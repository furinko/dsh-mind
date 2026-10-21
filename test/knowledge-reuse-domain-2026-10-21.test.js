/** 知识采用声明保持逐次历史，当前可读来源只核版本，不认证声明语义。 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { makeFixture, seedReviewRelation, LEAD, MEMBER, REVIEWER, SOVEREIGN } from './helpers.mjs';
import { Org } from '../src/org.js';
import { KnowledgeReuseService } from '../src/knowledge-reuse.js';
import { normalizeKnowledgeAdoption, validateStoredKnowledgeAdoption, validateKnowledgeEvidenceSource } from '../src/knowledge-reuse-contract.js';
import { readTaskLedger } from '../src/task-ledger.js';
import { atomicWrite } from '../src/kernel/fsx.js';
import { digest } from '../src/kernel/text.js';
import { Denied, Fault, InvalidBody } from '../src/kernel/errors.js';

const P = 'knowledge-reuse-domain';
const item = (id, extra = {}) => ({ id, 用途: '采用已验证方法', 适用判断: '前提和边界与本任务一致', 使用结果: '有帮助', ...extra });
const source = (extra = {}) => ({ 状态: '可核来源版本', 内容哈希: 'a'.repeat(64), 元数据哈希: 'b'.repeat(64), 捕获于: '2026-10-21T00:00:00Z', ...extra });
const wrapper = (entries) => ({ 版本: 1, 声明状态: entries.length ? '已声明' : '显式空', 条目: entries.map((entry) => ({ ...entry, 来源: source() })) });
async function scene(run) {
  const f = await makeFixture();
  try {
    const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
    const reuse = org.knowledgeReuse;
    const make = (extra = {}) => new KnowledgeReuseService({ layout: org.layout, policy: org.policy, registry: org.registry, memory: org.memory, ...extra });
    let serial = 0;
    const create = async (extra = {}) => {
      const task = await org.tasks.create({ subject: LEAD, 项目: P, 描述: `知识采用任务${++serial}`, 负责人: LEAD.id, 判据: ['可核对的交付结果'], ...extra });
      await org.tasks.dispatch(task.id, { subject: LEAD, 项目: P });
      await org.tasks.start(task.id, { subject: LEAD, 项目: P });
      return task;
    };
    const submit = (task, adoption = undefined, extra = {}) => org.tasks.submit(task.id, { subject: LEAD, 项目: P, 结论: '提交独立结果', ...(adoption === undefined ? {} : { 采用知识: adoption }), ...extra });
    const remember = (extra = {}) => org.memory.remember({ subject: LEAD, 类: '知识', 项目: P, 内容: '真实知识完整正文', 来源: { 谁: LEAD.id, 怎么知道: '通过独立检验' }, ...extra });
    const accept = async (task) => {
      await seedReviewRelation(f, { 项目: P, 目标: task.id });
      const reviewed = await org.tasks.review(task.id, { subject: REVIEWER, 项目: P, 三态: '过' });
      return org.tasks.accept(task.id, { subject: LEAD, 项目: P, 票: reviewed.待采纳.票 });
    };
    const query = (extra = {}) => reuse.query({ subject: LEAD, 项目: P, ...extra });
    const file = org.layout.taskLog(P);
    const rows = () => readTaskLedger(file);
    const replaceRows = (values) => writeFile(file, values.map((row) => JSON.stringify(row)).join('\n') + '\n');
    await run({ f, org, reuse, make, create, submit, remember, accept, query, file, rows, replaceRows });
  } finally { await f.cleanup(); }
}

describe('知识采用纯合同', () => {
  it('省略、显式空和声明分开；克隆不裁短、去重、强转或改写文本', () => {
    assert.equal(normalizeKnowledgeAdoption(undefined), undefined);
    assert.deepEqual(normalizeKnowledgeAdoption([]), []);
    const raw = [item('knowledge-1', { 用途: ' 原文保留 ', 说明: '' })];
    const normalized = normalizeKnowledgeAdoption(raw);
    assert.deepEqual(normalized, raw); assert.notEqual(normalized, raw); assert.notEqual(normalized[0], raw[0]);
    normalized[0].用途 = 'modified'; assert.equal(raw[0].用途, ' 原文保留 ');
    assert.deepEqual(validateStoredKnowledgeAdoption(wrapper([])), { 版本: 1, 声明状态: '显式空', 条目: [] });
  });

  it('null、重复id、超量、未知键、伪造来源/身份与无效文本明确拒绝', () => {
    for (const value of [null, '[]', {}, [item('same'), item('same')], Array.from({ length: 17 }, (_, index) => item(`k-${index}`)), [item('k', { 用途: 'x'.repeat(513) })], [item('k', { 适用判断: '' })], [item('k', { 使用结果: '证明正确' })], [item('k', { 说明: 'x'.repeat(1025) })], [item(' k')], [item('k', { 来源: source() })], [item('k', { subject: LEAD })], [item('k', { 内容哈希: 'a'.repeat(64) })]]) assert.throws(() => normalizeKnowledgeAdoption(value), (error) => error instanceof InvalidBody);
  });

  it('存储只接受版本1的精确来源封套，状态须与条目一致且不补历史', () => {
    const good = wrapper([item('k')]); assert.deepEqual(validateStoredKnowledgeAdoption(good), good);
    for (const value of [undefined, null, { ...good, 版本: 2 }, { ...good, 声明状态: '显式空' }, { ...good, 自报: true }, { ...good, 条目: [item('k')] }, { ...good, 条目: [{ ...item('k'), 来源: { ...source(), 正文: 'private' } }] }, { ...good, 条目: [{ ...item('k'), 来源: source({ 捕获于: 'today' }) }] }]) assert.throws(() => validateStoredKnowledgeAdoption(value), (error) => error instanceof InvalidBody);
    assert.deepEqual(validateKnowledgeEvidenceSource({ 状态: '来源未核验' }), { 状态: '来源未核验' });
    assert.throws(() => validateKnowledgeEvidenceSource({ 状态: '来源未核验', 内容哈希: 'a'.repeat(64) }), (error) => error instanceof InvalidBody);
    assert.throws(() => validateKnowledgeEvidenceSource(source({ 捕获于: '2026-02-31T00:00:00Z' })), (error) => error instanceof InvalidBody);
  });
});

describe('知识复用逐交卷历史与当前来源', () => {
  it('真实交卷区分省略/显式空/有声明；长正文取全内容hash而非记忆查询摘要', async () => scene(async ({ create, submit, remember, query, rows }) => {
    const content = '独立验证知识正文'.repeat(2000); const knowledge = await remember({ 内容: content });
    const a = await create(); await submit(a);
    const b = await create(); await submit(b, []);
    const c = await create(); await submit(c, [item(knowledge.id)]);
    const result = await query();
    assert.deepEqual(result.汇总, { 交卷记录: 3, 未说明: 1, 显式空: 1, 有声明: 1, 声明条目: 1, 有帮助声明: 1, 不适用声明: 0, 问题声明: 0, 来源可核: 1, 关联采纳交卷: 0 });
    const adopted = result.采用页.条目.find((row) => row.任务 === c.id).采用知识[0];
    assert.equal(adopted.来源.内容哈希, digest(content)); assert.equal(adopted.当前来源, '同一观察版本');
    assert.equal(Object.hasOwn(adopted, '正文'), false); assert.equal(JSON.stringify(result).includes(content.slice(0, 500)), false);
    const submitted = (await rows()).filter((row) => row.kind === 'submitted');
    assert.equal(Object.hasOwn(submitted[0], '采用知识'), false); assert.equal(submitted[0].代, 1);
    assert.equal(submitted[1].采用知识.声明状态, '显式空'); assert.equal(submitted[2].采用知识.版本, 1);
    assert.equal(result.完整, false);
  }));

  it('未知知识或来源故障仍保存声明但不能伪报可核；无采纳不当作失败', async () => scene(async ({ create, submit, query, org, rows }) => {
    const task = await create();
    const evidence = org.memory.readKnowledgeEvidence.bind(org.memory);
    org.memory.readKnowledgeEvidence = async () => { throw new Error('private source error'); };
    await submit(task, [item('unknown-knowledge', { 使用结果: '未知' })]);
    org.memory.readKnowledgeEvidence = evidence;
    const result = await query(); const record = result.采用页.条目[0];
    assert.deepEqual(record.采用知识[0].来源, { 状态: '来源未核验' });
    assert.equal(result.汇总.有帮助声明, 0); assert.equal(result.汇总.关联采纳交卷, 0);
    assert.equal((await rows()).at(-1).采用知识.条目[0].使用结果, '未知');
  }));

  it('同人复交每次保留声明，只关联当前代最后一次真实采纳交卷', async () => scene(async ({ create, submit, remember, accept, query }) => {
    const knowledge = await remember(); const task = await create();
    await submit(task, [item(knowledge.id, { 使用结果: '不适用' })]);
    await submit(task, [item(knowledge.id, { 使用结果: '有帮助' })]);
    await accept(task);
    const records = (await query({ 任务: task.id })).采用页.条目;
    assert.equal(records.length, 2); assert.equal(records[0].关联采纳.length, 1); assert.equal(records[1].关联采纳.length, 0);
    assert.equal(records[0].采用知识[0].使用结果, '有帮助'); assert.equal(records[1].采用知识[0].使用结果, '不适用');
    assert.equal(records[0].关联采纳[0].代, 1);
  }));

  it('返工关闭代，旧票拒绝；第二代只关联新声明，第一代不洗成已采纳', async () => scene(async ({ f, org, create, submit, remember, query, accept }) => {
    const knowledge = await remember(); const task = await create(); await submit(task, [item(knowledge.id, { 使用结果: '发现问题' })]);
    await seedReviewRelation(f, { 项目: P, 目标: task.id });
    const oldReview = await org.tasks.review(task.id, { subject: REVIEWER, 项目: P, 三态: '过' });
    await org.tasks.reject(task.id, { subject: LEAD, 项目: P, 理由: '发现新反例，重做' });
    await org.tasks.start(task.id, { subject: LEAD, 项目: P }); await submit(task, [item(knowledge.id)]);
    await assert.rejects(() => org.tasks.accept(task.id, { subject: LEAD, 项目: P, 票: oldReview.待采纳.票 }), (error) => error instanceof Denied);
    await accept(task);
    const records = (await query()).采用页.条目;
    assert.equal(records.find((row) => row.代 === 1).关联采纳.length, 0);
    assert.equal(records.find((row) => row.代 === 2).关联采纳.length, 1);
    assert.equal(records.find((row) => row.代 === 1).采用知识[0].使用结果, '发现问题');
  }));

  it('正式后继不继承采用声明或采纳关系，历史源独立保留', async () => scene(async ({ org, create, submit, remember, query, accept }) => {
    const knowledge = await remember(); const task = await create(); await submit(task, [item(knowledge.id)]);
    await org.tasks.close(task.id, { subject: LEAD, 项目: P, 原因: '换人接续原判据' });
    const successor = await org.tasks.createSuccessor(task.id, { subject: LEAD, 项目: P, 负责人: LEAD.id, 原因: '新执行轮次' });
    const next = successor.节点;
    await org.tasks.dispatch(next.id, { subject: LEAD, 项目: P }); await org.tasks.start(next.id, { subject: LEAD, 项目: P }); await submit(next, []); await accept(next);
    const result = await query();
    assert.equal(result.采用页.条目.find((row) => row.任务 === task.id).关联采纳.length, 0);
    assert.equal(result.采用页.条目.find((row) => row.任务 === next.id).声明状态, '显式空');
    assert.equal((await query({ 知识id: knowledge.id })).采用页.总数, 1);
  }));

  it('旧submitted缺代保持null/未知；不能从当前答案或后续采纳反推历史代', async () => scene(async ({ create, submit, accept, query, rows, replaceRows }) => {
    const task = await create(); await submit(task); await accept(task);
    const raw = await rows(); delete raw.find((row) => row.kind === 'submitted').代; await replaceRows(raw);
    const record = (await query()).采用页.条目[0];
    assert.equal(record.代, null); assert.equal(record.声明状态, '未知'); assert.equal(record.关联采纳.length, 0);
  }));

  it('当前正文/元数据版本变化与捕获未核验明确区分，历史封套保持不变', async () => scene(async ({ org, create, submit, remember, query, rows }) => {
    const knowledge = await remember(); const task = await create(); await submit(task, [item(knowledge.id)]);
    const stored = (await rows()).at(-1).采用知识;
    const original = await query();
    await org.memory.demote(knowledge.id, { subject: LEAD, 理由: '当前降低优先级' });
    const changed = await query(); const itemView = changed.采用页.条目[0].采用知识[0];
    assert.equal(itemView.当前来源, '版本已变'); assert.equal(itemView.来源.内容哈希, stored.条目[0].来源.内容哈希);
    assert.notEqual(itemView.当前版本.元数据哈希, stored.条目[0].来源.元数据哈希); assert.notEqual(changed.数据版本, original.数据版本);
    const next = await create();
    const oldEvidence = org.memory.readKnowledgeEvidence.bind(org.memory); org.memory.readKnowledgeEvidence = async ({ ids }) => new Map(ids.map((id) => [id, { 状态: '来源未核验' }]));
    await submit(next, [item(knowledge.id)]); org.memory.readKnowledgeEvidence = oldEvidence;
    assert.equal((await query({ 任务: next.id })).采用页.条目[0].采用知识[0].当前来源, '捕获未核验');
  }));

  it('当前源失效/权限收紧时剥历史hash，不经来源失败泄露旧版本', async () => scene(async ({ f, org, create, submit, remember, query }) => {
    const knowledge = await remember(); const task = await create(); await submit(task, [item(knowledge.id)]);
    const good = await query(); const oldHash = good.采用页.条目[0].采用知识[0].来源.内容哈希;
    const matrix = '集体L1-法律/权限矩阵.md'; const raw = await readFile(f.layout.factory(matrix), 'utf8');
    await f.write(matrix, raw + '\n```policy\n' + JSON.stringify({ grants: [{ subject: 'Lead', action: 'read', kind: '记忆', verdict: 'deny', reason: '记忆来源读域收紧' }] }) + '\n```\n');
    const deniedSource = await query(); const itemView = deniedSource.采用页.条目[0].采用知识[0];
    assert.deepEqual(itemView.来源, { 状态: '来源未核验' }); assert.equal(Object.hasOwn(itemView, '当前版本'), false); assert.equal(JSON.stringify(deniedSource).includes(oldHash), false);
    assert.notEqual(deniedSource.数据版本, good.数据版本);
    await f.write(matrix, raw); await org.policy.refreshIfStale(); await org.memory.invalidate(knowledge.id, { subject: LEAD, 理由: '真实证据推翻来源' });
    assert.deepEqual((await query()).采用页.条目[0].采用知识[0].来源, { 状态: '来源未核验' });
  }));

  it('治理读须真实当前Lead卡，成员/复核员/假Lead/停岗均不泄露历史', async () => scene(async ({ f, create, submit, query, reuse }) => {
    const task = await create(); await submit(task, []);
    for (const subject of [MEMBER, REVIEWER, { id: MEMBER.id, kind: 'Lead' }, { id: 'ghost', kind: 'Lead' }, { ...LEAD, roleId: 'wrong' }]) await assert.rejects(() => query({ subject }), (error) => error instanceof Denied);
    assert.equal((await query({ subject: SOVEREIGN })).汇总.交卷记录, 1);
    const identityFile = f.layout.identityFile(); const saved = await readFile(identityFile, 'utf8'); const identity = JSON.parse(saved); identity.members.lead.卡版本 = null; await writeFile(identityFile, JSON.stringify(identity));
    await assert.rejects(() => query(), (error) => error instanceof Denied); assert.equal(await reuse.summaryFor({ subject: LEAD, 项目: P }), null);
    await writeFile(identityFile, saved); await f.registry.seal({ subject: SOVEREIGN, 实例: LEAD.id, 理由: '当前治理读主体封存' });
    await assert.rejects(() => query(), (error) => error instanceof Denied);
  }));

  it('任务读判定先于知识过滤；当前读禁止不能靠知识id与分页探出记录', async () => scene(async ({ f, create, submit, remember, query, reuse }) => {
    const knowledge = await remember(); const task = await create(); await submit(task, [item(knowledge.id)]);
    const matrix = '集体L1-法律/权限矩阵.md'; const raw = await readFile(f.layout.factory(matrix), 'utf8');
    await f.write(matrix, raw + '\n```policy\n' + JSON.stringify({ grants: [{ subject: 'Lead', action: 'read', kind: '任务', verdict: 'deny', reason: '任务读域全部收紧' }] }) + '\n```\n');
    assert.equal((await query({ 知识id: knowledge.id, 条数: 1 })).采用页.总数, 0);
    await assert.rejects(() => query({ 任务: task.id, 知识id: knowledge.id }), (error) => error instanceof Denied);
    await f.write(matrix, raw + '\n```policy\n' + JSON.stringify({ grants: [{ subject: 'Lead', action: 'read', kind: '知识复用', verdict: 'deny', reason: '治理读面收紧' }] }) + '\n```\n');
    await assert.rejects(() => query(), (error) => error instanceof Denied); assert.equal(await reuse.summaryFor({ subject: LEAD, 项目: P }), null);
  }));

  it('纯摘要不造事实/审计，坏账有权读者看到不可用而非0或无权', async () => scene(async ({ org, reuse, create, submit, rows, file }) => {
    const task = await create(); await submit(task, []); const before = await rows(); const audit = await org.audit.readVerified();
    assert.equal((await reuse.summaryFor({ subject: LEAD, 项目: P })).汇总.显式空, 1);
    assert.equal((await reuse.summary(P)).汇总.显式空, 1);
    assert.deepEqual(await rows(), before); assert.deepEqual(await org.audit.readVerified(), audit);
    await writeFile(file, (await readFile(file, 'utf8')) + '{bad}\n');
    const bad = await reuse.summaryFor({ subject: LEAD, 项目: P }); assert.equal(bad.健康, '不可用'); assert.equal(bad.汇总.交卷记录, null);
    assert.equal((await reuse.summary(P)).汇总.未说明, null);
  }));

  it('分页汇总基于完整最终集，显式空/未知在知识过滤时不命中', async () => scene(async ({ create, submit, remember, query }) => {
    const knowledge = await remember();
    for (const use of [undefined, [], [item(knowledge.id)], [item(knowledge.id, { 使用结果: '发现问题' })]]) { const task = await create(); await submit(task, use); }
    const page = await query({ 条数: 1 }); assert.equal(page.采用页.总数, 4); assert.equal(page.汇总.交卷记录, 4); assert.equal(page.采用页.hasMore, true); assert.equal(page.采用页.下一偏移, 1);
    const next = await query({ 条数: 1, 偏移: page.采用页.下一偏移, 数据版本: page.数据版本 });
    assert.equal(next.数据版本, page.数据版本); assert.notEqual(next.采用页.条目[0].提交序, page.采用页.条目[0].提交序);
    const filtered = await query({ 知识id: knowledge.id, 条数: 1 }); assert.equal(filtered.汇总.交卷记录, 2); assert.equal(filtered.汇总.未说明, 0); assert.equal(filtered.汇总.问题声明, 1);
  }));

  it('响应硬预算按实际条目续页，完整文本被截部分变化也会使版本失效', async () => scene(async ({ create, submit, query, rows, replaceRows }) => {
    const many = Array.from({ length: 16 }, (_, index) => item(`knowledge-${index}`, { 用途: '用'.repeat(512), 适用判断: '判'.repeat(512), 说明: '说'.repeat(1024) }));
    for (let i = 0; i < 6; i += 1) { const task = await create(); await submit(task, many); }
    const page = await query({ 条数: 50 });
    assert.ok(JSON.stringify(page).length <= 40000); assert.ok(page.采用页.实际返回条目数 > 0); assert.ok(page.采用页.实际返回条目数 < 6); assert.equal(page.采用页.hasMore, true);
    const adopted = page.采用页.条目[0].采用知识[0]; assert.equal(adopted.用途.length, 160); assert.deepEqual(adopted.字段截断, ['用途', '适用判断', '说明']);
    const next = await query({ 条数: 50, 偏移: page.采用页.下一偏移, 数据版本: page.数据版本 });
    assert.notEqual(next.采用页.条目[0].提交序, page.采用页.条目.at(-1).提交序);
    const raw = await rows(); raw.find((row) => row.kind === 'submitted').采用知识.条目[0].说明 = '说'.repeat(1023) + '变'; await replaceRows(raw);
    await assert.rejects(() => query({ 偏移: page.采用页.下一偏移, 数据版本: page.数据版本 }), (error) => error instanceof Denied && /版本/.test(error.rule));
  }));

  it('新来源核验分批<=16且不调用正文query，不可用或恶意来源统一未核验', async () => scene(async ({ make, create, submit, remember, query }) => {
    const ids = [];
    for (let i = 0; i < 2; i += 1) { const task = await create(); const items = Array.from({ length: 16 }, (_, index) => item(`k-${i}-${index}`)); ids.push(...items.map((entry) => entry.id)); await submit(task, items); }
    const calls = [];
    const service = make({ memory: { readKnowledgeEvidence: async (spec) => { calls.push(spec.ids); return new Map(spec.ids.map((id) => [id, { ...source(), 正文: 'private' }])); }, query: () => { throw new Error('must not query正文'); } } });
    const result = await service.query({ subject: LEAD, 项目: P });
    assert.equal(calls.length, 2); assert.equal(calls.flat().length, ids.length); assert.equal(result.汇总.来源可核, 0);
    assert.deepEqual(result.采用页.条目[0].采用知识[0].来源, { 状态: '来源未核验' });
    void remember; void query;
  }));

  for (const corruption of ['json', 'torn', 'null', 'version', 'source', 'generation', 'extra']) it(`损坏交卷${corruption}拒读取/续写，摘要不能假零`, async () => scene(async ({ reuse, create, submit, query, rows, replaceRows, file }) => {
    const task = await create(); await submit(task, [item('unknown-knowledge')]);
    const raw = await rows(); const row = raw.find((value) => value.kind === 'submitted');
    if (corruption === 'null') row.采用知识 = null;
    if (corruption === 'version') row.采用知识.版本 = 99;
    if (corruption === 'source') row.采用知识.条目[0].来源.内容哈希 = 'forged';
    if (corruption === 'generation') delete row.代;
    if (corruption === 'extra') row.采用知识.条目[0].subject = LEAD;
    if (corruption === 'json') await writeFile(file, raw.map((value) => JSON.stringify(value)).join('\n') + '\n{bad}\n');
    else if (corruption === 'torn') await writeFile(file, raw.map((value) => JSON.stringify(value)).join('\n'));
    else await replaceRows(raw);
    await assert.rejects(() => query(), (error) => error instanceof Fault && error.code === 'TASK_LEDGER_INVALID');
    const bad = await reuse.summaryFor({ subject: LEAD, 项目: P }); assert.equal(bad.健康, '不可用'); assert.equal(bad.汇总.交卷记录, null);
    await assert.rejects(() => submit(task, []), (error) => error instanceof Fault);
  }));

  it('参数严格且无造数/身份写入口，空账是有界空观察不承诺完整知识效用', async () => scene(async ({ query }) => {
    const empty = await query(); assert.equal(empty.汇总.交卷记录, 0); assert.equal(empty.汇总.未说明, 0); assert.equal(empty.完整, false); assert.equal(empty.采用页.hasMore, false);
    for (const extra of [{ 条数: 51 }, { 偏移: -1 }, { 偏移: 1 }, { 数据版本: null }, { 知识id: '' }, { 来源: source() }, { 采用知识: [] }, { 认证: '真实' }, { 读域: '全部' }, { 任务: 'missing-task' }]) await assert.rejects(() => query(extra), (error) => error instanceof InvalidBody);
  }));

  it('直接写入旧票或缺依据的accepted不能洗成知识采纳，前缀合法采纳仍为正控', async () => scene(async ({ f, org, create, submit, query, rows, replaceRows }) => {
    const task = await create(); await submit(task, [item('knowledge-1')]);
    await seedReviewRelation(f, { 项目: P, 目标: task.id });
    const review = await org.tasks.review(task.id, { subject: REVIEWER, 项目: P, 三态: '过' });
    const original = await rows(); const manifest = original.filter((row) => row.kind === 'submitted').at(-1).交付物清单.摘要;
    const accepted = { seq: original.at(-1).seq + 1, at: org.clock.iso(), by: LEAD, kind: 'accepted', id: task.id, 状态: '已采纳', 代: 1, 依据: '复核结论', 票: review.待采纳.票, 豁免: null, 交付物摘要: manifest };
    for (const patch of [{ 票: 'rv-1' }, { 依据: 'unknown' }, { by: MEMBER }, { 交付物摘要: 'f'.repeat(64) }, { 代: 2 }]) { await replaceRows([...original, { ...accepted, ...patch }]); assert.equal((await query()).汇总.关联采纳交卷, 0); }
    await replaceRows(original); await org.tasks.accept(task.id, { subject: LEAD, 项目: P, 票: review.待采纳.票 });
    assert.equal((await query()).汇总.关联采纳交卷, 1);
  }));

  it('本代合法免审关联历史采纳，之后关闭全局开关不重写旧事实', async () => scene(async ({ f, org, create, submit, query }) => {
    await atomicWrite(org.layout.deploymentPrefs(), JSON.stringify({ 复核免审: true }));
    await org.policy.reload();
    const task = await create(); await submit(task, [item('knowledge-1')]);
    await org.tasks.exemptReview(task.id, { subject: LEAD, 项目: P, 原因: '主权者设置全局免审，按合同登记本代' });
    await org.tasks.accept(task.id, { subject: LEAD, 项目: P });
    assert.equal((await query()).汇总.关联采纳交卷, 1);
    await atomicWrite(org.layout.deploymentPrefs(), JSON.stringify({ 复核免审: false })); await org.policy.reload();
    assert.equal((await query()).汇总.关联采纳交卷, 1);
  }));

  it('有明确代和内容摘要的旧复核需Lead确认，正规确认后才关联', async () => scene(async ({ f, org, create, submit, query, rows, replaceRows }) => {
    const task = await create(); await submit(task, [item('knowledge-1')]); await seedReviewRelation(f, { 项目: P, 目标: task.id });
    await org.tasks.review(task.id, { subject: REVIEWER, 项目: P, 三态: '过' });
    const historical = await rows(); historical.filter((row) => row.kind === 'reviewed').at(-1).状态 = '已采纳'; await replaceRows(historical);
    assert.equal((await query()).汇总.关联采纳交卷, 0);
    await org.tasks.accept(task.id, { subject: LEAD, 项目: P });
    assert.equal((await query()).汇总.关联采纳交卷, 1);
  }));
});
