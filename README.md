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
  package.json                     dependencies: 三个组件包（link:，包内有效）
  src/                             八件基础设施实现（组件用相对路径引它）
  mind/                            出厂区：宪章 / 法律 / 编制 / 岗位卡 / 出厂能力库 / 默认值
  lib/actions.js                   动作表（内核组件用）
  scripts/verify-profile-install.mjs  安装自检（防「组件静默不装」）
  scripts/install-into-profile.mjs    一键装进 profile（幂等 + 装完自动验收）
  components/
    kernel/   dsh-mind-kernel      内核组件
    guard/    dsh-mind-guard       安全类组件
    board/    dsh-mind-board       看板组件（浏览器半区挂在这个包上）
```

| 组件 | 包 | 装什么 | 关掉它的后果 |
|---|---|---|---|
| **内核** | `dsh-mind-kernel` | 八件基础设施的对外两个面：`mind` 工具 · `/mind` 命令 · 工具范围闸 · 审计钩子 · 系统提示段 | 这张卡只剩空壳，所以别关 |
| **安全类** | `dsh-mind-guard` | 四道封闭探针 · 探针见红**定位**回滚目标（只定位入账＋告警升级主权者；运行态不自动改文件，装回由主权者经版本管理执行） · 条款级升级裁决（`mind_guard` 工具 · `/mind-guard` 命令） | 判定与记账照常，没有机制自检与升级运维 |
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

安装 = **四个包都写进 profile 的 `dependencies`**（`dsh-mind` + 三个组件包），
`dsh.profile.bundles` 里**只加 `dsh-mind`**。为什么是四行而不是一行，见 [安装](#安装)——
`link:` 不解析目标包的 `dependencies`，只写一行会得到「组件静默不装」。

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

外加上层机制：对象存储与版本回滚（[`src/store.js`](src/store.js)）、升级的条款级合并（[`src/upgrade.js`](src/upgrade.js)）、安全类探针与回滚目标定位（[`src/probes.js`](src/probes.js)：见红只定位入账并升级主权者，装回由主权者经版本管理执行）、复核与反趋同（[`src/review.js`](src/review.js)）、BM25 检索（[`src/retrieval.js`](src/retrieval.js)）。

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

**`mind` 工具**（模型用，全部动作走策略引擎——含只读面：`memory_query` / `bus_read` /
`capability_resolve` 也过判定并按「一次调用一条」记汇总审计，契约B 2026-10-09）：

```
status · workbench · policy_check
task_create · task_dispatch · task_start · task_submit · task_review · task_pending · task_resolve
memory_write · memory_query · memory_lineage · memory_lifecycle
capability_list · capability_resolve · capability_read · capability_publish
bus_send · bus_read · audit_tail · audit_verify
registry_list · registry_can · registry_assign · registry_seal · registry_revoke
upgrade_pending · review_zero · bus_unlock
```

命令面还多两个**专属动作**（工具 schema 里没有它们——模型没有这只手）：

```
/mind presence …                        → 改失联限制 / 响应期限（人用设置入口）
/mind sovereign_interaction             → 声明主权者在线（失联判定的事实源只能由人声明）
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

**装法（本机实测可行）**：把**四个包**都写进 profile 的 `dependencies`，`dsh.profile.bundles` 里
**只加 `dsh-mind`**，然后在 profile 目录里 `pnpm install`，再重启客户端。
（想省事就跳到下面的「一键装」——那段手工编辑已经固化成脚本，并自带验收闸。）

`<profileDir>/package.json`（本机是 `C:\Users\kuro\.dsh\profiles\desktop\package.json`，
只列与本插件相关的行，其余依赖照旧保留）：

```json
{
  "dependencies": {
    "dsh-mind": "link:E:/dsh-mind",
    "dsh-mind-kernel": "link:E:/dsh-mind/components/kernel",
    "dsh-mind-guard": "link:E:/dsh-mind/components/guard",
    "dsh-mind-board": "link:E:/dsh-mind/components/board"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "……其它 bundle 照旧……",
        "dsh-mind"
      ]
    }
  }
}
```

### 为什么必须写四行，而不是一行

- **`link:` 是纯符号链接协议，pnpm 不解析目标包的 `dependencies`。** 本包 `package.json` 里的
  `"dsh-mind-kernel": "link:./components/kernel"` 这种**相对 link** 因此**在 profile 层完全不生效**。
- **实测**：profile 里只写 `"dsh-mind": "link:E:/dsh-mind"` + bundles 加 `dsh-mind`，
  `pnpm install` 之后**三个组件包一个都没进 profile 的 `node_modules`**。
