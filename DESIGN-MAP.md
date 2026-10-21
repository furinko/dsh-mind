# 设计条款 → 实现 对照表（v2）

> **2026-10-20 阅读入口**：产品主路径、职责分层和未实现能力以 [ARCHITECTURE](ARCHITECTURE.md) 与 [ROADMAP](docs/ROADMAP.md) 为当前索引。本文保留组织 v2 条款的映射和历史验收；“已落”表示对应源码路径已有实现，不能据此推断本地候选已部署或某个历史测试数适用于新版本。普通问答无需完整组织流程，正式任务继续遵守现行授权与证据规则。

> 用途：拿《心智 · 数字组织设计 **v2.0**》逐条核对实现。**每条要么给出实现落点 + 测试，要么显式标注状态**——不许留「文档写了就算」的行。
> 判据：设计里写明「必须保证 / 永不 / 不许 / 不得」的，这里都必须有一行。
>
> **状态口径**（2026-10-13 审查批次纪律，v2 沿用）：
> **已落** = 当前主线有实现 + 实际调用路径 + 有测试兜底 ｜ **部分落** = 主路径在用，但设计要求里还有一条没接上（行内点名）｜ **未接线** = 口径/定义在，动作面无入口或无人调用（行内说明影响面）｜ **待退役** = 设计已删、实现还留着（行内说明清理条件）。
>
> 条款实现状态不证明当前客户端已重载或每项实机验收通过；部署与验收状态见[当前状态](docs/STATUS.md)。
>
> **历史快照（2026-10-18 m56ik 接续）**：当次组织 v2 变更依据为[口述确认24条](<docs/design/v2-口述收敛-2026-10-18.md>)；后续产品方向与实现增量从上面的当前索引进入。当次问题、证据与盲区见[独立审查跟踪](<docs/归档/审查轮-2026-10/代码审查报告-m56ik-2026-10-18.md>)。
>
> - **复核**：任务作用域、真实署名、冲突排除及过票/Lead采纳分离已接线；私有祖先递归读缺口已补并有反例，待总终验。
> - **介入**：冻结原请求、条件补偿计划、原申请者重放及消项已接线；失败补偿和审计后清理交叉已由工程独立票及合并反例核验。真实审批网页全生命周期未冒称实测。
> - **记忆**：结账真实晋升与条目追踪已接线；本轮已实际产生并召回双标签知识，不是只记声明。
> - **会审**：已退出任务图；旧写面封闭、新模式字段删除；受管起实例、咨询闭名单与资料根已接线。当前宿主实际两人交答→解锁→表态→收敛停封，任务数95→95；故障矩阵在隔离模块面证伪。
> - **实例**：钉卡、真实绑定及按存活事实孤儿回收已接线；不知道历史实例死活就保留未知。Lead真自执行补修经独立票部署，原同一节点已真实派发/开工；其他Lead及上级仍拒。
>
> **门禁口径**：最终合并版893根+21看板+503客户端、preflight/安装自检、17副本变异及四探针独立绿→红校准。实际宿主、冻结源码与独立票仍分别留证，不把其中一面借作另一面或任意后续版本通过。

## §2 主体

