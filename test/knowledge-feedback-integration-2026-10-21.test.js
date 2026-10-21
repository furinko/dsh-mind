/** 从真实负反馈交卷到记忆处置、治理查询与工作台的隔离纵向验证。 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { Org } from '../src/org.js';
import { readTaskLedger } from '../src/task-ledger.js';
import { makeFixture, LEAD, MEMBER, SOVEREIGN } from './helpers.mjs';

const P = 'knowledge-feedback-integration';
async function scene(run) {
  const f = await makeFixture();
  try {
    const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
    const knowledge = await org.memory.remember({ subject: LEAD, 类: '知识', 项目: P, 内容: 'memory-source-private-body', 来源: '隔离测试中的实际来源' });
    const task = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '核对知识适用性', 负责人: MEMBER.roleId, 判据: ['本次结果可复盘'] });
    await org.tasks.bind(task.id, { subject: LEAD, 项目: P, 实例: MEMBER.id, 岗位: MEMBER.roleId });
    await org.tasks.dispatch(task.id, { subject: LEAD, 项目: P });
    await org.tasks.start(task.id, { subject: MEMBER, 项目: P });
    await org.tasks.submit(task.id, { subject: MEMBER, 项目: P, 结论: '交付待复核', 采用知识: [{ id: knowledge.id, 用途: 'private-feedback-purpose', 适用判断: '当前前提不同', 使用结果: '发现问题', 说明: '需要后续核对' }] });
    const event = (await readTaskLedger(org.layout.taskLog(P))).find(row => row.id === task.id && row.kind === 'submitted');
    const ref = { 任务: task.id, 提交序: event.seq };
    const spec = { subject: LEAD, 项目: P, 原因: '依据现有反馈明确处置', 反馈引用: ref };
    const query = options => org.knowledgeReuse.query({ subject: LEAD, 项目: P, ...options });
    await run({ org, knowledge, task, ref, spec, query });
  } finally { await f.cleanup(); }
}

describe('知识负反馈的真实装配', { timeout: 30000 }, () => {
  it('无显式seq旧投影与后来真实seq撞号时，不能把新处置关联给旧声明', async () => scene(async ({ org, knowledge, task, ref, spec, query }) => {
    await org.tasks.submit(task.id, { subject: MEMBER, 项目: P, 采用知识: [{ id: knowledge.id, 用途: '另一次实际提交', 适用判断: '重新核对', 使用结果: '发现问题', 说明: 'new explicit negative' }] });
    const rows = await readTaskLedger(org.layout.taskLog(P));
    const submissions = rows.filter(row => row.id === task.id && row.kind === 'submitted');
    delete submissions[0].seq;
    submissions[1].seq = ref.提交序;
    await writeFile(org.layout.taskLog(P), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    await org.memory.demote(knowledge.id, spec);
    const view = await query();
    const old = view.采用页.条目.find(row => row.采用知识[0].说明 === '需要后续核对');
    const current = view.采用页.条目.find(row => row.采用知识[0].说明 === 'new explicit negative');
    assert.equal(old.采用知识[0].反馈处置.状态, '不可核对');
    assert.equal(current.采用知识[0].反馈处置.状态, '已见关联处置');
    assert.deepEqual(view.处置汇总, { 负反馈条目: 2, 已见关联处置: 1, 未见关联处置: 0, 处置不可核对: 1 });
  }));

  it('普通历史处置不猜关联，显式失效可核对且不泄私有指纹或把任务标完成', async () => scene(async ({ org, knowledge, task, spec, query }) => {
    const originalTask = await readFile(org.layout.taskLog(P), 'utf8');
    await org.memory.demote(knowledge.id, { subject: LEAD, 原因: '普通旧处置，不指定反馈' });
    assert.equal((await query()).采用页.条目[0].采用知识[0].反馈处置.状态, '未见关联处置');
    await org.memory.invalidate(knowledge.id, spec);
    const view = await query(); const adopted = view.采用页.条目[0].采用知识[0];
    assert.deepEqual(view.处置汇总, { 负反馈条目: 1, 已见关联处置: 1, 未见关联处置: 0, 处置不可核对: 0 });
    assert.equal(adopted.反馈处置.状态, '已见关联处置'); assert.equal(adopted.反馈处置.总数, 1);
    assert.equal(adopted.反馈处置.记录[0].动作, '失效'); assert.equal(adopted.反馈处置.记录[0].主体, LEAD.id);
    assert.deepEqual(adopted.来源, { 状态: '来源未核验' });
    const rows = (await readFile(org.layout.memoryLog(P, '知识'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const state = rows.find(row => row.追加 === 'invalid'); assert.equal(state.反馈关联.版本, 1);
    assert.ok(/^[a-f0-9]{64}$/.test(state.反馈关联.指纹));
    assert.ok(!JSON.stringify(rows).includes(task.id)); assert.ok(!JSON.stringify(rows).includes('private-feedback-purpose'));
    const publicRead = await org.memory.query({ subject: LEAD, 项目: P, 类: '知识', id: knowledge.id, 含失效: true });
    const lineage = await org.memory.lineage({ subject: LEAD, id: knowledge.id });
    for (const output of [view, publicRead, lineage]) { const json = JSON.stringify(output); assert.ok(!json.includes('反馈关联')); assert.ok(!json.includes(state.反馈关联.指纹)); }
    assert.equal(await readFile(org.layout.taskLog(P), 'utf8'), originalTask);
    assert.equal((await org.tasks.get(task.id, { 项目: P })).状态, '已交卷');
    assert.deepEqual((await org.workbench({ 项目: P, 读者: LEAD })).知识复用.处置汇总, view.处置汇总);
    assert.equal((await org.workbench({ 项目: P, 读者: MEMBER })).知识复用, null);
  }));

  it('坏观察回执或读取故障保持不可核对，不冒充未处理或泄出错误正文', async () => scene(async ({ org, query }) => {
    for (const observer of [async () => { throw new Error('private-observer-error'); }, async ({ items }) => new Map(items.map(item => [item.反馈指纹, { 状态: '可核对', 记录: [{ 正文: 'private-observer-body' }], 总数: 1, 截断: false }]))]) {
      org.memory.readFeedbackDispositions = observer;
      const view = await query();
      assert.deepEqual(view.处置汇总, { 负反馈条目: 1, 已见关联处置: 0, 未见关联处置: 0, 处置不可核对: 1 });
      assert.deepEqual(view.采用页.条目[0].采用知识[0].反馈处置, { 状态: '不可核对', 记录: [], 总数: null, 截断: null });
      assert.ok(!JSON.stringify(view).includes('private-observer'));
    }
    const noActor = await org.knowledgeReuse.summary(P);
    assert.equal(noActor.处置汇总.处置不可核对, 1); assert.equal(noActor.处置汇总.未见关联处置, 0);
  }));

  it('来源已失效仍独立核处置，后续关联改变分页版本，purge后不凭旧记录继续签处置可核', async () => scene(async ({ org, knowledge, spec, query }) => {
    await org.memory.invalidate(knowledge.id, spec);
    const first = await query(); const taskBytes = await readFile(org.layout.taskLog(P), 'utf8');
    assert.equal(first.汇总.来源可核, 0); assert.equal(first.处置汇总.已见关联处置, 1);
    await org.memory.demote(knowledge.id, spec);
    const next = await query();
    assert.equal(next.汇总.来源可核, 0); assert.equal(next.采用页.条目[0].采用知识[0].反馈处置.总数, 2);
    assert.notEqual(first.数据版本, next.数据版本);
    await assert.rejects(query({ 数据版本: first.数据版本 }), /版本|第一页/);
    assert.equal(await readFile(org.layout.taskLog(P), 'utf8'), taskBytes);
    await org.memory.purge(knowledge.id, { subject: SOVEREIGN, 敏感: true, 理由: '隔离数据明确删除' });
    const removed = await query();
    assert.deepEqual(removed.处置汇总, { 负反馈条目: 1, 已见关联处置: 0, 未见关联处置: 0, 处置不可核对: 1 });
    assert.equal(removed.采用页.条目[0].采用知识[0].反馈处置.总数, null);
  }));

  it('处置已落仅审计失败时，原负反馈仍可核到实际状态记录', async () => scene(async ({ org, knowledge, spec, query }) => {
    const append = org.audit.append.bind(org.audit);
    org.audit.append = async entry => { if (entry.动作 === '状态变更' && entry.对象?.id === knowledge.id) throw new Error('fixture post-state audit unavailable'); return append(entry); };
    await assert.rejects(org.memory.invalidate(knowledge.id, spec), /post-state audit unavailable/);
    org.audit.append = append;
    const view = await query();
    assert.equal(view.处置汇总.已见关联处置, 1); assert.equal(view.采用页.条目[0].采用知识[0].反馈处置.总数, 1);
    assert.ok(!JSON.stringify(view).includes('post-state audit unavailable'));
  }));
});
