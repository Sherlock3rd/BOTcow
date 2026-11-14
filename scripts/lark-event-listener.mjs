import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eligibleMessage, usesChatWorker } from "./bridge-eligibility.mjs";
import { applyMembership, membershipKeys } from "./group-membership.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = join(root, "runtime");
const configPath = join(root, "config", "bridge.json");
const inboxPath = join(runtimeDir, "inbox.ndjson");
const logPath = join(runtimeDir, "listener.log");
const pidPath = join(runtimeDir, "listener.pid");
const statusPath = join(runtimeDir, "listener-status.json");
const stopPath = join(runtimeDir, "stop.requested");
const wakeupScript = join(root, "scripts", "codex-event-wakeup.mjs");

mkdirSync(runtimeDir, { recursive: true });
const config = JSON.parse(readFileSync(configPath, "utf8"));

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

if (existsSync(pidPath)) {
  const existingPid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
  if (isProcessAlive(existingPid)) {
    process.stderr.write(`listener already running pid=${existingPid}\n`);
    process.exit(0);
  }
}

if (existsSync(stopPath)) rmSync(stopPath, { force: true });
writeFileSync(pidPath, String(process.pid), "utf8");

let child = null;
let stopping = false;
let restartDelayMs = 1000;
const taskWorker = { args: [], name: "codex", child: null, requested: false, timer: null };
const greetingWorker = { args: ["--greetings"], name: "greeting", child: null, requested: false, timer: null };
const membershipConsumers = new Map(membershipKeys.map(key => [key, { child: null, timer: null, delay: 1000 }]));

function timestamp() {
  return new Date().toISOString();
}

function writeStatus(status, extra = {}) {
  writeFileSync(
    statusPath,
    `${JSON.stringify({ status, pid: process.pid, updated_at: timestamp(), ...extra }, null, 2)}\n`,
    "utf8",
  );
}

function log(message) {
  appendFileSync(logPath, `[${timestamp()}] ${message}\n`, "utf8");
}

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

function consumeLines(stream, onLine) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    while (true) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) onLine(line);
    }
  });
  stream.on("end", () => {
    const line = buffer.trim();
    if (line) onLine(line);
  });
}

function eligible(event) {
  return eligibleMessage(event, config);
}

