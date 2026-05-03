# Jarviz — Autonomous Desktop AI Agent

A floating, always-on-top "Iron Man JARVIS" orb for macOS, Windows, and Linux. Talks back, listens to wake words, **sees your screen**, opens apps, runs commands, types/clicks for you, and chains tools — driven by Claude Sonnet 4.5, GPT-5.2, or Gemini 3 Pro.

![orb](resources/tray.png)

## Quick start

```bash
yarn install
yarn dev          # runs Electron + Vite hot-reload
```

The orb appears in the bottom-center of your primary display. **Fully functional out of the box** — ships with the Emergent Universal LLM Key pre-configured, so Claude / GPT / Gemini all work immediately.

## Triggers

| Action                | Hotkey / gesture                          |
| --------------------- | ----------------------------------------- |
| Voice                 | "Hey Jarviz" / "Jarvis"                   |
| Click                 | Click the orb                             |
| Hotkey                | `Cmd/Ctrl + Shift + J`                    |
| Settings              | `Cmd/Ctrl + ,`                            |
| Transcripts           | `Cmd/Ctrl + Shift + T`                    |
| Mini mode (compact)   | `Cmd/Ctrl + Shift + M`                    |
| Cancel current request| `Esc`                                     |
| Resize                | scroll wheel · `+` / `-` / `0`            |
| Move                  | drag (snaps to screen edges)              |

## Where to find Settings (v0.5)

The orb is **truly pristine** now — nothing on it but the orb itself. **Everything else lives in the menubar panel**.

**Open the panel any of these ways**:
1. **Click the tray icon** in the macOS top menu bar / Windows system tray — the panel pops out next to it.
2. **Hotkey** `Cmd+,` (macOS) / `Ctrl+,` (Win/Linux) — opens panel at Keys tab.
3. **Hotkey** `Cmd+Shift+P` / `Ctrl+Shift+P` — toggles panel.
4. **macOS menu bar** at top of screen → `Jarviz` menu → `Open Panel` / `Settings…` / `Transcripts…`.
5. **Right-click the tray icon** → context menu with all entries.

The panel has 4 tabs: **Status** (live diagnostics) · **Voice** (Gemini picker + ▷ Preview) · **Keys** (all API keys) · **Transcripts**.

## "Why hasn't the voice changed?"

