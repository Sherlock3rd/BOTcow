import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { modeRecords } from "./bridge-mode.mjs";
import { eligibleMessage } from "./bridge-eligibility.mjs";

export function chatContext(runtimeDir, event, config = null) {
  function rows(name) {
    const path = join(runtimeDir, name + ".ndjson");
    return existsSync(path) ? readFileSync(path, "utf8").trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : [];
  }
  const receipts = rows("greeting-replies");
  const sent = new Map(receipts.map(r => [r.message_id, r]));
  const processed = new Map(rows("processed").map(r => [r.message_id, r.reply_id]));
  const modes = modeRecords(runtimeDir);
  const blocked = new Map(rows("blocked").map(r => [r.message_id, r.status]));
  const turns = new Map();
  for (const msg of rows("inbox")) {
    if (msg.message_id === event.message_id) break;
    if (msg.chat_id !== event.chat_id || msg.sender_id !== event.sender_id) continue;
    if (config && !eligibleMessage(msg, config)) continue;
    const receipt = sent.get(msg.message_id);
    turns.set(msg.message_id, { message_id: msg.message_id, reply_id: receipt?.reply_id ?? processed.get(msg.message_id),
      user: String(msg.content ?? "").slice(0, 1000), reply: receipt?.text?.slice(0, 1000) ?? null,
      mode: modes.get(msg.message_id)?.mode ?? (receipt ? "chat" : "unknown"),
      status: processed.has(msg.message_id) ? "completed" : blocked.get(msg.message_id) === "blocked" ? "blocked" : "pending" });
  }
  const all = [...turns.values()], history = all.filter(t => t.status === "completed").slice(-6);
  const activeTasks = all.filter(t => t.mode === "task" && t.status !== "completed").slice(-3);
  const parent = event.reply_to || event.root_id;
  const quoted = parent && all.find(turn => turn.message_id === parent || turn.reply_id === parent);
  return { history, activeTasks, quoted, missingReference: Boolean(parent && !quoted),
    previousReply: sent.get(event.message_id), question: event.content,
    now: new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", weekday: "long",
      year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "numeric" }) };
}
