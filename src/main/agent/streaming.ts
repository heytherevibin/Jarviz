/**
 * Sentence-level TTS pipelining for "instant speak" UX.
 *
 * Splits a reply into clean speakable sentences (~1 sentence ≈ ~1 second of TTS),
 * synthesises them in parallel, and emits them in order via callback.
 * Renderer plays each chunk as it arrives, so the user hears the first words
 * within ~0.5–1s of the agent finishing instead of waiting 3–6s for the whole
 * reply to be synthesised.
 */

import { synthesize, type SynthesisResult } from './tts'

export interface SpeechChunk {
  index:     number
  total:     number
  text:      string
  audio:     number[] | null
  audioMime: string | null
  isFinal:   boolean
}

/**
 * Split text into sentence-shaped chunks suitable for sequential TTS playback.
 * Heuristics:
 *   • split on `. ! ? …` followed by whitespace OR end-of-text
 *   • never split inside common abbreviations (Mr., Dr., etc.)
 *   • merge tiny fragments (<24 chars) with the next chunk
 *   • soft cap: 220 chars per chunk (avoid TTS truncation)
 */
export function chunkForSpeech(text: string): string[] {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (!cleaned) return []

  const ABBR = /(Mr|Mrs|Ms|Dr|Sr|Jr|St|vs|etc|e\.g|i\.e|U\.S|U\.K|a\.m|p\.m|No)\.$/i
  const SOFT_CAP = 220

  const out: string[] = []
  let buf = ''
  const re = /([^.!?…]+[.!?…]+|[^.!?…]+$)/g
  const matches = cleaned.match(re) ?? [cleaned]

  for (const raw of matches) {
    const seg = raw.trim()
    if (!seg) continue
    // If we're mid-sentence (abbreviation), keep accumulating
    if (ABBR.test(buf + seg)) { buf = (buf ? buf + ' ' : '') + seg; continue }

    const candidate = buf ? buf + ' ' + seg : seg

    if (candidate.length < 24) {
      // Too short — keep buffering
      buf = candidate
    } else if (candidate.length <= SOFT_CAP) {
      out.push(candidate)
      buf = ''
    } else {
      // Hard cap — split on nearest comma/space before SOFT_CAP
      const cut = findBreakPoint(candidate, SOFT_CAP)
      out.push(candidate.slice(0, cut).trim())
      buf = candidate.slice(cut).trim()
    }
  }
  if (buf) out.push(buf)
  return out.filter(s => s.length > 0)
}

function findBreakPoint(s: string, max: number): number {
  for (let i = max; i > max - 80; i--) {
    if (i <= 0) break
    const c = s[i]
    if (c === ',' || c === ';' || c === ' ') return i + 1
  }
  return Math.min(s.length, max)
}

type ChunkCallback = (chunk: SpeechChunk) => void

/**
 * Pipeline: emit sentences in order as their TTS completes.
 * Synthesizes all chunks in parallel; emits in original order.
 *
 * If TTS isn't configured (returns null), we still emit chunks with audio=null
 * so the renderer can show captions in cadence.
 */
export async function streamSpeak(text: string, onChunk: ChunkCallback): Promise<void> {
  let chunks = chunkForSpeech(text)
  if (chunks.length === 0 && text.trim()) chunks = [text.trim()]
  if (chunks.length === 0) return

  // Kick off all syntheses in parallel
  const futures = chunks.map(c => synthesize(c).catch(() => null as SynthesisResult | null))

  // Emit in order — wait for chunk i before emitting i+1
  for (let i = 0; i < futures.length; i++) {
    const a = await futures[i]
    onChunk({
      index:     i,
      total:     chunks.length,
      text:      chunks[i],
      audio:     a ? Array.from(a.buffer) : null,
      audioMime: a?.mime ?? null,
      isFinal:   i === futures.length - 1,
    })
  }
}
