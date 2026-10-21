/** 成员创建的唯一领域计划：预览与执行都消费这份只读阶段表。 */
import { Denied, Fault, InvalidBody } from '../src/kernel/errors.js';
import { requireDelegation, parseModelRoute, assertExecutionHost } from './host-execution.js';
import { assertGoalAllowsAdvance } from '../src/goal-constraints.js';
import { randomUUID } from 'node:crypto';
import { canonical, digest } from '../src/kernel/text.js';
import { assertNoSpawnOperation } from './member-spawn-journal.js';

const STAGES = Object.freeze(['spawn', 'register', 'bind-dispatch', 'message', 'audit']);
const prepared = new WeakSet();
const goalGuards = new WeakMap();
const budgetContexts = new WeakMap();

/**
 * 只读准备；错误在审批请求或宿主创建之前暴露，不代替每次真实写入的策略复判。
 * @param {{org: object, 项目: string, subject: object, args: object, 宿主: object}} spec
 * @returns {Promise<object>} 仅本模块签发的不可变执行计划
 */
export async function prepareMemberSpawn({ org, 项目, subject, args = {}, 宿主 }) {
  const 授权 = requireDelegation({ host: 宿主, subject, project: 项目 });
  const 伪计划 = Object.keys(args).filter((key) => ['计划', '步骤', '阶段', '执行计划', '执行步骤'].includes(key));
  if (伪计划.length) throw new InvalidBody('member_spawn 的执行计划只能由领域服务生成，不接受模型传入计划或阶段。');
  const 方式 = args.方式;
  if (!['team', 'subagent'].includes(方式)) throw new InvalidBody('方式 必须是 team 或 subagent（不需要委派就别调本动作）。', { missing: ['方式'] });
  const 节点id = String(args.节点 ?? '').trim();
  const 岗位 = String(args.岗位 ?? '').trim();
  const 任务书 = String(args.任务书 ?? '');
  if (!任务书.trim()) throw new InvalidBody('任务书必填：成员开工消息里的核心指令。', { missing: ['任务书'] });
  if (!节点id) throw new InvalidBody('节点必填：member_spawn 只派发已定判据的既有任务节点。', { missing: ['节点'] });
  const 节点 = await org.tasks.get(节点id, { 项目 });
  if (!节点) throw new InvalidBody(`没有这个任务节点：${节点id}（项目 ${项目}）`);
  await assertNoSpawnOperation({ org, project: 项目, subject, task: 节点id });
  if (节点.状态 !== '待派发') throw new InvalidBody(`节点 ${节点id} 当前状态为 ${节点.状态}；member_spawn 只接受待派发节点。`);
  const checkCurrentGoal = async () => {
    const goals = org.goals ?? org.tasks.goals;
    if (!goals) return null; // 旧的纯入口夹具；真实 TaskGraph 恒装配目标服务。
    const nodes = await org.tasks.list({ 项目 });
    const current = nodes.find(node => node.id === 节点id);
    if (!current) throw new InvalidBody('待创建成员的任务已不存在，不能创建宿主执行。');
    if (current.状态 !== '待派发') throw new InvalidBody('成员创建准备后的任务已不再待派发，不能继续创建宿主。');
    const fields = ['描述', '负责人', '判据', '依赖', '复核对象', '绑定', '工具文件范围'];
    const snapshotOf = node => Object.fromEntries(fields.map(key => [key, node[key] ?? null]));
    if (canonical(snapshotOf(current)) !== canonical(snapshotOf(节点))) throw new InvalidBody('成员创建准备后的任务事实已变化，请重读任务后重新准备；未创建宿主。');
    const goal = goals.constraintsForTask(current, nodes, 项目);
    assertGoalAllowsAdvance(goal);
    return goal;
  };
  const 目标依据 = await checkCurrentGoal();
  const 预算依据 = 目标依据 && org.budgets ? org.budgets.getBudgetSync(目标依据.目标, { 项目 }) : null;
  if (预算依据?.可准入 === 0) throw new Denied('目标额度 · 受管准入尝试已耗尽', '该目标当前没有可准入额度，不能先创建成员再等待派发失败。');
  if (!await org.registry.get({ id: 岗位 })) throw new InvalidBody(`岗位「${岗位}」不存在：先建岗位卡再派实例。`);
  if (typeof org.policy?.delegationBoundary !== 'function') throw new Fault('MEMBER_SPAWN_PLAN_INVALID', '不越授只读预判未接线；不能先创建持久子会话再等待登记拒绝。');
  const 越授 = org.policy.delegationBoundary({ subject, action: 'create',
    target: { id: '（待创建成员实例）', kind: '身份', authority: '自治', zone: '私有', domain: '个体', project: null, 岗位 },
    context: { 身份操作: '实例' },
  });
  if (越授) throw new Denied(越授.rule, 越授.reason, { requireAuthority: 越授.requireAuthority, howToChange: 越授.howToChange, detail: 越授.detail });
  const 负责人 = 节点.负责人 ?? [];
  if (负责人.length > 1) throw new InvalidBody(`节点 ${节点id} 有 ${负责人.length} 位负责人（并行分担）：member_spawn 只服务单负责人节点。拆成单负责人节点各派各的，或先 task_reassign 收成单负责人。`, { detail: { 阶段: 'precheck', 负责人 } });
  const 身份 = await org.registry.identity();
  const 已登记负责人 = 负责人.filter((id) => 身份?.members?.[id] && id !== subject?.id);
  if (已登记负责人.length) throw new InvalidBody(`节点 ${节点id} 的负责人里已有已登记实例（${已登记负责人.join('、')}）：member_spawn 不覆盖真人负责的节点。先 task_reassign 解除，或另建节点。`, { detail: { 阶段: 'precheck', 已登记负责人, 负责人 } });
  if (!负责人.includes(岗位)) throw new Denied('任务图 · 绑定岗位必须与节点负责人对得上', `节点 ${节点id} 的负责人是 ${负责人.join('、')}，与将派岗位「${岗位}」不匹配：不能先创建成员再等绑定失败。`, {
    requireAuthority: 'Lead', howToChange: '先 task_reassign 把负责人明确改为将派岗位，再 member_spawn；Lead 自领任务仍可本人直接执行。', detail: { 阶段: 'precheck', 岗位, 负责人 },
  });
  const 工具面参数 = Object.keys(args).filter((key) => /^(工具|工具范围|允许工具|工具集|tools?)$/i.test(key));
  if (工具面参数.length) throw new InvalidBody(`member_spawn 不接受「${工具面参数.join('、')}」：工具总范围由部署者设定，派活不能给成员开额外工具。`, { detail: { 阶段: 'precheck', 工具面参数 } });
  if (args.工具文件范围 !== undefined) org.tasks.toolFileAuthority().grant(args.工具文件范围, subject);
  assertExecutionHost(宿主, 方式);
  const 路由 = parseModelRoute(args, 方式);
  const 入参 = { 方式, 岗位, 节点: 节点id, 任务书, 授权引用: args.授权引用, 工具文件范围: args.工具文件范围 };
  const taskTarget = { kind: '任务', id: 节点id, authority: '自治', zone: '私有', project: 项目 };
  const 阶段 = [
    { 类型: 'spawn', 审批归属: 'register' },
    { 类型: 'register', 步骤: [{ 动作: 'create', 目标: { kind: '身份', 新: true, authority: '自治', zone: '私有' }, 说明: `登记成员实例（岗位 ${岗位}）`,
      预览: { 岗位, 节点: 节点id, 方式, 任务书, 判据: 节点.判据, 负责人, 描述: 节点.描述, ...(目标依据 ? { 目标依据 } : {}), ...(预算依据 ? { 预算依据: { 目标: 目标依据.目标, 预算修订: 预算依据.预算修订, 上限: 预算依据.上限, 单位: '受管准入尝试' } } : {}), 模型路由: 路由.模型路由, 工具文件范围: args.工具文件范围 ?? { 读: [], 写: [] }, 执行阶段: STAGES } }] },
    { 类型: 'bind-dispatch', 步骤: [
      { 动作: 'write', 目标: taskTarget, 写: 'bind', 说明: '绑定实例到节点', 预览: { 节点: 节点id, 岗位 } },
      { 动作: 'dispatch', 目标: taskTarget, 说明: '派发节点', 预览: { 节点: 节点id } },
    ] },
    { 类型: 'message', 审批归属: 'register' },
    { 类型: 'audit', 审批归属: 'register' },
  ];
  const plan = structuredClone({ 版本: 1, 动作: 'member_spawn', 项目, 节点, 入参, 授权, ...路由, 阶段, 步骤: 阶段.flatMap((stage) => stage.步骤 ?? []) });
  freeze(plan);
  prepared.add(plan);
  goalGuards.set(plan, checkCurrentGoal);
  if (org.budgets) budgetContexts.set(plan, { org, subject, 项目, started: false, receipt: null });
  return plan;
}

