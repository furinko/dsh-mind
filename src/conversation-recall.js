/** 直接检索原轮缓冲；跨会话不要求先写正式记忆，不复制私人正文。 */
import { readdir, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { canonical, digest, normalizeForSearch, tokenize } from './kernel/text.js';
import { buildIndex, search } from './retrieval.js';
import { expandRecallQuery } from './memory-recall.js';
import { Denied, Fault, InvalidBody } from './kernel/errors.js';
import { currentProfessionalScope } from './professional-context.js';
import { TURN_BUFFER_LIMITS } from './turn-buffer.js';

export const CONVERSATION_RECALL_LIMITS = Object.freeze({ files: 1024, bytes: 64 * 1024 * 1024, context: 7000, snippet: 900 });
const natural = n => Number.isSafeInteger(n) && n >= 0;
const reference = (project, session, message) => `turn-${digest(canonical([project, session, message.seq, message.id]))}`;
// 工具调用只推进事件水位时，原文分页仍是同一版本。
const versionOf = state => digest(canonical(state ? { project: state.project, session: state.session,
  floor: state.floor, rounds: state.rounds, missing: state.missing, removed: state.removed } : null));
const entries = async directory => {
  try { return await readdir(directory, { withFileTypes: true }); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
};

function excerpt(text, query, limit) {
  if (text.length <= limit) return { text, offset: 0 };
  const normalized = normalizeForSearch(text);
  // 找命中位置，避免长消息末尾的细节只返回开头。归一化改变长度时从原文逐段核对。
  const terms = [...new Set(tokenize(query))].filter(t => t.length > 1).sort((a, b) => b.length - a.length);
  let offset = 0;
  if (normalized.length === text.length) {
    const positions = terms.map(t => normalized.indexOf(t)).filter(n => n >= 0);
    if (positions.length) offset = Math.max(0, Math.min(...positions) - 100);
  } else {
    for (let start = 0; start < text.length; start += Math.max(1, limit - 100)) {
      const part = normalizeForSearch(text.slice(start, start + limit));
      if (terms.some(t => part.includes(t))) { offset = start; break; }
    }
  }
  return { text: text.slice(offset, offset + limit), offset };
}

export class ConversationRecallService {
  constructor(org) { this.org = org; }
  async authorizeSource(actor, project, key) {
    await this.org.policy.check({ subject: actor, action: 'read', target: {
      id: `轮级缓冲/${key}`, kind: '记忆', authority: '自治', zone: '私有', domain: '个体', project } });
  }
  async proof(spec) {
    const credential = await this.org.turnBuffer.authorize(spec.subject, spec.project, spec.session);
    const bindings = await this.org.dataOwnership.bindings();
    return { bindings, stamp: digest(canonical([credential, bindings])) };
  }
  async read(spec, { text = '', id, limit = 8, offset = 0, bodyOffset = 0, budget = 12000,
    dataVersion, scanOffset = 0, crossProject = true, visible = [], includeRecent = false } = {}) {
    if (typeof text !== 'string' || text.length > 24000 || id !== undefined && !/^turn-[a-f0-9]{64}$/.test(id)
        || !natural(limit) || limit < 1 || limit > 100 || !natural(offset) || !natural(bodyOffset) || !natural(scanOffset)
        || !natural(budget) || budget < 1 || budget > 24000 || typeof crossProject !== 'boolean') throw new InvalidBody('对话召回需要有效查询词、引用、分页和1至24000字符预算。');
    const before = await this.proof(spec);
    const relationship = await this.org.dataOwnership.relationship(spec.session, before.bindings);
    const root = dirname(dirname(this.org.layout.turnBufferFile(spec.project, digest(spec.session))));
    const projects = crossProject ? (await entries(root)).filter(e => e.isDirectory() && !e.isSymbolicLink()).map(e => e.name) : [spec.project];
    projects.sort((a, b) => (a === spec.project ? -1 : b === spec.project ? 1 : a.localeCompare(b)));
    const actor = (await currentProfessionalScope(this.org, spec.subject, spec.project)).actor;
    const rows = []; const sources = new Map();
    const health = { 已扫描文件: 0, 不可读文件: 0, 扫描下一偏移: null, 扫描截断: false };
    let sourceIndex = 0; let bytes = 0;
    scan: for (const project of projects) {
      let directory;
      try {
        directory = dirname(this.org.layout.turnBufferFile(project, digest(spec.session)));
      } catch (e) { if (e.code === 'DENIED' || e.code === 'INVALID_BODY') continue; throw e; }
      const files = (await entries(directory)).filter(e => e.isFile() && !e.isSymbolicLink() && /^[a-f0-9]{64}\.json$/.test(e.name)).sort((a, b) => a.name.localeCompare(b.name));
      for (const file of files) {
        if (sourceIndex++ < scanOffset) continue;
        try { await this.authorizeSource(actor, project, file.name.slice(0, -5)); }
        catch (e) { if (e.code === 'DENIED') continue; throw e; }
        const info = await lstat(join(directory, file.name)).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
        if (!info || !info.isFile() || info.isSymbolicLink()) continue;
        if (info.size > TURN_BUFFER_LIMITS.bytes + 8192) { health.不可读文件++; continue; }
        if (health.已扫描文件 >= CONVERSATION_RECALL_LIMITS.files || bytes + info.size > CONVERSATION_RECALL_LIMITS.bytes) {
          health.扫描截断 = true; health.扫描下一偏移 = sourceIndex - 1; break scan;
        }
        bytes += info.size; health.已扫描文件++;
        let stored;
        try { stored = await this.org.turnBuffer.loadKey(project, file.name.slice(0, -5)); }
        catch (e) { if (e.code !== 'TURN_BUFFER_INVALID') throw e; health.不可读文件++; continue; }
        if (!stored || await this.org.dataOwnership.relationship(stored.session, before.bindings) !== relationship) continue;
        if (project === spec.project && stored.session === spec.session && spec.throughSeq !== undefined && stored.nextSeq > spec.throughSeq) {
          throw new Fault('TURN_RECALL_HISTORY_REWOUND', '当前宿主历史位置落后于缓冲，不召回未来正文。');
        }
        const state = this.org.turnBuffer.prune(structuredClone(stored));
        sources.set(`${project}/${stored.session}`, { project, session: stored.session, version: versionOf(state) });
        for (const round of state.rounds) for (const message of round.messages) {
          if (project === spec.project && stored.session === spec.session && visible.includes(message.seq)) continue;
          rows.push({ id: reference(project, stored.session, message), project, session: stored.session, round, message });
        }
      }
    }
    const version = digest(canonical({ sources: [...sources], relationship, health, scanOffset }));
    if (dataVersion !== undefined && version !== dataVersion) throw new Fault('TURN_RECALL_VERSION_CHANGED', '对话来源已变化，请从首页重新召回。');
    const query = expandRecallQuery(text);
    const index = !id && text.trim() ? buildIndex(rows.map(r => ({ id: r.id, 正文: r.message.text }))) : null;
    const ranked = index ? search(index, query, { limit: rows.length, 范围: crossProject ? '本地主人跨会话、跨项目原文' : '本项目跨会话原文' }) : null;
    const byId = new Map(rows.map(r => [r.id, r]));
    const recent = [...rows].sort((a, b) => (b.message.at ?? b.round.at) - (a.message.at ?? a.round.at) || b.message.seq - a.message.seq || a.id.localeCompare(b.id));
    let selected = id ? rows.filter(r => r.id === id) : ranked ? ranked.命中.map(h => byId.get(h.id)) : recent;
    if (!id && includeRecent && ranked) selected = [...new Map([...selected.slice(0, Math.max(0, limit - 2)), ...recent.slice(0, 2), ...selected].map(r => [r.id, r])).values()];
    const frame = { 版本: 1, 项目: spec.project, 会话: spec.session, 范围: crossProject ? '跨项目' : '本项目', 数据版本: version,
      口径: ranked?.口径 ?? { 搜索面: '轮级缓冲原文', 查询词: text, 文档数: rows.length, 命中数: selected.length },
      ...health, 下一偏移: null, 截断: health.扫描截断 || health.不可读文件 > 0, 条目: [] };
    let remaining = budget;
    for (const row of selected.slice(offset, offset + limit)) {
      if (remaining <= 0) break;
      const m = row.message;
      const piece = id ? { text: m.text.slice(bodyOffset, bodyOffset + remaining), offset: bodyOffset }
        : excerpt(m.text, query, Math.min(remaining, CONVERSATION_RECALL_LIMITS.snippet));
      remaining -= piece.text.length;
      const next = piece.offset + piece.text.length < m.text.length ? piece.offset + piece.text.length : null;
      frame.条目.push({ id: row.id, 项目: row.project, 会话: row.session, 消息: m.id, 事件序号: m.seq,
        角色: m.role, 时间: m.at ?? null, 轮次状态: row.round.status, 结束原因: row.round.reason ?? null,
        文本: piece.text, 正文偏移: piece.offset, 下一正文偏移: next, 保存时截断: m.clipped, 中断: m.interrupted,
        ...(m.origin ? { 来源: m.origin } : {}),
        继续读取: { action: 'turn_buffer_query', id: row.id, 正文偏移: 0, 扫描偏移: scanOffset, 跨项目: crossProject } });
      frame.截断 ||= m.clipped || piece.offset > 0 || next !== null;
    }
    frame.下一偏移 = offset + frame.条目.length < selected.length ? offset + frame.条目.length : null;
    frame.截断 ||= frame.下一偏移 !== null;
    if (frame.扫描下一偏移 !== null) frame.继续扫描 = { action: 'turn_buffer_query', 文本: text,
      跨项目: crossProject, 扫描偏移: frame.扫描下一偏移, 偏移: 0 };
    // 清空、过期、替换及关系改动都使旧帧失效；不使用私人正文的持久索引副本。
    for (const source of sources.values()) {
      await this.authorizeSource(actor, source.project, digest(source.session));
      const live = await this.org.turnBuffer.load(source.project, source.session);
      if (source.version !== versionOf(live ? this.org.turnBuffer.prune(structuredClone(live)) : null)) throw new Fault('TURN_RECALL_SOURCE_CHANGED', '对话来源读取期间变化，请重新召回。');
    }
    if (before.stamp !== (await this.proof(spec)).stamp) throw new Denied('对话召回 · 身份或关系变化', '身份或关系已变化，丢弃旧对话资料。');
    return frame;
  }
}
