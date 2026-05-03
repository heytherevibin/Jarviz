import { useCallback, useEffect, useState, type CSSProperties } from 'react'

const mono: CSSProperties = {
  fontFamily: '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace',
  fontSize: 11,
}

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
  const [allowDestructiveShell, setAllowDestructiveShell] = useState(false)
  const [anthropicThinking, setAnthropicThinking] = useState(true)
  const [mcpJson, setMcpJson] = useState('[]')
  const [mcpMsg, setMcpMsg] = useState<string | null>(null)

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

  useEffect(() => {
    window.jarviz.settings.get().then((s) => {
      setAllowDestructiveShell(!!s.allowDestructiveShell)
      setAnthropicThinking(s.anthropicThinking !== false)
      setMcpJson(JSON.stringify(s.mcpServers ?? [], null, 2))
    }).catch(console.error)
  }, [])

  const patchAgentShell = useCallback(async (on: boolean) => {
    setAllowDestructiveShell(on)
    try {
      await window.jarviz.settings.set({ allowDestructiveShell: on })
    } catch (e) {
      console.error(e)
      setAllowDestructiveShell(!on)
    }
  }, [])

  const patchAnthropicThinking = useCallback(async (on: boolean) => {
    setAnthropicThinking(on)
    try {
      await window.jarviz.settings.set({ anthropicThinking: on })
    } catch (e) {
      console.error(e)
      setAnthropicThinking(!on)
    }
  }, [])

  const applyMcp = useCallback(async () => {
    setMcpMsg(null)
    try {
      const parsed: unknown = JSON.parse(mcpJson)
      const ok = await window.jarviz.settings.set({ mcpServers: parsed })
      setMcpMsg(ok ? 'MCP configuration saved. Tools reload on save.' : 'Invalid list: each server needs a unique id and a command string.')
    } catch {
      setMcpMsg('Could not parse JSON.')
    }
  }, [mcpJson])

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

      <MenuSection title="Agent guardrails">
        <label
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
            padding: '12px 14px',
            borderBottom: `1px solid ${chrome.hairline}`,
            cursor: 'pointer',
            fontSize: 13,
            color: chrome.textMain,
          }}
        >
          <input
            type="checkbox"
            checked={allowDestructiveShell}
            onChange={(e) => void patchAgentShell(e.target.checked)}
            style={{ marginTop: 3 }}
          />
          <span>
            <span style={{ fontWeight: 600 }}>Allow destructive shell</span>
            <span style={{ display: 'block', marginTop: 4, fontSize: 11, color: chrome.textSub, lineHeight: 1.45 }}>
              When off, commands matching high-risk patterns (sudo, rm -rf, curl|sh, …) are refused. Turn on only if you trust the model and your keys.
            </span>
          </span>
        </label>
        <label
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
            padding: '12px 14px',
            cursor: 'pointer',
            fontSize: 13,
            color: chrome.textMain,
          }}
        >
          <input
            type="checkbox"
            checked={anthropicThinking}
            onChange={(e) => void patchAnthropicThinking(e.target.checked)}
            style={{ marginTop: 3 }}
          />
          <span>
            <span style={{ fontWeight: 600 }}>Anthropic extended thinking</span>
            <span style={{ display: 'block', marginTop: 4, fontSize: 11, color: chrome.textSub, lineHeight: 1.45 }}>
              Uses extra reasoning tokens on the direct Anthropic backend (prompt cache + thinking). Disable if you hit API errors on older models.
            </span>
          </span>
        </label>
      </MenuSection>

      <MenuSection title="MCP servers (stdio)">
        <div style={{ padding: '10px 12px 0', fontSize: 12, color: chrome.textSub, lineHeight: 1.5 }}>
          Power-user integration: each entry spawns a stdio MCP server and exposes its tools as <code style={mono}>jmcp_*</code> in the agent. Example: filesystem server with{' '}
          <code style={mono}>npx -y @modelcontextprotocol/server-filesystem</code> plus allowed paths as args.
        </div>
        <div style={{ padding: '10px 12px' }}>
          <textarea
            value={mcpJson}
            onChange={(e) => setMcpJson(e.target.value)}
            spellCheck={false}
            style={{
              width: '100%',
              minHeight: 140,
              boxSizing: 'border-box',
              resize: 'vertical',
              ...mono,
              padding: 10,
              borderRadius: chrome.radiusIn,
              border: `1px solid ${chrome.hairline}`,
              background: chrome.fillGroup,
              color: chrome.textMain,
            }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, gap: 10 }}>
            <button type="button" onClick={() => void applyMcp()} style={{ ...buttonSecondary, fontSize: 12 }}>
              Save MCP config
            </button>
            {mcpMsg && <span style={{ fontSize: 11, color: mcpMsg.includes('Invalid') || mcpMsg.includes('parse') ? '#f1918c' : chrome.textSub }}>{mcpMsg}</span>}
          </div>
        </div>
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