- 而 `cordis.patch.yml` 的 `insert` 三行是按 **profile 的 `node_modules`** 解析 `name` 的
  （profile 目录是 baseUrl 锚点）。解析不到就是**静默不装**：不报错、卡还在、组件没了——
  只有用到的时候才发现。所以组件依赖必须在 profile 层**再显式写一遍**。
- 试过 `"dsh-mind": "portal:E:/dsh-mind"`（想让 pnpm 顺带解析依赖）：该 pnpm 构建直接报
  `ERR_PNPM_SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER`，**不可用**。

### 为什么三个组件不能进 `dsh.profile.bundles`

`bundles` 是**插件卡的名单**：每条 = 一张卡 + 一层 patch。三个都写进去就变成**三张卡**，
而「组件」的定义恰恰是**那张卡下面的行**（一行一个包、一个独立开关）。
三个组件行的来源是 `dsh-mind` 自己的 `cordis.patch.yml`，不是 bundles——
bundles 里写 `dsh-mind` 一项就够。

### 一键装（推荐）：`scripts/install-into-profile.mjs`

```powershell
node E:\dsh-mind\scripts\install-into-profile.mjs %USERPROFILE%\.dsh\profiles\desktop
node E:\dsh-mind\scripts\install-into-profile.mjs %USERPROFILE%\.dsh\profiles\desktop --dry-run   # 只看要改什么
```

它做的事（**幂等**，可反复跑）：

1. 读 `<profileDir>/package.json`；
2. `dependencies` 补上四行（`link:` 指向本仓库与三个组件；写法已正确就不动，写法不对就改正并打印 `旧 → 新`）；
3. `dsh.profile.bundles` 确保有 `dsh-mind`，并确保三个组件**不在**其中（在就移除并明确告知——那是「三张卡」的错误形态）；
4. 有改动时**先备份**成同目录的 `package.json.bak-install-<时间戳>`，再写；
5. 在 `<profileDir>` 里跑 `pnpm install`。pnpm 探测顺序：`--pnpm` 参数 → 环境变量 `DSH_MIND_PNPM` / `DSH_PNPM`
   → PATH 上的 `pnpm` → 官方桌面客户端自带的 `resources/runtime/pnpm/bin/pnpm.mjs`（用当前 node 跑）。
   每个候选都**先试跑 `--version`**（探测到 ≠ 能用），第一个成功的胜出；
   全都探测不到就**明确报错**并给出可粘贴的手工命令，**不假装成功**；
6. 最后跑 `verify-profile-install.mjs <profileDir>` 当**验收闸**：自检非 0 ⇒ 本脚本也非 0。

硬边界：**不会**替你猜或创建 profile（无参数 / 不是 profile 目录 = exit 2）；
**不重启、不杀死、不启动任何客户端进程**——改完**需要你自己重启客户端**才生效。

### 装完必须自检（防「静默不装」）

```powershell
node E:\dsh-mind\scripts\verify-profile-install.mjs %USERPROFILE%\.dsh\profiles\desktop
```

逐条检查：profile 的四个依赖在不在 · `bundles` 是不是只写了 `dsh-mind` · 四个包在
`node_modules` 里解析得到吗 · `cordis.patch.yml` 的**三条 insert 行齐不齐**（少一行也红，缺哪一行点名）
且每条 `name` 解析得到吗 · 出厂区 `mind/` 必备目录件齐不齐。全过 exit 0，任一条红 exit 1 并逐条说明。
脚本自己也带反例测试：`node scripts/verify-profile-install.mjs --selftest`。

### `dsh plugin --profile desktop add …`：**实测它不会替本包装组件**

```powershell
dsh plugin --profile desktop add E:\dsh-mind     # 通用形式：add <本仓库路径>
```

它是 `pnpm add` 的**薄转发**（读官方 `@deepseek-ai/dsh` 的 `lib/plugin-*.js`：在 profile 目录里跑 pnpm，
再按「已装且声明 `dsh.bundle` 的依赖」重建 `bundles`）。**实测（隔离的临时 profile，desktop 全程未被碰）**：

```
$ DSH_HOME=C:\Users\kuro\.dsh node E:\DSHOME\node_modules\@deepseek-ai\dsh\lib\bin.js `
      plugin --profile zz-probe add E:\dsh-mind
