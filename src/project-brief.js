/** 项目接续资料：模型解释与可信来源引用分开，绝不改写正式目标或长期记忆。 */
import { chmod, copyFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { readJsonOrNull, serializeByKey, withLock } from './kernel/fsx.js';
import { canonical, digest } from './kernel/text.js';
import { Denied, Fault, InvalidBody } from './kernel/errors.js';
import { savePrivateBufferState } from './turn-buffer.js';
import { currentProfessionalScope } from './professional-context.js';

export const PROJECT_BRIEF_LIMITS = Object.freeze({ sessions: 16, items: 20, text: 320, sources: 4,
  messages: 24, input: 36000, context: 9000, bytes: 128 * 1024 });
const KINDS = ['需求', '约束', '决定', '待办', '进展', '待验证'];
const CLAIMS = ['用户表达', '助手记录', '助手推断'];
const STATES = ['进行中', '等待', '暂停', '已完成', '取消', '未知'];
const inactive = state => ['暂停', '已完成', '取消'].includes(state);
const natural = n => Number.isSafeInteger(n) && n >= 0;
const string = (s, n = 256) => typeof s === 'string' && s.trim().length > 0 && s.length <= n;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const bad = () => new Fault('PROJECT_BRIEF_INVALID', '项目接续资料损坏；保留文件，停止使用旧摘要。');
const signature = (session, m) => digest(canonical({ session, seq: m.seq, id: m.id, role: m.role,
  text: m.text, clipped: m.clipped, interrupted: m.interrupted }));
const refOf = (session, m) => ({ session, seq: m.seq, id: m.id, role: m.role, hash: signature(session, m) });
const validRef = ref => ref && string(ref.session) && natural(ref.seq) && string(ref.id)
  && ['user', 'assistant'].includes(ref.role) && hash(ref.hash);
const sourceVersion = buffer => digest(canonical(buffer ? { floor: buffer.floor,
  rounds: buffer.rounds.map(r => ({ turn: r.turn, status: r.status, reason: r.reason ?? null,
    messages: r.messages.map(m => ({ hash: signature(buffer.session, m), at: m.at ?? null })) })) } : null));
const sourceCut = buffers => digest(canonical([...buffers].sort(([a], [b]) => a.localeCompare(b))
  .map(([id, buffer]) => [id, sourceVersion(buffer)])));
const sessionCut = sessions => sessions.map(s => ({ id: s.id, processed: s.processed, version: s.version }))
  .sort((a, b) => a.id.localeCompare(b.id));
const messageOf = (buffers, ref) => buffers.get(ref.session)?.rounds.flatMap(r => r.messages)
  .find(m => m.seq === ref.seq && m.id === ref.id);
const sourceTime = (buffers, ref) => messageOf(buffers, ref)?.at ?? null;
const laterThan = (candidate, previous, buffers) => candidate.session === previous.session
  ? candidate.seq > previous.seq
  : Number.isFinite(sourceTime(buffers, candidate)) && Number.isFinite(sourceTime(buffers, previous))
    && sourceTime(buffers, candidate) > sourceTime(buffers, previous);

/** 保留各会话事件顺序，再按各队列头的事件时间合并；未知时间不冒充新更正。 */
function pendingMessages(state, buffers, currentSession, closedOnly = false, relationForgetAt = 0) {
  const queues = state.sessions.map(s => (buffers.get(s.id)?.rounds ?? [])
    .filter(r => !closedOnly || s.id !== currentSession || r.status !== 'open')
     .flatMap(round => round.messages.filter(m => ['user', 'assistant'].includes(m.role) && m.seq >= s.processed && (!Math.max(s.forgetAt ?? 0, state.forgetAt ?? 0, relationForgetAt)
       || (m.at ?? 0) > Math.max(s.forgetAt ?? 0, state.forgetAt ?? 0, relationForgetAt)))
      .map(message => ({ session: s.id, message, at: message.at ?? null }))));
  const result = [];
  while (queues.some(q => q.length)) {
    const next = queues.filter(q => q.length).sort((a, b) => (a[0].at ?? -Infinity) - (b[0].at ?? -Infinity)
      || a[0].session.localeCompare(b[0].session))[0];
    result.push(next.shift());
  }
  return result;
}

export class ProjectBriefService {
  constructor({ layout, org, clock }) { Object.assign(this, { layout, org, clock }); }
  file(project) { return this.layout.projectBriefFile(project); }
  async relationKey(session) { return digest(await this.org.dataOwnership?.relationship(session) ?? session); }
  async relationCutoff(state, session) {
    let at = 0;
    for (const entry of Object.values(state.relationForget ?? {})) {
      if (entry.session === session || await this.org.dataOwnership?.related(session, entry.session)) at = Math.max(at, entry.at);
    }
    return at;
  }
  async authorize(spec) {
    const stamp = await this.org.turnBuffer.authorize(spec.subject, spec.project, spec.session);
    return this.org.dataOwnership ? digest(canonical([stamp, await this.org.dataOwnership.stamp(spec.session)])) : stamp;
  }
  async load(project) {
    try {
      const file = this.file(project);
      const info = await stat(file).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      if (info?.size > PROJECT_BRIEF_LIMITS.bytes) throw bad();
      const state = await readJsonOrNull(file);
      if (!state) return { version: 1, project, epoch: 'legacy', revision: 0, sourceRevision: 0, at: null, forgetAt: 0, sessions: [], items: [] };
      state.epoch ??= 'legacy'; state.sourceRevision ??= 0;
      if (state.version !== 1 || state.project !== project || !natural(state.revision)
          || !string(state.epoch, 64) || !natural(state.sourceRevision)
          || !(state.at === null || Number.isFinite(state.at)) || !Number.isFinite(state.forgetAt) || !Array.isArray(state.sessions)
          || state.sessions.length > PROJECT_BRIEF_LIMITS.sessions || !Array.isArray(state.items)
           || state.items.length > PROJECT_BRIEF_LIMITS.items * PROJECT_BRIEF_LIMITS.sessions) throw bad();
      const ids = new Set();
      for (const s of state.sessions) {
        if (!string(s.id) || ids.has(s.id) || !natural(s.seen) || !natural(s.processed) || s.processed > s.seen || !Number.isFinite(s.at)
            || (s.version !== undefined && !hash(s.version))) throw bad();
        ids.add(s.id);
      }
       if (state.relationForget && (typeof state.relationForget !== 'object' || Array.isArray(state.relationForget)
           || Object.entries(state.relationForget).some(([k, v]) => !hash(k) || !string(v?.session) || digest(v.session) !== k || !Number.isFinite(v.at)))) throw bad();
       this.validateItems(state.items, { stored: true });
      return state;
    } catch (error) { if (error.code === 'ENOENT') return null; throw bad(); }
  }
  validateItems(items, { stored = false } = {}) {
    const ids = new Set();
    for (const item of items) {
      const key = stored ? `${item.ownerKey ?? 'legacy'}/${item.id}` : item.id;
      if (!string(item.id, 64) || ids.has(key) || (item.ownerKey !== undefined && !hash(item.ownerKey)) || !KINDS.includes(item.kind) || !CLAIMS.includes(item.claim)
          || !STATES.includes(item.state) || !string(item.text, PROJECT_BRIEF_LIMITS.text)
          || !Array.isArray(item.sources) || !item.sources.length || item.sources.length > PROJECT_BRIEF_LIMITS.sources
          || item.sources.some(ref => !validRef(ref)) || (item.goal !== undefined && !string(item.goal))) throw new InvalidBody('项目接续条目或来源无效。');
      if (item.claim === '用户表达' && item.sources.some(ref => ref.role !== 'user')) throw new InvalidBody('用户表达必须只引用已接纳用户来源。');
      if (['需求', '约束', '决定'].includes(item.kind) && item.claim !== '用户表达') throw new InvalidBody('助手解释不能登记成用户需求、约束或决定。');
      ids.add(key);
    }
  }
  async sources(spec, sessions) {
    const all = new Map();
    const actor = (await currentProfessionalScope(this.org, spec.subject, spec.project)).actor;
    for (const id of [...new Set(sessions)].slice(0, PROJECT_BRIEF_LIMITS.sessions)) {
      if (this.org.dataOwnership && !await this.org.dataOwnership.related(spec.session, id)) { all.set(id, null); continue; }
      await this.org.policy.check({ subject: actor, action: 'read', target: {
        id: `轮级缓冲/${digest(id)}`, kind: '记忆', authority: '自治', zone: '私有', domain: '个体', project: spec.project } });
      const stored = await this.org.turnBuffer.load(spec.project, id);
      const state = stored ? this.org.turnBuffer.prune(structuredClone(stored)) : null;
      all.set(id, state);
    }
    return all;
  }
  validItems(items, buffers) {
    const visible = items.filter(item => item.sources.every(ref => buffers.get(ref.session)?.rounds.some(round =>
      round.messages.some(m => m.seq === ref.seq && m.id === ref.id && signature(ref.session, m) === ref.hash))));
    return [...new Map(visible.map(item => [item.id, item])).values()];
  }
  async supplementInput() { return {}; }
  inputItems(items, add) { return items.map(({ ownerKey, ...item }) => ({ ...item, sources: item.sources.map(add) })); }
  async commitItems() {}
  responseItems(response, { items, refs, selected, exposed, goalMap, buffers }) {
    if (!response || Object.keys(response).some(k => k !== 'items') || !Array.isArray(response.items)
        || response.items.length > PROJECT_BRIEF_LIMITS.items) throw new InvalidBody('项目提炼只能返回有界items数组。');
    const next = response.items.map(item => {
      if (!item || Object.keys(item).some(k => !['id', 'kind', 'claim', 'state', 'text', 'sources', 'goal'].includes(k))
          || !Array.isArray(item.sources) || item.sources.some(key => !exposed.has(key))) throw new InvalidBody('项目提炼引用了未提供来源或未知字段。');
      const out = { ...item, sources: item.sources.map(key => refs.get(key)) };
      const oldItem = items.find(old => old.id === item.id);
      if (oldItem && inactive(oldItem.state) && !inactive(item.state)
          && !out.sources.some(ref => ref.role === 'user' && selected.some(m => m.session === ref.session && m.message.seq === ref.seq)
            && oldItem.sources.every(old => laterThan(ref, old, buffers)))) {
        throw new InvalidBody('暂停或终态事项重新推进必须有晚于原状态的本批新的用户来源；补读旧历史或时间未知不能恢复。');
      }
      if (item.goal !== undefined) {
        const goal = goalMap.get(item.goal);
        if (!goal) throw new InvalidBody('项目提炼引用未知目标。');
        out.state = goal.状态;
      }
      return out;
    });
    this.validateItems(next);
    return next;
  }
  async locked(project, work) {
    const file = this.file(project);
    return serializeByKey(file, () => withLock(`${file}.lock`, work, { timeoutMs: 3000 }));
  }
  async save(project, state) {
    if (Buffer.byteLength(JSON.stringify(state)) + 1 > PROJECT_BRIEF_LIMITS.bytes) throw new Fault('PROJECT_BRIEF_SIZE_LIMIT', '项目摘要实际文件超预算，保留原文件与处理位置。');
    await savePrivateBufferState(this.file(project), state);
  }
  async touch(spec) {
    const before = await this.authorize(spec);
    const stored = await this.org.turnBuffer.load(spec.project, spec.session);
    if (!stored) return;
    const buffer = this.org.turnBuffer.prune(structuredClone(stored));
    return this.locked(spec.project, async () => {
      const state = await this.load(spec.project);
      const previousItems = digest(canonical(state.items));
      const previousSessions = state.sessions.map(s => s.id).sort().join('\n');
      const previous = state.sessions.find(s => s.id === spec.session);
      if (previous && previous.seen > buffer.nextSeq) throw new Fault('PROJECT_BRIEF_HISTORY_REWOUND', '宿主历史回退，不能接续未来摘要。');
      state.sessions = state.sessions.filter(s => s.id !== spec.session);
      const version = sourceVersion(buffer);
      state.sessions.push({ id: spec.session, seen: buffer.nextSeq, processed: previous?.processed ?? buffer.floor, ...(previous?.forgetAt ? { forgetAt: previous.forgetAt } : {}), version,
        at: buffer.rounds.at(-1)?.at ?? this.clock.ms() });
      state.sessions = state.sessions.slice(-PROJECT_BRIEF_LIMITS.sessions);
      const retained = new Set(state.sessions.map(s => s.id));
      // 当前来源已被清空或替换时，连同派生文本一起物理移除；旧模型调用另有revision及来源复核。
      // 混合会话条目逐个核对本次会话的引用，其他会话在读取时独立复核。
      state.items = state.items.filter(item => item.sources.every(ref => retained.has(ref.session))
        && item.sources.filter(ref => ref.session === spec.session).every(ref => buffer.rounds.some(round =>
          round.messages.some(m => m.seq === ref.seq && signature(spec.session, m) === ref.hash))));
      if (previous?.version !== version || previousItems !== digest(canonical(state.items))
          || previousSessions !== state.sessions.map(s => s.id).sort().join('\n')) state.sourceRevision++;
      if (before !== await this.authorize(spec)) throw new Denied('项目接续 · 身份变化', '当前Lead变化，丢弃旧登记。');
      await this.save(spec.project, state);
    });
  }
  async update(spec, { extract, active = () => true }) {
    const before = await this.authorize(spec);
    const relationKey = await this.relationKey(spec.session);
    const previous = await this.load(spec.project);
    const buffers = await this.sources(spec, previous.sessions.map(s => s.id));
    const items = this.validItems(previous.items, buffers).slice(-PROJECT_BRIEF_LIMITS.items);
    const pending = pendingMessages(previous, buffers, spec.session, true, await this.relationCutoff(previous, spec.session));
    const selected = pending.slice(0, PROJECT_BRIEF_LIMITS.messages);
    if (!selected.length || !active()) return { updated: false, pending: pending.length };
    const refs = new Map();
    const add = ref => { let key = [...refs].find(([, r]) => r.hash === ref.hash)?.[0]; if (!key) { key = `s${refs.size}`; refs.set(key, ref); } return key; };
    const old = this.inputItems(items, add);
    const messages = selected.map(({ session, message: m }) => ({ source: add(refOf(session, m)), session, seq: m.seq,
      at: m.at ?? null, role: m.role,
      text: m.text.slice(0, 1000), clipped: m.clipped || m.text.length > 1000, interrupted: m.interrupted }));
    const goals = await this.org.goals.contextSnapshot({ subject: spec.subject, 项目: spec.project });
    const goalMap = new Map(goals.目标.map(g => [g.id, g]));
    const input = { previous: old, messages, goals: goals.目标.slice(-8).map(g => ({ id: g.id, state: g.状态,
      expected: g.期望结果.slice(0, 160), next: g.下一步.slice(0, 120) })), omitted: pending.length > selected.length };
    Object.assign(input, await this.supplementInput(spec));
    if (goals.目标.length > 8 || goals.目标.slice(-8).some(g => g.期望结果.length > 160 || g.下一步.length > 120)) {
      input.goalsOmitted = true; input.omitted = true;
    }
    // 模型只需区分来源会话、判断时间；不要为每条引用重复发送原始长会话ID。
    const sessionAliases = new Map([...buffers.keys()].sort().map((id, index) => [id, `c${index}`]));
    const exposeSources = () => Object.fromEntries([...new Set([...old.flatMap(item => item.sources), ...messages.map(m => m.source)])]
      .map(key => { const ref = refs.get(key); return [key, { session: sessionAliases.get(ref.session), seq: ref.seq, role: ref.role, at: sourceTime(buffers, ref) }]; }));
    input.sourceInfo = exposeSources();
    if (Buffer.byteLength(JSON.stringify(input)) > PROJECT_BRIEF_LIMITS.input) {
      // 正式目标可独立查询；先省略说明文本，保留id和权威状态，给本批新材料留空间。
      input.goals = input.goals.map(({ id, state }) => ({ id, state }));
      input.goalsOmitted = true; input.omitted = true;
    }
    while (Buffer.byteLength(JSON.stringify(input)) > PROJECT_BRIEF_LIMITS.input && messages.length > 1) {
      messages.pop(); selected.pop(); input.omitted = true;
      input.sourceInfo = exposeSources();
    }
    if (Buffer.byteLength(JSON.stringify(input)) > PROJECT_BRIEF_LIMITS.input) throw new Fault('PROJECT_BRIEF_INPUT_LIMIT', '项目提炼输入超预算；处理水位未前进。');
    const exposed = new Set([...old.flatMap(item => item.sources), ...messages.map(m => m.source)]);
    const response = await extract(input);
    const next = this.responseItems(response, { spec, items, refs, selected, exposed, goalMap, buffers, input });
    if (!active()) return { updated: false };
    return this.locked(spec.project, async () => {
      const state = await this.load(spec.project);
      if (state.epoch !== previous.epoch || state.revision !== previous.revision || state.sourceRevision !== previous.sourceRevision) throw new Fault('PROJECT_BRIEF_CHANGED', '项目摘要或来源已更新；处理水位未前进，下次重试。');
      const live = await this.sources(spec, state.sessions.map(s => s.id));
      if (sourceCut(live) !== sourceCut(buffers) || this.validItems(next, live).length !== next.length || selected.some(({ session, message }) =>
        !live.get(session)?.rounds.some(r => r.messages.some(m => signature(session, m) === signature(session, message))))) {
        throw new Fault('PROJECT_BRIEF_SOURCE_CHANGED', '提炼来源已撤回或过期；处理水位未前进。');
      }
      const afterGoals = await this.org.goals.contextSnapshot({ subject: spec.subject, 项目: spec.project });
      if (digest(canonical(goals.目标)) !== digest(canonical(afterGoals.目标))) throw new Fault('PROJECT_BRIEF_GOALS_CHANGED', '目标状态已变，丢弃旧提炼。');
      if (!active() || before !== await this.authorize(spec)) throw new Denied('项目接续 · 身份变化', '身份或项目变化，丢弃旧提炼。');
      await this.commitItems(spec, next, { input, selected, buffers: live, check: async () => {
        const current = await this.load(spec.project);
        const sources = await this.sources(spec, current.sessions.map(s => s.id));
        if (!active() || before !== await this.authorize(spec) || current.epoch !== previous.epoch
            || current.revision !== previous.revision || current.sourceRevision !== previous.sourceRevision
            || sourceCut(sources) !== sourceCut(buffers)) throw new Fault('PROJECT_BRIEF_CHANGED', '接续来源或身份变化，拒绝在途记忆写入。');
      } });
      const unrelated = state.items.filter(item => item.sources.some(ref => !live.get(ref.session)));
      state.items = [...unrelated, ...next.map(item => ({ ...item, ownerKey: relationKey }))]; state.revision++; state.at = this.clock.ms();
      for (const entry of state.sessions) {
        const buffer = live.get(entry.id);
        if (!buffer) continue;
        // capture已提交而touch尚未登记的窗口，也须在同一原子提交里同步来源水位。
        const version = sourceVersion(buffer);
        if (entry.version !== version) state.sourceRevision++;
        entry.version = version; entry.seen = Math.max(entry.seen, buffer.nextSeq);
      }
      for (const { session, message } of selected) {
        const entry = state.sessions.find(s => s.id === session);
        if (!entry) throw new Fault('PROJECT_BRIEF_SOURCE_CHANGED', '来源会话已移出保留范围。');
        entry.processed = Math.max(entry.processed, message.seq + 1);
      }
      await this.save(spec.project, state);
      return { updated: true, revision: state.revision, pending: pending.length - selected.length };
    });
  }
  async read(spec, { id, visible = [] } = {}) {
    if (id !== undefined && !string(id, 64)) throw new InvalidBody('项目接续id无效。');
    const before = await this.authorize(spec);
    const state = await this.load(spec.project);
    const buffers = await this.sources(spec, state.sessions.map(s => s.id));
    const items = this.validItems(state.items, buffers).filter(item => id === undefined || item.id === id);
    const goals = await this.org.goals.contextSnapshot({ subject: spec.subject, 项目: spec.project });
    const goalMap = new Map(goals.目标.map(goal => [goal.id, goal]));
    const pending = pendingMessages(state, buffers, spec.session, false, await this.relationCutoff(state, spec.session));
    const pendingUsers = pending.filter(p => p.message.role === 'user');
    const frame = { 版本: 1, 项目: spec.project, 修订: state.revision, 来源修订: state.sourceRevision, 更新于: state.at,
      依据: '模型从已接纳用户文本及助手已提交文本提炼；引用可核对，语义与完成声明未经程序认证',
      待整理消息数: pending.length, 摘要待更新: pendingUsers.length > 0, 待整理用户表达: [],
      数据版本: digest(canonical({ epoch: state.epoch, revision: state.revision, sourceRevision: state.sourceRevision, items,
        pending: pending.map(p => [p.session, signature(p.session, p.message)]), goals: goals.目标 })), 条目: [], 截断: false };
    // 新会话首步不等待辅助模型，但必须能核对最新已接纳更正，避免只看到旧摘要。
    // Only automatic assembly supplies its current session surface. Filter before
    // budgeting so newer visible chatter cannot evict a missing correction.
    // Default queries retain the original full pending index and provenance.
    const visibleSet = new Set(visible);
    const missingUsers = pendingUsers.filter(p => p.session !== spec.session || !visibleSet.has(p.message.seq));
    const recent = [...missingUsers].reverse().slice(0, 4);
    frame.截断 = missingUsers.length > recent.length;
    for (const { session, message: m } of recent) {
      const entry = { 会话: session, 事件序号: m.seq, 消息: m.id, 文本: m.text.slice(0, 800),
        时间: m.at ?? null, 截断: m.clipped || m.text.length > 800 };
      frame.待整理用户表达.unshift(entry);
      if (JSON.stringify(frame).length > PROJECT_BRIEF_LIMITS.context) { frame.待整理用户表达.shift(); frame.截断 = true; }
    }
    for (const item of items) {
      const goal = item.goal ? goalMap.get(item.goal) : null;
      if (item.goal && !goal) continue;
      const entry = { id: item.id, 类别: item.kind, 性质: item.claim,
        状态: goal ? goal.状态 : item.state, 内容: item.text,
        ...(item.goal ? { 目标: item.goal } : {}), 来源: item.sources.map(ref => ({ 会话: ref.session, 事件序号: ref.seq,
          消息: ref.id, 角色: ref.role, 内容摘要: ref.hash, ...(id === undefined ? {} : { 原文: buffers.get(ref.session).rounds
            .flatMap(r => r.messages).find(m => m.seq === ref.seq).text.slice(0, 1200) }) })) };
      frame.条目.push(entry);
      if (JSON.stringify(frame).length > PROJECT_BRIEF_LIMITS.context) { frame.条目.pop(); frame.截断 = true; break; }
    }
    const verify = await this.sources(spec, state.sessions.map(s => s.id));
    const latest = await this.load(spec.project);
    const afterGoals = await this.org.goals.contextSnapshot({ subject: spec.subject, 项目: spec.project });
    if (sourceCut(buffers) !== sourceCut(verify) || this.validItems(items, verify).length !== items.length || before !== await this.authorize(spec)
        || digest(canonical({ epoch: latest.epoch, items: latest.items, revision: latest.revision, sourceRevision: latest.sourceRevision, sessions: sessionCut(latest.sessions) }))
          !== digest(canonical({ epoch: state.epoch, items: state.items, revision: state.revision, sourceRevision: state.sourceRevision, sessions: sessionCut(state.sessions) }))
        || digest(canonical(goals.目标)) !== digest(canonical(afterGoals.目标))) throw new Fault('PROJECT_BRIEF_CHANGED', '来源或摘要变化，丢弃旧接续帧。');
    return frame;
  }
  async forget(spec) {
    await this.authorize(spec);
    return this.locked(spec.project, async () => {
      let state; let isolated = false;
      try { state = await this.load(spec.project); }
      catch (error) {
        if (error.code !== 'PROJECT_BRIEF_INVALID') throw error;
        const backup = `${this.file(spec.project)}.invalid-${randomUUID()}`;
        await copyFile(this.file(spec.project), backup, constants.COPYFILE_EXCL);
        await chmod(backup, 0o600); isolated = true;
        state = { version: 1, project: spec.project, forgetAt: 0, revision: 0, sourceRevision: 0, sessions: [], items: [] };
      }
      state.epoch = randomUUID();
      const buffers = await this.sources(spec, state.sessions.map(s => s.id));
      state.items = state.items.filter(item => item.sources.some(ref => !buffers.get(ref.session)));
      state.revision++; state.at = this.clock.ms();
      state.relationForget ??= {};
      state.relationForget[digest(spec.session)] = { session: spec.session, at: state.at };
      for (const entry of state.sessions) {
        if (!buffers.get(entry.id)) continue;
        entry.forgetAt = state.at;
        entry.seen = Math.max(entry.seen, buffers.get(entry.id)?.nextSeq ?? 0);
        entry.processed = entry.seen;
      }
      await this.authorize(spec);
      await this.save(spec.project, state);
      return { 已清空: true, 修订: state.revision, ...(isolated ? { 已隔离损坏数据: true } : {}) };
    });
  }
}
