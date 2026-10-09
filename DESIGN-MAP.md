# 设计条款 → 实现 对照表

> 用途：拿《心智 · 数字组织设计 v1.5》逐条核对实现。**每条都由测试兜底**，测试文件名在最后一列。
> 判据：设计里写明「必须保证 / 永不 / 不许」的，这里都必须有一行，且那一行必须能跑到。

## §2 主体

| 设计 | 实现 | 测试 |
|---|---|---|
| 主权者 / 出厂作者 / Lead / 成员 / 复核者 五类主体 | `SUBJECT_KINDS`（`src/policy.js`） | policy：未知主体 |
| 复核者由主权者确认（Lead 可提名） | `review.nominate` / `review.appoint`（`src/review.js`） | — |
| 复核者只读数，不改，不参与提案 | 法律档规则（`src/policy.js` `#tierRule`） | policy：复核者只读数 |
| 复核者跑命令限只读白名单；有副作用默认拒绝 | `ReviewProtocol.readonlyCommand`（`src/review.js`） | — |
| 落盘实验走沙箱区，任务结束即清、全程入账 | `review.sandboxExperiment`（`src/review.js`） | policy：复核者 sandbox |
| 复核者能力/经验存私有区独立命名空间，被验方不可读 | `layout.roleCardDir('自治')` + 成员切片（`src/workbench.js`） | safety：成员只读一片 |
| 知识挂岗位，不挂实例 | 角色卡 `个体L2` 只存能力引用（`src/capability.js` `referencesFor`） | objects：岗位→能力引用 |

## §3 约束（永不）

| 设计 | 实现 | 测试 |
|---|---|---|
| ① 实例知识默认外流 → 不出厂 | 自治能力库只写私有区（`src/capability.js` `publish`） | objects：能力库双区 |
| ② 未经主权者的删除 / 发布 / 批量覆盖 | 宪章不变式（`src/policy.js` `#invariants`） | policy：未经主权者的删除 |
| ③ 出厂件不含任何用户特定信息 | 「出厂件洁净」探针 + preflight 门禁 | safety：探针全绿 |
| ④ 组织给自己发合格证（提案者不得自批） | 宪章不变式 `approve` + `proposerId` | policy：提案者不得自批 |
| ⑤ 成员自扩权 / 再起成员 | 宪章不变式（建卡/派活/提案/自批） | policy：成员不得自扩权 |
| ⑥ 安全闸静默失败 | 全部故障走 `Fault` → `alarm: true` + 审计告警 | policy：fail-closed；safety：闸不在位见红 |
| 不可逆资源：已发布版本 / 审计日志 / 待决项记录 | `AuditLog.clearQueue` 把清掉的项写进账本 | safety：队列清空不入消失 |
| 队列可清空，记录不可逆 | 同上 | safety：清空队列 |
| 只增账目主权者也不能改 | 宪章不变式 `authority === '只增'` | policy：只增档 |

## §4 治理结构

| 设计 | 实现 | 测试 |
|---|---|---|
| 三档门槛：立宪 / 立法 / 自治 | `#tierRule` 三分支（`src/policy.js`） | policy：三档各一例 |
| 修宪 Lead 不许发起 | 宪章档拒绝 `propose` | policy：Lead 写宪章 deny |
| 三权：查看 / 否决 / 撤回（写拒绝名单，不删卡） | `registry.revoke` + 策略层 denylist 检查 | policy：撤回；objects：撤回 |
| 介入度四档，只影响自治档 | `intervention()` + 自治档分支 | policy：介入度只影响自治 |
| 建 / 改 / 删卡 = Lead（复核者卡例外） | 自治档 allow + 复核者卡 `authority: 法律` | policy：宪章/法律档 |
| 工具总范围 = 主权者 | 出厂 `defaults/工具总范围.json` + `tools.guard` 闸（`lib/index.js`） | host：闸单调 |
| 授权标签粒度 = 段；冲突取更高 authority | `parseDocument` 段解析 + `highestAuthority`（`src/tags.js`） | objects/preflight |
| 留痕是自治的门槛 | 每次状态变更 `audit.append`（各服务） | safety：审计只增 |
| 只有主权者能回滚文本版本 | `store.rollback` 的 `textVersion` 检查 | objects：非主权者不能回滚 |
| 失联：超过响应期限未响应 ⇒ 冻结自治 | `evaluateSovereignPresence` + 自治档检查 | policy：失联冻结 |
| 安全类封闭清单 + 五道配套 | `CLOSED_LIST` + `probeDeclaration`（`src/probes.js`） | safety：探针封闭清单 |
| 探针红 ⇒ 回滚到「全绿最近一版」 | `probes.autoRollback` 只定位回滚目标，不改文件 | safety：回滚目标 |
| 自动回滚的定性（甲′裁决 2026-10-09） | 定位全绿最近一版＋无条件入账＋告警升级主权者（`autoRollback` 不问策略引擎、直接记账）；运行态不自动改文件——执行面＝主权者经版本管理（git/包版本）装回 | safety：回滚入账 |
| 恒红 / 恒绿都要报警 | `probes.evaluateHealth` | safety：探针健康 |
| 影响面声明 | `probes.impactStatement` | safety：影响面声明 |

