import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectWorkbench } from '../src/workbench.js';

test('终止记录保留原成果线索及前后继关系，不作为待采纳、待决、升级或未结账待办', () => {
  const view = projectWorkbench({ 项目: 'recovery-view', 节点: [
    { id: 'old', 状态: '已终止', 描述: '中断的原工作', 负责人: ['worker'], 判据: ['原判据'], 判据冻结: true,
      终止: { 原状态: '待决', 原因: '停止结果未知，另建后继', 由: 'lead', 于: '2026-10-20T00:00:00Z' }, 后继任务: 'next',
      待决原因: '保留的旧待决原因', 升级: '保留的旧升级', 打回次数: 2, 待采纳: { 票: 'old-review' },
      产出物引用: ['原成果'], 独立答案: [{ 成员: 'worker', 结论: '原署名答案' }] },
    { id: 'next', 状态: '待派发', 描述: '独立后继', 负责人: ['新岗位'], 判据: ['原判据'], 判据冻结: true, 前序任务: 'old' },
  ] });
  assert.equal(view.任务.计数.已终止, 1);
  assert.equal(view.任务.现行未结账数, 1);
  assert.deepEqual(view.待你决定, []);
  const old = view.任务.节点.find(row => row.id === 'old');
  assert.equal(old.已终止, true);
  assert.equal(old.后继任务, 'next');
  assert.equal(old.终止.由, 'lead');
  assert.deepEqual(old.产物, ['原成果']);
  assert.equal(old.待采纳.票, 'old-review', '原票仍为历史线索，不能发出采纳命令');
  assert.ok(!old.采纳命令);
  assert.match(old.写入说明, /宿主停止未确认/);
  assert.equal(view.任务.节点.find(row => row.id === 'next').前序任务, 'old');
});

test('后继累计失败及旧待决处置未知仍可见，提醒不提供伪审批或裁决命令', () => {
  const view = projectWorkbench({ 项目: 'recovery-view', 节点: [{ id: 'next', 状态: '待派发', 描述: '沿原判据接续', 判据: ['原判据'],
    前序任务: 'old', 打回次数: 2, 继承打回次数: 2, 本节点打回次数: 0,
    接续提醒: { 来源任务: 'old', 累计打回次数: 2, 阈值提醒: true, 前序升级: null, 前序待决: { 原因: '缺少原材料', 类型: '待材料' }, 处置状态: '未确认' } }] });
  const row = view.任务.节点[0];
  assert.equal(row.打回次数, 2);
  assert.equal(row.本节点打回次数, 0);
  assert.equal(row.接续提醒.来源任务, 'old');
  assert.equal(view.待你决定.length, 1);
  assert.equal(view.待你决定[0].类型, '接续提醒');
  assert.match(view.待你决定[0].原因, /未确认原升级事件/);
  assert.match(view.待你决定[0].原因, /接续不代表已裁决/);
  assert.ok(!view.待你决定[0].命令);
  assert.deepEqual(view.待你决定[0].可选项, []);
});
