# Jarviz — Autonomous Desktop AI Agent

A floating, always-on-top "Iron Man JARVIS" orb for macOS, Windows, and Linux. Talks back, listens to wake words, sees your screen, opens apps, runs commands, and chains tools — all driven by your choice of Claude Sonnet 4.5, GPT-5.2, or Gemini 3 Pro.

![orb](resources/tray.png)

## Quick start

```bash
yarn install
yarn dev          # runs Electron + Vite hot-reload
```

The orb appears in the bottom-center of your primary display. The app is **fully functional out of the box** — it ships with the Emergent Universal LLM Key pre-configured, so Claude / GPT / Gemini all work immediately.

### Triggering Jarviz

| Action                                    | Method                                          |
| ----------------------------------------- | ----------------------------------------------- |
| Activate by voice                         | Say "Hey Jarviz" / "Jarvis"                     |
| Activate by click                         | Click the orb                                   |
| Activate by hotkey                        | `Cmd/Ctrl + Shift + J`                          |
| Open settings                             | `Cmd/Ctrl + ,` or right-click tray icon         |
| Cancel current request                    | `Esc`                                           |
| Resize orb                                | scroll wheel · `+` / `-` · `0` to reset         |
| Drag orb                                  | click and drag (snaps to screen edges)          |

## Settings & keys

Open Settings (`Cmd/Ctrl + ,`). You can:

1. **Use the Emergent Universal Key** (default — proxies Claude / GPT / Gemini through one key).
2. **Bring your own** Anthropic / OpenAI / Google / Groq / xAI keys instead.
3. Pick the model — Claude Sonnet 4.5 (default), GPT-5.2, Gemini 3 Pro, etc.
4. Choose Whisper STT model size (tiny → large-v3).

All keys are stored locally in `electron-store` (encrypted on macOS keychain). No keys ever leave your machine except to the chosen provider.

## What it can do (autonomous tools)

| Category    | Tools                                                                                |
| ----------- | ------------------------------------------------------------------------------------ |
| Information | `web_search`, `wikipedia`, `get_news`, `get_weather`, `get_time`, `define_word`, `calculate`, `crypto_price`, `stock_price`, `currency_convert`, `get_location` |
| Filesystem  | `read_file`, `list_directory`, `search_files`                                        |
| **Actions** | `open_url`, `open_app`, `open_path`, `run_command`, `screenshot`, `notify`           |
| System      | `read_clipboard`, `write_clipboard`, `system_info`                                   |

The agent chains tools automatically. Examples:
- *"Take a screenshot and tell me what's on my screen"* → `screenshot` → reasoning
- *"Open Spotify and play lo-fi"* → `open_app("Spotify")` → `open_url("https://open.spotify.com/...")`
- *"What's my CPU usage?"* → `run_command("top -l 1 -n 0 | head -10")`
- *"Search GitHub for X and open the top result"* → `web_search` → `open_url`

## Architecture

```
┌─────────── Electron Main ───────────┐    ┌────── Renderer (React + Three.js) ──────┐
│ ipcMain                             │    │ Orb (custom GLSL shader, 256×256 sphere) │
│ ├─ agent:query  → runAgent()        │ ↔  │ ParticleField (480 audio-reactive pts)   │
│ │   ├─ Emergent (OpenAI SDK)        │    │ JarvizFSM (idle→listen→think→speak)      │
│ │   ├─ Anthropic / OpenAI / Gemini  │    │ LocalSTT (Whisper via @xenova)           │
│ │   ├─ Groq / xAI                   │    │ LocalWakeWord (Silero VAD)               │
│ │   └─ runs tools (15+ functions)   │    │ LocalTTS (Web Speech) + ElevenLabs       │
│ ├─ Tray + global shortcuts          │    │ SoundEngine (WebAudio chimes/drone)      │
│ └─ store-env + electron-store       │    └──────────────────────────────────────────┘
└─────────────────────────────────────┘
```

## Build for distribution

```bash
yarn build        # compile only
yarn package      # → DMG (macOS) / NSIS (Windows) / AppImage (Linux)
```

## Dev tips

- `dev:stop` kills any orphaned electron-vite dev processes.
- The Whisper model downloads on first use (~145 MB for `base`); subsequent loads are instant from cache.
- All voice processing runs **locally** in the browser; only the chat + tool results travel to your chosen LLM.
