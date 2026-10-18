# 补修 I 方案：会审受管参与实例（不占任务台账）的最小接线

> 状态：**域面已落并冻结**（2026-10-18）：`council.js` / `registry.js` 会审绑定 / `instance-snapshot.js` /
> 16 条域测。共享入口已由 E 交 F；本阶段**不写 shared 文件**。待 F 交接后由我最后抽同一宿主成员创建 adapter
> 并接 `open/converge`，再做正式门禁与一次交付（**不提前 task_submit**）。
> 本文件是唯一新写文件；未改部署 / 真实数据。
> 节点：`task-补修I-按口述18-19提供不占-dqmkm`（负责人「插件工程」，本实例已钉卡 `75e80a274bc5`）。
> 真源：`docs/design/v2-口述收敛-2026-10-18.md` 条目 10/18/19/20 + 冻结判据；任务书「只读 + 先方案后码」。
> 基线实跑：`v2-council` + `v2-council-concurrency` = **39/39**；新域面 **17/17**；
> `preflight` exit 0（3 组件 / 30 内核模块 / 6 能力卡）。

## 一、现状读数（代码位置为当前工作树）

| # | 事实 | 位置 |
|---|---|---|
| 1 | 会审已有独立事件流、盲评遮罩、会审串行锁、讨论预算/轮边界；`open` 只接受**已登记实例 id** | `src/council.js:55-95, 102-132, 281-357, 493-542` |
| 2 | 创建真实受管成员的唯一适配器在 `member_spawn`：宿主执行体 → `registry.assign`（钉版 + 委派者）→ `cardOf` 就绪 → 开工书 | `lib/actions.js:1323-1535` |
| 3 | `registry.assign` 支持「绑定节点」，不支持「绑定会审」；身份记录是实例绑定的天然载体 | `src/registry.js:436-641` |
| 4 | 工具闸已有一个同步身份快照入口与「复核员只读」闭名单，可同址扩展 | `components/kernel/lib/index.js:543-609`；`src/instance-snapshot.js:24-63` |
| 5 | 策略引擎对成员的会审写已有「名单内放行」，但**没有**「带会审绑定的实例只许本会审」的边界 | `src/policy.js:1394-1425, 1271-1336` |
| 6 | `debate_open` 只解析 `参与者`，没有创建面 | `lib/actions.js:1003-1008` |

结论：缺口只有一处——**合法创建成员的唯一入口强绑任务节点**；会审又必须不占任务图。补法是复用同一适配器/
登记/钉版/父域，把「节点绑定」换成「会审 + 来源会话绑定」，不另造创建器、不立授权对象。

## 二、正式入口与字段（`debate_open` 扩展，旧参数不变）

| 参数 | 语义 |
|---|---|
| `参与者`（旧） | 已登记实例 id（逗号/数组）。**预给参与者：不退役、不停用、原任务权限不变**。 |
| `参与岗位`（新） | 岗位名列表（逗号/数组）。**每个元素创建一个真实受管实例**（可重复同一岗位 = N 个实例）。 |
| `资料`（新） | 发起者提供的绝对路径（文件/目录，逗号/数组）。realpath 归一后冻结进本次会审与实例绑定，是参与实例**唯一**文件读根；不提供则不能读文件。 |
| `方式`（新，可选） | `subagent`（默认）/ `team`；走 `member_spawn` 同一适配分支。 |
| `模型供应商`/`模型`/`推理档`（新，可选） | 与 `member_spawn` 同一成对/透传规则；产品默认缺省继承宿主设置；**本轮所有真实子调用显式 `deepseek-account/deepseek-flash`**，不静默换、team+路由响亮拒。 |
| `来源会话` | **不是参数**：由 `subject.id`（exec 会话事实）强制写入；模型自报值一律忽略。 |

> **复核岗硬边界（Lead 2026-10-18 裁决，不改）**：`参与岗位` 含 `复核员`，或 `参与者` 里有复核员实例，
> 一律在**副作用前** `Denied` 并指路「走真正的复核任务（复核任务 + 显式复核对象 + member_spawn 复核实例）」。
> 不设「跳过复核员只读窄条」——不为齐卷给复核岗开口子。

