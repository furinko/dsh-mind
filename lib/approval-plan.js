/**
 * 介入度「步骤计划」构造器（宏动作 → 底层策略写的**唯一翻译层**）。
 *
 * 为什么要有它：`task_create` / `member_spawn` / `task_settle` 这类宏动作在服务层会走多次
 * `policy.check`，动作名与目标 id 都不是宏名。批准必须绑定「这次到底会发生哪些写」，
 * 而不是绑宏名或临时 id。本模块只做**只读预判**：按宏动作与入参摊出完整步骤计划（含
 * 真正将写的内容预览），交给动作层在**任何副作用之前**登记介入请求 / 或按冻结计划重放。
 *
 * 单源边界：这里不执行任何写、不复制服务层的业务判定；它只读 `tasks` / `memory` /
 * `registry` 的公开读面。服务层若新增内部写步骤，必须同步补这里（否则重放会以
 * 「计划未覆盖」响亮失败——不许静默半动作）。
 */
import { MEMORY_KINDS } from '../src/paths.js';
import { Fault } from '../src/kernel/errors.js';

/**
 * 按宏动作造计划。没有计划的动作返回 null（动作层退回「被拦时按单步登记」）。
 * @param {{ org: object, 项目: string, action: string, args: object }} spec
 * @returns {Promise<{步骤: Array<object>}|null>}
 */
export async function 介入计划Of({ org, 项目, action, args = {}, 宿主, subject }) {
  switch (action) {
    case 'review_experiment_allow':
    case 'review_experiment_run':
      if (typeof 宿主?.reviewExperiments?.plan !== 'function') throw new Fault('EXPERIMENT_NOT_WIRED', '实验完整计划未接线；不退回单步盲审批。');
      return 宿主.reviewExperiments.plan({ action, args, project: 项目, sessionProject: 项目, host: 宿主, subject });
    case 'task_create':
      return 任务计划(args, 项目);
    case 'member_spawn':
      return 派活计划(org, 项目, args);
    case 'debate_open':
    case 'debate_converge':
      return org.council.councilPlan({ 项目, 动作: action, args });
    case 'task_settle':
      return 结账计划(org, 项目, args);
    case 'registry_assign':
      return 实例登记计划(args);
    case 'capability_publish':
      return 能力发布计划(org, args);
    case 'memory_write':
      return 记忆写计划(args, 项目);
    default:
      return null;
  }
}

/**
 * 计划里有没有任何一步在当前档位下会被介入度拦下（只读预判，不落账）。
 * 有 ⇒ 整单在副作用之前挂起：主权者批的必须是**完整计划**，不是第一道被拦的写。
 * @param {{ org: object, subject: object, 项目: string, 计划: {步骤: Array<object>} }} spec
 * @returns {boolean}
 */
export function 计划会挂起({ org, subject, 项目, 计划 }) {
  // 老夹具/降级装配可能只提供 check/decide（没有会挂起）：预判退回 false，让真正的
  // 服务判定照旧说话（它抛什么就是什么）；绝不因为预判读不到就把动作静默放行。
  if (typeof org?.policy?.会挂起 !== 'function') return false;
  return 计划.步骤.some((步) => org.policy.会挂起({
    subject,
    action: 步.动作,
    target: 预判目标(步, 项目),
    context: 步.上下文 ?? {},
  }));
}

/** 预判用的目标形状：新对象的 id 不参与判定，只留标签。 */
function 预判目标(步, 项目) {
  return {
    id: 步.目标?.id ?? '（预检）',
    kind: 步.目标?.kind ?? null,
    authority: 步.目标?.authority ?? '自治',
    zone: 步.目标?.zone ?? '私有',
    project: 步.目标?.project ?? 项目,
    ...(步.目标?.sandbox === true ? { sandbox: true } : {}),
  };
}

function 任务计划(args, 项目) {
  return {
    步骤: [{
      动作: 'create',
      目标: { kind: '任务', 新: true, authority: '自治', zone: '私有', project: 项目 },
      说明: '建任务节点',
      预览: { 描述: args.描述, 负责人: args.负责人, 判据: args.判据, 依赖: args.依赖 ?? null },
    }],
  };
}

function 实例登记计划(args) {
  return {
    步骤: [{
      动作: 'create',
      目标: { kind: '身份', 新: true, authority: '自治', zone: '私有' },
      说明: `登记实例到岗位 ${args.岗位 ?? '?'}`,
      预览: { 实例: args.实例, 岗位: args.岗位, 节点: args.节点 ?? null },
    }],
  };
}

