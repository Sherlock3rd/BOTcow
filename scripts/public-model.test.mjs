import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
test('public model receives no private profile, tools are disabled, oversized generation is terminated',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'botcow-public-')),scripts=dirname(fileURLToPath(import.meta.url));
  t.after(()=>{assert.equal(dirname(resolve(dir)),resolve(tmpdir()));rmSync(dir,{recursive:true,force:true});});
  for(const sub of ['scripts','docs','knowledge'])mkdirSync(join(dir,sub));
  for(const name of ['chat-model','assistant-profile','read-query'])copyFileSync(join(scripts,name+'.mjs'),join(dir,'scripts',name+'.mjs'));
  mkdirSync(join(dir,'docs/personas'));writeFileSync(join(dir,'docs/personas/whale-character.md'),'COMMON_CHARACTER');
  writeFileSync(join(dir,'docs/assistant-persona.md'),'PRIVATE_PERSONA_SENTINEL');
  writeFileSync(join(dir,'knowledge/assistant-core.md'),'PRIVATE_KNOWLEDGE_SENTINEL');
  writeFileSync(join(dir,'docs/assistant-public-persona.md'),'PUBLIC_PERSONA_SENTINEL');
  writeFileSync(join(dir,'app-server'),`
    const fs=require('fs'),rl=require('readline').createInterface({input:process.stdin});let n=0;
    const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
    rl.on('line',line=>{const x=JSON.parse(line);if(x.id==null)return;let result={};
      if(x.method==='config/read')result={config:{developer_instructions:'',features:{plugins:false,apps:false,shell_tool:false,unified_exec:false,multi_agent:false,memories:false},skills:{include_instructions:false},mcp_servers:{}}};
      if(x.method==='thread/start'){result={thread:{id:'t'+(++n)}};fs.appendFileSync('starts.ndjson',JSON.stringify(x.params)+'\\n');}
      send({id:x.id,result});
      if(x.method==='turn/start'){
        const q=JSON.parse(x.params.input[0].text).question;
        if(q==='long')send({method:'item/agentMessage/delta',params:{threadId:x.params.threadId,delta:'x'.repeat(1500)}});
        else {send({method:'item/completed',params:{threadId:x.params.threadId,item:{type:'agentMessage',text:'公开回答'}}});send({method:'turn/completed',params:{threadId:x.params.threadId,turn:{status:'completed'}}});}
      }
    });
  `);
  const {ChatModel}=await import(pathToFileURL(join(dir,'scripts/chat-model.mjs')).href);
  const m=new ChatModel(process.execPath,dir,'fixture','low',{publicOnly:true,maxGeneratedChars:1200});
  try {
    assert.equal((await m.answer({question:'hello'})).text,'公开回答');
    writeFileSync(join(dir,'docs/personas/whale-character.md'),'COMMON_CHARACTER_NEW');
    await m.answer({question:'hello'});
    const starts=readFileSync(join(dir,'starts.ndjson'),'utf8');assert.ok(starts.includes('PUBLIC_PERSONA_SENTINEL'));assert.ok(starts.includes('COMMON_CHARACTER_NEW'));assert.ok(!starts.includes('PRIVATE_'));
    await assert.rejects(m.answer({question:'long'}));assert.equal(m.closed,true);
  } finally {if(!m.closed)m.close();if(m.proc.exitCode===null)await new Promise(r=>m.proc.once('close',r));}
});
