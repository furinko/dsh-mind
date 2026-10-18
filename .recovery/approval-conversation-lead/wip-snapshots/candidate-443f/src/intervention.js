/**
 * 介入度待决：请求 / 决议 / 一次性放行（v2 口述收敛 2026-10-18 条目 14/17/20/24）。
 *
 * 为什么单开这个域服务：预审/审批档拦下的自治写需要一个**请求实体**才能被主权者
 * 「逐请求」放行。把请求/决议/消费塞进动作层或工作台，会让每一处各自解释这些行；
 * 而它们必须共用一份指纹规范与一个状态机（单源）。
 *
 * 载体：**请求/决议/消费仍走审计账本**（追加式、链式哈希），不新建授权对象、不新建
 * 队列库（条目20：不立统一授权模型，用天然凭证）。另有一份**私有冻结记录**：
 *  - 审计行只留安全摘要（键名/长度/目标 id）+ 内容指纹 + 记录引用 —— 账本是可广投影的，
 *    不许把请求正文搬进去；
 *  - 私有记录（`mind-private/介入请求/<请求id>.json`）存**完整冻结参数**，读限
 *    主权者本人与合法原申请者。主权者批准前必须能预览这份完整内容，不许只看 hash 盲批；
 *    原申请者回放时执行的就是这份冻结请求（不是 AI 复述参数），跨重启可追。
 *
 * 身份边界（Lead 2026-10-18 修正）：主权者主体**只在本模块内部构造**，调用方不能传
 * subject/kind/role/面。`mind` 工具的 enum 里没有这些函数，模型面不可达；人侧入口
 * （同源路由的宿主 Connection 认证、人侧命令回调）才调得到。Owner 是天然凭证，
 * 自己决定不需要再批准自己——策略引擎的介入度判定本就只罩自治档
 * （`subject.kind !== '主权者'`）。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'node:path';
import { canonical, digest } from './kernel/text.js';
import { atomicWrite, readJsonOrNull, withLock } from './kernel/fsx.js';
import { Denied, InvalidBody } from './kernel/errors.js';

export const 请求动作 = '介入请求';
export const 决议动作 = '介入决议';
export const 占用动作 = '介入放行占用';
export const 完成动作 = '介入完成';
export const 失败动作 = '介入失败';

/** 决议取值：批准 / 拒绝 / 撤销（撤销 = 主权者收回未消费的请求）。 */
export const 决议取值 = Object.freeze(['批准', '拒绝', '撤销']);

/** 私有冻结记录的封存版本（形状变了就升版本，旧记录按版本拒读）。 */
const 记录版本 = 1;

/** 收口态：同一请求再被拦（重复行）也不许把状态复活——「不能凭同参猜已完成」。 */
const 收口态 = new Set(['已完成', '已拒绝', '已撤销']);

const 放行上下文 = new AsyncLocalStorage();

/**
 * 去掉「凭据/派生字段」后的入参：指纹与冻结记录只认请求内容本身。
 * `审批引用` 是重放凭据（换一次就换指纹会和请求对不上）；`action`/`project` 由记录的
 * 显式两栏承载，留在入参里会让同一个请求出现两种写法。
 * @param {object} args
 * @returns {object}
 */
function 净入参(args) {
  const 净 = { ...(args ?? {}) };
  for (const 键 of ['审批引用', 'action', 'project', '请求id']) delete 净[键];
  return 净;
}

/**
 * 请求的安全摘要：**只记键名与形状，不记正文**（审计行可被项目内投影，正文另走私有记录）。
 * @param {object} args
 * @returns {{键: string[], 形状: Record<string, string>}}
 */
export function 安全摘要(args) {
  const 入参 = 净入参(args);
  const 键 = Object.keys(入参).sort();
  /** @type {Record<string, string>} */
  const 形状 = {};
  for (const k of 键) {
    const v = 入参[k];
    形状[k] = Array.isArray(v) ? `数组(${v.length})`
      : v === null ? 'null'
        : typeof v === 'string' ? `文本(${v.length})`
          : typeof v === 'object' ? '对象'
            : typeof v;
  }
  return { 键, 形状 };
}

/**
 * 规范化「步骤计划」——宏动作与底层策略的**唯一翻译层**。
 *
 * 为什么要有计划：一个工具动作（task_create / member_spawn / task_settle）在底层会走
 * 多次 policy.check，动作名与目标 id 都不是宏名（`task_create` ⇒ `action:'create'`；
 * 新建对象的 id 每次生成都不同）。拿宏名或临时 id 去匹配必定对不上，于是批准后
 * 一放就再挂、死循环。计划把「这次要发生哪些写」在**副作用之前**冻下来：
 *  - 匹配只认底层的 `动作 + 目标.kind`；`新: true` 的步不认 id（新建对象），
 *    其余步认 id（既有对象）；
 *  - 每步默认只能用 1 次（`次数` 可显式放宽，用于已知重复），所以不是全局豁免；
 *  - `写` 是稳定写入标签（可选）：同一次业务写的锁外预检与锁内复判共用它，
 *    不同写入意图必须不同（任务写的 `节点操作` 就属于这一类）；
 *  - `内容指纹` 把该步真正将写的内容/作用一起冻住：内容变了 = 计划不符 = 重新批。
 * @param {Array<object>} 步骤
 * @returns {Array<object>}
 */
export function 规范步骤(步骤) {
  const 名单 = Array.isArray(步骤) ? 步骤 : [];
  return 名单.map((步, i) => {
    const 目标 = 步?.目标 ?? {};
    return {
      序: Number.isInteger(步?.序) ? 步.序 : i + 1,
      动作: String(步?.动作 ?? ''),
      写: 步?.写 == null || String(步.写) === '' ? null : String(步.写),
      目标: {
        kind: 目标.kind ?? null,
        id: 目标.id ?? null,
        新: 目标.新 === true,
        authority: 目标.authority ?? null,
        zone: 目标.zone ?? null,
        project: 目标.project ?? null,
      },
      ...(步?.补偿自 != null ? { 补偿自: Number(步.补偿自) } : {}),
      次数: Number.isInteger(步?.次数) && 步.次数 > 0 ? 步.次数 : 1,
      说明: String(步?.说明 ?? ''),
      预览: 步?.预览 ?? null,
      内容指纹: digest(canonical({ 说明: String(步?.说明 ?? ''), 预览: 步?.预览 ?? null })),
    };
  });
}

