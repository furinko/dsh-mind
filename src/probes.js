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
import { shortHash } from './kernel/ids.js';
import { Denied } from './kernel/errors.js';
// 「按 id 找卡」的共享实现（设计评审 #11 · 2026-10-15）：撤回名单探针与升级比对此前
// 各有一份候选集（探针版漏了能力卡 ⇒ 撤回一张能力卡会被误报成「撤回变成删除」）。
// import 图无环：upgrade 只 import kernel/paths，不依赖本文件。
import { 按id找卡 } from './upgrade.js';

/** 封闭清单。新增一项要改这里 + 出厂声明，二者不一致就是故障。 */
export const CLOSED_LIST = ['审计链', '闸在位', '出厂件洁净', '撤回名单一致'];

/** 连续多少次同色才算「恒」。太短会把偶发抖动报成故障。 */
const STICKY_RUNS = 3;

/**
 * 探针巡检的主体白名单（2026-10-12 评审 P1-8）。**不挂策略引擎**：探针必须在引擎
 * 不健康时照常跑（「闸不在位」正是为它点的灯）；kind 由会话事实链供给，自报不到。
 */
const PROBE_RUNNERS = ['Lead', '主权者', '系统'];

export class ProbeRunner {
  /**
   * @param {{ layout: import('./paths.js').Layout, policy: import('./policy.js').PolicyEngine, audit: import('./audit.js').AuditLog, clock: import('./kernel/time.js').Clock, capability?: object }} spec
   */
  constructor(spec) {
    this.layout = spec.layout;
    this.policy = spec.policy;
    this.audit = spec.audit;
    this.clock = spec.clock;
    this.capability = spec.capability ?? null;
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
   * 「机制版本」恒由声明文件现算（`#mechanismVersion`）；`spec.机制版本` 只余装配/测试通道
   * （开机自检的 'boot'、测试造版本差），动作面已不可达——快照是回滚目标的唯一来源，
   * 自报标签 = 回滚目标投毒。
   *
   * @param {{ subject: object, 机制版本?: string }} spec
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
    const ran = {
      机制版本: spec.机制版本 ?? (await this.#mechanismVersion()),
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
    return ran;
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
   * @returns {Promise<{执行: boolean, 已定位?: boolean, 目标版本: string|null, 原因: string}>}
   */
  async autoRollback() {
    const snapshots = await this.#recentSnapshots(Number.MAX_SAFE_INTEGER);
    const latest = snapshots[snapshots.length - 1];
    if (!latest || latest.全绿) {
      return { 执行: false, 目标版本: null, 原因: '最新一次探针全绿，没有回滚的必要。' };
    }
    // 快照完整性校验（2026-10-13 裁决第二批 · 裁决3）：快照是无哈希普通 JSON，改一份
    // 历史「全绿+版本X」即可把回滚目标定位到伪造版本（投毒面）。修法：定位出的目标快照
    // 与账上「探针巡检/异常」行记录的内容哈希比对——不符 ⇒ 告警 + 拒绝定位（fail-closed）。
    const 校验 = await this.#verifySnapshotIntegrity(latest);
    if (!校验.ok) {
      await this.audit.append({
        动作: '自动回滚',
        主体: { id: 'system', kind: '系统' },
        对象: { id: '机制版本', kind: '账目' },
        依据: '§4 快照完整性校验（裁决第二批·裁决3）：回滚目标与审计入账哈希不符 = 投毒嫌疑，拒绝定位',
        结果: `最新快照完整性校验失败：${校验.原因}——不定位回滚目标，升级主权者核查`,
        告警: true,
        详情: { 校验 },
      });
      return { 执行: false, 目标版本: null, 原因: `快照完整性存疑（${校验.原因}），已告警并升级主权者；不定位回滚目标。` };
    }
    // 关键：不是「上一版」，是「**全绿的最近一版**」——中间可能隔着好几版见红。
    const 目标 = [...snapshots].reverse().find((s) => s.全绿 === true);
    if (!目标) {
      await this.audit.append({
        动作: '自动回滚',
        主体: { id: 'system', kind: '系统' },
        对象: { id: '机制版本', kind: '账目' },
        依据: '§4 探针红 ⇒ 自动回滚（甲′裁决 2026-10-09：定位全绿最近一版＋无条件入账＋告警升级主权者；执行面归主权者经版本管理装回）',
        结果: '找不到任何全绿版本：无回滚目标可定位，保持见红并升级主权者',
        告警: true,
        详情: { 见红: latest.见红 },
      });
      return { 执行: false, 目标版本: null, 原因: '历史里没有任何全绿快照，回滚无目标；已入账并升级主权者。' };
    }
    // 口径如实（F2 + 甲′裁决 2026-10-09）：运行态不自动改文件、不自建回滚制品——
    // 回滚制品＝git/包版本（开发仓），装回全绿版本由主权者经版本管理执行。
    // 这里只「定位目标并入账」，不许审计里出现「版本 x → 版本 y」这种像真回滚过的写法。
    // 回滚目标快照同样过完整性校验（裁决3）：目标被改过 = 定位到伪造版本，同拒。
    const 目标校验 = await this.#verifySnapshotIntegrity(目标);
    if (!目标校验.ok) {
      await this.audit.append({
        动作: '自动回滚',
        主体: { id: 'system', kind: '系统' },
        对象: { id: '机制版本', kind: '账目' },
        依据: '§4 快照完整性校验（裁决第二批·裁决3）：回滚目标与审计入账哈希不符 = 投毒嫌疑，拒绝定位',
        结果: `回滚目标快照完整性校验失败：${目标校验.原因}——不定位，升级主权者核查`,
        告警: true,
        详情: { 校验: 目标校验, 候选目标: 目标.机制版本 },
      });
      return { 执行: false, 目标版本: null, 原因: `回滚目标快照完整性存疑（${目标校验.原因}），已告警并升级主权者。` };
    }
    await this.audit.append({
      动作: '自动回滚',
      主体: { id: 'system', kind: '系统' },
      对象: { id: '机制版本', kind: '账目' },
      依据: '§4 探针红 ⇒ 自动回滚：定位探针全绿的最近一版＋无条件入账＋告警升级主权者（甲′裁决 2026-10-09）',
      结果: `已定位回滚目标 ${目标.机制版本}（${latest.机制版本} 见红），入账并升级主权者；运行态不自动改文件，装回全绿版本由主权者经版本管理（git/包版本）执行`,
      告警: true,
      详情: { 回滚目标: 目标.机制版本, 目标于: 目标.于, 见红: latest.见红, 定性: '策略引擎内置行为：无条件入账；运行态不自动改文件，回滚制品＝git/包版本，执行面归主权者（甲′裁决 2026-10-09）' },
    });
    return { 执行: false, 已定位: true, 目标版本: 目标.机制版本, 原因: '探针见红，已定位全绿的最近一版（不是紧邻上一版）并入账升级主权者；运行态不自动改文件——装回全绿版本由主权者经版本管理（git/包版本）执行。' };
  }

  /**
   * 影响面声明：每次强更必须声明动了哪些检测逻辑（§4 五道配套之一）。
   * @param {{ 机制版本: string }} spec
   * @returns {Promise<{机制版本: string, 动了: string[], 未动: string[], 声明: string}>}
   */
  async impactStatement(spec) {
    const snapshots = await this.#recentSnapshots(Number.MAX_SAFE_INTEGER);
    const previous = snapshots.filter((s) => s.机制版本 !== spec.机制版本).pop();
    const 当前 = await this.declare();
    const before = new Set(previous?.结果?.map((r) => r.探针) ?? []);
    const 动了 = 当前.声明.filter((name) => !before.has(name));
    const 未动 = 当前.声明.filter((name) => before.has(name));
    return {
      机制版本: spec.机制版本,
      动了,
      未动,
      声明: 动了.length
        ? `本版改动了检测逻辑：${动了.join('、')}。探针本身受安全类保护，强更不能绕过它。`
        : '本版未改动检测逻辑（对比上一个有快照的机制版本）。',
    };
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

  /** 防护机制被关闭 ⇒ 见红。闸不在位就是最严重的一种见红。 */
  #gatePresent() {
    const described = this.policy.describe();
    const ok = described.healthy && described.rules.length > 0 && this.policy.state.ok === true;
    return {
      探针: '闸在位',
      状态: ok ? '绿' : '红',
      详情: ok
        ? `策略引擎在位：${described.rules.length} 条规则，加载于 ${described.loadedAt}`
        : `闸不在位：healthy=${described.healthy}，规则数=${described.rules.length}，错误=${described.error ?? '无'}`,
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
    const name = `${ran.于.replace(/[:.]/g, '-')}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}-${shortHash(ran.机制版本, 6)}.json`;
    const text = `${JSON.stringify(ran, null, 2)}\n`;
    await atomicWrite(`${dir}/${name}`, text);
    // 内容哈希（裁决3）：按盘上字节算——校验侧对同一文件复算，两边同源。
    return { 名: name, 哈希: shortHash(text, 16) };
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

  /** 机制版本：以探针声明文件的内容哈希为准（改了声明就是换了机制）。 */
  async #mechanismVersion() {
    const text = (await readTextOrNull(this.layout.probeDeclaration())) ?? '';
    return shortHash(text, 12);
  }

  /**
   * 快照完整性校验（裁决3）：给定快照对象，找到盘上对应文件，复算内容哈希并与
   * 审计「探针巡检/异常」行入账的哈希比对。不符 / 找不到入账 ⇒ 不 ok（fail-closed）。
   * @param {object} snap
   * @returns {Promise<{ok: boolean, 原因?: string, 名?: string, 哈希?: string}>}
   */
  async #verifySnapshotIntegrity(snap) {
    const dir = this.layout.probeSnapshotDir();
    const files = (await listFiles(dir, { recursive: false, filter: (n) => n.endsWith('.json') })).sort();
    const 正文 = `${JSON.stringify(snap, null, 2)}\n`;
    let 名 = null;
    for (const f of files) {
      const t = await readTextOrNull(`${dir}/${f}`);
      if (t !== null && t === 正文) { 名 = f; break; }
    }
    if (!名) return { ok: false, 原因: '盘上找不到与该快照逐字节一致的文件（内容已被改动或已丢失）' };
    const 哈希 = shortHash(正文, 16);
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