/** 兼容现有介入计划 API，同时把同一次准备的执行计划只经内部字段传下去。 */
export function memberSpawnApprovalPlan(plan) {
  assertMemberSpawnPlan(plan);
  return { 步骤: plan.步骤, 执行计划: plan };
}

/** 全表预检必须先于第一阶段；未知阶段不能在已经 spawn 后才发现。 */
export function assertMemberSpawnPlan(plan) {
  if (!prepared.has(plan) || plan.版本 !== 1 || plan.动作 !== 'member_spawn') throw new Fault('MEMBER_SPAWN_PLAN_INVALID', '执行计划不是本次领域准备签发的有效计划，拒绝创建。');
  if (plan.阶段.length !== STAGES.length || plan.阶段.some((stage, i) => stage.类型 !== STAGES[i])) throw new Fault('MEMBER_SPAWN_PLAN_UNCOVERED', '执行计划包含未知、重复或顺序不符的阶段，拒绝创建。');
  return plan;
}

/** 额度预占等异步步骤之后、意图追加之前再核当前任务和目标，不持锁等待宿主。 */
export async function recheckMemberSpawnPlan(plan) {
  assertMemberSpawnPlan(plan);
  return goalGuards.get(plan)?.();
}

/**
 * 执行闭合阶段表；适配器只由服务器装配，模型不能提供回调或阶段。
 * @param {object} plan 本模块准备的计划
 * @param {Record<string, Function>} handlers 固定服务器阶段实现
 * @returns {Promise<void>}
 */
