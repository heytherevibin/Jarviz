import { useEffect, useState, useCallback } from 'react'

interface SessionMeta {
  id: string
  startedAt: number
  endedAt: number
  preview: string
  turns: number
}

interface SessionFull {
  id: string
  startedAt: number
  endedAt: number
  preview: string
  turns: Array<{ role: string; text: string; ts: number }>
}

type Props = { open: boolean; onClose: () => void }

function fmtDate(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay
    ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' · ' +
      d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

export function TranscriptOverlay({ open, onClose }: Props) {
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [selected, setSelected] = useState<SessionFull | null>(null)
  const [loading, setLoading]   = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const list = await window.jarviz.transcripts.list()
      setSessions(list)
      if (selected && !list.find(s => s.id === selected.id)) setSelected(null)
    } finally {
      setLoading(false)
    }
  }, [selected])

  useEffect(() => {
    if (open) refresh()
  }, [open, refresh])

  const openSession = async (id: string): Promise<void> => {
    const s = await window.jarviz.transcripts.get(id)
    setSelected(s)
  }

  const deleteSession = async (id: string): Promise<void> => {
    if (!confirm('Delete this conversation?')) return
    await window.jarviz.transcripts.delete(id)
    if (selected?.id === id) setSelected(null)
    refresh()
  }

  const clearAll = async (): Promise<void> => {
    if (!confirm('Delete ALL saved conversations? This cannot be undone.')) return
    await window.jarviz.transcripts.clear()
    setSelected(null)
    refresh()
  }

  const startNewSession = async (): Promise<void> => {
    await window.jarviz.transcripts.newSession()
    onClose()
  }

  if (!open) return null

  return (
    <div
      className="jarviz-settings-root"
      data-testid="transcripts-overlay"
      style={{
        position: 'fixed', inset: 0, zIndex: 95,
        background: 'rgba(6,8,14,0.94)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 12,
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
      role="presentation"
    >
      <div style={{
        width: 'min(820px, 100vw - 24px)',
        height: 'min(620px, 92vh)',
        display: 'flex',
        borderRadius: 16,
        overflow: 'hidden',
        background: 'linear-gradient(165deg, rgba(28,32,44,0.96), rgba(18,20,30,0.98))',
        border: '1px solid rgba(255,255,255,0.10)',
        boxShadow: '0 24px 48px rgba(0,0,0,0.6)',
        color: '#e8eaef',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: 13,
      }}>
        {/* Sidebar — session list */}
        <div style={{
          width: 260, borderRight: '1px solid rgba(255,255,255,0.08)',
          display: 'flex', flexDirection: 'column', background: 'rgba(0,0,0,0.18)',
        }}>
          <div style={{ padding: '14px 14px 10px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: 0.3 }}>Conversations</div>
            <div style={{ fontSize: 10, opacity: 0.55, marginTop: 2 }}>{sessions.length} saved</div>
          </div>
          <div style={{ flex: 1, overflow: 'auto' }}>
            {loading && <div style={{ padding: 14, fontSize: 11, opacity: 0.6 }}>Loading…</div>}
            {!loading && sessions.length === 0 && (
              <div style={{ padding: 14, fontSize: 11, opacity: 0.5 }}>
                No saved conversations yet. Talk to Jarviz and they'll appear here.
              </div>
            )}
            {sessions.map(s => (
              <button
                key={s.id}
                type="button"
                data-testid={`transcript-session-${s.id}`}
                onClick={() => openSession(s.id)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  padding: '10px 14px', border: 'none',
                  background: selected?.id === s.id ? 'rgba(120,80,220,0.18)' : 'transparent',
                  borderLeft: selected?.id === s.id ? '2px solid #A142F4' : '2px solid transparent',
                  color: '#fff', cursor: 'pointer',
                }}
              >
                <div style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {s.preview || '(empty)'}
                </div>
                <div style={{ fontSize: 10, opacity: 0.55, marginTop: 2 }}>
                  {fmtDate(s.startedAt)} · {s.turns} turns
                </div>
              </button>
            ))}
          </div>
          <div style={{ padding: 10, borderTop: '1px solid rgba(255,255,255,0.06)', display: 'flex', gap: 6 }}>
            <button type="button" data-testid="transcripts-new" onClick={startNewSession} style={smallBtn('#4285F4')}>+ New</button>
            <button type="button" data-testid="transcripts-clear" onClick={clearAll} style={smallBtn('#EA4335')} disabled={!sessions.length}>Clear all</button>
          </div>
        </div>

        {/* Main pane — session detail */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div style={{
            padding: '14px 18px', borderBottom: '1px solid rgba(255,255,255,0.06)',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>
                {selected ? selected.preview : 'Transcripts'}
              </div>
              <div style={{ fontSize: 10, opacity: 0.55, marginTop: 2 }}>
                {selected
                  ? `${fmtDate(selected.startedAt)} → ${fmtDate(selected.endedAt)} · ${selected.turns.length} turns`
                  : 'Select a conversation on the left to view it.'}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {selected && (
                <button type="button" data-testid="transcript-delete" onClick={() => deleteSession(selected.id)} style={smallBtn('#EA4335')}>Delete</button>
              )}
              <button type="button" data-testid="transcripts-close" onClick={onClose} style={smallBtn('rgba(255,255,255,0.10)')}>Close</button>
            </div>
          </div>
          <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>
            {!selected && (
              <div style={{ marginTop: 60, textAlign: 'center', opacity: 0.5, fontSize: 12 }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>·°·</div>
                Pick a conversation to inspect.
              </div>
            )}
            {selected?.turns.map((t, i) => (
              <div key={i} style={{ marginBottom: 14 }}>
                <div style={{
                  fontSize: 10,
                  letterSpacing: 0.08 * 12 + 'em',
                  textTransform: 'uppercase',
                  opacity: 0.55,
                  fontWeight: 700,
                  marginBottom: 4,
                  color: t.role === 'user' ? '#8AB4F8' : '#FBBC04',
                }}>
                  {t.role === 'user' ? 'You' : 'Jarviz'}
                  <span style={{ marginLeft: 8, opacity: 0.6 }}>{fmtDate(t.ts)}</span>
                </div>
                <div style={{
                  whiteSpace: 'pre-wrap',
                  lineHeight: 1.5,
                  fontSize: 13,
                  background: t.role === 'user' ? 'rgba(66,133,244,0.08)' : 'rgba(251,188,4,0.06)',
                  borderRadius: 10,
                  padding: '10px 12px',
                  border: '1px solid rgba(255,255,255,0.06)',
                }}>
                  {t.text}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function smallBtn(bg: string): React.CSSProperties {
  return {
    border: 'none', cursor: 'pointer',
    padding: '6px 10px', borderRadius: 8,
    background: bg, color: '#fff', fontSize: 11, fontWeight: 600,
  }
}