Gemini voices need a free `GEMINI_API_KEY` from `aistudio.google.com/apikey`. **The Universal Key alone is NOT enough for TTS** (the Emergent proxy doesn't currently support TTS endpoints). Without a Gemini key, Jarviz transparently falls back to your OS browser TTS voice — which is why selecting "Aoede" or any other Gemini voice has no audible effect.

**Fix**:
1. Open the panel (tray icon)
2. Go to **Keys** tab → paste your free `GEMINI_API_KEY` → Save
3. Go to **Voice** tab → pick `Aoede` → click **▷ Preview voice**
4. You should hear *"Good evening — Jarviz online and ready"* in the selected voice. If not, the Preview button surfaces the exact error.

## What's new (v0.5 — Menubar architecture)

## What's new (v0.4 — Instant speech & Futuristic HUD)

- **🗣️ Instant streaming speech** — Jarviz starts speaking the first sentence within ~0.5–1s of finishing the reply, not after the full TTS render. Sentence-pipelined: each sentence is synthesised in parallel and queued for ordered playback.
- **🎨 Futuristic redesign** — all the rings circling the orb are gone. New HUD: audio-reactive vertical scan beam, quadrant reticle pips that orbit, sparse perimeter tick marks, soft halo. Plus four floating sci-fi corner widgets (J-CORE identity / live telemetry / signal bars / audio meter) — JARVIS cockpit feel.
- **🎙️ Default voice = Aoede** (soft female, breezy). Voice picker reorganized with female voices first.
- **⚙ Always-visible Settings button** at top-right — no more hunting.

## What's new (v0.3 — Voice & Visual)

- **🎙️ Gemini voices** — premium prebuilt voices via Google AI Studio: Charon (calm), Kore (firm), Puck (upbeat), Algieba, Aoede, Enceladus, Orus, Despina, Iapetus, Achernar, Sulafat, Vindemiatrix. Set `GEMINI_API_KEY` (free) and pick a voice in Settings. Falls back to ElevenLabs → browser if not configured.
- **✨ Premium HUD orb** — three holographic 3D orbital rings (TorusGeometry + custom dashed shader) at orthogonal orientations slowly counter-rotating, plus a full SVG HUD layer with: outer rotating segmented arc, inner counter-rotating arc, 60-tick rim ring with 12 majors, 4 quadrant reticle pips that spin with state, audio-reactive scan ring, corner brackets — all color-locked to the state palette.
- **🪟 Glass HUD card** — refreshed with gradient glassmorphism, state-color status dot with bloom, "JARVIZ" tabular monogram, semantic colored labels for "You" / "Jarviz".

## What's new (v0.2)

- **👁️ Multimodal vision** — `see_screen` tool now sends actual screen pixels to the LLM. Ask "what's on my screen?" and Claude/GPT/Gemini can read it.
- **📜 Persistent transcripts** — every conversation is saved locally; browse, view, delete from the Transcripts panel (`Cmd/Ctrl+Shift+T`). Sessions auto-resume within 5 min.
- **⌨️ OS automation** — `type_text`, `key_combo`, `mouse_click`, `mouse_move`, `mouse_scroll`. Cross-platform (macOS via AppleScript, Windows via PowerShell SendKeys, Linux via xdotool).
- **🔄 Auto-update** — `electron-updater` wired with GitHub releases. Update banner appears when a new version is available; click "Restart to install".
- **⚡ Picovoice Porcupine** — paste a key in Settings to enable hardware-grade "Jarvis" wake-word at sub-1% CPU (replaces the heavier VAD+Whisper path).
- **🔻 Mini mode** — collapse the orb to a 64px compact dot for unobtrusive operation.

## Settings & keys

Open Settings (`Cmd/Ctrl + ,`):

1. **Emergent Universal Key** (default) — proxies Claude / GPT / Gemini through one key.
2. **Bring your own** Anthropic / OpenAI / Google / Groq / xAI keys.
3. Pick the model — Claude Sonnet 4.5 (default), GPT-5.2, Gemini 3 Pro Preview, etc.
4. Whisper STT model size (tiny → large-v3).
5. **Picovoice access key** (optional) — upgrades wake word to Porcupine.
6. **Mini mode toggle**.

All keys stored locally in `electron-store` (encrypted via OS keychain on macOS). Keys never leave your machine except to the chosen provider.

## Tools (28 total)

| Category    | Tools                                                                                |
| ----------- | ------------------------------------------------------------------------------------ |
| Information | `web_search`, `wikipedia`, `get_news`, `get_weather`, `get_time`, `define_word`, `calculate`, `crypto_price`, `stock_price`, `currency_convert`, `get_location` |
| Filesystem  | `read_file`, `list_directory`, `search_files`                                        |
| **Vision**  | `see_screen` — captures + attaches the screen image so the LLM can analyze it        |
| **Actions** | `open_url`, `open_app`, `open_path`, `run_command`, `notify`                         |
| **Input**   | `type_text`, `key_combo`, `mouse_click`, `mouse_move`, `mouse_scroll`                |
| System      | `read_clipboard`, `write_clipboard`, `system_info`                                   |

The agent chains tools automatically. Examples:
- *"What's on my screen?"* → `see_screen` → vision-LLM analyses the image → reply
- *"Click the green button at 850, 420"* → `mouse_click(850, 420)`
- *"Open Spotify, then type 'lo-fi beats' into the search"* → `open_app("Spotify")` → `key_combo("cmd+l")` → `type_text("lo-fi beats")`
- *"What's my CPU usage?"* → `run_command("top -l 1 -n 0 | head -10")`

## Platform helpers (for input automation)

| OS      | Built-in / install                                                              |
| ------- | ------------------------------------------------------------------------------- |
| macOS   | AppleScript (built in); for `mouse_move` install `cliclick` (`brew install cliclick`). Grant **Accessibility** permission to Jarviz in System Settings → Privacy & Security. |
| Windows | PowerShell SendKeys (built in)                                                  |
| Linux   | `xdotool` (`apt install xdotool` / `dnf install xdotool`)                       |

## Architecture

```
┌─────────── Electron Main ──────────────┐    ┌────── Renderer (React + Three.js) ──────┐
│ ipcMain                                │    │ Orb (custom GLSL shader, 256×256 sphere) │
│ ├─ agent:query  → runAgent()           │ ↔  │ ParticleField (480 audio-reactive pts)   │
│ │   ├─ Emergent (OpenAI SDK)           │    │ JarvizFSM (idle→listen→think→speak)      │
│ │   ├─ Anthropic / OpenAI / Gemini     │    │ LocalSTT (Whisper via @xenova)           │
│ │   ├─ Groq / xAI                      │    │ LocalWakeWord (Silero VAD + Whisper)     │
│ │   └─ runs tools (28 functions, vision)│   │ PicovoiceWakeWord (Porcupine, opt-in)    │
│ ├─ TranscriptStore (electron-store)     │   │ LocalTTS (Web Speech) + ElevenLabs       │
│ ├─ Auto-updater (GitHub releases)       │   │ SoundEngine (WebAudio chimes/drone)      │
│ ├─ Tray + global shortcuts              │   │ SettingsOverlay + TranscriptOverlay      │
│ └─ store-env + electron-store           │   └──────────────────────────────────────────┘
└────────────────────────────────────────┘
```

## Build & ship

```bash
yarn build        # compile only
yarn package      # → DMG (macOS) / NSIS (Windows) / AppImage (Linux)
```

To enable auto-update for your fork, set `GH_TOKEN` and run `yarn package` to publish a GitHub release. The default `publish` block points at `heytherevibin/Jarviz` — change it in `package.json` to your repo.

## Dev tips

- All voice processing runs **locally** in the browser; only the chat + tool results travel to your chosen LLM (or your own keys).
- Whisper downloads on first use (~145 MB for `base`); subsequent loads are instant from cache.
- `dev:stop` kills any orphaned electron-vite dev processes.
