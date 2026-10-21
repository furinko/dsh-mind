/** 持久成员创建意图：首次意图才可创建，已有意图从不重新签发宿主调用许可。 */
import { randomUUID } from 'node:crypto';
import { appendLines, serializeByKey, withLock } from './kernel/fsx.js';
import { canonical } from './kernel/text.js';
import { Denied, Fault, InvalidBody } from './kernel/errors.js';
import { SPAWN_OPERATION_STAGES, SPAWN_OPERATION_RECORDER, spawnOperationText, spawnOperationUUID, spawnOperationLogPath, spawnOperationLockPath, validateSpawnOperationReceipt, validateSpawnOperationIssue, foldSpawnOperationLedger, readSpawnOperationLedger, readSpawnOperationLedgerSync } from './spawn-operation-ledger.js';
export { SPAWN_OPERATION_ISSUE_CODES } from './spawn-operation-ledger.js';

export const SPAWN_OPERATION_COVERAGE = Object.freeze({ 来源: '本组件受管成员创建入口的意图及内部观察到的阶段回执',
  范围: '仅覆盖已落线记录；历史、未接入入口、崩溃及缺失回执未完整覆盖。没有记录不证明宿主没有创建。',
  预留: '拟用实例仅为服务器预留标识，不证明宿主已创建；重复意图不重新签发创建许可。',
  阶段: 'audited仅表示创建宏审计完成，不表示成员执行、任务或目标完成。缺失阶段保持未知，不补签、不推断停止。',
  问题: '问题是内部模块报告，不认证底层事实；操作页仅返回最近5条问题，并给出总数与截断标记。',
  持久性: '采用本地文件追加和互斥锁，不声称fsync、掉电恰好一次或检测合法删除与回滚；不提供自动重放或清零。' });

export class SpawnOperationService {
  constructor({ layout, clock, policy, registry }) { Object.assign(this, { layout, clock, policy, registry }); }

