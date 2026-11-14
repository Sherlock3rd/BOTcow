import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const messageId = process.argv[2] ?? "";
const cardArg = process.argv[3] ?? "";
const idempotencyKey = process.argv[4] ?? "";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (!/^om_[A-Za-z0-9]+$/.test(messageId)) fail("invalid message_id");
if (!cardArg || isAbsolute(cardArg)) fail("card path must be cwd-relative");
if (!idempotencyKey || idempotencyKey.length > 50) fail("invalid idempotency key");

const cardPath = resolve(root, cardArg);
const relativePath = relative(root, cardPath);
if (relativePath.startsWith("..") || isAbsolute(relativePath)) fail("card path escapes project root");
if (!existsSync(cardPath)) fail(`card file not found: ${cardArg}`);

const card = JSON.parse(readFileSync(cardPath, "utf8"));
if (card.schema !== "2.0") fail("only Card 2.0 payloads are supported");

const executable = process.platform === "win32" && process.env.APPDATA
  ? join(process.env.APPDATA, "npm", "node_modules", "@larksuite", "cli", "bin", "lark-cli.exe")
  : "lark-cli";
const args = [
  "im", "+messages-reply",
  "--profile", "botCow",
  "--as", "bot",
  "--message-id", messageId,
  "--msg-type", "interactive",
  "--content", JSON.stringify(card),
  "--idempotency-key", idempotencyKey,
  "--format", "json",
];

const sent = spawnSync(executable, args, {
  cwd: root,
  encoding: "utf8",
  timeout: 120000,
  env: {
    ...process.env,
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
  },
});
process.stdout.write(sent.stdout || sent.stderr);
process.exit(sent.status ?? 1);
