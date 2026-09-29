---
name: dshome-plugin-dev
description: DSHOME/DeepSeek Harness 结构与插件开发——运行时 Cordis 动态插件（code.host/code.client 纯 JS）、写码前 cordis_inspect 读真实接口、生命周期/修复/回滚；含自有 host 插件落地四处登记（漏 package.json exports = 宿主启动崩）与安全模式动态化。触发：做/改 DSH 插件、"plugin"、"错误：xxx is not declared"、"host.call 失败"、"slot 注册失败"、"启动崩溃"、"ERR_PACKAGE_PATH_NOT_EXPORTED"。
version: 1.4.0
author: DSHOME
license: internal
metadata:
  tags: [DSHOME, DSH, harness, cordis, plugin, 插件, code.host, code.client, slot]
  related: [mind/README.md, node_modules/@deepseek-ai/dsh-agent-presets/presets/cordis/skills/cordis-plugin-development/SKILL.md]
contract:
  id: dshome-plugin-dev
  triggers: [做插件, 改插件, plugin, cordis, slot, host.call 失败, is not declared, client 解析失败]
  inputs: [要做什么/改哪个插件, 目标能力(host/client)]
  outputs: [确定所属平台, 已读真实接口, 插件源码, 版本/修复判断, 失败排查]
  deps: [cordis-plugin-development (upstream), mind/README.md, mind/L1/Power.md]
---

# dshome-plugin-dev — DSHOME 结构与插件开发

## 一、DSHOME 是什么

DSHOME（DSHOME）运行在 **DeepSeek Harness (DSH)** 之上，本机宿主源码/运行时在 `$DSH_HOME`（本仓库根，环境变量解析——勿硬编码盘符，换设备路径不同）：

