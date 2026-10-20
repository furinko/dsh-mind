/** 组织任务终止与唯一后继：不把宿主停止、旧票或旧文件授权伪造成恢复事实。 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { makeFixture, seedLegacyIndependentCouncil, LEAD, MEMBER, SOVEREIGN } from './helpers.mjs';
import { TaskGraph, 已被合法采纳 } from '../src/tasks.js';
import { readTaskLedger } from '../src/task-ledger.js';
import { appendLines } from '../src/kernel/fsx.js';
import { Denied, Fault, InvalidBody } from '../src/kernel/errors.js';

const P = 'task-recovery-domain';
const CLOSE = { subject: LEAD, 项目: P, 原因: '原执行路径无法继续' };
const NEXT = { subject: LEAD, 项目: P, 负责人: ['插件工程'], 原因: '沿用冻结标准重新执行' };

async function scene(run) {
  const f = await makeFixture();
  try {
    const makeTasks = () => new TaskGraph({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock, registry: f.registry });
    const tasks = makeTasks();
    const create = (extra = {}) => tasks.create({ subject: LEAD, 项目: P, 描述: '恢复源任务', 负责人: ['member-a'], 判据: ['验收标准一', '验收标准二'], ...extra });
    const rows = () => readTaskLedger(f.layout.taskLog(P));
    const rewrite = async (edit) => { const value = await rows(); edit(value); await writeFile(f.layout.taskLog(P), value.map((row) => JSON.stringify(row)).join('\n') + '\n'); };
    const submit = async (id) => { await tasks.dispatch(id, { subject: LEAD, 项目: P }); await tasks.start(id, { subject: MEMBER, 项目: P }); return tasks.submit(id, { subject: MEMBER, 项目: P, 结论: '保留原答案', 知识候选: ['可追溯候选'] }); };
    const accept = async (id) => { await submit(id); const review = await tasks.review(id, { subject: SOVEREIGN, 项目: P, 三态: '过', 理由: '真实复核' }); return tasks.accept(id, { subject: LEAD, 项目: P, 票: review.待采纳.票 }); };
    await run({ f, tasks, makeTasks, create, rows, rewrite, submit, accept });
  } finally { await f.cleanup(); }
}

describe('任务终止与正式后继的领域合同', () => {
  it('封存的执行绑定可由 Lead 终止，保留答案/判据/票/绑定且不声称停止宿主', async () => scene(async ({ f, tasks, create, submit, rows }) => {
    const source = await create();
    await tasks.bind(source.id, { subject: LEAD, 项目: P, 实例: MEMBER.id, 岗位: MEMBER.roleId });
    await submit(source.id);
    const reviewed = await tasks.review(source.id, { subject: SOVEREIGN, 项目: P, 三态: '过', 理由: '可追溯旧票' });
    const before = await tasks.get(source.id, { 项目: P });
    await f.registry.seal({ subject: LEAD, 实例: MEMBER.id, 理由: '执行体已不可续用' });
    const result = await tasks.close(source.id, CLOSE);
    assert.equal(result.节点.状态, '已终止');
    assert.equal(result.宿主停止状态, '未确认');
    assert.equal(result.在途工具已取消, false);
    assert.deepEqual(result.节点.绑定, before.绑定);
    assert.deepEqual(result.节点.独立答案, before.独立答案);
    assert.deepEqual(result.节点.判据, before.判据);
    assert.deepEqual(result.节点.复核经过, before.复核经过);
    assert.equal(result.节点.终止.原状态, '已交卷');
    assert.equal(result.节点.终止.由, LEAD.id);
    assert.equal(result.节点.待采纳, undefined);
    assert.ok(reviewed.待采纳.票);
    assert.equal((await rows()).at(-1).kind, 'closed');
    assert.ok((await tasks.snapshot({ 项目: P })).终端.some((node) => node.id === source.id));
  }));

  it('同原因重试是当前 read 权限下的回执，不追加事件或伪补审计；不同原因冲突', async () => scene(async ({ f, tasks, create, rows }) => {
    const source = await create();
    await tasks.close(source.id, CLOSE);
    const before = await rows();
    const checks = [];
    const original = f.policy.check.bind(f.policy);
    f.policy.check = async (spec) => { checks.push(spec.action); return original(spec); };
    const plan = await tasks.closePlan(source.id, { ...CLOSE, 原因: `  ${CLOSE.原因}  ` });
    assert.equal(plan.步骤[0].动作, 'read');
    assert.equal((await tasks.close(source.id, { ...CLOSE, 执行计划: plan })).幂等, true);
    assert.deepEqual(checks, ['read']);
    assert.deepEqual(await rows(), before);
    await assert.rejects(() => tasks.close(source.id, { ...CLOSE, 原因: '另一个事实' }), (error) => error instanceof Denied);
    f.policy.check = async (spec) => { if (spec.action === 'read') throw new Denied('测试当前读闸', '读权限已变'); return original(spec); };
    await assert.rejects(() => tasks.close(source.id, CLOSE), /读权限已变/);
    assert.deepEqual(await rows(), before);
  }));

  it('成员、自报 Lead、未知主体与失去在岗资格的旧 Lead 均无恢复资格，主权者保留正门', async () => scene(async ({ f, tasks, create, rows }) => {
    const source = await create();
    const before = await rows();
    for (const subject of [MEMBER, { id: MEMBER.id, kind: 'Lead' }, { id: 'ghost', kind: 'Lead' }, { id: 'x', kind: '未知' }]) {
      await assert.rejects(() => tasks.close(source.id, { ...CLOSE, subject }), (error) => error instanceof Denied);
    }
    assert.deepEqual(await rows(), before);
    const plan = await tasks.closePlan(source.id, CLOSE);
    await f.registry.seal({ subject: SOVEREIGN, 实例: LEAD.id, 理由: '撤回在岗资格' });
    await assert.rejects(() => tasks.close(source.id, { ...CLOSE, 执行计划: plan }), (error) => error instanceof Denied);
    assert.equal((await tasks.close(source.id, { ...CLOSE, subject: SOVEREIGN })).节点.状态, '已终止');
  }));

  it('已采纳/已结账与旧独立会审拒绝终止，未终止源不能创建后继', async () => scene(async ({ f, tasks, create, accept, rows }) => {
    const accepted = await create();
    await accept(accepted.id);
    assert.equal(已被合法采纳(await tasks.get(accepted.id, { 项目: P })), true);
    await assert.rejects(() => tasks.close(accepted.id, CLOSE), (error) => error instanceof Denied);
    const seq = (await rows()).length + 1;
    await appendLines(f.layout.taskLog(P), [{ seq, at: f.clock.iso(), by: LEAD, kind: 'settled', id: accepted.id }]);
    await assert.rejects(() => tasks.close(accepted.id, CLOSE), (error) => error instanceof Denied);
    const legacy = await seedLegacyIndependentCouncil(f, { 项目: P });
    await assert.rejects(() => tasks.close(legacy, CLOSE), (error) => error instanceof Denied && /只读历史/.test(error.rule));
    await assert.rejects(() => tasks.successorPlan(legacy, NEXT), (error) => error instanceof Denied && /只读历史/.test(error.rule));
    const active = await create();
    await assert.rejects(() => tasks.createSuccessor(active.id, NEXT), (error) => error instanceof Denied && /先终止/.test(error.rule));
  }));

  it('后继仅继承冻结判据/原依赖/复核对象，一行 created 恢复唯一双向关系', async () => scene(async ({ tasks, makeTasks, create, rows }) => {
    const dependency = await create({ 描述: '原依赖' });
    const target = await create({ 描述: '被复核对象' });
    const source = await create({ 依赖: [dependency.id], 复核对象: [target.id] });
    await tasks.bind(source.id, { subject: LEAD, 项目: P, 实例: MEMBER.id, 岗位: MEMBER.roleId });
    await tasks.close(source.id, CLOSE);
    const before = await rows();
    const plan = await tasks.successorPlan(source.id, NEXT);
    assert.equal(Object.isFrozen(plan), true);
    assert.equal(Object.isFrozen(plan.后继输入.判据), true);
    assert.deepEqual(await rows(), before);
    assert.equal(plan.步骤.length, 1);
    assert.equal(plan.步骤[0].动作, 'create');
    const result = await tasks.createSuccessor(source.id, { ...NEXT, 执行计划: plan });
    const child = result.节点;
    assert.equal(child.状态, '待派发');
    assert.equal(child.判据冻结, true);
    assert.deepEqual(child.判据, source.判据);
    assert.deepEqual(child.依赖, [dependency.id]);
    assert.deepEqual(child.复核对象, [target.id]);
    for (const key of ['绑定', '工具文件范围', '采纳', '待采纳', '交付物清单']) assert.equal(child[key], undefined);
    assert.deepEqual(child.独立答案 ?? [], []);
    assert.equal(child.前序任务, source.id);
    assert.equal((await makeTasks().get(source.id, { 项目: P })).后继任务, child.id);
    assert.equal((await rows()).length, before.length + 1);
    assert.equal((await rows()).at(-1).kind, 'created');
  }));

  it('后继推进后同规范重试认真实节点，不重置状态；不同规范不能另立正式后继', async () => scene(async ({ tasks, create, rows }) => {
    const source = await create();
    await tasks.close(source.id, CLOSE);
    const first = await tasks.createSuccessor(source.id, { ...NEXT, 负责人: ['member-a', 'member-b'] });
    await tasks.dispatch(first.节点.id, { subject: LEAD, 项目: P });
    await tasks.start(first.节点.id, { subject: MEMBER, 项目: P });
    const before = await rows();
    const repeated = await tasks.createSuccessor(source.id, { ...NEXT, 原因: ` ${NEXT.原因} `, 负责人: ['member-b', 'member-a', 'member-a'] });
    assert.equal(repeated.幂等, true);
    assert.equal(repeated.节点.id, first.节点.id);
    assert.equal(repeated.节点.状态, '执行中');
    assert.deepEqual(await rows(), before);
    for (const change of [{ 负责人: 'member-a' }, { 描述: '另一个描述' }, { 原因: '另一原因' }]) await assert.rejects(() => tasks.createSuccessor(source.id, { ...NEXT, 负责人: ['member-a', 'member-b'], ...change }), (error) => error instanceof Denied && /冲突/.test(error.rule));
  }));

  it('并发相同输入至多一笔后继，不同输入至多一个赢家', async () => scene(async ({ tasks, makeTasks, create, rows }) => {
    const source = await create();
    await tasks.close(source.id, CLOSE);
    const [a, b] = await Promise.all([tasks.createSuccessor(source.id, NEXT), makeTasks().createSuccessor(source.id, NEXT)]);
    assert.equal(a.节点.id, b.节点.id);
    assert.equal([a, b].filter((result) => !result.幂等).length, 1);
    const other = await create({ 描述: '竞争源' });
    await tasks.close(other.id, CLOSE);
    const results = await Promise.allSettled([tasks.createSuccessor(other.id, NEXT), makeTasks().createSuccessor(other.id, { ...NEXT, 描述: '不同正式后继' })]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected' && result.reason instanceof Denied).length, 1);
    assert.equal((await rows()).filter((row) => row.kind === 'created' && row.前序任务 === source.id).length, 1);
    assert.equal((await rows()).filter((row) => row.kind === 'created' && row.前序任务 === other.id).length, 1);
  }));

  it('关系字段、继承覆写与伪造执行计划均显式拒绝，不能通过普通 create 注入', async () => scene(async ({ tasks, create, rows }) => {
    const source = await create();
    await tasks.close(source.id, CLOSE);
    const before = await rows();
    for (const key of ['判据', '依赖', '复核对象', '工具文件范围', '绑定', '状态', '前序任务', '执行计划']) await assert.rejects(() => tasks.successorPlan(source.id, { ...NEXT, [key]: [] }), (error) => error instanceof InvalidBody);
    await assert.rejects(() => tasks.close(source.id, { ...CLOSE, 执行计划: {} }), (error) => error instanceof InvalidBody);
    for (const key of ['前序任务', '后继任务', '源快照摘要', '规范摘要', '后继规范摘要', '后继原因', '终止源快照摘要']) await assert.rejects(() => create({ [key]: source.id }), (error) => error instanceof InvalidBody);
    assert.deepEqual(await rows(), before);
  }));

  it('已签发计划不能换主体/项目/输入，未执行前源事件变化必须重新准备', async () => scene(async ({ tasks, create, rows }) => {
    const source = await create();
    const plan = await tasks.closePlan(source.id, CLOSE);
    await assert.rejects(() => tasks.close(source.id, { ...CLOSE, subject: SOVEREIGN, 执行计划: plan }), (error) => error instanceof InvalidBody);
    await tasks.dispatch(source.id, { subject: LEAD, 项目: P });
    const before = await rows();
    await assert.rejects(() => tasks.close(source.id, { ...CLOSE, 执行计划: plan }), (error) => error instanceof Denied && /准备结果/.test(error.rule));
    assert.deepEqual(await rows(), before);
    await tasks.close(source.id, CLOSE);
    const next = await tasks.successorPlan(source.id, NEXT);
    await assert.rejects(() => tasks.createSuccessor(source.id, { ...NEXT, 描述: '改请求', 执行计划: next }), (error) => error instanceof InvalidBody);
  }));

  for (const field of ['判据', '依赖', '复核对象']) it(`源${field}原文被改后，旧后继请求不能伪认回执`, async () => scene(async ({ tasks, create, rewrite }) => {
    const source = await create();
    await tasks.close(source.id, CLOSE);
    await tasks.createSuccessor(source.id, NEXT);
    const plan = await tasks.successorPlan(source.id, NEXT);
    await rewrite((rows) => { rows.find((row) => row.kind === 'created' && row.id === source.id)[field] = ['管理员改动的原文']; });
    await assert.rejects(() => tasks.createSuccessor(source.id, { ...NEXT, 执行计划: plan }), (error) => error instanceof Fault && error.code === 'TASK_CLOSE_SOURCE_INVALID');
    await assert.rejects(() => tasks.successorPlan(source.id, NEXT), (error) => error instanceof Fault && error.code === 'TASK_CLOSE_SOURCE_INVALID');
  }));

  it('冻结的只读 close 计划不能因终止事实消失而变新写', async () => scene(async ({ tasks, create, rows, rewrite }) => {
    const source = await create();
    await tasks.close(source.id, CLOSE);
    const plan = await tasks.closePlan(source.id, CLOSE);
    await rewrite((rows) => rows.splice(rows.findIndex((row) => row.kind === 'closed'), 1));
    const before = await rows();
    await assert.rejects(() => tasks.close(source.id, { ...CLOSE, 执行计划: plan }), (error) => error instanceof Denied && /准备结果/.test(error.rule));
    assert.deepEqual(await rows(), before);
  }));

  it('冻结的只读 successor 计划不能因旧 created 消失而变新建', async () => scene(async ({ tasks, create, rows, rewrite }) => {
    const source = await create();
    await tasks.close(source.id, CLOSE);
    const child = await tasks.createSuccessor(source.id, NEXT);
    const plan = await tasks.successorPlan(source.id, NEXT);
    await rewrite((rows) => rows.splice(rows.findIndex((row) => row.id === child.节点.id), 1));
    const before = await rows();
    await assert.rejects(() => tasks.createSuccessor(source.id, { ...NEXT, 执行计划: plan }), (error) => error instanceof Denied && /准备结果/.test(error.rule));
    assert.deepEqual(await rows(), before);
  }));

  for (const operation of ['close', 'successor']) it(`${operation} 事件提交后审计失败保留 outcome，同参只读认回不伪补审计`, async () => scene(async ({ f, tasks, create, rows }) => {
    const source = await create();
    if (operation === 'successor') await tasks.close(source.id, CLOSE);
    const append = f.audit.append.bind(f.audit);
    let failed = false;
    f.audit.append = async (entry) => {
      if (!failed && entry.依据 === '任务图事件流' && entry.结果 === (operation === 'close' ? 'closed' : 'created')) { failed = true; throw new Error('模拟审计不可写'); }
      return append(entry);
    };
    const act = () => operation === 'close' ? tasks.close(source.id, CLOSE) : tasks.createSuccessor(source.id, NEXT);
    await assert.rejects(act, (error) => {
      assert.ok(error instanceof Fault);
      assert.equal(error.code, 'AUDIT_APPEND_FAILED_AFTER_EVENT');
      assert.equal(error.outcome?.提交状态, '已提交');
      if (operation === 'successor') {
        assert.equal(error.detail.前序任务, source.id);
        assert.equal(error.outcome.已确认阶段[0].前序任务, source.id);
        assert.notEqual(error.outcome.已确认阶段[0].任务, source.id);
      }
      return true;
    });
    const before = await rows();
    let taskAudits = 0;
    f.audit.append = async (entry) => { if (entry.依据 === '任务图事件流') taskAudits += 1; return append(entry); };
    assert.equal((await act()).幂等, true);
    assert.equal(taskAudits, 0);
    assert.deepEqual(await rows(), before);
  }));

  it('create 可登记未完成依赖，dispatch 必须等精确原依赖合法采纳', async () => scene(async ({ tasks, create, accept, rows }) => {
    const dependency = await create({ 描述: '尚未完成前置' });
    const downstream = await create({ 依赖: [dependency.id] });
    const before = await rows();
    await assert.rejects(() => tasks.dispatch(downstream.id, { subject: LEAD, 项目: P }), (error) => error instanceof Denied && /依赖/.test(error.rule));
    assert.deepEqual(await rows(), before);
    await accept(dependency.id);
    assert.equal((await tasks.dispatch(downstream.id, { subject: LEAD, 项目: P })).状态, '已派发');
  }));

  it('原依赖已终止时，其正式后继即使采纳也不能替旧 id 满足依赖', async () => scene(async ({ tasks, create, accept, rows }) => {
    const dependency = await create({ 描述: '必须精确指向的前置' });
    const downstream = await create({ 依赖: [dependency.id] });
    await tasks.close(dependency.id, CLOSE);
    const child = await tasks.createSuccessor(dependency.id, { ...NEXT, 负责人: MEMBER.id });
    await accept(child.节点.id);
    const before = await rows();
    await assert.rejects(() => tasks.dispatch(downstream.id, { subject: LEAD, 项目: P }), (error) => error instanceof Denied && error.detail.未完成依赖.includes(dependency.id));
    assert.deepEqual(await rows(), before);
  }));

  for (const field of ['判据', '依赖', '复核对象']) it(`首次接续前源 ${field} 被替换，closed 摘要阻止继承和旧终止认回`, async () => scene(async ({ tasks, create, rewrite, rows }) => {
    const source = await create();
    await tasks.close(source.id, CLOSE);
    await rewrite((rows) => { rows.find((row) => row.kind === 'created' && row.id === source.id)[field] = ['合法 JSON 的原文替换']; });
    const before = await rows();
    for (const call of [() => tasks.successorPlan(source.id, NEXT), () => tasks.createSuccessor(source.id, NEXT), () => tasks.close(source.id, CLOSE)]) await assert.rejects(call, (error) => error instanceof Fault && error.code === 'TASK_CLOSE_SOURCE_INVALID');
    assert.deepEqual(await rows(), before);
  }));

  for (const field of ['判据', '依赖', '复核对象', '工具文件范围', '继承打回次数', '接续提醒']) it(`后继 created 的 ${field} 原文变更不能靠自报摘要伪认回执`, async () => scene(async ({ tasks, create, rewrite, rows }) => {
    const source = await create();
    await tasks.close(source.id, CLOSE);
    const result = await tasks.createSuccessor(source.id, NEXT);
    await rewrite((rows) => { rows.find((row) => row.kind === 'created' && row.id === result.节点.id)[field] = ['篡改而保留自报摘要']; });
    const before = await rows();
    await assert.rejects(() => tasks.createSuccessor(source.id, NEXT), (error) => error instanceof Fault && error.code === 'TASK_SUCCESSOR_CREATION_INVALID');
    assert.deepEqual(await rows(), before);
  }));

  it('合法改派/绑定后仍按原 created 认回，不把可变负责人当创建证据', async () => scene(async ({ tasks, create }) => {
    const source = await create();
    await tasks.close(source.id, CLOSE);
    const result = await tasks.createSuccessor(source.id, NEXT);
    await tasks.reassign(result.节点.id, { subject: LEAD, 项目: P, 负责人: 'member-b' });
    await tasks.bind(result.节点.id, { subject: LEAD, 项目: P, 实例: 'member-b', 岗位: MEMBER.roleId });
    const repeated = await tasks.createSuccessor(source.id, NEXT);
    assert.equal(repeated.幂等, true);
    assert.deepEqual(repeated.节点.负责人, ['member-b']);
    assert.equal(repeated.节点.绑定[0].实例, 'member-b');
  }));

  it('正式后继不洗累计失败，跨阈值沿旧规则升级，下一代只继承来源提醒', async () => scene(async ({ tasks, create, rows }) => {
    const source = await create();
    await tasks.reject(source.id, { subject: SOVEREIGN, 项目: P, 理由: '前序失败一次' });
    await tasks.close(source.id, CLOSE);
    const child = await tasks.createSuccessor(source.id, NEXT);
    assert.equal(child.节点.继承打回次数, 1);
    assert.equal(child.节点.打回次数, 1);
    assert.equal(child.节点.本节点打回次数, 0);
    await tasks.reject(child.节点.id, { subject: SOVEREIGN, 项目: P, 理由: '本节点失败' });
    const failed = await tasks.get(child.节点.id, { 项目: P });
    assert.equal(failed.打回次数, 2);
    assert.equal(failed.本节点打回次数, 1);
    assert.deepEqual(failed.升级, { 原因: '打回≥2', 至: '主权者' });
    await tasks.markPending(child.节点.id, { subject: LEAD, 项目: P, 原因: '前序事项待裁决', 待决类型: '升级差异' });
    await tasks.close(child.节点.id, CLOSE);
    const before = await rows();
    const next = await tasks.createSuccessor(child.节点.id, NEXT);
    assert.equal(next.节点.状态, '待派发');
    assert.equal(next.节点.打回次数, 2);
    assert.equal(next.节点.本节点打回次数, 0);
    assert.deepEqual(next.节点.接续提醒, { 来源任务: child.节点.id, 前序升级: failed.升级, 累计打回次数: 2, 阈值提醒: true, 前序待决: { 原因: '前序事项待裁决', 类型: '升级差异' }, 处置状态: '未确认' });
    assert.equal((await rows()).filter((row) => row.kind === 'escalated').length, before.filter((row) => row.kind === 'escalated').length, '不为前序重复伪造升级事实');
    assert.equal((await tasks.dispatch(next.节点.id, { subject: LEAD, 项目: P })).状态, '已派发', '提醒不新增审批门或待决状态');
  }));

  it('第二次 rejected 与 escalated 之间先 close，保留前半事实且不追加终止后事件', async () => scene(async ({ f, tasks, create, rows }) => {
    const source = await create();
    await tasks.reject(source.id, { subject: SOVEREIGN, 项目: P, 理由: '首次失败' });
    const append = f.audit.append.bind(f.audit);
    let intercepted = false;
    f.audit.append = async (entry) => {
      if (!intercepted && entry.依据 === '任务图事件流' && entry.结果 === 'rejected') { intercepted = true; await tasks.close(source.id, CLOSE); }
      return append(entry);
    };
    const result = await tasks.reject(source.id, { subject: SOVEREIGN, 项目: P, 理由: '第二次失败' });
    assert.equal(result.状态, '已终止');
    assert.equal(result.打回次数, 2);
    assert.equal((await rows()).at(-1).kind, 'closed');
    assert.equal((await rows()).filter((row) => row.kind === 'escalated').length, 0);
    const child = await tasks.createSuccessor(source.id, NEXT);
    assert.equal(child.节点.接续提醒.阈值提醒, true);
    assert.equal(child.节点.接续提醒.前序升级, null);
    assert.equal(child.节点.接续提醒.处置状态, '未确认');
  }));

  it('close 与 submit/accept 的双向交错都受同一账本锁约束，不复活已终止节点', async () => scene(async ({ f, tasks, create, submit, rows }) => {
    const source = await create();
    await submit(source.id);
    const review = await tasks.review(source.id, { subject: SOVEREIGN, 项目: P, 三态: '过', 理由: '独立通过' });
    const acceptCheck = f.policy.check.bind(f.policy);
    let release;
    let entered;
    const reached = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    f.policy.check = async (spec) => { if (spec.action === 'write' && spec.target.id === source.id && spec.context?.节点操作 === 'other') { entered(); await gate; } return acceptCheck(spec); };
    const accepting = tasks.accept(source.id, { subject: LEAD, 项目: P, 票: review.待采纳.票 });
    await reached;
    await tasks.close(source.id, CLOSE);
    release();
    await assert.rejects(() => accepting, (error) => error instanceof Denied);
    const before = await rows();
    for (const call of [() => tasks.start(source.id, { subject: MEMBER, 项目: P }), () => tasks.submit(source.id, { subject: MEMBER, 项目: P, 结论: '不可复活' }), () => tasks.reject(source.id, { subject: SOVEREIGN, 项目: P, 理由: '不可复活' }), () => tasks.attach(source.id, { subject: LEAD, 项目: P, 产出物: 'x' })]) await assert.rejects(call, (error) => error instanceof Denied);
    assert.deepEqual(await rows(), before);
    f.policy.check = acceptCheck;
    const other = await create({ 描述: '先采纳的相反顺序' });
    await submit(other.id);
    const otherReview = await tasks.review(other.id, { subject: SOVEREIGN, 项目: P, 三态: '过', 理由: '通过' });
    const plan = await tasks.closePlan(other.id, CLOSE);
    await tasks.accept(other.id, { subject: LEAD, 项目: P, 票: otherReview.待采纳.票 });
    await assert.rejects(() => tasks.close(other.id, { ...CLOSE, 执行计划: plan }), (error) => error instanceof Denied);
    const submittingSource = await create({ 描述: '交卷预检后被终止' });
    await tasks.dispatch(submittingSource.id, { subject: LEAD, 项目: P });
    await tasks.start(submittingSource.id, { subject: MEMBER, 项目: P });
    let releaseSubmit;
    let enteredSubmit;
    const submitReached = new Promise((resolve) => { enteredSubmit = resolve; });
    const submitGate = new Promise((resolve) => { releaseSubmit = resolve; });
    f.policy.check = async (spec) => { if (spec.action === 'write' && spec.target.id === submittingSource.id && spec.context?.节点操作 === 'submit') { enteredSubmit(); await submitGate; } return acceptCheck(spec); };
    const submitting = tasks.submit(submittingSource.id, { subject: MEMBER, 项目: P, 结论: '在外层预检后暂停的交卷' });
    await submitReached;
    await tasks.close(submittingSource.id, CLOSE);
    const afterClose = await rows();
    releaseSubmit();
    await assert.rejects(() => submitting, (error) => error instanceof Denied);
    assert.deepEqual(await rows(), afterClose);
    f.policy.check = acceptCheck;
    const submitFirst = await create({ 描述: '交卷先落线的相反顺序' });
    await tasks.dispatch(submitFirst.id, { subject: LEAD, 项目: P });
    await tasks.start(submitFirst.id, { subject: MEMBER, 项目: P });
    const staleClose = await tasks.closePlan(submitFirst.id, CLOSE);
    await tasks.submit(submitFirst.id, { subject: MEMBER, 项目: P, 结论: '先落线的答案必须保留' });
    await assert.rejects(() => tasks.close(submitFirst.id, { ...CLOSE, 执行计划: staleClose }), (error) => error instanceof Denied);
    assert.equal((await tasks.get(submitFirst.id, { 项目: P })).独立答案[0].结论, '先落线的答案必须保留');
  }));
});
