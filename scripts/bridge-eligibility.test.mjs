import { test } from "node:test";
import assert from "node:assert/strict";
import { eligibleMessage } from "./bridge-eligibility.mjs";

const config = {
  allowed_sender_ids: ["owner"],
  allowed_chat_types: ["p2p", "group"],
  allowed_message_types: ["text", "post", "image"],
  allowed_group_chat_ids: ["approved-group"], bot_open_id: "bot",
};
const event = {
  message_id: "message", sender_type: "user", sender_id: "owner",
  chat_type: "group", chat_id: "approved-group", message_type: "text",
  mentions: [{ id: "bot" }],
};
test("accept owner mentioning this bot in approved group", () => {
  assert.equal(eligibleMessage(event, config), true);
});
test("reject other groups, senders, unmentioned chat and wrong bot", () => {
  for (const change of [
    { chat_id: "other-group" }, { sender_id: "other-person" },
    { sender_type: "app" }, { mentions: [] }, { mentions: undefined },
    { mentions: [{ id: "other-bot" }] }, { message_type: "system" },
    { message_id: "" }, { chat_type: "topic" },
  ]) assert.equal(eligibleMessage({ ...event, ...change }, config), false);
});
test("group access fails closed when configuration is incomplete", () => {
  for (const change of [
    { allowed_group_chat_ids: undefined }, { bot_open_id: undefined },
    { allowed_chat_types: ["p2p"] },
  ]) assert.equal(eligibleMessage(event, { ...config, ...change }), false);
});
test("existing owner DM remains accepted without mentions", () => {
  assert.equal(eligibleMessage({ ...event, chat_type: "p2p", mentions: undefined }, config), true);
  assert.equal(eligibleMessage({ ...event, chat_type: "p2p", sender_id: "other" }, config), false);
});