校验（全部在副作用前）：问题非空；`预给 + 新建` 合计 ≥2 且 ≤ `会审讨论.人数上限`（默认 8）；委托授权
（`DelegationPolicy.authorize`，仅 Lead / 已授权项目）；宿主运行接口在位；Lead 自身钉版就绪；每个岗位卡存在；
`资料` 为绝对路径且真实存在；模型路由成对（team 路不带路由）。

## 三、服务流程（`CouncilService.open` 增三个回调）

`open({ …, 参与岗位, 资料, 创建参与者, 发开场书, 退役实例 })`：

1. **回调缺一 ⇒ 先拒**：`参与岗位` 非空但 `创建参与者`/`发开场书`/`退役实例` 任一不是函数 ⇒
   `Fault(COUNCIL_ADAPTER_NOT_READY)`，零创建、零落线（「必要运行接口未就绪先拒不假成功」）。
2. **慢调用全部在会审锁外；锁只围状态读/append**（`#append` 沿用既有锁序 `council → bus`，短临界区）：
   1. 锁外逐岗位 `创建参与者({会审:id, 项目, 问题, 资料, 岗位, 来源会话, 模型路由})`：
      宿主起执行体（先发「启动自检」待命书）→ `registry.assign({岗位, 实例, 代次, 会审:{id,项目,资料}})` →
      `cardOf(实例)` 就绪读取（钉卡=注入规程的唯一来源）。返回 `{实例, 钉卡}`。
   2. `#append` 在锁内落 `opened` 事件：`参与者 = 预给 + 新建`、`创建实例=[{实例,岗位,卡版本摘要}]`、`资料`、
      `来源会话=subject.id`、`预算快照`（现状字段不动）。
   3. 锁外逐条 `发开场书(...)`：用**钉住的卡**拼 L0/L1 + 能力引用 + 问题 + 资料路径 + 作答/讨论规程；
      要求只走 `debate_answer`（讨论开启后 `debate_say`），不 `task_*`、不写文件、不再派活、不 `memory_write`。
   4. 任一步失败：对**本次已建实例**逆序 `退役实例`（seal → stop，锁外，收集失败）；opened 已落则再走一次
      短锁 `#append` 追加 `aborted`（`状态=作废`），未落则只写「会审创建失败」审计；抛带阶段码的 `Fault`。
      **预给参与者不在补偿名单**；不持会审锁等宿主停机。
3. 只有 `参与者` 的旧路径完全不变（不取锁、不新增字段）。
4. `converge` 落线后（锁外）只退役 `opened.创建实例` 中「仍 在岗 且 `会审绑定.会审 === 本场`」的实例：
   `seal` → stop；结果落 `retired` 事件 + 审计；**预给参与者、别场会审实例不动**；部分失败如实回执
   （不重试 converge，不把它伪装成全成功）。
5. 锁序不变（`council → bus`；本方案 open/retire 不碰总线）。

## 四、实例绑定（复用 `registry.assign`，不立授权对象）

- `assign` 增可选 `会审: {id, 项目, 资料}`：身份记录落 `会审绑定: {会审, 项目, 来源会话, 资料}`，
  **来源会话强制 = 登记主体 id**；只允许 `岗位种类 = 成员` 且**岗位 ≠ 复核员**的实例带此绑定；
  同一实例不得改绑另一场会审；`生命周期` 同步落 `绑定时/绑定会审`（与任务绑定互斥）。
- 不加 `节点`、不写任务图、不增任务事件 ⇒ **任务图节点数不变**。
- `委派者` 仍由 `#委派者事实(subject)` 落（Lead + 其钉住卡摘要）⇒ 现有**受控父判**每次写照跑。
- `instance-snapshot.js` 同步暴露 `会审绑定`（guard 用）。**归一合同**：`会审绑定` 缺失或显式 `null` =
  **无绑定**（只有 registry 会写这个键；旧记录/未绑定的合法形态）；任何非 null 坏形状（非对象/缺 会审/项目/
  来源会话）⇒ 仍然产出**带 `无效` 的对象**，guard 必须按闭名单 fail-closed，**不许折成无绑定**。
- 折叠视图只增 `创建实例`/`退役`/`资料` 三个只读字段，以及 `aborted` 事件折成 `状态=作废`；`opened` 六要素与盲评/预算语义不改。