export async function runMemberSpawnStages(plan, handlers) {
  assertMemberSpawnPlan(plan);
  const keys = Object.keys(handlers);
  if (keys.length !== STAGES.length || keys.some((key) => !STAGES.includes(key)) || STAGES.some((key) => typeof handlers[key] !== 'function')) throw new Fault('MEMBER_SPAWN_PLAN_UNCOVERED', '实际执行阶段与预览计划不一致：未知或缺失阶段，已在创建前拒绝。');
  const goal = await goalGuards.get(plan)?.();
  const budget = budgetContexts.get(plan);
  for (const stage of plan.阶段) {
    if (stage.类型 !== 'spawn' || !goal || !budget) { await handlers[stage.类型](); continue; }
    if (budget.started) throw new Denied('目标额度 · 旧创建计划不可重放', '旧创建计划已进入预算准入，不得复用原计划重建成员。');
    budget.started = true;
    const receipt = await budget.org.budgets.reserve({ subject: budget.subject, 项目: budget.项目, 目标: goal.目标,
      执行键: randomUUID(), 工具: 'member_spawn', 类别: 'member_spawn', 指纹: digest(canonical({ 目标: goal.目标, 入参: plan.入参, 模型路由: plan.模型路由 })) });
    if (receipt.受管 && receipt.可放行 !== true) throw new Denied('目标额度 · 旧占用不能放行', '只有原始预占与审计均成功的本次准入凭据才能创建宿主实例。');
    if (receipt.受管) budget.receipt = { ...receipt, 结果记账: '未决' };
    try { await handlers.spawn(); }
    catch (cause) {
      // 抛错/缺可靠宿主回执时不补造结果，同时保留已经提交的额度占用。
      if (!receipt.受管) throw cause;
      throw new Fault(cause.code ?? 'MEMBER_SPAWN_FAILED_AFTER_BUDGET', cause.message ?? '预算已预占，宿主创建结果未知。', {
        cause, detail: cause.detail,
        outcome: { 提交状态: cause.outcome?.提交状态 ?? '未知', 可重试: false,
          恢复指引: '预算准入已经提交；按执行键和宿主直系目录核对创建事实，未知占用不返还，不要盲重建。',
          已确认阶段: [{ 阶段: '预算准入已提交', 项目: budget.项目, 对象id: goal.目标, 预算目标: goal.目标, 执行键: receipt.执行键 }, ...(cause.outcome?.已确认阶段 ?? [])] },
      });
    }
    if (receipt.受管) {
      try {
        await budget.org.budgets.settle({ 项目: budget.项目, 目标: goal.目标, 执行键: receipt.执行键, 结果: 'success' });
        budget.receipt.结果记账 = '已收尾';
      } catch {
        budget.receipt.结果记账 = '需核对';
        budget.org.logger?.warn?.('[dsh-mind] 宿主创建已有可靠回执，预算结果记账未完整收尾；保留占用，不重复创建或返还额度。');
      }
    }
  }
}

/** 实际创建回执的附加小凭据，不展开账本或授权资料。 */
export function memberSpawnBudgetReceipt(plan) {
  const receipt = budgetContexts.get(plan)?.receipt;
  return receipt ? { 目标: receipt.目标, 执行键: receipt.执行键, 已准入: true, 结果记账: receipt.结果记账, token: null, 费用: null } : null;
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
}
