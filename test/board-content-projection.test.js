import { it } from 'node:test';
import assert from 'node:assert/strict';
import { projectWorkbench } from '../src/workbench.js';
import { projectGoalSnapshot } from '../src/goal-view.js';
import { timestampMillis } from '../src/kernel/time.js';

it('工作台保留真实任务时间和自检时间，只投影探针名称与状态，缺失分歧不补成false', () => {
  const input = { 项目: 'content', 节点: [{ id: 't', 创建于: '2026-10-20T00:00:00Z', 最近事件于: '2026-10-27T00:00:00Z' }],
    会审存档: [{ id: 'c', 状态: '已收敛' }], 探针: { 于: '2026-10-26T00:00:00Z', 结果: [{ 探针: '审计链', 状态: '绿', 详情: 'private-marker' }] } };
  const before = JSON.stringify(input), view = projectWorkbench(input);
  assert.equal(view.任务.节点[0].最近事件于, input.节点[0].最近事件于);
  assert.equal(view.任务.节点[0].创建于, input.节点[0].创建于);
  assert.equal(view.状态条.探针.于, input.探针.于);
  assert.deepEqual(view.状态条.探针.结果, [{ 探针: '审计链', 状态: '绿' }]);
  assert.equal(view.会审[0].零分歧, null);
  assert.equal(JSON.stringify(input), before); assert.doesNotMatch(JSON.stringify(view), /private-marker/);
});

it('目标摘要在截取前按更新时刻排序，旧目标新推进不会被新建目标挤掉', () => {
  const goal = (id, 更新于) => ({ id, 创建于: '2026-10-20T00:00:00Z', 更新于, 禁止工具: [], 约束: [] });
  const snapshot = { 项目: 'content', 目标: [goal('old-but-updated', '2026-10-27T04:00:00Z'),
    goal('middle', '2026-10-27T10:00:00+08:00'), goal('last-created', '2026-10-27T03:00:00Z')] };
  const before = JSON.stringify(snapshot);
  const out = projectGoalSnapshot({ constraintsForTask: () => null }, snapshot, [], 2);
  assert.deepEqual(out.目标.map(g => g.id), ['old-but-updated', 'last-created']);
  assert.equal(out.hasMore, true); assert.equal(out.目标[0].更新于, snapshot.目标[0].更新于);
  assert.equal(JSON.stringify(snapshot), before);
});

it('排序时间不接受无时区、不存在日期或数值时间戳，相同时刻偏移写法等价', () => {
  for (const value of ['2026-02-30T10:00:00Z', '2026-10-27T10:00:00', 'bad', null, 0]) assert.equal(timestampMillis(value), null);
  assert.equal(timestampMillis('2026-10-27T10:00:00+08:00'), timestampMillis('2026-10-27T02:00:00Z'));
});
