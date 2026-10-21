/** 单请求内部读能力：共享观察不改变旧方法资格，也不成为写凭据。 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fsPromises, { readFile, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { makeFixture, LEAD, MEMBER, SOVEREIGN } from './helpers.mjs';
import { Org } from '../src/org.js';
import { digest } from '../src/kernel/text.js';
import { InvalidBody } from '../src/kernel/errors.js';

const P = 'knowledge-observation-domain';
const fp = 'a'.repeat(64);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function scene(run) {
  const f = await makeFixture();
  try {
    const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
    const memory = org.memory;
    const knowledge = extra => memory.remember({ subject: LEAD, 类: '知识', 项目: P, 内容: 'knowledge-observation-private-body', 来源: '隔离域验证', ...extra });
    const frame = callback => memory.withKnowledgeReadSnapshot({ subject: LEAD, 项目: P }, callback);
    const evidence = (reader, ids) => reader.readKnowledgeEvidence({ subject: LEAD, 项目: P, ids });
    const disposition = (reader, id) => reader.readFeedbackDispositions({ subject: LEAD, 项目: P, items: [{ 知识id: id, 反馈指纹: fp }] });
    await run({ f, org, memory, knowledge, frame, evidence, disposition });
  } finally { await f.cleanup(); }
}

describe('知识读帧领域合同', () => {
  it('稳定来源与旧单方法同hash，处置明零且不写业务或审计', async () => scene(async ({ org, memory, knowledge, frame, evidence, disposition }) => {
    const source = await knowledge(); const file = source.账本;
    const before = await readFile(file, 'utf8'); const audit = await org.audit.readVerified();
    const old = (await memory.readKnowledgeEvidence({ subject: LEAD, 项目: P, ids: [source.id] })).get(source.id);
    const result = await frame(async reader => ({ source: (await evidence(reader, [source.id])).get(source.id), feedback: (await disposition(reader, source.id)).get(fp) }));
    assert.equal(result.有效, true); assert.equal(result.结果.source.内容哈希, old.内容哈希); assert.equal(result.结果.source.元数据哈希, old.元数据哈希);
    assert.deepEqual(result.结果.feedback, { 状态: '可核对', 记录: [], 总数: 0, 截断: false });
    assert.equal(await readFile(file, 'utf8'), before); assert.deepEqual(await org.audit.readVerified(), audit);
    assert.ok(!JSON.stringify(result).includes('knowledge-observation-private-body'));
  }));

  it('无观察回调懒加载，不读取知识文件', async () => scene(async ({ memory, frame }) => {
    const original = fsPromises.readFile; let reads = 0;
    fsPromises.readFile = async (file, ...args) => { if (typeof file === 'string' && file.endsWith('知识.jsonl')) reads++; return original(file, ...args); }; syncBuiltinESMExports();
    try { assert.deepEqual(await frame(async () => 'no-observation'), { 有效: true, 结果: 'no-observation' }); assert.equal(reads, 0); }
    finally { fsPromises.readFile = original; syncBuiltinESMExports(); }
    assert.equal(typeof memory.withKnowledgeReadSnapshot, 'function');
  }));

  it('每个旧方法仍限16项，不能借frame扩批', async () => scene(async ({ memory, frame, evidence }) => {
    await assert.rejects(() => memory.readKnowledgeEvidence({ subject: LEAD, 项目: P, ids: Array.from({ length: 17 }, (_, i) => `id-${i}`) }), error => error instanceof InvalidBody);
    const result = await frame(async reader => { await assert.rejects(() => evidence(reader, Array.from({ length: 17 }, (_, i) => `id-${i}`)), error => error instanceof InvalidBody); return 'caught'; });
    assert.deepEqual(result, { 有效: false, 结果: null });
  }));

  it('成员旧来源观察兼容，治理读帧不能用成员冒充Lead', async () => scene(async ({ memory, knowledge }) => {
    const source = await knowledge();
    assert.equal((await memory.readKnowledgeEvidence({ subject: MEMBER, 项目: P, ids: [source.id] })).get(source.id).状态, '可核来源版本');
    const result = await memory.withKnowledgeReadSnapshot({ subject: MEMBER, 项目: P }, reader => reader.readKnowledgeEvidence({ subject: MEMBER, 项目: P, ids: [source.id] }));
    assert.deepEqual(result, { 有效: false, 结果: null });
  }));

  it('未知主体即使未观察也不能得到有效治理读帧', async () => scene(async ({ memory }) => {
    assert.deepEqual(await memory.withKnowledgeReadSnapshot({ subject: { id: MEMBER.id, kind: 'Lead' }, 项目: P }, async () => 0), { 有效: false, 结果: null });
  }));

  it('仍经公开旧方法override，观察故障被捕获后也整组失效', async () => scene(async ({ memory, knowledge, frame, evidence, disposition }) => {
    const source = await knowledge(); let called = false;
    memory.readFeedbackDispositions = async () => { called = true; throw new Error('observer-fault-seam'); };
    const result = await frame(async reader => { const early = await evidence(reader, [source.id]); await assert.rejects(() => disposition(reader, source.id), /observer-fault-seam/); return early; });
    assert.equal(called, true); assert.deepEqual(result, { 有效: false, 结果: null });
  }));

  it('override完全绕过原方法不能凭伪造Map取得有效观察', async () => scene(async ({ memory, knowledge, frame, evidence }) => {
    const source = await knowledge();
    memory.readKnowledgeEvidence = async () => new Map([[source.id, { 状态: '可核来源版本', 内容哈希: fp, 元数据哈希: fp, 捕获于: '2026-10-21T00:00:00Z' }]]);
    assert.deepEqual(await frame(reader => evidence(reader, [source.id])), { 有效: false, 结果: null });
  }));

  it('业务回调异常原对象传播，异常后reader不可复用', async () => scene(async ({ knowledge, frame, evidence }) => {
    const source = await knowledge(); const expected = new Error('business-callback'); let escaped;
    await assert.rejects(() => frame(async reader => { escaped = reader; await evidence(reader, [source.id]); throw expected; }), error => error === expected);
    await assert.rejects(() => evidence(escaped, [source.id]), error => error instanceof InvalidBody);
  }));

  it('回调未等待的迟到observer结果在读帧关闭后拒绝', async () => scene(async ({ memory, knowledge, frame, evidence }) => {
    const source = await knowledge(); const entered = deferred(), release = deferred(); const original = memory.readKnowledgeEvidence.bind(memory); let pending;
    memory.readKnowledgeEvidence = async args => { const value = await original(args); entered.resolve(); await release.promise; return value; };
    const result = await frame(async reader => { pending = evidence(reader, [source.id]).then(() => 'unexpected', error => error); await entered.promise; return 'callback-finished'; });
    assert.equal(result.结果, 'callback-finished'); release.resolve(); assert.ok(await pending instanceof InvalidBody);
  }));

  it('源观察与处置观察保留各自旧格式资格，不扩大坏私有proof读面', async () => scene(async ({ memory, knowledge, frame, evidence, disposition }) => {
    const source = await knowledge();
    await writeFile(source.账本, (await readFile(source.账本, 'utf8')) + JSON.stringify({ id: 'legacy-cold', 指向: source.id, 追加: '降权', 追于: 'legacy-time', 反馈关联: { 版本: 999 } }) + '\n');
    assert.equal((await memory.readKnowledgeEvidence({ subject: LEAD, 项目: P, ids: [source.id] })).get(source.id).状态, '可核来源版本');
    const onlyEvidence = await frame(reader => evidence(reader, [source.id])); assert.equal(onlyEvidence.有效, true); assert.equal(onlyEvidence.结果.get(source.id).状态, '可核来源版本');
    assert.deepEqual((await memory.readFeedbackDispositions({ subject: LEAD, 项目: P, items: [{ 知识id: source.id, 反馈指纹: fp }] })).get(fp), { 状态: '不可核对', 记录: [], 总数: null, 截断: null });
    assert.deepEqual(await frame(reader => disposition(reader, source.id)), { 有效: false, 结果: null });
  }));

  it('坏JSON与撕裂不能当空知识或未见处置', async () => scene(async ({ knowledge, frame, evidence, disposition }) => {
    const source = await knowledge(); const text = await readFile(source.账本, 'utf8');
    for (const bad of [text + '{broken}\n', text.slice(0, -1)]) {
      await writeFile(source.账本, bad);
      assert.deepEqual(await frame(reader => evidence(reader, [source.id])), { 有效: false, 结果: null });
      assert.deepEqual(await frame(reader => disposition(reader, source.id)), { 有效: false, 结果: null });
    }
  }));

  it('到期源不签版本但仍可核对历史处置，固定时间不误作删除', async () => scene(async ({ org, knowledge, frame, evidence, disposition }) => {
    const now = Math.floor(Date.now() / 1000) * 1000; org.clock._source = () => new Date(now);
    const source = await knowledge({ 知识说明: { 复验期限: new Date(now).toISOString() } });
    const result = await frame(async reader => ({ source: (await evidence(reader, [source.id])).get(source.id), feedback: (await disposition(reader, source.id)).get(fp) }));
    assert.equal(result.有效, true); assert.deepEqual(result.结果.source, { 状态: '来源未核验' }); assert.equal(result.结果.feedback.状态, '可核对'); assert.equal(result.结果.feedback.总数, 0);
  }));

  it('准备时快照主体克隆，调用者改原对象不能改变读能力', async () => scene(async ({ memory, knowledge }) => {
    const source = await knowledge(); const actor = { ...LEAD };
    const result = await memory.withKnowledgeReadSnapshot({ subject: actor, 项目: P }, async reader => { actor.id = 'ghost'; return reader.readKnowledgeEvidence({ subject: LEAD, 项目: P, ids: [source.id] }); });
    assert.equal(result.有效, true); assert.equal(result.结果.get(source.id).状态, '可核来源版本');
  }));

  it('当前Lead真实封存使整帧失效，主权者仍可开启独立新读帧', async () => scene(async ({ org, memory, knowledge, frame, evidence }) => {
    const source = await knowledge();
    const result = await frame(async reader => { const first = await evidence(reader, [source.id]); await org.registry.seal({ subject: SOVEREIGN, 实例: LEAD.id, 理由: '读期间封存' }); return first; });
    assert.deepEqual(result, { 有效: false, 结果: null });
    const sovereign = await memory.withKnowledgeReadSnapshot({ subject: SOVEREIGN, 项目: P }, reader => reader.readKnowledgeEvidence({ subject: SOVEREIGN, 项目: P, ids: [source.id] })); assert.equal(sovereign.有效, true);
  }));

  it('下次请求读取新字节，不把上次版本当跨请求缓存', async () => scene(async ({ knowledge, frame, evidence }) => {
    const source = await knowledge(); const first = await frame(reader => evidence(reader, [source.id]));
    const rows = (await readFile(source.账本, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line)); rows[0].内容 = 'changed-between-requests'; await writeFile(source.账本, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const second = await frame(reader => evidence(reader, [source.id])); assert.equal(second.有效, true); assert.notEqual(second.结果.get(source.id).内容哈希, first.结果.get(source.id).内容哈希); assert.equal(second.结果.get(source.id).内容哈希, digest('changed-between-requests'));
  }));
});
