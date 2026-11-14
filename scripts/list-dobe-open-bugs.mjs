import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectOpenBugs, makeMeegleQuery } from "./dobe-bugs.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(join(root, "config", "assistant-workflows.json"), "utf8")).dobe_bugs;
const diagnostics = [];
function record(outcome) {
  mkdirSync(join(root, "runtime"), {recursive:true});
  appendFileSync(join(root, "runtime", "dobe-query-diagnostics.ndjson"), JSON.stringify({at:new Date().toISOString(),...outcome, attempts:diagnostics}) + "\n");
}
try {
  if (!config?.enabled) throw new Error("not_configured");
  const result = collectOpenBugs(config, makeMeegleQuery(config, root, {onDiagnostic: d => diagnostics.push(d)}));
  record({ok:true,count:result.count});
  console.log(JSON.stringify(result));
} catch (error) {
  record({ok:false,error:error.code || "query_failed"});
  console.log(JSON.stringify({ ok: false, complete: false, count: null, items: [], source_url: config?.url,
    error: error.code || "query_failed", diagnostic: error.diagnostic || null }));
  process.exitCode = 1;
}
