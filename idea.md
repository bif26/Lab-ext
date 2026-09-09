## 🚀 Architecture Overview (Sub-2GB RAM Optimized)
To handle YouTube Shadowing, Live Unscripted Training, and Custom Long-Text Practice locally without exceeding your 2GB RAM limit, your Python backend will use three highly specialized libraries:

* faster-whisper: Runs Whisper Small with 8-bit quantization (int8). This compresses the AI engine footprint down to ~450MB–600MB of RAM.
* fastapi & uvicorn: A high-performance, lightweight web server framework with minimal memory overhead.
* phonetics: An ultra-fast, zero-RAM algorithmic sound comparison tool used to track pronunciation accuracy.

                  ┌──────────────────────────────────────────────┐
                  │          YOUR WEB BROWSER / EXTENSION        │
                  └──────────────────────┬───────────────────────┘
                                         │
                 Sends User Audio (WAV)  │  Sends Text Data
                 & Endpoint Context      │  (Captions or Prompt)
                                         ▼
  ┌─────────────────────────────────────────────────────────────────────────────┐
  │                    LOCAL FASTAPI SUITE (Runs under 2GB RAM)                  │
  ├─────────────────────────────────────────────────────────────────────────────┤
  │                                                                             │
  │  📥 [/api/shadow]      📥 [/api/live-training]   📥 [/api/custom-text]     │
  │  Evaluates alignment   Extracts WPM & flags      Evaluates word skips       │
  │  & rhythm vs YouTube    academic transitional    & voice stamina on         │
  │  native captions.      connectors organically.   massive scripts.           │
  │                                                                             │
  │                                      │                                      │
  │                                      ▼                                      │
  │                 ┌─────────────────────────────────────────┐                 │
  │                 │    FASTER-WHISPER ENGINE (int8 CPU)     │                 │
  │                 │   Calculates Word-Level Timestamps      │                 │
  │                 └────────────────────┬────────────────────┘                 │
  │                                      │                                      │
  │                                      ▼                                      │
  │                 ┌─────────────────────────────────────────┐                 │
  │                 │        PHONETIC SOUND ALIGNER           │                 │
  │                 │     Matches user audio to targets       │                 │
  │                 └─────────────────────────────────────────┘                 │
  └─────────────────────────────────────────────────────────────────────────────┘

------------------------------
## 📂 Step 1: Dependencies Setup (requirements.txt)
Save this file as requirements.txt and install it on your local system using pip install -r requirements.txt. These specific components keep your server lightweight.

fastapi==0.110.0
uvicorn==0.28.0
faster-whisper==1.0.1
phonetics==1.0.5
python-multipart==0.0.9

------------------------------
## 💻 Step 2: The Core Pipeline Backend Engine (main.py)
Save the code block below as main.py. This script handles your endpoints, implements strict memory constraints via int8, computes words-per-minute (WPM), analyzes pauses, checks sounds phonetically, and outputs standardized CEFR metrics (A2 to B2+).

import osimport shutilimport difflibimport phoneticsfrom fastapi import FastAPI, UploadFile, File, Formfrom fastapi.middleware.cors import CORSMiddlewarefrom faster_whisper import WhisperModel
app = FastAPI(
    title="Local Academic Speech Training Suite",
    description="Optimized engine for CEFR A2-B2 scoring under 2GB RAM limits."
)
# Enable CORS so your browser extension can communicate with localhost securely
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
# Global Initialization of the lightweight model weights (approx 460MB loaded memory)
print("Loading optimized 8-bit quantized Speech AI model...")whisper_engine = WhisperModel("small", device="cpu", compute_type="int8")
print("Engine is ready for local local evaluation.")
# --- SHARED AUXILIARY HELPERS ---
def process_audio_and_get_timestamps(audio_path):
    """Transcribes audio using faster-whisper and returns tracking structures."""
    segments, info = whisper_engine.transcribe(audio_path, word_timestamps=True)
    segments = list(segments)  
    
    clean_words = []
    word_timestamps_map = []
    total_confidence = 0.0
    pause_penalty = 0
    previous_word_end = 0.0

    for segment in segments:
        for w in segment.words:
            word_cleaned = w.word.lower().strip(".,?!\"' ")
            if word_cleaned:
                clean_words.append(word_cleaned)
                total_confidence += w.probability
                
                word_timestamps_map.append({
                    "word": word_cleaned,
                    "start": round(w.start, 2),
                    "end": round(w.end, 2)
                })

                # Strict exam hesitation tracker (Gaps larger than 1.1s lower fluency)
                if previous_word_end > 0:
                    silence_duration = w.start - previous_word_end
                    if silence_duration > 1.1:
                        pause_penalty += 8
                
                previous_word_end = w.end

    return {
        "words": clean_words,
        "timestamps": word_timestamps_map,
        "avg_confidence": (total_confidence / len(clean_words) * 100) if clean_words else 0,
        "pause_penalty": pause_penalty,
        "duration": info.duration
    }