## 五、权限接线（三处同一判据，防「不是复核岗就全放」）

> 本阶段只落**域服务/登记/快照/测试**；动作面与工具面在 E 的 `actions/kernel` 冻结后接，policy 由 F 落。
> 下面是已冻结的合同（不是已生效读数）。

1. **动作面**（`lib/actions.js` runAction，模型可达的唯一 mind 入口）：带 `会审绑定` 的成员只许
   **显式名单**：`status / workbench / debate_answer / debate_say / capability_list / capability_read / capability_resolve`
   （**capability 不做前缀放行；publish 是写，拒**）；`bus_read` 只许 `线程 === 会审-{绑定.会审}`，
   且读面必须走既有盲评遮罩（服务层 `council.list` 的遮罩 + 工作台切片，不另造读出口）。
   其余动作（`task_* / member_spawn / bus_send / memory_* / registry_* / capability_publish /
   debate_open|unlock|round|converge` …）一律 `Denied`。`debate_answer/say` 的服务层再校验
   `会审绑定.会审 === id`（已落地）。
2. **工具面**（`components/kernel/lib/index.js` 的同一 guard，同步）：带 `会审绑定` 的成员（含坏形状）
   走**闭名单**：只放 `read/glob/grep/read_image`（限 `资料` 根，私有区先拒）、`skill`、`mind`；
   `write/edit/pwsh/bash/subagent/workflow/mind_guard/未知执行类` 全拒（不能改业务、不能再派活）。
   **故障上报通道**：`send_message` 仅允许复用 A 已验证的「只发给真实派发 Lead」函数（`委派者` + 宿主父会话
   唯一对上才放行），不许发给其他成员/再派活；其余收件人拒。坏 `会审绑定`（`无效`）⇒ 全工具拒并说明原因。
3. **策略面**（`policy.#preGrantBoundary` 顶部，F 落）：带 `会审绑定` 的成员，写动作只允许
   `target.kind==='会审' && target.id===绑定.会审 && context.会审.参与者含本人`；其余写一律
   `Denied('会审参与实例 · 只咨询不干活')`。**复核员不设任何例外**（它不会拿到会审绑定——registry 已在
   发起前拒复核岗）；`context.会审` 只由 CouncilService 从自己的事件流构造，不接受模型入参。
4. **父域**：创建即由 `assign` 落 `委派者=Lead`；任何成员写仍走现有受控父判（父无此权/需确认/凭证不齐 ⇒ 子也拒）。
   创建前预检 Lead 钉版就绪，避免「先建后卡」。

## 六、失败补偿与可追矩阵

| 阶段 | 失败时 | 留痕 | 不变量 |
|---|---|---|---|
| 预检（授权/宿主接口/Lead 钉版/岗位卡/资料/路由） | 未创建任何执行体 | Fault 带 `阶段=precheck` + 原因 | 零副作用；任务图/身份/会审账本无新增 |
| 第 k 个 spawn | 停已建 k-1 个 | 审计「会审创建失败」含 已创建[]、阶段、原因 | 不落 opened；预给不动 |
| 第 k 个 assign/钉版 | 停第 k 个（未登记，不能封）+ 停+封已登记的前 k-1 个 | 同上，阶段=registry/card | 不留「已创建未登记」孤儿；不重试 |
| 第 k 个发开场书 | 停+封全部已建 | opened 已落 ⇒ `aborted` 事件 + 审计（阶段=send） | fold 成 `状态=作废`；作答/发言/解锁/收敛一律拒；不假装进行中 |
| converge 退役第 k 个 | 继续其余，回执逐条 | `retired` 事件 + 审计 | 只退役本场创建实例；部分失败明写 |

所有补偿失败也写进 Fault.detail / 审计详情（「清理失败」本身就是可追事实），不吞。

## 七、本阶段已落 / 未落与测试

**已落（域面，2026-10-18）**：
- `src/council.js`：受管 `open`（锁外创建/发送、三回调、opened 冻结、失败补偿、作废、收敛退役、绑定校验、
  作废遮罩）；
- `src/registry.js`：`assign` 的 `会审绑定`（来源会话强制取登记主体、复核员/Lead 岗拒、与节点互斥、
  不可改绑/解除/补绑、生命周期 `绑定会审/绑定时`、审计带会审 id）；
