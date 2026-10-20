/** 目标共享的受管准入尝试额度。不是 token、费用或完整工作量上限。 */
import { appendLines, serializeByKey, withLock } from './kernel/fsx.js';
import { canonical, digest } from './kernel/text.js';
import { Denied, Fault, InvalidBody } from './kernel/errors.js';
import { BUDGET_CATEGORIES, BUDGET_FILE_TOOLS, BUDGET_UNIT, budgetLogPath, budgetLockPath, readBudgetLedger, readBudgetLedgerSync, foldBudgetLedger } from './budget-ledger.js';

export const BUDGET_COVERAGE = Object.freeze({ 单位: BUDGET_UNIT, 每次单位: 1,
  类别: Object.freeze(['member_file', 'member_spawn']), 原生文件工具: BUDGET_FILE_TOOLS,
  口径: '只统计本组件受管入口的准入尝试；后续拒绝、失败和未知结果均不退额度。配置前、未接入入口、token与费用用量未知。',
  覆盖token: false, 覆盖费用: false, 自动返还: false });
const RESULT_ACTOR = Object.freeze({ id: 'goal-budget-host-result', kind: '系统' });

export class GoalBudgetService {
  constructor({ layout, goals, policy, audit, clock, registry }) { Object.assign(this, { layout, goals, policy, audit, clock, registry }); }
  #plans = new WeakSet();

