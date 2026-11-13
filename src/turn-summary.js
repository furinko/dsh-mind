/** Incremental, source-bound experience recaps. Semantic understanding is revisable. */
import { canonical, digest } from './kernel/text.js';
import { InvalidBody } from './kernel/errors.js';
import { serializeByKey, withLock } from './kernel/fsx.js';
export const SUMMARY_DEFAULTS = Object.freeze({ rounds: 20, hours: 24, minimumChars: 4096 });
const CATEGORIES = ['用户决定', '助手建议', '认识'];
const FORMS = { extract: '自动经历摘录，非语义知识结论', semantic: 'Lead有来源的理解，可随新经历修正；不认证语义正确' };
const sourceOf = m => ({ seq: m.seq, id: m.id, hash: digest(m.text), role: m.role, ...(m.origin ? { origin: m.origin } : {}) });
const sourceKey = source => canonical([source.seq, source.id, source.hash, source.role, source.origin ?? null]);

function previousSources(entry, kind) {
  const metadata = entry.轮级总结;
  if (metadata.kind !== undefined) return metadata.kind === kind ? metadata.sources : [];
  // Legacy records have no kind. Recognize the actual body, never assume that a
  // shared numeric watermark proves understanding. Old semantic metadata also
  // included uncited messages, so only its real citations count as understood.
  let body;
  try { body = JSON.parse(entry.内容); } catch { return []; }
  if (!body || body.形式 !== FORMS[kind]) return [];
  if (kind === 'extract') return metadata.sources;
  const cited = new Set(CATEGORIES.flatMap(category => Array.isArray(body[category]) ? body[category].map(item => item?.source) : []));
  return metadata.sources.filter(source => cited.has(source.id));
}
function validateSummary(summary) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)
      || CATEGORIES.some(category => !Array.isArray(summary[category])) || Object.keys(summary).some(key => !CATEGORIES.includes(key))) {
    throw new InvalidBody('总结分别提供 用户决定、助手建议、认识 数组；每项需text和真实source消息id。');
  }
}
export class TurnSummaryService {
  constructor({ turns, memory, clock }) { this.turns = turns; this.memory = memory; this.clock = clock; }
  async summarize({ subject, project, session, summary }) {
    const file = this.turns.file(project, session);
    return serializeByKey(file, () => withLock(file + '.lock', () => this.#summarize({ subject, project, session, summary })));
  }
  async #summarize({ subject, project, session, summary }) {
    await this.turns.authorize(subject, project, session);
    const kind = summary === undefined ? 'extract' : 'semantic';
    if (kind === 'semantic') validateSummary(summary);
    const state = await this.turns.load(project, session);
    if (!state) return { due: false, gaps: ['宿主尚未提供轮级记录'] };
    const existing = await this.memory.turnSummaries({ subject, project, session });
    const history = existing.map(entry => ({ entry, sources: previousSources(entry, kind) })).filter(row => row.sources.length);
    const covered = new Set(history.flatMap(row => row.sources.map(sourceKey)));
    const closed = state.rounds.filter(round => round.status === 'closed');
    const available = closed.flatMap(round => round.messages);
    const pending = available.filter(message => !covered.has(sourceKey(sourceOf(message))));
    const pendingSeqs = new Set(pending.map(message => message.seq));
    const pendingRounds = closed.filter(round => round.messages.some(message => pendingSeqs.has(message.seq))).length;
    const pendingChars = pending.reduce((n, message) => n + message.text.length, 0);
    const last = history.reduce((latest, row) => Math.max(latest, Date.parse(row.entry.记于) || 0), 0);
    const due = pendingChars >= SUMMARY_DEFAULTS.minimumChars
      && (pendingRounds >= SUMMARY_DEFAULTS.rounds || this.clock.ms() - last >= SUMMARY_DEFAULTS.hours * 3600000);
    let messages = pending;
    if (kind === 'semantic') {
      const cited = new Set();
      for (const [category, items] of Object.entries(summary)) for (const item of items) {
        const source = available.find(message => message.id === item?.source);
        if (!source || typeof item.text !== 'string' || !item.text.trim()
            || category === '用户决定' && source.role !== 'user'
            || category === '助手建议' && !['assistant', 'external-assistant'].includes(source.role)) {
          throw new InvalidBody('总结来源或说话者不符；助手建议不能替代用户决定。');
        }
        cited.add(source.id);
      }
      // Empty understanding and retries do not consume uncited experiences. A new
      // interpretation can cite older sources alongside its newly understood ones.
      if (!pending.some(message => cited.has(message.id))) return { due: false, kind, pendingRounds, pendingChars };
      messages = available.filter(message => cited.has(message.id));
    } else if (!messages.length || !due) return { due, kind, pendingRounds, pendingChars };
    const sources = messages.map(sourceOf);
    const body = kind === 'semantic' ? { 形式: FORMS.semantic, ...summary }
      : { 形式: FORMS.extract, 经历: messages.map(message => ({ source: message.id, speaker: message.role,
        ...(message.origin ? { origin: message.origin } : {}), excerpt: message.text.slice(0, 240), 原文长度: message.text.length })) };
    const from = sources.reduce((lowest, source) => Math.min(lowest, source.seq), Infinity);
    const through = sources.reduce((highest, source) => Math.max(highest, source.seq), -1);
    const metadata = { kind, session: digest(session), from, through, sources,
      原文范围: '原文按需整理或明确遗忘，不因暂停或时间流逝自动淘汰；摘录不代表逐字完整记录', 缺口: state.coverageGaps ?? [] };
    const entry = await this.memory.recordTurnSummary({ subject, project, session, body: JSON.stringify(body), metadata, check: async () => {
      await this.turns.authorize(subject, project, session);
      const current = await this.turns.load(project, session);
      const currentSources = new Set(current?.rounds.flatMap(round => round.messages).map(message => sourceKey(sourceOf(message))));
      if (!current || current.floor > metadata.from || sources.some(source => !currentSources.has(sourceKey(source)))) {
        throw new InvalidBody('总结来源已更正或遗忘，丢弃迟到总结。');
      }
    } });
    const selected = new Set(sources.map(source => source.seq));
    return { due: false, kind, id: entry.id, rounds: closed.filter(round => round.messages.some(message => selected.has(message.seq))).length,
      sourceCount: sources.length, mode: body.形式 };
  }
  async forget({ subject, project, session }) {
    const entries = await this.memory.turnSummaries({ subject, project, session, includeInactive: true });
    if (entries.length) return this.memory.organize({ subject, 项目: project, op: 'forget', ids: entries.map(entry => entry.id), 原因: '轮级经历遗忘，同步清理总结' });
    return { forgotten: 0 };
  }
}
