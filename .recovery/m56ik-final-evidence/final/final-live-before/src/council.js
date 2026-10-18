/**
 * 会审（v2 口述收敛 2026-10-18 条目18/19）——**与会话绑定的独立咨询功能，退出任务图**。
 *
 * 主权者原话：「按理说这应该是一个独立的功能」「会审按理说应该是和一个会话绑定的」
 * 「存到会审页里」。会审不再占任务节点、不走派发/复核/结账：
 *   抛问题（debate_open）→ N 个独立实例作答（debate_answer，盲评：未交齐互不可见）
 *   → 交齐解锁揭名（debate_unlock）→ 可选讨论（debate_round 显式开启/换轮，debate_say 发言）
 *   → 收敛（debate_converge，Lead）。每次会审完整存档：问题/各答案/分歧/结论/来源会话/时间。
 *
 * 配件裁决（条目19）：提交后解锁=留（盲评含在内）；强制反对者=砍（轻量咨询不值一次
 * 实例调用，分歧不足由零分歧报警补位）；零分歧报警=留（纯信号，存档记「零分歧异常」）；
 * 讨论段=留但默认不开（Lead 显式开启 = 第一次 debate_round），预算上限照旧。
 *
 * 分工（与旧讨论段同一规格精神）：
 *  - **状态权威在自己的事件流**：`任务图/<项目>/councils.jsonl`（append-only，与任务图
 *    同目录但独立账本）；本服务追加事件并 fold 成会审视图。旧任务图里的讨论段事件
 *    （debate_opened 等）原地只读不迁移——tasks.js 的 fold 分支保留给历史回放。
 *  - **讨论消息在总线**：发言经 `bus.send`（线程 = `会审-{id}`）落消息，审计走 send 的
 *    既有路径；换轮落「系统」边界消息，预算闸用消息流内部的边界切轮——不靠时钟对齐。
 *  - **预算现算**：每次 say 现读线程（`bus.readRaw`），不为预算另立存储。
 */
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { appendLines, readJsonl, serializeByKey, withLock } from './kernel/fsx.js';
import { Denied, Fault, InvalidBody } from './kernel/errors.js';
import { DEFAULT_DEBATE_BUDGET, subjectKindForRole } from './policy.js';
import { judgeZeroDivergence, 盲标分配 } from './review.js';

/** 讨论发言的合法类型（§9 消息类型里讨论段专用的三种）。 */
export const DEBATE_SAY_TYPES = ['分歧', '表态', '答复'];

/** 换轮边界消息的标记前缀（内容以它开头的系统消息 = 轮边界，预算按它切轮）。 */
export const ROUND_BOUNDARY_MARK = '[debate-round]';

/** 会审线程前缀：讨论消息线程 = `会审-{会审id}`（路径段合法形态——assertPathSegment 拒 `/`）。 */
export { COUNCIL_THREAD_PREFIX } from './paths.js';
import { COUNCIL_THREAD_PREFIX } from './paths.js';

export class CouncilService {
  /**
   * @param {{ layout: import('./paths.js').Layout, policy: import('./policy.js').PolicyEngine, audit: import('./audit.js').AuditLog, clock: import('./kernel/time.js').Clock, bus: object, registry: object }} spec
   *   bus / registry 依赖注入：本服务只编排，不自己实现总线与身份档案。
   */
  constructor(spec) {
    this.layout = spec.layout;
    this.policy = spec.policy;
    this.audit = spec.audit;
    this.clock = spec.clock;
    this.bus = spec.bus;
    this.registry = spec.registry;
  }

