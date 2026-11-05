// Must load first: installs window.api for everything below.
import './platform/tauri-api'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/global.css'
import { applyStoredAppearance, installAppearanceListeners } from './utils/apply-theme'
// Initialize undo system (subscriptions activate on import)
import './stores/undo-store'
import { initSyncAutoconnect, startSync } from './sync/session'
import { useSyncStore } from './sync/sync-store'

initSyncAutoconnect()
void window.api.syncTakePendingConnect().then(async (projectId) => {
  if (!projectId) return
  try { await startSync(projectId) }
  catch (e) {
    useSyncStore.getState().set({
      status: 'error',
      projectId,
      error: e instanceof Error ? e.message : String(e)
    })
  }
})

// Prevent the webview from opening dropped files in the window.
// Individual components (e.g. DocumentBrowser) selectively handle drops.
document.addEventListener('dragover', (e) => e.preventDefault())
document.addEventListener('drop', (e) => e.preventDefault())

// Apply the user's saved theme before React mounts so the very first
// frame paints in the right colors. Then listen for live theme changes
// pushed from other windows (e.g. Preferences) so the main window keeps
// up too — historically the main window was the only initiator of theme
// changes, so it never had to listen.
applyStoredAppearance()
installAppearanceListeners()

// data-platform on <html> (the toolbar's traffic-light indent hangs off
// it) is stamped by platform/tauri-api.ts, for every window.

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
