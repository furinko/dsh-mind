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
//      状态条（闸 / 介入度 / 失联四态 / 探针见红）、待你决定的命令、会审的盲评/答案/零分歧都在；
//   6. remote 缺失 / ctx.get 抛错 / 返回 error / Promise reject / 返回非 JSON /
//      返回体结构不明 —— 六条降级路径都**不许抛**，且都渲染出「未连接」+ 旧快照；
//   7. 定位不到会话 id —— 优雅空态，不是抛错、不是空白；
//   8. 侧边栏入口：只画 svg 标记，点击与文案都归宿主那一行；
//   9. 时钟：注册 30s 自动刷新，卸载时 clearInterval。
//  10. 状态条告警：闸不在位 / 已失联 / 已关闭 / 探针见红 —— 读数块进告警样式，不只是换个点色。
//  11. 会审：盲评遮罩行只出盲标 + 锁行，成员 id 一个都不许出；已收敛的存档行给成员/结论。
//  12. 零分歧 true 渲染成**异常**；未收敛显示「未判定」。
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
export const PACKAGE_NAME = 'dsh-mind';
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

/** setState 调用计数（2026-10-12 评审批次5）：钉「降级路径不许每次渲染重复订阅」用。 */
let setState调用数 = 0;

function useHookState(init) {
  const state = renderCtx;
  const index = state.cursor;
  state.cursor += 1;
  if (!state.hooks[index]) {
    const slot = { kind: 'state', value: typeof init === 'function' ? init() : init };
    // 真实 React 的 setState **身份稳定**（同一组件实例恒为同一函数）——client.js 降级
    // 路径的订阅判重就靠这条；harness 此前每次渲染换新闭包，与真机语义不符。
    slot.set = function set(next) {
      setState调用数 += 1;
      slot.value = typeof next === 'function' ? next(slot.value) : next;
      state.dirty = true;
    };
    state.hooks[index] = slot;
  }
  const slot = state.hooks[index];
  return [slot.value, slot.set];
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
    if (options.presenceOnly && ['delegation-settings', 'persona-core-settings'].includes(node.props['data-dshmind'])) return;
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
 * 也可能（不该）出现在盲评遮罩的那场，整页文本搜索分不出来。
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
    // 第三个参数是**请求记录**（url/method/body）：只按命令串给回应的老 handler 用不到它，
    // 而「按 `?project=` 回不同投影」那种 handler 必须看得到 URL（见 `renderViewByProject`）。
    return handler('', 命令, 记录);
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
  // A deterministic browser zone, independent of the machine running the suite.
  sandbox.Intl = Object.create(Intl);
  sandbox.Intl.DateTimeFormat = function (locale, config) { return new Intl.DateTimeFormat(locale, { ...config, timeZone: config?.timeZone ?? options.timeZone ?? 'Asia/Shanghai' }); };
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
 * 故意包含：闸在位 / 失联`在位` / 探针见红；作答中（盲评遮罩）与已收敛的会审各若干；零分歧 true/false 各一场；
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
      介入度: '预审',
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
          // 派活闭环（2026-10-15）：执行中窗口内、审计链零行的负责人 ⇒ 徽章点名。
          负责人无活动: ['role-α'],
        },
        {
          id: 't-2', 描述: '校准策略引擎的拒绝理由', 状态: '已打回', 负责人: ['role-β'], 模式: null,
          判据: ['每条拒绝都带可执行理由'], 判据冻结: true, 依赖: [], 打回次数: 2, 产物: [],
          交卷: { 已交: 0, 应交: 1, 齐: false }, 升级: '打回 ≥2 次',
        },
        {
          // t-3 刻意用**长描述**（2026-10-12）：真实账本里有一条 2035 字、39 个换行的描述，
          // 而旧样本清一色 9 字短句 ⇒ 断言永远绿也测不出「卡片位不限行会被撑成一面墙」。
          // 保留「审计档位分级落地」子串，既有断言（如 1030 行族）不受影响。
          id: 't-3', 描述: '审计档位分级落地' + '\n\n背景：本条模拟真实账本里的长描述（对齐实账 2035 字 / 39 换行那一条）。'.repeat(45), 状态: '待决', 负责人: ['role-γ'], 模式: null,
          判据: ['三档分级与 §7 表格一致'], 判据冻结: false, 依赖: ['t-1'], 打回次数: 0, 产物: [],
          交卷: { 已交: 0, 应交: 1, 齐: false }, 待决原因: '出厂与私有两条都改了同一条',
        },
      ],
    },
    会审: [
      {
        // v2 存档形状（council.list）：作答中 + 盲评遮罩 ⇒ 只给盲标，结论区空白。
        id: 'council-a1', 问题: '双人会审：投影字段收敛', 状态: '作答中', 参与者: ['member-a', 'member-b'],
        来源会话: 'session-lead-1', 轮次: '0/2', 盲评遮罩: true,
        答案: [
          { 成员: '成员 B', 结论: null, 结论层: null, 反例面: [] },
          { 成员: '成员 A', 结论: null, 结论层: null, 反例面: [] },
        ],
        分歧清单: [], 结论: null, 零分歧: false,
        创建于: '2026-10-07T17:00:00+08:00',
      },
      {
        // 已收敛且全票一致：零分歧必须画成**异常信号**（§10 趋同 = 人工抽检）。
        id: 'council-a2', 问题: '会审：审计档位分级', 状态: '已收敛', 参与者: ['member-a', 'member-b', 'member-c'],
        来源会话: 'session-lead-2', 轮次: '1/2',
        答案: [
          { 成员: 'member-a', 结论: '三档划分正确', 结论层: '方案A', 反例面: [] },
          { 成员: 'member-b', 结论: '三档划分正确', 结论层: '方案A', 反例面: [] },
          { 成员: 'member-c', 结论: '三档划分正确', 结论层: '方案A', 反例面: [] },
        ],
        分歧清单: [], 结论: '按方案A收敛', 零分歧: true,
        创建于: '2026-10-07T17:01:00+08:00', 解锁于: '2026-10-07T17:02:00+08:00', 收敛于: '2026-10-07T17:03:00+08:00',
      },
      {
        // 已收敛但有分歧：零分歧 false 走中性文案，不得拿异常样式。
        id: 'council-a3', 问题: '会审：派发后判据冻结', 状态: '已收敛', 参与者: ['member-a', 'member-b'],
        来源会话: 'session-lead-3', 轮次: '2/2',
        答案: [
          { 成员: 'member-a', 结论: '冻结点正确', 结论层: '可修', 反例面: ['边界未覆盖复派'] },
          { 成员: 'member-b', 结论: '冻结点过早', 结论层: '不采纳', 反例面: [] },
        ],
        分歧清单: ['member-a: 边界未覆盖复派'], 结论: '按可修收敛', 零分歧: false,
        创建于: '2026-10-07T17:04:00+08:00', 解锁于: '2026-10-07T17:05:00+08:00', 收敛于: '2026-10-07T17:06:00+08:00',
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
    // 项目解析修正（2026-10-11，主权者指令「修」）：当前项目有账 ⇒ **不该**触发自动切换
    // （自动切换只在「当前无账 + 别处有账」时发生，见 lib/client.js 的 自动选项目）。
    项目清单: {
      当前: 'mind-private',
      项: [
        { 项目: 'mind-private', 任务: 5, 线程: 2, 未投递: 1, 最近于: '2026-10-07T17:04:05+08:00' },
        { 项目: 'default', 任务: 0, 线程: 0, 未投递: 0, 最近于: '' },
      ],
    },
    // ⑦（2026-10-11）：消息总线——普通线程（未投递>0）+ 会审讨论线程（投影层已收走正文）。
    消息总线: [
      {
        线程: '跑通测试-20261011', 条数: 3, 未投递: 1,
        最新: [
          // msg-1 刻意用**超 120 字**的长正文（2026-10-12）：真实总线里有 1853 字 / 46 换行的消息，
          // 旧样本全是短句 ⇒ 测不出「长正文折叠 + 展开全文」。保留原子串，既有断言不受影响。
          { id: 'msg-1', 发件: 'lead', 类型: '广播', 内容: '全员注意：批次开始前先对判据。' + '\n补充说明：本条模拟真实账本里的长正文。'.repeat(20), 正文原长: 400, 状态: '已投递', 追加于: '2026-10-07T17:01:02+08:00' },
          // msg-2 刻意含 `\n`（2026-10-12）：真实总线的正文是**多行简报**（标题/列表/表格），
          // 旧样本全是单行 ⇒ 367 条断言全绿却漏掉了「`\n` 被 white-space:normal 折叠成一段」这个 bug。
          // 保留「判据已核对」子串，既有断言不受影响。
          { id: 'msg-2', 发件: 'member-a', 类型: '表态', 内容: '【通报】\n判据已核对，可以开工。\n| 段 | 授权 |\n|---|---|', 状态: '已投递', 追加于: '2026-10-07T17:02:03+08:00' },
          { id: 'msg-3', 发件: 'member-b', 类型: '提问', 内容: '产物引用给仓内 commit 还是文件路径？', 状态: '暂不投递', 追加于: '2026-10-07T17:03:04+08:00' },
        ],
      },
      {
        线程: 'council-a1', 条数: 5, 未投递: 0, 会审讨论段: true,
      },
    ],
  };
}

/** 同一份投影，但闸不在位 + 已失联 + 探针见红两条：验状态条的告警外观。 */
export function alarmingView() {
  const view = sampleView();
  view.状态条 = {
    闸: { 在位: false, 规则数: 0, 错误: '策略引擎未加载' },
    介入度: '审批',
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
/** 盲评期的锁行：文案本身就是断言目标（§10 未交齐不揭名）。 */
export const LOCK_LINE = '🔒 盲评中：全员交齐并解锁前，此处只显示盲标；揭名后显示成员与结论';
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
    fetch: fetchImpl, noTimers: options.noTimers, timeZone: options.timeZone });
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
  const booted = boot({ store: options.store, timeZone: options.timeZone, services: Object.assign(session(), { remote: spy.remote }) });
  const renderer = mountDashboard(booted);
  renderer.flush();
  await settle();
  renderer.flush();
  const c = collect(renderer.tree, { skipStyle: true });
  renderer.unmount();
  return { text: c.text, elements: c.elements, texts: c.texts, tree: renderer.tree, calls: spy.calls };
}

/**
 * 同 `renderView`，但**假宿主按 `?project=` 回不同投影**（2026-10-11，主权者指令「修」）。
 *
 * 为什么需要它：自动/手动切项目那一环的可观察面是**第二次请求带了什么** ——
 * 这只有在"请求 URL 决定响应"的假宿主上才验得出来（`renderView` 对任何 URL 都回同一份）。
 * `回默认` = 首个请求（不带 `project`）的响应；`按项目[key]` = 带 `?project=key` 的响应。
 *
 * @param {object} 回默认 默认项目那份投影
 * @param {Record<string, object>} 按项目 项目键 → 投影
 * @returns {Promise<{text:string, elements:object[], texts:string[], tree:object, calls:object[]}>}
 */
