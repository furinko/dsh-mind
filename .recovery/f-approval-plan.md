# 补修 F 方案（已按 Lead 两处纠正修订）：介入度三档闭合 · 主权者逐请求放行 · 设置入口与审计

> 状态：域面已落地（`src/intervention.js` / `org.js` / `routes.js` / `policy` 钩子 / `registry` 来源），
> 四路全绿；actions/kernel/workbench/board 的接线等 E 冻结后接。**未 task_submit**。
> 真源：docs/design/v2-口述收敛-2026-10-18.md 条目 13/14/17/20/24 + 节点冻结判据。
> 本轮唯一允许写的方案文件 = 本文件（已随修正更新）。

## 一、现状读数（交接前核实，含反例面）

| # | 读数 | 证据 |
|---|---|---|
| 1 | 三档与预审四类判据已在 | `src/policy.js` INTERVENTION / #preGrantBoundary / #预审高风险 |
| 2 | 「改设置」这一档原先**没接线** | 全仓无 `kind:'设置'` 的 policy 调用点；`presence` 写盘不走 policy |
| 3 | 挂起只有一条审计行、无请求实体 | 无 args、无记录引用、无状态机 |
| 4 | 工作台把挂起**恒报「待放行」** | 按（主体+动作+对象）去重，改档/失败/拒绝后都不变 |
| 5 | 没有审批载体/动作/路由 | 全仓无针对介入度的 approve |
| 6 | 设置页只认 开关/小时 | 无介入度、无复核免审 |
| 7 | 可信人侧通路已存在 | 同源写栅栏 + 宿主 `connection.requestRejection`；命令面专属动作清单 |

## 二、Lead 纠正后的两条硬边界（已落地）

1. **Owner 归属**：主权者主体 `{id:'sovereign', kind:'主权者'}` **只在 `src/intervention.js`
   的人侧函数内部构造**（`人侧决议` / `以人侧身份`）。调用方不能传 subject/kind/role/面；
   模型工具面（mind 工具 enum）没有这些函数。审计行记 主体=主权者 + 依据/详情记通道与
   认证事实。**没有** `context.人侧=true` 之类宽豁免；设置写仍走 policy `kind:'设置'` 闸，
   Owner 因 `kind==='主权者'` 天然不受介入度（自己不批自己），非法模型写照 confirm/deny。
2. **失联**：本人改设置/逐请求决定 = 有效本人交互 ⇒ 调 `markInteraction`
   （来源=`人侧入口`，registry 白名单已加），恢复失联；**恢复 ≠ 批准其他待决**，
   决议只绑它那一单。自动通知/回放/agent-message 不续期（沿用 `source.kind==='user'&&rpcId`）。

## 三、载体与存储（不立统一授权对象）

- **账本（审计行）**：
  - `介入请求`：主体、动作、对象 id=请求指纹、档位、安全摘要（键名/长度/目标 id）、
    **内容指纹 + 记录引用**；
  - `介入决议`：主体=主权者、结果=批准/拒绝/撤销、绑请求指纹+请求行 hash+记录摘要+入口/认证；
  - `介入放行占用` / `介入完成` / `介入失败`：一次性消费三态，真实写成功才完成。
- **私有冻结记录**（正文载体）：`mind-private/介入请求/<请求id>.json`
  - 存**完整原参数** + 原主体/卡版本/目标代/项目/档位/规则/冻结时刻 + 内容摘要；
  - 读限**主权者本人与原申请者**（`读冻结` 校验）；摘要不符即拒（篡改不可当冻结请求）；
  - 主权者批准前由 `人侧待决` 带出完整内容供预览——**不许只看键名/hash 盲批**；
  - 原申请者回放时执行的是这份冻结 `入参`（不是 AI 复述参数），跨重启可追。

## 四、已落地文件

| 文件 | 内容 |
|---|---|
| `src/intervention.js` | 域服务：`记请求` / `读冻结` / `人侧决议` / `以人侧身份` / `记本人交互` / `校验放行` / `记完成` / `记失败` / `投影` / `人侧待决`；`以放行上下文` / `当前放行`（AsyncLocalStorage） |
| `src/org.js` | 装配 `org.intervention`；`卡版本Of` / `目标代Of`（档案钉版摘要 / 任务代 / 文档版本） |
| `src/policy.js` | 只加介入度 confirm 钩子：读 `当前放行`，主体+动作+目标对上才 allow；其余硬闸（不变式/拒名单/失联/复核员只读/父域/硬拒）照判；confirm 的 detail 多 `目标` 供登记请求 |
| `src/registry.js` | 交互来源白名单加 `人侧入口`（仅 Owner 适配器用） |
| `components/kernel/lib/routes.js` | 新端点 `GET/POST /plugins/dsh-mind/intervention`：Connection 认证 + 同源栅栏；GET=`人侧待决`（含完整请求）；POST 只认 `{请求id,决定,理由}` |
| `test/v2-intervention-approval-2026-10-18.test.js` | 18 条（反例优先）：伪 Owner、盲批、篡改记录、参数置换、复用批准、假完成、旧目标、卡版本变、档位改、拒绝/撤销、失联恢复、硬闸不可绕、路由认证、跨项目 |

