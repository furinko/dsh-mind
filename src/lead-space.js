/** Lead's optional creative workspace and bounded free-time ledger. Formal memory stays in MemoryService. */
import { constants } from 'node:fs';
import { mkdir, open, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { serializeByKey, withLock } from './kernel/fsx.js';
import { savePrivateBufferState } from './turn-buffer.js';
import { assertPersonaCorePath } from './persona-core.js';
import { digest } from './kernel/text.js';
import { Denied, Fault, InvalidBody } from './kernel/errors.js';

export const LEAD_SPACE_LIMITS = Object.freeze({ notes: 128, fileBytes: 32768, text: 6000, calls: 4, seconds: 60, outputTokens: 1500 });
export const LEAD_SPACE_DEFAULTS = Object.freeze({ enabled: false, timezone: 'UTC', times: ['10:00', '20:00'], dailyCalls: 4, seconds: 60 });
const own = (v, keys) => { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k))) throw new InvalidBody(`只接受字段：${keys.join(', ')}。`); };
const text = (v, max) => typeof v === 'string' && !!v.trim() && v.length <= max && Buffer.from(v).toString('utf8') === v;
const idOK = id => typeof id === 'string' && /^note-[a-f0-9-]{36}$/.test(id);
const conflict = () => new Fault('LEAD_SPACE_CONFLICT', '内容或设置已变化，请重新读取后再保存。');
const blank = () => ({ version: 1, revision: 0, config: structuredClone(LEAD_SPACE_DEFAULTS), usage: {}, wakes: [] });
export function freeTimeLocal(now, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(p => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}
export function freeTimeConfig(input) {
  own(input, Object.keys(LEAD_SPACE_DEFAULTS));
  if (typeof input.enabled !== 'boolean' || !text(input.timezone, 100)) throw new InvalidBody('自由活动需要开关和时区。');
  try { freeTimeLocal(new Date(), input.timezone); } catch { throw new InvalidBody('请选择有效的 IANA 时区。'); }
  if (!Array.isArray(input.times) || input.times.length < 1 || input.times.length > 2 || new Set(input.times).size !== input.times.length
    || input.times.some(t => typeof t !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(t))) throw new InvalidBody('每天选择一至两个不同的时间（HH:mm）。');
  if (!Number.isSafeInteger(input.dailyCalls) || input.dailyCalls < 1 || input.dailyCalls > LEAD_SPACE_LIMITS.calls
    || !Number.isSafeInteger(input.seconds) || input.seconds < 10 || input.seconds > LEAD_SPACE_LIMITS.seconds) throw new InvalidBody('每天最多4次模型请求，每次活动10至60秒。');
  return { ...input, times: [...input.times].sort() };
}

export class LeadSpaceService {
  constructor({ org, clock }) {
    Object.assign(this, { org, clock });
    this.root = join(dirname(org.layout.personaCoreFile()), '自由空间');
    this.notesRoot = join(this.root, '随笔'); this.file = join(this.root, '活动.json');
  }
  async readFile(file) {
    assertPersonaCorePath(file, { allowMissing: true });
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size > 256 * 1024) throw new Fault('LEAD_SPACE_INVALID', '自由空间文件类型或大小异常。');
      const bytes = Buffer.alloc(before.size + 1); const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const after = await handle.stat();
      if (bytesRead !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.size !== after.size) throw conflict();
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead));
    } finally { await handle.close(); }
  }
  async load() {
    let raw; try { raw = await this.readFile(this.file); } catch (error) { if (error.code === 'ENOENT') return blank(); throw error; }
    let state; try { state = JSON.parse(raw); } catch { throw new Fault('LEAD_SPACE_INVALID', '活动账本损坏，保留原件并停止活动。'); }
    if (state?.version !== 1 || !Number.isSafeInteger(state.revision) || !Array.isArray(state.wakes) || !state.usage || typeof state.usage !== 'object') throw new Fault('LEAD_SPACE_INVALID', '活动账本结构异常。');
    if (state.wakes.length > 120 || Object.keys(state.usage).length > 31 || Object.entries(state.usage).some(([day, u]) => !/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isSafeInteger(u?.calls) || u.calls < 0 || u.calls > LEAD_SPACE_LIMITS.calls)
      || state.wakes.some(w => !text(w?.id, 100) || !Number.isSafeInteger(w.calls) || w.calls < 0 || w.calls > 2 || !Number.isFinite(w.startedMs) || !Number.isFinite(w.deadline)
        || !Number.isSafeInteger(w.revision) || !Number.isSafeInteger(w.pid) || !['running', 'completed', 'rested', 'failed', 'interrupted', 'no-material'].includes(w.state))) throw new Fault('LEAD_SPACE_INVALID', '活动计量或回执损坏，停止活动且不重置预算。');
    state.config = freeTimeConfig(state.config); return state;
  }
  async locked(fn) {
    assertPersonaCorePath(this.file, { allowMissing: true });
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    return serializeByKey(this.file, () => withLock(`${this.file}.lock`, async () => {
      const state = await this.load(); const result = await fn(state);
      state.wakes = state.wakes.slice(-120);
      // Usage is keyed by UTC date, so changing timezone cannot reset the allowance.
      for (const day of Object.keys(state.usage).sort().reverse().slice(30)) delete state.usage[day];
      assertPersonaCorePath(this.file, { allowMissing: true }); await savePrivateBufferState(this.file, state); return result;
    }, { timeoutMs: 5000, staleMs: 120000 }));
  }
  target(project) { return { id: 'Lead自由空间', kind: '产物', authority: '自治', zone: '私有', domain: '个体', project }; }
  async authorize(spec, write = false) {
    if (!['Lead', '主权者'].includes(spec?.subject?.kind)) throw new Denied('Lead自由空间', '只向Lead和已认证的人侧开放。');
    // Identity/relationship read is shared; draft writes have their own one-step policy target.
    await this.org.information.authorize(spec);
    if (write && spec.subject.kind === 'Lead') {
      const member = (await this.org.registry.identity()).members?.[spec.subject.id];
      const card = await this.org.registry.cardOf(spec.subject.id);
      if (card?.就绪 !== true || !member?.卡版本?.摘要 || card.卡版本?.摘要 !== member.卡版本.摘要) throw new Denied('自由空间身份凭证', '需要当前真实Lead的有效钉版凭据。');
    }
    await this.org.policy.check({ subject: spec.subject, action: write ? 'write' : 'read', target: this.target(spec.project) });
  }
  async notes(spec, { globalOnly = false } = {}) {
    await this.authorize(spec);
    assertPersonaCorePath(this.notesRoot, { allowMissing: true });
    let names; try { names = await readdir(this.notesRoot); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    if (names.length > LEAD_SPACE_LIMITS.notes) throw new Fault('LEAD_SPACE_FULL', '随笔目录达到容量，请先从人侧清理。');
    const result = [];
    for (const name of names.sort()) {
      if (!name.endsWith('.md') || !idOK(name.slice(0, -3))) continue;
      const note = await this.noteFile(name.slice(0, -3));
      if (globalOnly && (note.scope.project !== null || note.scope.relationship !== null)) continue;
      if (await this.org.dataOwnership.allows(note.scope, spec.subject, spec.project)) result.push(note);
    }
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async noteFile(id) {
    if (!idOK(id)) throw new InvalidBody('随笔ID无效。');
    const raw = await this.readFile(join(this.notesRoot, `${id}.md`));
    if (Buffer.byteLength(raw) > LEAD_SPACE_LIMITS.fileBytes) throw new Fault('LEAD_SPACE_INVALID', '随笔超出大小限制。');
    const end = raw.indexOf('\n'); let meta;
    try { meta = JSON.parse(raw.slice(0, end).match(/^<!-- mind-note (.+) -->$/)?.[1]); } catch { /* Report corruption without reclassifying it. */ }
    if (meta?.id !== id || meta.version !== 1 || !text(meta.title, 160) || !Number.isSafeInteger(meta.revision) || meta.revision < 1
      || !meta.scope || meta.scope.audience !== 'lead' || !Array.isArray(meta.scope.roles) || meta.scope.roles.length
      || !(meta.scope.project === null || text(meta.scope.project, 256)) || !(meta.scope.relationship === null || text(meta.scope.relationship, 256))
      || typeof meta.share !== 'boolean' || typeof meta.humanEdited !== 'boolean'
      || !text(meta.updatedAt, 100)) throw new Fault('LEAD_SPACE_INVALID', '随笔标记损坏，保留原文件。');
    return { ...meta, text: raw.slice(end + 1), hash: digest(raw), path: join(this.notesRoot, `${id}.md`) };
  }
  async query(spec, input = {}) {
    own(input, ['id', 'offset', 'limit']);
    const notes = await this.notes(spec);
    if (input.id) { const note = notes.find(n => n.id === input.id); if (!note) throw new Denied('随笔范围', '随笔不存在或不在当前关系、项目范围。'); return note; }
    const offset = input.offset ?? 0; const limit = input.limit ?? 10;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 30) throw new InvalidBody('分页范围无效。');
    const state = await this.load();
    return { root: this.notesRoot, total: notes.length, entries: notes.slice(offset, offset + limit).map(({ text: _text, ...meta }) => meta), nextOffset: offset + limit < notes.length ? offset + limit : null,
      config: state.config, revision: state.revision, usage: state.usage[new Date(this.clock.ms()).toISOString().slice(0, 10)] ?? { calls: 0 }, wakes: state.wakes.slice(-10).reverse(),
      claim: '自由草稿，不是正式记忆、任务交付或能力认证；不自动收录，不设产量指标。' };
  }
  async update(spec, input, { global = false, check = async () => {} } = {}) {
    own(input, ['op', 'id', 'revision', 'hash', 'title', 'text', 'share']);
    if (!['write', 'remove'].includes(input.op)) throw new InvalidBody('自由空间操作为write/remove。');
    await this.authorize(spec, true);
    const stamp = await this.org.dataOwnership.stamp(spec.subject.id);
    return this.locked(async () => {
      await check(); await this.authorize(spec, true);
      if (stamp !== await this.org.dataOwnership.stamp(spec.subject.id)) throw conflict();
      let prior = null;
      if (input.id !== undefined) {
        prior = (await this.notes(spec)).find(n => n.id === input.id);
        if (!prior) throw new Denied('随笔范围', '随笔不存在或不在当前范围。');
        if (prior.revision !== input.revision || prior.hash !== input.hash) throw conflict();
        if (prior.humanEdited && spec.subject.kind !== '主权者') throw new Denied('人侧修订保护', '人侧修订的草稿由人侧继续维护；Lead可另写新稿。');
      }
      if (input.op === 'remove') {
        if (!prior) throw new InvalidBody('删除需要当前随笔ID、revision与hash。');
        await check(); assertPersonaCorePath(prior.path); await rm(prior.path);
        await this.audit(spec, '删除随笔', prior.id); return { id: prior.id, removed: true };
      }
      if (!text(input.title, 160) || !text(input.text, LEAD_SPACE_LIMITS.text) || input.share !== undefined && typeof input.share !== 'boolean') throw new InvalidBody('随笔需要标题与最多6000字符的正文，可用share标记下次交谈时的分享候选。');
      if (!prior && (await this.notes({ ...spec, subject: { id: '容量核对', kind: '主权者' } })).length >= LEAD_SPACE_LIMITS.notes) throw new Fault('LEAD_SPACE_FULL', '随笔已满128篇，请先整理。');
      const id = prior?.id ?? `note-${randomUUID()}`;
      const note = { version: 1, id, title: input.title, revision: (prior?.revision ?? 0) + 1, updatedAt: this.clock.iso(),
        humanEdited: spec.subject.kind === '主权者', share: input.share ?? prior?.share ?? false,
        scope: prior?.scope ?? { project: global ? null : spec.project, audience: 'lead', roles: [], relationship: global ? null : await this.org.dataOwnership.relationship(spec.session) },
        claim: '创作/自省草稿，未经事实验证，不构成用户表达或授权' };
      const raw = `<!-- mind-note ${JSON.stringify(note)} -->\n${input.text}`;
      if (Buffer.byteLength(raw) > LEAD_SPACE_LIMITS.fileBytes) throw new InvalidBody('随笔文件过大。');
      await mkdir(this.notesRoot, { recursive: true, mode: 0o700 });
      const file = join(this.notesRoot, `${id}.md`); assertPersonaCorePath(file, { allowMissing: true });
      await check();
      // Same private atomic writer as turn buffers, but Markdown remains the only body source.
      const temp = `${file}.tmp-${randomUUID()}`;
      const handle = await open(temp, 'wx', 0o600);
      try { await handle.writeFile(raw); await handle.sync(); } finally { await handle.close(); }
      try {
        const { rename } = await import('node:fs/promises'); await check();
        if (prior && (await this.noteFile(prior.id)).hash !== prior.hash) throw conflict();
        assertPersonaCorePath(file, { allowMissing: true }); await rename(temp, file);
      }
      finally { await rm(temp, { force: true }); }
      await this.audit(spec, '保存随笔', id); return { ...note, hash: digest(raw), path: file };
    });
  }
  async configure(spec, input) {
    if (spec.subject.kind !== '主权者') throw new Denied('自由活动设置', '只有已认证的人侧可以改变时段、预算和开关。');
    own(input, ['expectedRevision', 'config']); const config = freeTimeConfig(input.config);
    await this.authorize(spec, true);
    const result = await this.locked(state => { if (state.revision !== input.expectedRevision) throw conflict(); state.config = config; state.revision++; return { revision: state.revision }; });
    await this.audit(spec, '自由活动设置', 'Lead自由空间'); return result;
  }
  async reserve(spec) {
    await this.authorize(spec, true);
    return this.locked(state => {
      if (!state.config.enabled) return null;
      const local = freeTimeLocal(new Date(this.clock.ms()), state.config.timezone);
      // No catch-up burst: only the latest slot, within 30 minutes; restart never replays a claimed wake.
      const minutes = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
      const slot = state.config.times.filter(t => minutes(local.time) >= minutes(t) && minutes(local.time) - minutes(t) < 30).at(-1);
      if (!slot || state.wakes.some(w => w.localDay === local.day && w.slot === slot)
        || state.wakes.filter(w => w.startedMs > this.clock.ms() - 86400000).length >= 2) return null;
      const day = new Date(this.clock.ms()).toISOString().slice(0, 10);
      const usage = state.usage[day] ??= { calls: 0 };
      if (usage.calls >= state.config.dailyCalls) return null;
      const wake = { id: `free-${randomUUID()}`, localDay: local.day, slot, timezone: state.config.timezone, day, startedMs: this.clock.ms(), at: this.clock.iso(),
        state: 'running', pid: process.pid, calls: 0, revision: state.revision, session: spec.session, project: spec.project, deadline: this.clock.ms() + state.config.seconds * 1000 };
      state.wakes.push(wake); return structuredClone(wake);
    });
  }
  checkWake(state, wake) {
    const live = state.wakes.find(w => w.id === wake.id);
    if (!live || live.state !== 'running' || !state.config.enabled || state.revision !== wake.revision || this.clock.ms() >= live.deadline) throw new Fault('LEAD_ACTIVITY_CANCELED', '活动已关闭、设置变化或时间预算耗尽。');
    return live;
  }
  async check(spec, wake) { await this.authorize(spec, true); this.checkWake(await this.load(), wake); }
  async reserveCall(spec, wake) {
    await this.authorize(spec, true);
    return this.locked(state => {
      const live = this.checkWake(state, wake); const usage = state.usage[wake.day];
      if (new Date(this.clock.ms()).toISOString().slice(0, 10) !== wake.day || live.calls >= 2 || usage.calls >= state.config.dailyCalls) throw new Fault('LEAD_ACTIVITY_BUDGET', '自由活动请求预算耗尽。');
      live.calls++; usage.calls++; return live.calls;
    });
  }
  async finish(wake, outcome, error = null) {
    return this.locked(state => { const live = state.wakes.find(w => w.id === wake.id); if (live?.state === 'running') Object.assign(live, { state: error ? 'failed' : outcome, error: error ? String(error.code ?? error.name ?? 'unknown') : null, completedAt: this.clock.iso() }); });
  }
  async recover() {
    const state = await this.load(); if (!state.wakes.some(w => w.state === 'running' && w.pid !== process.pid)) return;
    await this.locked(s => { for (const w of s.wakes.filter(w => w.state === 'running' && w.pid !== process.pid)) { let alive = false; try { process.kill(w.pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; } if (!alive) Object.assign(w, { state: 'interrupted', completedAt: this.clock.iso() }); } });
  }
  async audit(spec, action, id) { return this.org.audit.append({ 动作: action, 主体: spec.subject, 对象: { id, kind: '产物' }, 项目: spec.project, 依据: 'Lead自由空间；不自动纳入任务或正式记忆', 结果: '已完成' }); }
}
