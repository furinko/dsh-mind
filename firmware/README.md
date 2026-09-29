# mind — 心智基座（出厂版）

> DSHOME 智能体（DSHOME）的 L0-L3 四阶知识系统，参考**外部参照引擎**的 CCBP 架构 + 轮级缓冲设计 + dsh-evolve 自动化理念重构。
> 本目录 = **出厂固件**（架构 + 默认内容），可推送 GitHub。运行时自进化数据在 `$DSH_HOME\mind-private\`（仓库同级 `mind-private\`，gitignore，永不上传）。

## 一、四阶架构

| 层 | 回答 | 内容 |
|---|---|---|
| L0 | 我是谁？怎么活？ | SOUL（人格）+ AGENTS（纪律）+ TOOL（工具）+ CREW（成员底线·**从属参考、非宪法级**；L0 四件，见 `L1\Tree.md`） |
| L1 | 能做什么？怎么做？怎么存？ | HUB（中枢·运行时总纲）+ Wisdom（思维）+ Tree（索引）+ Power（能力手册）+ Memory（归档规则）+ Learn（痕迹）+ Dream（灵感）+ Ritual（行为规程）+ Invariants（确定性内核）+ Concepts（契约）+ Design-Philosophy（生长哲学） |
| L2 | 某类问题怎么解决？ | Skill（方法论）+ Exp（工具手册） |
| L3 | 踩过的坑去哪查？被替代的去了哪？ | `common`（通用结晶）+ `projects`（项目记忆 + `知识\<主题>\`）+ `history`（时间胶囊）——三区**物理隔离**，见 `L1\Memory.md` §一/§十 |
| L3\projects | 现在在做什么？ | 项目记忆层：导航 `project.md` + 记忆档案 + `知识\<主题>\`（**原顶层 `Project\` 层已于 2026-09-09 并入 `L3\`**，见 `L1\Memory.md` §四） |
| TRASH | 废弃的放哪？ | 不删只移，可恢复 |

## 二、三层加载模型

> 完整加载策略（**注入层 R0 / 上工装配层 R1 / 按需层** 各含哪些文件）的**权威在 `mind\L1\HUB.md` §三**。此处仅速览：

```
注入层（R0）：dshome-mind-inject 运行时读 `mind\L0\SOUL.md` + `AGENTS.md` 全文注入（人格宪法+运行宪法，正文=注入源，无手写副本）｜ 上工装配层（R1）：dshome-mind-recall 调 `mind-prime` 装**七件**——`project.md`「进度状态」+「下一步」待办 + **L3 相关记忆 top-4** + `mind-private\L1\Learn.md` **末尾 3 条 + 按任务检索 2 条** + `user-rules` + 人设卡 + `Tree.md`/`Power.md` **速览** ｜ 按需层：`Memory` / `Invariants` / `Ritual` / `Concepts` / `Wisdom` / `Design-Philosophy` / `Dream` + L2/L3 按需 read（**原写「强制层（R2 触发）：Tree/Power/Memory/Learn/Invariants」是空头义务——`Memory`/`Invariants` 从不在装配面**，2026-09-18 按机制订正）
```

## 三、怎么用私密区（本机，一句话）

- **要记关于你/本机的事、存偏好、建人设卡** → 放 `mind-private\`（本机，gitignore 永不推）。
- **要人设演绎** → 在 `mind-private\L0\` 建你的**人设卡**（不建就是干净通用智能体）。
- 出厂 `mind\` 是通用逻辑，**别把私密写这**（会推出去）。
- **用就是了，不用先懂双区架构**——真要存私密/加人设时，Assistant/护栏会指点你放哪。

## 四、文件格式规范（frontmatter）

所有 L2 Skill/Exp 与 L3 记忆文件带头部元数据（机器可识别，支撑导入协议）：

> ⚠️ **完整规范以 `mind\L1\Power.md` §四 为准**（本处只给形状，别当第二份真源）。**`contract` 是 L2 必填**——`triggers` 就是**机器触发来源**（skill-loader 按 `contract.triggers` 匹配），**漏了 `contract` 的 Skill 永远不会被触发**（2026-09-28 校正：原模板缺该块）。

```yaml
---
name: 条目名
description: 一句话摘要
version: 1.0.0
author: 来源（DSHOME / 其他设备 / 导入）
license: internal | MIT
contract:
  id: 技能id
  triggers: [触发该技能的关键词]   # 机器触发来源（加载器按此匹配）
  inputs: 输入
  outputs: 输出
  deps: 依赖
metadata:
  tags: [关键词触发]
  related: [关联的 skill/记忆/文档]   # 知识网络链路
---
```

## 五、导入协议（即插即用）

其他设备/agent 产物"直接丢给智能体"→ 识别（frontmatter/结构）→ 校验（版本/死链）→ 归类放置（mind-private\）→ 更新索引 → git checkpoint → 汇报。详见 `mind-private\L1\` 导入规则与 import-artifact 技能。

## 六、知识流动方向

```
讨论经验 → L2 Exp 踩坑 → 阈值触发 → 记忆区结晶（common 通用 / projects\<项目>\知识 专属）→ 提炼成 L2 Skill → 旧版进 L3/history
任务工作 → 轮级缓冲（mind-private\tasks\pending\ 待放行 + Dream 灵感池）→ 收工闭环 → 蒸馏入记忆区（common/projects）
```
