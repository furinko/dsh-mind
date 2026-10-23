import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { makeFixture, LEAD, MEMBER, SOVEREIGN } from './helpers.mjs';
import { Org } from '../src/org.js';
import { runAction } from '../lib/actions.js';
import { Denied } from '../src/kernel/errors.js';
import { normalizeCollaborationFeedback, collaborationFeedbackSummary } from '../src/collaboration-feedback.js';
import { recallLeadContext, LEAD_CONTEXT_BUDGET } from '../src/lead-context.js';
import { LEAD_CONTEXT_SECTION } from '../components/kernel/lib/lead-context.js';
import { fakeHost } from './host-harness.mjs';
import * as kernel from '../components/kernel/lib/index.js';

const P = 'collaboration-feedback';
const config = f => ({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
const meta = () => ({ 类别: '协作教训', 主题: '模糊需求先小样例', 依据: '自省', 范围: '部署' });
const ref = goal => ({ 项目: P, 目标: goal.id, 修订: goal.修订 });
const feedback = (goal, extra = {}) => ({ 基线: ref(goal), 反馈: '用户指出过早实现，结果偏离预期', 来源: '用户转述', 原做法: '直接按第一种解释完整实现',
  调整做法: '先说明当前理解，提供一个低成本样例再推进', 适用条件: ['需求表达模糊且尝试成本可控'], 后续案例: [], ...extra });
const caseOf = (goal, extra = {}) => ({ 情境: ref(goal), 采用说明: '先制作小样例核对理解', 观察: '本轮用户表示方向符合预期', 结果声明: '改善', 来源: '用户转述', 依据: '后续会话中的用户反馈转述', ...extra });
async function scene(run, options = {}) {
  const f = await makeFixture(options);
  try { await run(await Org.open(config(f)), f); } finally { await f.cleanup(); }
}
const goal = (org, extra = {}) => org.goals.create({ subject: LEAD, 项目: P, 期望结果: '把页面调整到符合用户期望', 来源: '用户表示页面难用', 完成依据: ['整体符合当前目标'], 下一步: '调查并给小样例', ...extra });
const act = (org, args, subject = LEAD) => runAction({ org, 主体: subject, 项目: P, args });
const args = (value, extra = {}) => ({ action: 'memory_write', 类: '偏好', 内容: '模糊需求先用小样例验证，再投入完整实现。', 来源: '用户纠正与Lead复盘', 连续性: meta(), 协作反馈: value, ...extra });
const remember = async (org, value, extra = {}) => (await act(org, args(value, extra))).条目;
const recall = org => recallLeadContext({ org, subject: LEAD, project: P });
const ledger = f => readFile(f.layout.memoryLog('跨项目', '偏好'), 'utf8').catch(() => '');
const base = () => ({ sections: [{ name: 'host:rules', text: 'host' }], tools: [] });
const agent = (id = 'lead', child = false) => ({ session: { id, header: { cwd: process.cwd(), ...(child ? { origin: 'subagent', delegationDepth: 1 } : {}) } } });

it('用户纠正关联真实基线，调整做法和适用条件跨会话自动进入Lead上下文', async () => scene(async (org, f) => {
  const baseline = await goal(org);
  const record = await remember(org, feedback(baseline));
  const reopened = await Org.open(config(f));
  const result = await recall(reopened);
  const item = result.记录.find(item => item.id === record.id);
  assert.equal(item.协作反馈摘要.调整做法.文本, feedback(baseline).调整做法);
  assert.equal(item.协作反馈摘要.后续案例总数, 0);
  assert.equal(item.协作反馈摘要.最近案例, null);
  assert.match(item.协作反馈摘要.口径, /未认证/);
  const full = (await act(org, { action: 'memory_query', id: record.id, 返回模式: '全文' })).结果.条目[0];
  assert.deepEqual(full.协作反馈, feedback(baseline));
  assert.equal(Object.hasOwn(full, '成长已验证'), false);
}));

it('追加后续案例沿用原替代动作；新理解和复盘可分别更新，原教训不继续装配', async () => scene(async org => {
  const baseline = await goal(org, { 请求键: 'baseline', 需求理解: { 原始表达: '页面不好用', 当前理解: '直接完整改造', 来源: 'Lead初步解释' } });
  const initial = await remember(org, feedback(baseline));
  await org.goals.progress(baseline.id, { subject: LEAD, 项目: P, 修订: baseline.修订, 状态: '进行中', 需求理解: { 原始表达: '用户纠正先给一个样例', 当前理解: '先核对一个局部再扩大', 来源: '用户纠正转述' } });
  const later = await goal(org, { 请求键: 'later' });
  const update = feedback(baseline, { 后续案例: [caseOf(later)] });
  const replacement = (await act(org, { action: 'memory_lifecycle', op: 'overturn', id: initial.id, 原因: '补充后续采用与观察', 新条目: '保留样例优先做法，继续在相似任务中核对', 协作反馈: update })).结果.新条目;
  const items = (await recall(org)).记录;
  assert.ok(!items.some(item => item.id === initial.id));
  assert.equal(items.find(item => item.id === replacement).协作反馈摘要.最近案例.情境.目标, later.id);
  assert.equal(items.find(item => item.id === replacement).协作反馈摘要.最近案例.结果声明, '改善');
  const history = (await act(org, { action: 'memory_query', id: initial.id, 含失效: true, 返回模式: '全文' })).结果.条目[0];
  assert.equal(history.状态, '被推翻');
  assert.equal(history.协作反馈.后续案例.length, 0);
  assert.equal((await org.goals.get(baseline.id, { subject: LEAD, 项目: P })).需求理解.当前理解, '先核对一个局部再扩大');
}));

it('改善、无改善、变差和未知均保留；声明计数不认证结果或独立案例', async () => scene(async org => {
  const baseline = await goal(org, { 请求键: 'base' });
  const cases = [];
  for (const outcome of ['改善', '无改善', '变差', '未知']) {
    const later = await goal(org, { 请求键: outcome });
    cases.push(caseOf(later, { 结果声明: outcome, 来源: outcome === '未知' ? '未知' : '模型观察', 观察: outcome === '未知' ? '尚未取得后续反馈' : `模型记录本轮${outcome}` }));
  }
  const record = await remember(org, feedback(baseline, { 后续案例: cases }));
  const summary = (await recall(org)).记录.find(item => item.id === record.id).协作反馈摘要;
  assert.deepEqual(summary.结果声明计数, { 改善: 1, 无改善: 1, 变差: 1, 未知: 1 });
  assert.equal(summary.最近案例.来源, '未知');
  assert.equal(summary.最近案例.结果声明, '未知');
  assert.equal(summary.案例省略, true);
  assert.equal(summary.后续案例总数, 4);
  assert.match(summary.口径, /有界案例/);
}));

it('目标引用必须真实可读且修订已存在，跨项目引用按原读权核对，错误不留部分记忆', async () => scene(async (org, f) => {
  const baseline = await goal(org);
  const before = await ledger(f);
  for (const wrong of [{ ...ref(baseline), 目标: 'goal-nonexistent' }, { ...ref(baseline), 修订: baseline.修订 + 1 }, { ...ref(baseline), 项目: 'different-project' }]) {
    await assert.rejects(remember(org, feedback(baseline, { 基线: wrong })), /不存在/);
  }
  assert.equal(await ledger(f), before);
  const foreign = await goal(org, { 项目: 'different-project' });
  const good = feedback(baseline, { 后续案例: [caseOf(foreign, { 情境: { ...ref(foreign), 项目: 'different-project' } })] });
  const record = await remember(org, good);
  const get = org.goals.get.bind(org.goals);
  org.goals.get = async (id, spec) => { if (spec.项目 === 'different-project') throw new Denied('源读权撤回', '当前不可读'); return get(id, spec); };
  const beforeBadReplacement = await ledger(f);
  await assert.rejects(act(org, { action: 'memory_lifecycle', op: 'overturn', id: record.id, 原因: '重核', 新条目: 'x', 协作反馈: good }), /当前不可读/);
  assert.equal(await ledger(f), beforeBadReplacement);
}));

it('已完成目标仍可接收复盘，不恢复目标或篡改原采纳证据', async () => scene(async org => {
  let baseline = await goal(org);
  const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '交付', 负责人: [LEAD.id], 判据: ['交付可核对'] });
  baseline = await org.goals.linkTask(baseline.id, { subject: LEAD, 项目: P, 修订: baseline.修订, 任务: node.id });
  await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
  await org.tasks.start(node.id, { subject: LEAD, 项目: P });
  await org.tasks.submit(node.id, { subject: LEAD, 项目: P, 结论: '有真实交付' });
  const vote = await org.tasks.review(node.id, { subject: SOVEREIGN, 项目: P, 三态: '过' });
  await org.tasks.accept(node.id, { subject: LEAD, 项目: P, 票: vote.待采纳.票 });
  const done = await org.goals.complete(baseline.id, { subject: LEAD, 项目: P, 修订: baseline.修订, 说明: '逐条核对', 证据: [node.id], 完成核对: baseline.完成依据.map(依据 => ({ 依据, 任务: [node.id] })) });
  await remember(org, feedback(done));
  assert.deepEqual(await org.goals.get(done.id, { subject: LEAD, 项目: P }), done);
}));

