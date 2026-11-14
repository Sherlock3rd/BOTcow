import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflows = JSON.parse(
  readFileSync(join(root, "config", "assistant-workflows.json"), "utf8"),
);
const schedule = workflows.scheduling;

function resolveLarkCli() {
  if (process.env.LARK_CLI_EXE) return process.env.LARK_CLI_EXE;
  if (process.platform === "win32" && process.env.APPDATA) {
    return join(
      process.env.APPDATA,
      "npm",
      "node_modules",
      "@larksuite",
      "cli",
      "bin",
      "lark-cli.exe",
    );
  }
  return "lark-cli";
}

function fail(error, details = {}) {
  process.stdout.write(`${JSON.stringify({ ok: false, error, ...details }, null, 2)}\n`);
  process.exit(1);
}

const allRows = [];
let offset = 0;
while (true) {
  const command = spawnSync(
    resolveLarkCli(),
    [
      "base",
      "+record-list",
      "--profile",
      workflows.overdue_alert.profile,
      "--as",
      "bot",
      "--base-token",
      schedule.base_token,
      "--table-id",
      schedule.table_id,
      "--view-id",
      schedule.view_id,
      "--field-id",
      schedule.fields.task,
      "--field-id",
      schedule.fields.status,
      "--field-id",
      schedule.fields.owners,
      "--field-id",
      schedule.fields.next_check_date,
      "--field-id",
      schedule.fields.priority,
      "--field-id",
      schedule.fields.overdue,
      "--filter-json",
      "@config/overdue-filter.json",
      "--offset",
      String(offset),
      "--limit",
      "200",
      "--format",
      "json",
    ],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 120000,
      env: {
        ...process.env,
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
      },
    },
  );
  if (command.error) fail(command.error.message);
  let payload;
  try {
    payload = JSON.parse(command.stdout || command.stderr);
  } catch {
    fail("lark-cli returned invalid JSON", { stderr: command.stderr.trim() });
  }
  if (command.status !== 0 || payload.ok !== true) {
    fail("Base overdue query failed", { details: payload.error ?? payload });
  }
  const data = payload.data?.data ?? [];
  const fields = payload.data?.fields ?? [];
  const recordIds = payload.data?.record_id_list ?? [];
  data.forEach((row, index) => {
    const mapped = Object.fromEntries(fields.map((field, fieldIndex) => [field, row[fieldIndex]]));
    const owners = (mapped[schedule.fields.owners] ?? []).map((owner) => owner.name);
    const nextCheck = mapped[schedule.fields.next_check_date] ?? null;
    const overdueDays = nextCheck
      ? Math.max(
          0,
          Math.floor((Date.now() - new Date(`${nextCheck.replace(" ", "T")}+08:00`).getTime()) / 86400000),
        )
      : null;
    allRows.push({
      record_id: recordIds[index] ?? null,
      task: mapped[schedule.fields.task] ?? "",
      status: (mapped[schedule.fields.status] ?? [])[0] ?? "",
      owners,
      next_check_date: nextCheck,
      priority: (mapped[schedule.fields.priority] ?? [])[0] ?? "",
      overdue: mapped[schedule.fields.overdue] ?? "",
      overdue_days: overdueDays,
    });
  });
  if (!payload.data?.has_more) break;
  offset += data.length;
  if (data.length === 0) fail("Base returned has_more=true with an empty page");
}

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      source_url: schedule.url,
      count: allRows.length,
      items: allRows,
    },
    null,
    2,
  )}\n`,
);
