# dsh-mind 设计决策

> 本文记**为什么这么做**。改设计前先读这里——每条都对应一个具体的坑或一次实测。
> 现状结构见 `README.md`；代码里的关键约束都带"别回退"注释，指回这里。

---

## 一、定位：为什么是"心智"而不是"客户端"

`dsh-mind` 只做**心智**：宪法注入、上工召回、写前护栏、技能触发、观测与角色卡。

**不进本包的东西**（它们是"客户端"的组成部分，不是心智）：

| 排除项 | 理由 |
|---|---|
| 界面面板（图谱/待办/整理） | 属展示层；且官方已有「自动化任务」等面 |
| **定时任务（cron）** | **官方已完整覆盖**——见 §三 |
| 主题皮肤 / 命令面板 / 插件中心 / 输入队列 | 客户端外观与交互，与"心智"正交 |
| Electron 壳 | 载体，不是心智 |

**判据**：装上本包，你得到的是一套心智，不是一个客户端。

---

## 二、数据模型：三区 + 四条硬纪律

```
<数据根>/mind/          出厂固件（可推送、可被升级覆盖）
<数据根>/mind-private/  本机实例（永不外流）
<profile>/.dsh-market/  诊断与台账
```

**数据根解析顺序**（`lib/paths.js`）：`MIND_HOME` > **dsh home** > dev 上溯 > 包内兜底。

> **dsh home 的语义 ＝ `DSH_HOME`（非空白）?? `~/.dsh`** —— 与官方
> `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome` **同语义**。
> 落到 `<home>/mind-data`（独立插件布局）或 `<home>` 本身（单体布局：其下有 `mind/`）。

### 纪律 ①：`mind-data` **不要求已存在**

全新安装时它正等着首启自举创建。写成"不存在就换别的"会让固件落到**错误位置**。

> **实测代价**：首版写成"两者都不存在 ⇒ 回落 `cwd`"，后果是"谁在哪跑就落哪"。

### 纪律 ②：**永不回落 `cwd`**

心智数据必须有**稳定归属**。cwd 随调用者漂移，不是能承载长期记忆的位置。

### 纪律 ③：profile 目录**按布局分档**（别一刀切）

| 布局 | 诊断/台账该落哪 | 理由 |
|---|---|---|
| **单体**（dsh home 含 `mind/`，如 DSHOME 仓库） | `<home>/profiles/<名>`，**忽略** `DSH_PROFILE_DIR` | 诊断属"心智自己的那个 profile"；跟随 GUI 会话旋钮会让 marker 写错目录（实测红过一整片断言） |
| **独立插件**（如官方客户端） | 认 **`DSH_PROFILE_DIR`** | 诊断属"**插件正在运行的那个 profile**"；不认它会掉到包内 `.profile`，落痕跑进插件源码目录 |

### 纪律 ④：上游包必须**从宿主**解析（`lib/host-resolve.js`）

`import('@deepseek-ai/dsh-llm')` 按**本文件位置**往上找 node_modules。当插件以
**junction / link** 方式安装时，Node 按 **realpath** 解析 ⇒ 找到插件源码目录（那里没有
node_modules）⇒ 导入失败 ⇒ **R0 注入实际不工作**（marker 出现 `createUserMessage 不可用`）。

**解法**：以**宿主入口**（`process.argv[1]`）为基准解析——官方客户端是
`...\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\index.js`，dsh CLI 是
`<dir>\node_modules\@deepseek-ai\dsh\lib\bin.js`，两者往上找都命中宿主的 node_modules。

---

## 二·补、**测试环境掩盖真缺陷**（2026-09-29 最重要的一课）

纪律 ② 的 `~/.dsh` 档与纪律 ④，**在自建测试环境里全是绿的**，装进真实客户端才暴露。
根因是**测试环境与真实环境有三处结构性差异**：

| 差异 | 测试环境 | 真实客户端 | 掩盖了什么 |
|---|---|---|---|
| **安装方式** | `file:` **副本**（插件被复制进 profile 的 node_modules，旁边正好有上游包） | `link:` **junction**（按 realpath 解析到源码目录，没有 node_modules） | 纪律 ④ |
| **环境变量** | 我手动设了 `DSH_HOME` | 客户端**不设** `DSH_HOME`（用命令行参数传 profile） | 纪律 ② 的 `~/.dsh` 档 |
| **marker 检查** | 只看**最后一行** | 全量看 | ④ 的降级行被 `registered hook` 盖住 |

