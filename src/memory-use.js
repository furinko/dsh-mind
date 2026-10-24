/** Operational observations only. No bodies, queries or model reasoning; memory and submitted adoption remain their own truth. */
import { join } from 'node:path';
import { stat, mkdir, open, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import { assertPersonaCorePath } from './persona-core.js';
import { canonical, digest } from './kernel/text.js';
import { currentProfessionalScope } from './professional-context.js';
import { randomUUID } from 'node:crypto';
import { readJsonlHealth, listFiles, serializeByKey, withLock } from './kernel/fsx.js';
import { assertPathSegment, MEMORY_KINDS } from './paths.js';
import { Denied, Fault, InvalidBody } from './kernel/errors.js';

const STAGES = new Set(['selected', 'assembled', 'request-observed', 'explicit-read', 'adoption-declared']);
const claim = '仅观察记录：选中、装配、请求观察点包含、工具返回片段、交卷采用声明分别计；不证明主观阅读、远端最终接收或收益。无观察不等于未使用。';
const text = v => typeof v === 'string' && !!v.trim() && v.length <= 256;
export class MemoryUseService {
  constructor({ org, layout, clock }) { Object.assign(this, { org, layout, clock }); }
  root(project) { return this.layout.private('记忆调用观察', assertPathSegment(project, '项目')); }
  async observe(input) {
    const { subject, project, session, stage, observation, items = [], tasks = [], attempt = null } = input;
    if (!['Lead', '成员'].includes(subject?.kind) || subject.id !== session || !text(project) || !STAGES.has(stage) || !text(observation)
      || !Array.isArray(items) || items.length > 32 || !Array.isArray(tasks) || tasks.length > 8 || tasks.some(t => !text(t))) throw new InvalidBody('记忆观察需要真实主体及有限元数据。');
    const clean = items.map(i => {
      if (!text(i.id) || ![...MEMORY_KINDS, '能力'].includes(i.kind) || i.version != null && !/^[a-f0-9]{64}$/.test(i.version)
        || i.chars != null && (!Number.isSafeInteger(i.chars) || i.chars < 0 || i.chars > 40000)) throw new InvalidBody('记忆观察条目无效。');
      return { id: i.id, kind: i.kind, version: i.version ?? null, chars: i.chars ?? null, partial: i.partial === true,
        ...(i.outcome && ['有帮助', '不适用', '发现问题', '未知'].includes(i.outcome) ? { outcome: i.outcome } : {}) };
    });
    const member = (await this.org.registry.identity()).members?.[subject.id];
    if (member?.status !== '在岗' || (subject.kind === 'Lead') !== (member.岗位 === 'Lead') || subject.roleId !== undefined && subject.roleId !== member.岗位) throw new Denied('记忆观察主体', '身份已变化，不记录旧主体观察。');
    const stamp = digest(canonical(member)); const ownershipStamp = await this.org.dataOwnership.stamp(session);
    const check = async () => {
      if (await input.valid?.() === false || input.scopeStamp && input.scopeStamp !== (await currentProfessionalScope(this.org, subject, project)).stamp || stamp !== digest(canonical((await this.org.registry.identity()).members?.[subject.id] ?? null)) || ownershipStamp !== await this.org.dataOwnership.stamp(session)) throw new Denied('记忆观察范围变化', '旧观察不归入新身份或新关系。');
    };
    const relationship = subject.kind === 'Lead' ? await this.org.dataOwnership.relationship(session) : null;
    const now = this.clock.iso(); const file = join(this.root(project), now.slice(0, 7) + '.jsonl');
    const row = { version: 1, id: randomUUID(), at: now, actor: subject.id, role: member.岗位, session, relationship, stage, observation, tasks, attempt: text(attempt) ? attempt : null, items: clean };
    assertPersonaCorePath(file, { allowMissing: true });
    await mkdir(this.root(project), { recursive: true, mode: 0o700 }); await chmod(this.root(project), 0o700);
    await serializeByKey(file, () => withLock(file + '.lock', async () => {
      await check(); assertPersonaCorePath(file, { allowMissing: true });
      const size = await stat(file).then(s => s.size, e => { if (e.code === 'ENOENT') return 0; throw e; });
      if (size + Buffer.byteLength(JSON.stringify(row)) > 16 * 1024 * 1024) throw new Fault('MEMORY_USE_LIMIT', '当月记忆观察达到容量，观察存在缺口；不清零或改写记忆。');
      const handle = await open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { await handle.chmod(0o600); await check(); await handle.writeFile(JSON.stringify(row) + '\n'); } finally { await handle.close(); }
    }));
  }
  async query({ subject, project, id, limit = 20, offset = 0 }) {
    if (!text(project) || id !== undefined && !text(id) || !Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger(offset) || offset < 0) throw new InvalidBody('观察查询参数无效。');
    if (!['Lead', '成员', '主权者'].includes(subject?.kind)) throw new Denied('记忆观察读者', '需要当前真实读者。');
    const member = subject.kind === '主权者' ? null : (await this.org.registry.identity()).members?.[subject.id];
    if (subject.kind !== '主权者' && (member?.status !== '在岗' || (subject.kind === 'Lead') !== (member.岗位 === 'Lead'))) throw new Denied('记忆观察读者', '当前身份不可用。');
    await this.org.policy.check({ subject, action: 'read', target: { id: '记忆调用观察', kind: '记忆', authority: '自治', zone: '私有', domain: '集体', project } });
    const stamp = await this.org.dataOwnership.stamp(subject.id);
    const relationship = subject.kind === 'Lead' ? await this.org.dataOwnership.relationship(subject.id) : null;
    const scope = subject.kind === '成员' ? await currentProfessionalScope(this.org, subject, project) : null;
    const all = []; assertPersonaCorePath(this.root(project), { allowMissing: true }); const files = (await listFiles(this.root(project), { recursive: false, filter: n => /^\d{4}-\d{2}\.jsonl$/.test(n) })).sort().reverse();
    for (const name of files.slice(0, 3)) {
      const file = join(this.root(project), name); assertPersonaCorePath(file); if ((await stat(file)).size > 16 * 1024 * 1024) throw new Fault('MEMORY_USE_INVALID', '观察文件超限，不返回虚假空记录。');
      const health = await readJsonlHealth(file);
      if (health.坏行 || !health.末行完整) throw new Fault('MEMORY_USE_INVALID', '观察账本损坏，不返回虚假空记录。');
      for (const row of health.rows) {
        if (row.version !== 1 || !STAGES.has(row.stage) || !Array.isArray(row.items) || row.items.length > 32 || row.items.some(i => !i || !text(i.id) || ![...MEMORY_KINDS, '能力'].includes(i.kind)) || !text(row.actor) || !text(row.session) || !text(row.role) || !text(row.at) || !text(row.observation) || row.relationship !== null && !text(row.relationship) || !Array.isArray(row.tasks) || row.tasks.some(t => !text(t))) throw new Fault('MEMORY_USE_INVALID', '观察账本结构异常。');
        if (subject.kind === '成员' && (row.actor !== subject.id || row.role !== member.岗位 || scope.council || scope.domain?.限定 && (row.tasks.length === 0 || row.tasks.some(id => !scope.nodes.some(n => n.id === id))))) continue;
        if (subject.kind === 'Lead' && row.relationship !== null && row.relationship !== relationship) continue;
        if (id && !row.items.some(i => i.id === id)) continue;
        all.push(row);
      }
    }
    if (stamp !== await this.org.dataOwnership.stamp(subject.id)) throw new Denied('观察关系变化', '关系变化，请重新读取。');
    const current = subject.kind === '主权者' ? null : (await this.org.registry.identity()).members?.[subject.id];
    if (subject.kind !== '主权者' && (current?.status !== '在岗' || current.卡版本?.摘要 !== member.卡版本?.摘要 || current.代 !== member.代)) throw new Denied('观察读域变化', '身份变化，丢弃观察结果。');
    if (scope && scope.stamp !== (await currentProfessionalScope(this.org, subject, project)).stamp) throw new Denied('观察读域变化', '任务或复核读域变化，丢弃观察结果。');
    all.reverse().sort((a, b) => b.at.localeCompare(a.at));
    const counts = Object.fromEntries([...STAGES].map(s => [s, all.filter(r => r.stage === s).length]));
    return { counts, entries: all.slice(offset, offset + limit), total: all.length, nextOffset: offset + limit < all.length ? offset + limit : null,
      coverage: { months: files.slice(0, 3), olderMonthsOmitted: Math.max(0, files.length - 3), claim, actualUnderstanding: '未知', benefit: '以原任务采用声明与后续反馈核对，观察不作认证' },
      runtime: this.org.memoryUseHooks?.health() ?? { attached: false, coverage: '未知' } };
  }
}
