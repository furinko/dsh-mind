/** 记忆读面的分页与内容预算；不读取账本，也不参与权限判定。 */
import { InvalidBody, Fault } from './kernel/errors.js';
import { collaborationFeedbackSummary } from './collaboration-feedback.js';

/** 默认值与硬上限共用，动作 schema 可直接引用。单位为 JSON 的 UTF-16 字符数。 */
export const MEMORY_RESPONSE_LIMITS = Object.freeze({ defaultBudget: 12000, maxBudget: 32000, minBudget: 512, maxRows: 100, maxQuery: 2048, maxResponse: 40000 });

/**
 * 校验有限读数；不把 Infinity、字符串或负数静默变成“无限”。
 * @param {object} query
 * @returns {{ 返回模式: string, 内容预算: number, limit: number, 条数上限: number, 偏移: number, 正文偏移: number }}
 */
export function memoryResponseOptions(query = {}) {
  if (query.含待复验 !== undefined && typeof query.含待复验 !== 'boolean') throw new InvalidBody('含待复验只能为boolean；true只放宽复验筛选，不扩大失效或权限读域。');
  const integer = (key, fallback, min, max) => {
    const value = query[key] === undefined ? fallback : query[key];
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new InvalidBody(`${key} 必须是 ${min}–${max} 的整数。`);
    return value;
  };
  for (const [key, max] of [['文本', MEMORY_RESPONSE_LIMITS.maxQuery], ['id', 256], ['项目', 256], ['岗位', 256]]) {
    if (query[key] !== undefined && (typeof query[key] !== 'string' || query[key].length > max || (key === 'id' && !query[key].trim()))) {
      throw new InvalidBody(`${key} 必须是长度不超过 ${max} 的字符串${key === 'id' ? '，且不能为空' : ''}。`);
    }
  }
  if (query.数据版本 !== undefined && (typeof query.数据版本 !== 'string' || !/^[a-f0-9]{64}$/.test(query.数据版本))) throw new InvalidBody('数据版本 必须使用上一页返回的64位SHA256。');
  const 返回模式 = query.返回模式 ?? '全文';
  if (!['摘要', '全文'].includes(返回模式)) throw new InvalidBody('返回模式 只接受 摘要 / 全文。');
  const options = {
    返回模式,
    内容预算: integer('内容预算', MEMORY_RESPONSE_LIMITS.defaultBudget, MEMORY_RESPONSE_LIMITS.minBudget, MEMORY_RESPONSE_LIMITS.maxBudget),
    limit: integer('limit', 10, 0, MEMORY_RESPONSE_LIMITS.maxRows),
    条数上限: integer('条数上限', 50, 1, MEMORY_RESPONSE_LIMITS.maxRows),
    偏移: integer('偏移', 0, 0, Number.MAX_SAFE_INTEGER),
    正文偏移: integer('正文偏移', 0, 0, Number.MAX_SAFE_INTEGER),
  };
  if (options.正文偏移 > 0 && (!query.id || 返回模式 !== '全文')) throw new InvalidBody('正文偏移 仅用于 id + 返回模式=全文 的正文续读。');
  if (query.id && options.偏移 > 0) throw new InvalidBody('id 详情不接受列表偏移；续读请使用 正文偏移。');
  if (query.id && query.文本?.trim()) throw new InvalidBody('id 详情与文本检索不能同时指定。');
  if ((options.偏移 > 0 || options.正文偏移 > 0) && !query.数据版本) throw new InvalidBody('续页必须携带上一页的 数据版本；先从偏移0读取首屏。');
  return options;
}

/**
 * 装配已获准的本页条目。预算包括命中、正文、来源、标签和历史等两数组的全部 JSON 字符。
 * 预算不够时结束本页；首条过大则显式缩减元数据并切正文，仍能按 id 继续读正文。
 * @param {{entries: object[], hits?: object[], options: ReturnType<typeof memoryResponseOptions>, total: number, detail?: boolean, fromEnd?: boolean}} spec
 * @returns {object}
 */
