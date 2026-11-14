import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { greetingReply } from "./bridge-eligibility.mjs";
import { memoryEnabled,recordVerifiedReply } from "./context-builder.mjs";

// Persist the reply ID before verification so a retry of readback/mark never resends it.
export function deliverGreeting(event, config, runtimeDir, im, finish, answer = null, failure = null, epoch = undefined) {
  const ledger = join(runtimeDir, failure ? "read-query-notices.ndjson" : "greeting-replies.ndjson");
  const receipts = existsSync(ledger) ? readFileSync(ledger, "utf8").trim().split(/\r?\n/).filter(Boolean) : [];
  const prior = receipts.map(line => JSON.parse(line)).findLast(record => record.message_id === event.message_id && (record.failure ?? null) === failure);
  const payload=prior?.payload ?? answer ?? greetingReply(event,config);
  const media=payload&&typeof payload==="object";
  if(media && (payload.type!=="image"||!/^img_[A-Za-z0-9_-]+$/.test(payload.content?.image_key??"")||typeof payload.text!=="string"))
    throw new Error("invalid sticker payload");
  const text=media?payload.text:payload;
  if(typeof text!=="string"||!text)throw new Error("message is not an admitted greeting");
  let replyId = prior?.reply_id;
  if (!replyId) {
    // Freeze image selection before sending so an uncertain send retries the same payload/key.
    if(media&&!prior?.payload) appendFileSync(ledger,JSON.stringify({message_id:event.message_id,payload,text,failure,epoch,
      prepared_at:new Date().toISOString()})+"\n");
    const contentArgs=media?["--msg-type","image","--content",JSON.stringify(payload.content)]:["--text",text];
    const sent = im("+messages-reply", ["--message-id", event.message_id, ...contentArgs,
      "--idempotency-key", failure
        ? "notice-" + createHash("sha256").update(event.message_id + ":" + failure).digest("hex").slice(0, 40)
        : `greet-${event.message_id}`]);
    replyId = sent.message_id;
    if (!replyId || sent.chat_id !== event.chat_id) throw new Error("missing or mismatched greeting receipt");
    appendFileSync(ledger, JSON.stringify({ message_id: event.message_id, reply_id: replyId, text, failure, ...(media?{payload,epoch}:{}),
      sent_at: new Date().toISOString() }) + "\n");
  }
  const { messages } = im("+messages-mget", ["--message-ids", replyId, "--no-reactions"]);
  const reply = messages?.find(m => m.message_id === replyId);
  let actualKey;
  if(media&&reply) {
    if(typeof reply.content==="object")actualKey=reply.content?.image_key;
    else {try {actualKey=JSON.parse(reply.content)?.image_key;}catch{actualKey=/^\[Image:\s*([^\]]+)\]$/.exec(reply.content??"")?.[1];}}
  }
  if (!reply || reply.deleted || reply.reply_to !== event.message_id || reply.chat_id !== event.chat_id ||
      (media ? reply.msg_type!=="image"||actualKey!==payload.content.image_key : reply.content !== (prior?.text ?? text)) || reply.sender?.open_bot_id !== config.bot_open_id) {
    throw new Error("greeting reply readback did not match");
  }
  if(memoryEnabled(config)) {
    try {recordVerifiedReply(runtimeDir,config,event,reply,epoch);}
    catch { /* durable projection is replayed later; never resend a verified reply */ }
  }
  finish(event.message_id, replyId);
  return replyId;
}
