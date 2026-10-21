/** 知识采用的历史声明读面；不排行、不改写记忆，不把采纳或自报帮助当作语义证明。 */
import { parseTaskLedger } from './task-ledger.js';
import { readTextOrNull } from './kernel/fsx.js';
import { 已被合法采纳 } from './tasks.js';
import { canonical, digest } from './kernel/text.js';
import { Denied, Fault, InvalidBody } from './kernel/errors.js';
import { validateStoredKnowledgeAdoption, validateKnowledgeEvidenceSource } from './knowledge-reuse-contract.js';
import { createKnowledgeFeedbackResolver, validateFeedbackDispositionObservation } from './knowledge-feedback.js';

export const KNOWLEDGE_REUSE_COVERAGE = Object.freeze({ 来源: '任务原始submitted事件中的采用知识声明',
  声明: '省略为未知，显式空与有声明分列；使用结果是交卷者声明，不证明知识正确或无效。',
  版本: '保存捕获时可读来源版本，不保证与任务提交原子一致，也不证明交卷者实际使用过同一版；来源捕获不是检索或使用回执。每次读取重新核当前可见来源，不输出正文。',
  采纳: '按采纳前账本前缀核对本代有效票、豁免或历史确认引用及内容摘要，只关联本代每位最后一次交卷；不重新认证历史授权、免审开关或知识语义，不继承前序/后继或旧代。',
  完整性: '仅覆盖已落线任务交卷；旧事件不补声明、不猜代，不检测合法删除或回滚。',
  无读者摘要: '内部无读者摘要不伪造身份，来源均保持未核验；来源可核0仅表示本次未核得来源，不证明所有来源不可读或无效。',
  处置: '仅核对显式引用该负反馈的记忆状态记录；已见关联不认证纠错成功，未见不证明未处理。缺失、删除、不可读或坏账保留不可核对；不按时间接近或知识id猜关联。',
  返回: '工具页的用途、适用判断和说明各最多160字符并标截断；原文留在任务账本。关联采纳仅返回最近5条并标总数；本查询对象的紧凑JSON至多40000字符，外层动作封套不在此预算内。' });
const SUMMARY_FIELDS = Object.freeze(['交卷记录', '未说明', '显式空', '有声明', '声明条目', '有帮助声明', '不适用声明', '问题声明', '来源可核', '关联采纳交卷']);
const DISPOSITION_FIELDS = Object.freeze(['负反馈条目', '已见关联处置', '未见关联处置', '处置不可核对']);
const QUERY_KEYS = Object.freeze(['subject', '项目', '任务', '知识id', '条数', '偏移', '数据版本']);
const RESPONSE_LIMIT = 40000;
const unknownSource = () => ({ 状态: '来源未核验' });
const unknownDisposition = () => ({ 状态: '不可核对', 记录: [], 总数: null, 截断: null });
const isNegative = item => ['不适用', '发现问题'].includes(item.使用结果);
const SUBMITTED_SOURCE = Symbol('knowledge-feedback-original-submitted');
const feedbackKey = (record, item) => canonical([record.任务, record.提交序, item.id, record[SUBMITTED_SOURCE]?.index]);
const positive = (value) => Number.isSafeInteger(value) && value > 0;

export class KnowledgeReuseService {
  constructor({ layout, policy, registry, memory }) { Object.assign(this, { layout, policy, registry, memory }); }

  async query(spec) {
    validateQuery(spec);
    const args = structuredClone(spec);
    await this.#reader(args.subject);
    if (typeof this.policy?.check !== 'function') throw new Fault('KNOWLEDGE_REUSE_POLICY_UNAVAILABLE', '知识复用查询缺少当前策略引擎。');
    await this.policy.check({ subject: args.subject, action: 'read', target: readTarget(args.项目), context: {} });
    const records = await this.#records(args.项目, args.subject, args, true);
    const version = dataVersion(args.项目, args, records);
    if (args.数据版本 !== undefined && args.数据版本 !== version) throw new Denied('知识复用 · 续页版本已变化', '交卷、采纳、当前可见域或来源版本已变化，请从第一页重新查询；不能把旧页和新页拼成同一分母。');
    return boundedPage(args.项目, records, args.条数 ?? 20, args.偏移 ?? 0, version);
  }

