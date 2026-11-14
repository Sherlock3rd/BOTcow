import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { chatContext } from "./chat-context.mjs";
import { usesChatWorker } from "./bridge-eligibility.mjs";
import { parseChatResponse } from "./chat-model.mjs";
import { recordMode } from "./bridge-mode.mjs";

test("chat wire format preserves prose and requires valid task and weather controls", () => {
  assert.deepEqual(parseChatResponse("可以，把上一句改短。"), { kind: "answer", text: "可以，把上一句改短。" });
  assert.deepEqual(parseChatResponse("you majesty，#TASK"), { kind: "task" });
  assert.deepEqual(parseChatResponse("#ASSIST"), { kind: "assist" });
  assert.deepEqual(parseChatResponse('#WEATHER\n["成都",1]'), { kind: "weather", city: "成都", day: 1 });
  for (const value of ["", "#TASK 正在处理", '#WEATHER ["成都",8]', "#WEATHER 成都", "#ASSIST 正在查询"]) {
    assert.throws(() => parseChatResponse(value));
  }
});

test("malformed reserved route tokens cannot leak as user-visible persona text", () => {
  for (const value of ["#ASSISTANT\u0ba4\u0bae\u0bbf\u0bb4\u0bcd", "#TASKoops", "正文 #ASSISTANTdebug", "#MEMORYoops"]) {
    assert.throws(() => parseChatResponse(value));
  }
  assert.equal(parseChatResponse("# 结果\n完成核对。").kind, "answer");
});

const config = { chat_model: "fixture", allowed_chat_types: ["p2p", "group"], allowed_sender_ids: ["owner"],
  allowed_message_types: ["text", "post", "image"], allowed_group_chat_ids: ["g"], bot_open_id: "bot" };
const event = { message_id: "current", message_type: "text", chat_type: "p2p", chat_id: "a",
  sender_id: "owner", sender_type: "user", content: "为什么跑步后会口渴？" };
test("all admitted text is classified before reactions, including group and threaded replies", () => {
  assert.ok(usesChatWorker(event, config));
  assert.ok(usesChatWorker({ ...event, content: "上一句换个说法", reply_to: "reply" }, config));
  assert.ok(!usesChatWorker({ ...event, message_type: "image" }, config));
  assert.ok(usesChatWorker({ ...event, chat_type: "group", chat_id: "g", root_id: "task", mentions: [{ id: "bot" }] }, config));
  assert.ok(usesChatWorker({ ...event, thread_id: "thread" }, config));
  assert.ok(!usesChatWorker({ ...event, sender_id: "other" }, config));
});

test("in-progress tasks are available to followups but stay within sender and chat", t => {
  const dir = mkdtempSync(join(tmpdir(), "botcow-mode-context-"));
  t.after(() => { assert.equal(dirname(resolve(dir)), resolve(tmpdir())); rmSync(dir, { recursive: true, force: true }); });
  const own = { ...event, message_id: "own", content: "深入评审这个系统" };
  const foreign = { ...own, message_id: "foreign", chat_id: "b" };
  const outsider = { ...own, message_id: "outsider", sender_id: "other" };
  writeFileSync(join(dir, "inbox.ndjson"), [own, foreign, outsider, event].map(JSON.stringify).join("\n"));
  for (const row of [own, foreign, outsider]) recordMode(dir, row, "task", "test");
  const ctx = chatContext(dir, { ...event, reply_to: "own" });
  assert.deepEqual(ctx.activeTasks.map(t => t.message_id), ["own"]);
  assert.equal(ctx.quoted.mode, "task");
  assert.equal(ctx.quoted.status, "pending");
  assert.equal(ctx.missingReference, false);
  assert.equal(chatContext(dir, { ...event, reply_to: "foreign" }).missingReference, true);
});
test("quoted replies and previous text stay in the current sender and chat", t => {
  const dir = mkdtempSync(join(tmpdir(), "botcow-chat-test-"));
  t.after(() => { assert.equal(dirname(resolve(dir)), resolve(tmpdir())); rmSync(dir, { recursive: true, force: true }); });
  const messages = [{ ...event, message_id: "prior" }, { ...event, chat_id: "b", message_id: "other-chat" },
    { ...event, sender_id: "other", message_id: "other-sender" }, event, { ...event, message_id: "future" }];
  const write = (name, rows) => writeFileSync(join(dir, name + ".ndjson"), rows.map(row => JSON.stringify(row)).join("\n"));
  write("inbox", messages);
  write("processed", messages);
  write("greeting-replies", messages.map(row => ({ ...row, reply_id: "reply-" + row.message_id, text: "回答" })));
  const ctx = chatContext(dir, { ...event, reply_to: "reply-prior" });
  assert.deepEqual(ctx.history.map(row => row.message_id), ["prior"]);
  assert.equal(ctx.quoted.message_id, "prior");
  assert.ok(chatContext(dir, { ...event, reply_to: "other-chat" }).missingReference);
});


test("legacy desktop salutation is stripped from plain answers without rewriting quoted text",()=>{
  assert.deepEqual(parseChatResponse("you majesty，已经核对好了。"),{kind:"answer",text:"已经核对好了。"});
  assert.deepEqual(parseChatResponse("原句里含 you majesty，不是当前称呼。"),{kind:"answer",text:"原句里含 you majesty，不是当前称呼。"});
  assert.deepEqual(parseChatResponse("you majesty，#TASK"),{kind:"task"});
});
