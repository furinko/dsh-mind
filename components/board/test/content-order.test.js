import { it } from 'node:test';
import assert from 'node:assert/strict';
import { loadClient, makeSlots, makeCtx, makeSessions, makeStrictRequire, createRenderer,
  collect, textOf, jsonResponse, settle, sampleView, renderView, findAllByClass } from './client-harness.mjs';

async function scene(view, run) {
  const calls = [];
  const loaded = loadClient({ fetch: async (url, init) => {
    calls.push({ url, method: init.method });
    return jsonResponse(url.includes('/workbench') ? { 成功: true, 数据: view } : { 成功: true });
  } });
  const slots = makeSlots();
  const dispose = loaded.definition.factory(makeStrictRequire().require).apply(makeCtx({
    slots: slots.slots, sessions: makeSessions([{ id: 'content-order', main: true }]),
  }));
  const renderer = createRenderer(slots.calls.register.find(r => r.options.name === 'main').Component, {});
  const elements = () => collect(renderer.tree).elements;
  const flush = async () => { await settle(8); renderer.flush(); };
  const click = async label => {
    const button = elements().find(el => el.type === 'button' && textOf(el) === label);
    assert.ok(button, label); button.props.onClick(); await flush();
  };
  try { await flush(); await run({ elements, flush, click, calls, renderer, loaded }); }
  finally { renderer.unmount(); dispose?.(); }
}
const ids = (elements, attr) => elements.filter(el => el.props?.[attr]).map(el => el.props[attr]);

it('栏目按工作与记忆优先排列；任务按最近事件排序，展开全部不另发请求', async () => {
  const view = sampleView(); view.项目清单 = null;
  view.任务.节点 = Array.from({ length: 10 }, (_, i) => ({ id: 'task-' + i, 描述: '任务 ' + i,
    状态: '待派发', 负责人: [], 创建于: `2026-10-${String(10 + i).padStart(2, '0')}T00:00:00Z` }));
  view.任务.节点[0].最近事件于 = '2026-10-30T00:00:00Z';
  const before = JSON.stringify(view);
  await scene(view, async e => {
    assert.deepEqual(e.elements().filter(el => el.props?.['data-page']).map(el => el.props['data-page']),
      ['overview', 'tasks', 'memory', 'graph', 'reviews', 'bus', 'audit']);
    assert.deepEqual(ids(e.elements(), 'data-task-id'), ['task-0', 'task-9', 'task-8', 'task-7', 'task-6', 'task-5', 'task-4', 'task-3']);
    const requests = e.calls.length;
    await e.click('展开全部任务（共 10 个）');
    assert.equal(ids(e.elements(), 'data-task-id').length, 10);
    assert.equal(e.calls.length, requests);
    await e.click('收起任务'); assert.equal(ids(e.elements(), 'data-task-id').length, 8);
    assert.equal(JSON.stringify(view), before);
  });
});

it('会审按真实活动时间排序，较早记录可展开，缺少分歧判定保持未知', async () => {
  const view = sampleView(); view.项目清单 = null;
  view.会审 = Array.from({ length: 6 }, (_, i) => ({ id: 'review-' + i, 问题: '问题 ' + i,
    状态: '已收敛', 创建于: `2026-10-${10 + i}T00:00:00Z`, 零分歧: false }));
  view.会审[0].收敛于 = '2026-10-30T00:00:00Z'; delete view.会审[0].零分歧;
  await scene(view, async e => {
    assert.deepEqual(ids(e.elements(), 'data-review-id'), ['review-0', 'review-5', 'review-4', 'review-3']);
    const unknown = e.elements().find(el => el.props?.['data-review-id'] === 'review-0');
    assert.match(textOf(unknown), /零分歧：未提供判定/); assert.doesNotMatch(textOf(unknown), /存在分歧（正常）/);
    await e.click('展开全部会审（共 6 场）'); assert.equal(ids(e.elements(), 'data-review-id').length, 6);
    await e.click('收起会审'); assert.equal(ids(e.elements(), 'data-review-id').length, 4);
  });
});

it('总线按最新消息排线程和消息；跨时区比较真实时刻，未知日期不冒充最新', async () => {
  const view = sampleView(); view.项目清单 = null;
  const msg = (id, 追加于) => ({ id, 追加于, 内容: id });
  view.消息总线 = [
    { 线程: 'earlier', 最新: [msg('earlier-msg', '2026-10-27T10:00:00+08:00')] },
    { 线程: 'latest', 最新: [msg('m1', '2026-10-27T01:00:00Z'), msg('m3', '2026-10-27T09:00:00Z'),
      msg('m2', '2026-10-27T08:00:00Z'), msg('bad', '2026-02-30T10:00:00Z')] },
    { 线程: 'unknown', 最新: [msg('unknown-msg', '2026-10-30T00:00:00')] },
  ];
  const before = JSON.stringify(view);
  await scene(view, async e => {
    assert.deepEqual(ids(e.elements(), 'data-bus-thread'), ['latest', 'earlier', 'unknown']);
    assert.deepEqual(ids(e.elements(), 'data-message-id').slice(0, 3), ['m3', 'm2', 'm1']);
    await e.click('▸ 另有 1 条（展开全部 4 条）');
    assert.deepEqual(ids(e.elements(), 'data-message-id').slice(0, 4), ['m3', 'm2', 'm1', 'bad']);
    assert.equal(JSON.stringify(view), before);
  });
});

it('相同时刻保持稳定；审计动态不依赖服务返回顺序，自检注明原检查时间', async () => {
  const view = sampleView(); view.项目清单 = null;
  view.任务.节点 = [
    { id: 'one', 描述: 'one', 创建于: '2026-10-27T10:00:00+08:00' },
    { id: 'two', 描述: 'two', 创建于: '2026-10-27T02:00:00Z' },
    { id: 'unknown', 描述: 'unknown', 创建于: 'bad' },
  ];
  view.审计尾 = [{ 时间: '2026-10-27T04:00:00Z', 动作: '新事件' }, { 时间: '2026-10-27T03:00:00Z', 动作: '旧事件' }];
  view.状态条.探针 = { 状态: '正常', 恒绿: true, 于: '2026-10-26T03:00:00Z',
    结果: [{ 探针: '审计链', 状态: '绿', 详情: 'private-marker' }] };
  const page = await renderView(view);
  assert.deepEqual(ids(page.elements, 'data-task-id'), ['one', 'two', 'unknown']);
  assert.match(textOf(findAllByClass(page.tree, 'dshmind-tlRow')[0]), /新事件/);
  assert.match(page.text, /上次检查/); assert.match(page.text, /审计链：绿/); assert.match(page.text, /恒绿警报/);
  assert.doesNotMatch(page.text, /private-marker/);
});
