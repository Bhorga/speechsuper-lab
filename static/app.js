'use strict';
const $=id=>document.getElementById(id), L=LabLogic;
const configs={
 'word.eval.promax':{limit:20,examples:['monkey','ship','sheep','think'],help:'One word or phoneme sequence. Inspect individual sounds, substitutions and stress.',flags:[['phoneme_output','Return phoneme scores',1],['detect_phonemewise_read','Detect separated phonemes',0],['getParam','Echo request parameters',1]]},
 'sent.eval.promax':{limit:90,examples:['The monkey is eating a banana.','I eat poha and drink milk.'],help:'Up to 200 reference words. Inspect pronunciation, fluency, completeness, rhythm and word details.',flags:[['phoneme_output','Return phoneme scores',1],['readtype_diagnosis','Detect skipped / repeated words',1],['sentence_need_word_intonation','Return word intonation',0],['output_rawtext','Return reference text',1],['getParam','Echo request parameters',1]]},
 'para.eval':{limit:180,examples:['A little monkey lived in a tall tree. Every morning, it looked for sweet bananas. One day, it shared its breakfast with a hungry bird.'],help:'Up to 1,000 reference words. Word scores appear inside sentences → details. This API does not document phoneme scores.',flags:[['paragraph_need_word_score','Return word scores',1],['output_rawtext','Return reference text',1],['getParam','Echo request parameters',1]]},
 'asr.eval':{limit:290,examples:[],help:'Speak freely. No reference text is sent. Transcription and pronunciation scores cannot prove that a prompted word was said correctly.',flags:[]}
};
let core='word.eval.promax',blob=null,blobUrl=null,recorder=null,stream=null,chunks=[],clock=null,startTime=0,busy=false,current=null,history=[],requestingMic=false,segmentEnd=null;
const labels={0:'Normal',1:'Insertion before',2:'Insertion after',3:'Omitted',4:'Repeated',6:'Substitution'};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=n=>typeof n==='number'?Math.round(n*100)/100:'—';
const time=s=>`${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;
function status(s,error=false){$('status').textContent=s;$('status').style.color=error?'#a23f2d':'';}
function requestSettings(){
 const settings={};for(const k of ['agegroup','dict_dialect','accent_dialect','dict_type','slack','scale','precision']){
  const value=$(k).value;if(value!=='')settings[k]=['agegroup','slack','scale','precision'].includes(k)?Number(value):value;
 }
 for(const [key] of configs[core].flags)settings[key]=$(key).checked?1:0;
 if(core==='asr.eval'){settings.model=$('model').value;settings.allow_filler=$('allow_filler').value;}
 const extra=JSON.parse($('advanced').value);if(!extra||Array.isArray(extra)||typeof extra!=='object')throw Error('Advanced JSON must be an object.');
 return {...settings,...extra};
}
function preview(){try{$('requestPreview').textContent=JSON.stringify({coreType:core,...(core==='asr.eval'?{}:{refText:$('reference').value}),...requestSettings()},null,2);}catch(e){$('requestPreview').textContent=e.message;}}
function refreshButtons(){const recording=recorder?.state==='recording';$('record').disabled=busy||recording||requestingMic;$('stop').disabled=!recording;$('evaluate').disabled=busy||recording||requestingMic||!blob;$('upload').disabled=busy||recording||requestingMic;document.querySelectorAll('#modes button').forEach(b=>b.disabled=busy||recording||requestingMic);}
function mode(next){
 core=next;document.querySelectorAll('#modes button').forEach(b=>b.classList.toggle('active',b.dataset.core===core));
 $('coreLabel').textContent=core;$('modeHelp').textContent=configs[core].help;$('referenceLabel').hidden=core==='asr.eval';
 $('reference').value=configs[core].examples[0]||'';$('advanced').value='{}';
 $('specific').innerHTML=configs[core].flags.map(([k,label,v])=>`<label class="check"><input type="checkbox" id="${k}" ${v?'checked':''}>${label}</label>`).join('');
 if(core==='asr.eval')$('specific').innerHTML='<div class="grid"><label>Recognition model<select id="model"><option value="non_native">Non-native speakers</option><option value="native">Native speakers</option></select></label><label>Transcribe fillers<select id="allow_filler"><option value="1">Include</option><option value="0">Exclude</option></select></label></div>';
 for(const option of $('accent_dialect').options)option.disabled=core==='asr.eval'&&!['','indian'].includes(option.value);
 if($('accent_dialect').selectedOptions[0].disabled)$('accent_dialect').value='indian';
 $('examples').innerHTML=configs[core].examples.map(t=>`<button type="button">${esc(t.length>45?t.slice(0,42)+'…':t)}</button>`).join('');
 [...$('examples').children].forEach((b,i)=>b.onclick=()=>{$('reference').value=configs[core].examples[i];preview();});
 $('focus').value=core==='word.eval.promax'?'ʌ':'';$('requirePhones').checked=['word.eval.promax','sent.eval.promax'].includes(core);
 $('timer').textContent=`0:00 / ${time(configs[core].limit)}`;preview();if(current)render(current);renderHistory();
}
function setBlob(value,name){blob=value;if(blobUrl)URL.revokeObjectURL(blobUrl);blobUrl=URL.createObjectURL(blob);$('player').src=blobUrl;$('player').hidden=false;segmentEnd=null;$('recordLabel').textContent=name;$('timer').textContent=`Ready · limit ${time(configs[core].limit)}`;refreshButtons();if(current)render(current);status('Recording ready. Change settings and evaluate as often as needed.');}
function release(){stream?.getTracks().forEach(t=>t.stop());stream=null;clearInterval(clock);document.querySelector('.capture').classList.remove('recording');}
$('record').onclick=async()=>{
 if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){status('Microphone recording requires a supported browser on localhost or HTTPS. You can upload a file instead.',true);return;}
 requestingMic=true;refreshButtons();
 try{
  $('player').pause();stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:false,noiseSuppression:false,autoGainControl:false}});
  const mime=['audio/webm;codecs=opus','audio/ogg;codecs=opus','audio/mp4'].find(t=>MediaRecorder.isTypeSupported(t));
  recorder=new MediaRecorder(stream,mime?{mimeType:mime}:undefined);chunks=[];
  recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
  recorder.onstop=()=>{const type=recorder.mimeType;release();setBlob(new Blob(chunks,{type}),'Microphone recording');};
  recorder.onerror=()=>{release();status('Recording failed. Please try again.',true);refreshButtons();};
  recorder.start(250);startTime=performance.now();document.querySelector('.capture').classList.add('recording');$('recordLabel').textContent='Recording…';
  // Leave a small margin for codec/container timing around the hard vendor limit.
  clock=setInterval(()=>{const seconds=(performance.now()-startTime)/1000;$('timer').textContent=`${time(seconds)} / ${time(configs[core].limit)}`;if(seconds>=configs[core].limit-0.6&&recorder.state==='recording')recorder.stop();},100);
  status('Speak naturally, then press Stop.');
 }catch(e){release();status('Could not start microphone: '+e.message,true);}finally{requestingMic=false;refreshButtons();}
};
$('stop').onclick=()=>{if(recorder?.state==='recording')recorder.stop();};
$('upload').onchange=e=>{const f=e.target.files[0];if(!f)return;if(f.size>50*1024*1024){status('Maximum file size is 50 MiB.',true);return;}setBlob(f,f.name);};
function policy(){return {overall:Number($('overallThreshold').value),phone:Number($('phoneThreshold').value),focus:$('focus').value.trim(),require:$('requirePhones').checked};}
function playSegment(span){if(!blobUrl||!span)return;const start=Number(span.start)/100,end=Number(span.end)/100;if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)return;segmentEnd=end;$('player').currentTime=start;$('player').play().catch(()=>status('Use the audio player to replay this recording.',true));}
$('player').ontimeupdate=()=>{if(segmentEnd!==null&&$('player').currentTime>=segmentEnd){$('player').pause();segmentEnd=null;}};
function render(run){
 current=run;$('empty').hidden=true;$('results').hidden=false;const r=run.response?.result||{},scale=run.request.scale||100;
 $('metrics').innerHTML=['overall','pronunciation','fluency','integrity','rhythm','stress','speed'].filter(k=>typeof r[k]==='number').map(k=>`<div class="metric"><strong>${fmt(r[k])}</strong><span>${k==='integrity'?'Completeness':k}${k==='speed'?' · wpm':k==='stress'?' · 0/100':` / ${scale}`}</span></div>`).join('');
 const warnings=r.warning||[];$('warnings').innerHTML=warnings.map(w=>`<div class="warning">${esc(w.code)} · ${esc(w.message)}</div>`).join('');
 if(!run.response.result||run.response.error||run.response.errId||run.response.errorId)$('warnings').innerHTML+='<div class="warning">Vendor did not return a valid assessment. Inspect Full JSON for the error.</div>';
 $('transcript').innerHTML=r.recognition?`<p><b>Transcription</b><br>${esc(r.recognition)}</p>`:'';
 $('timing').textContent=`Audio ${run.audio.duration_seconds}s · normalization ${run.timing.normalization_ms}ms · SpeechSuper ${run.timing.vendor_ms}ms · browser round trip ${run.client_ms}ms`;
 $('raw').textContent=JSON.stringify(run,null,2);
 const words=L.words(r);$('wordsPanel').innerHTML='';
 if(r.sentences?.length){const p=document.createElement('p');p.className='hint';p.textContent='Sentence scores: '+r.sentences.map(s=>`${s.sentence||'Sentence'} (${fmt(s.overall)})`).join(' · ');$('wordsPanel').append(p);}
 if(!words.length){const p=document.createElement('p');p.className='hint';p.textContent='No word details returned. Inspect Full JSON and the selected API settings.';$('wordsPanel').append(p);}
 for(const w of words){
  const div=document.createElement('div');div.className='word';
  const score=w.scores?.pronunciation??w.scores?.overall??w.overall;
  div.innerHTML=`<div class="word-head"><b>${esc(w.word)}</b><span>${fmt(score)} / ${scale}${w.readType!==undefined?' · '+esc(labels[Number(w.readType)]??w.readType):''}</span><button class="secondary">Replay word</button></div><div class="phone-row"></div>`;
  const span=w.span||(w.start!==undefined?{start:w.start,end:w.end}:null);div.querySelector('button').disabled=!span||run.audio_id!==blobUrl;div.querySelector('button').onclick=()=>playSegment(span);
  for(const p of w.phonemes||[]){const b=document.createElement('button');b.className='phone'+((p.pronunciation/scale*100<policy().phone||[3,6].includes(Number(p.readType)))?' bad':'');b.innerHTML=`<b>${esc(p.phoneme)}</b>${fmt(p.pronunciation)}<em>${esc(p.sound_like===undefined?'':`Heard ${p.sound_like}`)}</em><em>${esc(p.readType===undefined?'':labels[Number(p.readType)]??p.readType)}</em>`;b.title=JSON.stringify(p,null,2);b.disabled=!p.span||run.audio_id!==blobUrl;b.onclick=()=>playSegment(p.span);div.querySelector('.phone-row').append(b);}
  if(w.phonics?.length){const p=document.createElement('p');p.className='hint';p.textContent='Letter ↔ sound: '+w.phonics.map(x=>`${x.spell} → /${(x.phoneme||[]).join('')}/ (${fmt(x.overall)})`).join(' · ');div.append(p);}
  if(w.scores?.stress){const p=document.createElement('p');p.className='hint';p.textContent='Syllable stress: '+w.scores.stress.map(s=>`${s.spell||s.phonetic}: spoken ${s.stress}, expected ${s.ref_stress}`).join(' · ');div.append(p);}
  if(w.mispron?.length){const p=document.createElement('pre');p.textContent=JSON.stringify(w.mispron,null,2);div.append(p);}
  $('wordsPanel').append(div);
 }
 const d=L.decide(run,policy());$('decision').className='decision '+d.status;$('decision').textContent=d.status.toUpperCase()+' · '+d.reason;
}
function cleanRun(r){const {audio_id,...rest}=r;return rest;}
function renderHistory(){
 $('history').innerHTML='';let falsePass=0,falseReject=0,graded=0;
 history.forEach((r,i)=>{const d=L.decide(r,policy());if(r.truth!=='unlabeled'&&d.status!=='review'){graded++;if(r.truth==='retry'&&d.status==='pass')falsePass++;if(r.truth==='pass'&&d.status==='retry')falseReject++;}
 const tr=document.createElement('tr');tr.innerHTML=`<td>${esc(r.label)}<small>${esc(r.request.coreType)}</small></td><td>slack ${r.request.slack??0}<small>${esc(r.request.dict_dialect||'closest')} · ${esc(r.request.accent_dialect||'general')} · age ${r.request.agegroup||3}</small></td><td>${fmt(r.response?.result?.overall)}</td><td>${d.status}</td><td><select aria-label="Human judgment for run ${i+1}"><option value="unlabeled">Unlabeled</option><option value="pass">Correct</option><option value="retry">Needs correction</option></select></td><td>${r.timing.vendor_ms}ms</td><td><button class="text-button">Inspect</button></td>`;tr.querySelector('select').value=r.truth;tr.querySelector('select').onchange=e=>{r.truth=e.target.value;renderHistory();};tr.querySelector('button').onclick=()=>render(r);$('history').append(tr);});
 $('summary').textContent=history.length?`${history.length} runs · ${graded} labeled with a pass/retry decision · ${falsePass} false passes · ${falseReject} false rejections. Review results are excluded from these counts.`:'No runs yet.';
}
$('evaluate').onclick=async()=>{
 let settings;try{settings=requestSettings();}catch(e){status(e.message,true);return;}
 if(core!=='asr.eval'&&!$('reference').value.trim()){status('Enter reference text.',true);return;}
 const form=new FormData();form.append('audio',blob,'recording');form.append('core_type',core);form.append('ref_text',$('reference').value);form.append('settings',JSON.stringify(settings));
 const label=$('testLabel').value.trim()||$('reference').value.trim().slice(0,35)||'Free speech',truth=$('truth').value,audioId=blobUrl;
 busy=true;refreshButtons();status('Normalizing audio and waiting for SpeechSuper…');const start=performance.now();
 try{const res=await fetch('/api/evaluate',{method:'POST',body:form});const data=await res.json();if(!res.ok)throw Error(typeof data.detail==='string'?data.detail:JSON.stringify(data.detail));const run={...data,client_ms:Math.round(performance.now()-start),label,truth,audio_id:audioId,created_at:new Date().toISOString()};history.unshift(run);render(run);renderHistory();status('Assessment returned. Inspect sound-level results and label this run.');}
 catch(e){status(e.message,true);}finally{busy=false;refreshButtons();}
};
function download(name,content,type='application/json'){const u=URL.createObjectURL(new Blob([content],{type})),a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);}
const exportData=()=>({exported_at:new Date().toISOString(),policy:policy(),runs:history.map(r=>({...cleanRun(r),decision:L.decide(r,policy())}))});
$('exportJson').onclick=()=>download('speechsuper-tests.json',JSON.stringify(exportData(),null,2));
$('downloadResult').onclick=()=>current&&download('speechsuper-result.json',JSON.stringify({...cleanRun(current),policy:policy(),decision:L.decide(current,policy())},null,2));
$('exportCsv').onclick=()=>{const cell=x=>'"'+String(x??'').replace(/^[=+@\-\t\r]/,"'$&").replace(/"/g,'""')+'"';const rows=[['label','core','reference','slack','scale','accent','agegroup','overall','decision','human','vendor_ms','request_json'],...history.map(r=>[r.label,r.request.coreType,r.request.refText,r.request.slack,r.request.scale,r.request.accent_dialect,r.request.agegroup,r.response?.result?.overall,L.decide(r,policy()).status,r.truth,r.timing.vendor_ms,JSON.stringify(r.request)])];download('speechsuper-tests.csv',rows.map(r=>r.map(cell).join(',')).join('\r\n'),'text/csv');};
$('clearHistory').onclick=()=>{history=[];renderHistory();};
$('resultTabs').onclick=e=>{const b=e.target.closest('button');if(!b)return;document.querySelectorAll('.result-panel').forEach(p=>p.hidden=p.id!==b.dataset.panel);document.querySelectorAll('#resultTabs button').forEach(x=>x.classList.toggle('active',x===b));};
$('modes').onclick=e=>{const b=e.target.closest('button');if(b)mode(b.dataset.core);};
document.querySelector('aside').addEventListener('input',()=>{$('slackValue').value=Number($('slack').value).toFixed(1);preview();});
for(const id of ['overallThreshold','phoneThreshold','focus','requirePhones'])$(id).addEventListener('input',()=>{if(current)render(current);renderHistory();});
window.addEventListener('beforeunload',()=>{release();if(blobUrl)URL.revokeObjectURL(blobUrl);});
fetch('/api/health').then(r=>r.json()).then(h=>{$('health').textContent=!h.ffmpeg_available?'FFmpeg missing':!h.credentials_configured?'Add keys to .env':'Backend ready';}).catch(()=>{$('health').textContent='Backend unavailable';});
mode(core);renderHistory();
