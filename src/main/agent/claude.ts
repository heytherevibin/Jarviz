import Groq from 'groq-sdk'
import type Anthropic from '@anthropic-ai/sdk'
import { TOOLS, executeTool, type ToolResult } from './tools'
import { getMcpToolsForAnthropic } from './mcp-registry'

function buildOpenAiStyleTools(): Groq.Chat.ChatCompletionTool[] {
  const mcp = getMcpToolsForAnthropic()
  return [...TOOLS, ...mcp].map(t => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }))
}

type StateCallback = (state: 'thinking' | 'searching') => void

const LLM_TIMEOUT_MS = 45000
const RETRY_DELAY_MS = 2000
const MAX_TURNS = 10

const EMERGENT_BASE_URL = 'https://integrations.emergentagent.com/llm'

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ])
}

async function withRetry<T>(
  fn: () => Promise<T>,
  retries: number,
  delayMs: number,
  label: string,
): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      if (i < retries) {
        console.warn(`[Agent] ${label} attempt ${i + 1} failed, retrying in ${delayMs}ms:`, (e as Error).message?.slice(0, 100))
        await new Promise(r => setTimeout(r, delayMs * (i + 1)))
      }
    }
  }
  throw lastErr
}

const SYSTEM = `You are Jarviz, a fully autonomous desktop AI agent modeled after Iron Man's JARVIS.
You are precise, confident, and speak with understated authority. You can SEE the user's screen, hear them, and act on their machine.

You have a rich toolset — chain tools aggressively to complete multi-step requests:

INFORMATION
- memory_search, memory_save — search/save Jarviz memory (preferences, project notes, snippets)
- web_search, wikipedia, get_news, get_weather, get_time, get_location, define_word, calculate
- crypto_price, stock_price, currency_convert

USER MACHINE
- read_file, read_pdf (PDF text layer — scan-only PDFs: ask user to open file + use see_screen), list_directory, search_files (paths must be absolute)
- read_clipboard, write_clipboard
- system_info — OS, CPU, memory of the user's machine

MCP (optional)
- Tools whose names start with jmcp_ come from user-configured Model Context Protocol servers. Use them when they match the user’s request (e.g. GitHub, Slack, custom integrations).

ACTIONS
- open_url, open_app, open_path
- run_command — execute a shell command (git, ls, mkdir, ffmpeg…). High-risk patterns (sudo, rm -rf, curl|sh, …) are blocked unless the user enabled “Allow destructive shell” in Settings.
- notify — native desktop notification

VISION & INPUT (the JARVIS superpower)
- see_screen — captures the primary display and ATTACHES THE IMAGE so you can visually analyze what is shown. Use whenever the user asks you to "look at", "read", "summarize", "click", or otherwise interact with anything on screen.
- type_text — type a string into the focused window
- key_combo — press a keyboard shortcut like "cmd+c", "ctrl+t", "alt+tab"
- mouse_click(x, y) / mouse_move(x, y) / mouse_scroll(amount) — control the cursor

AGENT BEHAVIOR
- Always pick a tool when the answer requires current/factual data, screen content, or a real action — never guess.
- For multi-step requests, call as many tools as needed in sequence (e.g. see_screen → identify the button → mouse_click).
- After tool returns, synthesize into ONE clear spoken answer with the actual numbers / outcome.
- Keep every response under 3 sentences — you are a voice assistant, not a document.
- Never say "As an AI" or similar disclaimers. Address the user directly.
- Multilingual: detect the user's language (English, Malayalam, Tamil, Hindi, etc.) and reply in the SAME language.`

// All OpenAI-compatible backends share the same message format
type Message = Groq.Chat.ChatCompletionMessageParam


// Helper: turn a tool result into a follow-up user message containing image(s).
// OpenAI-compatible providers (incl. Emergent proxy) accept content arrays with image_url parts.
function imageFollowupMessage(toolName: string, images: string[]): Message {
  const blocks: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
    { type: 'text', text: `Image attached from tool ${toolName}. Analyze it and continue.` },
  ]
  for (const b64 of images) {
    blocks.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } })
  }
  return { role: 'user', content: blocks } as unknown as Message
}