**三条判据（写进门禁的教训）**：

1. **测试环境的安装方式必须与目标一致**——`file:` 副本 ≠ `link:` junction，模块解析行为不同。
2. **验证要看全量 marker，不能只看最后一行**——降级行会被后续正常行盖住。
3. **不设环境变量跑一遍**——只测"env 齐全"的路径，等于没测默认路径。

---

## 三、不做定时任务（2026-09-29 决定）

**官方「自动化任务」与自建 cron 是同一件事，且官方更完整。**

| 能力 | 官方 | 自建（已弃） |
|---|---|---|
| 到点拉起**独立新会话** | ✅ 实测确认 | ✅ |
| 任务列表 / 状态筛选 / 搜索 | ✅ | ❌ |
| **运行记录**（含保留策略、分页） | ✅ | ⚠️ 裸 jsonl |
| 创建方式 | 自然语言（会话内 `schedule_create`） | ⚠️ 手写 JSON |

**未查实项（不假装查过）**：官方是否有**串行闸 / 重试上限**。该未知项**不改变决定**——
若有＝纯重复；若无＝缺的是并发保护，应以**提上游 issue** 解决，而非让一个"可移植"的包背 62KB 引擎。

---

## 四、上游不重叠的判据

本包与官方能力的关系（逐条实测过，不是照抄包描述）：

| 本包 | 官方同类 | 关系 |
|---|---|---|
| `inject` / `recall` | `dsh-agent-instructions` / `dsh-persona` | 官方供**通道**，本包供**内容与策略** |
| `guard` | `dsh-experimental-auto-review` | 官方管**工具授权**（通用），本包管**内容与区域**（心智专属） |
| `skill-loader` | `dsh-skill-filesystem` | 官方 `register` 注册式；本包自扫 frontmatter。**各扫各的目录** |
| `agent-roles` | `dsh-experimental-tool-agent-team` | 官方按 Team membership 装同一套；本包**每成员独立 persona** |
| `mood` / `session-budget` / `compaction-log` | `dsh-token-meter` 等 | 官方供**底层信号**，本包定**策略与呈现** |

### ⚠️ 判据教训：**不许用包 description 判断能力**

定这些结论时连错三次，根因同一个——**拿二手信息推断能力**：

1. 照抄 `package.json` 的 description 说某官方包"是只读目录" ⇒ 实际它是**一级侧边栏入口 + 完整页面**
2. 同样照抄 description 判"官方只在会话内" ⇒ 实际它**到点拉起独立会话**（与自建同形态）
3. 在打包产物里搜到 `cronForm.*` 文案 key 就假设"有编辑表单" ⇒ 实际那只是**详情页渲染规则**用的

**共同根因**：① 用 description 判断能力（上游描述与实现不符）；② **样本偏差**（只查本地
`node_modules` 的旧版本，没查**实际运行中的**桌面版 runtime，而真正的实现包本地根本没装）；
③ 看到符号就推断能力。

> **判据：能力必须实测运行中的系统。** 这与 `prompt-surface-audit` 卡里那条
> "别信注释里的『实测』——机制代码与活进程读数才是一手"是同一件事。

---

## 五、检索用 bigram 词面，不用向量

**取舍，不是"最先进"**：词面盲区尚未真咬人（多次回归实测召回 39/40），而向量检索会显著
加重依赖与成本。**够用就好**。

配套的检索质量约束（都在 `lib/search.js`）：

- **切块**：整篇算相似度会被分母稀释（长文里出现一个专有词也拉不过阈值）⇒ 整体 + `## ` 分节 +
  首段，取最高分。实测：没有 `##` 的整篇与短查询相似度被稀释到阈值之下 ⇒ "写得进、召不回"。
- **物理隔离**：候选 = `L3/common/`（恒含）+ `L3/projects/<当前项目>/`（仅当前）。其它项目不扫。
- **通用层保底席位**：项目层恒在场会吃满配额 ⇒ 通用层零席位。装配时给通用层保底 2 席。

