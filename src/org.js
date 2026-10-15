/**
 * 组装：把八件基础设施接成一个组织（唯一入口）。
 *
 * 为什么要有这一层：宿主插件只跟 `Org` 说话。装配点只有一个，
 * 于是「谁依赖谁」是显式的、可测的；散在各处的 `new` 会让「重启后可重建」变成空话。
 *
 * 首次打开时会**引导私有区**（建目录、落身份档案、上基线戳），
 * 但绝不触碰出厂区——出厂区是只读模板。
 */
import { ensureDirPath, exists, listDirs, listFiles } from './kernel/fsx.js';
import { dirname } from 'node:path';
import { Clock } from './kernel/time.js';
import { defaultLayout, DIR } from './paths.js';
import { AuditLog } from './audit.js';
import { PolicyEngine, DEFAULT_ROLE_IDLE_DAYS } from './policy.js';
import { ObjectStore } from './store.js';
import { TaskGraph } from './tasks.js';
import { MessageBus } from './bus.js';
import { MemoryService } from './memory.js';
import { CapabilityLibrary } from './capability.js';
import { RoleRegistry } from './registry.js';
import { UpgradeManager } from './upgrade.js';
import { ProbeRunner } from './probes.js';
import { ReviewProtocol } from './review.js';
import { DebateService } from './debate.js';
import { projectWorkbench, sliceForViewer } from './workbench.js';

/** 默认项目键。名字即目录名（§14.4-5）。 */
export const DEFAULT_PROJECT = 'default';

export class Org {
  /**
   * @param {{ layout: import('./paths.js').Layout, clock: Clock, audit: AuditLog, policy: PolicyEngine, store: ObjectStore,
   *           tasks: TaskGraph, bus: MessageBus, memory: MemoryService, capability: CapabilityLibrary, registry: RoleRegistry,
   *           upgrade: UpgradeManager, probes: ProbeRunner, review: ReviewProtocol,
   *           project: string, logger?: object }} parts
   */
  constructor(parts) {
    Object.assign(this, parts);
    /** 引导结果，供工具自述用。 */
    this.boot = { 已引导: false, 新建目录: [], 上基线: null };
  }

  /**
   * 组装 + 引导。
   *
   * @param {{ home: string, factoryRoot: string, privateRoot?: string, project?: string, logger?: object, random?: () => number }} spec
   * @returns {Promise<Org>}
   */
  static async open(spec) {
    const layout = defaultLayout({ home: spec.home, factoryRoot: spec.factoryRoot, privateRoot: spec.privateRoot });
    const clock = new Clock();
    const audit = new AuditLog({ layout, clock });
    const policy = new PolicyEngine({ layout, clock, audit });
    await policy.reload();

    const store = new ObjectStore({ layout, policy, audit, clock });
    // registry 先建、再交给 tasks（派活闭环 2026-10-15）：dispatch/reassign 的派发闸要按
    // 「在册在岗实例」核负责人——与 review 池化排班、debate 候选池同一条接线纪律：
    // 身份档案是唯一事实源，不许在任务图里再读一遍。
    const registry = new RoleRegistry({ layout, policy, audit, clock });
    // memory 先建、再交给 tasks（W3 批3）：结账（tasks.settle）要归档该项目的作答，
    // 而归档逻辑只有一处（MemoryService.archiveAnswers）——不在任务图里再写一份。
    const memory = new MemoryService({ layout, policy, audit, clock });
    const tasks = new TaskGraph({ layout, policy, audit, clock, memory, registry });
    const bus = new MessageBus({ layout, policy, audit, clock, tasks });
    const capability = new CapabilityLibrary({ layout, policy, audit, clock, store });
    const upgrade = new UpgradeManager({ layout, policy, audit, clock });
    const probes = new ProbeRunner({ layout, policy, audit, clock, capability });
    // registry 注入 review（2026-10-14 · 池化排班）：提名路由（池内派单/池外待决）要按
    // 「在册在岗复核员」分池——身份档案是唯一事实源，与 debate 候选池同一条接线纪律。
    const review = new ReviewProtocol({ layout, policy, audit, clock, tasks, bus, registry, random: spec.random });
    // registry 也注入 debate（⑮ 强制反对者·2026-10-10）：开启讨论时要按「身份档案成员」
    // 算候选池，而「在岗/封存」的唯一事实源就是角色注册表——不许在 debate 里再读一遍身份档案。
    const debate = new DebateService({ layout, policy, audit, clock, tasks, bus, review, registry });

    const org = new Org({
      layout,
      clock,
      audit,
      policy,
      store,
      tasks,
      bus,
      memory,
      capability,
      registry,
      upgrade,
      probes,
      review,
      debate,
      project: spec.project ?? DEFAULT_PROJECT,
      logger: spec.logger ?? console,
    });
    await org.bootstrap();
    return org;
  }

