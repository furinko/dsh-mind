/** One persistent Lead, shared affect, and scoped accounts of what moved it.
 * These are revisable model self-reports, never facts about a user or grants.
 */
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { serializeByKey, stripBom, withLock } from './kernel/fsx.js';
import { canonical, digest } from './kernel/text.js';
import { Denied, Fault, InvalidBody } from './kernel/errors.js';
import { assertPersonaCorePath } from './persona-core.js';
import { savePrivateBufferState } from './turn-buffer.js';

export const LEAD_AFFECT_LIMITS = Object.freeze({ events: 128, retired: 1024, days: 14, halfLifeHours: 6, bytes: 256 * 1024 });
const natural = n => Number.isSafeInteger(n) && n >= 0;
const text = (v, max) => typeof v === 'string' && !!v.trim() && v.length <= max
  && Buffer.from(v).toString('utf8') === v && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v);
const own = (v, keys) => {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k))) throw new InvalidBody(`情绪资料只接受字段：${keys.join(', ')}。`);
};
const changed = () => new Fault('LEAD_AFFECT_CONFLICT', '情绪记录、清空代次或设置已变化，请重新读取。');
const invalid = () => new Fault('LEAD_AFFECT_INVALID', '情绪账本不可用，保留原件，本轮不沿用旧心情。');
const blank = () => ({ version: 1, revision: 0, epoch: 0, enabled: true, events: [], retired: [] });
const list = (v, max) => Array.isArray(v) && v.length <= 3 && v.every(s => text(s, max)) && new Set(v).size === v.length;
function account(v) {
  own(v, ['event', 'appraisal', 'feelings', 'desires', 'affect', 'halfLifeHours']);
  own(v.affect, ['valence', 'arousal']);
  const halfLifeHours = v.halfLifeHours ?? LEAD_AFFECT_LIMITS.halfLifeHours;
  if (!text(v.event, 400) || !text(v.appraisal, 500) || !list(v.feelings, 24) || !list(v.desires, 160)
    || !['valence', 'arousal'].every(k => Number.isFinite(v.affect[k]) && Math.abs(v.affect[k]) <= 1)
    || !Number.isFinite(halfLifeHours) || halfLifeHours < 1 || halfLifeHours > 24) throw new InvalidBody('请分别记录事件转述、自身理解、至多3项情绪与动机、-1至1的愉悦/激活变化及1至24小时半衰期。');
  return { event: v.event, appraisal: v.appraisal, feelings: [...v.feelings], desires: [...v.desires], affect: { ...v.affect }, halfLifeHours };
}
function validate(state) {
  if (state?.version !== 1 || !natural(state.revision) || !natural(state.epoch) || typeof state.enabled !== 'boolean'
    || !Array.isArray(state.events) || state.events.length > LEAD_AFFECT_LIMITS.events
    || !Array.isArray(state.retired) || state.retired.length > LEAD_AFFECT_LIMITS.retired) throw invalid();
  const tokens = new Set(); const ids = new Set();
  for (const row of [...state.events, ...state.retired]) {
    if (!/^affect-[a-f0-9-]{36}$/.test(row?.id) || !/^[a-f0-9]{64}$/.test(row?.token)
      || tokens.has(row.token) || ids.has(row.id)) throw invalid();
    tokens.add(row.token); ids.add(row.id);
  }
  for (const row of state.events) {
    try { row.account = account(row.account); } catch { throw invalid(); }
    if (!natural(row.revision) || row.revision < 1 || typeof row.humanEdited !== 'boolean'
      || !Number.isFinite(row.createdMs) || !Number.isFinite(row.updatedMs) || row.updatedMs < row.createdMs
      || !text(row.scope?.project, 256) || !text(row.scope?.relationship, 256) || !text(row.context?.session, 256)
      || row.context.kind !== 'model-self-report' || !(row.context.seq === null || natural(row.context.seq))
      || !(row.context.expression === null || /^[a-f0-9]{64}$/.test(row.context.expression))
      || !text(row.lastChange?.actor, 256) || !['model-self-report', 'human-correction'].includes(row.lastChange.kind)
      || !(row.lastChange.seq === null || natural(row.lastChange.seq))
      || !(row.lastChange.expression === null || /^[a-f0-9]{64}$/.test(row.lastChange.expression))
      || !(row.changeReason === null || text(row.changeReason, 300))) throw invalid();
  }
  return state;
}
const round = v => Math.round(v * 100) / 100 || 0;
export function affectWeight(row, now) {
  const age = Math.max(0, now - row.updatedMs);
  return age >= LEAD_AFFECT_LIMITS.days * 86400000 ? 0 : 2 ** (-age / (row.account.halfLifeHours * 3600000));
}

