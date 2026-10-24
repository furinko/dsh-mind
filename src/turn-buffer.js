/** 可清理的短期会话资料。宿主事件是来源，缓冲不认证意图，也不自动晋升长期记忆。 */
import { open, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { ensureDir, readJsonOrNull, serializeByKey, withLock } from './kernel/fsx.js';
import { canonical, digest } from './kernel/text.js';
import { Denied, Fault, InvalidBody } from './kernel/errors.js';
import { currentProfessionalScope } from './professional-context.js';

export const TURN_BUFFER_LIMITS = Object.freeze({ days: 30, rounds: 128, messages: 512,
  text: 16384, bytes: 2 * 1024 * 1024, context: 6000, query: 24000 });
const integer = n => Number.isSafeInteger(n) && n >= 0;
const identifier = value => typeof value === 'string' && value.trim() && value.length <= 256;
const positive = n => integer(n) && n > 0;
const fail = () => new Fault('TURN_BUFFER_INVALID', '轮级缓冲损坏或与当前会话不符；保留文件，停止使用旧资料。');

/** 在异步排队前剥掉推理、工具参数、附件、RPC及原始模型流。 */
export function projectTurnEvent(event, context) {
  if (!integer(event?.seq) || typeof event.type !== 'string') throw new InvalidBody('轮级缓冲事件需要有效序号和类型。');
  const row = { seq: event.seq, type: 'skip', time: Number.isFinite(event.time) ? event.time : null };
  const data = event.data;
  if (event.type === 'working-directory/change') return { ...row, type: 'scope-change' };
  if (event.surfaceOp && typeof event.surfaceOp === 'object' && event.surfaceOp.op === 'replace') {
    const { startSeq, endSeq } = event.surfaceOp;
    if (!integer(startSeq) || !integer(endSeq) || startSeq >= event.seq || endSeq >= event.seq) throw new InvalidBody('无效表面替换范围。');
    // Surface order is positional, not numeric. Replacements enter an earlier slot
    // under a newer event number, so startSeq can legitimately exceed endSeq.
    const shadowedSeqs = context?.shadowedSeqs;
    if (!Array.isArray(shadowedSeqs) || !shadowedSeqs.length || shadowedSeqs[0] !== startSeq || shadowedSeqs.at(-1) !== endSeq
        || shadowedSeqs.some(seq => !integer(seq) || seq >= event.seq) || new Set(shadowedSeqs).size !== shadowedSeqs.length) throw new InvalidBody('表面替换需要宿主实际覆盖的有序节点。');
    const replacement = projectTurnEvent({ ...event, surfaceOp: 'append' });
    return { ...row, type: 'replace', startSeq, endSeq, shadowedSeqs: [...shadowedSeqs],
      compact: event.type === 'user/message' && data?.source?.kind === 'compact-checkpoint',
      ...(replacement.type === 'message' ? { message: replacement } : {}) };
  }
  if (['turn/start', 'turn/end'].includes(event.type) && positive(data?.turn)) {
    return { ...row, type: event.type, turn: data.turn,
      ...(event.type === 'turn/end' ? { reason: ['completed', 'canceled', 'aborted', 'blocked', 'error', 'max-tokens', 'interrupted', 'forked', 'stopped'].includes(data.reason?.kind) ? data.reason.kind : 'unknown' } : {}) };
  }
  if (event.surfaceOp !== 'append') return row;
  const human = event.type === 'user/message' && data?.role === 'user' && data.source?.kind === 'user';
  const assistant = event.type === 'assistant/message' && data?.message?.role === 'assistant' && positive(data.turn);
  const message = human ? data : assistant ? data.message : null;
  if (!message || !identifier(message.id) || !Array.isArray(message.content)) return row;
  let text = ''; let clipped = message.content.length > 256;
  for (const block of message.content.slice(0, 256)) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue;
    const separator = text ? '\n' : '';
    const remaining = TURN_BUFFER_LIMITS.text - text.length;
    clipped ||= separator.length + block.text.length > remaining;
    text += (separator + block.text.slice(0, Math.max(0, remaining - separator.length))).slice(0, remaining);
  }
  if (!text.trim()) return row;
  return { ...row, type: 'message', role: human ? 'user' : 'assistant', id: message.id, text, clipped,
    turn: assistant ? data.turn : null, interrupted: assistant && data.interrupted === true };
}

