# Lernn SpeechSuper Lab

A local interactive UI and FastAPI backend for testing SpeechSuper pronunciation assessment. No frontend build or Node installation is required. Keys belong only in your backend `.env` file; never paste them into the UI or commit them.

## Quick start (macOS / Linux)

Requires Python 3.10+ and FFmpeg. On macOS install FFmpeg with `brew install ffmpeg`; on Ubuntu/Debian use `sudo apt-get install ffmpeg`.

```bash
cd speechsuper-lab
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Edit `.env` locally:

```dotenv
SPEECHSUPER_APP_KEY=YOUR_APP_KEY
SPEECHSUPER_SECRET_KEY=YOUR_SECRET_KEY
```

Start the app:

```bash
uvicorn app:app --host 127.0.0.1 --port 8000 --reload
```

Open **http://localhost:8000**. Interactive backend API docs: **http://localhost:8000/docs**. Restart the server after changing keys. Opening `index.html` directly is not supported.

Windows: install FFmpeg and add it to PATH, use `py -m venv .venv`, activate with `.venv\Scripts\Activate.ps1`, copy `.env.example` to `.env`, then run the same pip and uvicorn commands.

### Docker alternative

Install Docker Desktop, copy `.env.example` to `.env`, fill in your keys, then:

```bash
docker compose up --build
```

Open http://localhost:8000. Docker includes FFmpeg. The port is bound to localhost. This is a local developer tester, without authentication or public-hosting hardening.

## What you can test

| Mode | coreType | Enforced audio limit | Important settings |
|---|---|---|---|
| Word | `word.eval.promax` | 20 s | `phoneme_output`, `detect_phonemewise_read` |
| Sentence | `sent.eval.promax` | 90 s | `phoneme_output`, `readtype_diagnosis`, `sentence_need_word_intonation` |
| Paragraph | `para.eval` | 180 s | `paragraph_need_word_score: 1` enabled by default |
| Free speech | `asr.eval` | 290 s | `model: non_native` enabled by default, optional fillers |

Scripted reference limits: one word (or phoneme sequence), 200 sentence words, 1,000 paragraph words. Limits use whitespace token counts as a local guard; the provider has final authority over tokenization. The recorder stops slightly before the audio limit; uploads that exceed it are rejected, not silently shortened. Files can be at most 50 MiB.

All input is decoded with FFmpeg into **16-bit PCM WAV, mono, 16,000 Hz (256 kbps)**. Browser recordings often use WebM/Opus or MP4/AAC: the backend decodes those too, then submits supported WAV to SpeechSuper. It never relies on the original extension. The conversion is equivalent to:

```bash
ffmpeg -i input.mp3 -acodec pcm_s16le -ac 1 -ar 16000 output.wav
```

Temporary audio is deleted after each request. Original audio remains in browser memory while the page is open. Each Evaluate action makes one potentially billable request; there are no automatic retries. The backend allows two concurrent evaluations per process. No batch of paid requests runs automatically.

## Suggested monkey experiment

1. Choose Word, reference `monkey`, IPA88, age group appropriate for the speaker, and slack `0`.
2. Record a correct pronunciation. Set a descriptive label and human judgment to Correct.
3. Evaluate. Inspect each phoneme's expected sound, score, `sound_like`, substitution/omission markers, and the syllable stress information.
4. Keep the same recording and change slack to `-0.2`, or change accent adaptation/reference accent, then evaluate again. This is another paid request.
5. Record a deliberate long /uː/ vowel in place of /ʌ/, and label it Needs correction. Repeat the settings comparison.
6. Include missing consonants, repetitions, silence, background noise and correctly pronounced words from different children.
7. Use Pass / retry policy to adjust thresholds without another API call. Relabel session rows if necessary. Export JSON or CSV before refreshing.

`monkey` uses /ʌ/ as in cup. The spelling approximation “munkey” can describe a correct vowel; use a human listener to label the actual sound. Indian accent adaptation is not a strictness control. Negative slack systematically adjusts scores and is not evidence of better phoneme discrimination.

The initial application thresholds are experimental: overall 80%, phoneme 70%. With focus `ʌ`, only that sound is checked at the phoneme stage. Blank focus checks every sound. Use the exact returned phoneme symbol; IPA88/KK/CMU use different symbols. Missing focus or missing required phonemes produces Review. Detected omission/substitution of a checked phoneme triggers Retry even if the overall score is high. Vendor warnings produce Review. Word omissions trigger Retry. Insertion/repetition details are displayed, but are not automatically penalized by this simple policy. Unscripted mode always produces Review: it cannot verify an intended word without a reference.

Paragraph responses use `result.sentences[].details[]` for word scores. They do not document phoneme scores, so the UI disables the phoneme requirement by default when switching to Paragraph. Read policy reasons before interpreting a Pass; it can be based on overall alone. Sentence and word modes enable the phoneme requirement by default. A pass is your application rule, not an independent guarantee of perfect pronunciation.

History is in memory only. Export includes full sanitized provider responses, request settings, human labels, timing and the current policy; it excludes audio and credentials. False-pass/rejection counts include only labeled runs whose application decision is Pass or Retry. Review runs are excluded. Settings, thresholds, and student feedback should be calibrated against teacher-reviewed examples.

## API contract

### `GET /api/health`
Returns credential-presence and FFmpeg status (no secret values), plus limits.

### `POST /api/evaluate`
Multipart fields:

- `audio`: audio/video file
- `core_type`: one of the four API identifiers above
- `ref_text`: required for scripted APIs; omitted upstream for free speech
- `settings`: JSON object of API-specific parameters

Word example:

```bash
curl -X POST http://localhost:8000/api/evaluate \
  -F 'audio=@monkey.wav' \
  -F 'core_type=word.eval.promax' \
  -F 'ref_text=monkey' \
  -F 'settings={"phoneme_output":1,"dict_type":"IPA88","agegroup":2,"slack":0,"scale":100,"precision":1,"accent_dialect":"indian"}'
