import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeFixture, LEAD, MEMBER, SOVEREIGN, writeUnder } from './helpers.mjs';
import { Org } from '../src/org.js';
import { runAction } from '../lib/actions.js';
import { normalizeDemandUnderstanding } from '../src/demand-understanding.js';
import { readGoalLedger, foldGoalLedger } from '../src/goal-ledger.js';
import { recallWorkContext, WORK_CONTEXT_BUDGET } from '../src/work-context.js';
import { injectWorkContext, WORK_CONTEXT_SECTION } from '../components/kernel/lib/work-context.js';
import { fakeHost } from './host-harness.mjs';
import * as kernel from '../components/kernel/lib/index.js';

const P = 'demand-work-context';
const config = f => ({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
const understanding = (extra = {}) => ({ 原始表达: '这个页面用着不舒服', 当前理解: '先检查层级、重复信息与操作打断', 来源: '用户本轮表达与Lead现场观察，尚未核验', 待验证: ['信息重复可能影响阅读'], 关键问题: [], 分工: [
  { 岗位: '插件工程', 工作: '检查交互路径并提供小样例', 理由: '需要专业核查状态与交互' },
  { 岗位: '文档整理', 工作: '检查文案与信息层级', 理由: '需要清晰的内容结构' },
], ...extra });
async function scene(run, options = {}) {
  const f = await makeFixture(options);
  const card = await readFile(join(f.factoryRoot, '集体L3-成员角色卡/插件工程.md'), 'utf8');
  await writeUnder(f.factoryRoot, '集体L3-成员角色卡/文档整理.md', card.replaceAll('插件工程', '文档整理'));
  try { await run(await Org.open(config(f)), f); } finally { await f.cleanup(); }
}
const create = (org, extra = {}) => org.goals.create({ subject: LEAD, 项目: P, 期望结果: '让页面易读且操作清楚', 来源: '用户表达的转述', 完成依据: ['操作路径清楚', '信息层级清楚'], 约束: ['保留现有数据'], 下一步: '先检查当前页面并给小样例', 需求理解: understanding(), ...extra });
const recall = (org, subject = LEAD, project = P) => recallWorkContext({ org, subject, project });
const act = (org, args, subject = LEAD) => runAction({ org, 主体: subject, 项目: P, args });
const base = () => ({ sections: [{ name: 'host:rules', text: '宿主规则' }], tools: [] });
const agent = (id = 'lead', child = false) => ({ session: { id, header: { cwd: process.cwd(), ...(child ? { origin: 'subagent', delegationDepth: 1 } : {}) } } });
const frame = out => JSON.parse(out.sections.find(s => s.name === WORK_CONTEXT_SECTION).text.split('\n').at(-1));
async function bindTask(org, role, id, description) {
  await org.registry.assign({ subject: LEAD, 岗位: role, 实例: id });
  const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: description, 负责人: [role], 判据: [description] });
  await org.tasks.bind(node.id, { subject: LEAD, 项目: P, 实例: id, 岗位: role });
  await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
  await org.tasks.start(node.id, { subject: { id, kind: '成员', roleId: role }, 项目: P });
  return node;
}

it('可修正理解真实持久化，新会话接续当前解释，不把修正当作改写目标或用户认证', async () => scene(async (org, f) => {
  let goal = await create(org);
  const original = goal;
  const corrected = understanding({ 当前理解: '用户主要不满信息重复，先精简文案', 待验证: [], 关键问题: ['是否需要保留详细诊断入口？'] });
  goal = (await act(org, { action: 'goal_progress', id: goal.id, 修订: goal.修订, 状态: '进行中', 需求理解: corrected, 下一步: '先提供一个精简版本' })).目标;
  const reopened = await Org.open(config(f));
  const current = await reopened.goals.get(goal.id, { subject: LEAD, 项目: P });
  assert.deepEqual(current.需求理解, corrected);
  assert.equal(current.理解修订, 2);
  assert.equal(current.期望结果, original.期望结果);
  assert.deepEqual(current.约束, original.约束);
  assert.deepEqual(current.完成依据, original.完成依据);
  assert.equal(current.来源声明.用户意图, '未核验');
  const result = await recall(reopened);
  assert.equal(result.资料[0].需求理解.当前理解.文本, corrected.当前理解);
  assert.doesNotMatch(JSON.stringify(result), /先检查层级、重复信息与操作打断/);
  const history = await readGoalLedger(f.layout.goalLog(P));
  assert.equal(history[0].需求理解.当前理解, original.需求理解.当前理解);
}));

