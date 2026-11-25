import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync,rmSync,writeFileSync,readFileSync,mkdirSync,copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join,dirname,resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { MemoryStore } from "./memory-store.mjs";
import { parseMemoryCommand,validateMemoryCommand,memoryScope } from "./memory-policy.mjs";
import { buildContext,openMemory,projectRecord,recordVerifiedReply,verifyContextEpoch,replayProjection } from "./context-builder.mjs";
import { manageMemory,withScopeLock } from "./memory-management.mjs";
import { taskSession,saveTaskThread,completeTaskForMessage } from "./task-session-registry.mjs";
import { scopedReply } from "./scoped-reply.mjs";

const config={profile:"test",bot_open_id:"bot",allowed_sender_ids:["owner"],allowed_chat_types:["p2p","group"],
  allowed_group_chat_ids:["g1","g2"],allowed_message_types:["text","post","image"],
  memory:{enabled:true,read_enabled:true,write_enabled:true,task_isolation:true}};
const event=(id,content,extra={})=>({message_id:id,content,sender_id:"owner",sender_type:"user",chat_id:"dm",chat_type:"p2p",
  message_type:"text",captured_at:new Date().toISOString(),...extra});
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),"botcow-memory-"));
  t.after(()=>{assert.equal(dirname(resolve(dir)),resolve(tmpdir()));rmSync(dir,{recursive:true,force:true});});
  return dir;
}
const remember=(dir,id,value)=>{
  const e=event(id,"记住，"+value);buildContext(dir,e,config);
  return manageMemory(dir,e,config,{operation:"save",value});
};

test("explicit memory survives reopen; replay never creates a second revision",t=>{
  const dir=fixture(t),result=remember(dir,"a","方案先给结论");
  const again=remember(dir,"a","方案先给结论");assert.equal(again.replay,true);
  const store=openMemory(dir),scope=store.scope(event("x",""),config);
  assert.equal(store.list(scope).length,1);assert.equal(store.list(scope)[0].revision,1);store.close();
  const context=buildContext(dir,event("q","我的方案格式是什么"),config);
  assert.equal(context.confirmed_memories[0].id,result.memory_id);
  assert.equal(context.confirmed_memories[0].value,"方案先给结论");
});
test("private memory, different groups, no mention and outsiders cannot cross scope",t=>{
  const dir=fixture(t);remember(dir,"a","私聊偏好");
  for(const chat_id of ["g1","g2"]) {
    const e=event(chat_id,"记住，群内口径",{chat_type:"group",chat_id,mentions:[{id:"bot"}]});
    assert.equal(buildContext(dir,e,config).confirmed_memories.length,0);
    manageMemory(dir,e,config,{operation:"save",value:"群内口径"});
  }
  for(const e of [event("out","秘密",{sender_id:"other"}),event("unmentioned","秘密",{chat_type:"group",chat_id:"g1"})]) {
    assert.throws(()=>projectRecord(dir,config,e),/scope_denied/);
    assert.equal(buildContext(dir,e,config).confirmed_memories.length,0);
  }
  assert.equal(buildContext(dir,event("q",""),config).confirmed_memories.length,1);
});
test("correction uses optimistic revision; forgetting invalidates replies and task threads",t=>{
  const dir=fixture(t),result=remember(dir,"a","先给结论"),store=openMemory(dir),scope=store.scope(event("x",""),config);
  const task=taskSession(store,scope,event("task","评审方案"),{},"v1");saveTaskThread(store,scope,task,"old-thread");
  recordVerifiedReply(dir,config,event("a",""),{message_id:"reply",chat_id:"dm",reply_to:"a",sender:{open_bot_id:"bot"},msg_type:"text",content:"已记住先给结论"},1);
  const correction=event("b","把偏好改成先解释背景");
  const changed=manageMemory(dir,correction,config,{operation:"update",target:result.memory_id,value:"先解释背景",expected_revision:1});
  assert.equal(changed.epoch,2);
  assert.throws(()=>manageMemory(dir,event("c","把偏好改成先说结论"),config,{operation:"update",target:result.memory_id,value:"先说结论",expected_revision:1}),/revision_conflict/);
  const forgotten=manageMemory(dir,event("d","忘掉这条偏好"),config,{operation:"forget",target:result.memory_id,expected_revision:2});
  assert.equal(forgotten.epoch,3);
  assert.equal(store.list(scope).length,0);assert.equal(store.db.prepare("SELECT COUNT(*) n FROM threads").get().n,0);
  const ctx=buildContext(dir,event("e","偏好是什么"),config);
  assert.ok(!JSON.stringify(ctx).includes("先给结论"));assert.ok(!JSON.stringify(ctx).includes("先解释背景"));
  assert.throws(()=>verifyContextEpoch(dir,event("e",""),config,1),/stale_memory_context/);
  assert.ok(!manageMemory(dir,event("a","记住，先给结论"),config,{operation:"save",value:"先给结论"}).text.includes("先给结论"));
  replayProjection(dir,config);assert.equal(store.list(scope).length,0);store.close();
});
test("quoted instructions and guesses cannot authorize memory writes",()=>{
  assert.throws(()=>validateMemoryCommand(event("a","今天有点累"),{operation:"save",value:"用户长期状态差"}),/instruction/);
  assert.throws(()=>validateMemoryCommand(event("a","记住我喜欢红色"),{operation:"save",value:"喜欢蓝色"}),/quote/);
  assert.equal(parseMemoryCommand(event("a","记住这个口径，再把表改了")),null);
  assert.deepEqual(parseMemoryCommand(event("a","忘掉先给结论")),{operation:"forget",target:"先给结论"});
  assert.throws(()=>validateMemoryCommand(event("a","解释这句话：记住我的偏好"),{operation:"save",value:"我的偏好"}),/instruction/);
  assert.equal(validateMemoryCommand(event("a","把那条格式偏好改成先讲背景"),{operation:"update",value:"把那条格式偏好改成先讲背景"}).value,"先讲背景");
});

