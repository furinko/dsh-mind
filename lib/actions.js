/**
 * 组织动作表（宿主插件与工作台共用的唯一实现）。
 *
 * 为什么动作表要独立成文件：`references/user-actions.md` 的纪律是
 * **一个操作两处调用者（工具 + UI），但只有一处实现**。
 * 于是这里既被 `mind` 工具调用，也被 `/mind` 命令调用，两条路进的是同一张表。
 */
import { Denied, InvalidBody } from '../src/kernel/errors.js';
import { subjectFor } from '../src/org.js';
import { MEMORY_KINDS } from '../src/paths.js';

export { describeFailure } from '../src/kernel/errors.js';

/** 动作清单：工具 schema 的 enum 必须与它一致，别处不再枚举。 */
export const ACTIONS = [
  'status',
  'workbench',
  'policy_check',
  'task_create',
  'task_dispatch',
  'task_start',
  'task_submit',
  'task_review',
  'task_pending',
  'task_resolve',
  'memory_write',
  'memory_query',
  'memory_lifecycle',
  'capability_list',
  'capability_resolve',
  'capability_read',
  'capability_publish',
  'bus_send',
  'bus_read',
  'audit_tail',
  'audit_verify',
  'registry_list',
  'registry_can',
  'registry_assign',
  'registry_seal',
  'registry_revoke',
  'upgrade_pending',
  'review_zero',
  'sovereign_interaction',
];

/**
 * 执行一个动作。
 *
 * @param {{ org: object, 项目: string, subject: object, args: object }} spec
 * @returns {Promise<object>} 结构化结果；调用方负责序列化。
 */
export async function runAction(spec) {
  const { org, subject } = spec;
  const args = spec.args ?? {};
  const 项目 = args.project ?? spec.项目;
  const handler = HANDLERS[args.action];
  if (!handler) {
    throw new InvalidBody(`未知 action：${String(args.action)}`, { detail: { 可选: ACTIONS } });
  }
  const 主体 = subjectFor({ 岗位: args.role, 实例: args.实例, 根会话: subject?.kind === 'Lead' });
  const 结果 = await handler({ org, 项目, subject: 主体, args });
  return { action: args.action, 项目, 主体: { id: 主体.id, kind: 主体.kind, roleId: 主体.roleId ?? null }, ...结果 };
}