it('两个专业只收到本任务冻结简报，Lead保留需求、分工理由和关联交付进展', async () => scene(async org => {
  let goal = await create(org);
  const engineering = await bindTask(org, '插件工程', 'engineer', 'engineering-only-brief');
  const writing = await bindTask(org, '文档整理', 'writer', 'writing-only-brief');
  for (const node of [engineering, writing]) goal = await org.goals.linkTask(goal.id, { subject: LEAD, 项目: P, 修订: goal.修订, 任务: node.id });
  for (const [id, own, other] of [['engineer', engineering, writing], ['writer', writing, engineering]]) {
    const result = await recall(org, { id, kind: '成员' });
    assert.deepEqual(result.资料.map(item => item.id), [own.id]);
    assert.deepEqual(result.资料[0].判据.map(item => item.文本), own.判据);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(`${other.id}|需求理解|分工|原始表达|这个页面`));
  }
  const result = await recall(org);
  assert.deepEqual(result.资料[0].交付进展.关联任务, 2);
  assert.ok(result.可咨询岗位.includes('插件工程') && result.可咨询岗位.includes('文档整理'));
  assert.equal(result.资料[0].需求理解.分工.length, 2);
  assert.equal(result.资料[0].交付进展.合法采纳, 0);
}));

it('任务已采纳仍不等于目标完成，整体核对须精确覆盖原依据并绑定真实证据', async () => scene(async org => {
  let goal = await create(org);
  const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '综合交付', 负责人: [LEAD.id], 判据: ['产物可复验'] });
  goal = await org.goals.linkTask(goal.id, { subject: LEAD, 项目: P, 修订: goal.修订, 任务: node.id });
  await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
  await org.tasks.start(node.id, { subject: LEAD, 项目: P });
  await org.tasks.submit(node.id, { subject: LEAD, 项目: P, 结论: '综合交付已有证据' });
  const vote = await org.tasks.review(node.id, { subject: SOVEREIGN, 项目: P, 三态: '过' });
  await org.tasks.accept(node.id, { subject: LEAD, 项目: P, 票: vote.待采纳.票 });
  const before = await recall(org);
  assert.equal(before.资料[0].交付进展.合法采纳, 1);
  assert.equal(before.资料[0].状态, '进行中');
  const spec = { subject: LEAD, 项目: P, 修订: goal.修订, 说明: '基于交付逐条核对整体目标', 证据: [node.id] };
  await assert.rejects(org.goals.complete(goal.id, { ...spec, 完成核对: [{ 依据: goal.完成依据[0], 任务: [node.id] }] }), /精确覆盖/);
  const done = await org.goals.complete(goal.id, { ...spec, 完成核对: goal.完成依据.map(依据 => ({ 依据, 任务: [node.id] })) });
  assert.equal(done.完成判断.机器证明目标语义, false);
  assert.deepEqual((await recall(org)).资料, []);
}));

it('旧目标兼容且不补猜测；修订约束后旧解释退出，进展省略声明则保留当前解释', async () => scene(async org => {
  let goal = await create(org, { 需求理解: undefined });
  assert.equal(Object.hasOwn(goal, '需求理解'), false);
  goal = await org.goals.progress(goal.id, { subject: LEAD, 项目: P, 修订: goal.修订, 状态: '进行中', 需求理解: understanding() });
  goal = await org.goals.progress(goal.id, { subject: LEAD, 项目: P, 修订: goal.修订, 状态: '进行中' });
  assert.ok(goal.需求理解);
  goal = await org.goals.revise(goal.id, { subject: LEAD, 项目: P, 修订: goal.修订, 约束: ['保留现有数据', '先只读调查'], 来源: '新增当前限制' });
  assert.equal(Object.hasOwn(goal, '需求理解'), false);
  assert.equal((await recall(org)).资料[0].需求理解, null);
  await assert.rejects(org.goals.progress(goal.id, { subject: LEAD, 项目: P, 修订: 1, 状态: '进行中', 需求理解: understanding() }), /当前修订/);
}));

