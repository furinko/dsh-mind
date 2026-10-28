import { it } from 'node:test';
import assert from 'node:assert/strict';
import { Org } from '../src/org.js';
import { makeFixture, LEAD, SOVEREIGN } from './helpers.mjs';

const project = 'continuity-tombstone-owner';
const spec = subject => ({ subject, project, session: subject.id });
const query = (org, subject) => org.memory.query({ subject, 读者: subject, 项目: project, 类: '偏好', 返回模式: '全文' });
const extract = input => ({ items: [{ id: 'lead-name', kind: '人格', scope: '部署', state: '有效',
  text: '用户希望称呼Lead为砚舟', sources: [input.messages[0].source], quotes: [input.messages[0].text] }] });
async function capture(org, subject, at) {
  const target = spec(subject); const seq = (await org.turnBuffer.position(target))?.nextSeq ?? 0;
  await org.turnBuffer.capture({ ...target, fromSeq: seq, throughSeq: seq + 3, records: [
    { seq, type: 'turn/start', turn: seq + 1, time: at },
    { seq: seq + 1, type: 'message', turn: seq + 1, role: 'user', text: '以后叫你砚舟。', id: `m-${seq}`,
      clipped: false, interrupted: false, time: at },
    { seq: seq + 2, type: 'turn/end', turn: seq + 1, reason: 'completed', time: at },
  ] });
  await org.continuityCapture.touch(target);
}
async function bind(org, subject, relationship) {
  await org.information.admin({ subject: SOVEREIGN, project }, { op: 'relationship',
    expectedRevision: (await org.information.load()).configRevision, session: subject.id, relationship });
}
async function scene(run) {
  const f = await makeFixture();
  const config = { home: f.home, privateRoot: f.privateRoot, factoryRoot: f.factoryRoot, project };
  const org = await Org.open(config);
  try { await run(org, config); } finally { await org.observability.flush(); await f.cleanup(); }
}
for (const operation of ['purge', 'invalidate', 'demote']) {
  it(`默认同主人跨聊天及服务重开承接${operation}屏障，仅真正后续来源可恢复`, async () => scene(async (org, config) => {
    const at = Date.now() - 20000;
    await capture(org, LEAD, at);
    await org.continuityCapture.update(spec(LEAD), { extract });
    const original = (await query(org, LEAD)).条目[0];
    await org.memory[operation](original.id, { subject: SOVEREIGN, 理由: '明确遗忘旧称呼', 原因: '明确停止旧称呼' });
    const reopened = await Org.open(config);
    const next = { id: 'restored-default-owner-chat', kind: 'Lead' };
    await reopened.registry.assign({ subject: SOVEREIGN, 岗位: 'Lead', 实例: next.id });
    assert.equal(await reopened.dataOwnership.related(LEAD.id, next.id), true);
    await capture(reopened, next, at + 1000);
    const pending = await reopened.memory.pendingContinuityExpressions({ subject: next, project,
      expressions: [{ 时间: at + 1000, 文本: '以后叫你砚舟。' }] });
    assert.equal(pending.length, 0, '旧原话不可从另一默认聊天重新注入');
    await reopened.continuityCapture.update(spec(next), { extract });
    assert.equal((await query(reopened, next)).条目.filter(r => r.状态 === '有效').length, 0, '旧原话不可重新生成有效偏好');
    await capture(reopened, next, Date.now() + 1000);
    await reopened.continuityCapture.update(spec(next), { extract });
    assert.equal((await query(reopened, next)).条目.filter(r => r.状态 === '有效').length, 1, '真正后续用户表达仍能更新偏好');
    await reopened.observability.flush();
  }));
}
it('显式同关系承接屏障，不将一个主人的停用扩散到其他关系', async () => scene(async org => {
  const at = Date.now() - 20000;
  await bind(org, LEAD, 'explicit-owner');
  await capture(org, LEAD, at);
  await org.continuityCapture.update(spec(LEAD), { extract });
  await org.memory.purge((await query(org, LEAD)).条目[0].id, { subject: SOVEREIGN, 理由: '明确删除' });
  for (const [id, relationship, blocked] of [['same-owner', 'explicit-owner', true], ['foreign-owner', 'another-owner', false], ['default-owner', null, false]]) {
    const subject = { id, kind: 'Lead' };
    await org.registry.assign({ subject: SOVEREIGN, 岗位: 'Lead', 实例: id });
    await bind(org, subject, relationship);
    await capture(org, subject, at + 1000);
    const pending = await org.memory.pendingContinuityExpressions({ subject, project, expressions: [{ 时间: at + 1000, 文本: '以后叫你砚舟。' }] });
    assert.equal(pending.length, blocked ? 0 : 1);
    await org.continuityCapture.update(spec(subject), { extract });
    assert.equal((await query(org, subject)).条目.length, blocked ? 0 : 1);
  }
}));
it('人侧解除显式关联后，旧散列墓碑按当前默认主人归属生效', async () => scene(async org => {
  const at = Date.now() - 20000;
  await bind(org, LEAD, 'previous-owner');
  await capture(org, LEAD, at);
  await org.continuityCapture.update(spec(LEAD), { extract });
  await org.memory.purge((await query(org, LEAD)).条目[0].id, { subject: SOVEREIGN, 理由: '明确删除' });
  await bind(org, LEAD, null);
  const next = { id: 'new-default-owner', kind: 'Lead' };
  await org.registry.assign({ subject: SOVEREIGN, 岗位: 'Lead', 实例: next.id });
  await capture(org, next, at + 1000);
  await org.continuityCapture.update(spec(next), { extract });
  assert.equal((await query(org, next)).条目.length, 0);
}));
