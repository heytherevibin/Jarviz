import { useCallback, useEffect, useMemo, useState } from 'react'

type MemoryItem = {
  id: string
  kind: string
  title: string
  text: string
  tags: string[]
  projectRoot?: string
  createdAt: number
  updatedAt: number
}

export function MemoryTab({ chrome, MenuSection, buttonSecondary }: {
  chrome: { hairline: string; radiusIn: number }
  MenuSection: (p: { title: string; children: React.ReactNode; style?: React.CSSProperties }) => React.ReactElement
  buttonSecondary: React.CSSProperties
}) {
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<MemoryItem[]>([])
  const [busy, setBusy] = useState(false)

  const [draftKind, setDraftKind] = useState<'snippet' | 'project' | 'profile'>('snippet')
  const [draftTitle, setDraftTitle] = useState('')
  const [draftText, setDraftText] = useState('')
  const [draftTags, setDraftTags] = useState('')

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const res = query.trim()
        ? await window.jarviz.memory.search(query.trim(), { limit: 50 })
        : await window.jarviz.memory.list({ limit: 50 })
      setItems(res as unknown as MemoryItem[])
    } finally {
      setBusy(false)
    }
  }, [query])

  useEffect(() => { load().catch(console.error) }, [load])

  const tagList = useMemo(
    () => draftTags.split(',').map(t => t.trim()).filter(Boolean).slice(0, 12),
    [draftTags],
  )

  const save = useCallback(async () => {
    if (!draftTitle.trim() || !draftText.trim()) return
    setBusy(true)
    try {
      await window.jarviz.memory.upsert({
        kind: draftKind,
        title: draftTitle.trim(),
        text: draftText.trim(),
        tags: tagList,
      })
      setDraftTitle('')
      setDraftText('')
      setDraftTags('')
      await load()
    } finally {
      setBusy(false)
    }
  }, [draftKind, draftTitle, draftText, tagList, load])

  const del = useCallback(async (id: string) => {
    if (!confirm('Delete this memory?')) return
    setBusy(true)
    try {
      await window.jarviz.memory.delete(id)
      await load()
    } finally {
      setBusy(false)
    }
  }, [load])

  return (
    <div style={{ paddingTop: 4 }}>
      <MenuSection title="Search">
        <div style={{ padding: 12, borderBottom: `1px solid ${chrome.hairline}` }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search memory…"
            style={{
              width: '100%',
              padding: '10px 12px',
              borderRadius: chrome.radiusIn,
              border: `1px solid ${chrome.hairline}`,
              background: 'rgba(0,0,0,0.32)',
              color: 'rgba(255,255,255,0.92)',
              fontSize: 13,
              outline: 'none',
            }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" onClick={() => load()} style={{ ...buttonSecondary, flex: 1, opacity: busy ? 0.7 : 1 }}>
              {busy ? 'Loading…' : 'Refresh'}
            </button>
            <button type="button" onClick={() => { setQuery(''); void load() }} style={{ ...buttonSecondary, flex: 1 }}>
              Clear
            </button>
          </div>
        </div>
        <div style={{ maxHeight: 240, overflow: 'auto' }}>
          {items.length === 0 && (
            <div style={{ padding: '14px 12px', fontSize: 13, color: 'rgba(255,255,255,0.5)' }}>
              No memories yet.
            </div>
          )}
          {items.map((m, i) => (
            <div key={m.id} style={{ padding: '12px 12px', borderBottom: i === items.length - 1 ? 'none' : `1px solid ${chrome.hairline}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                <div style={{ fontWeight: 650, fontSize: 13, color: 'rgba(255,255,255,0.92)' }}>{m.title}</div>
                <button type="button" onClick={() => void del(m.id)} style={{ ...buttonSecondary, padding: '6px 10px', fontSize: 11 }}>
                  Delete
                </button>
              </div>
              <div style={{ marginTop: 6, fontSize: 12, lineHeight: 1.45, color: 'rgba(255,255,255,0.68)', whiteSpace: 'pre-wrap' }}>
                {m.text}
              </div>
              {!!m.tags?.length && (
                <div style={{ marginTop: 8, fontSize: 11, opacity: 0.55 }}>
                  {m.tags.map(t => `#${t}`).join('  ')}
                </div>
              )}
            </div>
          ))}
        </div>
      </MenuSection>

      <MenuSection title="Add memory">
        <div style={{ padding: 12 }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <select
              value={draftKind}
              onChange={(e) => setDraftKind(e.target.value as 'snippet' | 'project' | 'profile')}
              style={{
                flex: 1,
                padding: '10px 12px',
                borderRadius: chrome.radiusIn,
                border: `1px solid ${chrome.hairline}`,
                background: 'rgba(0,0,0,0.32)',
                color: 'rgba(255,255,255,0.92)',
                fontSize: 13,
                outline: 'none',
              }}
            >
              <option value="snippet">Snippet</option>
              <option value="project">Project</option>
              <option value="profile">Profile</option>
            </select>
          </div>
          <input
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            placeholder="Title"
            style={{
              width: '100%',
              padding: '10px 12px',
              borderRadius: chrome.radiusIn,
              border: `1px solid ${chrome.hairline}`,
              background: 'rgba(0,0,0,0.32)',
              color: 'rgba(255,255,255,0.92)',
              fontSize: 13,
              outline: 'none',
              marginBottom: 10,
            }}
          />
          <textarea
            value={draftText}
            onChange={(e) => setDraftText(e.target.value)}
            placeholder="What should Jarviz remember?"
            style={{
              width: '100%',
              minHeight: 110,
              resize: 'vertical',
              padding: '10px 12px',
              borderRadius: chrome.radiusIn,
              border: `1px solid ${chrome.hairline}`,
              background: 'rgba(0,0,0,0.32)',
              color: 'rgba(255,255,255,0.92)',
              fontSize: 13,
              outline: 'none',
              marginBottom: 10,
            }}
          />
          <input
            value={draftTags}
            onChange={(e) => setDraftTags(e.target.value)}
            placeholder="Tags (comma separated)"
            style={{
              width: '100%',
              padding: '10px 12px',
              borderRadius: chrome.radiusIn,
              border: `1px solid ${chrome.hairline}`,
              background: 'rgba(0,0,0,0.32)',
              color: 'rgba(255,255,255,0.92)',
              fontSize: 13,
              outline: 'none',
              marginBottom: 10,
            }}
          />
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || !draftTitle.trim() || !draftText.trim()}
            style={{ ...buttonSecondary, width: '100%', opacity: busy ? 0.7 : 1 }}
          >
            Save memory
          </button>
        </div>
      </MenuSection>
    </div>
  )
}

