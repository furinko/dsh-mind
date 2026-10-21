/** 作者适用说明与期限走真实动作；期限不认证知识、不改变状态或扩大读域。 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { makeFixture, LEAD, MEMBER, REVIEWER } from './helpers.mjs';
import { fakeHost } from './host-harness.mjs';
import { Org } from '../src/org.js';
import { shareOrg } from '../src/runtime.js';
import { readTextOrNull } from '../src/kernel/fsx.js';
import { runAction, ACTIONS, READ_ONLY_ACTIONS } from '../lib/actions.js';
import { Denied, InvalidBody } from '../src/kernel/errors.js';
import * as kernel from '../components/kernel/lib/index.js';

const P = 'knowledge-applicability-entry';
const Q = 'knowledge-applicability-other';
const configFor = f => ({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
const future = '2099-12-31T23:59:59.123Z';
const past = '2020-01-01T00:00:00Z';
const context = () => ({ 适用条件: ['输入遵循同一接口契约'], 已知反例: ['外部状态已变化时不直接复用'], 复验条件: ['接口或证据变化'], 复验期限: future });
const invalid = error => error instanceof InvalidBody || error instanceof Denied;
const writeArgs = (extra = {}) => ({ action: 'memory_write', 类: '知识', 内容: '可复用检查：先核对当前边界。', 来源: '隔离验证证据', 岗位: MEMBER.roleId, ...extra });

async function scene(run, options = {}) {
  const f = await makeFixture(options);
  try {
    const org = await Org.open(configFor(f));
    const act = (args, subject = LEAD) => runAction({ org, 项目: P, 主体: subject, subject, 面: 'tool', args });
    const query = async (args = {}, subject = LEAD) => (await act({ action: 'memory_query', 类: '知识', ...args }, subject)).结果;
    const log = () => readTextOrNull(f.layout.memoryLog(P, '知识'));
    await run({ f, org, act, query, log });
  } finally { await f.cleanup(); }
}

async function ready(org, label, actor = MEMBER, extra = {}) {
  const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: label, 负责人: actor.roleId, 判据: ['交付可复验'], ...extra });
  await org.tasks.bind(node.id, { subject: LEAD, 项目: P, 实例: actor.id, 岗位: actor.roleId });
  await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
  await org.tasks.start(node.id, { subject: actor, 项目: P });
  return node;
}

describe('知识适用说明动作合同', () => {
  it('普通写入可保留合法说明，省略不补说明或永久有效结论', async () => scene(async ({ act, query, log }) => {
    const omitted = (await act(writeArgs())).条目;
    const declared = (await act(writeArgs({ 知识说明: context() }))).条目;
    const rows = (await log()).trim().split('\n').map(JSON.parse);
    assert.equal(Object.hasOwn(rows.find(row => row.id === omitted.id), '知识说明'), false);
    assert.deepEqual(rows.find(row => row.id === declared.id).知识说明, context());
    const result = await query();
    const a = result.条目.find(row => row.id === omitted.id);
    const b = result.条目.find(row => row.id === declared.id);
    assert.equal(a.复验状态, '未设期限');
    assert.match(a.复验警示, /不等于永远有效/);
    assert.equal(b.复验状态, '期限内');
    assert.deepEqual(b.知识说明, context());
    assert.match(b.复验警示, /不代表机器已经验证/);
    assert.equal(Object.hasOwn(b, '已验证'), false);
  }));

  it('null、未知/验证/hash字段、非法数组及非规范UTC均零知识写入；非知识类不可附说明', async () => scene(async ({ f, org, act, log }) => {
    const before = await log();
    const bad = [null, {}, [], { 适用条件: [] }, { 已知反例: [''] }, { 复验条件: ['判'.repeat(513)] }, { 适用条件: Array(17).fill('x') },
      ...['验证状态', '已验证', 'verified', '内容哈希', '元数据哈希', 'hash', '认证'].map(key => ({ 适用条件: ['x'], [key]: 'forged' })),
      ...['2026-10-21', '2026-10-21T00:00Z', '2026-10-21T00:00:00', '2026-10-21T08:00:00+08:00', '2026-02-30T00:00:00Z', '2026-10-21T00:00:00.1Z'].map(复验期限 => ({ 复验期限 }))];
    for (const 知识说明 of bad) {
      await assert.rejects(() => act(writeArgs({ 知识说明 })), error => error instanceof InvalidBody, JSON.stringify(知识说明));
      assert.equal(await log(), before);
    }
    for (const key of ['验证状态', '已验证', 'verified', '内容哈希', '元数据哈希', 'hash', '认证', 'subject', '读域']) {
      await assert.rejects(() => act(writeArgs({ [key]: 'forged' })), error => error instanceof InvalidBody, key);
      assert.equal(await log(), before);
    }
    for (const 类 of ['经历', '偏好', '作答']) await assert.rejects(() => act(writeArgs({ 类, 知识说明: { 适用条件: ['x'] } })), error => error instanceof InvalidBody, 类);
    assert.equal(await log(), before);
    await f.write('集体L2-共享基础设施/defaults/介入度.json', JSON.stringify({ 介入度: '审批' }));
    assert.equal(await org.policy.reload(), true);
    const requests = await org.intervention.投影({ 项目: P });
    for (const extra of [{ verified: true }, { 知识说明: { 验证状态: '已验证' } }, { 知识说明: null }]) {
      await assert.rejects(() => act(writeArgs(extra)), error => error instanceof InvalidBody);
      assert.deepEqual(await org.intervention.投影({ 项目: P }), requests, '非法参数必须先于介入请求拒绝');
    }
    assert.equal(await log(), before);
  }));

  it('仅overturn为新替代条目附新说明，不继承旧说明；其他生命周期明确拒绝而不改状态', async () => scene(async ({ act, query, log }) => {
    const a = (await act(writeArgs({ 知识说明: context() }))).条目;
    const before = await log();
    for (const op of ['invalidate', 'demote', 'promote', 'purge']) {
      await assert.rejects(() => act({ action: 'memory_lifecycle', op, id: a.id, 原因: '不应静默写入', 知识说明: { 已知反例: ['x'] } }), error => error instanceof InvalidBody, op);
      assert.equal(await log(), before);
    }
    await assert.rejects(() => act({ action: 'memory_lifecycle', op: 'invalidate', id: a.id, 原因: '伪状态', 验证状态: '已验证' }), error => error instanceof InvalidBody);
    assert.equal(await log(), before);
    const first = await act({ action: 'memory_lifecycle', op: 'overturn', id: a.id, 原因: '旧说法被新证据替换', 新条目: '替代知识一' });
    const b = (await query({ id: first.结果.新条目 })).条目[0];
    assert.equal(Object.hasOwn(b, '知识说明'), false, '旧期限或适用条件不自动背书替代知识');
    assert.equal(b.复验状态, '未设期限');
    const replacementContext = { 适用条件: ['新接口'], 复验期限: future };
    const second = await act({ action: 'memory_lifecycle', op: 'overturn', id: b.id, 原因: '再次更新', 新条目: '替代知识二', 知识说明: replacementContext });
    assert.deepEqual((await query({ id: second.结果.新条目 })).条目[0].知识说明, replacementContext);
  }));

  it('期限到期默认连id也不建议，显式读取只放宽复验筛选；双flag与失效交集不改事实', async () => scene(async ({ act, query, log }) => {
    const active = (await act(writeArgs({ 知识说明: { 复验期限: past } }))).条目;
    const invalidated = (await act(writeArgs({ 内容: '已失效且待复验的历史知识', 知识说明: { 复验期限: past } }))).条目;
    await act({ action: 'memory_lifecycle', op: 'invalidate', id: invalidated.id, 原因: '反例证据已确认' });
    const before = await log();
    assert.equal((await query({ id: active.id })).条目.length, 0);
    assert.equal((await query({ 含待复验: false })).条目.length, 0);
    const explicit = await query({ 含待复验: true });
    assert.deepEqual(explicit.条目.map(row => row.id), [active.id]);
    assert.equal(explicit.条目[0].复验状态, '待复验');
    assert.match(explicit.条目[0].复验警示, /不代表知识已失效/);
    assert.equal((await query({ 含失效: true })).条目.length, 0, '含失效不替代含待复验');
    const history = await query({ 含待复验: true, 含失效: true });
    assert.deepEqual(new Set(history.条目.map(row => row.id)), new Set([active.id, invalidated.id]));
    assert.equal(await log(), before, '期限读取和显式历史读取都不追加状态');
    for (const 含待复验 of [1, null, 'true', 'false', {}, []]) await assert.rejects(() => query({ 含待复验 }), error => error instanceof InvalidBody);
    await assert.rejects(() => act(writeArgs({ 含待复验: true })), error => error instanceof InvalidBody);
    await assert.rejects(() => act({ action: 'memory_lifecycle', op: 'invalidate', id: active.id, 原因: '不应执行', 含待复验: true }), error => error instanceof InvalidBody);
    assert.equal(await log(), before);
  }));

  it('待复验不阻断正常task_submit；显式flag仍不能扩大项目与复核任务读域', async () => scene(async ({ org, act, query }) => {
    const a = await ready(org, '可复核来源');
    const b = await ready(org, '读域外来源');
    const allowed = (await act(writeArgs({ 来源引用: [a.id], 知识说明: { 复验期限: past } }))).条目;
    const denied = (await act(writeArgs({ 来源引用: [b.id], 知识说明: { 复验期限: past } }))).条目;
    const other = (await act(writeArgs({ project: Q, 依据: '隔离项目测试', 知识说明: { 复验期限: past } }))).条目;
    const review = await ready(org, '精确复核任务', REVIEWER, { 复核对象: [a.id] });
    assert.ok(review.id);
    assert.equal((await query({}, REVIEWER)).条目.length, 0);
    const scoped = await query({ 含待复验: true, 含失效: true }, REVIEWER);
    assert.deepEqual(scoped.条目.map(row => row.id), [allowed.id]);
    assert.equal((await query({ id: denied.id, 含待复验: true }, REVIEWER)).条目.length, 0);
    assert.equal((await query({ id: other.id, 含待复验: true })).条目.length, 0);
    await assert.rejects(() => query({ project: Q, 含待复验: true }, MEMBER), error => error instanceof Denied);
    const submitted = await act({ action: 'task_submit', id: a.id, 结论: '按当前证据交付', 采用知识: [{ id: allowed.id, 用途: '历史参考', 适用判断: '本次重新核对', 使用结果: '未知' }] }, MEMBER);
    assert.equal(submitted.节点.状态, '已交卷');
  }));
});

const CURATOR = { id: 'curator', kind: '成员', roleId: '记忆整理' };
const curatorCard = `---\nid: 记忆整理\nkind: 身份\nauthority: 自治\nzone: 出厂\ndomain: 个体\nversion: 1\n---\n# 记忆整理\n## 个体L0 · 身份核心\n我是记忆整理。\n### 身份核心\n锁定段。\n## 个体L1 · 规则\n1. 只追加。\n## 个体L2 · 能力引用\n- \`policy-decision\`\n## 个体L3 · 经验引用\n### 占位\n`;

it('记忆整理受限晋升透传说明并参与幂等一致性，仍需真实岗位/执行任务/采纳来源', async () => scene(async ({ org, act, query }) => {
  const source = await ready(org, '受限晋升来源');
  await org.tasks.submit(source.id, { subject: MEMBER, 项目: P, 结论: '真实来源交卷' });
  const reviewed = await org.tasks.review(source.id, { subject: LEAD, 项目: P, 三态: '过' });
  await org.tasks.accept(source.id, { subject: LEAD, 项目: P, 票: reviewed.待采纳.票 });
  const execution = await ready(org, '正式蒸馏任务', CURATOR);
  const args = writeArgs({ 内容: '从采纳来源蒸馏的知识', 来源引用: [source.id], 任务: execution.id, 知识说明: context() });
  const first = await act(args, CURATOR);
  assert.deepEqual((await query({ id: first.条目.id })).条目[0].知识说明, context());
  assert.equal((await act(args, CURATOR)).条目.id, first.条目.id);
  await assert.rejects(() => act({ ...args, 知识说明: { 适用条件: ['换了适用条件'] } }, CURATOR), invalid);
  await assert.rejects(() => act(args, MEMBER), error => error instanceof Denied);
}, { rules: { '集体L3-成员角色卡/记忆整理.md': curatorCard }, members: {
  [MEMBER.id]: { id: MEMBER.id, 岗位: MEMBER.roleId, 代: 1, status: '在岗' },
  [REVIEWER.id]: { id: REVIEWER.id, 岗位: REVIEWER.roleId, 代: 1, status: '在岗' },
  [CURATOR.id]: { id: CURATOR.id, 岗位: CURATOR.roleId, 代: 1, status: '在岗' },
} }));

it('真实tool和command共用结构说明与待复验boolean，文本true/false不改型且不新增动作', async () => {
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
    const schema = tool.parameters.properties.知识说明;
    assert.equal(schema.type, 'object');
    assert.equal(schema.minProperties, 1);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(Object.keys(schema.properties), ['适用条件', '已知反例', '复验条件', '复验期限']);
    for (const field of ['适用条件', '已知反例', '复验条件']) {
      assert.equal(schema.properties[field].minItems, 1);
      assert.equal(schema.properties[field].maxItems, 16);
      assert.equal(schema.properties[field].items.maxLength, 512);
    }
    assert.equal(tool.parameters.properties.含待复验.type, 'boolean');
    assert.equal(READ_ONLY_ACTIONS.includes('memory_query'), true);
    assert.deepEqual(tool.parameters.properties.action.enum, ACTIONS);
    for (const action of ['knowledge_verify', 'memory_verify', 'knowledge_expire']) assert.equal(ACTIONS.includes(action), false);
    const metadata = { 适用条件: ['false'], 已知反例: ['true'], 复验期限: past };
    const written = JSON.parse(await tool.execute(writeArgs({ 知识说明: metadata }), exec));
    assert.equal(written.成功, true, JSON.stringify(written));
    const second = JSON.parse((await command.handler({ agent, rawInput: `memory_write ${JSON.stringify({ 类: '知识', 内容: 'false', 来源: 'true', 知识说明: JSON.stringify(metadata) })}` })).text);
    assert.equal(second.成功, true, JSON.stringify(second));
    const none = JSON.parse((await command.handler({ agent, rawInput: 'memory_query 类=知识 含待复验=false' })).text);
    assert.equal(none.成功, true, JSON.stringify(none));
    assert.equal(none.结果.条目.length, 0);
    const explicit = JSON.parse((await command.handler({ agent, rawInput: `memory_query id=${second.条目.id} 含待复验=true 返回模式=全文` })).text);
    assert.equal(explicit.成功, true, JSON.stringify(explicit));
    assert.equal(explicit.结果.条目[0].内容, 'false');
    assert.deepEqual(explicit.结果.条目[0].知识说明.适用条件, ['false']);
    assert.deepEqual(explicit.结果.条目[0].知识说明.已知反例, ['true']);
    const before = await readTextOrNull(f.layout.memoryLog(P, '知识'));
    const forged = JSON.parse(await tool.execute(writeArgs({ 知识说明: { 已验证: true } }), exec));
    assert.equal(forged.成功, false);
    const malformed = JSON.parse((await command.handler({ agent, rawInput: 'memory_write 类=知识 内容=x 来源=x 知识说明={bad' })).text);
    assert.equal(malformed.成功, false);
    const badFlag = JSON.parse((await command.handler({ agent, rawInput: 'memory_query 含待复验=maybe' })).text);
    assert.equal(badFlag.成功, false);
    assert.equal(await readTextOrNull(f.layout.memoryLog(P, '知识')), before);
    assert.equal((await org.memory.query({ subject: LEAD, 项目: P, 含待复验: true })).条目.length, 2);
  } finally { host.清理(); await f.cleanup(); }
});