## 五、动作/目标匹配合同（宏 → 底层策略的唯一翻译层）

**总原则**：宏动作名（`task_create` / `member_spawn` / `task_settle`）**永不参与**策略匹配；
匹配只认「步骤计划」里的底层 `动作 + 目标 kind/id`。计划必须在**任何副作用（含 host 创建子）
之前**由同一条执行链摊出来并冻进请求记录；每步一次性消费（次数可显式声明）；计划外的写
回到正常 confirm/deny；原主体之外的写不匹配；硬拒/失联/复核员/父域先于这一步判定。

**请求/记录形状（已实现）**
- `记请求({..., 步骤: [{序?, 动作, 目标:{kind, id?, 新?, authority?, zone?, project?}, 次数?, 说明?, 预览?}]})`；
  计划长度必须 ≥1（没有计划的批准对应不到任何一次写）。
- `新: true` ⇒ 不认 id（新建对象每次 id 不同）；否则必须 id 相等。
- `预览` = 真正将写的内容/作用（知识正文、任务描述、实例岗位…），进私有记录供 Owner
  批准前预览；审计只留步骤数/内容指纹/记录引用。
- `校验放行` 可传重新摊出的 `步骤`：与冻结计划逐字比（含内容指纹）⇒ 不符即「计划不符」，
  不许拿旧批准跑新计划；`冻结` 返回里带 `步骤`，执行时用 `冻结.入参`。

**三条真链的落法（actions 层）**
1. `task_create`：宏名下底层是 `action:'create'`、target.id 每次新生成。
   计划 = `[{动作:'create', 目标:{kind:'任务', 新:true}, 说明:'建任务节点', 预览:{描述,负责人,判据}}]`；
   重放按 `create + kind=任务 + 新` 匹配 ⇒ 新 id 不影响，宏名不进匹配。
2. `member_spawn`：派发/登记/bind 多个受管步骤，host 创建子有副作用。
   **必须在 host 创建之前**摊计划并拦截（未批 ⇒ 直接 NeedsApproval，不创建子）；批准后重放才进
   host 创建。计划示例：`[{write 任务 id=root}, {create 身份 新, 说明:'登记成员实例', 预览:{岗位,代,委派者}},
   {write 任务 id=root, 说明:'绑定实例'}]`（host 创建不是 policy 写，不进计划）。
   若某步不在计划里：policy 仍 confirm ⇒ 重放以「计划未覆盖」失败落账（占用行已在），不自动重试，
   子已创建的事实留在账上（不假装没发生）。
3. `task_settle` 多候选：计划 = `[{write 任务 id=N, 说明:'结账'}, {create 知识 新, 说明:'晋升候选1',
   预览:{标题,正文}}, …]`，每个候选一步；匹配按 `create + kind=知识 + 新` 逐条消费；第 N+1 条、
   别的 kind、别人 ⇒ 不匹配。候选正文进私有记录（预览真正将写的内容），审计只留步骤数。
   记忆处置里选「丢弃/留账本」的候选不产生写，不进计划。

**幂等/不重复副作用**：批准只够一次执行（占用行先落、每步只用一次，第二次重放在占用处被拒）；
已占用未完成 ⇒ 「占用未报告」，人工复核、不自动重跑；`记完成` 可带
`产出:[{序,kind,id}]` 记录新建对象真实 id。

**校准一 · 重复检查 ≠ 重复副作用（2026-10-18 Lead 真链反例）**：
同一次业务写可能 `policy.decide` 多次（锁外预检 + 锁内复判）。放行上下文按**写入身份**
`(动作, 目标 kind, 目标 id, 写标签)` 记账：同一身份再次来判 ⇒ 幂等放行、**不再消耗一步**；
`新: true` 步的下一个新建会生成新 id（新身份）⇒ 必须再消耗一步，借不到重复检查的豁免。
写标签取 `context.介入写`（首选）或任务图的 `context.节点操作`；计划步可写 `写` 对上它。
（真实 TaskGraph/MemoryService + 双检包装对照见 `test/v2-intervention-chains-2026-10-18.test.js`。）

**校准二 · 同一真实父的重复 confirm 不卡已批准子请求**：
受控父判（不越授）在父结论是「介入度 confirm」时，先用 `本次放行可匹配`（**只 peek、不消费**）
看本次子写是否对上已批准计划步；对上 ⇒ 不再传播这道父确认（真正的子判定点才消费那一步）。
父 deny / 父故障 / 父卡失效（写前凭证闸）仍照旧拒；父的其它 confirm 照旧传播。

