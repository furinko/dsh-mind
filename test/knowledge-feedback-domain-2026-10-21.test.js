/** 负面采用声明的处置关联：只加私有指纹，读面必须重新核对来源和权限。 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { makeFixture, seedReviewRelation, LEAD, MEMBER, REVIEWER, SOVEREIGN } from './helpers.mjs';
import { Org } from '../src/org.js';
import { fold as foldMemory } from '../src/memory.js';
import { normalizeFeedbackReference, resolveKnowledgeFeedback, knowledgeFeedbackFingerprint, validateFeedbackDispositionObservation } from '../src/knowledge-feedback.js';
import { readTaskLedger } from '../src/task-ledger.js';
import { readJsonl } from '../src/kernel/fsx.js';
import { Denied, Fault, InvalidBody } from '../src/kernel/errors.js';

const P = 'knowledge-feedback-domain';
const rejected = (error) => error instanceof Denied || error instanceof InvalidBody || error instanceof Fault;
const declaration = (id, extra = {}) => ({ id, 用途: '在本任务中采用', 适用判断: '实际前提不符', 使用结果: '不适用', 说明: '负反馈私有声明原文', ...extra });
async function scene(run) {
  const f = await makeFixture();
  try {
    const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
    const memory = org.memory;
    const source = await memory.remember({ subject: LEAD, 类: '知识', 项目: P, 内容: '原知识私有正文', 来源: '独立验证' });
    const task = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '检验知识适用性', 负责人: LEAD.id, 判据: ['核对适用前提'] });
    await org.tasks.dispatch(task.id, { subject: LEAD, 项目: P }); await org.tasks.start(task.id, { subject: LEAD, 项目: P });
    await org.tasks.submit(task.id, { subject: LEAD, 项目: P, 结论: '已给出反例', 采用知识: [declaration(source.id)] });
    const taskFile = org.layout.taskLog(P);
    const rows = () => readTaskLedger(taskFile);
    const submitted = (await rows()).filter((row) => row.kind === 'submitted').at(-1);
    const reference = { 任务: task.id, 提交序: submitted.seq };
    const prepare = (op = 'invalidate', extra = {}) => memory.prepareFeedbackReference(source.id, { subject: LEAD, 项目: P, op, 反馈引用: reference, 原因: '已核对负反馈', ...extra });
    const dispose = (op = 'invalidate', extra = {}) => memory[op](source.id, { subject: LEAD, 项目: P, 反馈引用: reference, 原因: '已核对负反馈', ...(op === 'overturn' ? { 理由: '已核对负反馈', 新条目: '替代知识正文' } : {}), ...extra });
    const fingerprint = resolveKnowledgeFeedback({ rows: await rows(), 项目: P, ...reference, 知识id: source.id }).指纹;
    const observe = (extra = {}) => memory.readFeedbackDispositions({ subject: LEAD, 项目: P, items: [{ 知识id: source.id, 反馈指纹: fingerprint }], ...extra });
    const raw = () => readJsonl(source.账本);
    const rewriteTask = (values) => writeFile(taskFile, values.map((row) => JSON.stringify(row)).join('\n') + '\n');
    await run({ f, org, memory, source, task, taskFile, submitted, reference, fingerprint, prepare, dispose, observe, raw, rows, rewriteTask });
  } finally { await f.cleanup(); }
}

describe('知识反馈纯见证', () => {
  it('引用严格clone，不接受伪造hash/主体/状态、位置猜测或坏序号', () => {
    assert.equal(normalizeFeedbackReference(undefined), undefined);
    const input = { 任务: 'task-real', 提交序: 4 }; const result = normalizeFeedbackReference(input); result.任务 = 'changed'; assert.equal(input.任务, 'task-real');
    for (const value of [null, [], {}, { 任务: '', 提交序: 1 }, { 任务: ' task', 提交序: 1 }, { 任务: 'task', 提交序: 0 }, { 任务: 'task', 提交序: 1.1 }, { 任务: 'task', 提交序: '1' }, { 任务: 'task', 提交序: Number.MAX_SAFE_INTEGER + 1 }, { ...input, 指纹: 'a'.repeat(64) }, { ...input, subject: LEAD }]) assert.throws(() => normalizeFeedbackReference(value), (error) => error instanceof InvalidBody);
  });

  it('指纹绑定完整原事件与采用条目，纯resolver只认唯一显式seq/当时代负项', async () => scene(async ({ source, submitted, reference, fingerprint, rows }) => {
    const all = await rows(); assert.equal(knowledgeFeedbackFingerprint({ 项目: P, ...reference, 知识id: source.id, 事件: submitted, 条目: submitted.采用知识.条目[0] }), fingerprint);
    for (const change of [{ seq: submitted.seq + 100 }, { 结论: '后来改原事件' }, { 采用知识: { ...submitted.采用知识, 条目: [declaration(source.id, { 使用结果: '有帮助', 来源: submitted.采用知识.条目[0].来源 })] } }]) {
      const modified = all.map((row) => row.seq === submitted.seq ? { ...row, ...change } : row);
      if (change.结论) assert.notEqual(resolveKnowledgeFeedback({ rows: modified, 项目: P, ...reference, 知识id: source.id }).指纹, fingerprint);
      else assert.throws(() => resolveKnowledgeFeedback({ rows: modified, 项目: P, ...reference, 知识id: source.id }), rejected);
    }
    assert.throws(() => resolveKnowledgeFeedback({ rows: [...all, { ...all[0], seq: submitted.seq }], 项目: P, ...reference, 知识id: source.id }), (error) => error instanceof Denied);
    const noGeneration = structuredClone(all); delete noGeneration.at(-1).代; assert.throws(() => resolveKnowledgeFeedback({ rows: noGeneration, 项目: P, ...reference, 知识id: source.id }), rejected);
  }));

  it('观察回执闭名单和明零/未知精确，不能spread原文/私有证明或伪造完成', () => {
    const empty = { 状态: '可核对', 记录: [], 总数: 0, 截断: false }; assert.deepEqual(validateFeedbackDispositionObservation(empty), empty);
    const unknown = { 状态: '不可核对', 记录: [], 总数: null, 截断: null }; assert.deepEqual(validateFeedbackDispositionObservation(unknown), unknown);
    for (const value of [{ ...empty, 已解决: true }, { ...unknown, 总数: 0 }, { ...empty, 总数: 1 }, { ...empty, 记录: [{ 动作: '失效', 记录摘要: 'a'.repeat(64), 处置于: '2026-10-21T00:00:00Z', 主体: 'lead', 原因: 'secret' }] }, { ...empty, 记录: Array(6).fill({}) }]) assert.throws(() => validateFeedbackDispositionObservation(value), (error) => error instanceof InvalidBody);
  });
});

describe('知识反馈处置与私有关联', () => {
  it('只读准备无业务/审计写，冻结步骤仅给见证摘要与原写标签', async () => scene(async ({ org, prepare, raw, rows }) => {
    const before = await raw(); const tasks = await rows(); const audit = await org.audit.readVerified();
    const plan = await prepare(); assert.equal(Object.isFrozen(plan), true); assert.equal(Object.isFrozen(plan.执行计划), true); assert.match(plan.指纹, /^[a-f0-9]{64}$/); assert.match(plan.步骤[0].写, /^记忆:invalid:/);
    assert.match(plan.步骤[0].预览.反馈见证, /^[a-f0-9]{64}$/); assert.doesNotMatch(JSON.stringify(plan.步骤.map((step) => step.预览)), /原知识私有正文|负反馈私有声明原文/);
    assert.deepEqual(await raw(), before); assert.deepEqual(await rows(), tasks); assert.deepEqual(await org.audit.readVerified(), audit);
  }));

  it('invalidate仅状态行保存版本+指纹，公开fold/回执/审计/元数据不展开私有见证', async () => scene(async ({ org, memory, source, fingerprint, dispose, raw }) => {
    const result = await dispose(); assert.equal(Object.hasOwn(result, '反馈关联'), false);
    const stored = await raw(); const state = stored.find((row) => row.追加 === 'invalid'); assert.deepEqual(state.反馈关联, { 版本: 1, 指纹: fingerprint });
    assert.equal(Object.hasOwn(state.反馈关联, '任务'), false); assert.equal(Object.hasOwn(state.反馈关联, '提交序'), false);
    const publicEntry = foldMemory(stored).find((entry) => entry.id === source.id); assert.equal(JSON.stringify(publicEntry).includes(fingerprint), false);
    const queried = await memory.query({ subject: LEAD, 项目: P, 类: '知识', id: source.id, 含失效: true }); assert.equal(JSON.stringify(queried).includes(fingerprint), false);
    assert.equal(JSON.stringify(await memory.lineage({ subject: LEAD, id: source.id })).includes(fingerprint), false); assert.equal(JSON.stringify(await org.audit.readVerified()).includes(fingerprint), false);
  }));

  it('可核对空记录只表示未见关联；旧无引用处置不倒填，新降权可核且不自动判错', async () => scene(async ({ memory, source, dispose, observe }) => {
    const empty = (await observe()).values().next().value; assert.deepEqual(empty, { 状态: '可核对', 记录: [], 总数: 0, 截断: false });
    await memory.demote(source.id, { subject: LEAD, 原因: '旧兼容处置' }); assert.equal((await observe()).values().next().value.总数, 0);
    await dispose('demote'); const result = (await observe()).values().next().value; assert.equal(result.总数, 1); assert.equal(result.记录[0].动作, '降权'); assert.equal(result.记录[0].主体, LEAD.id); assert.equal(Object.hasOwn(result.记录[0], '反馈指纹'), false);
  }));

  it('返工后仍可核第一代真实负反馈，不把当前代不一致误作原反馈消失', async () => scene(async ({ f, org, task, dispose, observe }) => {
    await seedReviewRelation(f, { 项目: P, 目标: task.id }); await org.tasks.review(task.id, { subject: REVIEWER, 项目: P, 三态: '不过', 分歧清单: ['需补证'] });
    await org.tasks.start(task.id, { subject: LEAD, 项目: P }); await org.tasks.submit(task.id, { subject: LEAD, 项目: P, 结论: '第二代', 采用知识: [] });
    await dispose('demote'); assert.equal((await observe()).values().next().value.记录.length, 1);
  }));

  it('成员/复核员/假Lead不能带新引用，旧无引用成员生命周期仍走原权限', async () => scene(async ({ memory, source, reference, raw, dispose, observe }) => {
    const before = await raw();
    for (const subject of [MEMBER, REVIEWER, { id: MEMBER.id, kind: 'Lead' }, { id: 'ghost', kind: 'Lead' }]) await assert.rejects(() => dispose('demote', { subject }), (error) => error instanceof Denied);
    assert.deepEqual(await raw(), before);
    assert.deepEqual((await observe({ subject: MEMBER })).values().next().value, { 状态: '不可核对', 记录: [], 总数: null, 截断: null });
    await assert.rejects(() => memory.invalidate(source.id, { subject: MEMBER, 项目: P, 反馈引用: reference, 原因: '成员关联企图' }), (error) => error instanceof Denied);
  }));

  it('品牌执行计划不能JSON伪造、跨主体或改业务字段，新直接调用自行准备', async () => scene(async ({ prepare, dispose, raw }) => {
    const plan = await prepare('demote');
    for (const extra of [{ 反馈执行计划: JSON.parse(JSON.stringify(plan.执行计划)) }, { 反馈执行计划: plan.执行计划, 原因: '换原因' }, { 反馈执行计划: plan.执行计划, subject: SOVEREIGN }]) await assert.rejects(() => dispose('demote', extra), (error) => error instanceof InvalidBody);
    assert.equal((await raw()).filter((row) => row.反馈关联).length, 0);
    await dispose('demote'); assert.equal((await raw()).filter((row) => row.反馈关联).length, 1);
  }));

  it('准备后原交卷/条目变化均拒，不能拿原hash给后来声明补签', async () => scene(async ({ prepare, dispose, rows, rewriteTask, raw }) => {
    const plan = await prepare('demote'); const taskRows = await rows(); taskRows.find((row) => row.kind === 'submitted').采用知识.条目[0].说明 = '后来改原始采用说明'; await rewriteTask(taskRows);
    await assert.rejects(() => dispose('demote', { 反馈执行计划: plan.执行计划 }), (error) => error instanceof Denied); assert.equal((await raw()).filter((row) => row.反馈关联).length, 0);
  }));

  it('准备后knowledge原文改变拒执行，purge也不能制造幽灵关联', async () => scene(async ({ memory, source, prepare, dispose, raw }) => {
    const plan = await prepare('demote'); const all = await raw(); all.find((row) => row.id === source.id).内容 = '原文被替换'; await writeFile(source.账本, all.map((row) => JSON.stringify(row)).join('\n') + '\n');
    await assert.rejects(() => dispose('demote', { 反馈执行计划: plan.执行计划 }), (error) => error instanceof Denied);
    const fresh = await prepare('demote'); await memory.purge(source.id, { subject: SOVEREIGN, 理由: '用户要求删除' });
    await assert.rejects(() => dispose('demote', { 反馈执行计划: fresh.执行计划 }), (error) => error instanceof Denied);
    assert.equal((await raw()).filter((row) => row.反馈关联).length, 0);
  }));

  it('真实write判定后purge窗口在锁内fresh重检，关联不落线', async () => scene(async ({ org, memory, source, prepare, dispose, raw }) => {
    const plan = await prepare('demote'); const check = org.policy.check.bind(org.policy); let purged = false;
    org.policy.check = async (spec) => { const result = await check(spec); if (!purged && spec.action === 'write' && spec.context?.状态 === '降权') { purged = true; await memory.purge(source.id, { subject: SOVEREIGN, 理由: '写前窗口删除' }); } return result; };
    await assert.rejects(() => dispose('demote', { 反馈执行计划: plan.执行计划 }), rejected); assert.equal(purged, true); assert.equal((await raw()).filter((row) => row.反馈关联).length, 0);
  }));

  it('当前task/knowledge读或write收紧拒关联，治理摘要不能复活旧身份', async () => scene(async ({ f, org, prepare, dispose, observe, raw }) => {
    const matrix = '集体L1-法律/权限矩阵.md'; const original = await readFile(f.layout.factory(matrix), 'utf8');
    for (const grant of [{ subject: 'Lead', action: 'read', kind: '任务', verdict: 'deny' }, { subject: 'Lead', action: 'read', kind: '记忆', verdict: 'deny' }, { subject: 'Lead', action: 'write', kind: '知识', verdict: 'deny' }]) { await f.write(matrix, original + '\n```policy\n' + JSON.stringify({ grants: [grant] }) + '\n```\n'); await assert.rejects(() => prepare(), rejected); }
    await f.write(matrix, original); await org.policy.refreshIfStale(); const plan = await prepare(); await org.registry.seal({ subject: SOVEREIGN, 实例: LEAD.id, 理由: '当前身份失效' });
    await assert.rejects(() => dispose('invalidate', { 反馈执行计划: plan.执行计划 }), (error) => error instanceof Denied); assert.equal((await observe()).values().next().value.状态, '不可核对'); assert.equal((await raw()).filter((row) => row.反馈关联).length, 0);
  }));

  it('overturn新知识和关联状态同锁落线，回执可读替代id但无私有见证', async () => scene(async ({ memory, source, prepare, dispose, observe, raw }) => {
    const plan = await prepare('overturn', { 理由: '已核对负反馈', 新条目: '替代知识正文' }); assert.equal(plan.步骤.length, 2); assert.deepEqual(plan.步骤.map((step) => step.动作), ['write', 'create']);
    const result = await dispose('overturn', { 反馈执行计划: plan.执行计划 }); const all = await raw(); assert.ok(all.some((row) => row.id === result.新条目)); const linked = all.find((row) => row.追加 === '推翻'); assert.equal(linked.指向, source.id); assert.ok(linked.反馈关联);
    const observed = (await observe()).values().next().value; assert.equal(observed.记录[0].动作, '替代'); assert.equal(observed.记录[0].替代知识, result.新条目); assert.equal(Object.hasOwn(result, '反馈关联'), false);
    await memory.purge(result.新条目, { subject: SOVEREIGN, 理由: '移除替代知识' }); assert.equal(Object.hasOwn((await observe()).values().next().value.记录[0], '替代知识'), false);
  }));

  it('overturn create被拒时原知识无关联/无推翻行，非提交错误不冒部分成功', async () => scene(async ({ org, dispose, raw }) => {
    const check = org.policy.check.bind(org.policy); org.policy.check = async (spec) => { if (spec.action === 'create' && spec.target.kind === '知识') throw new Denied('夹具真实create拒绝', '新条目不可写'); return check(spec); };
    await assert.rejects(() => dispose('overturn'), (error) => error instanceof Denied); assert.equal((await raw()).filter((row) => row.反馈关联 || row.追加 === '推翻').length, 0);
  }));

  it('observe严格fresh原字节，坏行/撕裂/坏私有封套与purge同形未知而不是0', async () => scene(async ({ memory, source, dispose, observe, raw }) => {
    await dispose('demote'); const original = await readFile(source.账本, 'utf8');
    for (const damaged of [original + '{bad}\n', original.slice(0, -1), original.replace('"版本":1,"指纹":', '"版本":2,"指纹":')]) { await writeFile(source.账本, damaged); const result = (await observe()).values().next().value; assert.deepEqual(result, { 状态: '不可核对', 记录: [], 总数: null, 截断: null }); }
    await writeFile(source.账本, original); await memory.purge(source.id, { subject: SOVEREIGN, 理由: '删除后不泄关联数' }); assert.equal((await observe()).values().next().value.总数, null); void raw;
  }));

  it('最近5条按时间和同秒扫描序排序，保总数/截断且观察不追加审计', async () => scene(async ({ org, source, dispose, observe, raw }) => {
    for (let i = 0; i < 7; i += 1) await dispose('demote', { 原因: `第${i}次人工核对` });
    const before = await raw(); const audit = await org.audit.readVerified(); const result = (await observe()).values().next().value;
    assert.equal(result.总数, 7); assert.equal(result.记录.length, 5); assert.equal(result.截断, true); assert.ok(result.记录.every((row) => row.动作 === '降权'));
    assert.deepEqual(await raw(), before); assert.deepEqual(await org.audit.readVerified(), audit); assert.equal(JSON.stringify(result).includes('第'), false); void source;
  }));

  it('已失效/待复验历史知识仍可核处置，不用当前推荐资格抹去处置事实', async () => scene(async ({ memory, source, dispose, observe, raw }) => {
    const all = await raw(); all[0].知识说明 = { 复验期限: '2000-01-01T00:00:00Z' }; await writeFile(source.账本, all.map((row) => JSON.stringify(row)).join('\n') + '\n');
    await dispose(); assert.equal((await observe()).values().next().value.状态, '可核对'); assert.equal((await observe()).values().next().value.记录[0].动作, '失效');
    assert.equal((await memory.query({ subject: LEAD, 类: '知识', 项目: P, 含失效: true })).条目.length, 0);
  }));

  it('返回克隆与参数预算严格，不接受模型补签或用超量items扩大观察', async () => scene(async ({ memory, observe, fingerprint, source }) => {
    const first = await observe(); first.get(fingerprint).记录.push({ 动作: '伪造' }); assert.equal((await observe()).get(fingerprint).记录.length, 0);
    for (const items of [null, Array(17).fill({ 知识id: source.id, 反馈指纹: fingerprint }), [{ 知识id: source.id, 反馈指纹: fingerprint, 原文: 'private' }], [{ 知识id: source.id, 反馈指纹: 'bad' }]]) await assert.rejects(() => memory.readFeedbackDispositions({ subject: LEAD, 项目: P, items }), (error) => error instanceof InvalidBody);
  }));
});