it('错误形状、伪认证、重复或倒序案例、错误类别与错误动作都不能写入', async () => scene(async (org, f) => {
  const baseline = await goal(org);
  const good = feedback(baseline);
  const bad = [null, {}, [], { ...good, 已验证: true }, { ...good, 反馈: '' }, { ...good, 来源: '用户认证' }, { ...good, 调整做法: 'x'.repeat(1001) }, { ...good, 适用条件: [] },
    { ...good, 后续案例: [caseOf(baseline)] }, { ...good, 后续案例: [caseOf(baseline, { 情境: { ...ref(baseline), 修订: 2 }, 结果声明: '成功率100%' })] },
    { ...good, 后续案例: Array(7).fill(caseOf(baseline)) }, { ...good, 后续案例: Array(2).fill(caseOf(baseline, { 情境: { ...ref(baseline), 修订: 2 } })) }];
  const before = await ledger(f);
  for (const 协作反馈 of bad) { assert.throws(() => normalizeCollaborationFeedback(协作反馈)); await assert.rejects(remember(org, 协作反馈)); }
  await assert.rejects(remember(org, good, { 类: '经历' }));
  await assert.rejects(remember(org, good, { 连续性: { ...meta(), 类别: '人格' } }));
  await assert.rejects(act(org, { action: 'memory_query', 协作反馈: good }));
  await assert.rejects(act(org, { action: 'memory_lifecycle', op: 'invalidate', id: 'pref-fake', 协作反馈: good }));
  await assert.rejects(act(org, { action: 'memory_lifecycle', op: 'overturn', id: 'know-fake', 新条目: 'x', 协作反馈: good, 反馈引用: { 任务: 'task-x', 提交序: 1 } }));
  assert.equal(await ledger(f), before);
}));

