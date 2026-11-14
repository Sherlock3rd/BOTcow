import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const admissionPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime', 'group-admissions.json');

// Read the same atomic projection in every process; new invites do not restart
// active tasks or replace the startup configuration.
export function admittedGroup(event, config, path = admissionPath) {
  const manual = config.allowed_group_chat_ids?.includes(event?.chat_id) === true;
  if (config.auto_group_admission?.enabled !== true) return manual;
  if (!existsSync(path)) return manual;
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'));
    if (state.schema_version !== 1 || state.profile !== config.profile ||
        state.app_id !== config.auto_group_admission.app_id || !state.groups) return false;
    const entry = state.groups[event?.chat_id];
    if (!entry) return manual;
    if (entry.status !== 'admitted' || !config.allowed_sender_ids?.includes(entry.inviter_id)) return false;
    const messageTime = /^\d{13}$/.test(event?.create_time ?? '') ? Number(event.create_time) : NaN;
    const activated = Date.parse(config.auto_group_admission.enabled_at);
    return Number.isFinite(messageTime) && Number.isFinite(activated) &&
      messageTime >= entry.event_time && messageTime >= activated;
  } catch { return false; }
}

// Shared by the listener and queue so acknowledgement and execution agree.
export const isOwnerSender=(event,config)=>config.allowed_sender_ids?.includes(event?.sender_id)===true;
export const isPublicGroup=(event,config)=>event?.sender_type==="user"&&event.chat_type==="group"&&
  config.group_public?.enabled===true&&admittedGroup(event,config)&&!isOwnerSender(event,config);
export function eligibleMessage(event, config) {
  if (!event?.message_id || event.sender_type !== "user" ||
      !event.sender_id ||
      !config.allowed_chat_types?.includes(event.chat_type) ||
      !config.allowed_message_types?.includes(event.message_type)) return false;
  if (event.chat_type === "p2p") return isOwnerSender(event,config);
  if (event.chat_type !== "group") return false;
  return (isOwnerSender(event,config)||isPublicGroup(event,config)) && Boolean(config.bot_open_id) &&
    admittedGroup(event,config) &&
    Array.isArray(event.mentions) &&
    event.mentions.some((mention) => mention.id === config.bot_open_id);
}

// Match the whole message. A greeting in front of a request is still a request.
export function greetingReply(event, config) {
  if (!eligibleMessage(event, config) || event.message_type !== "text" ||
      event.reply_to || event.root_id || event.thread_id || typeof event.content !== "string") return null;
  let body = event.content.trim();
  if (event.mentions?.length) {
    if (event.mentions.length !== 1 || event.mentions[0].id !== config.bot_open_id) return null;
    const mention = event.mentions[0];
    const prefix = [mention.key, mention.name && `@${mention.name}`].find(s => s && body.startsWith(s));
    if (!prefix) return null;
    body = body.slice(prefix.length).trim();
  }
  const plain = body.normalize("NFKC").replace(/[.!?,~。！？，～\s]+$/u, "").trim();
  if (/^(?:你好[呀啊]?|您好|在吗|在不在|hello|hi|嗨|哈喽)$/iu.test(plain))
    return "在呀，怎么啦？";
  if (/^(?:测试一下|连通性测试|测试连接|ping)(?:[,，、\s]+(?:你好[呀啊]?|在吗))?$/iu.test(plain))
    return "收到了，在线。";
  return null;
}

export function usesChatWorker(event, config) {
  if(isPublicGroup(event,config)&&eligibleMessage(event,config))return true;
  if (greetingReply(event, config)) return true;
  return Boolean(config.chat_model && eligibleMessage(event, config) &&
    event.message_type === "text" && typeof event.content === "string" &&
    event.content.trim());
}
