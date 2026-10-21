/**
 * 机制动作的**封闭清单**（v2 口述收敛 2026-10-18 条目8/12/20）。
 *
 * 为什么单开一个文件：条目8 把「系统」单列为主体一类，理由是机制动作要与人/组织的动作在
 * 账本上一眼分清。但「一眼分清」的前提是**系统能做的事是有限且可枚举的**——否则
 * `kind:'系统'` 就成了万能身份：任何代码路径只要拼一个 `{kind:'系统'}` 就拿到全权，
 * 而策略引擎在自治档里原本对落下来的主体一律 `allow`（这就是那条后门）。
 *
 * 这份清单是**唯一**的系统权限面：`policy.#机制不变式` 只认这里列出的
 * 「机制名 × 动作 × 授权档 × 目标类」。清单外的系统写 = 拒（fail-closed），
 * 不提供「其他类似情况」的兜底——兜底一开，清单就不再封闭。
 *
 * 谁可以构造系统主体：模型面做不到（`agentSubject` 只从宿主会话事实派生，
 * `args.role` / `args.实例` 的自报已被 runAction 拒），只有 import 本文件的机制代码能。
 * 所以「清单封闭」+「入口唯一」两件事合起来才成立，缺一条就有穿闸口子。
 *
 * 本清单不豁免失联冻结；系统主体的介入度仍走同一判定链。唯一有限例外是
 * `policy.withLeadBirth` 核验真实live根Agent首次登记自身Lead身份，且只免该笔出生的confirm。
 * 业务写、旧运行绑定与其他系统机制照常审批，不能仅凭本清单取得出生例外。
 * 「机制维护」不是「主权者不在也能改治理」的许可证。
 */

/**
 * 系统主体的**唯一**形状。id 写死 `system`：审计里要能与任何实例 id 区分开，
 * 也防止某个机制给自己起个看起来像实例的 id（审计归属就此模糊）。
 */
export const MECHANISM_SUBJECT = Object.freeze({ id: 'system', kind: '系统' });

/**
 * 封闭清单。每项 = 一个机制在账上允许的写动作面。
 *
 * 加一项 = 扩一条系统权限面 ⇒ 必须同时进审计与回归（`test/v2-instance-*` 钉着清单长度）；
 * 这里刻意不做「按前缀/正则匹配」的宽松条目——那等于把清单重新打开。
 *
 * @type {ReadonlyArray<{名: string, action: string, authority: string, kinds: ReadonlyArray<string>, 说明: string}>}
 */
export const MECHANISMS = Object.freeze([
  Object.freeze({
    名: '轮边界',
    action: 'create',
    authority: '只增',
    kinds: Object.freeze(['消息']),
    说明: '会审讨论换轮的 [debate-round] 边界消息：预算闸按它切轮，任何非机制主体自报即为伪造',
  }),
  Object.freeze({
    名: '会审解锁',
    action: 'create',
    authority: '只增',
    kinds: Object.freeze(['消息']),
    说明: '全员交卷后的齐卷解锁广播（发件=system）；目标类是总线的写入目标（消息）',
  }),
  Object.freeze({
    名: '实例出生',
    action: 'create',
    authority: '自治',
    kinds: Object.freeze(['身份']),
    说明: '根会话（Lead 实例）随会话出生时登记身份并钉住当时的卡版本（条目9/10）',
  }),
  Object.freeze({
    名: 'Lead运行绑定',
    action: 'write',
    authority: '自治',
    kinds: Object.freeze(['身份']),
    说明: '仅失效旧 Lead 运行绑定或由宿主真实根会话续接本代；不恢复封存或撤权身份',
  }),
  Object.freeze({
    名: '孤儿回收',
    action: 'seal',
    authority: '自治',
    kinds: Object.freeze(['身份']),
    说明: '崩溃/重启后按可靠进程代次判定为孤儿且 pid 已死的实例，由系统封存（条目12）',
  }),
].map((m) => Object.freeze(m)));

/** @type {Map<string, {名: string, action: string, authority: string, kinds: string[], 说明: string}>} */
const BY_NAME = new Map(MECHANISMS.map((m) => [m.名, m]));

/** 机制名清单（给错误信息与测试用；也用于「清单几项」这类回归断言）。 */
export const MECHANISM_NAMES = Object.freeze(MECHANISMS.map((m) => m.名));

/**
 * 一次系统写是否落在清单内。
 *
 * @param {unknown} 机制名 调用方声明的机制名（`context.机制动作`）
 * @param {string} action 动作
 * @param {string} authority 授权档
 * @param {string} kind 目标类
 * @returns {boolean} 清单内且三者都匹配 ⇒ true；其余一律 false（不抛，判定层要能给拒绝理由）
 */
export function mechanismAllows(机制名, action, authority, kind) {
  const 项 = BY_NAME.get(String(机制名 ?? ''));
  if (!项) return false;
  return 项.action === action && 项.authority === authority && 项.kinds.includes(kind);
}
