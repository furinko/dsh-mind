# 设计条款 → 实现 对照表（v2）

> 用途：拿《心智 · 数字组织设计 **v2.0**》逐条核对实现。**每条要么给出实现落点 + 测试，要么显式标注状态**——不许留「文档写了就算」的行。
> 判据：设计里写明「必须保证 / 永不 / 不许 / 不得」的，这里都必须有一行。
>
> **状态口径**（2026-10-13 审查批次纪律，v2 沿用）：
> **已落** = 有实现 + 在生产路径上活着 + 有测试兜底 ｜ **部分落** = 主路径在用，但设计要求里还有一条没接上（行内点名）｜ **未接线** = 口径/定义在，动作面无入口或无人调用（行内说明影响面）｜ **待退役** = 设计已删、实现还留着（行内说明清理条件）。
>
> **快照说明**：本表以 2026-10-18 的工作树为准（v2 代码改造仍在落）。**W1~W4 有落地骨架，但独立审计发现尚未落全**（见下），**W5 仍在实现**——钉卡版本、孤儿回收、不越授 / 不自授、负责人岗位名＋已绑实例分离字段在办。**验证前不把这些写成已落**。
>
> **本批「待验」清单（2026-10-18 独立审计；不粉饰）**：
> - **W1**：复核员仍按**项目全量宽读**（不是任务相关）；复核署名**未核验**在册 / 岗位（代录可绕过独立性）。
> - **W2**：介入挂起成功后**不清**、**无逐项放行绑定**（挂起项与原始写没绑死）。
> - **W3**：晋升**只记声明**、**无产物追踪**（知识条目未生成/未追溯；真源闭环仍缺）。
> - **W4**：旧 `bus_unlock` 仍可对历史节点**追加写**（不是纯只读）；`模式` 字段是**置 `null`** 不是真删；会审实例**缺「不占任务节点」的受管起实例入口**。
> - **W5 在办**：负责人保留岗位名 ＋ **已绑实例单独字段**（条目 11 的衔接）。
>
> **门禁口径**：本表状态以**最终门禁**（`npm test` 全绿）为准；W5 收口前，标「在办 / 待验」的行不作完成结论。

## §2 主体

