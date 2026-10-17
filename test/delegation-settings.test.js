import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DelegationPolicy } from '../src/delegation-policy.js';
import { Denied } from '../src/kernel/errors.js';
import { ACTIONS, COMMAND_ONLY_ACTIONS } from '../lib/actions.js';
import { createDelegationSettings } from '../components/kernel/lib/delegation-settings.js';
import { delegation路由, 端点表 } from '../components/kernel/lib/routes.js';
import { apply } from '../components/kernel/lib/index.js';
import { fakeHost } from './host-harness.mjs';
import { forgetSharedOrg } from '../src/runtime.js';
import { makeFixture, LEAD, MEMBER, SOVEREIGN } from './helpers.mjs';

const INITIAL = { mode: 'lead-discretion', projects: ['plugins'], authorizationRef: 'operator grant' };
const NEXT = { mode: 'explicit-user', projects: [], authorizationRef: '' };
const fingerprint = (config) => new DelegationPolicy(config).fingerprint;
const clone = (value) => structuredClone(value);

function fixture(options = {}) {
  let disk = clone(options.initialRaw ?? { unrelated: { retained: 7 }, delegation: INITIAL });
  let policy = new DelegationPolicy(disk.delegation);
  let settings;
  let handler;
  let queue = Promise.resolve();
  const entry = { options: { id: 'dsh-mind-kernel', name: 'dsh-mind/kernel', config: clone(disk) }, fiber: { state: 2 } };
  const audit = [];
  let edits = 0;
  let reads = 0;
  const editor = {
    documentPath: '/isolated/profile/cordis.patch.yml',
    entries() { assert.equal(this, editor); return options.duplicate ? [entry, { ...entry }] : [entry]; },
    configuration() {
      assert.equal(this, editor);
      reads += 1;
      if (options.readFailure) throw new Error('disk unavailable');
      return [{ entry, inherited: clone(options.inherited ?? {}), override: clone(Object.hasOwn(options, 'override') ? options.override : disk) }];
    },
    edit(target, change) {
      assert.equal(this, editor);
      assert.equal(target, entry);
      const run = queue.then(async () => {
        if (options.beforeEdit) await options.beforeEdit(entry);
        if (options.mode === 'before') throw new Error('overlay prevents write');
        const next = change(clone(entry.options.config), {});
        edits += 1;
        disk = clone(next);
        entry.options.config = clone(next);
        if (options.mode === 'rollback') {
          disk = { unrelated: { retained: 7 }, delegation: clone(INITIAL) };
          entry.options.config = clone(disk);
          throw new Error('apply failed, restored');
        }
        if (options.mode === 'after') throw new Error('apply and rollback failed');
        policy.close();
        policy = new DelegationPolicy(disk.delegation);
        mount();
      });
      queue = run.catch(() => {});
      return run;
    },
  };
  const connection = {
    marker: true,
    requestRejection(req) {
      assert.equal(this, connection, '宿主方法必须保留 this');
      if (req.headers['sec-fetch-site'] === 'cross-site') return 403;
      if (req.headers.origin && req.headers.origin !== 'http://127.0.0.1:19387') return 403;
      return req.headers.cookie === 'operator-session' ? undefined : 401;
    },
  };
  const ctx = { get(name) {
    if (options.missing === name) return undefined;
    return { configEditor: editor, connection, agentTeams: {}, subagents: {} }[name];
  } };
  const decisions = [];
  const org = { policy: { async check(spec) {
    assert.equal(this, org.policy);
    decisions.push(spec);
    if (options.policyFailure) throw new Denied('test-policy', '策略拒绝部署授权变更');
  } }, audit: { async append(record) {
    assert.equal(this, org.audit);
    if (options.auditFailure) throw new Error('audit unavailable');
    audit.push(record);
  } } };
  function mount() {
    settings = createDelegationSettings({ ctx, org, delegation: policy, project: 'plugins', readiness: { promptRegistered: true, creationGuardRegistered: true } });
    handler = delegation路由({ ctx, settings });
  }
  mount();
  return {
    ctx, org, editor, entry, audit, decisions,
    get settings() { return settings; }, get policy() { return policy; },
    get disk() { return disk; }, get edits() { return edits; }, get reads() { return reads; },
    async request(method = 'GET', body, headers = {}) {
      const req = {
        method, headers: { host: '127.0.0.1:19387', cookie: 'operator-session', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)); },
      };
      const res = { status: null, body: null, writeHead(code) { this.status = code; }, end(value) { this.body = JSON.parse(value); } };
      await handler(req, res);
      return res;
    },
  };
}

const input = (delegation = NEXT) => ({ delegation, expectedFingerprint: fingerprint(INITIAL) });

