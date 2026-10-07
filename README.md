# dsh-mind · 心智 · 数字组织

《心智 · 数字组织设计 v1.5》的**可执行实现**。**一张插件卡，三个组件**。

> 设计文档是判据来源，插件是实现。对照表见 [DESIGN-MAP.md](DESIGN-MAP.md)——每一条硬规则都能指到具体文件与测试。

---

## 一张卡，三个组件

「组件」= 插件管理页里那张卡下面的**行**：每行一个独立包、一个独立开关、一个独立状态点。
所以本仓库是一个 **bundle 包 + 三个组件包**，profile 的 `dsh.profile.bundles` 里**只写 bundle**——
三个都写进去就变成三张卡，那就不再是「组件」而是三个插件了。

```
dsh-mind/                        ← 插件列表里的那张卡（不插自己的行）
  cordis.patch.yml                 insert 三行：内核 / 安全类 / 看板
  package.json                     dependencies: 三个组件包（link:）
  src/                             八件基础设施实现（组件用相对路径引它）
  mind/                            出厂区：宪章 / 法律 / 编制 / 岗位卡 / 出厂能力库 / 默认值
  lib/actions.js                   动作表（内核组件用）
  components/
    kernel/   dsh-mind-kernel      内核组件
    guard/    dsh-mind-guard       安全类组件
    board/    dsh-mind-board       看板组件（浏览器半区挂在这个包上）
```

| 组件 | 包 | 装什么 | 关掉它的后果 |
|---|---|---|---|
| **内核** | `dsh-mind-kernel` | 八件基础设施的对外两个面：`mind` 工具 · `/mind` 命令 · 工具范围闸 · 审计钩子 · 系统提示段 | 这张卡只剩空壳，所以别关 |
| **安全类** | `dsh-mind-guard` | 四道封闭探针 · 自动回滚 · 条款级升级裁决（`mind_guard` 工具 · `/mind-guard` 命令） | 判定与记账照常，没有机制自检与升级运维 |
| **看板** | `dsh-mind-board` | 主内容区独立面板 + 左侧边栏下方入口 | 组织照常跑，只是没有可视化 |

**浏览器半区为什么挂在看板包上**：一个包的 `dsh.client` 是包级的，只有被某一行引用的包才会进 roster。
把面板与入口放进看板包，**关掉看板那一行，整个包不进 roster，界面一起消失**——
这是「组件可单独启停」在实现上唯一干净的落点。

三条纪律写在代码里，也写在断言里：

1. **所有组件共用同一个 `Org`**（`src/runtime.js` 的键控缓存，键 = 私有区根 + 项目）。
   各持一份的话，探针检查的策略引擎可能不是内核正在用的那一个——那等于白测。
2. **动作面不重叠**。内核的 `mind` 与安全类的 `mind_guard` 各自枚举自己的动作；
   内核不在 schema 里列它做不到的事（给个空承诺比不装更糟）。
3. **主面不吞异常**。工具注册不上就等于组件没生效，必须让装载如实失败；
   只有次要面（命令、提示段）才降级为告警。吞掉主面只会得到一个「看起来装好了」的假象。

安装就是装这一个 bundle（三个组件包是它的依赖，会被装成**普通依赖**而不是 profile 层）：

```powershell
dsh plugin --profile desktop add %DSH_HOME%\plugins\dsh-mind
```

---

## 它实现了什么

八件基础设施，一件不缺：

| 件 | 实现 | 关键保证（可测） |
|---|---|---|
| 角色注册表 | [`src/registry.js`](src/registry.js) | 索引可从真源重算 · 封存 ≠ 删除 · 实例权限只来自岗位 |
| 共享工作台 | [`src/workbench.js`](src/workbench.js) | **无存储的纯投影**：`projectWorkbench` 是纯函数，磁盘上不留痕 |
| 任务图 | [`src/tasks.js`](src/tasks.js) | 判据必填 · 派发后冻结 · 待决项是节点状态 · 打回≥2 升级主权者 · **N 份独立答案按人留** |
| 消息总线 | [`src/bus.js`](src/bus.js) | 线程隔离 · 支持暂不投递 · 会审解锁需「全员已交」 |
| 策略引擎 | [`src/policy.js`](src/policy.js) | 唯一判定点 · fail-closed · 拒绝带可执行理由 · 只读标签不读路径 |
| 能力库 | [`src/capability.js`](src/capability.js) | 双区各一份 · 同名不合并 · 角色卡只存引用（单源） |
| 记忆服务 | [`src/memory.js`](src/memory.js) | 写入必带「谁记的 + 怎么知道的」 · 不许改写只能追加 |
| 审计日志 | [`src/audit.js`](src/audit.js) | 只增（链哈希可验篡改）· 写入无条件 · 不承担回滚 |

外加上层机制：对象存储与版本回滚（[`src/store.js`](src/store.js)）、升级的条款级合并（[`src/upgrade.js`](src/upgrade.js)）、安全类探针与自动回滚（[`src/probes.js`](src/probes.js)）、复核与反趋同（[`src/review.js`](src/review.js)）、BM25 检索（[`src/retrieval.js`](src/retrieval.js)）。

## 看板显示什么（以及为什么只显示这些）

设计没有给面板一份内容清单，只给了性质与边界。所以这块是**从约束推出来的**：

