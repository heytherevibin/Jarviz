import { useEffect, useRef } from 'react'
import type { JarvizState } from './state/JarvizFSM'

/**
 * Premium HUD overlay rendered as SVG behind the orb canvas.
 * Adds rotating segmented arcs, tick marks, corner brackets, scan lines,
 * and a state-aware accent so the orb sits inside a "JARVIS HUD".
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

interface Props {
  state: JarvizState | 'searching'
  size: number
  amp: number
}

export function HUDLayer({ state, size, amp }: Props) {
  const accent = STATE_ACCENT[state] ?? '#8AB4F8'
  const ringRef = useRef<SVGGElement>(null)
  const counterRingRef = useRef<SVGGElement>(null)
  const reticleRef = useRef<SVGGElement>(null)

  // requestAnimationFrame-driven rotation (smoother than CSS keyframes for state changes)
  useEffect(() => {
    let raf = 0
    let t = 0
    const dirByState: Record<string, number> = {
      idle:      0.06,
      listening: 0.18,
      thinking:  0.40,
      searching: 0.30,
      speaking:  0.22,
      followUp:  0.10,
      error:     0.04,
    }
    const tick = (): void => {
      t += dirByState[state] ?? 0.06
      if (ringRef.current)        ringRef.current.style.transform        = `rotate(${t}deg)`
      if (counterRingRef.current) counterRingRef.current.style.transform = `rotate(${-t * 1.6}deg)`
      if (reticleRef.current)     reticleRef.current.style.transform     = `rotate(${t * 0.5}deg)`
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [state])

  const cx = size / 2
  const cy = size / 2
  const rOuter   = size * 0.46
  const rInner   = size * 0.40
  const rTicks   = size * 0.49
  const rDeep    = size * 0.495

  // Outer dashed ring (longer, slow rotation)
  const outerSeg = 2 * Math.PI * rOuter
  const outerDash = `${outerSeg * 0.018} ${outerSeg * 0.0025} ${outerSeg * 0.10} ${outerSeg * 0.018}`

  const innerSeg = 2 * Math.PI * rInner
  const innerDash = `${innerSeg * 0.06} ${innerSeg * 0.018}`

  // 60 tick marks around the rim (8 are highlighted)
  const TICKS = 60
  const ticks = Array.from({ length: TICKS }, (_, i) => {
    const angle = (i / TICKS) * Math.PI * 2 - Math.PI / 2
    const major = i % 5 === 0
    const len   = major ? size * 0.020 : size * 0.010
    const x1 = cx + Math.cos(angle) * (rTicks - len)
    const y1 = cy + Math.sin(angle) * (rTicks - len)
    const x2 = cx + Math.cos(angle) * rTicks
    const y2 = cy + Math.sin(angle) * rTicks
    return { x1, y1, x2, y2, major }
  })

  // Audio-reactive expansion of the deep "scan ring"
  const scanR = rDeep + amp * size * 0.02
  const scanOpacity = 0.10 + amp * 0.30

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
        filter:     `drop-shadow(0 0 18px ${accent}33)`,
      }}
    >
      <defs>
        <radialGradient id="hud-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%"  stopColor={accent} stopOpacity="0.18" />
          <stop offset="60%" stopColor={accent} stopOpacity="0.04" />
          <stop offset="100%" stopColor={accent} stopOpacity="0" />
        </radialGradient>
        <linearGradient id="hud-arc" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%"  stopColor={accent} stopOpacity="1.0" />
          <stop offset="50%" stopColor={accent} stopOpacity="0.4" />
          <stop offset="100%" stopColor={accent} stopOpacity="0.05" />
        </linearGradient>
      </defs>

      {/* Soft inner halo */}
      <circle cx={cx} cy={cy} r={rOuter * 1.05} fill="url(#hud-glow)" />

      {/* Audio-reactive scan ring */}
      <circle
        cx={cx} cy={cy} r={scanR}
        stroke={accent} strokeOpacity={scanOpacity}
        strokeWidth={1} fill="none"
      />

      {/* Tick marks ring */}
      {ticks.map((t, i) => (
        <line
          key={i}
          x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2}
          stroke={accent}
          strokeOpacity={t.major ? 0.65 : 0.28}
          strokeWidth={t.major ? 1.4 : 0.8}
          strokeLinecap="round"
        />
      ))}

      {/* Outer rotating segmented ring */}
      <g ref={ringRef} style={{ transformOrigin: `${cx}px ${cy}px` }}>
        <circle
          cx={cx} cy={cy} r={rOuter}
          stroke="url(#hud-arc)" strokeWidth={1.4}
          fill="none"
          strokeDasharray={outerDash}
          strokeOpacity={0.75}
          strokeLinecap="round"
        />
      </g>

      {/* Inner counter-rotating ring */}
      <g ref={counterRingRef} style={{ transformOrigin: `${cx}px ${cy}px` }}>
        <circle
          cx={cx} cy={cy} r={rInner}
          stroke={accent} strokeWidth={0.9}
          fill="none"
          strokeDasharray={innerDash}
          strokeOpacity={0.40}
        />
      </g>

      {/* Orbital reticle marks (4 quadrant pips slowly spinning) */}
      <g ref={reticleRef} style={{ transformOrigin: `${cx}px ${cy}px` }}>
        {[0, 90, 180, 270].map(deg => {
          const a = (deg * Math.PI) / 180
          const px = cx + Math.cos(a) * rOuter
          const py = cy + Math.sin(a) * rOuter
          return (
            <g key={deg}>
              <circle cx={px} cy={py} r={3.2} fill={accent} fillOpacity={0.85} />
              <circle cx={px} cy={py} r={6}   fill="none"   stroke={accent} strokeOpacity={0.30} />
            </g>
          )
        })}
      </g>

      {/* Corner brackets (top-left, top-right, bottom-left, bottom-right) */}
      {[
        [size * 0.04, size * 0.04, size * 0.10, size * 0.04, size * 0.04, size * 0.10],
        [size - size * 0.04, size * 0.04, size - size * 0.10, size * 0.04, size - size * 0.04, size * 0.10],
        [size * 0.04, size - size * 0.04, size * 0.10, size - size * 0.04, size * 0.04, size - size * 0.10],
        [size - size * 0.04, size - size * 0.04, size - size * 0.10, size - size * 0.04, size - size * 0.04, size - size * 0.10],
      ].map((pts, i) => (
        <polyline
          key={i}
          points={`${pts[2]},${pts[3]} ${pts[0]},${pts[1]} ${pts[4]},${pts[5]}`}
          fill="none"
          stroke={accent}
          strokeOpacity={0.55}
          strokeWidth={1.4}
          strokeLinecap="round"
        />
      ))}
    </svg>
  )
}