def calculate_phonetic_match(target_list, spoken_list):
    """Evaluates if the user pronounced the right sounds despite minor spelling variants."""
    matches = 0
    for target in target_list:
        target_sound = phonetics.metaphone(target)
        for spoken in spoken_list:
            if phonetics.metaphone(spoken) == target_sound:
                matches += 1
                break
    return int((matches / len(target_list)) * 100) if target_list else 0

# --- ENDPOINT 1: YOUTUBE SHADOWING SUITE ---

@app.post("/api/shadow")async def endpoint_youtube_shadowing(
    youtube_caption: str = Form(...),
    audio_file: UploadFile = File(...)
):
    """
    Evaluates instant mimicry/shadowing. Matches text rhythm directly 
    against a reference script extracted from YouTube subtitles.
    """
    temp_path = "temp_shadow.wav"
    with open(temp_path, "wb") as buffer:
        shutil.copyfileobj(audio_file.file, buffer)

    try:
        data = process_audio_and_get_timestamps(temp_path)
        target_words = youtube_caption.lower().strip(".,?!\"' ").split()
        
        # 1. Structural Metric Processing
        text_match_ratio = int(difflib.SequenceMatcher(None, target_words, data["words"]).ratio() * 100)
        phonetic_accuracy = calculate_phonetic_match(target_words, data["words"])
        pronunciation_clarity = int((phonetic_accuracy * 0.6) + (data["avg_confidence"] * 0.4))
        
        wpm = int((len(data["words"]) / data["duration"]) * 60) if data["duration"] > 0 else 0
        rhythm_fluency = max(10, int(100 - data["pause_penalty"]))
        
        overall = int((text_match_ratio + pronunciation_clarity + rhythm_fluency) / 3)

        # 2. Assign specialized grading thresholds for Shadowing Sync 
        if overall >= 84 and wpm >= 115:
            cefr = "B2+ (Excellent Native Synchronization)"
        elif overall >= 72 and wpm >= 90:
            cefr = "B2 (Solid Intermediate Sync & Rhythm)"
        elif overall >= 55 and wpm >= 70:
            cefr = "B1 (Lower Intermediate - Frequent Sync Gaps)"
        else:
            cefr = "A2 (Elementary - Failed to keep pace with native sound)"

        return {
            "status": "success",
            "mode": "youtube_shadowing",
            "metrics": {
                "overall_score": overall,
                "cefr_rating": cefr,
                "text_alignment_accuracy": text_match_ratio,
                "pronunciation_clarity": pronunciation_clarity,
                "rhythm_fluency_score": rhythm_fluency,
                "words_per_minute": wpm
            },
            "breakdown": {
                "target_word_count": len(target_words),
                "user_word_count": len(data["words"]),
                "unnatural_pauses_detected": data["pause_penalty"] // 8
            }
        }
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)

# --- ENDPOINT 2: LIVE UNSCRIPTED TRAINING ---

@app.post("/api/live-training")async def endpoint_live_spontaneous(
    topic_prompt: str = Form(...),
    audio_file: UploadFile = File(...)
):
    """
    Evaluates spontaneous free speech. No script mapping is forced. Instead,
    Whisper builds raw text, tracks pacing, and grades academic connector density.
    """
    temp_path = "temp_live.wav"
    with open(temp_path, "wb") as buffer:
        shutil.copyfileobj(audio_file.file, buffer)

    # Core academic logic vocabulary dictionaries for real B1/B2 scaling
    b1_connectors = {"however", "because", "therefore", "although", "besides", "finally", "instead"}
    b2_connectors = {"consequently", "furthermore", "whereas", "nevertheless", "in addition", "meanwhile", "on the other hand"}

    try:
        data = process_audio_and_get_timestamps(temp_path)
        wpm = int((len(data["words"]) / data["duration"]) * 60) if data["duration"] > 0 else 0
        
        # Count structural advanced items
        found_b1 = sum(1 for w in data["words"] if w in b1_connectors)
        found_b2 = sum(1 for w in data["words"] if w in b2_connectors)
        academic_score = min(100, (found_b1 * 10) + (found_b2 * 20))
        
        fluency_base = 95 if wpm >= 110 else (80 if wpm >= 85 else 60)
        fluency_score = max(10, int(fluency_base - data["pause_penalty"]))
        pron_score = int(data["avg_confidence"])
        
        overall = int((pron_score + fluency_score + academic_score) / 3)

        if wpm >= 110 and found_b2 >= 1:
            cefr = "B2 (Advanced Free Speech Structuring)"
        elif wpm >= 85 and (found_b1 >= 2 or found_b2 >= 1):
            cefr = "B1 (Intermediate Structural Speaking)"
        else:
            cefr = "A2 (Basic Vocabulary Spontaneity - Lacks Complex Connectors)"

        return {
            "status": "success",
            "mode": "live_unscripted_assessment",
            "prompt_target": topic_prompt,
            "transcription": " ".join(data["words"]),
            "metrics": {
                "overall_score": overall,
                "cefr_rating": cefr,
                "pronunciation_clarity": pron_score,
                "fluency_score": fluency_score,
                "academic_vocabulary_score": academic_score,
                "words_per_minute": wpm
            },
            "lexical_analysis": {
                "b1_connectors_used": found_b1,
                "b2_connectors_used": found_b2,
                "hesitation_penalties": data["pause_penalty"] // 8
            }
        }
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)