  /**
   * 发起会审：抛问题 + 点名参与者。参与者可以全是**已登记实例**（旧路径），也可以带
   * `参与岗位` 由调用方注入的三个真实适配器现场创建 N 个受管咨询实例（补修I）。
   * 来源会话 = 发起人主体 id（真实 exec 事实），入账且不由模型自报。
   *
   * 受管路径的四条边界（Lead 2026-10-18 批复）：
   *  - 创建/登记/**发书/退役都在会审锁外**（慢宿主调用不占锁）；锁只围状态 append；
   *  - 任一失败只清理**本次创建**的实例，预给参与者不动；
   *  - 会审绑定只落普通成员岗，复核员在发起前就拒（只读/不提案是本职硬约束）；
   *  - 适配器缺一/角色卡不可用/资料根不合法/发起者未钉版 ⇒ **副作用前**拒。
   *
   * @param {{ subject: object, 项目: string, 问题: string, 参与者?: string[], 参与岗位?: string[], 资料?: string[], 创建参与者?: Function|null, 发开场书?: Function|null, 退役实例?: Function|null, 模型路由?: object|null }} spec
   */
  async open(spec) {
    const 问题 = String(spec.问题 ?? '').trim();
    if (!问题) throw new InvalidBody('会审需要「问题」：没有问题的会审没有收敛对象。', { missing: ['问题'] });
    const 参与者 = [...new Set((Array.isArray(spec.参与者) ? spec.参与者 : []).map(String).filter(Boolean))];
    const 参与岗位 = (Array.isArray(spec.参与岗位) ? spec.参与岗位 : []).map((x) => String(x ?? '').trim()).filter(Boolean);
    const 预算 = 会审预算(this.policy);
    const 总数 = 参与者.length + 参与岗位.length;
    if (总数 < 2) {
      throw new InvalidBody('会审至少要点两位参与者：独立作答的意义在多份答案互相校验，一个人的会审直接问本人即可。', { missing: ['参与者', '参与岗位'] });
    }
    if (总数 > 预算.人数上限) {
      throw new Denied('会审 · 人数上限', `参与者 ${总数} 人超过人数上限 ${预算.人数上限}：会审按小会设计，规模上去请拆成多场。`, {
        requireAuthority: '主权者',
        howToChange: `拆成 ≤${预算.人数上限} 人的多场会审；或由主权者改私有 部署.json 的 会审讨论.人数上限。`,
        detail: { 参与人数: 总数, 人数上限: 预算.人数上限, 预给: 参与者.length, 新建: 参与岗位.length },
      });
    }
    // 参与者必须在册在岗：会审作答由成员实例承担，档案是唯一事实源（与派活同一条接线纪律）。
    const 档案 = (await this.registry.identity()).members ?? {};
    for (const id of 参与者) {
      const 记录 = 档案[id];
      if (!记录 || 记录.status === '封存') {
        throw new InvalidBody(`会审参与者 ${id} 不在身份档案的在岗名单里：会审答案要落到真实实例头上。`, {
          howToChange: '先 member_spawn / registry_assign 起实例，再把它列入参与者。',
          detail: { 参与者: id, 在册: Boolean(记录), 状态: 记录?.status ?? null },
        });
      }
      // 复核员不能作为参与者：作答是一次写，与「只读数、不改、不提案」的本职硬约束相冲。
      // 不为齐卷给它开口子——要复核意见就走真正的复核任务（Lead 建复核任务 + 复核对象）。
      if (记录.岗位 === '复核员') throw 复核岗不能参会(id);
    }

    // ── 旧路径：全是已登记参与者，行为与 v2 原实现一致（不取锁、不加字段） ──────────
    if (参与岗位.length === 0) {
      const id = `council-${this.clock.ms().toString(36)}-${randomUUID().slice(0, 5)}`;
      await this.policy.check({
        subject: spec.subject,
        action: 'create',
        target: { id, kind: '会审', authority: '自治', zone: '私有', project: spec.项目 },
        context: {},
      });
      const { view } = await this.#append(spec.项目, {
        kind: 'opened', id, 问题, 参与者,
        来源会话: spec.subject?.id ?? null,
        轮次上限: 预算.轮次上限,
        预算快照: { 每轮消息上限: 预算.每轮消息上限, 每人每轮字符上限: 预算.每人每轮字符上限 },
      }, spec.subject, '会审发起');
      return { 会审: view, id, 参与者, 来源会话: view.来源会话 };
    }

    // ── 受管路径（补修I）：先判全部副作用前条件，再锁外创建 ──────────────────────
    if (!['Lead', '主权者'].includes(spec.subject?.kind)) {
      throw new Denied('会审 · 受管创建仅 Lead/主权者', `${spec.subject?.kind ?? '未知'} 不得创建会审参与实例：这是派活面，不是咨询作答。`, {
        requireAuthority: 'Lead',
        howToChange: '由 Lead（根会话）发起；成员只作答/讨论。',
      });
    }
    for (const [名, 值] of [['创建参与者', spec.创建参与者], ['发开场书', spec.发开场书], ['退役实例', spec.退役实例]]) {
      if (typeof 值 !== 'function') {
        throw new Fault('COUNCIL_ADAPTER_NOT_READY', `会审受管创建需要「${名}」适配器，但实际没有装载（${typeof 值}）：必要运行接口未就绪，拒绝在有副作用前假装成功。先由内核动作层接上真实宿主适配器，再重试；不要裸起子代理绕过组织登记。`, {
          detail: { 缺: 名, 参与岗位 },
        });
      }
    }
    // 来源会话 = 真实登记主体 id；Lead 自己必须已钉版，否则父判/委托凭证会在创建后才炸。
    const 来源会话 = String(spec.subject?.id ?? '').trim();
    if (!来源会话) throw new InvalidBody('会审受管创建缺来源会话：来源只能取真实登记主体 id。', { missing: ['subject.id'] });
    if (spec.subject.kind === 'Lead') {
      const 源钉 = await this.registry.cardOf(来源会话);
      if (源钉?.就绪 !== true) {
        throw new Fault('COUNCIL_SOURCE_NOT_READY', `Lead 实例 ${来源会话} 的钉版未就绪（${源钉?.原因 ?? 'registry 没给就绪读数'}）：先修好岗位卡/身份档案，再发起受管会审；不要先创建实例再补钉。`, {
          detail: { 来源会话, 就绪: 源钉?.就绪 ?? null, 原因: 源钉?.原因 ?? null },
        });
      }
    }
    // 岗位卡/角色种类/复核员全部在副作用前判；任一不合格 ⇒ 零创建。
    for (const 岗位 of 参与岗位) {
      if (subjectKindForRole(岗位) !== '成员') {
        throw new InvalidBody(`会审参与实例只收普通成员岗：${岗位} 是 ${subjectKindForRole(岗位)} 岗。`, { missing: ['参与岗位'] });
      }
      if (岗位 === '复核员') throw 复核岗不能参会(岗位);
      const 卡 = await this.registry.get({ id: 岗位 });
      if (!卡) throw new InvalidBody(`岗位「${岗位}」不存在：先建岗位卡，再发起会审。`, { missing: ['参与岗位'] });
    }
    const 资料 = await this.#校验资料(spec.资料);
    const id = `council-${this.clock.ms().toString(36)}-${randomUUID().slice(0, 5)}`;
    await this.policy.check({
      subject: spec.subject,
      action: 'create',
      target: { id, kind: '会审', authority: '自治', zone: '私有', project: spec.项目 },
      context: {},
    });

    // 1) 锁外创建：慢宿主调用不占会审锁；失败只清本次已建（逆序 seal→stop）。
    const 创建实例 = [];
    try {
      for (const 岗位 of 参与岗位) {
        const 建 = await spec.创建参与者({ 会审: id, 项目: spec.项目, 问题, 资料, 岗位, 来源会话, 模型路由: spec.模型路由 ?? null });
        const 实例 = String(建?.实例 ?? '').trim();
        if (!实例) throw new Fault('COUNCIL_CREATE_NO_ID', `创建 ${岗位} 实例的适配器没有返回真实实例 id：不编造 Agent 对象/登记。`, { detail: { 岗位 } });
        if (参与者.includes(实例) || 创建实例.some((x) => x.实例 === 实例)) {
          throw new Fault('COUNCIL_CREATE_DUPLICATE_ID', `适配器返回了重复实例 id ${实例}：会审按实例 id 计票，重复会污染齐卷判定。`, { detail: { 岗位, 实例 } });
        }
        // 先入清单再判钉卡：钉卡不就绪的实例已经真实创建/登记，失败补偿必须能清到它。
        创建实例.push({ 实例, 岗位, 钉卡: 建?.钉卡 });
        if (建?.钉卡?.就绪 !== true) {
          throw new Fault('COUNCIL_CARD_NOT_READY', `实例 ${实例} 的岗位卡钉版未就绪（${建?.钉卡?.原因 ?? '适配器没给就绪读数'}）：不会把现行卡正文配旧摘要发成会审任务书。`, { detail: { 岗位, 实例, 就绪: 建?.钉卡?.就绪 ?? null } });
        }
      }
    } catch (error) {
      const 补偿 = await this.#补偿创建(创建实例, spec.退役实例, id);
      const 审计错误 = await this.#记创建失败(spec.项目, spec.subject, id, 'create', 创建实例, 补偿, error);
      throw 受管创建失败('COUNCIL_CREATE_FAILED', `会审 ${id} 创建第 ${创建实例.length + 1} 个实例失败：${错误信息(error)}。已清理本次已建实例（${创建实例.map((x) => x.实例).join('、') || '无'}）。`, {
        会审: id, 阶段: 'create', 已创建: 创建实例.map((x) => x.实例), 失败岗位: 参与岗位[创建实例.length] ?? null, 补偿失败: 补偿, 原因: 错误信息(error), ...(审计错误 ? { 审计错误 } : {}),
      });
    }

    // 2) 锁内只落 opened（状态权威）；锁外不持锁等宿主。
    let view;
    try {
      ({ view } = await this.#append(spec.项目, {
        kind: 'opened', id, 问题,
        参与者: [...参与者, ...创建实例.map((x) => x.实例)],
        来源会话,
        轮次上限: 预算.轮次上限,
        预算快照: { 每轮消息上限: 预算.每轮消息上限, 每人每轮字符上限: 预算.每人每轮字符上限 },
        资料,
        创建实例: 创建实例.map(({ 实例, 岗位, 钉卡 }) => ({ 实例, 岗位, 卡版本: 钉卡?.卡版本?.摘要 ?? null })),
      }, spec.subject, '会审发起'));
    } catch (error) {
      const 补偿 = await this.#补偿创建(创建实例, spec.退役实例, id);
      const 审计错误 = await this.#记创建失败(spec.项目, spec.subject, id, 'open', 创建实例, 补偿, error);
      throw 受管创建失败('COUNCIL_OPEN_FAILED', `会审 ${id} 的创建已完成，但 opened 事件落线失败：${错误信息(error)}。已清理本次已建实例；不要重试同一动作。`, {
        会审: id, 阶段: 'open', 已创建: 创建实例.map((x) => x.实例), 补偿失败: 补偿, 原因: 错误信息(error), ...(审计错误 ? { 审计错误 } : {}),
      });
    }

    // 3) 锁外逐条发会审任务书；失败则落 aborted（作答状态冻结）再清理。
    let 已发 = 0;
    try {
      for (const 项 of 创建实例) {
        await spec.发开场书({ 会审: id, 问题, 资料, 来源会话, 实例: 项.实例, 岗位: 项.岗位, 钉卡: 项.钉卡, 模型路由: spec.模型路由 ?? null });
        已发 += 1;
      }
    } catch (error) {
      let 作废错误 = null;
      try {
        await this.#append(spec.项目, { kind: 'aborted', id, 原因: 错误信息(error), 阶段: 'send', 已发 }, spec.subject, '会审作废');
      } catch (e) {
        作废错误 = 错误信息(e);
      }
      const 补偿 = await this.#补偿创建(创建实例, spec.退役实例, id);
      const 审计错误 = await this.#记创建失败(spec.项目, spec.subject, id, 'send', 创建实例, 补偿, error, 作废错误, { 已发 });
      throw 受管创建失败('COUNCIL_SEND_FAILED', `会审 ${id} 已落线，但任务书发送失败（已发 ${已发}/${创建实例.length}）：${错误信息(error)}。已落 aborted 并清理本次实例；不要重试同一动作。`, {
        会审: id, 阶段: 'send', 已发, 已创建: 创建实例.map((x) => x.实例), 补偿失败: 补偿, 作废错误, 原因: 错误信息(error), ...(审计错误 ? { 审计错误 } : {}),
      });
    }
    return { 会审: view, id, 参与者: view.参与者, 创建实例: 创建实例.map(({ 实例, 岗位, 钉卡 }) => ({ 实例, 岗位, 卡版本: 钉卡?.卡版本?.摘要 ?? null })), 来源会话: view.来源会话 };
  }

  /**
   * 只读步骤计划（补修I · 与 F 的统一介入度包装共用）：给动作层/审批预览摊出本次宏动作
   * 真正会发生的**底层策略写**。它不做任何写、不消耗放行；实际执行仍由 `open` / `converge`
   * 走同一批底层 `policy.check`，这里只是它们的只读投影（不另写一份候选逻辑）。
   *
   * 为什么必须包含 N 个 identity create：受管 open 是「create 会审 + N 次实例登记」的完整宏；
   * 若计划只盖第一笔 create，审批后会卡在 N 次身份登记循环里，且可能在已 spawn 之后才挂起。
   *
   * @param {{ 项目: string, 动作: 'debate_open'|'debate_converge', args?: object }} spec
   * @returns {Promise<{步骤: object[]}|null>}
   */
  async councilPlan(spec) {
    const 项目 = spec?.项目;
    const 动作 = String(spec?.动作 ?? '');
    const args = spec?.args ?? {};
    if (动作 === 'debate_open') {
      const 参与者 = 列表(args.参与者);
      const 参与岗位 = 岗位列表(args.参与岗位);
      if (参与者.length + 参与岗位.length < 2) return null;
      const 步骤 = [{
        动作: 'create',
        目标: { kind: '会审', 新: true, authority: '自治', zone: '私有', project: 项目 },
        说明: '发起会审（会话级存档，不占任务图）',
        预览: { 问题: args.问题 ?? args.描述 ?? null, 参与者, 参与岗位, 资料: 列表(args.资料) },
      }];
      for (const [序号, 岗位] of 参与岗位.entries()) {
        步骤.push({
          动作: 'create',
          目标: { kind: '身份', 新: true, authority: '自治', zone: '私有' },
          说明: `创建会审参与实例 ${序号 + 1}/${参与岗位.length}（${岗位}）`,
          预览: { 序号: 序号 + 1, 岗位, 来源会话: '真实登记主体（exec 会话事实）', 会审: '本次新建' },
        });
      }
      return { 步骤 };
    }
    if (动作 === 'debate_converge') {
      const id = String(args.id ?? '').trim();
      if (!id) return null;
      const view = await this.get(项目, id);
      // 不可收敛的状态不摊计划：让服务层先给出确定拒绝，而不是拿一份空计划去批。
      if (!view || !['已解锁', '讨论中'].includes(view.状态)) return null;
      const 步骤 = [{
        动作: 'write',
        目标: { kind: '会审', id, authority: '自治', zone: '私有', project: 项目 },
        说明: `收敛会审 ${id}`,
        预览: { 会审: id, 结论: args.内容 ?? null },
      }];
      // 只列**真正会退役**的实例：在岗 + 会审绑定=本场。判据与 #退役本场 同一份事实，
      // 不复制业务判定（计划只是投影）。
      const 档案 = (await this.registry.identity()).members ?? {};
      for (const 项 of view.创建实例 ?? []) {
        const 实例 = String(项?.实例 ?? '').trim();
        const 成员 = 档案[实例];
        if (!实例 || !成员 || 成员.status !== '在岗') continue;
        if (String(成员.会审绑定?.会审 ?? '') !== id) continue;
        步骤.push({
          动作: 'seal',
          目标: { kind: '身份', id: 实例, authority: '自治', zone: '私有' },
          说明: `退役会审参与实例 ${实例}`,
          预览: { 实例, 岗位: 项.岗位 ?? 成员.岗位 ?? null },
        });
      }
      return { 步骤 };
    }
    return null;
  }

  /**
   * 作答：参与者各交一份独立答案（结论 + 结论层 + 反例面）。未交齐前互不可见
   * （盲评遮罩在 list 投影层）；同人再交替换自己那份。
   * @param {{ subject: object, 项目: string, id: string, 结论: string, 结论层?: string, 反例面?: string[] }} spec
   */
  async answer(spec) {
    const council = await this.#require(spec.项目, spec.id);
    await this.#校验会审绑定(spec.id, spec.subject);
    if (council.状态 !== '作答中') {
      throw new Denied('会审 · 状态机', `会审 ${spec.id} 当前状态为 ${council.状态}，不再接受作答。`, {
        howToChange: council.状态 === '已解锁' || council.状态 === '讨论中' ? '已揭名：要表达立场用 debate_say（讨论开启时）；要改答案请 Lead 重新发起一场。' : '本场会审已收敛存档：结论已定格，有异议走新会审。',
      });
    }
    if (!council.参与者.includes(spec.subject?.id)) {
      throw new Denied('会审 · 仅参与者可作答', `${spec.subject?.id} 不在会审 ${spec.id} 的参与者名单（${council.参与者.join('、')}）里。`, {
        howToChange: '参与者由发起时点名；要参与请 Lead 重新发起并把你列入。',
      });
    }
    const 结论 = String(spec.结论 ?? '').trim();
    if (!结论) throw new InvalidBody('会审作答必须给「结论」：空答案不参与零分歧判定。', { missing: ['结论'] });
    await this.policy.check({
      subject: spec.subject,
      action: 'write',
      target: { id: spec.id, kind: '会审', authority: '自治', zone: '私有', project: spec.项目 },
      context: { 会审: council },
    });
    const { view } = await this.#append(spec.项目, {
      kind: 'answered', id: spec.id, 成员: spec.subject.id,
      结论, 结论层: spec.结论层 ?? null, 反例面: spec.反例面 ?? [],
    }, spec.subject, '会审作答', {
      inLockGuard: (viewInLock) => {
        if (viewInLock?.状态 !== '作答中') throw new Denied('会审 · 状态机（锁内复检）', `会审 ${spec.id} 已不在作答中（锁内复检）。`);
      },
    });
    const 已交 = view.答案.length;
    return { 会审: this.#forViewer(view, spec.subject), 已交, 待交: council.参与者.length - 已交, 齐: 已交 >= council.参与者.length };
  }

  /**
   * 解锁（提交后解锁 · 条目19）：全员交齐后 Lead 揭名——盲评到此为止。
   * @param {{ subject: object, 项目: string, id: string }} spec
   */
  async unlock(spec) {
    const council = await this.#require(spec.项目, spec.id);
    if (spec.subject?.kind !== 'Lead' && spec.subject?.kind !== '主权者') {
      throw new Denied('会审 · 解锁仅 Lead', `解锁是「盲评到此为止」的流程决定：${spec.subject?.kind ?? '未知'} 不得执行。`, { requireAuthority: 'Lead' });
    }
    if (council.状态 !== '作答中') {
      throw new Denied('会审 · 状态机', `会审 ${spec.id} 当前状态为 ${council.状态}，不能解锁。`);
    }
    await this.policy.check({
      subject: spec.subject,
      action: 'write',
      target: { id: spec.id, kind: '会审', authority: '自治', zone: '私有', project: spec.项目 },
      context: { 会审: council },
    });
    // 锁外那次状态读只为早失败与策略上下文；「齐卷」是读-判-写，并发两路解锁会
    // 同时读到「作答中 + 全员已交」。权威判定在锁内重做：先到的那次落线，后到的
    // 必须在锁内看见「已解锁」并拒，不许重复揭名。
    const { view } = await this.#append(spec.项目, { kind: 'unlocked', id: spec.id }, spec.subject, '会审解锁', {
      inLockGuard: (锁内) => {
        if (!锁内) throw new InvalidBody(`没有这场会审：${spec.id}（项目 ${spec.项目}）。会审存档在会审页可查。`);
        if (锁内.状态 !== '作答中') {
          throw new Denied('会审 · 状态机（锁内复检）', `会审 ${spec.id} 当前状态为 ${锁内.状态}，不能解锁（锁内复检：并发解锁 / 已揭名 / 已收敛）。`, {
            howToChange: '解锁只对「作答中」且全员已交的会审有效；已解锁的会审直接开讨论或收敛。',
          });
        }
        const 未交 = 锁内.参与者.filter((p) => !锁内.答案.some((a) => a.成员 === p));
        if (未交.length > 0) {
          throw new Denied('会审 · 全员已交才解锁（锁内复检）', `会审 ${spec.id} 未全员交卷：待交 ${未交.join('、')}。提前揭名会污染还没作答的独立判断。`, {
            detail: { 未交 },
          });
        }
      },
    });
    return { 会审: view };
  }

  /**
   * 换轮（讨论段 · 默认不开，Lead 显式开启）：第一次调用 = 开启讨论（轮次 1），
   * 之后 = 推进轮次。仅 Lead；轮次上限照旧。落「系统」边界消息切预算轮。
   * @param {{ subject: object, 项目: string, id: string }} spec
   */
  async round(spec) {
    const council = await this.#require(spec.项目, spec.id);
    this.#requireLead(spec.subject, '换轮/开启讨论');
    if (!['已解锁', '讨论中'].includes(council.状态)) {
      throw new Denied('会审 · 状态机', `会审 ${spec.id} 当前状态为 ${council.状态}：讨论在揭名之后才开得起来（先 debate_unlock）。`, {
        howToChange: '讨论是可选环节：多数会审在收敛前不需要它；确需讨论先解锁，再 debate_round。',
      });
    }
    if (council.轮次 >= council.轮次上限) {
      throw new Denied('会审 · 轮次上限', `轮次已到上限 ${council.轮次上限}：预算用尽就该收敛，无限换轮等于没有预算。`, {
        howToChange: '收敛（debate_converge）；上限调整走私有 部署.json 的 会审讨论.轮次上限（只影响之后开启的会审）。',
      });
    }
    await this.policy.check({
      subject: spec.subject,
      action: 'write',
      target: { id: spec.id, kind: '会审', authority: '自治', zone: '私有', project: spec.项目 },
      context: { 会审: council },
    });
    // 新轮次只能在锁内定：锁外两路并发会读到同一个旧轮次，各自 +1 ⇒ 重复同一轮
    // 且吞掉一格上限（Lead 实证 Promise.all([round, round]) 两个都返回轮1）。
    // 事件对象按引用带进锁里改轮次，落线的行才是锁内算出的那一轮。
    const 事件 = { kind: 'rounded', id: spec.id, 轮次: 0 };
    const 结果 = { 轮次: null, 轮次上限: council.轮次上限, 提示: null };
    const { view } = await this.#append(
      spec.项目,
      事件,
      spec.subject,
      (锁内) => (锁内?.状态 === '已解锁' ? '讨论开启' : '会审换轮'),
      {
        inLockGuard: async (锁内) => {
          if (!锁内) throw new InvalidBody(`没有这场会审：${spec.id}（项目 ${spec.项目}）。会审存档在会审页可查。`);
          if (!['已解锁', '讨论中'].includes(锁内.状态)) {
            throw new Denied('会审 · 状态机（锁内复检）', `会审 ${spec.id} 当前状态为 ${锁内.状态}：讨论在揭名之后才开得起来（先 debate_unlock）（锁内复检）。`, {
              howToChange: '讨论是可选环节：多数会审在收敛前不需要它；确需讨论先解锁，再 debate_round。',
            });
          }
          if (锁内.轮次 >= 锁内.轮次上限) {
            throw new Denied('会审 · 轮次上限（锁内复检）', `轮次已到上限 ${锁内.轮次上限}：预算用尽就该收敛，无限换轮等于没有预算（锁内复检）。`, {
              howToChange: '收敛（debate_converge）；上限调整走私有 部署.json 的 会审讨论.轮次上限（只影响之后开启的会审）。',
            });
          }
          const 消息 = await this.bus.readRaw({ 项目: spec.项目, 线程: 线程名(spec.id) });
          const 边界轮 = 轮边界轮次(消息);
          // 跨存储对账：状态说第 N 轮，线程最后边界就必须是 N。上一次换轮的边界
          // 没落线时，推进下一轮会让发言落进错的一轮、把预算洗掉——拒绝并指人工补记。
          if (锁内.轮次 > 0 && 边界轮 !== 锁内.轮次) {
            throw new Fault('DEBATE_BOUNDARY_DRIFT', `会审 ${spec.id} 的状态轮次是 ${锁内.轮次}，但线程里最后一条轮边界是「${边界轮 ?? '缺失'}」：状态事件与轮边界跨存储失配。按 fail-closed 拒绝推进——先人工核对该线程并补记边界消息，再继续换轮。`, {
              detail: { 会审: spec.id, 状态轮次: 锁内.轮次, 边界轮次: 边界轮 },
            });
          }
          结果.轮次 = 锁内.轮次 + 1;
          结果.轮次上限 = 锁内.轮次上限;
          结果.提示 = 可收敛判定(本轮发言(消息, 锁内.参与者), 锁内.参与者);
          事件.轮次 = 结果.轮次;
        },
        // 边界消息与轮次事件同锁同序落线：锁外发边界会被并发换轮乱序（后发先至），
        // 预算闸按最后一条边界切轮 ⇒ 序号倒挂的那一轮切错。事件先落、边界后落：
        // 边界失败时状态已推进且可对账出来（上方 fail-closed），不会出现「边界切了轮、
        // 状态没推进」的洗预算方向。
        afterAppend: async (落线后) => {
          try {
            await this.bus.send({
              subject: { id: 'system', kind: '系统' },
              项目: spec.项目,
              线程: 线程名(spec.id),
              发件: 'system',
              收件: 落线后?.参与者 ?? council.参与者,
              类型: '系统',
              内容: `${ROUND_BOUNDARY_MARK} ${结果.轮次}`,
            });
          } catch (error) {
            throw new Fault('DEBATE_BOUNDARY_MISSING', `会审 ${spec.id} 轮次已推进到 ${结果.轮次}（事件已落线），但轮边界消息落线失败：${error instanceof Error ? error.message : String(error)}。不要重试 debate_round——请人工核对该线程并补记边界消息。`, {
              detail: { 会审: spec.id, 轮次: 结果.轮次 },
            });
          }
        },
      },
    );
    return { 会审: view, 轮次: 结果.轮次, 轮次上限: 结果.轮次上限, 结束轮可收敛: 结果.提示.可收敛, 结束轮说明: 结果.提示.说明 };
  }

  /**
   * 发言（讨论段）：参与者、仅讨论中；类型 ∈ {分歧, 表态, 答复}；经 bus.send 落线。
   * 预算闸现算（读线程），用发起时冻结的快照。
   * @param {{ subject: object, 项目: string, id: string, 类型: string, 内容: string }} spec
   */
  async say(spec) {
    const council = await this.#require(spec.项目, spec.id);
    await this.#校验会审绑定(spec.id, spec.subject);
    if (council.状态 !== '讨论中') {
      throw new Denied('会审 · 没有开启讨论', `会审 ${spec.id} 当前状态为 ${council.状态}：讨论段默认不开（条目19），Lead 用 debate_round 显式开启后才能发言。`, {
        howToChange: '由 Lead 执行 debate_round 开启讨论；或直接把分歧写进自己的作答反例面。',
      });
    }
    if (!DEBATE_SAY_TYPES.includes(spec.类型)) {
      throw new InvalidBody(`讨论发言类型只有三种：${DEBATE_SAY_TYPES.join(' / ')}；收到「${spec.类型}」。`, { missing: ['类型'] });
    }
    if (!council.参与者.includes(spec.subject?.id)) {
      throw new Denied('会审 · 仅参与者可发言', `${spec.subject?.id} 不是会审 ${spec.id} 的参与者（${council.参与者.join('、')}）。旁听者看会审页 / bus_read。`);
    }
    const 内容 = String(spec.内容 ?? '').trim();
    if (!内容) throw new InvalidBody('讨论发言内容为空。');
    await this.policy.check({
      subject: spec.subject,
      action: 'write',
      target: { id: spec.id, kind: '会审', authority: '自治', zone: '私有', project: spec.项目 },
      context: { 会审: council },
    });
    const 上限 = council.预算快照?.每轮消息上限 ?? DEFAULT_DEBATE_BUDGET.每轮消息上限;
    let 锁内本轮 = null;
    let 锁内轮次 = council.轮次;
    const 预算闸 = async () => {
      // 总线写锁内的最后一道预算复检（bus.send 的 锁内闸）：只读总线与事件流文件。
      // 更外层的会审串行锁已经挡住并发收敛/换轮；这里仍自洽重判预算与边界轮——
      // 两道锁各管一段（会审状态 vs 总线落线），不把口径押在同一处。
      const 锁内 = await this.#require(spec.项目, spec.id);
      if (锁内.状态 !== '讨论中') {
        throw new Denied('会审 · 状态机（锁内复检）', `会审 ${spec.id} 当前状态为 ${锁内.状态}：并发收敛/换轮之后不许复活发言（锁内复检）。`, {
          howToChange: '收敛后的结论已定格：要表达异议请 Lead 发起新会审；讨论未开启时先 debate_round。',
        });
      }
      const 消息 = await this.bus.readRaw({ 项目: spec.项目, 线程: 线程名(spec.id) });
      const 边界轮 = 轮边界轮次(消息);
      if (边界轮 !== 锁内.轮次) {
        throw new Fault('DEBATE_BOUNDARY_DRIFT', `会审 ${spec.id} 的状态轮次是 ${锁内.轮次}，但线程里最后一条轮边界是「${边界轮 ?? '缺失'}」：状态事件与轮边界跨存储失配，这条发言会洗掉预算——按 fail-closed 拒绝。先人工核对该线程并补记边界消息。`, {
          detail: { 会审: spec.id, 状态轮次: 锁内.轮次, 边界轮次: 边界轮 },
        });
      }
      const 每轮上限 = 锁内.预算快照?.每轮消息上限 ?? DEFAULT_DEBATE_BUDGET.每轮消息上限;
      const 每轮字上限 = 锁内.预算快照?.每人每轮字符上限 ?? DEFAULT_DEBATE_BUDGET.每人每轮字符上限;
      const 本轮 = 本轮发言(消息, 锁内.参与者);
      if (本轮.length >= 每轮上限) {
        throw new Denied('会审 · 每轮消息上限', `本轮发言已 ${本轮.length}/${每轮上限} 条，预算用尽。`, {
          howToChange: '换轮（debate_round，Lead）或收敛（debate_converge，Lead）。',
          detail: { 本轮消息数: 本轮.length, 每轮消息上限: 每轮上限, 轮次: 锁内.轮次 },
        });
      }
      const 已用 = 本轮.filter((m) => m.发件 === spec.subject?.id).reduce((n, m) => n + String(m.内容 ?? '').length, 0);
      if (已用 + 内容.length > 每轮字上限) {
        throw new Denied('会审 · 每人每轮字符上限', `${spec.subject?.id} 本轮已用 ${已用}/${每轮字上限} 字符，再发 ${内容.length} 字超限。`, {
          howToChange: '把要说的话压缩后再发，或等换轮后预算重置。',
          detail: { 本轮已用字符: 已用, 本次字符: 内容.length, 每人每轮字符上限: 每轮字上限 },
        });
      }
      锁内本轮 = 本轮;
      锁内轮次 = 锁内.轮次;
      return 本轮;
    };
    // 最终读-判-写与会审状态机**同一把串行锁**（锁序 council → bus）：修前 say 只拿
    // 总线线程锁，而 converge/round 持的是会审锁——复检结束到 appendLines 之间仍能
    // 插进一次收敛，旧发言就会追加到已收敛的会审上（初审实证）。现在整段进会审锁，
    // 锁内只读总线文件（不嵌套拿总线锁），真正的总线写在 bus.send 内部完成。
    const { sent, 轮次 } = await this.#withCouncilLock(spec.项目, async () => {
      const 锁内 = await this.#require(spec.项目, spec.id);
      if (锁内.状态 !== '讨论中') {
        throw new Denied('会审 · 状态机（锁内复检）', `会审 ${spec.id} 当前状态为 ${锁内.状态}：并发收敛/换轮之后不许复活发言（锁内复检）。`, {
          howToChange: '收敛后的结论已定格：要表达异议请 Lead 发起新会审；讨论未开启时先 debate_round。',
        });
      }
      const 消息 = await this.bus.readRaw({ 项目: spec.项目, 线程: 线程名(spec.id) });
      const 边界轮 = 轮边界轮次(消息);
      if (边界轮 !== 锁内.轮次) {
        throw new Fault('DEBATE_BOUNDARY_DRIFT', `会审 ${spec.id} 的状态轮次是 ${锁内.轮次}，但线程里最后一条轮边界是「${边界轮 ?? '缺失'}」：状态事件与轮边界跨存储失配，这条发言会洗掉预算——按 fail-closed 拒绝。先人工核对该线程并补记边界消息。`, {
          detail: { 会审: spec.id, 状态轮次: 锁内.轮次, 边界轮次: 边界轮 },
        });
      }
      await 预算闸();
      const sent = await this.bus.send({
        subject: spec.subject,
        项目: spec.项目,
        线程: 线程名(spec.id),
        发件: spec.subject.id,
        收件: council.参与者,
        类型: spec.类型,
        内容,
        会审: 锁内,
        锁内闸: 预算闸,
      });
      return { sent, 轮次: 锁内轮次 };
    });
    const 权威本轮 = 锁内本轮 ?? [];
    return { 消息: sent, 轮次, 本轮消息数: 权威本轮.length + 1, 每轮消息上限: 上限 };
  }

  /**
   * 收敛（仅 Lead）：算分歧清单（各答案反例面 ∪ 讨论分歧消息）+ 零分歧报警，
   * 存档 = 事件流里这场会审的完整视图（问题/各答案/分歧/结论/来源会话/时间齐全）。
   * @param {{ subject: object, 项目: string, id: string, 内容?: string }} spec
   */
  async converge(spec) {
    const council = await this.#require(spec.项目, spec.id);
    this.#requireLead(spec.subject, '收敛');
    if (council.状态 === '作答中') {
      throw new Denied('会审 · 未解锁不得收敛', `会审 ${spec.id} 还在作答中：先全员交齐并解锁（debate_unlock），再收敛。`);
    }
    if (council.状态 === '已收敛') {
      throw new Denied('会审 · 状态机', `会审 ${spec.id} 已收敛存档：结论已定格。`);
    }
    if (council.状态 === '作废') {
      throw new Denied('会审 · 作废不得收敛', `会审 ${spec.id} 已作废（创建/投递失败）：没有可收敛的咨询，结论不成立。`, {
        howToChange: '由 Lead 重新发起会审；作废存档里的早卷只作事实留痕，不当结论。',
      });
    }
    await this.policy.check({
      subject: spec.subject,
      action: 'write',
      target: { id: spec.id, kind: '会审', authority: '自治', zone: '私有', project: spec.项目 },
      context: { 会审: council },
    });
    // 分歧清单、零分歧判定、存档结论全部在锁内算：并发两次收敛会各自从锁外视图
    // 算一份结论，后到的必须在锁内看见「已收敛」并拒——否则同一场会审落两条结论、
    // 两笔零分歧报警（Lead 判据「并发收敛只成功一次」）。
    const 事件 = { kind: 'converged', id: spec.id, 结论: null, 分歧清单: [], 零分歧异常: false };
    const 结果 = { 分歧清单: [], 判定: null };
    const { view } = await this.#append(spec.项目, 事件, spec.subject, '会审收敛', {
      inLockGuard: async (锁内) => {
        if (!锁内) throw new InvalidBody(`没有这场会审：${spec.id}（项目 ${spec.项目}）。会审存档在会审页可查。`);
        if (锁内.状态 === '作答中') {
          throw new Denied('会审 · 未解锁不得收敛（锁内复检）', `会审 ${spec.id} 还在作答中：先全员交齐并解锁（debate_unlock），再收敛（锁内复检）。`);
        }
        if (锁内.状态 === '已收敛') {
          throw new Denied('会审 · 状态机（锁内复检）', `会审 ${spec.id} 已收敛存档：结论已定格（锁内复检：并发收敛只有一次能成功）。`);
        }
        if (锁内.状态 === '作废') {
          throw new Denied('会审 · 作废不得收敛（锁内复检）', `会审 ${spec.id} 已作废（创建/投递失败）：没有可收敛的咨询，作废存档里的早卷不当结论。`);
        }
        const 消息 = await this.bus.readRaw({ 项目: spec.项目, 线程: 线程名(spec.id) });
        const 分歧清单 = [
          ...锁内.答案.flatMap((a) => (a.反例面 ?? []).map((x) => `${a.成员}: ${x}`)),
          ...本轮发言(消息, 锁内.参与者).filter((m) => m.类型 === '分歧').map((m) => `${m.发件}: ${m.内容}`),
          // 讨论里历史轮的分歧也要算（不只本轮）：收敛清的是全场的账。
          ...(消息 ?? []).filter((m) => m?.类型 === '分歧' && 锁内.参与者.includes(m?.发件)).map((m) => `${m.发件}: ${m.内容}`),
        ].filter((v, i, arr) => arr.indexOf(v) === i);
        // 零分歧报警（留 · 条目19）：结论层一致且无人给反例面 ⇒ 异常信号，随存档记。
        结果.分歧清单 = 分歧清单;
        结果.判定 = judgeZeroDivergence(锁内.答案);
        事件.结论 = String(spec.内容 ?? '').trim() || `收敛：会审结束（${锁内.答案.length} 份答案）`;
        事件.分歧清单 = 分歧清单;
        事件.零分歧异常 = 结果.判定.零分歧;
      },
      // 零分歧报警在事件落线后入账：并发第二路已在锁内被拒，不会多报；一旦这一段
      // 失败，事件已定格（不可重试），必须响亮并指人工补记。
      afterAppend: async () => {
        if (!结果.判定?.零分歧) return;
        try {
          await this.audit.append({
            动作: '零分歧异常',
            主体: { id: 'system', kind: '系统' },
            对象: { id: spec.id, kind: '会审' },
            依据: '§10 零分歧报警：结论层一致且无人给出反例面',
            结果: '会审零分歧异常',
            项目: spec.项目,
            详情: { 会审: spec.id, 结论层: 结果.判定.结论层, 参与人数: 结果.判定.参与人数 },
          });
        } catch (error) {
          throw new Fault('AUDIT_APPEND_FAILED_AFTER_EVENT', `会审 ${spec.id} 的收敛事件已落线，但「零分歧异常」审计追加失败：${error instanceof Error ? error.message : String(error)}。不要重试 debate_converge——结论已定格；请人工核对审计账本并补记。`, {
            detail: { 会审: spec.id, 项目: spec.项目 },
          });
        }
      },
    });
    // 收敛已落线（结论定格）⇒ 锁外退役本次 owned 实例；退役失败如实回执，不重试结论。
    // 只认 opened 里 `创建实例` + 身份记录 `会审绑定.会审 === 本场`：预给参与者/别场实例不动。
    const 退役 = await this.#退役本场(spec.项目, view, spec.退役实例 ?? null);
    let 退役事件错误 = null;
    if (退役.length > 0) {
      try {
        await this.#append(spec.项目, { kind: 'retired', id: spec.id, 退役 }, spec.subject, '会审退役');
      } catch (error) {
        退役事件错误 = 错误信息(error);
        try {
          await this.audit.append({
            动作: '会审退役失败',
            主体: spec.subject,
            对象: { id: spec.id, kind: '会审' },
            依据: 'v2 条目18/20 · 补修I：收敛已定格，但退役事件落线失败',
            结果: '部分失败',
            项目: spec.项目,
            详情: { 会审: spec.id, 退役, 原因: 退役事件错误 },
          });
        } catch { /* 审计失败不掩盖退役报告：事件错误已随返回值带出 */ }
      }
    }
    const 存档 = (await this.get(spec.项目, spec.id)) ?? view;
    return {
      会审: 存档,
      分歧清单: 结果.分歧清单,
      零分歧: 结果.判定.零分歧,
      零分歧依据: 结果.判定.依据,
      退役,
      ...(退役事件错误 ? { 退役事件错误 } : {}),
    };
  }

  /**
   * 会审页数据源：本项目全部会审的存档视图（进行中的也在列，状态字段如实标）。
   * 盲评遮罩（条目19「提交后解锁含盲评」）：作答中且读者是参与者成员时，别人的答案
   * 只留盲标；Lead/主权者/复核员与解锁后全量。
   * @param {{ 项目: string, 读者?: object }} query
   */
  async list(query) {
    const views = await this.#foldAll(query.项目);
    return views.map((v) => this.#forViewer(v, query.读者));
  }

  /** @param {string} 项目 @param {string} id @returns {Promise<object|null>} */
  async get(项目, id) {
    const views = await this.#foldAll(项目);
    return views.find((v) => v.id === id) ?? null;
  }

  // ── 内部 ────────────────────────────────────────────────────────────────────

  // 作答回执也是读面；只在列表遮罩会让后交卷者从自己的回执读到他人的盲评答案。
  // 作废（aborted）同样遮罩：它可能带着已交的早卷，未解锁就揭名 = 绕过盲评。
  #forViewer(view, reader) {
    const 盲评期 = view.状态 === '作答中' || view.状态 === '作废';
    if (!盲评期 || reader?.kind !== '成员' || reader.roleId === '复核员') return view;
    const 标 = new Map(盲标分配(线程名(view.id), view.参与者).map((e) => [e.id, e.盲标]));
    return {
      ...view,
      盲评遮罩: true,
      答案: view.答案.map((a) => a.成员 === reader.id ? a : {
        成员: 标.get(a.成员) ?? '成员?', 结论: null, 结论层: null, 反例面: [],
      }),
    };
  }

  #requireLead(subject, 动作名) {
    if (subject?.kind !== 'Lead' && subject?.kind !== '主权者') {
      throw new Denied(`会审 · ${动作名}仅 Lead`, `${subject?.kind ?? '未知'} 不得执行${动作名}：这是「流程到此为止」的决定，不是发言权的一部分。`, {
        requireAuthority: 'Lead',
        howToChange: `由 Lead 执行；成员用 debate_answer 作答、debate_say（讨论开启时）发言。`,
      });
    }
  }

  async #require(项目, id) {
    const council = await this.get(项目, id);
    if (!council) throw new InvalidBody(`没有这场会审：${id}（项目 ${项目}）。会审存档在会审页可查。`);
    return council;
  }

  /**
   * 资料根预检（补修I）：发起者给的绝对路径 = 参与实例唯一文件读根。
   * 副作用前全判：相对路径/不存在/私有区原始账本一律拒；通过则**realpath 归一后**冻结进
   * opened 事件与实例绑定（目录变化不扩大授权）。
   *
   * @param {unknown} 输入
   * @returns {Promise<string[]>}
   */
  async #校验资料(输入) {
    const 清单 = 列表(输入);
    if (清单.length === 0) return [];
    const 私有 = 规范路径(this.layout.privateRoot);
    const 结果 = [];
    for (const 路径 of 清单) {
      if (!isAbsolute(路径)) {
        throw new InvalidBody(`会审资料必须是绝对路径：收到「${路径}」。资料是参与实例唯一的文件读根，相对路径无法冻结成授权面。`, { missing: ['资料'], detail: { 资料: 路径 } });
      }
      let 真;
      try {
        真 = 规范路径(await realpath(路径));
      } catch (error) {
        throw new InvalidBody(`会审资料不存在或读不到：「${路径}」（${错误信息(error)}）。`, { missing: ['资料'], detail: { 资料: 路径 } });
      }
      if (在目录内(真, 私有)) {
        throw new Denied('会审 · 资料不得来自私有区原始账本', `资料「${路径}」落在私有区（任务图/审计/身份/记忆/总线原始账本）：会审参与者只能读发起者明确给的材料，原始账本先拒。`, {
          requireAuthority: 'Lead',
          howToChange: '把要讨论的材料复制/导出到工作区后再作为资料路径；不要直接给私有区路径。',
          detail: { 资料: 路径 },
        });
      }
      结果.push(真);
    }
    return [...new Set(结果)];
  }

  /**
   * 会审参与实例只能对**自己那一场**作答/发言（补修I）。预给参与者没有绑定 ⇒ 不额外限制；
   * 新建实例带 `会审绑定` ⇒ 跨场即拒（防止把答案投到别场污染独立作答/预算）。
   *
   * @param {string} id
   * @param {object} subject
   * @returns {Promise<object|null>}
   */
  async #校验会审绑定(id, subject) {
    const 成员 = (await this.registry.identity()).members?.[subject?.id];
    const 绑定 = 成员?.会审绑定;
    if (!绑定) return null;
    if (String(绑定.会审) !== String(id)) {
      throw new Denied('会审 · 实例绑定不是本场', `实例 ${subject?.id} 只绑定会审 ${绑定.会审}，不能把作答/发言投到 ${id}：临时参与实例只服务它出生时那一场。`, {
        requireAuthority: 'Lead',
        howToChange: '在绑定的那场会审里作答；要参与别场请由 Lead 另起受管参与实例。',
        detail: { 绑定会审: 绑定.会审, 请求会审: id },
      });
    }
    return 绑定;
  }

  /** 失败补偿：只退役**本次创建**的实例（逆序 seal→stop），返回逐条失败（不吞）。 */
  async #补偿创建(创建实例, 退役实例, 会审) {
    const 失败 = [];
    for (const 项 of [...创建实例].reverse()) {
      try {
        await 退役实例({ 实例: 项.实例, 会审, 原因: '会审创建失败补偿（本次 owned）' });
      } catch (error) {
        失败.push({ 实例: 项.实例, 原因: 错误信息(error) });
      }
    }
    return 失败;
  }

  /** 受管创建失败的审计（清理失败也写进详情）；返回审计错误文本或 null。 */
  async #记创建失败(项目, subject, id, 阶段, 创建实例, 补偿失败, error, 作废错误 = null, 附加 = {}) {
    try {
      await this.audit.append({
        动作: '会审创建失败',
        主体: subject,
        对象: { id, kind: '会审' },
        依据: 'v2 条目18/20 · 补修I：受管参与实例创建/投递失败，只清理本次 owned 实例',
        结果: `失败（阶段 ${阶段}）`,
        项目,
        详情: {
          会审: id,
          阶段,
          已创建: 创建实例.map((x) => x.实例),
          补偿失败,
          原因: 错误信息(error),
          ...(作废错误 ? { 作废错误 } : {}),
          ...附加,
          ...(error?.detail ? { 错误详情: error.detail } : {}),
        },
      });
      return null;
    } catch (审计失败) {
      return 错误信息(审计失败);
    }
  }

  /**
   * 收敛后退役（补修I）：只看 opened 里登记的 `创建实例`，且身份记录仍 在岗、`会审绑定.会审`
   * 就是本场——预给参与者与别场实例一律不碰。逐条结果（含失败原因）随 retired 事件存档。
   *
   * @param {string} 项目
   * @param {object} view 已收敛的会审视图
   * @param {Function|null} 退役实例
   * @returns {Promise<object[]>}
   */
  async #退役本场(项目, view, 退役实例) {
    const 名单 = Array.isArray(view?.创建实例) ? view.创建实例 : [];
    const 结果 = [];
    for (const 项 of 名单) {
      const 实例 = String(项?.实例 ?? '').trim();
      if (!实例) {
        结果.push({ 实例: null, 已退役: false, 原因: '创建实例记录缺 id' });
        continue;
      }
      const 成员 = (await this.registry.identity()).members?.[实例];
      if (!成员) {
        结果.push({ 实例, 已退役: false, 原因: '身份档案里没有该实例（不猜）' });
        continue;
      }
      if (成员.status !== '在岗') {
        结果.push({ 实例, 已退役: false, 原因: `状态为 ${成员.status}（无需退役）` });
        continue;
      }
      if (String(成员.会审绑定?.会审 ?? '') !== String(view.id)) {
        结果.push({ 实例, 已退役: false, 原因: '会审绑定不是本场（不退役别场实例）' });
        continue;
      }
      if (typeof 退役实例 !== 'function') {
        结果.push({ 实例, 已退役: false, 原因: '本入口未提供退役适配器（必要接口未就绪）' });
        continue;
      }
      try {
        const 回执 = await 退役实例({ 实例, 会审: view.id, 原因: '会审已收敛，退役临时参与实例' });
        结果.push({ 实例, 已退役: true, 回执: 回执 ?? null });
      } catch (error) {
        结果.push({ 实例, 已退役: false, 原因: 错误信息(error) });
      }
    }
    return 结果;
  }

  /**
   * 在会审串行锁内执行一段「读-判-写」——**会审状态变更的唯一锁序**。
   *
   * 锁序固定 `council → bus`：round 的边界消息、say 的发言都在持会审锁时进总线；
   * 反过来（先 bus 再 council）一律不做——同一把锁不可重入，反向拿锁迟早互等死锁。
   * 锁内只允许**读**总线/事件流文件（`readJsonl`/`readRaw` 不拿锁），不嵌套同键锁。
   *
   * @template T
   * @param {string} 项目
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async #withCouncilLock(项目, fn) {
    const file = this.layout.councilLog(项目);
    return serializeByKey(file, () => withLock(this.layout.councilLock(项目), fn));
  }

  /**
   * 事件落线 + 审计（与任务图 #append 同款纪律：事件落线后审计失败要响亮、不许重试）。
   *
   * @param {string} 项目
   * @param {object} event 事件行；**按引用**传进锁，锁内改字段（如轮次）后落线的是锁内值。
   * @param {object} subject
   * @param {string|((current: object|null) => string)} 审计动作 需要按锁内状态区分的动作名传函数。
   * @param {{ inLockGuard?: ((current: object|null) => (void|Promise<void>))|null, afterAppend?: ((view: object|undefined, current: object|null) => (void|Promise<void>))|null }} [hooks]
   *   `inLockGuard(current)`：锁内、落线前的权威复检（会审的解锁/换轮/收敛/作答全是读-判-写，
   *   锁外读到的视图只配早失败——并发两路会读到同一个旧视图）。
   *   `afterAppend(view, current)`：锁内、事件与审计落线后的第二步写入（换轮边界消息必须与
   *   轮次事件同锁同序；放锁外发会被并发换轮乱序，预算闸按最后一条边界切轮就切错）。
   */
  async #append(项目, event, subject, 审计动作, { inLockGuard = null, afterAppend = null } = {}) {
    const file = this.layout.councilLog(项目);
    const eventId = `${event.kind}-${randomUUID().slice(0, 8)}`;
    return this.#withCouncilLock(项目, async () => {
      const rows = await readJsonl(file);
      const views = foldCouncils(rows);
      const current = views.find((v) => v.id === event.id) ?? null;
      if (inLockGuard) await inLockGuard(current);
      const row = { ...event, at: this.clock.iso(), by: subject, eventId };
      await appendLines(file, [row]);
      const 动作 = typeof 审计动作 === 'function' ? 审计动作(current) : 审计动作;
      try {
        await this.audit.append({
          动作,
          主体: subject,
          对象: { id: event.id, kind: '会审' },
          依据: 'v2 条目18：会审 = 会话绑定的独立咨询功能，存档在自己的事件流',
          结果: event.kind,
          项目,
          详情: { kind: event.kind },
        });
      } catch (error) {
        throw new Fault('AUDIT_APPEND_FAILED_AFTER_EVENT', `会审 ${event.id} 的事件（${event.kind}）已落线，但审计追加失败：${error instanceof Error ? error.message : String(error)}。不要重试同一动作（重复事件会撞锁内复检或覆盖状态）——请人工核对审计账本并补记。`, {
          detail: { 会审: event.id, kind: event.kind, 项目 },
        });
      }
      const 落线后 = foldCouncils([...rows, row]);
      const view = 落线后.find((v) => v.id === event.id);
      if (afterAppend) await afterAppend(view, current);
      return { view };
    });
  }

  async #foldAll(项目) {
    const rows = await readJsonl(this.layout.councilLog(项目));
    return foldCouncils(rows);
  }
}

