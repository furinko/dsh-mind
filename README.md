# dsh-mind

> 给 DeepSeek Harness 的**一套可移植的心智**：宪法注入、上工召回、写前护栏、技能触发，
> 外加一份**出厂固件**——首启自动落地，之后由你自己养。

**版本**：0.1.3（工作树含未发版的「前端配套」）｜ **兼容**：`@deepseek-ai/dsh` ≥ 0.1.5-rc.2（真机验收在 **0.2.0-rc.1 / V4 会话格式**上）
**依赖**：零第三方运行时依赖（只用 Node 内置模块 + `@deepseek-ai/*` 上游）

---

## 它提供什么

| 插件 | 职责 |
|---|---|
| `inject` | **R0 宪法注入**：每会话首步注入 `SOUL.md` + `AGENTS.md` **全文**（人格 + 运行纪律）。**并负责首启自举** |
| `recall` | **R1 上工召回**：每会话首步装配「项目进度/待办 + 相关记忆 + 最近教训 + 用户规则 + 人设卡」 |
| `guard` | **写前护栏**：隐私红线（出厂区不写凭据）+ 自我修改门禁（高危文件需放行）+ 未接入禁写 |
| `connect` | 「接入心智」每会话开关（默认接入；关闭则上述三者都跳过） |
| `skill-loader` | **Skill 触发**：命中卡片 frontmatter 的 `contract.triggers` ⇒ 注入一张方法论卡片（摘要非全文） |
| `compaction-log` | **压缩留痕**：把此前静默的上下文压缩写成一行审计 |
| `mood` | **情绪状态**：每轮注入「当前情绪 + 客观成因」。只改语气、不改判断 |
| `session-budget` | **会话预算哨兵**：上下文过长时提醒换新会话（只在回合结束评估，不打断回合） |
| `agent-roles` | **角色卡 → 独立 persona 子代理**：卡正文 = 成员系统提示词；三把工具 + 执行期闸 |
| `api` | **前端配套（host 半）**：只读状态 API（`/api/mind/status · tree · file`）+ 接入开关转发（`/api/mind/connect`）+ 自托管浏览器包 |

**浏览器半**（`client/client.js`，由本包自己喂给外壳）：对话同级多一个「心智」视图 + 侧栏页脚一个挂件——
看到固件是否就位、R0/R1 注入读数、私有区空不空（角色卡 / 人设卡 / user-rules / L3 / Learn）、
**每个插件有没有真运行过**（挂载 ≠ 生效，面板把两者分开列）、以及只读文件浏览。**只读 + 一个接入开关**。

**不含**：裁决/放行面板（本包 `guard` 没有放行通道，见 `docs/DESIGN.md §七`）、图谱、待办/记忆增删、
定时任务、主题皮肤、命令面板 —— 前四项源头上就没有对应机制，后三项要么官方已有，要么不属于"心智"。

---

## 三区数据模型

```
<数据根>/mind/          出厂固件（可推送、可被升级覆盖）—— 首启从包内 firmware/ 落地
<数据根>/mind-private/  本机实例（永不外流，你自己养出来的那个）
<profile>/.dsh-market/  诊断与台账（marker / 审计流水）
```

**同名私有优先**：规则从 `mind/` 读，记忆与项目从 `mind-private/` 读。
**私密一律落 `mind-private/`** —— 写进 `mind/` 等于把隐私推上公开仓库。

### 数据根怎么定（可移植的关键）

| 环境变量 | 作用 |
|---|---|
| `MIND_HOME` | **最高优先**：直接指定数据根 |
| `DSH_HOME` | 其下有 `mind/` ⇒ 认它（单体布局）；否则用 `<DSH_HOME>/mind-data`（独立插件布局） |
| `MIND_PROFILE_NAME` | profile 目录名（默认 `dshome`） |
| `MIND_MARKET_DIR` | 诊断/台账目录（默认 `<profile>/.dsh-market`） |

**两条硬纪律**（都是实测换来的，改前先读懂 `lib/paths.js`）：

