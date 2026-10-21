/** 真实Org、交卷、来源观察和工作台的隔离纵向验证，不调用模型或宿主。 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Org } from '../src/org.js';
import { digest } from '../src/kernel/text.js';
import { readTaskLedger } from '../src/task-ledger.js';
import { makeFixture, LEAD, MEMBER, SOVEREIGN } from './helpers.mjs';

const P = 'knowledge-reuse-integration';
const declaration = id => ({ id, 用途: '选择当前实现', 适用判断: '核对本次版本前提', 使用结果: '有帮助', 说明: '仍需本任务复核' });
async function scene(run) {
  const f = await makeFixture();
  try {
    const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
    const makeTask = async () => {
      const task = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '核对采用声明', 负责人: '插件工程', 判据: ['本次交付有依据'] });
      await org.tasks.bind(task.id, { subject: LEAD, 项目: P, 实例: MEMBER.id, 岗位: MEMBER.roleId });
      await org.tasks.dispatch(task.id, { subject: LEAD, 项目: P });
      await org.tasks.start(task.id, { subject: MEMBER, 项目: P });
      return task;
    };
    const remember = 内容 => org.memory.remember({ subject: SOVEREIGN, 类: '知识', 项目: P, 内容, 来源: '隔离测试中的实际来源记录', 岗位: '插件工程' });
    await run({ f, org, makeTask, remember });
  } finally { await f.cleanup(); }
}

describe('知识采用的真实装配', { timeout: 30000 }, () => {
  it('保存完整来源哈希与本人声明，查询和工作台同源且不复制知识正文', async () => scene(async ({ org, makeTask, remember }) => {
    const body = 'only-in-memory-original\n' + '版本前提不可裁切'.repeat(5000);
    const knowledge = await remember(body);
    const task = await makeTask();
    const node = await org.tasks.submit(task.id, { subject: MEMBER, 项目: P, 结论: '交付待复核', 采用知识: [declaration(knowledge.id)] });
    const answer = node.独立答案.find(item => item.成员 === MEMBER.id);
    assert.equal(Object.hasOwn(answer, '采用知识'), false);
    assert.equal(answer.代, 1); assert.ok(answer.提交序 > 0);
    const submitted = (await readTaskLedger(org.layout.taskLog(P))).find(row => row.kind === 'submitted');
    assert.equal(submitted.采用知识.条目[0].来源.内容哈希, digest(body));
    const raw = await readFile(org.layout.taskLog(P), 'utf8');
    assert.ok(!raw.includes('only-in-memory-original'));
    const query = await org.knowledgeReuse.query({ subject: LEAD, 项目: P });
    assert.equal(query.汇总.交卷记录, 1); assert.equal(query.汇总.来源可核, 1);
    assert.equal(query.采用页.条目[0].采用知识[0].当前来源, '同一观察版本');
    assert.ok(!JSON.stringify(query).includes('only-in-memory-original'));
    assert.equal((await org.workbench({ 项目: P, 读者: LEAD })).知识复用.汇总.有帮助声明, 1);
    assert.equal((await org.workbench({ 项目: P, 读者: MEMBER })).知识复用, null);
  }));

  it('坏观察实现或坏回执均降为匿名未核验，合法交卷继续提交', async () => scene(async ({ org, makeTask }) => {
    for (const observer of [async () => { throw new Error('private source error'); }, async () => new Map([['know-missing', { 状态: '可核来源版本', 正文: 'private body' }]]), async () => ({ get: 'not-a-function' })]) {
      const task = await makeTask();
      org.memory.readKnowledgeEvidence = observer;
      const node = await org.tasks.submit(task.id, { subject: MEMBER, 项目: P, 结论: '保留未知来源', 采用知识: [declaration('know-missing')] });
      assert.equal(node.状态, '已交卷');
      const submitted = (await readTaskLedger(org.layout.taskLog(P))).find(row => row.kind === 'submitted' && row.id === task.id);
      assert.deepEqual(submitted.采用知识.条目[0].来源, { 状态: '来源未核验' });
    }
    const raw = await readFile(org.layout.taskLog(P), 'utf8');
    assert.ok(!raw.includes('private source error')); assert.ok(!raw.includes('private body'));
  }));

  it('失效后重新核当前来源，旧捕获哈希不继续从反馈查询返回', async () => scene(async ({ org, makeTask, remember }) => {
    const knowledge = await remember('capture-then-withdraw');
    const task = await makeTask();
    await org.tasks.submit(task.id, { subject: MEMBER, 项目: P, 采用知识: [declaration(knowledge.id)] });
    const first = await org.knowledgeReuse.query({ subject: LEAD, 项目: P });
    assert.equal(first.汇总.来源可核, 1);
    await org.memory.invalidate(knowledge.id, { subject: SOVEREIGN, 原因: '实际反例待核对' });
    const current = await org.knowledgeReuse.query({ subject: LEAD, 项目: P });
    assert.equal(current.汇总.声明条目, 1); assert.equal(current.汇总.来源可核, 0);
    assert.deepEqual(current.采用页.条目[0].采用知识[0].来源, { 状态: '来源未核验' });
    assert.ok(!JSON.stringify(current).includes('内容哈希')); assert.ok(!JSON.stringify(current).includes('capture-then-withdraw'));
    await assert.rejects(org.knowledgeReuse.query({ subject: LEAD, 项目: P, 数据版本: first.数据版本 }), /版本已变化|从第一页/);
  }));

  it('声明在首个异步边界前固定，省略和显式空分别留下历史记录', async () => scene(async ({ org, makeTask }) => {
    const task = await makeTask(); const items = [declaration('know-not-visible')];
    const pending = org.tasks.submit(task.id, { subject: MEMBER, 项目: P, 采用知识: items });
    items[0].用途 = 'mutated after async start'; items.push(declaration('know-another'));
    await pending;
    const second = await makeTask(); await org.tasks.submit(second.id, { subject: MEMBER, 项目: P });
    const third = await makeTask(); await org.tasks.submit(third.id, { subject: MEMBER, 项目: P, 采用知识: [] });
    const view = await org.knowledgeReuse.query({ subject: LEAD, 项目: P });
    assert.equal(view.汇总.未说明, 1); assert.equal(view.汇总.显式空, 1); assert.equal(view.汇总.有声明, 1);
    assert.equal(view.汇总.声明条目, 1);
    assert.equal(view.采用页.条目.find(item => item.任务 === task.id).采用知识[0].用途, '选择当前实现');
    await assert.rejects(org.knowledgeReuse.query({ subject: MEMBER, 项目: P }), /治理读资格|只向/);
  }));
});
