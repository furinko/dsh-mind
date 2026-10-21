/** 宿主模型frame的独立观察事实源；不提供授权，不声称完整审计或检测合法回滚。 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readTextOrNull, stripBom } from './kernel/fsx.js';
import { Fault, InvalidBody } from './kernel/errors.js';

export const MODEL_USAGE_FIELDS = Object.freeze(['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']);
export const MODEL_USAGE_FINISH_REASONS = Object.freeze(['stop', 'tool-calls', 'max-tokens', 'error', 'aborted']);
const FIELDS = {
  start: ['会话', '生命周期', 'attemptId', 'revision', 'turn', 'step', '主体', '归因', '配置路由'],
  sample: ['index', 'revision', 'time', 'usage'],
  end: ['index', 'revision', 'outcome', 'finish'],
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const text = (value, max = 256) => typeof value === 'string' && value.length > 0 && value.trim() === value && value.length <= max;
const natural = (value) => Number.isSafeInteger(value) && value >= 0;
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys, required = keys) => object(value) && Object.keys(value).every((key) => keys.includes(key)) && required.every((key) => Object.hasOwn(value, key));

export function modelUsageLogPath(layout, project) { return typeof layout.modelUsageLog === 'function' ? layout.modelUsageLog(project) : join(dirname(layout.taskLog(project)), 'model-usage.jsonl'); }
export function modelUsageLockPath(layout, project) { return typeof layout.modelUsageLock === 'function' ? layout.modelUsageLock(project) : join(dirname(layout.taskLog(project)), 'model-usage.lock'); }

/** 内部记录和账本解析共用强schema；可选SDK字段缺失保留缺失，不能传null或自算total。 */
export function validateModelUsageEvent(kind, value, { envelope = false } = {}) {
  const fields = Object.hasOwn(FIELDS, kind) ? FIELDS[kind] : null;
  const keys = fields ? ['项目', '执行键', ...fields, ...(envelope ? ['seq', 'at', 'kind'] : [])] : [];
  if (!fields || !exact(value, keys) || !text(value.项目) || typeof value.执行键 !== 'string' || !UUID.test(value.执行键) || !positive(value.revision)) throw new InvalidBody('模型用量事件的种类、项目、UUID、修订或字段集合无效。');
  if (envelope && (!positive(value.seq) || !text(value.at) || Number.isNaN(Date.parse(value.at)) || value.kind !== kind)) throw new InvalidBody('模型用量事件信封无效。');
  if (kind === 'start') {
    const actor = value.主体;
    if (!text(value.会话) || typeof value.生命周期 !== 'string' || !UUID.test(value.生命周期) || !text(value.attemptId, 512) || !natural(value.turn) || !natural(value.step) ||
        !exact(actor, ['id', 'kind', 'roleId'], ['id', 'kind']) || !text(actor.id) || actor.id !== value.会话 || !['Lead', '成员'].includes(actor.kind) ||
        (actor.kind === 'Lead' ? Object.hasOwn(actor, 'roleId') : Object.hasOwn(actor, 'roleId') && (!text(actor.roleId) || ['Lead', '主权者', '出厂作者'].includes(actor.roleId))) ||
        !exact(value.归因, ['目标', '原因']) || (value.归因.目标 !== null && !text(value.归因.目标)) || !text(value.归因.原因, 2000) ||
        !exact(value.配置路由, ['provider', 'model']) || ['provider', 'model'].some((key) => value.配置路由[key] !== null && !text(value.配置路由[key]))) throw new InvalidBody('模型用量起始帧缺少精确会话、生命周期、主体、归因或配置路由。');
  } else if (kind === 'sample') {
    if (!natural(value.index) || !natural(value.time) || !exact(value.usage, MODEL_USAGE_FIELDS, ['inputTokens', 'outputTokens']) || Object.values(value.usage).some((amount) => !natural(amount))) throw new InvalidBody('模型用量样本必须提供非负安全整数index/time和SDK input/output，未知字段与null均不接受。');
    // 安装的SDK声明input不含cache，cache读写与input/output互斥；reasoning属于output，不再加。
    const minimum = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].reduce((sum, field) => sum + BigInt(value.usage[field] ?? 0), 0n);
    if (Object.hasOwn(value.usage, 'totalTokens') && BigInt(value.usage.totalTokens) < minimum) throw new InvalidBody('SDK totalTokens低于已报告input/output/cache最小和，不能记录为一致快照。');
  } else {
    const outcome = value.outcome;
    if (!natural(value.index) || (value.finish !== null && !MODEL_USAGE_FINISH_REASONS.includes(value.finish)) || !object(outcome) ||
        (outcome.kind === 'abandoned' ? !exact(outcome, ['kind']) : outcome.kind !== 'committed' || !exact(outcome, ['kind', 'eventType', 'seq']) || !['assistant/message', 'assistant/attempt'].includes(outcome.eventType) || !positive(outcome.seq))) throw new InvalidBody('模型用量结束帧的index、提交事实或finish无效；结束不代表业务成功。');
  }
  return value;
}