| 设计 | 实现 | 测试 |
|---|---|---|
| 主权者 / 出厂作者 / Lead / 成员 / **系统** 五类主体 | `SUBJECT_KINDS`（`src/policy.js`） | policy：未知主体 |
| 「系统」= 机制动作的记账主体 | 审计/升级/打回升级写 `{id:'system', kind:'系统'}`（`src/tasks.js`、`src/policy.js`）；总线「系统」类型**仅系统主体可发**（`src/bus.js`） | policy：未知主体；v2-council：系统类型 |
| 复核 = 集体 L3 一张普通岗位卡（无任命 / 池 / 轮派） | 旧任命链（提名 / 池 / 轮派 / 服务层任命）已整体删除；卡在 `mind/集体L3-成员角色卡/复核员.md` | review-path-2026-10-16：member_spawn |
| 复核由 Lead 按任务 `member_spawn` 手动起实例 | **已落**：`member_spawn` 按岗位名派（`lib/actions.js`）；复核员岗的「授权引用」必填已随降级移除，`registry_assign` 只做可选透传 | delegation：按岗位名派；review-path：member_spawn |
| 旧任命链（提名 / 池 / 派单）整体移除 | **已落**：任务图的提名与派单方法已删、`ACTIONS` 不列（留这一行只为记录「删干净了」，不是待办） | review-path-2026-10-16：member_spawn |
| 「只读数、不改、不提案」由策略引擎**按岗位名**判 | **已落**：`#preGrantBoundary` 按 `subject.roleId === '复核员'` 拦全部写动作（`src/policy.js`；P1-05 前移到授权块之前，grant 绕不过） | policy：复核员只读；v2-reviewer-demotion：主体清单 |
| 复核实例读范围 = 任务作用域宽读 | **部分落（W1 待验）**：`sliceForViewer` / `task_criteria` 按 `roleId=复核员` **放宽到项目全量**（读全量、可读任意节点冻结判据），**不是任务相关** | safety：成员只读一片；v2-reviewer-demotion：冲突排除 |
| 冲突排除：执行者 / 交卷人 / 负责人 / 同会话者不得复核本任务 | **部分落（W1 待验）**：`tasks.review` 锁外快拒 + 锁内复检——交卷人（独立答案署名）与负责人（名单）两路都拒；**署名（`复核者` id）未核验在册 / 岗位，代录仍可绕过独立性** | v2-reviewer-demotion：冲突排除；fix-batch-2026-10-14：提审分离 |
| 复核结论 = 硬闸（无「过」不得采纳，「未验」也不得采纳） | `tasks.review` 三态状态机（过⇒已采纳 / 不过⇒已打回 / 未验⇒未验）；`review.record` 返回值只读 | flow：复核三态；flow：未验 |
| 采纳必须**引用**复核结论；Lead 不得改结论 | **已落**：`review(过)` 是进入「已采纳」的唯一迁移（`TRANSITIONS`），采纳事件自带复核者 / 三态 / 分歧清单；Lead 只能 `recordDisagreement` 追加不同意 | flow：结论不可改；v2-reviewer-demotion：豁免也翻不过采纳闸 |
| 免审 = 部署设置**全局开关**（默认关，变更入审计） | **部分落**：`复核免审` 内置默认 + 加载期布尔校验 + `tasks.exemptReview` 读开关（`src/policy.js`）；**手改 `部署.json` 不产生「设置变更」审计**（没有写入动作，也没有审计钩子） | v2-reviewer-demotion：默认关 / 开 / 坏值 |
| 统一实例模型：卡恒久 / 实例临时 / **启动钉卡版本** / 绑任务 / 用后封存 | `src/registry.js` 岗位与实例登记、`status 封存`、岗位闲置读数；**W5 在办**：钉 `cardVersion`（条目 9/10）正在接线，本次任务不背书其完成度 | objects：注册表三例；objects：封存失效 |
| 负责人写岗位名，实例随派绑定；「全员已交」按已绑实例算 | `tasks.create` 收岗位名 + `#assertOwnersSeated` 三条正路；全员已交见 `全员已交()`；**W5 在办**：负责人保留岗位名 ＋ **已绑实例单独字段**（当前实例绑定散在派发事件 / 独立答案里） | flow：任务四例；delegation：并集核对 |
| Lead = 岗位唯一、多会话实例 | 编制单卡 + 多会话各派生 Lead 主体（`src/subject.js`） | host：Lead 主体 |
| 孤儿实例：系统封存，未完成**不自动算成** | **W5 在办**：孤儿回收（条目 12）正在接线；未完成前以「重启后靠节点状态重建、不自动结算」为现状 | objects：索引重建 |
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
| ⑦ **不越授**（Lead 派活的写域 / 工具不得超自身范围） | **W5 在办**：不越授正在策略层接线（`src/policy.js` 在改），本次任务不背书其完成度 | — |
| ⑧ **不自授**（主体不得给自己扩权） | **W5 在办**：⑤ 已覆盖成员与自批；不自授（含 Lead / 复核员侧）正在接线，本次任务不背书其完成度 | policy：成员不得自扩权 |
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
| 审批档 = 每条自治写逐条放行；被拦写挂「待你决定」 | **部分落（W2 待验）**：`审批` 分支 + `decide()` 入账 `介入挂起` + 工作台投影在；**放行后不清挂起、无「逐项放行 ↔ 原始写」绑定** | v2-intervention：审批全拦 + 挂起投影 |
| 设置项仅主权者可改、变更入审计、非法值 fail-closed | 生效闭环 + `#loadDefaults` 加载期校验 | host：生效闭环 |
| 建 / 改 / 删卡 = Lead（复核员卡**不再例外**） | **已落**：自治档 allow；复核者例外 / 分段授权已从 `mind/集体L1-法律/权限矩阵.md` 删除（2026-10-18 文档对齐）；改卡在预审档按 `#预审高风险` 挂起 | policy：宪章/法律档；v2-intervention：四类全拦 |
| 工具总范围 = 主权者 | 出厂 `defaults/工具总范围.json` + `tools.guard` 闸（`lib/index.js`） | host：闸单调 |
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
| 「轮」的定义与分级（全记 / 记汇总 / 不逐次记） | `lib/components/kernel.js` `挂审计` + `GRADE` | host：失败全记 / 轮汇总 |
| **知识 = 晋升-only**（任务内只写经历 / 作答，不得直写知识、改能力库、改卡引用） | **部分落（待核）**：`memory.remember` 对 `成员`（非复核员岗）写「知识」即 Denied；经历 / 作答照常。**与真源口径有差**：设计说「Lead 或记忆整理岗」落笔，但记忆整理岗是成员实例 ⇒ 同样被拒，当前实际只有 Lead 能落笔 | v2-memory：知识 = 晋升动作 |
| **晋升的三个入口**：结账强制 / 工作台兜底 / Lead 手动 | **部分落（W3 待验）**：`tasks.settle` 无「记忆处置」拒收并列出候选（经历 ＋ 交卷知识候选）；工作台把「已采纳未结账」投「待你决定」；Lead 可 `memory_lifecycle op=promote`。**「晋升」目前只记声明，未生成/追踪知识产物**——真源闭环仍缺 | v2-memory：结账强制；v2-memory：工作台兜底 |
| **「通用」记忆命名空间** | **已落**：`项目=通用` 是合法项目键，条目落 `跨项目/` 账并带 `项目: '通用'`；披露闸与跨项目晋升同款 | v2-memory：通用命名空间 |
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
| 「不做讨论、不做权威记录」+ §9 硬规则③「工作台只读」 | 面板无任何写入控件；需要动作的地方给命令文本 | integration：待你决定给命令 |
| 「成员只读自己任务那片」 | `sliceForViewer` 连 `会审` 一起切片 | safety：成员只读一片 |
| §14.4-5「**目录名即项目键**」 | `项目键()`（`lib/components/kernel.js`）从工作区目录派生 | integration：两侧同项目 |

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
| 会审解锁 = 本场会审按人交齐（**历史路径**：任务图节点解锁只服务旧数据） | `council.unlock`（新会审）；`bus.unlock` 硬边界 + 模式闸仅对历史「独立会审」节点生效。**W4 待验**：旧 `bus_unlock` 仍可对历史节点**追加解锁写**，不是纯只读 | v2-council：解锁；fix-batch2-design：解锁边界（历史） |

