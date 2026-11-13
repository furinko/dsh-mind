import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { makeFixture, LEAD, MEMBER, REVIEWER, seedReviewRelation } from './helpers.mjs';
import { Org } from '../src/org.js';
import { 已被合法采纳, fold } from '../src/tasks.js';

const P = 'redesign-synthetic-work';
const direct = { 方式: '直接检查', 结论: '过', 证据: ['合成产物经实际检查符合判据；这是作者直接检查，不是独立验收'] };
async function fixture(fn) {
  const f = await makeFixture();
  try {
    const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
    await fn(org, f);
  } finally { await f.cleanup(); }
}
async function submitted(org, extra = {}) {
  const n = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '合成工作', 负责人: 'Lead', 判据: ['合成成果可查'], ...extra });
  const d = await org.tasks.dispatch(n.id, { subject: LEAD, 项目: P });
  assert.equal(d.绑定[0].实例, LEAD.id, '可判定自领自动绑定真实当前 Lead');
  await org.tasks.start(n.id, { subject: LEAD, 项目: P });
  return org.tasks.submit(n.id, { subject: LEAD, 项目: P, 结论: '实际完成', 知识候选: ['待学习的合成经历'] });
}

test('Lead 可直接检查自己的实际交付；不产生独立票，知识服务失败仍交付且必要作答收口成功', () => fixture(async (org) => {
  const n = await submitted(org);
  const adopted = await org.tasks.accept(n.id, { subject: LEAD, 项目: P, 验证: direct });
  assert.equal(adopted.采纳.依据, '直接检查');
  assert.equal(adopted.采纳.票, null);
  assert.equal(adopted.采纳.独立复核, false);
  assert.equal(已被合法采纳(adopted), true);
  const archive = org.memory.archiveAnswers.bind(org.memory);
  let closed = 0;
  org.memory.archiveAnswers = async spec => { closed++; return archive(spec); };
  org.memory.settleCandidates = async () => { throw new Error('合成知识存储失败'); };
  const settled = await org.tasks.settle(n.id, { subject: LEAD, 项目: P, 记忆处置: { [`候选/${LEAD.id}/0`]: '晋升' } });
  assert.equal(settled.状态, '已结账');
  assert.equal(settled.学习整理.状态, '失败');
  assert.match(settled.学习整理.原因, /合成知识存储失败/);
  assert.equal(closed, 1);
}));

test('明确独立复核与未迁移旧任务不能被直接检查取代；未验、空证据不得冒充成功', () => fixture(async (org) => {
  const independent = await submitted(org, { 验证要求: '独立复核' });
  await assert.rejects(org.tasks.accept(independent.id, { subject: LEAD, 项目: P, 验证: direct }), /独立复核/);
  const normal = await submitted(org);
  await assert.rejects(org.tasks.accept(normal.id, { subject: LEAD, 项目: P, 验证: { ...direct, 证据: [] } }), /实际检查结果/);
  await assert.rejects(org.tasks.accept(normal.id, { subject: LEAD, 项目: P, 验证: { ...direct, 结论: '未验' } }), /未验/);
  await assert.rejects(org.tasks.accept(normal.id, { subject: MEMBER, 项目: P, 验证: direct }), /Lead/);
  assert.equal(fold([{ kind: 'created', id: 'old', 判据: ['x'], 负责人: ['lead'] }]).get('old').验证要求, undefined, '旧任务不追认新验证方式');
}));

test('不带知识处置即可完成；作答访问收口失败仍阻断结账，修复接线后可以重试', () => fixture(async (org) => {
  const n = await submitted(org);
  await org.tasks.accept(n.id, { subject: LEAD, 项目: P, 验证: direct });
  const archive = org.memory.archiveAnswers;
  org.memory.archiveAnswers = async () => { throw new Error('合成访问收口失败'); };
  await assert.rejects(org.tasks.settle(n.id, { subject: LEAD, 项目: P }), /合成访问收口失败/);
  assert.equal((await org.tasks.get(n.id, { 项目: P })).状态, '已采纳');
  org.memory.archiveAnswers = archive;
  assert.equal((await org.tasks.settle(n.id, { subject: LEAD, 项目: P })).状态, '已结账');
}));

test('知识事件已提交但审计失败时记录待核对，工作仍可收口且不建议重放知识写入', () => fixture(async (org) => {
  const n = await submitted(org);
  await org.tasks.accept(n.id, { subject: LEAD, 项目: P, 验证: direct });
  const append = org.audit.append.bind(org.audit);
  org.audit.append = async event => {
    if (event.结果 === 'knowledge_organized') throw new Error('合成知识整理审计失败');
    return append(event);
  };
  const settled = await org.tasks.settle(n.id, { subject: LEAD, 项目: P, 记忆处置: { [`候选/${LEAD.id}/0`]: '晋升' } });
  assert.equal(settled.状态, '已结账');
  assert.equal(settled.学习整理.状态, '待核对');
  assert.equal(settled.学习整理.可重试, false);
  assert.equal(Object.keys(settled.记忆晋升).length, 1, '真实知识产物仍可核对');
}));

