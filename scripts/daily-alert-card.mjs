export function escapeMarkdown(value) {
  return String(value ?? "").replace(/[&<>*~\[\]()#_:|`\\]/g, c => `&#${c.charCodeAt(0)};`).replace(/[\r\n]+/g, " ");
}
const md = content => ({ tag: "markdown", content });
const block = content => ({ tag: "column_set", flex_mode: "none", columns: [
  { tag: "column", width: "weighted", weight: 1, padding: "12px", background_style: "grey-50", elements: [md(content)] },
] });
export function shanghaiDate(now = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
function bugRow(item) {
  const url = new URL(item.url);
  if (url.origin !== "https://project.feishu.cn" || !/^\/dobe\/issue\/detail\/\d+$/.test(url.pathname)) throw new Error("Invalid bug link");
  return { bug: `[${escapeMarkdown(item.title)}](${url.href})`,
    state: `${item.priority || "待定"} · ${item.status}`, owner: item.owners?.join("、") || "未填写" };
}
function bugTable(rows) {
  return { tag: "table", page_size: 10, row_height: "auto", row_max_height: "240px",
    columns: [
      { name: "bug", display_name: "Bug（点击查看）", data_type: "lark_md", width: "60%" },
      { name: "state", display_name: "优先级 / 状态", data_type: "text", width: "20%" },
      { name: "owner", display_name: "当前负责人", data_type: "text", width: "20%" },
    ], rows };
}
function taskRow(item, now) {
  const url = new URL(item.url);
  if (url.origin !== "https://applink.feishu.cn" || !/^\/client\/todo\/(detail|task)$/.test(url.pathname)
    || url.searchParams.get("guid") !== item.guid) throw new Error("Invalid task link");
  const date = item.due_ms === null ? null : new Date(item.due_ms);
  const due = date ? (item.is_all_day ? shanghaiDate(date) + "（全天）" : new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).format(date)) : "未设置";
  const late = date && (item.is_all_day ? shanghaiDate(date) < shanghaiDate(now) : item.due_ms < now.getTime());
  return { task: `[${escapeMarkdown(item.title)}](${url.href})`, due, state: late ? "已逾期" : "未完成" };
}
function taskTable(rows) {
  return { tag: "table", page_size: 10, row_height: "auto", row_max_height: "240px", columns: [
    { name: "task", display_name: "我的任务（点击查看）", data_type: "lark_md", width: "55%" },
    { name: "due", display_name: "截止时间（上海）", data_type: "text", width: "30%" },
    { name: "state", display_name: "状态", data_type: "text", width: "15%" },
  ], rows };
}
export function buildDailyCards(overdue, bugs, now = new Date(), maxBytes = 28000, tasks = null) {
  if (overdue.ok !== true || overdue.count !== overdue.items?.length) throw new Error("Incomplete overdue query");
  const complete = bugs?.ok === true && bugs.complete === true && bugs.scope === "related_to_current_user" && Number.isInteger(bugs.count)
    && Array.isArray(bugs.items) && bugs.count === bugs.items.length;
  const count = complete ? bugs.count : null;
  const tasksComplete = tasks?.ok === true && tasks.complete === true && tasks.scope === "assigned_to_me_incomplete"
    && Number.isInteger(tasks.count) && Array.isArray(tasks.items) && tasks.count === tasks.items.length;
  const taskCount = tasksComplete ? tasks.count : null;
  const taskMetric = `我的未完成任务\n**${taskCount ?? "未能读取"}**\n` + (tasksComplete
    ? (taskCount ? "清单见后续卡片" : "当前没有未完成任务") : "请检查任务读取授权");
  const hasAlerts = overdue.count > 0;
  const attention = hasAlerts || !complete || count > 0 || (tasks !== null && (!tasksComplete || taskCount > 0));
  const date = shanghaiDate(now);
  const summary = `超时需求 ${overdue.count} 条 · Dobe 未关闭 Bug ${complete ? `${count} 条` : "未能读取"}`
    + (tasks !== null ? ` · 我的未完成任务 ${tasksComplete ? `${taskCount} 条` : "未能读取"}` : "");
  const header = { title: { tag: "plain_text", content: "早上好，example" }, template: "green",
    ...(attention ? { subtitle: { tag: "plain_text", content: tasks !== null ? "存在需要关注的需求、任务或缺陷" : "存在需要关注的需求或缺陷" },
      text_tag_list: [{ tag: "text_tag", text: { tag: "plain_text", content: "需要关注" }, color: "orange" }] } : {}) };
  const baseCard = elements => ({ schema: "2.0", config: { update_multi: true, width_mode: "default", summary: { content: summary } },
    header: structuredClone(header), body: { direction: "vertical", padding: "16px 16px 20px 16px", vertical_spacing: "large", elements } });
  const overdueDetails = hasAlerts ? overdue.items.map((i,n) =>
    `**${n+1}. [${escapeMarkdown(i.priority || "未定")}] ${escapeMarkdown(i.task)}**\n状态：${escapeMarkdown(i.status)}　负责人：${escapeMarkdown(i.owners?.join("、") || "未填写")}\n下次 check：${escapeMarkdown(i.next_check_date?.slice(0,10) || "未填写")}　**超时 ${i.overdue_days ?? "未知"} 天**`).join("\n\n")
    : "今天没有超时需求，继续保持自己的工作节奏。";
  const bugSummary = complete
    ? `**与你有关的 Dobe 未关闭 Bug：${count} 条**\n${count ? Object.entries(bugs.status_counts).map(([s,n]) => `${escapeMarkdown(s)} ${n}`).join(" · ") : "当前没有与你有关的未关闭 Bug。"}\n口径：飞书项目全部参与人包含你，且状态不等于“已关闭”。${count ? "表格每页 10 条，可翻页查看全部。" : ""}\n[打开缺陷管理](${bugs.source_url})`
    : `**Dobe 未关闭 Bug：未能读取**\n本次数据不完整，请检查飞书项目连接或授权；不代表没有 Bug。\n[打开缺陷管理](https://project.feishu.cn/dobe/issue/homepage)`;
  const first = baseCard([
    md(`**早上好，今天要看的事放这了。**\n${date} · 一起看看今天的工作安排。`),
    { tag: "column_set", flex_mode: "none", horizontal_spacing: "large", columns: [
      { tag: "column", width: "weighted", weight: 1, padding: "12px", background_style: hasAlerts ? "red-50" : "green-50", elements: [md(`超时需求\n## ${overdue.count}`)] },
      { tag: "column", width: "weighted", weight: 1, padding: "12px", background_style: "grey-50", elements: [md(`Dobe 未关闭 Bug\n**${count ?? "未能读取"}**`)] },
      ...(tasks !== null ? [{ tag: "column", width: "weighted", weight: 1, padding: "12px", background_style: "grey-50", elements: [md(taskMetric)] }] : []),
    ] },
    block(`**需求排期**\n${overdueDetails}\n\n[查看完整排期](${overdue.source_url})`),
    md(bugSummary),
  ]);
  const cards = [first];
  const ranges = [];
  let table, start = 1;
  const bytes = c => Buffer.byteLength(JSON.stringify(c), "utf8");
  if (bytes(first) > maxBytes - 500) throw new Error("Overdue card exceeds capacity");
  for (const [index,item] of (complete ? bugs.items : []).entries()) {
    let current = cards.at(-1);
    if (!table) { table = bugTable([]); current.body.elements.push(table); }
    table.rows.push(bugRow(item));
    if (bytes(current) > maxBytes - 500) {
      table.rows.pop();
      if (!table.rows.length) throw new Error("Bug row exceeds card capacity");
      ranges.push([start,index]); start = index+1;
      table = bugTable([bugRow(item)]);
      current = baseCard([md(`**Dobe 未关闭 Bug 清单（续）**\n${date} · 共 ${count} 条 · [打开缺陷管理](${bugs.source_url})`), table]);
      cards.push(current);
      if (bytes(current) > maxBytes - 500) throw new Error("Bug row exceeds card capacity");
    }
  }
  if (complete && count) ranges.push([start,count]);
  const bugCardCount = cards.length;
  const taskRanges = [];
  let taskRows, taskStart = 1;
  for (const [index, item] of (tasksComplete ? tasks.items : []).entries()) {
    if (!taskRows) {
      taskRows = taskTable([]);
      cards.push(baseCard([md(`**我的未完成任务清单**\n${date} · 共 ${taskCount} 条\n口径：分配给你且尚未完成，不限制截止日期。按截止时间排序，无截止时间排后；每页10条。`), taskRows]));
    }
    taskRows.rows.push(taskRow(item, now));
    if (bytes(cards.at(-1)) > maxBytes - 500) {
      taskRows.rows.pop();
      if (!taskRows.rows.length) throw new Error("Task row exceeds card capacity");
      taskRanges.push([taskStart, index]); taskStart = index + 1;
      taskRows = taskTable([taskRow(item, now)]);
      cards.push(baseCard([md(`**我的未完成任务清单（续）**\n${date} · 共 ${taskCount} 条`), taskRows]));
      if (bytes(cards.at(-1)) > maxBytes - 500) throw new Error("Task row exceeds card capacity");
    }
  }
  if (tasksComplete && taskCount) taskRanges.push([taskStart, taskCount]);
  cards.forEach((c,i) => {
    if (cards.length > 1) {
      const range = i < bugCardCount ? ranges[i] : taskRanges[i - bugCardCount];
      const label = i < bugCardCount ? "Bug" : "任务";
      const total = i < bugCardCount ? count : taskCount;
      c.header.subtitle = { tag: "plain_text", content: `每日播报 ${i+1}/${cards.length}` + (range ? ` · ${label} 第 ${range[0]}–${range[1]} 条 / 共 ${total} 条` : " · 工作概览") };
      c.config.summary.content += `（${i+1}/${cards.length}）`;
    }
    if (bytes(c) > maxBytes) throw new Error("Card exceeds capacity");
  });
  return { ok: true, count: overdue.count, bug_count: count, bugs_complete: complete, bug_scope: "related_to_current_user",
    task_count: taskCount, tasks_complete: tasksComplete, tasks_scope: tasks?.scope ?? null,
    task_error: tasksComplete ? null : (tasks?.error || "incomplete"),
    bug_error: complete ? null : (bugs.error || "incomplete"), date, cards, card: cards[0], source_url: overdue.source_url };
}
