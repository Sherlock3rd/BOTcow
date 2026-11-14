import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDailyCards } from "./daily-alert-card.mjs";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
function query(script, timeout) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [join(root, "scripts", script)], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.on("data", chunk => { stdout += chunk; if (stdout.length > 8*1024*1024) child.kill(); });
    child.stderr.resume();
    child.on("error", () => { clearTimeout(timer); resolve({ok:false,error:"query_unavailable"}); });
    child.on("close", code => {
      clearTimeout(timer);
      try { const result = JSON.parse(stdout); resolve(code === 0 || result.ok === false ? result : {ok:false,error:"query_failed"}); }
      catch { resolve({ok:false,error:"query_failed"}); }
    });
  });
}
const [overdue, bugs, tasks] = await Promise.all([query("list-overdue-requirements.mjs", 90000), query("list-dobe-open-bugs.mjs", 90000), query("list-personal-pending-tasks.mjs", 90000)]);
if (process.argv.includes("--simulate-empty")) {
  if (overdue.ok) Object.assign(overdue, { count: 0, items: [] });
  if (bugs.ok) Object.assign(bugs, { count: 0, items: [], status_counts: {} });
  if (tasks.ok) Object.assign(tasks, { count: 0, items: [] });
}
try { console.log(JSON.stringify(buildDailyCards(overdue, bugs, new Date(), 28000, tasks))); }
catch { console.log(JSON.stringify({ok:false,error:"daily_card_build_failed"})); process.exitCode=1; }
