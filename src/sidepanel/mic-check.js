/**
 * LanguageShadow – mic-check page (v1.4.0)
 * One-time microphone permission + live level meter.
 * Works identically in Chrome (side panel) and Firefox (sidebar).
 */
(() => {
  // Firefox exposes promise-based APIs as `browser`; Chrome MV3 as `chrome`.
  const api = (typeof browser !== 'undefined') ? browser : chrome;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  async function ask() {
    const btn = $('btn-ask');
    btn.disabled = true;
    $('status').textContent = 'Asking the browser…';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      try { await api.storage.local.set({ lsMicGranted: true }); } catch (e) { /* ignore */ }
      $('status').innerHTML = '<span class="ok">✓ Microphone ready! You can close this tab and record takes in the panel.</span>';
      meterLoop(stream);
    } catch (e) {
      try { await api.storage.local.set({ lsMicGranted: false }); } catch (e2) { /* ignore */ }
      $('status').innerHTML = '<span class="bad">✕ Blocked: ' + esc(e.message || e.name) + ' — see the help below.</span>';
      btn.disabled = false;
      btn.textContent = 'Try again';
    }
  }

  // Show a short live level meter so the user SEES the mic actually works.
  function meterLoop(stream) {
    try {
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 256;
      src.connect(an);
      const data = new Uint8Array(an.frequencyBinCount);
      $('meter').classList.remove('hidden');
      let frames = 0;
      const tick = () => {
        an.getByteFrequencyData(data);
        let sum = 0;
        for (const v of data) sum += v;
        const avg = sum / data.length;
        const fill = $('meter-fill');
        if (fill) fill.style.width = Math.min(100, avg * 1.6) + '%';
        if (++frames < 180) requestAnimationFrame(tick);
        else {
          stream.getTracks().forEach((t) => t.stop());
          ctx.close().catch(() => {});
          const fill2 = $('meter-fill');
          if (fill2) fill2.style.width = '0%';
        }
      };
      requestAnimationFrame(tick);
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
    }
  }

  $('btn-ask').addEventListener('click', ask);
})();