| 设计 | 实现 | 测试 |
|---|---|---|
| 主权者 / 出厂作者 / Lead / 成员 / **系统** 五类主体 | `SUBJECT_KINDS`（`src/policy.js`） | policy：未知主体 |
| 「系统」= 机制动作的记账主体 | 审计/升级/打回升级写 `{id:'system', kind:'系统'}`（`src/tasks.js`、`src/policy.js`）；总线「系统」类型**仅系统主体可发**（`src/bus.js`） | policy：未知主体；v2-council：系统类型 |
| 复核 = 集体 L3 一张普通岗位卡（无任命 / 池 / 轮派） | 旧任命链（提名 / 池 / 轮派 / 服务层任命）已整体删除；卡在 `mind/集体L3-成员角色卡/复核员.md` | review-path-2026-10-16：member_spawn |
| 复核由 Lead 按任务 `member_spawn` 手动起实例 | **已落**：`member_spawn` 按岗位名派（`lib/actions.js`）；复核员岗的「授权引用」必填已随降级移除，`registry_assign` 只做可选透传 | delegation：按岗位名派；review-path：member_spawn |
| 旧任命链（提名 / 池 / 派单）整体移除 | **已落**：任务图的提名与派单方法已删、`ACTIONS` 不列（留这一行只为记录「删干净了」，不是待办） | review-path-2026-10-16：member_spawn |
| 「只读数、不改、不提案」由策略引擎**按岗位名**判 | **已落**：`#preGrantBoundary` 按 `subject.roleId === '复核员'` 拦全部写动作（`src/policy.js`；P1-05 前移到授权块之前，grant 绕不过） | policy：复核员只读；v2-reviewer-demotion：主体清单 |
| 复核实例读范围 = 任务作用域宽读 | 已接线：真实绑定复核任务→显式复核对象→依赖读域；workbench/判据/审计/总线/记忆同源裁剪，文件只读显式授根且禁raw私有及父根递归 | [读域](<test/v2-review-scope-2026-10-18.test.js>)；[真实工具闸](<test/guard-reviewer-readonly-2026-10-18.test.js>) |
| 冲突排除：执行者 / 交卷人 / 负责人 / 同会话者不得复核本任务 | 已接线：真实主体署名恒等、在册在岗/岗位与关联复核任务核验；锁内复检冲突，不能替别人代签 | [复核](<test/v2-reviewer-demotion-2026-10-18.test.js>)；[采纳分离](<test/v2-adopt-split-2026-10-18.test.js>) |
| 复核结论 = 硬闸（无「过」不得采纳，「未验」也不得采纳） | `review(过)`只留本代rv-N票，节点仍已交卷；不过打回，未验不算通过也不计打回 | [采纳分离](<test/v2-adopt-split-2026-10-18.test.js>) |
| 采纳必须引用复核结论；Lead 不得改结论 | `task_accept`引用本节点当前有效票，另走免审/旧账显式承接资格；新交卷/成果令旧票失效。异议仅追加；报告票不能借给产品任务 | [采纳分离](<test/v2-adopt-split-2026-10-18.test.js>)；本轮独立票与真实采纳回执 |
| 免审 = 部署设置全局开关（默认关，变更入审计） | 主权者设置入口、布尔校验及变更审计已接线；模型不能代开，外部文件变更按加载路径观察 | [复核](<test/v2-reviewer-demotion-2026-10-18.test.js>)；设置入口测试 |
| 统一实例模型：卡恒久 / 实例临时 / 启动钉卡版本 / 绑任务 / 用后封存 | 登记只消费钉住快照；普通任务与会审复用唯一宿主适配器。本轮真实起审查/工程实例、交卷后停封；会审故障交叉由独立工程票与最终17变异另证，非生产破坏审计实验 | [实例模型](<test/v2-instance-model-2026-10-18.test.js>)；[卡完整性](<test/v2-card-integrity-2026-10-18.test.js>) |
| 负责人写岗位名，实例随派绑定；全员已交按已绑实例算 | `负责人`与`绑定`独立；真实在岗/岗位/节点匹配核验；本人Lead绑定的直接执行已实际派发开工，不展开整个在岗集合 | [实例模型](<test/v2-instance-model-2026-10-18.test.js>)；[直接执行](<test/direct-lead-execution.test.js>) |
| Lead = 岗位唯一、多会话实例 | 编制单卡 + 会话出生真实Lead主体；不是Lead可任意新建另一个Lead | [代次](<test/v2-runtime-generation-2026-10-18.test.js>)；[直接执行](<test/direct-lead-execution.test.js>) |
| 孤儿实例：系统封存，未完成不自动算成 | 按真实代次与pid存活事实回收；无pid/无代次只能标未知，不能猜死。封存身份不自动采纳、结账或换署名 | [运行代次](<test/v2-runtime-generation-2026-10-18.test.js>)；当前重启孤儿回收读数 |
| 明确否决「派发时展开在岗实例集合」 | `tasks.create` 只存岗位名，未展开 | flow：任务四例 |

## §3 约束（永不）

