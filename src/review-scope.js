/**
 * 复核读域（v2 口述收敛 2026-10-18 条目4/6/18 的补修：读域按任务授权，不按岗位全量）。
 *
 * 判据**只有这一份**：复核实例能读什么，由「它自己被绑定的复核任务 → 该任务载体上的
 * 显式 `复核对象` 引用」决定。所有模型可达读出口（workbench / task_criteria /
 * memory_query / audit_tail / 工作台总线行）都调这里，不许各抄一套——
 * 「一处投影遮、另一出口泄露」正是这条判据要堵的形态。
 *
 * 三条边界：
 *  - **不按 role 全量**：roleId=复核员 只说明它是复核岗，不说明它能读整个项目；
 *    未绑定复核任务的复核实例读域为空（未关联任务不得读）。
 *  - **不复用 `依赖` 字段**：依赖是「先做谁」，复核对象是「验哪一单」；混用会让
 *    「被复核节点已交卷→复核任务才可派发」的依赖门槛把复核闭环锁死。
 *  - **项目随复核任务**：读域只在本次动作的项目节点表里解析（同项目才谈得上复核），
 *    不凭会话 cwd 或无项目的节点 id 去别的项目账本里猜。
 */
import { 线程等价键 } from './paths.js';
import { readTaskLedgerSync } from './task-ledger.js';
import { fold } from './tasks.js';
import { readInstanceSnapshot } from './instance-snapshot.js';
import { Fault } from './kernel/errors.js';

/** 从本项目任务真源和在岗实例取用途；调用参数不能授予读域。 */
export async function 取复核读域({ tasks, 项目, subject, registry }) {
  if (subject?.kind !== '成员') return null;
  const identity = await (registry ?? tasks?.registry)?.identity?.() ?? await tasks?.identityProvider?.();
  if (!identity?.members?.[subject.id]) throw new Fault('REVIEW_IDENTITY_UNAVAILABLE', '复核用途需要真实在岗身份，不能把缺接线当成无复核限制。');
  return 复核读域({ 节点: await tasks.list({ 项目 }), 主体: subject, 项目, 成员: identity.members[subject.id] });
}

/** 同步工具/策略检查与异步服务使用同一用途判据，严格读取实际任务账本。 */
export function 取复核用途同步({ layout, subject, 项目, identity }) {
  if (subject?.kind !== '成员') return null;
  const snapshot = identity ?? readInstanceSnapshot(layout.identityFile());
  const member = snapshot.members?.[subject.id] ?? snapshot.成员?.[subject.id];
  if (snapshot.ok === false || !member) throw new Fault('REVIEW_IDENTITY_UNAVAILABLE', '复核用途的真实身份快照不可读。');
  const nodes = [...fold(readTaskLedgerSync(layout.taskLog(项目))).values()];
  return 复核读域({ 节点: nodes, 主体: subject, 项目, 成员: member });
}

/**
 * 节点载体上的显式复核对象引用（归一去重；没有就是空数组）。
 * 这是「验哪一单」的唯一结构化载体——自由文本、任务书、依赖都不算。
 * @param {object|null|undefined} node
 * @returns {string[]}
 */
export function 复核对象引用(node) {
  const raw = node?.复核对象;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((x) => String(x ?? '').trim()).filter(Boolean))];
}

/**
 * 一个读者在本项目里的复核读域。
 *
 * @param {{ 节点?: object[], 主体?: object|null, 项目?: string|null }} spec
 *   `节点` 必须是**同一项目**的任务节点表（调用方按动作项目取）。
 * @returns {{
 *   限定: boolean,
 *   复核任务: string[],
 *   复核对象: string[],
 *   集合: Set<string>|null,
 *   项目: string|null,
 *   主体: string|null,
 *   说明: string,
 * }}
 */