## §5 载体与升级

| 设计 | 实现 | 测试 |
|---|---|---|
| 出厂区只读模板 / 私有区叠加层 / 生效内容 = 合并结果 | `Layout` 两区 + `UpgradeManager` | safety：条款级合并 |
| 用户没改过 ⇒ 直接替换 | `decide()` 第一行 | safety：四行处置表 |
| 用户改了、出厂没改 ⇒ 保留用户的 | `decide()` | safety：条款级合并 |
| 两边改了同一条 ⇒ 挂起，摆 diff | `decide()` + `#suspend` | safety：挂起 |
| 安全类 ⇒ 强制替换 | `decide(..., 安全类)` | safety：强制替换 |
| 挂起不阻塞其他更新 | 挂起队列按条款分文件 | safety：挂起不阻塞 |
| 三配套：基线戳 / 不强制 ≠ 不通知 / 可撤回 | `stamp` / `compare` 返回处置 / `withdraw` | safety：基线戳、撤回 |
| 身份核心锁定，不可叠加 | 段名不变式（`target.segment === '身份核心'`） | policy：身份核心锁定 |
| 出厂件只对出厂作者开放 | `store.write` 的 zone 检查 | objects：出厂区只读 |

## §6 数据结构

| 设计 | 实现 | 测试 |
|---|---|---|
| 对象带 id/kind/authority/zone/domain/project/version/refs | front matter（`formatFrontMatter`） | preflight：键序 |
| kind 封闭清单 | `KINDS`（`src/tags.js`） | — |
| 策略引擎是唯一写入口 | 各服务在落盘前 `policy.check` | objects/flow 全线 |
| 版本化在写时自动发生 | `store.#keepVersion` | objects：版本化 |
| 回滚读历史版本，审计只记指针 | `store.rollback` + `#recordPointer` | objects：回滚 |

## §7 八件基础设施

