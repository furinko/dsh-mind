/** Durable personal pursuits: explicit priorities, revisable satisfaction, and checked activity receipts. */
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical, digest } from './kernel/text.js';
import { serializeByKey, stripBom, withLock } from './kernel/fsx.js';
import { savePrivateBufferState } from './turn-buffer.js';
import { assertPersonaCorePath } from './persona-core.js';
import { Denied, Fault, InvalidBody } from './kernel/errors.js';

export const DESIRE_LIMITS = Object.freeze({ desires: 64, retired: 256, seen: 512, history: 8, bytes: 256 * 1024 });
const natural = n => Number.isSafeInteger(n) && n >= 0;
const unit = n => Number.isFinite(n) && n >= 0 && n <= 1;
const text = (v, max) => typeof v === 'string' && !!v.trim() && v.length <= max && Buffer.from(v).toString('utf8') === v && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v);
const own = (v, keys) => { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k))) throw new InvalidBody(`追求资料只接受字段：${keys.join(', ')}。`); };
const conflict = () => new Fault('LEAD_DESIRE_CONFLICT', '追求、版本或清空代次已经变化，请重新读取。');
const invalid = () => new Fault('LEAD_DESIRE_INVALID', '追求账本不可用，保留原件，不沿用旧追求。');
const canceled = () => new Fault('LEAD_ACTIVITY_CANCELED', '追求、范围或本次活动已经变化，不提交迟到结果。');
const blank = () => ({ version: 1, revision: 0, epoch: 0, enabled: true, desires: [], retired: [], seen: [] });
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const id = v => typeof v === 'string' && /^desire-[a-f0-9-]{36}$/.test(v);
const rounded = n => Math.round(n * 1000) / 1000;
function content(v) {
  own(v, ['title', 'reason', 'criterion', 'kind', 'importance', 'commitment', 'activities', 'nextStep', 'renewalHours']);
  const renewalHours = v.renewalHours ?? 72;
  if (!text(v.title, 120) || !text(v.reason, 400) || !text(v.criterion, 400) || !text(v.nextStep, 400)
    || !['finite', 'ongoing'].includes(v.kind) || !unit(v.importance) || !unit(v.commitment)
    || !Number.isFinite(renewalHours) || renewalHours < 6 || renewalHours > 720
    || !Array.isArray(v.activities) || !v.activities.length || v.activities.length > 3
    || new Set(v.activities).size !== v.activities.length || v.activities.some(a => !['read', 'write', 'rest'].includes(a))) throw new InvalidBody('追求需要名称、理由、满足判据、下一步、finite/ongoing、0至1的重要性与投入意愿，以及read/write/rest活动；持续兴趣恢复半衰期6至720小时。');
  return { ...v, activities: [...v.activities], renewalHours };
}
function evaluation(v) {
  own(v, ['outcome', 'satisfaction', 'progress', 'reflection', 'nextStep']);
  if (!['progress', 'fulfilled', 'setback', 'no-change'].includes(v.outcome) || !unit(v.satisfaction) || !unit(v.progress)
    || !text(v.reflection, 500) || !text(v.nextStep, 400) || v.outcome === 'fulfilled' && (v.satisfaction !== 1 || v.progress !== 1)) throw new InvalidBody('反馈需要结果、0至1的满足度和进度、反思与下一步；满足时两项均为1。');
  return { ...v };
}
function receiptShape(v) {
  if (v?.kind === 'note') {
    own(v, ['kind', 'id', 'revision', 'hash']);
    if (!text(v.id, 100) || !natural(v.revision) || !v.revision || !hash(v.hash)) throw invalid();
  } else if (v?.kind === 'reading') {
    own(v, ['kind', 'id', 'material', 'hash', 'partial']);
    if (!text(v.id, 100) || !text(v.material, 100) || !hash(v.hash) || v.partial !== undefined && typeof v.partial !== 'boolean') throw invalid();
  } else throw invalid();
}
function pendingShape(v) {
  if (v?.kind === 'note') { own(v, ['kind', 'id', 'operation']); if (!text(v.id, 100) || !hash(v.operation)) throw invalid(); }
  else { receiptShape(v); }
}
function validate(s) {
  if (s?.version !== 1 || !natural(s.revision) || !natural(s.epoch) || typeof s.enabled !== 'boolean'
    || !Array.isArray(s.desires) || s.desires.length > DESIRE_LIMITS.desires || !Array.isArray(s.retired) || s.retired.length > DESIRE_LIMITS.retired
    || !Array.isArray(s.seen) || s.seen.length > DESIRE_LIMITS.seen) throw invalid();
  const ids = new Set(); const tokens = new Set();
  for (const row of [...s.desires, ...s.retired]) {
    if (!id(row?.id) || !hash(row.token) || ids.has(row.id) || tokens.has(row.token)) throw invalid();
    ids.add(row.id); tokens.add(row.token);
  }
  for (const row of s.desires) {
    try { row.content = content(row.content); } catch { throw invalid(); }
    if (!natural(row.revision) || !row.revision || !['active', 'paused', 'fulfilled', 'released'].includes(row.status)
      || !unit(row.satisfaction) || !unit(row.progress) || !unit(row.frustration) || !natural(row.setbacks) || !natural(row.cycles)
      || typeof row.humanEdited !== 'boolean' || typeof row.humanStopped !== 'boolean'
      || ![row.createdMs, row.updatedMs, row.satisfactionAt, row.lastAttemptAt, row.cooldownUntil].every(Number.isFinite)
      || !(row.scope?.project === null || text(row.scope?.project, 256)) || !text(row.scope?.relationship, 256)
      || !text(row.origin?.session, 256) || !text(row.origin?.project, 256) || !(row.origin.seq === null || natural(row.origin.seq))
      || !(row.origin.expression === null || hash(row.origin.expression)) || !Array.isArray(row.history) || row.history.length > DESIRE_LIMITS.history
      || row.history.some(h => !text(h?.id, 100) || !Number.isFinite(h.at) || !['feedback', 'activity'].includes(h.kind)
        || typeof h.reviewed !== 'boolean' || !text(h.outcome, 32))
      || !(row.lease === null || text(row.lease?.token, 100) && text(row.lease.wake, 100) && text(row.lease.session, 256)
        && text(row.lease.project, 256) && hash(row.lease.proof) && natural(row.lease.epoch) && natural(row.lease.revision) && Number.isFinite(row.lease.deadline))) throw invalid();
    try {
      if (row.lease?.pending) pendingShape(row.lease.pending);
      for (const h of row.history) {
        if (h.kind === 'feedback') {
          evaluation(h.evaluation);
          if (!['conversation', 'note', 'activity'].includes(h.evidence?.kind)) throw invalid();
          if (h.evidence.kind === 'note') receiptShape(h.evidence);
          if (h.evidence.kind === 'activity' && !text(h.evidence.id, 100)) throw invalid();
          if (h.evidence.kind === 'conversation' && (!text(h.evidence.session, 256) || !(h.evidence.seq === null || natural(h.evidence.seq))
            || !(h.evidence.expression === null || hash(h.evidence.expression)))) throw invalid();
        } else {
          if (!['read', 'write', 'rest'].includes(h.activity) || !['completed', 'rested', 'deferred', 'failed', 'interrupted'].includes(h.outcome)) throw invalid();
          if (h.receipt !== null) receiptShape(h.receipt);
        }
      }
    } catch { throw invalid(); }
  }
  if (s.seen.some(r => !hash(r?.token) || !hash(r.body)) || new Set(s.seen.map(r => r.token)).size !== s.seen.length) throw invalid();
  return s;
}

