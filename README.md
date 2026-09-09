# LanguageShadow – Fix Package

This package fixes the two problems you reported:

1. **"I can't get the subtitle"**
2. **"The button [doesn't] open the side pane"**

plus follow-up fixes reported after testing:

3. **"I can't see the button on the YouTube page"** (v1.0.2)
4. **"The side panel is still empty"** + new UI requests (v1.0.3)
5. **"Settings say 2 languages but I only see the main language"** (v1.1.1)
6. **"These console lines look like errors when I change the translation language"** (v1.1.2)
7. **"Settings dropdown options are white-on-white — only the highlighted line is readable"** (v1.1.3)
8. **"Extension context invalidated" shows as errors after updating the extension** (v1.1.4)
9. **"Tested in Firefox – it refuses to open the side panel"** (v1.2.0)
10. **"Firefox cannot open a sidebar from a page-button click – use a keyboard shortcut + keep the button lighting"** (v1.3.0)

---

## v1.3.0 – Firefox: keyboard shortcut opens the panel (your suggestion)

### The hard truth you confirmed

Firefox will **never** open a sidebar programmatically from a button click
inside a normal web tab — `sidebarAction.open()` needs a user activation
that page clicks cannot provide. So v1.3.0 stops fighting it and uses
Firefox's own native mechanism, exactly as you suggested:

### What changed

1. **Keyboard shortcut** (in `firefox/manifest.json`):
   `Ctrl+Shift+U` (Mac: `Cmd+Shift+U`) toggles the LanguageShadow panel via
   the `_execute_sidebar_action` command. Users can change the key combo at
   `about:addons` → gear icon → **Manage Extension Shortcuts**.
2. **The LS button on YouTube keeps lighting up exactly as normal**
   (green idle → orange active). Clicking it still starts the session AND
   tries the auto-open; when Firefox refuses, a hint appears right on the
   video: *"Press Ctrl+Shift+U to open the LanguageShadow panel (or click
   the LS icon in the Firefox toolbar)."*
3. The **toolbar icon click** still toggles the panel too (that gesture
   always works).

### Firefox flow in practice

```
click LS button on YouTube  →  button lights orange, session starts,
                               hint shows "Press Ctrl+Shift+U …"
press Ctrl+Shift+U once     →  panel opens (stays open for the session)
```

After the first time, the sidebar normally stays open while you browse
YouTube, so later LS clicks need no shortcut at all.

### Files changed for v1.3.0

| File | Action |
|------|--------|
| `firefox/manifest.json` | **Replace** (adds the `commands` shortcut) |
| `src/background/index.js` | **Replace** (hint text now names the shortcut) |
| `src/content/index.js` | **Replace** (comment/UX docs only) |
| `manifest.json` | **Replace** (version 1.3.0, keeps versions in sync) |
| `firefox/src/*` | refreshed copy of `src/*` |
| everything else | keep from v1.2.0 |

Chrome behavior is completely unchanged — the shortcut exists only in the
Firefox manifest.

---

## v1.2.0 – Firefox support (one package, both browsers)

### Why Firefox refused to open the panel

Firefox has **no `chrome.sidePanel` API at all** – that is Chrome-only.
Firefox uses a completely different system: the **sidebar**
(`sidebar_action` in the manifest + `browser.sidebarAction.*` API) and a
classic **event page** instead of a service worker. So the Chrome build
could never open its panel there.

### What v1.2.0 ships

One zip, two flavors, one shared codebase:

```
language-shadow-fix/
├── manifest.json          ← Chrome (unchanged usage)
├── src/…                  ← shared code (now dual-browser)
└── firefox/
    ├── manifest.json      ← Firefox flavor (sidebar_action, event page)
    └── src/…              ← same code, copied
```

Shared code changes (work on BOTH browsers, Chrome behavior untouched):

- All extension-API calls go through `browser` (Firefox) / `chrome`
  (Chrome) automatically.
- The background script no longer imports `shared/constants.js` – the few
  needed constants are inlined, so it runs as a classic Firefox event page
  AND as a Chrome service worker.
