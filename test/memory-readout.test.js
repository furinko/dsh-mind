/**
 * 记忆验账读数（MemoryService.activity + 工作台投影 + 看板页脚）。
 *
 * 为什么盯它：人不翻账本，靠「存量 + 近段新增/晋升」确认记账在正常发生。
 * 数字必须真实：同 id 晋升副本不双计、物理删除不计、窗口外的不进「新增」。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, LEAD } from './helpers.mjs';
import { MemoryService } from '../src/memory.js';
import { projectWorkbench } from '../src/workbench.js';
import { appendLines } from '../src/kernel/fsx.js';

/** @type {Awaited<ReturnType<typeof makeFixture>>} */
let f;
/** @type {MemoryService} */ let memory;

describe('记忆验账读数', () => {
  before(async () => {
    f = await makeFixture();
    memory = new MemoryService({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
  });
  after(async () => {
    await f.cleanup();
  });

  it('存量不双计晋升副本；新增与晋升各自如实', async () => {
    await memory.remember({ subject: LEAD, 类: '经历', 内容: '读数验收的经历', 来源: { 谁: 'lead', 怎么知道: '测试' } });
    const k = await memory.remember({ subject: LEAD, 类: '知识', 内容: '读数验收的知识', 来源: { 谁: 'lead', 怎么知道: '测试' }, 项目: 'default' });
    await memory.promoteCrossProject(k.id, { subject: LEAD, 岗位: '插件工程', 理由: '可复用' });

    const 读数 = await memory.activity({ 项目: 'default' });
    assert.equal(读数.存量合计, 2, `经历 1 + 知识 1（晋升副本与原件同 id 折成一条），实际 ${读数.存量合计}`);
    assert.equal(读数.按类.知识, 1, '知识账里两行同 id 只算一条');
    assert.equal(读数.按类.经历, 1);
    assert.equal(读数.新增合计, 2, '两条都落在默认 7 天窗口内');
    assert.equal(读数.晋升, 1, '晋升动作按跨项目判定行数计');
    assert.ok(/T\d{2}:\d{2}:\d{2}/.test(读数.起点), '起点是 ISO 时刻，窗口可复核');
  });

  it('窗口外的旧条目进存量、不进新增；物理删除的不进存量', async () => {
    // 直接往账本里补一行 2020 年的旧条目与一条物理删除状态（append-only 的合法形状）。
    const 旧 = { id: 'exp-old-1', 类: '经历', 标题: '旧条目', 内容: '很久以前的经历', 归属: '跨项目', 岗位: null, 记于: '2020-01-01T00:00:00Z', 来源: { 谁: 'lead', 怎么知道: '测试' } };
    await appendLines(f.layout.memoryLog('跨项目', '经历'), [旧]);
    const 前读数 = await memory.activity({ 项目: 'default' });
    assert.equal(前读数.存量合计, 3, '旧条目计入存量');
    assert.equal(前读数.新增合计, 2, '旧条目不进近段新增');

    await appendLines(f.layout.memoryLog('跨项目', '经历'), [
      { id: objectIdOf('账目', 'exp-old-1:物理删除'), 指向: 'exp-old-1', 追加: '物理删除', 追于: new Date().toISOString(), 依据: '测试', 主体: LEAD },
    ]);
    const 后读数 = await memory.activity({ 项目: 'default' });
    assert.equal(后读数.存量合计, 2, '物理删除的条目退出存量');
    assert.equal(后读数.按类.经历, 1);
  });

  it('工作台投影带记忆读数；宿主没给就是 null，不装懂', async () => {
    const 基础 = { 项目: 'default', 节点: [], 审计尾: [], 探针: { 状态: '正常', 结果: [] }, 策略: { healthy: true, 错误: null }, 生成于: '2026-10-08T00:00:00Z' };
    const 有 = projectWorkbench({ ...基础, 记忆: { 存量合计: 12, 窗口天: 7, 新增合计: 3, 晋升: 1, 起点: 'x', 按类: {} } });
    assert.deepEqual(有.记忆, { 存量: 12, 近段: { 窗口天: 7, 新增: 3, 晋升: 1 } });
    const 无 = projectWorkbench(基础);
    assert.equal(无.记忆, null, '宿主没给记忆读数时不得伪造 0');
  });
});

/** 与 src/kernel/ids.js 的 objectId 同形（测试里只为状态行造个不冲突的 id）。 */
function objectIdOf(kind, seed) {
  return `${kind}-${String(seed).replace(/[^\w\u4e00-\u9fa5-]+/g, '').slice(0, 24)}`;
}
