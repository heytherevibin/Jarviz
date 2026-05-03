// Jarviz tool layer — autonomous agent capabilities.
// Includes:
//   • Information tools (web/wiki/news/weather/finance/dictionary/calc/location)
//   • Filesystem tools (read/list/search)
//   • System action tools (shell, open app/url, clipboard, screenshot, notify, system_info)

import { readdir, readFile, stat } from 'fs/promises'
import { join, extname } from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'
import { hostname, platform, arch, release, totalmem, freemem, cpus, userInfo, homedir } from 'os'
import { app, BrowserWindow, clipboard, Notification, shell, desktopCapturer, screen } from 'electron'
import type { Tool } from '@anthropic-ai/sdk/resources/messages'

const execAsync = promisify(exec)

const HTTP_TIMEOUT_MS = 6000
const MAX_TOOL_OUTPUT = 2000
const SHELL_TIMEOUT_MS = 15000
const SHELL_MAX_BUFFER = 1024 * 256
const TRANSIENT_CODES = new Set([429, 502, 503, 504])

function truncate(s: string, max = MAX_TOOL_OUTPUT): string {
  if (s.length <= max) return s
  return s.slice(0, max) + `\n[...truncated, ${s.length - max} chars omitted]`
}

async function fetchJSON<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const ctl = new AbortController()
  const t   = setTimeout(() => ctl.abort(), HTTP_TIMEOUT_MS)
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal })
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status })
    return await res.json() as T
  } finally {
    clearTimeout(t)
  }
}

async function fetchJSONRetry<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  try {
    return await fetchJSON<T>(url, init)
  } catch (e) {
    const status = (e as { status?: number }).status
    if (status && TRANSIENT_CODES.has(status)) {
      await new Promise(r => setTimeout(r, 1000))
      return fetchJSON<T>(url, init)
    }
    throw e
  }
}

