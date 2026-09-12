/**
 * LanguageShadow – content script (MAIN world) – FIXED VERSION
 *
 * Fixes included in this rewrite:
 *
 *  1) SUBTITLES
 *     - Caption tracks are now read from the LIVE player via
 *       movie_player.getPlayerResponse(). The static
 *       window.ytInitialPlayerResponse often no longer contains `baseUrl`
 *       ("No baseUrl for track" in the old log).
 *     - window.fetch + XMLHttpRequest are hooked at document_start to
 *       capture the /api/timedtext requests the player itself makes
 *       (those URLs carry valid signatures/pot tokens).
 *     - If nothing was captured yet, the player is asked to load the
 *       caption track (loadModule + setOption) so the hooks can capture
 *       the subtitle data.
 *     - The old "unsigned timedtext URL" trick is kept ONLY as a last
 *       resort: since 2024 it usually returns HTTP 200 with an EMPTY body,
 *       which caused "Unexpected end of JSON input".
 *
 *  2) SIDE PANEL
 *     - MAIN-world scripts cannot use chrome.runtime.*, so the
 *       LS_OPEN_SIDE_PANEL request is now sent through the isolated-world
 *       bridge (src/content/bridge.js) to the background service worker,
 *       which calls chrome.sidePanel.open() while the click's user
 *       activation is still fresh.
 *
 *  3) SETTINGS
 *     - Read from chrome.storage.local through the bridge (flat keys or a
 *       nested "settings" object both work).
 *
 *  4) SIDE PANEL DATA SYNC
 *     - Current practice state is written to chrome.storage.local under
 *       "lsShadowingState"; the full cue list under "lsSubtitleSource".
 *     - Commands from the side panel (seek / repeat / A-B loop ...) arrive
 *       via the bridge and are executed on the player.
 */
