import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeFixture, writeUnder, LEAD } from './helpers.mjs';
import { Org } from '../src/org.js';
import { Denied } from '../src/kernel/errors.js';
import { recallProfessionalContext, PROFESSIONAL_CONTEXT_BUDGET } from '../src/professional-context.js';
import { injectProfessionalContext, PROFESSIONAL_SECTION } from '../components/kernel/lib/professional-context.js';
import { runAction } from '../lib/actions.js';
import { fakeHost } from './host-harness.mjs';
import * as kernel from '../components/kernel/lib/index.js';

const P = 'professional-context';
async function fixture(run) {
  const f = await makeFixture();
  const engineer = await readFile(join(f.factoryRoot, '集体L3-成员角色卡/插件工程.md'), 'utf8');
  await writeUnder(f.factoryRoot, '集体L3-成员角色卡/文档整理.md', engineer.replaceAll('插件工程', '文档整理'));
  const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
  try { await run(org, f); } finally { await f.cleanup(); }
}
async function task(org, role, instance, description = 'nebula') {
  await org.registry.assign({ subject: LEAD, 岗位: role, 实例: instance });
  const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: description, 负责人: [role], 判据: ['nebula'] });
  await org.tasks.bind(node.id, { subject: LEAD, 项目: P, 实例: instance, 岗位: role });
  await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
  await org.tasks.start(node.id, { subject: { id: instance, kind: '成员', roleId: role }, 项目: P });
  return node;
}
async function knowledge(org, role, content = 'nebula', extra = {}) {
  return org.memory.remember({ subject: LEAD, 类: '知识', 项目: P, 岗位: role, 内容: content, 来源: '可定位夹具', ...extra });
}
const base = () => ({ sections: [{ name: 'host:rules', text: '宿主规则' }], tools: [] });
const agent = (id, child = false) => ({ session: { id, header: { cwd: process.cwd(), ...(child ? { origin: 'subagent', delegationDepth: 1 } : {}) } } });
const readFrame = result => JSON.parse(result.sections.find(s => s.name === PROFESSIONAL_SECTION).text.split('\n').at(-1));

it('两种真实专业保留本岗并召回相关未标岗旧知识，排除异岗和无关共享项', async () => fixture(async org => {
  await task(org, '插件工程', 'engineer');
  await task(org, '文档整理', 'writer');
  const engineering = await knowledge(org, '插件工程', 'nebula 工程正确做法');
  const writing = await knowledge(org, '文档整理', 'nebula 写作正确做法');
  const lead = await knowledge(org, 'Lead', '需求理解与协调');
  for (let i = 0; i < 24; i++) await knowledge(org, `其他专业${i}`, 'nebula unrelated-domain');
  const shared = await knowledge(org, undefined, 'nebula unclassified');
  await knowledge(org, undefined, 'ocean unrelated-shared');
  await org.memory.remember({ subject: LEAD, 类: '偏好', 内容: 'private-user-preference', 来源: '夹具用户' });
  await knowledge(org, '插件工程', 'nebula other-project', { 项目: 'another-project' });
  for (const [id, role, expected] of [['engineer', '插件工程', engineering.id], ['writer', '文档整理', writing.id]]) {
    const frame = await recallProfessionalContext({ org, subject: { id, kind: '成员' }, project: P });
    assert.equal(frame.岗位, role);
    assert.deepEqual(new Set(frame.知识.map(item => item.id)), new Set([expected, shared.id]));
    assert.equal(frame.候选数, 3);
    assert.doesNotMatch(JSON.stringify(frame), /unrelated-domain|unrelated-shared|private-user-preference|other-project/);
  }
  assert.deepEqual((await recallProfessionalContext({ org, subject: LEAD, project: P })).知识.map(item => item.id), [lead.id]);
}));

it('显式跨专业查询沿用原读权；自动分区不变成访问授权或封锁', async () => fixture(async org => {
  await task(org, '插件工程', 'engineer');
  const other = await knowledge(org, '文档整理', 'nebula 跨专业内容');
  const response = await runAction({ org, 主体: { id: 'engineer', kind: '成员' }, 项目: P,
    args: { action: 'memory_query', 岗位: '文档整理', 文本: 'nebula' } });
  assert.deepEqual(response.结果.条目.map(item => item.id), [other.id]);
  await assert.rejects(runAction({ org, 主体: { id: 'engineer', kind: '成员' }, 项目: P,
    args: { action: 'memory_query', project: 'another-project', 文本: 'nebula' } }), /跨项目/);
  assert.deepEqual((await recallProfessionalContext({ org, subject: { id: 'engineer', kind: '成员' }, project: P })).知识, []);
}));