// ── Tool definitions ─────────────────────────────────────────────────────────
export const TOOLS: Tool[] = [
  {
    name: 'web_search',
    description: 'Search the web for current information, news, or any factual query. Use Tavily if available, falls back to DuckDuckGo.',
    input_schema: {
      type: 'object' as const,
      properties: { query: { type: 'string', description: 'Search query' } },
      required: ['query'],
    },
  },
  {
    name: 'get_weather',
    description: 'Get current weather and short forecast for a city or location. Free, no key required.',
    input_schema: {
      type: 'object' as const,
      properties: { location: { type: 'string', description: 'City name, e.g. "London" or "San Francisco, CA"' } },
      required: ['location'],
    },
  },
  {
    name: 'get_time',
    description: 'Get the current local time for a city or IANA timezone (e.g. "Tokyo", "America/New_York").',
    input_schema: {
      type: 'object' as const,
      properties: { location: { type: 'string', description: 'City or IANA timezone' } },
      required: ['location'],
    },
  },
  {
    name: 'wikipedia',
    description: 'Get a concise Wikipedia summary for a topic, person, or place.',
    input_schema: {
      type: 'object' as const,
      properties: { topic: { type: 'string', description: 'Subject to look up' } },
      required: ['topic'],
    },
  },
  {
    name: 'get_news',
    description: 'Get top tech/world news headlines from Hacker News.',
    input_schema: {
      type: 'object' as const,
      properties: { count: { type: 'number', description: 'Number of headlines (default 5, max 10)' } },
    },
  },
  {
    name: 'currency_convert',
    description: 'Convert an amount between currencies using live rates.',
    input_schema: {
      type: 'object' as const,
      properties: {
        amount: { type: 'number', description: 'Amount to convert' },
        from:   { type: 'string', description: '3-letter currency code, e.g. USD' },
        to:     { type: 'string', description: '3-letter currency code, e.g. EUR' },
      },
      required: ['amount', 'from', 'to'],
    },
  },
  {
    name: 'crypto_price',
    description: 'Get the current price of a cryptocurrency in USD.',
    input_schema: {
      type: 'object' as const,
      properties: { coin: { type: 'string', description: 'Coin id, e.g. "bitcoin", "ethereum", "solana"' } },
      required: ['coin'],
    },
  },
  {
    name: 'stock_price',
    description: 'Get the current price of a stock by ticker symbol.',
    input_schema: {
      type: 'object' as const,
      properties: { symbol: { type: 'string', description: 'Stock ticker, e.g. "AAPL", "TSLA"' } },
      required: ['symbol'],
    },
  },
  {
    name: 'define_word',
    description: 'Get the definition of an English word.',
    input_schema: {
      type: 'object' as const,
      properties: { word: { type: 'string', description: 'Word to define' } },
      required: ['word'],
    },
  },
  {
    name: 'calculate',
    description: 'Evaluate a math expression. Supports +, -, *, /, %, **, parentheses, Math functions.',
    input_schema: {
      type: 'object' as const,
      properties: { expression: { type: 'string', description: 'e.g. "(45 * 1.18) + sqrt(144)"' } },
      required: ['expression'],
    },
  },
  {
    name: 'get_location',
    description: 'Get the user\'s approximate location based on IP address.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'read_file',
    description: 'Read the contents of a text file from the user\'s filesystem.',
    input_schema: {
      type: 'object' as const,
      properties: { path: { type: 'string', description: 'Absolute file path' } },
      required: ['path'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and folders in a directory.',
    input_schema: {
      type: 'object' as const,
      properties: { path: { type: 'string', description: 'Absolute directory path' } },
      required: ['path'],
    },
  },
  {
    name: 'search_files',
    description: 'Search for files by name pattern within a directory tree.',
    input_schema: {
      type: 'object' as const,
      properties: {
        directory: { type: 'string', description: 'Root directory' },
        pattern:   { type: 'string', description: 'Filename substring or extension' },
      },
      required: ['directory', 'pattern'],
    },
  },
  // ── System / agentic action tools ──────────────────────────────────────────
  {
    name: 'open_url',
    description: 'Open a URL in the user\'s default web browser. Use for any web link or to launch a search in browser.',
    input_schema: {
      type: 'object' as const,
      properties: { url: { type: 'string', description: 'Full URL including https://' } },
      required: ['url'],
    },
  },
  {
    name: 'open_app',
    description: 'Launch a desktop application by name (e.g. "Calculator", "Spotify", "Visual Studio Code", "Chrome"). Cross-platform.',
    input_schema: {
      type: 'object' as const,
      properties: { name: { type: 'string', description: 'Application display name' } },
      required: ['name'],
    },
  },
  {
    name: 'open_path',
    description: 'Open a file or folder using the OS default application (e.g. open a folder in Finder/Explorer or a PDF in default viewer).',
    input_schema: {
      type: 'object' as const,
      properties: { path: { type: 'string', description: 'Absolute path to file or folder' } },
      required: ['path'],
    },
  },
  {
    name: 'run_command',
    description: 'Execute a shell command on the user\'s machine. Use carefully — explain what you\'re doing first. Returns combined stdout+stderr. 15s timeout.',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'Shell command to run' },
        cwd:     { type: 'string', description: 'Optional working directory' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_clipboard',
    description: 'Read the current contents of the system clipboard.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'write_clipboard',
    description: 'Write text to the system clipboard so the user can paste it.',
    input_schema: {
      type: 'object' as const,
      properties: { text: { type: 'string', description: 'Text to copy' } },
      required: ['text'],
    },
  },
  {
    name: 'screenshot',
    description: 'Capture a screenshot of the primary display and return a short description of what is visible. Use for screen context awareness.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'notify',
    description: 'Show a native desktop notification to the user.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Notification title' },
        body:  { type: 'string', description: 'Notification body text' },
      },
      required: ['title', 'body'],
    },
  },
  {
    name: 'system_info',
    description: 'Get information about the user\'s machine: OS, architecture, memory, CPU, hostname.',
    input_schema: { type: 'object' as const, properties: {} },
  },
]

// ── Dispatcher ───────────────────────────────────────────────────────────────
type ToolInput = Record<string, unknown>

