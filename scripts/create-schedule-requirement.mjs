import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
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

function dateValue(value, name) {
  if (value == null || value === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/.test(value)) {
    fail(`${name} must be YYYY-MM-DD or YYYY-MM-DD HH:mm:ss`);
  }
  return value.length === 10 ? `${value} 00:00:00` : value;
}

const specPath = process.argv[2];
if (!specPath) fail("usage: node scripts/create-schedule-requirement.mjs <spec.json>");
const spec = JSON.parse(readFileSync(resolve(specPath), "utf8"));
if (typeof spec.task !== "string" || !spec.task.trim()) fail("task is required");

const status = spec.status ?? "待进行";
if (!schedule.status_options.includes(status)) fail("invalid status", { allowed: schedule.status_options });
if (spec.priority && !schedule.priority_options.includes(spec.priority)) {
  fail("invalid priority", { allowed: schedule.priority_options });
}
for (const department of spec.departments ?? []) {
  if (!schedule.department_options.includes(department)) {
    fail("invalid department", { department, allowed: schedule.department_options });
  }
}
for (const owner of spec.owners ?? []) {
  if (!/^ou_[A-Za-z0-9]+$/.test(owner)) fail("owner IDs must be current-app open_id values");
}
for (const recordId of spec.plan_link_record_ids ?? []) {
  if (!/^rec[A-Za-z0-9]+$/.test(recordId)) fail("plan link values must be Base record IDs");
}

const fields = {
  [schedule.fields.task]: spec.task.trim(),
  [schedule.fields.status]: status,
};
const optional = [
  [schedule.fields.status_note, spec.status_note],
  [schedule.fields.start_date, dateValue(spec.start_date, "start_date")],
  [schedule.fields.next_check_date, dateValue(spec.next_check_date, "next_check_date")],
  [schedule.fields.end_date, dateValue(spec.end_date, "end_date")],
  [schedule.fields.priority, spec.priority],
];
for (const [field, value] of optional) {
  if (value != null && value !== "") fields[field] = value;
}
if ((spec.owners ?? []).length) {
  fields[schedule.fields.owners] = spec.owners.map((id) => ({ id }));
}
if ((spec.departments ?? []).length) {
  fields[schedule.fields.departments] = spec.departments;
}
if ((spec.plan_link_record_ids ?? []).length) {
  fields[schedule.fields.plan_link] = spec.plan_link_record_ids.map((id) => ({ id }));
}

const create = spawnSync(
  resolveLarkCli(),
  [
    "base",
    "+record-batch-create",
    "--profile",
    workflows.overdue_alert.profile,
    "--as",
    "user",
    "--base-token",
    schedule.base_token,
    "--table-id",
    schedule.table_id,
    "--json",
    JSON.stringify({ create_records: [fields] }),
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
if (create.error) fail(create.error.message);
let createPayload;
try {
  createPayload = JSON.parse(create.stdout || create.stderr);
} catch {
  fail("record create returned invalid JSON", { stderr: create.stderr.trim() });
}
if (create.status !== 0 || createPayload.ok !== true) {
  fail("record create failed", { details: createPayload.error ?? createPayload });
}

const recordIds = createPayload.data?.record_id_list ?? [];
if (recordIds.length !== 1) {
  fail("record create succeeded but returned an unexpected record count", {
    record_id_list: recordIds,
  });
}
const recordId = recordIds[0];
const readback = spawnSync(
  resolveLarkCli(),
  [
    "base",
    "+record-get",
    "--profile",
    workflows.overdue_alert.profile,
    "--as",
    "user",
    "--base-token",
    schedule.base_token,
    "--table-id",
    schedule.table_id,
    "--record-id",
    recordId,
    "--field-id",
    schedule.fields.task,
    "--field-id",
    schedule.fields.status,
    "--field-id",
    schedule.fields.owners,
    "--field-id",
    schedule.fields.start_date,
    "--field-id",
    schedule.fields.next_check_date,
    "--field-id",
    schedule.fields.end_date,
    "--field-id",
    schedule.fields.priority,
    "--field-id",
    schedule.fields.overdue,
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
if (readback.error) fail(readback.error.message, { record_id: recordId, created: true });
let readbackPayload;
try {
  readbackPayload = JSON.parse(readback.stdout || readback.stderr);
} catch {
  fail("record readback returned invalid JSON", { record_id: recordId, created: true });
}
if (readback.status !== 0 || readbackPayload.ok !== true) {
  fail("record created but readback failed", {
    record_id: recordId,
    created: true,
    details: readbackPayload.error ?? readbackPayload,
  });
}

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      record_id: recordId,
      submitted_fields: fields,
      readback: readbackPayload.data,
      source_url: schedule.url,
    },
    null,
    2,
  )}\n`,
);