  /** 带读者工作台复用真实身份/卡与当前read；纯投影不追加审计或记忆事实。 */
  async summaryFor({ subject, 项目 } = {}) {
    try {
      preciseId(项目, '项目');
      await this.#reader(subject);
      if (this.#decision(subject, readTarget(项目))?.verdict !== 'allow') return null;
    } catch { return null; }
    try { const records = await this.#records(项目, subject, {}, true); return summaryEnvelope(项目, aggregate(records), dispositionAggregate(records)); }
    catch (error) { return unavailable(项目, error); }
  }

  /** 内部无读者的本地面板：不伪造主权者；无当前来源资格时不宣称来源可核。 */
  async summary(project) {
    try { preciseId(project, '项目'); const records = await this.#records(project, undefined, {}, false); return summaryEnvelope(project, aggregate(records), dispositionAggregate(records)); }
    catch (error) { return unavailable(project, error); }
  }

  async #records(project, subject, filters, scoped) {
    const taskFile = this.layout.taskLog(project);
    const taskText = await readTextOrNull(taskFile);
    const rows = parseTaskLedger(taskText, taskFile);
    const projection = projectSubmissions(rows, project);
    const nodes = projection.nodes;
    if (filters.任务 !== undefined && !nodes.has(filters.任务)) throw new InvalidBody('任务筛选必须引用当前项目真实存在的任务。');
    const readable = new Set();
    for (const node of nodes.values()) {
      if (filters.任务 !== undefined && filters.任务 !== node.id) continue;
      if (!scoped || this.#decision(subject, taskTarget(node.id, project), { task: node })?.verdict === 'allow') readable.add(node.id);
    }
    if (filters.任务 !== undefined && !readable.has(filters.任务)) throw new Denied('知识复用 · 任务不在当前读域', '该任务的当前读判定未放行，知识id或分页不能扩大任务读域。');
    const records = projection.records.filter((record) => readable.has(record.任务) && (filters.知识id === undefined || record.采用知识.some((item) => item.id === filters.知识id)));
    const ids = [...new Set(records.flatMap((record) => record.采用知识.map((item) => item.id)))];
    let current = new Map(ids.map(id => [id, unknownSource()]));
    let dispositions = new Map(records.flatMap(record => record.采用知识.filter(isNegative).map(item => [feedbackKey(record, item), unknownDisposition()])));
    const observe = async reader => ({ current: await this.#evidence(subject, project, ids, reader), dispositions: await this.#dispositions(subject, project, projection.resolveFeedback, records, reader) });
    if (subject && typeof this.memory?.withKnowledgeReadSnapshot === 'function') {
      try {
        const observed = await this.memory.withKnowledgeReadSnapshot({ subject, 项目: project }, observe);
        if (observed?.有效 === true && observed.结果?.current instanceof Map && observed.结果?.dispositions instanceof Map) ({ current, dispositions } = observed.结果);
      } catch { /* 来源观察故障保留原声明，但不得带回早批的哈希或回执。 */ }
    } else ({ current, dispositions } = await observe(this.memory));
    if (scoped) {
      await this.#reader(subject);
    }
    if (await readTextOrNull(taskFile) !== taskText) throw new Denied('知识复用 · 查询期间任务版本变化', '任务事件在读取期间变化，请重新查询，不能把旧声明分母与后来的观察混合。');
    if (scoped) {
      const returnedTasks = new Set(records.map(record => record.任务));
      if (filters.任务 !== undefined) returnedTasks.add(filters.任务);
      if (this.#decision(subject, readTarget(project))?.verdict !== 'allow' || [...returnedTasks].some(id => this.#decision(subject, taskTarget(id, project), { task: nodes.get(id) })?.verdict !== 'allow')) throw new Denied('知识复用 · 查询期间读域变化', '当前治理或任务读域已收紧，请重新核对，未返回开头许可下的旧声明。');
    }
    return records.map((record) => ({ ...record, 采用知识: record.采用知识.map((item) => ({ ...visibleAdoption(item, current.get(item.id)), ...(isNegative(item) ? { 反馈处置: dispositions.get(feedbackKey(record, item)) ?? unknownDisposition() } : {}) })) })).sort((a, b) => b.提交序 - a.提交序 || a.任务.localeCompare(b.任务));
  }

  async #dispositions(subject, project, resolveFeedback, records, reader = this.memory) {
    const result = new Map();
    const targets = [];
    for (const record of records) for (const item of record.采用知识) {
      if (!isNegative(item)) continue;
      const key = feedbackKey(record, item);
      result.set(key, unknownDisposition());
      try {
        const source = record[SUBMITTED_SOURCE]?.row;
        if (!positive(source?.seq) || source.seq !== record.提交序) continue;
        const proof = resolveFeedback({ 任务: record.任务, 提交序: record.提交序, 知识id: item.id });
        targets.push({ key, 知识id: item.id, 反馈指纹: proof.指纹 });
      } catch { /* 旧代缺证、歧义seq或坏声明不能被补造为一份可关联反馈。 */ }
    }
    if (!subject || typeof reader?.readFeedbackDispositions !== 'function') return result;
    for (let start = 0; start < targets.length; start += 16) {
      const batch = targets.slice(start, start + 16);
      try {
        const observed = await reader.readFeedbackDispositions({ subject, 项目: project, items: batch.map(({ 知识id, 反馈指纹 }) => ({ 知识id, 反馈指纹 })) });
        if (!(observed instanceof Map)) continue;
        for (const target of batch) {
          try {
            const value = validateFeedbackDispositionObservation(observed.get(target.反馈指纹));
            if (value.状态 === '可核对') result.set(target.key, { ...value, 状态: value.总数 > 0 ? '已见关联处置' : '未见关联处置' });
          } catch { /* 错误回执与不可读均保留不可核对，不复制私有proof或原因。 */ }
        }
      } catch { /* 记忆观测故障不把任务声明洗掉，也不冒充没有处置。 */ }
    }
    return result;
  }

  async #evidence(subject, project, ids, reader = this.memory) {
    const result = new Map(ids.map((id) => [id, unknownSource()]));
    if (!subject || typeof reader?.readKnowledgeEvidence !== 'function') return result;
    for (let start = 0; start < ids.length; start += 16) {
      const batch = ids.slice(start, start + 16);
      try {
        const evidence = await reader.readKnowledgeEvidence({ subject, 项目: project, ids: batch });
        if (!(evidence instanceof Map)) continue;
        for (const id of batch) {
          try { result.set(id, validateKnowledgeEvidenceSource(evidence.get(id))); }
          catch { /* 不可见、缺失或坏来源都统一未核验，不泄露旧版本。 */ }
        }
      } catch { /* 来源核验失败不冒作正文可读，原交卷声明仍保持。 */ }
    }
    return result;
  }

  async #reader(subject) {
    if (!isId(subject?.id) || !['Lead', '主权者'].includes(subject.kind)) throw new Denied('知识复用 · 治理读资格', '知识复用只向当前真实Lead或主权者开放，普通成员、复核员和自报认证不能扩大历史读域。');
    if (typeof this.policy?.refreshIfStale !== 'function' || typeof this.policy?.decideCurrentSync !== 'function') throw new Fault('KNOWLEDGE_REUSE_POLICY_UNAVAILABLE', '缺少当前健康策略和同步读判定。');
    await this.policy.refreshIfStale();
    if (!this.policy.healthy) throw new Fault('KNOWLEDGE_REUSE_POLICY_UNAVAILABLE', '当前策略不健康，不能生成知识复用治理读面。');
    if (subject.kind === 'Lead') {
      if (!this.registry?.identity || !this.registry?.cardOf) throw new Fault('KNOWLEDGE_REUSE_IDENTITY_UNAVAILABLE', '缺少真实Lead身份或卡凭证真源。');
      const member = (await this.registry.identity()).members?.[subject.id];
      if (member?.岗位 !== 'Lead' || member.status !== '在岗' || (subject.roleId !== undefined && subject.roleId !== 'Lead') || (await this.registry.cardOf(subject.id))?.就绪 !== true) throw new Denied('知识复用 · 治理读资格', '当前主体不是在册、在岗且卡凭证就绪的Lead。');
    }
  }
  #decision(subject, target, context = {}) { if (!this.policy?.healthy || typeof this.policy?.decideCurrentSync !== 'function') throw new Fault('KNOWLEDGE_REUSE_POLICY_UNAVAILABLE', '当前策略不可判，不能用旧读域生成知识复用统计。'); return this.policy.decideCurrentSync({ subject, action: 'read', target, context }); }
}

/** 只读原事件：同人复交和代由事件定位，不从最终答案、继承关系或当前状态回填历史。 */
function projectSubmissions(rows, project) {
  const submissions = [];
  const latest = new Map();
  const resolver = createKnowledgeFeedbackResolver({ rows, 项目: project, visit: ({ row, index, before, after }) => {
    if (row.kind === 'submitted') {
      let adoption;
      if (Object.hasOwn(row, '采用知识')) {
        try { adoption = validateStoredKnowledgeAdoption(row.采用知识); if (!positive(row.代)) throw new InvalidBody('有采用知识封套的新交卷必须带显式正整数代。'); }
        catch (cause) { throw new Fault('TASK_LEDGER_INVALID', '交卷知识采用封套或代损坏，不能跳过后生成历史统计。', { cause, detail: { line: index + 1 } }); }
      }
      const record = { 任务: row.id, 提交序: positive(row.seq) ? row.seq : index + 1, 代: positive(row.代) ? row.代 : null,
        提交人: isId(row.by?.id) ? row.by.id : null, 提交于: typeof row.at === 'string' ? row.at : null,
        声明状态: adoption?.声明状态 ?? '未知', 采用知识: adoption?.条目 ?? [], 关联采纳: [] };
      // 原文只在本次投影内定位，不序列化。旧位置序号不能冒充后来同数值的真实seq。
      Object.defineProperty(record, SUBMITTED_SOURCE, { value: { row, index } });
      submissions.push(record);
      if (record.提交人 !== null) {
        const byAuthor = latest.get(row.id) ?? new Map();
        byAuthor.set(record.提交人, record); latest.set(row.id, byAuthor);
      }
    } else if (row.kind === 'accepted' && acceptanceMatchesPrefix(row, before, after)) {
      for (const record of latest.get(row.id)?.values() ?? []) if (record.代 === row.代) record.关联采纳.push({ 采纳序: positive(row.seq) ? row.seq : index + 1, 于: typeof row.at === 'string' ? row.at : null, 代: row.代 });
    }
  } });
  return { records: submissions, nodes: resolver.nodes, resolveFeedback: resolver.resolve };
}

/** fold的accepted分支只投影，不代替引用验证；当前策略开关也不能伪造历史许可。 */
function acceptanceMatchesPrefix(row, before, after) {
  if (!positive(row.代) || !isId(row.by?.id) || !['Lead', '主权者'].includes(row.by.kind)) return false;
  if (!before || before.代 !== row.代 || !已被合法采纳(after) || after.代 !== row.代 || after.采纳?.代 !== row.代 || typeof row.交付物摘要 !== 'string' || row.交付物摘要 !== before.交付物清单?.摘要) return false;
  if (row.依据 === '复核结论') return ['已交卷', '未验'].includes(before.状态) && typeof row.票 === 'string' && row.票 === before.待采纳?.票 && before.待采纳?.代 === row.代 && before.已复核交付物摘要 === row.交付物摘要;
  if (row.依据 === '复核免审') return before.状态 === '已交卷' && before.复核豁免?.代 === row.代 && typeof row.豁免 === 'string' && row.豁免 === before.复核豁免.票 && row.票 === null;
  if (row.依据 === '历史确认') return before.状态 === '已采纳' && before.需Lead确认 === true && before.采纳?.代 === row.代 && row.票 === before.采纳?.票 && before.已复核交付物摘要 === row.交付物摘要;
  return false;
}

function visibleAdoption(item, current) {
  const { 来源: old, ...input } = structuredClone(item);
  if (current?.状态 !== '可核来源版本') return { ...input, 来源: unknownSource() };
  return { ...input, 来源: old, 当前来源: old.状态 === '来源未核验' ? '捕获未核验' : old.内容哈希 === current.内容哈希 && old.元数据哈希 === current.元数据哈希 ? '同一观察版本' : '版本已变', 当前版本: { 内容哈希: current.内容哈希, 元数据哈希: current.元数据哈希 } };
}
function aggregate(records) {
  const items = records.flatMap((record) => record.采用知识);
  return { 交卷记录: records.length, 未说明: records.filter((record) => record.声明状态 === '未知').length, 显式空: records.filter((record) => record.声明状态 === '显式空').length,
    有声明: records.filter((record) => record.声明状态 === '已声明').length, 声明条目: items.length, 有帮助声明: items.filter((item) => item.使用结果 === '有帮助').length,
    不适用声明: items.filter((item) => item.使用结果 === '不适用').length, 问题声明: items.filter((item) => item.使用结果 === '发现问题').length,
    来源可核: items.filter((item) => Object.hasOwn(item, '当前版本')).length, 关联采纳交卷: records.filter((record) => record.关联采纳.length > 0).length };
}
function dispositionAggregate(records) {
  const items = records.flatMap(record => record.采用知识).filter(isNegative);
  return { 负反馈条目: items.length, 已见关联处置: items.filter(item => item.反馈处置?.状态 === '已见关联处置').length, 未见关联处置: items.filter(item => item.反馈处置?.状态 === '未见关联处置').length, 处置不可核对: items.filter(item => item.反馈处置?.状态 === '不可核对').length };
}
function summaryEnvelope(project, summary, dispositions) { return { 项目: project, 健康: '可用', 覆盖口径: KNOWLEDGE_REUSE_COVERAGE, 完整: false, 汇总: summary, 处置汇总: dispositions }; }
function unavailable(project, error) { return { 项目: project, 健康: '不可用', 不可用原因: { code: error?.code ?? 'KNOWLEDGE_REUSE_UNAVAILABLE', 说明: '知识复用真源不可读或投影失败；未将未知当空记录。' }, 覆盖口径: KNOWLEDGE_REUSE_COVERAGE, 完整: false, 汇总: Object.fromEntries(SUMMARY_FIELDS.map((key) => [key, null])), 处置汇总: Object.fromEntries(DISPOSITION_FIELDS.map(key => [key, null])) }; }
function dataVersion(project, filters, records) { return digest(canonical({ 项目: project, 任务: filters.任务 ?? null, 知识id: filters.知识id ?? null, 记录: records })); }
function recordView(record) {
  return { ...record, 采用知识: record.采用知识.map((item) => {
    const fields = ['用途', '适用判断', ...(Object.hasOwn(item, '说明') ? ['说明'] : [])];
    const truncated = fields.filter((field) => item[field].length > 160);
    return { ...structuredClone(item), ...Object.fromEntries(fields.map((field) => [field, item[field].slice(0, 160)])), 字段截断: truncated };
  }), 关联采纳: record.关联采纳.slice(-5), 关联采纳总数: record.关联采纳.length, 关联采纳截断: record.关联采纳.length > 5 };
}
function boundedPage(project, records, limit, offset, version) {
  const result = { ...summaryEnvelope(project, aggregate(records), dispositionAggregate(records)), 数据版本: version, 采用页: { 条目: [], 总数: records.length, 条数: limit, 偏移: offset, 实际返回条目数: 0, 下一偏移: offset, hasMore: offset < records.length } };
  for (const record of records.slice(offset, offset + limit)) {
    result.采用页.条目.push(recordView(record));
    result.采用页.实际返回条目数 = result.采用页.条目.length; result.采用页.下一偏移 = offset + result.采用页.实际返回条目数; result.采用页.hasMore = result.采用页.下一偏移 < records.length;
    if (JSON.stringify(result).length <= RESPONSE_LIMIT) continue;
    if (result.采用页.条目.length === 1) {
      // 合法的16项负反馈各带5份回执也可能超预算；保留每项最近1份并如实标总数/截断。
      while (JSON.stringify(result).length > RESPONSE_LIMIT) {
        const candidates = result.采用页.条目[0].采用知识.map(item => item.反馈处置).filter(value => value?.记录?.length > 1).sort((a, b) => JSON.stringify(b.记录).length - JSON.stringify(a.记录).length);
        if (!candidates.length) break;
        candidates[0].记录.shift(); candidates[0].截断 = true;
      }
      if (JSON.stringify(result).length <= RESPONSE_LIMIT) continue;
    }
    result.采用页.条目.pop();
    result.采用页.实际返回条目数 = result.采用页.条目.length; result.采用页.下一偏移 = offset + result.采用页.实际返回条目数; result.采用页.hasMore = result.采用页.下一偏移 < records.length;
    if (result.采用页.条目.length === 0) throw new Fault('KNOWLEDGE_REUSE_RESPONSE_TOO_LARGE', '单条知识采用摘要仍超过响应预算，未返回空页循环或静默丢失条目。');
    break;
  }
  if (JSON.stringify(result).length > RESPONSE_LIMIT) throw new Fault('KNOWLEDGE_REUSE_RESPONSE_TOO_LARGE', '知识采用响应超过固定预算，未伪报完整页。');
  return result;
}
function readTarget(project) { return { id: 'knowledge-reuse', kind: '知识复用', authority: '自治', zone: '私有', domain: '集体', project }; }
function taskTarget(id, project) { return { id, kind: '任务', authority: '自治', zone: '私有', domain: '集体', project }; }
function isId(value) { return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value; }
function preciseId(value, name) { if (!isId(value)) throw new InvalidBody(`${name}必须为1至256字符的精确标识。`); }
function validateQuery(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !QUERY_KEYS.includes(key))) throw new InvalidBody('知识复用查询不接受来源、声明、身份认证或任务作用域等写入参数。');
  preciseId(value.项目, '项目');
  if (value.任务 !== undefined) preciseId(value.任务, '任务');
  if (value.知识id !== undefined) preciseId(value.知识id, '知识id');
  const limit = value.条数 ?? 20; const offset = value.偏移 ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger(offset) || offset < 0) throw new InvalidBody('条数必须为1至50，偏移必须为非负安全整数。');
  if (value.数据版本 !== undefined && (typeof value.数据版本 !== 'string' || !/^[a-f0-9]{64}$/.test(value.数据版本))) throw new InvalidBody('续页数据版本必须是本服务返回的SHA-256。');
  if (offset > 0 && value.数据版本 === undefined) throw new InvalidBody('非首页查询必须携带数据版本，不能把变化前后的声明分母拼成一页。');
}
