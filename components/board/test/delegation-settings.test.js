import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DelegationPolicy } from '../../../src/delegation-policy.js';
import { loadClient, makeStrictRequire, makeSlots, makeCtx, makeSessions, createRenderer, collect, settle, makeFetch, jsonResponse, sampleView } from './client-harness.mjs';

const INITIAL = { mode: 'lead-discretion', projects: ['plugins'], authorizationRef: 'human-grant' };
const normalized = (config) => new DelegationPolicy(config);
const asJSON = (value) => JSON.parse(JSON.stringify(value));

async function setup(options = {}) {
  let config = normalized(INITIAL).config;
  let runtime = normalized(config).status('plugins');
  let held = null;
  let holdNext = false;
  let accepted = 0;
  const fetch = makeFetch((url, init) => {
    if (url === '/plugins/dsh-mind/delegation') {
      if (init.method === 'POST') {
        const request = JSON.parse(init.body);
        const policy = normalized(request.delegation);
        if (request.expectedFingerprint !== normalized(config).fingerprint) return jsonResponse({ 成功: false, 理由: '配置冲突，请重新读取', commit: { state: 'not-started' }, audit: { state: 'recorded' } }, 409);
        if (options.mode !== 'no-save') {
          config = policy.config;
          if (options.mode !== 'old-runtime') runtime = policy.status('plugins');
          accepted += 1;
        }
        const receipt = { 成功: options.mode !== 'audit', 理由: options.mode === 'audit' ? '审计失败，配置可能已保存' : undefined, requestedFingerprint: policy.fingerprint,
          commit: { state: 'reconciled' }, persistence: { state: 'observed', fingerprint: policy.fingerprint },
          application: { state: 'unknown', requiresFreshGet: true }, audit: { state: options.mode === 'audit' ? 'failed' : 'recorded' } };
        if (options.mode === 'hang') return new Promise(() => {});
        if (options.mode === 'body-hang') return { ok: true, status: 200, text() { return new Promise(() => {}); } };
        return jsonResponse(receipt, options.mode === 'audit' ? 503 : 200);
      }
      const fingerprint = normalized(config).fingerprint;
      const payload = { 成功: true, 数据: { persistence: { state: 'observed', config, fingerprint, source: 'profile:dsh-mind-kernel.delegation' }, runtime,
        application: { state: runtime.fingerprint === fingerprint && !runtime.disposed ? 'confirmed' : 'unconfirmed' },
        readiness: { promptRegistered: true, creationGuardRegistered: true }, adapters: { agentTeams: true, subagents: true } } };
      if (options.badGet) return jsonResponse({ 成功: true, 数据: {} });
      if (holdNext) {
        holdNext = false;
        const snapshot = asJSON(payload);
        return new Promise((resolve) => { held = () => resolve(jsonResponse(snapshot)); });
      }
      return jsonResponse(payload);
    }
    if (url.startsWith('/plugins/dsh-mind/workbench')) return jsonResponse({ 成功: true, 数据: sampleView() });
    return jsonResponse({ 成功: true, 读数: { 失联限制: true, 生效响应期限小时: 72, lost: false, 响应期限小时来源: '出厂', 失联限制来源: '出厂' } });
  });
  const loaded = loadClient({ fetch: fetch.fetch });
  const plugin = loaded.definition.factory(makeStrictRequire().require);
  const slots = makeSlots();
  const ctx = makeCtx({ slots: slots.slots, sessions: makeSessions([{ id: 'settings', main: true }]) });
  const dispose = plugin.apply(ctx);
  const component = slots.calls.register.find((row) => row.options.name === 'settings.section').Component;
  const renderer = createRenderer(component, {});
  renderer.flush();
  await settle();
  renderer.flush();
  const elements = () => collect(renderer.tree, { skipStyle: true }).elements;
  const field = (label) => elements().find((node) => node.props['aria-label'] === label);
  const button = (label) => elements().find((node) => node.type === 'button' && node.props.children === label);
  return {
    loaded, renderer, calls: fetch.calls, field, button,
    get accepted() { return accepted; }, get config() { return config; },
    text: () => collect(renderer.tree, { skipStyle: true }).text,
    change(label, value) { field(label).props.onChange({ target: { value } }); renderer.flush(); },
    async click(label) { button(label).props.onClick(); await settle(); renderer.flush(); },
    async poll() { loaded.timers.intervals[0].fn(); await settle(); renderer.flush(); },
    hold() { holdNext = true; },
    async release() { assert.ok(held); held(); await settle(); renderer.flush(); },
    external(next) { config = normalized(next).config; runtime = normalized(config).status('plugins'); },
    async timeout() { loaded.timers.fireTimeouts(); await settle(); renderer.flush(); },
    close() { renderer.unmount(); dispose(); },
  };
}

