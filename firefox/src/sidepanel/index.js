/**
 * LanguageShadow – side panel (v1.4.0) – VANILLA JS, no React, no build step.
 *
 * Replaces the old React/JSX bundle which crashed with
 * "Uncaught SyntaxError: Unexpected token '<'" (uncompiled JSX).
 *
 * Data sources (chrome.storage.local, written by the content script):
 *   lsShadowingState  – active flag, video info, current cue index
 *   lsSubtitleSource  – full cue list + native cue list
 *
 * Commands (sent to background → relayed to the YouTube tab):
 *   LS_SEEK_CUE / LS_NEXT_SENTENCE / LS_PREV_SENTENCE / LS_REPEAT_SEGMENT
 *   LS_SETTINGS_UPDATED  – live language changes from the gear menu
 *
 * Recording model (v1.4.0):
 *   - Every take belongs to the caption that was active when it started.
 *   - Takes are numbered (1, 2, 3 …), selectable, playable, and scored
 *     EXPLICITLY with the Score button (only the selected take is sent).
 *   - Each take keeps its own score/result until the user moves to another
 *     caption — then takes are wiped automatically (blob URLs revoked, RAM).
 *   - API contract: see API.md in the package root.
 *
 * Auto-connect (v1.5.0):
 *   - The header shows a LIVE status pill for the local scoring server
 *     (manager :8765 / worker :8000), refreshed every 10 s via the background.
 *   - Scoring goes through the background, which talks to the MANAGER first
 *     (it auto-starts the AI worker) and falls back to the worker directly.
 *   - While a cold start is running the score card shows a "waking the local
 *     AI…" state; an offline result offers an actionable hint + Retry.
 */
