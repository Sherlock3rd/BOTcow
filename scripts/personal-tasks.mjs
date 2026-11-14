import { spawnSync } from "node:child_process";

function fail(code) { throw Object.assign(new Error(code), { code }); }
export function taskLink(guid, raw) {
  if (typeof guid !== "string" || !/^[a-zA-Z0-9-]+$/.test(guid)) fail("invalid_task_identity");
  const url = new URL(raw || `https://applink.feishu.cn/client/todo/detail?guid=${guid}`);
  if (url.origin !== "https://applink.feishu.cn" || !/^\/client\/todo\/(detail|task)$/.test(url.pathname)
    || url.searchParams.get("guid") !== guid || url.username || url.password) fail("invalid_task_link");
  return url.href;
}

export function collectPersonalTasks(config, call) {
  if (!config?.enabled || config.scope !== "assigned_to_me_incomplete" || !config.expected_user_open_id) fail("not_configured");
  const user = call(["auth", "status", "--json"]).identities?.user;
  if (!user || user.available !== true || ["missing", "expired", "invalid"].includes(user.status)
    || ["expired", "invalid"].includes(user.tokenStatus)) fail("authorization_required");
  if (user.openId !== config.expected_user_open_id) fail("identity_mismatch");
  const items = [], seen = new Set(), tokens = new Set();
  let token;
  do {
    const args = ["task", "+get-my-tasks", "--complete=false", "--page-limit", "1", "--as", "user", "--format", "json"];
    if (token) args.push("--page-token", token);
    const result = call(args);
    if (result.ok !== true || result.identity !== "user") fail("invalid_task_response");
    const data = result.data;
    if (!Array.isArray(data?.items) || typeof data.has_more !== "boolean") fail("incomplete_task_page");
    for (const task of data.items) {
      if (!task.guid || seen.has(task.guid)) fail("duplicate_or_missing_task");
      seen.add(task.guid);
      const completedAt = Number(task.completed_at || 0);
      if (!Number.isFinite(completedAt) || completedAt < 0) fail("invalid_completion_time");
      // A concurrent completion, including my completion of a countersign task, is not pending work.
      const mine = task.assignee_related?.find(member => member.id === user.openId);
      if (completedAt > 0 || Number(mine?.completed_at || 0) > 0) continue;
      const due = task.due?.timestamp ? Number(task.due.timestamp) : null;
      if (due !== null && (!Number.isFinite(due) || due <= 0 || Number.isNaN(new Date(due).getTime()))) fail("invalid_due_time");
      items.push({ guid: task.guid, title: task.summary || "无标题", due_ms: due,
        is_all_day: task.due?.is_all_day === true, url: taskLink(task.guid, task.url) });
    }
    if (!data.has_more) break;
    token = data.page_token;
    if (!data.items.length || !token || tokens.has(token)) fail("incomplete_task_pagination");
    tokens.add(token);
  } while (true);
  items.sort((a, b) => (a.due_ms ?? Infinity) - (b.due_ms ?? Infinity) || a.guid.localeCompare(b.guid));
  return { ok: true, complete: true, scope: config.scope, count: items.length, items };
}

export function makeTaskQuery(cli, profile, cwd, run = spawnSync) {
  const deadline = Date.now() + 65000;
  return args => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) fail("query_timeout");
    const result = run(cli, [...args, "--profile", profile], { cwd, encoding: "utf8", windowsHide: true,
      timeout: Math.min(20000, remaining), maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1" } });
    const parsed = [result.stdout, result.stderr].map(text => { try { return JSON.parse(text); } catch { return null; } }).filter(Boolean);
    const error = parsed.find(p => p.ok === false)?.error;
    if (error) {
      if (error.type === "authentication") fail("authorization_required");
      if (error.type === "authorization") fail(error.subtype === "missing_scope" ? "missing_scope" : "permission_denied");
      fail("task_query_failed");
    }
    const body = parsed[0];
    if (result.status !== 0 || !body || body.ok === false) fail(result.error?.code === "ETIMEDOUT" ? "query_timeout" : "task_query_failed");
    return body;
  };
}