```

Free speech example:

```bash
curl -X POST http://localhost:8000/api/evaluate \
  -F 'audio=@speech.wav' \
  -F 'core_type=asr.eval' \
  -F 'settings={"model":"non_native","allow_filler":"1"}'
```

Successful transport returns `request`, `audio`, `timing`, and `response`. Inspect `response.result` and vendor error fields: a vendor error can arrive in an HTTP 200 response. Invalid settings/audio return 422; oversized uploads 413; missing keys/FFmpeg 503; upstream transport errors 502; timeouts 504. Timeout messages do not imply that a provider charge was avoided.

The backend sends a multipart POST to `https://api.speechsuper.com/{coreType}` with `text` (connect/start JSON) and `audio`. Authentication follows the official Python HTTP sample:

- connect signature: SHA1(appKey + timestamp + secretKey)
- start signature: SHA1(appKey + timestamp + userId + secretKey)
- request header: `Request-Index: 0`

Provider-returned signature/application-ID fields are redacted before sending results to the browser. Keys are never accepted from browser inputs.

## Advanced settings

The Advanced JSON object overrides UI settings, not `coreType`, `refText`, authentication, or audio metadata. The backend rejects unsupported keys for the selected API. `customized_pron` and `customized_lexicon` are supported for scripted modes, for example:

```json
{"customized_pron":{"type":"IPA88","pron":{"lot":["lɑːt","lɒt"]}}}
```

Validate custom pronunciations with a teacher. Do not add an incorrect sound to the accepted list. Only use one custom pronunciation representation per experiment.

`phoneme_diagnosis` is intentionally excluded: the word documentation refers to it in a response description but does not list it as a request parameter. Confirm support with SpeechSuper before adding it to `ALLOWED` in app.py. Existing documented phoneme fields provide substitution diagnostics.

This tester uses **completed HTTP uploads**, not WebSocket streaming. Streaming-only `realtime_feedback` is excluded. Word/phoneme Replay uses vendor spans in 10 ms units and the matching original browser recording; it is disabled when a different clip is loaded. Converter/codec timing can make segment boundaries approximate. Full clip playback remains available.

Timing distinguishes backend normalization, SpeechSuper HTTP round trip, and browser round trip. API time includes upload/network overhead; it is not an isolated model inference benchmark. The test does not measure streaming latency.

## Validation

```bash
pip install pytest
python -m pytest -q
# Optional Node installation is needed only for these pure frontend logic checks:
node tests/test_logic.cjs
```

Offline checks cover actual FFmpeg normalization, overlong/corrupt audio, all four modes, authentication signatures, multipart shape, response redaction, missing credentials, per-mode parameter rejection, and policy handling of substitutions, scaling, missing phonemes, warnings and paragraph nesting. Vendor calls are mocked in tests. No real credentials were supplied during creation, so live authentication, account access, pronunciation quality, and latency must be validated with your keys. Browser interaction was not verified because the managed preview runtime could not start the Python environment.

## Sources

- Word: https://docs.speechsuper.com/#/./Languages/English/word.eval.promax
- Sentence: https://docs.speechsuper.com/#/./Languages/English/sent.eval.promax
- Paragraph: https://docs.speechsuper.com/#/./Languages/English/para.eval
- Unscripted: https://docs.speechsuper.com/#/./Languages/English/asr.eval
- Official authentication/transport example: https://github.com/speechsuper/SpeechSuper-API-Samples/blob/main/http_samples/python_http_sample/sample.py

The four documentation Markdown sources were retrieved directly from `https://docs.speechsuper.com/Languages/English/{coreType}.md` while building this app on 29 October 2026.
