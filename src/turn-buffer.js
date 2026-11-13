/** 可清理的短期会话资料。宿主事件是来源，缓冲不认证意图，也不自动晋升长期记忆。 */
import { open, rename, rm, stat, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { ensureDir, readJsonOrNull, serializeByKey, withLock } from './kernel/fsx.js';
import { canonical, digest } from './kernel/text.js';
import { Denied, Fault, InvalidBody } from './kernel/errors.js';
import { currentConversationScope } from './professional-context.js';
import { externalInputSource, externalToolProjection, validConversationOrigin, externalConversationMessage } from './conversation-origin.js';
import { hydrateTurnArchive, saveTurnArchive, turnArchiveBytes } from './turn-archive.js';

// Storage has no message, round or text cap. These are presentation budgets only.
export const TURN_BUFFER_LIMITS = Object.freeze({ days: 14, context: 6000, query: 24000,
  rollbackDays: 7, summaryRounds: 20 });
const integer = n => Number.isSafeInteger(n) && n >= 0;
const identifier = value => typeof value === 'string' && value.trim() && value.length <= 256;
const positive = n => integer(n) && n > 0;
const fail = () => new Fault('TURN_BUFFER_INVALID', '轮级缓冲损坏或与当前会话不符；保留文件，停止使用旧资料。');

/** Only public, committed content: hidden reasoning and raw provider streams never enter storage. */
export function projectTurnEvent(event, context) {
  if (!integer(event?.seq) || typeof event.type !== 'string') throw new InvalidBody('轮级缓冲事件需要有效序号和类型。');
  const row = { seq: event.seq, type: 'skip', time: Number.isFinite(event.time) ? event.time : null };
  const data = event.data;
  const pairedTool = event.type === 'tool/result' ? context?.externalCalls?.get(data?.message?.toolCallId) : null;
  const sent = externalToolProjection(event, context);
  if (sent && identifier(sent.id)) return { ...row, type: 'message', ...sent, clipped: false,
    public: { callId: data?.message?.toolCallId, content: publicContent(data?.message?.content).blocks }, gaps: [],
    turn: positive(data?.turn) ? data.turn : null, interrupted: false };
  if (event.type === 'working-directory/change') return { ...row, type: 'scope-change' };
  if (event.surfaceOp && typeof event.surfaceOp === 'object' && event.surfaceOp.op === 'replace') {
    const { startSeq, endSeq } = event.surfaceOp;
    if (!integer(startSeq) || !integer(endSeq) || startSeq >= event.seq || endSeq >= event.seq) throw new InvalidBody('无效表面替换范围。');
    // Surface order is positional, not numeric. Replacements enter an earlier slot
    // under a newer event number, so startSeq can legitimately exceed endSeq.
    const shadowedSeqs = context?.shadowedSeqs;
    if (!Array.isArray(shadowedSeqs) || !shadowedSeqs.length || shadowedSeqs[0] !== startSeq || shadowedSeqs.at(-1) !== endSeq
        || shadowedSeqs.some(seq => !integer(seq) || seq >= event.seq) || new Set(shadowedSeqs).size !== shadowedSeqs.length) throw new InvalidBody('表面替换需要宿主实际覆盖的有序节点。');
    const replacement = projectTurnEvent({ ...event, surfaceOp: 'append' }, context);
    return { ...row, type: 'replace', startSeq, endSeq, shadowedSeqs: [...shadowedSeqs],
      compact: event.type === 'user/message' && data?.source?.kind === 'compact-checkpoint',
      ...(replacement.type === 'message' ? { message: replacement } : {}) };
  }
  if (['turn/start', 'turn/end'].includes(event.type) && positive(data?.turn)) {
    return { ...row, type: event.type, turn: data.turn,
      ...(event.type === 'turn/end' ? { reason: ['completed', 'canceled', 'aborted', 'blocked', 'error', 'max-tokens', 'interrupted', 'forked', 'stopped'].includes(data.reason?.kind) ? data.reason.kind : 'unknown' } : {}) };
  }
  if (event.type === 'tool/call' && identifier(data?.callId) && identifier(data?.name)) {
    return { ...row, type: 'message', role: 'tool-call', id: data.callId,
      text: '', clipped: false, interrupted: false, turn: positive(data.turn) ? data.turn : null,
      public: { name: data.name, callId: data.callId, ...(data.arguments !== undefined ? { arguments: structuredClone(data.arguments) } : {}) }, gaps: [] };
  }
  if (event.type === 'tool/result' && data?.message?.role === 'tool' && identifier(data.message.id)) {
    if (!pairedTool) return { ...row, type: 'message', role: 'tool-result', id: data.message.id,
      text: '', clipped: false, interrupted: false, turn: positive(data.turn) ? data.turn : null,
      public: { callId: data.message.toolCallId ?? null, resultAvailable: false },
      gaps: [{ kind: 'unpaired-tool-result', detail: '当前保留范围没有同项目的调用，不从迟到结果回灌可能已遗忘的正文。' }] };
    const content = publicContent(data.message.content);
    return { ...row, type: 'message', role: 'tool-result', id: data.message.id,
      text: content.text, clipped: false, interrupted: false, turn: positive(data.turn) ? data.turn : null,
      public: { callId: data.message.toolCallId ?? null, isError: data.message.isError === true, content: content.blocks }, gaps: content.gaps };
  }
  if (event.surfaceOp !== 'append') return row;
  const human = event.type === 'user/message' && data?.role === 'user' && data.source?.kind === 'user';
  const external = event.type === 'user/message' && data?.role === 'user' ? externalInputSource(data.source) : null;
  const assistant = event.type === 'assistant/message' && data?.message?.role === 'assistant' && positive(data.turn);
  const message = human || external ? data : assistant ? data.message : null;
  if (!message || !identifier(message.id) || !Array.isArray(message.content)) return row;
  const content = publicContent(message.content);
  if (!content.text.trim() && !content.blocks.length) return row;
  return { ...row, type: 'message', role: human ? 'user' : external ? 'external-user' : 'assistant', id: message.id,
    text: content.text, clipped: false, public: { content: content.blocks }, gaps: content.gaps, ...(external ? { origin: external } : {}),
    turn: assistant ? data.turn : null, interrupted: assistant && data.interrupted === true };
}

function publicContent(content) {
  const blocks = []; const gaps = []; const texts = [];
  for (const block of Array.isArray(content) ? content : []) {
    if (block?.type === 'text' && typeof block.text === 'string') { texts.push(block.text); blocks.push({ type: 'text', text: block.text }); }
    else if (['image', 'file', 'audio', 'video'].includes(block?.type)) {
      const copy = { type: block.type };
      for (const key of ['url', 'path', 'fileId', 'mimeType', 'name', 'data', 'expiresAt']) if (block[key] !== undefined) copy[key] = structuredClone(block[key]);
      blocks.push(copy);
      if (!copy.data) gaps.push({ kind: 'attachment-reference', status: 'retention-unverified', type: block.type });
    } else if (!['reasoning', 'tool-call'].includes(block?.type)) gaps.push({ kind: 'unsupported-public-content', type: String(block?.type ?? 'unknown') });
  }
  return { text: texts.join('\n'), blocks, gaps };
}

/** Fold only public surface metadata. The caller replays the immutable host prefix. */
export function projectTurnSurfaceEvent(event, nodes, context = {}) {
  const op = event.surfaceOp;
  if (op && typeof op === 'object' && op.op === 'replace') {
    const start = nodes.indexOf(op.startSeq); const end = nodes.indexOf(op.endSeq);
    if (start < 0 || end < start) throw new InvalidBody('表面替换端点不在宿主当前有序节点范围内。');
    const row = projectTurnEvent(event, { ...context, shadowedSeqs: nodes.slice(start, end + 1) });
    nodes.splice(start, end - start + 1, event.seq);
    return row;
  }
  const row = projectTurnEvent(event, context);
  if (op === 'append') nodes.push(event.seq);
  return row;
}

/** 不复用通用 atomicWrite：私人正文以0600写入，文件sync后原子替换。 */
export async function savePrivateBufferState(file, state) {
  return savePrivateBufferText(file, JSON.stringify(state) + '\n');
}
async function savePrivateBufferText(file, text) {
  await ensureDir(file);
  const tmp = `${file}.tmp-${randomUUID()}`;
  let handle;
  try {
    handle = await open(tmp, 'wx', 0o600);
    await handle.writeFile(text, 'utf8');
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

/** Shared fold for live capture and a one-time source-aware history projection. */
export function foldTurnRecords(state, records, now) {
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
      state.rounds.push({ turn: row.turn, start: row.seq, at: row.time ?? now, status: 'open', messages: [] });
    } else if (row.type === 'turn/end') {
      const round = state.rounds.at(-1);
      if (round?.turn === row.turn) { round.status = 'closed'; round.reason = row.reason; }
      state.open = null;
    } else if (row.type === 'message') {
      let round = state.rounds.at(-1);
      const turn = row.turn ?? state.open;
      if (!round || round.turn !== turn || round.status === 'closed') {
        round = { turn, start: row.seq, at: row.time ?? now, status: turn === null ? 'unknown' : 'open', messages: [] };
        state.rounds.push(round);
      }
      round.messages.push({ seq: row.seq, anchor: row.seq, role: row.role, id: row.id,
        text: row.text, clipped: row.clipped, interrupted: row.interrupted,
        ...(row.public ? { public: structuredClone(row.public) } : {}), ...(row.gaps ? { gaps: structuredClone(row.gaps) } : {}),
        ...(row.origin ? { origin: structuredClone(row.origin) } : {}), at: row.time ?? now });
      round.at = Math.max(round.at, row.time ?? now);
    }
  }
  return state;
}

export class TurnBufferService {
  constructor({ layout, org, clock }) { Object.assign(this, { layout, org, clock }); }
  file(project, session) { return this.layout.turnBufferFile(project, digest(session)); }
  async authorize(subject, project, session) {
    if (!identifier(project) || !identifier(session)) throw new InvalidBody('轮级缓冲需要当前项目和会话。');
    if (subject?.kind !== 'Lead' || subject.id !== session) throw new Denied('轮级缓冲 · 本会话Lead', '私人轮级缓冲仅供当前会话的真实Lead使用。');
    const scope = await currentConversationScope(this.org, subject);
    await this.org.policy.check({ subject: scope.actor, action: 'read', target: {
      id: `轮级缓冲/${digest(session)}`, kind: '记忆', authority: '自治', zone: '私有', domain: '个体', project } });
    return scope.credentialStamp;
  }
  async authorizeMutation(subject, project, session) {
    const stamp = await this.authorize(subject, project, session);
    const scope = await currentConversationScope(this.org, subject);
    await this.org.policy.check({ subject: scope.actor, action: 'write', target: {
      id: `轮级缓冲/${digest(session)}`, kind: '记忆', authority: '自治', zone: '私有', domain: '个体', project } });
    if (stamp !== await this.authorize(subject, project, session)) throw new Denied('轮级整理 · 身份变化', '身份变化，停止整理。');
    return stamp;
  }
  async load(project, session) {
    return this.loadKey(project, digest(session), session);
  }
  async loadKey(project, key, expectedSession) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw fail();
    const file = this.layout.turnBufferFile(project, key);
    try {
      let state;
      // A reader may overlap collection of the previous generation's parts. Retry
      // only if the sole commit point changed, never accept a torn generation.
      for (let attempt = 0; ; attempt++) {
        const manifest = await readJsonOrNull(file);
        if (!manifest) return null;
        try { state = await hydrateTurnArchive(file, manifest); break; }
        catch (error) {
          if (attempt >= 2 || canonical(manifest) === canonical(await readJsonOrNull(file))) throw error;
        }
      }
      if (!state) return null;
      const session = state.session;
      if (!identifier(session) || digest(session) !== key || expectedSession !== undefined && session !== expectedSession
          || ![1, 2, 3, 4].includes(state.version) || state.project !== project || !integer(state.nextSeq)
          || !integer(state.floor) || state.floor > state.nextSeq || !integer(state.missing) || !integer(state.removed)
          || !Array.isArray(state.rounds)
           || !(state.open === null || positive(state.open))) throw fail();
      if (state.sourceRecovery !== undefined && (![2, 3].includes(state.sourceRecovery?.version) || !integer(state.sourceRecovery.throughSeq) || state.sourceRecovery.throughSeq > state.nextSeq || !integer(state.sourceRecovery.omitted))) throw fail();
      if (state.sourceProjection !== undefined && ![2, 3].includes(state.sourceProjection)) throw fail();
      if (state.legacyMigration !== undefined && (state.legacyMigration?.version !== 1 || !integer(state.legacyMigration.throughSeq)
          || state.legacyMigration.throughSeq > state.nextSeq || !Number.isFinite(state.legacyMigration.protectedUntil)
          || !/^[a-f0-9]{64}$/.test(state.legacyMigration.originalHash) || typeof state.legacyMigration.ownerMissing !== 'boolean')) throw fail();
      if (state.owner !== undefined && (state.owner.kind !== 'Lead' || state.owner.project !== project || state.owner.session !== session)) throw fail();
      let count = 0; let last = -1;
      for (const round of state.rounds) {
        if (!(round.turn === null || positive(round.turn)) || !integer(round.start) || !Number.isFinite(round.at)
            || !['open', 'closed', 'unknown'].includes(round.status) || !Array.isArray(round.messages)) throw fail();
        for (const m of round.messages) {
          if (!integer(m.seq) || m.seq <= last || m.seq >= state.nextSeq || !integer(m.anchor) || m.anchor < m.seq
              || m.anchor >= state.nextSeq || !['user', 'assistant', 'external-user', 'external-assistant', 'tool-call', 'tool-result'].includes(m.role)
               || externalConversationMessage(m) && (![2, 3, 4].includes(state.version) || state.version === 2 && m.origin?.version !== undefined || !validConversationOrigin(m.origin, m.role))
               || !externalConversationMessage(m) && m.origin !== undefined || !identifier(m.id)
              || typeof m.text !== 'string' || typeof m.clipped !== 'boolean'
              || typeof m.interrupted !== 'boolean' || (m.at !== undefined && !Number.isFinite(m.at))) throw fail();
          last = m.seq; count++;
        }
      }
      return state;
    } catch (error) { if (error?.code === 'ENOENT') return null; throw fail(); }
  }
  prune(state) {
    // An inline legacy document has not passed the lossless conversion boundary.
    // Reads and source replay must not trim it before the backup is established.
    if (state.version !== 4) return state;
    const protection = state.legacyMigration;
    const cutoff = this.clock.ms() - TURN_BUFFER_LIMITS.days * 86400000;
    state.rounds = state.rounds.filter(round => {
      // Unfinished and explicitly selected experiences survive short-term expiry.
      if (protection && this.clock.ms() < protection.protectedUntil && (round.start < protection.throughSeq || round.messages.some(message => message.seq < protection.throughSeq))) return true;
      if (round.at >= cutoff || round.status !== 'closed' || round.retain === true) return true;
      state.removed += round.messages.length; return false;
    });
    return state;
  }
  async saveState(file, state, { forget = false } = {}) {
    const backupFile = file + '.migration-backup';
    let migration = null;
    let original;
    try { original = await readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let inline = null;
    if (!forget && original !== undefined) {
      try { inline = JSON.parse(original.replace(/^\uFEFF/, '')); } catch { throw fail(); }
    }
    if (inline && [1, 2, 3].includes(inline.version)) {
      if (inline.project !== state.project || inline.session !== state.session || !integer(inline.nextSeq)) throw fail();
      const previous = await readJsonOrNull(backupFile);
      if (previous && (previous.version !== 1 || previous.originalHash !== digest(original) || previous.original !== original || !Number.isFinite(previous.expiresAt))) throw new Fault('TURN_MIGRATION_CONFLICT', '迁移回退副本与当前原字节不符，保留现场，不覆盖。');
      migration = previous ?? { version: 1, original, originalHash: digest(original),
        expiresAt: this.clock.ms() + TURN_BUFFER_LIMITS.rollbackDays * 86400000 };
      // An implicit capture/recovery may already contain new facts. Its initial
      // v4 installation is not permission to erase those facts by rollback.
      const payload = value => Object.fromEntries(Object.entries(value).filter(([key]) => !['version','coverageGaps','legacyMigration'].includes(key)));
      migration.postMigrationWrites = migration.postMigrationWrites === true || canonical(payload(inline)) !== canonical(payload(state));
      await save(backupFile, migration);
      state.legacyMigration = { version: 1, throughSeq: inline.nextSeq, protectedUntil: migration.expiresAt,
        originalHash: migration.originalHash, ownerMissing: inline.owner === undefined };
      if (inline.owner === undefined) delete state.owner;
    }
    if (state.version !== 4 && !(state.coverageGaps ?? []).some(gap => gap.kind === 'legacy-capture')) {
      state.coverageGaps = [...(state.coverageGaps ?? []), { kind: 'legacy-capture',
        detail: '旧缓冲曾有消息/轮数/长度上限且未保存全部公开类型；现存内容保留，丢失内容不能凭空恢复。' }];
    }
    if (state.legacyMigration?.ownerMissing && !(state.coverageGaps ?? []).some(gap => gap.kind === 'legacy-owner-unknown')) state.coverageGaps = [...(state.coverageGaps ?? []), { kind: 'legacy-owner-unknown', detail: '原缓冲未记录owner；保留缺失，不追认历史归属。' }];
    // Version 4 denotes the actual manifest/parts format, independently of
    // external-message projection. Publish the old-reader barrier first.
    const marker = join(this.layout.memoryRoot(), 'external-conversation-layout.json');
    const old = await readJsonOrNull(marker);
    if (old && ![2, 3, 4].includes(old.version)) throw fail();
    if (old?.version !== 4) await save(marker, { version: 4 });
    await saveTurnArchive(file, state, async (target, value) => {
      if (target === file && migration) {
        migration.installedHash = digest(JSON.stringify(value) + '\n');
        await save(backupFile, migration);
      }
      await save(target, value);
    });
    const backup = await readJsonOrNull(backupFile);
    if (backup?.expiresAt <= this.clock.ms()) await rm(backupFile, { force: true });
  }
  async recoverProjection({ subject, project, session, expected, state, active = () => true }) {
    const file = this.file(project, session);
    return serializeByKey(file, () => withLock(file + '.lock', async () => {
      if (!active()) return false;
      const proof = await this.authorize(subject, project, session);
      const current = await this.load(project, session);
      if (!current || digest(canonical(current)) !== expected || current.floor !== state.floor || current.nextSeq !== state.nextSeq || state.project !== project || state.session !== session) throw new Fault('TURN_BUFFER_SOURCE_REPLAY_CHANGED', '历史补读期间缓冲或清空边界变化，请重新补读。');
      if (proof !== await this.authorize(subject, project, session) || !active()) return false;
      await this.saveState(file, this.prune(state)); return true;
    }, { timeoutMs: 3000 }));
  }
  async position({ subject, project, session }) {
    await this.authorize(subject, project, session);
    const state = await this.load(project, session);
    return state ? { nextSeq: state.nextSeq, floor: state.floor, sourceProjection: state.sourceProjection ?? 1 } : null;
  }
  async capture({ subject, project, session, records, fromSeq, throughSeq, active = () => true }) {
    if (!integer(fromSeq) || !integer(throughSeq) || throughSeq < fromSeq || !Array.isArray(records) || records.length > 2048
        || records.some((r, i) => !integer(r.seq) || r.seq < fromSeq || r.seq >= throughSeq || (i && r.seq <= records[i - 1].seq))) throw new InvalidBody('轮级缓冲批次范围无效。');
    const file = this.file(project, session);
    return serializeByKey(file, () => withLock(`${file}.lock`, async () => {
      if (!active()) return;
      const before = await this.authorize(subject, project, session);
      const state = await this.load(project, session) ?? { version: 4, project, session,
        sourceProjection: 3, nextSeq: fromSeq, floor: fromSeq, missing: 0, removed: 0, open: null, rounds: [],
        coverageGaps: fromSeq > 0 ? [{ kind: 'uncovered-prefix', throughSeq: fromSeq, detail: '此副本未声明覆盖初始水位之前的历史；继承或宿主不可用范围不能冒充完整。' }] : [] };
      if (state.owner !== undefined || state.version === 4 && !state.legacyMigration?.ownerMissing) state.owner = { kind: 'Lead', project, session };
      if (throughSeq <= state.nextSeq) {
        // 重复事件和清空前迟到的批次都不能复活正文；顺便物理清理已到期资料。
        const previous = JSON.stringify(state); this.prune(state);
        if (previous !== JSON.stringify(state) && active()) await this.saveState(file, state);
        return;
      }
      if (fromSeq > state.nextSeq) { state.missing += fromSeq - state.nextSeq; state.open = null; }
      foldTurnRecords(state, records, this.clock.ms());
      state.nextSeq = throughSeq;
      this.prune(state);
      if (before !== await this.authorize(subject, project, session)) throw new Denied('轮级缓冲 · 身份变化', '身份变化，丢弃本次缓冲写入。');
      if (!active()) return;
      await this.saveState(file, state);
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
      来源投影版本: state?.sourceProjection ?? 1, 历史来源补读: state?.sourceRecovery ?? null,
      起始事件序号: state?.floor ?? null, 下次事件序号: state?.nextSeq ?? null, 未核事件数: state?.missing ?? 0, 已清理消息数: state?.removed ?? 0,
      保留天数: TURN_BUFFER_LIMITS.days, 保存与投影分离: true,
      覆盖缺口: state?.coverageGaps ?? [], 下一偏移: null, 截断: false, 轮次: [] };
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
        截断: m.clipped || text.length < m.text.length, 中断: m.interrupted, 缺口: m.gaps ?? [],
        原文长度: m.text.length, 继续读取: { id: m.id, textOffset: text.length }, ...(m.origin ? { 来源: m.origin } : {}) });
      frame.截断 ||= m.clipped || text.length < m.text.length;
    }
    frame.下一偏移 = offset + consumed < items.length ? offset + consumed : null;
    frame.截断 ||= frame.下一偏移 !== null;
    if (before !== await this.authorize(subject, project, session)) throw new Denied('轮级缓冲 · 身份变化', '身份变化，丢弃旧缓冲资料。');
    return frame;
  }
  /** Cursor through the original body, independently of context/message pagination.
   * Public structured content is fetched explicitly; it is never auto-injected. */
  async readOriginal({ subject, project, session, id, part = 'text', textOffset = 0, limit = 24000, dataVersion }) {
    if (!identifier(id) || !['text', 'public'].includes(part) || !integer(textOffset) || !positive(limit) || limit > 24000) throw new InvalidBody('原文读取需要消息id、text/public字段、非负文本偏移和1至24000的分段长度。');
    const proof = await this.authorize(subject, project, session);
    const stored = await this.load(project, session);
    const state = stored ? this.prune(structuredClone(stored)) : null;
    const version = digest(canonical(state));
    if (dataVersion !== undefined && dataVersion !== version) throw new Fault('TURN_BUFFER_VERSION_CHANGED', '原文已变化，请重新定位来源。');
    const round = state?.rounds.find(r => r.messages.some(m => m.id === id));
    const m = round?.messages.find(m => m.id === id);
    const result = { 数据版本: version, 找到: Boolean(m), 项目: project, 会话: session,
      缺口: [...(state?.coverageGaps ?? []), ...(m?.gaps ?? [])], 下次文本偏移: null };
    const body = m ? (part === 'public' ? JSON.stringify(m.public ?? null) : m.text) : '';
    if (m) Object.assign(result, { 消息: id, 事件序号: m.seq, 轮次: round.turn, 状态: round.status, 角色: m.role, 字段: part,
      文本: body.slice(textOffset, textOffset + limit), 原文长度: body.length,
      下次文本偏移: textOffset + limit < body.length ? textOffset + limit : null,
      历史已截断: m.clipped, 有公开结构: Boolean(m.public),
      来源: m.origin ?? null });
    if (proof !== await this.authorize(subject, project, session)) throw new Denied('轮级原文 · 身份变化', '身份变化，停止读取旧资料。');
    const live = await this.load(project, session);
    if (version !== digest(canonical(live ? this.prune(structuredClone(live)) : null))) throw new Fault('TURN_BUFFER_VERSION_CHANGED', '原文读取期间被清理或替换，丢弃旧页。');
    return result;
  }
  /** A retained experience can remain raw; retaining does not manufacture knowledge. */
  async retain({ subject, project, session, start, retained = true }) {
    if (!integer(start) || typeof retained !== 'boolean') throw new InvalidBody('保留经历需要轮次起始序号及布尔保留值。');
    const file = this.file(project, session);
    return serializeByKey(file, () => withLock(file + '.lock', async () => {
      await this.authorizeMutation(subject, project, session);
      const state = await this.load(project, session); const round = state?.rounds.find(r => r.start === start);
      if (!round) throw new InvalidBody('未找到可保留的原始轮次。');
      round.retain = retained; await this.saveState(file, this.prune(state));
      return { 已保留: retained, 起始事件序号: start };
    }));
  }
  async storageUsage({ subject, project, session }) {
    await this.authorize(subject, project, session);
    return { 总字节: await turnArchiveBytes(this.file(project, session)), 保留天数: TURN_BUFFER_LIMITS.days,
      原文硬轮数上限: null, 回退副本期限天数: TURN_BUFFER_LIMITS.rollbackDays };
  }
  /** Explicit maintenance migration. No old content is discarded on first conversion.
   * A single bounded backup is kept; rollback refuses any post-migration write. */
  async migrate({ subject, project, session }) {
    const file = this.file(project, session);
    return serializeByKey(file, () => withLock(file + '.lock', async () => {
      await this.authorizeMutation(subject, project, session);
      const state = await this.load(project, session);
      if (!state) return { 已迁移: false, 原因: '无原文件' };
      if (state.version === 4) return { 已迁移: false, 原因: '已经使用新格式' };
      const original = await readFile(file, 'utf8');
      const backupFile = file + '.migration-backup';
      const existing = await readJsonOrNull(backupFile);
      if (existing && existing.originalHash !== digest(original)) throw new Fault('TURN_MIGRATION_CONFLICT', '已有迁移回退副本与当前旧文件不同，先核对，不覆盖。');
      const backup = existing ?? { version: 1, original, originalHash: digest(original),
        expiresAt: this.clock.ms() + TURN_BUFFER_LIMITS.rollbackDays * 86400000 };
      await save(backupFile, backup);
      state.coverageGaps = [...(state.coverageGaps ?? []), { kind: 'legacy-capture',
        detail: '旧缓冲曾有消息/轮数/长度上限且未保存全部公开类型；现存内容保留，丢失内容不能凭空恢复。' }];
      await this.saveState(file, state);
      backup.installedHash = digest(await readFile(file, 'utf8')); await save(backupFile, backup);
      return { 已迁移: true, 回退到期: backup.expiresAt, 缺口: state.coverageGaps };
    }));
  }
  async rollbackMigration({ subject, project, session }) {
    const file = this.file(project, session);
    return serializeByKey(file, () => withLock(file + '.lock', async () => {
      await this.authorizeMutation(subject, project, session);
      const backup = await readJsonOrNull(file + '.migration-backup');
      if (!backup || backup.expiresAt <= this.clock.ms()) throw new Fault('TURN_ROLLBACK_EXPIRED', '迁移回退副本不存在或已到期。');
      if (backup.postMigrationWrites === true || digest(backup.original) !== backup.originalHash || digest(await readFile(file, 'utf8')) !== backup.installedHash) {
        throw new Fault('TURN_ROLLBACK_NEW_WRITES', '新格式已写入或迁移未完整确认；先核对并导出新写入，不能覆盖回旧副本。');
      }
      // Restore exact original bytes after validating the preserved document.
      JSON.parse(backup.original.replace(/^\uFEFF/, ''));
      await savePrivateBufferText(file, backup.original);
      const { collectTurnArchive } = await import('./turn-archive.js');
      await collectTurnArchive(file, new Set()); await rm(file + '.migration-backup', { force: true });
      return { 已回退: true, 需核对旧版兼容性: true, 全局读取屏障: 4, 说明: '单会话回退不降低全局屏障；切换旧源码前须完整核对全部v4资料与新写入。' };
    }));
  }
  async maintain({ subject, project, session }) {
    const file = this.file(project, session);
    return serializeByKey(file, () => withLock(file + '.lock', async () => {
      await this.authorizeMutation(subject, project, session);
      const state = await this.load(project, session);
      if (state) await this.saveState(file, this.prune(state));
      const backup = await readJsonOrNull(file + '.migration-backup');
      if (backup?.expiresAt <= this.clock.ms()) await rm(file + '.migration-backup', { force: true });
      return { 总字节: await turnArchiveBytes(file), 已清理消息数: state?.removed ?? 0 };
    }));
  }
  async forget({ subject, project, session, throughSeq }) {
    if (!integer(throughSeq)) throw new InvalidBody('清空缓冲需要宿主会话当前位置。');
    const file = this.file(project, session);
    return serializeByKey(file, () => withLock(`${file}.lock`, async () => {
      await this.authorize(subject, project, session);
      const previous = await this.load(project, session).catch(error => { if (error.code === 'TURN_BUFFER_INVALID') return null; throw error; });
      const nextSeq = Math.max(throughSeq, previous?.nextSeq ?? 0);
      await this.saveState(file, { version: 4, project, session, owner: { kind: 'Lead', project, session }, nextSeq, floor: nextSeq,
        missing: 0, removed: 0, open: null, rounds: [] }, { forget: true });
      await rm(file + '.migration-backup', { force: true });
      // First publish the forget barrier, then purge derivatives while holding the
      // same session writer lock. Delayed summarizers must recheck this floor.
      await this.org.turnSummaries?.forget({ subject, project, session });
      return { 已清空: true, 下次事件序号: nextSeq };
    }, { timeoutMs: 3000 }));
  }
}