- 宿主包在 `$DSH_HOME\node_modules\@deepseek-ai\*`（`dsh-client-runtime`、`dsh-client-ui-slots`、`dsh-client-ui-conversation`、`dsh-client-ui-primitives`、`dsh-attachment`、`cordis` 等）。
- 自带/upstream 的 Cordis 插件开发 skill 在
  `$DSH_HOME\node_modules\@deepseek-ai\dsh\config\agent-presets\cordis\skills\`
  （`cordis-plugin-development`、`editing-cordis-compositions`）。
- 我的能力库在 `mind\L2\Skill\`；能力手册见 `mind\L1\Power.md`、行为规程见 `mind\L1\Ritual.md`；知识索引 `mind\L1\Tree.md`。

## 二、第一铁律：先读真实接口，再写码

**绝不**从 Service 名、Event payload、Slot props、theme token、示例、或别人源码反推完整 API。
正确步骤：调用 `cordis_inspect_list` 拿到当前注册的 Providers/methods/schemas，再用尽量少的
`cordis_inspect_query` 读要用到的确切 Service / Event / Builtin / Slot / Theme / Tool。
不要硬编码 Provider 名，不要跳过 list。

## 三、插件形态：动态 Cordis 插件

DSH 插件是**运行时动态插件**，`code.host` / `code.client` 是**纯 JS 函数体**，返回一个 Cordis Plugin。

- **不是** TS / JSX / import / require / 打包产物。
- Client React 必须用 `React.createElement(...)`（不能用 JSX）。
- `apply(ctx)` 注册生命周期贡献，**不能**直接返回 React Element。
- 能力要用 `ctx.get(name)` 可选读取并判空；只有真硬依赖才声明 `inject: ['x']`。
  未声明却访问 `ctx.x` 会被 Guard 拒绝。

```js
// code.client 正确示范
return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    slots.inject('target.slot', () => slots.register(
      { name: 'target.slot', id: 'my-view' },
      (props) => React.createElement('div', null, String(props.someValue)),
    ))
  },
}
```

## 四、平台选择

| 需求 | 平台 | 先读 |
|---|---|---|
| 文件/命令/进程/网络 | Host | `Service.listService` (`fs`,`bash`,`subprocess`,`pty`,`web`) |
| Agent/durable 会话/宿主生命周期 | Host | 对应 Service + `Event.listEvents` |
| 注册动态模型 Tool | Host | `Builtin.listBuiltins` (`harness`) + `Tool.listTools` |
| 页面主题/布局 | Client | `Theme.listTokens` + 客户端 `Service.listService` |
| 会话快照/workspace 列表 | Client | 目标 Slot 的 standard props + owner props |
| 设置页/侧栏/输入区/overlay/工具卡 | Client | `Slots.listSubTree` |
| Host 取数、Client 展示 | Both | Host Service + `harness.handle`；Client Slot + `host.call` |

**原则**：选离数据所有者最近的能力。Slot props 已给会话快照就别再去 Host 拉一遍。

## 五、Slot 注册（Client UI）

1. 先 `Slots.listSubTree`（无 root）选目标，再用具体 `root` 读该 Slot 完整契约（protocol:
   single/list/keyed/chain、scope、standard props、owner props、当前占用者、替换风险、descendant）。
2. 用 `ctx.get('slots')`（不用 `ctx.slots` 除非声明 `inject:['slots']`），
   `slots.inject('x.slot', () => slots.register({name, id|key}, (props)=>React.createElement(...)))`。
3. 不要猜 `id`/`key`/selector/props；不要默认替换 root/sidebar/conversation/details 顶层槽
   （替换整个 occupant 会连带移除其声明的 descendant slots）。
4. session 级槽可能通过 standard props 提供 `useSession`/`useSessions`/`useWorkspaces`/`useProjection`/input/actions。
5. 只取真正需要的字段，**不要**复制/整段渲染 Conversation Snapshot / Session / Tool call / 整个 props 对象。

**Client 视图的高度 /「整页被滚走」（2026-09-12 实测根治）**：`conversation.view` 类视图被渲染进
`[data-conversation-scroll]`（滚动区）→ `[data-slot=conversation.session]`(display:contents) → `.wSkVaW_viewArea` → `[data-slot=conversation.view]`(display:contents) → 你的根节点。三条硬事实：

- 滚动区里除了 viewArea 还有 **composer seat（输入框，`flex:none` 在流内）**；`[data-phase=active]` 时上游给 `viewArea{flex:1 0 auto;min-height:auto}`（只增不减）。⇒ 自己写 `height`/`max-height` 必然与输入框打架：**外层溢出量 ≈ 输入框高 − 你留的余量**（实测 152px→8px、260px→116px；症状 = "内部滚到边界后滚轮继续带动整块面板"）。
- **别用 JS 写死高度**：根节点是 flex 子项时 `flex:1` = `flex-basis:0%`，**主轴尺寸由 flex-basis 决定 ⇒ `style.height` 被完全压过**（实测 inline 703px／实际 575px——这条"缓解"挂了 4 天从未生效）。兜底要写 `style.flex = '0 0 <px>px'`。
- **正解 = 用上游官方钩子（不动 node_modules）**：根节点挂 `data-conversation-composer-overlay`（官方「轨迹」视图同款）⇒ 上游 CSS 命中后 ① `.wSkVaW_viewArea` 锁成 `flex:1 1 0;min-height:0;overflow:hidden` ② composer seat 变 `position:absolute`（脱离滚动流 ⇒ 滚动区只剩 viewArea、零溢出）③ 面板底部让位用上游写在滚动区上的 `--dsh-composer-height`（`padding-bottom: var(--dsh-composer-height,152px)`）。根节点配 `flex:1 1 0; min-height:0; overflow:hidden` 即精确填满可视高；**JS 只在上游钩子未生效时兜底**（判据：viewArea 计算 `overflow-y === 'hidden'` 即命中）。

**判据**（这类问题的验收口径）：① `scrollBody.scrollHeight − clientHeight === 0`（页面级同样 0）② 内部滚动区照旧可滚 ③ 拿**上游真实 CSS + 真实 DOM 链**在隔离 Electron 隐藏窗口跑「改前复现 / 改后归零」——**"没复发"不是证据**（教训：只看"没复发"就写了"实测稳定"，从没量过那条缓解自己的产出）。

## 六、副作用与生命周期

- `ctx.on()` 监听 Event；`ctx.effect(() => disposer)` 管理外部订阅；保留 Service/Tool/Slot/timer 返回的 disposer。
- 不要在 module 作用域或 `apply()` 之外做页面/进程级副作用；Plugin 停止/更新/删除时自动清理。
- timer 是名为 `timer` 的 **Service**（不是 Builtin），用前先 `Service.listService` 并声明 `inject:['timer']`。
- 不要用全局 `window`/`document`/`process`/`Buffer`/`fetch`/`setTimeout`（非 Builtin 确认前）。

## 七、Host↔Client 通信

Host `harness.handle('method', handler)`，Client `await host.call('method', args)`（JSON RPC）。
参数/返回值必须 **lossless JSON**，不能传函数/React 元素/实例/Context/Service/运行时对象；无数据返回 `null`。

## 八、版本 / 生命周期 / 修复

- `pluginId` 稳定实例；`packageId` 不可变代码版本；每次激活有 `pluginRunId`。
- `currentPackageId`=最近成功版本（不代表正在运行）；`nextPackageId`=待批准/激活/最近失败。
- 激活：无 current 或有 current 同版本 → `cordis_run` mode `run`；不同版本 → `update`；
  更新失败重试 next → `update`；回滚当前 → `run`。
- 授权：单勾仅当前 Package，双勾自动授权未来版本；技术失败后授权仍在。`awaiting-approval`/`starting`
  后**不要在当回合等**，结束流程等系统回报。
- 修复：`cordis_inspect_self` 读失败版本 + 诊断 → 若 unknown capability 先 list/query Provider →
  在**同一 pluginId 下定义新 Package**（别覆盖失败包）→ 用新 `packageId` 按模式 run/update。
  用户拒批后**不要自动重试**。

## 九、常见失败排查

| 失败 | 先查 |
|---|---|
| `service "x" is not declared` | 用 `ctx.x` 未声明 `inject:['x']`；改 `ctx.get('x')` 判空或声明真硬依赖 |
| `cannot get property "timer" without inject` | 查 timer Service + 声明 `inject:['timer']` |
| Client 解析失败 | 是否用了 JSX/TS/import/未知全局 |
| Slot 注册失败 | 是否查过 live subtree、Slot 存在、options/key/selector 满足 protocol |
| UI 加载但页面报错 | 看 `client-render` 诊断与 stack；对应用 `cordis_define` 新 Package 修复 |
| `host.call` 失败 | handler 名、当前 `pluginRunId`、JSON 参数、handler 内 Service 依赖 |
| 更新失败 | 保持 current/next 语义；修 next 后 update，或 run current 回滚 |
| 启动报 `cannot resolve profile bundle "X"` | 读启动 stderr（`Error: dsh: cannot resolve profile bundle "X"`）→ 查 `payload\node_modules\X` 是否缺失（对照 `profiles/dshome/package.json` 的 `dsh.profile.bundles`）；缺 = payload 依赖陈旧，打包前需 `stage-payload` 同步 node_modules（`syncNodeModulesBundles` 已固化） |
| 后端崩 / HTTP 达不到（安装包 bundle 缺失） | 静默装到临时目录 → 起后端读 stderr 定位缺失 bundle → `stage-payload` 补齐 → 重新 ISCC；**source 环境 `smoke` PASS ≠ 安装包可用**，必须真装一装（静默装+起后端+HTTP200+junction）才算过 |
| 后端崩 / `Cannot find module` 报包外脚本 | 若报 `Cannot find module '../../../scripts/x'` 且仓库根 `scripts/x` 存在 = **包外相对 require 实体化后失效**；改用 `require(path.join(repoRoot(),'scripts',x))`（repoRoot=`DSH_HOME` 优先）动态定位 |

**打包缺 bundle 排查要点（2026-09-07 实测）**：安装包缺 profile bundle 时后端不是"起不来"而是**立即崩**（stderr 报 `cannot resolve profile bundle`），HTTP 达不到。定位链：静默装临时目录 → 起后端读 stderr → 得缺失 bundle 名 → 对照 `profiles/dshome/package.json` 的 `dsh.profile.bundles` → 确认 `payload\node_modules\X` 缺失 → `stage-payload` 的 `syncNodeModulesBundles` 补齐 → 重新 ISCC。**判据**：`smoke`（source）/`verify-payload`（payload 静态）PASS 只证明源码/静态树 OK，不证明安装包可用；唯一可靠终点是"真装一装 + 起后端 + HTTP200 + junction"。

**包外脚本 require（2026-09-08 实测）**：DShome 插件若 `require('../../../scripts/x')` 依赖**仓库根 scripts** 的共享脚本——开发时 junction 指向 `packages/<pkg>`、向上到仓库根（能跑）；安装实体化后 junction 被压成实体目录、向上到 `profiles/dshome`（无 scripts）→ `MODULE_NOT_FOUND` 后端崩。**一律改用 `require(path.join(repoRoot(),'scripts',x))` 动态 require**（`repoRoot()`=`DSH_HOME` 优先，dev=仓库根/安装=安装目录，两处 scripts 均在）；`smoke`（dev）与"实体布局 probe"双验。

## 十、DSHOME 自有 host 插件落地（**四处登记** checklist + 安全模式）

> 2026-09-04 血泪教训：开发 mind-recall host 插件时漏了 exports 注册，宿主启动崩溃循环 7+ 轮；
> 且安全模式静态清单漏 mind 系插件，崩溃时逃生通道形同虚设。
> **2026-09-12 复发（同一个病，我犯的）**：compaction-log 插件登记了 ①③④、**漏了 exports（②）**——
> 12:42 重启后端 boot 后必死，连崩 3 次撞外壳熔断（`MAX_CONSECUTIVE_FAILS=3`）→ 模态窗阻塞主进程 →
> **3099 掉线**，靠外部救援脚本补一行 exports + WMI 重拉才恢复。
> ⚠️ **本次最关键的一课**：这条 checklist 早就写在这里、描述还进过我的上工召回，**而我一次没读就动手**——
> 「规则建了、动作没接上」。落新 host 插件前**先读本节**，别凭印象。

**任何新 host 插件（`packages/dshome/lib/host/<name>.js`）上线必须四处齐：**

1. [ ] **插件文件**：`packages/dshome/lib/host/<name>.js`，`export const name` 与 patch 的 id 一致、格式同既有插件（mind-inject 为模板）
2. [ ] **`package.json` exports**：`packages/dshome/package.json` 的 `exports` 补
      `"./<name>": "./lib/host/<name>.js"` ← 🔴 **唯一致命的一步**：漏了 → `ERR_PACKAGE_PATH_NOT_EXPORTED`，
      cordis 按**包子路径**加载时 ESM 直接拒收，**插件一行代码都不跑，后端 boot 后必死**。
      ⚠️ **盲区**：按**文件路径** import 的测试（本仓 itest、`verify-host-plugins` 的加载段）**绕过了 exports** →
      漏登记时它们照样绿。2026-09-12 起 `verify-host-plugins` 增「包路径解析探针」专堵这一面。
3. [ ] **cordis.patch.yml 注册**：`packages/dshome/cordis.patch.yml` 的 insert 块加
      `- id: dshome-<name>` / `name: dshome/<name>` 条目
      （本机实测另有 `settings.yaml` 的 `include:` 启用条目——参考 dshome-mind-inject 行；落地后确认它在）
4. [ ] **`plugin-store.js` DESC_CN**：`packages/dshome/lib/host/plugin-store.js` 的插件描述表加
      `'dshome/<name>': '<一句话>'`（插件管理面板的名称来源；不影响启动，漏了面板上是空描述）

**安全模式（v3，2026-09-11 实测重写）**：覆盖层 = **L3 产品层 + L4 profile 覆盖层的并集**——
`packages/dshome/shell-app/safe-overlay.cjs` 收「`insert` 块内的自有行」+「任何位置的 `dshome*` 行」；
官方覆盖行（`web-runtime`/`webserver`/`llm-deepseek`/`ui-brand-official`）**永不进名单**（禁了会把宿主打死）。
v2「只取第一个 patch 文件」只覆盖 L3（15 行）、L4 后加的行漏禁——实测 dump-config 证实。两个实测坑：

- 🔴 **`--patch` 必须排在 launcher 旗标区**：`--profile <name>` 之后、app 参数（`--no-open`/`--port`）**之前**。
  拼在 app 参数之后 → dsh 0.1.5 直接报 `unknown option '--patch'`，**安全模式反而让后端起不来**（v2 安装分支即此写法）。
  验证姿势：`dsh --profile dshome --patch <yml> --dump-config`（launcher 旗标可任意顺序，但都要在 app 参数前）。
- ✅ **`packages/dshome/scripts/safe.mjs` 已与外壳统一口径**（2026-09-11 修）：不再自己解析，改用 `safe-overlay.cjs` 同参
  （L3 15 + L4 4 = **19** 个 id），并加 `--print-ids`（只打印清单/来源/覆盖层、不启动后端）供自检与回归断言。
  病史：v2 只读 `packages/dshome/cordis.patch.yml` → L4 后加的插件（Agent Teams 三包 / `dsh-imagegen`）**兜不住**；
  **同一个病有两种实现**（外壳已改、CLI 逃生没改）→ 修机制类 bug 要 grep 全部同型实现，别只修眼前那条。
- **回归**：`scripts/verify-safe-overlay.mjs`（**25 断言**：A 解析规则 / B 参数位置 / C 真实仓库布局 /
  D **CLI 清单 == 外壳清单**；已进 `pnpm verify` 与 `pre-commit` ⑤）——改这块前后都跑它
  （变异测试两例：`--patch` 退回拼末尾 → B1/B2 FAIL；safe.mjs 退回「只 L3」→ D3/D5 FAIL）。
- ⚠️ **safe 的覆盖边界（2026-09-12 实测 `--print-ids`）**：清单 20 个 id **全是自有插件 + 官方实验三包 —— 第三方包一个都没禁**，其中包括**能在进程内改 profile 的插件市场 `dsh-market`**。⇒ **safe ≠ "第三方面被关掉"**（09-11 第三方包崩时 safe 同样起不来）——事故窗口里从市场装插件，等于**继续改 profile**：先 `plugin-change-guard --preflight` 留安全点。判断"safe 会不会把这个包禁掉"**一律跑 `--print-ids` 看清单，别按"应该禁了吧"推断**。

**自检信号**（改完重启宿主后）：
- 有 marker 的插件：marker 时间戳必须刷新（`profiles\dshome\.dsh-market\<name>-marker.txt`）
- 无 marker 的插件：宿主能完整 boot（3099 + HTTP 200）
- ⚠️「插件树能加载到前一插件」≠「本插件正常」——崩溃点用 marker/日志对比定位（崩溃插件在前的插件每轮刷新、它自己不刷新）
- **插件 / 配置变更取证**：市场（`dshmarket`）自己的持久日志在 `profiles\dshome\.dsh-market\log.ndjson`（ndjson 一行一事件：`install` / `install-blocked`（**有 agent 在跑即拒绝安装**的并发保护，带 session id）/ `hot-mount` / `boot`，含失败原因与 pnpm 输出尾部）。**"谁装了 / 改了 profile"先看这里**——2026-09-12 补：本节此前只提 `*-marker.txt`，这本日志从没进过排查口径（于是出事时"查不到"）。

**验证流程**：写完逻辑先 `node --check` 语法 → 重启宿主看 boot + marker → 跑对应 itest/verify。
**不要**只测逻辑就收工（本次事故：itest 全绿但宿主加载链没验，上线即崩）。

**版本四元 = 机器同步，别手工改四处（2026-09-12 加）**：Skill 版本写在 **frontmatter（真源）** / 文件尾 `_版本：` / `Tree.md` 清单列 / `_index.md` 表格列 —— 四处手工同步，一次漏改就是 warn（09-12 实测：两个 Skill × 四处 × 两轮全手工）。

```
node scripts\skill-version.mjs --check                        # 只报漂移（读，不改）
node scripts\skill-version.mjs --bump <id> <x.y.z> --note "<变更摘要>"   # 改真源 + 追加文件尾记录 + 回写另两个镜像
node scripts\skill-version.mjs --selftest                     # 隔离临时树自测（10 例，含 4 条反证）
```
校验仍在 `mind-validate --strict`（pre-commit ②；四元不一致即 warn、`--strict` 即拒）——**本工具只是执行器，不另立第二套判据**；`--bump` 不带 `--note` 时只改数字（会续用旧摘要，慎用）。⚠️ `--sync/--bump` 会改 mind 文件（只动版本单元格）⇒ 跑前先 `evolve-log snapshot`。

## 十一、新增一个自建插件（client+host）的最小闭环

> 与 §十 的分工：§十 是**在 `packages/dshome` 里加一个 host 子件**；本节是**新开一个自有包**（client+host 两半）从建包到重启生效的完整闭环。
> 核心一句：**"新加一行 `cordis.patch.yml`"只是半条链**——宿主还必须能把那行里的**裸包名解析到实体**；缺哪一步都可能"后端启动即崩"（同 2026-09-01 事故形态）。以下按落地顺序，缺一不可。

1. **包体**：`packages/<name>/{package.json, lib/index.cjs, lib/client.js}`。`package.json` 必须有
   `main` → `lib/index.cjs`、`exports` 含 `"."` 与 `"./client"`、`dsh.client = { platform: "web", inject: [] }`。
2. **登记**：`packages/dshome/cordis.patch.yml` 追加 `- id: <name>` / `name: <name>`。
   **裸包名行 = roster 扫 `dsh.client` 的入口**（该文件注释里写明的机制）；顶层必须保持 **YAML 数组**形态（整文件只剩注释 ＝ 启动崩）。
3. **profile 依赖**：`profiles/dshome/package.json` 的 `dependencies` 加 `"<name>": "workspace:*"`。
4. **装**：仓库根 `pnpm install` ⇒ 建 `profiles/dshome/node_modules/<name>` junction。
   **不装 = 后端启动即崩**（cordis 行解析不到裸包名）；反向也危险：只手工建 junction、不写 ③ 的依赖声明 ⇒ 下次 `pnpm install` 会把它 prune 掉，仍是崩。
5. **重启前**：`node scripts/plugin-change-guard.mjs --preflight`（三查 + 备份三件套；出事 `--recover` 回滚）。
6. **装后核对**：`pnpm-lock.yaml` 的 `settings.autoInstallPeers` 必须仍为 `true`；diff 应只新增几行（新包条目 + importer 条目），**出现大范围重写即异常**（2026-09-01 事故根因）。
7. **`packages/dshome/package.json` 非必需**（bundle dependencies + `dsh.client.inject` 名单）：对照 `dshome-mind`、`dsh-imagegen` 都不在名单内却正常加载。
8. **生效面**：**client 半改完刷新即生效**（client-hmr 轮询 500ms → rebuilt → SSE）；**新增插件行必须重启后端 + 刷新页面**。
9. **输入框周边可用槽位**（查 slot 总表 `node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/client.js` 的 `CLIENT_SLOT_API` 数组确认 kind/scope/occupants）：
   `conversation.input.left`（工具行左 · 紧凑控件）/ `conversation.input.right`（提交键前 · 紧凑控件）——**两者 list/session、常驻小按钮首选**；
   `conversation.input.dock` 是"输入卡片上方整行条目"（queue/todo/goal 已占，会占一整行高度）。
10. **`ctx.conversation.send(text)` 等动词是 scope-addressed**：root ctx 调用会 fail loud ⇒ 全局槽（如 `sidebar.footer.action`）里要 `ctx.sessions.scope(sessionId)` 拿到 actx 再 `.get("conversation")`。

## 十二、本会话可用性检查

`cordis_*` 工具（`cordis_inspect_list/query/self`、`cordis_define/run/stop/undefine`）与上述 upstream skill
**未必每个会话都注入**。若当前工具集没有：
- 先确认是否在带 cordis 开发能力的会话/配置里；
- 组件渲染/纯逻辑可先单测（本地 node + 匹配 react），但**不要**把从外部源码反推的接口当真实契约。

---
_版本：1.4.0 | 2026-09-24 | §十一 新增「新增一个自建插件（client+host）的最小闭环」（10 步：包体 exports/dsh.client → cordis.patch.yml 登记 → profile 依赖 workspace:* → pnpm install 建 junction → plugin-change-guard --preflight → pnpm-lock 核对 → packages/dshome 非必需 → 生效面 → 输入框周边槽位 → scope-addressed 动词）；原 §十一 顺延为 §十二 | 1.3.10 | 2026-09-18 | safe.mjs 路径订正（两处）+ 与 crash-recovery 同批（出厂区过时引用清理第二批） | 1.3.9 | 2026-09-18 | related 订正：上游 Cordis 技能文件已迁至 @deepseek-ai/dsh-agent-presets\presets\cordis\skills\cordis-plugin-development\SKILL.md（原 @deepseek-ai\dsh\config\agent-presets\... 已不存在）；由 mind-validate 新增的 metadata.related 缩进块解析**首次真检出**（旧尺子零输入=假绿） | 1.3.8 | 2026-09-12 | §五 增「Client 视图高度/整页被滚走」：composer-overlay 官方钩子（viewArea 锁定高 + 输入框绝对定位）+ flex-basis 压过 height（兜底写 style.flex）+ --dsh-composer-height 让位；判据 = scrollBody 零溢出 + 复刻台改前/改后 | 1.3.6 | 2026-09-12 | §十 增「版本四元 = 机器同步」：新工具 scripts\skill-version.mjs（--check/--sync/--bump --note/--selftest 10 例含 4 条反证），取代四处手工同步（09-12 实测手工改两轮） | 1.3.5 | 2026-09-12 | 安全模式段补「**safe 的覆盖边界**」（实测 `--print-ids`：20 个 id 全是自有插件 + 官方实验三包，**第三方一个都没禁**，含能改 profile 的市场 `dsh-market`；判"safe 会不会禁某包"一律跑 `--print-ids`，别推断）| 1.3.4 | 2026-09-12 | 「自检信号」增「**插件/配置变更取证** → `profiles\dshome\.dsh-market\log.ndjson`」（市场自带事件日志：`install` / `install-blocked`（有 agent 在跑即拒绝安装）/ `hot-mount` / `boot`；"谁装了/改了 profile"先看这里）——本节此前只提 `*-marker.txt` | 1.3.3 | 2026-09-12 | §十 **三步 → 四处登记**（补 `plugin-store.js` DESC_CN；`exports` 标为**唯一致命**并记盲区：**按文件路径 import 的测试绕过 exports**，漏登记时照样绿）+ 落地判例（compaction-log 漏 exports → 后端 boot 必死 → 连崩 3 次撞外壳熔断 → 外部救援恢复）+ 头注"先读本节"；配套 `verify-host-plugins` 增「包路径解析探针」 | 1.3.2 | 2026-09-11 | §十 订正：`packages/dshome/scripts/safe.mjs` 已从「只 L3」改为与外壳同口径（`safe-overlay.cjs`，L3+L4 并集 19 个 id，加 `--print-ids` 自检）；回归断言 18 → **25**（新增 D 段锁「CLI 清单 == 外壳清单」）并接入 `pre-commit` ⑤ | 1.3.1 | 2026-09-11 | §十 安全模式升级 v3（覆盖层改 L3+L4 并集；补两处实测坑：`--patch` 必须排在 app 参数之前、`packages/dshome/scripts/safe.mjs` 仍只解析 L3 兜不住 L4 崩因；指向回归脚本 `verify-safe-overlay.mjs`）——起因主人报「崩了没报错框 + 安全模式打不开」，实为外壳安全网两处独立硬伤 | 1.3.0 | 2026-09-08 | §九 排查表加"包外脚本 require 实体化失效"一行 + "打包缺 bundle"内补 repoRoot/DSH_HOME 动态定位要点（dshome-mind 实测崩+修复沉淀 | 1.2.0 | 2026-09-07 | §九 排查表补"cannot resolve profile bundle / 安装包后端崩两行 + 打包缺 bundle 排查要点（实测：source smoke PASS ≠ 安装包可用，必须真装一装） | 1.1.0 | 2026-09-05 | 新增 §十 自有 host 插件落地三步 checklist（exports 易漏血泪教训）+ 安全模式动态化说明；触发词补启动崩溃/ERR_PACKAGE_PATH_NOT_EXPORTED_