it('错误理解声明、伪认证、错误动作均拒绝，坏已存事件不能回落旧理解', async () => scene(async (org, f) => {
  const goal = await create(org);
  const before = await readFile(f.layout.goalLog(P), 'utf8');
  const invalid = [null, [], {}, understanding({ 已核验: true }), understanding({ 来源: '' }), understanding({ 当前理解: 'x'.repeat(1001) }), understanding({ 待验证: Array(7).fill('x') }), understanding({ 关键问题: Array(4).fill('x') }), understanding({ 分工: [{ 岗位: '插件工程', 工作: 'x', 理由: 'x', 授权: true }] })];
  for (const 需求理解 of invalid) {
    assert.throws(() => normalizeDemandUnderstanding(需求理解));
    await assert.rejects(act(org, { action: 'goal_progress', id: goal.id, 修订: goal.修订, 状态: '进行中', 需求理解 }));
  }
  await assert.rejects(act(org, { action: 'task_create', 描述: 'x', 需求理解: understanding() }));
  await assert.rejects(act(org, { action: 'goal_query', id: goal.id, 需求理解: understanding() }));
  assert.equal(await readFile(f.layout.goalLog(P), 'utf8'), before);
  const rows = await readGoalLedger(f.layout.goalLog(P));
  rows[0].需求理解.已核验 = true;
  assert.throws(() => foldGoalLedger(rows), /需求理解不可判/);
  await writeFile(f.layout.goalLog(P), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const input = { ...base(), sections: [...base().sections, { name: WORK_CONTEXT_SECTION, text: 'old-interpretation' }] };
  const result = await injectWorkContext(input, { agent: agent(), org, projectOf: () => P });
  assert.deepEqual(result.sections, base().sections);
}));

it('理解不能代替身份、目标状态或原权限；未登记、冒报、封存与无绑定成员不取得工作资料', async () => scene(async org => {
  let goal = await create(org);
  for (const subject of [MEMBER, { id: MEMBER.id, kind: 'Lead' }, { id: 'ghost', kind: 'Lead' }]) {
    await assert.rejects(org.goals.contextSnapshot({ subject, 项目: P }));
    await assert.rejects(org.goals.progress(goal.id, { subject, 项目: P, 修订: goal.修订, 状态: '进行中', 需求理解: understanding() }));
  }
  assert.deepEqual((await recall(org, MEMBER)).资料, []);
  await assert.rejects(recall(org, { id: MEMBER.id, kind: '成员', roleId: 'Lead' }));
  goal = await org.goals.setState(goal.id, { subject: SOVEREIGN, 项目: P, 修订: goal.修订, 状态: '暂停' });
  await assert.rejects(org.goals.progress(goal.id, { subject: LEAD, 项目: P, 修订: goal.修订, 状态: '进行中', 需求理解: understanding() }), /暂停/);
  assert.equal((await recall(org)).资料[0].状态, '暂停');
  await org.registry.seal({ subject: SOVEREIGN, 实例: LEAD.id, 理由: '撤回Lead' });
  await assert.rejects(recall(org));
}));

it('未收尾目标先过滤再限量，其他项目与较新的已取消目标不挤掉正确工作', async () => scene(async org => {
  const own = await create(org, { 请求键: 'active' });
  for (let i = 0; i < 8; i++) {
    const closed = await create(org, { 请求键: `closed-${i}`, 期望结果: `closed-secret-${i}` });
    await org.goals.setState(closed.id, { subject: SOVEREIGN, 项目: P, 修订: closed.修订, 状态: '取消' });
  }
  await create(org, { 项目: 'other-project', 期望结果: 'foreign-secret' });
  const out = await recall(org);
  assert.deepEqual(out.资料.map(item => item.id), [own.id]);
  assert.doesNotMatch(JSON.stringify(out), /closed-secret|foreign-secret/);
}));

it('装配期间理解、任务事实或身份改变时丢弃旧帧；读取故障仅报类型', async () => scene(async org => {
  let goal = await create(org);
  const original = org.goals.contextSnapshot.bind(org.goals);
  let first = true;
  org.goals.contextSnapshot = async args => { const result = await original(args); if (first) { first = false; goal = await org.goals.progress(goal.id, { subject: LEAD, 项目: P, 修订: goal.修订, 状态: '进行中', 需求理解: understanding({ 当前理解: 'new-interpretation' }) }); } return result; };
  const input = { ...base(), sections: [...base().sections, { name: WORK_CONTEXT_SECTION, text: 'old-interpretation' }] };
  const out = await injectWorkContext(input, { agent: agent(), org, projectOf: () => P });
  assert.deepEqual(out.sections, base().sections);
  org.goals.contextSnapshot = original;
  const node = await bindTask(org, '插件工程', 'engineer', 'private-current-task');
  const list = org.tasks.list.bind(org.tasks); first = true;
  org.tasks.list = async spec => { const result = await list(spec); if (first) { first = false; await org.tasks.submit(node.id, { subject: { id: 'engineer', kind: '成员', roleId: '插件工程' }, 项目: P, 结论: '已交卷' }); } return result; };
  assert.deepEqual((await injectWorkContext(input, { agent: agent('engineer', true), org, projectOf: () => P })).sections, base().sections);
  org.tasks.list = list;
  org.goals.contextSnapshot = async () => { throw new Error('private-error-details'); };
  const warnings = [];
  assert.deepEqual((await injectWorkContext(input, { agent: agent(), org, projectOf: () => P, logger: { warn: msg => warnings.push(msg) } })).sections, base().sections);
  assert.doesNotMatch(warnings.join(''), /private-error-details/);
}));

it('工作摘要总量有界、详情省略可见，任务结束后旧简报退出装配', async () => scene(async org => {
  for (let i = 0; i < 5; i++) await create(org, { 请求键: `big-${i}`, 期望结果: '望'.repeat(4000), 完成依据: Array.from({ length: 12 }, (_, j) => `${j}${'据'.repeat(900)}`), 需求理解: understanding({ 当前理解: '解'.repeat(1000), 待验证: Array(6).fill('验'.repeat(240)), 分工: Array(6).fill({ 岗位: '岗'.repeat(80), 工作: '工'.repeat(500), 理由: '理'.repeat(240) }) }) });
  const out = await recall(org);
  assert.ok(out.资料.length > 0 && out.资料.length <= 3);
  assert.ok(JSON.stringify(out).length <= WORK_CONTEXT_BUDGET);
  assert.equal(out.截断, true);
  assert.equal(out.资料[0].期望结果.省略, true);
  assert.equal(out.资料[0].需求理解.省略, true);
  const node = await bindTask(org, '插件工程', 'engineer', 'ephemeral-task');
  const first = await injectWorkContext(base(), { agent: agent('engineer', true), org, projectOf: () => P });
  assert.equal(frame(first).资料[0].id, node.id);
  await org.tasks.submit(node.id, { subject: { id: 'engineer', kind: '成员', roleId: '插件工程' }, 项目: P, 结论: '完成当前工作' });
  assert.deepEqual((await injectWorkContext(first, { agent: agent('engineer', true), org, projectOf: () => P })).sections, base().sections);
}));

it('异步装配中切换项目或会话、卸载、撤回Lead身份，不带入旧工作资料', async () => scene(async org => {
  await create(org);
  const original = org.goals.contextSnapshot.bind(org.goals);
  for (const change of ['project', 'session', 'unload', 'seal']) {
    const a = agent(); let project = P; let active = true; let first = true;
    org.goals.contextSnapshot = async args => {
      const out = await original(args);
      if (first) {
        first = false;
        if (change === 'project') project = 'other';
        if (change === 'session') a.session.id = 'different-root';
        if (change === 'unload') active = false;
        if (change === 'seal') await org.registry.seal({ subject: SOVEREIGN, 实例: LEAD.id, 理由: '装配期间撤回' });
      }
      return out;
    };
    const input = base();
    assert.equal(await injectWorkContext(input, { agent: a, org, projectOf: () => project, active: () => active }), input);
  }
}));

it('审批冻结理解全文和分工理由，批准后不能偷换解释与范围', async () => scene(async org => {
  const args = { action: 'goal_create', 期望结果: '改善阅读体验', 来源: '用户本轮表达', 完成依据: ['层级清楚'], 下一步: '只读调查', 需求理解: understanding() };
  await assert.rejects(act(org, args));
  const requests = await org.intervention.投影({ 项目: P });
  const id = requests[0].请求id;
  const frozen = await org.intervention.读冻结({ 请求id: id, subject: LEAD });
  assert.deepEqual(frozen.入参.需求理解, args.需求理解);
  assert.deepEqual(frozen.步骤[0].预览.需求理解, args.需求理解);
  await org.intervention.人侧决议({ 请求id: id, 决定: '批准', 通道: '设置页', 认证: '宿主 Connection 已认证（同源浏览器设置入口）' });
  await assert.rejects(act(org, { ...args, 审批引用: id, 需求理解: understanding({ 当前理解: '偷换' }) }));
  assert.deepEqual((await act(org, { ...args, 审批引用: id })).目标.需求理解, args.需求理解);
}, { defaults: { 介入度: '审批' } }));

it('真实工具和命令写入理解，内核装配自动带入并在卸载或切换项目时移除旧帧', async () => scene(async (org, f) => {
  const host = fakeHost();
  try {
    await kernel.apply(host.ctx, { ...config(f), projectBindings: [{ path: process.cwd(), project: P }] });
    const a = agent(); const exec = { agent: a, name: 'mind', signal: new AbortController().signal };
    const tool = host.工具.get('mind');
    assert.equal(tool.parameters.properties.需求理解.additionalProperties, false);
    const result = JSON.parse(await tool.execute({ action: 'goal_create', 期望结果: '页面易用', 来源: '用户表示不满意', 完成依据: ['层级清楚'], 下一步: '先调查', 需求理解: understanding() }, exec));
    assert.equal(result.成功, true, JSON.stringify(result));
    const cmd = host.命令.get('mind');
    const corrected = understanding({ 当前理解: 'command-corrected-interpretation' });
    const revised = JSON.parse((await cmd.handler({ agent: a, rawInput: `goal_progress ${JSON.stringify({ id: result.目标.id, 修订: result.目标.修订, 状态: '进行中', 需求理解: JSON.stringify(corrected) })}` })).text);
    assert.equal(revised.成功, true, JSON.stringify(revised));
    const hook = host.钩子.get('system-prompt/assemble').at(-1);
    const input = base(); const assembled = await hook(input, { agent: a }, async () => input);
    assert.equal(frame(assembled).资料[0].需求理解.当前理解.文本, corrected.当前理解);
    const bad = JSON.parse((await cmd.handler({ agent: a, rawInput: 'goal_progress 需求理解={bad' })).text);
    assert.equal(bad.成功, false);
    assert.match(JSON.stringify(bad), /需求理解/);
    assert.deepEqual((await injectWorkContext(assembled, { agent: a, org, projectOf: () => P, active: () => false })).sections, assembled.sections.filter(s => s.name !== WORK_CONTEXT_SECTION));
    assert.ok(!(await injectWorkContext(assembled, { agent: agent(MEMBER.id, true), org, projectOf: () => 'other' })).sections.some(s => s.name === WORK_CONTEXT_SECTION));
  } finally { host.清理(); }
}));