  /** 内部首次许可；模型动作没有begin入口，也不能用查询回执充当宿主执行许可。 */
  async begin(spec) {
    input(spec, ['项目', 'subject', '任务', '方式', '请求摘要']);
    preciseText(spec.项目, '项目'); preciseText(spec.任务, '任务');
    if (!['subagent', 'team'].includes(spec.方式) || typeof spec.请求摘要 !== 'string' || !/^[a-f0-9]{64}$/.test(spec.请求摘要)) throw new InvalidBody('创建意图只接受subagent/team与精确SHA-256请求摘要。');
    // 排队前固定主体和请求；排队期间调用者修改对象不能迁移已准备的意图。
    const args = structuredClone(spec);
    return this.#locked(args.项目, async (file) => {
      const actor = await this.#creator(args.subject, args.任务);
      await this.#check(args.subject, { id: args.任务, kind: '任务', authority: '自治', zone: '私有', domain: '集体', project: args.项目 });
      const rows = await readSpawnOperationLedger(file, args.项目);
      const operations = foldSpawnOperationLedger(rows, args.项目, file);
      const prior = [...operations.values()].find((item) => item.任务 === args.任务);
      if (prior) {
        if (canonical(prior.发起主体) !== canonical(actor) || prior.方式 !== args.方式 || prior.请求摘要 !== args.请求摘要) throw new Denied('成员创建操作 · 同任务已有意图', '该任务已有不同主体或请求的创建意图；不能再次创建、覆盖或自动重放。', { detail: { 操作id: prior.操作id, 项目: prior.项目, 任务: prior.任务, 状态: prior.状态, 可创建: false }, howToChange: '先按操作id查询并核对宿主和任务事实；本组件不提供清零或人工补签。' });
        return beginReceipt(prior, false, true);
      }
      const event = { seq: rows.length + 1, at: this.clock.iso(), by: actor, kind: 'intent', 项目: args.项目, 操作id: randomUUID(), 任务: args.任务, 方式: args.方式, 请求摘要: args.请求摘要, 拟用实例: args.方式 === 'subagent' ? randomUUID() : null };
      const next = foldSpawnOperationLedger([...rows, event], args.项目, file).get(event.操作id);
      await this.#append(file, event);
      return beginReceipt(next, true, false);
    });
  }

  /** 诊断附记不推进创建阶段，也不清除意图栅栏或补签底层事实。 */
  async recordIssue(spec) {
    input(spec, ['项目', '操作id', '故障码', '已确认阶段']);
    preciseText(spec.项目, '项目'); operationId(spec.操作id);
    validateSpawnOperationIssue(spec.故障码, spec.已确认阶段);
    const args = structuredClone(spec);
    return this.#locked(args.项目, async (file) => {
      const rows = await readSpawnOperationLedger(file, args.项目);
      const current = foldSpawnOperationLedger(rows, args.项目, file).get(args.操作id);
      if (!current) throw new Denied('成员创建操作 · 问题缺少意图', '没有该项目与操作id的持久意图，不能附加问题或替它建立执行凭据。');
      const old = current.问题.find((issue) => issue.故障码 === args.故障码);
      if (old) {
        if (canonical(old.已确认阶段) !== canonical(args.已确认阶段)) throw new Denied('成员创建操作 · 问题报告冲突', '同故障码已保存不同安全回执，不能覆盖旧报告或伪造更新事实。');
        return { ...recordReceipt(current, 'issue', old.事件序号, true), 故障码: args.故障码 };
      }
      if (args.已确认阶段.some((receipt) => (Object.hasOwn(receipt, '项目') && receipt.项目 !== current.项目) || (Object.hasOwn(receipt, '任务') && receipt.任务 !== current.任务) || (Object.hasOwn(receipt, '操作id') && receipt.操作id !== current.操作id) || (Object.hasOwn(receipt, '拟用实例') && receipt.拟用实例 !== current.拟用实例))) throw new Denied('成员创建操作 · 问题归属冲突', '问题报告的项目、任务、操作和拟用实例必须与已有意图相符。');
      const event = { seq: rows.length + 1, at: this.clock.iso(), by: { ...SPAWN_OPERATION_RECORDER }, kind: 'issue', ...args };
      const next = foldSpawnOperationLedger([...rows, event], args.项目, file).get(args.操作id);
      await this.#append(file, event);
      return { ...recordReceipt(next, 'issue', event.seq, false), 故障码: args.故障码 };
    });
  }

  /** 内部可信事实记录。旧身份撤回后仍允许迟到回执，不把它伪签成旧Lead的新动作。 */
  async record(spec) {
    input(spec, ['项目', '操作id', '阶段', '回执']);
    preciseText(spec.项目, '项目'); operationId(spec.操作id);
    validateSpawnOperationReceipt(spec.阶段, spec.回执);
    const args = structuredClone(spec);
    return this.#locked(args.项目, async (file) => {
      const rows = await readSpawnOperationLedger(file, args.项目);
      const current = foldSpawnOperationLedger(rows, args.项目, file).get(args.操作id);
      if (!current) throw new Denied('成员创建操作 · 缺少创建意图', '没有该项目与操作id的持久创建意图，不能补造后续阶段。');
      const old = current.阶段.find((item) => item.阶段 === args.阶段);
      if (old) {
        if (canonical(old.回执) !== canonical(args.回执)) throw new Denied('成员创建操作 · 阶段回执冲突', '同一阶段已保存不同回执，不能覆盖、换实例、换任务或补签。');
        return recordReceipt(current, args.阶段, old.事件序号, true);
      }
      if (SPAWN_OPERATION_STAGES[current.阶段.length - 1] !== args.阶段) throw new Denied('成员创建操作 · 阶段顺序', '阶段必须按宿主返回、登记、绑定、派发、消息接收、宏审计顺序记录；未知阶段不得推断。');
      const host = current.阶段.find((item) => item.阶段 === 'host_returned')?.回执;
      if ((args.阶段 === 'host_returned' ? current.方式 === 'subagent' && args.回执.实例 !== current.拟用实例 : Object.hasOwn(args.回执, '实例') && args.回执.实例 !== host?.实例) || (Object.hasOwn(args.回执, '任务') && args.回执.任务 !== current.任务)) throw new Denied('成员创建操作 · 阶段归属冲突', '宿主实例必须匹配预留标识，后续实例和任务须与已有意图及宿主回执一致。');
      const event = { seq: rows.length + 1, at: this.clock.iso(), by: { ...SPAWN_OPERATION_RECORDER }, kind: 'stage', 项目: args.项目, 操作id: args.操作id, 阶段: args.阶段, 回执: args.回执 };
      const next = foldSpawnOperationLedger([...rows, event], args.项目, file).get(args.操作id);
      await this.#append(file, event);
      return recordReceipt(next, args.阶段, event.seq, false);
    });
  }

  rawSnapshot(project) {
    preciseText(project, '项目');
    const file = spawnOperationLogPath(this.layout, project);
    return { 项目: project, 操作: [...foldSpawnOperationLedger(readSpawnOperationLedgerSync(file, project), project, file).values()] };
  }
  findByTask(project, taskId) { preciseText(taskId, '任务'); return this.rawSnapshot(project).操作.find((item) => item.任务 === taskId) ?? null; }

  summary(project) {
    try { return envelope(project, aggregate(this.rawSnapshot(project).操作)); }
    catch (error) { return { 项目: project, 健康: '不可用', 不可用原因: { code: error?.code ?? 'SPAWN_OPERATION_UNAVAILABLE', 说明: '成员创建真源不可读；未将故障当作没有创建意图。' }, 覆盖口径: SPAWN_OPERATION_COVERAGE, 完整: false, 汇总: Object.fromEntries(['操作', '未收尾', '已审计', '已见宿主回执', '仅有意图', '有问题操作', '问题记录'].map((key) => [key, null])) }; }
  }
  async summaryFor({ subject, 项目 } = {}) {
    try {
      preciseText(项目, '项目');
      await this.#reader(subject);
      if (typeof this.policy?.refreshIfStale !== 'function' || typeof this.policy?.decideCurrentSync !== 'function') return null;
      await this.policy.refreshIfStale();
      if (this.policy.decideCurrentSync({ subject, action: 'read', target: this.#target(undefined, 项目), context: {} })?.verdict !== 'allow') return null;
      return this.summary(项目);
    } catch { return null; }
  }
  async query(spec) {
    input(spec, ['subject', '项目', 'id', '任务', '条数', '偏移'], ['subject', '项目']);
    preciseText(spec.项目, '项目');
    if (spec.id !== undefined) operationId(spec.id);
    if (spec.任务 !== undefined) preciseText(spec.任务, '任务');
    const limit = spec.条数 ?? 20; const offset = spec.偏移 ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger(offset) || offset < 0) throw new InvalidBody('条数必须为1至50，偏移必须为非负安全整数。');
    const args = structuredClone(spec);
    await this.#reader(args.subject);
    await this.#check(args.subject, this.#target(args.id, args.项目));
    const file = spawnOperationLogPath(this.layout, args.项目);
    const all = [...foldSpawnOperationLedger(await readSpawnOperationLedger(file, args.项目), args.项目, file).values()].filter((item) => (args.id === undefined || item.操作id === args.id) && (args.任务 === undefined || item.任务 === args.任务));
    const ordered = [...all].sort((a, b) => b.起始事件序号 - a.起始事件序号);
    return { ...envelope(args.项目, aggregate(all)), 操作页: { 条目: ordered.slice(offset, offset + limit).map(operationView), 总数: all.length, 条数: limit, 偏移: offset, hasMore: offset + limit < all.length } };
  }

  #locked(project, fn) { const file = spawnOperationLogPath(this.layout, project); return serializeByKey(file, () => withLock(spawnOperationLockPath(this.layout, project), () => fn(file))); }
  #target(id, project) { return { id: id ?? 'spawn-operations', kind: '成员创建操作', authority: '自治', zone: '私有', domain: '集体', project }; }
  #check(subject, target) { if (typeof this.policy?.check !== 'function') throw new Fault('SPAWN_OPERATION_POLICY_UNAVAILABLE', '成员创建操作缺少当前策略引擎。'); return this.policy.check({ subject, action: 'read', target, context: {} }); }
  async #reader(subject) {
    if (!spawnOperationText(subject?.id) || !['Lead', '主权者'].includes(subject.kind)) throw new Denied('成员创建操作 · 治理读资格', '创建操作只向当前真实Lead或主权者开放，成员、复核员和声明文本不能扩大读域。');
    if (subject.kind === 'Lead') {
      if (!this.registry?.identity || !this.registry?.cardOf) throw new Fault('SPAWN_OPERATION_IDENTITY_UNAVAILABLE', '缺少真实Lead身份或卡凭证真源。');
      const member = (await this.registry.identity()).members?.[subject.id];
      if (member?.岗位 !== 'Lead' || member.status !== '在岗' || (subject.roleId !== undefined && subject.roleId !== 'Lead') || (await this.registry.cardOf(subject.id))?.就绪 !== true) throw new Denied('成员创建操作 · 治理读资格', '当前主体不是在册、在岗且卡凭证就绪的Lead。');
    }
  }
  async #creator(subject, taskId) {
    if (!spawnOperationText(subject?.id) || subject.kind !== 'Lead') throw new Denied('成员创建操作 · 发起资格', '只有当前真实Lead可以记录新的创建意图；该记录不产生原动作授权。');
    if (!this.registry?.identity || !this.registry?.cardOf || typeof this.policy?.refreshIfStale !== 'function') throw new Fault('SPAWN_OPERATION_IDENTITY_UNAVAILABLE', '缺少真实身份、卡凭证或当前策略，不能新增意图。');
    await this.policy.refreshIfStale();
    if (!this.policy.healthy) throw new Fault('SPAWN_OPERATION_POLICY_UNAVAILABLE', '当前策略不健康，停止新增创建意图。');
    if (this.policy.presence?.().lost !== false) throw new Denied('成员创建操作 · 当前写冻结', '主权者失联或失联资格不可确认，不能新增创建意图。');
    const identity = await this.registry.identity();
    const member = identity.members?.[subject.id];
    if (member?.岗位 !== 'Lead' || member.status !== '在岗' || (subject.roleId !== undefined && subject.roleId !== 'Lead') || (await this.registry.cardOf(subject.id))?.就绪 !== true) throw new Denied('成员创建操作 · 当前实例凭证', '当前Lead不在岗、岗位自报不符或真实卡凭证失效，不能新增创建意图。');
    if (!Array.isArray(identity.denylist) || identity.denylist.some((entry) => [subject.id, 'Lead', taskId].includes(entry?.id))) throw new Denied('成员创建操作 · 当前撤回资格', 'Lead、岗位或任务已撤回，或拒绝名单不可判，不能新增创建意图。');
    return { id: subject.id, kind: 'Lead' };
  }
  async #append(file, row) {
    try { await appendLines(file, [row]); }
    catch (cause) { throw new Fault('SPAWN_OPERATION_APPEND_FAILED', '创建操作追加未获得完整成功回执，是否落线未知；不得据此调用宿主或盲重试。', { cause,
      detail: { 项目: row.项目, 操作id: row.操作id, ...(row.任务 ? { 任务: row.任务 } : {}), 阶段: row.kind === 'intent' ? 'intent' : row.阶段 },
      outcome: { 提交状态: '未知', 可重试: false, 恢复指引: '严格查询本项目创建操作账本并核对宿主事实；已有意图不重新签发创建许可，阶段缺失不自动补签。',
        已确认阶段: [{ 阶段: row.kind === 'intent' ? '拟用创建意图，追加未确认且未取得放行' : '阶段或问题追加未确认', 项目: row.项目, 操作id: row.操作id, ...(row.任务 ? { 任务: row.任务 } : {}), ...(row.拟用实例 !== undefined && row.拟用实例 !== null ? { 拟用实例: row.拟用实例 } : {}) }] } }); }
  }
}

