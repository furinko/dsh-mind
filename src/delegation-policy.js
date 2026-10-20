/**
 * 部署者授予的调度权限：提示词与实际创建入口共用，不从模型参数或记忆条目推导授权。
 */
import { createHash } from 'node:crypto';
import { Denied, Fault, InvalidBody } from './kernel/errors.js';
import { assertPathSegment } from './paths.js';

// 上游契约锚（2026-10-17 换代核对）：当前构建的官方 team:policy 真实文本出自
// app.asar → dsh-experimental-tool-agent-team/lib/index.js 的 teamPolicy()。
// 上游把旧的授权闸句（"…but create teammates only when the user explicitly asks…"）
// 整句删除——新文本是纯协作纪律（写域 / FS_STALE_VERSION / 消息语义），没有要替换的闸门句。
// 锚取首行+次段开头：够长能咬住所认的契约，上游再漂移即硬拒（fail-closed，不静默适配）。
const OFFICIAL_TEAM_OPENER = 'Agent Teams is available in this session\n\nThe Team Lead and all teammates share the same working directory and filesystem.';
const CREATION_TOOLS = new Set(['spawn_teammate', 'subagent', 'subagent_fork', 'role_spawn', 'workflow']);
/** @param {string|undefined} name @returns {boolean} 只读查询创建工具闭名单，无副作用。 */
export const isCreationTool = name => CREATION_TOOLS.has(name);

/** 唯一授权判据；不负责猜测任务是否值得委派，那是 Lead 的职责。 */
export class DelegationPolicy {
  /** 部署与运行自检共用的代次标记，不以心跳计数冒充版本。 */
  static generation = 'mind-delegation-v2';