- Firefox: clicking the **LanguageShadow icon in the Firefox toolbar**
  toggles the sidebar open/closed. The LS button on the YouTube page also
  tries to open it; if Firefox refuses (it sometimes demands the toolbar
  click for user-activation reasons), the video shows a hint telling you
  to click the toolbar icon once.

### Firefox install (temporary add-on)

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…**
3. Select `firefox/manifest.json` (inside the folder you unpacked)
4. Open a YouTube video → click the orange **LS** button. If the panel does
   not pop open by itself, click the **LS icon in the Firefox toolbar**
   once (click the puzzle-piece icon → pin LanguageShadow to make it always
   visible).

> Note: Firefox removes **temporary** add-ons when Firefox restarts. For a
> permanent install the extension must be signed via addons.mozilla.org
> (Developer Hub → distribute yourself) — same code, just upload the
> `firefox/` folder zipped.

### Notes for the Firefox flavor

- Requires Firefox **128+** (`world: "MAIN"` content scripts, MV3).
- Recording/scoring: the local worker (`127.0.0.1:8000`) only gets data if
  you grant *Access your data for 127.0.0.1* in the extension's
  **Permissions** tab; offline mode works regardless.
- No popup.html needed in Firefox: the toolbar button belongs to the
  sidebar toggle.

### Files changed for v1.2.0

| File | Action |
|------|--------|
| `src/background/index.js` | **Replace** (inlined constants, browser/sidePanel branching, Firefox toolbar toggle) |
| `src/content/bridge.js` | **Replace** (browser/chrome alias) |
| `src/sidepanel/index.js` | **Replace** (browser/chrome alias) |
| `src/content/index.js` | **Replace** (surfaces the toolbar hint if Firefox blocks auto-open) |
| `manifest.json` | **Replace** (version 1.2.0) |
| `firefox/` | **New folder** – Firefox manifest + copy of src |
| `src/sidepanel/style.css`, `src/sidepanel/index.html` | keep from v1.1.3 |

---

## v1.1.4 – "Extension context invalidated" is not a real error

### What you saw

After reloading the extension (to install v1.1.3), the Errors view showed:

```
[LS] runtime message failed: Extension context invalidated.
[LS] storage.set failed: Extension context invalidated.
```

### Why it happened (it is not a bug)

When you click **Reload** at `chrome://extensions`, the extension's brain is
swapped, but **the already-open YouTube tab keeps running the OLD injected
script**. That old script's connection to the extension is now dead — so
every save/state-push it attempts fails with exactly this message. It stops
the moment you press **F5** on the YouTube tab (which you should always do
after reloading the extension).

### What v1.1.4 changes

In `src/content/index.js`:

- This specific case is now **detected and downgraded**: instead of repeating
  warnings on every state push (every 150 ms), it logs **one single quiet
  info line**: `Extension was reloaded or updated – this tab still runs the
  old script. Refresh the page (F5) to reconnect.`
- After the first detection all further bridge calls fail **fast and
  silently** (no more message/timeout churn from the still-running loops).
- Genuine failures (real storage/runtime problems while the extension is
  alive) still warn as before.

### Files to replace for v1.1.4

| File | Action |
|------|--------|
| `src/content/index.js` | **Replace** (context-invalidated handling) |
| `manifest.json` | **Replace** (version 1.1.4) |
| everything else | keep from v1.1.3 |

### How to verify

1. Reload the extension at `chrome://extensions`.
2. WITHOUT refreshing the YouTube tab, watch the console → you get **one**
   quiet info line, then silence (no orange entries).
3. Press F5 on the YouTube tab → everything reconnects and works.

---

## v1.1.3 – Dropdown options readable again (white-on-white fix)

### The problem

Opening the Main/Translation language dropdown in the settings gear showed
every option as **near-white text on a white popup** — only the
blue-highlighted row was readable (your screenshot).

### Why it happened

The panel is dark-themed, so the `<select>` text is near-white (`#faf7f2`).
But the page never told Chrome "this page is dark", so Chrome painted the
native dropdown popup with its default **light** background → white text on
white background.

### The fix (yes, it really is just CSS)

In `src/sidepanel/style.css`:

