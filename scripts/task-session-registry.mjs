import { randomUUID } from "node:crypto";

export function taskSession(store,scope,event,context,profileVersion,rotationDays=30) {
  return store.transaction(()=>{
    const epoch=store.epoch(scope), db=store.db;
    let mapping=db.prepare("SELECT task_id FROM task_messages WHERE scope=? AND message_id=?").get(scope.id,event.message_id);
    let taskId=mapping?.task_id;
    if(!taskId) {
      for(const reference of [event.reply_to,event.root_id].filter(Boolean)) {
        const source=db.prepare("SELECT message_id FROM records WHERE scope=? AND (id=? OR reply_id=?) AND epoch=? AND suppressed=0").get(scope.id,reference,reference,epoch);
        const linked=db.prepare("SELECT task_id FROM task_messages WHERE scope=? AND message_id=?").get(scope.id,source?.message_id??reference);
        if(linked){taskId=linked.task_id;break;}
      }
      // Only explicit continuations bind automatically; ambiguity creates a fresh
      // clarification thread instead of selecting the most recent unrelated task.
      if(!taskId&&/^(?:继续|接着|按.{1,12}(?:做|方案)|已授权|完成授权|确认)[。！!\s]*$/.test(String(event.content))) {
        const active=db.prepare("SELECT id FROM tasks WHERE scope=? AND epoch=? AND status='active'").all(scope.id,epoch);
        if(active.length===1) taskId=active[0].id;
        else if(active.length>1) return {ambiguous:true,epoch};
      }
      taskId??="task_"+randomUUID();
      db.prepare("INSERT OR IGNORE INTO tasks VALUES (?,?,?,?,?,?)").run(scope.id,taskId,event.message_id,String(event.content??""),"active",epoch);
      db.prepare("INSERT INTO task_messages VALUES (?,?,?)").run(scope.id,event.message_id,taskId);
    }
    // A referenced follow-up may resume a task which was already settled by a
    // previous DONE/mark. Make the lifecycle explicit while this message is in
    // flight; bridge-queue settles it again only after delivery is verified.
    const priorStatus=db.prepare("SELECT status FROM tasks WHERE scope=? AND id=?").get(scope.id,taskId)?.status;
    db.prepare("UPDATE tasks SET status='active' WHERE scope=? AND id=? AND epoch=?")
      .run(scope.id,taskId,epoch);
    const row=db.prepare("SELECT * FROM threads WHERE scope=? AND task_id=?").get(scope.id,taskId);
    const valid=!['blocked','cancelled'].includes(priorStatus)&&row&&row.epoch===epoch&&row.profile_version===profileVersion&&Date.now()-Date.parse(row.started_at)<rotationDays*86400000;
    return {task_id:taskId,thread_id:valid?row.thread_id:null,epoch,profile_version:profileVersion};
  });
}

export function completeTaskForMessage(store,scope,messageId) {
  return store.transaction(()=>{
    const epoch=store.epoch(scope);
    const mapping=store.db.prepare("SELECT task_id FROM task_messages WHERE scope=? AND message_id=?")
      .get(scope.id,messageId);
    if(!mapping) return {updated:false,task_id:null};
    const result=store.db.prepare("UPDATE tasks SET status='completed' WHERE scope=? AND id=? AND epoch=?")
      .run(scope.id,mapping.task_id,epoch);
    return {updated:result.changes>0,task_id:mapping.task_id};
  });
}
export function saveTaskThread(store,scope,session,threadId) {
  store.transaction(()=>{
    store.assertEpoch(scope,session.epoch);
    store.db.prepare(`INSERT INTO threads VALUES (?,?,?,?,?,?) ON CONFLICT(scope,task_id) DO UPDATE SET
      thread_id=excluded.thread_id,epoch=excluded.epoch,profile_version=excluded.profile_version,started_at=excluded.started_at`)
      .run(scope.id,session.task_id,threadId,session.epoch,session.profile_version,new Date().toISOString());
  });
}

export function taskContext(store,scope,session) {
  if(!session.task_id) return null;
  const task=store.db.prepare("SELECT id,goal,status FROM tasks WHERE scope=? AND id=? AND epoch=?").get(scope.id,session.task_id,session.epoch);
  const records=store.db.prepare(`SELECT r.id,r.role,r.content_type,r.body,r.verification FROM records r
    JOIN task_messages t ON t.scope=r.scope AND t.message_id=r.message_id
    WHERE t.scope=? AND t.task_id=? AND r.epoch=? AND r.suppressed=0 ORDER BY r.rowid`).all(scope.id,session.task_id,session.epoch);
  let size=0;const included=[],omitted=[];
  for(const record of records) {
    if(size+record.body.length>18000){omitted.push(record.id);continue;}
    size+=record.body.length;included.push(record);
  }
  return {task,records:included,omitted_record_ids:omitted,requires_source_read:omitted.length>0};
}