// ── Generic OpenAI-compatible loop (used by Emergent + xAI + native OpenAI) ──
async function runOpenAICompatible(
  messages: Message[],
  onState: StateCallback,
  opts: { apiKey: string; baseURL?: string; model: string; label: string },
): Promise<{ reply: string; messages: Message[] }> {
  const Openai = (await import('openai')).default
  const client = new Openai({ apiKey: opts.apiKey, baseURL: opts.baseURL })

  const tools = buildOpenAiStyleTools()

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await withTimeout(
      client.chat.completions.create({
        model:       opts.model,
        max_tokens:  1024,
        messages:    [{ role: 'system', content: SYSTEM }, ...messages] as never,
        tools:       tools as any,
        tool_choice: 'auto',
      }),
      LLM_TIMEOUT_MS,
      opts.label,
    )

    const msg = (response as any).choices[0].message
    messages.push(msg as unknown as Message)
    const finish = (response as any).choices[0].finish_reason

    if (finish === 'stop' || (!msg.tool_calls?.length && msg.content)) {
      return { reply: msg.content?.trim() ?? '', messages }
    }

    if (msg.tool_calls?.length) {
      onState('searching')
      const followups: Message[] = []
      for (const call of msg.tool_calls) {
        if (call.type !== 'function') continue
        let args: Record<string, unknown> = {}
        try { args = JSON.parse(call.function.arguments || '{}') } catch { /* empty */ }
        const result = await executeTool(call.function.name, args)
        messages.push({ role: 'tool', tool_call_id: call.id, content: result.text } as Message)
        if (result.images?.length) followups.push(imageFollowupMessage(call.function.name, result.images))
      }
      // Push image follow-ups after all tool messages so the model sees the screenshots before its next turn
      for (const m of followups) messages.push(m)
      onState('thinking')
    }
  }

  return { reply: 'I was unable to complete that request.', messages }
}

// ── Groq backend (no vision support — text-only models) ─────────────────────
async function runGroq(
  messages: Message[],
  onState: StateCallback,
): Promise<{ reply: string; messages: Message[] }> {
  const client = new Groq({ apiKey: process.env.GROQ_API_KEY })

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await withTimeout(
      client.chat.completions.create({
        model:       'llama-3.3-70b-versatile',
        max_tokens:  1024,
        messages:    [{ role: 'system', content: SYSTEM }, ...messages],
        tools:       buildOpenAiStyleTools(),
        tool_choice: 'auto',
      }),
      LLM_TIMEOUT_MS,
      'Groq',
    )

    const msg = response.choices[0].message
    messages.push(msg as Message)
    const finish = response.choices[0].finish_reason

    if (finish === 'stop') return { reply: msg.content?.trim() ?? '', messages }

    if (finish === 'tool_calls' && msg.tool_calls?.length) {
      onState('searching')
      for (const call of msg.tool_calls) {
        const result: ToolResult = await executeTool(call.function.name, JSON.parse(call.function.arguments))
        const note = result.images?.length
          ? `${result.text}\n[Note: image was captured but Groq Llama does not support vision; switch backend for visual analysis.]`
          : result.text
        messages.push({ role: 'tool', tool_call_id: call.id, content: note })
      }
      onState('thinking')
    }
  }

  return { reply: 'I was unable to complete that request.', messages }
}