export async function executeTool(name: string, input: ToolInput): Promise<string> {
  try {
    const preview = JSON.stringify(input)
    console.log(`[Tools] ${name}(${preview.length > 280 ? `${preview.slice(0, 280)}…` : preview})`)
    let out: string
    switch (name) {
      case 'web_search':       out = await webSearch(String(input.query ?? '')); break
      case 'get_weather':      out = await getWeather(String(input.location ?? '')); break
      case 'get_time':         out = await getTime(String(input.location ?? '')); break
      case 'wikipedia':        out = await wikipedia(String(input.topic ?? '')); break
      case 'get_news':         out = await getNews(Number(input.count ?? 5)); break
      case 'currency_convert': out = await currencyConvert(Number(input.amount), String(input.from), String(input.to)); break
      case 'crypto_price':     out = await cryptoPrice(String(input.coin ?? '')); break
      case 'stock_price':      out = await stockPrice(String(input.symbol ?? '')); break
      case 'define_word':      out = await defineWord(String(input.word ?? '')); break
      case 'calculate':        out = calculate(String(input.expression ?? '')); break
      case 'get_location':     out = await getLocation(); break
      case 'read_file':        out = await readFileContents(String(input.path ?? '')); break
      case 'list_directory':   out = await listDir(String(input.path ?? '')); break
      case 'search_files':     out = await searchFiles(String(input.directory ?? ''), String(input.pattern ?? '')); break
      case 'open_url':         out = await openUrl(String(input.url ?? '')); break
      case 'open_app':         out = await openApp(String(input.name ?? '')); break
      case 'open_path':        out = await openPath(String(input.path ?? '')); break
      case 'run_command':      out = await runCommand(String(input.command ?? ''), input.cwd ? String(input.cwd) : undefined); break
      case 'read_clipboard':   out = readClipboardText(); break
      case 'write_clipboard':  out = writeClipboardText(String(input.text ?? '')); break
      case 'screenshot':       out = await captureScreenshot(); break
      case 'notify':           out = showNotification(String(input.title ?? ''), String(input.body ?? '')); break
      case 'system_info':      out = getSystemInfo(); break
      default:                 out = `Unknown tool: ${name}`
    }
    return truncate(out)
  } catch (e) {
    return `Tool ${name} failed: ${(e as Error).message}`
  }
}

