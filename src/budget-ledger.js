/** 目标共享准入尝试账本；拒绝跳坏行，不声称发现合法删除或回滚。 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readTextOrNull, stripBom } from './kernel/fsx.js';
import { Fault } from './kernel/errors.js';

export const BUDGET_CATEGORIES = Object.freeze(['member_file', 'member_spawn']);
export const BUDGET_FILE_TOOLS = Object.freeze(['read', 'read_image', 'glob', 'grep', 'write', 'edit']);
export const BUDGET_UNIT = '受管准入尝试';
const ENVELOPE = ['seq', 'at', 'by', 'kind', 'id'];
const FIELDS = {
  budget_configured: ['预算修订', '上限', '来源声明'],
  budget_reserved: ['预算修订', '执行键', '工具', '类别', '指纹', '单位'],
  budget_settled: ['执行键', '结果'],
};
const text = (value, max = 256) => typeof value === 'string' && value.length > 0 && value.trim() === value && value.length <= max;
const natural = (value) => Number.isSafeInteger(value) && value >= 0;

export function budgetLogPath(layout, project) { return typeof layout.goalBudgetLog === 'function' ? layout.goalBudgetLog(project) : join(dirname(layout.taskLog(project)), 'goal-budgets.jsonl'); }
export function budgetLockPath(layout, project) { return typeof layout.goalBudgetLock === 'function' ? layout.goalBudgetLock(project) : join(dirname(layout.taskLog(project)), 'goal-budgets.lock'); }

/** 返回每目标配置与尝试事实；内部投影可全量，模型 query 必须分页。 */
export function foldBudgetLedger(rows, file = 'goal-budgets.jsonl') {
  const budgets = new Map();
  const executions = new Map();
  const fail = (index, reason) => { throw new Fault('GOAL_BUDGET_LEDGER_INVALID', `目标额度账本第 ${index + 1} 行${reason}；停止准入与写入，保留原文核对，不能跳行恢复余额。`, { detail: { file, line: index + 1, reason } }); };
  for (const [index, row] of rows.entries()) {
    const fields = row && Object.hasOwn(FIELDS, row.kind) ? FIELDS[row.kind] : null;
    if (!row || typeof row !== 'object' || Array.isArray(row) || !fields || !text(row.id) || row.seq !== index + 1 || !text(row.at) || Number.isNaN(Date.parse(row.at)) || !row.by || typeof row.by !== 'object' || Array.isArray(row.by) || !text(row.by.id) ||
        Object.keys(row.by).some((key) => !['id', 'kind', 'roleId'].includes(key)) || Object.keys(row).some((key) => ![...ENVELOPE, ...fields].includes(key)) || fields.some((key) => !Object.hasOwn(row, key))) fail(index, '不是完整可识别的准入事件');
    const budget = budgets.get(row.id);
    if (row.kind === 'budget_configured') {
      if (row.by.kind !== '主权者' || Object.hasOwn(row.by, 'roleId') || !natural(row.预算修订) || row.预算修订 !== (budget?.预算修订 ?? 0) + 1 || !natural(row.上限) ||
          (row.来源声明 !== null && (!row.来源声明 || typeof row.来源声明 !== 'object' || Array.isArray(row.来源声明) || Object.keys(row.来源声明).sort().join(',') !== ['内容', '性质'].sort().join(',') || !text(row.来源声明.内容, 2000) || row.来源声明.性质 !== '调用者声明'))) fail(index, '配置主体、修订、上限或来源声明无效');
      const next = budget ?? { 目标: row.id, 预算修订: 0, 上限: null, 累计准入: 0, 已结算: 0, 未决占用: 0, 尝试: [] };
      Object.assign(next, { 预算修订: row.预算修订, 上限: row.上限, 配置: { 预算修订: row.预算修订, 上限: row.上限, 来源声明: structuredClone(row.来源声明), 由: row.by.id, 于: row.at } });
      budgets.set(row.id, next);
    } else if (row.kind === 'budget_reserved') {
      if (!budget || row.预算修订 !== budget.预算修订 || row.单位 !== 1 || !text(row.执行键) || executions.has(row.执行键) || !BUDGET_CATEGORIES.includes(row.类别) || !text(row.工具, 128) || !/^[a-f0-9]{64}$/.test(row.指纹) ||
          !['Lead', '成员'].includes(row.by.kind) || (row.by.kind === '成员' ? !text(row.by.roleId) || ['Lead', '主权者', '出厂作者'].includes(row.by.roleId) : Object.hasOwn(row.by, 'roleId')) ||
          (row.类别 === 'member_file' ? !BUDGET_FILE_TOOLS.includes(row.工具) : row.工具 !== 'member_spawn' || row.by.kind !== 'Lead') || budget.累计准入 >= budget.上限) fail(index, '准入缺配置、重复执行键、主体/工具无效或已超额度');
      const attempt = { 目标: row.id, 执行键: row.执行键, 主体: structuredClone(row.by), 工具: row.工具, 类别: row.类别, 指纹: row.指纹, 单位: 1, 预算修订: row.预算修订, 状态: 'reserved', 结果: null, 保留于: row.at, 结算于: null, 保留事件序号: row.seq };
      budget.尝试.push(attempt);
      budget.累计准入 += 1;
      budget.未决占用 += 1;
      executions.set(row.执行键, attempt);
    } else {
      const attempt = executions.get(row.执行键);
      if (row.by.id !== 'goal-budget-host-result' || row.by.kind !== '系统' || Object.hasOwn(row.by, 'roleId') || !text(row.执行键) || !['success', 'error'].includes(row.结果) || !attempt || attempt.目标 !== row.id || attempt.状态 !== 'reserved' || !budget) fail(index, '结果没有唯一未决准入、重复结算或伪造结算主体');
      Object.assign(attempt, { 状态: 'settled', 结果: row.结果, 结算于: row.at, 结算事件序号: row.seq });
      budget.已结算 += 1;
      budget.未决占用 -= 1;
    }
    const current = budgets.get(row.id);
    current.可准入 = Math.max(0, current.上限 - current.累计准入);
    if (current.累计准入 !== current.已结算 + current.未决占用) fail(index, '累计、结算与占用不一致');
  }
  return budgets;
}

export function parseBudgetLedger(value, file = 'goal-budgets.jsonl') {
  if (value === null) return [];
  const fail = (line, reason) => { throw new Fault('GOAL_BUDGET_LEDGER_INVALID', `目标额度账本第 ${line} 行${reason}；不能跳行或把未知折成零。`, { detail: { file, line, reason } }); };
  if (value !== '' && !value.endsWith('\n')) fail(value.split('\n').length, '末尾缺换行（可能是中断追加）');
  const rows = [];
  for (const [index, line] of value.split('\n').entries()) {
    const content = stripBom(line.trim());
    if (!content) continue;
    try { rows.push(JSON.parse(content)); } catch { fail(index + 1, '不是合法 JSON'); }
  }
  foldBudgetLedger(rows, file);
  return rows;
}
export async function readBudgetLedger(file) { return parseBudgetLedger(await readTextOrNull(file), file); }
export function readBudgetLedgerSync(file) {
  let value;
  try { value = readFileSync(file, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  return parseBudgetLedger(value, file);
}