describe('调度设置浏览器闭环（独立真形状夹具，presence-only 495 断言不放宽）', () => {
  it('展示模式/项目/依据/两面读数及撤回后不终止已有成员边界', async () => {
    const t = await setup();
    try {
      assert.equal(t.field('调度模式').props.value, INITIAL.mode);
      assert.equal(t.field('授权项目').props.value, 'plugins');
      assert.equal(t.field('授权依据').props.value, INITIAL.authorizationRef);
      assert.match(t.text(), /运行配置已同步/);
      assert.match(t.text(), /撤回不会终止已有成员/);
      assert.match(t.text(), /模型工具不提供改授权动作/);
      assert.ok(t.button('撤回自主调度'));
      const subtree = collect(t.renderer.tree).elements.find((node) => node.props['data-dshmind'] === 'delegation-settings');
      const controls = collect(subtree).elements.filter((node) => ['select', 'input', 'button'].includes(node.type));
      assert.equal(controls.filter((node) => String(node.props.className).includes('--primary')).length, 1);
      assert.equal(controls.every((node) => String(node.props.className).startsWith('dshmind-set__')), true);
    } finally { t.close(); }
  });

  it('保存 POST 后必须独立 GET，盘面和新运行策略一致后才确认', async () => {
    const t = await setup();
    try {
      t.change('授权项目', '*, plugins, plugins');
      t.change('授权依据', 'new human grant');
      assert.match(t.text(), /全项目授权/);
      const before = t.calls.length;
      await t.click('保存调度授权');
      const calls = t.calls.slice(before).filter((row) => row.url === '/plugins/dsh-mind/delegation');
      assert.deepEqual(calls.map((row) => row.method), ['POST', 'GET']);
      assert.deepEqual(JSON.parse(calls[0].body), { delegation: { mode: 'lead-discretion', projects: ['*', 'plugins'], authorizationRef: 'new human grant' }, expectedFingerprint: normalized(INITIAL).fingerprint });
      assert.match(t.text(), /已保存，盘面与新的运行授权读数一致/);
      assert.match(t.text(), /提示词实际应用待下一轮验证/);
      assert.equal(calls[1].cache, 'no-store');
    } finally { t.close(); }
  });

  it('撤回专用按钮保存 explicit-user，不终止成员且仍可重新授权', async () => {
    const t = await setup();
    try {
      await t.click('撤回自主调度');
      assert.equal(t.config.mode, 'explicit-user');
      assert.equal(t.field('调度模式').props.value, 'explicit-user');
      assert.match(t.text(), /仅用户点名/);
      assert.match(t.text(), /不会终止已有成员/);
      t.change('调度模式', 'lead-discretion');
      await t.click('保存调度授权');
      assert.equal(t.config.mode, 'lead-discretion');
    } finally { t.close(); }
  });

  it('草稿不被轮询吞掉；已知过期指纹禁用保存并引导采用当前配置', async () => {
    const t = await setup();
    try {
      t.change('授权依据', 'unfinished human draft');
      t.external({ mode: 'explicit-user', projects: ['external'], authorizationRef: '' });
      await t.poll();
      assert.equal(t.field('授权依据').props.value, 'unfinished human draft');
      assert.equal(t.field('授权项目').props.value, 'plugins');
      assert.equal(t.button('保存调度授权').props.disabled, true);
      // 失效按钮闭包或回车也不能旁路提交已知过期的草稿。
      t.button('保存调度授权').props.onClick(); await settle(); t.renderer.flush();
      assert.equal(t.accepted, 0);
      assert.match(t.text(), /授权配置已在别处更新/);
      assert.equal(t.calls.filter(row => row.method === 'POST').length, 0);
      assert.equal(t.field('授权依据').props.value, 'unfinished human draft');
      await t.click('采用当前配置');
      assert.equal(t.field('授权项目').props.value, 'external');
      assert.equal(t.field('授权依据').props.value, '');
    } finally { t.close(); }
  });

  it('未被轮询观察到的竞争更新仍由宿主指纹校验拒绝，独立回读保留草稿', async () => {
    const t = await setup();
    try {
      t.change('授权依据', 'unfinished human draft');
      t.external({ mode: 'explicit-user', projects: ['external'], authorizationRef: '' });
      await t.click('保存调度授权');
      assert.equal(t.accepted, 0);
      assert.match(t.text(), /配置冲突/);
      assert.equal(t.field('授权依据').props.value, 'unfinished human draft');
      assert.equal(t.button('保存调度授权').props.disabled, true);
      assert.ok(t.button('采用当前配置'));
    } finally { t.close(); }
  });

  it('保存后的新回读不被先发后到旧轮询盖回', async () => {
    const t = await setup();
    try {
      t.hold();
      await t.poll();
      await t.click('撤回自主调度');
      await t.release();
      assert.equal(t.field('调度模式').props.value, 'explicit-user');
      assert.match(t.text(), /已保存，盘面与新的运行授权读数一致/);
    } finally { t.close(); }
  });

  for (const mode of ['old-runtime', 'no-save']) it(`${mode} 不能拿 POST reconciled 当生效`, async () => {
    const t = await setup({ mode });
    try {
      await t.click('撤回自主调度');
      assert.doesNotMatch(t.text(), /已保存，盘面与新的运行授权读数一致/);
      assert.match(t.text(), /未确认生效/);
      assert.ok(t.calls.filter((row) => row.url === '/plugins/dsh-mind/delegation' && row.method === 'GET').length >= 2);
    } finally { t.close(); }
  });

  it('审计部分失败仍保留结构化回执并新 GET，不报未写入', async () => {
    const t = await setup({ mode: 'audit' });
    try {
      await t.click('撤回自主调度');
      assert.match(t.text(), /盘面与运行授权已一致，但提交或审计回执未完整确认/);
      assert.match(t.text(), /审计：失败/);
      assert.doesNotMatch(t.text(), /已保存，盘面与新的运行授权读数一致/);
      assert.equal(t.accepted, 1);
    } finally { t.close(); }
  });

  for (const mode of ['hang', 'body-hang']) it(`${mode} 超时之后新 GET 发现已保存，也不能编造审计成功`, async () => {
    const t = await setup({ mode });
    try {
      t.button('撤回自主调度').props.onClick();
      await settle(); t.renderer.flush();
      await t.timeout();
      assert.match(t.text(), /回执未完整确认/);
      assert.match(t.text(), /审计：未知/);
      assert.doesNotMatch(t.text(), /已保存，盘面与新的运行授权读数一致/);
      assert.equal(t.accepted, 1);
      assert.equal(t.calls.filter((row) => row.method === 'POST').length, 1, '超时不能自动重发');
    } finally { t.close(); }
  });

  it('无有效回读不可保存；启用授权缺字段在本地拒绝', async () => {
    const absent = await setup({ badGet: true });
    try {
      assert.equal(absent.button('保存调度授权').props.disabled, true);
      assert.match(absent.text(), /调度设置未接入/);
    } finally { absent.close(); }
    const t = await setup();
    try {
      t.change('授权项目', '');
      t.change('授权依据', '');
      await t.click('保存调度授权');
      assert.match(t.text(), /必须填写项目范围和授权依据/);
      assert.equal(t.calls.filter((row) => row.method === 'POST').length, 0);
    } finally { t.close(); }
  });
});