export function desirePriority(row, now, { enabled = true, canRead = true } = {}) {
  const elapsed = Math.max(0, now - row.satisfactionAt);
  const satisfaction = row.content.kind === 'ongoing' ? row.satisfaction * 2 ** (-elapsed / (row.content.renewalHours * 3600000)) : row.satisfaction;
  const need = 1 - satisfaction;
  const waiting = Math.min(1, Math.max(0, now - Math.max(row.createdMs, row.lastAttemptAt)) / (7 * 86400000));
  const factors = { importance: row.content.importance, commitment: row.content.commitment, need: rounded(need), waiting: rounded(waiting), frustration: row.frustration };
  const score = enabled && row.status === 'active' && !row.humanStopped
    ? row.content.importance * (0.5 + 0.5 * row.content.commitment) * need * (0.8 + 0.2 * waiting) * (1 - 0.5 * row.frustration) : 0;
  const blocked = !enabled ? 'disabled' : row.status !== 'active' ? row.status : row.humanStopped ? 'human-stopped'
    : row.lease && row.lease.deadline > now ? 'in-flight' : row.cooldownUntil > now ? 'cooldown' : need < 0.15 ? 'satisfied'
      : !row.content.activities.some(a => a !== 'read' || canRead) ? 'no-material' : score <= 0 ? 'no-current-interest' : null;
  return { score: rounded(score), satisfaction: rounded(satisfaction), need: rounded(need), factors, eligible: blocked === null, blocked };
}

