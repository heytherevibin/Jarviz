export type JarvizState =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'speaking'
  | 'followUp'
  | 'error'

export type JarvizEvent =
  | { type: 'ACTIVATE' }
  | { type: 'WAKE_WORD'; command: string }
  | { type: 'AUDIO_CAPTURED'; blob: Blob }
  | { type: 'NO_AUDIO' }
  | { type: 'TIMEOUT' }
  | { type: 'TRANSCRIPT_READY'; text: string }
  | { type: 'NOISE_DETECTED' }
  | { type: 'STT_FAILED' }
  | { type: 'RESPONSE_READY'; text: string; audio: number[] | null }
  | { type: 'AGENT_FAILED'; message: string }
  | { type: 'SPEECH_DONE' }
  | { type: 'INTERRUPTED' }
  | { type: 'FOLLOW_UP_TIMEOUT' }
  | { type: 'ERROR_DISMISS' }

interface Transition {
  target: JarvizState
  guard?: (event: JarvizEvent, ctx: FSMContext) => boolean
}

export interface FSMContext {
  transcript: string
  replyText: string
  replyAudio: number[] | null
  wakeCommand: string
  errorMessage: string
  turnCount: number
}

type TransitionMap = Partial<Record<JarvizEvent['type'], Transition>>

const TRANSITIONS: Record<JarvizState, TransitionMap> = {
  idle: {
    ACTIVATE:  { target: 'listening' },
    WAKE_WORD: { target: 'listening' },
  },
  listening: {
    AUDIO_CAPTURED:   { target: 'transcribing' },
    TRANSCRIPT_READY: { target: 'thinking' },
    NO_AUDIO:         { target: 'idle' },
    TIMEOUT:          { target: 'idle' },
    INTERRUPTED:      { target: 'idle' },
  },
  transcribing: {
    TRANSCRIPT_READY: { target: 'thinking' },
    NOISE_DETECTED:   { target: 'idle' },
    STT_FAILED:       { target: 'error' },
    INTERRUPTED:      { target: 'idle' },
  },
  thinking: {
    RESPONSE_READY: { target: 'speaking' },
    AGENT_FAILED:   { target: 'error' },
    INTERRUPTED:    { target: 'idle' },
  },
  speaking: {
    SPEECH_DONE: { target: 'followUp' },
    INTERRUPTED: { target: 'idle' },
  },
  followUp: {
    ACTIVATE:           { target: 'listening' },
    WAKE_WORD:          { target: 'listening' },
    AUDIO_CAPTURED:     { target: 'transcribing' },
    TRANSCRIPT_READY:   { target: 'thinking' },
    NO_AUDIO:           { target: 'idle' },
    FOLLOW_UP_TIMEOUT:  { target: 'idle' },
    TIMEOUT:            { target: 'idle' },
    INTERRUPTED:        { target: 'idle' },
  },
  error: {
    ERROR_DISMISS: { target: 'idle' },
    ACTIVATE:      { target: 'listening' },
    WAKE_WORD:     { target: 'listening' },
  },
}

const MAX_CONVERSATION_TURNS = 10

export type StateListener = (
  newState: JarvizState,
  oldState: JarvizState,
  event: JarvizEvent,
  ctx: Readonly<FSMContext>,
) => void

export class JarvizFSM {
  private _state: JarvizState = 'idle'
  private _ctx: FSMContext = {
    transcript: '',
    replyText: '',
    replyAudio: null,
    wakeCommand: '',
    errorMessage: '',
    turnCount: 0,
  }
  private listeners: StateListener[] = []
  private errorTimer: ReturnType<typeof setTimeout> | null = null

  get state(): JarvizState { return this._state }
  get context(): Readonly<FSMContext> { return this._ctx }

  clearWakeCommand(): void {
    this._ctx.wakeCommand = ''
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener)
    }
  }

  send(event: JarvizEvent): boolean {
    const transitions = TRANSITIONS[this._state]
    const transition = transitions[event.type]

    if (!transition) {
      console.warn(
        `[FSM] invalid transition: ${this._state} + ${event.type} — ignored`,
      )
      return false
    }

    if (transition.guard && !transition.guard(event, this._ctx)) {
      console.warn(
        `[FSM] guard rejected: ${this._state} + ${event.type}`,
      )
      return false
    }

    const oldState = this._state
    let newState = transition.target

    if (newState === 'followUp' && this._ctx.turnCount >= MAX_CONVERSATION_TURNS) {
      newState = 'idle'
    }

    this.updateContext(event, newState)

    this._state = newState
    this.scheduleErrorDismiss(newState)

    for (const listener of this.listeners) {
      try {
        listener(newState, oldState, event, this._ctx)
      } catch (err) {
        console.error('[FSM] listener error:', err)
      }
    }

    return true
  }

  private updateContext(event: JarvizEvent, nextState: JarvizState): void {
    switch (event.type) {
      case 'WAKE_WORD':
        this._ctx.wakeCommand = event.command
        break
      case 'TRANSCRIPT_READY':
        this._ctx.transcript = event.text
        this._ctx.turnCount++
        break
      case 'RESPONSE_READY':
        this._ctx.replyText = event.text
        this._ctx.replyAudio = event.audio
        break
      case 'AGENT_FAILED':
        this._ctx.errorMessage = event.message
        break
      case 'STT_FAILED':
        this._ctx.errorMessage = 'Speech recognition failed'
        break
    }

    if (nextState === 'idle') {
      this._ctx.turnCount = 0
      this._ctx.wakeCommand = ''
    }
  }

  private scheduleErrorDismiss(state: JarvizState): void {
    if (this.errorTimer) {
      clearTimeout(this.errorTimer)
      this.errorTimer = null
    }
    if (state === 'error') {
      this.errorTimer = setTimeout(() => {
        this.send({ type: 'ERROR_DISMISS' })
      }, 3000)
    }
  }

  dispose(): void {
    if (this.errorTimer) clearTimeout(this.errorTimer)
    this.listeners = []
  }
}
