/** 持久目标：当前约束、主体进展判断与任务证据引用；不制造新权限或用户认证。 */
import { appendLines, serializeByKey, withLock } from './kernel/fsx.js';
import { canonical, digest } from './kernel/text.js';
import { Denied, Fault, InvalidBody } from './kernel/errors.js';
import { artifactReferences, verifyArtifactManifest } from './artifact-manifest.js';
import { 已被合法采纳 } from './tasks.js';
import { GOAL_NATIVE_TOOLS, goalLogPath, goalLockPath, readGoalLedger, readGoalLedgerSync, foldGoalLedger, goalSnapshotOf, constraintsForTaskInSnapshot } from './goal-ledger.js';

export const GOAL_LIMITS = Object.freeze({ 期望结果: 4000, 文本: 2000, 数组项: 32, 数组文本: 1000, 请求键: 128, 默认条数: 20, 最大条数: 50 });
const ACTION_FIELDS = {
  goal_create: ['期望结果', '约束', '禁止工具', '完成依据', '来源', '下一步', '请求键'],
  goal_revise: ['修订', '期望结果', '约束', '禁止工具', '完成依据', '来源'],
  goal_progress: ['修订', '状态', '下一步', '等待原因'],
  goal_state: ['修订', '状态'],
  goal_complete: ['修订', '说明', '证据', '完成核对'],
  goal_link_task: ['修订', '任务'],
};
const EVENT_KIND = { goal_create: 'goal_created', goal_revise: 'goal_revised', goal_progress: 'goal_progressed', goal_state: 'goal_state_changed', goal_complete: 'goal_completed', goal_link_task: 'goal_task_linked' };

export class GoalService {
  constructor({ layout, policy, audit, clock, registry, tasks }) { Object.assign(this, { layout, policy, audit, clock, registry, tasks }); }
  #plans = new WeakSet();

  /** 统一锁序入口。只读任务事实可以在此锁内读取，不在内部调用任务变更。 */
  async withProjectLock(project, fn) {
    this.#project(project);
    const file = goalLogPath(this.layout, project);
    // 不可重入：异步后代不继承免锁资格；GoalService 内部只读任务，不反向调用任务写。
    return serializeByKey(file, () => withLock(goalLockPath(this.layout, project), fn));
  }

