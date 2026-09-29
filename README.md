# dsh-mind

> 给 DeepSeek Harness 的**一套可移植的心智**：宪法注入、上工召回、写前护栏、技能触发，
> 外加一份**出厂固件**——首启自动落地，之后由你自己养。

**版本**：0.1.0 ｜ **兼容**：`@deepseek-ai/dsh` ≥ 0.1.5-rc.2（在 0.1.5-rc.2 实测通过）
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

**不含**：界面面板、定时任务、主题皮肤、命令面板 —— 那些要么官方已有（见下），要么不属于"心智"。

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

## 自检

```bash
node test/selftest.mjs                            # 83 项（含 28 条反例）
node scripts/verify-dsh-mind-install.mjs <profileDir>   # 13 项真装验收
```

**写不出反例＝没验过** —— 每条断言都配了能把它变红的坏输入。

---

## 文档

- **`docs/DESIGN.md`** —— **设计决策**（为什么这么做）。改设计前先读它：十条决策各对应一个具体的坑或一次实测。
- 代码里的关键约束都带"别回退"注释，指回 `DESIGN.md`。

---

## 边界（诚实标注）

- **护栏不是防伪机制**：它只比批准记录的来源标注，本机进程可绕过。**这道闸靠纪律，不靠机器强校验**。
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