/**
 * 本次调用链是否带一次性放行。**只读**：唯一写入点是 `以放行上下文`，
 * 它由重放路径（校验放行之后）包住那一次执行；不进入任何持久状态，重启即无。
 * @returns {{原主体?: string, 请求id?: string, 步骤?: object[], 已用?: Map<number, number>,
 *            已匹配?: Map<string, {请求id: string, 序: number, 说明: string}>}|null}
 */
export function 当前放行() {
  return 放行上下文.getStore() ?? null;
}

/**
 * 以一次性放行上下文执行。作用域仅这一次调用链（AsyncLocalStorage），
 * 并发调用互不串味；每次执行自带两份账（不可由调用方预置）：
 *  - `已用`：每步已消耗次数；
 *  - `已匹配`：写入身份 → 该次业务写对上的步（**重复检查幂等**，见 `本次放行匹配`）。
 * @template T
 * @param {{原主体: string, 请求id: string, 步骤: object[]}} 上下文
 * @param {() => Promise<T>|T} fn
 * @returns {Promise<T>|T}
 */
export function 以放行上下文(上下文, fn) {
  // 计划在这里**再归一一次**：调用方给的是带 说明/预览 的原始步骤（没有 序 就要现编），
  // 不归一就所有步骤共用同一个 `undefined` 计数键 —— 第一步一用，其余全被当成用尽。
  return 放行上下文.run({ ...(上下文 ?? {}), 步骤: 规范步骤(上下文?.步骤), 已用: new Map(), 已匹配: new Map(), 新建: new Map() }, fn);
}

/**
 * 一次「写入」的身份：同一次业务写的锁外预检与锁内复判用**同一个身份**，
 * 不同的真实写入（例如同一任务节点上的 dispatch 与 bind）用不同的标签。
 *
 * 为什么不能只按「步序」计数：同一业务写可能 `policy.decide` 两次（锁外预检 + 锁内复判），
 * 第一次就耗尽一步会让锁内那次再 confirm —— 重复检查不是重复副作用。反过来，真的第二个
 * 新建会生成新的 id（身份不同）⇒ 必须再消耗一步，不能借重复检查豁免。
 * @param {string} action @param {object} target @param {object|null} context
 * @returns {string}
 */
function 写入身份(action, target, context) {
  const 写标签 = String(context?.介入写 ?? context?.节点操作 ?? '');
  return `${String(action ?? '')}|${String(target?.kind ?? '')}|${String(target?.id ?? '')}|${写标签}`;
}

/**
 * 登记适配器确认已真实首登后，绑定本请求的新对象与创建步；不授予计划外动作。
 * @param {object} subject 原申请者
 * @param {object} target 已落盘的新对象（调用方必须核验首登与归属）
 * @returns {boolean} 无放行上下文或未匹配新建步时不登记
 */
export function 记录本次新建(subject, target) {
  const 放行 = 放行上下文.getStore();
  if (!放行 || String(放行.原主体) !== String(subject?.id)) return false;
  const 命中 = 放行.已匹配.get(写入身份('create', target, null));
  const 步 = 放行.步骤.find(x => x.序 === 命中?.序);
  if (!步 || 步.动作 !== 'create' || 步.目标.新 !== true) return false;
  放行.新建.set(`${target.kind}|${target.id}`, 步.序);
  return true;
}

/** 计划步与本次底层写是否同一形状（动作/kind/id/写标签/三标签）。 */
function 步骤对上(步, action, target, 写标签) {
  if (String(步.动作 ?? '') !== String(action ?? '')) return false;
  if (步.写 != null && String(步.写) !== 写标签) return false;
  const 目标 = 步.目标 ?? {};
  if (String(目标.kind ?? '') !== String(target?.kind ?? '')) return false;
  if (目标.新 !== true && 步.补偿自 == null && String(目标.id ?? '') !== String(target?.id ?? '')) return false;
  if (目标.authority && target?.authority && 目标.authority !== target.authority) return false;
  if (目标.zone && target?.zone && 目标.zone !== target.zone) return false;
  if (目标.project && target?.project && 目标.project !== target.project) return false;
  return true;
}

/** @param {object} 放行 @param {string} action @param {object} target @param {string} 写标签 */
function 找可用步(放行, action, target, 写标签) {
  for (const 步 of 放行.步骤) {
    if ((放行.已用.get(步.序) ?? 0) >= (步.次数 ?? 1)) continue;
    if (!步骤对上(步, action, target, 写标签)) continue;
    if (步.补偿自 != null && (步.动作 !== 'seal' || 步.目标.kind !== '身份'
      || 放行.新建?.get(`${target?.kind}|${target?.id}`) !== 步.补偿自)) continue;
    return 步;
  }
  return null;
}

/**
 * 本次被批准的写能不能对上计划里的某一步（对上就消耗一次；**同一写入身份的重复检查幂等**）。
 *
 * 硬约束（都为了「不是全局豁免」）：
 *  - 主体必须是原申请者；
 *  - 只认底层的 `动作 + 目标.kind`，宏动作名从不参与；
 *  - `新: true` 的步不认 id，其余步必须 id 相等；
 *  - 写标签（`context.介入写` / 任务图的 `节点操作`）：步里给了就必须对上；
 *  - 每步按 `次数` 限量；超了或不在计划里 ⇒ null（回到正常 confirm/deny）；
 *  - 同一写入身份再次来判（锁外预检后锁内复判）⇒ 返回同一允许事实、**不再消耗**。
 *
 * 返回的是**匹配事实**，不是授权：policy 在「介入度 confirm」那一支拿它免掉本次挂起，
 * 其余硬闸（不变式/拒名单/失联/复核员只读/父域/硬拒）在前面已经判完。
 * @param {object} subject
 * @param {string} action 底层 policy 动作
 * @param {object} target
 * @param {object|null} [context]
 * @returns {{请求id: string, 序: number, 说明: string, 重复?: boolean}|null}
 */
