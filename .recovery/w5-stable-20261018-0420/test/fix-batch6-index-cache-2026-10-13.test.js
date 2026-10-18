/**
 * 2026-10-13 第四批 · 检索索引与血缘索引缓存 回归：
 *  - 缓存不改变检索结果（冷读 = 热读：同一查询词两次命中完全一致）；
 *  - 写后失效：新写入的条目立刻能被检索到；处置（失效/推翻）后立刻反映；
 *  - 物理删除后失效：被抹的条目不再能检索到，且血缘索引不再把它算作上游；
 *  - 血缘读面：缓存命中的读数与冷读一致（含 overturn 后新边）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, LEAD } from './helpers.mjs';
import { MemoryService } from '../src/memory.js';

describe('第四批 · 检索索引缓存', () => {
  it('冷读 = 热读：同一查询词两次命中逐字段一致', async () => {
    const f = await makeFixture();
    const memory = new MemoryService({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
    for (let i = 0; i < 12; i++) {
      await memory.remember({ subject: LEAD, 类: '知识', 内容: `缓存一致性第 ${i} 条：判据冻结与复核三态`, 来源: '测试', 项目: 'p-idx' });
    }
    const 冷 = await memory.query({ subject: LEAD, 类: ['知识'], 项目: 'p-idx', 文本: '判据冻结' });
    const 热 = await memory.query({ subject: LEAD, 类: ['知识'], 项目: 'p-idx', 文本: '判据冻结' });
    assert.deepEqual(热.命中, 冷.命中, '命中列表（含分数与排序）必须一致');
    assert.equal(热.口径.文档数, 冷.口径.文档数, '候选文档数一致');
    assert.ok(冷.命中.length > 0, '前提：这个词确实命中（否则上面是空集对比）');
    await f.cleanup();
  });

  it('写后失效：新条立刻可检索；换查询词仍命中同一索引', async () => {
    const f = await makeFixture();
    const memory = new MemoryService({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
    await memory.remember({ subject: LEAD, 类: '知识', 内容: '第一个词条：独有标记甲', 来源: '测试', 项目: 'p-idx2' });
    await memory.query({ subject: LEAD, 类: ['知识'], 项目: 'p-idx2', 文本: '独有标记甲' }); // 建索引
    const 新 = await memory.remember({ subject: LEAD, 类: '知识', 内容: '第二个词条：独有标记乙', 来源: '测试', 项目: 'p-idx2' });
    const 找新 = await memory.query({ subject: LEAD, 类: ['知识'], 项目: 'p-idx2', 文本: '独有标记乙' });
    assert.ok(找新.命中.some((h) => h.id === 新.id), '写后必须重建索引：新条目要能被检索到');
    // 换查询词（同一口径）⇒ 命中缓存但不该漏掉老条目
    const 找旧 = await memory.query({ subject: LEAD, 类: ['知识'], 项目: 'p-idx2', 文本: '独有标记甲' });
    assert.ok(找旧.命中.length >= 1, '换词查询仍命中原有条目');
    await f.cleanup();
  });

  it('物理删除后失效：被抹条目不再可检索，血缘读面不再把它算作上游', async () => {
    const f = await makeFixture();
    const memory = new MemoryService({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
    const 源 = await memory.remember({ subject: LEAD, 类: '知识', 内容: '将被抹掉的敏感条目：独有标记丙', 来源: '测试', 项目: 'p-idx3' });
    const 下游 = await memory.remember({ subject: LEAD, 类: '知识', 内容: '引用它的下游条目', 来源: '测试', 项目: 'p-idx3', 来源引用: [源.id] });
    await memory.query({ subject: LEAD, 类: ['知识'], 项目: 'p-idx3', 文本: '独有标记丙' }); // 建索引
    const 前 = await memory.lineage({ subject: LEAD, id: 下游.id });
    assert.ok(前.上游.some((u) => u.id === 源.id), '前提：血缘里看得到源');

    await memory.purge(源.id, { subject: LEAD, 理由: '基准：物理删除', 敏感: true });

    const 检索 = await memory.query({ subject: LEAD, 类: ['知识'], 项目: 'p-idx3', 文本: '独有标记丙', 含失效: true });
    assert.ok(!检索.条目.some((e) => e.id === 源.id), '被抹条目不许再出现在检索面（缓存必须失效）');
    const 后 = await memory.lineage({ subject: LEAD, id: 下游.id });
    const 源边 = 后.上游.find((u) => u.id === 源.id);
    assert.ok(源边, '历史事实照旧列出：下游那行记着「我引用过它」，抹不掉也不该抹');
    assert.equal(源边.已不存在, true, '已在盘上消失的一头必须如实标注（否则血缘读数是假读数）');
    const 下游读 = await memory.query({ subject: LEAD, 类: ['知识'], 项目: 'p-idx3', 含失效: true });
    assert.equal(下游读.条目.find((e) => e.id === 下游.id)?.状态, '已隔离', '下游要落在隔离态（阻断承诺不受缓存影响）');
    await f.cleanup();
  });

  it('血缘读面缓存：冷热读数一致，overturn 后立刻出现新边', async () => {
    const f = await makeFixture();
    const memory = new MemoryService({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
    const 基 = await memory.remember({ subject: LEAD, 类: '偏好', 内容: '旧偏好', 来源: '测试' });
    const 冷 = await memory.lineage({ subject: LEAD, id: 基.id });
    const 热 = await memory.lineage({ subject: LEAD, id: 基.id });
    assert.deepEqual(热.上游, 冷.上游, '血缘冷热读数一致');
    assert.deepEqual(热.下游, 冷.下游, '血缘冷热读数一致（下游）');

    const 翻 = await memory.overturn(基.id, { subject: LEAD, 新条目: '新偏好', 理由: '基准' });
    const 后 = await memory.lineage({ subject: LEAD, id: 翻.新条目 });
    assert.ok(后.上游.some((u) => u.id === 基.id && u.关系 === '派生'), '推翻后新边（派生）必须立刻出现在血缘里');
    await f.cleanup();
  });
});