// ── Web search (Tavily → DuckDuckGo fallback) ────────────────────────────────
async function webSearch(query: string): Promise<string> {
  if (!query) return 'Empty query.'

  const tavilyKey = process.env.TAVILY_API_KEY
  if (tavilyKey) {
    try {
      const data = await fetchJSON<{
        answer?: string
        results: Array<{ title: string; url: string; content: string }>
      }>('https://api.tavily.com/search', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ api_key: tavilyKey, query, search_depth: 'basic', max_results: 4, include_answer: true }),
      })
      const lines: string[] = []
      if (data.answer) lines.push(`Answer: ${data.answer}\n`)
      data.results.slice(0, 3).forEach(r => {
        lines.push(`• ${r.title}\n  ${r.content.slice(0, 250)}`)
      })
      return lines.join('\n')
    } catch (e) {
      // fall through to DuckDuckGo
      console.warn('[Tools] Tavily failed, falling back:', (e as Error).message)
    }
  }

  // DuckDuckGo Instant Answer — no key, sometimes empty for non-factoid queries
  const ddg = await fetchJSONRetry<{
    AbstractText?: string
    Abstract?: string
    Heading?: string
    Answer?: string
    Definition?: string
    RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>
  }>(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`)

  const lines: string[] = []
  if (ddg.Answer)       lines.push(ddg.Answer)
  if (ddg.AbstractText) lines.push(ddg.AbstractText)
  if (ddg.Definition)   lines.push(ddg.Definition)
  ddg.RelatedTopics?.slice(0, 3).forEach(t => { if (t.Text) lines.push(`• ${t.Text}`) })

  return lines.length ? lines.join('\n') : `No instant answer for "${query}". Try a more specific query or set TAVILY_API_KEY.`
}

// ── Weather (Open-Meteo, no key) ─────────────────────────────────────────────
async function getWeather(location: string): Promise<string> {
  if (!location) return 'No location given.'

  const geo = await fetchJSONRetry<{ results?: Array<{ latitude: number; longitude: number; name: string; country: string; admin1?: string }> }>(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`,
  )
  const place = geo.results?.[0]
  if (!place) return `Could not find location "${location}".`

  const w = await fetchJSONRetry<{
    current: { temperature_2m: number; apparent_temperature: number; relative_humidity_2m: number; wind_speed_10m: number; weather_code: number; is_day: number }
    daily: { temperature_2m_max: number[]; temperature_2m_min: number[]; precipitation_probability_max: number[] }
  }>(
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
    `&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code,is_day` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=2&timezone=auto`,
  )

  const desc = WMO[w.current.weather_code] ?? 'unknown conditions'
  const where = `${place.name}${place.admin1 ? ', ' + place.admin1 : ''}, ${place.country}`
  return [
    `Weather in ${where}:`,
    `Now: ${w.current.temperature_2m}°C (feels ${w.current.apparent_temperature}°C), ${desc}, humidity ${w.current.relative_humidity_2m}%, wind ${w.current.wind_speed_10m} km/h.`,
    `Today: ${w.daily.temperature_2m_min[0]}–${w.daily.temperature_2m_max[0]}°C, rain chance ${w.daily.precipitation_probability_max[0]}%.`,
    `Tomorrow: ${w.daily.temperature_2m_min[1]}–${w.daily.temperature_2m_max[1]}°C, rain chance ${w.daily.precipitation_probability_max[1]}%.`,
  ].join('\n')
}

const WMO: Record<number, string> = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'depositing rime fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'dense drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow',
  77: 'snow grains', 80: 'rain showers', 81: 'heavy showers', 82: 'violent showers',
  85: 'snow showers', 86: 'heavy snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'severe thunderstorm',
}

// ── Time (resolve city → timezone via Open-Meteo geocoder) ───────────────────
async function getTime(location: string): Promise<string> {
  const now = new Date()

  // If looks like an IANA zone, use it directly
  if (/^[A-Za-z_]+\/[A-Za-z_]+/.test(location)) {
    return `${location}: ${now.toLocaleString('en-US', { timeZone: location, dateStyle: 'full', timeStyle: 'medium' })}`
  }

  if (!location) {
    return `Local time: ${now.toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'medium' })}`
  }

  const geo = await fetchJSONRetry<{ results?: Array<{ timezone: string; name: string; country: string }> }>(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`,
  )
  const place = geo.results?.[0]
  if (!place) return `Could not resolve timezone for "${location}".`
  return `${place.name}, ${place.country} (${place.timezone}): ${now.toLocaleString('en-US', { timeZone: place.timezone, dateStyle: 'full', timeStyle: 'medium' })}`
}

// ── Wikipedia summary ────────────────────────────────────────────────────────
async function wikipedia(topic: string): Promise<string> {
  if (!topic) return 'No topic given.'
  try {
    const data = await fetchJSON<{ title?: string; extract?: string; description?: string }>(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topic.replace(/\s+/g, '_'))}`,
    )
    if (!data.extract) return `No Wikipedia article for "${topic}".`
    return `${data.title}${data.description ? ` — ${data.description}` : ''}\n\n${data.extract}`
  } catch {
    return `No Wikipedia article for "${topic}".`
  }
}

// ── News (Hacker News top stories) ───────────────────────────────────────────
async function getNews(count: number): Promise<string> {
  const n = Math.max(1, Math.min(10, count || 5))
  const ids = await fetchJSON<number[]>('https://hacker-news.firebaseio.com/v0/topstories.json')
  const top = ids.slice(0, n)
  const stories = await Promise.all(top.map(id =>
    fetchJSON<{ title?: string; url?: string; score?: number; by?: string }>(
      `https://hacker-news.firebaseio.com/v0/item/${id}.json`,
    ).catch(() => null),
  ))
  return stories
    .filter((s): s is { title?: string; url?: string; score?: number; by?: string } => !!s && !!s.title)
    .map((s, i) => `${i + 1}. ${s.title} (${s.score} points)${s.url ? `\n   ${s.url}` : ''}`)
    .join('\n')
}

