import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { projectWorkbench } from '../src/workbench.js';
import { 是只读旧会审 } from '../src/tasks.js';
import { Org } from '../src/org.js';
import { Denied } from '../src/kernel/errors.js';
import { makeFixture, seedLegacyIndependentCouncil, LEAD } from './helpers.mjs';

const node = (id, 状态 = '已采纳', extra = {}) => ({
  id, 状态, 描述: id, 负责人: ['lead'], 判据: ['原判据'], 判据冻结: true,
  采纳: { 依据: '复核结论', 票: 'rv-5', 由: 'lead' }, ...extra,
});
const old = (id, 状态, extra) => node(id, 状态, { 模式: '独立会审', ...extra });
const view = (nodes) => projectWorkbench({ 项目: 'fixture', 节点: nodes });

test('只读类别单源保持原写闸语义且不吞并行分担/新节点', () => {
  assert.equal(是只读旧会审(null), false);
  assert.equal(是只读旧会审({}), false);
  assert.equal(是只读旧会审({ 模式: '并行分担' }), false);
  assert.equal(是只读旧会审({ 模式: '独立会审' }), true);
});

test('14旧已采纳留在总账但不再被催办不可能的结账', () => {
  const nodes = Array.from({ length: 14 }, (_, i) => old(`old-${i}`));
  nodes.push(node('current-adopted'));
  const result = view(nodes);
  assert.equal(result.任务.总数, 15);
  assert.equal(result.任务.计数.已采纳, 15);
  assert.equal(result.任务.只读历史数, 14);
  assert.equal(result.任务.现行未结账数, 1);
  assert.deepEqual(result.待你决定.filter(x => x.类型 === '待结账').map(x => x.节点), ['current-adopted']);
  for (const row of result.任务.节点.slice(0, 14)) {
    assert.equal(row.状态, '已采纳');
    assert.equal(row.只读历史, true);
    assert.match(row.写入说明, /不改不迁移/);
  }
});

test('各种旧历史子态不再产出待决/升级/采纳/确认写命令且状态桶仍守恒', () => {
  const nodes = [
    old('old-pending', '待决'),
    old('old-review', '已交卷', { 待采纳: { 票: 'rv-99', 复核者: 'r', 代: 1 } }),
    old('old-confirm', '已采纳', { 需Lead确认: true }),
    old('old-escalated', '已打回', { 升级: true, 打回次数: 2 }),
  ];
  const result = view(nodes);
  assert.deepEqual(result.待你决定, []);
  assert.equal(result.任务.计数.待决, 1);
  assert.equal(result.任务.计数.已交卷, 1);
  assert.equal(result.任务.计数.已采纳, 1);
  assert.equal(result.任务.计数.已打回, 1);
  assert.equal(result.任务.现行未结账数, 0);
  const rows = result.任务.节点;
  assert.equal(rows[1].待采纳.票, 'rv-99');
  assert.equal(rows[1].采纳命令, undefined);
  assert.equal(rows[2].需Lead确认, true);
  assert.equal(rows[2].确认命令, undefined);
});

test('四个非旧会审历史采纳待确认及真正待采纳/待决不能一起消隐', () => {
  const nodes = Array.from({ length: 4 }, (_, i) => node(`confirm-${i}`, '已采纳', { 需Lead确认: true }));
  nodes.push(node('review-ready', '已交卷', { 待采纳: { 票: 'rv-7', 复核者: 'r', 代: 1 } }));
  nodes.push(node('real-pending', '待决'));
  const result = view(nodes);
  assert.equal(result.待你决定.filter(x => x.类型 === '历史采纳待确认').length, 4);
  assert.equal(result.待你决定.filter(x => x.类型 === '待采纳').length, 1);
  assert.equal(result.待你决定.filter(x => x.类型 === '待决项').length, 1);
  assert.match(result.任务.节点[4].采纳命令, /票=rv-7/);
  assert.equal(result.任务.节点[0].确认命令, undefined, '旧票缺内容绑定时不提供无效确认命令');
  assert.match(result.任务.节点[0].交付物待补证, /另立节点/);
  assert.ok(result.待你决定.filter(x => x.类型 === '历史采纳待确认').every(x => !x.命令 && /另立节点/.test(x.原因)));
});

test('并行分担历史模式不是只读旧会审且合法已采纳仍可催结账', () => {
  const result = view([node('parallel', '已采纳', { 模式: '并行分担' })]);
  assert.equal(result.任务.只读历史数, 0);
  assert.equal(result.任务.节点[0].只读历史, undefined);
  assert.equal(result.待你决定[0].类型, '待结账');
});

test('投影不改原状态/票/冻结判据或原输入任何字节', () => {
  const original = old('immutable', '已采纳', { 需Lead确认: true });
  const before = JSON.stringify(original);
  Object.freeze(original.判据);
  Object.freeze(original.采纳);
  Object.freeze(original);
  const result = view([original]);
  assert.equal(JSON.stringify(original), before);
  assert.deepEqual(result.任务.节点[0].采纳, original.采纳);
  assert.deepEqual(result.任务.节点[0].判据, original.判据);
});

test('空数据明确是零历史/零现行而不是缺字段或幽灵待办', () => {
  const result = view([]);
  assert.equal(result.任务.总数, 0);
  assert.equal(result.任务.只读历史数, 0);
  assert.equal(result.任务.现行未结账数, 0);
  assert.deepEqual(result.待你决定, []);
});

test('真实TaskGraph和Bus仍恒拒旧会审写入且旧账字节不变', async () => {
  const f = await makeFixture();
  const project = 'readonly-history';
  try {
    const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project, clock: f.clock });
    const id = await seedLegacyIndependentCouncil(f, { 项目: project, id: 'task-legacy-readonly' });
    const before = await readFile(f.layout.taskLog(project));
    await assert.rejects(() => org.tasks.start(id, { subject: LEAD, 项目: project }), e => e instanceof Denied && /只读历史/.test(e.rule));
    await assert.rejects(() => org.tasks.settle(id, { subject: LEAD, 项目: project, 记忆处置: {} }), e => e instanceof Denied && /只读历史/.test(e.rule));
    await assert.rejects(() => org.bus.send({ subject: LEAD, 项目: project, 线程: id.toUpperCase(), 类型: '广播', 内容: '禁止写入历史', 收件: [] }), e => e instanceof Denied && /写入口已封闭/.test(e.rule));
    assert.deepEqual(await readFile(f.layout.taskLog(project)), before);
    const row = view([await org.tasks.get(id, { 项目: project })]).任务.节点[0];
    assert.equal(row.状态, '已派发');
    assert.equal(row.只读历史, true);
  } finally { await f.cleanup(); }
});