- `:root { color-scheme: dark; }` — tells Chrome to render all native form
  controls (dropdown popup, scrollbars) in dark style. This is the main fix.
- Explicit `option` colors as a safety net for platforms that ignore
  `color-scheme`: dark rows (`#2c251e` background / `#faf7f2` text), and the
  hovered/selected row in **orange** to match the panel theme.

### Files to replace for v1.1.3

| File | Action |
|------|--------|
| `src/sidepanel/style.css` | **Replace** (color-scheme + option colors) |
| `manifest.json` | **Replace** (version 1.1.3) |
| everything else | keep from v1.1.2 |

### How to verify

1. Reload the extension at `chrome://extensions` (the side panel file changed,
   so also close and reopen the side panel).
2. Open the settings gear and click any dropdown → all languages are readable
   (dark rows, orange highlight).

---

## v1.1.2 – Quiet console + original-language fallback (you were right!)

### You were right: they are NOT errors

Lines like these are `console.warn` **progress notes**, not failures:

```
[LS] baseUrl fetch returned no cues
[LS] Native subtitles unavailable: no caption track for language "es"
```

They are the extension **checking** for a real native track, not finding one
(the normal case!), and then auto-translating. Translation always worked —
that is why everything functioned 100%. In v1.1.2 both messages became
**quiet info logs** (`console.log`), so nothing orange/red shows up in the
Errors view anymore. Warnings are now reserved for genuine problems only
(e.g. "No translation available for X on this video" — when every method
failed).

### Your option 1 is also in: auto original-language fallback

When the chosen translation language truly cannot be produced (no track AND
YouTube cannot auto-translate into it — rare), the extension now
automatically uses **the video's original-language track** as the second
line instead of showing nothing. The panel header badges it
**`original language`** so you always know it is not a real translation.

Priority order for the second line is now:

1. real native track (badge: *native track*)
2. YouTube auto-translate (badge: *auto-translated*)
3. video's original language (badge: *original language*)
4. nothing + one honest warning

### Files to replace for v1.1.2

| File | Action |
|------|--------|
| `src/content/index.js` | **Replace** (quiet logs + original-language fallback) |
| `src/sidepanel/index.js` | **Replace** (new *original language* badge) |
| `manifest.json` | **Replace** (version 1.1.2) |
| `src/sidepanel/style.css` | header comment only – optional |
| everything else | keep from v1.1.1 |

---

## v1.1.1 – Translation now auto-translates (the real “settings didn’t apply” story)

### What was actually happening

Your log shows the settings **were** applied correctly:

```
[LS] Settings loaded: {nativeLanguage: 'ar-AR', targetLanguage: 'de-DE', ...}
[LS] Selected track: de (manual)            ← target language picked right
[LS] Captured timedtext response for de (61 cues)
[LS] Native subtitles unavailable: no caption track for language "ar"
```

The video has **German and Spanish caption tracks, but no Arabic track**.
The old code wanted a real Arabic track for the translation line, found none,
warned, and showed **only German with no translation** — that is why it looked
like the language settings were ignored.

About “I find it first in es, not de”: the video’s original language is
Spanish, so YouTube lists `es` first in its CC menu. That is just YouTube’s
ordering — the extension correctly picks **de** because that is your target
language.

### The fix: use YouTube’s own auto-translate

YouTube can translate any caption track on the fly (the same machinery its
“Auto-translate” CC-menu entry uses). v1.1.1 now gets the native-language line
in three ways, in order:

1. **Real native track** — as before, if the video actually has one.
2. **Signed URL + `tlang`** — the player’s own signed timedtext request URL is
   remembered, then re-fetched with `&tlang=ar` appended (exactly what the
   YouTube UI does when you pick auto-translate).
3. **Player-driven capture** — `player.setOption('captions','translationLanguage',{languageCode:'ar'})`
   + re-select the target track; the network hooks capture the translated
   response. Everything is restored afterwards.

The panel header now shows **how** the second line was produced:
`auto-translated` / `native track` / `no translation on this video`.
The transcript also shows the translation **under every line** (with correct
RTL rendering for Arabic via `dir="auto"`).

### Bonus improvements in v1.1.1

