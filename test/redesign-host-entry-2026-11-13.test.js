import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { makeFixture, LEAD } from './helpers.mjs';
import { fakeHost } from './host-harness.mjs';
import { apply } from '../components/kernel/lib/index.js';
import { shareOrg, shareKey, forgetSharedOrg } from '../src/runtime.js';
import { ACTIONS, READ_ONLY_ACTIONS, COMMAND_ONLY_ACTIONS } from '../lib/actions.js';
import { Denied } from '../src/kernel/errors.js';

it('真实kernel入口使长原文与公开结构分页可达，知识整理/总结/恢复schema对应实际可用动作', async () => {
  const f = await makeFixture(); const host = fakeHost(); const project = 'redesign-host';
  const cwd = join(f.home, 'synthetic-work'); await mkdir(cwd);
  const events = [];
  const session = { id: LEAD.id, header: { id: LEAD.id, cwd }, inheritedEventCount: 0,
    get seq() { return events.length; }, get surface() { return { nodes: events.filter(e => e.surfaceOp === 'append').map(e => e.seq) }; },
    isOwnSeq: seq => seq >= 0 && seq < events.length };
  host.ctx.sessionQuery = { async observeSession() { return { source: 'live', header: session.header,
    inheritedEventCount: 0, cursor: events.length - 1, events, [Symbol.dispose]() {} }; } };
  const config = { home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project,
    projectBindings: [{ path: cwd, project }] };
  let org;
  try {
    await apply(host.ctx, config); org = await shareOrg(config);
    const tool = host.工具.get('mind');
    const schema = tool.parameters.properties;
    for (const name of ['turn_summary', 'memory_organize', 'task_reconcile', 'turn_experience_retain']) assert.ok(schema.action.enum.includes(name));
    for (const field of ['总结', '核对', '决策', 'op', 'ids', '内容', '原文', '字段', '正文偏移', '起始事件序号', '保留']) assert.ok(schema[field], field);
    assert.ok(schema.字段.enum.includes('public'));
    assert.ok(!READ_ONLY_ACTIONS.includes('turn_experience_retain'));
    assert.ok(COMMAND_ONLY_ACTIONS.includes('turn_archive_maintain')); assert.ok(!ACTIONS.includes('turn_archive_maintain'));
    const invoke = async args => {
      const result = JSON.parse(await tool.execute(args, { agent: { session }, name: 'mind', arguments: args, callId: 'synthetic-entry' }));
      assert.equal(result.成功, true, JSON.stringify(result)); return result;
    };
    const long = '开头' + '完整经历🙂'.repeat(9000) + '结尾';
    const add = (type, data, surfaceOp) => events.push({ seq: events.length, type, time: Date.now(), data, surfaceOp });
    add('turn/start', { turn: 1 });
    add('user/message', { id: 'long-original', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: long }] }, 'append');
    add('user/message', { id: 'file-reference', role: 'user', source: { kind: 'user' }, content: [{ type: 'file', name: 'example.pdf', url: 'https://fixture.invalid/temporary' }] }, 'append');
    add('turn/end', { turn: 1, reason: { kind: 'completed' } });
    let text = ''; let offset = 0; let version;
    do {
      const response = await invoke({ action: 'turn_buffer_query', 原文: true, id: 'long-original', 正文偏移: offset, 内容预算: 10000, 数据版本: version });
      text += response.原文.文本; offset = response.原文.下次文本偏移; version = response.原文.数据版本;
    } while (offset !== null);
    assert.equal(text, long);
    const file = await invoke({ action: 'turn_buffer_query', 原文: true, 字段: 'public', id: 'file-reference' });
    assert.equal(JSON.parse(file.原文.文本).content[0].name, 'example.pdf'); assert.equal(file.原文.缺口[0].status, 'retention-unverified');
    assert.equal((await invoke({ action: 'turn_experience_retain', 起始事件序号: 0, 保留: true })).保留.已保留, true);
    const unpin = await host.命令.get('mind').handler({ agent: { session }, rawInput: 'turn_experience_retain 起始事件序号=0 保留=false' });
    assert.equal(unpin.kind, 'success', unpin.text); assert.equal(JSON.parse(unpin.text).保留.已保留, false);
    const policyCheck = org.policy.check.bind(org.policy);
    org.policy.check = async request => {
      if (request.action === 'write' && request.target?.id?.startsWith('轮级缓冲/')) throw new Denied('合成明确写限制', '当前只读资料不能变更保留策略。');
      return policyCheck(request);
    };
    const deniedArgs = { action: 'turn_experience_retain', 起始事件序号: 0, 保留: true };
    const denied = JSON.parse(await tool.execute(deniedArgs, { agent: { session }, name: 'mind', arguments: deniedArgs, callId: 'synthetic-denial' }));
    assert.equal(denied.成功, false); assert.match(JSON.stringify(denied), /合成明确写限制/);
    assert.equal((await org.turnBuffer.load(project, session.id)).rounds[0].retain, false);
    assert.equal((await invoke({ action: 'turn_buffer_query', 原文: true, id: 'long-original', 内容预算: 10 })).原文.找到, true);
    org.policy.check = policyCheck;
    assert.equal((await invoke({ action: 'turn_summary' })).总结.due, false);
    const summaries = await org.memory.turnSummaries({ subject: LEAD, project, session: session.id });
    assert.equal(summaries.length, 1, '持久化入口自动生成有来源摘录');
    assert.equal((await invoke({ action: 'memory_organize', op: 'update', id: summaries[0].id, 内容: '新经历修正后的理解', 原因: '合成反例' })).整理.phase, 'committed');
    const task = await org.tasks.create({ subject: LEAD, 项目: project, 描述: '中断的合成工作', 负责人: 'Lead', 判据: ['保存既有结果'] });
    await org.tasks.dispatch(task.id, { subject: LEAD, 项目: project });
    const recovered = await invoke({ action: 'task_reconcile', id: task.id, 决策: '接手', 核对: {
      说明: '已检查但执行结果未知', 产物: [], 副作用: [{ 引用: 'synthetic-operation', 状态: '未知' }], 执行状态: '未知' } });
    assert.equal(recovered.恢复.可继续, false); assert.equal(recovered.恢复.已重放工具, false);
    const maintained = await host.命令.get('mind').handler({ agent: { session }, rawInput: 'turn_archive_maintain op=maintain' });
    assert.equal(maintained.kind, 'success', maintained.text);
  } finally {
    await org?.turnBufferHooks?.flush(); await org?.budgetHooks?.flush(); await org?.observability.flush();
    host.清理(); forgetSharedOrg(shareKey(config)); await f.cleanup();
  }
});