export function memoryResponsePage({ entries, hits = [], options, total, detail = false, fromEnd = false }) {
  if (fromEnd) { entries = [...entries].reverse(); hits = [...hits].reverse(); }
  const 条目 = [];
  const 命中 = [];
  const measure = () => JSON.stringify({ 命中, 条目 }).length;
  let 内容截断 = false;
  for (let i = 0; i < entries.length; i += 1) {
    const original = entries[i];
    const body = String(original.内容 ?? '');
    const start = detail && options.返回模式 === '全文' ? Math.min(options.正文偏移, body.length) : 0;
    if (detail && start > 0 && /[\uDC00-\uDFFF]/.test(body[start] ?? '') && /[\uD800-\uDBFF]/.test(body[start - 1])) {
      throw new InvalidBody('正文偏移 不得切开 UTF-16 代理对；请使用上一页的 下一正文偏移。');
    }
    const text = options.返回模式 === '全文' ? body.slice(start) : sliceText(body, 160);
    const field = options.返回模式 === '全文' ? '内容' : '摘要';
    let entry = options.返回模式 === '全文' ? { ...original, 内容: text } : compactEntry(original);
    if (options.返回模式 === '摘要') entry.摘要 = text;
    if (detail && options.返回模式 === '全文') Object.assign(entry, { 正文偏移: start, 正文总字符: body.length, 下一正文偏移: null, 正文截断: false });
    let hit = hits[i] ? { ...hits[i] } : null;
    const push = () => { 条目.push(entry); if (hit) 命中.push(hit); };
    const pop = () => { 条目.pop(); if (hit) 命中.pop(); };
    push();
    if (measure() <= options.内容预算) continue;
    pop();
    if (条目.length) { 内容截断 = true; break; }
    // 保留元数据还须容纳至少一个完整码点和最终分页标记，避免正文0字符原地续页。
    // 只有元数据与最小正文放不下时才缩减，正常大说明仍可配合正文分页读回。
    const firstText = text ? sliceText(text, text.codePointAt(0) > 0xffff ? 2 : 1) : '';
    entry = { ...entry, [field]: firstText, 正文截断: start + firstText.length < body.length };
    if (detail && options.返回模式 === '全文') entry.下一正文偏移 = start + firstText.length;
    push();
    const metadataFits = measure() <= options.内容预算;
    pop();
    if (!metadataFits) {
      // 巨大的历史/来源/标签也要计入预算，不能只截正文后原样带回其余字段。
      entry = { id: original.id, [field]: '', 元数据截断: true, ...reviewWarnings(original) };
      if (original.状态) entry.状态 = sliceText(String(original.状态), 32);
      if (detail && options.返回模式 === '全文') Object.assign(entry, { 正文偏移: start, 正文总字符: body.length, 下一正文偏移: start });
      hit = hit ? { id: hit.id, 分数: hit.分数, 摘要: '' } : null;
    }
    push();
    let low = 0;
    let high = text.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      entry[field] = sliceText(text, mid);
      if (detail && options.返回模式 === '全文') entry.下一正文偏移 = start + entry[field].length;
      if (measure() <= options.内容预算) low = mid;
      else high = mid - 1;
    }
    entry[field] = sliceText(text, low);
    const 刷新正文边界 = () => {
      const next = start + entry[field].length;
      entry.正文截断 = next < body.length;
      if (detail && options.返回模式 === '全文') entry.下一正文偏移 = entry.正文截断 ? next : null;
    };
    刷新正文边界();
    // 标志本身也占字符，缩短正文直到完整物化后的读数真实有界。
    while (measure() > options.内容预算 && entry[field].length) {
      entry[field] = sliceText(entry[field], entry[field].length - 1);
      刷新正文边界();
    }
    if (detail && options.返回模式 === '全文' && start < body.length && entry[field].length === 0) {
      throw new Fault('MEMORY_RESPONSE_NO_PROGRESS', '当前内容预算无法容纳正文续页；请增加内容预算，不能以相同正文偏移无限续读。');
    }
    刷新正文边界();
    if (measure() > options.内容预算) pop();
    内容截断 = true;
    break;
  }
  if (fromEnd) { 条目.reverse(); 命中.reverse(); }
  const 下一偏移 = !detail && 条目.length && options.偏移 + 条目.length < total ? options.偏移 + 条目.length : null;
  const 条目截断 = entries.length > 条目.length || (!detail && options.偏移 + 条目.length < total);
  return {
    命中, 条目, 条目总数: total, 条数上限: options.条数上限, 条目截断,
    返回模式: options.返回模式, 内容预算: options.内容预算, 内容已用: measure(),
    内容预算单位: '命中与条目两数组的JSON字符（UTF-16代码单元）', 内容截断,
    偏移: options.偏移, 下一偏移,
    ...(detail ? { 下一正文偏移: 条目[0]?.下一正文偏移 ?? null } : {}),
  };
}

/**
 * 完整响应另设硬上限；口径与解释同样不能通过巨大查询词/内部读域说明绕过。
 * 动态数组已由内容预算封顶，这里只裁解释与口径文本，保留条目引用、数值和分页凭据。
 * @param {object} result
 * @returns {object}
 */
