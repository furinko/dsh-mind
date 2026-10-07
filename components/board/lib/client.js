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
// 客户端服务 `ctx.remote` → `commands.execute(sessionId, '/mind dashboard', [])`
// → `{ok, value:{result:{kind, text}}}`，`text` 是宿主半边算好的工作台投影 JSON
// （`src/workbench.js` 的 `projectWorkbench`，字段见 INTERFACES.md §2.10）。
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
    // React 16.8+ 都有这几个 hook；兜底只为「万一取不到也还有一次静态渲染」，
    // 因为一次抛错就等于整个槽位空白。
    function hook(name, fallback) {
      var fn = React && React[name];
      return typeof fn === 'function' ? fn : fallback;
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
    /** 上一次已知快照：命令不可用时仍然有东西可看。 */
    var CACHE_KEY = 'dsh-mind.dashboard.v1';
    /** 自动刷新间隔（人看的板子，30s 够「活」，又不打扰）。 */
    var REFRESH_MS = 30000;
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
          失联: boolOf(firstOf(statusBag, ['失联', 'lost', 'presenceLost'])),
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
        任务: taskBag,
        // 投影把节点放在 `任务.节点` 下；`节点` 只是同一件事的直白叫法。
        任务节点: arr(taskBag.节点 || firstOf(v, ['任务节点', '节点', 'tasks'])),
        视图: line(firstOf(v, ['视图', 'view']), ''),
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
      '.dshmind-readouts{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;',
      'background:var(--dsw-alias-border-l1,#0000001f)}',
      '.dshmind-readout{background:var(--dsw-alias-bg-layer-1,#fff);padding:10px 14px;min-width:0}',
      '.dshmind-readoutKey{color:var(--dsw-alias-label-tertiary,#81858c);font-size:11px;letter-spacing:.04em}',
      '.dshmind-readoutVal{margin-top:3px;font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;',
      'text-overflow:ellipsis}',

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

      // 页头告警：闸不在位 / 已失联 —— 只是换个点色不算「看见了」，整块读数要变色。
      '.dshmind-readoutAlarm{background:var(--dsw-alias-state-error-tertiary,#fdecea)}',
      '.dshmind-readoutAlarm .dshmind-readoutVal{color:var(--dsw-alias-state-error-primary,#d54941)}',

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
      '.dshmind-chips{display:flex;gap:4px;flex-wrap:wrap}',

      // 审计流
      '.dshmind-audit{display:flex;flex-direction:column;gap:1px}',
      '.dshmind-auditRow{display:grid;grid-template-columns:88px 78px 1fr 150px;gap:10px;align-items:baseline;',
      'padding:6px 10px;background:var(--dsw-alias-bg-layer-2,#fff);font-size:12px;border-left:2px solid transparent}',
      '.dshmind-auditFull{border-left-color:var(--dsw-alias-state-error-primary,#d54941)}',
      '.dshmind-auditMid{border-left-color:var(--dsw-alias-state-business-primary,#0f1115)}',
      '.dshmind-auditLow{border-left-color:var(--dsw-alias-border-l2,#0000001f);',
      'color:var(--dsw-alias-label-tertiary,#81858c);opacity:.72}',
      '.dshmind-auditAction{font-weight:500;overflow-wrap:anywhere}',
      '.dshmind-auditWho{color:var(--dsw-alias-label-tertiary,#81858c);font-size:11px;overflow:hidden;',
      'text-overflow:ellipsis;white-space:nowrap}',

      // 公告条
      '.dshmind-notice{display:flex;gap:8px;align-items:flex-start;padding:9px 14px;font-size:12px;',
      'background:var(--dsw-alias-state-warn-tertiary,#fdf6e7);color:var(--dsw-alias-state-warn-primary,#c47f17);',
      'border:.5px solid var(--dsw-alias-state-warn-secondary,#e5b46a);border-radius:var(--dsw-radius-md,8px)}',
      '.dshmind-empty{color:var(--dsw-alias-label-tertiary,#81858c);font-size:12px;padding:10px 0}',
      '.dshmind-foot{display:flex;gap:10px;flex-wrap:wrap;align-items:center;color:var(--dsw-alias-label-caption,#adb2b8);',
      'font-size:11px;padding:2px 2px 4px}',

    ].join('');

    // ── 小部件 ──────────────────────────────────────────────────────────────
    function dot(color) {
      return h('span', { className: 'dshmind-dot', style: { background: color } });
    }
    var GREEN = 'var(--dsw-alias-state-success-primary,#2f9e44)';
    var RED = 'var(--dsw-alias-state-error-primary,#d54941)';
    var GREY = 'var(--dsw-alias-label-caption,#adb2b8)';
    var BRAND = 'var(--dsw-alias-state-business-primary,#0f1115)';
    var WARN = 'var(--dsw-alias-state-warn-primary,#c47f17)';

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
    /** `alarm` 为真时整块读数进告警色：闸不在位 / 已失联属于「一眼就得看见」，不能只换个点色。 */
    function readout(key, value, node, alarm) {
      return h('div', { className: 'dshmind-readout' + (alarm ? ' dshmind-readoutAlarm' : '') }, [
        h('div', { className: 'dshmind-readoutKey' }, key),
        h('div', { className: 'dshmind-readoutVal' }, node || value),
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
     * 取工作台投影。**永不 reject**：所有失败都变成一个 `{ok:false, error}`。
     * 返回形状：`{ok:true, view}` 或 `{ok:false, error}`。
     */
    function fetchView(ctx, sessionId) {
      return new Promise(function (resolve) {
        var remote = null;
        try {
          remote = ctx.get('remote');
        } catch (error) {
          resolve({ ok: false, error: '读取 remote 服务失败：' + line(error && error.message, String(error)) });
          return;
        }
        var execute = remote && remote.commands && remote.commands.execute;
        if (typeof execute !== 'function') {
          resolve({ ok: false, error: '宿主命令服务不可用（remote.commands.execute）' });
          return;
        }
        var pending;
        try {
          pending = execute(sessionId, COMMAND, []);
        } catch (error) {
          resolve({ ok: false, error: '命令调用抛错：' + line(error && error.message, String(error)) });
          return;
        }
        Promise.resolve(pending).then(function (response) {
          try {
            var result = response && response.value && response.value.result;
            if (!obj(result)) { resolve({ ok: false, error: '命令返回体无法识别' }); return; }
            if (result.kind !== 'success') {
              resolve({ ok: false, error: line(result.text, '命令执行失败') });
              return;
            }
            var parsed = parseLooseJson(result.text);
            if (!obj(parsed)) { resolve({ ok: false, error: '命令返回的不是 JSON' }); return; }
            resolve({ ok: true, view: normalizeView(parsed) });
          } catch (error) {
            resolve({ ok: false, error: '解析返回体失败：' + line(error && error.message, String(error)) });
          }
        }, function (error) {
          resolve({ ok: false, error: '命令失败：' + line(error && error.message, String(error)) });
        });
      });
    }

    // ── 主视图 ──────────────────────────────────────────────────────────────
    /** `apply` 拿到的客户端上下文（`apply` 只跑一次，组件可多次挂载）。 */
    var activeCtx = null;

    function Dashboard() {
      var stateBox = useState(EMPTY);
      var snap = stateBox[0];
      var setSnap = stateBox[1];
      var nonceBox = useState(0);
      var nonce = nonceBox[0];
      var setNonce = nonceBox[1];
      var ctx = activeCtx;

      useEffect(function () {
        var alive = true;
        function settle(next) { if (alive) setSnap(next); }
        try {
          var session = resolveSessionId(ctx);
          if (!session.id) {
            var cached = readCache();
            settle({
              phase: 'nosession', view: cached ? normalizeView(cached.view) : null, at: cached ? cached.at : '',
              error: '', sessionId: '', source: '', stale: !!cached,
            });
            return function () { alive = false; };
          }
          fetchView(ctx, session.id).then(function (out) {
            if (!alive) return;
            if (out.ok) {
              writeCache(out.view.原始);
              settle({
                phase: 'live', view: out.view, at: new Date().toISOString(),
                error: '', sessionId: session.id, source: session.source, stale: false,
              });
              return;
            }
            var last = readCache();
            settle({
              phase: 'error', view: last ? normalizeView(last.view) : null, at: last ? last.at : '',
              error: out.error, sessionId: session.id, source: session.source, stale: !!last,
            });
          });
        } catch (error) {
          settle({
            phase: 'error', view: null, at: '', stale: false,
            error: '工作台投影不可用：' + line(error && error.message, String(error)), sessionId: '', source: '',
          });
        }
        return function () { alive = false; };
      }, [nonce, ctx]);

      useEffect(function () {
        try {
          if (typeof window === 'undefined' || typeof window.setInterval !== 'function') return undefined;
          var timer = window.setInterval(function () {
            setNonce(function (value) { return value + 1; });
          }, REFRESH_MS);
          return function () {
            try { if (typeof window.clearInterval === 'function') window.clearInterval(timer); } catch (error) { /* 已卸载 */ }
          };
        } catch (error) {
          return undefined;
        }
      }, []);

      var view = snap.view;
      var bar = view ? view.状态条 : null;
      var gate = bar ? bar.闸 : null;
      var probe = bar ? bar.探针 : null;
      var tasks = view ? view.任务节点 : [];
      var 待你决定 = view ? view.待你决定 : [];
      var 会审 = view ? view.会审 : [];
      var audit = view ? view.审计尾.slice(-AUDIT_LIMIT).reverse() : [];
      var boundReadOnly = view ? boolOf(firstOf(view.边界, ['只读', 'readonly'])) : null;
      // 闸不在位 / 已失联是两件「现在能不能干活」的事：false 才告警，null（宿主没给）不当成故障。
      var gateAlarm = !!gate && gate.在位 === false;
      var lostAlarm = !!bar && bar.失联 === true;

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
                onClick: function () { setNonce(function (value) { return value + 1; }); },
              }, '刷新'),
            ]),
          ]),
          h('div', { key: 'ro', className: 'dshmind-readouts' }, [
            readout('项目键', view ? view.项目 : '—'),
            readout('生成时刻', view ? shortTime(view.生成于) || '—' : '—'),
            readout('策略引擎闸', null, h('span', { className: 'dshmind-dot-line' }, [
              dot(!gate ? GREY : gate.在位 === true ? GREEN : gate.在位 === false ? RED : GREY),
              h('span', { key: 'v' }, !gate ? '未接入' : gate.在位 === true ? '闸在位' : gate.在位 === false ? '闸不在位' : '未知'),
              gate && gate.规则数 !== null
                ? h('span', { key: 'n', className: 'dshmind-mono', style: { color: 'var(--dsw-alias-label-tertiary,#81858c)' } }, '规则 ' + gate.规则数)
                : null,
              gate && gate.错误 ? h('span', { key: 'e' }, gate.错误) : null,
            ].filter(Boolean)), gateAlarm),
            readout('介入度档位', null, bar
              ? h('span', { style: { display: 'inline-flex', flexWrap: 'wrap', gap: 3 } },
                  ['零参与', '事后抽检', '变更预审', '逐条审批'].map(function (level) {
                    var on = bar.介入度 === level;
                    return h('span', {
                      key: level,
                      className: 'dshmind-badge',
                      style: {
                        color: on ? 'var(--dsw-alias-label-primary-inverted,#fff)' : 'var(--dsw-alias-label-tertiary,#81858c)',
                        background: on ? 'var(--dsw-alias-state-business-primary,#0f1115)' : 'transparent',
                        borderColor: on ? 'transparent' : 'var(--dsw-alias-border-l2,#0000001f)',
                      },
                    }, level);
                  }))
              : '—'),
            readout('失联状态', null, h('span', { className: 'dshmind-dot-line' }, [
              dot(!bar ? GREY : bar.失联 === true ? RED : bar.失联 === false ? GREEN : GREY),
              h('span', { key: 'v' }, !bar ? '未接入' : bar.失联 === true ? '已失联 · 自治冻结' : bar.失联 === false ? '在位' : '未知'),
            ]), lostAlarm),
            readout('安全类探针', null, h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } }, [
              dot(!probe ? GREY : probe.见红.length ? RED : probe.状态 === '正常' || probe.状态 === '绿' ? GREEN : GREY),
              h('span', { key: 'v' }, probe ? probe.状态 : '未接入'),
              probe && probe.见红.length ? h('span', { key: 'r' }, '见红：' + probe.见红.join('、')) : null,
              probe && probe.恒红 ? badge('恒红警报', 'red') : null,
              probe && probe.恒绿 ? badge('恒绿警报', 'warn') : null,
            ].filter(Boolean))),
          ]),
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
                  return h('article', { key: line(task.id, 'task-' + index), className: cls }, [
                    h('div', { key: 'top', className: 'dshmind-nodeTop' }, [
                      h('span', { key: 't', className: 'dshmind-nodeTitle' }, line(task.描述 || task.标题 || task.id, '未命名节点')),
                      h('span', { key: 'st', className: 'dshmind-badge', style: {
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
                      h('span', { key: 'v' }, criteria.length ? criteria.join('；') : '（缺失 —— 建节点时必填）'),
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
        section(4, '审计流', '只增的事实记录 · 写入无条件',
          audit.length ? '末 ' + audit.length + ' 条' : '',
          audit.length
            ? h('div', { className: 'dshmind-audit' }, audit.map(function (row, index) {
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
              }))
            : h('div', { className: 'dshmind-empty' }, '审计尾为空 —— 没有事实记录，或工作台投影未附带审计尾。')),

        // 页脚：只读边界与命令回显
        h('footer', { key: 'foot', className: 'dshmind-foot' }, [
          h('span', { key: 'b' }, boundReadOnly === true ? '共享工作台：投影只读 ✓' : boundReadOnly === false ? '⚠ 边界未声明只读' : '边界：未知'),
          h('span', { key: 'c' }, '命令 ' + COMMAND),
          h('span', { key: 's' }, '会话 ' + (snap.sessionId ? snap.sessionId.slice(0, 12) : '—') + (snap.source ? '（' + snap.source + '）' : '')),
          view ? h('span', { key: 'm' }, '待你决定 ' + 待你决定.length + ' 项 · 会审 ' + 会审.length + ' 场 · 任务 ' + tasks.length + ' 节点') : null,
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

    // ── 插件体 ──────────────────────────────────────────────────────────────
    /**
     * 两处注册，一个面板：
     *  1. `main`（keyed，声明方 `@deepseek-ai/dsh-client-ui-layout`）—— 面板本体；
     *  2. `sidebar.panellist`（list，声明方 `@deepseek-ai/dsh-client-ui-sidebar`）—— 侧边栏里的面板入口。
     *
     * 入口排在**插件入口下面**：插件那一行的 `order` 是 0，本组件是 10。
     * 不留 `settings.section`：看板是常驻运维视图，不是一项设置。
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

      // 看板是「按需」的一个组件：它可能被宿主配置关掉。
      // 浏览器半区读不到那份配置，所以问一次宿主；关着就自己撤下席位，
      // 不留一个点了没反应的按钮。问不到（无会话 / 无 remote）就默认显示——
      // 界面可见性不是安全边界，真去取数时宿主会照旧拒绝。
      probeBoardEnabled(ctx).then(function (enabled) {
        if (enabled === false) disposeAll();
      });

      return disposeAll;
    }

    /**
     * 问一次宿主：看板组件现在是开是关？
     * @returns {Promise<boolean|null>} true/false；问不到返回 null（按显示处理）
     */
    function probeBoardEnabled(ctx) {
      return new Promise(function (resolve) {
        try {
          var session = resolveSessionId(ctx);
          if (!session || !session.id) { resolve(null); return; }
          var remote = ctx && typeof ctx.get === 'function' ? ctx.get('remote') : null;
          if (!remote || !remote.commands || typeof remote.commands.execute !== 'function') { resolve(null); return; }
          Promise.resolve(remote.commands.execute(session.id, '/mind components', [])).then(function (response) {
            try {
              var result = response && response.value && response.value.result;
              if (!result || result.kind !== 'success') { resolve(null); return; }
              var parsed = parseLooseJson(result.text);
              var 名册 = parsed && parsed.组件;
              if (!名册 || !名册.board) { resolve(null); return; }
              resolve(名册.board.已装载 !== false);
            } catch (error) {
              resolve(null);
            }
          }).catch(function () { resolve(null); });
        } catch (error) {
          resolve(null);
        }
      });
    }

    return { name: 'dsh-mind-board', inject: ['slots'], apply: apply };
  },
});
