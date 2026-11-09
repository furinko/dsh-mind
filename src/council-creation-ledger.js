/** Strict extension of the existing council stream; observations, never replay grants. */
import { Fault } from './kernel/errors.js';
import { readJsonlHealth } from './kernel/fsx.js';
import { validateHostCreationCall, spawnOperationText as text } from './spawn-operation-ledger.js';

export const COUNCIL_CREATION_RECORDER = Object.freeze({ id: 'council-creation-journal', kind: '系统' });
const fields = {
  creation_intent: ['来源会话', '方式', '岗位', '序号', '宿主调用'],
  creation_returned: ['宿主调用id', '实例', '团队名'],
  creation_halted: ['阶段'],
};
const fail = message => { throw new Fault('COUNCIL_CREATION_LEDGER_INVALID', `会审创建记录不一致：${message}。原记录保留，不猜测未创建或自动重放。`); };

/** Never erase an interrupted creation by the generic reader's bad-line skipping. */
export async function readCouncilRows(file) {
  const health = await readJsonlHealth(file);
  if (health.坏行 || !health.末行完整 || health.rows.some(row => !row || Array.isArray(row) || !text(row.id) || !text(row.kind))) fail('事件流损坏或末行不完整');
  return health.rows;
}

/** Mutates only the fresh fold projection. All new event shapes are closed. */
export function applyCouncilCreation(c, row, calls) {
  const extra = fields[row.kind], keys = ['kind', 'id', 'at', 'by', 'eventId', ...(extra ?? [])];
  if (!extra || Object.keys(row).length !== keys.length || keys.some(k => !Object.hasOwn(row, k))
    || !text(row.id) || !text(row.at) || Number.isNaN(Date.parse(row.at)) || !text(row.eventId)) fail('事件信封或种类错误');
  if (row.kind === 'creation_intent') {
    try { validateHostCreationCall(row.宿主调用, row.方式); } catch { fail('宿主调用关联错误'); }
    if (!text(row.来源会话) || row.by?.kind !== 'Lead' || row.by.id !== row.来源会话 || !text(row.岗位)) fail('来源主体或岗位错误');
    const previous = c.创建调用 ?? [];
    if (!['未知', '创建中'].includes(c.状态) || row.序号 !== previous.length + 1
      || !Number.isSafeInteger(row.序号) || row.序号 < 1 || previous.some(x => x.状态 !== 'host_returned')
      || (previous.length && (c.来源会话 !== row.来源会话 || previous[0].方式 !== row.方式))) fail('非连续创建、旧意图未收尾或来源变化');
    if (calls.has(row.宿主调用.调用id)) fail('宿主调用被重复使用');
    calls.add(row.宿主调用.调用id);
    c.来源会话 = row.来源会话;
    c.创建于 ??= row.at;
    c.状态 = '创建中';
    c.创建调用 = [...previous, { 序号: row.序号, 岗位: row.岗位, 方式: row.方式,
      宿主调用: structuredClone(row.宿主调用), 状态: 'intent', 实例: null, 团队名: null, 于: row.at }];
    return;
  }
  if (row.by?.id !== COUNCIL_CREATION_RECORDER.id || row.by.kind !== '系统' || Object.keys(row.by).length !== 2) fail('观察来源错误');
  const previous = c.创建调用 ?? [], last = previous.at(-1);
  if (!last || c.状态 !== '创建中') fail('缺少当前创建意图');
  if (row.kind === 'creation_halted') {
    if (!['create', 'open'].includes(row.阶段)) fail('中止阶段错误');
    c.状态 = '创建未完成'; c.创建中止于 = row.at; c.创建中止阶段 = row.阶段;
    return; // Does NOT certify that a Host child stopped or never existed.
  }
  if (last.状态 !== 'intent' || row.宿主调用id !== last.宿主调用.调用id || !text(row.实例)
    || previous.some(x => x.实例 === row.实例) || (last.方式 === 'team' ? !text(row.团队名) : row.团队名 !== null)) fail('返回关联、实例或团队名不一致');
  Object.assign(last, { 状态: 'host_returned', 实例: row.实例, 团队名: row.团队名, 返回于: row.at });
}

export function assertCouncilCreationOpened(c, row) {
  if (!c.创建调用) return; // Historical councils and non-Host domain adapters.
  const owned = row.创建实例;
  if (c.状态 !== '创建中' || c.来源会话 !== row.来源会话 || !Array.isArray(owned)
    || owned.length !== c.创建调用.length || c.创建调用.some((call, i) => call.状态 !== 'host_returned'
      || owned[i]?.实例 !== call.实例 || owned[i]?.岗位 !== call.岗位)) fail('opened 与已确认宿主调用不对应');
}
