/** 真实Org内跨知识、交卷、采纳、结账与跨项目副本的隔离集成。 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Org } from '../src/org.js';
import { readTaskLedger } from '../src/task-ledger.js';
import { readTextOrNull } from '../src/kernel/fsx.js';
import { memoryResponsePage, memoryResponseOptions } from '../src/memory-response.js';
import { makeFixture, LEAD, MEMBER, REVIEWER, SOVEREIGN } from './helpers.mjs';

const P = 'knowledge-applicability-integration';
async function scene(run) {
  const f = await makeFixture();
  try {
    const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
    let now = Date.now(); org.clock._source = () => new Date(now);
    const setNow = value => { now = typeof value === 'number' ? value : Date.parse(value); };
    const deadline = new Date(now + 2000).toISOString();
    const makeTask = async () => {
      const task = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '核对适用条件', 负责人: MEMBER.roleId, 判据: ['实际可核对交付'] });
      await org.tasks.bind(task.id, { subject: LEAD, 项目: P, 实例: MEMBER.id, 岗位: MEMBER.roleId });
      await org.tasks.dispatch(task.id, { subject: LEAD, 项目: P });
      await org.tasks.start(task.id, { subject: MEMBER, 项目: P });
      return task;
    };
    const accept = async task => {
      const reviewTask = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '独立核对', 负责人: REVIEWER.roleId, 判据: ['复核当前交付'], 复核对象: [task.id] });
      await org.tasks.bind(reviewTask.id, { subject: LEAD, 项目: P, 实例: REVIEWER.id, 岗位: REVIEWER.roleId });
      await org.tasks.dispatch(reviewTask.id, { subject: LEAD, 项目: P });
      const reviewed = await org.tasks.review(task.id, { subject: REVIEWER, 项目: P, 三态: '过' });
      await org.tasks.accept(task.id, { subject: LEAD, 项目: P, 票: reviewed.待采纳.票 });
    };
    const remember = 知识说明 => org.memory.remember({ subject: LEAD, 类: '知识', 项目: P, 内容: '当前实现使用已知协议', 来源: '实际隔离观察', ...(知识说明 === undefined ? {} : { 知识说明 }) });
    await run({ f, org, deadline, setNow, makeTask, accept, remember });
  } finally { await f.cleanup(); }
}

describe('知识适用说明的真实装配', { timeout: 30000 }, () => {
  it('恰好容纳说明的预算仍须推进正文分页，不能返回相同偏移无限循环或切开Unicode', () => {
    for (const text of ['A'.repeat(2000), '😀'.repeat(1000)]) {
      const entry = { id: 'know-demo', 类: '知识', 内容: text, 知识说明: { 适用条件: ['x'.repeat(500)] }, 复验状态: '期限内', 复验警示: '仅作者声明' };
      for (const budget of [647, 648, 649, 650]) {
        const page = memoryResponsePage({ entries: [entry], options: memoryResponseOptions({ id: entry.id, 返回模式: '全文', 内容预算: budget }), total: 1, detail: true });
        const result = page.条目[0];
        assert.equal(result.正文截断, true);
        assert.ok(result.下一正文偏移 > 0, `预算${budget}的正文续页必须推进`);
        assert.equal(result.内容, text.slice(0, result.下一正文偏移));
        assert.ok(!/[\uD800-\uDBFF]$/.test(result.内容), '不能切开Unicode代理对');
      }
    }
  });

  it('跨作者期限后旧来源降为未核验，新交卷仍提交，不把期限当作失效或业务失败', async () => scene(async ({ org, deadline, setNow, remember, makeTask }) => {
    const knowledge = await remember({ 适用条件: ['协议版本相同'], 复验期限: deadline });
    const use = { id: knowledge.id, 用途: '核对当前实现', 适用判断: '本次符合相同协议', 使用结果: '未知' };
    const first = await makeTask(); await org.tasks.submit(first.id, { subject: MEMBER, 项目: P, 采用知识: [use] });
    const before = await org.knowledgeReuse.query({ subject: LEAD, 项目: P });
    assert.equal(before.汇总.来源可核, 1);
    const raw = await readFile(org.layout.memoryLog(P, '知识'), 'utf8');
    setNow(deadline);
    const after = await org.knowledgeReuse.query({ subject: LEAD, 项目: P });
    assert.equal(after.汇总.来源可核, 0);
    assert.deepEqual(after.采用页.条目[0].采用知识[0].来源, { 状态: '来源未核验' });
    assert.ok(!JSON.stringify(after).includes('内容哈希'));
    await assert.rejects(org.knowledgeReuse.query({ subject: LEAD, 项目: P, 数据版本: before.数据版本 }), /版本|第一页/);
    const second = await makeTask();
    assert.equal((await org.tasks.submit(second.id, { subject: MEMBER, 项目: P, 采用知识: [use] })).状态, '已交卷');
    assert.equal(await readFile(org.layout.memoryLog(P, '知识'), 'utf8'), raw);
    const explicit = await org.memory.query({ subject: LEAD, 项目: P, 类: '知识', id: knowledge.id, 含待复验: true });
    assert.equal(explicit.条目[0].复验状态, '待复验'); assert.equal(explicit.条目[0].状态, '有效');
    const submitted = (await readTaskLedger(org.layout.taskLog(P))).filter(row => row.kind === 'submitted').at(-1);
    assert.deepEqual(submitted.采用知识.条目[0].来源, { 状态: '来源未核验' });
  }));

  it('结账晋升真实保存说明；部分提交重试不能改期限冒认旧知识，原请求收敛且不复制说明正文', async () => scene(async ({ org, deadline, makeTask, accept }) => {
    const task = await makeTask(); await org.tasks.submit(task.id, { subject: MEMBER, 项目: P, 知识候选: ['可复用的本次结论'] }); await accept(task);
    const key = `候选/${MEMBER.id}/0`;
    const notes = { 适用条件: ['notes-only-private-marker'], 复验期限: deadline };
    const request = { subject: LEAD, 项目: P, 记忆处置: { [key]: { 处置: '晋升', 知识说明: notes } } };
    const archive = org.memory.archiveAnswers.bind(org.memory);
    org.memory.archiveAnswers = async () => { throw new Error('fixture archive unavailable'); };
    await assert.rejects(org.tasks.settle(task.id, request), /archive unavailable/);
    const before = await org.memory.query({ subject: LEAD, 项目: P, 类: '知识' });
    assert.equal(before.条目.length, 1); const id = before.条目[0].id;
    assert.deepEqual(before.条目[0].知识说明, notes);
    const changed = structuredClone(request); changed.记忆处置[key].知识说明.复验期限 = new Date(Date.parse(deadline) + 1000).toISOString();
    await assert.rejects(org.tasks.settle(task.id, changed), /幂等|参数|不一致/);
    org.memory.archiveAnswers = archive;
    const settled = await org.tasks.settle(task.id, request);
    assert.equal(settled.状态, '已结账'); assert.equal(settled.记忆晋升[key], id);
    assert.equal((await org.memory.query({ subject: LEAD, 项目: P, 类: '知识' })).条目.length, 1);
    const tasks = await readFile(org.layout.taskLog(P), 'utf8');
    assert.ok(!tasks.includes('notes-only-private-marker')); assert.ok(!Object.hasOwn(settled.记忆处置[key], '知识说明'));
  }));

  it('非法结账说明在知识/归档写前拒绝，不能借晋升对象注入验证结论', async () => scene(async ({ org, makeTask, accept }) => {
    const task = await makeTask(); await org.tasks.submit(task.id, { subject: MEMBER, 项目: P, 知识候选: ['本次候选'] }); await accept(task);
    const beforeTask = await readFile(org.layout.taskLog(P), 'utf8');
    const beforeMemory = await readTextOrNull(org.layout.memoryLog(P, '知识'));
    for (const notes of [{ 复验期限: '2026-02-30T00:00:00Z' }, { 适用条件: ['实际条件'], 验证状态: '已验证' }]) {
      await assert.rejects(org.tasks.settle(task.id, { subject: LEAD, 项目: P, 记忆处置: { [`候选/${MEMBER.id}/0`]: { 处置: '晋升', 知识说明: notes } } }), /知识说明|复验期限/);
      assert.equal(await readFile(org.layout.taskLog(P), 'utf8'), beforeTask);
      assert.equal(await readTextOrNull(org.layout.memoryLog(P, '知识')), beforeMemory);
    }
  }));

  it('跨项目副本保留作者条件和期限，到期不借晋升续期；显式历史读取不放宽失效过滤', async () => scene(async ({ org, deadline, setNow, remember }) => {
    const notes = { 适用条件: ['相同环境'], 复验期限: deadline };
    const knowledge = await remember(notes);
    await org.memory.promoteCrossProject(knowledge.id, { subject: LEAD, 岗位: MEMBER.roleId, 理由: '明确跨项目适用' });
    const query = args => org.memory.query({ subject: LEAD, 项目: 'other-project', 类: '知识', id: knowledge.id, ...args });
    assert.deepEqual((await query({})).条目[0].知识说明, notes);
    setNow(deadline);
    assert.equal((await query({})).条目.length, 0);
    assert.equal((await query({ 含待复验: true })).条目[0].复验状态, '待复验');
    await org.memory.invalidate(knowledge.id, { subject: SOVEREIGN, 原因: '另有实际反例' });
    assert.equal((await query({ 含待复验: true })).条目.length, 0);
    const history = await query({ 含待复验: true, 含失效: true });
    assert.equal(history.条目[0].状态, '已失效'); assert.equal(history.条目[0].复验状态, '待复验');
  }));
});