it('精确筛选不污染兼容查询索引或分页版本；未标专业的旧知识保持原记录', async () => fixture(async org => {
  const tagged = await knowledge(org, 'Lead', 'nebula tagged');
  const old = await knowledge(org, undefined, 'nebula untagged');
  const params = { subject: LEAD, 项目: P, 类: '知识', 岗位: 'Lead', 文本: 'nebula' };
  const precise = await org.memory.query({ ...params, 精确岗位: true });
  assert.deepEqual(precise.条目.map(item => item.id), [tagged.id]);
  const compatible = await org.memory.query(params);
  assert.deepEqual(new Set(compatible.条目.map(item => item.id)), new Set([tagged.id, old.id]));
  assert.notEqual(precise.数据版本, compatible.数据版本);
  await assert.rejects(org.memory.query({ ...params, 数据版本: precise.数据版本 }), /查询口径已变化/);
  await assert.rejects(org.memory.query({ subject: LEAD, 项目: P, 精确岗位: true }), /非空岗位/);
}));

it('零命中不夹带本岗无关正文；失效和待复验知识不进入默认装配', async () => fixture(async org => {
  await task(org, '插件工程', 'engineer', 'nebula');
  await knowledge(org, '插件工程', 'ocean unrelatedtext');
  const invalid = await knowledge(org, '插件工程', 'nebula invalid-secret');
  await org.memory.invalidate(invalid.id, { subject: LEAD, 原因: '错误' });
  await knowledge(org, '插件工程', 'nebula expired-secret', { 知识说明: { 复验期限: '2020-01-01T00:00:00.000Z' } });
  const frame = await recallProfessionalContext({ org, subject: { id: 'engineer', kind: '成员' }, project: P });
  assert.deepEqual(frame.知识, []);
  assert.doesNotMatch(JSON.stringify(frame), /invalid-secret|expired-secret|unrelatedtext/);
}));

it('无当前绑定、旧代绑定、冒报岗位、未登记和已封存实例不获得自动知识', async () => fixture(async org => {
  await knowledge(org, '插件工程', 'nebula protected');
  const noTask = await recallProfessionalContext({ org, subject: { id: 'member-a', kind: '成员' }, project: P });
  assert.equal(noTask.状态, '无当前有效活动绑定');
  await assert.rejects(recallProfessionalContext({ org, subject: { id: 'member-a', kind: '成员', roleId: 'Lead' }, project: P }), /自报岗位/);
  await assert.rejects(recallProfessionalContext({ org, subject: { id: 'ghost', kind: '成员' }, project: P }), /在岗身份/);
  await task(org, '插件工程', 'engineer');
  const path = org.layout.identityFile();
  const identity = JSON.parse(await readFile(path, 'utf8'));
  identity.members.engineer.代 += 1;
  await writeFile(path, JSON.stringify(identity));
  assert.deepEqual((await recallProfessionalContext({ org, subject: { id: 'engineer', kind: '成员' }, project: P })).知识, []);
  identity.members.engineer.status = '封存';
  await writeFile(path, JSON.stringify(identity));
  await assert.rejects(recallProfessionalContext({ org, subject: { id: 'engineer', kind: '成员' }, project: P }), /在岗身份/);
}));

it('复核员自动知识仍按真实复核对象裁剪', async () => fixture(async org => {
  const target = await org.tasks.create({ subject: LEAD, 项目: P, 描述: 'nebula 待复核对象', 负责人: ['Lead'], 判据: ['nebula'] });
  const review = await org.tasks.create({ subject: LEAD, 项目: P, 描述: 'nebula 核验', 负责人: ['复核员'], 判据: ['nebula'], 复核对象: [target.id] });
  await org.tasks.bind(review.id, { subject: LEAD, 项目: P, 实例: 'reviewer', 岗位: '复核员' });
  await org.tasks.dispatch(review.id, { subject: LEAD, 项目: P });
  const visible = await knowledge(org, '复核员', 'nebula allowed-review', { 来源引用: [target.id] });
  await knowledge(org, '复核员', 'nebula outside-review');
  const frame = await recallProfessionalContext({ org, subject: { id: 'reviewer', kind: '成员' }, project: P });
  assert.deepEqual(frame.知识.map(item => item.id), [visible.id]);
}));

