---
name: dshome-crash-recovery
description: DSHOME/DSH 崩溃排查+自愈——先分装配期/运行期/前端半区三层；启动失败（fail-loud boot 崩溃循环）用 marker 定位崩溃插件 → plugin-change-guard --recover / safe 模式逃生；前端「Failed to load plugins」用「__ModuleLoader__.load id == 包名」四证核对；host 半区崩=整宿主起不来、client 崩=仅 UI 缺失。触发：启动失败/起不来/崩溃循环/Failed to load plugins/半区加载失败/插件加载失败/ERR_PACKAGE_PATH_NOT_EXPORTED/重启后依旧崩。
version: 1.0.9
author: DSHOME
license: internal
metadata:
  tags: [dshome, dsh, 崩溃, 自愈, 排查, boot, fail-loud, 前端半区, marker, recovery, loader]
  related: [mind/L2/Skill/dshome-diagnostics.md, mind/L2/Skill/dshome-plugin-dev.md, docs/incidents/DSHOME-ISSUE-20260831-PLUGIN-LOAD.md, scripts/plugin-change-guard.mjs, packages/dshome/lib/host/plugin-store.js]
contract:
  id: dshome-crash-recovery
  triggers: [启动失败, 起不来, 崩溃循环, Failed to load plugins, 半区加载失败, 插件加载失败, ERR_PACKAGE_PATH_NOT_EXPORTED, 插件导致启动崩, 重启后依旧崩]
  inputs: [崩溃现象, 后端启动日志/前端报错文本, 最近改动（插件/patch/exports）]
  outputs: [层定位（装配期/运行期/前端半区）, 崩溃插件与根因, 自愈动作（recover/safe/修复）, 防复发动作]
  deps: [dshome-diagnostics, dshome-plugin-dev, scripts/plugin-change-guard.mjs, %APPDATA%\dshome-shell\dshome-shell.log]
---

# dshome-crash-recovery — DSHOME/DSH 崩溃排查 + 自愈

> 建立：2026-09-06 | 案例：09-04 mind-recall 启动崩溃循环（漏 exports）、09-06 imagegen-min 前端半区（client.js 注册 id 与包名错位）
> 与 `dshome-diagnostics`（运行态崩/卡/闪断）互补：本卡管**装配/加载期 + 前端半区**；机制权威见宿主 `dsh-app-boot`（fail-loud/审计）与 `cordis-plugin-loader`（entry 语义）。

## 〇、第一判：崩在哪一层（1 分钟内定性）

| 层 | 特征信号 | 对主体影响 | 主要证据源 |
|---|---|---|---|
| **装配期**（loader/boot） | 宿主启动即退/循环重启；日志 `fatal load failure` / `plugin tree failed to load` / `failed to import loader entry` / `ERR_PACKAGE_PATH_NOT_EXPORTED` | **整宿主起不来** | 后端启动 stderr 尾部、shell log errTail、marker 时间戳 |
| **运行期** | 宿主曾正常，运行中退出 code 1 / unhandledRejection | 进程退出（`installFailLoud` 是设计，非随机） | shell log `{"backend","exit","code":1}`（走 dshome-diagnostics） |
| **前端半区**（client） | 前端弹「Failed to load plugins」，后端 HTTP 200 正常 | **仅该插件 UI 缺失**，宿主活着 | 浏览器控制台、client-modules 报错 |

**判据顺序**：① 后端 HTTP 是否活着（3099）→ 死 = 装配期或运行期，再按"是否启动阶段"分；活 = 前端半区问题，直接进场景卡 B。
⚠️ 先跑真实证据（日志/HTTP/marker）再动手，别凭"我记得改过啥"猜（dshome-diagnostics 同款纪律）。

## 一、场景卡 A：启动失败 / 崩溃循环（装配期）

**机制**：`boot()` 树 settle 后跑 `assertEntriesActivated`——任一启用的 entry 若 import/apply 失败或停在 pending（等不到 inject 服务），整体 boot 抛错「plugin tree failed to load」并 dispose；`installFailLoud` 再把运行期未捕获 rejection 变成 `exit(1)`。所以"宿主反复起不来"最常见的根因 = **插件树某一环坏了**（缺 exports 注册 / 语法错 / import 期抛错 / inject 服务不存在），官方有意 fail-loud——宁可整体失败也不半运行，错误一般指名道姓。

**排查三步**：

