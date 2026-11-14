import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { shanghaiDate } from "./daily-alert-card.mjs";
import { deliverDailyCards } from "./daily-alert-delivery.mjs";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflows = JSON.parse(readFileSync(join(root, "config", "assistant-workflows.json"), "utf8"));
const dryRun = process.argv.includes("--dry-run");
const simulate = process.argv.includes("--simulate-empty");
const replyMessageId = process.argv.slice(2).find(a => !a.startsWith("--")) || "";
if (replyMessageId && !/^om_[A-Za-z0-9]+$/.test(replyMessageId)) throw new Error("Invalid reply message ID");
if (simulate && !dryRun) throw new Error("Simulation is only available with --dry-run");
const executable = process.env.LARK_CLI_EXE || (process.platform === "win32" && process.env.APPDATA
  ? join(process.env.APPDATA, "npm", "node_modules", "@larksuite", "cli", "bin", "lark-cli.exe") : "lark-cli");
function im(command, args) {
  const result = spawnSync(executable, ["im", command, "--profile", workflows.overdue_alert.profile, "--as", "bot", ...args, "--format", "json"], {
    cwd: root, encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 8*1024*1024,
    env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1" },
  });
  let payload;
  try { payload = JSON.parse(result.stdout); } catch { throw new Error("Feishu message request failed"); }
  if (result.status !== 0 || payload.ok !== true) throw new Error("Feishu message request failed");
  return payload.data;
}
function build() {
  const result = spawnSync(process.execPath, [join(root, "scripts", "build-overdue-alert-card.mjs"), ...(simulate ? ["--simulate-empty"] : [])], {
    cwd: root, encoding: "utf8", windowsHide: true, timeout: 100000, maxBuffer: 8*1024*1024,
  });
  if (result.status !== 0) throw new Error("Card build failed");
  const built = JSON.parse(result.stdout);
  if (!built.ok || !built.cards?.length) throw new Error("Card build failed");
  return built;
}
const key = replyMessageId ? `bc-daily-${createHash("sha256").update(replyMessageId).digest("hex").slice(0,24)}` : `bc-daily-${shanghaiDate().replaceAll("-", "")}`;
const directory = join(root, "runtime", "daily-alert-deliveries");
const path = join(directory, `${key}.json`);
const lockPath = `${path}.lock`;
let lock;
try {
  if (dryRun) {
    console.log(JSON.stringify({ ...build(), dry_run: true, writes_attempted: 0 }));
  } else {
    mkdirSync(directory, { recursive: true });
    lock = openSync(lockPath, "wx");
    const save = plan => { writeFileSync(`${path}.tmp`, JSON.stringify(plan), "utf8"); renameSync(`${path}.tmp`, path); };
    let plan;
    if (existsSync(path)) plan = JSON.parse(readFileSync(path, "utf8"));
    else {
      // Respect deliveries made by the previous runner earlier on the migration day.
      const oldStatusPath = join(root, "runtime", "daily-overdue-alert-status.json");
      const old = existsSync(oldStatusPath) ? JSON.parse(readFileSync(oldStatusPath, "utf8")) : null;
      if (!replyMessageId && old?.date === shanghaiDate() && ["sent", "sent_with_source_error"].includes(old.state)) {
        console.log(JSON.stringify({ok:true, already_sent:true, data:{message_id:old.message_id}}));
      } else {
        const built = build();
        plan = { key, date: built.date, chat_id: workflows.overdue_alert.chat_id, reply_message_id: replyMessageId,
          cards: built.cards, bug_count: built.bug_count, bug_scope: built.bug_scope, bugs_complete: built.bugs_complete, bug_error: built.bug_error,
          task_count: built.task_count, tasks_scope: built.tasks_scope, tasks_complete: built.tasks_complete, task_error: built.task_error, receipts: [] };
        save(plan);
      }
    }
    if (plan) {
      if (plan.chat_id !== workflows.overdue_alert.chat_id || plan.key !== key || plan.bug_scope !== "related_to_current_user") throw new Error("Delivery target or scope changed");
      const alreadyComplete = plan.receipts.length === plan.cards.length && plan.receipts.every(r => r?.verified);
      if (workflows.personal_tasks?.enabled && plan.tasks_scope !== "assigned_to_me_incomplete" && !alreadyComplete)
        throw new Error("Pending delivery snapshot lacks personal task scope");
      console.log(JSON.stringify(deliverDailyCards(plan, im, save)));
    }
  }
} catch (error) {
  console.log(JSON.stringify({ok:false,error: error.code === "EEXIST" ? "daily_alert_locked" : error.message}));
  process.exitCode = 1;
} finally {
  if (lock !== undefined) { closeSync(lock); unlinkSync(lockPath); }
}