export function 本次放行匹配(subject, action, target, context = null) {
  const 放行 = 放行上下文.getStore();
  if (!放行 || !Array.isArray(放行.步骤) || !(放行.已用 instanceof Map)) return null;
  if (String(放行.原主体 ?? '') !== String(subject?.id ?? '')) return null;
  const 身份 = 写入身份(action, target, context);
  const 已匹配 = 放行.已匹配 instanceof Map ? 放行.已匹配.get(身份) : null;
  if (已匹配) return { ...已匹配, 重复: true };
  const 写标签 = String(context?.介入写 ?? context?.节点操作 ?? '');
  const 步 = 找可用步(放行, action, target, 写标签);
  if (!步) return null;
  放行.已用.set(步.序, (放行.已用.get(步.序) ?? 0) + 1);
  const 命中 = { 请求id: String(放行.请求id ?? ''), 序: 步.序, 说明: 步.说明 ?? '' };
  放行.已匹配.set(身份, 命中);
  return 命中;
}

/**
 * 只看不消耗：本次子写**是否**对得上已批准计划里的某一步（重复检查的已匹配身份也算）。
 *
 * 谁用它：受控父判。父判可能在同一动作上再返回一次「介入度 confirm」；那是**同一真实父**
 * 的重复确认，不能把已经由 Owner 批准过的子请求再卡一次。父判只 peek、不消费，
 * 真正的子写自己的判定点才会消费那一步。父 deny / 父故障 / 其它类 confirm 不走这里。
 * @param {object} subject @param {string} action @param {object} target @param {object|null} [context]
 * @returns {boolean}
 */
export function 本次放行可匹配(subject, action, target, context = null) {
  const 放行 = 放行上下文.getStore();
  if (!放行 || !Array.isArray(放行.步骤) || !(放行.已用 instanceof Map)) return false;
  if (String(放行.原主体 ?? '') !== String(subject?.id ?? '')) return false;
  const 身份 = 写入身份(action, target, context);
  if (放行.已匹配 instanceof Map && 放行.已匹配.has(身份)) return true;
  return 找可用步(放行, action, target, String(context?.介入写 ?? context?.节点操作 ?? '')) !== null;
}

export class InterventionService {
  /**
   * @param {{ layout: object, clock: object, audit: object, policy: object, registry?: object,
   *           卡版本Of?: ((id: string) => Promise<string|null>|string|null)|null,
   *           目标代Of?: ((spec: {id: string, kind: string, 项目: string}) => Promise<number|string|null>|number|string|null)|null,
   *           交互来源?: string }} parts
   *   `卡版本Of` / `目标代Of`：把「原主体的卡版本 / 目标代」冻进请求记录，并在重放与投影时
   *   复核；读不到就返回 null（不猜通过）。`交互来源`：本人交互记入失联时钟的来源名，
   *   默认「人侧入口」（registry 白名单已登记）；只有本模块的人侧函数会用它。
   */
  constructor({ layout, clock, audit, policy, registry = null, 卡版本Of = null, 目标代Of = null, 交互来源 = '人侧入口' }) {
    this.layout = layout;
    this.clock = clock;
    this.audit = audit;
    this.policy = policy;
    this.registry = registry;
    this.卡版本Of = 卡版本Of;
    this.目标代Of = 目标代Of;
    this.交互来源 = 交互来源;
  }

  /**
   * 规范化请求：指纹的**唯一输入**。参数置换、换主体、换卡版本、换目标代、换项目都会不同。
   * @param {{subject: object, action: string, args: object, 目标?: object|null, 项目?: string|null}} spec
   * @returns {{主体: object, 动作: string, 入参: object, 目标: object|null, 项目: string|null}}
   */
  规范请求({ subject, action, args, 目标 = null, 项目 = null }) {
    return {
      主体: {
        id: String(subject?.id ?? ''),
        kind: subject?.kind ?? null,
        roleId: subject?.roleId ?? null,
        卡版本: subject?.卡版本 ?? null,
      },
      动作: String(action ?? ''),
      入参: 净入参(args),
      目标: 目标 ? { id: 目标.id ?? null, kind: 目标.kind ?? null, 代: 目标.代 ?? null } : null,
      项目: 项目 ?? null,
    };
  }

  /**
   * 请求指纹（sha256 hex）。它就是请求 id——账本行对象 id、决议绑定值、记录文件名同一个。
   * @param {{subject: object, action: string, args: object, 目标?: object|null, 项目?: string|null}} spec
   * @returns {string}
   */
  请求指纹(spec) {
    return digest(canonical(this.规范请求(spec)));
  }

