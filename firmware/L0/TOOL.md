# TOOL.md — 工具操作指南（L0 从属参考）

> 版本：1.4 | 2026-09-29 | **新增 §四「本包不随附 scripts/ 工具链」**：把散在固件各处的 **32 个脚本 / 125 处命令引用**收口成**一条可判声明**（含等效做法 + 照抄禁令），并配 `test/selftest.mjs` ⑱ 防声明腐化；同节把 `packages\dshome\*`、`dshome-mind-*`、`changelog-L0/L1.md` 三类悬空引用一并收口；正文规则语义零改动 ｜ 1.3 | 2026-09-28 | 沿革移出正文（完整版的累积沿革台账在 `mind\L1\changelog-L1.md`，**本包未随该文件**）
> 本文件为 L0 **从属参考**，非宪法级（不注入、改它不按行为宪法审批）。
> **具体工具清单/参数以运行时 schema 为准**（渐进披露由配置决定，不写死）；不确定参数名先看工具自身的 schema 再调。

## 一、按用途的操作原则（跨工具集通用）

| 你要做 | 原则 |
|---|---|
| 读内容 | 用只读工具；大文件分批（offset/limit）；能片段不整篇 |
| 找 / 搜 | 先 grep/glob 精准定位，不整库翻找 |
| 写 / 改 | 覆盖前先 read；改已有用唯一锚点；失败先读上下文再改 |
| 验证 / 运行 | 跑命令 / 看截图 / 收后台任务；退出码 0 才算过 |
| 问用户 | 需拍板 / 澄清才问，带稳定 id，一次问清 |
| 长任务 | 定目标 → 跟踪进度 → 收结果 |
| 交付 | 自检三问：改了啥 / 验证了啥 / 下一步 |

## 二、工具侧纪律（补充，不重复 AGENTS 行为规则）

- 🔴 **先搜后写**：改任何文件前先 grep/glob 搜相关引用与现有实现；不凭推测写码。
- 🟡 **省用量**：能定位不读全文；能 read 片段不读整文件；大输出分批。
- 🟡 **write 前先 read**：覆盖已有文件必须先 read 过（fs-observation-policy）。
- 🟡 **edit 用唯一锚点**：old_string 精确匹配；多次出现时加上下文或 replace_all。
- 🟡 **改动前一句话说明**：占用时间 / 产生可见动作的操作，先说明"做什么、为什么、预计多久"。

> 🔴 行为纪律（隐私双区 / 等放行 / 收工 / 汇报节奏）以 `mind\L0\AGENTS.md` 为权威，本文件不重复。

## 三、与心智系统的关系

- 工具只是操作手段；"怎么做事"的规则在 `mind\L0\AGENTS.md`（权威），本文件补工具侧操作细则（从属）。
- 工具清单 / 参数以运行时 schema 为准；渐进披露（阶段解锁工具）由配置决定，不由本文件硬编码。
- 产物落心智：正式结论 → mind-private 对应层；轮级缓冲 → `mind-private\tasks\`；导入另一设备/agent 产物走 `import-artifact`（`mind\README.md` §五）。

## 四、本包**不随附** `scripts/` 工具链（🔴 2026-09-29 加）

⚠️ **本包（`dsh-mind`）只带机制层：9 个 host 插件 + 本固件。完整版（DSHOME）另有一整套 `scripts\*.mjs` 运维工具链，本包未随包分发。**

- **工具链缺件读数：32 个脚本 / 132 处命令引用**（机器读数；口径＝扫本固件全部 `.md` 里 `scripts\<名>.mjs|cjs|js` 形式的引用，**减去本包实有的那几支**——目前仅 `verify-dsh-mind-install.mjs` 1 处。全部引用实为 33 个 / 133 处。由 `test/selftest.mjs` ⑱ 校验：**固件新增或删除引用而此处没跟着改 ⇒ 门禁变红**）。
- 本包 `scripts\` 实有的 **4 个**全是会话错误排查工具（`read-session-error` / `scan-turn-errors` / `dump-around-error` / `verify-dsh-mind-install`），与上面那 32 个**零重叠**。
- **缺的是"执行件"，不是"规程"**：本节与 L1/L2 各处出现的 `node scripts\...` 命令，其**规则**仍是权威（怎么做、什么判据）；缺的只是"一键跑起来的那支脚本"。

| 规程里让你跑 | 缺的作用 | 装机后的等效做法 |
|---|---|---|
| `node scripts\mind-validate.mjs --strict` | 出厂固件校验器（frontmatter / 死链 / 版本行 / 出厂卫生） | 手工逐项核对；打包方另跑 |
| `node scripts\evolve-log.mjs snapshot / log / decide / trash` | 改前快照与进化台账 | **改前先复制原文件留档**；仓内用 `git diff` 当改动证据 |
| `node scripts\trash-sweep.mjs` / `snap-prune.mjs` / `memory-archive.mjs` | 回收站认定、快照裁剪、长节指针化 | 手工移入 `mind-private\tasks\` 下自建目录；**不物理删除**（只移只留痕） |
| `node scripts\mind-prime.mjs` | R1 召回装配器 | **不需要脚本**：本包已重写为 `lib\host\recall.js`，每会话自动注入 |
| `node scripts\mind-search-lib.cjs` / `search-regression.mjs` | 检索内核与回归门禁 | 本包 `lib\search.js` 是同一套 bigram 口径的最小实现 |
| `node scripts\skill-version.mjs --check` | 技能版本一致性 | 手工核对文件头/尾版本行 |
| `node scripts\shot.mjs`（视觉验收） | 一条命令拿渲染图 | 用宿主自带截图能力 |
| `node scripts\verify-*.mjs`（11 支） | 各面门禁 | 本包门禁＝`node test/selftest.mjs` + `node test/pre-step-waterfall.mjs` + `node scripts/verify-dsh-mind-install.mjs <profileDir>` |

- 🔴 **纪律（照抄禁令）**：见到本文档或 L1/L2 卡里出现 `node scripts\...` 时，**先按上表判本包有没有**——没有就**手工做等效动作，不要把命令照抄给用户**（照抄＝教人去跑不存在的文件）。
- **同一条约束也适用于另两类悬空引用**：① 指向 `packages\dshome\...`、`dshome-mind-*` 的路径/插件名——本包机制真源是 `lib\host\*.js`、插件名一律 `dsh-mind-*`；② 指向 `mind\L1\changelog-L0.md` / `changelog-L1.md` 的沿革台账——**本包未随这两个文件**（完整版才有；本包各件只保留"本版摘要"）。
- **本文件自身的沿革**亦按此办理：完整版的累积沿革在 `changelog-L1.md`，本包只有下面这条本版摘要。