test('中断核对保留部分成果；未知结果等待，核实后接手不重放工具、不覆盖原作者', () => fixture(async (org, f) => {
  const n = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '中断的合成工作', 负责人: MEMBER.id, 判据: ['保留成果'] });
  await org.tasks.bind(n.id, { subject: LEAD, 项目: P, 实例: MEMBER.id, 岗位: MEMBER.roleId });
  await org.tasks.dispatch(n.id, { subject: LEAD, 项目: P });
  await org.tasks.start(n.id, { subject: MEMBER, 项目: P });
  const artifact = join(f.home, 'partial-output.txt');
  await writeFile(artifact, '真实已发生的合成部分成果');
  await org.tasks.attach(n.id, { subject: LEAD, 项目: P, 产出物: artifact });
  const check = { 说明: '已核对中断前实际结果', 产物: [artifact], 副作用: [{ 引用: 'isolated-op-1', 状态: '未知' }], 执行状态: '未知' };
  const waiting = await org.tasks.reconcile(n.id, { subject: LEAD, 项目: P, 决策: '接手', 核对: check });
  assert.equal(waiting.可继续, false);
  assert.equal(waiting.已重放工具, false);
  await assert.rejects(org.tasks.submit(n.id, { subject: MEMBER, 项目: P, 结论: '不能把未知说成功' }), /未知/);
  const resumed = await org.tasks.reconcile(n.id, { subject: LEAD, 项目: P, 决策: '接手', 核对: { ...check, 副作用: [{ 引用: 'isolated-op-1-actual-receipt', 状态: '已发生' }], 执行状态: '已结束', 执行回执: 'isolated-host-ended-receipt' } });
  assert.equal(resumed.可继续, true);
  assert.equal(resumed.已重放工具, false);
  assert.equal(resumed.节点.绑定[0].实例, LEAD.id);
  assert.equal(resumed.节点.历史执行者[0].实例, MEMBER.id);
  assert.equal(resumed.节点.状态, '执行中');
  assert.deepEqual(resumed.节点.产出物引用, [artifact]);
  assert.equal(await readFile(artifact, 'utf8'), '真实已发生的合成部分成果');
  const rows = (await readFile(f.layout.taskLog(P), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(row => row.kind === 'reconciled').length, 2);
  assert.equal(rows.filter(row => row.kind === 'submitted').length, 0);
  await org.tasks.submit(n.id,{subject:LEAD,项目:P,结论:'接手后完成余下部分'});
  await assert.rejects(org.tasks.review(n.id,{subject:MEMBER,项目:P,三态:'过'}),/执行者复核自己的/,'原执行者未曾交卷也不能在换人后冒充独立复核');
}));

test('恢复时发现交付内容变化则撤销待采纳旧票，换人不洗掉原执行者的复核冲突', () => fixture(async (org,f) => {
  const workspace = join(f.home,'workspace'); await mkdir(workspace);
  org.tasks.configureToolFiles({read:[workspace],write:[workspace]});
  const n = await org.tasks.create({subject:LEAD,项目:P,描述:'复核版本恢复',负责人:MEMBER.id,判据:['原内容可核']});
  await org.tasks.bind(n.id,{subject:LEAD,项目:P,实例:MEMBER.id,岗位:MEMBER.roleId});
  await org.tasks.dispatch(n.id,{subject:LEAD,项目:P,工具文件范围:{读:[workspace],写:[workspace]}});
  await org.tasks.start(n.id,{subject:MEMBER,项目:P});
  const artifact = join(workspace,'reviewed-output.txt');
  await writeFile(artifact,'version one');
  await org.tasks.attach(n.id,{subject:LEAD,项目:P,产出物:artifact});
  await org.tasks.submit(n.id,{subject:MEMBER,项目:P,结论:'交付第一版'});
  const reviewTask = await seedReviewRelation(f,{项目:P,目标:n.id});
  await org.tasks.attach(reviewTask,{subject:LEAD,项目:P,产出物:artifact,读根:true});
  const reviewed=await org.tasks.review(n.id,{subject:REVIEWER,项目:P,三态:'过'});
  assert.ok(reviewed.待采纳.票);
  await writeFile(artifact,'version two after interruption');
  const recovered=await org.tasks.reconcile(n.id,{subject:LEAD,项目:P,决策:'接手',核对:{说明:'原作者结束后发现后续内容改变',产物:[artifact],副作用:[],执行状态:'已结束',执行回执:'synthetic-host-receipt'}});
  assert.equal(recovered.节点.待采纳,undefined);
  assert.equal(recovered.节点.复核经过[0].三态,'过','原版本真实复核结果不篡改');
  await assert.rejects(org.tasks.accept(n.id,{subject:LEAD,项目:P,票:reviewed.待采纳.票}),/当前有效票=无|失效/);
  await assert.rejects(org.tasks.review(n.id,{subject:MEMBER,项目:P,三态:'过'}),/复核自己的/);
}));
