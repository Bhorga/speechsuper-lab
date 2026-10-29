"""Local SpeechSuper assessment workbench. Run: uvicorn app:app --reload"""
import asyncio
import hashlib
import json
import os
import shutil
import tempfile
import time
import uuid
import wave
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / '.env')
app = FastAPI(title='Lernn SpeechSuper Lab', version='1.0.0')
app.mount('/static', StaticFiles(directory=ROOT / 'static'), name='static')
LIMITS = {'word.eval.promax': 20, 'sent.eval.promax': 90, 'para.eval': 180, 'asr.eval': 290}
COMMON = {'dict_type', 'scale', 'precision', 'slack', 'dict_dialect', 'agegroup', 'accent_dialect'}
SCRIPTED = {'getParam', 'customized_pron', 'customized_lexicon'}
ALLOWED = {
    'word.eval.promax': COMMON | SCRIPTED | {'phoneme_output', 'detect_phonemewise_read'},
    'sent.eval.promax': COMMON | SCRIPTED | {'phoneme_output', 'output_rawtext', 'readtype_diagnosis', 'sentence_need_word_intonation'},
    'para.eval': COMMON | SCRIPTED | {'output_rawtext', 'paragraph_need_word_score'},
    'asr.eval': COMMON | {'model', 'allow_filler'},
}
MAX_UPLOAD = 50 * 1024 * 1024
slots = asyncio.Semaphore(2)


def validate_request(core, ref, settings):
    if core not in LIMITS:
        raise ValueError('Unsupported coreType')
    if not isinstance(settings, dict):
        raise ValueError('Settings must be a JSON object')
    unknown = settings.keys() - ALLOWED[core]
    if unknown:
        raise ValueError('Unsupported settings for this API: ' + ', '.join(sorted(unknown)))
    ref = ref.strip()
    if core != 'asr.eval':
        if not ref:
            raise ValueError('Reference text is required')
        count = len(ref.split())
        maximum = {'word.eval.promax': 1, 'sent.eval.promax': 200, 'para.eval': 1000}[core]
        if count > maximum:
            raise ValueError(f'This API accepts at most {maximum} reference words')
    for key, low, high in [('scale', 0, 100), ('precision', 0, 1), ('slack', -1, 1)]:
        if key in settings:
            value = settings[key]
            if isinstance(value, bool) or not isinstance(value, (float, int)) or not low <= value <= high or (key != 'slack' and value == 0):
                raise ValueError(f'Invalid {key}')
    enums = {'dict_type': ['IPA88', 'KK', 'CMU'], 'dict_dialect': ['en_br', 'en_us'], 'agegroup': [1, 2, 3], 'model': ['native', 'non_native'], 'accent_dialect': ['indian'] if core == 'asr.eval' else ['indian', 'australian', 'new_zealand']}
    for k, allowed in enums.items():
        if k in settings and settings[k] not in allowed:
            raise ValueError(f'Invalid {k}')
    flags = {'getParam','phoneme_output','detect_phonemewise_read','output_rawtext','readtype_diagnosis','sentence_need_word_intonation','paragraph_need_word_score'}
    for k in flags & settings.keys():
        if type(settings[k]) is not int or settings[k] not in (0, 1):
            raise ValueError(f'{k} must be 0 or 1')
    if 'allow_filler' in settings and str(settings['allow_filler']) not in ('0','1'):
        raise ValueError('allow_filler must be 0 or 1')
    for k in ('customized_pron','customized_lexicon'):
        if k in settings and not isinstance(settings[k], dict):
            raise ValueError(k + ' must be an object')
    request = {'coreType': core, **settings, 'tokenId': uuid.uuid4().hex}
    if core != 'asr.eval':
        request['refText'] = ref
    return request


def envelope(request, app_key, secret, timestamp=None):
    timestamp = str(timestamp if timestamp is not None else int(time.time()))
    user = 'lernn-lab'
    def sig(s):
        return hashlib.sha1(s.encode()).hexdigest()
    return {
        'connect': {'cmd': 'connect', 'param': {
            'sdk': {'version': 16777472, 'source': 9, 'protocol': 2},
            'app': {'applicationId': app_key, 'timestamp': timestamp, 'sig': sig(app_key + timestamp + secret)}}},
        'start': {'cmd': 'start', 'param': {
            'app': {'applicationId': app_key, 'timestamp': timestamp, 'userId': user, 'sig': sig(app_key + timestamp + user + secret)},
            'audio': {'audioType': 'wav', 'channel': 1, 'sampleBytes': 2, 'sampleRate': 16000},
            'request': request}},
    }


