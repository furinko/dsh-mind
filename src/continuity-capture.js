/** 从已接纳对话中提炼协作偏好；写入仍由正式记忆服务判定与留痕。 */
import { ProjectBriefService } from './project-brief.js';
import { canonical } from './kernel/text.js';
import { InvalidBody } from './kernel/errors.js';

const text = (value, max) => typeof value === 'string' && value.trim() && value.length <= max;
const categories = ['人格', '用户偏好'];
const refValid = r => r && text(r.session, 256) && text(r.id, 256) && r.role === 'user'
  && Number.isSafeInteger(r.seq) && r.seq >= 0 && /^[a-f0-9]{64}$/.test(r.hash);

export class ContinuityCaptureService extends ProjectBriefService {
  knownFrames = new WeakMap();
  file(project) { return this.layout.continuityCaptureFile(project); }
  async touch(spec) {
    await this.authorize(spec);
    await this.locked(spec.project, async () => {
      const state = await this.load(spec.project);
      if (state.seeded || state.sessions.length || state.revision) return;
      // 升级时补读同项目已登记的来源，不要求用户重复说过的称呼。
      let prior;
      try { prior = await this.org.projectBrief.load(spec.project); }
      catch (error) { if (error.code !== 'PROJECT_BRIEF_INVALID') throw error; }
      const buffers = await this.sources(spec, prior?.sessions.map(s => s.id) ?? []);
      state.sessions = [...buffers].filter(([, b]) => b).map(([id, b]) => ({ id, seen: b.nextSeq,
        processed: b.floor, at: b.rounds.at(-1)?.at ?? this.clock.ms() }));
      state.seeded = true;
      await this.authorize(spec);
      await this.save(spec.project, state);
    });
    return super.touch(spec);
  }
  validateItems(items) {
    const ids = new Set();
    if (items.length > 12) throw new InvalidBody('每份协作提炼最多12项。');
    for (const item of items) {
      if (!text(item?.id, 64) || ids.has(item.id) || !categories.includes(item.kind)
          || !['部署', '项目'].includes(item.scope) || !['有效', '停止'].includes(item.state) || !text(item.text, 320)
          || !Array.isArray(item.sources) || !item.sources.length || item.sources.length > 4 || item.sources.some(r => !refValid(r))
          || !Array.isArray(item.quotes) || item.quotes.length !== item.sources.length || item.quotes.some(q => !text(q, 400))
          || !Array.isArray(item.replaces) || item.replaces.length > 4 || item.replaces.some(id => !text(id, 256))) throw new InvalidBody('协作偏好提炼或用户来源无效。');
      ids.add(item.id);
    }
  }
  inputItems(items, add) {
    return items.map(({ quotes, replaces, ...item }) => ({ ...item, sources: item.sources.map(add) }));
  }
  async supplementInput(spec) {
    const known = [];
    for (const category of categories) {
      const result = await this.org.memory.query({ subject: spec.subject, 读者: spec.subject, 项目: spec.project,
        类: '偏好', 连续性类别: category, limit: 4, 条数上限: 4, 内容预算: 12000 });
      known.push(...result.条目.filter(e => !e.正文截断 && !e.元数据截断));
    }
    const remembered = known.map(e => ({ id: e.id, topic: e.连续性.主题, kind: e.连续性.类别,
      scope: e.连续性.范围, text: e.内容.slice(0, 320) }));
    this.knownFrames.set(remembered, known);
    return { remembered };
  }
  responseItems(response, { items, refs, selected, exposed, buffers, input }) {
    if (!response || Object.keys(response).some(k => k !== 'items') || !Array.isArray(response.items) || response.items.length > 12) throw new InvalidBody('协作提炼只能返回有界items。');
    const next = response.items.map(item => {
      if (!item || Object.keys(item).some(k => !['id', 'kind', 'scope', 'state', 'text', 'sources', 'quotes', 'replaces'].includes(k))
          || !Array.isArray(item.sources) || item.sources.some(key => !exposed.has(key))) throw new InvalidBody('协作提炼引用未提供来源或未知字段。');
      const out = { ...item, sources: item.sources.map(key => refs.get(key)), replaces: item.replaces ?? [] };
      const prior = items.find(old => old.id === out.id);
      const unchanged = prior && canonical(this.inputItems([prior], r => r.hash)[0])
        === canonical({ id: out.id, kind: out.kind, scope: out.scope, state: out.state, text: out.text, sources: out.sources.map(r => r.hash) });
      if (unchanged && !out.quotes) out.quotes = prior.quotes;
      const hasNew = out.sources.some(r => selected.some(p => p.session === r.session && p.message.seq === r.seq));
      if (!hasNew && !unchanged) throw new InvalidBody('偏好更正须引用本批新的用户表达。');
      if (!Array.isArray(out.quotes) || out.quotes.length !== out.sources.length) throw new InvalidBody('偏好必须给出逐来源的原文片段。');
      out.sources.forEach((r, i) => {
        const m = buffers.get(r.session)?.rounds.flatMap(round => round.messages).find(m => m.seq === r.seq && m.id === r.id);
        if (r.role !== 'user' || !m || m.clipped || m.interrupted || !Number.isFinite(m.at)
            || !text(out.quotes[i], 400) || !m.text.includes(out.quotes[i])) throw new InvalidBody('自动偏好只能引用完整已接纳用户文本中的精确原文。');
      });
      const topics = new Set();
      for (const id of out.replaces) {
        const known = input.remembered.find(m => m.id === id);
        if (!known || known.kind !== out.kind || known.scope !== out.scope) throw new InvalidBody('只能更正已提供的同类同范围偏好。');
        const original = this.knownFrames.get(input.remembered)?.find(m => m.id === id);
        if (original?.自动连续性) topics.add(known.topic);
      }
      if (topics.size > 1) throw new InvalidBody('不同偏好主题分别更正，不能合并成一条自动记忆。');
      if (topics.size) out.id = [...topics][0];
      return out;
    });
    this.validateItems(next);
    return next;
  }
  async commitItems(spec, next, { input, selected, buffers, check }) {
    for (const item of [...next]) {
      if (!item.sources.some(r => selected.some(p => p.session === r.session && p.message.seq === r.seq))) continue;
      const proof = item.sources.map((r, i) => ({ ...r, project: spec.project, quote: item.quotes[i],
        at: buffers.get(r.session).rounds.flatMap(round => round.messages).find(m => m.seq === r.seq).at }));
      try {
        await this.org.memory.captureContinuity({ subject: spec.subject, project: spec.project, item, proof,
          known: this.knownFrames.get(input.remembered) ?? [], check });
      } catch (error) {
        if (error.code !== 'CONTINUITY_OLDER_SOURCE') throw error;
        next.splice(next.indexOf(item), 1);
      }
    }
  }
}
