import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { makeFixture, LEAD, MEMBER } from './helpers.mjs';
import { Org } from '../src/org.js';
import { runAction } from '../lib/actions.js';
import { recallLeadContext, LEAD_CONTEXT_BUDGET } from '../src/lead-context.js';
import { injectLeadContext, LEAD_CONTEXT_SECTION } from '../components/kernel/lib/lead-context.js';
import { normalizeContinuity } from '../src/lead-continuity.js';
import { fakeHost } from './host-harness.mjs';
import * as kernel from '../components/kernel/lib/index.js';

const P = 'lead-continuity';
const meta = (extra = {}) => ({ 类别: '用户偏好', 主题: '表达方式', 依据: '明确表达', 范围: '部署', ...extra });
const config = f => ({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
async function scene(run) {
  const f = await makeFixture();
  try { await run(await Org.open(config(f)), f); } finally { await f.cleanup(); }
}
const write = (org, extra = {}) => org.memory.remember({ subject: LEAD, 类: '偏好', 项目: P,
  内容: '请直接说明结果与依据', 来源: '用户在当前验收案例中明确表达', 连续性: meta(), ...extra });
const recall = (org, extra = {}) => recallLeadContext({ org, subject: LEAD, project: P, ...extra });
const action = (org, args, subject = LEAD) => runAction({ org, 主体: subject, 项目: P, args });
const base = () => ({ sections: [{ name: 'host:rules', text: '宿主规则' }], tools: [] });
const agent = (id = 'lead', child = false) => ({ session: { id, header: { cwd: process.cwd(), ...(child ? { origin: 'subagent', delegationDepth: 1 } : {}) } } });
const frame = result => JSON.parse(result.sections.find(s => s.name === LEAD_CONTEXT_SECTION).text.split('\n').at(-1));

it('人格、明确偏好与教训真实落账，在新Org和新Lead会话重建，不复活旧身份', async () => scene(async (org, f) => {
  const preference = await write(org);
  const personality = await write(org, { 内容: '保持好奇，给出独立判断', 连续性: meta({ 类别: '人格', 依据: '自省', 主题: '判断方式' }) });
  const lesson = await write(org, { 内容: '先给一个小样例以核对模糊需求', 连续性: meta({ 类别: '协作教训', 依据: '自省', 主题: '需求澄清' }) });
  const reopened = await Org.open(config(f));
  const host = fakeHost();
  await kernel.apply(host.ctx, { ...config(f), projectBindings: [{ path: process.cwd(), project: P }] });
  try {
    const hook = host.钩子.get('system-prompt/assemble').at(-1);
    const input = base();
    await hook(input, { agent: agent('new-lead') }, async () => input);
  } finally { host.清理(); }
  const result = await recall(reopened, { subject: { id: 'new-lead', kind: 'Lead' } });
  assert.deepEqual(new Set(result.记录.map(e => e.id)), new Set([preference.id, personality.id, lesson.id]));
  assert.equal(result.记录.find(e => e.id === personality.id).连续性.依据, '自省');
  const untouched = await reopened.registry.identity();
  assert.equal(untouched.members.lead.status, '在岗');
  assert.equal(untouched.members['new-lead'].岗位, 'Lead');
}));

it('分类及项目在分页前筛选，未标记旧偏好不自动迁入，明确表达不被大量更新推断挤掉', async () => scene(async org => {
  const explicit = await write(org);
  const personality = await write(org, { 连续性: meta({ 类别: '人格', 依据: '自省' }) });
  for (let i = 0; i < 15; i++) {
    await write(org, { 内容: `candidate-${i}`, 连续性: meta({ 依据: '推断', 主题: `候选${i}` }) });
    await write(org, { 项目: 'other-project', 内容: `foreign-${i}`, 连续性: meta({ 范围: '项目' }) });
  }
  await write(org, { 内容: 'old-unclassified', 连续性: undefined });
  const result = await recall(org);
  assert.equal(result.记录.filter(e => e.连续性.类别 === '用户偏好').length, 3);
  assert.ok(result.记录.some(e => e.id === explicit.id));
  assert.ok(result.记录.some(e => e.id === personality.id));
  assert.doesNotMatch(JSON.stringify(result), /foreign-|old-unclassified/);
  assert.equal(result.截断, true);
  const across = await recall(org, { project: 'another-project' });
  assert.ok(across.记录.some(e => e.id === explicit.id));
  const projectOnly = await write(org, { 内容: 'local-only', 连续性: meta({ 范围: '项目' }) });
  assert.ok((await recall(org)).记录.some(e => e.id === projectOnly.id));
  assert.ok(!(await recall(org, { project: 'another-project' })).记录.some(e => e.id === projectOnly.id));
}));

it('更正经真实动作原子替代并继承范围；推断可改为明确表达，原记录和引用它的摘要退出', async () => scene(async org => {
  const old = (await action(org, { action: 'memory_write', 类: '偏好', 内容: '推测喜欢冗长讲解', 来源: '一次行为线索', 连续性: meta({ 依据: '推断', 范围: '项目' }) })).条目;
  const derived = await write(org, { 内容: 'derived-old-summary', 来源引用: [old.id], 连续性: meta({ 类别: '协作教训', 依据: '自省' }) });
  const changed = await action(org, { action: 'memory_lifecycle', op: 'overturn', id: old.id,
    原因: '用户明确纠正：简短说明即可', 新条目: '用户希望简短说明', 连续性: meta({ 范围: '项目' }) });
  const current = await recall(org);
  assert.ok(current.记录.some(e => e.id === changed.结果.新条目));
  assert.ok(!current.记录.some(e => [old.id, derived.id].includes(e.id)));
  assert.equal(current.记录[0].连续性.依据, '明确表达');
  const second = await action(org, { action: 'memory_lifecycle', op: 'overturn', id: changed.结果.新条目, 原因: '细化表达偏好', 新条目: '保持简短，必要时补充依据' });
  assert.deepEqual((await recall(org)).记录[0].连续性, meta({ 范围: '项目' }));
  assert.equal((await recall(org)).记录[0].id, second.结果.新条目);
  const history = await action(org, { action: 'memory_query', id: old.id, 类: '偏好', 含失效: true });
  assert.equal(history.结果.条目[0].状态, '被推翻');
}));

it('停用、降权及被撤回来源的多级派生资料不自动使用；显式历史仍可核对', async () => scene(async org => {
  const source = await write(org, { 内容: 'source-sensitive' });
  const child = await write(org, { 内容: 'child-sensitive', 来源引用: [source.id] });
  const grandchild = await write(org, { 内容: 'grandchild-sensitive', 来源引用: [child.id] });
  await action(org, { action: 'memory_lifecycle', op: 'invalidate', id: source.id, 原因: '用户停止使用' });
  await action(org, { action: 'memory_lifecycle', op: 'demote', id: source.id, 原因: '降权不能复活' });
  assert.deepEqual((await recall(org)).记录, []);
  assert.ok((await action(org, { action: 'memory_query', 类: '偏好' })).结果.条目.some(e => e.id === grandchild.id));
  const cold = await write(org);
  await action(org, { action: 'memory_lifecycle', op: 'demote', id: cold.id, 原因: '不再默认使用' });
  assert.deepEqual((await recall(org)).记录, []);
  await org.memory.purge(source.id, { subject: LEAD, 理由: '敏感内容删除', 敏感: true });
  assert.deepEqual((await recall(org)).记录, []);
}));

it('知识来源被失效后，引用它的协作教训也退出自动装配', async () => scene(async org => {
  const source = await org.memory.remember({ subject: LEAD, 类: '知识', 内容: '观察事实', 来源: '验收证据', 项目: P });
  const lesson = await write(org, { 来源引用: [source.id], 连续性: meta({ 类别: '协作教训', 依据: '自省' }) });
  assert.ok((await recall(org)).记录.some(e => e.id === lesson.id));
  await org.memory.invalidate(source.id, { subject: LEAD, 原因: '证据已被反例推翻' });
  assert.deepEqual((await recall(org)).记录, []);
}));

it('连续性声明严格校验但不冒充用户认证；错误字段和错误动作不留部分写入', async () => scene(async (org, f) => {
  const before = await readFile(f.layout.memoryLog('跨项目', '偏好'), 'utf8').catch(() => '');
  const bad = [null, {}, [], { ...meta(), 已确认: true }, meta({ 类别: '知识' }), meta({ 主题: '' }), meta({ 主题: 'x'.repeat(81) }), meta({ 依据: '自省' }), meta({ 范围: '全局' })];
  for (const 连续性 of bad) {
    assert.throws(() => normalizeContinuity(连续性));
    await assert.rejects(write(org, { 连续性 }));
    await assert.rejects(action(org, { action: 'memory_write', 类: '偏好', 内容: 'x', 来源: 'x', 连续性 }));
  }
  for (const 类 of ['经历', '知识', '作答']) await assert.rejects(write(org, { 类 }));
  await assert.rejects(write(org, { subject: MEMBER }));
  await assert.rejects(write(org, { 项目: undefined, 连续性: meta({ 范围: '项目' }) }));
  await assert.rejects(action(org, { action: 'memory_query', 连续性: meta() }));
  await assert.rejects(action(org, { action: 'memory_query', 连续性类别: '人格' }));
  await assert.rejects(action(org, { action: 'memory_lifecycle', op: 'invalidate', id: 'pref-fake', 连续性: meta() }));
  assert.equal(await readFile(f.layout.memoryLog('跨项目', '偏好'), 'utf8').catch(() => ''), before);
}));

it('专业成员和冒报岗位不获得连续性；显式列表、id及可读性也不泄露原文', async () => scene(async org => {
  const record = await write(org, { 内容: 'private-personality-record' });
  await assert.rejects(recall(org, { subject: MEMBER }));
  await assert.rejects(recall(org, { subject: { id: MEMBER.id, kind: 'Lead' } }));
  await assert.rejects(recall(org, { subject: { id: 'unknown', kind: 'Lead' } }));
  assert.equal((await org.memory.query({ subject: MEMBER, 项目: P, 类: '偏好', id: record.id })).条目.length, 0);
  assert.equal((await org.memory.readableBy(record.id, { 读者: MEMBER })).可读, false);
  await assert.rejects(org.memory.lineage({ subject: MEMBER, id: record.id }));
  await assert.rejects(org.memory.invalidate(record.id, { subject: MEMBER, 原因: '非Lead不能停用' }), /仅Lead或主权者/);
  await assert.rejects(org.memory.purge(record.id, { subject: MEMBER, 理由: '成员自报敏感', 敏感: true }), /仅Lead或主权者/);
  const input = { ...base(), sections: [...base().sections, { name: LEAD_CONTEXT_SECTION, text: 'stale-private' }] };
  const out = await injectLeadContext(input, { agent: agent(MEMBER.id, true), org, projectOf: () => P });
  assert.doesNotMatch(JSON.stringify(out), /private/);
}));

it('既有审批冻结连续性全文和范围，批准不能换参数；旧档位不被资料绕过', async () => {
  const f = await makeFixture({ defaults: { 介入度: '审批' } });
  try {
    const org = await Org.open(config(f));
    const args = { action: 'memory_write', 类: '偏好', 内容: 'approval-private-preference', 来源: '用户明确表达', 连续性: meta({ 范围: '项目' }) };
    let pending;
    try { await action(org, args); } catch (error) { pending = error; }
    assert.ok(pending);
    const requests = await org.intervention.投影({ 项目: P });
    assert.equal(requests.length, 1);
    const id = requests[0].请求id;
    const frozen = await org.intervention.读冻结({ 请求id: id, subject: LEAD });
    assert.deepEqual(frozen.入参.连续性, args.连续性);
    assert.equal(frozen.入参.内容, args.内容);
    assert.deepEqual(frozen.步骤[0].预览.连续性, args.连续性);
    assert.deepEqual((await recall(org)).记录, []);
    await org.intervention.人侧决议({ 请求id: id, 决定: '批准', 通道: '设置页', 认证: '宿主 Connection 已认证（同源浏览器设置入口）' });
    await assert.rejects(action(org, { ...args, 连续性: meta({ 范围: '部署' }), 审批引用: id }));
    const written = await action(org, { ...args, 审批引用: id });
    assert.ok((await recall(org)).记录.some(e => e.id === written.条目.id));
  } finally { await f.cleanup(); }
});

it('长正文及元数据保持预算，摘要可按id读全文；空账不添加空白段', async () => scene(async org => {
  const empty = base();
  assert.equal(await injectLeadContext(empty, { agent: agent(), org, projectOf: () => P }), empty);
  for (const 类别 of ['用户偏好', '人格', '协作教训']) for (let i = 0; i < 4; i++) {
    await write(org, { 内容: `summary-${类别}-${i}:` + '文'.repeat(10000), 连续性: meta({ 类别, 主题: '长'.repeat(80) }) });
  }
  const result = await recall(org);
  assert.ok(JSON.stringify(result).length <= LEAD_CONTEXT_BUDGET);
  assert.ok(result.记录.length <= 9);
  assert.equal(result.截断, true);
  assert.ok(result.记录.every(e => e.摘要.length <= 160));
  const details = await action(org, { action: 'memory_query', id: result.记录[0].id, 返回模式: '全文' });
  assert.ok(details.结果.条目[0].内容.length > 160);
}));

it('装配中撤回记忆、封存身份或读取失败时清除旧段，宿主对话继续', async () => scene(async (org, f) => {
  const record = await write(org);
  const input = { ...base(), sections: [...base().sections, { name: LEAD_CONTEXT_SECTION, text: 'stale-private' }] };
  const original = org.memory.query.bind(org.memory);
  let first = true;
  org.memory.query = async args => {
    const out = await original(args);
    if (first) { first = false; await org.memory.invalidate(record.id, { subject: LEAD, 原因: '装配中撤回' }); }
    return out;
  };
  assert.deepEqual((await injectLeadContext(input, { agent: agent(), org, projectOf: () => P })).sections, base().sections);
  org.memory.query = original;
  await write(org);
  first = true;
  org.memory.query = async args => {
    const out = await original(args);
    if (first) { first = false; const identity = await org.registry.identity(); identity.members.lead.status = '封存'; await writeFile(org.layout.identityFile(), JSON.stringify(identity)); }
    return out;
  };
  assert.deepEqual((await injectLeadContext(input, { agent: agent(), org, projectOf: () => P })).sections, base().sections);
  org.memory.query = async () => { throw new Error('broken-private-details'); };
  const warnings = [];
  assert.deepEqual((await injectLeadContext(input, { agent: agent(), org, projectOf: () => P, logger: { warn: m => warnings.push(m) } })).sections, base().sections);
  assert.ok(warnings.length);
  assert.doesNotMatch(warnings.join(''), /broken-private-details/);
}));

it('查询中切换项目、宿主会话或卸载插件，不将旧帧带入新上下文', async () => scene(async org => {
  await write(org);
  for (const mutate of ['project', 'agent', 'unload']) {
    const a = agent(); let project = P; let active = true;
    const original = org.memory.query.bind(org.memory);
    let first = true;
    org.memory.query = async args => { const out = await original(args); if (first) { first = false; if (mutate === 'project') project = 'other'; if (mutate === 'agent') a.session.id = 'other'; if (mutate === 'unload') active = false; } return out; };
    const input = base();
    assert.equal(await injectLeadContext(input, { agent: a, org, projectOf: () => project, active: () => active }), input);
    org.memory.query = original;
  }
}));

it('真实内核工具、命令及模型装配共用持久记录；连续性不会进入子会话', async () => scene(async (org, f) => {
  const host = fakeHost();
  try {
    await kernel.apply(host.ctx, { ...config(f), projectBindings: [{ path: process.cwd(), project: P }] });
    const tool = host.工具.get('mind');
    assert.equal(tool.parameters.properties.连续性.additionalProperties, false);
    const a = agent(); const exec = { agent: a, name: 'mind', signal: new AbortController().signal };
    const written = JSON.parse(await tool.execute({ action: 'memory_write', 类: '偏好', 内容: 'real-tool-user-preference', 来源: '实测用户明确表达', 连续性: meta() }, exec));
    assert.equal(written.成功, true, JSON.stringify(written));
    const command = host.命令.get('mind');
    const cmd = JSON.parse((await command.handler({ agent: a, rawInput: `memory_write ${JSON.stringify({ 类: '偏好', 内容: 'real-command-personality', 来源: '自省记录', 连续性: JSON.stringify(meta({ 类别: '人格', 依据: '自省' })) })}` })).text);
    assert.equal(cmd.成功, true, JSON.stringify(cmd));
    const hook = host.钩子.get('system-prompt/assemble').at(-1);
    const input = base(); const result = await hook(input, { agent: a }, async () => input);
    assert.ok(frame(result).记录.some(e => e.id === written.条目.id));
    assert.match(JSON.stringify(result), /real-command-personality/);
    const child = await hook(input, { agent: agent(MEMBER.id, true) }, async () => input);
    assert.ok(!child.sections.some(s => s.name === LEAD_CONTEXT_SECTION));
    const bad = JSON.parse((await command.handler({ agent: a, rawInput: 'memory_write 类=偏好 内容=x 来源=x 连续性={bad' })).text);
    assert.equal(bad.成功, false);
    assert.match(JSON.stringify(bad), /连续性/);
    const stopped = JSON.parse(await tool.execute({ action: 'memory_lifecycle', op: 'invalidate', id: written.条目.id, 原因: '用户停止使用' }, exec));
    assert.equal(stopped.成功, true);
    const reassembled = await hook(result, { agent: a }, async () => result);
    assert.doesNotMatch(JSON.stringify(frame(reassembled)), /real-tool-user-preference/);
  } finally { host.清理(); }
}));