  /**
   * 引导私有区。幂等：已有的东西一律不动。
   * @returns {Promise<{已引导: boolean, 新建目录: string[], 上基线: string|null}>}
   */
  async bootstrap() {
    const dirs = [
      dirname(this.layout.rulePath('宪章', '私有')),
      dirname(this.layout.rulePath('协作协议', '私有')),
      this.layout.private(DIR.集体结构),
      this.layout.private(DIR.角色卡),
      this.layout.private(DIR.基础设施, DIR.角色注册表),
      this.layout.private(DIR.基础设施, DIR.任务图, this.project),
      this.layout.private(DIR.基础设施, DIR.消息总线, this.project),
      this.layout.private(DIR.基础设施, DIR.能力库),
      this.layout.memoryDir(DIR.跨项目),
      this.layout.memoryDir(this.project),
      this.layout.auditDir(),
      this.layout.private(DIR.升级, '探针快照'),
      this.layout.pendingDir(),
      this.layout.private(DIR.版本历史),
      this.layout.private(DIR.身份档案),
    ];
    const 新建目录 = [];
    for (const dir of dirs) {
      if (!(await exists(dir))) 新建目录.push(dir);
      await ensureDirPath(dir);
    }

    // 身份档案缺失时补一份：主权者「启动了这个部署」就是它的第一次交互，
    // 否则失联会从第一天起把自治档全部冻住。
    if (!(await exists(this.layout.identityFile()))) {
      await this.registry.markInteraction({});
    }
    await this.registry.sync();

    let 上基线 = null;
    if (!(await exists(this.layout.baselineFile()))) {
      上基线 = (await this.upgrade.stamp({ 版本: '1.0.0' })).版本;
    }

    this.boot = { 已引导: true, 新建目录, 上基线 };
    // 引导会新增身份档案，而策略引擎在引导前就已加载过：不重载的话，
    // 引擎眼里的「最后一次交互」仍是 null，于是失联会从第一天起冻住自治档。
    await this.policy.reload();
    return this.boot;
  }

