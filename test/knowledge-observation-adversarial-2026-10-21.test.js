/** 单请求知识读帧：真实晚变更不能混入早批hash，不靠跨请求缓存或毫秒阈值。 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fsPromises, { readFile, writeFile, stat } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
import { makeFixture, LEAD, MEMBER, SOVEREIGN } from './helpers.mjs';
import { Org } from '../src/org.js';
import { digest } from '../src/kernel/text.js';
import { DIR } from '../src/paths.js';

const P = 'knowledge-observation-independent-adversarial';
const Q = `${P}-other`;
const DECLARATION = 'TASK_DECLARATION_MUST_SURVIVE_SOURCE_UNKNOWN';
const CONTENT = 'KNOWLEDGE_CONTENT_MUST_NOT_ENTER_OBSERVATION_RESPONSE';
const adoption = id => ({ id, 用途: DECLARATION, 适用判断: '作者判断，不代表来源已验证', 使用结果: '发现问题' });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function scene(run) {
  const f = await makeFixture();
  try {
    const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
    const base = Math.floor(Date.now() / 1000) * 1000; let now = base; org.clock._source = () => new Date(now);
    const setNow = value => { now = value; };
    const knowledge = (extra = {}) => org.memory.remember({ subject: LEAD, 类: '知识', 项目: P, 内容: CONTENT, 来源: '隔离快照证据', ...extra });
    const task = async () => { const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '观察快照隔离', 负责人: MEMBER.roleId, 判据: ['读数可追溯'] }); await org.tasks.bind(node.id, { subject: LEAD, 项目: P, 实例: MEMBER.id, 岗位: MEMBER.roleId }); await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P }); await org.tasks.start(node.id, { subject: MEMBER, 项目: P }); return node; };
    const declare = async (sources, repetitions = 1) => { const node = await task(); for (let round = 0; round < repetitions; round++) for (let start = 0; start < sources.length; start += 16) await org.tasks.submit(node.id, { subject: MEMBER, 项目: P, 采用知识: sources.slice(start, start + 16).map(source => adoption(source.id)) }); return node; };
    const many = async (count = 17, extra = {}) => { const result = []; for (let i = 0; i < count; i++) result.push(await knowledge(extra)); return result; };
    const query = () => org.knowledgeReuse.query({ subject: LEAD, 项目: P });
    const frame = callback => org.memory.withKnowledgeReadSnapshot({ subject: LEAD, 项目: P }, callback);
    const evidence = (reader, ids) => reader.readKnowledgeEvidence({ subject: LEAD, 项目: P, ids });
    const purge = id => org.memory.purge(id, { subject: SOVEREIGN, 理由: '隔离晚删除', 敏感: true });
    await run({ f, org, base, setNow, knowledge, many, task, declare, query, frame, evidence, purge });
  } finally { await f.cleanup(); }
}

function assertUnknownSources(view, count) {
  const items = view.采用页.条目.flatMap(record => record.采用知识);
  assert.equal(items.length, count); assert.ok(JSON.stringify(view).includes(DECLARATION), '来源失败不能抹除合法任务声明');
  for (const item of items) { assert.deepEqual(item.来源, { 状态: '来源未核验' }); assert.equal(item.当前版本, undefined); assert.equal(item.当前来源, undefined); assert.deepEqual(item.反馈处置, { 状态: '不可核对', 记录: [], 总数: null, 截断: null }); }
  assert.ok(!JSON.stringify(view).includes('内容哈希')); assert.ok(!JSON.stringify(view).includes(CONTENT));
}

describe('独立观察：晚变更不能泄早批观察', { timeout: 60_000 }, () => {
  it('晚批真实purge后整组unknown，不公开早批来源hash且保留原任务声明', async () => scene(async ({ org, many, declare, query, purge }) => {
    const sources = await many(); await declare(sources); const original = org.memory.readKnowledgeEvidence.bind(org.memory); let calls = 0;
    org.memory.readKnowledgeEvidence = async args => { if (++calls === 2) await purge(sources[0].id); return original(args); };
    const view = await query(); assert.ok(calls >= 2, '必须保留跨批旧方法seam'); assertUnknownSources(view, sources.length);
  }));

  it('晚批撤来源read后整组unknown，不能只让后来批变未知', async () => scene(async ({ org, many, declare, query }) => {
    const sources = await many(); await declare(sources); const original = org.memory.readKnowledgeEvidence.bind(org.memory); const decide = org.policy.decideCurrentSync.bind(org.policy); let calls = 0;
    org.memory.readKnowledgeEvidence = async args => { if (++calls === 2) org.policy.decideCurrentSync = input => input.action === 'read' && input.target?.kind === '记忆' ? { verdict: 'deny', rule: 'isolated-late-memory-read', reason: CONTENT } : decide(input); return original(args); };
    const view = await query(); assert.ok(calls >= 2); assertUnknownSources(view, sources.length);
  }));

  it('处置读取结束后purge也能在frame结束检出，不能复用子调用的早收尾', async () => scene(async ({ org, many, declare, query, purge }) => {
    const sources = await many(1); await declare(sources); const original = org.memory.readFeedbackDispositions.bind(org.memory); let changed = false;
    org.memory.readFeedbackDispositions = async args => { const value = await original(args); if (!changed) { changed = true; await purge(sources[0].id); } return value; };
    assertUnknownSources(await query(), 1); assert.equal(changed, true);
  }));

  it('晚撤逐源entry read即失效，不只复核generic检索read', async () => scene(async ({ org, many, declare, query }) => {
    const sources = await many(1); await declare(sources); const original = org.memory.readFeedbackDispositions.bind(org.memory); const decide = org.policy.decideCurrentSync.bind(org.policy);
    org.memory.readFeedbackDispositions = async args => { const value = await original(args); org.policy.decideCurrentSync = input => input.action === 'read' && input.target?.kind === '知识' && input.context?.id === sources[0].id ? { verdict: 'deny', rule: 'isolated-entry-read', reason: CONTENT } : decide(input); return value; };
    assertUnknownSources(await query(), 1);
  }));

  it('晚撤替代知识read不能公开之前可见的新id，整组失效仍留本人声明', async () => scene(async ({ org, many, declare, query }) => {
    const sources = await many(1); const node = await declare(sources); const row = (await org.tasks.events({ 项目: P })).find(event => event.kind === 'submitted' && event.id === node.id);
    const replaced = await org.memory.overturn(sources[0].id, { subject: LEAD, 项目: P, 理由: '真实替代供读域核验', 新条目: '独立替代正文', 反馈引用: { 任务: node.id, 提交序: row.seq } });
    const original = org.memory.readFeedbackDispositions.bind(org.memory); const decide = org.policy.decideCurrentSync.bind(org.policy); let sawReplacement = false;
    org.memory.readFeedbackDispositions = async args => { const value = await original(args); sawReplacement ||= JSON.stringify([...value.values()]).includes(replaced.新条目); org.policy.decideCurrentSync = input => input.action === 'read' && input.target?.kind === '知识' && input.context?.id === replaced.新条目 ? { verdict: 'deny', rule: 'isolated-replacement-read', reason: CONTENT } : decide(input); return value; };
    const view = await query(); assert.equal(sawReplacement, true, '须先真正读到替代id再撤权'); assertUnknownSources(view, 1); assert.ok(!JSON.stringify(view).includes(replaced.新条目));
  }));

  it('无文件变化的请求内到期也整组失效，不混用前后批时间资格', async () => scene(async ({ f, org, base, setNow, many, declare, query }) => {
    const sources = await many(17, { 知识说明: { 复验期限: new Date(base + 1000).toISOString() } }); await declare(sources); const file = f.layout.memoryLog(P, '知识'); const bytes = await readFile(file, 'utf8'); const initialStat = await stat(file); const original = org.memory.readKnowledgeEvidence.bind(org.memory); let calls = 0;
    org.memory.readKnowledgeEvidence = async args => { if (++calls === 2) setNow(base + 1000); return original(args); };
    assertUnknownSources(await query(), sources.length); assert.equal(await readFile(file, 'utf8'), bytes); assert.equal((await stat(file)).mtimeMs, initialStat.mtimeMs);
  }));

  it('晚批撕裂源只使观察unknown，不把声明或分母洗成空记录', async () => scene(async ({ f, org, many, declare, query }) => {
    const sources = await many(); await declare(sources); const file = f.layout.memoryLog(P, '知识'); const original = org.memory.readKnowledgeEvidence.bind(org.memory); let calls = 0;
    org.memory.readKnowledgeEvidence = async args => { if (++calls === 2) await writeFile(file, (await readFile(file, 'utf8')).slice(0, -1), 'utf8'); return original(args); };
    const view = await query(); assertUnknownSources(view, sources.length); assert.equal(view.汇总.声明条目, sources.length); assert.equal(view.采用页.总数, 2);
  }));
});

describe('独立观察：frame生命周期和结构工作量', { timeout: 60_000 }, () => {
  it('callback异常原样抛且finally关闭reader，旧普通读取仍可独立工作', async () => scene(async ({ org, many, frame, evidence }) => {
    const sources = await many(1); let saved; const expected = new Error('isolated-callback-failure');
    await assert.rejects(() => frame(async reader => { saved = reader; await evidence(reader, [sources[0].id]); throw expected; }), error => error === expected);
    let escaped; try { escaped = await evidence(saved, [sources[0].id]); } catch { /* 关闭reader可以明确拒绝。 */ }
    assert.notEqual(escaped?.get(sources[0].id)?.状态, '可核来源版本');
    assert.equal((await org.memory.readKnowledgeEvidence({ subject: MEMBER, 项目: P, ids: [sources[0].id] })).get(sources[0].id).状态, '可核来源版本');
  }));

  it('reader固定主体与项目，正常完成后也不能带旧frame再读', async () => scene(async ({ knowledge, frame, evidence }) => {
    const source = await knowledge(); const foreign = await knowledge({ 项目: Q }); let saved;
    await frame(async reader => { let escaped; try { escaped = await reader.readKnowledgeEvidence({ subject: SOVEREIGN, 项目: Q, ids: [foreign.id] }); } catch { /* 不接受换域。 */ } assert.notEqual(escaped?.get(foreign.id)?.状态, '可核来源版本'); return null; });
    const result = await frame(async reader => { saved = reader; return (await evidence(reader, [source.id])).get(source.id); });
    assert.equal(result.有效, true); assert.equal(result.结果.状态, '可核来源版本'); let late; try { late = await evidence(saved, [source.id]); } catch { /* 不能复用完成reader。 */ } assert.notEqual(late?.get(source.id)?.状态, '可核来源版本');
  }));

  it('并发项目frame隔离，一边purge不会清空另一边稳定来源', async () => scene(async ({ org, knowledge, frame, evidence, purge }) => {
    const source = await knowledge(); const other = await knowledge({ 项目: Q }); const ready = deferred(); const release = deferred();
    const first = frame(async reader => { const value = await evidence(reader, [source.id]); ready.resolve(); await release.promise; return value; }); await ready.promise;
    const second = org.memory.withKnowledgeReadSnapshot({ subject: LEAD, 项目: Q }, reader => reader.readKnowledgeEvidence({ subject: LEAD, 项目: Q, ids: [other.id] }));
    await purge(source.id); release.resolve(); const [a, b] = await Promise.all([first, second]); assert.deepEqual(a, { 有效: false, 结果: null }); assert.equal(b.有效, true); assert.equal(b.结果.get(other.id).状态, '可核来源版本');
  }));

  it('初读没有的项目scope在callback间出现，结束不能只比已有文件字节', async () => scene(async ({ knowledge, frame, evidence }) => {
    let created; const result = await frame(async reader => { await evidence(reader, ['know-future-source']); created = await knowledge(); return evidence(reader, [created.id]); });
    assert.deepEqual(result, { 有效: false, 结果: null }); assert.ok(created.id);
  }));

  it('返回Map值被改写不污染frame，未跨资格边界的时间推进不误报漂移', async () => scene(async ({ base, setNow, many, frame, evidence }) => {
    const [source] = await many(1); const result = await frame(async reader => { const one = await evidence(reader, [source.id]); one.get(source.id).内容哈希 = 'a'.repeat(64); one.clear(); setNow(base + 500); return (await evidence(reader, [source.id])).get(source.id); });
    assert.equal(result.有效, true); assert.equal(result.结果.内容哈希, digest(CONTENT)); const next = await frame(reader => evidence(reader, [source.id])); assert.equal(next.有效, true); assert.equal(next.结果.get(source.id).内容哈希, digest(CONTENT));
  }));

  it('17知识与68负项每请求只初读/终比对各一次、逐行解析一次；下请求重新读', async t => scene(async ({ f, many, declare, query }) => {
    const sources = await many(); await declare(sources, 4); const tracked = new Set([f.layout.memoryLog(P, '知识'), f.layout.memoryLog(DIR.跨项目, '知识')].map(file => resolve(file))); const ids = new Set(sources.map(source => source.id)); const originalRead = fsPromises.readFile; const originalParse = JSON.parse; let reads = 0; let parses = 0;
    fsPromises.readFile = async (file, ...args) => { if (typeof file === 'string' && tracked.has(resolve(file))) reads++; return originalRead(file, ...args); };
    JSON.parse = (text, ...args) => { const value = originalParse(text, ...args); if (value && ids.has(value.id) && value.类 === '知识') parses++; return value; }; syncBuiltinESMExports();
    try {
      const first = await query(); assert.equal(first.汇总.声明条目, 68); assert.equal(first.处置汇总.未见关联处置, 68); assert.ok(reads <= tracked.size * 2, `首次知识文件read=${reads}，不应随批数增加`); assert.equal(parses, sources.length, '同一知识行每请求只解析一次');
      const firstReads = reads; const firstParses = parses; const second = await query(); assert.equal(second.数据版本, first.数据版本); assert.ok(reads > firstReads, '不能跨请求复用旧快照'); assert.ok(reads - firstReads <= tracked.size * 2); assert.equal(parses - firstParses, sources.length);
      t.diagnostic(JSON.stringify({ 知识: sources.length, 负项: 68, 知识账本: tracked.size, 首请求知识文件read: firstReads, 首请求知识行parse: firstParses, 次请求知识文件read: reads - firstReads, 次请求知识行parse: parses - firstParses }));
    } finally { fsPromises.readFile = originalRead; JSON.parse = originalParse; syncBuiltinESMExports(); }
  }));
});