/** 会审线程名（单一拼法：actions 的直灌闸与本服务共用）。 */
export function 线程名(councilId) {
  return `${COUNCIL_THREAD_PREFIX}${councilId}`;
}

/** 错误 → 一行原因（受管创建/退役的补偿与审计共用；不吞原文）。 */
function 错误信息(error) {
  return error instanceof Error ? error.message : String(error);
}

/** 逗号/数组两形态的路径清单归一（`资料` 参数）。 */
function 列表(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(/[,，]/);
  return [...new Set(raw.map((x) => String(x ?? '').trim()).filter(Boolean))];
}

/** 岗位清单归一：**保序、不去重**——同一岗位重复 N 次 = N 个受管实例，去重会把 N 洗成 1。 */
function 岗位列表(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(/[,，]/);
  return raw.map((x) => String(x ?? '').trim()).filter(Boolean);
}

/** 绝对路径归一（Windows 大小写不敏感：同一路径的两种写法必须折成一个）。 */
function 规范路径(路径) {
  const 绝对 = resolve(String(路径));
  return process.platform === 'win32' ? 绝对.toLowerCase() : 绝对;
}

/** 目标是否在根内（按路径段判：前缀相同的兄弟目录不算）。 */
function 在目录内(目标, 根) {
  const 相对 = relative(根, 目标);
  return 相对 === '' || (!相对.startsWith('..') && !isAbsolute(相对));
}