- `src/instance-snapshot.js`：只读 `会审绑定` 归一（无绑定/合法/坏形状带 `无效`，显式 null = 无绑定）；
- `test/v2-council-managed-2026-10-18.test.js`：**17/17 绿**（含全新建 N=2、复核岗先拒、三阶段失败、
  作废遮罩、bus 非答案读面、跨场隔离、慢创建不占锁、父域 deny、退役部分失败、registry 绑定分支、snapshot 归一）。

**未落（共享面已交 F；本阶段不写）**：`debate_open`/`debate_converge` 的参数与适配器接线、runAction 动作闭名单、
kernel 工具闭名单与 `send_message` 受限通道、policy 咨询限制 hunk。E 已 freeze 并把共享入口交 F；F 现独占
`actions/kernel/workbench/board`（接审批与 UI），policy 合同已转 F。**待 F 交接后，由我最后抽「同一宿主成员创建
adapter」并接 open/converge**（与 `member_spawn` 共用同一实现，不留第二入口）——之前不写共享文件。

已跑的域面判据（每条都能变红）：
1. 全流程：N=2 真实登记/钉版、opened 冻结创建实例+卡版本、作答→解锁→收敛、只退役本场；预给/别场不动。
2. 任务图节点数不因咨询增长（`tasks.list` 前后相等）。
3. 绑定字段：会审/项目/来源会话/资料/生命周期；`委派者=Lead`。
4. 复核岗：预给与 `参与岗位` 两条路都在副作用前拒，指路真实复核任务。
5. 先拒：缺适配器、Lead 未钉版、资料相对/不存在/私有区。
6. 部分失败：第二实例 spawn / 钉卡未就绪 / 发送失败 ⇒ 只清本次 owned，审计带阶段/已建/补偿失败；
   opened 未落则不落、已落则 `aborted`（作废）。
7. 作废早卷仍按同一盲评遮罩（不揭名）；作答中答案不在总线（讨论线程解锁后才建），`bus` 不是答案读面。
8. 跨场作答拒；两场隔离退役。
9. 慢创建不占会审锁：创建进行中，同项目另一场会审可继续作答。
10. registry：同绑定幂等；改绑/解除/补绑/复核岗/Lead 岗/节点互斥全拒；seal/restore 保留绑定。
11. snapshot：无绑定不产出字段；坏形状保留 `无效`；显式 null = 无绑定。

**待共享面接上后补**：动作/工具反例矩阵（含 capability 只 list/read/resolve、publish 拒；
`bus_read` 仅本会审线程且走既有遮罩；`send_message` 仅真实派发 Lead）、父域 deny 对照臂、
隔离宿主适配契约（subagent+team 的 signal/parent/agentOptions）、四路全量（preflight / 根+board /
harness / 本批专项）。**域绿不等于端到端。**

## 八、验收判据 → 证据（本阶段口径）

| 冻结判据 | 本阶段证据 | 状态 |
|---|---|---|
| 正式入口创建 N 个真实受管临时实例并完成咨询 | 域服务 N=2/3 测试 + 假适配器调用记录 | 域面绿；入口/动作待 F；adapter 我最后接 |
| 任务图节点数不增长 | 测试 1/2 | 绿 |
| 卡版本与注入规程一致、委派不越父域 | registry 绑定 + 委派者记录；注入规程由最终 adapter 用钉卡拼 | 绑定/委派绿；注入接线待接 |
| 只可读答讨论、不能改业务/再派活 | 服务层跨场/状态/复核岗闸；动作/工具/策略三面待 F/最终接线 | 部分 |
| 盲评遮罩、锁序/预算回归 | 原 39/39 + 本批 17/17（含作废遮罩、bus 非答案读面） | 绿 |
| 会审归真实来源会话、自报无效 | registry 强制 `来源会话=subject.id` + 测试 | 绿 |
| 部分失败可追且清理、预给不动 | 测试 3（spawn/card/send 三阶段）+ 退役部分失败 | 绿 |
| 收敛只退役本场实例 | 测试 1/4 + retired 事件/审计 | 绿 |
| 运行接口未就绪先拒 | 测试 2（缺适配器/Lead 未钉/资料） | 绿（宿主接口预检在共享入口） |
| 四路全绿 + 真实创建适配契约 | 见 §九 读数 | 域面/看板/harness 绿；根套件受 F/E 在飞影响，见 §九 |