| 设计 | 实现 | 测试 |
|---|---|---|
| ① 实例知识默认外流 → 不出厂 | 自治能力库只写私有区（`src/capability.js` `publish`） | objects：能力库双区 |
| ② 未经主权者的删除 / 发布 / 批量覆盖 | 宪章不变式（`src/policy.js` `#invariants`） | policy：未经主权者的删除 |
| ③ 出厂件不含任何用户特定信息 | 「出厂件洁净」探针 + preflight 门禁 | safety：探针全绿 |
| ④ 组织给自己发合格证（提案者不得自批） | 宪章不变式 `approve` + `proposerId` | policy：提案者不得自批 |
| ⑤ 成员自扩权 / 再起成员 | 宪章不变式（建卡 / 派活 / 提案 / 自批） | policy：成员不得自扩权 |
| ⑥ 安全闸静默失败 | 全部故障走 `Fault` → `alarm: true` + 审计告警 | policy：fail-closed；safety：闸不在位见红 |
| ⑦ 不越授（不得外派超过自身权限的主体） | 唯一不变式覆盖登记、派发、实例绑定与改派；任务账本锁内真实候选判定，真本人Lead自执行不等于外派另一Lead。工具/写域声明仍按既有凭证边界判，不捏造未提供的子集事实 | [父域](<test/v2-delegation-parent-2026-10-18.test.js>)；[直接执行](<test/direct-lead-execution.test.js>)及当前真实派发 |
| ⑧ 不自授（主体不得给自己扩权） | 真实身份/岗位及钉卡凭证在授权块之前核验；自登记不赋新权，复核只读与咨询闭名单不能被grant翻过 | [父域](<test/v2-delegation-parent-2026-10-18.test.js>)；[卡完整性](<test/v2-card-integrity-2026-10-18.test.js>) |
| 不可逆资源：已发布版本 / 审计日志 / 待决项记录 | `AuditLog.clearQueue` 把清掉的项写进账本 | safety：队列清空不入消失 |
| 队列可清空，记录不可逆 | 同上 | safety：清空队列 |
| 只增账目主权者也不能改 | 宪章不变式 `authority === '只增'` | policy：只增档 |

## §4 治理结构

| 设计 | 实现 | 测试 |
|---|---|---|
| 三档门槛：立宪 / 立法 / 自治 | `#tierRule` 三分支（`src/policy.js`） | policy：三档各一例 |
| 修宪 Lead 不许发起 | 宪章档拒绝 `propose` | policy：Lead 写宪章 deny |
| 三权：查看 / 否决 / 撤回（写拒绝名单，不删卡） | `registry.revoke` + 策略层 denylist 检查 | policy：撤回；objects：撤回 |
| 介入度**三档：放权 / 预审 / 审批**，只影响自治档 | `INTERVENTION` 三值（`src/policy.js:55`）；旧档名加载期 fail-closed（`#loadDefaults`） | policy：三档各例（v2-intervention）；旧值 fail-closed（fix-batch P2-1） |
| 预审档「高风险」= 写死清单（改卡 / 发布能力 / 物理删除记忆 / 改设置） | `#预审高风险()`（`src/policy.js`）；实例登记经 `context.身份操作='实例'` 自证不算改卡 | v2-intervention：四类全拦 + 低风险直落 |
| 审批档 = 每条自治写逐请求放行 | 冻结原主体/项目/参数及底层步骤；认证人侧只决议，原申请者引用重放；成功/失败消项、不重复执行。条件补偿与审计失败交叉已有独立候选票和合并反例，真实人侧审批网页仍未以夹具代测 | [审批](<test/v2-intervention-approval-2026-10-18.test.js>)；[真动作链](<test/v2-approval-entry-chains-2026-10-18.test.js>) |
| 设置项仅主权者可改、变更入审计、非法值 fail-closed | 生效闭环 + `#loadDefaults` 加载期校验 | host：生效闭环 |
| 建 / 改 / 删卡 = Lead（复核员卡**不再例外**） | **已落**：自治档 allow；复核者例外 / 分段授权已从 `mind/集体L1-法律/权限矩阵.md` 删除（2026-10-18 文档对齐）；改卡在预审档按 `#预审高风险` 挂起 | policy：宪章/法律档；v2-intervention：四类全拦 |
| 工具总范围 = 主权者 | 出厂 `defaults/工具总范围.json` + `tools.guard` 闸（[内核入口](<components/kernel/lib/index.js>)） | host：闸单调 |
| 授权标签粒度 = 段；冲突取更高 authority | `parseDocument` 段解析 + `highestAuthority`（`src/tags.js`） | objects/preflight |
| 留痕是自治的门槛 | 每次状态变更 `audit.append`（各服务） | safety：审计只增 |
| 只有主权者能回滚文本版本 | `store.rollback` 的 `textVersion` 检查 | objects：非主权者不能回滚 |
| 失联：超过响应期限未响应 ⇒ **冻结全部自治变更** | `evaluateSovereignPresence` + 自治档检查（§4 维持宪章，不松绑） | policy：失联冻结 |
| 恢复 = 任一交互；恢复 ≠ 批准待决项 | `presence` 恢复路径 + 待决项独立状态 | presence：恢复语义 |
| 安全类封闭清单 + 五道配套 | `CLOSED_LIST` + `probeDeclaration`（`src/probes.js`） | safety：探针封闭清单 |
| 探针红 ⇒ 回滚到「全绿最近一版」 | `probes.autoRollback` 只定位回滚目标，不改文件 | safety：回滚目标 |
| 自动回滚的定性（甲′裁决 2026-10-09） | 定位全绿最近一版＋无条件入账＋告警升级主权者；运行态不自动改文件——执行面＝主权者经版本管理装回 | safety：回滚入账 |
| 恒红 / 恒绿都要报警 | `probes.evaluateHealth` + `run()` 消费 | safety：探针健康 |
| 影响面声明 | `probes.impactStatement` | safety：影响面声明 |