---

## 六、注入机制：每会话一次 + 代次跟踪

R0（宪法）与 R1（召回）**共用** `lib/injector.js`。三个要点：

1. **正文即注入源**，不做手写摘要副本。曾用摘要 ⇒ **权威倒挂**（生效的是摘要、改正文不生效）。
   现在每会话运行时读盘 ⇒ 改正文即改注入。
2. **代次键**（`session.surface.replaceGeneration`）：官方压缩器只保护 surface 第 0 格、
   **从第 1 格起压**，而注入塞在后面 ⇒ **每次压缩必被换出去**。代次只有 replace 才 +1，
   普通 append 不动 ⇒ 同代次 O(1) 返回（零扫描）；换代次才扫 surface 复核在场。
   > 曾试过两条错路：查 `decision.messages` 判在场（**死代码**，该数组不含会话历史）；
   > 订阅 `compaction/end` 摘标记（**失败压缩也 append end** ⇒ 误摘、白重注一遍）。
3. **注入没落地 ⇒ 不记代次**：`insertAfterClaimed` 在 `decision.messages` 非数组时静默返回原对象。
   若照样记代次，一次没落地会把该代次"钉死"、到下次换代前永不再试。

**为什么抽共用**：同一机制写两遍 ⇒ 修一处漏一处（历史上两插件曾各维护一份 60 行代次逻辑）。

---

## 七、护栏：只拦不注入，且诚实标注强度

- **只拦不注入**（注入归 `inject`）——单一职责
- **fail-open**：整个 apply 包 try/catch；判定内部出错 ⇒ **放行**（宁可护栏没生效，也不带崩界面）
- **不做"等放行"硬拦**：程序判不了用户意图，硬拦易误伤生长

### ⚠️ 强度诚实标注（不许写得比机制强）

本护栏是**纪律级 + 来源标注**，**不是防伪机制**——本机进程可绕过（直接改批准记录）。
它治"误伤/误写"，不治"恶意"。**这是已标注的边界，不是待补的漏洞。**

### 不覆盖的面

`pwsh` / `node` 直接写文件**不经此处**（内容级判定不现实）⇒ 本包**既不拦、也不留痕**
（完整版另有独立提示环 `mind-guard-hints.txt` 与归属台账 `write-log.jsonl`，本包未随）。

### ⚠️ 本包**没有放行通道**（2026-09-29 补，防"规则比机制宽"）

完整版（DSHOME）有四条互备通道：一次性额度（**写成功才消费**）· 路径前缀粒度 · 面板待裁决卡 ·
上游 `approval` 弹窗（外加 `upstreamTrace` 留痕）。**本包只有"拦"**：不读 `approvals.json`、
不接 `approval` 服务、没有面板 ⇒ 高危命中即**终局拒绝**，没有"批一下就过"的机器出口。

⇒ 纪律：被拦时**停下说明**，由主人明确放行后**主人自己动手**（或临时停用 `guard` 插件）；
**agent 不得自己去停护栏**（那等于把隐私红线一起关掉）。
`HIGH_RISK` 名单里那条 `mind-private/tasks/approvals.json` 的含义是"护它不被改"，**不是**授权来源。

### 隐私判据：**赋值形态**，不是词

拦"提到 `token` 这个词"会把"记录 token 消耗的教训"这类**正当写作**也拦死，且无解除通道。
故判据是 `KEY = 值`（值 ≥6 位）或 PEM 块。

---

## 八、角色卡：两道闸缺一不可

| 闸 | 机制 | 拦什么 |
|---|---|---|
| ① **可见面** | `request.toolFilter` → `childCtx.tools.restrict()` | 继承来的工具 |
| ② **执行期闸** | `ctx.tools.guard()` 在**调用期**判 | **scope 自己注册的工具** |

**为什么必须有 ②**：`restrict()` 的官方语义是"只过滤该 scope **继承来的**工具，不过滤它自己注册的"，
而 `subagent` 是按每个 agent 自己的 scope 注册的 ⇒ 光靠 ① 拦不住"成员再起成员"。
**删了 ②，"成员不得再起成员"就是空话。**

其他约束：

