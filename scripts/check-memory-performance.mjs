// Synthetic, local-only fixed dataset. No original inbox import or external calls.
import { mkdtempSync,rmSync,writeFileSync,mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join,dirname,resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openMemory,buildContext } from "./context-builder.mjs";

const root=join(dirname(fileURLToPath(import.meta.url)),".."),dir=mkdtempSync(join(tmpdir(),"botcow-memory-perf-"));
const config={profile:"synthetic",bot_open_id:"bot",allowed_sender_ids:["owner"],allowed_chat_types:["p2p"],allowed_message_types:["text"],memory:{enabled:true,read_enabled:true}};
const event={message_id:"query",chat_id:"dm",chat_type:"p2p",sender_id:"owner",sender_type:"user",message_type:"text",content:"方案格式和第1999个主题"};
try {
  const store=openMemory(dir),scope=store.scope(event,config);
  store.transaction(()=>{
    for(let i=0;i<10000;i++) store.record(scope,{id:"record"+i,message_id:"message"+i,role:"user",content_type:"text",
      body:`合成对话 ${i}，用于检索压力测试。`,verification:"received",source_time:"2026-11-13T00:00:00Z"});
    const insert=store.db.prepare("INSERT INTO memories VALUES (?,?,?,?,?,?,?,?,?)");
    for(let i=0;i<2000;i++) insert.run("memory"+i,scope.id,`第${i}个主题：方案先给结论，然后说明依据。`,"confirmed",1,"message"+i,"explicit_user","owner","2026-11-13T00:00:00Z");
  });store.close();
  const durations=[];
  for(let i=0;i<40;i++) {
    const started=performance.now(),ctx=buildContext(dir,{...event,message_id:"query"+i},config);
    if(ctx.memory_status!=="available") throw new Error("synthetic_context_unavailable");
    durations.push(performance.now()-started);
  }
  durations.sort((a,b)=>a-b);
  const result={records:10000,memories:2000,samples:40,p50_ms:durations[19],p95_ms:durations[37],max_ms:durations[39],target_ms:100,writes_attempted:0};
  result.ok=result.p95_ms<=result.target_ms;
  mkdirSync(join(root,"runtime/memory-check"),{recursive:true});
  writeFileSync(join(root,"runtime/memory-check/performance.json"),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));if(!result.ok) process.exitCode=1;
} finally {
  if(dirname(resolve(dir))!==resolve(tmpdir())) throw new Error("unsafe_cleanup_path");
  rmSync(dir,{recursive:true,force:true});
}