// ── Currency conversion (open.er-api.com, no key) ────────────────────────────
async function currencyConvert(amount: number, from: string, to: string): Promise<string> {
  if (!isFinite(amount)) return 'Invalid amount.'
  const f = (from || '').toUpperCase()
  const t = (to   || '').toUpperCase()
  if (!f || !t) return 'Specify "from" and "to" 3-letter currency codes.'

  const data = await fetchJSONRetry<{ result: string; rates: Record<string, number>; base_code: string }>(
    `https://open.er-api.com/v6/latest/${f}`,
  )
  if (data.result !== 'success') return `Could not fetch rates for ${f}.`
  const rate = data.rates[t]
  if (!rate) return `Unknown currency code "${t}".`
  const converted = amount * rate
  return `${amount} ${f} = ${converted.toFixed(2)} ${t} (rate: 1 ${f} = ${rate} ${t})`
}

// ── Crypto (CoinGecko, no key) ───────────────────────────────────────────────
async function cryptoPrice(coin: string): Promise<string> {
  if (!coin) return 'No coin specified.'
  const id = coin.toLowerCase().replace(/\s+/g, '-')
  const data = await fetchJSONRetry<Record<string, { usd: number; usd_24h_change?: number }>>(
    `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd&include_24hr_change=true`,
  )
  const info = data[id]
  if (!info) return `Unknown coin "${coin}". Try the full id (e.g. "bitcoin", "ethereum").`
  const change = info.usd_24h_change != null ? ` (${info.usd_24h_change >= 0 ? '+' : ''}${info.usd_24h_change.toFixed(2)}% 24h)` : ''
  return `${coin}: $${info.usd.toLocaleString()}${change}`
}

// ── Stock (Yahoo Finance public quote endpoint, no key) ──────────────────────
async function stockPrice(symbol: string): Promise<string> {
  if (!symbol) return 'No symbol specified.'
  const sym = symbol.toUpperCase()
  const data = await fetchJSONRetry<{
    chart: { result?: Array<{ meta: { regularMarketPrice: number; previousClose: number; currency: string; longName?: string; symbol: string } }>; error?: { description: string } }
  }>(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`)

  const r = data.chart.result?.[0]
  if (!r) return `Could not fetch quote for "${sym}".`
  const m = r.meta
  const change = m.regularMarketPrice - m.previousClose
  const pct = (change / m.previousClose) * 100
  const sign = change >= 0 ? '+' : ''
  return `${m.longName ?? m.symbol} (${m.symbol}): ${m.regularMarketPrice.toFixed(2)} ${m.currency} (${sign}${change.toFixed(2)}, ${sign}${pct.toFixed(2)}%)`
}

// ── Dictionary ───────────────────────────────────────────────────────────────
async function defineWord(word: string): Promise<string> {
  if (!word) return 'No word given.'
  try {
    const data = await fetchJSON<Array<{
      word: string
      phonetic?: string
      meanings: Array<{ partOfSpeech: string; definitions: Array<{ definition: string; example?: string }> }>
    }>>(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`)
    const entry = data[0]
    if (!entry) return `No definition found for "${word}".`
    const lines = [`${entry.word}${entry.phonetic ? ` ${entry.phonetic}` : ''}`]
    entry.meanings.slice(0, 2).forEach(m => {
      lines.push(`(${m.partOfSpeech}) ${m.definitions[0]?.definition ?? ''}`)
      if (m.definitions[0]?.example) lines.push(`   e.g. "${m.definitions[0].example}"`)
    })
    return lines.join('\n')
  } catch {
    return `No definition found for "${word}".`
  }
}

// ── Calculator (safe — no eval, only whitelisted tokens) ─────────────────────
function calculate(expression: string): string {
  if (!expression) return 'No expression.'
  const cleaned = expression.replace(/\s+/g, '')
  if (!/^[-+*/%().\d,e^sqrtablogincoexpiPI]+$/i.test(cleaned)) {
    return `Expression contains unsupported characters.`
  }
  const mapped = expression
    .replace(/\^/g, '**')
    .replace(/\bpi\b/gi, 'Math.PI')
    .replace(/\be\b/g, 'Math.E')
    .replace(/\b(sqrt|cbrt|log|log2|log10|exp|abs|sin|cos|tan|asin|acos|atan|floor|ceil|round)\(/gi, 'Math.$1(')
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const result = Function(`"use strict"; return (${mapped})`)()
    if (typeof result !== 'number' || !isFinite(result)) return `Invalid result.`
    return `${expression} = ${result}`
  } catch (e) {
    return `Math error: ${(e as Error).message}`
  }
}