- `maxDepth` 是**绝对**深度上限（官方校验 `delegationDepth(parent)+1 > maxDepth`）⇒ 顶层起成员**必须传 1**，传 0 直接拒。
- label 形如 `<卡名>:<成员名>`——**卡名含冒号要退回卡 id**（否则解析不出来）。
- 卡正文 = 成员的**系统提示词**；改卡只影响**之后起的**成员。

---

## 九、上游抗崩：运行时可选获取

所有 `@deepseek-ai/*` 的取用都走 `lib/upstream.js`：拿不到返回 `null`，调用方降级。

> 顶层具名导入是 ESM 的**链接期**错误：上游一改名，模块在任何代码求值前就抛错，
> 插件里 `apply()` 外层的 try/catch **一行都执行不到** ⇒ 整个插件树加载失败 ⇒ 界面起不来。

**实测**：`dsh-settings` 的 `settingsNamespace` 在 `0.1.5-rc.2` 与 `0.2.0-rc.1` **都不存在**——
本层保证那只是"降级"，不是"崩"。

---

## 十、首启自举：五条纪律

1. **幂等**：必备件齐全 ⇒ 一个字节都不动
2. **只增不改**：已存在的文件一律跳过（**绝不覆盖用户已经养出来的心智**）
3. **不写示例记忆**：只建私有区空壳 + 首启说明（写了＝预设生长方向）
4. **缺失必＝未就位**：用**必备件清单**判据。单点判据（只看 `SOUL.md`）下"SOUL 在、HUB 被误删"
   会被当成"已就位"⇒ **跳过补缺**，残缺固件永远修不好
5. **fail-open**：自举异常只 warn，绝不断插件加载

---

## 十一、注入消息的**形态是硬契约**（2026-09-29 把宿主带崩两次，最贵的一课）

### 两种合法形态（**按宿主会话格式版本自适应**）

| 宿主 | 形态 | 出处 |
|---|---|---|
| **V3（≤ 0.1.x）** | `{ kind: 'plugin', plugin: '<包名>', form }` | `dsh-agent-instructions` / `dsh-time-context` 的写法 |
| **V4（≥ 0.2.0）** | `{ kind: 'plugin:<包名>', form }` ← **没有 `plugin` 字段** | 官方 `producerKind()` 的 `return \`plugin:${plugin}\`` |

外层形态两版相同：

```js
createUserMessage({
  content: [{ type: 'text', text }],   // content 是块数组，不是 { text }
  source: pluginSource(name, form),    // 必须构造期传入（消息被 freezeMessage 冻结）
});
```

### 违反的后果：**整个回合作废**，两次症状不同

| 错法 | 实机报错 |
|---|---|
| ① 完全没有 `source` | `Cannot read properties of undefined (reading 'kind')` |
| ② V4 下用 `kind:'plugin'` | `format v4 message requires a producer-owned source kind` |

① 的机理：宿主有 **30+ 处**直接读 `message.source.kind`（`dsh-agent-loop.isOwned`、
`dsh-api-session-controller`、`dsh-session-title`、`dsh-tool-skill`、`dsh-goal`…）。

② 的机理：V4 的准入函数**明确拒绝**退役包装 —— 原文：

```js
function source(message) {
  const value = message["source"];
  if (!isSessionFormatJsonObject(value) || typeof value["kind"] !== "string"
      || value["kind"].length === 0 || value["kind"] === "plugin")
    throw new SessionFormatError("format v4 message requires a producer-owned source kind");
}
```

### 默认取 V4（宽容度不对称）

V4 对 `kind:'plugin'` 是**硬拒绝**（整回合作废）；V3 见到 `plugin:<名>` 只是"不把它当
plugin 消息"（**无害**）。⇒ **版本探测失败时取 V4，是损失更小的一侧**。
（客户端宿主入口在 `app.asar` 里，普通 Node 读不到 ⇒ 探测可能失败 ⇒ 必须靠这个默认值兜住。）

### 判断"是不是我干的"的线索

错误发生在 `turn/start` 与第一个 `step/start` **之间** ⇒ 那就是 `agent/pre-step` 的地盘
（`dsh-agent-loop` 里 `if (decision.kind === "reject")` 那一行）。

### 为什么之前所有测试都是绿的

