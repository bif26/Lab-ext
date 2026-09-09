/**
 * LanguageShadow – side panel (v1.1.2) – VANILLA JS, no React, no build step.
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

  // Recording
  let mediaRecorder = null;
  let mediaStream = null;
  let recChunks = [];
  let recTimer = null;
  let recStartTs = 0;
  const takes = [];

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
    if (!isActive) { showView('waiting'); return; }
    if (!source || !source.cues || !source.cues.length) { showView('loading'); return; }
    showView('session');
    $('video-title').textContent = (state && state.title) || '';
    renderLangPair();
    renderTranscript();
    renderCurrent();
  }

  // ------------------------------------------------------------------
  // Assessment result rendering
  // ------------------------------------------------------------------
  function extractScore(r) {
    if (!r) return null;
    const cand = [r.pronunciation_score, r.pronunciationScore, r.accuracy_score, r.score,
      r.overall && r.overall.score, r.pronunciationAssessment && r.pronunciationAssessment.score];
    return cand.find((v) => typeof v === 'number') ?? null;
  }

  function extractSubScores(r) {
    if (!r) return [];
    const p = r.pronunciationAssessment || r;
    return [
      ['Accuracy', p.accuracy_score ?? p.accuracyScore],
      ['Fluency', p.fluency_score ?? p.fluencyScore],
      ['Prosody', p.prosody_score ?? p.prosodyScore],
      ['Complete', p.completeness_score ?? p.completenessScore]
    ].filter(([, v]) => typeof v === 'number');
  }

  function extractWords(r) {
    const w = (r && (r.words || r.word_list || (r.pronunciationAssessment && r.pronunciationAssessment.words))) || null;
    if (!Array.isArray(w)) return [];
    return w.map((x) => ({ word: x.word || x.text || '', score: typeof x.score === 'number' ? x.score :
      (x.pronunciationAssessment && typeof x.pronunciationAssessment.accuracyScore === 'number' ? x.pronunciationAssessment.accuracyScore : null) }))
      .filter((x) => x.word);
  }

  function renderScore(result, offline) {
    const area = $('score-area');
    area.classList.remove('hidden');
    if (offline) {
      area.innerHTML = `<div class="score-offline">✓ Take saved. Local assessment server (127.0.0.1:8000) is offline — start it to get pronunciation scores.</div>` + takesHtml();
      return;
    }
    const score = extractScore(result);
    const subs = extractSubScores(result);
    const words = extractWords(result);
    let html = '<div class="score-header"><span class="score-title">Pronunciation</span>' +
      '<button class="score-close" id="score-close">✕</button></div>';
    if (score != null) {
      html += `<div class="score-number">${Math.round(score)}<small> /100</small></div>`;
    } else if (result && result.error) {
      html += `<div class="score-error">Assessment failed: ${esc(result.error)}</div>`;
    } else {
      html += `<div class="score-error">Assessment returned no score.</div>`;
    }
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
    html += takesHtml();
    area.innerHTML = html;
    const close = $('score-close');
    if (close) close.addEventListener('click', () => area.classList.add('hidden'));
  }

  function takesHtml() {
    if (!takes.length) return '';
    return '<div class="takes-list">' + takes.map((t, i) =>
      `<button class="take-chip" data-i="${i}">▶ ${esc(t.label)}${t.score != null ? ` · ${Math.round(t.score)}` : ''}</button>`).join('') + '</div>';
  }

  function bindTakeChips() {
    $('score-area').querySelectorAll('.take-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const t = takes[Number(chip.dataset.i)];
        if (t) new Audio(t.url).play();
      });
    });
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
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      renderScore(null, false);
      $('score-area').innerHTML = `<div class="score-error">Microphone unavailable: ${esc(e.message)}</div>`;
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
    const cur = state && state.currentCue;
    const reference = cur ? cur.target : '';
    const language = settings.targetLanguage;

    const base64 = await new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result).split(',')[1] || '');
      fr.readAsDataURL(blob);
    });

    let result = null;
    try {
      result = await api.runtime.sendMessage({
        name: 'assess-speech',
        body: { audio_base64: base64, reference_text: reference, language }
      });
    } catch (e) {
      result = { status: 'ERROR', error: e.message };
    }

    const offline = !result || result.status === 'ERROR' && /fetch|network/i.test(result.error || '');
    const score = extractScore(result);
    takes.push({ url: URL.createObjectURL(blob), label: fmtTime((Date.now() - recStartTs) / 1000), score });
    renderScore(result, offline);
    bindTakeChips();
    mediaRecorder = null;
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
    $('btn-save-settings').addEventListener('click', saveSettings);
    $('btn-prev').addEventListener('click', () => relay({ type: CMD.PREV_SENTENCE }));
    $('btn-next').addEventListener('click', () => relay({ type: CMD.NEXT_SENTENCE }));
    $('btn-repeat').addEventListener('click', () => relay({ type: CMD.REPEAT_SEGMENT }));
    $('btn-record').addEventListener('click', toggleRecording);
  }

  async function init() {
    bindEvents();
    fillLanguageSelects();
    renderLangPair();
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
