import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, LEAD } from './helpers.mjs';
import { Org } from '../src/org.js';
import { runAction } from '../lib/actions.js';
import { NeedsApproval } from '../src/kernel/errors.js';

const P = 'approval-attention-terminal';
const HUMAN = { 通道: '隔离人侧测试入口', 认证: '宿主 Connection 已认证' };

async function scene(fn) {
  const f = await makeFixture({ defaults: { 介入度: '审批' } });
  try {
    const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
    await fn(org, f);
  } finally { await f.cleanup(); }
}

async function request(org, id) {
  return org.intervention.记请求({
    subject: LEAD, action: 'write', args: { id, 描述: `审批注意项 ${id}` },
    目标: { id, kind: '任务' }, 项目: P, 档位: '审批',
    步骤: [{ 动作: 'write', 目标: { id, kind: '任务' }, 说明: '更新任务', 预览: { id } }],
  });
}

async function decide(org, id, decision = '批准') {
  return org.intervention.人侧决议({ ...HUMAN, 请求id: id, 决定: decision });
}

async function consume(org, id) {
  const result = await org.intervention.校验放行({ 请求id: id, subject: LEAD, action: 'write' });
  assert.equal(result.ok, true);
  return result.占用;
}

async function attention(org) {
  return (await org.workbench({ 项目: P, 读者: LEAD })).待你决定.filter(item => item.类型 === '介入审批');
}

test('真实task_create批准完成后退出待决定，重建Org仍保留审批和任务历史', () => scene(async (org, f) => {
  const args = { action: 'task_create', 描述: '工作台完成审批正控', 负责人: 'lead', 判据: '只创建一次' };
  const run = input => runAction({ org, 项目: P, subject: LEAD, 主体: LEAD, 面: 'tool', args: input });
  let id;
  await assert.rejects(() => run(args), error => error instanceof NeedsApproval && (id = error.detail.请求id, true));
  assert.equal((await attention(org)).length, 1);
  await decide(org, id);
  assert.equal((await attention(org))[0].状态, '已批准待重放', '批准尚不等于已执行');
  const result = await run({ ...args, 审批引用: id });
  assert.ok(result.节点.id);
  const auditBefore = await org.audit.read({});
  assert.deepEqual(await attention(org), [], '已完成请求不能继续计入待你决定');
  assert.deepEqual(await org.audit.read({}), auditBefore, '工作台读数不改审批账本');
  assert.equal((await org.intervention.投影({ 项目: P })).find(row => row.请求id === id).状态, '已完成');
  assert.equal(auditBefore.filter(row => row.动作 === '介入完成' && row.对象?.id === id).length, 1);
  assert.equal((await org.tasks.list({ 项目: P })).length, 1);

  const reopened = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
  assert.deepEqual(await attention(reopened), []);
  assert.equal((await reopened.intervention.投影({ 项目: P })).find(row => row.请求id === id).状态, '已完成');
  assert.equal((await reopened.tasks.list({ 项目: P })).length, 1, '收起待办不删除真实任务');
}));

test('真实拒绝、撤销与当前档位失效仅退出待决定，历史投影和审计全部保留', () => scene(async (org, f) => {
  const rejected = await request(org, 'rejected');
  const revoked = await request(org, 'revoked');
  const stale = await request(org, 'stale');
  assert.equal((await attention(org)).length, 3);
  await decide(org, rejected.请求id, '拒绝');
  await decide(org, revoked.请求id, '撤销');
  assert.deepEqual((await attention(org)).map(row => row.状态), ['待放行']);

  await f.write('集体L2-共享基础设施/defaults/介入度.json', JSON.stringify({ 介入度: '预审' }));
  assert.equal(await org.policy.reload(), true);
  const auditBefore = await org.audit.read({});
  assert.deepEqual(await attention(org), []);
  const history = await org.intervention.投影({ 项目: P });
  assert.deepEqual(new Map(history.map(row => [row.请求id, row.状态])), new Map([
    [rejected.请求id, '已拒绝'], [revoked.请求id, '已撤销'], [stale.请求id, '已失效'],
  ]));
  assert.equal(auditBefore.filter(row => row.动作 === '介入请求').length, 3);
  assert.equal(auditBefore.filter(row => row.动作 === '介入决议').length, 2);
  assert.deepEqual(await org.audit.read({}), auditBefore, '过滤待办不追加失效或删除历史');
}));

test('真实待放行、已批准待重放、占用未报告和失败仍计入待决定，不掩盖需人工核对的尝试', () => scene(async org => {
  const pending = await request(org, 'pending');
  const approved = await request(org, 'approved');
  const occupied = await request(org, 'occupied');
  const failed = await request(org, 'failed');
  await decide(org, approved.请求id);
  await decide(org, occupied.请求id);
  await consume(org, occupied.请求id);
  await decide(org, failed.请求id);
  const failureClaim = await consume(org, failed.请求id);
  await org.intervention.记失败({ 请求id: failed.请求id, 主体: LEAD, 占用行: failureClaim, 项目: P, 原因: '真实执行未成功，需要重新决定' });

  const auditBefore = await org.audit.read({});
  const items = await attention(org);
  assert.equal(items.length, 4);
  assert.deepEqual(items.map(row => row.状态).sort(), ['待放行', '已批准待重放', '占用未报告', '失败'].sort());
  for (const item of items) assert.ok(item.命令.includes('intervention_resolve'));
  assert.deepEqual(items.find(row => row.状态 === '失败').可选项, ['批准', '拒绝', '撤销']);
  assert.deepEqual(items.find(row => row.状态 === '占用未报告').可选项, ['撤销']);
  assert.match(items.find(row => row.状态 === '占用未报告').原因, /人工复核.*不自动重跑/);
  assert.match(items.find(row => row.状态 === '失败').原因, /真实执行未成功.*不自动重试/);
  assert.equal((await org.intervention.投影({ 项目: P })).length, 4);
  assert.deepEqual(await org.audit.read({}), auditBefore);
  assert.ok(pending.请求id);
}));
