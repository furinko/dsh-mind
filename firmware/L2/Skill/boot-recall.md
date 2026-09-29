---
name: boot-recall
description: 上工自动召回——会话/任务开始时把 project.md + L3 相关记忆 + Learn + user-rules + 人设卡 装配成注入上下文。触发：每次会话/任务开始（上工）、"我忘了/你想起来/有什么待办"。
version: 1.0.3
author: DSHOME
license: internal
metadata:
  tags: [boot, recall, 召回, 上工, 记忆, 待办]
  related: [scripts/mind-prime.mjs, mind-private/, mind/L1/Tree.md]
contract:
  id: boot-recall
  triggers: [上工, 会话开始, 你想起来了, 有什么待办, 我忘了]
  inputs: [项目/任务关键词]
  outputs: [注入上下文（进度+待办+相关 L3+教训+用户偏好+人设卡）, 一次 refresh/update]
  deps: [scripts/mind-prime.mjs, mind-private/]
---

# boot-recall — 上工自动召回（boot recall）

## 一、使用流程

**主会话已机器自动**：宿主插件 `dshome-mind-recall` 会在每主会话首步自动注入 mind-prime 产物（顶层会话、幂等、cron/子代理跳过、空机降级）——**无需手动跑**。本 skill 用于：机器未注入时的兜底、换项目/刷新召回、诊断召回问题。

1. 确定当前项目/任务关键词（默认 `DSHOME 心智`；换项目则传对应词）。
2. 手动兜底召回：`node scripts/mind-prime.mjs "<项目/任务>"` —— 输出可注入上下文（project.md 进度+下一步、相关 L3 记忆 top-N、最近教训、用户偏好、**人设卡**）。**R0 宪法（`mind\L0\SOUL.md` 人格 + `AGENTS.md` 运行）由宿主插件 `dshome-mind-inject` 运行时读双件全文注入（正文=注入源，本脚本不重复生成）；主会话自动召回由 `dshome-mind-recall` 插件注入（依据唯一）。**
3. 把这段上下文**纳入思考**（作为初始上下文），再进入用户问题。
4. 需要刷新时重跑（`--json` 可结构化，供 build 后注入）。

## 二、核心规则

- 🔴 **召回必须发生**：主会话首步由 `dshome-mind-recall` 机器注入；若发现未注入（旧宿主/插件停用）→ 手动跑 `mind-prime` 兜底。**别等用户写报告/附件来补记忆**。
- 🔴 **走确定性脚本**：不靠"我记得该搜哪"，由 `scripts/mind-prime.mjs` 机械装配（机器注入与手动跑同源）。
- 🟡 **查询词选准**：默认项目主线关键词；跨项目时用任务/主题关键词，否则召回会偏。
- 🟡 **注入量克制**：默认 top-N（可 `--limit` 调）+ 进度表 + 待办前 8；太长的按需再 grep 深读。
- 🟡 **问答后回写**：如果发现知识缺失/新结论 → 走蒸馏闭环（Skill/Exp/L3），让下次召回更准。

## 三、行为准则

- 召回是"接住上下文"，不是替代思考：注入后仍要对着用户问题做判断。
- 召回命中弱不代表没有 —— 阈值 0.03 较宽，保召回；精度不足再 grep 深读。
- 隐私：`mind-prime` 只读 `mind-private\`（本机），产出不进出厂区。

## 四、踩坑记录

- 忘了上工召回 → 像这次"待办猜错源"，靠用户写报告；`mind-prime` 就是防这个。
- `related` 死链 → `mind-validate.mjs` 会拦（改记忆前先跑它）。
- 查询词太窄 → 召回空；换主题词或默认主线词。

## 五、关联索引

- **L1**：`mind\L1\Ritual.md` §四（行为纪律）· `mind\L1\Tree.md`（索引）· `mind\L1\Invariants.md`（确定性内核）
- **脚本**：`scripts/mind-prime.mjs`（回召）· `scripts/mind-validate.mjs`（自写校验/事务门禁验证一半）
- **L3**：`mind-private\`（本机私有：项目待办/进度、L3 记忆、教训、用户规则、**人设卡**）——由 `scripts/mind-prime.mjs` 动态读取并容错（不存在则跳过）；具体文件清单不在此罗列（见 `mind\L1\Tree.md` 主题级索引）。

---
_版本：1.0.3 | 2026-09-06 | outputs/正文对齐注入层 v2.5：L0 纪律改「AGENTS.md 全文注入（正文=注入源）」，去掉过时的「L0/HUB/Wisdom 决策规则摘要」描述；余同 1.0.2_