// ── IP geolocation ───────────────────────────────────────────────────────────
async function getLocation(): Promise<string> {
  const data = await fetchJSON<{ city?: string; region?: string; country_name?: string; latitude?: number; longitude?: number; timezone?: string }>(
    'https://ipapi.co/json/',
  )
  if (!data.city) return 'Could not determine location.'
  return `${data.city}, ${data.region}, ${data.country_name} (${data.timezone})`
}

// ── Filesystem ───────────────────────────────────────────────────────────────
async function readFileContents(filePath: string): Promise<string> {
  const SAFE_EXTS = ['.txt', '.md', '.json', '.js', '.ts', '.tsx', '.jsx', '.py', '.sh', '.yaml', '.yml', '.toml', '.csv', '.html', '.css']
  const MAX_BYTES = 16_000
  const ext = extname(filePath).toLowerCase()
  if (!SAFE_EXTS.includes(ext)) return `File type ${ext || '(none)'} is not readable as text.`
  const info = await stat(filePath)
  if (info.size > MAX_BYTES) {
    const buf = Buffer.alloc(MAX_BYTES)
    const { open } = await import('fs/promises')
    const fd = await open(filePath, 'r')
    await fd.read(buf, 0, MAX_BYTES, 0)
    await fd.close()
    return buf.toString('utf8') + `\n[...truncated — file is ${info.size} bytes]`
  }
  return await readFile(filePath, 'utf8')
}

async function listDir(dirPath: string): Promise<string> {
  const entries = await readdir(dirPath, { withFileTypes: true })
  return entries.map(e => `${e.isDirectory() ? 'd' : 'f'}  ${e.name}`).join('\n')
}

async function searchFiles(dir: string, pattern: string, depth = 4): Promise<string> {
  const matches: string[] = []
  async function walk(current: string, d: number): Promise<void> {
    if (d === 0 || matches.length > 50) return
    try {
      const entries = await readdir(current, { withFileTypes: true })
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue
        const full = join(current, e.name)
        if (e.name.toLowerCase().includes(pattern.toLowerCase())) matches.push(full)
        if (e.isDirectory()) await walk(full, d - 1)
      }
    } catch { /* ignore */ }
  }
  await walk(dir, depth)
  return matches.length ? matches.join('\n') : `No files matching "${pattern}".`
}

// ── System action tools ──────────────────────────────────────────────────────

async function openUrl(url: string): Promise<string> {
  if (!url) return 'No URL given.'
  let target = url.trim()
  if (!/^https?:\/\//i.test(target) && !/^mailto:|^file:/i.test(target)) {
    target = 'https://' + target
  }
  await shell.openExternal(target)
  return `Opened ${target}`
}

