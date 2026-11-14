import { DatabaseSync } from "node:sqlite";
import { mkdirSync,readdirSync,writeFileSync } from "node:fs";
import { dirname,join } from "node:path";
import { digest, memoryScope, validateMemoryCommand, safeMemoryBody, messageText } from "./memory-policy.mjs";

// No native npm dependency: deployed and tested with Node 22.17.1 / SQLite 3.50.0.
// DELETE journal + FULL sync: short serialized transactions, no WAL copy hazards.
export class MemoryStore {
  constructor(path) {
    this.directory=dirname(path);
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { timeout: 3000 });
    try { this.db.exec(`PRAGMA busy_timeout=3000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS scopes(id TEXT PRIMARY KEY, binding TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, scope TEXT NOT NULL, message_id TEXT NOT NULL,
        reply_id TEXT, role TEXT NOT NULL, content_type TEXT NOT NULL, body TEXT NOT NULL, verification TEXT NOT NULL,
        source_time TEXT NOT NULL, epoch INTEGER NOT NULL, suppressed INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS records_scope ON records(scope,epoch,source_time);
      CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, scope TEXT NOT NULL, value TEXT NOT NULL,
        status TEXT NOT NULL, revision INTEGER NOT NULL, source_id TEXT NOT NULL, origin TEXT NOT NULL,
        confirmed_by TEXT NOT NULL, confirmed_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS memories_scope ON memories(scope,status);
      CREATE TABLE IF NOT EXISTS revisions(memory_id TEXT, revision INTEGER, scope TEXT NOT NULL, value TEXT NOT NULL,
        status TEXT NOT NULL, source_id TEXT NOT NULL, PRIMARY KEY(memory_id,revision));
      CREATE TABLE IF NOT EXISTS commands(scope TEXT, message_id TEXT, result TEXT NOT NULL, epoch INTEGER NOT NULL,
        PRIMARY KEY(scope,message_id));
      CREATE TABLE IF NOT EXISTS tasks(scope TEXT, id TEXT, source_id TEXT NOT NULL, goal TEXT NOT NULL,
        status TEXT NOT NULL, epoch INTEGER NOT NULL, PRIMARY KEY(scope,id));
      CREATE TABLE IF NOT EXISTS task_messages(scope TEXT, message_id TEXT, task_id TEXT NOT NULL,
        PRIMARY KEY(scope,message_id));
      CREATE TABLE IF NOT EXISTS threads(scope TEXT, task_id TEXT, thread_id TEXT NOT NULL, epoch INTEGER NOT NULL,
        profile_version TEXT NOT NULL, started_at TEXT NOT NULL, PRIMARY KEY(scope,task_id));
      CREATE TABLE IF NOT EXISTS projection_entries(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS projection_cursor(id INTEGER PRIMARY KEY CHECK(id=1),offset INTEGER NOT NULL);
      PRAGMA user_version=1;`); }
    catch(error) {this.db.close();throw error;}
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  scope(event, config) {
    const scope = memoryScope(event, config);
    this.db.prepare("INSERT OR IGNORE INTO scopes(id,binding) VALUES (?,?)").run(scope.id, JSON.stringify(scope.binding));
    const epoch=this.epoch(scope),prefix=`memory-epoch-${scope.id}-`;
    const versions=readdirSync(this.directory).filter(name=>name.startsWith(prefix)&&name.endsWith(".fence"))
      .map(name=>Number(name.slice(prefix.length,-6)));
    if(versions.some(version=>version>epoch)) throw new Error("memory_restore_behind_epoch_fence");
    try {writeFileSync(join(this.directory,`${prefix}${epoch}.fence`),"",{flag:"wx"});}
    catch(error){if(error.code!=="EEXIST") throw error;}
    return scope;
  }
  epoch(scope) { return this.db.prepare("SELECT epoch FROM scopes WHERE id=?").get(scope.id)?.epoch; }
  assertEpoch(scope, epoch) { if (this.epoch(scope) !== epoch) throw new Error("stale_memory_context"); }
  record(scope, entry) {
    const prior = this.db.prepare("SELECT scope FROM records WHERE id=?").get(entry.id);
    if (prior && prior.scope !== scope.id) throw new Error("record_scope_collision");
    this.db.prepare(`INSERT INTO records(id,scope,message_id,reply_id,role,content_type,body,verification,source_time,epoch)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,verification=excluded.verification
      WHERE records.suppressed=0 AND records.verification!='reply_verified'`).run(entry.id, scope.id, entry.message_id,
      entry.reply_id ?? null, entry.role, entry.content_type, safeMemoryBody(entry.body), entry.verification,
      entry.source_time, entry.epoch ?? this.epoch(scope));
  }
  list(scope) {
    return this.db.prepare("SELECT * FROM memories WHERE scope=? AND status='confirmed' ORDER BY confirmed_at DESC,id").all(scope.id);
  }
  recall(scope, query = "", limit = 8) {
    const terms = [...new Set(String(query).toLowerCase().match(/[a-z0-9_]+|[\u3400-\u9fff]{2}/g) ?? [])];
    return this.list(scope).map(row => ({ ...row, score: terms.reduce((n,t) => n + Number(row.value.toLowerCase().includes(t)), 0) }))
      .sort((a,b) => b.score-a.score).slice(0,limit);
  }
  recent(scope) {
    return this.db.prepare("SELECT * FROM records WHERE scope=? AND epoch=? AND suppressed=0 ORDER BY rowid DESC LIMIT 36")
      .all(scope.id,this.epoch(scope)).reverse();
  }
  priorCommand(scope, messageId) {
    const prior = this.db.prepare("SELECT * FROM commands WHERE scope=? AND message_id=?").get(scope.id,messageId);
    if (!prior) return null;
    if (prior.epoch !== this.epoch(scope)) return { text: "这条记忆操作已处理，之后记忆有更新；请以当前记忆为准。", epoch: this.epoch(scope), replay: true };
    return { ...JSON.parse(prior.result), replay: true };
  }
  manage(event, config, input) {
    const scope = this.scope(event, config), command = validateMemoryCommand(event,input);
    return this.transaction(() => {
      const prior = this.priorCommand(scope,event.message_id);
      if (prior) return prior;
      const all = this.list(scope);
      let text, memory = null;
      if (command.operation === "list") {
        const selected=command.target?all.filter(m=>m.id===command.target||m.value.includes(command.target)):all;
        let budget=5000;const visible=selected.filter(m=>{if(m.value.length>budget)return false;budget-=m.value.length+80;return true;});
        text = selected.length ? `当前对话已确认的记忆（共 ${selected.length} 条）：\n` + visible.map(m => `• ${m.value}（${m.id}，版本 ${m.revision}）`).join("\n")+
          (visible.length<selected.length?"\n内容较多，以上仅显示部分；请指定主题查看其余记忆。":"") : "当前对话还没有符合查询的已确认长期记忆。";
      } else {
        if (command.operation === "save") {
          const same = all.find(m => m.value === command.value);
          if (same) memory = same;
          else memory = { id: "mem_"+digest(scope.id+event.message_id).slice(0,20), revision: 0 };
        } else {
          const target = command.target ?? "";
          const normalized = target.replace(/^(?:刚才|之前|这个|那个|这条|那条|我的|的|记忆|偏好|口径|格式)+/g, "");
          const reference = event.reply_to || event.root_id;
          const source = reference && this.db.prepare("SELECT message_id FROM records WHERE scope=? AND (id=? OR reply_id=?)").get(scope.id,reference,reference);
          const candidates = all.filter(m => (m.id === target && (all.length===1 || messageText(event).includes(m.id) ||
            messageText(event).includes(m.value) || (source && m.source_id===source.message_id))) || m.value === target ||
            (normalized.length >= 2 && m.value.includes(normalized)) || (source && m.source_id === source.message_id) ||
            (all.length===1 && /^(?:刚才|之前|这个|那个|这条|那条).*(?:偏好|记忆|口径)$/.test(target)));
          if (candidates.length !== 1) return { text: "请指出要修改或停止使用的记忆内容或记忆 ID；当前无法唯一确定。", epoch: this.epoch(scope), clarification: true };
          memory = candidates[0];
          if (command.expected_revision != null && command.expected_revision !== memory.revision) throw new Error("memory_revision_conflict");
          const sourceTime = event.create_time ?? event.captured_at;
          const numeric = Number(sourceTime);
          const millis = Number.isFinite(numeric) && numeric > 0 ? (numeric < 1e12 ? numeric*1000 : numeric) : Date.parse(sourceTime);
          const priorSource=this.db.prepare("SELECT source_time FROM records WHERE scope=? AND id=?").get(scope.id,memory.source_id);
          if (Number.isFinite(millis) && priorSource && millis < Date.parse(priorSource.source_time)) throw new Error("stale_memory_instruction");
        }
        const noChange = command.operation === "save" && memory.value === command.value;
        if (!noChange) {
          if (command.operation !== "save") {
            // Conservatively invalidate all older context in this audience, including replies
            // which may have repeated the preference. Keep original ledgers for audit only.
            this.db.prepare("UPDATE scopes SET epoch=epoch+1 WHERE id=?").run(scope.id);
            this.db.prepare("UPDATE records SET suppressed=1 WHERE scope=?").run(scope.id);
            this.db.prepare("DELETE FROM threads WHERE scope=?").run(scope.id);
          }
          const status = command.operation === "forget" ? "inactive" : "confirmed";
          const value = command.value ?? memory.value;
          const revision = memory.revision+1, now = new Date().toISOString();
          this.db.prepare(`INSERT INTO memories VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
            value=excluded.value,status=excluded.status,revision=excluded.revision,source_id=excluded.source_id,
            confirmed_by=excluded.confirmed_by,confirmed_at=excluded.confirmed_at`).run(memory.id,scope.id,value,status,revision,event.message_id,"explicit_user",scope.owner,now);
          this.db.prepare("INSERT INTO revisions VALUES (?,?,?,?,?,?)").run(memory.id,revision,scope.id,value,status,event.message_id);
          memory = { ...memory, value, revision };
        }
        text = command.operation === "forget" ? "已停止在后续回答中使用这条记忆。这不会删除飞书原消息或备份。" :
          `已${command.operation === "update" ? "更新" : "记住"}：${memory.value}（${memory.id}）`;
      }
      const result = { text, epoch: this.epoch(scope), memory_id: memory?.id ?? null };
      this.db.prepare("INSERT INTO commands VALUES (?,?,?,?)").run(scope.id,event.message_id,JSON.stringify(result),result.epoch);
      return result;
    });
  }
}