it('同目标较晚修订可记录迭代，但不会冒充不同任务独立验证', async () => scene(async org => {
  const baseline = await goal(org);
  const later = await org.goals.progress(baseline.id, { subject: LEAD, 项目: P, 修订: baseline.修订, 状态: '进行中', 下一步: '按纠正后的理解给样例' });
  const record = await remember(org, feedback(baseline, { 后续案例: [caseOf(later)] }));
  const summary = (await recall(org)).记录.find(item => item.id === record.id).协作反馈摘要;
  assert.equal(summary.基线.目标, summary.最近案例.情境.目标);
  assert.equal(Object.hasOwn(summary, '独立验证已通过'), false);
}));

it('替代时省略复盘不继承旧效果声明；停用与被撤回来源使相关教训退出自动装配', async () => scene(async org => {
  const baseline = await goal(org);
  const original = await remember(org, feedback(baseline));
  const derived = await remember(org, feedback(baseline), { 来源引用: [original.id] });
  const replacement = (await act(org, { action: 'memory_lifecycle', op: 'overturn', id: original.id, 原因: '改变适用方法', 新条目: '新的条件下先调查再选择方案' })).结果.新条目;
  const full = (await act(org, { action: 'memory_query', id: replacement, 返回模式: '全文' })).结果.条目[0];
  assert.equal(Object.hasOwn(full, '协作反馈'), false);
  assert.equal((await recall(org)).记录.some(item => item.id === derived.id), false);
  await org.memory.invalidate(replacement, { subject: LEAD, 原因: '停止使用' });
  assert.deepEqual((await recall(org)).记录, []);
}));

it('成员不能记录、读取或改写私人反馈；旧教训保持兼容，坏复盘不当成无记录', async () => scene(async (org, f) => {
  const baseline = await goal(org);
  const record = await remember(org, feedback(baseline));
  await assert.rejects(act(org, args(feedback(baseline)), MEMBER));
  assert.deepEqual((await org.memory.query({ subject: MEMBER, 项目: P, 类: '偏好', id: record.id })).条目, []);
  await assert.rejects(org.memory.overturn(record.id, { subject: MEMBER, 新条目: '改私人教训', 理由: 'x' }));
  const old = await remember(org, undefined);
  assert.ok((await recall(org)).记录.some(item => item.id === old.id));
  const file = f.layout.memoryLog('跨项目', '偏好');
  const rows = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
  rows.find(row => row.id === record.id).协作反馈.已验证 = true;
  await writeFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  assert.ok(!(await recall(org)).记录.some(item => item.id === record.id));
  assert.equal(collaborationFeedbackSummary({ 已验证: true }).状态, '说明不可判');
}));

