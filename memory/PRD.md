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
