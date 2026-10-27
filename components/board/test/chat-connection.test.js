import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadClient, makeSlots, makeCtx, makeStrictRequire, createRenderer, collect, textOf, jsonResponse, settle } from './client-harness.mjs';

function env(handler, id = 'a') {
  const calls = [];
  const loaded = loadClient({ fetch: async (url, init) => {
    if (!url.startsWith('/plugins/dsh-mind/chat-connection')) return jsonResponse({ 成功: true });
    const req = { sessionId: new URL(url, 'http://local').searchParams.get('sessionId'), method: init.method, body: init.body ? JSON.parse(init.body) : null }; calls.push(req);
    return handler(req);
  } });
  const plugin = loaded.definition.factory(makeStrictRequire().require); const { slots, calls: registrations } = makeSlots();
  const dispose = plugin.apply(makeCtx({ slots })); const component = registrations.register.find(r => r.options.name === 'conversation.input.left');
  assert.equal(component.options.id, 'dsh-mind-connect');
  const props = { sessionId: id }; const r = createRenderer(component.Component, props);
  return { r, props, calls, loaded, dispose() { r.unmount(); dispose(); } };
}
const reply = (id, enabled, revision = 0) => jsonResponse({ 成功: true, sessionId: id, enabled, revision });
const button = e => collect(e.r.tree).elements.find(n => n.type === 'button');
async function flush(e) { e.r.flush(); await settle(15); e.r.flush(); }

test('聊天开关先读真实状态，单次写入后回读确认，双击不会重复发送', async () => {
  let enabled = true; let revision = 0;
  const e = env(req => {
    if (req.method === 'POST') { assert.deepEqual(req.body, { sessionId: 'a', enabled: false, expectedRevision: 0 }); enabled = false; revision++; }
    return reply('a', enabled, revision);
  });
  try {
    assert.equal(button(e).props.role, undefined, '读取前不假称已接入');
    await flush(e); assert.equal(button(e).props['aria-checked'], true);
    const old = button(e); old.props.onClick(); old.props.onClick(); await flush(e);
    assert.equal(button(e).props['aria-checked'], false);
    assert.deepEqual(e.calls.map(r => r.method), ['GET', 'POST', 'GET']);
    assert.match(button(e).props.title, /不补记关闭期间/);
  } finally { e.dispose(); }
});

test('切换聊天及卸载时忽略旧响应，状态和POST永远绑定当前标准props', async () => {
  let release; const e = env(req => req.sessionId === 'a' ? new Promise(resolve => { release = resolve; }) : reply('b', false, 2));
  try {
    await flush(e); e.props.sessionId = 'b'; e.r.render(); assert.equal(button(e).props['aria-checked'], undefined);
    await flush(e); assert.equal(button(e).props['aria-checked'], false);
    release(reply('a', true)); await flush(e); assert.equal(button(e).props['aria-checked'], false);
    assert.deepEqual(e.calls.map(r => r.sessionId), ['a', 'b']);
  } finally { e.dispose(); }
});

test('保存失败、409冲突、错会话和坏JSON均明确显示，先重读才能再次写入', async () => {
  for (const failure of [jsonResponse({ 成功: false, 理由: '保存失败' }, 503), jsonResponse({ 成功: false, 理由: '修订冲突' }, 409), reply('foreign', false, 1), jsonResponse({ 成功: true })]) {
    const e = env(req => req.method === 'GET' ? reply('a', true) : failure);
    try {
      await flush(e); button(e).props.onClick(); await flush(e);
      assert.equal(button(e).props.role, undefined); assert.match(textOf(e.r.tree), /保存未确认/);
      button(e).props.onClick(); await flush(e); assert.equal(button(e).props['aria-checked'], true);
      assert.equal(e.calls.filter(r => r.method === 'POST').length, 1);
    } finally { e.dispose(); }
  }
});

test('会话缺失不取数，读取超时有重试入口，服务重新可用后恢复', async () => {
  const missing = env(() => { throw Error('无会话不应调用'); }, '');
  await flush(missing); assert.equal(button(missing).props.disabled, true); assert.equal(missing.calls.length, 0); missing.dispose();
  let blocked = true; const e = env(() => blocked ? new Promise(() => {}) : reply('a', false, 1));
  try {
    await flush(e); e.loaded.timers.fireTimeouts(); await flush(e); assert.match(textOf(e.r.tree), /读取失败/);
    blocked = false; button(e).props.onClick(); await flush(e); assert.equal(button(e).props['aria-checked'], false);
  } finally { e.dispose(); }
});
