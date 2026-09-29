// lib/insert.js — 会话注入的定位逻辑（R0 注入与 R1 召回共用）。
//
// 通道与官方 `dsh-agent-instructions` 同构：把一条 user 消息塞进 agent 的消息流，
// 它随上下文携带。**纯逻辑、不碰 fs**，便于单测与复用。
//
// 为什么插在 "claimed" 之后：claimed 是本次真正被领取的用户消息（指令本身），
// 注入的规则/记忆应当**紧跟指令**、在其后的上下文里生效，而不是被挤到队尾稀释掉。

/**
 * 每会话去重用的 key（会话销毁后新会话重新注入）。
 * @returns {string|null} 取不到 id ⇒ null（该会话不参与去重，调用方应跳过）
 */
export function sessionKey(agent) {
  const id = agent?.session?.header?.id;
  return id ? `session:${String(id)}` : null;
}

/** claimed 用户消息在 `decision.messages` 里的最后位置（用 Set 判属，O(n)）。 */
function lastClaimedIndex(decision, messages) {
  const claimed = new Set(messages || []);
  const arr = decision?.messages;
  if (!Array.isArray(arr)) return -1;
  for (let i = arr.length - 1; i >= 0; i -= 1) if (claimed.has(arr[i])) return i;
  return -1;
}

/**
 * 把 `newMessage` 插到 claimed 用户消息之后；无 claimed 则放最前。
 * 保留 decision 的其它字段（如 `kind`），不丢。
 * @returns {object} 新的 decision（不可变式，不改原对象）
 */
export function insertAfterClaimed(decision, messages, newMessage) {
  const msgs = decision?.messages;
  if (!Array.isArray(msgs)) return decision;
  const idx = lastClaimedIndex(decision, messages);
  const out = msgs.slice();
  if (idx >= 0) out.splice(idx + 1, 0, newMessage);
  else out.unshift(newMessage);
  return { ...decision, messages: out };
}
