/**
 * 2026-10-13 审查批次1 回归：fail-closed 方向修正（P1-2 / P1-3 / P2-1 / P2-9）。
 *
 * 每条对应 docs/design/审查报告-设计与技术缺陷-2026-10-13.md 的一处「默认值倒向宽松侧」：
 *  - approve 缺 proposerId ⇒ 之前静默跳过自批检查，现在必须拒；
 *  - grant verdict 拼错 ⇒ 之前静默当 allow，现在加载期响亮抛错（引擎不健康）；
 *  - 宽 grant 放行成员写 ⇒ 之前绕过任务边界，现在仍要过 scopeOf；
 *  - 介入度坏值 ⇒ 之前静默回退最宽松档「零参与」，现在加载期抛错；
 *  - normalizeArgs ⇒ 布尔归一只作用于布尔型参数，自由文本 'true' 原样透传。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, SOVEREIGN, LEAD, MEMBER, REVIEWER, writeUnder } from './helpers.mjs';

/** @type {Awaited<ReturnType<typeof makeFixture>>} */
let f;

describe('审查批次1（2026-10-13）· fail-closed 方向修正', () => {
  before(async () => {
    f = await makeFixture();
  });
  after(async () => {
    await f.cleanup();
  });

  it('P1-2：approve 缺 proposerId ⇒ 拒（缺席 = 证据不足，不再跳过自批检查）', async () => {
    const target = { id: 't1', kind: '任务', authority: '自治' };
    const 缺席 = await f.policy.decide({ subject: LEAD, action: 'approve', target, context: {} });
    assert.equal(缺席.verdict, 'deny', 'proposerId 缺席必须拒');
    assert.match(缺席.reason, /proposerId|提案人/);
    // 反例面：带 proposerId 且非本人 ⇒ 照常放行（合法路径不受影响）。
    assert.equal((await f.policy.decide({ subject: LEAD, action: 'approve', target, context: { proposerId: 'member-a' } })).verdict, 'allow');
    // 自批照旧拒。
    assert.equal((await f.policy.decide({ subject: LEAD, action: 'approve', target, context: { proposerId: LEAD.id } })).verdict, 'deny');
  });

  it('P1-3a：grant verdict 拼错 ⇒ 加载期响亮抛错（引擎不健康），不静默当 allow', async () => {
    const g = await makeFixture({
      rules: {
        '集体L1-法律/权限矩阵.md': [
          '---', 'id: 权限矩阵', 'kind: 规则', 'authority: 法律', 'zone: 私有', 'domain: 集体', 'version: 1', '---',
          '# 权限矩阵', '', '```policy',
          JSON.stringify({ grants: [{ subject: 'Lead', action: 'create', kind: '能力', verdict: '拒绝', reason: '把 deny 写成了中文' }] }),
          '```',
        ].join('\n'),
      },
    });
    assert.equal(await g.policy.reload(), false, '坏 verdict 必须让 reload 失败');
    assert.equal(g.policy.healthy, false, '引擎不健康 ⇒ 写动作 fail-closed');
    const d = await g.policy.decide({ subject: LEAD, action: 'create', target: { id: 'c', kind: '能力', authority: '自治' } });
    assert.equal(d.verdict, 'deny');
    await g.cleanup();
  });

  it('P1-3b：宽 grant 放行成员写 ⇒ 仍要过任务边界（任务外无不许被授权块掀掉）', async () => {
    const g = await makeFixture({
      rules: {
        '集体L1-法律/权限矩阵.md': [
          '---', 'id: 权限矩阵', 'kind: 规则', 'authority: 法律', 'zone: 私有', 'domain: 集体', 'version: 1', '---',
          '# 权限矩阵', '', '```policy',
          JSON.stringify({ grants: [{ subject: '成员', action: 'create', kind: '记忆', verdict: 'allow', reason: '宽授权：不限 authority' }] }),
          '```',
        ].join('\n'),
      },
    });
    assert.equal(await g.policy.reload(), true);
    const target = { id: 'm-1', kind: '记忆', authority: '自治' };
    // 任务外：grant 放行也拦。
    const 任务外 = await g.policy.decide({ subject: MEMBER, action: 'create', target, context: {} });
    assert.equal(任务外.verdict, 'deny', 'grant allow 不许绕过「任务内全权，任务外无」');
    assert.match(任务外.reason, /任务外无|负责人/);
    // 任务内：grant 照常生效。
    assert.equal((await g.policy.decide({ subject: MEMBER, action: 'create', target, context: { task: { 负责人: 'member-a' } } })).verdict, 'allow');
    // 读动作不受任务边界影响（成员读消息既有语义）。
    assert.equal((await g.policy.decide({ subject: MEMBER, action: 'read', target: { id: 'msg-1', kind: '消息', authority: '只增' }, context: {} })).verdict, 'allow');
    await g.cleanup();
  });

  it('P2-1：介入度坏值 ⇒ 加载期抛错，不静默回退「零参与」', async () => {
    const g = await makeFixture({ defaults: { 介入度: '变更预审 ' } }); // 带空格的坏值
    assert.equal(g.policy.healthy, false, '坏介入度必须让引擎不健康');
    const d = await g.policy.decide({ subject: LEAD, action: 'write', target: { id: 'c', kind: '能力', authority: '自治' } });
    assert.equal(d.verdict, 'deny', '引擎不健康 ⇒ 写全拒（不会静默用最宽松档放行）');
    await g.cleanup();
  });
});
