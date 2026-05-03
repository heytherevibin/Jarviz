import { useEffect, useRef } from 'react'
import type { JarvizState } from './state/JarvizFSM'

/**
 * Premium HUD overlay rendered as SVG behind the orb canvas.
 * Minimalist & futuristic — no concentric rings circling the orb.
 *   • soft state-color radial halo
 *   • audio-reactive scan ring (single, ephemeral)
 *   • 4 quadrant reticle pips (orbiting, slow)
 *   • vertical scan beam (sweeps during listen/think/speak)
 *   • subtle perimeter tick marks
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

const ACTIVE_STATES = new Set<JarvizState>(['listening', 'transcribing', 'thinking', 'speaking'])

interface Props {
  state: JarvizState | 'searching'
  size: number
  amp: number
}

export function HUDLayer({ state, size, amp }: Props) {
  const accent = STATE_ACCENT[state] ?? '#8AB4F8'
  const reticleRef = useRef<SVGGElement>(null)
  const scanRef    = useRef<SVGLineElement>(null)

  // Independent rotation for the 4 reticle pips + horizontal sweep for scan beam
  useEffect(() => {
    let raf = 0
    let phase = 0
    const speedByState: Record<string, number> = {
      idle: 0.10, listening: 0.36, transcribing: 0.30, thinking: 0.55, searching: 0.40, speaking: 0.32, followUp: 0.18, error: 0.06,
    }
    const tick = (): void => {
      phase += speedByState[state] ?? 0.10
      if (reticleRef.current) reticleRef.current.style.transform = `rotate(${phase}deg)`
      if (scanRef.current && ACTIVE_STATES.has(state as JarvizState)) {
        const t = (phase * 0.6) % 200 / 200 // 0..1
        const x = (t < 0.5 ? t * 2 : (1 - t) * 2) // ping-pong 0..1
        scanRef.current.setAttribute('x1', String(size * (0.10 + x * 0.80)))
        scanRef.current.setAttribute('x2', String(size * (0.10 + x * 0.80)))
        scanRef.current.style.opacity = '0.55'
      } else if (scanRef.current) {
        scanRef.current.style.opacity = '0'
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [state, size])

  const cx = size / 2
  const cy = size / 2
  const rPip   = size * 0.46
  const rTicks = size * 0.49
  const rDeep  = size * 0.495

  // 36 light tick marks, only every 9th drawn (4 long marks at compass points)
  const TICKS = 36
  const ticks = Array.from({ length: TICKS }, (_, i) => {
    const angle = (i / TICKS) * Math.PI * 2 - Math.PI / 2
    const major = i % 9 === 0
    if (!major && i % 3 !== 0) return null
    const len = major ? size * 0.024 : size * 0.008
    const x1 = cx + Math.cos(angle) * (rTicks - len)
    const y1 = cy + Math.sin(angle) * (rTicks - len)
    const x2 = cx + Math.cos(angle) * rTicks
    const y2 = cy + Math.sin(angle) * rTicks
    return { x1, y1, x2, y2, major, key: i }
  }).filter(Boolean) as Array<{ x1: number; y1: number; x2: number; y2: number; major: boolean; key: number }>

  const scanR = rDeep + amp * size * 0.025
  const scanOpacity = 0.06 + amp * 0.34

  return (
    <svg
      data-testid="orb-hud"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={{
        position:   'absolute',
        inset:      0,
        pointerEvents: 'none',
        zIndex:     1,
        overflow:   'visible',
        filter:     `drop-shadow(0 0 26px ${accent}33)`,
      }}
    >
      <defs>
        <radialGradient id="hud-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%"  stopColor={accent} stopOpacity="0.20" />
          <stop offset="55%" stopColor={accent} stopOpacity="0.05" />
          <stop offset="100%" stopColor={accent} stopOpacity="0" />
        </radialGradient>
        <linearGradient id="hud-scan" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"  stopColor={accent} stopOpacity="0" />
          <stop offset="50%" stopColor={accent} stopOpacity="0.85" />
          <stop offset="100%" stopColor={accent} stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Soft halo behind the orb */}
      <circle cx={cx} cy={cy} r={rPip * 1.18} fill="url(#hud-glow)" />

      {/* Vertical scan beam (visible only in active states) */}
      <line
        ref={scanRef}
        x1={cx} y1={cy - rPip * 1.05}
        x2={cx} y2={cy + rPip * 1.05}
        stroke="url(#hud-scan)" strokeWidth={1.4}
        style={{ opacity: 0, transition: 'opacity 0.5s' }}
      />

      {/* Tick marks (sparse, only at major + half-major positions) */}
      {ticks.map(t => (
        <line
          key={t.key}
          x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2}
          stroke={accent}
          strokeOpacity={t.major ? 0.65 : 0.20}
          strokeWidth={t.major ? 1.6 : 0.8}
          strokeLinecap="round"
        />
      ))}

      {/* Audio-reactive scan ring */}
      <circle
        cx={cx} cy={cy} r={scanR}
        stroke={accent} strokeOpacity={scanOpacity}
        strokeWidth={1} fill="none"
      />

      {/* 4 quadrant reticle pips that orbit slowly */}
      <g ref={reticleRef} style={{ transformOrigin: `${cx}px ${cy}px` }}>
        {[0, 90, 180, 270].map(deg => {
          const a = (deg * Math.PI) / 180
          const px = cx + Math.cos(a) * rPip
          const py = cy + Math.sin(a) * rPip
          return (
            <g key={deg}>
              <circle cx={px} cy={py} r={3.2} fill={accent} fillOpacity={0.95} />
              <circle cx={px} cy={py} r={6.5} fill="none"   stroke={accent} strokeOpacity={0.30} />
            </g>
          )
        })}
      </g>
    </svg>
  )
}
