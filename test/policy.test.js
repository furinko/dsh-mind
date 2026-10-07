/**
 * 策略引擎：三档门槛、三权、失联、旧数据、fail-closed。
 *
 * 这些用例的共同形状是「**拒绝路径**」：设计里每条禁令都必须有对应的失败断言，
 * 否则「不能被绕过」就只是口号。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, SOVEREIGN, LEAD, MEMBER, REVIEWER, writeUnder } from './helpers.mjs';
import { Denied, Fault, NeedsApproval } from '../src/kernel/errors.js';

/** @type {Awaited<ReturnType<typeof makeFixture>>} */
let f;

const 判定 = (subject, action, target, context) => f.policy.decide({ subject, action, target, context });

describe('策略引擎', () => {
  before(async () => {
    f = await makeFixture();
  });
  after(async () => {
    await f.cleanup();
  });

  it('装不齐规则件就是 fail-closed：引擎不健康，写动作抛 Fault', async () => {
    const broken = await makeFixture({ rules: {} });
    // makeFixture 默认齐全；这里直接把宪章删掉再重载，模拟出厂件损坏。
    const { rm } = await import('node:fs/promises');
    await rm(broken.layout.rulePath('宪章', '出厂'), { force: true });
    assert.equal(await broken.policy.reload(), false);
    assert.equal(broken.policy.healthy, false);
    const decision = await broken.policy.decide({ subject: LEAD, action: 'write', target: { id: 'x', kind: '能力', authority: '自治' } });
    assert.equal(decision.verdict, 'deny');
    assert.equal(decision.alarm, true, '故障必须响亮（§3.6 不许静默失败）');
    await assert.rejects(
      () => broken.policy.check({ subject: LEAD, action: 'write', target: { id: 'x', kind: '能力', authority: '自治' } }),
      (error) => error instanceof Fault || error instanceof Denied,
    );
    await broken.cleanup();
  });

  it('宪章档：主权者放行，Lead 只可起草不可发起，其他主体一律拒绝', async () => {
    const target = { id: '宪章', kind: '规则', authority: '宪章' };
    assert.equal((await 判定(SOVEREIGN, 'write', target)).verdict, 'allow');
    assert.equal((await 判定(LEAD, 'write', target)).verdict, 'deny');
    assert.equal((await 判定(LEAD, 'draft', target)).verdict, 'allow');
    assert.equal((await 判定(MEMBER, 'write', target)).verdict, 'deny');
    const 修宪 = await 判定(LEAD, 'propose', target);
    assert.equal(修宪.verdict, 'deny');
    assert.match(修宪.reason, /修宪|不得/);
  });

  it('法律档：主权者确定，Lead 只可提议', async () => {
    const target = { id: '权限矩阵', kind: '规则', authority: '法律' };
    assert.equal((await 判定(SOVEREIGN, 'write', target)).verdict, 'allow');
    assert.equal((await 判定(LEAD, 'propose', target)).verdict, 'allow');
    assert.equal((await 判定(LEAD, 'publish', target)).verdict, 'deny');
  });

  it('自治档：组织自决；成员任务内全权、任务外无', async () => {
    const target = { id: 'cap-x', kind: '能力', authority: '自治' };
    assert.equal((await 判定(LEAD, 'write', target)).verdict, 'allow');
    assert.equal((await 判定(MEMBER, 'write', target, { task: { 负责人: 'member-a' } })).verdict, 'allow');
    const 任务外 = await 判定(MEMBER, 'write', target);
    assert.equal(任务外.verdict, 'deny');
    assert.match(任务外.reason, /任务外无/);
    const 他人任务 = await 判定(MEMBER, 'write', target, { task: { 负责人: 'member-b' } });
    assert.equal(他人任务.verdict, 'deny');
  });

  it('介入度只影响自治档：变更预审要主权者点头，立宪立法不受影响', async () => {
    const gated = await makeFixture({ defaults: { 介入度: '变更预审', 响应期限小时: 72 } });
    const 自治 = await gated.policy.decide({ subject: LEAD, action: 'write', target: { id: 'c', kind: '能力', authority: '自治' } });
    assert.equal(自治.verdict, 'confirm');
    assert.equal(自治.requireAuthority, '主权者');
    const 宪章 = await gated.policy.decide({ subject: SOVEREIGN, action: 'write', target: { id: '宪章', kind: '规则', authority: '宪章' } });
    assert.equal(宪章.verdict, 'allow', '介入度不影响立宪');
    await gated.cleanup();
  });

  it('复核者只读数、不改被验对象，但可以落复核结论', async () => {
    const target = { id: 't1', kind: '任务', authority: '自治' };
    assert.equal((await 判定(REVIEWER, 'read', target)).verdict, 'allow');
    assert.equal((await 判定(REVIEWER, 'review', target)).verdict, 'allow');
    assert.equal((await 判定(REVIEWER, 'write', target)).verdict, 'deny');
    assert.equal((await 判定(REVIEWER, 'dispatch', target)).verdict, 'deny');
    assert.equal((await 判定(REVIEWER, 'propose', target)).verdict, 'deny');
    // 落盘实验只有进沙箱区才放行。
    assert.equal((await 判定(REVIEWER, 'experiment', { ...target, sandbox: true })).verdict, 'allow');
    assert.equal((await 判定(REVIEWER, 'experiment', target)).verdict, 'deny');
  });

  it('组织不给自己发合格证：提案者不得自批', async () => {
    const 自批 = await 判定(LEAD, 'approve', { id: 't1', kind: '任务', authority: '自治' }, { proposerId: 'lead' });
    assert.equal(自批.verdict, 'deny');
    assert.match(自批.reason, /自批/);
    assert.equal((await 判定(LEAD, 'approve', { id: 't1', kind: '任务', authority: '自治' }, { proposerId: 'member-a' })).verdict, 'allow');
  });

  it('成员不得自扩权、不得再起成员', async () => {
    for (const action of ['create', 'dispatch', 'propose', 'approve']) {
      const d = await 判定(MEMBER, action, { id: 'x', kind: '身份', authority: '自治' }, { task: { 负责人: 'member-a' } });
      assert.equal(d.verdict, 'deny', `${action} 应被拒绝`);
    }
  });

  it('只增档：主权者也不能改写，只能追加', async () => {
    const target = { id: 'audit-2026-10', kind: '账目', authority: '只增' };
    assert.equal((await 判定(SOVEREIGN, 'write', target)).verdict, 'deny');
    assert.equal((await 判定(SOVEREIGN, 'delete', target)).verdict, 'deny');
    assert.equal((await 判定(SOVEREIGN, 'create', target)).verdict, 'allow');
    assert.equal((await 判定(SOVEREIGN, 'read', target)).verdict, 'allow');
  });

  it('身份核心锁定：本部署任何角色都改不动', async () => {
    const d = await 判定(SOVEREIGN, 'write', { id: '复核员', kind: '身份', authority: '法律', segment: '身份核心' });
    assert.equal(d.verdict, 'deny');
    assert.match(d.reason, /身份核心|连续性/);
    assert.equal((await 判定({ id: 'fa', kind: '出厂作者' }, 'write', { id: 'x', kind: '身份', authority: '自治', segment: '身份核心' })).verdict, 'allow');
  });

  it('未经主权者的删除 / 发布一律拒绝', async () => {
    for (const action of ['delete', 'publish']) {
      const d = await 判定(LEAD, action, { id: 'x', kind: '能力', authority: '自治' });
      assert.equal(d.verdict, 'deny');
    }
  });

  it('旧数据读权限：主权者可以、Lead 需单次授权、成员不可、自动检索不可', async () => {
    const target = { id: 'old', kind: '知识', authority: '自治', zone: '旧数据' };
    assert.equal((await 判定(SOVEREIGN, 'read', target)).verdict, 'allow');
    const lead = await 判定(LEAD, 'read', target);
    assert.equal(lead.verdict, 'confirm');
    assert.match(lead.reason, /单次授权/);
    assert.equal((await 判定(MEMBER, 'read', target)).verdict, 'deny');
    assert.equal((await 判定({ id: 'search', kind: '系统' }, 'read', target)).verdict, 'deny');
  });

  it('失联冻结自治变更，但服务、记忆与安全类强更照常', async () => {
    const offline = await makeFixture({ offline: true });
    assert.equal(offline.policy.presence().lost, true);
    assert.equal((await offline.policy.decide({ subject: LEAD, action: 'write', target: { id: 'c', kind: '能力', authority: '自治' } })).verdict, 'deny');
    assert.equal((await offline.policy.decide({ subject: LEAD, action: 'read', target: { id: 'c', kind: '能力', authority: '自治' } })).verdict, 'allow');
    // 一次交互即解除。
    await writeUnder(offline.privateRoot, '身份档案/identity.json', JSON.stringify({
      members: { lead: { id: 'lead', 岗位: 'Lead', status: '在岗' } },
      sovereign: { lastInteraction: new Date().toISOString() },
      denylist: [],
    }, null, 2));
    await offline.policy.reload();
    assert.equal(offline.policy.presence().lost, false);
    assert.equal((await offline.policy.decide({ subject: LEAD, action: 'write', target: { id: 'c', kind: '能力', authority: '自治' } })).verdict, 'allow');
    await offline.cleanup();
  });

  it('撤回 = 写拒绝名单：挡住新写入，但对象没有被删除', async () => {
    const w = await makeFixture();
    const { writeUnder: wu } = { writeUnder };
    void wu;
    await writeUnder(w.privateRoot, '身份档案/identity.json', JSON.stringify({
      members: { lead: { id: 'lead', 岗位: 'Lead', status: '在岗' } },
      sovereign: { lastInteraction: new Date().toISOString() },
      denylist: [{ id: '被撤回的对象', 理由: '主权者撤回', 撤于: new Date().toISOString() }],
    }, null, 2));
    await w.policy.reload();
    const d = await w.policy.decide({ subject: LEAD, action: 'write', target: { id: '被撤回的对象', kind: '能力', authority: '自治' } });
    assert.equal(d.verdict, 'deny');
    assert.match(d.reason, /拒绝名单/);
    assert.equal((await w.policy.decide({ subject: LEAD, action: 'read', target: { id: '被撤回的对象', kind: '能力', authority: '自治' } })).verdict, 'allow', '撤回不删卡，读仍然可以');
    assert.equal((await w.policy.decide({ subject: SOVEREIGN, action: 'write', target: { id: '被撤回的对象', kind: '能力', authority: '自治' } })).verdict, 'allow', '主权者自己可以解绑');
    await w.cleanup();
  });

  it('未知主体与未知动作都拒绝，且理由可执行', async () => {
    const 未知主体 = await 判定({ id: 'x', kind: '路人' }, 'read', { id: 'k', kind: '知识', authority: '自治' });
    assert.equal(未知主体.verdict, 'deny');
    assert.match(未知主体.reason, /查不到身份不等于放行|未知主体/);
    assert.ok(未知主体.howToChange.length > 0);

    const 未知动作 = await 判定(LEAD, '飞升', { id: 'k', kind: '知识', authority: '自治' });
    assert.equal(未知动作.verdict, 'deny');
    assert.match(未知动作.reason, /未知动作/);
  });

  it('法律件里的 policy 授权块真的驱动判定，且能覆盖内置默认', async () => {
    const g = await makeFixture();
    // 内置默认禁止复核者写（§2）。主权者通过改 权限矩阵.md 给复核者开一个口子：
    // 这正是「法律件是现行版本、内置表是出厂默认」的可执行证明。
    await g.writePrivate('集体L1-法律/权限矩阵.md', [
      '---',
      'id: 权限矩阵',
      'kind: 规则',
      'authority: 法律',
      'zone: 私有',
      'version: 1',
      '---',
      '# 权限矩阵',
      '',
      '## 三档门槛',
      '本部署允许复核者在会审中直接落一条结论草稿。',
      '',
      '```policy',
      JSON.stringify({ grants: [{ subject: '复核者', action: 'write', authority: '自治', verdict: 'allow', reason: '本部署允许复核者落结论草稿' }] }),
      '```',
    ].join('\n'));
    assert.equal(await g.policy.reload(), true);
    const d = await g.policy.decide({ subject: REVIEWER, action: 'write', target: { id: 't1', kind: '任务', authority: '自治' } });
    assert.equal(d.verdict, 'allow');
    assert.match(d.rule, /权限矩阵/);
    assert.match(d.reason, /落结论草稿/);

    // 但宪章不变式仍然翻不动：同一条法律块不能给复核者开「删除」。
    const 删除 = await g.policy.decide({ subject: REVIEWER, action: 'delete', target: { id: 't1', kind: '任务', authority: '自治' } });
    assert.equal(删除.verdict, 'deny', '宪章不变式优先于任何法律件');
    await g.cleanup();
  });

  it('check() 把三种结论分别映射成 allow / NeedsApproval / Denied', async () => {
    assert.equal((await f.policy.check({ subject: LEAD, action: 'read', target: { id: 'k', kind: '知识', authority: '自治' } })).verdict, 'allow');
    const g = await makeFixture({ defaults: { 介入度: '逐条审批', 响应期限小时: 72 } });
    await assert.rejects(
      () => g.policy.check({ subject: LEAD, action: 'write', target: { id: 'c', kind: '能力', authority: '自治' } }),
      (error) => error instanceof NeedsApproval && error.requireAuthority === '主权者',
    );
    await assert.rejects(
      () => f.policy.check({ subject: MEMBER, action: 'delete', target: { id: 'c', kind: '能力', authority: '自治' } }),
      (error) => error instanceof Denied && error.rule.length > 0 && error.howToChange.length > 0,
    );
    await g.cleanup();
  });
});