  /** 内核只读真源：每次严格读取，不凭缓存猜空配置。 */
  rawSnapshot(project) { this.#project(project); return { 项目: project, 预算: [...foldBudgetLedger(readBudgetLedgerSync(budgetLogPath(this.layout, project))).values()] }; }
  getBudgetSync(id, spec) { this.#id(id); this.#project(spec?.项目); const state = this.rawSnapshot(spec.项目).预算.find((item) => item.目标 === id); return state ? counters(state) : null; }

  async query(id, spec) {
    this.#queryInput(id, spec);
    await this.#governanceActor(spec.subject, false);
    await this.#policy('read', id, spec, 'budget_query');
    this.#goal(id, spec.项目);
    const state = foldBudgetLedger(await readBudgetLedger(budgetLogPath(this.layout, spec.项目))).get(id);
    return budgetView(id, state, spec.条数 ?? 20, spec.偏移 ?? 0);
  }

  /** 人侧配置同源预览；不把来源声明当作真实人侧入口。 */
  async plan(action, args) {
    if (action !== 'budget_configure') throw new InvalidBody('未知目标额度领域动作。');
    this.#configureInput(args?.id, args, false);
    await this.#governanceActor(args.subject, true);
    const plan = this.#configurationPlan(args.id, args, await readBudgetLedger(budgetLogPath(this.layout, args.项目)));
    deepFreeze(plan);
    this.#plans.add(plan);
    return plan;
  }

  async configure(id, spec) {
    this.#configureInput(id, spec, true);
    const args = { ...spec, id };
    const plan = args.执行计划 ?? await this.plan('budget_configure', withoutPlan(args));
    if (!this.#plans.has(plan) || plan.动作 !== 'budget_configure' || plan.目标id !== id || plan.项目 !== args.项目 || plan.主体.id !== args.subject?.id || plan.主体.kind !== args.subject?.kind || plan.输入摘要 !== digest(canonical(this.#configurationInput(args)))) throw new InvalidBody('额度执行计划不是本服务签发的同主体、同项目、同规范输入计划。');
    let committed;
    let result;
    await this.#withGoalAndBudgetLock(args.项目, async () => {
      await this.#governanceActor(args.subject, true);
      const rows = await readBudgetLedger(budgetLogPath(this.layout, args.项目));
      const current = this.#configurationPlan(id, args, rows);
      if (current.源摘要 !== plan.源摘要 || canonical(current.事件) !== canonical(plan.事件)) throw new Denied('目标额度 · 配置准备已变化', '目标、当前用量或预算修订已经变化，请重读后再决定，不能将旧预览直接落线。');
      await this.#policy('write', id, args, 'budget_configure');
      committed = { seq: rows.length + 1, at: this.clock.iso(), by: { id: args.subject.id, kind: args.subject.kind }, ...structuredClone(current.事件) };
      const state = foldBudgetLedger([...rows, committed]).get(id);
      await appendLines(budgetLogPath(this.layout, args.项目), [committed]);
      result = budgetView(id, state, 20, 0);
    });
    await this.#audit(committed, args.项目, args.subject);
    return result;
  }

  /** 内部入口；占用不是原动作授权。每个真实执行使用服务器新生成的执行键。 */
  async reserve(spec) {
    this.#reserveInput(spec);
    let committed = null;
    let receipt;
    await this.#withGoalAndBudgetLock(spec.项目, async () => {
      const goal = this.#goal(spec.目标, spec.项目);
      if (goal.状态 !== '进行中') throw new Denied('目标额度 · 目标不在进行中', `目标当前为${goal.状态}，不能新增受管准入尝试；额度不会自动修改目标状态。`);
      const actor = await this.#executionActor(spec.subject, spec.目标, spec.类别);
      await this.#policy('read', spec.目标, spec, 'budget_reserve');
      const rows = await readBudgetLedger(budgetLogPath(this.layout, spec.项目));
      const states = foldBudgetLedger(rows);
      const existing = [...states.values()].flatMap((item) => item.尝试).find((attempt) => attempt.执行键 === spec.执行键);
      if (existing) {
        if (existing.目标 !== spec.目标 || existing.工具 !== spec.工具 || existing.类别 !== spec.类别 || existing.指纹 !== spec.指纹 || canonical(existing.主体) !== canonical(actor)) throw new Denied('目标额度 · 执行键冲突', '该执行键已绑定不同目标、主体或操作指纹，不能重复占用或转移额度。');
        receipt = reserveReceipt(existing, true, false);
        return;
      }
      const budget = states.get(spec.目标);
      if (!budget) { receipt = { 受管: false, 目标: spec.目标, 执行键: spec.执行键, 保留状态: 'unmanaged', 可放行: null, 覆盖口径: BUDGET_COVERAGE }; return; }
      if (budget.已结算 + budget.未决占用 >= budget.上限) throw new Denied('目标额度 · 受管准入尝试已耗尽', '目标的受管准入尝试额度不足；失败和未知结果不退还，不会自动暂停目标。', { howToChange: '由人侧核对已有占用后明确调整上限；独立且不属于该目标的合法工作仍按原权限进行。', detail: counters(budget) });
      committed = { seq: rows.length + 1, at: this.clock.iso(), by: actor, kind: 'budget_reserved', id: spec.目标, 预算修订: budget.预算修订, 执行键: spec.执行键, 工具: spec.工具, 类别: spec.类别, 指纹: spec.指纹, 单位: 1 };
      const state = foldBudgetLedger([...rows, committed]).get(spec.目标);
      await appendLines(budgetLogPath(this.layout, spec.项目), [committed]);
      receipt = reserveReceipt(state.尝试.find((attempt) => attempt.执行键 === spec.执行键), false, false);
    });
    if (committed) {
      // 写账成功、审计失败也不能向宿主签发许可；占用保持待核对，不自动返还。
      await this.#audit(committed, spec.项目, spec.subject);
      receipt.可放行 = true;
    }
    return receipt;
  }

  /** 仅真实宿主结果入口调用；迟到结算不依赖旧实例或目标当前可执行性。 */
  async settle(spec) {
    this.#settleInput(spec);
    let committed = null;
    let receipt;
    await this.#withBudgetLock(spec.项目, async () => {
      const rows = await readBudgetLedger(budgetLogPath(this.layout, spec.项目));
      const states = foldBudgetLedger(rows);
      const attempt = [...states.values()].flatMap((budget) => budget.尝试).find((item) => item.执行键 === spec.执行键);
      if (!attempt || attempt.目标 !== spec.目标) throw new Denied('目标额度 · 结果没有对应准入', '没有该目标与执行键的真实准入记录，不能补造结算。');
      if (attempt.状态 === 'settled') {
        if (attempt.结果 !== spec.结果) throw new Denied('目标额度 · 结算结果冲突', '该准入已经结算为另一个结果，不能覆盖原结果。');
        receipt = { ...reserveReceipt(attempt, true, false), 结果: attempt.结果 };
        return;
      }
      committed = { seq: rows.length + 1, at: this.clock.iso(), by: { ...RESULT_ACTOR }, kind: 'budget_settled', id: spec.目标, 执行键: spec.执行键, 结果: spec.结果 };
      const budget = foldBudgetLedger([...rows, committed]).get(spec.目标);
      await appendLines(budgetLogPath(this.layout, spec.项目), [committed]);
      receipt = { ...reserveReceipt(budget.尝试.find((item) => item.执行键 === spec.执行键), false, false), 结果: spec.结果 };
    });
    if (committed) await this.#audit(committed, spec.项目, RESULT_ACTOR);
    return receipt;
  }

  #configurationInput(args) { return { 预算修订: natural(args.预算修订, '预算修订'), 上限: natural(args.上限, '上限'), 来源: args.来源 === undefined ? null : bounded(args.来源, '来源', 2000) }; }
  #configurationPlan(id, args, rows) {
    const input = this.#configurationInput(args);
    const goal = this.#goal(id, args.项目);
    const state = foldBudgetLedger(rows).get(id);
    if (input.预算修订 !== (state?.预算修订 ?? 0)) throw new Denied('目标额度 · 预算修订冲突', `当前预算修订为 ${state?.预算修订 ?? 0}，收到 ${input.预算修订}；请重读后再配置。`);
    if (input.预算修订 === Number.MAX_SAFE_INTEGER) throw new InvalidBody('预算修订已到可表示上限，不能再递增。');
    const event = { kind: 'budget_configured', id, 预算修订: input.预算修订 + 1, 上限: input.上限, 来源声明: input.来源 === null ? null : { 内容: input.来源, 性质: '调用者声明' } };
    const source = { 目标: { id: goal.id, 修订: goal.修订, 状态: goal.状态, 期望结果: goal.期望结果 }, 预算: state ?? null };
    const preview = { 目标: source.目标, 当前预算: state ? counters(state) : { 配置: null, 累计准入: null }, 新预算修订: event.预算修订, 新上限: event.上限, 来源声明: event.来源声明, 历史累计不会清零: true, 调低上限不撤销已准入: true, 覆盖口径: BUDGET_COVERAGE, token: null, 费用: null };
    return { 版本: 1, 动作: 'budget_configure', 项目: args.项目, 主体: { id: args.subject.id, kind: args.subject.kind }, 目标id: id, 输入摘要: digest(canonical(input)), 源摘要: digest(canonical(source)), 事件: event, 预览: preview,
      步骤: [{ 动作: 'write', 写: 'budget_configure', 目标: this.#target(id, args.项目), 上下文: { 介入写: 'budget_configure' }, 说明: '配置目标共享受管准入尝试额度（不清累计）', 预览: preview }] };
  }

  #configureInput(id, args, execution) {
    this.#baseInput(id, args);
    unknown(args, ['subject', '项目', 'id', 'action', 'project', '审批引用', '预算修订', '上限', '来源', ...(execution ? ['执行计划'] : [])]);
    if (args.action !== undefined && args.action !== 'budget_configure') throw new InvalidBody('额度配置动作与领域计划不一致。');
    this.#configurationInput(args);
  }
  #queryInput(id, args) { this.#baseInput(id, args); unknown(args, ['subject', '项目', 'id', '条数', '偏移']); page(args.条数 ?? 20, args.偏移 ?? 0); }
  #baseInput(id, args) { if (!args || typeof args !== 'object' || Array.isArray(args)) throw new InvalidBody('目标额度需要结构化输入。'); this.#id(id); this.#project(args.项目); if ((args.id !== undefined && args.id !== id) || (args.project !== undefined && args.project !== args.项目)) throw new InvalidBody('额度目标 id 或项目不一致。'); }
  #reserveInput(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new InvalidBody('准入需要结构化内部参数。');
    unknown(args, ['subject', '项目', '目标', '执行键', '工具', '类别', '指纹']);
    this.#project(args.项目); this.#id(args.目标); boundedExact(args.执行键, '执行键', 256); boundedExact(args.工具, '工具', 128);
    if (!BUDGET_CATEGORIES.includes(args.类别) || (args.类别 === 'member_file' ? !BUDGET_FILE_TOOLS.includes(args.工具) : args.工具 !== 'member_spawn') || typeof args.指纹 !== 'string' || !/^[a-f0-9]{64}$/.test(args.指纹)) throw new InvalidBody('受管类别、精确工具或 SHA-256 指纹无效；不接受自报单位、用量或费用。');
  }
  #settleInput(args) { if (!args || typeof args !== 'object' || Array.isArray(args)) throw new InvalidBody('结果需要结构化内部参数。'); unknown(args, ['项目', '目标', '执行键', '结果']); this.#project(args.项目); this.#id(args.目标); boundedExact(args.执行键, '执行键', 256); if (!['success', 'error'].includes(args.结果)) throw new InvalidBody('结果只能来自真实 success/error，未知结果保持未决占用。'); }
  #goal(id, project) { if (!this.goals?.rawSnapshot) throw new Fault('GOAL_BUDGET_GOAL_SOURCE_UNAVAILABLE', '缺少严格目标真源，不能配置或准入。'); const goal = this.goals.rawSnapshot(project).目标.find((item) => item.id === id); if (!goal) throw new InvalidBody(`没有这个目标：${id}`); return goal; }
  #id(id) { boundedExact(id, '目标 id', 256); }
  #project(project) { boundedExact(project, '项目', 256); }
  #target(id, project) { return { id, kind: '目标预算', authority: '自治', zone: '私有', domain: '集体', project }; }
  #policy(action, id, args, operation) { if (typeof this.policy?.check !== 'function') throw new Fault('GOAL_BUDGET_POLICY_UNAVAILABLE', '目标额度缺少当前策略引擎。'); return this.policy.check({ subject: args.subject, action, target: this.#target(id, args.项目), context: { 介入写: operation } }); }
  #withBudgetLock(project, fn) { const file = budgetLogPath(this.layout, project); return serializeByKey(file, () => withLock(budgetLockPath(this.layout, project), fn)); }
  #withGoalAndBudgetLock(project, fn) { if (typeof this.goals?.withProjectLock !== 'function') throw new Fault('GOAL_BUDGET_GOAL_LOCK_UNAVAILABLE', '缺少目标共同锁，不能在变更期间凭旧目标准入。'); return this.goals.withProjectLock(project, () => this.#withBudgetLock(project, fn)); }

  async #governanceActor(subject, configure) {
    if (typeof subject?.id !== 'string' || !subject.id.trim() || (configure ? subject.kind !== '主权者' : !['Lead', '主权者'].includes(subject.kind))) throw new Denied('目标额度 · 治理资格', configure ? '额度配置只接受真实人侧主权者，声明文本不能代替认证。' : '额度读面只向真实 Lead 或主权者开放。');
    if (subject.kind === 'Lead') {
      if (!this.registry?.identity) throw new Fault('GOAL_BUDGET_IDENTITY_UNAVAILABLE', '缺少真实身份源。');
      const member = (await this.registry.identity()).members?.[subject.id];
      if (member?.岗位 !== 'Lead' || member.status !== '在岗') throw new Denied('目标额度 · 治理资格', '当前主体不是在册在岗 Lead。');
    }
  }
  async #executionActor(subject, goalId, category) {
    if (typeof subject?.id !== 'string' || !subject.id.trim() || !['Lead', '成员'].includes(subject.kind) || (category === 'member_spawn' && subject.kind !== 'Lead')) throw new Denied('目标额度 · 准入资格', '受管准入只接受真实 Lead 或成员，派活仅限 Lead；额度不产生原动作权限。');
    if (!this.registry?.identity || !this.registry?.cardOf || typeof this.policy?.refreshIfStale !== 'function') throw new Fault('GOAL_BUDGET_IDENTITY_UNAVAILABLE', '缺少当前身份、卡凭证或新鲜策略，不能准入。');
    await this.policy.refreshIfStale();
    if (!this.policy.healthy) throw new Fault('GOAL_BUDGET_POLICY_UNAVAILABLE', '当前策略不健康，停止新准入。');
    if (this.policy.presence?.().lost !== false) throw new Denied('目标额度 · 当前写冻结', '主权者失联或失联资格不可确认，不能新增受管准入。');
    const identity = await this.registry.identity();
    const member = identity.members?.[subject.id];
    const kind = member?.岗位 === 'Lead' ? 'Lead' : ['主权者', '出厂作者'].includes(member?.岗位) ? member.岗位 : '成员';
    if (!member || member.status !== '在岗' || kind !== subject.kind || (subject.kind === '成员' && subject.roleId !== member.岗位) || (subject.kind === 'Lead' && subject.roleId !== undefined && subject.roleId !== 'Lead') || (await this.registry.cardOf(subject.id))?.就绪 !== true) throw new Denied('目标额度 · 当前实例凭证', '实例不在岗、岗位自报不匹配或真实卡凭证失效，不能准入。');
    const denied = new Set([subject.id, member.岗位, goalId]);
    if (subject.kind === '成员') {
      const parentId = member.委派者?.id;
      const parent = identity.members?.[parentId];
      if (!parentId || parent?.岗位 !== 'Lead' || parent.status !== '在岗' || (await this.registry.cardOf(parentId))?.就绪 !== true) throw new Denied('目标额度 · 当前父Lead资格', '成员缺少当前真实在岗父 Lead，不能准入。');
      denied.add(parentId); denied.add('Lead');
    }
    if (!Array.isArray(identity.denylist) || identity.denylist.some((entry) => denied.has(entry?.id))) throw new Denied('目标额度 · 当前撤回资格', '主体、岗位、父 Lead 或目标已撤回，或拒绝名单不可判；停止新准入。');
    return { id: subject.id, kind: subject.kind, ...(subject.kind === '成员' ? { roleId: subject.roleId } : {}) };
  }
  async #audit(row, project, subject) {
    try { await this.audit.append({ 动作: '状态变更', 主体: subject, 对象: { id: row.id, kind: '目标预算' }, 依据: '目标额度事件流', 结果: row.kind, 项目: project, 详情: { 事件: row.kind, 预算修订: row.预算修订 ?? null, ...(row.执行键 ? { 执行键: row.执行键 } : {}) } }); }
    catch (cause) { throw new Fault('GOAL_BUDGET_AUDIT_APPEND_FAILED_AFTER_EVENT', '目标额度事件已提交，但审计未收尾；准入占用保留，不得据此放行宿主或盲重放。', {
      cause, detail: { id: row.id, 项目: project, 事件序号: row.seq, ...(row.执行键 ? { 执行键: row.执行键 } : {}) },
      outcome: { 提交状态: '已提交', 可重试: false, 恢复指引: '按项目、目标和执行键查询占用或结算事实并核对缺失审计；同执行键认回不会重新签发宿主放行，未知结果不退还额度。',
        已确认阶段: [{ 阶段: '目标额度事件落线', 项目: project, 对象id: row.id, 预算目标: row.id, 事件: row.kind, 事件序号: row.seq, ...(row.执行键 ? { 执行键: row.执行键 } : {}) }] },
    }); }
  }
}

