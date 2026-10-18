/**
 * 安全类（封闭清单）与红线索兵（§4 安全类 + 五道配套）。
 *
 * 这一件是整份设计里唯一允许**绕过主权者**的机制，所以它的每一条边界都必须可执行：
 *
 *  - **封闭清单**：只有四类探针，且**不许「等其他类似情况」兜底**。
 *  - **红线索兵**：主权者声明、出厂作者实现；探针本身受安全类保护，强更不能绕过它。
 *  - **探针红 ⇒ 自动回滚**：定位**探针全绿的最近一版**（不是紧邻上一版）。
 *  - **自动回滚的定性（甲′裁决 2026-10-09）**：定位全绿最近一版＋无条件**入账**＋告警并**升级主权者**；
 *    运行态**不自动改文件**——执行面＝主权者经版本管理（git/包版本）装回全绿版本。
 *  - **探针健康**：恒红与恒绿都要报警（恒亮的灯等于没灯）。
 *  - **留痕 + 可申诉**：全程入账，主权者可申诉并回滚机制版本。
 */
import { listFiles, readJsonOrNull, readTextOrNull, atomicWrite, ensureDirPath } from './kernel/fsx.js';
import { unlink } from 'node:fs/promises';
import { shortHash } from './kernel/ids.js';
import { Denied } from './kernel/errors.js';
import { mechanismArtifact } from './mechanism-artifact.js';
// 「按 id 找卡」的共享实现（设计评审 #11 · 2026-10-15）：撤回名单探针与升级比对此前
// 各有一份候选集（探针版漏了能力卡 ⇒ 撤回一张能力卡会被误报成「撤回变成删除」）。
// import 图无环：upgrade 只 import kernel/paths，不依赖本文件。
import { 按id找卡 } from './upgrade.js';

/** 封闭清单。新增一项要改这里 + 出厂声明，二者不一致就是故障。 */
export const CLOSED_LIST = ['审计链', '闸在位', '出厂件洁净', '撤回名单一致'];

/** 连续多少次同色才算「恒」。太短会把偶发抖动报成故障。 */
const STICKY_RUNS = 3;

/**
 * 快照保留（设计债㉘ · 2026-10-17）。触发线对齐心跳盯守阈值「>200 该盯」；
 * 清理带回滞（一次清回 150）：不留滞回会「每跑一次删一个」，把审计链灌成保留日志。
 * 盘面自检一条只读命令：数目录文件数 ≤ 201（200 触发线 + 受保护的最近全绿）。
 */
const KEEP_SNAPSHOTS = 200;
const PRUNE_TO = 150;

/**
 * 探针巡检的主体白名单（2026-10-12 评审 P1-8）。**不挂策略引擎**：探针必须在引擎
 * 不健康时照常跑（「闸不在位」正是为它点的灯）；kind 由会话事实链供给，自报不到。
 */
const PROBE_RUNNERS = ['Lead', '主权者', '系统'];

export class ProbeRunner {
  /**
   * @param {{ layout: import('./paths.js').Layout, policy: import('./policy.js').PolicyEngine, audit: import('./audit.js').AuditLog, clock: import('./kernel/time.js').Clock, capability?: object, 无内核装配?: boolean }} spec
   *   `无内核装配: true` 只给纯服务夹具/命令面用：没有内核装配就没有回执文件，
   *   探针必须显式知道这一点；**缺省不猜**，回执缺席按「未知」见红（P1-04）。
   */
  constructor(spec) {
    this.layout = spec.layout;
    this.policy = spec.policy;
    this.audit = spec.audit;
    this.clock = spec.clock;
    this.capability = spec.capability ?? null;
    this.无内核装配 = spec.无内核装配 === true;
  }

