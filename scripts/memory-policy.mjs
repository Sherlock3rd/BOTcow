import { createHash } from "node:crypto";
import { eligibleMessage, isOwnerSender } from "./bridge-eligibility.mjs";

export const digest = value => createHash("sha256").update(value).digest("hex");
export function safeMemoryBody(value) {
  return String(value??"").replace(/((?:access[_ -]?token|refresh[_ -]?token|app[_ -]?secret|device[_ -]?code|密码|密钥|授权码)["']?\s*[:：=]\s*["']?)[^\s,"'，；;]+/gi,"$1[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi,"Bearer [REDACTED]");
}
export function memoryScope(event, config) {
  if (!eligibleMessage(event, config) || !isOwnerSender(event,config) || !event.chat_id || !config.bot_open_id)
    throw new Error("memory_scope_denied");
  const binding = [config.profile || "default", config.bot_open_id, event.sender_id, event.chat_type, event.chat_id];
  return { id: digest(JSON.stringify(binding)), binding, owner: event.sender_id };
}
export function messageText(event) {
  let text = String(event.content ?? "").trim();
  for (const m of event.mentions ?? []) for (const prefix of [m.key, m.name && `@${m.name}`])
    if (prefix && text.startsWith(prefix)) text = text.slice(prefix.length).trim();
  return text;
}
export const mixedMemoryRequest = text => /(?:再|然后|同时|并且|顺便|并|还要).{0,12}(?:修改|改表|把.{0,20}改|写入|记录到|同步到|提交|发送|生成|制作|分析|评审|排查|配置|执行)/u.test(text);

// The model may select fields, but cannot invent consent, scope or a remembered value.
export function validateMemoryCommand(event, command) {
  const text = messageText(event);
  if (!command || !["save", "list", "update", "forget"].includes(command.operation)) throw new Error("invalid_memory_operation");
  const cue = { save: /^(?:请)?(?:帮我)?(?:记住|记下|记一下|保存.{0,8}(?:偏好|口径|记忆))/, list: /(?:记得|记住|记忆|偏好|口径|约定|之前|上周)/,
    update: /^(?:请)?(?:(?:把|将|刚才|之前|这个|那个|这条|那条|我的|记忆|偏好|口径|格式).{0,100})?(?:纠正|改一下|改成|改为|更新|更正)/,
    forget: /^(?:请)?(?:忘掉|忘记|停止使用|不再使用|取消.{0,8}(?:偏好|记忆))/ };
  if (!cue[command.operation].test(text)) throw new Error("explicit_memory_instruction_required");
  if (["save", "update"].includes(command.operation)) {
    if (typeof command.value !== "string" || !command.value.trim() || command.value.length > 2000 || !text.includes(command.value))
      throw new Error("memory_value_must_quote_current_message");
    if (/(?:access[_ -]?token|refresh[_ -]?token|app[_ -]?secret|device[_ -]?code|密码|密钥|授权码)\s*[:：=]/i.test(command.value))
      throw new Error("memory_secret_rejected");
  }
  if (command.target != null && (typeof command.target !== "string" || command.target.length > 2000))
    throw new Error("invalid_memory_target");
  const valueMatch=command.operation==="update"?text.match(/(?:改成|改为|更正为|更新为|改一下[，,:：\s]+)[，,:：\s]*(.+?)[。！!]?$/su):
    command.operation==="save"?text.match(/(?:记住|记下|记一下)[，,:：\s]*(.+?)[。！!]?$/su):null;
  let value=valueMatch?.[1]??command.value?.trim();
  if(value&&mixedMemoryRequest(value)&&command.value&&!mixedMemoryRequest(command.value)) value=command.value.trim();
  if(value&&mixedMemoryRequest(value)) throw new Error("memory_value_contains_business_action");
  return { operation: command.operation, value, target: command.target?.trim(),
    expected_revision: command.expected_revision };
}

export function parseMemoryCommand(event) {
  const text = messageText(event);
  if (mixedMemoryRequest(text)) return null;
  if (/^(?:你)?(?:还)?记得.{0,30}(?:偏好|口径|要求|记忆|什么|哪些)/u.test(text)) return {operation:"list"};
  if(/[？?]$/.test(text)||/^(?:你)?记住了?吗/.test(text)) return null;
  let match = text.match(/^(?:请)?(?:记住|记下|记一下)[，,:：\s]*(.+?)[。！!]?$/su);
  if (match) return { operation: "save", value: match[1] };
  if (/^(?:你)?(?:还)?(?:记得|记住了|保存了).{0,16}(?:什么|哪些|偏好|口径|要求)[？?。]?$/u.test(text) ||
      /^(?:查看|列出|看看)(?:我的|当前)?(?:长期)?(?:记忆|偏好)[？?。]?$/u.test(text)) return { operation: "list" };
  match = text.match(/^(?:请)?(?:忘掉|忘记|停止使用|不再使用)[，,:：\s]*(.+?)[。！!]?$/su);
  if (match) return { operation: "forget", target: match[1] };
  match = text.match(/^(?:把|将)?(.+?)(?:改成|改为|更正为)[，,:：\s]*(.+?)[。！!]?$/su);
  if (match && /记忆|偏好|口径/.test(match[1])) return { operation: "update", target: match[1], value: match[2] };
  return null;
}
