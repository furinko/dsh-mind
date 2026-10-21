/** 真实宿主frame的只读用量观察。记录入口仅供宿主内部调用，不能被模型用来造数。 */
import { appendLines, serializeByKey, withLock } from './kernel/fsx.js';
import { canonical } from './kernel/text.js';
import { Denied, Fault, InvalidBody } from './kernel/errors.js';
import { MODEL_USAGE_FIELDS, modelUsageLogPath, modelUsageLockPath, validateModelUsageEvent, foldModelUsageLedger, readModelUsageLedger, readModelUsageLedgerSync } from './model-usage-ledger.js';

export const MODEL_USAGE_COVERAGE = Object.freeze({ 来源: '观察到的宿主frame',
  范围: '仅当前观察窗口；历史、辅助模型调用和中途丢帧未完整覆盖。',
  快照: '每次尝试只采用最高合法index的最后一份usage，不逐样本相加。',
  缓存: 'SDK input为未缓存输入，cacheRead/cacheWrite分开报告；reasoning属于output，不再次加入。',
  归因: '按起始活动绑定归类并冻结，不证明模型请求语义或计费归属；未知保持未归因，不验证原会话正文或重新推断用户意图。',
  路由: '配置路由不代表远端实际计费路由。',
  计费: '缺失total不推算，不推算费用；不是完整审计、准入额度或权限依据。' });

export class ModelUsageService {
  constructor({ layout, policy, clock, registry, goals }) { Object.assign(this, { layout, policy, clock, registry, goals }); }

