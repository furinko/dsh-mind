import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { loadClient, makeSlots, makeCtx, makeStrictRequire, createRenderer, collect, textOf, jsonResponse, settle } from 'file:///C:/Users/wjthq/AppData/Local/Temp/dsh-mind-conversation-approval-RPsVEF/product/components/board/test/client-harness.mjs';
const owner = 'root-independent-slow-response-session';
const requests = [];
const loaded = loadClient({ fetch: (url) => {
  if (!url.startsWith('/plugins/dsh-mind/intervention')) return Promise.resolve(jsonResponse({ 成功: true }));
  return new Promise(resolve => requests.push({ resolve, url }));
} });
const { slots, calls } = makeSlots();
const plugin = loaded.definition.factory(makeStrictRequire().require);
const dispose = plugin.apply(makeCtx({ slots }));
const entry = calls.register.find(call => call.options.id === 'dsh-mind-intervention');
assert(entry);
const renderer = createRenderer(entry.Component, { sessionId: owner });
const flush = async () => { await settle(40); renderer.flush(); await settle(40); renderer.flush(); };
renderer.flush();
await flush();
const initial = requests.length;
const frames = [];
for (let index = 0; index < 4; index += 1) {
  for (const timer of loaded.timers.intervals) timer.fn();
  await flush();
  assert(requests[index], 'Each prior request must exist before controlled completion');
  requests[index].resolve(jsonResponse({ 成功: true, 会话: owner, 待决: [{ 请求id: 'visible-request', 原主体: { id: owner }, 状态: '待放行', 可选项: [], 完整请求: { marker: 'SERVER-RETURNED-REQUEST' }, 步骤: [{}] }] }));
  await flush();
  const elements = collect(renderer.tree, { skipStyle: true }).elements;
  frames.push({ completedResponses: index + 1, requestCount: requests.length, dialog: elements.some(el => el.props.role === 'dialog'), text: textOf(renderer.tree) });
}
assert.equal(initial, 1);
assert(frames.every(frame => !frame.dialog && !frame.text.includes('SERVER-RETURNED-REQUEST')),
  'Expected the reported stale-ticket starvation to reproduce on the frozen candidate');
const result = { at: new Date().toISOString(), candidate: '443f42fa661c1dfe79bc569039745137b071f3ee339d2b8fd16741fc255a3549', scope: 'Controlled asynchronous ordering in actual candidate client module, not real browser/network timing', schedule: 'Each response resolves after the next 3-second poll ticket but before its own timeout; equivalent to steady latency between 3 and 6 seconds', frames, reproduced: true };
writeFileSync(new URL('./repro-slow-poll-result.json', import.meta.url), JSON.stringify(result, null, 2));
renderer.unmount();
dispose();
console.log(JSON.stringify({ reproduced: true, completedResponses: frames.length, renderedDialogs: frames.filter(frame => frame.dialog).length }));