// ── Anthropic backend ─────────────────────────────────────────────────────────
function openAiToAnthropicMessages(messages: Message[]): Anthropic.Messages.MessageParam[] {
  const out: Anthropic.Messages.MessageParam[] = []
  let i = 0
  while (i < messages.length) {
    const m = messages[i]
    if (m.role === 'system') { i++; continue }

    if (m.role === 'user') {
      const content = m.content
      if (typeof content === 'string') {
        out.push({ role: 'user', content })
      } else if (Array.isArray(content)) {
        // Convert OpenAI-format content array (text + image_url) to Anthropic blocks
        const blocks: Anthropic.Messages.ContentBlockParam[] = []
        for (const part of content as unknown as Array<Record<string, unknown>>) {
          if (part.type === 'text') {
            blocks.push({ type: 'text', text: String((part as { text: string }).text) })
          } else if (part.type === 'image_url') {
            const url = String(((part as { image_url: { url: string } }).image_url ?? {}).url ?? '')
            const m = /^data:(image\/[^;]+);base64,(.+)$/.exec(url)
            if (m) {
              blocks.push({
                type: 'image',
                source: { type: 'base64', media_type: m[1] as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif', data: m[2] },
              })
            }
          }
        }
        out.push({ role: 'user', content: blocks })
      }
      i++; continue
    }

    if (m.role === 'assistant') {
      const am = m as {
        role: 'assistant'
        content?: string | null
        tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>
      }
      if (am.tool_calls?.length) {
        const blocks: Anthropic.Messages.ContentBlockParam[] = []
        if (am.content) blocks.push({ type: 'text', text: am.content })
        for (const tc of am.tool_calls) {
          let input: Record<string, unknown> = {}
          try { input = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown> } catch { /* empty */ }
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input })
        }
        out.push({ role: 'assistant', content: blocks })
        i++

        const toolResults: Anthropic.Messages.ToolResultBlockParam[] = []
        while (i < messages.length && messages[i].role === 'tool') {
          const tm = messages[i] as { role: 'tool'; tool_call_id: string; content: string }
          toolResults.push({ type: 'tool_result', tool_use_id: tm.tool_call_id, content: tm.content })
          i++
        }
        if (toolResults.length) out.push({ role: 'user', content: toolResults })
      } else {
        out.push({ role: 'assistant', content: am.content ?? '' })
        i++
      }
      continue
    }

    if (m.role === 'tool') {
      const tm = m as { role: 'tool'; tool_call_id: string; content: string }
      out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: tm.tool_call_id, content: tm.content }] })
      i++; continue
    }

    i++
  }
  return out
}

function buildAnthropicTools(): Anthropic.Messages.ToolUnion[] {
  const mcp = getMcpToolsForAnthropic()
  const merged = [...TOOLS, ...mcp] as Anthropic.Messages.ToolUnion[]
  const cacheOn = process.env.ANTHROPIC_PROMPT_CACHE !== '0' && process.env.ANTHROPIC_PROMPT_CACHE !== 'false'
  if (!cacheOn || merged.length === 0) return merged
  return merged.map((t, i) =>
    i === merged.length - 1 ? { ...t, cache_control: { type: 'ephemeral' as const } } : { ...t },
  )
}

function anthropicSystemParam(): string | Anthropic.Messages.TextBlockParam[] {
  const cacheOn = process.env.ANTHROPIC_PROMPT_CACHE !== '0' && process.env.ANTHROPIC_PROMPT_CACHE !== 'false'
  if (cacheOn) {
    return [{ type: 'text' as const, text: SYSTEM, cache_control: { type: 'ephemeral' as const } }]
  }
  return SYSTEM
}

function looksLikeThinkingUnsupported(err: unknown): boolean {
  const msg = `${(err as Error)?.message ?? err}`
  return /thinking|extended_thinking|invalid_request|not supported|400|403/i.test(msg)
}

async function runAnthropic(
  messages: Message[],
  onState: StateCallback,
): Promise<{ reply: string; messages: Message[] }> {
  const AnthropicSdk = (await import('@anthropic-ai/sdk')).default
  const client = new AnthropicSdk({ apiKey: process.env.ANTHROPIC_API_KEY })
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929'
  const tools = buildAnthropicTools()
  const maxTokens = 8192
  const thinkingOn = process.env.ANTHROPIC_THINKING !== '0' && process.env.ANTHROPIC_THINKING !== 'false'

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const anthMsgs = openAiToAnthropicMessages(messages)

    const base = (includeThinking: boolean): Anthropic.Messages.MessageCreateParamsNonStreaming => ({
      model,
      max_tokens: maxTokens,
      system:   anthropicSystemParam(),
      tools,
      messages: anthMsgs,
      ...(includeThinking
        ? { thinking: { type: 'enabled' as const, budget_tokens: 2048, display: 'summarized' as const } }
        : {}),
    })

    let response: Awaited<ReturnType<typeof client.messages.create>>
    try {
      if (thinkingOn) {
        response = await withTimeout(client.messages.create(base(true)), LLM_TIMEOUT_MS, 'Anthropic')
      } else {
        response = await withTimeout(client.messages.create(base(false)), LLM_TIMEOUT_MS, 'Anthropic')
      }
    } catch (e) {
      if (thinkingOn && looksLikeThinkingUnsupported(e)) {
        console.warn('[Agent] Anthropic extended thinking unavailable for this model; retrying without.')
        response = await withTimeout(client.messages.create(base(false)), LLM_TIMEOUT_MS, 'Anthropic')
      } else {
        throw e
      }
    }

    const toolUses = response.content.filter((b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use')
    const textBlocks = response.content.filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
    const replyText = textBlocks.map(b => b.text).join('\n').trim()

    if (toolUses.length === 0) {
      messages.push({ role: 'assistant', content: replyText })
      return { reply: replyText, messages }
    }

    onState('searching')

    const oaiToolCalls = toolUses.map(tu => ({
      id: tu.id,
      type: 'function' as const,
      function: { name: tu.name, arguments: JSON.stringify((tu.input ?? {}) as Record<string, unknown>) },
    }))

    messages.push({ role: 'assistant', content: replyText || null, tool_calls: oaiToolCalls } as Message)

    const followups: Message[] = []
    for (const tu of toolUses) {
      const result: ToolResult = await executeTool(tu.name, (tu.input ?? {}) as Record<string, unknown>)
      messages.push({ role: 'tool', tool_call_id: tu.id, content: result.text } as Message)
      if (result.images?.length) followups.push(imageFollowupMessage(tu.name, result.images))
    }
    for (const m of followups) messages.push(m)

    onState('thinking')
  }

  return { reply: 'I was unable to complete that request.', messages }
}

// ── Google Gemini backend (REST) ─────────────────────────────────────────────
type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: { result: string } } }
  | { inlineData: { mimeType: string; data: string } }