1. `mind-data` **不要求已存在** —— 全新安装时它正等着自举创建；写成"不存在就换别的"会让固件落到错误位置。
2. **永不回落 `cwd`** —— 心智数据必须有稳定归属；兜底用 `~/.dsh-mind`。

---

## 安装

```bash
# 1. 装进 profile
dsh plugin --profile <你的profile> add file:../path/to/dsh-mind
# 或发布后：dsh plugin --profile <你的profile> add dsh-mind
```

```jsonc
// 2. profile 的 package.json 里把 dsh-mind 加进 bundles
{
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-mind"] } }
}
```

**3. 自检**：`node scripts/verify-dsh-mind-install.mjs <profileDir>`

> ⚠️ 装完改代码后要**先删再装**：pnpm 的 `file:` 是复制语义，不会跟随源更新。

---

## 首启自举

第一次装上、本机没有固件时，`inject` 的 apply 会触发一次自举：

- **幂等**：必备件齐全就一个字节都不动
- **只增不改**：已存在的文件一律跳过（**绝不覆盖你已经养出来的心智**）
- **不写示例记忆**：只建私有区空壳 + 首启说明（写了＝预设生长方向）
- **缺失必＝未就位**：用**必备件清单**判据（不是看单一标志文件，否则残缺固件永远修不好）
- **fail-open**：自举失败只 warn，绝不断插件加载

---

## 上游抗崩（为什么能跨版本）

所有 `@deepseek-ai/*` 的取用都走 `lib/upstream.js` 的**运行时可选获取**：拿不到就返回 `null`，
调用方降级 → **绝不把异常抛回模块加载期**。

> 顶层具名导入是 ESM 的**链接期**错误：上游一改名，模块在任何代码求值前就抛错，
> 插件里 `apply()` 外层的 try/catch **一行都执行不到** ⇒ 整个插件树加载失败 ⇒ 界面起不来。

**实测**：`@deepseek-ai/dsh-settings` 的 `settingsNamespace` 在 0.1.5-rc.2 与 0.2.0-rc.1 **都不存在**
—— 本层保证那只是"降级"，不是"崩"。

---

## 前端配套（面板）

**装完重启后端 + 刷新页面即可看到**（不需要构建步骤）：

- 对话区顶部多一个 **「心智」视图**（与「轨迹」同级），视图内两种模式：
  - **图谱**（默认）：**分层色带 + 卡片**的知识地图（L0→L3 色带、层内卡片流式排布、贝塞尔关联线）。
    点卡片看它的关联与正文；搜索按标题/路径淡化；拖空白平移、`＋/－` 缩放；项目钮切换 L3 视角
  - **数字**：状态卡（固件/注入读数/私有区/项目/插件运行读数）+ 只读文件浏览
- 侧栏页脚多一个 **「心智」挂件**：圆点＝本会话接没接入；角标＝实况警告条数；点按切换接入态

浏览器半走**官方通道**：`package.json` 的 `dsh.client` 由 `dsh-client-modules` 扫描 →
自动编入启动图 → 自行服务 `/plugins/dsh-mind/client.js`（combo 批次）。
**本包不自己造通道**（曾经自托管 + `tapIndex` 注 boot 行，在本版外壳上是静默 no-op——
启动清单是对象 `{rev, entries, batches}`，不是数组；详见 `docs/DESIGN.md §十三`）。

> ⚠️ **安装前提（缺了面板永不出现，而且零报错）**：`cordis.patch.yml` 里必须有**一行裸包名**
> （`name: dsh-mind`）。官方扫描器 `exactPackageSpecifier` 只认不含 `/` 的名字去判"属于哪个包"，
> 子路径行（`dsh-mind/host/xxx`）会被直接跳过 ⇒ `dsh.client` 永不被扫描。自测 ⑳ 与真装 ③
> 各钉了一条判据；诊断口 `/api/mind/boot` 的 `hasSelf` 可直接确认。

数据全部走**宿主同源只读路由**（浏览器不碰文件系统）：