def redact(value):
    if isinstance(value, dict):
        return {k: '[REDACTED]' if k.lower() in {'sig', 'applicationid', 'appkey', 'secretkey', 'secret'} else redact(v) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v) for v in value]
    return value


async def convert_audio(source, target, limit):
    # Decode only slightly beyond the limit: overlong clips are rejected, never silently truncated.
    proc = await asyncio.create_subprocess_exec(
        'ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-protocol_whitelist', 'file,pipe', '-i', str(source), '-t', str(limit + 1),
        '-vn', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', '16000', str(target),
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
    try:
        _, err = await asyncio.wait_for(proc.communicate(), 45)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        proc.kill()
        await proc.communicate()
        raise
    if proc.returncode:
        raise ValueError('Could not decode this recording. Upload a valid audio/video file.')
    with wave.open(str(target), 'rb') as wav:
        duration = wav.getnframes() / wav.getframerate()
    if duration > limit:
        raise ValueError(f'Audio exceeds the {limit}-second limit. Record a shorter clip.')
    if duration < 0.15:
        raise ValueError('Recording is too short')
    return duration


async def call_vendor(request, wav):
    payload = envelope(request, os.environ['SPEECHSUPER_APP_KEY'], os.environ['SPEECHSUPER_SECRET_KEY'])
    started = time.perf_counter()
    async with httpx.AsyncClient(timeout=httpx.Timeout(180, connect=15), follow_redirects=False) as client:
        with open(wav, 'rb') as audio:
            response = await client.post('https://api.speechsuper.com/' + request['coreType'],
                data={'text': json.dumps(payload)}, files={'audio': ('audio.wav', audio, 'audio/wav')},
                headers={'Request-Index': '0'})
    elapsed = round((time.perf_counter() - started) * 1000)
    try:
        data = response.json()
    except ValueError:
        raise HTTPException(502, 'SpeechSuper returned a non-JSON response')
    if not response.is_success:
        raise HTTPException(502, {'message': 'SpeechSuper HTTP error', 'vendor_status': response.status_code, 'response': redact(data)})
    return redact(data), elapsed


@app.get('/')
async def index():
    return FileResponse(ROOT / 'static/index.html')


@app.get('/api/health')
async def health():
    return {'credentials_configured': bool(os.getenv('SPEECHSUPER_APP_KEY') and os.getenv('SPEECHSUPER_SECRET_KEY')), 'ffmpeg_available': bool(shutil.which('ffmpeg')), 'limits': LIMITS}


@app.post('/api/evaluate')
async def evaluate(audio: UploadFile = File(...), core_type: str = Form(...), ref_text: str = Form(''), settings: str = Form('{}')):
    start = time.perf_counter()
    try:
        request = validate_request(core_type, ref_text, json.loads(settings))
    except (ValueError, TypeError) as exc:
        raise HTTPException(422, str(exc))
    if not os.getenv('SPEECHSUPER_APP_KEY') or not os.getenv('SPEECHSUPER_SECRET_KEY'):
        raise HTTPException(503, 'Add both SpeechSuper keys to .env and restart the server')
    if not shutil.which('ffmpeg'):
        raise HTTPException(503, 'Install FFmpeg and restart the server')
    async with slots:
        try:
            with tempfile.TemporaryDirectory(prefix='lernn-speech-') as temp:
                source, target = Path(temp) / 'input', Path(temp) / 'audio.wav'
                size = 0
                with open(source, 'wb') as out:
                    while chunk := await audio.read(1024 * 1024):
                        size += len(chunk)
                        if size > MAX_UPLOAD:
                            raise HTTPException(413, 'Maximum upload size is 50 MiB')
                        out.write(chunk)
                conversion_start = time.perf_counter()
                duration = await convert_audio(source, target, LIMITS[core_type])
                conversion_ms = round((time.perf_counter() - conversion_start) * 1000)
                response, vendor_ms = await call_vendor(request, target)
                return {'request': request, 'audio': {'duration_seconds': round(duration, 3), 'sample_rate': 16000, 'channels': 1, 'bits_per_sample': 16, 'bitrate_kbps': 256},
                    'timing': {'normalization_ms': conversion_ms, 'vendor_ms': vendor_ms, 'backend_ms': round((time.perf_counter() - start) * 1000)}, 'response': response}
        except ValueError as exc:
            raise HTTPException(422, str(exc))
        except asyncio.TimeoutError:
            raise HTTPException(504, 'Audio conversion timed out')
        except httpx.TimeoutException:
            raise HTTPException(504, 'SpeechSuper timed out. No automatic retry was made; a request may have been charged.')
        except httpx.RequestError:
            raise HTTPException(502, 'Could not reach SpeechSuper. Check network access. No automatic retry was made.')
        finally:
            await audio.close()
