// ═══════════════════════════════════════════════════════════════════════════════
// dsh-mind · 浏览器半边的 Node harness
// ═══════════════════════════════════════════════════════════════════════════════
//
// 这里不"模拟一个 React"，而是跑一个**最小真渲染器**：hooks 有槽位、state 会触发
// 重渲染、effect 有依赖比较与 cleanup。这样 `lib/client.js` 里的组件是被**真的执行**
// 了一遍（包括 useEffect 里的取数逻辑），而不是被 stub 掉——否则"渲染出一棵树"
// 这条断言就没有意义。
//
// 覆盖的断言（`runHarness()` 的返回值里逐条列出）：
//   1. 经典脚本形态：`window.__ModuleLoader__.load({id, factory})` 被调用，id 是新包名；
//   2. 工厂返回插件体：name / inject / apply，且只 require react 系模块；
//   3. 两处席位注册：`main`（带 key `dsh-mind`）与 `sidebar.panellist`（图标排在插件入口下面）
//      （带 id 与 label 函数），且**不再**注册 `settings.section`；
//      apply 的返回值能把两处一起撤下（合并 disposer）；
//   4. 首帧就渲染出一棵非平凡的树（一条数据都没有时也一样）：标题、四个分区全在，
//      空态文案是「没有需要你决定的事」这类明说的话，不是空白；
//   5. 装了 remote：调 `/mind dashboard`、解析 JSON、把活数据画上去，并把快照落缓存；
//      状态条（闸 / 介入度 / 失联 / 探针见红）、待你决定的命令、会审的揭名与零分歧都在；
//   6. remote 缺失 / ctx.get 抛错 / 返回 error / Promise reject / 返回非 JSON /
//      返回体结构不明 —— 六条降级路径都**不许抛**，且都渲染出「未连接」+ 旧快照；
//   7. 定位不到会话 id —— 优雅空态，不是抛错、不是空白；
//   8. 侧边栏入口：只画 svg 标记，点击与文案都归宿主那一行；
//   9. 时钟：注册 30s 自动刷新，卸载时 clearInterval。
//  10. 状态条告警：闸不在位 / 已失联 / 探针见红 —— 读数块进告警样式，不只是换个点色。
//  11. 会审：未交齐（揭名 false）只出盲标 + 锁行，成员 id 一个都不许出；交齐后两者都给。
//  12. 零分歧 true 渲染成**异常**，复核三态三档三个类名。
//
// 只用 node 内置模块，不装任何东西。

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

/** 被测文件（经典脚本）的绝对路径。 */
export const CLIENT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js');
/** 包名：loader 的 id 与插件体的 name 都必须是它。 */
export const PACKAGE_NAME = 'dsh-mind-board';
/** 主面板的 key，也是侧边栏入口的 id。 */
export const PANEL_KEY = 'dsh-mind';
/** 宿主命令：与 lib/client.js 里的常量一致。 */
export const COMMAND = '/mind dashboard';
/** 本地缓存键：与 lib/client.js 里的常量一致。 */
export const CACHE_KEY = 'dsh-mind.dashboard.v1';
/** 自动刷新间隔：与 lib/client.js 里的常量一致。 */
export const REFRESH_MS = 30000;

// ── 最小渲染器 ────────────────────────────────────────────────────────────────
let renderCtx = null;

function sameDeps(prev, next) {
  if (next === undefined) return false;
  if (!Array.isArray(prev) || !Array.isArray(next)) return false;
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i += 1) if (!Object.is(prev[i], next[i])) return false;
  return true;
}

function createElement(type, props, ...children) {
  const next = Object.assign({}, props || {});
  if (children.length === 1) next.children = children[0];
  else if (children.length > 1) next.children = children;
  const key = props && props.key !== undefined && props.key !== null ? props.key : null;
  return { $$element: true, type, key, props: next };
}

function useHookState(init) {
  const state = renderCtx;
  const index = state.cursor;
  state.cursor += 1;
  if (!state.hooks[index]) {
    state.hooks[index] = { kind: 'state', value: typeof init === 'function' ? init() : init };
  }
  const slot = state.hooks[index];
  return [slot.value, function set(next) {
    slot.value = typeof next === 'function' ? next(slot.value) : next;
    state.dirty = true;
  }];
}

function useHookEffect(fn, deps) {
  const state = renderCtx;
  const index = state.cursor;
  state.cursor += 1;
  const prev = state.hooks[index];
  if (!sameDeps(prev && prev.deps, deps)) {
    state.hooks[index] = {
      kind: 'effect', fn, deps, pending: true, cleanup: prev ? prev.cleanup : undefined,
    };
  }
}

function useHookRef(initial) {
  const state = renderCtx;
  const index = state.cursor;
  state.cursor += 1;
  if (!state.hooks[index]) state.hooks[index] = { kind: 'ref', current: initial };
  return state.hooks[index];
}

const React = {
  createElement,
  useState(init) { return useHookState(init); },
  useEffect(fn, deps) { return useHookEffect(fn, deps); },
  useRef(initial) { return useHookRef(initial); },
};