test("restoring a pre-forget backup fails closed against the durable epoch fence",t=>{
  const dir=fixture(t),result=remember(dir,"a","旧偏好");
  const db=join(dir,"assistant-memory.sqlite"),snapshot=join(dir,"old.sqlite");
  copyFileSync(db,snapshot);
  manageMemory(dir,event("b","忘掉那个偏好"),config,{operation:"forget",target:result.memory_id});
  copyFileSync(snapshot,db);
  const ctx=buildContext(dir,event("c","旧偏好是什么"),config);
  assert.equal(ctx.memory_status,"unavailable");assert.deepEqual(ctx.confirmed_memories,[]);
});
test("new projection does not copy obvious credentials into history or its outbox",t=>{
  const dir=fixture(t),e=event("a","app_secret=secret_fixture_123 access_token: secret_fixture_456");
  buildContext(dir,e,config);
  assert.ok(!readFileSync(join(dir,"conversation-projection.ndjson"),"utf8").includes("secret_fixture"));
  const ctx=buildContext(dir,event("b","之前说什么"),config);
  assert.ok(!JSON.stringify(ctx.history).includes("secret_fixture"));
});
test("missing database is unavailable, never silently reinitialized or global-memory fallback",t=>{
  const dir=fixture(t);remember(dir,"a","长期口径");
  rmSync(join(dir,"assistant-memory.sqlite"));
  const ctx=buildContext(dir,event("b","还记得吗"),config);
  assert.equal(ctx.memory_status,"unavailable");assert.deepEqual(ctx.confirmed_memories,[]);
  assert.throws(()=>manageMemory(dir,event("c","记住新口径"),config,{operation:"save",value:"新口径"}),/restore_required/);
});
test("task registry resumes only matching scope, reference, epoch and persona",t=>{
  const dir=fixture(t),store=openMemory(dir),e=event("a","评审"),scope=store.scope(e,config);
  projectRecord(dir,config,e);
  const session=taskSession(store,scope,e,{},"v1");saveTaskThread(store,scope,session,"thread-a");
  assert.equal(taskSession(store,scope,event("b","继续",{reply_to:"a"}),{},"v1").thread_id,"thread-a");
  assert.equal(taskSession(store,scope,event("c","新的独立任务"),{},"v1").thread_id,null);
  assert.equal(taskSession(store,scope,event("d","继续"),{},"v1").ambiguous,true);
  const group=event("g","继续",{chat_id:"g1",chat_type:"group",mentions:[{id:"bot"}],reply_to:"a"});
  assert.equal(taskSession(store,store.scope(group,config),group,{},"v1").thread_id,null);
  assert.equal(taskSession(store,scope,event("f","继续",{reply_to:"a"}),{},"v2").thread_id,null);store.close();
});
test("task lifecycle settles verified messages and reactivates explicit follow-ups",t=>{
  const dir=fixture(t),store=openMemory(dir),first=event("a","评审"),scope=store.scope(first,config);
  projectRecord(dir,config,first);
  const session=taskSession(store,scope,first,{},"v1");
  assert.equal(store.db.prepare("SELECT status FROM tasks WHERE scope=? AND id=?").get(scope.id,session.task_id).status,"active");
  assert.equal(completeTaskForMessage(store,scope,"a").updated,true);
  assert.equal(store.db.prepare("SELECT status FROM tasks WHERE scope=? AND id=?").get(scope.id,session.task_id).status,"completed");
  taskSession(store,scope,event("b","继续",{reply_to:"a"}),{},"v1");
  assert.equal(store.db.prepare("SELECT status FROM tasks WHERE scope=? AND id=?").get(scope.id,session.task_id).status,"active");
  assert.equal(completeTaskForMessage(store,scope,"b").updated,true);
  assert.equal(store.db.prepare("SELECT status FROM tasks WHERE scope=? AND id=?").get(scope.id,session.task_id).status,"completed");
  assert.deepEqual(completeTaskForMessage(store,scope,"missing"),{updated:false,task_id:null});
  store.close();
});
test("card and attachment partial delivery retries readback, never resends; forged identity rejected",t=>{
  const dir=fixture(t),e=event("a","交付"),ctx=buildContext(dir,e,config);
  let sends=0,correct=false;
  for(const type of ["interactive","file"]) {
    const spec={part:type,epoch:ctx.scope_epoch,type,content:type==="file"?{file_key:"file_test"}:{schema:"2.0"},expected_text:["result"]};
    let id;
    const im=(cmd)=>{
      if(cmd==="+messages-reply"){sends++;id="reply_"+type;return {message_id:id,chat_id:"dm"};}
      return {messages:[{message_id:id,chat_id:"dm",reply_to:"a",msg_type:type,content:"result",sender:{open_bot_id:correct?"bot":"wrong"}}]};
    };
    correct=false;assert.throws(()=>scopedReply(dir,e,config,spec,im),/identity_mismatch/);
    correct=true;assert.equal(scopedReply(dir,e,config,spec,im).verification,"reply_verified");
  }
  assert.equal(sends,2);
  const store=openMemory(dir),records=store.recent(store.scope(e,config));
  assert.equal(records.filter(r=>r.verification==="reply_verified").length,2);
  assert.ok(records.every(r=>r.verification!=="business_verified"));store.close();
});
test("stale context cannot send after forget; scope lock serializes mutation and send",t=>{
  const dir=fixture(t),result=remember(dir,"a","先说结论"),e=event("b","问答"),ctx=buildContext(dir,e,config);
  manageMemory(dir,event("c","忘掉偏好"),config,{operation:"forget",target:result.memory_id});
  let sends=0;
  assert.throws(()=>scopedReply(dir,e,config,{part:"answer",epoch:ctx.scope_epoch,type:"text",content:"先说结论"},()=>{sends++;}),/stale_memory_context/);
  assert.equal(sends,0);
  withScopeLock(dir,e,config,()=>assert.throws(()=>manageMemory(dir,event("d","记住另一个"),config,{operation:"save",value:"另一个"}),/scope_busy/));
});
test("a model-selected memory ID cannot resolve an ambiguous user instruction",t=>{
  const dir=fixture(t),first=remember(dir,"a","先给结论");remember(dir,"b","先解释背景");
  const result=manageMemory(dir,event("c","忘掉那个偏好"),config,{operation:"forget",target:first.memory_id});
  assert.equal(result.clarification,true);
  assert.equal(buildContext(dir,event("d","查看记忆"),config).confirmed_memories.length,2);
});
test("crashed SQLite transaction rolls back atomically",t=>{
  const dir=fixture(t);remember(dir,"a","原值");
  const path=join(dir,"assistant-memory.sqlite");
  const child=spawnSync(process.execPath,["--input-type=module","-e",`import {DatabaseSync} from 'node:sqlite';
    const db=new DatabaseSync(process.argv[1]);db.exec("BEGIN IMMEDIATE; UPDATE memories SET value='bad';");process.exit(9);`,path],{windowsHide:true});
  assert.equal(child.status,9);
  assert.equal(buildContext(dir,event("b","原值"),config).confirmed_memories[0].value,"原值");
});
test("long current input and mandatory quote are not silently clipped",t=>{
  const dir=fixture(t),body="长文".repeat(18000),e=event("a",body);
  const ctx=buildContext(dir,e,config);assert.equal(ctx.current_message,body);assert.equal(ctx.budget.status,"requires_chunking");
  const next=buildContext(dir,event("b","请解释",{reply_to:"a"}),config);
  assert.equal(next.quoted.user,body);assert.equal(next.budget.status,"requires_chunking");
});
test("database projection outage after verified delivery can be replayed without IM writes",t=>{
  const dir=fixture(t),e=event("a","收到"),ctx=buildContext(dir,e,config);
  const locked=openMemory(dir);locked.db.exec("BEGIN IMMEDIATE");
  assert.throws(()=>recordVerifiedReply(dir,config,e,{message_id:"r",chat_id:"dm",reply_to:"a",msg_type:"text",content:"已收到",sender:{open_bot_id:"bot"}},ctx.scope_epoch));
  locked.db.exec("ROLLBACK");locked.close();replayProjection(dir,config);
  const next=buildContext(dir,event("b","刚才说了什么"),config);
  assert.equal(next.history[0].reply,"已收到");
});