| 面板上的块 | 依据 |
|---|---|
| **待你决定**（首屏） | §7 唯一点名「工作台把它投影出来」的东西就是待决项；这里再并上打回升级 / 挂起 diff / 探针见红。每项附**该敲的命令**——§9 硬规则③「工作台只读」，所以给命令不给按钮 |
| **会审** | §10：独立答案（交卷前只有盲标，交齐才揭名）· 分歧清单 · 反例面 · 零分歧告警。**零分歧按异常呈现**，因为「全票一致 = 异常信号」 |
| **任务** | 投影的两个来源之一（§7「能从任务图 + 日志重算」）：判据 / 冻结 / 打回次数 / 产物引用 / 交卷进度 |
| **审计尾** | 另一个来源；事实记录，不是讨论 |
| **状态条** | 闸 / 介入度 / 失联 / 探针——取**已有记录**（探针取最近一次快照），不现场重跑 |

**刻意不显示**：八件基础设施的计数（系统元数据，不是当前状态，且与 `mind status` 重复）、
主干环路 stepper（§8 的环路是流程定义，画成常驻进度条永远停在某一格）。
两者都曾经在面板上，已删。

## 载体：两区

```
<插件包>/mind/                          ← 出厂区（只读模板，随产品更新）
  ├─ 集体L0-宪章/宪章.md
  ├─ 集体L1-法律/{协作协议,权限矩阵,裁决流程,审计要求}.md
  ├─ 集体L2-集体结构/编制.md
  ├─ 集体L2-共享基础设施/{能力库/,defaults/,README.md}
  └─ 集体L3-成员角色卡/{_模板,复核员,插件工程,文档整理,记忆整理}.md

$DSH_HOME/mind-data/mind-private/       ← 私有区（首次启动自动引导）
  ├─ 集体L0-宪章/ 集体L1-法律/ 集体L2-集体结构/ 集体L3-成员角色卡/   ← 你的叠加层
  ├─ 集体L2-共享基础设施/{角色注册表,任务图/<项目>,消息总线/<项目>,
  │                       能力库,记忆服务/{跨项目,<项目>},审计日志,defaults}
  ├─ 身份档案/identity.json
  ├─ 升级/{基线.json,挂起/,探针快照/}
  └─ 版本历史/<对象id>/<版本>.md
```

出厂区是**只读模板**，私有区是你的**叠加层**，生效内容是**条款级合并的结果**（§5）。
判定授权只读标签，不读路径（§4）——所以两个区的同一条目录可以放心同构。

## 用法

装进 profile 后（见下），模型侧多出一个工具，界面侧多一页看板。

**`/mind` 命令**（人用，零 token）：

```
/mind                       → 工作台投影（看板用的同一份 JSON）
/mind status                → 组织自述：闸灯 / 失联 / 探针 / 规模
/mind audit                 → 审计尾
/mind can 实例=member-a      → 这个身份能碰什么
```

**`mind` 工具**（模型用，全部动作走策略引擎）：

```
status · workbench · policy_check
task_create · task_dispatch · task_start · task_submit · task_review · task_pending · task_resolve
memory_write · memory_query · memory_lifecycle
capability_list · capability_resolve · capability_read · capability_publish
bus_send · bus_read · audit_tail · audit_verify
registry_list · registry_can · registry_assign · registry_seal · registry_revoke
upgrade_pending · review_zero · sovereign_interaction
```

安全类组件另有一个 `mind_guard` 工具（关掉该组件时它不存在）：

```
probe_run · probe_health · probe_rollback
upgrade_compare · upgrade_resolve · upgrade_withdraw
```

被拒绝时结果长这样，照着改就行（§9「拒绝必须带可执行理由」）：

```json
{ "成功": false, "结果": "拒绝",
  "规则": "宪章 §3.4 组织给自己发合格证",
  "理由": "提案者不得自批：本次提案人与批准人是同一个主体。",
  "要什么授权": "宪章", "怎么改": "换一个未参与提案的主体批准（复核者或主权者）。" }
```

## 安装

```powershell
dsh plugin --profile desktop add %DSH_HOME%\plugins\dsh-mind
```

装完是**一行**；组件的启停写在那一行的 `config.components` 里（见上）。
或手工把包加进 profile 的 `dependencies`（`link:` 指向本目录）与 `dsh.profile.bundles`，然后重启。
本插件**零依赖**：不 import 任何 `@deepseek-ai/*`，因此不会被出厂包的解析规则挡住。

## 验证

```powershell
cd %DSH_HOME%\plugins\dsh-mind
npm test                       # preflight 门禁 + 101 条用例（组件 / 策略 / 流程 / 安全 / 对象 / 宿主）
node test/client-harness.mjs   # 看板：104 条行为断言
node --test test/client.test.js # 看板：5 条结构断言
```

`preflight` 是门禁：出厂件结构、岗位卡的能力引用、**组件名册与装载行配置对得上**、
清单里每个被引用的路径都在 `exports` 里、`client.js` 的经典脚本约束、
全部内核与组件模块可加载、出厂件不含用户特定信息。任一项失败即拒绝交付。

## 设计上刻意保留的取舍

- **失联从第一次交互起算**：全新部署由「启动」本身记为第一次交互；否则自治档从第一天就被冻住。
- **`复核者` 的只读边界属法律档**：它写在 `权限矩阵.md` 的默认文本里，主权者改法即可调整；
  但「不自批」「不删除」「身份核心锁定」属宪章不变式，任何法律都翻不动。
- **检索的证据门槛**：CJK 单字会让几乎任何查询都「命中」点什么，于是 0 命中永不出现。
  因此含双字词或拉丁词的查询必须至少命中一个同级词——这是精度修复，不是排序偏好。
- **工具范围闸用 `tools.guard()` 而非 `tools/pre-execute`**：前者单调，后来的监听者翻不回放行（§12.1）。
- **组件的主面不吞异常**：工具注册不上就等于组件没生效，必须让名册如实写「未装载」；
  只有次要面（命令、提示段）才降级为告警。吞掉主面只会得到一个「看起来装好了」的假象。
