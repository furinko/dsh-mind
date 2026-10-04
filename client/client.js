// client/client.js — 心智面板（**浏览器半**，手写 bundle，无构建步骤）。
//
// ── 形态为什么是 `__ModuleLoader__.load({ id, factory })` ─────────────────────
//   官方外壳的客户端模块装载器只认这一种形态（`require` 只给外壳**已外部化**的模块：
//   `react` / `react/jsx-runtime`）⇒ 本文件不 import 任何东西，全部走工厂参数。
//   `id` **必须与 host 半 `api.js` 的 `CLIENT_ID` 一致**（boot 行按 id 去重，自测盯着这条）。
//
// ── 装在哪两处（都在本机实测存在的槽位上，别凭记忆加）─────────────────────────
//   · `conversation.view`（id=`mind`）—— 对话/轨迹同级的**顶级视图**：完整面板
//     （视图内两种模式：**图谱**＝分层色带知识地图〔默认〕 / **数字**＝读数卡 + 文件浏览）
//   · `sidebar.footer.action` —— 左栏页脚挂件：一眼看到"接没接入 + 几个警告"
//   槽位不存在时注册会一直挂起（官方语义），不报错；`slots.inject` 不可用时退回 `effect`。
//
// ── 数据从哪来（同源 loopback，host 半 `lib/host/api.js`）─────────────────────
//   GET /api/mind/status · /api/mind/tree?zone= · /api/mind/file?zone=&rel=
//     · /api/mind/graph[?project=] · /api/mind/connect
//   浏览器**不碰文件系统**：所有事实由 host 半读成 JSON，隐私边界只有一条。
//
// ⚠️ **浏览器半是热更的，host 半不是**：外壳按内容散列服务本文件（rev 变即换代码），
//    而 host 插件要重启才换。所以「前端已是新版、后端还是旧形状」这个窗口期**真实存在**——
//    图谱那一格会明说"宿主半还是旧版（没 layers）⇒ 重启后端再看"，而不是画出半张图让人猜。
//
// ── 边界（诚实标注）──────────────────────────────────────────────────────────
//   本面板**只读 + 一个接入开关**。没有裁决/放行入口（本包 guard 没有放行通道），
//   不改记忆/待办（不属本包）。面板里出现的每个数字都直接来自盘上读数——
//   **空就说空**（空壳时它会明写"0 张角色卡"），不做美化。