1. **定位崩溃插件**（marker/日志对比）：
   - 有 marker 的插件：看 `profiles\dshome\.dsh-market\<name>-marker.txt` 时间戳——崩溃插件**它自己不再刷新**，排在它前面的每轮都刷新（「插件树能加载到前一插件 ≠ 本插件正常」）。
   - 无 marker 的插件：看启动 stderr 尾——`failed to import loader entry <id> (<name>): ...` 直接点名；`ERR_PACKAGE_PATH_NOT_EXPORTED` = 包 exports 缺子路径（见下）。
2. **自愈**（由易到难）：
   - **快速回滚**：`node scripts/plugin-change-guard.mjs --recover`（按备份恢复 3 件套 package.json/pnpm-lock/cordis.patch.yml + pnpm install + 裸跑冒烟；冒烟不过提示用更早备份目录）。
   - **精准修复**：新 host 插件漏 exports → `packages/dshome/package.json` 的 `exports` 补 `"./<name>": "./lib/host/<name>.js"`（三步 checklist 见 dshome-plugin-dev §十，**exports 是最易漏的一步**）；语法/逻辑错 → 改插件本体。
   - **逃生**：宿主还起不来时用安全模式（`packages/dshome/scripts/safe.mjs` 挂白名单，id 由 `shell-app/safe-overlay.cjs` 从 **L3 产品层 + L4 profile 覆盖层并集**动态解析，共 19 个；`--print-ids` 可先自检清单）先起来，再修坏插件。
     ⚠️ **safe 的覆盖边界（2026-09-12 实测 `--print-ids`）**：清单 20 个 id **全是自有插件 + 官方实验三包 —— 第三方包一个都没禁**，其中就包括**能在进程内改 profile 的插件市场 `dsh-market`**。⇒ **safe ≠ "第三方面被关掉"**（09-11 第三方包崩时 safe 同样起不来）；事故窗口里若从市场装插件，等于**继续改 profile** ⇒ 先跑 `plugin-change-guard --preflight` 留安全点。
3. **防复发验证**：修复后重启前跑 `node scripts/plugin-change-guard.mjs --preflight`（L4 形态三查 + 裸跑冒烟 + 备份安全点），通过才重启；重启后看 marker 刷新 / HTTP 200 / 对应 verify 脚本。

**已知事故**：09-04 mind-recall 漏 exports → `ERR_PACKAGE_PATH_NOT_EXPORTED` → 每 ~3s 一轮 boot、崩溃循环 7+ 轮；marker 对比（mind-inject 刷新 / mind-recall 不刷新）锁定崩溃点。修复 = exports 补 1 行。

## 二、场景卡 B：前端「Failed to load plugins」（client 半区）

**机制**：客户端模块系统（`dsh-client-modules`）是**惰性注册**模型：host 侧扫描插件生成启动图（行 id = 包名）→ 前端按图拉 `/plugins/<包名>/client.js` → bundle 执行 `window.__ModuleLoader__.load({ id, factory })` 只登记 factory → 加载器查 `factories.has(图里的 id)` 才算注册成功。**id 对不上 → `loaded without registering "<包名>"`**，后端毫不知情（host 半区 OK）。

**排查：四证核对表**（四处必须全同，任一不同即病根）：

| 位置 | 期望值 |
|---|---|
| `package.json` 的 name | `<包名>` |
| host 半区 `export const name`（lib/index.js） | 同 |
| `cordis.patch.yml` 条目 name | 同 |
| `client.js` 里 `__ModuleLoader__.load({ id })` | **同**（最易漏：改包名/抄模板时忘改） |

**修复**：把 client.js 的注册 id 改成包名 → 重启宿主 → 该插件 UI（生图卡片等）恢复。
**注意**：`stripClientSuffix` 只剥 `/client` 尾巴，救不了 `plugin` vs `min` 这类名字差异。

**已知事故**：09-06 imagegen-min——包名 `dsh-imagegen-min`，client.js 注册 id 却写 `dsh-imagegen-plugin`（抄模板漏改），前端半区整体不加载。

## 三、场景卡 C：host vs client 半区失败差异

| 半区 | 失败后果 | 说明 |
|---|---|---|
| **host 半区** | **整宿主启动失败**（fail-loud） | 装配期：import 失败/apply 抛错 → boot 拒绝；运行期：unhandledRejection → exit(1)。与官方内核同进程，无沙箱兜底 |
| **client 半区** | 仅该插件 UI 缺失 | 前端报错不崩后端；但 client/host 的 id 必须一致（场景卡 B） |