## §5 载体与升级

| 设计 | 实现 | 测试 |
|---|---|---|
| 出厂区只读模板 / 私有区叠加层 / 生效内容 = 合并结果 | `Layout` 两区 + `UpgradeManager` | safety：条款级合并 |
| 用户没改过 ⇒ 直接替换 | `decide()` 第一行 | safety：四行处置表 |
| 用户改了、出厂没改 ⇒ 保留用户的 | `decide()` | safety：条款级合并 |
| 两边改了同一条 ⇒ **私有优先** + 审计告警（2026-10-08 裁决） | `decide()` / `compare()` 的冲突标记与告警 | safety：条款级合并 |
| 安全类 ⇒ 强制替换 | `decide(..., 安全类)` | safety：强制替换 |
| 遗留挂起项不阻塞其他更新、可裁决/撤回 | `pending()` / `resolve()` / `withdraw()`（队列按条款分文件） | safety：遗留挂起 |
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
| 任务图：判据必填、派发后冻结、待决项是状态、**负责人写岗位名**、产物只存引用 | `src/tasks.js` | flow：任务四例 |
| 消息总线：暂不投递、线程隔离、历史不入上下文、发件人恒为真实主体 | `src/bus.js` | flow：总线；v2-council：发件不许自报 |
| 策略引擎：唯一判定点、fail-closed、可执行理由、只读标签 | `src/policy.js` | policy 全量 |
| 能力库：单源、双区同名不合并 | `src/capability.js` | objects：同名不合并 |
| 记忆服务：写入必带来源、不许改写只能追加、写入时校验结构 | `src/memory.js` | flow：记忆三例 |
| 只读面收窄（契约B）：query / bus.read / capability.resolve 也过判定，一次调用一条「记汇总」 | `memory.query` + `bus.read` + `capability.resolve` 的 `policy.check`；`ACTION_GRADE` 登记档位 | contracts-bc：契约B 七例 |
| 知识晋升披露机械检查（契约C） | `memory.promoteCrossProject` + `DEFAULT_DISCLOSURE_PATTERNS`；部署.json `披露敏感模式` 加载期校验 | contracts-bc：契约C 九例 |
| 完整血缘（契约A） | `memory.remember`/`#verifyRefs` + `buildLineageIndex`/`lineageClosure` + `memory.lineage` | contracts-a：血缘七例 |
| 物理删除三步化（契约A · §C8） | `memory.purge` + `fold` 两态 + `口径.隔离条目数` | contracts-a：建链/深度/旧数据三例 |
| 披露拦截入账 + 空清单显式关闭留痕（契约C 骑手①②） | `memory.promoteCrossProject` 拒绝路径 append「披露拦截」；`policy.#warnIfDisclosureDisabled` | contracts-a：骑手两例 |
| 审计日志：只增、无条件写、不承担回滚 | `src/audit.js` | safety：审计 |
| 记忆四类归属（知识双标签 / 经历账本 / 偏好部署 / 作答实例） | `MemoryService.remember` | flow：记忆标签 |
| 「轮」的定义与分级（全记 / 记汇总 / 不逐次记） | [内核入口](<components/kernel/lib/index.js>) `挂审计` + `GRADE` | host：失败全记 / 轮汇总 |
| 知识 = 晋升-only；记忆整理岗受限晋升而非自由直写 | `remember`挡成员直写；`promoteFromAdopted`只认同项目已合法采纳来源、双标签与整理实例真实执行中任务绑定，披露检查同款 | [记忆](<test/v2-memory-2026-10-18.test.js>)；[真实晋升](<test/v2-promotion-2026-10-18.test.js>) |
| 晋升三个入口：结账强制 / 工作台兜底 / Lead手动 | `settlePlan`单源候选及意图；`settle`逐候选处置，真实生成知识并记晋升映射。失败不假结账，同键幂等/冲突拒。当前工程已采纳→结账晋升→知识召回已实走 | [晋升](<test/v2-promotion-2026-10-18.test.js>)；本轮工具回执 |
| 通用记忆命名空间 | 工具显式`命名空间=通用`，存储项目标签为通用、落跨项目账；执行项目不变，不是让成员改project跨项目的侧门 | [记忆](<test/v2-memory-2026-10-18.test.js>)；[晋升](<test/v2-promotion-2026-10-18.test.js>) |
| **跨项目写**：Lead 显式 `project` + 依据必填 + 入审计；成员禁跨项目 | **已落**：`memory.remember` 校验跨项目写必须带「依据」；成员跨项目写 / 读一律拒；Lead 跨项目读放行 | v2-memory：跨项目规则 |
| 会审讨论段：预算快照冻结、轮边界由系统消息切 | **已落（W4 收编）**：`src/council.js`（从已删的 `src/debate.js` 搬入）＋ `policy` 加载期校验；旧任务图 `debate_*` 事件仅 fold 只读 | v2-council：讨论 / 预算 |
| 作答归档后的可读性矩阵 | `memory.readableBy` + `query` 默认面 | flow：归档可读性 |

