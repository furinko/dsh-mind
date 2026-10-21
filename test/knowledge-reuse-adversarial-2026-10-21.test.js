/** 独立知识采用反例：真实 Org/任务/记忆，来源是观察版本，声明不升级为语义认证。 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { makeFixture, LEAD, MEMBER, SOVEREIGN } from './helpers.mjs';
import { Org } from '../src/org.js';
import { digest } from '../src/kernel/text.js';
import { readTextOrNull } from '../src/kernel/fsx.js';
import { runAction } from '../lib/actions.js';
import { InvalidBody, Denied, Fault } from '../src/kernel/errors.js';

const P = 'knowledge-reuse-independent-adversarial';
const Q = `${P}-other`;
const B = { id: 'member-b', kind: '成员', roleId: '插件工程' };
const REVIEWER = { id: 'reviewer', kind: '成员', roleId: '复核员' };
const PRIVATE_BODY = 'PRIVATE_KNOWLEDGE_BODY_NOT_TASK_CONTENT';
const OTHER_STATEMENT = 'OTHER_MEMBER_PRIVATE_ADOPTION_STATEMENT';
const adoption = (id, extra = {}) => ({ id, 用途: '支撑当前任务选择', 适用判断: '本人声明当前场景适用', 使用结果: '有帮助', ...extra });

async function scene(body) {
  const f = await makeFixture();
  try {
    const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
    const knowledge = (内容 = PRIVATE_BODY, extra = {}) => org.memory.remember({ subject: LEAD, 类: '知识', 项目: P, 内容, 来源: '隔离来源，不代表人侧认证', ...extra });
    const task = async (members = [MEMBER]) => {
      const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '知识采用隔离验收', 负责人: '插件工程', 判据: ['记录可追溯'] });
      for (const member of members) await org.tasks.bind(node.id, { subject: LEAD, 项目: P, 实例: member.id, 岗位: member.roleId });
      await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
      await org.tasks.start(node.id, { subject: members[0], 项目: P });
      return node;
    };
    const act = (args, subject = MEMBER) => runAction({ org, 项目: P, subject, 主体: subject, 面: 'tool', args });
    const submit = (node, fields = {}, subject = MEMBER) => act({ action: 'task_submit', id: node.id, 结论: '当前独立结论', ...fields }, subject);
    const query = (extra = {}) => org.knowledgeReuse.query({ subject: LEAD, 项目: P, ...extra });
    const events = () => org.tasks.events({ 项目: P });
    const accept = async node => { const reviewed = await org.tasks.review(node.id, { subject: LEAD, 项目: P, 三态: '过' }); return org.tasks.accept(node.id, { subject: LEAD, 项目: P, 票: reviewed.待采纳.票 }); };
    await body({ f, org, knowledge, task, act, submit, query, events, accept });
  } finally { await f.cleanup(); }
}

describe('独立知识采用：其他任务出口不能漏出新来源字段', { timeout: 60_000 }, () => {
  it('采用来源不再可读后，合法task_pending回执也不能回传历史hash；多人交卷不能夹带他人采用声明', async () => scene(async ({ org, knowledge, task, submit, act, events }) => {
    const source = await knowledge(); const node = await task([MEMBER, B]);
    await submit(node, { 采用知识: [adoption(source.id, { 说明: OTHER_STATEMENT })] });
    const row = (await events()).find(event => event.kind === 'submitted');
    const hash = row.采用知识.条目[0].来源.内容哈希; assert.equal(hash, digest(PRIVATE_BODY));
    const decision = org.policy.decideCurrentSync.bind(org.policy);
    org.policy.decideCurrentSync = input => input.target?.kind === '记忆' && input.action === 'read' ? { verdict: 'deny', rule: 'independent-current-source-read-denied', reason: '当前来源不可读' } : decision(input);
    const second = await submit(node, { 采用知识: [] }, B);
    assert.ok(!JSON.stringify(second).includes(OTHER_STATEMENT), 'B的交卷回执不能带A的采用声明');
    const pending = await act({ action: 'task_pending', id: node.id, 原因: '合法记录当前阻塞' });
    assert.ok(!JSON.stringify(pending).includes(hash), '新治理query之外的任务出口不能绕过当前来源剥除');
    assert.ok(!JSON.stringify(pending).includes(PRIVATE_BODY));
  }));
});

describe('独立知识采用：结构、完整来源和当前权限', { timeout: 60_000 }, () => {
  it('省略、显式空和本人声明分列，来源完整hash不抄正文，task回执不展开采用封套', async () => scene(async ({ org, knowledge, task, submit, query, events }) => {
    const source = await knowledge(); const node = await task();
    await submit(node); await submit(node, { 采用知识: [] });
    const result = await submit(node, { 采用知识: [adoption(source.id, { 使用结果: '发现问题', 说明: '这是本人负反馈，不要求自动推翻' })] });
    const rows = (await events()).filter(row => row.kind === 'submitted'); assert.equal(rows.length, 3);
    assert.ok(!Object.hasOwn(rows[0], '采用知识')); assert.equal(rows[1].采用知识.声明状态, '显式空');
    assert.equal(rows[2].采用知识.声明状态, '已声明'); assert.equal(rows[2].by.id, MEMBER.id); assert.equal(rows[2].代, 1);
    assert.equal(rows[2].采用知识.条目[0].来源.内容哈希, digest(PRIVATE_BODY));
    assert.ok(!JSON.stringify(rows).includes(PRIVATE_BODY)); assert.ok(!JSON.stringify(result).includes('内容哈希'));
    const view = await query(); assert.equal(view.汇总.交卷记录, 3); assert.equal(view.汇总.未说明, 1); assert.equal(view.汇总.显式空, 1); assert.equal(view.汇总.问题声明, 1);
    assert.equal(view.采用页.条目[0].当前状态, undefined, '不把当前任务状态偷塞成当年声明结论');
    assert.equal(view.采用页.条目[0].采用知识[0].当前来源, '同一观察版本');
    assert.equal((await org.memory.readKnowledgeEvidence({ subject: MEMBER, 项目: P, ids: [source.id] })).get(source.id).状态, '可核来源版本');
  }));

  it('null、超限、重复id和伪造核验/主体字段在零交卷事件时拒绝', async () => scene(async ({ f, task, submit }) => {
    const node = await task(); const file = f.layout.taskLog(P); const before = await readFile(file, 'utf8');
    const invalid = [null, {}, Array.from({ length: 17 }, (_, i) => adoption(`know-${i}`)), [adoption('know-a'), adoption('know-a')],
      [adoption('know-a', { 来源: { 状态: '可核来源版本' } })], [adoption('know-a', { hash: 'a'.repeat(64) })],
      [adoption('know-a', { 主体: LEAD })], [adoption('know-a', { 使用结果: '已认证有效' })], [adoption('know-a', { 用途: 'x'.repeat(513) })]];
    for (const 采用知识 of invalid) {
      await assert.rejects(() => submit(node, { 采用知识 }), InvalidBody); assert.equal(await readFile(file, 'utf8'), before);
    }
    await assert.rejects(() => submit(node, { 采用知识: [], 已核验: true }), InvalidBody); assert.equal(await readFile(file, 'utf8'), before);
  }));

  it('第一个await前固定声明，调用者改数组或条目不能迁移已开始的交卷', async () => scene(async ({ org, task, events }) => {
    const node = await task(); const declarations = [adoption('know-unknown', { 用途: '原用途' })];
    const pending = org.tasks.submit(node.id, { subject: MEMBER, 项目: P, 采用知识: declarations });
    declarations[0].用途 = '后来改写'; declarations.push(adoption('know-later'));
    await pending;
    const row = (await events()).find(event => event.kind === 'submitted'); assert.equal(row.采用知识.条目.length, 1); assert.equal(row.采用知识.条目[0].用途, '原用途');
  }));

  it('长正文取完整hash且内部批量核验零额外审计，未知/跨项目/非知识一律同形未核验', async () => scene(async ({ org, knowledge }) => {
    const body = `${PRIVATE_BODY}:${'长正文'.repeat(10000)}:完整尾部`;
    const source = await knowledge(body); const foreign = await knowledge('other-project-private', { 项目: Q });
    const experience = await org.memory.remember({ subject: LEAD, 类: '经历', 内容: '不是知识', 来源: '隔离来源' });
    const before = (await org.audit.read({})).length;
    const evidence = await org.memory.readKnowledgeEvidence({ subject: MEMBER, 项目: P, ids: [source.id, foreign.id, experience.id, 'know-no-such-source'] });
    assert.equal(evidence.get(source.id).内容哈希, digest(body)); assert.match(evidence.get(source.id).元数据哈希, /^[a-f0-9]{64}$/);
    assert.notEqual(evidence.get(source.id).内容哈希, digest(body.slice(0, 160)));
    for (const id of [foreign.id, experience.id, 'know-no-such-source']) assert.deepEqual(evidence.get(id), { 状态: '来源未核验' });
    assert.equal((await org.audit.read({})).length, before); assert.ok(!JSON.stringify([...evidence]).includes(PRIVATE_BODY));
  }));

  it('复核员来源核验复用本人显式对象域，kind/role自报不能扩大它', async () => scene(async ({ org, knowledge, task }) => {
    const one = await task(); const other = await task();
    const a = await knowledge('对口知识', { 来源引用: [one.id] }); const b = await knowledge('无关知识', { 来源引用: [other.id] });
    const review = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '真实独立复核', 负责人: '复核员', 判据: ['核对'], 复核对象: [one.id] });
    await org.tasks.bind(review.id, { subject: LEAD, 项目: P, 实例: REVIEWER.id, 岗位: '复核员' });
    await org.tasks.dispatch(review.id, { subject: LEAD, 项目: P });
    const evidence = await org.memory.readKnowledgeEvidence({ subject: REVIEWER, 项目: P, ids: [a.id, b.id] });
    assert.equal(evidence.get(a.id).状态, '可核来源版本'); assert.deepEqual(evidence.get(b.id), { 状态: '来源未核验' });
    const forged = await org.memory.readKnowledgeEvidence({ subject: { id: MEMBER.id, kind: 'Lead' }, 项目: P, ids: [a.id] });
    assert.deepEqual(forged.get(a.id), { 状态: '来源未核验' });
  }));

  it('坏JSON、未知状态和撕裂不能跳行签来源，合法submit照常提交且不泄原因', async () => scene(async ({ f, org, knowledge, task, submit, events }) => {
    const source = await knowledge(); const file = f.layout.memoryLog(P, '知识'); const raw = await readFile(file, 'utf8');
    const broken = [`${raw}{broken\n`, raw.slice(0, -1), `${raw}${JSON.stringify({ id: 'state-unknown', 指向: source.id, 追加: 'unknown-state', 追于: '2026-10-21T12:00:00.000Z' })}\n`];
    const node = await task();
    for (const text of broken) {
      await writeFile(file, text, 'utf8'); await submit(node, { 采用知识: [adoption(source.id)] });
      const row = (await events()).filter(event => event.kind === 'submitted').at(-1);
      assert.deepEqual(row.采用知识.条目[0].来源, { 状态: '来源未核验' });
    }
    await writeFile(file, raw, 'utf8'); await org.memory.invalidate(source.id, { subject: LEAD, 原因: '真实失效状态' });
    await submit(node, { 采用知识: [adoption(source.id)] });
    assert.deepEqual((await events()).filter(event => event.kind === 'submitted').at(-1).采用知识.条目[0].来源, { 状态: '来源未核验' });
  }));
});

describe('独立知识采用：采纳归属与治理查询', { timeout: 60_000 }, () => {
  it('同人复交留历史，多人只关联当时本代每人的最后提交，旧票或坏manifest原文不能洗出关联', async () => scene(async ({ f, org, knowledge, task, submit, query, events, accept }) => {
    const source = await knowledge(); const node = await task([MEMBER, B]);
    await submit(node, { 采用知识: [adoption(source.id, { 使用结果: '未知' })] });
    await submit(node, { 采用知识: [adoption(source.id, { 使用结果: '不适用' })] }, B);
    const old = await org.tasks.review(node.id, { subject: LEAD, 项目: P, 三态: '过' });
    await submit(node, { 采用知识: [adoption(source.id, { 使用结果: '发现问题' })] });
    await assert.rejects(() => org.tasks.accept(node.id, { subject: LEAD, 项目: P, 票: old.待采纳.票 }), Denied);
    await accept(node);
    const submitted = (await events()).filter(row => row.kind === 'submitted'); const records = (await query()).采用页.条目;
    assert.equal(records.length, 3); assert.deepEqual(records.find(row => row.提交序 === submitted[0].seq).关联采纳, []);
    for (const event of submitted.slice(1)) assert.equal(records.find(row => row.提交序 === event.seq).关联采纳.length, 1);
    assert.equal(records.find(row => row.提交人 === B.id).采用知识[0].使用结果, '不适用');
    assert.equal((await query()).汇总.关联采纳交卷, 2);
    const rows = await events(); const file = f.layout.taskLog(P);
    for (const patch of [{ 票: old.待采纳.票 }, { 交付物摘要: 'a'.repeat(64) }, { by: { id: MEMBER.id, kind: '成员' } }]) {
      await writeFile(file, rows.map(row => JSON.stringify(row.kind === 'accepted' ? { ...row, ...patch } : row)).join('\n') + '\n', 'utf8');
      assert.equal((await query()).汇总.关联采纳交卷, 0, '仅fold出已采纳不能代替历史引用关系核验');
    }
    await writeFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  }));

  it('返工关闭代与正式后继不迁移旧声明，也不把后来采纳补签到旧提交', async () => scene(async ({ org, knowledge, task, submit, query, accept }) => {
    const source = await knowledge(); const node = await task(); await submit(node, { 采用知识: [adoption(source.id)] });
    await org.tasks.review(node.id, { subject: LEAD, 项目: P, 三态: '不过', 分歧清单: ['需要返工'] });
    await org.tasks.start(node.id, { subject: MEMBER, 项目: P }); await submit(node, { 采用知识: [] }); await accept(node);
    const records = (await query()).采用页.条目; assert.equal(records[0].代, 2); assert.equal(records[0].关联采纳.length, 1); assert.equal(records[1].代, 1); assert.deepEqual(records[1].关联采纳, []);
    const original = await task(); await submit(original, { 采用知识: [adoption(source.id)] });
    await org.tasks.close(original.id, { subject: LEAD, 项目: P, 原因: '另立隔离后继' });
    const next = await org.tasks.createSuccessor(original.id, { subject: LEAD, 项目: P, 负责人: '插件工程', 原因: '保留前序，不复制本人声明' });
    await org.tasks.bind(next.节点.id, { subject: LEAD, 项目: P, 实例: MEMBER.id, 岗位: MEMBER.roleId }); await org.tasks.dispatch(next.节点.id, { subject: LEAD, 项目: P });
    await org.tasks.start(next.节点.id, { subject: MEMBER, 项目: P });
    await submit(next.节点);
    const successor = (await query({ 任务: next.节点.id })).采用页.条目[0]; assert.equal(successor.声明状态, '未知'); assert.deepEqual(successor.采用知识, []);
  }));

  it('旧submitted无代且无采用字段保持未知；有封套却坏代则拒投影，不跳成空统计', async () => scene(async ({ f, org, task, submit, query, events, accept }) => {
    const node = await task(); await submit(node); const file = f.layout.taskLog(P);
    const rows = await events(); const submitted = rows.find(row => row.kind === 'submitted'); delete submitted.代;
    await writeFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
    await accept(node); const view = await query(); assert.equal(view.采用页.条目[0].代, null); assert.equal(view.采用页.条目[0].声明状态, '未知'); assert.deepEqual(view.采用页.条目[0].关联采纳, []);
    const original = await events(); const corrupt = original.map(row => row.kind === 'submitted' ? { ...row, 采用知识: { 版本: 1, 声明状态: '显式空', 条目: [] } } : row);
    await writeFile(file, corrupt.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
    await assert.rejects(() => query(), error => error instanceof Fault && error.code === 'TASK_LEDGER_INVALID');
    assert.equal((await org.knowledgeReuse.summary(P)).健康, '不可用');
  }));

  it('普通成员、复核员、假Lead及当前封存Lead不能借task/id/分页读取治理采用汇总', async () => scene(async ({ org, knowledge, task, submit, query }) => {
    const source = await knowledge(); const node = await task(); await submit(node, { 采用知识: [adoption(source.id)] }); const first = await query();
    for (const subject of [MEMBER, REVIEWER, { id: MEMBER.id, kind: 'Lead' }, { id: 'unregistered', kind: 'Lead' }]) {
      for (const filter of [{}, { 任务: node.id }, { 知识id: source.id }, { 条数: 1, 偏移: 1, 数据版本: first.数据版本 }]) await assert.rejects(() => query({ subject, ...filter }), Denied);
      assert.equal(await org.knowledgeReuse.summaryFor({ subject, 项目: P }), null);
    }
    await org.registry.seal({ subject: SOVEREIGN, 实例: LEAD.id, 理由: '当前治理资格已撤回' }); await assert.rejects(() => query(), Denied);
  }));

  it('知识全可读也不扩大被拒任务读域，计数、知识筛选与显式task筛选同源', async () => scene(async ({ org, knowledge, task, submit, query }) => {
    const source = await knowledge(); const a = await task(); const b = await task();
    await submit(a, { 采用知识: [] }); await submit(b, { 采用知识: [adoption(source.id, { 说明: OTHER_STATEMENT })] });
    const decide = org.policy.decideCurrentSync.bind(org.policy);
    org.policy.decideCurrentSync = input => input.action === 'read' && input.target?.kind === '任务' && input.target.id === b.id ? { verdict: 'deny', rule: 'isolated-task-read-denied', reason: '当前任务不可读' } : decide(input);
    const view = await query(); assert.equal(view.汇总.交卷记录, 1); assert.equal(view.采用页.总数, 1); assert.ok(!JSON.stringify(view).includes(OTHER_STATEMENT));
    assert.equal((await query({ 知识id: source.id })).采用页.总数, 0); await assert.rejects(() => query({ 任务: b.id }), Denied);
  }));

  it('当前来源不可读时剥全部历史hash；来源内容变化仅标版本已变并拒旧快照续页', async () => scene(async ({ f, org, knowledge, task, submit, query }) => {
    const source = await knowledge(); const node = await task(); await submit(node, { 采用知识: [adoption(source.id)] });
    const first = await query(); const original = first.采用页.条目[0].采用知识[0].来源;
    const file = f.layout.memoryLog(P, '知识'); const rows = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
    rows.find(row => row.id === source.id).内容 = '独立篡改夹具的新版本'; await writeFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
    const changed = await query(); assert.equal(changed.采用页.条目[0].采用知识[0].当前来源, '版本已变');
    assert.equal(changed.采用页.条目[0].采用知识[0].来源.内容哈希, original.内容哈希);
    await assert.rejects(() => query({ 数据版本: first.数据版本, 偏移: 1 }), Denied);
    const decide = org.policy.decideCurrentSync.bind(org.policy);
    org.policy.decideCurrentSync = input => input.action === 'read' && input.target?.kind === '记忆' ? { verdict: 'deny', rule: 'source-read-now-denied', reason: PRIVATE_BODY } : decide(input);
    const hidden = await query(); const entry = hidden.采用页.条目[0].采用知识[0]; assert.deepEqual(entry.来源, { 状态: '来源未核验' });
    assert.equal(entry.当前版本, undefined); assert.equal(entry.当前来源, undefined); assert.ok(!JSON.stringify(hidden).includes(original.内容哈希)); assert.ok(!JSON.stringify(hidden).includes(PRIVATE_BODY));
    org.policy.decideCurrentSync = decide;
    await org.memory.purge(source.id, { subject: SOVEREIGN, 理由: '独立验证敏感来源删除后不从任务反馈取回旧hash', 敏感: true });
    const purged = await query(); assert.deepEqual(purged.采用页.条目[0].采用知识[0].来源, { 状态: '来源未核验' }); assert.ok(!JSON.stringify(purged).includes(original.内容哈希));
  }));

  it('大声明摘要总预算与实际下一偏移一致，稳定续页不漏重，查询不改业务与记忆', async () => scene(async ({ f, org, task, submit, query }) => {
    const node = await task(); const list = Array.from({ length: 16 }, (_, i) => adoption(`know-unknown-${i}`, { 用途: '用'.repeat(512), 适用判断: '判'.repeat(512), 说明: '说'.repeat(1024) }));
    for (let i = 0; i < 6; i++) await submit(node, { 采用知识: list });
    const files = [f.layout.taskLog(P), f.layout.goalLog(P), f.layout.goalBudgetLog(P), f.layout.identityFile(), f.layout.memoryLog(P, '知识')];
    const before = await Promise.all(files.map(file => readTextOrNull(file))); const first = await query({ 条数: 50 });
    assert.ok(first.采用页.hasMore); assert.equal(first.采用页.总数, 6); assert.ok(first.采用页.实际返回条目数 > 0); assert.ok(JSON.stringify(first).length <= 40000);
    const seen = []; let current = first;
    for (;;) {
      assert.equal(current.汇总.交卷记录, 6); assert.equal(current.采用页.实际返回条目数, current.采用页.条目.length); assert.equal(current.采用页.下一偏移, current.采用页.偏移 + current.采用页.条目.length);
      for (const record of current.采用页.条目) { seen.push(record.提交序); assert.ok(record.采用知识.every(item => item.用途.length <= 160 && item.字段截断.includes('用途'))); }
      if (!current.采用页.hasMore) break;
      current = await query({ 条数: 50, 偏移: current.采用页.下一偏移, 数据版本: first.数据版本 }); assert.ok(JSON.stringify(current).length <= 40000);
    }
    assert.equal(seen.length, 6); assert.equal(new Set(seen).size, 6); assert.deepEqual(await Promise.all(files.map(file => readTextOrNull(file))), before);
  }));

  it('交卷事件落盘后审计失败仍只有原声明和提交序，查询不补写或把它报成没提交', async () => scene(async ({ f, org, knowledge, task, submit, query, events }) => {
    const source = await knowledge(); const node = await task(); const append = org.audit.append.bind(org.audit);
    org.audit.append = async row => { if (row.对象?.id === node.id && row.结果 === 'submitted') throw new Error('isolated-submit-audit-failed'); return append(row); };
    await assert.rejects(() => submit(node, { 采用知识: [adoption(source.id)] }), error => error instanceof Fault && error.outcome.提交状态 === '已提交' && error.outcome.可重试 === false);
    const submitted = (await events()).filter(row => row.kind === 'submitted'); assert.equal(submitted.length, 1);
    const before = await readFile(f.layout.taskLog(P), 'utf8'); const view = await query(); assert.equal(view.采用页.总数, 1); assert.equal(view.采用页.条目[0].提交序, submitted[0].seq);
    assert.equal(await readFile(f.layout.taskLog(P), 'utf8'), before);
  }));
});