(() => {
  // ------------------------------------------------------------------
  // Constants
  // ------------------------------------------------------------------
  const STATE_KEY = 'lsShadowingState';
  const SOURCE_KEY = 'lsSubtitleSource';
  const RELAY_TYPE = 'LS_RELAY_TO_YOUTUBE_TAB';
  const CMD = {
    SEEK_CUE: 'LS_SEEK_CUE',
    NEXT_SENTENCE: 'LS_NEXT_SENTENCE',
    PREV_SENTENCE: 'LS_PREV_SENTENCE',
    REPEAT_SEGMENT: 'LS_REPEAT_SEGMENT',
    PAUSE_FOR_RECORDING: 'LS_PAUSE_FOR_RECORDING',
    SETTINGS_UPDATED: 'LS_SETTINGS_UPDATED'
  };
  const MAX_RECORDING_MS = 30000;
  const HEALTH_POLL_MS = 10000;   // status pill refresh
  const COLD_START_HINT_MS = 3000; // show "waking the AI…" after this long

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
  const FLAGS = { en: '🇬🇧', de: '🇩🇪', ar: '🇸🇦', es: '🇪🇸', fr: '🇫🇷', it: '🇮🇹', pt: '🇧🇷', ru: '🇷🇺', ja: '🇯🇵', ko: '🇰🇷', zh: '🇨🇳', tr: '🇹🇷', nl: '🇳🇱', pl: '🇵🇱', hi: '🇮🇳', sv: '🇸🇪' };

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
  let state = null;   // lsShadowingState
  let source = null;  // lsSubtitleSource
  let activeIndex = -1;

  // Recording & takes (multiple recordings per caption line)
  let mediaRecorder = null;
  let mediaStream = null;
  let recChunks = [];
  let recTimer = null;
  let recStartTs = 0;
  let recRef = '';        // caption text captured at record START
  let recLang = '';       // language captured at record START
  const takes = [];       // { blob, url, label, reference, language, score, result }
  let selTake = -1;       // currently selected take index
  let curCueKey = -1;     // caption change detector → auto cleanup
  const takeAudio = new Audio(); // single playback element (paused on switch)

  // Local scoring server status (auto-connect)
  let serverState = 'checking';  // 'checking' | 'online' | 'starting' | 'offline'
  let serverInfo = null;         // last health payload from the background
  let healthTimer = null;

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
  // Firefox exposes promise-based APIs as `browser`; Chrome MV3 as `chrome`.
  const api = (typeof browser !== 'undefined') ? browser : chrome;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtTime = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  const flagOf = (code) => FLAGS[(code || '').split('-')[0]] || '🌐';
  const langLabel = (code) => (LANGUAGES.find((x) => x[0] === code) || [null, code || '—'])[1];
  const relay = (payload) => api.runtime.sendMessage({ type: RELAY_TYPE, payload }).catch(() => {});

  // ------------------------------------------------------------------
  // Local server status (auto-connect pill + health polling)
  // ------------------------------------------------------------------
  function renderServerStatus() {
    const el = $('server-status');
    if (!el) return;
    const label = {
      checking: 'AI · checking',
      online: 'AI · connected',
      starting: 'AI · starting',
      offline: 'AI · offline'
    }[serverState] || 'AI · ?';
    el.className = 'server-status ' + serverState;
    el.textContent = label;
    const model = serverInfo && serverInfo.model_name ? serverInfo.model_name : '?';
    const loaded = serverInfo && serverInfo.model_loaded === true ? 'loaded' : 'loads on first use';
    const workerUp = serverInfo && serverInfo.worker && serverInfo.worker.up;
    const managerUp = serverInfo && serverInfo.manager && serverInfo.manager.up;
    el.title = `Local model (LanguageShadow)\n` +
      `Manager (127.0.0.1:8765): ${managerUp ? 'running' : 'not reachable'}\n` +
      `AI worker (127.0.0.1:8000): ${workerUp ? 'running' : 'not running (auto-starts on demand)'}\n` +
      `Model: ${model} (${loaded})\n` +
      `Click to re-check · start the stack with: cd languageshadow && ./start_manager.sh`;
  }

  async function pollHealth() {
    try {
      const h = await api.runtime.sendMessage({ name: 'health-check' });
      serverInfo = h || null;
      const managerUp = !!(h && h.manager && h.manager.up);
      const workerUp = !!(h && h.worker && h.worker.up);
      if (workerUp || (managerUp && h.manager.model_loaded)) serverState = 'online';
      else if (managerUp) serverState = 'starting';  // manager alive, worker not spawned yet
      else serverState = 'offline';
    } catch (e) {
      serverState = 'offline';
      serverInfo = null;
    }
    renderServerStatus();
  }

  function startHealthPolling() {
    pollHealth();
    if (healthTimer) clearInterval(healthTimer);
    healthTimer = setInterval(pollHealth, HEALTH_POLL_MS);
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------
  function showView(name) {
    $('view-waiting').classList.toggle('hidden', name !== 'waiting');
    $('view-loading').classList.toggle('hidden', name !== 'loading');
    $('view-session').classList.toggle('hidden', name !== 'session');
  }

  function renderLangPair() {
    // Translation source badge: tells the user HOW the second line is produced
    const srcBadge = !source || !source.cues ? '' :
      source.translationSource === 'auto-translate'
        ? '<span class="src-badge">auto-translated</span>'
        : source.translationSource === 'track'
          ? '<span class="src-badge">native track</span>'
          : source.translationSource === 'original'
            ? '<span class="src-badge">original language</span>'
            : source.translationSource === 'none'
              ? '<span class="src-badge warn">no translation on this video</span>'
              : '';
    $('lang-pair').innerHTML =
      `<div class="lang-main"><span class="flag">${flagOf(settings.targetLanguage)}</span>` +
      `<span class="lang-name">${esc(langLabel(settings.targetLanguage))}</span></div>` +
      `<div class="lang-sub"><span class="arrow">↓</span>` +
      `<span class="lang-name">translated to ${esc(langLabel(settings.nativeLanguage))}</span>${srcBadge}</div>`;
  }

  function renderCurrent() {
    const cur = state && state.currentCue;
    const mode = settings.subtitleDisplayMode;
    const target = mode !== 'native' && cur ? cur.target : (mode === 'native' && cur ? cur.native : '');
    const native = mode !== 'target' && cur ? cur.native : '';
    $('cur-target').textContent = target || (cur ? '' : 'Waiting for the next line…');
    $('cur-native').textContent = native || '';
    if (!cur) $('cur-target').textContent = '⏸ waiting for speech…';
  }

  // Find the native (translation) text for a target cue start time.
  // nativeCues arrive sorted by start – binary search + small window scan.
  function nativeTextAt(start) {
    const nc = (source && source.nativeCues) || [];
    if (!nc.length) return '';
    let lo = 0, hi = nc.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (start < nc[mid].start - 0.5) hi = mid - 1;
      else { best = mid; lo = mid + 1; }
    }
    for (let i = Math.max(0, best - 2); i <= Math.min(nc.length - 1, best + 2); i++) {
      if (start >= nc[i].start - 0.5 && start <= nc[i].end + 0.5) return nc[i].text;
    }
    return '';
  }

  function renderTranscript() {
    const box = $('transcript');
    const cues = (source && source.cues) || [];
    const nativeCues = (source && source.nativeCues) || [];
    $('cue-count').textContent = cues.length ? `${cues.length} lines` : '';
    box.innerHTML = '';
    const showNative = settings.subtitleDisplayMode !== 'target' && nativeCues.length > 0;
    const frag = document.createDocumentFragment();
    cues.forEach((c, i) => {
      const item = document.createElement('div');
      item.className = 'transcript-cue' + (i === activeIndex ? ' active' : '');
      item.dataset.index = i;
      const native = showNative ? nativeTextAt(c.start) : '';
      item.innerHTML =
        `<span class="cue-time">${fmtTime(c.start)}</span>` +
        `<span class="cue-text">${esc(c.text)}</span>` +
        (native ? `<div class="cue-native" dir="auto">${esc(native)}</div>` : '');
      item.addEventListener('click', () => relay({ type: CMD.SEEK_CUE, index: i }));
      frag.appendChild(item);
    });
    box.appendChild(frag);
  }

  function syncActiveCue() {
    const idx = state && typeof state.currentCueIndex === 'number' ? state.currentCueIndex : -1;
    if (idx === activeIndex && state) { renderCurrent(); return; }
    activeIndex = idx;
    // Moving to another caption frees the recordings of the old one (RAM).
    if (idx !== curCueKey) { curCueKey = idx; clearTakes(); }
    renderCurrent();
    const box = $('transcript');
    const prev = box.querySelector('.transcript-cue.active');
    if (prev) prev.classList.remove('active');
    const el = box.querySelector(`.transcript-cue[data-index="${idx}"]`);
    if (el) {
      el.classList.add('active');
      // keep the active line visible without jumping the whole panel
      const targetTop = el.offsetTop - box.offsetTop - box.clientHeight / 2 + el.clientHeight / 2;
      box.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
    }
  }

  function renderAll() {
    const isActive = !!(state && state.active);
    if (!isActive) { clearTakes(); showView('waiting'); return; }
    if (!source || !source.cues || !source.cues.length) { showView('loading'); return; }
    showView('session');
    $('video-title').textContent = (state && state.title) || '';
    renderLangPair();
    renderTranscript();
    renderCurrent();
  }

  // ------------------------------------------------------------------
  // Assessment result parsing (tolerant to many API shapes – see API.md)
  // ------------------------------------------------------------------
  function extractScore(r) {
    if (!r) return null;
    const cand = [r.overall, r.overall_score, r.pronunciation_score, r.pronunciationScore, r.accuracy_score, r.score,
      r.overall && r.overall.score, r.pronunciationAssessment && r.pronunciationAssessment.score];
    return cand.find((v) => typeof v === 'number') ?? null;
  }

  function extractSubScores(r) {
    if (!r) return [];
    const s = r.subscores || {};
    const p = r.pronunciationAssessment || r;
    return [
      ['Accuracy', s.accuracy ?? p.accuracy_score ?? p.accuracyScore],
      ['Fluency', s.fluency ?? p.fluency_score ?? p.fluencyScore],
      ['Prosody', s.prosody ?? p.prosody_score ?? p.prosodyScore],
      ['Complete', s.completeness ?? p.completeness_score ?? p.completenessScore]
    ].filter(([, v]) => typeof v === 'number');
  }

  function extractWords(r) {
    const w = (r && (r.words || r.word_list || (r.pronunciationAssessment && r.pronunciationAssessment.words))) || null;
    if (!Array.isArray(w)) return [];
    return w.map((x) => {
      let sc = null;
      for (const v of [x.score, x.accuracy, x.accuracyScore, x.pronunciationAssessment && x.pronunciationAssessment.accuracyScore]) {
        if (typeof v === 'number') { sc = v; break; }
      }
      return { word: x.word || x.text || '', score: sc };
    }).filter((x) => x.word);
  }

  function extractPace(r) {
    if (!r) return '';
    const wpm = r.wpm ?? (r.pace && r.pace.wpm);
    const ms = r.duration_ms ?? r.durationMs ?? (r.pace && (r.pace.duration_ms ?? r.pace.durationMs));
    if (typeof wpm === 'number' && typeof ms === 'number') return `⏱ ${Math.round(wpm)} words/min · ${(ms / 1000).toFixed(1)}s`;
    if (typeof wpm === 'number') return `⏱ ${Math.round(wpm)} words/min`;
    if (typeof ms === 'number') return `⏱ ${(ms / 1000).toFixed(1)}s`;
    return '';
  }

  // ------------------------------------------------------------------
  // Takes – numbered recordings for the CURRENT caption only
  // ------------------------------------------------------------------
  function clearTakes() {
    takes.forEach((t) => { try { URL.revokeObjectURL(t.url); } catch (e) { /* ignore */ } });
    takes.length = 0;
    selTake = -1;
    try { takeAudio.pause(); } catch (e) { /* ignore */ }
    $('score-area').classList.add('hidden');
    renderTakesBar();
  }

  function renderTakesBar() {
    const bar = $('takes-bar');
    if (!bar) return;
    if (!takes.length) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
    bar.classList.remove('hidden');
    const chips = takes.map((t, i) =>
      `<button class="take-chip${i === selTake ? ' active' : ''}" data-i="${i}" title="Take ${i + 1}${t.reference ? ': ' + esc(t.reference).slice(0, 40) : ''}">` +
      `${i + 1}` +
      (t.score != null ? `<span class="score-pill ${t.score >= 80 ? 'good' : t.score >= 60 ? 'ok' : 'bad'}">${Math.round(t.score)}</span>` : '') +
      `</button>`).join('');
    bar.innerHTML =
      `<div class="takes-nav">` +
      `<button class="tnav" id="tk-prev" ${takes.length < 2 ? 'disabled' : ''} title="Previous take">◀</button>` +
      `<span class="tk-count">${selTake >= 0 ? selTake + 1 : '–'}/${takes.length}</span>` +
      `<button class="tnav" id="tk-next" ${takes.length < 2 ? 'disabled' : ''} title="Next take">▶</button>` +
      `</div>` +
      `<div class="takes-chips">${chips}</div>` +
      `<div class="takes-actions">` +
      `<button class="tbtn" id="tk-play" ${selTake < 0 ? 'disabled' : ''} title="Listen to the selected take">▶ Play</button>` +
      `<button class="tbtn primary" id="tk-score" ${selTake < 0 ? 'disabled' : ''} title="Send ONLY the selected take + its caption to the scoring API">Score</button>` +
      `</div>` +
      `<div class="takes-hint">Score sends the selected take + the caption you said to the API. Changing caption deletes all takes (saves RAM).</div>`;
    bar.querySelectorAll('.take-chip').forEach((chip) =>
      chip.addEventListener('click', () => selectTake(Number(chip.dataset.i))));
    const p = bar.querySelector('#tk-prev');
    const n = bar.querySelector('#tk-next');
    if (p) p.addEventListener('click', () => selectTake((selTake - 1 + takes.length) % takes.length));
    if (n) n.addEventListener('click', () => selectTake((selTake + 1) % takes.length));
    const play = bar.querySelector('#tk-play');
    if (play) play.addEventListener('click', playSelected);
    const sc = bar.querySelector('#tk-score');
    if (sc) sc.addEventListener('click', scoreSelected);
  }

  function selectTake(i) {
    if (i < 0 || i >= takes.length) return;
    selTake = i;
    try { takeAudio.pause(); } catch (e) { /* ignore */ }
    renderTakesBar();
    const t = takes[i];
    if (t.result) renderScoreCard(t.result, i);      // show the saved result of THIS take
    else $('score-area').classList.add('hidden');
  }

  function playSelected() {
    if (selTake < 0) return;
    try { takeAudio.pause(); } catch (e) { /* ignore */ }
    takeAudio.src = takes[selTake].url;
    takeAudio.play().catch(() => {});
  }

  async function scoreSelected() {
    if (selTake < 0) return;
    const i = selTake;
    const t = takes[i];
    const btn = $('tk-score');
    if (btn) { btn.disabled = true; btn.textContent = '… scoring'; }
    const area = $('score-area');
    area.classList.remove('hidden');
    area.innerHTML = `<div class="score-title">Scoring take ${i + 1}…</div>`;
    // Cold starts (the manager spawning the AI worker + loading the model the
    // first time) can take several seconds – show a matching hint while waiting.
    const coldHint = setTimeout(() => {
      if (area.querySelector('.score-title')) {
        area.innerHTML = `<div class="score-title">Scoring take ${i + 1}…</div>` +
          `<div class="score-waking"><span class="mini-spinner"></span> Waking the local AI (first use loads the model)…</div>`;
      }
    }, COLD_START_HINT_MS);
    const base64 = await new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result).split(',')[1] || '');
      fr.readAsDataURL(t.blob);
    });
    let result = null;
    try {
      result = await api.runtime.sendMessage({
        name: 'assess-speech',
        body: { audio_base64: base64, reference_text: t.reference, language: t.language }
      });
    } catch (e) {
      result = { status: 'ERROR', error: e.message };
    }
    clearTimeout(coldHint);
    const offline = !!result && (result.offline === true ||
      (result.status === 'ERROR' && /fetch|network|reachable|refused|timeout/i.test(result.error || '')));
    // The score is SAVED on this take – switching takes shows each own result.
    t.result = result;
    t.score = extractScore(result);
    if (btn) { btn.disabled = false; btn.textContent = 'Score'; }
    renderTakesBar();
    if (offline) {
      serverState = 'offline';
      renderServerStatus();
      area.innerHTML =
        `<div class="score-offline">` +
        `<b>Take ${i + 1} kept — score pending.</b><br>` +
        `The local scoring server (127.0.0.1:8765 / 127.0.0.1:8000) is not reachable.<br>` +
        `Start it with <code>cd languageshadow && ./start_manager.sh</code> — the extension then ` +
        `connects and scores automatically.<br>` +
        `<button class="mini-btn" id="score-retry">↻ Retry now</button></div>`;
      const retry = $('score-retry');
      if (retry) retry.addEventListener('click', () => {
        selTake = i;
        scoreSelected();
      });
    } else {
      if (t.score != null) { serverState = 'online'; renderServerStatus(); }
      renderScoreCard(result, i);
    }
  }

  function renderScoreCard(result, takeIdx) {
    const area = $('score-area');
    area.classList.remove('hidden');
    const score = extractScore(result);
    const subs = extractSubScores(result);
    const words = extractWords(result);
    const pace = extractPace(result);
    let html = '<div class="score-header"><span class="score-title">Pronunciation · Take ' + (takeIdx + 1) + '</span>' +
      '<button class="score-close" id="score-close">✕</button></div>';
    if (score != null) {
      html += `<div class="score-number">${Math.round(score)}<small> /100</small></div>`;
    } else if (result && result.error) {
      html += `<div class="score-error">Assessment failed: ${esc(result.error)}</div>`;
    } else {
      html += `<div class="score-error">Assessment returned no score.</div>`;
    }
    if (pace) html += `<div class="pace-line">${esc(pace)}</div>`;
    if (subs.length) {
      html += '<div class="sub-scores">' + subs.map(([k, v]) =>
        `<div class="sub-score"><span>${esc(k)}</span><b>${Math.round(v)}</b></div>`).join('') + '</div>';
    }
    if (words.length) {
      html += '<div class="word-list">' + words.map(({ word, score: ws }) => {
        const cls = ws == null ? '' : ws >= 80 ? 'word-good' : ws >= 60 ? 'word-ok' : 'word-bad';
        return `<span class="word ${cls}">${esc(word)}${ws != null ? ` · ${Math.round(ws)}` : ''}</span>`;
      }).join('') + '</div>';
    }
    area.innerHTML = html;
    const close = $('score-close');
    if (close) close.addEventListener('click', () => area.classList.add('hidden'));
  }

  // ------------------------------------------------------------------
  // Recording
  // ------------------------------------------------------------------
  async function toggleRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      return;
    }
    const cur = state && state.currentCue;
    if (!cur || !cur.target) { alert('No subtitle line is active right now — play the video a little first.'); return; }
    // Freeze WHICH caption this take belongs to at record start, so a later
    // cue change cannot mix up the reference text.
    recRef = cur.target;
    recLang = settings.targetLanguage;
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      const area = $('score-area');
      area.classList.remove('hidden');
      area.innerHTML = `<div class="score-error">Microphone unavailable: ${esc(e.message)}<br>Use “Allow / test” in the settings (gear) or open mic-check.html.</div>`;
      return;
    }
    recChunks = [];
    mediaRecorder = new MediaRecorder(mediaStream);
    mediaRecorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
    mediaRecorder.onstop = onRecordingStop;
    mediaRecorder.start();
    recStartTs = Date.now();
    $('btn-record').classList.add('recording');
    recTimer = setInterval(() => {
      const left = Math.max(0, MAX_RECORDING_MS - (Date.now() - recStartTs));
      $('rec-timer').textContent = (left / 1000).toFixed(1);
      if (left <= 0 && mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
    }, 100);
  }

  async function onRecordingStop() {
    clearInterval(recTimer);
    $('btn-record').classList.remove('recording');
    $('rec-timer').textContent = '';
    if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null; }
    const blob = new Blob(recChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
    const durMs = Date.now() - recStartTs;
    mediaRecorder = null;
    if (!blob.size) return;
    // NO automatic scoring – the user picks a take and presses Score.
    takes.push({
      blob,
      url: URL.createObjectURL(blob),
      label: (durMs / 1000).toFixed(1) + 's',
      reference: recRef,
      language: recLang || settings.targetLanguage,
      score: null,
      result: null
    });
    selectTake(takes.length - 1);
  }

  // ------------------------------------------------------------------
  // Settings UI
  // ------------------------------------------------------------------
  function fillLanguageSelects() {
    const opts = LANGUAGES.map(([code, label]) => `<option value="${code}">${esc(label)}</option>`).join('');
    $('set-target').innerHTML = opts;
    $('set-native').innerHTML = opts;
    $('set-target').value = settings.targetLanguage;
    $('set-native').value = settings.nativeLanguage;
    $('set-mode').value = settings.subtitleDisplayMode;
    $('set-repeat').value = String(settings.repetitionCount);
  }

  async function saveSettings() {
    settings.targetLanguage = $('set-target').value;
    settings.nativeLanguage = $('set-native').value;
    settings.subtitleDisplayMode = $('set-mode').value;
    settings.repetitionCount = Number($('set-repeat').value) || 1;
    try {
      await api.storage.local.set({
        nativeLanguage: settings.nativeLanguage,
        targetLanguage: settings.targetLanguage,
        subtitleDisplayMode: settings.subtitleDisplayMode,
        repetitionCount: settings.repetitionCount,
        pauseDuration: settings.pauseDuration,
        interfaceTheme: settings.interfaceTheme
      });
    } catch (e) { /* ignore */ }
    // Live-apply in the content script (refetches subtitles if a session is active)
    relay({
      type: CMD.SETTINGS_UPDATED,
      settings: {
        nativeLanguage: settings.nativeLanguage,
        targetLanguage: settings.targetLanguage,
        subtitleDisplayMode: settings.subtitleDisplayMode,
        repetitionCount: settings.repetitionCount
      }
    });
    renderLangPair();
    renderCurrent();
    const btn = $('btn-save-settings');
    btn.textContent = 'Saved ✓';
    setTimeout(() => { btn.textContent = 'Save'; }, 1200);
  }

  // ------------------------------------------------------------------
  // Init
  // ------------------------------------------------------------------
  function bindEvents() {
    $('btn-settings').addEventListener('click', () => {
      const p = $('settings-panel');
      const open = p.classList.toggle('open');
      $('btn-settings').classList.toggle('open', open);
    });
    const ss = $('server-status');
    if (ss) ss.addEventListener('click', pollHealth);  // manual re-check
    $('btn-save-settings').addEventListener('click', saveSettings);
    $('btn-prev').addEventListener('click', () => relay({ type: CMD.PREV_SENTENCE }));
    $('btn-next').addEventListener('click', () => relay({ type: CMD.NEXT_SENTENCE }));
    $('btn-repeat').addEventListener('click', () => relay({ type: CMD.REPEAT_SEGMENT }));
    $('btn-record').addEventListener('click', toggleRecording);
    const mic = $('btn-mic-check');
    if (mic) mic.addEventListener('click', () => {
      api.tabs.create({ url: api.runtime.getURL('src/sidepanel/mic-check.html') });
    });
  }

  async function init() {
    bindEvents();
    fillLanguageSelects();
    renderLangPair();
    renderServerStatus();
    startHealthPolling();  // auto-connect: probe + keep the status pill fresh
    try {
      const data = await api.storage.local.get([STATE_KEY, SOURCE_KEY,
        'nativeLanguage', 'targetLanguage', 'subtitleDisplayMode', 'repetitionCount']);
      if (data.nativeLanguage) settings.nativeLanguage = data.nativeLanguage;
      if (data.targetLanguage) settings.targetLanguage = data.targetLanguage;
      if (data.subtitleDisplayMode) settings.subtitleDisplayMode = data.subtitleDisplayMode;
      if (data.repetitionCount) settings.repetitionCount = data.repetitionCount;
      state = data[STATE_KEY] || null;
      source = data[SOURCE_KEY] || null;
      fillLanguageSelects();
      renderAll();
    } catch (e) {
      showView('waiting');
    }

    api.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[STATE_KEY]) {
        state = changes[STATE_KEY].newValue;
        // The active cue moves about once a second – only sync the highlight
        // and the current line, do NOT rebuild the whole transcript here
        // (a full renderAll would kill the smooth auto-scroll).
        syncActiveCue();
      }
      if (changes[SOURCE_KEY]) {
        source = changes[SOURCE_KEY].newValue;
        activeIndex = -2;
        clearTakes(); // new video / new cue list – free all recordings
        renderAll();
      }
      // Live settings change (e.g. saved from another panel instance)
      if (changes.nativeLanguage || changes.targetLanguage || changes.subtitleDisplayMode) {
        if (changes.nativeLanguage && changes.nativeLanguage.newValue) settings.nativeLanguage = changes.nativeLanguage.newValue;
        if (changes.targetLanguage && changes.targetLanguage.newValue) settings.targetLanguage = changes.targetLanguage.newValue;
        if (changes.subtitleDisplayMode && changes.subtitleDisplayMode.newValue) settings.subtitleDisplayMode = changes.subtitleDisplayMode.newValue;
        fillLanguageSelects();
        renderAll();
      }
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