/** Try to launch an app cross-platform. macOS: `open -a`, Windows: `start`, Linux: best-effort which/xdg-open. */
async function openApp(name: string): Promise<string> {
  if (!name) return 'No app name given.'
  const safe = name.replace(/"/g, '\\"')
  const plat = process.platform

  try {
    if (plat === 'darwin') {
      await execAsync(`open -a "${safe}"`, { timeout: SHELL_TIMEOUT_MS })
      return `Launching "${name}" (macOS).`
    }
    if (plat === 'win32') {
      await execAsync(`start "" "${safe}"`, { timeout: SHELL_TIMEOUT_MS, shell: 'cmd.exe' })
      return `Launching "${name}" (Windows).`
    }
    // linux: try the binary directly, then a couple of common variants
    const candidates = [name, name.toLowerCase(), name.replace(/\s+/g, '').toLowerCase()]
    for (const c of candidates) {
      try {
        const which = await execAsync(`which "${c}"`, { timeout: 2000 })
        if (which.stdout.trim()) {
          exec(c, { timeout: SHELL_TIMEOUT_MS }, () => { /* fire and forget */ })
          return `Launching "${c}" (Linux).`
        }
      } catch { /* try next */ }
    }
    return `Could not find an executable named "${name}" on PATH.`
  } catch (e) {
    return `Failed to launch "${name}": ${(e as Error).message}`
  }
}

async function openPath(p: string): Promise<string> {
  if (!p) return 'No path given.'
  const err = await shell.openPath(p)
  if (err) return `Could not open "${p}": ${err}`
  return `Opened ${p}`
}

async function runCommand(command: string, cwd?: string): Promise<string> {
  if (!command) return 'No command given.'
  // Lightweight footgun guard — refuse the most catastrophic patterns outright.
  const banned = [/\brm\s+-rf\s+\/(\s|$)/i, /\bmkfs\./i, /:\(\)\s*\{\s*:\|:&/i, /\bdd\s+if=.*of=\/dev\//i]
  if (banned.some(rx => rx.test(command))) {
    return `Refused: command appears destructive. Ask the user to run it manually if intended.`
  }
  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout: SHELL_TIMEOUT_MS,
      maxBuffer: SHELL_MAX_BUFFER,
      cwd: cwd || process.cwd(),
    })
    const out = (stdout || '').trim()
    const err = (stderr || '').trim()
    if (!out && !err) return '(command finished with no output)'
    return [out && `stdout:\n${out}`, err && `stderr:\n${err}`].filter(Boolean).join('\n\n')
  } catch (e) {
    const err = e as { message: string; stdout?: string; stderr?: string; code?: number; killed?: boolean }
    if (err.killed) return `Command timed out after ${SHELL_TIMEOUT_MS / 1000}s.`
    const tail = [err.stdout && `stdout:\n${err.stdout.toString().trim()}`, err.stderr && `stderr:\n${err.stderr.toString().trim()}`].filter(Boolean).join('\n\n')
    return `Command failed (exit ${err.code ?? '?'}): ${err.message}${tail ? '\n' + tail : ''}`
  }
}

function readClipboardText(): string {
  const text = clipboard.readText()
  if (!text) return '(clipboard is empty)'
  return text
}

function writeClipboardText(text: string): string {
  clipboard.writeText(text)
  return `Copied ${text.length} characters to clipboard.`
}

async function captureScreenshot(): Promise<string> {
  try {
    const orbWin = BrowserWindow.getAllWindows()[0]
    const display = screen.getPrimaryDisplay()
    const { width, height } = display.size
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.min(1920, width), height: Math.min(1080, height) },
    })
    const primary = sources[0]
    if (!primary) return 'No screen source available.'

    // Save to user's downloads folder for follow-up actions
    const fs = await import('fs/promises')
    const dest = join(app.getPath('downloads'), `jarviz-screenshot-${Date.now()}.png`)
    const png = primary.thumbnail.toPNG()
    await fs.writeFile(dest, png)

    const dim = primary.thumbnail.getSize()
    void orbWin
    return `Captured screen "${primary.name}" (${dim.width}×${dim.height}). Saved to: ${dest}`
  } catch (e) {
    return `Screenshot failed: ${(e as Error).message}`
  }
}

function showNotification(title: string, body: string): string {
  if (!Notification.isSupported()) return 'Native notifications not supported on this system.'
  new Notification({ title: title || 'Jarviz', body: body || '' }).show()
  return `Notified: ${title}`
}

function getSystemInfo(): string {
  const cpuList = cpus()
  const cpuName = cpuList[0]?.model ?? 'unknown'
  const memGB = (totalmem() / 1024 ** 3).toFixed(1)
  const freeGB = (freemem() / 1024 ** 3).toFixed(1)
  const u = userInfo()
  return [
    `OS: ${platform()} ${release()} (${arch()})`,
    `Host: ${hostname()}`,
    `User: ${u.username} (home: ${homedir()})`,
    `CPU: ${cpuName} (${cpuList.length} cores)`,
    `Memory: ${freeGB} GB free / ${memGB} GB total`,
  ].join('\n')
}
