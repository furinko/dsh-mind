/** 受管准入尝试固定单位、持久占用、真实结果结算与人侧配置。 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { makeFixture, LEAD, MEMBER, SOVEREIGN } from './helpers.mjs';
import { TaskGraph } from '../src/tasks.js';
import { GoalBudgetService } from '../src/goal-budget.js';
import { budgetLogPath, readBudgetLedger, readBudgetLedgerSync, parseBudgetLedger } from '../src/budget-ledger.js';
import { digest } from '../src/kernel/text.js';
import { Denied, Fault, InvalidBody } from '../src/kernel/errors.js';

const P = 'budget-domain';
const invalid = (error) => error instanceof Denied || error instanceof Fault || error instanceof InvalidBody;
async function scene(run) {
  const f = await makeFixture();
  try {
    const tasks = new TaskGraph({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock, registry: f.registry });
    const goals = tasks.goals;
    const service = () => new GoalBudgetService({ layout: f.layout, goals, policy: f.policy, audit: f.audit, clock: f.clock, registry: f.registry });
    const budget = service();
    let serial = 0;
    const goal = (extra = {}) => goals.create({ subject: LEAD, 项目: P, 请求键: `budget-goal-${++serial}`, 期望结果: '可复验完成目标', 完成依据: ['独立采纳'], 来源: '调用者意图转述', 下一步: '执行受管工作', ...extra });
    const configure = (node, limit, revision = 0, extra = {}) => budget.configure(node.id, { subject: SOVEREIGN, 项目: P, 预算修订: revision, 上限: limit, ...extra });
    const reserve = (node, extra = {}) => budget.reserve({ subject: LEAD, 项目: P, 目标: node.id, 执行键: randomUUID(), 类别: 'member_spawn', 工具: 'member_spawn', 指纹: digest('normalized-operation'), ...extra });
    const settle = (receipt, result = 'success') => budget.settle({ 项目: P, 目标: receipt.目标, 执行键: receipt.执行键, 结果: result });
    const query = (node, extra = {}) => budget.query(node.id, { subject: LEAD, 项目: P, ...extra });
    const file = budgetLogPath(f.layout, P);
    const rows = () => readBudgetLedger(file);
    await run({ f, tasks, goals, budget, service, goal, configure, reserve, settle, query, rows, file });
  } finally { await f.cleanup(); }
}

describe('目标共享受管准入尝试额度领域', () => {
  it('未配额度明确未知且不记录虚假零用量，合法准入仍为未受管', async () => scene(async ({ budget, goal, reserve, query, rows }) => {
    const node = await goal();
    const result = await query(node);
    for (const field of ['配置', '预算修订', '上限', '累计准入', '已结算', '未决占用', '可准入', 'token', '费用']) assert.equal(result[field], null);
    assert.equal(result.尝试页.总数, null);
    assert.equal(result.尝试页.hasMore, null);
    const receipt = await reserve(node);
    assert.equal(receipt.受管, false);
    assert.equal(receipt.可放行, null);
    assert.equal(receipt.保留状态, 'unmanaged');
    assert.deepEqual(await rows(), []);
    assert.equal(budget.getBudgetSync(node.id, { 项目: P }), null);
  }));

  it('配置只接受真实主权者，查询只接受真实在岗Lead/主权者，来源不产生认证', async () => scene(async ({ budget, goal, query, rows }) => {
    const node = await goal();
    for (const subject of [LEAD, MEMBER, { id: MEMBER.id, kind: 'Lead' }]) await assert.rejects(() => budget.configure(node.id, { subject, 项目: P, 预算修订: 0, 上限: 2, 来源: '本人已批准' }), (error) => error instanceof Denied);
    for (const subject of [MEMBER, { id: MEMBER.id, kind: 'Lead' }, { id: 'ghost', kind: 'Lead' }]) await assert.rejects(() => query(node, { subject }), (error) => error instanceof Denied);
    assert.deepEqual(await rows(), []);
    const result = await budget.configure(node.id, { subject: SOVEREIGN, 项目: P, 预算修订: 0, 上限: 2, 来源: '人侧主体的配置来源声明' });
    assert.equal(result.预算修订, 1);
    assert.deepEqual(result.配置.来源声明, { 内容: '人侧主体的配置来源声明', 性质: '调用者声明' });
    assert.equal((await query(node, { subject: SOVEREIGN })).累计准入, 0);
  }));

  it('配置修订只随人侧配置增加，调低到累计以下不清历史或恢复目标', async () => scene(async ({ goals, goal, configure, reserve, settle, query }) => {
    let node = await goal();
    await configure(node, 3);
    const a = await reserve(node);
    await settle(a, 'error');
    await reserve(node);
    assert.equal((await query(node)).预算修订, 1);
    node = await goals.setState(node.id, { subject: SOVEREIGN, 项目: P, 修订: node.修订, 状态: '暂停' });
    const lowered = await configure(node, 0, 1);
    assert.equal(lowered.预算修订, 2);
    assert.equal(lowered.累计准入, 2);
    assert.equal(lowered.已结算, 1);
    assert.equal(lowered.未决占用, 1);
    assert.equal(lowered.可准入, 0);
    assert.equal((await goals.get(node.id, { subject: SOVEREIGN, 项目: P })).状态, '暂停');
    await assert.rejects(() => configure(node, 20, 1), (error) => error instanceof Denied);
  }));

  it('冻结配置计划绑定主体/目标/输入/当前状态，不能把旧预览跟随新用量落线', async () => scene(async ({ budget, goal, configure, reserve, rows }) => {
    const node = await goal();
    await configure(node, 2);
    const spec = { id: node.id, subject: SOVEREIGN, 项目: P, 预算修订: 1, 上限: 4 };
    const plan = await budget.plan('budget_configure', spec);
    assert.equal(Object.isFrozen(plan.预览), true);
    assert.equal(plan.步骤[0].写, 'budget_configure');
    await assert.rejects(() => budget.configure(node.id, { ...spec, 上限: 5, 执行计划: plan }), (error) => error instanceof InvalidBody);
    await assert.rejects(() => budget.configure(node.id, { ...spec, subject: LEAD, 执行计划: plan }), (error) => error instanceof InvalidBody);
    await reserve(node);
    const before = await rows();
    await assert.rejects(() => budget.configure(node.id, { ...spec, 执行计划: plan }), (error) => error instanceof Denied);
    assert.deepEqual(await rows(), before);
    await assert.rejects(() => budget.plan('budget_configure', { ...spec, 执行计划: {} }), (error) => error instanceof InvalidBody);
  }));

  it('所有首次准入固定消耗1，失败/后续拒绝与未知均不退；耗尽不修改目标', async () => scene(async ({ goal, configure, reserve, settle, query, goals }) => {
    const node = await goal();
    await configure(node, 3);
    const success = await reserve(node);
    assert.equal(success.单位, 1);
    assert.equal(success.可放行, true);
    await settle(success, 'success');
    const rejectedLater = await reserve(node);
    await settle(rejectedLater, 'error');
    await reserve(node); // 无结果回执，持续占用。
    const state = await query(node);
    assert.equal(state.累计准入, 3);
    assert.equal(state.已结算, 2);
    assert.equal(state.未决占用, 1);
    assert.equal(state.可准入, 0);
    await assert.rejects(() => reserve(node), (error) => error instanceof Denied && /耗尽/.test(error.rule));
    assert.equal((await goals.get(node.id, { subject: LEAD, 项目: P })).状态, '进行中');
    assert.equal(state.token, null);
    assert.equal(state.费用, null);
  }));

  it('同执行键同规范只认回占用且不重新放行，多输入冲突零追加', async () => scene(async ({ goal, configure, reserve, settle, rows }) => {
    const node = await goal();
    const other = await goal();
    await configure(node, 3);
    await configure(other, 3);
    const key = randomUUID();
    const original = await reserve(node, { 执行键: key });
    const before = await rows();
    const repeated = await reserve(node, { 执行键: key });
    assert.equal(repeated.幂等, true);
    assert.equal(repeated.可放行, false);
    assert.equal(repeated.保留状态, 'reserved');
    for (const extra of [{ 指纹: digest('different') }, { 类别: 'member_file', 工具: 'read' }, { subject: MEMBER, 类别: 'member_file', 工具: 'read' }]) await assert.rejects(() => reserve(node, { 执行键: key, ...extra }), invalid);
    await assert.rejects(() => reserve(other, { 执行键: key }), (error) => error instanceof Denied);
    assert.deepEqual(await rows(), before);
    await settle(original);
    const settled = await reserve(node, { 执行键: key });
    assert.equal(settled.保留状态, 'settled');
    assert.equal(settled.可放行, false);
  }));

  it('多服务竞争最后1个额度只准入一次，独立目标保留自己的额度', async () => scene(async ({ budget, service, goal, configure, reserve, query, rows }) => {
    const node = await goal();
    const independent = await goal();
    await configure(node, 1);
    await configure(independent, 1);
    const specs = Array.from({ length: 4 }, () => ({ subject: LEAD, 项目: P, 目标: node.id, 执行键: randomUUID(), 类别: 'member_spawn', 工具: 'member_spawn', 指纹: digest('same operation but separate calls') }));
    const results = await Promise.allSettled(specs.map((spec, index) => (index % 2 ? service() : budget).reserve(spec)));
    assert.equal(results.filter((result) => result.status === 'fulfilled' && result.value.可放行).length, 1);
    assert.equal((await query(node)).累计准入, 1);
    assert.equal((await rows()).filter((row) => row.kind === 'budget_reserved' && row.id === node.id).length, 1);
    assert.equal((await reserve(independent)).可放行, true);
  }));

  it('真实成员与Lead准入校验角色/卡凭证，未知主体和角色自报不消耗', async () => scene(async ({ goal, configure, reserve, rows }) => {
    const node = await goal();
    await configure(node, 2);
    const before = await rows();
    for (const subject of [{ id: 'ghost', kind: '成员', roleId: '插件工程' }, { ...MEMBER, roleId: '别的岗位' }, { id: MEMBER.id, kind: 'Lead' }, SOVEREIGN, { ...LEAD, roleId: '插件工程' }]) await assert.rejects(() => reserve(node, { subject, 类别: 'member_file', 工具: 'write' }), invalid);
    await assert.rejects(() => reserve(node, { subject: MEMBER }), (error) => error instanceof Denied);
    assert.deepEqual(await rows(), before);
    assert.equal((await reserve(node, { subject: MEMBER, 类别: 'member_file', 工具: 'read' })).可放行, true);
    assert.equal((await reserve(node)).可放行, true);
  }));

  for (const revoked of ['member-a', 'lead', '插件工程', 'goal']) it(`真实撤回${revoked}后新准入拒绝且不计数`, async () => scene(async ({ f, goal, configure, reserve, rows }) => {
    const node = await goal();
    await configure(node, 2);
    await f.registry.revoke({ subject: SOVEREIGN, 对象id: revoked === 'goal' ? node.id : revoked, 理由: '真实撤回测试' });
    const before = await rows();
    await assert.rejects(() => reserve(node, { subject: MEMBER, 类别: 'member_file', 工具: 'write' }), (error) => error instanceof Denied);
    assert.deepEqual(await rows(), before);
  }));

  it('目标暂停、实例封存、失联或策略故障阻止新准入，内部迟到结果仍可结算', async () => scene(async ({ f, goals, goal, configure, reserve, settle, query }) => {
    let node = await goal();
    await configure(node, 2);
    const pending = await reserve(node);
    node = await goals.setState(node.id, { subject: SOVEREIGN, 项目: P, 修订: node.修订, 状态: '暂停' });
    await assert.rejects(() => reserve(node), (error) => error instanceof Denied);
    await f.registry.seal({ subject: SOVEREIGN, 实例: LEAD.id, 理由: '真实实例已退场' });
    const settled = await settle(pending, 'error');
    assert.equal(settled.保留状态, 'settled');
    const state = await query(node, { subject: SOVEREIGN });
    assert.equal(state.累计准入, 1);
    assert.equal(state.已结算, 1);
    assert.equal(state.可准入, 1);
  }));

  it('当前失联和策略损坏不能以旧内存资格准入', async () => scene(async ({ f, goal, configure, reserve, rows }) => {
    const node = await goal();
    await configure(node, 2);
    const file = f.layout.identityFile();
    const raw = await readFile(file, 'utf8');
    const identity = JSON.parse(raw);
    identity.sovereign.lastInteraction = '2000-01-01T00:00:00.000Z';
    await writeFile(file, JSON.stringify(identity));
    const before = await rows();
    await assert.rejects(() => reserve(node), invalid);
    assert.deepEqual(await rows(), before);
    await writeFile(file, raw);
    await f.policy.reload();
    await f.write('集体L1-法律/权限矩阵.md', '```policy\n{ malformed policy JSON }\n```');
    await assert.rejects(() => reserve(node), invalid);
    assert.deepEqual(await rows(), before);
  }));

  it('重启保留未知占用，迟到相同结果只结一次，冲突结果不能覆盖或返还', async () => scene(async ({ budget, service, goal, configure, reserve, settle, query, rows }) => {
    const node = await goal();
    await configure(node, 1);
    const receipt = await reserve(node);
    const reopened = service();
    assert.equal(reopened.getBudgetSync(node.id, { 项目: P }).未决占用, 1);
    await assert.rejects(() => reopened.reserve({ subject: LEAD, 项目: P, 目标: node.id, 执行键: randomUUID(), 工具: 'member_spawn', 类别: 'member_spawn', 指纹: digest('new') }), (error) => error instanceof Denied);
    await settle(receipt, 'error');
    const before = await rows();
    const again = await reopened.settle({ 项目: P, 目标: node.id, 执行键: receipt.执行键, 结果: 'error' });
    assert.equal(again.幂等, true);
    await assert.rejects(() => settle(receipt, 'success'), (error) => error instanceof Denied);
    assert.deepEqual(await rows(), before);
    const state = await query(node);
    assert.equal(state.累计准入, 1);
    assert.equal(state.已结算, 1);
    assert.equal(state.未决占用, 0);
    assert.equal(state.可准入, 0);
    await assert.rejects(() => budget.settle({ 项目: P, 目标: node.id, 执行键: 'unknown', 结果: 'success' }), (error) => error instanceof Denied);
  }));

  it('reserve事件已落而审计失败不签发许可，同key认回仍不可放行且不补造审计', async () => scene(async ({ f, goal, configure, reserve, query, rows }) => {
    const node = await goal();
    await configure(node, 2);
    const append = f.audit.append.bind(f.audit);
    let failed = false;
    const key = randomUUID();
    f.audit.append = async (entry) => { if (!failed && entry.依据 === '目标额度事件流' && entry.结果 === 'budget_reserved') { failed = true; throw new Error('audit failed after reserve'); } return append(entry); };
    await assert.rejects(() => reserve(node, { 执行键: key }), (error) => { assert.equal(error.code, 'GOAL_BUDGET_AUDIT_APPEND_FAILED_AFTER_EVENT'); assert.equal(error.outcome.提交状态, '已提交'); assert.equal(error.outcome.可重试, false); assert.equal(error.outcome.已确认阶段[0].对象id, node.id); assert.equal(error.outcome.已确认阶段[0].执行键, key); assert.equal(error.outcome.已确认阶段[0].预算目标, node.id); assert.equal(error.detail.执行键, key); return true; });
    assert.equal((await query(node)).未决占用, 1);
    const before = await rows();
    let events = 0;
    f.audit.append = async (entry) => { if (entry.依据 === '目标额度事件流') events += 1; return append(entry); };
    assert.equal((await reserve(node, { 执行键: key })).可放行, false);
    assert.equal(events, 0);
    assert.deepEqual(await rows(), before);
  }));

  for (const operation of ['configure', 'settle']) it(`${operation}提交后审计失败保留事实，重启不会误清累计`, async () => scene(async ({ f, budget, service, goal, configure, reserve, settle, query }) => {
    const node = await goal();
    let receipt;
    if (operation === 'settle') { await configure(node, 1); receipt = await reserve(node); }
    const append = f.audit.append.bind(f.audit);
    const kind = operation === 'configure' ? 'budget_configured' : 'budget_settled';
    f.audit.append = async (entry) => { if (entry.依据 === '目标额度事件流' && entry.结果 === kind) throw new Error('audit failure'); return append(entry); };
    await assert.rejects(() => operation === 'configure' ? configure(node, 1) : settle(receipt), (error) => error instanceof Fault && error.outcome?.提交状态 === '已提交');
    f.audit.append = append;
    const state = service().getBudgetSync(node.id, { 项目: P });
    assert.equal(state.预算修订, 1);
    if (operation === 'settle') { assert.equal(state.累计准入, 1); assert.equal(state.已结算, 1); assert.equal(state.可准入, 0); assert.equal((await settle(receipt)).幂等, true); }
    else { await assert.rejects(() => configure(node, 1), (error) => error instanceof Denied); assert.equal((await query(node)).上限, 1); }
    assert.equal(budget.getBudgetSync(node.id, { 项目: P }).预算修订, 1);
  }));

  for (const corruption of ['json', 'torn', 'unknown', 'seq', 'revision', 'duplicate-reserve', 'unit', 'over-quota', 'orphan-result', 'duplicate-result']) it(`严格账本${corruption}异常使查询/准入/结算同步异步一并拒绝`, async () => scene(async ({ budget, goal, configure, reserve, settle, query, file, rows }) => {
    const node = await goal();
    await configure(node, 1);
    const receipt = await reserve(node);
    if (corruption === 'duplicate-result') await settle(receipt);
    const existing = await rows();
    let text;
    const last = existing.at(-1);
    const addition = { ...existing[1], seq: existing.length + 1 };
    if (corruption === 'json') text = existing.map((row) => JSON.stringify(row)).join('\n') + '\n{bad}\n';
    else if (corruption === 'torn') text = existing.map((row) => JSON.stringify(row)).join('\n');
    else {
      if (corruption === 'unknown') addition.kind = 'constructor';
      if (corruption === 'seq') addition.seq += 10;
      if (corruption === 'revision') { Object.assign(addition, existing[0], { seq: existing.length + 1 }); }
      if (corruption === 'unit') addition.单位 = 0;
      if (corruption === 'over-quota') addition.执行键 = randomUUID();
      if (corruption === 'orphan-result') { for (const key of Object.keys(addition)) delete addition[key]; Object.assign(addition, { seq: existing.length + 1, at: last.at, by: { id: 'goal-budget-host-result', kind: '系统' }, kind: 'budget_settled', id: node.id, 执行键: 'missing', 结果: 'success' }); }
      if (corruption === 'duplicate-result') Object.assign(addition, last, { seq: existing.length + 1 });
      text = [...existing, addition].map((row) => JSON.stringify(row)).join('\n') + '\n';
    }
    await writeFile(file, text);
    assert.throws(() => budget.getBudgetSync(node.id, { 项目: P }), (error) => error.code === 'GOAL_BUDGET_LEDGER_INVALID');
    await assert.rejects(() => query(node), (error) => error.code === 'GOAL_BUDGET_LEDGER_INVALID');
    await assert.rejects(() => reserve(node), (error) => error.code === 'GOAL_BUDGET_LEDGER_INVALID');
    await assert.rejects(() => settle(receipt), (error) => error.code === 'GOAL_BUDGET_LEDGER_INVALID');
    assert.equal(await readFile(file, 'utf8'), text);
  }));

  it('BOM/CRLF兼容，返回对象污染不影响下次真源；query分页但统计全量', async () => scene(async ({ budget, goal, configure, reserve, settle, query, file, rows }) => {
    const node = await goal();
    await configure(node, 4);
    for (let i = 0; i < 4; i += 1) { const receipt = await reserve(node); if (i < 2) await settle(receipt, i ? 'error' : 'success'); }
    const original = await readFile(file, 'utf8');
    await writeFile(file, '\ufeff' + original.replaceAll('\n', '\r\n'));
    assert.deepEqual(readBudgetLedgerSync(file), await rows());
    assert.deepEqual(parseBudgetLedger(await readFile(file, 'utf8')), await rows());
    const page = await query(node, { 条数: 2, 偏移: 1 });
    assert.equal(page.尝试页.条目.length, 2);
    assert.equal(page.尝试页.总数, 4);
    assert.equal(page.尝试页.hasMore, true);
    assert.equal(page.累计准入, 4);
    assert.equal(page.已结算, 2);
    assert.equal(page.未决占用, 2);
    page.配置.上限 = 100;
    const raw = budget.rawSnapshot(P);
    raw.预算[0].尝试.length = 0;
    assert.equal((await query(node)).配置.上限, 4);
    assert.equal(budget.rawSnapshot(P).预算[0].尝试.length, 4);
  }));

  it('自报用量、单位、释放、token费用与未知结果字段一律拒绝', async () => scene(async ({ budget, goal, configure, reserve, rows }) => {
    const node = await goal();
    await configure(node, 2);
    const before = await rows();
    for (const field of ['累计准入', '已结算', '未决占用', '可准入', 'token', '费用', '释放', '清零', '执行键', '认证', '受管']) {
      await assert.rejects(() => budget.configure(node.id, { subject: SOVEREIGN, 项目: P, 预算修订: 1, 上限: 2, [field]: 0 }), (error) => error instanceof InvalidBody);
      await assert.rejects(() => budget.query(node.id, { subject: LEAD, 项目: P, [field]: 0 }), (error) => error instanceof InvalidBody);
    }
    await assert.rejects(() => reserve(node, { 单位: 0 }), (error) => error instanceof InvalidBody);
    await assert.rejects(() => budget.settle({ 项目: P, 目标: node.id, 执行键: 'none', 结果: 'unknown' }), (error) => error instanceof InvalidBody);
    assert.deepEqual(await rows(), before);
  }));
});