  /**
   * @param {{mode?: 'explicit-user'|'lead-discretion', projects?: string[], authorizationRef?: string}} [config]
   * @throws {InvalidBody} 配置形状、范围或授权引用不合法时拒绝加载。
   */
  constructor(config = {}) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new InvalidBody('delegation 必须是配置对象。');
    const keys = new Set(['mode', 'projects', 'authorizationRef']);
    for (const key of Object.keys(config)) {
      if (!keys.has(key)) throw new InvalidBody(`delegation 未知配置键：${key}`);
    }
    const mode = config.mode ?? 'explicit-user';
    if (!['explicit-user', 'lead-discretion'].includes(mode)) throw new InvalidBody('delegation.mode 只认 explicit-user 或 lead-discretion。');
    if (config.projects !== undefined && !Array.isArray(config.projects)) throw new InvalidBody('delegation.projects 必须是项目键数组。');
    const projects = [...new Set((config.projects ?? []).map((project) => {
      if (typeof project !== 'string') throw new InvalidBody('delegation.projects 的每项必须是字符串。');
      return project === '*' ? project : assertPathSegment(project, '授权项目');
    }))].sort();
    if (config.authorizationRef !== undefined && typeof config.authorizationRef !== 'string') throw new InvalidBody('delegation.authorizationRef 必须是字符串。');
    const authorizationRef = config.authorizationRef?.trim() ?? '';
    if (mode === 'lead-discretion' && (projects.length === 0 || !authorizationRef)) {
      throw new InvalidBody('Lead 自主调度必须声明 projects 范围与 authorizationRef；不能从记忆或模型自报补授权。');
    }
    this.config = Object.freeze({ mode, projects: Object.freeze(projects), authorizationRef });
    this.fingerprint = createHash('sha256').update(JSON.stringify(this.config)).digest('hex');
    this.closed = false;
  }

  /**
   * 只读描述，不把授权存在当成执行体已经就绪。
   * @param {string} project
   * @returns {object} 当前范围、授权来源与版本指纹。
   */
  status(project) {
    return {
      generation: DelegationPolicy.generation,
      mode: this.config.mode,
      project,
      authorized: !this.closed && this.config.mode === 'lead-discretion' && (this.config.projects.includes(project) || this.config.projects.includes('*')),
      projects: [...this.config.projects],
      authorizationRef: this.config.authorizationRef || null,
      source: 'profile:dsh-mind-kernel.delegation',
      fingerprint: this.fingerprint,
      disposed: this.closed,
      choices: ['direct', 'team', 'subagent'],
    };
  }

  /**
   * @param {{subject: object, project: string}} spec
   * @returns {object} 通过的授权快照。
   * @throws {Denied|Fault} 非 Lead、范围外、未授权或组件已卸载时硬拒绝。
   */
  authorize({ subject, project }) {
    if (this.closed) throw new Fault('DELEGATION_DISPOSED', '调度组件已卸载或授权正在重载，不接受新的委派。');
    if (subject?.kind !== 'Lead') {
      throw new Denied('组织调度 · 仅 Lead', '成员与复核者不得自行再起成员或扩大调度权限。', { howToChange: '把需求交回 Lead；身份只认宿主会话事实。' });
    }
    const state = this.status(assertPathSegment(project, '授权项目'));
    if (!state.authorized) {
      throw new Denied('部署授权 · Lead 自主调度', `项目 ${project} 没有有效的 Lead 自主调度授权。`, {
        requireAuthority: '主权者',
        howToChange: '由部署者在 dsh-mind-kernel.delegation 配置中明确授权项目与授权依据；模型参数和记忆条目不能代替该配置。',
      });
    }
    return state;
  }

  /**
   * 维护已登记委派不授予创建权；归属、任务与宿主父链由唯一维护判据继续核实。
   * @param {{subject:object,project:string}} spec
   * @returns {object} 维护准入快照（不改变 authorized 创建权读数）。
   * @throws {Denied|Fault} 非 Lead、组件关闭或项目键不合法时拒绝。
   */
  authorizeMaintenance({ subject, project }) {
    if (this.closed) throw new Fault('DELEGATION_DISPOSED', '调度组件已卸载或授权正在重载，不接受既有委派维护。');
    if (subject?.kind !== 'Lead') throw new Denied('组织调度 · 仅 Lead', '仅真实 Lead 可维护已有委派。', { howToChange: '交回派发该实例的 Lead；不得自报父身份。' });
    const state = this.status(assertPathSegment(project, '维护项目'));
    return { ...state, maintenanceOnly: true };
  }

  /**
   * 受授权项目的创建只走组织适配入口，避免裸工具绕过登记与任务装载。
   * @param {{name?: string}} exec
   * @param {{subject: object, project: string}} spec
   * @returns {string|undefined} 宿主单调 guard 使用的拒绝理由。
   */
  creationGuard(exec, { subject, project }) {
    if (!CREATION_TOOLS.has(exec?.name)) return undefined;
    if (this.closed) return '调度组件已卸载或授权正在重载，暂不接受创建成员。';
    if (subject?.kind !== 'Lead') return '组织调度仅允许 Lead 发起；成员与复核者不能再起成员。';
    if (this.status(project).authorized) return '本项目已启用组织调度：创建团队或子智能体请走 mind member_spawn，先定任务判据再登记、装载并开工；也可由 Lead 直接执行。';
    return undefined;
  }

  /**
   * 正式装配 waterfall 的后处理：只原位替换一个 Team 策略段，保留官方其余协作约束。
   * @param {{sections: Array<{name: string, text: string}>, [key: string]: any}} assembly
   * @param {{project: string, isTeam: boolean}} spec
   * @returns {object} 新装配值；未授权或非 Team 作用域原样返回。
   * @throws {Fault} 已授权的 Team 缺段、重段或上游策略形状漂移时拒绝组装。
   */
  assemble(assembly, { project, isTeam }) {
    if (!this.status(project).authorized || !isTeam) return assembly;
    const sections = assembly?.sections;
    if (!Array.isArray(sections)) throw new Fault('DELEGATION_PROMPT_SHAPE', '宿主提示词装配没有 sections，不能确认唯一策略落点。');
    const team = sections.filter((section) => section.name === 'team:policy');
    if (team.length !== 1) throw new Fault('DELEGATION_TEAM_POLICY', `授权范围内要求唯一 team:policy，实际 ${team.length} 段。`);
    const original = team[0].text;
    if (typeof original !== 'string' || !original.startsWith(OFFICIAL_TEAM_OPENER)) {
      throw new Fault('DELEGATION_UPSTREAM_POLICY_DRIFT', '官方 team:policy 入口已变化；先核对上游契约，不能盲目替换或追加相反指令。');
    }
    const header = [
      `[${DelegationPolicy.generation}] The deployment owner explicitly authorizes the Team Lead to choose direct execution, ordinary subagents, or Agent Teams according to task needs in project ${JSON.stringify(project)}.`,
      'Delegation is optional: do not create agents merely to parallelize. Use mind member_spawn for governed delegation; it registers the actual instance, binds a task with acceptance criteria, loads role instructions, and only then sends the work.',
      // v2（口述收敛 2026-10-18 条目1/3）：复核员是**普通岗位卡**，不再需要主权者任命授权——
      // Lead 按任务用 member_spawn 起复核实例即完成就位，独立性由复核时的冲突排除
      // （交卷人 / 负责人不得复核本任务）与机制附上的冻结判据承担。
      // 修前这句写的是 "Reviewer appointments still require the existing sovereign authorization"，
      // 与真源冲突：一句提示词就是一次「任命授权」闸的复活（且模型会照做）。
      'Only the Lead chooses and initiates delegation. Members and reviewers cannot create further agents or grant themselves authority. Reviewers are ordinary role cards: the Lead spawns a review instance per task like any other member, and independence is enforced by conflict exclusion (whoever submitted or owns the work must not review it) plus the criteria frozen by the mechanism, not by any appointment authorization.',
      'Use mind member_message and member_stop for organization-managed instances; Team names and ordinary child session ids are different addresses. The organization task graph remains the business-state authority; the Team task board is an execution mirror, not a second acceptance authority.',
    ].join('\n');
    // 拼接形态换代（2026-10-17）：旧契约是「换掉授权闸句、保留尾巴」；上游删掉闸句后，
    // 改为组织授权头**前置**、官方全文逐字保留——不删不改不加相反指令（上游已不再说
    // 「仅用户明确要求才可创建」，组织纪律是部署者附加约束，与上游文本无冲突）。
    return {
      ...assembly,
      sections: sections.map((section) => section === team[0] ? { ...section, text: header + '\n\n' + original } : section),
    };
  }

  /** 卸载先撤回运行中适配器的准入，避免热重载后旧回调继续使用旧授权。 */
  close() {
    this.closed = true;
  }
}
