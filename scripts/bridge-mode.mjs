import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { eligibleMessage } from "./bridge-eligibility.mjs";

export function modeRecords(runtimeDir) {
  const path = join(runtimeDir, "message-modes.ndjson");
  if (!existsSync(path)) return new Map();
  return new Map(readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map(line => {
    const row = JSON.parse(line);
    return [row.message_id, row];
  }));
}

export function recordMode(runtimeDir, event, mode, source, model = null, effort = null) {
  if (!["chat", "task"].includes(mode) || !event.message_id) throw new Error("invalid message mode");
  const existing = modeRecords(runtimeDir).get(event.message_id);
  if (existing) {
    if (existing.mode !== mode) throw new Error("message mode already classified differently");
    return existing;
  }
  const record = { message_id: event.message_id, chat_id: event.chat_id, sender_id: event.sender_id,
    mode, source, model, effort, classified_at: new Date().toISOString() };
  appendFileSync(join(runtimeDir, "message-modes.ndjson"), JSON.stringify(record) + "\n", "utf8");
  return record;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const [mode, ...args] = process.argv.slice(2);
    const i = args.indexOf("--message-id");
    const messageId = i >= 0 ? args[i + 1] : null;
    const config = JSON.parse(readFileSync(join(root, "config/bridge.json"), "utf8"));
    const runtimeDir = join(root, "runtime");
    const event = readFileSync(join(runtimeDir, "inbox.ndjson"), "utf8").split(/\r?\n/)
      .filter(Boolean).map(JSON.parse).find(row => row.message_id === messageId && eligibleMessage(row, config));
    if (!event) throw new Error("message is not admitted");
    const record = recordMode(runtimeDir, event, mode, "worker", config.event_wakeup.model,
      config.event_wakeup.reasoning_effort ?? "high");
    process.stdout.write(JSON.stringify({ ok: true, ...record }) + "\n");
  } catch (error) {
    process.stderr.write(error.message + "\n");
    process.exitCode = 1;
  }
}
