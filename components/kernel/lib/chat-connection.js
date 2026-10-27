import { readFile } from 'node:fs/promises';
import { atomicWrite, serializeByKey, withLock } from '../../../src/kernel/fsx.js';
import { assertPersonaCorePath } from '../../../src/persona-core.js';
import { Fault, InvalidBody } from '../../../src/kernel/errors.js';

const validId = id => typeof id === 'string' && id.trim() === id && id.length > 0 && id.length <= 256 && !/[\u0000-\u001f]/.test(id);
const natural = n => Number.isSafeInteger(n) && n >= 0;
const empty = () => ({ version: 1, sessions: Object.create(null) });
function validate(state) {
  if (state?.version !== 1 || !state.sessions || typeof state.sessions !== 'object' || Array.isArray(state.sessions)) throw Error('Invalid connection state');
  for (const [id, row] of Object.entries(state.sessions)) {
    if (!validId(id) || typeof row?.enabled !== 'boolean' || !natural(row.revision) || !Array.isArray(row.excluded)
        || row.excluded.some(r => !Array.isArray(r) || r.length !== 2 || !natural(r[0]) || r[1] !== null && (!natural(r[1]) || r[1] < r[0]))) throw Error('Invalid session connection');
    if (row.excluded.length > 4096 || row.excluded.some((r, i, all) => i > 0 && (all[i - 1][1] === null || all[i - 1][1] > r[0]))
        || (row.excluded.at(-1)?.[1] === null) !== !row.enabled) throw Error('Invalid connection intervals');
  }
  if (Object.keys(state.sessions).length > 50000) throw Error('Too many sessions');
  return state;
}

/** Human-owned session preference; no conversation text, credentials or permission grants. */
export class ChatConnection {
  constructor(file) { this.file = file; this.state = empty(); this.error = null; }
  async load() {
    try { this.state = await this.readDisk(); this.error = null; }
    catch { this.error = new Fault('MIND_CONNECTION_UNAVAILABLE', '心智开关记录不可读；暂不自动接入，请检查开关记录后重试。'); }
    return this;
  }
  async readDisk() {
    assertPersonaCorePath(this.file, { allowMissing: true });
    let raw;
    try { raw = await readFile(this.file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return empty(); throw error; }
    if (raw.length > 8 * 1024 * 1024) throw Error('Connection state too large');
    return validate(JSON.parse(raw.replace(/^\uFEFF/, '')));
  }
  read(id) {
    if (!validId(id)) throw new InvalidBody('需要明确的当前会话ID。');
    if (this.error) throw this.error;
    const row = Object.hasOwn(this.state.sessions, id) ? this.state.sessions[id] : null;
    return { sessionId: id, enabled: row?.enabled ?? true, revision: row?.revision ?? 0 };
  }
  enabled(id) { try { return this.read(id).enabled; } catch { return false; } }
  revision(id) { try { return this.read(id).revision; } catch { return -1; } }
  allowsCapture(id, seq) {
    if (!this.enabled(id) || !natural(seq)) return false;
    const row = Object.hasOwn(this.state.sessions, id) ? this.state.sessions[id] : null;
    return !(row?.excluded ?? []).some(([from, to]) => seq >= from && (to === null || seq < to));
  }
  async set({ sessionId, enabled, expectedRevision }, nextSeq) {
    if (!validId(sessionId) || typeof enabled !== 'boolean' || !natural(expectedRevision) || !natural(nextSeq)) throw new InvalidBody('心智开关需要会话、boolean状态和当前修订。');
    return serializeByKey(this.file, () => withLock(this.file + '.lock', async () => {
      let state;
      try { state = await this.readDisk(); }
      catch { throw new Fault('MIND_CONNECTION_UNAVAILABLE', '心智开关记录不可读，保留原件，不覆盖未知状态。'); }
      const old = Object.hasOwn(state.sessions, sessionId) ? state.sessions[sessionId] : { enabled: true, revision: 0, excluded: [] };
      if (old.revision !== expectedRevision) throw new Fault('MIND_CONNECTION_CHANGED', '该聊天的心智开关已变化，请重新读取。');
      if (old.enabled === enabled) { this.state = state; this.error = null; return this.read(sessionId); }
      const excluded = old.excluded.map(r => [...r]);
      if (!enabled) excluded.push([nextSeq, null]);
      else {
        const last = excluded.at(-1);
        if (!last || last[1] !== null || nextSeq < last[0]) throw new Fault('MIND_CONNECTION_SCOPE_CHANGED', '会话历史位置变化，不能恢复旧开关范围，请重新读取。');
        last[1] = nextSeq;
      }
      if (excluded.length > 4096 || old.revision >= Number.MAX_SAFE_INTEGER || !Object.hasOwn(state.sessions, sessionId) && Object.keys(state.sessions).length >= 50000) throw new Fault('MIND_CONNECTION_LIMIT', '心智开关记录达到容量，请先维护记录。');
      Object.defineProperty(state.sessions, sessionId, { value: { enabled, revision: old.revision + 1, excluded }, writable: true, enumerable: true, configurable: true });
      assertPersonaCorePath(this.file, { allowMissing: true });
      validate(state);
      const raw = JSON.stringify(state) + '\n';
      if (raw.length > 8 * 1024 * 1024) throw new Fault('MIND_CONNECTION_LIMIT', '心智开关记录达到容量。');
      await atomicWrite(this.file, raw);
      // Publish only after persistence; failed saves never masquerade as a confirmed switch.
      this.state = state; this.error = null;
      return this.read(sessionId);
    }));
  }
}

const LEASE = Symbol('mind-chat-connection');
export function chatConnected(org, session) { return !org.mindConnection || !session?.id || org.mindConnection.enabled(session.id); }
export function chatRevision(org, session) { return session?.id ? org.mindConnection?.revision(session.id) ?? 0 : 0; }
export function chatScope(org, session, spec) {
  if (!chatConnected(org, session)) return null;
  Object.defineProperty(spec, LEASE, { value: chatRevision(org, session) });
  return spec;
}
export function sameChat(org, session, spec) { return chatConnected(org, session) && chatRevision(org, session) === (spec?.[LEASE] ?? 0); }
export function captureAllowed(org, session, seq) { return !org.mindConnection || org.mindConnection.allowsCapture(session?.id, seq); }