/** Fold only public surface metadata. The caller replays the immutable host prefix. */
export function projectTurnSurfaceEvent(event, nodes) {
  const op = event.surfaceOp;
  if (op && typeof op === 'object' && op.op === 'replace') {
    const start = nodes.indexOf(op.startSeq); const end = nodes.indexOf(op.endSeq);
    if (start < 0 || end < start) throw new InvalidBody('表面替换端点不在宿主当前有序节点范围内。');
    const row = projectTurnEvent(event, { shadowedSeqs: nodes.slice(start, end + 1) });
    nodes.splice(start, end - start + 1, event.seq);
    return row;
  }
  const row = projectTurnEvent(event);
  if (op === 'append') nodes.push(event.seq);
  return row;
}

/** 不复用通用 atomicWrite：私人正文以0600写入，文件sync后原子替换。 */
export async function savePrivateBufferState(file, state) {
  await ensureDir(file);
  const tmp = `${file}.tmp-${randomUUID()}`;
  let handle;
  try {
    handle = await open(tmp, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(state) + '\n', 'utf8');
    await handle.sync();
    await handle.close(); handle = null;
    await rename(tmp, file);
    if (process.platform !== 'win32') {
      const directory = await open(dirname(file), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally {
    await handle?.close();
    await rm(tmp, { force: true });
  }
}
const save = savePrivateBufferState;

export class TurnBufferService {
  constructor({ layout, org, clock }) { Object.assign(this, { layout, org, clock }); }
  file(project, session) { return this.layout.turnBufferFile(project, digest(session)); }
  async authorize(subject, project, session) {
    if (!identifier(project) || !identifier(session)) throw new InvalidBody('轮级缓冲需要当前项目和会话。');
    if (subject?.kind !== 'Lead' || subject.id !== session) throw new Denied('轮级缓冲 · 本会话Lead', '私人轮级缓冲仅供当前会话的真实Lead使用。');
    const scope = await currentProfessionalScope(this.org, subject, project);
    await this.org.policy.check({ subject: scope.actor, action: 'read', target: {
      id: `轮级缓冲/${digest(session)}`, kind: '记忆', authority: '自治', zone: '私有', domain: '个体', project } });
    return scope.stamp;
  }
  async load(project, session) {
    const file = this.file(project, session);
    try {
      const info = await stat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (info && info.size > TURN_BUFFER_LIMITS.bytes + 8192) throw fail();
      const state = await readJsonOrNull(file);
      if (!state) return null;
      if (state.version !== 1 || state.project !== project || state.session !== session || !integer(state.nextSeq)
          || !integer(state.floor) || state.floor > state.nextSeq || !integer(state.missing) || !integer(state.removed)
          || !Array.isArray(state.rounds) || state.rounds.length > TURN_BUFFER_LIMITS.rounds
           || !(state.open === null || positive(state.open))) throw fail();
      if (state.owner !== undefined && (state.owner.kind !== 'Lead' || state.owner.project !== project || state.owner.session !== session)) throw fail();
      let count = 0; let last = -1;
      for (const round of state.rounds) {
        if (!(round.turn === null || positive(round.turn)) || !integer(round.start) || !Number.isFinite(round.at)
            || !['open', 'closed', 'unknown'].includes(round.status) || !Array.isArray(round.messages)) throw fail();
        for (const m of round.messages) {
          if (!integer(m.seq) || m.seq <= last || m.seq >= state.nextSeq || !integer(m.anchor) || m.anchor < m.seq
              || m.anchor >= state.nextSeq || !['user', 'assistant'].includes(m.role) || !identifier(m.id)
              || typeof m.text !== 'string' || m.text.length > TURN_BUFFER_LIMITS.text || typeof m.clipped !== 'boolean'
              || typeof m.interrupted !== 'boolean' || (m.at !== undefined && !Number.isFinite(m.at))) throw fail();
          last = m.seq; count++;
        }
      }
      if (count > TURN_BUFFER_LIMITS.messages) throw fail();
      return state;
    } catch (error) { if (error?.code === 'ENOENT') return null; throw fail(); }
  }
  prune(state) {
    const cutoff = this.clock.ms() - TURN_BUFFER_LIMITS.days * 86400000;
    const remove = () => { const round = state.rounds.shift(); state.removed += round.messages.length; };
    while (state.rounds.length && state.rounds[0].at < cutoff) remove();
    while (state.rounds.length > TURN_BUFFER_LIMITS.rounds
        || state.rounds.reduce((sum, round) => sum + round.messages.length, 0) > TURN_BUFFER_LIMITS.messages
        || Buffer.byteLength(JSON.stringify(state), 'utf8') + 1 > TURN_BUFFER_LIMITS.bytes) {
      if (state.rounds.length > 1) remove();
      else if (state.rounds[0]?.messages.length) { state.rounds[0].messages.shift(); state.removed++; }
      else break;
    }
    return state;
  }
  async position({ subject, project, session }) {
    await this.authorize(subject, project, session);
    const state = await this.load(project, session);
    return state ? { nextSeq: state.nextSeq, floor: state.floor } : null;
  }
  async capture({ subject, project, session, records, fromSeq, throughSeq, active = () => true }) {
    if (!integer(fromSeq) || !integer(throughSeq) || throughSeq < fromSeq || !Array.isArray(records) || records.length > 2048
        || records.some((r, i) => !integer(r.seq) || r.seq < fromSeq || r.seq >= throughSeq || (i && r.seq <= records[i - 1].seq))) throw new InvalidBody('轮级缓冲批次范围无效。');
    const file = this.file(project, session);
    return serializeByKey(file, () => withLock(`${file}.lock`, async () => {
      if (!active()) return;
      const before = await this.authorize(subject, project, session);
      const state = await this.load(project, session) ?? { version: 1, project, session,
        nextSeq: fromSeq, floor: fromSeq, missing: 0, removed: 0, open: null, rounds: [] };
      state.owner = { kind: 'Lead', project, session };
      if (throughSeq <= state.nextSeq) {
        // 重复事件和清空前迟到的批次都不能复活正文；顺便物理清理已到期资料。
        const previous = JSON.stringify(state); this.prune(state);
        if (previous !== JSON.stringify(state) && active()) await save(file, state);
        return;
      }
      if (fromSeq > state.nextSeq) { state.missing += fromSeq - state.nextSeq; state.open = null; }
      for (let row of records) {
        if (row.seq < state.nextSeq) continue;
        if (row.type === 'scope-change') {
          if (state.rounds.at(-1)?.status === 'open') state.rounds.at(-1).status = 'unknown';
          state.open = null; continue;
        }
        if (row.type === 'replace') {
          if (!Array.isArray(row.shadowedSeqs) || !row.shadowedSeqs.length
              || row.shadowedSeqs[0] !== row.startSeq || row.shadowedSeqs.at(-1) !== row.endSeq
              || row.shadowedSeqs.some(seq => !integer(seq) || seq >= row.seq)) throw new InvalidBody('轮级缓冲替换缺少可核对的表面节点。');
          const shadowed = new Set(row.shadowedSeqs);
          for (const round of state.rounds) round.messages = round.messages.filter(m => {
            if (!shadowed.has(m.anchor)) return true;
            if (row.compact) { m.anchor = row.seq; return true; }
            state.removed++; return false;
          });
          if (!row.message) continue;
          row = row.message;
        }
        if (row.type === 'turn/start') {
          if (state.rounds.at(-1)?.status === 'open') state.rounds.at(-1).status = 'unknown';
          state.open = row.turn;
          state.rounds.push({ turn: row.turn, start: row.seq, at: row.time ?? this.clock.ms(), status: 'open', messages: [] });
        } else if (row.type === 'turn/end') {
          const round = state.rounds.at(-1);
          if (round?.turn === row.turn) { round.status = 'closed'; round.reason = row.reason; }
          state.open = null;
        } else if (row.type === 'message') {
          let round = state.rounds.at(-1);
          const turn = row.turn ?? state.open;
          if (!round || round.turn !== turn || round.status === 'closed') {
            round = { turn, start: row.seq, at: row.time ?? this.clock.ms(), status: turn === null ? 'unknown' : 'open', messages: [] };
            state.rounds.push(round);
          }
          round.messages.push({ seq: row.seq, anchor: row.seq, role: row.role, id: row.id,
            text: row.text, clipped: row.clipped, interrupted: row.interrupted, at: row.time ?? this.clock.ms() });
          round.at = Math.max(round.at, row.time ?? this.clock.ms());
        }
      }
      state.nextSeq = throughSeq;
      this.prune(state);
      if (before !== await this.authorize(subject, project, session)) throw new Denied('轮级缓冲 · 身份变化', '身份变化，丢弃本次缓冲写入。');
      if (!active()) return;
      await save(file, state);
    }, { timeoutMs: 3000 }));
  }
  async read({ subject, project, session, limit = 16, offset = 0, id, dataVersion, budget = TURN_BUFFER_LIMITS.query, visible = [] }) {
    if (!positive(limit) || limit > 100 || !integer(offset) || !positive(budget) || budget > TURN_BUFFER_LIMITS.query
        || (id !== undefined && !identifier(id))) throw new InvalidBody('轮级缓冲limit须为1至100，偏移为非负整数，内容预算须为1至24000，id须为消息标识。');
    const before = await this.authorize(subject, project, session);
    const stored = await this.load(project, session);
    const state = stored ? this.prune(structuredClone(stored)) : null;
    const visibleSet = new Set(visible);
    const version = digest(canonical(state ? { rounds: state.rounds, floor: state.floor, missing: state.missing, removed: state.removed } : null));
    if (dataVersion !== undefined && dataVersion !== version) throw new Fault('TURN_BUFFER_VERSION_CHANGED', '缓冲内容已变化，请从首页重新读取。');
    const frame = { 版本: 1, 项目: project, 会话: session, 数据版本: version,
      起始事件序号: state?.floor ?? null, 下次事件序号: state?.nextSeq ?? null, 未核事件数: state?.missing ?? 0, 已清理消息数: state?.removed ?? 0,
      保留天数: TURN_BUFFER_LIMITS.days, 下一偏移: null, 截断: false, 轮次: [] };
    // 从新到旧分配预算，再恢复时间顺序。可见正文不重复注入，压缩后的原文仍可作为历史资料。
    const items = (state?.rounds ?? []).flatMap(round => round.messages
      .filter(m => !visibleSet.has(m.seq) && (id === undefined || m.id === id)).map(message => ({ round, message }))).reverse();
    let remaining = budget;
    let consumed = 0;
    for (const { round, message: m } of items.slice(offset, offset + limit)) {
      if (remaining <= 0 || (consumed && m.text.length > remaining)) break;
      const text = m.text.slice(0, remaining); remaining -= text.length; consumed++;
      let group = frame.轮次[0];
      if (!group || group.起始事件序号 !== round.start) {
        group = { 轮次: round.turn, 起始事件序号: round.start, 状态: round.status, 结束原因: round.reason ?? null, 消息: [] };
        frame.轮次.unshift(group);
      }
      group.消息.unshift({ 事件序号: m.seq, 消息: m.id, 角色: m.role, 文本: text,
        截断: m.clipped || text.length < m.text.length, 中断: m.interrupted });
      frame.截断 ||= m.clipped || text.length < m.text.length;
    }
    frame.下一偏移 = offset + consumed < items.length ? offset + consumed : null;
    frame.截断 ||= frame.下一偏移 !== null;
    if (before !== await this.authorize(subject, project, session)) throw new Denied('轮级缓冲 · 身份变化', '身份变化，丢弃旧缓冲资料。');
    return frame;
  }
  async forget({ subject, project, session, throughSeq }) {
    if (!integer(throughSeq)) throw new InvalidBody('清空缓冲需要宿主会话当前位置。');
    const file = this.file(project, session);
    return serializeByKey(file, () => withLock(`${file}.lock`, async () => {
      await this.authorize(subject, project, session);
      const previous = await this.load(project, session).catch(error => { if (error.code === 'TURN_BUFFER_INVALID') return null; throw error; });
      const nextSeq = Math.max(throughSeq, previous?.nextSeq ?? 0);
      await save(file, { version: 1, project, session, owner: { kind: 'Lead', project, session }, nextSeq, floor: nextSeq,
        missing: 0, removed: 0, open: null, rounds: [] });
      return { 已清空: true, 下次事件序号: nextSeq };
    }, { timeoutMs: 3000 }));
  }
}
