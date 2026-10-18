/**
 * 2026-10-13 第三批 · 记忆账本读缓存 回归：
 *  - 本进程写后立刻可见（写计数让签名失效，不靠 mtime 精度）；
 *  - 外部进程追加一行（改 mtime/size）后本进程读得到；
 *  - 缓存不改变语义：删改不存在的条目行为一致、stats/query 与盘上事实对齐。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { makeFixture, LEAD } from './helpers.mjs';
import { MemoryService } from '../src/memory.js';

describe('第三批 · 记忆账本读缓存', () => {
  it('本进程写后立刻读得到（写计数让签名失效）', async () => {
    const f = await makeFixture();
    const memory = new MemoryService({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
    await memory.query({ subject: LEAD, 类: ['偏好'] }); // 先填缓存
    const a = await memory.remember({ subject: LEAD, 类: '偏好', 内容: '写后可见', 来源: '测试' });
    const q = await memory.query({ subject: LEAD, 类: ['偏好'] });
    assert.ok(q.条目.some((e) => e.id === a.id), '同一毫秒内的写入也必须立刻可见');
    await f.cleanup();
  });

  it('外部进程追加 ⇒ 签名变化让缓存失效（本进程读得到别人写的）', async () => {
    const f = await makeFixture();
    const memory = new MemoryService({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
    const a = await memory.remember({ subject: LEAD, 类: '偏好', 内容: '外部写前', 来源: '测试' });
    await memory.query({ subject: LEAD, 类: ['偏好'] }); // 填缓存
    const file = f.layout.memoryLog('跨项目', '偏好');
    const before = await stat(file);
    const 外行 = JSON.stringify({ id: 'pref-外部-1', 类: '偏好', 标题: '外部', 内容: '外部进程写的', 来源: { 谁: 'someone', 怎么知道: '外部' }, 来源引用: [], 派生自: null, 归属: '跨项目', 项目: null, 岗位: null, 标签: [], 状态: '有效', 记于: new Date(Date.now() + 2000).toISOString(), 轮: null });
    await writeFile(file, `${await readFile(file, 'utf8')}${外行}\n`);
    const after = await stat(file);
    assert.notEqual(`${before.mtimeMs}:${before.size}`, `${after.mtimeMs}:${after.size}`, '前提：外部写改变了签名');
    const q = await memory.query({ subject: LEAD, 类: ['偏好'] });
    assert.ok(q.条目.some((e) => e.id === 'pref-外部-1'), '外部写入必须被本进程看见');
    assert.ok(q.条目.some((e) => e.id === a.id), '原有条目照常可见');
    await f.cleanup();
  });

  it('缓存不改变语义：血缘/处置读面与盘上事实一致', async () => {
    const f = await makeFixture();
    const memory = new MemoryService({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
    const a = await memory.remember({ subject: LEAD, 类: '偏好', 内容: '被引用', 来源: '测试' });
    await memory.remember({ subject: LEAD, 类: '知识', 内容: '引用它', 来源: '测试', 项目: 'p-cache', 来源引用: [a.id] });
    await memory.query({ subject: LEAD, 类: ['知识'], 项目: 'p-cache' }); // 填缓存
    await memory.invalidate(a.id, { subject: LEAD, 原因: '缓存后处置' });
    const 读回 = await memory.query({ subject: LEAD, 类: ['偏好'], 含失效: true });
    const entry = 读回.条目.find((e) => e.id === a.id);
    assert.equal(entry.状态, '已失效', '处置后的状态必须读得到（缓存不许把状态读旧）');
    await f.cleanup();
  });
});
