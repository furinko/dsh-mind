/** 独立负反馈关联反例：真实任务/记忆/审批，不把观察到处置当成纠错成功。 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { makeFixture, LEAD, MEMBER, SOVEREIGN } from './helpers.mjs';
import { Org } from '../src/org.js';
import { fold as foldMemory } from '../src/memory.js';
import { runAction } from '../lib/actions.js';
import { readTextOrNull } from '../src/kernel/fsx.js';
import { Denied, InvalidBody, NeedsApproval, Fault } from '../src/kernel/errors.js';

const P = 'knowledge-feedback-independent-adversarial';
const Q = `${P}-other`;
const PRIVATE = 'PRIVATE_FEEDBACK_STATEMENT_NOT_PUBLIC_HISTORY';
const BODY = 'PRIVATE_KNOWLEDGE_BODY_NOT_FEEDBACK_RECEIPT';
const adoption = (id, extra = {}) => ({ id, 用途: '当前任务核对', 适用判断: '本人判断，未经系统认证', 使用结果: '发现问题', 说明: PRIVATE, ...extra });
const rejection = error => error instanceof InvalidBody || error instanceof Denied || error instanceof Fault;

async function scene(run) {
  const f = await makeFixture();
  try {
    const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
    const knowledge = (extra = {}) => org.memory.remember({ subject: LEAD, 类: '知识', 项目: P, 内容: BODY, 来源: '隔离作者陈述', ...extra });
    const task = async () => {
      const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '负反馈引用独立验收', 负责人: MEMBER.roleId, 判据: ['原提交可追溯'] });
      await org.tasks.bind(node.id, { subject: LEAD, 项目: P, 实例: MEMBER.id, 岗位: MEMBER.roleId });
      await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P }); await org.tasks.start(node.id, { subject: MEMBER, 项目: P }); return node;
    };
    const rows = () => org.tasks.events({ 项目: P });
    const rewrite = entries => writeFile(f.layout.taskLog(P), entries.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
    const submit = async (node, declarations) => {
      await org.tasks.submit(node.id, { subject: MEMBER, 项目: P, ...(declarations === undefined ? {} : { 采用知识: declarations }) });
      return (await rows()).filter(row => row.kind === 'submitted' && row.id === node.id).at(-1);
    };
    const reference = row => ({ 任务: row.id, 提交序: row.seq });
    const act = (args, subject = LEAD) => runAction({ org, 项目: P, subject, 主体: subject, 面: 'tool', args });
    const dispose = (id, 反馈引用, extra = {}, subject = LEAD) => act({ action: 'memory_lifecycle', op: 'invalidate', id, 原因: '显式核对负反馈后处置', ...(反馈引用 === undefined ? {} : { 反馈引用 }), ...extra }, subject);
    const query = (extra = {}) => org.knowledgeReuse.query({ subject: LEAD, 项目: P, ...extra });
    const log = () => readTextOrNull(f.layout.memoryLog(P, '知识'));
    const prepare = (id, 反馈引用, op = 'invalidate', extra = {}) => org.memory.prepareFeedbackReference(id, { subject: LEAD, 项目: P, op, 反馈引用, ...extra });
    const approval = async () => { await f.write('集体L2-共享基础设施/defaults/介入度.json', JSON.stringify({ 介入度: '审批' })); await org.policy.reload(); };
    const approve = async args => {
      let request; await assert.rejects(() => act(args), error => error instanceof NeedsApproval && Boolean(request = error.detail.请求id));
      await org.intervention.人侧决议({ 请求id: request, 决定: '批准', 通道: '设置页', 认证: '宿主Connection已认证' }); return request;
    };
    await run({ f, org, knowledge, task, rows, rewrite, submit, reference, act, dispose, query, log, prepare, approval, approve });
  } finally { await f.cleanup(); }
}

function itemAt(view, seq, id) { return view.采用页.条目.find(record => record.提交序 === seq).采用知识.find(item => item.id === id); }

describe('独立负反馈：精确原提交与现行资格', { timeout: 60_000 }, () => {
  it('三种真实处置只关联显式负反馈，原声明和采纳统计不改成纠错成功', async () => scene(async ({ knowledge, task, submit, reference, dispose, query, log }) => {
    const node = await task(); const sources = await Promise.all([knowledge(), knowledge(), knowledge()]);
    const row = await submit(node, sources.map(source => adoption(source.id))); const ref = reference(row);
    await dispose(sources[0].id, ref); await dispose(sources[1].id, ref, { op: 'demote' }, SOVEREIGN); await dispose(sources[2].id, ref, { op: 'overturn', 新条目: '明确新主张，不声明纠错已经成功' });
    const view = await query(); assert.equal(view.处置汇总.负反馈条目, 3); assert.equal(view.处置汇总.已见关联处置, 3);
    assert.deepEqual(sources.map(source => itemAt(view, row.seq, source.id).反馈处置.记录[0].动作), ['失效', '降权', '替代']);
    for (const source of sources) { const item = itemAt(view, row.seq, source.id); assert.equal(item.使用结果, '发现问题'); assert.equal(item.反馈处置.状态, '已见关联处置'); assert.equal(item.反馈处置.总数, 1); }
    assert.ok(!(await log()).includes(PRIVATE)); assert.ok(!JSON.stringify(view.处置汇总).includes('成功'));
  }));

  it('引用形状和自报指纹先于审批请求拒绝，普通旧处置仍兼容', async () => scene(async ({ org, knowledge, task, submit, reference, dispose, act, log, approval }) => {
    const source = await knowledge(); const node = await task(); const row = await submit(node, [adoption(source.id)]); const ref = reference(row); await approval();
    const before = await log(); const requests = await org.intervention.投影({ 项目: P });
    for (const value of [null, {}, [], { ...ref, 提交序: String(ref.提交序) }, { ...ref, 提交序: 0 }, { ...ref, 指纹: 'a'.repeat(64) }, { ...ref, 摘要: PRIVATE }, { ...ref, 主体: MEMBER.id }]) {
      await assert.rejects(() => dispose(source.id, value), rejection); assert.equal(await log(), before); assert.deepEqual(await org.intervention.投影({ 项目: P }), requests);
    }
    for (const key of ['反馈关联', '执行计划', '反馈执行计划', '已处理', '反馈指纹']) await assert.rejects(() => act({ action: 'memory_lifecycle', op: 'invalidate', id: source.id, 原因: '不能自签', [key]: 'a'.repeat(64) }), rejection);
  }));

  it('全账重复seq和缺失显式seq不能借另一任务或legacy行号绑定', async () => scene(async ({ knowledge, task, submit, reference, rows, rewrite, prepare, log }) => {
    const source = await knowledge(); const node = await task(); const row = await submit(node, [adoption(source.id)]); const original = await rows(); const before = await log();
    const duplicated = structuredClone(original); duplicated.find(event => event.kind === 'created').seq = row.seq;
    const missing = structuredClone(original); delete missing.find(event => event.kind === 'submitted').seq;
    for (const entries of [duplicated, missing]) { await rewrite(entries); await assert.rejects(() => prepare(source.id, reference(row)), rejection); assert.equal(await log(), before); }
    await rewrite(original);
  }));

  it('缺代、错误代、无封套、显式空及非负反馈都不能制造关联状态', async () => scene(async ({ knowledge, task, submit, reference, rows, rewrite, prepare, log }) => {
    const source = await knowledge(); const node = await task(); const row = await submit(node, [adoption(source.id)]); const original = await rows(); const before = await log();
    const variants = [event => { delete event.代; }, event => { event.代 += 1; }, event => { delete event.采用知识; }, event => { event.采用知识 = { 版本: 1, 声明状态: '显式空', 条目: [] }; }, ...['有帮助', '未知'].map(result => event => { event.采用知识.条目[0].使用结果 = result; })];
    for (const alter of variants) { const entries = structuredClone(original); alter(entries.find(event => event.kind === 'submitted')); await rewrite(entries); await assert.rejects(() => prepare(source.id, reference(row)), rejection); assert.equal(await log(), before); }
    await rewrite(original);
  }));

  it('另一知识、另一任务及跨项目引用均拒；真实不适用声明可处置', async () => scene(async ({ org, knowledge, task, submit, reference, prepare, dispose, query, log }) => {
    const source = await knowledge(); const other = await knowledge(); const node = await task(); const foreignNode = await task(); const row = await submit(node, [adoption(source.id, { 使用结果: '不适用' })]); const before = await log();
    await assert.rejects(() => prepare(other.id, reference(row)), rejection);
    await assert.rejects(() => prepare(source.id, { ...reference(row), 任务: foreignNode.id }), rejection);
    await assert.rejects(() => org.memory.prepareFeedbackReference(source.id, { subject: LEAD, 项目: Q, op: 'invalidate', 反馈引用: reference(row) }), rejection);
    assert.equal(await log(), before); await dispose(source.id, reference(row)); assert.equal(itemAt(await query(), row.seq, source.id).反馈处置.状态, '已见关联处置');
  }));

  it('返工后旧本代反馈仍能显式处置，后续空声明不会洗掉原引用', async () => scene(async ({ org, knowledge, task, submit, reference, dispose, query }) => {
    const source = await knowledge(); const node = await task(); const old = await submit(node, [adoption(source.id)]);
    await org.tasks.review(node.id, { subject: LEAD, 项目: P, 三态: '不过', 分歧清单: ['返工不抹除旧负反馈'] }); await org.tasks.start(node.id, { subject: MEMBER, 项目: P }); const next = await submit(node, []); assert.equal(next.代, 2);
    await dispose(source.id, reference(old)); const view = await query(); assert.equal(itemAt(view, old.seq, source.id).反馈处置.状态, '已见关联处置'); assert.deepEqual(view.采用页.条目.find(record => record.提交序 === next.seq).采用知识, []);
  }));

  it('知识可读不能替代当前task read；普通成员、假Lead和封存Lead不能附引用写', async () => scene(async ({ org, knowledge, task, submit, reference, dispose, log }) => {
    const source = await knowledge(); const node = await task(); const row = await submit(node, [adoption(source.id)]); const ref = reference(row); const before = await log();
    for (const subject of [MEMBER, { id: MEMBER.id, kind: 'Lead' }]) await assert.rejects(() => dispose(source.id, ref, {}, subject), rejection);
    const decide = org.policy.decideCurrentSync.bind(org.policy); org.policy.decideCurrentSync = input => input.action === 'read' && input.target?.kind === '任务' && input.target.id === node.id ? { verdict: 'deny', rule: 'isolated-task-read', reason: PRIVATE } : decide(input);
    await assert.rejects(() => dispose(source.id, ref), rejection); assert.equal(await log(), before); org.policy.decideCurrentSync = decide;
    await org.registry.seal({ subject: SOVEREIGN, 实例: LEAD.id, 理由: '真实撤销治理资格' }); await assert.rejects(() => dispose(source.id, ref), rejection); assert.equal(await log(), before);
  }));
});

describe('独立负反馈：审批和提交点', { timeout: 60_000 }, () => {
  it('品牌计划不可在原交卷原文变化后续写，且计划不是可复制授权', async () => scene(async ({ org, knowledge, task, submit, reference, rows, rewrite, prepare, log }) => {
    const source = await knowledge(); const node = await task(); const row = await submit(node, [adoption(source.id)]); const 原因 = '固定原因核品牌与原文'; const plan = await prepare(source.id, reference(row), 'invalidate', { 原因 }); const before = await log();
    const spec = { subject: LEAD, 项目: P, 原因, 反馈引用: reference(row) };
    await assert.rejects(() => org.memory.invalidate(source.id, { ...spec, 反馈执行计划: structuredClone(plan.执行计划) }), rejection); assert.equal(await log(), before);
    const entries = await rows(); entries.find(event => event.kind === 'submitted').采用知识.条目[0].说明 = '后来改变原始声明'; await rewrite(entries);
    await assert.rejects(() => org.memory.invalidate(source.id, { ...spec, 反馈执行计划: plan.执行计划 }), rejection); assert.equal(await log(), before);
  }));

  it('审批等待原文漂移会拒旧批准，零关联写入而非重新绑定新声明', async () => scene(async ({ knowledge, task, submit, reference, rows, rewrite, approval, approve, act, log }) => {
    const source = await knowledge(); const node = await task(); const row = await submit(node, [adoption(source.id)]); await approval();
    const args = { action: 'memory_lifecycle', op: 'invalidate', id: source.id, 原因: '等待批准时来源不能漂移', 反馈引用: reference(row) }; const request = await approve(args); const before = await log();
    const entries = await rows(); entries.find(event => event.kind === 'submitted').采用知识.条目[0].用途 = '批准后替换用途'; await rewrite(entries);
    await assert.rejects(() => act({ ...args, 审批引用: request }), rejection); assert.equal(await log(), before);
  }));

  it('提交点purge竞态不能在已删除源上追加幽灵关联', async () => scene(async ({ org, knowledge, task, submit, reference, prepare, log }) => {
    const source = await knowledge(); const node = await task(); const row = await submit(node, [adoption(source.id)]); const ref = reference(row); const 原因 = '不能写入已删除源'; const plan = await prepare(source.id, ref, 'invalidate', { 原因 });
    const check = org.policy.check.bind(org.policy); let purged = false;
    org.policy.check = async input => { const result = await check(input); if (!purged && input.action === 'write' && input.target?.kind === '知识') { purged = true; await org.memory.purge(source.id, { subject: SOVEREIGN, 理由: '精确提交窗口删除', 敏感: true }); } return result; };
    await assert.rejects(() => org.memory.invalidate(source.id, { subject: LEAD, 项目: P, 原因, 反馈引用: ref, 反馈执行计划: plan.执行计划 }), rejection);
    assert.equal(purged, true, '夹具必须真正进入write通过后的窗口'); assert.ok(!(await log()).includes('反馈关联'));
  }));

  it('overturn替代create被拒时原状态和关联也零写入，保留同锁双行合同', async () => scene(async ({ org, knowledge, task, submit, reference, dispose, log }) => {
    const source = await knowledge(); const node = await task(); const row = await submit(node, [adoption(source.id)]); const before = await log(); const check = org.policy.check.bind(org.policy); let refused = false;
    org.policy.check = async input => { if (input.action === 'create' && input.target?.kind === '知识') { refused = true; throw new Denied('isolated-overturn-create', '原子替代前拒绝'); } return check(input); };
    await assert.rejects(() => dispose(source.id, reference(row), { op: 'overturn', 新条目: '不能半提交的新主张' }), rejection); assert.equal(refused, true); assert.equal(await log(), before);
  }));
});

describe('独立负反馈：私有关联和受限观察', { timeout: 60_000 }, () => {
  it('私有proof只在原始state，普通全文/血缘/动作/审计和fold都剥除它', async () => scene(async ({ org, knowledge, task, submit, reference, dispose, act, log }) => {
    const source = await knowledge(); const node = await task(); const row = await submit(node, [adoption(source.id)]); const result = await dispose(source.id, reference(row)); const raw = (await log()).trim().split('\n').map(JSON.parse); const state = raw.find(event => event.反馈关联); const hash = state.反馈关联.指纹;
    assert.match(hash, /^[a-f0-9]{64}$/); assert.deepEqual(Object.keys(state.反馈关联).sort(), ['指纹', '版本']); assert.ok(!JSON.stringify(state).includes(node.id)); assert.ok(!JSON.stringify(state).includes(PRIVATE));
    const publicReads = [result, await act({ action: 'memory_query', id: source.id, 类: '知识', 含失效: true, 返回模式: '全文' }), await act({ action: 'memory_lineage', id: source.id }), await org.audit.read({})];
    for (const value of publicReads) { assert.ok(!JSON.stringify(value).includes(hash)); assert.ok(!JSON.stringify(value).includes('反馈关联')); }
    const polluted = structuredClone(raw); polluted[0].反馈关联 = state.反馈关联; polluted[0].历史 = [{ ...state }];
    assert.ok(!JSON.stringify(foldMemory(polluted)).includes(hash)); assert.ok(!JSON.stringify(foldMemory(polluted)).includes('反馈关联'));
  }));

  it('invalid及已过期限仍可核处置，不能把默认来源未核验误报为没处理', async () => scene(async ({ org, knowledge, task, submit, reference, dispose, query }) => {
    const source = await knowledge({ 知识说明: { 复验期限: '2020-01-01T00:00:00Z' } }); const node = await task(); const row = await submit(node, [adoption(source.id)]); await dispose(source.id, reference(row));
    assert.deepEqual((await org.memory.readKnowledgeEvidence({ subject: LEAD, 项目: P, ids: [source.id] })).get(source.id), { 状态: '来源未核验' });
    const item = itemAt(await query(), row.seq, source.id); assert.deepEqual(item.来源, { 状态: '来源未核验' }); assert.equal(item.反馈处置.状态, '已见关联处置'); assert.equal(item.反馈处置.总数, 1);
  }));

  it('坏JSON/撕裂/未知状态统一不可核对，不跳坏行伪报未处理', async () => scene(async ({ f, knowledge, task, submit, reference, dispose, query, log }) => {
    const source = await knowledge(); const node = await task(); const row = await submit(node, [adoption(source.id)]); await dispose(source.id, reference(row)); const original = await log(); const file = f.layout.memoryLog(P, '知识');
    for (const text of [original + '{broken\n', original.slice(0, -1), original + JSON.stringify({ id: 'unknown', 指向: source.id, 追加: 'unknown', 追于: '2026-10-21T12:00:00Z' }) + '\n']) {
      await writeFile(file, text, 'utf8'); const view = await query(); const item = itemAt(view, row.seq, source.id); assert.equal(item.反馈处置.状态, '不可核对'); assert.equal(item.反馈处置.总数, null); assert.deepEqual(item.反馈处置.记录, []); assert.equal(view.处置汇总.处置不可核对, 1);
    }
    await writeFile(file, original, 'utf8');
  }));

  it('purge与当前来源read拒绝同样匿名不可核对，声明保留但无私有hash', async () => scene(async ({ org, knowledge, task, submit, reference, dispose, query, log }) => {
    const source = await knowledge(); const node = await task(); const row = await submit(node, [adoption(source.id)]); await dispose(source.id, reference(row)); const hash = (await log()).trim().split('\n').map(JSON.parse).find(event => event.反馈关联).反馈关联.指纹;
    const decide = org.policy.decideCurrentSync.bind(org.policy); org.policy.decideCurrentSync = input => input.action === 'read' && input.target?.kind === '记忆' ? { verdict: 'deny', rule: 'private-current-source', reason: BODY } : decide(input);
    const denied = itemAt(await query(), row.seq, source.id); assert.equal(denied.反馈处置.状态, '不可核对'); assert.ok(!JSON.stringify(denied).includes(hash)); assert.equal(denied.说明, PRIVATE); org.policy.decideCurrentSync = decide;
    await org.memory.purge(source.id, { subject: SOVEREIGN, 理由: '已关联源也必须能敏感删除', 敏感: true }); const purged = itemAt(await query(), row.seq, source.id); assert.deepEqual(purged.反馈处置, denied.反馈处置); assert.ok(!JSON.stringify(purged).includes(hash));
  }));

  it('替代知识标识须独立满足当前项目读域，旧源可读不授予新源跨项目可见', async () => scene(async ({ f, knowledge, task, submit, reference, dispose, query, log }) => {
    const source = await knowledge(); const foreign = await knowledge({ 项目: Q }); const node = await task(); const row = await submit(node, [adoption(source.id)]); await dispose(source.id, reference(row), { op: 'overturn', 新条目: '替代知识需要独立核当前读域' }); const id = foreign.id;
    const entries = (await log()).trim().split('\n').map(JSON.parse); entries.find(event => event.追加 === '推翻').新条目 = id;
    await writeFile(f.layout.memoryLog(P, '知识'), entries.map(event => JSON.stringify(event)).join('\n') + '\n', 'utf8');
    const item = itemAt(await query(), row.seq, source.id); assert.equal(item.反馈处置.状态, '已见关联处置'); assert.ok(!JSON.stringify(item.反馈处置).includes(id));
  }));

  it('无引用处置不按同id或时间猜关联；同反馈多次真实处置只回最近5并拒旧分页', async () => scene(async ({ knowledge, task, submit, reference, dispose, query }) => {
    const source = await knowledge(); const node = await task(); const row = await submit(node, [adoption(source.id)]); await dispose(source.id, undefined, { op: 'demote' });
    const first = await query(); assert.equal(itemAt(first, row.seq, source.id).反馈处置.状态, '未见关联处置'); assert.equal(first.处置汇总.未见关联处置, 1);
    for (let i = 0; i < 7; i++) await dispose(source.id, reference(row), { op: 'demote', 原因: `明确第${i}次后续处置` });
    const item = itemAt(await query(), row.seq, source.id); assert.equal(item.反馈处置.记录.length, 5); assert.equal(item.反馈处置.总数, 7); assert.equal(item.反馈处置.截断, true);
    await assert.rejects(() => query({ 偏移: 1, 数据版本: first.数据版本 }), rejection);
  }));

  it('关联观察仍受40k与真实分页预算，稳定续读不漏重且不追加任何事实', async () => scene(async ({ f, org, knowledge, task, submit, reference, dispose, query }) => {
    const source = await knowledge(); const node = await task(); const total = 50;
    for (let i = 0; i < total; i++) { const row = await submit(node, [adoption(source.id, { 用途: '用'.repeat(512), 适用判断: '判'.repeat(512), 说明: '说'.repeat(1024) })]); await dispose(source.id, reference(row), { op: 'demote' }); }
    const files = [f.layout.taskLog(P), f.layout.memoryLog(P, '知识'), f.layout.identityFile()]; const before = await Promise.all(files.map(file => readTextOrNull(file))); const audit = await org.audit.read({});
    const first = await query({ 条数: 50 }); assert.ok(first.采用页.hasMore, '本夹具必须实际进入预算续页'); const seen = []; let page = first;
    for (;;) { assert.ok(JSON.stringify(page).length <= 40000); assert.equal(page.处置汇总.已见关联处置, total); assert.equal(page.采用页.实际返回条目数, page.采用页.条目.length); for (const record of page.采用页.条目) seen.push(record.提交序); if (!page.采用页.hasMore) break; assert.ok(page.采用页.下一偏移 > page.采用页.偏移); page = await query({ 条数: 50, 偏移: page.采用页.下一偏移, 数据版本: first.数据版本 }); }
    assert.equal(seen.length, total); assert.equal(new Set(seen).size, total); assert.deepEqual(await Promise.all(files.map(file => readTextOrNull(file))), before); assert.deepEqual(await org.audit.read({}), audit);
  }));

  it('单条16项各5个合法长回执也可读，缩减旧回执保最近1条且不伪改总数', async () => scene(async ({ f, knowledge, task, submit, reference, prepare, query, log }) => {
    const sources = []; for (let i = 0; i < 16; i++) sources.push(await knowledge());
    const node = await task(); const row = await submit(node, sources.map(source => adoption(source.id, { 用途: '用'.repeat(512), 适用判断: '判'.repeat(512), 说明: '说'.repeat(1024) })));
    const entries = (await log()).trim().split('\n').map(JSON.parse); const original = [...entries];
    for (const [index, source] of sources.entries()) {
      const plan = await prepare(source.id, reference(row)); const sourceRow = original.find(entry => entry.id === source.id);
      for (let j = 0; j < 5; j++) {
        const id = `replacement-${index}-${j}-`.padEnd(256, 'r');
        entries.push({ ...sourceRow, id, 内容: '仅供标识当前读域核对，不回传正文' });
        entries.push({ id: `state-${index}-${j}`, 指向: source.id, 追加: '推翻', 追于: `2026-10-21T12:00:0${j}Z`, 主体: { id: `actor-${index}-${j}-`.padEnd(256, 'a'), kind: 'Lead' }, 新条目: id, 反馈关联: { 版本: 1, 指纹: plan.指纹 } });
      }
    }
    // 合法结构历史的极限载荷；不把这些手工历史行声称为过去授权的重新认证。
    await writeFile(f.layout.memoryLog(P, '知识'), entries.map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
    const view = await query({ 条数: 50 }); assert.ok(JSON.stringify(view).length <= 40000); assert.equal(view.采用页.实际返回条目数, 1); assert.equal(view.采用页.hasMore, false);
    const items = view.采用页.条目[0].采用知识; assert.equal(items.length, 16); assert.ok(items.some(item => item.反馈处置.截断));
    for (const item of items) { assert.equal(item.反馈处置.总数, 5); assert.ok(item.反馈处置.记录.length >= 1); assert.ok(item.反馈处置.记录.length <= 5); assert.equal(item.反馈处置.记录.at(-1).处置于, '2026-10-21T12:00:04Z'); }
  }));
});