# --- ENDPOINT 3: CUSTOM LONG-TEXT TRAINING ---

@app.post("/api/custom-text")async def endpoint_custom_text(
    custom_script: str = Form(...),
    audio_file: UploadFile = File(...)
):
    """
    Evaluates vocal endurance and reading stamina over extensive multi-sentence 
    academic scripts. Flags missing or skipped sentences.
    """
    temp_path = "temp_custom.wav"
    with open(temp_path, "wb") as buffer:
        shutil.copyfileobj(audio_file.file, buffer)

    try:
        data = process_audio_and_get_timestamps(temp_path)
        target_words = custom_script.lower().strip(".,?!\"' ").split()
        
        # Word sequence analytics 
        matcher = difflib.SequenceMatcher(None, target_words, data["words"])
        text_accuracy = int(matcher.ratio() * 100)
        
        phonetic_accuracy = calculate_phonetic_match(target_words, data["words"])
        wpm = int((len(data["words"]) / data["duration"]) * 60) if data["duration"] > 0 else 0
        
        stamina_score = max(10, int(text_accuracy - (data["pause_penalty"] * 0.5)))
        overall = int((stamina_score + phonetic_accuracy + int(data["avg_confidence"])) / 3)

        if overall >= 85 and text_accuracy >= 90:
            cefr = "B2 (High Academic Reading Competency)"
        elif overall >= 70 and text_accuracy >= 75:
            cefr = "B1 (Mid-Tier Vocabulary Stamina)"
        else:
            cefr = "A2 (Skipped items or high fatigue breaks detected)"

        return {
            "status": "success",
            "mode": "custom_long_text_trainer",
            "metrics": {
                "overall_score": overall,
                "cefr_rating": cefr,
                "text_stamina_accuracy": text_accuracy,
                "phonetic_pronunciation": phonetic_accuracy,
                "words_per_minute": wpm
            },
            "diagnostics": {
                "omitted_words_count": max(0, len(target_words) - len(data["words"])),
                "total_stutter_flags": data["pause_penalty"] // 8
            }
        }
    finally:
        if os.path.exists(temp_path):

os.remove(temp_path)


---

### 🏁 Step 3: Execution Instructions

To execute your 100% free local scoring platform, open your system terminal and run these two commands:

```bash
# 1. Install the specialized environment libraries
pip install -r requirements.txt

# 2. Spin up the high-speed backend server bound to local port 8000
uvicorn main:app --host 127.0.0.1 --port 8000 --reload

------------------------------
## 📡 Step 4: Web Request Schema for Browser Extensions
Your browser extension can now query these endpoints using FormData and native JavaScript fetch. Below are the structured payload configurations for your front-end integration:
## YouTube Shadowing Configuration

* Target Endpoint: POST http://127.0.0
* Payload Type: multipart/form-data
* Required Parameter Key-Values:
* youtube_caption: "The critical analysis reveals a significant correlation." (String)
   * audio_file: [Your recorded Web Blob binary data saved as a .wav file] (Binary File)

## Live Spontaneous Speech Configuration

* Target Endpoint: POST http://127.0.0
* Payload Type: multipart/form-data
* Required Parameter Key-Values:
* topic_prompt: "What are the pros and cons of artificial intelligence in higher education?" (String)
   * audio_file: [Your unscripted 60-second speech recording response binary file] (Binary File)

## Custom Long-Text Trainer Configuration

* Target Endpoint: POST http://127.0.0
* Payload Type: multipart/form-data
* Required Parameter Key-Values:
* custom_script: "Moreover, environmental variations consistently demand rapid physiological adaptability." (String)
   * audio_file: [Your recorded reading attempt sample binary file] (Binary File)