- Instant re-enable: captured cues are tried **before** the baseUrl fetch
  (which always returns empty on current YouTube), so toggling LS is faster.
- Caption caches are cleared on video navigation → stale cues from the
  previous video can never leak into the next one.
- The active transcript line updates via highlight+scroll only (no full
  rebuild every second — smoother auto-scroll).

### Files to replace for v1.1.1

| File | Action |
|------|--------|
| `src/content/index.js` | **Replace** (auto-translate + strategy reorder + cache clearing) |
| `src/sidepanel/index.js` | **Replace** (badge + translation in transcript + lighter updates) |
| `src/sidepanel/style.css` | **Replace** (badge + `.cue-native` styles) |
| `manifest.json` | **Replace** (version 1.1.1) |
| `src/content/bridge.js`, `src/background/index.js`, `src/sidepanel/index.html` | keep from v1.1.0 |

### How to verify

1. Reload the extension, hard-refresh the YouTube tab (F5).
2. Start shadowing on the same video. Console should show something like:
   `Translation via auto-translated timedtext URL: 61 cues` or
   `Translation via player auto-translate capture: 61 cues`, then
   `Translation ready: 61 cues (auto-translate)`.
3. The panel header shows **German ↓ translated to Arabic** + badge
   *auto-translated*, and Arabic text appears under each German line and in
   the video overlay.

> Note: auto-translation is machine translation by YouTube. If the badge says
> `no translation on this video`, YouTube has no translation data for that
> language pair on this video — pick another video or another translation
> language to test.

---

## v1.0.3 – New side panel + settings gear

### Why the panel was empty

The side panel console showed:

```
index.js:225 Uncaught SyntaxError: Unexpected token '<'
```

Your old `src/sidepanel/index.js` **contains HTML instead of JavaScript**
(broken export/build), so its script died on load and nothing ever rendered.
The React libs referenced by the old HTML are **no longer needed**.

### What v1.0.3 ships

| File | Action |
|------|--------|
| `src/sidepanel/index.html` | **Replace** – new layout, no React/libs |
| `src/sidepanel/style.css` | **Replace** – polished dark/orange theme |
| `src/sidepanel/index.js` | **Replace** – new vanilla-JS logic |
| `src/background/index.js` | **Replace** – manager calls no longer block panel open; retry cap |
| `src/content/index.js` | **Replace** – button turns **solid orange when active** (green when idle); restarts shadowing when you save new settings |
| `manifest.json` | **Replace** – version 1.0.3 |

### New side panel features

- **⚙ Settings gear** – set **Main language** and **Translate language**
  (plus subtitle display mode). Saved to `chrome.storage` and applied
  immediately; if shadowing is active it restarts with the new languages.
- **Language pair header** – translate language shown **under** the main
  language, as requested.
- **Practice / Transcript tabs** – both live in the same panel section:
  - *Practice*: current cue card (target + native), prev / repeat / next,
    big **Record** button (sends audio to your local worker on
    `127.0.0.1:8000` and shows the score), A-B loop controls.
  - *Transcript*: full cue list with native line, click any cue to seek,
    current cue auto-highlighted + auto-scrolled.
- Toast messages for feedback, badge with cue count, compact 30 px buttons.

### About `Manager start failed: Failed to fetch`

That warning is **expected** when your local manager service
(`127.0.0.1:8765`) is not running. It never blocked the panel — v1.0.3 makes
it fully fire-and-forget so it can't delay or spam anything.

### Note on the button colors

The LS player button is now **green while idle** and turns **solid orange
while shadowing is active** (as you requested). Both colors live in
`ensureStyles()` inside `src/content/index.js` if you want to tweak them.

---

## v1.0.2 – Trusted Types fix (button was invisible)

After installing v1.0.1 the console showed:

```
Uncaught TypeError: Failed to set the 'innerHTML' property on 'Element':
This document requires 'TrustedHTML' assignment.   (at injectButton)
```

**Cause:** YouTube enforces **Trusted Types** CSP
(`require-trusted-types-for 'script'`). In the MAIN world, every
`element.innerHTML = "string"` assignment is **blocked and throws** — so the
button (and the overlay) were never created.

