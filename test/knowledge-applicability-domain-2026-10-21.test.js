/** 作者声明的知识适用与复验边界：不自动判错、不追加状态，不绕现有可见性。 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { makeFixture, seedReviewRelation, LEAD, MEMBER, REVIEWER, SOVEREIGN } from './helpers.mjs';
import { MemoryService } from '../src/memory.js';
import { TaskGraph } from '../src/tasks.js';
import { normalizeKnowledgeContext, knowledgeReviewStatus } from '../src/knowledge-applicability.js';
import { memoryResponseOptions, memoryResponsePage, finalizeMemoryResponse, serializeMemoryEnvelope } from '../src/memory-response.js';
import { readJsonl } from '../src/kernel/fsx.js';
import { digest, canonical } from '../src/kernel/text.js';
import { Denied, InvalidBody } from '../src/kernel/errors.js';

const P = 'knowledge-applicability-domain';
async function scene(run) {
  const f = await makeFixture();
  let instant = f.clock.ms();
  f.clock._source = () => new Date(instant);
  const memory = new MemoryService(f);
  const tasks = new TaskGraph({ ...f, memory });
  memory.tasks = tasks;
  try {
    const remember = (extra = {}) => memory.remember({ subject: LEAD, 类: '知识', 项目: P, 内容: 'orbit 可复用方法', 来源: '经过独立测试', ...extra });
    const query = (extra = {}) => memory.query({ subject: LEAD, 读者: LEAD, 类: '知识', 项目: P, ...extra });
    const clock = { now: () => instant, set: (value) => { instant = typeof value === 'number' ? value : Date.parse(value); }, advance: (ms) => { instant += ms; }, iso: (ms = 0) => new Date(instant + ms).toISOString() };
    const accepted = async () => {
      const task = await tasks.create({ subject: LEAD, 项目: P, 描述: '已采纳来源', 负责人: LEAD.id, 判据: ['有独立可核对结果'] });
      await tasks.dispatch(task.id, { subject: LEAD, 项目: P }); await tasks.start(task.id, { subject: LEAD, 项目: P }); await tasks.submit(task.id, { subject: LEAD, 项目: P, 结论: '完成来源' });
      await seedReviewRelation(f, { 项目: P, 目标: task.id }); const review = await tasks.review(task.id, { subject: REVIEWER, 项目: P, 三态: '过' });
      await tasks.accept(task.id, { subject: LEAD, 项目: P, 票: review.待采纳.票 }); return task;
    };
    await run({ f, memory, tasks, remember, query, clock, accepted });
  } finally { await f.cleanup(); }
}

describe('知识说明纯合同', () => {
  it('可省略且不补空字段，说明严格clone与规范UTC期限', () => {
    assert.equal(normalizeKnowledgeContext(undefined), undefined);
    const input = { 适用条件: [' 原文保留 '], 已知反例: ['反例'], 复验条件: ['接口改变'], 复验期限: '2026-10-21T01:02:03.000Z' };
    const clone = normalizeKnowledgeContext(input); assert.deepEqual(clone, input); clone.适用条件[0] = 'changed'; assert.equal(input.适用条件[0], ' 原文保留 ');
    for (const value of [null, {}, [], { 适用条件: [] }, { 适用条件: [''] }, { 已知反例: null }, { 复验条件: Array(17).fill('x') }, { 适用条件: ['x'.repeat(513)] }, { 已验证: true }, { 复验期限: '2026-10-21T01:02:03+00:00' }, { 复验期限: '2026-02-31T01:02:03Z' }, { 复验期限: '2026-10-21T01:02Z' }, { 复验期限: 1792540800 }]) assert.throws(() => normalizeKnowledgeContext(value), (error) => error instanceof InvalidBody);
  });

  it('期限前/等于/后固定边界；旧知识无期限，坏说明不猜无期限', () => {
    const entry = { 类: '知识', 知识说明: { 复验期限: '2026-10-21T00:00:00Z' } }; const at = Date.parse(entry.知识说明.复验期限);
    assert.equal(knowledgeReviewStatus(entry, at - 1), '期限内'); assert.equal(knowledgeReviewStatus(entry, at), '待复验'); assert.equal(knowledgeReviewStatus(entry, at + 1), '待复验');
    assert.equal(knowledgeReviewStatus({ 类: '知识' }, at), '未设期限'); assert.equal(knowledgeReviewStatus({ 类: '知识', 知识说明: { 适用条件: ['前提'] } }, at), '未设期限');
    for (const bad of [null, {}, { 复验期限: 'bad' }, { 复验期限: null }, { 已验证: true }]) assert.equal(knowledgeReviewStatus({ 类: '知识', 知识说明: bad }, at), '说明不可判');
    assert.equal(knowledgeReviewStatus(entry, new Date(NaN)), '说明不可判'); assert.equal(knowledgeReviewStatus({ 类: '经历' }, at), null);
  });
});

describe('知识适用、到期召回及读数', () => {
  it('到期只改派生读面，无状态追加；浏览、搜索和id默认同源排除', async () => scene(async ({ f, memory, remember, query, clock }) => {
    const deadline = clock.iso(1000); const row = await remember({ 知识说明: { 复验期限: deadline, 适用条件: ['只有前提一致时'] } });
    const raw = await readFile(row.账本, 'utf8');
    for (const params of [{}, { 文本: 'orbit' }, { id: row.id }]) { const before = await query(params); assert.equal(before.条目[0].复验状态, '期限内'); }
    clock.advance(1000);
    for (const params of [{}, { 文本: 'orbit' }, { id: row.id }]) { const after = await query(params); assert.deepEqual(after.条目, []); assert.equal(after.口径.待复验条目数, 1); assert.equal(after.口径.排除待复验, 1); assert.equal(after.口径.可召回数, 0); assert.equal(after.口径.条目数, 1); }
    const explicit = await query({ id: row.id, 含待复验: true }); assert.equal(explicit.条目[0].复验状态, '待复验'); assert.equal(explicit.条目[0].状态, '有效'); assert.match(explicit.条目[0].复验警示, /不代表.*失效/);
    assert.equal(await readFile(row.账本, 'utf8'), raw); assert.deepEqual((await memory.readKnowledgeEvidence({ subject: LEAD, 项目: P, ids: [row.id] })).get(row.id), { 状态: '来源未核验' });
    void f;
  }));

  it('无文件变化的跨期使索引和续页版本失效，同期跨秒仍稳定', async () => scene(async ({ remember, query, clock }) => {
    await remember({ 知识说明: { 复验期限: clock.iso(5000) } }); await remember({ 内容: 'orbit 旧知识仍可用' });
    const first = await query({ 文本: 'orbit', limit: 1 }); assert.equal(first.口径.文档数, 2);
    clock.advance(1000);
    const same = await query({ 文本: 'orbit', limit: 1, 偏移: 1, 数据版本: first.数据版本 }); assert.equal(same.数据版本, first.数据版本);
    clock.advance(4000);
    await assert.rejects(() => query({ 文本: 'orbit', limit: 1, 偏移: 1, 数据版本: first.数据版本 }), (error) => error instanceof InvalidBody);
    const after = await query({ 文本: 'orbit' }); assert.equal(after.口径.文档数, 1); assert.equal(after.命中.length, 1); assert.notEqual(after.数据版本, first.数据版本);
  }));

  it('含失效与含待复验为交集，false/真值字符串不能绕新筛选', async () => scene(async ({ memory, remember, query, clock }) => {
    const row = await remember({ 知识说明: { 复验期限: clock.iso(-1000) } }); await memory.invalidate(row.id, { subject: LEAD, 原因: '独立证据否定' });
    for (const params of [{}, { 含失效: true }, { 含待复验: true }]) assert.equal((await query(params)).条目.length, 0);
    const both = await query({ 含失效: true, 含待复验: true }); assert.equal(both.条目.length, 1); assert.equal(both.口径.排除失效, 0); assert.equal(both.口径.排除待复验, 0);
    for (const value of [null, 'true', 'false', 1, {}, []]) await assert.rejects(() => query({ 含待复验: value }), (error) => error instanceof InvalidBody);
  }));

  it('无期限旧知识继续召回但有警示；说明不属于非知识类且不添空元数据', async () => scene(async ({ memory, remember, query }) => {
    const row = await remember(); const raw = await readJsonl(row.账本); assert.equal(Object.hasOwn(raw[0], '知识说明'), false);
    const result = await query({ id: row.id, 返回模式: '摘要' }); assert.equal(result.条目[0].复验状态, '未设期限'); assert.match(result.条目[0].复验警示, /不等于永远有效/); assert.equal(Object.hasOwn(result.条目[0], '知识说明'), false);
    for (const kind of ['经历', '偏好', '作答']) await assert.rejects(() => memory.remember({ subject: LEAD, 类: kind, 项目: P, 内容: '非知识', 来源: '测试', 知识说明: { 适用条件: ['不允许挂这里'] } }), (error) => error instanceof InvalidBody);
  }));

  it('坏已存说明默认不推荐，显式只显示安全标记，不返未知对象或伪造验证字段', async () => scene(async ({ memory, remember, query }) => {
    const row = await remember(); const raw = await readJsonl(row.账本); raw[0].知识说明 = { 复验期限: 'bad', 自报验证: 'private-injected-metadata' }; await writeFile(row.账本, raw.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    const normal = await query(); assert.equal(normal.条目.length, 0); assert.equal(normal.口径.说明不可判数, 1); assert.equal(normal.口径.排除说明不可判, 1);
    const history = await query({ 含待复验: true }); assert.equal(history.条目[0].复验状态, '说明不可判'); assert.equal(Object.hasOwn(history.条目[0], '知识说明'), false); assert.doesNotMatch(JSON.stringify(history), /private-injected/);
    assert.deepEqual((await memory.readKnowledgeEvidence({ subject: LEAD, 项目: P, ids: [row.id] })).get(row.id), { 状态: '来源未核验' });
  }));

  it('新说明在首await前克隆，来源hash不抄派生now且旧hash算法保持', async () => scene(async ({ memory, remember, query, clock }) => {
    const input = { subject: LEAD, 类: '知识', 项目: P, 内容: 'clone内容', 来源: '测试', 知识说明: { 适用条件: ['原始条件'], 复验期限: clock.iso(60000) } };
    const pending = memory.remember(input); input.知识说明.适用条件[0] = 'changed'; input.知识说明.复验期限 = clock.iso(-1000);
    const row = await pending; const entry = (await query({ id: row.id })).条目[0]; assert.equal(entry.知识说明.适用条件[0], '原始条件'); assert.equal(entry.复验状态, '期限内');
    const evidence = (await memory.readKnowledgeEvidence({ subject: LEAD, 项目: P, ids: [row.id] })).get(row.id); clock.advance(1000);
    const later = (await memory.readKnowledgeEvidence({ subject: LEAD, 项目: P, ids: [row.id] })).get(row.id); assert.equal(later.元数据哈希, evidence.元数据哈希);
    const legacy = await remember(); const original = (await query({ id: legacy.id })).条目[0]; const meta = Object.fromEntries(['id', '类', '标题', '来源', '来源引用', '派生自', '归属', '项目', '岗位', '标签', '状态', '历史', '记于'].map((key) => [key, original[key] ?? null]));
    assert.equal((await memory.readKnowledgeEvidence({ subject: LEAD, 项目: P, ids: [legacy.id] })).get(legacy.id).元数据哈希, digest(canonical(meta)));
  }));

  it('最终候选分页分母正确，期限跨越对所有类别查询同样生效', async () => scene(async ({ memory, remember, query, clock }) => {
    for (let i = 0; i < 3; i += 1) await remember({ 内容: `orbit due-${i}`, 知识说明: { 复验期限: clock.iso(-1) } });
    for (let i = 0; i < 3; i += 1) await remember({ 内容: `orbit current-${i}` });
    const first = await query({ 条数上限: 1 }); assert.equal(first.条目总数, 3); assert.equal(first.口径.条目数, 6); assert.equal(first.口径.可召回数, 3); assert.equal(first.下一偏移, 1);
    const second = await query({ 条数上限: 1, 偏移: 1, 数据版本: first.数据版本 }); assert.notEqual(second.条目[0].id, first.条目[0].id);
    const allKinds = await memory.query({ subject: LEAD, 项目: P, 读者: LEAD }); assert.equal(allKinds.条目总数, 3); assert.equal(allKinds.口径.待复验条目数, 3);
  }));

  it('显式待复验不能扩大项目或复核读域，也不把非命中正文混进搜索', async () => scene(async ({ memory, remember, query, clock }) => {
    const wanted = await remember({ 来源引用: ['artifact-in-scope'], 知识说明: { 复验期限: clock.iso(-1) } });
    await remember({ 内容: 'private-unrelated', 来源引用: ['artifact-out-scope'], 知识说明: { 复验期限: clock.iso(-1) } });
    const restricted = await query({ 含待复验: true, 文本: 'orbit', 读域: { 限定: true, 项目: P, 集合: new Set(['artifact-in-scope']), 说明: '仅本次显式对象' } });
    assert.deepEqual(restricted.条目.map((entry) => entry.id), [wanted.id]); assert.equal(restricted.口径.条目数, 1); assert.equal(restricted.口径.待复验条目数, 1);
    assert.equal((await memory.query({ subject: LEAD, 项目: 'other-project', 类: '知识', 含待复验: true })).条目.length, 0);
  }));

  it('摘要与512预算fallback仍保留复验警示，说明原文计入预算并标元数据截断', async () => scene(async ({ remember, query, clock }) => {
    const context = { 适用条件: Array(16).fill('前'.repeat(512)), 复验期限: clock.iso(-1000) };
    const row = await remember({ 内容: 'body'.repeat(1000), 知识说明: context });
    for (const 返回模式 of ['摘要', '全文']) {
      const result = await query({ id: row.id, 含待复验: true, 返回模式, 内容预算: 512 }); const entry = result.条目[0];
      assert.equal(entry.复验状态, '待复验'); assert.match(entry.复验警示, /需复验/); assert.equal(entry.元数据截断, true); assert.ok(result.内容已用 <= 512);
      assert.equal(JSON.stringify({ 命中: result.命中, 条目: result.条目 }).length, result.内容已用);
    }
  }));

  it('大预算可读全合法大说明，仅分页长正文；元数据能容纳时不永久丢失适用条件', async () => scene(async ({ remember, query, clock }) => {
    const context = { 适用条件: Array(16).fill('前'.repeat(512)), 已知反例: Array(16).fill('反'.repeat(512)), 复验条件: Array(16).fill('验'.repeat(512)), 复验期限: clock.iso(60000) };
    const body = '正文'.repeat(16000); const row = await remember({ 内容: body, 知识说明: context });
    const first = await query({ id: row.id, 返回模式: '全文', 内容预算: 32000 }); const entry = first.条目[0];
    assert.deepEqual(entry.知识说明, context); assert.notEqual(entry.元数据截断, true); assert.equal(entry.正文截断, true); assert.ok(entry.内容.length > 0); assert.ok(first.内容已用 <= 32000);
    const next = await query({ id: row.id, 返回模式: '全文', 内容预算: 32000, 正文偏移: first.下一正文偏移, 数据版本: first.数据版本 });
    assert.deepEqual(next.条目[0].知识说明, context); assert.equal(next.条目[0].正文偏移, entry.内容.length);
    assert.equal(entry.内容 + next.条目[0].内容, body.slice(0, entry.内容.length + next.条目[0].内容.length));
    const summary = await query({ id: row.id, 返回模式: '摘要', 内容预算: 32000 }); assert.deepEqual(summary.条目[0].知识说明, context);
  }));

  it('三个说明数组进入通用/跨项目披露闸，未检查尾部拒绝，Lead显式豁免仍留原字段', async () => scene(async ({ memory, remember, query }) => {
    for (const field of ['适用条件', '已知反例', '复验条件']) await assert.rejects(() => remember({ 项目: '通用', 知识说明: { [field]: ['联系 someone@example.com'] } }), (error) => error instanceof Denied && /披露/.test(error.rule));
    const large = { 适用条件: Array(16).fill('前'.repeat(512)), 已知反例: Array(16).fill('反'.repeat(512)), 复验条件: [...Array(15).fill('验'.repeat(512)), '尾部 someone@example.com'] };
    await assert.rejects(() => remember({ 项目: '通用', 知识说明: large }), (error) => error instanceof Denied && /未全检/.test(error.rule));
    const row = await remember({ 知识说明: { 适用条件: ['联系 someone@example.com'] } });
    await assert.rejects(() => memory.promoteCrossProject(row.id, { subject: LEAD, 岗位: '插件工程', 理由: '尝试扩散' }), (error) => error instanceof Denied);
    await memory.promoteCrossProject(row.id, { subject: LEAD, 岗位: '插件工程', 理由: '已核对可披露', 披露豁免: true });
    const copy = (await query({ id: row.id })).条目[0]; assert.equal(copy.知识说明.适用条件[0], '联系 someone@example.com');
  }));

  it('受限晋升幂等比较说明对象内容，缺省重试兼容，换期限或条件同key明确冲突', async () => scene(async ({ memory, accepted, query, clock }) => {
    const task = await accepted(); const spec = { subject: LEAD, 项目: P, 岗位: '插件工程', 内容: '已采纳后蒸馏', 晋升: { 来源任务: task.id, 候选键: 'candidate-1' } };
    const legacy = await memory.promoteFromAdopted(spec); assert.equal((await memory.promoteFromAdopted({ ...spec, 知识说明: undefined })).id, legacy.id);
    const context = { 适用条件: ['条件A'], 复验期限: clock.iso(60000) }; const fresh = { ...spec, 晋升: { ...spec.晋升, 候选键: 'candidate-2' }, 知识说明: context };
    const row = await memory.promoteFromAdopted(fresh); assert.equal((await memory.promoteFromAdopted({ ...fresh, 知识说明: { 复验期限: context.复验期限, 适用条件: ['条件A'] } })).id, row.id);
    for (const 知识说明 of [{ ...context, 复验期限: clock.iso(120000) }, { ...context, 适用条件: ['条件B'] }, undefined]) await assert.rejects(() => memory.promoteFromAdopted({ ...fresh, 知识说明 }), (error) => error instanceof Denied && /幂等/.test(error.rule));
    assert.deepEqual((await query({ id: row.id })).条目[0].知识说明, context);
  }));

  it('overturn新替代条目不继承旧条件，可显式给新说明而不写进状态行/审计', async () => scene(async ({ f, memory, remember, query, clock }) => {
    const unique = 'private-old-condition-to-delete'; const row = await remember({ 知识说明: { 适用条件: [unique], 复验期限: clock.iso(-1) } });
    const replacement = await memory.overturn(row.id, { subject: LEAD, 新条目: '替代知识', 理由: '旧结论已有反例' });
    const next = (await query({ id: replacement.新条目 })).条目[0]; assert.equal(next.复验状态, '未设期限'); assert.equal(Object.hasOwn(next, '知识说明'), false);
    const another = await memory.overturn(replacement.新条目, { subject: LEAD, 新条目: '再次替代', 理由: '适用边界变化', 知识说明: { 适用条件: ['新条件'] } });
    assert.deepEqual((await query({ id: another.新条目 })).条目[0].知识说明.适用条件, ['新条件']);
    const stateRows = (await readJsonl(row.账本)).filter((entry) => Object.hasOwn(entry, '追加')); assert.equal(JSON.stringify(stateRows).includes(unique), false); assert.equal(JSON.stringify(await f.audit.readVerified()).includes(unique), false);
  }));

  it('purge从源和跨项目副本整行删除说明，审计不复制条件原文', async () => scene(async ({ f, memory, remember }) => {
    const marker = 'condition-private-full-delete'; const row = await remember({ 知识说明: { 已知反例: [marker] } });
    await memory.promoteCrossProject(row.id, { subject: LEAD, 岗位: '插件工程', 理由: '允许跨项目复用' });
    const cross = f.layout.memoryLog('跨项目', '知识'); assert.match(await readFile(cross, 'utf8'), new RegExp(marker));
    await memory.purge(row.id, { subject: SOVEREIGN, 理由: '按用户要求完整清除' });
    assert.equal((await readFile(row.账本, 'utf8')).includes(marker), false); assert.equal((await readFile(cross, 'utf8')).includes(marker), false); assert.equal(JSON.stringify(await f.audit.readVerified()).includes(marker), false);
  }));
});

it('最终信封再次裁元数据仍保留复验状态与警示，不被超长口径覆盖', () => {
  const entry = { id: 'know-large', 内容: '文'.repeat(31000), 状态: '有效', 复验状态: '待复验', 复验警示: '需复验，不代表失效。', 知识说明: { 适用条件: ['前'.repeat(10000)] }, 来源: '元'.repeat(10000) };
  const page = memoryResponsePage({ entries: [entry], total: 1, options: memoryResponseOptions({ 内容预算: 32000 }) });
  const result = finalizeMemoryResponse({ ...page, 口径: { 查询词: '词'.repeat(30000) }, 说明: '说'.repeat(30000) });
  const serialized = serializeMemoryEnvelope({ 成功: true, 结果: result }, 8); const decoded = JSON.parse(serialized).结果;
  assert.ok(serialized.length <= 40000); assert.equal(decoded.条目[0].复验状态, '待复验'); assert.match(decoded.条目[0].复验警示, /需复验/);
});