/** 复核员不能作为会审参与者：作答是一次写，与「只读数、不改、不提案」的本职硬约束冲突。 */
function 复核岗不能参会(岗位) {
  return new Denied('会审 · 复核岗不能作为参与者', `复核员（${岗位}）的「只读数、不改、不参与提案」是本职硬约束；会审作答是一次写，不为齐卷给复核岗开口子。要复核意见请走真正的复核任务（Lead 建复核任务 + 显式复核对象，member_spawn 复核实例）。`, {
    requireAuthority: 'Lead',
    howToChange: '把复核员留在复核任务上；会审参与实例用普通成员岗（插件工程 / 文档整理 / 记忆整理…）。',
    detail: { 岗位, 提示: '复核意见走复核任务，不走会审作答' },
  });
}

/** 受管创建失败的统一故障形状（阶段、已建清单、补偿失败都进 detail，便于可追）。 */
function 受管创建失败(code, message, detail) {
  return new Fault(code, message, { detail });
}

/**
 * 会审事件流 → 视图（append-only fold）。一场会审的完整存档 = 这里折出的视图：
 * 问题/各答案/分歧/结论/来源会话/时间——会审页直接读它，不另立存档库。
 */
export function foldCouncils(rows) {
  const map = new Map();
  for (const row of rows ?? []) {
    let c = map.get(row.id);
    if (!c) {
      c = { id: row.id, 问题: null, 参与者: [], 来源会话: null, 状态: '未知', 答案: [], 轮次: 0, 轮次上限: 0, 预算快照: null, 分歧清单: [], 结论: null, 创建于: null, 收敛于: null, 零分歧异常: false, 创建实例: [], 资料: [], 退役: [] };
      map.set(row.id, c);
    }
    switch (row.kind) {
      case 'opened':
        c.问题 = row.问题;
        c.参与者 = row.参与者 ?? [];
        c.来源会话 = row.来源会话 ?? null;
        c.轮次上限 = row.轮次上限 ?? 0;
        c.预算快照 = row.预算快照 ?? null;
        // 补修I：受管创建的实例清单与资料根随 opened 冻结（旧会审无这两个字段 ⇒ 空数组）。
        c.创建实例 = row.创建实例 ?? [];
        c.资料 = row.资料 ?? [];
        c.状态 = '作答中';
        c.创建于 = row.at;
        break;
      case 'answered': {
        const 他人 = c.答案.filter((a) => a.成员 !== row.成员);
        c.答案 = [...他人, { 成员: row.成员, 结论: row.结论 ?? null, 结论层: row.结论层 ?? null, 反例面: row.反例面 ?? [], 于: row.at }];
        break;
      }
      case 'unlocked':
        c.状态 = '已解锁';
        c.解锁于 = row.at;
        break;
      case 'rounded':
        c.状态 = '讨论中';
        c.轮次 = row.轮次 ?? (c.轮次 + 1);
        break;
      case 'converged':
        c.状态 = '已收敛';
        c.结论 = row.结论 ?? null;
        c.分歧清单 = row.分歧清单 ?? [];
        c.零分歧异常 = row.零分歧异常 === true;
        c.收敛于 = row.at;
        break;
      // 补修I：投递失败 ⇒ 作废（冻结作答；可能带早卷，读面仍按盲评遮罩）。
      case 'aborted':
        c.状态 = '作废';
        c.作废于 = row.at;
        c.作废原因 = row.原因 ?? null;
        c.作废阶段 = row.阶段 ?? null;
        break;
      // 补修I：收敛后的退役逐条结果（只本场创建的实例；预给参与者不会出现在这里）。
      case 'retired':
        c.退役 = row.退役 ?? [];
        c.退役于 = row.at;
        break;
      default:
        break; // 未知事件类型：只增账本的旧行/未来行都不炸 fold（向前兼容）。
    }
  }
  return [...map.values()];
}

