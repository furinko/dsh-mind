/** 成员创建意图与宿主阶段的独立事实源；不提供重放、补签或宿主停止证明。 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readTextOrNull, stripBom } from './kernel/fsx.js';
import { Fault, InvalidBody, OUTCOME_RECEIPT_KEYS } from './kernel/errors.js';

export const SPAWN_OPERATION_STAGES = Object.freeze(['host_returned', 'registered', 'bound', 'dispatched', 'message_received', 'audited']);
export const SPAWN_OPERATION_RECORDER = Object.freeze({ id: 'spawn-operation-journal', kind: '系统' });
export const SPAWN_OPERATION_ISSUE_CODES = Object.freeze(['MEMBER_SPAWN_RESULT_UNKNOWN', 'MEMBER_SPAWN_RESERVED_ID_MISMATCH', 'MEMBER_SPAWN_RECEIPT_UNKNOWN', 'MEMBER_SPAWN_NO_ID', 'MEMBER_SPAWN_NO_AGENT', 'MEMBER_SPAWN_ASSIGN_FAILED', 'MEMBER_SPAWN_CARD_NOT_READY', 'MEMBER_SPAWN_DISPATCH_FAILED', 'MEMBER_SPAWN_MESSAGE_FAILED', 'MEMBER_SPAWN_FAILED_AFTER_BUDGET', 'MEMBER_SPAWN_CONTRACT', 'MEMBER_SPAWN_FAILED', 'MEMBER_SPAWN_INCOMPLETE', 'MEMBER_MESSAGE_RESULT_UNKNOWN', 'MEMBER_MESSAGE_RECEIPT_UNKNOWN', 'MEMBER_RELEASE_UNKNOWN', 'AUDIT_APPEND_FAILED_AFTER_EVENT', 'GOAL_BUDGET_AUDIT_APPEND_FAILED_AFTER_EVENT', 'SPAWN_OPERATION_APPEND_FAILED', 'DENIED', 'INVALID_BODY']);
const ISSUE_BOOLEANS = Object.freeze(['已请求', '已接收', '已停止', '已封存', '当前驻留已释放']);
const RECEIPT_FIELDS = Object.freeze({ host_returned: ['实例', '初始消息id', '团队名'], registered: ['实例'], bound: ['实例', '任务'], dispatched: ['任务'], message_received: ['实例', '任务', '消息id'], audited: ['实例', '任务'] });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const spawnOperationUUID = (value) => typeof value === 'string' && UUID.test(value);
export const spawnOperationText = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const actor = (value, kind) => exact(value, ['id', 'kind']) && spawnOperationText(value.id) && value.kind === kind;

export function spawnOperationLogPath(layout, project) { return typeof layout.spawnOperationLog === 'function' ? layout.spawnOperationLog(project) : join(dirname(layout.taskLog(project)), 'spawn-operations.jsonl'); }
export function spawnOperationLockPath(layout, project) { return typeof layout.spawnOperationLock === 'function' ? layout.spawnOperationLock(project) : join(dirname(layout.taskLog(project)), 'spawn-operations.lock'); }

export function validateSpawnOperationReceipt(stage, receipt) {
  const fields = Object.hasOwn(RECEIPT_FIELDS, stage) ? RECEIPT_FIELDS[stage] : null;
  if (!fields || !exact(receipt, fields) || fields.some((key) => ['初始消息id', '团队名'].includes(key) ? receipt[key] !== null && !spawnOperationText(receipt[key]) : !spawnOperationText(receipt[key]))) throw new InvalidBody('成员创建阶段或精确回执字段无效；只记录标识，不接收任务书、错误正文或自报完成。');
  return receipt;
}

export function validateSpawnOperationIssue(code, receipts) {
  if (!SPAWN_OPERATION_ISSUE_CODES.includes(code) || !Array.isArray(receipts) || receipts.length > 32) throw new InvalidBody('创建问题只接受封闭故障码及至多32条安全回执；不接收原始错误正文。');
  for (const receipt of receipts) {
    if (!object(receipt) || !Object.hasOwn(receipt, '阶段') || Object.keys(receipt).some((key) => !OUTCOME_RECEIPT_KEYS.includes(key))) throw new InvalidBody('创建问题凭据必须有阶段且只含安全标识、事件序号和布尔字段。');
    for (const [key, value] of Object.entries(receipt)) {
      const valid = key === '事件序号' ? positive(value) : ISSUE_BOOLEANS.includes(key) ? typeof value === 'boolean' : typeof value === 'string' && value.length > 0 && value.trim() === value && value.length <= (key === '阶段' ? 512 : 256);
      if (!valid) throw new InvalidBody('创建问题凭据字段类型或长度无效；不截断、不补未知事实。');
    }
  }
  return receipts;
}

export function validateSpawnOperationEvent(row) {
  const keys = row?.kind === 'intent' ? ['seq', 'at', 'by', 'kind', '项目', '操作id', '任务', '方式', '请求摘要', '拟用实例'] : row?.kind === 'stage' ? ['seq', 'at', 'by', 'kind', '项目', '操作id', '阶段', '回执'] : row?.kind === 'issue' ? ['seq', 'at', 'by', 'kind', '项目', '操作id', '故障码', '已确认阶段'] : null;
  if (!keys || !exact(row, keys) || !positive(row.seq) || !spawnOperationText(row.at) || Number.isNaN(Date.parse(row.at)) || !spawnOperationText(row.项目) || !spawnOperationUUID(row.操作id)) throw new InvalidBody('成员创建事件的种类、信封、项目、UUID或字段集合无效。');
  if (row.kind === 'intent') {
    if (!actor(row.by, 'Lead') || !spawnOperationText(row.任务) || !['subagent', 'team'].includes(row.方式) || typeof row.请求摘要 !== 'string' || !/^[a-f0-9]{64}$/.test(row.请求摘要) || (row.方式 === 'subagent' ? !spawnOperationUUID(row.拟用实例) : row.拟用实例 !== null)) throw new InvalidBody('创建意图必须保存真实Lead、任务、方式、请求摘要及服务器预留实例；预留不代表已创建。');
  } else {
    if (!actor(row.by, '系统') || row.by.id !== SPAWN_OPERATION_RECORDER.id) throw new InvalidBody('阶段事实只能标记内部记录来源，不能伪签为旧Lead的本人动作。');
    if (row.kind === 'stage') validateSpawnOperationReceipt(row.阶段, row.回执);
    else validateSpawnOperationIssue(row.故障码, row.已确认阶段);
  }
  return row;
}

/** 全量严格折叠。同任务只准一份意图；同阶段认回在服务层完成，账本不接受重复行。 */
export function foldSpawnOperationLedger(rows, project = null, file = 'spawn-operations.jsonl') {
  const operations = new Map();
  const tasks = new Set();
  const candidates = new Set();
  let ledgerProject = project;
  const fail = (index, reason) => { throw new Fault('SPAWN_OPERATION_LEDGER_INVALID', `成员创建账本第 ${index + 1} 行${reason}；不能跳行、猜测未创建或重新放行宿主。`, { detail: { file, line: index + 1, reason } }); };
  for (const [index, row] of rows.entries()) {
    try { validateSpawnOperationEvent(row); } catch { fail(index, '不是完整可识别的创建事件'); }
    if (ledgerProject === null) ledgerProject = row.项目;
    if (row.seq !== index + 1 || row.项目 !== ledgerProject) fail(index, '序号不连续或事件被迁移到另一项目');
    const prior = operations.get(row.操作id);
    if (row.kind === 'intent') {
      if (prior || tasks.has(row.任务) || (row.拟用实例 !== null && candidates.has(row.拟用实例))) fail(index, '重复操作、同任务重复意图或重复预留实例');
      tasks.add(row.任务);
      if (row.拟用实例 !== null) candidates.add(row.拟用实例);
      operations.set(row.操作id, { 操作id: row.操作id, 项目: row.项目, 任务: row.任务, 方式: row.方式, 发起主体: structuredClone(row.by), 请求摘要: row.请求摘要, 拟用实例: row.拟用实例,
        状态: 'intent', 起始于: row.at, 起始事件序号: row.seq, 最新事件序号: row.seq,
        阶段: [{ 阶段: 'intent', 回执: { 拟用实例: row.拟用实例 }, 于: row.at, 事件序号: row.seq }], 问题: [] });
      continue;
    }
    if (row.kind === 'issue') {
      if (!prior || prior.项目 !== row.项目 || prior.问题.some((issue) => issue.故障码 === row.故障码)) fail(index, '问题缺少同源意图或同故障码重复记录');
      if (row.已确认阶段.some((receipt) => (Object.hasOwn(receipt, '项目') && receipt.项目 !== prior.项目) || (Object.hasOwn(receipt, '任务') && receipt.任务 !== prior.任务) || (Object.hasOwn(receipt, '操作id') && receipt.操作id !== prior.操作id) || (Object.hasOwn(receipt, '拟用实例') && receipt.拟用实例 !== prior.拟用实例))) fail(index, '问题报告的项目、任务、操作或预留实例不匹配');
      prior.问题.push({ 故障码: row.故障码, 已确认阶段: structuredClone(row.已确认阶段), 于: row.at, 事件序号: row.seq, 来源: '内部模块报告；本记录不代替底层事实真源核验' });
      prior.最新事件序号 = row.seq;
      continue;
    }
    if (!prior || prior.项目 !== row.项目 || row.阶段 !== SPAWN_OPERATION_STAGES[prior.阶段.length - 1]) fail(index, '缺少同源意图、阶段乱序或终态后新增阶段');
    const receipt = row.回执;
    const host = prior.阶段.find((item) => item.阶段 === 'host_returned')?.回执;
    if (row.阶段 === 'host_returned' ? prior.方式 === 'subagent' && receipt.实例 !== prior.拟用实例 : Object.hasOwn(receipt, '实例') && receipt.实例 !== host?.实例) fail(index, '宿主实例与预留或已有回执不一致');
    if (Object.hasOwn(receipt, '任务') && receipt.任务 !== prior.任务) fail(index, '阶段任务与创建意图不一致');
    prior.阶段.push({ 阶段: row.阶段, 回执: structuredClone(receipt), 于: row.at, 事件序号: row.seq });
    prior.状态 = row.阶段;
    prior.最新事件序号 = row.seq;
  }
  return operations;
}

export function parseSpawnOperationLedger(value, project = null, file = 'spawn-operations.jsonl') {
  if (value === null || value === '') return [];
  const fail = (line, reason) => { throw new Fault('SPAWN_OPERATION_LEDGER_INVALID', `成员创建账本第 ${line} 行${reason}；不能忽略损坏记录或当成没有创建意图。`, { detail: { file, line, reason } }); };
  if (!value.endsWith('\n')) fail(value.split('\n').length, '末尾缺换行（可能追加中断）');
  const lines = value.slice(0, -1).split('\n');
  const rows = lines.map((line, index) => {
    const content = index === 0 ? stripBom(line) : line;
    if (!content.trim()) fail(index + 1, '为空行而非事件');
    try { return JSON.parse(content); } catch { fail(index + 1, '不是合法JSON'); }
  });
  foldSpawnOperationLedger(rows, project, file);
  return rows;
}
export async function readSpawnOperationLedger(file, project = null) { return parseSpawnOperationLedger(await readTextOrNull(file), project, file); }
export function readSpawnOperationLedgerSync(file, project = null) {
  let value;
  try { value = readFileSync(file, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  return parseSpawnOperationLedger(value, project, file);
}
