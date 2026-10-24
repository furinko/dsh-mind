/** 只读本会话本轮已接纳文本并保留来源；不窥待接纳消息，不缓存或复制聊天账本。 */
import { canonical, digest } from '../../../src/kernel/text.js';
import { externalInputSource } from '../../../src/conversation-origin.js';

export const EXPRESSION_EVENT_LIMIT = 256;
export const EXPRESSION_TEXT_LIMIT = 800;
const boundedId = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 256;

export function readAcceptedExpression(session, { allowExternal = false } = {}) {
  try {
    if (!boundedId(session?.id) || typeof session.eventAt !== 'function' || typeof session.isOwnSeq !== 'function'
        || !Number.isSafeInteger(session.seq) || session.seq < 1) return null;
    const end = session.seq;
    let candidate = null;
    for (let seq = end - 1; seq >= Math.max(0, end - EXPRESSION_EVENT_LIMIT); seq--) {
      const event = session.eventAt(seq);
      if (!event || event.seq !== seq || session.isOwnSeq(seq) !== true) return null;
      if (event.type === 'turn/end') return null;
      // 新消息已领取但尚未接纳时，不能沿用此前表达冒充本次输入。
      if (!candidate && event.type === 'agent/inbox/spliced' && event.data?.removedCount > 0 && event.data?.outcome !== 'canceled') return null;
      if (!candidate && event.type === 'user/message') {
        if (event.data?.source?.kind === 'user') candidate = event;
        else {
          const origin = externalInputSource(event.data?.source);
          if (origin?.contentType === 'conversation' && !allowExternal) return null;
          if (origin && origin.contentType !== 'notification' && allowExternal) candidate = event;
        }
      }
      if (event.type !== 'turn/start') continue;
      const message = candidate?.data;
      if (!Number.isSafeInteger(event.data?.turn) || event.data.turn < 1 || !boundedId(message?.id) || message.role !== 'user'
          || !Array.isArray(message.content)) return null;
      // 已接纳后又被压缩/替换移出模型表面的原文，不重新从历史捞回。
      const nodes = session.surface?.nodes;
      if (candidate.surfaceOp !== 'append' || !Array.isArray(nodes) || !nodes.slice(-EXPRESSION_EVENT_LIMIT).includes(candidate.seq)) return null;
      let query = ''; let truncated = message.content.length > 64;
      for (const block of message.content.slice(0, 64)) {
        if (block?.type !== 'text' || typeof block.text !== 'string') continue;
        const remaining = EXPRESSION_TEXT_LIMIT - query.length;
        const separator = query ? '\n' : '';
        query += (separator + block.text.slice(0, Math.max(0, remaining - separator.length))).slice(0, remaining);
        truncated ||= separator.length + block.text.length > remaining;
      }
      query = query.trim();
      if (!query) return null;
      const description = { 类型: message.source.kind === 'user' ? '已接纳用户来源文本' : '已接纳外部来源文本，类型见来源，参与者身份未核对', 会话: session.id, 轮次: event.data.turn,
        事件序号: candidate.seq, 消息: message.id, 截断: truncated,
        ...(message.source.kind !== 'user' ? { 来源: externalInputSource(message.source) } : {}),
        依据: '本轮已接纳文本的词面线索；来源标记不认证原话、意图或授权' };
      return { query, description, stamp: digest(canonical({ description, query })) };
    }
  } catch { /* SDK缺能力、读取失败或不可判时保留原目标召回，不泄露聊天内容。 */ }
  return null;
}
