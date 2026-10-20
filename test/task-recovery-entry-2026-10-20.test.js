/** 任务恢复走真实动作、一次性审批、工具及命令入口；只在临时组织账本注入前置事实。 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeFixture, seedLegacyIndependentCouncil, LEAD, MEMBER, REVIEWER } from './helpers.mjs';
import { fakeHost } from './host-harness.mjs';
import { Org } from '../src/org.js';
import { shareOrg } from '../src/runtime.js';
import { readTaskLedger } from '../src/task-ledger.js';
import { runAction, ACTIONS, READ_ONLY_ACTIONS } from '../lib/actions.js';
import { 介入计划Of } from '../lib/approval-plan.js';
import { Denied, InvalidBody, NeedsApproval, Fault, describeFailure } from '../src/kernel/errors.js';
import * as kernel from '../components/kernel/lib/index.js';

const P = 'task-recovery-entry';
const CLOSE_REASON = '原执行路径终止，由新任务继续';
const NEXT_REASON = '保留原判据重新安排正式执行';
const closeArgs = (node) => ({ action: 'task_close', id: node.id, 原因: CLOSE_REASON });
const nextArgs = (node) => ({ action: 'task_successor', id: node.id, 负责人: '插件工程', 原因: NEXT_REASON });

async function scene(run) {
  const f = await makeFixture();
  try {
    const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
    const calls = { spawn: 0, send: 0, stop: 0, release: 0 };
    const host = { subagents: {
      startContinuable: async () => { calls.spawn += 1; return { childId: 'unexpected', messageId: 'unexpected' }; },
      sendMessage: async () => { calls.send += 1; return { messageId: 'unexpected' }; },
      interrupt: () => { calls.stop += 1; },
      drainContinuableChildren: async () => { calls.release += 1; },
    } };
    const act = (args, subject = LEAD) => runAction({ org, 项目: P, 主体: subject, subject, 面: 'tool', 宿主: host, args });
    const create = (extra = {}) => org.tasks.create({ subject: LEAD, 项目: P, 描述: '恢复源任务', 负责人: '插件工程', 判据: ['先核对边界', '交付可复验'], ...extra });
    const approval = async () => {
      await f.write('集体L2-共享基础设施/defaults/介入度.json', JSON.stringify({ 介入度: '审批' }));
      assert.equal(await org.policy.reload(), true);
    };
    const requests = () => org.intervention.投影({ 项目: P });
    const rows = () => readTaskLedger(f.layout.taskLog(P));
    const approve = async (args) => {
      let id;
      await assert.rejects(() => act(args), (e) => e instanceof NeedsApproval && Boolean(id = e.detail.请求id));
      await org.intervention.人侧决议({ 请求id: id, 决定: '批准', 通道: '设置页', 认证: '宿主 Connection 已认证' });
      return id;
    };
    await run({ f, org, calls, host, act, create, approval, requests, rows, approve });
    assert.deepEqual(calls, { spawn: 0, send: 0, stop: 0, release: 0 }, '组织关闭/创建后继不暗中启动、发送、停止或释放宿主');
  } finally { await f.cleanup(); }
}

describe('任务恢复动作与审批的真实链路', () => {
  it('task_close 整步挂起→批准→真实关闭；明确不证明宿主停止，原答案仍可追溯', async () => scene(async ({ org, act, create, approval, rows, approve }) => {
    const source = await create();
    await org.tasks.bind(source.id, { subject: LEAD, 项目: P, 实例: MEMBER.id, 岗位: MEMBER.roleId });
    await org.tasks.dispatch(source.id, { subject: LEAD, 项目: P });
    await org.tasks.start(source.id, { subject: MEMBER, 项目: P });
    await org.tasks.submit(source.id, { subject: MEMBER, 项目: P, 结论: '尚未采纳的原答案' });
    await approval();
    const before = await rows();
    const requestId = await approve(closeArgs(source));
    assert.deepEqual(await rows(), before, '等待批准时不能先写closed');
    const preview = (await org.intervention.人侧待决({ 项目: P })).find((row) => row.请求id === requestId);
    assert.equal(preview.步骤.length, 1);
    assert.equal(preview.步骤[0].动作, 'write');
    assert.equal(preview.步骤[0].写, 'close');
    assert.equal(preview.步骤[0].目标.id, source.id);
    assert.equal(preview.步骤[0].预览.原因, CLOSE_REASON);
    const checks = [];
    const check = org.policy.check.bind(org.policy);
    org.policy.check = async (spec) => { checks.push(spec); return check(spec); };
    const result = await act({ ...closeArgs(source), 审批引用: requestId });
    assert.equal(result.节点.状态, '已终止');
    assert.equal(result.组织任务已终止, true);
    assert.equal(result.宿主停止状态, '未确认');
    assert.equal(result.在途工具已取消, false);
    assert.equal(result.节点.独立答案[0].结论, '尚未采纳的原答案');
    assert.ok(!result.节点.采纳, '关闭不得伪造采纳事实');
    assert.ok(checks.some((row) => row.action === 'write' && row.context?.节点操作 === 'close' && row.target.id === source.id), '批准只覆盖介入挂起，实际写仍需policy复判');
    assert.equal((await org.intervention.投影({ 项目: P })).find((row) => row.请求id === requestId).状态, '已完成');
    await assert.rejects(() => act({ ...closeArgs(source), 审批引用: requestId }), (e) => e instanceof Denied, '已经消费的批准不因计划已幂等而复活');
    assert.equal((await rows()).filter((row) => row.id === source.id && row.kind === 'closed').length, 1);
  }));

  it('task_successor 冻结唯一领域计划：一次批准只建一个待派发后继，关系、判据和依赖保持真实', async () => scene(async ({ org, act, create, approval, rows, approve }) => {
    const dependency = await create({ 描述: '原前置依赖' });
    const target = await create({ 描述: '原被复核对象' });
    const source = await create({ 描述: '冻结恢复来源', 依赖: [dependency.id], 复核对象: [target.id] });
    const downstream = await create({ 描述: '仍依赖原任务', 依赖: [source.id] });
    await act(closeArgs(source));
    await approval();
    const plan = await org.tasks.successorPlan(source.id, { subject: LEAD, 项目: P, 负责人: '插件工程', 原因: NEXT_REASON });
    const before = await rows();
    const requestId = await approve(nextArgs(source));
    assert.deepEqual(await rows(), before, '审批前只读准备，不先写后继');
    const preview = (await org.intervention.人侧待决({ 项目: P })).find((row) => row.请求id === requestId).步骤;
    assert.equal(preview.length, 1);
    assert.equal(preview[0].动作, 'create');
    assert.equal(preview[0].目标.id, plan.后继输入.id);
    assert.equal(preview[0].预览.源快照摘要, plan.源快照摘要);
    assert.deepEqual(preview[0].预览.后继输入.判据, source.判据);
    assert.deepEqual(preview[0].预览.后继输入.依赖, [dependency.id]);
    assert.deepEqual(preview[0].预览.后继输入.复核对象, [target.id]);
    let passed;
    const createSuccessor = org.tasks.createSuccessor.bind(org.tasks);
    org.tasks.createSuccessor = async (id, spec) => { passed = spec.执行计划; return createSuccessor(id, spec); };
    const checks = [];
    const check = org.policy.check.bind(org.policy);
    org.policy.check = async (spec) => { checks.push(spec); return check(spec); };
    const result = await act({ ...nextArgs(source), 审批引用: requestId });
    assert.equal(Object.isFrozen(passed), true, '真实执行收到领域签发的冻结计划');
    assert.equal(passed.源快照摘要, plan.源快照摘要);
    assert.equal(result.节点.id, plan.后继输入.id);
    assert.equal(result.前序任务, source.id);
    assert.equal(result.节点.前序任务, source.id);
    assert.equal((await org.tasks.get(source.id, { 项目: P })).后继任务, result.节点.id);
    assert.equal(result.节点.状态, '待派发');
    assert.equal(result.节点.判据冻结, true);
    assert.deepEqual(result.节点.判据, source.判据);
    assert.deepEqual(result.节点.依赖, [dependency.id]);
    assert.deepEqual(result.节点.复核对象, [target.id]);
    assert.deepEqual(result.节点.独立答案 ?? [], []);
    assert.deepEqual(result.节点.绑定 ?? [], []);
    assert.ok(!result.节点.工具文件范围 && !result.节点.待采纳 && !result.节点.采纳, '答案、采纳票、文件域不会继承');
    assert.deepEqual((await org.tasks.get(downstream.id, { 项目: P })).依赖, [source.id], '不自动迁移其他任务依赖');
    assert.ok(checks.some((row) => row.action === 'create' && row.target.id === result.节点.id));
    await assert.rejects(() => act({ ...nextArgs(source), 审批引用: requestId }), (e) => e instanceof Denied);
    assert.equal((await rows()).filter((row) => row.kind === 'created' && row.前序任务 === source.id).length, 1);
  }));

  it('审批档同规范重试只认回已提交事实：零新事件、零新请求；变化输入明确冲突', async () => scene(async ({ org, act, create, approval, rows, requests }) => {
    const source = await create();
    await act(closeArgs(source));
    const first = await act(nextArgs(source));
    await approval();
    const beforeRows = await rows();
    const beforeRequests = await requests();
    const closed = await act(closeArgs(source));
    assert.equal(closed.幂等, true);
    const next = await act(nextArgs(source));
    assert.equal(next.幂等, true);
    assert.equal(next.节点.id, first.节点.id);
    assert.equal((await 介入计划Of({ org, 项目: P, action: 'task_close', args: closeArgs(source), subject: LEAD })).步骤[0].动作, 'read');
    assert.equal((await 介入计划Of({ org, 项目: P, action: 'task_successor', args: nextArgs(source), subject: LEAD })).步骤[0].动作, 'read');
    assert.deepEqual(await rows(), beforeRows);
    assert.deepEqual(await requests(), beforeRequests);
    for (const args of [{ ...closeArgs(source), 原因: '换个终止原因' }, { ...nextArgs(source), 描述: '另一个任务' }, { ...nextArgs(source), 负责人: '复核员' }]) {
      await assert.rejects(() => act(args), (e) => (e instanceof Denied || e instanceof InvalidBody) && !(e instanceof NeedsApproval));
    }
    assert.deepEqual(await rows(), beforeRows);
    assert.deepEqual(await requests(), beforeRequests);
  }));

  for (const action of ['task_close', 'task_successor']) {
    it(`${action}已准备的read计划遇到账本恢复，放权档也必须拒绝转成新写`, async () => scene(async ({ f, org, act, create, rows, requests }) => {
      const source = await create();
      if (action === 'task_successor') await act(closeArgs(source));
      const savedLedger = await readFile(f.layout.taskLog(P), 'utf8');
      const savedRows = await rows();
      const args = action === 'task_close' ? closeArgs(source) : nextArgs(source);
      await act(args);
      const method = action === 'task_close' ? 'close' : 'createSuccessor';
      const execute = org.tasks[method].bind(org.tasks);
      let prepared;
      org.tasks[method] = async (id, spec) => {
        prepared = spec.执行计划;
        // 模拟预览之后、执行之前恢复了较早备份；不能让领域重新准备后自动转写。
        await writeFile(f.layout.taskLog(P), savedLedger, 'utf8');
        return execute(id, spec);
      };
      await assert.rejects(() => act(args), (e) => e instanceof Denied && /准备结果已变化/.test(e.rule));
      assert.equal(prepared.幂等, true);
      assert.equal(prepared.步骤[0].动作, 'read');
      assert.deepEqual(await rows(), savedRows, '旧read计划不可追加closed或successor created');
      assert.deepEqual(await requests(), []);
    }));
  }

  it('无效恢复、继承覆写和模型伪造计划都在审批副作用之前拒绝', async () => scene(async ({ act, create, approval, rows, requests }) => {
    const source = await create();
    await act(closeArgs(source));
    const active = await create({ 描述: '未终止来源' });
    await approval();
    const before = await rows();
    const invalid = [
      { action: 'task_close', id: active.id },
      { ...nextArgs(active) },
      { ...nextArgs(source), 负责人: undefined },
      ...['判据', 'criteria', '依赖', '复核对象', '绑定', '工具文件范围', '判据冻结', '前序任务', '后继任务', '源快照摘要', '后继规范摘要', '执行计划'].map((key) => ({ ...nextArgs(source), [key]: key === '执行计划' ? { 步骤: [] } : [] })),
    ];
    for (const args of invalid) await assert.rejects(() => act(args), (e) => (e instanceof Denied || e instanceof InvalidBody) && !(e instanceof NeedsApproval), JSON.stringify(args));
    assert.deepEqual(await rows(), before);
    assert.deepEqual(await requests(), []);
  }));

  it('成员、复核员和role自报不能借恢复越权，也不能将旧会审转为新任务', async () => scene(async ({ f, org, act, create, approval, rows, requests }) => {
    const source = await create();
    await act(closeArgs(source));
    const active = await create({ 描述: '待关闭节点' });
    const legacy = await seedLegacyIndependentCouncil(f, { 项目: P, id: 'task-recovery-legacy' });
    await approval();
    const before = await rows();
    for (const subject of [MEMBER, REVIEWER]) {
      for (const args of [closeArgs(active), nextArgs(source), { ...closeArgs(active), role: '主权者' }, { ...nextArgs(source), role: 'Lead' }]) {
        await assert.rejects(() => act(args, subject), (e) => e instanceof Denied || (args.role === '主权者' && e instanceof InvalidBody));
      }
    }
    for (const action of ['task_close', 'task_successor']) await assert.rejects(
      () => act({ action, id: legacy, ...(action === 'task_successor' ? { 负责人: '插件工程' } : {}), 原因: '禁止改历史' }),
      (e) => e instanceof Denied && /旧会审.*只读|只读历史/.test(e.rule),
    );
    assert.deepEqual(await rows(), before);
    assert.deepEqual(await requests(), []);
    assert.equal((await org.tasks.get(legacy, { 项目: P })).状态, '已派发');
  }));

  it('普通task_create不能伪造正式恢复关系，即使字段来自命令而非工具schema', async () => scene(async ({ act, approval, rows, requests }) => {
    await approval();
    for (const key of ['前序任务', '后继任务', '后继原因', '源快照摘要', '终止源快照摘要', '规范摘要', '后继规范摘要']) await assert.rejects(
      () => act({ action: 'task_create', 描述: '伪后继', 负责人: '插件工程', 判据: ['x'], [key]: 'forged' }),
      (e) => e instanceof InvalidBody && /task_successor/.test(e.message),
    );
    assert.deepEqual(await rows(), []);
    assert.deepEqual(await requests(), []);
  }));

  for (const action of ['task_create', 'task_close', 'task_successor']) {
    it(`批准${action}成功但完成记账失败：保留嵌套节点id，零重复业务提交`, async () => scene(async ({ org, act, create, approval, rows, approve }) => {
      const source = await create();
      if (action === 'task_successor') await act(closeArgs(source));
      await approval();
      const args = action === 'task_create' ? { action, 描述: '审批嵌套回执', 负责人: '插件工程', 判据: ['x'] }
        : action === 'task_close' ? closeArgs(source) : nextArgs(source);
      const requestId = await approve(args);
      let failed = 0;
      org.intervention.记完成 = async () => { throw new Error('completion-audit-down'); };
      org.intervention.记失败 = async () => { failed += 1; };
      let error;
      try { await act({ ...args, 审批引用: requestId }); } catch (e) { error = e; }
      assert.ok(error instanceof Fault);
      assert.equal(error.code, 'APPROVAL_COMPLETION_AUDIT_FAILED');
      const publicError = describeFailure(error);
      assert.equal(publicError.提交状态, '已提交');
      assert.equal(publicError.可重试, false);
      assert.equal(failed, 0, '业务成功后不得误记业务失败');
      const all = await rows();
      const row = action === 'task_close' ? all.find((row) => row.kind === 'closed' && row.id === source.id)
        : all.findLast((row) => row.kind === 'created' && (action === 'task_create' ? row.描述 === args.描述 : row.前序任务 === source.id));
      assert.ok(row?.id);
      assert.ok(publicError.已确认阶段.some((stage) => stage.任务 === row.id), '公开回执保留真实node.id，不要求用户猜哪单成功');
      if (action === 'task_successor') assert.ok(publicError.已确认阶段.some((stage) => stage.任务 === source.id), '保留后继对应源任务');
      assert.equal(all.filter((candidate) => candidate.kind === row.kind && candidate.id === row.id).length, 1);
      await assert.rejects(() => act({ ...args, 审批引用: requestId }), (e) => e instanceof Denied);
      assert.deepEqual(await rows(), all);
    }));
  }
});

it('真实apply的工具和命令共享恢复入口、写动作schema与身份闸', async () => {
  const f = await makeFixture();
  const cwd = join(f.home, P);
  await mkdir(cwd, { recursive: true });
  const host = fakeHost();
  try {
    const config = { home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P, projectBindings: [{ path: cwd, project: P }] };
    await kernel.apply(host.ctx, config);
    const org = await shareOrg(config);
    const tool = host.工具.get('mind');
    const command = host.命令.get('mind');
    const agent = { session: { id: 'lead', header: { cwd } } };
    const exec = { name: 'mind', agent, signal: new AbortController().signal };
    for (const action of ['task_close', 'task_successor']) {
      assert.ok(ACTIONS.includes(action));
      assert.ok(tool.parameters.properties.action.enum.includes(action));
      assert.equal(READ_ONLY_ACTIONS.includes(action), false);
      assert.equal(tool.isConcurrencySafe({ action }), false);
    }
    const created = JSON.parse(await tool.execute({ action: 'task_create', 描述: '宿主恢复来源', 负责人: '插件工程', 判据: '边界不丢,可验收' }, exec));
    assert.equal(created.成功, true, JSON.stringify(created));
    const source = created.节点;
    const closed = JSON.parse(await tool.execute(closeArgs(source), exec));
    assert.equal(closed.成功, true, JSON.stringify(closed));
    assert.equal(closed.宿主停止状态, '未确认');
    const result = JSON.parse((await command.handler({ agent, rawInput: `task_successor ${JSON.stringify(nextArgs(source))}` })).text);
    assert.equal(result.成功, true, JSON.stringify(result));
    assert.equal(result.节点.前序任务, source.id);
    assert.deepEqual(result.节点.判据, ['边界不丢', '可验收']);
    const repeat = JSON.parse(await tool.execute(nextArgs(source), exec));
    assert.equal(repeat.成功, true, JSON.stringify(repeat));
    assert.equal(repeat.幂等, true);
    assert.equal(repeat.节点.id, result.节点.id);
    const badCommand = JSON.parse((await command.handler({ agent, rawInput: `task_successor ${JSON.stringify({ ...nextArgs(source), 判据: '伪覆盖' })}` })).text);
    assert.equal(badCommand.成功, false);
    const child = { name: 'mind', agent: { session: { id: 'member-a', header: { origin: 'subagent', parentSession: 'lead', cwd } } } };
    const forged = JSON.parse(await tool.execute({ ...nextArgs(source), role: 'Lead' }, child));
    assert.equal(forged.成功, false);
    assert.equal(forged.结果, '拒绝');
    assert.equal((await org.tasks.list({ 项目: P })).length, 2);
  } finally { host.清理(); await f.cleanup(); }
});

it('工具与命令的多人CSV都存为精确实例；等价数组和领域CSV只读认回同一后继', async () => {
  const f = await makeFixture();
  const cwd = join(f.home, P);
  await mkdir(cwd, { recursive: true });
  const host = fakeHost();
  try {
    const config = { home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P, projectBindings: [{ path: cwd, project: P }] };
    await kernel.apply(host.ctx, config);
    const org = await shareOrg(config);
    const agent = { session: { id: 'lead', header: { cwd } } };
    const exec = { name: 'mind', agent, signal: new AbortController().signal };
    const tool = host.工具.get('mind');
    const command = host.命令.get('mind');
    for (const surface of ['tool', 'command']) {
      const source = await org.tasks.create({ subject: LEAD, 项目: P, 描述: `多人CSV-${surface}`, 负责人: '插件工程', 判据: ['按精确实例安排'] });
      await org.tasks.close(source.id, { subject: LEAD, 项目: P, 原因: CLOSE_REASON });
      const args = { ...nextArgs(source), 负责人: 'member-a,member-b' };
      const first = JSON.parse(surface === 'tool'
        ? await tool.execute(args, exec)
        : (await command.handler({ agent, rawInput: `task_successor id=${source.id} 负责人=member-a,member-b 原因=${NEXT_REASON}` })).text);
      assert.equal(first.成功, true, JSON.stringify(first));
      assert.deepEqual(first.节点.负责人, ['member-a', 'member-b']);
      const before = await readTaskLedger(f.layout.taskLog(P));
      const audit = await org.audit.read({});
      const spec = { subject: LEAD, 项目: P, 负责人: ['member-b', 'member-a', 'member-a'], 原因: NEXT_REASON };
      const recovered = await org.tasks.createSuccessor(source.id, spec);
      assert.equal(recovered.幂等, true);
      assert.equal(recovered.节点.id, first.节点.id);
      assert.deepEqual(recovered.节点.负责人, ['member-a', 'member-b']);
      const csv = await org.tasks.createSuccessor(source.id, { ...spec, 负责人: ' member-b，member-a ' });
      assert.equal(csv.幂等, true, '领域本身也消费相同CSV规范，不依赖工具入口先拆分');
      assert.equal(csv.节点.id, first.节点.id);
      assert.deepEqual(await readTaskLedger(f.layout.taskLog(P)), before);
      assert.deepEqual(await org.audit.read({}), audit);
    }
  } finally { host.清理(); await f.cleanup(); }
});

it('Org.open同home重新装配后按账本重建关闭与后继，审批档只读认回保留已推进进度', async () => scene(async ({ f, org, act, create, approval, rows }) => {
  const source = await create({ 描述: '重装配恢复源' });
  await act(closeArgs(source));
  const next = (await act(nextArgs(source))).节点;
  await org.tasks.reassign(next.id, { subject: LEAD, 项目: P, 负责人: MEMBER.id });
  await org.tasks.bind(next.id, { subject: LEAD, 项目: P, 实例: MEMBER.id, 岗位: MEMBER.roleId });
  await org.tasks.dispatch(next.id, { subject: LEAD, 项目: P });
  await org.tasks.start(next.id, { subject: MEMBER, 项目: P });
  await org.tasks.submit(next.id, { subject: MEMBER, 项目: P, 结论: '已推进的后继交卷' });
  await approval();
  const sourceBefore = await org.tasks.get(source.id, { 项目: P });
  const nextBefore = await org.tasks.get(next.id, { 项目: P });
  const eventsBefore = await rows();
  const recoveryAudit = (audit) => audit.filter((row) => [source.id, next.id].includes(row.对象?.id) && ['closed', 'created'].includes(row.结果));
  const auditBefore = recoveryAudit(await org.audit.read({}));
  const fresh = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
  assert.notEqual(fresh, org, '必须真实重新装配，不能取shareOrg缓存');
  assert.notEqual(fresh.tasks, org.tasks);
  assert.deepEqual(await fresh.tasks.get(source.id, { 项目: P }), sourceBefore);
  assert.deepEqual(await fresh.tasks.get(next.id, { 项目: P }), nextBefore);
  assert.deepEqual(await readTaskLedger(f.layout.taskLog(P)), eventsBefore);
  assert.deepEqual(recoveryAudit(await fresh.audit.read({})), auditBefore, '重新引导可记录进程装配，不能重复业务审计');
  const auditAfterBoot = await fresh.audit.read({});
  const readback = (args) => runAction({ org: fresh, 项目: P, 主体: LEAD, subject: LEAD, 面: 'tool', args });
  const closed = await readback(closeArgs(source));
  const successor = await readback(nextArgs(source));
  assert.equal(closed.幂等, true);
  assert.equal(successor.幂等, true);
  assert.equal(successor.节点.id, next.id);
  assert.equal(successor.节点.状态, '已交卷');
  assert.deepEqual(successor.节点.负责人, [MEMBER.id], '认回创建事实不会覆盖之后合法改派');
  assert.equal(successor.节点.独立答案[0].结论, '已推进的后继交卷');
  assert.deepEqual(closed.节点, sourceBefore);
  assert.deepEqual(successor.节点, nextBefore);
  assert.deepEqual(await readTaskLedger(f.layout.taskLog(P)), eventsBefore);
  assert.deepEqual(await fresh.audit.read({}), auditAfterBoot, '只读认回不追加任务事件或审计');
  assert.deepEqual(await fresh.intervention.投影({ 项目: P }), [], '审批档也不为已提交事实重新申请');
}));
