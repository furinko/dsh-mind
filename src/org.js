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
import { randomUUID } from 'node:crypto';
import { Clock } from './kernel/time.js';
import { defaultLayout, DIR } from './paths.js';
import { AuditLog, 审计尾默认条数 } from './audit.js';
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
import { CouncilService } from './council.js';
// v2 条目14/17（2026-10-18 补修F）：介入度待决的请求/决议/一次性放行 —— 域服务单源，
// 动作层、人侧路由、工作台三个消费者只读它，不各写一套状态机。
import { InterventionService } from './intervention.js';
import { Denied } from './kernel/errors.js';
import { projectWorkbench, sliceForViewer } from './workbench.js';
import { ObservabilityService } from './observability.js';
import { projectGoalSnapshot } from './goal-view.js';
import { GoalBudgetService } from './goal-budget.js';
import { ModelUsageService } from './model-usage.js';
import { SpawnOperationService } from './spawn-operations.js';
import { KnowledgeReuseService } from './knowledge-reuse.js';
import { TurnBufferService } from './turn-buffer.js';
import { ProjectBriefService } from './project-brief.js';
import { ContinuityCaptureService } from './continuity-capture.js';

/** 默认项目键。名字即目录名（§14.4-5）。 */
export const DEFAULT_PROJECT = 'default';