dsh: initialized profile zz-probe at C:\Users\kuro\.dsh\profiles\zz-probe
dependencies:
+ dsh-mind link:E:/dsh-mind
Already up to date
Done in 425ms using pnpm v10.34.5          ← exit=0
```

它写出的 profile 只有**一行依赖**（`"dsh-mind": "link:E:/dsh-mind"`），装出来的 `node_modules` 里
`dsh-mind*` 相关的**只有 `dsh-mind` 一个，三个组件一个都没有** ⇒ 照它装就是**组件静默不装**。
另外两个实测事实：它会 `initialized profile`（**会替你创建 profile 目录**），
并给 `bundles` 加上 `@deepseek-ai/dsh-base`。

所以两条出路：

1. **用它装完，再手工补三行**（三个组件的 `link:` 依赖）——就是上面那份 `package.json` 片段；
2. **直接用一键脚本**（上一节），它把四行一次写好，并且装完自动验收。

装完是**一张卡**，三个组件是那张卡下面的三行，各有独立开关（关一行 = 那个包不进 roster，
它的工具 / 命令 / 界面一起消失）；每行的 `config` 是各组件自己的（如安全类那一行的 `开机自检`），
**不是**卡上的 `config.components`。运行时不 import 任何 `@deepseek-ai/*`，
因此不会被出厂包的解析规则挡住（`peerDependencies` 里的 `@deepseek-ai/dsh` 是 optional，只作版本声明）。

## 验证

```powershell
cd E:\dsh-mind
npm test                                             # preflight 门禁 + 内核用例 136 条
node components/board/test/client-harness.mjs        # 看板：307 条行为断言
node --test components/board/test/client.test.js     # 看板：6 条结构断言
```

数字口径（哪个脚本产出哪个数，本机实测 exit=0）：

| 数 | 产出者 | 怎么看 |
|---|---|---|
| **206** | `node --test "test/*.test.js"`（`npm test` 的后半段） | `ℹ tests 206` / `ℹ pass 206` / `ℹ fail 0` |
| **307** | `components/board/test/client-harness.mjs` 自己打印 | 末行 `client-harness: 307 条断言全部通过` |
| **6** | `node --test components/board/test/client.test.js` | `ℹ tests 6` / `ℹ pass 6` / `ℹ fail 0` |

这三个数会随断言增加而变——**以脚本自己的输出为准**（表里是写这份文档时的实测值）。

**这两个看板脚本在 `components/board/test/` 下**（不在根 `test/`）——
写成 `node test/client-harness.mjs` 会 MODULE_NOT_FOUND。

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
- **只读面也过判定，但档位是「记汇总」（契约B 2026-10-09）**：`memory.query` / `bus.read` /
  `capability.resolve` 的调用链带 subject 过 `policy.check`，放行**一次调用一条**审计——
  查询命中 50 条 ≠ 50 条审计。介入度调到「变更预审 / 逐条审批」时读面会被判 `confirm`：
  那是既有 tierRule 语义，收窄时未改动。
- **知识晋升先过披露机械检查（契约C 2026-10-09）**：`memory_lifecycle op=promote` 对
  标题+内容+标签 跑敏感模式（盘符/UNC 路径、`%环境变量%`、email、凭据词表），命中即拒；
  清单可在私有 `部署.json` 的 `披露敏感模式` 键整体覆盖（非法正则 = 引擎 fail-closed，不静默）。
  豁免参数 `披露豁免=true` **仅 Lead**（主权者也不在豁免面——裁决原文如此）；豁免与命中
  模式名一起进审计，但**不抄敏感原文**（抄进账本等于二次披露）。机械检查宁可误拦：
  被拦的内容走豁免或改写，不需要放宽默认清单。
- **记忆有完整血缘（契约A 2026-10-09，评审稿 §C2/§C8）**：条目带 `来源引用`（证据链，
  写入时存在性校验——悬空引用当场拒；`artifact-` 前缀本批不校验）与 `派生自`（推翻
  替换链，`overturn` 自动写、不可自报）。`memory_lineage` 查上下游闭包（≤3 层、环安全）；
  索引是纯投影，从账本重算，不另立真源。**物理删除三步化**：先给源记「待删除」、
  按血缘把下游（引用它的+派生自它的）逐条「隔离」（退出默认召回、粘性、`含失效: true`
  可拉回、口径单报 `隔离条目数`），再物理抹源——「删了源头、引用它的下游还顶着有效
  知识的面目」这个空窗从此关死。
- **披露拦截与显式关闭都留痕（契约C 骑手①② 2026-10-09）**：命中被拒记「披露拦截」
  （记汇总：主体+命中模式名，不抄原文）——拦截企图是安全信号；部署.json
  `披露敏感模式: []` 是主权者显式关闭这道闸——合法且生效，但引擎按状态迁移记一条
  告警档审计（持续关闭不刷屏，再关再喊），不许静默关闭。
