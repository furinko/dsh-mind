import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeFixture, LEAD, MEMBER, SOVEREIGN } from './helpers.mjs';
import { Org } from '../src/org.js';
import { recallLeadContext, LEAD_CONTEXT_BUDGET } from '../src/lead-context.js';
import { recallWorkContext } from '../src/work-context.js';
import { lessonSearchText } from '../src/lead-focus.js';
import { injectLeadContext, LEAD_CONTEXT_SECTION } from '../components/kernel/lib/lead-context.js';
import { WORK_CONTEXT_SECTION } from '../components/kernel/lib/work-context.js';
import { buildIndex, search, runRegression } from '../src/retrieval.js';
import { fakeHost } from './host-harness.mjs';
import * as kernel from '../components/kernel/lib/index.js';

const P = 'lead-focus';
const OTHER = { id: 'lead-other', kind: 'Lead' };
const config = f => ({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
async function scene(run) {
  const f = await makeFixture();
  try {
    const org = await Org.open(config(f));
    await org.registry.assign({ subject: SOVEREIGN, 岗位: 'Lead', 实例: OTHER.id });
    await run(org, f);
  } finally { await f.cleanup(); }
}
const goal = (org, word, extra = {}) => org.goals.create({ subject: LEAD, 项目: P, 期望结果: word, 完成依据: [word], 下一步: word, 来源: '模型对本轮目标的转述', ...extra });
const recall = (org, subject = LEAD) => recallLeadContext({ org, subject, project: P });
const lesson = (org, text, extra = {}) => org.memory.remember({ subject: LEAD, 类: '偏好', 项目: P, 内容: text, 来源: '有界回归夹具', 连续性: { 类别: '协作教训', 主题: '协作方法', 依据: '自省', 范围: '部署' }, ...extra });
const brief = (org, subject = LEAD) => recallWorkContext({ org, subject, project: P });
const base = () => ({ sections: [{ name: 'host:rules', text: 'host' }], tools: [] });
const agent = (id = LEAD.id, child = false) => ({ session: { id, header: { cwd: process.cwd(), ...(child ? { origin: 'subagent', delegationDepth: 1 } : {}) } } });

it('本会话旧目标不被其他窗口的大量较新目标与无关教训挤掉', async () => scene(async org => {
  const own = await goal(org, 'nebula');
  const relevant = await lesson(org, 'nebula workflow');
  for (let i = 0; i < 12; i++) {
    await goal(org, `ocean-${i}`, { subject: OTHER, 请求键: `other-${i}` });
    await lesson(org, `ocean-method-${i}`);
  }
  const work = await brief(org);
  assert.equal(work.资料[0].id, own.id);
  assert.equal(work.本会话目标.id, own.id);
  assert.equal(work.截断, true);
  const memory = await recall(org);
  assert.equal(memory.焦点线索.目标, own.id);
  assert.deepEqual(memory.记录.map(item => item.id), [relevant.id]);
  assert.doesNotMatch(JSON.stringify(memory), /ocean/);
}));

it('本会话推进旧目标立即切换线索，选择依据来自真实事件顺序而非时间并列或id', async () => scene(async org => {
  let first = await goal(org, 'nebula', { 请求键: 'first' });
  const second = await goal(org, 'ocean', { 请求键: 'second' });
  const a = await lesson(org, 'nebula workflow');
  const b = await lesson(org, 'ocean workflow');
  assert.equal((await recall(org)).焦点线索.目标, second.id);
  assert.deepEqual((await recall(org)).记录.map(item => item.id), [b.id]);
  first = await org.goals.progress(first.id, { subject: LEAD, 项目: P, 修订: first.修订, 状态: '进行中', 下一步: 'nebula followthrough' });
  assert.equal((await brief(org)).资料[0].id, first.id);
  const out = await recall(org);
  assert.equal(out.焦点线索.修订, first.修订);
  assert.deepEqual(out.记录.map(item => item.id), [a.id]);
}));

it('没有本会话推进线索时保留兼容近期资料，不冒称已识别当前对话焦点', async () => scene(async org => {
  const shared = await goal(org, 'ocean', { subject: OTHER });
  const old = await lesson(org, 'legacy-recent');
  const out = await recall(org);
  assert.equal(out.焦点线索, null);
  assert.ok(out.记录.some(item => item.id === old.id));
  const work = await brief(org);
  assert.equal(work.本会话目标, null);
  assert.equal(work.资料[0].id, shared.id);
  assert.match(work.选择口径, /不代表当前聊天焦点/);
}));

it('暂停目标不提供检索线索，取消终态不复活；仍保留状态概览', async () => scene(async org => {
  const own = await goal(org, 'nebula');
  let paused = await goal(org, 'ocean');
  paused = await org.goals.setState(paused.id, { subject: SOVEREIGN, 项目: P, 修订: paused.修订, 状态: '暂停' });
  assert.equal((await recall(org)).焦点线索.目标, own.id);
  assert.ok((await brief(org)).资料.some(item => item.id === paused.id && item.状态 === '暂停'));
  await org.goals.setState(own.id, { subject: SOVEREIGN, 项目: P, 修订: own.修订, 状态: '取消' });
  assert.equal((await recall(org)).焦点线索, null);
  assert.ok(!(await brief(org)).资料.some(item => item.id === own.id));
}));

it('有工作线索但零词面命中时不夹带近期教训，人格及明确偏好保持独立', async () => scene(async org => {
  await goal(org, 'nebula');
  await lesson(org, 'ocean unrelated');
  const preference = await lesson(org, '表达简短', { 连续性: { 类别: '用户偏好', 主题: '表达', 依据: '明确表达', 范围: '部署' } });
  const persona = await lesson(org, '保持好奇心', { 连续性: { 类别: '人格', 主题: '特点', 依据: '自省', 范围: '部署' } });
  const out = await recall(org);
  assert.deepEqual(new Set(out.记录.map(item => item.id)), new Set([preference.id, persona.id]));
  assert.ok(out.记录.every(item => item.连续性.类别 !== '协作教训'));
}));

it('教训可匹配主题和新做法条件，显式查询与内部检索的索引及版本不混用', async () => scene(async org => {
  const baseline = await goal(org, 'nebula');
  const entry = await lesson(org, 'opaque lesson', { 协作反馈: { 基线: { 项目: P, 目标: baseline.id, 修订: baseline.修订 },
    反馈: '先核对条件', 来源: '用户转述', 原做法: '直接执行', 调整做法: 'nebula dryrun', 适用条件: ['nebula request'] } });
  const manual = { subject: LEAD, 项目: P, 类: '偏好', 文本: 'nebula' };
  assert.deepEqual((await org.memory.query(manual)).条目, []);
  const focused = await org.memory.query({ ...manual, 连续性类别: '协作教训' });
  assert.deepEqual(focused.条目.map(item => item.id), [entry.id]);
  assert.deepEqual((await org.memory.query(manual)).条目, []);
  assert.notEqual(focused.数据版本, (await org.memory.query(manual)).数据版本);
  assert.deepEqual((await recall(org)).记录.map(item => item.id), [entry.id]);
  const tagged = await lesson(org, 'opaque second', { 连续性: { 类别: '协作教训', 主题: 'nebula', 依据: '自省', 范围: '部署' } });
  assert.ok((await recall(org)).记录.some(item => item.id === tagged.id));
}));

it('项目、失效及来源撤回先于词面排序，不因高匹配率扩大召回范围', async () => scene(async org => {
  await goal(org, 'nebula');
  const source = await lesson(org, 'nebula baseline');
  await lesson(org, 'nebula derivative', { 来源引用: [source.id] });
  await org.memory.invalidate(source.id, { subject: LEAD, 原因: '用户撤回原教训' });
  await lesson(org, 'nebula foreign', { 项目: 'another-project', 连续性: { 类别: '协作教训', 主题: 'nebula', 依据: '自省', 范围: '项目' } });
  const own = await lesson(org, 'nebula valid');
  assert.deepEqual((await recall(org)).记录.map(item => item.id), [own.id]);
}));

it('本会话工作线索在召回中改变时丢弃旧帧，不将旧目标教训带入新工作', async () => scene(async org => {
  await goal(org, 'nebula');
  await lesson(org, 'nebula workflow');
  const query = org.memory.query.bind(org.memory); let first = true;
  org.memory.query = async args => { const out = await query(args); if (first) { first = false; await goal(org, 'ocean', { 请求键: 'changed' }); } return out; };
  const input = { ...base(), sections: [...base().sections, { name: LEAD_CONTEXT_SECTION, text: 'old-private-frame' }] };
  const out = await injectLeadContext(input, { agent: agent(), org, projectOf: () => P });
  assert.deepEqual(out.sections, base().sections);
}));

it('会话推进线索不接受自报Lead、不跨项目复制，也不修改原目标或记忆账本', async () => scene(async (org, f) => {
  const own = await goal(org, 'nebula');
  await goal(org, 'ocean', { subject: OTHER });
  await lesson(org, 'nebula workflow');
  const beforeGoal = await readFile(f.layout.goalLog(P), 'utf8');
  const beforeMemory = await readFile(f.layout.memoryLog('跨项目', '偏好'), 'utf8');
  const a = await org.goals.contextSnapshot({ subject: LEAD, 项目: P });
  const b = await org.goals.contextSnapshot({ subject: OTHER, 项目: P });
  assert.deepEqual(a.本会话推进.map(item => item.目标), [own.id]);
  assert.ok(!b.本会话推进.some(item => item.目标 === own.id));
  await assert.rejects(org.goals.contextSnapshot({ subject: { id: MEMBER.id, kind: 'Lead' }, 项目: P }));
  const elsewhere = await recallLeadContext({ org, subject: LEAD, project: 'unrelated-project' });
  assert.equal(elsewhere.焦点线索, null);
  await recall(org);
  assert.equal(await readFile(f.layout.goalLog(P), 'utf8'), beforeGoal);
  assert.equal(await readFile(f.layout.memoryLog('跨项目', '偏好'), 'utf8'), beforeMemory);
}));

it('有界查询和回传预算继续有效，大量无关近期资料不触发全文装配', async () => scene(async org => {
  await goal(org, 'nebula'.repeat(500), { 完成依据: ['nebula'], 下一步: 'nebula' });
  for (let i = 0; i < 6; i++) await lesson(org, 'nebula '.repeat(2000), { 连续性: { 类别: '协作教训', 主题: 'nebula'.repeat(12), 依据: '自省', 范围: '部署' } });
  const out = await recall(org);
  assert.ok(JSON.stringify(out).length <= LEAD_CONTEXT_BUDGET);
  assert.ok(out.记录.length <= 3);
  assert.ok(out.记录.every(item => item.摘要.length <= 160 && !Object.hasOwn(item, '内容')));
  assert.equal(out.截断, true);
}));

it('新内部词面口径有固定回归集，零命中与主题/做法条件命中保持可复现', async () => {
  const entries = [
    { id: 'nebula', 内容: 'opaque-a', 连续性: { 主题: 'nebula' } },
    { id: 'ocean', 内容: 'opaque-b', 协作反馈: { 调整做法: 'ocean', 适用条件: [] } },
    { id: 'quantum', 内容: 'opaque-c', 协作反馈: { 调整做法: 'opaque', 适用条件: ['quantum'] } },
  ];
  const index = buildIndex(entries.map(entry => ({ id: entry.id, 正文: lessonSearchText(entry) })));
  const result = await runRegression({ 回归集: [{ 查询: 'nebula', 期望: 'nebula' }, { 查询: 'ocean', 期望: 'ocean' }, { 查询: 'quantum', 期望: 'quantum' }, { 查询: 'totallyunmatched', 期望: 'NONE' }],
    执行: query => search(index, query).命中[0]?.id ?? 'NONE' });
  assert.equal(result.通过, true, JSON.stringify(result));
});

it('真实内核按当前Lead会话组装目标与相关教训，其他Lead和专业成员不串线', async () => scene(async (org, f) => {
  const own = await goal(org, 'nebula');
  const other = await goal(org, 'ocean', { subject: OTHER });
  const a = await lesson(org, 'nebula workflow'); const b = await lesson(org, 'ocean workflow');
  const host = fakeHost();
  try {
    await kernel.apply(host.ctx, { ...config(f), projectBindings: [{ path: process.cwd(), project: P }] });
    const hook = host.钩子.get('system-prompt/assemble').at(-1);
    for (const [who, expectedGoal, expectedMemory] of [[LEAD, own.id, a.id], [OTHER, other.id, b.id]]) {
      const input = base(); const out = await hook(input, { agent: agent(who.id) }, async () => input);
      const memory = JSON.parse(out.sections.find(item => item.name === LEAD_CONTEXT_SECTION).text.split('\n').at(-1));
      const work = JSON.parse(out.sections.find(item => item.name === WORK_CONTEXT_SECTION).text.split('\n').at(-1));
      assert.ok(!Object.hasOwn(memory, '焦点线索'));
      assert.equal((await recallLeadContext({ org, subject: who, project: P })).焦点线索.目标, expectedGoal);
      assert.deepEqual(memory.记录.map(item => item.id), [expectedMemory]);
      assert.equal(work.资料[0].id, expectedGoal);
    }
    const input = base(); const child = await hook(input, { agent: agent(MEMBER.id, true) }, async () => input);
    assert.ok(!child.sections.some(item => item.name === LEAD_CONTEXT_SECTION));
  } finally { host.清理(); }
}));
