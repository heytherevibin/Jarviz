# Jarviz — Product Requirements Document

## Original Problem Statement
> Analyse the GitHub repo (heytherevibin/Jarviz) and help me fix any issues and completely make it functional and redesign the orb to a fully functional and robust agent — this app is currently based on electron for desktop. Ensure nothing is breaking. Voice + system tray agent like JARVIS from Iron Man, fully fledged autonomous agent. Capabilities: voice + text chat, screen/context awareness, system actions, tool/function calling. LLM: Claude Sonnet 4.5, GPT-5.2, Gemini 3 Pro. Use Emergent Universal Key by default with option to provide own key.

## Architecture
- **Electron desktop app** (macOS / Windows / Linux), TypeScript, Vite, React, Three.js
- **Main process** (`src/main/index.ts`): always-on-top transparent BrowserWindow that hosts the orb, system tray, IPC handlers, agent runner, electron-store for settings.
- **Renderer** (`src/renderer/src/`): Three.js orb (custom GLSL shader, 256×256 sphere + 480 audio-reactive particles), JarvizFSM (idle→listen→think→speak→follow-up), Whisper STT (in-browser), Silero VAD wake-word, Web Speech / ElevenLabs TTS.
- **Agent** (`src/main/agent/claude.ts`): 6 backends — `emergent` (default, OpenAI-SDK + Emergent proxy), `anthropic`, `openai`, `gemini`, `groq`, `xai`. Auto-falls-back if primary fails.
- **Tools** (`src/main/agent/tools.ts`): 23 tools — info (web/wiki/news/weather/finance/dictionary), filesystem, system actions (open_url, open_app, open_path, run_command, screenshot, notify), clipboard, system_info.

## What's Been Implemented (2026-01-21)
- Installed all deps via `yarn install`; build (`yarn build`) succeeds clean.
- New **Emergent Universal LLM Key** backend using OpenAI SDK against `https://integrations.emergentagent.com/llm`. Verified end-to-end with Claude Sonnet 4.5, GPT-5.2 and Gemini 3 Pro (preview), including tool calling.
- Updated default model identifiers throughout: Claude Sonnet 4.5 (`claude-sonnet-4-5-20250929`), GPT-5.2, Gemini 3.1 Pro Preview.
- Pre-baked `EMERGENT_LLM_KEY` into `.env` so the app works out-of-the-box. User can override or add their own keys via Settings.
- Settings overlay redesigned: provider+model dropdowns, all key fields with hints, redesigned visuals.
- Added **9 new autonomous agent tools**: open_url, open_app, open_path, run_command (with destructive-pattern guard, 15s timeout), screenshot (saves to ~/Downloads), notify (native notifications), read_clipboard, write_clipboard, system_info.
- System prompt rewritten to emphasise multi-step tool chaining and decisive action-taking ("you can DO things, not just answer").
- Increased agent loop limit from 8 → 10 turns; max_tokens 512 → 1024 to handle Gemini 3's reasoning overhead.
- Existing 6-backend fallback chain preserved (Emergent → Anthropic → OpenAI → Gemini → Groq → xAI), now anchored on Emergent.
- README.md added with full quickstart, hotkeys, and architecture diagram.
- Verified Electron main process boots in xvfb headless: tray icon loads, BrowserWindow opens, IPC + agent + Three.js orb all initialize.

## Tech Stack
- electron 35, electron-vite 2.3, vite 5.4, React 18, three 0.176, TypeScript 5.5
- @xenova/transformers (Whisper STT), @ricky0123/vad-web (Silero VAD), onnxruntime-web
- @anthropic-ai/sdk, openai, groq-sdk, dotenv, electron-store

## P0 — Done
- [x] App builds clean, types pass, electron boots
- [x] Emergent Universal Key + Claude Sonnet 4.5 / GPT-5.2 / Gemini 3 Pro
- [x] BYOK support (Anthropic, OpenAI, Gemini, Groq, xAI) via Settings
- [x] 23 agent tools (info + system actions + clipboard + screenshot)
- [x] Voice (wake word + STT + TTS), system tray, global hotkey

## Backlog (P1 / P2)
- [ ] Multimodal vision: send screenshot bytes to Claude/GPT/Gemini for actual screen-content reasoning (currently we only return path + dimensions).
- [ ] Persistent conversation memory (across sessions) via electron-store.
- [ ] Custom wake word training (Picovoice integration).
- [ ] Conversation transcript history viewer.
- [ ] OS-level keyboard/mouse automation for click/type tools (would need robotjs / nut-tree).
- [ ] Auto-update via electron-updater.
- [ ] Mac menu bar mini-mode (MenuBarExtra-style compact UI).

## How to run locally
```bash
yarn install
yarn dev              # hot-reload dev
yarn build && yarn package    # ship DMG/NSIS/AppImage
```

## Notes
- Cannot fully exercise voice flow in headless Linux container (no mic device, no DBus). All non-IO logic (build, types, agent, IPC) verified.
- Emergent proxy works for tool calling on all three providers (verified via curl + OpenAI SDK).
