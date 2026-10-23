// ═══════════════════════════════════════════════════════════════════════════════
// dsh-mind · 浏览器半边 —— 「心智 · 数字组织」任务控制台
// ═══════════════════════════════════════════════════════════════════════════════
//
// 它住在哪
// --------
// 两处注册，一个面板：
//   · `main`（keyed）—— 主内容区的**独立面板**，key = `dsh-mind`；
//   · `sidebar.panellist`（list）—— 侧边栏里的入口，排在插件入口（order 0）**下面**。
// 入口那一格只画图标：整行（按钮 / 标签 / 点击）由侧边栏自己的 PanelRow 负责。
//
// 为什么这一整个文件里没有模块语句
// ---------------------------------
// 宿主把这个 bundle 当**经典脚本**加载（`document.createElement('script')` + `el.src`），
// 不是 ES 模块。顶层写 `import` / `export` 会抛
// `SyntaxError: Cannot use import statement outside a module`，**整站 web 启动失败**——
// 不只是本插件不显示。所以整份源码刻意写成一个自包含文件，React 通过 loader 工厂的
// `require` 参数取（不重复安装、不用 CDN）。
//
// 为什么不用 `@deepseek-ai/dsh-client-ui-primitives`
// ------------------------------------------------
// 那是宿主内部包，接口随时变；本文件是纯 JS，没有类型检查兜底。一旦它抛错，
// 槽位条目直接空白（控制台：slot entry crashed）。所以控件自己写，样式只用
// `--dsw-alias-*` 主题令牌（附兜底色，令牌改名只会掉外观，不会掉功能）。
//
// 数据从哪来
// ----------
// **同源 `fetch` 路由**（Batch 7 换的）：`GET /plugins/dsh-mind/workbench` →
// `{成功, ...}`，`数据` 就是宿主半边算好的工作台投影 JSON
// （`src/workbench.js` 的 `projectWorkbench`，字段见 INTERFACES.md §2.10）。
// ⚠️ 旧的 `ctx.remote` → `commands.execute(sessionId, '/mind dashboard')` 通道**已停用**
// （真机实测永不返回，见下面「传输层」一节的注释）——别再照旧文档接回去。
// **任何一环缺失都不许抛**：拿不到就渲染「未连接」+ 上一次已知快照（localStorage）。
//
// 降级是合同，不是愿望
// --------------------
// 这个页面最坏的结果只能是「信息少」，绝不能是「空白」或「抛错」。

window.__ModuleLoader__.load({
  // ⚠️ 这个 id **必须等于被安装包的包名**：宿主是按包名去模块表里取这个 factory 的。
  // 写错不会「本插件不显示」，而是整站 web 启动失败 —— 改名前先看 package.json。
  // （2026-10-11 单包化：浏览器半区归属根包 dsh-mind，不再是独立的 dsh-mind-board 包。）
  id: 'dsh-mind',
  factory: function (require) {
    var React = require('react');

    // ── React 兜底 ──────────────────────────────────────────────────────────
    /**
     * **兜底不许静默**（Batch 6 修的第二条真缺陷）。
     *
     * 原来的写法是 `hook('useEffect', function () {})` —— 取不到就退化成空实现，
     * 于是设置页**永远停在「正在读取设置…」**：effect 根本没跑，页面看着像死的，
     * 而控制台一片安静。`useState` 的空 setter 同理（设了值不重渲染）。
     *
     * 「React 16.8+ 都有这几个 hook」这句假设**正是兜底存在的唯一理由** ——
     * 而它一旦不成立，这个兜底就把缺陷**藏起来**了。所以现在：
     *  · 兜底仍然给（页面不能因为少一个 hook 就整个空白 —— 那更糟）；
     *  · 但**明确报出来**：`console.error` 一句 + 一个可查询的标记（页面据此显示一句人话）。
     *
     * @param {string} name hook 名
     * @param {Function} fallback 退化实现
     * @returns {Function}
     */
    var 缺失的钩子 = [];
    function hook(name, fallback) {
      var fn = React && React[name];
      if (typeof fn === 'function') return fn;
      缺失的钩子.push(name);
      try {
        // 响亮：这不是"顺手告警"，是这个页面接下来会缺什么，必须能在控制台里看到。
        // ⚠️ 措辞别写成"页面会停在初始状态" —— 那是 Batch 6 之前的实话，现在已经不成立：
        // 取数已移出 `useEffect`（`apply` 里的裸轮询负责），所以缺 effect **只少一层增强**，
        // 不再影响出数据。写错这句话会把排障的人带偏。
        console.error('dsh-mind: React 缺少 ' + name + '（需要 16.8+）。已退化为静态兜底：'
          + '与本插件的数据无关（数据由轮询喂 store、靠 useState 重渲染）——'
          + '少的只是「挂载后立刻再拉一次」这类增强。');
      } catch (error) { /* 控制台都没了就算了 —— 标记还在，页面照样会显示 */ }
      return fallback;
    }
    var createElement = hook('createElement', function (type, props) {
      return { type: type, key: null, props: props || {} };
    });
    var useState = hook('useState', function (init) {
      return [typeof init === 'function' ? init() : init, function () {}];
    });
    var useEffect = hook('useEffect', function () {});

    /** 数组子节点自动补 key：控制台干净是交付的一部分。 */
    function withKey(el, index) {
      if (!el || typeof el !== 'object' || el.key !== null && el.key !== undefined) return el;
      return createElement(el.type, Object.assign({}, el.props || {}, { key: 'k' + index }));
    }

    /** `h(type, props, ...children)`：扁平化 + 补 key，替代 JSX（本文件不能编译）。 */
    function h(type, props) {
      var flat = [];
      (function push(list) {
        for (var i = 0; i < list.length; i += 1) {
          var child = list[i];
          if (Array.isArray(child)) { push(child); continue; }
          if (child === null || child === undefined || child === false || child === true) continue;
          flat.push(child);
        }
      })(Array.prototype.slice.call(arguments, 2));
      var keyed = flat.map(function (child, index) {
        return typeof child === 'object' ? withKey(child, index) : child;
      });
      var args = [type, props === undefined ? null : props].concat(keyed);
      return createElement.apply(null, args);
    }

    // ── 小工具 ──────────────────────────────────────────────────────────────
    function obj(value) {
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    }
    /**
     * 浅合并到 fresh 对象，跳过 `__proto__` / `constructor` / `prototype` 三个 own 键
     * （2026-10-12 评审 P3）：Object.assign 的 [[Set]] 语义会让 `__proto__` 改掉目标原型；
     * 合并来自网络的投影时这是白送的污染面。用 defineProperty 式赋值（`Object.defineProperty`
     * 的 own-key 语义）绕开 setter。
     */
    function 安全合并() {
      var out = {};
      for (var i = 0; i < arguments.length; i += 1) {
        var src = arguments[i];
        if (!src) continue;
        var keys = Object.keys(src);
        for (var j = 0; j < keys.length; j += 1) {
          var k = keys[j];
          if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
          Object.defineProperty(out, k, { value: src[k], writable: true, enumerable: true, configurable: true });
        }
      }
      return out;
    }
    function arr(value) {
      if (Array.isArray(value)) return value;
      if (value === null || value === undefined || value === '') return [];
      return [value];
    }
    function firstOf(source, names) {
      var box = obj(source);
      if (!box) return undefined;
      for (var i = 0; i < names.length; i += 1) {
        if (box[names[i]] !== undefined && box[names[i]] !== null) return box[names[i]];
      }
      return undefined;
    }
    function line(value, fallback) {
      if (typeof value === 'string' && value !== '') return value;
      if (typeof value === 'number' && isFinite(value)) return String(value);
      return fallback === undefined ? '' : fallback;
    }
    function boolOf(value) {
      if (value === true || value === false) return value;
      if (value === 1 || value === '1' || value === 'true' || value === '是') return true;
      if (value === 0 || value === '0' || value === 'false' || value === '否') return false;
      return null;
    }
    /**
     * 失联态的**四态字符串**（`在位` / `已失联` / `已关闭` / `未知`）。
     *
     * 为什么不能是布尔：布尔装不下「关了」这件事 —— `false` 同时表示
     * 「主权者一直在」与「这个机制被停掉了」，读的人分不清这两件完全不同的事。
     * Batch 2 之前这里读的是 `boolOf(...)`，于是宿主给 `'已关闭'` 时
     * `boolOf`（只认布尔 / `'true'` / `'是'` 那几个）返回 **null**，页面画成「未知」——
     * 而真缺陷比这更糟：**过了 `boolOf` 的值一定是布尔，四态里那一态根本到不了渲染层**。
     *
     * @param {unknown} value 宿主给的 `状态条.失联`
     * @returns {'在位'|'已失联'|'已关闭'|'未知'}
     */
    function 失联态Of(value) {
      if (value === '在位' || value === '已失联' || value === '已关闭' || value === '未知') return value;
      // 旧宿主只给布尔：降级成两态里最接近的那个，绝不把「没给」画成「在位」。
      var 旧 = boolOf(value);
      if (旧 === true) return '已失联';
      if (旧 === false) return '在位';
      return '未知';
    }

    /**
     * `状态条.失联详情` 的**读数细节**：生效期限、来源、坏值标记。
     *
     * 这些答案宿主（`src/workbench.js` 的 `失联详情`）已经算好了，页面只负责取出来；
     * 取不到就给「未知」而不是「看着正常」的默认值 —— 没读到 ≠ 正常。
     */
    function 失联详情Of(bag) {
      var box = obj(bag);
      if (!box) {
        return {
          在位: false, 读数: '缺失', 已关闭: false, lost: null, hours: null,
          生效响应期限小时: null, 响应期限小时来源: '未知', 失联限制来源: '未知',
          值不合法: false, 原值: null, 原值来源: '未知', 不合法说明: '', 说明: '',
          提示: '宿主没给 状态条.失联详情。',
        };
      }
      var 生效 = numOf(firstOf(box, ['生效响应期限小时', 'hours']));
      var 来源期限 = line(box.响应期限小时来源, '未知');
      var 来源开关 = line(box.失联限制来源, '未知');
      var 值不合法 = boolOf(box.值不合法) === true;
      var 读数 = 失联态Of(firstOf(box, ['读数', '状态']));
      return {
        在位: true,
        读数: 读数,
        已关闭: boolOf(box.已关闭) === true,
        lost: boolOf(box.lost),
        hours: numOf(box.hours),
        生效响应期限小时: 生效,
        响应期限小时来源: 来源期限,
        失联限制来源: 来源开关,
        值不合法: 值不合法,
        原值: 值不合法 ? (box.原值 === undefined ? null : box.原值) : null,
        原值来源: 值不合法 ? line(box.原值来源, '未知') : '',
        不合法说明: 值不合法 ? line(box.不合法说明, '') : '',
        说明: line(box.说明, ''),
        提示: 失联详情提示({
          读数: 读数, 生效响应期限小时: 生效,
          响应期限小时来源: 来源期限, 失联限制来源: 来源开关, 值不合法: 值不合法,
        }),
      };
    }

    /**
     * **读数对象**（`policy.presence()` / `presence` 动作返回的 `读数`）→ 四态字符串。
     *
     * ⚠️ 这个函数与 `失联态Of` 是两件东西，别互相喂错：
     * `失联态Of` 收的是**已经归一好的值**（`状态条.失联` 那个字符串，或旧宿主的布尔）；
     * 这里收的是**对象**，判据顺序与宿主 `src/workbench.js` 的 `失联态` 逐条对齐：
     * `已关闭` 先判（否则关了会被当成在位）→ `已失联` → `在位` → `未知`。
     *
     * 为什么必须单独立一个：Batch 4b 的真缺陷就是**把对象喂给了 `失联态Of`** ——
     * 前者只认四个字符串，遇到对象一律返回 `未知`，于是设置页那行三态（关 / 失联 / 在位）
     * **全渲染成「当前 未知」+ 灰点**，`已关闭（不判定失联）` 那个分支在设置页根本不可达。
     * 工作台面板那边没这个错（它读的是宿主已经归一好的 `状态条.失联` 字符串）。
     */
    function 读数对象四态(读数) {
      var box = obj(读数);
      if (!box) return '未知';
      if (boolOf(box.已关闭) === true) return '已关闭';
      var 态 = firstOf(box, ['读数', '状态']);
      if (态 !== undefined && 态 !== null) return 失联态Of(态);
      var lost = boolOf(box.lost);
      if (lost === true) return '已失联';
      if (lost === false) return '在位';
      return '未知';
    }

    /** 悬停用的读数全文：一格里塞不下的东西放这儿，版面上不喧宾夺主。 */
    function 失联详情提示(d) {
      var 段 = [
        '读数：' + (d.读数 === '缺失' ? '缺失' : d.读数),
        '生效响应期限小时：' + (d.生效响应期限小时 === null ? '—' : d.生效响应期限小时),
        '响应期限小时来源：' + d.响应期限小时来源,
        '失联限制来源：' + d.失联限制来源,
      ];
      if (d.值不合法) 段.push('值不合法：true —— 已退回内置兜底');
      return 段.join('\n');
    }

    /**
     * 失联那一格的一行后缀：生效期限、来源、坏值标记。
     * 只在有东西可说时给；绝不把「值不合法」按掉了 —— 那是这一格最该说的事。
     */
    function 失联附注(d) {
      if (!d || !d.在位) return '';
      var 段 = [];
      if (d.生效响应期限小时 !== null) {
        段.push('期限 ' + d.生效响应期限小时 + 'h');
        if (d.响应期限小时来源 !== '未知') 段.push('来源 ' + d.响应期限小时来源);
      }
      if (d.失联限制来源 !== '未知') 段.push('开关来源 ' + d.失联限制来源);
      if (d.值不合法) 段.push('⚠ 值不合法（已退回兜底）');
      return 段.join(' · ');
    }

    /** 数量取值：数字直取、数组取长度、对象取 `合计` 或键数。取不到返回 null（渲染成「—」，不是 0）。 */
    function numOf(value) {
      if (typeof value === 'number' && isFinite(value)) return value;
      if (Array.isArray(value)) return value.length;
      if (value && typeof value === 'object') {
        if (typeof value.合计 === 'number') return value.合计;
        var keys = Object.keys(value);
        return keys.length ? keys.length : null;
      }
      if (value === null || value === undefined || value === '') return null;
      var n = Number(value);
      return isFinite(n) ? n : null;
    }
    /** 见红项可能是探针名，也可能是 `{探针, 详情}`：两种都要能读出名字。 */
    function probeName(item) {
      if (typeof item === 'string') return item;
      var box = obj(item);
      return box ? line(firstOf(box, ['探针', '名', '名称', 'name', 'id'])) : '';
    }
    /** `2026-10-07T09:15:30.123Z` → `10-07 09:15:30`；非 ISO 原样返回（不依赖 locale）。 */
    function shortTime(value) {
      var m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/.exec(String(value || ''));
      return m ? m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5] + ':' + m[6] : String(value || '');
    }
    /**
     * 时刻 → **分钟级**（`MM-DD HH:MM`）：时间线与节律条是「一行一条」的扫读面，秒是噪声。
     * 只对 ISO 形状裁剪（与 `shortTime` 同款纪律：不依赖 locale、非 ISO 原样返回）。
     * 审计页仍用 `shortTime` 给全精度 —— 两处精度不同是**有意的**，不是漏改。
     */
    function 短时刻(value) {
      var s = shortTime(value);
      return /^\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? s.slice(0, 11) : s;
    }
    /** 从可能带围栏/前后文的文本里抠出 JSON 对象。 */
    function parseLooseJson(text) {
      var raw = String(text === null || text === undefined ? '' : text).trim();
      if (raw === '') return null;
      var start = raw.indexOf('{');
      var end = raw.lastIndexOf('}');
      if (start < 0 || end <= start) return null;
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch (error) {
        return null;
      }
    }

    // ── 常量：宿主命令与本地缓存 ────────────────────────────────────────────
    /** 面板键：主面板席位与侧边栏入口绑在同一个 key 上，布局控制器按它判定可开性。 */
    var PANEL_KEY = 'dsh-mind';
    /** 宿主半边注册的会话命令；`dashboard` 子命令返回工作台投影 JSON。 */
    var COMMAND = '/mind dashboard';
    /**
     * ── 传输层：同源 `fetch` 路由（Batch 7 换的，**不再是 `remote.commands.execute`**）──
     *
     * 为什么换：真机实测 `remote.commands.execute(sessionId, '/mind dashboard')` **永不返回**
     * （私有 `部署.json` 没建、审计 0 条 ⇒ 命令根本没到宿主；看板与设置页**一起死**，
     * 因为它们共用同一个 `runCommand`）。同机另一个第三方插件走的是同源 `fetch`
     * 打 `/plugins/<包名>/...` 路由 —— 那条路是活的。所以照它来。
     *
     * **响应体与命令面返回的 JSON 完全同形**（宿主侧另一位成员按此契约注册路由）⇒
     * 下面的解析 / 失败形状 / 回读判据**一个字都不用改**，换的只是"怎么把请求发出去"。
     */
    var ROUTE_PRESENCE = '/plugins/dsh-mind/presence';
    // v2 条目14/17：主权者逐请求放行的读数/决议端点（仅同源 + 宿主 Connection 认证可达）。
    var ROUTE_INTERVENTION = '/plugins/dsh-mind/intervention';
    var ROUTE_DELEGATION = '/plugins/dsh-mind/delegation';
    var ROUTE_PERSONA_CORE = '/plugins/dsh-mind/persona-core';
    var ROUTE_WORKBENCH = '/plugins/dsh-mind/workbench';
    /** 上一次已知快照：取不到投影时仍然有东西可看。 */
    var CACHE_KEY = 'dsh-mind.dashboard.v1';
    /**
     * 一次请求的**上限等待**（毫秒）。
     *
     * 为什么必须有：请求**可能永远不 settle**（通道不回、宿主侧卡住）。链上没有超时的话，
     * 设置页就**永远停在「正在读取设置…」**——页面看着像死的，而没有任何报错。
     * Batch 6 主人真机上遇到的就是这个（`phase:'reading'` 出不来了）。
     *
     * 8 秒是"人还愿意等"与"别把真卡住当成慢"之间的折中；超时后落到 `phase:'error'`
     * 并**带上可诊断信息**（路由 / 等了多久），下一张截图就能指出卡在哪一步。
     */
    var COMMAND_TIMEOUT_MS = 8000;
    /** 设置页分区：id 与标签（`settings.section` 的注册契约是 `{name, id, order, label()}`）。 */
    var SETTINGS_SECTION_ID = 'dsh-mind-settings';
    var SETTINGS_SECTION_LABEL = '心智';
    /**
     * 「响应期限小时」的**上界**，与宿主同一份判据（`src/kernel/time.js` 的
     * `MAX_RESPONSE_DEADLINE_HOURS`，`lib/actions.js` 的写前校验也用它）。
     *
     * 浏览器半边**取不到**那个常量（本文件是经典脚本，不 import 宿主模块），所以这里只能
     * 复写一份字面量。复写是有代价的（两处会漂），因此：
     *  · 变红的方式写进了断言（填 876001 ⇒ 页面必须说「没写进去」并给出区间）；
     *  · 真正说了算的仍是宿主 —— 就算这里漏了，宿主也会拒，页面会因为「回读对不上」而明说没写进去。
     */
    var MAX_RESPONSE_DEADLINE_HOURS = 876000;
    var TASK_LIMIT = 8;
    var AUDIT_LIMIT = 20;
    /**
     * ⑦（2026-10-12，主权者指令「也默认收起呗」）：总线改为**折叠**而不是**截断**。
     *
     * 旧版这里是 `BUS_LIMIT = 8` + `BUS_MSGS_LIMIT = 5` 两处 `slice` —— 超出的**静默消失**，
     * 与本仓「别静默截断（Batch 9）」的纪律相悖（审计区/任务图都给了「另有 N」，唯独总线没有）。
     * 现在：全部数据都在（投影层已给全量），默认只画预览，点「展开」看全部；超出部分**明说还有多少**。
     * 仍是纯显示动作、零请求（同「独立答案」「描述」折叠）。
     */
    var BUS_PREVIEW = 3;        /** 默认先画几个线程，其余收起（点「展开全部线程」铺开）。 */
    var BUS_MSGS_PREVIEW = 3;   /** 每个线程默认先画几条消息，其余收起（点「展开全部消息」铺开）。 */
    var BUS_TEXT_PREVIEW = 120; /** 消息正文超过多少字才折叠（沿用旧的 120 字「扫一眼」尺度，只是不丢字）。 */
    var DECIDE_LIMIT = 8;
    var REVIEW_LIMIT = 4;

    function storage() {
      try {
        if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
      } catch (error) { /* 隐私模式等：没有就没有 */ }
      return null;
    }
    function readCache() {
      try {
        var store = storage();
        if (!store) return null;
        var parsed = JSON.parse(store.getItem(CACHE_KEY) || 'null');
        return obj(parsed) && parsed.view ? parsed : null;
      } catch (error) {
        return null;
      }
    }
    function writeCache(view) {
      try {
        var store = storage();
        if (!store) return;
        store.setItem(CACHE_KEY, JSON.stringify({ at: new Date().toISOString(), view: view }));
      } catch (error) { /* 写不进去不影响本次显示 */ }
    }

    // ── 视图模型：把宿主投影收敛成渲染用得上的形状（§2.10 + 容错别名）──────
    var EMPTY = { phase: 'init', view: null, at: '', error: '', sessionId: '', source: '', stale: false, 项目选择: null, 自动选择: null };

    // 百分比是三档介入度的显示名称；配置值与审批规则沿用原有枚举。
    function 介入度标签(value) {
      return value === '放权' ? '0%' : value === '预审' ? '50%' : value === '审批' ? '100%' : line(value, '未知');
    }

    function normalizeView(raw) {
      // 宿主命令返回 `{成功, action, 项目, 数据: <投影>}`；工具路径共用同一个包装。
      // 这里把包装与投影合并成一层，两种形状都能读，视图不必知道自己被谁调过。
      // ⚠️ 合并走 安全赋值 而不是 Object.assign（2026-10-12 评审 P3）：assign 用 [[Set]]
      // 语义，投影里若带 own 键 `__proto__` 会顺手改掉目标的原型——投影来自网络，
      // 把它当可信输入是白送的原型污染面。
      var box = obj(raw) || {};
      var v = obj(box.数据) ? 安全合并(box, box.数据) : box;
      var taskBag = obj(firstOf(v, ['任务', 'task'])) || {};
      var statusBag = obj(firstOf(v, ['状态条', '状态'])) || {};
      var gateBag = obj(firstOf(statusBag, ['闸', 'policy'])) || {};
      var probeBag = obj(firstOf(statusBag, ['探针', 'probes'])) || {};
      var 失联详情袋 = firstOf(statusBag, ['失联详情']);
      var 失联原值 = firstOf(statusBag, ['失联', 'lost', 'presenceLost']);
      if (失联原值 === undefined) 失联原值 = firstOf(obj(失联详情袋) || {}, ['读数']);
      return {
        原始: v,
        核心人设保护: obj(v.核心人设保护),
        项目: line(firstOf(v, ['项目', '项目键', 'project', 'projectKey']), '（未指定）'),
        // 项目清单（2026-10-11，主权者指令「修」）：面板默认只看一个项目，而活账可能在别的
        // 项目下 —— 不带这份清单，界面就无法说出「还有哪些项目有账」，只能干显示一片空白。
        项目清单: 项目清单Of(firstOf(v, ['项目清单', 'projects'])),
        生成于: line(firstOf(v, ['生成于', 'generatedAt', '生成时刻', 'at']), ''),
        边界: obj(firstOf(v, ['边界', 'bounds'])) || {},
        // 状态条是**一行**「现在能不能干活」：闸 / 介入度 / 失联 / 探针。
        // 三态（true / false / null）都要留住：null 是「宿主没给」，不能画成「正常」。
        状态条: {
          闸: {
            在位: boolOf(firstOf(gateBag, ['在位', 'healthy', 'ok'])),
            规则数: numOf(firstOf(gateBag, ['规则数', 'rules'])),
            错误: line(firstOf(gateBag, ['错误', 'error']), ''),
          },
          介入度: line(firstOf(statusBag, ['介入度', 'intervention']), '未知'),
          // 四态字符串：在位 / 已失联 / 已关闭 / 未知。
          // 取值顺序是**有意的**：宿主没给 `失联`（`undefined`）时，不要立刻判「未知」——
          // 它可能只是把结论放在 `失联详情.读数` 里了（两者都缺才是未知）。
          失联: 失联态Of(失联原值),
          失联详情: 失联详情Of(失联详情袋),
          探针: {
            状态: line(firstOf(probeBag, ['状态', 'status']), '未知'),
            见红: arr(firstOf(probeBag, ['见红', '红灯', 'red'])).map(probeName).filter(Boolean),
            恒红: boolOf(firstOf(probeBag, ['恒红', 'stuckRed'])) === true,
            恒绿: boolOf(firstOf(probeBag, ['恒绿', 'stuckGreen'])) === true,
          },
        },
        // 工作台仍是只读投影；审批行只带导航标识，完整计划按需从认证人侧路由读取。
        待你决定: arr(firstOf(v, ['待你决定', '待决清单'])).map(function (item) {
          var row = obj(item) || {};
          return {
            类型: line(firstOf(row, ['类型', 'kind']), '待决项'),
            节点: line(firstOf(row, ['节点', 'node', 'id']), '') || null,
            描述: line(firstOf(row, ['描述', '对象', '名称']), ''),
            原因: line(firstOf(row, ['原因', '理由', 'reason']), '（未给原因）'),
            可选项: arr(firstOf(row, ['可选项', '选项', 'options'])).map(refText).filter(Boolean),
            命令: line(firstOf(row, ['命令', 'command']), ''),
            请求id: line(row.请求id, ''),
            会话: line(row.会话, ''),
          };
        }),
        会审: arr(firstOf(v, ['会审', '会审记录'])).map(reviewRow),
        // ⑦（2026-10-11）：消息总线——投影给什么画什么；会审讨论线程投影已收走正文（盲评保护）。
        消息总线: arr(firstOf(v, ['消息总线', '总线', 'bus'])).map(busThreadRow),
        审计尾: arr(firstOf(v, ['审计尾', '审计', 'audit'])),
        监控: obj(v.监控),
        目标: obj(v.目标),
        模型用量: obj(v.模型用量),
        创建操作: obj(v.创建操作),
        知识复用: obj(v.知识复用),
        // 记忆读数：宿主没给就是 null（不装懂）；给了只取四个标量，数字真伪由投影侧负责。
        记忆: 记忆读数Of(firstOf(v, ['记忆', '记忆读数', 'memory'])),
        // 能力 × 岗位接线（2026-10-13 重做·图谱）。**宿主没给就是 null**（不装懂）：
        // 投影层没这门数据时，面板不该画一张「组织里一张卡都没有」的空图。
        能力: 能力行们(firstOf(v, ['能力', 'capabilities'])),
        岗位: 岗位行们(firstOf(v, ['岗位', 'roles'])),
        实例计数: obj(firstOf(v, ['实例计数', 'instances'])),
        // 岗位闲置（派活闭环 2026-10-15）：宿主没给 ⇒ null（不装懂），与实例计数同族。
        岗位闲置: obj(firstOf(v, ['岗位闲置', 'roleIdle'])),
        任务: taskBag,
        // 投影把节点放在 `任务.节点` 下；`节点` 只是同一件事的直白叫法。
        任务节点: arr(taskBag.节点 || firstOf(v, ['任务节点', '节点', 'tasks'])),
        视图: line(firstOf(v, ['视图', 'view']), ''),
      };
    }

    /**
     * 项目清单袋 → 渲染用形状（2026-10-11，主权者指令「修」）。
     * 纪律同「记忆读数」：宿主没给就 `null`（不装懂），给了就只取用得上的标量。
     * 计数全部来自宿主现算的账本读数，界面不自己数、不猜。
     */
    function 项目清单Of(bag) {
      var b = obj(bag);
      if (!b) return null;
      var 项 = arr(firstOf(b, ['项', 'projects', 'list'])).map(function (p) {
        var x = obj(p) || {};
        return {
          项目: line(firstOf(x, ['项目', 'project', 'key']), ''),
          任务: numOf(firstOf(x, ['任务', 'tasks', '节点数'])),
          线程: numOf(firstOf(x, ['线程', 'threads'])),
          未投递: numOf(firstOf(x, ['未投递', 'undelivered'])),
          最近于: line(firstOf(x, ['最近于', 'lastAt']), ''),
        };
      }).filter(function (x) { return x.项目 !== ''; });
      return { 当前: line(firstOf(b, ['当前', 'current']), '') || null, 项: 项 };
    }

    /**
     * 一个总线线程 → 渲染用的形状（⑦·2026-10-11）。
     * 会审讨论段：投影层已把 正文/发件 收走（盲评保护），这里只认标记位，不补内容。
     */
    function busThreadRow(row) {
      var r = obj(row) || {};
      return {
        线程: line(firstOf(r, ['线程', 'thread']), ''),
        条数: numOf(firstOf(r, ['条数', 'count'])),
        未投递: numOf(firstOf(r, ['未投递', 'undelivered'])),
        会审讨论段: r.会审讨论段 === true,
        最新: arr(firstOf(r, ['最新', 'latest'])).map(function (m) {
          var x = obj(m) || {};
          return {
            id: line(x.id, ''),
            发件: line(x.发件, ''),
            类型: line(x.类型, ''),
            内容: line(x.内容, ''),
            // 正文原长（2026-10-12）：投影层给全量后，渲染层据此决定要不要给「展开全文」钮。
            // 缺省时退回内容自身长度（向后兼容旧投影，不装懂也不崩）。
            正文原长: numOf(firstOf(x, ['正文原长', 'contentLength'])),
            状态: line(x.状态, ''),
            追加于: line(x.追加于, ''),
          };
        }),
      };
    }

    /**
     * 记忆读数袋 → 渲染用的形状。null/非对象 ⇒ null：宿主没给就不画，
     * 与「失联四态」同一纪律——缺数据不许伪装成 0。
     */
    function 记忆读数Of(bag) {      var b = obj(bag);
      if (!b) return null;
      var 近段 = obj(firstOf(b, ['近段'])) || {};
      return {
        存量: numOf(firstOf(b, ['存量', '存量合计'])),
        窗口天: numOf(firstOf(近段, ['窗口天'])),
        新增: numOf(firstOf(近段, ['新增', '新增合计'])),
        晋升: numOf(firstOf(近段, ['晋升'])),
        // 按类构成（2026-10-13 重做）：只认三个合法类，数字真伪由投影侧负责。
        按类: 按类Of(firstOf(b, ['按类'])),
      };
    }

    /** 记忆按类计数 → `{经历, 知识, 偏好}`（缺的类给 null，不给 0：0 是「这一类是空的」）。 */
    function 按类Of(bag) {
      var b = obj(bag);
      if (!b) return null;
      var out = {};
      var 有值 = false;
      ['经历', '知识', '偏好'].forEach(function (k) {
        out[k] = numOf(b[k]);
        if (out[k] !== null) 有值 = true;
      });
      // 三类全空 ⇒ 当作「没给」（null），否则会画出一张 0 的甜甜圈——
      // 那看起来像「记忆是空的」，而真相是「宿主没给这一格」。
      return 有值 ? out : null;
    }

    /**
     * 能力卡行（2026-10-13 重做·图谱）。**只取结构与三个标量**：id / 来源 / 适用岗位。
     * 摘要与正文一律不上图（图画的是结构，不是内容）。
     */
    function 能力行们(bag) {
      if (!Array.isArray(bag)) return null;
      return bag.map(function (row) {
        var r = obj(row) || {};
        return {
          id: line(firstOf(r, ['id', '名', 'name']), ''),
          来源: line(firstOf(r, ['来源', 'zone', 'source']), ''),
          适用岗位: arr(firstOf(r, ['适用岗位', 'roles', '适用'])).map(refText).filter(Boolean),
        };
      }).filter(function (r) { return r.id !== ''; });
    }

    /**
     * 岗位卡行（2026-10-13 重做·图谱）：id / 来源 / 同名 / 摘要 / **能力引用**。
     * `同名` 是「生效的是哪份、另外还有哪份」的唯一读数——双区同名时不许被拍平成一个来源。
     */
    function 岗位行们(bag) {
      if (!Array.isArray(bag)) return null;
      return bag.map(function (row) {
        var r = obj(row) || {};
        return {
          id: line(firstOf(r, ['id', 'name']), ''),
          来源: line(firstOf(r, ['来源', 'zone', 'source']), ''),
          同名: arr(firstOf(r, ['同名', 'zones'])).map(refText).filter(Boolean),
          摘要: line(firstOf(r, ['摘要', 'summary']), ''),
          能力引用: arr(firstOf(r, ['能力引用', 'capabilities'])).map(refText).filter(Boolean),
        };
      }).filter(function (r) { return r.id !== ''; });
    }

    /**
     * 接线读数（2026-10-13 重做·图谱）：把两个真源对起来。
     *
     * **口径**（与投影同源，不另发明）：一条「适用边」= 能力卡的 `适用岗位` 里点名了某岗位；
     * 它**接线了**当且仅当该岗位卡的 `能力引用` 里出现这张能力卡的 id。两个方向都不许放宽：
     *  - 只看能力卡声明 ⇒ 把「声明」当「生效」（正是「发卡 ≠ 接线」这个缺陷本身）；
     *  - 只看岗位引用 ⇒ 看不出「声明了但没人接」的缺口。
     *
     * @param {Array|null} 能力
     * @param {Array|null} 岗位
     */
    function 接线读数(能力, 岗位) {
      if (!Array.isArray(能力) || !Array.isArray(岗位)) return null;
      var 引用 = {};
      岗位.forEach(function (r) { 引用[r.id] = r.能力引用; });
      var 接线 = [], 缺口 = [];
      能力.forEach(function (c) {
        c.适用岗位.forEach(function (role) {
          var hit = (引用[role] || []).indexOf(c.id) >= 0;
          (hit ? 接线 : 缺口).push({ 能力: c.id, 岗位: role, 来源: c.来源 });
        });
      });
      var 自治适用 = 0, 自治接线 = 0, 出厂适用 = 0, 出厂接线 = 0;
      (接线.length + 缺口.length) && 能力.forEach(function (c) {
        c.适用岗位.forEach(function (role) {
          var hit = (引用[role] || []).indexOf(c.id) >= 0;
          if (c.来源 === '自治') { 自治适用 += 1; if (hit) 自治接线 += 1; }
          else if (c.来源 === '出厂') { 出厂适用 += 1; if (hit) 出厂接线 += 1; }
        });
      });
      var 适用边 = 接线.length + 缺口.length;
      return {
        适用边: 适用边, 接线: 接线, 缺口: 缺口,
        接线率: 适用边 ? Math.round(接线.length / 适用边 * 100) : null,
        自治适用: 自治适用, 自治接线: 自治接线,
        出厂适用: 出厂适用, 出厂接线: 出厂接线,
      };
    }

    /**
     * 一次会审 → 渲染用的形状（v2 口述收敛 2026-10-18 条目18：会审退出任务图）。
     *
     * 数据源是 `council.list()` 折出的**会审存档**：
     * id / 问题 / 状态 / 参与者 / 来源会话 / 轮次 / 答案 / 分歧清单 / 结论 / 零分歧 / 时间。
     * 盲评遮罩已在服务层做过（作答中参与者读到的是 `{成员:'成员 X', 结论:null}`）——
     * 这里**只搬、不判**，绝不拿旧任务图的 揭名/独立答案/讨论 字段去猜（那些键 v2 已不存在）。
     */
    function reviewRow(row) {
      var r = obj(row) || {};
      var 遮 = boolOf(firstOf(r, ['盲评遮罩'])) === true;
      return {
        id: line(firstOf(r, ['id', '会审']), ''),
        问题: line(firstOf(r, ['问题', '描述', '标题']), ''),
        状态: line(firstOf(r, ['状态', 'state']), '未知'),
        参与者: arr(firstOf(r, ['参与者', 'participants'])).map(refText).filter(Boolean),
        来源会话: line(firstOf(r, ['来源会话', '会话']), ''),
        // 轮次是存档给的 `已用/上限` 字符串（刚发起时为 `0/2`）；原样画，不自己算。
        轮次: line(firstOf(r, ['轮次', 'round']), ''),
        盲评遮罩: 遮,
        答案: arr(firstOf(r, ['答案'])).map(function (answer, index) {
          var a = obj(answer) || {};
          return {
            // 遮罩期投影把「成员」换成了盲标；揭名后同一字段是真成员 id。两者都按投影画的画。
            成员: line(firstOf(a, ['成员', 'member']), 遮 ? '成员 ' + String.fromCharCode(65 + index) : ''),
            // 遮罩期结论/结论层/反例面都是 null/[]：没有内容就一个字都不画（不补假占位）。
            结论: line(firstOf(a, ['结论', 'conclusion']), ''),
            结论层: line(firstOf(a, ['结论层']), ''),
            反例面: arr(a.反例面).map(refText).filter(Boolean),
          };
        }),
        分歧清单: arr(firstOf(r, ['分歧清单', '分歧'])).map(refText).filter(Boolean),
        结论: line(firstOf(r, ['结论', 'conclusion']), ''),
        // 零分歧：存档是布尔（已收敛时才有意义）。保留原值，渲染层按状态判三态；
        // 未收敛时绝不许把它画成「存在分歧」——那是替投影断言一个它没给的事实。
        零分歧: firstOf(r, ['零分歧', 'zeroDivergence']),
        创建于: line(firstOf(r, ['创建于']), ''),
        解锁于: line(firstOf(r, ['解锁于']), ''),
        收敛于: line(firstOf(r, ['收敛于']), ''),
      };
    }

    /** 派发之后判据冻结（§7）。投影直接给这一位，界面不再自己推阶段。 */
    function criteriaFrozen(task) {
      return boolOf(firstOf(task, ['判据冻结', 'criteriaFrozen'])) === true;
    }
    /** 待决 = 任务图里的一种节点状态，或投影带了待决原因。 */
    function isPending(task) {
      if (task && (task.已终止 === true || task.状态 === '已终止')) return false;
      return String((task && task.状态) || '') === '待决' || !!line(task && task.待决原因);
    }
    /** 交卷进度文本：`3/3`；没齐就带上「未齐」，不让人自己去比两个数。 */
    function progressText(bag) {
      var box = obj(bag) || {};
      var 已交 = numOf(box.已交);
      var 应交 = numOf(box.应交);
      var text = (已交 === null ? '—' : String(已交)) + '/' + (应交 === null ? '—' : String(应交));
      return text + (box.齐 === true ? ' 齐' : ' 未齐');
    }

    /** 三种审计档位各有一个类名：分级要在版面上看得见，不只是文字。 */
    function auditClass(row) {
      var grade = auditGrade(row);
      return grade === '全记' ? 'dshmind-auditFull' : grade === '记汇总' ? 'dshmind-auditMid' : 'dshmind-auditLow';
    }

    function auditGrade(row) {
      var grade = line(firstOf(row, ['档位', 'grade']));
      if (grade === '全记' || grade === '记汇总' || grade === '不逐次记') return grade;
      return '记汇总';
    }
    function actorOf(row) {
      var actor = firstOf(row, ['主体', 'actor']);
      if (typeof actor === 'string') return actor;
      var box = obj(actor);
      if (!box) return '未知';
      return [line(box.id, '未知'), line(box.kind)].filter(Boolean).join(' · ');
    }
    /**
     * 审计主体的**显示名**：`session-<uuid>` 长达 38 字符，会把主体列顶成省略号
     * （一排 `session-d6d8208e-b3e9-42c...` —— 主人视觉打回「很多被截断」的一族）。
     * 截到 `session-` + 前 8 位即可人读；全文仍挂 title，截断不丢信息。
     * @param {string} 主体 actorOf 的结果
     * @returns {string} 显示用短名
     */
    function 短主体(主体) {
      var m = /^(session-[0-9a-f]{8})[0-9a-f-]+$/i.exec(主体);
      return m ? m[1] : 主体;
    }
    function refText(item) {
      if (typeof item === 'string') return item;
      var box = obj(item);
      if (!box) return '';
      return line(firstOf(box, ['id', '名称', 'name', 'ref'])) || line(box.正文);
    }

    // ── 样式：只用 --dsw-alias-* 令牌，附兜底色（令牌改名只掉外观，不掉功能）──
    var CSS = [
      // 滚动作用域 vs 显示宽度，**拆成两层**（2026-10-12，主权者：「不能只放宽滚动作用域吗」）：
      //
      // 问题的根源是两者原先**共用一个元素**：`.dshmind-root` 既是面板的 DOM 边界（只有
      // `max-width:1040px` 宽），又是滚动容器（`overflow:auto`）。于是滚轮落在它**两侧的空白**上时
      // 命中的是宿主容器、而宿主不是滚动容器 ⇒ **那两块区域滚不动**（主权者截图红框即此处）。
      //
      // 拆法：
      //   · `.dshmind-root`  —— **铺满**（无 max-width），承担 `overflow:auto`、`min-height:100%`。
      //                        鼠标落在整屏任何位置（含左右空白）都在它的范围内 ⇒ 都能滚。
      //   · `.dshmind-page`  —— **内容居中**，管排版与内边距。宽度**随设计走**：
      //                        2026-10-12 是 1040px（单列长页）；2026-10-13 重做改成两栏
      //                        （侧栏 + 内容）⇒ 放宽到 **1180px**。**不含 overflow** 这一条不变。
      // 两层之间不要再放 `overflow`，否则又会出现「内层截住滚轮」的同款毛病。
      '.dshmind-root{box-sizing:border-box;display:flex;flex-direction:column;width:100%;',
      'min-height:100%;overflow:auto;',
      'color:var(--dsw-alias-label-primary,#16181d);font-size:13px;line-height:20px;',
      "font-family:var(--ds-font-family-sans,-apple-system,'Segoe UI',system-ui,sans-serif)}",
      // 内容层：**铺满**（2026-10-13 晚口径改形：主权者真机问「为啥左右留空这么多」）。
      // 旧口径（1040 → 1180 居中）来自 2026-10-12 的「滚动作用域 vs 显示宽度」修复，
      // 当时只要求「滚动作用域放宽、显示宽度不变」；但那在宽屏上就是两侧一大片空白。
      // 现在：布局铺满，**改由正文自己限行长**（`--mk-measure`）—— 这是"铺满"与"读得动"的分工：
      //   · 宽度交给容器（卡片、图谱、表格都吃满，宽屏不浪费）；
      //   · 行长交给正文（标题/正文/命令块 ≤ 78ch，一行不会长到串行）。
      // ⚠️ 仍然**不许**有 overflow（那是滚动作用域的硬口径，与本行无关）。
      '.dshmind-page{box-sizing:border-box;display:flex;flex-direction:column;gap:14px;width:100%;',
      'padding:24px clamp(20px,2.5vw,40px) 40px}',
      '.dshmind-root *{box-sizing:border-box}',
      // ⚠️ 子项**不许被压缩**（2026-10-11 截断事故）：根是 flex 纵向容器 + height:100%，
      // 子项默认 flex-shrink:1 ⇒ 内容变高时先**压扁**子项而不是出滚动条，而各分区
      // 又是 overflow:hidden ⇒ 被压掉的那截**直接裁掉**（健康组卡片下半、空态命令块下半）。
      // 固定成自然高度后，超出由根的 overflow:auto 滚动接管——裁切与滚动各司其职。
      '.dshmind-root>*{flex:none}',
      '.dshmind-mono{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);',
      'font-variant-numeric:tabular-nums}',

      // 顶部横幅
      '.dshmind-hero{border:.5px solid var(--dsw-alias-border-l1,#0000001f);border-radius:var(--dsw-radius-lg,12px);',
      'background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:var(--dsw-elevation-soft,none);overflow:hidden}',
      '.dshmind-heroTop{display:flex;align-items:flex-start;gap:16px;padding:16px 18px 12px;',
      'border-bottom:.5px solid var(--dsw-alias-border-l1,#0000001f)}',
      '.dshmind-title{margin:0;font-size:18px;font-weight:600;letter-spacing:.02em}',
      '.dshmind-sub{margin:2px 0 0;color:var(--dsw-alias-label-tertiary,#81858c);font-size:12px}',
      '.dshmind-actions{margin-left:auto;display:flex;align-items:center;gap:8px}',
      '.dshmind-btn{height:28px;padding:0 12px;border-radius:var(--dsw-radius-md,8px);cursor:pointer;',
      'border:.5px solid var(--dsw-alias-border-l2,#0000001f);background:var(--dsw-alias-bg-layer-2,#fff);',
      'color:var(--dsw-alias-label-secondary,#61666b);font-size:12px;font-family:inherit}',
      '.dshmind-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#eff1f5);',
      'color:var(--dsw-alias-label-primary,#16181d)}',
      // ── 状态条（Batch 8 重排）────────────────────────────────────────────
      // 三条规矩，都是从真机截图上拆出来的：
      //  1. **值不许被裁**：旧版 `white-space:nowrap` + `ellipsis` 把「已关闭（不判定失联）」
      //     裁成了「已关闭（不判定失」——为了"一行好看"牺牲了完整性，不能接受。现在值可换行。
      //  2. **一格的宽度按内容**：`auto-fit,minmax(190px,1fr)` 让窄面板自动减列，
      //     配合 `overflow-wrap:anywhere` 长文案自己换行（不再需要横向截断）。
      //  3. **告警底色贴合内容**：底色只染「值那一小块」（`width:fit-content`），
      //     不再铺满整格/整列（旧版底色比内容宽一大截）。
      // ── 状态条（Batch 8 排版 / **Batch 9 治"空位"**）──────────────────────
      // 历史与理由，一条都别删（每条都是真机上挑出来的）：
      //  · Batch 8-1 **值不许被裁**：`nowrap` + `ellipsis` 把「已关闭（不判定失联）」裁成
      //    「已关闭（不判定失」——现在值可换行（`overflow-wrap:anywhere`）。
      //  · Batch 8-2 **告警底色贴合内容**：底色只染「值那一小块」（`width:fit-content`）。
      //  · **Batch 9 空位**（主人：「空位的地方不好看，比较突兀」）：
      //    旧版是 `repeat(auto-fit,minmax(190px,1fr))` —— `auto-fit` 会把**空轨道**也画上外观
      //    （格子的底/边来自 `.dshmind-readouts` 的背景色被 `gap:1px` 露出的缝），
      //    于是 5 格排进 6 列时末尾那块是**一个空洞的方框**。
      //    现在改 **`flex-wrap`**：没有"轨道"这个概念 ⇒ 排不满只是右边留白，
      //    **不会再画出任何空框**。分隔感改由每格自己的边框提供。
      '.dshmind-readouts{display:flex;flex-wrap:wrap;gap:8px;align-items:stretch;background:transparent}',
      // 每格自己画壳（底色 + 边框 + 圆角）。壳**只在真有内容的格上**：
      // 没内容的格压根不渲染 —— `readout()` 里 `没内容就不画壳`。
      '.dshmind-readout{box-sizing:border-box;flex:1 1 190px;min-width:150px;max-width:100%;',
      'background:var(--dsw-alias-bg-layer-1,#fff);padding:10px 14px;',
      'border:.5px solid var(--dsw-alias-border-l1,#0000001f);border-radius:var(--dsw-radius-md,8px)}',
      '.dshmind-readoutKey{color:var(--dsw-alias-label-tertiary,#81858c);font-size:11px;letter-spacing:.04em}',
      // 键在下、值在上：值可以换行，**永不 `text-overflow:ellipsis`**（裁切会把话说不全）。
      '.dshmind-readoutVal{margin-top:3px;font-size:14px;font-weight:600;line-height:20px;',
      'overflow-wrap:anywhere}',
      // 格内附注：紧贴这一格（不横跨整行），字号小、色淡，可换行。
      '.dshmind-readoutNote{display:flex;flex-direction:column;gap:2px;margin-top:5px;font-size:11px;',
      'line-height:16px;color:var(--dsw-alias-label-tertiary,#81858c);overflow-wrap:anywhere}',
      // 「介入度」那格的值行：一个值 + 一句注解，**不带边框/背景/光标**（只读，别像能点）。
      '.dshmind-valueLine{display:inline-flex;align-items:baseline;gap:6px;flex-wrap:wrap}',
      '.dshmind-valueNote{font-size:11px;line-height:16px;font-weight:400;',
      'color:var(--dsw-alias-label-tertiary,#81858c)}',

      // 状态点 / 徽章
      '.dshmind-dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex:none}',
      '.dshmind-dot-line{display:inline-flex;align-items:center;gap:6px}',
      '.dshmind-badge{display:inline-flex;align-items:center;gap:4px;height:18px;padding:0 6px;border-radius:4px;',
      'font-size:11px;line-height:18px;white-space:nowrap;border:.5px solid transparent}',
      '.dshmind-chip{display:inline-flex;align-items:center;max-width:230px;height:20px;padding:0 7px;border-radius:4px;',
      'font-size:11px;background:var(--dsw-alias-markdown-code-block,#f5f5f5);',
      'border:.5px solid var(--dsw-alias-border-l1,#0000001f);color:var(--dsw-alias-label-secondary,#61666b);',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',

      // 分区
      '.dshmind-sec{border:.5px solid var(--dsw-alias-border-l1,#0000001f);border-radius:var(--dsw-radius-lg,12px);',
      'background:var(--dsw-alias-bg-layer-1,#fff);overflow:hidden}',
      '.dshmind-secHead{display:flex;align-items:center;gap:10px;padding:12px 16px;',
      'border-bottom:.5px solid var(--dsw-alias-border-l1,#0000001f)}',
      '.dshmind-secIdx{width:20px;height:20px;border-radius:5px;flex:none;display:inline-flex;align-items:center;',
      'justify-content:center;font-size:11px;font-weight:600;color:var(--dsw-alias-label-primary-inverted,#fff);',
      'background:var(--dsw-alias-state-business-primary,#0f1115)}',
      '.dshmind-secTitle{margin:0;font-size:14px;font-weight:600}',
      '.dshmind-secHint{color:var(--dsw-alias-label-tertiary,#81858c);font-size:12px;min-width:0;overflow:hidden;',
      'text-overflow:ellipsis;white-space:nowrap}',
      '.dshmind-secCount{margin-left:auto;color:var(--dsw-alias-label-caption,#adb2b8);font-size:12px}',
      '.dshmind-secBody{padding:14px 16px}',

      // 页头告警：闸不在位 / 已失联 / 已关闭 —— 只是换个点色不算「看见了」，值那一块要变色。
      // ⚠️ 底色**只染值那一小块**（`width:fit-content`），不再染整格：
      //    旧版整格染色 ⇒ 底色铺满整列、比内容宽一大截（Batch 8 主人提的第 2 条）。
      //    键与注仍保持中性色，免得"一整块红"看起来像坏了。
      '.dshmind-readoutAlarm .dshmind-readoutVal{color:var(--dsw-alias-state-error-primary,#d54941);',
      'display:inline-block;width:fit-content;max-width:100%;padding:1px 6px;border-radius:4px;',
      'background:var(--dsw-alias-state-error-tertiary,#fdecea)}',

      // 待你决定：只读工作台给的是**一条命令**，不是一个按钮
      '.dshmind-decide{display:flex;flex-direction:column;gap:10px}',
      '.dshmind-decideRow{border:.5px solid var(--dsw-alias-border-l1,#0000001f);border-radius:var(--dsw-radius-md,8px);',
      'background:var(--dsw-alias-bg-layer-2,#fff);padding:10px 12px;display:flex;flex-direction:column;gap:6px}',
      '.dshmind-decideTop{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dshmind-decideWhat{font-weight:600;font-size:13px;min-width:0;overflow-wrap:anywhere}',
      '.dshmind-decideWhy{color:var(--dsw-alias-label-secondary,#61666b);font-size:11.5px;line-height:17px;overflow-wrap:anywhere}',
      // 命令要被选中带走：等宽、整块可选、光标给文本光标。
      '.dshmind-cmd{display:block;padding:7px 10px;border-radius:var(--dsw-radius-sm,6px);',
      'background:var(--dsw-alias-markdown-code-block,#f5f5f5);border:.5px solid var(--dsw-alias-border-l1,#0000001f);',
      'font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;',
      'color:var(--dsw-alias-label-primary,#16181d);overflow-wrap:anywhere;cursor:text;-webkit-user-select:text;user-select:text}',

      // 会审
      '.dshmind-reviews{display:flex;flex-direction:column;gap:12px}',
      '.dshmind-review{border:.5px solid var(--dsw-alias-border-l1,#0000001f);border-radius:var(--dsw-radius-md,8px);',
      'background:var(--dsw-alias-bg-layer-2,#fff);padding:10px 12px;display:flex;flex-direction:column;gap:8px}',
      // ⑦ 总线线程卡：样式与 dshmind-review 同一款，但类名**必须分开**——
      // 「三场会审各一张卡」那条断言按 .dshmind-review 数卡，两个分区共用类名会互相污染计数。
      '.dshmind-bus{border:.5px solid var(--dsw-alias-border-l1,#0000001f);border-radius:var(--dsw-radius-md,8px);',
      'background:var(--dsw-alias-bg-layer-2,#fff);padding:10px 12px;display:flex;flex-direction:column;gap:8px}',
      '.dshmind-reviewTop{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      // 未交齐的锁：它说的就是「不许看人」，所以占整行、显眼、不可错过。
      '.dshmind-lock{padding:6px 10px;border-radius:var(--dsw-radius-sm,6px);font-size:11.5px;',
      'background:var(--dsw-alias-state-warn-tertiary,#fdf6e7);color:var(--dsw-alias-state-warn-primary,#c47f17);',
      'border:.5px dashed var(--dsw-alias-state-warn-secondary,#e5b46a)}',
      '.dshmind-answers{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px}',
      '.dshmind-answer{border-left:2px solid var(--dsw-alias-border-l3,#00000024);padding-left:8px;',
      'display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.dshmind-answerHead{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.dshmind-answerBody{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#61666b);overflow-wrap:anywhere}',
      '.dshmind-counter{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary,#81858c);overflow-wrap:anywhere}',
      '.dshmind-divergence{font-size:11.5px;line-height:17px;color:var(--dsw-alias-state-warn-primary,#c47f17);overflow-wrap:anywhere}',
      '.dshmind-consensus{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary,#81858c);overflow-wrap:anywhere}',
      // 零分歧是**异常**（§10 全票一致 = 趋同信号），所以它拿告警外观，不能长得像好消息。
      '.dshmind-anomaly{padding:7px 10px;border-radius:var(--dsw-radius-sm,6px);font-size:11.5px;line-height:17px;',
      'background:var(--dsw-alias-state-error-tertiary,#fdecea);border:.5px solid var(--dsw-alias-state-error-primary,#d54941);',
      'color:var(--dsw-alias-state-error-primary,#d54941);overflow-wrap:anywhere}',
      // 复核三态：三档三样。`未验` 是灰底虚线，绝不借到「过」的绿。
      '.dshmind-verdict{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:4px;',
      'font-size:11px;white-space:nowrap;border:.5px solid transparent}',
      '.dshmind-verdictPass{color:var(--dsw-alias-state-success-primary,#2f9e44);',
      'border-color:var(--dsw-alias-state-success-primary,#2f9e44);background:var(--dsw-alias-state-success-tertiary,#eaf7ec)}',
      '.dshmind-verdictFail{color:var(--dsw-alias-state-error-primary,#d54941);',
      'border-color:var(--dsw-alias-state-error-primary,#d54941);background:var(--dsw-alias-state-error-tertiary,#fdecea)}',
      '.dshmind-verdictUnverified{color:var(--dsw-alias-label-secondary,#61666b);border-style:dashed;',
      'border-color:var(--dsw-alias-border-l3,#00000024);background:transparent}',
      '.dshmind-verdictNone{color:var(--dsw-alias-label-caption,#adb2b8);border-color:var(--dsw-alias-border-l2,#0000001f)}',

      // 任务节点
      // **单列**（2026-10-12，主权者指令「这个多列还是干掉」）：
      // 原先 `repeat(auto-fit,minmax(288px,1fr))` 在 1040px 容器里会排 3 列，每卡仅约
      // 340px 宽；而卡里要放 2037 字级的「描述」⇒ 每行才 24 字、要 85 行、高约 1700px，
      // 视觉上就是「只用了左侧一半的面板」的那坨密排。多列对**长正文**是错的布局：
      // 高度随列宽收窄而爆炸，横向却还空着。改单列吃满宽度，长文本才读得下去。
      // 注：`grid-template-columns:1fr` 而非 `display:block`——保留 grid 的 gap 语义，
      // 且与下方 `.dshmind-node` 的既有样式零冲突（改动面最小）。
      // 📌 **口径改形（2026-10-14 · 主权者指令「不要用多列，就按 mockup 做」）**：
      //    2026-10-13 晚这里被改成 `repeat(auto-fill,minmax(420px,1fr))` 的自动网格，
      //    理由是「单列 + 正文限行宽 ⇒ 每张卡右半边空着」。**那个诊断把因果搞反了。**
      //    右半边空的成因是**逐元素的行长上限**（`--mk-measure:78ch`），不是单列本身 ——
      //    设计稿（`mind-panel-redesign/mockup.html`）正是**单列**，而它的 `.tcard .desc`
      //    **没有任何行长上限**，卡片自然吃满整宽。
      //    ⇒ 正确改法：**回单列，同时放开卡内预览文本的限宽**（见下方 V19），
      //    而不是靠多列去把卡片切窄。多列的代价：每卡只剩 420px、长正文疯狂折行，
      //    读者要竖着扫三遍（主权者原话「不好看」）。
      //    守的本意不变：**任何一列都窄不到让长描述爆炸** —— 单列是最宽的那一档。
      '.dshmind-nodes{display:grid;grid-template-columns:1fr;gap:10px;margin-top:12px}',
      '.dshmind-node{border:.5px solid var(--dsw-alias-border-l1,#0000001f);border-radius:var(--dsw-radius-md,8px);',
      'background:var(--dsw-alias-bg-layer-2,#fff);padding:10px 12px;min-width:0;display:flex;flex-direction:column;gap:6px}',
      '.dshmind-nodePending{border-color:var(--dsw-alias-state-warn-primary,#c47f17);',
      'background:var(--dsw-alias-state-warn-tertiary,#fdf6e7)}',
      '.dshmind-nodeEscalated{border-color:var(--dsw-alias-state-error-primary,#d54941)}',
      '.dshmind-nodeTop{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      // 标题位实际承载的是**描述**（任务图 `描述||标题||id` / 会审 `描述||节点`，同源），
      // 实测 2037 字 / 40 换行 ⇒ 必须管住高度。
      // 2026-10-12 主权者改口径：**要全文 + 默认折叠**（先前 line-clamp 硬截断被否——
      // 那会丢全文、只能 hover 看）。所以现在是「折叠预告 3 行 / 展开全文」两态，
      // 全文走改动`:描述`的展开钮在原地铺开，而不是塞进 title。
      // 折叠态用 line-clamp 只是**视觉预告**（配合下面的展开钮），并非最终截断手段。
      '.dshmind-nodeTitle{font-weight:600;font-size:13px;min-width:0;flex:1;overflow-wrap:anywhere;white-space:pre-wrap}',
      // 标题**独占整行**（2026-10-12，主权者打回「这里就不能单起一行吗」）：
      // 标题位（承载描述）住在 `reviewTop`/`nodeTop` 这个 flex 行里，而 `nodeTitle` 原本
      // 是 `flex:1` —— 它会**吃掉整行剩余宽度**，于是后面的徽章组（交卷/模式/复核）被顶到
      // 远端右侧，标题只剩 3 行时左边空出一大片，看着就是「徽章飘在右半空里」。
      // 改 `flex-basis:100%`：标题强制占满整行 ⇒ 徽章组自然**换行到下一行、从左边开始排**。
      // **只加在两处长描述标题上**，不动共享的 `.dshmind-nodeTitle`：总线线程名
      // （`:2404`）同样是 `reviewTop`+`nodeTitle` 结构，但线程名短、那里本就正常，
      // 全局改会连带把它也顶成独占一行（超范围）。
      '.dshmind-nodeTitleFull{flex:1 1 100%;flex-basis:100%}',
      // 折叠态：最多 3 行预告 + 省略号。展开态见 `.dshmind-nodeTitleOpen`（去掉钳位、全文铺开）。
      '.dshmind-nodeTitleClamped{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden}',
      '.dshmind-nodeTitleOpen{display:block;white-space:pre-wrap}',
      // 展开/收起钮：纯显示动作、零请求（照 `.dshmind-toggle` 独立答案折叠的同款先例）。
      '.dshmind-descToggle{border:none;background:transparent;padding:2px 0;cursor:pointer;font-size:11.5px;',
      'color:var(--dsw-alias-state-business-primary,#0f1115);text-align:left;width:fit-content}',
      '.dshmind-meta{display:flex;gap:10px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary,#81858c);font-size:11px}',
      '.dshmind-criteria{color:var(--dsw-alias-label-secondary,#61666b);font-size:11.5px;line-height:17px;',
      'border-left:2px solid var(--dsw-alias-border-l3,#00000024);padding-left:8px;overflow-wrap:anywhere}',
      // 优化批⑤：判据值最多两行（纯布局属性，无色值）；全文走值 span 的 title。
      '.dshmind-criteriaVal{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}',
      '.dshmind-chips{display:flex;gap:4px;flex-wrap:wrap}',

      // 审计流
      // **可滚动**（Batch 9 后半，主人：「审计流那个框不能滚动」）：
      // 旧版没有 `max-height`/`overflow` ⇒ 行一多就把面板撑长（或在外层被裁），**框内滚不动**。
      // 现在：列表容器给 `max-height` + `overflow-y:auto`，超出的行**框内可滚到**（不裁、不可达）。
      // ⚠️ 2026-10-13 晚：**卡内滚动壳（`.dshmind-auditScroll`）整条删除**。
      // 它是「五个分区堆一页」时代的产物（主权者当时说「审计流那个框不能滚动」⇒ 加框内滚动）；
      // 现在审计与总线**各自成页**，根容器本来就是滚动容器 ⇒ 框内再套一个 `overflow-y:auto`
      // 就是**双层滚动**（滚轮在框里框外行为还不一样）且内容被压在小盒子里看不见。
      // 现在：行直接进页面流（`.dshmind-audit` / `.dshmind-busMsgs`），超出上限的靠「展开」钮铺开。
      '.dshmind-audit{display:flex;flex-direction:column;gap:1px;padding-bottom:2px}',
      // ⑥ 总线消息区：**独立类名、独立壳**（审计区按 .dshmind-auditRow 数行，
      // 两个分区共用类名会污染那条「不静默裁掉」的断言）；换行口径**不复用**（见下）。
      '.dshmind-busMsgs{display:flex;flex-direction:column;gap:1px;padding-bottom:2px}',
      // 扫描行布局（2026-10-12，主权者：「这里单起一行啊」）：
      // 旧版是四列网格 `max-content ×3 + minmax(0,1fr)` —— 时间/类型/发件三格**吃掉左侧宽度**，
      // 正文被挤到右边只剩一条（截图里正文只显示一行半就被 line-clamp 截了），而正文才是要读的。
      // 改成**两行**：上行 = 时间/类型/发件（小字元信息），下行 = 正文（吃满整行宽度）。
      '.dshmind-busRow{display:flex;flex-direction:column;gap:2px;',
      'padding:6px 10px;background:var(--dsw-alias-bg-layer-2,#fff);font-size:12px}',
      '.dshmind-busMeta{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      // 正文格（2026-10-12 主人视觉打回「密排/显示太丑」）：
      // 旧版正文套的是 `.dshmind-auditAction`（审计**动作列**的类名），而它只有
      // `overflow-wrap:anywhere`、**没有 `white-space`** ⇒ 默认 normal 把消息里的 `\n`
      // 折叠成空格：一条 24 行的正文会挤成一整段（bus.js 只截到 120 字，换行还在，
      // 是被**渲染**吞掉的，不是数据侧丢的）。`overflow-wrap` 只管断超长词，不解析 `\n`。
      // 用 pre-wrap 而非 pre：pre 不折行会横向溢出，而本行末列是 `minmax(0,1fr)`，就该吃满折行。
      '.dshmind-busText{white-space:pre-wrap;overflow-wrap:anywhere;font-weight:400}',
      // 正文折叠（2026-10-12，主权者「（总线）也默认收起呗」）：投影层不再截字，
      // 超长正文由这里默认折到若干行 + 「展开全文」钮，点开看全部（不丢字）。
      '.dshmind-busTextClamped{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden}',
      '.dshmind-busTextWrap{display:flex;flex-direction:column;gap:2px;min-width:0}',
      // UI 卫生批（主人视觉打回「截断」）：时间列固定 88px，而 shortTime 恒为
      // `MM-DD HH:mm:ss`（14 字符，11px 等宽 ≈ 92px）——固定列窄过内容就是叠字/截断。
      // 时间与档位两列改按内容（max-content），动作列吃剩余宽，主体列保持省略（有 title）。
      '.dshmind-auditRow{display:grid;grid-template-columns:max-content max-content minmax(0,1fr) 150px;',
      'gap:10px;align-items:baseline;',
      'padding:6px 10px;background:var(--dsw-alias-bg-layer-2,#fff);font-size:12px;border-left:2px solid transparent}',
      '.dshmind-auditFull{border-left-color:var(--dsw-alias-state-error-primary,#d54941)}',
      '.dshmind-auditMid{border-left-color:var(--dsw-alias-state-business-primary,#0f1115)}',
      '.dshmind-auditLow{border-left-color:var(--dsw-alias-border-l2,#0000001f);',
      'color:var(--dsw-alias-label-tertiary,#81858c);opacity:.72}',
      '.dshmind-auditAction{font-weight:500;overflow-wrap:anywhere}',
      '.dshmind-auditWho{color:var(--dsw-alias-label-tertiary,#81858c);font-size:11px;overflow:hidden;',
      'text-overflow:ellipsis;white-space:nowrap}',
      // 框尾那句说明：告诉人"能滚"以及"投影里一共多少条"（不是静默截断）。
      '.dshmind-auditHint{margin-top:6px;font-size:11px;line-height:16px;',
      'color:var(--dsw-alias-label-caption,#adb2b8)}',

      // 公告条
      '.dshmind-notice{display:flex;gap:8px;align-items:flex-start;padding:9px 14px;font-size:12px;',
      'background:var(--dsw-alias-state-warn-tertiary,#fdf6e7);color:var(--dsw-alias-state-warn-primary,#c47f17);',
      'border:.5px solid var(--dsw-alias-state-warn-secondary,#e5b46a);border-radius:var(--dsw-radius-md,8px)}',
      '.dshmind-empty{color:var(--dsw-alias-label-tertiary,#81858c);font-size:12px;padding:10px 0}',
      // 优化批④：读数分「身份／健康」两组竖排，组内仍横排——失联详情多行时只撑自己那一格，
      // 不再把身份读数一起拉高（详情贴格的 Batch 8 定案不变）。
      // UI 卫生批（主人视觉打回「贴边」）：读数区与 hero 圆角内缘之间要有呼吸（hero 是
      // overflow:hidden 的容器，格子自己带边框——容器不给内边距时格子直接顶住容器边）。
      '.dshmind-readoutGroups{display:flex;flex-direction:column;gap:8px;padding:12px 16px 16px}',
      '.dshmind-readoutGroup{display:flex;flex-direction:column;gap:4px}',
      '.dshmind-readoutGroupLabel{font-size:10px;letter-spacing:.14em;color:var(--dsw-alias-label-caption,#adb2b8)}',
      // 优化批③：会审独立答案折叠——切换钮走文字样式（无底无框，只有指针与箭头示意）。
      // UI 卫生批：button 不声明字体时用浏览器默认（Arial 系），与面板字体混排一眼就穿帮——
      // 照 .dshmind-btn 的先例 font-family:inherit。
      '.dshmind-toggle{border:none;background:transparent;padding:2px 0;cursor:pointer;font-size:12px;',
      'font-family:inherit;line-height:1.5;text-align:left;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.dshmind-answerSummary{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#81858c);overflow-wrap:anywhere}',

      // 页头「项目」格里的项目 chips（2026-10-11，主权者指令「修」）：换投影的开关，
      // 当前项目画成不可点的 span（不给假控件），其余是可点按钮（零写动作，参照「刷新」）。
      '.dshmind-projChips{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.dshmind-projChip,.dshmind-projChipOn{display:inline-flex;align-items:center;max-width:230px;height:20px;',
      'padding:0 7px;border-radius:4px;font-size:11px;font-family:inherit;line-height:20px;',
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dshmind-projChip{background:var(--dsw-alias-bg-layer-2,#fff);cursor:pointer;',
      'border:.5px solid var(--dsw-alias-border-l2,#d3dcea);color:var(--dsw-alias-label-secondary,#61666b)}',
      '.dshmind-projChipOn{background:var(--dsw-alias-markdown-code-block,#f5f5f5);',
      'border:.5px solid var(--dsw-alias-border-l1,#0000001f);color:var(--dsw-alias-label-primary,#1a2233);',
      'font-weight:600}',

      '.dshmind-foot{display:flex;gap:10px;flex-wrap:wrap;align-items:center;color:var(--dsw-alias-label-caption,#adb2b8);',
      'font-size:11px;padding:2px 2px 4px}',

      // ── 分页外壳（2026-10-13 重做）─────────────────────────────────────────
      // 为什么是「全部页都渲染、非当前页 display:none」而不是「只渲染当前页」：
      //  ① 轮询每 3 秒重渲染，只渲染当前页会在切页时闪一次空白；
      //  ② **渲染树是断言的对象**（client-harness 直接走树，不走 CSS）——
      //     只渲染当前页会让「会审/任务图/审计流」那批既有断言在默认页面上全部失效，
      //     而那批断言守的是**内容口径**（不静默截断、盲评遮罩、档位分级），与它在第几页无关。
      //     显示用 CSS 收，口径仍然全部在树里 —— 两层各管各的。
      '.dshmind-shell{display:flex;gap:16px;align-items:flex-start;width:100%}',
      '.dshmind-nav{position:sticky;top:0;flex:none;width:142px;display:flex;flex-direction:column;gap:2px;padding:4px 0}',
      '.dshmind-navBtn{display:flex;align-items:center;gap:6px;width:100%;text-align:left;font:inherit;font-size:12.5px;',
      'padding:6px 9px;border-radius:6px;border:0;background:transparent;cursor:pointer;',
      'color:var(--dsw-alias-label-secondary,#61666b)}',
      '.dshmind-navBtn:hover{background:var(--dsw-alias-bg-layer-2,#fff)}',
      '.dshmind-navBtnOn{background:var(--dsw-alias-markdown-code-block,#f5f5f5);',
      'color:var(--dsw-alias-label-primary,#1a2233);font-weight:600}',
      '.dshmind-navCount{margin-left:auto;font-size:10.5px;color:var(--dsw-alias-label-caption,#adb2b8)}',
      // 非当前页：**display:none 收显示，节点仍在树里**（见上）。
      '.dshmind-pageBox{display:flex;flex-direction:column;gap:14px;min-width:0}',
      '.dshmind-pageBoxOff{display:none}',
      '.dshmind-pages{flex:1;min-width:0;display:flex;flex-direction:column;gap:14px}',

      // ── 可视化（甜甜圈 / 统计砖 / 审计节律条）──────────────────────────────
      '.dshmind-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(138px,1fr));gap:8px}',
      '.dshmind-tile{border:.5px solid var(--dsw-alias-border-l2,#d3dcea);border-radius:8px;padding:9px 11px;',
      'background:var(--dsw-alias-bg-layer-1,#fff)}',
      '.dshmind-tileK{font-size:11px;color:var(--dsw-alias-label-caption,#adb2b8)}',
      '.dshmind-tileV{font-size:19px;font-weight:600;color:var(--dsw-alias-label-primary,#1a2233);line-height:1.35}',
      '.dshmind-tileD{font-size:11px;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.dshmind-vizGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(246px,1fr));gap:8px}',
      '.dshmind-vizCard{display:flex;gap:12px;align-items:center;border:.5px solid var(--dsw-alias-border-l2,#d3dcea);',
      'border-radius:8px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1,#fff)}',
      '.dshmind-vizTitle{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#1a2233);margin-bottom:6px}',
      '.dshmind-legend{display:flex;flex-direction:column;gap:4px;font-size:11px;',
      'color:var(--dsw-alias-label-secondary,#61666b);min-width:0}',
      '.dshmind-legendRow{display:flex;align-items:center;gap:5px;white-space:nowrap}',
      '.dshmind-swatch{width:8px;height:8px;border-radius:2px;display:inline-block;flex:none}',
      '.dshmind-actbar{display:flex;gap:1px;height:20px;border-radius:4px;overflow:hidden;margin-top:6px}',
      // 节律条：**定宽格**（10px）。`flex:1` 在只有几条时会拉成几百像素的大色块——
      // 那是「一格一条」这条读法的反面（条数与密度都读不出来了）。
      '.dshmind-actbar>i{flex:0 0 auto;width:10px;display:block;border-radius:2px}',

      // ── 图谱 ───────────────────────────────────────────────────────────────
      '.dshmind-graphWrap{border:.5px solid var(--dsw-alias-border-l2,#d3dcea);border-radius:8px;',
      'background:var(--dsw-alias-bg-layer-1,#fff);overflow:hidden}',
      '.dshmind-graph{display:block;width:100%;height:auto}',
      '.dshmind-gEdge{fill:none}',
      '.dshmind-gNode{cursor:pointer}',
      '.dshmind-gNodeOff{opacity:.10}',
      '.dshmind-gLabel{font-size:10px;fill:var(--dsw-alias-label-secondary,#61666b)}',
      '.dshmind-gLabelStrong{font-size:11px;fill:var(--dsw-alias-label-primary,#1a2233)}',
      '.dshmind-graphBar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px}',
      '.dshmind-graphNote{font-size:11px;color:var(--dsw-alias-label-caption,#adb2b8);padding:6px 2px 0}',
      // 缺口榜：窄面板下**横向可滚**，不许把单元格挤成一字一行（与任务图同一款处置）。
      '.dshmind-tbl{width:100%;border-collapse:collapse;font-size:12px;border-radius:8px;overflow:hidden}',
      '.dshmind-tbl th{text-align:left;font-weight:500;font-size:11px;padding:6px 10px;',
      'color:var(--dsw-alias-label-caption,#adb2b8);background:var(--dsw-alias-bg-layer-2,#f5f5f5)}',
      '.dshmind-tbl td{padding:6px 10px;border-top:.5px solid var(--dsw-alias-border-l2,#d3dcea);',
      'color:var(--dsw-alias-label-secondary,#61666b);overflow-wrap:anywhere}',

      // ── 动态时间线 ─────────────────────────────────────────────────────────
      '.dshmind-tl{border:.5px solid var(--dsw-alias-border-l2,#d3dcea);border-radius:8px;overflow:hidden;',
      'background:var(--dsw-alias-bg-layer-1,#fff)}',
      '.dshmind-tlRow{display:flex;gap:10px;align-items:baseline;padding:6px 11px;font-size:12px;',
      'color:var(--dsw-alias-label-secondary,#61666b)}',
      '.dshmind-tlRow+.dshmind-tlRow{border-top:.5px solid var(--dsw-alias-border-l2,#d3dcea)}',
      '.dshmind-tlTime{font-size:11px;color:var(--dsw-alias-label-caption,#adb2b8);flex:none;width:52px}',
      '.dshmind-tlIcon{flex:none;width:14px;text-align:center}',
      '.dshmind-tlBad{color:var(--dsw-alias-label-error,#d33)}',
      '.dshmind-tlWarn{color:var(--dsw-alias-label-warning,#c80)}',

      // ══ 表现层重做（2026-10-13 · v2 设计稿落地）══════════════════════════════
      // 为什么另起一层覆盖、而不去逐条改旧规则：旧规则里混着两类东西——
      //  ①**行为不变量**（root 铺满+滚动、page 不许 overflow、读数格不许 ellipsis 裁值 ……）
      //    这些与设计无关，是「滚动作用域」「值不许被裁」那批真机缺陷的产物，继续守着；
      //  ②**旧设计的呈现口径**（内容列 1040 居中、大号分区序号、读数格 flex:1 1 Npx ……）
      //    这些**随设计走**：设计稿要「侧栏 + 更宽的内容列」，就把它们改掉——
      //    对应的断言按「口径改形」处理（写明理由），不是留着一条对不上设计的假绿。
      //
      // 调色板：**令牌优先、设计稿配色兜底**——宿主主题里有令牌就用主题色，
      // 令牌缺也要好看；且一条裸 `var()` 都不许有（client.test.js 的令牌纪律）。
      '.dshmind-root{--mk-bg:var(--dsw-alias-bg-layer-1,#161a22);--mk-bg2:var(--dsw-alias-bg-layer-2,#1c212b);',
      '--mk-bd:var(--dsw-alias-border-l2,#2a303d);--mk-tx:var(--dsw-alias-label-primary,#e7e9ee);',
      '--mk-tx2:var(--dsw-alias-label-secondary,#9aa3b2);--mk-tx3:var(--dsw-alias-label-caption,#6b7280);',
      '--mk-ac:var(--dsw-alias-state-business-primary,#5b8def);--mk-ok:var(--dsw-alias-state-success-primary,#3fb27f);',
      '--mk-warn:var(--dsw-alias-state-warning-primary,#d4a053);--mk-bad:var(--dsw-alias-state-error-primary,#e5534b);',
      // 版面铺满之后，**行长**必须单独管：一行放 200 个字是读不动的（这不是审美，是可读性）。
      // 📌 **值改形（2026-10-14 · 主权者：「描述展开后就只占一半了」）**：
      //    原值 `78ch`（≈550px @14px）。但 `ch` 是**西文 "0" 的宽度**，中文一个字约等于 2ch
      //    ⇒ 78ch 对中文只有约 39 字/行，落在**卡宽 1300~1800px** 的卡里就是"只占左半"。
      //    设计稿（`.tcard .desc`，含 `.open` 展开态）**没有任何限宽**；我上一步却把 78ch
      //    保留在展开态、理由是"大段正文要控行长" —— **那是我自作主张，偏离了设计稿**。
      //    现在把值提到**实际不构成视觉上限**的一档（200ch ≈ 1560px @14px）：
      //    正常窗口下正文吃满卡片，同时**保留一个上界**（4K 超宽屏仍不许一行铺满整屏）。
      //    ⚠️ 诚实标注代价：中文在这种宽度下一行可达 60~100 字，**行长确实偏长**，
      //    眼睛换行容易串行。若主权者更看重可读性，另一条路是**把卡片收窄**
      //    （设计稿的 `.main{max-width:1180px}` 就是那么做的）——两条路我都能走，等一句话。
      '--mk-measure:200ch}',
      // 内容列宽度：旧规则已经是 1180px（2026-10-13 重做时改的，见上面 `.dshmind-page`）——
      // 这里**不再重复声明**，免得同一件事有两个出处（改一处忘一处就是漂移）。

      // 侧栏：**真正的一栏**（背景 + 描边 + 品牌行），不再是内容列左边的裸文字
      // ⚠️ `top` 必须与 `.dshmind-page` 的 padding-top（24px）对齐：否则滚动开始时
      // 侧栏会先跟着走 24px、再"啪"地贴住（主权者报的「会随着右侧板滚动稍微移动一点」就是它）。
      '.dshmind-nav{width:152px;padding:10px 8px;border-radius:12px;background:var(--mk-bg2);',
      'border:.5px solid var(--mk-bd);align-self:flex-start;gap:1px;position:sticky;top:24px;',
      'max-height:calc(100vh - 48px);overflow:auto}',
      '.dshmind-navBrand{display:flex;flex-direction:column;padding:2px 8px 9px}',
      '.dshmind-navBrand b{font-size:12.5px;font-weight:600;color:var(--mk-tx)}',
      '.dshmind-navBrand span{font-size:10.5px;color:var(--mk-tx3)}',
      '.dshmind-navBtn{border-radius:8px;padding:6px 9px;font-size:12.5px;color:var(--mk-tx2)}',
      '.dshmind-navBtn:hover{background:var(--mk-bg)}',
      '.dshmind-navBtnOn{background:var(--dsw-alias-bg-layer-3,rgba(91,141,239,.16));color:var(--mk-ac);font-weight:600}',
      '.dshmind-navCount{font-size:10px;color:var(--mk-tx3)}',

      // 页头：紧凑（设计稿里标题一行、**读数退成一行 pill**）
      '.dshmind-hero{gap:9px;padding:0}',
      '.dshmind-title{font-size:16px;color:var(--mk-tx)}',
      '.dshmind-sub{font-size:11.5px;color:var(--mk-tx3);margin-top:2px}',
      // 读数＝**一行铺满的 pill**（设计稿的健康条）。旧版是 6 张竖卡、占 350px 高 —— 那是"右侧板过长"
      // 的一大来源。结构（.dshmind-readout 里仍是 键/值/注）一个字没动，只把它压成行内 pill，
      // 所以那批"读数格"断言（键、值、注、四态、空壳/破折号注入）依旧成立。
      // ⚠️ 第二轮：pill 也要**吃满整行**（`flex:1 1 180px`）——只在左边挤着、右半行空着同样难看。
      '.dshmind-readoutGroups{display:flex;flex-direction:column;gap:6px;align-items:stretch}',
      '.dshmind-readoutGroup{display:flex;flex-direction:row;flex-wrap:wrap;gap:6px;align-items:center}',
      '.dshmind-readoutGroupLabel{flex:none;font-size:10.5px;letter-spacing:.08em;color:var(--mk-tx3)}',
      '.dshmind-readout{flex:1 1 180px;min-width:0;display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;',
      'background:var(--mk-bg);border:.5px solid var(--mk-bd);border-radius:10px;padding:5px 11px}',
      '.dshmind-readoutKey{font-size:10.5px;color:var(--mk-tx3)}',
      '.dshmind-readoutVal{font-size:12px;color:var(--mk-tx)}',
      '.dshmind-readoutNote{font-size:10.5px;color:var(--mk-tx3)}',

      // 注意力区（设计稿首屏第一块）：平静态一条绿带，异常态一张卡
      '.dshmind-attn{display:flex;flex-direction:column;gap:8px}',
      '.dshmind-attnClear{display:flex;align-items:center;gap:9px;padding:11px 14px;border-radius:12px;',
      'background:rgba(63,178,127,.10);border:.5px solid rgba(63,178,127,.34);color:var(--mk-ok);font-size:13px}',
      '.dshmind-attnCard{background:var(--mk-bg);border:.5px solid var(--mk-bd);border-left:3px solid var(--mk-warn);',
      'border-radius:12px;padding:11px 14px}',
      '.dshmind-attnCardBad{border-left-color:var(--mk-bad)}',
      '.dshmind-attnCard h4{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:var(--mk-tx)}',
      '.dshmind-attnCard p{font-size:12px;color:var(--mk-tx2);margin-top:5px}',
      '.dshmind-attnNodes{display:flex;flex-direction:column;gap:3px;margin-top:7px}',
      '.dshmind-attnNode{font-size:11.5px;color:var(--mk-tx2);overflow-wrap:anywhere}',

      // 分区与卡片：一块一卡
      '.dshmind-sec{background:var(--mk-bg);border:.5px solid var(--mk-bd);border-radius:12px;padding:13px 15px}',
      '.dshmind-secIdx{display:none}',
      '.dshmind-secTitle{font-size:13px;color:var(--mk-tx);font-weight:600}',
      '.dshmind-secHint{font-size:11px;color:var(--mk-tx3)}',
      '.dshmind-secCount{font-size:11px;color:var(--mk-tx3)}',
      '.dshmind-secBody{margin-top:9px}',
      '.dshmind-node,.dshmind-review,.dshmind-decideRow,.dshmind-answer{background:var(--mk-bg2);',
      'border:.5px solid var(--mk-bd);border-radius:10px}',
      '.dshmind-node,.dshmind-review,.dshmind-decideRow{padding:11px 13px}',
      '.dshmind-empty{color:var(--mk-tx3);font-size:12px;padding:8px 2px}',
      '.dshmind-notice{background:rgba(212,160,83,.12);border:.5px solid rgba(212,160,83,.4);border-radius:10px;',
      'color:var(--mk-warn);padding:9px 12px;font-size:12px}',

      // 时间线：一行一条（设计稿的紧凑度；旧版把时刻与正文挤成两行）
      '.dshmind-tl{background:var(--mk-bg);border:.5px solid var(--mk-bd);border-radius:12px}',
      '.dshmind-tlRow{padding:7px 12px;gap:10px;font-size:12px;color:var(--mk-tx2)}',
      '.dshmind-tlTime{width:86px;font-size:11px;color:var(--mk-tx3);white-space:nowrap}',
      '.dshmind-tlIcon{width:12px}',
      // 失败/拦截那几行给一条左强调线：扫一眼就知道账上有没有坏事（不改文案，只加层次）
      '.dshmind-tlRow{border-left:2px solid transparent}',
      '.dshmind-tlRow.dshmind-tlBad{border-left-color:var(--mk-bad)}',
      '.dshmind-tlRow.dshmind-tlWarn{border-left-color:var(--mk-warn)}',

      // 图谱：画布 + 详情抽屉（点节点开；纯显示、零请求）
      '.dshmind-graphWrap{position:relative;background:var(--mk-bg);border:.5px solid var(--mk-bd);border-radius:12px}',
      // 手势光标（2026-10-14 加缩放/平移）：抓取态一眼可读。
      // 纯 CSS，**不新增控件**——只读面板的可点面白名单原样不动。
      '.dshmind-graph{cursor:grab;touch-action:none}',
      '.dshmind-graph:active{cursor:grabbing}',
      '.dshmind-gDrawer{position:absolute;top:10px;right:10px;width:252px;max-height:calc(100% - 20px);overflow:auto;',
      'background:var(--mk-bg2);border:.5px solid var(--mk-bd);border-radius:10px;padding:11px 12px;font-size:11.5px;',
      'color:var(--mk-tx2)}',
      '.dshmind-gDrawer h5{display:flex;align-items:center;gap:7px;font-size:12.5px;color:var(--mk-tx);font-weight:600}',
      '.dshmind-gDrawerRow{display:flex;gap:8px;margin-top:6px}',
      '.dshmind-gDrawerRow b{flex:none;width:46px;color:var(--mk-tx3);font-weight:400}',
      '.dshmind-gLinks{margin-top:9px;padding-top:8px;border-top:.5px solid var(--mk-bd);display:flex;',
      'flex-direction:column;gap:4px}',
      '.dshmind-gLink{display:flex;align-items:center;gap:6px}',
      '.dshmind-gNodeOn circle{stroke:var(--mk-tx);stroke-width:1.7}',
      '.dshmind-gNodeOff{opacity:.12}',
      '.dshmind-gEdgeOff{opacity:.05}',
      '.dshmind-graphNote{color:var(--mk-tx3);line-height:1.7}',

      // ══ 视觉打磨（2026-10-13 · 把还没统一的老组件收进同一套间距/字阶/卡片语言）══════
      // 这一层做两件事：**统一**（间距 4/8/12/16 · 圆角 12/10/8/999 · 字阶 16/13/12/11/10.5）
      // 与**加层次**（卡片 → 子卡 → 徽章三层；颜色只用于「出事了」）。
      // 不动任何被断言钉住的行为口径：`.dshmind-readoutVal` 不加 ellipsis、`.dshmind-page` 只许一处、
      // `.dshmind-auditScroll` 的 max-height/overflow/滚动条不动。

      // 分区头：标题独占一行 + 一条发丝线；读数靠右（层次：谁重要谁在上）
      '.dshmind-secHead{align-items:baseline;gap:9px;padding-bottom:7px;border-bottom:.5px solid var(--mk-bd)}',
      '.dshmind-secHint{font-weight:400;opacity:.85}',
      '.dshmind-secCount{font-variant-numeric:tabular-nums}',

      // 三级容器：卡片（.dshmind-sec）→ 子卡（行/块）→ 徽章；子卡统一间距与悬停
      // ⚠️ 2026-10-13 晚第二轮：**列表用网格铺满**（原来一律 `flex-direction:column` 单列）。
      // 单列 + 正文限行宽（--mk-measure）在宽屏上的结果就是「每张卡右半边空着」——
      // 主权者原话「面板右面空白一大堆太丑了」。改成每列**不低于 420px** 的自动网格：
      // 窄屏自动回落单列（不会把长描述挤成一面墙），宽屏 2~3 列铺满、卡内文字自然填满卡片。
      // ⚠️ 2026-10-13 晚第二轮曾把这里改成 `minmax(420px,1fr)` 多列；
      //    **2026-10-14 按主权者指令改回单列**（理由见上面 `.dshmind-nodes` 那条口径改形）——
      //    三处（任务/会审/总线）一起改，只改一处就是漏。
      '.dshmind-nodes,.dshmind-reviews,.dshmind-bus{display:grid;grid-template-columns:1fr;',
      'gap:10px;align-items:start}',
      '.dshmind-decide,.dshmind-answers{gap:9px}',
      '.dshmind-decideRow,.dshmind-node,.dshmind-review,.dshmind-busRow,.dshmind-answer{',
      'transition:border-color .12s ease,background .12s ease}',
      '.dshmind-decideRow:hover,.dshmind-node:hover,.dshmind-review:hover,.dshmind-busRow:hover{',
      'border-color:var(--mk-ac)}',

      // 徽章与 chip：药丸 + 淡色（只读投影不该花花绿绿；颜色只留给"出事了"）
      '.dshmind-badge{display:inline-flex;align-items:center;height:18px;padding:0 8px;border-radius:999px;',
      'font-size:10.5px;line-height:1;border:.5px solid currentColor;opacity:.92}',
      '.dshmind-chip{display:inline-flex;align-items:center;height:18px;padding:0 8px;border-radius:999px;',
      'font-size:10.5px;line-height:1;background:var(--mk-bg2);border:.5px solid var(--mk-bd);color:var(--mk-tx2)}',

      // 判据 / 元信息：小字、贴近、可换行不裁切
      '.dshmind-meta{gap:10px;font-size:11px;color:var(--mk-tx3);flex-wrap:wrap}',
      // 判据：**键与值同一行**（旧版竖成两行，每张卡白多一行高）
      '.dshmind-criteria{display:flex;gap:6px;align-items:baseline;font-size:11.5px;color:var(--mk-tx2);line-height:1.65}',
      '.dshmind-criteriaVal{overflow-wrap:anywhere}',
      '.dshmind-chips{gap:5px;flex-wrap:wrap}',
      '.dshmind-lock{font-size:10.5px;color:var(--mk-tx3)}',

      // 命令块：等宽 + 可选中 + 左强调线（只读面板给的是**可拿走的文本**，不是按钮）
      '.dshmind-cmd{display:block;margin-top:7px;padding:7px 10px;border-radius:8px;background:var(--mk-bg2);',
      'border:.5px solid var(--mk-bd);border-left:2px solid var(--mk-ac);',
      'font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;line-height:1.6;',
      'color:var(--mk-tx);white-space:pre-wrap;overflow-wrap:anywhere;user-select:text}',

      // 折叠钮：无底无框，只有指针与下划线（与只读气质一致）
      '.dshmind-toggle,.dshmind-descToggle{color:var(--mk-ac);font-size:11.5px;cursor:pointer;background:none;',
      'border:0;padding:2px 0}',
      '.dshmind-toggle:hover,.dshmind-descToggle:hover{text-decoration:underline}',

      // 会审：三态徽章四色 + 答案块做成子卡
      '.dshmind-verdict{display:inline-flex;align-items:center;height:19px;padding:0 9px;border-radius:999px;',
      'font-size:11px;border:.5px solid currentColor}',
      '.dshmind-verdictPass{color:var(--mk-ok)}',
      '.dshmind-verdictFail{color:var(--mk-bad)}',
      '.dshmind-verdictUnverified{color:var(--mk-warn)}',
      '.dshmind-verdictNone{color:var(--mk-tx3)}',
      '.dshmind-answer{padding:10px 12px}',
      '.dshmind-answerHead{font-size:11.5px;color:var(--mk-tx2);margin-bottom:5px}',
      '.dshmind-answerBody{font-size:12px;color:var(--mk-tx2);line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere}',
      '.dshmind-answerSummary{font-size:11.5px;color:var(--mk-tx3)}',
      '.dshmind-counter,.dshmind-divergence,.dshmind-consensus{font-size:11.5px;color:var(--mk-tx2)}',
      '.dshmind-anomaly{font-size:11.5px;color:var(--mk-warn)}',

      // 消息总线：元信息退到 11px 淡色；正文换行口径不动
      '.dshmind-busRow{padding:9px 12px}',
      '.dshmind-busMeta{font-size:10.5px;color:var(--mk-tx3);gap:8px;flex-wrap:wrap}',
      '.dshmind-busTextWrap{margin-top:4px}',
      '.dshmind-busMsgs{gap:8px}',

      // 审计流：**保留原来的四列 grid**（时刻 / 档位 / 动作 / 主体 150px 靠右）。
      // ⚠️ 2026-10-13 晚自我订正：上一轮我在这里加了 `display:flex` 覆盖，把 grid 顶掉了 ⇒
      // 主体不再靠右、行右半边空着，而 harness 那条「四列 grid」断言查的是**源码里的旧规则**、
      // 于是一直绿着（**假绿**）。现在只动配色与内距，**不改列定义** ⇒ 断言＝生效值。
      '.dshmind-auditRow{gap:10px;padding:5px 10px;font-size:11.5px;border-radius:6px}',
      '.dshmind-auditRow:hover{background:var(--mk-bg2)}',
      '.dshmind-auditAction{font-size:11px;color:var(--mk-tx2)}',
      '.dshmind-auditWho{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10.5px;',
      'color:var(--mk-tx3);text-align:right;overflow-wrap:anywhere}',
      '.dshmind-auditHint{font-size:10.5px;color:var(--mk-tx3)}',
      '.dshmind-auditFull{border-left-color:var(--mk-ac)}',
      '.dshmind-auditMid{border-left-color:var(--mk-tx3)}',
      '.dshmind-auditLow{border-left-color:transparent;opacity:.72}',

      // 任务/会审卡内部：标题位与元信息分层
      '.dshmind-nodeTop{gap:7px;flex-wrap:wrap;align-items:center}',
      // 卡片的**第一行**＝身份行：左徽章 + 等宽 id，右对齐元信息（设计稿的卡片解剖）
      '.dshmind-cardId{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10.5px;',
      'color:var(--mk-tx3);overflow-wrap:anywhere}',
      '.dshmind-cardMeta{display:flex;gap:9px;flex-wrap:wrap;margin-left:auto;font-size:11px;color:var(--mk-tx3)}',
      '.dshmind-nodeTitleFull{line-height:1.6}',
      '.dshmind-nodeTitleClamped{line-height:1.65}',
      '.dshmind-nodePending,.dshmind-nodeEscalated{font-size:11.5px}',
      '.dshmind-reviewTop{gap:7px;flex-wrap:wrap;align-items:center}',

      // 项目 chip 与页脚
      '.dshmind-projChip,.dshmind-projChipOn{height:22px;line-height:22px;border-radius:999px;',
      'transition:border-color .12s ease}',
      '.dshmind-projChip:hover{border-color:var(--mk-ac);color:var(--mk-ac)}',
      '.dshmind-foot{font-size:10.5px;color:var(--mk-tx3);border-top:.5px solid var(--mk-bd);padding-top:10px}',

      // ── 铺满之后的两条收口（2026-10-13 晚）────────────────────────────────
      // ① **行长**：布局吃满宽度，但**正文**不许跟着无限变宽（一行 200 字读不动）。
      //    注意 `--mk-measure` **不管命令块**：命令块是等宽短行，吃满卡片反而更好看、也更像"可复制的文本块"。
      '.dshmind-nodeTitleFull,.dshmind-nodeTitleClamped,.dshmind-nodeTitleOpen,.dshmind-criteria,',
      '.dshmind-answerBody,.dshmind-busText,.dshmind-graphNote,.dshmind-attnNode{',
      'max-width:var(--mk-measure)}',
      // ② **小块吃满**：统计砖与构成图跟着铺满（右端不再空一截）。
      //    构成图给 `minmax(360px,1fr)`：宽屏正好三张一行（三张构成图是"一组"，
      //    落单的那张会变成"孤卡 + 一大片空白"——这才是真正的留空来源）。
      '.dshmind-tiles{grid-template-columns:repeat(auto-fit,minmax(138px,1fr))}',
      '.dshmind-vizGrid{grid-template-columns:repeat(auto-fit,minmax(360px,1fr))}',

      // ══ 视觉打磨 v2.1（2026-10-13 深夜 · 设计稿 v2.1 落地实机）════════════════
      // 这一层**只加表现，不动口径**：不碰任何被断言钉住的行为（滚动作用域、
      // 值不裁切、审计四列、page 只许一处 ……），全部是增量规则 —— 删掉这一层
      // 面板回到上一版，功能分毫不损。与设计稿 v2.1（mind-panel-redesign）同源：
      //  ① 层级（双层柔影：贴边 1px + 远处 26px 低透明）；
      //  ② 反馈（统计砖/构成图悬浮微抬、边框提亮；图谱节点悬浮发光）；
      //  ③ 微动效（缺口虚线缓慢流动——实线无 dasharray，动画对其无效，天然安全）；
      //  ④ 可达性（键盘焦点环：只读面板的按钮/折叠钮也该能被 Tab 看见）。
      // 阴影色用固定深色而不是令牌：两层柔影要的是"低透明度的深"，各主题通用。
      '.dshmind-nav,.dshmind-sec,.dshmind-tl,.dshmind-graphWrap,.dshmind-tile,.dshmind-vizCard{',
      'box-shadow:0 1px 2px rgba(9,12,20,.10),0 10px 26px -18px rgba(9,12,20,.55)}',
      // 悬浮反馈：抬 1px（不是设计稿的 2px——实机卡片更小、2px 会跳）。
      '.dshmind-tile,.dshmind-vizCard{transition:border-color .15s ease,box-shadow .15s ease,transform .15s ease}',
      '.dshmind-tile:hover,.dshmind-vizCard:hover{transform:translateY(-1px);border-color:var(--mk-ac,#5b8def);',
      'box-shadow:0 1px 2px rgba(9,12,20,.10),0 14px 30px -18px rgba(9,12,20,.65)}',
      // 甜甜圈：一记很轻的投影，把图从"贴在纸上"变成"浮在纸上"。
      '.dshmind-donut{filter:drop-shadow(0 4px 10px rgba(9,12,20,.22))}',
      // 键盘焦点环：与设置页 __btn 同款（2px 主色 + 1px 外距），补齐看板侧的缺口。
      // ⚠️ **`:focus-visible` 必须逐个选择器都写**（2026-10-14 修的真缺陷）：
      //    选择器列表里伪类的**作用域只到它所在的那一个复杂选择器**——
      //    写成 `A,B,C,.D:focus-visible` 时，A/B/C **无条件命中**，于是
      //    导航钮、刷新钮、折叠钮、项目 chip **常年顶着一圈蓝描边**（实测：未聚焦时
      //    `outline: 2px solid rgb(91,141,239)` 就已在生效，activeElement = BODY）。
      //    这属于「看着像能点的东西」多了一圈"选中态"，与只读面板的气质冲突。
      '.dshmind-navBtn:focus-visible,.dshmind-btn:focus-visible,.dshmind-toggle:focus-visible,',
      '.dshmind-descToggle:focus-visible,.dshmind-projChip:focus-visible,.dshmind-projChipOn:focus-visible{',
      'outline:2px solid var(--mk-ac,#5b8def);outline-offset:2px}',
      // 侧栏当前页：左侧 2px 强调色内嵌条（设计稿导航同款；不动原底色/字色）。
      '.dshmind-navBtnOn{box-shadow:inset 2px 0 0 var(--mk-ac,#5b8def)}',
      '.dshmind-navBtn,.dshmind-btn{transition:background-color .15s,color .15s,border-color .15s}',
      // 图谱：缺口虚线缓慢流动（给"这是没接上的活口"一点方向感）。
      // stroke-dashoffset 动画只对带 dasharray 的线可见 ⇒ 实线（已接线）不受影响。
      '.dshmind-gEdge[data-wired="0"]{animation:dshmind-flow 2.2s linear infinite}',
      '@keyframes dshmind-flow{to{stroke-dashoffset:-14}}',
      // 图谱节点：悬浮发光 + 选中节点常亮光晕（circle 的 filter 不影响文本层）。
      '.dshmind-gNode:hover circle{filter:brightness(1.18) drop-shadow(0 0 5px rgba(91,141,239,.55))}',
      '.dshmind-gNodeOn circle{filter:drop-shadow(0 0 6px rgba(91,141,239,.6))}',
      // 详情抽屉：淡入下移一眼（0.18s，快到不挡手、慢到看得见）。
      '.dshmind-gDrawer{animation:dshmind-in .18s ease-out}',
      '@keyframes dshmind-in{from{opacity:0;transform:translateY(-5px)}to{opacity:1;transform:none}}',

      // ══ 视觉打磨 v2.2（2026-10-14 · 按真机截图逐条收口）════════════════════════
      // 这一层与上面各层同性质：**纯增量表现**，删掉即回到 v2.1，功能分毫不损。
      // 每条都来自一张实机渲染图上的可指认现象（不是设计推演），根因写在各条上方。
      //
      // 为什么另起一层而不改上面的规则：上面那些规则里混着**被断言钉住的行为口径**
      // （root 铺满+滚动 / page 无 overflow / 值不裁切 / 审计四列 / page 只许一处），
      // 就地改会连带碰到它们。另起一层只覆盖"长相"，碰不到"行为"。

      // ── V2 长文墙：注意力区正文 12px 密排 + 长 id 被从词中间断开 ──────────────
      // 根因：`.dshmind-attnNode` 只声明 `overflow-wrap:anywhere`，行高走 `--mk-*` 默认
      //      （全局 13px/20px 的 body 行高对 11.5px 正文偏紧），于是三行 200 多字的节点说明
      //      糊成一块；而 `anywhere` 会在**任意字符处**断行 ⇒ `...-7lost` / `be17d628939d`
      //      这类无空格长 id 被从中间劈开，读者认不出这是同一个 id。
      // 改法：正文给**可读行高**（1.75）+ `word-break:keep-all` 让断行尽量发生在空格/标点，
      //      长 id 再退到 `overflow-wrap:anywhere` 兜底（不裁切这条硬口径不变）。
      //      节点之间用发丝线分隔（原文照给、不截断，只加层次）。
      '.dshmind-attnCard p{font-size:12.5px;line-height:1.7}',
      '.dshmind-attnNodes{gap:0}',
      '.dshmind-attnNode{font-size:12px;line-height:1.75;word-break:keep-all;overflow-wrap:anywhere;',
      'padding:7px 0}',
      '.dshmind-attnNode+.dshmind-attnNode{border-top:.5px solid var(--mk-bd)}',
      // V6 折叠态（2026-10-14 二次收口）：**整块收起**，不做"钳 1 行"。
      // 📌 口径改形（主权者：「这里有截断。这部分需要做收起吗」）：
      //    上一版给每条挂 `-webkit-line-clamp:1`，结果是**5 条各切半句、末尾点一串 `…`**
      //    —— 看上去就是"文本被截断坏了"，而它既没给出全文、也没真正省下地方（5 行还在）。
      //    这正撞本仓 2026-10-12 已定的口径：**硬截断被否，要的是「要全文 + 默认折叠」**。
      //    ⇒ 现在默认把**整段条目列表收起来**（`display:none`），只留标题 + 一句说明 +
      //    「展开全部（N 条 · 共 M 字）」；点开才逐条给**全文**。
      //    ⚠️ 文本**仍在 DOM 里**（只是不显示）⇒ 「原文照给，不截断」不破，
      //    harness ⑪f「原因全文照给」照样绿（它量文本，不量可见性）。
      '.dshmind-attnNodesOff{display:none}',
      // 说明句的折叠态：**1 行**（它是流程注解，不是读数）。
      // 与条目同吃一张折叠表 ⇒ 一个钮管两处，不会出现"展开了一半"的半吊子态。
      '.dshmind-attnIntroClamped{display:-webkit-box;-webkit-box-orient:vertical;',
      '-webkit-line-clamp:1;overflow:hidden}',
      // ⚠️ 行长上限（`--mk-measure:78ch`）**不该管这一块**（2026-10-14 实测发现）：
      //    v2.1 把 `.dshmind-attnNode` 一起塞进了「正文限 78ch」那条规则。可注意力区这张卡
      //    在 1242px 宽的面板里**是一个待决记录列表，不是散文**——结果每条都被 78ch 卡住、
      //    折成 2 行，而卡片**右半边整片空着**（这与主权者框出的"这块有问题"是同一个病：
      //    既高又空）。实测：条目块 170px（3 条 × 2 行）。
      //    改法：这一块放开限宽（卡片多宽就用多宽）。这些条目是「id + 一句原因」的记录式短句，
      //    不是需要控行长的大段正文；放开后多数条目自然落到 1 行，右半边也不再空。
      //    `--mk-measure` 那条规则本身不动（任务卡/会审卡的长描述仍受它管，那是散文）。
      '.dshmind-attnNode{max-width:none}',
      // 折叠钮与条目之间留一口气，别贴在分隔线上
      '.dshmind-attnCard .dshmind-descToggle{margin-top:7px}',
      // 注意力区的说明句（"现行收集口径只收……"）与正文拉开一点，别与考语糊在一起
      '.dshmind-attnCard h4{line-height:1.5}',
      '.dshmind-attnCard p+p{margin-top:7px}',

      // ── V4 审计节律条：一排彩色小方块，没有标题/刻度/口径 ─────────────────────
      // 根因：`.dshmind-actbar` 只画色块（`>i` 定宽 10px），既不说明"一格＝一条"，
      //      也不给起点/终点时刻 ⇒ 读者无法把某个红块对应到某个时间。
      //      这不是审美问题，是**读数缺了坐标系**（同族于"报 0 命中必须连口径一起报"）。
      // 改法：色块之间留缝、块本身圆角（看得出"一格一条"的粒度），并在条下压一行
      //      **起止时刻**（数据已在投影里，不新取数）。图例文案由渲染处给。
      '.dshmind-actbar{gap:2px;height:22px;align-items:stretch;margin-top:8px}',
      '.dshmind-actbar>i{width:12px;border-radius:3px;min-height:22px}',
      '.dshmind-actbarAxis{display:flex;justify-content:space-between;margin-top:5px;',
      'font-size:10.5px;color:var(--mk-tx3);font-variant-numeric:tabular-nums}',

      // ── V1 卡片内空：分区卡与统计砖下缘留白偏大 ───────────────────────────────
      // 根因：`.dshmind-sec` 的 `padding:13px 15px` 与 `.dshmind-secBody{margin-top:9px}`
      //      叠加后，正文只有一行时下缘显得空；统计砖 `padding:9px 11px` 而内容 66px /
      //      卡高 86px，多出的 20px 全落在下缘（上缘贴、下缘松 ⇒ 视觉重心偏下）。
      // 改法：把不对称的空收成**对称的小内距**，让内容与边框的距离上下一致。
      //      ⚠️ 不动 `.dshmind-secBody`（多处断言按它定位），只调卡的 padding。
      '.dshmind-sec{padding:12px 15px}',
      '.dshmind-tile{padding:10px 12px}',
      // 统计砖里的"说明行"与数值贴紧一点（数值大、说明小，原本被 line-height 撑开）
      '.dshmind-tileD{margin-top:1px}',

      // ── V3 统计区与分布卡之间的空带（2026-10-15 修：缝 2px → 14px）───────────
      // 根因：统计砖网格与构成图网格是两个独立块，叠起来在两者之间形成比"块内"明显
      //      更大的缝（视觉上像是少画了一张卡）。上一版按「容器会给 10px」给
      //      `.dshmind-tiles` 挂了 `margin-bottom:2px`，但 `.dshmind-viz` 只是一只
      //      **没有任何规则的裸 div**（它不给 gap）—— 于是那 2px ＋ 节律条的行内
      //      `marginTop:2` 成了这一组**全部的纵向缝**。实机量得（2026-10-15 截图）：
      //      砖底边 y=168 / 构成图顶边 y=171 ⇒ **缝 2px**，而同屏页内块间距 14px、
      //      组内横向格间距 10px —— 这一组因此被压得像两排糊在一起。
      // 改法：把这一段的行间距交给**页面自己的节奏值 14px**（`.dshmind-pageBox` 用的
      //      就是它），并删掉那两处写死的 2px。块间距从此只有**一个出处**（容器 gap），
      //      不再有「假设的容器 gap ＋ 补救边距」这种一改就漂的一对值。
      //      横向 `gap:10px` 不动：统计砖/构成图两排的横向缝保持一致。
      '.dshmind-viz{display:flex;flex-direction:column;gap:14px}',
      '.dshmind-tiles{gap:10px}',
      '.dshmind-vizGrid{gap:10px}',

      // ── V5 页头读数区：6 格挤成两行、高度参差 ────────────────────────────────
      // 根因：`.dshmind-readouts` 用 `auto-fit,minmax(190px,1fr)` ⇒ 1242px 宽下排 6 列、
      //      但"失联"那格带多行附注时整格变高，同行的其余格被 stretch 拉齐 ⇒ 每格内部
      //      上贴下空、看着像没对齐。
      // 改法：格子**顶部对齐**（不再互拉），高度各随内容——读数行看起来是"一排标签"，
      //      不是"一排高度不一的盒子"。
      '.dshmind-readout{align-self:start}',

      // ══ 视觉打磨 v2.3（2026-10-14 · 把设计稿里**可搬的那部分**搬齐）════════════════
      // 起因：主权者拿设计稿（`mind-panel-redesign/mockup.html`）对本机截图，问
      // 「设计稿挺好，为什么落到客户端就差这么多」。逐条比对后结论是：
      //   **能搬的没搬全，不能搬的被当成了"已经搬了"。**
      //   · **不能搬的**：设计稿自带一套 `:root` 调色板（`--bg/--card/--border-soft`）
      //     与页面背景辉光——面板有硬纪律「只用宿主令牌 `--dsw-alias-*` + 兜底」，
      //     宿主不暴露"卡片底色"这类令牌 ⇒ 那套配色本来就落不进来（这是**边界，不是漏做**）；
      //   · **能搬却没搬的**（本层补的就是这批）：字阶、分区标题的强调条、卡片微渐变、
      //     阴影强度、页头留白、页面辉光。这些**不依赖任何宿主令牌**，却一直是旧值的。
      // 参照值全部取自设计稿实测：body `14px/1.6` · h1 `19px` · `.sec-title` 带
      // `::before` 3px 主色渐变条 + `letter-spacing:.05em` · 卡片
      // `linear-gradient(180deg, var(--card), #171b24)` · 阴影 `rgba(0,0,0,.28)/.65` ·
      // `.main{padding:22px 28px 60px}`。

      // ── V7 字阶：整页基线 13px→14px、行高 20px→1.6（设计稿 body 实测值）
      '.dshmind-root{font-size:14px;line-height:1.6}',
      // ── V8 页标题 16px→19px；设计稿那手「渐变字」也一并给上（纯装饰，掉了不影响读）
      '.dshmind-title{font-size:19px;letter-spacing:.01em;',
      'background:linear-gradient(90deg,var(--mk-tx),var(--mk-tx2));-webkit-background-clip:text;',
      'background-clip:text;-webkit-text-fill-color:transparent}',
      // ── V9 分区标题：字距 + 左侧 3px 主色渐变强调条（设计稿 `.sec-title::before`）
      //     ⚠️ 用伪元素而非新增 DOM：`::before` 不产生文本节点 ⇒ `textOf()` 读到的东西不变，
      //        既有那批「分区标题写了什么」的断言一个字都不用改。
      '.dshmind-secTitle{display:flex;align-items:center;gap:8px;letter-spacing:.05em}',
      '.dshmind-secTitle::before{content:"";width:3px;height:13px;border-radius:2px;flex:none;',
      'background:linear-gradient(180deg,var(--mk-ac),transparent)}',
      // ── V10 卡片微渐变：设计稿的卡片是 `linear-gradient(180deg,var(--card),#171b24)`，
      //     面板把两端都取令牌（`--mk-bg`→`--mk-bg2`）⇒ 令牌改名只掉外观，不掉功能。
      '.dshmind-sec,.dshmind-tile,.dshmind-vizCard,.dshmind-tl,.dshmind-graphWrap,.dshmind-nav{',
      'background-image:linear-gradient(180deg,var(--mk-bg),var(--mk-bg2))}',
      // ── V11 阴影强度对齐设计稿（原来偏轻：.10/.55 → 设计稿 .28/.65）
      '.dshmind-nav,.dshmind-sec,.dshmind-tl,.dshmind-graphWrap,.dshmind-tile,.dshmind-vizCard{',
      'box-shadow:0 1px 2px rgba(0,0,0,.28),0 10px 28px -18px rgba(0,0,0,.65)}',
      // ── V12 卡片描边回到 1px（设计稿是 1px；面板早前用 .5px，在高分屏上偏虚）
      '.dshmind-sec,.dshmind-tile,.dshmind-vizCard,.dshmind-tl,.dshmind-graphWrap,.dshmind-nav{',
      'border-width:1px}',
      // ── V13 页面留白：**不动**。设计稿是 `.main{padding:22px 28px 60px}`，但面板这边
      //     `.dshmind-page` 被一条硬断言钉着——「内容层宽度只有一个出处」（同一件事两个
      //     出处 ⇒ 迟早漂移）。要改就得改**那一条原本的规则**，而它的 `padding-top:24px`
      //     又与 `.dshmind-nav` 的 `position:sticky;top:24px` **成对耦合**（改一处不改另一处，
      //     滚动时侧栏会先跟着走再"啪"地贴住）。为 2px 的观感去动这条耦合不划算 ⇒ 本批不动，
      //     留作独立决定。
      // ── V14 页面辉光：设计稿 body 上那两层 radial-gradient 是"有层次"的主要来源。
      //     取色用**字面 rgba**（同 `.dshmind-attnClear` / `.dshmind-notice` 的既有做法）：
      //     宿主没有"页面辉光"这种令牌，而它是**纯装饰**——掉了不影响任何读数。
      '.dshmind-root{background-image:',
      'radial-gradient(1100px 500px at 18% -8%,rgba(91,141,239,.07),transparent 55%),',
      'radial-gradient(900px 460px at 100% 0%,rgba(169,123,234,.05),transparent 50%)}',

      // ══ 视觉打磨 v2.4（2026-10-14 · **照设计稿抄版式**）══════════════════════════
      // 主权者原话：「主要不在那些细节上，在信息整洁度和适配上」＋「先照着他把格式抄过来」。
      // ⇒ 本层不再调色/调影，而是**把 mockup.html 的版式搬过来**。参照值逐个取自设计稿源码：
      //    `.topbar`（h1=页名 · 项目 chip · spacer · live · 刷新，**不是卡片**）·
      //    `.nav`（188px 竖栏 · bg-soft · border-right · 方形）·
      //    `.readout` 芯片（一枚子弹式小圆角，key 与值**同一行**）·
      //    `.viz-card`（构成图与节律条同属"可视化"一组，同一张卡的皮）。
      // ⚠️ 只换皮、**不换骨架**：`dshmind-readoutGroup/Label`（身份|健康 顺序）、
      //    `dshmind-readout/readoutNote`（失联详情必须贴在那格里）、`dshmind-navBtn` 的
      //    可点面白名单 —— 这些都被断言钉着，一律保持原样。

      // ── V15 页头：卡片 → 工具行（设计稿 `.topbar`）
      '.dshmind-hero{border:0;border-radius:0;background:transparent;background-image:none;',
      'box-shadow:none;overflow:visible;gap:10px}',
      '.dshmind-heroTop{align-items:center;gap:12px;padding:0;border-bottom:0;flex-wrap:wrap}',
      // 标题随设计稿：19px + 渐变字（已在 V8 给过），并**取代**原来的「产品名 + 副标题」两块
      '.dshmind-title{margin:0;flex:none}',
      '.dshmind-hero .dshmind-projChips{display:flex;gap:6px;flex-wrap:wrap;align-items:center}',
      '.dshmind-hero .dshmind-actions{margin-left:auto;gap:10px}',

      // ── V16 读数：方格 → 子弹式芯片（设计稿「● 策略引擎闸 在位 · 规则 5」的形态）
      //     key 与值**并排**（原来是上下两行，一格占出 40px 高）；失联的多行附注
      //     用 `flex-basis:100%` 落到芯片内的第二行 —— 它仍在那一格的子树里（断言要的就是这个）。
      // 📌 两组**并成一行流**（2026-10-14）：设计稿里状态就是一条横排、没有分组框。
      //    断言只钉「标签文本与先后（身份|健康）」，不钉它们各占一行 ⇒ 改成 row 流不影响它。
      //    这样页头从"三行盒子"收成"一条芯片带"，右侧也不再空一大片。
      '.dshmind-readoutGroups{flex-direction:row;flex-wrap:wrap;gap:8px 16px;align-items:center}',
      '.dshmind-readoutGroup{flex-direction:row;flex-wrap:wrap;gap:8px;align-items:center}',
      '.dshmind-readout{display:inline-flex;flex-wrap:wrap;align-items:baseline;gap:0 6px;',
      // ⚠️ `flex:0 0 auto` 必须写：旧规则给的是 `flex:1 1 180px`（"每格至少 180px 并等分"），
      //    那套是**方格**时代的排版假设。改成子弹芯片后，180px 的基宽会让同一组里的两枚
      //    芯片互相挤到换行（实测：身份组被撑成 298px 宽、两枚 267px 的芯片各自占一行）。
      //    芯片应当**按内容宽度**排，不参与等分。
      'flex:0 0 auto;border-radius:999px;padding:4px 12px}',
      '.dshmind-readoutKey{font-size:11px}',
      '.dshmind-readoutVal{margin-top:0;font-size:12.5px;font-weight:600}',
      '.dshmind-readoutNote{flex-basis:100%;margin-top:2px;gap:0 8px;font-size:10.5px}',
      // 读数区的分组标签（身份/健康）：设计稿里**没有**这两枚标签，但它们是断言钉住的结构
      // （顺序"身份|健康"必须还在）⇒ 保留文本，压成行内的一枚小标，不再当"栏目名"占宽占高。
      // （先试过竖排 `writing-mode`：它把两组各自撑高、还把芯片挤到换行 —— 不如行内小标。）
      '.dshmind-readoutGroupLabel{font-size:10px;letter-spacing:.14em;opacity:.55;flex:none}',

      // ── V17 侧栏：浮起的小圆盒 → 一根竖栏（设计稿 `.nav`：188px · bg-soft · 右侧发丝线 · 方形）
      //     ⚠️ 仍住在 `.dshmind-page` 里（页面有内边距），所以做不到设计稿那种"贴到窗口左缘"，
      //     但**形态**（竖栏 / 方形 / 描边 / 宽度 / 行距）按设计稿对齐。
      '.dshmind-nav{width:188px;padding:16px 10px;border-radius:12px;gap:2px;',
      'align-self:flex-start;position:sticky;top:24px;max-height:calc(100vh - 48px);overflow:auto}',
      '.dshmind-navBrand{padding:2px 10px 14px}',
      '.dshmind-navBrand b{font-size:15px;font-weight:600}',
      '.dshmind-navBrand span{font-size:11px;margin-top:2px}',
      '.dshmind-navBtn{padding:8px 10px;border-radius:8px;font-size:13.5px;margin-bottom:2px}',
      // 当前页：设计稿是「左侧 2.5px 强调条 + 自左向右淡出的底色」（已在 v2.1 给过内嵌条，此处对齐底色方向）
      '.dshmind-navBtnOn{background:linear-gradient(90deg,var(--mk-bg),transparent 75%)}',
      '.dshmind-navCount{font-size:11px;margin-left:auto}',

      // ── V18 审计节律条：裸块 → 一张「可视化」卡（设计稿把它与三张构成图并列成一组）
      '.dshmind-actCard{border:1px solid var(--mk-bd);border-radius:12px;padding:14px 16px;',
      'background-image:linear-gradient(180deg,var(--mk-bg),var(--mk-bg2));',
      'box-shadow:0 1px 2px rgba(0,0,0,.28),0 10px 28px -18px rgba(0,0,0,.65)}',

      // ── V19 卡内文本：**预览与记录吃满卡宽，只有"要读的大段"才限行长** ─────────
      // 依据设计稿：`.tcard .desc` 没有任何行长上限（限宽靠整列，不靠逐元素）。
      // 单列之后卡宽约 1300px ⇒ 若仍给 78ch（≈550px），右半边又会空一片
      // ——那正是上一轮"用多列去补"的诱因。这里把因果摆正：
      //   · **放开**：折叠预览（2-3 行，不存在行长失控）、判据行、答案正文、总线正文、
      //     图谱说明 —— 这些是**记录**，读者是"扫"不是"读"；
      //   · **保留 78ch**：`.dshmind-nodeTitleFull` / `.dshmind-nodeTitleOpen` ——
      //     点开「展开全文」之后才是真正要读的大段正文（也是 ⑦g 那条断言钉住的面）。
      // ⚠️ 顺序要紧：本条必须排在上方 `.dshmind-nodeTitleFull,.dshmind-nodeTitleClamped,…`
      //    那条**之后**，否则同权重下先写的赢、折叠态仍被限宽。
      '.dshmind-nodeTitleClamped,.dshmind-criteria,.dshmind-answerBody,.dshmind-busText,',
      '.dshmind-graphNote{max-width:none}',
    ].join('');

    /**
     * 设置页那套样式（`.dshmind-set__*`）—— **必须走 `document.head` 注入，不能挂在渲染子树里**。
     *
     * 为什么单独一份、单独注入（这是 Batch 6 修的真缺陷，记在这儿免得后人又改回去）：
     * 看板面板的样式可以当**面板自己的 DOM 子节点**渲染（`h('style', …)`）——面板在哪，
     * 样式就在哪，够用。但**设置页不住在看板面板的子树里**：它住在官方设置面板里（
     * `settings.section` 那一格）。挂在看板子树里的 CSS 对设置页**根本不可达** ——
     * 表现就是文案与类名都是新的、样式一条没生效（标签与控件竖着堆、控件是浏览器默认长相）。
     * 所以设置页这套要走**文档级**：`document.head` 追加 `<style>`，全局可见。
     *
     * 参考实现：另一插件的参考实现（同一个宿主、同一个槽位，
     * 已在官方客户端跑通）——它也是 `document.createElement('style')` + `document.head.appendChild`，
     * 并按 `style[data-plugin='<id>']` 判重，所以热重载不会叠出第二份。
     */
    var SETTINGS_CSS = [
      '.dshmind-set__{box-sizing:border-box;width:100%;min-width:0;max-width:880px;padding:4px 0 20px;color:var(--dsw-alias-label-primary,#1a2233);font:13px/1.6 var(--ds-font-family-sans,system-ui,sans-serif)}',
      '.dshmind-set__ *{box-sizing:border-box}.dshmind-set__header{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:24px}.dshmind-set__header>div{min-width:0;flex:1}.dshmind-set__header>button{flex:0 0 auto}',
      '.dshmind-set__title{margin:0 0 4px;font-size:18px;line-height:26px;font-weight:600}.dshmind-set__lede{margin:0;color:var(--dsw-alias-label-secondary,#61666b);font-size:13px}',
      '.dshmind-set__section{margin:0 0 18px;padding:20px;border:1px solid var(--dsw-alias-border-l2,#d3dcea);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff)}',
      '.dshmind-set__subtitle{font-size:15px;line-height:24px;font-weight:600;margin:0 0 6px}.dshmind-set__groupTitle{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:22px 0 0;font-size:13px;font-weight:600}',
      '.dshmind-set__rows{display:flex;flex-direction:column}.dshmind-set__row{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:15px 0;border-bottom:1px solid var(--dsw-alias-border-l2,#d3dcea)}',
      '.dshmind-set__texts{flex:1 1 auto;min-width:0}.dshmind-set__label{display:block;margin-bottom:3px;font-size:14px;font-weight:500;color:var(--dsw-alias-label-primary,#1a2233)}',
      '.dshmind-set__hint{font-size:12px;line-height:1.65;color:var(--dsw-alias-label-secondary,#61666b);overflow-wrap:anywhere}',
      '.dshmind-set__control{display:flex;align-items:center;gap:8px;flex:0 0 auto;min-width:0;max-width:100%}.dshmind-set__value{display:flex;align-items:center;gap:7px;min-width:0;flex-wrap:wrap;overflow-wrap:anywhere}',
      '.dshmind-set__select,.dshmind-set__number{height:34px;max-width:100%;padding:0 10px;font:inherit;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#d3dcea);background:var(--dsw-alias-bg-layer-2,#fff);color:inherit}',
      '.dshmind-set__select{min-width:160px}.dshmind-set__number{width:96px}.dshmind-set__select:focus-visible,.dshmind-set__number:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:2px}',
      '.dshmind-set__select:disabled,.dshmind-set__number:disabled{opacity:.55;cursor:default}',
      '.dshmind-set__row--field{display:block}.dshmind-set__row--field .dshmind-set__control{width:100%;margin-top:9px}.dshmind-set__text{width:100%;max-width:none}',
      '.dshmind-set__persona{display:block;width:100%;box-sizing:border-box;min-height:240px;resize:vertical;padding:12px;border:1px solid var(--dsw-alias-border-l2,#d3dcea);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#1a2233);font:inherit;line-height:1.65}.dshmind-set__persona:focus{outline:2px solid var(--dsw-alias-brand-primary,#4c78ff);outline-offset:1px}.dshmind-set__persona:disabled{opacity:.65}',
      '.dshmind-set__actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding-top:16px}.dshmind-set__editState{font-size:12px;color:var(--dsw-alias-label-secondary,#61666b);margin-right:auto}',
      '.dshmind-set__btn{min-height:32px;padding:5px 13px;font:inherit;font-size:12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#d3dcea);background:var(--dsw-alias-bg-layer-2,#fff);color:inherit;cursor:pointer}',
      '.dshmind-set__btn:hover{background:var(--dsw-alias-interactive-bg-hover,#eff1f5)}.dshmind-set__btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:2px}.dshmind-set__btn:disabled{opacity:.45;cursor:default}',
      '.dshmind-set__btn--primary{background:var(--dsw-alias-brand-primary,#4d6bfe);border-color:transparent;color:var(--dsw-alias-label-primary-inverted,#fff);font-weight:500}.dshmind-set__btn--primary:hover{background:var(--dsw-alias-brand-primary-hover,#3f5be8)}',
      '.dshmind-set__notice,.dshmind-set__bad,.dshmind-set__toast{margin:12px 0;padding:10px 12px;border-radius:6px;font-size:12px;line-height:1.7;overflow-wrap:anywhere}',
      '.dshmind-set__notice{border:1px solid var(--dsw-alias-border-l2,#d3dcea);background:var(--dsw-alias-bg-layer-2,#f7f8fa)}.dshmind-set__noticeText{color:var(--dsw-alias-label-secondary,#61666b)}',
      '.dshmind-set__noticeCmd{display:block;margin-top:6px;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;overflow-wrap:anywhere;user-select:text}',
      '.dshmind-set__bad,.dshmind-set__toast--warn{border:1px solid var(--dsw-alias-state-error-primary,#d54941);color:var(--dsw-alias-state-error-primary,#d54941);background:var(--dsw-alias-state-error-tertiary,#fdecea)}',
      '.dshmind-set__toast--ok{border:1px solid var(--dsw-alias-state-success-primary,#2f9e44);color:var(--dsw-alias-state-success-primary,#2f9e44);background:var(--dsw-alias-state-success-tertiary,#eaf7ec)}',
      '.dshmind-set__details{margin-top:16px;color:var(--dsw-alias-label-secondary,#61666b);font-size:12px}.dshmind-set__details>summary{cursor:pointer;padding:4px 0;max-width:100%}.dshmind-set__details[open]>summary{margin-bottom:8px}.dshmind-set__details p{margin:7px 0}',
      '.dshmind-set__details .dshmind-set__row{align-items:flex-start;padding:9px 0}.dshmind-set__details .dshmind-set__control{flex:1 1 55%;overflow-wrap:anywhere}.dshmind-set__details .dshmind-set__label{font-size:12px}',
      '.dshmind-set__status{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:400;color:var(--dsw-alias-label-secondary,#61666b)}.dshmind-set__dot{display:inline-block;width:7px;height:7px;border-radius:50%;flex:0 0 auto}',
      '.dshmind-set__foot{display:flex;align-items:center;gap:12px;justify-content:space-between;padding-top:16px;border-top:1px solid var(--dsw-alias-border-l2,#d3dcea)}.dshmind-set__foot p{margin:0}.dshmind-set__mono{font-family:var(--ds-font-family-code,ui-monospace,monospace);overflow-wrap:anywhere}',
      '@media(max-width:560px){.dshmind-set__section{padding:16px}.dshmind-set__row{align-items:flex-start;flex-direction:column;gap:10px}.dshmind-set__row .dshmind-set__control{width:100%}.dshmind-set__select{width:100%}.dshmind-set__header{gap:12px}.dshmind-set__actions{gap:8px}.dshmind-set__editState{flex-basis:100%}.dshmind-set__details .dshmind-set__control{flex:auto}.dshmind-set__groupTitle{align-items:flex-start;flex-wrap:wrap}}',
    ].join('');

    /** 注入设置页样式的 `<style>` 标记（判重用），与宿主里 `installStyle` 的做法同源。 */
    var SETTINGS_STYLE_ID = 'dsh-mind-settings-style';

    /**
     * 把**设置页**那套样式注入到**文档级**（`document.head`）。
     *
     * 四条纪律，缺一条都会在真机上坏掉：
     *  1. **一次、幂等**：靠 `window.__dshMindSettingsStyle` 记住"这份样式归谁管" ⇒
     *     重复 `apply` / 热重载不会叠出第二份（叠了不会立刻出错，但会越来越难收拾）；
     *  2. **随卸载移除**：返回 disposer（`apply` 把它并进那份合并 disposer 里），
     *     组件被撤下时样式也一起走，不留野样式；
     *  3. **非浏览器环境有守卫**：这个文件是**经典脚本**，可能在没有 `document` 的环境里被求值，
     *     拿不到 `document` / `document.head` 就**静默返回 null**（样式没了只是难看，绝不能抛）；
     *  4. **失败只掉外观**：任何一步抛错都吞掉并 `warn` 一句 —— 设置页仍然可用，只是没套主题。
     *
     * 为什么用 window 上的标记而不是 `document.querySelector` 判重：两者都能防重复注入，
     * 但**只有标记能回答"这份样式是不是我插的"**——不是自己插的那种，卸载时就不该去摘它
     * （摘掉别的实例/别的插件的样式是越界）。另一插件的参考实现用 querySelector
     * 判重，那里只有一个实例、不涉及移除，所以那样够用；这里要管卸载，就多留一个归属标记。
     *
     * @returns {Function|null} 移除注入的 disposer；注入不了（无 document / 已有主 / 抛错）时返回 null
     */
    function 注入设置页样式() {
      try {
        if (typeof document === 'undefined' || !document) return null;
        var head = document.head;
        if (!head || typeof head.appendChild !== 'function') return null;
        // 幂等 + 归属：已有主人就不再插第二份，也不再接管移除（谁注的谁撤）。
        var 宿主 = typeof window !== 'undefined' && window ? window : null;
        if (宿主 && 宿主.__dshMindSettingsStyle) return null;
        var tag = document.createElement('style');
        tag.setAttribute('data-mind', SETTINGS_STYLE_ID);
        tag.textContent = SETTINGS_CSS;
        head.appendChild(tag);
        var 撤下 = function 撤下设置页样式() {
          try {
            if (宿主) 宿主.__dshMindSettingsStyle = null;
            if (tag && tag.parentNode && typeof tag.parentNode.removeChild === 'function') {
              tag.parentNode.removeChild(tag);
            }
          } catch (error) { /* 已经没了就算了：撤样式失败不该影响任何东西 */ }
        };
        if (宿主) 宿主.__dshMindSettingsStyle = 撤下;
        return 撤下;
      } catch (error) {
        // 注入失败只掉外观，不掉功能：说一声，然后继续（设置页仍可用，只是没套主题）。
        try { console.warn('dsh-mind: 设置页样式注入失败（只影响外观）', error); } catch (ignored) { /* 控制台都没了就算了 */ }
        return null;
      }
    }

    // ── 计时器：**裸全局**，拿不到就响亮地报（Batch 7 修）────────────────────
    /**
     * 取一个计时器函数：**裸全局名优先**，`globalThis.*` 兜底。
     *
     * 为什么不是 `window.setTimeout`：真机上那个**不一定是函数**（`window` 存在 ≠ 它上面有计时器；
     * 宿主也可能把 `window.*` 换掉/隔离掉）。同机跑通的第三方插件用的就是**裸 `setTimeout` /
     * `setInterval`**（`dsh-status-rotator/lib/client.js` 多处），所以照它来。
     *
     * ⚠️ **拿不到必须响亮**（这是 Batch 6 的教训）：旧代码在拿不到计时器时**静默地不设超时**，
     * 于是真机上"8 秒超时也没救出来"——因为那个超时**压根没设上**，而控制台一片安静。
     * 现在：取不到就记进 `缺失的计时器`，`console.error` 一句，页面也会照实说
     * 「本客户端拿不到计时器 ⇒ 不设上限等待」，而**绝不假装超时在生效**。
     *
     * @param {'setTimeout'|'setInterval'|'clearTimeout'|'clearInterval'} name
     * @returns {Function|null}
     */
    var 缺失的计时器 = [];
    function 取计时器(name) {
      var fromGlobal = null;
      try {
        // 裸名：经典脚本里就是全局函数的直接引用。
        if (typeof globalThis !== 'undefined' && globalThis && typeof globalThis[name] === 'function') {
          fromGlobal = globalThis[name];
        }
      } catch (error) { /* 继续试 window */ }
      if (!fromGlobal) {
        try {
          if (typeof window !== 'undefined' && window && typeof window[name] === 'function') fromGlobal = window[name];
        } catch (error) { /* 没有就没有 */ }
      }
      if (fromGlobal) return fromGlobal;
      if (缺失的计时器.indexOf(name) < 0) {
        缺失的计时器.push(name);
        try {
          console.error('dsh-mind: 本客户端拿不到计时器 ' + name
            + '。后果：请求**没有上限等待**（页面可能一直停在"读取中"）。'
            + '这是运行环境问题，不是设置问题。');
        } catch (error) { /* 控制台都没了就算了 */ }
      }
      return null;
    }

    /**
     * 给一个 promise 加**上限等待**：到点没 settle 就当作失败（永不 settle 的 promise 是这里的天敌）。
     *
     * 为什么不能只靠 `.catch`：请求卡住时**既不会 resolve 也不会 reject**，
     * `.catch` 一辈子等不到 —— 页面就一直停在 loading。**超时是唯一能离开那种状态的东西。**
     *
     * @template T
     * @param {Promise<T>|T} promise
     * @param {number} ms 上限等待
     * @param {string} 说明 超时时要带出去的可诊断信息（路由 / 等了多久）
     * @returns {Promise<T>} 超时以 reject 的方式失败（错误信息就是那句可诊断信息）
     */
    function 限时(promise, ms, 说明) {
      return new Promise(function (resolve, reject) {
        var 到了 = false;
        var 计时器 = null;
        var 设时 = 取计时器('setTimeout');
        var 清时 = 取计时器('clearTimeout');
        if (设时) {
          try {
            计时器 = 设时(function () {
              if (到了) return;
              到了 = true;
              reject(new Error('超时：' + 说明));
            }, ms);
          } catch (error) { 计时器 = null; }
        }
        Promise.resolve(promise).then(function (value) {
          if (到了) return;
          到了 = true;
          try { if (计时器 !== null && 清时) 清时(计时器); } catch (error) { /* 无所谓 */ }
          resolve(value);
        }, function (error) {
          if (到了) return;
          到了 = true;
          try { if (计时器 !== null && 清时) 清时(计时器); } catch (ignored) { /* 无所谓 */ }
          reject(error);
        });
      });
    }

    function dot(color) {
      return h('span', { className: 'dshmind-dot', style: { background: color } });
    }
    var GREEN = 'var(--dsw-alias-state-success-primary,#2f9e44)';
    var RED = 'var(--dsw-alias-state-error-primary,#d54941)';
    var GREY = 'var(--dsw-alias-label-caption,#adb2b8)';
    var BRAND = 'var(--dsw-alias-state-business-primary,#0f1115)';
    var WARN = 'var(--dsw-alias-state-warn-primary,#c47f17)';

    /**
     * 任务状态 → 徽章色（优化批②·2026-10-12）。只复用上面的色常量，不新造色值。
     * 口径对齐 `src/workbench.js` 的 `进行中 = new Set(['已派发','执行中'])`，
     * 状态全集出自 `src/tasks.js` 状态机（待派发/已派发/执行中/已交卷/未验/已采纳/已打回/待决/已结账）。
     * **查表之外一律保灰**（待派发/已结账/未验/未知/缺失/白名单外）：
     * 「未验」未验收、「未知」缺数据——都不许画成好态（失联四态同款教训）。
     */
    var 状态徽章色 = {
      已派发: BRAND, 执行中: BRAND, // 进行
      已交卷: GREEN, 已采纳: GREEN, // 完成 / 过关
      已打回: WARN, 待决: WARN, // 要返工 / 被卡
    };

    function badge(text, tone) {
      var color = tone === 'red' ? RED : tone === 'green' ? GREEN : tone === 'warn' ? WARN : BRAND;
      return h('span', {
        className: 'dshmind-badge',
        style: {
          color: color,
          borderColor: color,
          background: 'var(--dsw-alias-bg-layer-1,#fff)',
        },
      }, text);
    }
    function section(index, title, hint, count, body) {
      return h('section', { className: 'dshmind-sec' }, [
        h('div', { className: 'dshmind-secHead' }, [
          h('span', { className: 'dshmind-secIdx' }, String(index)),
          h('h3', { className: 'dshmind-secTitle' }, title),
          // UI 卫生批：hint 是 nowrap+ellipsis 的，窄面板会省略——挂 title 全文，截断不丢信息。
          hint ? h('span', { className: 'dshmind-secHint', title: hint }, hint) : null,
          count ? h('span', { className: 'dshmind-secCount dshmind-mono' }, count) : null,
        ]),
        h('div', { className: 'dshmind-secBody' }, body),
      ]);
    }

    // ── 分页外壳与可视化（2026-10-13 重做）────────────────────────────────────
    /**
     * 七页：id / 标签 / 计数（计数为 `null` 就不画徽章——「没数据就别占位置」）。
     * **顺序＝注意力顺序**：总览（要我做什么）→ 图谱（组织长什么样）→ 任务/会审/总线/审计（明细）→ 记忆。
     */
    function 页清单(ctx) {
      return [
        { id: 'overview', 名: '总览' },
        { id: 'graph', 名: '图谱' },
        { id: 'tasks', 名: '任务', 计数: ctx.tasks ? ctx.tasks.length : null },
        { id: 'reviews', 名: '会审', 计数: ctx.会审 ? ctx.会审.length : null },
        { id: 'bus', 名: '总线', 计数: ctx.总线 ? ctx.总线.length : null },
        { id: 'audit', 名: '审计' },
        { id: 'monitor', 名: '阻塞反馈' },
        { id: 'memory', 名: '记忆', 计数: ctx.记忆 ? ctx.记忆.存量 : null },
      ];
    }

    function 导航(ctx) {
      var 现在 = 当前页();
      return h('nav', { className: 'dshmind-nav', 'data-dshmind': 'nav' }, [
        h('div', { key: 'brand', className: 'dshmind-navBrand' }, [
          h('b', { key: 'b' }, '心智 · 数字组织'),
          h('span', { key: 's' }, '唯一投影视图（只读）'),
        ]),
      ].concat(页清单(ctx).map(function (p) {
        return h('button', {
          key: p.id,
          type: 'button',
          className: 'dshmind-navBtn' + (p.id === 现在 ? ' dshmind-navBtnOn' : ''),
          'data-page': p.id,
          'aria-current': p.id === 现在 ? 'page' : null,
          onClick: function () { 切页(p.id); },
        }, [
          h('span', { key: 'n' }, p.名),
          p.计数 === null || p.计数 === undefined
            ? null
            : h('span', { key: 'c', className: 'dshmind-navCount dshmind-mono' }, String(p.计数)),
        ]);
      })));
    }

    /**
     * 注意力区（2026-10-13 重做·设计稿的首屏第一块）：**3 秒内回答「现在要我做什么」**。
     *
     * 三个来源，全部由**已到手的投影**现算（不新取数、不发请求）：
     *  ① 待你决定清单——空就给一条平静绿带，而不是留一块空白（空白让人以为面板坏了）；
     *  ② 安全类探针异常——`恒绿` 也算异常：「从来没红过」可能意味着探针失灵；
     *  ③ **挂有待决说明、但状态不是「待决」的节点**：现行收集口径（`收集待你决定`）只收
     *     「状态＝待决」的节点，这类节点（负责人消亡后待裁决处置的存档节点等）**会漏出待决清单**——
     *     而它们恰恰是「需要人拍板」的那一类。这一条是设计稿里唯一新增的**判据性内容**，
     *     不是装饰：漏掉的正是最需要被看见的。
     */
    function 状态区(ctx) {
      var 待你决定 = ctx.待你决定 || [];
      var 探针 = ctx.view && obj(ctx.view.状态条) ? obj(ctx.view.状态条.探针) : null;
      var 挂待决 = (ctx.tasks || []).filter(function (n) { return n.只读历史 !== true && n.已终止 !== true && n.状态 !== '已终止' && n.待决原因 && n.状态 !== '待决'; });
      var 卡 = [];
      if (!待你决定.length) {
        卡.push(h('div', { key: 'clear', className: 'dshmind-attnClear' }, [
          h('span', { key: 'i' }, '✓'),
          h('span', { key: 't' }, '现在没有需要你拍板的事'),
        ]));
      } else {
        // 数据键字典用 null 原型（2026-10-14 审查 P2-24）：类型字符串来自服务端数据，
        // `__proto__` 当键会把计数写到原型 setter 上被静默吞掉——与自家 `安全合并` 同口径。
        var 计数 = Object.create(null);
        待你决定.forEach(function (x) { 计数[x.类型] = (计数[x.类型] || 0) + 1; });
        卡.push(h('div', { key: 'decide', className: 'dshmind-attnCard dshmind-attnCardBad' }, [
          h('h4', { key: 'h' }, [h('span', { key: 'i' }, '⚑'), h('span', { key: 't' }, 待你决定.length + ' 件事等你拍板')]),
          h('p', { key: 'p' }, Object.keys(计数).map(function (k) { return k + ' ' + 计数[k]; }).join('　·　')
            + '　——　明细与可敲的命令见下方「待你决定」'),
        ]));
      }
      if (探针 && (arr(探针.见红).length > 0 || 探针.恒红 === true || 探针.恒绿 === true)) {
        var 见红 = arr(探针.见红).filter(Boolean);
        var 说明 = 见红.length ? '见红：' + 见红.join('、')
          : 探针.恒红 === true ? '四道封闭探针全部恒红：哨兵可能已经卡死，别当成「刚好都出事」。'
            : '四道封闭探针全部恒绿 ——「从来没红过」本身是异常信号：可能探针失灵，而不是一切正常。';
        卡.push(h('div', {
          key: 'probe',
          className: 'dshmind-attnCard' + (见红.length ? ' dshmind-attnCardBad' : ''),
        }, [
          h('h4', { key: 'h' }, [h('span', { key: 'i' }, '⚠'), h('span', { key: 't' }, '安全类探针')]),
          h('p', { key: 'p' }, 说明),
          h('div', { key: 'c', className: 'dshmind-gLink' }, [
            h('span', { key: 'x', className: 'dshmind-mono' }, '/mind-guard probe'),
          ]),
        ]));
      }
      if (挂待决.length) {
        // ── 折与不折（2026-10-14 收口）────────────────────────────────────────
        // 根因：这一块把**每条待决说明全文**铺在注意力区（首屏"3 秒内回答要我做什么"），
        //      实测 **337px**（HEAD 版，3 条待决）——占掉大半屏，正撞它自己的设计目的。
        // 改法：走本面板**已有的**「默认折叠 + 展开全文」口径（⑩d / 主人口径「要全文 + 默认折叠」），
        //      而不是截断——**折叠是 CSS 视觉态，DOM 里仍是全文**（原文照给这条不破；
        //      harness ⑪f 那条「原因全文照给」照样绿，正是因为它量的是文本、不是显示高度）。
        //      折叠态住 `界面store.折叠描述`（与任务卡/会审卡同一张覆盖表、同一个折叠钮类名），
        //      **不挂 useEffect**（设计债⑩）。
        // ⚠️ 「折叠」要叠**两处**才够：光叠条目，那条 4 行的流程注解仍在占位（实测只降到 310px，
        //    仅 8%）。说明句与条目一起吃同一张折叠表，才真正把首屏还给数据。
        var 折叠键 = 'attn:挂待决';
        var 折 = 描述折叠(折叠键);
        var 全文字数 = 挂待决.reduce(function (a, n) {
          return a + String(n.id + '　' + n.待决原因).length;
        }, 0);
        卡.push(h('div', { key: 'orphan', className: 'dshmind-attnCard' }, [
          h('h4', { key: 'h' }, [
            h('span', { key: 'i' }, '⚠'),
            h('span', { key: 't' }, 挂待决.length + ' 个节点挂有待决说明，但不在待决清单里'),
          ]),
          // 说明句也吃折叠：它是**流程口径的注解**，在注意力区占 3-4 行纯属挤占。
          // 全文逐字仍在 DOM 里，点开即见（同一条纪律：折叠不改文本）。
          h('p', {
            key: 'p',
            className: 折 ? 'dshmind-attnIntroClamped' : null,
          }, '现行收集口径只收「状态＝待决」的节点，这类会漏出去。它们等你裁决处置'
            + '（作废 / 保留存档）。**原文照给，不截断**——裁决要看的就是那句话。'),
          // 条目列表：折叠态**整块收起**（不是逐条钳行——那样会切半句，看着像坏了）。
          // 文本仍在树里，点开就是全文。
          h('div', {
            key: 'n',
            className: 'dshmind-attnNodes' + (折 ? ' dshmind-attnNodesOff' : ''),
          }, 挂待决.map(function (n, i) {
            return h('span', {
              key: 'x' + i,
              className: 'dshmind-attnNode',
              title: n.待决原因,
            }, n.id + '　' + n.待决原因);
          })),
          // 折叠钮：复用 `dshmind-descToggle` 类名（harness 的「可点面白名单」逐一枚举它，
          // 新造一类会算破规）。纯显示切换、**零请求**。
          h('button', {
            key: 'tg', type: 'button', className: 'dshmind-descToggle',
            onClick: function () { 切描述折叠(折叠键); },
          }, 折 ? '▸ 展开全部（' + 挂待决.length + ' 条 · 共 ' + 全文字数 + ' 字）' : '▾ 收起'),
        ]));
      }
      return h('div', { key: 'attn', className: 'dshmind-attn' }, 卡);
    }

    /**
     * 分页外壳：把扁平的 children 拆成「导航 ＋ 七个页容器 ＋ 页脚」。
     *
     * 拆法按**节点自身的标识**（`type` / `key` / `className`），**不按位置**：位置会随
     * 上面增删一行而漂，而 key 是渲染层自己写死的契约。
     *
     * 非当前页**只收显示、不收节点**（`display:none` + 类名）：渲染树是断言的读面，
     * 「会审/任务图/审计流」那一批断言守的是内容口径（不静默截断、盲评遮罩、档位分级），
     * 与它在第几页无关 —— 只渲染当前页会让那批断言在默认页面上全部落空。
     */
    function 分页外壳(children, ctx) {
      var 样式 = [], 公告 = [], 段 = [], 头 = null, 页脚 = null;
      (children || []).forEach(function (n) {
        if (!n || typeof n !== 'object') return;
        var props = n.props || {};
        if (n.type === 'style') { 样式.push(n); return; }
        if (props.className === 'dshmind-notice') { 公告.push(n); return; }
        if (props.key === 'hero') { 头 = n; return; }
        if (n.type === 'section') { 段.push(n); return; }
        if (props.key === 'foot') { 页脚 = n; return; }
      });
      var 现在 = 当前页();
      var 页体 = {
        // ① 总览＝注意力顺序：状态头 → **注意力区（要我做什么）** → 数字 → 「待你决定」明细 → 最近动态
        overview: [头, 状态区(ctx), 目标概览({ goals: ctx.view && ctx.view.目标 }), 知识复用概览(ctx.view && ctx.view.知识复用), 创建操作概览(ctx.view && ctx.view.创建操作), 模型用量概览(ctx.view && ctx.view.模型用量), 可视化块(ctx), 段[0] || null, 动态时间线(ctx)],
        graph: 图谱页(ctx),
        tasks: [段[2] || null],
        reviews: [段[1] || null],
        bus: [段[4] || null],
        audit: [段[3] || null],
        monitor: [h(监控反馈页, { monitor: ctx.view && ctx.view.监控 })],
        memory: 记忆页(ctx),
      };
      var 页节点 = 页清单(ctx).map(function (p) {
        var 在 = p.id === 现在;
        return h('div', {
          key: 'page-' + p.id,
          className: 'dshmind-pageBox' + (在 ? '' : ' dshmind-pageBoxOff'),
          'data-dshmind-page': p.id,
          style: 在 ? null : { display: 'none' },
        }, 页体[p.id] || []);
      });
      return 样式.concat(公告, [
        h('div', { key: 'shell', className: 'dshmind-shell' }, [
          导航(ctx),
          h('div', { key: 'pages', className: 'dshmind-pages' }, 页节点),
        ]),
      ], 页脚 ? [页脚] : []);
    }

    /**
     * 甜甜圈：**不引任何图库**（本插件零依赖且不能编译），用 SVG 圆的 `stroke-dasharray` 画弧。
     * 值为 0 的段跳过（0 度弧会画出一条看起来像数据的假线）。中心数字＝**该块自己的合计**。
     */
    function 甜甜圈(segs, size, thick) {
      var 总 = 0, i;
      for (i = 0; i < segs.length; i += 1) 总 += 段值(segs[i]);
      var r = (size - thick) / 2;
      var C = 2 * Math.PI * r;
      var 偏移 = 0;
      var 弧 = [];
      for (i = 0; i < segs.length; i += 1) {
        var 值 = 段值(segs[i]);
        if (值 <= 0 || 总 <= 0) continue;
        var 长 = 值 / 总 * C;
        弧.push(h('circle', {
          key: 'arc' + i, cx: size / 2, cy: size / 2, r: r, fill: 'none',
          stroke: segs[i].色, strokeWidth: thick,
          strokeDasharray: 长.toFixed(2) + ' ' + (C - 长).toFixed(2),
          strokeDashoffset: (-偏移).toFixed(2),
          transform: 'rotate(-90 ' + (size / 2) + ' ' + (size / 2) + ')',
        }));
        偏移 += 长;
      }
      return h('svg', { className: 'dshmind-donut', width: size, height: size, viewBox: '0 0 ' + size + ' ' + size }, [
        h('circle', {
          key: 'bg', cx: size / 2, cy: size / 2, r: r, fill: 'none',
          stroke: 'var(--dsw-alias-border-l2,#d3dcea)', strokeWidth: thick, opacity: 0.35,
        }),
      ].concat(弧, [
        h('text', {
          key: 'v', x: size / 2, y: size / 2 + 5, textAnchor: 'middle', fontSize: 17, fontWeight: 600,
          fill: 'var(--dsw-alias-label-primary,#1a2233)',
        }, String(总)),
      ]));
    }
    /** 段的数值：非有限数按 0 算（投影脏值不许把图算崩）。 */
    function 段值(s) { return s && typeof s.值 === 'number' && isFinite(s.值) ? s.值 : 0; }

    function 图例(segs) {
      var 总 = 0, i;
      for (i = 0; i < segs.length; i += 1) 总 += 段值(segs[i]);
      return h('div', { className: 'dshmind-legend' }, segs.map(function (s, i) {
        return h('span', { key: 'l' + i, className: 'dshmind-legendRow' }, [
          h('i', { key: 's', className: 'dshmind-swatch', style: { background: s.色 } }),
          h('span', { key: 'n' }, s.名),
          h('b', { key: 'v', className: 'dshmind-mono' }, String(段值(s))),
          h('span', { key: 'p', className: 'dshmind-mono' }, 总 > 0 ? Math.round(段值(s) / 总 * 100) + '%' : '—'),
        ]);
      }));
    }

    /** 一张可视化卡：左图右例。**图与例用同一份 segs**（口径单源，不许两处各数一遍）。 */
    function 可视化卡(标题, 副题, segs) {
      return h('div', { className: 'dshmind-vizCard' }, [
        h('div', { key: 'l', style: { flex: 'none' } }, 甜甜圈(segs, 96, 12)),
        h('div', { key: 'r', style: { minWidth: 0, flex: 1 } }, [
          h('div', { className: 'dshmind-vizTitle' }, 标题 + (副题 ? '　' + 副题 : '')),
          图例(segs),
        ]),
      ]);
    }

    /**
     * 总览的可视化块：统计砖 ＋ 三个构成图 ＋ 审计节律条。
     *
     * **没数据的块整块不画**（Batch 9 纪律）：能力/岗位没投影过来时，那块砖与那张图都不出现，
     * 而不是画一张空图让读的人以为「组织里一张卡都没有」。
     */
    function 可视化块(ctx) {
      var 任务袋 = ctx.view ? obj(ctx.view.任务) : null;
      var 计数 = 任务袋 ? obj(任务袋.计数) : null;
      var 接线 = 接线读数(ctx.能力, ctx.岗位);
      var 记忆 = ctx.记忆;
      var 任务总 = 任务袋 && typeof 任务袋.总数 === 'number' ? 任务袋.总数 : null;
      var 砖 = [
        ctx.审计总条数 ? { k: '审计条目（只增）', v: ctx.审计总条数, d: '近 ' + (ctx.audit ? ctx.audit.length : 0) + ' 条在「审计」页' } : null,
        记忆 ? { k: '记忆存量', v: 记忆.存量, d: 记忆.新增 === null ? '' : '近 ' + (记忆.窗口天 || 7) + ' 天 +' + 记忆.新增 } : null,
        任务总 === null ? null : { k: '任务节点', v: 任务总, d: 计数 ? '进行中 ' + (计数.进行中 || 0) + ' · 已交卷 ' + (计数.已交卷 || 0) : '' },
        接线 ? { k: '能力卡', v: ctx.能力.length, d: '岗位接线 ' + 接线.接线.length + '/' + 接线.适用边 + '（' + 接线.接线率 + '%）' + (接线.缺口.length ? ' ⚠ 有缺口' : ' ✓') } : null,
      ].filter(Boolean);
      var 卡 = [];
      if (计数) {
        卡.push(可视化卡('任务状态', '共 ' + (任务总 === null ? '—' : 任务总) + ' 节点', [
          { 名: '进行中', 值: 计数.进行中 || 0, 色: '#5b8def' },
          { 名: '已交卷', 值: 计数.已交卷 || 0, 色: '#d4a053' },
          { 名: '已结账', 值: 计数.已结账 || 0, 色: '#3fb27f' },
          { 名: '已终止', 值: 计数.已终止 || 0, 色: '#81858c' },
          { 名: '待决', 值: 计数.待决 || 0, 色: '#e5534b' },
        ]));
      }
      if (记忆 && 记忆.按类) {
        卡.push(可视化卡('记忆构成', 记忆.存量 === null ? '' : '共 ' + 记忆.存量 + ' 条', [
          { 名: '经历', 值: 记忆.按类.经历, 色: '#4bb8c8' },
          { 名: '知识', 值: 记忆.按类.知识, 色: '#a97bea' },
          { 名: '偏好', 值: 记忆.按类.偏好, 色: '#d4a053' },
        ]));
      }
      if (ctx.会审 && ctx.会审.length) {
        // v2（条目18）：会审是独立咨询，不再有「复核三态」。分布改按会审自己的状态机报——
        // 作答中（等答案）/ 已解锁 / 讨论中 / 已收敛（存档）。
        var 作答中 = 0, 解锁 = 0, 讨论中 = 0, 收敛 = 0, 其他 = 0;
        ctx.会审.forEach(function (r) {
          if (r.状态 === '作答中') 作答中 += 1;
          else if (r.状态 === '已解锁') 解锁 += 1;
          else if (r.状态 === '讨论中') 讨论中 += 1;
          else if (r.状态 === '已收敛') 收敛 += 1;
          else 其他 += 1;
        });
        卡.push(可视化卡('会审状态分布', '共 ' + ctx.会审.length + ' 场', [
          { 名: '作答中', 值: 作答中, 色: '#d4a053' },
          { 名: '已解锁', 值: 解锁, 色: '#5b8def' },
          { 名: '讨论中', 值: 讨论中, 色: '#4bb8c8' },
          { 名: '已收敛', 值: 收敛, 色: '#3fb27f' },
          { 名: '未知', 值: 其他, 色: '#adb2b8' },
        ]));
      }
      if (!砖.length && !卡.length) return null;
      return h('div', { key: 'viz', className: 'dshmind-viz' }, [
        砖.length ? h('div', { key: 'tiles', className: 'dshmind-tiles' }, 砖.map(function (t, i) {
          return h('div', { key: 't' + i, className: 'dshmind-tile' }, [
            h('div', { key: 'k', className: 'dshmind-tileK' }, t.k),
            h('div', { key: 'v', className: 'dshmind-tileV dshmind-mono' }, t.v === null || t.v === undefined ? '—' : String(t.v)),
            t.d ? h('div', { key: 'd', className: 'dshmind-tileD' }, t.d) : null,
          ]);
        })) : null,
        卡.length ? h('div', { key: 'cards', className: 'dshmind-vizGrid' }, 卡) : null,
        审计节律条(ctx),
      ].filter(Boolean));
    }

    /**
     * 审计节律条：把**已经到手的那几条审计**画成一格一条。
     *
     * ⚠️ 它的读数是「投影给了多少条」，**不是**账本总数（总数在标题里另说）：
     * 一条一格，颜色按 动作/结果 分级（失败红、拦截黄、其余蓝）。这是**唯一一处界面自己数**，
     * 所以在下面把口径写出来，免得读的人把节律条当全量分布。
     */
    function 审计节律条(ctx) {
      var 行 = ctx.audit || [];
      if (!行.length) return null;
      var 计数 = { 状态变更: 0, 失败: 0, 拦截: 0, 其他: 0 };
      var 格 = 行.map(function (r, i) {
        var 失败 = r.结果 === '失败';
        var 拦截 = r.动作 === '动作拦截' || r.结果 === '拒绝';
        var 色 = 失败 ? '#e5534b' : 拦截 ? '#d4a053' : '#5b8def';
        if (失败) 计数.失败 += 1; else if (拦截) 计数.拦截 += 1; else if (r.动作 === '状态变更') 计数.状态变更 += 1; else 计数.其他 += 1;
        return h('i', {
          key: 'b' + i, style: { background: 色 },
          title: shortTime(r.时间) + ' · ' + (r.动作 || '') + ' · ' + (源主体短(r.主体)) + ' · ' + (r.结果 || ''),
        });
      });
      // 与上方统计砖、构成图之间的缝**交给 `.dshmind-viz` 的容器 gap（14px）**：
      // 这里不再自带 `marginTop` —— 一半写在容器、一半写在自己身上，迟早对不上。
      return h('div', { key: 'act', className: 'dshmind-actCard' }, [
        h('div', { key: 'h', className: 'dshmind-tileK' }, '审计节律（一格一条，共 ' + 行.length + ' 条；全量 ' + ctx.审计总条数 + ' 条）'),
        h('div', { key: 'bar', className: 'dshmind-actbar' }, 格),
        // 起止时刻：给这条色带一个**坐标系**。没有它，读者无法把某个红块对到某个时间——
        // 那一排方块就只是装饰（2026-10-14 收口；数据取自同一批审计行，不新取数）。
        h('div', { key: 'axis', className: 'dshmind-actbarAxis' }, [
          h('span', { key: 'a' }, shortTime(行[0] && 行[0].时间)),
          h('span', { key: 'b' }, shortTime(行[行.length - 1] && 行[行.length - 1].时间)),
        ]),
        h('div', { key: 'lg', className: 'dshmind-legend', style: { flexDirection: 'row', gap: 12, marginTop: 6 } }, [
          h('span', { key: 'a', className: 'dshmind-legendRow' }, ['状态变更 ' + 计数.状态变更]),
          h('span', { key: 'b', className: 'dshmind-legendRow' }, ['失败 ' + 计数.失败]),
          h('span', { key: 'c', className: 'dshmind-legendRow' }, ['拦截 ' + 计数.拦截]),
          h('span', { key: 'd', className: 'dshmind-legendRow' }, ['其他 ' + 计数.其他]),
        ]),
      ]);
    }

    /**
     * 最近动态：把审计尾翻译成「人话一行」——**失败与拦截优先上色**，
     * 因为它答的是「我说过的做完了，账上对得上吗」。
     */
    function 动态时间线(ctx) {
      var 行 = (ctx.audit || []).slice(0, 8);
      if (!行.length) return null;
      return h('div', { key: 'tl', className: 'dshmind-tl' }, 行.map(function (r, i) {
        var 失败 = r.结果 === '失败';
        var 拦截 = r.动作 === '动作拦截' || r.结果 === '拒绝';
        return h('div', {
          key: 'r' + i,
          className: 'dshmind-tlRow' + (失败 ? ' dshmind-tlBad' : 拦截 ? ' dshmind-tlWarn' : ''),
        }, [
          h('span', { key: 't', className: 'dshmind-tlTime dshmind-mono' }, 短时刻(r.时间) || '—'),
          h('span', { key: 'i', className: 'dshmind-tlIcon' }, 失败 ? '✗' : 拦截 ? '⛔' : r.动作 === '状态变更' ? '·' : '•'),
          h('span', { key: 'b' }, (r.动作 || '记录') + '　' + (源主体短(r.主体) || '') + (r.结果 ? '　' + r.结果 : '')),
        ]);
      }));
    }
    /** 主体短名：先走 `短主体` 的 session- 收成（单一事实源），再按时间线 12 字预算截。 */
    function 源主体短(主体) {
      var s = 短主体(line(主体, ''));
      if (!s) return '';
      return s.length > 12 ? s.slice(0, 12) : s;
    }

    // ── 图谱（岗位 × 能力接线）─────────────────────────────────────────────────
    /**
     * 布局：**两列定宽 + 纵向均分**（岗位左、能力右）。不用力导向——
     * 力导向每次渲染位置都变，读的人记不住「上次那个红点在哪」，而这张图上
     * 「哪条红线在哪个岗位」正是要一眼看出来的东西。
     */
    function 图谱坐标(岗位, 能力) {
      // 两列拉开到画布两侧（2026-10-13 晚第二轮）：原来 120/540 挤在左边，
      // 宽屏上卡片右 1/3 全空（主权者：「面板右面空白一大堆」）。现在 150/760，标签向右吃到边。
      var 宽 = 1240;
      // 高按两列里**多的一边**算（2026-10-14 审查 P2-22）：修前只看能力数——岗位 > 能力时
      // 岗位节点被压进 240px 里纵向重叠。
      var 高 = Math.max(240, Math.max(能力.length, 岗位.length) * 34 + 48);
      var pos = {};
      var i;
      for (i = 0; i < 岗位.length; i += 1) {
        pos['角色:' + 岗位[i].id] = {
          x: 150,
          y: 岗位.length <= 1 ? 高 / 2 : 46 + (高 - 92) * i / (岗位.length - 1),
        };
      }
      for (i = 0; i < 能力.length; i += 1) {
        pos['能力:' + 能力[i].id] = {
          x: 760,
          y: 能力.length <= 1 ? 高 / 2 : 30 + (高 - 60) * i / (能力.length - 1),
        };
      }
      return { 宽: 宽, 高: 高, pos: pos };
    }

    /**
     * 图谱页：岗位 × 能力的接线图 ＋ 缺口清单。
     *
     * **为什么记忆/任务不在这一页的图里**（如实标注，不许画假边）：这一版的投影只给到
     * 记忆的**按类计数**，条目级（含 `来源引用` 血缘）还没开——`memory.query` 走契约B 要记审计，
     * 而工作台是 3 秒轮询的投影，挂上去会把审计链灌成流水。要画「教训 → 能力卡」那条血缘，
     * 得先有一条**免审计的浅读面**（`memory.stats` 同款）＋「标题算不算内容」这个披露口径的裁决。
     * 在那之前，宁可不画，也不画一条自己编的关系。
     */
    function 图谱页(ctx) {
      var 岗位 = ctx.岗位, 能力 = ctx.能力, 接线 = 接线读数(能力, 岗位);
      if (!岗位 || !能力) {
        return [h('div', { key: 'nog', className: 'dshmind-empty' },
          '这次投影没带能力/岗位接线（宿主没给 ⇒ 不装懂）：图谱要的是 `capability.list` 与 `registry.list` 两份只读真源。')];
      }
      var 坐标 = 图谱坐标(岗位, 能力);
      var 引用表 = {};
      岗位.forEach(function (r) { 引用表[r.id] = r.能力引用; });
      // 邻接表（选中态要高亮「它的邻居」）：键一律与 `data-node` 同源，别在两处各拼一遍。
      var 邻接 = {};
      function 连(a, b) {
        (邻接[a] = 邻接[a] || {})[b] = 1;
        (邻接[b] = 邻接[b] || {})[a] = 1;
      }
      能力.forEach(function (c) { c.适用岗位.forEach(function (role) { 连('能力:' + c.id, '角色:' + role); }); });
      var 选中 = 图谱选中();
      // 当前缩放/平移视图（null ＝ 整图）。放这里是为了让 viewBox 与手势共用同一份读数。
      var 视图 = 图谱视图();
      var 类名 = function (key) {
        if (!选中) return 'dshmind-gNode';
        if (key === 选中) return 'dshmind-gNode dshmind-gNodeOn';
        return 邻接[选中] && 邻接[选中][key] ? 'dshmind-gNode' : 'dshmind-gNode dshmind-gNodeOff';
      };
      var 边类名 = function (a, b) {
        if (!选中) return 'dshmind-gEdge';
        return (a === 选中 || b === 选中) ? 'dshmind-gEdge' : 'dshmind-gEdge dshmind-gEdgeOff';
      };
      var 边 = [], 节点 = [], i, j;
      // ⚠️ 闭包要**按节点绑定**：`var` 是函数作用域，直接在循环里写
      // `onClick: function () { 切图谱选中(r键) }` 会让所有节点共享同一个变量 ⇒
      // 点哪个都选到最后一个（2026-10-13 首跑被 ⑪e 当场抓出）。工厂把键固化进参数。
      // 点节点的处理器：**也吃拖拽尾巴的抑制**（拖完松手不该顺手换选中）。
      var 点击器 = function (键) { return function () { if (拖拽尾巴()) return; 切图谱选中(键); }; };
      for (i = 0; i < 岗位.length; i += 1) {
        var r = 岗位[i], rp = 坐标.pos['角色:' + r.id], r键 = '角色:' + r.id;
        var 实例 = 实例计数Of(ctx.实例计数, r.id);
        // 闲置灯（2026-10-15 主权者拍板阈值 14 天，部署键可调）：超期/从未派发 ⇒ 「闲置」；
        // 阈值关（闲置===null）时退回「未见派发」这个无需阈值的信号。完整读数挂 <title>；
        // 宿主没给这块读数 ⇒ 连 title 都不画（不装懂）。
        var 闲置 = 岗位闲置Of(ctx.岗位闲置, r.id);
        节点.push(h('g', {
          key: 'r' + i, className: 类名(r键), 'data-node': r键,
          onClick: 点击器(r键),
        }, [
          h('circle', { key: 'c', cx: rp.x, cy: rp.y, r: 12, fill: '#5b8def', fillOpacity: 0.9 }),
          h('text', { key: 't', x: rp.x + 17, y: rp.y + 4, className: 'dshmind-gLabelStrong' }, r.id),
          h('text', { key: 's', x: rp.x + 17, y: rp.y + 17, className: 'dshmind-gLabel' },
            '在岗 ' + 实例.在岗 + (实例.封存 ? ' · 封存 ' + 实例.封存 : '') + ' · 接线 ' + (r.能力引用 ? r.能力引用.length : 0)
            + (闲置.闲置 === true ? ' · 闲置' : (闲置.已知 && !闲置.最近派发于 ? ' · 未见派发' : ''))),
          闲置.已知
            ? h('title', { key: 'i' },
                r.id + '：在岗实例 ' + (闲置.在岗实例 === null ? '—' : 闲置.在岗实例)
                + ' · 封存 ' + (闲置.封存实例 === null ? '—' : 闲置.封存实例)
                + ' · 最近派发 ' + (闲置.最近派发于 || '未见')
                + (闲置.闲置 === null ? '（未判闲置：阈值关）' : '（闲置阈值 ' + 闲置.阈值 + ' 天，' + (闲置.闲置 ? '已超' : '未超') + '）'))
            : null,
        ].filter(Boolean)));
      }
      for (i = 0; i < 能力.length; i += 1) {
        var c = 能力[i], cp = 坐标.pos['能力:' + c.id], c键 = '能力:' + c.id;
        var 色 = c.来源 === '自治' ? '#a97bea' : c.来源 === '出厂' ? '#3fb27f' : '#7d8590';
        节点.push(h('g', {
          key: 'c' + i, className: 类名(c键), 'data-node': c键,
          onClick: 点击器(c键),
        }, [
          h('circle', { key: 'o', cx: cp.x, cy: cp.y, r: 8, fill: 色, fillOpacity: 0.9 }),
          h('text', { key: 't', x: cp.x + 13, y: cp.y + 4, className: 'dshmind-gLabel' }, c.id),
        ]));
      }
      for (i = 0; i < 能力.length; i += 1) {
        for (j = 0; j < 能力[i].适用岗位.length; j += 1) {
          var 岗位名 = 能力[i].适用岗位[j];
          var A = 坐标.pos['角色:' + 岗位名], B = 坐标.pos['能力:' + 能力[i].id];
          if (!A || !B) continue;
          var 已接 = (引用表[岗位名] || []).indexOf(能力[i].id) >= 0;
          // 单段二次曲线 + **每条边给一点纵向错位**：48 条边全走同一根中线会结成死结
          // （截图实测）。错位按边序取 ±2 档，够把线束摊开成"扇"，又不至于看着乱。
          var 中线 = (A.y + B.y) / 2 + ((i % 5) - 2) * 5;
          var 控制x = (A.x + B.x) / 2;
          var 相关 = !!选中 && (('角色:' + 岗位名) === 选中 || ('能力:' + 能力[i].id) === 选中);
          边.push(h('path', {
            key: 'e' + i + '-' + j,
            className: 边类名('角色:' + 岗位名, '能力:' + 能力[i].id),
            'data-wired': 已接 ? '1' : '0',
            d: 'M' + A.x + ' ' + A.y + ' Q' + 控制x + ' ' + 中线 + ' ' + B.x + ' ' + B.y,
            style: 已接
              // 默认**压低不透明度**：48 条线是「纹理」不是主角；选中/悬停时才亮起来
              ? { stroke: '#3fb27f', strokeWidth: 相关 ? 1.7 : 1, opacity: 相关 ? 0.95 : 0.42 }
              : { stroke: '#e5534b', strokeWidth: 相关 ? 1.8 : 1.2, strokeDasharray: '4 3', opacity: 相关 ? 0.95 : 0.75 },
          }));
        }
      }
      var 缺口榜 = 能力.map(function (c) {
        var 缺 = c.适用岗位.filter(function (role) { return (引用表[role] || []).indexOf(c.id) < 0; });
        return { id: c.id, 来源: c.来源, 适用: c.适用岗位, 缺: 缺 };
      }).filter(function (x) { return x.缺.length > 0; }).sort(function (a, b) { return b.缺.length - a.缺.length; });

      return [
        h('div', { key: 'bar', className: 'dshmind-graphBar' }, [
          h('span', { key: 'a', className: 'dshmind-badge', style: { color: '#3fb27f', borderColor: '#3fb27f' } }, '已接线 ' + 接线.接线.length),
          h('span', { key: 'b', className: 'dshmind-badge', style: { color: 接线.缺口.length ? '#e5534b' : '#7d8590', borderColor: 接线.缺口.length ? '#e5534b' : '#7d8590' } }, '未接线 ' + 接线.缺口.length),
          h('span', { key: 'c', className: 'dshmind-tileK' },
            '适用边 ' + 接线.适用边 + ' 条 ⇒ 接线率 ' + (接线.接线率 === null ? '—' : 接线.接线率 + '%')
            + '（自治卡 ' + 接线.自治接线 + '/' + 接线.自治适用 + '）'),
        ]),
        h('div', { key: 'wrap', className: 'dshmind-graphWrap' }, [
          // 缩放/平移：`图谱手势()` 返回的 props 直接摊进来（滚轮缩放 / 拖拽平移 / 双击复位）。
          // 复用 `Object.assign` 而不是写进对象字面量：手势那组是"可选增强"，
          // 显式摊开更能看出它**不改变** svg 的身份（key/className/viewBox 仍由这里定）。
          h('svg', Object.assign({
            key: 'svg', className: 'dshmind-graph',
            viewBox: (视图
              ? 视图.x + ' ' + 视图.y + ' ' + (坐标.宽 / 视图.k) + ' ' + (坐标.高 / 视图.k)
              : '0 0 ' + 坐标.宽 + ' ' + 坐标.高),
            'data-dshmind': 'graph',
            preserveAspectRatio: 'xMidYMid meet',
          }, 图谱手势(坐标.宽, 坐标.高)), [
            // 空白层：铺满画布、垫在节点下面。点空白 ⇒ 取消选中（见 清图谱选中 的注释）。
            // `fill:'transparent'` 而不是 `none`：`none` 不接收指针事件。
            h('rect', {
              key: 'bg', 'data-graph-bg': '1',
              x: 0, y: 0, width: 坐标.宽, height: 坐标.高, fill: 'transparent',
              // 拖拽尾巴不算点击（见 拖拽尾巴 的注释）
              onClick: function () { if (!拖拽尾巴()) 清图谱选中(); },
            }),
          ].concat(边, 节点)),
          // 详情抽屉：点节点开（纯显示动作）。不选就不画 —— 不给一壳空抽屉。
          选中 ? 图谱详情(选中, ctx, 引用表, 邻接) : null,
        ]),
        // 两段说明**并排**（各占一半）—— 单列时右半边空着（宽屏上很扎眼）
        h('div', {
          key: 'notes',
          style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(380px,1fr))', gap: '10px', marginTop: 8 },
        }, [
          h('div', { key: 'note', className: 'dshmind-graphNote', style: { maxWidth: 'none' } },
            '左列＝岗位卡（蓝）· 右列＝能力卡（紫＝自治／绿＝出厂）。绿实线＝岗位卡的 个体L2 真引用了这张卡；'
            + '红虚线＝能力卡声明「适用这个岗位」但岗位卡里没有 ⇒ **成员实际看不到这张卡**（发卡 ≠ 接线）。'
            // 手势提示：**只给文字、不给控件**（只读面板的可点面有白名单，多一类就算破规）。
            + '　📐 **滚轮缩放 · 拖拽平移 · 双击复位**'),
          h('div', { key: 'mem', className: 'dshmind-graphNote', style: { maxWidth: 'none' } },
            '记忆（按类）：' + (ctx.记忆 && ctx.记忆.按类
              ? '经历 ' + (ctx.记忆.按类.经历 === null ? '—' : ctx.记忆.按类.经历)
                + ' · 知识 ' + (ctx.记忆.按类.知识 === null ? '—' : ctx.记忆.按类.知识)
                + ' · 偏好 ' + (ctx.记忆.按类.偏好 === null ? '—' : ctx.记忆.按类.偏好)
                + '　—　**条目级血缘（「教训立卡」）暂不上图**：它要一条免审计的条目浅读面（工作台是 3 秒轮询，'
                + '走 memory.query 会把审计链灌成流水），且「标题算不算内容」需先定披露口径。宁可不画，不画编的关系。'
              : '宿主没给按类计数 ⇒ 不画。')),
        ]),
        // 图例：把上面那句话里的颜色/线型**画出来**（文字解释留一处，图例只做对照）
        h('div', { key: 'legend', className: 'dshmind-legend',
          style: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, marginTop: 8 } }, [
          h('span', { key: 'r', className: 'dshmind-legendRow' }, [
            h('i', { key: 's', className: 'dshmind-swatch', style: { borderRadius: '50%', background: '#5b8def' } }),
            h('span', { key: 't' }, '岗位'),
          ]),
          h('span', { key: 'ca', className: 'dshmind-legendRow' }, [
            h('i', { key: 's', className: 'dshmind-swatch', style: { borderRadius: '50%', background: '#a97bea' } }),
            h('span', { key: 't' }, '自治能力卡'),
          ]),
          h('span', { key: 'cf', className: 'dshmind-legendRow' }, [
            h('i', { key: 's', className: 'dshmind-swatch', style: { borderRadius: '50%', background: '#3fb27f' } }),
            h('span', { key: 't' }, '出厂能力卡'),
          ]),
          h('span', { key: 'w', className: 'dshmind-legendRow' }, [
            h('i', { key: 's', className: 'dshmind-swatch', style: { background: '#3fb27f' } }),
            h('span', { key: 't' }, '已接线（岗位卡真引用了它）'),
          ]),
          h('span', { key: 'u', className: 'dshmind-legendRow' }, [
            h('i', { key: 's', className: 'dshmind-swatch',
              style: { background: 'repeating-linear-gradient(90deg,#e5534b 0 4px,transparent 4px 7px)' } }),
            h('span', { key: 't' }, '未接线（声明了，但成员看不到）'),
          ]),
        ]),
        // 缺口榜收进卡片（与其它分区同一套卡片语言；裸标题会显得像没做完的一页）
        h('section', { key: 'gap', className: 'dshmind-sec' }, [
          h('div', { className: 'dshmind-secHead' }, [
            h('h3', { key: 't', className: 'dshmind-secTitle' }, '接线缺口榜'),
            h('span', { key: 'h', className: 'dshmind-secHint' },
              缺口榜.length ? '能力卡声明了适用、岗位卡里却没引用 ⇒ 成员实际看不到这张卡' : '没有缺口：声明与接线一致'),
            h('span', { key: 'c', className: 'dshmind-secCount dshmind-mono' }, String(缺口榜.length)),
          ]),
          h('div', { key: 'b', className: 'dshmind-secBody' }, 缺口榜.length
            ? h('table', { key: 'tbl', className: 'dshmind-tbl' }, [
                h('thead', { key: 'h' }, h('tr', {}, [
                  h('th', { key: 'a' }, '能力卡'), h('th', { key: 'b' }, '来源'),
                  h('th', { key: 'c' }, '声明适用'), h('th', { key: 'd' }, '未接线岗位'),
                ])),
                h('tbody', { key: 'b' }, 缺口榜.map(function (x, i) {
                  return h('tr', { key: 'r' + i }, [
                    h('td', { key: 'a', className: 'dshmind-mono' }, x.id),
                    h('td', { key: 'b' }, x.来源 === '自治' ? '自治' : x.来源 === '出厂' ? '出厂' : (x.来源 || '—')),
                    h('td', { key: 'c' }, x.适用.join('、')),
                    h('td', { key: 'd', className: 'dshmind-tlBad' }, x.缺.join('、')),
                  ]);
                })),
              ])
            : h('div', { key: 'ok', className: 'dshmind-empty' }, '✓ 无接线缺口：' + 接线.适用边 + ' 条适用边全部接上')),
        ]),
      ];
    }
    /**
     * 图谱的详情抽屉（2026-10-13 重做）：点开一个节点，回答「**它到底接了谁**」。
     *
     * 只读投影的现算，不新取数：岗位侧列它引用的每张卡（已接/未接），
     * 能力侧列它声明的每个岗位（已接/未接）。未接的一律显式写「未接线」——
     * 这正是「发卡 ≠ 接线」在单个节点上的读法。
     */
    function 图谱详情(键, ctx, 引用表, 邻接) {
      var 是岗位 = 键.indexOf('角色:') === 0;
      var id = 键.slice(3);
      var 邻居 = Object.keys(邻接[键] || {});
      var 行 = [];
      if (是岗位) {
        var 岗位 = (ctx.岗位 || []).filter(function (r) { return r.id === id; })[0];
        var 实例 = 实例计数Of(ctx.实例计数, id);
        行.push(['来源', (岗位 && 岗位.来源 ? 岗位.来源 + '区' : '—')
          + (岗位 && 岗位.同名 && 岗位.同名.length > 1 ? '（同名：' + 岗位.同名.join(' · ') + '，生效＝' + 岗位.来源 + '）' : '')]);
        行.push(['实例', '在岗 ' + (实例.在岗 === null ? '—' : 实例.在岗) + ' · 封存 ' + (实例.封存 === null ? '—' : 实例.封存)]);
        行.push(['接线', (岗位 && 岗位.能力引用 ? 岗位.能力引用.length : 0) + ' 张（声明适用它的一共 ' + 邻居.length + ' 张）']);
      } else {
        var 能力 = (ctx.能力 || []).filter(function (c) { return c.id === id; })[0];
        行.push(['来源', 能力 && 能力.来源 ? 能力.来源 + '能力库' : '—']);
        行.push(['适用', (能力 ? 能力.适用岗位.length : 0) + ' 个岗位']);
      }
      return h('div', { key: 'drawer', className: 'dshmind-gDrawer' }, [
        h('h5', { key: 'h' }, [
          h('span', { key: 'i' }, 是岗位 ? '岗位' : '能力卡'),
          h('span', { key: 'x', className: 'dshmind-mono' }, id),
        ]),
      ].concat(
        // 取消方式写在抽屉里（不然「怎么收起来」得靠猜；点同一个节点也能收）
        [h('div', { key: 'hint', className: 'dshmind-graphNote', style: { marginTop: 3 } }, '点空白处或再点它一次即可取消')],
        行.map(function (r, i) {
          return h('div', { key: 'r' + i, className: 'dshmind-gDrawerRow' }, [
            h('b', { key: 'k' }, r[0]), h('span', { key: 'v' }, r[1]),
          ]);
        }),
        [h('div', { key: 'links', className: 'dshmind-gLinks' }, 邻居.length
          ? 邻居.map(function (n, i) {
              var 邻居是岗位 = n.indexOf('角色:') === 0;
              var 邻居id = n.slice(3);
              var 已接 = 是岗位
                ? (引用表[键.slice(3)] || []).indexOf(邻居id) >= 0
                : (引用表[邻居id] || []).indexOf(键.slice(3)) >= 0;
              return h('span', { key: 'l' + i, className: 'dshmind-gLink' }, [
                h('span', { key: 'd', className: 'dshmind-swatch', style: { background: 已接 ? '#3fb27f' : '#e5534b' } }),
                h('span', { key: 'n', className: 'dshmind-mono' }, 邻居id),
                h('span', { key: 'w' }, 已接 ? '已接线' : '未接线'),
              ]);
            })
          : [h('span', { key: 'none', className: 'dshmind-gLink' }, '没有声明关系（既没适用岗位，也没被引用）')]),
        ]));
    }

    /** 岗位的实例计数（宿主没给 ⇒ 全 null，不装懂成 0）。 */
    function 实例计数Of(袋, 岗位名) {
      var b = obj(袋);
      var 按 = b ? obj(b.按岗位) : null;
      var 行 = 按 ? obj(按[岗位名]) : null;
      return {
        在岗: 行 && typeof 行.在岗 === 'number' ? 行.在岗 : null,
        封存: 行 && typeof 行.封存 === 'number' ? 行.封存 : null,
        已知: !!行,
      };
    }

    /**
     * 岗位闲置读数（派活闭环 2026-10-15；宿主没给 ⇒ 全 null，不装懂）。
     * 投影给的是「跨全部项目现算」的读数 + 部署阈值（`岗位闲置天数`，0 = 不判）：
     * `闲置 === true` = 超 N 天无派发（含从未派发）的**机械读数**；`闲置 === null` = 阈值关，
     * 只有「未见派发」这个无需阈值的信号。
     */
    function 岗位闲置Of(袋, 岗位名) {
      var b = obj(袋);
      var 表 = b ? obj(b.岗位) : null;
      var 行 = 表 ? obj(表[岗位名]) : null;
      return {
        在岗实例: 行 && typeof 行.在岗实例 === 'number' ? 行.在岗实例 : null,
        封存实例: 行 && typeof 行.封存实例 === 'number' ? 行.封存实例 : null,
        最近派发于: 行 ? line(行.最近派发于, '') : null,
        闲置: 行 && typeof 行.闲置 === 'boolean' ? 行.闲置 : null,
        阈值: b && typeof b.阈值 === 'number' ? b.阈值 : null,
        已知: !!行,
      };
    }

    /** 记忆页：读数与构成 + 「正文不在这里」的口径说明（内容出口是对话）。 */
    function 记忆页(ctx) {
      var 记忆 = ctx.记忆;
      if (!记忆) {
        return [h('div', { key: 'nomem', className: 'dshmind-empty' }, '这次投影没带记忆读数（宿主没给 ⇒ 不装懂）。')];
      }
      var 卡 = [];
      if (记忆.按类) {
        卡.push(可视化卡('按类构成', 记忆.存量 === null ? '' : '共 ' + 记忆.存量 + ' 条', [
          { 名: '经历', 值: 记忆.按类.经历, 色: '#4bb8c8' },
          { 名: '知识', 值: 记忆.按类.知识, 色: '#a97bea' },
          { 名: '偏好', 值: 记忆.按类.偏好, 色: '#d4a053' },
        ]));
      }
      return [
        // ① 四个读数砖铺满一行（原来只有三个、每个又宽又空；第四格放"按类"的实际数字）
        h('div', { key: 'tiles', className: 'dshmind-tiles' }, [
          h('div', { key: 'a', className: 'dshmind-tile' }, [
            h('div', { key: 'k', className: 'dshmind-tileK' }, '存量'),
            h('div', { key: 'v', className: 'dshmind-tileV dshmind-mono' }, 记忆.存量 === null ? '—' : String(记忆.存量)),
            h('div', { key: 'd', className: 'dshmind-tileD' }, '四类账目合计（知识 / 经历 / 偏好 / 作答）'),
          ]),
          h('div', { key: 'b', className: 'dshmind-tile' }, [
            h('div', { key: 'k', className: 'dshmind-tileK' }, '近 ' + (记忆.窗口天 || 7) + ' 天新增'),
            h('div', { key: 'v', className: 'dshmind-tileV dshmind-mono' }, 记忆.新增 === null ? '—' : String(记忆.新增)),
            h('div', { key: 'd', className: 'dshmind-tileD' }, '窗口外的旧条目不进这一格'),
          ]),
          h('div', { key: 'c', className: 'dshmind-tile' }, [
            h('div', { key: 'k', className: 'dshmind-tileK' }, '近段晋升'),
            h('div', { key: 'v', className: 'dshmind-tileV dshmind-mono' }, 记忆.晋升 === null ? '—' : String(记忆.晋升)),
            h('div', { key: 'd', className: 'dshmind-tileD' }, '跨项目共享的条目'),
          ]),
          记忆.按类
            ? h('div', { key: 'd', className: 'dshmind-tile' }, [
                h('div', { key: 'k', className: 'dshmind-tileK' }, '按类'),
                h('div', { key: 'v', className: 'dshmind-tileV dshmind-mono' },
                  '经历 ' + (记忆.按类.经历 === null ? '—' : 记忆.按类.经历)
                  + ' · 知识 ' + (记忆.按类.知识 === null ? '—' : 记忆.按类.知识)
                  + ' · 偏好 ' + (记忆.按类.偏好 === null ? '—' : 记忆.按类.偏好)),
                h('div', { key: 'd', className: 'dshmind-tileD' }, '作答按实例归档，不计入常驻三类'),
              ])
            : null,
        ].filter(Boolean)),
        // ② 构成图与「为什么不列条目」并排 —— 两块各占一半，不再是一块挤在左、右半边空着
        h('div', {
          key: 'grid',
          style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(380px,1fr))', gap: '10px', alignItems: 'start' },
        }, [
          卡.length ? 卡[0] : null,
          h('div', { key: 'why', className: 'dshmind-graphNote', style: { maxWidth: 'none', paddingTop: 2 } },
            '为什么这里没有条目列表：记忆正文可能含敏感上下文，面板只做**读数与结构**（存量／新增／晋升／按类），'
            + '不做全文陈列。要查内容，在对话里说一句「memory_query ×××」——命中的条目与来源会一起给你。'
            + '**面板管「状态与账」，对话管「内容与意图」。**'),
        ].filter(Boolean)),
      ];
    }
    /**
     * 一格读数：**键在上、值在下**。
     *
     * 三条规矩（每条都是真机上挑出来的）：
     *  1. **值可换行、不裁切**（Batch 8）：旧版 `nowrap` + `ellipsis` 会把「已关闭（不判定失联）」
     *     裁成「已关闭（不判定失」——为了"一行好看"牺牲了完整性。
     *  2. **壳只在有内容的格上**（**Batch 9**）：`没内容就不画壳` —— 旧版 `auto-fit` 网格会给
     *     空轨道也画上底色/边框，排不满时末尾就是一块空洞的方框（主人说的"空位突兀"）。
     *     现在：没有值就**整格不渲染**，不留"壳"。
     *  3. **值不许是光秃秃的 `—`**（Batch 9）：没有值就**不画这一格**（不占位置、不留空框）。
     *
     * `alarm` 只染**值那一小块**（底色贴合内容，不铺满整列）。
     *
     * @param {string} key 键
     * @param {string|null} value 纯文本值（`node` 为空时用它）
     * @param {*} [node] 自定义值节点
     * @param {boolean} [alarm] 是否进告警色（闸不在位 / 已失联 / 已关闭）
     * @param {*} [note] 格内附注（换行的次要读数；紧贴这一格，不横跨整行）
     * @param {boolean} [允许空壳] **仅用于故障注入**（默认关，生产永远走 `false`）：为真时"没内容也照样画壳"
     * @returns {*} 有内容才返回元素；**没内容返回 `null`**（调用方照旧 `.filter(Boolean)`）
     */
    function readout(key, value, node, alarm, note, 允许空壳) {
      var 内容 = node || value;
      // 「没内容」= 没给 `node` 也没给值，或者给的是空串 / 破折号占位。
      // 破折号也算"没内容"：那是"这一格没东西"的记法，而 Batch 9 的规矩是**不占位置**。
      var 有内容 = !(内容 === null || 内容 === undefined
        || (typeof 内容 === 'string' && (内容.trim() === '' || 内容.trim() === '—' || 内容.trim() === '-')));
      if (!有内容 && 允许空壳 !== true) return null;
      return h('div', { className: 'dshmind-readout' + (alarm ? ' dshmind-readoutAlarm' : '') }, [
        h('div', { className: 'dshmind-readoutKey' }, key),
        h('div', { className: 'dshmind-readoutVal' }, 内容),
        note ? h('div', { className: 'dshmind-readoutNote' }, note) : null,
      ].filter(Boolean));
    }

    /**
     * 页头「项目」格里的一个项目 chip（2026-10-11，主权者指令「修」）。
     *
     * 语义：**换一个项目的投影**（`?project=` 重取），不写任何账 —— 与页头「刷新」同类，
     * 所以面板仍然是「只读投影 + 两个纯显示动作」。当前项目画成不可点的 span（不给假控件）。
     * 计数随 chip 一起给：主人一眼看出「哪个项目里才有卡/消息」。
     * @param {{项目:string, 任务:number, 线程:number, 未投递:number}} p
     * @param {number} i 渲染序（做 key）
     * @param {string} 当前 现在显示的项目键
     */
    function 项目导航项(p, i, 当前) {
      // 计数缺数据画「？」不画 null/undefined（2026-10-12 评审 P3）：缺数据不是 0，
      // 印「null 卡」是排版事故，印「0 卡」是说谎。
      var 数 = function (n) { return Number.isFinite(n) ? String(n) : '？'; };
      var 文案 = p.项目 + '（' + 数(p.任务) + ' 卡 · ' + 数(p.线程) + ' 线程'
        + (p.未投递 > 0 ? ' · 未投递 ' + p.未投递 : '') + '）';
      if (p.项目 === 当前) {
        return h('span', { key: 'p' + i, className: 'dshmind-projChipOn', title: 文案 + '（当前显示）' }, 文案);
      }
      return h('button', {
        key: 'p' + i,
        type: 'button',
        className: 'dshmind-projChip',
        title: '切到这个项目的投影（只读：不改任何账）',
        onClick: function () { 切项目(p.项目); 立即刷新(); },
      }, 文案);
    }

    /**
     * 空态用的一句「还有哪些项目有账」（2026-10-11，主权者指令「修」）。
     * 现状空话照旧（harness 钉着它），后面接一句实话：当前项目是不是空的、别处有没有账。
     * @param {object|null} 清单 归一化后的 项目清单
     * @param {string} 当前 当前项目键
     * @returns {string} 追加说明（没有别的项目时不追加，返回空串）
     */
    function 他处有账(清单, 当前) {
      var 项 = (清单 && 清单.项) || [];
      var 别处 = 项.filter(function (x) { return x.项目 !== 当前 && (x.任务 > 0 || x.线程 > 0); });
      if (!别处.length) return '';
      return '；本项目（' + (当前 || '未知') + '）没有账，有账的是：'
        + 别处.slice(0, 3).map(function (x) { return x.项目 + '（' + x.任务 + ' 卡 · ' + x.线程 + ' 线程）'; }).join('、')
        + ' —— 点上方「项目」那一格的 chip 切过去';
    }

    /**
     * 空 section 的上手引导（优化批①）：空话换成「一句现状 + 一句来路 + 一条可敲的命令」。
     * 口径：§9 只读投影——给**可选中复制的文本**（`.dshmind-cmd` 的 code 块），不给控件；
     * 命令里的 id 用 `task-…` 占位（是示例不是真节点），照抄进任何会话即走真链路。
     * @param {string} 现状 一句明说的空态（原有措辞保留——harness 断言钉着它们）
     * @param {string} 来路 这一块的数据由什么产生（一句话，不含命令）
     * @param {string} 命令 示例命令全文
     */
    function emptyGuide(现状, 来路, 命令) {
      return h('div', { key: 'none', className: 'dshmind-empty' }, [
        h('div', { key: 't' }, 现状 + ' —— ' + 来路),
        h('code', { key: 'cmd', className: 'dshmind-cmd dshmind-mono', title: '选中复制这条命令去执行' }, 命令),
      ]);
    }

    /**
     * 读数分组（优化批④）：「身份（项目键/生成时刻）」与「健康（闸/介入度/失联/探针）」两组。
     * 为什么分：读数行 6-7 格一行，失联详情多行附注时把整行撑高，身份读数跟着变形。
     * 定案不翻烧饼：失联详情**仍贴格**（留在失联那一格里，不拉回整行脚注——Batch 8）。
     * Batch 9 推到组级：组内一格都没有时**整组不画**，组标签不许浮空。
     * @param {string} label 组名
     * @param {Array} cells `readout(…)` 的返回值们（可含 null）
     */
    function readoutGroup(label, cells) {
      var 有 = (cells || []).filter(Boolean);
      if (!有.length) return null;
      return h('div', { className: 'dshmind-readoutGroup' }, [
        h('span', { className: 'dshmind-readoutGroupLabel' }, label),
        h('div', { className: 'dshmind-readouts' }, 有),
      ]);
    }

    // ── 会话定位 ────────────────────────────────────────────────────────────
    /**
     * 定位「用户正在看的会话」。官方口径是 `sessions.list` 快照里
     * `retainedBy.mainView > 0` 的那一行（`dsh-client-ui-session` 自己也用这条）；
     * 取不到时退回目录里的最后一条。全部包在 try/catch 里：任何一处 API 形状
     * 变了都只是「拿不到会话 id」，而不是抛错。
     */
    function resolveSessionId(ctx) {
      try {
        var sessions = ctx.get('sessions');
        var list = sessions && sessions.list;
        var snapshot = list && typeof list.getSnapshot === 'function' ? list.getSnapshot() : null;
        var box = obj(snapshot);
        if (box) {
          var ids = Array.isArray(box.ids) ? box.ids.slice() : Object.keys(obj(box.byId) || {});
          var byId = obj(box.byId) || {};
          var main = '';
          for (var i = 0; i < ids.length; i += 1) {
            var row = byId[ids[i]];
            if (row && row.retainedBy && Number(row.retainedBy.mainView) > 0) { main = String(ids[i]); break; }
          }
          if (main) return { id: main, source: 'sessions.list · mainView' };
          if (ids.length) return { id: String(ids[ids.length - 1]), source: 'sessions.list · 末条' };
        }
      } catch (error) { /* 换下一条路 */ }

      try {
        var ui = ctx.get('uiSession');
        var candidates = ui ? [ui.sessionId, ui.activeSessionId, ui.currentSessionId, ui.current, ui.id] : [];
        for (var j = 0; j < candidates.length; j += 1) {
          var value = candidates[j];
          var id = line(typeof value === 'object' && value ? value.id : value);
          if (id) return { id: id, source: 'uiSession' };
        }
      } catch (error) { /* 换下一条路 */ }

      try {
        var manual = line(window.__dshSessionId);
        if (manual) return { id: manual, source: 'window.__dshSessionId' };
      } catch (error) { /* 没有就没有 */ }

      return { id: '', source: '' };
    }

    /**
     * 打一次同源 HTTP 请求，拿回宿主那边算好的 JSON。**永不 reject**：所有失败（含**超时**）
     * 都变成一个 `{ok:false, error}`。返回形状：`{ok:true, value}` 或 `{ok:false, error}`，
     * `value` 就是**命令面那份同形 JSON**（`{成功:true, …}` / `{成功:false, 结果, 理由, …}`）。
     *
     * 看板取数与设置页读写走的是**同一条路**（同一个 `fetch` + 同一套「失败包成 ok:false」的约定），
     * 所以只有这一个入口 —— 降级口径就只有一份。
     *
     * ⚠️ **上限等待是这条路的硬要求**：请求可能永不 settle（通道不回、宿主卡住），
     * 只有 `.catch` 是**永远等不到**的 ⇒ 页面会一直停在 loading。
     * 超时错误里带上**可诊断信息**（路由 · 等了多久）：下一张真机截图就能指出卡在哪一步。
     *
     * @param {object} ctx 客户端上下文（**不再用它取 `remote`**，留着只为兼容调用点签名）
     * @param {string} sessionId 会话 id（`resolveSessionId` 给的；这里只进诊断串，不进 URL）
     * @param {{method:string, path:string, body?:object}} 请求
     */
    function runCommand(ctx, sessionId, 请求) {
      var 会话尾 = line(sessionId, '') ? String(sessionId).slice(0, 12) + '…' : '（无会话 id）';
      var 方法 = 请求 && 请求.method ? String(请求.method).toUpperCase() : 'GET';
      var 路径 = 请求 && 请求.path ? String(请求.path) : '';
      return new Promise(function (resolve) {
        var 取fetch = null;
        try {
          if (typeof globalThis !== 'undefined' && globalThis && typeof globalThis.fetch === 'function') 取fetch = globalThis.fetch;
        } catch (error) { /* 继续试 window */ }
        if (!取fetch) {
          try {
            if (typeof window !== 'undefined' && window && typeof window.fetch === 'function') 取fetch = function () { return window.fetch.apply(window, arguments); };
          } catch (error) { /* 没有就没有 */ }
        }
        if (typeof 取fetch !== 'function') {
          resolve({ ok: false, error: '本客户端拿不到 fetch：读不到设置（这一页需要一个能发请求的会话宿主）。' });
          return;
        }
        var 选项 = { method: 方法 };
        // 插件通道标记（2026-10-13 真机取证用）：官方客户端里插件页的请求到达路由时
        // **不带 Fetch Metadata 头**（`sec-fetch-site` 缺席）⇒ 与「本机任意进程」无法区分
        // ⇒ 被同源栅栏整类拒掉（P1-10 的 fail-closed）。这里带一个自有标记头，用来实测
        // **自定义头能不能穿过那条通道**：能穿过，才谈得上拿它做凭据（认凭据而不是认来源）。
        选项.headers = { 'x-dsh-mind-panel': '1' };
        if (方法 === 'GET') {
          // 照同机跑通的第三方插件：GET 一律绕开缓存。
          选项.cache = 'no-store';
        } else if (请求.body !== undefined) {
          选项.headers['content-type'] = 'application/json';
          选项.body = JSON.stringify(请求.body);
        }
        var pending;
        try {
          pending = 取fetch(路径, 选项);
        } catch (error) {
          // 同步抛（有些实现对非法参数会抛）：按请求失败处理，别让它冒出去。
          resolve({ ok: false, error: '请求发送失败：' + line(error && error.message, String(error)) });
          return;
        }
        var 说明 = '路由 ' + 方法 + ' ' + 路径 + ' · 会话 ' + 会话尾
          + ' · 等 ' + Math.round(COMMAND_TIMEOUT_MS / 1000) + ' 秒无回应';
        限时(pending, COMMAND_TIMEOUT_MS, 说明).then(function (response) {
          try {
            if (!response || typeof response !== 'object') { resolve({ ok: false, error: '请求没有返回响应体' }); return; }
            var 状态 = Number(response.status);
            var 行不行 = response.ok === true || (状态 >= 200 && 状态 < 300);
            // 读文本再自己解析：响应**不是** JSON 时也要能给出人话（别让 `res.json()` 抛出去）。
            限时(Promise.resolve(typeof response.text === 'function' ? response.text() : ''), COMMAND_TIMEOUT_MS, 说明 + '（响应体）').then(function (text) {
              try {
                var parsed = parseLooseJson(text);
                if (!obj(parsed)) {
                  resolve({ ok: false, error: 行不行 ? '返回的内容不是 JSON（HTTP ' + 状态 + '）' : 'HTTP ' + 状态 });
                  return;
                }
                // 宿主把失败也包在同一份 JSON 里（`{成功:false, 结果:'结构不合规', 理由:…}`，
                // 见 `describeFailure`）：认出来就不许当成成功 —— 否则设置页会把「被拒绝」
                // 显示成「已保存」。`理由` 就是那条可执行理由，优先取它。
                if (parsed.成功 === false) {
                  resolve({ ok: false, value: parsed, status: 状态, error: line(firstOf(parsed, ['理由', '错误', '原因', '结果', 'message']), '请求被拒绝') });
                  return;
                }
                if (!行不行) { resolve({ ok: false, value: parsed, status: 状态, error: 'HTTP ' + 状态 }); return; }
                resolve({ ok: true, value: parsed });
              } catch (error) {
                resolve({ ok: false, error: '解析返回体失败：' + line(error && error.message, String(error)) });
              }
            }, function (error) {
              resolve({ ok: false, error: '读取返回体失败：' + line(error && error.message, String(error)) });
            });
          } catch (error) {
            resolve({ ok: false, error: '解析返回体失败：' + line(error && error.message, String(error)) });
          }
        }, function (error) {
          resolve({ ok: false, error: '请求失败：' + line(error && error.message, String(error)) });
        });
      });
    }

    /**
     * 取工作台投影。**永不 reject**：所有失败都变成一个 `{ok:false, error}`。
     * 返回形状：`{ok:true, view}` 或 `{ok:false, error}`。
     */
    function fetchView(ctx, sessionId, 项目) {
      var 路径 = ROUTE_WORKBENCH + (项目 ? '?project=' + encodeURIComponent(项目) : '');
      return runCommand(ctx, sessionId, { method: 'GET', path: 路径 }).then(function (out) {
        if (!out.ok) return out;
        return { ok: true, view: normalizeView(out.value) };
      });
    }

    function readDelegation() {
      return runCommand(activeCtx, '', { method: 'GET', path: ROUTE_DELEGATION }).then(function (out) {
        if (!out.ok) return out;
        var data = obj(out.value.数据);
        if (!data || !obj(data.persistence) || !obj(data.persistence.config) || !obj(data.runtime)
          || typeof data.persistence.fingerprint !== 'string' || typeof data.runtime.fingerprint !== 'string') {
          return { ok: false, error: '调度设置回读缺少盘面或真实运行策略。' };
        }
        return { ok: true, data: data };
      });
    }

    function 刷新调度() {
      if (!调度页已访问) return Promise.resolve({ ok: false, error: '设置页尚未打开' });
      var 号 = 调度序号.取号();
      return readDelegation().then(function (out) {
        if (!调度序号.该用(号)) return { ok: false, error: '回读已被较新的请求替代，请重新核对。' };
        发通知(调度store, { phase: out.ok ? 'live' : 'error', data: out.ok ? out.data : null, error: out.ok ? '' : out.error });
        return out;
      });
    }

    function writeDelegation(config, expectedFingerprint) {
      return runCommand(activeCtx, '', {
        method: 'POST', path: ROUTE_DELEGATION,
        body: { delegation: config, expectedFingerprint: expectedFingerprint },
      }).then(function (post) {
        // POST 可能重装自身，也可能超时后才提交；无论回执怎样，都只用另一次 GET 验证新实例。
        调度序号.该用(调度序号.取号());
        return 刷新调度().then(function (back) { return { post: post, back: back }; });
      });
    }

    function 刷新人设() {
      if (!人设页已访问) return Promise.resolve({ ok: false, error: '设置页尚未打开' });
      var 号 = 人设序号.取号();
      return runCommand(activeCtx, '', { method: 'GET', path: ROUTE_PERSONA_CORE }).then(function (out) {
        if (!人设序号.该用(号)) return { ok: false, error: '人设回读已被较新的请求替代。' };
        var data = out.ok && obj(out.value.数据);
        if (out.ok && (!data || typeof data.text !== 'string' || typeof data.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(data.fingerprint))) out = { ok: false, error: '未读到完整的核心人设与版本。' };
        发通知(人设store, { phase: out.ok ? 'live' : 'error', data: out.ok ? data : null, error: out.ok ? '' : out.error });
        return out.ok ? { ok: true, data: data } : out;
      });
    }

    function writePersonaCore(text, expectedFingerprint) {
      return runCommand(activeCtx, '', { method: 'POST', path: ROUTE_PERSONA_CORE, body: { text: text, expectedFingerprint: expectedFingerprint } }).then(function (post) {
        人设序号.该用(人设序号.取号());
        return 刷新人设().then(function (back) { return { post: post, back: back }; });
      });
    }

    // ── 设置页的数据通道：读 / 写 `mind presence` ────────────────────────────
    /** 设置页命令：与看板**同一条通道**（同源 `fetch` 路由，见 `runCommand`），不同子命令。 */
    var PRESENCE_COMMAND = '/mind presence';
    /** 没有 remote / 没有会话时给的那条命令：让人自己复制去敲，而不是看一块空白。 */
    var PRESENCE_EXAMPLE = '/mind presence 开关=是 小时=168';

    /**
     * 读当前生效设置。读数取自命令返回体的 `读数` 字段（宿主 `policy.presence()` 的原样）。
     * @returns {Promise<{ok:true, 读数:object, 设置文件:string, 说明:string} | {ok:false, error:string}>}
     */
    function readPresence(ctx, sessionId) {
      return runCommand(ctx, sessionId, { method: 'GET', path: ROUTE_PRESENCE }).then(function (out) {
        if (!out.ok) return out;
        var 读数 = obj(out.value.读数);
        if (!读数) return { ok: false, error: '返回体里没有「读数」字段' };
        return {
          ok: true,
          读数: 读数,
          设置文件: line(out.value.设置文件, ''),
          说明: line(out.value.说明, ''),
        };
      });
    }

    /**
     * 写设置。
     *
     * ⚠️ 传输层的失败会被包成 `{ok:false,error}` 而**不会 reject**
     * （见 `runCommand`：fetch 拒绝、HTTP 非 2xx、返回体不是 JSON、宿主同形 JSON 里的
     * `{成功:false}` 都走这条路），
     * 所以「没抛错」绝不等于「写进去了」—— 唯一判据是**回读**。
     * 这里发完写命令立刻再读一次，并把「请求了什么」一起交给界面：
     * 界面按回读值显示，回读与请求不一致就明说「没写进去」。
     *
     * @param {{ctx:object, sessionId:string, 开关:'是'|'否'|null, 小时:number|null}} spec
     *   `开关` / `小时` 传 null 表示这次不该这个键（不是「写成 null」）。
     * @returns {Promise<{ok:true, 请求:object, 写回应:object, 回读:object} | {ok:false, error:string, 请求:object}>}
     */
    function writePresence(spec) {
      var 请求 = {
        开关: spec.开关 === undefined ? null : spec.开关,
        小时: spec.小时 === undefined ? null : spec.小时,
        介入度: spec.介入度 === undefined ? null : spec.介入度,
        复核免审: spec.复核免审 === undefined ? null : spec.复核免审,
      };
      // body 里**只放本次真要改的键**：`开关=是` 单独一次写不许顺手把别的键也写一遍
      // （那会把「只改一个键」变成"替人做主改了另一个"）。
      var body = {};
      if (请求.开关 !== null) body.开关 = 请求.开关;
      if (请求.小时 !== null) body.小时 = 请求.小时;
      if (请求.介入度 !== null) body.介入度 = 请求.介入度;
      if (请求.复核免审 !== null) body.复核免审 = 请求.复核免审;
      return runCommand(spec.ctx, spec.sessionId, { method: 'POST', path: ROUTE_PRESENCE, body: body }).then(function (out) {
        if (!out.ok) return { ok: false, error: out.error, 请求: 请求 };
        // 写成功也**必须回读**：写请求的返回值是「它说它做了什么」，回读才是「盘上现在是什么」。
        return readPresence(spec.ctx, spec.sessionId).then(function (back) {
          if (!back.ok) return { ok: false, error: '写请求已发出，但回读失败：' + back.error, 请求: 请求 };
          return { ok: true, 请求: 请求, 写回应: out.value, 回读: back };
        });
      });
    }

    /** 回读是否与请求一致；不一致就返回**明说没写进去**的文案（而绝不是「已保存」）。 */
    function 回读对不上(请求, 读数) {
      var 差 = [];
      if (请求.开关 !== null) {
        var 实际开关 = 开关态Of(读数);
        var 实际文本 = 实际开关 === false ? '否' : 实际开关 === true ? '是' : '读不出';
        if (实际文本 !== 请求.开关) 差.push('开关 请求 ' + 请求.开关 + ' / 回读 ' + 实际文本);
      }
      if (请求.小时 !== null) {
        var 实际小时 = numOf(读数.生效响应期限小时);
        if (实际小时 !== 请求.小时) 差.push('小时 请求 ' + 请求.小时 + ' / 回读 ' + (实际小时 === null ? '读不出' : 实际小时));
      }
      if (请求.介入度 !== null) {
        var 实际档 = line(obj(读数) && 读数.介入度, '读不出');
        if (实际档 !== 请求.介入度) 差.push('介入度 请求 ' + 请求.介入度 + ' / 回读 ' + 实际档);
      }
      if (请求.复核免审 !== null) {
        var 实际免审 = boolOf(obj(读数) && 读数.复核免审);
        var 免审文本 = 实际免审 === null ? '读不出' : (实际免审 ? '是' : '否');
        if (免审文本 !== (请求.复核免审 ? '是' : '否')) 差.push('复核免审 请求 ' + (请求.复核免审 ? '是' : '否') + ' / 回读 ' + 免审文本);
      }
      return 差.length ? '没写进去：回读与请求不一致（' + 差.join('；') + '）' : '';
    }

    /**
     * `presence()` **读数对象** → 「失联限制」这个开关现在是什么：`true / false / null`。
     *
     * 为什么不能只读 `读数.失联限制` 就算完：F1 之前 `presence()` **不产出**这个字段
     * （只有 `lost` / `已关闭`），读它只会得到 `undefined` —— 于是表单「初值来自回读」这件事
     * 会**悄悄退回硬编码默认值**，而界面上完全看不出差别。这是"没产出的字段被当成了产出"。
     *
     * 取值顺序：先认 `失联限制`（F1 之后的唯一真源），缺了就**从 `已关闭` 推**：
     * `已关闭 === true` ⇒ 关（`false`）；`已关闭 === false` ⇒ 开（`true`）。
     * 两个都没有 ⇒ `null`（**不许**猜成"开"：查不到 ≠ 放行）。
     */
    function 开关态Of(读数) {
      var box = obj(读数);
      if (!box) return null;
      var 直给 = boolOf(box.失联限制);
      if (直给 !== null) return 直给;
      var 已关闭 = boolOf(box.已关闭);
      if (已关闭 !== null) return !已关闭;
      return null;
    }

    /** 开关态 → 给人看的字 + 来源。`null` 一律「未知」，绝不画成「开」。 */
    function 开关文本(读数) {
      var 态 = 开关态Of(读数);
      return (态 === false ? '关（不判定失联）' : 态 === true ? '开' : '未知')
        + '（' + line(obj(读数) && 读数.失联限制来源, '未知') + '）';
    }

    /**
     * `presence()` **读数对象** → 一句给设置页看的附注：开关 / 生效期限 / 来源 / 坏值。
     *
     * ⚠️ 别拿看板那三个函数（`失联详情Of` / `失联附注` / `失联详情提示`）来这里用：
     * 它们吃的是**工作台投影**的 `状态条.失联详情`（字段是 `生效响应期限小时` / `来源…`，
     * 且带"缺失"那套占位），与 `presence()` 的读数**不是同一个东西**（那边没有 `失联限制` 这个布尔）。
     * 混用会静默读出「未知」——Batch 4b 的 F2 就是同款错法（对象喂给了吃字符串的函数）。
     */
    function 读数附注(读数) {
      var box = obj(读数);
      if (!box) return '';
      var 态 = 读数对象四态(box);
      var 段 = [
        '失联保险 ' + (开关态Of(box) === false ? '关' : 开关态Of(box) === true ? '开' : '未知'),
        '生效期限 ' + (numOf(box.生效响应期限小时) === null ? '—' : numOf(box.生效响应期限小时) + ' 小时'),
      ];
      if (line(box.响应期限小时来源, '')) 段.push('期限来自 ' + line(box.响应期限小时来源, '未知'));
      if (line(box.失联限制来源, '')) 段.push('开关来自 ' + line(box.失联限制来源, '未知'));
      段.push('当前 ' + 态);
      if (boolOf(box.值不合法) === true) {
        段.push('⚠ 值不合法：原值 ' + JSON.stringify(box.原值 === undefined ? null : box.原值) + '，已退回兜底');
      }
      return 段.join(' · ');
    }

    /**
     * 内部错误串 → **用户能读的一句人话**。
     *
     * 为什么必须过一道：错误串是给**排障**写的（里面是 fetch 路由、函数名、`JSON.parse`
     * 这类实现细节），而设置页是给**主人**看的。
     * 把排障原文直接印上去，等于让用户读我们的栈 —— 主人截图上那句就是这个问题。
     *
     * 认不出原样时**不吞**：先看这句原文是不是**本来就面向人**的（宿主拒绝理由就是这种，
     * 例如 `小时 只接受 ≥1 的整数：收到 "0"。`、`策略引擎不健康`）——是就原样带出来；
     * 只有当原文带**实现痕迹**（`remote.` / `execute` / `JSON` / 函数名这类）时，才用一句人话兜住。
     * 这条映射只改**措辞**，不改判定：拿不到就是拿不到。
     */
    function 用户向原因(原始) {
      var s = line(原始, '');
      if (s === '') return '这一页需要一个打开的会话才能读写设置。';
      if (s.indexOf('定位不到会话') >= 0) return '这一页需要一个打开的会话才能读写设置。';
      if (s.indexOf('宿主命令服务不可用') >= 0) return '这一页需要一个打开的会话才能读写设置。';
      if (s.indexOf('读取 remote 服务失败') >= 0) return '这一页需要一个打开的会话才能读写设置。';
      // ⚠️ 「超时」必须排在「命令失败」**前面**：超时错误也是被 `命令失败：…` 那层包出来的，
      //    放在后面就永远轮不到它 —— 诊断信息会被那句泛泛的"通信失败"吃掉，
      //    而这行诊断正是**下一张真机截图唯一能定位的东西**（Batch 6 的教训）。
      if (s.indexOf('超时') >= 0) {
        var 尾巴 = s.replace(/^.*?超时[:：]\s*/, '');
        return '未接入：读设置超时（' + 尾巴 + '）';
      }
      if (s.indexOf('命令调用抛错') >= 0) return '与宿主通信失败，设置暂时读写不了。';
      if (s.indexOf('命令失败') >= 0) return '与宿主通信失败，设置暂时读写不了。';
      if (s.indexOf('不是 JSON') >= 0 || s.indexOf('无法识别') >= 0) return '读到的设置无法解析，暂时按未知处理。';
      if (s.indexOf('没有「读数」字段') >= 0) return '读到的设置不完整，暂时按未知处理。';
      if (s.indexOf('解析返回体失败') >= 0) return '读到的设置无法解析，暂时按未知处理。';
      // 剩下的是宿主/会话直接给的话（拒绝理由、门禁拒绝…）：只要不带实现痕迹就原样给人。
      if (!/remote\.|execute|JSON|undefined|null|function|\{\}/.test(s)) return s;
      return '这一页需要一个打开的会话才能读写设置。';
    }

    /** 读数 → 一行「这台机器现在是什么样」：生效值 + 来源 + 坏值标记。 */
    function 生效读数行(读数) {
      // 这里收的也是**读数对象** ⇒ 同样走 `读数对象四态`（原来喂给 `失联态Of` 是错的：
      // 那个只认四个字符串，于是这一行永远印「当前 未知」）。
      var 态 = 读数对象四态(读数);
      var 段 = [
        '失联限制 ' + 开关文本(读数),
        '生效期限 ' + (numOf(读数.生效响应期限小时) === null ? '—' : numOf(读数.生效响应期限小时) + 'h')
          + '（' + line(读数.响应期限小时来源, '未知') + '）',
        '当前 ' + 态,
      ];
      if (boolOf(读数.值不合法) === true) 段.push('⚠ 值不合法：原值 ' + JSON.stringify(读数.原值 === undefined ? null : 读数.原值));
      return 段.join(' · ');
    }

    // ── 模块级 store + 轮询器（Batch 7：**取数不许挂在 useEffect 上**）───────────
    /**
     * 为什么要有这一层（这是真机"页面永远不动"的根因）：
     *
     * 真机实测：设置页与看板面板**都停在初始态**（`正在读取设置…` / 右上「读取中」、底部 `会话 —`）；
     * 而**点「保存」按钮能让它变「保存中…」** ⇒ `useState`（含 setter 与重渲染）是**好的**，
     * 坏的只有 `useEffect` —— 这个宿主给插件的 React 里它**很可能是空实现**。
     * 同机**真机跑通**的另一插件全文**一个 `useEffect` 都没有**，只用 `useState` +
     * 裸 `setInterval` 轮询 —— 照它来。
     *
     * 于是分工钉死：
     *  · **出数据**：`apply` 里起的裸 `setInterval` 轮询（立刻拉一次 + 每 3 秒）→ 写进下面的 store；
     *  · **渲染**：组件 `useState` 订阅 store，store 一变就 `setState` ⇒ 重渲染；
     *  · **`useEffect` 只是增强**（挂载后立刻再拉一次）：它不跑，数据照样有。
     *
     * store 是模块级的（不是组件 state）：`apply` 只跑一次、组件可多次挂载，
     * 让"只有一个轮询器"和"组件随时订阅"两件事同时成立。
     */
    var 调度页已访问 = false;
    var 调度store = { 快照: { phase: 'reading', data: null, error: '' }, 订阅者: [] };
    var 人设页已访问 = false;
    var 人设store = { 快照: { phase: 'reading', data: null, error: '' }, 订阅者: [] };
    var 信息页已访问 = false;
    var 信息参数 = { offset: 0, query: '' };
    var 信息请求序 = 0;
    var 信息最近读取 = 0;
    var 信息store = { 快照: { phase: 'reading', data: null, error: '' }, 订阅者: [] };
    var 投影store = { 快照: EMPTY, 订阅者: [] };
    var 设置store = { 快照: { phase: 'reading', 读数: null, 设置文件: '', error: '', 保存中: false, 提示: '', 提示调: 'warn' }, 订阅者: [] };
    /** 待批准清单（v2 条目14/17）：状态机投影由域服务给，前端只读、只发批准/拒绝/撤销。 */
    /**
     * 会审折叠态（优化批③）：看板唯一的 UI 状态——照 `投影store` 同款「模块级 store + 组件订阅」，
     * **不挂 useEffect**（设计债⑩：这个宿主给插件的 effect 可能是空实现，取数如此，UI 状态也如此）。
     * `折叠会审` 是覆盖表（id → 折不折）；没点过的场次走默认（首场展开、其余折叠）。
     */
    var 界面store = { 快照: { 折叠会审: null, 折叠描述: null, 折叠总线: null, 项目选择: null, 自动选择: null, 当前页: null, 图谱选中: null, 图谱视图: null, 审计展开: null }, 订阅者: [] };
    /** 轮询间隔：2~5 秒量级（人看的板子，又不至于把宿主问烦）。 */
    var POLL_MS = 3000;
    /** 轮询把手：`apply` 起、disposer 清（**不许留定时器**）。 */
    var 轮询把手 = { timer: null, 停了: true, 通知: null };

    function 发通知(store, 快照) {
      store.快照 = 快照;
      for (var i = 0; i < store.订阅者.length; i += 1) {
        try { store.订阅者[i](快照); } catch (error) { /* 单个订阅者坏掉不影响别的 */ }
      }
    }

    /**
     * 轮询序号（W3 批3·2026-10-09）：**慢响应后到不许盖新快照**。
     *
     * 为什么必须有：轮询是「发起—等待—写 store」，而等待时长不固定（宿主忙、网络慢、
     * 第一次请求卡住）。两次请求重叠时，**先发的后到**会把 store 写回旧读数 ——
     * 面板上显示的时间比实际更早，而"看起来正常"的旧读数正是最难发现的错（§3.6 静默失效）。
     * 规则：每次发起占一个递增号，响应回来时号比**已应用**的小就整条丢掉（连 resolve 都照走，
     * 只是不写 store）。
     */
    function 序号器() {
      var 发出 = 0;
      var 已用 = 0;
      return {
        取号: function () { 发出 += 1; return 发出; },
        该用: function (号) { if (号 < 已用) return false; 已用 = 号; return true; },
      };
    }
    var 投影序号 = 序号器();
    var 设置序号 = 序号器();
    var 调度序号 = 序号器();
    var 人设序号 = 序号器();
    /**
     * 投影变更签名（2026-10-14 审查 P2-23）：轮询 3s 一拍，**数据没变就不重渲染**——
     * 修前每拍都全量 发通知（7 页 reconcile）+ writeCache 大 JSON.stringify，投影变大后
     * 可感知卡顿。签名 = 原始投影的一次序列化（这串本来 writeCache 也要算，只算一次两用）。
     * 序列化失败（环形等）⇒ 退回旧行为（每次都通知），绝不因优化丢画面。
     */
    var 投影签名 = { 值: null };
    /**
     * 写缓存 + 发通知的统一落点（三个 live 分支共用）：返回是否真的通知了。
     * @returns {boolean}
     */
    function 布投影(view, session, 选择, 自动) {
      var 串 = null;
      try { 串 = JSON.stringify(view && view.原始); } catch (error) { 串 = null; }
      if (串 !== null && 串 === 投影签名.值) return false; // 数据没变：整轮重渲染跳过
      if (串 !== null) 投影签名.值 = 串;
      writeCache(view.原始);
      发通知(投影store, {
        phase: 'live', view: view, at: new Date().toISOString(),
        error: '', sessionId: session.id, source: session.source, stale: false,
        项目选择: 选择, 自动选择: 自动,
      });
      return true;
    }
    /** 订阅：**立刻回放当前值**（这样"数据先到、组件后挂载"也能直接显示），返回退订。 */
    function 订阅(store, fn) {
      store.订阅者.push(fn);
      try { fn(store.快照); } catch (error) { /* 首次回放失败不影响订阅本身 */ }
      return function 退订() {
        var at = store.订阅者.indexOf(fn);
        if (at >= 0) store.订阅者.splice(at, 1);
      };
    }
    /**
     * 把 store 清回初始态。
     *
     * 生产里只在 `apply` 开始时叫一次（一个插件实例一份数据）。测试里每次 boot 也会叫：
     * 模块级 store 在**同一次进程**里是活的，不清就会让上一个用例的数据漏到下一个用例
     * （表现是"A 用例的数据出现在 B 用例页面上"——那会污染断言，比缺陷还难查）。
     */
    function 清空store() {
      调度页已访问 = false;
      调度store.快照 = { phase: 'reading', data: null, error: '' };
      人设页已访问 = false;
      人设store.快照 = { phase: 'reading', data: null, error: '' };
      信息页已访问 = false; 信息请求序 += 1; 信息最近读取 = 0; 信息参数 = { offset: 0, query: '' };
      信息store.快照 = { phase: 'reading', data: null, error: '' };
      投影store.快照 = EMPTY;
      设置store.快照 = { phase: 'reading', 读数: null, 设置文件: '', error: '', 保存中: false, 提示: '', 提示调: 'warn' };
      界面store.快照 = { 折叠会审: null, 折叠描述: null, 折叠总线: null, 项目选择: null, 自动选择: null, 当前页: null, 图谱选中: null, 图谱视图: null, 审计展开: null };
    }

    /**
     * 这一场会审现在折不折。没点过（覆盖表里没有）就走默认：首场展开、其余折叠。
     * 原型链键照 ② 徽章色查表的口径用 hasOwnProperty 挡掉——`constructor` 之类的继承属性
     * 不许被当成「点过」。
     * @param {string} id 会审节点 id
     * @param {boolean} 默认折叠 这一场没被点过时该有的态（渲染序 ≠ 0）
     * @returns {boolean} 当前是否折叠
     */
    function 会审折叠(id, 默认折叠) {
      var 表 = 界面store.快照.折叠会审;
      return 表 && Object.prototype.hasOwnProperty.call(表, id) ? !!表[id] : 默认折叠;
    }

    /**
     * 点了一下切换钮：把这一场的态写进覆盖表（取反当前生效值）并广播重渲染。
     * @param {string} id 会审节点 id
     * @param {boolean} 默认折叠 同 {@link 会审折叠}
     */
    function 切会审折叠(id, 默认折叠) {
      var 下 = {};
      var 表 = 界面store.快照.折叠会审;
      if (表) for (var k in 表) if (Object.prototype.hasOwnProperty.call(表, k)) 下[k] = 表[k];
      下[id] = !会审折叠(id, 默认折叠);
      // 整表替换会把 项目选择 一起抹掉（同一个 store），所以用 `Object.assign` 合并。
      发通知(界面store, Object.assign({}, 界面store.快照, { 折叠会审: 下 }));
    }

    // ── 分页状态（2026-10-13 重做）────────────────────────────────────────────
    /**
     * 七页的 id 与标签（**顺序＝注意力顺序**，与 {@link 页清单} 同源：这里只判合法值）。
     * 这个数组只服务「值合法吗」，标签与计数由 `页清单(ctx)` 给。
     */
    var 合法页 = { overview: 1, graph: 1, tasks: 1, reviews: 1, bus: 1, audit: 1, monitor: 1, memory: 1 };

    /** 当前页：**非法值一律落回总览**——切页状态坏掉不许把整块面板画没。 */
    function 当前页() {
      var 值 = 界面store.快照.当前页;
      return 合法页[值] === 1 ? 值 : 'overview';
    }

    /**
     * 当前页的中文名（页头 h1 用）。
     *
     * 照设计稿 v2.1 的 `.topbar`：页头标题是**当前页名**（"总览"/"图谱"/…），
     * 不是固定的产品名——产品名留在侧栏品牌位（`导航()` 里那份）。
     *
     * ⚠️ **绝不许调 `页清单(ctx)`**（2026-10-14 真机事故，**整块面板空白**）：
     *   `页清单()` 读的是 `ctx.tasks / ctx.会审 / ctx.总线 / ctx.记忆` —— 那是
     *   **「页上下文」**，只在 `分页外壳(children, {…})` 那一个调用点现场造出来；
     *   而页头所在的 `Dashboard` 里 `ctx = activeCtx` 是**宿主 ctx**，两者**不是同一个东西**。
     *   更致命的是：**宿主 ctx 在真机的某些渲染时机下是 `null`** ⇒ `页清单(null)` 里
     *   `null.tasks` 抛 TypeError ⇒ React 整棵树卸载 ⇒ 面板全空。
     *   harness 与本地预览都抓不到这一条，因为那两个环境里 `apply()` 一定先跑、
     *   `activeCtx` 永不为 null —— **装置绿 ≠ 真机活**（本会话第二次栽在这一条上）。
     *   ⇒ 页名**只需页 id**，用一张静态表；不碰任何上下文，就不可能因上下文而抛。
     * @returns {string}
     */
    function 当前页名() {
      var 表 = {
        overview: '总览', graph: '图谱', tasks: '任务', reviews: '会审',
        bus: '总线', audit: '审计', monitor: '阻塞反馈', memory: '记忆',
      };
      return 表[当前页()] || '总览';
    }

    /**
     * 切页：**纯显示动作**（零请求、零写账），与折叠钮同类。
     * 同一个 store 里还有 项目选择 / 各种折叠表，所以整表替换必须走 `Object.assign` 合并。
     */
    function 切页(id) {
      if (合法页[id] !== 1 || 当前页() === id) return;
      发通知(界面store, Object.assign({}, 界面store.快照, { 当前页: id }));
    }

    /** 图谱里当前选中的节点键（`角色:<id>` / `能力:<id>`）；没选 ⇒ `null`。 */
    function 图谱选中() {
      var 值 = 界面store.快照.图谱选中;
      return typeof 值 === 'string' && 值 !== '' ? 值 : null;
    }

    /**
     * 审计流是否**展开全部**（2026-10-13 晚）。
     *
     * 背景：审计流此前靠**卡内滚动框**（`max-height + overflow-y:auto`）把二十行装进一个小盒子里。
     * 那是"五个分区堆一页"时代的产物；现在审计**自成一页**、根容器本来就是滚动容器 ⇒
     * 卡内再套一个滚动容器就是**双层滚动条**（滚轮在框里框外行为还不一样），而且内容被压在框里看不见。
     * 现在：行**直接进页面流**，超出 `AUDIT_LIMIT` 的由这个钮铺开（纯显示、零请求），
     * 并且**照旧明说**「投影共 N 条 · 已列 M 条」（不静默截断这条纪律一个字没动）。
     */
    function 审计展开() {
      return 界面store.快照.审计展开 === true;
    }

    /** 点「展开全部审计」：纯显示动作（零请求、零写账）。 */
    function 切审计展开() {
      发通知(界面store, Object.assign({}, 界面store.快照, { 审计展开: !审计展开() }));
    }

    /**
     * 点图谱里的一个节点：选中它（再点同一个 ⇒ 取消）。
     *
     * 与折叠钮、切页同款：**纯显示动作**（零请求、零写账）。选中态只改一件事——
     * 把无关节点/边调暗 + 开一张详情卡，让「这个岗位到底接了哪几张卡」不必来回对照两列。
     */
    function 切图谱选中(key) {
      if (typeof key !== 'string' || key === '') return;
      发通知(界面store, Object.assign({}, 界面store.快照, { 图谱选中: 图谱选中() === key ? null : key }));
    }

    /**
     * 点图谱**空白处** ⇒ 取消选中（2026-10-13 晚，主权者提的交互缺口）。
     *
     * 实现走**空白层**（铺满画布的不可见 `<rect>`，垫在所有节点下面），不靠事件冒泡：
     *  - SVG 里后画的元素在上层，点节点命中的是节点、点空白命中的才是这层；
     *  - 于是「点节点」与「点空白」是两个互不干扰的处理器，不必依赖 stopPropagation，
     *    也不必赌宿主把事件对象传成什么形状（本仓的渲染层只保证 `onClick()` 被调到）。
     */
    function 清图谱选中() {
      if (!图谱选中()) return;
      发通知(界面store, Object.assign({}, 界面store.快照, { 图谱选中: null }));
    }

    // ── 图谱缩放/平移（2026-10-14 · 主权者：「能把图谱做成可放大缩小平移的吗」）──────
    //
    // 为什么**不加按钮**：面板是 §9 只读投影，可点面有**白名单**（`dshmind-btn` /
    // `dshmind-toggle` / `dshmind-projChip` / `dshmind-descToggle`），harness 逐类枚举，
    // **多一类就算破规**。而缩放/平移本来就**不是"控件"**，是**看图的指针手势**——
    // 用滚轮 / 拖拽 / 双击实现，一个按钮都不新增，白名单原样不动。
    //
    // 状态住 `界面store`（与 `图谱选中` 同款：模块级、订阅式、**不挂 useEffect**——
    // 宿主给插件的 effect 可能是空实现，设计债⑩）。
    //
    // 坐标系：`null` = 未动过 ⇒ 用基础 viewBox（`0 0 宽 高`，即"整图刚好装下"）。
    // 一旦动过就存 `{k, x, y}`：`k` 是缩放倍率，`x/y` 是 viewBox 左上角。
    // viewBox 写成 `x y 宽/k 高/k` ⇒ 放大 k 倍、平移到 x/y。
    /** 当前图谱视图；没动过（或值坏）时返回 null（＝基础整图）。 */
    function 图谱视图() {
      var v = 界面store.快照.图谱视图;
      return v && typeof v.k === 'number' && isFinite(v.k) && v.k > 0 ? v : null;
    }
    /** 写图谱视图（纯显示、零请求）。传 null ＝复位成整图。 */
    function 设图谱视图(v) {
      发通知(界面store, Object.assign({}, 界面store.快照, { 图谱视图: v }));
    }
    /** 缩放上下限：太小看不清、太大易迷失。 */
    var 图谱最小K = 0.5;
    var 图谱最大K = 8;
    /** 拖拽会话（模块级瞬时量，**不进 store**：它每帧都变，进 store 会把订阅者吵死）。 */
    var 拖拽中 = null;
    /** 上一次拖拽的位移（px）：用来抑制"拖完顺带触发一次 click"的误触。 */
    var 上次拖拽位移 = 0;

    /**
     * 把鼠标位置换算成**基础坐标系**里的点（与 viewBox 同单位）。
     * `rect` 由调用方给（真实 DOM 有 `getBoundingClientRect`；无 DOM 的环境拿不到 ⇒ 返回 null，
     * 那时所有手势都安静地不生效，绝不抛）。
     */
    function 基础坐标(e, 视图, 基础宽, 基础高) {
      var el = e && e.currentTarget;
      if (!el || typeof el.getBoundingClientRect !== 'function') return null;
      var r = el.getBoundingClientRect();
      if (!r || !r.width || !r.height) return null;
      var k = 视图 ? 视图.k : 1;
      var 视角宽 = 基础宽 / k;
      var 视角高 = 基础高 / k;
      return {
        x: (视图 ? 视图.x : 0) + ((e.clientX - r.left) / r.width) * 视角宽,
        y: (视图 ? 视图.y : 0) + ((e.clientY - r.top) / r.height) * 视角高,
        fx: (e.clientX - r.left) / r.width,
        fy: (e.clientY - r.top) / r.height,
        rect: r,
      };
    }

    /**
     * 图谱的指针手势集（纯显示、零请求）。返回可直接摊进 `h('svg', {...})` 的一组 props。
     * @param {number} 基础宽 基础 viewBox 宽
     * @param {number} 基础高 基础 viewBox 高
     */
    function 图谱手势(基础宽, 基础高) {
      // 滚轮缩放本体（2026-10-14 审查 P1-11）：React 17+ 把 wheel 注册成根节点 passive
      // 监听——写在 onWheel 里的 preventDefault 是 no-op（缩放与整页滚动**同时**发生，
      // 注释宣称的行为与实际相反）。改走 ref 回调对 svg 原生节点挂 {passive:false} 监听；
      // harness 无 DOM 环境 ref 不会被调，安静不生效。
      function 缩放(e) {
        // 阻止整页跟着滚：在图上滚就该缩放，而不是把面板滚走。
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        if (!e) return;
        var 当前 = 图谱视图() || { k: 1, x: 0, y: 0 };
        var 因子 = (e.deltaY || 0) < 0 ? 1.18 : 1 / 1.18;
        var 新k = Math.min(图谱最大K, Math.max(图谱最小K, 当前.k * 因子));
        if (新k === 当前.k) return;
        var p = 基础坐标(e, 当前, 基础宽, 基础高);
        if (!p) return;
        // 让指针底下那个点**留在原地**（否则缩放会"跑偏"，这是缩放体验的关键）。
        var 新视角宽 = 基础宽 / 新k;
        var 新视角高 = 基础高 / 新k;
        设图谱视图({ k: 新k, x: p.x - p.fx * 新视角宽, y: p.y - p.fy * 新视角高 });
      }
      return {
        ref: function (el) {
          if (!el || typeof el.addEventListener !== 'function') return; // 卸载（null）与无 DOM 都安静跳过
          if (el.__dshmindWheel) el.removeEventListener('wheel', el.__dshmindWheel); // 重渲染先摘旧（ref 每次渲染换新闭包）
          el.__dshmindWheel = 缩放;
          el.addEventListener('wheel', 缩放, { passive: false });
        },
        onMouseDown: function (e) {
          if (!e || (e.button !== undefined && e.button !== 0)) return; // 只认左键
          var 当前 = 图谱视图() || { k: 1, x: 0, y: 0 };
          var p = 基础坐标(e, 当前, 基础宽, 基础高);
          if (!p) return;
          拖拽中 = { 起X: e.clientX, 起Y: e.clientY, 视图: 当前, rect: p.rect, 位移: 0 };
        },
        onMouseMove: function (e) {
          if (!拖拽中 || !e) return;
          var dx = e.clientX - 拖拽中.起X;
          var dy = e.clientY - 拖拽中.起Y;
          拖拽中.位移 = Math.abs(dx) + Math.abs(dy);
          var 视角宽 = 基础宽 / 拖拽中.视图.k;
          var 视角高 = 基础高 / 拖拽中.视图.k;
          设图谱视图({
            k: 拖拽中.视图.k,
            x: 拖拽中.视图.x - (dx / 拖拽中.rect.width) * 视角宽,
            y: 拖拽中.视图.y - (dy / 拖拽中.rect.height) * 视角高,
          });
        },
        onMouseUp: function () {
          if (拖拽中) 上次拖拽位移 = 拖拽中.位移;
          拖拽中 = null;
        },
        onMouseLeave: function () {
          // 拖出画布就结束这次拖拽（否则回来时会"粘住"）。
          if (拖拽中) 上次拖拽位移 = 拖拽中.位移;
          拖拽中 = null;
        },
        onDoubleClick: function () { 设图谱视图(null); }, // 双击复位成整图
      };
    }

    /**
     * 这次 click 是不是"拖拽的尾巴"。
     * 拖完手一松，浏览器还会照常发一次 click ⇒ 会把刚拖到的位置顺手取消选中/换选中，很恼人。
     * 判据：本次拖拽位移超过 4px 就吃掉这一次 click（真点击的位移通常是 0）。
     */
    function 拖拽尾巴() {
      if (上次拖拽位移 > 4) { 上次拖拽位移 = 0; return true; }
      上次拖拽位移 = 0;
      return false;
    }

    /**
     * 总线某一处折叠态（2026-10-12，主权者指令「（总线）也默认收起呗」）。
     *
     * 一处折叠 = 一个 `key`（如 `线程:task-1终审` / `消息:task-1终审` / `正文:task-1终审#3`）。
     * 默认**折叠**（true）：总线的线程/消息/长正文都默认只给预览，点钮才铺开——这样
     * 「数据全都在」与「面板不被撑爆」两件事同时成立，不再靠静默截断。
     * @param {string} key 折叠点标识
     * @returns {boolean} 当前是否折叠（未点过 ⇒ true）
     */
    function 总线折叠(key) {
      var 表 = 界面store.快照.折叠总线;
      return 表 && Object.prototype.hasOwnProperty.call(表, key) ? !!表[key] : true;
    }

    /**
     * 点了一下总线的某个折叠钮：取反并入表、广播重渲染（纯显示、零请求）。
     * @param {string} key 折叠点标识，同 {@link 总线折叠}
     */
    function 切总线折叠(key) {
      var 下 = {};
      var 表 = 界面store.快照.折叠总线;
      if (表) for (var k in 表) if (Object.prototype.hasOwnProperty.call(表, k)) 下[k] = 表[k];
      下[key] = !总线折叠(key);
      发通知(界面store, Object.assign({}, 界面store.快照, { 折叠总线: 下 }));
    }

    /**
     * 这一张卡的长描述现在折不折（2026-10-12，主权者指令「要全文 + 默认折叠」）。
     *
     * 为什么需要它：`描述` 是**全量长文本**（实测 2037 字 / 40 换行），而它住在卡片
     * 标题位（任务图 `描述||标题||id`、会审 `描述||节点`，同源）。硬截断（line-clamp）
     * 会把全文丢掉、要看只能 hover；改成**默认折叠 + 可展开**：默认收起省版面，
     * 想读全文点一下就在原地铺开，不丢一个字、也不新增写动作。
     *
     * 默认**折叠**（与「独立答案」首场展开不同）：描述通常几千字，全铺开正是本次
     * 要治的「密排」；且它出现在每一张卡上，逐张展开是有意为之的动作。
     * 原型链键照 {@link 会审折叠} 同款用 hasOwnProperty 挡（`constructor` 不算点过）。
     * @param {string} id 卡片所属节点 id
     * @returns {boolean} 当前是否折叠（默认 true）
     */
    function 描述折叠(id) {
      var 表 = 界面store.快照.折叠描述;
      return 表 && Object.prototype.hasOwnProperty.call(表, id) ? !!表[id] : true;
    }

    /**
     * 点了一下「展开全文」：把这张卡的态写进覆盖表并广播重渲染（纯显示、零请求）。
     * @param {string} id 卡片所属节点 id
     */
    function 切描述折叠(id) {
      var 下 = {};
      var 表 = 界面store.快照.折叠描述;
      if (表) for (var k in 表) if (Object.prototype.hasOwnProperty.call(表, k)) 下[k] = 表[k];
      下[id] = !描述折叠(id);
      发通知(界面store, Object.assign({}, 界面store.快照, { 折叠描述: 下 }));
    }

    /**
     * 用户显式选过的项目键（2026-10-11，主权者指令「修」）。
     *
     * `null` = 没选过 ⇒ 走宿主默认项目（或"默认项目无活动时按最近活动自动选"）。
     * 为什么要有这一格：面板的 `?project=` 只有客户端能带，而项目键只有用户知道
     * （面板拿不到会话工作目录）；没有它，主人就只能看着默认项目的空账本。
     * @returns {string|null}
     */
    function 项目选择() {
      return line(界面store.快照.项目选择, '') || null;
    }

    /** 点了一个项目 chip：记住它，下一次取数就带 `?project=`。**不写任何账**（纯显示动作）。 */
    function 切项目(项目键) {
      发通知(界面store, Object.assign({}, 界面store.快照, { 项目选择: line(项目键, '') || null, 自动选择: null }));
    }

    /**
     * 自动项目选择：**当前项目无任务、也无总线线程**，而清单里另有有活动的项目 ⇒ 取最近活动那个。
     *
     * 为什么允许自动选：主人的真机症状是「面板永远一片空白」——组织所有活都在别的项目下，
     * 而面板的默认项目是空账。默认空账 + 别处有账时，显示空账不是"忠实"，是误导。
     * 纪律：**绝不静默** —— 自动选出来的项目必须在页头明写「已按最近活动自动选择」，
     * 且用户点过任何 chip 之后这条路彻底关闭（`项目选择()` 非 null 时不再自动）。
     * @param {object|null} view 归一化后的投影
     * @returns {string|null} 要切的另一个项目键；不需要切就 null
     */
    function 自动选项目(view) {
      var 清单 = view && view.项目清单;
      if (!清单 || !清单.项 || !清单.项.length) return null;
      var 当前行 = null;
      for (var i = 0; i < 清单.项.length; i += 1) if (清单.项[i].项目 === view.项目) 当前行 = 清单.项[i];
      var 当前有活动 = !!当前行 && (当前行.任务 > 0 || 当前行.线程 > 0);
      if (当前有活动) return null;
      for (var j = 0; j < 清单.项.length; j += 1) {
        if (清单.项[j].任务 > 0 || 清单.项[j].线程 > 0) return 清单.项[j].项目;
      }
      return null;
    }
    /** 组件用它接 store：`useState` + 订阅（不依赖 `useEffect`）。 */
    function useStore(store) {
      var box = useState(store.快照);
      var 值 = box[0];
      var 设值 = box[1];
      useEffect(function () {
        // 有 effect 就在这里退订（干净）；没有 effect 也不影响取值 ——
        // 退订只在"组件卸载后 store 还在推"时才有意义，代价是几次多余 setState，可接受。
        return 订阅(store, 设值);
      }, []);
      // 「重复订阅」核实（W3 批3·2026-10-09）：两条路**互斥**，不是重复订阅 ——
      //   · 走上面那条：`React.useEffect` 是个函数（真跑）⇒ `缺失的钩子` 里没有 'useEffect'
      //     ⇒ 这里不订阅；
      //   · 走这里：`React.useEffect` 不是函数 ⇒ `hook()` 已把 'useEffect' 记进 `缺失的钩子`，
      //     而退化的 `useEffect` 是空实现（`function () {}`）⇒ 上面那个回调**根本不会执行**。
      // 但「互斥」只挡住两条路之间——**降级路径内部**每次渲染都会再 push 一个新订阅
      // （2026-10-12 评审 P1-11）：store 是模块级、随插件常驻，订阅数组随渲染次数线性涨，
      // 每次发通知都要扫一遍越来越长的表（里头全是同一组件的旧 setter）。
      // 判重的支点：真实 React 的 setState **身份稳定**（同一组件实例恒为同一函数）。
      if (缺失的钩子.indexOf('useEffect') >= 0 && 缺失的钩子.indexOf('useState') < 0) {
        // effect 不跑 ⇒ 没人订阅 ⇒ 值永远是订阅那一刻的快照。这里补一次同步订阅兜住。
        // useState 也缺 ⇒ 设值是每渲染一个新 noop：订阅它纯属泄漏，不如不订
        // （页面本来就是静态兜底，假订阅只涨内存不涨正确性）。
        if (store.订阅者.indexOf(设值) < 0) {
          try { 订阅(store, 设值); } catch (error) { /* 订阅不上就算了：至少初次回放拿到了当前值 */ }
        }
      }
      return 值;
    }

    /** 拉一次工作台投影并写进 store（失败保留旧快照，只是标 stale）。 */
    function 刷新投影() {
      var ctx = activeCtx;
      var 号 = 投影序号.取号();
      return new Promise(function (resolve) {
        var session = { id: '', source: '' };
        try { session = resolveSessionId(ctx); } catch (error) { session = { id: '', source: '' }; }
        if (!session.id) {
          var cached = readCache();
          投影签名.值 = null; // 会话丢失后复位签名：会话回来时数据没变也要把 nosession 翻回 live
          if (投影序号.该用(号)) {
            发通知(投影store, {
              phase: 'nosession', view: cached ? normalizeView(cached.view) : null, at: cached ? cached.at : '',
              error: '', sessionId: '', source: '', stale: !!cached,
            });
          }
          resolve();
          return;
        }
        var 选择 = 项目选择();
        fetchView(ctx, session.id, 选择).then(function (out) {
          if (!投影序号.该用(号)) { resolve(); return; } // 旧响应：丢掉，不覆盖更新的快照
          if (out.ok) {
            // 自动项目选择（2026-10-11，主权者指令「修」）：没点过任何 chip、且当前项目是空账
            //而别处有账 ⇒ 重取一次。**不静默**：快照里带上 `自动选择`，页头据此明写。
            var 自动 = 选择 ? null : 自动选项目(out.view);
            if (自动 && 自动 !== out.view.项目) {
              fetchView(ctx, session.id, 自动).then(function (二次) {
                if (!投影序号.该用(号)) { resolve(); return; }
                if (二次.ok) {
                  布投影(二次.view, session, 选择, 自动);
                  resolve();
                  return;
                }
                // 自动那一次失败：回落到默认项目的读数（宁可显示"确认过的空账"，不显示一张坏快照）。
                布投影(out.view, session, 选择, null);
                resolve();
              }, function () {
                if (!投影序号.该用(号)) { resolve(); return; }
                投影签名.值 = null; // 出错后复位签名：恢复时哪怕数据没变也必须通知（把 error 态翻回 live）
                发通知(投影store, Object.assign({}, 投影store.快照, {
                  phase: 'error', error: '切项目取数失败：' + 自动,
                }));
                resolve();
              });
              return;
            }
            布投影(out.view, session, 选择, null);
            resolve();
            return;
          }
          var last = readCache();
          投影签名.值 = null; // 出错复位签名（同上）：恢复后不许因「数据没变」跳过通知
          发通知(投影store, {
            phase: 'error', view: last ? normalizeView(last.view) : null, at: last ? last.at: '',
            error: out.error, sessionId: session.id, source: session.source, stale: !!last,
          });
          resolve();
        }, function (error) {
          if (!投影序号.该用(号)) { resolve(); return; }
          投影签名.值 = null; // 出错复位签名（同上）
          发通知(投影store, Object.assign({}, 投影store.快照, {
            phase: 'error', error: '工作台投影不可用：' + line(error && error.message, String(error)),
          }));
          resolve();
        });
      });
    }

    /** 拉一次设置读数并写进 store。**保留** `保存中 / 提示`（那是交互状态，不该被轮询抹掉）。 */
    function 刷新设置() {
      var ctx = activeCtx;
      var 号 = 设置序号.取号(); // 与投影同一个道理：慢响应后到不许盖新读数（含"保存后的回读"）
      return new Promise(function (resolve) {
        var session = { id: '', source: '' };
        try { session = resolveSessionId(ctx); } catch (error) { session = { id: '', source: '' }; }
        var 旧 = 设置store.快照;
        if (!session.id) {
          if (设置序号.该用(号)) {
            发通知(设置store, Object.assign({}, 旧, {
              phase: 'nosession', 读数: null, 设置文件: '', error: '定位不到会话 id，无法读取设置',
            }));
          }
          resolve();
          return;
        }
        readPresence(ctx, session.id).then(function (out) {
          if (!设置序号.该用(号)) { resolve(); return; }
          if (!out.ok) {
            发通知(设置store, Object.assign({}, 旧, {
              phase: 'error', 读数: null, error: out.error,
            }));
            resolve();
            return;
          }
          发通知(设置store, Object.assign({}, 旧, {
            phase: 'live', 读数: out.读数, 设置文件: out.设置文件, error: '',
          }));
          resolve();
        }, function (error) {
          if (!设置序号.该用(号)) { resolve(); return; }
          发通知(设置store, Object.assign({}, 旧, {
            phase: 'error', 读数: null, error: '读设置失败：' + line(error && error.message, String(error)),
          }));
          resolve();
        });
      });
    }

    /** 官方根席位只从实际可见引用取会话：主视图mainView、嵌入侧聊sidebarChat；不把后台持有者当正在看的会话。 */
    /** A small authenticated feedback surface. POST is confirmed by a fresh independent GET. */
    function 知识复用概览(reuse) {
      if (!reuse) return null;
      var counts = obj(reuse.汇总) || {};
      var dispositions = obj(reuse.处置汇总);
      var known = function (value) { return typeof value === 'number' ? String(value) : '未知'; };
      return h('section', { 'data-dshmind': 'knowledge-reuse' }, [
        h('h3', { key: 'h' }, '知识采用反馈'),
        reuse.健康 !== '可用' ? h('p', { key: 'error' }, '知识采用记录不可读，当前反馈未知。')
          : h('p', { key: 'counts' }, '交卷记录 ' + known(counts.交卷记录) + '；未说明 ' + known(counts.未说明) + '；显式空 ' + known(counts.显式空) + '；有声明 ' + known(counts.有声明)),
        reuse.健康 === '可用' ? h('p', { key: 'feedback' }, '采用声明条目 ' + known(counts.声明条目) + '；有帮助声明 ' + known(counts.有帮助声明) + '；不适用声明 ' + known(counts.不适用声明) + '；问题声明 ' + known(counts.问题声明) + '；当前来源可核 ' + known(counts.来源可核) + '；关联采纳交卷 ' + known(counts.关联采纳交卷)) : null,
        reuse.健康 === '可用' && dispositions ? h('p', { key: 'dispositions' }, '负反馈条目 ' + known(dispositions.负反馈条目) + '；已见关联处置 ' + known(dispositions.已见关联处置) + '；未见关联处置 ' + known(dispositions.未见关联处置) + '；处置不可核对 ' + known(dispositions.处置不可核对)) : null,
        dispositions ? h('p', { key: 'disposition-scope' }, '只核对明确引用本次负反馈的失效、降权或替代记录；已见关联不证明问题已解决，未见不证明尚未处理。') : null,
        h('p', { key: 'scope' }, '使用结果由交卷者声明；检索不等于采用，任务采纳不证明知识正确或带来收益。未说明保持未知，不回填零采用。'),
        h('p', { key: 'read', className: 'dshmind-mono' }, 'knowledge_reuse_query 可按任务或知识id分页核对；问题声明作为纠错线索，不自动改写知识状态或排行。'),
      ]);
    }

    function 创建操作概览(operations) {
      if (!operations) return null;
      var counts = obj(operations.汇总) || {};
      return h('section', { 'data-dshmind': 'spawn-operations' }, [
        h('h3', { key: 'h' }, '成员创建恢复记录'),
        operations.健康 !== '可用' ? h('p', { key: 'error' }, '创建操作记录不可读，当前创建结果未知；不要重复创建。')
          : h('p', { key: 'counts' }, '已记录操作 ' + String(counts.操作) + '；未收尾 ' + String(counts.未收尾) + '；已见宿主回执 ' + String(counts.已见宿主回执) + '；创建宏已审计 ' + String(counts.已审计)),
        h('p', { key: 'scope' }, '拟用实例不等于已创建；未收尾不表示正在运行，创建宏已审计不代表成员执行或任务完成。'),
        h('p', { key: 'read', className: 'dshmind-mono' }, 'operation_query 可按任务或操作id核对阶段与问题；缺记录不证明未创建，不自动重放或清零。'),
      ]);
    }

    function 模型用量概览(usage) {
      if (!usage) return null;
      var counts = obj(usage.汇总) || {};
      var tokens = obj(counts.已报告token) || {};
      var coverage = obj(counts.字段覆盖) || {};
      var collection = obj(usage.采集) || {};
      var known = function (value) { return typeof value === 'number' ? String(value) : '未知'; };
      var covered = function (key) { var field = obj(coverage[key]) || {}; return known(field.已知) + ' 已知 / ' + known(field.缺失) + ' 缺失'; };
      return h('section', { 'data-dshmind': 'model-usage' }, [
        h('h3', { key: 'h' }, '模型用量观察'),
        h('p', { key: 'scope' }, '只含已接入观察窗口，不代表项目或目标全部用量。费用未知；用量观察不改变准入额度。'),
        usage.健康 !== '可用' ? h('p', { key: 'error' }, '模型用量记录不可读，当前读数未知。') : h('p', { key: 'counts' }, '已观察尝试 ' + known(counts.尝试) + '；有用量 ' + known(counts.有用量) + '；无用量 ' + known(counts.无用量) + '；未结束 ' + known(counts.未结束) + '；未归因 ' + known(counts.未归因)),
        usage.健康 === '可用' ? h('p', { key: 'tokens' }, '已报告 token：未缓存输入 ' + known(tokens.inputTokens) + '；输出 ' + known(tokens.outputTokens) + '；缓存读 ' + known(tokens.cacheReadTokens) + '；缓存写 ' + known(tokens.cacheWriteTokens) + '；提供方总数 ' + known(tokens.totalTokens)) : null,
        usage.健康 === '可用' ? h('p', { key: 'coverage' }, '字段覆盖（尝试数）：输入 ' + covered('inputTokens') + '；输出 ' + covered('outputTokens') + '；缓存读 ' + covered('cacheReadTokens') + '；缓存写 ' + covered('cacheWriteTokens') + '；总数 ' + covered('totalTokens')) : null,
        collection.enabled === false ? h('p', { key: 'off' }, '模型用量观察已关闭，保留的历史读数不代表当前消耗。') : null,
        collection.attached === false || collection.failedWrites > 0 || collection.invalidFrames > 0 || collection.orphanFrames > 0 || collection.droppedWrites > 0 ? h('p', { key: 'gap' }, '采集存在未接线、丢帧或写入缺口，缺失用量不补零。') : null,
        h('p', { key: 'detail', className: 'dshmind-mono' }, 'usage_query 可分页核对；指定 id 仅看观察开始时已归因的目标。'),
      ]);
    }

    function 目标概览(props) {
      var goals = props.goals;
      if (!goals) return null;
      if (goals.健康 !== '可用') return h('section', { 'data-dshmind': 'goal-summary' }, [
        h('h3', { key: 'h' }, '持续目标'), h('p', { key: 'e' }, '目标记录暂不可读，当前状态未知。'),
      ]);
      return h('section', { 'data-dshmind': 'goal-summary' }, [
        h('h3', { key: 'h' }, '持续目标'),
        h('p', { key: 'count' }, '共 ' + String(goals.总数) + ' 个目标，展示 ' + arr(goals.目标).length + ' 个摘要。'),
        !arr(goals.目标).length ? h('p', { key: 'empty' }, '尚未登记持续目标。') : null,
        arr(goals.目标).map(function (goal) {
          var result = obj(goal.期望结果) || {};
          var next = obj(goal.下一步) || {};
          var waiting = obj(goal.等待原因) || {};
          var progress = obj(goal.任务进展) || {};
          var source = obj(goal.来源声明) || {};
          var budget = obj(goal.预算);
          var nextLabel = goal.状态 === '等待' ? '等待原因：' : goal.状态 === '进行中' ? '下一步：' : '原计划（当前不推进）：';
          var step = goal.状态 === '等待' ? waiting : next;
          return h('article', { key: goal.id, 'data-goal-id': goal.id }, [
            h('h4', { key: 'result' }, String(result.文本 || goal.id) + (result.省略 ? '…（摘要）' : '')),
            h('p', { key: 'state' }, String(goal.状态) + ' · 修订 ' + String(goal.修订)),
            h('p', { key: 'next' }, nextLabel + String(step.文本 || '见目标详情') + (step.省略 ? '…（摘要）' : '')),
            h('p', { key: 'limits' }, '禁用文件工具：' + (arr(goal.禁止工具).join('、') || '无') + '；另有 ' + String(goal.文本约束条数) + ' 条文本约束，使用 goal_query 读取全文。'),
            h('p', { key: 'progress' }, '关联任务 ' + String(progress.关联) + '；已合法采纳 ' + String(progress.合法采纳) + '。任务进度不代表目标自动完成。'),
            h('p', { key: 'budget' }, !budget || budget.健康 !== '可用' ? '预算记录不可用，当前额度与用量未知。'
              : !budget.配置 ? '未配置受管尝试额度；配置前用量未知，不表示零消耗。'
              : '受管尝试上限 ' + String(budget.上限) + '；累计准入 ' + String(budget.累计准入) + '；已返回结果 ' + String(budget.已结算) + '；未决占用 ' + String(budget.未决占用) + '；可准入 ' + String(budget.可准入)),
            h('p', { key: 'budget-scope' }, '仅覆盖普通成员文件工具与 member_spawn 的准入尝试；失败和未知不退额度，token 与费用未知。'),
            h('p', { key: 'source' }, '意图来源：' + String(source.用户意图 || '未核验')),
            h('p', { key: 'detail', className: 'dshmind-mono' }, String(goal.详情指引 || '')),
          ]);
        }),
        goals.hasMore ? h('p', { key: 'more' }, '还有目标未展示，可用 goal_query 分页读取。') : null,
        h('p', { key: 'stop' }, '暂停或取消保留已发生事实；在途宿主操作是否停止须另行核对。'),
      ]);
    }

    function 监控反馈页(props) {
      var monitor = props.monitor;
      var form = useState({ id: '', reason: '', reference: '', category: '未知', verdict: 'unknown', busy: false, message: '' });
      var value = form[0]; var set = form[1];
      var life = useState(function () { return { active: true, generation: 0, busy: false }; })[0];
      useEffect(function () { life.active = true; return function () { life.active = false; life.generation++; }; }, []);
      function edit(key, text) { set(function (old) { var next = Object.assign({}, old); next[key] = text; return next; }); }
      function send(row) {
        if (life.busy || !value.reason.trim() || !value.reference.trim()) return;
        life.busy = true; var generation = life.generation;
        edit('busy', true); edit('message', '提交中，尚未确认');
        var route = '/plugins/dsh-mind/monitor?sessionId=' + encodeURIComponent(row.subject);
        runCommand(activeCtx, row.subject, { method: 'POST', path: route, body: { 阻塞引用: row.id, 原因分类: value.category,
          判定: value.verdict, 原因: value.reason, 来源引用: value.reference } }).then(function (out) {
          if (!life.active || life.generation !== generation) return;
          var receipt = obj(out.value);
          if (!out.ok || !receipt || !receipt.feedbackId || receipt.blockId !== row.id || receipt.source !== 'human_confirmation') {
            life.busy = false; edit('busy', false); edit('message', '反馈未确认：' + (out.error || '回执不匹配，请回读核查。')); return;
          }
          return runCommand(activeCtx, row.subject, { method: 'GET', path: route }).then(function (read) {
            if (!life.active || life.generation !== generation) return;
            var data = read.ok && read.value && read.value.数据;
            var item = data && arr(data.阻塞).find(function (entry) { return entry.id === row.id && entry.subject === row.subject; });
            var confirmed = item && arr(item.feedback).some(function (f) { return f.eventId === receipt.feedbackId && f.source === 'human_confirmation'; });
            life.busy = false; edit('busy', false); edit('message', confirmed ? '已回读确认反馈；权限与审批未改变。' : '提交回执已收到，独立回读未确认；请核查后再提交。');
            if (confirmed) 刷新投影();
          });
        });
      }
      if (!monitor) return h('p', null, '监控尚未接入，覆盖与分母未知。');
      var health = monitor.健康 || {};
      return h('section', { 'data-dshmind': 'monitor-feedback' }, [
        h('h2', { key: 'title' }, '阻塞与原因反馈'),
        h('p', { key: 'scope' }, String(monitor.范围 || '范围未知') + ' · 采集 ' + String(health.状态 || '未知') + ' · 已落账尝试 ' + String(monitor.尝试总数 === null ? '未知' : monitor.尝试总数)),
        h('p', { key: 'coverage' }, JSON.stringify(health.覆盖 || {}) + ' · ' + String(health.分母 || '') + ' · ' + String(health.崩溃窗口 || '')),
        h('p', { key: 'denom' }, '误拦截率：未知（缺少有效分母）；模型声明与人侧确认分别统计。批准或重试发起不等于恢复。'),
        h('p', { key: 'paging' }, '阻塞共 ' + String(monitor.阻塞总数) + ' 条，此页展示最近 ' + arr(monitor.阻塞).length + ' 条；模型可用 monitor_query + 监控偏移继续读取。规则共 ' + String(monitor.规则总数) + ' 条，展示上限100；每条仅展示最近10条反馈与跟进。'),
        h('p', { key: 'timing' }, monitor.耗时口径 || ''),
        arr(monitor.规则汇总).map(function (r) { return h('p', { key: r.ruleId + r.ruleVersion },
          r.ruleId + ' · 版本 ' + String(r.ruleVersion).slice(0, 12) + ' · 阻塞 ' + r.blocked + ' · 恢复 ' + r.recovered + ' · 放弃 ' + r.abandoned + ' · 未跟进 ' + r.unresolved
          + ' · 人侧确认误拦 ' + r.humanFalsePositive + ' · 未确认 ' + r.unconfirmed + ' · 模型声明 ' + r.modelClaims + ' · 按来源的最新原因 ' + JSON.stringify(r.reasonCounts || {})); }),
        !arr(monitor.阻塞).length ? h('p', { key: 'none' }, '本可见域尚无已落账阻塞；不代表宿主从未拒绝。') : null,
        arr(monitor.阻塞).map(function (row) { return h('article', { key: row.id, 'data-block-id': row.id }, [
          h('h3', { key: 'head' }, row.tool + (row.action ? ' / ' + row.action : '') + ' · ' + ({ recovered: '已恢复', abandoned: '已放弃', unresolved: '未跟进' }[row.state] || '未知')),
          h('p', { key: 'ref' }, row.id + ' · ' + row.subject + ' · 项目 ' + row.project + ' · 规则 ' + (row.block && row.block.ruleId)),
          h('p', { key: 'recover' }, row.recovery ? '关联成功执行 ' + row.recovery.attemptId + ' · 等待间隔 ' + (row.recovery.recoveryMs === null ? '未知' : row.recovery.recoveryMs + ' ms') : '尚无关联成功执行'),
          h('p', { key: 'feedback-count' }, '反馈 ' + String(row.feedbackTotal) + ' 条，跟进 ' + String(row.followupsTotal) + ' 条'),
          arr(row.feedback).map(function (f) { return h('p', { key: f.eventId }, f.source + ' · ' + f.category + ' · ' + f.verdict + ' · ' + f.reason + ' · 来源 ' + f.reference); }),
          h('button', { key: 'open', type: 'button', className: 'dshmind-set__btn', disabled: value.busy, onClick: function () { edit('id', row.id); } }, '记录原因反馈'),
          value.id === row.id ? h('form', { key: 'form', onSubmit: function (event) { event.preventDefault(); send(row); } }, [
            h('label', { key: 'category' }, ['原因分类 ', h('select', { value: value.category, onChange: function (e) { edit('category', e.target.value); } }, ['授权缺口', '规则缺陷疑似', '材料不足', '环境故障', '调用不合法', '主动放弃', '其他', '未知'].map(function (x) { return h('option', { key: x, value: x }, x); }))]),
            h('label', { key: 'verdict' }, ['人侧判定 ', h('select', { value: value.verdict, onChange: function (e) { edit('verdict', e.target.value); } }, [h('option', { key: 'u', value: 'unknown' }, '尚未确认'), h('option', { key: 'f', value: 'false_positive' }, '确认误拦截'), h('option', { key: 'c', value: 'correct_block' }, '确认正确拦截')])]),
            h('label', { key: 'reason' }, ['理由 ', h('textarea', { required: true, maxLength: 1000, value: value.reason, onChange: function (e) { edit('reason', e.target.value); } })]),
            h('label', { key: 'reference' }, ['来源引用 ', h('input', { required: true, maxLength: 500, value: value.reference, onChange: function (e) { edit('reference', e.target.value); } })]),
            h('button', { key: 'submit', className: 'dshmind-set__btn', type: 'submit', disabled: value.busy || !value.reason.trim() || !value.reference.trim() }, '提交反馈'),
          ]) : null,
        ]); }),
        value.message ? h('p', { key: 'message', role: 'status' }, value.message) : null,
      ]);
    }

    /** 独立审阅页，只在用户从实时待办中选择请求后挂载。正文不进入投影或本地缓存。 */
    function 审批详情(props) {
      var sessionId = line(props && props.sessionId, '');
      var requestId = line(props && props.requestId, '');
      var snapState = useState({ sessionId: '', requestId: '', phase: 'reading', 清单: [], error: '', 提示: '', 忙: '' });
      var setSnap = snapState[1];
      var life = useState(function () { return { active: false, seq: 0, busy: false, refresh: null, sessionId: '' }; })[0];
      var snap = snapState[0].sessionId === sessionId && snapState[0].requestId === requestId ? snapState[0] : { phase: 'reading', 清单: [], error: '', 提示: '', 忙: '' };
      var route = ROUTE_INTERVENTION + '?sessionId=' + encodeURIComponent(sessionId);
      useEffect(function () {
        life.active = true;
        life.sessionId = sessionId;
        life.busy = false;
        var epoch = ++life.seq;
        var inFlight = null;
        function alive() { return life.active && life.seq === epoch && life.sessionId === sessionId; }
        function fail(message) {
          if (alive()) setSnap(function (old) { return Object.assign({}, old, { sessionId: sessionId, requestId: requestId, phase: 'error', 清单: [], error: message }); });
        }
        function read(force) {
          if (!alive()) return Promise.resolve(null);
          if (!sessionId || !requestId) { fail('缺少请求标识或所属会话；请返回待办重新打开。'); return Promise.resolve(null); }
          // poll复用同一在途读取；人侧POST后的强制回读必须等旧读结束再新发，不能拿旧快照确认。
          if (inFlight) return force === true ? inFlight.then(function () { return read(true); }) : inFlight;
          inFlight = runCommand(activeCtx, sessionId, { method: 'GET', path: route }).then(function (out) {
            if (!alive()) return null;
            var value = obj(out.value);
            if (!out.ok) { fail('读取会话审批失败：' + out.error); return null; }
            if (!value || value.会话 !== sessionId || !Array.isArray(value.待决)
              || value.待决.some(function (item) { return !item || !item.原主体 || item.原主体.id !== sessionId; })) {
              fail('宿主返回的会话审批范围不符；拒绝展示其他会话请求。'); return null;
            }
            var selected = value.待决.filter(function (item) { return item.请求id === requestId; });
            if (selected.length > 1) { fail('请求标识重复，无法确认当前记录。'); return null; }
            setSnap(function (old) { return Object.assign({}, old, { sessionId: sessionId, requestId: requestId, phase: 'live', 清单: selected, error: '' }); });
            return selected;
          }).then(function (value) { inFlight = null; return value; });
          return inFlight;
        }
        life.refresh = read;
        read();
        var set = 取计时器('setInterval');
        var clear = 取计时器('clearInterval');
        var timer = null;
        if (set && clear && sessionId) timer = set(read, POLL_MS);
        else if (sessionId) fail('自动刷新不可用，请使用重新读取更新当前请求。');
        return function () {
          if (timer !== null && clear) clear(timer);
          if (life.seq === epoch) { life.active = false; life.seq += 1; life.refresh = null; }
        };
      }, [sessionId, requestId]);

      function decide(item, decision) {
        if (!life.active || life.sessionId !== sessionId || life.busy || snap.phase !== 'live') return;
        if (!item || item.请求id !== requestId || !item.审阅指纹 || item.记录问题 || !obj(item.完整请求) || !Array.isArray(item.步骤) || !item.步骤.length) {
          setSnap(function (old) { return Object.assign({}, old, { 提示: '完整冻结计划或审阅指纹不可用，不能盲批。' }); }); return;
        }
        life.busy = true;
        var epoch = life.seq;
        setSnap(function (old) { return Object.assign({}, old, { 忙: item.请求id, 提示: '' }); });
        runCommand(activeCtx, sessionId, { method: 'POST', path: route, body: { 请求id: item.请求id, 决定: decision, 审阅指纹: item.审阅指纹 } }).then(function (out) {
          if (!life.active || life.seq !== epoch) return;
          var reply = obj(out.value);
          var accepted = out.ok && reply && reply.请求id === item.请求id && reply.决定 === decision;
          return life.refresh(true).then(function (items) {
            if (!life.active || life.seq !== epoch) return;
            var actual = items && items.find(function (row) { return row.请求id === item.请求id; });
            var expected = decision === '批准' ? '已批准待重放' : decision === '拒绝' ? '已拒绝' : '已撤销';
            var confirmed = accepted && actual && actual.状态 === expected;
            life.busy = false;
            setSnap(function (old) { return Object.assign({}, old, { 忙: '', 提示: confirmed
              ? '已回读确认「' + expected + '」。批准不会执行原动作，仍需原申请者重放冻结请求。'
              : '决议未确认：' + (out.ok ? '回执或独立回读不匹配，请核查当前状态后再决定。' : out.error) }); });
          });
        });
      }

      var item = arr(snap.清单).find(function (row) { return row.请求id === requestId; });
      var terminal = item && ['已完成', '已拒绝', '已撤销', '已失效'].indexOf(item.状态) >= 0;
      var complete = item && !item.记录问题 && obj(item.完整请求) && Array.isArray(item.步骤) && item.步骤.length && item.审阅指纹;
      return h('main', { 'data-dshmind': 'approval-review', 'data-session-id': sessionId, 'data-request-id': requestId, className: 'dshmind-approvalPage' }, [
        h('style', { key: 'style' }, APPROVAL_CSS),
        h('nav', { key: 'nav', 'aria-label': '审批导航' }, h('button', { type: 'button', onClick: props.onBack }, '← 返回待你决定')),
        h('header', { key: 'header' }, [
          h('p', { key: 'eyebrow', className: 'dshmind-approvalMuted' }, '心智 / 待你决定'),
          h('h1', { key: 'title' }, '审阅操作'),
          h('p', { key: 'boundary', className: 'dshmind-approvalMuted' }, '核对以下冻结内容。批准后由申请者继续执行，其他权限检查仍然生效。'),
        ]),
        snap.phase === 'reading' ? h('p', { key: 'loading', role: 'status' }, '正在读取当前请求…') : null,
        snap.error ? h('p', { key: 'error', role: 'alert' }, snap.error) : null,
        snap.提示 ? h('p', { key: 'tip', role: 'status' }, snap.提示) : null,
        snap.phase === 'live' && !item ? h('p', { key: 'missing', role: 'status' }, '当前请求已不可用。返回待办可查看最新事项。') : null,
        item && snap.phase === 'live' ? h('div', { key: 'content' }, [
          h('dl', { key: 'summary', className: 'dshmind-approvalSummary' }, [
            ['状态', item.状态], ['项目', item.项目], ['申请角色', item.原主体 && item.原主体.kind], ['操作', item.动作], ['目标', item.目标 && [item.目标.kind, item.目标.id].filter(Boolean).join(' / ')], ['冻结时间', item.冻结于],
          ].map(function (pair) { return h('div', { key: pair[0] }, [h('dt', { key: 'label' }, pair[0]), h('dd', { key: 'value' }, line(pair[1], '未声明'))]); })),
          !terminal ? h('section', { key: 'params' }, [h('h2', { key: 'title' }, '操作参数'), 审阅字段(item.完整请求, 'request')]) : null,
          !terminal ? h('section', { key: 'steps' }, [
            h('h2', { key: 'title' }, '执行计划 · ' + arr(item.步骤).length + ' 步'),
            h('ol', { key: 'list' }, arr(item.步骤).map(function (step, index) { return h('li', { key: index }, [h('h3', { key: 'title' }, line(step.说明 || step.动作, '步骤 ' + (index + 1))), 审阅字段(step, 'step-' + index)]); })),
          ]) : null,
          !terminal && !complete ? h('p', { key: 'problem', role: 'alert' }, item.记录问题 || '完整冻结计划不可用，禁止盲批。') : null,
          item.失败原因 ? h('p', { key: 'failure', role: 'alert' }, '原执行失败：' + item.失败原因) : null,
          h('details', { key: 'source' }, [h('summary', { key: 'label' }, '请求标识与原始记录'), h('pre', { key: 'raw' }, JSON.stringify(item, null, 2))]),
          !terminal ? h('footer', { key: 'actions', 'aria-label': '当前请求的决定' }, arr(item.可选项).filter(function (x) { return ['批准', '拒绝', '撤销'].indexOf(x) >= 0; }).map(function (decision) {
            return h('button', { key: decision, type: 'button', className: decision === '批准' ? 'dshmind-approvalPrimary' : '', disabled: !!snap.忙 || snap.phase !== 'live' || !complete, onClick: function () { decide(item, decision); } }, decision);
          })) : null,
        ]) : null,
        h('button', { key: 'refresh', type: 'button', onClick: function () { if (life.refresh) life.refresh(); } }, '重新读取'),
      ]);
    }

    // 用字段与步骤阅读冻结计划；完整值保留换行、嵌套和空值，不截断正文。
    function 审阅字段(value, key) {
      if (value && typeof value === 'object') {
        if (!Object.keys(value).length) return h('span', { key: key }, Array.isArray(value) ? '[]' : '{}');
        return h('dl', { key: key, className: 'dshmind-approvalFields' }, Object.keys(value).map(function (name) {
          return h('div', { key: name }, [h('dt', { key: 'key' }, Array.isArray(value) ? String(Number(name) + 1) : name), h('dd', { key: 'value' }, 审阅字段(value[name], key + '-' + name))]);
        }));
      }
      return h('span', { key: key }, value === undefined ? '未提供' : value === null ? 'null' : String(value));
    }

    var APPROVAL_CSS = [
      '.dshmind-approvalPage{box-sizing:border-box;min-height:100%;width:100%;padding:28px clamp(20px,5vw,72px);overflow:auto;color:var(--dsw-alias-label-primary,#e5e9f0);background:var(--dsw-alias-bg-base,#141821);font:14px/1.65 var(--ds-font-family-ui,system-ui,sans-serif);overflow-wrap:anywhere}',
      '.dshmind-approvalPage>*{max-width:960px;margin-left:auto;margin-right:auto}',
      '.dshmind-approvalPage h1{font-size:25px;margin:4px 0 12px}.dshmind-approvalPage h2{font-size:16px;margin:0 0 16px}.dshmind-approvalPage h3{font-size:14px;margin:0 0 10px}',
      '.dshmind-approvalPage header{margin-top:24px;margin-bottom:28px}.dshmind-approvalPage section{padding:24px 0;border-top:1px solid var(--dsw-alias-border-l2,#333946)}',
      '.dshmind-approvalMuted,.dshmind-approvalPage dt{color:var(--dsw-alias-label-secondary,#9aa5b8)}',
      '.dshmind-approvalSummary{display:flex;flex-wrap:wrap;gap:16px 32px;margin:0 0 28px}.dshmind-approvalSummary>div{min-width:120px;max-width:100%}',
      '.dshmind-approvalPage dl{margin-top:0}.dshmind-approvalPage dd{margin:0;white-space:pre-wrap;min-width:0}.dshmind-approvalFields>div{display:grid;grid-template-columns:minmax(70px,130px) minmax(0,1fr);gap:16px;padding:7px 0}.dshmind-approvalFields .dshmind-approvalFields{margin:0}',
      '.dshmind-approvalPage ol{padding-left:24px}.dshmind-approvalPage li{padding:0 0 24px 8px}.dshmind-approvalPage pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}.dshmind-approvalPage details{margin:20px 0}.dshmind-approvalPage summary{cursor:pointer}',
      '.dshmind-approvalPage footer{display:flex;gap:12px;padding:24px 0}.dshmind-approvalPage button{border:1px solid var(--dsw-alias-border-l2,#414959);background:transparent;color:inherit;font:inherit;border-radius:6px;padding:7px 16px;cursor:pointer}.dshmind-approvalPage button:disabled{opacity:.5;cursor:default}.dshmind-approvalPage button:focus-visible{outline:2px solid #6e8aff;outline-offset:3px}.dshmind-approvalPage .dshmind-approvalPrimary{background:var(--dsw-alias-brand-primary,#4d6bfe);border-color:transparent;color:#fff}',
      '@media(max-width:560px){.dshmind-approvalFields>div{display:block}.dshmind-approvalFields dd{padding-left:8px}.dshmind-approvalPage{padding:20px 16px}}',
    ].join('');

    /** 立刻拉一次（两个页面都刷）。给"手动刷新"按钮与 effect 增强用。 */
    function 立即刷新() {
      return Promise.all([刷新投影(), 刷新设置(), 刷新调度(), 刷新人设(), 刷新信息(false)]);
    }

    /**
     * 起轮询：**立刻拉一次**，然后每 `POLL_MS` 拉一次。返回停止函数（进 `apply` 的 disposer）。
     *
     * ⚠️ 区间计时器与超时一样走**裸全局**（`取计时器`）：拿不到就**响亮报出**，
     * 绝不静默地"不轮询"——那正是真机上"什么都没发生"的成因之一。
     */
    function 起轮询() {
      var 设 = 取计时器('setInterval');
      var 清 = 取计时器('clearInterval');
      // 幂等（2026-10-12 评审 P2）：重复调用先把旧 interval 停掉再挂新的——
      // 否则每次调用多挂一根，刷新频率悄悄翻倍，而旧把手永远没人停。
      if (轮询把手.timer !== null) {
        try { if (清) 清(轮询把手.timer); } catch (error) { /* 已经没了就算了 */ }
        轮询把手.timer = null;
      }
      if (!设) {
        // 响亮：页面会显示这句（见设置页的 `钩子缺失提示` 同类处理），控制台也有一句。
        轮询把手.停了 = true;
        轮询把手.通知 = '本客户端拿不到计时器 setInterval：这一页不会自动刷新（只能手动点「重新读取」）。';
        发通知(投影store, Object.assign({}, 投影store.快照, { error: 投影store.快照.error || 轮询把手.通知 }));
        return function 停轮询() {};
      }
      轮询把手.停了 = false;
      轮询把手.通知 = null;
      立即刷新();
      var timer = null;
      try {
        timer = 设(function () {
          if (轮询把手.停了) return;
          // 隐藏标签页不拉（2026-10-12 评审 P3）：看不见的面板每 3s 全量拉一遍是纯浪费；
          // 回到前台后最多晚一个周期自然补上。拿不到 document 就照拉（保守：宁可多拉不可不拉）。
          try {
            if (typeof document !== 'undefined' && document && document.hidden === true) return;
          } catch (error) { /* 读不到可见性就照拉 */ }
          立即刷新();
        }, POLL_MS);
      } catch (error) {
        轮询把手.停了 = true;
        return function 停轮询() {};
      }
      轮询把手.timer = timer;
      return function 停轮询() {
        轮询把手.停了 = true;
        try { if (timer !== null && 清) 清(timer); } catch (error) { /* 已经没了就算了 */ }
        轮询把手.timer = null;
      };
    }

    // ── 主视图 ──────────────────────────────────────────────────────────────
    /** `apply` 拿到的客户端上下文（`apply` 只跑一次，组件可多次挂载）。 */
    var activeCtx = null;

    function Dashboard() {
      var snap = useStore(投影store);
      // ③ 折叠态也走 store 订阅（返回值在渲染处直接读 界面store.快照）：
      // 切换钮 `切会审折叠` 发通知 ⇒ 这里 setState ⇒ 重渲染，全程不碰 useEffect。
      useStore(界面store);
      var ctx = activeCtx;
      var review = useState(null);
      var decideExpanded = useState(false);

      // ⚠️ **取数不在这里做**（Batch 7 的方向修正，见模块顶部 `起轮询` 的长注释）：
      // 这个宿主给插件的 `useEffect` 很可能是**空实现** ⇒ 把取数挂在 effect 上 = 页面永远不动。
      // 数据由 `apply` 起的**裸 setInterval 轮询**放进模块级 store；组件只是**订阅**它。
      useEffect(function () {
        try {
          // effect 可用时只当**增强**：挂载后立刻拉一次，让首屏更快。
          // **不许**因为这里不跑就什么都不做 —— 出数据靠 store，不靠它。
          立即刷新();
        } catch (error) { /* effect 不可用也没关系 */ }
        return function () { /* 订阅由 store 自己管，这里没有要清的 */ };
      }, []);

      var view = snap.view;
      var bar = view ? view.状态条 : null;
      var gate = bar ? bar.闸 : null;
      var probe = bar ? bar.探针 : null;
      var tasks = view ? view.任务节点 : [];
      var 待你决定 = view ? view.待你决定 : [];
      var 会审 = view ? view.会审 : [];
      var 总线 = view ? view.消息总线 : [];
      // 项目解析（2026-10-11，主权者指令「修」）：面板默认只看一个项目，而活账常在别的
      // 项目下 ⇒ 这份清单是"说清现在看的是哪个项目、还有哪些项目有账"的唯一来源。
      var 项目清单 = view ? view.项目清单 : null;
      var 当前项目 = view ? view.项目 : '';
      var 自动选择 = line(snap.自动选择, '') || null;
      // 审计：**全量留着**，渲染多少由「展开」决定（2026-10-13 晚去掉卡内滚动框）。
      // 旧写法在这里就 `.slice(-AUDIT_LIMIT)` 把多出来的行丢掉 ⇒ 展开钮根本无从展开。
      var 审计全 = view ? view.审计尾.slice().reverse() : [];
      var audit = 审计展开() ? 审计全 : 审计全.slice(0, AUDIT_LIMIT);
      // 投影里**一共**多少条（用来在列表尾部说清"看不全是因为投影只有这些/还有多少没列"）。
      var 审计总条数 = view ? view.审计尾.length : 0;
      var boundReadOnly = view ? boolOf(firstOf(view.边界, ['只读', 'readonly'])) : null;
      // 闸不在位 / 已失联 / 已关闭是「现在能不能干活」的事：确定的不良态才告警，
      // `未知`（宿主没给）不当成故障，也不当成正常。
      var gateAlarm = !!gate && gate.在位 === false;
      var 失联态 = bar ? bar.失联 : '未知';
      // 「探针有结论」= 有状态且不是"未知"，或者有见红/恒红/恒绿这类明确信号。
      // 缺一格数据时 `normalizeView` 会造出 `状态:'未知'` 的空袋，别把它当成"有数据"。
      var 探针有结论 = !!probe && (probe.状态 !== '未知' || probe.见红.length > 0 || probe.恒红 || probe.恒绿);
      var 失联详情 = bar ? bar.失联详情 : 失联详情Of(null);
      var lostAlarm = !!bar && (失联态 === '已失联' || 失联态 === '已关闭');
      /** 故障注入开关（只在测试/探针里打开；见下面状态条那两笔）。 */
      var 注入空壳格 = typeof window !== 'undefined' && window && window.__dshMindInjectEmptySlot === true;
      var 注入破折号格 = typeof window !== 'undefined' && window && window.__dshMindInjectDashSlot === true;

      // 导航只接受当前实时投影里的结构化标识；缓存和描述/命令均不能提供审批归属。
      function openReview(item) {
        var latest = 投影store.快照;
        if (latest.phase !== 'live' || latest.stale || !item.请求id || !item.会话 || item.类型 !== '介入审批') return;
        if (!latest.view || !latest.view.待你决定.some(function (row) { return row.类型 === '介入审批' && row.请求id === item.请求id && row.会话 === item.会话; })) return;
        review[1]({ sessionId: item.会话, requestId: item.请求id });
      }
      if (review[0]) return h(审批详情, { key: review[0].sessionId + '/' + review[0].requestId, sessionId: review[0].sessionId, requestId: review[0].requestId, onBack: function () { review[1](null); 刷新投影(); } });

      var children = [
        h('style', { key: 'dshmind-css' }, CSS),

        // 未连接公告（有快照时说明「显示的是旧数据」）
        snap.phase === 'error' ? h('div', { key: 'notice', className: 'dshmind-notice' }, [
          h('span', { key: 'i' }, '⚠'),
          h('span', { key: 't' }, '未连接：' + (snap.error || '宿主命令不可用')
            + (snap.stale ? '　—　下面是最后一次已知快照（' + shortTime(snap.at) + '）' : '　—　暂无历史快照')),
        ]) : null,
        snap.phase === 'nosession' ? h('div', { key: 'notice2', className: 'dshmind-notice' }, [
          h('span', { key: 'i' }, '⚠'),
          h('span', { key: 't' }, '未连接：定位不到会话 id，无法读取工作台投影'
            + (snap.stale ? '　—　显示最后一次已知快照（' + shortTime(snap.at) + '）' : '')),
        ]) : null,

        // ① 页头 —— 照设计稿 v2.1 的 `.topbar` 版式：
        //    一行之内「当前页名 ＋ 项目 chip ＋ 撑开 ＋ 活数据·生成时刻 ＋ 刷新」，
        //    **不再是一张带边框的卡片**：那张卡把页头做成了"一块内容"，而设计稿里
        //    它是"一条工具行"。品牌名留在侧栏（设计稿同款，`导航()` 里有）。
        //    项目 chip 由「身份」读数格提到这里 —— 设计稿就是把"在看哪个项目"与页题并列。
        h('header', { key: 'hero', className: 'dshmind-hero' }, [
          h('div', { key: 'top', className: 'dshmind-heroTop' }, [
            h('h2', { key: 'h', className: 'dshmind-title' }, 当前页名()),
            项目清单 && 项目清单.项.length > 1
              ? h('div', { key: 'pc', className: 'dshmind-projChips' },
                  项目清单.项.map(function (p, i) { return 项目导航项(p, i, 当前项目); }))
              : null,
            h('div', { key: 'a', className: 'dshmind-actions' }, [
              h('span', { key: 'live', className: 'dshmind-dot-line', style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary,#81858c)' } }, [
                dot(snap.phase === 'live' ? GREEN : snap.phase === 'error' ? RED : GREY),
                snap.phase === 'live' ? '活数据' : snap.phase === 'error' ? '未连接' : snap.phase === 'nosession' ? '无会话' : '读取中',
                view && view.生成于 ? h('span', { key: 'g', className: 'dshmind-mono' }, '生成于 ' + shortTime(view.生成于)) : null,
              ].filter(Boolean)),
              h('button', {
                key: 'r', type: 'button', className: 'dshmind-btn',
                onClick: function () { 立即刷新(); },
              }, '刷新'),
            ]),
          ]),
          // 优化批④：读数分「身份／健康」两组——失联详情多行时只撑自己那一格，
          // 不再把项目键/生成时刻一起拉高。组内规矩不变（Batch 9：没数据的格不出现）。
          h('div', { key: 'ro', className: 'dshmind-readoutGroups' }, [
            readoutGroup('身份', [
              // 项目键那一格带一句注记：自动选出来的项目必须**明写**（不许静默换项目）。
              readout('项目键', null, h('span', { className: 'dshmind-valueLine' }, [
                h('span', { key: 'v', className: 'dshmind-mono' }, view ? 当前项目 : '未接入'),
                view && 自动选择 && 自动选择 === 当前项目
                  ? h('span', { key: 'h', className: 'dshmind-valueNote' }, '默认项目无账，已按最近活动自动选择')
                  : null,
              ].filter(Boolean))),
              // （项目 chip 已提到页头，此处不再重复）
              // 2026-10-14：项目 chip 已提到页头（照设计稿"页题与项目并列"）⇒ 此处不再重复一份。
              readout('生成时刻', view ? (shortTime(view.生成于) || '宿主没给') : '未接入'),
            ]),
            readoutGroup('健康', [
              view && view.核心人设保护
                ? readout('人设保护', line(view.核心人设保护.执行状态, '隔离程度未知'), null, false,
                    h('span', { className: 'dshmind-readoutNote' }, line(view.核心人设保护.保护范围, '保护范围未提供')))
                : null,
              readout('策略引擎闸', null, h('span', { className: 'dshmind-dot-line' }, [
                dot(!gate ? GREY : gate.在位 === true ? GREEN : gate.在位 === false ? RED : GREY),
                h('span', { key: 'v' }, !gate ? '未接入' : gate.在位 === true ? '闸在位' : gate.在位 === false ? '闸不在位' : '未知'),
                gate && gate.规则数 !== null
                  ? h('span', { key: 'n', className: 'dshmind-mono', style: { color: 'var(--dsw-alias-label-tertiary,#81858c)' } }, '规则 ' + gate.规则数)
                  : null,
                gate && gate.错误 ? h('span', { key: 'e' }, gate.错误) : null,
              ].filter(Boolean)), gateAlarm),
              // 介入度：**只显示当前生效的那一档**（一个值）。
              // v2（2026-10-18）：四档砍成三档（放权 / 预审 / 审批），「事后抽检」退役。
              // 保持只读投影的纪律：一个值 + 一句注记，不带边框、不带背景、不带光标、不可聚焦。
              readout('介入度档位', null, bar
                ? h('span', { className: 'dshmind-valueLine' }, [
                    h('span', { key: 'v' }, 介入度标签(bar.介入度)),
                    h('span', { key: 'h', className: 'dshmind-valueNote' }, '三档之一（只读）'),
                  ])
                : null),
              // 失联那一格四态四样。**`已关闭` 绝不许给绿点**：开关被关掉不是「主权者一直在」，
              // 但也不是失联 —— 所以它拿告警色 + 明说「不判定失联」，与「在位」「已失联」都长得不一样。
              // `未知` 照旧是灰点 + 未接入：宿主没给 ≠ 正常。
              // 详情（生效期限 / 来源 / 坏值）**紧贴这一格**放在同一个 cell 里 —— 别拉到整行当脚注，
              // 那会横跨所有列、把列对齐打断（Batch 8 主人提的第 6 条）。
              readout('失联状态', null, h('span', { className: 'dshmind-dot-line' }, [
                dot(!bar ? GREY : 失联态 === '已失联' ? RED : 失联态 === '已关闭' ? WARN : 失联态 === '在位' ? GREEN : GREY),
                h('span', { key: 'v' }, !bar ? '未接入'
                  : 失联态 === '已失联' ? '已失联 · 自治冻结'
                  : 失联态 === '已关闭' ? '已关闭（不判定失联）'
                  : 失联态 === '在位' ? '在位'
                  : '未知'),
              ].filter(Boolean)), lostAlarm,
                // 格内附注：完整读数，换行显示（不裁切、不铺满整行）。
                失联详情.在位
                  ? h('span', { key: 'note', className: 'dshmind-readoutNote' }, [
                      h('span', { key: 'a', className: 'dshmind-mono' }, 失联详情.读数 === '缺失' ? '读数：缺失' : '读数：' + 失联详情.读数),
                      h('span', { key: 'b' }, '生效期限 ' + (失联详情.生效响应期限小时 === null ? '—' : 失联详情.生效响应期限小时 + 'h')
                        + '（' + 失联详情.响应期限小时来源 + '）'),
                      h('span', { key: 'c' }, '开关来源 ' + 失联详情.失联限制来源),
                      失联详情.值不合法
                        ? h('span', { key: 'd', style: { color: WARN } }, '⚠ 值不合法：原值 ' + JSON.stringify(失联详情.原值)
                            + '（' + 失联详情.原值来源 + '）已退回兜底' + (失联详情.不合法说明 ? ' · ' + 失联详情.不合法说明 : ''))
                        : null,
                    ].filter(Boolean))
                  : null),
              // 安全类探针：**没数据就整格不出现**（Batch 9 主人倾向的"没数据就别占位置"）。
              // 「没数据」的判据不是 `!probe`：`normalizeView` 总会造一个探针袋（缺了就是
              // `状态:'未知'` + 没见红），所以这里认「没有结论」= 状态未知且没有见红/恒红/恒绿。
              探针有结论
                ? readout('安全类探针', null, h('span', { className: 'dshmind-dot-line' }, [
                    dot(probe.见红.length ? RED : probe.状态 === '正常' || probe.状态 === '绿' ? GREEN : GREY),
                    h('span', { key: 'v' }, probe.状态),
                    probe.见红.length ? h('span', { key: 'r' }, '见红：' + probe.见红.join('、')) : null,
                    probe.恒红 ? badge('恒红警报', 'red') : null,
                    probe.恒绿 ? badge('恒绿警报', 'warn') : null,
                  ].filter(Boolean)))
                : null,
              // **故障注入**（Batch 9 交付物 4）：探针那一格的"退化形态"。
              // 那两个"没内容就不画壳"的守卫现在没有活的触发者，断言也就无从变红；
              // 留这一笔是为了让探针/门禁能**故意**把退化形态造出来（没有反例 = 没验过）。
              //  ① 空壳格：`允许空壳` 为真 ⇒ 没内容也画壳（用来验"不许有壳没内容"那条判据真在算）。
              注入空壳格
                ? readout('（故障注入：没数据的格）', null, null, false, null, true)
                : null,
              //  ② 破折号值：把 `—` 当值传进去，且绕过守卫 ⇒ 验"值不许是光秃秃的 `—`"那条判据。
              注入破折号格
                ? readout('（故障注入：破折号值）', '—', null, false, null, true)
                : null,
            ]),
          ].filter(Boolean)),
        ]),

        // ① 待你决定 —— 排在最前：这是主子唯一必须看的一块（§7 唯一点名要投影的清单）
        section(1, '待你决定', '查看事项；审批请求在独立审阅页核对后决定',
          待你决定.length ? 待你决定.length + ' 项' : '',
          view && 待你决定.length
            ? h('div', { className: 'dshmind-decide' }, 待你决定.slice(0, decideExpanded[0] ? undefined : DECIDE_LIMIT).map(function (item, index) {
                var hot = item.类型 === '探针见红' || item.类型 === '打回升级';
                return h('div', { key: 'd' + index, className: 'dshmind-decideRow' }, [
                  h('div', { key: 'top', className: 'dshmind-decideTop' }, [
                    badge(item.类型, hot ? 'red' : 'warn'),
                    h('span', { key: 'w', className: 'dshmind-decideWhat' }, line(item.描述, '（无描述）')),
                    item.节点 ? h('span', { key: 'n', className: 'dshmind-chip dshmind-mono', title: item.节点 }, item.节点) : null,
                  ].filter(Boolean)),
                  h('div', { key: 'why', className: 'dshmind-decideWhy' }, '原因：' + item.原因),
                  item.可选项.length
                    ? h('div', { key: 'opt', className: 'dshmind-chips' }, item.可选项.map(function (option, i) {
                        return h('span', { key: 'o' + i, className: 'dshmind-chip' }, option);
                      }))
                    : null,
                  item.类型 === '介入审批' && item.请求id && item.会话
                    ? h('button', { key: 'review', type: 'button', className: 'dshmind-set__btn', disabled: snap.phase !== 'live' || !!snap.stale, 'data-review-request': item.请求id, onClick: function () { openReview(item); } }, '查看请求')
                    : item.命令
                    ? h('code', { key: 'cmd', className: 'dshmind-cmd dshmind-mono', title: '选中复制这条命令去执行' }, item.命令)
                    : h('div', { key: 'cmd', className: 'dshmind-decideWhy' }, '（投影未给命令）'),
                ].filter(Boolean));
              }).concat(待你决定.length > DECIDE_LIMIT ? [h('button', { key: 'expand-decisions', type: 'button', className: 'dshmind-set__btn', onClick: function () { decideExpanded[1](!decideExpanded[0]); } }, decideExpanded[0] ? '收起待办' : '查看全部 ' + 待你决定.length + ' 项')] : []))
            // 优化批①：空态不再是一句空话——给「怎么来的 + 可敲的命令」（§9：给文本不给控件）。
            : emptyGuide('没有需要你决定的事', '打回 ≥2 的升级、探针见红、task_pending 都会把事项送到这里',
              "mind {action:'task_pending', id:'task-…', 待决类型:'升级差异', 描述:'两条路都可行，等主权者拍板'}"),
        ),

        // ② 会审（v2 条目18：与会话绑定的独立功能 · 存档形状）
        section(2, '会审', '§10 · 盲评提交后解锁 · 零分歧是异常信号',
          会审.length ? 会审.length + ' 场' : '',
          view && 会审.length
            ? h('div', { className: 'dshmind-reviews' }, 会审.slice(0, REVIEW_LIMIT).map(function (row, index) {
                // ③ 折叠的键与 article 的 key 同源：id 稳定在会审 id（缺时才退回序号占位）。
                var 会审id = line(row.id, 'review-' + index);
                // 问题全文 + 默认折叠（2026-10-12 主权者口径「要全文 + 默认折叠」）：
                // 标题位先给 3 行预告；点「展开全文」在**卡片内**另起一块铺开全文（不丢字）。
                var 会审问题 = line(row.问题 || row.id, '未命名会审');
                var 会审问题长 = 会审问题.length > 80;
                var 会审折 = 描述折叠(会审id);
                // 状态四档各一色：作答中=等答案（WARN）、已解锁/讨论中=进行（BRAND）、
                // 已收敛=完成（GREEN）、未知=灰。颜色只是辅助，文字恒在。
                var 状态色 = row.状态 === '已收敛' ? GREEN
                  : row.状态 === '作答中' ? WARN
                  : row.状态 === '已解锁' || row.状态 === '讨论中' ? BRAND
                  : GREY;
                return h('article', { key: 会审id, className: 'dshmind-review' }, [
                  // ① 身份行：左＝状态徽章 + 参与者数 + 轮次，右＝会审 id（与任务卡同一套解剖）
                  h('div', { key: 'top', className: 'dshmind-reviewTop' }, [
                    h('span', {
                      key: 's',
                      className: 'dshmind-badge',
                      style: {
                        color: 状态色,
                        borderColor: 状态色,
                        background: 'var(--dsw-alias-bg-layer-1,#fff)',
                      },
                    }, row.状态),
                    h('span', { key: 'p', className: 'dshmind-chip' }, '参与者 ' + row.参与者.length),
                    row.轮次 ? h('span', { key: 'r', className: 'dshmind-chip' }, '轮次 ' + row.轮次) : null,
                    h('span', { key: 'id', className: 'dshmind-cardMeta' },
                      h('span', { key: 'i', className: 'dshmind-cardId', title: 会审id }, 会审id)),
                  ].filter(Boolean)),
                  // ② 问题（长的 3 行钳位 + 展开钮）
                  h('span', {
                    key: 't',
                    className: 'dshmind-nodeTitle dshmind-nodeTitleFull' + (会审问题长 && 会审折 ? ' dshmind-nodeTitleClamped' : ''),
                  }, 会审问题),
                  // 问题折叠：长的才给钮；展开态全文**另起一块**（不进 reviewTop 那个 flex 行）。
                  // 纯显示动作、零请求，与「答案」折叠同款。
                  会审问题长
                    ? h('button', {
                        key: 'desctog', type: 'button', className: 'dshmind-descToggle',
                        onClick: function () { 切描述折叠(会审id); },
                        title: 会审折 ? '展开问题全文' : '收起问题',
                      }, (会审折 ? '▸ 展开全文（' + 会审问题.length + ' 字）' : '▾ 收起问题'))
                    : null,
                  会审问题长 && !会审折
                    ? h('div', { key: 'descfull', className: 'dshmind-nodeTitleOpen' }, 会审问题)
                    : null,
                  // 盲评中明说锁着：遮罩在服务层做过，这里只报事实——不自己再判一次揭名。
                  row.盲评遮罩
                    ? h('div', { key: 'lock', className: 'dshmind-lock' }, '🔒 盲评中：全员交齐并解锁前，此处只显示盲标；揭名后显示成员与结论')
                    : null,
                  // ③ 答案可折叠——多场会审时答案区不再把面板撑爆。
                  // 默认**首场展开、其余一行摘要**（摘要只给成员/盲标标签，不出结论）；
                  // 切换走 onClick（先例：页头「刷新」），状态住模块级 界面store，不挂 useEffect（设计债⑩）。
                  row.答案.length
                    ? h('div', { key: 'answersWrap' }, [
                        h('button', {
                          key: 'tog', type: 'button', className: 'dshmind-toggle',
                          onClick: function () { 切会审折叠(会审id, index !== 0); },
                          title: 会审折叠(会审id, index !== 0) ? '展开答案' : '收起答案',
                        }, (会审折叠(会审id, index !== 0) ? '▸' : '▾') + ' 答案 ' + row.答案.length + ' 份'
                          + (会审折叠(会审id, index !== 0) ? '（展开看结论与反例面）' : '')),
                        会审折叠(会审id, index !== 0)
                          ? h('div', { key: 'sum', className: 'dshmind-answerSummary' },
                              '成员：' + (row.答案.map(function (answer) { return line(answer.成员); }).filter(Boolean).join('、') || '（无）'))
                          : h('div', { key: 'ans', className: 'dshmind-answers' }, row.答案.map(function (answer, i) {
                              return h('div', { key: 'a' + i, className: 'dshmind-answer' }, [
                                h('div', { key: 'h', className: 'dshmind-answerHead' }, [
                                  h('span', { key: 'b', className: 'dshmind-badge', style: {
                                    color: BRAND, borderColor: BRAND, background: 'var(--dsw-alias-bg-layer-1,#fff)',
                                  } }, answer.成员),
                                  answer.结论层 ? h('span', { key: 'l', className: 'dshmind-chip dshmind-mono', title: answer.结论层 }, answer.结论层) : null,
                                ].filter(Boolean)),
                                answer.结论 ? h('div', { key: 'c', className: 'dshmind-answerBody' }, answer.结论) : null,
                                answer.反例面.length
                                  ? h('div', { key: 'x', className: 'dshmind-counter' }, '反例面：' + answer.反例面.join('；'))
                                  : null,
                              ].filter(Boolean));
                            })),
                      ])
                    : null,
                  // 盲评期不列参与者 id：那张卡上只许出现盲标（成员 id 在这一阶段一个都不出）。
                  row.参与者.length && !row.盲评遮罩
                    ? h('div', { key: 'who', className: 'dshmind-counter' }, '参与者：' + row.参与者.join('、'))
                    : null,
                  row.分歧清单.length
                    ? h('div', { key: 'div', className: 'dshmind-divergence' }, '分歧清单：' + row.分歧清单.join('；'))
                    : null,
                  row.结论
                    ? h('div', { key: 'concl', className: 'dshmind-consensus' }, '结论：' + row.结论)
                    : null,
                  // 零分歧 === true 是**警报**，不是好话：§10 里全票一致意味着趋同，要交人工抽检。
                  // 存档给的是布尔；只有已收敛才有判定意义。未收敛时明说「未判定」——
                  // 绝不许把 false 画成「存在分歧」：那是在替投影断言一个它还没给出的结论。
                  (function () {
                    if (row.状态 !== '已收敛') {
                      return h('div', { key: 'zero', className: 'dshmind-consensus' },
                        '零分歧：未判定（会审未收敛）');
                    }
                    if (row.零分歧 === true) {
                      return h('div', { key: 'zero', className: 'dshmind-anomaly' },
                        '⚠ 零分歧（全票一致）—— §10：这是趋同异常信号，应转人工抽检');
                    }
                    return h('div', { key: 'zero', className: 'dshmind-consensus' }, '存在分歧（正常）');
                  })(),
                  row.状态 === '讨论中'
                    ? h('div', { key: 'disc', className: 'dshmind-consensus' }, '💬 讨论进行中（Lead 显式开启）')
                    : null,
                  // 存档来源与时间：只搬存档字段，不补造。
                  row.来源会话
                    ? h('div', { key: 'src', className: 'dshmind-counter' }, '来源会话：' + row.来源会话)
                    : null,
                  (row.创建于 || row.收敛于)
                    ? h('div', { key: 'at', className: 'dshmind-counter' },
                        '创建 ' + (row.创建于 || '—')
                          + (row.解锁于 ? ' · 解锁 ' + row.解锁于 : '')
                          + (row.收敛于 ? ' · 收敛 ' + row.收敛于 : ''))
                    : null,
                ].filter(Boolean));
              }))
            : emptyGuide('没有进行中的会审', '会审是与会话绑定的独立咨询：Lead 发起 → 参与者盲评作答 → 交齐解锁 → 收敛存档',
              "mind {action:'debate_open', 问题:'要收敛的问题', 参与者:'member-a,member-b'}"),
        ),

        // ③ 任务图
        section(3, '任务图', '状态权威 · 判据派发后冻结' + (view && obj(view.任务) && typeof view.任务.只读历史数 === 'number' ? ' · 只读历史 ' + view.任务.只读历史数 + ' · 现行未结账 ' + (typeof view.任务.现行未结账数 === 'number' ? view.任务.现行未结账数 : '—') : ''), tasks.length ? tasks.length + ' 节点' : '',
          [
            tasks.length
            ? h('div', { className: 'dshmind-nodes' },
                tasks.slice(0, TASK_LIMIT).map(function (task, index) {
                  var rejects = numOf(task.打回次数) || 0;
                  var 只读历史 = task.只读历史 === true;
                  var 已终止 = task.已终止 === true || task.状态 === '已终止';
                  var pending = !只读历史 && !已终止 && isPending(task);
                  var frozen = criteriaFrozen(task);
                  var owners = arr(task.负责人).map(refText).filter(Boolean);
                  var criteria = arr(task.判据).map(refText).filter(Boolean);
                  var outputs = arr(task.产物 || task.产出物引用).map(refText).filter(Boolean);
                  // 判活（派活闭环 2026-10-15）：投影在「已派发/执行中」窗口给的未见活动名单。
                  // 有名单才画徽章（空数组 = 查过且没有，不是缺陷，不画）；字段缺席 = 宿主没给，同样不画。
                  var 无活动 = arr(task.负责人无活动).filter(Boolean);
                  var cls = 'dshmind-node' + (pending ? ' dshmind-nodePending' : '') + (!只读历史 && !已终止 && rejects >= 2 ? ' dshmind-nodeEscalated' : '');
                  // hasOwnProperty 挡原型链键（'constructor'/'toString' 等字面量查表会返回 truthy 函数，
                  // 绕过「查表 miss ⇒ 保灰」）——坏值不许因为继承属性画出彩色（失联「值不合法」同族口径）。
                  var 徽色 = Object.prototype.hasOwnProperty.call(状态徽章色, task.状态) ? 状态徽章色[task.状态] : null;
                  // 描述全文 + 默认折叠（2026-10-12 主权者口径，与会审卡同款）：
                  // 标题位给 3 行预告，长的才给展开钮；展开后在卡内另起一块铺开全文。
                  var 任务描述 = line(task.描述 || task.标题 || task.id, '未命名节点');
                  var 任务id = line(task.id, 'task-' + index);
                  var 任务描述长 = 任务描述.length > 80;
                  var 任务折 = 描述折叠(任务id);
                  return h('article', { key: 任务id, className: cls }, [
                    // ① 身份行（设计稿解剖）：左＝状态徽章 + 等宽 id，右＝负责人/模式/交卷/打回。
                    // 旧版把**描述当标题置顶**、徽章跟在后面 ⇒ 一屏全是长句，状态反而要往下找。
                    h('div', { key: 'top', className: 'dshmind-nodeTop' }, [
                      h('span', {
                        key: 'st',
                        className: 'dshmind-badge',
                        style: 徽色 ? {
                          color: 徽色,
                          borderColor: 徽色,
                          background: 'var(--dsw-alias-bg-layer-1,#fff)',
                        } : {
                          borderColor: 'var(--dsw-alias-border-l2,#0000001f)',
                          color: 'var(--dsw-alias-label-secondary,#61666b)',
                        },
                      }, line(task.状态, '未知')),
                      只读历史 ? h('span', { key: 'history', className: 'dshmind-badge', title: line(task.写入说明, '旧会审仅保留历史，不改不迁移。') }, '只读历史') : null,
                      h('span', { key: 'id', className: 'dshmind-cardId', title: 任务id }, 任务id),
                      h('span', { key: 'meta', className: 'dshmind-cardMeta' }, [
                        h('span', { key: 'o' }, '负责人 ' + (owners.length ? owners.join('、') : '未指派')),
                        task.模式 ? h('span', { key: 'm' }, line(task.模式)) : null,
                        h('span', { key: 's', className: 'dshmind-mono' }, '交卷 ' + progressText(task.交卷)),
                        rejects ? h('span', { key: 'r', className: 'dshmind-mono' }, typeof task.继承打回次数 === 'number'
                          ? '累计打回 ' + rejects + ' 次（前序 ' + task.继承打回次数 + ' + 本节点 ' + (numOf(task.本节点打回次数) || 0) + '）'
                          : '打回 ' + rejects + ' 次') : null,
                        arr(task.依赖).length ? h('span', { key: 'd' }, '依赖 ' + arr(task.依赖).map(refText).join('、')) : null,
                      ].filter(Boolean)),
                    ]),
                    // ② 描述（长描述 3 行钳位 + 展开钮；展开后在卡内另起一块铺全文）
                    h('span', {
                      key: 't',
                      className: 'dshmind-nodeTitle dshmind-nodeTitleFull' + (任务描述长 && 任务折 ? ' dshmind-nodeTitleClamped' : ''),
                    }, 任务描述),
                    // 描述折叠（2026-10-12，与会审卡同款）：长的才给钮，展开后卡内另起一块铺全文。
                    任务描述长
                      ? h('button', {
                          key: 'desctog', type: 'button', className: 'dshmind-descToggle',
                          onClick: function () { 切描述折叠(任务id); },
                          title: 任务折 ? '展开描述全文' : '收起描述',
                        }, (任务折 ? '▸ 展开全文（' + 任务描述.length + ' 字）' : '▾ 收起描述'))
                      : null,
                    任务描述长 && !任务折
                      ? h('div', { key: 'descfull', className: 'dshmind-nodeTitleOpen' }, 任务描述)
                      : null,
                    h('div', { key: 'c', className: 'dshmind-criteria' }, [
                      h('span', { key: 'k', style: { color: 'var(--dsw-alias-label-tertiary,#81858c)' } }, '判据：'),
                      // 优化批⑤：长判据最多两行（.dshmind-criteriaVal 的 line-clamp），截断不丢信息——
                      // 有值才挂 title 给全文；「（缺失）」占位不是可展开的信息，那条分支不挂。
                      h('span', {
                        key: 'v',
                        className: 'dshmind-criteriaVal',
                        title: criteria.length ? criteria.join('；') : undefined,
                      }, criteria.length ? criteria.join('；') : '（缺失 —— 建节点时必填）'),
                    ]),
                    h('div', { key: 'b', className: 'dshmind-chips' }, [
                      只读历史 ? badge('历史判据 · 只读') : 已终止 ? badge('终止记录 · 只读') : frozen ? badge('判据冻结') : badge('判据可改', 'warn'),
                      pending ? badge('待决项', 'warn') : null,
                      !只读历史 && !已终止 && 无活动.length ? badge(无活动.length + ' 位负责人未见活动', 'warn') : null,
                      !只读历史 && !已终止 && rejects >= 2 ? badge('打回 ' + rejects + ' 次 · 升级主权者', 'red') : null,
                      !只读历史 && !已终止 && task.升级 ? badge('升级：' + line(task.升级), 'red') : null,
                      outputs.length ? h('span', { key: 'a', className: 'dshmind-meta' }, '产物 ' + outputs.length + ' 项') : null,
                    ].filter(Boolean)),
                    已终止 ? h('div', { key: 'closed', className: 'dshmind-meta' }, '终止原因：' + line(task.终止 && task.终止.原因, '未记录') + '。' + line(task.写入说明, '组织任务已终止；宿主停止未确认，在途工具未被取消。')) : null,
                    task.前序任务 ? h('div', { key: 'predecessor', className: 'dshmind-meta' }, '前序任务：' + line(task.前序任务)) : null,
                    task.接续提醒 ? h('div', { key: 'lineage', className: 'dshmind-meta' }, '接续提醒（来源 ' + line(task.接续提醒.来源任务) + '，处置未确认）：'
                      + (task.接续提醒.前序升级 ? '原升级事实保留。' : task.接续提醒.阈值提醒 ? '累计打回达到阈值，未确认原升级事件。' : '')
                      + (task.接续提醒.前序待决 ? '前序待决：' + line(task.接续提醒.前序待决.原因, '未记录') + '；接续不代表已裁决。' : '')) : null,
                    task.后继任务 ? h('div', { key: 'successor', className: 'dshmind-meta' }, '后继任务：' + line(task.后继任务) + '；下游依赖未自动迁移') : null,
                    task.待决原因 ? h('div', { key: 'w', className: 'dshmind-decideWhy' }, (只读历史 ? '历史待决说明（只读）：' : 已终止 ? '终止前待决说明：' : '待决原因：') + line(task.待决原因)) : null,
                    outputs.length
                      ? h('div', { key: 'chips', className: 'dshmind-chips' },
                          outputs.slice(0, 4).map(function (ref, i) {
                            // chip 是 nowrap+ellipsis 的（max-width 230px）：引用长了会省略，
                            // 挂 title 全文——截断不许丢信息（UI 卫生批）。
                            return h('span', { key: 'c' + i, className: 'dshmind-chip dshmind-mono', title: refText(ref) }, ref);
                          }))
                      : null,
                  ].filter(Boolean));
                }))
            : emptyGuide('任务图为空', '从建一张卡开始：判据在派发后冻结，先想清「什么样算验收通过」' + 他处有账(项目清单, 当前项目),
              "mind {action:'task_create', 描述:'示例：校准一条拒绝理由', 判据:'每条拒绝都带可执行的理由'}"),
            view && tasks.length > TASK_LIMIT
              ? h('div', { key: 'more', className: 'dshmind-empty' }, '另有 ' + (tasks.length - TASK_LIMIT) + ' 个节点未在此列出（工作台投影可展开）。')
              : null,
          ]),

        // ④ 审计流
        // **别静默截断**（Batch 9）这条没变：`AUDIT_LIMIT` 只是"一次渲染多少行"的上限，
        // 超出时必须**看得出来**（「投影共 N 条 · 已列 M 条」）并且**能铺开**。
        // ⚠️ 2026-10-13 晚改形：**去掉卡内滚动框**。审计自成一页后，根容器就是滚动容器 ⇒
        // 框内再套一个 `overflow-y:auto` 是双层滚动（滚轮在框里框外还不一样），
        // 而且内容被压在一个小盒子里看不见。现在行**直接进页面流**，铺开靠「展开全部」钮
        // （纯显示、零请求，同折叠钮）。
        section(4, '审计流', '只增的事实记录 · 写入无条件 · 页面滚动',
          audit.length ? '已列 ' + audit.length + (审计总条数 > audit.length ? ' / 共 ' + 审计总条数 : '') : '',
          audit.length
            ? [
                h('div', { key: 'list', className: 'dshmind-audit' }, audit.map(function (row, index) {
                  var grade = auditGrade(row);
                  var alarm = boolOf(firstOf(row, ['告警', 'alarm'])) === true;
                  return h('div', { key: 'a' + index, className: 'dshmind-auditRow ' + auditClass(row) }, [
                    h('span', { key: 't', className: 'dshmind-mono', style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary,#81858c)' } },
                      shortTime(firstOf(row, ['时间', 'at', 'time'])) || '—'),
                    h('span', { key: 'g', style: { fontSize: 11 } }, grade),
                    h('span', { key: 'a', className: 'dshmind-auditAction' }, [
                      alarm ? h('span', { key: 'x', style: { color: RED, marginRight: 4 } }, '⚑') : null,
                      line(firstOf(row, ['动作', 'action']), '未命名动作'),
                      line(firstOf(row, ['结果', 'result'])) ? h('span', { key: 'r', style: { color: 'var(--dsw-alias-label-tertiary,#81858c)' } }, ' · ' + line(firstOf(row, ['结果', 'result']))) : null,
                    ].filter(Boolean)),
                    h('span', { key: 'w', className: 'dshmind-auditWho', title: actorOf(row) }, 短主体(actorOf(row))),
                  ]);
                })),
                // 尾部说明 + 铺开钮：有多少条、看不全怎么铺开（不让人猜是不是被裁了）。
                h('div', { key: 'hint', className: 'dshmind-auditHint' }, [
                  h('span', { key: 't' }, 审计总条数 > audit.length
                    ? '投影共 ' + 审计总条数 + ' 条 · 已列 ' + audit.length + ' 条'
                    : '投影共 ' + 审计总条数 + ' 条，已全部列出'),
                  audit.length > AUDIT_LIMIT || 审计总条数 > AUDIT_LIMIT
                    ? h('button', {
                        key: 'b', type: 'button', className: 'dshmind-toggle',
                        onClick: function () { 切审计展开(); },
                        title: 审计展开() ? '只列最近的一批' : '把投影里的审计全铺开',
                      }, 审计展开() ? '▾ 收起（只列最近 ' + AUDIT_LIMIT + ' 条）' : '▸ 展开全部（共 ' + 审计总条数 + ' 条待铺开）')
                    : null,
                ].filter(Boolean)),
              ]
            : h('div', { className: 'dshmind-empty' }, '审计尾为空 —— 没有事实记录，或工作台投影未附带审计尾。')),

        // ⑤ 消息总线（⑦·2026-10-11）：**全部**有消息的线程（不只未投递）——
        // 「有没有人想说话」一眼可见；未投递 >0 高亮。会审讨论线程按盲评口径收起正文
        // （投影层已收走 发件/正文，这里只画标记与规模行——与独立答案的遮罩同一条纪律）。
        //
        // 2026-10-12（主权者指令「（总线）也默认收起呗」）：本区从**静默截断**改为**折叠**。
        // 旧版 `slice(0, BUS_LIMIT)` + `slice(-BUS_MSGS_LIMIT)` 会让超出的线程/消息直接消失、
        // 还不说少了多少——与本仓「别静默截断（Batch 9）」相悖。现在：数据全在（投影已给全量），
        // 默认只画预览，点钮铺开全部，并**明说还有多少**。纯显示、零请求（同「独立答案」「描述」折叠）。
        section(5, '消息总线', '§7 结构化通信 · 全部线程 · 未投递高亮 · 投影只读',
          总线.length ? 总线.length + ' 线程' : '',
          总线.length
            ? h('div', { className: 'dshmind-reviews' }, (function () {
                // 线程层折叠：默认画 BUS_PREVIEW 个，其余收起（全都在，随时可铺开）。
                var 线程展开 = !总线折叠('线程:全部');
                var 画线程 = 线程展开 ? 总线 : 总线.slice(0, BUS_PREVIEW);
                var 行 = 画线程.map(function (row, index) {
                var 线程id = line(row.线程, 'bus-' + index);
                // 消息层折叠：默认画最新的 BUS_MSGS_PREVIEW 条，其余收起。
                var 消息键 = '消息:' + 线程id;
                var 消息展开 = !总线折叠(消息键);
                var 全部消息 = arr(row.最新);
                var 画消息 = 消息展开 ? 全部消息 : 全部消息.slice(-BUS_MSGS_PREVIEW);
                var 收起消息数 = 全部消息.length - 画消息.length;
                return h('article', { key: 线程id, className: 'dshmind-bus' }, [
                  h('div', { key: 'top', className: 'dshmind-reviewTop' }, [
                    h('span', { key: 't', className: 'dshmind-nodeTitle', title: row.线程 }, row.线程 || '（未命名线程）'),
                    h('span', { key: 'c', className: 'dshmind-mono' }, (row.条数 || 0) + ' 条'),
                    // 未投递高亮：warn 徽章——这是本区唯一要用颜色喊的事。
                    row.未投递 > 0 ? badge('未投递 ' + row.未投递, 'warn') : null,
                    row.会审讨论段 ? badge('会审讨论段 · 盲评保护', 'warn') : null,
                  ].filter(Boolean)),
                  row.会审讨论段
                    ? h('div', { key: 'mask', className: 'dshmind-decideWhy' },
                        '讨论发言按盲评口径收起（未交齐不揭名）；讨论读数见上方会审区。')
                    : (全部消息.length
                        ? h('div', { key: 'msgs', className: 'dshmind-busMsgs' }, [
                            // 消息层：被收起时明说还有多少条（不静默）。
                            收起消息数 > 0
                              ? h('button', {
                                  key: 'msgtog', type: 'button', className: 'dshmind-descToggle',
                                  onClick: function () { 切总线折叠(消息键); },
                                  title: '展开该线程的全部消息',
                                }, '▸ 另有 ' + 收起消息数 + ' 条（展开全部 ' + 全部消息.length + ' 条）')
                              : (全部消息.length > BUS_MSGS_PREVIEW
                                  ? h('button', {
                                      key: 'msgtog2', type: 'button', className: 'dshmind-descToggle',
                                      onClick: function () { 切总线折叠(消息键); },
                                      title: '收起',
                                    }, '▾ 收起')
                                  : null),
                            h('div', { className: 'dshmind-busMsgs' }, 画消息.map(function (m, i) {
                              // 扫描行：时间/类型/发件/正文。
                              // 2026-10-12：投影层现在给**全量正文**（收窄挪到这里），
                              // 所以超长的正文用**折叠预览**而不是丢掉——点钮看全文。
                              var 正文全 = String(m.内容 || '');
                              var 正文键 = '正文:' + 线程id + '#' + m.id;
                              var 正文折 = 总线折叠(正文键);
                              var 正文长 = m.正文原长 > 0 ? m.正文原长 : 正文全.length;
                              var 要折 = 正文长 > BUS_TEXT_PREVIEW;
                              var 摘要 = (m.状态 === '暂不投递' ? '⏸ ' : '') + (正文全 || '（空消息）');
                              var 单元格 = h('span', {
                                key: 'c',
                                className: 'dshmind-busText' + (要折 && 正文折 ? ' dshmind-busTextClamped' : ''),
                                // 折叠预览时 title 给全文（截断不丢信息的 UI 卫生口径）；
                                // 展开态不再挂 title（正文就在页面上，重复挂反而挡视线）。
                                title: 要折 && 正文折 ? 摘要 : undefined,
                              }, 摘要);
                              return h('div', { key: 'm' + i, className: 'dshmind-busRow' }, [
                                // 元信息独立一行（时间/类型/发件）——不再和正文抢同一行的宽度。
                                h('div', { key: 'meta', className: 'dshmind-busMeta' }, [
                                  h('span', { key: 't', className: 'dshmind-mono', style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary,#81858c)' } },
                                    shortTime(m.追加于) || '—'),
                                  h('span', { key: 'k', className: 'dshmind-chip' }, m.类型 || '?'),
                                  m.发件 ? h('span', { key: 'f', className: 'dshmind-chip dshmind-mono', title: m.发件 }, 短主体(m.发件)) : null,
                                ].filter(Boolean)),
                                // 正文独占下一行、吃满宽度（正文才是要读的东西）。
                                // 独立类名：不再借审计动作列的口径（两套口径合流正是上面那个 bug）。
                                h('div', { key: 'cw', className: 'dshmind-busTextWrap' }, [
                                  单元格,
                                  要折
                                    ? h('button', {
                                        key: 'txtog', type: 'button', className: 'dshmind-descToggle',
                                        onClick: function () { 切总线折叠(正文键); },
                                        title: 正文折 ? '展开该条正文全文' : '收起正文',
                                      }, 正文折 ? '▸ 展开全文（' + 正文长 + ' 字）' : '▾ 收起')
                                    : null,
                                ]),
                              ].filter(Boolean));
                            })),
                          ])
                        : null),
                ].filter(Boolean));
                });
                // 线程层：被收起时明说还有多少线程（总线程数由投影给，算得出）。
                var 收起线程数 = 总线.length - 画线程.length;
                if (收起线程数 > 0) {
                  行.push(h('button', {
                    key: 'bustog', type: 'button', className: 'dshmind-descToggle',
                    onClick: function () { 切总线折叠('线程:全部'); },
                    title: '展开全部线程',
                  }, '▸ 另有 ' + 收起线程数 + ' 个线程（展开全部 ' + 总线.length + ' 个）'));
                } else if (总线.length > BUS_PREVIEW) {
                  行.push(h('button', {
                    key: 'bustog2', type: 'button', className: 'dshmind-descToggle',
                    onClick: function () { 切总线折叠('线程:全部'); },
                    title: '收起',
                  }, '▾ 收起线程'));
                }
                return 行;
              })())
            : emptyGuide('消息总线上还没有消息', '成员间结构化通信走这里（bus_send 落线即出现）' + 他处有账(项目清单, 当前项目),
              "mind {action:'bus_send', 线程:'通报-示例', 类型:'广播', 内容:'一句话正文', 收件:'lead'}"),
        ),

        // 页脚：只读边界与命令回显
        h('footer', { key: 'foot', className: 'dshmind-foot' }, [
          h('span', { key: 'b' }, boundReadOnly === true ? '共享工作台：投影只读 ✓' : boundReadOnly === false ? '⚠ 边界未声明只读' : '边界：未知'),
          h('span', { key: 'c' }, '命令 ' + COMMAND),
          h('span', { key: 's' }, '会话 ' + (snap.sessionId ? snap.sessionId.slice(0, 12) : '—') + (snap.source ? '（' + snap.source + '）' : '')),
          view ? h('span', { key: 'm' }, '待你决定 ' + 待你决定.length + ' 项 · 会审 ' + 会审.length + ' 场 · 任务 ' + tasks.length + ' 节点') : null,
          view && view.记忆
            ? h('span', { key: 'mem' },
                '记忆 存量 ' + (view.记忆.存量 === null ? '—' : view.记忆.存量)
                  + (view.记忆.新增 === null ? '' : ' · 近' + (view.记忆.窗口天 || 7) + '天 +' + view.记忆.新增 + '（晋升 ' + (view.记忆.晋升 === null ? '—' : view.记忆.晋升) + '）'))
            : null,
          view && view.视图 ? h('span', { key: 'v' }, '视图 ' + view.视图) : null,
        ].filter(Boolean)),
      ];

      // 两层（2026-10-12）：root = 铺满 + 滚动容器；page = 内容居中（宽度随设计走，2026-10-13 起 1180px）。
      // 鼠标落在左右空白上时命中的是 root（它铺满整屏）⇒ 也能滚。
      // 2026-10-13 重做：page 里再分「导航 + 七个页容器」——分页只收显示，节点仍在树里（见 分页外壳）。
      var 页 = 分页外壳(children, {
        view: view,
        待你决定: 待你决定,
        会审: 会审,
        tasks: tasks,
        总线: 总线,
        audit: audit,
        审计总条数: 审计总条数,
        记忆: view ? view.记忆 : null,
        能力: view ? view.能力 : null,
        岗位: view ? view.岗位 : null,
        实例计数: view ? view.实例计数 : null,
        岗位闲置: view ? view.岗位闲置 : null,
      });
      return h('div', { className: 'dshmind-root', 'data-dshmind': 'root' }, [
        h('div', { key: 'page', className: 'dshmind-page', 'data-dshmind': 'page' }, 页),
      ]);
    }

    // ── 侧边栏入口 ──────────────────────────────────────────────────────────
    /**
     * 侧边栏的**面板图标**（`sidebar.panellist`，list 协议，由
     * `@deepseek-ai/dsh-client-ui-sidebar` 声明）。
     *
     * ⚠️ 这个席位只画**图标**。侧边栏自己的 `PanelRow` 负责整行：
     * 行按钮、`aria-current`、`label`、以及点击后的 `selectPanel(id)`。
     * 我注册进去的组件被塞在 `span.panelGlyph` 里，收到 `{ size, active }`。
     *
     * 所以这里**不能**有按钮、文字或 onClick —— 那样会与宿主那一行叠成两层可点区域，
     * 并且把标签画两遍。顺序由注册时的 `order` 决定：插件入口是 0，本组件 10，于是排在它下面。
     */
    function MindGlyph(props) {
      var size = props && typeof props.size === 'number' ? props.size : 16;
      var active = !!(props && props.active);
      var attention = useStore(投影store);
      var count = attention.phase === 'live' && !attention.stale && attention.view ? attention.view.待你决定.length : 0;
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        focusable: 'false',
        'aria-hidden': 'true',
        // 颜色随行（currentColor）：选中/悬停交给侧边栏的样式，这里只改浓淡。
        style: { display: 'block', opacity: active ? 1 : 0.72 },
      }, [
        h('circle', { key: 'r', cx: 8, cy: 8, r: 6.3, fill: 'none', stroke: 'currentColor', strokeWidth: 1.1, opacity: 0.45 }),
        count ? h('text', { key: 'count', x: 8, y: 11, textAnchor: 'middle', fill: 'currentColor', fontSize: count > 9 ? 7 : 9, fontWeight: 700 }, count > 9 ? '9+' : String(count)) : h('circle', { key: 'c', cx: 8, cy: 8, r: 2.7, fill: 'currentColor' }),
        count ? h('title', { key: 'hint' }, '当前项目有 ' + count + ' 件事待你决定') : null,
        ...[0, 1, 2, 3].map(function (i) {
          var angle = (Math.PI / 2) * i + Math.PI / 4;
          return h('circle', {
            key: 'd' + i,
            cx: (8 + Math.cos(angle) * 6.3).toFixed(2),
            cy: (8 + Math.sin(angle) * 6.3).toFixed(2),
            r: 1.05,
            fill: 'currentColor',
            opacity: 0.7,
          });
        }),
      ]);
    }

    // ── 设置页：心智设置（`settings.section`）────────────────────────────────
    /**
     * 一行：左「标题 + 说明」，右控件 —— 与官方设置页其它分区同一套排法。
     * 传 `null` 当控件时不产生右栏（**不留空容器**：空块在版面上是"渲染坏了"的样子）。
     *
     * 纯渲染帮手（不碰状态），所以挂在**模块级**：定义在组件体内会每渲染重建一遍，
     * 而且失联保险区与调度授权区两处都要用 —— 单源，各调各的。
     *
     * `变体` 目前只认 `'field'`：长文本字段行 —— 标题与输入框**上下排**、输入框吃满行宽
     * （右栏定宽会被 flex 挤到截断，2026-10-17 截图实测）。
     */
    function 设置行(key, 标题, 说明, 控件, 变体) {
      var id = 'dshmind-setting-' + key;
      var controls = arr(Array.isArray(控件) ? 控件 : [控件]).map(function (control) {
        return control && control.props && ['input', 'select', 'textarea'].indexOf(control.type) >= 0
          ? h(control.type, Object.assign({}, control.props, { id: id, 'aria-describedby': 说明 ? id + '-hint' : undefined }), control.props.children) : control;
      });
      return h('div', { key: key, className: 'dshmind-set__row' + (变体 === 'field' ? ' dshmind-set__row--field' : '') }, [
        h('div', { key: 't', className: 'dshmind-set__texts' }, [
          h('label', { key: 'l', className: 'dshmind-set__label', htmlFor: id }, 标题),
          说明 ? h('div', { key: 'h', id: id + '-hint', className: 'dshmind-set__hint' }, 说明) : null,
        ]),
        控件 ? h('div', { key: 'c', className: 'dshmind-set__control' }, controls) : null,
      ]);
    }
    /** 只读读数行：值是文字，没有控件（也不产生空的右侧栏）。与 `设置行` 同排法。 */
    function 设置读数行(key, 标题, 说明, 值节点) {
      return h('div', { key: key, className: 'dshmind-set__row' }, [
        h('div', { key: 't', className: 'dshmind-set__texts' }, [
          h('div', { key: 'l', className: 'dshmind-set__label' }, 标题),
          说明 ? h('div', { key: 'h', className: 'dshmind-set__hint' }, 说明) : null,
        ].filter(Boolean)),
        h('div', { key: 'c', className: 'dshmind-set__control' }, [
          h('span', { key: 'v', className: 'dshmind-set__value' }, 值节点),
        ]),
      ]);
    }

    /**
     * 官方设置页里的「心智设置」分区。
     *
     * 为什么单开一页而不塞回看板：**看板面板 ≠ 设置页**。
     * 看板是常驻运维视图，§9 三条硬规则之三「工作台只读」管着它 —— 面板里**一个写控件都不许有**。
     * 而失联限制 / 响应期限小时是主权者要改的**设置**：它需要一个能写的地方，
     * 那个地方就是这里，和只读面板分开，两边互不破对方的规矩。
     *
     * 数据通道与看板**复用同一条**（同源 `fetch` 路由，见 `runCommand`），
     * 命令是 `mind presence`：读不带参数、写带 `开关=` / `小时=`。
     * 页面自己只维护「表单草稿 + 最近一次读数」，值一律以**回读**为准。
     *
     * 主人（宿主）只传 `{close}`。
     */
    function 刷新信息(force) {
      if (!信息页已访问 || (!force && Date.now() - 信息最近读取 < 15000)) return Promise.resolve({ ok: false, error: '等待下次读取' });
      信息最近读取 = Date.now(); var ticket = ++信息请求序;
      var url = '/plugins/dsh-mind/information?limit=10&offset=' + 信息参数.offset + (信息参数.query ? '&query=' + encodeURIComponent(信息参数.query) : '');
      return runCommand(activeCtx, '', { method: 'GET', path: url }).then(function (out) {
        if (ticket !== 信息请求序) return { ok: false, error: '信息回读已被新请求替代' };
        var data = out.ok && out.value.数据;
        if (out.ok && (!data || !obj(data.config) || !Array.isArray(data.sources) || !obj(data.materials) || !obj(data.growth) || !obj(data.candidates))) out = { ok: false, error: '信息收录未返回完整读数。' };
        if (out.ok) data.runtime = out.value.runtime || null;
        发通知(信息store, { phase: out.ok ? 'live' : 'error', data: out.ok ? data : null, error: out.ok ? '' : out.error });
        return out;
      });
    }

    function 信息成长设置() {
      信息页已访问 = true;
      var snapshot = useStore(信息store); var data = snapshot.data;
      var busyState = useState(false); var busy = busyState[0]; var setBusy = busyState[1];
      var lock = useState(function () { return { saving: false }; })[0];
      var noticeState = useState(''); var notice = noticeState[0]; var setNotice = noticeState[1];
      var sourceState = useState({ name: '', path: '', purpose: '两者', project: '', audience: 'lead', roles: '', recursive: true });
      var source = sourceState[0]; var setSource = sourceState[1];
      var configState = useState(null); var draft = configState[0]; var setDraft = configState[1];
      var configRevisionState = useState(null); var draftRevision = configRevisionState[0]; var setDraftRevision = configRevisionState[1];
      var tabState = useState('materials'); var tab = tabState[0]; var setTab = tabState[1];
      var searchState = useState(''); var search = searchState[0]; var setSearch = searchState[1];
      var pagesState = useState([]); var pages = pagesState[0]; var setPages = pagesState[1];
      var previewState = useState(null); var preview = previewState[0]; var setPreview = previewState[1];
      var editState = useState(null); var edit = editState[0]; var setEdit = editState[1];
      var relationshipState = useState(''); var relationship = relationshipState[0]; var setRelationship = relationshipState[1];
      var confirmState = useState(null); var confirmation = confirmState[0]; var setConfirmation = confirmState[1];
      useEffect(function () { 刷新信息(true); }, []);
      function patchSource(k, v) { var next = Object.assign({}, source); next[k] = v; setSource(next); }
      function patchConfig(k, v) { if (!draft) setDraftRevision(data.configRevision); var next = Object.assign({}, draft || data.config); next[k] = v; setDraft(next); }
      function refresh() { return 刷新信息(true); }
      function relationshipSession() { var value = resolveSessionId(activeCtx); if (!value.id || value.source === 'sessions.list · 末条') { setNotice('没有确认当前可见会话，请先打开目标会话；不会猜测关联对象。'); return null; } return value.id; }
      function send(body, after) {
        if (lock.saving) return; lock.saving = true; setBusy(true); setNotice('正在处理并核对…');
        return runCommand(activeCtx, '', { method: 'POST', path: '/plugins/dsh-mind/information', body: body }).then(function (out) {
          return refresh().then(function (back) {
            setNotice(out.ok && back.ok ? '已处理，最新状态已重新读取。' : out.ok ? '操作已返回；状态回读失败，请重新读取核对。' : out.error + '；请核对最新状态后再操作。');
            if (out.ok && back.ok && after) after(back.value.数据);
          });
        }).then(function () { lock.saving = false; setBusy(false); }, function () { lock.saving = false; setBusy(false); setNotice('操作未完整确认，请重新读取核对。'); });
      }
      function sourceInput(label, name, type) {
        return 设置行('information-' + name, label, '', h('input', { className: 'dshmind-set__input', type: type || 'text', 'aria-label': label,
          value: source[name], disabled: busy, onChange: function (event) { patchSource(name, event.target.value); } }));
      }
      function button(label, click, disabled) { return h('button', { type: 'button', className: 'dshmind-set__btn', disabled: busy || disabled, onClick: click }, label); }
      function openMaterial(item, offset, hashValue, version) {
        var url = '/plugins/dsh-mind/information-material?id=' + encodeURIComponent(item.id) + '&offset=' + (offset || 0) + (hashValue ? '&hash=' + encodeURIComponent(hashValue) : '') + (version ? '&version=' + version : '');
        runCommand(activeCtx, '', { method: 'GET', path: url }).then(function (out) {
          if (out.ok) setPreview(out.value.数据); else setNotice(out.error);
        });
      }
      function saveSource() {
        var value = { name: source.name, path: source.path, purpose: source.purpose, recursive: source.recursive, enabled: true,
          extensions: ['.md', '.txt', '.json', '.jsonl', '.html', '.htm', '.vtt', '.srt'],
          scope: { project: source.project.trim() || null, audience: source.audience, roles: source.audience === 'roles' ? source.roles.split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean) : [], relationship: source.relationship || null } };
        if (source.id) value.id = source.id;
        send({ op: 'source_save', expectedRevision: source.expectedRevision === undefined ? data.configRevision : source.expectedRevision, source: value }, function () { setSource({ name: '', path: '', purpose: '两者', project: '', audience: 'lead', roles: '', recursive: true }); });
      }
      var config = draft || (data && data.config);
      var page = data && data[tab];
      var stateLabels = { active: '使用中', dormant: '暂时淡去', withdrawn: '已撤回', 'needs-review': '待重新理解', missing: '来源不可用', error: '读取失败' };
      return h('section', { className: 'dshmind-set__section', 'data-dshmind': 'information-settings', 'aria-label': '见闻与成长' }, [
        h('h3', { className: 'dshmind-set__subtitle' }, '见闻与成长'),
        h('p', { className: 'dshmind-set__hint' }, '在会话中分享链接、文件或说“这个记一下”即可。这里连接资料目录，查看 Lead 的兴趣、回忆和能力候选，也可以纠正它。'),
        snapshot.phase === 'error' ? h('p', { role: 'alert' }, snapshot.error) : null,
        !data ? h('p', { role: 'status' }, '正在读取见闻与成长…') : null,
        button('刷新见闻与成长', refresh),
        data ? h('div', null, [
          h('p', null, (data.config.paused ? '阅读已暂停' : '阅读已开启') + ' · 今日提供 ' + data.usage.readChars + ' / ' + data.config.dailyReadChars + ' 字符 · 辅助阅读 ' + data.usage.modelCalls + ' / ' + data.config.dailyModelCalls + ' 次'),
          button(data.config.paused ? '恢复阅读' : '暂停阅读', function () { send({ op: 'configure', expectedRevision: data.configRevision, config: Object.assign({}, data.config, { paused: !data.config.paused }) }); }),
          h('details', { className: 'dshmind-set__details' }, [
            h('summary', null, '阅读节奏与预算'),
            ['autoScan', 'autoLearn'].map(function (name, i) { return 设置行('information-' + name, i ? '自动整理收获' : '自动收录目录更新', '', h('input', { type: 'checkbox', 'aria-label': i ? '自动整理收获' : '自动收录目录更新', checked: config[name], disabled: busy, onChange: function (event) { patchConfig(name, event.target.checked); } })); }),
            ['dailyReadChars', 'dailyModelCalls'].map(function (name, i) { var label = i ? '每日辅助阅读次数' : '每日阅读字符上限'; return 设置行('information-' + name, label, '', h('input', { type: 'number', min: 0, max: i ? 100 : 1000000, className: 'dshmind-set__input', 'aria-label': label, value: config[name], disabled: busy, onChange: function (event) { patchConfig(name, Number(event.target.value)); } })); }),
            h('p', { className: 'dshmind-set__hint' }, '预算按 UTC 日计算，次数含失败尝试。自动整理使用当前 Lead 的模型，在轮末运行；没有可用模型时资料保持待阅读。这些读数不等于 token 或费用。'),
            draft && draftRevision !== data.configRevision ? h('p', { role: 'status' }, '阅读设置已在别处更新，草稿保留；放弃草稿并核对当前设置后再修改。') : null,
            button('保存阅读设置', function () { send({ op: 'configure', expectedRevision: draftRevision, config: config }, function () { setDraft(null); }); }, !draft || draftRevision !== data.configRevision),
            draft ? button('放弃阅读设置修改', function () { setDraft(null); }) : null,
          ]),
          h('h4', { className: 'dshmind-set__groupTitle' }, '信息来源'),
          data.sources.length ? data.sources.map(function (s) { return h('article', { key: s.id, style: { padding: '12px 0', borderBottom: '1px solid var(--dsw-alias-border-l2,#444)' } }, [
            h('strong', null, s.name), h('p', { className: 'dshmind-set__mono' }, s.path),
            h('p', { className: 'dshmind-set__hint' }, (s.enabled ? '已连接' : '已停用') + ' · ' + s.purpose + ' · ' + (s.scope.project || '跨项目') + ' · ' + (s.scope.audience === 'lead' ? '仅 Lead' : '共享给 ' + s.scope.roles.join('、')) + (s.scanPending ? ' · 本轮扫描未完，下批续接' : '') + (s.lastError ? ' · ' + s.lastError : '')),
            button('编辑来源 ' + s.name, function () { setSource({ id: s.id, expectedRevision: data.configRevision, name: s.name, path: s.path, purpose: s.purpose, project: s.scope.project || '', audience: s.scope.audience, roles: s.scope.roles.join(','), relationship: s.scope.relationship, recursive: s.recursive }); }),
            button((s.enabled ? '停用 ' : '启用 ') + s.name, function () { var v = {}; ['id', 'name', 'path', 'recursive', 'extensions', 'purpose', 'scope'].forEach(function (k) { v[k] = s[k]; }); v.enabled = !s.enabled; send({ op: 'source_save', expectedRevision: data.configRevision, source: v }); }),
            button('断开 ' + s.name, function () { setConfirmation({ label: '断开来源 ' + s.name + ' 后，其派生资料停止自动使用。', body: { op: 'source_remove', id: s.id, expectedRevision: data.configRevision } }); }),
          ]); }) : h('p', null, '尚未连接目录。可以连接外部插件导出目录，也可以连接你的本地知识库。'),
          h('details', { className: 'dshmind-set__details', open: source.id ? true : undefined }, [
            h('summary', null, source.id ? '编辑信息来源' : '连接一个目录'), sourceInput('来源名称', 'name'), sourceInput('本地目录绝对路径', 'path'),
            设置行('information-purpose', '阅读用途', '', h('select', { 'aria-label': '阅读用途', value: source.purpose, disabled: busy, onChange: function (e) { patchSource('purpose', e.target.value); } }, ['两者', '探索', '专业'].map(function (v) { return h('option', { value: v }, v); }))),
            sourceInput('所属项目（留空跨项目）', 'project'),
            设置行('information-audience', '可用范围', '', h('select', { 'aria-label': '可用范围', value: source.audience, disabled: busy, onChange: function (e) { patchSource('audience', e.target.value); } }, [h('option', { value: 'lead' }, '仅 Lead'), h('option', { value: 'roles' }, 'Lead 与指定岗位') ])),
            source.audience === 'roles' ? sourceInput('共享岗位（逗号分隔）', 'roles') : null,
            设置行('information-recursive', '包含子目录', '', h('input', { type: 'checkbox', 'aria-label': '包含子目录', checked: source.recursive, disabled: busy, onChange: function (e) { patchSource('recursive', e.target.checked); } })),
            h('p', { className: 'dshmind-set__hint' }, '原目录只读，默认收录文字、JSON、网页导出和字幕。隐藏文件、链接及 Mind 自身数据跳过；其他格式不会被当成已阅读。'),
            button(source.id ? '保存信息来源' : '连接信息来源', saveSource, !source.name.trim() || !source.path.trim() || (source.audience === 'roles' && !source.roles.trim())),
          ]),
          button('现在收录一批', function () { send({ op: 'scan' }); }),
          h('h4', { className: 'dshmind-set__groupTitle' }, '材料与收获'),
          h('nav', { 'aria-label': '成长记录分类' }, ['materials', 'growth', 'candidates'].map(function (v, i) { return button(['资料', '趣味与成长', '能力候选'][i], function () { setTab(v); setPages([]); 信息参数.offset = 0; refresh(); }, v === tab); })),
          h('div', { className: 'dshmind-set__actions' }, [h('input', { className: 'dshmind-set__input', 'aria-label': '搜索材料与收获', value: search, onChange: function (e) { setSearch(e.target.value); } }), button('搜索收录记录', function () { 信息参数.query = search; 信息参数.offset = 0; setPages([]); refresh(); })]),
          page ? h('p', { className: 'dshmind-set__hint' }, page.countMode ? '资料共 ' + page.total + ' 条，本批检查 ' + page.examined + ' 条，命中 ' + page.matched + ' 条' : '共 ' + page.total + ' 条，当前从第 ' + (page.total ? page.offset + 1 : 0) + ' 条开始') : null,
          page && page.entries.map(function (r) { return h('article', { key: r.id, style: { padding: '14px 0', borderBottom: '1px solid var(--dsw-alias-border-l2,#444)' } }, [
            h('strong', null, r.title), h('p', { className: 'dshmind-set__hint' }, (stateLabels[r.state] || r.state) + ' · 第 ' + r.revision + ' 版' + (r.stage ? ' · ' + r.stage : '') + (r.processing ? ' · ' + r.processing : '') + (r.sourceStatus === 'disconnected' ? ' · 来源已断开，保留快照' : r.sourceStatus === 'disabled' ? ' · 来源已停用' : '') + (r.usable === false ? ' · 暂不自动使用' : '')),
            r.text ? h('p', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, r.text) : null,
            r.method ? h('details', null, [h('summary', null, '方法、条件与试用'), h('p', null, r.method), h('p', null, r.conditions), h('p', null, r.limitations), h('pre', { style: { whiteSpace: 'pre-wrap' } }, JSON.stringify(r.trials, null, 2))]) : null,
            h('details', null, [h('summary', null, '出处'), h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, JSON.stringify(r.sources || { source: r.source, name: r.name, coverage: r.coverage }, null, 2)),
              tab === 'materials' && r.state !== 'withdrawn' ? button('查看原文 ' + r.title, function () { openMaterial(r); }) : null,
              tab === 'materials' ? r.versions.map(function (v) { return button('查看第 ' + v.revision + ' 版 ' + r.title, function () { openMaterial(r, 0, v.hash, v.revision); }, r.state === 'withdrawn'); }) : null,
            ]),
            tab !== 'materials' ? [button('查看修订与试用 ' + r.title, function () { openMaterial(r); }), button('纠正 ' + r.title, function () { setEdit({ id: r.id, revision: r.revision, text: r.text, reason: '' }); }),
              button('让它淡去 ' + r.title, function () { send({ op: 'revise', id: r.id, revision: r.revision, state: 'dormant', reason: '用户选择暂时淡去' }); }),
              button('停止使用 ' + r.title, function () { send({ op: 'revise', id: r.id, revision: r.revision, state: 'withdrawn', reason: '用户选择停止使用' }); }),
              r.state === 'dormant' || r.state === 'withdrawn' ? button('恢复使用 ' + r.title, function () { send({ op: 'revise', id: r.id, revision: r.revision, state: 'active', reason: '用户明确恢复此记录' }); }) : null,
            ] : [r.state !== 'withdrawn' ? button('撤回资料 ' + r.title, function () { send({ op: 'forget', id: r.id, revision: r.revision }); }) :
              button('删除资料快照 ' + r.title, function () { setConfirmation({ label: '删除本地资料快照及派生收获；原始文件、宿主对话和备份分别管理。', body: { op: 'purge', id: r.id, revision: r.revision } }); }),
              r.state !== 'withdrawn' ? button('分享资料 ' + r.title, function () { setEdit({ share: true, id: r.id, revision: r.revision, text: '', reason: '', roles: '' }); }) : null],
          ]); }),
          page && !page.total ? h('p', null, '这里还没有记录。没有收获时可以不写，记录数不代表成长。') : null,
          h('div', { className: 'dshmind-set__actions' }, [button('上一批收录记录', function () { 信息参数.offset = pages[pages.length - 1]; setPages(pages.slice(0, -1)); refresh(); }, !pages.length), button('下一批收录记录', function () { setPages(pages.concat([信息参数.offset])); 信息参数.offset = page.nextOffset; refresh(); }, !page || page.nextOffset === null)]),
          preview ? h('details', { open: true, className: 'dshmind-set__details' }, [h('summary', null, '原文预览 · ' + preview.title + ' · 第 ' + preview.revision + ' 版'),
            h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '360px', overflowY: 'auto' } }, preview.text),
            h('p', { className: 'dshmind-set__hint' }, preview.coverage), button('继续预览原文', function () { openMaterial(preview, preview.nextOffset, preview.hash, preview.format === 'growth-history' ? null : preview.revision); }, preview.nextOffset === null), button('关闭原文预览', function () { setPreview(null); })]) : null,
          edit ? h('div', { className: 'dshmind-set__rows' }, [
            h('h4', null, edit.share ? '明确分享所选资料' : '纠正这条收获'),
            edit.share ? 设置行('information-share-roles', '允许使用的岗位', '分享会创建一份跨项目副本，请先核对原文中的私人内容。', h('input', { 'aria-label': '允许使用的岗位', className: 'dshmind-set__input', value: edit.roles, onChange: function (e) { setEdit(Object.assign({}, edit, { roles: e.target.value })); } })) :
              h('textarea', { 'aria-label': '纠正后的收获', className: 'dshmind-set__persona', value: edit.text, onChange: function (e) { setEdit(Object.assign({}, edit, { text: e.target.value })); } }),
            设置行('information-correction-reason', '说明原因', '', h('input', { 'aria-label': '收获修订或分享原因', className: 'dshmind-set__input', value: edit.reason, onChange: function (e) { setEdit(Object.assign({}, edit, { reason: e.target.value })); } })),
            button(edit.share ? '确认分享所选资料' : '保存收获纠正', function () { send(edit.share ? { op: 'share', id: edit.id, revision: edit.revision, reason: edit.reason, scope: { project: null, audience: 'roles', roles: edit.roles.split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean), relationship: null } } :
              { op: 'revise', id: edit.id, revision: edit.revision, text: edit.text, reason: edit.reason }, function () { setEdit(null); }); }, !edit.reason.trim() || (!edit.share && !edit.text.trim()) || (edit.share && !edit.roles.trim())),
            button('取消收获编辑', function () { setEdit(null); }),
          ]) : null,
          h('details', { className: 'dshmind-set__details' }, [h('summary', null, '关联同一段关系的会话'), h('p', { className: 'dshmind-set__hint' }, '默认各会话独立。你确认当前会话属于同一人或关系时，可填写稳定标识；不依据昵称自动合并。'),
            h('input', { 'aria-label': '稳定关系标识', className: 'dshmind-set__input', value: relationship, onChange: function (e) { setRelationship(e.target.value); } }),
            button('关联当前会话', function () { var id = relationshipSession(); if (id) send({ op: 'relationship', session: id, relationship: relationship, expectedRevision: data.configRevision }); }, !relationship.trim()),
            button('恢复当前会话独立范围', function () { var id = relationshipSession(); if (id) send({ op: 'relationship', session: id, relationship: null, expectedRevision: data.configRevision }); }),
          ]),
          h('details', { className: 'dshmind-set__details' }, [h('summary', null, '最近阅读状态'),
            data.runtime && data.runtime.lastFailure ? h('p', { role: 'status' }, '上次辅助处理未完成：' + data.runtime.lastFailure.code + '（' + (data.runtime.lastFailure.phase === 'scan' ? '目录收录' : '阅读整理') + '），资料仍保留，可核对后重试。') : null,
            data.runtime && data.runtime.waitingForLead ? h('p', { className: 'dshmind-set__hint' }, '部分恢复的会话等待 Lead 身份接续；正常进入会话后再安排辅助阅读。') : null,
            data.jobs.map(function (j) { return h('p', { key: j.id }, j.at + ' · ' + ({ running: '阅读中', completed: '已整理', failed: '未完成' }[j.state] || j.state) + (j.partial ? ' · 部分材料' : '') + (j.error ? ' · ' + j.error : '') + (j.records ? ' · 关联 ' + j.records.length + ' 条记录（含复用）' : '')); })]),
        ]) : null,
        confirmation ? h('div', { role: 'alert', className: 'dshmind-set__notice' }, [h('p', null, confirmation.label), button('确认这次操作', function () { send(confirmation.body, function () { setConfirmation(null); }); }), button('取消这次操作', function () { setConfirmation(null); })]) : null,
        notice ? h('p', { role: 'status', className: 'dshmind-set__hint' }, notice) : null,
      ]);
    }

    function 心智设置(props) {
      var close = props && typeof props.close === 'function' ? props.close : null;
      // ⚠️ 读数来自**模块级 store**（由 `apply` 的裸 setInterval 轮询喂），**不来自 effect**：
      // 这个宿主的 `useEffect` 很可能是空实现 ⇒ 挂在它上面的取数永远不会跑。
      var snap = useStore(设置store);
      var actionLocks = useState(function () { return { policy: false, delegation: false, persona: false, refreshing: false }; })[0];
      var refreshing = useState(false);
      // 核心人设独立保存，轮询只更新读数，不覆盖正在编辑的草稿。
      人设页已访问 = true;
      var 人设快照 = useStore(人设store);
      useEffect(function () { 刷新人设(); }, []);
      var 人设表态 = useState({ text: '', fingerprint: '', dirty: false });
      var 人设表 = 人设表态[0];
      var 设人设表 = 人设表态[1];
      var 人设提示态 = useState({ saving: false, text: '', ok: false });
      var 人设提示 = 人设提示态[0];
      var 设人设提示 = 人设提示态[1];
      var 人设读数 = 人设快照.data;
      if (人设读数 && !人设表.dirty && !actionLocks.persona && 人设表.fingerprint !== 人设读数.fingerprint) {
        设人设表({ text: 人设读数.text, fingerprint: 人设读数.fingerprint, dirty: false });
      }
      var 人设有修改 = !!人设读数 && 人设表.text !== 人设读数.text;
      var 人设外部更新 = !!人设读数 && 人设表.dirty && 人设表.fingerprint !== 人设读数.fingerprint;
      var 人设字数 = Array.from(人设表.text).length;
      function 重置人设() {
        if (!人设读数 || actionLocks.persona) return;
        设人设表({ text: 人设读数.text, fingerprint: 人设读数.fingerprint, dirty: false });
        设人设提示({ saving: false, text: '', ok: false });
      }
      function 保存人设() {
        if (actionLocks.persona || !人设读数 || !人设有修改 || 人设外部更新 || 人设字数 > 3000 || !人设表.fingerprint) return;
        var requested = 人设表.text;
        actionLocks.persona = true;
        设人设提示({ saving: true, text: '正在保存并重新读取…', ok: false });
        writePersonaCore(requested, 人设表.fingerprint).then(function (out) {
          var receipt = obj(out.post.value) || {};
          var same = out.back.ok && out.back.data.text === requested && out.back.data.fingerprint === receipt.requestedFingerprint;
          var ok = !!(same && out.post.ok && receipt.commit && receipt.commit.state === 'written' && receipt.audit && receipt.audit.state === 'recorded');
          var text = ok ? '核心人设已保存并回读一致，下一轮开始读取。'
            : !out.back.ok ? '保存结果尚未确认，重新读取失败；草稿已保留。请先重新读取核对。'
            : out.back.data.text === requested ? '已回读到提交内容，但保存或审计回执未完整确认；请核对，避免重复提交。'
            : (out.post.error || '保存后内容未一致') + ' 草稿已保留。';
          if (ok) 设人设表({ text: out.back.data.text, fingerprint: out.back.data.fingerprint, dirty: false });
          actionLocks.persona = false;
          设人设提示({ saving: false, text: text, ok: ok });
        });
      }
      // ══ 调度授权区：订阅 / 草稿 / 保存链 ══
      调度页已访问 = true;
      var 调度快照 = useStore(调度store);
      useEffect(function () { 刷新调度(); }, []);
      var 调度表态 = useState({ mode: 'explicit-user', projects: '', authorizationRef: '', fingerprint: '' });
      var 调度表 = 调度表态[0];
      var 设调度表 = 调度表态[1];
      var 调度改态 = useState(false);
      var 调度已改 = 调度改态[0];
      var 设调度已改 = 调度改态[1];
      var 调度提示态 = useState({ saving: false, text: '', ok: false });
      var 调度提示 = 调度提示态[0];
      var 设调度提示 = 调度提示态[1];
      var 调度读数 = 调度快照.data;
      if (调度读数 && !调度已改 && 调度表.fingerprint !== 调度读数.persistence.fingerprint) {
        var 当前配置 = 调度读数.persistence.config;
        设调度表({ mode: 当前配置.mode, projects: arr(当前配置.projects).join(', '), authorizationRef: 当前配置.authorizationRef || '', fingerprint: 调度读数.persistence.fingerprint });
      }

      function 改调度表(key, value) {
        if (actionLocks.delegation || 调度提示.saving) return;
        var next = Object.assign({}, 调度表);
        next[key] = value;
        var nextConfig = { mode: next.mode, projects: String(next.projects).split(/[,，\s]+/).filter(Boolean).filter(function (p, i, list) { return list.indexOf(p) === i; }).sort(), authorizationRef: String(next.authorizationRef).trim() };
        设调度已改(!调度读数 || JSON.stringify(nextConfig) !== JSON.stringify(调度读数.persistence.config));
        设调度表(next);
      }

      function 调度配置草稿() {
        return { mode: 调度表.mode, projects: String(调度表.projects).split(/[,，\s]+/).filter(Boolean).filter(function (p, i, list) { return list.indexOf(p) === i; }).sort(), authorizationRef: String(调度表.authorizationRef).trim() };
      }
      var 调度有修改 = !!调度读数 && JSON.stringify(调度配置草稿()) !== JSON.stringify(调度读数.persistence.config);
      var 调度外部更新 = !!调度读数 && 调度已改 && 调度表.fingerprint !== 调度读数.persistence.fingerprint;
      function 重置调度() {
        if (!调度读数 || actionLocks.delegation) return;
        var config = 调度读数.persistence.config;
        设调度表({ mode: config.mode, projects: arr(config.projects).join(', '), authorizationRef: config.authorizationRef || '', fingerprint: 调度读数.persistence.fingerprint });
        设调度已改(false);
        设调度提示({ saving: false, text: '', ok: false });
      }

      function 保存调度(撤回) {
        if (actionLocks.delegation || 调度提示.saving || !调度表.fingerprint || !调度读数) return;
        if (!撤回 && 调度外部更新) {
          设调度提示({ saving: false, text: '授权配置已在别处更新，草稿已保留。请先采用当前配置再修改。', ok: false });
          return;
        }
        if (!撤回 && !调度有修改) return;
        var projects = String(调度表.projects).split(/[,，\s]+/).filter(Boolean).filter(function (p, i, list) { return list.indexOf(p) === i; }).sort();
        if (撤回) projects = arr(调度读数.persistence.config.projects).slice();
        var config = { mode: 撤回 ? 'explicit-user' : 调度表.mode, projects: projects, authorizationRef: 撤回 ? 调度读数.persistence.config.authorizationRef : String(调度表.authorizationRef).trim() };
        if (config.mode === 'lead-discretion' && (!projects.length || !config.authorizationRef)) {
          设调度提示({ saving: false, text: '未提交：Lead 按需调度必须填写项目范围和授权依据。', ok: false });
          return;
        }
        actionLocks.delegation = true;
        设调度提示({ saving: true, text: '提交后将重新读取新的运行策略；超时不表示没有保存。', ok: false });
        writeDelegation(config, 调度表.fingerprint).then(function (out) {
          var post = out.post;
          var receipt = obj(post.value) || {};
          var audit = obj(receipt.audit) || {};
          var commit = obj(receipt.commit) || {};
          var text;
          var ok = false;
          if (!out.back.ok) {
            text = '提交与应用状态未知：新的 GET 回读未确认（' + out.back.error + '）。' + (post.error || '');
          } else {
            var data = out.back.data;
            var disk = data.persistence;
            var runtime = data.runtime;
            var sameConfig = JSON.stringify(disk.config) === JSON.stringify(config);
            var same = sameConfig && disk.fingerprint === runtime.fingerprint && runtime.disposed === false;
            if (same && post.ok && commit.state === 'reconciled' && audit.state === 'recorded'
              && receipt.requestedFingerprint === disk.fingerprint) {
              var ready = data.readiness && data.readiness.promptRegistered === true && data.readiness.creationGuardRegistered === true;
              ok = ready;
              text = ready ? '已保存，盘面与新的运行授权读数一致；提示词实际应用待下一轮验证。'
                : '盘面与运行授权一致，但调度接线未全部确认，不能宣称就绪。';
              设调度已改(false);
              设调度表({ mode: config.mode, projects: projects.join(', '), authorizationRef: config.authorizationRef, fingerprint: disk.fingerprint });
            } else if (same) {
              text = '盘面与运行授权已一致，但提交或审计回执未完整确认：' + (post.error || '状态未知') + '。不要盲目重试。';
            } else {
              text = (post.ok ? '已提交，但最新配置可能被其他更新替代，或运行授权尚未应用。' : '请求未确认：' + post.error + '。') + '盘面与请求/运行指纹尚未一致，未确认生效。';
            }
            text += ' 审计：' + (audit.state === 'recorded' ? '已记录' : audit.state === 'failed' ? '失败' : '未知') + '。';
          }
          actionLocks.delegation = false;
          设调度提示({ saving: false, text: text, ok: ok });
        });
      }
      // ══ 失联保险区：草稿 / 回读同步 / 保存链 ══
      // 表单草稿：**独立于读数**——回读一来就覆盖输入框，人正在打的字会被吃掉。
      var 表 = useState({ 开关: '是', 小时: '72', 介入度: '放权', 复核免审: '否' });
      var form = 表[0];
      var setForm = 表[1];
      /** 「提示 / 保存中」是**组件本地**状态（交互结果，不该被轮询抹掉）。 */
      var 提示态 = useState({ 保存中: false, 提示: '', 提示调: 'warn' });
      var 提示 = 提示态[0];
      var set提示 = 提示态[1];
      /** 表单是否已被"人改过"：改过就别再被回读刷掉（否则人正在填的字会被轮询吃掉）。 */
      var 已改 = useState(false);
      var 人改过 = 已改[0];
      var set人改过 = 已改[1];

      // 回读即真源：读数一变就把表单同步过来（**只在人没改过时**，且用 `useState` 驱动，
      // 不靠 effect）。`useState` 的初值 + 这里每次渲染的比对，等价于"受控同步"。
      // 渲染体内 setState 是**有意为之**（2026-10-12 评审 P3 复核）：React 官方认可的
      // render-phase derived-state 模式（同组件、守卫收敛 `键 !== 同步.键` ⇒ 最多多渲染
      // 一轮，不会死循环；effect 版会晚一帧闪旧值）。别「修」成 effect。
      var 读 = snap.读数;
      var 上次同步 = useState({ 键: '', 开关: '是', 小时: '72', 介入度: '放权', 复核免审: '否' });
      var 同步 = 上次同步[0];
      var set同步 = 上次同步[1];
      if (读 && !人改过) {
        var 开 = 开关态Of(读);
        var 时 = numOf(读.生效响应期限小时);
        var 档 = line(obj(读) && 读.介入度, '') || '放权';
        var 免 = boolOf(obj(读) && 读.复核免审) === true ? '是' : '否';
        var 键 = String(开) + '/' + String(时) + '/' + 档 + '/' + 免;
        if (键 !== 同步.键) {
          set同步({ 键: 键, 开关: 开 === false ? '否' : '是', 小时: 时 === null ? '' : String(时), 介入度: 档, 复核免审: 免 });
          setForm({ 开关: 开 === false ? '否' : '是', 小时: 时 === null ? '' : String(时), 介入度: 档, 复核免审: 免 });
        }
      }

      function 当前策略表() {
        if (!读) return null;
        return { 开关: 开关态Of(读) === false ? '否' : '是', 小时: numOf(读.生效响应期限小时) === null ? '' : String(numOf(读.生效响应期限小时)), 介入度: line(读.介入度, '') || '放权', 复核免审: boolOf(读.复核免审) === true ? '是' : '否' };
      }
      var 当前策略 = 当前策略表();
      var 策略有修改 = !!当前策略 && JSON.stringify(form) !== JSON.stringify(当前策略);
      var 当前策略键 = 当前策略 ? String(开关态Of(读)) + '/' + String(numOf(读.生效响应期限小时)) + '/' + 当前策略.介入度 + '/' + 当前策略.复核免审 : '';
      var 策略外部更新 = !!读 && 人改过 && 同步.键 !== 当前策略键;
      function 改策略(key, value) {
        if (actionLocks.policy || !读) return;
        var next = Object.assign({}, form); next[key] = value;
        setForm(next);
        set人改过(JSON.stringify(next) !== JSON.stringify(当前策略));
      }
      function 重置策略() {
        if (!当前策略 || actionLocks.policy) return;
        setForm(当前策略);
        set同步(Object.assign({ 键: 当前策略键 }, 当前策略));
        set人改过(false);
        set提示({ 保存中: false, 提示: '', 提示调: 'warn' });
      }
      function 手动刷新() {
        if (actionLocks.refreshing || actionLocks.policy || actionLocks.delegation || actionLocks.persona) return;
        actionLocks.refreshing = true; refreshing[1](true);
        Promise.all([刷新设置(), 刷新调度(), 刷新人设()]).then(function () { actionLocks.refreshing = false; refreshing[1](false); });
      }

      function 保存() {
        if (actionLocks.policy || 提示.保存中) return;
        // 未接入时没有回读真源：框里的值只是硬编码草稿，拿它去写等于"替盘上瞎编"。
        // 按钮已禁用，这道守的是 Enter 键那条旁路。
        if (!snap.读数) {
          set提示({ 保存中: false, 提示: '没写进去：还没读到当前设置（未接入），先「重新读取」。', 提示调: 'warn' });
          return;
        }
        if (策略外部更新) {
          set提示({ 保存中: false, 提示: '当前设置已在别处更新，草稿已保留。请先采用当前配置再修改。', 提示调: 'warn' });
          return;
        }
        if (!策略有修改) return;
        var ctx = activeCtx;
        var session = resolveSessionId(ctx);
        if (!session.id) {
          set提示({ 保存中: false, 提示: '没写进去：定位不到会话 id。', 提示调: 'warn' });
          return;
        }
        var 小时文本 = String(form.小时 === null || form.小时 === undefined ? '' : form.小时).trim();
        var 小时;
        if (小时文本 === '') {
          set提示({ 保存中: false, 提示: '没写进去：响应期限小时 必须填一个 ≥1 的整数。', 提示调: 'warn' });
          return;
        }
        小时 = Number(小时文本);
        // 上界不是「输入体检」：超过 `MAX_RESPONSE_DEADLINE_HOURS`（≈100 年）之后，
        // 失联判定要算的 `deadline = since + 小时×3600e3` 会越出 `Date` 上界，
        // `toIso()` 抛错 ⇒ 拿不到状态条。宿主侧拒它，页面也在本地就拦住并说清区间。
        if (!isFinite(小时) || Math.floor(小时) !== 小时 || 小时 < 1 || 小时 > MAX_RESPONSE_DEADLINE_HOURS) {
          set提示({
            保存中: false,
            提示: '没写进去：响应期限小时 只接受 1 ~ ' + MAX_RESPONSE_DEADLINE_HOURS
              + ' 之间的整数（上限 ≈ 100 年），收到 ' + JSON.stringify(小时文本) + '。',
            提示调: 'warn',
          });
          return;
        }
        if (form.开关 !== '是' && form.开关 !== '否') {
          set提示({ 保存中: false, 提示: '没写进去：失联限制 只接受「是 / 否」。', 提示调: 'warn' });
          return;
        }
        var 介入度 = String(form.介入度 || '');
        if (['放权', '预审', '审批'].indexOf(介入度) < 0) {
          set提示({ 保存中: false, 提示: '没写进去：介入度请选择 0% / 50% / 100%。', 提示调: 'warn' });
          return;
        }
        if (form.复核免审 !== '是' && form.复核免审 !== '否') {
          set提示({ 保存中: false, 提示: '没写进去：复核免审 只接受「是 / 否」。', 提示调: 'warn' });
          return;
        }
        // 只在**人改了这一项**时才写：不把部署原本没写过的键（生效值来自出厂层）顺手写进私有层。
        var 读档 = line(obj(读) && 读.介入度, '') || '放权';
        var 读免 = boolOf(obj(读) && 读.复核免审) === true;
        actionLocks.policy = true;
        set提示({ 保存中: true, 提示: '', 提示调: 'warn' });
        writePresence({
          ctx: ctx,
          sessionId: session.id,
          开关: form.开关,
          小时: 小时,
          介入度: 介入度 !== 读档 ? 介入度 : undefined,
          复核免审: (form.复核免审 === '是') !== 读免 ? (form.复核免审 === '是') : undefined,
        }).then(function (out) {
          actionLocks.policy = false;
          if (!out.ok) {
            // 拒绝也要**照旧显示盘上现在是什么**（走 store 的最近一次读数），并明说没写进去。
            set提示({ 保存中: false, 提示: '没写进去：宿主拒绝了（' + out.error + '）', 提示调: 'warn' });
            return;
          }
          var 差 = 回读对不上(out.请求, out.回读.读数);
          // 保存成功 ⇒ 抬水位（2026-10-12 评审 P2）：在途的轮询响应（号更旧）回来时不许
          // 盖掉刚写进的回读——不抬的话，「已保存」闪现一下就被旧读数盖回，看着像没存上。
          // （保存链不走 刷新设置，所以要显式占号 + 用掉，把 已用 抬过所有在途的号。）
          设置序号.该用(设置序号.取号());
          // 回读值**写进 store**（那才是"盘上现在是什么"的权威），UI 因此以回读为准。
          发通知(设置store, Object.assign({}, 设置store.快照, {
            phase: 'live', 读数: out.回读.读数, 设置文件: out.回读.设置文件, error: '',
          }));
          set提示({
            保存中: false,
            提示: 差 ? 差 : ('已保存，且回读一致：' + 生效读数行(out.回读.读数)),
            提示调: 差 ? 'warn' : 'ok',
          });
          if (!差) {
            // 回读可能只规范了输入格式（如 072→72），也要用已确认值清除草稿。
            set同步(Object.assign({}, 同步, { 键: '' }));
            set人改过(false);
          }
        });
      }

      // ══ 失联保险区（渲染件） ══
      var 值不合法 = !!读 && boolOf(读.值不合法) === true;
      // 设置页的读数是**对象** ⇒ 在这里一次性归一成四态（别再各处 `失联态Of(读)`）。
      var 设置四态 = 读数对象四态(读);
      var 未接入 = !读;

      // 四态 → 人话 + 点色（设置页读的是**读数对象**，走 `读数对象四态`）。
      var 态文本 = 设置四态 === '已关闭' ? '已关闭 · 不判定失联'
        : 设置四态 === '已失联' ? '已失联 · 自治冻结'
        : 设置四态 === '在位' ? '在位'
        : '未知';
      var 态色 = 设置四态 === '已失联' ? RED : 设置四态 === '已关闭' ? WARN : 设置四态 === '在位' ? GREEN : GREY;

      // 未接入（含"正在读"）：**一条紧凑提示** + 一句人话 + 一条可复制的命令。
      // 用户面前**不许**出现实现细节（函数名 / `remote.commands.execute` 之类）：
      // 要解释为什么现在不可用，就说"这一页需要一个打开的会话"。
      // ⇒ 原因必须过 `用户向原因` 那道映射（原始错误串是排障用的，不是给主人读的）。
      //
      // ⚠️ **页面永远不许停在 loading**（Batch 6 修的第二条真缺陷）：
      // 「正在读取设置…」只是**过程**，不是终态 —— 读链要么拿到读数、要么落到 error（含超时），
      // 所以这句话在收敛之后**不可能**还留在版面上。若它一直在，那就是真的没跑起来（见 `钩子缺失`）。
      var 钩子缺失提示 = 缺失的钩子.length
        ? '这一页在本客户端里跑不起来：缺少 React 的 ' + 缺失的钩子.join(' / ') + '（需要 16.8+）。'
          + '控制台有详细错误；这是客户端版本问题，不是设置问题。'
        : '';
      // 拿不到计时器 ⇒ **响亮**：不轮询这件事必须写在脸上（Batch 7 的纪律，与超时同一条）。
      var 计时器缺失提示 = 缺失的计时器.length
        ? '本客户端拿不到计时器 ' + 缺失的计时器.join(' / ') + '：这一页不会自动刷新，也不会超时。'
          + '控制台有详细错误；这是运行环境问题，不是设置问题。'
        : '';
      var 未接入原因 = 钩子缺失提示 !== '' ? 钩子缺失提示
        : 计时器缺失提示 !== '' ? 计时器缺失提示
        : snap.phase === 'reading' ? '正在读取设置…'
        : 用户向原因(snap.error);
      // 统一带上「未接入」这个前缀：**只要不是"正在读"，这一页就是"没接上"**（含超时/异常），
      // 让人一眼看出这是终态而不是还在转圈。超时那句本身已经带了「未接入：」，别叠两遍。
      if (未接入原因.indexOf('未接入') !== 0 && 未接入原因.indexOf('正在读取设置') !== 0) {
        未接入原因 = '未接入：' + 未接入原因;
      }
      var 未接入块 = 未接入
        ? h('div', { key: 'off', className: 'dshmind-set__notice' }, [
            h('div', { key: 't', className: 'dshmind-set__noticeText' }, 未接入原因),
            h('code', {
              key: 'c', className: 'dshmind-set__noticeCmd',
              title: '选中复制这条命令去执行',
            }, PRESENCE_EXAMPLE),
          ])
        : null;

      // 有读数才渲染读数与表单：没读数时不留空块（空块在版面上就是"坏了"）。
      // 读数只留「当前生效值」一行：附注里已含开关/期限/来源/当前态，
      // 来源、路径与层序一起放进配置详情，主界面只保留当前状态。
      var 读数块 = 读
        ? h('div', { key: 'rows', className: 'dshmind-set__rows' }, [
            设置读数行('now', '当前生效值', 读数附注(读), [
              // 设置页自己的点（`dshmind-set__dot`）：看板那条 `.dshmind-dot` 规则
              // 住在看板子树的 <style> 里，看板没挂载时它对设置页不存在。
              h('span', { key: 'dot', className: 'dshmind-set__dot', style: { background: 态色 } }),
              h('span', { key: 'v' }, 态文本),
            ]),
          ].filter(Boolean))
        : null;

      var 坏值块 = 读 && 值不合法
        ? h('div', { key: 'bad', className: 'dshmind-set__bad' },
            '⚠ 值不合法：原值 ' + JSON.stringify(读.原值 === undefined ? null : 读.原值)
            + '（' + line(读.原值来源, '未知') + '）已退回内置兜底 '
            + (numOf(读.生效响应期限小时) === null ? '72' : numOf(读.生效响应期限小时)) + 'h'
            + (line(读.不合法说明, '') ? ' —— ' + line(读.不合法说明, '') : ''))
        : null;

      // 表单：一个开关 + 一个数字 + 保存。控件一律带类名（不许裸默认样式）。
      // 未接入（含"正在读"）时表单**禁用**：没有回读真源，框里只是硬编码草稿，
      // 让人继续编它会像"盘上就是这样"（误导）；「重新读取」是唯一该亮的操作。
      var 表单禁用 = 未接入 || 提示.保存中 === true;
      // P1-11（全面审查 2026-10-17）：未接入时不许把写死的初值（是/72）画成读数。
      // 控件已禁用，但显示仍是「一组像真读数的设置值」——I1 只修了写、没修显示。
      // 未接入 ⇒ 控件给空值 + 「未读到」占位；真值只在有回读时出现。
      var 显示开关 = 未接入 ? '' : form.开关;
      var 显示小时 = 未接入 ? '' : form.小时;
      var 策略行 = [
        设置行('sw', '失联保险', '超过响应期限未交互时，暂停自治操作。', [
          h('select', {
            key: 'sel', className: 'dshmind-set__select',
            'aria-label': '失联保险',
            value: 显示开关,
            disabled: 表单禁用,
            onChange: function (event) {
              var next = event && event.target ? String(event.target.value) : '是';
              改策略('开关', next === '否' ? '否' : '是');
            },
          }, [
            ...(未接入 ? [h('option', { key: 'x', value: '' }, '未读到（未接入）')] : []),
            h('option', { key: 'y', value: '是' }, '开启'),
            h('option', { key: 'n', value: '否' }, '关闭'),
          ]),
        ]),
        设置行('hrs', '响应期限', '自最后一次交互起计算；关闭保险后不判定失联。', [
          h('input', {
            key: 'inp', className: 'dshmind-set__number',
            type: 'number', min: 1, step: 1,
            'aria-label': '响应期限小时',
            placeholder: 未接入 ? '未读到（未接入）' : '1 ~ 876000',
            value: 显示小时,
            disabled: 表单禁用,
            onChange: function (event) {
              改策略('小时', event && event.target ? String(event.target.value) : '');
            },
            onKeyDown: function (event) {
              if (event && event.key === 'Enter') 保存();
            },
          }),
          h('span', { key: 'unit', className: 'dshmind-set__hint' }, '小时'),
        ]),
        // v2 条目14/17：介入度三档 + 复核免审全局开关（设置项的语义见条目14/17/24）。
        设置行('intervention', '介入度', 未接入 ? '读取后可选择操作的确认方式。' : ({ 放权: '自治写入直接执行并留痕。', 预审: '改岗位、发布能力、物理删除记忆和改设置需先确认。', 审批: '每次自治写入都需先确认。' }[form.介入度] || '请选择确认方式。'), [
          h('select', {
            key: 'sel', className: 'dshmind-set__select',
            'aria-label': '介入度',
            value: 未接入 ? '' : form.介入度,
            disabled: 表单禁用,
            onChange: function (event) {
              改策略('介入度', event && event.target ? String(event.target.value) : '放权');
            },
          }, [
            ...(未接入 ? [h('option', { key: 'x', value: '' }, '未读到（未接入）')] : []),
            h('option', { key: 'f', value: '放权' }, 介入度标签('放权')),
            h('option', { key: 'p', value: '预审' }, 介入度标签('预审')),
            h('option', { key: 'a', value: '审批' }, 介入度标签('审批')),
          ]),
        ]),
        设置行('exempt', '复核免审', '允许 Lead 为任务登记复核豁免；关闭时仍须复核。', [
          h('select', {
            key: 'sel', className: 'dshmind-set__select',
            'aria-label': '复核免审',
            value: 未接入 ? '' : form.复核免审,
            disabled: 表单禁用,
            onChange: function (event) {
              改策略('复核免审', event && event.target && event.target.value === '是' ? '是' : '否');
            },
          }, [
            ...(未接入 ? [h('option', { key: 'x', value: '' }, '未读到（未接入）')] : []),
            h('option', { key: 'n', value: '否' }, '关闭（默认）'),
            h('option', { key: 'y', value: '是' }, '允许豁免'),
          ]),
        ]),
      ];

      var 调度块 = h('section', { key: 'delegation', 'data-dshmind': 'delegation-settings', className: 'dshmind-set__section', 'aria-labelledby': 'dshmind-delegation-title', 'aria-busy': 调度提示.saving }, [
        h('h3', { key: 'h', id: 'dshmind-delegation-title', className: 'dshmind-set__subtitle' }, 'Lead 调度授权'),
        h('p', { key: 'scope', className: 'dshmind-set__lede' }, '决定 Lead 是否可自行创建成员；撤回不会终止已有成员。'),
        !调度读数 ? h('div', { key: 'error', role: 调度快照.phase === 'reading' ? 'status' : 'alert', className: 'dshmind-set__notice' }, 调度快照.phase === 'reading' ? '正在读取调度授权…' : '调度设置未接入：' + 调度快照.error) : null,
        调度读数 ? h('p', { key: 'runtime', className: 'dshmind-set__hint' }, '当前运行：' + (调度读数.runtime.mode === 'lead-discretion' ? 'Lead 按需选择' : '仅用户点名') + ' · ' + (调度读数.runtime.disposed ? '插件已卸载' : 调度读数.application && 调度读数.application.state === 'confirmed' ? '运行配置已同步' : '等待运行端确认')) : null,
        h('div', { key: 'fields', className: 'dshmind-set__rows' }, [
          设置行('delegation-mode', '调度模式', !调度读数 ? '读取后可选择成员派工方式。' : 调度表.mode === 'lead-discretion' ? '在授权项目内按需要派工。' : '按用户的明确指令派工。', h('select', {
            className: 'dshmind-set__select', 'aria-label': '调度模式', value: 调度读数 ? 调度表.mode : '', disabled: 调度提示.saving || !调度读数,
            onChange: function (event) { 改调度表('mode', event.target.value); },
          }, [!调度读数 ? h('option', { value: '' }, '未读到（未接入）') : null, h('option', { value: 'explicit-user' }, '仅用户点名'), h('option', { value: 'lead-discretion' }, 'Lead 按需选择')])),
          h('details', { key: 'scope-fields', className: 'dshmind-set__details', open: !!调度读数 && 调度表.mode === 'lead-discretion' }, [
            h('summary', { key: 'label' }, '项目范围与授权依据'),
            设置行('delegation-projects', '授权项目', '项目键用逗号分隔；* 表示所有项目。', h('input', {
              type: 'text', className: 'dshmind-set__number dshmind-set__text', 'aria-label': '授权项目', placeholder: '例如 plugins, my-project',
              value: 调度读数 ? 调度表.projects : '', disabled: 调度提示.saving || !调度读数,
              onChange: function (event) { 改调度表('projects', event.target.value); },
              onKeyDown: function (event) { if (event && event.key === 'Enter') 保存调度(false); },
            }), 'field'),
            设置行('delegation-ref', '授权依据', '填写本次授权的来源或说明。', h('input', {
              type: 'text', className: 'dshmind-set__number dshmind-set__text', 'aria-label': '授权依据', placeholder: '例如：本次对话中确认的授权',
              value: 调度读数 ? 调度表.authorizationRef : '', disabled: 调度提示.saving || !调度读数,
              onChange: function (event) { 改调度表('authorizationRef', event.target.value); },
              onKeyDown: function (event) { if (event && event.key === 'Enter') 保存调度(false); },
            }), 'field'),
          ]),
        ]),
        调度表.mode === 'lead-discretion' && String(调度表.projects).split(/[,，\s]+/).indexOf('*') >= 0 ? h('div', { key: 'global', className: 'dshmind-set__notice' }, '全项目授权：* 会命中当前 profile 下的所有项目。') : null,
        调度外部更新 ? h('p', { key: 'changed', role: 'status', className: 'dshmind-set__notice' }, '授权配置已在别处更新，当前草稿已保留。采用当前配置后可继续修改。') : null,
        h('div', { key: 'actions', className: 'dshmind-set__actions' }, [
          h('span', { key: 'dirty', className: 'dshmind-set__editState' }, 调度提示.saving ? '正在提交并核对…' : 调度有修改 ? '有未保存的调度修改' : '调度授权单独保存'),
          调度有修改 || 调度外部更新 ? h('button', { key: 'reset', type: 'button', className: 'dshmind-set__btn', disabled: 调度提示.saving || !调度读数, onClick: 重置调度 }, 调度外部更新 ? '采用当前配置' : '取消调度修改') : null,
          h('button', { key: 'save', type: 'button', className: 'dshmind-set__btn dshmind-set__btn--primary', disabled: 调度提示.saving || !调度读数 || !调度表.fingerprint || !调度有修改 || 调度外部更新, onClick: function () { 保存调度(false); } }, 调度提示.saving ? '调度提交中…' : '保存调度授权'),
        ]),
        调度提示.text ? h('div', { key: 'receipt', role: 调度提示.ok ? 'status' : 'alert', className: 'dshmind-set__toast ' + (调度提示.ok ? 'dshmind-set__toast--ok' : 'dshmind-set__toast--warn') }, [
          h('span', { key: 'summary' }, 调度提示.ok ? '已保存，当前运行授权已核对。' : 调度提示.text.split('。')[0] + '。'),
          h('details', { key: 'details', className: 'dshmind-set__details' }, [h('summary', { key: 'title' }, '提交详情'), h('p', { key: 'text' }, 调度提示.text)]),
        ]) : null,
        h('details', { key: 'diagnostics', className: 'dshmind-set__details' }, [
          h('summary', { key: 'label' }, '授权详情与更多操作'),
          h('p', { key: 'boundary' }, '仅人侧设置入口提供写入，模型工具不提供改授权动作；仅用户点名不终止或禁用已有成员。本机 shell 与凭据的隔离由宿主权限负责。'),
          调度读数 ? h('div', { key: 'readings', className: 'dshmind-set__rows' }, [
            设置读数行('delegation-source', '配置位置', '预览项目 ' + line(调度读数.runtime.project, '未知'), 调度读数.persistence.source),
            设置读数行('delegation-fingerprint', '盘面 / 运行指纹', '提示词实际应用仍待下一轮验证', 调度读数.persistence.fingerprint.slice(0, 12) + ' / ' + 调度读数.runtime.fingerprint.slice(0, 12)),
          ]) : null,
          h('button', { key: 'revoke', type: 'button', className: 'dshmind-set__btn', disabled: 调度提示.saving || !调度读数 || 调度读数.persistence.config.mode !== 'lead-discretion', onClick: function () { 保存调度(true); } }, '撤回自主调度'),
        ]),
      ]);

      var 人设块 = h('section', { key: 'persona', className: 'dshmind-set__section', 'data-dshmind': 'persona-core-settings', 'aria-labelledby': 'dshmind-persona-title', 'aria-busy': 人设提示.saving }, [
        h('h3', { key: 'title', id: 'dshmind-persona-title', className: 'dshmind-set__subtitle' }, '核心人设'),
        h('p', { key: 'scope', className: 'dshmind-set__lede' }, '由你维护，适用于当前部署的所有项目。保存后下一轮读取；留空保存可停用。'),
        !人设读数 ? h('div', { key: 'error', role: 人设快照.phase === 'reading' ? 'status' : 'alert', className: 'dshmind-set__notice' }, 人设快照.phase === 'reading' ? '正在读取核心人设…' : '核心人设暂不可用：' + 人设快照.error) : null,
        人设读数 && 人设读数.state === 'missing' ? h('p', { key: 'missing', className: 'dshmind-set__hint' }, '尚未创建核心人设卡，填写后保存即可创建。') : null,
        设置行('persona-core', '核心人设内容', '填写性格、表达方式与关系称呼。此卡可用于公开聊天，请勿填写秘密或密钥。', h('textarea', {
          className: 'dshmind-set__persona', 'aria-label': '核心人设内容', rows: 10, value: 人设表.text,
          disabled: !人设读数 || 人设提示.saving,
          placeholder: '例如：保持好奇、坦诚，有独立判断；不知道时直接说明。',
          onChange: function (event) {
            if (actionLocks.persona || !人设读数) return;
            var text = event.target.value;
            设人设表({ text: text, fingerprint: 人设表.fingerprint, dirty: text !== 人设读数.text || 人设表.fingerprint !== 人设读数.fingerprint });
          },
        }), 'field'),
        h('p', { key: 'count', className: 'dshmind-set__hint', role: 人设字数 > 3000 ? 'alert' : undefined }, 人设字数 + ' / 3000 字符' + (人设字数 > 3000 ? '，请缩短后保存。' : '')),
        人设外部更新 ? h('p', { key: 'changed', role: 'status', className: 'dshmind-set__notice' }, '核心人设已在别处更新，当前草稿已保留。核对后可采用当前人设继续修改。') : null,
        h('div', { key: 'actions', className: 'dshmind-set__actions' }, [
          h('span', { key: 'dirty', className: 'dshmind-set__editState' }, 人设提示.saving ? '正在保存并核对…' : 人设有修改 ? '有未保存的人设修改' : '核心人设单独保存'),
          人设有修改 || 人设外部更新 ? h('button', { key: 'reset', type: 'button', className: 'dshmind-set__btn', disabled: 人设提示.saving || !人设读数, onClick: 重置人设 }, 人设外部更新 ? '采用当前人设' : '取消人设修改') : null,
          h('button', { key: 'save', type: 'button', className: 'dshmind-set__btn dshmind-set__btn--primary', disabled: 人设提示.saving || !人设读数 || !人设有修改 || 人设外部更新 || 人设字数 > 3000, onClick: 保存人设 }, 人设提示.saving ? '人设保存中…' : '保存核心人设'),
        ]),
        人设提示.text ? h('div', { key: 'receipt', role: 人设提示.ok ? 'status' : 'alert', className: 'dshmind-set__toast ' + (人设提示.ok ? 'dshmind-set__toast--ok' : 'dshmind-set__toast--warn') }, 人设提示.text) : null,
        人设读数 ? h('details', { key: 'file', className: 'dshmind-set__details' }, [h('summary', { key: 'title' }, '人设卡位置'), h('p', { key: 'path', className: 'dshmind-set__mono' }, 人设读数.file)]) : null,
      ]);

      var 操作块 = h('div', { key: 'acts', className: 'dshmind-set__actions' }, [
        h('span', { key: 'dirty', className: 'dshmind-set__editState' }, 提示.保存中 ? '正在保存并核对…' : 策略有修改 ? '有未保存的策略修改' : '修改后保存'),
        策略有修改 || 策略外部更新 ? h('button', { key: 'reset', type: 'button', className: 'dshmind-set__btn', disabled: 表单禁用, onClick: 重置策略 }, 策略外部更新 ? '采用当前策略' : '取消修改') : null,
        h('button', { key: 'save', type: 'button', className: 'dshmind-set__btn dshmind-set__btn--primary', disabled: 表单禁用 || !策略有修改 || 策略外部更新, onClick: function () { 保存(); } }, 提示.保存中 ? '保存中…' : '保存'),
      ]);
      var 提示块 = 提示.提示 ? h('div', { key: 'toast', role: 提示.提示调 === 'ok' ? 'status' : 'alert', className: 'dshmind-set__toast ' + (提示.提示调 === 'ok' ? 'dshmind-set__toast--ok' : 'dshmind-set__toast--warn') }, 提示.提示调 === 'ok' ? [
        h('span', { key: 'summary' }, '已保存，且回读一致。'), h('details', { key: 'details', className: 'dshmind-set__details' }, [h('summary', { key: 'title' }, '生效详情'), h('p', { key: 'text' }, 提示.提示)]),
      ] : 提示.提示) : null;
      return h('section', { className: 'dshmind-set__', 'aria-label': '心智设置' }, [
        h('header', { key: 'header', className: 'dshmind-set__header' }, [
          h('div', { key: 'title' }, [h('h2', { key: 'h', className: 'dshmind-set__title' }, '心智'), h('p', { key: 's', className: 'dshmind-set__lede' }, '配置核心人设、审批方式、失联保护与成员调度。')]),
          h('button', { key: 'read', type: 'button', className: 'dshmind-set__btn', disabled: refreshing[0] || 提示.保存中 || 调度提示.saving || 人设提示.saving, onClick: 手动刷新 }, refreshing[0] ? '读取中…' : '重新读取'),
        ]),
        人设块,
        h(信息成长设置, { key: 'information' }),
        h('section', { key: 'policy', className: 'dshmind-set__section', 'data-dshmind': 'policy-settings', 'aria-labelledby': 'dshmind-policy-title', 'aria-busy': 提示.保存中 }, [
          h('h3', { key: 'title', id: 'dshmind-policy-title', className: 'dshmind-set__subtitle' }, '运行与审批'),
          未接入块, 坏值块,
          h('h4', { key: 'presence-title', className: 'dshmind-set__groupTitle' }, [h('span', { key: 'title' }, '失联保护'), 读 ? h('span', { key: 'status', className: 'dshmind-set__status' }, [h('span', { key: 'dot', className: 'dshmind-set__dot', style: { background: 态色 } }), 态文本]) : null]),
          h('div', { key: 'presence-fields', className: 'dshmind-set__rows' }, 策略行.slice(0, 2)),
          h('h4', { key: 'review-title', className: 'dshmind-set__groupTitle' }, '审批与复核'),
          h('div', { key: 'review-fields', className: 'dshmind-set__rows' }, 策略行.slice(2)),
          策略外部更新 ? h('p', { key: 'changed', role: 'status', className: 'dshmind-set__notice' }, '当前设置已在别处更新，草稿已保留。采用当前策略后可继续修改。') : null,
          操作块, 提示块,
          h('details', { key: 'diagnostics', className: 'dshmind-set__details' }, [
            h('summary', { key: 'label' }, '配置详情'), 读数块,
            h('p', { key: 'source' }, '写入本部署的私有设置。生效顺序：私有设置 ＞ 出厂设置 ＞ 内置兜底。'),
            snap.设置文件 ? h('p', { key: 'path', className: 'dshmind-set__mono' }, '设置文件 ' + snap.设置文件) : null,
            h('p', { key: 'command', className: 'dshmind-set__mono' }, '命令 ' + PRESENCE_COMMAND),
          ]),
        ]),
        调度块,
        h('footer', { key: 'foot', className: 'dshmind-set__foot' }, [
          h('p', { key: 'location', className: 'dshmind-set__hint' }, '审批请求在心智「待你决定」处理。'),
          close ? h('button', { key: 'close', type: 'button', className: 'dshmind-set__btn', onClick: function () { close(); } }, '关闭') : null,
        ]),
      ]);
    }

    // ── 插件体 ──────────────────────────────────────────────────────────────
    /**
     * 只注册 main、sidebar.panellist 与 settings.section。
     * 工作台是只读投影；从实时待办导航到独立人侧审阅页才读取私有计划和发出决议。
     * 聊天、输入区和全局浮层均不承载审批 UI。
     *
     * 入口排在**插件入口下面**：插件那一行的 `order` 是 0，本组件是 10。
     */
    function apply(ctx) {
      var slots = null;
      try {
        slots = ctx && typeof ctx.get === 'function' ? ctx.get('slots') : (ctx ? ctx.slots : null);
      } catch (error) {
        slots = ctx ? ctx.slots : null;
      }
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
        try { console.warn('dsh-mind: slots 服务不可用，看板未注册'); } catch (error) { /* 控制台都没了就算了 */ }
        return undefined;
      }
      activeCtx = ctx;

      // ⚠️ 两处注册**各自包在 try/catch 里**。
      // 一个界面组件绝不该有能力把整站 web 启动搞崩 —— 最坏的结果只能是「看板不出现」。
      // 槽位协议与声明方随时可能变，这个兜底就是那条边界。
      var disposers = [];
      function 登记(name, 注册) {
        try {
          var disposer = slots.inject(name, 注册);
          if (typeof disposer === 'function') disposers.push(disposer);
          return true;
        } catch (error) {
          try { console.warn('dsh-mind: 注册席位 ' + name + ' 失败，看板降级为不可见', error); } catch (ignored) { /* 控制台都没了就算了 */ }
          return false;
        }
      }

      登记('main', function () {
        return slots.register({
          name: 'main',
          key: PANEL_KEY,
        }, Dashboard);
      });
      登记('sidebar.panellist', function () {
        return slots.register({
          name: 'sidebar.panellist',
          id: PANEL_KEY,
          // 插件入口是 0：10 让它排在插件**下面**。
          order: 10,
          // 标签由侧边栏渲染（`span.panelTitle`），我这份只在窄轨的工具提示里用到。
          label: function () { return '心智 · 数字组织'; },
        }, MindGlyph);
      });
      登记('settings.section', function () {
        return slots.register({
          name: 'settings.section',
          id: SETTINGS_SECTION_ID,
          // 官方设置页里各分区的先后：本组件排在后面，不抢「通用」那一档的位置。
          order: 60,
          // 分区标签由设置页渲染；主人只传 `{close}` 给组件（见 心智设置）。
          label: function () { return SETTINGS_SECTION_LABEL; },
        }, 心智设置);
      });

      // 设置页那套样式走**文档级**注入（`document.head`）—— 它不住在看板面板的子树里，
      // 挂在面板里的 CSS 对设置页不可达（Batch 6 修的真缺陷，见 `SETTINGS_CSS` 的说明）。
      // 注入失败（无 document 等）返回 null：只掉外观，不影响任何功能。
      var 撤样式 = 注入设置页样式();
      if (typeof 撤样式 === 'function') disposers.push(撤样式);

      // **起轮询**：取数不挂在 `useEffect` 上（这个宿主的 effect 很可能是空实现）。
      // 立刻拉一次 + 每 `POLL_MS` 拉一次；停止函数进 disposer（**不许留定时器**）。
      // 先清 store：一个插件实例一份数据，别让上一次 apply 的残留漏进来。
      清空store();
      var 停轮询 = 起轮询();
      if (typeof 停轮询 === 'function') disposers.push(停轮询);

      var disposed = false;
      function disposeAll() {
        if (disposed) return;
        disposed = true;
        for (var i = 0; i < disposers.length; i += 1) {
          try {
            if (typeof disposers[i] === 'function') disposers[i]();
          } catch (error) { /* 单个撤下失败不影响另一个 */ }
        }
      }

      // 看板行被关掉时本模块根本不进 roster（只有被行引用的包才会被注入浏览器），
      // 可见性由 roster 自己管——曾有的 components 探针打的是宿主从未注册过的路由
      // （端点表只许 presence/workbench/ping 三条），死代码已删，不留第二个口径。
      return disposeAll;
    }

    return { name: 'dsh-mind', inject: ['slots'], apply: apply };
  },
});
