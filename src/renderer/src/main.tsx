import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

// NOTE: StrictMode disabled — it double-mounts effects in dev which doubled
// our mic streams, VAD instances, and Whisper loads. Causes audible/visual glitches.
void React
ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
