import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const scripts = dirname(fileURLToPath(import.meta.url));

test("the single worker dispatches only its admitted event and supplies rules and image inputs", t => {
  const root = mkdtempSync(join(tmpdir(), "botcow-wakeup-test-"));
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  for (const dir of ["scripts", "runtime", "config", "rules", "docs", "knowledge"]) mkdirSync(join(root, dir));
  for (const name of ["codex-event-wakeup", "bridge-queue", "bridge-eligibility", "worker-output", "greeting-reply",
    "chat-model", "chat-context", "chat-weather", "read-query", "assistant-profile", "bridge-mode", "bridge-reaction",
    "memory-policy", "memory-store", "context-builder", "memory-management", "task-session-registry", "chat-stickers", "request-risk", "task-control", "task-notice"]) {
    copyFileSync(join(scripts, name + ".mjs"), join(root, "scripts", name + ".mjs"));
  }
  const write = (file, value) => writeFileSync(join(root, file), value);
  write("AGENTS.md", "project instructions fixture");
  write("rules/rules.md", "current rules fixture");
  mkdirSync(join(root,"docs/personas"));write("docs/personas/whale-character.md","common character fixture");
  write("docs/assistant-persona.md", "shared persona fixture");
  write("knowledge/assistant-core.md", "shared knowledge fixture");
  write("config/bridge.json", JSON.stringify({
    profile: "botCow", allowed_sender_ids: ["owner"], allowed_chat_types: ["group", "p2p"],
    allowed_message_types: ["text", "post", "image"], allowed_group_chat_ids: ["group"], bot_open_id: "bot",
    event_wakeup: { enabled: true, thread_id: "test-thread", model: "fixture-model", reasoning_effort: "high" },
    reaction_types: { processing: "OnIt", done: "DONE" },
  }));
  const group = {
    message_id: "om_group", message_type: "text", sender_type: "user", sender_id: "owner",
    chat_type: "group", chat_id: "group", mentions: [{ id: "bot" }], reply_to: "parent", root_id: "root",
    content: '第一行\n"第二行" $(literal)', captured_at: new Date().toISOString(),
  };
  const image = { ...group, chat_id: "dm", chat_type: "p2p", message_id: "om_photo",
    message_type: "post", content: "说明 ![Image](img_photo)" };
  const records = [
    { ...group, message_id: "other", mentions: [], content: "unmentioned-private" },
    { ...group, message_id: "done", content: "completed-private" },
    { ...group, message_id: "blocked", content: "blocked-private" },
    { ...group, message_id: "greeting", chat_type: "p2p", mentions: [], reply_to: null, root_id: null, content: "你好" },
    group, group, image, { ...image, message_id: "missing", message_type: "image" },
  ];
  write("runtime/inbox.ndjson", records.map(x => JSON.stringify(x)).join("\n"));
  write("runtime/processed.ndjson", '{"message_id":"done"}\n');
  write("runtime/blocked.ndjson", '{"message_id":"blocked","status":"blocked"}\n');

  // Substitute only the two external services. The production worker, lock and queue run normally.
  write("scripts/fetch-message-images.mjs", `
    const images = process.argv[2] === "missing" ? [] : [{ absolute_path: "fixture-image.png" }];
    console.log(JSON.stringify({ ok: true, images }));
  `);
  write("exec", `
    const fs = require("node:fs");
    const { execFileSync } = require("node:child_process");
    const prompt = fs.readFileSync(0, "utf8");
    const event = JSON.parse(prompt.split("\\n").find(line => line.startsWith("{")));
    fs.appendFileSync("runtime/dispatched", JSON.stringify({ prompt, args: process.argv.slice(2), event }) + "\\n");
    execFileSync(process.execPath, ["scripts/bridge-mode.mjs", "task", "--message-id", event.message_id]);
    if (event.message_id !== "missing") {
      fs.appendFileSync("runtime/reactions.ndjson", JSON.stringify({ message_id: event.message_id, status: "done", ok: true }) + "\\n");
    }
    const action = event.message_id === "missing"
      ? ["block", "--error-type", "image", "--error-fingerprint", "image", "--reason", "missing", "--recovery-condition", "restore"]
      : ["mark", "--reply-id", "fixture-reply"];
    execFileSync(process.execPath, ["scripts/bridge-queue.mjs", ...action, "--message-id", event.message_id]);
  `);
  execFileSync(process.execPath, ["scripts/codex-event-wakeup.mjs"], {
    cwd: root, env: { ...process.env, BOTCOW_CODEX_EXE: process.execPath }, timeout: 30000,
  });
  const runs = readFileSync(join(root, "runtime/dispatched"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(runs.map(run => run.event.message_id), ["om_group", "om_photo", "missing"]);
  assert.equal(runs[0].event.content, group.content);
  assert.equal(runs[0].event.reply_to, group.reply_to);
  assert.equal(runs[0].event.root_id, group.root_id);
  assert.deepEqual(runs[0].event.mentions, group.mentions);
  for (const { prompt } of runs) {
    assert.ok(prompt.includes("project instructions fixture") && prompt.includes("current rules fixture"));
    assert.ok(prompt.includes("shared persona fixture") && prompt.includes("shared knowledge fixture"));
    assert.ok(prompt.includes("chat 全程不得调用表情接口"));
    assert.ok(!/unmentioned-private|blocked-private|bridge-queue\.mjs pending/.test(prompt));
  }
  for (const { args } of runs) {
    assert.ok(args.includes('model_reasoning_effort="high"'));
    assert.equal(args[args.indexOf("--model") + 1], "fixture-model");
  }
  assert.ok(!runs[0].args.includes("--image"));
  assert.equal(runs[1].args[runs[1].args.indexOf("--image") + 1], "fixture-image.png");
  assert.ok(!runs[2].args.includes("--image"));
  assert.ok(runs[2].prompt.includes('"ok":false'));
  assert.match(readFileSync(join(root, "runtime/codex-wakeup.log"), "utf8"), /capture_to_prompt_ms=\d+/);
});
