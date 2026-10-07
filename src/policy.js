/**
 * 策略引擎（§7「唯一判定点」、§4 三档门槛与三权、§12 约束清单）。
 *
 * 四条不可让步的性质：
 *  1. **不能被绕过** —— 对象存储、记忆服务、任务图、消息总线全部经由 `check()` 才落盘。
 *  2. **fail-closed** —— 规则加载失败、主体未知、动作未知、无匹配规则，一律拒绝。
 *     §12.2 特别点名：「身份被停用/删除时，权限判定必须有确定答案（不许查不到 = 放行）」。
 *  3. **拒绝带可执行理由** —— 「哪条规则 + 改它要什么授权」，由 `Denied` 承载。
 *  4. **判定只读标签不读路径** —— 决策只看 `authority / kind / domain / zone / 编制`，
 *     不因为某个对象「放在自己家门口」就放行。
 *
 * 规则的三层来源，从强到弱：
 *  第一层 · 宪章不变式（硬编码，任何法律都改不动）—— 直接来自 §3「永不」与 §12 约束清单
 *  第二层 · 法律件里的机器可读授权块（`权限矩阵.md` 中的 ```policy 块）
 *  第三层 · 出厂默认值（介入度 / 响应期限 / 工具总范围）
 *  兜底   · 无匹配 ⇒ 拒绝
 */
import { readTextOrNull } from './kernel/fsx.js';
import { digest } from './kernel/text.js';
import { Denied, Fault, NeedsApproval } from './kernel/errors.js';
import { evaluateSovereignPresence } from './kernel/time.js';
import { RULE_FILES } from './paths.js';
import { parseDocument } from './tags.js';

/** 动作的封闭清单。表外的动作 = 未知动作 = 拒绝（fail-closed）。 */
export const ACTIONS = [
  'read',
  'write',
  'create',
  'delete',
  'publish',
  'dispatch',
  'review',
  'approve',
  'seal',
  'revoke',
  'propose',
  'draft',
  'rollback',
  'forceUpdate',
  'experiment',
];

/** 主体种类的封闭清单（§2 主体表）。 */
export const SUBJECT_KINDS = ['主权者', '出厂作者', 'Lead', '成员', '复核者', '系统'];

/** 介入度四档（§4），只影响自治档。 */
export const INTERVENTION = ['零参与', '事后抽检', '变更预审', '逐条审批'];

const ALWAYS_INVARIANTS = '宪章 不可违背原则（§3 永不 + §12 约束清单）';

/**
 * 引擎实例。
 */
export class PolicyEngine {
  /**
   * @param {{ layout: import('./paths.js').Layout, clock: import('./kernel/time.js').Clock, audit?: { append: Function } }} spec
   */
  constructor(spec) {
    this.layout = spec.layout;
    this.clock = spec.clock;
    this.audit = spec.audit ?? null;
    /** @type {{ ok: boolean, error: string|null, at: string|null, rules: object[], defaults: object, identity: object, establishment: object, digests: Record<string,string> }} */
    this.state = {
      ok: false,
      error: '尚未加载',
      at: null,
      rules: [],
      defaults: {},
      identity: { members: {}, sovereign: { lastInteraction: null }, denylist: [] },
      establishment: { roles: [], mode: '独立会审' },
      digests: {},
    };
    /** 已加载的授权块（法律件里那份），热更新时整体替换。 */
    this.grants = [];
  }

  /** 热更新入口：宿主在文件变更时调用；失败不改变「不健康」这个事实。 */
  async reload() {
    try {
      const { rules, digests } = await this.#loadRules();
      const defaults = await this.#loadDefaults();
      const identity = await this.#loadIdentity();
      const establishment = await this.#loadEstablishment();
      this.grants = collectGrants(rules);
      this.state = {
        ok: true,
        error: null,
        at: this.clock.iso(),
        rules,
        defaults,
        identity,
        establishment,
        digests,
      };
    } catch (error) {
      // fail-closed：加载失败 ⇒ 引擎不健康，之后所有判定走 Fault（拒绝 + 告警）。
      this.state = {
        ...this.state,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        at: this.clock.iso(),
      };
    }
    return this.state.ok;
  }

