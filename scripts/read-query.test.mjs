import assert from "node:assert/strict";
import { test } from "node:test";
import { obviousRead, performRead } from "./read-query.mjs";
import { parseChatResponse } from "./chat-model.mjs";

const event = { chat_type: "p2p", sender_id: "owner" };
const auth = { identities: { user: { openId: "owner", status: "ready", available: true } } };
const query = { kind: "document_count" };
test("standalone count goes direct; a write, filter or different owner does not match", () => {
  for (const s of ["我有多少个文档", "你知道现在我有多少个文档了吗？", "我目前拥有几篇飞书文档？"])
    assert.deepEqual(obviousRead(s), query);
  for (const s of ["我有多少个文档，顺便删掉旧的", "他有多少个文档", "我本周创建了多少个文档"])
    assert.equal(obviousRead(s), null);
  assert.deepEqual(parseChatResponse('#READ {"kind":"agenda_today"}'), { kind: "read", query: { kind: "agenda_today" } });
  assert.throws(() => parseChatResponse('#READ {"kind":"delete"}'));
});
test("count all owned doc/docx pages, deduplicate, ignore the approximate total", () => {
  const pages = [
    { total: 100, results: [{ entity_id: "a" }, { entity_id: "b" }], has_more: true, page_token: "next" },
    { total: 100, results: [{ entity_id: "b" }, { entity_id: "c" }], has_more: false },
  ];
  const reply = performRead(query, event, args => {
    if (args[0] === "auth") return auth;
    assert.ok(args.includes("--mine") && args.includes("doc,docx") && args.includes("user"));
    if (pages.length === 1) assert.ok(args.includes("next"));
    return { data: pages.shift() };
  });
  assert.match(reply.text, /3 篇/);
  assert.equal(pages.length, 0);
  assert.match(performRead(query, event, a => a[0] === "auth" ? auth : { data: { results: [], has_more: false } }).text, /0 篇/);
});
test("missing authorization and mismatched sender stop before searching; page failure gives no total", () => {
  let calls = 0;
  assert.equal(performRead(query, event, () => { calls++; return { identities: { user: { status: "missing" } } }; }).code, "user_auth");
  assert.equal(calls, 1);
  assert.equal(performRead(query, { ...event, sender_id: "someone" }, () => auth).code, "user_identity");
  assert.equal(performRead(query, { ...event, chat_type: "group" }, () => assert.fail()).code, "private_chat");
  assert.equal(performRead(query, event, a => a[0] === "auth" ? auth : { data: { results: [], has_more: true, page_token: "same" } }).code, "read_failed");
  assert.equal(performRead(query, event, a => {
    if (a[0] === "auth") return auth;
    throw Object.assign(new Error(), { feishu: { type: "authorization", subtype: "missing_scope" } });
  }).code, "permission");
});
