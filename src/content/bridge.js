/**
 * LanguageShadow – ISOLATED world bridge script.
 *
 * WHY THIS FILE EXISTS:
 * Content scripts declared with "world": "MAIN" in the manifest have NO
 * access to chrome.runtime / chrome.storage. They live in the page's JS
 * context (needed to reach movie_player.getPlayerResponse() etc.), so they
 * cannot talk to the background service worker directly.
 *
 * This bridge runs in the normal (isolated) world and provides:
 *   1. MAIN world  ->  chrome.runtime.sendMessage / chrome.storage  (requests)
 *   2. chrome.runtime (background / side panel)  ->  MAIN world  (commands)
 *
 * Communication with the MAIN-world script happens via window.postMessage
 * using the markers below (nothing else is touched).
 */
(() => {
  const TAG = '[LS][bridge]';

  // ------------------------------------------------------------------
  // 1) Requests coming FROM the MAIN world
  // ------------------------------------------------------------------
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.__lsMain !== true) return;

    const { id, kind, payload, keys } = msg;
    let response = null;
    let error = null;

    try {
      switch (kind) {
        case 'ping':
          response = { ok: true };
          break;
        case 'runtime':
          response = await chrome.runtime.sendMessage(payload);
          break;
        case 'storage.get':
          response = await chrome.storage.local.get(keys ?? null);
          break;
        case 'storage.sync.get':
          response = await chrome.storage.sync.get(keys ?? null);
          break;
        case 'storage.set':
          response = await chrome.storage.local.set(payload);
          break;
        case 'storage.remove':
          response = await chrome.storage.local.remove(keys ?? []);
          break;
        default:
          error = 'Unknown bridge kind: ' + kind;
      }
    } catch (e) {
      error = (e && e.message) ? e.message : String(e);
    }

    try {
      window.postMessage({ __lsReply: true, id, response, error }, window.location.origin);
    } catch (e) {
      // Structured clone of the response can fail for exotic values.
      window.postMessage(
        { __lsReply: true, id, response: null, error: 'clone-failed: ' + ((e && e.message) || e) },
        window.location.origin
      );
    }
  });

  // ------------------------------------------------------------------
  // 2) Messages from the extension (background / side panel) -> MAIN world
  //    e.g. side panel commands relayed via RELAY_TO_YOUTUBE_TAB.
  // ------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    try {
      window.postMessage({ __lsToMain: true, message }, window.location.origin);
    } catch (e) {
      console.warn(TAG, 'relay to MAIN world failed:', e);
    }
    sendResponse({ ok: true, relayed: true });
  });

  console.log(TAG, 'ready');

  // Announce ourselves (the MAIN-world script also pings us as a fallback,
  // because script evaluation order between the two worlds is not guaranteed).
  try {
    window.postMessage({ __lsBridgeReady: true }, window.location.origin);
  } catch (e) { /* ignore */ }
})();
