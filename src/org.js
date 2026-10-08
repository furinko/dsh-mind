/**
 * 组装：把八件基础设施接成一个组织（唯一入口）。
 *
 * 为什么要有这一层：宿主插件只跟 `Org` 说话。装配点只有一个，
 * 于是「谁依赖谁」是显式的、可测的；散在各处的 `new` 会让「重启后可重建」变成空话。
 *
 * 首次打开时会**引导私有区**（建目录、落身份档案、上基线戳），
 * 但绝不触碰出厂区——出厂区是只读模板。
 */
import { ensureDirPath, exists, listFiles } from './kernel/fsx.js';
import { dirname } from 'node:path';
import { Clock } from './kernel/time.js';
import { defaultLayout, DIR } from './paths.js';
import { AuditLog } from './audit.js';
import { PolicyEngine } from './policy.js';
import { ObjectStore } from './store.js';
import { TaskGraph } from './tasks.js';
import { MessageBus } from './bus.js';
import { MemoryService } from './memory.js';
import { CapabilityLibrary } from './capability.js';
import { RoleRegistry } from './registry.js';
import { UpgradeManager } from './upgrade.js';
import { ProbeRunner } from './probes.js';
import { ReviewProtocol } from './review.js';
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
    const tasks = new TaskGraph({ layout, policy, audit, clock });
    const bus = new MessageBus({ layout, policy, audit, clock });
    const memory = new MemoryService({ layout, policy, audit, clock });
    const capability = new CapabilityLibrary({ layout, policy, audit, clock });
    const registry = new RoleRegistry({ layout, policy, audit, clock });
    const upgrade = new UpgradeManager({ layout, policy, audit, clock });
    const probes = new ProbeRunner({ layout, policy, audit, clock, capability });
    const review = new ReviewProtocol({ layout, policy, audit, clock, tasks, bus, random: spec.random });

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
      生成于: this.clock.iso(),
    });
    return spec.读者 ? sliceForViewer(view, spec.读者) : view;
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
  return { id: 实例, kind: '成员', roleId: '未登记' };
}
