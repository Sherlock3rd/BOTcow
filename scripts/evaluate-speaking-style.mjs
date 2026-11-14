// Offline, synthetic dialogue checks. No IM writes, real history, or business execution.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ChatModel} from './chat-model.mjs';
import {profileSnapshot,publicProfileSnapshot} from './assistant-profile.mjs';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const phase=process.argv[2];
if(!['baseline','candidate','holdout','candidate2','validation2'].includes(phase))throw Error('Use baseline, candidate, holdout, candidate2, or validation2');
const cfg=JSON.parse(readFileSync(join(root,'config/bridge.json'),'utf8'));
const data=JSON.parse(readFileSync(join(root,'scripts/fixtures/speaking-style-dialogues.json'),'utf8'));
const suite=phase==='candidate2'?[...data.development.filter(x=>['specific_missing','unknown_emotion','work_switch','public_boundary'].includes(x.id)),...data.holdout.filter(x=>x.id==='new_cause_same_words')]:data[phase==='validation2'?'validation2':phase==='holdout'?'holdout':'development'];
const out=join(root,'runtime/style-evaluation');mkdirSync(out,{recursive:true});
const bin=join(process.env.APPDATA??'','npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
const initial={profile:profileSnapshot(),public_profile:publicProfileSnapshot()};
const results=[];
for(const lane of ['chat','public']){
 const cases=suite.filter(x=>(x.lane??'chat')===lane);if(!cases.length)continue;
 const m=new ChatModel(existsSync(bin)?bin:'codex',join(out,'model-'+lane),cfg.chat_model,'low',lane==='public'?{publicOnly:true,timeoutMs:12000,maxGeneratedChars:1200,maxReplyChars:800}:{});
 try{for(const scenario of cases){
  const history=(scenario.history??[]).map((x,i)=>({message_id:'synthetic-seed-'+i,user:x.user,reply:x.reply,verification:'reply_verified'}));
  for(const [i,turn] of scenario.turns.entries()){
   let answer;try{answer=await m.answer(lane==='public'?{question:turn.question}:{schema_version:1,question:turn.question,history:history.slice(-6),quoted:null,activeTasks:[],confirmed_memories:[],memory_status:'available',sticker_catalog:[],now:'2026年11月13日 星期五'});}catch(e){answer={kind:'error',error:e.message};}
   const text=answer.text??'',issues=[];
   if(!(turn.kinds??['answer']).includes(answer.kind))issues.push('wrong_route');
   if(turn.no_question&&/[?？]|(?:咋[啦了]|怎么了|忙啥|发生.{0,3}(?:什么|啥))/.test(text))issues.push('unnecessary_question');
   if(/咋[啦了]|今天又忙啥了|碰到啥事了/.test(text))issues.push('generic_cause_prompt');
   if(/今天辛苦了|喝口水|放空十分钟|拽回工作状态|还有什么.*帮助/.test(text))issues.push('service_template');
   if(text.length>(turn.max_chars??180))issues.push('too_long');
   if(turn.must_match&&!new RegExp(turn.must_match,'u').test(text))issues.push('missing_context_anchor');
   if(turn.must_not_match&&new RegExp(turn.must_not_match,'u').test(text))issues.push('contradicts_context');
   const normalized=text.replace(/[\s，。！？,.!?]/g,'');
   if(normalized.length>4&&history.some(x=>(x.reply??'').replace(/[\s，。！？,.!?]/g,'')===normalized))issues.push('repeats_previous_reply');
   const row={scenario:scenario.id,turn:i,lane,question:turn.question,expectation:turn.expectation,history:[...history],answer,issues,pass:issues.length===0};
   results.push(row);console.log(JSON.stringify({scenario:row.scenario,turn:i,lane,answer,issues}));
   history.push({message_id:'synthetic-'+scenario.id+'-'+i,user:turn.question,reply:answer.kind==='answer'?text:null,verification:'reply_verified'});
  }
 }}finally{m.close();}
}
const report={phase,...initial,profile_unchanged:initial.profile.version===profileSnapshot().version&&initial.public_profile.version===publicProfileSnapshot().version,
 synthetic:true,feishu_writes:0,total:results.length,heuristic_pass:results.filter(x=>x.pass).length,results};
writeFileSync(join(out,phase+'.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({phase,total:report.total,heuristic_pass:report.heuristic_pass,profile_unchanged:report.profile_unchanged}));
// Heuristics flag review candidates; they do not prove naturalness or replace human reading.
if(!report.profile_unchanged||report.heuristic_pass<report.total)process.exitCode=1;
