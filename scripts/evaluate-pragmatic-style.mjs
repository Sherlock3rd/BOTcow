// Offline synthetic multi-turn evaluation. No IM writes, real chat ingestion, or business execution.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ChatModel} from './chat-model.mjs';
import {profileSnapshot} from './assistant-profile.mjs';

const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const phase=process.argv[2];
const allowed=new Set(['baseline','candidate','candidate2','candidate3','candidate4','candidate5','candidate6','candidate7','candidate8','candidate9','candidate10','candidate11','candidate12','candidate13','candidate14','candidate15','candidate16','holdout','validation','validation2','validation3']);
const referenceRun=['reference2022-dev','reference2022-validation','reference2022-regression','reference2022-dev2','reference2022-validation2','reference2022-regression2','reference2022-final','reference2022-confirm'].includes(phase);
if(!allowed.has(phase)&&!referenceRun)throw Error('Use a configured development, holdout, or validation phase');
const cfg=JSON.parse(readFileSync(join(root,'config/bridge.json'),'utf8'));
const data=JSON.parse(readFileSync(join(root,'scripts/fixtures',referenceRun&&!phase.startsWith('reference2022-regression')?'reference-style-2022.json':'pragmatic-dialogues-v3.json'),'utf8'));
const suite=phase==='reference2022-confirm'?data.final_checks.filter(s=>['current_context_not_memory','explicit_memory_kept','negative_fact_is_not_repetition','no_unprovided_consequence'].includes(s.id)):data[phase==='reference2022-final'?'final_checks':phase.startsWith('reference2022-validation')||phase.startsWith('reference2022-regression')?'validation':phase==='holdout'?'holdout':phase.startsWith('validation')?'validation':'development'];
for(const s of suite)for(const t of s.turns)for(const field of ['must_match','must_not_match'])if(t[field])new RegExp(t[field],'u');
const out=join(root,referenceRun?'runtime/style-analysis-2022/evaluation':'runtime/style-evaluation-v3');mkdirSync(out,{recursive:true});
const bin=join(process.env.APPDATA??'','npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
const initial=profileSnapshot();
const model=new ChatModel(existsSync(bin)?bin:'codex',join(out,'model'),cfg.chat_model,cfg.chat_reasoning_effort??'low',{timeoutMs:60000,rpcTimeoutMs:60000});
const results=[];

function testRegex(value,text){return new RegExp(value,'u').test(text);}
function addIssue(issues,dimension,code){issues.push({dimension,code});}

try{
  for(const scenario of suite){
    const history=(scenario.history??[]).map((x,i)=>({message_id:`synthetic-seed-${i}`,user:x.user,reply:x.reply,verification:'reply_verified'}));
    for(const [turnIndex,turn] of scenario.turns.entries()){
      let answer;
      try{
        answer=await model.answer({schema_version:1,question:turn.question,history:history.slice(-6),quoted:null,activeTasks:[],confirmed_memories:[],memory_status:'available',sticker_catalog:[],now:'2026年11月13日 星期五'});
      }catch(error){answer={kind:'error',error:error.message};}
      const text=answer.text??'';
      const issues=[];
      if(referenceRun&&/\p{Script=Malayalam}|you majesty|陛下/iu.test(text))addIssue(issues,'naturalness','unexpected_language_or_legacy_prefix');
      if(!(turn.kinds??['answer']).includes(answer.kind))addIssue(issues,'mode_accuracy','wrong_route');
      if(turn.no_question&&/[?？]/.test(text))addIssue(issues,'pacing','unnecessary_question');
      if(turn.max_chars&&text.length>turn.max_chars)addIssue(issues,'pacing','too_long');
      if(turn.must_match&&!testRegex(turn.must_match,text))addIssue(issues,turn.dimensions?.[0]??'context_fit','missing_expected_signal');
      if(turn.must_not_match&&testRegex(turn.must_not_match,text))addIssue(issues,turn.dimensions?.[0]??'context_fit','contains_forbidden_signal');
      if(turn.no_unsolicited_direction&&/(?:先|就|那就).{0,8}(?:歇|休息)|别.{0,6}(?:撑|想|忙)|今天.{0,5}(?:到这|先到)|早点.{0,6}(?:睡|收工|休息)/u.test(text))addIssue(issues,'agency','unsolicited_direction');
      if(turn.no_future_promise&&/(?:后面|以后|接下来).{0,12}(?:改|不再|会)|我会.{0,12}(?:改|注意)|按实际表现/u.test(text))addIssue(issues,'repair','future_promise_instead_of_repair');
      if(turn.no_term_definition&&/(?:意思是|网络说法|指的是|这个词是)/u.test(text))addIssue(issues,'reference_resolution','defines_term_instead_of_choice');
      if(turn.single_sentence&&(text.match(/[。！？!?]/gu)?.length??0)>1)addIssue(issues,'pacing','more_than_one_sentence');
      if(/作为.?AI|人工智能助手|语言模型/.test(text))addIssue(issues,'naturalness','ai_self_brochure');
      if(/如果.{0,8}(?:人身|生命).{0,8}危险|立即拨打.?110|寻求专业帮助/.test(text)&&!/危险|伤害|自杀|自残/.test(turn.question))addIssue(issues,'safety_calibration','unprompted_safety_script');
      if(/还有什么.{0,6}(?:帮助|需要)|可以继续发给我|我可以帮你/.test(text))addIssue(issues,'naturalness','service_tail');
      const normalized=text.replace(/[\s，。！？,.!?]/g,'');
      if(normalized.length>4&&history.some(x=>(x.reply??'').replace(/[\s，。！？,.!?]/g,'')===normalized))addIssue(issues,'pacing','repeats_previous_reply');
      const dimensions=Object.fromEntries((turn.dimensions??[]).map(d=>[d,!issues.some(x=>x.dimension===d)]));
      const row={scenario:scenario.id,turn:turnIndex,question:turn.question,expectation:turn.expectation,history:[...history],answer,dimensions,issues,pass:issues.length===0,manual_review_required:true};
      results.push(row);
      console.log(JSON.stringify({scenario:row.scenario,turn:turnIndex,answer,issues}));
      history.push({message_id:`synthetic-${scenario.id}-${turnIndex}`,user:turn.question,reply:answer.kind==='answer'?text:null,verification:'reply_verified'});
    }
  }
}finally{model.close();}

const dimensionTotals={};
for(const row of results)for(const [dimension,pass] of Object.entries(row.dimensions)){
  dimensionTotals[dimension]??={pass:0,total:0};
  dimensionTotals[dimension].total++;
  if(pass)dimensionTotals[dimension].pass++;
}
const report={phase,synthetic:true,feishu_writes:0,profile:initial,profile_unchanged:initial.version===profileSnapshot().version,total:results.length,automatic_pass:results.filter(x=>x.pass).length,dimension_totals:dimensionTotals,results};
writeFileSync(join(out,`${phase}.json`),JSON.stringify(report,null,2));
console.log(JSON.stringify({phase,total:report.total,automatic_pass:report.automatic_pass,profile_unchanged:report.profile_unchanged,dimension_totals:dimensionTotals}));
if(!report.profile_unchanged||report.automatic_pass<report.total)process.exitCode=1;
