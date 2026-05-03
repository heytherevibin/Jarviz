import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { PanelView } from './PanelView'

// NOTE: StrictMode disabled — it double-mounts effects in dev which doubled
// our mic streams, VAD instances, and Whisper loads. Causes audible/visual glitches.
void React

const params = new URLSearchParams(window.location.search)
const view   = params.get('view')

const root = ReactDOM.createRoot(document.getElementById('root')!)
if (view === 'settings' || view === 'panel') {
  root.render(<PanelView />)
} else {
  root.render(<App />)
}
