/** 独立攻击夹具：计划分叉、真实创建原文和当前资格，全部使用隔离账本。 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { makeFixture, LEAD, MEMBER, SOVEREIGN } from './helpers.mjs';
import { TaskGraph } from '../src/tasks.js';

const PROJECT = 'task-recovery-independent-adversarial';

async function scene(body) {
  const f = await makeFixture();
  try {
    const tasks = new TaskGraph(f);
    const source = await tasks.create({ subject: LEAD, 项目: PROJECT, 描述: '独立恢复攻击源', 负责人: ['插件工程'], 判据: ['必须保留原标准'] });
    const close = { subject: LEAD, 项目: PROJECT, 原因: '原实例失联；停止状态未知' };
    const next = { subject: LEAD, 项目: PROJECT, 负责人: ['插件工程'], 原因: 'Lead 显式接续原标准' };
    await tasks.close(source.id, close);
    const file = f.layout.taskLog(PROJECT);
    const rewrite = async edit => {
      const rows = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
      const edited = edit(rows) ?? rows;
      await writeFile(file, `${edited.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8');
    };
    const noMutation = async operation => {
      const before = await readFile(file, 'utf8');
      const auditBefore = (await f.audit.read({ project: PROJECT })).filter(row => row.动作 === '状态变更');
      await operation();
      assert.equal(await readFile(file, 'utf8'), before, '拒绝或认回不能补写新的业务事实');
      assert.deepEqual((await f.audit.read({ project: PROJECT })).filter(row => row.动作 === '状态变更'), auditBefore, '不能补造当时未成功落下的业务审计');
    };
    await body({ f, tasks, source, close, next, rewrite, noMutation });
  } finally {
    await f.cleanup();
  }
}

const changedPlan = error => error?.code === 'DENIED' && /准备结果已变化/.test(error.rule);

describe('独立恢复分叉攻击', () => {
  it('close 已签发 read 计划后删除原 closed，不能自动降格为新的 write', async () => scene(async ({ tasks, source, close, rewrite, noMutation }) => {
    const plan = await tasks.closePlan(source.id, close);
    assert.equal(plan.步骤[0].动作, 'read');
    await rewrite(rows => rows.filter(row => !(row.id === source.id && row.kind === 'closed')));
    await noMutation(() => assert.rejects(() => tasks.close(source.id, { ...close, 执行计划: plan }), changedPlan));
    assert.equal((await tasks.get(source.id, { 项目: PROJECT })).状态, '待派发');
  }));

  it('successor 已签发 read 计划后删除原后继，不能自动降格为新的 create', async () => scene(async ({ tasks, source, next, rewrite, noMutation }) => {
    const first = await tasks.createSuccessor(source.id, next);
    const plan = await tasks.successorPlan(source.id, next);
    assert.equal(plan.步骤[0].动作, 'read');
    await rewrite(rows => rows.filter(row => row.id !== first.节点.id));
    await noMutation(() => assert.rejects(() => tasks.createSuccessor(source.id, { ...next, 执行计划: plan }), changedPlan));
    assert.equal(await tasks.get(first.节点.id, { 项目: PROJECT }), null);
  }));

  it('准备新后继之后改源判据，旧准备不能沿新原文写入', async () => scene(async ({ tasks, source, next, rewrite, noMutation }) => {
    const plan = await tasks.successorPlan(source.id, next);
    assert.equal(plan.步骤[0].动作, 'create');
    await rewrite(rows => {
      rows.find(row => row.id === source.id && row.kind === 'created').判据 = ['准备之后被替换的标准'];
    });
    await noMutation(() => assert.rejects(() => tasks.createSuccessor(source.id, { ...next, 执行计划: plan }), error =>
      error?.code === 'TASK_CLOSE_SOURCE_INVALID' || changedPlan(error)));
  }));

  it('read 计划准备后 Lead 被真实封存，不能靠旧计划读取恢复回执', async () => scene(async ({ f, tasks, source, close, noMutation }) => {
    const plan = await tasks.closePlan(source.id, close);
    await f.registry.seal({ subject: SOVEREIGN, 实例: LEAD.id, 理由: '独立反例：排兵资格撤销' });
    await noMutation(() => assert.rejects(() => tasks.close(source.id, { ...close, 执行计划: plan }), error =>
      error?.code === 'DENIED' && /排兵资格/.test(error.rule)));
  }));

  it('合法后继改派、真实绑定和开工后，仍认回当前节点且不重置其进展', async () => scene(async ({ tasks, source, next, noMutation }) => {
    const first = await tasks.createSuccessor(source.id, next);
    await tasks.reassign(first.节点.id, { subject: LEAD, 项目: PROJECT, 负责人: [MEMBER.id] });
    await tasks.bind(first.节点.id, { subject: LEAD, 项目: PROJECT, 实例: MEMBER.id, 岗位: MEMBER.roleId });
    await tasks.dispatch(first.节点.id, { subject: LEAD, 项目: PROJECT });
    await tasks.start(first.节点.id, { subject: MEMBER, 项目: PROJECT });
    const before = await tasks.get(first.节点.id, { 项目: PROJECT });
    await noMutation(async () => {
      const result = await tasks.createSuccessor(source.id, next);
      assert.equal(result.幂等, true);
      assert.equal(result.节点.id, first.节点.id);
      assert.equal(result.节点.状态, '执行中');
      assert.deepEqual(result.节点, before, '核创建原文，不能误把后继当前可变字段当作初始创建字段');
    });
  }));
});

describe('恢复摘要必须验证真实原文', () => {
  for (const [field, value] of [['判据', ['关闭后换掉的标准']], ['依赖', ['task-injected-dependency']], ['复核对象', ['task-injected-review-target']]]) {
    it(`源 close 后首次准备前替换 created.${field}，不能继承为新的冻结事实`, async () => scene(async ({ tasks, source, close, next, rewrite, noMutation }) => {
      await rewrite(rows => { rows.find(row => row.id === source.id && row.kind === 'created')[field] = value; });
      await noMutation(async () => {
        await assert.rejects(() => tasks.createSuccessor(source.id, next), error => error?.code === 'TASK_CLOSE_SOURCE_INVALID');
        await assert.rejects(() => tasks.close(source.id, close), error => error?.code === 'TASK_CLOSE_SOURCE_INVALID');
      });
    }));
  }

  for (const [field, value] of [['判据', ['后继创建后换掉的标准']], ['依赖', ['task-injected-dependency']], ['复核对象', ['task-injected-review-target']], ['工具文件范围', { 版本: 1, 读: ['C:/injected'], 写: ['C:/injected'] }]]) {
    it(`后继 created.${field} 被替换但自报摘要未变，不能冒充原创建回执`, async () => scene(async ({ tasks, source, next, rewrite, noMutation }) => {
      const first = await tasks.createSuccessor(source.id, next);
      let originalHashes;
      await rewrite(rows => {
        const row = rows.find(row => row.id === first.节点.id && row.kind === 'created');
        originalHashes = { 源快照摘要: row.源快照摘要, 后继规范摘要: row.后继规范摘要 };
        assert.ok(originalHashes.源快照摘要 && originalHashes.后继规范摘要);
        row[field] = value;
        assert.equal(row.源快照摘要, originalHashes.源快照摘要);
        assert.equal(row.后继规范摘要, originalHashes.后继规范摘要);
      });
      await noMutation(() => assert.rejects(() => tasks.createSuccessor(source.id, next), error => error?.code === 'TASK_SUCCESSOR_CREATION_INVALID'));
    }));
  }
});
