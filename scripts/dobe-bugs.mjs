import { spawnSync } from "node:child_process";

export class BugQueryError extends Error {
  constructor(code, diagnostic) { super(code); this.code = code; this.diagnostic = diagnostic; }
}

// Keep raw errors in memory only. Persist allowlisted metadata, never provider text or argv.
export function classifyMeegleResult(result, stage, attempt) {
  let payload, stream = "none";
  for (const name of ["stdout", "stderr"]) {
    try { payload = JSON.parse(result[name]); stream = name; break; } catch {}
  }
  if (!result.error && result.status === 0 && payload && !payload.error && payload.data && typeof payload.data === "object") {
    return { data: payload.data };
  }
  const raw = `${result.stdout || ""}\n${result.stderr || ""}`;
  const providerCode = payload?.error?.code;
  const http = raw.match(/(?:HTTP(?:\/\d(?:\.\d)?)?[\s:_-]*|status(?:_code| code)?["\s:=]+)(401|403|408|429|5\d\d)\b/i)?.[1];
  let code = "query_failed", retryable = false;
  if (result.error?.code === "ETIMEDOUT") { code = "query_timeout"; retryable = true; }
  else if (result.error) code = "cli_unavailable";
  else if (http === "403" || /permission.denied|forbidden|insufficient.scope/i.test(raw)) code = "permission_denied";
  else if (http === "401" || /not logged in|unauthorized|auth(?:entication|orization)[_ ]required|invalid_grant|token.expired|token_missing|login.required/i.test(raw)) code = "authorization_required";
  else if (http === "429" || /rate.limit|too many requests/i.test(raw)) { code = "rate_limited"; retryable = true; }
  else if (http === "408" || http?.startsWith("5") || /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|TLS handshake timeout|context deadline exceeded|i\/o timeout|network is unreachable|connection reset|no such host|temporary failure/i.test(raw)) { code = "service_unavailable"; retryable = true; }
  else if (result.status === 0 && !payload?.error) code = "schema_changed";
  return { code, retryable, diagnostic: {
    stage: ["user me", "workitem meta-fields", "workitem query"].includes(stage) ? stage : "unknown",
    attempt, exit_code: Number.isInteger(result.status) ? result.status : null,
    code, retryable, json_stream: stream,
    ...(http ? { http_status: Number(http) } : {}),
    ...(Number.isSafeInteger(providerCode) ? { provider_code: providerCode } : {}),
  } };
}

export function makeMeegleQuery(config, cwd, options = {}) {
  const run = options.run || spawnSync;
  const sleep = options.sleep || (ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
  const deadline = Date.now() + 65000;
  return (args) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new BugQueryError("query_timeout");
      const result = run(process.env.MEEGLE_CLI_EXE || config.cli_executable, [...args, "--envelope"], {
        cwd, encoding: "utf8", windowsHide: true, timeout: Math.min(20000, remaining), maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, MEEGLE_HOST: "project.feishu.cn" },
      });
      const outcome = classifyMeegleResult(result, args.slice(0,2).join(" "), attempt);
      if (outcome.data) return outcome.data;
      options.onDiagnostic?.(outcome.diagnostic);
      if (!outcome.retryable || attempt === 3 || deadline - Date.now() <= attempt * 1000) {
        throw new BugQueryError(outcome.code, outcome.diagnostic);
      }
      sleep(attempt * 1000);
    }
  };
}

function scalar(fields, key) {
  const f = fields.find(f => f.key === key);
  if (!f) throw new BugQueryError("schema_changed");
  return f.value?.[f.value_type] ?? null;
}

export function normalizeBug(row, config) {
  const f = row.moql_field_list;
  if (!Array.isArray(f)) throw new BugQueryError("schema_changed");
  const id = scalar(f, "work_item_id");
  const title = scalar(f, "name");
  const status = scalar(f, "work_item_status");
  if (!Number.isSafeInteger(id) || id <= 0 || typeof title !== "string" || status?.length !== 1 || !status[0].label) {
    throw new BugQueryError("schema_changed");
  }
  if (status[0].key === config.excluded_status_key) throw new BugQueryError("filter_mismatch");
  const names = value => (value ?? []).map(p => p.name_cn || p.name_en || p.name).filter(Boolean);
  return {
    id: String(id), title, status: status[0].label, status_key: status[0].key,
    priority: scalar(f, "priority")?.[0]?.label || "待定",
    owners: names(scalar(f, "current_status_operator")),
    updated_at: scalar(f, "updated_at") || "",
    url: `https://project.feishu.cn/${config.simple_name}/${config.type_key}/detail/${id}`,
  };
}

export function collectOpenBugs(config, query, now = new Date()) {
  if (config.simple_name !== "dobe" || config.type_key !== "issue" || config.excluded_status_key !== "CLOSED"
    || config.scope !== "related_to_current_user" || !config.expected_user_email) {
    throw new BugQueryError("configuration_invalid");
  }
  const me = query(["user", "me"]);
  if (me.email !== config.expected_user_email) throw new BugQueryError("identity_mismatch");
  const meta = query(["workitem", "meta-fields", "--project-key", config.simple_name, "--work-item-type", config.type_key]);
  if (!Array.isArray(meta.list) || meta.pagination?.has_more !== false) throw new BugQueryError("metadata_incomplete");
  const fields = Object.fromEntries(meta.list.map(f => [f.field_key, f]));
  const required = ["work_item_id", "name", "work_item_status", "priority", "current_status_operator", "updated_at"];
  if (required.some(key => !fields[key]?.field_name)) throw new BugQueryError("schema_changed");
  const closed = fields.work_item_status.option?.find(s => s.option_id === config.excluded_status_key);
  if (!closed || closed.option_name !== config.excluded_status_name) throw new BugQueryError("schema_changed");
  const quote = value => { if (/[`'\\]/.test(value)) throw new BugQueryError("schema_changed"); return value; };
  const field = key => `\`${quote(fields[key].field_name)}\``;
  const base = `SELECT ${required.map(field).join(", ")} FROM \`dobe\`.\`issue\` WHERE ${field("work_item_status")} != '${quote(closed.option_name)}' AND array_contains(all_participate_persons(), current_login_user())`;
  const items = [];
  let initialTotal, lastId = 0;
  // Stable ID ordering gives bounded keyset queries without storing opaque query sessions.
  // Check remaining totals on every page; concurrent membership changes fail as incomplete.
  for (let page = 0; page < 200; page++) {
    const mql = `${base}${lastId ? ` AND ${field("work_item_id")} > ${lastId}` : ""} ORDER BY ${field("work_item_id")} ASC`;
    const data = query(["workitem", "query", "--project-key", config.simple_name, "--mql", mql]);
    // Official CLI returns list=null and data={} for a successful empty query.
    const groups = data.list === null && data.data && !Object.keys(data.data).length
      ? [{ count: 0, group_infos: [{ group_id: "1" }] }] : data.list;
    if (!Array.isArray(groups) || groups.length !== 1) throw new BugQueryError("schema_changed");
    const group = groups[0];
    const groupId = group.group_infos?.[0]?.group_id;
    if (!Number.isInteger(group.count) || group.count < 0 || !groupId) throw new BugQueryError("schema_changed");
    initialTotal ??= group.count;
    if (group.count !== initialTotal - items.length) throw new BugQueryError("snapshot_changed");
    const rows = data.data?.[groupId] ?? (group.count === 0 ? [] : null);
    if (!Array.isArray(rows) || rows.length > group.count || (!rows.length && group.count)) throw new BugQueryError("pagination_incomplete");
    for (const row of rows) {
      const item = normalizeBug(row, config);
      if (Number(item.id) <= lastId) throw new BugQueryError("pagination_not_advancing");
      lastId = Number(item.id);
      items.push(item);
    }
    if (items.length === initialTotal) {
      const rank = { P0: 0, P1: 1, P2: 2 };
      items.sort((a,b) => (rank[a.priority] ?? 3) - (rank[b.priority] ?? 3) || a.status.localeCompare(b.status, "zh-CN") || Number(a.id) - Number(b.id));
      return { ok: true, complete: true, scope: config.scope, count: items.length, items, source_url: config.url,
        queried_at: now.toISOString(), status_counts: items.reduce((r,i) => ({...r, [i.status]: (r[i.status] || 0) + 1}), {}) };
    }
  }
  throw new BugQueryError("pagination_limit");
}
