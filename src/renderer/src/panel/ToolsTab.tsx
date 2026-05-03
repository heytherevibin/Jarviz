import { useCallback, useEffect, useState } from 'react'

type Activity = { id: string; ts: number; type: string; label: string; detail?: string }

type Chrome = {
  hairline: string
  radiusIn: number
  textMain: string
  textSub: string
  fillGroup: string
}

export function ToolsTab({ chrome, MenuSection, buttonSecondary }: {
  chrome: Chrome
  MenuSection: (p: { title: string; children: React.ReactNode; style?: React.CSSProperties }) => React.ReactElement
  buttonSecondary: React.CSSProperties
}) {
  const [activity, setActivity] = useState<Activity[]>([])
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    setBusy(true)
    try {
      const a = await window.jarviz.agentAdmin.activityList(120)
      setActivity(a as unknown as Activity[])
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => { refresh().catch(console.error) }, [refresh])

  const openPane = useCallback(async (pane: string) => {
    try {
      await window.jarviz.system.openMacPrivacyPane(pane)
    } catch (e) {
      console.error(e)
    }
  }, [])

  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPod|iPad/i.test(navigator.platform)

  return (
    <div style={{ paddingTop: 4 }}>
      <MenuSection title="System permissions">
        <div style={{ padding: '12px 14px', fontSize: 13, lineHeight: 1.55, color: chrome.textMain, borderBottom: `1px solid ${chrome.hairline}` }}>
          Jarviz relies on <strong style={{ fontWeight: 600 }}>System Settings → Privacy &amp; Security</strong> for filesystem, automation, screen, and microphone — not in-app toggles. Grant access there for full capability.
        </div>
        {isMac && (
          <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button type="button" onClick={() => void openPane('privacy')} style={{ ...buttonSecondary, width: '100%' }}>
              Open Privacy &amp; Security…
            </button>
            <button type="button" onClick={() => void openPane('fullDisk')} style={{ ...buttonSecondary, width: '100%' }}>
              Full Disk Access…
            </button>
            <button type="button" onClick={() => void openPane('files')} style={{ ...buttonSecondary, width: '100%' }}>
              Files and Folders…
            </button>
            <button type="button" onClick={() => void openPane('accessibility')} style={{ ...buttonSecondary, width: '100%' }}>
              Accessibility…
            </button>
            <button type="button" onClick={() => void openPane('screen')} style={{ ...buttonSecondary, width: '100%' }}>
              Screen Recording…
            </button>
            <button type="button" onClick={() => void openPane('microphone')} style={{ ...buttonSecondary, width: '100%' }}>
              Microphone…
            </button>
          </div>
        )}
        {!isMac && (
          <div style={{ padding: '14px 12px', fontSize: 13, color: chrome.textSub }}>
            Privacy panes are macOS-specific. Use your OS settings to grant Jarviz access to the microphone, screen, and files.
          </div>
        )}
      </MenuSection>

      <MenuSection title="Activity log">
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 12px 0' }}>
          <button type="button" disabled={busy} onClick={() => void refresh()} style={{ ...buttonSecondary, fontSize: 11 }}>
            {busy ? '…' : 'Refresh'}
          </button>
        </div>
        <div style={{ maxHeight: 280, overflow: 'auto' }}>
          {activity.length === 0 && (
            <div style={{ padding: '14px 12px', fontSize: 13, color: chrome.textSub }}>
              No activity yet.
            </div>
          )}
          {activity.slice().reverse().map((e, i) => (
            <div key={e.id ?? i} style={{ padding: '10px 12px', borderBottom: i === activity.length - 1 ? 'none' : `1px solid ${chrome.hairline}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 650, color: chrome.textMain }}>
                  {e.type}: {e.label}
                </div>
                <div style={{ fontSize: 10, opacity: 0.5, fontFamily: '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace' }}>
                  {new Date(e.ts).toLocaleTimeString()}
                </div>
              </div>
              {e.detail && (
                <div style={{ marginTop: 6, fontSize: 11, opacity: 0.55, color: chrome.textSub, whiteSpace: 'pre-wrap' }}>
                  {e.detail}
                </div>
              )}
            </div>
          ))}
        </div>
      </MenuSection>
    </div>
  )
}
