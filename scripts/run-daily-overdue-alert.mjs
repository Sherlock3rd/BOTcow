import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = join(root, "runtime");
const logPath = join(runtimeDir, "daily-overdue-alert.log");
const statusPath = join(runtimeDir, "daily-overdue-alert-status.json");
const checkOnly = process.argv.includes("--check-only");

mkdirSync(runtimeDir, { recursive: true });

function timestamp() {
  return new Date().toISOString();
}

function log(message) {
  appendFileSync(logPath, `[${timestamp()}] ${message}\n`, "utf8");
}

function status(state, extra = {}) {
  const payload = { ok: state !== "error", state, updated_at: timestamp(), ...extra };
  writeFileSync(statusPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function runNode(script, args = []) {
  return spawnSync(process.execPath, [join(root, "scripts", script), ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 600000,
    env: {
      ...process.env,
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
      LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
    },
  });
}

try {
  const dayCheck = runNode("is-overdue-alert-day.mjs");
  if (dayCheck.status !== 0) {
    throw new Error(dayCheck.stderr.trim() || dayCheck.stdout.trim() || "alert-day check failed");
  }
  const day = JSON.parse(dayCheck.stdout);
  if (day.ok !== true) throw new Error("alert-day check returned ok=false");

  if (day.should_run !== true) {
    log(`skipped date=${day.date} reason=${day.reason}`);
    status("skipped", { date: day.date, reason: day.reason });
    process.exit(0);
  }

  if (checkOnly) {
    status("check_only", { date: day.date, reason: day.reason });
    process.exit(0);
  }

  const sent = runNode("send-overdue-alert-card.mjs");
  if (sent.status !== 0) {
    throw new Error(sent.stderr.trim() || sent.stdout.trim() || "alert send failed");
  }
  const result = JSON.parse(sent.stdout);
  if (result.ok !== true) throw new Error(result.error?.message || "alert send returned ok=false");

  log(`sent date=${day.date} message_id=${result.data?.message_id ?? "unknown"}`);
  status(result.data?.bugs_complete === false || result.data?.tasks_complete === false ? "sent_with_source_error" : "sent", {
    date: day.date, message_id: result.data?.message_id ?? null,
    message_ids: result.data?.message_ids ?? [], card_count: result.data?.card_count ?? 1,
    bug_count: result.data?.bug_count ?? null, bugs_complete: result.data?.bugs_complete ?? null,
    bug_error: result.data?.bug_error ?? null,
    task_count: result.data?.task_count ?? null, tasks_complete: result.data?.tasks_complete ?? null,
    task_error: result.data?.task_error ?? null,
  });
} catch (error) {
  log(`error ${error.stack ?? error.message}`);
  status("error", { error: error.message });
  process.exit(1);
}