## §9 接口契约

| 设计 | 实现 | 测试 |
|---|---|---|
| 策略引擎入参 `{主体, 对象 id, 动作}` → 允许/拒绝/需确认 + 理由 | `policy.decide` / `check` | policy：三种结论 |
| 审计入参 `{时间, 主体, 动作, 对象, 依据, 结果}` | `audit.append` | safety：审计 |
| 写操作先过策略引擎，无旁路 | 各服务落盘前 check | objects/flow |
| 拒绝必须带可执行理由 | `Denied.rule/reason/requireAuthority/howToChange` | policy/host |
| 特权读只有策略引擎拥有 | `PolicyEngine` 直接读标签，不经自身判定 | policy：加载 |
| 工作台只读 | `边界: {只读: true}` | safety：投影只读 |
| 授权用**天然凭证**（不立统一对象模型） | 主权者=身份 / Lead=任务节点 / 成员=实例绑定；无统一授权对象表。**W5 在办**：不越授 / 不自授两条不变式正在接线（§3 ⑦⑧），本次任务不背书其完成度 | — |
| **全组织仅剩的授权引用：更正审计**（须引主权者决议） | `audit.correct` 的 `授权引用` 必填（`src/audit.js`） | audit-correction：授权引用 |
| Lead 起实例的入口 = `member_spawn`（岗位 + 节点 + 任务书） | `lib/actions.js` `member_spawn`；岗位卡与判据由机制装载 | delegation：member_spawn |

## §10 会审（独立功能）

> **部分落地，待补修验收**（W4 · 2026-10-18）：`src/council.js` 已有独立事件流存档与
> debate_open/answer/unlock/round/say/converge 六动作；旧数据封写、受管咨询实例起点及并发收口仍按本表待验清单核验。