## 五之二、下游接线（最小桥合同）

- **actions.js**：
  1. 写 handler 捕获 `NeedsApproval` 且 `detail.介入挂起` ⇒
     `记请求({subject, action, args, 目标: detail.目标, 项目, 档位: detail.档位, 规则: error.rule, 步骤})`，
     rethrow 的 `howToChange` 带 `审批引用=<请求id>`。
  2. 写 handler 见 `args.审批引用` ⇒ `校验放行({请求id, subject, action, 入参: args, 步骤})`；
     `!ok` ⇒ Denied（带 状态/原因）；`ok` ⇒ **用 `冻结.入参` + `冻结.步骤`** 执行原 handler，外面套
     `以放行上下文({原主体: subject.id, 请求id, 步骤: 冻结.步骤})`；成功 `记完成({..., 产出})`、
     异常 `记失败({..., 原因})`。绝不拿模型复述参数执行。
  3. `presence` 设置入口：`面==='command'`（人侧命令/路由）时用
     `以人侧身份({通道, 执行})` 拿主权者主体；设置写仍 `policy.check(kind 设置)`；有写意图后
     `记本人交互()`。merge 键加 `介入度`（三档，非法 fail-closed）/`复核免审`（布尔）。
- **workbench / org**：把「介入挂起」投影换成 `org.intervention.投影({项目})`（状态机、无正文）。
- **board**：设置页加 介入度下拉 + 复核免审开关 + 待审批列表（GET/POST intervention，
  只显示 `人侧待决` 的 `完整请求` 与 `步骤` 预览）。
- **kernel**：命令面 `/mind intervention …`（COMMAND_ONLY，人侧唯一实现）；工具 enum 不加动作。

## 六、验证读数（2026-10-18）

- `node test/preflight.mjs`：通过（30 个内核模块可加载）。
- `node --test "test/*.test.js" "components/board/test/*.test.js"`：**821 pass / 0 fail**。
- `node components/board/test/client-harness.mjs`：**503 断言全过**。
- 新增 18 条反例测试全过（含篡改记录、伪 Owner、参数置换、假完成）。

## 七、共享入口与 UI 已接（2026-10-18，E 正式 freeze 后）

- `lib/actions.js`：写动作**计划预判**（宏动作在副作用前挂起整份计划）/ `审批引用` 重放（`校验放行` → 以放行上下文执行冻结入参 → 记完成/失败）/ 无计划动作被拦时按单步登记；`presence` 扩为设置入口（介入度 + 复核免审，主权者主体由域内构造，先记本人交互再判失联冻结）；新增命令面专属 `intervention_resolve`。
- `lib/approval-plan.js`：宏动作 → 底层写的只读计划器（task_create / member_spawn / task_settle / registry_assign / capability_publish / memory_write），每一步带「真正将写什么」的预览；`计划会挂起` 用 `policy.会挂起` 预判。
- `components/kernel/lib/index.js`：`mind` 工具 schema 增 `审批引用`（enum 不加动作）。
- `src/workbench.js` + `src/org.js`：待你决定改读域服务状态机（类型「介入审批」，含状态/请求id/步骤数/命令），不再从策略拒绝行去重出恒报待放行的影子。
- `components/board/lib/client.js`：设置页加 介入度下拉 + 复核免审开关（只写人改过的键）；新增「待批准」区：完整冻结请求 + 每步预览 + 批准/拒绝/撤销，走同源 `/intervention`。
- `src/policy.js`：会审绑定成员的写面边界（受控父判**之前**判：只允许本场作答/讨论的受限写，其余业务写/派活/能力发布确定拒绝）。
- 入口级真链测试：`test/v2-approval-entry-chains-2026-10-18.test.js`（create / spawn（挂起时 host 未创建子）/ 多候选 settle）、`test/v2-intervention-chains-2026-10-18.test.js`（锁外/锁内复判 + 真实父 confirm）、`test/v2-council-binding-2026-10-18.test.js`。
- 读数：preflight ✔；`node --test` **864 pass / 0 fail**；client-harness **503 断言全过**。
- 单源收口（2026-10-18 第二批）：`tasks.settlePlan` 已落地为**唯一只读归一**（候选/处置/晋升/丢弃/归档意图 + 幂等键），业务 `settle` 与审批步骤计划（`lib/approval-plan.js`）消费同一个结果，不再有第二份复刻；计划零写并有专项反例（审计/任务事件/记忆账本前后逐项相同；非法处置在计划阶段就拒）。

## 八、不做

- 不动 `INTERVENTION` 三档与预审四类清单；不立统一授权对象/新队列库。
- 不动 J 的凭证校验；不新增服务器/重启/改配置。
- 不在 actions/kernel/workbench/board/helpers 未交接前改它们；不提前 `task_submit`。