export function 复核读域(spec = {}) {
  const nodes = Array.isArray(spec.节点) ? spec.节点 : [];
  const subject = spec.主体 ?? null, member = spec.成员;
  const project = spec.项目 ?? null;
  const tasks = [], targets = [];
  const status = member?.status ?? member?.状态;
  const generation = typeof member?.代次 === 'string' ? member.代次 : member?.代次?.代 ?? member?.宿主代次 ?? null;
  const active = new Set(['已派发', '执行中', '已交卷', '未验', '已打回', '待决']);
  if (subject?.kind === '成员' && status === '在岗') for (const node of nodes) {
    if (node.项目 != null && node.项目 !== project || !active.has(node.状态) || node.判据冻结 !== true) continue;
    const refs = 复核对象引用(node); if (!refs.length) continue;
    const owners = Array.isArray(node.负责人) ? node.负责人 : [node.负责人];
    if (!owners.includes(subject.id) && !owners.includes(member.岗位)) continue;
    const bound = (node.绑定 ?? []).some(binding => binding?.实例 === subject.id && binding.岗位 === member.岗位
      && binding.凭证?.版本 === 1 && binding.凭证.代 === (member.代 ?? 1) && binding.凭证.宿主代次 === generation);
    if (!bound) continue;
    tasks.push(String(node.id)); targets.push(...refs);
  }
  const reviewTasks = [...new Set(tasks)], reviewTargets = [...new Set(targets)];
  const limited = reviewTasks.length > 0;
  return { 限定: limited, 复核任务: reviewTasks, 复核对象: reviewTargets,
    集合: limited ? new Set([...reviewTasks, ...reviewTargets]) : null, 项目: project, 主体: subject?.id ?? null,
    说明: limited ? `真实复核用途：${reviewTasks.length}个活动任务、${reviewTargets.length}个显式对象；专业名不决定权限。`
      : '没有当前有效复核用途：按普通执行与资料归属判定，不授予复核特权。' };
}
export const 复核用途 = 复核读域;

/**
 * 这个对象 id 在不在读域里。
 * @param {ReturnType<typeof 复核读域>|null|undefined} 域
 * @param {string} id
 * @returns {boolean}
 */
export function 在读域(域, id) {
  if (!域?.限定) return true;
  return 域.集合.has(String(id ?? ''));
}

/**
 * 审计行是否落在读域：对象命中读域（且同项目），或读者自己的动作行（**同样先核项目**）。
 *
 * 为什么本人行也要核项目：审计是跨项目共享账本，`audit_tail(project=A)` 不许读出本人
 * 在 project=B 的行——项目是隔离单元，不是「本人任意项目都可读」。
 *
 * 唯一的全局自身记录口子（迁移补登 / 身份授权这类无项目行）：**对象 kind=身份 且对象 id=本人**。
 * 明确到对象位，不扩张成「本人所有行」。
 *
 * @param {object} row `audit.read()` 的一行（或工作台投影后的行）
 * @param {ReturnType<typeof 复核读域>|null|undefined} 域
 * @returns {boolean}
 */
export function 审计行在读域(row, 域) {
  if (!域?.限定) return true;
  const 主体 = String(row?.主体?.id ?? row?.主体 ?? '');
  const 对象 = String(row?.对象?.id ?? '');
  const 同项目 = !域.项目 || String(row?.项目 ?? '') === String(域.项目);
  if (主体 && 主体 === 域.主体 && 同项目) return true;
  if (主体 && 主体 === 域.主体
    && String(row?.对象?.kind ?? '') === '身份'
    && 对象 === 域.主体) {
    return true;
  }
  if (!域.集合.has(对象)) return false;
  // 读域命中的对象行同样必须同项目（同 id 跨项目会撞车）。
  return 同项目;
}

/**
 * 记忆条目是否落在读域：条目**同一项目** + 来源引用与读域有交集。
 * 只认来源引用这一条结构化血缘——按项目全量或按岗位标签召回都会把「相关账本」
 * 扩成「整个项目」，那等于没限定。
 * @param {object} entry `memory.query` 折出的条目
 * @param {ReturnType<typeof 复核读域>|null|undefined} 域
 * @returns {boolean}
 */
export function 记忆条目在读域(entry, 域) {
  if (!域?.限定) return true;
  if (String(entry?.项目 ?? '') !== String(域.项目 ?? '')) return false;
  const refs = Array.isArray(entry?.来源引用) ? entry.来源引用 : [];
  return refs.some((ref) => 域.集合.has(String(ref)));
}

/**
 * 工作台总线行是否落在读域：线程名与读域里的节点 id 走**同一等价类**
 * （NTFS 大小写不敏感，落线路径 `busThread` 就是这么落文件的；判定侧不许另造一套）。
 * @param {string} 线程
 * @param {ReturnType<typeof 复核读域>|null|undefined} 域
 * @returns {boolean}
 */
export function 线程在读域(线程, 域) {
  if (!域?.限定) return true;
  const 键 = 线程等价键(String(线程 ?? ''));
  for (const id of 域.集合) {
    if (线程等价键(id) === 键) return true;
  }
  return false;
}