  /**
   * 出厂声明：主权者声明探针集合，出厂作者实现它们。
   * 声明与封闭清单不一致时**报错而不是兜底**——那是安全类被绕过的第一个信号。
   *
   * 坏 JSON 不许把巡检整条带崩（W3 批2·2026-10-09）：此前 `JSON.parse` 裸调用，
   * 一个手滑写坏的声明文件会让 `declare()` 抛 ⇒ `run()` 在第一步就炸 ⇒
   * **快照与审计全都没有**——「声明坏了」这件事反而变成看不见的事（静默失败最坏的一种）。
   * 现在坏 JSON 折成一条「问题」，`一致=false`、巡检照跑照落快照照入账，见红。
   *
   * @returns {Promise<{声明: string[], 已实现: string[], 一致: boolean, 问题: string[]}>}
   */
  async declare() {
    const text = await readTextOrNull(this.layout.probeDeclaration());
    const 问题 = [];
    let 声明 = [];
    if (text) {
      try {
        const 解析 = JSON.parse(text);
        声明 = Array.isArray(解析?.探针) ? 解析.探针 : [];
        if (!Array.isArray(解析?.探针)) 问题.push('声明文件的 探针 字段不是数组（或缺失）：安全类声明面读不出探针集合。');
      } catch (error) {
        // 只报「解析不了 + 原始原因」，不吞：坏声明等于探针集合失去约束。
        问题.push(`声明文件无法解析（${error.message}）：安全类声明面坏了等于探针集合失去约束。`);
      }
    }
    for (const name of 声明) {
      if (!CLOSED_LIST.includes(name)) 问题.push(`声明了清单外的探针「${name}」：安全类不许「等其他类似情况」兜底。`);
    }
    for (const name of CLOSED_LIST) {
      if (!声明.includes(name)) 问题.push(`清单内的探针「${name}」没有被声明，等于它被关掉了。`);
    }
    return { 声明, 已实现: CLOSED_LIST, 一致: 问题.length === 0, 问题 };
  }