async function 派活计划(org, 项目, args) {
  const 节点 = await org.tasks.get(String(args.节点 ?? ''), { 项目 });
  if (!节点 || 节点.状态 !== '待派发') return null;
  return {
    步骤: [
      {
        动作: 'create',
        目标: { kind: '身份', 新: true, authority: '自治', zone: '私有' },
        说明: `登记成员实例（岗位 ${args.岗位 ?? '?'}）`,
        预览: { 岗位: args.岗位, 节点: 节点.id, 方式: args.方式, 任务书: args.任务书 },
      },
      {
        动作: 'write',
        目标: { kind: '任务', id: 节点.id, authority: '自治', zone: '私有', project: 项目 },
        写: 'bind',
        说明: '绑定实例到节点',
        预览: { 节点: 节点.id, 岗位: args.岗位 },
      },
      {
        动作: 'dispatch',
        目标: { kind: '任务', id: 节点.id, authority: '自治', zone: '私有', project: 项目 },
        说明: '派发节点',
        预览: { 节点: 节点.id },
      },
    ],
  };
}

async function 结账计划(org, 项目, args) {
  // 单源（2026-10-18 收口）：候选 / 处置归一 / 晋升与丢弃意图全部消费 `tasks.settlePlan`
  // 的同一个结果，这里只做「意图 → 底层策略写」的翻译。settlePlan 是只读的：它抛错就是
  // 业务判定错（状态机 / 采纳确认 / 处置非法 / 内容 / 岗位缺失），不留半截副作用。
  const 计划 = await org.tasks.settlePlan(String(args.id ?? ''), { 项目, 记忆处置: args.记忆处置 });
  const 步骤 = [{
    动作: 'settle',
    目标: { kind: '任务', id: 计划.节点.id, authority: '自治', zone: '私有', project: 项目 },
    说明: `结账 ${计划.节点.id}`,
    预览: { 节点: 计划.节点.id, 归档作答: true, 候选数: 计划.候选清单.length },
  }];
  for (const 晋升 of 计划.晋升计划) {
    步骤.push({
      动作: 'create',
      目标: { kind: '知识', 新: true, authority: '自治', zone: '私有', project: 项目 },
      写: `知识:${晋升.幂等键}`,
      说明: `晋升候选 ${晋升.候选.键}`,
      预览: { 候选键: 晋升.候选.键, 标题: 晋升.标题 ?? null, 岗位: 晋升.岗位 ?? null, 内容: 晋升.内容 },
    });
  }
  for (const 键 of 计划.丢弃) {
    步骤.push({
      动作: 'write',
      目标: { kind: '经历', id: '记忆/跨项目/经历', authority: '自治', zone: '私有', project: 项目 },
      写: `记忆:invalid:${键}`,
      说明: `丢弃经历 ${键}`,
      预览: { 候选键: 键 },
    });
  }
  // 归档作答：settle 恒定执行一次（即使 0 条作答，策略判定也在归档前发生）。
  步骤.push({
    动作: 'write',
    目标: { kind: '作答', id: `记忆/${项目}/作答`, authority: '自治', zone: '私有', project: 项目 },
    写: `记忆:归档:${计划.节点.id}`,
    说明: '归档作答',
    预览: { 节点: 计划.节点.id },
  });
  return { 步骤 };
}

async function 能力发布计划(org, args) {
  const 名 = String(args.名 ?? '').trim();
  if (!名) return null;
  let 既有 = null;
  try {
    既有 = await org.store.read('能力', 名, {});
  } catch {
    // 盘上的卡读不干净（例如文件名/元数据 id 大小写不一致）：这不是预判能替它下结论的场合，
    // 退回「没有预判计划」——真正的写入面会以它自己的拒因说话（store.write 的闸在落笔前）。
    return null;
  }
  return {
    步骤: [{
      动作: 既有 ? 'write' : 'create',
      目标: { kind: '能力', id: 名, zone: '私有' },
      说明: 既有 ? '改能力卡' : '发布能力',
      预览: { 名, 标题: args.标题 ?? null, 正文长度: String(args.正文 ?? '').length },
    }],
  };
}

function 记忆写计划(args, 项目) {
  const 类 = String(args.类 ?? '');
  if (!MEMORY_KINDS.includes(类)) return null;
  const 命名空间 = args.命名空间 === '通用' ? '通用' : null;
  const scope = (类 === '经历' || 类 === '偏好' || 命名空间) ? '跨项目' : 项目;
  const 目标项目 = 命名空间 ?? 项目;
  return {
    步骤: [{
      动作: 'create',
      目标: { kind: 类, id: `记忆/${scope}/${类}`, authority: '自治', zone: '私有', project: 目标项目 },
      说明: `写${类}`,
      预览: { 类, 标题: args.标题 ?? String(args.内容 ?? '').slice(0, 40) },
    }],
  };
}
