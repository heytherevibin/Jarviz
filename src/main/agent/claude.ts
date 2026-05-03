import Groq from 'groq-sdk'
import type Anthropic from '@anthropic-ai/sdk'
import { TOOLS, executeTool } from './tools'

type StateCallback = (state: 'thinking' | 'searching') => void

const LLM_TIMEOUT_MS = 25000
const RETRY_DELAY_MS = 2000

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

const SYSTEM = `You are Jarviz, a highly capable AI assistant modeled after Iron Man's JARVIS.
You are precise, confident, and speak with understated authority.

Tools available — use them aggressively for any factual question:
- get_weather for weather
- get_time for current time anywhere
- wikipedia for facts about people, places, history, science
- get_news for current headlines
- currency_convert, crypto_price, stock_price for finance
- define_word for word meanings
- calculate for math
- get_location for "where am I"
- web_search as a general fallback for anything else current
- read_file, list_directory, search_files for workspace files (paths must be absolute)

Rules:
- Always pick a tool when the answer requires current/factual data — never guess.
- Keep every response under 3 sentences — you are a voice assistant, not a document.
- Never say "As an AI" or similar disclaimers. Address the user directly. Be decisive.
- After a tool returns, synthesize into one clear spoken answer with the actual numbers.
- Multilingual: detect the user's language (English, Malayalam, Tamil, Hindi, etc.) and reply in the SAME language they used. If they mix languages, match their style.`

// All three backends share the same OpenAI-compatible message format
type Message = Groq.Chat.ChatCompletionMessageParam

const GROQ_TOOLS: Groq.Chat.ChatCompletionTool[] = TOOLS.map(t => ({
  type: 'function' as const,
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}))

// ── Groq backend ─────────────────────────────────────────────────────────────
async function runGroq(
  messages: Message[],
  onState: StateCallback,
): Promise<{ reply: string; messages: Message[] }> {
  const client = new Groq({ apiKey: process.env.GROQ_API_KEY })

  for (let turn = 0; turn < 8; turn++) {
    const response = await withTimeout(
      client.chat.completions.create({
        model:       'llama-3.3-70b-versatile',
        max_tokens:  512,
        messages:    [{ role: 'system', content: SYSTEM }, ...messages],
        tools:       GROQ_TOOLS,
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
        const result = await executeTool(call.function.name, JSON.parse(call.function.arguments))
        messages.push({ role: 'tool', tool_call_id: call.id, content: result })
      }
      onState('thinking')
    }
  }

  return { reply: 'I was unable to complete that request.', messages }
}

// ── xAI Grok backend (OpenAI-compatible API) ─────────────────────────────────
async function runXAI(
  messages: Message[],
  onState: StateCallback,
): Promise<{ reply: string; messages: Message[] }> {
  // xAI uses OpenAI-compatible API at https://api.x.ai/v1
  const Openai = (await import('openai')).default
  const client = new Openai({
    apiKey:  process.env.XAI_API_KEY,
    baseURL: 'https://api.x.ai/v1',
  })

  const tools = TOOLS.map(t => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }))

  for (let turn = 0; turn < 8; turn++) {
    const response = await withTimeout(
      client.chat.completions.create({
        model:       'grok-3-fast',
        max_tokens:  512,
        messages:    [{ role: 'system', content: SYSTEM }, ...messages] as never,
        tools,
        tool_choice: 'auto',
      }),
      LLM_TIMEOUT_MS,
      'xAI',
    )

    const msg = response.choices[0].message
    messages.push(msg as unknown as Message)
    const finish = response.choices[0].finish_reason

    if (finish === 'stop') return { reply: msg.content?.trim() ?? '', messages }

    if (finish === 'tool_calls' && msg.tool_calls?.length) {
      onState('searching')
      for (const call of msg.tool_calls) {
        const result = await executeTool(call.function.name, JSON.parse(call.function.arguments))
        messages.push({ role: 'tool', tool_call_id: call.id, content: result } as Message)
      }
      onState('thinking')
    }
  }

  return { reply: 'I was unable to complete that request.', messages }
}

// ── Anthropic backend ─────────────────────────────────────────────────────────
/** Convert OpenAI-format chat history → Anthropic Messages API shape (preserves tool rounds). */
function openAiToAnthropicMessages(messages: Message[]): Anthropic.Messages.MessageParam[] {
  const out: Anthropic.Messages.MessageParam[] = []
  let i = 0
  while (i < messages.length) {
    const m = messages[i]
    if (m.role === 'system') {
      i++
      continue
    }

    if (m.role === 'user') {
      out.push({ role: 'user', content: typeof m.content === 'string' ? m.content : '' })
      i++
      continue
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
          try {
            input = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>
          } catch { /* empty */ }
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
      i++
      continue
    }

    i++
  }
  return out
}

