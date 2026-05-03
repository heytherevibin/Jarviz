# Jarviz — Product Requirements Document

## Original Problem Statement
> Analyse the GitHub repo (heytherevibin/Jarviz) and help me fix any issues and completely make it functional and redesign the orb to a fully functional and robust agent. Voice + system tray agent like JARVIS from Iron Man, fully fledged autonomous agent. Capabilities: voice + text chat, screen/context awareness, system actions, tool/function calling. LLM: Claude Sonnet 4.5, GPT-5.2, Gemini 3 Pro. Use Emergent Universal Key by default with option to provide own key. Then: add multimodal vision, persistent memory + transcript viewer, OS-level keyboard/mouse automation, auto-update + Picovoice + mac menu-bar mini-mode.

## Architecture
- **Electron 35** desktop app (macOS / Windows / Linux), TypeScript 5.5, Vite 5.4, React 18, Three.js 0.176
- **Main process** (`src/main/index.ts`): always-on-top transparent BrowserWindow, system tray, IPC, agent runner, electron-store, transcript store, electron-updater
- **Renderer** (`src/renderer/src/`): Three.js orb (custom GLSL), JarvizFSM (idle→listen→think→speak→follow-up), Whisper STT (in-browser), Silero VAD wake-word + optional Picovoice Porcupine, Web Speech / ElevenLabs TTS, SettingsOverlay + TranscriptOverlay
- **Agent** (`src/main/agent/claude.ts`): 6 backends — `emergent` (default), `anthropic`, `openai`, `gemini`, `groq`, `xai`. All support vision (except Groq Llama text-only). Auto-falls-back if primary fails.
- **Tools** (`src/main/agent/tools.ts`): **28 tools** — info, filesystem, system actions (open_url/app/path, run_command, notify), clipboard, system_info, **vision (see_screen)**, **input automation (type_text, key_combo, mouse_click/move/scroll)**.

## What's Been Implemented (2026-01-21)

### Iteration 5 — Menubar architecture, voice diagnostics, stability
- **Two-window architecture**: orb window is now **truly pristine** (just orb + halo + reticle pips + scan beam). All UI / config / status moved into a separate **menubar panel window** that pops out from the tray icon.
- **PanelView** (`src/renderer/src/PanelView.tsx`) — 360×560 popover with 4 tabs:
  - **Status**: platform, uptime, memory, LLM backend, key/voice diagnostics with red/green markers, mini-mode toggle.
  - **Voice**: Gemini voice picker, ▷ Preview voice button (synthesises "Good evening — Jarviz online and ready" with the selected voice), prominent warning when `GEMINI_API_KEY` is missing (the cause of "voice never changed").
  - **Keys**: LLM backend + provider/model selector, Whisper model, all 9 API keys with hints.
  - **Transcripts**: list/select/view/delete saved sessions, clear all.
- **Voice fix** — exposed in 3 ways:
  1. Status tab shows "Gemini key: ✗ missing — voice will use browser fallback" in red the moment the user opens the panel.
  2. Voice tab shows an inline `⚠ Gemini voice "X" requires GEMINI_API_KEY — set it in the Keys tab` callout when the key is missing but a voice is selected.
  3. ▷ Preview voice button calls `panel:previewVoice` IPC which actually attempts synthesis and surfaces the real error message ("No GEMINI_API_KEY set" / "Synthesis returned no audio") instead of failing silently.
- **Tray icon click** now toggles the panel (instead of focusing orb). On macOS it positions just below the menu-bar icon (popover-style); on Windows/Linux it docks near the system tray.
- **Panel auto-hides on blur** — true menubar dropdown behaviour.
- **`Cmd/Ctrl+,`** opens the panel at the Keys tab. `Cmd/Ctrl+Shift+P` toggles the panel. `Cmd/Ctrl+Shift+T` jumps to Transcripts. `Cmd/Ctrl+Shift+M` toggles mini orb. macOS app menu (`Jarviz → …`) and tray context menu both expose all of the above.
- **Voice preview audio playback** — main process synthesises, sends bytes via `panel:previewAudio` IPC, panel renderer plays via Audio element with proper Blob/URL cleanup.
- **Live state mirroring** — orb's FSM relays state + caption to the panel via throttled IPC (`relayState` 80ms, `relayCaption` 100ms), so the panel header always shows the current J-CORE / state / last user-question / last reply without any extra work in the orb window.
- **Stability improvements**:
  - Whisper model load **deferred to `requestIdleCallback`** (1.5s setTimeout fallback) — the orb appears instantly instead of blocking on a 145 MB ONNX download on first run.
  - IPC relays throttled to ≤10 Hz to prevent panel re-render spam during rapid FSM transitions.
  - `setApplicationMenu` macOS template extended with explicit "Open Panel" / "Settings…" / "Transcripts…" entries so users can find them through the standard macOS menu bar.
  - `store-env.ts` upgraded with managed-key list so unsetting a value (e.g. selecting "Off" voice) actively `delete`s `process.env[key]` — previously stale values lingered.
  - Crash recovery: `unhandledRejection` + `uncaughtException` listeners installed; panel/orb windows guard against destroyed-window writes.