type GeminiContent = { role: 'user' | 'model'; parts: GeminiPart[] }

async function runGemini(
  messages: Message[],
  onState: StateCallback,
): Promise<{ reply: string; messages: Message[] }> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY not set')

  const model = process.env.GEMINI_MODEL || 'gemini-2.5-pro'
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`

  const contents: GeminiContent[] = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => {
      const role: 'user' | 'model' = m.role === 'assistant' ? 'model' : 'user'
      // Convert OpenAI-format content array (text + image_url) → Gemini parts
      if (Array.isArray(m.content)) {
        const parts: GeminiPart[] = []
        for (const part of m.content as unknown as Array<Record<string, unknown>>) {
          if (part.type === 'text') parts.push({ text: String((part as { text: string }).text) })
          else if (part.type === 'image_url') {
            const url2 = String(((part as { image_url: { url: string } }).image_url ?? {}).url ?? '')
            const mt = /^data:(image\/[^;]+);base64,(.+)$/.exec(url2)
            if (mt) parts.push({ inlineData: { mimeType: mt[1], data: mt[2] } })
          }
        }
        return { role, parts: parts.length ? parts : [{ text: '' }] }
      }
      return { role, parts: [{ text: String(m.content ?? '') }] }
    })

  const functionDeclarations = [...TOOLS, ...getMcpToolsForAnthropic()].map(t => ({
    name:        t.name,
    description: t.description,
    parameters:  t.input_schema,
  }))

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), LLM_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        signal:  ctl.signal,
        body:    JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents,
          tools:             [{ functionDeclarations }],
          generationConfig:  { maxOutputTokens: 1024, temperature: 0.7 },
        }),
      })
    } catch (e) {
      clearTimeout(timer)
      if ((e as Error).name === 'AbortError') throw new Error('Gemini timed out')
      throw e
    }
    clearTimeout(timer)

    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`Gemini ${res.status}: ${errText.slice(0, 200)}`)
    }

    const data = await res.json() as {
      candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>
    }
    const cand = data.candidates?.[0]
    const parts = cand?.content?.parts ?? []

    const textParts = parts.filter((p): p is { text: string } => 'text' in p)
    const fnCalls   = parts.filter((p): p is { functionCall: { name: string; args: Record<string, unknown> } } => 'functionCall' in p)

    const replyText = textParts.map(p => p.text).join(' ').trim()

    if (fnCalls.length === 0) {
      messages.push({ role: 'assistant', content: replyText })
      return { reply: replyText, messages }
    }

    onState('searching')
    contents.push({ role: 'model', parts })

    const toolResponses: GeminiPart[] = []
    const imageParts: GeminiPart[] = []
    for (const fc of fnCalls) {
      const result: ToolResult = await executeTool(fc.functionCall.name, fc.functionCall.args)
      toolResponses.push({
        functionResponse: { name: fc.functionCall.name, response: { result: result.text } },
      })
      if (result.images?.length) {
        for (const b64 of result.images) imageParts.push({ inlineData: { mimeType: 'image/png', data: b64 } })
      }
    }
    contents.push({ role: 'user', parts: toolResponses })
    if (imageParts.length) {
      contents.push({ role: 'user', parts: [{ text: 'Image(s) attached from tool. Analyze and continue.' }, ...imageParts] })
    }
    onState('thinking')
  }

  return { reply: 'I was unable to complete that request.', messages }
}

// ── Emergent Universal backend ───────────────────────────────────────────────
async function runEmergent(
  messages: Message[],
  onState: StateCallback,
): Promise<{ reply: string; messages: Message[] }> {
  const apiKey = process.env.EMERGENT_LLM_KEY
  if (!apiKey) throw new Error('EMERGENT_LLM_KEY not set')

  const provider = (process.env.EMERGENT_PROVIDER || 'anthropic').toLowerCase()
  const rawModel = process.env.EMERGENT_MODEL || 'claude-sonnet-4-5-20250929'

  // Gemini models must be prefixed with "gemini/" through the Emergent proxy
  const model = provider === 'gemini' && !rawModel.startsWith('gemini/')
    ? `gemini/${rawModel}`
    : rawModel

  return runOpenAICompatible(messages, onState, {
    apiKey,
    baseURL: EMERGENT_BASE_URL,
    model,
    label: `Emergent (${provider}/${rawModel})`,
  })
}

async function runXAI(
  messages: Message[],
  onState: StateCallback,
): Promise<{ reply: string; messages: Message[] }> {
  return runOpenAICompatible(messages, onState, {
    apiKey:  process.env.XAI_API_KEY ?? '',
    baseURL: 'https://api.x.ai/v1',
    model:   process.env.XAI_MODEL || 'grok-3-fast',
    label:   'xAI',
  })
}

async function runOpenAI(
  messages: Message[],
  onState: StateCallback,
): Promise<{ reply: string; messages: Message[] }> {
  return runOpenAICompatible(messages, onState, {
    apiKey: process.env.OPENAI_API_KEY ?? '',
    model:  process.env.OPENAI_MODEL || 'gpt-5.2',
    label:  'OpenAI',
  })
}

// ── Public entry point ────────────────────────────────────────────────────────
export async function runAgent(
  text: string,
  history: Message[],
  onState: StateCallback,
): Promise<{ reply: string; history: Message[] }> {
  const backend = (process.env.LLM_BACKEND ?? 'emergent').toLowerCase()

  const messages: Message[] = [
    ...history,
    { role: 'user', content: text },
  ]

  onState('thinking')

  type Runner = () => Promise<{ reply: string; messages: Message[] }>
  const runners: Record<string, Runner | null> = {
    emergent:  process.env.EMERGENT_LLM_KEY  ? () => runEmergent(messages, onState)  : null,
    anthropic: process.env.ANTHROPIC_API_KEY ? () => runAnthropic(messages, onState) : null,
    openai:    process.env.OPENAI_API_KEY    ? () => runOpenAI(messages, onState)    : null,
    gemini:    process.env.GEMINI_API_KEY    ? () => runGemini(messages, onState)    : null,
    groq:      process.env.GROQ_API_KEY      ? () => runGroq(messages, onState)      : null,
    xai:       process.env.XAI_API_KEY       ? () => runXAI(messages, onState)       : null,
  }

  const fallbackOrder = ['emergent', 'anthropic', 'openai', 'gemini', 'groq', 'xai']
  const order = [backend, ...fallbackOrder.filter(b => b !== backend)]

  const backends: Runner[] = []
  const seen = new Set<string>()
  for (const name of order) {
    if (seen.has(name)) continue
    seen.add(name)
    const r = runners[name]
    if (r) backends.push(r)
  }

  if (backends.length === 0) {
    throw new Error('No LLM key configured. Open Settings (Cmd/Ctrl+,) and add the Emergent Universal Key, or your own Anthropic/OpenAI/Gemini key.')
  }

  let lastErr: unknown
  for (let i = 0; i < backends.length; i++) {
    const run = backends[i]
    try {
      const { reply, messages: updated } = await withRetry(
        run,
        i === backends.length - 1 ? 1 : 0,
        RETRY_DELAY_MS,
        `backend-${i}`,
      )
      return { reply, history: updated.slice(-20) }
    } catch (e) {
      console.error(`[Agent] backend ${i} failed, trying next:`, (e as Error).message?.slice(0, 200))
      lastErr = e
    }
  }

  throw lastErr
}