  /** 内核专用同步全量真源；面向模型的有界读面走 get/list。 */
  rawSnapshot(project) { this.#project(project); return goalSnapshotOf(readGoalLedgerSync(goalLogPath(this.layout, project)), project); }
  constraintsForTask(node, nodes, project) { return constraintsForTaskInSnapshot(node, nodes, this.rawSnapshot(project)); }

  async get(id, spec) {
    this.#project(spec?.项目);
    await this.#actor(spec.subject);
    await this.#policy('read', id, spec, 'goal_query');
    const goal = foldGoalLedger(await readGoalLedger(goalLogPath(this.layout, spec.项目))).get(id);
    return goal ? goalDetail(goal) : null;
  }

  async list(spec) {
    this.#project(spec?.项目);
    await this.#actor(spec.subject);
    await this.#policy('read', 'goals', spec, 'goal_query');
    const 条数 = integer(spec.条数 ?? GOAL_LIMITS.默认条数, 1, GOAL_LIMITS.最大条数, '条数');
    const 偏移 = integer(spec.偏移 ?? 0, 0, Number.MAX_SAFE_INTEGER, '偏移');
    const all = [...foldGoalLedger(await readGoalLedger(goalLogPath(this.layout, spec.项目))).values()].sort((a, b) => a.id.localeCompare(b.id));
    return { 目标: all.slice(偏移, 偏移 + 条数).map(goalSummary), 总数: all.length, 条数, 偏移, hasMore: 偏移 + 条数 < all.length, 摘要: true };
  }

  /** 准备不追加事件或审批；执行只接受本服务签发的同主体同输入计划。 */
  async plan(action, args) {
    this.#input(action, args, false);
    await this.#actor(args.subject);
    const rows = await readGoalLedger(goalLogPath(this.layout, args.项目));
    const plan = await this.#prepare(action, args, rows);
    deepFreeze(plan);
    this.#plans.add(plan);
    return plan;
  }

  create(spec) { return this.#execute('goal_create', null, spec); }
  revise(id, spec) { return this.#execute('goal_revise', id, spec); }
  progress(id, spec) { return this.#execute('goal_progress', id, spec); }
  setState(id, spec) { return this.#execute('goal_state', id, spec); }
  complete(id, spec) { return this.#execute('goal_complete', id, spec); }
  linkTask(id, spec) { return this.#execute('goal_link_task', id, spec); }

  async #execute(action, id, spec) {
    const args = id === null ? { ...spec } : { ...spec, id };
    if (spec.id !== undefined && spec.id !== id) throw new InvalidBody('目标 id 与方法参数不一致。');
    this.#input(action, args, true);
    const plan = args.执行计划 ?? await this.plan(action, withoutPlan(args));
    if (!this.#plans.has(plan) || plan.动作 !== action || plan.项目 !== args.项目 || plan.主体.id !== args.subject?.id || plan.主体.kind !== args.subject?.kind || plan.输入摘要 !== digest(canonical(this.#normalized(action, args)))) throw new InvalidBody('目标执行计划不是本服务签发的同主体、同项目、同规范输入计划。');
    let committed = null;
    let result;
    await this.withProjectLock(args.项目, async () => {
      await this.#actor(args.subject);
      const rows = await readGoalLedger(goalLogPath(this.layout, args.项目));
      const current = await this.#prepare(action, args, rows);
      if (current.目标id !== plan.目标id || current.输入摘要 !== plan.输入摘要 || (plan.幂等 && (!current.幂等 || current.源摘要 !== plan.源摘要)) || (!current.幂等 && current.源摘要 !== plan.源摘要) || canonical(current.事件) !== canonical(plan.事件)) throw new Denied('持久目标 · 准备结果变化', '目标、证据或修订在准备后已变化，请重读后重新准备；只读回执不能转换为新写。');
      if (current.幂等) {
        await this.#policy('read', current.目标id, args, action);
        result = { ...structuredClone(current.当前目标), 幂等: true };
        return;
      }
      await this.#policy(action === 'goal_create' ? 'create' : 'write', current.目标id, args, action);
      const row = { seq: rows.length + 1, at: this.clock.iso(), by: { id: args.subject.id, kind: args.subject.kind }, ...structuredClone(current.事件) };
      // 与读取者同一校验器承重；任何事件内容错误须在实际落笔前拒绝。
      const goals = foldGoalLedger([...rows, row]);
      await appendLines(goalLogPath(this.layout, args.项目), [row]);
      committed = row;
      result = { ...goalDetail(goals.get(row.id)), ...(action === 'goal_create' ? { 幂等: false } : {}) };
    });
    if (!committed) return result;
    try {
      await this.audit.append({ 动作: action === 'goal_create' ? '新建' : '状态变更', 主体: args.subject, 对象: { id: committed.id, kind: '目标' },
        依据: '目标事件流', 结果: committed.kind, 项目: args.项目, 详情: { 事件: committed.kind, 修订: committed.修订 } });
    } catch (cause) {
      throw new Fault('GOAL_AUDIT_APPEND_FAILED_AFTER_EVENT', '目标事件已落线，但审计未完整收尾；请按目标 id 和修订查询，不要盲重放本次写入。', {
        cause, detail: { id: committed.id, 项目: args.项目, 修订: committed.修订, 事件序号: committed.seq },
        outcome: { 提交状态: '已提交', 可重试: false, 恢复指引: '查询该项目目标 id、修订和事件序号，核对后补记缺失审计；创建的同规范请求可只读认回，其他写入不得按旧修订重放。',
          已确认阶段: [{ 阶段: '目标事件落线', 项目: args.项目, 对象id: committed.id, 事件: committed.kind, 事件序号: committed.seq }] },
      });
    }
    return result;
  }

  #input(action, args, execution) {
    if (!Object.hasOwn(ACTION_FIELDS, action) || !args || typeof args !== 'object') throw new InvalidBody('未知目标领域动作或缺少输入。');
    this.#project(args.项目);
    const allowed = new Set(['subject', '项目', 'action', 'id', 'project', '审批引用', ...(execution ? ['执行计划'] : []), ...ACTION_FIELDS[action]]);
    const unknown = Object.keys(args).filter((key) => !allowed.has(key));
    if (unknown.length) throw new InvalidBody(`目标操作不接受字段：${unknown.join('、')}。来源声明和普通参数不能产生认证或权限。`);
    if ((args.action !== undefined && args.action !== action) || (args.project !== undefined && args.project !== args.项目)) throw new InvalidBody('目标动作或项目与领域操作不一致。');
    if (action !== 'goal_create') {
      bounded(args.id, '目标 id', 256);
      integer(args.修订, 1, Number.MAX_SAFE_INTEGER, '修订');
    } else if (args.id !== undefined) throw new InvalidBody('目标创建 id 由规范请求与可选请求键生成，不能自报。');
  }

  #normalized(action, args) {
    const common = action === 'goal_create' ? {} : { id: args.id, 修订: args.修订 };
    switch (action) {
      case 'goal_create': return { ...common, 期望结果: bounded(args.期望结果, '期望结果', 4000), 约束: list(args.约束 ?? [], '约束'), 禁止工具: tools(args.禁止工具 ?? []), 完成依据: list(args.完成依据, '完成依据', true), 来源: bounded(args.来源, '来源', 2000), 下一步: bounded(args.下一步, '下一步', 2000), 请求键: args.请求键 === undefined ? null : bounded(args.请求键, '请求键', 128) };
      case 'goal_revise': return { ...common, 来源: bounded(args.来源, '来源', 2000), ...(args.期望结果 !== undefined ? { 期望结果: bounded(args.期望结果, '期望结果', 4000) } : {}), ...(args.约束 !== undefined ? { 约束: list(args.约束, '约束') } : {}), ...(args.禁止工具 !== undefined ? { 禁止工具: tools(args.禁止工具) } : {}), ...(args.完成依据 !== undefined ? { 完成依据: list(args.完成依据, '完成依据', true) } : {}) };
      case 'goal_progress':
        if (!['进行中', '等待'].includes(args.状态)) throw new InvalidBody('目标进展状态只允许进行中或等待。');
        if (args.状态 === '进行中' && args.等待原因 !== undefined && args.等待原因 !== null) throw new InvalidBody('进行中不能同时保留等待原因。');
        return { ...common, 状态: args.状态, ...(args.下一步 !== undefined ? { 下一步: bounded(args.下一步, '下一步', 2000) } : {}), 等待原因: args.状态 === '等待' ? bounded(args.等待原因, '等待原因', 2000) : null };
      case 'goal_state':
        if (!['暂停', '取消', '进行中'].includes(args.状态)) throw new InvalidBody('目标决定只允许暂停、取消或恢复进行中。');
        return { ...common, 状态: args.状态 };
      case 'goal_complete': {
        const 证据 = list(args.证据, '证据', true, 256);
        if (!Array.isArray(args.完成核对) || !args.完成核对.length || args.完成核对.length > 32) throw new InvalidBody('完成核对必须逐条对应当前完成依据，最多32项。');
        const 完成核对 = args.完成核对.map((item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some((key) => !['依据', '任务'].includes(key))) throw new InvalidBody('完成核对只接受依据和任务引用。');
          return { 依据: bounded(item.依据, '完成核对依据', 1000), 任务: list(item.任务, '完成核对任务', true, 256) };
        });
        return { ...common, 说明: bounded(args.说明, '说明', 2000), 证据, 完成核对 };
      }
      case 'goal_link_task': return { ...common, 任务: bounded(args.任务, '任务', 256) };
    }
  }

  async #prepare(action, args, rows) {
    const input = this.#normalized(action, args);
    const snapshot = goalSnapshotOf(rows, args.项目);
    const goals = new Map(snapshot.目标.map((goal) => [goal.id, goal]));
    let id = input.id;
    let current;
    let event;
    let 幂等 = false;
    if (action === 'goal_create') {
      const 规范摘要 = digest(canonical(input));
      id = `goal-${digest(canonical({ 项目: args.项目, 主体: args.subject.id, 请求键: input.请求键 ?? 规范摘要 })).slice(0, 24)}`;
      current = goals.get(id);
      event = { kind: 'goal_created', id, 修订: 1, 期望结果: input.期望结果, 约束: input.约束, 禁止工具: input.禁止工具, 完成依据: input.完成依据,
        来源声明: { 内容: input.来源, 用户意图: '未核验' }, 下一步: input.下一步, 状态: '进行中', 请求键: input.请求键, 创建规范摘要: 规范摘要 };
      if (current) {
        const created = rows.find((row) => row.id === id && row.kind === 'goal_created');
        const payload = Object.fromEntries(Object.keys(event).map((key) => [key, created?.[key]]));
        if (canonical(payload) !== canonical(event) || created.by.id !== args.subject.id || created.by.kind !== args.subject.kind) throw new Denied('持久目标 · 创建请求冲突', '该请求键已创建不同目标，不能覆盖或重建。');
        幂等 = true;
      }
    } else {
      current = goals.get(id);
      if (!current) throw new InvalidBody(`没有这个目标：${id}`);
      if (current.修订 !== input.修订) throw new Denied('持久目标 · 修订冲突', `目标当前修订为 ${current.修订}，收到 ${input.修订}；请重读后再写。`);
      if (['取消', '已完成'].includes(current.状态)) throw new Denied('持久目标 · 终态只读', '取消或已完成目标不能恢复或继续写入；需新建目标并显式引用旧成果。');
      event = { kind: EVENT_KIND[action], id, 修订: current.修订 + 1 };
      if (action === 'goal_revise') {
        const result = { 期望结果: input.期望结果 ?? current.期望结果, 约束: input.约束 ?? current.约束, 禁止工具: input.禁止工具 ?? current.禁止工具, 完成依据: input.完成依据 ?? current.完成依据 };
        if (args.subject.kind === 'Lead' && (result.期望结果 !== current.期望结果 || canonical(result.完成依据) !== canonical(current.完成依据) || current.约束.some((value) => !result.约束.includes(value)) || current.禁止工具.some((tool) => !result.禁止工具.includes(tool)))) throw new Denied('持久目标 · 用户意图不可代改', 'Lead 只能增加约束和禁止工具，不能更改期望结果、完成依据或移除既有限制。', { requireAuthority: '主权者' });
        Object.assign(event, result, { 来源声明: { 内容: input.来源, 用户意图: '未核验' } });
      } else if (action === 'goal_state') {
        if (args.subject.kind !== '主权者') throw new Denied('持久目标 · 用户状态决定', '暂停、取消或恢复目标只接受真实主权者。', { requireAuthority: '主权者' });
        event.状态 = input.状态;
      } else if (action === 'goal_progress') {
        if (!['进行中', '等待'].includes(current.状态)) throw new Denied('持久目标 · 暂停不能代恢复', 'Lead 进展不能恢复用户暂停的目标。', { requireAuthority: '主权者' });
        Object.assign(event, { 状态: input.状态, 下一步: input.下一步 ?? current.下一步, 等待原因: input.等待原因 });
      } else if (action === 'goal_link_task') {
        const nodes = await this.#taskNodes(args.项目);
        if (!nodes.has(input.任务)) throw new InvalidBody('关联任务必须在本项目真实存在。');
        const direct = snapshot.任务归属[input.任务];
        if (direct && direct !== id) throw new Denied('持久目标 · 单任务唯一目标', '该任务已关联其他目标，不能转移或复制归属。');
        const candidate = structuredClone(snapshot);
        candidate.任务归属[input.任务] = id;
        candidate.任务关联[input.任务] = { 任务: input.任务, 目标: id, 关联修订: event.修订 };
        // 同时校验后代，防止先绑后继、再把前序绑到另一目标。
        for (const node of nodes.values()) constraintsForTaskInSnapshot(node, nodes, candidate);
        event.任务 = input.任务;
      } else if (action === 'goal_complete') {
        if (!['进行中', '等待'].includes(current.状态)) throw new Denied('持久目标 · 暂停不能完成', '用户暂停的目标不能由完成判断代为恢复。');
        const checks = input.完成核对;
        if (new Set(checks.map((item) => item.依据)).size !== checks.length || checks.length !== current.完成依据.length || current.完成依据.some((criterion) => !checks.some((item) => item.依据 === criterion)) || checks.some((item) => item.任务.some((task) => !input.证据.includes(task))) || input.证据.some((task) => !checks.some((item) => item.任务.includes(task)))) throw new InvalidBody('完成核对必须精确覆盖每条当前完成依据，且所有证据都被引用；引用不能超出证据清单。');
        const nodes = await this.#taskNodes(args.项目);
        const facts = [];
        for (const taskId of input.证据) {
          const node = nodes.get(taskId);
          if (!node || constraintsForTaskInSnapshot(node, nodes, snapshot)?.目标 !== id || !已被合法采纳(node)) throw new Denied('持久目标 · 完成证据不足', `任务 ${taskId} 不是本目标已关联且合法采纳的证据。`);
          const 交付物摘要 = await verifyArtifactManifest(node.交付物清单, artifactReferences(node), { layout: this.layout, policy: this.policy, subject: args.subject, task: { ...node, 项目: args.项目 }, fileAuthority: this.tasks.toolFileAuthority?.() });
          if (交付物摘要 !== node.采纳.交付物摘要) throw new Denied('持久目标 · 证据未绑定原采纳内容', '当前交付物清单没有绑定原合法采纳事实，不能用新的清单替代已采纳成果。');
          facts.push({ 任务: taskId, 交付物摘要, 采纳依据: node.采纳.依据, 票: node.采纳.票 ?? null, 代: node.代 ?? 1 });
        }
        Object.assign(event, { 说明: input.说明, 证据: input.证据, 完成核对: checks, 证据事实: facts });
      }
    }
    const policyAction = 幂等 ? 'read' : action === 'goal_create' ? 'create' : 'write';
    const preview = { ...(current ? { 当前目标: goalDetail(current) } : {}), ...structuredClone(event), 来源口径: '来源只是调用者声明，用户意图未核验；不产生认证或授权', ...(action === 'goal_complete' ? { 完成口径: '主体基于证据的判断，不是机器证明目标语义' } : {}) };
    return { 版本: 1, 动作: action, 项目: args.项目, 主体: { id: args.subject.id, kind: args.subject.kind }, 目标id: id, 预期修订: current?.修订 ?? 0,
      输入摘要: digest(canonical(input)), 源摘要: current ? digest(canonical(current)) : null, 幂等, 当前目标: current ? goalDetail(current) : null, 事件: event, 预览: preview,
      步骤: [{ 动作: policyAction, 目标: this.#target(id, args.项目), ...(policyAction === 'write' ? { 写: action, 上下文: { 介入写: action } } : {}), 说明: 幂等 ? '读取已有目标创建回执' : action, 预览: preview }] };
  }

  async #taskNodes(project) {
    if (!this.tasks || typeof this.tasks.list !== 'function') throw new Fault('GOAL_TASK_SOURCE_UNAVAILABLE', '未接入任务真源，不能关联或完成目标。');
    return new Map((await this.tasks.list({ 项目: project })).map((node) => [node.id, node]));
  }
  #target(id, project) { return { id, kind: '目标', authority: '自治', zone: '私有', domain: '集体', project }; }
  #policy(action, id, args, operation) { return this.policy.check({ subject: args.subject, action, target: this.#target(id, args.项目), context: { 介入写: operation } }); }
  #project(value) { if (typeof value !== 'string' || !value.trim()) throw new InvalidBody('目标需要明确项目。'); }
  async #actor(subject) {
    if (typeof subject?.id !== 'string' || !subject.id.trim() || !['Lead', '主权者'].includes(subject.kind)) throw new Denied('持久目标 · 治理读写资格', '目标当前只向真实 Lead 或主权者开放，来源、role 或认证参数不能代替身份。');
    if (subject.kind === 'Lead') {
      if (!this.registry?.identity) throw new Fault('GOAL_IDENTITY_UNAVAILABLE', '缺少目标治理的真实身份源。');
      const member = (await this.registry.identity()).members?.[subject.id];
      if (member?.岗位 !== 'Lead' || member.status !== '在岗') throw new Denied('持久目标 · 治理读写资格', '当前主体不是在册在岗 Lead。');
    }
  }
}

function bounded(value, name, max) { if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new InvalidBody(`${name} 必须是1至${max}字符的文本。`); return value.trim(); }
function integer(value, min, max, name) { if (!Number.isSafeInteger(value) || value < min || value > max) throw new InvalidBody(`${name} 必须是${min}至${max}的整数。`); return value; }
function list(value, name, required = false, maxText = 1000) { if (!Array.isArray(value) || value.length > 32 || (required && !value.length)) throw new InvalidBody(`${name} 必须是${required ? '1' : '0'}至32项的文本数组。`); return [...new Set(value.map((item) => bounded(item, name, maxText)))]; }
function tools(value) { const result = list(value, '禁止工具'); if (result.some((tool) => !GOAL_NATIVE_TOOLS.includes(tool))) throw new InvalidBody(`禁止工具只接受精确原生工具：${GOAL_NATIVE_TOOLS.join('、')}。`); return result; }
function withoutPlan(value) { const { 执行计划: _plan, ...rest } = value; return rest; }
function deepFreeze(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; }
function goalSummary(goal) { return { id: goal.id, 修订: goal.修订, 状态: goal.状态, 期望结果摘要: goal.期望结果.slice(0, 240), 下一步摘要: goal.下一步.slice(0, 240), 约束数: goal.约束.length, 禁止工具: [...goal.禁止工具], 完成依据数: goal.完成依据.length, 关联任务数: goal.任务关联.length, 用户意图: '未核验', 更新于: goal.更新于 }; }
function goalDetail(goal) {
  const { 来源历史, 状态历史, 任务关联, ...current } = structuredClone(goal);
  return { ...current, 来源历史: 来源历史.slice(-10), 来源历史总数: 来源历史.length, 来源历史截断: 来源历史.length > 10, 状态历史: 状态历史.slice(-10), 状态历史总数: 状态历史.length, 状态历史截断: 状态历史.length > 10,
    任务关联: 任务关联.slice(-50), 关联任务总数: 任务关联.length, 任务关联截断: 任务关联.length > 50, 硬约束完整: true };
}