### 共享工作台显示什么

| 设计 | 实现 | 测试 |
|---|---|---|
| 「**待决项** = 任务图里的一种节点状态；工作台把它投影出来」 | `待你决定` 块（`src/workbench.js` `收集待你决定`）；每项附**该敲的命令** | safety：纯投影 |
| 「能从**任务图 + 日志**重算」 | `任务` 块 + `审计尾` 块 | safety：纯投影 |
| 「§10 会审 → N 份独立答案 + 分歧清单」 | **已落（W4）**：`workbench.会审` = `council.list` 存档行（问题 / 各答案 / 分歧 / 结论 / 来源会话 / 时间）；盲评遮罩在 `council` 服务层 | v2-council：存档 |
| 「零分歧 = 结论层一致且无人给反例面 ⇒ 异常信号」 | `judgeZeroDivergence`（`src/review.js`）一处实现两处用 | safety：会审块 |
| 工作台不做权威记录 | 工作台仍是只读纯投影；另注册的设置分区走认证人侧端点，只做明确设置/审批，不是任意动作代理 | integration：待你决定；客户端设置断言 |
| 「成员只读自己任务那片」 | `sliceForViewer` 连 `会审` 一起切片 | safety：成员只读一片 |
| §14.4-5「**目录名即项目键**」 | `项目键()`（[内核入口](<components/kernel/lib/index.js>)）从工作区目录派生 | integration：两侧同项目 |

**刻意不显示的两块**（曾经有，已删）：

| 曾显示 | 为什么删 |
|---|---|
| 八件基础设施的计数 | 那是**系统元数据**，不是「当前状态」，且与 `mind status` 完全重复 |
| 主干环路 stepper | §8 的环路是**流程定义**，画成常驻进度条永远停在某一格，信息量为零 |

## §8 主干环路

| 设计 | 实现 | 测试 |
|---|---|---|
| 环路十一站（流程定义，**不作为常驻视图渲染**） | 出厂件 `mind/集体L1-法律/协作协议.md` 的「主干环路」段 | preflight：出厂件结构 |
| 复核三态：过 / 不过 / 未验 | `REVIEW_VERDICTS`（`src/tasks.js`）；三态在面板上视觉可区分 | flow：复核三态 |
| 未验 ≠ 通过，不计打回，升级 Lead | `review.record` 返回值 | flow：未验 |
| 结论不经 Lead 修改；可记录不同意 | `recordDisagreement` 只追加（仅 Lead） | flow：结论不可改 |
| 打回 ≥2 次 ⇒ 升级主权者 | `tasks.reject` + `escalated` 事件（主体记 `系统`） | flow：打回≥2 |
| 会审解锁 = 本场按人交齐；旧任务会审只读 | `council.unlock`是新解锁正门；`bus_unlock`退出模型清单，服务墓碑对所有节点恒拒不写广播，历史事件仅fold回放 | [会审](<test/v2-council-2026-10-18.test.js>)；[受管会审](<test/v2-council-managed-2026-10-18.test.js>) |