function input(value, allowed, required = allowed) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) throw new InvalidBody('成员创建操作参数缺失或含未知字段；不接受模型声明阶段、认证、任务书或重放许可。'); }
function preciseText(value, name) { if (!spawnOperationText(value)) throw new InvalidBody(`${name}必须为1至256字符的精确标识。`); }
function operationId(value) { if (!spawnOperationUUID(value)) throw new InvalidBody('操作id必须是规范UUID。'); }
function beginReceipt(operation, allow, repeated) { return { 操作id: operation.操作id, 项目: operation.项目, 任务: operation.任务, 方式: operation.方式, 拟用实例: operation.拟用实例, 状态: operation.状态, 可创建: allow, 幂等: repeated }; }
function recordReceipt(operation, stage, seq, repeated) { return { 操作id: operation.操作id, 任务: operation.任务, 拟用实例: operation.拟用实例, 状态: operation.状态, 已记录阶段: stage, 事件序号: seq, 幂等: repeated }; }
function operationView(item) { return { ...item, 问题: item.问题.slice(-5), 问题总数: item.问题.length, 问题截断: item.问题.length > 5 }; }
function aggregate(all) { return { 操作: all.length, 未收尾: all.filter((item) => item.状态 !== 'audited').length, 已审计: all.filter((item) => item.状态 === 'audited').length, 已见宿主回执: all.filter((item) => item.状态 !== 'intent').length, 仅有意图: all.filter((item) => item.状态 === 'intent').length, 有问题操作: all.filter((item) => item.问题.length > 0).length, 问题记录: all.reduce((sum, item) => sum + item.问题.length, 0) }; }
function envelope(project, summary) { return { 项目: project, 健康: '可用', 覆盖口径: SPAWN_OPERATION_COVERAGE, 完整: false, 汇总: summary }; }
