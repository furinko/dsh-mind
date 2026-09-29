# HUB.md — 知识网络之心

> 版本：1.16 | 2026-09-28 | §三 订正记录里 Learn 读数订正 **末尾 4 条→3 条**（机制真值＝`mind-prime.mjs` 的 `slice(-3)` + 检索 2 条；同节正文早已是 3+2，只有这条订正记录还写 4——**订正记录自身也是引用面**）| 历史沿革见 mind\L1\changelog-L1.md
> 加载：按需层——维护/审计/新设备时读；不参与运行时注入（注入=R0 SOUL+AGENTS）
> 定位：L1 中枢——心智基座的设计理念、加载规则、跨层红线

## 一、我们为什么存在

mind 不是文件仓库。它是**被蒸馏过的逻辑结晶**——把"怎么想"和"怎么做"分离、归类、索引、版本化。

**存在价值：**
- 让每一次决策有据可查，不依赖"我记得"
- 让每一个技能可以跨项目复用，不被上下文遗忘
- 让每一个灵感有家可归，不在对话流里蒸发
- 让 DSHOME 不只是聊天工具，而是**能自我进化的认知系统**

## 二、架构层次

| 层 | 回答 | 内容 |
|---|---|---|
| L0 | 我是谁？怎么活？ | SOUL + AGENTS（宪法）· TOOL / CREW（从属参考——不注入；CREW＝成员底线，由 `agent-roles.js` 运行时读盘拼进成员系统提示段） |
| L1 | 能做什么？怎么做？怎么存？ | HUB + Wisdom + Tree + Power + Memory + Dream + Learn + Ritual + Invariants + Concepts + Design-Philosophy |
| L2 Skill | 某类问题怎么解决？ | 方法论——跨项目可复用的逻辑闭环 |
| L2 Exp | 这个工具/平台怎么用？有什么坑？ | 经验公式——方法论的实例 + 踩坑记录 |
| L3/common | 踩过的坑、做过的设计，去哪查？ | 通用结晶知识——踩坑沉淀 / 设计文档 / 速查表（跨项目） |
| L3/projects | 某项目专属的记忆与结晶在哪？ | 项目记忆之家——导航卡 + 记忆档案 + 知识\ 结晶 |
| L3/history | 被替代的、完结的，去了哪？ | 时间胶囊——里程碑 / 旧版归档（只写不改） |
| TRASH | 废弃的放哪？ | 不删只移，可恢复 |

**知识流动方向：**
```
讨论中产生的经验 → L2 Exp 踩坑 → 积累到阈值 → 记忆区结晶（L3/common 通用 / L3/projects\<项目>\知识 专属）→ 提炼成 L2 Skill → 旧版进 L3/history
任务工作 → 轮级缓冲（mind-private\tasks\pending\ 待放行 + Dream 灵感池）→ 收工闭环 → 蒸馏入记忆区（common/projects）
```

## 三、加载策略（三层）

### 注入层（R0 常驻，会话首步由宿主插件注入，随上下文携带）
`dshome-mind-inject` 运行时读 `mind\L0\SOUL.md`（人格宪法）+ `mind\L0\AGENTS.md`（运行宪法）**双件全文**注入（正文=唯一注入源，SOUL 先于 AGENTS 是契约）。

### 上工装配层（R1 常驻，由 `dshome-mind-recall` 调 `mind-prime` 装配——**不是"全文加载"**）
装的七件：`project.md`「进度状态」+「下一步」待办 + **L3 相关记忆 top-4**（`--limit` 默认 4；通用层保底 2 席）+ **`mind-private\L1\Learn.md` 末尾 3 条 + 按任务检索 2 条** + `user-rules` + 人设卡 + **`Tree.md`/`Power.md` 速览（头部差量）**。

### 按需层（本层**不注入、也不由上工装配**，用时 read）
`Memory` / `Invariants` / `Ritual` / `Concepts` / `Wisdom` / `Design-Philosophy` / `Dream`；L2 Skill/Exp（关键词触发）；L3 记忆区（common/projects/history）grep/read。

> ⚠️ **订正记录（2026-09-18，规则层订正批次 ② 高2① / 旧批 ⑤）**：本节原写「**强制层（每次上工必须加载）**：Tree + Power + **Memory** + Learn + **Invariants**」。核对机制：`mind-inject.js` 只注入 SOUL+AGENTS，`mind-prime.mjs` 只装配上面那六件，**`Memory.md`/`Invariants.md` 从未被任何装配代码读过**（grep 三处装配面 0 命中）⇒ 那是**无机制支撑的强制义务**，而 `Tree`/`Power`/`Learn` 也只是"速览/末尾 3 条"而非全文。按本仓已定方向（**规则口径不得比机制宽 ⇒ 收窄文本对齐机制**，不是扩机制）改为三档如实描述。同批：`Tree.md` 的 Invariants 行删「——强制层加载」。

## 四、跨层红线

1. **L0 是宪法** — **SOUL / AGENTS** 仅用户明确要求时修改；`TOOL.md` 与 `CREW.md` 层属 L0 但为**从属参考、非宪法级**（不注入、改它们不按宪法审批，依据 `TOOL.md`/`CREW.md` 首行 + `mind-guard.js` 高危名单不含它们；`CREW.md` 目前**无机器门禁、属纪律级**）。
2. **L1 是法律** — L1 文件定义规则，不对 L2/L3 具体内容负责。
3. **L2 是能力** — Skill/Exp 遵守 L1 规则，独立演化。
4. **L3 是记忆** — 遵守 Memory 规则，各自维护 `_index`。
5. **双区边界** — `mind\` 出厂可推送；`mind-private\` 隐私永不推送，同名私有优先。
6. **TRASH 不删只移** — 可恢复优先于永久删除。

## 五、L1 文件职责

| 文件 | 比喻 | 职责 |
|---|---|---|
| HUB.md | 脑袋 | 设计理念 + 加载顺序 + 跨层红线（本文件） |
| Design-Philosophy.md | 灵魂之纲 | 生长哲学：自生长 / 绽放 + 唯一防毒底座（别自欺） |
| Wisdom.md | 大脑皮层 | 思维模式系统 + 元认知框架 |
| Tree.md | 血管 | 全知识网络目录（"有什么"一键查询） |
| Power.md | 功法 | 能力手册：Skill/Exp 使用教程 + 沉淀路径 + L2 格式 |
| Memory.md | 规则书 | 记忆层（common/projects/history）归档规则 |
| Dream.md | 灵感池 | 松散点子 + 整理提醒 |
| Learn.md | 痕迹库 | 精炼教训（💢/🤗，≤200字/条） |
| Ritual.md | 行为规程 | 收工闭环 / 自主维护 / 元进化 / 行为纪律细则 / 自省判据（AGENTS 细则的家） |
| Invariants.md | 闸门 | 确定性内核：不可绕过的硬约束/门禁清单（🔴/🟡 不变式）——**按需 read**（不注入） |
| Concepts.md | 契约 | 概念注册表：todo/progress/suggestion/memory/skill 权威源 + 意图→概念→权威源路由表 |

---

_版本：1.16 | 2026-09-28 | §三 订正记录里 Learn 读数订正 4→3（对齐机制 `slice(-3)` + 检索 2 条）；沿革（1.15 及更早）已整行归档 `mind\L1\changelog-L1.md`_
