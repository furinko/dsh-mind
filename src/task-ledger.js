/** 任务事件流是授权真源：损坏时不得跳行生成较早的权限投影。 */
import { readFileSync } from 'node:fs';
import { readTextOrNull, stripBom } from './kernel/fsx.js';
import { Fault } from './kernel/errors.js';
import { validateStoredKnowledgeAdoption } from './knowledge-reuse-contract.js';

const EVENT_KINDS = new Set([
  'created', 'dispatched', 'reassigned', 'bound', 'started', 'submitted', 'reviewed',
  'review_nominated', 'review_assigned', 'review_exempted', 'rejected', 'pending',
  'resolved', 'artifact', 'escalated', 'settled', 'accepted', 'closed',
  'debate_opened', 'debate_round', 'debate_converged',
]);

/**
 * 同步工具闸与异步服务共享同一严格解析器；缺文件与坏文件的含义不同。
 * @param {string|null} text @param {string} [file]
 * @returns {object[]} @throws {Fault} 坏JSON、撕裂末行或不可识别事件；无写副作用。
 */
export function parseTaskLedger(text, file = 'tasks.jsonl') {
  if (text === null) return [];
  const fail = (line, reason) => {
    throw new Fault('TASK_LEDGER_INVALID', `任务账本损坏，第 ${line} 行${reason}；停止读取和写入，请保留原文件并按备份/审计核对恢复，不能跳行重算权限。`, { detail: { file, line, reason } });
  };
  if (text !== '' && !text.endsWith('\n')) fail(text.split('\n').length, '末尾缺少换行（可能是追加中断）');
  const rows = [];
  for (const [index, line] of text.split('\n').entries()) {
    const value = stripBom(line.trim());
    if (!value) continue;
    let row;
    try { row = JSON.parse(value); }
    catch { fail(index + 1, '不是合法 JSON'); }
    if (!row || typeof row !== 'object' || Array.isArray(row) ||
        typeof row.id !== 'string' || !row.id.trim() || !EVENT_KINDS.has(row.kind)) {
      fail(index + 1, '不是可识别的任务事件');
    }
    if (Object.hasOwn(row, '采用知识')) {
      try {
        if (row.kind !== 'submitted' || !Number.isSafeInteger(row.代) || row.代 < 1) fail(index + 1, '采用声明不属于明确本代交卷');
        validateStoredKnowledgeAdoption(row.采用知识);
      } catch { fail(index + 1, '采用知识声明结构非法'); }
    }
    rows.push(row);
  }
  return rows;
}

/** @param {string} file @returns {Promise<object[]>} @throws {Fault} 账本损坏；不存在回空数组，无写副作用。 */
export async function readTaskLedger(file) {
  return parseTaskLedger(await readTextOrNull(file), file);
}

/** @param {string} file @returns {object[]} @throws {Fault} 账本损坏；不存在回空数组，无写副作用。 */
export function readTaskLedgerSync(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  return parseTaskLedger(text, file);
}