export function finalizeMemoryResponse(result) {
  fitSerializedResponse(result, () => JSON.stringify(result));
  return result;
}

/**
 * 宿主边界使用同一个完整序列化预算，包含包装字段、缩进和换行。
 * 不修改调用方对象；领域服务仍只返回对象，不依赖宿主协议。
 * @param {object} envelope 包含 `结果` 的 mind 动作包装
 * @param {number} [space] JSON 缩进，默认1
 * @returns {string}
 */
export function serializeMemoryEnvelope(envelope, space = 1) {
  const copy = { ...envelope, 结果: { ...envelope.结果, 口径: { ...envelope.结果?.口径 } } };
  fitSerializedResponse(copy.结果, () => JSON.stringify(copy, null, space));
  return JSON.stringify(copy, null, space);
}

/** 将“整条最终消息”而非中间对象收口到硬预算。 */
function fitSerializedResponse(result, serialize) {
  result.总响应上限 = MEMORY_RESPONSE_LIMITS.maxResponse;
  result.总响应字符 = 0;
  result.信封截断 = result.信封截断 === true;
  const measure = () => serialize().length;
  for (const [owner, key] of [[result, '说明'], [result.口径, '查询词'], [result.口径, '范围']]) {
    if (measure() <= result.总响应上限) break;
    if (!owner || typeof owner[key] !== 'string') continue;
    result.信封截断 = true;
    const original = owner[key];
    let low = 0;
    let high = original.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      owner[key] = sliceText(original, mid);
      if (measure() + 8 <= result.总响应上限) low = mid;
      else high = mid - 1;
    }
    owner[key] = sliceText(original, low);
  }
  if (measure() + 8 > result.总响应上限) {
    // 缩进也可能放大嵌套历史的体积；先缩减元数据，保留所有条目id与正文续读凭据。
    result.信封截断 = true;
    result.内容截断 = true;
    result.条目 = (result.条目 ?? []).map((entry) => ({
      ...Object.fromEntries(['id', '类', '状态', '内容', '摘要', '正文偏移', '正文总字符', '下一正文偏移', '正文截断', '复验状态', '复验警示'].filter((key) => entry[key] !== undefined).map((key) => [key, entry[key]])),
      元数据截断: true,
    }));
    result.命中 = (result.命中 ?? []).map((hit) => ({ id: hit.id, 分数: hit.分数, 摘要: hit.摘要 ?? '' }));
    for (const entry of [...result.命中, ...result.条目].reverse()) {
      for (const key of ['摘要', '内容']) {
        if (measure() + 16 <= result.总响应上限) break;
        if (typeof entry[key] !== 'string') continue;
        const original = entry[key];
        let low = 0;
        let high = original.length;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          entry[key] = sliceText(original, mid);
          if (measure() + 64 <= result.总响应上限) low = mid;
          else high = mid - 1;
        }
        entry[key] = sliceText(original, low);
        entry.正文截断 = true;
        if (entry.正文总字符 !== undefined && key === '内容') {
          entry.下一正文偏移 = (entry.正文偏移 ?? 0) + entry.内容.length;
          result.下一正文偏移 = entry.下一正文偏移;
        }
      }
    }
    result.内容已用 = JSON.stringify({ 命中: result.命中, 条目: result.条目 }).length;
  }
  // 本身的位数也属于响应长度；收敛后才对外报告，不能少算这几个字符。
  for (let i = 0; i < 4; i += 1) result.总响应字符 = measure();
  if (result.总响应字符 > result.总响应上限) throw new Fault('MEMORY_RESPONSE_BUDGET_EXCEEDED', '记忆响应信封无法在硬上限内装配。');
}

/** 摘要不携带完整历史；所有动态元数据仍由总预算兜底。 */
function compactEntry(entry) {
  return { ...Object.fromEntries(['id', '类', '状态', '项目', '岗位', '归属', '记于', '来源', '来源引用', '派生自', '归档', '连续性', '知识说明', '复验状态', '复验警示'].filter((key) => entry[key] !== undefined).map((key) => [key, entry[key]])),
    ...(Object.hasOwn(entry, '协作反馈') ? { 协作反馈摘要: collaborationFeedbackSummary(entry.协作反馈) } : {}) };
}
function reviewWarnings(entry) { return Object.fromEntries(['复验状态', '复验警示'].filter((key) => entry[key] !== undefined).map((key) => [key, entry[key]])); }

/** 字符分页不可把补充平面字符切成两个坏代理项。 */
function sliceText(text, size) {
  let end = Math.min(text.length, size);
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end] ?? '')) end -= 1;
  return text.slice(0, end);
}