| 缺的那一轴 | 说明 |
|---|---|
| **只验了"返回非 undefined"** | 消息插进去了、形状是错的 ⇒ 宿主照炸 |
| **只跑了旧版本宿主** | V4 的拒绝规则在 0.1.x **根本不存在** ⇒ 本地怎么跑都绿 |
| **测试自身的坑** | 注入是"每会话每代次一次"；先跑隔离会消耗状态，全链就"看起来没注入" ⇒ **全链必须跑在隔离之前** |

> **判据：注入类改动的验收，必须断言"产物的形态"，不能只断言"函数返回了东西"；
> 且必须**在目标版本上**断言。**

---

## 十二、跨环境验收的判据（三次实机翻车换来的）

自建测试环境与真实客户端有**结构性差异**，会成片掩盖缺陷：

| 差异 | 测试环境 | 真实客户端 | 掩盖了什么 |
|---|---|---|---|
| **安装方式** | `file:` **副本**（旁边正好有上游包） | `link:` **junction**（按 realpath 解析，没有 node_modules） | 上游解析 |
| **环境变量** | 我手动设了 `DSH_HOME` | 客户端**不设** `DSH_HOME`（用命令行参数传 profile） | `~/.dsh` 档 |
| **宿主版本** | 0.1.5-rc.2（V3 格式） | **0.2.0-rc.1（V4 格式）** | §十一 的 V4 规则**本地根本不存在** |
| **观察方式** | 只看 marker **最后一行** | 全量看 | 降级行会被后续正常行盖住 |
| **验收对象** | 只看"我的日志写了什么" | 要看"宿主拿到什么" | §十一 的形态契约 |

**五条判据**：

1. 测试环境的**安装方式**必须与目标一致（副本 ≠ junction）。
2. **不设环境变量跑一遍**——只测"env 齐全"等于没测默认路径。
3. **在目标版本上验**——本地旧版本跑绿**不构成**对新版本的验证。
4. **看全量 marker**，不看最后一行。
5. **断言宿主侧产物**（消息形态 / 事件流），不只断言自己写的日志。

### 从会话日志取真相（已工具化）

会话日志是**多帧 zstd**（每帧一个独立块）——只解第一帧只会拿到 ~170 字符的 session 头。
`turn/end` 的 `reason.kind=error` 带 `error.message`，是定位失败回合最直接的入口。

`scripts/read-session-error.mjs`（单会话）· `scan-turn-errors.mjs`（全量扫）·
`dump-around-error.mjs`（失败点上下文）。

---

## 十三、前端配套：自托管浏览器包 + 只读面板（2026-09-29 加）

### 浏览器半怎么进外壳：**只用官方 `dsh.client`**（自托管是死路，实测订正）

正解＝在 `package.json` 声明 `dsh.client`（`platform: "web"` + `inject`）并导出 `./client`。
`@deepseek-ai/dsh-client-modules` 会扫 Loader 条目、**按包名**编入启动图，并自行服务
`/plugins/<id>/client.js`（combo 批次）。junction / link 安装也没问题：它是按**行所解析到的
模块 URL** 往上找 `package.json`（`nearestPackage`），不看"包名能不能在 DSH 自己的
node_modules 里解析"。

### ⚠️ 入场券：启动行必须是**裸包名**（2026-10-04 实测，最贵的一条）

扫描器判"这条 Loader 行属于哪个包"用的是 `exactPackageSpecifier`：

```js
return specifier.length > 0 && !specifier.includes("/") && !specifier.includes(":") ? specifier : void 0;
```

**不含 `/` 才算包名**。本包十行原本全是子路径（`dsh-mind/host/inject`…）⇒ 全部被判"不是包行"
⇒ `locatePkgJson` 早早 `return void 0` ⇒ `dsh.client` **永不被扫描**。

代价的形态极坏：**面板一片空白，而宿主、marker、自测全绿**——只有
`/api/mind/boot` 的 `hasSelf=false`（75 条官方 entry，就是没有我）能看出来。
对照组一眼可见：能用的第三方客户端插件（`dsh-context`、`dsh-opencode-go-usage`）
行名都是**裸包名**，`dsh-context` 的注释还写明了这个分工（"这行把包 main 当 host 半，
`dsh.client` 再把 `./client` 当浏览器半"）。