## §9 接口契约

| 设计 | 实现 | 测试 |
|---|---|---|
| 策略引擎入参 `{主体, 对象 id, 动作}` → 允许/拒绝/需确认 + 理由 | `policy.decide` / `check` | policy：三种结论 |
| 审计入参 `{时间, 主体, 动作, 对象, 依据, 结果}` | `audit.append` | safety：审计 |
| 写操作先过策略引擎，无旁路 | 各服务落盘前 check | objects/flow |
| 拒绝必须带可执行理由 | `Denied.rule/reason/requireAuthority/howToChange` | policy/host |
| 特权读只有策略引擎拥有 | `PolicyEngine` 直接读标签，不经自身判定 | policy：加载 |
| 工作台只读 | `边界: {只读: true}` | safety：投影只读 |
| 授权用天然凭证，不立统一对象模型 | 主权者身份、Lead真实会话、节点真实绑定及钉卡各有本来事实源；动作预检读取真实任务，不接模型自报负责人/状态，不能拿Root allow代授给成员 | [实例模型](<test/v2-instance-model-2026-10-18.test.js>)；[任务上下文](<test/policy-check-task-context-2026-10-18.test.js>) |
| **全组织仅剩的授权引用：更正审计**（须引主权者决议） | `audit.correct` 的 `授权引用` 必填（`src/audit.js`） | audit-correction：授权引用 |
| Lead 起实例的入口 = `member_spawn`（岗位 + 节点 + 任务书） | `lib/actions.js` `member_spawn`；岗位卡与判据由机制装载 | delegation：member_spawn |

## §10 会审（独立功能）

> **部分落地，待补修验收**（W4 · 2026-10-18）：`src/council.js` 已有独立事件流存档与
> debate_open/answer/unlock/round/say/converge 六动作；旧数据封写、受管咨询起点与并发定格保护均已有接线及反例；实际会审存档与任务数另有运行记录。

| 设计 | 实现 | 测试 |
|---|---|---|
| 会审 = 与会话绑定的独立功能，不占任务节点、不走派发 / 复核 / 结账 | `src/council.js`（`CouncilService`，自己的 `councils.jsonl` 事件流）；动作面六个 debate_* 全挂 council；任务图无会审形态 | v2-council：全链路 |
| 会审存档进会审页：问题 / 各份答案 / 分歧 / 结论 / 来源会话 / 时间 | fold 视图六要素齐全；`workbench.会审` = `council.list` 存档行 | v2-council：存档 |
| 配件：提交后解锁（含盲评）留 | `council.unlock` 齐卷揭名；`council.list` 按读者遮盲标（未交齐他人只见盲标） | v2-council：盲评/解锁 |
| 配件：**强制反对者砍** | `pickDissenter`/`#usedDissenters` 已删（`src/review.js`），开启不再指定反对者 | v2-council：发起 |
| 配件：**零分歧报警留**（结论层一致且无人给反例面） | `council.converge` 现算 `judgeZeroDivergence`，命中即审计 `零分歧异常` 并入存档 | v2-council：零分歧 |
| 配件：讨论段**留但默认不开**，预算轮2/人8/每轮24条/每人4000字 | 第一次 `debate_round` = 显式开启；预算快照发起时冻结；边界消息切轮（`src/council.js`） | v2-council：讨论/预算 |
| 一岗多人取消模式字段 | 新建/改派及投影不制造模式空壳；历史事件有真实模式值才只读保留 | [会审](<test/v2-council-2026-10-18.test.js>) |
| 咨询实例独立且不占任务节点 | 参与岗位经同一宿主创建/登记钉版/发书适配器起实例；绑定本场与资料根，consult工具及动作双闭名单。正常入口链及故障交叉均有真模块测试；本轮实际生命周期另记 | [受管会审](<test/v2-council-managed-2026-10-18.test.js>)；[真入口](<test/v2-council-entry-recovery-2026-10-18.test.js>) |

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
| 旧数据不迁移、保留、只读、不默认检索 | 新旧目录不覆盖，原读权限不扩；历史会审/讨论仅fold回放，bus.unlock墓碑恒拒且模型无bus_unlock，不能续写旧节点 | policy：旧数据读权限；[会审](<test/v2-council-2026-10-18.test.js>) |
| 新旧关系：替换 dsh-mind 插件 | 本包即新的 `dsh-mind` | — |
| 领域协调者暂不设 | 编制里不设该岗位 | preflight：出厂件结构 |
| 会审页的形态细节 | **部分落（W4 待验）**：会审页读 `council.list` 存档行、列全部历史；列表字段与收敛入口的 UI 细化未单独验收 | v2-council：存档 |

