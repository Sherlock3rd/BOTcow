import { spawnSync } from "node:child_process";

const kinds = new Set(["document_count", "documents", "agenda_today", "agenda_tomorrow", "pending_tasks"]);
const denied = (code, text) => ({ code, text });

export function obviousRead(text) {
  const q = String(text).normalize("NFKC").replace(/\s+/g, "").replace(/[?。!]+$/u, "");
  if (/^(?:(?:请|请问|帮我|你知道)?(?:查一下|查下|看看|统计一下)?)?(?:现在)?我(?:现在|目前)?(?:拥有|名下有|有)(?:多少|几)(?:个|篇|份)?(?:飞书|云)?文档(?:了|吗|了吗)?$/u.test(q))
    return { kind: "document_count" };
  if (/^(?:看看|查一下|列出)?我(?:的)?(?:未完成的?任务|待办)(?:有哪些)?$/u.test(q)) return { kind: "pending_tasks" };
  if (/^(?:看看|查一下)?(?:我今天的?|今天我的?)日程(?:有哪些)?$/u.test(q)) return { kind: "agenda_today" };
  return null;
}

export function checkReadRequest(query) {
  if (!query || !kinds.has(query.kind)) throw new Error("unknown read operation");
  if (query.keyword !== undefined && (query.kind !== "documents" || typeof query.keyword !== "string" ||
      [...query.keyword].length > 30)) throw new Error("invalid document keyword");
  return query;
}

export function larkRead(cli, profile, args) {
  const r = spawnSync(cli, [...args, "--profile", profile], { encoding: "utf8",
    windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
  let body;
  try { body = JSON.parse((r.status === 0 ? r.stdout : r.stderr || r.stdout).trim()); } catch { /* handled below */ }
  if (r.status === 0 && body && body.ok !== false) return body;
  const error = new Error("Feishu read failed");
  error.feishu = body?.error ?? {};
  throw error;
}

function documents(query, call) {
  const count = query.kind === "document_count";
  const args = ["drive", "+search", "--mine", "--doc-types", "doc,docx", "--page-size", "20"];
  if (query.keyword) args.push("--query", query.keyword, "--only-title");
  const found = new Map(), pages = new Set();
  let page;
  do {
    const { data } = call([...args, ...(page ? ["--page-token", page] : []), "--as", "user", "--format", "json"]);
    if (!Array.isArray(data?.results) || typeof data.has_more !== "boolean") throw new Error("invalid search page");
    for (const doc of data.results) {
      const url = doc.result_meta?.url;
      const token = doc.result_meta?.token || doc.entity_id || doc.token ||
        (url && new URL(url).pathname.split("/").filter(Boolean).at(-1));
      if (!token) throw new Error("missing document identity");
      found.set(token, String(doc.title || doc.title_highlighted || "无标题").replace(/<\/?h(?:b)?>/g, ""));
    }
    if (!count && found.size >= 5) break;
    if (!data.has_more) break;
    page = data.page_token;
    if (!page || pages.has(page)) throw new Error("incomplete search pagination");
    pages.add(page);
  } while (true);
  if (count) return `你拥有的飞书文档共有 ${found.size} 篇（含旧版文档和新版文档）。`;
  const names = [...found.values()].slice(0, 5);
  return names.length ? "你拥有的文档（最多列 5 篇）：\n" + names.join("\n") : "没有查到符合条件的自有文档。";
}

export function performRead(query, event, call, now = new Date()) {
  checkReadRequest(query);
  if (event.chat_type !== "p2p") return denied("private_chat", "请在与我的私聊中查询个人飞书数据。");
  const domain = query.kind.startsWith("agenda") ? "日历" : query.kind === "pending_tasks" ? "任务" : "云文档";
  const authMessage = `当前没有可用的飞书个人${domain}读取授权，无法查询。请重新授权 botCow 后再问一次。`;
  try {
    const user = call(["auth", "status", "--json"]).identities?.user;
    if (!user || user.available === false || ["missing", "expired", "invalid"].includes(user.status) ||
        ["expired", "invalid"].includes(user.tokenStatus)) return denied("user_auth", authMessage);
    if (!user.openId || user.openId !== event.sender_id)
      return denied("user_identity", "当前授权账号与发消息的账号不匹配，无法读取你的个人数据。");
    if (domain === "云文档") return { text: documents(query, call) };
    if (domain === "日历") {
      const offset = query.kind === "agenda_tomorrow" ? 86400000 : 0;
      const date = new Date(now.getTime() + offset + 8 * 3600000).toISOString().slice(0, 10);
      const { data } = call(["calendar", "+agenda", "--start", date + "T00:00:00+08:00",
        "--end", date + "T23:59:59+08:00", "--as", "user", "--format", "json"]);
      if (!Array.isArray(data)) throw new Error("invalid calendar response");
      return { text: data.length ? `${date} 有 ${data.length} 项日程（最多列 8 项）：\n` +
        data.slice(0, 8).map(e => (e.start_time?.datetime?.slice(11, 16) || "全天") + " " + (e.summary || "无标题")).join("\n")
        : `${date} 没有日程。` };
    }
    const { data } = call(["task", "+get-my-tasks", "--complete=false", "--page-limit", "1", "--as", "user", "--format", "json"]);
    if (!Array.isArray(data?.items)) throw new Error("invalid task response");
    return { text: data.items.length ? "你的未完成任务（最多列 8 项）：\n" +
      data.items.slice(0, 8).map(t => t.summary || "无标题").join("\n") : data.has_more ? "本页没有可展示的任务。" : "你没有未完成的任务。" };
  } catch (error) {
    const e = error.feishu ?? {};
    if (e.type === "authentication" || /token_missing|token_expired|need_user_authorization/.test(e.subtype ?? ""))
      return denied("user_auth", authMessage);
    if (e.type === "authorization" || /permission|scope|forbidden/.test(e.subtype ?? ""))
      return denied("permission", `飞书拒绝了这次${domain}查询，当前账号或应用缺少所需权限。请补齐权限后再问一次。`);
    return denied("read_failed", `本次未能完整读取飞书${domain}数据，请稍后重试。`);
  }
}