export class LeadDesireService {
  constructor({ org, clock }) { Object.assign(this, { org, clock }); this.file = join(dirname(org.layout.personaCoreFile()), '情绪与动机', '追求.json'); }
  target(project) { return this.org.leadAffect.target(project); }
  authorize(spec, write = false) { return this.org.leadAffect.authorize(spec, write); }
  validateAspiration(input) {
    own(input, ['key', 'content']); if (!text(input.key, 80)) throw new InvalidBody('新的自身愿望需要稳定key。'); content(input.content);
  }
  visible(row, spec) { return spec.subject.kind === '主权者' || (row.scope.project === null || row.scope.project === spec.project) && row.scope.relationship === spec.relationship; }
  async load() {
    let raw; try { raw = await this.org.leadSpace.readFile(this.file); } catch (e) { if (e.code === 'ENOENT') return blank(); throw e; }
    try { return validate(JSON.parse(stripBom(raw))); } catch { throw invalid(); }
  }
  async locked(spec, fn, check = async () => {}) {
    const proof = await this.authorize(spec);
    assertPersonaCorePath(this.file, { allowMissing: true }); await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    return serializeByKey(this.file, () => withLock(this.file + '.lock', async () => {
      const s = await this.load(); await check(); if (proof !== await this.authorize(spec)) throw conflict();
      const result = await fn(s, proof);
      if (result?.unchanged) return result.value;
      if (s.revision === Number.MAX_SAFE_INTEGER) throw conflict(); s.revision++; validate(s);
      if (Buffer.byteLength(JSON.stringify(s)) > DESIRE_LIMITS.bytes) throw new Fault('LEAD_DESIRE_LIMIT', '追求账本已满，请整理；原件未被覆盖。');
      await check(); if (proof !== await this.authorize(spec, true)) throw conflict();
      assertPersonaCorePath(this.file, { allowMissing: true }); await savePrivateBufferState(this.file, s);
      await this.org.audit.append({ 动作: 'Lead追求更新', 主体: spec.subject, 项目: spec.project,
        对象: { id: result?.id ?? 'Lead追求', kind: '产物' }, 依据: '个人动机与可修正评价；活动回执不认证主观满足或能力', 结果: '已完成' });
      return result?.returnNull ? null : { ...result, stateRevision: s.revision, epoch: s.epoch };
    }, { timeoutMs: 5000, staleMs: 120000 }));
  }
  view(row, s, options = {}) {
    const { token, lease, ...rest } = row;
    return { ...rest, priority: desirePriority(row, this.clock.ms(), { enabled: s.enabled, ...options }), inFlight: !!lease && lease.deadline > this.clock.ms() };
  }
  async query(spec, input = {}) {
    own(input, ['id', 'offset', 'limit', 'includeInactive']); const offset = input.offset ?? 0; const limit = input.limit ?? 20;
    if (!natural(offset) || !Number.isSafeInteger(limit) || limit < 1 || limit > 64 || input.id !== undefined && !id(input.id)
      || input.includeInactive !== undefined && typeof input.includeInactive !== 'boolean') throw new InvalidBody('追求查询需要有效ID、分页及includeInactive布尔值，limit为1至64。');
    const proof = await this.authorize(spec); const s = await this.load();
    let rows = s.desires.filter(row => this.visible(row, spec) && (input.id || input.includeInactive || row.status === 'active')).map(row => this.view(row, s));
    rows.sort((a, b) => b.priority.score - a.priority.score || a.createdMs - b.createdMs || a.id.localeCompare(b.id));
    if (input.id) { rows = rows.filter(row => row.id === input.id); if (!rows.length) throw new Denied('追求范围', '追求不存在或不在当前关系与项目范围。'); }
    if (proof !== await this.authorize(spec)) throw conflict();
    return { version: 1, revision: s.revision, epoch: s.epoch, enabled: s.enabled, entries: rows.slice(offset, offset + limit),
      nextOffset: offset + limit < rows.length ? offset + limit : null,
      claim: '排序由重要性、投入意愿、未满足程度、等待及受挫共同计算。进度与满足度是有出处的可修正评价，不是能力或外部任务完成认证；用户工作优先，个人追求不授予权限。' };
  }
  async evidence(spec, e, context, row) {
    own(e, ['kind', 'id', 'revision', 'hash']);
    if (e.kind === 'conversation') {
      own(e, ['kind']);
      if (!context || context.session !== spec.session || !(context.seq === null || natural(context.seq)) || !(context.expression === null || hash(context.expression))) throw new InvalidBody('会话反馈需要真实宿主上下文。');
      return { kind: 'conversation', session: context.session, seq: context.seq, expression: context.expression, claim: '当前会话自述，不认证用户判断或外部完成' };
    }
    if (e.kind === 'note') {
      const note = await this.org.leadSpace.query(spec, { id: e.id });
      if (note.revision !== e.revision || note.hash !== e.hash) throw conflict();
      return { kind: 'note', id: note.id, revision: note.revision, hash: note.hash };
    }
    if (e.kind === 'activity') {
      own(e, ['kind', 'id']); const h = row.history.find(h => h.kind === 'activity' && h.id === e.id);
      if (!h || h.reviewed || !['completed', 'rested'].includes(h.outcome)) throw new InvalidBody('只能评价尚未评价的真实已完成活动。');
      if (h.receipt) await this.checkReceipt(spec, h.receipt);
      return { kind: 'activity', id: h.id };
    }
    throw new InvalidBody('反馈依据为conversation、当前note或实际activity回执。');
  }
  feedback(row, value, evidence) {
    const now = this.clock.ms();
    row.satisfaction = value.satisfaction; row.satisfactionAt = now; row.progress = value.progress;
    row.content.nextStep = value.nextStep; row.lease = null;
    if (value.outcome === 'setback') { row.setbacks++; row.frustration = Math.min(1, row.frustration + 0.25); row.cooldownUntil = now + Math.min(168, 2 ** Math.min(8, row.setbacks)) * 3600000; }
    else {
      row.setbacks = 0; row.frustration = Math.max(0, row.frustration - 0.2);
      row.cooldownUntil = now + (value.outcome === 'no-change' ? 6 : 1) * 3600000;
      if (value.outcome === 'fulfilled') {
        row.cycles++; if (row.content.kind === 'finite') row.status = 'fulfilled';
        else { row.progress = 0; row.cooldownUntil = now + row.content.renewalHours * 0.25 * 3600000; }
      }
    }
    if (evidence.kind === 'activity') row.history.find(h => h.id === evidence.id).reviewed = true;
    row.history.push({ id: `feedback-${randomUUID()}`, kind: 'feedback', at: now, outcome: value.outcome, reviewed: true, evaluation: value, evidence });
    row.history = row.history.slice(-DESIRE_LIMITS.history);
  }
  async update(spec, input, { context = null, check = async () => {} } = {}) {
    const shapes = { create: ['op', 'epoch', 'key', 'scope', 'content'], revise: ['op', 'epoch', 'id', 'revision', 'reason', 'content'],
      state: ['op', 'epoch', 'id', 'revision', 'reason', 'status'], feedback: ['op', 'epoch', 'id', 'revision', 'evaluation', 'evidence'],
      remove: ['op', 'epoch', 'id', 'revision', 'reason'], clear: ['op', 'expectedRevision'], configure: ['op', 'expectedRevision', 'enabled'] };
    own(input, ['op', ...new Set(Object.values(shapes).flat())]); if (!Object.hasOwn(shapes, input.op)) throw new InvalidBody('未知追求操作。'); own(input, shapes[input.op]);
    const human = spec?.subject?.kind === '主权者';
    if (['clear', 'configure'].includes(input.op) && !human) throw new Denied('追求人侧维护', '整体清空与开关只能由认证人侧操作。');
    const body = ['create', 'revise'].includes(input.op) ? content(input.content) : null;
    const value = input.op === 'feedback' ? evaluation(input.evaluation) : null;
    if (['clear', 'configure'].includes(input.op)) {
      if (!natural(input.expectedRevision) || input.op === 'configure' && typeof input.enabled !== 'boolean') throw new InvalidBody('需要当前expectedRevision，enabled为布尔值。');
    } else {
      if (!natural(input.epoch)) throw new InvalidBody('需要当前清空代次epoch。');
      if (input.op === 'create') {
        if (!text(input.key, 80) || !['project', 'relationship'].includes(input.scope ?? 'project') || !context || context.session !== spec.session
          || !(context.seq === null || natural(context.seq)) || !(context.expression === null || hash(context.expression))) throw new InvalidBody('新追求需要稳定key、project/relationship范围及真实宿主上下文。');
      } else if (!id(input.id) || !natural(input.revision) || input.op !== 'feedback' && !text(input.reason, 300)) throw new InvalidBody('变更需要当前追求ID、revision与原因。');
      if (input.op === 'state' && !['active', 'paused', 'released'].includes(input.status)) throw new InvalidBody('状态为active/paused/released；满足走有依据的feedback。');
    }
    return this.locked(spec, async s => {
      if (['clear', 'configure'].includes(input.op)) {
        if (s.revision !== input.expectedRevision || s.epoch === Number.MAX_SAFE_INTEGER) throw conflict();
        if (input.op === 'clear') { s.desires = []; s.retired = []; s.seen = []; s.epoch++; }
        else { s.enabled = input.enabled; if (!s.enabled) for (const row of s.desires) row.lease = null; }
        return { enabled: s.enabled };
      }
      if (input.epoch !== s.epoch) throw conflict(); if (!s.enabled && !human) throw new Denied('追求已停用', '人侧已停止追求机制。');
      const now = this.clock.ms();
      if (input.op === 'create') {
        const scope = { project: input.scope === 'relationship' ? null : spec.project, relationship: spec.relationship };
        const token = digest(canonical({ scope, key: input.key }));
        if (s.retired.some(r => r.token === token)) throw new Denied('追求已撤回', '这个追求已撤回，不能以重试恢复。');
        const prior = s.desires.find(r => r.token === token);
        if (prior) { if (canonical(prior.content) !== canonical(body)) throw conflict(); return { unchanged: true, value: { id: prior.id, revision: prior.revision, epoch: s.epoch, duplicate: true } }; }
        if (s.desires.length >= DESIRE_LIMITS.desires) throw new Fault('LEAD_DESIRE_LIMIT', '最多64项追求，请整理已放下的追求。');
        const row = { id: `desire-${randomUUID()}`, token, revision: 1, scope, origin: { session: context.session, project: spec.project, seq: context.seq, expression: context.expression },
          content: body, status: 'active', humanEdited: human, humanStopped: false, satisfaction: 0, satisfactionAt: now, progress: 0,
          frustration: 0, setbacks: 0, cycles: 0, createdMs: now, updatedMs: now, lastAttemptAt: now, cooldownUntil: 0, lease: null, history: [] };
        s.desires.push(row); return { id: row.id, revision: row.revision };
      }
      const row = s.desires.find(r => r.id === input.id && this.visible(r, spec)); if (!row) throw new Denied('追求范围', '追求不存在或不在当前范围。');
      if (input.op === 'feedback') {
        const proof = await this.evidence(spec, input.evidence, context, row);
        const token = digest(canonical({ desire: row.id, evidence: proof })); const bodyHash = digest(canonical(value));
        const prior = s.seen.find(r => r.token === token);
        if (prior) { if (prior.body !== bodyHash) throw conflict(); return { unchanged: true, value: { id: row.id, revision: row.revision, epoch: s.epoch, duplicate: true } }; }
        if (s.seen.length >= DESIRE_LIMITS.seen) throw new Fault('LEAD_DESIRE_LIMIT', '反馈屏障已满，请由人侧维护。');
        if (row.revision !== input.revision) throw conflict();
        if (row.humanStopped || row.status !== 'active') throw new Denied('追求已停止', '当前追求不接受活动反馈。');
        this.feedback(row, value, proof); s.seen.push({ token, body: bodyHash });
      } else {
        if (row.revision !== input.revision) throw conflict();
        if (!human && (row.humanStopped || row.humanEdited)) throw new Denied('人侧追求保护', '人侧修正的描述、取舍和停止决定不能由模型覆盖。');
        if (input.op === 'remove') {
          if (s.retired.length >= DESIRE_LIMITS.retired) throw new Fault('LEAD_DESIRE_LIMIT', '撤回屏障已满，请由人侧清空。');
          s.desires = s.desires.filter(r => r !== row); s.retired.push({ id: row.id, token: row.token }); return { id: row.id, removed: true };
        }
        if (input.op === 'revise') row.content = body;
        if (input.op === 'state') {
          if (!human && ['fulfilled', 'released'].includes(row.status)) throw new Denied('追求已结束', '已结束的追求不自动恢复。');
          if (human && input.status === 'active' && ['fulfilled', 'released'].includes(row.status)) {
            row.satisfaction = 0; row.satisfactionAt = now; row.progress = 0; row.cooldownUntil = 0;
          }
          row.status = input.status; if (human) row.humanStopped = input.status !== 'active';
        }
        if (human) row.humanEdited = true; row.lease = null;
      }
      if (row.revision === Number.MAX_SAFE_INTEGER) throw conflict(); row.revision++; row.updatedMs = now;
      return { id: row.id, revision: row.revision, status: row.status };
    }, check);
  }
  async checkReceipt(spec, receipt) {
    if (receipt.kind === 'note') return this.evidence(spec, { kind: 'note', id: receipt.id, revision: receipt.revision, hash: receipt.hash }, null, null);
    if (receipt.kind === 'reading') {
      const data = await this.org.information.readState();
      const material = data.items.find(i => i.id === receipt.material && i.hash === receipt.hash && i.state === 'active');
      const reading = data.jobs.find(r => r.id === receipt.id && r.key === `${receipt.material}:${receipt.hash}` && r.state === 'completed');
      if (!material || !reading || !this.org.information.visible(material.scope, spec)
        || spec.subject.kind !== '主权者' && await this.org.dataOwnership.relationship(reading.session) !== spec.relationship) throw new Denied('追求阅读来源', '阅读来源已变化或撤回，不能用于本次评价。');
      return receipt;
    }
    throw new InvalidBody('活动回执必须指向真实随笔或已完成阅读。');
  }
  async claimActivity(spec, wake, { canRead = false, check = async () => {} } = {}) {
    if (wake.session !== spec.session || wake.project !== spec.project) throw canceled();
    await this.org.leadSpace.check(spec, wake);
    return this.locked(spec, async (s, proof) => {
      if (!s.enabled) return { unchanged: true, value: null };
      let recovered = false;
      for (const row of s.desires.filter(r => this.visible(r, spec) && r.lease && r.lease.deadline <= this.clock.ms())) {
        let receipt = null; const pending = row.lease.pending;
        if (pending) {
          try {
            if (pending.kind === 'note') {
              const note = await this.org.leadSpace.query(spec, { id: pending.id });
              if (!note.humanEdited && note.operation === pending.operation) receipt = { kind: 'note', id: note.id, revision: note.revision, hash: note.hash };
            } else { await this.checkReceipt(spec, pending); receipt = pending; }
          } catch { /* Unknown or withdrawn output is never counted as completed. */ }
        }
        row.history.push({ id: `activity-${randomUUID()}`, kind: 'activity', at: this.clock.ms(), activity: pending?.kind === 'reading' ? 'read' : 'write',
          outcome: receipt ? 'completed' : 'interrupted', receipt, reviewed: false, recovered: true }); row.history = row.history.slice(-DESIRE_LIMITS.history);
        row.lease = null; row.revision++; recovered = true;
      }
      const ranked = s.desires.filter(r => this.visible(r, spec)).map(row => ({ row, p: desirePriority(row, this.clock.ms(), { canRead }) }))
        .filter(x => x.p.eligible).sort((a, b) => b.p.score - a.p.score || a.row.createdMs - b.row.createdMs || a.row.id.localeCompare(b.row.id));
      const row = ranked[0]?.row; if (!row) return recovered ? { returnNull: true } : { unchanged: true, value: null };
      row.revision++; row.lease = { token: randomUUID(), wake: wake.id, deadline: wake.deadline, session: spec.session, project: spec.project, proof, epoch: s.epoch, revision: row.revision };
      return { id: row.id, lease: structuredClone(row.lease), desire: this.view(row, s, { canRead }) };
    }, check);
  }
  async checkActivity(spec, claim) {
    const proof = await this.authorize(spec); const s = await this.load(); const row = s.desires.find(r => r.id === claim.id);
    if (!s.enabled || !row || !this.visible(row, spec) || row.status !== 'active' || row.humanStopped || s.epoch !== claim.lease.epoch
      || row.revision !== claim.lease.revision || row.lease?.token !== claim.lease.token || row.lease.proof !== proof
      || row.lease.session !== spec.session || row.lease.project !== spec.project || this.clock.ms() >= row.lease.deadline) throw canceled();
    return row;
  }
  async stageActivity(spec, claim, pending, { check = async () => {} } = {}) {
    own(pending, ['kind', 'id', 'operation', 'material', 'hash']);
    if (pending.kind === 'note' ? !text(pending.id, 100) || !hash(pending.operation)
      : pending.kind !== 'reading' || !text(pending.id, 100) || !text(pending.material, 100) || !hash(pending.hash)) throw new InvalidBody('活动准备回执无效。');
    return this.locked(spec, async s => {
      await this.checkActivity(spec, claim); const row = s.desires.find(r => r.id === claim.id);
      if (row.lease?.token !== claim.lease.token) throw canceled(); row.lease.pending = { ...pending }; return { id: row.id, revision: row.revision };
    }, check);
  }
  async resumeContext(spec, claim) {
    const row = await this.checkActivity(spec, claim); const latest = [...row.history].reverse().find(h => h.kind === 'activity' && !h.reviewed && ['completed', 'rested'].includes(h.outcome));
    if (!latest) return { desire: claim.desire, lastActivity: null };
    let artifact = null;
    if (latest.receipt) {
      try {
        await this.checkReceipt(spec, latest.receipt);
        if (latest.receipt.kind === 'note') { const n = await this.org.leadSpace.query(spec, { id: latest.receipt.id }); artifact = { title: n.title, text: n.text.slice(0, 800) }; }
        else artifact = { material: latest.receipt.material, readingCompleted: true };
      } catch { return { desire: claim.desire, lastActivity: { id: latest.id, available: false } }; }
    }
    return { desire: claim.desire, lastActivity: { ...latest, available: true, artifact } };
  }
  async checkReview(spec, claim, review) {
    own(review, ['checkpoint', 'evaluation']); evaluation(review.evaluation);
    const row = await this.checkActivity(spec, claim);
    await this.evidence(spec, { kind: 'activity', id: review.checkpoint }, null, row);
  }
  async finishActivity(spec, claim, { outcome, activity, receipt = null, review = null }, { check = async () => {} } = {}) {
    if (!['completed', 'rested', 'deferred', 'failed', 'interrupted'].includes(outcome) || !['read', 'write', 'rest'].includes(activity)) throw new InvalidBody('活动结果无效。');
    return this.locked(spec, async (s, proof) => {
      const row = s.desires.find(r => r.id === claim.id);
      if (!row || row.lease?.token !== claim.lease.token || row.revision !== claim.lease.revision || s.epoch !== claim.lease.epoch || !s.enabled
        || row.lease.proof !== proof || !this.visible(row, spec) || row.status !== 'active' || row.humanStopped) throw canceled();
      if (['completed', 'rested', 'deferred'].includes(outcome)) {
        await this.checkActivity(spec, claim);
        if (outcome === 'completed' && activity !== 'rest' && !receipt) throw new InvalidBody('完成活动必须有真实产物或阅读回执。');
        if (receipt) await this.checkReceipt(spec, receipt);
        if (review) {
          own(review, ['checkpoint', 'evaluation']); const value = evaluation(review.evaluation);
          if (value.outcome === 'fulfilled' && activity !== 'rest') throw new InvalidBody('已满足的追求本次应休息，不追加活动。');
          const evidence = await this.evidence(spec, { kind: 'activity', id: review.checkpoint }, null, row);
          this.feedback(row, value, evidence);
        }
      }
      const now = this.clock.ms();
      row.lease = null; row.lastAttemptAt = now; row.updatedMs = now; row.revision++;
      row.history.push({ id: `activity-${randomUUID()}`, kind: 'activity', at: now, outcome, activity, receipt,
        reviewed: outcome === 'rested' && (!row.content.activities.includes('rest') || review?.evaluation?.outcome === 'fulfilled') }); row.history = row.history.slice(-DESIRE_LIMITS.history);
      if (outcome === 'failed') { row.setbacks++; row.frustration = Math.min(1, row.frustration + 0.25); row.cooldownUntil = now + Math.min(168, 2 ** Math.min(8, row.setbacks)) * 3600000; }
      else row.cooldownUntil = Math.max(row.cooldownUntil, now + (outcome === 'deferred' ? 6 : 1) * 3600000);
      return { id: row.id, revision: row.revision, status: row.status };
    }, check);
  }
}