## §14 目录结构

| 设计 | 实现 | 测试 |
|---|---|---|
| 出厂区五个目录名与文件清单 | `<包>/mind/**` | preflight |
| 私有区目录（`记忆服务/` 跨项目 ＋ 各项目；会审存档） | `Org.bootstrap`（`src/org.js`）：**「通用」不另建目录**（落 `跨项目/` 账，`项目=通用`）；**会审存档 = `任务图/<项目>/councils.jsonl`**（与任务图同目录的独立事件流） | host：装配；v2-council：存档 |
| 八件 ↔ 物理形态 | `src/paths.js` `Layout` | 全线 |
| 命名规则：id 短 kebab / 文件名 `<id>.md` / 账目 `.jsonl` / `版本历史/<id>/<版本>.md` / 目录名即项目键 | `src/kernel/ids.js` + `Layout` | objects：版本历史 |

---

## 组件 ↔ 物理形态（一张卡 + 三行）

一个自洽包、三行组件，各有独立开关，不再靠三个相对link子包依赖装齐。

| 组件 | 装载入口 | 对应设计 | 关闭后果 |
|---|---|---|---|
| 内核 | `dsh-mind/kernel` | 八件基础设施、双区载体、工具/命令、闸及提示 | 无组织动作主面 |
| 安全类 | `dsh-mind/guard` | 四闭探针及升级运维 | 无机制自检 |
| 看板 | `dsh-mind`载体行与`./client`导出 | 工作台呈现及单独设置分区 | 无该呈现/设置入口 |

profile bundles只登记`dsh-mind`一张卡，包内patch插齐三行，exports提供子路径。安装反例自检检查依赖、bundle、三行与每个入口真实存在；不会因npm退出0就假定装齐。

三条纪律：

1. **所有组件共用同一个 `Org`**（`src/runtime.js` 的键控缓存）——`test/components.test.js` 与 `test/integration.test.js` 盯着。
2. **动作面不重叠**：内核 `mind` 与安全类 `mind_guard` 各自枚举；内核不列它做不到的事。唯一留在内核的升级动作是只读的 `upgrade_pending`。
3. **主面不吞异常**：工具注册不上就等于组件没生效，装载必须如实失败；只有次要面（命令、提示段）才降级为告警。

看板面板进`main`，侧栏图标进`sidebar.panellist`；设置分区另进`settings.section`。设置分区不是把工作台移回设置页；三处真实注册见[客户端](<components/board/lib/client.js>)及[结构断言](<components/board/test/client.test.js>)。

---

## 与设计的自觉偏离

第一处：设计中「目录负责找得到」把八件的**程序**也画在数据目录里（`集体L2-共享基础设施/策略引擎/`）。
实现里八件的程序就是插件本身的模块（`src/*.js`），出厂区目录保留同名位置用于放**声明与默认值**。
理由：程序必须能被宿主直接 import，放进数据目录既加载不了，也会让「随产品更新」失去载体。

第二处：设计把八件当作一个整体，实现按**用得上才装**拆成三个组件；装载粒度变细，对外仍是一张卡。

**第三处（v2 收口边界）**：不以批次名判断完成度。当前任务范围以独立票、合并源码哈希、全套门禁/变异和实际宿主读数逐项核；磁盘不可写时只能如实报告无法持久化，跨账本身份瞬时原子性、规模性能及真实浏览器手动交互没有被本轮夹具绿灯证明。
