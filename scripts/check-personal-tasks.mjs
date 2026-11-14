// Run under the daily task's principal. Safe metadata only, no messages or task writes.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync(process.execPath, [join(root, "scripts/list-personal-pending-tasks.mjs")], {
  cwd: root, encoding: "utf8", windowsHide: true, timeout: 75000, maxBuffer: 8 * 1024 * 1024 });
let data; try { data = JSON.parse(result.stdout); } catch {}
const status = { at: new Date().toISOString(), ok: result.status === 0 && data?.complete === true,
  count: data?.count ?? null, error: data?.error ?? null, exit_code: result.status, writes_attempted: 0 };
writeFileSync(join(root, "runtime/personal-tasks-background-probe.json"), JSON.stringify(status, null, 2));
console.log(JSON.stringify(status));
process.exitCode = status.ok ? 0 : 1;
