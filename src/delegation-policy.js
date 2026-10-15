/**
 * 部署者授予的调度权限：提示词与实际创建入口共用，不从模型参数或记忆条目推导授权。
 */
import { createHash } from 'node:crypto';
import { Denied, Fault, InvalidBody } from './kernel/errors.js';
import { assertPathSegment } from './paths.js';

const OFFICIAL_TEAM_OPENER = 'Agent Teams is available in this session, but create teammates only when the user explicitly asks to use Agent Teams or teammates.';
const CREATION_TOOLS = new Set(['spawn_teammate', 'subagent', 'subagent_fork', 'role_spawn', 'workflow']);

/** 唯一授权判据；不负责猜测任务是否值得委派，那是 Lead 的职责。 */
export class DelegationPolicy {
  /** 部署与运行自检共用的代次标记，不以心跳计数冒充版本。 */
  static generation = 'mind-delegation-v1';

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
      'Only the Lead chooses and initiates delegation. Members and reviewers cannot create further agents or grant themselves authority. Reviewer appointments still require the existing sovereign authorization.',
      'Use mind member_message and member_stop for organization-managed instances; Team names and ordinary child session ids are different addresses. The organization task graph remains the business-state authority; the Team task board is an execution mirror, not a second acceptance authority.',
    ].join('\n');
    return {
      ...assembly,
      sections: sections.map((section) => section === team[0] ? { ...section, text: header + original.slice(OFFICIAL_TEAM_OPENER.length) } : section),
    };
  }

  /** 卸载先撤回运行中适配器的准入，避免热重载后旧回调继续使用旧授权。 */
  close() {
    this.closed = true;
  }
}