**推论**：
- host 半区改动风险远高于 client——改 host 插件前**必跑 `--preflight`**，别直接重启。
- 高危/大型插件的稳装配路线：**只进 profile 依赖 + agent preset，不进 profile bundles**（生图插件版注释原话："任何加载问题只影响该模式的会话，伤不到宿主"）。若插件在 L4 patch 顶层 insert（如 imagegen-min），它就落在 boot 关键路径上——host 半区必须保证 import 期零风险。

## 四、自愈工具速查

| 工具 | 用法 | 作用 |
|---|---|---|
| `scripts/plugin-change-guard.mjs` | `--preflight`（改前）/ `--recover [目录]`（崩后） | 备份 3 件套 + L4 形态三查 + 裸跑冒烟 / 恢复 + install + 冒烟（指针语义防坏备份覆盖） |
| `packages/dshome/scripts/safe.mjs` | 崩溃逃生 | 安全模式：白名单 id 由 `safe-overlay.cjs` 从 **L3 产品层 + L4 profile 覆盖层**动态解析（19 个；加插件无需手同步清单；`--print-ids` 自检；回归 `verify-safe-overlay.mjs` 25 断言） |
| marker 文件 | 看 `profiles\dshome\.dsh-market\*-marker.txt` | 插件级 apply 证据；时间戳对比定位崩溃点（场景卡 A） |
| **市场事件日志** | `profiles\dshome\.dsh-market\log.ndjson` | **插件/配置变更取证 —— 查"谁装了 / 改了 profile"看这里**：ndjson 一行一事件，`install`（含失败原因与 pnpm 输出尾部）/ `install-blocked`（**有 agent 在跑就拒绝安装**的并发保护，带 session id）/ `hot-mount` / `boot`。2026-09-12 补：此前本卡与 `dshome-plugin-dev` **只提 marker、零处提到这本日志**，于是"谁改了 profile"在排查口径里是空的 |
| verify 脚本 | `scripts/verify-*.mjs` | boot 后逐插件/链路验证（如 verify-boot-recall.mjs） |
| 裸跑冒烟 | dsh CLI 随机端口 + `--no-open` | 隔离复现，**勿共享主 DSH_HOME**（dshome-diagnostics ① 规则） |
| shell log | `%APPDATA%\dshome-shell\dshome-shell.log` | 运行期 exit code 与 errTail（新壳才有 errTail） |

## 五、前端自救（守护横幅 + /self-heal 自救台）

**形态**（v4，2026-09-06 修订）：**不劫持页面的横幅提示** + 一个**不加载任何插件**的纯静态自救页（host 直出 HTML）。v1 曾做"自动刷新→跳转"（误判即死循环、吞报错现场）——废弃；v2 改横幅但用全文文本轮询 → 命中**对话/历史消息里的同文本**（会话里讨论过 "Failed to load plugins" 就误弹）——废弃；v3 只认 JS 错误事件零误触，但漏报「官方把注册失败渲染成页面文本（did not activate / waiting for service）」的情形。

**两个部件**：
1. **守护横幅**（`self-heal-guard.js`，注入主页面 `<head>`，早于任何插件 bundle）。**两个通道**：
   - **通道 1 JS 错误**：监听 window error / unhandledrejection，错误消息含 `loaded without registering` / `Failed to load plugins` 实锤句 → 弹可关闭横幅。
   - **通道 2 渲染式失败页**：扫 DOM 文本，命中 `Failed to load plugins` / `did not activate` / `waiting for service` / `does not appear to be registered` 才弹。**只在【非内容展示容器】命中才触发**，排除两类：① `[data-chat-flow]`（对话/历史，用户聊到这些词很正常）；② class 含 `dshome-mind`（DSHOME 心智/知识面板，渲染 `.md` 正文——如 `project.md` 就字面含 "Failed to load plugins" 这类**描述旧事故**的句子，非当前加载失败）。避免 v2 式误触。
   - 横幅：⚠️ 检测到插件加载异常：<报错原文> → **[去自救台停用插件]**（新标签打开，主界面不丢）+ **[关闭]**。**永不跳转/刷新/劫持** → 无死循环、报错现场保留。
2. **自救台**（`/self-heal`）：插件列表（中文说明/状态）+ 每行「停用/启用」（调 `/api/dshome/plugins/toggle`，受保护核心运行中不可停）+ 「返回主界面」。地址栏输 `http://127.0.0.1:3099/self-heal` 可手动直达。