/** 挂载一个组件：`render()` 出树、`flush()` 跑 effect 到收敛、`unmount()` 跑 cleanup。 */
export function createRenderer(component, props) {
  const state = { hooks: [], cursor: 0, dirty: false, tree: null };

  function render() {
    state.cursor = 0;
    renderCtx = state;
    try {
      state.tree = component(props || {});
    } finally {
      renderCtx = null;
    }
    return state.tree;
  }

  function runEffects() {
    for (const slot of state.hooks) {
      if (!slot || slot.kind !== 'effect' || !slot.pending) continue;
      slot.pending = false;
      if (typeof slot.cleanup === 'function') slot.cleanup();
      const out = slot.fn();
      slot.cleanup = typeof out === 'function' ? out : undefined;
    }
  }

  render();

  return {
    render,
    get tree() { return state.tree; },
    /** 跑到状态收敛；返回渲染轮数。 */
    flush(maxRounds = 25) {
      let rounds = 0;
      runEffects();
      while (state.dirty && rounds < maxRounds) {
        state.dirty = false;
        render();
        runEffects();
        rounds += 1;
      }
      return rounds;
    },
    unmount() {
      for (const slot of state.hooks) {
        if (slot && slot.kind === 'effect' && typeof slot.cleanup === 'function') slot.cleanup();
      }
    },
  };
}

/** 让所有已排队的 Promise 链跑完。 */
export function settle(rounds = 6) {
  let chain = Promise.resolve();
  for (let i = 0; i < rounds; i += 1) {
    chain = chain.then(() => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  return chain;
}

// ── 树遍历 ────────────────────────────────────────────────────────────────────
export function collect(tree, options = {}) {
  const elements = [];
  const texts = [];
  (function visit(node) {
    if (node === null || node === undefined || typeof node === 'boolean') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (typeof node === 'string' || typeof node === 'number') { texts.push(String(node)); return; }
    if (!node || node.$$element !== true) return;
    elements.push(node);
    if (options.skipStyle && node.type === 'style') return;
    visit(node.props.children);
  })(tree);
  return { elements, texts, text: texts.join('\n') };
}

export function classNames(tree) {
  return collect(tree, { skipStyle: true }).elements
    .map((el) => (typeof el.props.className === 'string' ? el.props.className : ''))
    .filter(Boolean);
}

/**
 * 按**类名 token** 找元素（按空格切开比对，所以 `dshmind-review` 不会命中 `dshmind-reviews`）。
 * 会审的断言必须落在单张卡片上：同一页里 `member-a` 既可能出现在揭名的那场，
 * 也可能（不该）出现在未揭名的那场，整页文本搜索分不出来。
 */
export function findAllByClass(tree, token) {
  return collect(tree, { skipStyle: true }).elements.filter((el) => {
    const value = el.props && el.props.className;
    return typeof value === 'string' && value.split(/\s+/).indexOf(token) >= 0;
  });
}

/** 某个元素子树里的文本（配合 findAllByClass 做「这场会审里有什么」的断言）。 */
export function textOf(node) {
  return collect(node, { skipStyle: true }).text;
}

// ── 假服务 ────────────────────────────────────────────────────────────────────
export function makeSlots() {
  const calls = { inject: [], register: [], disposed: 0 };
  const slots = {
    inject(name, callback) {
      calls.inject.push(name);
      if (typeof callback !== 'function') throw new Error('slots.inject 第二个参数必须是函数');
      return callback();
    },
    register(options, Component) {
      calls.register.push({ options, Component });
      return function dispose() { calls.disposed += 1; };
    },
  };
  return { slots, calls };
}

/** `sessions.list` 快照：官方口径的「用户正在看的会话」是 retainedBy.mainView > 0。 */
export function makeSessions(rows) {
  const ids = [];
  const byId = {};
  for (const row of rows) {
    ids.push(row.id);
    byId[row.id] = { running: false, retainedBy: { mainView: row.main ? 1 : 0 } };
  }
  return { list: { getSnapshot: () => ({ phase: 'ready', ids, byId }) } };
}

export function makeCtx(services) {
  const box = Object.assign({}, services);
  const throwOn = services.throwOn || [];
  return {
    slots: services.slots,
    get(name) {
      if (throwOn.indexOf(name) >= 0) throw new Error('service "' + name + '" 读取时抛错');
      return box[name];
    },
    inject() { return function noop() {}; },
  };
}

/** 让 remote 记住每次调用，便于断言命令名与会话 id。 */
export function makeRemote(handler) {
  const calls = [];
  return {
    calls,
    remote: {
      commands: {
        execute(sessionId, command, attachments) {
          calls.push({ sessionId, command, attachments });
          return handler(sessionId, command, attachments);
        },
      },
    },
  };
}

export function okReply(view) {
  return { ok: true, value: { result: { kind: 'success', text: JSON.stringify(view) } } };
}

// ── 装载经典脚本 ──────────────────────────────────────────────────────────────
/**
 * 在一个干净的 vm 上下文里执行 lib/client.js，捕获 loader 定义。
 * @param {{ store?: Map<string,string>, sessionId?: string }} [options]
 *   `store` 可跨次复用以模拟同一个浏览器（缓存跨插件加载存活）。
 */
export function loadClient(options = {}) {
  const store = options.store || new Map();
  const timers = { intervals: [], cleared: [] };
  let definition = null;
  let loaderCalls = 0;

  const win = {
    __ModuleLoader__: { load(def) { loaderCalls += 1; definition = def; } },
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, String(value)); },
      removeItem: (key) => { store.delete(key); },
    },
    setInterval(fn, ms) { timers.intervals.push({ fn, ms }); return timers.intervals.length; },
    clearInterval(id) { timers.cleared.push(id); },
  };
  if (options.sessionId) win.__dshSessionId = options.sessionId;

  const warnings = [];
  const sandbox = {
    window: win,
    console: {
      warn: (...args) => warnings.push(args.map(String).join(' ')),
      error: (...args) => warnings.push(args.map(String).join(' ')),
      log() {},
    },
  };
  vm.createContext(sandbox);
  new vm.Script(readFileSync(CLIENT_PATH, 'utf8'), { filename: CLIENT_PATH }).runInContext(sandbox);

  return { win, store, timers, warnings, get loaderCalls() { return loaderCalls; }, get definition() { return definition; } };
}