test("explicit follow-up to a stopped task starts a fresh thread without deleting history",t=>{
  const dir=fixture(t),store=openMemory(dir),e=event('cancel-a','查询'),scope=store.scope(e,config);
  projectRecord(dir,config,e);
  const session=taskSession(store,scope,e,{},'v1');saveTaskThread(store,scope,session,'old-full-thread');
  store.db.prepare("UPDATE tasks SET status='cancelled' WHERE scope=? AND id=?").run(scope.id,session.task_id);
  const next=taskSession(store,scope,event('cancel-b','重新查询',{reply_to:'cancel-a'}),{},'v1');
  assert.equal(next.thread_id,null);assert.equal(next.task_id,session.task_id);
  assert.ok(store.recent(scope).some(r=>r.message_id==='cancel-a'));store.close();
});

test("cancel fence prevents a new reply even after another task becomes active",t=>{
  const dir=fixture(t),e=event('stopped','查询'),ctx=buildContext(dir,e,config);let sends=0;
  writeFileSync(join(dir,'blocked.ndjson'),JSON.stringify({message_id:e.message_id,status:'blocked',error_type:'user_cancelled'})+'\n');
  writeFileSync(join(dir,'active-task.json'),JSON.stringify({message_id:'another',run_id:'new',state:'running'}));
  assert.throws(()=>scopedReply(dir,e,config,{part:'answer',epoch:ctx.scope_epoch,type:'text',content:'late'},()=>{sends++;}),/task_stopped/);
  assert.equal(sends,0);
});