  /** @returns {boolean} */
  get healthy() {
    return this.state.ok === true;
  }

  /** 引擎自述：给工作台与探针用（探针要能发现「闸被关了」）。 */
  describe() {
    return {
      healthy: this.healthy,
      error: this.state.error,
      loadedAt: this.state.at,
      rules: this.state.rules.map((r) => ({ id: r.id, authority: r.authority, zone: r.zone, digest: r.digest })),
      defaults: this.state.defaults,
      grants: this.grants.length,
      digests: this.state.digests,
    };
  }

  /**
   * 判定。永不抛错，只返回结论——调用方要「拒绝即抛」就用 `check()`。
   *
   * @param {{ subject: object, action: string, target: object, context?: object }} input
   * @returns {Promise<{ verdict: 'allow'|'deny'|'confirm', rule: string, reason: string, requireAuthority: string, howToChange: string, detail?: object, authority?: string, alarm?: boolean }>}
   */
  async decide(input) {
    if (!this.healthy) {
      return new Fault('POLICY_NOT_LOADED', `策略引擎不健康：${this.state.error ?? '未知原因'}`).toDecision();
    }
    try {
      const verdict = this.#evaluate(input);
      if (verdict.verdict !== 'allow') {
        await this.audit?.append?.({
          动作: '策略拒绝',
          主体: input.subject,
          对象: { id: input.target?.id ?? null, kind: input.target?.kind ?? '未知' },
          依据: verdict.rule,
          结果: verdict.verdict === 'confirm' ? '需确认' : '拒绝',
          详情: { action: input.action, reason: verdict.reason, requireAuthority: verdict.requireAuthority },
        });
      }
      return verdict;
    } catch (error) {
      return new Fault('POLICY_EVALUATION_FAILED', `判定过程故障：${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
        detail: { action: input.action, target: input.target?.id ?? null },
      }).toDecision();
    }
  }

  /**
   * 判定 + 不通过就抛。写路径的唯一入口。
   * @param {{ subject: object, action: string, target: object, context?: object }} input
   * @returns {Promise<{ verdict: 'allow', rule: string, reason: string }>}
   */
  async check(input) {
    const decision = await this.decide(input);
    if (decision.verdict === 'allow') {
      return { verdict: 'allow', rule: decision.rule, reason: decision.reason };
    }
    if (decision.verdict === 'confirm') {
      throw new NeedsApproval(decision.rule, decision.reason, {
        requireAuthority: decision.requireAuthority,
        howToChange: decision.howToChange,
        detail: decision.detail,
      });
    }
    if (decision.alarm) {
      throw new Fault(String(decision.rule).replace(/^fault:/, ''), decision.reason, { detail: decision.detail });
    }
    throw new Denied(decision.rule, decision.reason, {
      requireAuthority: decision.requireAuthority,
      howToChange: decision.howToChange,
      detail: decision.detail,
    });
  }

  /**
   * 主体能否在任务内行动（§2「任务内全权，任务外无」）。
   * @param {object} subject
   * @param {object|null} task
   * @returns {{ ok: boolean, reason?: string }}
   */
  scopeOf(subject, task) {
    if (subject?.kind !== '成员') return { ok: true };
    if (!task) return { ok: false, reason: '成员在任务外无权限：没有关联任务节点' };
    // 负责人可能是**一个人**，也可能是**一岗多人的一组**（§10）。
    // 拿字符串去比数组会永远不相等，于是多负责人任务上谁也干不了活 —— 这里统一折成名单。
    const 名单 = normalizeList(task.负责人);
    if (名单.length === 0) return { ok: true };
    const 我 = [subject.id, subject.roleId].filter(Boolean);
    if (!我.some((id) => 名单.includes(id))) {
      return { ok: false, reason: `该任务节点负责人是 ${名单.join('、')}，不是 ${subject.id}` };
    }
    return { ok: true };
  }

  /** 当前是否处于失联（§4 失联：所有自治变更冻结）。 */
  presence() {
    return evaluateSovereignPresence({
      lastInteraction: this.state.identity?.sovereign?.lastInteraction ?? null,
      responseDeadlineHours: this.state.defaults?.响应期限小时 ?? 72,
      now: this.clock.now(),
    });
  }

  /** @returns {string} 当前介入度档位 */
  intervention() {
    const level = this.state.defaults?.介入度 ?? '零参与';
    return INTERVENTION.includes(level) ? level : '零参与';
  }

  // ── 判定本体 ────────────────────────────────────────────────────────────────

  /** @param {{ subject: object, action: string, target: object, context?: object }} input */
  #evaluate(input) {
    const subject = normalizeSubject(input.subject);
    const target = input.target ?? {};
    const action = input.action;
    const context = input.context ?? {};
    const authority = target.authority ?? '自治';

    if (!SUBJECT_KINDS.includes(subject.kind)) {
      return deny('宪章 主体定义（§2）', `未知主体种类：${String(subject.kind)}。查不到身份不等于放行（§12.2）。`, {
        requireAuthority: '宪章',
        howToChange: '由主权者在身份档案中登记该主体，或改用已登记的身份。',
      });
    }
    if (!ACTIONS.includes(action)) {
      return deny(ALWAYS_INVARIANTS, `未知动作：${String(action)}。策略引擎不做默认放行。`, {
        requireAuthority: '宪章',
        howToChange: `改用动作清单内的动作：${ACTIONS.join(' / ')}`,
      });
    }

    const invariant = this.#invariants(subject, action, target, context);
    if (invariant) return invariant;

    const write = action !== 'read';
    if (write && this.#isDenied(subject, target)) {
      return deny(
        '法律 撤回 = 写拒绝名单，不删卡（§4 三权）',
        `对象 ${target.id} 在拒绝名单上：主权者已撤回该对象，新的写入一律不许。`,
        { requireAuthority: '主权者', howToChange: '由主权者从拒绝名单移除该 id，卡本身没有被删除。' },
      );
    }

    if (write && authority === '自治' && this.presence().lost) {
      return deny('宪章 失联（§4）', `主权者已失联，所有自治变更冻结；服务与记忆照常，安全类强更不受影响。`, {
        requireAuthority: '主权者',
        howToChange: '主权者任一次交互即解除失联。',
      });
    }

    // 顺序很重要：不变式 → 法律件的显式授权块 → 内置的三档默认。
    // 内置档位是**出厂默认文本**，主权者改过的 权限矩阵.md 是同一部法律的现行版本，
    // 所以它必须先于默认生效；而宪章不变式在它之前，任何法律都翻不动。
    const grant = this.#grantRule(subject, action, authority, target);
    if (grant) return grant;

    const tierRule = this.#tierRule(subject, action, target, authority, context);
    if (tierRule) return tierRule;

    const scoped = this.scopeOf(subject, context.task ?? null);
    if (!scoped.ok && action !== 'read') {
      return deny('法律 权限矩阵 · 任务内全权，任务外无（§2）', scoped.reason, {
        requireAuthority: 'Lead',
        howToChange: '由 Lead 把该成员派到对应任务节点，或改由该节点负责人执行。',
      });
    }

    return deny(
      '策略引擎 fail-closed（§7）',
      `没有匹配到允许规则：主体 ${subject.kind}/${subject.id} 对 ${target.kind ?? '未知'}(${target.id ?? '-'}) 执行 ${action}。`,
      {
        requireAuthority: '法律',
        howToChange: `在 权限矩阵.md 的 \`\`\`policy 块中为该组合登记 grant，或改由有授权的身份执行。`,
      },
    );
  }

