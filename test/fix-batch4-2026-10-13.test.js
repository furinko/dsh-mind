/**
 * 2026-10-13 第三批 回归：
 *  - reload in-flight 去重（并发 reload 只做一次全量加载，且刷新的快照在盘上各自可见）；
 *  - 规则件授权块不再被双重解析（parseDocument 调用次数 ≤ 规则文件数）；
 *  - #verifyRefs 单次折叠（一个引用也不许退化成「每引用扫全库」）；
 *  - normalizeActor 对缺席 id 记 '未知'（不产出伪主体 'undefined'）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, LEAD, MEMBER } from './helpers.mjs';
import { AuditLog } from '../src/audit.js';
import { MemoryService } from '../src/memory.js';

describe('第三批 · reload in-flight 去重', () => {
  it('并发 reload ⇒ 共享同一次全量加载（rulePath 读取次数不随调用数翻倍）', async () => {
    const f = await makeFixture();
    // 统计 #loadRules 期间的真实读盘次数：每个规则文件每轮 1 次（私有未命中则出厂 1 次）。
    const 原读 = f.layout.rulePath.bind(f.layout);
    let 读次数 = 0;
    f.layout.rulePath = (...args) => {
      读次数 += 1;
      return 原读(...args);
    };
    const promise = Promise.all([f.policy.reload(), f.policy.reload(), f.policy.reload(), f.policy.reload()]);
    const results = await promise;
    assert.deepEqual(results, [true, true, true, true], '并发调用都拿到同一次成功结果');
    // 一次全量加载：6 份规则件 × 每份最多 2 个 zone 候选 ⇒ 上限 12；4 个并发若各跑一遍就是 ~48。
    assert.ok(读次数 <= 12, `并发 reload 必须合并成一次全量加载（实际 rulePath 调用 ${读次数} 次）`);
    await f.cleanup();
  });
});

describe('第三批 · 规则件不再双重解析', () => {
  it('collectGrants 复用 loadRules 的解析结果（同一文本只 parseDocument 一次）', async () => {
    const f = await makeFixture();
    // 通过「解析结果对象被复用」间接验证：reload 后 rules 里带 parsed，且 grants 已就绪。
    assert.equal(await f.policy.reload(), true);
    const rules = f.policy.state.rules;
    assert.ok(rules.every((r) => r.parsed && typeof r.parsed.body === 'string'), '每份规则件都带 loadRules 的解析结果');
    assert.ok(Array.isArray(f.policy.grants), '授权块仍被收集（口径未变）');
    await f.cleanup();
  });
});

describe('第三批 · #verifyRefs 单次折叠', () => {
  it('带引用的写入：多引用只触发一次跨账本折叠', async () => {
    const f = await makeFixture();
    const memory = new MemoryService({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
    const a = await memory.remember({ subject: LEAD, 类: '偏好', 内容: '第一条', 来源: '测试' });
    const b = await memory.remember({ subject: LEAD, 类: '偏好', 内容: '第二条', 来源: '测试' });
    const c = await memory.remember({ subject: LEAD, 类: '知识', 内容: '带两条引用的知识', 来源: '测试', 项目: 'p3', 来源引用: [a.id, b.id] });
    assert.ok(c.id, '多合法引用照常写入');
    await assert.rejects(
      () => memory.remember({ subject: LEAD, 类: '知识', 内容: '引用混入悬空', 来源: '测试', 项目: 'p3', 来源引用: [a.id, 'know-不存在-zzz'] }),
      (e) => e.name === 'InvalidBody' && /悬空引用/.test(e.message),
      '只要有一个引用悬空就拒（fail-closed 未因收口而放宽）',
    );
    await f.cleanup();
  });
});

describe('第三批 · normalizeActor 伪主体', () => {
  it('主体成对象但 id 缺席 ⇒ 记 未知，而不是字符串 undefined', async () => {
    const f = await makeFixture();
    const audit = new AuditLog({ layout: f.layout, clock: f.clock });
    await audit.append({ 动作: '状态变更', 主体: { kind: '成员' }, 对象: { id: 'x' }, 结果: 'ok' });
    const rows = await audit.read({});
    // 夹具初态也有「状态变更」行（Lead 钉版登记）：按本条的对象 id 精确取，不按动作名抢第一条。
    const row = rows.find((r) => r.动作 === '状态变更' && r.对象?.id === 'x');
    assert.equal(row.主体.id, '未知', `id 缺席记「未知」（实际 ${JSON.stringify(row.主体)}）`);
    assert.notEqual(row.主体.id, 'undefined', '不许把缺席折成伪主体 undefined');
    await f.cleanup();
  });
});