⇒ 修法：加一行 `- id: dsh-mind / name: dsh-mind`（挂包 main），且**包根必须是合法 plugin**
（空模块会判 "invalid plugin"，故 `lib/index.js` 挂了一个只留一行痕的空 `apply`）。
自测 ⑳ 钉三条（含"文件里确实还有子路径行"的反例，防"恰好全裸"），真装 ③ 钉一条。

> ⚠️ **曾经的错（保留在此，别回退）**：我照抄第三方插件（`dsh-opencode-go-usage`）注释里的
> "自托管 + `webServer.tapIndex` 注 boot 行"，理由是"官方解析不到第三方包"。实测两头都错：
> 1. 本版启动清单是**对象** `{ rev, entries, batches }`（`parseBootManifest` 逐字校验），
>    而那份实现第一句是 `if (!Array.isArray(graph)) return html` ⇒ **静默 no-op**；
> 2. marker 照样写 `client=ok 21049B` ⇒ **假绿**，面板从没被加载却"看起来验过了"。
>
> 教训与 `§四` 那条同源：**别用二手注释（哪怕是能跑的插件）判断能力，去读外壳源码**。
> 以及一条更狠的：**"我做了 X"和"X 生效了"之间必须有一格盘上读数**——`hasSelf` / beacon
> 就是为此存在的（见下节）。

两条硬约束（各有断言盯着）：

1. `package.json` 的 `dsh.client` + `exports["./client"]` 缺一不可（后者缺 ⇒ client-modules
   **响亮抛错**："declares dsh.client but exports no ./client bundle"）。
2. 浏览器半是**手写 bundle**：只用工厂参数 `require`（外壳外部化的 `react` / `react/jsx-runtime`），
   **不许裸 `import`**；`client/` 与 `lib/` **分目录**，故它不会被 node 侧"自动发现"当模块加载
   （否则 selftest ① 会在没有 `window` 的环境里 import 它，整节变红）。

### 链路每一环都要有盘上读数（否则"静默失效"永远抓不住）

面板"看不见"有三种完全不同的原因，必须能一次分清：

| 环节 | 读数 | 在哪 |
|---|---|---|
| 有没有被编进启动图 | `hasSelf` + 真实 entries/batches | `/api/mind/boot`（读 `clientModules.graph()`） |
| 浏览器半有没有被执行 | beacon `apply` ⇒ `status.clientApplied` | `/api/mind/beacon` |
| 槽位有没有注册上 | beacon `slot`（成功才报） | 同上 |
| 组件有没有真渲染 / 有没有抛错 | beacon `render` / `error`（`error` 进**警告**） | 同上 |

`status.notes` 会把"已到 X、未到 Y ⇒ 断点在这两格之间"直接写成一句话。
**这套读数是被一次真实翻车逼出来的**：没有它，我拿到的是"主人说没有"，而我手里只有"marker 说 ok"。

### 槽位只许用"本机实测存在"的

面板挂 `conversation.view`（顶级视图）+ `sidebar.footer.action`（页脚挂件）——两个槽位在本机
**已装插件**（`dsh-context` / `dsh-opencode-go-usage`）里都在用。**凭记忆写槽位名 = 面板静默失效**，
故 selftest 把"注册到的槽位名 ⊆ 白名单"做成断言，并配一条反例（拼错的 `converstion.view` 会红）。

### 为什么只有"只读 + 一个开关"

面板容易越想越大（图谱、待办增删、待裁决卡）。本包**不做**：`guard` 没有放行通道（`§七`），
没有裁决机制就没有裁决面板；记忆/待办增删不在本包（`§一`）。所以面板只做**"把盘上的事实读给人看"**，
唯一写口是 `connect.js` 那个开关——而且**转发而非复制**判据（两处各写一份必然漂移）。

### 信任闸：**判据不许比现实严一档**（2026-10-04 实测）

官方桌面壳的页面跑在**自定义协议** `dsh-app://app` 上（渲染进程带
`--standard-schemes=dsh-app --fetch-schemes=dsh-app`）。面板发出的 `/api/mind/*` 请求由 Electron
主进程的 `forwardWebRequest()` 转发给本机 web 服务器，而它**转发前显式删头**：