it('装配总量有界，长正文和元数据不挤入默认上下文', async () => fixture(async org => {
  for (let i = 0; i < 8; i++) await knowledge(org, 'Lead', `协调经验${i} ${'😀'.repeat(2000)}`, { 来源: 'source'.repeat(6000) });
  const frame = await recallProfessionalContext({ org, subject: LEAD, project: P });
  assert.ok(frame.知识.length > 0 && frame.知识.length <= 4);
  assert.ok(JSON.stringify(frame).length <= PROFESSIONAL_CONTEXT_BUDGET);
  assert.equal(frame.截断, true);
  assert.ok(frame.知识.every(item => item.摘要.length <= 160 && !Object.hasOwn(item, '内容')));
}));

it('每次装配更新记忆、替换旧段；未知会话、撤销接线和读取失败都移除旧段', async () => fixture(async org => {
  const record = await knowledge(org, 'Lead', 'coordination-before');
  const options = { agent: agent('lead'), org, projectOf: () => P };
  const first = await injectProfessionalContext(base(), options);
  assert.equal(readFrame(first).知识[0].id, record.id);
  await org.memory.invalidate(record.id, { subject: LEAD, 原因: '已失效' });
  const second = await injectProfessionalContext(first, options);
  assert.equal(second.sections.filter(s => s.name === PROFESSIONAL_SECTION).length, 1);
  assert.deepEqual(readFrame(second).知识, []);
  for (const changed of [{ agent: {} }, { active: () => false }]) {
    const out = await injectProfessionalContext(first, { ...options, ...changed });
    assert.deepEqual(out.sections, base().sections);
  }
  org.memory.query = async () => { throw new Error('read failed'); };
  assert.deepEqual((await injectProfessionalContext(first, options)).sections, base().sections);
}));

it('查询过程中撤销身份，旧读数不会进入提示词', async () => fixture(async org => {
  await knowledge(org, 'Lead', 'stale-knowledge-secret');
  const query = org.memory.query.bind(org.memory);
  org.memory.query = async spec => {
    const result = await query(spec);
    const path = org.layout.identityFile();
    const identity = JSON.parse(await readFile(path, 'utf8'));
    identity.members.lead.status = '封存';
    await writeFile(path, JSON.stringify(identity));
    return result;
  };
  const out = await injectProfessionalContext(base(), { agent: agent('lead'), org, projectOf: () => P });
  assert.deepEqual(out.sections, base().sections);
}));

it('真实内核装配监听自动提供Lead与专业成员的岗位知识，未使用额外模型工具调用', async () => fixture(async (org, f) => {
  await task(org, '插件工程', 'engineer');
  const engineering = await knowledge(org, '插件工程', 'nebula native-engineering');
  const lead = await knowledge(org, 'Lead', 'native-coordination');
  const host = fakeHost();
  try {
    await kernel.apply(host.ctx, { home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P,
      projectBindings: [{ path: process.cwd(), project: P }] });
    const hook = (host.钩子.get('system-prompt/assemble') ?? []).at(-1);
    assert.equal(typeof hook, 'function');
    const assembly = base();
    const root = await hook(assembly, { agent: agent('native-root') }, async () => assembly);
    assert.deepEqual(readFrame(root).知识.map(item => item.id), [lead.id]);
    const member = await hook(assembly, { agent: agent('engineer', true) }, async () => assembly);
    assert.deepEqual(readFrame(member).知识.map(item => item.id), [engineering.id]);
    assert.equal(host.工具.has('mind'), true);
  } finally { host.清理(); }
}));

it('宿主项目或会话事实在查询中变化时不注入旧项目内容，异步卸载也不续用', async () => fixture(async org => {
  await knowledge(org, 'Lead', 'old-project-secret');
  const query = org.memory.query.bind(org.memory);
  let currentProject = P;
  let running = true;
  org.memory.query = async spec => { const result = await query(spec); currentProject = 'changed-project'; return result; };
  const options = { agent: agent('lead'), org, projectOf: () => currentProject, active: () => running };
  assert.deepEqual((await injectProfessionalContext(base(), options)).sections, base().sections);
  currentProject = P;
  org.memory.query = async spec => { const result = await query(spec); running = false; return result; };
  assert.deepEqual((await injectProfessionalContext(base(), options)).sections, base().sections);
}));

it('岗位与任务绑定不绕过当前任务读取规则；召回失败不阻断宿主装配', async () => fixture(async org => {
  await task(org, '插件工程', 'engineer');
  await knowledge(org, '插件工程', 'nebula task-restricted-secret');
  const check = org.policy.check.bind(org.policy);
  org.policy.check = async spec => {
    if (spec.action === 'read' && spec.target?.kind === '任务') throw new Denied('夹具当前读权', '当前任务不允许读取');
    return check(spec);
  };
  const result = await injectProfessionalContext(base(), { agent: agent('engineer', true), org, projectOf: () => P });
  assert.deepEqual(result.sections, base().sections);
}));