/** 每个动作一个函数；键名即 action 名。 */
const HANDLERS = {
  async status({ org }) {
    return { 数据: await org.status() };
  },

  async workbench({ org, 项目, subject, args }) {
    return {
      数据: await org.workbench({ 读者: args.全量 === true ? undefined : subject, 项目, 审计条数: args.审计条数 ?? 20 }),
      说明: '工作台是投影：只读，不存储，不是第二事实源。',
    };
  },

  async policy_check({ org, subject, args }) {
    if (!args.target?.kind) throw new InvalidBody('policy_check 需要 target.kind');
    const decision = await org.policy.decide({
      subject,
      action: args.动作 ?? 'read',
      target: {
        id: args.target.id ?? 'probe',
        kind: args.target.kind,
        authority: args.target.authority ?? '自治',
        zone: args.target.zone ?? '私有',
        project: args.project ?? null,
        segment: args.target.segment ?? null,
      },
      context: {},
    });
    return { 判定: decision, 说明: '拒绝必须带可执行理由：哪条规则 + 改它要什么授权。' };
  },

  async task_create({ org, 项目, subject, args }) {
    return { 节点: await org.tasks.create({ subject, 项目, 描述: args.描述, 负责人: args.负责人, 判据: args.判据, 依赖: args.依赖, 模式: args.模式 }) };
  },

  async task_dispatch({ org, 项目, subject, args }) {
    return { 节点: await org.tasks.dispatch(args.id, { subject, 项目 }) };
  },

  async task_start({ org, 项目, subject, args }) {
    return { 节点: await org.tasks.start(args.id, { subject, 项目 }) };
  },

  async task_submit({ org, 项目, subject, args }) {
    return { 节点: await org.tasks.submit(args.id, { subject, 项目, 产出物引用: args.产出物引用, 结论: args.结论 }) };
  },

  async task_review({ org, 项目, subject, args }) {
    return {
      结论: await org.review.record({
        subject,
        项目,
        节点: args.id,
        三态: args.三态,
        分歧清单: args.分歧清单,
        反例面: args.反例面,
        复核者: args.复核者,
      }),
    };
  },

  async task_pending({ org, 项目, subject, args }) {
    return { 节点: await org.tasks.markPending(args.id, { subject, 项目, 原因: args.原因, 待决类型: args.待决类型 }) };
  },

  async task_resolve({ org, 项目, subject, args }) {
    return { 节点: await org.tasks.resolvePending(args.id, { subject, 项目, 决定: args.决定 }) };
  },

  async memory_write({ org, 项目, subject, args }) {
    if (!MEMORY_KINDS.includes(args.类)) throw new InvalidBody(`记忆只有四类：${MEMORY_KINDS.join(' / ')}`);
    // 不许替调用方编一个来源：§7 要求「写入必带谁记的 + 怎么知道的」，
    // 缺了就拒写（写入侧义务），而不是填个「未说明」让它过关。
    const 来源 = args.来源 ?? (args.依据 ? args.依据 : null);
    if (!来源) throw new InvalidBody('memory_write 需要「来源」：这条你是怎么知道的？', { missing: ['来源'] });
    return {
      条目: await org.memory.remember({
        subject,
        类: args.类,
        内容: args.内容,
        来源,
        项目,
        岗位: args.岗位,
        标签: args.标签,
      }),
    };
  },

  async memory_query({ org, 项目, subject, args }) {
    return {
      结果: await org.memory.query({ 类: args.类, 项目, 岗位: args.岗位, 文本: args.文本, 显式: args.显式, 读者: subject, limit: args.limit }),
    };
  },

  async memory_lifecycle({ org, subject, args }) {
    const op = args.op;
    if (op === 'invalidate') return { 结果: await org.memory.invalidate(args.id, { subject, 原因: args.原因 }) };
    if (op === 'demote') return { 结果: await org.memory.demote(args.id, { subject, 原因: args.原因 }) };
    if (op === 'overturn') return { 结果: await org.memory.overturn(args.id, { subject, 新条目: args.新条目, 理由: args.原因 }) };
    if (op === 'purge') return { 结果: await org.memory.purge(args.id, { subject, 理由: args.原因 }) };
    if (op === 'promote') return { 结果: await org.memory.promoteCrossProject(args.id, { subject, 岗位: args.岗位, 理由: args.原因 }) };
    throw new InvalidBody(`未知记忆处置：${String(op)}`, { detail: { 可选: ['invalidate', 'demote', 'overturn', 'purge', 'promote'] } });
  },

  async capability_list({ org, args }) {
    return { 能力: await org.capability.list({ 岗位: args.岗位, 来源: args.来源 }) };
  },

  async capability_resolve({ org, args }) {
    return { 解析: await org.capability.resolve({ 名: args.名 }) };
  },

  async capability_read({ org, args }) {
    const 条目 = await org.capability.read({ id: args.id, 来源: args.来源 });
    if (!条目) throw new InvalidBody(`能力库里没有 ${args.id}`);
    return { 条目 };
  },

  async capability_publish({ org, subject, args }) {
    return { 能力: await org.capability.publish({ subject, 名: args.名, 正文: args.正文, 适用岗位: args.适用岗位, 依据: args.依据 ?? '组织自治' }) };
  },

  async bus_send({ org, 项目, subject, args }) {
    if (!args.线程) throw new InvalidBody('bus_send 需要 线程');
    return {
      消息: await org.bus.send({
        subject,
        项目,
        线程: args.线程,
        发件: args.发件 ?? subject.id,
        收件: args.收件 ?? [],
        类型: args.类型,
        内容: args.内容,
        暂不投递: args.暂不投递,
        延后: args.延后,
        引用: args.引用,
      }),
    };
  },

  async bus_read({ org, 项目, args }) {
    if (!args.线程) throw new InvalidBody('bus_read 需要 线程');
    return { 消息: await org.bus.read({ 项目, 线程: args.线程, 收件: args.收件, 未投递: args.未投递, limit: args.limit }) };
  },

  async audit_tail({ org, args }) {
    const rows = await org.audit.read({ grade: args.档位, limit: args.limit ?? 20 });
    return { 审计: rows.slice(-(args.limit ?? 20)), 说明: '审计只增：主权者也不能改，只能追加更正。' };
  },

  async audit_verify({ org }) {
    return { 校验: await org.audit.verify() };
  },

  async registry_list({ org }) {
    return { 岗位: await org.registry.list(), 实例: (await org.registry.identity()).members };
  },

  async registry_can({ org, args }) {
    if (!args.id) throw new InvalidBody('registry_can 需要 id');
    return { 能力: await org.registry.canTouch({ id: args.id }) };
  },

  async registry_assign({ org, subject, args }) {
    return { 实例: await org.registry.assign({ subject, 岗位: args.岗位, 实例: args.实例, 代: args.代 }) };
  },

  async registry_seal({ org, subject, args }) {
    return { 结果: await org.registry.seal({ subject, 实例: args.实例, 理由: args.原因 ?? '未说明' }) };
  },

  async registry_revoke({ org, subject, args }) {
    return { 结果: await org.registry.revoke({ subject, 对象id: args.id, 理由: args.原因 ?? '未说明' }) };
  },

  async upgrade_pending({ org }) {
    return { 挂起: (await org.upgrade.pending()).filter((p) => !p.已裁决 && !p.已撤回) };
  },

  async review_zero({ org, 项目, subject, args }) {
    return { 检查: await org.review.checkZeroDivergence({ subject, 项目, 节点: args.id, 结论集: args.结论集 ?? [] }) };
  },

  async sovereign_interaction({ org }) {
    return { 主权者: await org.registry.markInteraction({}) };
  },
};
