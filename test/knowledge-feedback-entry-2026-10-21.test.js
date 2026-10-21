/** 引用真实交卷负反馈进行治理处置，审批计划与执行使用同一服务端见证。 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeFixture, LEAD, MEMBER, REVIEWER, SOVEREIGN } from './helpers.mjs';
import { fakeHost } from './host-harness.mjs';
import { Org } from '../src/org.js';
import { shareOrg } from '../src/runtime.js';
import { readTextOrNull } from '../src/kernel/fsx.js';
import { runAction, ACTIONS, READ_ONLY_ACTIONS } from '../lib/actions.js';
import { 介入计划Of } from '../lib/approval-plan.js';
import { 规范步骤 } from '../src/intervention.js';
import { InvalidBody, Denied, NeedsApproval, Fault } from '../src/kernel/errors.js';
import * as kernel from '../components/kernel/lib/index.js';

const P = 'knowledge-feedback-entry';
const SECRET = 'KNOWLEDGE_PRIVATE_BODY-do-not-put-in-preview';
const NOTE = 'PRIVATE_ADOPTION_REASON-do-not-put-in-preview';
const configFor = f => ({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
const rejectBeforeApproval = error => error instanceof InvalidBody || error instanceof Denied || (error instanceof Fault && error.code === 'TASK_LEDGER_INVALID');
const parse = text => text.trim().split('\n').map(JSON.parse);
const encode = rows => rows.map(JSON.stringify).join('\n') + '\n';
const lifecycle = (item, op = 'invalidate', extra = {}) => ({ action: 'memory_lifecycle', op, id: item.knowledge.id, 原因: '已核对本次负反馈，按治理决定处置', 反馈引用: item.reference, ...extra });

async function feedback(org, f, { result = '发现问题' } = {}) {
  const knowledge = await org.memory.remember({ subject: LEAD, 项目: P, 类: '知识', 岗位: MEMBER.roleId, 内容: SECRET, 来源: '真实入口测试证据', 知识说明: { 复验期限: '2099-12-31T23:59:59Z' } });
  const task = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '真实负反馈任务', 负责人: MEMBER.roleId, 判据: ['核对当前适用性'] });
  await org.tasks.bind(task.id, { subject: LEAD, 项目: P, 实例: MEMBER.id, 岗位: MEMBER.roleId });
  await org.tasks.dispatch(task.id, { subject: LEAD, 项目: P });
  await org.tasks.start(task.id, { subject: MEMBER, 项目: P });
  await runAction({ org, 项目: P, 主体: MEMBER, args: { action: 'task_submit', id: task.id, 结论: '适用性核对完成', 采用知识: [{ id: knowledge.id, 用途: '核对当前边界', 适用判断: NOTE, 使用结果: result }] } });
  const submitted = parse(await readTextOrNull(f.layout.taskLog(P))).findLast(row => row.kind === 'submitted' && row.id === task.id);
  return { knowledge, task, reference: { 任务: task.id, 提交序: submitted.seq } };
}

async function scene(run) {
  const f = await makeFixture();
  try {
    const org = await Org.open(configFor(f));
    const act = (args, subject = LEAD) => runAction({ org, 项目: P, 主体: subject, subject, 面: 'tool', args });
    const log = () => readTextOrNull(f.layout.memoryLog(P, '知识'));
    const requests = () => org.intervention.投影({ 项目: P });
    const approval = async () => {
      await f.write('集体L2-共享基础设施/defaults/介入度.json', JSON.stringify({ 介入度: '审批' }));
      assert.equal(await org.policy.reload(), true);
    };
    const request = async args => {
      let id;
      await assert.rejects(() => act(args), error => error instanceof NeedsApproval && Boolean(id = error.detail.请求id));
      return id;
    };
    const approve = id => org.intervention.人侧决议({ 请求id: id, 决定: '批准', 通道: '设置页', 认证: '宿主 Connection 已认证' });
    await run({ f, org, act, log, requests, approval, request, approve });
  } finally { await f.cleanup(); }
}

describe('知识负反馈生命周期入口', () => {
  it('结构伪造、非支持op及普通成员在审批前拒绝，零请求零业务写', async () => scene(async ({ f, org, act, log, requests, approval }) => {
    const item = await feedback(org, f);
    await approval();
    const before = await log();
    const tasks = await readTextOrNull(f.layout.taskLog(P));
    const pending = await requests();
    for (const 反馈引用 of [null, {}, [], { 任务: '', 提交序: 1 }, { 任务: item.task.id, 提交序: 0 }, { 任务: item.task.id, 提交序: 0.5 }, { 任务: item.task.id, 提交序: Number.MAX_SAFE_INTEGER + 1 },
      ...['hash', 'proof', 'subject', '主体', '处理状态'].map(key => ({ ...item.reference, [key]: 'forged' }))]) {
      await assert.rejects(() => act(lifecycle(item, 'invalidate', { 反馈引用 })), error => error instanceof InvalidBody);
    }
    for (const key of ['反馈执行计划', '执行计划', 'hash', 'proof', '处理状态']) await assert.rejects(() => act(lifecycle(item, 'invalidate', { [key]: 'forged' })), error => error instanceof InvalidBody);
    for (const op of ['promote', 'purge']) await assert.rejects(() => act(lifecycle(item, op)), error => error instanceof InvalidBody);
    for (const subject of [MEMBER, REVIEWER]) await assert.rejects(() => act(lifecycle(item), subject), error => error instanceof Denied);
    assert.equal(await log(), before);
    assert.equal(await readTextOrNull(f.layout.taskLog(P)), tasks);
    assert.deepEqual(await requests(), pending);
  }));

  it('不存在知识/任务、非交卷序号、有帮助和另一知识负反馈均不能生成待批请求', async () => scene(async ({ f, org, act, log, requests, approval }) => {
    const item = await feedback(org, f);
    const positive = await feedback(org, f, { result: '有帮助' });
    const another = await org.memory.remember({ subject: LEAD, 项目: P, 类: '知识', 内容: '另一条知识', 来源: '独立证据' });
    await approval();
    const before = await log();
    const pending = await requests();
    for (const args of [lifecycle(item, 'invalidate', { id: 'know-not-present' }), lifecycle(item, 'invalidate', { id: another.id }), lifecycle(item, 'invalidate', { 反馈引用: { ...item.reference, 任务: 'task-not-present' } }),
      lifecycle(item, 'invalidate', { 反馈引用: { ...item.reference, 提交序: 1 } }), lifecycle(positive)]) await assert.rejects(() => act(args), rejectBeforeApproval);
    assert.equal(await log(), before);
    assert.deepEqual(await requests(), pending);
  }));

  it('全账唯一seq与提交前真实代必须可核，损坏或旧无代交卷不能补造凭据', async () => scene(async ({ f, org, act, log, requests, approval }) => {
    const item = await feedback(org, f);
    await approval();
    const original = await readTextOrNull(f.layout.taskLog(P));
    const before = await log();
    const pending = await requests();
    for (const change of [rows => { delete rows.find(row => row.seq === item.reference.提交序).代; }, rows => { rows.find(row => row.seq === item.reference.提交序).代 = 2; }, rows => { rows.push(structuredClone(rows.find(row => row.seq === item.reference.提交序))); }]) {
      const rows = parse(original);
      change(rows);
      const changed = encode(rows);
      await writeFile(f.layout.taskLog(P), changed, 'utf8');
      await assert.rejects(() => act(lifecycle(item)), rejectBeforeApproval);
      assert.equal(await readTextOrNull(f.layout.taskLog(P)), changed);
      assert.equal(await log(), before);
      assert.deepEqual(await requests(), pending);
    }
  }));

  it('合法批准绑定同源见证，仅消费一次；预览无知识或声明正文，不自动复验完成', async () => scene(async ({ f, org, act, log, requests, approval, request, approve }) => {
    const item = await feedback(org, f);
    const args = lifecycle(item);
    const plan = await 介入计划Of({ org, 项目: P, action: args.action, args, subject: LEAD });
    assert.match(plan.指纹, /^[a-f0-9]{64}$/);
    assert.ok(plan.执行计划);
    assert.equal(plan.步骤.length, 1);
    const preview = JSON.stringify(plan.步骤);
    assert.ok(preview.includes(plan.指纹));
    assert.equal(preview.includes(SECRET), false);
    assert.equal(preview.includes(NOTE), false);
    await approval();
    const before = await log();
    const id = await request(args);
    assert.equal(await log(), before, '等待批准零状态追加');
    const frozen = await org.intervention.读冻结({ 请求id: id, subject: SOVEREIGN });
    assert.deepEqual(frozen.步骤, 规范步骤(plan.步骤));
    await approve(id);
    await act({ ...args, 审批引用: id });
    const after = await log();
    assert.equal(parse(after).length, parse(before).length + 1);
    const disposition = parse(after).findLast(row => row.指向 === item.knowledge.id);
    assert.deepEqual(disposition.反馈关联, { 版本: 1, 指纹: plan.指纹 });
    assert.equal(JSON.stringify(disposition).includes(NOTE), false, '处置只保留服务端关联凭据，不复制声明原文');
    assert.equal((await requests()).find(row => row.请求id === id).状态, '已完成');
    await assert.rejects(() => act({ ...args, 审批引用: id }), error => error instanceof Denied);
    assert.equal(await log(), after, '已消费批准不能重复追加状态');
    const history = (await act({ action: 'memory_query', id: item.knowledge.id, 含失效: true, 含待复验: true })).结果.条目[0];
    assert.equal(history.复验状态, '期限内');
    assert.equal(history.知识说明.复验期限, '2099-12-31T23:59:59Z');
    assert.equal(Object.hasOwn(history, '复验完成'), false);
    assert.equal(Object.hasOwn(history, '已验证'), false);
  }));

  for (const drift of ['knowledge-body', 'adoption']) it(`等待批复期间${drift}变化，旧批准在消费前拒绝且零状态追加`, async () => scene(async ({ f, org, act, log, requests, approval, request, approve }) => {
    const item = await feedback(org, f);
    const args = lifecycle(item);
    await approval();
    const id = await request(args);
    await approve(id);
    if (drift === 'knowledge-body') {
      const rows = parse(await log());
      rows.find(row => row.id === item.knowledge.id && Object.hasOwn(row, '内容')).内容 += '-changed';
      await writeFile(f.layout.memoryLog(P, '知识'), encode(rows), 'utf8');
    } else {
      const rows = parse(await readTextOrNull(f.layout.taskLog(P)));
      rows.find(row => row.seq === item.reference.提交序).采用知识.条目[0].适用判断 += '-changed';
      await writeFile(f.layout.taskLog(P), encode(rows), 'utf8');
    }
    const before = await log();
    await assert.rejects(() => act({ ...args, 审批引用: id }), error => error instanceof Denied);
    assert.equal(await log(), before);
    assert.equal((await requests()).find(row => row.请求id === id).状态, '已批准待重放', '漂移拒绝不抢占或消费旧批准');
  }));

  it('overturn完整write+create一次审批，失败不先落状态；旧无引用生命周期保持可用', async () => scene(async ({ f, org, act, log, approval, request, approve }) => {
    const item = await feedback(org, f);
    const args = lifecycle(item, 'overturn', { 新条目: '核对后的替代知识', 知识说明: { 适用条件: ['当前接口'] } });
    const plan = await 介入计划Of({ org, 项目: P, action: args.action, args, subject: LEAD });
    assert.deepEqual(plan.步骤.map(step => step.动作), ['write', 'create']);
    await approval();
    const before = await log();
    const id = await request(args);
    await approve(id);
    const result = await act({ ...args, 审批引用: id });
    assert.ok(result.结果.新条目);
    assert.equal(parse(await log()).length, parse(before).length + 2, '替代条目和旧状态一起落线');
    const replacement = (await act({ action: 'memory_query', id: result.结果.新条目 })).结果.条目[0];
    assert.deepEqual(replacement.知识说明, { 适用条件: ['当前接口'] });
    await f.write('集体L2-共享基础设施/defaults/介入度.json', JSON.stringify({ 介入度: '放权' }));
    await org.policy.reload();
    const failedItem = await feedback(org, f);
    const failureBefore = await log();
    const remember = org.memory.remember.bind(org.memory);
    org.memory.remember = async spec => { if (spec.派生自 === failedItem.knowledge.id) throw new Error('replacement-write-failed'); return remember(spec); };
    await assert.rejects(() => act(lifecycle(failedItem, 'overturn', { 新条目: '不应留下的替代知识' })), /replacement-write-failed/);
    assert.equal(await log(), failureBefore);
    org.memory.remember = remember;
    await act({ action: 'memory_lifecycle', op: 'demote', id: replacement.id, 原因: '旧无反馈引用路径' });
  }));
});

it('真实tool/command只扩展生命周期参数，严格JSON引用与既有审批写分类一致', async () => {
  const f = await makeFixture();
  const host = fakeHost();
  try {
    const cwd = join(f.home, P);
    await mkdir(cwd, { recursive: true });
    const config = { ...configFor(f), projectBindings: [{ path: cwd, project: P }] };
    await kernel.apply(host.ctx, config);
    const org = await shareOrg(config);
    const tool = host.工具.get('mind');
    const command = host.命令.get('mind');
    const agent = { session: { id: LEAD.id, header: { cwd } } };
    const exec = { name: 'mind', agent, signal: new AbortController().signal };
    const schema = tool.parameters.properties.反馈引用;
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ['任务', '提交序']);
    assert.deepEqual(Object.keys(schema.properties), ['任务', '提交序']);
    assert.equal(schema.properties.任务.maxLength, 256);
    assert.equal(schema.properties.提交序.maximum, Number.MAX_SAFE_INTEGER);
    assert.equal(READ_ONLY_ACTIONS.includes('memory_lifecycle'), false);
    assert.equal(tool.isConcurrencySafe({ action: 'memory_lifecycle' }), false);
    assert.deepEqual(tool.parameters.properties.action.enum, ACTIONS);
    for (const action of ['knowledge_feedback_process', 'knowledge_reverify_complete', 'feedback_record']) assert.equal(ACTIONS.includes(action), false);
    const a = await feedback(org, f);
    const result = JSON.parse(await tool.execute(lifecycle(a, 'demote'), exec));
    assert.equal(result.成功, true, JSON.stringify(result));
    const b = await feedback(org, f);
    const args = lifecycle(b, 'demote');
    delete args.action;
    const response = JSON.parse((await command.handler({ agent, rawInput: `memory_lifecycle ${JSON.stringify({ ...args, 反馈引用: JSON.stringify(args.反馈引用) })}` })).text);
    assert.equal(response.成功, true, JSON.stringify(response));
    const before = await readTextOrNull(f.layout.memoryLog(P, '知识'));
    for (const 反馈引用 of [null, '{bad', { ...b.reference, hash: 'forged' }]) {
      const bad = JSON.parse((await command.handler({ agent, rawInput: `memory_lifecycle ${JSON.stringify({ ...args, 反馈引用 })}` })).text);
      assert.equal(bad.成功, false);
    }
    assert.equal(await readTextOrNull(f.layout.memoryLog(P, '知识')), before);
  } finally { host.清理(); await f.cleanup(); }
});
