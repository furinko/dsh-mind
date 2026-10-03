// client/client.js — 心智面板（**浏览器半**，手写 bundle，无构建步骤）。
//
// ── 形态为什么是 `__ModuleLoader__.load({ id, factory })` ─────────────────────
//   官方外壳的客户端模块装载器只认这一种形态（`require` 只给外壳**已外部化**的模块：
//   `react` / `react/jsx-runtime`）⇒ 本文件不 import 任何东西，全部走工厂参数。
//   `id` **必须与 host 半 `api.js` 的 `CLIENT_ID` 一致**（boot 行按 id 去重，自测盯着这条）。
//
// ── 装在哪两处（都在本机实测存在的槽位上，别凭记忆加）─────────────────────────
//   · `conversation.view`（id=`mind`）—— 对话/轨迹同级的**顶级视图**：完整面板
//   · `sidebar.footer.action` —— 左栏页脚挂件：一眼看到"接没接入 + 几个警告"
//   槽位不存在时注册会一直挂起（官方语义），不报错；`slots.inject` 不可用时退回 `effect`。
//
// ── 数据从哪来（同源 loopback，host 半 `lib/host/api.js`）─────────────────────
//   GET /api/mind/status · /api/mind/tree?zone= · /api/mind/file?zone=&rel= · /api/mind/connect
//   浏览器**不碰文件系统**：所有事实由 host 半读成 JSON，隐私边界只有一条。
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
        ".dm-col-graph{padding:8px;overflow:hidden;display:flex;min-height:360px}",
        ".dm-graph-wrap{flex:1 1 0;min-width:0;position:relative;display:flex}",
        ".dm-graph{flex:1 1 auto;width:100%;height:100%;min-height:0;display:block;touch-action:none}",
        ".dm-legend{position:absolute;left:6px;bottom:6px;display:flex;gap:9px;align-items:center;font-size:10.5px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.72));border:1px solid var(--dsw-alias-border-l1);padding:2px 8px;border-radius:8px;pointer-events:none;flex-wrap:wrap;max-width:96%}",
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

    // ══ 心智图谱（知识网络）═══════════════════════════════════════════════════
    //
    // ── 画的是什么（**不许编关系**）───────────────────────────────────────────
    //   圆点 = 盘上真实存在的文件；线 = 正文里**真写了**的 `.md` 引用。
    //   关系判据全在 host 半 `lib/host/graph.js`（纯函数、有反例测试）——
    //   浏览器这层**不做任何推断**，只负责"把 JSON 画出来 + 让人能核对"。
    //   于是每个点都能点开看原文、每条病都能看到"谁引用的"。
    //
    // ── 布局为什么自己写、且**不依赖容器尺寸** ────────────────────────────────
    //   ① 不引第三方图库：本包是"手写 bundle 无构建步骤"，加依赖等于加一次构建。
    //   ② 坐标一律算在**固定 1000×700 的逻辑空间**里，SVG 用 viewBox +
    //      `preserveAspectRatio` 自适应 ⇒ 容器怎么变都不需要重算，
    //      也就没有"缓存键漏了某个输入导致永不更新"那一类坑（视觉交付的经典坑）。
    //   ③ 初始位置由 **id 的确定性哈希**给出（不用 Math.random）⇒ 同一份数据每次
    //      布局一致：可截图比对、可复现，不会"刷新一次一个样"。

    var GW = 1000, GH = 700;
    var LAYER_COLOR = { L0: "#d9483b", L1: "#4D6BFE", L2: "#1e9e73", L3: "#8a8f98", other: "#b8860b" };
    var LAYER_NAME = { L0: "宪法", L1: "规则", L2: "技能", L3: "记忆", other: "根/其它" };

    /** 字符串 → [0,1) 的确定性伪随机（FNV-1a）。 */
    function hash01(s) {
      var h = 2166136261;
      for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; }
      return (h % 10000) / 10000;
    }

    function nodeRadius(n) { return 3.4 + 1.55 * Math.sqrt(Math.max(0, n.deg || 0)); }

    /**
     * 力导向布局（同步跑完）。三股力：节点互斥 / 边当弹簧 / 向心。
     * 收尾做一次**自动适配**：把结果缩放到画布内 ⇒ 常量调得不准也不会画出界。
     */
    function computeGraphLayout(nodes, edges) {
      var list = Array.isArray(nodes) ? nodes : [];
      var idx = {};
      for (var i = 0; i < list.length; i++) idx[list[i].id] = i;
      var pos = list.map(function (n) {
        var layer = ["L0", "L1", "L2", "L3", "other"].indexOf(n.layer);
        var ang = hash01(n.id) * Math.PI * 2;
        var rad = 70 + (layer < 0 ? 4 : layer) * 110;
        return { x: GW / 2 + Math.cos(ang) * rad, y: GH / 2 + Math.sin(ang) * rad, vx: 0, vy: 0, r: nodeRadius(n) };
      });
      var link = [];
      var es = Array.isArray(edges) ? edges : [];
      for (var e = 0; e < es.length; e++) {
        var a = idx[es[e].from], b = idx[es[e].to];
        if (a !== undefined && b !== undefined) link.push([a, b]);
      }

      var K_REP = 5200, K_SPRING = 0.03, REST = 95, DAMP = 0.8, CENTER = 0.008;
      for (var t = 0; t < 500; t++) {
        var p, q, j;
        for (i = 0; i < pos.length; i++) { pos[i].fx = 0; pos[i].fy = 0; }
        for (i = 0; i < pos.length; i++) {
          for (j = i + 1; j < pos.length; j++) {
            p = pos[i]; q = pos[j];
            var dx = q.x - p.x, dy = q.y - p.y;
            var d2 = dx * dx + dy * dy; if (d2 < 1) d2 = 1;
            var d = Math.sqrt(d2);
            var f = K_REP / d2;
            var ux = dx / d, uy = dy / d;
            p.fx -= ux * f; p.fy -= uy * f;
            q.fx += ux * f; q.fy += uy * f;
          }
        }
        for (var l = 0; l < link.length; l++) {
          p = pos[link[l][0]]; q = pos[link[l][1]];
          var sdx = q.x - p.x, sdy = q.y - p.y;
          var sd = Math.sqrt(sdx * sdx + sdy * sdy) || 1;
          var sf = (sd - REST) * K_SPRING;
          var sx = sdx / sd * sf, sy = sdy / sd * sf;
          p.fx += sx; p.fy += sy; q.fx -= sx; q.fy -= sy;
        }
        for (i = 0; i < pos.length; i++) {
          p = pos[i];
          p.fx += (GW / 2 - p.x) * CENTER;
          p.fy += (GH / 2 - p.y) * CENTER;
          p.vx = (p.vx + p.fx) * DAMP; p.vy = (p.vy + p.fy) * DAMP;
          p.x += p.vx; p.y += p.vy;
        }
      }

      var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (i = 0; i < pos.length; i++) {
        if (pos[i].x < minX) minX = pos[i].x;
        if (pos[i].x > maxX) maxX = pos[i].x;
        if (pos[i].y < minY) minY = pos[i].y;
        if (pos[i].y > maxY) maxY = pos[i].y;
      }
      if (!pos.length || !isFinite(minX)) return pos;
      var w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
      var s = Math.min((GW - 90) / w, (GH - 90) / h);
      var ox = (GW - w * s) / 2 - minX * s, oy = (GH - h * s) / 2 - minY * s;
      for (i = 0; i < pos.length; i++) { pos[i].x = pos[i].x * s + ox; pos[i].y = pos[i].y * s + oy; pos[i].r = pos[i].r * Math.max(0.85, Math.min(1.6, s)); }
      return pos;
    }

    function GraphLegend() {
      return h("div", { className: "dm-legend" },
        ["L0", "L1", "L2", "L3", "other"].map(function (k) {
          return h("span", { key: k },
            h("i", { className: "dm-sw", style: { background: LAYER_COLOR[k] } }),
            LAYER_NAME[k]);
        }));
    }

    /** 一条"病"：引用指向盘上没有的东西（按目标归组，count 是引用处数）。 */
    function DiseaseRow(props) {
      var d = props.d;
      var why = d.why === "missing" ? "真缺件" : (d.why === "package" ? "指向包内/别处" : "模板占位");
      return h("div", { className: "dm-dise" },
        h("span", { className: "dm-why" + (d.why === "missing" ? " missing" : "") }, why),
        h("span", { className: "dm-dise-k" }, d.target),
        h("span", { className: "dm-dise-n" }, d.count + " 处"));
    }

    /**
     * 画布（**纯展示**：给定 data + 算好的坐标就画出来）。
     *
     * 为什么从 GraphBody 里抽出来：GraphBody 挂着 hooks，假 React 只能看到"建图中…"那一支
     * ⇒ 画线/画点这段代码在 node 侧永远不被执行，而"渲染期抛错 = 整块空白"正是最难查的一类。
     * 抽成无 hooks 的纯组件后，自测能拿**真 graph JSON** 直接渲染它（见 selftest ㉒）。
     */
    function GraphCanvas(props) {
      var data = props.data, pos = props.pos;
      var nodes = data.nodes || [];
      var isolated = {};
      for (var k = 0; k < (data.isolated || []).length; k++) isolated[data.isolated[k]] = true;
      var sel = props.sel, hover = props.hover;
      var hot = {};
      if (sel) {
        hot[sel] = true;
        for (var e = 0; e < data.edges.length; e++) {
          if (data.edges[e].from === sel) hot[data.edges[e].to] = true;
          if (data.edges[e].to === sel) hot[data.edges[e].from] = true;
        }
      }
      var at = {};
      for (var i = 0; i < nodes.length; i++) at[nodes[i].id] = pos[i];

      var lines = data.edges.map(function (ed, ei) {
        var a = at[ed.from], b = at[ed.to];
        if (!a || !b) return null;
        var isHot = Boolean(sel) && (ed.from === sel || ed.to === sel);
        return h("line", {
          key: "e" + ei, x1: a.x, y1: a.y, x2: b.x, y2: b.y,
          style: {
            stroke: isHot ? "#4D6BFE" : "var(--dsw-alias-border-l2)",
            strokeWidth: isHot ? 1.5 : 0.7,
            opacity: sel && !isHot ? 0.25 : 0.9,
          },
        });
      }).filter(Boolean);

      var dots = nodes.map(function (n, ni) {
        var p = pos[ni];
        var isSel = sel === n.id;
        var isIso = Boolean(isolated[n.id]);
        return h("circle", {
          key: "n" + ni, cx: p.x, cy: p.y, r: p.r,
          onClick: function () { props.onSel(isSel ? null : n.id); },
          onMouseEnter: function () { if (props.onHover) props.onHover(n.id); },
          onMouseLeave: function () { if (props.onHover) props.onHover(null); },
          style: {
            // 颜色**走内联 style**，不赌 CSS 选择器（2026-10-03 的教训：选择器不匹配时静默失效）
            fill: isIso ? "none" : (LAYER_COLOR[n.layer] || LAYER_COLOR.other),
            stroke: isIso ? "#d9483b" : (isSel ? "#111" : "var(--dsw-alias-bg-base,#fff)"),
            strokeWidth: isSel ? 2.2 : 1,
            strokeDasharray: isIso ? "2 2" : null,
            opacity: sel && !hot[n.id] ? 0.35 : 1,
            cursor: "pointer",
          },
        }, h("title", null, n.id + "　度 " + n.deg));
      });

      var labels = nodes.map(function (n, ni) {
        if (n.deg < 3 && sel !== n.id && hover !== n.id) return null;
        var p = pos[ni];
        return h("text", {
          key: "t" + ni, x: p.x + p.r + 3, y: p.y + 3.2,
          style: { fontSize: "9.5px", fill: "var(--dsw-alias-label-secondary)", pointerEvents: "none" },
        }, n.label);
      }).filter(Boolean);

      return h("div", { className: "dm-col dm-col-graph" },
        h("div", { className: "dm-graph-wrap" },
          h("svg", { className: "dm-graph", viewBox: "0 0 " + GW + " " + GH, preserveAspectRatio: "xMidYMid meet" },
            lines, dots, labels),
          h(GraphLegend)));
    }

    function GraphSide(props) {
      var g = props.data, sel = props.sel, onSel = props.onSel;
      var node = null;
      for (var i = 0; i < g.nodes.length; i++) if (g.nodes[i].id === sel) node = g.nodes[i];

      if (node) {
        var outs = g.edges.filter(function (e) { return e.from === node.id; }).map(function (e) { return e.to; });
        var ins = g.edges.filter(function (e) { return e.to === node.id; }).map(function (e) { return e.from; });
        var nb = function (id) {
          return h("button", { key: id, className: "dm-nbr", onClick: function () { onSel(id); } }, id);
        };
        return h("div", { className: "dm-col" },
          h("button", { className: "dm-btn", onClick: function () { onSel(null); } }, "← 返回清单"),
          h("div", { className: "dm-card", style: { marginTop: "8px" } },
            h("div", { className: "dm-card-title" }, "节点"),
            Row("id", node.id, true),
            Row("层", (node.layer || "other") + "（" + (LAYER_NAME[node.layer] || "其它") + "）"),
            Row("大小", fmtBytes(node.bytes), true),
            Row("度", "总 " + node.deg + " · 进 " + node.inDeg + " · 出 " + node.outDeg),
            h("div", { style: { marginTop: "6px" } },
              h("button", {
                className: "dm-btn",
                onClick: function () {
                  getJSON("/api/mind/file?zone=" + node.zone + "&rel=" + encodeURIComponent(node.rel)).then(function (d) {
                    props.onText(d && d.ok ? { rel: node.rel, text: d.text, bytes: d.bytes, truncated: d.truncated } : { rel: node.rel, text: "（读不到：" + ((d && d.error) || "未知") + "）" });
                  });
                }
              }, "读正文"))),
          outs.length ? Card("它引用谁（" + outs.length + "）", outs.map(nb)) : null,
          ins.length ? Card("谁引用它（" + ins.length + "）", ins.map(nb)) : null,
          props.text
            ? h("div", { className: "dm-card" },
              h("div", { className: "dm-card-title" }, props.text.rel + " · " + fmtBytes(props.text.bytes) + (props.text.truncated ? "（已截断）" : "")),
              h("pre", { className: "dm-pre" }, props.text.text))
            : null);
      }

      return h("div", { className: "dm-col" },
        Card("图读数（全部来自盘上读数，非估算）",
          Row("节点 / 边", g.stats.nodes + " / " + g.stats.edges),
          Row("扫了 / 跳过", g.stats.filesScanned + " 件 / " + g.stats.skippedFiles + " 件（TRASH 与超限）"),
          Row("读了", fmtBytes(g.stats.bytesRead), true),
          Row("孤岛（一根线都没有）", g.stats.isolated + " 个" + (g.stats.isolated ? "（见下）" : "")),
          g.stats.truncated ? Row("⚠️ 有文件超限未读", "计数已如实标出", false) : null),
        Card("枢纽（度 = 进 + 出）",
          g.stats.hubs.map(function (hb) {
            return h("button", { key: hb.id, className: "dm-nbr", onClick: function () { onSel(hb.id); } },
              hb.id + "　度 " + hb.deg);
          })),
        g.isolated.length
          ? Card("孤岛（没人引用它、它也没引用别人）",
            g.isolated.map(function (id) { return h("button", { key: id, className: "dm-nbr", onClick: function () { onSel(id); } }, id); }))
          : null,
        Card("病 · 引用指向盘上没有的东西（" + g.stats.danglingRefs + " 处 / " + g.stats.dangling + " 个目标）",
          g.dangling.length ? g.dangling.map(function (d, i) { return h(DiseaseRow, { key: i, d: d }); })
            : h("div", { className: "dm-dim" }, "没有悬空引用")),
        g.ambiguous.length
          ? Card("歧义 · 同名多份 ⇒ 不连线（" + g.stats.ambiguous + " 个目标）",
            g.ambiguous.map(function (a, i) {
              return h("div", { className: "dm-dise", key: i },
                h("span", { className: "dm-why" }, "同名 " + a.candidates + " 份"),
                h("span", { className: "dm-dise-k" }, a.target),
                h("span", { className: "dm-dise-n" }, a.count + " 处"));
            }))
          : null);
    }

    /** 图谱主体（渲染期抛错由外层 GraphView 兜住并上报）。 */
    function GraphBody(props) {
      var gs = React.useState(null);
      var data = gs[0], setData = gs[1];
      var es = React.useState(null);
      var err = es[0], setErr = es[1];
      var ss = React.useState(null);
      var sel = ss[0], setSel = ss[1];
      var ts = React.useState(null);
      var text = ts[0], setText = ts[1];
      var hs = React.useState(null);
      var hover = hs[0], setHover = hs[1];

      React.useEffect(function () {
        var alive = true;
        getJSON("/api/mind/graph").then(function (d) {
          if (!alive) return;
          if (d && d.ok) { setData(d); setErr(null); }
          else { setErr("读不到 /api/mind/graph（host 半 api 插件没起来，或这条路被闸挡了）"); }
        });
        return function () { alive = false; };
      }, [props.stamp]);

      var nodes = data ? data.nodes : [];
      var pos = React.useMemo(function () { return data ? computeGraphLayout(nodes, data.edges) : null; }, [data]);

      if (err) {
        return h("div", { className: "dm-body" },
          h("div", { className: "dm-col" }, h("div", { className: "dm-warn" }, h("b", null, err))),
          h("div", { className: "dm-col" }));
      }
      if (!data || !pos) {
        return h("div", { className: "dm-body" },
          h("div", { className: "dm-col" }, h("div", { className: "dm-dim" }, "建图中…（要读全部正文，本机约几十毫秒）")),
          h("div", { className: "dm-col" }));
      }

      var pick = function (id) { setSel(id); setText(null); };
      return h("div", { className: "dm-body" },
        h(GraphCanvas, { data: data, pos: pos, sel: sel, hover: hover, onSel: pick, onHover: setHover }),
        h(GraphSide, { data: data, sel: sel, onSel: pick, text: text, onText: setText }));
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
      computeGraphLayout: computeGraphLayout, LAYER_COLOR: LAYER_COLOR,
    };
    return module.exports;
  }
});
