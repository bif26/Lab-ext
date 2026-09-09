# LanguageShadow – Scoring API Contract (v1.4.0)

This is the complete contract between the extension and your local scoring
server. Implement exactly this and the panel's **Score** button works out of
the box. A runnable example server lives in `example-server/server.py`.

## Endpoint

```
POST http://127.0.0.1:8000/api/assess-speech
Content-Type: application/json
```

The request is sent by the extension's **background service worker** (so no
CORS problems; the manifest already has the host permission).

## Request

| Field           | Type   | Description |
|-----------------|--------|-------------|
| `audio_base64`  | string | The user's recording. **webm/opus** container (Chrome) or ogg/opus (Firefox), base64-encoded, ≤ 30 s. |
| `reference_text`| string | The caption the user practiced — exactly the subtitle line shown in the panel. |
| `language`      | string | BCP-47 tag of the caption, e.g. `de-DE`, `en-US`, `ar-AR`. |

```json
{
  "audio_base64": "GkXfo0AgQoaBAUL3gQFC8oeeQ...",
  "reference_text": "Ich habe heute einen langen Tag gehabt.",
  "language": "de-DE"
}
```

### curl example

```bash
B64=$(base64 -w0 take.webm)
curl -s http://127.0.0.1:8000/api/assess-speech \
  -H 'Content-Type: application/json' \
  -d "{\"audio_base64\":\"$B64\",\"reference_text\":\"Ich habe heute einen langen Tag gehabt.\",\"language\":\"de-DE\"}"
```

## Response — the recommended scoring format

Scores are integers **0–100**. This shape is designed for shadowing practice:
one honest overall number, four sub-scores that tell the user WHAT to improve,
a pace readout, and word-level detail for self-correction.

```json
{
  "status": "OK",
  "overall": 84,
  "subscores": {
    "accuracy":     88,
    "fluency":      81,
    "prosody":      76,
    "completeness": 100
  },
  "pace": {
    "wpm": 118,
    "duration_ms": 4200
  },
  "words": [
    { "word": "Ich",   "accuracy": 96, "errorType": "None" },
    { "word": "habe",  "accuracy": 91, "errorType": "None" },
    { "word": "heute", "accuracy": 74, "errorType": "Mispronunciation" },
    { "word": "einen", "accuracy": 0,  "errorType": "Omitted" },
    { "word": "langen","accuracy": 83, "errorType": "None" },
    { "word": "Tag",   "accuracy": 88, "errorType": "None" },
    { "word": "gehabt.","accuracy": 71, "errorType": "Mispronunciation" }
  ],
  "recognized": "ich habe heute langen tag gehabt"
}
```

### Field notes (what the panel shows where)

| Field | Panel usage |
|-------|-------------|
| `overall` (or any of `overall_score`, `score`, `pronunciation_score`, `pronunciationAssessment.score`) | Big number on the score card + the score pill on the take chip. Saved **per take**. |
| `subscores.accuracy / fluency / prosody / completeness` (snake or camel, or flat `accuracy_score` … at top level) | The 2×2 sub-score grid. |
| `pace.wpm`, `pace.duration_ms` (also accepted flat: `wpm`, `duration_ms`) | The `⏱ words/min · seconds` line — the user asked to "analyze what speed he said". |
| `words[].word` + `words[].accuracy` (or `.score`) | Color-coded word chips: green ≥ 80, yellow ≥ 60, red below. |
| `recognized` | Not shown yet — useful for debugging your ASR. |

### What the sub-scores should mean

- **accuracy** — how close the pronounced words are to the reference (phoneme/word level).
- **fluency** — rhythm and smoothness, no long hesitations or false starts.
- **prosody** — intonation, stress, sentence melody.
- **completeness** — how much of the reference was actually said (missing words lower this).

### Error response

```json
{ "status": "ERROR", "error": "short human-readable reason" }
```

If the server is simply not running, the panel keeps the take and shows a
"score pending" note — nothing is lost, the user can press **Score** again.

## Server-side recipe (how to produce these scores)

1. **Decode** `audio_base64` → webm/opus bytes (ffmpeg handles both Chrome's
   webm and Firefox's ogg).
2. **ASR** the audio in the requested `language` — Azure Speech / Whisper
   (faster-whisper, whisper.cpp) / Vosk / Google STT all work. You need the
   transcript **with word timings** if you want real fluency/prosody.
3. **Align** the recognized words against `reference_text`
   (difflib/levenshtein on word lists → per-word accuracy + errorType:
   `None` / `Mispronunciation` / `Omitted` / `Inserted`).
4. **Sub-scores**: accuracy = mean of matched word accuracies;
   completeness = fraction of reference words spoken; fluency from pause
   ratio + speaking rate vs. expected (~150 wpm baseline); prosody from
   pitch-energy variance (or your engine's native score, e.g. Azure's
   prosodyScore).
5. **overall** = weighted mix, e.g.
   `0.45*accuracy + 0.2*fluency + 0.15*prosody + 0.2*completeness`.

A minimal runnable FastAPI implementation of steps 2–5 (with faster-whisper,
graceful stub if not installed) is in `example-server/server.py`:

```bash
pip install fastapi uvicorn
# optional, for real transcription:
pip install faster-whisper
uvicorn server:app --host 127.0.0.1 --port 8000
```

> Note: Firefox users must grant the extension
> *Access your data for 127.0.0.1* (Permissions tab of the extension) before
> the background can reach the server; Chrome grants it via the manifest.
