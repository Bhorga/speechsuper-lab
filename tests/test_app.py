import asyncio
import hashlib
import io
import json
import struct
import wave
from pathlib import Path
from unittest.mock import patch
import httpx
import pytest
from fastapi.testclient import TestClient
import app as lab


def wav_bytes(seconds=0.5, channels=2, rate=44100):
    out=io.BytesIO()
    with wave.open(out,'wb') as w:
        w.setnchannels(channels); w.setsampwidth(2); w.setframerate(rate)
        w.writeframes(struct.pack('<h', 500) * int(rate*seconds)*channels)
    return out.getvalue()


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv('SPEECHSUPER_APP_KEY','test-app')
    monkeypatch.setenv('SPEECHSUPER_SECRET_KEY','test-secret')
    return TestClient(lab.app)


def test_signatures_match_official_sample():
    p=lab.envelope({'coreType':'word.eval.promax'},'app','secret',123)
    assert p['connect']['param']['app']['sig']==hashlib.sha1(b'app123secret').hexdigest()
    assert p['start']['param']['app']['sig']==hashlib.sha1(b'app123lernn-labsecret').hexdigest()


@pytest.mark.parametrize('core', lab.LIMITS)
def test_all_modes_normalize_and_forward(client, monkeypatch, core):
    async def vendor(request,path):
        with wave.open(str(path)) as w:
            assert w.getnchannels()==1 and w.getframerate()==16000 and w.getsampwidth()==2
        assert request['coreType']==core
        assert ('refText' in request)==(core!='asr.eval')
        return {'eof':1,'result':{'overall':88}}, 20
    monkeypatch.setattr(lab,'call_vendor',vendor)
    r=client.post('/api/evaluate',data={'core_type':core,'ref_text':'monkey','settings':'{}'},files={'audio':('test.wav',wav_bytes(),'audio/wav')})
    assert r.status_code==200, r.text
    assert r.json()['audio']['duration_seconds']==0.5
    assert r.json()['timing']['vendor_ms']==20


@pytest.mark.parametrize('core,settings',[('asr.eval',{'phoneme_output':1}),('para.eval',{'model':'non_native'}),('word.eval.promax',{'coreType':'asr.eval'}),('word.eval.promax',{'slack':-2}),('sent.eval.promax',{'agegroup':4})])
def test_reject_invalid_settings_before_vendor(client,core,settings):
    r=client.post('/api/evaluate',data={'core_type':core,'ref_text':'monkey','settings':json.dumps(settings)},files={'audio':('a.wav',b'x')})
    assert r.status_code==422


def test_missing_keys(client,monkeypatch):
    monkeypatch.delenv('SPEECHSUPER_SECRET_KEY')
    r=client.post('/api/evaluate',data={'core_type':'word.eval.promax','ref_text':'monkey'},files={'audio':('a.wav',b'x')})
    assert r.status_code==503


def test_bad_audio(client):
    r=client.post('/api/evaluate',data={'core_type':'word.eval.promax','ref_text':'monkey'},files={'audio':('a.wav',b'not audio')})
    assert r.status_code==422


def test_overlong_clip_rejected(tmp_path):
    src=tmp_path/'input.wav';src.write_bytes(wav_bytes(21,1,16000))
    with pytest.raises(ValueError,match='20-second'):
        asyncio.run(lab.convert_audio(src,tmp_path/'out.wav',20))


def test_vendor_multipart_and_redaction(tmp_path, monkeypatch):
    monkeypatch.setenv('SPEECHSUPER_APP_KEY','app');monkeypatch.setenv('SPEECHSUPER_SECRET_KEY','secret')
    path=tmp_path/'a.wav';path.write_bytes(wav_bytes())
    def respond(request):
        assert str(request.url)=='https://api.speechsuper.com/word.eval.promax'
        assert request.headers['Request-Index']=='0'
        body=request.read()
        assert b'name="text"' in body and b'name="audio"' in body
        assert b'"connect"' in body and b'"start"' in body
        return httpx.Response(200,json={'eof':1,'applicationId':'app','params':{'app':{'sig':'sensitive'}},'result':{'overall':90}})
    original=httpx.AsyncClient
    def make_client(**kwargs): return original(transport=httpx.MockTransport(respond),**kwargs)
    with patch.object(lab.httpx,'AsyncClient',make_client):
        data,_=asyncio.run(lab.call_vendor({'coreType':'word.eval.promax'},path))
    assert data['applicationId']=='[REDACTED]'
    assert data['params']['app']['sig']=='[REDACTED]'


def test_paragraph_and_asr_parameters():
    assert lab.validate_request('para.eval','A monkey ate.',{'paragraph_need_word_score':1})['paragraph_need_word_score']==1
    assert 'refText' not in lab.validate_request('asr.eval','ignored',{'model':'non_native'})


def test_static_ui_and_health(client):
    assert client.get('/').status_code==200
    assert client.get('/static/app.js').status_code==200
    assert client.get('/api/health').json()['ffmpeg_available']
