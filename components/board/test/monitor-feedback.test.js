import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadClient, makeSlots, makeCtx, makeSessions, makeStrictRequire, collect, textOf, jsonResponse, settle, sampleView } from './client-harness.mjs';
import { createApprovalRenderer } from './approval-renderer.mjs';

async function env({ confirm = true, postFails = false } = {}) {
  const row = { id: 'at-real-attempt', subject: 'owner-exact', project: 'plugins', tool: 'write', state: 'unresolved',
    block: { ruleId: 'kernel.member-files', ruleVersion: 'version' }, feedback: [], feedbackTotal: 0, followupsTotal: 0 };
  const monitor = { 范围: '当前项目全部已落账观测', 健康: { 状态: 'observed', 覆盖: { nativeTools: 'enabled' }, 分母: '仅已落账执行', 崩溃窗口: '漏记数量未知' },
    尝试总数: 3, 阻塞总数: 1, 规则总数: 0, 规则汇总: [], 阻塞: [row] };
  const view = sampleView(); view.监控 = monitor; const requests = [];
  const loaded = loadClient({ fetch: async (url, init) => {
    if (url.startsWith('/plugins/dsh-mind/workbench')) return jsonResponse({ 成功: true, 数据: view });
    if (url.startsWith('/plugins/dsh-mind/monitor')) {
      requests.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
      if (init.method === 'POST') {
        if (postFails) return jsonResponse({ 成功: false, 理由: '认证被拒绝' }, 403);
        if (confirm) { row.feedback = [{ eventId: 'feedback-real', source: 'human_confirmation', category: '规则缺陷疑似', verdict: 'false_positive', reason: '人工核验', reference: 'review-1' }]; row.feedbackTotal = 1; }
        return jsonResponse({ 成功: true, blockId: row.id, feedbackId: 'feedback-real', source: 'human_confirmation' });
      }
      return jsonResponse({ 成功: true, 数据: monitor });
    }
    return jsonResponse({ 成功: true });
  } });
  const strict = makeStrictRequire(); const plugin = loaded.definition.factory(strict.require); const slots = makeSlots();
  const dispose = plugin.apply(makeCtx({ slots: slots.slots, sessions: makeSessions([{ id: row.subject, main: true }]) }));
  const entry = slots.calls.register.find(x => x.options.name === 'main'); assert.ok(entry);
  const renderer = createApprovalRenderer(entry.Component, {});
  const flush = async () => { renderer.flush(); await settle(35); renderer.flush(); await settle(20); renderer.flush(); };
  await flush();
  const elements = () => collect(renderer.tree, { skipStyle: true }).elements;
  const button = text => elements().find(e => e.type === 'button' && textOf(e) === text);
  const click = text => { const e = button(text); assert.ok(e, `missing button ${text}`); assert.equal(!!e.props.disabled, false); e.props.onClick(); renderer.flush(); };
  const fill = (type, value, index = 0) => { const field = elements().filter(e => e.type === type)[index]; assert.ok(field, `missing ${type}`); field.props.onChange({ target: { value } }); renderer.flush(); };
  return { renderer, requests, flush, elements, click, fill, button, text: () => textOf(renderer.tree), dispose() { renderer.unmount(); dispose?.(); } };
}

test('看板监控页展示覆盖/真实分母，反馈必须有理由与来源；POST后独立GET确认', async () => {
  const e = await env(); try {
    assert.match(e.text(), /阻塞与原因反馈/); assert.match(e.text(), /漏记数量未知/); assert.match(e.text(), /缺少有效分母/);
    e.click('记录原因反馈'); assert.equal(e.button('提交反馈').props.disabled, true);
    e.fill('textarea', '人工核验'); e.fill('input', 'review-1'); e.fill('select', '规则缺陷疑似', 0); e.fill('select', 'false_positive', 1);
    const form = e.elements().find(x => x.type === 'form'); form.props.onSubmit({ preventDefault() {} }); await e.flush();
    assert.deepEqual(e.requests.map(r => r.method), ['POST', 'GET']);
    assert.equal(e.requests[0].url, '/plugins/dsh-mind/monitor?sessionId=owner-exact');
    assert.deepEqual(e.requests[0].body, { 阻塞引用: 'at-real-attempt', 原因分类: '规则缺陷疑似', 判定: 'false_positive', 原因: '人工核验', 来源引用: 'review-1' });
    assert.match(e.text(), /已回读确认反馈；权限与审批未改变/);
  } finally { e.dispose(); }
});
test('反馈POST成功但回读缺少本条事实，不宣称确认成功', async () => {
  const e = await env({ confirm: false }); try {
    e.click('记录原因反馈'); e.fill('textarea', 'reason'); e.fill('input', 'ref');
    e.elements().find(x => x.type === 'form').props.onSubmit({ preventDefault() {} }); await e.flush();
    assert.match(e.text(), /独立回读未确认/); assert.doesNotMatch(e.text(), /已回读确认反馈/);
  } finally { e.dispose(); }
});
test('认证/写入失败明确显示未确认，不伪造反馈或权限恢复', async () => {
  const e = await env({ postFails: true }); try {
    e.click('记录原因反馈'); e.fill('textarea', 'reason'); e.fill('input', 'ref');
    e.elements().find(x => x.type === 'form').props.onSubmit({ preventDefault() {} }); await e.flush();
    assert.match(e.text(), /反馈未确认/); assert.doesNotMatch(e.text(), /已回读确认反馈/); assert.equal(e.requests.length, 1);
  } finally { e.dispose(); }
});
