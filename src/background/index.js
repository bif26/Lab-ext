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
// Timeouts: health checks must be snappy; assessment may include a cold start
// (manager spawns the worker + faster-whisper lazy-loads the model, ~2–10 s).
const HEALTH_TIMEOUT_MS = 3000;
const ASSESS_TIMEOUT_MS = 60000;

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

// --- Local server plumbing (LanguageShadow manager port 8765 + worker port 8000) ---
// The MANAGER is the small always-on process: it SPAWNS the heavy AI worker on
// demand (first assess request) and proxies /api/assess-speech to it. The WORKER
// is the process that owns the Whisper model and is auto-killed after ~60 s idle.
// => Scoring should go through the manager first so the worker comes back
//    automatically; the direct worker URL is only a fallback for setups where
//    just the worker runs.
function fetchWithTimeout(url, opts = {}, timeoutMs = HEALTH_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const ctl = ('AbortController' in self) ? new AbortController() : null;
    const timer = setTimeout(() => {
      try { if (ctl) ctl.abort(); } catch (e) { /* ignore */ }
      reject(new Error('timeout'));
    }, timeoutMs);
    fetch(url, ctl ? { ...opts, signal: ctl.signal } : opts)
      .then((res) => { clearTimeout(timer); resolve(res); })
      .catch((e) => { clearTimeout(timer); reject(e); });
  });
}

async function managerStart() {
  try {
    const res = await fetchWithTimeout(`${MANAGER_API_BASE}/manager/start`, { method: 'POST' }, HEALTH_TIMEOUT_MS);
    managerStarted = res.ok;
    managerOfflineLogged = false;
    console.log('[Background] Manager start request sent (worker auto-spawns on demand).');
  } catch (e) {
    // Server not running – this is normal in offline mode. Log once, stay quiet.
    managerStarted = false;
    if (!managerOfflineLogged) {
      console.log('[Background] Local manager not reachable – continuing in offline mode.');
      managerOfflineLogged = true;
    }
  }
}

// GET /health on both ports. Never throws – always resolves a status object.
async function checkServerHealth() {
  const out = { ok: false, manager: null, worker: null, model_loaded: null, model_name: null };
  const probe = async (base) => {
    try {
      const res = await fetchWithTimeout(`${base}/health`, { method: 'GET' }, HEALTH_TIMEOUT_MS);
      if (!res.ok) return { up: false };
      const j = await res.json();
      return { up: true, ...j };
    } catch (e) {
      return { up: false };
    }
  };
  out.manager = await probe(MANAGER_API_BASE);
  out.worker = await probe(WORKER_API_BASE);
  out.ok = !!(out.manager.up || out.worker.up);
  const src = out.worker.up ? out.worker : out.manager;
  if (src && src.up) {
    out.model_loaded = !!src.model_loaded;
    out.model_name = src.model_name || null;
  }
  return out;
}

// POST /api/assess-speech with automatic connection recovery.
// Order: manager (auto-starts the worker; tolerates a cold start) → worker direct.
async function assessSpeech(body) {
  const payload = JSON.stringify({
    audio_base64: body.audio_base64,
    reference_text: body.reference_text,
    language: body.language || body.target_language || 'auto'
  });
  const post = (base) => fetchWithTimeout(`${base}/api/assess-speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload
  }, ASSESS_TIMEOUT_MS);

  // 1) Manager first – it spawns the worker if it was idle-killed.
  try {
    const res = await post(MANAGER_API_BASE);
    const result = await res.json();
    if (res.ok && result && result.status !== 'ERROR') return { ...result, via: 'manager' };
    if (result && result.error) return { ...result, via: 'manager' };  // API-level error (audio, model, …)
    if (res.status === 404 || res.status >= 500) {
      // Manager reachable but cannot serve the endpoint right now –
      // give the direct worker path a chance before failing.
      throw new Error('manager HTTP ' + res.status);
    }
    return { status: 'ERROR', error: `Server returned HTTP ${res.status}`, via: 'manager' };
  } catch (e) {
    console.log('[Background] Manager not usable for scoring (' + e.message + ') – trying worker directly…');
  }

  // 2) Fallback: worker direct (setups without the manager).
  try {
    const res = await post(WORKER_API_BASE);
    const result = await res.json();
    if (res.ok && result && result.status !== 'ERROR') return { ...result, via: 'worker' };
    if (result && result.error) return { ...result, via: 'worker' };
    return { status: 'ERROR', error: `Server returned HTTP ${res.status}`, via: 'worker' };
  } catch (e) {
    console.log('[Background] No local scoring server reachable (manager 8765 / worker 8000).');
    return {
      status: 'ERROR',
      offline: true,
      error: 'Local scoring server is not reachable on 127.0.0.1:8765 / 127.0.0.1:8000.',
      hint: 'Start it with:  cd languageshadow && ./start_manager.sh  — the extension connects and scores automatically once it is up.'
    };
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
            const { audio_base64, reference_text } = message.body || {};
            if (!audio_base64 || !reference_text) {
              sendResponse({ status: 'ERROR', error: 'Missing required fields' });
              return;
            }
            try {
              const result = await assessSpeech(message.body);
              sendResponse(result);
            } catch (e) {
              sendResponse({ status: 'ERROR', error: e.message });
            }
            break;
          }
          if (message.name === 'health-check') {
            // Used by the side panel status pill. Never throws.
            try {
              const health = await checkServerHealth();
              sendResponse(health);
            } catch (e) {
              sendResponse({ ok: false, manager: null, worker: null });
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