/**
 * 读取当前生效的会审讨论预算（policy 加载期已校验并规范化成四键齐全）。
 * @param {import('./policy.js').PolicyEngine} policy
 */
export function 会审预算(policy) {
  return { ...DEFAULT_DEBATE_BUDGET, ...(policy.state.defaults?.会审讨论 ?? {}) };
}

/**
 * 最后一条轮边界消息的位置与轮次 —— **轮边界判定的单一源**。
 *
 * 为什么把「认边界」抽出来：预算切轮（`本轮发言`）与跨存储对账（`轮边界轮次`）
 * 必须认同一行、同一段前缀；各写一份，对账口径先漂，预算闸就会在漂掉的那一支上
 * 静默放行（verify-integrity 配方22：匹配口径也是覆盖面）。
 *
 * @param {object[]} 集合
 * @returns {{ 位置: number, 轮次: number|null }} 无边界时 位置=-1 / 轮次=null；
 *   边界消息内容里的轮号不是整数时 轮次=null（对账侧按失配处理）。
 */
function 最后边界(集合) {
  for (let i = 集合.length - 1; i >= 0; i -= 1) {
    const m = 集合[i];
    if (m?.发件 === 'system' && String(m?.类型) === '系统' && String(m?.内容 ?? '').startsWith(ROUND_BOUNDARY_MARK)) {
      const 轮 = Number(String(m.内容 ?? '').slice(ROUND_BOUNDARY_MARK.length).trim());
      return { 位置: i, 轮次: Number.isInteger(轮) && 轮 > 0 ? 轮 : null };
    }
  }
  return { 位置: -1, 轮次: null };
}

