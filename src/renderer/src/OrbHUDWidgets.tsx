import { useEffect, useState } from 'react'
import type { JarvizState } from './state/JarvizFSM'

/**
 * Floating sci-fi data widgets that surround the orb.
 * These give the "JARVIS cockpit" feel without circling rings.
 *   • Top-left:    J-CORE identity strip with running uptime + state badge
 *   • Top-right:   live system stats (CPU / MEM) + tiny waveform tick
 *   • Bottom-left: chip ID + signal bars
 *   • Bottom-right: status code + audio level bar
 */

const STATE_ACCENT: Record<JarvizState | 'searching', string> = {
  idle:         '#8AB4F8',
  listening:    '#FF8A80',
  transcribing: '#A8D8B9',
  thinking:     '#D7AEFB',
  searching:    '#A8D8B9',
  speaking:     '#FBD688',
  followUp:     '#8AB4F8',
  error:        '#F28B82',
}

const STATE_LABEL: Record<JarvizState | 'searching', string> = {
  idle:         'STANDBY',
  listening:    'LIVE-IN',
  transcribing: 'PARSE',
  thinking:     'COMPUTE',
  searching:    'QUERY',
  speaking:     'OUTBOUND',
  followUp:     'STANDBY',
  error:        'FAULT',
}

interface Props {
  state:    JarvizState | 'searching'
  amp:      number
  uptime:   number  // milliseconds since app start
}

const fontMono: React.CSSProperties = {
  fontFamily: '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace',
  fontVariantNumeric: 'tabular-nums',
  letterSpacing: '0.04em',
}

function fmtUptime(ms: number): string {
  const sec = Math.floor(ms / 1000) % 60
  const min = Math.floor(ms / 60000) % 60
  const hr  = Math.floor(ms / 3600000)
  return `${String(hr).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

export function OrbHUDWidgets({ state, amp, uptime }: Props) {
  const accent = STATE_ACCENT[state] ?? '#8AB4F8'
  const label  = STATE_LABEL[state] ?? state.toUpperCase()

  // Animated mock telemetry — moves smoothly with random walks
  const [tele, setTele] = useState({ cpu: 14, mem: 38, net: 92, sig: 4 })
  useEffect(() => {
    const id = setInterval(() => {
      setTele(prev => ({
        cpu: clamp(prev.cpu + (Math.random() - 0.5) * 6, 4, 64),
        mem: clamp(prev.mem + (Math.random() - 0.5) * 4, 22, 70),
        net: clamp(prev.net + (Math.random() - 0.5) * 3, 80, 99),
        sig: state === 'idle' ? 4 : Math.random() < 0.85 ? 4 : 3,
      }))
    }, 950)
    return () => clearInterval(id)
  }, [state])

  // Audio-reactive tick (smoothed)
  const [smoothAmp, setSmoothAmp] = useState(0)
  useEffect(() => {
    let raf = 0
    const loop = (): void => {
      setSmoothAmp(prev => prev * 0.84 + amp * 0.16)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [amp])

  return (
    <>
      {/* ── Top-left: J-CORE identity ──────────────────────────────────────── */}
      <div data-testid="hud-id" style={{
        position: 'fixed',
        top: 14, left: 14,
        zIndex: 12, pointerEvents: 'none',
        ...fontMono,
        color: 'rgba(240,242,248,0.94)',
        fontSize: 9.5,
        textTransform: 'uppercase',
      }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
          <CornerGlyph color={accent} />
          <span style={{ fontWeight: 700, letterSpacing: '0.16em' }}>J-CORE 7.3</span>
        </div>
        <div style={{ fontSize: 9, opacity: 0.55, marginBottom: 4, letterSpacing: '0.12em' }}>
          UPTIME · {fmtUptime(uptime)}
        </div>
        <div style={{
          display: 'inline-block',
          padding: '2px 7px',
          borderRadius: 3,
          background: `${accent}26`,
          border: `1px solid ${accent}66`,
          color: accent,
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: '0.16em',
          boxShadow: `0 0 6px ${accent}44`,
        }}>
          {label}
        </div>
      </div>

      {/* ── Top-right: telemetry ───────────────────────────────────────────── */}
      <div data-testid="hud-telemetry" style={{
        position: 'fixed',
        top: 14, right: 50, // leave 36px for the gear button at right: 14
        zIndex: 12, pointerEvents: 'none',
        ...fontMono,
        textAlign: 'right',
        color: 'rgba(240,242,248,0.92)',
        fontSize: 9,
        textTransform: 'uppercase',
      }}>
        <Row label="CPU"  value={`${tele.cpu.toFixed(0).padStart(2,'0')}%`} accent={accent} />
        <Row label="MEM"  value={`${tele.mem.toFixed(0).padStart(2,'0')}%`} accent={accent} />
        <Row label="NET"  value={`${tele.net.toFixed(0)}%`} accent={accent} />
      </div>

      {/* ── Bottom-left: chip + signal ─────────────────────────────────────── */}
      <div data-testid="hud-signal" style={{
        position: 'fixed',
        bottom: 14, left: 14,
        zIndex: 12, pointerEvents: 'none',
        ...fontMono,
        color: 'rgba(240,242,248,0.85)',
        fontSize: 9,
        textTransform: 'uppercase',
      }}>
        <div style={{ marginBottom: 4, opacity: 0.55, letterSpacing: '0.16em' }}>
          NODE · J7-A
        </div>
        <SignalBars level={tele.sig} accent={accent} />
      </div>

      {/* ── Bottom-right: audio level + status code ────────────────────────── */}
      <div data-testid="hud-audio" style={{
        position: 'fixed',
        bottom: 14, right: 14,
        zIndex: 12, pointerEvents: 'none',
        ...fontMono,
        color: 'rgba(240,242,248,0.85)',
        fontSize: 9,
        textTransform: 'uppercase',
        textAlign: 'right',
      }}>
        <div style={{ marginBottom: 4, opacity: 0.55, letterSpacing: '0.16em' }}>
          LVL {Math.round(smoothAmp * 100).toString().padStart(2, '0')} · OK
        </div>
        <AudioMeter level={smoothAmp} accent={accent} />
      </div>
    </>
  )
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function Row({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div style={{ marginBottom: 2, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
      <span style={{ opacity: 0.55, letterSpacing: '0.16em' }}>{label}</span>
      <span style={{ color: accent, fontWeight: 700, minWidth: 36, textAlign: 'right' }}>{value}</span>
    </div>
  )
}

function CornerGlyph({ color }: { color: string }) {
  return (
    <svg width={10} height={10} viewBox="0 0 10 10" style={{ overflow: 'visible' }}>
      <path d="M 1 1 L 1 5 L 5 5 L 5 9 L 9 9" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function SignalBars({ level, accent }: { level: number; accent: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2 }}>
      {[3, 6, 9, 12].map((h, i) => (
        <div key={i} style={{
          width: 3, height: h,
          background: i < level ? accent : 'rgba(255,255,255,0.18)',
          borderRadius: 1,
          boxShadow: i < level ? `0 0 4px ${accent}88` : 'none',
        }} />
      ))}
    </div>
  )
}

function AudioMeter({ level, accent }: { level: number; accent: string }) {
  const bars = 12
  const active = Math.round(level * bars)
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
      {Array.from({ length: bars }).map((_, i) => (
        <div key={i} style={{
          width: 3, height: 9,
          background: i < active ? accent : 'rgba(255,255,255,0.12)',
          borderRadius: 1,
          boxShadow: i < active ? `0 0 4px ${accent}88` : 'none',
        }} />
      ))}
    </div>
  )
}
