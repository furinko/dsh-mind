/** Narrow adapters for accepted QQ input and successful QQ send receipts; no text-prefix identity inference. */
import { digest } from './kernel/text.js';
export const EXTERNAL_CONVERSATION_LAYOUT = 2;
export const externalConversationMessage = message => ['external-user', 'external-assistant'].includes(message?.role);
export function qqInputSource(source) {
  if (source?.kind === 'plugin:dsh-qq-bridge' || source?.kind === 'plugin' && source.plugin === 'qq-bridge') {
    return { channel: 'qq', producer: 'dsh-qq-bridge', direction: 'inbound', identity: 'unverified', representation: 'accepted-text' };
  }
  return null;
}
export function validConversationOrigin(source, role) {
  return source && source.channel === 'qq' && source.producer === 'dsh-qq-bridge' && source.identity === 'unverified'
    && (role === 'external-user' ? source.direction === 'inbound' && source.representation === 'accepted-text'
      : role === 'external-assistant' && source.direction === 'outbound' && source.representation === 'request-text'
        && ['group', 'private'].includes(source.destination?.kind) && /^[a-f0-9]{64}$/.test(source.destination?.key ?? ''));
}
export function qqToolProjection(event, context) {
  if (!context || typeof context !== 'object') return null;
  context.qqCalls ??= new Map(); const calls = context.qqCalls;
  if (event.type === 'working-directory/change') { calls.clear(); return null; }
  if (event.type === 'tool/call') {
    const data = event.data;
    if (typeof data?.callId !== 'string' || data.callId.length > 256) return null;
    if (calls.has(data.callId)) { calls.set(data.callId, null); return null; }
    while (calls.size >= 64) calls.delete(calls.keys().next().value);
    calls.set(data.callId, null);
    if (data.name !== 'qq_bridge_send' || typeof data.arguments !== 'string' || data.arguments.length > 65536) return null;
    try {
      const args = JSON.parse(data.arguments);
      if (typeof args?.text !== 'string' || !args.text.trim() || args.text.length > 16384) return null;
      calls.set(data.callId, { text: args.text, groupId: args.groupId, userId: args.userId });
    } catch { /* Invalid or unpaired tool arguments never become conversation text. */ }
    return null;
  }
  if (event.type !== 'tool/result' || event.surfaceOp !== 'append') return null;
  const message = event.data?.message; const call = calls.get(message?.toolCallId); calls.delete(message?.toolCallId);
  if (!call || message.role !== 'tool' || message.isError === true || message.source?.kind !== 'tool' || message.source.callId !== message.toolCallId) return null;
  const content = message.content;
  if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'text' || typeof content[0].text !== 'string' || content[0].text.length > 8000) return null;
  try {
    const result = JSON.parse(content[0].text); const dest = result.destination;
    const id = dest?.kind === 'group' ? dest.groupId : dest?.kind === 'private' ? dest.userId : null;
    if (result.sent !== 1 || result.dropped !== false || !/^[0-9]{1,20}$/.test(String(id ?? ''))
      || call.groupId != null && (dest.kind !== 'group' || String(call.groupId) !== String(id))
      || call.userId != null && (dest.kind !== 'private' || String(call.userId) !== String(id))) return null;
    return { id: message.id, text: call.text, role: 'external-assistant',
      origin: { channel: 'qq', producer: 'dsh-qq-bridge', direction: 'outbound', identity: 'unverified', representation: 'request-text', destination: { kind: dest.kind, key: digest(String(id)) } } };
  } catch { return null; }
}
/** Only the known send call may retain its bounded text while replaying a prefix. */
export function turnMetadataEvent(event) {
  if (event.type === 'tool/call') return { ...event, data: { callId: event.data?.callId, name: event.data?.name, ...(event.data?.name === 'qq_bridge_send' ? { arguments: event.data.arguments } : {}) } };
  if (['turn/start', 'turn/end', 'working-directory/change'].includes(event.type)) return event;
  return { seq: event.seq, time: event.time, type: event.type, surfaceOp: event.surfaceOp, data: { source: { kind: event.data?.source?.kind } } };
}
export const conversationRef = m => ({ id: m.id, role: m.role, seq: m.seq, hash: digest(m.text), clipped: m.clipped,
  ...(m.origin ? { origin: m.origin } : {}) });
export const conversationText = m => '[' + m.role + (m.origin ? ' · QQ插件来源，参与者身份未核对' + (m.role === 'external-assistant' ? '；发送请求文本，桥接声明成功，格式可能转换' : '') : '') + ' · ' + m.id + ']\n' + m.text;