| 设计 | 实现 | 测试 |
|---|---|---|
| 会审 = 与会话绑定的独立功能，不占任务节点、不走派发 / 复核 / 结账 | `src/council.js`（`CouncilService`，自己的 `councils.jsonl` 事件流）；动作面六个 debate_* 全挂 council；任务图无会审形态 | v2-council：全链路 |
| 会审存档进会审页：问题 / 各份答案 / 分歧 / 结论 / 来源会话 / 时间 | fold 视图六要素齐全；`workbench.会审` = `council.list` 存档行 | v2-council：存档 |
| 配件：提交后解锁（含盲评）留 | `council.unlock` 齐卷揭名；`council.list` 按读者遮盲标（未交齐他人只见盲标） | v2-council：盲评/解锁 |
| 配件：**强制反对者砍** | `pickDissenter`/`#usedDissenters` 已删（`src/review.js`），开启不再指定反对者 | v2-council：发起 |
| 配件：**零分歧报警留**（结论层一致且无人给反例面） | `council.converge` 现算 `judgeZeroDivergence`，命中即审计 `零分歧异常` 并入存档 | v2-council：零分歧 |
| 配件：讨论段**留但默认不开**，预算轮2/人8/每轮24条/每人4000字 | 第一次 `debate_round` = 显式开启；预算快照发起时冻结；边界消息切轮（`src/council.js`） | v2-council：讨论/预算 |
| **一岗多人模式字段取消**（多人只剩并行分担） | **部分落（W4 待验）**：`tasks.create`/`reassign` 不再写 模式、`MULTI_MODES` 已删；但 **fold 出的节点仍带 `模式: null`**（置 null ≠ 真删），历史事件仍折出真值 | flow：一岗多人 |
| 会审参与实例 = 独立实例、不占任务节点 | **待验（W4）**：`debate_open` 只校验参与者「在册在岗」；**起实例仍只有 `member_spawn`（绑任务节点），缺「不占节点的受管起实例」入口** | v2-council：发起（在册校验） |

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
| 旧数据：不迁移、保留、原地只读、不接入检索面 | 私有区新目录与旧 `L0..L3` 并列，不覆盖；读权限走宪章不变式（主权者可读，Lead 需单次确认，其余拒）；任务图历史会审 / 讨论事件只 fold 不迁移。**W4 待验**：旧 `bus_unlock` 仍可对历史节点追加解锁写 | policy：旧数据读权限；v2-council：旧数据只读 |
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

设计没有规定「八件必须挤在一个 `apply` 里」。实现把它拆成**组件**——
也就是插件管理页里那张卡下面的行：每行一个独立包、一个独立开关。

| 组件 | 包 | 对应设计里的什么 | 关掉它的后果 |
|---|---|---|---|
| 内核 | `dsh-mind-kernel` | 八件基础设施 + §5 双区载体 + §8 主干环路，以及对外两个面（工具 / 命令）与闸、审计钩子、提示段 | 那张卡只剩空壳 |
| 安全类 | `dsh-mind-guard` | §4.5 安全类（封闭清单 + 五道配套）+ §5 升级运维面 | 判定与记账照常，没有机制自检 |
| 看板 | `dsh-mind-board` | §7「共享工作台」的**呈现**（投影本身在内核里） | 组织照常跑，只是没人看得见 |

载体形状：`dsh-mind` 是 **bundle 包**（= 那张卡，自己不插行），三个组件包写在它的 `dependencies` 里。
profile 的 `dsh.profile.bundles` **只写 bundle**；写全三个就会变成三张卡。

三条纪律：

1. **所有组件共用同一个 `Org`**（`src/runtime.js` 的键控缓存）——`test/components.test.js` 与 `test/integration.test.js` 盯着。
2. **动作面不重叠**：内核 `mind` 与安全类 `mind_guard` 各自枚举；内核不列它做不到的事。唯一留在内核的升级动作是只读的 `upgrade_pending`。
3. **主面不吞异常**：工具注册不上就等于组件没生效，装载必须如实失败；只有次要面（命令、提示段）才降级为告警。

看板的两处席位：`main`（keyed，key = `dsh-mind`）= 独立面板；`sidebar.footer.action`（list）= 左侧边栏下方入口。
它**不在** `settings.section` 里——看板是常驻运维视图，不是一项设置。

---

## 与设计的自觉偏离

第一处：设计中「目录负责找得到」把八件的**程序**也画在数据目录里（`集体L2-共享基础设施/策略引擎/`）。
实现里八件的程序就是插件本身的模块（`src/*.js`），出厂区目录保留同名位置用于放**声明与默认值**。
理由：程序必须能被宿主直接 import，放进数据目录既加载不了，也会让「随产品更新」失去载体。

第二处：设计把八件当作一个整体，实现按**用得上才装**拆成三个组件；装载粒度变细，对外仍是一张卡。

**第三处（v2 新增，收口中）**：W1~W4 已有实现骨架，独立审计仍发现读域、审批消项、晋升闭环与会审起实例等缺口；钉卡版本、孤儿回收、不越授 / 不自授由 **W5 在办**。完成度以上表逐项证据与最终验收为准，不以批次名代替落实结论。
