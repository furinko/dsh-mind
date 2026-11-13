import { it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, LEAD, MEMBER, REVIEWER } from './helpers.mjs';
import { Org } from '../src/org.js';

const P = 'purpose-memory';
async function scene(run) {
  const f = await makeFixture(); const org = await Org.open({ ...f, project: P });
  try { await run(org); } finally { await org.observability.flush(); await f.cleanup(); }
}
it('归档作答按真实复核用途可读，专业名无特权；对象、代次与结束收口均生效', () => scene(async org => {
  const target = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '待核对成果', 负责人: 'Lead', 判据: ['可核对'] });
  await org.tasks.dispatch(target.id, { subject: LEAD, 项目: P });
  const answer = await org.memory.remember({ subject: LEAD, 项目: P, 类: '作答', 内容: '已归档的目标答案', 来源: '实际合成成果', 来源引用: [target.id] });
  const otherTask = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '其他任务', 负责人: 'Lead', 判据: ['另单'] });
  const unrelated = await org.memory.remember({ subject: LEAD, 项目: P, 类: '作答', 内容: '另一单私人答案', 来源: '其他合成成果', 来源引用: [otherTask.id] });
  await org.memory.archiveAnswers({ subject: LEAD, 项目: P });
  assert.equal((await org.memory.readableBy(answer.id, { 读者: REVIEWER, 项目: P })).可读, false, '复核专业没有用途不能读取归档答案');
  const review = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '由工程专业核对成果', 负责人: MEMBER.roleId,
    判据: ['如实核对'], 复核对象: [target.id] });
  await org.tasks.bind(review.id, { subject: LEAD, 项目: P, 实例: MEMBER.id, 岗位: MEMBER.roleId });
  await org.tasks.dispatch(review.id, { subject: LEAD, 项目: P });
  assert.equal((await org.memory.readableBy(answer.id, { 读者: MEMBER, 项目: P })).可读, true);
  assert.equal((await org.memory.readableBy(unrelated.id, { 读者: MEMBER, 项目: P })).可读, false);
  const visible = await org.memory.query({ subject: MEMBER, 读者: MEMBER, 项目: P, 类: '作答', 显式: true,
    读域: { 限定: false } });
  assert.deepEqual(visible.条目.map(row => row.id), [answer.id], '自报读域不能扩大实际对象');
  const fakeReader = await org.memory.query({ subject: MEMBER, 读者: LEAD, 项目: P, 类: '作答', 显式: true });
  assert.deepEqual(fakeReader.条目, [], '读者字段不能冒充治理身份');
  const owned = org.memory.ownedReadable.bind(org.memory); let closed = false;
  org.memory.ownedReadable = async (...args) => {
    const allowed = await owned(...args);
    if (!closed) { closed = true; await org.tasks.close(review.id, { subject: LEAD, 项目: P, 原因: '读取中复核用途结束' }); }
    return allowed;
  };
  await assert.rejects(org.memory.query({ subject: MEMBER, 读者: MEMBER, 项目: P, 类: '作答', 显式: true }), /复核用途或实际实例代次/);
  org.memory.ownedReadable = owned;
  assert.equal((await org.memory.readableBy(answer.id, { 读者: MEMBER, 项目: P })).可读, false);
}));

it('复核专业普通参会保持盲评，真实活动复核用途不能同时参与提案', () => scene(async org => {
  const normal = await org.council.open({ subject: LEAD, 项目: P, 问题: '普通专业咨询', 参与者: [REVIEWER.id, MEMBER.id] });
  await org.council.answer({ id: normal.id, subject: REVIEWER, 项目: P, 结论: '复核专业的普通建议', 结论层: '可验', 反例面: [] });
  const memberView = (await org.council.list({ 项目: P, 读者: MEMBER }))[0];
  const reviewerView = (await org.council.list({ 项目: P, 读者: REVIEWER }))[0];
  assert.equal(memberView.盲评遮罩, true); assert.equal(memberView.答案[0].结论, null);
  assert.equal(reviewerView.盲评遮罩, true);
  const target = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '核对目标', 负责人: 'Lead', 判据: ['可核对'] });
  const review = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '实际复核', 负责人: MEMBER.roleId, 判据: ['核对对象'], 复核对象: [target.id] });
  await org.tasks.bind(review.id, { subject: LEAD, 项目: P, 实例: MEMBER.id, 岗位: MEMBER.roleId });
  await org.tasks.dispatch(review.id, { subject: LEAD, 项目: P });
  await assert.rejects(org.council.open({ subject: LEAD, 项目: P, 问题: '不能混用真实复核用途', 参与者: [REVIEWER.id, MEMBER.id] }), /活动复核用途|当前持有本项目复核资料/);
}));

it('新记忆审计不复制来源正文，遗忘后程序持有的正式正文和来源一起删除', () => scene(async org => {
  const secret = 'SOURCE_PRIVATE_BODY_MUST_NOT_REMAIN_IN_AUDIT';
  const record = await org.memory.remember({ subject: LEAD, 项目: P, 类: '知识', 内容: '合成认识', 来源: { 谁: LEAD.id, 怎么知道: secret } });
  const events = await org.audit.read({});
  const event = events.find(row => row.动作 === '状态变更' && row.对象?.id === record.id);
  assert.ok(event.详情.来源摘要); assert.doesNotMatch(JSON.stringify(event), new RegExp(secret));
  await org.memory.organize({ subject: LEAD, 项目: P, op: 'forget', id: record.id, 原因: '合成遗忘' });
  assert.equal((await org.memory.query({ subject: LEAD, 项目: P, id: record.id })).条目.length, 0);
}));

it('明确岗位分享只筛选专业，复核专业普通任务可读而任意专业真实复核用途不可读', () => scene(async org => {
  const ordinary = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '复核专业的普通资料整理', 负责人: REVIEWER.roleId, 判据: ['整理资料'] });
  await org.tasks.bind(ordinary.id, { subject: LEAD, 项目: P, 实例: REVIEWER.id, 岗位: REVIEWER.roleId });
  await org.tasks.dispatch(ordinary.id, { subject: LEAD, 项目: P });
  const scope = { project: P, audience: 'roles', roles: [REVIEWER.roleId, MEMBER.roleId], relationship: null };
  assert.equal(await org.dataOwnership.allows(scope, REVIEWER, P), true);
  assert.equal(await org.dataOwnership.allows({ ...scope, roles: [MEMBER.roleId] }, REVIEWER, P), false, '保留明确分享岗位筛选');
  assert.equal(await org.dataOwnership.allows({ ...scope, audience: 'lead' }, REVIEWER, P), false, '私人Lead资料不因专业开放');
  assert.equal(await org.dataOwnership.allows(scope, REVIEWER, 'another-project'), false, '保留项目归属');
  const target = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '独立核对目标', 负责人: 'Lead', 判据: ['可核对'] });
  const review = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '技术专业承担真实复核', 负责人: MEMBER.roleId,
    判据: ['核对目标'], 复核对象: [target.id] });
  await org.tasks.bind(review.id, { subject: LEAD, 项目: P, 实例: MEMBER.id, 岗位: MEMBER.roleId });
  await org.tasks.dispatch(review.id, { subject: LEAD, 项目: P });
  assert.equal(await org.dataOwnership.allows(scope, MEMBER, P), false, '真实复核用途不借专业分享扩大读域');
}));