## 九、共享面与交接（本阶段边界）

- 已改且只属我的独占面：`src/council.js`、`src/instance-snapshot.js`、`src/registry.js` 的会审绑定小段、
  `test/v2-council-managed-2026-10-18.test.js`、本文件。
- **未碰**：`lib/actions.js`、`components/kernel/lib/index.js`、`src/org.js`、`components/kernel/lib/routes.js`、
  `src/policy.js`；**F 的 registry「人侧入口」白名单未覆盖**（只在 assign 的绑定/生命周期分支加行）。
- 待 F：共享入口/动作面/工具面/审批与 UI（E 已 freeze 交接）；policy 咨询限制 hunk（合同见 §十一）。
- 待我（F 交接后）：抽**同一**宿主成员创建 adapter（与 `member_spawn` 共用），接 open/converge；
  在此之前**不写共享文件**。
- 本阶段读数（2026-10-18 工作树，实跑）：
  - `preflight` exit 0（30 内核模块 / 6 能力卡）；原 `v2-council*` **39/39**；新域面 **17/17**；
    看板 `components/board/test/*.test.js` **21/21**；`client-harness` **503/503**。
  - 根套件：F/E 15:40-15:45 并发写**之前**的一次实跑 **834/834**；并发写期间复跑 **825/835**，
    10 条失败集中在 F/E 在飞的 presence / intervention / 能力发布路径（mtime 证据：`src/policy.js`、
    `lib/actions.js`、`src/org.js`、`components/kernel/lib/routes.js`、`src/intervention.js`、`src/workbench.js`
    在 15:40-15:45 被写），与本批文件无交集。**不声称四路全绿**；等 F 收口后由共享门禁重跑。
  - 这些是域面 + 既有全量读数，不是 I 的端到端：入口/动作/工具/policy 仍待 F 与最终 adapter 接线。

## 十、不做 / 残余

- 不立统一授权对象；不新增任务模式/节点/事件；不复活 `模式`、`强制反对者`、`bus_unlock`。
- 不新增代理/配置/服务器；**不把本轮模型偏好硬编码进产品**（产品默认路由仍按宿主可配置）。
- **本轮不新建真实演员**：flash 咨询创建被止；`openai-codex/gpt-6.1-sol` 当前被 Session 拒（目录只 Luna），
  未开放前不创建真实咨询实例、不静默换模型；只做隔离假宿主 + 真依赖契约。恢复真实创建需 Lead 明确放行并给显式路由。
- 不抢 F 的共享面；不在本阶段声称端到端；F 交接前不写 shared 文件。
- **HMR 口径**：本机 host 半区改动按 `.recovery/reload-contract-20261018.md` 的官方模块 watcher 局部生效，
  不宣称「未重启=旧版」；验收读同一 URL 的 live `mind status` 与真实行为，文件 hash / 离线绿 / 成员 read 成功
  都不替代运行态证据。
- 残余：① 创建成功但 opened 落线前进程崩溃 ⇒ 已登记实例带绑定但无会审存档；guard 会按咨询闭名单锁住它们，
  由孤儿回收按代次封存（不做假恢复）；② team 路停止仍依赖宿主 `listMembers` 现状；③ 真实创建验收需 Lead
  放行并指定显式路由（本轮不静默换）。

## 十一、给 F / 最终 adapter 的短合同（共享入口现归 F）

### F · `src/policy.js`（`#preGrantBoundary` 顶部，约 20 行）

在复核员分支**之前**加（只对成员、只读 `state.identity.members[subject.id].会审绑定`）：

```
if (subject?.kind === '成员') {
  const 绑定 = this.state.identity?.members?.[subject.id]?.会审绑定;
  if (绑定 && action !== 'read') {
    const 本会审 = target?.kind === '会审'
      && String(target.id) === String(绑定.会审)
      && (context?.会审?.参与者 ?? []).includes(subject.id);
    if (!本会审) return deny('会审参与实例 · 只咨询不干活（条目18）',
      `实例 ${subject.id} 只绑定会审 ${绑定.会审}：除本场作答/发言外不得写业务、不得再派活。`,
      { requireAuthority: 'Lead', howToChange: '在绑定会审里作答；要干活走任务台账。' });
  }
}
```

