import { appendFileSync, existsSync, readFileSync, writeFileSync,openSync,readSync,fstatSync,closeSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore } from "./memory-store.mjs";
import { digest, memoryScope, safeMemoryBody } from "./memory-policy.mjs";
import { profileSnapshot } from "./assistant-profile.mjs";

export const memoryEnabled = config => config.memory?.enabled === true;
export function openMemory(runtimeDir) {
  const path = join(runtimeDir,"assistant-memory.sqlite"), marker = join(runtimeDir,"memory-initialized.json");
  if (existsSync(marker) && !existsSync(path)) throw new Error("memory_database_missing_restore_required");
  const store = new MemoryStore(path);
  try {if (!existsSync(marker)) writeFileSync(marker,JSON.stringify({schema:1,created_at:new Date().toISOString()}));}
  catch(error){store.close();throw error;}
  return store;
}
export function projectRecord(runtimeDir, config, event, part = null) {
  memoryScope(event,config);
  const entry = part ?? { id:event.message_id,message_id:event.message_id,role:"user",content_type:event.message_type,
    body:String(event.content ?? ""),verification:"received",source_time:event.captured_at ?? new Date().toISOString() };
  entry.body=safeMemoryBody(entry.body);
  const identity=Object.fromEntries(["message_id","sender_type","sender_id","chat_id","chat_type","message_type","mentions"].map(key=>[key,event[key]]));
  const row = { id:digest(JSON.stringify([entry.id,entry.verification,entry.body])), event:identity, entry };
  // Durable outbox precedes the projection: a DB failure cannot require resending IM.
  appendFileSync(join(runtimeDir,"conversation-projection.ndjson"),JSON.stringify(row)+"\n");
  return replayProjection(runtimeDir,config);
}
export function replayProjection(runtimeDir,config) {
  const store = openMemory(runtimeDir);
  try {
    const path = join(runtimeDir,"conversation-projection.ndjson");
    store.transaction(() => {
      if(!existsSync(path)) return;
      const cursor=store.db.prepare("SELECT offset FROM projection_cursor WHERE id=1").get()?.offset??0;
      const fd=openSync(path,"r");let bytes;
      try {
        const size=fstatSync(fd).size;
        if(size<cursor) throw new Error("projection_log_truncated");
        bytes=Buffer.alloc(size-cursor);readSync(fd,bytes,0,bytes.length,cursor);
      } finally {closeSync(fd);}
      const boundary=bytes.lastIndexOf(10);
      if(boundary<0) return;
      const rows=bytes.subarray(0,boundary+1).toString("utf8").split(/\r?\n/).filter(Boolean);
      for (const line of rows) {
        let row; try { row=JSON.parse(line); } catch { throw new Error("projection_record_corrupt"); }
        if (store.db.prepare("SELECT 1 FROM projection_entries WHERE id=?").get(row.id)) continue;
        let scope; try { scope=store.scope(row.event,config); } catch { continue; }
        // An old outbox entry must not become current again after correction/forgetting.
        if (row.entry.epoch == null && store.epoch(scope)>1 && row.entry.role === "user") {
          store.record(scope,{...row.entry,epoch:1});
        } else store.record(scope,row.entry);
        store.db.prepare("INSERT INTO projection_entries VALUES (?)").run(row.id);
      }
      store.db.prepare("INSERT INTO projection_cursor VALUES (1,?) ON CONFLICT(id) DO UPDATE SET offset=excluded.offset").run(cursor+boundary+1);
    });
  } finally { store.close(); }
}
export function buildContext(runtimeDir,event,config) {
  const started=performance.now(), profile=profileSnapshot();
  const base={ schema_version:1,event:{message_id:event.message_id},persona_version:profile.personaVersion,
    knowledge_version:profile.knowledgeVersion,current_message:event.content,question:event.content,
    now:new Date().toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"}),history:[],activeTasks:[],
    quoted:null,missingReference:Boolean(event.reply_to||event.root_id),confirmed_memories:[],relevant_episodes:[],conflicts:[],
    retrieval_manifest:[],budget:{status:"within_limit",omitted_record_ids:[]},memory_status:"unavailable" };
  // Read an existing send receipt only for idempotent reconciliation, never as verified history.
  const ledger=join(runtimeDir,"greeting-replies.ndjson");
  if(existsSync(ledger)) base.previousReply=readFileSync(ledger,"utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse).findLast(r=>r.message_id===event.message_id);
  let store;
  try {
    store=openMemory(runtimeDir);
    const scope=store.scope(event,config), epoch=store.epoch(scope);
    projectRecord(runtimeDir,config,event,{id:event.message_id,message_id:event.message_id,role:"user",
      content_type:event.message_type,body:String(event.content??""),verification:"received",
      source_time:event.captured_at??new Date().toISOString(),epoch});
    base.event.scope_id=scope.id; base.scope_epoch=epoch;
    const records=store.recent(scope).filter(r=>r.message_id!==event.message_id);
    const turns=records.filter(r=>r.role==="user").map(r=>{
      const reply=records.find(x=>x.message_id===r.message_id&&x.role==="assistant"&&x.verification==="reply_verified");
      return {message_id:r.message_id,user:r.body,reply:reply?.body??null,reply_id:reply?.reply_id,
        verification:reply?.verification??r.verification};
    });
    const reference=event.reply_to||event.root_id;
    base.quoted=turns.find(t=>t.message_id===reference||t.reply_id===reference)??null;
    base.missingReference=Boolean(reference&&!base.quoted);
    base.history=turns.slice(-6);
    base.activeTasks=store.db.prepare("SELECT id AS task_id,source_id AS message_id,goal AS user,status FROM tasks WHERE scope=? AND epoch=? AND status='active' ORDER BY rowid DESC LIMIT 4").all(scope.id,epoch);
    if(memoryEnabled(config)&&config.memory.read_enabled!==false) base.confirmed_memories=store.recall(scope,event.content).map(m=>({id:m.id,value:m.value,revision:m.revision,source_message_id:m.source_id,origin:m.origin}));
    let remaining=6000;
    for(const key of ["confirmed_memories","history"]) {
      base[key]=base[key].filter(item=>{
        const size=JSON.stringify(item).length;
        if(size>remaining){base.budget.omitted_record_ids.push(item.id??item.message_id);return false;}
        remaining-=size;return true;
      });
    }
    if(base.budget.omitted_record_ids.length) base.budget.status="trimmed";
    // Necessary source and current message are never silently truncated.
    if(JSON.stringify(base).length>30000) base.budget.status="requires_chunking";
    base.retrieval_manifest=base.confirmed_memories.map(m=>({id:m.id,revision:m.revision,scope:scope.id,reason:"scope_keyword_or_recent"}));
    base.memory_status=!memoryEnabled(config)||config.memory.read_enabled===false?"disabled":"available";
    appendFileSync(join(runtimeDir,"context-diagnostics.ndjson"),JSON.stringify({message_id:event.message_id,scope_id:scope.id,
      epoch,budget:base.budget,manifest:base.retrieval_manifest,prepare_ms:performance.now()-started})+"\n");
  } catch { base.memory_status="unavailable";base.history=[];base.activeTasks=[];base.quoted=null;base.confirmed_memories=[]; }
  finally {store?.close();}
  return base;
}

export function verifyContextEpoch(runtimeDir,event,config,epoch) {
  const store=openMemory(runtimeDir);
  try {const scope=store.scope(event,config);store.assertEpoch(scope,epoch);} finally {store.close();}
}

export function recordVerifiedReply(runtimeDir,config,event,reply,epoch) {
  if(reply.deleted||reply.chat_id!==event.chat_id||reply.reply_to!==event.message_id||reply.sender?.open_bot_id!==config.bot_open_id)
    throw new Error("reply_identity_mismatch");
  projectRecord(runtimeDir,config,event,{id:reply.message_id,message_id:event.message_id,reply_id:reply.message_id,
    role:"assistant",content_type:reply.msg_type??"text",body:typeof reply.content==="string"?reply.content:JSON.stringify(reply.content??{}),
    verification:"reply_verified",source_time:new Date().toISOString(),epoch});
}
