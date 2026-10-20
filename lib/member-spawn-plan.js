/** 成员创建的唯一领域计划：预览与执行都消费这份只读阶段表。 */
import { Denied, Fault, InvalidBody } from '../src/kernel/errors.js';
import { requireDelegation, parseModelRoute, assertExecutionHost } from './host-execution.js';
import { assertGoalAllowsAdvance } from '../src/goal-constraints.js';

const STAGES = Object.freeze(['spawn', 'register', 'bind-dispatch', 'message', 'audit']);
const prepared = new WeakSet();
const goalGuards = new WeakMap();

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
  if (节点.状态 !== '待派发') throw new InvalidBody(`节点 ${节点id} 当前状态为 ${节点.状态}；member_spawn 只接受待派发节点。`);
  const checkCurrentGoal = async () => {
    const goals = org.goals ?? org.tasks.goals;
    if (!goals) return null; // 旧的纯入口夹具；真实 TaskGraph 恒装配目标服务。
    const nodes = await org.tasks.list({ 项目 });
    const current = nodes.find(node => node.id === 节点id);
    if (!current) throw new InvalidBody('待创建成员的任务已不存在，不能创建宿主执行。');
    const goal = goals.constraintsForTask(current, nodes, 项目);
    assertGoalAllowsAdvance(goal);
    return goal;
  };
  const 目标依据 = await checkCurrentGoal();
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
      预览: { 岗位, 节点: 节点id, 方式, 任务书, 判据: 节点.判据, 负责人, 描述: 节点.描述, ...(目标依据 ? { 目标依据 } : {}), 模型路由: 路由.模型路由, 工具文件范围: args.工具文件范围 ?? { 读: [], 写: [] }, 执行阶段: STAGES } }] },
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
  await goalGuards.get(plan)?.();
  for (const stage of plan.阶段) await handlers[stage.类型]();
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
}
