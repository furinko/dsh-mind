import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { makeFixture, LEAD, MEMBER } from './helpers.mjs';
import { fakeHost } from './host-harness.mjs';
import { apply } from '../components/kernel/lib/index.js';
import { shareOrg, forgetSharedOrg, shareKey } from '../src/runtime.js';
import { runAction } from '../lib/actions.js';
import { withObservation, projectObservations, executionTarget } from '../src/observability.js';
import { createKernelObservations } from '../components/kernel/lib/observability-hooks.js';
import { Denied } from '../src/kernel/errors.js';
import { monitor路由 } from '../components/kernel/lib/routes.js';

const P = 'monitor-project';
async function setup(config = {}) {
  const f = await makeFixture(); const cwd = join(f.home, 'work'); await mkdir(cwd);
  const input = join(cwd, 'file.txt'); await writeFile(input, 'unchanged');
  const host = fakeHost();
  await apply(host.ctx, { home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P,
    projectBindings: [{ path: cwd, project: P }], memberFileAccess: { read: [cwd], write: [cwd] }, ...config });
  const org = await shareOrg({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
  const exec = (name = 'read', args = { file_path: input }, id = 'member-a') => Object.freeze({ name, arguments: Object.freeze(args), callId: 'reused-call', rootCallId: 'root', token: Symbol('host-execution'),
    agent: { session: { id, header: { cwd, ...(id === 'lead' ? {} : { origin: 'subagent', parentSession: 'lead', delegationDepth: 1 }) } } } });
  // Exact host contract: synchronous guards -> no body on denial -> one final result, including denials.
  const execute = async (e, body = async () => readFile(input, 'utf8')) => {
    let denial; for (const guard of host.闸) { denial = guard(e); if (denial !== undefined) break; }
    let result;
    if (denial !== undefined) result = { isError: true, error: { message: denial } };
    else { host.触发('tools/pre-execute', e); try { await body(); result = { isError: false }; } catch { result = { isError: true, error: { code: 'BODY_FAILED' } }; } }
    host.触发('tools/result', e, result); await org.observability.flush(); return result;
  };
  const dispatch = async () => {
    const n = await org.tasks.create({ subject: LEAD, 项目: P, 描述: 'file', 负责人: ['插件工程'], 判据: ['read'] });
    await org.tasks.bind(n.id, { subject: LEAD, 项目: P, 实例: 'member-a', 岗位: '插件工程' });
    await org.tasks.dispatch(n.id, { subject: LEAD, 项目: P, 工具文件范围: { 读: [cwd], 写: [cwd] } }); return n;
  };
  return { f, cwd, input, host, org, exec, execute, dispatch, query: () => org.observability.query({ subject: MEMBER, project: P }),
    async cleanup() { host.清理(); await org.observability.flush(); forgetSharedOrg(shareKey({ home: f.home, privateRoot: f.privateRoot, project: P })); await f.cleanup(); } };
}

describe('阻塞监控与反馈闭环', () => {
  it('调用摘要只剔除 mind 顶层真实审批凭据，原生/嵌套同名业务输入仍区分', () => {
    const hash = (name, args) => executionTarget({ name, arguments: args });
    assert.equal(hash('mind', { action: 'task_create', 审批引用: 'a' }), hash('mind', { action: 'task_create', 审批引用: 'b' }));
    assert.notEqual(hash('native', { 审批引用: 'a' }), hash('native', { 审批引用: 'b' }));
    assert.notEqual(hash('mind', { action: 'x', body: { 审批引用: 'a' } }), hash('mind', { action: 'x', body: { 审批引用: 'b' } }));
  });
  it('采集摘要/阶段异常均不得覆盖原 guard 判定、跳过工具体或篡改业务异常', async () => {
    const s = await setup(); try {
      await s.dispatch(); const cycle = {}; cycle.self = cycle;
      const e = s.exec('read', { file_path: s.input, extra: cycle }); let body = 0;
      await s.execute(e, async () => { body++; await readFile(s.input); });
      assert.equal(body, 1); assert.ok(s.org.observability.health().采集异常 > 0);
      const observer = s.org.observability;
      const adapter = createKernelObservations({ org: s.org, projectOf() { throw Error('bad project source'); }, enabled: false });
      let work = 0; assert.equal(adapter.guard(s.exec(), 'r', () => { work++; return 'original-denial'; }), 'original-denial'); assert.equal(work, 1);
      const old = observer.begin; observer.begin = () => { throw Error('capture begin'); };
      assert.equal(await adapter.execute(s.exec(), async () => 'original-value'), 'original-value');
      const originalError = Error('business'); await assert.rejects(adapter.execute(s.exec(), async () => { throw originalError; }), error => error === originalError);
      observer.begin = old;
      const end = observer.finish; observer.finish = () => { throw Error('finish capture'); };
      assert.equal(await adapter.execute(s.exec(), async () => 'still-success'), 'still-success'); observer.finish = end;
      const block = observer.block; observer.block = () => { throw Error('block capture'); };
      const active = createKernelObservations({ org: s.org, projectOf: () => P });
      assert.equal(active.guard(s.exec(), 'r', mark => { mark('r'); return 'still-denied'; }), 'still-denied'); observer.block = block;
    } finally { await s.cleanup(); }
  });
  it('policy_check 的 deny 是诊断结果，不进真实阻塞/恢复分母', async () => {
    const s = await setup({ audit工具调用: false }); try {
      const args = { action: 'policy_check', 动作: 'write', target: { id: 'preview-only', kind: '能力', authority: '法律' } };
      const e = s.exec('mind', args, 'lead');
      const out = JSON.parse(await s.host.工具.get('mind').execute(args, e));
      assert.equal(out.成功, true); assert.equal(out.判定.verdict, 'deny');
      const q = await s.org.observability.query({ project: P }); assert.equal(q.阻塞总数, 0); assert.equal(q.尝试总数, 1);
      assert.equal(q.规则汇总.length, 0);
    } finally { await s.cleanup(); }
  });
  it('真实审批批准不标恢复；原申请者显式关联且重放实际成功后才恢复', async () => {
    const s = await setup(); try {
      await s.f.writePrivate('集体L2-共享基础设施/defaults/部署.json', JSON.stringify({ 介入度: '审批' }));
      await s.org.policy.reload();
      const args = { action: 'task_create', 描述: 'needs owner review', 负责人: ['插件工程'], 判据: ['proof'] };
      const e = s.exec('mind', args, 'lead'); const tool = s.host.工具.get('mind');
      const blocked = JSON.parse(await tool.execute(args, e)); assert.equal(blocked.成功, false);
      s.host.触发('tools/result', e, { isError: false });
      const q = await s.org.observability.query({ project: P }); assert.equal(q.阻塞总数, 1);
      const block = q.阻塞[0]; assert.ok(block.block.requestId, JSON.stringify(block));
      await s.org.intervention.人侧决议({ 请求id: block.block.requestId, 决定: '批准', 通道: '测试认证人侧', 认证: '真实隔离夹具' });
      assert.equal((await s.org.observability.query({ project: P })).阻塞[0].state, 'unresolved');
      await s.org.observability.followup({ subject: LEAD, project: P, blockId: block.id, disposition: 'retry', reason: '已批准，原参数重放', reference: block.block.requestId });
      const replayArgs = { ...args, 审批引用: block.block.requestId }; const retry = s.exec('mind', replayArgs, 'lead');
      const out = JSON.parse(await tool.execute(replayArgs, retry)); assert.equal(out.成功, true, JSON.stringify(out));
      s.host.触发('tools/result', retry, { isError: false });
      const done = await s.org.observability.query({ project: P }); assert.equal(done.阻塞[0].state, 'recovered');
    } finally { await s.cleanup(); }
  });
  it('分页与反馈截断给出真实总数，汇总不按显示页缩小', async () => {
    const s = await setup(); try {
      await s.execute(s.exec()); await s.execute(s.exec()); const block = (await s.query()).阻塞[0];
      for (let i = 0; i < 12; i++) await s.org.observability.feedback({ subject: MEMBER, project: P, blockId: block.id, reason: `reason ${i}`, reference: block.id });
      const first = await s.org.observability.query({ subject: MEMBER, project: P, limit: 1 });
      assert.equal(first.阻塞总数, 2); assert.equal(first.阻塞.length, 1); assert.equal(first.分页.下一偏移, 1);
      assert.equal(first.规则汇总[0].blocked, 2); assert.equal(first.阻塞[0].feedbackTotal, 12); assert.equal(first.阻塞[0].feedback.length, 10);
      const next = await s.org.observability.query({ subject: MEMBER, project: P, limit: 1, offset: 1 }); assert.notEqual(next.阻塞[0].id, first.阻塞[0].id);
      await assert.rejects(s.org.observability.query({ project: P, limit: 101 }), /limit/);
    } finally { await s.cleanup(); }
  });
  it('真实 apply 同步 guard 拒绝不执行工具体，并由最终结果落下一个可查阻塞', async () => {
    const s = await setup(); try {
      let body = 0; const e = s.exec(); const result = await s.execute(e, async () => { body++; await writeFile(s.input, 'corrupt'); });
      assert.equal(body, 0); assert.equal(result.isError, true); assert.equal(await readFile(s.input, 'utf8'), 'unchanged');
      // Duplicate callbacks on the same immutable execution never create another attempt/block/end.
      s.host.闸[0](e); s.host.触发('tools/result', e, result);
      const q = await s.query(); assert.equal(q.尝试总数, 1); assert.equal(q.阻塞.length, 1);
      assert.equal(q.阻塞[0].block.ruleId, 'kernel.member-files'); assert.equal(q.阻塞[0].end.outcome, 'blocked');
      assert.match(q.健康.崩溃窗口, /未知/); assert.equal(q.误拦截率, null); assert.ok(!JSON.stringify(q).includes(s.input));
    } finally { await s.cleanup(); }
  });
  it('相同 callId 的两个真实执行分别计数；不把父/子调用或会话当去重键', async () => {
    const s = await setup(); try { await s.execute(s.exec()); await s.execute(s.exec()); const q = await s.query();
      assert.equal(q.尝试总数, 2); assert.equal(q.阻塞.length, 2); assert.notEqual(q.阻塞[0].id, q.阻塞[1].id); assert.equal(q.阻塞[0].callId, q.阻塞[1].callId);
    } finally { await s.cleanup(); }
  });
  it('仅收到最终结果时不编造开始耗时，缺真实会话时单列unknown主体', async () => {
    const s = await setup(); try {
      s.host.触发('tools/result', { name: 'read', arguments: {}, callId: 'no-session' }, { isError: true });
      const rows = projectObservations(await s.org.observability.facts(null));
      assert.equal(rows[0].subject, 'unknown'); assert.equal(rows[0].end.executionMs, null); assert.equal(rows[0].startPhase, 'result');
    } finally { await s.cleanup(); }
  });
  it('显式重试只能由相同主体/项目/入参的真实成功恢复；无关成功及声明不能恢复', async () => {
    const s = await setup(); try {
      await s.execute(s.exec()); const block = (await s.query()).阻塞[0];
      await s.org.observability.followup({ subject: MEMBER, project: P, blockId: block.id, disposition: 'retry', reason: '等待派发后重试', reference: block.id });
      await s.dispatch();
      await s.execute(s.exec('read', { file_path: s.input, offset: 1 }));
      assert.equal((await s.query()).阻塞[0].state, 'unresolved');
      let body = 0; await s.execute(s.exec(), async () => { body++; await readFile(s.input); });
      const q = await s.query(); assert.equal(body, 1); assert.equal(q.阻塞[0].state, 'recovered'); assert.ok(q.阻塞[0].recovery.attemptId);
      assert.equal(q.规则汇总[0].recoverySamples, 1);
    } finally { await s.cleanup(); }
  });
  it('关联重试失败仍未恢复；放弃有来源/理由/引用，不能伪造成功', async () => {
    const s = await setup(); try {
      await s.execute(s.exec()); const block = (await s.query()).阻塞[0]; await s.dispatch();
      await s.org.observability.followup({ subject: MEMBER, project: P, blockId: block.id, disposition: 'retry', reason: '重试', reference: block.id });
      await s.execute(s.exec(), async () => { throw Error('failure'); }); assert.equal((await s.query()).阻塞[0].state, 'unresolved');
      await assert.rejects(s.org.observability.followup({ subject: MEMBER, project: P, blockId: block.id, disposition: 'recovered', reason: 'model success', reference: block.id }), /retry/);
      await s.org.observability.followup({ subject: MEMBER, project: P, blockId: block.id, disposition: 'abandon', reason: '不再需要', reference: block.id });
      const q = await s.query(); assert.equal(q.阻塞[0].state, 'abandoned'); assert.equal(q.阻塞[0].followups.at(-1).source, 'model_claim');
    } finally { await s.cleanup(); }
  });
  it('policy/action 审计与 mind 的 JSON 语义失败归到同一真实执行，isError=false 不洗成成功', async () => {
    const s = await setup(); try {
      const e = s.exec('mind', { action: 'task_create', 描述: 'forbidden', 负责人: ['插件工程'], 判据: ['x'] });
      const raw = await s.host.工具.get('mind').execute(e.arguments, e);
      assert.equal(JSON.parse(raw).成功, false);
      s.host.触发('tools/result', e, { isError: false }); const q = await s.query();
      assert.equal(q.尝试总数, 1); assert.equal(q.阻塞.length, 1); assert.equal(q.阻塞[0].end.outcome, 'blocked');
    } finally { await s.cleanup(); }
  });
  it('普通成员只见当前项目自己的安全摘要；不能反馈/跟进其他主体或项目', async () => {
    const s = await setup(); try {
      await s.execute(s.exec()); await s.execute(s.exec('read', { file_path: s.input }, 'member-b'));
      const q = await s.query(); assert.equal(q.尝试总数, 1); assert.equal(q.阻塞[0].subject, 'member-a');
      const all = await s.org.observability.query({ project: P }); const other = all.阻塞.find(a => a.subject === 'member-b');
      await assert.rejects(s.org.observability.feedback({ subject: MEMBER, project: P, blockId: other.id, reason: 'x', reference: other.id }), /可见域/);
      assert.equal((await s.org.observability.query({ subject: MEMBER, project: 'other' })).尝试总数, 0);
      await assert.rejects(s.org.observability.followup({ subject: MEMBER, project: 'other', blockId: q.阻塞[0].id, disposition: 'retry', reason: 'x', reference: 'x' }), /可见域/);
    } finally { await s.cleanup(); }
  });
  it('模型反馈强制为声明，人侧确认必须有认证来源；所有反馈均不能改权限', async () => {
    const s = await setup(); try {
      await s.execute(s.exec()); const block = (await s.query()).阻塞[0];
      await runAction({ org: s.org, 项目: P, 主体: MEMBER, args: { action: 'monitor_feedback', 阻塞引用: block.id,
        原因分类: '规则缺陷疑似', 原因: '需要复核', 来源引用: block.id, human: true, 判定: 'false_positive', source: 'human_confirmation' } });
      const q = await s.query(); assert.equal(q.阻塞[0].feedback[0].source, 'model_claim'); assert.equal(q.规则汇总[0].humanFalsePositive, 0);
      assert.equal(q.规则汇总[0].unconfirmed, 1); assert.ok(s.host.闸[0](s.exec()));
      await assert.rejects(s.org.observability.feedback({ subject: MEMBER, project: P, blockId: block.id, verdict: 'false_positive', reason: 'x', reference: 'x' }), /模型只能/);
      await assert.rejects(s.org.observability.feedback({ subject: MEMBER, project: P, blockId: block.id, reason: 'x', reference: '' }), /来源引用/);
    } finally { await s.cleanup(); }
  });
  it('完整观测历史独立于最近40条审计尾；重开组织后重建原阻塞和反馈', async () => {
    const s = await setup(); try {
      await s.execute(s.exec()); const block = (await s.query()).阻塞[0];
      await s.org.observability.feedback({ subject: MEMBER, project: P, blockId: block.id, reason: '说明', reference: block.id });
      for (let i = 0; i < 41; i++) await s.org.audit.append({ 动作: '只读服务调用', 主体: LEAD, 项目: P });
      const view = await s.org.workbench({ 项目: P, 读者: MEMBER, 审计条数: 1 });
      assert.equal(view.监控.阻塞.length, 1); assert.equal(view.监控.阻塞[0].feedback.length, 1);
      const { Org } = await import('../src/org.js'); const reopened = await Org.open({ home: s.f.home, factoryRoot: s.f.factoryRoot, privateRoot: s.f.privateRoot });
      assert.equal((await reopened.observability.query({ subject: MEMBER, project: P })).阻塞[0].id, block.id);
    } finally { await s.cleanup(); }
  });
  it('核验读取跨月时明确要求重试，不把未加锁新月读数算完整', async () => {
    const s = await setup(); try {
      await s.execute(s.exec());
      const audit = s.org.audit, read = audit.read.bind(audit), source = audit.clock._source;
      audit.read = async query => { const rows = await read(query); audit.clock._source = () => new Date('2032-01-01T00:00:00Z'); return rows; };
      try { await assert.rejects(s.query(), /新月份.*重新读取/); }
      finally { audit.read = read; audit.clock._source = source; }
      assert.equal((await s.query()).阻塞总数, 1);
    } finally { await s.cleanup(); }
  });
  it('审计写失败仍拒绝原调用，健康显式降级；关闭工具审计明确缩小覆盖', async () => {
    const s = await setup(); try {
      const original = s.org.audit.append.bind(s.org.audit);
      s.org.audit.append = entry => entry.动作.startsWith('监控') ? Promise.reject(Error('disk unavailable')) : original(entry);
      assert.equal((await s.execute(s.exec())).isError, true); assert.equal(s.org.observability.health().状态, 'degraded');
      assert.ok(s.org.observability.health().写入失败 > 0);
      s.org.audit.append = original;
    } finally { await s.cleanup(); }
    const disabled = await setup({ audit工具调用: false }); try { await disabled.execute(disabled.exec()); const q = await disabled.query();
      assert.equal(q.健康.覆盖.nativeTools, 'disabled'); assert.equal(q.尝试总数, 0); assert.equal(q.健康.状态, 'partial');
    } finally { await disabled.cleanup(); }
  });
  it('没有真实结束记录的尝试耗时未知；不能把审批事实或无结束记录推断成恢复', () => {
    const rows = [
      { 动作: '监控开始', 主体: MEMBER, 项目: P, 时间: '2026-10-20T00:00:00Z', 详情: { version: 1, eventId: 'a:start', attemptId: 'a', start: '2026-10-20T00:00:00Z', target: 't' } },
      { 动作: '监控阻塞', 主体: MEMBER, 项目: P, 时间: '2026-10-20T00:00:01Z', 详情: { version: 1, eventId: 'a:block', attemptId: 'a', target: 't', ruleId: 'r' } },
      { 动作: '介入决议', 主体: LEAD, 项目: P, 详情: { 决定: '批准' } },
    ];
    const a = projectObservations(rows)[0]; assert.equal(a.state, 'unresolved'); assert.equal(a.end, undefined); assert.equal(a.recovery, undefined);
  });
  it('audit 上下文的多个拦截证据不重复生成阻塞', async () => {
    const s = await setup(); try {
      const a = s.org.observability.begin(s.exec('mind', { action: 'x' }), { subject: MEMBER, project: P });
      await withObservation(s.org.observability, a, async () => {
        await s.org.audit.append({ 动作: '策略拒绝', 主体: MEMBER, 依据: 'rule-A' });
        await s.org.audit.append({ 动作: '动作拦截', 主体: MEMBER, 依据: 'rule-A' });
      });
      s.org.observability.semanticFailure(a, new Denied('rule-A', 'hidden raw error'));
      assert.equal((await s.query()).阻塞.length, 1);
    } finally { await s.cleanup(); }
  });
  it('人侧反馈路由认证、会话范围、来源引用全部承重，不代理任意动作', async () => {
    const s = await setup(); try {
      await s.execute(s.exec()); const block = (await s.query()).阻塞[0];
      const invoke = async (ctx, { method = 'GET', owner = 'member-a', body = null } = {}) => {
        const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
        Object.assign(req, { method, url: `/plugins/dsh-mind/monitor?sessionId=${owner}`, headers: { origin: 'http://localhost:3000', host: 'localhost:3000', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, socket: { remoteAddress: '127.0.0.1' } });
        let response; const res = { setHeader() {}, writeHead(code) { this.statusCode = code; }, end(raw) { response = { status: this.statusCode, body: JSON.parse(raw) }; } };
        await monitor路由({ org: s.org, ctx })(req, res); return response;
      };
      assert.equal((await invoke({ get: () => null })).status, 503);
      assert.equal((await invoke({ get: () => ({ requestRejection: () => 401 }) })).status, 401);
      const ctx = { get: () => ({ requestRejection: () => undefined }) };
      assert.equal((await invoke(ctx)).body.数据.阻塞.length, 1);
      const body = { 阻塞引用: block.id, 原因分类: '规则缺陷疑似', 判定: 'false_positive', 原因: '经人审查为误拦', 来源引用: 'human-review-1', action: 'grant' };
      assert.equal((await invoke(ctx, { method: 'POST', owner: 'member-b', body })).body.成功, false);
      const saved = await invoke(ctx, { method: 'POST', body }); assert.equal(saved.body.source, 'human_confirmation', JSON.stringify(saved));
      const q = (await invoke(ctx)).body.数据; assert.equal(q.规则汇总[0].humanFalsePositive, 1); assert.equal(q.规则汇总[0].falsePositiveRate, null);
      assert.ok(q.阻塞[0].feedback.some(f => f.eventId === saved.body.feedbackId)); assert.ok(s.host.闸[0](s.exec()));
    } finally { await s.cleanup(); }
  });
});