function counters(state) { return { 目标: state.目标, 配置: structuredClone(state.配置), 预算修订: state.预算修订, 上限: state.上限, 累计准入: state.累计准入, 已结算: state.已结算, 未决占用: state.未决占用, 可准入: state.可准入 }; }
function budgetView(id, state, limit, offset) { page(limit, offset); const all = state?.尝试 ?? []; return { ...(state ? counters(state) : { 目标: id, 配置: null, 预算修订: null, 上限: null, 累计准入: null, 已结算: null, 未决占用: null, 可准入: null }), 覆盖口径: BUDGET_COVERAGE, token: null, 费用: null,
  尝试页: { 条目: [...all].reverse().slice(offset, offset + limit).map((item) => structuredClone(item)), 总数: state ? all.length : null, 条数: limit, 偏移: offset, hasMore: state ? offset + limit < all.length : null } }; }
function reserveReceipt(attempt, repeated, allow) { return { 受管: true, 目标: attempt.目标, 执行键: attempt.执行键, 保留状态: attempt.状态, 单位: 1, 预算修订: attempt.预算修订, 幂等: repeated, 可放行: allow }; }
function natural(value, name) { if (!Number.isSafeInteger(value) || value < 0) throw new InvalidBody(`${name} 必须是非负安全整数。`); return value; }
function page(limit, offset) { if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger(offset) || offset < 0) throw new InvalidBody('条数必须为1至50的整数，偏移为非负安全整数。'); }
function bounded(value, name, max) { if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new InvalidBody(`${name} 必须是1至${max}字符文本。`); return value.trim(); }
function boundedExact(value, name, max) { const result = bounded(value, name, max); if (result !== value) throw new InvalidBody(`${name} 必须是无首尾空白的精确标识。`); return result; }
function unknown(args, allowed) { const bad = Object.keys(args).filter((key) => !allowed.includes(key)); if (bad.length) throw new InvalidBody(`目标额度不接受字段：${bad.join('、')}；用量、释放、结算与认证事实不能由模型声明。`); }
function withoutPlan(value) { const { 执行计划: _plan, ...rest } = value; return rest; }
function deepFreeze(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; }
