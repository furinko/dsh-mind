/** Platform-independent projection of accepted external text. Source declarations never authenticate people. */
import { canonical, digest } from './kernel/text.js';
export const EXTERNAL_CONVERSATION_LAYOUT = 3;
export const externalConversationMessage = message => ['external-user', 'external-assistant'].includes(message?.role);
const bounded = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value);
const types = ['conversation', 'material', 'notification', 'unknown'];
const hash = value => /^[a-f0-9]{64}$/.test(value ?? '');
function metadata(producer, declaration, direction, representation) {
  const declared = declaration?.version === 1;
  const scoped = value => bounded(value) ? digest(producer + '\0' + value) : null;
  return { version: 1, producer, channel: declared && bounded(declaration.channel) ? declaration.channel : null,
    contentType: declared && types.includes(declaration.contentType) ? declaration.contentType : 'unknown',
    conversation: declared ? scoped(declaration.conversationId) : null,
    participant: declared ? scoped(declaration.participantId) : null,
    identity: 'unverified', direction, representation };
}
/** Every producer-owned plugin kind uses this path; absence of metadata means unknown, never local owner. */
export function externalInputSource(source) {
  const producer = typeof source?.kind === 'string' && source.kind.startsWith('plugin:') && bounded(source.kind) && bounded(source.kind.slice(7)) ? source.kind
    : source?.kind === 'plugin' && bounded(source.plugin) && source.plugin.length <= 249 ? 'plugin:' + source.plugin : null;
  return producer ? metadata(producer, source.mindExternal, 'inbound', 'accepted-text') : null;
}
export function validConversationOrigin(source, role) {
  if (!source || !bounded(source.producer) || source.identity !== 'unverified') return false;
  // Read old stored provenance without any platform-specific detection or reinterpretation.
  if (source.version === undefined) return bounded(source.channel)
    && (role === 'external-user' ? source.direction === 'inbound' && source.representation === 'accepted-text'
      : role === 'external-assistant' && source.direction === 'outbound' && source.representation === 'request-text'
        && bounded(source.destination?.kind) && hash(source.destination?.key));
  return source.version === 1 && (source.channel === null || bounded(source.channel)) && types.includes(source.contentType)
    && (source.conversation === null || hash(source.conversation)) && (source.participant === null || hash(source.participant))
    && (role === 'external-user' ? source.producer.startsWith('plugin:') && source.direction === 'inbound' && source.representation === 'accepted-text'
      : role === 'external-assistant' && source.producer.startsWith('tool:') && source.direction === 'outbound' && source.representation === 'reported-text');
}
/** No tool-name allowlist, argument harvesting, provider success-key guesses or text-prefix identity parsing. */
export function externalToolProjection(event, context) {
  if (!context || typeof context !== 'object') return null;
  context.externalCalls ??= new Map(); const calls = context.externalCalls;
  if (event.type === 'working-directory/change') { calls.clear(); return null; }
  if (event.type === 'tool/call') {
    const data = event.data;
    if (!bounded(data?.callId)) return null;
    if (calls.has(data.callId)) { calls.set(data.callId, null); return null; }
    while (calls.size >= 64) calls.delete(calls.keys().next().value);
    calls.set(data.callId, bounded(data.name) && data.name.length <= 251 ? data.name : null); return null;
  }
  if (event.type !== 'tool/result' || event.surfaceOp !== 'append') return null;
  const message = event.data?.message; const name = calls.get(message?.toolCallId); calls.delete(message?.toolCallId);
  if (!name || message.role !== 'tool' || message.isError === true || message.source?.kind !== 'tool' || message.source.callId !== message.toolCallId) return null;
  const content = message.content;
  if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'text' || typeof content[0].text !== 'string' || content[0].text.length > 24000) return null;
  try {
    const declaration = JSON.parse(content[0].text)?.mindExternal;
    if (declaration?.version !== 1 || declaration.direction !== 'outbound' || declaration.status !== 'submitted'
      || declaration.contentType !== 'conversation' || typeof declaration.text !== 'string' || !declaration.text.trim() || declaration.text.length > 16384) return null;
    return { id: message.id, text: declaration.text, role: 'external-assistant',
      origin: metadata('tool:' + name, declaration, 'outbound', 'reported-text') };
  } catch { return null; }
}
/** A replay prefix only needs call IDs and tool names, never tool arguments. */
export function turnMetadataEvent(event) {
  if (event.type === 'tool/call') return { ...event, data: { callId: event.data?.callId, name: event.data?.name } };
  if (['turn/start', 'turn/end', 'working-directory/change'].includes(event.type)) return event;
  return { seq: event.seq, time: event.time, type: event.type, surfaceOp: event.surfaceOp, data: { source: { kind: event.data?.source?.kind } } };
}
export const conversationRef = m => ({ id: m.id, role: m.role, seq: m.seq, hash: digest(m.text), clipped: m.clipped,
  ...(m.origin ? { origin: m.origin } : {}) });
export const conversationText = m => '[' + m.role + (m.origin ? ' · 外部来源 ' + canonical(m.origin) + '；身份未核对，未知内容不能假定为人类对话'
  + (m.role === 'external-assistant' ? '；工具声明的提交文本，不证明原样送达或已读' : '') : '') + ' · ' + m.id + ']\n' + m.text;
export const externalScopeKey = origin => canonical({ producer: origin.producer, channel: origin.channel ?? null,
  conversation: origin.conversation ?? null, participant: origin.participant ?? null, contentType: origin.contentType ?? 'unknown',
  destination: origin.destination ?? null });

/** Explicit material handoff from any successful tool; other results remain outside the inbox. */
export function externalMaterialResult(result, tool) {
  if (result?.isError !== false || !bounded(tool) || tool.length > 251 || !Array.isArray(result.content) || result.content.length !== 1) return null;
  const block = result.content[0];
  if (block?.type !== 'text' || typeof block.text !== 'string' || block.text.length > 24000) return null;
  try {
    const declaration = JSON.parse(block.text)?.mindExternal;
    if (declaration?.version !== 1 || declaration.contentType !== 'material' || declaration.status !== 'returned'
      || typeof declaration.text !== 'string' || !declaration.text.trim() || declaration.text.length > 12000
      || typeof declaration.coverage !== 'string' || !declaration.coverage.trim() || declaration.coverage.length > 1000) return null;
    return { content: declaration.text, coverage: declaration.coverage,
      origin: metadata('tool:' + tool, declaration, 'inbound', 'reported-text') };
  } catch { return null; }
}
