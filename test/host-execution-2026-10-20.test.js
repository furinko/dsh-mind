import { it } from 'node:test';
import assert from 'node:assert/strict';
import { assertExecutionHost, createExecution, releaseExecution, requestExecutionInterrupt, sendExecutionMessage } from '../lib/host-execution.js';
import { describeFailure } from '../src/kernel/errors.js';

function fixture() {
  const agent = { session: { id: 'parent-exact' } }, signal = new AbortController().signal;
  const calls = { start: [], release: [], interrupt: [], send: [], oneShot: 0 };
  const subagents = {
    async startContinuable(spec) { assert.equal(this, subagents); calls.start.push(spec); return { childId: 'durable-child', messageId: 'inbox-initial' }; },
    async sendMessage(parent, id, content, options) { assert.equal(this, subagents); calls.send.push({ parent, id, content, options }); return 'inbox-next'; },
    async drainContinuableChildren(parent, ids) { assert.equal(this, subagents); calls.release.push({ parent, ids }); },
    interrupt(id, authority) { assert.equal(this, subagents); calls.interrupt.push({ id, authority }); },
    async start() { calls.oneShot++; throw Error('one-shot must never be called'); },
  };
  const host = { agent, signal, subagents };
  return { agent, signal, calls, subagents, host, args: { host, mode: 'subagent', name: 'child', description: 'org child', standby: 'wait for task' } };
}

it('public continuable creation passes exact Agent and outer signal, preserves model route and accepted inbox ids', async () => {
  const f = fixture(); const modelRoute = { provider: 'p', model: 'm', reasoningEffort: 'high' };
  const result = await createExecution({ ...f.args, modelRoute });
  assert.equal(f.calls.start.length, 1); assert.equal(f.calls.oneShot, 0);
  assert.equal(f.calls.start[0].request.parent, f.agent); assert.equal(f.calls.start[0].signal, f.signal);
  assert.equal(Object.hasOwn(f.calls.start[0].request, 'signal'), false); assert.equal(f.calls.start[0].request.agentOptions, modelRoute);
  assert.equal(result.实例, 'durable-child'); assert.equal(result.初始消息id, 'inbox-initial'); assert.equal(result.初始消息已接收, true); assert.equal(result.执行完成, null);
});

for (const missing of ['startContinuable', 'sendMessage', 'drainContinuableChildren']) it(`missing public ${missing} rejects before any spawn, with no internal/one-shot fallback`, async () => {
  const f = fixture(); delete f.subagents[missing];
  f.subagents.startActivation = async () => { throw Error('unverified old API'); };
  f.subagents.manager = { drainChildren() { throw Error('internal manager forbidden'); } };
  await assert.rejects(createExecution(f.args), error => error.code === 'MEMBER_SPAWN_CONTRACT' && error.detail.缺.includes(missing));
  assert.equal(f.calls.start.length, 0); assert.equal(f.calls.oneShot, 0);
});

it('child identity without initial inbox receipt is partial/unknown and never reported ready', async () => {
  const f = fixture(); f.subagents.startContinuable = async () => ({ childId: 'observed-id' });
  await assert.rejects(createExecution(f.args), error => error.code === 'MEMBER_SPAWN_RECEIPT_UNKNOWN' && error.detail.实例 === 'observed-id' && error.detail.可重试 === false && error.detail.初始消息已接收 === null && describeFailure(error).已确认阶段[0].实例 === 'observed-id' && describeFailure(error).提交状态 === '未知');
});

it('interrupt void/no-op receipt means only requested, never stopped', async () => {
  const f = fixture(); const result = await requestExecutionInterrupt({ host: f.host, mode: 'subagent', agent: f.agent, id: 'absent-is-allowed' });
  assert.equal(result.已请求中断, true); assert.equal(result.已停, null);
  assert.equal(f.calls.interrupt[0].authority.agent, f.agent); assert.equal(f.calls.interrupt[0].authority.kind, 'ancestor');
  assert.equal(f.calls.release.length, 0);
});

