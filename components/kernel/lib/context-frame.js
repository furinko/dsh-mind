/** Model projection only. Original frames and their version/permission checks stay intact. */
import { canonical } from '../../../src/kernel/text.js';

const INTERNAL_FIELDS = {
  'mind:professional-context': ['观察ID', '数据版本'],
  'mind:lead-continuity': ['观察ID', '数据版本'],
  'mind:turn-buffer': ['数据版本', '下次事件序号'],
  'mind:information-growth': ['dataRevision'],
  'mind:project-brief': ['数据版本', '来源修订'],
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