export class Org {
  /**
   * @param {{ layout: import('./paths.js').Layout, clock: Clock, audit: AuditLog, policy: PolicyEngine, store: ObjectStore,
   *           tasks: TaskGraph, bus: MessageBus, memory: MemoryService, capability: CapabilityLibrary, registry: RoleRegistry,
   *           upgrade: UpgradeManager, probes: ProbeRunner, review: ReviewProtocol, intervention: InterventionService,
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
    const memory = new MemoryService({ layout, policy, audit, clock, registry });
    const tasks = new TaskGraph({ layout, policy, audit, clock, memory, registry });
    memory.tasks = tasks;
    const goals = tasks.goals;
    const budgets = new GoalBudgetService({ layout, policy, audit, clock, registry, goals });
    const modelUsage = new ModelUsageService({ layout, policy, clock, registry, goals });
    const spawnOperations = new SpawnOperationService({ layout, policy, clock, registry });
    const knowledgeReuse = new KnowledgeReuseService({ layout, policy, registry, memory });
    const bus = new MessageBus({ layout, policy, audit, clock, tasks });
    const capability = new CapabilityLibrary({ layout, policy, audit, clock, store });
    const upgrade = new UpgradeManager({ layout, policy, audit, clock });
    const probes = new ProbeRunner({ layout, policy, audit, clock, capability });
    // registry 注入 review（2026-10-14 · 池化排班）：提名路由（池内派单/池外待决）要按
    // 「在册在岗复核员」分池——身份档案是唯一事实源，与 debate 候选池同一条接线纪律。
    const review = new ReviewProtocol({ layout, policy, audit, clock, tasks, bus, registry, random: spec.random });
    // v2（条目18/19）：会审退出任务图，换成会话绑定的 CouncilService——自己的事件流
    // （councils.jsonl）、自己的状态机；bus 只承载讨论消息；registry 核参与者在册在岗。
    const council = new CouncilService({ layout, policy, audit, clock, bus, registry });
    // 介入度待决（v2 条目14/17/20/24）：只消费策略引擎与人侧入口的事实，自己不改规则。
    // 卡版本/目标代用于「旧批准失效」判定——读不到就返回 null（不猜通过，重放侧另有一道）。
    const intervention = new InterventionService({
      layout,
      clock,
      audit,
      policy,
      registry,
      卡版本Of: async (id) => (await registry.identity()).members?.[String(id ?? '')]?.卡版本?.摘要 ?? null,
      目标代Of: async ({ id, kind, 项目 }) => {
        const 目标 = String(id ?? '');
        if (!目标) return null;
        if (kind === '任务') return (await tasks.get(目标, { 项目 }))?.代 ?? null;
        // 文档类对象（岗位卡/能力/知识）的「代」= 文本版本号：改过就是新目标。
        if (['身份', '能力', '知识'].includes(kind)) {
          try {
            return (await store.read(String(kind), 目标, {}))?.meta?.version ?? null;
          } catch {
            return null;
          }
        }
        return null;
      },
    });

    const org = new Org({
      layout,
      clock,
      audit,
      policy,
      store,
      tasks,
      goals,
      budgets,
      modelUsage,
      spawnOperations,
      knowledgeReuse,
      bus,
      memory,
      capability,
      registry,
      upgrade,
      probes,
      review,
      council,
      intervention,
      project: spec.project ?? DEFAULT_PROJECT,
      logger: spec.logger ?? console,
    });
    org.observability = new ObservabilityService({ audit, clock, registry, tasks, policy, logger: spec.logger ?? console });
    org.turnBuffer = new TurnBufferService({ layout, org, clock });
    org.projectBrief = new ProjectBriefService({ layout, org, clock });
    org.continuityCapture = new ContinuityCaptureService({ layout, org, clock });
    await org.bootstrap({ 代次: spec.代次 });
    return org;
  }

  /**
   * 引导私有区。幂等：已有的东西一律不动。
   *
   * v2（口述收敛 2026-10-18 条目10/12）新增两步，顺序有讲究：
   *  ① `recordBoot` 先记本进程代次——它是判孤儿的事实源，必须在任何实例判定之前落定；
   *  ② `orphanSweep` 只按**可靠进程代次**判死（同代=活、异代查 pid、无代次=未判定），
   *     判得死的标封存；**绝不碰任务图**（未完成交卷的节点不会被回收动作推进成成功态）。
   * 两步都只在每个进程第一次装配时发生一次（`shareOrg` 是每进程单例）——
   * 「某 Lead 首次动作就把所有其他会话实例封存」这种形态在结构上不可能出现。
   *
   * @param {{ 代次?: {代: string, pid: number, 于: string} }} [spec]
   * @returns {Promise<{已引导: boolean, 新建目录: string[], 上基线: string|null, 孤儿回收?: object}>}
   */
  async bootstrap(spec = {}) {
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
    // 来源声明（设计评审 #7 · 2026-10-15）：bootstrap 是 markInteraction 白名单里的
    // 第三个合法入口（「部署引导」）——任务清单只列了两处调用方，这里是既有第三处。
    if (!(await exists(this.layout.identityFile()))) {
      await this.registry.markInteraction({ 来源: '部署引导' });
    }
    // v2 条目12：进程代次 + 孤儿回收（判据与「不猜死」的口径住在 registry.orphanSweep）。
    const 代次 = spec.代次 ?? { 代: `anon-${randomUUID()}`, pid: process.pid, 于: this.clock.iso() };
    await this.registry.recordBoot(代次);
    const 孤儿回收 = await this.registry.orphanSweep({ 代次 });
    // 索引的生命周期投影要用「实例最近活动于」：口径的**唯一实现**是下面的 计实例活动
    // （与工作台同一份），由装配点算好交给 registry，不在注册表里再写一遍。
    const identity = await this.registry.identity();
    const 节点 = (await this.tasks.snapshot({ 项目: this.project })).节点;
    await this.registry.sync({ 活动: await 计实例活动(this.audit, identity, 节点) });

    let 上基线 = null;
    if (!(await exists(this.layout.baselineFile()))) {
      上基线 = (await this.upgrade.stamp({ 版本: '1.0.0' })).版本;
    }

    this.boot = { 已引导: true, 新建目录, 上基线, 孤儿回收, 代次 };
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
    const identity = await this.registry.identity();
    const 参与实例 = spec.读者?.kind === '成员' ? identity.members?.[spec.读者.id] : null;
    const 咨询 = 参与实例?.会审绑定;
    if (咨询 !== undefined && 咨询 !== null) {
      if (参与实例.status !== '在岗' || typeof 咨询 !== 'object' || 咨询.项目 !== 项目 || !咨询.会审) {
        throw new Denied('会审参与实例 · 工作台读域不可用', '咨询实例仅能查看自己绑定项目/会审；未知绑定或封存实例不得扩大读域。');
      }
      // 答案仍走 Council 唯一遮罩；咨询读面不夹带任务、审计、其他会审和跨项目目录。
      const 存档 = await this.council.list({ 项目, 读者: { ...spec.读者, roleId: 参与实例.岗位 } });
      return projectWorkbench({ 项目, 会审存档: 存档.filter((x) => x.id === 咨询.会审), 生成于: this.clock.iso() });
    }
    const snapshot = await this.tasks.snapshot({ 项目 });
    const views = await this.#views(项目, spec.审计条数 ?? 审计尾默认条数);
    const 健康 = await this.probes.evaluateHealth();
    const 最近一次 = await this.probes.latest();
    // ⑦（2026-10-11）：消息总线投影——全部线程的规模 + 最新消息 + 未投递数。
    // summary 内部走 readRaw（免审计，设计债③）：投影取数不过闸不入账。
    const 线程汇总 = await this.bus.summary({ 项目 });
    // 身份档案沿用入口已读取的同一份，三块规模读数不另采一代。
    // ㉔读面收口（设计债 2026-10-17）：会话派生成员不带 roleId——先解析读者再取会审
    // 存档，盲评遮罩（council.list 按读者遮）才有正确口径。
    let 读者 = spec.读者;
    if (读者?.kind === '成员' && !读者.roleId) {
      const member = identity?.members?.[读者.id];
      if (member?.status === '在岗' && typeof member.岗位 === 'string' && member.岗位) {
        读者 = { ...读者, roleId: member.岗位 };
      }
    }
    // v2（条目18）：会审页数据源 = 会审自己的存档账本（旧任务图讨论段原地只读不迁移）。
    const 会审存档 = await this.council.list({ 项目, 读者 });
    const view = projectWorkbench({
      项目,
      节点: snapshot.节点,
      审计尾: views.审计尾,
      升级挂起: views.升级挂起,
      介入挂起: views.介入挂起,
      // 四盏灯取最近一次真实运行的快照；没有跑过就老实显示「未跑过」。
      // 不现场重跑：否则它就不是「从已有记录重算的投影」了。
      探针: { ...健康, 结果: 最近一次?.结果 ?? [], 于: 最近一次?.于 ?? null, 机制版本: 最近一次?.机制版本 ?? null },
      // `describe()` 给的是 `error`，而投影字段叫 `错误` —— 这里显式补上同名键，
      // 让「面板要读的那个键」在输入里就存在（只靠投影那一侧的兜底太隐蔽，见 workbench.js 的注释）。
      策略: { ...this.policy.describe(), 错误: this.policy.state.error, 介入度: this.policy.intervention(), 失联: this.policy.presence() },
      记忆: await this.memory.activity({ 项目 }),
      会审存档,
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
    // （读者已在上面解析过——会审盲评遮罩与切片共用同一口径。）
    const visible = 读者 ? sliceForViewer(view, 读者) : view;
    // 成员目前没有目标全文读域；不从任务可见性推导整个目标/其他任务的可读性。
    const 可读目标 = !读者 || 读者.kind === '主权者' || (读者.kind === 'Lead' && identity.members?.[读者.id]?.岗位 === 'Lead' && identity.members?.[读者.id]?.status === '在岗');
    if (!可读目标) { visible.目标 = null; visible.模型用量 = null; visible.创建操作 = null; visible.知识复用 = null; }
    else {
      visible.知识复用 = !读者 ? await this.knowledgeReuse.summary(项目) : await this.knowledgeReuse.summaryFor({ subject: 读者, 项目 });
      visible.创建操作 = !读者 ? this.spawnOperations.summary(项目) : await this.spawnOperations.summaryFor({ subject: 读者, 项目 });
      const 用量读面 = !读者 ? this.modelUsage.summary(项目) : await this.modelUsage.summaryFor({ subject: 读者, 项目 });
      visible.模型用量 = 用量读面 ? { ...用量读面, 采集: this.modelUsageHooks?.health() ?? { enabled: null, attached: false, 完整: false } } : null;
      try { visible.目标 = projectGoalSnapshot(this.goals, this.goals.rawSnapshot(项目), snapshot.节点, 10, this.budgets); }
      catch (error) { visible.目标 = { 健康: '不可用', 故障码: error.code ?? 'GOAL_READ_FAILED', 总数: null, 目标: [] }; }
    }
    // This projection reads the entire verified observation history, independently of the audit tail.
    try { visible.监控 = await this.observability.query({ subject: 读者, project: 项目 }); }
    catch { visible.监控 = { 健康: { ...this.observability.health(), 状态: 'unavailable' }, 阻塞: [], 规则汇总: [], 尝试总数: null, 误拦截率: null }; }
    return visible;
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
   *
   * 项目口径（设计评审 F2 · 2026-10-15）：任务行与记忆行按**本次调用的项目键**取数
   * （`spec.项目 ?? this.project`，与 workbench 同款）——修前恒用装配期 `this.project`，
   * 于是 status 拿 default 项目的组织回答 repos 项目的调用（任务 0 vs 31 的假空白）。
   * 其余字段（策略/失联/探针/能力/岗位/引导）本来就跨项目，保持原样。
   *
   * @param {{ 项目?: string }} [spec]
   * @returns {Promise<object>}
   */
  async status(spec = {}) {
    const 项目 = spec.项目 ?? this.project;
    const 探针 = await this.probes.evaluateHealth();
    return {
      项目,
      于: this.clock.iso(),
      策略: { healthy: this.policy.healthy, 错误: this.policy.state.error, 规则数: this.policy.state.rules.length, 介入度: this.policy.intervention() },
      失联: this.policy.presence(),
      探针,
      任务: (await this.tasks.snapshot({ 项目 })).节点.length,
      能力: await this.capability.stats(),
      // 验账读数：人不翻账本，扫一眼「存量 + 近段新增/晋升」就知道记账在正常发生。
      记忆: await this.memory.activity({ 项目 }),
      岗位: (await this.registry.list()).length,
      引导: this.boot,
    };
  }

  /** @param {string} 项目 @param {number} 审计条数 */
  async #views(项目, 审计条数) {
    const 升级挂起 = (await this.upgrade.pending()).filter((p) => !p.已裁决 && !p.已撤回);
    const 全账 = await this.audit.read({});
    // 介入待决（v2 口述收敛 2026-10-18 条目14/17）：状态机在域服务里单源（请求/决议/占用/
    // 完成/失败 + 档位/卡版本/目标代失效），这里只取当前项目的那一片——不再从「策略拒绝」
    // 行去重出一个恒报「待放行」的影子清单。
    const 介入挂起 = await this.intervention.投影({ 项目 });
    return {
      审计尾: 全账.slice(-审计条数),
      升级挂起,
      介入挂起,
    };
  }

  /**
   * 岗位闲置读数（派活闭环 2026-10-15）：岗位 → {在岗实例, 封存实例, 最近派发于}。
   *
   * 「最近派发于」= 该岗实例（含封存）或岗位名名下**已派发节点**的最大派发时刻，**跨全部项目**枚举
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
      // 封存只改变当前实例数，不能让已经发生的派发失去岗位归属。
      实例岗位.set(id, m.岗位);
    }
    const 项目键 = new Set([this.project]);
    for (const name of await listDirs(this.layout.private(DIR.基础设施, DIR.任务图))) 项目键.add(name);
    for (const 键 of 项目键) {
      for (const n of (await this.tasks.snapshot({ 项目: 键 })).节点) {
        if (typeof n.派发于 !== 'string' || n.派发于 === '') continue;
        for (const id of n.负责人 ?? []) {
          const 岗 = 实例岗位.get(id) ?? (Object.hasOwn(闲置, id) ? id : null);
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
 * 约定（可被宿主覆盖）：根会话的执行者是 Lead；带岗位标记的子会话是成员
 * （复核员岗也是成员主体——v2 口述收敛 2026-10-18：复核者退出主体清单，
 * 其只读边界由策略引擎按 roleId=复核员 判）。**未知一律不给「系统」这种万能身份** ——
 * §12.2 要求身份不明时判定有确定答案，而答案是"最严"。
 *
 * @param {{ 岗位?: string, 实例?: string, 根会话?: boolean }} spec
 * @returns {{id: string, kind: string, roleId?: string}}
 */
export function subjectFor(spec) {
  const 实例 = spec.实例 ?? spec.岗位 ?? 'unknown';
  // 岗位先于根会话标记：带岗位的会话就是该岗位的成员，
  // 不能因为「宿主把根会话标记也传了」就被回填成 Lead（B3：成员 kind 构造不出来）。
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
 * 岗名负责人按该岗在岗实例聚合；实例直配仍只认本人，封存实例的旧活动不能替当前岗位消灯。
 *
 * @param {{ read(query?: object): Promise<object[]> }} audit
 * @param {{ members?: Record<string, object> }} identity
 * @param {object[]} 节点 当前项目的任务节点（负责人并进种子面）
 * @returns {Promise<Record<string, {最近活动于: string|null, 活动条数: number}>>} 实例及节点所用岗位名的活动索引
 */
export async function 计实例活动(audit, identity, 节点 = []) {
  const 索引 = Object.create(null);
  const members = identity?.members ?? {};
  const 岗位活动 = new Map();
  const 播种 = (id) => {
    if (typeof id === 'string' && id !== '' && !Object.hasOwn(索引, id)) 索引[id] = { 最近活动于: null, 活动条数: 0 };
  };
  for (const [id, m] of Object.entries(members)) {
    播种(id);
    if (m?.status === '在岗' && typeof m.岗位 === 'string' && m.岗位 !== '' && !岗位活动.has(m.岗位)) {
      岗位活动.set(m.岗位, { 最近活动于: null, 活动条数: 0 });
    }
  }
  for (const n of 节点) for (const id of n.负责人 ?? []) 播种(id);
  if (audit?.read) {
    for (const row of await audit.read({})) {
      const id = String(row.主体?.id ?? '').trim();
      const 岗位 = members[id]?.status === '在岗' ? members[id].岗位 : null;
      for (const 桶 of [索引[id], 岗位活动.get(岗位)]) {
        if (!桶) continue;
        桶.活动条数 += 1;
        if (String(row.时间) > String(桶.最近活动于 ?? '')) 桶.最近活动于 = String(row.时间);
      }
    }
  }
  for (const n of 节点) {
    for (const id of n.负责人 ?? []) {
      if (members[id]?.status !== '在岗' && 岗位活动.has(id)) 索引[id] = 岗位活动.get(id);
    }
  }
  return 索引;
}