/** 全量严格折叠。序号/快照index/revision只接受前进；重复由服务只读认回，不写重复事件。 */
export function foldModelUsageLedger(rows, project = null, file = 'model-usage.jsonl') {
  const attempts = new Map();
  const origins = new Map();
  let ledgerProject = project;
  const fail = (index, reason) => { throw new Fault('MODEL_USAGE_LEDGER_INVALID', `模型用量账本第 ${index + 1} 行${reason}；停止用量投影，不能跳行或把未知折成零。`, { detail: { file, line: index + 1, reason } }); };
  for (const [index, row] of rows.entries()) {
    try { validateModelUsageEvent(row?.kind, row, { envelope: true }); } catch { fail(index, '不是完整可识别的宿主观察事件'); }
    if (ledgerProject === null) ledgerProject = row.项目;
    if (row.seq !== index + 1 || row.项目 !== ledgerProject) fail(index, '序号不连续或事件被迁移到另一项目');
    const prior = attempts.get(row.执行键);
    if (row.kind === 'start') {
      const origin = JSON.stringify([row.会话, row.生命周期, row.attemptId]);
      if (prior || origins.has(origin)) fail(index, '重复起始或同一生命周期attempt被迁移到另一执行键');
      origins.set(origin, row.执行键);
      attempts.set(row.执行键, { 执行键: row.执行键, 项目: row.项目, 会话: row.会话, 生命周期: row.生命周期, attemptId: row.attemptId, turn: row.turn, step: row.step,
        主体: structuredClone(row.主体), 归因: structuredClone(row.归因), 配置路由: structuredClone(row.配置路由), 起始revision: row.revision, revision: row.revision,
        状态: 'open', 样本: [], usage: null, 最高样本index: -1, outcome: null, finish: null, 起始于: row.at, 结束于: null, 起始事件序号: row.seq, 最新事件序号: row.seq });
    } else {
      if (!prior || prior.项目 !== row.项目 || prior.状态 !== 'open' || row.revision <= prior.revision) fail(index, '样本/结束缺少同源open尝试或revision未递增');
      if (row.index <= prior.最高样本index) fail(index, '样本乱序或结束index不大于已有样本');
      if (row.kind === 'sample') {
        prior.样本.push({ index: row.index, revision: row.revision, time: row.time, usage: structuredClone(row.usage), 事件序号: row.seq, 观察于: row.at });
        prior.usage = structuredClone(row.usage);
        prior.最高样本index = row.index;
      } else Object.assign(prior, { 状态: 'ended', outcome: structuredClone(row.outcome), finish: row.finish, 结束于: row.at, 结束index: row.index });
      prior.revision = row.revision;
      prior.最新事件序号 = row.seq;
    }
  }
  return attempts;
}

export function parseModelUsageLedger(value, project = null, file = 'model-usage.jsonl') {
  if (value === null) return [];
  const fail = (line, reason) => { throw new Fault('MODEL_USAGE_LEDGER_INVALID', `模型用量账本第 ${line} 行${reason}；不能跳过损坏记录。`, { detail: { file, line, reason } }); };
  if (value !== '' && !value.endsWith('\n')) fail(value.split('\n').length, '末尾缺换行（可能追加中断）');
  const rows = [];
  for (const [index, line] of value.split('\n').entries()) {
    const content = stripBom(line.trim());
    if (!content) continue;
    try { rows.push(JSON.parse(content)); } catch { fail(index + 1, '不是合法JSON'); }
  }
  foldModelUsageLedger(rows, project, file);
  return rows;
}
export async function readModelUsageLedger(file, project = null) { return parseModelUsageLedger(await readTextOrNull(file), project, file); }
export function readModelUsageLedgerSync(file, project = null) {
  let value;
  try { value = readFileSync(file, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  return parseModelUsageLedger(value, project, file);
}
