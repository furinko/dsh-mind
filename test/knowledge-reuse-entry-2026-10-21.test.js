/** 知识采用声明通过真实提交链入账；治理查询不把声明或采纳等同于收益。 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { makeFixture, LEAD, MEMBER, REVIEWER, SOVEREIGN } from './helpers.mjs';
import { fakeHost } from './host-harness.mjs';
import { Org } from '../src/org.js';
import { shareOrg } from '../src/runtime.js';
import { readTextOrNull } from '../src/kernel/fsx.js';
import { runAction, ACTIONS, COMMAND_ACTIONS, READ_ONLY_ACTIONS, 是写动作 } from '../lib/actions.js';
import { Denied, InvalidBody } from '../src/kernel/errors.js';
import * as kernel from '../components/kernel/lib/index.js';

const P = 'knowledge-reuse-entry';
const Q = 'knowledge-reuse-other';
const configFor = f => ({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
const invalid = error => error instanceof InvalidBody || error instanceof Denied;
const adoption = id => ({ id, 用途: '复用边界检查方法', 适用判断: '当前任务存在相同失败条件', 使用结果: '有帮助', 说明: '仍由交付证据核验结果' });

async function ready(org, label, 项目 = P) {
  const node = await org.tasks.create({ subject: LEAD, 项目, 描述: label, 负责人: '插件工程', 判据: ['交付可复验'] });
  await org.tasks.bind(node.id, { subject: LEAD, 项目, 实例: MEMBER.id, 岗位: MEMBER.roleId });
  await org.tasks.dispatch(node.id, { subject: LEAD, 项目 });
  await org.tasks.start(node.id, { subject: MEMBER, 项目 });
  return node;
}

async function scene(run) {
  const f = await makeFixture();
  try {
    const org = await Org.open(configFor(f));
    const act = (args, subject = LEAD, 面 = 'tool') => runAction({ org, 项目: P, 主体: subject, subject, 面, args });
    const query = async (args = {}, subject = LEAD) => (await act({ action: 'knowledge_reuse_query', ...args }, subject)).知识复用;
    const submit = (node, extra = {}) => act({ action: 'task_submit', id: node.id, 结论: '交付完成待核验', ...extra }, MEMBER);
    const log = (project = P) => readTextOrNull(f.layout.taskLog(project));
    const source = () => org.memory.remember({ subject: LEAD, 类: '知识', 项目: P, 岗位: MEMBER.roleId, 内容: '隔离测试知识：按边界条件核查失败路径。', 来源: '入口隔离夹具核对', 依据: '测试真实知识采用链' });
    await run({ f, org, act, query, submit, log, source });
  } finally { await f.cleanup(); }
}

describe('知识复用声明与治理入口', () => {
  it('省略、显式空和有声明区分落线，来源哈希仅服务捕获且不改变正常交卷', async () => scene(async ({ org, source, submit, query, log }) => {
    const known = await source();
    const omitted = await ready(org, '省略采用');
    const empty = await ready(org, '明确空采用');
    const used = await ready(org, '声明采用');
    assert.equal((await submit(omitted)).节点.状态, '已交卷');
    assert.equal((await submit(empty, { 采用知识: [] })).节点.状态, '已交卷');
    const submitted = await submit(used, { 采用知识: [adoption(known.id)] });
    assert.equal(submitted.节点.状态, '已交卷');
    assert.ok(submitted.节点.独立答案.every(answer => !Object.hasOwn(answer, '采用知识')), '普通任务动作不直接投影声明封套与来源哈希');
    const rows = (await log()).trim().split('\n').map(JSON.parse).filter(row => row.kind === 'submitted');
    assert.equal(Object.hasOwn(rows.find(row => row.id === omitted.id), '采用知识'), false, '省略不能自动补成空声明');
    assert.deepEqual(rows.find(row => row.id === empty.id).采用知识, { 版本: 1, 声明状态: '显式空', 条目: [] });
    const declaration = rows.find(row => row.id === used.id).采用知识;
    assert.equal(declaration.版本, 1);
    assert.equal(declaration.声明状态, '已声明');
    assert.deepEqual(Object.keys(declaration.条目[0]).sort(), [...Object.keys(adoption(known.id)), '来源'].sort());
    assert.equal(declaration.条目[0].来源.状态, '可核来源版本');
    for (const field of ['内容哈希', '元数据哈希']) assert.match(declaration.条目[0].来源[field], /^[a-f0-9]{64}$/);
    assert.ok(Number.isFinite(Date.parse(declaration.条目[0].来源.捕获于)));
    const result = await query();
    assert.equal(result.完整, false);
    assert.equal(result.汇总.交卷记录, 3);
    assert.equal(result.汇总.未说明, 1);
    assert.equal(result.汇总.显式空, 1);
    assert.equal(result.汇总.有声明, 1);
    assert.equal(result.汇总.声明条目, 1);
    assert.equal(result.汇总.有帮助声明, 1);
    assert.equal(result.汇总.来源可核, 1);
    assert.deepEqual(new Set(result.采用页.条目.map(row => row.声明状态)), new Set(['未知', '显式空', '已声明']));
    assert.ok(result.采用页.条目.every(row => row.提交人 === MEMBER.id));
    assert.equal(Object.hasOwn(result, '有效率'), false);
    assert.equal(Object.hasOwn(result, '收益'), false);
  }));

  it('来源缺失保持未核验，声明发现问题不阻断交付或自动处置知识', async () => scene(async ({ org, source, submit, query, act }) => {
    const known = await source();
    const node = await ready(org, '未核来源及问题声明');
    const result = await submit(node, { 采用知识: [{ ...adoption(known.id), 使用结果: '发现问题' }, { ...adoption('know-not-present'), 使用结果: '不适用' }] });
    assert.equal(result.节点.状态, '已交卷');
    const view = await query({ 任务: node.id });
    assert.equal(view.汇总.问题声明, 1);
    assert.equal(view.汇总.不适用声明, 1);
    const missing = view.采用页.条目[0].采用知识.find(row => row.id === 'know-not-present');
    assert.deepEqual(missing.来源, { 状态: '来源未核验' });
    const memory = await act({ action: 'memory_query', id: known.id, 返回模式: '摘要' });
    assert.equal(memory.结果.条目.length, 1, '发现问题只是声明，不能自动失效知识');
  }));

  it('null、坏结构、超界、重复与每项伪封套均在交卷落线前拒绝', async () => scene(async ({ org, submit, log }) => {
    const node = await ready(org, '声明验证反例');
    const valid = adoption('know-reference');
    const before = await log();
    for (const 采用知识 of [null, {}, '[]', [null], [valid, valid], Array.from({ length: 17 }, (_, i) => adoption(`know-${i}`)),
      [{ ...valid, id: 'x'.repeat(257) }], [{ ...valid, 用途: '' }], [{ ...valid, 用途: '用'.repeat(513) }], [{ ...valid, 适用判断: '判'.repeat(513) }],
      [{ ...valid, 使用结果: '确定有效' }], [{ ...valid, 说明: '说'.repeat(1025) }], ...['来源', '内容哈希', '元数据哈希', '版本', 'subject', '读域', '执行计划'].map(key => [{ ...valid, [key]: 'forged' }])]) {
      await assert.rejects(() => submit(node, { 采用知识 }), error => error instanceof InvalidBody, JSON.stringify(采用知识));
      assert.equal(await log(), before, '无效采用声明不能留下submitted事件');
    }
    assert.equal((await org.tasks.get(node.id, { 项目: P })).状态, '执行中');
  }));

  it('提交顶层封套、哈希及来源不能伪报，严格查询只接受过滤和有限分页', async () => scene(async ({ org, submit, query, log }) => {
    const node = await ready(org, '顶层伪造');
    const before = await log();
    for (const key of ['采用知识版本', '声明状态', '来源', '内容哈希', '元数据哈希', '采用知识封套', '执行计划', 'subject', '主体', '读域', '认证']) {
      await assert.rejects(() => submit(node, { [key]: 'forged' }), error => error instanceof InvalidBody, key);
      await assert.rejects(() => query({ [key]: 'forged' }), invalid, key);
    }
    for (const key of ['id', 'role', '岗位', '面', '审批引用', '含失效', '结果', '排行']) await assert.rejects(() => query({ [key]: 'forged' }), invalid, key);
    for (const args of [{ 条数: 0 }, { 条数: 51 }, { 条数: Infinity }, { 偏移: -1 }, { 偏移: 0.5 }, { 数据版本: 'forged' }]) await assert.rejects(() => query(args), invalid);
    assert.equal(await log(), before);
  }));

  it('成员、复核员、伪Lead及停岗Lead没有汇总读域，真实policy.read仍复判', async () => scene(async ({ org, submit, query }) => {
    const node = await ready(org, '治理读取');
    await submit(node, { 采用知识: [] });
    for (const subject of [MEMBER, REVIEWER, { id: MEMBER.id, kind: 'Lead' }]) await assert.rejects(() => query({ 任务: node.id }, subject), error => error instanceof Denied);
    assert.equal((await query({}, SOVEREIGN)).汇总.交卷记录, 1);
    const check = org.policy.check.bind(org.policy);
    org.policy.check = async spec => {
      if (spec.action === 'read') throw new Denied('测试当前读策略', '汇总读取被撤回');
      return check(spec);
    };
    await assert.rejects(() => query(), error => error instanceof Denied);
    org.policy.check = check;
    await org.registry.seal({ subject: SOVEREIGN, 实例: LEAD.id, 理由: '当前治理卡资格复判' });
    await assert.rejects(() => query(), error => error instanceof Denied);
  }));

  it('精确知识及任务过滤保持项目隔离，稳定版本续页且纯查询不追加事实或审计', async () => scene(async ({ f, org, act, submit, query, log }) => {
    const a = await ready(org, '分页一');
    const b = await ready(org, '分页二');
    const other = await ready(org, '另一项目', Q);
    await submit(a, { 采用知识: [adoption('know-a')] });
    await submit(b, { 采用知识: [adoption('know-b')] });
    await runAction({ org, 项目: Q, 主体: MEMBER, subject: MEMBER, args: { action: 'task_submit', id: other.id, 结论: '另一项目交卷', 采用知识: [adoption('know-a')] } });
    const audit = await org.audit.read({});
    const before = await log();
    const page = await query({ 条数: 1 });
    await assert.rejects(() => query({ 条数: 1, 偏移: page.采用页.下一偏移 }), invalid, '续页须显式钉住数据版本');
    const next = await query({ 条数: 1, 偏移: page.采用页.下一偏移, 数据版本: page.数据版本 });
    assert.equal(page.汇总.交卷记录, 2);
    assert.deepEqual(next.汇总, page.汇总);
    assert.equal(page.采用页.条目.length, 1);
    assert.equal(next.采用页.条目.length, 1);
    assert.notEqual(page.采用页.条目[0].提交序, next.采用页.条目[0].提交序);
    assert.equal(next.采用页.hasMore, false);
    const filtered = await query({ 知识id: 'know-a' });
    assert.deepEqual(filtered.采用页.条目.map(row => row.任务), [a.id]);
    assert.equal((await query({ 任务: a.id, 知识id: 'know-b' })).采用页.总数, 0);
    assert.equal((await query({ 知识id: 'know-' })).采用页.总数, 0);
    assert.equal((await act({ action: 'knowledge_reuse_query', project: Q })).知识复用.汇总.交卷记录, 1);
    assert.equal(await log(), before);
    assert.deepEqual(await org.audit.read({}), audit);
    const reopened = await Org.open(configFor(f));
    const restored = await reopened.knowledgeReuse.query({ subject: LEAD, 项目: P, 任务: a.id });
    assert.equal(restored.采用页.条目[0].声明状态, '已声明');
    assert.equal(await log(), before, '重装配不能改写历史声明');
    const newer = await ready(org, '分页版本变化');
    await submit(newer);
    await assert.rejects(() => query({ 条数: 1, 偏移: page.采用页.下一偏移, 数据版本: page.数据版本 }), invalid);
  }));
});

it('真实工具/命令共用知识复用读入口及结构声明，schema保持精确仅读分类', async () => {
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
    assert.ok(ACTIONS.includes('knowledge_reuse_query'));
    assert.ok(COMMAND_ACTIONS.includes('knowledge_reuse_query'));
    assert.ok(READ_ONLY_ACTIONS.includes('knowledge_reuse_query'));
    assert.equal(是写动作('knowledge_reuse_query'), false);
    assert.equal(是写动作('task_submit'), true);
    assert.equal(tool.isConcurrencySafe({ action: 'knowledge_reuse_query' }), true);
    assert.equal(tool.isConcurrencySafe({ action: 'task_submit' }), false);
    assert.ok(tool.parameters.properties.action.enum.includes('knowledge_reuse_query'));
    const schema = tool.parameters.properties.采用知识;
    assert.equal(schema.type, 'array');
    assert.equal(schema.maxItems, 16);
    assert.equal(schema.items.additionalProperties, false);
    assert.deepEqual(schema.items.required, ['id', '用途', '适用判断', '使用结果']);
    assert.deepEqual(schema.items.properties.使用结果.enum, ['有帮助', '不适用', '发现问题', '未知']);
    assert.equal(schema.items.properties.id.maxLength, 256);
    assert.equal(schema.items.properties.用途.maxLength, 512);
    assert.equal(schema.items.properties.适用判断.maxLength, 512);
    assert.equal(schema.items.properties.说明.maxLength, 1024);
    assert.equal(tool.parameters.properties.知识id.maxLength, 256);
    assert.match(tool.description, /声明及历史采纳不证明知识有效或带来收益/);
    for (const action of ['knowledge_reuse_record', 'knowledge_reuse_rank', 'knowledge_reuse_promote', 'knowledge_reuse_reset']) {
      assert.equal(ACTIONS.includes(action), false);
      assert.equal(COMMAND_ACTIONS.includes(action), false);
    }
    const member = { session: { id: MEMBER.id, header: { origin: 'subagent', cwd } } };
    const lead = { session: { id: LEAD.id, header: { cwd } } };
    const exec = agent => ({ name: 'mind', agent, signal: new AbortController().signal });
    const a = await ready(org, '真实工具交卷');
    const submitted = JSON.parse(await tool.execute({ action: 'task_submit', id: a.id, 结论: 'true', 采用知识: [adoption('know-tool')] }, exec(member)));
    assert.equal(submitted.成功, true, JSON.stringify(submitted));
    const b = await ready(org, '真实命令交卷');
    const item = { ...adoption('know-command'), 用途: 'false', 适用判断: 'true', 使用结果: '未知' };
    const submittedCommand = JSON.parse((await command.handler({ agent: member, rawInput: `task_submit ${JSON.stringify({ id: b.id, 结论: 'false', 采用知识: JSON.stringify([item]) })}` })).text);
    assert.equal(submittedCommand.成功, true, JSON.stringify(submittedCommand));
    const page = JSON.parse(await tool.execute({ action: 'knowledge_reuse_query', 条数: 1 }, exec(lead)));
    assert.equal(page.成功, true, JSON.stringify(page));
    const next = JSON.parse((await command.handler({ agent: lead, rawInput: `knowledge_reuse_query 条数=1 偏移=${page.知识复用.采用页.下一偏移} 数据版本=${page.知识复用.数据版本}` })).text);
    assert.equal(next.成功, true, JSON.stringify(next));
    assert.deepEqual(next.知识复用.汇总, page.知识复用.汇总);
    assert.notEqual(next.知识复用.采用页.条目[0].提交序, page.知识复用.采用页.条目[0].提交序);
    const commandRead = JSON.parse((await command.handler({ agent: lead, rawInput: `knowledge_reuse_query 任务=${b.id}` })).text);
    assert.equal(commandRead.知识复用.采用页.条目[0].采用知识[0].用途, 'false');
    assert.equal(commandRead.知识复用.采用页.条目[0].采用知识[0].适用判断, 'true');
    const denied = JSON.parse(await tool.execute({ action: 'knowledge_reuse_query' }, exec(member)));
    assert.equal(denied.成功, false);
    const c = await ready(org, '真实命令坏声明');
    const before = await readTextOrNull(f.layout.taskLog(P));
    for (const 采用知识 of [null, '[bad-json']) {
      const bad = JSON.parse((await command.handler({ agent: member, rawInput: `task_submit ${JSON.stringify({ id: c.id, 采用知识 })}` })).text);
      assert.equal(bad.成功, false);
    }
    const spoof = JSON.parse((await command.handler({ agent: lead, rawInput: 'knowledge_reuse_query 内容哈希=forged' })).text);
    assert.equal(spoof.成功, false);
    assert.equal(await readTextOrNull(f.layout.taskLog(P)), before);
  } finally { host.清理(); await f.cleanup(); }
});
