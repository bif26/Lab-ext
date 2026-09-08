import {
  RUNTIME_MESSAGE,
  WORKER_API_BASE,
  MANAGER_API_BASE,
  SESSION_PANEL_BOOTING_KEY
} from '../shared/constants.js';

console.log('[Background] Service worker started.');

let activeTabId = null;
let heartbeatInterval = null;
let managerStarted = false;
let managerOfflineLogged = false;
let pendingSidePanelOpen = false;  // flag for popup

// --- Manager API (local Python helper; optional – silently skipped if offline) ---
async function managerStart() {
  try {
    const res = await fetch(`${MANAGER_API_BASE}/manager/start`, { method: 'POST' });
    managerStarted = res.ok;
    managerOfflineLogged = false;
    console.log('[Background] Manager started.');
  } catch (e) {
    // Server not running – this is normal in offline mode. Log once, stay quiet.
    managerStarted = false;
    if (!managerOfflineLogged) {
      console.log('[Background] Local manager not reachable – continuing in offline mode.');
      managerOfflineLogged = true;
    }
  }
}

async function managerHeartbeat() {
  if (!managerStarted) return;
  try {
    await fetch(`${MANAGER_API_BASE}/manager/heartbeat`, { method: 'POST' });
  } catch (e) {
    managerStarted = false;
  }
}

async function managerStop() {
  if (!managerStarted) return;
  try {
    await fetch(`${MANAGER_API_BASE}/manager/stop`, { method: 'POST' });
  } catch (e) { /* ignore – server offline */ }
  managerStarted = false;
  console.log('[Background] Manager stopped.');
}

// --- Side panel management ---
async function openSidePanel(tabId, attempt = 0) {
  if (!tabId) return;
  activeTabId = tabId;
  console.log('[Background] Opening side panel for tab', tabId);
  try {
    // The manifest defines default_path, so no setOptions needed.
    await chrome.sidePanel.open({ tabId });
    await chrome.storage.local.set({ [SESSION_PANEL_BOOTING_KEY]: true });
    // Non-blocking: the manager is optional and must never delay/impair the panel.
    managerStart();
    pendingSidePanelOpen = false;
  } catch (e) {
    console.warn('[Background] Side panel open failed:', e.message);
    // A user gesture is required for sidePanel.open – retry a few times only.
    if (attempt < 3) setTimeout(() => openSidePanel(tabId, attempt + 1), 800);
  }
}

async function closeSidePanel(tabId, windowId) {
  console.log('[Background] Closing side panel for tab', tabId);
  if (tabId) {
    try { await chrome.sidePanel.setOptions({ tabId, enabled: false }); } catch (e) { /* ignore */ }
    try { await chrome.sidePanel.setOptions({ tabId, enabled: true }); } catch (e) { /* ignore */ }
  }
  if (windowId) {
    try { await chrome.sidePanel.close({ windowId }); } catch (e) { /* ignore */ }
  }
  await chrome.storage.local.remove(SESSION_PANEL_BOOTING_KEY);
  await chrome.storage.local.remove('lsPendingSidePanelOpen');
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  await managerStop();
  activeTabId = null;
  pendingSidePanelOpen = false;
}

// --- Message handling ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[Background] Received message:', message);
  const handleAsync = async () => {
    try {
      switch (message.type) {
        case RUNTIME_MESSAGE.OPEN_SIDE_PANEL: {
          const tabId = sender.tab?.id || message.tabId;
          const windowId = sender.tab?.windowId || message.windowId;
          if (tabId) {
            await openSidePanel(tabId);
            sendResponse({ ok: true });
          } else {
            sendResponse({ ok: false, error: 'Missing tab id' });
          }
          break;
        }
        case RUNTIME_MESSAGE.CLOSE_SIDE_PANEL: {
          const tabId = sender.tab?.id || message.tabId;
          const windowId = sender.tab?.windowId || message.windowId;
          await closeSidePanel(tabId, windowId);
          sendResponse({ ok: true });
          break;
        }
        case RUNTIME_MESSAGE.RELAY_TO_YOUTUBE_TAB: {
          const payload = message.payload;
          if (!payload || !payload.type) {
            sendResponse({ ok: false });
            return;
          }
          let tabId = activeTabId || sender.tab?.id;
          if (!tabId) {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tabs[0]) tabId = tabs[0].id;
          }
          if (tabId) {
            try {
              await chrome.tabs.sendMessage(tabId, payload);
              sendResponse({ ok: true });
            } catch (e) {
              sendResponse({ ok: false });
            }
          } else {
            sendResponse({ ok: false });
          }
          break;
        }
        case RUNTIME_MESSAGE.RELAY_SESSION_PUSH: {
          sendResponse({ ok: true });
          break;
        }
        case RUNTIME_MESSAGE.REGISTER_SIDE_PANEL_TAB: {
          activeTabId = message.tabId;
          sendResponse({ ok: true });
          break;
        }
        default: {
          if (message.name === 'assess-speech') {
            const { audio_base64, reference_text, language } = message.body || {};
            if (!audio_base64 || !reference_text) {
              sendResponse({ status: 'ERROR', error: 'Missing required fields' });
              return;
            }
            try {
              const response = await fetch(`${WORKER_API_BASE}/api/assess-speech`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ audio_base64, reference_text, language })
              });
              const result = await response.json();
              sendResponse(result);
            } catch (e) {
              sendResponse({ status: 'ERROR', error: e.message });
            }
            break;
          }
          sendResponse({ ok: false, error: 'Unknown message type' });
        }
      }
    } catch (err) {
      console.error('[Background] Error handling message:', err);
      sendResponse({ ok: false, error: err.message });
    }
  };
  handleAsync();
  return true;
});

chrome.runtime.onSuspend.addListener(async () => {
  console.log('[Background] Suspending.');
  await managerStop();
  if (heartbeatInterval) clearInterval(heartbeatInterval);
});

chrome.runtime.onUpdateAvailable.addListener((details) => {
  console.log('[Background] Update available:', details);
  chrome.storage.local.set({ ['lsPendingUpdateVersion']: details.version });
});
