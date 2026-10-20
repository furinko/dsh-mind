/** 会审宏动作不能把已确认的创建、投递和补偿事实在包装时丢掉。 */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, LEAD } from './helpers.mjs';
import { Org } from '../src/org.js';
import { runAction } from '../lib/actions.js';
import { describeFailure } from '../src/kernel/errors.js';

const P = 'council-partial-outcome';

async function scene(run) {
  const f = await makeFixture();
  try {
    const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
    const calls = { spawn: 0, send: 0, drain: [] };
    const inbox = [];
    const host = {
      agent: { session: { id: 'lead-session' } },
      delegation: { authorize: () => ({ fingerprint: 'council-outcome-test' }) },
      subagents: {
        startContinuable: async () => ({ childId: `owned-${++calls.spawn}`, messageId: `initial-${calls.spawn}` }),
        sendMessage: async (_agent, id) => {
          calls.send += 1;
          const receipt = { messageId: `opening-${calls.send}` };
          inbox.push({ id, ...receipt });
          return receipt;
        },
        drainContinuableChildren: async (_agent, ids) => { calls.drain.push(...ids); },
      },
    };
    const open = () => runAction({ org, 项目: P, subject: LEAD, 主体: LEAD, 面: 'tool', 宿主: host,
      args: { action: 'debate_open', 方式: 'subagent', 问题: '故障不能抹去已确认事实', 参与岗位: '插件工程,插件工程' } });
    await run({ org, host, calls, inbox, open });
  } finally { await f.cleanup(); }
}

async function failed(fn) {
  try { await fn(); } catch (error) { return error; }
  assert.fail('故障必须明确报告，不能伪报完整成功');
}

it('第一实例成员创建审计失败：公开回执仍保留登记、封存及当前驻留释放事实', async () => scene(async ({ org, calls, open }) => {
  const append = org.audit.append.bind(org.audit);
  org.audit.append = async (row) => {
    if (row.动作 === '成员创建') throw new Error('member-created-audit-unavailable');
    return append(row);
  };
  const error = await failed(open);
  assert.equal(error.code, 'COUNCIL_CREATE_FAILED');
  const output = describeFailure(error);
  assert.equal(output.提交状态, '部分提交', '会审未打开不等于宿主/组织没有已发生事实');
  assert.equal(output.可重试, false);
  assert.ok(output.已确认阶段.some((stage) => stage.实例 === 'owned-1' && /登记/.test(stage.阶段)), '回调尚未return也必须保留已确认的登记');
  assert.ok(output.已确认阶段.some((stage) => stage.实例 === 'owned-1' && stage.已封存 === true));
  assert.ok(output.已确认阶段.some((stage) => stage.实例 === 'owned-1' && stage.当前驻留已释放 === true));
  assert.equal((await org.registry.identity()).members['owned-1'].status, '封存');
  assert.deepEqual(calls.drain, ['owned-1']);
  assert.equal(calls.spawn, 1);
  assert.equal(calls.send, 0);
  assert.ok(!Object.hasOwn(output, 'detail'));
}));

it('第二封开场书失败：保留第一封接收消息id，以及逐实例成功补偿回执', async () => scene(async ({ org, host, calls, inbox, open }) => {
  const send = host.subagents.sendMessage;
  host.subagents.sendMessage = async (...args) => {
    if (calls.send === 1) { calls.send += 1; throw new Error('second-opening-transport-failed'); }
    return send(...args);
  };
  const error = await failed(open);
  assert.equal(error.code, 'COUNCIL_SEND_FAILED');
  const output = describeFailure(error);
  assert.equal(output.提交状态, '部分提交');
  assert.equal(output.可重试, false);
  assert.equal(inbox.length, 1, '第一封确已被公共宿主接口接受');
  assert.ok(output.已确认阶段.some((stage) => stage.实例 === 'owned-1' && stage.消息id === inbox[0].messageId && stage.已接收 === true), '第二封失败不能抹去第一封已确认的inbox接收凭据');
  for (const id of ['owned-1', 'owned-2']) {
    assert.ok(output.已确认阶段.some((stage) => stage.实例 === id && stage.已封存 === true), `${id}封存回执`);
    assert.ok(output.已确认阶段.some((stage) => stage.实例 === id && stage.当前驻留已释放 === true), `${id}当前驻留释放回执`);
    assert.equal((await org.registry.identity()).members[id].status, '封存');
  }
  assert.equal((await org.council.list({ 项目: P }))[0].状态, '作废');
  assert.deepEqual(calls.drain, ['owned-2', 'owned-1']);
  assert.equal(calls.spawn, 2);
  assert.equal(calls.send, 2);
}));
