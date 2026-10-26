/** Model projection only. Original frames and their version/permission checks stay intact. */
import { canonical } from '../../../src/kernel/text.js';

const INTERNAL_FIELDS = {
  'mind:professional-context': ['观察ID', '数据版本'],
  // Retrieval provenance stays in the checked raw frame, including the exact
  // accepted-expression stamp. It is not recalled material for the model.
  'mind:lead-continuity': ['观察ID', '数据版本', '焦点线索'],
  'mind:turn-buffer': ['数据版本', '下次事件序号'],
  // Submission IDs change with ordinary conversation and tool traffic. They remain
  // available through information_query status, rather than renewing every snapshot.
  'mind:information-growth': ['dataRevision', 'conversationMessages', 'sourceToolReceipts'],
  'mind:project-brief': ['数据版本', '来源修订', '待整理消息数', '摘要待更新'],
  'mind:lead-free-space': ['runtime'],
};

export function renderContextFrame(name, frame) {
  const hidden = INTERNAL_FIELDS[name] ?? [];
  const view = Object.fromEntries(Object.entries(frame).filter(([key]) => !hidden.includes(key)));
  // Match JSON's treatment of undefined; only canonicalize the model projection.
  return canonical(JSON.parse(JSON.stringify(view)));
}

/** Each injector renders guidance followed by one complete JSON line. */
export function contextPayload(text) {
  const end = text.lastIndexOf('\n');
  return `${text.split('\n', 1)[0]}\n${text.slice(end + 1)}`;
}