/** 严格 require：只暴露 react / react/jsx-runtime，其它一律抛错（宿主内部包必须抛）。 */
export function makeStrictRequire() {
  const asked = [];
  return {
    asked,
    require(name) {
      asked.push(name);
      if (name === 'react') return React;
      if (name === 'react/jsx-runtime') return { jsx: createElement, jsxs: createElement, Fragment: 'Fragment' };
      throw new Error('未声明的模块：' + name);
    },
  };
}

// ── 样本数据 ──────────────────────────────────────────────────────────────────
/**
 * 一份**真实形状**的投影（`src/workbench.js` 的 `projectWorkbench` 输出）。
 * 故意包含：闸在位 / 未失联 / 探针见红；两种揭名状态的会审；零分歧 true 的一场；
 * 三种审计档位各一条。这样每条界面断言都有真数据可打。
 */
export function sampleView() {
  return {
    项目: 'mind-private',
    生成于: '2026-10-07T17:20:37+08:00',
    边界: { 只读: true, 说明: '工作台是投影：它不存储、不做讨论、不做权威记录。' },
    状态条: {
      闸: { 在位: true, 规则数: 5, 错误: null },
      介入度: '事后抽检',
      失联: false,
      探针: { 状态: '异常', 见红: ['审计链'], 恒红: false, 恒绿: true },
    },
    待你决定: [
      {
        类型: '待决项', 节点: 't-3', 描述: '审计档位分级落地', 原因: '出厂与私有两条都改了同一条',
        可选项: ['用出厂版', '用我的版'], 命令: '/mind task_resolve id=t-3 决定=用出厂版',
      },
      {
        类型: '打回升级', 节点: 't-2', 描述: '校准策略引擎的拒绝理由',
        原因: '同一节点打回 2 次（§8：≥2 次升级主权者）', 可选项: [], 命令: '/mind workbench',
      },
    ],
    任务: {
      总数: 3,
      计数: { 待派发: 0, 进行中: 1, 已交卷: 1, 已采纳: 0, 已打回: 1, 未验: 0, 待决: 1 },
      节点: [
        {
          id: 't-1', 描述: '把工作台投影接上客户端', 状态: '执行中', 负责人: ['role-α'], 模式: null,
          判据: ['刷新后可见实时状态'], 判据冻结: true, 依赖: [], 打回次数: 0,
          产物: ['artifact-1', { id: 'artifact-2', kind: '产物' }], 交卷: { 已交: 0, 应交: 1, 齐: false },
        },
        {
          id: 't-2', 描述: '校准策略引擎的拒绝理由', 状态: '已打回', 负责人: ['role-β'], 模式: null,
          判据: ['每条拒绝都带可执行理由'], 判据冻结: true, 依赖: [], 打回次数: 2, 产物: [],
          交卷: { 已交: 0, 应交: 1, 齐: false }, 升级: '打回 ≥2 次',
        },
        {
          id: 't-3', 描述: '审计档位分级落地', 状态: '待决', 负责人: ['role-γ'], 模式: null,
          判据: ['三档分级与 §7 表格一致'], 判据冻结: false, 依赖: ['t-1'], 打回次数: 0, 产物: [],
          交卷: { 已交: 0, 应交: 1, 齐: false }, 待决原因: '出厂与私有两条都改了同一条',
        },
      ],
    },
    会审: [
      {
        // 未交齐（2/3）：只许出盲标
        节点: 't-4', 描述: '双人独立会审：投影字段收敛', 模式: '独立会审', 揭名: false,
        交卷: { 已交: 2, 应交: 3, 齐: false },
        独立答案: [
          { 盲标: '成员 A', 成员: 'member-x1', 结论: '字段够用', 反例面: ['缺视图切片'], 产出物引用: ['artifact-a'] },
          { 盲标: '成员 B', 成员: 'member-x2', 结论: '缺审计档位', 反例面: [], 产出物引用: [] },
        ],
        分歧清单: ['审计档位是否逐条'], 反例面: ['权限矩阵未覆盖自动派发'],
        零分歧: false, 零分歧依据: '结论文本不同', 复核三态: '未验', 复核者: 'reviewer-1',
      },
      {
        // 交齐（3/3）且全票一致：揭名，但零分歧要当异常画
        节点: 't-5', 描述: '会审：审计档位分级', 模式: '独立会审', 揭名: true,
        交卷: { 已交: 3, 应交: 3, 齐: true },
        独立答案: [
          { 盲标: '成员 A', 成员: 'member-a', 结论: '三档划分正确', 反例面: [], 产出物引用: [] },
          { 盲标: '成员 B', 成员: 'member-b', 结论: '三档划分正确', 反例面: [], 产出物引用: [] },
          { 盲标: '成员 C', 成员: 'member-c', 结论: '三档划分正确', 反例面: [], 产出物引用: [] },
        ],
        分歧清单: [], 反例面: [], 零分歧: true, 零分歧依据: '三份结论逐字一致',
        复核三态: '过', 复核者: 'reviewer-1',
      },
      {
        节点: 't-6', 描述: '会审：派发后判据冻结', 模式: '独立会审', 揭名: true,
        交卷: { 已交: 2, 应交: 2, 齐: true },
        独立答案: [
          { 盲标: '成员 A', 成员: 'member-d', 结论: '冻结点正确', 反例面: ['边界未覆盖复派'], 产出物引用: [] },
          { 盲标: '成员 B', 成员: 'member-e', 结论: '冻结点过早', 反例面: [], 产出物引用: [] },
        ],
        分歧清单: ['冻结时点是否该在派发前'], 反例面: ['复派场景未测'],
        零分歧: false, 零分歧依据: '结论互斥', 复核三态: '不过', 复核者: 'reviewer-2',
      },
    ],
    审计尾: [
      { seq: 1, 时间: '2026-10-07T17:01:02+08:00', 动作: '策略拒绝', 主体: 'role-β', 结果: '拒绝', 档位: '全记', 告警: false },
      { seq: 2, 时间: '2026-10-07T17:02:03+08:00', 动作: '工具调用成功', 主体: 'role-α', 结果: '成功', 档位: '记汇总', 告警: false },
      { seq: 3, 时间: '2026-10-07T17:03:04+08:00', 动作: '只读调用', 主体: 'role-α', 结果: '记', 档位: '不逐次记', 告警: false },
      { seq: 4, 时间: '2026-10-07T17:04:05+08:00', 动作: '零分歧异常', 主体: { id: 'lead', kind: 'Lead' }, 结果: '触发人工抽检', 档位: '全记', 告警: true },
    ],
  };
}

