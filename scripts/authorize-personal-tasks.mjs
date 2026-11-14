// Device code lives only in this process; wait for explicit user acknowledgement before redemption.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(process.env.APPDATA, "npm/node_modules/@larksuite/cli/bin/lark-cli.exe");
const profile = JSON.parse(readFileSync(join(root, "config/assistant-workflows.json"), "utf8")).personal_tasks.profile;
const ack = join(root, "runtime/personal-tasks-auth-ack.txt");
const statusPath = join(root, "runtime/personal-tasks-auth-status.json");
const status = value => writeFileSync(statusPath, JSON.stringify({ at:new Date().toISOString(), ...value }, null, 2));
function call(args, timeout = 20000) {
  return spawnSync(cli, [...args, "--profile", profile], { cwd:root,encoding:"utf8",windowsHide:true,timeout,
    env:{...process.env,LARKSUITE_CLI_NO_UPDATE_NOTIFIER:"1",LARKSUITE_CLI_NO_SKILLS_NOTIFIER:"1"} });
}
try {
  if (existsSync(ack)) throw new Error("stale_ack");
  const started = call(["auth","login","--scope","task:task:read","--no-wait","--json"]);
  const payload = JSON.parse(started.stdout || started.stderr);
  const login = payload.data ?? payload;
  const url = login.verification_url || login.verification_uri_complete || login.verification_uri;
  if (started.status !== 0 || !url || !login.device_code) {
    status({state:"setup_failed",error:payload.error?.subtype || "authorization_setup_failed"});
    // Only a provider-supplied console URL is suitable for the user; do not expose raw responses.
    console.log(JSON.stringify({ok:false,error:payload.error?.subtype || "authorization_setup_failed",console_url:payload.error?.console_url || null}));
    process.exit(1);
  }
  const qr = call(["auth","qrcode",url,"--output","runtime/personal-tasks-auth.png"]);
  if (qr.status !== 0) throw new Error("qr_failed");
  status({state:"waiting_for_user",pid:process.pid});
  console.log(JSON.stringify({state:"waiting_for_user",verification_url:url,qr_path:join(root,"runtime/personal-tasks-auth.png")}));
  const deadline = Date.now() + Number(login.expires_in || 600) * 1000;
  while (Date.now() < deadline && !existsSync(ack)) await delay(500);
  if (!existsSync(ack)) throw new Error("authorization_expired");
  unlinkSync(ack);
  const redeemed = call(["auth","login","--device-code",login.device_code,"--json"], 60000);
  const completed = redeemed.status === 0;
  status({state:completed?"authorized":"authorization_failed"});
  console.log(JSON.stringify({ok:completed,state:completed?"authorized":"authorization_failed"}));
  process.exitCode = completed ? 0 : 1;
} catch (error) {
  const code = ["stale_ack","qr_failed","authorization_expired"].includes(error.message) ? error.message : "authorization_setup_failed";
  status({state:"failed",error:code}); console.log(JSON.stringify({ok:false,error:code})); process.exitCode=1;
}
