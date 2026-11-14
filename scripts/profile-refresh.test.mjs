import assert from "node:assert/strict";
import { test } from "node:test";
import { copyFileSync,mkdirSync,mkdtempSync,writeFileSync,readFileSync,rmSync } from "node:fs";
import { dirname,join,resolve } from "node:path";
import { fileURLToPath,pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

test("prewarmed chat thread is discarded after persona changes and never contains private data",async t=>{
  const dir=mkdtempSync(join(tmpdir(),"botcow-profile-")),scripts=dirname(fileURLToPath(import.meta.url));
  t.after(()=>{assert.equal(dirname(resolve(dir)),resolve(tmpdir()));rmSync(dir,{recursive:true,force:true});});
  for(const name of ["scripts","docs","knowledge"]) mkdirSync(join(dir,name));
  for(const name of ["chat-model","assistant-profile","read-query"]) copyFileSync(join(scripts,name+".mjs"),join(dir,"scripts",name+".mjs"));
  mkdirSync(join(dir,"docs/personas"));writeFileSync(join(dir,"docs/personas/whale-character.md"),"character-old");
  writeFileSync(join(dir,"docs/assistant-persona.md"),"persona-old");writeFileSync(join(dir,"knowledge/assistant-core.md"),"shared-knowledge");
  writeFileSync(join(dir,"app-server"),`
    const fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin});let n=0;
    const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
    rl.on('line',line=>{const x=JSON.parse(line);if(x.id==null)return;let result={};
      if(x.method==='config/read')result={config:{features:{memories:false},skills:{include_instructions:false},mcp_servers:{}}};
      if(x.method==='thread/start'){result={thread:{id:'thread-'+(++n)}};fs.appendFileSync('starts.ndjson',JSON.stringify(x.params)+'\\n');}
      send({id:x.id,result});
      if(x.method==='turn/start'){
        fs.appendFileSync('turns.ndjson',JSON.stringify(x.params)+'\\n');
        send({method:'item/completed',params:{threadId:x.params.threadId,item:{type:'agentMessage',text:'回答'}}});
        send({method:'turn/completed',params:{threadId:x.params.threadId,turn:{status:'completed'}}});
      }
    });
  `);
  const {ChatModel}=await import(pathToFileURL(join(dir,"scripts/chat-model.mjs")).href);
  const model=new ChatModel(process.execPath,dir,"fixture");
  try {
    await model.standby;
    writeFileSync(join(dir,"docs/personas/whale-character.md"),"character-new");
    await model.answer({question:"private-current-message 刚才结果呢",history:[{message_id:"m1",user:"算一下",reply:"旧风格结果 42"}]});
    const starts=readFileSync(join(dir,"starts.ndjson"),"utf8").trim().split("\n").map(JSON.parse);
    const turn=JSON.parse(readFileSync(join(dir,"turns.ndjson"),"utf8").trim());
    assert.equal(turn.threadId,"thread-2");assert.ok(starts[1].baseInstructions.includes("character-new"));
    const input=JSON.parse(turn.input[0].text);
    assert.equal(input.history[0].reply,undefined);assert.equal(input.assistant_evidence[0].source_text,"旧风格结果 42");
    assert.ok(!JSON.stringify(starts).includes("private-current-message"));
  } finally {model.close();await new Promise(resolve=>model.proc.once("close",resolve));}
});