**Fix:** all DOM building now uses `document.createElement` +
`textContent` (never `innerHTML`). Trusted Types does not restrict those APIs.

**Bonus fix in v1.0.2:** your log showed settings loading as defaults
(`en-US`/`es-ES` instead of your `de-DE`/`ar-AR`). Settings are now read from
**page localStorage + chrome.storage.local + chrome.storage.sync** (including
nested wrapper objects), so your real languages are picked up wherever the
popup saved them. If the log still shows `en-US`/`es-ES`, just open the popup
once and re-select your languages.

Everything else in the v1.0.1 log was already working — including
`[LS] Captured timedtext response for de (61 cues)`, which proves the
subtitle network-capture hook works.

---

## v1.1.0 – New side panel (transcript + practice + settings gear)

Your side-panel log showed why the panel was **empty**:

```
index.js:225 Uncaught SyntaxError: Unexpected token '<'
```

The old panel bundle contained **uncompiled React/JSX**, which browsers cannot
run. It has been replaced with a **plain JavaScript panel — no React, no build
step** — so it works directly when loaded unpacked.

### What the new panel includes

- **Header with settings gear** — opens a settings drawer.
- **Language pair display** — main (practice) language on top, translation
  language **underneath** (`↓ translated to …`), exactly as requested.
- **Settings drawer** — set main language + translation language + what is
  shown (both / main only / translation only) + repeats per line. Saving
  applies **live**: the content script refetches subtitles immediately
  (`LS_SETTINGS_UPDATED`), no page reload needed. Settings are stored in
  `chrome.storage.local` under flat keys, so they survive restarts.
- **Current line card** — target sentence + native translation.
- **Controls** — previous, repeat, record (46 px round button, pulses red while
  recording, 30 s max), next. Compact 36 px icon buttons to save space.
- **Transcript section** — every line with timestamps; click a line to seek the
  video there; active line auto-scrolls and is highlighted in orange.
- **Score area** — after recording, the take is sent to your local worker
  (`127.0.0.1:8000/api/assess-speech` via the background). If the server is
  offline, the take is kept and playable — no crash, clear message.
- **Optimized space** — tight paddings, custom slim scrollbars, ellipsized
  video title, three views: empty → loading → session.

### Also fixed in v1.1.0

- `Manager start failed TypeError: Failed to fetch` spam — the local manager
  (`127.0.0.1:8765`) is optional; its absence is now logged **once** and never
  blocks or delays the side panel. Side-panel open retries are capped at 3.
- The side-panel open no longer waits for the manager call.

### Files to replace for v1.1.0

| File | Action |
|------|--------|
| `src/sidepanel/index.html` | **Replace** (no longer loads React libs) |
| `src/sidepanel/index.js`   | **Replace** (vanilla JS app) |
| `src/sidepanel/style.css`  | **Replace** (redesigned) |
| `src/background/index.js`  | **Replace** (quiet offline mode, retry cap) |
| `src/content/index.js`     | **Replace** (live settings updates) |
| `manifest.json`            | **Replace** (version 1.1.0) |
| `src/content/bridge.js`    | keep from v1.0.2 |

Note: if your `popup.html` bundles React too, it may show the same
`Unexpected token '<'` error — that is unrelated to the panel and can be
ignored for now (or share it with me and I'll convert it as well).

---

## What was wrong (tied to your console log)

### Problem 1 – Subtitles fail

Your log shows the exact failure chain:

```
[LS] Selected track: de
[LS] No baseUrl for track: {languageCode: 'de', ...}
[LS] Using timedtext fallback for language: de
[LS] Timedtext fallback failed: SyntaxError: ... Unexpected end of JSON input
```

Two separate causes:

- **`No baseUrl for track`** — Your script reads caption tracks from the static
  `window.ytInitialPlayerResponse`. On many watch pages YouTube now strips the
  signed `baseUrl` out of that static data, so the track object exists but has
  no fetchable URL.
- **`Unexpected end of JSON input`** — Your fallback builds an unsigned URL
  like `https://www.youtube.com/api/timedtext?v=...&lang=de`. Since ~2024
  YouTube returns **HTTP 200 with an empty body** for unsigned timedtext URLs
  (they now require signed / pot-token parameters). An empty body makes
  `res.json()` throw exactly that error. **This fallback can never work as
  written.**

### Problem 2 – Side panel never opens

Your `manifest.json` declares the content script with `"world": "MAIN"`.

Scripts in the MAIN world run in the page's own JavaScript context (that's why
you can read `movie_player`), but they have **NO access to `chrome.runtime` or
`chrome.storage`**. That means:

