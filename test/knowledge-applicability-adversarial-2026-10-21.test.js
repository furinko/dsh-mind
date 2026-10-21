/** 独立适用说明/期限反例：真实Org与可推进时钟，禁止用文件改动代替到期测试。 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { makeFixture, LEAD, MEMBER, SOVEREIGN } from './helpers.mjs';
import { Org } from '../src/org.js';
import { normalizeKnowledgeContext, knowledgeReviewStatus } from '../src/knowledge-applicability.js';
import { canonical, digest } from '../src/kernel/text.js';
import { readTextOrNull } from '../src/kernel/fsx.js';
import { runAction } from '../lib/actions.js';
import { DIR } from '../src/paths.js';
import { InvalidBody, Denied } from '../src/kernel/errors.js';

const P = 'knowledge-applicability-independent-adversarial';
const Q = `${P}-other`;
const REVIEWER = { id: 'reviewer', kind: '成员', roleId: '复核员' };
const DELETION_TEXT = '删除后不得残留的适用条件与反例全文';
const SECRET = 'private-token-in-conditions';
const declaration = id => ({ id, 用途: '本次任务采用声明', 适用判断: '本人判断，非机器认证', 使用结果: '未知' });

async function scene(body) {
  const f = await makeFixture();
  try {
    const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
    const base = Math.floor(Date.now() / 1000) * 1000; let now = base;
    org.clock._source = () => new Date(now);
    const clock = value => { now = value; };
    const iso = delta => new Date(base + delta).toISOString();
    const write = (知识说明, extra = {}) => org.memory.remember({ subject: LEAD, 类: '知识', 项目: P, 内容: 'DeadlineCacheAlpha 可复用主张', 来源: '隔离作者声明', ...(知识说明 === undefined ? {} : { 知识说明 }), ...extra });
    const query = (extra = {}) => org.memory.query({ subject: LEAD, 项目: P, 类: '知识', 读者: LEAD, 返回模式: '摘要', ...extra });
    const task = async (extra = {}) => {
      const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '复验期限隔离任务', 负责人: MEMBER.roleId, 判据: ['记录可追溯'], ...extra });
      await org.tasks.bind(node.id, { subject: LEAD, 项目: P, 实例: MEMBER.id, 岗位: MEMBER.roleId }); await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P }); await org.tasks.start(node.id, { subject: MEMBER, 项目: P });
      return node;
    };
    const accepted = async () => {
      const node = await task(); await org.tasks.submit(node.id, { subject: MEMBER, 项目: P, 知识候选: ['待晋升候选'] });
      const reviewed = await org.tasks.review(node.id, { subject: LEAD, 项目: P, 三态: '过' }); await org.tasks.accept(node.id, { subject: LEAD, 项目: P, 票: reviewed.待采纳.票 });
      return node;
    };
    const act = (args, subject = LEAD) => runAction({ org, 项目: P, subject, 主体: subject, 面: 'tool', args });
    await body({ f, org, base, clock, iso, write, query, task, accepted, act });
  } finally { await f.cleanup(); }
}

describe('独立知识说明：写入与兼容', { timeout: 60_000 }, () => {
  it('UTC秒/毫秒正控与精确到期边界；无期限不猜永远有效，非法说明不冒充旧知识', () => {
    for (const time of ['2026-10-21T12:00:00Z', '2026-10-21T12:00:00.000Z', '2026-10-21T12:00:00.123Z']) assert.equal(normalizeKnowledgeContext({ 复验期限: time }).复验期限, time);
    const entry = { 类: '知识', 知识说明: { 复验期限: '2026-10-21T12:00:00Z' } }; const deadline = Date.parse(entry.知识说明.复验期限);
    assert.equal(knowledgeReviewStatus(entry, deadline - 1), '期限内'); assert.equal(knowledgeReviewStatus(entry, deadline), '待复验');
    assert.equal(knowledgeReviewStatus({ 类: '知识' }, deadline), '未设期限'); assert.equal(knowledgeReviewStatus({ 类: '知识', 知识说明: {} }, deadline), '说明不可判');
    assert.equal(knowledgeReviewStatus({ 类: '经历' }, deadline), null);
  });

  it('坏日期、空/越界/自报状态、非知识挂说明都在零记忆事件时拒绝', async () => scene(async ({ f, write }) => {
    const bad = [null, {}, { 适用条件: [] }, { 适用条件: [''] }, { 适用条件: ['x'.repeat(513)] }, { 已验证: true },
      { 复验期限: '2026-02-30T12:00:00Z' }, { 复验期限: '2026-10-21T12:00:00' }, { 复验期限: '2026-10-21T12:00:00+08:00' },
      { 适用条件: Array(17).fill('条件') }];
    for (const value of bad) await assert.rejects(() => write(value), InvalidBody);
    await assert.rejects(() => write({ 适用条件: ['仅知识'] }, { 类: '经历' }), InvalidBody);
    assert.equal(await readTextOrNull(f.layout.memoryLog(P, '知识')), null); assert.equal(await readTextOrNull(f.layout.memoryLog(DIR.跨项目, '经历')), null);
  }));

  it('首个await前深拷贝作者数组，后改入参不能偷偷延长期限或改说明', async () => scene(async ({ iso, write, query }) => {
    const notes = { 适用条件: ['原条件'], 复验期限: iso(1000) };
    const pending = write(notes); notes.适用条件[0] = '后来改条件'; notes.复验期限 = iso(100000); const result = await pending;
    const entry = (await query({ id: result.id, 返回模式: '全文' })).条目[0]; assert.deepEqual(entry.知识说明.适用条件, ['原条件']); assert.equal(entry.知识说明.复验期限, iso(1000));
  }));

  it('旧知识metadatahash保持原算法，新增说明完整入hash且没有正文改动的版本差异可辨', async () => scene(async ({ org, write, query, clock, base }) => {
    const old = await write(); const entry = (await query({ id: old.id, 返回模式: '全文' })).条目[0];
    const metadata = Object.fromEntries(['id', '类', '标题', '来源', '来源引用', '派生自', '归属', '项目', '岗位', '标签', '状态', '历史', '记于'].map(key => [key, entry[key] ?? null]));
    const evidence = (await org.memory.readKnowledgeEvidence({ subject: LEAD, 项目: P, ids: [old.id] })).get(old.id);
    assert.equal(evidence.元数据哈希, digest(canonical(metadata)), '无新字段的老知识不能无故更换捕获算法');
    clock(base + 10000); assert.equal((await org.memory.readKnowledgeEvidence({ subject: LEAD, 项目: P, ids: [old.id] })).get(old.id).元数据哈希, evidence.元数据哈希);
    const notes = { 适用条件: ['完整条件'], 已知反例: ['反例保留完整'], 复验条件: ['出现新证据时'] };
    const fresh = await write(notes); const full = (await query({ id: fresh.id, 返回模式: '全文' })).条目[0];
    const newMeta = { ...Object.fromEntries(Object.keys(metadata).map(key => [key, full[key] ?? null])), 知识说明: notes };
    assert.equal((await org.memory.readKnowledgeEvidence({ subject: LEAD, 项目: P, ids: [fresh.id] })).get(fresh.id).元数据哈希, digest(canonical(newMeta)));
  }));
});

describe('独立知识说明：时间资格、缓存和读域', { timeout: 60_000 }, () => {
  it('无文件改动跨过期限即换索引/数据版本，未跨边界的秒变不会使分页失效', async () => scene(async ({ f, base, iso, clock, write, query }) => {
    const source = await write({ 复验期限: iso(1000), 适用条件: ['作者条件'] }); const file = f.layout.memoryLog(P, '知识');
    const bytes = await readFile(file, 'utf8'); const originalStat = await stat(file);
    const first = await query({ 文本: 'DeadlineCacheAlpha', 条数上限: 1, limit: 1 }); assert.equal(first.条目[0].id, source.id); assert.equal(first.条目[0].复验状态, '期限内');
    clock(base + 500); const same = await query({ 文本: 'DeadlineCacheAlpha', 偏移: 1, 数据版本: first.数据版本 }); assert.equal(same.数据版本, first.数据版本);
    clock(base + 1000); const expired = await query({ 文本: 'DeadlineCacheAlpha' }); assert.deepEqual(expired.条目, []); assert.equal(expired.口径.文档数, 0); assert.equal(expired.口径.排除待复验, 1); assert.notEqual(expired.数据版本, first.数据版本);
    await assert.rejects(() => query({ 文本: 'DeadlineCacheAlpha', 偏移: 1, 数据版本: first.数据版本 }), InvalidBody);
    assert.equal(await readFile(file, 'utf8'), bytes); assert.equal((await stat(file)).mtimeMs, originalStat.mtimeMs, '不能靠偷偷写状态行完成到期');
    const explicit = await query({ id: source.id, 含待复验: true, 返回模式: '全文' }); assert.equal(explicit.条目[0].复验状态, '待复验'); assert.equal(explicit.条目[0].状态, '有效');
  }));

  it('含待复验和含失效是交集；list/search/id及无期限旧知识同一口径', async () => scene(async ({ org, base, iso, clock, write, query }) => {
    const due = await write({ 复验期限: iso(1) }); const invalid = await write({ 复验期限: iso(1) }); const old = await write(undefined, { 内容: 'legacy-no-deadline' });
    await org.memory.invalidate(invalid.id, { subject: LEAD, 原因: '真实失效，复验不能解除' }); clock(base + 2);
    for (const args of [{}, { 含失效: true }]) assert.deepEqual((await query(args)).条目.map(row => row.id), [old.id]);
    const explicit = await query({ 含待复验: true }); assert.ok(explicit.条目.some(row => row.id === due.id)); assert.ok(!explicit.条目.some(row => row.id === invalid.id));
    assert.equal((await query({ 含待复验: true, 含失效: true })).条目.length, 3);
    assert.deepEqual((await query({ id: due.id })).条目, []); assert.deepEqual((await query({ 文本: 'DeadlineCacheAlpha' })).条目, []);
    assert.equal((await query({ id: old.id })).条目[0].复验状态, '未设期限');
    await assert.rejects(() => query({ 含待复验: 'true' }), InvalidBody);
  }));

  it('显式含待复验不扩大复核对象域或项目域', async () => scene(async ({ org, base, iso, clock, write, task, act }) => {
    const one = await task(); const other = await task();
    const a = await write({ 复验期限: iso(1) }, { 来源引用: [one.id] }); const b = await write({ 复验期限: iso(1) }, { 来源引用: [other.id] }); const foreign = await write({ 复验期限: iso(1) }, { 项目: Q });
    const review = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '复验说明的独立读域', 负责人: '复核员', 判据: ['核对'], 复核对象: [one.id] });
    await org.tasks.bind(review.id, { subject: LEAD, 项目: P, 实例: REVIEWER.id, 岗位: REVIEWER.roleId }); await org.tasks.dispatch(review.id, { subject: LEAD, 项目: P }); clock(base + 2);
    const result = (await act({ action: 'memory_query', 类: '知识', 含待复验: true, 返回模式: '全文' }, REVIEWER)).结果;
    assert.deepEqual(result.条目.map(row => row.id), [a.id]);
    for (const id of [b.id, foreign.id]) assert.deepEqual((await act({ action: 'memory_query', 类: '知识', 含待复验: true, id }, REVIEWER)).结果.条目, []);
  }));

  it('到期来源统一未核验，任务仍能合法提交，采用历史hash当前也不复活', async () => scene(async ({ f, org, base, iso, clock, write, task }) => {
    const source = await write({ 复验期限: iso(1000) }); const node = await task();
    await org.tasks.submit(node.id, { subject: MEMBER, 项目: P, 采用知识: [declaration(source.id)] });
    const before = await org.knowledgeReuse.query({ subject: LEAD, 项目: P }); const oldHash = before.采用页.条目[0].采用知识[0].来源.元数据哈希;
    clock(base + 1000); const evidence = await org.memory.readKnowledgeEvidence({ subject: MEMBER, 项目: P, ids: [source.id] }); assert.deepEqual(evidence.get(source.id), { 状态: '来源未核验' });
    await org.tasks.submit(node.id, { subject: MEMBER, 项目: P, 采用知识: [declaration(source.id)] });
    const rows = (await org.tasks.events({ 项目: P })).filter(row => row.kind === 'submitted'); assert.equal(rows.length, 2); assert.deepEqual(rows[1].采用知识.条目[0].来源, { 状态: '来源未核验' });
    const current = await org.knowledgeReuse.query({ subject: LEAD, 项目: P }); assert.ok(!JSON.stringify(current).includes(oldHash)); assert.ok(await readTextOrNull(f.layout.taskLog(P)));
  }));

  it('坏已存说明默认排除，显式读也只给不可判警示而不回显任意对象', async () => scene(async ({ f, org, write, query }) => {
    const source = await write(); const file = f.layout.memoryLog(P, '知识');
    const rows = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse); rows[0].知识说明 = { 已验证: true, 正文: SECRET }; await writeFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
    const hidden = await query(); assert.deepEqual(hidden.条目, []); assert.equal(hidden.口径.说明不可判数, 1); assert.equal(hidden.口径.排除说明不可判, 1);
    const explicit = await query({ id: source.id, 含待复验: true }); assert.equal(explicit.条目[0].复验状态, '说明不可判'); assert.equal(explicit.条目[0].知识说明, undefined); assert.ok(!JSON.stringify(explicit).includes(SECRET));
    assert.deepEqual((await org.memory.readKnowledgeEvidence({ subject: LEAD, 项目: P, ids: [source.id] })).get(source.id), { 状态: '来源未核验' });
  }));
});

describe('独立知识说明：披露、晋升与删除', { timeout: 60_000 }, () => {
  it('说明中的凭据/路径受通用直写与跨项目晋升共同扫描，正常条件仍可用', async () => scene(async ({ f, org, write }) => {
    for (const text of ['password=not-for-public', 'C:\\private\\notes']) {
      await assert.rejects(() => write({ 已知反例: [text] }, { 项目: '通用' }), Denied);
      const source = await write({ 适用条件: [text] }); await assert.rejects(() => org.memory.promoteCrossProject(source.id, { subject: LEAD, 岗位: MEMBER.roleId, 理由: '尝试扩散说明字段' }), Denied);
    }
    const normal = await write({ 适用条件: ['明确的公开适用条件'] }, { 项目: '通用' }); assert.ok(normal.id);
    assert.ok(!JSON.stringify(await org.audit.read({})).includes('password=not-for-public'));
  }));

  it('新说明后尾超20k未全检不能扩散，不能只扫正文和前缀后把尾部放行', async () => scene(async ({ org, write }) => {
    const fields = Object.fromEntries(['适用条件', '已知反例', '复验条件'].map(key => [key, Array(16).fill('x'.repeat(512))])); fields.复验条件[15] = 'x'.repeat(480) + SECRET;
    const source = await write(fields); await assert.rejects(() => org.memory.promoteCrossProject(source.id, { subject: LEAD, 岗位: MEMBER.roleId, 理由: '尾部未完整扫描' }), error => error instanceof Denied && /超长/.test(error.rule));
    await assert.rejects(() => write(fields, { 项目: '通用' }), error => error instanceof Denied && /超长/.test(error.rule));
  }));

  it('晋升同key同说明认回，改条件/期限及省略差异均拒，不把两个对象String化认成同一份', async () => scene(async ({ org, accepted, iso, query }) => {
    const source = await accepted(); const notes = { 适用条件: ['条件甲'], 复验期限: iso(100000) };
    const spec = { subject: LEAD, 项目: P, 岗位: MEMBER.roleId, 内容: '正式晋升内容', 知识说明: notes, 晋升: { 来源任务: source.id, 候选键: 'same-normalized-key' } };
    const first = await org.memory.promoteFromAdopted(spec); assert.equal((await org.memory.promoteFromAdopted(structuredClone(spec))).id, first.id);
    for (const 知识说明 of [{ ...notes, 适用条件: ['条件乙'] }, { ...notes, 复验期限: iso(200000) }, undefined]) await assert.rejects(() => org.memory.promoteFromAdopted({ ...spec, 知识说明 }), Denied);
    assert.equal((await query()).条目.length, 1); assert.deepEqual((await query({ id: first.id, 返回模式: '全文' })).条目[0].知识说明, notes);
  }));

  it('结账晋升真实透传作者说明，不只在审批/计划预览里显示', async () => scene(async ({ org, accepted, iso, query }) => {
    const source = await accepted(); const key = `候选/${MEMBER.id}/0`; const notes = { 已知反例: ['作者反例'], 复验期限: iso(100000) };
    const result = await org.tasks.settle(source.id, { subject: LEAD, 项目: P, 记忆处置: { [key]: { 处置: '晋升', 内容: '结账真实知识', 岗位: MEMBER.roleId, 知识说明: notes } } });
    assert.deepEqual((await query({ id: result.记忆晋升[key], 返回模式: '全文' })).条目[0].知识说明, notes);
  }));

  it('purge同时清源和跨项目完整说明，审计/状态行不能留下说明正文', async () => scene(async ({ f, org, write }) => {
    const source = await write({ 适用条件: [DELETION_TEXT], 已知反例: [DELETION_TEXT] }, { 内容: 'purge目标正文' });
    await org.memory.promoteCrossProject(source.id, { subject: LEAD, 岗位: MEMBER.roleId, 理由: '公开知识双副本' });
    const files = [f.layout.memoryLog(P, '知识'), f.layout.memoryLog(DIR.跨项目, '知识')];
    for (const file of files) assert.ok((await readFile(file, 'utf8')).includes(DELETION_TEXT));
    await org.memory.purge(source.id, { subject: SOVEREIGN, 理由: '隔离删除校验', 敏感: true });
    for (const file of files) assert.ok(!(await readFile(file, 'utf8')).includes(DELETION_TEXT));
    assert.ok(!JSON.stringify(await org.audit.read({})).includes(DELETION_TEXT));
  }));

  it('overturn新正文默认无旧说明，明确给新说明才保存，不自动宣称复验成功', async () => scene(async ({ org, iso, write, query }) => {
    const old = await write({ 适用条件: ['旧主张条件'], 复验期限: iso(1000) });
    const one = await org.memory.overturn(old.id, { subject: LEAD, 新条目: '新主张不等于旧主张', 理由: '真实追加替代' });
    const current = (await query({ id: one.新条目, 返回模式: '全文' })).条目[0]; assert.equal(current.知识说明, undefined); assert.equal(current.复验状态, '未设期限');
    const notes = { 适用条件: ['新条件'], 复验期限: iso(100000) }; const two = await org.memory.overturn(one.新条目, { subject: LEAD, 新条目: '另一个新主张', 理由: '明确新说明', 知识说明: notes });
    assert.deepEqual((await query({ id: two.新条目, 返回模式: '全文' })).条目[0].知识说明, notes);
  }));

  it('巨型说明遵守现有响应预算，压缩元数据后仍保留待复验警示', async () => scene(async ({ base, iso, clock, write, query }) => {
    const source = await write({ 适用条件: Array(16).fill('用'.repeat(512)), 复验期限: iso(1) }); clock(base + 1);
    const result = await query({ id: source.id, 含待复验: true, 内容预算: 512 });
    assert.ok(JSON.stringify(result).length <= 40000); assert.ok(result.内容截断); assert.equal(result.条目[0].复验状态, '待复验'); assert.ok(result.条目[0].复验警示.includes('复验'));
  }));

  it('最大预算能读全三组长说明，长正文仍能按同一数据版本逐页恢复', async () => scene(async ({ write, act }) => {
    const notes = Object.fromEntries(['适用条件', '已知反例', '复验条件'].map(key => [key, Array.from({ length: 16 }, (_, i) => `${key}:${i}:`.padEnd(512, '述'))]));
    const body = '独立正文段😀\n'.repeat(2500) + '终'; const source = await write(notes, { 内容: body });
    let offset = 0; let version; let restored = ''; let pages = 0;
    do {
      const envelope = await act({ action: 'memory_query', id: source.id, 返回模式: '全文', 内容预算: 32000, 正文偏移: offset, ...(version ? { 数据版本: version } : {}) });
      const page = envelope.结果; const row = page.条目[0]; pages += 1;
      assert.ok(row, '不能因完整说明较大而丢掉整条知识'); assert.deepEqual(row.知识说明, notes); assert.notEqual(row.元数据截断, true);
      assert.ok(page.内容已用 <= 32000); assert.ok(JSON.stringify(envelope, null, 1).length <= 40000);
      assert.equal(row.正文偏移, offset); assert.equal(row.正文总字符, body.length);
      if (version) assert.equal(page.数据版本, version); else version = page.数据版本;
      restored += row.内容;
      const next = page.下一正文偏移;
      if (next === null) break;
      assert.equal(next, offset + row.内容.length); assert.ok(next > offset, '每个续页必须推进正文'); offset = next;
      assert.ok(pages < 20, '有限正文不能停在不可恢复的同一页');
    } while (true);
    assert.ok(pages > 1); assert.equal(restored, body);
  }));
});
