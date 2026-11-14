import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { modeRecords } from "./bridge-mode.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = join(root, "runtime");
const ledgerPath = join(runtimeDir, "reactions.ndjson");
const config = JSON.parse(readFileSync(join(root, "config", "bridge.json"), "utf8"));

mkdirSync(runtimeDir, { recursive: true });

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

function readLedger() {
  if (!existsSync(ledgerPath)) return [];
  return readFileSync(ledgerPath, "utf8")
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

function output(value, exitCode = 0) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  process.exit(exitCode);
}

const [status, ...args] = process.argv.slice(2);
const messageIdIndex = args.indexOf("--message-id");
const messageId = messageIdIndex >= 0 ? args[messageIdIndex + 1] : "";
const emojiType = config.reaction_types?.[status];

if (!["processing", "done"].includes(status) || !emojiType) {
  output({ ok: false, error: "status must be processing or done" }, 2);
}
if (!/^om_[A-Za-z0-9]+$/.test(messageId)) {
  output({ ok: false, error: "message_id must match om_<letters-or-digits>" }, 2);
}

// Receiving a message or falling back to the tool worker does not make it a task.
const mode = modeRecords(runtimeDir).get(messageId)?.mode ?? "unclassified";
if (mode !== "task") output({ ok: true, skipped: true, message_id: messageId, mode, status });

const existing = readLedger().find(
  (item) =>
    item.message_id === messageId &&
    item.status === status &&
    item.ok === true,
);
if (existing) {
  output({
    ok: true,
    deduplicated: true,
    message_id: messageId,
    status,
    emoji_type: emojiType,
    reaction_id: existing.reaction_id,
  });
}

const command = spawnSync(
  resolveLarkCli(),
  [
    "im",
    "reactions",
    "create",
    "--profile",
    config.profile,
    "--as",
    "bot",
    "--params",
    JSON.stringify({ message_id: messageId }),
    "--data",
    JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
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

if (command.error) output({ ok: false, error: command.error.message }, 1);

let payload;
try {
  payload = JSON.parse(command.stdout || command.stderr);
} catch {
  output(
    {
      ok: false,
      error: "lark-cli returned invalid JSON",
      exit_code: command.status,
      stderr: command.stderr.trim(),
    },
    1,
  );
}
if (command.status !== 0 || payload.ok !== true) {
  output(
    {
      ok: false,
      error: payload.error ?? payload,
      exit_code: command.status,
    },
    1,
  );
}

const record = {
  ok: true,
  message_id: messageId,
  status,
  emoji_type: emojiType,
  reaction_id: payload.data?.reaction_id ?? null,
  created_at: new Date().toISOString(),
};
appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`, "utf8");
output(record);
