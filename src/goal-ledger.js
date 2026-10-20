/** 持久目标事件是当前约束真源；不跳过坏行，也不把来源声明当用户认证。 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readTextOrNull, stripBom } from './kernel/fsx.js';
import { Fault } from './kernel/errors.js';
import { canonical } from './kernel/text.js';

export const GOAL_STATES = Object.freeze(['进行中', '等待', '暂停', '取消', '已完成']);
export const GOAL_NATIVE_TOOLS = Object.freeze(['read', 'read_image', 'glob', 'grep', 'write', 'edit']);
const ENVELOPE = ['seq', 'at', 'by', 'kind', 'id', '修订'];
const FIELDS = {
  goal_created: ['期望结果', '约束', '禁止工具', '完成依据', '来源声明', '下一步', '状态', '请求键', '创建规范摘要'],
  goal_revised: ['期望结果', '约束', '禁止工具', '完成依据', '来源声明'],
  goal_progressed: ['状态', '下一步', '等待原因'],
  goal_state_changed: ['状态'],
  goal_completed: ['说明', '证据', '完成核对', '证据事实'],
  goal_task_linked: ['任务'],
};
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const strings = (value, nonempty = false, maxText = 1000) => Array.isArray(value) && value.length <= 32 && (!nonempty || value.length > 0) && value.every((item) => text(item) && item.length <= maxText) && new Set(value).size === value.length;
const closed = (goal) => ['取消', '已完成'].includes(goal?.状态);

export function goalLogPath(layout, project) { return typeof layout.goalLog === 'function' ? layout.goalLog(project) : join(dirname(layout.taskLog(project)), 'goals.jsonl'); }
export function goalLockPath(layout, project) { return typeof layout.goalLock === 'function' ? layout.goalLock(project) : join(dirname(layout.taskLog(project)), 'goals.lock'); }

/** 同步、异步消费者共用完整事件校验与折叠；返回 Map 不承担身份认证。 */
export function foldGoalLedger(rows, file = 'goals.jsonl') {
  const goals = new Map();
  const owners = new Map();
  const fail = (index, reason) => { throw new Fault('GOAL_LEDGER_INVALID', `目标账本第 ${index + 1} 行${reason}；停止读取与写入，保留原文件核对恢复。`, { detail: { file, line: index + 1, reason } }); };
  for (const [index, row] of rows.entries()) {
    const fields = row && Object.hasOwn(FIELDS, row.kind) ? FIELDS[row.kind] : null;
    if (!row || typeof row !== 'object' || Array.isArray(row) || !fields || !text(row.id) || row.seq !== index + 1 || !text(row.at) || Number.isNaN(Date.parse(row.at)) ||
        !row.by || !text(row.by.id) || Object.keys(row.by).some((key) => !['id', 'kind'].includes(key)) || !['Lead', '主权者'].includes(row.by.kind) || !Number.isSafeInteger(row.修订) || row.修订 < 1 ||
        Object.keys(row).some((key) => ![...ENVELOPE, ...fields].includes(key)) || fields.some((key) => !Object.hasOwn(row, key))) fail(index, '不是完整且可识别的目标事件');
    const prior = goals.get(row.id);
    if (row.kind === 'goal_created' ? prior || row.修订 !== 1 : !prior || row.修订 !== prior.修订 + 1 || closed(prior)) fail(index, '目标不存在、重复创建、修订不连续或终态后仍写入');
    if (['goal_created', 'goal_revised'].includes(row.kind)) {
      if (!text(row.期望结果) || row.期望结果.length > 4000 || !strings(row.约束) || !strings(row.禁止工具) || row.禁止工具.some((tool) => !GOAL_NATIVE_TOOLS.includes(tool)) || !strings(row.完成依据, true) ||
          !row.来源声明 || Object.keys(row.来源声明).sort().join(',') !== ['内容', '用户意图'].sort().join(',') || !text(row.来源声明.内容) || row.来源声明.内容.length > 2000 || row.来源声明.用户意图 !== '未核验') fail(index, '目标内容或未核验来源声明无效');
      if (row.kind === 'goal_created' && (row.状态 !== '进行中' || !text(row.下一步) || row.下一步.length > 2000 || (row.请求键 !== null && (!text(row.请求键) || row.请求键.length > 128)) || !/^[a-f0-9]{64}$/.test(row.创建规范摘要))) fail(index, '初始状态、下一步或请求指纹无效');
      if (prior && row.by.kind === 'Lead' && (row.期望结果 !== prior.期望结果 || canonical(row.完成依据) !== canonical(prior.完成依据) || prior.约束.some((value) => !row.约束.includes(value)) || prior.禁止工具.some((value) => !row.禁止工具.includes(value)))) fail(index, 'Lead 修订改写目标本意或移除了既有限制');
    }
    if (row.kind === 'goal_progressed' && (!['进行中', '等待'].includes(prior.状态) || !['进行中', '等待'].includes(row.状态) || !text(row.下一步) || row.下一步.length > 2000 || (row.状态 === '等待' ? !text(row.等待原因) || row.等待原因.length > 2000 : row.等待原因 !== null))) fail(index, '进展状态、下一步或等待原因无效');
    if (row.kind === 'goal_state_changed' && (row.by.kind !== '主权者' || !['暂停', '取消', '进行中'].includes(row.状态))) fail(index, '状态决定缺少主权者或状态无效');
    if (row.kind === 'goal_completed' && (!['进行中', '等待'].includes(prior.状态) || !text(row.说明) || row.说明.length > 2000 || !strings(row.证据, true, 256))) fail(index, '完成判断缺少说明、证据或来自不可完成状态');
    if (row.kind === 'goal_completed') {
      if (!Array.isArray(row.完成核对) || row.完成核对.length !== prior.完成依据.length || new Set(row.完成核对.map((item) => item?.依据)).size !== prior.完成依据.length ||
          row.完成核对.some((item) => !item || Object.keys(item).some((key) => !['依据', '任务'].includes(key)) || !prior.完成依据.includes(item.依据) || !strings(item.任务, true) || item.任务.some((id) => !row.证据.includes(id))) || row.证据.some((id) => !row.完成核对.some((item) => item.任务.includes(id))) ||
          !Array.isArray(row.证据事实) || row.证据事实.length !== row.证据.length || new Set(row.证据事实.map((fact) => fact?.任务)).size !== row.证据.length || row.证据事实.some((fact) => !fact || !row.证据.includes(fact.任务) || !/^[a-f0-9]{64}$/.test(fact.交付物摘要) || !text(fact.采纳依据) || (fact.票 !== null && !text(fact.票)) || !Number.isSafeInteger(fact.代) || fact.代 < 1 || Object.keys(fact).some((key) => !['任务', '交付物摘要', '采纳依据', '票', '代'].includes(key)))) fail(index, '完成核对未覆盖依据，或证据事实无效');
    }
    if (row.kind === 'goal_task_linked' && (!text(row.任务) || (owners.has(row.任务) && owners.get(row.任务) !== row.id))) fail(index, '任务关联无效或跨目标重复');
    const goal = prior ?? { id: row.id, 修订: 0, 任务关联: [], 来源历史: [], 状态历史: [] };
    if (row.kind === 'goal_created' || row.kind === 'goal_revised') {
      Object.assign(goal, { 期望结果: row.期望结果, 约束: [...row.约束], 禁止工具: [...row.禁止工具], 完成依据: [...row.完成依据], 来源声明: structuredClone(row.来源声明) });
      goal.来源历史.push({ ...structuredClone(row.来源声明), 由: row.by.id, 于: row.at, 修订: row.修订 });
    }
    switch (row.kind) {
      case 'goal_created': Object.assign(goal, { 状态: '进行中', 下一步: row.下一步, 等待原因: null, 创建于: row.at, 创建者: row.by.id, 请求键: row.请求键, 创建规范摘要: row.创建规范摘要 }); break;
      case 'goal_progressed': Object.assign(goal, { 状态: row.状态, 下一步: row.下一步, 等待原因: row.等待原因 }); break;
      case 'goal_state_changed':
        goal.状态历史.push({ 原状态: prior.状态, 状态: row.状态, 由: row.by.id, 于: row.at, 修订: row.修订 });
        goal.状态 = row.状态;
        if (row.状态 === '进行中') goal.等待原因 = null;
        break;
      case 'goal_completed':
        goal.状态 = '已完成';
        goal.完成判断 = { 说明: row.说明, 证据: [...row.证据], 完成核对: structuredClone(row.完成核对), 证据事实: structuredClone(row.证据事实), 由: row.by.id, 主体类型: row.by.kind, 于: row.at, 修订: row.修订, 性质: '主体基于证据的完成判断', 机器证明目标语义: false };
        goal.等待原因 = null;
        break;
      case 'goal_task_linked':
        goal.任务关联 = [...goal.任务关联.filter((link) => link.任务 !== row.任务), { 任务: row.任务, 关联修订: row.修订, 由: row.by.id, 于: row.at }];
        owners.set(row.任务, row.id);
        break;
    }
    goal.修订 = row.修订;
    goal.更新于 = row.at;
    goals.set(row.id, goal);
  }
  return goals;
}

