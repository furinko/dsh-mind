/** 长查询收尾仍核真实任务与治理读资格，不凭开头的许可回传旧声明。 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Org } from '../src/org.js';
import { makeFixture, LEAD, MEMBER, SOVEREIGN } from './helpers.mjs';

const P = 'knowledge-observation-integration';
async function scene(run) {
  const f = await makeFixture();
  try {
    const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
    const knowledge = await org.memory.remember({ subject: LEAD, 类: '知识', 项目: P, 内容: 'private-observation-source', 来源: '实际隔离观察' });
    const task = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '核对查询收尾', 负责人: MEMBER.roleId, 判据: ['当前读域仍有效'] });
    await org.tasks.bind(task.id, { subject: LEAD, 项目: P, 实例: MEMBER.id, 岗位: MEMBER.roleId });
    await org.tasks.dispatch(task.id, { subject: LEAD, 项目: P });
    await org.tasks.start(task.id, { subject: MEMBER, 项目: P });
    const submit = () => org.tasks.submit(task.id, { subject: MEMBER, 项目: P, 结论: '独立交卷', 采用知识: [{ id: knowledge.id, 用途: 'private-task-declaration', 适用判断: '本次需核对', 使用结果: '发现问题' }] });
    await submit();
    const query = (options = {}) => org.knowledgeReuse.query({ subject: LEAD, 项目: P, ...options });
    await run({ f, org, task, knowledge, submit, query });
  } finally { await f.cleanup(); }
}

describe('知识查询收尾的真实读域与任务版本', () => {
  it('其他任务读权收紧不阻断已授权知识过滤结果，明确任务过滤仍复核', async () => scene(async ({ org, knowledge, query }) => {
    const other = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '不在过滤结果中的任务', 负责人: MEMBER.roleId, 判据: ['单独核验'] });
    await org.tasks.bind(other.id, { subject: LEAD, 项目: P, 实例: MEMBER.id, 岗位: MEMBER.roleId });
    await org.tasks.dispatch(other.id, { subject: LEAD, 项目: P });
    await org.tasks.start(other.id, { subject: MEMBER, 项目: P });
    await org.tasks.submit(other.id, { subject: MEMBER, 项目: P, 采用知识: [] });
    const observer = org.memory.readFeedbackDispositions.bind(org.memory);
    const decide = org.policy.decideCurrentSync.bind(org.policy); let entered = false;
    org.memory.readFeedbackDispositions = async spec => {
      const result = await observer(spec); entered = true;
      org.policy.decideCurrentSync = input => input.action === 'read' && input.target?.kind === '任务' && input.target.id === other.id ? { verdict: 'deny', reason: 'unrelated-task-read-revoked' } : decide(input);
      return result;
    };
    const result = await query({ 知识id: knowledge.id });
    assert.equal(entered, true); assert.equal(result.采用页.总数, 1); assert.equal(result.汇总.声明条目, 1);
    await assert.rejects(() => query({ 任务: other.id }), /读域|权限/);
  }));

  it('记忆观察后任务read收紧，不能继续回传开头已读的声明', async () => scene(async ({ org, task, query }) => {
    const observer = org.memory.readFeedbackDispositions.bind(org.memory);
    const decide = org.policy.decideCurrentSync.bind(org.policy);
    let entered = false;
    org.memory.readFeedbackDispositions = async spec => {
      const result = await observer(spec); entered = true;
      org.policy.decideCurrentSync = input => input.action === 'read' && input.target?.kind === '任务' && input.target.id === task.id ? { verdict: 'deny', reason: 'private-task-read-revoked' } : decide(input);
      return result;
    };
    await assert.rejects(query, /读域|权限|核对|变化/);
    assert.equal(entered, true, '必须确实发生在来源观察之后');
  }));

  it('记忆观察后真实Lead封存，查询不能凭开头的卡返回历史声明', async () => scene(async ({ org, query }) => {
    const observer = org.memory.readFeedbackDispositions.bind(org.memory); let entered = false;
    org.memory.readFeedbackDispositions = async spec => {
      const result = await observer(spec);
      await org.registry.seal({ subject: SOVEREIGN, 实例: LEAD.id, 理由: '查询期间撤回当前治理身份' });
      entered = true; return result;
    };
    await assert.rejects(query, /Lead|资格|凭证|读域/);
    assert.equal(entered, true);
  }));

  it('记忆观察期间真实交卷追加，不混原任务快照和新观察返回旧分母', async () => scene(async ({ org, submit, query }) => {
    const file = org.layout.taskLog(P); const before = await readFile(file, 'utf8');
    const observer = org.memory.readFeedbackDispositions.bind(org.memory); let entered = false;
    org.memory.readFeedbackDispositions = async spec => {
      const result = await observer(spec); await submit(); entered = true; return result;
    };
    await assert.rejects(query, /任务|版本|变化|重新/);
    assert.equal(entered, true); assert.notEqual(await readFile(file, 'utf8'), before);
  }));
});