- Settings/Transcripts overlays no longer rendered inside the orb window — orb is unobstructed.

### Iteration 4 — Instant speech + Futuristic HUD redesign + Settings discoverability
- **Streaming sentence-pipelined TTS** (`src/main/agent/streaming.ts`) — splits replies into sentence-shaped chunks (with abbreviation guards + soft 220-char cap), synthesises all chunks **in parallel**, emits in order over new `agent:speakChunk` IPC. Renderer's new `StreamingPlayer` queues chunks and plays them sequentially with smooth amplitude-driven orb modulation. First sentence is heard within ~0.5–1s instead of waiting 3–6s for full reply.
- **Default voice changed to Aoede** — soft female, breezy. Voice picker reordered with all soft-female voices grouped at the top (Aoede / Vindemiatrix / Despina / Sulafat / Achernar) and Charon/Iapetus marked male for clarity.
- **Removed orbital ring layer entirely** (3D TorusGeometry rings deleted) and stripped concentric outer/inner rings + 4 corner brackets from the SVG HUD per user direction. Orb now sits in clean negative space.
- **New futuristic HUD elements**:
  - Audio-reactive vertical scan beam that sweeps across the orb during listen/think/speak states.
  - 4 quadrant reticle pips that orbit at variable speeds per FSM state (idle 0.10°/frame → thinking 0.55°/frame).
  - Sparse 36-position tick marks (only majors + half-majors drawn).
  - Soft state-colored radial halo + ephemeral audio-reactive scan ring.
- **OrbHUDWidgets** component — 4 floating sci-fi data widgets at screen corners (no rings around the orb):
  - Top-left: J-CORE 7.3 identity strip with running uptime + state badge ("STANDBY" / "LIVE-IN" / "COMPUTE" / "OUTBOUND").
  - Top-right: live mock telemetry (CPU / MEM / NET %) with smooth random-walk animation.
  - Bottom-left: NODE id + 4-bar signal indicator.
  - Bottom-right: live audio level meter (12-bar) + status code.
- **Always-visible Settings gear button** at top-right of orb window (28px circular, glassmorphic, hover-glow). Solves "where do I find Settings?" — always discoverable. Existing Cmd+, hotkey, tray menu, and macOS application menu (Jarviz → Settings) all preserved.

