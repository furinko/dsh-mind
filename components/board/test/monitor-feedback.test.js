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

test('阻塞反馈不再占用导航与页面，不要求用户填写诊断表',async()=>{const e=await env();try{assert.ok(!e.elements().some(x=>x.props['data-page']==='monitor'));assert.ok(!e.button('记录原因反馈'));assert.ok(!e.button('提交反馈'));assert.doesNotMatch(e.text(),/阻塞与原因反馈|原因分类|确认误拦截/);assert.equal(e.requests.length,0);}finally{e.dispose();}});
test('后台有阻塞记录时面板仍不发起反馈写入，也不伪造人侧确认',async()=>{const e=await env({confirm:false});try{await e.flush();assert.equal(e.requests.length,0);assert.doesNotMatch(e.text(),/已回读确认反馈|权限.*恢复/);}finally{e.dispose();}});
