// Browser-native TTS — used when ElevenLabs is unavailable.
// Tuned for a soft, calm, professional delivery (not rough or over-eager).

let cachedVoice: SpeechSynthesisVoice | null = null
let speaking = false

function pickVoice(): SpeechSynthesisVoice | null {
  if (cachedVoice) return cachedVoice
  const voices = window.speechSynthesis.getVoices()
  if (!voices.length) return null

  // Premium / neural voices first (smoothest), then warm British/American males.
  // These names cover macOS, Windows (Edge/Chromium), and ChromeOS.
  const preferred = [
    'Microsoft Guy Online',          // Windows neural — soft, warm
    'Microsoft Ryan Online',         // Windows neural — calm, professional
    'Microsoft Aria Online',         // neutral, smooth
    'Google UK English Male',
    'Google US English',
    'Daniel (Enhanced)',             // macOS premium UK
    'Daniel',                        // macOS UK English male
    'Alex',                          // macOS US — warm baritone
    'Oliver',                        // UK
    'Arthur',                        // UK premium
    'Tom',                           // US, calm
  ]
  for (const name of preferred) {
    const v = voices.find(x => x.name === name) || voices.find(x => x.name.includes(name))
    if (v) { cachedVoice = v; return v }
  }
  // Fallback: any local English voice (localService = native, less robotic than cloud TTS)
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
    // Soft, professional delivery
    utter.rate   = 0.96   // slightly slower than default — calmer
    utter.pitch  = 1.0    // neutral, not gravelly
    utter.volume = 0.95   // pull back from clipping for a softer feel
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
