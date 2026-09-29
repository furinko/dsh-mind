---
name: dshome-diagnostics
description: DSHOME 诊断（两层）——①进程层：后端崩溃/卡顿先分真假(exit崩 vs offline闪断)，再 shell log errTail/进程/隔离复现；②agent 层：GUI「本轮运行失败」按 报错文本→源码链→会话日志取证 四跳定位，改 host 插件用「假宿主+真依赖」离线端到端验证。触发：后端重启/卡顿/exit1/offline闪断/本轮运行失败/报错文本/turn error。
version: 1.1.0
author: DSHOME
license: internal
metadata:
  tags: [dshome, 诊断, 崩溃, 卡顿, 重启, errTail, 报错诊断, 会话日志, turn-error]
  related: [packages/dshome/shell-app/main.cjs, mind/L1/Invariants.md, mind/L1/Concepts.md, mind/L2/Skill/dshome-crash-recovery.md, mind/L2/Skill/dshome-plugin-dev.md]
contract:
  id: dshome-diagnostics
  triggers: [后端重启, 后端卡, exit1, offline闪断, 频繁重启, 本轮运行失败, 报错文本, turn error, 会话日志]
  inputs: [后端异常现象, shell log, 进程状态, 界面报错文本]
  outputs: [诊断结论(真崩/闪断/卡顿+根因), 报错→根因定位链, 处理建议]
  deps: [dshome-shell.log, tasklist, sessions/*/session.jsonl.zstd]
---

# dshome-diagnostics — DSHOME 后端诊断

> 建立：2026-09-02 | 目标：先分清"真的崩了"还是"状态抖"，别把闪断当重启、别瞎改。

## 一、使用流程（诊断步骤）

```
① 先区分真假：后端"重启"到底是——
   A. 真崩：shell log 有 {"backend":"exit","code":1} → 壳 restart-scheduled 自动重启
   B. 状态抖：shell log 只有 offline→online（1 秒，无 exit）→ 壳探测瞬时失败，不是进程重启
② 看 shell log：`%APPDATA%\dshome-shell\dshome-shell.log`
   - grep "backend.*exit" 看 code（1=崩；新壳带 errTail=崩溃详情）
   - grep "state.*offline" 看闪断频率
③ 看进程：`tasklist //FI "IMAGENAME eq node.exe"` —— 找残留测试后端
   - 端口非 3099 / CPU 累计极高 = 测试残留（吃资源=卡顿元凶）
   - 主后端应只有一个（3099）
④ 真崩但旧壳无 errTail → 用**新壳**（exit 记 stderr 尾部）下次崩抓根因
⑤ 卡顿 → tasklist 找 CPU 高的 node（多为残留测试后端）→ kill 它
⑥ 复现 → **隔离 DSH_HOME** 起测试后端（勿共享主环境）
```

## 二、agent 运行故障（报错文本 → 源码链 → 会话日志）

> 场景：界面红字「本轮运行失败」+ 一行错误文本，**后端进程没崩**。别从报错点猜，按四跳走。

```
① 原样抓住错误文本（连 section / kind / 变量名等限定词一起抄）
② 定位抛错行：搜文本片段找抛它的模块与行（注意 grep 默认跳过 node_modules，得用 Select-String 之类扫）
③ 顺变量来源往上跳：抛错行用的值 ← 谁注册/提供它 ← 契约要求什么形状
   （实例：prompt 变量 {{model}} ← installModelSelection 注入 ← 契约要 {provider, model} 对象）
④ 找调用点：列出「上游提供者」的全部调用处 → 谁传了不合契约的值，谁就是根因
```

**判据：报错点常不是根因点。变量取到 `undefined` 时，根因通常在几跳之外。**

### 会话日志取证（读失败那一轮的原话）

DSHOME 会话日志 = **多帧 zstd**：`sessions\<workspace>\<session-id>\session.jsonl.zstd`，每帧一个独立 zstd 块。

```javascript
// 按魔数切帧、逐帧解 —— 只解第一帧只会拿到 ~170 字符的 session 头（多帧陷阱）
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
// 逐帧 zlib.zstdDecompressSync(buf.subarray(pos[k], pos[k + 1])) 再拼接
```

- `turn/end` 的 `reason` 带错误原文（`{"kind":"error","error":{"message":"…"}}`）→ 定位**哪一轮、什么错**
- `request/header` 的 `config` = 那一轮真正使用的 provider/model → 验证模型选择是否真生效
- 先按 `mtime`/目录名筛出目标会话，别全库解压

### `/api/mind/*` 从命令行调（否则 403）

`isTrustedLocalRequest` 要求 loopback + 合法 Host + **`sec-fetch-site: same-origin`**（或同源 `Origin`）。`Invoke-WebRequest -Headers @{'sec-fetch-site'='same-origin'}` 即可过闸。

## 三、离线端到端验证（改 host 插件后，不重启也能验逻辑）

用**假宿主 + 真依赖**跑真实被测函数：假的只是 hostCtx，被验的逻辑本身一行不 mock。

```javascript
const { executeTask } = require('…/cron.cjs');            // 真实被测函数
const hostCtx = { get: (n) => n === 'agents'
  ? { create: async (o) => { captured = o.setup; return { agent: { followup() {} } }; } }
  : undefined };
await executeTask(hostCtx, fakeTask);                      // 捕获插件装的 setup
const handlers = [];
await captured({ agent: {}, on: (e, f) => handlers.push([e, f]), get: () => undefined });
const h = handlers.find((x) => x[0] === 'system-prompt/assemble');
await h[1](assembly, ctx, async () => assembly);           // 手工触发组装 waterfall
// 断言最终 variables / 传入参数形状
```

- 再补一条**反证**（用旧写法跑出故障值）——证明修的就是那个因，不是别处
- **局限**：运行中的进程仍是旧码，离线通过 ≠ 已生效；**生效仍需重启**，重启后补一次**真机探针**（建一个 `once` 临时任务 → 立即运行 → 读新会话日志断言 → 删任务）

## 四、核心规则

- 🔴 **测试后端勿共享主 DSH_HOME** —— 用隔离目录起测试后端，否则与主后端争 profile/cron/资源 → 主后端不稳（反复起共享测试后端 = 主后端 exit1 诱因之一）
- 🔴 **先分真假再动手** —— 先确认是真崩（exit）还是状态抖（offline 闪断），别把闪断当重启去修
- 🔴 **跨层传值核对契约形状** —— 传字符串而底层要对象（或反之）时属性访问静默得 `undefined`，故障在几跳之外才爆炸；改跨层调用先看契约要什么形状
- 🟡 **看证据不猜** —— shell log / 进程 PID / CPU / 会话日志都是证据；先收集再下结论

## 五、行为准则

- 区分"我该收敛的"（测试活动/起后端干扰）vs"真 bug"（exit 崩根因）
- 诊断时**别频繁起测试后端/高密度跑命令**——那本身会扰乱主后端（offline 闪断）
- 查证据优先，不先假设

## 六、踩坑记录

- 反复起共享主 `DSH_HOME` 的测试后端 → 主后端 exit1（争资源/重复调度）
- offline/online 1 秒闪断 ≠ 重启（误判会往"崩"方向瞎修）
- 旧壳 backend exit 不记 stderr（只看 code）——**新壳才带 errTail**，别靠旧壳定位
- 自己密集测试活动 → 主后端 offline 闪断（该收敛）
- 会话日志**只解第一帧** → 误以为日志是空的（其实每轮一个帧）；多帧必须逐帧解
- 静态/离线验证通过就以为"修好了" → 进程里还是旧码；**host 插件改动一律要重启才算生效**

## 七、关联索引

**日志：** `%APPDATA%\dshome-shell\dshome-shell.log` · 会话取证 `sessions\<workspace>\<id>\session.jsonl.zstd`
**代码：** `packages\dshome\shell-app\main.cjs`（errTail）· `packages\dshome-mind\lib\`（cron/路由/client）
**待办：** `mind-private\L3\projects\DSHOME\project.md`（体系主线档「下一步」区）

---
_版本：1.1.0 | 2026-09-10 | 收工蒸馏：补 agent 层诊断（报错→源码链→会话日志取证四跳 + `/api/mind/*` 过闸头 + 离线端到端验证/真机探针）+ 核心规则补「跨层传值核对契约形状」| 1.0.0 | 2026-09-02 | 后端诊断固化_
