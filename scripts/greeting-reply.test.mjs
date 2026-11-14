import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { greetingReply } from "./bridge-eligibility.mjs";
import { deliverGreeting } from "./greeting-reply.mjs";

const config = { bot_open_id: "bot", allowed_sender_ids: ["owner"], allowed_chat_types: ["p2p", "group"],
  allowed_group_chat_ids: ["approved"], allowed_message_types: ["text", "post", "image"] };
const event = { message_id: "om_test", chat_id: "dm", sender_type: "user", sender_id: "owner",
  chat_type: "p2p", message_type: "text", content: "测试一下，你好呀" };

test("route whole standalone greetings only, including a single approved bot mention", () => {
  const group = { ...event, chat_type: "group", chat_id: "approved", mentions: [{ id: "bot", key: "@_user_1", name: "牛马小助手" }] };
  for (const content of ["你好！", " 在吗？ ", "测试一下，你好呀", "PING"]) assert.ok(greetingReply({ ...event, content }, config));
  for (const content of ["@牛马小助手 你好", "@_user_1 你好"]) assert.ok(greetingReply({ ...group, content }, config));
  for (const delta of [{ content: "你好，帮我查一下排期" }, { content: "测试一下加速效果" }, { content: "你好\n查任务" },
    { message_type: "post" }, { message_type: "image" }, { reply_to: "parent" }, { root_id: "root" },
    { sender_id: "other" }, { ...group, mentions: [] }, { ...group, chat_id: "other" }]) {
    assert.equal(greetingReply({ ...event, ...delta }, config), null);
  }
});

test("persist send before readback and retry without sending or marking twice", t => {
  const dir = mkdtempSync(join(tmpdir(), "botcow-greeting-test-"));
  t.after(() => {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    rmSync(dir, { recursive: true, force: true });
  });
  let sends = 0, marks = 0, correct = false;
  const im = (command, args) => {
    if (command === "+messages-reply") {
      sends++;
      assert.ok(args.includes("greet-om_test"));
      return { message_id: "reply", chat_id: "dm" };
    }
    return { messages: [{ message_id: "reply", chat_id: "dm", reply_to: correct ? "om_test" : "wrong",
      sender: { open_bot_id: "bot" }, content: greetingReply(event, config) }] };
  };
  const finish = () => { marks++; };
  assert.throws(() => deliverGreeting(event, config, dir, im, finish), /readback/);
  assert.equal(marks, 0);
  correct = true;
  assert.equal(deliverGreeting(event, config, dir, im, finish), "reply");
  assert.equal(marks, 1);
  assert.equal(sends, 1);
});

test("an authorization notice and a later successful answer have separate receipts", t => {
  const dir = mkdtempSync(join(tmpdir(), "botcow-read-notice-test-"));
  t.after(() => {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    rmSync(dir, { recursive: true, force: true });
  });
  const sent = new Map(), keys = [];
  function im(command, args) {
    if (command === "+messages-reply") {
      keys.push(args[args.indexOf("--idempotency-key") + 1]);
      const r = { message_id: "reply" + keys.length, chat_id: event.chat_id, reply_to: event.message_id,
        sender: { open_bot_id: config.bot_open_id }, content: args[args.indexOf("--text") + 1] };
      sent.set(r.message_id, r);
      return r;
    }
    return { messages: [sent.get(args[1])] };
  }
  const blocked = [], marked = [];
  for (let i = 0; i < 2; i++) {
    deliverGreeting(event, config, dir, im, (_, id) => blocked.push(id), "需要授权", "user_auth");
  }
  deliverGreeting(event, config, dir, im, (_, id) => marked.push(id), "共有 2 篇");
  assert.deepEqual(blocked, ["reply1", "reply1"]);
  assert.deepEqual(marked, ["reply2"]);
  assert.equal(new Set(keys).size, 2);
});