export class LeadAffectService {
  constructor({ org, clock }) {
    Object.assign(this, { org, clock });
    this.file = join(dirname(org.layout.personaCoreFile()), '情绪与动机', '状态.json');
  }
  target(project) { return { id: 'Lead情绪与动机', kind: '产物', authority: '自治', zone: '私有', domain: '个体', project }; }
  async load() {
    let raw;
    // Reuse the private, no-link, bounded UTF-8 reader, not its workspace ledger.
    try { raw = await this.org.leadSpace.readFile(this.file); }
    catch (error) { if (error.code === 'ENOENT') return blank(); throw error; }
    try { return validate(JSON.parse(stripBom(raw))); } catch { throw invalid(); }
  }
  async authorize(spec, write = false) {
    if (!['Lead', '主权者'].includes(spec?.subject?.kind)
      || spec.subject.kind === 'Lead' && spec.session !== spec.subject.id) throw new Denied('Lead情绪身份', '情绪与动机仅供真实根Lead和已认证人侧，不向专业成员提供。');
    const proof = await this.org.information.authorize(spec);
    // The own-target policy write below checks real execution identity and host
    // generation. Specialty card availability does not authorize self-reports.
    await this.org.policy.check({ subject: spec.subject, action: write ? 'write' : 'read', target: this.target(spec.project) });
    return proof;
  }
  visible(row, spec) { return spec.subject.kind === '主权者' || row.scope.project === spec.project && row.scope.relationship === spec.relationship; }
  async query(spec, input = {}) {
    own(input, ['id', 'offset', 'limit']);
    const offset = input.offset ?? 0; const limit = input.limit ?? 20;
    if (!natural(offset) || !Number.isSafeInteger(limit) || limit < 1 || limit > 50
      || input.id !== undefined && !text(input.id, 80)) throw new InvalidBody('情绪查询需要有效ID或分页，limit为1至50。');
    const proof = await this.authorize(spec);
    const state = await this.load(); const now = this.clock.ms();
    let valence = 0; let arousal = 0;
    // Deliberate shared mood channel: only two bounded numbers cross scopes.
    // Private causes, labels, desires, identities and quotations never do.
    if (state.enabled) for (const row of state.events) {
      const weight = affectWeight(row, now);
      valence += row.account.affect.valence * weight; arousal += row.account.affect.arousal * weight;
    }
    const visible = state.events.filter(row => this.visible(row, spec)).sort((a, b) => b.updatedMs - a.updatedMs || a.id.localeCompare(b.id));
    if (input.id && !visible.some(row => row.id === input.id)) throw new Denied('情绪缘由范围', '记录不存在或不在当前项目和关系范围。');
    const selected = input.id ? visible.filter(row => row.id === input.id) : visible.slice(offset, offset + limit);
    const entries = selected.map(({ token: _token, ...row }) => ({ ...row, weight: state.enabled ? round(affectWeight(row, now)) : 0 }));
    if (proof !== await this.authorize(spec)) throw changed();
    return { version: 1, revision: state.revision, epoch: state.epoch, enabled: state.enabled,
      mood: { valence: round(Math.max(-1, Math.min(1, valence))), arousal: round(Math.max(-1, Math.min(1, arousal))) },
      entries, nextOffset: !input.id && offset + limit < visible.length ? offset + limit : null,
      claim: '同一Lead跨窗口延续整体心情；具体事件是模型转述，理解、情绪和动机是可修正自述。没有可读缘由时不推测原因，不归咎当前发言者；不是事实、用户意图、主观感受或权限认证。' };
  }
  async update(spec, input, { context = null, check = async () => {} } = {}) {
    own(input, ['op', 'epoch', 'key', 'id', 'revision', 'account', 'reason', 'expectedRevision', 'enabled']);
    const shapes = {
      record: ['op', 'epoch', 'key', 'account'], revise: ['op', 'epoch', 'id', 'revision', 'account', 'reason'],
      remove: ['op', 'epoch', 'id', 'revision', 'reason'], clear: ['op', 'expectedRevision'], configure: ['op', 'expectedRevision', 'enabled'],
    };
    if (!Object.hasOwn(shapes, input.op)) throw new InvalidBody('情绪操作为record/revise/remove，清空与开关由认证人侧处理。');
    own(input, shapes[input.op]);
    const human = spec?.subject?.kind === '主权者';
    if (['clear', 'configure'].includes(input.op) && !human) throw new Denied('情绪人侧维护', '只有已认证人侧可以清空全部或改变开关。');
    const body = ['record', 'revise'].includes(input.op) ? account(input.account) : null;
    if (['clear', 'configure'].includes(input.op)) {
      if (!natural(input.expectedRevision) || input.op === 'configure' && typeof input.enabled !== 'boolean') throw new InvalidBody('人侧维护需要当前expectedRevision，开关为boolean。');
    } else if (!natural(input.epoch) || input.op === 'record' && (!text(input.key, 80) || !context || context.kind !== 'model-self-report'
      || context.session !== spec.session || !(context.seq === null || natural(context.seq)) || !(context.expression === null || /^[a-f0-9]{64}$/.test(context.expression)))
      || input.op !== 'record' && (!text(input.id, 80) || !natural(input.revision) || !text(input.reason, 300))) throw new InvalidBody('情绪写入需要当前清空代次、真实会话上下文；修正/删除还需记录版本和原因。');
    const proof = await this.authorize(spec);
    assertPersonaCorePath(this.file, { allowMissing: true });
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    return serializeByKey(this.file, () => withLock(this.file + '.lock', async () => {
      const state = await this.load(); await check();
      if (proof !== await this.authorize(spec)) throw changed();
      if (!['clear', 'configure'].includes(input.op) && input.epoch !== state.epoch) throw changed();
      let result; const now = this.clock.ms();
      if (['clear', 'configure'].includes(input.op)) {
        if (input.expectedRevision !== state.revision || state.epoch === Number.MAX_SAFE_INTEGER) throw changed();
        if (input.op === 'clear') { state.events = []; state.retired = []; state.epoch++; }
        else state.enabled = input.enabled;
        result = { epoch: state.epoch, enabled: state.enabled };
      } else {
        if (!state.enabled && !human) throw new Denied('情绪已停用', '情绪记录已由人侧停用。');
        const token = input.op === 'record' ? digest(canonical({ project: spec.project, relationship: spec.relationship, key: input.key })) : null;
        if (input.op === 'record') {
          if (state.retired.some(row => row.token === token)) throw new Denied('情绪已撤回', '这个事件已撤回，不以重试恢复；新的真实事件使用新的key。');
          const prior = state.events.find(row => row.token === token);
          if (prior) {
            if (canonical(prior.account) !== canonical(body)) throw changed();
            return { id: prior.id, revision: prior.revision, epoch: state.epoch, duplicate: true };
          }
          if (state.events.length >= LEAD_AFFECT_LIMITS.events) throw new Fault('LEAD_AFFECT_LIMIT', '情绪记录已满，请整理已平复的事件。');
          const row = { id: `affect-${randomUUID()}`, token, revision: 1, humanEdited: human,
            scope: { project: spec.project, relationship: spec.relationship },
            context: { kind: context.kind, session: context.session, seq: context.seq, expression: context.expression },
            lastChange: { actor: spec.subject.id, kind: 'model-self-report', seq: context.seq, expression: context.expression }, changeReason: null,
            createdMs: now, updatedMs: now, account: body };
          state.events.push(row); result = { id: row.id, revision: row.revision, epoch: state.epoch };
        } else {
          const row = state.events.find(row => row.id === input.id && this.visible(row, spec));
          if (!row) throw new Denied('情绪缘由范围', '记录不存在或不在当前范围。');
          if (row.revision !== input.revision || row.revision === Number.MAX_SAFE_INTEGER) throw changed();
          if (row.humanEdited && !human) throw new Denied('情绪人侧修订', '人侧修正的情绪记录不由模型覆盖或恢复。');
          if (input.op === 'remove') {
            if (state.retired.length >= LEAD_AFFECT_LIMITS.retired) throw new Fault('LEAD_AFFECT_LIMIT', '撤回屏障已满，请由人侧清空。');
            state.events = state.events.filter(e => e !== row); state.retired.push({ id: row.id, token: row.token });
          } else {
            row.account = body; row.revision++; row.updatedMs = Math.max(now, row.updatedMs); row.humanEdited = human;
            row.changeReason = input.reason;
            row.lastChange = { actor: spec.subject.id, kind: human ? 'human-correction' : 'model-self-report', seq: context?.seq ?? null, expression: context?.expression ?? null };
          }
          result = { id: row.id, revision: row.revision, removed: input.op === 'remove', epoch: state.epoch };
        }
      }
      if (state.revision === Number.MAX_SAFE_INTEGER) throw changed();
      state.revision++; validate(state);
      if (Buffer.byteLength(JSON.stringify(state)) > LEAD_AFFECT_LIMITS.bytes) throw new Fault('LEAD_AFFECT_LIMIT', '情绪资料超过容量，保留原账本。');
      await check(); if (proof !== await this.authorize(spec, true)) throw changed();
      assertPersonaCorePath(this.file, { allowMissing: true });
      await savePrivateBufferState(this.file, state);
      await this.org.audit.append({ 动作: `Lead情绪${input.op}`, 主体: spec.subject, 项目: spec.project,
        对象: { id: result.id ?? 'Lead情绪与动机', kind: '产物' }, 依据: '可修正的模型自述；不改人设、事实或权限', 结果: '已完成' });
      return { ...result, stateRevision: state.revision };
    }, { timeoutMs: 5000, staleMs: 120000 }));
  }
}