/**
 * 线程里最后一条轮边界消息声明的轮次（无边界 ⇒ null）。
 *
 * 会审的轮次状态住在 `councils.jsonl`、预算轮住在总线线程——两个存储各自只增，
 * 因此每次「写前读」都要对一次账：状态说第 N 轮，边界就必须是 N。对不上时调用方
 * 必须 fail-closed（拒绝写并指明人工补记），不许把消息记进错的一轮把预算洗掉。
 *
 * @param {object[]} messages 折叠后的线程消息（`bus.readRaw` 的输出）
 * @returns {number|null}
 */
export function 轮边界轮次(messages) {
  return 最后边界(messages ?? []).轮次;
}

/**
 * 本轮发言：**最后一条**轮边界消息（`[debate-round]` 系统消息）之后的**名单内**发言
 * （类型 ∈ 分歧/表态/答复，且 `发件 ∈ 名单`）。第 1 轮没有边界消息 ⇒ 全部消息算本轮。
 * 名单必填：漏传会让预算闸静默失效（fail-open），按 fail-closed 拒。
 *
 * @param {object[]} messages 折叠后的线程消息（`bus.readRaw` 的输出）
 * @param {string[]} 名单 预算名单（= 会审参与者；v2 起没有强制反对者）
 * @returns {object[]}
 */