it('selected resident release awaits public promise and does not assert durable deletion or completed work', async () => {
  const f = fixture(); let complete; let settled = false;
  f.subagents.drainContinuableChildren = async function (parent, ids) {
    assert.equal(this, f.subagents); assert.equal(parent, f.agent); assert.deepEqual(ids, ['durable-child']);
    await new Promise(resolve => { complete = resolve; });
  };
  const pending = releaseExecution({ host: f.host, mode: 'subagent', agent: f.agent, id: 'durable-child' }).then(value => { settled = true; return value; });
  await Promise.resolve(); assert.equal(settled, false); complete();
  const result = await pending; assert.equal(result.当前驻留已释放, true); assert.equal(result.已停, null); assert.equal(result.持久子会话已删除, false);
});

it('release rejection or missing capability is loud, with no interrupt-only false confirmation', async () => {
  const f = fixture(); delete f.subagents.drainContinuableChildren;
  await assert.rejects(releaseExecution({ host: f.host, mode: 'subagent', agent: f.agent, id: 'child' }), error => error.code === 'COUNCIL_ADAPTER_NOT_READY');
  assert.equal(f.calls.interrupt.length, 0);
  const error = Error('host release failed'); f.subagents.drainContinuableChildren = async () => { throw error; };
  await assert.rejects(releaseExecution({ host: f.host, mode: 'subagent', agent: f.agent, id: 'child' }), actual => actual.cause === error && actual.code === 'MEMBER_RELEASE_UNKNOWN' && actual.outcome.提交状态 === '未知' && actual.outcome.可重试 === false);
});

it('message receipt confirms inbox acceptance only; unknown receipt cannot imply processed or completed', async () => {
  const f = fixture(); const args = { host: f.host, mode: 'subagent', agent: f.agent, signal: f.signal, id: 'durable-child', content: 'work' };
  const result = await sendExecutionMessage(args); assert.equal(result.messageId, 'inbox-next'); assert.equal(result.已接收, true); assert.equal(result.已处理, null); assert.equal(result.执行完成, null);
  assert.equal(f.calls.send[0].parent, f.agent); assert.equal(f.calls.send[0].options.signal, f.signal);
  f.subagents.sendMessage = async () => undefined;
  await assert.rejects(sendExecutionMessage(args), error => error.code === 'MEMBER_MESSAGE_RECEIPT_UNKNOWN' && error.detail.可重试 === false);
});

it('Team interrupt remains request-only; no installed completion contract is invented', async () => {
  const f = fixture(); f.host.agentTeams = { interrupt() {} };
  const result = await releaseExecution({ host: f.host, mode: 'team', agent: f.agent, id: 'team-child', teamName: 'exact-name' });
  assert.equal(result.已请求中断, true); assert.equal(result.已停, null); assert.equal(result.当前驻留已释放, undefined);
});

it('host creation/message exceptions keep results unknown without exposing raw host content or retry advice', async () => {
  const f = fixture(); const secret = 'PRIVATE-HOST-AND-CONTENT';
  f.subagents.startContinuable = async () => { f.calls.start.push('attempt'); throw Error(secret); };
  await assert.rejects(createExecution(f.args), error => {
    const reply = describeFailure(error);
    assert.equal(reply.提交状态, '未知'); assert.equal(reply.可重试, false);
    assert.deepEqual(reply.已确认阶段, []); assert.doesNotMatch(JSON.stringify(reply), /PRIVATE-/); return true;
  });
  assert.equal(f.calls.start.length, 1);
  f.subagents.sendMessage = async () => { f.calls.send.push('attempt'); throw Error(secret); };
  await assert.rejects(sendExecutionMessage({ host: f.host, mode: 'subagent', agent: f.agent, id: 'child', content: secret }), error => {
    const reply = describeFailure(error);
    assert.equal(reply.提交状态, '未知'); assert.equal(reply.可重试, false);
    assert.equal(reply.已确认阶段[0].已请求, true); assert.doesNotMatch(JSON.stringify(reply), /PRIVATE-/); return true;
  });
  assert.equal(f.calls.send.length, 1);
});