  /**
   * 登记一次被拦下的写：写私有冻结记录 + 追加「介入请求」审计行（同一指纹只建一行）。
   *
   * 顺序有意：**先写冻结记录，再落审计行**——账上出现的请求一定预览得到完整内容；
   * 记录写失败就不登记（调用方拿到错误，而不是一条无法批准的待决）。
   * @param {{subject: object, action: string, args: object, 目标?: object|null, 项目?: string|null,
   *          档位: string, 规则?: string, 策略行?: {seq: number, hash: string}|null}} spec
   * @returns {Promise<{请求id: string, 已存在: boolean, 状态: string, 请求行?: {seq: number, hash: string}|null, 内容摘要?: string}>}
   */
  async 记请求({ subject, action, args, 目标 = null, 项目 = null, 档位, 规则 = '', 策略行 = null, 步骤 = [] }) {
    if (!档位) throw new InvalidBody('记请求需要 档位：请求记录要冻住「当时凭什么挂起」。', { missing: ['档位'] });
    // 计划是宏动作 → 底层策略的唯一翻译层；没有计划 = 批准对应不到任何一次写 ⇒ 拒绝登记，
    // 逼调用方在**副作用之前**把「这次要发生哪些写、各写什么内容」摊开（不静默跳过）。
    const 步骤规范 = 规范步骤(步骤);
    if (步骤规范.length === 0) {
      throw new InvalidBody('记请求必须带步骤计划（至少一步：底层 policy 动作 + 目标 kind；新建对象标 新:true）。没有计划的批准无法对应到任何一次写。', { missing: ['步骤'] });
    }
    // 卡版本/目标代一并冻进请求：读不到就是 null（不猜），重放/投影时同样不猜通过。
    const 主体 = {
      ...(subject ?? {}),
      卡版本: (subject?.id && this.卡版本Of ? await this.卡版本Of(String(subject.id)) : null) ?? subject?.卡版本 ?? null,
    };
    const 目标位 = 目标
      ? {
        id: 目标.id ?? null,
        kind: 目标.kind ?? null,
        代: 目标.代 ?? (目标.id && this.目标代Of ? await this.目标代Of({ id: String(目标.id), kind: 目标.kind ?? null, 项目: 项目 ?? null }) : null),
      }
      : null;
    const 指纹 = this.请求指纹({ subject: 主体, action, args, 目标: 目标位, 项目 });
    // 同一请求的并发登记也只留一行：锁内读-写-落账。
    return withLock(this.#锁路径(指纹), async () => {
      const 项 = this.#折叠(await this.audit.read(项目 ? { project: 项目 } : {})).get(指纹);
      if (项) return { 请求id: 指纹, 已存在: true, 状态: 项.状态, 请求行: 项.请求行, 内容摘要: 项.内容摘要 };
      const 冻结 = {
        版本: 记录版本,
        请求id: 指纹,
        请求指纹: 指纹,
        动作: String(action ?? ''),
        项目: 项目 ?? null,
        档位,
        规则,
        主体,
        目标: 目标位,
        入参: 净入参(args),
        步骤: 步骤规范,
        冻结于: this.clock.iso(),
      };
      // 摘要必须在**JSON 往返之后**算：落盘走 JSON.stringify（丢 undefined 值），
      // 读取侧复算吃的是解析回来的对象——两边形状不一致时摘要会自己打自己（预览里
      // 一个 undefined 字段就够）。先归一，再算摘要，再写。
      const 落盘 = JSON.parse(JSON.stringify(冻结));
      落盘.内容摘要 = digest(canonical(落盘));
      await this.#写冻结(指纹, 落盘);
      const 行 = await this.audit.append({
        动作: 请求动作,
        主体,
        对象: { id: 指纹, kind: '介入请求' },
        依据: `法律 介入度 · ${档位}（v2 条目14/17/24）：高风险自治写挂起，等主权者逐请求放行`,
        结果: '待放行',
        项目: 项目 ?? null,
        详情: {
          请求指纹: 指纹,
          档位,
          动作: action,
          目标: 目标位,
          安全摘要: 安全摘要(args),
          步骤数: 步骤规范.length,
          规则,
          策略行,
          // 正文不进账：只留记录引用与内容指纹（记录本体在私有区）。
          请求记录: { 请求id: 指纹, 摘要: 落盘.内容摘要 },
        },
      });
      return { 请求id: 指纹, 已存在: false, 状态: '待放行', 请求行: { seq: 行.seq, hash: 行.hash }, 内容摘要: 落盘.内容摘要 };
    });
  }

  /**
   * 读完整冻结请求（主权者本人 / 合法原申请者）。批准前的预览、跨重启的重放都走这里。
   * @param {{请求id: string, subject: object}} spec
   * @returns {Promise<object>}
   */
  async 读冻结({ 请求id, subject }) {
    const 记录 = await this.#读冻结(String(请求id ?? ''));
    if (!记录) throw new InvalidBody(`没有这个介入请求记录：${请求id}。记录缺失时不能预览、也不能盲批。`, { missing: ['请求id'] });
    const 是本人 = subject?.kind === '主权者';
    const 是原申请者 = String(subject?.id ?? '') === String(记录.主体?.id ?? '');
    if (!是本人 && !是原申请者) {
      throw new Denied('法律 介入度 · 完整请求只给主权者与原申请者（v2 条目14/17）', `完整冻结请求只对主权者本人与合法原申请者（${记录.主体?.id ?? '?'}）开放：它不是公开读数。`, {
        requireAuthority: '主权者',
        howToChange: '原申请者用自己的实例（同一主体）回放；看清单摘要用工作台/设置页的待决投影。',
        detail: { 请求id: String(请求id ?? ''), 申请人: 记录.主体?.id ?? null },
      });
    }
    return 记录;
  }

  /**
   * 主权者本人的决定（人侧入口专用）。
   *
   * 主体在这里**内部构造**，不接受任何入参里的 subject/kind/role/面——
   * 「谁批准」只能由「从哪条入口进来」决定，不能由调用方声明。
   * 决定前必须能读到完整冻结记录（不能盲批）；批准/拒绝/撤销都算一次有效本人交互
   * （恢复失联），但**不等于**批准别的待决。
   *
   * @param {{请求id: string, 决定: '批准'|'拒绝'|'撤销', 理由?: string, 通道: string, 认证: string, 项目?: string|null, 会话?: string|null, 审阅指纹?: string|null}} spec
   * @returns {Promise<{请求id: string, 决定: string, 决议行: {seq: number, hash: string}, 主体: object, 交互: object}>}
   */
  async 人侧决议({ 请求id, 决定, 理由 = '', 通道, 认证, 项目 = null, 会话 = null, 审阅指纹 = null }) {
    if (!决议取值.includes(决定)) {
      throw new InvalidBody(`人侧决议只认 ${决议取值.join(' / ')}，收到 ${JSON.stringify(决定 ?? null)}。`, { missing: ['决定'] });
    }
    if (!通道 || !认证) {
      throw new InvalidBody('人侧决议必须声明入口与认证事实（通道/认证）：来源不许由调用方省略，也不许由模型面补造。', { missing: ['通道', '认证'] });
    }
    const 指纹 = String(请求id ?? '');
    if (!/^[a-f0-9]{64}$/.test(指纹)) throw new InvalidBody('人侧决议需要合法请求id（64位请求指纹）。', { missing: ['请求id'] });
    // 与登记/重放共用同一把请求锁，双击或并发批准不能同时读到待放行。
    return withLock(this.#锁路径(指纹), async () => {
      const 项 = this.#折叠(await this.#读(项目)).get(指纹);
      if (会话 !== null && (!会话 || 项?.原主体?.id !== 会话)) {
        throw new InvalidBody('请求不属于此会话；拒绝跨会话决议。', { missing: ['会话'] });
      }
      if (审阅指纹 !== null) {
        const 当前 = (await this.人侧待决({ 项目, 会话 })).find(x => x.请求id === 指纹);
        if (!审阅指纹 || !当前 || 当前.审阅指纹 !== 审阅指纹 || 当前.记录问题) {
          throw new InvalidBody('审阅版本已变化或完整冻结记录不可用；请重新读取完整计划后决定。', { missing: ['审阅指纹'] });
        }
        if (!当前.可选项.includes(决定)) throw new InvalidBody(`请求当前「${当前.状态}」不可${决定}。`, { missing: ['决定'] });
      }
      if (!项) {
        throw new InvalidBody(`没有这个介入请求：${指纹}。请求 id 就是请求指纹（「介入请求」账本行的 对象.id）。`, { missing: ['请求id'] });
      }
      const 允许 = 决定 === '撤销'
        ? ['待放行', '已批准待重放', '占用未报告', '失败']
        : ['待放行', '失败'];
      if (收口态.has(项.状态) || !允许.includes(项.状态)) {
        throw new Denied(
          '法律 介入度 · 决议只对未收口的请求（v2 条目14/17）',
          `介入请求 ${指纹} 当前是「${项.状态}」：${决定} 不能应用。收口态不复活，重复决议不产生第二份副作用。`,
          {
            requireAuthority: '主权者',
            howToChange: '看「介入审批」清单里该请求的当前状态；要重新申请，由原申请者按原动作再发起一次（会得到新请求）。',
            detail: { 请求id: 指纹, 状态: 项.状态, 收到决定: 决定 },
          },
        );
      }
      // 不盲批：记录读不到或摘要不符，决议直接拒绝（fail-closed）。
      const 冻结 = await this.#读冻结(指纹);
      if (!冻结) {
        throw new InvalidBody(`介入请求 ${指纹} 的完整冻结记录缺失：没有可预览的内容，不能由主权者拍板。`, { missing: ['请求记录'] });
      }
      // 主权者主体：本方法内部构造 —— 调用方传什么 subject/kind 都不参与。
      const 主体 = { id: 'sovereign', kind: '主权者' };
      const 行 = await this.audit.append({
        动作: 决议动作,
        主体,
        对象: { id: 指纹, kind: '介入请求' },
        依据: `人侧入口：${通道}（${认证}）· v2 条目14/17/20`,
        结果: 决定,
        项目: 项.项目,
        详情: { 请求指纹: 指纹, 请求行: 项.请求行, 理由, 入口: { 通道, 认证 }, 请求记录: { 请求id: 指纹, 摘要: 冻结.内容摘要 } },
      });
      const 交互 = await this.记本人交互();
      return { 请求id: 指纹, 决定, 决议行: { seq: 行.seq, hash: 行.hash }, 主体, 交互 };
    });
  }

  /**
   * 重放前校验并**一次性占用**。校验通过后返回**冻结请求**；调用方必须用这份冻结 `入参`
   * 执行那一次调用（不是模型复述的参数），成功再 `记完成`、失败 `记失败`。
   *
   * 判据与投影同一把尺：原主体/卡版本/动作/目标代/档位/决议状态都在账本与冻结记录里；
   * 调用方额外传的 `入参`/`步骤` 只用于**发现置换**（与冻结不一致即拒），绝不拿它们执行。
   * `步骤` 必须由同一条执行链在**副作用之前**重新摊出来：计划变了（少写/多写/内容变）
   * 就不许拿旧批准去跑——否则「批准 A」会被当成「同一链里任意 B」的豁免。
   *
   * @param {{请求id: string, subject: object, action?: string, 入参?: object, 步骤?: Array<object>}} spec
   * @returns {Promise<{ok: boolean, 状态: string, 原因?: string, 请求id?: string, 决议?: object,
   *                    决议行?: object, 占用?: {seq: number, hash: string}, 档位?: string,
   *                    冻结?: {动作: string, 入参: object, 目标: object|null, 项目: string|null, 步骤: Array<object>}}>}
   */
  async 校验放行({ 请求id, subject, action = null, 入参 = undefined, 步骤 = null }) {
    const 指纹 = String(请求id ?? '');
    if (!指纹) throw new InvalidBody('校验放行需要 请求id（请求指纹）', { missing: ['请求id'] });
    // 占用是「读-判-写」：同一请求并发重放会双双读到「已批准待重放」——锁内只剩一个赢家。
    return withLock(this.#锁路径(指纹), async () => {
      const 项 = this.#折叠(await this.audit.read({})).get(指纹);
      if (!项) return { ok: false, 状态: '无决议', 原因: '没有这个介入请求（请求 id 不存在）。' };
      const 同人 = await this.#同一主体(项.原主体, subject);
      if (!同人.ok) return { ok: false, 状态: '主体不符', 原因: 同人.原因 };
      if (action !== null && String(action) !== String(项.动作)) {
        return { ok: false, 状态: '动作不符', 原因: `请求冻结的动作是「${项.动作}」，本次是「${action}」：不能拿这笔放行执行别的动作。` };
      }
      const 档位 = this.policy?.intervention?.() ?? null;
      if (项.档位 && 档位 && 档位 !== 项.档位) {
        return { ok: false, 状态: '已失效', 原因: `介入度已从「${项.档位}」改为「${档位}」：旧批准失效，需按现档位重新申请。` };
      }
      if (项.状态 !== '已批准待重放') {
        return { ok: false, 状态: 项.状态, 原因: `介入请求当前是「${项.状态}」，不是「已批准待重放」。` };
      }
      let 冻结;
      try {
        冻结 = await this.#读冻结(指纹);
      } catch (error) {
        return { ok: false, 状态: '记录不可用', 原因: error instanceof Error ? error.message : String(error) };
      }
      if (!冻结) return { ok: false, 状态: '记录缺失', 原因: '完整冻结记录缺失：没有可验证的原请求，拒绝执行。' };
      if (冻结.请求指纹 !== 指纹 || String(冻结.主体?.id ?? '') !== String(项.原主体?.id ?? '')) {
        return { ok: false, 状态: '记录不符', 原因: '冻结记录与账本请求对不上（疑似被替换）：拒绝执行。' };
      }
      if (入参 !== undefined && canonical(净入参(入参)) !== canonical(冻结.入参)) {
        return { ok: false, 状态: '参数置换', 原因: '本次调用参数与冻结请求不一致：批准只能重放原请求，不能换参数。' };
      }
      if (步骤 !== null && 步骤 !== undefined && canonical(规范步骤(步骤)) !== canonical(冻结.步骤 ?? [])) {
        return { ok: false, 状态: '计划不符', 原因: '本次执行将发生的写与批准时冻结的步骤计划不一致（少写 / 多写 / 内容变）：不能拿旧批准跑新计划。' };
      }
      const 当前卡 = await this.#卡版本(subject);
      if (项.原主体?.卡版本 && !当前卡) {
        return { ok: false, 状态: '已失效', 原因: '原主体的当前卡版本读不到（不猜通过）。' };
      }
      if (项.原主体?.卡版本 && 当前卡 && 当前卡 !== 项.原主体.卡版本) {
        return { ok: false, 状态: '已失效', 原因: '原主体的卡版本已变：旧批准按当时那一版卡做出，不能跨版重放。' };
      }
      const 当代 = 项.目标?.id && this.目标代Of
        ? await this.目标代Of({ id: 项.目标.id, kind: 项.目标.kind ?? null, 项目: 项.项目 })
        : null;
      if (项.目标?.代 != null && 当代 != null && String(当代) !== String(项.目标.代)) {
        return { ok: false, 状态: '已失效', 原因: `目标已更新（代 ${项.目标.代} → ${当代}）：旧批准不作用于新目标。` };
      }
      const 占用 = await this.audit.append({
        动作: 占用动作,
        主体: subject,
        对象: { id: 指纹, kind: '介入请求' },
        依据: '法律 介入度 · 已批准放行（v2 条目14/17）：原申请者按冻结请求重放，一次性占用',
        结果: '占用',
        项目: 项.项目,
        详情: { 请求指纹: 指纹, 决议行: 项.决议行, 档位 },
      });
      return {
        ok: true,
        请求id: 指纹,
        决议: 项.决议,
        决议行: 项.决议行,
        占用: { seq: 占用.seq, hash: 占用.hash },
        档位,
        冻结: { 动作: 冻结.动作, 入参: 冻结.入参, 目标: 冻结.目标, 项目: 冻结.项目, 步骤: 冻结.步骤 ?? [] },
      };
    });
  }

  /**
   * 真实执行成功后收口。**先占用后执行**：只有成功才写这一行，
   * 「批准 ≠ 已写」在账上一眼可读。
   * @param {{请求id: string, 主体: object, 占用行: {seq: number, hash: string}, 项目?: string|null,
   *          产出?: Array<{序?: number, kind?: string, id?: string}>}} spec
   *   `产出`：本次真正创建出来的对象 id（新建对象的步匹配不认 id，这里补上可追）。
   */
  async 记完成({ 请求id, 主体, 占用行, 项目 = null, 产出 = [] }) {
    const 指纹 = String(请求id ?? '');
    const 行 = await this.audit.append({
      动作: 完成动作,
      主体,
      对象: { id: 指纹, kind: '介入请求' },
      依据: '法律 介入度 · 放行已执行且真实写成功（v2 条目14/17）',
      结果: '已完成',
      项目,
      详情: { 请求指纹: 指纹, 占用行, ...(Array.isArray(产出) && 产出.length > 0 ? { 产出 } : {}) },
    });
    return { 完成行: { seq: 行.seq, hash: 行.hash } };
  }

  /**
   * 执行失败：如实记失败，批准即被这次尝试消费（不自动重试，避免重复副作用）；
   * 要再来一次是主权者的下一次决定，不是系统回放。
   * @param {{请求id: string, 主体: object, 占用行: {seq: number, hash: string}, 原因: string, 项目?: string|null}} spec
   */
  async 记失败({ 请求id, 主体, 占用行, 原因, 项目 = null }) {
    const 指纹 = String(请求id ?? '');
    const 行 = await this.audit.append({
      动作: 失败动作,
      主体,
      对象: { id: 指纹, kind: '介入请求' },
      依据: '法律 介入度 · 放行已执行但写失败（v2 条目14/17）：批准不自动重试，需重新决定',
      结果: '失败',
      项目,
      详情: { 请求指纹: 指纹, 占用行, 原因: String(原因 ?? '').slice(0, 500) },
    });
    return { 失败行: { seq: 行.seq, hash: 行.hash } };
  }

  /**
   * 待决投影（只读，**不含正文**）：把账本行折成「每一单现在是什么状态」。
   *
   * 状态只由**事实**决定：决议/占用/完成/失败行 + 当前档位 + 卡版本 + 目标代。
   * 没有任何一条分支会「凭同参数猜已完成」——完成必须真有完成行。
   * @param {{项目?: string|null, 当前档位?: string|null}} [spec]
   * @returns {Promise<object[]>}
   */
  async 投影({ 项目 = null, 当前档位 = null } = {}) {
    const 档位 = 当前档位 ?? this.policy?.intervention?.() ?? null;
    const 项们 = [...this.#折叠(await this.#读(项目)).values()];
    /** @type {object[]} */
    const 清单 = [];
    for (const 项 of 项们) {
      const 状态 = await this.#判状态(项, 档位);
      清单.push({
        类型: '介入审批',
        请求id: 项.请求id,
        状态,
        原主体: 项.原主体,
        动作: 项.动作,
        目标: 项.目标,
        档位: 项.档位,
        项目: 项.项目,
        安全摘要: 项.安全摘要,
        内容摘要: 项.内容摘要,
        步骤数: 项.步骤数,
        请求行: 项.请求行,
        决议: 项.决议 ?? null,
        决议行: 项.决议行 ?? null,
        理由: 项.决议?.理由 ?? '',
        入口: 项.决议?.入口 ?? null,
        失败原因: 项.失败原因 ?? '',
        完成行: 项.完成行 ?? null,
        可选项: 状态 === '已批准待重放' || 状态 === '占用未报告' ? ['撤销']
          : 状态 === '待放行' || 状态 === '失败' ? ['批准', '拒绝', '撤销']
            : [],
      });
    }
    return 清单;
  }

  /**
   * 人侧待决清单：在 `投影` 之上补**完整冻结请求**，供主权者批准前预览。
   * 只给人侧路由/设置页用（它是人类入口；账本投影与工作台不得拿它当公共读数）。
   * @param {{项目?: string|null, 会话?: string|null}} [spec]
   * @returns {Promise<object[]>}
   */
  async 人侧待决({ 项目 = null, 会话 = null } = {}) {
    if (会话 !== null && (typeof 会话 !== 'string' || !会话.trim())) {
      throw new InvalidBody('会话范围不能为空；不猜测当前会话。', { missing: ['会话'] });
    }
    const 清单 = (await this.投影({ 项目 })).filter(x => 会话 === null || x.原主体?.id === 会话);
    for (const 项 of 清单) {
      try {
        const 记录 = await this.#读冻结(项.请求id);
        if (记录) {
          if (记录.请求id !== 项.请求id || 记录.内容摘要 !== 项.内容摘要 || 记录.主体?.id !== 项.原主体?.id || 记录.项目 !== 项.项目) {
            throw new InvalidBody('完整冻结记录与请求账本不符，禁止展示或决定。', { missing: ['请求记录'] });
          }
          项.完整请求 = 记录.入参;
          // 完整意图：每一步写什么、作用是什么（正文预览，不只 hash）。
          项.步骤 = 记录.步骤 ?? [];
          项.冻结于 = 记录.冻结于;
          项.审阅指纹 = digest(canonical({ 内容摘要: 记录.内容摘要, 请求行: 项.请求行, 状态: 项.状态, 决议行: 项.决议行 }));
        } else {
          项.记录问题 = '完整冻结记录缺失，不能盲批。';
        }
      } catch (error) {
        项.记录问题 = error instanceof Error ? error.message : String(error);
      }
    }
    return 清单;
  }

  /**
   * 以**人侧身份**执行一段人侧写（设置入口专用）。主体由本方法内部构造，调用方拿不到
   * 构造权、也不能传 subject/kind/role/面。
   *
   * 为什么不是「导出一个主权者常量」：那等于谁 import 谁就能冒充。只有人侧适配器
   * （命令面专属的 `presence` 动作 / 同源路由）才会调到这里；模型工具面的动作清单里
   * 没有它。
   * @template T
   * @param {{通道: string, 执行: (subject: object) => Promise<T>|T}} spec
   * @returns {Promise<T>}
   */
  async 以人侧身份({ 通道, 执行 }) {
    if (!通道 || typeof 执行 !== 'function') {
      throw new InvalidBody('以人侧身份需要 通道 与 执行 回调：身份由入口决定，不接受调用方声明。', { missing: ['通道', '执行'] });
    }
    const 主体 = { id: 'sovereign', kind: '主权者' };
    return await 执行(主体);
  }

  /**
   * 记录一次「本人有效交互」（改设置有写意图、审批决议时调用）：恢复失联时钟。
   * 只记迁移那一刻（registry 的口径），常规心跳不刷账。
   * @returns {Promise<{已记: boolean, 交互来源?: string, lastInteraction?: string|null, 原因?: string}>}
   */
  async 记本人交互() {
    if (!this.registry?.markInteraction) return { 已记: false, 原因: '本服务未接身份档案，交互时钟未动' };
    try {
      const 读数 = await this.registry.markInteraction({ 来源: this.交互来源 });
      return { 已记: true, 交互来源: this.交互来源, lastInteraction: 读数?.lastInteraction ?? null };
    } catch (error) {
      const 原因 = error instanceof Error ? error.message : String(error);
      try {
        await this.audit.append({
          动作: '主权者交互',
          主体: { id: 'sovereign', kind: '主权者' },
          对象: { id: 'sovereign', kind: '失联' },
          依据: '人侧入口恢复失联（决定已成立，但恢复未发生）',
          结果: `失败：${原因}`,
          告警: true,
        });
      } catch {
        // 账本自身坏了：审计链探针会见红，那里才是它该响的地方。
      }
      return { 已记: false, 原因 };
    }
  }

  /** @param {string|null} 项目 */
  async #读(项目) {
    return this.audit.read(项目 ? { project: 项目 } : {});
  }

  /** @param {string} 请求id */
  #记录路径(请求id) {
    return this.layout.private('介入请求', `${请求id}.json`);
  }

  /** @param {string} 请求id */
  #锁路径(请求id) {
    return join(this.layout.privateRoot, '.intervention-locks', 请求id);
  }

  /**
   * 写私有冻结记录（原子写、写一次）。已存在且内容一致 ⇒ 复用；不一致 ⇒ 响亮拒。
   * @param {string} 请求id
   * @param {object} 记录
   */
  async #写冻结(请求id, 记录) {
    const 路径 = this.#记录路径(请求id);
    const 已有 = await readJsonOrNull(路径);
    if (已有) {
      if (已有.内容摘要 !== 记录.内容摘要 || 已有.请求指纹 !== 记录.请求指纹) {
        throw new InvalidBody(`介入请求记录 ${请求id} 已存在且内容不同：同一请求 id 只允许一份冻结记录（疑似碰撞或篡改）。`, { detail: { 请求id } });
      }
      return;
    }
    await atomicWrite(路径, `${JSON.stringify(记录, null, 2)}\n`);
  }

  /**
   * 读私有冻结记录并**验摘要**（内容被改过即拒；摘要缺失/形状不对同样拒）。
   * 坏记录不许降级成「没有记录」——那会让缺内容也能推进。
   * @param {string} 请求id
   * @returns {Promise<object|null>}
   */
  async #读冻结(请求id) {
    const 记录 = await readJsonOrNull(this.#记录路径(请求id));
    if (!记录) return null;
    if (Number(记录.版本) !== 记录版本) {
      throw new InvalidBody(`介入请求记录 ${请求id} 的版本是 ${记录.版本}，本实现只认 ${记录版本}：旧记录不猜读，请重新发起该请求。`, { detail: { 请求id, 版本: 记录.版本 } });
    }
    const { 内容摘要, ...其余 } = 记录;
    if (typeof 内容摘要 !== 'string' || 内容摘要 !== digest(canonical(其余))) {
      throw new InvalidBody(`介入请求记录 ${请求id} 的内容摘要不符（疑似被改过）：拒绝把它当作冻结请求。`, { detail: { 请求id } });
    }
    return 记录;
  }

  /**
   * 按请求指纹折叠账本行。顺序即事实顺序（audit.read 已按月/seq 排好）。
   * 收口态不被后来的同参请求复活（同一指纹不会再有第二行——登记在锁内去重）。
   * @param {object[]} rows
   * @returns {Map<string, object>}
   */
  #折叠(rows) {
    /** @type {Map<string, object>} */
    const 项表 = new Map();
    for (const 行 of rows) {
      const 指纹 = 行?.对象?.id;
      if (!指纹) continue;
      const 动作 = 行.动作;
      if (动作 === 请求动作) {
        if (项表.has(指纹)) continue;
        项表.set(指纹, {
          请求id: 指纹,
          原主体: 行.主体 ?? null,
          档位: 行.详情?.档位 ?? null,
          动作: 行.详情?.动作 ?? null,
          目标: 行.详情?.目标 ?? null,
          项目: 行.项目 ?? null,
          安全摘要: 行.详情?.安全摘要 ?? null,
          内容摘要: 行.详情?.请求记录?.摘要 ?? null,
          步骤数: 行.详情?.步骤数 ?? null,
          请求行: { seq: 行.seq, hash: 行.hash },
          状态: '待放行',
          决议: null,
          决议行: null,
          占用行: null,
          完成行: null,
          失败原因: '',
        });
        continue;
      }
      const 项 = 项表.get(指纹);
      if (!项) continue;
      if (动作 === 决议动作) {
        项.决议 = { 决定: 行.结果, 理由: 行.详情?.理由 ?? '', 入口: 行.详情?.入口 ?? null, 行: { seq: 行.seq, hash: 行.hash } };
        项.决议行 = { seq: 行.seq, hash: 行.hash };
        // 新一轮决定：清掉上一轮的消费痕迹（只影响状态推导，账本行永在）。
        项.占用行 = null;
        项.完成行 = null;
        项.失败原因 = '';
        if (行.结果 === '批准') 项.状态 = '已批准待重放';
        else if (行.结果 === '拒绝') 项.状态 = '已拒绝';
        else if (行.结果 === '撤销') 项.状态 = '已撤销';
        continue;
      }
      if (动作 === 占用动作) {
        项.占用行 = { seq: 行.seq, hash: 行.hash };
        if (项.状态 === '已批准待重放') 项.状态 = '占用未报告';
        continue;
      }
      if (动作 === 完成动作) {
        项.完成行 = { seq: 行.seq, hash: 行.hash };
        项.状态 = '已完成';
        continue;
      }
      if (动作 === 失败动作) {
        项.失败行 = { seq: 行.seq, hash: 行.hash };
        项.失败原因 = 行.详情?.原因 ?? '';
        项.状态 = '失败';
      }
    }
    return 项表;
  }

  /**
   * 状态推导：收口态原样；未收口态再看「档位是否已改 / 卡版本是否已变 / 目标代是否已旧」。
   * @param {object} 项
   * @param {string|null} 当前档位
   * @returns {Promise<string>}
   */
  async #判状态(项, 当前档位) {
    if (收口态.has(项.状态)) return 项.状态;
    if (当前档位 !== null && 项.档位 && 当前档位 !== 项.档位) return '已失效';
    if (项.状态 === '失败' || 项.状态 === '占用未报告') return 项.状态;
    const 当前卡 = 项.原主体?.卡版本 && this.卡版本Of ? await this.卡版本Of(项.原主体.id) : null;
    if (项.原主体?.卡版本 && 当前卡 && 当前卡 !== 项.原主体.卡版本) return '已失效';
    const 当代 = 项.目标?.id && 项.目标?.代 != null && this.目标代Of
      ? await this.目标代Of({ id: 项.目标.id, kind: 项.目标.kind ?? null, 项目: 项.项目 })
      : null;
    if (项.目标?.代 != null && 当代 != null && String(当代) !== String(项.目标.代)) return '已失效';
    return 项.状态;
  }

  /** @param {object} 主体 */
  async #卡版本(主体) {
    // 权威源优先：身份档案里的钉版摘要是「此刻生效的卡」，主体自带的卡版本只是它在
    // 会话出生时的一个副本。两者不一致时按档案判（不拿自报副本推翻权威读数）。
    if (主体?.id && this.卡版本Of) {
      const 读 = await this.卡版本Of(String(主体.id));
      if (读) return 读;
    }
    return 主体?.卡版本 ?? null;
  }

  /**
   * 原主体核对：id 必同；种类不冲突。卡版本另判（它属于「已失效」而不是「冒充别人」）。
   * @param {object|null} 记录主体
   * @param {object} 当前
   * @returns {Promise<{ok: boolean, 原因?: string}>}
   */
  async #同一主体(记录主体, 当前) {
    if (!记录主体 || !当前) return { ok: false, 原因: '主体读数缺失（不猜通过）' };
    if (String(记录主体.id) !== String(当前.id)) return { ok: false, 原因: `不是原申请者（原主体 ${记录主体.id}）。` };
    if (记录主体.kind && 当前.kind && 记录主体.kind !== 当前.kind) return { ok: false, 原因: '主体种类不符。' };
    return { ok: true };
  }
}