| 设计 | 实现 | 测试 |
|---|---|---|
| 角色注册表：索引不是真源；封存 ≠ 删除；实例权限只来自岗位 | `src/registry.js` | objects：注册表三例 |
| 共享工作台：投影，无存储，成员只读一片 | `src/workbench.js` | safety：纯投影 / 成员切片 |
| 任务图：判据必填、派发后冻结、待决项是状态、一岗多人标模式、产物只存引用 | `src/tasks.js` | flow：任务四例 |
| 消息总线：暂不投递、线程隔离、历史不入上下文 | `src/bus.js` | flow：总线 |
| 策略引擎：唯一判定点、fail-closed、可执行理由、只读标签 | `src/policy.js` | policy 全量 |
| 能力库：单源、双区同名不合并 | `src/capability.js` | objects：同名不合并 |
| 记忆服务：写入必带来源、不许改写只能追加、写入时校验结构 | `src/memory.js` | flow：记忆三例 |
| 只读面收窄（契约B 2026-10-09）：query / bus.read / capability.resolve 也过判定，放行一次调用一条「记汇总」审计 | `memory.query` + `bus.read` + `capability.resolve` 的 `policy.check`；`ACTION_GRADE` 登记档位 | contracts-bc：契约B 七例 |
| 知识晋升披露机械检查（契约C 2026-10-09）：标题+内容+标签过敏感模式，豁免仅 Lead 且豁免+命中模式进审计 | `memory.promoteCrossProject` + `DEFAULT_DISCLOSURE_PATTERNS`；部署.json `披露敏感模式` 在 `policy.#loadDefaults` 加载期校验（非法正则 = fail-closed） | contracts-bc：契约C 九例 |
| 完整血缘（契约A 2026-10-09）：来源引用 fail-closed 存在性校验 + 派生自自动记录 + 闭包 ≤3 层环安全 | `memory.remember`/`#verifyRefs` + `buildLineageIndex`/`lineageClosure`（纯投影）+ `memory.lineage`（读面契约B 同款） | contracts-a：血缘七例 |
| 物理删除三步化（契约A · §C8 阻断）：待删除状态行 + 下游隔离闭包 + 审计含隔离清单；隔离/待删除退出默认召回（粘性） | `memory.purge` + `fold` 两态 + `口径.隔离条目数` | contracts-a：建链/深度/旧数据三例 |
| 披露拦截入账 + 空清单显式关闭留痕（契约C 骑手①② 2026-10-09） | `memory.promoteCrossProject` 拒绝路径 append「披露拦截」；`policy.#warnIfDisclosureDisabled` 按状态迁移记告警 | contracts-a：骑手两例 |
| 会审讨论段（W2 2026-10-09）：任务图事件流为权威、bus 只承载消息；齐卷重算 + 预算快照冻结 + 轮边界系统消息切轮 | `src/debate.js`（编排 + 预算纯函数）+ `tasks.js` 三事件 fold `讨论` 子状态 + `bus.readRaw` 内部读 + `policy` 的 `会审讨论` 键加载期校验 | debate：16 例 |
| 讨论软约束（W2）：讨论中仍可 review，投影标注「讨论未收敛」——不把「Lead 不收敛」变成死锁 | `workbench.讨论小节`（现算读数）+ board `debateView` 渲染 | debate：投影标注例 |
| 审计日志：只增、无条件写、不承担回滚 | `src/audit.js` | safety：审计 |
| 记忆四类归属（知识双标签 / 经历账本 / 偏好部署 / 作答实例） | `MemoryService.remember` | flow：记忆标签 |
| 作答归档后的可读性矩阵 | `memory.readableBy` + `query` 默认面 | flow：归档可读性 |
| 「轮」的定义与分级（全记 / 记汇总 / 不逐次记） | `lib/components/kernel.js` `挂审计` + `GRADE` | host：失败全记 / 轮汇总 |

### 共享工作台显示什么（§7 表 · §9 契约 · §14.2）

界面这一块的内容是**从设计推出来的**，不是挑好看的：

| 设计 | 实现 | 测试 |
|---|---|---|
| 「**待决项** = 任务图里的一种节点状态；**工作台把它投影出来**」（§7 唯一被点名要投影的东西） | `待你决定` 块（`src/workbench.js` `收集待你决定`）；每项附**该敲的命令** | safety：纯投影 |
| 「能从**任务图 + 日志**重算」 | `任务` 块 + `审计尾` 块——投影的两个来源 | safety：纯投影 |
| 「§10 独立会审 → **N 份独立答案** + 分歧清单」 | `会审` 块：独立答案按人留、盲标、分歧清单、反例面 | safety：会审块 |
| 「零分歧 = 结论层一致且无人给反例面 ⇒ **异常信号**」 | `judgeZeroDivergence`（`src/review.js`）**一处实现两处用**：复核时入账 + 投影时重算 | safety：会审块 |
| 「不做讨论、不做权威记录」+ §9 硬规则③「工作台只读」 | 面板无任何写入控件；需要动作的地方给命令文本 | integration：待你决定给命令 |
| 「成员只读自己任务那片」 | `sliceForViewer` 连 `会审` 一起切片 | safety：成员只读一片 |
| §14.4-5「**目录名即项目键**」 | `项目键()`（`lib/components/kernel.js`）从工作区目录派生，不写死默认值 | integration：两侧同项目 |

**刻意不显示的两块**（曾经有，已删）：

| 曾显示 | 为什么删 |
|---|---|
| 八件基础设施的计数 | 那是**系统元数据**，不是「当前状态」，且与 `mind status` 完全重复。设计里没有这一块 |
| 主干环路 stepper | §8 的环路是**流程定义**，画成常驻进度条永远停在某一格，信息量为零 |