| 路由 | 用途 |
|---|---|
| `GET /api/mind/status` | 固件就位 / R0·R1 注入读数 / 私有区统计 / **每个插件的运行读数** / 警告与说明 / 浏览器自报 |
| `GET /api/mind/tree?zone=private\|mind` | 可读文件清单（`.md/.json/.txt/.yml`） |
| `GET /api/mind/file?zone=&rel=` | 读一个文件（128 KB 截断；目录穿越挡死） |
| `GET /api/mind/graph?project=` | **图谱**：节点＝活内容件，边＝frontmatter `related`/`tags`/`topic`；随图下发 `layers`（层表唯一真源）与 `stats`（含孤点/落空读数） |
| `GET/POST /api/mind/connect` | 读/写「接入心智」开关（**逻辑仍在 `connect.js`**，此处只转发） |
| `GET /api/mind/boot` | **只读诊断**：官方启动图里有没有我（`hasSelf` + 真实 entries/batches） |
| `GET /api/mind/beacon?what=&detail=` | **浏览器自报**：apply → slot → render → error 走到哪一格 |

**信任闸**：只服务 loopback 请求，并拒绝跨站。**两种客户端形态都必须过**：

- **浏览器直连**（`dsh web` / 本机 curl）：带 `Origin` 时必须与本机同源；不带 `Origin` 时要求
  `Sec-Fetch-Site: same-origin|none`
- **官方桌面壳**（页面跑在 `dsh-app://app`）：Electron 转发前**会删掉** `Origin`/`Sec-Fetch-Site`
  （源码逐字，见 `docs/DESIGN.md §十三`）⇒ 这一形态按"loopback + 非跨站"直接放行

```bash
curl http://127.0.0.1:19387/api/mind/status    # 本机 curl 无 Origin ⇒ 放行
curl http://127.0.0.1:19387/api/mind/boot      # hasSelf 应是 true
curl http://127.0.0.1:19387/api/mind/graph     # 图谱：nodes/edges/layers/isolated/relatedMiss/stats
curl "http://127.0.0.1:19387/api/mind/graph?project=<项目key>"   # 只看该项目记忆（底座照常在场）
```

### 图谱读什么（以及它**不**做什么）

它是**分层色带 + 卡片流式排布**的知识地图（L0→L3 自上而下一条条色带，层内卡片从左到右摆、
超宽换行），不是力导向毛线团。关系判据全在 `lib/host/graph.js`（**纯函数**，可单测、有反例）：

1. **线只来自 frontmatter**（三条来源，按优先级）：
   - `metadata.related` —— **人显式写的关联**，主来源，条条都能追到作者写的那一行
   - `metadata.tags` —— 共享 **≥2 个** tag 才自动成边（阈值 2 防"通用 tag 把全图连成一坨"）
   - `topic` —— L3 记忆同主题两两成边（topic 是分类维度，比 tags 可靠）
   > v1 曾经用"正文里的 `.md` 词面引用"当边：45 个点刷出 **211 条边**，`L1/Tree.md` 一张索引表
   > 就贡献 32 条"我列了你"⇒ **枢纽全由排版决定**。边少了才读得出结构。
2. **指不到就留读数，不静默丢**：`related` 指向盘上没有的件、或**同名多份指不清**，
   都进 `relatedMiss` 并分类点名（`缺件` / `同名 N 份`）。
3. **同名多份不许猜**：`related: [project.md]` 撞上两个项目下的 `project.md` ⇒ **不连线**
   （参考实现这里是"后写的那份赢"⇒ 静默编了一条关系；本条是**刻意保留**的一处更严口径）。
   同键多份但**同区唯一**时仍连线。

另外两条口径：`README.md`/`_index.md`（索引件）不进图；`TRASH/` 下的**归档副本**不进图——
判据按**路径段**看且枚举同义形态（文件级 `__` 戳 **和** 目录级 `snapshots-` 戳）。
本机实测：不排时 11 个 TR 节点全是旧副本、还多出 3 条"副本 ↔ 活档"的假 tags 边，一个真回收件都没有。
孤点只**点名**不**下结论**（`SOUL.md` 这种被注入而不被正文引用的件天生度为 0，不是死件）。

