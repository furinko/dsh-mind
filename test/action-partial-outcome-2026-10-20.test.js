/** 独立检查真实动作链的部分提交回执；故障只注入落线后的外部确认点。 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, LEAD } from './helpers.mjs';
import { Org } from '../src/org.js';
import { runAction } from '../lib/actions.js';
import { readTaskLedger } from '../src/task-ledger.js';
import { Fault, NeedsApproval, Denied, describeFailure } from '../src/kernel/errors.js';

const P = 'action-partial-outcome';

async function scene(run) {
  const f = await makeFixture();
  try {
    const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
    const calls = { spawn: 0, send: 0, release: 0 };
    const inbox = [];
    const host = {
      agent: { session: { id: 'outcome-lead' } },
      delegation: { authorize: () => ({ fingerprint: 'outcome-test-authority' }) },
      subagents: {
        startContinuable: async () => ({ childId: `outcome-child-${++calls.spawn}`, messageId: 'initial-received' }),
        sendMessage: async (_parent, id, content) => {
          calls.send += 1;
          const receipt = { messageId: `accepted-work-${calls.send}` };
          inbox.push({ id, content, ...receipt });
          return receipt;
        },
        drainContinuableChildren: async () => { calls.release += 1; },
      },
    };
    const act = (args) => runAction({ org, 项目: P, subject: LEAD, 主体: LEAD, 面: 'tool', 宿主: host, args });
    const create = () => org.tasks.create({ subject: LEAD, 项目: P, 描述: '部分回执验收', 负责人: '插件工程', 判据: ['交付可核对'] });
    const approvalLevel = async () => {
      await f.write('集体L2-共享基础设施/defaults/介入度.json', JSON.stringify({ 介入度: '审批' }));
      await org.policy.reload();
    };
    const approve = async (args) => {
      let requestId;
      await assert.rejects(() => act(args), (e) => e instanceof NeedsApproval && Boolean(requestId = e.detail.请求id));
      await org.intervention.人侧决议({ 请求id: requestId, 决定: '批准', 通道: '设置页', 认证: '宿主 Connection 已认证' });
      return requestId;
    };
    await run({ f, org, host, calls, inbox, act, create, approvalLevel, approve });
  } finally { await f.cleanup(); }
}

const spawnArgs = (node) => ({ action: 'member_spawn', 方式: 'subagent', 岗位: '插件工程', 节点: node.id, 任务书: '完成已冻结交付' });

async function failed(fn) {
  try { await fn(); } catch (error) { return error; }
  assert.fail('应取得故障及部分提交回执，不能伪报完整成功');
}

function partial(error, state = '部分提交') {
  assert.ok(error instanceof Fault);
  const output = describeFailure(error);
  assert.equal(output.结果, '执行未完整收尾');
  assert.equal(output.提交状态, state);
  assert.equal(output.可重试, false);
  assert.ok(Array.isArray(output.已确认阶段));
  assert.ok(!Object.hasOwn(output, 'detail'), '公开故障不能顺手展开原始detail');
  return output;
}

async function assertDispatched(org, node, id) {
  const current = await org.tasks.get(node.id, { 项目: P });
  assert.equal(current.状态, '已派发');
  assert.ok(current.绑定.some((b) => b.实例 === id));
  assert.equal((await org.registry.identity()).members[id].status, '在岗');
}

describe('动作真实链路的部分提交回执', () => {
  it('派发事件已落线、仅审计失败：外层保留dispatched及真实事件序号，不说仍待派发', async () => scene(async ({ f, org, calls, act, create }) => {
    const node = await create();
    const append = org.audit.append.bind(org.audit);
    org.audit.append = async (row) => {
      if (row.对象?.id === node.id && row.结果 === 'dispatched') throw new Error('dispatch-audit-unavailable');
      return append(row);
    };
    const error = await failed(() => act(spawnArgs(node)));
    assert.equal(error.code, 'MEMBER_SPAWN_DISPATCH_FAILED');
    const output = partial(error);
    const event = (await readTaskLedger(f.layout.taskLog(P))).find((row) => row.id === node.id && row.kind === 'dispatched');
    assert.ok(event && Number.isInteger(event.seq));
    assert.ok(output.已确认阶段.some((stage) => stage.事件 === 'dispatched' && stage.事件序号 === event.seq && stage.任务 === node.id));
    assert.doesNotMatch(output.怎么改, /节点仍在待派发/);
    await assertDispatched(org, node, 'outcome-child-1');
    assert.equal(calls.spawn, 1);
    assert.equal(calls.send, 0);
  }));

  for (const failure of ['lost-receipt', 'throw-after-accept']) {
    it(`开工书已入inbox但${failure}：保留登记/绑定/派发，结果未知不建议重发`, async () => scene(async ({ org, host, calls, inbox, act, create }) => {
      const node = await create();
      const send = host.subagents.sendMessage;
      host.subagents.sendMessage = async (...args) => {
        await send(...args);
        if (failure === 'throw-after-accept') throw new Error('reply-transport-lost');
        return undefined;
      };
      const error = await failed(() => act(spawnArgs(node)));
      assert.equal(error.code, 'MEMBER_SPAWN_MESSAGE_FAILED');
      const output = partial(error);
      for (const phase of ['登记及钉卡就绪', '任务绑定完成', '任务派发完成']) assert.ok(output.已确认阶段.some((stage) => stage.阶段 === phase), phase);
      assert.ok(!output.已确认阶段.some((stage) => stage.阶段 === '开工书inbox已接收'), '丢了接收回执，不能把夹具知道的事实冒称服务已确认');
      assert.match(output.怎么改, /不要重发/);
      await assertDispatched(org, node, 'outcome-child-1');
      assert.equal(inbox.length, 1, '反例前提：宿主已实际接受一次');
      assert.equal(calls.send, 1);
      assert.equal(calls.spawn, 1);
    }));
  }

  it('开工已接受、成员创建审计失败：报告已提交及消息id，零重建或重发', async () => scene(async ({ org, calls, inbox, act, create }) => {
    const node = await create();
    const append = org.audit.append.bind(org.audit);
    org.audit.append = async (row) => {
      if (row.动作 === '成员创建') throw new Error('member-final-audit-unavailable');
      return append(row);
    };
    const error = await failed(() => act(spawnArgs(node)));
    assert.equal(error.code, 'AUDIT_APPEND_FAILED_AFTER_EVENT');
    const output = partial(error, '已提交');
    assert.ok(output.已确认阶段.some((stage) => stage.阶段 === '开工书inbox已接收' && stage.消息id === inbox[0].messageId && stage.已接收 === true));
    assert.match(output.怎么改, /不要重建成员或重复发送开工书/);
    await assertDispatched(org, node, 'outcome-child-1');
    assert.equal(calls.spawn, 1);
    assert.equal(calls.send, 1);
  }));

  it('批准handler成功、记完成失败：已提交不可重试，不得再调用记失败', async () => scene(async ({ org, calls, act, approvalLevel, approve }) => {
    await approvalLevel();
    const args = { action: 'task_create', 描述: '批准创建已成功', 负责人: '插件工程', 判据: ['可验收'] };
    const id = await approve(args);
    let failures = 0;
    org.intervention.记完成 = async () => { throw new Error('approval-completion-audit-unavailable'); };
    const reportFailure = org.intervention.记失败.bind(org.intervention);
    org.intervention.记失败 = async (spec) => { failures += 1; return reportFailure(spec); };
    const error = await failed(() => act({ ...args, 审批引用: id }));
    assert.equal(error.code, 'APPROVAL_COMPLETION_AUDIT_FAILED');
    const output = partial(error, '已提交');
    assert.ok(output.已确认阶段.some((stage) => stage.请求id === id && stage.阶段 === '批准动作已完成'));
    assert.equal(failures, 0, '完成记账失败不能改记成业务失败');
    assert.equal((await org.tasks.list({ 项目: P })).filter((node) => node.描述 === args.描述).length, 1);
    await assert.rejects(() => act({ ...args, 审批引用: id }), (e) => e instanceof Denied);
    assert.equal((await org.tasks.list({ 项目: P })).length, 1, '重复调用不能重建业务对象');
    assert.equal(calls.spawn, 0);
  }));

  it('批准member_spawn成功但记完成失败：保留已知实例、任务和开工消息id', async () => scene(async ({ org, calls, inbox, act, create, approvalLevel, approve }) => {
    const node = await create();
    await approvalLevel();
    const args = spawnArgs(node);
    const id = await approve(args);
    org.intervention.记完成 = async () => { throw new Error('completion-after-success-lost'); };
    const error = await failed(() => act({ ...args, 审批引用: id }));
    assert.equal(error.code, 'APPROVAL_COMPLETION_AUDIT_FAILED');
    const output = partial(error, '已提交');
    assert.ok(output.已确认阶段.some((stage) => stage.实例 === 'outcome-child-1'), '外层记账失败不能抹去已拿到的成员id');
    assert.ok(output.已确认阶段.some((stage) => stage.任务 === node.id), '已派发任务id必须保留');
    assert.ok(output.已确认阶段.some((stage) => stage.消息id === inbox[0].messageId && stage.已接收 === true), '开工书接收回执不能退化成仅有审批请求id');
    await assertDispatched(org, node, 'outcome-child-1');
    assert.equal(calls.spawn, 1);
    assert.equal(calls.send, 1);
  }));

  it('批准记忆写入成功但记完成失败：展开固定返回包装，保留条目标识而不泄正文', async () => scene(async ({ org, act, approvalLevel, approve }) => {
    await approvalLevel();
    const args = { action: 'memory_write', 类: '经历', 内容: 'PRIVATE-MEMORY-CONTENT', 来源: '真实回执测试' };
    const request = await approve(args);
    const remember = org.memory.remember.bind(org.memory); let savedId, writes = 0;
    org.memory.remember = async (...args) => { const row = await remember(...args); savedId = row.id; writes++; return row; };
    org.intervention.记完成 = async () => { throw Error('completion-unavailable'); };
    const error = await failed(() => act({ ...args, 审批引用: request }));
    const output = partial(error, '已提交');
    assert.equal(writes, 1); assert.ok(savedId);
    assert.ok(output.已确认阶段.some(row => row.对象id === savedId && row.动作 === 'memory_write'));
    assert.ok(!JSON.stringify(output).includes('PRIVATE-MEMORY-CONTENT'));
  }));

  it('原执行故障加记失败也失败：外层保留原outcome和已落线事件序号', async () => scene(async ({ f, org, act, create, approvalLevel, approve }) => {
    const node = await create();
    await approvalLevel();
    const args = { action: 'task_dispatch', id: node.id };
    const id = await approve(args);
    const append = org.audit.append.bind(org.audit);
    org.audit.append = async (row) => {
      if (row.对象?.id === node.id && row.结果 === 'dispatched') throw new Error('dispatch-original-audit-failure');
      return append(row);
    };
    let original;
    const dispatch = org.tasks.dispatch.bind(org.tasks);
    org.tasks.dispatch = async (...params) => {
      try { return await dispatch(...params); }
      catch (error) { original = error; throw error; }
    };
    let failures = 0;
    org.intervention.记失败 = async () => { failures += 1; throw new Error('approval-failure-report-unavailable'); };
    const outer = await failed(() => act({ ...args, 审批引用: id }));
    assert.equal(failures, 1);
    assert.ok(original instanceof Fault);
    assert.equal(outer.code, original.code);
    assert.deepEqual(outer.outcome, original.outcome, '报告失败不得覆盖原执行提交事实');
    const output = partial(outer, '已提交');
    const event = (await readTaskLedger(f.layout.taskLog(P))).find((row) => row.id === node.id && row.kind === 'dispatched');
    assert.ok(output.已确认阶段.some((stage) => stage.事件 === 'dispatched' && stage.事件序号 === event.seq));
    assert.equal((await org.tasks.get(node.id, { 项目: P })).状态, '已派发');
  }));
});