  /**
   * 跑全部探针并落一份快照。
   *
   * 快照是「回滚目标」的唯一来源：只有留下证据，才可能回到「全绿的最近一版」。
   *
   * 主体闸（2026-10-12 评审 P1-8）：落快照 + 入账是写动作，动作面修前零闸——任何成员
   * 子会话都能经 mind_guard 灌水快照、操纵恒红/恒绿健康判定。但这里**不能过策略引擎**：
   * 探针必须在引擎不健康时照常跑（「闸不在位」那盏灯正是为它点的；safety-suite 钉死了
   * 删掉规则件后 run 必须照常落快照），过 policy.check 等于「闸坏了灯也灭」。
   * 于是闸是**结构性身份白名单**：Lead / 主权者 / 系统可跑，成员 / 复核者 / 未知一律拒。
   * 它不靠身份档案（引擎不健康时档案同样不可信），而 kind 由会话事实链供给（内核
   * 门①/门② 已封自报），成员在工具面拿不到 Lead 这个 kind。
   *
   * 机制版本只取实际加载包的代码身份，不采信调用方标签；制品凭据缺失不等于可恢复。
   *
   * @param {{ subject: object }} spec
   * @returns {Promise<{全绿: boolean, 结果: Array<object>, 见红: Array<object>, 机制版本: string, 于: string, 声明问题: string[]}>}
   */
  async run(spec = {}) {
    if (!PROBE_RUNNERS.includes(spec.subject?.kind)) {
      throw new Denied('安全类 · 探针巡检的主体闸（§4：机制内置动作，不挂策略引擎——引擎不健康时探针必须照常跑）', `主体 ${spec.subject?.id ?? '（缺席）'}（${spec.subject?.kind ?? '未知'}）无权跑探针：落快照 + 入账是写动作，只有 Lead / 主权者 / 系统能触发。`, {
        requireAuthority: 'Lead',
        howToChange: '由 Lead（根会话）执行 probe_run；成员要探针读数用 probe_health（只读）。',
      });
    }
    const declaration = await this.declare();
    const 结果 = [];
    for (const 探针 of CLOSED_LIST) {
      结果.push(await this.#probe(探针));
    }
    const 见红 = 结果.filter((r) => r.状态 === '红').map((r) => ({ 探针: r.探针, 详情: r.详情 }));
    const 全绿 = 见红.length === 0 && declaration.一致;
    const 代码身份 = mechanismArtifact();
    const ran = {
      机制版本: 代码身份.机制版本,
      代码身份,
      于: this.clock.iso(),
      全绿,
      结果,
      见红,
      声明问题: declaration.问题,
    };
    const 快照 = await this.#snapshot(ran);
    // 快照哈希入账（2026-10-13 裁决第二批 · 裁决3）：快照是回滚目标的唯一来源，
    // 无完整性保护等于回滚面可投毒——哈希进审计链，autoRollback 定位前校验。
    await this.audit.append({
      // 动作名按结果分流：全绿是「巡检」（系统的机制内置动作，见权限矩阵主体表），
      // 见红才是「异常」。全绿也记异常会让动作名与结果语义不符，审计全是噪音。
      动作: 全绿 ? '探针巡检' : '探针异常',
      // 主体记真实触发者（设计评审 #10 · 2026-10-15）：修前恒 {id:'system',kind:'系统'}——
      // 手动 Lead 巡检与机制自动巡检在账上不可分辨。`spec.subject` 已过上方白名单闸
      // （kind ∈ Lead/主权者/系统），机制自动路径传 system 主体，行为不变；手动巡检
      // 从此在账上可分辨。
      主体: spec.subject,
      对象: { id: '红线索兵', kind: '账目' },
      依据: '§4 五道配套：红线索兵 + 留痕 + 可申诉',
      结果: 全绿 ? '全绿' : `见红 ${见红.length} 项：${见红.map((r) => r.探针).join('、')}`,
      告警: !全绿,
      详情: { 机制版本: ran.机制版本, 见红, 声明问题: declaration.问题, 快照 },
    });
    // 必须在本次快照入账后、健康/保留等旁路之前触发；不能让后续巡检或旁路故障吃掉本次红灯。
    const 回滚 = 全绿 ? null : await this.autoRollback(快照);
    // 恒红/恒绿报警接线（2026-10-13 裁决第二批 · P2-10）：§4「恒亮的灯等于没灯」——
    // evaluateHealth 此前只返回结构、无消费点，恒绿可能静默。巡检后现判，恒态 ⇒ 告警入账。
    const 健康 = await this.evaluateHealth();
    if (健康.恒红 || 健康.恒绿) {
      await this.audit.append({
        动作: '探针健康异常',
        // 同一次 run 触发的告警，主体同记真实触发者（设计评审 #10）：谁触发的巡检，
        // 谁对这批快照的恒态负责。
        主体: spec.subject,
        对象: { id: '红线索兵', kind: '账目' },
        依据: '§4 恒红/恒绿都要报警：连续同态 = 检测能力存疑，不是"安全"',
        结果: 健康.状态,
        告警: true,
        详情: { 状态: 健康.状态, 说明: 健康.说明, 连续次数: 健康.最近.length },
      });
    }
    // 快照保留（设计债㉘ · 2026-10-17）：放在**本次巡检的证据（快照+入账）落定之后**——
    // 保留失败不许吞掉它们；但失败也不许静默（required-action-wiring：没跑就硬失败），
    // 直接抛 ⇒ 调用方（工具面/开机自检）按既有口径记「工具调用失败」。清了文件是
    // 自治的破坏性动作，删多少必须入账（无留痕的自治变更 = 无效）。
    const 清理 = await this.#pruneSnapshots();
    if (清理) {
      await this.audit.append({
        动作: '快照保留',
        主体: spec.subject,
        对象: { id: '探针快照', kind: '账目' },
        依据: '设计债㉘（2026-10-17）：探针快照无保留策略无限涨；保留最新 + 永久保护最近全绿（autoRollback 回滚目标）',
        结果: `清了 ${清理.清了} 个最旧快照，目录现存 ${清理.现存} 个`,
        详情: { 触发线: KEEP_SNAPSHOTS, 清理目标: PRUNE_TO, ...清理 },
      });
    }
    return { ...ran, 快照, 回滚 };
  }

  /**
   * 最近一次运行的快照。
   *
   * 工作台的「四盏灯」必须来自**真实跑过的那一次**，而不是现场重跑——
   * 重跑会消耗随机性、也会让看板上的灯与账本里的记录不是同一件事。
   * @returns {Promise<object|null>}
   */
  async latest() {
    const snapshots = await this.#recentSnapshots(1);
    return snapshots[0] ?? null;
  }

  /**
   * 探针健康：恒红或恒绿都要报警。
   * @returns {Promise<{状态: string, 恒红: boolean, 恒绿: boolean, 说明: string, 最近: Array<object>}>}
   */
  async evaluateHealth() {
    const 最近 = await this.#recentSnapshots(STICKY_RUNS);
    if (最近.length < STICKY_RUNS) {
      return { 状态: '样本不足', 恒红: false, 恒绿: false, 说明: `只有 ${最近.length} 次记录，还不能判断恒红/恒绿。`, 最近 };
    }
    const 恒红 = 最近.every((s) => s.全绿 === false);
    const 恒绿 = 最近.every((s) => s.全绿 === true);
    const 状态 = 恒红 ? '恒红' : 恒绿 ? '恒绿' : '正常';
    return {
      状态,
      恒红,
      恒绿,
      说明: 恒红
        ? '探针连续见红：这不是"安全"，这是闸坏了没人管。'
        : 恒绿
          ? '探针连续全绿：恒亮的灯等于没灯——可能是探针失去检测能力，必须人工校验。'
          : '探针有红有绿，工作正常。',
      最近,
    };
  }

  /**
   * 探针红 ⇒ 自动回滚：**定位**「探针全绿的最近一版」＋无条件**入账**＋告警并**升级主权者**。
   *
   * 定性（§4，甲′裁决 2026-10-09）：这是**策略引擎内置行为**，因此**入账**无条件 ——
   * 不问策略引擎要许可，也不因为主权者失联而暂停。它回滚的是**机制**，不是文本。
   * 执行面（甲′）：运行态**不自动改文件、不自建回滚制品**——回滚制品＝git/包版本（开发仓），
   * 装回全绿版本由主权者经版本管理执行；这里只定位目标并入账，不假装执行过（F2）。
   *
   * @param {{名: string, 哈希: string}} [reference] 内部巡检传本次已落快照；工具面不接此参数。
   * @returns {Promise<object>} 定位/未知/拒绝的可读结果；副作用仅无条件审计告警，审计或定位故障抛出。
   */
  async autoRollback(reference) {
    let result = { 执行: false, 已定位: false, 目标版本: null, 可恢复: '不可确定', 制品来源: null, 状态: '不可确定', 原因: '' };
    let failure = null;
    try {
      if (!reference) {
        const rows = await this.audit.read({});
        reference = rows.filter((r) => ['探针巡检', '探针异常'].includes(r.动作)).at(-1)?.详情?.快照;
      }
      const latest = reference
        ? await readJsonOrNull(`${this.layout.probeSnapshotDir()}/${reference.名}`)
        : null;
      if (!latest) {
        result.原因 = '触发快照缺失：无法确定红灯或回滚目标，升级主权者核查。';
      } else {
        const checked = await this.#verifySnapshotIntegrity(latest, reference);
        if (!checked.ok) {
          result.状态 = '拒绝定位';
          result.原因 = `快照完整性存疑（${checked.原因}），不定位，升级主权者核查。`;
        } else if (latest.全绿 === true) {
          return { ...result, 状态: '无需定位', 原因: '本次探针全绿，没有回滚的必要。' };
        } else {
          result.触发快照 = { 名: checked.名, 哈希: checked.哈希 };
          const rows = await this.audit.read({});
          const index = rows.findLastIndex((r) => ['探针巡检', '探针异常'].includes(r.动作) && r.详情?.快照?.名 === checked.名 && r.详情.快照.哈希 === checked.哈希);
          if (index < 0) throw new Error('本次快照的审计凭据消失');
          // 审计提交序决定“之前”，而非全局latest或同秒随机文件名序；后续绿/红都不能替换触发者。
          const candidate = rows.slice(0, index).reverse().find((r) => r.动作 === '探针巡检' && r.详情?.快照);
          if (!candidate) {
            result.原因 = '历史里没有任何已入账全绿快照，回滚无目标，升级主权者。';
          } else {
            const targetRef = candidate.详情.快照;
            const target = await readJsonOrNull(`${this.layout.probeSnapshotDir()}/${targetRef.名}`);
            const targetCheck = target ? await this.#verifySnapshotIntegrity(target, targetRef) : { ok: false, 原因: '全绿目标快照已丢失' };
            if (!targetCheck.ok || target.全绿 !== true) {
              result.状态 = '拒绝定位';
              result.原因 = `回滚目标快照完整性存疑（${targetCheck.原因 ?? '全绿标记不符'}），升级主权者。`;
            } else if (target.代码身份?.状态 !== '已核代码身份' || !target.机制版本 || target.代码身份.机制版本 !== target.机制版本) {
              result.原因 = '历史全绿快照缺代码身份/制品凭据（含boot及声明哈希旧标签）；不能倒灌当前身份或认定可恢复，升级主权者。';
              result.历史标签 = target.机制版本 ?? null;
            } else {
              result = { ...result, 状态: '已定位代码身份', 已定位: true, 目标版本: target.机制版本, 目标快照: targetRef, 包名: target.代码身份.包名, 包版本: target.代码身份.包版本,
                原因: `已定位回滚目标 ${target.机制版本}（全绿最近一版的代码身份），入账并升级主权者；没有精确git/包制品出处，可恢复性不可确定。运行态不自动改文件、不自建回滚制品，装回由主权者经版本管理执行。` };
            }
          }
        }
      }
    } catch (error) {
      failure = error;
      result.状态 = '定位失败';
      result.原因 = `回滚定位失败：${error instanceof Error ? error.message : String(error)}；升级主权者核查。`;
    }
    // 包括未知、拒绝与读取异常，均必须审计告警；审计失败直接抛，不得伪报“已入账”。
    await this.audit.append({
      动作: '自动回滚', 主体: { id: 'system', kind: '系统' }, 对象: { id: '机制版本', kind: '账目' },
      依据: '§4 甲′：定位全绿最近一版＋无条件入账＋告警升级主权者；运行态不自动改文件、不自建回滚制品',
      结果: result.原因, 告警: true, 详情: { ...result, 触发快照: result.触发快照 ?? reference ?? null, 升级: '主权者' },
    });
    if (failure) throw new Error(result.原因, { cause: failure });
    return result;
  }

  /**
   * 影响面声明：每次强更必须声明动了哪些检测逻辑（§4 五道配套之一）。
   * @returns {Promise<object>} 真实代码文件差异，不从相同探针名称推断“实现未改”；无基线则未知。只读。
   */
  async impactStatement() {
    const 当前 = mechanismArtifact();
    const snapshots = await this.#recentSnapshots(Number.MAX_SAFE_INTEGER);
    const previous = snapshots.filter((s) => s.代码身份?.状态 === '已核代码身份' && s.机制版本 !== 当前.机制版本).pop();
    if (当前.状态 !== '已核代码身份' || !previous) {
      return { 机制版本: 当前.机制版本, 状态: '不可确定', 动了: [], 未动: [], 声明: '代码身份或上一个不同版本的代码清单缺失，检测逻辑影响面不可确定；相同探针声明不证明实现未变。' };
    }
    const before = new Map(previous.代码身份.文件.map((f) => [f.路径, f.SHA256]));
    const after = new Map(当前.文件.map((f) => [f.路径, f.SHA256]));
    const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
    const 动了 = paths.filter((p) => before.get(p) !== after.get(p));
    const 未动 = paths.filter((p) => before.get(p) === after.get(p));
    return { 机制版本: 当前.机制版本, 状态: '已核代码差异', 动了, 未动, 声明: `代码文件差异 ${动了.length} 项（不是逻辑语义等价证明）；探针本身受安全类保护。` };
  }

  // ── 探针实现 ────────────────────────────────────────────────────────────────

  /** @param {string} 探针 */
  async #probe(探针) {
    try {
      switch (探针) {
        case '审计链':
          return await this.#auditChain();
        case '闸在位':
          return this.#gatePresent();
        case '出厂件洁净':
          return await this.#factoryClean();
        case '撤回名单一致':
          return await this.#denylistConsistent();
        default:
          return { 探针, 状态: '红', 详情: `清单外的探针「${探针}」没有实现——安全类不许兜底。` };
      }
    } catch (error) {
      // 探针自己坏了也必须响亮：这就是「安全闸静默失败」要防的那件事。
      return { 探针, 状态: '红', 详情: `探针执行故障：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /** 审计被篡改 ⇒ 见红。已确认瑕疵（更正声明闭环）不计断裂，但要在读数里报数。 */
  async #auditChain() {
    const verified = await this.audit.verify();
    const 瑕疵 = verified.已确认瑕疵?.length ? `；已确认瑕疵 ${verified.已确认瑕疵.length} 处（${verified.已确认瑕疵.map((x) => `${x.month}#${x.seq}`).join('、')}，更正声明已入链）` : '';
    return {
      探针: '审计链',
      状态: verified.ok ? '绿' : '红',
      详情: verified.ok
        ? `链完整：${verified.months} 个月分片 / ${verified.entries} 条记录${瑕疵}`
        : `链断了 ${verified.broken.length} 处：${JSON.stringify(verified.broken.slice(0, 3))}${瑕疵}`,
    };
  }

  /**
   * 防护机制被关闭 ⇒ 见红。闸不在位就是最严重的一种见红。
   * R06（审查 2026-10-16）：不再只看策略对象——宿主工具闸（范围闸/调度创建闸）的**真实
   * 注册回执**（layout.guardReceiptFile()，内核装配时落盘）也进本探针。修前定向注入注册
   * 异常后 guards=0、mind 工具照常在、策略 healthy=true，本探针照样绿（审查实证：最需要
   * 红灯的时候它绿着）。回执跨 org 实例走文件（内核与 guard 组件各持一个装配实例）；
   * 文件缺席 = 本部署没有内核装配过（纯服务夹具/命令面）——如实标注，不误红也不装懂。
   */
  async #gatePresent() {
    const described = this.policy.describe();
    const ok = described.healthy && described.rules.length > 0 && this.policy.state.ok === true;
    const 回执 = await readJsonOrNull(this.layout.guardReceiptFile());
    let 工具闸句 = null;
    let 工具闸红 = false;
    if (回执 && typeof 回执 === 'object') {
      // P1-04（全面审查 2026-10-17）：修前只有 registered===false 才红，回执缺席/
      // 未尝试/旧回执全绿——「不知道」被当成「安全」。回执是内核装配的机械读数：
      // 缺项、未确认（registered 不是严格 true）、显式失败，三者任一都按红处理；
      // 只有每个应有闸都 registered===true 才是绿。
      const 应有 = ['范围闸', '调度创建闸'];
      const 缺项 = 应有.filter((名) => !回执[名]);
      const 失败 = Object.entries(回执).filter(([, r]) => r?.registered === false);
      const 未确认 = Object.entries(回执).filter(([, r]) => !r || r.registered !== true);
      const 已注册 = Object.entries(回执).filter(([, r]) => r?.registered === true);
      工具闸红 = 缺项.length > 0 || 失败.length > 0 || 未确认.length > 0;
      const 句们 = [];
      if (失败.length) 句们.push(`工具闸注册失败：${失败.map(([名, r]) => `${名}（${r.error ?? '未知原因'}）`).join('、')}`);
      if (未确认.length) 句们.push(`工具闸未确认：${未确认.map(([名, r]) => `${名}（registered=${r?.registered ?? '缺'}）`).join('、')}`);
      if (缺项.length) 句们.push(`工具闸回执缺项：${缺项.join('、')}`);
      if (已注册.length) 句们.push(`${已注册.map(([名]) => 名).join('、')} 已注册`);
      工具闸句 = 句们.join('；');
    } else if (this.无内核装配) {
      // 纯服务夹具/命令面：没有内核装配就没有回执，必须由夹具**显式声明**；
      // 缺省不猜（缺省按红），否则「没装内核」会被静默读成「闸在位」。
      工具闸句 = '无内核装配（纯服务夹具显式声明）：工具闸回执不在可观测面';
    } else {
      工具闸红 = true;
      工具闸句 = '工具闸回执缺失：当前装配无法证明闸在位（未知 ≠ 绿）';
    }
    return {
      探针: '闸在位',
      状态: ok && !工具闸红 ? '绿' : '红',
      详情: [
        ok ? `策略引擎在位：${described.rules.length} 条规则，加载于 ${described.loadedAt}` : `闸不在位：healthy=${described.healthy}，规则数=${described.rules.length}，错误=${described.error ?? '无'}`,
        工具闸句,
      ].join('；'),
    };
  }

  /** 出厂件含用户特定信息（或私有区有外流口） ⇒ 见红。 */
  async #factoryClean() {
    const hits = [];
    const files = await listFiles(this.layout.factoryRoot, { recursive: true, filter: (n) => /\.(md|json|yml|yaml|txt)$/.test(n) });
    for (const rel of files) {
      const text = await readTextOrNull(`${this.layout.factoryRoot}/${rel}`);
      if (text === null) continue;
      for (const [名称, pattern] of SENSITIVE_PATTERNS) {
        const m = pattern.exec(text);
        if (m) hits.push({ 文件: rel, 类型: 名称, 片段: mask(m[0]) });
      }
    }
    return {
      探针: '出厂件洁净',
      状态: hits.length === 0 ? '绿' : '红',
      详情: hits.length === 0 ? `扫过 ${files.length} 个出厂文件：不含用户特定信息` : `发现 ${hits.length} 处：${JSON.stringify(hits.slice(0, 3))}`,
    };
  }

  /** 撤回名单与卡的实际存在性一致 ⇒ 见红（§3 不可逆：名单删卡 = 记录消失）。 */
  async #denylistConsistent() {
    const identity = await readJsonOrNull(this.layout.identityFile());
    const list = identity?.denylist ?? [];
    if (list.length === 0) return { 探针: '撤回名单一致', 状态: '绿', 详情: '拒绝名单为空。' };
    const 缺失 = [];
    for (const entry of list) {
      const found = await findCard(this.layout, entry.id);
      if (!found) 缺失.push(entry.id);
    }
    return {
      探针: '撤回名单一致',
      状态: 缺失.length === 0 ? '绿' : '红',
      详情: 缺失.length === 0 ? `拒绝名单 ${list.length} 项，卡都还在盘上（撤回不删卡）` : `名单里的 ${缺失.join('、')} 已经找不到卡：撤回变成了删除。`,
    };
  }

  // ── 快照 ────────────────────────────────────────────────────────────────────

  /**
   * @param {object} ran
   * @returns {Promise<{名: string, 哈希: string}>} 快照文件名与内容哈希（入账供 autoRollback 校验）
   */
  async #snapshot(ran) {
    const dir = this.layout.probeSnapshotDir();
    await ensureDirPath(dir);
    // 文件名补毫秒与随机段（2026-10-14 审查 P1-7）：ran.于 是秒级 ISO（toIso 剥了毫秒），
    // 机制版本不变时同秒两次巡检同名 ⇒ atomicWrite 静默覆盖 ⇒ 审计里两行「探针巡检」
    // 同名不同哈希 ⇒ 快照完整性校验见红 ⇒ autoRollback 拒绝定位——回滚机制会被自己的
    // 命名碰撞毒化。
    const name = `${ran.于.replace(/[:.]/g, '-')}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}-${shortHash(ran.机制版本 ?? 'unknown', 6)}.json`;
    const text = `${JSON.stringify(ran, null, 2)}\n`;
    await atomicWrite(`${dir}/${name}`, text);
    // 内容哈希（裁决3）：按盘上字节算——校验侧对同一文件复算，两边同源。
    return { 名: name, 哈希: shortHash(text, 16) };
  }

  /**
   * 快照保留（设计债㉘ · 2026-10-17）：按名序（≈时间序，文件名以 ISO 时刻打头）保留
   * 最新 PRUNE_TO 个；**「最近全绿」永不在清理之列**——它是 autoRollback「定位全绿的
   * 最近一版」的唯一目标来源（裁决3 的完整性校验还要求盘上文件与审计哈希对得上），
   * 保留策略不许吃掉回滚目标。超限才动手（KEEP_SNAPSHOTS 触发线 + 滞回）；失败不吞。
   * @returns {Promise<{清了: number, 现存: number}|null>} 没超限 ⇒ null（不动盘）
   */
  async #pruneSnapshots() {
    const dir = this.layout.probeSnapshotDir();
    const files = (await listFiles(dir, { recursive: false, filter: (n) => n.endsWith('.json') })).sort();
    if (files.length <= KEEP_SNAPSHOTS) return null;
    const keep = new Set(files.slice(-PRUNE_TO));
    // 找「最近全绿」：autoRollback 只会取它（.reverse().find(全绿)），护住这一个就够。
    for (let i = files.length - 1; i >= 0; i -= 1) {
      const snap = await readJsonOrNull(`${dir}/${files[i]}`);
      if (snap?.全绿 === true) {
        keep.add(files[i]);
        break;
      }
    }
    const 清理 = files.filter((name) => !keep.has(name));
    for (const name of 清理) await unlink(`${dir}/${name}`);
    return { 清了: 清理.length, 现存: keep.size };
  }

  /** @param {number} limit */
  async #recentSnapshots(limit) {
    const dir = this.layout.probeSnapshotDir();
    const files = (await listFiles(dir, { recursive: false, filter: (n) => n.endsWith('.json') })).sort();
    const 选 = files.slice(-limit);
    const out = [];
    for (const name of 选) {
      const snap = await readJsonOrNull(`${dir}/${name}`);
      if (snap) out.push(snap);
    }
    return out;
  }

  /**
   * 快照完整性校验（裁决3）：给定快照对象，找到盘上对应文件，复算内容哈希并与
   * 审计「探针巡检/异常」行入账的哈希比对。不符 / 找不到入账 ⇒ 不 ok（fail-closed）。
   * @param {object} snap
   * @returns {Promise<{ok: boolean, 原因?: string, 名?: string, 哈希?: string}>}
   */
  async #verifySnapshotIntegrity(snap, reference) {
    const dir = this.layout.probeSnapshotDir();
    const files = reference ? [reference.名] : (await listFiles(dir, { recursive: false, filter: (n) => n.endsWith('.json') })).sort();
    const 正文 = `${JSON.stringify(snap, null, 2)}\n`;
    let 名 = null;
    for (const f of files) {
      const t = await readTextOrNull(`${dir}/${f}`);
      if (t !== null && t === 正文) { 名 = f; break; }
    }
    if (!名) return { ok: false, 原因: '盘上找不到与该快照逐字节一致的文件（内容已被改动或已丢失）' };
    const 哈希 = shortHash(正文, 16);
    if (reference && reference.哈希 !== 哈希) return { ok: false, 原因: '本次绑定快照哈希不符' };
    const rows = await this.audit.read({});
    const 记录 = rows.filter((r) => ['探针巡检', '探针异常'].includes(r.动作) && r.详情?.快照?.名 === 名).at(-1);
    if (!记录) return { ok: false, 原因: `账上没有快照 ${名} 的入账哈希（入账缺失或早于裁决3的旧快照）` };
    if (记录.详情.快照.哈希 !== 哈希) {
      return { ok: false, 原因: `哈希不符：账上 ${记录.详情.快照.哈希}，盘上复算 ${哈希}` };
    }
    return { ok: true, 名, 哈希 };
  }
}

/** 用户数据 / 凭据外泄的检测面。模式写得具体，避免把正常文本误判成泄漏。 */
const SENSITIVE_PATTERNS = [
  // 正反斜杠两种写法都要拦（2026-10-13 审查 P2-21）：Node 生态里 `C:/Users/kuro/...` 极常见，
  // 修前只匹配反斜杠写法 ⇒ 正斜杠路径完全漏过。
  ['绝对用户路径（反斜杠）', /[A-Za-z]:\\Users\\[^\\\s"']+/u],
  ['绝对用户路径（正斜杠）', /[A-Za-z]:\/Users\/[^\s"']+/u],
  ['POSIX 用户路径', /\/Users\/[A-Za-z0-9._-]+\//u],
  ['Linux 家目录路径', /\/home\/[A-Za-z0-9._-]+\//u],
  ['疑似密钥', /\bsk-[A-Za-z0-9]{16,}\b/u],
  ['Bearer 令牌', /Bearer\s+[A-Za-z0-9._-]{20,}/u],
];

/** @param {string} text */
function mask(text) {
  if (text.length <= 8) return '***';
  return `${text.slice(0, 4)}***${text.slice(-2)}`;
}

/**
 * 按 id 找「撤回名单一致」探针要核对的卡：两区（私有/出厂）× 三类对象（规则件+角色卡+能力卡）。
 * 候选集与升级比对（upgrade.#resolve）**同一份实现**（设计评审 #11 · 2026-10-15）：
 * 修前这里漏了能力卡——撤回一张能力卡后 `registry.revoke` 照实写了拒绝名单（撤回不删卡），
 * 探针却按「规则件+角色卡」找，找不到 ⇒ 把一次合法撤回误报成「撤回变成删除」（见红）。
 * 落点选在 upgrade.js 导出 `按id找卡`：两处共用一份候选集，谁的清单多一类对象都是同一处改。
 * @param {import('./paths.js').Layout} layout @param {string} id
 */
async function findCard(layout, id) {
  return (await 按id找卡(layout, id, '私有')) ?? (await 按id找卡(layout, id, '出厂'));
}
