import { it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import { Org } from '../src/org.js';
import { runAction } from '../lib/actions.js';
import { readTaskLedger } from '../src/task-ledger.js';
import { makeFixture, LEAD, MEMBER, REVIEWER, SOVEREIGN } from './helpers.mjs';

const P = 'review-task-lifetime';
const denied = error => error?.code === 'DENIED';
async function scene(body) {
  const f = await makeFixture(); let org;
  try {
    org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
    const lead = { subject: LEAD, 项目: P };
    const reviewer = { subject: REVIEWER, 项目: P };
    const run = (subject, args) => runAction({ org, 项目: P, 主体: subject, args });
    const business = await org.tasks.create({ ...lead, 描述: '真实业务交付', 负责人: ['插件工程'], 判据: ['核对交付'] });
    await org.tasks.bind(business.id, { ...lead, 实例: MEMBER.id, 岗位: MEMBER.roleId });
    await org.tasks.dispatch(business.id, lead);
    await org.tasks.start(business.id, { subject: MEMBER, 项目: P });
    await org.tasks.submit(business.id, { subject: MEMBER, 项目: P, 结论: '交付结果' });
    const review = await org.tasks.create({ ...lead, 描述: '独立复核', 负责人: ['复核员'], 判据: ['独立核对'], 复核对象: [business.id] });
    await org.tasks.bind(review.id, { ...lead, 实例: REVIEWER.id, 岗位: REVIEWER.roleId });
    const vote = () => run({ id: REVIEWER.id, kind: '成员' }, { action: 'task_review', id: business.id, 三态: '过' });
    const noVote = async () => {
      await assert.rejects(vote, denied);
      assert.equal((await org.tasks.events({ 项目: P })).filter(e => e.id === business.id && e.kind === 'reviewed').length, 0);
      assert.equal((await org.tasks.get(business.id, { 项目: P })).状态, '已交卷');
    };
    await body({ f, org, lead, reviewer, business, review, run, vote, noVote });
  } finally { await org?.observability.flush(); await f.cleanup(); }
}

it('尚未派发的复核任务不能提前授权出票', () => scene(async ({ noVote }) => { await noVote(); }));

it('复核任务终止后原在岗复核员不能再出票', () => scene(async ({ org, lead, review, noVote }) => {
  await org.tasks.dispatch(review.id, lead);
  await org.tasks.close(review.id, { ...lead, 原因: '撤回该次复核' });
  assert.equal((await org.registry.identity()).members[REVIEWER.id].status, '在岗');
  await noVote();
}));

for (const settle of [false, true]) it(`复核报告已${settle ? '结账' : '采纳'}后不再授权新业务票`, () => scene(async ({ org, lead, reviewer, review, noVote }) => {
  await org.tasks.dispatch(review.id, lead);
  await org.tasks.start(review.id, reviewer);
  await org.tasks.submit(review.id, { ...reviewer, 结论: '完成独立复核报告' });
  const reportVote = await org.tasks.review(review.id, { ...lead, 三态: '过' });
  await org.tasks.accept(review.id, { ...lead, 票: reportVote.待采纳.票 });
  if (settle) await org.tasks.settle(review.id, { ...lead, 记忆处置: {} });
  await noVote();
}));

for (const submitted of [false, true]) it(`当前有效复核绑定${submitted ? '已交报告后' : '已派发后'}仍能出票并由Lead采纳`, () => scene(async ({ org, lead, reviewer, review, business, run, vote }) => {
  await org.tasks.dispatch(review.id, lead);
  if (submitted) {
    await org.tasks.start(review.id, reviewer);
    await org.tasks.submit(review.id, { ...reviewer, 结论: '独立报告已提交，业务票随后出具' });
  }
  const response = await vote();
  assert.match(response.结论.票, /^rv-\d+$/);
  assert.equal((await run(LEAD, { action: 'task_accept', id: business.id, 票: response.结论.票 })).节点.状态, '已采纳');
}));

it('历史无凭证绑定不能冒充当前复核授权', () => scene(async ({ org, lead, review, noVote }) => {
  await org.tasks.dispatch(review.id, lead);
  const file = org.layout.taskLog(P); const rows = await readTaskLedger(file);
  await appendFile(file, JSON.stringify({ seq: rows.length + 1, at: new Date().toISOString(), by: LEAD,
    kind: 'bound', id: review.id, 绑定: { 实例: REVIEWER.id, 岗位: REVIEWER.roleId, 于: new Date().toISOString() } }) + '\n');
  await noVote();
}));

it('同id复核员换实例代次不能继承旧任务出票权', () => scene(async ({ org, lead, review, noVote }) => {
  await org.tasks.dispatch(review.id, lead);
  await org.registry.seal({ subject: SOVEREIGN, 实例: REVIEWER.id, 理由: '旧实例结束' });
  await org.registry.assign({ subject: SOVEREIGN, 实例: REVIEWER.id, 岗位: '插件工程' });
  await org.registry.seal({ subject: SOVEREIGN, 实例: REVIEWER.id, 理由: '重新进入复核岗' });
  await org.registry.assign({ subject: SOVEREIGN, 实例: REVIEWER.id, 岗位: REVIEWER.roleId, 代: 2 });
  await noVote();
}));

it('复核预检后任务被终止，写账锁内重新核验而不落旧票', () => scene(async ({ org, lead, review, noVote }) => {
  await org.tasks.dispatch(review.id, lead);
  const list = org.tasks.list.bind(org.tasks); let closed = false;
  org.tasks.list = async spec => {
    const snapshot = await list(spec);
    if (!closed) { closed = true; await org.tasks.close(review.id, { ...lead, 原因: '在预检快照与出票之间撤回' }); }
    return snapshot;
  };
  await noVote();
  assert.equal(closed, true);
  assert.equal((await org.tasks.get(review.id, { 项目: P })).状态, '已终止');
}));

it('封存复核员仍由身份闸拒绝，Lead独立验收不要求虚构复核任务', () => scene(async ({ org, lead, review, business, noVote, run }) => {
  await org.tasks.dispatch(review.id, lead);
  await org.registry.seal({ subject: SOVEREIGN, 实例: REVIEWER.id, 理由: '撤回身份' });
  await noVote();
  const response = await run(LEAD, { action: 'task_review', id: business.id, 三态: '过' });
  assert.match(response.结论.票, /^rv-\d+$/);
}));

it('Lead独立验收审批重放的锁内重复核验不重复消耗同一张许可', () => scene(async ({ f, org, lead, review, business, run }) => {
  await org.tasks.dispatch(review.id, lead);
  await f.write('集体L2-共享基础设施/defaults/介入度.json', JSON.stringify({ 介入度: '审批' }));
  await org.policy.reload();
  const args = { action: 'task_review', id: business.id, 三态: '过' }; let requestId;
  await assert.rejects(() => run(LEAD, args), error => {
    requestId = error?.detail?.请求id; return error?.code === 'NEEDS_APPROVAL' && typeof requestId === 'string';
  });
  await org.intervention.人侧决议({ 请求id: requestId, 决定: '批准', 通道: '设置页', 认证: '宿主 Connection 已认证' });
  const response = await run(LEAD, { ...args, 审批引用: requestId });
  assert.match(response.结论.票, /^rv-\d+$/);
  assert.equal((await org.tasks.events({ 项目: P })).filter(e => e.id === business.id && e.kind === 'reviewed').length, 1);
  await assert.rejects(() => run(LEAD, { ...args, 审批引用: requestId }), denied);
}));
