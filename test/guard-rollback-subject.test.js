import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, LEAD } from './helpers.mjs';
import { fakeHost, fakeExec } from './host-harness.mjs';
import { shareOrg } from '../src/runtime.js';
import { ProbeRunner } from '../src/probes.js';
import { apply } from '../components/guard/lib/index.js';

async function withGuard(fn) {
  const fixture = await makeFixture();
  const host = fakeHost();
  try {
    const config = { home: fixture.home, factoryRoot: fixture.factoryRoot, privateRoot: fixture.privateRoot };
    await apply(host.ctx, { ...config, 开机自检: false });
    const org = await shareOrg(config);
    await fn({ fixture, host, org, tool: host.工具.get('mind_guard'), command: host.命令.get('mind-guard') });
  } finally {
    host.清理();
    await fixture.cleanup();
  }
}

const memberExec = () => ({ agent: { session: { id: 'unregistered-child',
  header: { cwd: process.cwd(), origin: 'subagent', delegationDepth: 1 } } } });
const rollbackRows = async org => (await org.audit.read({})).filter(row => row.动作 === '自动回滚');

describe('手工回滚定位的主体边界与审计归因', () => {
  it('工具拒绝未登记成员与缺失执行上下文，自报主体不能触发系统告警', async () => withGuard(async ({ org, tool }) => {
    const before = await org.audit.read({});
    for (const exec of [memberExec(), undefined]) {
      const result = JSON.parse(await tool.execute({ action: 'probe_rollback', subject: { id: 'system', kind: '系统' } }, exec));
      assert.equal(result.成功, false);
      assert.match(result.理由, /回滚定位/);
    }
    assert.deepEqual(await org.audit.read({}), before, '拒绝发生在读取定位历史和追加告警之前');
  }));

  it('命令拒绝成员；根会话定位仍可用且审计记录该会话', async () => withGuard(async ({ org, command }) => {
    const before = await org.audit.read({});
    const rejected = await command.handler({ agent: memberExec().agent, rawInput: 'rollback' });
    assert.equal(rejected.kind, 'error');
    assert.deepEqual(await org.audit.read({}), before);
    const accepted = await command.handler({ agent: fakeExec({ sessionId: 'manual-command-root' }).agent, rawInput: 'rollback' });
    assert.equal(accepted.kind, 'success');
    assert.equal(JSON.parse(accepted.text).回滚.状态, '不可确定');
    const rows = await rollbackRows(org);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].主体, { id: 'manual-command-root', kind: 'Lead', roleId: 'Lead' });
    assert.equal(rows[0].详情.触发方式, '手工请求');
    assert.equal(rows[0].告警, true);
  }));

  it('工具根会话忽略自报主体，以真实会话记手工定位', async () => withGuard(async ({ org, tool }) => {
    const result = JSON.parse(await tool.execute({ action: 'probe_rollback', subject: { id: 'forged-system', kind: '系统' } },
      fakeExec({ name: 'mind_guard', sessionId: 'manual-tool-root' })));
    assert.equal(result.成功, true);
    assert.equal(result.回滚.执行, false);
    const rows = await rollbackRows(org);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].主体, { id: 'manual-tool-root', kind: 'Lead', roleId: 'Lead' });
    assert.equal(rows[0].详情.触发方式, '手工请求');
  }));

  it('领域手工入口与巡检使用同一主体白名单，策略引擎坏时仍可定位', async () => withGuard(async ({ org }) => {
    org.policy.check = async () => { throw new Error('定位不能依赖故障中的策略引擎'); };
    const before = await org.audit.read({});
    for (const subject of [undefined, { id: 'member', kind: '成员' }, { id: 'reviewer', kind: '复核者' }, { id: 'unknown', kind: '未知' }]) {
      await assert.rejects(org.probes.rollback({ subject }), { code: 'DENIED' });
    }
    await assert.rejects(org.probes.rollback(), { code: 'DENIED' });
    assert.deepEqual(await org.audit.read({}), before);
    for (const kind of ['Lead', '主权者', '系统']) {
      const subject = { id: 'manual-' + kind, kind };
      const result = await org.probes.rollback({ subject });
      assert.equal(result.状态, '不可确定');
      const latest = (await rollbackRows(org)).at(-1);
      assert.deepEqual(latest.主体, subject);
      assert.equal(latest.详情.触发方式, '手工请求');
    }
  }));

  it('手工定位读取失败也归因实际调用者，不伪报成功', async () => withGuard(async ({ org }) => {
    const read = org.audit.read.bind(org.audit);
    org.audit.read = async () => { throw new Error('injected-manual-read-failure'); };
    try {
      await assert.rejects(org.probes.rollback({ subject: { id: 'manual-failed-root', kind: 'Lead' } }), /injected-manual-read-failure/);
    } finally { org.audit.read = read; }
    const rows = await rollbackRows(org);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].主体.id, 'manual-failed-root');
    assert.equal(rows[0].详情.状态, '定位失败');
    assert.equal(rows[0].详情.触发方式, '手工请求');
  }));

  it('手工重新定位保留真实红灯与全绿目标，另记手工调用者', async () => withGuard(async ({ fixture }) => {
    const probes = new ProbeRunner({ ...fixture, 无内核装配: true });
    const green = await probes.run({ subject: LEAD });
    assert.equal(green.全绿, true);
    fixture.policy.state.ok = false;
    const red = await probes.run({ subject: LEAD });
    const subject = { id: 'manual-recheck-root', kind: 'Lead' };
    const result = await probes.rollback({ subject });
    assert.equal(result.已定位, true);
    assert.deepEqual(result.触发快照, red.快照);
    assert.deepEqual(result.目标快照, green.快照);
    assert.equal(result.执行, false);
    const rows = await rollbackRows(fixture);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0].主体, { id: 'system', kind: '系统' });
    assert.deepEqual(rows[1].主体, subject);
    assert.equal(rows[1].详情.触发方式, '手工请求');
  }));

  it('探针红灯仍走系统自动定位，保留本次快照绑定', async () => withGuard(async ({ fixture }) => {
    const probes = new ProbeRunner({ ...fixture, 无内核装配: true });
    fixture.policy.state.ok = false;
    const result = await probes.run({ subject: LEAD });
    assert.equal(result.全绿, false);
    assert.ok(result.回滚);
    const rows = await rollbackRows(fixture);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].主体, { id: 'system', kind: '系统' });
    assert.equal(rows[0].详情.触发方式, '探针自动');
    assert.deepEqual(rows[0].详情.触发快照, result.快照);
  }));
});