## §8 主干环路

| 设计 | 实现 | 测试 |
|---|---|---|
| 环路十一站（流程定义，**不作为常驻视图渲染**） | 出厂件 `mind/集体L1-法律/协作协议.md` 的「主干环路」段 | preflight：出厂件结构 |
| 复核三态：过 / 不过 / 未验 | `REVIEW_VERDICTS`（`src/tasks.js`）；三态在面板上视觉可区分 | flow：复核三态 |
| 未验 ≠ 通过，不计打回，升级 Lead | `review.record` 返回值 | flow：未验 |
| 结论不经 Lead 修改；可记录不同意 | `recordDisagreement` 只追加 | flow：结论不可改 |
| 打回 ≥2 次 ⇒ 升级主权者 | `tasks.reject` + `escalated` 事件 | flow：打回≥2 |
| 会审解锁 = 任务图报「全员已交」 | `bus.unlock` 硬边界；投影里的 `揭名` 就是它的读数 | flow：解锁边界 |

## §9 接口契约

| 设计 | 实现 | 测试 |
|---|---|---|
| 策略引擎入参 `{主体, 对象 id, 动作}` → 允许/拒绝/需确认 + 理由 | `policy.decide` / `check` | policy：三种结论 |
| 审计入参 `{时间, 主体, 动作, 对象, 依据, 结果}` | `audit.append` | safety：审计 |
| 写操作先过策略引擎，无旁路 | 各服务落盘前 check | objects/flow |
| 拒绝必须带可执行理由 | `Denied.rule/reason/requireAuthority/howToChange` | policy/host |
| 特权读只有策略引擎拥有 | `PolicyEngine` 直接读标签，不经自身判定 | policy：加载 |
| 工作台只读 | `边界: {只读: true}` | safety：投影只读 |

## §10 反趋同

| 设计 | 实现 | 测试 |
|---|---|---|
| 提交后解锁 | `review.openBlind` 拒绝未交齐 | flow：盲评 |
| 强制反对者：随机、未参与、不重复 | `review.pickDissenter` | flow：反对者不重复 |
| 盲评：第一轮只显示成员 A/B/C | `openBlind` 盲标 + `reveal` | flow：揭名 |
| 一岗多人必须显式声明模式 | `tasks.create` + `review.declareMode` | flow：一岗多人 |
| 零分歧报警（结论层一致且无人给反例面） | `review.checkZeroDivergence` | flow：零分歧 |
| 记一笔「会审零分歧异常」并触发人工抽检 | 审计 `动作: 零分歧异常`，`告警: true` | flow：零分歧审计 |

## §11 检索层

| 设计 | 实现 | 测试 |
|---|---|---|
| 默认词面检索 BM25 + 长度归一化 | `buildIndex` / `search`（`src/retrieval.js`） | flow：检索 |
| 排序各维同量纲或显式归一化 | 打分只有 BM25 一个量纲；`normalizeScores` 供显式合并 | flow：检索 |
| 回归集 + 基线 | `runRegression` | — |
| 报 0 命中必须连口径一起报 | `口径` + `formatMiss` | flow：0 命中口径 |
| 正文结构是写入侧义务 | `assertStructure`（`src/tags.js`） | objects：结构拒收 |

## §12 约束清单（血换来的）

| 设计 | 实现 | 测试 |
|---|---|---|
| 1 闸不许 fail-open | `Fault` → 拒绝 + `alarm`；`tools.guard` 单调 | policy：fail-closed；host：闸 |
| 2 身份停用/删除时判定必须有确定答案 | `identityStatus` + 未知主体拒绝 | policy：未知主体；objects：未登记 |
| 3 权限来源必须唯一确定 | 实例权限只来自岗位卡 | objects：不存在的岗位 |
| 4 重启后所有判定必须能重建 | 全 append-only + 索引可重算 | objects：索引重建 |
| 5 出厂件不含用户特定信息 | 探针 + preflight | safety：探针全绿 |
| 6 全票一致 = 异常信号 | 零分歧报警 | flow：零分歧 |

## §13 未决

