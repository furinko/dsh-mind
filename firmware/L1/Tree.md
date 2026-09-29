# Tree.md — 知识网络血管（全目录）

> 版本：1.50 | 2026-09-29 | **技能版本格同步**：concurrent-writers 1.0.5 · recall-tuning 1.1.4 · required-action-wiring 1.1.2 · prompt-surface-audit 1.0.4（四张卡「私有卡全库不存在」假结论订正）| 历史沿革见 mind\L1\changelog-L1.md
> 加载：按需层——上工由 R1 召回带层骨架速览；完整目录按需 read（查"X 在哪"→ 本文件定位 → grep/read 目标）
> 定位：L1 循环系统——全知识网络目录，AI 友好表格化。"有什么"的一键查询。

## 使用说明
每个 ## 段落对应一个层级/类别。查"X 在哪"→ 本文件定位 → grep/read 目标文件。
**本机运行时内容（L3 记忆/项目/Learn 条目）在 `mind-private\`，同名私有优先。**

## L0 — 基本指令集（mind\L0\，出厂固件）

| 文件 | 角色 | 修改规则 |
|---|---|---|
| SOUL.md | 身份锚点 + 价值观 + 决策规则 | 仅用户明确要求时修改 |
| AGENTS.md | 运行纪律 + 层级铁律（L0 权威版，`mind\L0\AGENTS.md`，由 `dshome-mind-inject` 注入；根版已退役） | 需确认后改 |
| TOOL.md | 工具操作指南 | 环境变化时更新 |
| CREW.md | 成员宪法：专项成员底线**单一真源**（`packages\dshome\lib\host\agent-roles.js` 运行时读盘拼进成员系统提示段 `deployment:persona-prefix`；L0 从属件，同 TOOL.md 档）| 改前快照 + `mind-validate`；**改文件即生效**（2026-09-28 批次 `crew-split` 新建）|

## L1 — 认知中枢（mind\L1\）

| 文件 | 比喻 | 职责 |
|---|---|---|
| HUB.md | 脑袋 | 设计理念 + 加载顺序 + 跨层红线 |
| Design-Philosophy.md | 灵魂之纲 | 生长哲学：自生长/绽放 + 唯一防毒底座（别自欺） |
| Wisdom.md | 大脑皮层 | 思维模式系统 + 元认知框架 |
| Tree.md | 血管 | 全知识网络目录（本文件） |
| Power.md | 功法 | 能力手册：Skill/Exp 使用教程 + 沉淀路径 + L2 格式 |
| Memory.md | 规则书 | L3 归档规则 |
| Invariants.md | 闸门 | 确定性内核：不可绕过的硬约束/门禁清单（🔴/🟡 不变式）——**按需 read**（不注入；原写"强制层加载"＝空头义务，2026-09-18 订正） |
| Concepts.md | 契约 | 概念注册表：todo/progress/suggestion/memory/skill 的**权威源** + 意图→概念→权威源路由表 |
| Dream.md | 灵感池 | 松散点子 |
| Learn.md | 痕迹库 | 🤗/💢教训（模板在 mind\，实际条目在 mind-private\L1\） |
| Ritual.md | 行为规程 | 收工闭环 / 自主维护 / 元进化 / 行为纪律细则 / 自省判据（AGENTS 细则的家，按需读） |
| changelog-L0.md | 旧档 | L0 宪法（SOUL/AGENTS）版本沿革全文归档——**不进注入**；L0 正文尾部只留本版一行（2026-09-23 注入瘦身） |
| changelog-L1.md | 旧档 | L1 规则件版本沿革全文归档——**不进注入**；L1 正文版本行只留「本版摘要 + 指针」（2026-09-28 主人点「方案②」起；本批 `l1-slim` 已把 L1 其余十件规则件（HUB/Wisdom/Tree/Power/Dream/Learn/Ritual/Invariants/Concepts/Design-Philosophy）+ `L0` 从属件 CREW/TOOL 的沿革整行移出，逐字节照抄 + 断言） |

## L2 — 能力层（mind\L2\）

### Skill 清单（方法论）
| 文件 | 版本 | 描述 | 触发关键词 |
|---|---|---|---|
| verify-integrity.md | 1.16.0 | 验证可信度四则：真加载 / 反例证伪 / 不污染被测对象 / 输入缺失即响亮失败（+5 配方：判别"线上跑的是不是新代码"、门禁探针零风险设计、调参类改动先离线扫参数矩阵、**评分/自评三件套**、**判据也是消费者**＝改形状/行为必须同批改判据 + 判活复刻用户路径 + 诊断打印先打码；**配方 ⑳**＝判据的参照物必须稳定——**环境一变假红 / 提交一次恒红**，判别力一律放夹具、真树真实读数只作 `[info]`、对照臂不依赖 `git HEAD` 相对位置）；**配方 ㉑**＝改"被机制读取"的正文/数据前先找到它的读者并量出口径（归档≠删，读者必须零感知）；配方 ⑳ 补第三种形态＝夹具 env 作用域要覆盖被测代码的**整个使用期**（调用期读 env 而夹具只钉加载期 ⇒ 假红甚至污染真数据） | 验证、自测、怎么确认生效、测试全绿、门禁可信、裁判本身、反例、评分、打分、判据过时、凭据泄漏 |
| import-artifact.md | 1.0.0 | 导入协议：其他设备/agent 产物即插即用 | import、导入、即插即用、artifact、蒸馏包 |
| boot-recall.md | 1.0.3 | 上工自动召回：project.md+L3+Learn+user-rules+人设卡 装配成注入上下文 | 上工、你想不起来、有什么待办、记忆召回 |
| dshome-diagnostics.md | 1.1.0 | DSHOME 诊断两层：进程层（崩/卡/闪断：先分真假+证据）+ agent 层（报错→源码链→会话日志取证四跳 + 离线端到端验证） | 后端重启、卡、exit1、闪断、本轮运行失败、报错文本、turn error |
| dshome-crash-recovery.md | 1.0.9 | DSHOME/DSH 崩溃排查+自愈：三层定位（装配期/运行期/前端半区）+ marker 定位崩溃插件 + **市场事件日志 `log.ndjson` 变更取证** + guard --recover/safe 逃生 + Failed to load plugins 四证核对 | 启动失败、起不来、崩溃循环、Failed to load plugins、半区加载失败、ERR_PACKAGE_PATH_NOT_EXPORTED |
| dshome-plugin-dev.md | 1.4.0 | DSHOME/DSH 结构与运行时 Cordis 插件开发：写码前先 `cordis_inspect` 读真实接口，纯 JS code.host/code.client，生命周期/修复/回滚；自有 host 插件落地**四处登记**（漏 exports = 启动崩）；安全模式 v3（覆盖层 L3+L4 并集、`--patch` 必须排在 app 参数之前）；打包缺 bundle + 包外脚本 require 实体化失效排查；变更取证看 `.dsh-market\log.ndjson` | 做/改插件、cordis、slot、`is not declared`、`host.call` 失败、启动崩溃、安全模式 |
| landing-audit.md | 1.0.0 | 落地审计三查法：查「文档说有 ≠ 机制真在跑 ≠ 数据真达标」（定义/接线/数据逐层查） | 审计、落地、三查、落到实处吗、纸面定义、空壳、接线 |
| scar-inference.md | 1.1.0 | 伤疤反推法/咬痕考古法：不蒸整体蒸版本差，不读架构图读咬痕 | 考古、蒸、版本差、反推坑、咬痕、伤疤、为什么在、作者画像、同源盲区 |
| required-action-wiring.md | 1.1.2 | 必需动作接线三判据：唯一权威落点 / 没跑就硬失败（不许 WARN 后 exit 0）/ 设备侧可自检（配套「回执≠产物」；判例：**端口回 200 ≠ 就绪**——近似判据会抢在初始化完成前放行消费者） | 静默失败、只 WARN、退出码 0、装了没生效、必须发生的动作、就绪判定、接线 |
| visual-verification.md | 1.1.0 | 视觉/UI 交付的验证法：先划呈现面，再读实测值（不猜 CSS），用渲染截图 + 放大镜 + 逐帧自看当验收；桩不解析 CSS ⇒ 全绿也可能是错的；补三条硬约束＝**"自己算位置/尺寸"的缓存键必须含全部影响输入**（漏一格＝永不更新且不报错）· **覆盖层靠 transform 进出 ⇒ 没有 resize 事件**，联动用语义属性观察器 + 过渡后补算（`prefers-reduced-motion` 下要定时兜底）· **审美判定先声明"印象分"**并给可自查判据清单 | 视觉交付、UI 不对、样式没生效、浮层关不掉、面板能滚、布局错位、响应式、动画不对、真看渲染、computed style、呈现面 |
| concurrent-writers.md | 1.0.5 | 多写者共享工作区的纪律：先盘点写者（"干净"≠"没别人"），共享配置单写者、并行走独立环境，台账 append-only，提交前复核 staged，善后先判谁覆盖了谁 | 并发、多写者、同时改、抢写、写冲突、共享工作区、单写者、互斥、串行、git 竞态、提交冲突、别人的改动 |
| recall-tuning.md | 1.1.4 | 记忆/知识「写得进却召不回」的调优法：先分三层（词面 / 阈值 vs 真命中分布 / 切块）再动排序量纲；验召回必须复刻真实上工路径（cwd/project），验收判据是「排第几」不是「命中没有」；改完跑回归集 | 召不回、召回不准、写进去却召不回、检索不到、搜不到、命中率、排序不对、top1、调参、阈值、minScore、切块、查重、回归基线、权重、蒸馏验收 |
| distillation.md | 1.0.1 | 蒸馏与压缩：把多份材料收成一份唯一态——蒸前读全文不读摘要、改唯一态不留副本、逐文件过压缩七形态（双写 / 双源 / 过时 / 无意义版本元数据 / 低信息密度 / 易过时数据 / 兑现后降级）；验收读「节点数不增、覆盖不减」而非体积，**条目只增不减 = 用堆规则掩盖路由缺陷** | 蒸馏、蒸、压缩、瘦身、精简、文档压缩、语义压缩、只增不减、节点数、包体、超线、归并、拆包、蒸馏验收、路由失效 |
| factory-hygiene.md | 1.0.1 | 出厂卫生自检（双区边界）：推送面以 **git 为准**（`ls-files --cached --others --exclude-standard`）→ 两道门禁 ⑨ 禁词表扫 + ⑩ 凭据/PII 形态扫 → 补门禁管不了的历史维 `git grep HEAD`；唯一划区判据＝"这段能贴在公开 GitHub 上吗"；红线定义指 `AGENTS §五` / `Invariants #13`（本卡不做第二份真相） | 出厂卫生、双区卫生、出厂区、私有区泄漏、私密泄漏、禁词、禁词表、凭据泄漏、私有名、盘符、脱敏、去私、隐私红线、公开仓库、推之前、能公开吗 |
| prompt-surface-audit.md | 1.0.4 | 注入面体检（每会话都带着的那一面）：先钉真身（注入器 / 文件 / 频次 / 活进程 marker）→ **真跑装配器**量分节字符账（R1 必带 `--cwd`，否则账本小一半）→ 逐条核「机制承诺」的引用真实性（脚本子命令 / HTTP **方法与参数位置** / 路径 / 交叉章节号 / 悬空指针）→ 判据「每行值不值得每个会话看到」→ 改高危区走快照+validate+版本门禁 → 验收四件（真跑长度 · 基线**人工**比对 · 新会话 marker · payload hash） | 注入面、提示词优化、出厂提示词、系统提示词、每会话注入、token 账本、瘦身、减注入、上下文预算、宪法改动 |
| delegation-brief.md | 1.0.1 | 派活任务书三件套（判据带反例面 / 闸门 / 不许自批）+ 派前先查卡线与既有分析 + 落笔前回权威源核口径 | 派活、派成员、子代理、任务书、委派、分工、验收成员、授权转授、派单 |