  /**
   * 工作台投影。给读者前先按身份切片——成员只读自己任务那片。
   *
   * @param {{ 读者?: object, 项目?: string, 审计条数?: number }} [spec]
   * @returns {Promise<object>}
   */
  async workbench(spec = {}) {
    const 项目 = spec.项目 ?? this.project;
    const snapshot = await this.tasks.snapshot({ 项目 });
    const views = await this.#views(项目, spec.审计条数 ?? 20);
    const 健康 = await this.probes.evaluateHealth();
    const 最近一次 = await this.probes.latest();
    // 会审讨论段（W2）：有「讨论」子状态的节点，把它线程（=节点id）的当前消息
    // 喂给纯投影——投影自己算 本轮消息数/可收敛提示，本层只取数（readRaw：内部读，
    // 过闸与留痕属于编排动作，不属于投影取数）。
    const 讨论消息 = {};
    for (const n of snapshot.节点) {
      if (n.讨论) 讨论消息[n.id] = await this.bus.readRaw({ 项目, 线程: n.id });
    }
    // ⑦（2026-10-11）：消息总线投影——全部线程的规模 + 最新消息 + 未投递数。
    // summary 内部走 readRaw（免审计，设计债③）：与 讨论消息 同一条投影取数口径。
    const 线程汇总 = await this.bus.summary({ 项目 });
    // 判活读数（派活闭环 2026-10-15）：身份档案只读一次，喂 实例计数 / 岗位闲置 / 实例活动 三块。
    const identity = await this.registry.identity();
    const view = projectWorkbench({
      项目,
      节点: snapshot.节点,
      审计尾: views.审计尾,
      升级挂起: views.升级挂起,
      // 四盏灯取最近一次真实运行的快照；没有跑过就老实显示「未跑过」。
      // 不现场重跑：否则它就不是「从已有记录重算的投影」了。
      探针: { ...健康, 结果: 最近一次?.结果 ?? [], 于: 最近一次?.于 ?? null, 机制版本: 最近一次?.机制版本 ?? null },
      // `describe()` 给的是 `error`，而投影字段叫 `错误` —— 这里显式补上同名键，
      // 让「面板要读的那个键」在输入里就存在（只靠投影那一侧的兜底太隐蔽，见 workbench.js 的注释）。
      策略: { ...this.policy.describe(), 错误: this.policy.state.error, 介入度: this.policy.intervention(), 失联: this.policy.presence() },
      记忆: await this.memory.activity({ 项目 }),
      讨论消息,
      线程: 线程汇总,
      // 项目清单（2026-10-11，主权者指令「修」）：面板的 `?project=` 只有宿主能定，
      // 而客户端的 fetch 不带项目键 ⇒ 退回默认项目；组织全部活账在别的项目下时，
      // 面板就永远一片空白（主人真机截图：任务图/消息总线全空）。给这份清单，
      // 界面才可能说出「还有哪些项目有账」并一键切过去，而不是继续假装组织是空的。
      项目清单: await this.projectList(项目),
      // 能力 × 岗位接线（2026-10-13 重做·图谱）：两个只读真源 + 实例规模。
      // 三条都走**免审计的只读取数**（`capability.list` / `registry.list` / `identity` 都不入账）——
      // 工作台是轮询的投影，取数一旦入账就会把审计链灌成流水。
      能力: await this.capability.list(),
      岗位: await this.registry.list(),
      实例计数: 计实例计数(identity),
      // 岗位闲置（派活闭环 2026-10-15）：岗位 → {在岗实例, 封存实例, 最近派发于}。
      // **跨项目现算**（岗位与身份不按项目隔离，闲置与否要看全账——只看当前项目会把
      // 「活在别的项目」误判成闲置）；来源是任务图快照（有读缓存，轮询不放大 IO）+ 身份档案，
      // 纯投影零新账。退役判据（无在岗实例且超期无派发）由读者按这份读数下，机制不替谁拍板。
      岗位闲置: await this.计岗位闲置(identity),
      // 实例活动（派活闭环 2026-10-15）：实例 → {最近活动于, 活动条数}，审计链现算
      // （含被拒——拒绝恰恰证明活着，死物不会敲门）；与复核员池「已任命 · 未见活动」同一口径。
      // 任务行据此标 `负责人无活动`：已派发/执行中的节点若负责人在账上零行，「派了没人干」亮灯。
      实例活动: await 计实例活动(this.audit, identity, snapshot.节点),
      生成于: this.clock.iso(),
    });
    return spec.读者 ? sliceForViewer(view, spec.读者) : view;
  }

  /**
   * 项目清单：磁盘上出现过的项目键 + 各项目规模（任务数 / 总线线程数 / 未投递数 / 最近活动于）。
   *
   * 口径：**目录名即项目键**（§14.4-5），所以「有哪些项目」只能靠目录枚举回答；
   * 计数全部现算（任务图事件流 fold + 总线 summary），不落盘、不写账——§9 工作台只读。
   * 排序：有活动的在前（按最近活动倒序），空账项目沉底；`当前` 项目即使没在磁盘上出现过也带上。
   *
   * @param {string} [当前] 这次投影的项目键
   * @returns {Promise<{当前: string|null, 项: object[]}>}
   */
  async projectList(当前) {
    const 键 = new Set();
    for (const dir of [
      this.layout.private(DIR.基础设施, DIR.任务图),
      this.layout.private(DIR.基础设施, DIR.消息总线),
    ]) {
      for (const name of await listDirs(dir)) 键.add(name);
    }
    if (当前) 键.add(当前);
    const 项 = [];
    for (const 项目键 of 键) {
      const 节点 = (await this.tasks.snapshot({ 项目: 项目键 })).节点;
      const 线程 = await this.bus.summary({ 项目: 项目键 });
      // 最近活动：任务事件时刻 ∪ 各线程最新一条的时刻（都取自账本里的行，不取文件 mtime）。
      const 时刻 = [
        ...节点.map((n) => n.最近事件于),
        ...线程.map((t) => (t.最新 ?? []).at(-1)?.追加于),
      ].filter((x) => typeof x === 'string' && x !== '').sort();
      项.push({
        项目: 项目键,
        任务: 节点.length,
        线程: 线程.length,
        未投递: 线程.reduce((和, t) => 和 + (Number(t.未投递) || 0), 0),
        最近于: 时刻.at(-1) ?? null,
      });
    }
    项.sort((a, b) => {
      const 有A = a.任务 > 0 || a.线程 > 0;
      const 有B = b.任务 > 0 || b.线程 > 0;
      if (有A !== 有B) return 有A ? -1 : 1;
      const 时 = String(b.最近于 ?? '').localeCompare(String(a.最近于 ?? ''));
      return 时 !== 0 ? 时 : a.项目.localeCompare(b.项目);
    });
    return { 当前: 当前 ?? null, 项 };
  }