export function parseGoalLedger(value, file = 'goals.jsonl') {
  if (value === null) return [];
  const fail = (line, reason) => { throw new Fault('GOAL_LEDGER_INVALID', `目标账本第 ${line} 行${reason}；不能跳行生成旧约束。`, { detail: { file, line, reason } }); };
  if (value !== '' && !value.endsWith('\n')) fail(value.split('\n').length, '末尾缺换行（可能是中断追加）');
  const rows = [];
  for (const [index, line] of value.split('\n').entries()) {
    const content = stripBom(line.trim());
    if (!content) continue;
    try { rows.push(JSON.parse(content)); } catch { fail(index + 1, '不是合法 JSON'); }
  }
  foldGoalLedger(rows, file);
  return rows;
}

export async function readGoalLedger(file) { return parseGoalLedger(await readTextOrNull(file), file); }
export function readGoalLedgerSync(file) {
  let value;
  try { value = readFileSync(file, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  return parseGoalLedger(value, file);
}

export function goalSnapshotOf(rows, project) {
  const goals = [...foldGoalLedger(rows).values()];
  const 任务归属 = Object.create(null);
  const 任务关联 = Object.create(null);
  for (const goal of goals) for (const link of goal.任务关联) {
    任务归属[link.任务] = goal.id;
    任务关联[link.任务] = { ...link, 目标: goal.id };
  }
  return { 项目: project, 目标: goals, 任务归属, 任务关联 };
}

/** 纯追溯：正式后继继承同一目标当前约束；不接受调用方的自报目标 id。 */
export function constraintsForTaskInSnapshot(node, nodes, snapshot) {
  if (!node?.id) throw new Fault('GOAL_TASK_LINEAGE_INVALID', '缺少任务真源节点，不能判断目标约束。');
  const map = nodes instanceof Map ? new Map(nodes) : new Map((Array.isArray(nodes) ? nodes : Object.values(nodes ?? {})).map((item) => [item.id, item]));
  map.set(node.id, node);
  const seen = new Set();
  const matches = [];
  let current = node;
  for (;;) {
    if (seen.has(current.id)) throw new Fault('GOAL_TASK_LINEAGE_INVALID', '任务前序关系有环，不能跳过目标约束。');
    seen.add(current.id);
    const link = snapshot.任务关联?.[current.id];
    if (link) matches.push({ ...link, 来源任务: current.id });
    if (!current.前序任务) break;
    current = map.get(current.前序任务);
    if (!current) throw new Fault('GOAL_TASK_LINEAGE_INVALID', '前序任务缺失，不能推测目标约束为空。');
  }
  if (!matches.length) return null;
  if (new Set(matches.map((match) => match.目标)).size !== 1) throw new Fault('GOAL_TASK_LINEAGE_CONFLICT', '任务与前序关联了不同目标，停止执行，不能借后继换目标逃过限制。');
  const match = matches[0];
  const goal = snapshot.目标.find((item) => item.id === match.目标);
  if (!goal) throw new Fault('GOAL_LEDGER_INVALID', '目标关联缺少对应目标，不能生成空约束。');
  return { 目标: goal.id, 修订: goal.修订, 状态: goal.状态, 约束: [...goal.约束], 禁止工具: [...goal.禁止工具], 关联修订: match.关联修订, 来源任务: match.来源任务, 直接关联: match.来源任务 === node.id };
}