```js
for (const name of ["host", "origin", "cookie", "sec-fetch-site"]) headers.delete(name);
headers.set("cookie", cookie);                // 只补回它自己签发的 cookie
const response = await fetch(target, init);   // Host 由 fetch 自动补成 127.0.0.1:<port>
```

⇒ **到达插件的请求：没有 `Origin`、也没有 `Sec-Fetch-Site`。**

我上一版闸写的是"无 `Origin` ⇒ 必须有 `Sec-Fetch-Site: same-origin|none`"（那是 `dsh web`
直连形态）⇒ 官方客户端面板**每一个请求都 403**。症状极坏：面板画得出来，但每格都写"读不到"，
而 marker 里**一条 `hit:` 都没有**（命中记在闸之后）⇒ 盘上无痕、只能靠读 Electron 源码才找得到。

**修法与纪律**：

- 无 `Origin` + loopback + 非 `cross-site` ⇒ **放行**（桌面壳形态）
- 带 `Origin` ⇒ 仍必须与本机同源或 `dsh-app://app`（挡住本机浏览器里的恶意页）
- **判定本身也留痕**：`noteRequestShape()` 把首次见到的每种形态写一行 marker
  （`req: host=… origin=… site=… remote=… => allow|DENY`），并进 `status.requestShapes`
  —— 闸挡错人时不再"盘上无痕"

残留风险（诚实标注）：老浏览器不发 `Sec-Fetch-*`，其**跨站导航**能打到只读口；
但导航响应攻击者读不到（无 CORS），写口（POST）需要 JSON + 非跨站 ⇒ 不构成实际通道。

### "挂载 ≠ 生效"要看得见

marker 环里 `apply:` 开头的行只证明**挂载**。面板把每个插件的**运行读数**（非 `apply:` 行数）
单列一格，为 0 时给出"自挂载后没有任何运行读数"的警告 —— 2026-09-29 正是靠这类读数定位到
`mood` / `session-budget` / `compaction-log` 三个插件在真宿主上**从未生效**。

**同日修掉（2026-09-30）**：根因是 `session/event` 回调签名——宿主传 `(session, event)` 两个位置
参数，本包写成单参 payload ⇒ 事件恒 `undefined` ⇒ 三处全部提前 return。修法：抽
`lib/host/session-event.js` **一处**归一化（宿主形态优先，兼容单参老写法：session 可能挂在
`event` 上），三个插件共用；selftest ⑪/⑫/⑬ 各加一条**按宿主形态**的行为断言，㉑ 再钉一条
**结构性**判据（谁把签名改回 `(payload)` 立刻变红）。教训与 `§十一` 同族：**判据与实现同错 =
双向空转**，纯函数自测看不见运行期契约。

**顺带收口一个盲区**：面板"有没有被浏览器加载"过去只能靠人眼。现在 `/dsh-mind/client.js` 与
`/api/mind/*` 每次命中都在内存记账，`status` 给出 `hits` / `clientFetched`，**首次**命中写一行
marker ⇒ 这条链以后可机械验收（轮询不会刷满 marker 环）。

### 沉默要分档（误报比不报更糟）

v1 一律按"零运行读数 ⇒ 警告"报，于是 `guard` 被误报——它只在**拦截**时留痕，"没拦过"是正常态。
现在 `SILENT_BY_DESIGN`（`connect` / `api` / `guard`）降级为**说明**（结论不删，只不当故障），
其余插件的沉默仍是**警告**（`mood` 那类"每轮都该留痕却没有"才是真的坏）。

### 测试的"客户端发现"不许假设包躺着的位置

`test/pre-step-waterfall.mjs` 原来只认 `resolve(PKG,'..')/resources/app.asar`（源码住在客户端目录
里时的布局）。源码搬到 `~/.dsh/plugins/dsh-mind` 之后 ⇒ 找不到客户端 ⇒ 不重跑 Electron node 模式
⇒ "最贵的判据"被跳过并记 FAIL ⇒ **`npm test` 假红**。现在按判据找：`DSH_CLIENT_DIR` → 同级旧布局
→ 各盘根下名字含 `Harness` 的目录（1 层有界）。**没有把任何一台机器的绝对路径写进仓库**。

---

_本文是现行文档：与实测不符即缺陷。_