  /**
   * 一行自述：工具与命令的第一屏。
   * @returns {Promise<object>}
   */
  async status() {
    const 探针 = await this.probes.evaluateHealth();
    return {
      项目: this.project,
      于: this.clock.iso(),
      策略: { healthy: this.policy.healthy, 错误: this.policy.state.error, 规则数: this.policy.state.rules.length, 介入度: this.policy.intervention() },
      失联: this.policy.presence(),
      探针,
      任务: (await this.tasks.snapshot({ 项目: this.project })).节点.length,
      能力: await this.capability.stats(),
      // 验账读数：人不翻账本，扫一眼「存量 + 近段新增/晋升」就知道记账在正常发生。
      记忆: await this.memory.activity({ 项目: this.project }),
      岗位: (await this.registry.list()).length,
      引导: this.boot,
    };
  }

  /** @param {string} 项目 @param {number} 审计条数 */
  async #views(项目, 审计条数) {
    const 升级挂起 = (await this.upgrade.pending()).filter((p) => !p.已裁决 && !p.已撤回);
    return {
      审计尾: (await this.audit.read({})).slice(-审计条数),
      升级挂起,
    };
  }

  /**
   * 岗位闲置读数（派活闭环 2026-10-15）：岗位 → {在岗实例, 封存实例, 最近派发于}。
   *
   * 「最近派发于」= 该岗在册实例名下**已派发节点**的最大派发时刻，**跨全部项目**枚举
   * （目录名即项目键，与 projectList 同一口径）——岗位与身份不按项目隔离（§7），
   * 只看当前项目会把「活在别的项目」误判成闲置。快照走 TaskGraph 的读缓存，
   * 轮询不放大 IO。纯投影零新账。返回 `{阈值, 岗位}`：阈值来自部署键
   * `岗位闲置天数`（0 = 不判，行不带 闲置 位）；判闲置是**机械读数**（超 N 天无派发），
   * 退役与否的决定仍由读者下——机制报读数不拍板。
   *
   * @param {{ members?: Record<string, {岗位?: string, status?: string}> }} identity 已读好的身份档案
   * @returns {Promise<{阈值: number, 岗位: Record<string, {在岗实例: number, 封存实例: number, 最近派发于: string|null, 闲置?: boolean}>}>}
   */
  async 计岗位闲置(identity) {
    const 阈值 = Number.isInteger(this.policy.state?.defaults?.岗位闲置天数)
      ? this.policy.state.defaults.岗位闲置天数
      : DEFAULT_ROLE_IDLE_DAYS;
    const 闲置 = {};
    const 实例岗位 = new Map();
    for (const [id, m] of Object.entries(identity?.members ?? {})) {
      if (id === 'undefined' || typeof m?.岗位 !== 'string' || m.岗位 === '') continue;
      const 桶 = (闲置[m.岗位] ??= { 在岗实例: 0, 封存实例: 0, 最近派发于: null });
      if (m.status === '封存') 桶.封存实例 += 1;
      else 桶.在岗实例 += 1;
      if (m.status === '在岗') 实例岗位.set(id, m.岗位);
    }
    const 项目键 = new Set([this.project]);
    for (const name of await listDirs(this.layout.private(DIR.基础设施, DIR.任务图))) 项目键.add(name);
    for (const 键 of 项目键) {
      for (const n of (await this.tasks.snapshot({ 项目: 键 })).节点) {
        if (typeof n.派发于 !== 'string' || n.派发于 === '') continue;
        for (const id of n.负责人 ?? []) {
          const 岗 = 实例岗位.get(id);
          if (!岗) continue;
          const 桶 = (闲置[岗] ??= { 在岗实例: 0, 封存实例: 0, 最近派发于: null });
          if (String(n.派发于) > String(桶.最近派发于 ?? '')) 桶.最近派发于 = n.派发于;
        }
      }
    }
    // 阈值判定（2026-10-15 主权者拍板：默认 14 天，部署键 `岗位闲置天数` 覆盖）：
    // 超过 N 天无派发（含从未派发）⇒ `闲置: true`。**0 = 不判**（行不带 闲置 位，
    // 读者按原始读数自己下结论）。日期解析不了也判闲置——读数坏 ⇒ 亮灯让人来看，不静默当健康。
    if (阈值 > 0) {
      const 下限 = this.clock.ms() - 阈值 * 86400000;
      for (const 桶 of Object.values(闲置)) {
        const ms = 桶.最近派发于 == null ? NaN : Date.parse(桶.最近派发于);
        桶.闲置 = !(Number.isFinite(ms) && ms > 下限);
      }
    }
    return { 阈值, 岗位: 闲置 };
  }

  /**
   * 私有区里已经有哪些记忆分片（探针与工作台用它显示"跑出来的东西"）。
   * @returns {Promise<string[]>}
   */
  async memoryShards() {
    return listFiles(this.layout.memoryDir(DIR.跨项目), { recursive: false, filter: (n) => n.endsWith('.jsonl') });
  }
}