async function runAnthropic(
  messages: Message[],
  onState: StateCallback,
): Promise<{ reply: string; messages: Message[] }> {
  const AnthropicSdk = (await import('@anthropic-ai/sdk')).default
  const client = new AnthropicSdk({ apiKey: process.env.ANTHROPIC_API_KEY })
  const { TOOLS: ATOOLS } = await import('./tools')

  for (let turn = 0; turn < 8; turn++) {
    const anthMsgs = openAiToAnthropicMessages(messages)

    const response = await withTimeout(
      client.messages.create({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 512,
        system:     SYSTEM,
        tools:      ATOOLS,
        messages:   anthMsgs,
      }),
      LLM_TIMEOUT_MS,
      'Anthropic',
    )

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
      function: {
        name:      tu.name,
        arguments: JSON.stringify((tu.input ?? {}) as Record<string, unknown>),
      },
    }))

    messages.push({
      role:       'assistant',
      content:    replyText || null,
      tool_calls: oaiToolCalls,
    } as Message)

    for (const tu of toolUses) {
      const result = await executeTool(tu.name, (tu.input ?? {}) as Record<string, unknown>)
      messages.push({
        role: 'tool',
        tool_call_id: tu.id,
        content: result,
      } as Message)
    }

    onState('thinking')
  }

  return { reply: 'I was unable to complete that request.', messages }
}

// ── Google Gemini backend (REST API — multilingual, fast, free tier) ─────────
type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: { result: string } } }

type GeminiContent = { role: 'user' | 'model'; parts: GeminiPart[] }

async function runGemini(
  messages: Message[],
  onState: StateCallback,
): Promise<{ reply: string; messages: Message[] }> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY not set')

  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash'
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`

  // Convert message history (OpenAI-format) → Gemini contents
  const contents: GeminiContent[] = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({
      role:  m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content ?? '') }],
    }))

  // Convert tool definitions → Gemini function declarations
  const functionDeclarations = TOOLS.map(t => ({
    name:        t.name,
    description: t.description,
    parameters:  t.input_schema,
  }))

  for (let turn = 0; turn < 8; turn++) {
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
          generationConfig:  { maxOutputTokens: 512, temperature: 0.7 },
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
      // Pure text answer — done
      messages.push({ role: 'assistant', content: replyText })
      return { reply: replyText, messages }
    }

    // Tool call(s) — record model turn, run tools, append responses
    onState('searching')
    contents.push({ role: 'model', parts })

    const toolResponses: GeminiPart[] = []
    for (const fc of fnCalls) {
      const result = await executeTool(fc.functionCall.name, fc.functionCall.args)
      toolResponses.push({
        functionResponse: { name: fc.functionCall.name, response: { result } },
      })
    }
    contents.push({ role: 'user', parts: toolResponses })
    onState('thinking')
  }

  return { reply: 'I was unable to complete that request.', messages }
}

// ── Public entry point ────────────────────────────────────────────────────────
export async function runAgent(
  text: string,
  history: Message[],
  onState: StateCallback,
): Promise<{ reply: string; history: Message[] }> {
  const backend = (process.env.LLM_BACKEND ?? 'groq').toLowerCase()

  const messages: Message[] = [
    ...history,
    { role: 'user', content: text },
  ]

  onState('thinking')

  // Available backends keyed by env name
  type Runner = () => Promise<{ reply: string; messages: Message[] }>
  const runners: Record<string, Runner | null> = {
    gemini:    process.env.GEMINI_API_KEY    ? () => runGemini(messages, onState)    : null,
    groq:      process.env.GROQ_API_KEY      ? () => runGroq(messages, onState)      : null,
    xai:       process.env.XAI_API_KEY       ? () => runXAI(messages, onState)       : null,
    anthropic: process.env.ANTHROPIC_API_KEY ? () => runAnthropic(messages, onState) : null,
  }

  // Preferred order — chosen backend first, then sensible fallback chain
  const fallbackOrder = ['gemini', 'groq', 'xai', 'anthropic']
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
    throw new Error('No LLM API key set. Add GEMINI_API_KEY, GROQ_API_KEY, XAI_API_KEY, or ANTHROPIC_API_KEY to .env')
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
      console.error(`[Agent] backend ${i} failed, trying next:`, (e as Error).message?.slice(0, 120))
      lastErr = e
    }
  }

  throw lastErr
}