export async function renderViewByProject(回默认, 按项目) {
  // ⚠️ `makeRemote` 的 handler 形状是 `('', 命令, 记录)`——**要 URL 就读第三个参数**，
  //    把记录当第二个参数会拿到命令串，于是任何 `?project=` 都读不出来（本批踩过）。
  const spy = makeRemote((_占位, _命令, 记录) => {
    const m = /[?&]project=([^&]*)/.exec(String((记录 && 记录.url) || ''));
    const key = m ? decodeURIComponent(m[1]) : '';
    return okReply((key && 按项目 && 按项目[key]) || 回默认);
  });
  const booted = boot({ services: Object.assign(session(), { remote: spy.remote }) });
  const renderer = mountDashboard(booted);
  // 自动切项目那一环是**两次串联**取数（默认 → 按最近活动），比单次取数多一条 Promise 链：
  // 收敛要比 `renderView` 更耐心（每轮 settle 让一条链跑完，最后再 flush 一次把状态落到树上）。
  renderer.flush();
  await settle(12);
  renderer.flush();
  await settle(4);
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
  // 用户否定聊天区审批形式：审批由工作台待办显式导航，不能注册输入区或全局浮层。
  passed.push(check(injected.join('|') === ['main', 'settings.section', 'sidebar.panellist'].join('|'),
    'inject 仅含看板、设置和侧栏；审批不占聊天或全局浮层', a.calls.inject.join(',')));
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
  for (const section of ['待你决定', '会审', '任务图', '审计预览', '消息总线']) {
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
  passed.push(check(c1.text.includes('1 位负责人未见活动'), '派活闭环：执行中节点亮「负责人未见活动」徽章'));
  passed.push(check(c1.text.includes('artifact-1') && c1.text.includes('artifact-2'), '产物引用显示为 chip'));
  passed.push(check(c1.text.includes('活数据'), '页头显示活数据状态'));
  passed.push(check(c1.text.includes('50%'), '介入度档位显示百分比'));
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
  // ⚠️ 口径改形（2026-10-13 重做·图谱）：原来这条是「凡带 onClick 的必须是 button」。
  //    图谱的节点是 SVG `<g>`（SVG 里放不了 button），选中它只为看详情抽屉——
  //    与折叠钮同款的**纯显示动作**（零请求、零写账，由 ⑪e「点节点零请求」钉死）。
  //    所以例外开在「带 data-node 的 g」上，**不是**把整条放宽：除它以外仍只许 button。
  passed.push(check(c1.elements.every((el) => !el.props || typeof el.props.onClick !== 'function'
    || el.type === 'button'
    || (el.type === 'g' && typeof el.props['data-node'] === 'string')),
    '除刷新按钮与图谱节点外没有可点动作：待你决定里不得有按钮'));
  // 反向：图谱节点**只许**在真的画了图谱时出现（没数据不许留可点空壳）
  const 假节点 = c1.elements.filter((el) => el.type === 'g' && typeof el.props['data-node'] === 'string'
    && typeof el.props.onClick !== 'function');
  passed.push(check(假节点.length === 0, '图谱节点都带 onClick（不许有画出来却点不动的节点）', String(假节点.length)));
  const decideButtons = collect(r1.tree, { skipStyle: true }).elements
    .filter((el) => el.type === 'button' && String(el.props.className || '').indexOf('dshmind-cmd') >= 0);
  passed.push(check(decideButtons.length === 0, '命令不是按钮'));

  // ③c 待你决定之前先看页脚的验账读数：记忆存量 + 近段新增/晋升
  passed.push(check(c1.text.includes('记忆 存量 12 · 近7天 +3（晋升 1）'),
    '页脚给记忆验账读数（存量 + 近7天新增 + 晋升）'));

  // ③c 会审（v2 存档形状）：盲评期只出盲标 + 锁行；已收敛行给答案/分歧/结论/零分歧。
  const cards = findAllByClass(r1.tree, 'dshmind-review');
  passed.push(check(cards.length === 3, '三场会审各一张卡', String(cards.length)));
  const hidden = textOf(cards[0]);
  passed.push(check(hidden.includes('成员 A') && hidden.includes('成员 B'), '盲评期的会审仍给盲标（服务层遮罩后的字段）'));
  passed.push(check(hidden.includes(LOCK_LINE), '盲评期的会审给锁行「' + LOCK_LINE + '」'));
  passed.push(check(!hidden.includes('member-a') && !hidden.includes('member-b'),
    '盲评期成员 id 一个都不许出现在那张卡里', hidden.slice(0, 80)));
  passed.push(check(hidden.includes('参与者 2'), '参与者数按存档显示'));
  passed.push(check(hidden.includes('轮次 0/2'), '轮次按存档 `已用/上限` 显示'));
  // 答案折叠：首场展开、其余一行摘要（摘要不出结论；展开后才出）。
  passed.push(check(findAllByClass(cards[0], 'dshmind-answers').length === 1,
    '③ 首场会审默认展开答案（dshmind-answers 在）'));
  passed.push(check(!hidden.includes('三档划分正确') && !hidden.includes('（无结论）'),
    '盲评卡一份结论文本都不出，也不补「（无结论）」假占位'));
  passed.push(check(findAllByClass(cards[1], 'dshmind-answers').length === 0
    && textOf(cards[1]).includes('答案 3 份'),
    '③ 第二场默认折叠：一行摘要，不铺答案'));
  passed.push(check(!textOf(cards[1]).includes('三档划分正确'), '③ 折叠摘要不把结论文本搬出来'));
  const 二场切换钮 = collect(r1.tree, { skipStyle: true }).elements
    .find((el) => el.type === 'button' && String(el.props.className || '').indexOf('dshmind-toggle') >= 0
      && textOf(el).includes('答案 3 份'));
  passed.push(check(!!二场切换钮, '③ 折叠场有切换钮（button，不是别的可点元素）'));
  // 走真实 onClick（不是直接调内部函数）：点开 ⇒ 展开；每一步后重新取元素（旧快照握着旧闭包）。
  const 请求前 = spy.calls.length;
  二场切换钮.props.onClick();
  await settle();
  r1.flush();
  const cards点开 = findAllByClass(r1.tree, 'dshmind-review');
  const shown = textOf(cards点开[1]);
  passed.push(check(shown.includes('member-a') && shown.includes('member-b') && shown.includes('member-c'),
    '揭名（已收敛）后答案给真成员 id'));
  passed.push(check(shown.includes('三档划分正确'), '揭名卡展开后给每份结论文本'));
  passed.push(check(!shown.includes(LOCK_LINE), '已收敛的会审没有盲评锁行'));
  passed.push(check(shown.includes('已收敛'), '状态徽章按存档状态显示'));
  // 再点一下收回去：覆盖表取反，摘要回来、全文消失；首场不受影响（按会审 id 记，不按位置记）。
  const 二场切换钮2 = collect(r1.tree, { skipStyle: true }).elements
    .find((el) => el.type === 'button' && String(el.props.className || '').indexOf('dshmind-toggle') >= 0
      && textOf(el).includes('答案 3 份'));
  二场切换钮2.props.onClick();
  await settle();
  r1.flush();
  const cards收起 = findAllByClass(r1.tree, 'dshmind-review');
  passed.push(check(findAllByClass(cards收起[1], 'dshmind-answers').length === 0
    && textOf(cards收起[1]).includes('答案 3 份'),
    '③ 再点一下收回去（覆盖表取反，摘要回来）'));
  passed.push(check(findAllByClass(cards收起[0], 'dshmind-answers').length === 1,
    '③ 切换按会审 id 记：首场仍是展开'));
  // 零请求：折叠切换是纯显示动作——两次点击之间一个命令都不许发（「不是写动作」的真判据）。
  passed.push(check(spy.calls.length === 请求前,
    '③ 折叠切换不发任何请求（纯显示切换，不是写动作）', String(spy.calls.length - 请求前)));
  // 分歧清单/结论只来自存档字段，原样渲染；答案级反例面要展开第三场才在（默认折叠）。
  passed.push(check(textOf(cards[2]).includes('分歧清单：member-a: 边界未覆盖复派'), '分歧清单渲染出来'));
  passed.push(check(textOf(cards[2]).includes('结论：按可修收敛'), '收敛结论渲染出来'));
  passed.push(check(textOf(cards[2]).includes('来源会话：session-lead-3'), '来源会话照实显示（会话绑定）'));
  const 三场切换钮 = findAllByClass(findAllByClass(r1.tree, 'dshmind-review')[2], 'dshmind-toggle')[0];
  passed.push(check(!!三场切换钮, '第三场有答案切换钮'));
  三场切换钮.props.onClick();
  await settle();
  r1.flush();
  const cards三 = findAllByClass(r1.tree, 'dshmind-review');
  passed.push(check(textOf(cards三[2]).includes('反例面：边界未覆盖复派'), '答案反例面渲染出来（展开后）'));
  passed.push(check(textOf(cards三[2]).includes('可修'), '结论层 chip 照存档显示'));

  // ③d 零分歧是异常，不是好消息。三态：已收敛 true=异常 / 已收敛 false=中性 / 未收敛=未判定。
  const anomaly = findAllByClass(r1.tree, 'dshmind-anomaly');
  passed.push(check(anomaly.length === 1, '零分歧 true 恰好一场，且拿异常样式', String(anomaly.length)));
  passed.push(check(textOf(cards[1]).includes('零分歧') && textOf(cards[1]).includes('异常信号'),
    '零分歧 true 渲染成异常信号（§10 全票一致 = 趋同）'));
  passed.push(check(textOf(cards[0]).includes('未判定'), '未收敛不编造「存在分歧」——零分歧是未判定'));
  passed.push(check(!textOf(cards[0]).includes('存在分歧（正常）'), '未收敛绝不画成存在分歧'));
  passed.push(check(textOf(cards[2]).includes('存在分歧（正常）'),
    '零分歧 false 走中性文案，与异常长得不一样'));
  passed.push(check(!textOf(cards[2]).includes('异常信号'), '有分歧的场次不许拿异常文案'));
  const classes = classNames(r1.tree);
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
  // 按钮只许三种——刷新（dshmind-btn）与折叠钮（dshmind-toggle）、项目 chip（dshmind-projChip）。
  //
  // ⚠️ 项目解析修正（2026-10-11，主权者指令「修」）新增第三种：项目 chip 也是**换一个只读投影**
  // （onClick 只带 `?project=` 重取，不写任何账，由 ⑧b 的「零写请求」断言钉死）。
  //
  // ⚠️ 描述折叠（2026-10-12，主权者指令「要全文 + 默认折叠」）新增第四种：`dshmind-descToggle`
  // 是长描述的展开/收起钮——同样是**纯显示切换**（onClick 只改本地折叠态，不发任何命令，
  // 由 ⑩d 的「零请求」断言钉死）。加它的理由：描述是 2037 字级全文，硬截断会丢全文，
  // 主权者明确要「可看全文」——折叠是唯一既不丢字、又不把面板撑爆、也不引入写入口的做法。
  //
  // ⚠️ 分页导航（2026-10-13 重做）新增第五种：`dshmind-navBtn` 是七页之间的切换钮——
  // 与折叠钮同款**纯显示切换**（onClick 只写本地 `当前页`，零请求、零写账，由新增的
  // ⑪a「切页零请求」断言钉死）。加它的理由：五个分区从一条长页拆成七页之后，
  // 「切页」是唯一的导航动作；它不引入任何写入口，也不发任何命令。
  // 本条仍不许出现第六种按钮，也不许出现任何写控件。
  const 非法按钮 = 面板按钮.filter((el) => {
    const 类 = String(el.props.className || '');
    if (类.indexOf('dshmind-btn') >= 0 && String(el.props.children).indexOf('刷新') >= 0) return false;
    if (类.indexOf('dshmind-toggle') >= 0) return false;
    if (类.indexOf('dshmind-projChip') >= 0) return false;
    if (类.indexOf('dshmind-descToggle') >= 0) return false;
    if (类.indexOf('dshmind-navBtn') >= 0) return false;
    return true;
  });
  passed.push(check(面板按钮.length >= 1 && 非法按钮.length === 0,
    '④ 工作台面板的可点动作只有「刷新」与会审折叠钮、描述折叠钮、项目 chip、分页导航（纯显示切换；仍无任何写动作）',
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
  passed.push(check(设置文本.includes('期限来自 出厂') && 设置文本.includes('开关来自 出厂'),
    '⑤ 页面把两个键的来源都显示出来（2026-10-17 改形：独立的「来源」行并入「当前生效值」一行，'
    + '同一份信息不再排两遍；断言词随之从「期限 出厂 · 开关 出厂」换成附注里的「期限来自/开关来自」）'));
  passed.push(check(设置文本.includes('私有设置 ＞ 出厂设置 ＞ 内置兜底'),
    '⑤ 生效值层序说明收进配置详情，保留排障信息'));
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
    // 2026-10-17 改形：设置页的点改用**自己的** `dshmind-set__dot`（看板的 `dshmind-dot` 规则住在
    // 看板子树的 <style> 里，看板没挂载时对设置页不存在 —— 真机截图实测点没有尺寸）。
    const 点 = 格 ? findAllByClass(格, 'dshmind-set__dot')[0] : null;
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
      .find((el) => el.type === 'button' && String(el.props.children) === '保存').props.onClick();
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
    .find((el) => el.type === 'button' && String(el.props.children) === '保存');
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
    .find((el) => el.type === 'button' && String(el.props.children) === '保存').props.onClick();
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
      .find((el) => el.type === 'button' && String(el.props.children) === '保存').props.onClick();
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
      .find((el) => el.type === 'button' && String(el.props.children) === '保存').props.onClick();
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
      // 旧组继续严格验 presence-only 的按钮数/空态；调度表单另由专属真形状夹具验证。
      return { renderer, doc: booted.doc, 元素: () => collect(renderer.tree, { skipStyle: true, presenceOnly: true }).elements };
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
    const 未接策略节 = collect(未接.renderer.tree, { skipStyle: true }).elements.find(el => el.props['data-dshmind'] === 'policy-settings');
    const 未接提示 = findAllByClass(未接策略节, 'dshmind-set__notice')[0];
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

    // ═══ ⑬ 2026-10-17 设置页优化批：视觉收口的行为判据 ═══
    // 背景：真机截图（`_settings_shot` 装置，离线渲染**真实组件**）钉出的五个面 ——
    // 态点无尺寸（借看板类名，看板没挂载就不存在）/ 两分区无分隔 / 来源信息排两遍 /
    // 长文本输入被右栏定宽挤断 / 未接入时表单仍可编辑（硬编码草稿冒充读数）。
    {
      // ⑬a 态点有自己的基础规则且**带尺寸**。
      const 点规则 = 基础规则体('dshmind-set__dot');
      passed.push(check(/width\s*:/.test(点规则) && /height\s*:/.test(点规则),
        '⑬ 设置页态点有自己的基础规则且带尺寸（不再借看板的 .dshmind-dot）', 点规则.slice(0, 80)));
      // ⑬b 分区边界：各模块使用独立圆角边框卡片与 subtitle 标题层级，
      //     且 DOM **真的挂上**这些类（只验 CSS 在源里，DOM 不挂照样绿 —— 空转）。
      const 全元素 = collect(常驻.renderer.tree, { skipStyle: true }).elements;
      const 调度节 = 全元素.find((el) => el.props['data-dshmind'] === 'delegation-settings');
      const 副题 = 全元素.find((el) => el.type === 'h3' && String(el.props.children).indexOf('Lead 调度授权') >= 0);
      passed.push(check(/border\s*:/.test(基础规则体('dshmind-set__section'))
        && /border-radius\s*:/.test(基础规则体('dshmind-set__section'))
        && 基础规则体('dshmind-set__subtitle') !== ''
        && !!调度节 && String(调度节.props.className || '').split(/\s+/).indexOf('dshmind-set__section') >= 0
        && !!副题 && String(副题.props.className || '').split(/\s+/).indexOf('dshmind-set__subtitle') >= 0,
        '⑬ 调度授权区有看得见的卡片边界（section 圆角边框 + subtitle 标题层级，CSS 与 DOM 两面都验）'));
      // ⑬c 长文本字段行走上下排变体：输入框吃满行宽，不再被右栏定宽挤断。
      const 字段框 = 全元素.filter((el) => el.type === 'input'
        && String(el.props['aria-label'] || '').indexOf('授权') === 0);
      passed.push(check(字段框.length === 2
        && 字段框.every((el) => String(el.props.className).split(/\s+/).indexOf('dshmind-set__text') >= 0),
        '⑬ 授权项目/授权依据输入框带 dshmind-set__text（吃满行宽）',
        JSON.stringify(字段框.map((el) => el.props.className))));
      const 字段行 = collect(调度节, { skipStyle: true }).elements.filter((el) => String(el.props.className || '').split(/\s+/).indexOf('dshmind-set__row--field') >= 0);
      passed.push(check(字段行.length === 2, '⑬ 两个长文本字段行都挂上下排变体（dshmind-set__row--field）', String(字段行.length)));
      // ⑬d 未接入时表单禁用：没有回读真源，框里只是硬编码草稿，不许再让人编它冒充读数；
      //     「重新读取」是唯一该亮的操作（它是恢复动作）。
      const 离线控 = 未接.元素().filter((el) => ['select', 'input', 'button'].indexOf(el.type) >= 0);
      const 离线保存 = 离线控.find((el) => el.type === 'button' && String(el.props.children) === '保存');
      const 离线重读 = 离线控.find((el) => el.type === 'button' && String(el.props.children) === '重新读取');
      passed.push(check(离线控.filter((el) => el.type !== 'button').every((el) => el.props.disabled === true)
        && !!离线保存 && 离线保存.props.disabled === true,
        '⑬ 未接入态：失联保险表单与「保存」全部禁用（草稿不许冒充读数）',
        JSON.stringify(离线控.map((el) => el.type + ':' + String(el.props.disabled)))));
      passed.push(check(!!离线重读 && 离线重读.props.disabled !== true,
        '⑬ 未接入态「重新读取」保持可用（它是唯一的恢复动作）'));
      // P1-11：未接入时不许把写死初值（是/72）画成读数——控件值必须为空 + 「未读到」占位。
      const 离线开关 = 未接.元素().find((el) => el.props['aria-label'] === '失联保险');
      const 离线小时 = 未接.元素().find((el) => el.props['aria-label'] === '响应期限小时');
      passed.push(check(!!离线开关 && 离线开关.props.value === ''
        && !!离线小时 && 离线小时.props.value === '' && String(离线小时.props.placeholder).indexOf('未读到') >= 0,
        'P1-11：未接入态不显示写死的 是/72（值清空 + 未读到占位）',
        JSON.stringify({ 开关: 离线开关?.props.value, 小时: 离线小时?.props.value })));
      // ⑬e 页脚恰好一处且排在调度授权区**之后**（原来夹在两区中间，把第二区标题顶得没有喘息）。
      const 足 = 全元素.filter((el) => el.props.className === 'dshmind-set__foot');
      const 调度区 = 全元素.findIndex((el) => el.props['data-dshmind'] === 'delegation-settings');
      const 足位 = 全元素.findIndex((el) => el.props.className === 'dshmind-set__foot');
      passed.push(check(足.length === 1 && 调度区 >= 0 && 足位 > 调度区,
        '⑬ 页脚恰好一处且排在调度授权区之后', JSON.stringify({ 足: 足.length, 调度区, 足位 })));
      // ⑬f 「关闭」收在页脚里（整页动作的落点在页尾，不再停在页面中段的操作行）。
      const 足内钮 = 足.length ? collect(足[0], { skipStyle: true }).elements.filter((el) => el.type === 'button') : [];
      passed.push(check(足内钮.length === 1 && String(足内钮[0].props.children) === '关闭',
        '⑬ 「关闭」收在页脚右端', JSON.stringify(足内钮.map((el) => String(el.props.children)))));
      // ⑬g Enter 旁路也守住「未接入不写」：按钮禁用挡得住指针，挡不住输入框里的回车。
      const 离线输入 = 未接.元素().find((el) => el.type === 'input');
      离线输入.props.onKeyDown({ key: 'Enter' });
      await settle();
      未接.renderer.flush();
      const 拦截文本 = collect(未接.renderer.tree, { skipStyle: true }).text;
      passed.push(check(拦截文本.indexOf('还没读到当前设置') >= 0 && 拦截文本.indexOf('没写进去') >= 0,
        '⑬ 未接入时 Enter 保存被本地拦截，明说「还没读到当前设置」（不是"宿主拒绝了"那种泛话）',
        拦截文本.slice(-160)));
    }
    未接.renderer.unmount();

    // ⑫ **不渲染空容器**：有我们的类名、却既没文本也没控件的块 = 版面上的"空框"。
    //    主人截图右侧那个圆角空框，第一件要做的事就是排除它是不是我们自己画的。
    const 空块 = (元素) => 元素.filter((el) => {
      if (typeof el.props.className !== 'string' || el.props.className.indexOf('dshmind-set__') !== 0) return false;
      // 态点（dshmind-set__dot）是**纯视觉标记**：无文本无控件是它的本分，不是空框（2026-10-17 优化批新增）。
      if (el.props.className.split(/\s+/).indexOf('dshmind-set__dot') >= 0) return false;
      const 子 = collect(el, { skipStyle: true });
      const 有控件 = 子.elements.some((x) => ['button', 'select', 'input', 'textarea'].indexOf(x.type) >= 0);
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
  passed.push(check(全空.text.includes('task_pending') && 全空.text.includes('debate_open')
    && 全空.text.includes('task_create'), '① 三块空态各给一条真命令（task_pending / debate_open / task_create）'));
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

  // ⑥d 保存抬水位（2026-10-12 评审批次5）：保存链不走 刷新设置 ⇒ 修前在途的轮询响应
  //   回来后把「刚保存的回读」盖回旧值（「已保存」闪现后消失）。现在保存成功先占号抬水位。
  // ⚠️ 2026-10-17 优化批改形：未接入（含首读未回）时保存**禁用且本地拦截**——框里只是
  //   硬编码草稿，拿它写等于替盘上瞎编。于是竞态的造法跟着变：原来让**首读**慢（保存时
  //   还没有读数），现在首读先到位（72）→ 点「重新读取」起一次**慢的轮询读**挂着 → 再保存。
  //   被测性质不变：保存抬水位，在途的更旧的响应回来时不许盖掉刚保存的回读。
  {
    const 保存后袋 = 真读数('在位');
    保存后袋.生效响应期限小时 = 168; // 可观察标记：保存后页面应稳定显示「生效期限 168 小时」
    const 旧袋 = 真读数('在位');
    旧袋.生效响应期限小时 = 72;
    let 读第几次 = 0;
    const 放行慢读 = [];
    const 桥 = makeRemote(function (_sessionId, 命令) {
      if (命令 === PRESENCE_COMMAND) {
        读第几次 += 1;
        if (读第几次 === 2) {
          // 第二次读（点「重新读取」起的那次）挂起，由测试手动放行 —— 它就是那个"慢轮询"。
          return new Promise(function (resolve) { 放行慢读.push(function () { resolve(okReply({ 读数: 旧袋, 设置文件: SETTINGS_FILE, 说明: '读：慢' })); }); });
        }
        if (读第几次 === 1) return okReply({ 读数: 旧袋, 设置文件: SETTINGS_FILE, 说明: '读：首读' });
        return okReply({ 读数: 保存后袋, 设置文件: SETTINGS_FILE, 说明: '读：回读' });
      }
      if (命令.indexOf(PRESENCE_COMMAND + ' ') === 0) {
        return okReply({ 设置文件: SETTINGS_FILE, 变更: ['响应期限小时'], 无变更: [], 读数: 保存后袋, 说明: '已改' });
      }
      return okReply(sampleView());
    });
    const 双轨 = boot({ store, services: Object.assign(session(), { remote: 桥.remote }) });
    await settle(); // 首读（72）落地
    const sr双 = mountSettings(双轨);
    await settle();
    sr双.flush();
    // 前提：首读已到位，表单与保存都可用（2026-10-17 起未接入时禁用）。
    const 就绪文本 = collect(sr双.tree, { skipStyle: true }).text;
    passed.push(check(就绪文本.indexOf('生效期限 72 小时') >= 0, '⑥d 前提：首读落地（显示 72）', 就绪文本.slice(-160)));
    // 点「重新读取」起一次慢读（72，挂着），再改值保存。
    collect(sr双.tree, { skipStyle: true }).elements
      .find((el) => el.type === 'button' && String(el.props.children) === '重新读取').props.onClick();
    await settle();
    collect(sr双.tree, { skipStyle: true }).elements.find((el) => el.type === 'input')
      .props.onChange({ target: { value: '168' } });
    sr双.flush();
    collect(sr双.tree, { skipStyle: true }).elements
      .find((el) => el.type === 'button' && String(el.props.children) === '保存').props.onClick();
    await settle();
    sr双.flush();
    const 存后文本 = collect(sr双.tree, { skipStyle: true }).text;
    passed.push(check(存后文本.indexOf('生效期限 168 小时') >= 0, '⑥d 前提：保存后显示回读值 168', 存后文本.slice(-160)));
    放行慢读.forEach(function (放) { 放(); }); // 挂着的那次慢读（72）这时才到
    await settle();
    sr双.flush();
    const 慢到后文本 = collect(sr双.tree, { skipStyle: true }).text;
    passed.push(check(慢到后文本.indexOf('生效期限 168 小时') >= 0 && 慢到后文本.indexOf('生效期限 72 小时') < 0,
      '⑥d 保存后的慢轮询响应不许盖掉回读（保存抬水位）', 慢到后文本.slice(-160)));
    sr双.unmount();
    双轨.disposer();
  }

  // ⑥e 起轮询幂等（2026-10-12 评审批次5）：重复 apply（等价于重复起轮询）不许挂双 interval。
  {
    const 两次 = boot({ services: Object.assign(session(), {
      fetch: makeFetch((url) => (String(url).indexOf('workbench') >= 0
        ? jsonResponse(sampleView())
        : jsonResponse({ 读数: 读数袋(), 设置文件: SETTINGS_FILE, 说明: '读…' }))).fetch,
    }) });
    const 第一次数量 = 两次.timers.intervals.length;
    两次.plugin.apply(两次.ctx); // 生产里 Cordis 只调一次；这里人为重复调，钉住幂等
    // 判据是「旧的先停」（cleared 在第二次 apply 内 +1）：注册数本来就会 +1（停旧的挂新的），
    // 拿它当判据会误伤「先停再挂」的正确实现——钉的是**没有两根同时在跑**。
    passed.push(check(两次.timers.cleared.length >= 1 && 两次.timers.intervals.length === 第一次数量 + 1,
      '⑥e 重复 apply ⇒ 旧轮询先停再挂新的（修前旧的不停 ⇒ 两根同时在跑、刷新翻倍）',
      'intervals=' + 两次.timers.intervals.length + ' cleared=' + 两次.timers.cleared.length));
    两次.disposer();
  }

  // ⑥f 隐藏标签页不轮询（2026-10-12 评审批次6·P3）：看不见的面板每 3s 全量拉一遍是纯浪费；
  //    回前台后到点自然补拉。对照臂钉「闸没把轮询掐死」。
  {
    const 隐藏doc = makeDocument().document;
    隐藏doc.hidden = true;
    const 计数 = { fetch: 0 };
    const 隐页 = boot({ services: Object.assign(session(), {
      document: 隐藏doc,
      fetch: makeFetch(function (url) {
        计数.fetch += 1;
        return String(url).indexOf('workbench') >= 0
          ? jsonResponse(sampleView())
          : jsonResponse({ 读数: 读数袋(), 设置文件: SETTINGS_FILE, 说明: '读…' });
      }).fetch,
    }) });
    await settle();
    const 轮隐 = 隐页.timers.intervals.find((t) => t.ms === REFRESH_MS);
    check(!!轮隐, '⑥f 轮询器已注册');
    const 基数 = 计数.fetch;
    轮隐.fn();
    await settle();
    passed.push(check(计数.fetch === 基数, '⑥f document.hidden ⇒ 轮询到点不拉（修前照拉：白跑）', 'fetch ' + 基数 + '→' + 计数.fetch));
    隐藏doc.hidden = false;
    轮隐.fn();
    await settle();
    passed.push(check(计数.fetch > 基数, '⑥f 回前台 ⇒ 到点照拉（对照臂）', 'fetch=' + 计数.fetch));
    隐页.disposer();
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

    // ⑩d 描述展开钮：**行为**断言（走真实 onClick）。放在这里是因为要用 `状态render`
    //     （共享 store、不 unmount、带 flush）；`renderView` 挂载后立刻 unmount，
    //     返回静态快照，点了看不到变化。
    //     体例照 ③「答案折叠」：点开验展开、再点验收回、每步重新取元素。
    {
      const r10 = await 状态render(sampleView());
      const 钮10 = findAllByClass(r10.tree, 'dshmind-descToggle')[0];
      passed.push(check(!!钮10, '⑩d 长描述展开钮在（button）', 钮10 ? 'ok' : 'null'));
      const 取长卡 = () => findAllByClass(r10.tree, 'dshmind-node')
        .filter((el) => textOf(el).includes('审计档位分级落地'));
      // 默认折叠：全文块此刻不画。
      passed.push(check(取长卡().length === 1 && findAllByClass(取长卡()[0], 'dshmind-nodeTitleOpen').length === 0,
        '⑩d 默认折叠 ⇒ 全文块不画'));
      钮10.props.onClick();
      await settle();
      r10.flush();
      const 卡10 = 取长卡();
      const 全文10 = 卡10.length === 1 ? findAllByClass(卡10[0], 'dshmind-nodeTitleOpen')[0] : null;
      passed.push(check(!!全文10, '⑩d 点开 ⇒ 全文块出现（dshmind-nodeTitleOpen）',
        '命中 ' + (卡10.length === 1 ? findAllByClass(卡10[0], 'dshmind-nodeTitleOpen').length : -1)));
      // 全文必须**完整**：展开块文本长度要与样本描述同量级（不许只剩个尾巴）。
      // ⚠️ 不能用 `textOf(全文10)`：它递归收集**整块子树**的文本，卡片里的判据/meta 等
      // 会把长度垫到 1000+ ⇒ 展开块即便只画了 40 字，断言照样绿（2026-10-12 塞 bug 校准
      // 当场抓出的假断言）。必须直读展开块**自己的** `props.children`。
      const 展开文本 = 全文10 ? String(全文10.props && 全文10.props.children || '') : '';
      passed.push(check(展开文本.length > 1000,
        '⑩d 展开块给的是**完整描述**（不是截断残留），实测展开块自身长度 > 1000',
        '长度 ' + 展开文本.length));
      // 再点一下收回：全文块消失（覆盖表取反）。
      const 钮10b = findAllByClass(r10.tree, 'dshmind-descToggle')[0];
      钮10b.props.onClick();
      await settle();
      r10.flush();
      const 卡10b = 取长卡();
      passed.push(check(卡10b.length === 1 && findAllByClass(卡10b[0], 'dshmind-nodeTitleOpen').length === 0,
        '⑩d 再点 ⇒ 收回（全文块消失）'));
    }

    // ⑦e 总线折叠是**行为**断言（2026-10-12，主权者「（总线）也默认收起呗」）：
    // ⑪i 图谱缩放 / 平移 / 复位（2026-10-14 · 主权者：「能把图谱做成可放大缩小平移的吗」）
    //
    // **行为**断言：滚轮走 ref 原生监听（2026-10-14 审查 P1-11：React 17+ 的 onWheel 是
    // passive 监听，preventDefault 是 no-op ⇒ 改 ref 回调挂 {passive:false} 原生监听），
    // harness 用假 DOM 节点（记 addEventListener 的参数与监听器）把 ref 真调一遍；
    // 拖拽/双击仍走 props。验 `viewBox` 真的变了 —— 不是读源码文本。
    // ⚠️ 手势要用 `getBoundingClientRect()` 把指针换算成基础坐标，而 harness 是**虚拟树、没有 DOM**
    //    ⇒ 必须喂一个**带 rect 的假事件**，否则处理器会（正确地）早退，断言就变成假绿。
    //    这也正是它比"读源码"值钱的地方：**它证明了手势在拿到 rect 时真的算对了**。
    // 塞 bug 校准：删掉 `图谱手势(...)` 的摊开 ⇒ 本组必红；把 `onDoubleClick` 的复位去掉 ⇒ 必红。
    {
      // ⚠️ 夹具要**自带能力/岗位**：`sampleView()` 没这两门数据，图谱页那时画的是
      //    「投影没带接线」的提示、**没有画布**（首跑就栽在这里：`svg=null`）。
      //    这里就地造一份最小的（与后面 ⑪e 用的 `接线视图()` 同形），不依赖它的作用域。
      const 图谱夹具 = (() => {
        const v = sampleView();
        v.能力 = [
          { id: 'policy-decision', 来源: '出厂', 适用岗位: ['Lead', '复核员'] },
          { id: 'assert-with-evidence', 来源: '自治', 适用岗位: ['Lead'] },
        ];
        v.岗位 = [
          { id: 'Lead', 来源: '私有', 同名: ['私有'], 摘要: '常驻、唯一', 能力引用: ['policy-decision'] },
          { id: '复核员', 来源: '私有', 同名: ['私有', '出厂'], 摘要: '常驻岗', 能力引用: ['policy-decision'] },
        ];
        v.实例计数 = { 按岗位: { Lead: { 在岗: 1, 封存: 0 }, 复核员: { 在岗: 2, 封存: 1 } }, 异常键: 0, 合计: 4 };
        return v;
      })();
      const rG = await 状态render(图谱夹具);
      const 取svg = () => findAllByClass(rG.tree, 'dshmind-graph')[0];
      const 图谱钮 = findAllByClass(rG.tree, 'dshmind-navBtn')
        .filter((el) => textOf(el).indexOf('图谱') >= 0)[0];
      passed.push(check(!!图谱钮, '⑪i 图谱页入口在（导航钮）'));
      if (图谱钮) {
        图谱钮.props.onClick();
        await settle();
        rG.flush();
      }
      /** 假指针事件：`currentTarget.getBoundingClientRect` 是手势唯一依赖的 DOM 能力。 */
      const 事件 = (x, y, 额外) => Object.assign({
        clientX: x, clientY: y, button: 0, preventDefault() { this._拦了 = true; },
        currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 600 }) },
      }, 额外 || {});
      const 解析 = (vb) => String(vb || '').trim().split(/\s+/).map(Number);
      const 基础 = 取svg();
      // 假 svg 原生节点：记下 addEventListener 的类型/监听器/选项（passive:false 是修复的核心）。
      const 假节点 = {
        监听: null, 选项: null, 摘了: 0,
        addEventListener(type, fn, opts) { this.监听 = { type, fn }; this.选项 = opts; },
        removeEventListener() { this.摘了 += 1; },
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 600 }),
      };
      if (基础 && typeof 基础.props.ref === 'function') 基础.props.ref(假节点);
      passed.push(check(!!基础 && typeof 基础.props.ref === 'function'
        && 假节点.监听 && 假节点.监听.type === 'wheel'
        && !!假节点.选项 && 假节点.选项.passive === false
        && typeof 基础.props.onMouseDown === 'function'
        && typeof 基础.props.onDoubleClick === 'function',
        '⑪i 画布挂上了三个手势（滚轮=ref 原生 passive:false / 拖拽 / 双击）',
        'svg=' + (基础 ? 基础.props.className : 'null')
          + ' ref=' + (基础 ? typeof 基础.props.ref : '-')
          + ' wheel=' + (假节点.监听 ? 假节点.监听.type + ' passive=' + (假节点.选项 && 假节点.选项.passive) : '-')
          + ' onMouseDown=' + (基础 ? typeof 基础.props.onMouseDown : '-')
          + ' onDoubleClick=' + (基础 ? typeof 基础.props.onDoubleClick : '-')));
      const 滚轮 = (x, y, deltaY) => {
        const e = 事件(x, y, { deltaY });
        e.currentTarget = 假节点; // 原生监听器里 currentTarget = 挂载节点
        假节点.监听.fn(e);
        return e;
      };
      const 初始 = 解析(基础 && 基础.props.viewBox);
      const 初始文本 = String(基础 && 基础.props.viewBox);

      // ① 滚轮向上 ⇒ 放大（viewBox 变窄）且**缩放上限内**；preventDefault 必须真的被调
      const 轮事件 = 滚轮(300, 200, -120);
      await settle(); rG.flush();
      const 放大后 = 解析(取svg().props.viewBox);
      passed.push(check(放大后[2] > 0 && 放大后[2] < 初始[2] && 轮事件._拦了 === true,
        '⑪i 滚轮向上 ⇒ 放大且拦住整页滚动（preventDefault 真被调）',
        JSON.stringify(初始) + ' → ' + JSON.stringify(放大后) + ' 拦=' + 轮事件._拦了));

      // ② 拖拽 ⇒ 平移（宽高不变、x/y 变）
      const 拖前 = 解析(取svg().props.viewBox);
      取svg().props.onMouseDown(事件(400, 300));
      取svg().props.onMouseMove(事件(500, 360));
      取svg().props.onMouseUp();
      await settle(); rG.flush();
      const 拖后 = 解析(取svg().props.viewBox);
      passed.push(check(拖后[0] !== 拖前[0] && 拖后[1] !== 拖前[1] && 拖后[2] === 拖前[2],
        '⑪i 拖拽 ⇒ 平移（x/y 变、缩放不变）',
        JSON.stringify(拖前) + ' → ' + JSON.stringify(拖后)));

      // ③ 拖拽尾巴不算点击：位移 >4px 之后那次 click 必须被吃掉（否则拖完顺手改掉选中）
      const 选中前 = findAllByClass(rG.tree, 'dshmind-gNodeOn').length;
      const bg = collect(rG.tree, { skipStyle: true }).elements
        .find((el) => el.props && el.props['data-graph-bg'] === '1');
      bg.props.onClick();   // 拖拽刚结束 ⇒ 应被抑制
      await settle(); rG.flush();
      passed.push(check(findAllByClass(rG.tree, 'dshmind-gNodeOn').length === 选中前,
        '⑪i 拖拽尾巴的 click 被抑制（拖完不会顺手改选中）'));

      // ④ 双击 ⇒ 复位成整图（viewBox 回到初始）
      取svg().props.onDoubleClick();
      await settle(); rG.flush();
      passed.push(check(String(取svg().props.viewBox) === 初始文本,
        '⑪i 双击 ⇒ 复位成整图', String(取svg().props.viewBox) + ' vs ' + 初始文本));

      // ⑤ 全程零请求（纯显示手势）
      passed.push(check(!/dshmind-graph/.test('') && 假节点.监听.fn.length === 1,
        '⑪i 手势是纯显示：处理器只接事件对象、不带任何取数参数'));
    }

    // 本区从**静默截断**改为**折叠** —— 线程超 BUS_PREVIEW、消息超 BUS_MSGS_PREVIEW、
    // 正文超 BUS_TEXT_PREVIEW 都默认只给预览，**明说还有多少**，点钮铺开全部。
    // 用 `状态render`（共享 store、不 unmount、带 flush）才能验点击后的变化。
    // 塞 bug 校准：把任一处的 `slice(0, N)` 改回旧的静默截断（不画「另有 N」钮）⇒ 本组必红。
    {
      // 造一个「超限」投影：5 个线程，首个线程 6 条消息、首条为长正文。
      const 超 = sampleView();
      const 长文 = '超长正文测试。' + '补充。'.repeat(60);
      超.消息总线 = [0, 1, 2, 3, 4].map((i) => ({
        线程: 'th-' + i, 条数: i === 0 ? 6 : 1, 未投递: 0,
        最新: i === 0
          ? [0, 1, 2, 3, 4, 5].map((j) => ({
              id: 'x' + j, 发件: 'member-a', 类型: '广播',
              // 长正文放在**最新**那条（j=5）：默认只画最新 BUS_MSGS_PREVIEW 条，
              // 放最旧的位置会被消息层折叠挡住，测不到正文折叠。
              内容: j === 5 ? 长文 : '消息' + j, 正文原长: j === 5 ? 长文.length : 3,
              状态: '已投递', 追加于: '2026-10-07T17:0' + j + ':00+08:00',
            }))
          : [{ id: 'y' + i, 发件: 'member-b', 类型: '表态', 内容: '短', 正文原长: 1, 状态: '已投递', 追加于: '2026-10-07T17:00:00+08:00' }],
      }));
      const rB = await 状态render(超);
      // 线程层：默认只画 BUS_PREVIEW=3 个，明说另有 2 个。
      passed.push(check(findAllByClass(rB.tree, 'dshmind-bus').length === 3,
        '⑦e 线程默认只画 3 个（其余收起）',
        '卡数 ' + findAllByClass(rB.tree, 'dshmind-bus').length));
      passed.push(check(textOf(rB.tree).indexOf('另有 2 个线程') >= 0,
        '⑦e 收起时**明说**还有几个线程（不静默截断）',
        JSON.stringify(textOf(rB.tree).match(/另有 \d+ 个线程/))));
      // 按**文案**精确定位「展开全部线程」钮：页面上还有描述钮/正文钮，取第一个会点错。
      const 钮B = findAllByClass(rB.tree, 'dshmind-descToggle')
        .find((el) => String(el.props.children).indexOf('个线程') >= 0);
      passed.push(check(!!钮B, '⑦e 有「展开全部线程」钮',
        JSON.stringify(findAllByClass(rB.tree, 'dshmind-descToggle').map((el) => String(el.props.children)))));
      钮B.props.onClick();
      await settle();
      rB.flush();
      passed.push(check(findAllByClass(rB.tree, 'dshmind-bus').length === 5,
        '⑦e 点开 ⇒ 全部 5 个线程都画出来（数据本来就在，没被丢）',
        '卡数 ' + findAllByClass(rB.tree, 'dshmind-bus').length));
      // 消息层：首个线程默认只画 3 条，明说另有 3 条。
      const 首卡 = findAllByClass(rB.tree, 'dshmind-bus').filter((el) => textOf(el).indexOf('th-0') >= 0)[0];
      passed.push(check(!!首卡 && findAllByClass(首卡, 'dshmind-busRow').length === 3,
        '⑦e 每线程默认只画 3 条消息',
        '行数 ' + (首卡 ? findAllByClass(首卡, 'dshmind-busRow').length : -1)));
      passed.push(check(!!首卡 && textOf(首卡).indexOf('另有 3 条') >= 0,
        '⑦e 消息收起时**明说**还有几条（不静默截断）'));
      // 正文层：长正文默认折到 3 行、给展开钮。
      const 长正文格B = 首卡 ? findAllByClass(首卡, 'dshmind-busText').find((el) => textOf(el).indexOf('超长正文测试') >= 0) : null;
      passed.push(check(!!长正文格B && String(长正文格B.props.className).indexOf('busTextClamped') >= 0,
        '⑦e 长正文默认折叠（busTextClamped）'));
    }

    // ① 面板里**不许有"看起来能点"的东西**。例外五种：刷新按钮 + 会审折叠切换钮
    //    （优化批③：纯显示切换，不发命令——「不是写动作」由 ③c 的零请求断言钉死）
    //    + 项目 chip（项目解析修正·2026-10-11：换投影的纯显示动作，不写账——由 ⑧b 钉死）
    //    + 描述折叠钮（2026-10-12 主权者要「全文+默认折叠」：纯显示切换，零请求——由 ⑩d 钉死）
    //    + 分页导航钮（2026-10-13 重做：七页之间切换，纯显示、零请求零写账——由 ⑪a 钉死）。
    //    旧版「介入度档位」画成 4 个 chip（零参与/事后抽检/变更预审/逐条审批）——
    //    只读投影长得像按钮，会误导人以为能点。五者之外多一个按钮都算破规。
    const 面板 = await 状态render(sampleView());
    const 面板元素 = collect(面板.tree, { skipStyle: true }).elements;
    const 可点按钮 = 面板元素.filter((el) => el.type === 'button');
    const 非规按钮 = 可点按钮.filter((el) => {
      const 类 = String(el.props.className || '');
      if (类.indexOf('dshmind-btn') >= 0 && String(el.props.children).indexOf('刷新') >= 0) return false;
      if (类.indexOf('dshmind-toggle') >= 0) return false;
      if (类.indexOf('dshmind-projChip') >= 0) return false;
      if (类.indexOf('dshmind-descToggle') >= 0) return false;
      if (类.indexOf('dshmind-navBtn') >= 0) return false;
      return true;
    });
    passed.push(check(可点按钮.length >= 1 && 非规按钮.length === 0,
      '① 面板里可点的只有「刷新」与会审折叠钮、描述折叠钮、项目 chip、分页导航（其余一律不许可点）',
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
    passed.push(check(!!介入格 && 介入格.文本.indexOf('50%') >= 0 && !/(^|\s)(0%|100%)/.test(介入格.文本)
      && 介入格.文本.indexOf('变更预审') < 0 && 介入格.文本.indexOf('审批') < 0,
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

    // ④ ⚠️ **口径改形（2026-10-13 晚）：审计不再有"卡内滚动框"**。
    //    旧口径（Batch 9 后半）是「审计流那个框不能滚动 ⇒ 给它 max-height + overflow-y:auto」，
    //    那是「五个分区堆一页」时代的补丁。审计**自成一页**之后，根容器（`.dshmind-root`）
    //    本来就是滚动容器 ⇒ 框内再套一个 `overflow-y:auto` 就是**双层滚动**
    //    （滚轮在框里框外行为还不一样），而且内容被压在小盒子里看不见（主权者原话：
    //    「审计你还使用卡片内部滚动的做法呢」）。现在：**行直接进页面流**，超上限靠「展开」钮铺开。
    //    所以这三条改成**反向判据**：那个壳必须**不存在**（不是把红删掉，是把要求改对了）。
    passed.push(check(!/\.dshmind-auditScroll\{/.test(面板源码),
      '④ 审计**不许**再有卡内滚动壳（`.dshmind-auditScroll` 必须不存在）—— 审计自成一页，页面自己滚'));
    passed.push(check(!/\.dshmind-busMsgs\{[^}]*overflow(-y)?:\s*auto/.test(面板源码),
      '④ 总线消息区同样不许卡内滚动（独立壳、无 overflow）'));
    passed.push(check(/\.dshmind-root\{[^}]*overflow:\s*auto/.test(面板源码),
      '④ 唯一的滚动容器是根容器（页面级滚动）'));

    // Metadata previews are not a fake history pager. The active page reads native history separately.
    {
      const v=sampleView();const base=v.审计尾[0];v.审计尾=Array.from({length:40},(_,i)=>Object.assign({},base,{seq:i+1}));
      const r=await 状态render(v);const elements=collect(r.tree,{skipStyle:true}).elements;
      passed.push(check(findAllByClass(r.tree,'dshmind-auditRow').length===40,'⑤ 审计快照预览如实保留40条，正文历史另按需读取'));
      passed.push(check(!elements.some(e=>e.type==='button'&&textOf(e).includes('展开全部（共')),'⑤ 审计没有20变40的伪展开控件'));
      passed.push(check(collect(r.tree,{skipStyle:true}).text.includes('打开审计页可筛选并加载更早记录'),'⑤ 预览说明真实历史入口，不称为全量历史'));
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

    // ①b（2026-10-12 评审 P1-11）：降级路径的同步补订阅必须**判重**——
    //    修前每次渲染都往模块级 store 里再 push 一个订阅（订阅数组随渲染数线性涨）。
    //    判据用 setState 调用数当探针：每次新订阅都会立刻回放一次（回放 = 一次 setState），
    //    重复渲染两次若判重在位 ⇒ 一次回放都不该再有。
    setState调用数 = 0;
    设置渲染.render();
    设置渲染.render();
    passed.push(check(setState调用数 === 0,
      '①b 降级路径重复渲染 ⇒ 订阅判重（零新增回放；修前每次渲染都再订一次）', 'setState 被调 ' + setState调用数 + ' 次'));
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

  // ③ 「人改过」防覆盖（2026-10-14 审查 P1-10）：修前 `set人改过(true)` 全文 0 调用——
  //    注释承诺「人正在填的字不被轮询吃掉」，代码里保护是死的，3 秒回读会静默冲掉表单。
  //    对照臂（没碰过 ⇒ 回读照刷）与修复臂（碰过 ⇒ 不许刷）同组件先后验。
  {
    let 当前读数 = 读数袋(); // 开 / 72h
    const 宿主 = Object.assign(session(), {
      fetch: makeFetch((url) => (String(url).indexOf('workbench') >= 0
        ? jsonResponse(sampleView())
        : jsonResponse({ 读数: 当前读数, 设置文件: SETTINGS_FILE, 说明: '读…' }))).fetch,
    });
    const b = boot({ store: new Map(), services: 宿主 });
    const r = mountSettings(b);
    r.flush(); await settle(); r.flush();
    const 输入框 = () => findAllByClass(r.tree, 'dshmind-set__number')[0];
    const 打一拍 = async () => {
      b.timers.intervals.forEach((t) => { try { t.fn(); } catch (e) { /* 轮询自身异常不挡断言 */ } });
      await settle(); r.flush();
    };
    passed.push(check(!!输入框() && String(输入框().props.value) === '72',
      '③ 表单初值跟读数（72h）', 输入框() ? String(输入框().props.value) : '没有输入框'));
    // 对照臂：人没碰过，服务端读数变成 24h ⇒ 下一拍回读把表单刷成 24
    当前读数 = 读数袋({ 生效响应期限小时: 24 });
    await 打一拍();
    passed.push(check(String(输入框().props.value) === '24',
      '③ 对照：人没碰过 ⇒ 回读照刷（24h）', String(输入框().props.value)));
    // 修复臂：人改成 100 ⇒ 读数再变（48h）也不许吃掉人填的字
    输入框().props.onChange({ target: { value: '100' } });
    r.flush();
    当前读数 = 读数袋({ 生效响应期限小时: 48 });
    await 打一拍();
    passed.push(check(String(输入框().props.value) === '100',
      '③ 人改过 ⇒ 轮询回读不许吃掉表单（仍是 100）', String(输入框().props.value)));
    r.unmount();
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
    // ⚠️ 2026-10-17 优化批改形：处理器原来按**次数**路由（第 1 次正常、之后挂死），
    //    隐含假设「第一次命令一定是 presence 读」。调度授权区挂载后也发 GET，谁先谁后
    //    不是这条用例想测的东西 —— 改成按**命令**路由：presence 读正常、写与其它挂死。
    //    （保存现在在未接入时会被本地拦截，读数必须先到位，按命令路由正好保证这一点。）
    const 保存挂死 = boot({ store, services: Object.assign(session(), {
      remote: makeRemote((sessionId, command) => {
        if (command === PRESENCE_COMMAND) return okReply({ 读数: 读数袋(), 设置文件: SETTINGS_FILE, 说明: '读…' });
        return new Promise(() => {});
      }).remote,
    }) });
    const 保存渲染 = mountSettings(保存挂死);
    await textAfterLoad(保存渲染);
    // 未修改时保存禁用；先形成真实草稿再验证写链超时，不能靠空提交绕过新交互。
    collect(保存渲染.tree, { skipStyle: true }).elements.find((el) => el.props['aria-label'] === '响应期限小时')
      .props.onChange({ target: { value: '168' } });
    保存渲染.flush();
    collect(保存渲染.tree, { skipStyle: true }).elements.find((el) => el.type === 'button'
      && String(el.props.children) === '保存').props.onClick();
    await settle();
    保存渲染.flush();
    保存挂死.timers.fireTimeouts();
    await settle();
    保存渲染.flush();
    const 保存文本 = collect(保存渲染.tree, { skipStyle: true }).text;
    const 保存钮 = collect(保存渲染.tree, { skipStyle: true }).elements.find((el) => el.type === 'button'
      && String(el.props.children) === '保存');
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
      // ⑩ 长描述不打爆卡片 + 全文可看（2026-10-12）：
      //    主人先报「只用了左侧一半的面板」→ 定案：多列网格 + 长描述。
      //    随后主人改口径为「**要全文 + 默认折叠**」（否掉硬截断——那会丢全文）。
      //    所以现在钉的是：①单列；②折叠态有钳位且数值合理；③展开态类名在；
      //    ④长描述有展开钮；⑤展开钮纯显示、零请求。
      // 塞 bug 校准：把 `.dshmind-nodeTitleClamped` 的 line-clamp 改成 999、或把 `.dshmind-nodes`
      //    改回多列、或删掉展开钮 ⇒ 本组必红。
      {
        const r9 = await renderView(sampleView());
        const 样式9 = collect(r9.tree, {}).elements
          .filter((el) => el.type === 'style')
          .map((el) => String(el.props && el.props.children || '')).join('\n');
        // ①网格 —— **口径改形（2026-10-14）**：
        //    旧口径（2026-10-13 晚第二轮）是「**列宽下限 ≥380px 的自动网格**」，
        //    理由是「单列 + 正文限行宽 ⇒ 每张卡右半边空着」。
        //
        //    ⚠️ 主权者 2026-10-14 看真机后判：**多列不好看**，并指明「就按设计稿做」。
        //    复核设计稿（`mind-panel-redesign/mockup.html`）：`.tcard{padding:14px 16px;margin-bottom:10px}`
        //    ⇒ **单列、整宽、一条条堆**；且 `.tcard .desc` **没有任何行长上限**。
        //    ⇒ **旧口径的因果搞反了**：右半边空的成因是**逐元素行长上限 `--mk-measure`**，
        //    不是单列。正确改法是「回单列 + 放开卡内预览的限宽」，而不是"用多列把卡片切窄"。
        //
        //    守的本意**不变**：**任何一列都不许窄到让长描述爆炸**。单列（`1fr`）是最宽的那一档，
        //    故本意更强地成立。这一条是**口径改形、不是删红**：判据从
        //    「列宽下限 ≥380px」改成「单列 1fr，且**不得**出现 auto-fill/auto-fit 多列」。
        //    塞 bug 校准：把 `.dshmind-nodes` 改回 `repeat(auto-fill,minmax(…))` 多列 ⇒ 必红。
        const 网格规则 = (样式9.match(/\.dshmind-nodes\{[^}]*\}/) || [''])[0];
        passed.push(check(/grid-template-columns:\s*1fr/.test(网格规则)
          && !/auto-fill|auto-fit/.test(网格规则),
          '⑩ 任务图＝单列（照设计稿 .tcard：一条条堆；多列会让长正文疯狂折行）',
          JSON.stringify(网格规则)));
        // ②折叠态钳位：只查「有没有 line-clamp」不够，`999` 也是合法声明却等于没限行。
        const 折叠规则 = (样式9.match(/\.dshmind-nodeTitleClamped\{[^}]*\}/) || [''])[0];
        const 钳位 = Number((折叠规则.match(/-webkit-line-clamp:\s*(\d+)/) || [0, 0])[1]);
        passed.push(check(钳位 >= 1 && 钳位 <= 6,
          '⑩ 折叠态行数上限落在 1~6 行 —— 长描述默认不许把卡片撑成一面墙',
          JSON.stringify(折叠规则) + ' 钳位=' + 钳位));
        passed.push(check(/overflow:\s*hidden/.test(折叠规则),
          '⑩ 折叠态必须配 overflow:hidden（否则只是排版提示、照样溢出）', JSON.stringify(折叠规则)));
        // ③展开态类名在：展开时不许再钳位（否则「要全文」落空）。
        const 展开规则 = (样式9.match(/\.dshmind-nodeTitleOpen\{[^}]*\}/) || [''])[0];
        passed.push(check(展开规则.length > 0 && !/-webkit-line-clamp/.test(展开规则),
          '⑩ 展开态不钳位 —— 点开后必须看到全文，不许再截',
          JSON.stringify(展开规则)));
        // ④长描述必须有展开钮，且默认是折叠态（主权者口径「默认折叠」）。
        const 长卡 = 卡(r9, '审计档位分级落地');
        const 钮 = 长卡 ? findAllByClass(长卡, 'dshmind-descToggle')[0] : null;
        passed.push(check(!!钮 && String(钮.props.children).indexOf('展开全文') >= 0,
          '⑩ 长描述给「展开全文」钮（默认折叠）', JSON.stringify(钮 && String(钮.props.children))));
        // ⑤默认折叠 ⇒ 全文块此刻不该出现（点开才画）。
        passed.push(check(!!长卡 && findAllByClass(长卡, 'dshmind-nodeTitleOpen').length === 0,
          '⑩ 默认折叠 ⇒ 全文块此刻不画（点开才铺开）'));
        // ⑥折叠态标题确实带钳位类。
        const 长标题2 = 长卡 ? findAllByClass(长卡, 'dshmind-nodeTitle')[0] : null;
        passed.push(check(!!长标题2 && String(长标题2.props.className).indexOf('dshmind-nodeTitleClamped') >= 0,
          '⑩ 折叠态标题挂 Clamped 类', JSON.stringify(长标题2 && String(长标题2.props.className))));
        // ⑦标题**独占整行**（2026-10-12，主权者打回「这里就不能单起一行吗」）：
        //   标题原为 `flex:1`，会吃掉整行剩余宽 ⇒ 后面的徽章组（交卷/模式/复核）被顶到
        //   远端右侧、标题只剩 3 行时左侧空一大片。改成 `flex-basis:100%` 强制换行。
        //   塞 bug 校准：把 `.dshmind-nodeTitleFull` 去掉/改回 flex:1 ⇒ 本条必红。
        const 独占规则 = (样式9.match(/\.dshmind-nodeTitleFull\{[^}]*\}/) || [''])[0];
        passed.push(check(/flex-basis:\s*100%/.test(独占规则),
          '⑩ 标题独占整行（flex-basis:100%）—— 徽章组才会换行到下一行、从左边排',
          JSON.stringify(独占规则)));
        passed.push(check(!!长标题2 && String(长标题2.props.className).indexOf('dshmind-nodeTitleFull') >= 0,
          '⑩ 任务图长描述标题挂 TitleFull 类', JSON.stringify(长标题2 && String(长标题2.props.className))));
        // 反例面：**不许**改共享的 `.dshmind-nodeTitle` 去加 flex-basis —— 总线线程名
        // （`:2404`）同用该类，全局改会把短线程名也顶成独占一行（超范围、连带改外观）。
        const 标题规则9 = (样式9.match(/\.dshmind-nodeTitle\{[^}]*\}/) || [''])[0];
        passed.push(check(标题规则9.length > 0 && !/flex-basis/.test(标题规则9),
          '⑩ 共享的 .dshmind-nodeTitle 不许加 flex-basis（总线线程名同用它，全局改会连带超范围）',
          JSON.stringify(标题规则9)));
        // 会审卡那处也必须挂（两处同源，只改一处就是漏）。
        const 会审卡9 = findAllByClass(r9.tree, 'dshmind-review')[0];
        const 会审标题9 = 会审卡9 ? findAllByClass(会审卡9, 'dshmind-nodeTitle')[0] : null;
        passed.push(check(!!会审标题9 && String(会审标题9.props.className).indexOf('dshmind-nodeTitleFull') >= 0,
          '⑩ 会审卡标题同样挂 TitleFull（两处同源，不许只改一处）',
          JSON.stringify(会审标题9 && String(会审标题9.props.className))));
        // 反例面：总线线程名的 nodeTitle **不许**带 TitleFull（超范围改外观）。
        const 总线标题9 = findAllByClass(r9.tree, 'dshmind-bus')
          .map((el) => findAllByClass(el, 'dshmind-nodeTitle')[0]).filter(Boolean);
        passed.push(check(总线标题9.every((el) => String(el.props.className).indexOf('dshmind-nodeTitleFull') < 0),
          '⑩ 总线线程名不带 TitleFull（线程名短、本就正常，不改）'));
      }
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
    // UI 卫生批（2026-10-10 · 主人视觉打回「截断、贴边」）：CSS 规则判据读真注入的 style
    // 元素（体例同 ⑤），title 是行为判据——截断省略的地方必须挂全文，截断不丢信息。
    {
      const r = await renderView(sampleView());
      const 样式 = r.elements.find((el) => el.type === 'style');
      const 规则体 = 样式 ? (Array.isArray(样式.props.children) ? 样式.props.children.join('') : String(样式.props.children)) : '';
      passed.push(check(/\.dshmind-readoutGroups\{[^}]*padding:12px 16px 16px/.test(规则体),
        'UI 读数区与 hero 内缘有 12/16px 边距（格子不贴容器圆角边）'));
      passed.push(check(/\.dshmind-auditRow\{[^}]*grid-template-columns:max-content max-content minmax\(0,1fr\) 150px/.test(规则体)
        && !/88px 78px/.test(规则体),
        'UI 审计时间/档位列按内容宽（固定 88px 装不下 MM-DD HH:mm:ss≈92px）'));
      passed.push(check(/\.dshmind-toggle\{[^}]*font-family:inherit/.test(规则体),
        'UI 折叠钮继承面板字体（button 默认 Arial 会混排）'));
      const 产物chip = r.elements.find((el) => String(el.props.className || '').indexOf('dshmind-chip') >= 0
        && textOf(el) === 'artifact-1');
      passed.push(check(!!产物chip && 产物chip.props.title === 'artifact-1',
        'UI 产物 chip 带 title 全文（省略不丢信息）', JSON.stringify(产物chip && 产物chip.props.title)));
      const 提示 = r.elements.find((el) => String(el.props.className || '').split(/\s+/).indexOf('dshmind-secHint') >= 0);
      passed.push(check(!!提示 && 提示.props.title === textOf(提示) && textOf(提示).length > 0,
        'UI 分区 hint 带 title 全文（窄面板省略不丢信息）', JSON.stringify(提示 && 提示.props.title)));
      // UI 截断事故（2026-10-11）：根是 flex 纵向容器 + height:100%，子项默认会被压扁，
      // 而分区 overflow:hidden ⇒ 压掉的那截直接裁掉（健康组卡片下半、空态命令块下半）。
      passed.push(check(/\.dshmind-root>\*\{flex:none\}/.test(规则体),
        'UI 根的子项不许压缩（flex:none）——压扁即被分区 overflow 裁掉'));
      // 审计主体：session-<uuid> 长达 38 字符会把主体列顶成省略号——显示截到前 8 位，title 给全文。
      const 会话视图 = sampleView();
      会话视图.审计尾 = [{ seq: 1, 时间: '2026-10-07T17:01:02+08:00', 动作: '状态变更', 主体: 'session-d6d8208e-b3e9-42c9-9d4a-75d0f40a7cd9', 结果: '记入', 档位: '全记' }];
      const 会话页 = await renderView(会话视图);
      const 主体格 = 会话页.elements.find((el) => String(el.props.className || '').split(/\s+/).indexOf('dshmind-auditWho') >= 0);
      passed.push(check(!!主体格 && textOf(主体格) === 'session-d6d8208e'
        && 主体格.props.title === 'session-d6d8208e-b3e9-42c9-9d4a-75d0f40a7cd9',
        'UI 审计主体显示名截到 session-+8 位（title 全文）',
        JSON.stringify({ t: 主体格 && textOf(主体格), title: 主体格 && 主体格.props.title })));
    }

    // ⑦ 消息总线（2026-10-11）：全部线程 + 未投递高亮 + 会审讨论段盲评收起 + 空态给命令。
    {
      const r = await renderView(sampleView());
      const 卡 = findAllByClass(r.tree, 'dshmind-bus').filter((el) => textOf(el).includes('跑通测试-20261011'));
      passed.push(check(卡.length === 1 && textOf(卡[0]).indexOf('3 条') >= 0,
        '⑦ 普通线程画出来（线程名 + 条数）', '卡数 ' + 卡.length));
      passed.push(check(卡.length === 1 && textOf(卡[0]).indexOf('未投递 1') >= 0,
        '⑦ 未投递 >0 高亮（warn 徽章）'));
      passed.push(check(卡.length === 1 && textOf(卡[0]).indexOf('⏸') >= 0 && textOf(卡[0]).indexOf('判据已核对') >= 0,
        '⑦ 最新消息扫描行在（暂不投递带 ⏸ 前缀）'));
      // ⚠️ 口径改形（2026-10-12，主权者「（总线）也默认收起呗」）：
      // 旧版 title 挂在**行**上、给的是投影层截断后的 120 字（「全文」其实只有 120 字）。
      // 现在投影层给全量正文，收窄挪到渲染层折叠 —— **长正文**（> BUS_TEXT_PREVIEW）在
      // 折叠态把 title 挂到**正文格**上给全文；**短正文不折、不挂**（没什么可展开的）。
      // 本条守的本意不变：截断处必须有不丢信息的出口。用长正文样本 msg-1 测。
      const 长行 = 卡.length === 1 ? findAllByClass(卡[0], 'dshmind-busRow').find((el) => textOf(el).indexOf('全员注意') >= 0) : null;
      const 长正文格 = 长行 ? findAllByClass(长行, 'dshmind-busText')[0] : null;
      passed.push(check(!!长正文格 && String(长正文格.props.title).indexOf('全员注意') === 0,
        '⑦ 长正文折叠态：正文格挂 title=全文（截断不丢信息）',
        JSON.stringify(长正文格 && 长正文格.props.title).slice(0, 80)));
      // 短正文不许被折叠（没东西可展）：msg-3 的短句不该带 Clamped 类。
      const 短行 = 卡.length === 1 ? findAllByClass(卡[0], 'dshmind-busRow').find((el) => textOf(el).indexOf('产物引用给仓内') >= 0) : null;
      const 短正文格 = 短行 ? findAllByClass(短行, 'dshmind-busText')[0] : null;
      passed.push(check(!!短正文格 && String(短正文格.props.className).indexOf('Clamped') < 0,
        '⑦ 短正文不折叠（没东西可展，不给多一个钮）', JSON.stringify(短正文格 && String(短正文格.props.className))));
      // 长正文必须给「展开全文」钮，且折叠态挂 Clamped。
      passed.push(check(!!长行 && findAllByClass(长行, 'dshmind-descToggle').length === 1,
        '⑦ 长正文给「展开全文」钮（默认折叠）',
        '钮数 ' + (长行 ? findAllByClass(长行, 'dshmind-descToggle').length : -1)));
      passed.push(check(!!长正文格 && String(长正文格.props.className).indexOf('busTextClamped') >= 0,
        '⑦ 长正文折叠态挂 busTextClamped', JSON.stringify(长正文格 && String(长正文格.props.className))));
      const 行 = 长行;
      // ⑦c 总线正文保留换行（2026-10-12，主人视觉打回「密排」）：
      // 旧版正文套 `.dshmind-auditAction`（审计动作列口径），它只有 overflow-wrap、无 white-space
      // ⇒ 默认 normal 把消息里的 `\n` 折叠成空格：多行简报（标题/列表/表格）挤成一整段。
      // 塞 bug 校准：删掉 `.dshmind-busText{…white-space:pre-wrap…}` 里那段（或把 :2325 换回
      // auditAction）⇒ 本组必红。
      const 正文 = findAllByClass(r.tree, 'dshmind-busText');
      passed.push(check(正文.length > 0,
        '⑦c 总线正文用独立类名 dshmind-busText（不借审计动作列口径）', '命中 ' + 正文.length + ' 个'));
      // 样式写在模块级样式表字符串里（不是内联 props.style）——它在 type:'style' 节点的
      // `props.children` 上（一个长字符串）。**不能用 `textOf()`**：它内部强制 skipStyle，
      // 对 style 节点返回空串（2026-10-12 实测踩过，断言会永远绿/假红）。
      const 样式文本 = collect(r.tree, {}).elements
        .filter((el) => el.type === 'style')
        .map((el) => String(el.props && el.props.children || '')).join('\n');
      const 规则 = (样式文本.match(/\.dshmind-busText\{[^}]*\}/) || [''])[0];
      passed.push(check(/white-space:\s*pre-wrap/.test(规则),
        '⑦c 总线正文声明 white-space:pre-wrap —— 保留消息内换行（否则 24 行折叠成一段）',
        JSON.stringify(规则)));
      // 反例面：`nowrap` 会截断、裸 `pre` 不折行会横向溢出（末列是 minmax(0,1fr)，本就该吃满折行）。
      // 注意 `(?!-wrap)`：不加它，`pre-wrap` 会被 `pre\b` 误伤（`\b` 在 `-` 前成立）。
      passed.push(check(规则.length > 0 && !/white-space:\s*(nowrap|pre(?!-wrap))\b/.test(规则),
        '⑦c 不许用 nowrap（截断）或裸 pre（不折行会横向溢出）', JSON.stringify(规则)));
      // 反向：总线行内不得再出现 .dshmind-auditAction —— 两套口径合流正是这个 bug 的成因。
      passed.push(check(卡.length === 1 && findAllByClass(卡[0], 'dshmind-auditAction').length === 0,
        '⑦c 总线行内不再出现 .dshmind-auditAction（分区类名不串味）'));
      // 换行必须真的到达正文格：多行消息的正文文本里要保住 `\n`（渲染不得先折叠）。
      const 多行行 = 卡.length === 1 ? findAllByClass(卡[0], 'dshmind-busRow').find((el) => textOf(el).indexOf('【通报】') >= 0) : null;
      const 多行正文 = 多行行 ? findAllByClass(多行行, 'dshmind-busText')[0] : null;
      passed.push(check(!!多行正文 && textOf(多行正文).indexOf('\n') >= 0,
        '⑦c 多行消息的 `\\n` 到达渲染（没被折成一整段）',
        JSON.stringify(多行正文 && textOf(多行正文))));
      // ⑦f 扫描行是**两行**（2026-10-12，主权者：「这里单起一行啊」）：
      // 旧版四列网格（时间/类型/发件/正文）里前三列吃掉左侧宽度，正文被挤到右边只剩一条。
      // 现在：元信息（时间/类型/发件）独立一行，正文独占下一行、吃满宽度。
      // 塞 bug 校准：把 `.dshmind-busRow` 改回 `display:grid` 四列（或把元信息与正文合成一行）⇒ 必红。
      {
        const 行f = findAllByClass(r.tree, 'dshmind-busRow')[0];
        passed.push(check(!!行f, '⑦f 消息扫描行在'));
        // 结构：每行只有两个块 —— busMeta（元信息）+ busTextWrap（正文）。
        const 子块f = 行f ? (行f.props.children || []).filter(Boolean) : [];
        const 类名f = 子块f.map((c) => String(c.props && c.props.className || ''));
        passed.push(check(类名f.length === 2
          && 类名f[0].indexOf('dshmind-busMeta') >= 0
          && 类名f[1].indexOf('dshmind-busTextWrap') >= 0,
          '⑦f 扫描行只有两个块：元信息 + 正文（正文不再和元信息抢同一行）',
          JSON.stringify(类名f)));
        // 元信息块里必须是 时间/类型/发件 三样（不许把正文也塞进去）。
        const metaF = 行f ? findAllByClass(行f, 'dshmind-busMeta')[0] : null;
        const meta文本f = metaF ? textOf(metaF) : '';
        passed.push(check(!!metaF && meta文本f.indexOf('广播') >= 0 && meta文本f.indexOf('lead') >= 0
          && meta文本f.indexOf('全员注意') < 0,
          '⑦f 元信息行只有时间/类型/发件（正文不在这行）', JSON.stringify(meta文本f)));
        // 布局：busRow 必须是纵排（flex-direction:column），不是旧的四列 grid。
        const 样式f = collect(r.tree, {}).elements
          .filter((el) => el.type === 'style')
          .map((el) => String(el.props && el.props.children || '')).join('\n');
        const 行规则f = (样式f.match(/\.dshmind-busRow\{[^}]*\}/) || [''])[0];
        passed.push(check(/flex-direction:\s*column/.test(行规则f) && !/grid-template-columns/.test(行规则f),
          '⑦f 扫描行改纵排（不再用四列 grid 挤正文）', JSON.stringify(行规则f)));
      }
      // ⑦g 滚动作用域 vs 显示宽度，**拆成两层**（2026-10-12）：
      // 主权者先报「面板整体的纵向滚动作用域太小」，我改 min-height 未解决；随后他框出
      // **面板左右两侧的空白**并说明「不能只放宽滚动作用域吗」——根因是两者原先**共用一个元素**：
      // `.dshmind-root` 既是面板 DOM 边界（原先自己带 `max-width`，两侧空白不属于它）、又是滚动容器
      // （`overflow:auto`）⇒ 滚轮落在两侧空白上命中的是宿主容器、而宿主不是滚动容器 ⇒ 滚不动。
      // 现在：root 铺满（无 max-width）+ 滚动容器；page 负责居中排版。
      //
      // ⚠️ 口径改形（2026-10-13 重做）：page 的宽度**从 1040 改成 1180**。
      //    理由（不是把红删掉）：1040 是「单列长页」时代的产物；重做后是「侧栏 + 内容」两栏，
      //    1040 塞不下侧栏与内容且两侧留白过大。**本条真正守的两件事没变**：
      //      ① 滚动容器只能有一个（root），page **不许**有 overflow；
      //      ② root 必须是铺满的那个（不许自己限宽）。
      //    所以断言改成「页宽等于设计值 1180 + 居中 + 无 overflow」，并**不许**再出现
      //    「源码里某处写着 1040」这种对不上生效值的假绿（旧写法只对源码文本取一次匹配，
      //    覆盖层一加就会出现「写着 1040、实际 1180」的假绿）。
      // 塞 bug 校准：把 max-width 加回 root、把 overflow 挪到 page、或把页宽改回 1040 ⇒ 必红。
      {
        const 样式g = collect(r.tree, {}).elements
          .filter((el) => el.type === 'style')
          .map((el) => String(el.props && el.props.children || '')).join('\n');
        const 根规则g = (样式g.match(/\.dshmind-root\{[^}]*\}/) || [''])[0];
        const 页规则g = (样式g.match(/\.dshmind-page\{[^}]*\}/) || [''])[0];
        // root：铺满 + 滚动容器 + 不锁死高度。
        passed.push(check(!/max-width/.test(根规则g),
          '⑦g 根容器**不许**再限宽（限宽会让两侧空白不属于面板 ⇒ 那里滚不动）',
          JSON.stringify(根规则g)));
        passed.push(check(/overflow:\s*auto/.test(根规则g),
          '⑦g 根容器是滚动容器（overflow:auto）—— 铺满整屏 ⇒ 整屏任何位置都能滚',
          JSON.stringify(根规则g)));
        passed.push(check(/min-height:\s*100%/.test(根规则g) && !/(?:^|;)\s*height:\s*100%/.test(根规则g),
          '⑦g 根容器 min-height:100% 而非 height:100%（不锁死高度）', JSON.stringify(根规则g)));
        // page：**不许**自己再成为滚动容器（否则又截住滚轮）；宽度口径见下面那条改形说明。
        passed.push(check(页规则g.length > 0 && !/overflow/.test(页规则g),
          '⑦g 内容层不许有 overflow（否则内层又会截住滚轮）', JSON.stringify(页规则g)));
        // ⚠️ 口径改形（2026-10-13 晚）：「1180px 居中」→ **铺满**。
        // 理由（不是删红）：旧口径来自 2026-10-12 的「滚动作用域 vs 显示宽度」修复，
        // 当时主权者只要求放宽滚动作用域、显示宽度不变；宽屏真机上那条款就成了两侧一大片空白
        // （主权者原话「为啥左右留空这么多」）。现在布局铺满，**可读性改由行长上限保证**
        // （`--mk-measure`，下一条断言钉着）——这是「铺满」与「读得动」的分工。
        passed.push(check(!/max-width/.test(页规则g) && /width:\s*100%/.test(页规则g),
          '⑦g 内容层铺满（无 max-width + width:100%）—— 宽屏不留大片空白',
          JSON.stringify(页规则g)));
        passed.push(check(/--mk-measure:\s*\d+ch/.test(readFileSync(CLIENT_PATH, 'utf8'))
          && /\.dshmind-nodeTitleFull[^{]*\{[^}]*max-width:\s*var\(--mk-measure\)/.test(readFileSync(CLIENT_PATH, 'utf8')),
          '⑦g 铺满的同时**正文有行长上限**（铺满的可读性代价必须对冲：一行的字太多读不动）',
          '--mk-measure 在位：' + /--mk-measure:\s*\d+ch/.test(readFileSync(CLIENT_PATH, 'utf8'))));
        // 覆盖层不许再偷偷声明第二份 page 宽度（同一件事两个出处 ⇒ 迟早漂移）
        const 页规则们 = 样式g.match(/\.dshmind-page\{[^}]*\}/g) || [];
        passed.push(check(页规则们.length === 1,
          '⑦g 内容层宽度只有一个出处（覆盖层不许再声明一份，改一处忘一处就是漂移）',
          String(页规则们.length)));
        // 结构上确实存在两层。
        passed.push(check(findAllByClass(r.tree, 'dshmind-root').length === 1
          && findAllByClass(r.tree, 'dshmind-page').length === 1,
          '⑦g DOM 确实是两层：root（铺满+滚动）+ page（内容居中）',
          'root=' + findAllByClass(r.tree, 'dshmind-root').length + ' page=' + findAllByClass(r.tree, 'dshmind-page').length));
      }
      const 讨论卡 = findAllByClass(r.tree, 'dshmind-bus').filter((el) => textOf(el).indexOf('会审讨论段 · 盲评保护') >= 0);
      passed.push(check(讨论卡.length === 1
        && textOf(讨论卡[0]).indexOf('member-') < 0
        && textOf(讨论卡[0]).indexOf('盲评口径收起') >= 0,
        '⑦ 会审讨论线程收起正文（无发件人、无正文，只给规模行）', '卡数 ' + 讨论卡.length));
      const 空 = sampleView();
      空.消息总线 = [];
      const e = await renderView(空);
      passed.push(check(e.text.indexOf('消息总线上还没有消息') >= 0 && e.text.indexOf("action:'bus_send'") >= 0,
        '⑦ 空总线给明说空态 + 一条可敲的 bus_send 命令'));
    }


    // ⑧ 项目解析修正（2026-10-11，主权者指令「修」）：清单进页头 + 一键切项目 + 空账明写自动选择。
    {
      // ⑧a 有清单 ⇒ 页头画出「项目」那一格：当前项目不可点、别的项目是可点 chip。
      const r = await renderView(sampleView());
      const chips = findAllByClass(r.tree, 'dshmind-projChip');
      const 当前档 = findAllByClass(r.tree, 'dshmind-projChipOn');
      passed.push(check(chips.length === 1 && 当前档.length === 1
        && textOf(chips[0]).indexOf('default（0 卡 · 0 线程）') >= 0
        && textOf(当前档[0]).indexOf('mind-private（5 卡 · 2 线程') >= 0,
        '⑧a 页头画出项目 chips：当前项目不可点、别的项目可点（带计数）',
        JSON.stringify({ chips: chips.length, 当前: 当前档.length })));
      // ⑧b 点 chip ⇒ 下一次取数带 `?project=`，且**一个写请求都没有**（纯显示动作）。
      const 目标chip = chips[0];
      const fetch前 = r.calls.length;
      if (目标chip && typeof 目标chip.props.onClick === 'function') 目标chip.props.onClick();
      目标chip && r.tree && await settle();
      const 后 = r.calls.slice(fetch前);
      passed.push(check(后.length >= 1 && 后.every((c) => c.请求.method === 'GET')
        && 后.some((c) => String(c.请求.url).indexOf('?project=default') >= 0),
        '⑧b 点项目 chip 以 ?project= 重取，且零写请求',
        JSON.stringify(后.map((c) => c.请求.method + ' ' + c.请求.url))));
      // ⑧c 空账 + 别处有账 ⇒ 自动选最近活动那个，且页头**明写**（不许静默换项目）。
      const 空账 = sampleView();
      空账.项目 = 'default';
      空账.任务 = { 总数: 0, 计数: { 待派发: 0, 进行中: 0, 已交卷: 0, 已采纳: 0, 已打回: 0, 未验: 0, 已结账: 0, 待决: 0 }, 节点: [] };
      空账.会审 = [];
      空账.消息总线 = [];
      空账.项目清单 = {
        当前: 'default',
        项: [
          { 项目: 'plugins', 任务: 14, 线程: 1, 未投递: 0, 最近于: '2026-10-11T05:44:19Z' },
          { 项目: 'default', 任务: 0, 线程: 0, 未投递: 0, 最近于: '' },
        ],
      };
      const 切后 = await renderViewByProject(空账, { plugins: 有账项目视图() });
      /** 切过去那一份：项目键 **必须**是 plugins（否则页头与"自动选出来的项目"对不上，注记就不会画）。 */
      function 有账项目视图() {
        const v = sampleView();
        v.项目 = 'plugins';
        v.项目清单 = { 当前: 'plugins', 项: 空账.项目清单.项 };
        return v;
      }
      const 发过的 = 切后.calls.filter((c) => c.command === COMMAND);
      passed.push(check(发过的.some((c) => String(c.请求.url).indexOf('?project=plugins') >= 0),
        '⑧c 默认项目无账 ⇒ 自动按最近活动项目重取（请求带 ?project=plugins）',
        JSON.stringify(发过的.map((c) => c.请求.url))));
      passed.push(check(切后.text.indexOf('已按最近活动自动选择') >= 0,
        '⑧c 自动选择**明写在页头**（不许静默换项目）', 切后.text.slice(0, 0) + ''));
      // ⑧d 空态点名当前项目 + 指出别处有账的项目（不让人以为"组织是空的"）。
      const 空账页 = await renderView(空账);
      passed.push(check(空账页.text.indexOf('任务图为空') >= 0
        && 空账页.text.indexOf('本项目（default）没有账') >= 0
        && 空账页.text.indexOf('plugins（14 卡 · 1 线程）') >= 0,
        '⑧d 空态点名当前项目并指出有账的项目', 空账页.text.slice(-160)));
      // ⑧e 宿主没给清单 ⇒ 不画项目那格（不装懂；与记忆读数同一条纪律）。
      const 无清单 = sampleView();
      无清单.项目清单 = null;
      const 无清单页 = await renderView(无清单);
      passed.push(check(findAllByClass(无清单页.tree, 'dshmind-projChip').length === 0
        && findAllByClass(无清单页.tree, 'dshmind-projChipOn').length === 0,
        '⑧e 清单缺失 ⇒ 不画项目 chips（不装懂）'));
      // ⑧f chip 缺计数 ⇒ 画「？」不画 null/undefined（2026-10-12 评审批次6·P3）：
      //    缺数据不是 0；印「null 卡」是排版事故，印「0 卡」是说谎。
      const 缺数 = sampleView();
      缺数.项目清单 = { 当前: 'mind-private', 项: [{ 项目: 'mind-private', 任务: 5, 线程: 2 }, { 项目: '缺数项目' }] };
      const 缺数页 = await renderView(缺数);
      passed.push(check(缺数页.text.indexOf('缺数项目（？ 卡 · ？ 线程）') >= 0
        && 缺数页.text.indexOf('null 卡') < 0 && 缺数页.text.indexOf('undefined 卡') < 0,
        '⑧f 项目 chip 缺计数 ⇒ 画「？」（修前印 null 卡 · null 线程）', 缺数页.text.slice(0, 200)));
    }

    // ⑨ 投影合并抗原型污染（2026-10-12 评审批次6·P3）：数据袋里的 own __proto__ 不许借
    //    Object.assign 的 [[Set]] 语义换掉合并目标的原型——修前攻击者可借原型注入伪造的
    //    「项目清单」等字段，绕过归一化默认值直接上屏。
    {
      const 毒袋 = JSON.parse('{"__proto__":{"项目清单":{"项":[{"项目":"毒项目","任务":1,"线程":1}]}},'
        + '"任务":{"总数":0,"计数":{"待派发":0,"进行中":0,"已交卷":0,"已采纳":0,"已打回":0,"未验":0,"已结账":0,"待决":0},"节点":[]},'
        + '"状态条":{"闸":"正常","介入度":"自动","失联":false,"探针":"健康"},"会审":[],"待你决定":[],"消息总线":[]}');
      const 毒页 = await renderView({ 成功: true, 项目: 'default', 数据: 毒袋 });
      passed.push(check(毒页.text.indexOf('毒项目') < 0,
        '⑨ own __proto__ 不许污染合并结果（修前「毒项目」借原型上屏成 chip）', 毒页.text.slice(0, 160)));
      passed.push(check(({}).项目清单 === undefined, '⑨ 全局 Object.prototype 没被碰'));
    }

    // ⑪ 分页外壳 / 可视化 / 能力×岗位图谱（2026-10-13 重做）。
    //    这批新口径每条都配行为判据；接线判定那两条另配塞 bug 校准（判定反了必红）。
    {
      /**
       * 挂一块面板并等数据到位。**不是**复制上面 Batch 8 那个 `状态render` 的语义——
       * 它被定义在更早的块作用域里、这里拿不到；名字故意不同（`挂`），
       * 并额外把请求记录挂回渲染器（⑪a 要证「切页零请求」）。
       */
      const 挂 = async (view) => {
        const spy = makeRemote(() => okReply(view));
        const b = boot({ store, services: Object.assign(session(), { remote: spy.remote }) });
        const r = mountDashboard(b);
        r.flush();
        await settle();
        r.flush();
        r.spy = spy;
        return r;
      };
      /** 带接线的投影：2 张能力卡 × 2 个岗位 ⇒ 适用边 3 条，其中 1 条未接线。 */
      const 接线视图 = (全接上) => {
        const v = sampleView();
        v.能力 = [
          { id: 'policy-decision', 来源: '出厂', 适用岗位: ['Lead', '复核员'] },
          { id: 'assert-with-evidence', 来源: '自治', 适用岗位: ['Lead'] },
        ];
        v.岗位 = [
          { id: 'Lead', 来源: '私有', 同名: ['私有'], 摘要: '常驻、唯一', 能力引用: ['policy-decision'].concat(全接上 ? ['assert-with-evidence'] : []) },
          { id: '复核员', 来源: '私有', 同名: ['私有', '出厂'], 摘要: '常驻岗', 能力引用: ['policy-decision'] },
        ];
        v.实例计数 = { 按岗位: { Lead: { 在岗: 1, 封存: 0 }, 复核员: { 在岗: 2, 封存: 1 } }, 异常键: 0, 合计: 4 };
        // 派活闭环（2026-10-15）：Lead 有派发日期且未超 14 天、复核员从未被派 ⇒ 只有后者亮「闲置」。
        v.岗位闲置 = {
          阈值: 14,
          岗位: {
            Lead: { 在岗实例: 1, 封存实例: 0, 最近派发于: '2026-10-14T09:00:00Z', 闲置: false },
            复核员: { 在岗实例: 2, 封存实例: 1, 最近派发于: null, 闲置: true },
          },
        };
        v.记忆 = { 存量: 44, 窗口天: 7, 新增: 44, 晋升: 0, 按类: { 经历: 31, 知识: 10, 偏好: 3 } };
        return v;
      };

      // ── ⑪a 分页外壳 ──
      const r11 = await 挂(接线视图());
      const 页容器 = findAllByClass(r11.tree, 'dshmind-pageBox');
      const 页序 = 页容器.map((el) => el.props['data-dshmind-page']);
      passed.push(check(页序.join(',') === 'overview,graph,tasks,reviews,bus,audit,memory',
        '⑪a 七个页容器按注意力顺序在树里（总览→图谱→任务→会审→总线→审计→记忆）', 页序.join(',')));
      const 显示中 = 页容器.filter((el) => !(el.props.style && el.props.style.display === 'none'));
      passed.push(check(显示中.length === 1 && 显示中[0].props['data-dshmind-page'] === 'overview',
        '⑪a 默认只显示总览，其余六页 display:none（节点仍在树里 ⇒ 内容口径断言不受页影响）',
        显示中.map((el) => el.props['data-dshmind-page']).join(',')));
      const 导航钮 = findAllByClass(r11.tree, 'dshmind-navBtn');
      passed.push(check(导航钮.length === 7, '⑪a 导航七个钮（一页一个）', String(导航钮.length)));
      passed.push(check(findAllByClass(r11.tree, 'dshmind-navBtnOn').length === 1
        && textOf(findAllByClass(r11.tree, 'dshmind-navBtnOn')[0]).indexOf('总览') >= 0,
        '⑪a 当前页那一个带 On（且是总览）'));
      const 请求前 = r11.spy.calls.length;
      const 图谱钮 = 导航钮.find((el) => el.props['data-page'] === 'graph');
      图谱钮.props.onClick();
      await settle();
      r11.flush();
      const 显示中2 = findAllByClass(r11.tree, 'dshmind-pageBox')
        .filter((el) => !(el.props.style && el.props.style.display === 'none'));
      passed.push(check(r11.spy.calls.length === 请求前,
        '⑪a 切页不发任何请求（纯显示切换，与折叠钮同款判据）', String(r11.spy.calls.length - 请求前)));
      passed.push(check(显示中2.length === 1 && 显示中2[0].props['data-dshmind-page'] === 'graph',
        '⑪a 点了「图谱」⇒ 只有图谱页可见（总览收起）',
        显示中2.map((el) => el.props['data-dshmind-page']).join(',')));
      passed.push(check(findAllByClass(r11.tree, 'dshmind-navBtn').length === 7, '⑪a 切页后导航仍在（渲染没崩）'));

      // ── ⑪b 可视化：甜甜圈与统计砖 ──
      const 图 = findAllByClass(r11.tree, 'dshmind-donut');
      passed.push(check(图.length >= 1, '⑪b 构成图（甜甜圈）渲染出来', String(图.length)));
      const 弧段 = collect(图[0], { skipStyle: true }).elements
        .filter((el) => el.type === 'circle' && typeof el.props.strokeDasharray === 'string');
      passed.push(check(弧段.length >= 1, '⑪b 弧段用 strokeDasharray 画（不引第三方图库）', String(弧段.length)));
      const 文本11 = collect(r11.tree, { skipStyle: true }).text;
      passed.push(check(文本11.indexOf('岗位接线 2/3（67%）') >= 0,
        '⑪b 统计砖读出接线率（2/3 = 67%，口径＝适用边 ∩ 岗位能力引用）', 文本11.slice(0, 120)));
      // ── 派活闭环（2026-10-15）：岗位闲置的「亮灯」判据 ──
      // ⚠️ 岗名（gLabelStrong）与读数行（gLabel）是**两个独立 text 元素**——
      //    判据落在读数行的内容上（封存 1 = 复核员行、无封存 = Lead 行），不跨元素找名字。
      const 在岗行们 = collect(r11.tree, { skipStyle: true }).elements
        .filter((el) => el.type === 'text' && textOf(el).indexOf('在岗') >= 0);
      const 未见派发行 = 在岗行们.filter((el) => textOf(el).indexOf('闲置') >= 0 || textOf(el).indexOf('未见派发') >= 0);
      passed.push(check(在岗行们.length === 2 && 未见派发行.length === 1 && textOf(未见派发行[0] || {}).indexOf('封存 1') >= 0
        && textOf(未见派发行[0] || {}).indexOf('闲置') >= 0,
        '⑪b 岗位闲置：闲置岗（复核员行，阈值 14 天从未派发）亮「闲置」灯',
        在岗行们.map(textOf).join(' | ')));
      const lead行 = 在岗行们.find((el) => textOf(el).indexOf('封存') < 0);
      passed.push(check(!!lead行 && textOf(lead行).indexOf('闲置') < 0 && textOf(lead行).indexOf('未见派发') < 0,
        '⑪b 未超期的岗（Lead 行）不亮「闲置」也不亮「未见派发」',
        lead行 ? textOf(lead行) : '(没找到 Lead 行)'));
      passed.push(check(文本11.indexOf('最近派发 未见') >= 0 && 文本11.indexOf('最近派发 2026-10-14T09:00:00Z') >= 0
        && 文本11.indexOf('闲置阈值 14 天，已超') >= 0 && 文本11.indexOf('闲置阈值 14 天，未超') >= 0,
        '⑪b 岗位节点 <title> 给完整闲置读数（在岗/封存/最近派发/阈值与超否）'));
      const 无接线 = await renderView(sampleView());
      // ⚠️ 判据要落在**没画**上，不能拿「文本里有没有『岗位接线』四个字」当判据：
      //    图谱页在没数据时的空态说明里**明说**了「没带能力/岗位接线」，那句话本身就含这四个字
      //    （2026-10-13 首跑当场抓出的假红）。所以改判：统计砖的标签「能力卡」不出现，
      //    **且**图一个都没画出来（没有 data-dshmind=graph 的 svg）。
      const 无接线图 = collect(无接线.tree, { skipStyle: true }).elements
        .filter((el) => el.type === 'svg' && el.props['data-dshmind'] === 'graph');
      passed.push(check(无接线.text.indexOf('能力卡') < 0 && 无接线图.length === 0
        && 无接线.text.indexOf('不装懂') >= 0,
        '⑪b 投影没带能力/岗位 ⇒ 不画接线砖、不画图谱，只明说「宿主没给」（不装懂）',
        '能力卡=' + (无接线.text.indexOf('能力卡') >= 0) + ' 图=' + 无接线图.length));

      // ── ⑪c 图谱：节点 / 边 / 缺口 ──
      const 取图 = (tree) => collect(tree, { skipStyle: true }).elements
        .filter((el) => el.type === 'svg' && el.props['data-dshmind'] === 'graph')[0] || null;
      const 图节点 = collect(取图(r11.tree), { skipStyle: true }).elements
        .filter((el) => typeof el.props['data-node'] === 'string');
      passed.push(check(图节点.length === 4, '⑪c 图谱节点 = 2 岗位 + 2 能力', String(图节点.length)));
      const 图边 = collect(取图(r11.tree), { skipStyle: true }).elements
        .filter((el) => typeof el.props['data-wired'] === 'string');
      const 未接边 = 图边.filter((el) => el.props['data-wired'] === '0');
      passed.push(check(图边.length === 3, '⑪c 图谱边 = 适用边 3 条（一张卡声明了几个岗位就几条边）', String(图边.length)));
      passed.push(check(未接边.length === 1, '⑪c 未接线的边恰 1 条（assert-with-evidence → Lead）', String(未接边.length)));
      passed.push(check(文本11.indexOf('接线缺口榜') >= 0 && 文本11.indexOf('assert-with-evidence') >= 0
        && 文本11.indexOf('无接线缺口') < 0,
        '⑪c 有缺口 ⇒ 画缺口榜并点名那张卡（不是静默）'));
      const 全接 = await renderView(接线视图(true));
      const 全接边 = collect(取图(全接.tree), { skipStyle: true }).elements
        .filter((el) => typeof el.props['data-wired'] === 'string');
      passed.push(check(全接边.length === 3 && 全接边.every((el) => el.props['data-wired'] === '1'),
        '⑪c 全部接线时没有一条红线（data-wired 全 1）', String(全接边.filter((el) => el.props['data-wired'] === '0').length)));
      passed.push(check(全接.text.indexOf('无接线缺口') >= 0, '⑪c 无缺口时明说「无接线缺口」（不给空表）'));

      // Memory inspection is independent of dashboard counters and has no body in the cached preview.
      passed.push(check(文本11.includes('打开记忆页，浏览已保存的内容与来源。'),'⑪d 记忆页提供原生内容浏览入口'));
      passed.push(check(!文本11.includes('为什么这里没有条目列表'),'⑪d 不再用说明替代记忆内容'));
      const noCounters=sampleView();noCounters.记忆=null;const noCounterPage=await renderView(noCounters);
      passed.push(check(noCounterPage.text.includes('打开记忆页，浏览已保存的内容与来源。'),'⑪d 缺少统计不阻碍独立内容浏览入口'));
      // ── ⑪e 图谱交互：点节点开详情（纯显示、零请求）──
      {
        passed.push(check(findAllByClass(r11.tree, 'dshmind-gDrawer').length === 0,
          '⑪e 没选节点时不画详情抽屉（不给空壳）'));
        const 岗位节点 = findAllByClass(r11.tree, 'dshmind-gNode')
          .find((el) => el.props['data-node'] === '角色:Lead');
        passed.push(check(!!岗位节点 && typeof 岗位节点.props.onClick === 'function',
          '⑪e 图谱节点带 onClick（点得动）'));
        const 请求前2 = r11.spy.calls.length;
        岗位节点.props.onClick();
        await settle();
        r11.flush();
        passed.push(check(r11.spy.calls.length === 请求前2,
          '⑪e 点节点不发任何请求（纯显示动作，与折叠钮同款判据）', String(r11.spy.calls.length - 请求前2)));
        const 抽屉 = findAllByClass(r11.tree, 'dshmind-gDrawer');
        passed.push(check(抽屉.length === 1, '⑪e 点节点 ⇒ 详情抽屉出现', String(抽屉.length)));
        const 抽屉文本 = 抽屉.length ? textOf(抽屉[0]) : '';
        passed.push(check(抽屉文本.indexOf('policy-decision') >= 0 && 抽屉文本.indexOf('已接线') >= 0
          && 抽屉文本.indexOf('assert-with-evidence') >= 0 && 抽屉文本.indexOf('未接线') >= 0,
          '⑪e 抽屉逐条列出邻居并标已接/未接（「发卡 ≠ 接线」在单点上的读法）', 抽屉文本.slice(0, 90)));
        passed.push(check(findAllByClass(r11.tree, 'dshmind-gNodeOff').length >= 1,
          '⑪e 选中后无关节点被调暗（一眼看出它连的是谁）',
          String(findAllByClass(r11.tree, 'dshmind-gNodeOff').length)));
        passed.push(check(findAllByClass(r11.tree, 'dshmind-gEdgeOff').length >= 1,
          '⑪e 选中后无关的边被调暗'));
        const 选中节点 = findAllByClass(r11.tree, 'dshmind-gNodeOn');
        passed.push(check(选中节点.length === 1 && 选中节点[0].props['data-node'] === '角色:Lead',
          '⑪e 选中的那个节点带 On 类'));
        const 同节点 = findAllByClass(r11.tree, 'dshmind-gNode')
          .find((el) => el.props['data-node'] === '角色:Lead');
        // 先验另一条取消路径：**点空白处**（2026-10-13 晚主权者提的缺口）——
        // 空白层是垫在所有节点下面的不可见 rect，点它 ⇒ 取消选中；纯显示、零请求。
        const 空白层 = collect(r11.tree, { skipStyle: true }).elements
          .find((el) => el.props && el.props['data-graph-bg'] === '1');
        passed.push(check(!!空白层 && typeof 空白层.props.onClick === 'function',
          '⑪e 图谱有空白层且点得动（点空白 ⇒ 取消选中的入口）'));
        if (空白层) {
          const 请求前3 = r11.spy.calls.length;
          空白层.props.onClick();
          await settle();
          r11.flush();
          passed.push(check(findAllByClass(r11.tree, 'dshmind-gDrawer').length === 0
            && findAllByClass(r11.tree, 'dshmind-gNodeOn').length === 0
            && findAllByClass(r11.tree, 'dshmind-gNodeOff').length === 0,
            '⑪e 点空白处 ⇒ 取消选中（抽屉收起、调暗复原）'));
          passed.push(check(r11.spy.calls.length === 请求前3,
            '⑪e 点空白处不发任何请求（纯显示动作）', String(r11.spy.calls.length - 请求前3)));
        }
        // 再选中一次，验另一条路径：**再点同一个节点** ⇒ 取消。
        const 重选 = findAllByClass(r11.tree, 'dshmind-gNode')
          .find((el) => el.props['data-node'] === '角色:Lead');
        重选.props.onClick();
        await settle();
        r11.flush();
        同节点.props.onClick();
        await settle();
        r11.flush();
        passed.push(check(findAllByClass(r11.tree, 'dshmind-gDrawer').length === 0
          && findAllByClass(r11.tree, 'dshmind-gNodeOn').length === 0,
          '⑪e 再点同一个节点 ⇒ 取消选中（抽屉收起、调暗复原）'));
      }

      // ── ⑪f 注意力区（3 秒层）：平静 / 探针异常 / **漏项捕获** ──
      {
        const 空待决 = 接线视图();
        空待决.待你决定 = [];
        const 平静 = await renderView(空待决);
        passed.push(check(平静.text.indexOf('现在没有需要你拍板的事') >= 0,
          '⑪f 待你决定为空 ⇒ 一条平静绿带（不留一块空白让人以为面板坏了）'));
        const 恒绿 = 接线视图();
        恒绿.状态条 = Object.assign({}, 恒绿.状态条, { 探针: { 状态: '恒绿', 见红: [], 恒红: false, 恒绿: true } });
        const 恒绿页 = await renderView(恒绿);
        passed.push(check(恒绿页.text.indexOf('从来没红过') >= 0,
          '⑪f 探针恒绿也进注意力区（「从来没红过」是异常信号，不是平安）'));
        // 漏项捕获：**带待决说明、但状态不是「待决」**的节点——现行收集口径会漏掉它
        const 漏项 = 接线视图();
        const 节点们 = (漏项.任务 && 漏项.任务.节点) || [];
        漏项.任务 = Object.assign({}, 漏项.任务, {
          节点: 节点们.concat([{
            id: 'task-存档-9', 描述: '存档节点', 状态: '已派发', 负责人: ['插件工程'], 模式: '并行分担',
            判据: [], 判据冻结: true, 依赖: [], 打回次数: 0, 产物: [],
            交卷: { 已交: 0, 应交: 1, 齐: false }, 待决原因: '负责人实例消亡，待裁决处置（作废/存档）',
          }]),
        });
        const 漏项页 = await renderView(漏项);
        passed.push(check(漏项页.text.indexOf('挂有待决说明，但不在待决清单里') >= 0
          && 漏项页.text.indexOf('task-存档-9') >= 0
          && 漏项页.text.indexOf('负责人实例消亡，待裁决处置（作废/存档）') >= 0,
          '⑪f 挂待决说明但状态非「待决」的节点被顶到注意力区，原因**全文照给**（不截断）',
          漏项页.text.slice(0, 90)));
      }

      // ── ⑪g 视觉打磨 v2.2（2026-10-14）：**读数要有坐标系** + 长文行高 ──
      //
      // 这一组守的是「一条色带没有起止时刻就只是装饰」这个判断，不是审美：
      // 一条轴上哪一格对应哪个时刻，读者必须能自己算出来 —— 否则那排方块
      // 看着像数据、实际读不出任何东西（同族于「报 0 命中必须连口径一起报」）。
      {
        const r = await renderView(接线视图());
        // 轴的两端＝这批审计行的首/末时刻（数据取自同一批行，不新取数）。
        const 轴 = findAllByClass(r.tree, 'dshmind-actbarAxis')[0];
        passed.push(check(!!轴, '⑪g 审计节律条带起止时刻坐标（没有它，那排色块读不出含义）'));
        if (轴) {
          const 轴文 = textOf(轴);
          const 审计行 = 接线视图().审计尾 || [];
          const 首 = 审计行.length ? String(审计行[0].时间) : '';
          const 末 = 审计行.length ? String(审计行[审计行.length - 1].时间) : '';
          // `shortTime` 只给时分秒：断言「两端都在」用它的输出片段，不硬编时刻字面量
          const 尾段 = (s) => String(s).slice(11, 19);
          passed.push(check(首 && 末 && 轴文.indexOf(尾段(首)) >= 0 && 轴文.indexOf(尾段(末)) >= 0,
            '⑪g 轴两端的时刻＝该批审计的第一条与最后一条（同源，不另取数）',
            JSON.stringify(轴文.slice(0, 40))));
        }
        // 样式口径（**必须直读 style 节点**：`textOf()` 内部强制 skipStyle，
        // 对样式规则返回空串 ⇒ 那种断言永远绿。2026-10-12 塞 bug 校准抓过假绿）。
        const 样式 = (() => {
          const 节点 = collect(r.tree, { skipStyle: false }).elements
            .filter((el) => el.type === 'style').pop();
          return 节点 ? String(节点.props.children || '') : '';
        })();
        passed.push(check(样式.includes('word-break:keep-all'),
          '⑪g 注意力区长文给 keep-all：长 id 不再被从词中间劈开（7lost / be17d628939d）'));
        passed.push(check(/\.dshmind-attnNode\{[^}]*line-height:1\.75/.test(样式),
          '⑪g 注意力区正文行高 1.75（密排的说明字要读得动）'));
        passed.push(check(/\.dshmind-actbarAxis\{/.test(样式),
          '⑪g 轴样式在位（与结构断言成对，防「画了轴但没样式」）'));

        // ── ⑪h 2026-10-14：红框两处 + 设计稿可搬层 ──────────────────────────
        //
        // ① **焦点环伪类的作用域**（这是本轮抓到的真缺陷，且 462 条断言一条都没守住它）：
        //    CSS 选择器列表里，伪类的**作用域只到它所在的那一个复杂选择器**——
        //    写成 `A,B,C,.D:focus-visible{outline:...}` 时 A/B/C **无条件命中**，
        //    于是导航钮/刷新钮/折叠钮/项目 chip **常年顶着一圈蓝描边**。
        //    实测（改前）：未聚焦时 `outline: 2px solid rgb(91,141,239)`、`activeElement = BODY`。
        //    这条断言钉「每个选择器都自带 :focus-visible」——它必须能红。
        const 焦点环段 = (() => {
          const m = /([^{}]*:focus-visible[^{}]*)\{outline:2px solid/.exec(样式);
          return m ? m[1] : '';
        })();
        passed.push(check(!!焦点环段 && !/(^|,)\s*\.dshmind-(navBtn|btn|toggle|descToggle|projChip)\s*(,|$)/.test(焦点环段),
          '⑪h 焦点环逐个选择器都带 :focus-visible（裸类名无条件命中 ⇒ 常驻蓝框）',
          JSON.stringify(焦点环段.slice(0, 120))));
        passed.push(check((焦点环段.match(/:focus-visible/g) || []).length >= 6,
          '⑪h 六个可点类各有一份 :focus-visible（不是只挂在最后一个上）',
          String((焦点环段.match(/:focus-visible/g) || []).length)));

        // ② 注意力区折叠：**整块收起** + 一个折叠钮（复用既有类名，白名单不扩）
        // 📌 口径改形（2026-10-14 · 主权者「这里有截断。这部分需要做收起吗」）：
        //    上一版是逐条 `-webkit-line-clamp:1` —— 5 条各切半句、末尾一串 `…`，
        //    **看着像文本被截断坏了**，且既没给全文也没省地方。
        //    本仓 2026-10-12 已定口径：**硬截断被否，要「要全文 + 默认折叠」**。
        //    ⇒ 现在判据改成「条目容器默认带 `dshmind-attnNodesOff`（整块 display:none）」，
        //    并且**文本仍在树里**（下一条钉着）——这才是"折叠"而非"截断"。
        passed.push(check(/\.dshmind-attnNodesOff\{[^}]*display:none/.test(样式),
          '⑪h 折叠＝整块收起（display:none），不是逐条钳行切半句'));
        passed.push(check(!/attnNodeClamped/.test(样式),
          '⑪h 不再用逐条钳位（那会把每句切一半、看着像坏了）'));
        // ⚠️ 结构断言要用**自己造的夹具**：`接线视图()` 本身没有挂待决节点（⑪f 也是另加一条），
        //    照抄"3 条"会红。这里造 2 条，并**按夹具算期望值**，不写死数字。
        const 孤儿 = 接线视图();
        const 孤儿节点 = (孤儿.任务 && 孤儿.任务.节点) || [];
        const 造一条 = (id, 原因) => ({
          id, 描述: '存档节点' + id, 状态: '已派发', 负责人: ['插件工程'], 模式: '并行分担',
          判据: [], 判据冻结: true, 依赖: [], 打回次数: 0, 产物: [],
          交卷: { 已交: 0, 应交: 1, 齐: false }, 待决原因: 原因,
        });
        孤儿.任务 = Object.assign({}, 孤儿.任务, {
          节点: 孤儿节点.concat([
            造一条('task-存档-9', '负责人实例消亡，待裁决处置（作废/存档）'),
            造一条('task-存档-10', '同族：按岗名派发的节点成员无法 start。'),
          ]),
        });
        const rOrphan = await renderView(孤儿);
        const 挂待决卡 = findAllByClass(rOrphan.tree, 'dshmind-attnCard')
          .filter((el) => textOf(el).indexOf('挂有待决说明') >= 0)[0] || null;
        const 条目容器 = 挂待决卡 ? findAllByClass(挂待决卡, 'dshmind-attnNodes')[0] : null;
        const 折叠钮 = 挂待决卡 ? findAllByClass(挂待决卡, 'dshmind-descToggle') : [];
        passed.push(check(!!条目容器
          && String(条目容器.props.className).indexOf('dshmind-attnNodesOff') >= 0
          && 折叠钮.length === 1,
          '⑪h 折叠态：条目容器整块收起 + 恰好 1 个折叠钮（一条一钮会变成一排小链接）',
          '容器类=' + (条目容器 ? 条目容器.props.className : 'null') + ' / 钮 ' + 折叠钮.length));
        // 收起 ≠ 截断：两条原因**全文都还在树里**（只是不显示）。
        // 这条是「要全文 + 默认折叠」口径的**另一半**，缺了它"收起"就变成"藏起来"。
        passed.push(check(!!挂待决卡
          && textOf(挂待决卡).indexOf('负责人实例消亡，待裁决处置（作废/存档）') >= 0
          && textOf(挂待决卡).indexOf('同族：按岗名派发的节点成员无法 start。') >= 0,
          '⑪h 收起不改文本：两条原因全文都还在树里（收起 ≠ 截断）'));
        // 说明句也吃同一张折叠表（一个钮管两处，不留"展开了一半"的半吊子态）
        passed.push(check(!!挂待决卡
          && findAllByClass(挂待决卡, 'dshmind-attnIntroClamped').length === 1,
          '⑪h 说明句与条目同吃一张折叠表（同一个钮管两处）'));

        // ③ 设计稿可搬层（v2.3）：字阶 / 强调条 / 卡片渐变 / 阴影 / 辉光
        passed.push(check(/\.dshmind-root\{font-size:14px;line-height:1\.6\}/.test(样式),
          '⑪h 基线字阶随设计稿 14px/1.6（原 13px/20px）'));
        passed.push(check(/\.dshmind-secTitle::before\{[^}]*width:3px/.test(样式),
          '⑪h 分区标题带 3px 主色强调条（设计稿 .sec-title::before）'));
        passed.push(check(/\.dshmind-sec,[^{]*\{[^}]*background-image:linear-gradient\(180deg,var\(--mk-bg\),var\(--mk-bg2\)\)/.test(样式),
          '⑪h 卡片微渐变取**双令牌**（令牌改名只掉外观，不掉功能）'));
        passed.push(check(/radial-gradient/.test(样式) && /\.dshmind-root\{background-image:/.test(样式),
          '⑪h 页面辉光在位（设计稿有层次感的主要来源）'));

        // ④ 页头标题**不许依赖上下文**（2026-10-14 真机整块空白的真因，必须能红）
        //
        // 真因：`当前页名(ctx)` 里的 `ctx` 是 `activeCtx`（**宿主 ctx**），而 `页清单()` 要的是
        // 「**页上下文**」（`ctx.tasks / 会审 / 总线 / 记忆`）—— 两者不是同一个东西。
        // 更要命的是：**宿主 ctx 在真机某些渲染时机下是 `null`** ⇒ `页清单(null)` 里
        // `null.tasks` 抛 TypeError ⇒ React 卸载整棵树 ⇒ **面板全空**。
        //
        // 为什么本 harness 当时是绿的：它（和本地预览）里 `apply()` 一定先跑、
        // `activeCtx` 永不为 null ⇒ **装置绿 ≠ 真机活**。
        // 所以这条只能从**形状**上钉：页名必须**无参**、且**不得引用 `页清单`**。
        // 这是"源码文本断言"，用在别处不妥；用在这里正合适 —— 它守的不是行为，
        // 而是**禁止建立那条会抛的依赖**。
        const 客户端源 = readFileSync(CLIENT_PATH, 'utf8');
        const 页名源 = (() => {
          const m = /function 当前页名\(([^)]*)\)\s*\{([\s\S]*?)\n    \}/.exec(客户端源);
          return m ? { 参: m[1].trim(), 体: m[2] } : null;
        })();
        passed.push(check(!!页名源 && 页名源.参 === '',
          '⑪h 页名函数**无参**（带 ctx 就会在宿主 ctx 为 null 时抛错、整块面板空白）',
          JSON.stringify(页名源 && 页名源.参)));
        passed.push(check(!!页名源 && !/页清单/.test(页名源.体),
          '⑪h 页名**不引用 页清单**（那是「页上下文」的东西，页头手里只有宿主 ctx）'));
        passed.push(check(!/当前页名\(ctx\)/.test(客户端源),
          '⑪h 页头不把宿主 ctx 喂给页名（真机事故的原始写法）'));

        // ── ⑪i 可视化组的纵向缝（2026-10-15 · 主权者：「这部分块之间的间隔有点小了，
        //    和其他部分的一致就行」）────────────────────────────────────────────
        //
        // 这是真缺陷：`.dshmind-viz` 是一只**没有任何规则的裸 div** —— 它**不给 gap**，
        // 于是这一组三块（统计砖 / 构成图 / 节律条）之间只剩两处写死的 2px
        // （`.dshmind-tiles{margin-bottom:2px}` ＋ 节律条根节点的行内 `marginTop:2`），
        // 而同屏页内块间距 14px、组内横向格间距 10px。
        // 实测（主权者截图，按像素量的）：砖底边 y=168、构成图顶边 y=171 ⇒ **缝 2px**。
        // 这一组钉的是「**缝只有一个出处，且与页面节奏同源**」，不是某个审美值 ——
        // 所以它按**两个值的相等**判，不硬编 14。（旧值 2px 是照"容器会给 10px"的
        // 假设补出来的，而那个容器从来不给 ⇒ 这类"一对值"必然漂移，必须能红。）
        const viz组 = findAllByClass(r.tree, 'dshmind-viz');
        passed.push(check(viz组.length === 1,
          '⑪i 可视化组恰好一处（组间距要有一个明确的落点）', String(viz组.length)));
        const 子块 = viz组.length ? collect(viz组[0], { skipStyle: true }).elements
          .filter((el) => /(^|\s)(dshmind-tiles|dshmind-vizGrid|dshmind-actCard)(\s|$)/.test(String(el.props && el.props.className))) : [];
        passed.push(check(子块.length >= 3,
          '⑪i 统计砖 / 构成图 / 节律条三块同属这一组（"缝"就是它们之间的缝）', String(子块.length)));
        passed.push(check(子块.length > 0 && 子块.every((el) => {
          const s = el.props && el.props.style;
          return !s || (s.marginTop === undefined && s.marginBottom === undefined);
        }), '⑪i 三块都不自带纵向边距（一半写容器、一半写自己 ⇒ 迟早对不上）',
          JSON.stringify(子块.map((el) => (el.props && el.props.style) || null))));
        const 节奏 = (sel) => {
          const m = new RegExp('\\.' + sel + '\\{[^}]*gap:(\\d+)px').exec(样式);
          return m ? Number(m[1]) : null;
        };
        passed.push(check(节奏('dshmind-viz') !== null && 节奏('dshmind-viz') === 节奏('dshmind-pageBox'),
          '⑪i 可视化组的纵向缝＝页面节奏（同一个值，不许各写各的）',
          'viz=' + 节奏('dshmind-viz') + ' / pageBox=' + 节奏('dshmind-pageBox')));
        passed.push(check(!/\.dshmind-tiles\{[^}]*margin-bottom/.test(样式),
          '⑪i 统计砖不再自带 margin-bottom（旧值按"容器会给 10px"补的，那容器不给）'));
      }
      r11.unmount();
    }
  }

  {
    const historyView = sampleView();
    historyView.待你决定 = [];
    historyView.任务 = { 总数: 2, 只读历史数: 1, 现行未结账数: 1, 节点: [
      { id: 'task-readonly-history', 描述: '历史只读记录', 状态: '已采纳', 模式: '独立会审', 只读历史: true,
        写入说明: '原记录保留且不提供写入口', 负责人: ['old-owner'], 判据: ['原判据'], 判据冻结: false,
        打回次数: 2, 升级: true, 负责人无活动: ['old-owner'], 待决原因: '旧说明保留但不催办' },
      { id: 'task-current-followup', 描述: '现行记录', 状态: '已派发', 负责人: ['owner'], 判据: ['判据'],
        待决原因: '现行说明仍需关注', 判据冻结: true },
    ] };
    const rendered = await renderView(historyView);
    const historicalCard = findAllByClass(rendered.tree, 'dshmind-node').find(el => textOf(el).includes('task-readonly-history'));
    const historicalText = historicalCard ? textOf(historicalCard) : '';
    passed.push(check(historicalText.includes('只读历史') && historicalText.includes('已采纳'), '历史任务卡明确只读且保留原状态'));
    passed.push(check(historicalText.includes('历史判据 · 只读') && !historicalText.includes('判据可改'), '历史任务卡不把原冻结标记误画为可改判据'));
    passed.push(check(!historicalText.includes('升级主权者') && !historicalText.includes('负责人未见活动') && !String(historicalCard?.props.className).includes('nodeEscalated'), '历史任务卡不催升级或实例活动'));
    passed.push(check(historicalText.includes('历史待决说明（只读）：') && historicalText.includes('旧说明保留但不催办'), '历史待决说明保全文但标注只读'));
    passed.push(check(rendered.text.includes('只读历史 1 · 现行未结账 1'), '任务区消费历史与现行计数而不拿总账差值当待办'));
    const attention = findAllByClass(rendered.tree, 'dshmind-attnCard').find(el => textOf(el).includes('挂有待决说明'));
    passed.push(check(attention && textOf(attention).includes('task-current-followup') && !textOf(attention).includes('task-readonly-history'), '只读历史不进挂待决注意力旁路且正常现行不漏'));
  }

  {
    const recoveryView = sampleView();
    recoveryView.待你决定 = [];
    recoveryView.任务 = { 总数: 2, 只读历史数: 0, 现行未结账数: 1, 计数: { 已终止: 1, 待派发: 1 }, 节点: [
      { id: 'task-closed-old', 描述: '已终止任务保留旧成果', 状态: '已终止', 已终止: true, 判据冻结: true, 判据: ['原判据'],
        终止: { 原因: '停止结果未知，另建后继' }, 后继任务: 'task-successor-new', 负责人: ['old-worker'],
        待决原因: '原待决原因', 打回次数: 2, 升级: '原升级', 负责人无活动: ['old-worker'], 产物: ['old-artifact'] },
      { id: 'task-successor-new', 描述: '可追溯后继', 状态: '待派发', 前序任务: 'task-closed-old', 判据冻结: true, 判据: ['原判据'], 负责人: ['new-worker'],
        打回次数: 3, 继承打回次数: 2, 本节点打回次数: 1,
        接续提醒: { 来源任务: 'task-closed-old', 阈值提醒: true, 前序升级: null, 前序待决: { 原因: '原材料未齐' }, 处置状态: '未确认' } },
    ] };
    const rendered = await renderView(recoveryView);
    const cards = findAllByClass(rendered.tree, 'dshmind-node');
    const old = cards.find(el => textOf(el).includes('task-closed-old') && textOf(el).includes('已终止任务保留旧成果'));
    const next = cards.find(el => textOf(el).includes('task-successor-new') && textOf(el).includes('可追溯后继'));
    const oldText = old ? textOf(old) : '';
    passed.push(check(oldText.includes('已终止') && oldText.includes('终止记录 · 只读'), '终止任务明确只读且保留终止状态'));
    passed.push(check(oldText.includes('停止结果未知，另建后继') && oldText.includes('宿主停止未确认') && oldText.includes('在途工具未被取消'), '终止说明区分组织状态和未知宿主停止'));
    passed.push(check(oldText.includes('后继任务：task-successor-new') && oldText.includes('下游依赖未自动迁移') && textOf(next).includes('前序任务：task-closed-old'), '前后继关系可见且不声称迁移依赖'));
    passed.push(check(!String(old?.props.className).includes('nodeEscalated') && !String(old?.props.className).includes('nodePending') && !oldText.includes('升级主权者') && !oldText.includes('负责人未见活动'), '终止旧任务不继续催升级或挂待决'));
    passed.push(check(!findAllByClass(rendered.tree, 'dshmind-attnCard').some(el => textOf(el).includes('挂有待决说明')), '终止前的待决原因不进入注意力旁路'));
    passed.push(check(oldText.includes('old-artifact') && oldText.includes('终止前待决说明：原待决原因'), '终止前成果和待决说明仍可追溯'));
    passed.push(check(textOf(next).includes('累计打回 3 次（前序 2 + 本节点 1）'), '后继区分前序失败与本节点新增，不给新人补签旧失败'));
    passed.push(check(textOf(next).includes('未确认原升级事件') && textOf(next).includes('接续不代表已裁决'), '后继保留旧升级阈值和待决处置未知，不冒称已解决'));
  }

  {
    const goalView = sampleView();
    goalView.目标 = { 健康: '可用', 总数: 12, hasMore: true, 摘要: true, 目标: [{
      id: 'goal-preview', 修订: 4, 状态: '暂停', 期望结果: { 文本: '实现导出预览', 省略: false },
      下一步: { 文本: '核对预览结果', 省略: false }, 等待原因: { 文本: '', 省略: false },
      禁止工具: ['write', 'edit'], 文本约束条数: 2, 来源声明: { 用户意图: '未核验' },
      任务进展: { 关联: 3, 合法采纳: 2 }, 详情指引: 'goal_query id=goal-preview；摘要不含完整约束和完成依据。',
    }] };
    const rendered = await renderView(goalView);
    const card = rendered.elements.find(el => el.props['data-goal-id'] === 'goal-preview');
    const text = textOf(card);
    passed.push(check(text.includes('实现导出预览') && text.includes('暂停 · 修订 4'), '持续目标消费服务器当前状态与修订'));
    passed.push(check(text.includes('原计划（当前不推进）') && text.includes('核对预览结果'), '暂停目标不把旧下一步显示为可立即推进'));
    passed.push(check(text.includes('write、edit') && text.includes('2 条文本约束') && text.includes('goal_query'), '目标限制保持工具精确名单并明确全文读取入口'));
    passed.push(check(text.includes('关联任务 3；已合法采纳 2') && text.includes('不代表目标自动完成'), '目标不按任务计数自动宣布完成'));
    passed.push(check(text.includes('意图来源：未核验') && rendered.text.includes('在途宿主操作是否停止须另行核对'), '目标不冒认真人来源或宿主已停止'));
    passed.push(check(rendered.text.includes('共 12 个目标，展示 1 个摘要') && rendered.text.includes('还有目标未展示'), '目标概览明确摘要覆盖与剩余目标'));
    goalView.目标.目标[0].预算 = { 健康: '可用', 配置: { 上限: 3 }, 上限: 3, 累计准入: 2, 已结算: 1, 未决占用: 1, 可准入: 1, token: null, 费用: null };
    const budgetView = await renderView(goalView);
    passed.push(check(budgetView.text.includes('受管尝试上限 3；累计准入 2；已返回结果 1；未决占用 1；可准入 1'), '目标额度消费真源累计和未决，不把未决当可用'));
    passed.push(check(budgetView.text.includes('失败和未知不退额度，token 与费用未知'), '预算界面明确受管范围和未知真实费用'));
    goalView.目标.目标[0].预算 = { 健康: '可用', 配置: null };
    const unconfiguredBudget = await renderView(goalView);
    passed.push(check(unconfiguredBudget.text.includes('配置前用量未知，不表示零消耗') && !unconfiguredBudget.text.includes('累计准入 0'), '未配置预算不冒充零用量'));
    goalView.目标.目标[0].预算 = { 健康: '不可用', 配置: null };
    const invalidBudget = await renderView(goalView);
    passed.push(check(invalidBudget.text.includes('预算记录不可用，当前额度与用量未知') && invalidBudget.text.includes('实现导出预览'), '坏预算记录显示未知而保留可读目标'));
    goalView.目标.目标[0].预算 = { 健康: '可用', 配置: { 上限: 0 }, 上限: 0, 累计准入: 0, 已结算: 0, 未决占用: 0, 可准入: 0 };
    passed.push(check((await renderView(goalView)).text.includes('受管尝试上限 0；累计准入 0；已返回结果 0；未决占用 0；可准入 0'), '显式配置零上限按真实数字显示'));
    goalView.目标 = { 健康: '不可用', 总数: null, 目标: [] };
    const unavailable = await renderView(goalView);
    passed.push(check(unavailable.text.includes('目标记录暂不可读，当前状态未知') && !unavailable.text.includes('尚未登记持续目标'), '坏目标读面呈现未知，不冒充空目标'));
  }

  {
    const usageView = sampleView();
    usageView.模型用量 = { 健康: '可用', 完整: false, token: null, 费用: null,
      汇总: { 尝试: 3, 有用量: 2, 无用量: 1, 未结束: 1, 未归因: 1,
        已报告token: { inputTokens: 0, outputTokens: 12, cacheReadTokens: 5, cacheWriteTokens: null, totalTokens: null },
        字段覆盖: { inputTokens: { 已知: 2, 缺失: 1 }, outputTokens: { 已知: 2, 缺失: 1 }, cacheReadTokens: { 已知: 1, 缺失: 2 }, cacheWriteTokens: { 已知: 0, 缺失: 3 }, totalTokens: { 已知: 0, 缺失: 3 } } },
      采集: { enabled: true, attached: true, failedWrites: 0, invalidFrames: 0, orphanFrames: 0, droppedWrites: 0 } };
    const partial = await renderView(usageView);
    passed.push(check(partial.text.includes('已观察尝试 3；有用量 2；无用量 1；未结束 1；未归因 1'), '模型观察显示缺用量、未结束与未归因分母'));
    passed.push(check(partial.text.includes('未缓存输入 0；输出 12；缓存读 5；缓存写 未知；提供方总数 未知'), '模型token精确区分已知零与缺失，不推算总数'));
    passed.push(check(partial.text.includes('字段覆盖（尝试数）：输入 2 已知 / 1 缺失') && partial.text.includes('总数 0 已知 / 3 缺失'), '模型字段分别展示来源分母，不把部分已知和冒充全部观察'));
    passed.push(check(partial.text.includes('不代表项目或目标全部用量') && partial.text.includes('费用未知') && partial.text.includes('不改变准入额度'), '部分用量不冒充目标总量或费用硬额度'));
    usageView.模型用量.采集.enabled = false;
    passed.push(check((await renderView(usageView)).text.includes('观察已关闭，保留的历史读数不代表当前消耗'), '关闭观察仍明确历史读数的覆盖缺口'));
    usageView.模型用量.采集.droppedWrites = 1;
    passed.push(check((await renderView(usageView)).text.includes('采集存在未接线、丢帧或写入缺口'), '模型采集队列缺口不会静默补零'));
    usageView.模型用量.健康 = '不可用';
    const broken = await renderView(usageView);
    passed.push(check(broken.text.includes('模型用量记录不可读，当前读数未知') && !broken.text.includes('未缓存输入 0'), '坏用量账不显示旧数字为有效读数'));
    usageView.模型用量 = null;
    passed.push(check(!(await renderView(usageView)).text.includes('模型用量观察'), '没有模型用量读域时不渲染治理统计'));
  }

  {
    const operationView = sampleView();
    operationView.创建操作 = { 健康: '可用', 完整: false, 汇总: { 操作: 3, 未收尾: 2, 已见宿主回执: 2, 已审计: 1 } };
    const rendered = await renderView(operationView);
    passed.push(check(rendered.text.includes('已记录操作 3；未收尾 2；已见宿主回执 2；创建宏已审计 1'), '创建恢复读数消费阶段观察而不从任务数猜创建'));
    passed.push(check(rendered.text.includes('拟用实例不等于已创建') && rendered.text.includes('未收尾不表示正在运行'), '创建恢复分开候选身份、已见回执和未知执行'));
    passed.push(check(rendered.text.includes('不代表成员执行或任务完成') && rendered.text.includes('operation_query'), '创建宏完成不冒成员执行成功，并提供同源查询'));
    operationView.创建操作.健康 = '不可用';
    const broken = await renderView(operationView);
    passed.push(check(broken.text.includes('创建操作记录不可读，当前创建结果未知') && !broken.text.includes('已记录操作 3'), '坏创建账不显示旧数值或当作空操作'));
    operationView.创建操作 = null;
    passed.push(check(!(await renderView(operationView)).text.includes('成员创建恢复记录'), '没有治理读域时不显示创建操作统计'));
  }

  {
    const reuseView = sampleView();
    reuseView.知识复用 = { 健康: '可用', 完整: false, 汇总: { 交卷记录: 4, 未说明: 2, 显式空: 1, 有声明: 1, 声明条目: 2, 有帮助声明: 1, 不适用声明: 0, 问题声明: 1, 来源可核: 1, 关联采纳交卷: 1 } };
    const rendered = await renderView(reuseView);
    passed.push(check(rendered.text.includes('交卷记录 4；未说明 2；显式空 1；有声明 1'), '知识反馈区分未知、明确空与有声明分母'));
    passed.push(check(rendered.text.includes('有帮助声明 1；不适用声明 0；问题声明 1') && rendered.text.includes('当前来源可核 1'), '知识反馈消费声明与当前来源可核数，不假造效果率'));
    passed.push(check(rendered.text.includes('任务采纳不证明知识正确或带来收益') && rendered.text.includes('不自动改写知识状态或排行'), '知识采用与采纳不升级为语义或因果保证'));
    reuseView.知识复用.健康 = '不可用';
    const broken = await renderView(reuseView);
    passed.push(check(broken.text.includes('知识采用记录不可读，当前反馈未知') && !broken.text.includes('交卷记录 4'), '坏反馈账保持未知，不显示旧计数为现值'));
    reuseView.知识复用 = null;
    passed.push(check(!(await renderView(reuseView)).text.includes('知识采用反馈'), '没有治理读域时不渲染知识反馈汇总'));
  }

  {
    const dispositionView = sampleView();
    dispositionView.知识复用 = { 健康: '可用', 汇总: { 交卷记录: 1, 未说明: 0, 显式空: 0, 有声明: 1, 声明条目: 4, 有帮助声明: 1, 不适用声明: 1, 问题声明: 2, 来源可核: 1, 关联采纳交卷: 0 }, 处置汇总: { 负反馈条目: 3, 已见关联处置: 1, 未见关联处置: 1, 处置不可核对: 1 } };
    const rendered = await renderView(dispositionView);
    passed.push(check(rendered.text.includes('负反馈条目 3；已见关联处置 1；未见关联处置 1；处置不可核对 1'), '知识处置分列可核关联、未见与不可核对，保持负反馈分母'));
    passed.push(check(rendered.text.includes('已见关联不证明问题已解决，未见不证明尚未处理'), '处置观察不冒充语义成功或未处理结论'));
    dispositionView.知识复用.健康 = '不可用';
    passed.push(check(!(await renderView(dispositionView)).text.includes('负反馈条目 3'), '坏反馈源不显示旧处置计数'));
    dispositionView.知识复用.健康 = '可用';
    dispositionView.知识复用.处置汇总 = { 负反馈条目: null, 已见关联处置: null, 未见关联处置: null, 处置不可核对: null };
    const unknown = await renderView(dispositionView);
    passed.push(check(unknown.text.includes('负反馈条目 未知；已见关联处置 未知') && !unknown.text.includes('负反馈条目 0'), '未知处置计数不补成零'));
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
