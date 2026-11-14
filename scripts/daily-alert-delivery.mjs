export function deliverDailyCards(plan, callIm, save) {
  for (let index = 0; index < plan.cards.length; index++) {
    let receipt = plan.receipts[index];
    if (!receipt) {
      const args = plan.reply_message_id ? ["--message-id", plan.reply_message_id] : ["--chat-id", plan.chat_id];
      const sent = callIm(plan.reply_message_id ? "+messages-reply" : "+messages-send", [...args,
        "--msg-type", "interactive", "--content", JSON.stringify(plan.cards[index]),
        "--idempotency-key", `${plan.key}-${index+1}`]);
      if (!sent.message_id || sent.chat_id !== plan.chat_id) throw new Error("Unexpected delivery receipt");
      receipt = plan.receipts[index] = { message_id: sent.message_id, verified: false };
      save(plan);
    }
    if (!receipt.verified) {
      const read = callIm("+messages-mget", ["--message-ids", receipt.message_id, "--no-reactions"]);
      const message = read.messages?.find(m => m.message_id === receipt.message_id);
      const subtitle = plan.cards[index].header?.subtitle?.content;
      const hasTaskTable = plan.cards[index].body?.elements?.some(e => e.tag === "table" && e.columns.some(c => c.name === "task"));
      const marker = hasTaskTable ? "我的未完成任务" : "Dobe 未关闭 Bug";
      if (!message || message.deleted || message.chat_id !== plan.chat_id || message.msg_type !== "interactive"
        || !message.content?.includes(marker)
        || (subtitle && !message.content.includes(subtitle))) throw new Error("Card readback failed");
      receipt.verified = true;
      save(plan);
    }
  }
  return { ok: true, data: { message_id: plan.receipts[0].message_id, message_ids: plan.receipts.map(r => r.message_id),
    card_count: plan.cards.length, bug_count: plan.bug_count, bugs_complete: plan.bugs_complete, bug_error: plan.bug_error,
    task_count: plan.task_count, tasks_complete: plan.tasks_complete, task_error: plan.task_error } };
}