**分工边界**：前端崩（页面报错/打不开但后端 200）→ 用自救台停用坏插件；**连 /self-heal 都打不开 = 后端崩** → 跑 `--recover`（自救台页脚附命令文本）。

**防误触/防劫持设计**（v4）：通道 1 只认 JS 错误事件（对话文本不会成为 JS error message → 零误触）；通道 2 只认实锤失败短语，并排除对话流 + DSHOME 知识面板（否则文档里的旧事故字眼会被当实锤——2026-09-06 实测踩坑）。实锤句只认官方报错原文；横幅可关、只提示不动作；`/self-heal` 不经 renderIndex → 不注入守护 → 无自跳死循环。已知局限：官方若把注册失败 catch 成 console.error（不产生 error 事件、也不渲染成 DOM）则横幅不弹——此时官方「Failed to load plugins」弹窗本身仍可见，可手动去 /self-heal。

**实现位置**：`packages/dshome/lib/host/self-heal.html`（页面）+ `self-heal-guard.js`（守护 v4）+ `plugin-api.js`（`/self-heal` 路由 & `webserver/index-inject` head 注入）。改 host 源码 → **重启后端生效**。

## 六、预防 / 可选加固

- 新 host 插件上线三步 checklist（exports 最易漏）→ dshome-plugin-dev §十。
- 插件面板描述缺失/显示英文 → 去 `packages/dshome/lib/host/plugin-store.js` 的 `DESC_CN` 补中文（四级回退：覆盖文件 → DESC_CN → 包 dsh.descriptionZh → 包 description）。
- 【可选加固·未实施】给 `plugin-change-guard.mjs --preflight` 加静态检查「client.js 的 `__ModuleLoader__.load` id == package.json name」，可在重启前拦截 09-06 类事故。难点：client 半区格式不止一种（imagegen 是手写 bundle；dshome-* 是 exports 形式），静态解析覆盖面有限——动手前先枚举现有 client 半区形态再定规则。

## 七、关联索引

- `mind/L2/Skill/dshome-diagnostics.md`——运行态崩/卡/闪断（本卡只管装配/半区）
- `mind/L2/Skill/dshome-plugin-dev.md`——插件开发、三步 checklist、生命周期/修复/回滚
- `docs/incidents/`——历史事故档（PLUGIN-LOAD 等 DSHOME-ISSUE-*）
- `docs/incidents/` 09-04 报告 + 09-06 报告为两次案例原始记录
- `packages/dshome/lib/host/` 的 self-heal.html / self-heal-guard.js / plugin-api.js——前端自救界面实现

---
_版本：1.0.9 | 2026-09-18 | safe.mjs 路径订正：三处 \scripts/safe.mjs\ → \packages/dshome/scripts/safe.mjs\（前者**不存在**，实测后者在）——照原文找脚本会扑空 | _版本：1.0.8 | 2026-09-12 | §一 逃生条补「**safe 的覆盖边界**」：清单 20 个 id 全是自有插件 + 官方实验三包，**第三方一个都没禁**（含能在进程内改 profile 的市场 `dsh-market`）⇒ safe ≠ 第三方面被关；事故窗口里装插件＝继续改 profile，先 `--preflight` | _版本：1.0.7 | 2026-09-12 | §四 工具表加「**市场事件日志** `profiles\dshome\.dsh-market\log.ndjson`」一行（插件/配置变更取证：查"谁装了/改了 profile"；含 `install` / `install-blocked` 并发保护）——此前本卡与 `dshome-plugin-dev` 只提 `*-marker.txt`，这本日志从未进过排查口径 | _版本：1.0.6 | 2026-09-11 | §一 逃生条 + §四 工具表订正：`packages/dshome/scripts/safe.mjs` 已从「只解析 L3」升级为 L3+L4 并集（复用 `safe-overlay.cjs`，19 个 id，`--print-ids` 自检；回归 `verify-safe-overlay.mjs` 25 断言） | _版本：1.0.5 | 2026-09-11 | §七 关联索引去掉本机盘符（Power §四 可移植筛：出厂区不写盘符/本机路径）| 1.0.4 | 2026-09-06 | §五 v4：守护加 DOM 渲染式失败通道（.dshome-mind 知识面板排除 + [data-chat-flow] 排除），同步自 v4 代码；v3 → v4 演进记录在案_