| 项 | 实现 | 测试 |
|---|---|---|
| 旧数据：不迁移、保留、原地只读、不接入检索面 | 私有区新目录与旧 `L0..L3` 并列，不覆盖；旧数据读权限走宪章不变式 | policy：旧数据读权限 |
| 新旧关系：替换 dsh-mind 插件 | 本包即新的 `dsh-mind` | — |
| 领域协调者暂不设 | 编制里不设该岗位 | preflight：出厂件结构 |

## §14 目录结构

| 设计 | 实现 | 测试 |
|---|---|---|
| 出厂区五个目录名与文件清单 | `<包>/mind/**` | preflight |
| 私有区目录 | `Org.bootstrap`（`src/org.js`） | host：装配 |
| 八件 ↔ 物理形态 | `src/paths.js` `Layout` | 全线 |
| 命名规则：id 短 kebab / 文件名 `<id>.md` / 账目 `.jsonl` / `版本历史/<id>/<版本>.md` / 目录名即项目键 | `src/kernel/ids.js` + `Layout` | objects：版本历史 |

---

## 组件 ↔ 物理形态（一张卡 + 三行）

设计没有规定「八件必须挤在一个 `apply` 里」。实现把它拆成**组件**——
也就是插件管理页里那张卡下面的行：每行一个独立包、一个独立开关。

| 组件 | 包 | 对应设计里的什么 | 关掉它的后果 |
|---|---|---|---|
| 内核 | `dsh-mind-kernel` | 八件基础设施 + §5 双区载体 + §8 主干环路，以及对外两个面（工具 / 命令）与闸、审计钩子、提示段 | 那张卡只剩空壳 |
| 安全类 | `dsh-mind-guard` | §4 安全类（封闭清单 + 五道配套）+ §5 升级运维面 | 判定与记账照常，没有机制自检 |
| 看板 | `dsh-mind-board` | §7「共享工作台」的**呈现**（投影本身在内核里） | 组织照常跑，只是没人看得见 |

载体形状：`dsh-mind` 是 **bundle 包**（= 那张卡，自己不插行），三个组件包写在它的 `dependencies` 里。
profile 的 `dsh.profile.bundles` **只写 bundle**；写全三个就会变成三张卡，
「组件」就退回成了「三个插件」——这正是这一版要修的那个错。

三条纪律：

1. **所有组件共用同一个 `Org`**（`src/runtime.js` 的键控缓存）。
   各持一份的话，探针检查的策略引擎可能不是内核正在用的那一个——那等于白测。
   `test/components.test.js` 与 `test/integration.test.js` 都盯着这件事。
2. **动作面不重叠**。内核的 `mind` 与安全类的 `mind_guard` 各自枚举自己的动作；
   内核不在 schema 里列它做不到的事（给个空承诺比不装更糟）。
   唯一留在内核的升级动作是只读的 `upgrade_pending`——关掉安全类也要能看到待裁决的 diff。
3. **主面不吞异常**。工具注册不上就等于组件没生效，装载必须如实失败；
   只有次要面（命令、提示段）才降级为告警。

看板的两处席位也是实现决定，写在这里备查：
`main`（keyed，key = `dsh-mind`）= 独立面板；`sidebar.footer.action`（list）= 左侧边栏下方入口。
它**不在** `settings.section` 里——看板是常驻运维视图，不是一项设置。
浏览器半区之所以挂在看板包而不是 bundle 包上，是为了让「关掉看板那一行」真的能撤下界面：
只有被某一行引用的包才会进 roster。

---

## 与设计的自觉偏离（两处，都不改判定语义）

第一处：设计中「目录负责找得到」把八件的**程序**也画在数据目录里（`集体L2-共享基础设施/策略引擎/`）。
实现里八件的程序就是插件本身的模块（`src/*.js`），出厂区目录保留同名位置用于放**声明与默认值**。
理由：程序必须能被宿主直接 import，放进数据目录既加载不了，也会让「随产品更新」失去载体。

第二处：设计把八件当作一个整体（「八件基础设施」），实现按**用得上才装**把它拆成三个组件。
八件的实现仍在同一份 `src/` 里、同一套策略判定下，只是**装载粒度**变细了；
对外仍然是**一张卡**：一次安装、一次装配、一份组织。