  recordStart(spec) { return this.#record('start', spec); }
  recordSample(spec) { return this.#record('sample', spec); }
  recordEnd(spec) { return this.#record('end', spec); }

  /** 内部严格全量真源；返回值修改不影响后续观察。 */
  rawSnapshot(project) {
    preciseText(project, '项目');
    const file = modelUsageLogPath(this.layout, project);
    return { 项目: project, 尝试: [...foldModelUsageLedger(readModelUsageLedgerSync(file, project), project, file).values()] };
  }

  /** 工作台安全读面；坏账或不可表示的和明确不可用，不把错误/未知当0。 */
  summary(project, goalId = undefined) {
    try {
      if (goalId !== undefined) preciseText(goalId, '目标id');
      const attempts = select(this.rawSnapshot(project).尝试, goalId);
      return envelope(project, goalId, aggregate(attempts));
    } catch (error) {
      return { 项目: project, 目标: goalId ?? null, 健康: '不可用', 不可用原因: { code: error?.code ?? 'MODEL_USAGE_UNAVAILABLE', 说明: '用量真源不可读取或汇总不可用；未以空记录替代。' }, 覆盖口径: MODEL_USAGE_COVERAGE, 完整: false, token: null, 费用: null, 汇总: unknownAggregate() };
    }
  }

  /** 带读者的工作台复用治理读边界；此投影不追加查询审计或观测事实。 */
  async summaryFor({ subject, 项目 } = {}) {
    try {
      preciseText(项目, '项目');
      await this.#reader(subject);
      if (typeof this.policy?.refreshIfStale !== 'function' || typeof this.policy?.decideCurrentSync !== 'function') return null;
      await this.policy.refreshIfStale();
      const decision = this.policy.decideCurrentSync({ subject, action: 'read', target: this.#readTarget(undefined, 项目), context: {} });
      if (decision?.verdict !== 'allow') return null;
      return this.summary(项目);
    } catch { return null; }
  }

  async query(spec) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new InvalidBody('用量查询需要结构化参数。');
    const bad = Object.keys(spec).filter((key) => !['subject', '项目', 'id', '条数', '偏移'].includes(key));
    if (bad.length) throw new InvalidBody(`用量查询不接受字段：${bad.join('、')}；模型不能声明帧、usage、身份来源或计费。`);
    preciseText(spec.项目, '项目');
    if (spec.id !== undefined) preciseText(spec.id, '目标id');
    const limit = spec.条数 ?? 20;
    const offset = spec.偏移 ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger(offset) || offset < 0) throw new InvalidBody('条数必须为1至50，偏移必须是非负安全整数。');
    await this.#reader(spec.subject);
    if (typeof this.policy?.check !== 'function') throw new Fault('MODEL_USAGE_POLICY_UNAVAILABLE', '用量查询缺少当前策略引擎。');
    await this.policy.check({ subject: spec.subject, action: 'read', target: this.#readTarget(spec.id, spec.项目), context: {} });
    if (spec.id !== undefined) {
      if (!this.goals?.rawSnapshot) throw new Fault('MODEL_USAGE_GOAL_SOURCE_UNAVAILABLE', '按目标查询缺少目标真源，不能信任调用者自报归因。');
      if (!this.goals.rawSnapshot(spec.项目).目标.some((goal) => goal.id === spec.id)) throw new InvalidBody('按目标查询必须引用同一项目真实存在的目标。');
    }
    const file = modelUsageLogPath(this.layout, spec.项目);
    const rows = await readModelUsageLedger(file, spec.项目);
    const all = select([...foldModelUsageLedger(rows, spec.项目, file).values()], spec.id);
    const ordered = [...all].sort((a, b) => b.起始事件序号 - a.起始事件序号);
    return { ...envelope(spec.项目, spec.id, aggregate(all)), 尝试页: { 条目: ordered.slice(offset, offset + limit).map(attemptView), 总数: all.length, 条数: limit, 偏移: offset, hasMore: offset + limit < all.length } };
  }

  async #record(kind, spec) {
    validateModelUsageEvent(kind, spec);
    // 在第一个await前复制：排队期间身份、目标和调用者对象变化不能迁移既有帧。
    const frozen = structuredClone(spec);
    const file = modelUsageLogPath(this.layout, frozen.项目);
    return serializeByKey(file, () => withLock(modelUsageLockPath(this.layout, frozen.项目), async () => {
      const rows = await readModelUsageLedger(file, frozen.项目);
      const attempts = foldModelUsageLedger(rows, frozen.项目, file);
      const current = attempts.get(frozen.执行键);
      const old = rows.find((row) => row.执行键 === frozen.执行键 && row.kind === kind && (kind !== 'sample' || row.index === frozen.index));
      if (old) {
        if (canonical(payload(old)) !== canonical(frozen)) throw new Denied('模型用量 · 同源观察冲突', '同一执行键与帧位置已保存不同的结构或usage，不能覆盖、迁移或重复计量。');
        return receipt(frozen.执行键, old.seq, current.状态, true);
      }
      if (kind === 'start') {
        if ([...attempts.values()].some((attempt) => attempt.会话 === frozen.会话 && attempt.生命周期 === frozen.生命周期 && attempt.attemptId === frozen.attemptId)) throw new Denied('模型用量 · 尝试执行键迁移', '同一会话生命周期的宿主attempt已绑定另一执行键，不能作为新用量再记一次。');
      } else {
        if (!current) throw new Denied('模型用量 · 缺少起始观察', '没有本执行键的真实起始观察，不能补造样本或结束。');
        if (current.状态 !== 'open') throw new Denied('模型用量 · 尝试已经结束', '已结束尝试不能追加新样本或另一结束事实，旧用量仍保留。');
        if (frozen.revision <= current.revision || frozen.index <= current.最高样本index) throw new Denied('模型用量 · 乱序观察', 'revision必须高于本尝试上笔观察，样本index须前进，结束index须大于已有样本。');
      }
      const row = { seq: rows.length + 1, at: this.clock.iso(), kind, ...frozen };
      const next = foldModelUsageLedger([...rows, row], frozen.项目, file).get(frozen.执行键);
      // 单独使用用量锁，不取得目标/任务锁，不调用policy/audit/registry；采集失败由宿主隔离。
      await appendLines(file, [row]);
      return receipt(frozen.执行键, row.seq, next.状态, false);
    }));
  }

  async #reader(subject) {
    if (typeof subject?.id !== 'string' || !subject.id.trim() || !['Lead', '主权者'].includes(subject.kind)) throw new Denied('模型用量 · 治理读资格', '模型用量只向当前真实Lead或主权者开放，成员和自报认证不能扩大读域。');
    if (subject.kind === 'Lead') {
      if (!this.registry?.identity || !this.registry?.cardOf) throw new Fault('MODEL_USAGE_IDENTITY_UNAVAILABLE', '缺少真实Lead身份或卡凭证真源。');
      const member = (await this.registry.identity()).members?.[subject.id];
      if (member?.岗位 !== 'Lead' || member.status !== '在岗' || (await this.registry.cardOf(subject.id))?.就绪 !== true) throw new Denied('模型用量 · 治理读资格', '当前主体不是在册、在岗且卡凭证就绪的Lead。');
    }
  }
  #readTarget(id, project) { return { id: id ?? 'model-usage', kind: '模型用量', authority: '自治', zone: '私有', domain: '集体', project }; }
}

function payload(row) { const { seq: _seq, at: _at, kind: _kind, ...value } = row; return value; }
function receipt(key, seq, state, repeated) { return { 执行键: key, 事件序号: seq, 状态: state, 幂等: repeated }; }
function preciseText(value, name) { if (typeof value !== 'string' || !value || value.trim() !== value || value.length > 256) throw new InvalidBody(`${name}必须是1至256字符的精确标识。`); }
function select(attempts, goalId) { return goalId === undefined ? attempts : attempts.filter((attempt) => attempt.归因.目标 === goalId); }
function attemptView(attempt) {
  const { 样本, ...rest } = structuredClone(attempt);
  const known = MODEL_USAGE_FIELDS.filter((field) => attempt.usage !== null && Object.hasOwn(attempt.usage, field));
  const last = 样本.at(-1);
  return { ...rest, usage: attempt.usage === null ? null : Object.fromEntries(MODEL_USAGE_FIELDS.map((field) => [field, attempt.usage[field] ?? null])), 样本数: 样本.length,
    已知字段: known, 缺失字段: MODEL_USAGE_FIELDS.filter((field) => !known.includes(field)), 最后用量index: last?.index ?? null, 最后用量revision: last?.revision ?? null, 最后用量time: last?.time ?? null, 来源: '观察到的宿主frame', 完整: false };
}
function aggregate(attempts) {
  const fields = {};
  const coverage = {};
  const unavailable = [];
  for (const field of MODEL_USAGE_FIELDS) {
    let total = 0n;
    let known = 0;
    for (const attempt of attempts) if (attempt.usage !== null && Object.hasOwn(attempt.usage, field)) { total += BigInt(attempt.usage[field]); known += 1; }
    const overflow = total > BigInt(Number.MAX_SAFE_INTEGER);
    fields[field] = !known || overflow ? null : Number(total);
    coverage[field] = { 已知: known, 缺失: attempts.length - known };
    if (overflow) unavailable.push(field);
  }
  return { 尝试: attempts.length, 已结束: attempts.filter((attempt) => attempt.状态 === 'ended').length, 未结束: attempts.filter((attempt) => attempt.状态 === 'open').length,
    有用量: attempts.filter((attempt) => attempt.usage !== null).length, 无用量: attempts.filter((attempt) => attempt.usage === null).length, 未归因: attempts.filter((attempt) => attempt.归因.目标 === null).length,
    已报告token: fields, 字段覆盖: coverage, 不可用字段: unavailable };
}
function unknownAggregate() { return { 尝试: null, 已结束: null, 未结束: null, 有用量: null, 无用量: null, 未归因: null, 已报告token: Object.fromEntries(MODEL_USAGE_FIELDS.map((field) => [field, null])), 字段覆盖: Object.fromEntries(MODEL_USAGE_FIELDS.map((field) => [field, { 已知: null, 缺失: null }])), 不可用字段: [] }; }
function envelope(project, goalId, summary) { return { 项目: project, 目标: goalId ?? null, 健康: summary.不可用字段.length ? '不可用' : '可用', ...(summary.不可用字段.length ? { 不可用原因: { code: 'MODEL_USAGE_SUM_OVERFLOW', 说明: '部分SDK字段的已报告值和超过安全整数范围，该字段不可用，未截断或假报数值。' } } : {}), 覆盖口径: MODEL_USAGE_COVERAGE, 完整: false, token: null, 费用: null, 汇总: summary }; }