(() => {
  if (window.__LS_CONTENT_LOADED__) return;
  window.__LS_CONTENT_LOADED__ = true;

  console.log('[LS] Content script loaded (MAIN world).');

  // ------------------------------------------------------------------
  // Constants (mirror of src/shared/constants.js – kept in sync manually,
  // because MAIN-world scripts cannot use ES-module imports from the
  // extension bundle).
  // ------------------------------------------------------------------
  const SESSION_STATE_KEY = 'lsShadowingState';
  const SESSION_SUBTITLE_SOURCE_KEY = 'lsSubtitleSource';
  const RUNTIME_MESSAGE = {
    OPEN_SIDE_PANEL: 'LS_OPEN_SIDE_PANEL',
    CLOSE_SIDE_PANEL: 'LS_CLOSE_SIDE_PANEL'
  };
  const CONTENT_COMMAND = {
    PLAY_NATIVE: 'LS_PLAY_NATIVE',
    REPEAT_SEGMENT: 'LS_REPEAT_SEGMENT',
    NEXT_SENTENCE: 'LS_NEXT_SENTENCE',
    PREV_SENTENCE: 'LS_PREV_SENTENCE',
    PAUSE_FOR_RECORDING: 'LS_PAUSE_FOR_RECORDING',
    AB_SET_A: 'LS_AB_SET_A',
    AB_SET_B: 'LS_AB_SET_B',
    AB_TOGGLE_LOOP: 'LS_AB_TOGGLE_LOOP',
    AB_CLEAR: 'LS_AB_CLEAR',
    SEEK_CUE: 'LS_SEEK_CUE'
  };

  // Mirror of the side panel LANGUAGES list (kept in sync manually).
  // Used by the first-run onboarding popup and to turn a detected video
  // language ("de") into the panel's code format ("de-DE").
  const LANGUAGES = [
    ['en-US', 'English'],
    ['de-DE', 'German · Deutsch'],
    ['ar-AR', 'Arabic · العربية'],
    ['es-ES', 'Spanish · Español'],
    ['fr-FR', 'French · Français'],
    ['it-IT', 'Italian · Italiano'],
    ['pt-BR', 'Portuguese · Português'],
    ['ru-RU', 'Russian · Русский'],
    ['ja-JP', 'Japanese · 日本語'],
    ['ko-KR', 'Korean · 한국어'],
    ['zh-CN', 'Chinese · 中文'],
    ['tr-TR', 'Turkish · Türkçe'],
    ['nl-NL', 'Dutch · Nederlands'],
    ['pl-PL', 'Polish · Polski'],
    ['hi-IN', 'Hindi · हिन्दी'],
    ['sv-SE', 'Swedish · Svenska']
  ];
  const LANG_NAME = { en: 'English', de: 'German', ar: 'Arabic', es: 'Spanish', fr: 'French', it: 'Italian', pt: 'Portuguese', ru: 'Russian', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', tr: 'Turkish', nl: 'Dutch', pl: 'Polish', hi: 'Hindi', sv: 'Swedish' };

  const normLang = (code) => (code || '').split('-')[0].toLowerCase();
  const langName = (code) => LANG_NAME[normLang(code)] || (code || '?');
  // "de" -> "de-DE" (panel dropdown format); unknown codes stay as-is
  function fullLangCode(code) {
    const base = normLang(code);
    const hit = LANGUAGES.find(([c]) => normLang(c) === base);
    return hit ? hit[0] : (code || base || '');
  }

  const log = (...a) => console.log('[LS]', ...a);
  const warn = (...a) => console.warn('[LS]', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  const settings = {
    nativeLanguage: 'en-US',
    targetLanguage: 'es-ES',
    repetitionCount: 1,
    pauseDuration: 'auto',
    subtitleDisplayMode: 'both',
    interfaceTheme: 'dark'
  };
  const session = {
    active: false,
    videoId: null,
    cues: [],
    nativeCues: [],
    currentCueIndex: -1,
    nativePointer: 0,
    abA: null,
    abB: null,
    abLooping: false,
    // Language ACTUALLY used for the main (practice) line. Normally equals
    // settings.targetLanguage, but when the video has no captions in the
    // preferred language it becomes the video's original language and
    // languageFallback is flagged so the panel can show a "video language"
    // badge. The user's PREFERENCE in storage is never overwritten.
    effectiveTarget: null,
    languageFallback: false
  };

  // ------------------------------------------------------------------
  // Bridge client (talks to src/content/bridge.js via postMessage)
  // ------------------------------------------------------------------
  let reqId = 0;
  const pendingReplies = new Map();

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const m = event.data;
    if (!m) return;
    if (m.__lsReply && pendingReplies.has(m.id)) {
      const p = pendingReplies.get(m.id);
      pendingReplies.delete(m.id);
      if (m.error) p.reject(new Error(m.error));
      else p.resolve(m.response);
      return;
    }
    if (m.__lsToMain) {
      handleExtensionMessage(m.message);
    }
  });

  // "Extension context invalidated" = the extension was reloaded, updated or
  // disabled while this YouTube tab kept running the previously injected
  // script. It is expected, harmless and disappears after an F5 refresh,
  // so it must never show up in the Errors view – log it ONCE, quietly.
  let contextGone = false;
  const isContextGone = (e) => /extension context invalid/i.test((e && e.message) || String(e || ''));
  function bridgeFail(scope, e) {
    if (!isContextGone(e)) return false;
    if (!contextGone) {
      contextGone = true;
      log(`Extension was reloaded or updated – this tab still runs the old script. Refresh the page (F5) to reconnect. (${scope})`);
    }
    return true;
  }

  function bridgeCall(kind, { payload, keys } = {}, timeoutMs = 6000) {
    if (contextGone) return Promise.reject(new Error('Extension context invalidated.'));
    return new Promise((resolve, reject) => {
      const id = ++reqId;
      pendingReplies.set(id, { resolve, reject });
      window.postMessage({ __lsMain: true, id, kind, payload, keys }, window.location.origin);
      setTimeout(() => {
        if (pendingReplies.has(id)) {
          pendingReplies.delete(id);
          reject(new Error('bridge timeout: ' + kind));
        }
      }, timeoutMs);
    });
  }

  const bridgePing = () => bridgeCall('ping', {}, 1500).catch(() => null);
  const storageGet = (keys) => bridgeCall('storage.get', { keys });
  const storageSet = (obj) => bridgeCall('storage.set', { payload: obj }).catch((e) => { if (!bridgeFail('storage.set', e)) warn('storage.set failed:', e.message); });
  const sendRuntime = (msg) => bridgeCall('runtime', { payload: msg }).catch((e) => { if (!bridgeFail('runtime message', e)) warn('runtime message failed:', e.message); });

  // ------------------------------------------------------------------
  // Settings
  // ------------------------------------------------------------------
  // Recursively find a (sub-)object that contains our setting keys.
  // Tolerates flat storage, a nested "settings" object, or any wrapper
  // the popup may have used.
  function extractSettings(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 2) return {};
    const found = {};
    for (const k of Object.keys(settings)) {
      if (obj[k] !== undefined && obj[k] !== null) found[k] = obj[k];
    }
    if (Object.keys(found).length) return found;
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const sub = extractSettings(v, depth + 1);
        if (Object.keys(sub).length) return sub;
      }
    }
    return {};
  }

  // Page localStorage is directly readable in the MAIN world – the previous
  // version of the extension most likely stored settings there.
  function readLocalStorageSettings() {
    try {
      const flat = {};
      for (const k of Object.keys(settings)) {
        const v = localStorage.getItem(k);
        if (v !== null) {
          try { flat[k] = JSON.parse(v); } catch (e) { flat[k] = v; }
        }
      }
      if (Object.keys(flat).length) return flat;
      for (const wrap of ['lsSettings', 'ls_settings', 'ls-settings', 'settings', 'LS_SETTINGS']) {
        const raw = localStorage.getItem(wrap);
        if (raw) {
          try {
            const found = extractSettings(JSON.parse(raw));
            if (Object.keys(found).length) return found;
          } catch (e) { /* ignore */ }
        }
      }
    } catch (e) { /* ignore */ }
    return {};
  }

  async function loadSettings() {
    // Priority (lowest → highest): defaults ← page localStorage ←
    // chrome.storage.local ← chrome.storage.sync
    const merged = { ...settings };
    const apply = (src) => {
      for (const k of Object.keys(settings)) {
        if (src && src[k] !== undefined && src[k] !== null) merged[k] = src[k];
      }
    };
    apply(readLocalStorageSettings());
    try {
      apply(extractSettings(await storageGet(null)));
    } catch (e) { /* ignore */ }
    try {
      apply(extractSettings(await bridgeCall('storage.sync.get', { keys: null })));
    } catch (e) { /* ignore */ }
    for (const k of Object.keys(settings)) settings[k] = merged[k];
    log('Settings loaded:', JSON.parse(JSON.stringify(settings)));
  }

  // ------------------------------------------------------------------
  // Timedtext network capture (fetch + XHR hooks)
  // ------------------------------------------------------------------
  const capturedByLang = new Map(); // langKey -> cues[]
  const capturedUrlByLang = new Map(); // langKey -> last SIGNED timedtext URL (reusable with &tlang=)

  function langFromTimedtextUrl(url) {
    try {
      const u = new URL(url, location.origin);
      if (!u.pathname.includes('/api/timedtext')) return null;
      return { lang: u.searchParams.get('lang') || '', tlang: u.searchParams.get('tlang') || '' };
    } catch {
      return null;
    }
  }

  function parseJson3(data) {
    const cues = [];
    for (const ev of (data && data.events) || []) {
      if (!ev || !ev.segs) continue;
      const text = ev.segs.map((s) => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const start = (ev.tStartMs || 0) / 1000;
      const dur = (ev.dDurationMs || 2000) / 1000;
      if (ev.aAppend === 1 && cues.length && start <= cues[cues.length - 1].end + 0.05) {
        cues[cues.length - 1].text += ' ' + text;
        cues[cues.length - 1].end = Math.max(cues[cues.length - 1].end, start + dur);
      } else {
        cues.push({ start, end: start + dur, text });
      }
    }
    return cues;
  }

  function parseTimedtextXml(xmlText) {
    try {
      const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
      return Array.from(doc.getElementsByTagName('text'))
        .map((n) => {
          const start = parseFloat(n.getAttribute('start') || '0');
          const dur = parseFloat(n.getAttribute('dur') || '2');
          const text = (n.textContent || '').replace(/\s+/g, ' ').trim();
          return { start, end: start + dur, text };
        })
        .filter((c) => c.text);
    } catch {
      return [];
    }
  }

  function cuesFromBody(body) {
    if (!body) return [];
    const t = String(body).trim();
    if (!t) return [];
    if (t.startsWith('{') || t.startsWith('[')) {
      try { return parseJson3(JSON.parse(t)); } catch { return []; }
    }
    if (t.startsWith('<')) return parseTimedtextXml(t);
    return [];
  }

  function cacheTimedtext(url, body) {
    const info = langFromTimedtextUrl(url);
    if (!info) return;
    const cues = cuesFromBody(body);
    if (!cues.length) return;
    const langKey = info.tlang || info.lang;
    if (!langKey) return;
    // Remember the player's own SIGNED request URL – appending &tlang=<code>
    // to it later is exactly how YouTube's UI auto-translates captions.
    if (!capturedUrlByLang.has(langKey)) capturedUrlByLang.set(langKey, url);
    const existing = capturedByLang.get(langKey) || [];
    if (cues.length > existing.length) capturedByLang.set(langKey, cues);
    log('Captured timedtext response for', langKey, `(${cues.length} cues)`);
  }

  function lookupCaptured(langCode) {
    const base = (langCode || '').split('-')[0].toLowerCase();
    for (const [k, v] of capturedByLang) {
      if (k === langCode || k.split('-')[0].toLowerCase() === base) return v;
    }
    return [];
  }

  // fetch hook (installed at document_start, BEFORE YouTube's player boots)
  const origFetch = window.fetch;
  if (origFetch && !window.__LS_FETCH_HOOKED__) {
    window.__LS_FETCH_HOOKED__ = true;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const promise = origFetch.apply(this, arguments);
      if (url && url.includes('/api/timedtext')) {
        promise
          .then((res) => {
            try {
              res.clone().text().then((b) => cacheTimedtext(url, b)).catch(() => {});
            } catch (e) { /* ignore */ }
          })
          .catch(() => {});
      }
      return promise;
    };
  }

  // XHR hook
  if (!window.__LS_XHR_HOOKED__) {
    window.__LS_XHR_HOOKED__ = true;
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      try {
        if (typeof url === 'string' && url.includes('/api/timedtext')) {
          this.addEventListener('load', () => {
            try { cacheTimedtext(url, this.responseText); } catch (e) { /* ignore */ }
          });
        }
      } catch (e) { /* ignore */ }
      return origOpen.apply(this, arguments);
    };
  }

  // ------------------------------------------------------------------
  // Subtitle fetching (multi-strategy)
  // ------------------------------------------------------------------
  function getPlayer() {
    return document.getElementById('movie_player');
  }

  function getVideo() {
    return document.querySelector('video.html5-main-video') || document.querySelector('video');
  }

  function getVideoId() {
    try {
      return new URL(location.href).searchParams.get('v') ||
        (getPlayer() && getPlayer().getVideoData && getPlayer().getVideoData().video_id) || null;
    } catch {
      return null;
    }
  }

  function getCaptionTracks() {
    let tracks = [];
    // Strategy 1: LIVE player response (contains signed baseUrl)
    try {
      const p = getPlayer();
      const pr = p && typeof p.getPlayerResponse === 'function' ? p.getPlayerResponse() : null;
      tracks = (pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer &&
        pr.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
      if (tracks.length) {
        log('Caption tracks via movie_player.getPlayerResponse():', tracks.length);
        return tracks;
      }
    } catch (e) {
      warn('getPlayerResponse failed:', (e && e.message) || e);
    }
    // Strategy 2: captions tracklist via player options API
    try {
      const p = getPlayer();
      const tl = p && typeof p.getOption === 'function' ? p.getOption('captions', 'tracklist') : null;
      if (Array.isArray(tl) && tl.length) {
        log('Caption tracks via getOption(captions, tracklist):', tl.length);
        return tl;
      }
    } catch (e) { /* ignore */ }
    // Strategy 3: static player response (metadata only; baseUrl often missing)
    try {
      tracks = (window.ytInitialPlayerResponse &&
        window.ytInitialPlayerResponse.captions &&
        window.ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer &&
        window.ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
      if (tracks.length) log('Caption tracks via ytInitialPlayerResponse:', tracks.length);
    } catch (e) { /* ignore */ }
    return tracks;
  }

  function pickTrack(tracks, langPref, strict) {
    if (!tracks || !tracks.length) return null;
    const norm = (l) => (l || '').split('-')[0].toLowerCase();
    const base = norm(langPref);
    const exact = tracks.find((t) => norm(t.languageCode) === base && t.kind !== 'asr');
    const exactAsr = tracks.find((t) => norm(t.languageCode) === base);
    if (strict) return exact || exactAsr || null;
    return exact || exactAsr ||
      tracks.find((t) => t.kind !== 'asr') || tracks[0] || null;
  }

  async function fetchTimedtext(baseUrl) {
    if (!baseUrl) return [];
    let url = baseUrl;
    if (!/fmt=/.test(url)) url += (url.includes('?') ? '&' : '?') + 'fmt=json3';
    let cues = [];
    try {
      const res = await origFetch(url, { credentials: 'include' });
      cues = cuesFromBody(await res.text());
    } catch (e) {
      warn('timedtext fetch failed:', (e && e.message) || e);
    }
    if (!cues.length && url !== baseUrl) {
      // Some signed URLs break when parameters are appended – retry verbatim.
      try {
        const res = await origFetch(baseUrl, { credentials: 'include' });
        cues = cuesFromBody(await res.text());
      } catch (e) { /* ignore */ }
    }
    return cues;
  }

  async function forceCaptureViaPlayer(track, langCode) {
    const player = getPlayer();
    if (!player || typeof player.setOption !== 'function') return [];
    log('Asking the player to load captions so they can be captured...');
    try { if (typeof player.loadModule === 'function') player.loadModule('captions'); } catch (e) { /* ignore */ }
    try { player.setOption('captions', 'track', track || { languageCode: langCode }); } catch (e) {
      warn('setOption failed:', (e && e.message) || e);
    }
    for (let i = 0; i < 24; i++) {
      await sleep(250);
      if (lookupCaptured(langCode).length) break;
    }
    try { player.setOption('captions', 'track', {}); } catch (e) { /* hide again, best effort */ }
    return lookupCaptured(langCode);
  }

  async function fetchSubtitles(langPref, { strict = false } = {}) {
    const tracks = getCaptionTracks();
    const track = pickTrack(tracks, langPref, strict);
    if (track) {
      log('Selected track:', track.languageCode, track.kind ? `(${track.kind})` : '(manual)');
    } else if (strict) {
      throw new Error(`no caption track for language "${langPref}"`);
    } else {
      warn(`No caption tracks found on this video (wanted: ${langPref})`);
    }

    const langCode = (track && track.languageCode) || langPref;

    // A) Already captured via network hooks? (instant + always signed)
    let cues = lookupCaptured(langCode);
    if (cues.length) {
      log('Subtitles via network capture:', cues.length, 'cues');
      return { cues, track };
    }

    // B) Fetch directly from the signed baseUrl of the track
    if (track && track.baseUrl) {
      cues = await fetchTimedtext(track.baseUrl);
      if (cues.length) {
        log('Subtitles fetched via track baseUrl:', cues.length, 'cues');
        return { cues, track };
      }
      // EXPECTED on current YouTube (baseUrl bodies come back empty) –
      // the capture strategies below handle it. Info only, NOT an error.
      log('baseUrl returned empty (normal on current YouTube) – using capture strategies');
    } else if (track) {
      log('No baseUrl for track – using capture strategies');
    }

    // C) Force the player to load the track so the hooks capture it
    cues = await forceCaptureViaPlayer(track, langCode);
    if (cues.length) {
      log('Subtitles via forced player capture:', cues.length, 'cues');
      return { cues, track };
    }

    // D) LAST resort: unsigned URL. Since 2024 this usually returns an empty
    //    body (kept for the rare cases where it still works).
    const videoId = getVideoId();
    const base = (langPref || '').split('-')[0];
    if (videoId && base) {
      const url = `${location.origin}/api/timedtext?v=${encodeURIComponent(videoId)}&lang=${encodeURIComponent(base)}&fmt=json3`;
      try {
        const res = await origFetch(url, { credentials: 'include' });
        cues = cuesFromBody(await res.text());
        if (cues.length) {
          log('Subtitles via unsigned timedtext URL:', cues.length, 'cues');
          return { cues, track };
        }
      } catch (e) { /* ignore */ }
    }

    if (!tracks.length) {
      throw new Error('This video has no captions/subtitles at all – LanguageShadow needs captions to work. Try a video where the CC button offers languages.');
    }
    const avail = tracks.map((t) => t.languageCode).join(', ');
    throw new Error(`Captions exist (${avail}) but could not be loaded – click the CC button once, then press the LS button again.`);
  }

  // ------------------------------------------------------------------
  // Native-language cues WITH AUTO-TRANSLATE fallback
  //
  // Most videos have no caption track in the user's native language
  // (e.g. a video with es+de tracks when native = ar). The previous
  // version just warned and showed no translation at all. YouTube can
  // translate any track on the fly, though – the same mechanism its own
  // "Auto-translate" menu uses. Three ways to get it, in order:
  //   1) a real native caption track (strict pick),
  //   2) re-fetch the player's SIGNED timedtext URL with &tlang=<native>,
  //   3) ask the player to display auto-translated captions
  //      (setOption 'translationLanguage') and capture the request.
  // ------------------------------------------------------------------
  function withTlang(url, code) {
    try {
      const u = new URL(url, location.origin);
      u.searchParams.set('tlang', code);
      if (!u.searchParams.has('fmt')) u.searchParams.set('fmt', 'json3');
      return u.toString();
    } catch {
      return `${url}${url.includes('?') ? '&' : '?'}tlang=${encodeURIComponent(code)}&fmt=json3`;
    }
  }

  function findCapturedUrl(langCode) {
    const base = (langCode || '').split('-')[0].toLowerCase();
    for (const [k, u] of capturedUrlByLang) {
      if (k === langCode || k.split('-')[0].toLowerCase() === base) return u;
    }
    return null;
  }

  async function fetchTranslationByUrl(targetTrack, targetCode, nativeCode) {
    const candidates = [];
    const captured = findCapturedUrl(targetCode);
    if (captured) candidates.push(withTlang(captured, nativeCode));
    if (targetTrack && targetTrack.baseUrl) candidates.push(withTlang(targetTrack.baseUrl, nativeCode));
    for (const url of candidates) {
      try {
        const res = await origFetch(url, { credentials: 'include' });
        const cues = cuesFromBody(await res.text());
        if (cues.length) {
          capturedByLang.set(nativeCode, cues);
          return cues;
        }
      } catch (e) { /* try next candidate */ }
    }
    return [];
  }

  async function forceTranslationCapture(targetTrack, targetCode, nativeCode) {
    const player = getPlayer();
    if (!player || typeof player.setOption !== 'function') return [];
    // Bail out early when YouTube cannot translate into this language at all.
    // (info only – the original-language fallback below still applies)
    try {
      if (typeof player.getOption === 'function') {
        const tl = player.getOption('captions', 'translationLanguages') || [];
        if (tl.length && !tl.some((t) => (t.languageCode || '').split('-')[0] === nativeCode)) {
          log('YouTube cannot auto-translate into', nativeCode, '– trying fallback');
          return [];
        }
      }
    } catch (e) { /* ignore */ }
    log(`Asking the player to load AUTO-TRANSLATED captions (${nativeCode})...`);
    try { player.setOption('captions', 'translationLanguage', { languageCode: nativeCode }); } catch (e) { /* ignore */ }
    try { if (typeof player.loadModule === 'function') player.loadModule('captions'); } catch (e) { /* ignore */ }
    try { player.setOption('captions', 'track', targetTrack || { languageCode: targetCode }); } catch (e) { /* ignore */ }
    for (let i = 0; i < 24; i++) {
      await sleep(250);
      if (lookupCaptured(nativeCode).length) break;
    }
    // Restore: switch translation off and hide the track again
    try { player.setOption('captions', 'translationLanguage', {}); } catch (e) { /* ignore */ }
    try { player.setOption('captions', 'track', {}); } catch (e) { /* ignore */ }
    return lookupCaptured(nativeCode);
  }

  // Best-effort guess of the video's ORIGINAL (main) language: the first
  // caption track usually matches it; microformat language as backup.
  function getVideoOriginalLanguage() {
    try {
      const tracks = getCaptionTracks();
      if (tracks.length && tracks[0].languageCode) {
        return String(tracks[0].languageCode).split('-')[0].toLowerCase();
      }
      const p = getPlayer();
      const pr = p && typeof p.getPlayerResponse === 'function' ? p.getPlayerResponse() : null;
      const mfLang = pr && pr.microformat && pr.microformat.playerMicroformatRenderer &&
        pr.microformat.playerMicroformatRenderer.language;
      if (mfLang) return String(mfLang).split('-')[0].toLowerCase();
    } catch (e) { /* ignore */ }
    return null;
  }

  async function getNativeCues(targetTrack, targetCode, nativeCode) {
    if (!nativeCode || nativeCode === targetCode) return { cues: [], source: 'same' };
    // 1) Real native caption track on this video.
    //    NOT finding one is the NORMAL case (most videos have no track in
    //    the user's native language) – auto-translate takes over next.
    //    This is a quiet info line, never an error.
    try {
      const nat = await fetchSubtitles(nativeCode, { strict: true });
      if (nat.cues.length) return { cues: nat.cues, source: 'track' };
      log('No usable native track for', JSON.stringify(nativeCode), '– using YouTube auto-translate');
    } catch (e) {
      log('No native track for', JSON.stringify(nativeCode), '– using YouTube auto-translate');
    }
    // 2) YouTube auto-translation via signed URL + tlang
    let cues = await fetchTranslationByUrl(targetTrack, targetCode, nativeCode);
    if (cues.length) {
      log('Translation via auto-translated timedtext URL:', cues.length, 'cues');
      return { cues, source: 'auto-translate' };
    }
    // 3) Player-driven auto-translation (same path as YouTube's UI)
    cues = await forceTranslationCapture(targetTrack, targetCode, nativeCode);
    if (cues.length) {
      log('Translation via player auto-translate capture:', cues.length, 'cues');
      return { cues, source: 'auto-translate' };
    }
    // 4) Last fallback: the video's ORIGINAL language track as the second
    //    line. Better than an empty translation slot – the panel badges it
    //    as "original language" so it is never mistaken for a translation.
    const original = getVideoOriginalLanguage();
    if (original && original !== targetCode && original !== nativeCode) {
      try {
        const orig = await fetchSubtitles(original, { strict: true });
        if (orig.cues.length) {
          log(`No translation into "${nativeCode}" – using the video's original language track (${original}) instead`);
          return { cues: orig.cues, source: 'original' };
        }
      } catch (e) { /* ignore */ }
    }
    return { cues: [], source: 'none' };
  }

  // ------------------------------------------------------------------
  // Overlay
  // ------------------------------------------------------------------
  let overlayEl = null;

  function ensureStyles() {
    if (document.getElementById('ls-styles')) return;
    const st = document.createElement('style');
    st.id = 'ls-styles';
    st.textContent = [
      '#ls-overlay{position:absolute;left:50%;transform:translateX(-50%);bottom:70px;z-index:60;',
      'background:rgba(20,16,12,.82);border:1px solid rgba(249,115,22,.4);border-radius:10px;',
      'padding:8px 14px;max-width:80%;text-align:center;pointer-events:none;display:none}',
      '#ls-overlay .ls-ov-target{color:#fff;font-size:20px;font-weight:700;line-height:1.35}',
      '#ls-overlay .ls-ov-native{color:#cbd5e1;font-size:14px;margin-top:2px}',
      '#ls-overlay.ls-hidden{display:none!important}',
      '.ytp-button.ls-btn .ls-btn-label{font-size:12px;font-weight:800;color:#4ade80;',
      'line-height:36px;text-align:center;display:block;font-family:inherit;',
      'transition:color .15s ease,background .15s ease}',
      '.ytp-button.ls-btn.ls-active{background:rgba(249,115,22,.95);border-radius:6px;',
      'box-shadow:0 0 0 2px rgba(249,115,22,.35)}',
      '.ytp-button.ls-btn.ls-active .ls-btn-label{color:#1c1917}',
      // First-run onboarding popup
      '#ls-onboarding{position:fixed;top:16px;right:16px;z-index:2147483647;width:300px;',
      'background:#1c1917;color:#fafaf9;border:1px solid rgba(249,115,22,.55);border-radius:14px;',
      'padding:16px;box-shadow:0 12px 40px rgba(0,0,0,.55);font-family:Roboto,Arial,sans-serif}',
      '#ls-onboarding .ls-ob-title{margin:0 0 6px;font-size:15px;font-weight:800;color:#f97316}',
      '#ls-onboarding .ls-ob-sub{margin:0 0 4px;font-size:12px;line-height:1.5;color:#d6d3d1}',
      '#ls-onboarding label{display:block;font-size:11.5px;font-weight:700;color:#a8a29e;margin:10px 0 4px;letter-spacing:.02em}',
      '#ls-onboarding select{width:100%;box-sizing:border-box;padding:7px 8px;border-radius:8px;',
      'border:1px solid #57534e;background:#292524;color:#fafaf9;font-size:13px;outline:none}',
      '#ls-onboarding select:focus{border-color:#f97316}',
      '#ls-onboarding .ls-ob-actions{display:flex;gap:8px;margin-top:14px}',
      '#ls-onboarding button{flex:1;padding:8px 10px;border-radius:8px;border:none;',
      'font-size:12.5px;font-weight:800;cursor:pointer}',
      '#ls-onboarding .ls-ob-save{background:#f97316;color:#1c1917}',
      '#ls-onboarding .ls-ob-save:hover{background:#fb923c}',
      '#ls-onboarding .ls-ob-skip{background:#44403c;color:#e7e5e4}',
      '#ls-onboarding .ls-ob-skip:hover{background:#57534e}'
    ].join('');
    document.head.appendChild(st);
  }

  function ensureOverlay() {
    if (overlayEl && document.contains(overlayEl)) return overlayEl;
    ensureStyles();
    // NOTE: YouTube enforces Trusted Types, so innerHTML is FORBIDDEN here.
    // Build everything with createElement/textContent instead.
    overlayEl = document.createElement('div');
    overlayEl.id = 'ls-overlay';
    overlayEl.className = 'ls-hidden';
    const target = document.createElement('div');
    target.className = 'ls-ov-target';
    const native = document.createElement('div');
    native.className = 'ls-ov-native';
    overlayEl.appendChild(target);
    overlayEl.appendChild(native);
    const host = document.getElementById('movie_player') || document.body;
    host.appendChild(overlayEl);
    return overlayEl;
  }

  function showTransientOverlayMessage(text) {
    const ov = ensureOverlay();
    ov.classList.remove('ls-hidden');
    ov.querySelector('.ls-ov-target').textContent = text;
    ov.querySelector('.ls-ov-native').textContent = '';
    setTimeout(() => { if (!session.active) ov.classList.add('ls-hidden'); }, 5000);
  }

  function findCueIndex(t) {
    const cues = session.cues;
    let lo = 0, hi = cues.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = cues[mid];
      if (t < c.start) hi = mid - 1;
      else if (t > c.end) { best = mid; lo = mid + 1; }
      else return mid;
    }
    return best;
  }

  function nativeTextFor(start) {
    const nc = session.nativeCues;
    if (!nc.length) return '';
    while (session.nativePointer < nc.length && nc[session.nativePointer].end <= start) {
      session.nativePointer++;
    }
    const from = Math.max(0, session.nativePointer - 3);
    const to = Math.min(nc.length, session.nativePointer + 3);
    for (let i = from; i < to; i++) {
      const c = nc[i];
      if (start >= c.start - 0.5 && start <= c.end + 0.5) return c.text;
    }
    return '';
  }

  function renderOverlay() {
    const ov = ensureOverlay();
    const cue = session.cues[session.currentCueIndex];
    if (!session.active || !cue) {
      ov.classList.add('ls-hidden');
      return;
    }
    ov.classList.remove('ls-hidden');
    ov.querySelector('.ls-ov-target').textContent = cue.text || '';
    ov.querySelector('.ls-ov-native').textContent = nativeTextFor(cue.start);
  }

  // ------------------------------------------------------------------
  // Video sync
  // ------------------------------------------------------------------
  let videoEl = null;
  let videoHandler = null;

  function attachVideoListeners() {
    const v = getVideo();
    if (!v) return;
    if (v === videoEl && videoHandler) return;
    if (videoEl && videoHandler) videoEl.removeEventListener('timeupdate', videoHandler);
    videoEl = v;
    videoHandler = () => {
      if (!session.active || !session.cues.length) return;
      const idx = findCueIndex(videoEl.currentTime);
      if (idx !== session.currentCueIndex) {
        session.currentCueIndex = idx;
        renderOverlay();
        pushState();
      }
    };
    videoEl.addEventListener('timeupdate', videoHandler);
  }

  // ------------------------------------------------------------------
  // State push to side panel (chrome.storage via bridge)
  // ------------------------------------------------------------------
  let lastPushTs = 0;
  let pushTimer = null;

  function pushState() {
    const run = () => {
      lastPushTs = Date.now();
      pushTimer = null;
      const cue = session.cues[session.currentCueIndex] || null;
      const stateObj = {
        active: session.active,
        videoId: session.videoId,
        title: (document.title || '').replace(' - YouTube', ''),
        // EFFECTIVE language (what the main line actually speaks). When the
        // video has no captions in the preferred language this is the video's
        // own language and languageFallback flags it for the panel badge.
        targetLanguage: session.effectiveTarget || settings.targetLanguage,
        requestedLanguage: settings.targetLanguage,
        languageFallback: !!session.languageFallback,
        nativeLanguage: settings.nativeLanguage,
        currentCueIndex: session.currentCueIndex,
        currentCue: cue
          ? {
              index: session.currentCueIndex,
              start: cue.start,
              end: cue.end,
              target: cue.text,
              native: nativeTextFor(cue.start)
            }
          : null,
        cueCount: session.cues.length,
        abA: session.abA,
        abB: session.abB,
        abLooping: session.abLooping,
        updatedAt: new Date().toISOString()
      };
      storageSet({ [SESSION_STATE_KEY]: stateObj });
    };
    const since = Date.now() - lastPushTs;
    if (since >= 150) run();
    else if (!pushTimer) pushTimer = setTimeout(run, 150 - since);
  }

  function pushCuesSource(track, translationSource) {
    storageSet({
      [SESSION_SUBTITLE_SOURCE_KEY]: {
        videoId: session.videoId,
        language: (track && track.languageCode) || session.effectiveTarget || settings.targetLanguage,
        requestedLanguage: settings.targetLanguage,
        languageFallback: !!session.languageFallback,
        languageName: (track && (track.languageName || track.displayName)) || '',
        kind: (track && track.kind) || 'manual',
        displayMode: settings.subtitleDisplayMode,
        translationLanguage: settings.nativeLanguage,
        translationSource: translationSource || 'none',
        cues: session.cues,
        nativeCues: session.nativeCues,
        fetchedAt: new Date().toISOString()
      }
    });
  }

  // ------------------------------------------------------------------
  // Button
  // ------------------------------------------------------------------
  function setButtonActive(active) {
    const b = document.getElementById('ls-shadow-btn');
    if (b) b.classList.toggle('ls-active', active);
  }

  function injectButton() {
    const controls = document.querySelector('.ytp-right-controls');
    if (!controls) return false;
    if (document.getElementById('ls-shadow-btn')) return true;
    ensureStyles();
    // NOTE: YouTube enforces Trusted Types, so innerHTML is FORBIDDEN here.
    // Build everything with createElement/textContent instead.
    const btn = document.createElement('button');
    btn.id = 'ls-shadow-btn';
    btn.className = 'ytp-button ls-btn';
    btn.title = 'LanguageShadow – toggle shadowing';
    const label = document.createElement('span');
    label.className = 'ls-btn-label';
    label.textContent = 'LS';
    btn.appendChild(label);
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleShadowing();
    });
    controls.prepend(btn);
    log('Button injected.');
    return true;
  }

  function startButtonInjection() {
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      if (injectButton() || tries > 40) {
        clearInterval(timer);
        if (injectButton()) log('Button injection succeeded.');
      }
    }, 250);
  }

  // ------------------------------------------------------------------
  // A-B loop
  // ------------------------------------------------------------------
  let abTimer = null;

  function startAbLoop() {
    stopAbLoop();
    if (session.abA == null || session.abB == null) return;
    abTimer = setInterval(() => {
      const v = getVideo();
      if (v && v.currentTime >= session.abB) v.currentTime = session.abA;
    }, 200);
  }

  function stopAbLoop() {
    if (abTimer) { clearInterval(abTimer); abTimer = null; }
  }

  // ------------------------------------------------------------------
  // Shadowing control
  // ------------------------------------------------------------------
  async function toggleShadowing() {
    log('toggleShadowing called by click');
    if (session.active) {
      disableShadowing();
      return;
    }

    // IMPORTANT: ask the background to open the side panel FIRST, while the
    // user gesture (click) is still fresh. chrome.sidePanel.open() requires
    // a user gesture, and the bridge -> background round-trip preserves it.
    // Firefox: a page click can NEVER open the sidebar (no user activation
    // for sidebarAction.open from a web tab) – background replies with a
    // hint and we show it on the video: press Ctrl+Shift+U (the manifest's
    // _execute_sidebar_action shortcut) or click the LS toolbar icon.
    // The button itself still lights up orange (active) as normal either way.
    sendRuntime({ type: RUNTIME_MESSAGE.OPEN_SIDE_PANEL }).then((reply) => {
      // Firefox may refuse the automatic panel open (no user activation for
      // sidebarAction.open) – background answers { ok:false, hint } and we
      // surface that hint directly on the video.
      if (reply && reply.ok === false && reply.hint) showTransientOverlayMessage(reply.hint);
    });

    session.active = true;
    setButtonActive(true);
    try {
      await enableShadowing();
    } catch (e) {
      warn('Enable failed:', (e && e.message) || e);
      session.active = false;
      setButtonActive(false);
      showTransientOverlayMessage('LanguageShadow: ' + ((e && e.message) || e));
      pushState();
    }
  }

  // ------------------------------------------------------------------
  // Language resolution: preferred language vs. what the video actually
  // offers. Fixes the "extension set main lang es but the video is de"
  // problem: when the preferred language has no caption track we fall
  // back to the VIDEO'S ORIGINAL language automatically and tell the
  // user (panel badge + overlay message) instead of failing.
  // ------------------------------------------------------------------
  function resolveTargetLanguage() {
    const preferred = settings.targetLanguage || 'en';
    const prefBase = normLang(preferred);
    const tracks = getCaptionTracks();
    if (!tracks.length) return { effective: preferred, fallback: false, tracks };

    const hasTrack = (base) => tracks.some((t) => normLang(t.languageCode) === base);
    if (hasTrack(prefBase)) return { effective: preferred, fallback: false, tracks };

    // Preferred language not available – use the video's original language
    // (first caption track is usually it; microformat as backup).
    const original = getVideoOriginalLanguage();
    if (original && hasTrack(normLang(original))) {
      return { effective: original, fallback: true, tracks };
    }
    // Last resort: whatever manual track the video has (ASR last).
    const any = tracks.find((t) => t.kind !== 'asr') || tracks[0];
    if (any && any.languageCode) {
      return { effective: any.languageCode, fallback: true, tracks };
    }
    return { effective: preferred, fallback: false, tracks };
  }

  // Shared loader for enableShadowing() and refreshSubtitles().
  async function loadSessionCues() {
    const prefCode = settings.targetLanguage || 'en';
    const prefBase = normLang(prefCode);
    const { effective, fallback } = resolveTargetLanguage();

    log(`Target language: preferred="${prefCode}" effective="${effective}"` + (fallback ? ' (video-language fallback)' : ''));
    const { cues, track } = await fetchSubtitles(normLang(effective), { strict: false });

    session.effectiveTarget = (track && track.languageCode) || effective;
    session.languageFallback = fallback || normLang(session.effectiveTarget) !== prefBase;

    if (session.languageFallback) {
      const msg = `${langName(prefCode)} subtitles are not available on this video – using ${langName(session.effectiveTarget)} (the video's language). Change the main language in the panel settings (gear) if needed.`;
      warn(msg);
      // Surface it in two places: on the video and in the panel (badge via state).
      showTransientOverlayMessage(msg);
    }
    return { cues, track };
  }

  async function enableShadowing() {
    const { cues, track } = await loadSessionCues();
    const targetCode = session.effectiveTarget || settings.targetLanguage;
    const nativeCode = (settings.nativeLanguage || '').split('-')[0];

    session.cues = cues;
    session.currentCueIndex = -1;
    session.nativePointer = 0;
    session.videoId = getVideoId();

    // Native-language cues for the translation line (non-fatal if missing).
    // Auto-translates through YouTube when the video has no native track.
    session.nativeCues = [];
    let translationSource = 'none';
    if (nativeCode && nativeCode !== normLang(targetCode)) {
      const nat = await getNativeCues(track, normLang(targetCode), nativeCode);
      session.nativeCues = nat.cues;
      session.nativePointer = 0;
      translationSource = nat.source;
      if (nat.cues.length) {
        log('Translation ready:', nat.cues.length, `cues (${nat.source})`);
      } else {
        warn(`No translation available for "${nativeCode}" on this video`);
      }
    }
    session.translationSource = translationSource;

    attachVideoListeners();
    ensureOverlay();
    pushCuesSource(track, translationSource);
    pushState();
    log('Shadowing enabled with', cues.length, 'cues');
  }

  function disableShadowing() {
    if (!session.active) return;
    log('Shadowing disabled');
    session.active = false;
    session.abLooping = false;
    stopAbLoop();
    setButtonActive(false);
    if (overlayEl) overlayEl.classList.add('ls-hidden');
    pushState();
  }

  // Re-fetch subtitles after a language change made in the side panel
  async function refreshSubtitles() {
    log('Refreshing subtitles for new languages...');
    try {
      const { cues, track } = await loadSessionCues();
      const targetCode = session.effectiveTarget || settings.targetLanguage;
      const nativeCode = (settings.nativeLanguage || '').split('-')[0];
      session.cues = cues;
      session.currentCueIndex = -1;
      session.nativePointer = 0;
      session.nativeCues = [];
      let translationSource = 'none';
      if (nativeCode && nativeCode !== normLang(targetCode)) {
        const nat = await getNativeCues(track, normLang(targetCode), nativeCode);
        session.nativeCues = nat.cues;
        session.nativePointer = 0;
        translationSource = nat.source;
        if (!nat.cues.length) warn(`No translation available for "${nativeCode}" on this video`);
      }
      session.translationSource = translationSource;
      pushCuesSource(track, translationSource);
      renderOverlay();
      pushState();
      log('Subtitles refreshed:', cues.length, 'cues');
    } catch (e) {
      warn('Refresh failed:', (e && e.message) || e);
      showTransientOverlayMessage('LanguageShadow: ' + ((e && e.message) || e));
    }
  }

  // ------------------------------------------------------------------
  // Commands from the side panel (relayed by the bridge)
  // ------------------------------------------------------------------
  function handleExtensionMessage(message) {
    if (!message || !message.type) return;
    const v = getVideo();
    const cur = session.cues[session.currentCueIndex];
    switch (message.type) {
      case CONTENT_COMMAND.PLAY_NATIVE:
      case CONTENT_COMMAND.REPEAT_SEGMENT:
        if (v && cur) { v.currentTime = cur.start; v.play(); }
        break;
      case CONTENT_COMMAND.NEXT_SENTENCE: {
        const i = Math.min(session.cues.length - 1, session.currentCueIndex + 1);
        const c = session.cues[i];
        if (v && c) {
          session.currentCueIndex = i;
          v.currentTime = c.start;
          v.play();
          renderOverlay();
          pushState();
        }
        break;
      }
      case CONTENT_COMMAND.PREV_SENTENCE: {
        const i = Math.max(0, session.currentCueIndex - 1);
        const c = session.cues[i];
        if (v && c) {
          session.currentCueIndex = i;
          v.currentTime = c.start;
          v.play();
          renderOverlay();
          pushState();
        }
        break;
      }
      case CONTENT_COMMAND.PAUSE_FOR_RECORDING:
        if (v) v.pause();
        break;
      case CONTENT_COMMAND.SEEK_CUE: {
        const c = session.cues[message.index];
        if (v && c) {
          session.currentCueIndex = message.index;
          v.currentTime = c.start;
          v.play();
          renderOverlay();
          pushState();
        }
        break;
      }
      case CONTENT_COMMAND.AB_SET_A:
        session.abA = v ? v.currentTime : null;
        log('A-B point A set to', session.abA);
        break;
      case CONTENT_COMMAND.AB_SET_B:
        session.abB = v ? v.currentTime : null;
        log('A-B point B set to', session.abB);
        if (session.abLooping) startAbLoop();
        break;
      case CONTENT_COMMAND.AB_TOGGLE_LOOP:
        session.abLooping = !session.abLooping;
        if (session.abLooping) startAbLoop(); else stopAbLoop();
        break;
      case CONTENT_COMMAND.AB_CLEAR:
        session.abA = null;
        session.abB = null;
        session.abLooping = false;
        stopAbLoop();
        break;
      case 'LS_SETTINGS_UPDATED':
        if (message.settings && typeof message.settings === 'object') {
          Object.assign(settings, message.settings);
          log('Settings updated from side panel:', message.settings);
          if (session.active) refreshSubtitles();
        }
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------------
  // Navigation / init
  // ------------------------------------------------------------------
  function onNavigate() {
    log('Navigation detected:', location.pathname + location.search);
    // Caption data (and signed URLs) belong to the previous video – drop them
    // so stale cues can never leak into the next one.
    capturedByLang.clear();
    capturedUrlByLang.clear();
    const wasActive = session.active;
    session.cues = [];
    session.nativeCues = [];
    session.currentCueIndex = -1;
    session.nativePointer = 0;
    session.effectiveTarget = null;
    session.languageFallback = false;
    if (wasActive) disableShadowing();
    if (location.pathname === '/watch') {
      startButtonInjection();
      attachVideoListeners();
    }
  }

  // ------------------------------------------------------------------
  // First-run onboarding: a small popup in the corner of the YouTube tab
  // asking for the main (practice) language and the translation language.
  // Shown once, when the background flagged lsOnboardingPending on install.
  // Trusted-Types safe: built with createElement/textContent only.
  // ------------------------------------------------------------------
  function fillLangSelectForOnboarding(sel, selectedCode, detectedOriginal) {
    // Ensure the detected video language exists in the list (e.g. "de" is
    // covered, but rare languages would be missing) and preselect it.
    const codes = LANGUAGES.map(([c]) => c);
    if (detectedOriginal && !codes.some((c) => normLang(c) === normLang(detectedOriginal))) {
      const opt = document.createElement('option');
      opt.value = fullLangCode(detectedOriginal);
      opt.textContent = langName(detectedOriginal) + ' · ' + detectedOriginal;
      sel.appendChild(opt);
    }
    for (const [code, label] of LANGUAGES) {
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = label;
      sel.appendChild(opt);
    }
    const wantFull = fullLangCode(selectedCode || detectedOriginal || codes[0]);
    const wantBase = normLang(wantFull);
    const match = Array.from(sel.options).find((o) => normLang(o.value) === wantBase);
    sel.value = match ? match.value : sel.options[0].value;
  }

  async function maybeShowOnboarding() {
    let flag = null;
    try {
      const st = await storageGet(['lsOnboardingPending']);
      flag = st && st.lsOnboardingPending;
    } catch (e) { /* bridge not ready – skip silently */ }
    if (!flag) return;
    if (document.getElementById('ls-onboarding')) return;
    log('First run detected – showing the language setup popup.');

    ensureStyles();
    const box = document.createElement('div');
    box.id = 'ls-onboarding';

    const title = document.createElement('div');
    title.className = 'ls-ob-title';
    title.textContent = 'LanguageShadow · Setup';

    const sub = document.createElement('p');
    sub.className = 'ls-ob-sub';
    sub.textContent = 'Pick your languages. The orange LS button in the player starts shadowing. You can change these anytime in the panel settings (gear).';

    const detected = getVideoOriginalLanguage();

    const lblTarget = document.createElement('label');
    lblTarget.textContent = 'Main language (I practice in…)';
    const selTarget = document.createElement('select');
    fillLangSelectForOnboarding(selTarget, settings.targetLanguage, detected);

    const lblNative = document.createElement('label');
    lblNative.textContent = 'Translation language (show subtitles in…)';
    const selNative = document.createElement('select');
    fillLangSelectForOnboarding(selNative, settings.nativeLanguage, null);

    const actions = document.createElement('div');
    actions.className = 'ls-ob-actions';
    const btnSave = document.createElement('button');
    btnSave.className = 'ls-ob-save';
    btnSave.textContent = 'Save & start';
    const btnSkip = document.createElement('button');
    btnSkip.className = 'ls-ob-skip';
    btnSkip.textContent = 'Skip';

    actions.appendChild(btnSave);
    actions.appendChild(btnSkip);
    box.appendChild(title);
    box.appendChild(sub);
    box.appendChild(lblTarget);
    box.appendChild(selTarget);
    box.appendChild(lblNative);
    box.appendChild(selNative);
    box.appendChild(actions);
    (document.body || document.documentElement).appendChild(box);

    const close = () => { try { box.remove(); } catch (e) { /* ignore */ } };

    btnSkip.addEventListener('click', async () => {
      close();
      try { await bridgeCall('storage.remove', { keys: ['lsOnboardingPending'] }); } catch (e) { /* ignore */ }
    });

    btnSave.addEventListener('click', async () => {
      settings.targetLanguage = fullLangCode(selTarget.value);
      settings.nativeLanguage = fullLangCode(selNative.value);
      log('Onboarding saved languages:', settings.targetLanguage, '/', settings.nativeLanguage);
      close();
      try {
        await storageSet({
          targetLanguage: settings.targetLanguage,
          nativeLanguage: settings.nativeLanguage
        });
        await bridgeCall('storage.remove', { keys: ['lsOnboardingPending'] });
      } catch (e) { warn('Onboarding save failed:', (e && e.message) || e); }
      // If a session is already running, apply the new languages immediately.
      if (session.active) refreshSubtitles();
    });
  }

  async function init() {
    // Wait for the bridge (it also announces itself; ping is a safe fallback
    // because evaluation order between the two worlds is not guaranteed).
    const t0 = Date.now();
    while (Date.now() - t0 < 4000) {
      if (await bridgePing()) break;
      await sleep(150);
    }
    await loadSettings();
    startButtonInjection();
    attachVideoListeners();
    maybeShowOnboarding();
  }

  document.addEventListener('yt-navigate-finish', onNavigate, true);

  init();
})();
