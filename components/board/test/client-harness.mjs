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
//   3. 三处席位注册：`main`（带 key `dsh-mind`）与 `sidebar.panellist`（图标排在插件入口下面）
//      （带 id 与 label 函数），以及 `settings.section`（「心智设置」分区）。
//      **看板面板 ≠ 设置页**：面板搬出设置页那条历史决定，说的是「面板不是一个设置项」，
//      不是「本组件永不注册设置页」。设置页是失联限制 / 响应期限小时**唯一**的写入口，
//      而面板（§9 工作台只读）里一个写控件都没有 —— 两件事各有各的断言。
//      apply 的返回值能把三处一起撤下（合并 disposer）；
//   4. 首帧就渲染出一棵非平凡的树（一条数据都没有时也一样）：标题、四个分区全在，
//      空态文案是「没有需要你决定的事」这类明说的话，不是空白；
//   5. 装了 remote：调 `/mind dashboard`、解析 JSON、把活数据画上去，并把快照落缓存；
//      状态条（闸 / 介入度 / 失联四态 / 探针见红）、待你决定的命令、会审的揭名与零分歧都在；
//   6. remote 缺失 / ctx.get 抛错 / 返回 error / Promise reject / 返回非 JSON /
//      返回体结构不明 —— 六条降级路径都**不许抛**，且都渲染出「未连接」+ 旧快照；
//   7. 定位不到会话 id —— 优雅空态，不是抛错、不是空白；
//   8. 侧边栏入口：只画 svg 标记，点击与文案都归宿主那一行；
//   9. 时钟：注册 30s 自动刷新，卸载时 clearInterval。
//  10. 状态条告警：闸不在位 / 已失联 / 已关闭 / 探针见红 —— 读数块进告警样式，不只是换个点色。
//  11. 会审：未交齐（揭名 false）只出盲标 + 锁行，成员 id 一个都不许出；交齐后两者都给。
//  12. 零分歧 true 渲染成**异常**，复核三态三档三个类名。
//  13. 失联四态：`在位` 绿 / `已失联` 红 / `已关闭` **不是绿**（本批修的真缺陷）/ `未知` 灰；
//      旧宿主只给布尔 ⇒ 降级成 `已失联` / `在位`。
//  14. 设置页：读（remote 收到 `mind presence`、页面显示生效值与来源）、
//      写（收到带参数的命令 **且随后有一次回读**）、回读不一致 ⇒ 明说「没写进去」、
//      remote 缺失 / 命令报错 / 非 JSON ⇒ 「未接入 + 原因」且不抛。
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
/** 轮询间隔：与 lib/client.js 里的 `POLL_MS` 一致（Batch 7：取数改由 `apply` 里的裸 setInterval 轮询）。 */
export const REFRESH_MS = 3000;

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
  if (node === null || node === undefined) return '';
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
  // ⚠️ 传输层已换成同源 `fetch`（见 `makeFetchFromCommands`）。这里**只改接线、不改夹具语义**：
  //    同一个 handler（收到的还是"命令串"）被接到 fetch 上；`calls` 仍然形如
  //    `{sessionId, command, attachments}`，老断言一个字不用改。
  const 桥 = makeFetchFromCommands(function (命令, 记录) {
    calls.push({ sessionId: '', command: 命令, attachments: [], 请求: 记录 });
    return handler('', 命令, []);
  });
  return {
    calls,
    fetch: 桥.fetch,
    remote: {
      commands: {
        // 这个通道**已经不用了**：真机上它永不返回。留着只为兼容调用点签名 ——
        // 万一有人（或某段代码）又去调它，立刻**响亮地失败**，而不是无声卡住。
        execute(sessionId, command, attachments) {
          calls.push({ sessionId, command, attachments, 走了旧通道: true });
          return Promise.reject(new Error('旧通道 remote.commands.execute 已停用（Batch 7 换成同源 fetch）'));
        },
      },
      __fetch: 桥.fetch,
    },
  };
}

/**
 * 一个**最小**的假 `fetch`：记下每次请求，按 handler 给回应。
 *
 * 为什么要它：传输层已从 `remote.commands.execute` 换成**同源 `fetch`**
 * （真机上命令通道永不返回，而另一个第三方插件的 fetch 路由是活的）。
 * 断言要验「发了哪个方法 / 哪个路由 / 带没带 `cache` / body 对不对」——
 * 只有假的 fetch 能回答这些。**不 mock 一整套 HTTP**：
 * 只要 `{ok, status, text()}` 三样，够 `runCommand` 的全部判据走通。
 *
 * @param {(url: string, options: object) => any} handler 返回假 Response
 * @returns {{ calls: object[], fetch: Function }}
 */
export function makeFetch(handler) {
  const calls = [];
  const fetch = function (url, options) {
    const 选项 = options || {};
    const 记录 = {
      url: String(url),
      method: String(选项.method || 'GET').toUpperCase(),
      cache: 选项.cache,
      headers: 选项.headers,
      body: 选项.body,
    };
    calls.push(记录);
    return handler(String(url), 选项, 记录);
  };
  return { calls, fetch };
}

/** 假 Response：`text()` 给一段 JSON 文本（`payload` 是字符串时原样给，用来造非 JSON）。 */
export function jsonResponse(payload, status) {
  const 状态 = status === undefined ? 200 : status;
  return {
    ok: 状态 >= 200 && 状态 < 300,
    status: 状态,
    text() { return Promise.resolve(typeof payload === 'string' ? payload : JSON.stringify(payload)); },
  };
}

/**
 * **把"命令面夹具"接到新传输上**——让既有夹具一个字不改就能继续测同一件事。
 *
 * 传输层从 `remote.commands.execute(sessionId, 命令, [])` 换成同源 `fetch`，
 * 但**路由与命令、响应 JSON 是逐字同形的**（宿主侧按此契约注册）。所以：
 * 把旧夹具那套「给命令 → 给回应」原样接在 fetch 上即可 —— 断言测的还是同样的行为，
 * 只是现在能从**请求侧**（方法 / 路由 / cache / body）多验一层。
 *
 * 请求 → 命令的对应（写死在这里，与 `lib/client.js` 的常量一致）：
 *  · `GET  /plugins/dsh-mind/presence`  → `/mind presence`
 *  · `POST /plugins/dsh-mind/presence`  → `/mind presence 开关=… 小时=…`（参数从 body 还原）
 *  · `GET  /plugins/dsh-mind/workbench` → `/mind dashboard`
 *
 * 兼容两种 handler 返回值：
 *  · 命令面形状 `{ok:true, value:{result:{kind,text}}}`（老的 `okReply(...)`）；
 *  · 直接给 JSON 对象/字符串（更贴近"路由直接回 JSON"）。
 *
 * @param {(command: string, 请求: object) => any} handler
 */
export function makeFetchFromCommands(handler) {
  return makeFetch(function (url, options, 记录) {
    const 路径 = 记录.url.split('?')[0];
    let 命令 = null;
    if (路径 === '/plugins/dsh-mind/presence') {
      if (记录.method === 'POST') {
        let body = {};
        try { body = 记录.body ? JSON.parse(记录.body) : {}; } catch (error) { body = {}; }
        const 段 = [];
        if (body && body.开关 !== undefined && body.开关 !== null) 段.push('开关=' + body.开关);
        if (body && body.小时 !== undefined && body.小时 !== null) 段.push('小时=' + body.小时);
        命令 = '/mind presence' + (段.length ? ' ' + 段.join(' ') : '');
      } else {
        命令 = '/mind presence';
      }
    } else if (路径 === '/plugins/dsh-mind/workbench') {
      命令 = '/mind dashboard';
    } else {
      命令 = 路径;
    }
    const 原始 = handler(命令, 记录);
    return Promise.resolve(原始).then(function (回应) {
      const 盒子 = 回应 && 回应.value && 回应.value.result;
      if (盒子 && typeof 盒子.text === 'string') {
        const 行不行 = 盒子.kind === 'success';
        return jsonResponse(盒子.text, 行不行 ? 200 : 500);
      }
      if (typeof 回应 === 'string') return jsonResponse(回应);
      if (回应 && typeof 回应 === 'object' && typeof 回应.text === 'function') return 回应; // 已是假 Response
      return jsonResponse(回应 === undefined ? {} : 回应);
    });
  });
}

/** 老夹具里的 `makeRemote(...).remote` 形状 → 新传输的 fetch。**只改接线，不改夹具语义**。 */
export function remoteShim(fetch) {
  // `ctx.get('remote')` 已不被 `runCommand` 使用；留着只为兼容既有调用点签名。
  return { commands: { execute() { return new Promise(() => {}); } }, __fetch: fetch };
}

export function okReply(view) {
  return { ok: true, value: { result: { kind: 'success', text: JSON.stringify(view) } } };
}

// ── 装载经典脚本 ──────────────────────────────────────────────────────────────
/**
 * 一个**最小**的假 `document`：只够验「样式有没有注到文档级」这一件事。
 *
 * 为什么必须有它：设置页的样式**必须**走 `document.head`（它不住在看板面板的子树里，
 * 挂在面板里的 CSS 对设置页不可达 —— Batch 6 的真缺陷就是栽在这里）。
 * 而"挂在哪"这件事只有 `document` 知道，渲染树里看不出来 ⇒ 不给假 document，这条性质就没人守。
 *
 * 刻意**不 mock 一整套 DOM**：只要 `head.appendChild` 记下收到的节点、`createElement('style')`
 * 能造出一个带 `textContent`/`setAttribute`/`parentNode` 的小对象即可（`head.appendChild` 会
 * 顺手把 `parentNode` 接上，好让「卸载时移除」也测得出来）。
 *
 * @param {{ nodes: object[] }} doc 记录器：`nodes` 就是"head 里现在的样式标记"（会被就地增删）
 */
export function makeDocument(doc = {}) {
  const 记录 = doc.nodes ? doc : { nodes: [] };
  const head = {
    appendChild(node) {
      node.parentNode = {
        removeChild(target) {
          const at = 记录.nodes.indexOf(target);
          if (at >= 0) 记录.nodes.splice(at, 1);
        },
      };
      记录.nodes.push(node);
      return node;
    },
  };
  const document = {
    head,
    createElement(tag) {
      return { tagName: String(tag).toUpperCase(), attrs: {}, textContent: '', parentNode: null,
        setAttribute(k, v) { this.attrs[k] = String(v); } };
    },
  };
  // 把记录挂回 document 上，方便调用方拿到（`booted.doc` 用它）。
  document.__nodes = 记录.nodes;
  return { doc: 记录, document };
}

/**
 * 在一个干净的 vm 上下文里执行 lib/client.js，捕获 loader 定义。
 * @param {{ store?: Map<string,string>, sessionId?: string, document?: object }} [options]
 *   `store` 可跨次复用以模拟同一个浏览器（缓存跨插件加载存活）；
 *   `document` 不传则上下文里**没有** document（顺手守住"无 document 也不许抛"）。
 */
export function loadClient(options = {}) {
  const store = options.store || new Map();
  const timers = { intervals: [], cleared: [], timeouts: [], clearedTimeouts: [] };
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
    // ⚠️ `setTimeout` 必须在：设置页的读/写链靠**上限等待**离开 loading
    //    （`execute` 返回永不 settle 的 promise 时，只有超时能救）。
    //    这里不真的等 8 秒：把回调记下来，由测试用 `timers.fireTimeouts()` 推进。
    setTimeout(fn, ms) { timers.timeouts.push({ fn, ms }); return timers.timeouts.length; },
    clearTimeout(id) { timers.clearedTimeouts.push(id); },
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
  if (options.document) sandbox.document = options.document;
  // 假 `fetch` 装成**全局**（组件取的是裸 `fetch` / `globalThis.fetch`）——
  // 不传就真的没有 fetch，用来守「拿不到 fetch 要响亮降级」那条。
  if (options.fetch) sandbox.fetch = options.fetch;
  // 不给计时器：`noTimers: true` 时沙箱里**没有** setTimeout/setInterval
  // （守住"拿不到计时器要响亮，不许静默不设超时 / 不轮询"那条纪律）。
  if (options.noTimers) {
    delete win.setTimeout;
    delete win.clearTimeout;
    delete win.setInterval;
    delete win.clearInterval;
  }
  vm.createContext(sandbox);
  new vm.Script(readFileSync(CLIENT_PATH, 'utf8'), { filename: CLIENT_PATH }).runInContext(sandbox);

  /**
   * 推进「假时钟」：把已注册的 setTimeout 回调全部触发一次（模拟"8 秒到了"）。
   * 只对**还没被 clearTimeout 撤掉**的那些触发（撤了就不该再响）。
   */
  timers.fireTimeouts = function fireTimeouts() {
    const 撤掉的 = new Set(timers.clearedTimeouts);
    const 待发 = timers.timeouts.filter((t, i) => !撤掉的.has(i + 1));
    timers.timeouts.length = 0;
    timers.clearedTimeouts.length = 0;
    待发.forEach((t) => { try { t.fn(); } catch (error) { /* 回调抛错交给调用方观察 */ } });
    return 待发.length;
  };

  return { win, store, timers, warnings, document: options.document || null,
    get loaderCalls() { return loaderCalls; }, get definition() { return definition; } };
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
 * 故意包含：闸在位 / 失联`在位` / 探针见红；两种揭名状态的会审；零分歧 true 的一场；
 * 三种审计档位各一条。这样每条界面断言都有真数据可打。
 *
 * ⚠️ `状态条.失联` 是**四态字符串**（Batch 2 的契约）：`在位` / `已失联` / `已关闭` / `未知`。
 * 夹具跟着契约走，而不是跟着旧实现的布尔走 —— 布尔装不下「已关闭」，那正是本批要修的缺陷。
 */
export function sampleView() {
  return {
    项目: 'mind-private',
    生成于: '2026-10-07T17:20:37+08:00',
    边界: { 只读: true, 说明: '工作台是投影：它不存储、不做讨论、不做权威记录。' },
    状态条: {
      闸: { 在位: true, 规则数: 5, 错误: null },
      介入度: '事后抽检',
      失联: '在位',
      失联详情: {
        读数: '在位', 已关闭: false, lost: false, hours: 0.5, since: '2026-10-07T16:50:00+08:00',
        deadline: '2026-10-10T17:20:00+08:00', 生效响应期限小时: 72, 响应期限小时来源: '出厂',
        失联限制来源: '出厂', 值不合法: false,
      },
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
        // ⑮ 强制反对者（2026-10-10）：**投影在行级给这一个键**（有讨论段才给）。
        // 这一场是「有值」的那一面；t-4 / t-5 没有讨论段 ⇒ 投影不给键 ⇒ 归一化兜底成空串 ⇒ 一个字都不画。
        // ⚠️ 夹具喂的是**真键** `强制反对者` —— 这才是 `src/workbench.js` 真发的形状
        //    （收尾⑥·2026-10-10：以前这里喂的是**别名** `dissenter`，于是「真键能渲染」这件事
        //     只由一条源码文本正则兜着；别名那一路现在**单列一条断言**钉，不许它冒充真键）。
        讨论: {
          状态: '讨论中', 轮次: '1/2', 本轮消息数: '1/24',
          可收敛: false, 可收敛说明: '不可收敛：本轮还有 1 条新分歧未答复；未表态：member-e。',
          讨论未收敛: true,
        },
        强制反对者: 'member-c',
      },
    ],
    审计尾: [
      { seq: 1, 时间: '2026-10-07T17:01:02+08:00', 动作: '策略拒绝', 主体: 'role-β', 结果: '拒绝', 档位: '全记', 告警: false },
      { seq: 2, 时间: '2026-10-07T17:02:03+08:00', 动作: '工具调用成功', 主体: 'role-α', 结果: '成功', 档位: '记汇总', 告警: false },
      { seq: 3, 时间: '2026-10-07T17:03:04+08:00', 动作: '只读调用', 主体: 'role-α', 结果: '记', 档位: '不逐次记', 告警: false },
      { seq: 4, 时间: '2026-10-07T17:04:05+08:00', 动作: '零分歧异常', 主体: { id: 'lead', kind: 'Lead' }, 结果: '触发人工抽检', 档位: '全记', 告警: true },
    ],
    // 验账读数：人扫一眼页脚就知道记账在正常发生（真源是 MemoryService.activity）。
    记忆: { 存量: 12, 近段: { 窗口天: 7, 新增: 3, 晋升: 1 } },
  };
}

/** 同一份投影，但闸不在位 + 已失联 + 探针见红两条：验状态条的告警外观。 */
export function alarmingView() {
  const view = sampleView();
  view.状态条 = {
    闸: { 在位: false, 规则数: 0, 错误: '策略引擎未加载' },
    介入度: '逐条审批',
    失联: '已失联',
    失联详情: {
      读数: '已失联', 已关闭: false, lost: true, hours: 100, since: '2026-10-03T10:00:00+08:00',
      deadline: '2026-10-06T10:00:00+08:00', 生效响应期限小时: 72, 响应期限小时来源: '出厂',
      失联限制来源: '出厂', 值不合法: false,
    },
    探针: { 状态: '异常', 见红: ['审计链', '闸在位'], 恒红: true, 恒绿: false },
  };
  return view;
}

/**
 * 失联开关被**关掉**（`presence().已关闭 === true`）——本批要修的那个真缺陷。
 *
 * Batch 2 之前页面读的是 `boolOf('已关闭')`：`boolOf` 只认布尔 / `'true'` / `'是'` 那几个，
 * 于是拿到 **null** ⇒ 画成灰点「未知」。看上去像「没读到」，而真相是「这个机制被停掉了」。
 *
 * 这份夹具同时还带了 `值不合法: true`（私有层写了 `0`）：关掉开关与坏值可以同时发生，
 * 页面两件都得说 —— 坏值不许被「已关闭」这个更响的结论盖掉。
 */
export function closedView() {
  const view = sampleView();
  view.状态条 = Object.assign({}, view.状态条, {
    失联: '已关闭',
    失联详情: {
      读数: '已关闭', 已关闭: true, lost: false, hours: 0, since: null, deadline: null,
      生效响应期限小时: 168, 响应期限小时来源: '内置兜底', 失联限制来源: '私有', 值不合法: true,
      原值: 0, 原值来源: '私有', 不合法说明: '响应期限小时 的原值 0 不合法（不是 ≥1 的整数），已退回内置兜底 168。',
    },
  });
  return view;
}

