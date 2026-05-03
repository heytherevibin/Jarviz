import type Store from 'electron-store'

export interface TranscriptTurn {
  role: 'user' | 'assistant'
  text: string
  ts: number
}

export interface TranscriptSession {
  id: string
  startedAt: number
  endedAt: number
  preview: string
  turns: TranscriptTurn[]
}

const MAX_SESSIONS = 100
const MAX_TURNS_PER_SESSION = 200

/**
 * Manages persistent conversation transcripts stored in electron-store.
 * Each user query + agent reply becomes one (user, assistant) pair appended to
 * the active session. New sessions auto-start after 5 min of idle time.
 */
export class TranscriptStore {
  private current: TranscriptSession | null = null

  constructor(private store: Store) {}

  list(): TranscriptSession[] {
    return (this.store.get('transcripts', []) as TranscriptSession[])
      .slice()
      .sort((a, b) => b.startedAt - a.startedAt)
  }

  get(id: string): TranscriptSession | null {
    return this.list().find(s => s.id === id) ?? null
  }

  delete(id: string): void {
    const next = this.list().filter(s => s.id !== id)
    this.store.set('transcripts', next)
    if (this.current?.id === id) this.current = null
  }

  clearAll(): void {
    this.store.set('transcripts', [])
    this.current = null
  }

  /** Restore the most recent live session if it ended within the idle window. */
  restoreActive(idleWindowMs: number): TranscriptTurn[] {
    const all = this.list()
    if (!all.length) return []
    const latest = all[0]
    if (Date.now() - latest.endedAt > idleWindowMs) return []
    this.current = latest
    return latest.turns.slice(-20)
  }

  startNewSession(): void {
    this.current = null
  }

  append(userText: string, assistantText: string): void {
    const now = Date.now()
    if (!this.current) {
      this.current = {
        id: `s_${now}_${Math.random().toString(36).slice(2, 8)}`,
        startedAt: now,
        endedAt: now,
        preview: userText.slice(0, 80),
        turns: [],
      }
    }
    this.current.turns.push({ role: 'user',      text: userText,      ts: now })
    this.current.turns.push({ role: 'assistant', text: assistantText, ts: now })
    this.current.endedAt = now
    if (this.current.turns.length > MAX_TURNS_PER_SESSION) {
      this.current.turns = this.current.turns.slice(-MAX_TURNS_PER_SESSION)
    }
    this.persist()
  }

  private persist(): void {
    if (!this.current) return
    const all = this.list().filter(s => s.id !== this.current!.id)
    all.unshift(this.current)
    if (all.length > MAX_SESSIONS) all.length = MAX_SESSIONS
    this.store.set('transcripts', all)
  }
}