/**
 * 把 DSH 世界的身份映射成组织世界的主体。
 *
 * 约定（可被宿主覆盖）：根会话的执行者是 Lead；带岗位标记的子会话是成员；
 * 复核员岗位映射成复核者。**未知一律不给「系统」这种万能身份** ——
 * §12.2 要求身份不明时判定有确定答案，而答案是"最严"。
 *
 * @param {{ 岗位?: string, 实例?: string, 根会话?: boolean }} spec
 * @returns {{id: string, kind: string, roleId?: string}}
 */
export function subjectFor(spec) {
  const 实例 = spec.实例 ?? spec.岗位 ?? 'unknown';
  // 岗位先于根会话标记：带岗位的会话就是该岗位的成员/复核者，
  // 不能因为「宿主把根会话标记也传了」就被回填成 Lead（B3：成员 kind 构造不出来）。
  if (spec.岗位 === '复核员') return { id: 实例, kind: '复核者', roleId: '复核员' };
  if (spec.岗位 === 'Lead') return { id: 实例 === 'unknown' ? 'lead' : 实例, kind: 'Lead', roleId: 'Lead' };
  if (spec.岗位) return { id: 实例, kind: '成员', roleId: spec.岗位 };
  if (spec.根会话 === true) return { id: 实例 === 'unknown' ? 'lead' : 实例, kind: 'Lead', roleId: 'Lead' };
  // ── 会话派生（A 修 · 2026-10-10）：**不填 `roleId`**，不是「填一个 `'未登记'`」。
  //
  // 为什么这一档给不出岗位：走到这里的实例键是宿主给的**会话 id**，而会话事实里
  // **没有岗位这一位**。独立取证的结论是「成员身份有 sanctioned 来源，岗位没有」——
  // 所有 sanctioned 位只给到预设 id / 自由文本 / id（`label` 是模型可控，
  // `persona` 来自部署 config 且无格式契约）⇒ 从 label/persona 里**猜**岗位是不合法的。
  //
  // 先前的写法是填一个哨兵值 `'未登记'`。它坏在两处：
  //  1. 它是**一个像岗位名的字符串** ⇒ `lib/actions.js` 的档案对账 `member.岗位 !== 主体.roleId`
  //     会拿它去比。比的结果是**恒不匹配**（档案里没有叫「未登记」的岗位，那是唯一真岗位名）
  //     ⇒ P1 之后成员子会话在主体链上**恒被拒**（实测读数见 docs/设计债-2026-10-09.md ㉑）。
  //  2. 反过来，**手写**档案把某实例岗位写成 `'未登记'` ⇒ 恰好匹配 ⇒ 放行（㉓ 那个怪面）。
  //     一个哨兵值同时负责「恒拒」与「撞上就放行」，说明它本来就不是身份信息。
  //
  // 现在：缺省 = 「**主体不自报岗位**」（字段缺席，不是一个值）。对账的第三段于是短路，
  // 语义变成「**在册且在岗即可，岗位以档案为准**」——身份的权威源是 Lead 的显式登记
  // （`registry_assign`，实例键 = 该会话 id），不是主体的自陈。
  // ⚠️ 上下两档**一个字节都没动**：`岗位` 分支（**宿主显式给的主体**带岗位时仍必须与档案一致 ——
  // 门① 的成果）与 `根会话` 分支（无岗位的根会话仍是 Lead）。
  // ⚠️ 2026-10-10 订正（P2 收口）：`lib/actions.js` 已改为「`spec.主体` 缺席即拒」，
  // `args.role` 不再参与主体构造 ⇒「自报岗位」那条路**已不存在**；本 `岗位` 分支现在只服务
  // **宿主显式给的主体**（工具面/命令面 = `agentSubject`，路由面 = 设置页主体）。
  return { id: 实例, kind: '成员' };
}