window.__ModuleLoader__.load({
  id: "dsh-mind",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var jsx = require("react/jsx-runtime");
    var React = require("react");
    var h = React.createElement;

    // ── 样式（注入一次；颜色全走官方 CSS 变量，跟随主题/暗色）─────────────────
    var CSS_ID = "dsh-mind/panel.css";
    function ensureStyle() {
      if (typeof document === "undefined") return;
      if (document.querySelector('style[data-plugin-css="' + CSS_ID + '"]')) return;
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-mind";
      tag.dataset.pluginCss = CSS_ID;
      tag.textContent = [
        ".dm-root{flex:1 1 0;box-sizing:border-box;width:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden;font-size:13px;color:var(--dsw-alias-label-primary)}",
        ".dm-head{display:flex;align-items:center;gap:10px;padding:8px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;flex-wrap:wrap}",
        ".dm-title{font-size:14px;font-weight:700;display:inline-flex;align-items:center;gap:6px}",
        ".dm-stat{font-size:11.5px;color:var(--dsw-alias-label-tertiary);margin-left:auto;white-space:nowrap}",
        ".dm-btn{box-sizing:border-box;height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}",
        ".dm-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
        ".dm-btn.on{background:var(--dsw-alias-brand-primary,#4D6BFE);border-color:transparent;color:#fff}",
        ".dm-body{flex:1;min-height:0;display:flex;overflow:hidden;align-items:stretch}",
        ".dm-col{flex:1 1 0;min-width:0;overflow-y:auto;padding:12px 14px 24px}",
        ".dm-col+.dm-col{border-left:1px solid var(--dsw-alias-border-l1);flex:0 1 340px}",
        ".dm-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;margin-bottom:10px;background:var(--dsw-alias-bg-layer-2,transparent)}",
        ".dm-card-title{font-size:12px;font-weight:700;color:var(--dsw-alias-label-secondary);margin:0 0 8px;letter-spacing:.3px}",
        ".dm-row{display:flex;gap:8px;align-items:baseline;padding:2px 0;font-size:12px;line-height:18px}",
        ".dm-row-k{flex:0 0 auto;color:var(--dsw-alias-label-tertiary);min-width:96px}",
        ".dm-row-v{flex:1 1 auto;min-width:0;word-break:break-all}",
        ".dm-mono{font-family:Consolas,'Cascadia Mono',monospace;font-size:11.5px}",
        ".dm-warn{border:1px solid var(--dsw-alias-state-warn-primary,#b8860b);border-radius:10px;padding:8px 12px;margin-bottom:10px;background:rgba(240,180,41,.10);font-size:12px;line-height:19px}",
        ".dm-warn b{font-weight:600}",
        ".dm-warn ul{margin:4px 0 0;padding-left:18px}",
        ".dm-ok{color:var(--dsw-alias-state-success-primary,#1e9e73)}",
        ".dm-bad{color:var(--dsw-alias-state-error-primary,#d9483b)}",
        ".dm-dim{color:var(--dsw-alias-label-tertiary)}",
        ".dm-tags{display:flex;flex-wrap:wrap;gap:4px}",
        ".dm-tag{padding:1px 7px;border-radius:99px;font-size:11px;background:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}",
        ".dm-list{max-height:56vh;overflow:auto}",
        ".dm-item{display:block;width:100%;text-align:left;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:20px;padding:3px 6px;border-radius:6px;cursor:pointer;word-break:break-all}",
        ".dm-item:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
        ".dm-item.sel{background:rgba(77,107,254,.12);color:var(--dsw-alias-brand-primary,#4D6BFE)}",
        ".dm-pre{margin:0;white-space:pre-wrap;word-break:break-word;font-size:11.5px;line-height:1.6;font-family:Consolas,'Cascadia Mono',monospace;color:var(--dsw-alias-label-secondary)}",
        ".dm-widget{box-sizing:border-box;width:100%;min-width:0;padding:5px 6px 4px;display:flex;align-items:center;gap:6px;border-top:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:12px}",
        ".dm-widget:hover{background:var(--dsw-alias-interactive-bg-hover)}",
        ".dm-dot{width:8px;height:8px;border-radius:99px;flex:none;background:var(--dsw-alias-state-success-primary,#1e9e73)}",
        ".dm-dot.off{background:var(--dsw-alias-label-tertiary)}",
        ".dm-badge{margin-left:auto;font-size:10.5px;padding:0 6px;border-radius:99px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
        ".dm-mode{display:flex;gap:4px;margin-left:2px}",
        ".dm-mode .dm-btn{height:24px;padding:0 9px;font-size:11.5px}",
        ".dm-col-graph{padding:8px;overflow:hidden;display:flex;flex-direction:column;min-height:360px}",
        ".dm-tools{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:0 2px 8px;flex:none}",
        ".dm-input{box-sizing:border-box;height:24px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;width:168px}",
        ".dm-graph-scroll{flex:1 1 0;min-height:0;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2,transparent)}",
        ".dm-graph{display:block;touch-action:none}",
        ".dm-legend{display:flex;gap:9px;align-items:center;font-size:10.5px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.72));border:1px solid var(--dsw-alias-border-l1);padding:3px 8px;border-radius:8px;flex-wrap:wrap;margin-top:8px}",
        ".dm-sw{display:inline-block;width:7px;height:7px;border-radius:99px;margin-right:4px;vertical-align:middle}",
        ".dm-dise{display:flex;gap:6px;align-items:baseline;padding:3px 0;font-size:11.5px;line-height:17px;border-bottom:1px dashed var(--dsw-alias-border-l1)}",
        ".dm-dise:last-child{border-bottom:none}",
        ".dm-dise-k{flex:1 1 auto;min-width:0;word-break:break-all;font-family:Consolas,'Cascadia Mono',monospace}",
        ".dm-dise-n{flex:0 0 auto;color:var(--dsw-alias-label-tertiary);font-size:11px}",
        ".dm-why{flex:0 0 auto;font-size:10px;padding:0 5px;border-radius:99px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}",
        ".dm-why.missing{border-color:var(--dsw-alias-state-error-primary,#d9483b);color:var(--dsw-alias-state-error-primary,#d9483b)}",
        ".dm-nbr{display:block;width:100%;text-align:left;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;line-height:18px;padding:1px 4px;border-radius:5px;cursor:pointer;word-break:break-all}",
        ".dm-nbr:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
        "@media (max-width:1100px){.dm-body{flex-direction:column;overflow:auto}.dm-col{overflow:visible}.dm-col-graph{overflow:visible;min-height:46vh}.dm-col+.dm-col{border-left:none;border-top:1px solid var(--dsw-alias-border-l1);flex:1 1 auto}.dm-list{max-height:32vh}}"
      ].join("");
      document.head.appendChild(tag);
    }

    // ── 取数（三个口子；失败一律降级成"读不到"，不编数字）───────────────────
    function getJSON(url) {
      return fetch(url, { signal: AbortSignal.timeout(8000) })
        .then(function (r) { return r.json(); })
        .catch(function () { return null; });
    }
    function postJSON(url, body) {
      return fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
        signal: AbortSignal.timeout(8000)
      }).then(function (r) { return r.json(); }).catch(function () { return null; });
    }

    // ── 浏览器自报（beacon）───────────────────────────────────────────────────
    // 为什么要有：后端**看不见浏览器**。链路任何一环断掉（模块没执行 / 槽位不存在 /
    // 组件渲染抛错），从盘上看到的都只是"没事发生"——上一轮正是被这种静默骗过去的
    // （自托管的 boot 行注入 `if (!Array.isArray(graph)) return html` 直接 no-op，链路根本没通）。
    // 现在四格全程留痕：apply → slot → render → error。
    function beacon(what, detail) {
      try {
        var q = "/api/mind/beacon?what=" + encodeURIComponent(String(what || ""))
          + (detail ? "&detail=" + encodeURIComponent(String(detail).slice(0, 180)) : "");
        fetch(q, { signal: AbortSignal.timeout(4000) }).catch(function () {});
      } catch (e) { /* 自报失败绝不能影响渲染 */ }
    }
    var renderReported = false;
    var widgetReported = false;
    var graphReported = false;

    function fmtBytes(n) {
      if (n === null || n === undefined) return "—";
      if (n < 1024) return n + " B";
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
      return (n / 1024 / 1024).toFixed(1) + " MB";
    }
    function fmtTime(iso) {
      if (!iso) return "—";
      try { return new Date(iso).toLocaleTimeString("zh-CN"); } catch (e) { return String(iso); }
    }

    function Row(k, v, mono) {
      return h("div", { className: "dm-row" },
        h("span", { className: "dm-row-k" }, k),
        h("span", { className: "dm-row-v" + (mono ? " dm-mono" : "") }, v));
    }

    function Card(title, children) {
      return h("div", { className: "dm-card" },
        h("div", { className: "dm-card-title" }, title),
        children);
    }

    /** 状态拉取 + 轮询（面板打开时 15s 一次；关掉即停）。 */
    function useStatus() {
      var st = React.useState(null);
      var status = st[0], setStatus = st[1];
      var ts = React.useState(0);
      var stamp = ts[0], setStamp = ts[1];
      React.useEffect(function () {
        var alive = true;
        getJSON("/api/mind/status").then(function (d) { if (alive && d && d.ok) setStatus(d); });
        var timer = setInterval(function () {
          getJSON("/api/mind/status").then(function (d) { if (alive && d && d.ok) setStatus(d); });
        }, 15000);
        return function () { alive = false; clearInterval(timer); };
      }, [stamp]);
      return [status, function () { setStamp(function (s) { return s + 1; }); }];
    }

    /**
     * 官方启动图读数（`/api/mind/boot` → `clientModules.graph()`）。
     * 为什么面板自己要看它：**"我的浏览器半在不在启动图里"是把"面板看不见"一分为二的那一刀**
     * （不在 ⇒ 声明/导出问题；在 ⇒ 看 beacon 走到哪一格）。
     */
    function useBoot() {
      var b = React.useState(null);
      var boot = b[0], setBoot = b[1];
      React.useEffect(function () {
        var alive = true;
        getJSON("/api/mind/boot").then(function (d) { if (alive && d && d.ok) setBoot(d); });
        return function () { alive = false; };
      }, []);
      return boot;
    }

    /** 接入开关（当前会话）。取不到 sessionId ⇒ 明说"识别不到会话"，不假装能切。 */
    function ConnectSwitch(props) {
      var sessionId = props && props.sessionId;
      var st = React.useState(null);
      var state = st[0], setState = st[1];
      var busySt = React.useState(false);
      var busy = busySt[0], setBusy = busySt[1];
      React.useEffect(function () {
        if (!sessionId) return undefined;
        var alive = true;
        getJSON("/api/mind/connect?session=" + encodeURIComponent(sessionId))
          .then(function (d) { if (alive && d && d.ok) setState(d); });
        return function () { alive = false; };
      }, [sessionId]);
      if (!sessionId) {
        return h("span", { className: "dm-dim", title: "本视图没拿到会话 id" }, "会话未识别");
      }
      var on = !state || state.enabled !== false;
      var label = on ? "已接入心智" : "已关闭心智";
      function toggle() {
        if (busy) return;
        setBusy(true);
        postJSON("/api/mind/connect", { session: sessionId, enabled: !on })
          .then(function (d) { if (d && d.ok) setState(d); })
          .then(function () { setBusy(false); });
      }
      return h("button", {
        className: "dm-btn" + (on ? " on" : ""),
        onClick: toggle,
        disabled: busy,
        title: on ? "点按＝本会话不再注入宪法/召回/护栏" : "点按＝本会话重新接入心智"
      }, label);
    }

    /** 顶部：标题 + **图谱/数字**切换 + 开关 + 刷新 + 数据根。 */
    function Header(props) {
      var s = props.status;
      return h("div", { className: "dm-head" },
        h("span", { className: "dm-title" }, "心智"),
        h("div", { className: "dm-mode" },
          h("button", {
            className: "dm-btn" + (props.mode === "graph" ? " on" : ""),
            onClick: function () { if (props.onMode) props.onMode("graph"); },
            title: "知识网络：文件为点、正文里的 .md 引用为线",
          }, "图谱"),
          h("button", {
            className: "dm-btn" + (props.mode === "facts" ? " on" : ""),
            onClick: function () { if (props.onMode) props.onMode("facts"); },
            title: "读数面板：固件/记忆/项目/插件运行读数 + 文件浏览",
          }, "数字")),
        h(ConnectSwitch, { sessionId: props.sessionId }),
        h("button", { className: "dm-btn", onClick: props.onRefresh }, "刷新"),
        h("span", { className: "dm-stat" },
          s ? ("更新 " + fmtTime(s.at) + " · 关闭中的会话 " + s.connect.offCount) : "读取中…"));
    }

    /** 左列：事实（固件 / 记忆 / 项目 / 插件读数）。 */
    function Facts(props) {
      // 渲染已到达 = 链路最后一格（见 beacon 注释）
      if (!renderReported) { renderReported = true; beacon("render", "facts"); }
      try {
        return FactsBody(props);
      } catch (e) {
        // 渲染抛错在浏览器里表现为"整块空白"——上报 + 就地显示，别让它无声无息
        beacon("error", "facts: " + ((e && e.message) || e));
        return h("div", { className: "dm-col" },
          h("div", { className: "dm-warn" },
            h("b", null, "面板渲染出错（已上报到 /api/mind/beacon）"),
            h("div", { className: "dm-mono" }, String((e && e.message) || e))));
      }
    }

    function FactsBody(props) {
      var s = props.status;
      if (!s) return h("div", { className: "dm-col" }, h("div", { className: "dm-dim" }, "读不到 /api/mind/status（host 半 api 插件没起来？）"));
      var fw = s.firmware || {};
      var v = s.vault || {};
      var l3 = v.l3 || { topics: [], fileCount: 0 };
      var roles = [];
      if (Array.isArray(s.markers)) {
        roles = s.markers.filter(function (m) { return !["connect", "api"].includes(m.name); });
      }
      return h("div", { className: "dm-col" },
        (s.warnings && s.warnings.length)
          ? h("div", { className: "dm-warn" },
            h("b", null, "实况警告（" + s.warnings.length + "）"),
            h("ul", null, s.warnings.map(function (w, i) { return h("li", { key: i }, w); })))
          : h("div", { className: "dm-card dm-ok" }, "无警告：固件就位、插件有运行读数、私有区非空"),

        (s.notes && s.notes.length)
          ? h("div", { className: "dm-card" },
            h("div", { className: "dm-card-title" }, "说明（沉默但属设计，不是故障）"),
            h("ul", {
              style: { margin: 0, paddingLeft: "18px", fontSize: "12px", lineHeight: "19px", color: "var(--dsw-alias-label-secondary)" }
            }, s.notes.map(function (n, i) { return h("li", { key: i }, n); })))
          : null,

        Card("面板自检（这面板自己有没有被加载）",
          Row("浏览器半已执行", s.clientApplied ? "是（apply 已自报）" : "否（模块没被执行，或页面没刷新）"),
          Row("浏览器自报", (s.clientBeacons && Object.keys(s.clientBeacons).length)
            ? Object.keys(s.clientBeacons).map(function (k) { return k + "×" + s.clientBeacons[k].n; }).join(" · ")
            : "（一格都没到）"),
          Row("启动图里的我", props.boot
            ? (props.boot.hasSelf
              ? "在（" + ((props.boot.selfEntry && props.boot.selfEntry.url) || "") + "）"
              : "**不在**（entries " + ((props.boot.entries || []).length) + " 条；`dsh.client` 没被编进启动图）")
            : "读不到 /api/mind/boot"),
          Row("路由命中", (s.hits && Object.keys(s.hits).length)
            ? Object.keys(s.hits).map(function (k) { return k.replace("/api/mind/", "") + "×" + s.hits[k]; }).join(" · ")
            : "无", true)),

        Card("固件（R0 的源）",
          Row("数据根", s.paths.dataRoot, true),
          Row("出厂区", s.paths.mindDir, true),
          Row("私有区", s.paths.privateDir, true),
          Row("已就位", fw.ready ? "是" : "否（缺 " + (fw.missing || []).join("、") + "）", false),
          Row("包内有固件源", fw.firmwareAvailable ? "是" : "否", false)),

        Card("R0 / R1 注入读数",
          Row("R0 宪法", s.live.injectLen === null ? "无读数" : s.live.injectLen + " 字节"),
          Row("R1 召回", s.live.recallLen === null ? "无读数" : s.live.recallLen + " 字节"),
          Row("压缩留痕", s.live.compactionLines === null ? "读不到" : s.live.compactionLines + " 行")),

        Card("私有区（本机心智）",
          Row("角色卡", v.roleCardCount + " 张" + (v.roleCardCount ? "" : "（派不出成员）")),
          Row("人设卡", v.persona && v.persona.present ? ("有 · " + fmtBytes(v.persona.bytes)) : "无（用 SOUL 通用款）"),
          Row("user-rules", v.userRules && v.userRules.present ? ("有 · " + fmtBytes(v.userRules.bytes)) : "无"),
          Row("Learn 教训", v.learnCount + " 条"),
          Row("L3 记忆", l3.fileCount + " 个文件 / " + (l3.topics || []).length + " 个主题"),
          (l3.topics && l3.topics.length)
            ? h("div", { className: "dm-tags" }, l3.topics.map(function (t, i) {
              return h("span", { className: "dm-tag", key: i }, t.topic + " · " + t.files);
            }))
            : null),

        Card("项目待办",
          (v.projects && v.projects.length)
            ? v.projects.map(function (p, i) {
              return Row(p.key, "未完成 " + p.todos + " · 已完成 " + p.done, false);
            })
            : h("div", { className: "dm-dim" }, "没有项目档")),

        Card("插件运行读数（挂载 ≠ 生效）",
          roles.length
            ? roles.map(function (m, i) {
              return h("div", { className: "dm-row", key: i },
                h("span", { className: "dm-row-k" }, m.name),
                h("span", { className: "dm-row-v" },
                  h("span", { className: m.runtime > 0 ? "dm-ok" : "dm-bad" }, m.runtime > 0 ? "运行 " + m.runtime + " 条" : "零运行读数"),
                  h("div", { className: "dm-dim dm-mono" }, m.lastRuntime || m.last || "（无留痕）")));
            })
            : h("div", { className: "dm-dim" }, "无 marker")),

        Card("关闭中的会话",
          (s.connect.offSessions && s.connect.offSessions.length)
            ? s.connect.offSessions.map(function (id, i) {
              return h("div", { className: "dm-row", key: i },
                h("span", { className: "dm-row-v dm-mono" }, id),
                h("button", {
                  className: "dm-btn",
                  onClick: function () {
                    postJSON("/api/mind/connect", { session: id, enabled: true }).then(props.onRefresh);
                  }
                }, "接回"));
            })
            : h("div", { className: "dm-dim" }, "全部会话都接着（默认接入）")));
    }

    /** 右列：文件浏览（只读；左选右看）。 */
    function Files(props) {
      var zoneSt = React.useState("private");
      var zone = zoneSt[0], setZone = zoneSt[1];
      var listSt = React.useState([]);
      var files = listSt[0], setFiles = listSt[1];
      var selSt = React.useState(null);
      var sel = selSt[0], setSel = selSt[1];

      React.useEffect(function () {
        var alive = true;
        getJSON("/api/mind/tree?zone=" + zone).then(function (d) {
          if (alive && d && d.ok) setFiles(d.files || []);
        });
        setSel(null);
        return function () { alive = false; };
      }, [zone]);

      function open(rel) {
        getJSON("/api/mind/file?zone=" + zone + "&rel=" + encodeURIComponent(rel)).then(function (d) {
          if (d && d.ok) setSel({ rel: rel, text: d.text, truncated: d.truncated, bytes: d.bytes });
          else setSel({ rel: rel, text: "（读不到：" + ((d && d.error) || "未知") + "）" });
        });
      }

      return h("div", { className: "dm-col" },
        h("div", { className: "dm-card-title" }, "文件（只读）"),
        h("div", { style: { display: "flex", gap: "6px", marginBottom: "8px" } },
          h("button", { className: "dm-btn" + (zone === "private" ? " on" : ""), onClick: function () { setZone("private"); } }, "私有区"),
          h("button", { className: "dm-btn" + (zone === "mind" ? " on" : ""), onClick: function () { setZone("mind"); } }, "出厂区")),
        h("div", { className: "dm-list" },
          files.length
            ? files.map(function (f, i) {
              return h("button", {
                key: i,
                className: "dm-item" + (sel && sel.rel === f.rel ? " sel" : ""),
                onClick: function () { open(f.rel); },
                title: fmtBytes(f.bytes)
              }, f.rel);
            })
            : h("div", { className: "dm-dim" }, "（空）")),
        sel
          ? h("div", { className: "dm-card", style: { marginTop: "10px" } },
            h("div", { className: "dm-card-title" }, sel.rel + " · " + fmtBytes(sel.bytes) + (sel.truncated ? "（已截断）" : "")),
            h("pre", { className: "dm-pre" }, sel.text))
          : null);
    }

    // ══ 心智图谱（分层色带 + 卡片流式布局）══════════════════════════════════════
    //
    // ── 为什么推倒重画（2026-10-04 主人："不好，你参考DSHOME的图谱呗"）───────────
    //   v1 是**力导向圆点图**：45 个点、211 条边，其中 `Tree.md` 一张索引表刷出 32 条
    //   "我列了你"的边 ⇒ 枢纽全由排版决定、与语义无关，看着就是一团毛线。
    //   参考实现（`E:\DSHOME\packages\dshome-mind`，「🐳 心智图谱」）根本不是这么画的：
    //     · **分层色带**：L0→L3 自上而下一条条半透明色带，层标题在带左上
    //     · **卡片流式排布**：层内节点是矩形卡片，从左到右摆、超宽换行——是"结构化地图"，
    //       不是弹簧网；层数/节点数涨上去也照样能读
    //     · **边是贝塞尔曲线**，画在卡片**下层**，只连 `related`/`tags`/`topic`（语义边）
    //   ⇒ 本层照这套画。布局是**确定性**的（无随机、无迭代），所以可截图比对、可复现。
    //
    // ── 两条硬约束（都来自参考实现的翻车记录）──────────────────────────────────
    //   ① 层表**不许两边各写一份**：参考实现里客户端 `LAYER_ORDER` 漏登记一个层 id ⇒
    //      布局不给它排位 ⇒ 渲染时读 `p.x` 抛 TypeError ⇒ **整块图谱白屏**（其后的节点全不画）。
    //      现在层表由**宿主**随图数据一起下发（`data.layers`），客户端只消费 ⇒ 这一类缺陷
    //      在结构上不可能发生（`FALLBACK_LAYERS` 只服务"老宿主没给"的退化场景）。
    //   ② 面板**必须锁进可视高度**（页内自己滚、页面不滚）：整页滚是 chat 视图的官方模式，
    //      面板不是。所以画布外层是 `overflow:auto` 的滚动容器，高度由 flex 锁死。
    //
    // ── 交互（对齐参考实现）────────────────────────────────────────────────────
    //   点卡片＝选中（描边）→ 右列出详情；悬停＝高亮该卡 + 它的边加粗提亮；
    //   搜索＝按 label/rel 淡化未命中；拖空白＝平移；＋/－＝缩放；项目钮＝切换 L3 项目记忆视角。

    // 画布常量（照抄参考实现的量纲：1240 宽、卡片 36 高、单行 17、带间 34）
    var CANVAS_W = 1240, NODE_H = 36, LINE_H = 17, MAX_NODE_W = 230;
    var ROW_GAP = 12, LAYER_GAP = 34, LAYER_TITLE_H = 34, SIDE_PAD = 24, NODE_GAP = 14;
    var FONT = "12.5px system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif";

    /** 退化兜底：宿主没下发 `layers` 时用（正常路径永远走宿主那份，见上面约束 ①）。 */
    var FALLBACK_LAYERS = [
      { id: "L0", label: "L0 宪法", color: "#8b5cf6" },
      { id: "L1", label: "L1 规则", color: "#4D6BFE" },
      { id: "L2S", label: "L2 技能", color: "#10b981" },
      { id: "L2E", label: "L2 经验", color: "#14b8a6" },
      { id: "AG", label: "角色卡", color: "#a78bfa" },
      { id: "L3I", label: "L3 记忆", color: "#f97316" },
      { id: "L3P", label: "项目记忆", color: "#ef4444" },
      { id: "L3H", label: "L3 历史", color: "#f59e0b" },
      { id: "TR", label: "回收站", color: "#64748b" },
      { id: "TK", label: "任务缓冲", color: "#ec4899" },
      { id: "OT", label: "其他（非标路径）", color: "#94a3b8" },
    ];

    // ── 文字量宽（决定卡片宽与折行）──────────────────────────────────────────
    // 浏览器里用 canvas 精确测（中英混排不出界）；**没有 canvas 时必须退回估算**——
    // 否则 node 侧的自测根本跑不了布局，而"布局"恰恰是最该被测的一段（白屏族）。
    var textCtx = null, textCtxTried = false;
    function textWidth(s) {
      var str = String(s == null ? "" : s);
      if (!textCtxTried) {
        textCtxTried = true;
        try {
          if (typeof document !== "undefined" && document.createElement) {
            textCtx = document.createElement("canvas").getContext("2d");
            textCtx.font = FONT;
          }
        } catch (e) { textCtx = null; }
      }
      if (textCtx) {
        try { return textCtx.measureText(str).width; } catch (e) { /* 落到估算 */ }
      }
      var w = 0;
      for (var i = 0; i < str.length; i++) w += str.charCodeAt(i) > 0x2e80 ? 12.5 : 6.6;
      return w;
    }
    function nodeWidth(label) {
      return Math.max(120, Math.min(MAX_NODE_W, 34 + textWidth(label) + 28));
    }
    function splitLines(text, maxW) {
      var out = [], cur = "", chars = Array.from(String(text));
      for (var i = 0; i < chars.length; i++) {
        var test = cur + chars[i];
        if (textWidth(test) > maxW && cur !== "") { out.push(cur); cur = chars[i]; }
        else cur = test;
      }
      if (cur !== "") out.push(cur);
      return out.length ? out : [String(text)];
    }
    function nodeLines(label, w, pad) {
      var avail = w - pad - 4;
      return textWidth(label) > avail ? splitLines(label, avail) : [label];
    }

    /**
     * 分层色带 + 卡片流式布局（**纯函数、确定性**）。
     *
     * 返回 `{ pos, bands, width, height }`：
     *   · `pos[id] = {x,y,w,h,lines,tx}` —— 卡片左上角与折行结果
     *   · `bands[]  = {top,bottom,label,color}` —— 色带矩形（含层标题）
     * 排布规则：层内按「出厂在前、再按 label 中文序」排；从左到右摆，超出画布宽就换行；
     * `L3P`（项目记忆）**按项目拆子段**（"项目记忆 · 各项目名"），避免多项目混成一排。
     */
    function layoutGraph(nodes, layers, opts) {
      var list = Array.isArray(nodes) ? nodes : [];
      var table = (Array.isArray(layers) && layers.length) ? layers : FALLBACK_LAYERS;
      var projectMode = opts && opts.project;
      var byLayer = {};
      list.forEach(function (n) { (byLayer[n.layer] = byLayer[n.layer] || []).push(n); });
      function sortNode(a, b) {
        if (a.zone !== b.zone) return a.zone === "mind" ? -1 : 1;
        return String(a.label).localeCompare(String(b.label), "zh");
      }
      var groups = [];
      table.forEach(function (lay) {
        var arr = byLayer[lay.id] || [];
        if (!arr.length) return;
        if (lay.id === "L3P" && !projectMode) {
          var byP = {};
          arr.forEach(function (n) { (byP[n.project || "?"] = byP[n.project || "?"] || []).push(n); });
          Object.keys(byP).sort(function (a, b) { return a.localeCompare(b, "zh"); }).forEach(function (p) {
            byP[p].sort(sortNode);
            groups.push({ label: lay.label + " · " + p, color: lay.color, nodes: byP[p] });
          });
        } else {
          arr.sort(sortNode);
          groups.push({ label: lay.label, color: lay.color, nodes: arr });
        }
      });

      var pos = {}, bands = [], yCursor = 20, maxRight = 0;
      groups.forEach(function (grp) {
        var top = yCursor;
        yCursor += LAYER_TITLE_H;
        var x = SIDE_PAD, lineBottom = yCursor;
        grp.nodes.forEach(function (n) {
          var pad = (n.zone === "private" ? 30 : 14) + 8;
          var w = Math.min(MAX_NODE_W, nodeWidth(n.label));
          var lines = nodeLines(n.label, w, pad);
          var h = lines.length > 1 ? 12 + lines.length * LINE_H : NODE_H;
          if (x + w > CANVAS_W - SIDE_PAD) { x = SIDE_PAD; yCursor = lineBottom + ROW_GAP; }
          pos[n.id] = { x: x, y: yCursor, w: w, h: h, lines: lines, tx: pad - 8 };
          lineBottom = Math.max(lineBottom, yCursor + h);
          maxRight = Math.max(maxRight, x + w);
          x += w + NODE_GAP;
        });
        yCursor = lineBottom + LAYER_GAP;
        bands.push({ top: top, bottom: lineBottom + 8, color: grp.color, label: grp.label });
      });

      return {
        pos: pos,
        bands: bands,
        width: Math.max(CANVAS_W, maxRight + SIDE_PAD),
        height: yCursor + 10,
      };
    }

    var EDGE_COLOR = { related: "#10b981", tags: "#f59e0b", topic: "#8b5cf6" };
    var EDGE_NAME = { related: "关联 related", tags: "同标签 tags", topic: "同主题 topic" };

    function svgText(props, children) { return h("text", props, children); }

    /** 画布（**纯展示**：给 data + 布局就画出来；可供 node 侧渲染冒烟）。 */
    function GraphCanvas(props) {
      var data = props.data, laid = props.laid, sel = props.sel, hover = props.hover, q = props.q;
      var zoom = props.zoom, nodes = data.nodes || [], edges = data.edges || [];
      var pos = laid.pos;
      var idSet = {};
      nodes.forEach(function (n) { idSet[n.id] = n; });

      var ql = String(q || "").toLowerCase();
      function hit(n) {
        if (!ql) return true;
        return String(n.label).toLowerCase().indexOf(ql) >= 0 || String(n.rel).toLowerCase().indexOf(ql) >= 0;
      }
      var bands = laid.bands.map(function (b, i) {
        return h("g", { key: "b" + i },
          h("rect", {
            x: 8, y: b.top - 8, width: laid.width - 16, height: b.bottom - b.top + 8, rx: 12,
            style: { fill: b.color, fillOpacity: 0.05 },
          }),
          h("text", { x: 18, y: b.top + 6, style: { fontSize: "12px", fontWeight: 700, fill: b.color } }, b.label),
          h("circle", { cx: laid.width - 22, cy: b.top + 1, r: 3, style: { fill: b.color, opacity: 0.4 } }));
      });

      var paths = edges.map(function (e, i) {
        var a = pos[e.source], b = pos[e.target];
        if (!a || !b) return null;                       // 兜底：位置缺失也不许整块炸
        var ax = a.x + a.w / 2, ay = a.y + a.h / 2;
        var bx = b.x + b.w / 2, by = b.y + b.h / 2;
        var my = (ay + by) / 2;
        var d = "M " + ax + " " + ay + " C " + ax + " " + my + ", " + bx + " " + my + ", " + bx + " " + by;
        var lit = hover && (e.source === hover || e.target === hover);
        var on = (!ql) || (hit(idSet[e.source] || {}) && hit(idSet[e.target] || {}));
        return h("path", {
          key: "e" + i, d: d, fill: "none",
          style: {
            stroke: EDGE_COLOR[e.type] || "#10b981",
            strokeWidth: lit ? 2.4 : 1.4,
            strokeOpacity: !on ? 0.08 : (lit ? 0.95 : 0.4),
          },
        });
      }).filter(Boolean);

      var cards = nodes.map(function (n) {
        var p = pos[n.id];
        if (!p) return null;                             // 层表漏登记时的兜底（参考实现的教训）
        var priv = n.zone === "private";
        var isSel = sel === n.id;
        var on = hit(n);
        return h("g", {
          key: n.id,
          transform: "translate(" + p.x + "," + p.y + ")",
          style: { cursor: "pointer", opacity: on ? 1 : 0.12 },
          onClick: function () { props.onPick(n.id); },
          onMouseEnter: function () { props.onHover(n.id); },
          onMouseLeave: function () { props.onHover(null); },
        },
          h("rect", {
            x: 0, y: 0, width: p.w, height: p.h, rx: 9,
            style: {
              fill: priv ? n.color + "1f" : "var(--dsw-alias-bg-layer-2,#ffffff)",
              stroke: isSel ? "#111" : (priv ? n.color : "var(--dsw-alias-border-l2,#d3dcea)"),
              strokeWidth: isSel ? 2 : (priv ? 1.1 : 1),
              strokeDasharray: priv ? "4 3" : null,
            },
          }),
          h("rect", { x: 0, y: 7, width: 4, height: Math.max(4, p.h - 14), rx: 2, style: { fill: n.color } }),
          priv ? svgText({ x: 12, y: 23, style: { fontSize: "11px" } }, "🔒") : null,
          svgText({ y: p.lines.length === 1 ? 23 : (p.h - p.lines.length * LINE_H) / 2 + 13, style: { fontSize: "12.5px", fill: "var(--dsw-alias-label-primary,#1a2233)" } },
            p.lines.map(function (ln, li) { return h("tspan", { key: li, x: p.tx, dy: li === 0 ? 0 : LINE_H }, ln); })),
          h("title", null, (priv ? "🔒 " : "") + n.rel));
      }).filter(Boolean);

      var w = laid.width * zoom, hh = laid.height * zoom;
      return h("div", { className: "dm-graph-scroll", ref: props.scrollRef,
        onMouseDown: props.onPanStart, onMouseMove: props.onPanMove, onMouseUp: props.onPanEnd,
        onMouseLeave: props.onPanEnd,
        style: { cursor: props.panning ? "grabbing" : "grab" } },
        h("svg", {
          className: "dm-graph", viewBox: "0 0 " + laid.width + " " + laid.height,
          width: w, height: hh, style: { minWidth: w + "px", display: "block" },
        }, bands, paths, cards));
    }

    /** 一条读数行（详情/读数卡共用）。 */
    function GraphLegend(props) {
      var table = props.layers || FALLBACK_LAYERS;
      return h("div", { className: "dm-legend" },
        table.filter(function (l) { return props.used && props.used[l.id]; }).map(function (l) {
          return h("span", { key: l.id },
            h("i", { className: "dm-sw", style: { background: l.color } }), l.label);
        }),
        h("span", { key: "__edge" }, h("i", { className: "dm-sw", style: { background: "#10b981" } }), "related"),
        h("span", { key: "__edge2" }, h("i", { className: "dm-sw", style: { background: "#f59e0b" } }), "tags"));
    }

    function GraphDetail(props) {
      var data = props.data, sel = props.sel, onSel = props.onSel, text = props.text;
      var node = null;
      for (var i = 0; i < data.nodes.length; i++) if (data.nodes[i].id === sel) node = data.nodes[i];
      if (!node) return null;
      var outs = data.edges.filter(function (e) { return e.source === node.id; });
      var ins = data.edges.filter(function (e) { return e.target === node.id; });
      var byId = {};
      data.nodes.forEach(function (n) { byId[n.id] = n; });
      function nbr(id, type) {
        var t = byId[id];
        return h("button", { key: type + id, className: "dm-nbr", onClick: function () { onSel(id); } },
          h("span", { className: "dm-why", style: { borderColor: EDGE_COLOR[type], color: EDGE_COLOR[type] } }, type),
          " " + (t ? t.label : id));
      }
      return h("div", { className: "dm-col" },
        h("button", { className: "dm-btn", onClick: function () { onSel(null); } }, "← 返回读数"),
        h("div", { className: "dm-card", style: { marginTop: "8px" } },
          h("div", { className: "dm-card-title" }, node.label),
          Row("层", node.layerLabel + "（" + node.layer + "）"),
          Row("区", node.zone === "private" ? "私有区 🔒" : "出厂区"),
          Row("路径", node.rel, true),
          Row("大小", fmtBytes(node.bytes), true),
          Row("度", String(node.deg)),
          h("div", { style: { marginTop: "6px" } },
            h("button", {
              className: "dm-btn",
              onClick: function () {
                getJSON("/api/mind/file?zone=" + node.zone + "&rel=" + encodeURIComponent(node.rel)).then(function (d) {
                  props.onText(d && d.ok
                    ? { rel: node.rel, text: d.text, bytes: d.bytes, truncated: d.truncated }
                    : { rel: node.rel, text: "（读不到：" + ((d && d.error) || "未知") + "）" });
                });
              },
            }, "读正文"))),
        outs.length ? Card("它关联谁（" + outs.length + "）", outs.map(function (e) { return nbr(e.target, e.type); })) : null,
        ins.length ? Card("谁关联它（" + ins.length + "）", ins.map(function (e) { return nbr(e.source, e.type); })) : null,
        text ? h("div", { className: "dm-card" },
          h("div", { className: "dm-card-title" }, text.rel + " · " + fmtBytes(text.bytes) + (text.truncated ? "（已截断）" : "")),
          h("pre", { className: "dm-pre" }, text.text)) : null);
    }

    /** 右列（未选中时＝读数 + 枢纽 + 孤点 + related 落空清单）。 */
    function GraphSide(props) {
      var g = props.data;
      var used = g.stats.byLayer || {};
      var nodes = g.nodes;
      return h("div", { className: "dm-col" },
        Card("图读数（全部来自盘上读数）",
          Row("节点 / 边", g.stats.nodes + " / " + g.stats.edges),
          Row("边按来源", "related " + (g.stats.byType.related || 0) + " · tags " + (g.stats.byType.tags || 0) + " · topic " + (g.stats.byType.topic || 0)),
          Row("边密度", g.stats.edgePerNode + " 条/点（参考实现约 1.1）"),
          Row("有 frontmatter", g.stats.withFm + " / " + g.stats.nodes + " 张"),
          Row("孤点（度为 0）", g.stats.isolated + " 张"),
          Row("related 指不到盘上", g.stats.relatedMiss + " 条"),
          Row("扫了 / 跳过", g.stats.filesScanned + " 件 / " + g.stats.skippedFiles + " 件（索引件·归档副本）"),
          Row("读了", fmtBytes(g.stats.bytesRead), true),
          g.stats.truncated ? Row("⚠️ 有文件超限未读", "计数已如实标出") : null),
        Card("枢纽（度 = related 进 + 出）",
          g.stats.hubs.map(function (hb) {
            return h("button", { key: hb.id, className: "dm-nbr", onClick: function () { props.onSel(hb.id); } },
              hb.label + "　度 " + hb.deg);
          })),
        g.isolated.length ? Card("孤点（没有任何 related/tags/topic 连它）",
          g.isolated.map(function (id) {
            var n = null;
            for (var i = 0; i < nodes.length; i++) if (nodes[i].id === id) n = nodes[i];
            return h("button", { key: id, className: "dm-nbr", onClick: function () { props.onSel(id); } },
              h("span", { className: "dm-why" }, n ? n.layer : "?"), " " + (n ? n.label : id));
          })) : null,
        g.relatedMiss.length ? Card("related 没连上的（" + g.relatedMiss.length + " 条：名字指不清 "
          + ((g.stats.relatedMissByWhy && g.stats.relatedMissByWhy.ambiguous) || 0)
          + " · 盘上没这件 " + ((g.stats.relatedMissByWhy && g.stats.relatedMissByWhy.missing) || 0) + "）",
          g.relatedMiss.slice(0, 12).map(function (m, i) {
            return h("div", { className: "dm-dise", key: i },
              h("span", { className: "dm-why" + (m.why === "ambiguous" ? " missing" : "") },
                m.why === "ambiguous" ? "同名 " + m.candidates + " 份" : "缺件"),
              h("span", { className: "dm-dise-k" }, m.target),
              h("span", { className: "dm-dise-n" }, String(m.from).split(":")[1]));
          })) : null,
        GraphLegend({ layers: g.layers, used: used }));
    }

    /** 图谱主体（渲染期抛错由外层 GraphView 兜住并上报）。 */
    function GraphBody(props) {
      var gs = React.useState(null);
      var data = gs[0], setData = gs[1];
      var es = React.useState(null);
      var err = es[0], setErr = es[1];
      var ss = React.useState(null);
      var sel = ss[0], setSel = ss[1];
      var qs = React.useState("");
      var q = qs[0], setQ = qs[1];
      var hs = React.useState(null);
      var hover = hs[0], setHover = hs[1];
      var zs = React.useState(1);
      var zoom = zs[0], setZoom = zs[1];
      var ps = React.useState("");
      var project = ps[0], setProject = ps[1];
      var ts = React.useState(null);
      var text = ts[0], setText = ts[1];
      var pn = React.useState(false);
      var panning = pn[0], setPanning = pn[1];

      React.useEffect(function () {
        var alive = true;
        var url = "/api/mind/graph" + (project ? "?project=" + encodeURIComponent(project) : "");
        getJSON(url).then(function (d) {
          if (!alive) return;
          if (d && d.ok && !Array.isArray(d.layers)) {
            // 浏览器半是热更的（宿主按内容散列服务 bundle），但 host 半要重启才换代码
            // ⇒ 会出现"前端已是新版、后端还是旧形状"的窗口期。**明说**，别画出一张半张图让人猜。
            setErr("宿主半还是旧版（图谱数据里没有 layers）⇒ 重启后端再看；浏览器半已是新版。");
            return;
          }
          if (d && d.ok) { setData(d); setErr(null); setSel(null); setText(null); }
          else setErr("读不到 /api/mind/graph（host 半 api 插件没起来，或这条路被闸挡了）");
        });
        return function () { alive = false; };
      }, [props.stamp, project]);

      var layers = data && Array.isArray(data.layers) && data.layers.length ? data.layers : FALLBACK_LAYERS;
      var laid = React.useMemo(function () {
        return data ? layoutGraph(data.nodes, layers, { project: project }) : null;
      }, [data, project]);

      // ── 图谱自报第二格（`beacon: graph`）：渲染完成后把**几何真值**报给后端 ──────────
      // 为什么加：面板"好不好看"只能人眼看，但"画出来没有 / 画了几条带 / 几张卡 / 多高"
      // **是可机器核的**。第一版只报了 `render graph`（到没到渲染这一步）⇒ "渲染成功但布局
      // 塌成 0 高、卡片叠在一起"这类仍只能靠盯屏幕。这一格把那段也变成读数。
      // 浏览器半是热更的（宿主按内容散列服务 bundle）⇒ 加这条**不需要重启后端**。
      React.useEffect(function () {
        if (!data || !laid || !laid.bands.length) return;
        var labels = laid.bands.map(function (b) { return b.label; }).join("|").slice(0, 96);
        beacon("graph", "bands=" + laid.bands.length
          + " cards=" + Object.keys(laid.pos).length
          + " edges=" + data.edges.length
          + " w=" + laid.width + " h=" + laid.height
          + " card0=" + ((data.nodes[0] && data.nodes[0].label) || "?")
          + " :: " + labels);
      }, [data]);

      // 拖拽平移：直接改滚动容器的 scrollLeft/Top（不进 React 状态 ⇒ 不抖）；
      // 位移超过 4px 就记一笔 `movedRef`，避免"拖完手一松就顺手选中了一张卡"。
      var dragRef = React.useRef(null);
      var scrollRef = React.useRef(null);
      var movedRef = React.useRef(false);
      function panStart(e) {
        if (!scrollRef.current || (e && e.button !== undefined && e.button !== 0)) return;
        dragRef.current = { x: e.clientX, y: e.clientY, sl: scrollRef.current.scrollLeft, st: scrollRef.current.scrollTop };
        movedRef.current = false;
        setPanning(true);
      }
      function panMove(e) {
        var d = dragRef.current;
        if (!d || !scrollRef.current) return;
        var dx = e.clientX - d.x, dy = e.clientY - d.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) movedRef.current = true;
        scrollRef.current.scrollLeft = d.sl - dx;
        scrollRef.current.scrollTop = d.st - dy;
      }
      function panEnd() { dragRef.current = null; setPanning(false); }
      function pick(id) { if (movedRef.current) return; setSel(id); setText(null); }

      if (err) {
        return h("div", { className: "dm-body" },
          h("div", { className: "dm-col" }, h("div", { className: "dm-warn" }, h("b", null, err))),
          h("div", { className: "dm-col" }));
      }
      if (!data || !laid) {
        return h("div", { className: "dm-body" },
          h("div", { className: "dm-col" }, h("div", { className: "dm-dim" }, "建图中…（要读全部正文，本机约几十毫秒）")),
          h("div", { className: "dm-col" }));
      }

      var used = data.stats.byLayer || {};
      return h("div", { className: "dm-body" },
        h("div", { className: "dm-col dm-col-graph" },
          h("div", { className: "dm-tools" },
            h("input", {
              className: "dm-input", placeholder: "搜标题 / 路径…", value: q,
              onChange: function (e) { setQ(e.target.value); },
            }),
            h("button", { className: "dm-btn" + (project ? "" : " on"), onClick: function () { setProject(""); } }, "全部"),
            (data.projects || []).map(function (p) {
              return h("button", {
                key: p, className: "dm-btn" + (project === p ? " on" : ""),
                title: "只看「" + p + "」的项目记忆（其余项目记忆离线，底座照常在场）",
                onClick: function () { setProject(p); },
              }, p);
            }),
            h("span", { style: { flex: "1 1 auto" } }),
            h("button", { className: "dm-btn", onClick: function () { setZoom(function (z) { return Math.max(0.5, Number((z - 0.15).toFixed(2))); }); } }, "−"),
            h("span", { className: "dm-dim", style: { fontSize: "11px", minWidth: "38px", textAlign: "center" } }, Math.round(zoom * 100) + "%"),
            h("button", { className: "dm-btn", onClick: function () { setZoom(function (z) { return Math.min(2.5, Number((z + 0.15).toFixed(2))); }); } }, "＋"),
            h("span", { className: "dm-stat" }, data.stats.nodes + " 点 · " + data.stats.edges + " 边" + (project ? " · 只看 " + project : ""))),
          h(GraphCanvas, {
            data: data, laid: laid, sel: sel, hover: hover, q: q, zoom: zoom,
            panning: panning, onPick: pick, onHover: setHover,
            scrollRef: scrollRef, onPanStart: panStart, onPanMove: panMove, onPanEnd: panEnd,
          })),
        sel ? h(GraphDetail, { data: data, sel: sel, onSel: pick, text: text, onText: setText })
          : h(GraphSide, { data: data, onSel: pick }));
    }

    /** 图谱外壳：兜渲染期异常（在浏览器里表现为"整块空白"，最难事后定位）。 */
    function GraphView(props) {
      if (!graphReported) { graphReported = true; beacon("render", "graph"); }
      try {
        return GraphBody(props);
      } catch (e) {
        beacon("error", "graph: " + ((e && e.message) || e));
        return h("div", { className: "dm-body" },
          h("div", { className: "dm-col" },
            h("div", { className: "dm-warn" },
              h("b", null, "图谱渲染出错（已上报到 /api/mind/beacon）"),
              h("div", { className: "dm-mono" }, String((e && e.message) || e)))),
          h("div", { className: "dm-col" }));
      }
    }

    /** 顶级视图（conversation.view id=mind）。 */
    function MindPanel(props) {
      ensureStyle();
      var pair = useStatus();
      var status = pair[0], refresh = pair[1];
      var boot = useBoot();
      // 默认落在**图谱**：这是主人要的那一格（2026-10-04 明示"我想看的是图谱"）。
      var ms = React.useState("graph");
      var mode = ms[0], setMode = ms[1];
      // 图谱与读数共用同一个"刷新戳"：点「刷新」两格一起重新取数（不然会出现
      // "读数已更新、图还是旧图"这种自相矛盾的画面）。
      var cs = React.useState(0);
      var stamp = cs[0], setStamp = cs[1];
      var sessionId = props && props.sessionId;
      function doRefresh() { refresh(); setStamp(function (v) { return v + 1; }); }
      return h("div", { className: "dm-root" },
        h(Header, { status: status, sessionId: sessionId, onRefresh: doRefresh, mode: mode, onMode: setMode }),
        mode === "graph"
          ? h(GraphView, { stamp: stamp })
          : h("div", { className: "dm-body" },
            h(Facts, { status: status, boot: boot, onRefresh: doRefresh }),
            h(Files, { zone: "private" })));
    }

    /** 左栏页脚挂件（sidebar.footer.action）：一眼看接入态 + 警告数。 */
    function MindWidget(props) {
      if (!widgetReported) { widgetReported = true; beacon("render", "widget"); }
      ensureStyle();
      var pair = useStatus();
      var status = pair[0], refresh = pair[1];
      var sessionId = props && props.sessionId;
      var on = true;
      if (status && status.connect && sessionId && Array.isArray(status.connect.offSessions)) {
        on = status.connect.offSessions.indexOf(sessionId) === -1;
      }
      var warns = status && status.warnings ? status.warnings.length : 0;
      var title = status
        ? ("心智：" + (on ? "已接入" : "已关闭") + " · 警告 " + warns + " 条" + (status.live.recallLen === null ? "" : " · 召回 " + status.live.recallLen + "B"))
        : "心智：读取中…";
      function click() {
        if (!sessionId) { refresh(); return; }
        postJSON("/api/mind/connect", { session: sessionId, enabled: !on }).then(refresh);
      }
      return h("div", { className: "dm-widget", onClick: click, title: title },
        h("span", { className: "dm-dot" + (on ? "" : " off") }),
        h("span", null, "心智"),
        warns > 0 ? h("span", { className: "dm-badge" }, String(warns)) : null);
    }

    // ── 插件体（槽位注册；槽位缺失只会挂起，不报错）───────────────────────────
    var inject = ["slots"];

    function register(ctx, slot, id, order, label, Component) {
      var doRegister = function () {
        var out = ctx.slots.register({ name: slot, id: id, order: order, label: label }, Component);
        beacon("slot", slot + ":" + id);   // 注册成功才报到（失败会抛 ⇒ 由外层 catch 报 error）
        return out;
      };
      try {
        if (typeof ctx.slots.inject === "function") {
          ctx.effect(function () { return ctx.slots.inject(slot, doRegister); }, "dsh-mind: " + id);
        } else {
          ctx.effect(doRegister, "dsh-mind: " + id);
        }
      } catch (e) {
        if (typeof console !== "undefined") console.warn("dsh-mind: 槽位注册失败", slot, e);
      }
    }

    function apply(ctx) {
      // 第一格自报：模块被执行且 apply 被调用（拿不到它 ⇒ 浏览器半根本没起来）
      beacon("apply", "id=dsh-mind");
      ensureStyle();
      register(ctx, "conversation.view", "mind", 15, function () { return "心智"; }, function (props) {
        return h(MindPanel, props);
      });
      register(ctx, "sidebar.footer.action", "mind-connect", 10, function () { return "心智"; }, function (props) {
        return h(MindWidget, props);
      });
    }

    exports.name = "dsh-mind";
    exports.inject = inject;
    exports.apply = apply;
    // 测试缝（selftest ⑳ 用**真实 status JSON** 渲染一遍这些组件——渲染期抛错会让面板整块空白，
    // 而那是最难在重启后定位的一类故障；这里先在 node 里拿假 React 跑一遍）
    exports.__internals = {
      MindPanel: MindPanel, Facts: Facts, Files: Files, MindWidget: MindWidget, Header: Header,
      // 图谱的可单测面：布局是纯函数（同样的输入必须给出同样的坐标），
      // 组件面交给"真 status/graph JSON 渲染不抛"那条冒烟
      GraphView: GraphView, GraphBody: GraphBody, GraphSide: GraphSide, GraphCanvas: GraphCanvas,
      GraphDetail: GraphDetail, layoutGraph: layoutGraph, textWidth: textWidth,
      FALLBACK_LAYERS: FALLBACK_LAYERS, nodeWidth: nodeWidth,
    };
    return module.exports;
  }
});
