# Concepts.md — 心智概念注册表（L1 契约）

> 版本：1.10 | 2026-09-28 | 本批 `l1-slim`：加载档位「按需（查询层）」→**按需层**（消别名，与 HUB §三 三档一致）
> 定位：这是"某一概念的**权威源/入口在哪**"的**挂号处**。系统要查询/流转一个概念，只在本表查一次；
> 加载：按需层（L1 参考文档）——概念权威源/路由表，按需查
> 其他文档（AGENTS.md、Skill、记忆）**引用本表**，**不得各自重复定义**同一概念的权威源。
> 依据唯一 / 索引一致 / 可判定行为能被约束 —— 本表是前两条的"语义挂号处"。

## 概念注册表

| 概念 | 权威源 | 关系（它回答什么） | 接口 | 机器可读薄字段（开放标签，不设死枚举） |
|---|---|---|---|---|
| todo | `mind-private\L3\projects\<项目>\project.md`「下一步」（**体系主线档**；key＝本机仓库目录名） | 需要/要求/该做/计划 | `/api/mind/todos` 读写 | status / priority / source / promotedFrom |
| progress | `mind-private\L3\projects\<项目>\project.md`「进度状态」（同主线档） | 现状/阶段/到哪一步 | `/api/mind/read`?zone=private（读 project.md）或 mind-prime | phase / health / updated |
| suggestion | 待裁决的"动作/修改/评估产出"（`mind-private\tasks\approvals.json`——guard 护栏写入 + 面板裁决） | 建议/可改/改进点/需放行的动作 | 经护栏面板 ✓/✗ 裁决〔⚠️ **本包无面板、无放行通道**——见下方实况标注〕 | 薄字段（开放标签）：id / kind(action·edit·delete) / path / op / reason / status(pending·approved) / requestedAt / decidedAt / decidedBy |
| memory | 记忆层三区：`L3\common\<主题>\`（通用）+ `L3\projects\<项目>\知识\<主题>\`（专属）+ 各目录 `_index` | 教训/偏好/跨会话记忆 | `/api/mind/search` + `/api/mind/dup-check` | kind / importance / scope / topic / project / tags |
| skill | `mind\L2\Skill\<id>.md` + `_index` | 怎么做/能力/流程/积木 | 关键词触发加载 | name / version / triggers / inputs / outputs |

> 📌 **todo/progress 权威源 = 体系主线档（跨设备语义）**：`mind-private\L3\projects\<项目>\project.md`（**key＝本机仓库目录名**）是**心智体系自身**的运行档
> （每台设备的智能体都维护同语义的一份：记录心智本体的进度/待办），**不是**任何本机业务项目档。
> 用户业务项目（各自独立目录，key＝该业务项目目录名）在 `L3\projects\<项目>\project.md`，**不入 todo API**。
> **新设备首启自举（B3 闭环 2026-09-05）**：`mind-prime` 上工召回时若无 `mind-private\L3\projects\<项目>\project.md` → **当场按 `mind\L1\Memory.md` §四 模板初始化一份**（含「进度状态」表 + 「下一步」`- [ ]` 列表，标题不带序号前缀），再装配——不等收工（收工 step1 假定档已存在，鸡生蛋由此解开）；mind-prime 无档时目前容错返回空，初始化动作由智能体在首会话开场补做。
> **跨设备立场（V4 2026-09-05）**：主线档**每设备独立演化、不跨设备自动同步**——出厂区（mind\）经 git 多设备同步（规则/技能/本文）；私有区（mind-private\）有意本机私有（gitignore），各设备的心智进度/待办各自为政（上班的公司机 vs 家里的个人机进度不同是**设计预期**，不是 bug）。心智本体跨设备延续靠"任务带走/结论蒸馏后 git 同步出厂规则"，不靠主线档合并；**不做双机主线档 diff/合并机制**（业务项目档同）。

> 📌 **suggestion 权威源 = 动作放行记录（实况对齐 2026-09-05）**：suggestion 概念落地为护栏的动作放行机制
> （完整版为 `dshome-mind-guard` 插件）——它**不是**抽象的"建议流"，而是**真实在跑的裁决闭环**：
>
> ⚠️ **本包实况（2026-09-29 加，防"规则比机制宽"）**：本包（`dsh-mind`）的护栏是 `lib/host/guard.js`，
> **只有"拦"、没有放行通道**——不写也不读 `approvals.json`、没有面板、不接上游 `approval` 服务。
> ⇒ 本包里 **suggestion 概念没有落地机制**：下面这套"产生→裁决→消费"属完整版；本包遇到高危拦截即终局拒绝，
> 按 `Ritual §四` 的「本包护栏能力边界」处置（停下说明，等主人放行后由主人动手）。
> 同理，`/api/mind/*` 那几条写接口也**不在本包**（面板属完整版，本包按 `docs\DESIGN.md §一` 有意不做）。
> - **产生**：改"自我类高危文件"（L0 纪律 / L1 规则）时护栏真拦 → 写一条 `approvals.json` 待裁决（kind=action，status=pending，含 path/op/reason 摘要）；
> - **裁决**：用户在「心智 → 动作放行」面板 ✓ 放行（→approved）或 ✗ 拒绝（不入 TRASH——被拦的本就是未落盘改动，拒绝即不落盘）；
> - **消费**：放行记录**一次性**，且**写成功之后才消费**——命中只是拿到额度（记入 in-flight），`tools/post-execute` 报成功才删 ⇒ **写失败不消费**、额度不丢（2026-09-12 修，原文「命中即删」已过时）；下次改同文件需重新裁决（不永久放行）；
> - **产出类建议**（评估/审计/巡检发现）不走此机制：直接汇报用户，用户口头裁决——不入 approvals。
> 机器可读薄字段即 approvals.json 条目字段（id/kind/path/op/reason/status/requestedAt/decidedAt/decidedBy）；不再使用 candidate/accepted/rejected/deferred 虚字段（原理想状态机无实现，废弃）。

## 意图 → 概念 → 权威源（路由表）

| 意图（我想…） | 概念 | 去哪里（权威源 / 入口） |
|---|---|---|
| 下一步 / 该做什么 / 有什么待办 | todo | 体系主线档「下一步」→ 经 `/api/mind/todos` 读写 |
| 到哪一步 / 进度 / 项目状态 | progress | 体系主线档「进度状态」 |
| 建议 / 可改 / 改进点 / 需放行动作 | suggestion | 动作放行面板（approvals.json）→ 用户 ✓ 放行 / ✗ 拒绝；**写成功之后才消费**（命中只是拿到额度；一次性、不永久放行）。**评估 / 审计 / 巡检发现 → 直接汇报用户、用户口头裁决——不入 approvals（见上方"产出类建议"）** |
| 教训 / 偏好 / 记忆 / 上次怎么做 | memory | `/api/mind/search?q=` 模糊召回 → `mind-private\L3\`（common+projects）grep 深读；写前 `/api/mind/dup-check` |
| 怎么做 / 技能 / 能力 / 流程 / 积木 | skill | `mind\L2\Skill\` + `_index.md`（关键词触发加载） |

## 撞名消歧表（歧义词 → 先钉身份再动手）

> 用途：一个词命中多个候选对象时，**先钉身份再动手**，不裸词乱搜/乱答。
> 加载：召回/装配/搜索前，query 命中本表歧义词 → 返回候选并提示"指哪个"。
> 机器可读约定：每行 `| 歧义词 | 候选对象（分号分隔） | 判定线索 |`；第 2 列空 = 无歧义不登记。
> 增补规则：新增歧义场景 → 在此登记（候选对象必须是 Concepts/权威源体系内已有对象）。

| 歧义词 | 候选对象 | 判定线索 |
|---|---|---|
| `DSHOME` | 产品/仓库；心智系统（mind+mind-private）；心智图谱面板 | 改代码/构建/打包 → 产品仓库；规则/记忆/召回/进化 → 心智系统；打开图谱/节点 → 面板 |
| `mind` | 心智基座目录（mind\）；心智系统整体；心智 API（/api/mind） | 看路径前缀：mind\\ → 目录；谈记忆/规则/召回 → 系统；curl /api/mind → API |
| `心智` | 心智系统整体；心智图谱面板 | 谈运行/记忆/规则 → 系统；谈图谱/可视化 → 面板 |
| `记忆` | L3 记忆权威源（memory 概念）；通用意义的"记住" | 谈条目/主题/溯源 → 权威源；日常"记住这事" → 非概念（不路由） |
| `技能` | L2 Skill 权威源（skill 概念）；DSH skills 目录机制 | 谈方法论/流程/积木 → 权威源；谈 dsh 工具集/插件 → skills 目录 |

## 使用规则

- **依据唯一**：判断某概念的权威源/入口，只在本表查一次；其它文档引用本表，不重复定义。
- **薄契约 + 开放正文**：只把"系统要判断/查询/流转"的字段结构化；`status` / `priority` 等用**开放标签，不设死枚举**；正文自由。
- **改契约流程**：增删概念 / 调整权威源属"自我类文件"改动 → 走 `AGENTS.md` §四 硬流程：**用户放行 → 快照 → `mind-validate.mjs` 通过 → 失败回滚**。

---

_版本：1.10 | 2026-09-28 | 本批 `l1-slim`：加载档位统一「按需层」；沿革（1.7 及更早）已整行归档 `mind\L1\changelog-L1.md`_