- `chrome.runtime.sendMessage({type: 'LS_OPEN_SIDE_PANEL'})` can never be sent
  from the content script → the background service worker never receives it →
  `chrome.sidePanel.open()` is never called.
- Reading settings from `chrome.storage` from the MAIN world also cannot work
  directly.

Your background script (`src/background/index.js`) handles
`LS_OPEN_SIDE_PANEL` correctly — the message just never reached it.

---

## What this package changes

| File | Action | Purpose |
|------|--------|---------|
| `manifest.json` | **Replace** | Registers 2 content scripts: the new isolated bridge (runs first) + the MAIN-world script |
| `src/content/bridge.js` | **Add (new file)** | ISOLATED-world relay: `chrome.runtime` / `chrome.storage` ⇄ `window.postMessage`. This is the missing link for the side panel. |
| `src/content/index.js` | **Replace** | Rewritten MAIN-world script (see below) |
| `src/background/index.js` | **No change** | Already correct |
| `src/sidepanel/*`, `popup.html` | **No change** | — |

### How the new subtitle fetching works (4 strategies, in order)

1. **Live player response** — `document.getElementById('movie_player').getPlayerResponse()`
   returns fresh caption tracks **with signed `baseUrl`** → fetch it with
   `&fmt=json3`.
2. **Network capture** — at `document_start` the script hooks `window.fetch`
   and `XMLHttpRequest` and silently records every `/api/timedtext` response
   the player itself downloads (those are always correctly signed).
3. **Forced capture** — if nothing was captured yet, the script calls
   `player.loadModule('captions')` + `player.setOption('captions','track', …)`
   so the player downloads the track itself; the hooks then grab it (captions
   are hidden again afterwards, best effort).
4. **Unsigned URL** — the old trick, kept only as a harmless last resort.

### How the side panel now opens

```
Click "LS" button (user gesture)
  → MAIN script: window.postMessage({LS_OPEN_SIDE_PANEL})
  → bridge.js (isolated world): chrome.runtime.sendMessage(...)
  → background: chrome.sidePanel.open({tabId})   ✓ gesture preserved
```

The panel is opened **immediately on click** (before subtitles are fetched) so
the user-gesture requirement of `sidePanel.open()` is always satisfied. If
subtitle fetching then fails, the error is shown as an overlay message on the
video instead of failing silently.

---

## Install

1. Copy `manifest.json` over your existing one.
2. Put `bridge.js` and `index.js` into `src/content/` (replace the old
   `index.js`).
3. Go to `chrome://extensions` → find LanguageShadow → click **Reload**.
4. **Fully reload the YouTube tab** (F5) — content scripts only inject on
   fresh page loads.

## Test

1. Open a video that **actually has captions in your target language**
   (check the CC menu — auto-generated "ASR" tracks are fine).
2. Click the orange **LS** button in the player controls.
3. Expected result:
   - Side panel opens.
   - Subtitle overlay appears above the video.
   - Console shows `Subtitles fetched via track baseUrl` or
     `Subtitles via network capture` / `forced player capture`.

## Notes & limitations

- The target language in settings must exist as a caption track on the video;
  otherwise you now get a **clear error message** on the video instead of a
  silent failure. (Your settings are `native de-DE / target ar-AR` — make sure
  the video you test with has an Arabic or German track.)
- The side panel receives data via `chrome.storage.local` keys
  `lsShadowingState` (current cue + progress) and `lsSubtitleSource`
  (full cue list). If your side panel bundle expects a different shape,
  either adapt its reader or share `src/sidepanel/index.js` so the exact
  format can be matched.
- Other extensions that also hook `fetch` (your log shows
  `pageWorld.inject.js`) coexist fine — hooks are chained.
