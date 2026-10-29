/* Pure result handling, shared by the UI and offline tests. */
(function(root){
function words(result){return Array.isArray(result?.words)?result.words:(result?.sentences||[]).flatMap(s=>s.details||s.words||[]);}
function decide(run, policy){
 const r=run.response?.result;
 if(!r||run.response?.eof===0||run.response?.error||run.response?.errId||run.response?.errorId)return {status:'review',reason:'No complete, valid assessment.'};
 if(run.request.coreType==='asr.eval')return {status:'review',reason:'Unscripted speech: diagnostic scores only; no expected pronunciation to verify.'};
 if(r.warning?.length)return {status:'review',reason:'Vendor warnings: inspect recording quality before grading.'};
 if(r.scorable_word_count===0)return {status:'retry',reason:'No scorable words detected.'};
 const scale=Number(run.request.scale||100), score=r.overall;
 if(typeof score!=='number')return {status:'review',reason:'Overall score is unavailable.'};
 const ws=words(r), ps=ws.flatMap(w=>w.phonemes||[]);
 if(ws.some(w=>Number(w.readType)===3))return {status:'retry',reason:'An expected word was omitted.'};
 if(score/scale*100<policy.overall)return {status:'retry',reason:'Overall score is below your threshold.'};
 if(!ps.length&&policy.require)return {status:'review',reason:'Phoneme results unavailable. Paragraph mode normally provides word scores only.'};
 let selected=policy.focus?ps.filter(p=>p.phoneme===policy.focus):ps;
 if(policy.focus&&ps.length&&!selected.length)return {status:'review',reason:'Focus sound absent. Check the exact dictionary symbol or clear the focus.'};
 if(selected.some(p=>[3,6].includes(Number(p.readType))))return {status:'retry',reason:'A checked sound was omitted or substituted.'};
 if(selected.some(p=>typeof p.pronunciation!=='number'))return {status:'review',reason:'A checked sound has no score.'};
 if(selected.some(p=>p.pronunciation/scale*100<policy.phone))return {status:'retry',reason:'A checked sound is below your phoneme threshold.'};
 return {status:'pass',reason:ps.length?'Overall and checked sounds meet your rules.':'Overall meets your rules; phoneme checks were disabled.'};
}
const api={words,decide};if(typeof module!=='undefined')module.exports=api;else root.LabLogic=api;
})(globalThis);