### Exp 清单（工具手册）
| 文件 | 版本 | 描述 | 触发关键词 |
|---|---|---|---|
| `mind-api-calls.md` | 1.0.2 | 用脚本直打心智 HTTP API（`/api/mind/*`）的三条硬口径：CSRF 头 `Sec-Fetch-Site: same-origin` · body 必须 **UTF-8 字节**（字符串 body 会把中文**静默**变 `?`、接口仍返 200） · 写完**回读校验**；附已实测路由形状 + 「`cron/run` 会真拉一个 agent」的边界（2026-09-24 由私有区**提升**、去敏改写为固定四章；1.0.2：补齐文件尾版本行、正文零改动；1.0.1：`cron/run` 改走串行闸 ⇒ 返回形状 `{ok,mode,…}` + 会话**会进**台账） | 打API · Invoke-RestMethod · api/mind · 心智API · 中文变问号 · body编码 · 回读校验 · CSRF · 403 |

## L3 — 记忆层（mind-private\L3\，隐私）

> 记忆层重构（2026-09-09）：三区 = `common\`（通用结晶）+ `projects\`（项目记忆）+ `history\`（归档）。检索隔离 = 物理目录（common 恒含 + projects\<当前>）。结构与规则详见 `mind\L1\Memory.md`。

### common — 通用结晶（跨项目可调取）
> 主题目录 = `mind-private\L3\common\<主题>\`；索引 = 各主题目录下的 `_index.md`。（2026-09-11 修：原文枚举「当前：user-rules / lessons」并称有 `common\_index.md` → 改为**只给结构、不枚举**，理由=出厂不登记本机运行时主题，同 §projects 隐私卫生。⚠️ 原注记另断「实测无 lessons 目录、该 index 不存在」已删：那是**对 `mind-private\L3\` 本机私有状态的实测结论**，而私有区按设备各自演化（每设备独立，见 `Concepts.md` V4），本机实测在别的设备不成立——出厂文件只写结构与机制，**不写依赖私有区的实测事实**（同 `Invariants` #13 出厂卫生）。）
### projects — 项目记忆（每项目一目录，上工加载）
> `mind-private\L3\projects\<项目>\`：导航 project.md + 记忆档案（按项目自维护，如 `<项目>记忆.md`）+ `知识\<主题>\` 项目结晶。
> 🔴 **出厂不登记任何项目条目**（51df701 隐私卫生：出厂只给结构、不枚举本机运行时条目——含本仓库 DSHOME 自身，它也只是私有区里的一个项目档案）。
### history 归档
> history = `mind-private\L3\history\`（时间胶囊，只写不改）。归档时 `YYYY-MM-DD_<标题>_归档.md` 命名，并登记到**该目录的 `_index.md`**。
> 🔴 **本文件不登记任何运行时条目**（含 history 有几个归档、TRASH 里有什么）：出厂只写结构与机制、**不写依赖私有区的实测事实**（每设备各自演化，本机读数在别的设备不成立）——同 §projects 隐私卫生与 `Invariants` #13。

## TRASH — 回收站（不删只移）

| 文件 | 原因 | 移入日期 |
|---|---|---|
| — | — | — |

> 🔴 **本表只列出厂结构，不登记本机 TRASH 条目**（运行时条目与其恢复坐标见 `mind-private\TRASH\_index.md`；同 §projects 隐私卫生）。

## 更新规则
- 出厂 L2 Skill/Exp 变更 → 同步更新本文件对应清单。
- 🔴 私有 L3 记忆（common/projects/history 运行时条目）→ **不进本文件**（本文件随 git 推公开仓库；运行时条目一律归 mind-private，51df701）。
- 版本号/关联变化 → 同步。
- 每轮收工（`Ritual.md` §一 9 步）**step5** 强制检查本文件同步。

---

_版本：1.50 | 2026-09-29 | 技能版本格同步：concurrent-writers 1.0.5 · recall-tuning 1.1.4 · required-action-wiring 1.1.2 · prompt-surface-audit 1.0.4（四张卡「私有卡全库不存在」假结论订正）；沿革（1.49 及更早）已整行归档 mind\L1\changelog-L1.md_