function startWakeup(worker) {
  if (stopping || config.event_wakeup?.enabled !== true) return;
  if (worker.child || worker.timer) {
    if (worker === greetingWorker && worker.child?.connected) {
      worker.child.send("wake", error => { if (error) worker.requested = true; });
      return;
    }
    worker.requested = true;
    return;
  }
  worker.requested = false;
  const proc = spawn(process.execPath, [wakeupScript, ...worker.args], {
    cwd: root,
    env: process.env,
    stdio: worker === greetingWorker ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  worker.child = proc;
  consumeLines(proc.stdout, (line) => {
    log(`${worker.name} wakeup: ${line}`);
    if (worker === greetingWorker && line === "greeting recovery required") startWakeup(taskWorker);
  });
  consumeLines(proc.stderr, (line) => log(`${worker.name} wakeup error: ${line}`));
  proc.on("error", (error) => log(`${worker.name} wakeup spawn error: ${error.message}`));
  proc.on("close", (code) => {
    log(`${worker.name} wakeup exited code=${code}`);
    worker.child = null;
    if (stopping) return;
    if (code === 0) {
      if (worker.requested) startWakeup(worker);
      return;
    }
    const delay = Number(config.event_wakeup?.retry_delay_ms) || 15000;
    worker.timer = setTimeout(() => {
      worker.timer = null;
      startWakeup(worker);
    }, delay);
  });
}

function startConsumer() {
  if (stopping) return;

  const executable = resolveLarkCli();
  const args = [
    "event",
    "consume",
    config.event_key,
    "--profile",
    config.profile,
    "--as",
    "bot",
  ];

  writeStatus("starting", { event_key: config.event_key });
  log(`starting consumer: ${config.event_key} profile=${config.profile}`);

  child = spawn(executable, args, {
    cwd: root,
    env: {
      ...process.env,
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
      LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  consumeLines(child.stdout, (line) => {
    try {
      const event = JSON.parse(line);
      appendFileSync(
        inboxPath,
        `${JSON.stringify({ captured_at: timestamp(), ...event })}\n`,
        "utf8",
      );
      if (eligible(event)) startWakeup(usesChatWorker(event, config) ? greetingWorker : taskWorker);
      writeStatus("ready", {
        event_key: config.event_key,
        last_event_at: timestamp(),
        last_message_id: event.message_id ?? null,
      });
    } catch (error) {
      log(`stdout parse error: ${error.message}; line=${line}`);
    }
  });

  consumeLines(child.stderr, (line) => {
    log(line);
    if (line.includes(`[event] ready event_key=${config.event_key}`)) {
      restartDelayMs = 1000;
      writeStatus("ready", { event_key: config.event_key });
      startWakeup(greetingWorker);
      startWakeup(taskWorker);
    }
  });

  child.on("error", (error) => {
    log(`consumer spawn error: ${error.message}`);
    writeStatus("error", { error: error.message });
  });

  child.on("exit", (code, signal) => {
    log(`consumer exited code=${code} signal=${signal ?? ""}`);
    child = null;
    if (stopping) return;
    writeStatus("restarting", { code, signal, restart_in_ms: restartDelayMs });
    const delay = restartDelayMs;
    restartDelayMs = Math.min(restartDelayMs * 2, 30000);
    setTimeout(startConsumer, delay);
  });
}

function startMembershipConsumer(key) {
  if (stopping || config.auto_group_admission?.enabled !== true) return;
  const state = membershipConsumers.get(key);
  const statusFile = join(runtimeDir, key + '.status.json');
  const status = (value, extra = {}) => writeFileSync(statusFile, JSON.stringify({
    status: value, event_key: key, listener_pid: process.pid, updated_at: timestamp(), ...extra
  }, null, 2));
  status('starting');
  const proc = spawn(resolveLarkCli(), ['event', 'consume', key, '--profile', config.profile, '--as', 'bot'], {
    cwd: root, env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
  });
  state.child = proc;
  let errors = '';
  consumeLines(proc.stdout, line => {
    try {
      const result = applyMembership(JSON.parse(line), config, runtimeDir);
      log(`membership event key=${key} changed=${result.changed} status=${result.status ?? result.reason}`);
      if (result.changed && result.status === 'admitted') {
        // An IM event may reach the bus before its corresponding invitation.
        startWakeup(greetingWorker); startWakeup(taskWorker);
      }
    } catch { status('error', { error: 'membership_projection_failed' }); log('membership projection failed'); }
  });
  consumeLines(proc.stderr, line => {
    if (errors.length < 32768) errors += line + '\n';
    if (line.includes(`[event] ready event_key=${key}`)) {
      errors = ''; state.delay = 1000; status('ready', { pid: proc.pid }); log(`[event] ready event_key=${key}`);
    }
  });
  proc.on('error', () => status('error', { error: 'membership_consumer_spawn_failed' }));
  proc.on('close', code => {
    state.child = null;
    if (stopping) { status('stopped'); return; }
    let error;
    try { error = JSON.parse(errors).error; } catch { /* diagnostic lines are deliberately not persisted */ }
    const permanent = error?.type === 'authorization' || error?.type === 'validation' || code === 2 || code === 3;
    status(permanent ? 'blocked' : 'restarting', { exit_code: code, error_type: error?.type ?? null,
      error_subtype: error?.subtype ?? null });
    if (permanent) { log(`membership subscription blocked key=${key}; verify console subscription and bot scope`); return; }
    state.timer = setTimeout(() => startMembershipConsumer(key), state.delay);
    state.delay = Math.min(state.delay * 2, 30000);
  });
}

function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  log(`shutdown requested: ${reason}`);
  writeStatus("stopping", { reason });
  for (const worker of [greetingWorker, taskWorker]) clearTimeout(worker.timer);
  for (const state of membershipConsumers.values()) {
    clearTimeout(state.timer);
    if (state.child) state.child.stdin.end();
  }

  if (child && !child.killed) {
    child.kill();
    setTimeout(() => {
      if (child && !child.killed) child.kill();
    }, 5000).unref();
  }

  setTimeout(() => {
    rmSync(pidPath, { force: true });
    rmSync(stopPath, { force: true });
    writeStatus("stopped", { reason });
    process.exit(0);
  }, child ? 1000 : 0).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("exit", () => {
  try {
    rmSync(pidPath, { force: true });
  } catch {
    // Best-effort cleanup only.
  }
});

setInterval(() => {
  if (existsSync(stopPath)) shutdown("stop.requested");
}, 1000).unref();

startConsumer();
for (const key of membershipKeys) startMembershipConsumer(key);
