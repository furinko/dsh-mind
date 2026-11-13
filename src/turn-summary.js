/** Incremental, source-bound experience recaps. Semantic understanding is revisable. */
import { digest } from './kernel/text.js';
import { InvalidBody } from './kernel/errors.js';
import { serializeByKey, withLock } from './kernel/fsx.js';
export const SUMMARY_DEFAULTS = Object.freeze({ rounds: 20, hours: 24, minimumChars: 4096 });
export class TurnSummaryService {
  constructor({ turns, memory, clock }) { this.turns = turns; this.memory = memory; this.clock = clock; }
  async summarize({ subject, project, session, summary }) {
    const file = this.turns.file(project, session);
    return serializeByKey(file, () => withLock(file + '.lock', () => this.#summarize({subject,project,session,summary})));
  }
  async #summarize({ subject, project, session, summary }) {
    await this.turns.authorize(subject, project, session);
    const state = await this.turns.load(project, session);
    if (!state) return { due: false, gaps: ['宿主尚未提供轮级记录'] };
    const existing = await this.memory.turnSummaries({ subject, project, session });
    const through = Math.max(-1, ...existing.map(e => e.轮级总结.through));
    const rounds = state.rounds.filter(r => r.status === 'closed' && r.messages.some(m => m.seq > through));
    const messages = rounds.flatMap(r => r.messages).filter(m => m.seq > through);
    const size = messages.reduce((n,m) => n + m.text.length, 0);
    const last = Math.max(0, ...existing.map(e => Date.parse(e.记于)));
    const due = size >= SUMMARY_DEFAULTS.minimumChars && (rounds.length >= SUMMARY_DEFAULTS.rounds || this.clock.ms() - last >= SUMMARY_DEFAULTS.hours * 3600000);
    if (!messages.length || !summary && !due) return { due, pendingRounds: rounds.length, pendingChars: size };
    const sources = messages.map(m => ({ seq:m.seq, id:m.id, hash:digest(m.text), role:m.role, ...(m.origin ? {origin:m.origin} : {}) }));
    let body;
    if (summary !== undefined) {
      if (!summary || typeof summary !== 'object' || !Array.isArray(summary.认识) || !Array.isArray(summary.用户决定) || !Array.isArray(summary.助手建议)) throw new InvalidBody('总结分别提供 用户决定、助手建议、认识 数组；每项需text和真实source消息id。');
      for (const [kind, items] of Object.entries(summary)) {
        if (!['认识','用户决定','助手建议'].includes(kind)) throw new InvalidBody('未知总结类别。');
        for (const item of items) {
          const source = messages.find(m => m.id === item?.source);
          if (!source || typeof item.text !== 'string' || !item.text.trim() || kind === '用户决定' && source.role !== 'user' || kind === '助手建议' && !['assistant','external-assistant'].includes(source.role)) throw new InvalidBody('总结来源或说话者不符；助手建议不能替代用户决定。');
        }
      }
      body = { 形式:'Lead有来源的理解，可随新经历修正；不认证语义正确', ...summary };
    } else {
      // Useful without a new model request; explicitly an extract, never a knowledge claim.
      body = { 形式:'自动经历摘录，非语义知识结论', 经历:messages.map(m => ({ source:m.id, speaker:m.role, ...(m.origin?{origin:m.origin}:{}), excerpt:m.text.slice(0,240), 原文长度:m.text.length })) };
    }
    const metadata = { session:digest(session), from:Math.min(...sources.map(s=>s.seq)), through:Math.max(...sources.map(s=>s.seq)), sources,
      原文范围:'Mind保留期内可取回；过期后摘录不代表逐字完整记录', 缺口:state.coverageGaps ?? [] };
    const entry = await this.memory.recordTurnSummary({ subject, project, session, body:JSON.stringify(body), metadata, check:async () => {
      await this.turns.authorize(subject,project,session);
      const current = await this.turns.load(project,session);
      if (!current || current.floor > metadata.from || sources.some(source => !current.rounds.some(r => r.messages.some(m => m.id === source.id && m.seq === source.seq && digest(m.text) === source.hash)))) throw new InvalidBody('总结来源已更正、过期或遗忘，丢弃迟到总结。');
    } });
    return { due:false, id:entry.id, rounds:rounds.length, sourceCount:sources.length, mode:body.形式 };
  }
  async forget({subject,project,session}) {
    const entries = await this.memory.turnSummaries({subject,project,session,includeInactive:true});
    if (entries.length) return this.memory.organize({subject,项目:project,op:'forget',ids:entries.map(e=>e.id),原因:'轮级经历遗忘，同步清理总结'});
    return {forgotten:0};
  }
}