/** 宿主没给失联读数（既没有 `失联`，也没有 `失联详情`）—— 未知 ≠ 正常。 */
export function unknownPresenceView() {
  const view = sampleView();
  const 状态条 = Object.assign({}, view.状态条);
  delete 状态条.失联;
  delete 状态条.失联详情;
  view.状态条 = 状态条;
  return view;
}

/**
 * 旧宿主：`状态条.失联` 只给**布尔**（Batch 2 之前的契约），也没有 `失联详情`。
 * 新版页面必须降级读得出来：`true → 已失联`、`false → 在位`，而不是变成「未知」。
 */
export function legacyBoolView(值) {
  const view = sampleView();
  const 状态条 = Object.assign({}, view.状态条, { 失联: 值 === true });
  delete 状态条.失联详情;
  view.状态条 = 状态条;
  return view;
}

/** 清空「待你决定」：验空态是明说的那句话，而不是空白。 */
export function noDecisionView() {
  const view = sampleView();
  view.待你决定 = [];
  return view;
}

/**
 * **半数缺数据**的状态条视图（Batch 9 用）：项目键 / 生成时刻 / 介`入度 / 探针 都缺，
 * 只留闸与失联。用来验"没数据的地方不留空壳、不画光秃秃的 `—`"。
 */
export function 半数缺数据的视图() {
  const view = sampleView();
  delete view.项目;
  view.生成于 = null;
  const 状态条 = Object.assign({}, view.状态条);
  delete 状态条.介入度;
  delete 状态条.探针;
  view.状态条 = 状态条;
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
/** 设置页分区：与 lib/client.js 里的常量一致（`settings.section` 的注册契约）。 */
export const SETTINGS_SECTION_ID = 'dsh-mind-settings';
export const SETTINGS_SECTION_LABEL = '心智';
/** 设置页命令：与 lib/client.js 里的常量一致。 */
export const PRESENCE_COMMAND = '/mind presence';
/** 未接入时给用户复制的那条完整命令（也来自 lib/client.js 的常量）。 */
export const PRESENCE_EXAMPLE = '/mind presence 开关=是 小时=168';

// ── 断言 ──────────────────────────────────────────────────────────────────────
class HarnessFailure extends Error {}

function check(passed, name, detail) {
  if (!passed) throw new HarnessFailure(name + (detail ? '　→ ' + detail : ''));
  return name;
}

/** 装载 + apply，返回渲染器所需的全部把手。 */
function boot(options = {}) {
  // ⚠️ 假 `document` 走**服务**传进来（`services.document`）——所有调用方都是
  // `boot({ services: Object.assign(session(), …) })` 这个形状，而 `session()` 里带 document。
  // 第一版这里读的是 `options.document`（顶层）⇒ 组件拿不到假 document、head 里永远是空的，
  // 「注入到 document.head」那条断言就永远绿不了（**接线错了，不是实现错了**）。
  // 顶层 `options.document` 仍保留：给"就想单独指定一个 document"的用例用。
  const doc = options.document || (options.services && options.services.document) || null;
  // 假 `fetch`：优先 `services.fetch`；老夹具的 `services.remote.__fetch`（`makeRemote` 的桥）也认。
  // 两者都没有 ⇒ 沙箱里**真的没有 fetch**，用来守「拿不到 fetch 要响亮降级」那条。
  const fetchImpl = options.fetch
    || (options.services && options.services.fetch)
    || (options.services && options.services.remote && options.services.remote.__fetch)
    || null;
  const loaded = loadClient({ store: options.store, sessionId: options.sessionId, document: doc,
    fetch: fetchImpl, noTimers: options.noTimers });
  check(loaded.loaderCalls === 1, 'loader 被调用一次', '实际 ' + loaded.loaderCalls + ' 次');
  const def = loaded.definition;
  check(!!def && def.id === PACKAGE_NAME, '工厂 id 是包名 ' + PACKAGE_NAME, String(def && def.id));
  check(typeof def.factory === 'function', 'factory 是函数');

  const strict = makeStrictRequire();
  const 用的require = options.requireOverride ? options.requireOverride(strict.require) : strict.require;
  const plugin = def.factory(用的require);
  check(!!plugin && plugin.name === PACKAGE_NAME, '插件体 name 是 ' + PACKAGE_NAME, String(plugin && plugin.name));
  check(Array.isArray(plugin.inject) && plugin.inject.indexOf('slots') >= 0,
    '插件体 inject 含 slots', JSON.stringify(plugin.inject));
  check(typeof plugin.apply === 'function', '插件体 apply 是函数');

  const { slots, calls } = makeSlots();
  const ctx = makeCtx(Object.assign({ slots }, options.services));
  const disposer = plugin.apply(ctx);
  return { loaded, strict, plugin, slots, calls, ctx, disposer, timers: loaded.timers, warnings: loaded.warnings,
    // 这次 boot 的假 document 记录（`nodes` = head 里现在挂着的样式标记）。
    doc: doc && doc.__nodes ? doc.__nodes : null };
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

/** 渲染设置页那一格（`settings.section`「心智设置」）。主人只传 `{close}`。 */
function mountSettings(booted, props) {
  return createRenderer(registrationOf(booted, 'settings.section').Component, props || { close() {} });
}

/**
 * 一次 boot 用的服务：会话 + 一个**属于这次 boot 的假 document**。
 *
 * 为什么要配 document：设置页样式必须注到 `document.head`（不可达的话真机上就是"类名在、样式没上去"）。
 * 每次 boot 一个新 document ⇒ 各用例之间不会因为"样式已有人管"而互相干扰。
 */
function session() {
  return { sessions: makeSessions([{ id: 'sess-main', main: true }]), document: makeDocument().document };
}

/** 取这次 boot 的假 document 记录（`head` 里现在有哪些样式标记）。 */
function docNodes(booted) {
  return (booted.ctx.get('document') && booted.ctx.get('document').__nodes) || [];
}

/** 一次 boot 用的服务，但**故意不给** document（守住"非浏览器环境不许抛"）。 */
function sessionWithNoDocument() {
  return { sessions: makeSessions([{ id: 'sess-main', main: true }]) };
}

async function textAfterLoad(renderer) {
  renderer.flush();
  await settle();
  renderer.flush();
  return collect(renderer.tree, { skipStyle: true }).text;
}

/**
 * 把**一份给定的投影**真的渲染一遍，返回页面文本（给行为判据用：收尾⑥·2026-10-10）。
 *
 * 起 DOM / 起渲染器的路子与 `runHarness` 逐字同款（不另造一套夹具）：
 * 同一次 `boot`（`session()` 带假 document）、同一个 remote→fetch 桥（handler 回 `okReply(view)`）、
 * 同一个 `flush → settle → flush` 收敛节奏，最后取整页文本。
 *
 * 为什么要导出它：判据必须落在**行为**上（喂进去 → 画出来），而不是「源码里有这行字」。
 * `client.test.js` 用它把「真键能渲染 / 空串一个字都不画」两条钉成渲染读数。
 *
 * @param {object} view 一份投影（形状同 `sampleView()`）
 * @param {{ store?: Map<string,string> }} [options] `store` 可跨次复用（同一浏览器）
 * @returns {Promise<{ text: string, elements: object[], texts: string[], tree: object, calls: object[] }>}
 */
export async function renderView(view, options = {}) {
  const spy = makeRemote(() => okReply(view));
  const booted = boot({ store: options.store, services: Object.assign(session(), { remote: spy.remote }) });
  const renderer = mountDashboard(booted);
  renderer.flush();
  await settle();
  renderer.flush();
  const c = collect(renderer.tree, { skipStyle: true });
  renderer.unmount();
  return { text: c.text, elements: c.elements, texts: c.texts, tree: renderer.tree, calls: spy.calls };
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
  passed.push(check(injected.length === 3
    && injected[0] === 'main' && injected[1] === 'settings.section' && injected[2] === 'sidebar.panellist',
    'inject 的槽位恰好是 main + sidebar.panellist + settings.section', a.calls.inject.join(',')));
  // ⚠️ 这一条**改过**，理由必须留在注释里（不是把历史的红偷偷删掉）：
  //
  // 旧断言是「不再注册 settings.section」，理由是「看板已搬出设置页」。那条决定说的是
  // **看板面板** —— 它是常驻运维视图，不是一项设置，所以不该占着设置页里的一格。
  //
  // 本批新增的 `settings.section` 是**另一件东西**：官方设置页里的「心智设置」分区，
  // 里面只有「失联限制」开关 + 「响应期限小时」数字 + 保存。失联限制与响应期限小时
  // 是要主权者改的**设置**，而 §9「工作台只读」不许面板里出现写控件 —— 两者必须分家。
  // 于是：面板照旧搬出设置页（断言在 ③h：面板里一个写控件都没有），
  // 设置页这一格注册的是「心智设置」而不是看板面板本身。
  passed.push(check(a.calls.inject.indexOf('settings.section') >= 0,
    '注册 settings.section：看板面板 ≠ 设置页，「心智设置」分区是失联限制唯一的写入口'));
  passed.push(check(a.calls.inject.indexOf('sidebar.footer.action') < 0,
    '不再占用侧边栏页脚席位（入口移到插件入口下面）'));
  passed.push(check(a.calls.register.length === 3, '恰好三处 register', String(a.calls.register.length)));

  const mainOptions = registrationOf(a, 'main').options;
  passed.push(check(mainOptions.key === PANEL_KEY, 'main 席位带 key ' + PANEL_KEY, JSON.stringify(mainOptions)));
  passed.push(check(typeof a.disposer === 'function', 'apply 返回合并后的 disposer'));
  a.disposer();
  passed.push(check(a.calls.disposed === 3, '撤下时三处注册都被释放', String(a.calls.disposed)));

  const entryOptions = registrationOf(a, 'sidebar.panellist').options;
  passed.push(check(entryOptions.id === PANEL_KEY, '入口的 id 是 ' + PANEL_KEY, JSON.stringify(entryOptions)));
  passed.push(check(typeof entryOptions.order === 'number' && entryOptions.order > 0,
    '入口 order > 0：插件入口是 0，所以本组件排在它下面', String(entryOptions.order)));
  passed.push(check(typeof entryOptions.label === 'function' && String(entryOptions.label()).length > 0,
    '入口带 label 函数（窄轨工具提示与无障碍名由侧边栏取用）', String(entryOptions.label && entryOptions.label())));

  // ①a 设置页分区：注册形状 (`{name, id, order, label()}`) 一项都不能少
  // （`settings.section` 是 list 协议，官方客户端按这些字段渲染分区标题与排序）。
  const sectionOptions = registrationOf(a, 'settings.section').options;
  passed.push(check(sectionOptions.name === 'settings.section',
    '设置页注册的 name 是 settings.section', String(sectionOptions.name)));
  passed.push(check(sectionOptions.id === SETTINGS_SECTION_ID,
    '设置页分区 id 是 ' + SETTINGS_SECTION_ID, String(sectionOptions.id)));
  passed.push(check(typeof sectionOptions.order === 'number' && isFinite(sectionOptions.order),
    '设置页分区带数字 order', String(sectionOptions.order)));
  passed.push(check(typeof sectionOptions.label === 'function' && sectionOptions.label() === SETTINGS_SECTION_LABEL,
    '设置页 label() 返回分区标题「' + SETTINGS_SECTION_LABEL + '」', String(sectionOptions.label && sectionOptions.label())));
  passed.push(check(registrationOf(a, 'settings.section').Component !== registrationOf(a, 'main').Component,
    '设置页组件**不是**看板面板本体（看板是只读视图，设置页才有写控件）'));

  // ①b 清理器：宿主卸载时三处席位一起撤下。可见性由 roster 管（看板行被关时本模块
  //    不注入浏览器）——曾经的 components 探针打的是宿主从未注册的路由，已连同这里
  //    的 mock 一起删掉，不留第二个口径。
  const off = boot({ services: session() });
  await settle();
  passed.push(check(off.calls.disposed === 0, '注册后不自行撤下（没有名册探针了）', String(off.calls.disposed)));
  off.disposer();
  passed.push(check(off.calls.disposed === 3, '清理器一次撤下三处席位', String(off.calls.disposed)));

  const noAnswer = boot({ services: session() });
  await settle();
  passed.push(check(noAnswer.calls.disposed === 0, '取不到数时默认显示（界面可见性不是安全边界）', String(noAnswer.calls.disposed)));
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
  passed.push(check(c0b.text.includes('未连接') && c0b.text.includes('拿不到 fetch'),
    '拿不到 fetch 时给出「未连接」与原因，而不是空白或抛错'));
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
  // 取工作台投影的那次请求：**至少一次**（`apply` 的轮询立刻拉一次；组件挂载的 effect 增强
  // 若可用会再拉一次 ⇒ 一次以上是正常的，**少于一次**才是缺陷）。
  // 断言打在"请求长相"上：方法 / 路由 / cache —— 这是换传输后新有的可验面。
  const dashboardCalls = spy.calls.filter((call) => call.command === COMMAND);
  passed.push(check(dashboardCalls.length >= 1, '取投影至少请求一次', String(dashboardCalls.length)));
  passed.push(check(dashboardCalls[0].command === COMMAND, '走的是工作台路由（' + COMMAND + '）', dashboardCalls[0].command));
  passed.push(check(dashboardCalls[0].请求.method === 'GET' && dashboardCalls[0].请求.url === '/plugins/dsh-mind/workbench',
    '看板取数是 GET /plugins/dsh-mind/workbench', JSON.stringify({ m: dashboardCalls[0].请求.method, u: dashboardCalls[0].请求.url })));
  passed.push(check(dashboardCalls[0].请求.cache === 'no-store', '看板取数带 cache:no-store', String(dashboardCalls[0].请求.cache)));
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

  // ③a 状态条：闸 / 探针 / 见红 / 恒绿 / 失联四态（夹具这一份是 `在位`）
  passed.push(check(c1.text.includes('闸在位') && c1.text.includes('规则 5'), '状态条给「闸在位 + 规则数」'));
  passed.push(check(c1.text.includes('见红：审计链'), '状态条列出见红的探针名'));
  passed.push(check(c1.text.includes('恒绿警报'), '恒绿也要报警（恒绿与恒红一样是坏信号）'));
  passed.push(check(c1.text.includes('在位') && !c1.text.includes('已失联') && !c1.text.includes('已关闭'),
    '失联=在位 时只画「在位」，不画失联告警、也不画「已关闭」'));
  // 详情是**次要行**：生效期限 + 来源要看得见，但不许抢主读数的位置。
  passed.push(check(c1.text.includes('生效期限 72h（出厂）'), '失联详情给出生效期限与来源'));
  passed.push(check(c1.text.includes('开关来源 出厂'), '失联详情给出「失联限制」生效值的来源'));
  passed.push(check(c1.text.includes('读数：在位'), '失联详情给出读数本身'));

  // ③a′ 优化批④（2026-10-10）：读数分「身份／健康」两组；失联详情仍贴格（Batch 8 定案不翻烧饼）。
  const 组标签 = c1.elements.filter((el) => String(el.props.className || '').split(/\s+/).indexOf('dshmind-readoutGroupLabel') >= 0)
    .map((el) => textOf(el));
  passed.push(check(组标签.join('|') === '身份|健康', '④ 读数行分「身份｜健康」两组（顺序也钉住）', 组标签.join('|')));
  const 读数组 = findAllByClass(r1.tree, 'dshmind-readoutGroup');
  const 身份组文本 = 读数组.length > 0 ? textOf(读数组[0]) : '';
  const 健康组文本 = 读数组.length > 1 ? textOf(读数组[1]) : '';
  passed.push(check(身份组文本.includes('项目键') && 身份组文本.includes('生成时刻') && !身份组文本.includes('策略引擎闸'),
    '④ 身份组＝项目键+生成时刻（健康类不混进来）', 身份组文本.slice(0, 60)));
  passed.push(check(健康组文本.includes('策略引擎闸') && 健康组文本.includes('失联状态'),
    '④ 健康组＝闸/介入度/失联（/探针）', 健康组文本.slice(0, 60)));
  const 失联读数格 = findAllByClass(r1.tree, 'dshmind-readout').find((el) => textOf(el).includes('失联状态'));
  // readoutNote 在实现里是「div 包 span」两层同名类，数个数会得 2；判据要的是**包含**：
  // 详情节点在失联那一格的子树里（在整棵树里查到不算数——那可能是拉到整行的脚注）。
  passed.push(check(!!失联读数格 && findAllByClass(失联读数格, 'dshmind-readoutNote').length >= 1,
    '④ 失联详情仍贴在失联那一格里（readoutNote 不外溢到整行）'));

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

  // ③c 待你决定之前先看页脚的验账读数：记忆存量 + 近段新增/晋升
  passed.push(check(c1.text.includes('记忆 存量 12 · 近7天 +3（晋升 1）'),
    '页脚给记忆验账读数（存量 + 近7天新增 + 晋升）'));

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
  // ⚠️ 优化批③（2026-10-10）改过这一段的读法（理由留在断言里，不是把历史的红偷偷删掉）：
  // 独立答案现在默认「首场展开、其余折叠」——第二场的盲标/成员 id 要**点开**才在。
  // 揭名口径没变：折叠摘要只给盲标；点开后盲标与成员 id 都给（下面点开后再验）。
  passed.push(check(findAllByClass(cards[0], 'dshmind-answers').length === 1,
    '③ 首场会审默认展开独立答案（dshmind-answers 在）'));
  passed.push(check(textOf(cards[0]).includes('字段够用') && textOf(cards[0]).includes('缺审计档位'),
    '③ 展开的那场给每份结论文本'));
  passed.push(check(findAllByClass(cards[1], 'dshmind-answers').length === 0
    && textOf(cards[1]).includes('独立答案 3 份'),
    '③ 第二场默认折叠：一行摘要，不铺独立答案'));
  passed.push(check(textOf(cards[1]).includes('成员 A') && !textOf(cards[1]).includes('member-a'),
    '③ 折叠摘要只给盲标不出成员 id（揭名口径不因折叠放宽）', textOf(cards[1]).slice(0, 80)));
  const 二场切换钮 = collect(r1.tree, { skipStyle: true }).elements
    .find((el) => el.type === 'button' && String(el.props.className || '').indexOf('dshmind-toggle') >= 0
      && textOf(el).includes('独立答案 3 份'));
  passed.push(check(!!二场切换钮, '③ 折叠场有切换钮（button，不是别的可点元素）'));
  // 走真实 onClick（不是直接调内部函数）：点开 ⇒ 展开；每一步后重新取元素（旧快照握着旧闭包）。
  const 请求前 = spy.calls.length;
  二场切换钮.props.onClick();
  await settle();
  r1.flush();
  const cards点开 = findAllByClass(r1.tree, 'dshmind-review');
  const shown = textOf(cards点开[1]);
  passed.push(check(shown.includes('成员 A') && shown.includes('member-a') && shown.includes('member-c'),
    '揭名 true 时盲标与成员 id 都给（点开折叠后）'));
  passed.push(check(!shown.includes(LOCK_LINE), '交齐的会审没有锁行'));
  passed.push(check(shown.includes('3/3 齐'), '交齐的会审显示 `3/3 齐`'));
  // 再点一下收回去：覆盖表取反，摘要回来、全文消失；首场不受影响（按节点 id 记，不按位置记）。
  const 二场切换钮2 = collect(r1.tree, { skipStyle: true }).elements
    .find((el) => el.type === 'button' && String(el.props.className || '').indexOf('dshmind-toggle') >= 0
      && textOf(el).includes('独立答案 3 份'));
  二场切换钮2.props.onClick();
  await settle();
  r1.flush();
  const cards收起 = findAllByClass(r1.tree, 'dshmind-review');
  passed.push(check(findAllByClass(cards收起[1], 'dshmind-answers').length === 0
    && textOf(cards收起[1]).includes('独立答案 3 份'),
    '③ 再点一下收回去（覆盖表取反，摘要回来）'));
  passed.push(check(findAllByClass(cards收起[0], 'dshmind-answers').length === 1,
    '③ 切换按会话节点 id 记：首场仍是展开'));
  // 零请求：折叠切换是纯显示动作——两次点击之间一个命令都不许发（「不是写动作」的真判据）。
  passed.push(check(spy.calls.length === 请求前,
    '③ 折叠切换不发任何请求（纯显示切换，不是写动作）', String(spy.calls.length - 请求前)));
  passed.push(check(shown.includes('分歧清单') === false && shown.includes('零分歧'), '零分歧那一场照旧报出零分歧'));
  passed.push(check(textOf(cards[0]).includes('分歧清单：审计档位是否逐条'), '分歧清单渲染出来'));
  passed.push(check(textOf(cards[0]).includes('反例面：权限矩阵未覆盖自动派发'), '会审级反例面渲染出来'));

  // ③c′ ⑮ 强制反对者（2026-10-10）：讨论那一行**有值才画**——t-6 有讨论段且指定了人，
  //     所以画出来；t-4 / t-5 投影里没有这个键（没讨论段）⇒ 一个字都不许多画。
  //     夹具喂的是**真键**（收尾⑥）：这一条钉的是「投影真发的形状能被渲染」。
  passed.push(check(textOf(cards[2]).includes('强制反对者：member-c'),
    '指定了强制反对者的会审卡上画出来（真键 强制反对者）'));
  const 反对者句 = textOf(cards[2]).split('\n').filter((t) => t.indexOf('强制反对者') >= 0);
  passed.push(check(反对者句.length === 1, '强制反对者恰好显示一次（不重复画）', String(反对者句.length)));
  passed.push(check(!textOf(cards[0]).includes('强制反对者') && !textOf(cards[1]).includes('强制反对者'),
    '没有讨论段的会审卡一个「强制反对者」都不画（不给空壳读数）'));

  // ③c″ 别名那一路**单列两条**钉它（收尾⑥）：别名只是兼容旧投影的读法，
  //      不许它冒充真键 —— 所以这两条**专门**喂一份只有别名、没有真键的投影（有值 / 空串各一条）。
  //      真键那一路的「空串 ⇒ 一个字都不画」由 `client.test.js` 的行为判据钉（那边直接拿真键喂 ''）。
  const 别名视图 = sampleView();
  const 别名行 = 别名视图.会审.find((r) => r.节点 === 't-6');
  delete 别名行.强制反对者;
  别名行.dissenter = 'member-c';
  const 别名页 = await renderView(别名视图);
  passed.push(check(别名页.text.includes('强制反对者：member-c'),
    '别名 dissenter 单独喂（没有真键）也归一化画出来 —— 别名只作兼容'));
  const 别名空 = sampleView();
  const 别名空行 = 别名空.会审.find((r) => r.节点 === 't-6');
  delete 别名空行.强制反对者; // 真键在时它先被读到（firstOf 的顺序），要单独验别名就得把它摘掉
  别名空行.dissenter = '';
  const 别名空页 = await renderView(别名空);
  passed.push(check(!别名空页.text.includes('强制反对者'),
    '别名给空串同样一个字都不画（别名不是「有键就画」）'));

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

  // ③g 失联**四态**：每一态渲染各不相同，`已关闭` **绝不许给绿点**
  //     （Batch 2 之前读的是 `boolOf`，拿到 `'已关闭'` 得到 null ⇒ 画成灰点「未知」，
  //      看上去像「没读到」，而真相是「这个机制被停掉了」）。
  const 失联格 = (tree) => {
    const blocks = findAllByClass(tree, 'dshmind-readout');
    const 块 = blocks.find((el) => textOf(el).indexOf('失联状态') >= 0);
    if (!块) return null;
    // 详情**就在这一格里面**（Batch 8：从"横跨整行的脚注"改成"格内附注"）。
    // 所以文本直接取整格的 —— 点色也只取主读数那一格（「这一态是什么颜色」问的是主读数）。
    return {
      文本: textOf(块),
      点色: (findAllByClass(块, 'dshmind-dot')[0] || { props: {} }).props.style.background,
    };
  };
  const GREEN_TOKEN = 'var(--dsw-alias-state-success-primary,#2f9e44)';
  const RED_TOKEN = 'var(--dsw-alias-state-error-primary,#d54941)';
  const GREY_TOKEN = 'var(--dsw-alias-label-caption,#adb2b8)';
  const WARN_TOKEN = 'var(--dsw-alias-state-warn-primary,#c47f17)';

  async function 失联态渲染(view, name) {
    const spy4 = makeRemote(() => okReply(view));
    const booted = boot({ store, services: Object.assign(session(), { remote: spy4.remote }) });
    const renderer = mountDashboard(booted);
    renderer.flush();
    await settle();
    renderer.flush();
    const 格 = 失联格(renderer.tree);
    check(!!格, name + '：页面里找得到「失联状态」那一格');
    renderer.unmount();
    return 格;
  }

  const 在位格 = await 失联态渲染(sampleView(), '在位');
  passed.push(check(在位格.文本.includes('在位') && !在位格.文本.includes('已失联') && !在位格.文本.includes('已关闭'),
    '① 失联=在位 ⇒ 「在位」'));
  passed.push(check(在位格.点色 === GREEN_TOKEN, '① 在位给绿点', String(在位格.点色)));

  const 失联格2 = await 失联态渲染(alarmingView(), '已失联');
  passed.push(check(失联格2.文本.includes('已失联 · 自治冻结'), '① 失联=已失联 ⇒ 「已失联 · 自治冻结」'));
  passed.push(check(失联格2.点色 === RED_TOKEN && 失联格2.点色 !== GREEN_TOKEN, '① 已失联给红点（且不是绿）', String(失联格2.点色)));

  const 关闭格 = await 失联态渲染(closedView(), '已关闭');
  passed.push(check(关闭格.文本.includes('已关闭（不判定失联）'), '① 失联=已关闭 ⇒ 渲染出「已关闭」文案', 关闭格.文本.slice(0, 80)));
  passed.push(check(关闭格.点色 !== GREEN_TOKEN, '① 已关闭**不是绿点**（这是本批要修的真缺陷）', String(关闭格.点色)));
  passed.push(check(关闭格.点色 === WARN_TOKEN, '① 已关闭给中性/告警色', String(关闭格.点色)));
  passed.push(check(!关闭格.文本.includes('已失联'), '① 已关闭 ≠ 已失联：不许写成「已失联」'));
  // 详情里「值不合法」也要露出来（悬停 + 详情行），但主读数不许被它顶掉。
  passed.push(check(关闭格.文本.includes('已关闭（不判定失联）') && 关闭格.文本.includes('值不合法'),
    '① 已关闭那一格同时给出详情里的「值不合法」标记', 关闭格.文本.slice(0, 120)));
  passed.push(check(关闭格.文本.includes('原值 0'), '① 坏值详情带出原值', 关闭格.文本.slice(0, 200)));

  const 未知格 = await 失联态渲染(unknownPresenceView(), '未知');
  passed.push(check(未知格.文本.includes('未知') && !未知格.文本.includes('在位') && !未知格.文本.includes('已关闭'),
    '① 宿主没给失联读数 ⇒ 「未知」，不画成「在位」'));
  passed.push(check(未知格.点色 === GREY_TOKEN, '① 未知给灰点（宿主没给 ≠ 正常）', String(未知格.点色)));
  passed.push(check(未知格.点色 !== GREEN_TOKEN && 未知格.点色 !== RED_TOKEN,
    '① 未知既不是绿也不是红：它与在位、已失联都长得不一样'));

  // ② 四态各渲染对（把四态的点色摊在一张表上比，防止「两态其实同色」这种悄悄退化）
  const 点色表 = { 在位: 在位格.点色, 已失联: 失联格2.点色, 已关闭: 关闭格.点色, 未知: 未知格.点色 };
  passed.push(check(Object.keys(点色表).every((k) => typeof 点色表[k] === 'string' && 点色表[k]),
    '② 四态都有各自的点色', JSON.stringify(点色表)));
  passed.push(check(点色表.在位 !== 点色表.已失联 && 点色表.已失联 !== 点色表.已关闭
    && 点色表.已关闭 !== 点色表.未知 && 点色表.在位 !== 点色表.未知,
    '② 四态的点色两两不同（尤以「在位」与「已关闭」必须不同）', JSON.stringify(点色表)));

  // ③ 旧宿主只给布尔 ⇒ 降级成 已失联 / 在位（绝不降成「未知」）
  const 旧真 = await 失联态渲染(legacyBoolView(true), '旧宿主 true');
  const 旧假 = await 失联态渲染(legacyBoolView(false), '旧宿主 false');
  passed.push(check(旧真.文本.includes('已失联'), '③ 旧宿主 失联=true ⇒ 降级成「已失联」', 旧真.文本.slice(0, 60)));
  passed.push(check(旧真.点色 === RED_TOKEN, '③ 旧宿主 true 给红点', String(旧真.点色)));
  passed.push(check(旧假.文本.includes('在位') && !旧假.文本.includes('已失联'),
    '③ 旧宿主 失联=false ⇒ 降级成「在位」', 旧假.文本.slice(0, 60)));
  passed.push(check(旧假.点色 === GREEN_TOKEN, '③ 旧宿主 false 给绿点', String(旧假.点色)));

  // ④ 看板面板是**只读**的（§9 三条硬规则之三）：一个写控件都不许有。
  //    设置页是独立分区，写控件只在那边 —— 这两条必须同时成立。
  const 面板控件 = collect(r1.tree, { skipStyle: true }).elements;
  const 写控件 = 面板控件.filter((el) => el.type === 'input' || el.type === 'select' || el.type === 'textarea');
  passed.push(check(写控件.length === 0,
    '④ 工作台面板里没有任何输入类控件（input/select/textarea）', 写控件.map((el) => el.type).join(',')));
  const 面板按钮 = 面板控件.filter((el) => el.type === 'button');
  // ⚠️ 优化批③（2026-10-10）改过这条的形状（理由留在断言里，不是把历史的红偷偷删掉）：
  // 面板上现在除了「刷新」还有会审折叠切换钮——那是**纯显示切换**（onClick 只改本地折叠态，
  // 不发任何命令，由 ③c 的「零请求」断言钉死），不是写动作。本条守住的本意是「不给任何写动作」：
  // 按钮只许两种——刷新（dshmind-btn）与折叠钮（dshmind-toggle），多一种都算破规。
  const 非法按钮 = 面板按钮.filter((el) => {
    const 类 = String(el.props.className || '');
    if (类.indexOf('dshmind-btn') >= 0 && String(el.props.children).indexOf('刷新') >= 0) return false;
    if (类.indexOf('dshmind-toggle') >= 0) return false;
    return true;
  });
  passed.push(check(面板按钮.length >= 1 && 非法按钮.length === 0,
    '④ 工作台面板的可点动作只有「刷新」与会审折叠钮（纯显示切换；仍无任何写动作）',
    面板按钮.map((el) => String(el.props.children)).join(',')));
  passed.push(check(!面板控件.some((el) => typeof el.props.onChange === 'function'),
    '④ 工作台面板里没有 onChange 绑定的表单控件（没有任何「写」的入口）'));

  // ⑤⑥⑦ 设置页：读 / 写 + 回读确认
  const SETTINGS_FILE = 'mind-data/mind-private/集体L2-共享基础设施/defaults/部署.json';

  /**
   * `presence` 命令返回体里的 `读数` —— **照真宿主实测的形状写，不是照我们以为的形状写**。
   *
   * 形状来源（逐字段核过 `src/policy.js` 的 `presence()`，宿主侧已落地）：
   *  - **`失联限制: boolean` 恒在**（开 `true` / 关 `false`）—— 它是这个开关的唯一真源；
   *  - **`已关闭?: boolean` 只在关时出现**（`失联限制 === false` 那条 return 才有它）；
   *  - 开着时带 `evaluateSovereignPresence(...)` 的 `{lost, since, deadline, hours}`；
   *  - `响应期限小时来源` / `失联限制来源` 恒在（`来源.X ?? '内置兜底'`）；
   *  - 坏值才多出 `原值` / `原值来源` / `不合法说明`。
   *
   * ⚠️ **这里曾经多补过一个字段、又漏过一个字段**，两次都代价惨重：
   *  · 多补 `失联限制: true`（实现当时不产出它）⇒ 夹具比实现多一个字段，
   *    195 条门禁全绿却漏掉「设置页把读数**对象**喂给只认四态字符串的函数」这个真缺陷；
   *  · 反过来若漏掉现在恒在的 `失联限制`，就等于又在测一个不存在的宿主。
   * 所以：**夹具只写实现真的会产的字段**；要测「字段缺失」的降级路径，另起夹具并显式说明。
   */
  function 真读数(态) {
    const 公共 = {
      失联限制: 态 !== '已关闭',
      响应期限小时来源: '出厂',
      失联限制来源: '出厂',
      生效响应期限小时: 72,
      值不合法: false,
    };
    if (态 === '已关闭') {
      // 关：`已关闭: true` 与 `失联限制: false` 同时出现（前者是后者的显式回声）。
      return Object.assign({ 已关闭: true, lost: false, hours: 0, since: null, deadline: null }, 公共);
    }
    if (态 === '已失联') {
      // 开且超期：**没有 `已关闭`**（它只在关时出现）。
      return Object.assign({
        lost: true, hours: 100, since: '2026-10-03T10:00:00+08:00', deadline: '2026-10-06T10:00:00+08:00',
      }, 公共);
    }
    // 开且在位：同样没有 `已关闭`。
    return Object.assign({
      lost: false, hours: 0.5, since: '2026-10-07T16:50:00+08:00', deadline: '2026-10-10T17:20:00+08:00',
    }, 公共);
  }
  const 读数袋 = (extra) => Object.assign(真读数('在位'), extra || {});

  /**
   * **夹具形状的底本：真宿主实测的键集**（不是我们推断的，也不是我们希望它长什么样）。
   *
   * 怎么来的（临时脚本，`makeFixture({presence:{…}})` ＋ `t.policy.presence()`，跑完即删）：
   * ```text
   * ── 开着且在位      字段：deadline, hours, lost, since, 值不合法, 响应期限小时来源, 失联限制, 失联限制来源, 生效响应期限小时
   * ── 关着            字段：… + 已关闭   （失联限制: false, 已关闭: true）
   * ── 开着但超期      字段：同「开着且在位」（**没有 已关闭**）  lost=true
   * ── 坏值            字段：… + 不合法说明, 原值, 原值来源
   * ```
   * 于是三条不变的结论（**夹具照着它写，谁改宿主形状谁就得回来改这里**）：
   *  1. `失联限制: boolean` **恒在**；
   *  2. `已关闭` **只在关时出现**；
   *  3. 坏值才多出 `原值 / 原值来源 / 不合法说明`。
   *
   * ⚠️ 为什么要把它钉成断言：上一轮夹具在**开**状态多补了一个实现没产的 `失联限制: true`，
   * 结果 195 条门禁全绿却漏掉了 F2（设置页把读数对象喂给只认四态字符串的函数）——
   * **夹具比实现多一个字段，就等于替实现把缺陷遮住了**。钉住键集，夹具想漂就得先红。
   */
  const 真形状键 = {
    在位: ['deadline', 'hours', 'lost', 'since', '值不合法', '响应期限小时来源', '失联限制', '失联限制来源', '生效响应期限小时'],
    已失联: ['deadline', 'hours', 'lost', 'since', '值不合法', '响应期限小时来源', '失联限制', '失联限制来源', '生效响应期限小时'],
    已关闭: ['deadline', 'hours', 'lost', 'since', '值不合法', '响应期限小时来源', '失联限制', '失联限制来源', '已关闭', '生效响应期限小时'],
  };
  for (const 态 of Object.keys(真形状键)) {
    const 实得 = Object.keys(真读数(态)).sort();
    const 应有 = 真形状键[态].slice().sort();
    passed.push(check(JSON.stringify(实得) === JSON.stringify(应有),
      '⑤ 夹具「' + 态 + '」的键集与真宿主实测一致（多一个字段也算漂）'
      + '｜多出来 ' + JSON.stringify(实得.filter((k) => 应有.indexOf(k) < 0))
      + '｜少了 ' + JSON.stringify(应有.filter((k) => 实得.indexOf(k) < 0))));
  }
  passed.push(check(读数袋().失联限制 === true && !Object.hasOwn(读数袋(), '已关闭'),
    '⑤ 夹具照真形状：开着时 `失联限制: true` 且**没有** `已关闭`', JSON.stringify(Object.keys(读数袋()))));
  passed.push(check(真读数('已关闭').失联限制 === false && 真读数('已关闭').已关闭 === true,
    '⑤ 夹具照真形状：关着时 `失联限制: false` ＋ `已关闭: true`'));
  passed.push(check(!Object.hasOwn(真读数('已失联'), '已关闭') && 真读数('已失联').失联限制 === true,
    '⑤ 夹具照真形状：开着（哪怕已失联）**没有** `已关闭`'));

  // ⑤ 读：remote 间谍收到 `mind presence` ⇒ 页面显示生效值 / 来源
  const readSpy = makeRemote((sessionId, command) => {
    if (command === PRESENCE_COMMAND) {
      return Promise.resolve(okReply({ 读数: 读数袋(), 设置文件: SETTINGS_FILE, 说明: '读：本次没带「开关 / 小时」…' }));
    }
    return Promise.resolve(okReply({}));
  });
  const s1 = boot({ store, services: Object.assign(session(), { remote: readSpy.remote }) });
  const sr1 = mountSettings(s1);
  const 设置文本 = await textAfterLoad(sr1);
  const 读调用 = readSpy.calls.filter((c) => c.command === PRESENCE_COMMAND);
  passed.push(check(读调用.length >= 1,
    '⑤ 设置页**至少请求过一次**（`apply` 的轮询立刻拉一次 ⇒ 取数不靠 effect）', String(读调用.length)));
  passed.push(check(读调用[0].command === PRESENCE_COMMAND, '⑤ 读到的是 ' + PRESENCE_COMMAND, 读调用[0].command));
  // ① 读：**GET /plugins/dsh-mind/presence + cache:no-store**（不再走 remote.commands.execute）
  passed.push(check(读调用[0].请求.method === 'GET' && 读调用[0].请求.url === '/plugins/dsh-mind/presence',
    '① 读是 GET /plugins/dsh-mind/presence', JSON.stringify({ m: 读调用[0].请求.method, u: 读调用[0].请求.url })));
  passed.push(check(读调用[0].请求.cache === 'no-store', '① 读带 cache:no-store', String(读调用[0].请求.cache)));
  passed.push(check(读调用.every((c) => c.走了旧通道 !== true),
    '① 一次都没有再碰旧通道 remote.commands.execute'));
  passed.push(check(设置文本.includes('生效期限 72 小时') && 设置文本.includes('期限来自 出厂'),
    '⑤ 页面显示生效值与来源（生效期限 + 由哪一层给的）', 设置文本.slice(0, 140)));
  passed.push(check(设置文本.includes('期限 出厂') && 设置文本.includes('开关 出厂'),
    '⑤ 页面把两个键的来源都显示出来'));
  passed.push(check(设置文本.includes('失联保险 开'),
    '⑤ 页面显示「失联限制」的生效值（真源 = 读数里的布尔），且用新词「失联保险」'));
  passed.push(check(设置文本.includes('心智'), '⑤ 设置页有标题'));
  passed.push(check(设置文本.includes('写入本部署的私有设置'),
    '⑤ 说明收短但信息不丢（它是什么 / 写在哪 / 可关）'));

  // ⑤b 【Batch 4b · F2】设置页那行「当前生效值」必须按**四态**取。
  //     原缺陷：`失联态Of(读)` —— 把 `presence()` 的**对象**喂给只认四态字符串的函数，
  //     于是三态（关 / 失联 / 在位）**全渲染成「当前 未知」+ caption 灰点**，
  //     `已关闭（不判定失联）` 那个分支在设置页**根本不可达**。
  //     （工作台面板没这个错：它读的是宿主已经归一好的 `状态条.失联` 字符串。）
  const 设置页四态 = async (读数, name) => {
    const spy4 = makeRemote(() => Promise.resolve(okReply({ 读数, 设置文件: SETTINGS_FILE, 说明: '读…' })));
    const booted = boot({ store, services: Object.assign(session(), { remote: spy4.remote }) });
    const renderer = mountSettings(booted);
    const 文本 = await textAfterLoad(renderer);
    const 格 = findAllByClass(renderer.tree, 'dshmind-set__row').find((el) => textOf(el).indexOf('当前生效值') >= 0);
    const 点 = 格 ? findAllByClass(格, 'dshmind-dot')[0] : null;
    renderer.unmount();
    return { 文本, 行文本: 格 ? textOf(格) : '', 点色: 点 ? 点.props.style.background : null, name };
  };

  const 设置关 = await 设置页四态(真读数('已关闭'), '已关闭');
  passed.push(check(设置关.行文本.includes('已关闭 · 不判定失联'),
    '⑤b 设置页在「已关闭」读数下显示「已关闭 · 不判定失联」（F2 修的就是这条）', 设置关.行文本.slice(0, 140)));
  passed.push(check(设置关.行文本.indexOf('当前 未知') < 0, '⑤b 已关闭**不许**再显示成「当前 未知」', 设置关.行文本.slice(0, 140)));
  passed.push(check(设置关.点色 === WARN_TOKEN, '⑤b 已关闭给中性/告警色（不是 caption 灰）', String(设置关.点色)));
  passed.push(check(设置关.行文本.includes('当前 已关闭'), '⑤b 那一行后缀的「当前 …」也按四态取', 设置关.行文本.slice(0, 160)));

  passed.push(check(设置关.行文本.includes('失联保险 关'),
    '⑤b 已关闭那行也说「失联保险 关」（不再跟着状态点一起变成「未知」）', 设置关.行文本.slice(0, 170)));

  const 设置失 = await 设置页四态(真读数('已失联'), '已失联');
  passed.push(check(设置失.行文本.includes('已失联 · 自治冻结'),
    '⑤b 设置页在「已失联」读数下显示「已失联 · 自治冻结」', 设置失.行文本.slice(0, 140)));
  passed.push(check(设置失.点色 === RED_TOKEN, '⑤b 已失联给红点', String(设置失.点色)));

  const 设置在 = await 设置页四态(真读数('在位'), '在位');
  // ⚠️ 断言只认四态那一栏（`当前 …` / 开关栏），不做整行「未知」搜索：
  // 开关栏与状态栏是两件事，整行搜会把一栏的字误当成另一栏判错。
  passed.push(check(设置在.行文本.includes('当前 在位') && 设置在.行文本.indexOf('当前 未知') < 0,
    '⑤b 设置页在「在位」读数下显示「当前 在位」', 设置在.行文本.slice(0, 140)));
  passed.push(check(设置在.点色 === GREEN_TOKEN, '⑤b 在位给绿点', String(设置在.点色)));

  passed.push(check(设置关.点色 !== 设置在.点色 && 设置失.点色 !== 设置关.点色 && 设置失.点色 !== 设置在.点色,
    '⑤b 设置页三态的点色两两不同（原来三态全是 caption 灰）',
    JSON.stringify([设置在.点色, 设置失.点色, 设置关.点色])));

  // ⑤c 上界：`响应期限小时` 的合法区间是 **1 ~ 876000**（≈100 年），不是「≥1」。
  //     超过上限的值会让失联判定算不出 deadline（越出 Date 上界）⇒ 读数面全废，
  //     所以宿主拒它，页面也在本地拦住并说清区间（两边同一个数）。
  {
    const spyBound = makeRemote(() => Promise.resolve(okReply({ 读数: 真读数('在位'), 设置文件: SETTINGS_FILE, 说明: '读…' })));
    const booted = boot({ store, services: Object.assign(session(), { remote: spyBound.remote }) });
    const renderer = mountSettings(booted);
    await textAfterLoad(renderer);
    collect(renderer.tree, { skipStyle: true }).elements.find((el) => el.type === 'input')
      .props.onChange({ target: { value: '876001' } });
    renderer.flush();
    spyBound.calls.length = 0;
    collect(renderer.tree, { skipStyle: true }).elements
      .find((el) => el.type === 'button' && String(el.props.children).indexOf('保存') >= 0).props.onClick();
    await settle();
    renderer.flush();
    const 文本 = collect(renderer.tree, { skipStyle: true }).text;
    passed.push(check(文本.includes('没写进去') && 文本.includes('876000'),
      '⑤c 超过上界（876001）⇒ 本地就拦住并说清区间 1 ~ 876000', 文本.slice(-200)));
    passed.push(check(spyBound.calls.filter((c) => c.command.indexOf(PRESENCE_COMMAND + ' ') === 0).length === 0,
      '⑤c 超过上界时**不发**写命令（先拦，不打无准备的仗）', JSON.stringify(spyBound.calls.map((c) => c.command))));
    renderer.unmount();
  }

  let 盘上 = 读数袋();
  const writeSpy = makeRemote((sessionId, command) => {
    // ⚠️ 用 `writeSpy.calls`（`makeRemote` 里记的那份）当日志，因为它**带 `请求` 明细**
    // （方法 / URL / cache / body），写请求的三条断言全靠它；别在这里另起一份只记命令串的。
    if (command === PRESENCE_COMMAND) {
      return Promise.resolve(okReply({ 读数: 盘上, 设置文件: SETTINGS_FILE, 说明: '读：没带参数…' }));
    }
    if (command.indexOf(PRESENCE_COMMAND + ' ') === 0) {
      // 宿主行为：写后就地生效；这里让「盘上」跟着变，模拟真写成功。
      // 「关」这个态在真形状里由 `失联限制: false` ＋ `已关闭: true` 一起表达。
      盘上 = Object.assign(真读数('已关闭'), { 生效响应期限小时: 168, 响应期限小时来源: '私有', 失联限制来源: '私有' });
      return Promise.resolve(okReply({
        设置文件: SETTINGS_FILE, 变更: ['失联限制', '响应期限小时'], 无变更: [], 读数: 盘上, 说明: '已改：这是 merge 写…',
      }));
    }
    return Promise.resolve(okReply({}));
  });
  const 写日志 = writeSpy.calls;
  const s2 = boot({ store, services: Object.assign(session(), { remote: writeSpy.remote }) });
  const sr2 = mountSettings(s2);
  const 设置文本2 = await textAfterLoad(sr2);
  passed.push(check(设置文本2.includes('失联保险 开') && 设置文本2.includes('当前 在位'),
    '⑥ 保存前页面显示的是回读值（开关「开」/ 当前「在位」）', 设置文本2.slice(0, 170)));
  const 控件 = collect(sr2.tree, { skipStyle: true }).elements;
  const 选中框 = 控件.find((el) => el.type === 'select');
  const 数字框 = 控件.find((el) => el.type === 'input');
  passed.push(check(!!选中框 && !!数字框, '⑥ 设置页有一个开关控件 + 一个数字控件'));
  passed.push(check(选中框.props.value === '是' && 数字框.props.value === '72',
    '⑥ 表单初值来自回读（是 / 72）', JSON.stringify([选中框.props.value, 数字框.props.value])));
  // 改值 → 点保存（走的是真实 onChange / onClick，不是直接调内部函数）。
  // ⚠️ 每一步之后**重新取一次元素**：`collect` 给的是那一刻的 props 快照，
  // 重渲染后旧快照上的闭包还握着上一轮的 state —— 拿旧快照调第二次，测的就不是真页面了。
  选中框.props.onChange({ target: { value: '否' } });
  sr2.flush();
  collect(sr2.tree, { skipStyle: true }).elements.find((el) => el.type === 'input')
    .props.onChange({ target: { value: '168' } });
  sr2.flush();
  const 改后 = collect(sr2.tree, { skipStyle: true }).elements;
  passed.push(check(改后.find((el) => el.type === 'select').props.value === '否'
    && 改后.find((el) => el.type === 'input').props.value === '168',
    '⑥ 改动的草稿留在表单里（否 / 168）',
    JSON.stringify([改后.find((el) => el.type === 'select').props.value, 改后.find((el) => el.type === 'input').props.value])));
  const 保存钮 = collect(sr2.tree, { skipStyle: true }).elements
    .find((el) => el.type === 'button' && String(el.props.children).indexOf('保存') >= 0);
  passed.push(check(!!保存钮, '⑥ 设置页有「保存」按钮，且它是写入口'));
  写日志.length = 0;
  保存钮.props.onClick();
  await settle();
  sr2.flush();
  const 写命令 = 写日志.filter((c) => c.command.indexOf(PRESENCE_COMMAND + ' ') === 0);
  passed.push(check(写命令.length === 1, '⑥ 保存 ⇒ 恰好一条写请求', JSON.stringify(写日志.map((c) => c.command))));
  passed.push(check(!!写命令[0] && 写命令[0].command.indexOf('开关=否') >= 0 && 写命令[0].command.indexOf('小时=168') >= 0,
    '⑥ 写请求带上两个参数（开关=否 小时=168）', String(写命令[0] && 写命令[0].command) + ' / 全部 ' + JSON.stringify(写日志.map((c) => c.command))));
  // ② 写：**POST /plugins/dsh-mind/presence** + content-type + body 键值对
  const 写请求 = 写命令[0] && 写命令[0].请求;
  passed.push(check(!!写请求 && 写请求.method === 'POST' && 写请求.url === '/plugins/dsh-mind/presence',
    '② 写是 POST /plugins/dsh-mind/presence', JSON.stringify(写请求 && { m: 写请求.method, u: 写请求.url })));
  passed.push(check(!!写请求 && 写请求.headers && 写请求.headers['content-type'] === 'application/json',
    '② 写带 content-type: application/json', JSON.stringify(写请求 && 写请求.headers)));
  passed.push(check(!!写请求 && 写请求.body === JSON.stringify({ 开关: '否', 小时: 168 }),
    '② 写 body 是对的键值（只放本次要改的键）', String(写请求 && 写请求.body)));
  passed.push(check(写日志.length >= 2 && 写日志[1].command === PRESENCE_COMMAND
    && 写日志[1].请求 && 写日志[1].请求.method === 'GET',
    '② **写完必须回读**：紧随其后的是一次不带参数的 GET ' + PRESENCE_COMMAND, JSON.stringify(写日志.map((c) => c.command + ':' + (c.请求 && c.请求.method)))));
  passed.push(check(写日志[0].command.indexOf(' ') > 0, '② 顺序对：先写后读（不是反的）'));  const 设置文本3 = collect(sr2.tree, { skipStyle: true }).text;
  passed.push(check(设置文本3.includes('已保存') && 设置文本3.includes('回读一致'),
    '⑥ 回读一致 ⇒ 明说已保存且回读一致', 设置文本3.slice(-120)));
  passed.push(check(设置文本3.includes('失联保险 关') && 设置文本3.includes('生效期限 168 小时')
    && 设置文本3.indexOf('失联保险 开') < 0,
    '⑥ UI 以**回读值**为准（关 / 168 小时，不再是写之前的「开 / 72」）', 设置文本3.slice(-220)));
  passed.push(check(设置文本3.includes('（私有）') || 设置文本3.includes('来自 私有'),
    '⑥ UI 的来源也换成回读值给的「私有」'));

  // ⑦ 回读不一致 ⇒ UI 明说「没写进去」，**不许**显示成功
  const 骗人日志 = [];
  const 骗人的 = makeRemote((sessionId, command) => {
    骗人日志.push(command);
    if (command === PRESENCE_COMMAND) {
      // 回读永远说「开关开着、期限 72」——与请求（否 / 168）不一致。
      return Promise.resolve(okReply({ 读数: 读数袋(), 设置文件: SETTINGS_FILE, 说明: '读…' }));
    }
    if (command.indexOf(PRESENCE_COMMAND + ' ') === 0) {
      return Promise.resolve(okReply({ 设置文件: SETTINGS_FILE, 变更: ['响应期限小时'], 无变更: [], 读数: 读数袋(), 说明: '已改…' }));
    }
    return Promise.resolve(okReply({}));
  });
  const s3 = boot({ store, services: Object.assign(session(), { remote: 骗人的.remote }) });
  const sr3 = mountSettings(s3);
  await textAfterLoad(sr3);
  // 同 ⑥：每一步都重新取元素，别拿重渲染前的 props 快照调下一个 handler。
  collect(sr3.tree, { skipStyle: true }).elements.find((el) => el.type === 'select')
    .props.onChange({ target: { value: '否' } });
  sr3.flush();
  collect(sr3.tree, { skipStyle: true }).elements.find((el) => el.type === 'input')
    .props.onChange({ target: { value: '168' } });
  sr3.flush();
  collect(sr3.tree, { skipStyle: true }).elements
    .find((el) => el.type === 'button' && String(el.props.children).indexOf('保存') >= 0).props.onClick();
  await settle();
  sr3.flush();
  const 文本3 = collect(sr3.tree, { skipStyle: true }).text;
  passed.push(check(文本3.includes('没写进去'), '⑦ 回读不一致 ⇒ 明说「没写进去」', 文本3.slice(-140)));
  passed.push(check(文本3.indexOf('没写进去') >= 0 && 文本3.indexOf('已保存，且回读一致') < 0,
    '⑦ 绝不许在回读不一致时显示成功'));
  passed.push(check(文本3.includes('回读与请求不一致') && 文本3.includes('小时 请求 168'),
    '⑦ 不一致的地方要说清（哪个键、请求什么、回读什么）', 文本3.slice(-160)));
  passed.push(check(骗人日志.filter((c) => c.indexOf(PRESENCE_COMMAND + ' ') === 0).length === 1
    && 骗人日志.filter((c) => c === PRESENCE_COMMAND).length >= 2,
    '⑦ 写完照旧回读了一次（写 1 条 + 读 2 条）', JSON.stringify(骗人日志)));

  // ⑦b 【终审追加 S1】回读判据：**读不出 ⇒ 判不一致**
  //
  // 这条与 ⑦ 不是同一件事，所以必须单独一条（⑦ 的 `读数袋()` 里 `失联限制` 是**有值**的：
  // 它测的是「回读得出、但与请求不同」）。这里测的是**键都读不出**的情形：
  // 回读只给 `{lost:false, hours:72, …}` —— **既没有 `失联限制` 也没有 `已关闭`**。
  //
  // 为什么这条性质非守不可：回读读不出时**唯一安全的方向**是判「不一致」。
  // 一旦放宽成「读不出就当成请求值」，界面就会显示「已保存」—— 而盘上到底是什么**谁也不知道**。
  // 这正是 §「查不到 ≠ 放行」在浏览器半边的同款：读不出来不是"写成了"的证据。
  //
  // ⚠️ 复核官的变异 M6（把读不出当成请求值）当时**213 条断言全绿** —— 性质对，但无人守。
  //    这条断言就是为那个变异写的：它必须能红。
  {
    // 回读形状：只给 lost/hours 与来源，**关键的两个键一个都不给**。
    const 读不出的读数 = {
      lost: false, hours: 72, since: null, deadline: null,
      生效响应期限小时: 72, 响应期限小时来源: '出厂', 失联限制来源: '出厂', 值不合法: false,
    };
    passed.push(check(!Object.hasOwn(读不出的读数, '失联限制') && !Object.hasOwn(读不出的读数, '已关闭'),
      '⑦b 前提：这份回读**既没有 `失联限制` 也没有 `已关闭`**（键读不出）',
      JSON.stringify(Object.keys(读不出的读数))));

    const 读不出日志 = [];
    const 读不出的 = makeRemote((sessionId, command) => {
      读不出日志.push(command);
      if (command === PRESENCE_COMMAND) {
        return Promise.resolve(okReply({ 读数: 读不出的读数, 设置文件: SETTINGS_FILE, 说明: '读…' }));
      }
      if (command.indexOf(PRESENCE_COMMAND + ' ') === 0) {
        // 宿主嘴上说改了 —— 但回读读不出它到底改成了什么。**不许信它**。
        return Promise.resolve(okReply({
          设置文件: SETTINGS_FILE, 变更: ['失联限制', '响应期限小时'], 无变更: [], 读数: 读不出的读数, 说明: '已改…',
        }));
      }
      return Promise.resolve(okReply({}));
    });
    const s3b = boot({ store, services: Object.assign(session(), { remote: 读不出的.remote }) });
    const sr3b = mountSettings(s3b);
    await textAfterLoad(sr3b);
    collect(sr3b.tree, { skipStyle: true }).elements.find((el) => el.type === 'select')
      .props.onChange({ target: { value: '否' } });
    sr3b.flush();
    collect(sr3b.tree, { skipStyle: true }).elements.find((el) => el.type === 'input')
      .props.onChange({ target: { value: '168' } });
    sr3b.flush();
    collect(sr3b.tree, { skipStyle: true }).elements
      .find((el) => el.type === 'button' && String(el.props.children).indexOf('保存') >= 0).props.onClick();
    await settle();
    sr3b.flush();
    const 文本3b = collect(sr3b.tree, { skipStyle: true }).text;

    passed.push(check(文本3b.includes('没写进去'),
      '⑦b 键都读不出 ⇒ **必须**报「没写进去」（读不出 ⇒ 判不一致）', 文本3b.slice(-180)));
    // ⚠️ 下面这条**改过一次**，理由留在这里（第一版是空转的）：
    // 第一版写的是 `文本3b.includes('回读 读不出')` —— 而界面上那句话**从来没渲染过**：
    // 回读不一致时提示里只印「小时 请求 X / 回读 Y」那一条（小时读得出 ⇒ 印 72，不是「读不出」），
    // 「开关 请求 否 / 回读 读不出」只存在于内部那一行文案里，没进界面。
    // 拿一个界面根本不显示的串做断言 = 测了个寂寞（复核官的变异也抓不到）。
    // 改成两条**真能绑定这个判据**的：如实印出读到的数值 + 逐字面点名「读不出」（见 ⑦b-2）。
    passed.push(check(文本3b.includes('回读 72'),
      '⑦b 提示里如实给出回读**读出**的那个数值（证明提示确实来自回读比对，不是套话）', 文本3b.slice(-180)));
    passed.push(check(文本3b.indexOf('已保存') < 0 && 文本3b.indexOf('回读一致') < 0,
      '⑦b 键读不出时**绝不许**显示「已保存 / 回读一致」（读不出来不是"写成了"的证据）', 文本3b.slice(-180)));
    // 表单也不许被"读出来的值"顶掉：既然读不出，就保持人刚填的草稿（那才是"没确认"的样子）。
    const 读不出后 = collect(sr3b.tree, { skipStyle: true }).elements;
    passed.push(check(读不出后.find((el) => el.type === 'select').props.value === '否'
      && 读不出后.find((el) => el.type === 'input').props.value === '168',
      '⑦b 读不出时不拿回读值去刷表单（保留人填的草稿）',
      JSON.stringify([读不出后.find((el) => el.type === 'select').props.value, 读不出后.find((el) => el.type === 'input').props.value])));
    passed.push(check(读不出日志.filter((c) => c.indexOf(PRESENCE_COMMAND + ' ') === 0).length === 1
      && 读不出日志.filter((c) => c === PRESENCE_COMMAND).length >= 2,
      '⑦b 照旧先写后读（写 1 条 + 读 2 条）', JSON.stringify(读不出日志)));
    sr3b.unmount();
  }

  // ⑦b-2 【S1 的关键一条】回读里**小时也读不出**时，判据会得出「两个键都不一致」⇒ 那行提示
  // 才会把「开关 请求 否 / 回读 读不出」印到界面上。这一条是唯一能按**字面**钉住
  // 「读不出 ⇒ 判不一致」的断言：把判据放宽成「读不出就当成请求值」，整句提示就会消失 ⇒ 必红。
  {
    const 全读不出的读数 = {
      lost: false, hours: 72, since: null, deadline: null, 值不合法: false,
      // 既没有 `失联限制` / `已关闭`，也**没有 `生效响应期限小时`** ⇒ 两个键都读不出。
    };
    passed.push(check(!Object.hasOwn(全读不出的读数, '失联限制') && !Object.hasOwn(全读不出的读数, '已关闭')
      && !Object.hasOwn(全读不出的读数, '生效响应期限小时'),
      '⑦b-2 前提：这份回读**两个键都读不出**（开关与小时都缺）',
      JSON.stringify(Object.keys(全读不出的读数))));

    const 全读不出 = makeRemote((sessionId, command) => {
      if (command === PRESENCE_COMMAND) {
        return Promise.resolve(okReply({ 读数: 全读不出的读数, 设置文件: SETTINGS_FILE, 说明: '读…' }));
      }
      if (command.indexOf(PRESENCE_COMMAND + ' ') === 0) {
        return Promise.resolve(okReply({
          设置文件: SETTINGS_FILE, 变更: ['失联限制', '响应期限小时'], 无变更: [], 读数: 全读不出的读数, 说明: '已改…',
        }));
      }
      return Promise.resolve(okReply({}));
    });
    const s3c = boot({ store, services: Object.assign(session(), { remote: 全读不出.remote }) });
    const sr3c = mountSettings(s3c);
    await textAfterLoad(sr3c);
    collect(sr3c.tree, { skipStyle: true }).elements.find((el) => el.type === 'select')
      .props.onChange({ target: { value: '否' } });
    sr3c.flush();
    collect(sr3c.tree, { skipStyle: true }).elements.find((el) => el.type === 'input')
      .props.onChange({ target: { value: '168' } });
    sr3c.flush();
    collect(sr3c.tree, { skipStyle: true }).elements
      .find((el) => el.type === 'button' && String(el.props.children).indexOf('保存') >= 0).props.onClick();
    await settle();
    sr3c.flush();
    const 文本3c = collect(sr3c.tree, { skipStyle: true }).text;
    passed.push(check(文本3c.includes('开关 请求 否 / 回读 读不出'),
      '⑦b-2 开关读不出 ⇒ 判**不一致**，并按字面点名「回读 读不出」（放宽成"当成请求值"这句就没了）',
      文本3c.slice(-200)));
    passed.push(check(文本3c.includes('小时 请求 168 / 回读 读不出'),
      '⑦b-2 小时读不出 ⇒ 同样判**不一致**并按字面点名（两个键都不许被"当成请求值"）', 文本3c.slice(-200)));
    passed.push(check(文本3c.includes('没写进去') && 文本3c.indexOf('已保存') < 0 && 文本3c.indexOf('回读一致') < 0,
      '⑦b-2 两个键都读不出 ⇒ 绝不显示成功', 文本3c.slice(-200)));
    sr3c.unmount();
  }

  // ⑧ 诚实降级：remote 缺失 / 命令返回 error / 非 JSON ⇒ 「未接入（用户向）+ 可复制命令」，不抛
  // ⚠️ 这里的 `expect` 是**用户看得见的那句话**，不是实现内部那句错误串（Batch 5 起两者分家）。
  // Batch 7 换传输后，"失败长相"也换了：不再是 `remote.commands.execute` 那套，
  // 而是「拿不到 fetch / HTTP 错 / 非 JSON / 宿主同形 JSON 报失败」。
  const 降级清单 = [
    { name: '拿不到 fetch', services: session(), expect: '拿不到 fetch' },
    { name: 'HTTP 500', services: Object.assign(session(), {
      fetch: makeFetch(() => jsonResponse('<html>500</html>', 500)).fetch,
    }), expect: 'HTTP 500' },
    { name: '宿主同形 JSON 报失败（真拒绝形状）', services: Object.assign(session(), {
      // `InvalidBody` 经 `describeFailure` 出来就是这几个键 —— **没有 `错误` 这一栏**。
      // 所以这一条也钉住「拒绝的形状照真实的那样读得出来」，而不是我以为的形状。
      fetch: makeFetch(() => jsonResponse({ 成功: false, 结果: '结构不合规', 理由: '小时 只接受 ≥1 的整数：收到 "0"。' })).fetch,
    }), expect: '只接受 ≥1 的整数' },
    { name: '返回体不是 JSON', services: Object.assign(session(), {
      fetch: makeFetch(() => jsonResponse('<html>不是 JSON</html>', 200)).fetch,
    }), expect: '读到的设置无法解析' },
    { name: '返回体缺「读数」', services: Object.assign(session(), {
      fetch: makeFetch(() => jsonResponse({ 说明: '没有读数' })).fetch,
    }), expect: '读到的设置不完整' },
  ];
  for (const 场景 of 降级清单) {
    const booted = boot({ store, services: 场景.services });
    const renderer = mountSettings(booted);
    const 文本 = await textAfterLoad(renderer);
    passed.push(check(文本.includes(场景.expect),
      '⑧ ' + 场景.name + ' ⇒ 未接入 + 用户向原因（' + 场景.expect + '）', 文本.slice(0, 140)));
    passed.push(check(文本.includes(PRESENCE_COMMAND), '⑧ ' + 场景.name + ' ⇒ 仍给出可复制去敲的命令'));
    passed.push(check(文本.includes('心智') && !文本.includes('已保存'), '⑧ ' + 场景.name + ' ⇒ 页面没有空白，也没装成已连接'));
    // 顺手把「降级路径也不许漏实现细节」一并钉住（与 ⑨ 互补：⑨ 打正常态，这里打异常态）。
    passed.push(check(!/remote\.|commands\.execute|execute\(/.test(文本),
      '⑧ ' + 场景.name + ' ⇒ 未接入文案里也不许出现实现细节',
      (文本.match(/[^\n]*(?:remote\.|commands\.execute|execute\()[^\n]*/) || [''])[0].slice(0, 90)));
    renderer.unmount();
  }
  // 定位不到会话：同样给「未接入 + 用户向原因」，不是抛错
  const 无会话设置 = boot({ store, services: {} });
  const 无会话渲染 = mountSettings(无会话设置);
  const 无会话文本 = await textAfterLoad(无会话渲染);
  passed.push(check(无会话文本.includes('这一页需要一个打开的会话才能读写设置。'),
    '⑧ 设置页定位不到会话 ⇒ 未接入 + 用户向原因，不抛', 无会话文本.slice(0, 140)));
  passed.push(check(无会话文本.includes(PRESENCE_COMMAND), '⑧ 设置页定位不到会话 ⇒ 仍给可敲的命令'));
  无会话渲染.unmount();
  sr1.unmount();
  sr2.unmount();
  sr3.unmount();

  // ═══ Batch 5：设置页的**人话与样式**（这一类问题此前一条门禁都没有）═══
  //
  // 背景：主人看真机截图挑出两条 —— ①失联限制那个旧叫法不吉利（已统一改成「失联保险」）；
  // ②设置页不像官方设置页的一家人（裸浏览器默认控件 + 一大段文字）。
  // 下面四组断言把这两条拆成可判的东西。
  {
    const 渲染 = (services) => {
      const booted = boot({ store, services });
      const renderer = mountSettings(booted);
      // ⚠️ `doc` 必须一起带出来：样式注入到哪，只有假 document 的 head 知道，
      //    渲染树里看不出来（那正是 Batch 6 缺陷能溜过 247 条断言的原因）。
      return { renderer, doc: booted.doc, 元素: () => collect(renderer.tree, { skipStyle: true }).elements };
    };
    const 常驻 = 渲染(Object.assign(session(), { remote: makeRemote(() => okReply({ 读数: 读数袋(), 设置文件: SETTINGS_FILE, 说明: '读…' })).remote }));
    await textAfterLoad(常驻.renderer);

    // ⑨ 用户可见文本里不含实现细节（`remote.` / `commands.execute` / `execute(`）。
    //    为什么守：错误串是给排障写的（里面就是函数名与调用形状），印到界面上等于让主人读我们的栈。
    const 黑名单 = ['remote.', 'commands.execute', 'execute('];
    const 可见文本 = (元素) => 元素
      .filter((el) => el.type !== 'style' && el.type !== 'script')
      .map((el) => el.props.children)
      .filter((c) => typeof c === 'string' || typeof c === 'number')
      .join('\n');
    const 活文本 = 可见文本(常驻.元素());
    for (const 串 of 黑名单) {
      passed.push(check(活文本.indexOf(串) < 0,
        '⑨ 设置页可见文本不含实现细节「' + 串 + '」',
        (活文本.match(new RegExp('[^\\n]*' + 串.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^\\n]*')) || [''])[0].slice(0, 100)));
    }
    passed.push(check(活文本.indexOf('失联保险') >= 0, '⑨ 文案已换成新词「失联保险」'));
    // 新旧词一刀切：整个设置页一个旧词都不许留。
    // ⚠️ 断言里那个串用 `\u` 转义写字面量：本文件里不留旧词的**明文**，
    //    这样 `grep 旧词 components mind` 能干净地返回 0（门禁之外的眼睛也是门禁）。
    const 旧词 = '\u6b7b\u4eba';
    passed.push(check(collect(常驻.renderer.tree, { skipStyle: true }).text.indexOf(旧词) < 0,
      '⑨ 设置页里不许再出现旧词（失联限制那个不吉利的旧叫法）'));

    // ⑩ 所有交互控件都带我们的类名（= 不是裸浏览器默认样式），且**文档级样式里**能找到对应规则。
    const 控 = 常驻.元素().filter((el) => ['select', 'input', 'button'].indexOf(el.type) >= 0);
    passed.push(check(控.length >= 4, '⑩ 设置页确实渲染出交互控件（select/number/保存/重新读取…）', String(控.length)));

    // ⚠️⚠️ 判据是**可达性**，不是"源里有"（Batch 6 的教训，写在这儿免得又退回去）：
    //    设置页样式**必须**在 `document.head` 里（文档级），因为设置页**不住在看板面板的子树里**。
    //    上一版这条只查"源码里有对应规则" ⇒ 样式压根没生效它照样绿 —— 一个字都没测到可达性。
    //    现在从**假 document 的 head** 里取样式文本：注到面板子树里的那种写法在这里必然查不到。
    const 文档级样式 = (常驻.doc || []).filter((n) => n.tagName === 'STYLE').map((n) => n.textContent).join('\n');
    passed.push(check((常驻.doc || []).some((n) => n.attrs && n.attrs['data-mind'] === 'dshmind-set-settings-style'
      || String(n.attrs && n.attrs['data-mind'] || '').indexOf('settings-style') >= 0),
      '⑩ 设置页样式**注入到 document.head**（文档级，设置页不在看板子树里也能取到）',
      JSON.stringify((常驻.doc || []).map((n) => n.attrs))));
    passed.push(check(文档级样式.indexOf('.dshmind-set__') >= 0,
      '⑩ 文档级样式里确实含设置页那套规则 .dshmind-set__*（不是只存在于某个祖先子树里）',
      String(文档级样式.length) + ' 字符'));
    // 反例守卫：设置页的**渲染树里不许有 style 节点** —— 那就是"挂在子树里"的老写法，
    // 一旦有人改回去，样式会再次对设置页不可达，而这条会先红。
    passed.push(check(常驻.元素().filter((el) => el.type === 'style').length === 0,
      '⑩ 设置页渲染树里没有 <style>（样式**不许**挂在子树里：那样对设置页不可达）'));
    // 判据要强到「这条控件真有基础样式」：
    //  · 第一版 `indexOf('.类名')` —— 基础规则删掉后 `:focus` 那条仍让它"找得到" ⇒ 变异不红；
    //  · 第二版只要求"有从选择器开头的规则" —— 只剩伪态的规则照样满足 ⇒ 变异还是不红；
    //  · 第三版按 `',` 切行 —— 那时样式是**数组源码**；现在设置页样式是注入到 head 的
    //    **连续文本**（数组已经 join 过），按 `',` 切什么都切不到 ⇒ 又绿不了。
    //  现在按**真正的规则边界**（`{` 与 `}`）解析选择器与规则体，与代码怎么拼串无关。
    const 样式文本 = 文档级样式;
    const 规则表 = (() => {
      const 表 = [];
      const 段 = String(样式文本).split('}');
      for (const 块 of 段) {
        const 括号 = 块.lastIndexOf('{');
        if (括号 < 0) continue;
        let 选择器 = 块.slice(0, 括号);
        const 换行 = 选择器.lastIndexOf('\n');
        if (换行 >= 0) 选择器 = 选择器.slice(换行 + 1);
        选择器 = 选择器.trim().replace(/^['"]/, '');
        表.push({ 选择器, 体: 块.slice(括号 + 1) });
      }
      return 表;
    })();
    passed.push(check(规则表.length > 20, '⑩ 样式表解析出可判的规则条数（前提检查）', String(规则表.length)));
    const 基础规则体 = (基) => {
      const 类 = '.' + 基;
      for (const { 选择器, 体 } of 规则表) {
        // 类名边界：`.dshmind-set__btn` 不许匹配到 `.dshmind-set__btn--primary`。
        const 位 = 选择器.indexOf(类);
        if (位 < 0) continue;
        const 后 = 选择器[位 + 类.length];
        if (后 !== undefined && /[\w-]/.test(后)) continue;
        // 伪态（`:focus` / `:hover` / `:disabled`）不算基础规则。
        if (选择器.indexOf(':') >= 0) continue;
        if (/height|padding|background|border|color|font|opacity|border-radius/.test(体)) return 体;
      }
      return '';
    };
    const 我们的 = 控.filter((el) => typeof el.props.className === 'string' && el.props.className.indexOf('dshmind-') === 0);
    passed.push(check(我们的.length === 控.length,
      '⑩ 每个交互控件都带我们的类名（裸默认样式 = 0 个）',
      JSON.stringify(控.filter((el) => 我们的.indexOf(el) < 0).map((el) => el.type + ':' + String(el.props.className)))));
    const 样式表里没有规则的 = 我们的.filter((el) => {
      const 基 = el.props.className.split(/\s+/).filter((c) => c.indexOf('dshmind-') === 0)[0];
      return 基础规则体(基) === '';
    });
    passed.push(check(样式表里没有规则的.length === 0,
      '⑩ 每个控件类名在样式源里都有**基础规则**（带 height/padding/background，不只是伪态；不是"给了类名没给样式"）',
      JSON.stringify(样式表里没有规则的.map((el) => el.props.className))));
    // 主次分档：保存＝主（实心主色），重新读取 / 关闭＝次（描边）。
    const 按钮 = 控.filter((el) => el.type === 'button');
    const 主按钮 = 按钮.filter((el) => String(el.props.className).indexOf('dshmind-set__btn--primary') >= 0);
    passed.push(check(主按钮.length === 1 && String(主按钮[0].props.children).indexOf('保存') >= 0,
      '⑩ 恰好一个主按钮（保存），其余都是次要按钮',
      JSON.stringify(按钮.map((el) => String(el.props.children)))));
    passed.push(check(基础规则体('dshmind-set__btn--primary') && 基础规则体('dshmind-set__select') && 基础规则体('dshmind-set__number'),
      '⑩ 控件基础样式确实在（select / number / 主按钮各有一条带样式的非伪态规则）',
      JSON.stringify([基础规则体('dshmind-set__select').slice(0, 40)])));

    // ⑪ 「未接入」是**用户向**的，且仍给出可复制命令。
    // Batch 7 换传输后，"没有 remote" 不再是一种失败（传输已经不用 remote 了）；
    // 这里的"未接入"取自**拿不到 fetch**（沙箱里真的没有 fetch）—— 那才是现在真实的降级起点。
    const 未接 = 渲染(session());
    const 未接文本 = await textAfterLoad(未接.renderer);
    passed.push(check(未接文本.includes('未接入') && 未接文本.includes('拿不到 fetch'),
      '⑪ 未接入文案是用户向的（说"拿不到 fetch"，不说函数名 / 通道名）', 未接文本.slice(0, 140)));
    passed.push(check(!/remote\.|commands\.execute|execute\(/.test(未接文本),
      '⑪ 未接入文案里没有实现细节'));
    // ⚠️ 这条必须打**未接入那块自己**：页脚本来就有「命令 /mind presence」，
    //    整页搜 `PRESENCE_COMMAND` 会被页脚接住 ⇒ 提示里就算没给命令也照样绿（空转）。
    const 未接提示 = findAllByClass(未接.renderer.tree, 'dshmind-set__notice')[0];
    const 提示文本 = 未接提示 ? textOf(未接提示) : '';
    passed.push(check(!!未接提示 && 提示文本.indexOf(PRESENCE_EXAMPLE) >= 0,
      '⑪ 未接入那块自己给出可复制去敲的完整命令（' + PRESENCE_EXAMPLE + '）', 提示文本.slice(0, 120)));
    passed.push(check(!!未接提示 && 提示文本.indexOf(PRESENCE_COMMAND) >= 0,
      '⑪ 未接入那块给出的命令确实以 ' + PRESENCE_COMMAND + ' 开头'));
    // 「别喧宾夺主」：未接入提示的元素数要**明显少于**正式内容（不是一整屏告警）。
    // ⚠️ 按类名 token 精确算容器（`dshmind-set__noticeText` / `__noticeCmd` 也以 `__notice` 开头，
    //    用 `indexOf` 数会把一条提示数成 3 个元素 —— 那测的就不是"紧凑"了）。
    const 未接元素数 = 未接.元素().filter((el) => typeof el.props.className === 'string'
      && el.props.className.split(/\s+/).indexOf('dshmind-set__notice') >= 0).length;
    passed.push(check(未接元素数 === 1,
      '⑪ 未接入提示收成紧凑一条（1 个容器块，不是一整屏告警）', String(未接元素数)));
    未接.renderer.unmount();

    // ⑫ **不渲染空容器**：有我们的类名、却既没文本也没控件的块 = 版面上的"空框"。
    //    主人截图右侧那个圆角空框，第一件要做的事就是排除它是不是我们自己画的。
    const 空块 = (元素) => 元素.filter((el) => {
      if (typeof el.props.className !== 'string' || el.props.className.indexOf('dshmind-set__') !== 0) return false;
      const 子 = collect(el, { skipStyle: true });
      const 有控件 = 子.elements.some((x) => ['button', 'select', 'input'].indexOf(x.type) >= 0);
      return 子.text.trim() === '' && !有控件;
    });
    for (const 场景 of [{ name: '能读', 渲染器: 常驻.renderer }, { name: '未接入', 渲染器: 未接.renderer }]) {
      const 空 = 空块(collect(场景.渲染器.tree, { skipStyle: true }).elements);
      passed.push(check(空.length === 0,
        '⑫ ' + 场景.name + '态下不渲染任何空容器',
        JSON.stringify(空.map((el) => el.props.className))));
    }
    常驻.renderer.unmount();
  }

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

  // ③f′ 优化批①：空态从「一句空话」换成「一句来路 + 一条可敲的命令」（§9：给文本不给控件）。
  //     三块全空的视图从 noDecisionView 再清空 会审/任务——这就是「新部署账本基本为空」的实况。
  const 全空视图 = noDecisionView();
  全空视图.会审 = [];
  全空视图.任务.节点 = [];
  全空视图.任务.总数 = 0;
  const 全空 = await renderView(全空视图);
  passed.push(check(全空.text.includes('没有需要你决定的事') && 全空.text.includes('没有进行中的会审')
    && 全空.text.includes('任务图为空'), '① 空态仍是明说的一句话（原有措辞保留）'));
  passed.push(check(全空.text.includes('task_pending') && 全空.text.includes('task_submit')
    && 全空.text.includes('task_create'), '① 三块空态各给一条真命令（task_pending / task_submit / task_create）'));
  const 引导命令 = 全空.elements.filter((el) => el.type === 'code'
    && String(el.props.className || '').indexOf('dshmind-cmd') >= 0);
  passed.push(check(引导命令.length === 3, '① 引导命令用等宽可选中的 code 块（恰好三条，不给按钮）',
    String(引导命令.length)));
  passed.push(check(全空.elements.filter((el) => el.type === 'button'
    && String(el.props.className || '').indexOf('dshmind-toggle') >= 0).length === 0,
    '① 空态不画切换钮（引导只给文本）'));
  passed.push(check(findAllByClass(全空.tree, 'dshmind-node').length === 0
    && findAllByClass(全空.tree, 'dshmind-review').length === 0,
    '① 空态不画卡片壳（Batch 9「没数据的格不出现」不倒车）'));
  passed.push(check(!全空.text.includes('/mind task_resolve'),
    '① 空清单里不得残留上一场的裁决命令'));

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
  // 【Batch 4b · 治一条恒真断言】
  // 旧写法：`!/onClick/.test(String(mountEntry(...).tree && ''))` ——
  // 树对象是 truthy，`tree && ''` **恒为 `''`**，`String('')` 的 regex 测试**恒通过**。
  // 也就是说这一条从来没测过任何东西（它并不"保护"什么，只是占了一行、还让人以为测了）。
  // 现在改成真判据：把入口渲染出的**整棵树的元素**都翻出来，任何一个都不得带 onClick。
  // 同一条纪律由**两处**接住，删或改都不会留下空档：
  //   · 这里（入口那一格：点击归宿主 `selectPanel`）；
  //   · ④（工作台面板：唯一可点动作是「刷新」，且没有任何 onChange 表单控件）。
  const 入口元素 = collect(mountEntry(a, { size: 16, active: false }).tree, { skipStyle: true }).elements;
  const 带点击的 = 入口元素.filter((el) => typeof el.props.onClick === 'function');
  passed.push(check(入口元素.length > 0 && 带点击的.length === 0,
    '入口不处理点击（由宿主 selectPanel 负责）—— 整棵树 ' + 入口元素.length + ' 个元素，带 onClick 的 ' + 带点击的.length + ' 个'));
  passed.push(check(svg.props.style.opacity === 0.72, '未选中时标记淡一些', String(svg.props.style.opacity)));
  const glyphActive = mountEntry(a, { size: 16, active: true });
  passed.push(check(collect(glyphActive.tree).elements.find((el) => el.type === 'svg').props.style.opacity === 1,
    '选中态标记不透明（颜色由 currentColor 跟随宿主样式）'));

  // ⑤ 槽位注册不许把 web 启动带崩：注册抛错时降级为「看板不出现」，apply 仍安全返回
  const throwingSlots = makeSlots();
  throwingSlots.slots.register = () => { throw new Error('槽位协议变了'); };
  const broken = boot({ services: Object.assign(session(), { slots: throwingSlots.slots }) });
  passed.push(check(throwingSlots.calls.inject.length === 3, '仍然尝试了三次注入', throwingSlots.calls.inject.join(',')));
  passed.push(check(typeof broken.disposer === 'function' || broken.disposer === undefined,
    '注册失败也不抛，apply 照常返回'));

  // ⑥ 时钟：轮询间隔 + 卸载清理（Batch 7：从"组件里的 30s 自动刷新"改成"apply 里的轮询"）
  passed.push(check(fresh.timers.intervals.length >= 1 && fresh.timers.intervals.some((t) => t.ms === REFRESH_MS),
    '注册了 ' + REFRESH_MS + 'ms 轮询（取数不靠 effect）', JSON.stringify(fresh.timers.intervals.map((t) => t.ms))));
  r0.unmount();
  r1.unmount();
  // ⚠️ 轮询器**不在组件里**（Batch 7：取数移出 effect、由 `apply` 起）⇒ 组件 unmount 不会清它。
  //    清它的地方是 **`apply` 的 disposer** —— 断言就必须打在那上面（③ 轮询计时器被清掉）。
  fresh.disposer();
  passed.push(check(fresh.timers.cleared.length >= 1,
    '③ 轮询计时器在 dispose 时被清掉（clearInterval 被调用）', String(fresh.timers.cleared.length)));

  // ⑥b 轮询序号（W3 批3）：**慢响应后到不许盖新快照**
  //   构造：第一次工作台请求挂着不回（模拟慢响应），手动触发第二次（新读数）先到，
  //   再放行第一次的旧响应 —— 面板必须还显示新读数。
  //   为什么要这条：轮询是「发起—等待—写 store」，等待时长不固定；先发的后到会把 store
  //   写回旧读数，而"看起来正常"的旧读数正是最难发现的错（§3.6 静默失效）。
  {
    const 新读数 = sampleView();
    新读数.项目 = '新读数';
    const 旧读数 = sampleView();
    旧读数.项目 = '旧读数';
    let 工作台第几次 = 0;
    const 放行旧响应 = [];
    // ⚠️ `makeRemote` 的 handler 签名是 `(sessionId, 命令, attachments)`（老夹具形状），
    //    第一个参数不是命令 —— 写成 `function (命令)` 会永远走"设置页那条"分支。
    const 慢桥 = makeRemote(function (_sessionId, 命令) {
      if (命令 !== COMMAND) return okReply({ 读数: { lost: false } }); // 设置页那条不掺和
      工作台第几次 += 1;
      if (工作台第几次 === 1) {
        return new Promise(function (resolve) { 放行旧响应.push(function () { resolve(okReply(旧读数)); }); });
      }
      return okReply(新读数);
    });
    const 慢 = boot({ services: Object.assign(session(), { fetch: 慢桥.fetch }) });
    await settle();
    const 轮 = 慢.timers.intervals.find((t) => t.ms === REFRESH_MS);
    check(!!轮, '⑥b 轮询器已注册');
    轮.fn(); // 第二次请求：新读数立刻到
    await settle();
    放行旧响应.forEach(function (放) { 放(); }); // 第一次的慢响应这时才到
    await settle();
    const r慢 = mountDashboard(慢);
    r慢.flush();
    const 慢文本 = collect(r慢.tree, { skipStyle: true }).text;
    passed.push(check(慢文本.indexOf('新读数') >= 0, '⑥b 慢响应后到时保留新快照', 慢文本.slice(0, 80)));
    passed.push(check(慢文本.indexOf('旧读数') < 0, '⑥b 旧响应不许盖掉新读数（轮询序号）', 慢文本.slice(0, 80)));
    r慢.unmount();
    慢.disposer();
  }

  // ⑥c 设置页轮询序号（W3 批4）：**设置读数那条**同样不许被慢响应盖回去。
  //   ⑥b 只覆盖了投影那条；设置页是「失联限制 / 响应期限小时」的唯一写入口，
  //   它的读数被旧值盖回会让人照着旧值做决定（§3.6 静默失效的另一种长相）。
  {
    const 新读数袋 = 真读数('在位');
    新读数袋.生效响应期限小时 = 168; // 可观察标记：页面显示「生效期限 168 小时」
    const 旧读数袋 = 真读数('在位');
    旧读数袋.生效响应期限小时 = 72;
    let 设置第几次 = 0;
    const 放行旧读数 = [];
    const 慢桥设置 = makeRemote(function (_sessionId, 命令) {
      if (命令 !== PRESENCE_COMMAND) return okReply(sampleView()); // 投影那条不掺和
      设置第几次 += 1;
      if (设置第几次 === 1) {
        return new Promise(function (resolve) { 放行旧读数.push(function () { resolve(okReply({ 读数: 旧读数袋, 设置文件: SETTINGS_FILE, 说明: '读：慢响应' })); }); });
      }
      return okReply({ 读数: 新读数袋, 设置文件: SETTINGS_FILE, 说明: '读：新读数' });
    });
    const 慢设置 = boot({ store, services: Object.assign(session(), { remote: 慢桥设置.remote }) });
    await settle();
    const 轮设置 = 慢设置.timers.intervals.find((t) => t.ms === REFRESH_MS);
    check(!!轮设置, '⑥c 轮询器已注册');
    轮设置.fn(); // 第二次设置请求：新读数（168）先到
    await settle();
    放行旧读数.forEach(function (放) { 放(); }); // 第一次的慢响应这时才到（72）
    await settle();
    const sr慢 = mountSettings(慢设置);
    const 设置慢文本 = await textAfterLoad(sr慢);
    passed.push(check(设置慢文本.indexOf('生效期限 168 小时') >= 0, '⑥c 设置读数：慢响应后到时保留新读数', 设置慢文本.slice(0, 140)));
    passed.push(check(设置慢文本.indexOf('生效期限 72 小时') < 0, '⑥c 旧响应不许盖掉新设置读数（轮询序号）', 设置慢文本.slice(0, 140)));
    sr慢.unmount();
    慢设置.disposer();
  }

  // ⑦ 六条降级路径（都带缓存，所以既能报「未连接」也能显示旧快照）
  // ⚠️ 传输层换了（`remote.commands.execute` → 同源 `fetch`），这一表也跟着换了"失败长相"：
  //    原来的「宿主命令服务不可用 / 读取 remote 服务失败」不再存在，取而代之的是
  //    「拿不到 fetch」与 HTTP / 非 JSON / 宿主同形 JSON 里的失败。
  const fallbacks = [
    { name: '拿不到 fetch', services: session(), expect: '拿不到 fetch' },
    { name: 'HTTP 500 且响应非 JSON', services: Object.assign(session(), {
      fetch: makeFetch(() => jsonResponse('<html>500</html>', 500)).fetch,
    }), expect: 'HTTP 500' },
    { name: '宿主同形 JSON 报失败', services: Object.assign(session(), {
      fetch: makeFetch(() => jsonResponse({ 成功: false, 结果: '策略拒绝', 理由: '策略引擎不健康' })).fetch,
    }), expect: '策略引擎不健康' },
    { name: 'fetch reject', services: Object.assign(session(), {
      fetch: makeFetch(() => Promise.reject(new Error('桥断了'))).fetch,
    }), expect: '桥断了' },
    { name: '返回体不是 JSON', services: Object.assign(session(), {
      fetch: makeFetch(() => jsonResponse('<html>不是 JSON</html>', 200)).fetch,
    }), expect: '返回的内容不是 JSON' },
    { name: '响应没有 text()', services: Object.assign(session(), {
      fetch: makeFetch(() => ({ ok: true, status: 200 })).fetch,
    }), expect: '返回的内容不是 JSON' },
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

  // ═══ Batch 8 · 状态条排版（真机截图逐条拆出来的）═══
  {
    /** 状态条每一格：键 → 该格渲染出的文本（探针要靠这张表眼检排版）。 */
    const 状态条各格 = (tree) => findAllByClass(tree, 'dshmind-readout').map((el) => {
      const 键 = (findAllByClass(el, 'dshmind-readoutKey')[0] || { props: {} });
      const 值 = textOf(findAllByClass(el, 'dshmind-readoutVal')[0]).trim();
      const 注 = textOf(findAllByClass(el, 'dshmind-readoutNote')[0]).replace(/\s+/g, ' ').trim();
      return {
        键: textOf(键).trim(),
        值: 值,
        注: 注,
        // 整格文本（键 + 值 + 注，换行分隔）—— 老断言用惯了这个形状，别让它们失明。
        文本: [textOf(键).trim(), 值, 注].filter(Boolean).join('\n'),
        告警: String(el.props.className).indexOf('dshmind-readoutAlarm') >= 0,
        元素: el,
      };
    });

    /**
     * 渲染面板并等数据到位。
     * @param {object} view 投影
     * @param {boolean} [注入空壳] 是否打开"故障注入"（让面板故意多渲染一个没数据的格）
     */
    const 状态render = async (view, 注入空壳, 注入破折号) => {
      const spy = makeRemote(() => okReply(view));
      const b = boot({ store, services: Object.assign(session(), { remote: spy.remote }) });
      if (注入空壳) b.loaded.win.__dshMindInjectEmptySlot = true;
      if (注入破折号) b.loaded.win.__dshMindInjectDashSlot = true;
      const r = mountDashboard(b);
      r.flush();
      await settle();
      r.flush();
      return r;
    };

    // ① 面板里**不许有"看起来能点"的东西**。例外两种：刷新按钮 + 会审折叠切换钮
    //    （优化批③：纯显示切换，不发命令——「不是写动作」由 ③c 的零请求断言钉死）。
    //    旧版「介入度档位」画成 4 个 chip（零参与/事后抽检/变更预审/逐条审批）——
    //    只读投影长得像按钮，会误导人以为能点。
    const 面板 = await 状态render(sampleView());
    const 面板元素 = collect(面板.tree, { skipStyle: true }).elements;
    const 可点按钮 = 面板元素.filter((el) => el.type === 'button');
    const 非规按钮 = 可点按钮.filter((el) => {
      const 类 = String(el.props.className || '');
      if (类.indexOf('dshmind-btn') >= 0 && String(el.props.children).indexOf('刷新') >= 0) return false;
      if (类.indexOf('dshmind-toggle') >= 0) return false;
      return true;
    });
    passed.push(check(可点按钮.length >= 1 && 非规按钮.length === 0,
      '① 面板里可点的只有「刷新」与会审折叠钮（其余一律不许可点）',
      JSON.stringify(可点按钮.map((el) => String(el.props.children)))));
    passed.push(check(面板元素.every((el) => el.props.role !== 'button'),
      '① 没有任何 role=button 的伪按钮', JSON.stringify(面板元素.filter((el) => el.props.role === 'button').map((el) => el.type))));
    passed.push(check(面板元素.every((el) => el.props.tabIndex === undefined && el.props.tabindex === undefined),
      '① 没有任何 tabindex（不可聚焦）'));
    // 伪按钮 chip：状态条里**一个 chip 都不许有**（chip 是"可选项"的长相 ⇒ 只读投影不用）。
    // `badge` 例外：它是**真告警**（恒红 / 恒绿），语义是"这一格出事了"，不是"可以点我"。
    // 优化批④后读数分身份/健康两组，每组一个 .dshmind-readouts 容器——chip/badge 的规矩两组都要守。
    const 状态条节点s = findAllByClass(面板.tree, 'dshmind-readouts');
    passed.push(check(状态条节点s.length >= 1, '① 找得到状态条那一块（④ 后是身份/健康两个容器）'));
    const 状态条里的伪按钮 = 状态条节点s.flatMap((节点) => findAllByClass(节点, 'dshmind-chip'));
    passed.push(check(状态条里的伪按钮.length === 0,
      '① 状态条里没有任何 chip（"可选项"长相 ⇒ 只读投影不许有）',
      JSON.stringify(状态条里的伪按钮.map((el) => textOf(el)))));
    const 状态条badges = 状态条节点s.flatMap((节点) => findAllByClass(节点, 'dshmind-badge'));
    passed.push(check(状态条badges.length === 0
      || 状态条badges.every((el) => /恒[红绿]警报/.test(textOf(el))),
      '① 状态条里出现的 badge 只能是真告警（恒红/恒绿），不是选项外观',
      JSON.stringify(状态条badges.map((el) => textOf(el)))));
    // 介入度那格：**只显示当前生效的那一档**（一个值），而且不带边框/背景/光标。
    const 各格 = 状态条各格(面板.tree);
    const 介入格 = 各格.find((g) => g.键 === '介入度档位');
    passed.push(check(!!介入格 && 介入格.文本.indexOf('事后抽检') >= 0 && 介入格.文本.indexOf('零参与') < 0
      && 介入格.文本.indexOf('变更预审') < 0 && 介入格.文本.indexOf('逐条审批') < 0,
      '① 介入度只显示当前生效那一档（其余三档不出现）', 介入格 ? 介入格.文本 : '(缺)'));
    passed.push(check(!!介入格 && collect(介入格.元素).elements.every((el) => !el.props.onClick
      && (!el.props.style || el.props.style.cursor === undefined)),
      '① 介入度那格没有任何可点外观（无 onClick / 无 pointer 光标）'));
    面板.unmount();

    // ② 失联状态格：**文案完整**（旧版窄格 + nowrap + ellipsis 被裁成「已关闭（不判定失」）。
    const 关闭面板 = await 状态render(closedView());
    const 关闭各格 = 状态条各格(关闭面板.tree);
    const 失联格2 = 关闭各格.find((g) => g.键 === '失联状态');
    passed.push(check(!!失联格2 && 失联格2.文本.indexOf('已关闭（不判定失联）') >= 0,
      '② 失联状态格**完整**渲染「已关闭（不判定失联）」（不许被截断）', 失联格2 ? 失联格2.文本 : '(缺)'));
    // 「不裁切」的可判形态：值节点上**不许有** nowrap / ellipsis 这类会裁字的样式。
    const 失联值 = 失联格2 ? findAllByClass(失联格2.元素, 'dshmind-readoutVal')[0] : null;
    passed.push(check(!!失联值 && (!失联值.props.style || 失联值.props.style.whiteSpace !== 'nowrap'),
      '② 失联那一格的值没有被设成 nowrap（换行而不是裁切）',
      JSON.stringify(失联值 && 失联值.props.style)));
    // ⑥ 详情必须**贴在这一格里**（不再横跨整行当脚注）。
    passed.push(check(!!失联格2 && 失联格2.文本.indexOf('生效期限') >= 0 && 失联格2.文本.indexOf('开关来源') >= 0,
      '⑥ 失联的详情（生效期限 / 开关来源）**紧贴这一格**渲染', 失联格2 ? 失联格2.文本 : '(缺)'));
    passed.push(check(findAllByClass(关闭面板.tree, 'dshmind-readoutDetail').length === 0,
      '⑥ 不再有横跨整行的旧详情行（.dshmind-readoutDetail 已删）'));
    关闭面板.unmount();

    // ③ 没数据的安全类探针：**不许渲染空容器** —— 要么有说明文字、要么整格不出现。
    const 无探针 = sampleView();
    无探针.状态条 = Object.assign({}, 无探针.状态条);
    delete 无探针.状态条.探针;
    const 无探针面板 = await 状态render(无探针);
    const 探针格 = 状态条各格(无探针面板.tree).find((g) => g.键 === '安全类探针');
    passed.push(check(!探针格 || 探针格.文本.replace('安全类探针', '').trim().length > 0,
      '③ 没数据的安全类探针格**不是空的**（有"未跑过"这类说明文字）', 探针格 ? 探针格.文本 : '(整格未渲染)'));
    // 形态二：整格也可以收起来 —— 两种都接受，但"空框"不接受。
    passed.push(check(!探针格 || (探针格.文本.indexOf('未跑过') >= 0 || 探针格.文本.indexOf('没有快照') >= 0),
      '③ 没数据时如实说「未跑过 / 没有快照」，不留空白大框', 探针格 ? 探针格.文本 : '(整格未渲染)'));
    无探针面板.unmount();

    // ⑦ 生成时刻与项目键那两格的列宽口径一致（同一个网格、同一套类名 ⇒ 宽窄齐）。
    const 项目格 = 各格.find((g) => g.键 === '项目键');
    const 时刻格 = 各格.find((g) => g.键 === '生成时刻');
    passed.push(check(!!项目格 && !!时刻格
      && String(项目格.元素.props.className) === String(时刻格.元素.props.className),
      '⑦ 项目键与生成时刻两格用同一套类名（列宽口径一致）',
      JSON.stringify([项目格 && 项目格.元素.props.className, 时刻格 && 时刻格.元素.props.className])));
    // 自适应 + **没有空轨道**（Batch 9：网格换成 flex-wrap —— `auto-fit` 的空轨道就是"空位突兀"的来源）。
    const 面板源码 = readFileSync(CLIENT_PATH, 'utf8');
    passed.push(check(/\.dshmind-readouts\{display:flex;flex-wrap:wrap/.test(面板源码),
      '⑤ 状态条是 flex-wrap（没有"轨道"概念 ⇒ 排不满也不会画出空框）'));
    passed.push(check(!/\.dshmind-readouts\{display:grid/.test(面板源码),
      '⑤ 状态条不再是 auto-fit 网格（那是空轨道的来源）'));
    passed.push(check(/\.dshmind-readout\{[^}]*flex:1 1 \d+px/.test(面板源码),
      '⑤ 每格自适应宽度（`flex:1 1 <basis>`）'));
    passed.push(check(/\.dshmind-readoutVal\{[^}]*overflow-wrap:anywhere/.test(面板源码)
      && !/\.dshmind-readoutVal\{[^}]*text-overflow:ellipsis/.test(面板源码),
      '⑤ 值的样式是"可换行"而不是"裁切"（无 text-overflow:ellipsis）'));

    // ═══ Batch 9 · 状态条"空位" + 审计框可滚动 ═══
    //
    // 主人看过真机：「还可以，就是空位的地方不好看，比较突兀」＋「审计流那个框不能滚动」。
    // 两个成因分别钉住：①`auto-fit` 的空轨道会被画上外观 ②值为 `—` 的空格照样占位。

    // ① **带壳的元素数 === 有内容的格数**（不许存在"有壳没内容"的格）。
    //    旧版：格子的壳来自容器背景 + `gap:1px` 露的缝 ⇒ 空轨道也长成一个方框。
    //
    // ⚠️ 这两条（① 与 ②）守的是**防御性守卫**：Batch 9 之后每个调用点都给得出真值或一句人话，
    //    所以它们**没有活的触发者**——真值改变不了它们（我试过：把守卫拆了也不红）。
    //    于是一起用**故障注入**把退化形态造出来验：面板读 `window.__dshMindInjectEmptySlot === true`
    //    时会故意多渲染一个"没数据的格"。**没有反例 = 没验过**，这一笔就是那个反例。
    for (const 场景 of [
      { name: '常态', view: sampleView() },
      { name: '半数缺数据', view: 半数缺数据的视图() },
    ]) {
      const r = await 状态render(场景.view);
      const 格 = findAllByClass(r.tree, 'dshmind-readout');
      const 空壳 = 格.filter((el) => {
        // ⚠️ 判据是**「除了键以外的内容」**：格子总是有键（那是标签，不是内容。
        //    第一版只算「整格文本去掉空白/破折号」，于是"只剩一个键"的退化格子会被算成"有内容"
        //    ⇒ 变异（让没内容的格照样画壳）不红。现在把键去掉再判。
        const 键文本 = textOf(findAllByClass(el, 'dshmind-readoutKey')[0]);
        const 其余 = textOf(el).replace(键文本, '');
        return 其余.replace(/[\s—–-]/g, '').length === 0;
      });
      passed.push(check(格.length > 0, '① ' + 场景.name + '：状态条确实渲染了格子', String(格.length)));
      passed.push(check(空壳.length === 0,
        '① ' + 场景.name + '：**没有"有壳没内容"的格**（带壳元素数 === 有内容的格数）',
        JSON.stringify(空壳.map((el) => textOf(el)))));
      r.unmount();
    }
    // **反例（证据）**：故意注入一个"没数据的格" ⇒ 同一把尺子必须数得出来。
    // 数不出来就说明上面那条是空转的（"没有反例 = 没验过"）。
    {
      const 注入 = await 状态render(sampleView(), true);
      const 空壳 = findAllByClass(注入.tree, 'dshmind-readout').filter((el) => {
        const 键文本 = textOf(findAllByClass(el, 'dshmind-readoutKey')[0]);
        return textOf(el).replace(键文本, '').replace(/[\s—–-]/g, '').length === 0;
      });
      passed.push(check(空壳.length === 1,
        '① 反例：故意注入一个"没数据的格" ⇒ 判据必须**数得出来**（否则这条是空转）',
        JSON.stringify(空壳.map((el) => textOf(el)))));
      注入.unmount();
    }

    // ② 状态条里**不许出现空的 `—` 格**：无数据的格要么有说明文字、要么不渲染。
    const 缺数据面板 = await 状态render(半数缺数据的视图());
    const 缺数据各格 = 状态条各格(缺数据面板.tree);
    passed.push(check(缺数据各格.every((g) => g.值.replace(/[\s—–-]/g, '').length > 0),
      '② 每一格的值都不是光秃秃的 `—`（无数据就不渲染 / 有说明文字）',
      JSON.stringify(缺数据各格.map((g) => g.键 + '=' + g.值))));
    // **反例（证据）**：故意注入一个"值为 `—`"的格 ⇒ 同一把尺子必须**看得出它不合格**。
    // 这条是"② 那条判据真在算"的证据 —— 没有它，② 就只是"碰巧数据里没有破折号"。
    {
      const 注入 = await 状态render(sampleView(), false, true);
      const 破折号格 = 状态条各格(注入.tree).filter((g) => g.值.replace(/[\s—–-]/g, '') === '');
      passed.push(check(破折号格.length === 1,
        '② 反例：故意注入一个"值为 —"的格 ⇒ 判据必须**认得出它**（否则这条是空转）',
        JSON.stringify(破折号格.map((g) => g.键 + '=' + g.值))));
      注入.unmount();
    }
    // 整格不出现也接受：探针没结论时那一格必须消失。
    const 缺探针 = sampleView();
    缺探针.状态条 = Object.assign({}, 缺探针.状态条);
    delete 缺探针.状态条.探针;
    const 缺探针面板 = await 状态render(缺探针);
    passed.push(check(!状态条各格(缺探针面板.tree).some((g) => g.键 === '安全类探针'),
      '② 探针没数据时**整格不渲染**（不是留一个写着"—"的格子）'));
    缺探针面板.unmount();
    缺数据面板.unmount();

    // ④ 审计列表容器**可滚动**（样式源里有 max-height + overflow-y:auto）。
    passed.push(check(/\.dshmind-auditScroll\{[^}]*max-height:[^;}]+/.test(面板源码),
      '④ 审计容器有 max-height（超高的内容不会把面板撑长）'));
    passed.push(check(/\.dshmind-auditScroll\{[^}]*overflow-y:auto/.test(面板源码),
      '④ 审计容器 overflow-y:auto —— **框内可滚**（Batch 9 后半的硬要求）'));
    passed.push(check(/\.dshmind-auditScroll\{[^}]*scrollbar-width:thin/.test(面板源码),
      '④ 滚动条可见（让人知道能滚，`scrollbar-width:thin`）'));

    // ⑤ **渲染出的审计行数 === 投影给的行数**（不许静默裁掉、不许渲染了却不可达）。
    {
      const 多行 = sampleView();
      // 造一份"条数明显超可视高度"的投影（40 条，超过 AUDIT_LIMIT=20 ⇒ 也要如实说明）。
      const 基 = 多行.审计尾[0];
      多行.审计尾 = Array.from({ length: 40 }, (_, i) => Object.assign({}, 基, { seq: i + 1 }));
      const r = await 状态render(多行);
      const 行 = findAllByClass(r.tree, 'dshmind-auditRow');
      const 应渲染 = Math.min(40, 20); // AUDIT_LIMIT
      passed.push(check(行.length === 应渲染,
        '⑤ 审计行**渲染数 === 该列出的行数**（'+应渲染+' 条，不静默裁掉）', String(行.length)));
      const 滚动容器 = findAllByClass(r.tree, 'dshmind-auditScroll')[0];
      passed.push(check(!!滚动容器 && findAllByClass(滚动容器, 'dshmind-auditRow').length === 行.length,
        '⑤ 渲染出的行**全部落在滚动容器里**（渲染了却不可达 ＝ 等于没渲染）',
        String(滚动容器 ? findAllByClass(滚动容器, 'dshmind-auditRow').length : -1)));
      const 文本 = collect(r.tree, { skipStyle: true }).text;
      passed.push(check(文本.indexOf('投影共 40 条') >= 0 && 文本.indexOf('另有 20 条') >= 0,
        '⑤ 框尾如实说清「投影共 40 条 / 另有 20 条未列出」（不是静默截断）', 文本.slice(-160)));
      r.unmount();
    }
    // 行数没超上限时：如实说"已全部列出"。
    {
      const r = await 状态render(sampleView());
      const 文本 = collect(r.tree, { skipStyle: true }).text;
      passed.push(check(文本.indexOf('投影共 4 条，已全部列出') >= 0,
        '⑤ 不超上限时明说「已全部列出」', 文本.slice(-160)));
      r.unmount();
    }
  }

  //
  // 真机事实：设置页与看板面板**都停在初始态**，而点「保存」能让按钮变「保存中…」
  // ⇒ `useState`（含 setter 与重渲染）是好的，坏的只有 `useEffect`。
  // 所以：数据由 `apply` 里的裸 `setInterval` 轮询喂进模块级 store，组件只 `useState` 订阅。
  // 下面两条就是"把 effect 废掉，页面照样出数据"。
  {
    /** 一个**没有** `useEffect` 的 React（模拟这个宿主）。 */
    const 无effect的React = {
      createElement: React.createElement,
      useState: React.useState,
      useRef: React.useRef,
    };
    const 去掉effect = (require) => (name) => {
      if (name === 'react') return 无effect的React;
      return require(name);
    };
    const 好宿主 = Object.assign(session(), {
      fetch: makeFetch((url) => (String(url).indexOf('workbench') >= 0
        ? jsonResponse(sampleView())
        : jsonResponse({ 读数: 读数袋(), 设置文件: SETTINGS_FILE, 说明: '读…' }))).fetch,
    });

    // ① 设置页：没有 effect ⇒ 仍能出数据（读数 / 生效值都在）
    const 设置无effect = boot({ store, services: Object.assign({}, 好宿主, {}), requireOverride: 去掉effect });
    const 设置渲染 = mountSettings(设置无effect);
    设置渲染.flush();  // **只 flush，不跑 effect**（effect 是空的）
    await settle();
    设置渲染.flush();
    const 设置文本 = collect(设置渲染.tree, { skipStyle: true }).text;
    passed.push(check(设置文本.includes('失联保险 开') && 设置文本.includes('生效期限 72 小时'),
      '① 宿主没有 useEffect ⇒ 设置页**仍出数据**（轮询喂 store，不靠 effect）', 设置文本.slice(0, 160)));
    passed.push(check(设置文本.indexOf('正在读取设置') < 0,
      '① 没有 effect 也不会停在「正在读取设置…」', 设置文本.slice(0, 120)));
    设置渲染.unmount();

    // ② 看板面板：同样没有 effect ⇒ 仍出数据
    const 面板无effect = boot({ store, services: 好宿主, requireOverride: 去掉effect });
    const 面板渲染 = mountDashboard(面板无effect);
    面板渲染.flush();
    await settle();
    面板渲染.flush();
    const 面板文本 = collect(面板渲染.tree, { skipStyle: true }).text;
    passed.push(check(面板文本.includes('mind-private') && 面板文本.includes('把工作台投影接上客户端'),
      '② 宿主没有 useEffect ⇒ **看板面板**仍出数据（它以前也是 effect 驱动，所以一直不出）',
      面板文本.slice(0, 180)));
    passed.push(check(面板文本.includes('活数据'),
      '② 面板页头显示「活数据」（不是永远「读取中」）', 面板文本.slice(0, 120)));
    面板渲染.unmount();
  }

  // ═══ Batch 7 · 拿不到计时器 ⇒ **响亮**（不许静默"不设超时 / 不轮询"）═══
  {
    const 无计时器 = boot({ services: Object.assign(session(), {
      fetch: makeFetch(() => jsonResponse({ 读数: 读数袋(), 设置文件: SETTINGS_FILE, 说明: '读…' })).fetch,
    }), noTimers: true });
    const 渲染器 = mountSettings(无计时器);
    const 文本 = await textAfterLoad(渲染器);
    passed.push(check(无计时器.warnings.some((w) => w.indexOf('计时器') >= 0),
      '④ 拿不到计时器 ⇒ console **明确报出**（不许静默）', JSON.stringify(无计时器.warnings.slice(0, 2))));
    passed.push(check(文本.includes('计时器') && 文本.includes('不会自动刷新'),
      '④ 拿不到计时器 ⇒ 页面上也明说（不许静默不轮询）', 文本.slice(0, 200)));
    passed.push(check(无计时器.timers.intervals.length === 0,
      '④ 拿不到计时器时确实没有注册轮询（如实反映，而不是假装有）'));
    渲染器.unmount();
  }
  //
  // 真机缺陷：设置页永远停在「正在读取设置…」。两个成因，两条都要守：
  //  1. `execute` 返回**永不 settle** 的 promise ⇒ 只有**超时**能离开 loading（`.catch` 永远等不到）；
  //  2. React 缺 `useEffect`（兜底是空实现）⇒ effect 根本没跑 ⇒ 页面静止在初始态。
  {
    // ① 永不 settle + 推进假时钟 ⇒ 必须离开 loading，落到「未接入（超时）」，且文案带诊断。
    const 挂死 = boot({ store, services: Object.assign(session(), {
      // 请求永不 settle：resolve/reject 都不来（真机那次就是这个形状）。
      fetch: makeFetch(() => new Promise(() => {})).fetch,
    }) });
    const 挂死渲染 = mountSettings(挂死);
    挂死渲染.flush();
    await settle();
    挂死渲染.flush();
    const 未推进 = collect(挂死渲染.tree, { skipStyle: true }).text;
    passed.push(check(未推进.includes('正在读取设置'),
      '⑯ 未推进时钟时仍是 loading（前提：这一态真的存在）', 未推进.slice(0, 100)));
    // 推进 8 秒：超时回调触发 ⇒ 链落到 error。
    挂死.timers.fireTimeouts();
    await settle();
    挂死渲染.flush();
    const 挂死文本 = collect(挂死渲染.tree, { skipStyle: true }).text;
    passed.push(check(挂死文本.indexOf('正在读取设置') < 0,
      '⑯ 永不 settle 的 execute + 推进 8 秒 ⇒ **必须离开 loading**', 挂死文本.slice(0, 160)));
    passed.push(check(挂死文本.includes('超时'),
      '⑯ 落到「未接入（超时）」而不是继续等', 挂死文本.slice(0, 160)));
    passed.push(check(挂死文本.includes('/plugins/dsh-mind/presence') && 挂死文本.includes('8 秒'),
      '⑯ 超时文案**带可诊断信息**（路由 · 等了多久）', 挂死文本.slice(0, 220)));
    挂死渲染.unmount();

    // ② reject ⇒ 同样落「未接入（原因）」，不停 loading。
    const 拒了 = boot({ store, services: Object.assign(session(), {
      remote: makeRemote(() => Promise.reject(new Error('通道断了'))).remote,
    }) });
    const 拒了渲染 = mountSettings(拒了);
    const 拒了文本 = await textAfterLoad(拒了渲染);
    passed.push(check(拒了文本.indexOf('正在读取设置') < 0 && 拒了文本.includes('未接入'),
      '⑯ execute reject ⇒ 落到「未接入」，不停 loading', 拒了文本.slice(0, 160)));
    passed.push(check(拒了文本.includes('通道断了') || 拒了文本.includes('与宿主通信失败'),
      '⑯ reject 的原因要看得见（原样带出或给用户向说法）', 拒了文本.slice(0, 160)));
    拒了渲染.unmount();

    // ③ 假 React 抽掉 useEffect ⇒ **明确报出**（console 一句），不许静默。
    //    ⚠️ Batch 7 起断言**改了半条**（不是放松，是事实变了）：取数已移出 effect，
    //    所以缺 effect **不再让页面停住** —— 它只少一层增强。于是这里要同时钉住两件事：
    //      · console 仍然**响亮**（缺 hook 必须有人看得见，不许静默退化）；
    //      · 页面**照常有数据**（不再依赖 effect ⇒ 这条比"页面会说一句"强得多）。
    const 真Effect = React.useEffect;
    delete React.useEffect;
    try {
      const 缺钩 = boot({ store, services: Object.assign(session(), {
        fetch: makeFetch((url) => (String(url).indexOf('workbench') >= 0
          ? jsonResponse(sampleView())
          : jsonResponse({ 读数: 读数袋(), 设置文件: SETTINGS_FILE, 说明: '读…' }))).fetch,
      }) });
      const 缺钩渲染 = mountSettings(缺钩);
      缺钩渲染.flush();
      const 缺钩文本 = collect(缺钩渲染.tree, { skipStyle: true }).text;
      passed.push(check(缺钩.warnings.some((w) => w.indexOf('useEffect') >= 0),
        '⑯ 缺 useEffect ⇒ console **明确报出**（不许静默）',
        JSON.stringify(缺钩.warnings.slice(0, 2))));
      await settle();
      缺钩渲染.flush();
      const 缺钩终态 = collect(缺钩渲染.tree, { skipStyle: true }).text;
      passed.push(check(缺钩终态.includes('失联保险 开') && 缺钩终态.includes('生效期限 72 小时'),
        '⑯ 缺 useEffect ⇒ 页面**照常有数据**（取数不再依赖 effect，这是 Batch 7 的重心）',
        缺钩终态.slice(0, 200)));
      passed.push(check(缺钩.calls.register.length === 3,
        '⑯ 缺 useEffect 也不影响注册（页面还在，只是不能自动取数）'));
      缺钩渲染.unmount();
    } finally {
      React.useEffect = 真Effect;
    }

    // ④ 保存链超时 ⇒ 按钮**不永久「保存中」**，并明说「没写进去」。
    let 第几次 = 0;
    const 保存挂死 = boot({ store, services: Object.assign(session(), {
      remote: makeRemote(() => {
        第几次 += 1;
        // 第一次（读）正常返回；之后（写命令 + 回读）全部挂死 ⇒ 保存链卡住。
        if (第几次 === 1) return okReply({ 读数: 读数袋(), 设置文件: SETTINGS_FILE, 说明: '读…' });
        return new Promise(() => {});
      }).remote,
    }) });
    const 保存渲染 = mountSettings(保存挂死);
    await textAfterLoad(保存渲染);
    collect(保存渲染.tree, { skipStyle: true }).elements.find((el) => el.type === 'button'
      && String(el.props.children).indexOf('保存') >= 0).props.onClick();
    await settle();
    保存渲染.flush();
    保存挂死.timers.fireTimeouts();
    await settle();
    保存渲染.flush();
    const 保存文本 = collect(保存渲染.tree, { skipStyle: true }).text;
    const 保存钮 = collect(保存渲染.tree, { skipStyle: true }).elements.find((el) => el.type === 'button'
      && String(el.props.children).indexOf('保存') >= 0);
    passed.push(check(!!保存钮 && 保存钮.props.disabled !== true && String(保存钮.props.children) === '保存',
      '⑯ 保存链超时 ⇒ 按钮**不永久「保存中」**，回到可点', JSON.stringify(保存钮 && String(保存钮.props.children))));
    passed.push(check(保存文本.includes('没写进去'),
      '⑯ 保存链超时 ⇒ 明说「没写进去」，不装成功', 保存文本.slice(-180)));
    保存渲染.unmount();
  }

  // ⑩b 设置页无 document 时也不抛：样式注不了只掉外观，功能不受影响
  {
    const 无文档 = boot({ services: sessionWithNoDocument() });
    const 无文档渲染 = mountSettings(无文档);
    const 无文档文本 = await textAfterLoad(无文档渲染);
    passed.push(check(!!无文档渲染.tree && 无文档文本.includes('心智'),
      '⑩b 没有 document 时：页面照常渲染（注入不了样式只掉外观，不抛）'));
    passed.push(check(无文档.doc === null, '⑩b 没有 document 时：没有 head 可注入，也不报错'));
    无文档渲染.unmount();
  }

  // ═══ 优化批 ②⑤⑥（2026-10-12）· 任务状态徽章着色 / 判据限行+title / 审计时间口径 ═══
  //
  // 判据全部走 renderView 的**行为读数**（喂进去 → 画出来），体例同学 ⑮ 收尾⑥。
  // 夹具三态（t-1 执行中 / t-2 已打回 / t-3 待决）恰好覆盖 BRAND 与 WARN；
  // GREEN 与灰态用 sampleView() 拷贝后局部改字段构造（任务.计数 无断言消费，
  // 页脚只数 tasks.length —— 已 grep 核过，改 状态/判据 字段不牵连交叉断言）。
  {
    // 色令牌与 lib/client.js 的常量逐字对应（令牌改名只掉外观，断言名不变）。
    const 色板 = {
      BRAND: 'var(--dsw-alias-state-business-primary,#0f1115)',
      GREEN: 'var(--dsw-alias-state-success-primary,#2f9e44)',
      WARN: 'var(--dsw-alias-state-warn-primary,#c47f17)',
      灰: 'var(--dsw-alias-label-secondary,#61666b)',
    };
    /** 任务卡里的**状态**徽章（nodeTop 内那一个；chips 区 badge() 生成的不是它）。 */
    const 状态徽章 = (card) => {
      const top = card ? findAllByClass(card, 'dshmind-nodeTop')[0] : null;
      return top ? findAllByClass(top, 'dshmind-badge')[0] : null;
    };
    /** 按节点描述找任务卡（id 只进 key，页面上找得到的是描述）。 */
    const 卡 = (r, desc) => findAllByClass(r.tree, 'dshmind-node')
      .find((el) => textOf(el).indexOf(desc) >= 0) || null;
    const 判据值 = (card) => (card ? findAllByClass(card, 'dshmind-criteriaVal')[0] || null : null);
    const 改状态 = (view, id, 状态) => {
      const 节点 = view.任务.节点.find((n) => n.id === id);
      if (状态 === undefined) delete 节点.状态; else 节点.状态 = 状态;
    };

    // ② 夹具三态：执行中 BRAND、已打回 WARN、待决 WARN（体例：color+border 同值+layer-1 底色）。
    {
      const r = await renderView(sampleView());
      const 徽 = 状态徽章(卡(r, '把工作台投影接上客户端'));
      passed.push(check(!!徽 && 徽.props.style.color === 色板.BRAND
        && 徽.props.style.borderColor === 色板.BRAND
        && 徽.props.style.background === 'var(--dsw-alias-bg-layer-1,#fff)',
        '② 执行中任务徽章给进行色 BRAND（color+border 同值+底色 layer-1）',
        JSON.stringify(徽 && 徽.props.style)));
      const 徽2 = 状态徽章(卡(r, '校准策略引擎的拒绝理由'));
      passed.push(check(!!徽2 && 徽2.props.style.color === 色板.WARN && 徽2.props.style.borderColor === 色板.WARN,
        '② 已打回任务徽章给告警 WARN', JSON.stringify(徽2 && 徽2.props.style)));
      const 徽3 = 状态徽章(卡(r, '审计档位分级落地'));
      passed.push(check(!!徽3 && 徽3.props.style.color === 色板.WARN && 徽3.props.style.borderColor === 色板.WARN,
        '② 待决任务徽章给告警 WARN', JSON.stringify(徽3 && 徽3.props.style)));
      // ⑥ 顺手在同一份活页上钉审计时间口径：夹具 seq1 的 ISO（Clock.iso 同款秒级 ISO）
      //   `2026-10-07T17:01:02+08:00` 必须画成带 MM-DD 前缀的 `10-07 17:01:02`——
      //   诊断档「只到时分秒」不成立，这条钉住短日期前缀不许再被「优化」掉。
      passed.push(check(r.text.indexOf('10-07 17:01:02') >= 0,
        '⑥ 审计时间恒带 MM-DD 短日期前缀（→ 10-07 17:01:02 形态）', r.text.slice(0, 0)));
    }
    // ② GREEN 两态 + 已派发归 BRAND：拷贝夹具局部改字段。
    {
      const view = sampleView();
      改状态(view, 't-1', '已交卷');
      改状态(view, 't-2', '已采纳');
      const r = await renderView(view);
      const 交 = 状态徽章(卡(r, '把工作台投影接上客户端'));
      const 纳 = 状态徽章(卡(r, '校准策略引擎的拒绝理由'));
      passed.push(check(!!交 && 交.props.style.color === 色板.GREEN && 交.props.style.borderColor === 色板.GREEN,
        '② 已交卷任务徽章给完成绿 GREEN', JSON.stringify(交 && 交.props.style)));
      passed.push(check(!!纳 && 纳.props.style.color === 色板.GREEN && 纳.props.style.borderColor === 色板.GREEN,
        '② 已采纳任务徽章给完成绿 GREEN', JSON.stringify(纳 && 纳.props.style)));
    }
    {
      const view = sampleView();
      改状态(view, 't-1', '已派发');
      const r = await renderView(view);
      const 徽 = 状态徽章(卡(r, '把工作台投影接上客户端'));
      passed.push(check(!!徽 && 徽.props.style.color === 色板.BRAND,
        '② 已派发任务徽章同给进行色 BRAND', JSON.stringify(徽 && 徽.props.style)));
    }
    // ② 灰态家族：待派发 / 已结账 / 未验 / 缺失（画「未知」）/ 白名单外 —— 一个都不许画成好态。
    {
      const view = sampleView();
      改状态(view, 't-1', '待派发');
      改状态(view, 't-2', '已结账');
      改状态(view, 't-3', '未验');
      const r = await renderView(view);
      const 灰们 = [卡(r, '把工作台投影接上客户端'), 卡(r, '校准策略引擎的拒绝理由'), 卡(r, '审计档位分级落地')]
        .map(状态徽章);
      passed.push(check(灰们.every((b) => !!b && b.props.style.color === 色板.灰
        && b.props.style.color !== 色板.GREEN && b.props.style.color !== 色板.BRAND),
        '② 待派发/已结账/未验徽章保灰（未验不是好态）',
        JSON.stringify(灰们.map((b) => b && b.props.style.color))));
    }
    {
      const view = sampleView();
      改状态(view, 't-1', undefined);
      改状态(view, 't-2', '异维度状态');
      // 'constructor' 是**原型链键**：字面量查表 `表[k]` 对它返回 truthy 函数（toString/__proto__ 同族），
      // 能绕过「查表 miss ⇒ 保灰」的分支——白名单外最险的一类值，必须跟普通外来词一起钉死。
      改状态(view, 't-3', 'constructor');
      const r = await renderView(view);
      const 未知徽 = 状态徽章(卡(r, '把工作台投影接上客户端'));
      const 外来徽 = 状态徽章(卡(r, '校准策略引擎的拒绝理由'));
      const 原型徽 = 状态徽章(卡(r, '审计档位分级落地'));
      passed.push(check(!!未知徽 && 未知徽.props.style.color === 色板.灰 && textOf(未知徽) === '未知',
        '② 状态缺失（显示「未知」）徽章保灰——缺数据不是好态', JSON.stringify(未知徽 && 未知徽.props.style)));
      passed.push(check(!!外来徽 && 外来徽.props.style.color === 色板.灰,
        '② 白名单外状态值徽章保灰', JSON.stringify(外来徽 && 外来徽.props.style)));
      passed.push(check(!!原型徽 && 原型徽.props.style.color === 色板.灰,
        '② 原型链键（constructor 等）徽章保灰——查表不得命中继承属性',
        JSON.stringify(原型徽 && 原型徽.props.style)));
    }
    // ⑤ 判据值：类名 + title 全文 + 样式表里的两行限行规则（读真注入的 style 元素，不是源码正则）。
    {
      const r = await renderView(sampleView());
      const 值 = 判据值(卡(r, '把工作台投影接上客户端'));
      passed.push(check(!!值 && String(值.props.className).split(/\s+/).indexOf('dshmind-criteriaVal') >= 0,
        '⑤ 判据值挂 dshmind-criteriaVal 类名', String(值 && 值.props.className)));
      passed.push(check(!!值 && 值.props.title === '刷新后可见实时状态',
        '⑤ 判据值带 title 全文（截断不丢信息）', String(值 && 值.props.title)));
      const 样式 = r.elements.find((el) => el.type === 'style');
      const 规则体 = 样式 ? (Array.isArray(样式.props.children) ? 样式.props.children.join('') : String(样式.props.children)) : '';
      passed.push(check(/\.dshmind-criteriaVal\{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden\}/.test(规则体),
        '⑤ 样式表注入两行限行规则（-webkit-line-clamp:2）', 规则体.slice(0, 0)));
    }
    // ⑤ 缺失分支：占位文案照画，但不挂 title（占位不是可展开的信息）。
    {
      const view = sampleView();
      view.任务.节点.find((n) => n.id === 't-1').判据 = [];
      const r = await renderView(view);
      const 值 = 判据值(卡(r, '把工作台投影接上客户端'));
      passed.push(check(!!值 && 值.props.title === undefined && textOf(值).indexOf('（缺失') >= 0,
        '⑤ 判据缺失占位分支不挂 title', JSON.stringify(值 && 值.props.title)));
    }
  }

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