### Iteration 3 — Gemini voices + Premium orb HUD
- **Gemini TTS** integration. New `synthesize()` returns `{buffer, mime}` and supports 3-tier preference: Gemini (when `GEMINI_API_KEY` + `GEMINI_TTS_VOICE` set) → ElevenLabs → browser. Calls `gemini-2.5-flash-preview-tts` directly (proxy doesn't support TTS yet); wraps PCM L16 24kHz output in a manual RIFF/WAVE header so the renderer Audio element plays it natively. Renderer now picks `audio/wav` vs `audio/mpeg` via the `audioMime` field threaded through IPC + FSM.
- **Voice picker UI** in Settings — 12 curated Gemini voices with trait descriptions; "Off" option skips Gemini. `store-env.ts` upgraded with managed-key list so unsetting a voice clears `process.env`.
- **OrbitalRings** module — three TorusGeometry rings (radii 1.35/1.55/1.75 at orthogonal Euler orientations) with a custom dashed-segment shader (per-ring dash frequency, gap, time, pulse uniforms). Color-locked to orb's rim color, additive blending, audio-reactive intensity, per-state opacity multiplier. Wired into OrbScene tick + dispose lifecycle.
- **HUDLayer** SVG overlay — outer segmented rotating arc (gradient stroke), inner counter-rotating dashed ring, 60 tick marks (12 majors), 4 quadrant reticle pips that spin slowly, audio-reactive scan ring, four corner brackets, soft state-colored radial halo. Rotation speed varies per FSM state (idle 0.06°/frame → thinking 0.40°/frame). Color accent maps to JarvizState.
- **Refreshed HUD card** — glassmorphism (18px backdrop blur + 140% saturation), gradient bg, state-color bloom dot, JARVIZ monogram, semantic colored "You"/"Jarviz" labels.

### Iteration 1 — Foundation
- Yarn install + electron-vite build clean; main-process TypeScript typechecks pass.
- New **Emergent Universal LLM Key** backend using OpenAI SDK against `https://integrations.emergentagent.com/llm`. Verified live with Claude Sonnet 4.5, GPT-5.2 and Gemini 3 Pro Preview, including tool calling.
- Pre-baked `EMERGENT_LLM_KEY` into `.env`. User can override or add Anthropic / OpenAI / Gemini / Groq / xAI keys via Settings.
- 9 system action tools added: `open_url`, `open_app` (cross-platform), `open_path`, `run_command` (with destructive-pattern guard, 15s timeout), `screenshot`, `notify`, `read_clipboard`, `write_clipboard`, `system_info`.
- Settings UI: Emergent provider+model picker, Whisper model selector, 8 keys with hints.

### Iteration 2 — Vision + Memory + Automation + Update
- **Multimodal vision** via new `see_screen` tool. `executeTool` now returns `{text, images?}`; tool results carrying images are converted into a follow-up user message in the OpenAI/Anthropic/Gemini chat shapes. Verified end-to-end via curl: Claude Sonnet 4.5, GPT-5.2, and Gemini 3 Pro Preview all correctly identify image colors when sent base64-encoded PNGs through the proxy.
- **Persistent transcripts** via `TranscriptStore` (electron-store). Every successful agent turn appended to the active session; auto-resume previous session if user re-opens within 5 min. Up to 100 sessions × 200 turns retained.
- **TranscriptOverlay** React component (Cmd/Ctrl+Shift+T): list/select/view/delete sessions, "+ New" to start fresh, "Clear all" with confirmation.
- **OS keyboard/mouse automation**: 5 new tools (`type_text`, `key_combo`, `mouse_click`, `mouse_move`, `mouse_scroll`). Cross-platform shell-based (macOS osascript, Windows PowerShell SendKeys, Linux xdotool). No native bindings; graceful "install xdotool / grant Accessibility" error messages.
- **Auto-update** via `electron-updater` (GitHub releases publish target wired in package.json). Update banner UI + "Restart to install" button. No-op in dev / unpackaged runs.
- **Picovoice Porcupine** wake word as opt-in. When `PICOVOICE_ACCESS_KEY` is in Settings, `PicovoiceWakeWord` swaps in (sub-1% CPU, hardware-grade) and the heavier VAD+Whisper path pauses. Default falls back to existing wake-word if key absent or init fails.
- **Mini-mode**: `Cmd/Ctrl+Shift+M` toggle (also in Settings + tray menu). Shrinks BrowserWindow to 64px and back. Persisted across launches.
- README rewritten with v0.2 feature list, hotkeys table, tools table, platform helper requirements, architecture diagram.

## Tech Stack
- electron 35, electron-vite 2.3, vite 5.4, React 18, three 0.176, TypeScript 5.5, electron-updater 6.8
- @xenova/transformers (Whisper STT), @ricky0123/vad-web (Silero VAD), @picovoice/porcupine-web 4.0 (opt-in)
- @anthropic-ai/sdk, openai, groq-sdk, dotenv, electron-store

## P0 — Done
- [x] App builds clean, types pass, electron boots
- [x] Emergent Universal Key + Claude Sonnet 4.5 / GPT-5.2 / Gemini 3 Pro
- [x] BYOK support (Anthropic, OpenAI, Gemini, Groq, xAI) via Settings
- [x] 28 agent tools across info / filesystem / system actions / vision / input automation / clipboard / system_info
- [x] Multimodal vision (verified live with all 3 providers via the Emergent proxy)
- [x] Persistent conversation memory + transcript viewer UI
- [x] Cross-platform input automation (no native deps)
- [x] Auto-update via electron-updater (GitHub releases wired)
- [x] Picovoice Porcupine wake word (opt-in)
- [x] Mini-mode collapse + tray menu integration

## Backlog (P1 / P2)
- [ ] Streaming responses (token-by-token TTS instead of wait-for-full-reply)
- [ ] Multi-screen support (currently primary display only for see_screen)
- [ ] Region selection for see_screen (`{x,y,w,h}` parameter for cropping)
- [ ] Action audit log overlay — see what tools the agent called and their results
- [ ] iOS / Android companion via remote agent
- [ ] Vector search over saved transcripts ("did I ask Jarviz about this last week?")
- [ ] Custom tool plugin system (drop-in JS files in a `tools/` directory)

## How to run locally
```bash
yarn install
yarn dev              # hot-reload dev
yarn build && yarn package    # ship DMG/NSIS/AppImage
```

## Notes
- Cannot fully exercise voice flow in headless Linux container (no audio device, no DBus). All non-IO logic verified: build, types, IPC, agent loop, tool calls, multimodal vision via curl, electron boot in xvfb.
- Vision verified live across Claude Sonnet 4.5, GPT-5.2, and Gemini 3 Pro Preview using the same OpenAI-compatible call path the agent uses.
