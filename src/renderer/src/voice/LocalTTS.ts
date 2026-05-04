// Browser-native TTS — used when Gemini/ElevenLabs are unavailable.
// Tuned for a SOFT FEMALE delivery (matching the Gemini "Aoede" default the
// panel exposes). Falls back gracefully through neural → premium → enhanced
// female voices on macOS / Windows / ChromeOS.

let cachedVoice: SpeechSynthesisVoice | null = null
let speaking = false

// Soft-female voice catalogue, in preference order (best-sounding first).
// Covers macOS (Samantha/Ava/Allison/Serena), Windows neural (Aria/Jenny),
// and Google Cloud voices.
const SOFT_FEMALE_VOICES = [
  // macOS premium / enhanced female voices
  'Ava (Premium)', 'Ava (Enhanced)', 'Ava',
  'Allison (Premium)', 'Allison (Enhanced)', 'Allison',
  'Samantha (Enhanced)', 'Samantha',
  'Serena (Premium)', 'Serena',
  'Susan (Enhanced)', 'Susan',
  'Karen (Enhanced)', 'Karen',        // AU — warm
  'Moira (Enhanced)', 'Moira',        // IE — gentle
  'Tessa (Enhanced)', 'Tessa',        // ZA — soft
  'Fiona',                             // Scottish, breathy
  'Kate',
  // Windows neural (Edge/Chromium) — smoothest on Windows
  'Microsoft Aria Online',
  'Microsoft Jenny Online',
  'Microsoft Michelle Online',
  'Microsoft Sonia Online',
  'Microsoft Libby Online',
  'Microsoft Emma Online',
  // Google Chrome cloud voices
  'Google UK English Female',
  'Google US English',                 // neutral female on Chrome
]

// Heuristics to identify female voices when the exact names above aren't available.
const FEMALE_HINTS = /\b(female|woman|aria|jenny|michelle|sonia|libby|emma|ava|allison|samantha|serena|susan|karen|moira|tessa|fiona|kate|victoria|zira|hazel|eva|nora|amelie|amelia|chloe|luciana|paulina|monica|helena|veena|rishi|mei|lily|joanna|ivy|salli|kimberly)\b/i

function isFemaleVoice(v: SpeechSynthesisVoice): boolean {
  return FEMALE_HINTS.test(v.name)
}

function pickVoice(): SpeechSynthesisVoice | null {
  if (cachedVoice) return cachedVoice
  const voices = window.speechSynthesis.getVoices()
  if (!voices.length) return null

  // 1. Curated soft-female voice list — exact match first, then partial match
  for (const name of SOFT_FEMALE_VOICES) {
    const v = voices.find(x => x.name === name) ?? voices.find(x => x.name.includes(name))
    if (v) { cachedVoice = v; return v }
  }

  // 2. Any English female voice we can identify via name hints
  const femaleEn = voices.find(v => v.lang.startsWith('en') && isFemaleVoice(v))
  if (femaleEn) { cachedVoice = femaleEn; return femaleEn }

  // 3. Any female voice in any locale
  const femaleAny = voices.find(isFemaleVoice)
  if (femaleAny) { cachedVoice = femaleAny; return femaleAny }

  // 4. Last resort — any local English voice (localService = native, less robotic)
  cachedVoice = voices.find(v => v.lang.startsWith('en') && v.localService)
            ?? voices.find(v => v.lang.startsWith('en'))
            ?? voices[0]
  return cachedVoice
}

if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  // Voices load async on Chrome/Edge — refresh cache when ready
  window.speechSynthesis.onvoiceschanged = () => { cachedVoice = null; pickVoice() }
  // Trigger initial population
  try { window.speechSynthesis.getVoices() } catch {}
}

export function speakLocal(text: string, onEnd?: () => void): void {
  if (!('speechSynthesis' in window) || !text.trim()) { onEnd?.(); return }

  window.speechSynthesis.cancel()
  speaking = true

  // Split long replies into clauses so each utterance ends cleanly. This avoids
  // the choppy mid-sentence cutoffs Web Speech sometimes does on long strings.
  const clauses = text
    .replace(/\s+/g, ' ')
    .match(/[^.!?]+[.!?]?/g) ?? [text]

  const finish = () => { speaking = false; onEnd?.() }

  let i = 0
  const speakNext = () => {
    if (i >= clauses.length) return finish()
    const utter = new SpeechSynthesisUtterance(clauses[i].trim())
    const voice = pickVoice()
    if (voice) utter.voice = voice
    // Soft, breezy female delivery — slightly brighter pitch, relaxed pace
    utter.rate   = 0.98
    utter.pitch  = 1.08
    utter.volume = 0.92
    utter.onend   = () => { i++; speakNext() }
    utter.onerror = () => { i++; speakNext() }
    window.speechSynthesis.speak(utter)
  }
  speakNext()
}

export function stopLocalSpeech(): void {
  speaking = false
  if ('speechSynthesis' in window) window.speechSynthesis.cancel()
}

export function isSpeakingLocal(): boolean {
  return speaking || (('speechSynthesis' in window) && window.speechSynthesis.speaking)
}
