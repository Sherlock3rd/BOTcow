import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { eligibleMessage, usesChatWorker, isPublicGroup, isOwnerSender } from "./bridge-eligibility.mjs";
import { modeRecords } from "./bridge-mode.mjs";
import { openMemory } from "./context-builder.mjs";
import { completeTaskForMessage } from "./task-session-registry.mjs";
import { stopCommand } from "./task-control.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = join(root, "runtime");
const inboxPath = join(runtimeDir, "inbox.ndjson");
const processedPath = join(runtimeDir, "processed.ndjson");
const blockedPath = join(runtimeDir, "blocked.ndjson");
const statusPath = join(runtimeDir, "listener-status.json");

function readNdjson(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? "" : "";
}

function blockedState() {
  const states = new Map();
  for (const item of readNdjson(blockedPath)) {
    if (!item?.message_id) continue;
    states.set(item.message_id, item);
  }
  return states;
}

export function pending(lane) {
  const config = JSON.parse(readFileSync(join(root, "config", "bridge.json"), "utf8"));
  const processed = new Set(readNdjson(processedPath).map((item) => item.message_id));
  const blocked = blockedState();
  const seen = new Set();
  const items = [];
  const fallback = new Map(readNdjson(join(runtimeDir, "greeting-fallback.ndjson")).map(row => [row.message_id, row]));

  for (const event of readNdjson(inboxPath)) {
    const guest=isPublicGroup(event,config);
    if(guest&&(!Number.isFinite(Date.parse(config.group_public?.enabled_at))||!Number.isFinite(Date.parse(event.captured_at))||
      Date.parse(event.captured_at)<Date.parse(config.group_public.enabled_at)))continue;
    if (
      !eligibleMessage(event, config) || stopCommand(event,config) ||
      processed.has(event.message_id) ||
      blocked.get(event.message_id)?.status === "blocked" ||
      seen.has(event.message_id)
    ) continue;
    seen.add(event.message_id);
    const direct = guest || (!fallback.has(event.message_id) && usesChatWorker(event, config));
    if (lane && (lane === "--greetings") !== direct) continue;
    items.push(!guest && fallback.has(event.message_id) && fallback.get(event.message_id).reason !== "task"
      ? { ...event, greeting_recovery: true } : event);
  }

  const blockedCount = [...blocked.values()].filter((item) => item.status === "blocked").length;
  // Public traffic must not keep admitted owner requests behind a visitor backlog.
  items.sort((a,b)=>Number(isPublicGroup(a,config))-Number(isPublicGroup(b,config)));
  return { ok: true, pending: items.slice(0, 20), blocked_count: blockedCount };
}

function mark(args) {
  const messageId = argValue(args, "--message-id");
  const replyId = argValue(args, "--reply-id");

  if (!messageId) {
    process.stderr.write("--message-id is required\n");
    process.exit(2);
  }

  const mode = modeRecords(runtimeDir).get(messageId)?.mode;
  if (!mode || (mode === "task" && !readNdjson(join(runtimeDir, "reactions.ndjson"))
    .some(row => row.message_id === messageId && row.status === "done" && row.ok === true))) {
    process.stderr.write("classify the message first; tasks require a successful DONE before mark\n");
    process.exit(2);
  }

  // The processed ledger and task registry are separate stores. Settle any
  // mapped owner task before publishing processed so stale active tasks cannot
  // leak into later prompts. Public guest traffic deliberately has no memory
  // scope and therefore skips this step.
  const config = JSON.parse(readFileSync(join(root, "config", "bridge.json"), "utf8"));
  const event = readNdjson(inboxPath).find((item) => item.message_id === messageId);
  if (config.memory?.task_isolation === true && event && isOwnerSender(event, config)) {
    const store = openMemory(runtimeDir);
    try { completeTaskForMessage(store, store.scope(event, config), messageId); }
    finally { store.close(); }
  }

  appendFileSync(
    processedPath,
    `${JSON.stringify({
      message_id: messageId,
      reply_id: replyId || null,
      mode,
      processed_at: new Date().toISOString(),
    })}\n`,
    "utf8",
  );
  process.stdout.write(`${JSON.stringify({ ok: true, message_id: messageId, reply_id: replyId || null })}\n`);
}

function block(args) {
  const messageId = argValue(args, "--message-id");
  const errorType = argValue(args, "--error-type");
  const errorFingerprint = argValue(args, "--error-fingerprint");
  const reason = argValue(args, "--reason");
  const recoveryCondition = argValue(args, "--recovery-condition");

  if (!messageId || !errorType || !errorFingerprint || !reason || !recoveryCondition) {
    process.stderr.write(
      "--message-id, --error-type, --error-fingerprint, --reason and --recovery-condition are required\n",
    );
    process.exit(2);
  }

  const existing = blockedState().get(messageId);
  if (
    existing?.status === "blocked" &&
    existing.error_fingerprint === errorFingerprint
  ) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, deduplicated: true, message_id: messageId, status: "blocked" })}\n`,
    );
    return;
  }

  appendFileSync(
    blockedPath,
    `${JSON.stringify({
      message_id: messageId,
      status: "blocked",
      error_type: errorType,
      error_fingerprint: errorFingerprint,
      reason,
      recovery_condition: recoveryCondition,
      blocked_at: new Date().toISOString(),
    })}\n`,
    "utf8",
  );
  process.stdout.write(
    `${JSON.stringify({ ok: true, message_id: messageId, status: "blocked" })}\n`,
  );
}

function unblock(args) {
  const messageId = argValue(args, "--message-id");
  if (!messageId) {
    process.stderr.write("--message-id is required\n");
    process.exit(2);
  }

  const existing = blockedState().get(messageId);
  if (existing?.status !== "blocked") {
    process.stdout.write(
      `${JSON.stringify({ ok: true, deduplicated: true, message_id: messageId, status: "unblocked" })}\n`,
    );
    return;
  }

  appendFileSync(
    blockedPath,
    `${JSON.stringify({
      message_id: messageId,
      status: "unblocked",
      unblocked_at: new Date().toISOString(),
    })}\n`,
    "utf8",
  );
  process.stdout.write(
    `${JSON.stringify({ ok: true, message_id: messageId, status: "unblocked" })}\n`,
  );
}

function status() {
  const inbox = readNdjson(inboxPath);
  const processed = readNdjson(processedPath);
  const blocked = [...blockedState().values()].filter((item) => item.status === "blocked");
  const listener = existsSync(statusPath)
    ? JSON.parse(readFileSync(statusPath, "utf8"))
    : { status: "not_started" };
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      listener,
      received_count: inbox.length,
      processed_count: processed.length,
      blocked_count: blocked.length,
      blocked,
    }, null, 2)}\n`,
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "pending") process.stdout.write(JSON.stringify(pending(args[0]), null, 2) + "\n");
  else if (command === "mark") mark(args);
  else if (command === "block") block(args);
  else if (command === "unblock") unblock(args);
  else if (command === "status") status();
  else {
    process.stderr.write("usage: node scripts/bridge-queue.mjs <pending|mark|block|unblock|status>\n");
    process.exit(2);
  }
}