export function 本轮发言(messages, 名单) {
  if (!Array.isArray(名单)) {
    throw new InvalidBody('本轮发言 需要 名单（会审参与者）：漏传会让预算闸静默失效（fail-open），按 fail-closed 拒。', {
      missing: ['名单'],
    });
  }
  const 集合 = messages ?? [];
  const 在名单 = new Set(名单.filter((id) => typeof id === 'string' && id !== ''));
  const { 位置 } = 最后边界(集合);
  return 集合.slice(位置 + 1).filter((m) => DEBATE_SAY_TYPES.includes(m?.类型) && 在名单.has(m?.发件));
}

/**
 * 可收敛判据：本轮零新「分歧」消息 **且** 每个参与者都发过「表态」。
 * @param {object[]} 本轮 @param {string[]} 参与者
 */
export function 可收敛判定(本轮, 参与者) {
  const 新分歧 = 本轮.filter((m) => m.类型 === '分歧').length;
  const 已表态 = [...new Set(本轮.filter((m) => m.类型 === '表态').map((m) => m.发件))];
  const 未表态 = (参与者 ?? []).filter((p) => !已表态.includes(p));
  const 可收敛 = 新分歧 === 0 && 未表态.length === 0;
  const 说明 = 可收敛
    ? '本轮零新分歧且每个参与者都已表态：可以收敛（debate_converge，Lead）。'
    : `不可收敛：${新分歧 > 0 ? `本轮还有 ${新分歧} 条新分歧未答复` : '零新分歧'}；${未表态.length > 0 ? `未表态：${未表态.join('、')}` : '已全员表态'}。`;
  return { 可收敛, 说明, 详情: { 新分歧, 已表态, 未表态 } };
}
