import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const membershipKeys = ['im.chat.member.bot.added_v1', 'im.chat.member.bot.deleted_v1'];

// Only the trusted event consumer calls this function. Never accept message bodies.
// Persist a minimal projection: V2 headers contain a verification token, so the
// original envelope must never be logged or copied into the inbox.
export function applyMembership(envelope, config, runtimeDir, now = Date.now()) {
  const policy = config.auto_group_admission;
  const h = envelope?.header, e = envelope?.event;
  const enabledAt = Date.parse(policy?.enabled_at);
  const time = /^\d{13}$/.test(h?.create_time ?? '') ? Number(h.create_time) : NaN;
  if (policy?.enabled !== true || !policy.app_id || envelope?.schema !== '2.0' ||
      h?.app_id !== policy.app_id || !membershipKeys.includes(h?.event_type) ||
      typeof h?.event_id !== 'string' || !h.event_id || !/^oc_[A-Za-z0-9]+$/.test(e?.chat_id ?? '') ||
      !Number.isFinite(enabledAt) || !Number.isFinite(time) || time < enabledAt || time > now + 300000)
    return { changed: false, reason: 'invalid_or_pre_activation_event' };
  const added = h.event_type === membershipKeys[0];
  const inviter = e.operator_id?.open_id;
  if (added && !config.allowed_sender_ids?.includes(inviter))
    return { changed: false, reason: 'inviter_not_owner' };
  mkdirSync(runtimeDir, { recursive: true });
  const path = join(runtimeDir, 'group-admissions.json');
  let state = { schema_version: 1, profile: config.profile, app_id: policy.app_id, groups: {} };
  if (existsSync(path)) {
    state = JSON.parse(readFileSync(path, 'utf8'));
    if (state.schema_version !== 1 || state.profile !== config.profile || state.app_id !== policy.app_id ||
        !state.groups || typeof state.groups !== 'object') throw new Error('group_admission_state_mismatch');
  }
  const previous = state.groups[e.chat_id];
  if (previous && (time < previous.event_time || h.event_id === previous.event_id ||
      (time === previous.event_time && (added || previous.status === 'removed'))))
    return { changed: false, reason: 'duplicate_or_stale' };
  state.groups[e.chat_id] = { status: added ? 'admitted' : 'removed', event_id: h.event_id,
    event_time: time, inviter_id: added ? inviter : null, recorded_at: new Date(now).toISOString() };
  const temp = path + `.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  renameSync(temp, path);
  return { changed: true, chat_id: e.chat_id, status: state.groups[e.chat_id].status };
}