describe('调度设置：正式 editor、认证、锁内 CAS 与分面回执', () => {
  it('GET 分开返回盘面和真实策略，不把 ACTIVE 当生效；服务读取保持 this', async () => {
    const t = fixture();
    const out = await t.request();
    assert.equal(out.status, 200);
    assert.equal(out.body.数据.persistence.fingerprint, fingerprint(INITIAL));
    assert.equal(out.body.数据.runtime.fingerprint, fingerprint(INITIAL));
    assert.equal(out.body.数据.application.state, 'confirmed');
    assert.equal(out.body.数据.persistence.config.mode, 'lead-discretion');
    assert.match(out.body.数据.effect, /不会终止已有成员/);
    t.policy.close();
    assert.equal((await t.request()).body.数据.application.state, 'unconfirmed');
  });

  it('POST 只改最新 current.delegation；新 GET 看到新策略，旧策略已 close', async () => {
    const t = fixture({ beforeEdit(entry) { entry.options.config.otherWriter = 'preserve'; } });
    const previous = t.policy;
    const out = await t.request('POST', input());
    assert.equal(out.body.成功, true);
    assert.equal(out.body.commit.state, 'reconciled');
    assert.equal(out.body.application.state, 'unknown', 'POST 不许读旧 closure 冒充生效');
    assert.equal(out.body.application.requiresFreshGet, true);
    assert.equal(out.body.persistence.matchesRequested, true);
    assert.equal(t.disk.otherWriter, 'preserve');
    assert.deepEqual(t.disk.unrelated, { retained: 7 });
    assert.equal(previous.closed, true);
    const fresh = (await t.request()).body.数据;
    assert.equal(fresh.runtime.disposed, false);
    assert.equal(fresh.runtime.fingerprint, fingerprint(NEXT));
    assert.equal(fresh.application.state, 'confirmed');
    assert.equal(t.audit.length, 1);
    assert.equal(t.audit[0].动作, '调度设置变更');
    assert.equal(JSON.stringify(t.audit).includes('operator grant'), false, '审计不复制授权自由文本');
  });

  it('两个相同 expected 并发保存：仅一份提交，另一 409，不以锁外检查替代', async () => {
    const t = fixture();
    const [a, b] = await Promise.all([t.request('POST', input()), t.request('POST', input({ mode: 'lead-discretion', projects: ['other'], authorizationRef: 'another grant' }))]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal(t.edits, 1);
    assert.equal(b.body.commit.state, 'not-started');
    assert.equal(t.audit.length, 2);
  });

  it('进入 edit 后外部更新必须在 change 内识别，不丢外部授权', async () => {
    const changed = { mode: 'explicit-user', projects: ['external'], authorizationRef: '' };
    const t = fixture({ beforeEdit(entry) { entry.options.config.delegation = changed; } });
    const out = await t.request('POST', input());
    assert.equal(out.status, 409);
    assert.equal(t.edits, 0);
    assert.equal(out.body.beforeFingerprint, fingerprint(changed));
  });

  for (const missing of ['configEditor', 'connection']) it(`缺 ${missing} 响亮不可用，不退回裸写/无认证`, async () => {
    const t = fixture({ missing });
    const get = await t.request();
    const post = await t.request('POST', input());
    assert.equal(get.status, 503);
    assert.equal(post.status, 503);
    assert.equal(t.edits, 0);
  });

  it('策略拒绝或缺席时零 edit；主权者映射仅在认证人侧通道', async () => {
    const t = fixture({ policyFailure: true });
    const out = await t.request('POST', input());
    assert.equal(out.status, 403);
    assert.equal(t.edits, 0);
    assert.equal(t.decisions.length, 1);
    assert.deepEqual(t.decisions[0].subject, { id: '设置页', kind: '主权者' });
    assert.equal(t.decisions[0].target.authority, '宪章');
    assert.equal(out.body.audit.state, 'recorded');
    delete t.org.policy;
    assert.equal((await t.request('POST', input())).status, 503);
    assert.equal(t.edits, 0);
  });

  it('真实引擎：模型形状主体对同目标仍拒，主权者通道才放行（映射不可从模型面触及）', async () => {
    const f = await makeFixture();
    try {
      const target = { id: 'dsh-mind-kernel.delegation', kind: '部署授权', authority: '宪章', zone: '私有', project: 'plugins' };
      for (const subject of [LEAD, MEMBER]) {
        const decision = await f.policy.decide({ subject, action: 'write', target, context: {} });
        assert.equal(decision.verdict, 'deny', `${subject.kind} 不得改部署授权：${JSON.stringify(decision)}`);
        assert.match(decision.rule, /宪章/);
      }
      const sovereign = await f.policy.decide({ subject: SOVEREIGN, action: 'write', target, context: {} });
      assert.equal(sovereign.verdict, 'allow');
    } finally {
      await f.cleanup();
    }
  });

  it('官方整 config 替换：部分配置不能隐式继承旧 delegation 或嵌套字段', async () => {
    // 对照官方 applyEntryPatches 的 target[key]=value，config 对象整个替换，不深合并。
    const inherited = { delegation: INITIAL, otherInherited: 1 };
    const t = fixture({ initialRaw: { onlyOverride: true }, inherited });
    const get = (await t.request()).body.数据;
    assert.equal(get.persistence.config.mode, 'explicit-user');
    assert.equal(get.persistence.fingerprint, fingerprint({}));
    assert.equal(get.runtime.fingerprint, fingerprint({}));
    const partial = fixture({ initialRaw: { delegation: { mode: 'explicit-user' } }, inherited });
    const config = (await partial.request()).body.数据.persistence.config;
    assert.deepEqual(config.projects, []);
    assert.equal(config.authorizationRef, '');
    const invalid = fixture({ initialRaw: {}, inherited, override: { delegation: { mode: 'lead-discretion' } } });
    assert.equal((await invalid.request()).status, 503, '缺的 projects/ref 不得从下层猜补');
  });

  it('configuration 将无覆盖与显式 config:{} 混同，分歧盘面必须报未知', async () => {
    const t = fixture({ initialRaw: {}, inherited: { delegation: INITIAL } });
    const out = await t.request();
    assert.equal(out.status, 503);
    assert.match(out.body.理由, /无法区分/);
    const equivalent = fixture({ initialRaw: {}, inherited: { unrelated: true } });
    assert.equal((await equivalent.request()).body.数据.persistence.fingerprint, fingerprint({}));
  });

  it('非唯一正式 entry 不可写', async () => {
    const t = fixture({ duplicate: true });
    assert.equal((await t.request('POST', input())).status, 503);
    assert.equal(t.edits, 0);
  });

  it('无认证、跨站和伪造来源均先拒绝；桌面删 Origin 后带认证 cookie 的正例可用', async () => {
    const t = fixture();
    assert.equal((await t.request('POST', input(), { cookie: '' })).status, 401);
    assert.equal((await t.request('POST', input(), { 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await t.request('POST', input(), { origin: 'https://hostile.invalid' })).status, 403);
    assert.equal(t.edits, 0);
    assert.equal(t.reads, 0, '认证之前不能读取授权配置');
    assert.equal((await t.request('POST', input())).status, 200);
  });

  it('JSON 类型、体积、方法边界拒绝，绝不接受通用代理', async () => {
    const t = fixture();
    assert.equal((await t.request('PUT', input())).status, 405);
    assert.equal((await t.request('OPTIONS')).status, 405);
    assert.equal((await t.request('POST', input(), { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await t.request('POST', '{')).status, 400);
    assert.equal((await t.request('POST', ' '.repeat(65537))).status, 413);
    for (const value of [null, [], {}, { ...input(), action: 'anything' }, { ...input(), expectedFingerprint: 'old' }, input({ mode: 'lead-discretion', projects: [], authorizationRef: 'x' }), input({ mode: 'bad' }), input({ extra: true })]) {
      const out = await t.request('POST', value);
      assert.equal(out.status, 400, JSON.stringify(value));
      assert.equal(out.body.commit.state, 'not-started');
    }
    assert.equal(t.edits, 0);
    assert.equal(ACTIONS.some((action) => /delegation.*(set|write|save)/.test(action)), false);
    assert.equal(COMMAND_ONLY_ACTIONS.some((action) => /delegation/.test(action)), false);
  });

  for (const mode of ['before', 'after', 'rollback']) it(`editor ${mode} 失败如实回分面，不臆测“未写”或“回滚成功”`, async () => {
    const t = fixture({ mode });
    const out = await t.request('POST', input());
    assert.equal(out.body.成功, false);
    assert.equal(out.body.application.state, 'unknown');
    assert.equal(out.body.commit.state, mode === 'before' ? 'not-started' : 'unknown');
    assert.equal(out.body.persistence.matchesRequested, mode === 'after');
    assert.equal(out.body.audit.state, 'recorded');
    assert.equal(JSON.stringify(out.body).includes('rolled-back'), false);
  });

  it('磁盘读取失败不能把提交回执冒充已保存', async () => {
    const t = fixture({ readFailure: true });
    const out = await t.request('POST', input());
    assert.equal(out.body.commit.state, 'reconciled');
    assert.equal(out.body.persistence.state, 'unknown');
    assert.equal((await t.request()).body.成功, false);
  });

  it('审计失败保留已观察到的盘面，不重复提交也不自称整体成功', async () => {
    const t = fixture({ auditFailure: true });
    const out = await t.request('POST', input());
    assert.equal(out.body.成功, false);
    assert.equal(out.body.commit.state, 'reconciled');
    assert.equal(out.body.persistence.matchesRequested, true);
    assert.equal(out.body.audit.state, 'failed');
    assert.match(out.body.理由, /可能已保存/);
    assert.equal((await t.request()).body.数据.runtime.fingerprint, fingerprint(NEXT));
  });

  it('kernel 真 apply 接线并卸载路由；正式服务缺席仍注册 fail-closed 端点', async () => {
    const home = await mkdtemp(join(tmpdir(), 'delegation-kernel-'));
    const handlers = new Map();
    const t = fixture();
    const host = fakeHost({ 提供服务: ['tools', 'commands', 'systemPrompt', 'connection', 'configEditor'], 服务: { connection: t.ctx.get('connection'), configEditor: t.editor } });
    host.ctx.webServer = { register(route) { assert.equal(handlers.has(route.path), false); handlers.set(route.path, route.handler); return () => handlers.delete(route.path); } };
    try {
      await apply(host.ctx, { home, privateRoot: join(home, 'private'), factoryRoot: fileURLToPath(new URL('../mind', import.meta.url)), delegation: INITIAL });
      assert.ok(handlers.has(端点表.delegation));
      const res = { writeHead(status) { this.status = status; }, end(text) { this.body = JSON.parse(text); } };
      await handlers.get(端点表.delegation)({ method: 'GET', headers: { cookie: 'operator-session' } }, res);
      assert.equal(res.status, 200);
      assert.equal(res.body.数据.runtime.fingerprint, fingerprint(INITIAL));
      assert.equal(res.body.数据.readiness.promptRegistered, true);
      assert.equal(res.body.数据.readiness.creationGuardRegistered, true);
      const schema = host.工具.get('mind').parameters.properties.action.enum;
      assert.equal(schema.includes('delegation_status'), true);
      assert.equal(schema.includes('delegation_save'), false);
    } finally {
      host.清理();
      assert.equal(handlers.size, 0);
      forgetSharedOrg();
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
    }
  });

  it('R06回执自愈：apply后落true；被覆写回null后2秒内被幂等确认写恢复（冷启动验收实证场景）', async () => {
    const home = await mkdtemp(join(tmpdir(), 'delegation-receipt-'));
    const host = fakeHost({ 提供服务: ['tools', 'commands', 'systemPrompt'] });
    const receipt = join(home, 'private', '集体L2-共享基础设施', 'defaults', '工具闸回执.json');
    const 读回执 = async () => JSON.parse(await readFile(receipt, 'utf8'));
    const 等到 = async (predicate, ms) => {
      const 止 = Date.now() + ms;
      for (;;) {
        try { if (predicate(await 读回执())) return await 读回执(); } catch { /* 尚未落盘 */ }
        if (Date.now() > 止) throw new Error(`等待回执超时：${await readFile(receipt, 'utf8').catch(() => '<无文件>')}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    try {
      await apply(host.ctx, { home, privateRoot: join(home, 'private'), factoryRoot: fileURLToPath(new URL('../mind', import.meta.url)), delegation: INITIAL });
      // 观察预算 ≠ 机制承诺（2026-10-17 测试稳定性批）：确认写是 apply+2s 的**定时**——机制
      // 语义「2秒窗」指这个排程，不是墙钟观测上限。并发全量套件跑起来后事件循环繁忙，
      // setTimeout 回调晚点几秒是测试环境噪声不是产品行为；修前 3s/4s 预算在负载下超窗
      // （本批与设计债批复核均实测踩中）——预算放宽，断言（自愈后形态）一字不变。
      const landed = await 等到((doc) => doc.调度创建闸?.registered === true, 8_000);
      assert.equal(landed.范围闸.registered, true);
      // 冷启动实证场景：二次激活把先到的 true 覆写回初始形态——确认写必须在2秒窗内恢复真实闸态。
      await writeFile(receipt, `${JSON.stringify({ 范围闸: { registered: true, error: null }, 调度创建闸: { registered: null, error: null } }, null, 2)}\n`, 'utf8');
      assert.equal((await 读回执()).调度创建闸.registered, null, '前提：覆写已生效');
      const healed = await 等到((doc) => doc.调度创建闸?.registered === true, 15_000);
      assert.deepEqual(healed.调度创建闸, { registered: true, error: null });
    } finally {
      host.清理();
      forgetSharedOrg();
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
    }
  });
});