it('长复盘与多案例摘要受预算限制，详情可读完整失败和未知记录', async () => scene(async org => {
  const baseline = await goal(org, { 请求键: 'base' });
  const cases = [];
  for (let i = 0; i < 6; i++) cases.push(caseOf(await goal(org, { 请求键: `later-${i}` }), { 采用说明: '采'.repeat(500), 观察: '观'.repeat(1000), 依据: '据'.repeat(500), 结果声明: i % 2 ? '无改善' : '未知' }));
  const value = feedback(baseline, { 反馈: '反'.repeat(1000), 原做法: '原'.repeat(1000), 调整做法: '调'.repeat(1000), 适用条件: Array(6).fill('条'.repeat(240)), 后续案例: cases });
  const record = await remember(org, value);
  const result = await recall(org);
  assert.ok(JSON.stringify(result).length <= LEAD_CONTEXT_BUDGET);
  const summary = result.记录.find(item => item.id === record.id).协作反馈摘要;
  assert.equal(summary.后续案例总数, 6);
  assert.equal(summary.适用条件省略, true);
  assert.equal(summary.案例省略, true);
  const full = (await act(org, { action: 'memory_query', id: record.id, 返回模式: '全文', 内容预算: 32000 })).结果.条目[0];
  assert.deepEqual(full.协作反馈.后续案例, cases);
  assert.equal(summary.结果声明计数.改善, 0);
}));

it('审批完整冻结复盘与来源，批准后不能换效果；非法引用不先制造待审批', async () => scene(async (org, f) => {
  const baseline = await org.goals.create({ subject: SOVEREIGN, 项目: P, 期望结果: '复盘基线', 来源: '人侧目标', 完成依据: ['可核对'], 下一步: '调查' });
  const value = feedback(baseline);
  await assert.rejects(remember(org, feedback(baseline, { 基线: { ...ref(baseline), 修订: 999 } })));
  assert.equal((await org.intervention.投影({ 项目: P })).length, 0);
  const input = args(value);
  await assert.rejects(act(org, input));
  const request = (await org.intervention.投影({ 项目: P }))[0];
  const frozen = await org.intervention.读冻结({ 请求id: request.请求id, subject: LEAD });
  assert.deepEqual(frozen.入参.协作反馈, value);
  assert.deepEqual(frozen.步骤[0].预览.协作反馈, value);
  await org.intervention.人侧决议({ 请求id: request.请求id, 决定: '批准', 通道: '设置页', 认证: '宿主 Connection 已认证（同源浏览器设置入口）' });
  await assert.rejects(act(org, { ...input, 协作反馈: { ...value, 调整做法: '偷换做法' }, 审批引用: request.请求id }));
  const record = (await act(org, { ...input, 审批引用: request.请求id })).条目;
  assert.ok((await recall(org)).记录.some(item => item.id === record.id));
}, { defaults: { 介入度: '审批' } }));

it('真实工具、命令和新Lead装配共用复盘；专业子会话不接收私人反馈', async () => scene(async (org, f) => {
  const baseline = await goal(org);
  const host = fakeHost();
  try {
    await kernel.apply(host.ctx, { ...config(f), projectBindings: [{ path: process.cwd(), project: P }] });
    const tool = host.工具.get('mind');
    assert.equal(tool.parameters.properties.协作反馈.additionalProperties, false);
    const a = agent(); const exec = { agent: a, name: 'mind', signal: new AbortController().signal };
    const written = JSON.parse(await tool.execute(args(feedback(baseline)), exec));
    assert.equal(written.成功, true, JSON.stringify(written));
    const cmd = host.命令.get('mind');
    const later = await goal(org, { 请求键: 'later' });
    const updated = feedback(baseline, { 后续案例: [caseOf(later, { 结果声明: '无改善', 来源: '模型观察' })] });
    const revised = JSON.parse((await cmd.handler({ agent: a, rawInput: `memory_lifecycle ${JSON.stringify({ op: 'overturn', id: written.条目.id, 原因: '记录后续案例', 新条目: '首次改法未改善，应重审适用条件', 协作反馈: JSON.stringify(updated) })}` })).text);
    assert.equal(revised.成功, true, JSON.stringify(revised));
    const hook = host.钩子.get('system-prompt/assemble').at(-1);
    for (const session of [LEAD.id, 'new-lead']) {
      const state = await org.information.load();
      await org.information.admin({ subject: { id: 'owner-fixture', kind: '主权者' }, project: P },
        { op: 'relationship', expectedRevision: state.configRevision, session, relationship: 'same-human-fixture' });
    }
    const input = base();
    const out = await hook(input, { agent: agent('new-lead') }, async () => input);
    const section = out.sections.find(item => item.name === LEAD_CONTEXT_SECTION);
    assert.match(section.text, /无改善/);
    assert.match(section.text, /模型观察/);
    const child = await hook(input, { agent: agent(MEMBER.id, true) }, async () => input);
    assert.ok(!child.sections.some(item => item.name === LEAD_CONTEXT_SECTION));
    const bad = JSON.parse((await cmd.handler({ agent: a, rawInput: 'memory_write 类=偏好 内容=x 来源=x 协作反馈={bad' })).text);
    assert.equal(bad.成功, false);
    assert.match(JSON.stringify(bad), /协作反馈/);
  } finally { host.清理(); }
}));