/** 同一份投影，但闸不在位 + 已失联 + 探针见红两条：验状态条的告警外观。 */
export function alarmingView() {
  const view = sampleView();
  view.状态条 = {
    闸: { 在位: false, 规则数: 0, 错误: '策略引擎未加载' },
    介入度: '逐条审批',
    失联: true,
    探针: { 状态: '异常', 见红: ['审计链', '闸在位'], 恒红: true, 恒绿: false },
  };
  return view;
}

/** 清空「待你决定」：验空态是明说的那句话，而不是空白。 */
export function noDecisionView() {
  const view = sampleView();
  view.待你决定 = [];
  return view;
}

/** 页面上一旦缺数据就会出现的占位文本；给全量数据时不该出现。 */
export const DEGRADED_MARKS = [
  '未连接', '未接入', '任务图为空', '没有需要你决定的事', '没有进行中的会审', '审计尾为空',
];
/** 未交齐时的锁行：文案本身就是断言目标（§10 未交齐不揭名）。 */
export const LOCK_LINE = '🔒 未交齐，讨论保持锁定';
export const VERDICT_CLASSES = ['dshmind-verdictPass', 'dshmind-verdictFail', 'dshmind-verdictUnverified'];
export const AUDIT_CLASSES = ['dshmind-auditFull', 'dshmind-auditMid', 'dshmind-auditLow'];
export const ENTRY_LABEL = '心智 · 数字组织';

// ── 断言 ──────────────────────────────────────────────────────────────────────
class HarnessFailure extends Error {}

function check(passed, name, detail) {
  if (!passed) throw new HarnessFailure(name + (detail ? '　→ ' + detail : ''));
  return name;
}

/** 装载 + apply，返回渲染器所需的全部把手。 */
function boot(options = {}) {
  const loaded = loadClient({ store: options.store, sessionId: options.sessionId });
  check(loaded.loaderCalls === 1, 'loader 被调用一次', '实际 ' + loaded.loaderCalls + ' 次');
  const def = loaded.definition;
  check(!!def && def.id === PACKAGE_NAME, '工厂 id 是包名 ' + PACKAGE_NAME, String(def && def.id));
  check(typeof def.factory === 'function', 'factory 是函数');

  const strict = makeStrictRequire();
  const plugin = def.factory(strict.require);
  check(!!plugin && plugin.name === PACKAGE_NAME, '插件体 name 是 ' + PACKAGE_NAME, String(plugin && plugin.name));
  check(Array.isArray(plugin.inject) && plugin.inject.indexOf('slots') >= 0,
    '插件体 inject 含 slots', JSON.stringify(plugin.inject));
  check(typeof plugin.apply === 'function', '插件体 apply 是函数');

  const { slots, calls } = makeSlots();
  const ctx = makeCtx(Object.assign({ slots }, options.services));
  const disposer = plugin.apply(ctx);
  return { loaded, strict, plugin, slots, calls, ctx, disposer, timers: loaded.timers, warnings: loaded.warnings };
}

function registrationOf(booted, slotName) {
  const registration = booted.calls.register.find((r) => r.options.name === slotName);
  check(!!registration, '注册了 ' + slotName);
  return registration;
}

function mountDashboard(booted) {
  return createRenderer(registrationOf(booted, 'main').Component, {});
}

/**
 * 渲染侧边栏那一格的图标。
 * 宿主传的是 `{ size, active }`（见侧边栏的 PanelRow：`renderSlot("sidebar.panellist", {size, active}, {only: id})`）。
 */
function mountEntry(booted, props) {
  return createRenderer(registrationOf(booted, 'sidebar.panellist').Component, props);
}

function session() {
  return { sessions: makeSessions([{ id: 'sess-main', main: true }]) };
}

async function textAfterLoad(renderer) {
  renderer.flush();
  await settle();
  renderer.flush();
  return collect(renderer.tree, { skipStyle: true }).text;
}

// ── 主流程 ────────────────────────────────────────────────────────────────────
/**
 * 跑完整套断言。失败抛错（含具体哪一条）；成功返回报告。
 * @returns {Promise<{passed: string[], liveElements: number, liveTexts: number}>}
 */