边界：`context.会审` 只由 CouncilService 从事件流构造；**不给复核员任何例外**（registry 已拒复核岗绑定）；
只读不变；父判/凭证闸/介入度照旧先/后判，不绕过。可拷贝本段进 F 的批，不必我改 policy。

### 共享入口（E 已 freeze 交 F；adapter 抽取由我最后做，不在本阶段写）

1. **适配器抽取（F 交接后我做）**：从 `member_spawn` 抽出 `起执行体`（spawn 待命书 + 返回实例/名）、
   `登记钉版`（`registry.assign` + `cardOf` 就绪 + 失败补偿停用）、`发书`（sendMessage）三个私有函数；
   `member_spawn` 与 `debate_open` 共用，**不留第二份创建实现**。`debate_open` 需：
   - 参数：`参与岗位`/`资料`/`方式`/`模型供应商`/`模型`/`推理档`；`参与者` 保留；
   - 先 `要求授权` + 检查宿主接口（`agent`、`startActivation`/`spawnTeammate`、`sendMessage`、
     `interrupt`/`drainChildren`）+ 模型路由成对/team 拒；再调 `org.council.open({...callbacks})`；
   - `创建参与者(spec)` 返回 `{实例, 钉卡}`；`发开场书(spec)` 用 `钉卡.段` 的 L0/L1 + 能力引用 + 问题 +
     资料 + 只咨询规程；`退役实例(spec)` = `registry.seal` → 宿主 interrupt/drain，只按服务给的实例；
   - `debate_converge` 把 `退役实例` 传进 `org.council.converge`（否则退役报告为「未提供适配器」）。
2. **动作闭名单**（runAction，显式名单，不用前缀）：`status/workbench/debate_answer/debate_say/
   capability_list/capability_read/capability_resolve`；`bus_read` 仅当 `args.线程 === 会审-${绑定.会审}`；
   其余（含 `capability_publish`、`member_spawn`、`task_*`、`bus_send`）拒。
   **bus_read 不得成为答案读面**：会审讨论线程只在解锁后才存在；作答中的答案只在
   `councils.jsonl`（服务层 `list` 遮罩），禁止新增直读该文件的出口。任何答案读面（`workbench` / 会审页 /
   `council.list`）必须走同一 `#forViewer` 遮罩；`作废` 态同样遮罩。
3. **工具闭名单**（同一 guard，同步读 `readInstanceSnapshot().成员[id].会审绑定`；有对象即收紧，含 `无效`）：
   放 `read/glob/grep/read_image` 且只限 `资料` 根（先拒私有区；realpath + Windows 小写归一，口径与
   `council.js` 的 `规范路径/在目录内` 一致）、`skill`、`mind`；`write/edit/pwsh/subagent/workflow/mind_guard`
   全拒；`send_message` 只放「真实派发 Lead」——复用 A 已验证的 `复核报告通道`（委派者 + 宿主父会话唯一对上），
   其收件人只能是该 Lead，其他成员/再派活拒。坏 `会审绑定` ⇒ 全工具拒。
4. 模型路由：产品默认按宿主可配置，**不硬编码本轮偏好**；本轮不新建真实演员（flash 被止、sol 路由未开放），
   只做隔离假宿主 + 真依赖契约；恢复真实创建需 Lead 放行并指定显式路由，不静默回落。

## 十二、过程教训（持久）

- **实时依赖源码：定义先落且验证 → 调用后接**，或一次 literal edit **原子替换完整片段**；
  不许「先存调用、另一次 edit 补定义」——本批曾因此让 live 同步 guard 抛 `ReferenceError`，把所有成员
  工具一起锁死（Root 用 `instance-snapshot-before-ht55m.js` 恢复并只补缺失函数）。
- **回归不能靠 `node --check`**：语法检查发现不了未定义的运行期名称。本批判据全部是真实调用
  （registry/snapshot/service + preflight + 全量套件），事件流/审计/身份状态都做正反断言。