/**
 * 身份档案 → 岗位级实例计数（2026-10-13 重做·图谱）。
 *
 * 口径：**只给计数，不给实例 id** —— 图谱上岗位是一个节点，实例是它的规模；
 * 把 id 搬上投影等于把「谁在岗」这份名单多复制一份，而真源是身份档案本身。
 * `undefined` 键（历史上 `registry_assign` 漏传实例时落下的坏键，见 exp 422ca5）照实计入：
 * 它不是「一个岗位」，所以单独放在 `异常键` 里可见，**不混进任何岗位的计数**。
 *
 * @param {{ members?: Record<string, {岗位?: string, status?: string}> }} identity
 * @returns {{ 按岗位: Record<string, {在岗: number, 封存: number}>, 异常键: number, 合计: number }}
 */
export function 计实例计数(identity) {
  const 按岗位 = {};
  let 异常键 = 0;
  const members = identity?.members ?? {};
  for (const key of Object.keys(members)) {
    if (key === 'undefined') { 异常键 += 1; continue; }
    const 岗位 = members[key]?.岗位;
    if (typeof 岗位 !== 'string' || 岗位 === '') continue;
    const 桶 = (按岗位[岗位] ??= { 在岗: 0, 封存: 0 });
    if (members[key]?.status === '封存') 桶.封存 += 1;
    else 桶.在岗 += 1;
  }
  return { 按岗位, 异常键, 合计: Object.keys(members).length };
}

/**
 * 实例活动索引（派活闭环 2026-10-15）——工作台侧的判活数据源。
 *
 * 与 `lib/actions.js` 的复核员池读数同一口径：审计链现算，只数「主体 = 该实例」的行
 * （任何动作、任何项目都算，**含被拒**——拒绝恰恰证明活着，死物不会敲门）。
 * 种子面 = 身份档案成员 ∪ 当前项目节点负责人：后者让「未登记却挂着负责人名」的
 * 历史节点也能如实报「未见活动」，而不是因为查无此人而漏报。
 *
 * @param {{ read(query?: object): Promise<object[]> }} audit
 * @param {{ members?: Record<string, object> }} identity
 * @param {object[]} 节点 当前项目的任务节点（负责人并进种子面）
 * @returns {Promise<Record<string, {最近活动于: string|null, 活动条数: number}>>}
 */
export async function 计实例活动(audit, identity, 节点 = []) {
  const 索引 = {};
  const 播种 = (id) => {
    if (typeof id === 'string' && id !== '' && !(id in 索引)) 索引[id] = { 最近活动于: null, 活动条数: 0 };
  };
  for (const id of Object.keys(identity?.members ?? {})) 播种(id);
  for (const n of 节点) for (const id of n.负责人 ?? []) 播种(id);
  if (audit?.read) {
    for (const row of await audit.read({})) {
      const id = String(row.主体?.id ?? '').trim();
      const 桶 = 索引[id];
      if (!桶) continue;
      桶.活动条数 += 1;
      if (String(row.时间) > String(桶.最近活动于 ?? '')) 桶.最近活动于 = String(row.时间);
    }
  }
  return 索引;
}