export async function runHarness() {
  const passed = [];
  const store = new Map();

  // ① 经典脚本 + 插件体 + 两处席位注册（这条路径没有 remote：降级）
  const a = boot({ services: session() });
  passed.push(check(a.loaded.definition.factory.length <= 1, 'factory 只接收 require 参数'));
  passed.push(check(a.strict.asked.every((n) => n === 'react' || n === 'react/jsx-runtime'),
    '只 require react 系模块（未 require 宿主内部包）', a.strict.asked.join(',')));

  const injected = a.calls.inject.slice().sort();
  passed.push(check(injected.length === 2 && injected[0] === 'main' && injected[1] === 'sidebar.panellist',
    'inject 的槽位恰好是 main + sidebar.panellist', a.calls.inject.join(',')));
  passed.push(check(a.calls.inject.indexOf('settings.section') < 0,
    '不再注册 settings.section（看板已搬出设置页）'));
  passed.push(check(a.calls.inject.indexOf('sidebar.footer.action') < 0,
    '不再占用侧边栏页脚席位（入口移到插件入口下面）'));
  passed.push(check(a.calls.register.length === 2, '恰好两处 register', String(a.calls.register.length)));

  const mainOptions = registrationOf(a, 'main').options;
  passed.push(check(mainOptions.key === PANEL_KEY, 'main 席位带 key ' + PANEL_KEY, JSON.stringify(mainOptions)));
  passed.push(check(typeof a.disposer === 'function', 'apply 返回合并后的 disposer'));
  a.disposer();
  passed.push(check(a.calls.disposed === 2, '撤下时两处注册都被释放', String(a.calls.disposed)));

  const entryOptions = registrationOf(a, 'sidebar.panellist').options;
  passed.push(check(entryOptions.id === PANEL_KEY, '入口的 id 是 ' + PANEL_KEY, JSON.stringify(entryOptions)));
  passed.push(check(typeof entryOptions.order === 'number' && entryOptions.order > 0,
    '入口 order > 0：插件入口是 0，所以本组件排在它下面', String(entryOptions.order)));
  passed.push(check(typeof entryOptions.label === 'function' && String(entryOptions.label()).length > 0,
    '入口带 label 函数（窄轨工具提示与无障碍名由侧边栏取用）', String(entryOptions.label && entryOptions.label())));

  // ①b 看板是「按需」组件：宿主说关着，浏览器半区必须自己撤下两处席位。
  const offSpy = makeRemote((sessionId, command) => {
    if (command === '/mind components') {
      return Promise.resolve({ ok: true, value: { result: { kind: 'success', text: JSON.stringify({ 成功: true, 组件: { kernel: { 已装载: true }, board: { 已装载: false, 原因: '配置里关掉了' } } }) } } });
    }
    return Promise.resolve({ ok: true, value: { result: { kind: 'success', text: '{}' } } });
  });
  const off = boot({ services: Object.assign(session(), { remote: offSpy.remote }) });
  passed.push(check(off.calls.disposed === 0, '先注册（还没问到开关）', String(off.calls.disposed)));
  await settle();
  await settle();
  passed.push(check(offSpy.calls.some((c) => c.command === '/mind components'), '问过一次宿主的组件名册'));
  passed.push(check(off.calls.disposed === 2, '宿主说看板关着 ⇒ 两处席位自动撤下', String(off.calls.disposed)));

  // ①c 开关是「开」或问不到时，都不许乱撤
  const onSpy = makeRemote((sessionId, command) => Promise.resolve({
    ok: true,
    value: { result: { kind: 'success', text: JSON.stringify(command === '/mind components' ? { 成功: true, 组件: { board: { 已装载: true } } } : {}) } },
  }));
  const on = boot({ services: Object.assign(session(), { remote: onSpy.remote }) });
  await settle();
  await settle();
  passed.push(check(on.calls.disposed === 0, '看板开着时不撤', String(on.calls.disposed)));
  on.disposer();
  passed.push(check(on.calls.disposed === 2, '清理器照旧能撤下', String(on.calls.disposed)));

  const noAnswer = boot({ services: session() });
  await settle();
  await settle();
  passed.push(check(noAnswer.calls.disposed === 0, '问不到开关时默认显示（界面可见性不是安全边界）', String(noAnswer.calls.disposed)));
  noAnswer.disposer();
  passed.push(check(typeof entryOptions.order === 'number', '入口带数字 order'));
  passed.push(check(typeof entryOptions.label === 'function' && String(entryOptions.label()).length > 0,
    '入口 label 是函数且返回可见文案', String(entryOptions.label && entryOptions.label())));

  // ② 面板：首帧就是完整骨架（没有一条数据也一样）
  const fresh = boot({ services: session() });
  const r0 = mountDashboard(fresh);
  const c0 = collect(r0.tree, { skipStyle: true });
  passed.push(check(c0.elements.length > 60, '首帧元素数 > 60（数据全空也是完整骨架）', String(c0.elements.length)));
  passed.push(check(c0.text.includes(ENTRY_LABEL), '首帧含标题「' + ENTRY_LABEL + '」'));
  for (const section of ['待你决定', '会审', '任务图', '审计流']) {
    passed.push(check(c0.text.includes(section), '首帧含分区「' + section + '」'));
  }
  // 空态必须是**明说的话**：没有数据时最坏的结果是「信息少」，不是「猜」。
  passed.push(check(c0.text.includes('没有需要你决定的事'), '空清单时说「没有需要你决定的事」而不是留白'));
  passed.push(check(c0.text.includes('没有进行中的会审'), '空会审时给明说的空态'));
  passed.push(check(c0.text.includes('任务图为空'), '空任务图给明说的空态'));
  passed.push(check(!c0.text.includes('八件') && !c0.text.includes('受理'),
    '投影不再带八件计数与环路阶段：界面也不许再画'));

  const rounds0 = r0.flush();
  await settle();
  passed.push(check(r0.flush() >= 1, 'effect 收敛后发生重渲染', '轮数 ' + rounds0));
  const c0b = collect(r0.tree, { skipStyle: true });
  passed.push(check(c0b.text.includes('未连接') && c0b.text.includes('宿主命令服务不可用'),
    '无 remote 时给出「未连接」与原因，而不是空白或抛错'));
  passed.push(check(c0b.text.includes(ENTRY_LABEL), '降级后页面仍在'));

  // ③ 装了 remote：活数据 + 落缓存
  const spy = makeRemote(() => okReply(sampleView()));
  const b = boot({
    store,
    services: Object.assign(session(), { remote: spy.remote }),
  });
  const r1 = mountDashboard(b);
  r1.flush();
  await settle();
  const rounds1 = r1.flush();
  const c1 = collect(r1.tree, { skipStyle: true });
  passed.push(check(rounds1 >= 1, '取数成功后重渲染', '轮数 ' + rounds1));
  // 取数命令只允许一条。看板组件开关是用**另一条**命令（`/mind components`）问的，
  // 所以这里按命令名分离计数：混在一起数会把「问一次开关」误判成重复取数。
  const dashboardCalls = spy.calls.filter((call) => call.command === COMMAND);
  passed.push(check(dashboardCalls.length === 1, '取数命令只调一次', String(dashboardCalls.length)));
  passed.push(check(dashboardCalls[0].command === COMMAND, '命令是 ' + COMMAND, dashboardCalls[0].command));
  passed.push(check(dashboardCalls[0].sessionId === 'sess-main', '用的是 mainView 那个会话 id', dashboardCalls[0].sessionId));
  passed.push(check(Array.isArray(dashboardCalls[0].attachments) && dashboardCalls[0].attachments.length === 0, 'attachments 是空数组'));
  passed.push(check(c1.text.includes('mind-private'), '活数据里出现项目键'));
  passed.push(check(c1.text.includes('把工作台投影接上客户端'), '活数据里出现节点描述'));
  passed.push(check(c1.text.includes('零分歧异常'), '活数据里出现审计动作'));
  passed.push(check(c1.text.includes('打回 2 次 · 升级主权者'), '打回 ≥2 高亮为升级主权者'));
  passed.push(check(c1.text.includes('判据冻结'), '派发后判据打冻结徽章'));
  passed.push(check(c1.text.includes('artifact-1') && c1.text.includes('artifact-2'), '产物引用显示为 chip'));
  passed.push(check(c1.text.includes('活数据'), '页头显示活数据状态'));
  passed.push(check(c1.text.includes('事后抽检'), '介入度档位可见'));
  const marks = DEGRADED_MARKS.filter((m) => c1.text.includes(m));
  passed.push(check(marks.length === 0, '全量数据下不出现任何降级占位文本', marks.join(',')));

  // ③a 状态条：闸 / 探针 / 见红 / 恒绿
  passed.push(check(c1.text.includes('闸在位') && c1.text.includes('规则 5'), '状态条给「闸在位 + 规则数」'));
  passed.push(check(c1.text.includes('见红：审计链'), '状态条列出见红的探针名'));
  passed.push(check(c1.text.includes('恒绿警报'), '恒绿也要报警（恒绿与恒红一样是坏信号）'));
  passed.push(check(c1.text.includes('在位') && !c1.text.includes('已失联'), '未失联时不画失联告警'));

  // ③b 待你决定：命令是**可拿走的文本**，不是按钮
  passed.push(check(c1.text.includes('/mind task_resolve id=t-3 决定=用出厂版'), '待你决定渲染出可敲的命令文本'));
  passed.push(check(c1.text.includes('待你决定') && c1.text.includes('用我的版') && c1.text.includes('打回升级'),
    '待你决定给出类型、可选项与原因'));
  const cmd = collect(r1.tree, { skipStyle: true }).elements.find((el) => el.type === 'code');
  passed.push(check(!!cmd && String(cmd.props.className).indexOf('dshmind-cmd') >= 0,
    '命令用等宽可选中的 code 块渲染（只读工作台给文本，不给按钮）'));
  passed.push(check(c1.elements.every((el) => !el.props || typeof el.props.onClick !== 'function' || el.type === 'button'),
    '除刷新按钮外没有可点动作：待你决定里不得有按钮'));
  const decideButtons = collect(r1.tree, { skipStyle: true }).elements
    .filter((el) => el.type === 'button' && String(el.props.className || '').indexOf('dshmind-cmd') >= 0);
  passed.push(check(decideButtons.length === 0, '命令不是按钮'));

  // ③c 会审：未交齐只出盲标 + 锁行（成员 id 一个都不许出）
  const cards = findAllByClass(r1.tree, 'dshmind-review');
  passed.push(check(cards.length === 3, '三场会审各一张卡', String(cards.length)));
  const hidden = textOf(cards[0]);
  passed.push(check(hidden.includes('成员 A') && hidden.includes('成员 B'), '未交齐的会审仍给盲标'));
  passed.push(check(hidden.includes(LOCK_LINE), '未交齐的会审给锁行「' + LOCK_LINE + '」'));
  passed.push(check(!hidden.includes('member-x1') && !hidden.includes('member-x2'),
    '揭名 false 时成员 id 一个都不许出现在那张卡里', hidden.slice(0, 80)));
  passed.push(check(!c1.text.includes('member-x1') && !c1.text.includes('member-x2'),
    '揭名 false 的成员 id 在整页都不许出现'));
  passed.push(check(hidden.includes('2/3 未齐'), '交卷进度按 `2/3 未齐` 显示'));
  const shown = textOf(cards[1]);
  passed.push(check(shown.includes('成员 A') && shown.includes('member-a') && shown.includes('member-c'),
    '揭名 true 时盲标与成员 id 都给'));
  passed.push(check(!shown.includes(LOCK_LINE), '交齐的会审没有锁行'));
  passed.push(check(shown.includes('3/3 齐'), '交齐的会审显示 `3/3 齐`'));
  passed.push(check(shown.includes('分歧清单') === false && shown.includes('零分歧'), '零分歧那一场照旧报出零分歧'));
  passed.push(check(textOf(cards[0]).includes('分歧清单：审计档位是否逐条'), '分歧清单渲染出来'));
  passed.push(check(textOf(cards[0]).includes('反例面：权限矩阵未覆盖自动派发'), '会审级反例面渲染出来'));

  // ③d 零分歧是异常，不是好消息；复核三态三档三样
  const anomaly = findAllByClass(r1.tree, 'dshmind-anomaly');
  passed.push(check(anomaly.length === 1, '零分歧 true 恰好一场，且拿异常样式', String(anomaly.length)));
  passed.push(check(textOf(cards[1]).includes('零分歧') && textOf(cards[1]).includes('异常信号'),
    '零分歧 true 渲染成异常信号（§10 全票一致 = 趋同）'));
  passed.push(check(textOf(cards[1]).includes('依据：三份结论逐字一致'), '零分歧带依据'));
  passed.push(check(textOf(cards[0]).includes('存在分歧（正常）'),
    '零分歧 false 走中性文案，与异常长得不一样'));
  const classes = classNames(r1.tree);
  for (const verdict of VERDICT_CLASSES) {
    passed.push(check(classes.some((c) => c.split(/\s+/).indexOf(verdict) >= 0),
      '复核三态各有独立样式类 ' + verdict));
  }
  passed.push(check(textOf(cards[0]).includes('复核 未验'), '未验照原样显示，不是通过'));
  passed.push(check(textOf(cards[2]).includes('复核 不过'), '不过照原样显示'));
  for (const audit of AUDIT_CLASSES) {
    passed.push(check(classes.some((c) => c.split(/\s+/).indexOf(audit) >= 0),
      '审计档位各有独立样式类 ' + audit));
  }
  passed.push(check(store.has(CACHE_KEY), '成功取数后把快照写进本地缓存'));
  passed.push(check(r1.flush() === 0, '无新状态时不再重渲染（依赖比较生效）'));

  // ③e 告警态：闸不在位 / 已失联 / 探针见红两条 —— 读数块要整体进告警样式
  const alarmSpy = makeRemote(() => okReply(alarmingView()));
  const alarmed = boot({ store, services: Object.assign(session(), { remote: alarmSpy.remote }) });
  const r2 = mountDashboard(alarmed);
  r2.flush();
  await settle();
  r2.flush();
  const c2 = collect(r2.tree, { skipStyle: true });
  passed.push(check(c2.text.includes('闸不在位'), '闸不在位时明说「闸不在位」'));
  passed.push(check(c2.text.includes('策略引擎未加载'), '闸的错误理由可见'));
  passed.push(check(c2.text.includes('已失联 · 自治冻结'), '失联时明说「已失联 · 自治冻结」'));
  passed.push(check(c2.text.includes('见红：审计链、闸在位'), '见红两条都列出来'));
  passed.push(check(c2.text.includes('恒红警报'), '恒红报警'));
  const alarmClasses = classNames(r2.tree).filter((c) => c.split(/\s+/).indexOf('dshmind-readoutAlarm') >= 0);
  passed.push(check(alarmClasses.length >= 2,
    '闸不在位与已失联两块读数都进告警样式，不只是换个点色', String(alarmClasses.length)));
  r2.unmount();

  // ③f 待你决定为空：空态是明说的一句话
  const emptySpy = makeRemote(() => okReply(noDecisionView()));
  const empty = boot({ store, services: Object.assign(session(), { remote: emptySpy.remote }) });
  const r3 = mountDashboard(empty);
  r3.flush();
  await settle();
  r3.flush();
  const c3 = collect(r3.tree, { skipStyle: true });
  passed.push(check(c3.text.includes('没有需要你决定的事'), '待你决定为空时给「没有需要你决定的事」', c3.text.slice(0, 60)));
  passed.push(check(!c3.text.includes('/mind task_resolve'), '空清单里不得残留命令文本'));
  r3.unmount();

  // ④ 侧边栏入口：只画图标（整行的按钮、标签、点击都归宿主侧边栏的 PanelRow）
  const glyphWide = mountEntry(a, { size: 18, active: false });
  const glyphElements = collect(glyphWide.tree).elements;
  passed.push(check(glyphElements.filter((el) => el.type === 'svg').length === 1,
    '入口渲染恰好一个 svg 标记', String(glyphElements.filter((el) => el.type === 'svg').length)));
  const svg = glyphElements.find((el) => el.type === 'svg');
  passed.push(check(svg.props.width === 18 && svg.props.height === 18,
    '标记尺寸跟随宿主给的 size', JSON.stringify({ w: svg.props.width, h: svg.props.height })));
  passed.push(check(svg.props['aria-hidden'] === 'true',
    '标记对无障碍隐藏：这一行的语义由宿主那一行承担'));
  passed.push(check(glyphElements.every((el) => el.type !== 'button'),
    '不得自己画按钮：会与宿主那一行叠成两层可点区域'));
  passed.push(check(collect(glyphWide.tree).text.trim() === '',
    '不得自己画文字：标签由宿主渲染一次', JSON.stringify(collect(glyphWide.tree).text)));
  passed.push(check(!/onClick/.test(String(mountEntry(a, { size: 16, active: false }).tree && '')) ,
    '入口不处理点击（由宿主 selectPanel 负责）'));
  passed.push(check(svg.props.style.opacity === 0.72, '未选中时标记淡一些', String(svg.props.style.opacity)));
  const glyphActive = mountEntry(a, { size: 16, active: true });
  passed.push(check(collect(glyphActive.tree).elements.find((el) => el.type === 'svg').props.style.opacity === 1,
    '选中态标记不透明（颜色由 currentColor 跟随宿主样式）'));

  // ⑤ 槽位注册不许把 web 启动带崩：注册抛错时降级为「看板不出现」，apply 仍安全返回
  const throwingSlots = makeSlots();
  throwingSlots.slots.register = () => { throw new Error('槽位协议变了'); };
  const broken = boot({ services: Object.assign(session(), { slots: throwingSlots.slots }) });
  passed.push(check(throwingSlots.calls.inject.length === 2, '仍然尝试了两次注入', throwingSlots.calls.inject.join(',')));
  passed.push(check(typeof broken.disposer === 'function' || broken.disposer === undefined,
    '注册失败也不抛，apply 照常返回'));

  // ⑥ 时钟：30s 自动刷新 + 卸载清理
  passed.push(check(fresh.timers.intervals.length >= 1 && fresh.timers.intervals.some((t) => t.ms === REFRESH_MS),
    '注册了 ' + REFRESH_MS + 'ms 自动刷新', JSON.stringify(fresh.timers.intervals.map((t) => t.ms))));
  r0.unmount();
  r1.unmount();
  passed.push(check(fresh.timers.cleared.length >= 1, '卸载时 clearInterval 被调用', String(fresh.timers.cleared.length)));

  // ⑦ 六条降级路径（都带缓存，所以既能报「未连接」也能显示旧快照）
  const fallbacks = [
    { name: 'remote 服务缺失', services: session(), expect: '宿主命令服务不可用' },
    { name: 'ctx.get 抛错', services: Object.assign(session(), { throwOn: ['remote'] }), expect: '读取 remote 服务失败' },
    { name: '命令返回 kind:error', services: Object.assign(session(), {
      remote: makeRemote(() => ({ ok: true, value: { result: { kind: 'error', text: '策略引擎不健康' } } })).remote,
    }), expect: '策略引擎不健康' },
    { name: 'Promise reject', services: Object.assign(session(), {
      remote: makeRemote(() => Promise.reject(new Error('桥断了'))).remote,
    }), expect: '桥断了' },
    { name: '返回体不是 JSON', services: Object.assign(session(), {
      remote: makeRemote(() => ({ ok: true, value: { result: { kind: 'success', text: '<html>不是 JSON</html>' } } })).remote,
    }), expect: '命令返回的不是 JSON' },
    { name: '返回体结构无法识别', services: Object.assign(session(), {
      remote: makeRemote(() => ({ ok: true })).remote,
    }), expect: '命令返回体无法识别' },
  ];
  for (const scenario of fallbacks) {
    const booted = boot({ store, services: scenario.services });
    const renderer = mountDashboard(booted);
    const text = await textAfterLoad(renderer);
    passed.push(check(text.includes('未连接') && text.includes(scenario.expect),
      scenario.name + ' → 未连接（' + scenario.expect + '）'));
    passed.push(check(text.includes('mind-private'), scenario.name + ' → 仍显示最后一次已知快照'));
    passed.push(check(text.includes(ENTRY_LABEL), scenario.name + ' → 页面没有空白'));
    renderer.unmount();
  }

  // ⑧ 定位不到会话
  const noSession = boot({ store, services: {} });
  const rNo = mountDashboard(noSession);
  const noText = await textAfterLoad(rNo);
  passed.push(check(noText.includes('未连接') && noText.includes('定位不到会话 id'),
    '定位不到会话 → 优雅空态而非抛错'));
  passed.push(check(noText.includes('mind-private'), '无会话时用缓存快照兜底'));
  rNo.unmount();

  // ⑨ slots 服务不可用：apply 不抛
  const barePlugin = boot({ services: {} }).plugin;
  const result = barePlugin.apply(makeCtx({}));
  passed.push(check(result === undefined || result === null, 'slots 缺失时 apply 返回空且不抛'));

  return { passed, liveElements: c1.elements.length, liveTexts: c1.texts.length };
}

// ── 直接执行 ──────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  runHarness().then(
    (report) => {
      for (const name of report.passed) process.stdout.write('  [+] ' + name + '\n');
      process.stdout.write('\nclient-harness: ' + report.passed.length + ' 条断言全部通过'
        + '（活数据树 ' + report.liveElements + ' 元素 / ' + report.liveTexts + ' 文本节点）\n');
      process.exit(0);
    },
    (error) => {
      process.stderr.write('\nclient-harness 失败：' + (error && error.message) + '\n');
      if (error && error.stack && !(error instanceof HarnessFailure)) process.stderr.write(error.stack + '\n');
      process.exit(1);
    },
  );
}
