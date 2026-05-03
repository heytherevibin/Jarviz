import { useCallback, useEffect, useState } from 'react'

declare global {
  interface Window {
    jarviz: {
      trayMenu: {
        getEnabled: () => Promise<boolean>
        setEnabled: (on: boolean) => Promise<boolean>
        onEnabledFromMain: (cb: (enabled: boolean) => void) => () => void
        openSettings: () => void
        quit: () => void
        close: () => void
      }
    }
  }
}

/** macOS tray popover — Klack-style row + switch (Electron menus cannot render NSSwitch). */
export function TrayPopoverView(): JSX.Element {
  const [on, setOn] = useState(true)

  useEffect(() => {
    void window.jarviz.trayMenu.getEnabled().then(setOn).catch(() => {})
    return window.jarviz.trayMenu.onEnabledFromMain(setOn)
  }, [])

  const toggle = useCallback((): void => {
    const next = !on
    setOn(next)
    void window.jarviz.trayMenu.setEnabled(next).then(setOn).catch(() => {})
  }, [on])

  const row: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
    padding: '4px 2px 10px',
    userSelect: 'none',
  }
  const brand: React.CSSProperties = {
    fontSize: 14,
    fontWeight: 600,
    letterSpacing: '-0.02em',
    color: 'rgba(255,255,255,0.95)',
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif',
  }
  const sep: React.CSSProperties = {
    height: 1,
    margin: '2px 0 8px',
    background: 'rgba(255,255,255,0.12)',
    border: 'none',
  }
  const menuBtn: React.CSSProperties = {
    display: 'block',
    width: '100%',
    textAlign: 'left' as const,
    padding: '8px 10px',
    marginBottom: 2,
    border: 'none',
    borderRadius: 6,
    background: 'transparent',
    color: 'rgba(255,255,255,0.92)',
    fontSize: 13,
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif',
    cursor: 'pointer',
  }

  return (
    <div
      style={{
        padding: '10px 12px 10px',
        boxSizing: 'border-box',
        minHeight: '100vh',
        WebkitFontSmoothing: 'antialiased',
      }}
    >
      <div style={row}>
        <span style={brand}>Jarviz</span>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          onClick={toggle}
          style={{
            width: 51,
            height: 31,
            padding: 0,
            border: 'none',
            borderRadius: 16,
            cursor: 'pointer',
            flexShrink: 0,
            background: 'rgba(120, 120, 128, 0.52)',
            boxShadow: 'inset 0 1px 1px rgba(0,0,0,0.22), inset 0 -1px 0 rgba(255,255,255,0.06)',
            position: 'relative',
            transition: 'background 0.18s ease',
          }}
        >
          <span
            aria-hidden
            style={{
              position: 'absolute',
              top: 2,
              left: on ? 22 : 2,
              width: 27,
              height: 27,
              borderRadius: '50%',
              background: '#fff',
              boxShadow: '0 2px 6px rgba(0,0,0,0.28), 0 0 0 0.5px rgba(0,0,0,0.04)',
              transition: 'left 0.2s cubic-bezier(0.25, 0.1, 0.25, 1)',
            }}
          />
        </button>
      </div>
      <hr style={sep} />
      <button
        type="button"
        style={menuBtn}
        onClick={() => {
          window.jarviz.trayMenu.openSettings()
          window.jarviz.trayMenu.close()
        }}
      >
        Settings…
      </button>
      <button
        type="button"
        style={{ ...menuBtn, color: 'rgba(255,154,154,0.95)' }}
        onClick={() => {
          window.jarviz.trayMenu.quit()
        }}
      >
        Quit Jarviz
      </button>
    </div>
  )
}
