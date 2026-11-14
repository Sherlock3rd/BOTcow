import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectPersonalTasks, makeTaskQuery } from "./personal-tasks.mjs";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(join(root, "config/assistant-workflows.json"), "utf8")).personal_tasks;
const cli = process.env.LARK_CLI_EXE || (process.platform === "win32" && process.env.APPDATA
  ? join(process.env.APPDATA, "npm/node_modules/@larksuite/cli/bin/lark-cli.exe") : "lark-cli");
try { console.log(JSON.stringify(collectPersonalTasks(config, makeTaskQuery(cli, config.profile, root)))); }
catch (error) {
  console.log(JSON.stringify({ ok: false, complete: false, scope: config?.scope, count: null, items: [], error: error.code || "task_query_failed" }));
  process.exitCode = 1;
}