  /**
   * 第一层：宪章不变式。任何法律都改不动，因为它们是「组织给自己发合格证」这类
   * 结构性失效的唯一防线。
   */
  #invariants(subject, action, target, context) {
    const write = action !== 'read';
    const authority = target.authority ?? '自治';

    if (action === 'approve' && context.proposerId && String(context.proposerId) === String(subject.id)) {
      return deny('宪章 §3.4 组织给自己发合格证', '提案者不得自批：本次提案人与批准人是同一个主体。', {
        requireAuthority: '宪章',
        howToChange: '换一个未参与提案的主体批准（复核者或主权者）。',
      });
    }
    // §3.5「成员自扩权 / 再起成员」的准确边界：禁的是**给自己或别人扩权**，
    // 不是「成员不许产生任何对象」——成员把自己的作答与知识记下来是本职。 
    const 建卡或扩权 = action === 'create' && ['身份', '规则'].includes(target.kind);
    if (subject.kind === '成员' && (建卡或扩权 || ['dispatch', 'propose', 'approve'].includes(action))) {
      return deny('宪章 §3.5 成员自扩权 / 再起成员', `成员不得执行 ${action}：建卡、派活与提案都属于 Lead。`, {
        requireAuthority: 'Lead',
        howToChange: '由 Lead 执行该动作；成员只能在自己的任务节点内干活并留下作答与知识。',
      });
    }
    if (authority === '只增' && ['write', 'delete', 'publish'].includes(action)) {
      return deny('宪章 §7 只增（主权者也不能改，只能追加更正）', `对象 ${target.id} 是只增账目，${action} 不被允许。`, {
        requireAuthority: '宪章',
        howToChange: '改用「追加更正」：新写一条更正记录指向原条目。',
      });
    }
    if (target.segment === '身份核心' && write && subject.kind !== '出厂作者') {
      return deny('宪章 §5 身份核心锁定', '身份核心不可就地改写：身份若能被就地改写，身份连续性就断了。', {
        requireAuthority: '出厂作者',
        howToChange: '身份核心随产品更新；本部署只能改个体 L1/L2/L3 段。',
      });
    }
    if (target.zone === '旧数据') {
      if (subject.kind === '主权者') return allow('宪章 §13 旧数据读权限（主权者可读）', '主权者随时可读旧数据，但它不接入检索面。');
      if (subject.kind === 'Lead') {
        return confirm('宪章 §13 旧数据读权限（Lead 需单次授权）', 'Lead 读旧数据需要主权者单次授权。', {
          requireAuthority: '主权者',
          howToChange: '由主权者针对本次读取给出单次授权。',
        });
      }
      return deny('宪章 §13 旧数据读权限', `${subject.kind} 不可读旧数据。`, {
        requireAuthority: '主权者',
        howToChange: '旧数据原地只读、不接入检索面；确需内容请主权者导出。',
      });
    }
    if (['delete', 'publish'].includes(action) && subject.kind !== '主权者') {
      return deny('宪章 §3.2 未经主权者的删除 / 发布 / 批量覆盖', `${subject.kind} 不得执行 ${action}。`, {
        requireAuthority: '主权者',
        howToChange: '改为提交提案（propose），由主权者发布或删除。',
      });
    }
    if (action === 'rollback' && target.textVersion === true && subject.kind !== '主权者') {
      return deny('宪章 §4 只有主权者能回滚文本版本', '文本版本回滚是主权者专属动作。', {
        requireAuthority: '主权者',
        howToChange: '注意：回滚的是文本，不是世界；机制回滚是另一回事。',
      });
    }
    return null;
  }

  /** 第二层：三档门槛（立宪 / 立法 / 自治），唯一分界线是「你定的 > 组织定的」。 */
  #tierRule(subject, action, target, authority, context) {
    if (subject.kind === '复核者') {
      // §2「只读数，不改，不参与提案」的准确边界：**不许改被验对象**。
      // 它属于法律档而不是宪章不变式 —— 复核者卡的「身份 + 权限 + 判据」段本就是法律，
      // 主权者改 权限矩阵.md 时应当能改到它；宪章不变式（不自批、不删除）在更前面拦着。
      //
      // §8 同时要求复核者输出三态结论 —— 结论是只增证据，不是对被验对象的改动，
      // 所以 review 与 read 放行，experiment 只在沙箱区放行，其余写动作一律拒绝。
      if (action === 'experiment') {
        if (target.sandbox !== true) {
          return deny('§2 复核者需要落盘的实验走沙箱区', '复核者的落盘实验必须落在沙箱区：单独授权、不进持久状态、任务结束即清。', {
            requireAuthority: '主权者',
            howToChange: '把实验放进沙箱区（target.sandbox = true），或改由成员在任务内执行。',
          });
        }
      } else if (!['read', 'review'].includes(action)) {
        return deny('法律 复核者只读数，不改，不参与提案（§2）', `复核者不得执行写动作 ${action}：它不改被验对象，也不派活、不提案。`, {
          requireAuthority: '主权者',
          howToChange: '复核结论经 review 落账（只增证据）；需要改动由 Lead 按结论执行。',
        });
      }
    }
    if (authority === '宪章') {
      if (subject.kind === '主权者') return allow('法律 权限矩阵 · 宪章档', '宪章由主权者主导并确定。');
      if (subject.kind === 'Lead' && action === 'draft') {
        return allow('法律 权限矩阵 · 宪章档（Lead 只协助起草）', 'Lead 可协助起草，修宪不可发起。');
      }
      return deny('法律 权限矩阵 · 宪章档（Lead 不许发起修宪）', `${subject.kind} 不得对宪章执行 ${action}。`, {
        requireAuthority: '主权者',
        howToChange: 'Lead 只能协助起草；立宪与修宪由主权者主导并确定。',
      });
    }
    if (authority === '法律') {
      if (subject.kind === '主权者') return allow('法律 权限矩阵 · 法律档', '法律由主权者确定。');
      if (subject.kind === 'Lead' && action === 'propose') {
        return allow('法律 权限矩阵 · 法律档（Lead 可提议修法）', 'Lead 可提议修法，确定权在主权者。');
      }
      if (subject.kind === 'Lead' && action === 'read') return allow('法律 权限矩阵 · 法律档', '法律可读。');
      return deny('法律 权限矩阵 · 法律档', `${subject.kind} 不得对法律执行 ${action}。`, {
        requireAuthority: '主权者',
        howToChange: 'Lead 提议（propose）后由主权者确定；法律默认文本与用户改动走叠加层合并。',
      });
    }
    if (authority === '只增') {
      // 只增档的语义就是「只能追加」：追加（create）与读取放行，
      // 改写 / 删除 / 发布由宪章不变式先一步拒绝（主权者也不例外）。
      if (action === 'create') return allow('法律 权限矩阵 · 只增档', '只增对象允许追加；改写与删除由宪章不变式拒绝。');
      if (action === 'read') return allow('法律 权限矩阵 · 只增档', '只增对象可读。');
      return deny('法律 权限矩阵 · 只增档', `只增对象不支持 ${action}：它只能被追加。`, {
        requireAuthority: '宪章',
        howToChange: '改用 create 追加一条更正记录，指向原条目。',
      });
    }
    if (authority === '自治') {
      if (subject.kind === '主权者') return allow('法律 权限矩阵 · 自治档', '主权者随时可介入自治档。');
      if (subject.kind === '成员') {
        // 「任务外无」管的是**权**，不是**读**：成员读自己岗位的知识与能力是干活的前提。
        const scoped = this.scopeOf(subject, context.task ?? target.task ?? null);
        if (!scoped.ok && action !== 'read') return deny('法律 权限矩阵 · 自治档（任务外无）', scoped.reason, {
          requireAuthority: 'Lead',
          howToChange: '由 Lead 派发任务节点后再执行。',
        });
      }
      const level = this.intervention();
      if (level === '变更预审') {
        return confirm('法律 介入度 · 变更预审（§4）', `本部署介入度为「变更预审」：自治变更需主权者预审。`, {
          requireAuthority: '主权者',
          howToChange: '由主权者预审后放行，或把介入度调回「零参与 / 事后抽检」。',
        });
      }
      if (level === '逐条审批') {
        return confirm('法律 介入度 · 逐条审批（§4）', '本部署介入度为「逐条审批」：每条自治变更都要主权者点头。', {
          requireAuthority: '主权者',
          howToChange: '由主权者逐条批准。',
        });
      }
      return allow(
        level === '事后抽检' ? '法律 介入度 · 事后抽检（§4）' : '法律 介入度 · 零参与（§4）',
        level === '事后抽检' ? '自治变更放行，事后抽检，留痕必须完整。' : '自治档由组织自决，主权者默认不参与。',
      );
    }
    return null;
  }

  /** 第三层：法律件里的机器可读授权块。 */
  #grantRule(subject, action, authority, target) {
    for (const grant of this.grants) {
      if (grant.subject !== subject.kind) continue;
      if (grant.action !== action) continue;
      if (grant.authority && grant.authority !== authority) continue;
      if (grant.kind && grant.kind !== target.kind) continue;
      if (grant.verdict === 'deny') {
        return deny(`法律 权限矩阵 grant#${grant.index}`, grant.reason ?? `法律显式禁止 ${subject.kind} 对 ${authority} 档执行 ${action}。`, {
          requireAuthority: grant.requireAuthority ?? '主权者',
          howToChange: '修改 权限矩阵.md 中对应的 grant。',
        });
      }
      if (grant.verdict === 'confirm') {
        return confirm(`法律 权限矩阵 grant#${grant.index}`, grant.reason ?? `法律要求该动作先获确认。`, {
          requireAuthority: grant.requireAuthority ?? '主权者',
          howToChange: '由相应授权人确认后重试。',
        });
      }
      return allow(`法律 权限矩阵 grant#${grant.index}`, grant.reason ?? '法律授权块显式允许。');
    }
    return null;
  }

  /** 撤回名单命中（只挡新写入，不删卡）。 */
  #isDenied(subject, target) {
    if (subject.kind === '主权者') return false;
    const list = this.state.identity?.denylist ?? [];
    return list.some((entry) => entry.id === target.id);
  }

  // ── 加载 ────────────────────────────────────────────────────────────────────

  async #loadRules() {
    /** @type {Array<{id:string, authority:string, zone:string, text:string, digest:string, path:string}>} */
    const rules = [];
    const digests = {};
    for (const spec of RULE_FILES) {
      let found = null;
      // 私有区覆盖出厂区（§5 叠加层）：先看私有，命中即生效，出厂那份仍留作基线。
      for (const zone of ['私有', '出厂']) {
        const path = this.layout.rulePath(spec.id, zone);
        if (!path) continue;
        const text = await readTextOrNull(path);
        if (text === null) continue;
        const parsed = parseDocument(text, { defaultAuthority: spec.authority });
        if (parsed.errors.length) {
          throw new Error(`规则件 ${spec.id}（${zone}）无法解析：${parsed.errors.join('；')}`);
        }
        found = { id: spec.id, authority: spec.authority, zone, text, digest: digest(text), path };
        break;
      }
      if (!found) {
        // 宪章缺失 = 没有判据来源 = fail-closed（§7 加载失败 fail-closed）。
        throw new Error(`规则件缺失：${spec.id}（私有区与出厂区都没有）`);
      }
      rules.push(found);
      digests[spec.id] = found.digest;
    }
    return { rules, digests };
  }

  async #loadDefaults() {
    const merged = { 介入度: '零参与', 响应期限小时: 72, 工具总范围: '全部', 安全类: [] };
    for (const zone of ['出厂', '私有']) {
      const file =
        zone === '出厂' ? this.layout.factoryDefault('介入度') : this.layout.deploymentPrefs();
      const text = await readTextOrNull(file);
      if (text === null) continue;
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw new Error(`${zone}区默认值无法解析：${error instanceof Error ? error.message : String(error)}`);
      }
      Object.assign(merged, parsed);
      if (zone === '出厂') {
        const probeText = await readTextOrNull(this.layout.probeDeclaration());
        if (probeText !== null) {
          try {
            merged.安全类 = JSON.parse(probeText).探针 ?? [];
          } catch (error) {
            throw new Error(`出厂安全类探针声明无法解析：${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    }
    return merged;
  }

  async #loadIdentity() {
    const text = await readTextOrNull(this.layout.identityFile());
    if (text === null) {
      // 身份档案缺失不是「无限制」，而是「没有任何登记在案的身份」——
      // 除主权者外一律拒绝，见 #evaluate 的 fail-closed 兜底。
      return { members: {}, sovereign: { lastInteraction: null }, denylist: [] };
    }
    try {
      const parsed = JSON.parse(text);
      return {
        members: parsed.members ?? {},
        sovereign: parsed.sovereign ?? { lastInteraction: null },
        denylist: parsed.denylist ?? [],
      };
    } catch (error) {
      throw new Error(`身份档案无法解析：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async #loadEstablishment() {
    const path = this.layout.establishmentPath('私有');
    const factoryPath = this.layout.establishmentPath('出厂');
    const text = (await readTextOrNull(path)) ?? (await readTextOrNull(factoryPath));
    if (text === null) return { roles: [], mode: '独立会审' };
    const parsed = parseDocument(text, { defaultAuthority: '自治' });
    const block = extractPolicyBlock(parsed.body);
    return {
      roles: block?.roles ?? [],
      mode: block?.mode ?? '独立会审',
      digest: digest(text),
    };
  }
}

/** @param {string} rule @param {string} reason @param {{requireAuthority?:string, howToChange?:string, detail?:object}} [options] */
function deny(rule, reason, options = {}) {
  return { verdict: 'deny', rule, reason, requireAuthority: options.requireAuthority ?? '自治', howToChange: options.howToChange ?? '', detail: options.detail ?? {} };
}
/** @param {string} rule @param {string} reason */
function allow(rule, reason) {
  return { verdict: 'allow', rule, reason, requireAuthority: '无', howToChange: '' };
}
/** @param {string} rule @param {string} reason @param {{requireAuthority?:string, howToChange?:string}} [options] */
function confirm(rule, reason, options = {}) {
  return { verdict: 'confirm', rule, reason, requireAuthority: options.requireAuthority ?? '主权者', howToChange: options.howToChange ?? '' };
}

/**
 * 把「一个人 / 一组人 / 空」折成名单。任务图的负责人本来就是这个形状（§10 一岗多人）。
 * @param {string|string[]|null|undefined} value
 * @returns {string[]}
 */
function normalizeList(value) {
  if (value === null || value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map((v) => String(v).trim()).filter(Boolean);
}

/**
 * 主体规范化。缺 id/kind 的主体不会被「当作系统」放行。
 * @param {string|object} subject
 * @returns {{ id: string, kind: string, roleId?: string, generation?: number }}
 */
export function normalizeSubject(subject) {
  if (subject && typeof subject === 'object') {
    return {
      id: String(subject.id ?? 'anonymous'),
      kind: String(subject.kind ?? '未知'),
      ...(subject.roleId ? { roleId: String(subject.roleId) } : {}),
      ...(subject.generation !== undefined ? { generation: Number(subject.generation) } : {}),
    };
  }
  return { id: String(subject ?? 'anonymous'), kind: '未知' };
}

/**
 * 从正文中取出 ```policy 块并解析成授权表。
 * @param {string} body
 * @returns {{ grants?: object[], roles?: string[], mode?: string }|null}
 */
export function extractPolicyBlock(body) {
  const blocks = [...String(body).matchAll(/```policy\r?\n([\s\S]*?)```/g)];
  if (blocks.length === 0) return null;
  const merged = {};
  for (const [, raw] of blocks) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    for (const key of Object.keys(parsed)) {
      if (Array.isArray(parsed[key])) merged[key] = [...(merged[key] ?? []), ...parsed[key]];
      else merged[key] = parsed[key];
    }
  }
  return merged;
}

/** 把各法律件里的 grants 摊平并编上序号（拒绝理由要能指回条款）。 */
function collectGrants(rules) {
  const out = [];
  for (const rule of rules) {
    const parsed = parseDocument(rule.text, { defaultAuthority: rule.authority });
    const block = extractPolicyBlock(parsed.body);
    if (!block?.grants) continue;
    block.grants.forEach((grant, index) => {
      out.push({
        ...grant,
        verdict: grant.verdict ?? 'allow',
        source: `${rule.id}（${rule.zone}区）`,
        index: `${rule.id}#${index + 1}`,
      });
    });
  }
  return out;
}

/**
 * 主体是否在身份档案中登记且未停用（§12.2：身份被停用/删除时判定必须有确定答案）。
 * @param {PolicyEngine} engine
 * @param {string} id
 * @returns {{ known: boolean, status: string, reason: string }}
 */
export function identityStatus(engine, id) {
  const member = engine.state.identity?.members?.[id];
  if (!member) {
    return { known: false, status: '未登记', reason: `身份档案里没有 ${id}：查不到不等于放行，按最严处理。` };
  }
  if (member.status && member.status !== '在岗') {
    return { known: true, status: member.status, reason: `身份 ${id} 当前状态为 ${member.status}，按最严处理。` };
  }
  return { known: true, status: '在岗', reason: '' };
}
