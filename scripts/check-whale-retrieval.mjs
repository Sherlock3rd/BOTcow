import {ChatModel} from './chat-model.mjs';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const cfg=JSON.parse(readFileSync(join(root,'config/bridge.json'),'utf8').replace(/^\uFEFF/,''));
const bin=join(process.env.APPDATA,'npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
const m=new ChatModel(existsSync(bin)?bin:'codex',join(root,'runtime/cleanup-check/retrieval'),cfg.chat_model,cfg.chat_reasoning_effort),rows=[];
try{
 for(const c of [
  {id:'unrecognised_dependency',question:'把末尾那项翻译成英文',history:[{message_id:'m1',reply_id:'r1',user:'给我两个地点名',reply:'1. 星港，2. 月湾'}],kind:'assist'},
  {id:'project',question:'底层项目名称是什么？',history:[],kind:'answer',must:/botCow/}
 ]){
 const answer=await m.answer({schema_version:1,question:c.question,history:c.history,quoted:null,confirmed_memories:[],memory_status:'available',activeTasks:[],now:'2026年11月14日 星期六',sticker_catalog:[]});
 const ok=answer.kind===c.kind&&(!c.must||c.must.test(answer.text??''));rows.push({id:c.id,answer,ok});console.log(JSON.stringify(rows.at(-1)));
 }
}finally{m.close();}
writeFileSync(join(root,'runtime/cleanup-check/retrieval-results.json'),JSON.stringify({rows,total:rows.length,passed:rows.filter(x=>x.ok).length,feishu_writes:0},null,2));if(rows.some(x=>!x.ok))process.exitCode=1;
