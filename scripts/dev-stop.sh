#!/usr/bin/env bash
# Stop all Jarviz dev processes (Vite on 5173 + Electron from this repo).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

for pid in $(lsof -ti tcp:5173 2>/dev/null || true); do
  kill -9 "$pid" 2>/dev/null || true
done

pkill -9 -f "${ROOT}/node_modules/electron/dist/Electron.app" 2>/dev/null || true
pkill -9 -f "${ROOT}/node_modules/.bin/electron-vite" 2>/dev/null || true
pkill -9 -f "${ROOT}/node_modules/@esbuild" 2>/dev/null || true

echo "dev-stop: port 5173 and Jarviz Electron/electron-vite cleared (if any were running)."
