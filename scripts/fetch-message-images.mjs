import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(
  await import("node:fs/promises").then(({ readFile }) =>
    readFile(join(root, "config", "bridge.json"), "utf8"),
  ),
);

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

function fail(message, details = {}) {
  process.stdout.write(
    `${JSON.stringify({ ok: false, error: message, ...details }, null, 2)}\n`,
  );
  process.exit(1);
}

const messageId = process.argv[2] ?? "";
if (!/^om_[A-Za-z0-9]+$/.test(messageId)) {
  fail("message_id must match om_<letters-or-digits>");
}

const targetDir = resolve(root, "runtime", "inbound", messageId);
mkdirSync(targetDir, { recursive: true });

const command = spawnSync(
  resolveLarkCli(),
  [
    "im",
    "+messages-mget",
    "--profile",
    config.profile,
    "--as",
    "bot",
    "--message-ids",
    messageId,
    "--no-reactions",
    "--download-resources",
    "--format",
    "json",
  ],
  {
    cwd: targetDir,
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
if (command.status !== 0) {
  fail("lark-cli image download failed", {
    exit_code: command.status,
    stderr: command.stderr.trim(),
  });
}

let payload;
try {
  payload = JSON.parse(command.stdout);
} catch {
  fail("lark-cli returned invalid JSON", { stderr: command.stderr.trim() });
}
if (payload.ok !== true) fail("lark-cli returned ok=false");

const messages = payload.data?.messages ?? [];
const images = [];
for (const message of messages) {
  for (const resource of message.resources ?? []) {
    if (resource.type !== "image") continue;
    if (resource.error || !resource.local_path) fail("an image resource could not be downloaded");
    const candidate = isAbsolute(resource.local_path)
      ? resolve(resource.local_path)
      : resolve(targetDir, resource.local_path);
    const escaped = relative(targetDir, candidate);
    if (escaped.startsWith("..") || isAbsolute(escaped) || !existsSync(candidate)) {
      fail("downloaded image escaped the message directory or is missing", {
        local_path: resource.local_path,
      });
    }
    images.push({
      key: resource.key,
      size_bytes: resource.size_bytes,
      absolute_path: candidate,
    });
  }
}

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      message_id: messageId,
      message_type: messages[0]?.msg_type ?? null,
      content: messages[0]?.content ?? "",
      directory: targetDir,
      images,
    },
    null,
    2,
  )}\n`,
);