> **本机现状（2026-10-04 实测）**：38 节点 / 45 边（全为 `related`）/ 边密度 1.18 /
> 孤点 11 / `related` 落空 23（多为指向包内脚本，如 `scripts/*.mjs`）。
> `tags` 与 `topic` 边为 0：本机只有 18/38 张卡带 frontmatter，且 L3 记忆文件没有 `topic`。
> ⇒ **想让图更密，靠的是给文件补 `related`**（这正是参考实现记的"图谱边稀疏"那条债）。

---

## 自检

```bash
node test/selftest.mjs                            # 276 项（含反例；前端配套在 ⑳、签名防回退在 ㉑、图谱在 ㉒）
node test/pre-step-waterfall.mjs                  # 28 项注入形态契约（自动找客户端，见下）
node scripts/verify-dsh-mind-install.mjs <profileDir>   # 21 项真装验收
```

> 契约测试要验**注入形态**，必须有**宿主入口**。客户端宿主包在 `app.asar` 内，普通 node 解析不到 ⇒
> 它自己会**改用客户端 Electron node 模式重跑**（客户端根按此顺序找：`DSH_CLIENT_DIR` →
> 与包同级的旧布局 → 各盘根下名字含 `Harness` 的目录）。找不到客户端时那条"最贵的判据"会
> **响亮跳过并记 FAIL**——那是有意的（宁可红，也不假装验过）。
>
> 想手工指定宿主入口：
>
> ```bash
> DSH_MIND_TEST_HOST='<客户端>/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js' \
> ELECTRON_RUN_AS_NODE=1 '<客户端>/DeepSeek Harness.exe' test/pre-step-waterfall.mjs
> ```

**写不出反例＝没验过** —— 每条断言都配了能把它变红的坏输入。

---

## 文档

- **`docs/DESIGN.md`** —— **设计决策**（为什么这么做）。改设计前先读它：每条决策都对应一个具体的坑或一次实测。
- 代码里的关键约束都带"别回退"注释，指回 `DESIGN.md`。

---

## 边界（诚实标注）

- **护栏不是防伪机制**：它只比批准记录的来源标注，本机进程可绕过。**这道闸靠纪律，不靠机器强校验**。
- **面板只读**：能看不能改——除了「接入心智」那一个开关。裁决/放行、记忆/待办增删都**没有**入口。
- **shell 写入口未拦**：`pwsh` / `node` 直接写文件不经护栏（内容级判定不现实）⇒ 只留痕、不硬拦。
- **触发匹配是精确子串**：中文口语变体会漏。这是**有意设计**（防命中自身文件名导致自触发）。
- **检索用 bigram 词面**，不用向量：词面盲区尚未真咬人，向量会显著加重依赖与成本。
- **固件不随上游自动更新**：装上后 `mind/` 就是你的了。

---

## 与官方能力的关系（为什么这些该由本插件做）

| 本插件 | 官方同类 | 为什么不重叠 |
|---|---|---|
| `inject` / `recall` | `dsh-agent-instructions` / `dsh-persona` | 官方供**通道**，本插件供**内容与策略** |
| `guard` | `dsh-experimental-auto-review` | 官方管**工具授权**（通用），本插件管**内容与区域**（心智专属） |
| `skill-loader` | `dsh-skill-filesystem` | 官方走 `register` 注册式；本插件自扫 frontmatter。**各扫各的目录，不交叉** |
| `agent-roles` | `dsh-experimental-tool-agent-team` | 官方按 Team membership 装同一套；本插件**每成员独立 persona** |
| `mood` / `session-budget` / `compaction-log` | `dsh-token-meter` 等 | 官方供**底层信号**，本插件定**策略与呈现** |

**定时任务不做**：官方「自动化任务」已完整覆盖（到点拉起独立会话 + 列表 + 运行记录）。

---

_本插件的机制源自 DSHOME 心智系统的提炼与重写；重写把 9 个插件从 5592 行压到 1039 行。_
