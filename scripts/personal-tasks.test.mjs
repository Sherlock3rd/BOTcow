import test from "node:test";
import assert from "node:assert/strict";
import { collectPersonalTasks, makeTaskQuery } from "./personal-tasks.mjs";
import { buildDailyCards } from "./daily-alert-card.mjs";
import { deliverDailyCards } from "./daily-alert-delivery.mjs";
const config = { enabled: true, scope: "assigned_to_me_incomplete", expected_user_open_id: "owner" };
const auth = { identities: { user: { available: true, openId: "owner", status: "ready" } } };
const item = (guid, extra = {}) => ({ guid, summary: `任务 ${guid}`, completed_at: "0", ...extra });
const page = (items, has_more = false, page_token = "") => ({ ok: true, identity: "user", data: { items, has_more, page_token } });
const result = items => ({ ok: true, complete: true, scope: config.scope, count: items.length, items });
const overdue = { ok: true, count: 0, items: [], source_url: "https://example.com" };
const bugs = { ok: true, complete: true, scope: "related_to_current_user", count: 0, items: [], status_counts: {}, source_url: "https://project.feishu.cn/dobe/issue/homepage" };
test("fetches every task page as the verified user, filters completions and sorts deadlines", () => {
  const calls = [], pages = [auth, page([item("a"), item("b", { due: { timestamp: "1800000000000" } })], true, "next"),
    page([item("c", { completed_at: "1" }), item("d", { assignee_related: [{id:"owner",completed_at:"1"}] }), item("e", { due: { timestamp: "1700000000000" } })])];
  const found = collectPersonalTasks(config, args => { calls.push(args); return pages.shift(); });
  assert.deepEqual(found.items.map(t => t.guid), ["e", "b", "a"]);
  for (const args of calls.slice(1)) { assert.ok(args.includes("--complete=false")); assert.equal(args[args.indexOf("--as")+1], "user"); }
  assert.ok(calls[2].includes("next")); assert.equal(found.count, 3);
  assert.doesNotMatch(JSON.stringify(found), /completed_at|assignee_related|owner/);
});
test("wrong identity, missing auth, truncated pagination and repeated task IDs fail closed", () => {
  for (const rows of [
    [{ identities: { user: { available:true,openId:"other" } } }], [{}],
    [auth, page([item("a")], true, "")], [auth,page([item("a")],true,"x"),page([item("a")])],
    [auth,page([],true,"x")], [auth,{ok:true,identity:"user",data:{items:[]}}],
    [auth,{...page([]),identity:"bot"}],
  ]) assert.throws(() => collectPersonalTasks(config, () => rows.shift()));
});
test("authorization errors from stderr stop once and never expose raw secret-bearing messages", () => {
  let count = 0;
  const call = makeTaskQuery("mock", "profile", ".", () => { count++; return { status:1,stdout:"",stderr:JSON.stringify({ok:false,error:{type:"authorization",subtype:"missing_scope",message:"access_token=secret"}}) }; });
  assert.throws(() => call(["task"]), error => error.code === "missing_scope" && !error.message.includes("secret"));
  assert.equal(count, 1);
});
test("zero tasks, failed tasks and unscoped data are distinct; failures retain bug and schedule content", () => {
  const zero = buildDailyCards(overdue, bugs, new Date(), 28000, result([]));
  assert.equal(zero.task_count, 0); assert.equal(zero.tasks_complete, true);
  for (const tasks of [{ok:false,error:"missing_scope"}, {...result([]),scope:"all"}]) {
    const failed = buildDailyCards(overdue, bugs, new Date(), 28000, tasks);
    assert.equal(failed.task_count, null); assert.equal(failed.tasks_complete, false);
    assert.match(JSON.stringify(failed.cards), /我的未完成任务.*未能读取/s);
    assert.match(JSON.stringify(failed.cards), /需求排期/); assert.equal(failed.bug_count, 0);
  }
});
test("complete task list paginates into bounded cards without dropping rows; due dates use Shanghai", () => {
  const rows = Array.from({length:150}, (_,n) => ({guid:`t-${n}`,title:"任务 *测试* ".repeat(10),due_ms:null,is_all_day:false,url:`https://applink.feishu.cn/client/todo/detail?guid=t-${n}`}));
  rows[0].due_ms = Date.parse("2026-11-13T01:00:00Z");
  rows[1].due_ms = Date.parse("2026-11-13T00:00:00Z"); rows[1].is_all_day = true;
  const built = buildDailyCards(overdue, bugs, new Date("2026-11-13T02:00:00Z"), 28000, result(rows));
  const tables = built.cards.flatMap(c => c.body.elements.filter(e => e.tag === "table"));
  const output = tables.flatMap(t => t.rows);
  assert.equal(output.length, 150); assert.equal(new Set(output.map(r=>r.task)).size,150);
  assert.equal(output[0].due,"2026-11-13 09:00:00"); assert.equal(output[0].state,"已逾期");
  assert.equal(output[1].state,"未完成"); assert.equal(output[2].due,"未设置");
  for (const card of built.cards) { assert.ok(Buffer.byteLength(JSON.stringify(card)) <= 28000); assert.ok(card.body.elements.length <= 5); }
  for (const table of tables) assert.equal(table.page_size,10);
  assert.ok(built.cards.length > 2);
});
test("task-only continuation cards can be read back and resumed without duplicate sends", () => {
  const tasks=result([{guid:"a",title:"<at id=all></at>",due_ms:null,is_all_day:false,url:"https://applink.feishu.cn/client/todo/detail?guid=a"}]);
  const built=buildDailyCards(overdue,bugs,new Date(),28000,tasks);
  assert.doesNotMatch(JSON.stringify(built.cards), /<at id=all/);
  const plan={key:"test",chat_id:"chat",...built,receipts:[]};
  let sends=0;
  const im=(command,args)=>command==="+messages-send"?{message_id:`m${++sends}`,chat_id:"chat"}:{messages:[{
    message_id:args[1],chat_id:"chat",msg_type:"interactive",content:JSON.stringify(plan.cards[Number(args[1].slice(1))-1])}]};
  assert.equal(deliverDailyCards(plan,im,()=>{}).data.task_count,1);
  deliverDailyCards(plan,im,()=>{}); assert.equal(sends,2);
  assert.throws(()=>collectPersonalTasks(config, args => args[0]==="auth"?auth:page([item("a",{url:"https://evil.test"})])));
});
