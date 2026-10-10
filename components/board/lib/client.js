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
  // ⚠️ 这个 id **必须等于本包的包名**：宿主是按包名去模块表里取这个 factory 的。
  // 写错不会「本插件不显示」，而是整站 web 启动失败 —— 改名前先看 package.json。
  id: 'dsh-mind-board',
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
    var ROUTE_WORKBENCH = '/plugins/dsh-mind/workbench';
    /** 上一次已知快照：取不到投影时仍然有东西可看。 */
    var CACHE_KEY = 'dsh-mind.dashboard.v1';
    /** 自动刷新间隔（人看的板子，30s 够「活」，又不打扰）。 */
    var REFRESH_MS = 30000;
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
    var TASK_LIMIT = 12;
    var AUDIT_LIMIT = 20;
    /** 「待你决定」是主子唯一必须看的清单，所以给得比任务卡更宽；超出的部分明说还有多少条。 */
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
    var EMPTY = { phase: 'init', view: null, at: '', error: '', sessionId: '', source: '', stale: false };

    function normalizeView(raw) {
      // 宿主命令返回 `{成功, action, 项目, 数据: <投影>}`；工具路径共用同一个包装。
      // 这里把包装与投影合并成一层，两种形状都能读，视图不必知道自己被谁调过。
      var box = obj(raw) || {};
      var v = obj(box.数据) ? Object.assign({}, box, box.数据) : box;
      var taskBag = obj(firstOf(v, ['任务', 'task'])) || {};
      var statusBag = obj(firstOf(v, ['状态条', '状态'])) || {};
      var gateBag = obj(firstOf(statusBag, ['闸', 'policy'])) || {};
      var probeBag = obj(firstOf(statusBag, ['探针', 'probes'])) || {};
    var 失联详情袋 = firstOf(statusBag, ['失联详情']);
    var 失联原值 = firstOf(statusBag, ['失联', 'lost', 'presenceLost']);
    if (失联原值 === undefined) 失联原值 = firstOf(obj(失联详情袋) || {}, ['读数']);
      return {
        原始: v,
        项目: line(firstOf(v, ['项目', '项目键', 'project', 'projectKey']), '（未指定）'),
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
        // §9 工作台只读 ⇒ 界面上没有「决定」这个动作可点，只有一条能敲的命令。
        // 命令由投影给出（界面不拼命令），所以这里只做取值，不做生成。
        待你决定: arr(firstOf(v, ['待你决定', '待决清单'])).map(function (item) {
          var row = obj(item) || {};
          return {
            类型: line(firstOf(row, ['类型', 'kind']), '待决项'),
            节点: line(firstOf(row, ['节点', 'node', 'id']), '') || null,
            描述: line(firstOf(row, ['描述', '对象', '名称']), ''),
            原因: line(firstOf(row, ['原因', '理由', 'reason']), '（未给原因）'),
            可选项: arr(firstOf(row, ['可选项', '选项', 'options'])).map(refText).filter(Boolean),
            命令: line(firstOf(row, ['命令', 'command']), ''),
          };
        }),
        会审: arr(firstOf(v, ['会审', '会审记录'])).map(reviewRow),
        审计尾: arr(firstOf(v, ['审计尾', '审计', 'audit'])),
        // 记忆读数：宿主没给就是 null（不装懂）；给了只取四个标量，数字真伪由投影侧负责。
        记忆: 记忆读数Of(firstOf(v, ['记忆', '记忆读数', 'memory'])),
        任务: taskBag,
        // 投影把节点放在 `任务.节点` 下；`节点` 只是同一件事的直白叫法。
        任务节点: arr(taskBag.节点 || firstOf(v, ['任务节点', '节点', 'tasks'])),
        视图: line(firstOf(v, ['视图', 'view']), ''),
      };
    }

    /**
     * 记忆读数袋 → 渲染用的形状。null/非对象 ⇒ null：宿主没给就不画，
     * 与「失联四态」同一纪律——缺数据不许伪装成 0。
     */
    function 记忆读数Of(bag) {
      var b = obj(bag);
      if (!b) return null;
      var 近段 = obj(firstOf(b, ['近段'])) || {};
      return {
        存量: numOf(firstOf(b, ['存量', '存量合计'])),
        窗口天: numOf(firstOf(近段, ['窗口天'])),
        新增: numOf(firstOf(近段, ['新增', '新增合计'])),
        晋升: numOf(firstOf(近段, ['晋升'])),
      };
    }

    /**
     * 一次会审 → 渲染用的形状。
     *
     * 揭名判据**只在这里判一次**：未交齐就把成员 id 直接丢掉。放进渲染层，
     * 等于给「将来某个分支忘了判断」留一道泄露人格的缝（§10 未交齐 = 讨论保持锁定）。
     */
    function reviewRow(row) {
      var r = obj(row) || {};
      var 交 = obj(firstOf(r, ['交卷', '进度'])) || {};
      var 已交 = numOf(firstOf(交, ['已交', 'submitted']));
      var 应交 = numOf(firstOf(交, ['应交', 'expected']));
      var 齐 = boolOf(firstOf(交, ['齐', 'complete']));
      // 没给「齐」就自己算：应交看负责人人数，已交看独立答案数（与投影同一判据）。
      if (齐 === null) 齐 = 应交 !== null && 应交 > 0 && 已交 !== null && 已交 >= 应交;
      var 揭名 = boolOf(firstOf(r, ['揭名', 'revealed']));
      if (揭名 === null) 揭名 = 齐 === true; // 缺省从严：只有确知交齐才揭名
      return {
        节点: line(firstOf(r, ['节点', 'id']), ''),
        描述: line(firstOf(r, ['描述', '标题']), ''),
        模式: line(firstOf(r, ['模式', 'mode']), ''),
        揭名: 揭名 === true,
        交卷: { 已交: 已交 === null ? 0 : 已交, 应交: 应交 === null ? 0 : 应交, 齐: 齐 === true },
        独立答案: arr(firstOf(r, ['独立答案', '答案'])).map(function (answer, index) {
          var a = obj(answer) || {};
          return {
            盲标: line(firstOf(a, ['盲标', 'blind']), '成员 ' + String.fromCharCode(65 + index)),
            成员: 揭名 === true ? line(firstOf(a, ['成员', 'member'])) : '',
            结论: line(firstOf(a, ['结论', 'conclusion']), '（无结论）'),
            反例面: arr(a.反例面).map(refText).filter(Boolean),
            产出物引用: arr(a.产出物引用).map(refText).filter(Boolean),
          };
        }),
        分歧清单: arr(firstOf(r, ['分歧清单', '分歧'])).map(refText).filter(Boolean),
        反例面: arr(firstOf(r, ['反例面'])).map(refText).filter(Boolean),
        零分歧: boolOf(firstOf(r, ['零分歧', 'zeroDivergence'])) === true,
        零分歧依据: line(firstOf(r, ['零分歧依据', '依据']), ''),
        复核三态: line(firstOf(r, ['复核三态', '三态']), ''),
        复核者: line(firstOf(r, ['复核者', 'reviewer']), ''),
        // ⑮ 强制反对者（2026-10-10）：开启讨论时系统指定的那位。投影**没有讨论段就不给**
        // 这个键（并行分担等），所以这里兜底成空串 ⇒ 渲染层「有值才画」，一个字都不多写。
        强制反对者: line(firstOf(r, ['强制反对者', 'dissenter']), ''),
        // W2 会审讨论段（2026-10-09）：投影给什么渲染什么——没有讨论段（并行分担等）
        // 就是 null，界面一个字都不多画。
        讨论: debateView(firstOf(r, ['讨论', 'debate'])),
      };
    }

    /** 讨论小节 → 渲染形状；没开讨论返回 null（并行分担全程不带这个字段）。 */
    function debateView(raw) {
      var d = obj(raw);
      if (!d) return null;
      return {
        状态: line(firstOf(d, ['状态', 'state']), '未知'),
        轮次: line(firstOf(d, ['轮次', 'round']), ''),
        本轮消息数: line(firstOf(d, ['本轮消息数', 'roundMessages']), ''),
        可收敛: boolOf(firstOf(d, ['可收敛', 'convergable'])) === true,
        可收敛说明: line(firstOf(d, ['可收敛说明', 'convergeHint']), ''),
        讨论未收敛: boolOf(firstOf(d, ['讨论未收敛', 'unconverged'])) === true,
        复核时讨论未收敛: boolOf(firstOf(d, ['复核时讨论未收敛'])) === true,
        表态消息id: line(firstOf(d, ['表态消息id', 'closingMessage']), ''),
      };
    }

    /** 派发之后判据冻结（§7）。投影直接给这一位，界面不再自己推阶段。 */
    function criteriaFrozen(task) {
      return boolOf(firstOf(task, ['判据冻结', 'criteriaFrozen'])) === true;
    }
    /** 待决 = 任务图里的一种节点状态，或投影带了待决原因。 */
    function isPending(task) {
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
    /**
     * 复核三态 → 三个互不相同的视觉档位。
     * `未验` 明确不是通过：它拿灰底虚线，绝不借到通过的绿（§9 未验 ≠ 通过且不计打回）。
     */
    function verdictOf(value) {
      var text = line(value).trim();
      if (text === '过' || text === '通过' || text === 'pass') return { 文本: '过', 类: 'dshmind-verdictPass' };
      if (text === '不过' || text === '不通过' || text === 'fail') return { 文本: '不过', 类: 'dshmind-verdictFail' };
      if (text === '未验') return { 文本: '未验', 类: 'dshmind-verdictUnverified' };
      return { 文本: text || '未复核', 类: 'dshmind-verdictNone' };
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
    function refText(item) {
      if (typeof item === 'string') return item;
      var box = obj(item);
      if (!box) return '';
      return line(firstOf(box, ['id', '名称', 'name', 'ref'])) || line(box.正文);
    }

    // ── 样式：只用 --dsw-alias-* 令牌，附兜底色（令牌改名只掉外观，不掉功能）──
    var CSS = [
      '.dshmind-root{box-sizing:border-box;display:flex;flex-direction:column;gap:14px;width:100%;max-width:1040px;',
      'margin:0 auto;padding:24px clamp(24px,4vw,48px) 40px;height:100%;overflow:auto;',
      'color:var(--dsw-alias-label-primary,#16181d);font-size:13px;line-height:20px;',
      "font-family:var(--ds-font-family-sans,-apple-system,'Segoe UI',system-ui,sans-serif)}",
      '.dshmind-root *{box-sizing:border-box}',
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
      '.dshmind-nodes{display:grid;grid-template-columns:repeat(auto-fit,minmax(288px,1fr));gap:10px;margin-top:12px}',
      '.dshmind-node{border:.5px solid var(--dsw-alias-border-l1,#0000001f);border-radius:var(--dsw-radius-md,8px);',
      'background:var(--dsw-alias-bg-layer-2,#fff);padding:10px 12px;min-width:0;display:flex;flex-direction:column;gap:6px}',
      '.dshmind-nodePending{border-color:var(--dsw-alias-state-warn-primary,#c47f17);',
      'background:var(--dsw-alias-state-warn-tertiary,#fdf6e7)}',
      '.dshmind-nodeEscalated{border-color:var(--dsw-alias-state-error-primary,#d54941)}',
      '.dshmind-nodeTop{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.dshmind-nodeTitle{font-weight:600;font-size:13px;min-width:0;flex:1;overflow-wrap:anywhere}',
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
      // 滚动条给足可见度（`scrollbar-width/color` 是标准属性；`::-webkit-*` 管 WebKit 内核），
      // 并在框尾垫一点内边距，免得最后一行贴着边框像被切掉。
      '.dshmind-auditScroll{max-height:340px;overflow-y:auto;overscroll-behavior:contain;',
      'scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l3,#00000024) transparent;padding-right:2px}',
      '.dshmind-auditScroll::-webkit-scrollbar{width:9px}',
      '.dshmind-auditScroll::-webkit-scrollbar-thumb{border-radius:5px;',
      'background:var(--dsw-alias-border-l3,#00000024)}',
      '.dshmind-auditScroll::-webkit-scrollbar-track{background:transparent}',
      '.dshmind-audit{display:flex;flex-direction:column;gap:1px;padding-bottom:2px}',
      '.dshmind-auditRow{display:grid;grid-template-columns:88px 78px 1fr 150px;gap:10px;align-items:baseline;',
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

      '.dshmind-foot{display:flex;gap:10px;flex-wrap:wrap;align-items:center;color:var(--dsw-alias-label-caption,#adb2b8);',
      'font-size:11px;padding:2px 2px 4px}',

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
     * 参考实现：`E:\DSHOME-Plugin\lib\client.js` 的 `installStyle`（同一个宿主、同一个槽位，
     * 已在官方客户端跑通）——它也是 `document.createElement('style')` + `document.head.appendChild`，
     * 并按 `style[data-plugin='<id>']` 判重，所以热重载不会叠出第二份。
     */
    var SETTINGS_CSS = [
      // 前缀 `.dshmind-set__*`（BEM 风），**另起一套、不与看板的 `.dshmind-*` 混用**：
      // 设置页住在官方设置面板里，与看板面板是两件东西，样式也该各归各的。
      //
      // 目标：与官方设置页其它分区（通用 / 模型 / 插件 …）**长得像一家人**。
      // 参考实现是 `E:\DSHOME-Plugin\lib\client.js` 的「提醒」分区（同一个宿主、同一个槽位，
      // 已在官方客户端跑通）：它的做法是 —— 每行「左标题 + 说明 / 右控件」、行间用
      // 那条 `border-l2` 别名令牌画 `1px solid` 分隔、圆角与淡背景也走别名令牌、
      // 说明用 `label-tertiary`、控件给类名而不是裸默认样式。这里照同一套做法。
      //
      // 令牌纪律照旧：每个 `var(--dsw-*)` 都带兜底值（令牌改名只掉外观，不掉功能）。
      '.dshmind-set__{box-sizing:border-box;display:flex;flex-direction:column;gap:4px;width:100%;',
      'padding:2px 0 12px;color:var(--dsw-alias-label-primary,#1a2233);font-size:13px;line-height:20px;',
      "font-family:var(--ds-font-family-sans,-apple-system,'Segoe UI',system-ui,sans-serif)}",
      '.dshmind-set__ *{box-sizing:border-box}',
      // 标题与说明：标题与官方分区标题同尺，说明只留一句（原来那一大段收短）。
      '.dshmind-set__title{margin:0 0 2px;font-size:15px;line-height:24px;font-weight:600;',
      'color:var(--dsw-alias-label-primary,#1a2233)}',
      '.dshmind-set__lede{margin:0 0 10px;font-size:12.5px;line-height:19px;',
      'color:var(--dsw-alias-label-tertiary,#6b7a99);overflow-wrap:anywhere}',
      // 未接入：**一条紧凑提示**，不抢主版面（原来它占的比正式内容还大）。
      '.dshmind-set__notice{display:flex;flex-direction:column;gap:6px;margin:0 0 10px;padding:10px 12px;',
      'border:1px solid var(--dsw-alias-border-l2,#d3dcea);border-left:3px solid var(--dsw-alias-state-warn-primary,#c47f17);',
      'border-radius:8px;background:var(--dsw-alias-bg-layer-2,#fff);font-size:12.5px;line-height:19px}',
      '.dshmind-set__noticeText{color:var(--dsw-alias-label-secondary,#4a5a78);overflow-wrap:anywhere}',
      '.dshmind-set__noticeCmd{margin:0;padding:6px 8px;border-radius:6px;cursor:text;-webkit-user-select:text;user-select:text;',
      'background:var(--dsw-alias-markdown-code-block,#f5f5f5);border:.5px solid var(--dsw-alias-border-l1,#0000001f);',
      'font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;',
      'color:var(--dsw-alias-label-secondary,#4a5a78);overflow-wrap:anywhere}',
      // 行：与官方分区同款「左标题 + 说明 / 右控件」，行间细分隔线。
      '.dshmind-set__rows{display:flex;flex-direction:column;border-top:1px solid var(--dsw-alias-border-l2,#d3dcea)}',
      '.dshmind-set__row{display:flex;align-items:center;gap:16px;padding:12px 0;',
      'border-bottom:1px solid var(--dsw-alias-border-l2,#d3dcea)}',
      '.dshmind-set__texts{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.dshmind-set__label{font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,#1a2233)}',
      '.dshmind-set__hint{font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-tertiary,#6b7a99);',
      'overflow-wrap:anywhere}',
      '.dshmind-set__control{flex:0 0 auto;display:flex;align-items:center;gap:8px;min-width:0}',
      '.dshmind-set__value{min-width:0;display:flex;align-items:center;gap:6px;flex-wrap:wrap;overflow-wrap:anywhere}',
      // 控件：圆角 / 边框 / 背景 / focus 态对齐宿主观感，且**都有类名**（不许裸默认样式）。
      '.dshmind-set__select,.dshmind-set__number{height:32px;padding:0 10px;border-radius:8px;font-size:13px;',
      'font-family:inherit;color:var(--dsw-alias-label-primary,#1a2233);background:var(--dsw-alias-bg-layer-2,#fff);',
      'border:1px solid var(--dsw-alias-border-l2,#d3dcea)}',
      '.dshmind-set__number{width:112px}',
      '.dshmind-set__select:focus,.dshmind-set__number:focus{outline:none;',
      'border-color:var(--dsw-alias-brand-primary,#4D6BFE)}',
      '.dshmind-set__select:disabled,.dshmind-set__number:disabled{opacity:.55;cursor:default}',
      // 按钮：主次分档 —— 保存＝主（实心），重新读取 / 关闭＝次（描边）。
      '.dshmind-set__actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:14px}',
      '.dshmind-set__btn{height:32px;padding:0 14px;border-radius:8px;cursor:pointer;font-size:13px;',
      'font-family:inherit;border:1px solid var(--dsw-alias-border-l2,#d3dcea);',
      'background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#1a2233);',
      'transition:background .15s,border-color .15s,color .15s}',
      '.dshmind-set__btn:hover{background:var(--dsw-alias-interactive-bg-hover,#eff1f5)}',
      '.dshmind-set__btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4D6BFE);outline-offset:1px}',
      '.dshmind-set__btn:disabled{opacity:.55;cursor:default}',
      '.dshmind-set__btn--primary{border-color:transparent;font-weight:500;',
      'background:var(--dsw-alias-brand-primary,#4D6BFE);color:var(--dsw-alias-label-primary-inverted,#fff)}',
      '.dshmind-set__btn--primary:hover{background:var(--dsw-alias-brand-primary-hover,#3F5BE8)}',
      // 坏值 / 提示条：告警与成功各一色，两者都必须**一眼可见**。
      '.dshmind-set__bad{margin:10px 0 0;padding:9px 11px;border-radius:8px;font-size:12.5px;line-height:19px;',
      'border:1px solid var(--dsw-alias-state-error-primary,#d54941);',
      'background:var(--dsw-alias-state-error-tertiary,#fdecea);color:var(--dsw-alias-state-error-primary,#d54941);',
      'overflow-wrap:anywhere}',
      '.dshmind-set__toast{margin:12px 0 0;padding:9px 11px;border-radius:8px;font-size:12.5px;line-height:19px;',
      'overflow-wrap:anywhere}',
      '.dshmind-set__toast--warn{border:1px solid var(--dsw-alias-state-error-primary,#d54941);',
      'background:var(--dsw-alias-state-error-tertiary,#fdecea);color:var(--dsw-alias-state-error-primary,#d54941)}',
      '.dshmind-set__toast--ok{border:1px solid var(--dsw-alias-state-success-primary,#2f9e44);',
      'background:var(--dsw-alias-state-success-tertiary,#eaf7ec);color:var(--dsw-alias-state-success-primary,#2f9e44)}',
      // 页脚：命令与设置文件路径 —— 字号最小、色最淡，属于"想看才看"的信息。
      '.dshmind-set__foot{display:flex;gap:12px;flex-wrap:wrap;margin-top:14px;padding-top:10px;',
      'border-top:1px solid var(--dsw-alias-border-l2,#d3dcea);font-size:11.5px;line-height:17px;',
      'color:var(--dsw-alias-label-caption,#8b93a7)}',
      '.dshmind-set__mono{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);',
      'overflow-wrap:anywhere}',
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
     * （摘掉别的实例/别的插件的样式是越界）。参考实现（DSHOME 的 `installStyle`）用 querySelector
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
          hint ? h('span', { className: 'dshmind-secHint' }, hint) : null,
          count ? h('span', { className: 'dshmind-secCount dshmind-mono' }, count) : null,
        ]),
        h('div', { className: 'dshmind-secBody' }, body),
      ]);
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
        if (方法 === 'GET') {
          // 照同机跑通的第三方插件：GET 一律绕开缓存。
          选项.cache = 'no-store';
        } else if (请求.body !== undefined) {
          选项.headers = { 'content-type': 'application/json' };
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
            Promise.resolve(typeof response.text === 'function' ? response.text() : '').then(function (text) {
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
                  resolve({ ok: false, error: line(firstOf(parsed, ['理由', '错误', '原因', '结果', 'message']), '请求被拒绝') });
                  return;
                }
                if (!行不行) { resolve({ ok: false, error: 'HTTP ' + 状态 }); return; }
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
    function fetchView(ctx, sessionId) {
      return runCommand(ctx, sessionId, { method: 'GET', path: ROUTE_WORKBENCH }).then(function (out) {
        if (!out.ok) return out;
        return { ok: true, view: normalizeView(out.value) };
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
      var 请求 = { 开关: spec.开关 === undefined ? null : spec.开关, 小时: spec.小时 === undefined ? null : spec.小时 };
      // body 里**只放本次真要改的键**：`开关=是` 单独一次写不许顺手把 `小时` 也写一遍
      // （那会把「只改一个键」变成"替人做主改了另一个"）。
      var body = {};
      if (请求.开关 !== null) body.开关 = 请求.开关;
      if (请求.小时 !== null) body.小时 = 请求.小时;
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
     * 同机**真机跑通**的 `DSHOME-Plugin` 全文**一个 `useEffect` 都没有**，只用 `useState` +
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
    var 投影store = { 快照: EMPTY, 订阅者: [] };
    var 设置store = { 快照: { phase: 'reading', 读数: null, 设置文件: '', error: '', 保存中: false, 提示: '', 提示调: 'warn' }, 订阅者: [] };
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
      投影store.快照 = EMPTY;
      设置store.快照 = { phase: 'reading', 读数: null, 设置文件: '', error: '', 保存中: false, 提示: '', 提示调: 'warn' };
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
      // 所以「同一组件订阅两次」这条假设路径不存在；真要发生，得先有一个"是函数但从不跑回调"
      // 的 useEffect —— 那种情况下两条路都不订阅（缺的是订阅，不是重复）。这里维持原样。
      if (缺失的钩子.indexOf('useEffect') >= 0) {
        // effect 不跑 ⇒ 没人订阅 ⇒ 值永远是订阅那一刻的快照。这里补一次同步订阅兜住。
        try { 订阅(store, 设值); } catch (error) { /* 订阅不上就算了：至少初次回放拿到了当前值 */ }
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
          if (投影序号.该用(号)) {
            发通知(投影store, {
              phase: 'nosession', view: cached ? normalizeView(cached.view) : null, at: cached ? cached.at : '',
              error: '', sessionId: '', source: '', stale: !!cached,
            });
          }
          resolve();
          return;
        }
        fetchView(ctx, session.id).then(function (out) {
          if (!投影序号.该用(号)) { resolve(); return; } // 旧响应：丢掉，不覆盖更新的快照
          if (out.ok) {
            writeCache(out.view.原始);
            发通知(投影store, {
              phase: 'live', view: out.view, at: new Date().toISOString(),
              error: '', sessionId: session.id, source: session.source, stale: false,
            });
            resolve();
            return;
          }
          var last = readCache();
          发通知(投影store, {
            phase: 'error', view: last ? normalizeView(last.view) : null, at: last ? last.at : '',
            error: out.error, sessionId: session.id, source: session.source, stale: !!last,
          });
          resolve();
        }, function (error) {
          if (!投影序号.该用(号)) { resolve(); return; }
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

    /** 立刻拉一次（两个页面都刷）。给"手动刷新"按钮与 effect 增强用。 */
    function 立即刷新() {
      return Promise.all([刷新投影(), 刷新设置()]);
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
        timer = 设(function () { if (!轮询把手.停了) 立即刷新(); }, POLL_MS);
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
      var ctx = activeCtx;

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
      var audit = view ? view.审计尾.slice(-AUDIT_LIMIT).reverse() : [];
      // 投影里**一共**多少条（用来在框尾说清"看不全是因为投影只有这些/还有多少没列"）。
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

        // ① 页头
        h('header', { key: 'hero', className: 'dshmind-hero' }, [
          h('div', { key: 'top', className: 'dshmind-heroTop' }, [
            h('div', { key: 't', style: { minWidth: 0 } }, [
              h('h2', { key: 'h', className: 'dshmind-title' }, '心智 · 数字组织'),
              h('p', { key: 's', className: 'dshmind-sub' },
                '当前状态 · 待你决定 · 反趋同会审 · 只增审计 —— 唯一投影视图（只读）'),
            ]),
            h('div', { key: 'a', className: 'dshmind-actions' }, [
              h('span', { key: 'live', className: 'dshmind-dot-line', style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary,#81858c)' } }, [
                dot(snap.phase === 'live' ? GREEN : snap.phase === 'error' ? RED : GREY),
                snap.phase === 'live' ? '活数据' : snap.phase === 'error' ? '未连接' : snap.phase === 'nosession' ? '无会话' : '读取中',
              ]),
              h('button', {
                key: 'r', type: 'button', className: 'dshmind-btn',
                onClick: function () { 立即刷新(); },
              }, '刷新'),
            ]),
          ]),
          h('div', { key: 'ro', className: 'dshmind-readouts' }, [
            // Batch 9 规矩：**没数据的格不出现**（不占位置、不留空框、不给光秃秃的 `—`）。
            // 有数据但读不出时给一句人话（「未接入」/「宿主没给」），而不是破折号。
            readout('项目键', view ? view.项目 : '未接入'),
            readout('生成时刻', view ? (shortTime(view.生成于) || '宿主没给') : '未接入'),
            readout('策略引擎闸', null, h('span', { className: 'dshmind-dot-line' }, [
              dot(!gate ? GREY : gate.在位 === true ? GREEN : gate.在位 === false ? RED : GREY),
              h('span', { key: 'v' }, !gate ? '未接入' : gate.在位 === true ? '闸在位' : gate.在位 === false ? '闸不在位' : '未知'),
              gate && gate.规则数 !== null
                ? h('span', { key: 'n', className: 'dshmind-mono', style: { color: 'var(--dsw-alias-label-tertiary,#81858c)' } }, '规则 ' + gate.规则数)
                : null,
              gate && gate.错误 ? h('span', { key: 'e' }, gate.错误) : null,
            ].filter(Boolean)), gateAlarm),
            // 介入度：**只显示当前生效的那一档**（一个值）。
            // 旧版画成 4 个 chip（零参与 / 事后抽检 / 变更预审 / 逐条审批），选中那个上色 ——
            // 那是**只读投影**，4 个看着能点的小方块会让人以为能点（Batch 8 主人提的第 4 条）。
            // 现在：一个值 + 旁边一句"（四档之一）"，不带边框、不带背景、不带光标、不可聚焦。
            readout('介入度档位', null, bar
              ? h('span', { className: 'dshmind-valueLine' }, [
                  h('span', { key: 'v' }, bar.介入度),
                  h('span', { key: 'h', className: 'dshmind-valueNote' }, '四档之一（只读）'),
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
          ].filter(Boolean)),
        ]),

        // ① 待你决定 —— 排在最前：这是主子唯一必须看的一块（§7 唯一点名要投影的清单）
        section(1, '待你决定', '§9 · 工作台只读：给你一条能敲的命令，不给你按钮',
          待你决定.length ? 待你决定.length + ' 项' : '',
          view && 待你决定.length
            ? h('div', { className: 'dshmind-decide' }, 待你决定.slice(0, DECIDE_LIMIT).map(function (item, index) {
                var hot = item.类型 === '探针见红' || item.类型 === '打回升级';
                return h('div', { key: 'd' + index, className: 'dshmind-decideRow' }, [
                  h('div', { key: 'top', className: 'dshmind-decideTop' }, [
                    badge(item.类型, hot ? 'red' : 'warn'),
                    h('span', { key: 'w', className: 'dshmind-decideWhat' }, line(item.描述, '（无描述）')),
                    item.节点 ? h('span', { key: 'n', className: 'dshmind-chip dshmind-mono' }, item.节点) : null,
                  ].filter(Boolean)),
                  h('div', { key: 'why', className: 'dshmind-decideWhy' }, '原因：' + item.原因),
                  item.可选项.length
                    ? h('div', { key: 'opt', className: 'dshmind-chips' }, item.可选项.map(function (option, i) {
                        return h('span', { key: 'o' + i, className: 'dshmind-chip' }, option);
                      }))
                    : null,
                  // 命令是**要被人拿走**的：等宽、可选中、整块给出来，而不是藏进 tooltip。
                  item.命令
                    ? h('code', { key: 'cmd', className: 'dshmind-cmd dshmind-mono', title: '选中复制这条命令去执行' }, item.命令)
                    : h('div', { key: 'cmd', className: 'dshmind-decideWhy' }, '（投影未给命令）'),
                ].filter(Boolean));
              }))
            : h('div', { key: 'none', className: 'dshmind-empty' }, '没有需要你决定的事。'),
        ),

        // ② 会审（§10 反趋同）：交齐才揭名 · 全票一致是异常
        section(2, '会审', '§10 · 未交齐不揭名 · 零分歧是异常信号',
          会审.length ? 会审.length + ' 场' : '',
          view && 会审.length
            ? h('div', { className: 'dshmind-reviews' }, 会审.slice(0, REVIEW_LIMIT).map(function (row, index) {
                var verdict = verdictOf(row.复核三态);
                return h('article', { key: line(row.节点, 'review-' + index), className: 'dshmind-review' }, [
                  h('div', { key: 'top', className: 'dshmind-reviewTop' }, [
                    h('span', { key: 't', className: 'dshmind-nodeTitle' }, line(row.描述 || row.节点, '未命名会审')),
                    h('span', {
                      key: 'p',
                      className: 'dshmind-badge',
                      style: {
                        color: row.交卷.齐 ? GREEN : WARN,
                        borderColor: row.交卷.齐 ? GREEN : WARN,
                        background: 'var(--dsw-alias-bg-layer-1,#fff)',
                      },
                    }, '交卷 ' + progressText(row.交卷)),
                    row.模式 ? h('span', { key: 'm', className: 'dshmind-chip' }, row.模式) : null,
                    // 复核三态各占一个类名：`未验` 必须与「过」在版面上就分得开。
                    h('span', { key: 'v', className: 'dshmind-verdict ' + verdict.类 },
                      '复核 ' + verdict.文本 + (row.复核者 ? ' · ' + row.复核者 : '')),
                  ].filter(Boolean)),
                  // 未交齐 = 讨论保持锁定：明说锁着，并且下面只可能出现盲标（成员 id 在归一化时就丢了）。
                  row.揭名 === false
                    ? h('div', { key: 'lock', className: 'dshmind-lock' }, '🔒 未交齐，讨论保持锁定：此处只显示盲标，交齐后揭名')
                    : null,
                  h('div', { key: 'answers', className: 'dshmind-answers' }, row.独立答案.map(function (answer, i) {
                    return h('div', { key: 'a' + i, className: 'dshmind-answer' }, [
                      h('div', { key: 'h', className: 'dshmind-answerHead' }, [
                        h('span', { key: 'b', className: 'dshmind-badge', style: {
                          color: BRAND, borderColor: BRAND, background: 'var(--dsw-alias-bg-layer-1,#fff)',
                        } }, answer.盲标),
                        answer.成员 ? h('span', { key: 'm', className: 'dshmind-chip dshmind-mono' }, answer.成员) : null,
                      ].filter(Boolean)),
                      h('div', { key: 'c', className: 'dshmind-answerBody' }, answer.结论),
                      answer.反例面.length
                        ? h('div', { key: 'x', className: 'dshmind-counter' }, '反例面：' + answer.反例面.join('；'))
                        : null,
                    ].filter(Boolean));
                  })),
                  row.分歧清单.length
                    ? h('div', { key: 'div', className: 'dshmind-divergence' }, '分歧清单：' + row.分歧清单.join('；'))
                    : null,
                  row.反例面.length
                    ? h('div', { key: 'cnt', className: 'dshmind-counter' }, '反例面：' + row.反例面.join('；'))
                    : null,
                  // 零分歧 === true 是**警报**，不是好话：§10 里全票一致意味着趋同，要交人工抽检。
                  h('div', { key: 'zero', className: row.零分歧 ? 'dshmind-anomaly' : 'dshmind-consensus' },
                    (row.零分歧 ? '⚠ 零分歧（全票一致）—— §10：这是趋同异常信号，应转人工抽检' : '存在分歧（正常）')
                      + (row.零分歧依据 ? ' · 依据：' + row.零分歧依据 : '')),
                  // W2 会审讨论段：状态 · 轮次 · 本轮预算 · 可收敛提示。讨论未收敛而复核已过
                  // 是「Lead 不收敛」的可见信号——软约束不拦 review，但面板必须喊出来。
                  row.讨论
                    ? h('div', {
                        key: 'debate',
                        className: row.讨论.讨论未收敛 ? 'dshmind-lock' : 'dshmind-consensus',
                      }, (row.讨论.状态 === '讨论中'
                        ? '💬 讨论：进行中 · 轮次 ' + (row.讨论.轮次 || '-') + ' · 本轮 ' + (row.讨论.本轮消息数 || '-')
                          + (row.讨论.可收敛 ? ' · 可收敛' : '')
                          + (row.讨论.讨论未收敛 ? ' · 讨论未收敛' : '')
                          + (row.讨论.复核时讨论未收敛 ? '（复核已过而讨论未收敛——软约束，不拦复核但在此标注）' : '')
                        : '💬 讨论：已收敛' + (row.讨论.表态消息id ? ' · 末位表态 ' + row.讨论.表态消息id : ''))
                        // ⑮ 强制反对者（2026-10-10）：**有值才画**——没指定出来（空串）时
                        // 这一句整个不出现，不给「强制反对者：—」这种空壳读数。
                        + (row.强制反对者 ? ' · 强制反对者：' + row.强制反对者 : '')
                        + (row.讨论.可收敛说明 ? ' · ' + row.讨论.可收敛说明 : ''))
                    : null,
                ].filter(Boolean));
              }))
            : h('div', { key: 'none', className: 'dshmind-empty' }, '没有进行中的会审。'),
        ),

        // ③ 任务图
        section(3, '任务图', '状态权威 · 判据派发后冻结', tasks.length ? tasks.length + ' 节点' : '',
          [
            tasks.length
            ? h('div', { className: 'dshmind-nodes' },
                tasks.slice(0, TASK_LIMIT).map(function (task, index) {
                  var rejects = numOf(task.打回次数) || 0;
                  var pending = isPending(task);
                  var frozen = criteriaFrozen(task);
                  var owners = arr(task.负责人).map(refText).filter(Boolean);
                  var criteria = arr(task.判据).map(refText).filter(Boolean);
                  var outputs = arr(task.产物 || task.产出物引用).map(refText).filter(Boolean);
                  var cls = 'dshmind-node' + (pending ? ' dshmind-nodePending' : '') + (rejects >= 2 ? ' dshmind-nodeEscalated' : '');
                  // hasOwnProperty 挡原型链键（'constructor'/'toString' 等字面量查表会返回 truthy 函数，
                  // 绕过「查表 miss ⇒ 保灰」）——坏值不许因为继承属性画出彩色（失联「值不合法」同族口径）。
                  var 徽色 = Object.prototype.hasOwnProperty.call(状态徽章色, task.状态) ? 状态徽章色[task.状态] : null;
                  return h('article', { key: line(task.id, 'task-' + index), className: cls }, [
                    h('div', { key: 'top', className: 'dshmind-nodeTop' }, [
                      h('span', { key: 't', className: 'dshmind-nodeTitle' }, line(task.描述 || task.标题 || task.id, '未命名节点')),
                      h('span', { key: 'st', className: 'dshmind-badge', style: 徽色 ? {
                        // 着色体例照抄会审交卷徽章：color + borderColor 同色值 + 底色 layer-1。
                        color: 徽色,
                        borderColor: 徽色,
                        background: 'var(--dsw-alias-bg-layer-1,#fff)',
                      } : {
                        // 查表之外保灰（现状样式原样）：待派发 / 已结账 / 未验 / 未知 / 缺失 / 白名单外。
                        borderColor: 'var(--dsw-alias-border-l2,#0000001f)',
                        color: 'var(--dsw-alias-label-secondary,#61666b)',
                      } }, line(task.状态, '未知')),
                    ]),
                    h('div', { key: 'meta', className: 'dshmind-meta' }, [
                      h('span', { key: 'o' }, '负责人 ' + (owners.length ? owners.join('、') : '未指派')),
                      task.模式 ? h('span', { key: 'm' }, '模式 ' + line(task.模式)) : null,
                      h('span', { key: 'r', className: 'dshmind-mono' }, '打回 ' + rejects + ' 次'),
                      h('span', { key: 's', className: 'dshmind-mono' }, '交卷 ' + progressText(task.交卷)),
                      arr(task.依赖).length ? h('span', { key: 'd' }, '依赖 ' + arr(task.依赖).map(refText).join('、')) : null,
                    ].filter(Boolean)),
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
                      frozen ? badge('判据冻结') : badge('判据可改', 'warn'),
                      pending ? badge('待决项', 'warn') : null,
                      rejects >= 2 ? badge('打回 ' + rejects + ' 次 · 升级主权者', 'red') : null,
                      task.升级 ? badge('升级：' + line(task.升级), 'red') : null,
                      outputs.length ? h('span', { key: 'a', className: 'dshmind-meta' }, '产物 ' + outputs.length + ' 项') : null,
                    ].filter(Boolean)),
                    task.待决原因 ? h('div', { key: 'w', className: 'dshmind-decideWhy' }, '待决原因：' + line(task.待决原因)) : null,
                    outputs.length
                      ? h('div', { key: 'chips', className: 'dshmind-chips' },
                          outputs.slice(0, 4).map(function (ref, i) {
                            return h('span', { key: 'c' + i, className: 'dshmind-chip dshmind-mono' }, ref);
                          }))
                      : null,
                  ].filter(Boolean));
                }))
            : h('div', { key: 'none', className: 'dshmind-empty' }, '任务图为空 —— 没有在办的节点。'),
            view && tasks.length > TASK_LIMIT
              ? h('div', { key: 'more', className: 'dshmind-empty' }, '另有 ' + (tasks.length - TASK_LIMIT) + ' 个节点未在此列出（工作台投影可展开）。')
              : null,
          ]),

        // ④ 审计流
        // **别静默截断**（Batch 9）：`AUDIT_LIMIT` 只是"一次渲染多少行"的上限，
        // 超出时必须**看得出来**（那句「投影共 N 条」）并且**框内滚得到**（`.dshmind-auditScroll`）。
        section(4, '审计流', '只增的事实记录 · 写入无条件 · 框内可滚动',
          audit.length ? '末 ' + audit.length + ' 条' + (审计总条数 > audit.length ? ' / 共 ' + 审计总条数 : '') : '',
          audit.length
            ? [
                // 滚动容器：内容高过 `max-height` 时**框内滚**（不裁、不可达的代名词就是没有它）。
                h('div', { key: 'scroll', className: 'dshmind-auditScroll' },
                  h('div', { className: 'dshmind-audit' }, audit.map(function (row, index) {
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
                      h('span', { key: 'w', className: 'dshmind-auditWho', title: actorOf(row) }, actorOf(row)),
                    ]);
                  }))),
                // 框尾说明：有多少条、看不全就去滚（不让人猜是不是被裁了）。
                审计总条数 > audit.length
                  ? h('div', { key: 'hint', className: 'dshmind-auditHint' },
                      '另有 ' + (审计总条数 - audit.length) + ' 条未在此列出（投影共 ' + 审计总条数 + ' 条）；框内可滚动查看已列出的 ' + audit.length + ' 条。')
                  : h('div', { key: 'hint', className: 'dshmind-auditHint' },
                      '投影共 ' + 审计总条数 + ' 条，已全部列出；框内可滚动。'),
              ]
            : h('div', { className: 'dshmind-empty' }, '审计尾为空 —— 没有事实记录，或工作台投影未附带审计尾。')),

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

      return h('div', { className: 'dshmind-root', 'data-dshmind': 'root' }, children);
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
        h('circle', { key: 'c', cx: 8, cy: 8, r: 2.7, fill: 'currentColor' }),
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
    function 心智设置(props) {
      var close = props && typeof props.close === 'function' ? props.close : null;
      // ⚠️ 读数来自**模块级 store**（由 `apply` 的裸 setInterval 轮询喂），**不来自 effect**：
      // 这个宿主的 `useEffect` 很可能是空实现 ⇒ 挂在它上面的取数永远不会跑。
      var snap = useStore(设置store);
      // 表单草稿：**独立于读数**——回读一来就覆盖输入框，人正在打的字会被吃掉。
      var 表 = useState({ 开关: '是', 小时: '72' });
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
      var 读 = snap.读数;
      var 上次同步 = useState({ 键: '', 开关: '是', 小时: '72' });
      var 同步 = 上次同步[0];
      var set同步 = 上次同步[1];
      if (读 && !人改过) {
        var 开 = 开关态Of(读);
        var 时 = numOf(读.生效响应期限小时);
        var 键 = String(开) + '/' + String(时);
        if (键 !== 同步.键) {
          set同步({ 键: 键, 开关: 开 === false ? '否' : '是', 小时: 时 === null ? '' : String(时) });
          setForm({ 开关: 开 === false ? '否' : '是', 小时: 时 === null ? '' : String(时) });
        }
      }

      function 保存() {
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
        set提示({ 保存中: true, 提示: '', 提示调: 'warn' });
        writePresence({ ctx: ctx, sessionId: session.id, 开关: form.开关, 小时: 小时 }).then(function (out) {
          if (!out.ok) {
            // 拒绝也要**照旧显示盘上现在是什么**（走 store 的最近一次读数），并明说没写进去。
            set提示({ 保存中: false, 提示: '没写进去：宿主拒绝了（' + out.error + '）', 提示调: 'warn' });
            return;
          }
          var 差 = 回读对不上(out.请求, out.回读.读数);
          // 回读值**写进 store**（那才是"盘上现在是什么"的权威），UI 因此以回读为准。
          发通知(设置store, Object.assign({}, 设置store.快照, {
            phase: 'live', 读数: out.回读.读数, 设置文件: out.回读.设置文件, error: '',
          }));
          set提示({
            保存中: false,
            提示: 差 ? 差 : ('已保存，且回读一致：' + 生效读数行(out.回读.读数)),
            提示调: 差 ? 'warn' : 'ok',
          });
          if (!差) set人改过(false); // 回读已确认 ⇒ 表单可以重新跟着读数走
        });
      }

      var 值不合法 = !!读 && boolOf(读.值不合法) === true;
      // 设置页的读数是**对象** ⇒ 在这里一次性归一成四态（别再各处 `失联态Of(读)`）。
      var 设置四态 = 读数对象四态(读);
      var 未接入 = !读;

      /**
       * 一行：左「标题 + 说明」，右控件 —— 与官方设置页其它分区同一套排法。
       * 传 `null` 当控件时不产生右栏（**不留空容器**：空块在版面上是"渲染坏了"的样子）。
       */
      function 行(key, 标题, 说明, 控件) {
        return h('div', { key: key, className: 'dshmind-set__row' }, [
          h('div', { key: 't', className: 'dshmind-set__texts' }, [
            h('div', { key: 'l', className: 'dshmind-set__label' }, 标题),
            说明 ? h('div', { key: 'h', className: 'dshmind-set__hint' }, 说明) : null,
          ].filter(Boolean)),
          控件 ? h('div', { key: 'c', className: 'dshmind-set__control' }, 控件) : null,
        ].filter(Boolean));
      }
      /** 只读读数行：值是文字，没有控件（也不产生空的右侧栏）。 */
      function 读数行(key, 标题, 说明, 值节点) {
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
      var 读数块 = 读
        ? h('div', { key: 'rows', className: 'dshmind-set__rows' }, [
            读数行('now', '当前生效值', 读数附注(读), [
              dot(态色),
              h('span', { key: 'v' }, 态文本),
            ]),
            读数行('src', '来源', '生效值由哪一层给：私有 ＞ 出厂 ＞ 内置兜底', [
              h('span', { key: 'v', className: 'dshmind-set__mono' },
                '期限 ' + line(读.响应期限小时来源, '未知') + ' · 开关 ' + line(读.失联限制来源, '未知')),
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
      var 表单块 = h('div', { key: 'rows2', className: 'dshmind-set__rows' }, [
        行('sw', '失联保险', '关掉后不再判定失联（机制停用会被如实记录）', [
          h('select', {
            key: 'sel', className: 'dshmind-set__select',
            'aria-label': '失联保险',
            value: form.开关,
            onChange: function (event) {
              var next = event && event.target ? String(event.target.value) : '是';
              setForm({ 开关: next === '否' ? '否' : '是', 小时: form.小时 });
            },
          }, [
            h('option', { key: 'y', value: '是' }, '是（开启）'),
            h('option', { key: 'n', value: '否' }, '否（关闭）'),
          ]),
        ]),
        行('hrs', '响应期限小时', '自最后一次交互起超过这个时长未响应 ⇒ 自动标记失联', [
          h('input', {
            key: 'inp', className: 'dshmind-set__number',
            type: 'number', min: 1, step: 1,
            'aria-label': '响应期限小时',
            placeholder: '1 ~ 876000',
            value: form.小时,
            onChange: function (event) {
              setForm({ 开关: form.开关, 小时: event && event.target ? String(event.target.value) : '' });
            },
            onKeyDown: function (event) {
              if (event && event.key === 'Enter') 保存();
            },
          }),
        ]),
      ]);

      return h('section', { className: 'dshmind-set__' }, [
        h('h2', { key: 'h', className: 'dshmind-set__title' }, '心智'),
        h('p', { key: 's', className: 'dshmind-set__lede' },
          '失联限制与响应期限：写入本部署的私有设置，随时可关。'),

        // 顺序：标题 → 说明 → 表单 → 操作。未接入提示紧凑地插在说明之后。
        未接入块,

        表单块,

        h('div', { key: 'acts', className: 'dshmind-set__actions' }, [
          h('button', {
            key: 'save', type: 'button', className: 'dshmind-set__btn dshmind-set__btn--primary',
            disabled: 提示.保存中 === true,
            onClick: function () { 保存(); },
          }, 提示.保存中 ? '保存中…' : '保存'),
          h('button', {
            key: 'read', type: 'button', className: 'dshmind-set__btn',
            onClick: function () { 立即刷新(); },
          }, '重新读取'),
          close
            ? h('button', { key: 'close', type: 'button', className: 'dshmind-set__btn', onClick: function () { close(); } }, '关闭')
            : null,
        ].filter(Boolean)),

        // 写失败 / 回读不一致：**明说没写进去**，绝不许显示成功。
        提示.提示
          ? h('div', {
              key: 'toast',
              className: 'dshmind-set__toast ' + (提示.提示调 === 'ok' ? 'dshmind-set__toast--ok' : 'dshmind-set__toast--warn'),
            }, 提示.提示)
          : null,

        坏值块,
        读数块,

        h('div', { key: 'foot', className: 'dshmind-set__foot' }, [
          h('span', { key: 'c' }, '命令 ' + PRESENCE_COMMAND),
          snap.设置文件 ? h('span', { key: 'f', className: 'dshmind-set__mono' }, '设置文件 ' + snap.设置文件) : null,
        ].filter(Boolean)),
      ].filter(Boolean));
    }

    // ── 插件体 ──────────────────────────────────────────────────────────────
    /**
     * 三处注册，两种东西：
     *  1. `main`（keyed，声明方 `@deepseek-ai/dsh-client-ui-layout`）—— 看板面板本体；
     *  2. `sidebar.panellist`（list，声明方 `@deepseek-ai/dsh-client-ui-sidebar`）—— 侧边栏里的面板入口；
     *  3. `settings.section`（list，声明方 `@deepseek-ai/dsh-client-ui-settings-*`）—— 官方设置页里的
     *     「心智设置」分区。
     *
     * ⚠️ **看板面板 ≠ 设置页**，这是两件被分开的东西，别再合并回去：
     * 面板是常驻运维视图，§9 工作台只读 ⇒ 面板里**一个写控件都没有**；
     * 而失联限制 / 响应期限小时是要人改的设置 ⇒ 它住在设置页那一格（第 3 处注册）。
     * 所以「看板搬出设置页」这条历史决定说的是**面板**，不是「本组件永不注册设置页」。
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

    return { name: 'dsh-mind-board', inject: ['slots'], apply: apply };
  },
});
