// Inlined from shared/constants.js so this ONE file runs as a Chrome MV3
// service worker (module) AND as a Firefox MV3 event page (classic script).
const RUNTIME_MESSAGE = {
  OPEN_SIDE_PANEL: 'LS_OPEN_SIDE_PANEL',
  CLOSE_SIDE_PANEL: 'LS_CLOSE_SIDE_PANEL',
  LEFT_YOUTUBE: 'LS_LEFT_YOUTUBE',
  REQUEST_SESSION_PUSH: 'LS_REQUEST_SESSION_PUSH',
  RELAY_SESSION_PUSH: 'LS_RELAY_SESSION_PUSH',
  REGISTER_SIDE_PANEL_TAB: 'LS_REGISTER_SIDE_PANEL_TAB',
  RELAY_TO_YOUTUBE_TAB: 'LS_RELAY_TO_YOUTUBE_TAB'
};
const WORKER_API_BASE = 'http://127.0.0.1:8000';
const MANAGER_API_BASE = 'http://127.0.0.1:8765';
const SESSION_PANEL_BOOTING_KEY = 'lsPanelBootingForPractice';

// Firefox exposes the promise-based `browser` namespace + sidebarAction;
// Chrome MV3 exposes promise-based `chrome` + sidePanel.
const api = (typeof browser !== 'undefined') ? browser : chrome;
const IS_FIREFOX = (typeof browser !== 'undefined') && !!api.sidebarAction;

console.log('[Background] started (' + (IS_FIREFOX ? 'Firefox event page' : 'Chrome service worker') + ').');

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

// --- Panel management (Chrome: sidePanel API / Firefox: sidebarAction API) ---
async function openSidePanel(tabId, attempt = 0) {
  activeTabId = tabId;
  console.log('[Background] Opening side panel for tab', tabId);
  try {
    if (IS_FIREFOX) {
      // Works when the call carries user activation (toolbar click handler,
      // recent Firefox also from message round-trips). Throws otherwise.
      await api.sidebarAction.open();
    } else {
      // The manifest defines default_path, so no setOptions needed.
      await api.sidePanel.open({ tabId });
    }
    await api.storage.local.set({ [SESSION_PANEL_BOOTING_KEY]: true });
    // Non-blocking: the manager is optional and must never delay/impair the panel.
    managerStart();
    pendingSidePanelOpen = false;
    return true;
  } catch (e) {
    console.warn('[Background] Panel open failed:', e.message);
    if (IS_FIREFOX) {
      // Firefox refused (missing user activation) – tell the page so it can
      // hint the user to use the toolbar button instead.
      return false;
    }
    // A user gesture is required for sidePanel.open – retry a few times only.
    if (attempt < 3) setTimeout(() => openSidePanel(tabId, attempt + 1), 800);
    return false;
  }
}

async function closeSidePanel(tabId, windowId) {
  console.log('[Background] Closing side panel for tab', tabId);
  if (IS_FIREFOX) {
    try { await api.sidebarAction.close(); } catch (e) { /* ignore */ }
  } else {
    if (tabId) {
      try { await api.sidePanel.setOptions({ tabId, enabled: false }); } catch (e) { /* ignore */ }
      try { await api.sidePanel.setOptions({ tabId, enabled: true }); } catch (e) { /* ignore */ }
    }
    if (windowId) {
      try { await api.sidePanel.close({ windowId }); } catch (e) { /* ignore */ }
    }
  }
  await api.storage.local.remove(SESSION_PANEL_BOOTING_KEY);
  await api.storage.local.remove('lsPendingSidePanelOpen');
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  await managerStop();
  activeTabId = null;
  pendingSidePanelOpen = false;
}

// Firefox: the toolbar button toggles the sidebar (no popup defined for it).
if (IS_FIREFOX && api.action && api.action.onClicked) {
  api.action.onClicked.addListener(async () => {
    try {
      const open = await api.sidebarAction.isOpen({});
      if (open) await api.sidebarAction.close();
      else await api.sidebarAction.open();
    } catch (e) {
      try { await api.sidebarAction.open(); } catch (e2) { /* ignore */ }
    }
  });
}

// --- Message handling ---
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[Background] Received message:', message);
  const handleAsync = async () => {
    try {
      switch (message.type) {
        case RUNTIME_MESSAGE.OPEN_SIDE_PANEL: {
          const tabId = sender.tab?.id || message.tabId;
          const windowId = sender.tab?.windowId || message.windowId;
          if (tabId) {
            const opened = await openSidePanel(tabId);
            if (IS_FIREFOX && !opened) {
              sendResponse({ ok: false, hint: 'Press Ctrl+Shift+U to open the LanguageShadow panel (or click the LS icon in the Firefox toolbar).' });
            } else {
              sendResponse({ ok: true });
            }
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
            const tabs = await api.tabs.query({ active: true, currentWindow: true });
            if (tabs[0]) tabId = tabs[0].id;
          }
          if (tabId) {
            try {
              await api.tabs.sendMessage(tabId, payload);
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
  api.storage.local.set({ ['lsPendingUpdateVersion']: details.version });
});
