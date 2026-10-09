# dsh-mind 内核接口（冻结版）

> **状态**：这是**建造时**冻结的接口契约，用来让并行实现不跑偏；代码已按其落地。
> 现在读它只有两个用处：查某个模块当时的对外签名，以及看当时为什么这么切。
> 与最终形态的差异以代码为准（例如组件已拆到 `components/{kernel,guard,board}/`）。

> 只允许依赖本文件列出的符号；不得改签名，不得新增第二实现。
> 已存在、不得修改的文件：`src/kernel/{errors,time,ids,fsx,text}.js`、`src/paths.js`、`src/tags.js`、`src/audit.js`、`src/policy.js`。

## 0 · 硬约束（每条都来自设计评审）

1. **零依赖**：不得 import 任何 `@deepseek-ai/*` 或第三方包。只用 `node:*`。
2. **纯 ESM**：文件后缀 `.js`，具名导出。每个导出符号必须有 JSDoc（参数/返回/抛出/副作用）；函数体内注释只写「为什么」。
3. **路径只来自 layout**：`src/paths.js` 的 `Layout` 是唯一的路径来源，禁止手写目录名字面量。
4. **写操作必须过策略引擎**：任何落盘前先 `await policy.check({subject, action, target, context})`。
   拒绝会抛 `Denied`（带 `rule/reason/requireAuthority/howToChange`）、`NeedsApproval`、`Fault`；不得吞掉。
5. **状态可重建**：只有 append-only `.jsonl` 与非派生的 JSON 索引；任何索引都能从账本重算（§12.4）。
6. **并发**：读-改-写用 `withLock` / `mutateLocked`（`src/kernel/fsx.js`）；纯追加用 `appendLines`。
7. **注释语言**：中文，与现有文件一致。

## 1 · 已冻结的公共积木

```js
// src/kernel/errors.js
Denied(rule, reason, {requireAuthority, howToChange, detail})  // .toDecision()
Fault(code, message, {detail, cause}); NeedsApproval(...); InvalidBody(reason, {missing, detail})

// src/kernel/time.js
Clock  // .now() .iso() .ms()
toIso(v); monthKey(v); evaluateSovereignPresence({lastInteraction, responseDeadlineHours, now})
BUILTIN_RESPONSE_DEADLINE_HOURS
MAX_RESPONSE_DEADLINE_HOURS   // 876000（≈100 年）：`响应期限小时` 的**上界**，写前校验（lib/actions.js 的 解析设置小时）与运行时折算（resolveResponseDeadline）引用的**同一个**上界
resolveResponseDeadline(raw) -> {生效, 不合法, 原值, 理由}   // 坏值（含越界的大整数）fail-safe 退 72，并把「不合法」交回调用方报进读数

// src/kernel/fsx.js
ensureDir(file); ensureDirPath(dir); exists(file); readTextOrNull(file); atomicWrite(file, text)
appendLines(file, lines); readJsonl(file); readJsonOrNull(file); listFiles(dir, {filter, recursive})
sha256Hex(v); withLock(lockPath, fn, {staleMs, timeoutMs, onSteal}); sleep(ms)
mutateLocked({file, lockPath, read, apply, serialize}) -> T   // apply(current) => {next, result}

// src/kernel/text.js
digest(v); chainHash(prevHash, entry); canonical(v); normalizeForSearch(t); tokenize(t)
splitClauses(markdown) -> [{key, heading, level, body, hash, start, end}]; summarize(t, max)

// src/kernel/ids.js
slug(text, {maxLength}); shortHash(v, length); objectId(kind, seed, {prefix, at}); kindPrefix(kind)
versionName(n); parseVersionName(name)

// src/paths.js
DIR, MEMORY_KINDS, RULE_FILES, ROLE_CARD_FILES, DEFAULT_FILES, Layout, defaultLayout({home, factoryRoot, privateRoot})

// src/tags.js
AUTHORITY_RANK, KINDS, AUTHORITIES, compareAuthority, highestAuthority, parseSimpleYaml, formatFrontMatter
parseDocument(text, {defaultAuthority}) -> {meta, body, segments, authority, clauses, errors}
assertStructure(kind, doc)  // 不合规抛 InvalidBody；写入侧唯一校验点
authorityOfSegment(doc, heading)

// src/audit.js
GRADE, AuditLog, RoundRecorder, entryFingerprint(row)
// AuditLog: .append(entry) .read(query) .verify() .months() .clearQueue(spec) .gradeOf(action)
// verify() 除链内自洽外还读 anchor 查「尾部截断」（W3 批2，见 §2.16）；read() 排序键 =(月, seq)

// src/policy.js
ACTIONS, SUBJECT_KINDS, INTERVENTION, PolicyEngine, normalizeSubject, extractPolicyBlock
identityStatus(engine, id) -> {known, status, reason}
// PolicyEngine: .reload() .healthy .describe() .decide(input) .check(input) .scopeOf(subject, task)
//               .presence() .intervention() .state
// input = {subject: {id, kind, roleId?, generation?}, action, target: {id, kind, authority, zone, domain, project, segment?}, context?}
// decision = {verdict: 'allow'|'deny'|'confirm', rule, reason, requireAuthority, howToChange, detail?}
```

`parseDocument` 返回的 `meta` 里可能有 `{id, kind, authority, zone, domain, project, version, generation, refs, source, ...}`。

## 2 · 待实现模块（各自独立文件，互不 import 彼此，可 import 上面第 1 节的积木）

### 2.1 `src/tasks.js` — 任务图（状态权威）
```js
export class TaskGraph {
  /** @param {{layout, policy, audit, clock}} spec */
  constructor(spec)
  /** 建节点；判据必填，缺则抛 InvalidBody。
   * @returns {Promise<{id, 描述, 负责人, 判据, 依赖, 状态, 项目, 模式, 打回次数, 创建于}>} */
  async create({ subject, 描述, 负责人, 判据, 依赖, 项目, 模式, 一岗多人 })
  /** 派发；派发后判据冻结（后续任何改判据的事件都拒绝）。
   * @returns {Promise<object>} 更新后的节点 */
  async dispatch(id, { subject })
  async start(id, { subject })
  async submit(id, { subject, 产出物引用, 结论 })
  /** 复核结论：三态 过/不过/未验。结论不经 Lead 修改。 */
  async review(id, { subject, 结论, 分歧清单, 反例面, 复核者 })
  /** 打回：同一节点打回 ≥2 次 ⇒ 升级主权者（节点上出现 升级={原因:'打回≥2'}）。 */
  async reject(id, { subject, 理由 })
  /** 结账（W3 批3）：环路最后一步。前置=已采纳；仅 Lead（policy 的 `settle` 动作守着）；
   *  先归档该项目作答（`MemoryService.archiveAnswers`），再落终态「已结账」；审计动作名「结账」（全记）。 */
  async settle(id, { subject, 项目 })
  /** 待决项是节点状态（§7）。 */
  async markPending(id, { subject, 原因, 待决类型 })
  async resolvePending(id, { subject, 决定 })
  async attach(id, { subject, 产出物 })
  /** 折叠状态；日志缺失/损坏时不抛，返回 {error} 字段。 */
  async get(id, { 项目 })
  async list({ 项目, 状态 })
  /** 供工作台：全量投影输入。 */
  async snapshot({ 项目 })
  /** 事件流原文，供审计/重建。 */
  async events({ 项目 })
}
```
存储：`layout.taskLog(project)` + `layout.taskLock(project)`，事件类型 `created|dispatched|started|submitted|reviewed|rejected|pending|resolved|artifact|escalated|settled`。
每次落盘前 `policy.check({subject, action:'dispatch'|'write'|'review'|... , target:{id, kind:'任务', authority:'自治', project}})`；
每次落盘后 `audit.append({动作:'状态变更', ...})`（结账那一条动作名是「结账」，档位全记）。

**W3 批3**：`create` 的 `依赖` 在锁内校验——指向不存在的节点 ⇒ `InvalidBody`；依赖链成环 ⇒ `Denied`（DFS 三色标记，
范围说清：新节点自己的边不可能成环，这一关实际拦的是「依赖指向空气」与「依赖链上游已经成环」）。

### 2.2 `src/bus.js` — 消息总线
```js
export class MessageBus {
  constructor({layout, policy, audit, clock})
  /** {线程, 发件, 收件, 类型, 内容, 项目, 暂不投递} -> {id, 状态:'已投递'|'暂不投递', 追加于} */
  async send(message)
  /** 只返回本线程消息（线程隔离）。契约B（2026-10-09）：subject 必带并过 policy.check
   *  （action 'read'），放行记一条「只读服务调用」审计（档位=记汇总，一次调用一条）。 */
  async read({ subject, 项目, 线程, 读者, 收件 })
  async deliver(id)
  /** 会审解锁：任务图报「全员已交」→ 解锁并广播（§9 边界写死）。 */
  async unlock({ 项目, 线程, 全员已交 })
  async threads({ 项目 })
}
```
存储：`layout.busThread(project, thread)`；消息 `authority:'只增'`；**历史不入上下文**（本模块只负责存与取，不注入）。

### 2.3 `src/memory.js` — 记忆服务（知道什么）
```js
export class MemoryService {
  constructor({layout, policy, audit, clock, retrieval})
  /** 写入必带 谁记的 + 怎么知道的；写入时校验正文结构，不合规拒写。
   * 类 ∈ 知识/经历/偏好/作答。归属按 §7 表：知识=岗位+项目双标签；经历=组织账本；偏好=部署；作答=实例。 */
  async remember({ subject, 类, 内容, 来源, 项目, 岗位, 标签, 来源引用 })
  /** 契约B（2026-10-09）：subject 必带并过 policy.check（action 'read'）；
   *  放行记一条「只读服务调用」审计（档位=记汇总，一次调用一条，不随命中条数膨胀）。
   *  W3 批2：口径里 `文档数`＝检索面实算的候选数、`条目数`＝账本侧可见条数，**两个数分开报**
   *  （同名覆盖会让 `formatMiss` 的「候选文档数」虚高）。 */
  async query({ subject, 类, 项目, 岗位, 文本, 显式, 读者 })
  /** 契约A（2026-10-09）·血缘查询：上下游闭包 ≤3 层（引用 + 推翻替换链），环安全；
   *  读面与契约B 同款（subject 过判定 + 「只读服务调用」汇总审计）。详见 §2.14。 */
  async lineage({ subject, id })
  /** 不许改写，只能追加：以下四个都是「追加一条状态记录」。 */
  async invalidate(id, { subject, 原因 })
  async demote(id, { subject, 原因 })
  /** 契约A：新条目自动写 派生自=被推翻者 id（调用方不传），并继承 来源引用（证据链连续）。 */
  async overturn(id, { subject, 新条目, 理由 })
  /** 物理删除仅限：敏感数据、主权者明确要求。契约A 三步化（§C8 阻断语义）：
   *  ①待删除状态行 + 下游隔离闭包 ②物理抹源 ③审计含隔离清单；返回值带 下游隔离。详见 §2.14。 */
  async purge(id, { subject, 理由, 敏感 })
  /** 契约C（2026-10-09）：晋升 = 跨项目发布面变宽，先对 标题+内容+标签 过披露机械检查
   *  （清单见 §2.13）；命中即拒（Denied 指向豁免面），Lead 带 披露豁免:true 放行并记
   *  「披露豁免」审计（全记，详情含命中模式名，不含敏感原文）。 */
  async promoteCrossProject(id, { subject, 岗位, 理由, 披露豁免 })
  /** 作答归档 + 归档后可读性矩阵（§7）。 */
  async archiveAnswers({ 项目, 任务 })
  async readableBy(id, { 读者 })
}
```
存储：`layout.memoryLog(scope, kind)`，`scope ∈ {layout 的 跨项目 常量, <项目>}`。
`remember` 里对 `not 知识` 的类必须把 `来源` 写进条目；`知识` 的项目标签恒打、岗位标签默认不打。
`query` 默认把 `作答`（归档后）排除在默认检索面之外，`显式:true` 才返回（§7）。

### 2.4 `src/retrieval.js` — 检索层（BM25 + 长度归一化）
```js
export function buildIndex(docs)   // docs = [{id, 正文, 标签?, 来源?}]
export function search(index, 查询, {limit, 范围})
  // -> {命中:[{id, 分数, 摘要}], 口径:{搜索面, 查询词, 范围, 文档数, 命中数}}
export function formatMiss(口径)   // §11 报「0 命中」必须连口径一起报
export async function runRegression({ 回归集, 基线, 执行 })
  // -> {通过, 用例:[{查询, 期望, 实际, 通过}], 差异}
```
要求：`k1=1.2, b=0.75`；长度归一化必须体现在打分里（§11 治「分母膨胀」）；打分各维同量纲；相同输入必须给出相同排序（稳定排序，分数相同按 id 升序）。
W3 批2：索引期预存 `dl[]`，**与 tf/df 取自同一串 token（正文 + 标签）**——`search` 不再自己
tokenize 正文算长度（同一条文标签多时 dl 与 tf 不同源，分母被算小 ⇒ 分数虚高）。改口径必须跑
`runRegression`，排序差异逐条列出（本批实测：真实语料 5 个查询排序不变、分数按标签量下降；
对抗语料「正文略长 vs 标签多」排序翻转，见提交说明）。
W3 批3：`index.field`（口径里的**搜索面**）改为真实字段集 **`'正文+标签'`**——索引一直取这两个字段，
此前报成 `'正文'`，读的人会以为标签不参与检索。

### 2.5 `src/capability.js` — 能力库（怎么做）
```js
export class CapabilityLibrary {
  constructor({layout, policy, audit, clock})
  /** 两区各一份：出厂能力库（随产品更新）+ 自治能力库（组织自治，永不外流）。 */
  async list({ subject, 岗位 })
  /** 同名不合并：两条都返回并标注来源；默认用自治版；冲突时并列给 Lead 判。
   *  契约B（2026-10-09）：subject 必带并过 policy.check（action 'read'）；
   *  放行记一条「只读服务调用」审计（档位=记汇总，一次调用一条）。 */
  async resolve({ subject, 名 })
  async read({ subject, id })
  /** 发布到自治能力库（永不外流）。 */
  async publish({ subject, 名, 正文, 适用岗位, 依据 })
  /** 角色卡 L2 段只存引用：给出「岗位 -> 能力 id 列表」。 */
  async referencesFor({ 岗位 })
}
```
文件：`layout.capabilityDir('出厂'|'自治')` 下的 `<id>.md`，走 `assertStructure('能力', ...)`。

### 2.6 `src/registry.js` — 角色注册表（索引，不是真源）
```js
export class RoleRegistry {
  constructor({layout, policy, audit, clock})
  /** 从 角色卡（两区）+ 身份档案 重建索引。真源永远是那两处。 */
  async sync()
  async list({ 项目 })
  async get({ id })
  /** 随时能答「这身份能碰什么」。 */
  async canTouch({ id })
  /** 实例权限只来自岗位。W3 批2/批3 的守卫表（都在锁内判）：
   *  没登记→登记；在岗+同岗位→**幂等**返回现状（不写盘/不重置代数/不记审计）；在岗+不同岗位→**拒**（换岗先停岗）；
   *  封存+同岗位→**拒**（那是静默复活，还原走 restore）；封存+不同岗位→允许（这就是 seal→assign 的换岗正路）。 */
  async assign({ subject, 岗位, 实例, 代 })
  /** 封存 ≠ 删除。 */
  async seal({ subject, 实例, 理由 })
  async restore({ subject, 实例 })
  /** 撤回 = 写拒绝名单，不删卡。 */
  async revoke({ subject, 对象id, 理由 })
  async denylist()
}
```
文件：`layout.registryFile()`（索引）、`layout.identityFile()`（身份档案，含 `members/sovereign/denylist`）。

### 2.7 `src/upgrade.js` — 升级：叠加层 + 条款级合并
```js
export class UpgradeManager {
  constructor({layout, policy, audit, clock})
  /** 基线戳：记录出厂件每个条款的哈希。 */
  async stamp({ 版本 })
  async baseline()
  /** 出厂件变更时按 §5 表处置。返回 [{对象, 条款, 处置, diff}]。
   *  处置 ∈ 直接替换 / 保留用户的 / 挂起 / 强制替换 */
  async compare({ 出厂文件, 私有文件, 对象id, 安全类 })
  async pending()
  async resolve({ subject, id, 选择, 理由 })
  /** 可撤回。 */
  async withdraw({ subject, id })
}
```
存储：`layout.baselineFile()`、`layout.pendingDir()/pendingFile(id)`。挂起 **不阻塞** 其他更新。

### 2.8 `src/probes.js` — 安全类（封闭清单）与红线索兵
```js
export class ProbeRunner {
  /** @param {{layout, policy, audit, clock, auditLog, capability, memory}} spec */
  constructor(spec)
  /** 出厂声明：主权者声明探针，出厂作者实现。 */
  async declare()
  /** 跑全部探针。 */
  async run()
  /** 恒红 / 恒绿都要报警（恒亮的灯等于没灯）。 */
  async evaluateHealth()
  /** 探针红 ⇒ 定位「探针全绿的最近一版」＋无条件入账＋告警升级主权者（甲′裁决 2026-10-09）；运行态不自动改文件——执行面＝主权者经版本管理（git/包版本）装回全绿版本。 */
  async autoRollback()
  /** 影响面声明：动了哪些检测逻辑。 */
  async impactStatement({ 机制版本 })
}
```
探针清单（封闭，不得兜底「等其他类似情况」）：
1. `审计链` — 调 `auditLog.verify()`；
2. `闸在位` — `policy.healthy` 为真且 `policy.describe().rules.length > 0`；
3. `出厂件洁净` — 出厂区文本中不得出现用户特定信息（绝对路径、`$DSH_HOME` 下的真实用户名、凭据样式串）；
4. `撤回名单一致` — 身份档案 denylist 与角色卡实际存在性一致。
快照落 `layout.probeSnapshotDir()`；回滚目标 = 最近一次 `全绿:true` 的快照。

### 2.9 `src/review.js` — 复核流程 + 反趋同
```js
export class ReviewProtocol {
  constructor({layout, policy, audit, clock, tasks, bus})
  /** 复核者由主权者确认（Lead 可提名）。 */
  async nominate({ subject, 实例 })
  async appoint({ subject, 实例 })
  /** 复核输出的三态 + 分歧清单 + 反例面。结论不经 Lead 修改。 */
  async record({ subject, 节点, 三态, 分歧清单, 反例面, 复核者 })
  /** Lead 只能「记录不同意」。 */
  async recordDisagreement({ subject, 节点, 理由 })
  /** 强制反对者：系统随机指定一名未参与成员，且不重复。 */
  async pickDissenter({ 项目, 参与者, 候选 })
  /** 一岗多人必须显式声明模式：并行分担 / 独立会审。 */
  async declareMode({ subject, 节点, 模式 })
  async openBlind({ 项目, 线程, 参与者 })   // 提交后解锁：全员交卷后才亮出彼此答案
  async reveal({ 项目, 线程 })
  /** 零分歧报警：判据 = 结论层一致且无人给出反例面。 */
  async checkZeroDivergence({ 节点, 结论集 })
}
```
零分歧命中时：`audit.append({动作:'零分歧异常', ...})` 且触发人工抽检标记。

### 2.10 `src/workbench.js` — 共享工作台（纯投影，无存储）
```js
/** 从任务图 + 日志重算当前状态的唯一视图。可以是纯函数。 */
export function projectWorkbench(input)
// input = {项目, 节点:[...], 待决:[...], 消息线程:[...], 审计尾:[...], 角色:[...], 升级挂起:[...], 探针, 策略, 读者}
// 返回 {项目, 生成于, 我的任务, 全部任务, 待决项, 打回≥2, 探针灯, 策略状态, 升级挂起, 成员, 审计尾, 边界:{只读:true}}
/** 成员只读自己任务那片。 */
export function sliceForViewer(view, 读者)
```
W3 批2（遮罩做在投影这一层）：会审行的 `独立答案` 在**未交齐**时只给 `{盲标}`——
成员、结论、反例面、产出物引用都不出；交齐（`揭名: true`）才全给。
W3 批3：未交齐时**`零分歧` / `零分歧依据` 也不投影**——「这两份一致」本身也是内容级信息
（盲评的意义在于互不可见）；判定照旧用全量答案现算，齐后才给这两个字段。
W3 批5：未交齐时改投影一个**机械读数** `零分歧判定基数`（= 判定实际消费到几条**带结论**的答案，
由全量答案算得；**不含任何人的结论文本**）。它是为了让「判定读的是全量、不是遮罩后的行」
可被断言打红（复核实测：把判定改成读遮罩行时，没有这个读数就全绿）；齐后给判定值本身，不再给基数。
`任务.计数` 增加 `已结账` 桶（环路终态之一；不报它会出现「总数 5、各桶加起来 4」）。

### 2.11 `src/org.js` — 组装（不要动，由 Lead 实现）
把上面各件组装成 `createOrg({home, factoryRoot, privateRoot, project, subject})`。

### 2.12 `presence` 动作 + 状态条失联四态（Batch 1.5 / 2 落地，契约在此冻结）

> 这一节是**已实现**的对外契约（不在第 2 节的"待实现"清单里，写在这里是为了让
> 「读一个模块当时为什么这么切」这件事不至于分散到三个文件）。实现：
> `lib/actions.js` 的 `presence`、`src/policy.js` 的 `presence()`、`src/workbench.js` 的
> `失联态` / `失联详情`、`components/kernel/lib/index.js` 的 `/mind` 命令。

#### 2.12.1 `presence`：失联限制的**人用设置入口**（命令面专属）

```js
// lib/actions.js
export const COMMAND_ONLY_ACTIONS = ['presence', 'sovereign_interaction'];   // 只有人能敲，模型没有这只手
export const COMMAND_ACTIONS = [...ACTIONS, ...COMMAND_ONLY_ACTIONS];
// sovereign_interaction：声明主权者在线（失联判定的事实源只能由人声明）。
```

- **面**：`presence` **不在** `ACTIONS` 里 ⇒ `mind` 工具的 `enum` 里没有它 ⇒ **模型面够不着**。
  工具面调用它必须失败（`test/presence-command.test.js` ⑤ 两侧都断言）。可达性由**两张清单**
  的结构保证，不靠"配方里没写"这种约定。
- **读**：`/mind presence`（不带参数）⇒ 只回报当前生效读数，**不改盘、不入账**。
  ```jsonc
  { "成功": true,
    "action": "presence",              // runAction 的回声
    "读数": { /* policy.presence() 的原样 */ },
    "设置文件": "<私有 部署.json 的绝对路径>",
    "说明": "读：本次没带「开关 / 小时」，没有改任何设置，也没入账（读不是设置入口）。" }
  ```
- **`读数` 的字段稳定性**（`policy.presence()`，三态实测的键集——照它写夹具，别照推断写）：

  | 情形 | 键集 |
  |---|---|
  | 开着且在位 / 开着但已超期 | `失联限制, lost, hours, since, deadline, 生效响应期限小时, 响应期限小时来源, 失联限制来源, 值不合法` |
  | 关着（`失联限制 === false`） | 上面那一串 **＋ `已关闭: true`** |
  | 坏值（期限不合法） | 上面那一串 **＋ `原值, 原值来源, 不合法说明`** |
  | 极值（`lastInteraction` 合法，但 `since + 期限` 越过 `Date` 上界） | 上面那一串 **＋ `判定说明`**，且 `deadline` / `hours` 为 `null`、`lost: true`（**最严**，见 §12.2「查不到 ≠ 放行」） |

  - **`失联限制: boolean` 恒在**（开 `true` / 关 `false`）：它是这个开关的唯一真源；
  - **`已关闭: boolean` 只在关时出现**（它不是"恒在字段"，别在开着时补它）；
  - 坏值才多出 `原值 / 原值来源 / 不合法说明`（合法值带个 `原值: null` 只会让人以为有东西不合法）。
  - ⚠️ 夹具多一个实现没产的字段 = **替实现把缺陷遮住**：浏览器半边曾因此在 195 条门禁全绿的情况下
    漏掉一个真缺陷（见 §2.12.3 的消费者口径）。
- **写**：`/mind presence 开关=否 小时=168`
  - `开关` 只收 `是 / 否`（等价 `true / false`）；
  - `小时` 只收 **`1 ~ MAX_RESPONSE_DEADLINE_HOURS` 之间的整数**（宿主的写前校验
    `lib/actions.js` 的 `解析设置小时`）；**上界 = `876000`**（≈ 100 年）。
    **上界是判据的一部分，不是"输入体检"**：`evaluateSovereignPresence` 要算
    `deadline = since + 小时 × 3600_000`，而 `Date` 能表示的最大时刻是 `8.64e15` ms ——
    越界时 `toIso()` 抛 `RangeError` ⇒ `presence()` 抛 ⇒ `/mind status` 与工作台**一起拿不到状态条**，
    而引擎还报 `healthy`。越界阈值约 `2.4e9` 小时：**一个"合法的大整数"足以把读数面整个打死**。
    取 100 年的理由：语义上它已经等于"永不判失联"（远超任何部署寿命），
    而距 `Date` 上界还有 4 个数量级的安全余量；
  - 落盘是私有 `部署.json`（`Layout.deploymentPrefs()`），**merge 写**（只覆盖这两个键，
    别的键一个不丢）＋ **原子写**（`atomicWrite`）＋ **无条件入账**（`audit.append`，
    动作 `设置变更`，主体记**真实主体**）；
  - 完成后**立刻重载**并回读 `policy.presence()`，返回 `{设置文件, 变更, 无变更, 读数, 说明}`。
- **拒绝形状**（两种拒绝都**一个字节都不改盘**，但都留痕）：
  - 参数非法 ⇒ `InvalidBody` ⇒ `/mind` 命令回
    `{"成功":false, "结果":"结构不合规", "理由":"…（含合法取值）", "缺什么":…}`；
  - 文件坏 / 写不进去 ⇒ 同样拒，`理由` 说明是读不懂还是写不进，`写盘: false`。
  - **注意**：`命令面` 的失败**不会 reject** —— 命令把它包在 `kind:'error'` 的返回体里。
    所以任何调用方（含浏览器半边）**不许把"没抛错"当作"写成功了"**，唯一判据是**回读**。
- **`role=` 参数不再参与身份判定**：命令面的 `role=…` 只是个普通参数，**不用于选身份**。
  旧代码会拿它去映射"复核员"这类身份（`subjectFor({岗位:'复核员'})` ⇒ 复核者），于是
  同一条命令加不加 `role=` 会走出**不同的授权面**。现在命令面的主体一律是**真实会话主体**
  （`runAction({subject, 主体})` 显式传入）。实测差异：同一命令同一参数 `role=复核员`，
  **旧 = deny**（「法律 复核者只读数，不改，不参与提案（§2）」）、**新 = allow**
  （「法律 介入度 · 零参与（§4）」）。已核过这**不新增可达权限面**（旧代码不写 `role` 时
  拿到的就是同样的 Lead 身份）⇒ 不是缺陷；但**`role=` 从此不管用**，别再以为它管用。

#### 2.12.2 `runAction` 的两个参数（命令面用）

```js
await runAction({ org, 项目, subject, 主体, args: { action, ...args }, 面: 'command' });
```

- `面` ∈ `'command'`（人侧 `/mind` 命令）：只有这一面认 `COMMAND_ONLY_ACTIONS`；
- `主体`：命令面**显式**把「敲这条命令的人」传下去（账上不许归并成一个泛化的 `lead`）；
- `subject` 与 `主体` 同源时两处都要给 —— 前者是既有调用约定，后者是"这条命令是谁敲的"这一事实。

#### 2.12.3 `状态条.失联` 是**四态字符串** + `状态条.失联详情`

```js
失联: '在位' | '已失联' | '已关闭' | '未知'
```

| 态 | 判据（顺序即优先级） | 人看到的意思 |
|---|---|---|
| `已关闭` | `presence().已关闭 === true`（**先判它**） | 这个机制被停掉了 —— **不判定失联** |
| `已失联` | `presence().lost === true` | 超期未响应 ⇒ 自治冻结 |
| `在位` | 有读数且 `lost === false` | 主权者一直在 |
| `未知` | 上层没给策略读数，或读数形状读不出结论 | **宿主没给 ≠ 正常** |

- **为什么不能是布尔**：布尔装不下"关了"这件事 —— `lost === false` 同时表示"主权者一直在"
  与"这个机制被停掉了"，读的人分不清。Batch 2 之前 `状态条.失联` 就是布尔，于是
  **关了开关反而显示成"没失联"**，看上去和"主权者一直在"一模一样。
- **`状态条.失联详情`**：把 `presence()` 里的来源 / 坏值标记原样带出来，字段
  `{读数, 已关闭, lost, hours, since, deadline, 生效响应期限小时, 响应期限小时来源,
  失联限制来源, 值不合法, [原值, 原值来源, 不合法说明]}`；**`判定说明` 只在到期时刻越过 `Date` 上界时出现**
  （那时 `lost: true`＝最严、`deadline` / `hours` 为 `null`，说明指向真原因——那**不是**你写坏了设置，
  别去改 `部署.json`）；**没有读数时 `读数: '缺失'`**，
  其余给 `null` / `'未知'`，不给"看起来正常"的默认值。
- **消费者口径（浏览器半边 `components/board/lib/client.js`）——两个消费点，两套输入，别混**：
  这半边有**两处**要判断失联态，它们拿到的**不是同一种东西**，所以走的是**两个不同的函数**：

  | 消费点 | 它读什么 | 走哪个函数 | 渲染 |
  |---|---|---|---|
  | **工作台面板**（`main` 席位） | 宿主**已经归一好的** `状态条.失联`（四态字符串；旧宿主是布尔） | `失联态Of` | `在位` 绿 / `已失联` 红 +「已失联 · 自治冻结」/ **`已关闭` 中性·告警色 +「已关闭（不判定失联）」（绝不给绿点）** / `未知` 灰 +「未接入」 |
  | **设置页**（`settings.section`「心智设置」） | `presence` 命令返回的**读数对象** | `读数对象四态`（对象 → 四态；`已关闭` 先判，再 `读数` 字符串，再 `lost`） | 同上一行四态 |

  旧宿主只给布尔的口径照旧：`true → 已失联`、`false → 在位`、缺 → `未知`（两部分都适用）。
  ⚠️ **别把对象喂给 `失联态Of`**：它只认那四个字符串，收到对象一律返回 `未知` ——
  Batch 4b 的真缺陷就是设置页这么写了，于是三态（关 / 失联 / 在位）**全渲染成「当前 未知」+ 灰点**，
  `已关闭（不判定失联）` 那个分支在设置页**根本不可达**（面板那一侧没这个错，
  因为它读的是宿主已经归一好的字符串）。判据只有一份：**对象→四态**的归一必须显式做一次。

### 2.13 契约B（只读面收窄）+ 契约C（披露机械检查）——主权者裁决 2026-10-09

> 实现落点：`src/{memory,bus,capability}.js`（服务层判定）、`src/policy.js`（部署键加载校验）、
> `src/audit.js`（档位登记）、`lib/actions.js` 与 `components/kernel/lib/index.js`（工具面主体传递）。

#### 2.13.1 契约B · 只读面收窄

- **收窄面**（三个，此前直连不过判定）：`memory.query` / `bus.read` / `capability.resolve`。
- **签名变化**：三者的入参都新增必带 `subject`；缺失 ⇒ 引擎按「未知主体种类」拒绝
  （fail-closed，`Denied` 带 `rule/reason/requireAuthority/howToChange`），**不设默认主体**。
- **判定**：`policy.check({ subject, action: 'read', target, context })`——动作用封闭清单里
  既有的 `'read'`，不新增策略动作。`读者`（归档作答可见性）与 `subject`（判定）分工不变。
- **审计**：放行记动作 **`只读服务调用`**，档位 **`记汇总`**（`src/audit.js` 的 `ACTION_GRADE`
  登记）——**一次调用一条**，绝不随返回条数入账；拒绝路径不入这条账（引擎的
  「策略拒绝」按全记已入账）。表外 fallback 是全记：新只读服务不登记就会记成假档位。
- **工具面**：`lib/actions.js` 的三个 handler 把 `runAction` 的主体链主体（批次3：成员/
  复核者必须与身份档案一致，不许 role 自报即真）传进服务；`mind` 工具 schema 复用既有
  `role` / `实例` 参数，**没有**另开自报主体字段。
- **交互边界（如实记录）**：介入度调到「变更预审 / 逐条审批」时，`'read'` 走自治档
  会被判 `confirm`（`NeedsApproval`）——这是既有 tierRule 语义，本契约未改动。

#### 2.13.2 契约C · 披露机械检查（`promoteCrossProject`）

- **检查面**：标题 + 内容 + 标签 三个面拼接后过敏感模式；命中 ⇒ `Denied`
  （`rule` 含「披露机械检查」，`howToChange` 指向豁免面，`detail.命中模式` 带模式名清单）。
- **默认清单**（`src/memory.js` 的 `DEFAULT_DISCLOSURE_PATTERNS`，大小写不敏感）：
  `[A-Za-z]:\`（Windows 盘符绝对路径）、`\\`（UNC 路径）、`%NAME%`（环境变量引用）、
  email 形态、凭据词表（password / secret / token / 凭据 / 密码 / 密钥）。
- **部署覆盖键**：私有 `部署.json` 的 **`披露敏感模式`**，形状 `[{ "名": string, "正则": string }]`，
  **整体覆盖**默认清单（空值=未写=用默认；写了就用写的，哪怕只有一条）。
  形状坏或正则编译不过 ⇒ `policy.reload()` 响亮抛错 ⇒ 引擎不健康 ⇒ 全部写动作
  fail-closed（§3.6 不许静默失败）。
- **豁免**：`promoteCrossProject(id, { subject, 岗位, 理由, 披露豁免: true })`——
  **仅 `subject.kind === 'Lead'`**（裁决原文如此；主权者不在豁免面，非 Lead 带此参数按越权拒）。
  豁免放行记动作 **`披露豁免`**（档位 `全记`），详情含命中模式名与晋升理由——
  **不含命中片段**（把敏感原文抄进账本等于二次披露）。命中拒绝本身不入账
  （与 `purge` 域内闸同口径；拒绝时引擎侧无「策略拒绝」记录，因为 policy.check 是放行的）。
- **工具面**：`memory_lifecycle` 的 `op=promote` 透传 `披露豁免`（boolean，缺省折 false）。
- **骑手①（补强 2026-10-09）**：披露命中被拒也入账——动作 **`披露拦截`**（档位 `记汇总`），
  一条：主体 + 命中模式名 + 拒绝类型（`命中未豁免` | `豁免越权`），**不抄敏感原文**。
  「有人试过扩散敏感内容被拦」是安全信号，不入账复核者就永远看不到这次企图。
- **骑手②（补强 2026-10-09）**：部署.json `披露敏感模式: []`（空数组）是主权者**显式关闭**
  这道闸——合法且生效（不拦任何模式），但**必须响亮留痕**：引擎加载/重载时按**状态迁移**
  记一条告警档审计，动作 **`披露机械检查已显式关闭`**（`policy.js` 的
  `#warnIfDisclosureDisabled`；持续关闭不重复记，恢复非空再关会再记）。

### 2.14 契约A · 完整血缘（评审稿 §C2/§C8，2026-10-09 主人裁决方案②）

> 实现落点：`src/memory.js`（数据模型 + `buildLineageIndex` / `lineageClosure` / `lineage`
> / purge 三步化 + fold 两态）、`lib/actions.js`（`memory_lineage` 动作 + `memory_write`
> 透传 `来源引用`）、`components/kernel/lib/index.js`（schema）。

#### 2.14.1 数据模型（向后兼容：旧行无新字段照常 fold）

- **`来源引用: string[]`**——这条记忆的证据/来源对象 id 列表。`remember` 接受
  （工具面 `memory_write` 透传，逗号串自动折数组），写入时**存在性校验 fail-closed**：
  | 引用前缀 | 校验面 | 查不到 |
  |---|---|---|
  | `know-` / `exp-` / `pref-` / `answ-` | 记忆账本 `#folded` | `InvalidBody` 悬空引用 |
  | `task-` | 任务图事件流（跨全部项目的 `tasks.jsonl` 出现过该 id） | 同上 |
  | `artifact-` | **本批不校验**（产物库尚无独立账本可查） | 放行 |
  | 其余前缀 | 无法校验 | `InvalidBody` 无法校验的引用 |
- **`派生自: string|null`**——推翻替换链：新条目记被推翻者的 id。**overturn 自动写**
  （`remember` 的内部参数，调用方不传、工具面不透传——血缘是事实不是自报项）；
  overturn 的新条目同时**继承**被推翻者的 `来源引用`（证据链连续）。
- promote 副本经 spread **自然继承**两字段（测试钉住：晋升不丢血缘）。

#### 2.14.2 血缘索引与查询（不变式 #4：可重建、不另立真源）

- `buildLineageIndex(rows)`——**纯函数**，扫账本行（经 fold）出双向关系：
  `引用`（id→它的来源引用）、`被引用`（id→引用它的）、`派生自`、`派生下家`。
  纯投影不落盘，索引丢了从账本重算。
- `lineageClosure(index, id)`——BFS 闭包，**传递深度上限 3**（`LINEAGE_MAX_DEPTH`），
  visited 集**环安全**；`深度读数` 如实报两侧最深层与是否截断。
- `lineage({ subject, id })`——只读 API，返回 `{ id, 上游, 下游, 深度读数 }`；
  读面与契约B 同款（subject 必带过 `policy.check` read；放行记一条「只读服务调用」
  汇总审计，详情 `服务: 'memory.lineage'`）。工具面动作 **`memory_lineage`**。

#### 2.14.3 purge 三步化（§C8 阻断语义；承诺范围升格为「含下游隔离」）

1. 追加 **`待删除`** 状态行入账（源对象自己的删除留痕，行 id 是 `ledger-` 前缀，
   物理抹只按条目行 id 过滤，状态行保留）；按血缘算**下游闭包**（引用它的 +
   派生自它的，传递 ≤3 层、环安全），逐条追加 **`隔离`** 状态行（依据
   「源对象物理删除·血缘阻断」，同账本合并一次追加）；
2. 物理抹源条目（沿用多账本扫描）；
3. 不可逆操作审计记 清理覆盖 + **下游隔离清单**；返回值 `{ 下游隔离: [ids] }`。

- **隔离 ≠ 删除**：下游条目行字节不动，只退出默认召回；`fold` 支持「待删除 / 隔离」
  两态（判据与已失效同为**粘性**——追加过就不再回默认召回，后来的降权不许复活）。
- **读数**：`含失效: true` 可拉回；`口径.隔离条目数` 单独报（与「自身被判错」的
  `失效条目数` 分开——被隔离是因为源被删，不是因为自己错）；无文本查询面也给
  拉回说明。
- 旧行（无血缘字段）下游闭包为空 ⇒ purge 行为与旧版完全一致（不回归）。

### 2.15 W2 · 会审讨论段（2026-10-09 规格冻结）——协作环路的最后一块

> 实现落点：`src/debate.js`（编排层 `DebateService` + 预算/轮次纯函数）、`src/tasks.js`
> （`debate_opened / debate_round / debate_converged` 三事件 + fold 的 `讨论` 子状态
> + 三个受控追加方法）、`src/bus.js`（`readRaw` 内部读）、`src/policy.js`（预算键加载）、
> `src/org.js` / `src/workbench.js`（投影）、`lib/actions.js` + schema + 冻结清单（工具面）。

#### 2.15.1 状态机（任务图事件流为权威，bus 只承载消息）

- 新事件 `debate_opened / debate_round / debate_converged`；fold 后节点长
  `讨论 = { 状态: '讨论中'|'已收敛', 轮次, 轮次上限, 参与者, 预算快照, 表态消息id? }`——
  **节点主状态不动**（已交卷保持：讨论中仍可 review 的软约束由此成立）。
- `debate_open` 前置：节点 状态=已交卷 且 独立答案**齐**（从事件流重算，**不信自报**——
  与 `bus_unlock` 同判据）；参与者 = 独立答案成员数，超过 `人数上限` 拒（提示拆会审）；
  开启时 `review.reveal` 揭名并**冻结预算快照**（判据冻结同哲学：之后改 部署.json
  不影响进行中的讨论）。模式闸：并行分担节点没有讨论段（`debate_opened` 前置拒）。
- `debate_say`：仅参与者、仅讨论中；类型 ∈ **{分歧, 表态, 答复}**；经 `bus.send`
  （**线程 = 节点 id**）落消息；预算闸**现算**（`bus.readRaw` 读线程，不引入第二事实源）：
  本轮消息数 < `每轮消息上限`、该成员本轮累计字符 + 新内容 ≤ `每人每轮字符上限`，
  超限 `Denied` 给读数（`x/y`）。**轮边界靠消息流内部的系统边界消息**
  （`[debate-round] n`，换轮时落线）切轮，不靠时钟对齐。
- **系统类型消息仅系统主体可发**（W2 安全修复 2026-10-09）：`bus.send` 写入面对
  `类型='系统'` 且 `subject.kind !== '系统'` 一律 `Denied`——「系统」是机制保留字
  （轮边界等），任何已知主体自报 发件/类型/内容 三件套伪造轮边界都会洗掉讨论预算。
  配套：`bus_send` 动作面**发件不许自报**（handler 恒以主体链真实 id 为发件人，
  `args.发件` 一律忽略）。unlock 广播（类型='广播'）与 debate.round 真边界
  （subject.kind='系统'）不受影响。
- `debate_round`：轮次 < `轮次上限` 才放行（上限判定在任务图状态机面），否则
  `Denied`「轮次用尽，须收敛」；返回 `结束轮可收敛` 提示 =（本轮零新「分歧」消息
  **且** 每个参与者都发过「表态」）。
- `debate_converge`：**仅 Lead**；Lead 末位 `bus.send`（类型=表态，发件=lead）记消息 id
  进事件；此后 `debate_say` 拒（讨论已收敛）。
- **对 review 是软约束**（设计取舍已定，不许改成硬闸）：讨论中仍可 review，
  工作台会审行标注 `讨论未收敛` / `复核时讨论未收敛`。

#### 2.15.2 预算（部署.json 键 `会审讨论`）

- 默认 `{ 轮次上限: 2, 人数上限: 8, 每轮消息上限: 24, 每人每轮字符上限: 4000 }`
  （`policy.js` 的 `DEFAULT_DEBATE_BUDGET`）；部署.json 的 `会审讨论` 键**部分覆盖**
  （缺键用默认），进 `RUNTIME_DEFAULT_KEYS`，加载期校验：非对象 / 键非 ≥1 整数 ⇒
  响亮抛错 ⇒ 引擎不健康（fail-closed，§3.6）。
- `debate_open` 时把 `每轮消息上限 / 每人每轮字符上限` 冻结进事件（预算快照）；
  进行中的讨论不受之后部署值变化影响；`轮次上限` 取开启时刻的值入事件。

#### 2.15.3 审计与工具面

- 审计：`讨论开启 / 讨论换轮 / 讨论收敛` 各一条（`ACTION_GRADE` 登记 = **记汇总**）；
  `debate_say` 的审计走 `bus.send` 既有路径（规格明定，不另记）。
- 工具面：`debate_open / debate_say / debate_round / debate_converge` 四动作进
  `lib/actions.js` 的 `ACTIONS` + `mind` 工具 schema；主体走批次3身份链（成员发言用
  成员主体）；`test/presence.test.js` 的冻结清单同步登记（白名单关卡，先红后绿）。
- 工作台投影：会审行加 `讨论` 小节 `{状态, 轮次, 本轮消息数, 可收敛, 可收敛说明,
  讨论未收敛?, 复核时讨论未收敛?, 表态消息id}`（读数现算，纯投影；并行分担节点无此
  小节）；board 渲染层同步（`reviewRow` 的 `debateView`）。

### 2.16 W3 批2 · 口径与静默失效（2026-10-09）——四条对外语义

> 这一节记的是**已实现**的对外语义变更（实现散在各文件，这里只留「读的人必须知道的差异」）。

1. **审计自检口径（`src/audit.js`）**
   - `verify()` 逐月除了验链内自洽，还要把**月尾**与 `layout.auditAnchor(month)` 对照：
     `broken[].类型 ∈ {链断裂, 尾部截断, 锚缺失}`。为什么必须这样：砍掉尾部若干行之后，
     剩下的链**仍然自洽**（每行 prev/hash 都对得上它前面那行），删掉「最后一次写入」
     恰好是自检唯一查不出的形状；anchor 是链外的独立留痕。
   - 边界（如实说明）：写入进程若死在 `appendLines` 与 `#writeAnchor` 之间，这一档也会亮——
     它报的是同一件事「尾部那几行没有链外留痕覆盖」，方向是响亮而非静默。
   - `read()` 的排序键是 **(月, seq)**：`seq` 逐月从 1 开始，按它全局排会把两个月交错
     （1 月的第 7 条排到 2 月的第 2 条后面）。`limit` 取的是**最新**的那几条（末月末尾）。
2. **`registry.assign` 守卫**：见 §2.6（封存拒 + 在岗同岗幂等）。
3. **`store.rollback` 的 authority**：取**被回滚版本自己写的**档位
   （`parsed.meta.authority ?? parsed.authority ?? '自治'`），不再硬编码 `法律`；
   `#decorate` 在「文件名 ≠ meta.id」时抛 `InvalidBody`（对象 id 是引用凭据，不许静默换 id；
   meta 里没写 id 仍按文件名兜底）。
4. **工作台会审遮罩**：见 §2.10。
   另外 `MemoryService.stats()` 改为**跨账合并** fold（晋升过的同 id 只计一次，照 `activity()` 先例）。

### 2.17 W3 批3 · 入口与边界（2026-10-09）

> 记的是**已实现**的对外语义（实现散在各文件，这里只留「读的人必须知道的差异」）。

1. **复核者只读命令白名单（`ReviewProtocol.readonlyCommand`）**：`node --test` **已从白名单移除**——
   跑测试会落盘（临时文件 / 快照 / 账本），而且「跑哪个测试文件」由调用方自选 ⇒ 等于一条不经判定的
   写副作用通道，与「只读数，不改」冲突。拒绝时返回 `{允许:false, 依据, howToChange}`，`howToChange`
   指向沙箱区（`sandboxExperiment`）。
   ⚠️ **它是口径/纪律件，尚无运行时调用点**——别把它当成一道活门禁。接线属设计决策
   （复核者的命令面在哪、谁执行、闸挂哪一层），已进设计债清单：**待接线**。
   **实测证据（W3 批5 补，免得下次复核再猜）**：两处 grep 都是「定义之外 0 调用」——
   ① 本仓 `src/` / `lib/` / `components/*/lib/`（只有 `src/review.js` 的定义与测试引用）；
   ② 宿主安装目录 `C:\Users\kuro\.dsh\profiles\desktop\node_modules\dsh-mind`（复核补搜）。
   动作面也没有承载它的入口（`ACTIONS` 里没有对应动作名）。
2. **新动作 `task_settle`（`settle`）**：见 §2.1；权限在 `policy` 的 `settle` 动作里（非 Lead/主权者 ⇒ Denied），
   审计动作名「结账」档位**全记**（它同时改状态与改可见面）。工具面与命令面都可达（`ACTIONS` 里有它，
   `test/presence.test.js` 的冻结清单同步登记）。
3. **`extractPolicyBlock` 坏块不再静默**：解析失败折进 `解析错误[]` ⇒ `collectGrants` / `#loadEstablishment`
   抛错 ⇒ `reload()` 的 catch 落 `state.error` ⇒ `describe()`/健康面见红 + 全部写动作 fail-closed。
   修的是「整部法律的授权块被丢，而引擎照样报 healthy」。
4. **`tags` 转义引号**：`"a \" b"` 的值是 `a " b`（`unquote` 解转义）；注释扫描器同样认转义
   （`\"` 不结束引号，否则行尾注释会被当值留下）。不带引号的值**不解转义**（Windows 路径不许被吃反斜杠）。
   写出侧的引号化在 §2.18 收口（批4 修的真缺陷）。
5. **看板客户端轮询序号**（`components/board/lib/client.js`）：投影与设置两条轮询各有一个递增号，
   响应回来时号比「已应用」小就整条丢掉——**慢响应后到不许盖新快照**（旧读数看起来正常，最难发现）。

### 2.18 W3 批4 · 收口：front matter 写-读往返闭合（2026-10-09）

> 复核挖出的**真缺陷**：`formatFrontMatter`（写侧）从不引号化，而读侧会剥引号、切行内注释、切数组
> ⇒ 自由文本里的 ` # `、行首 `#`、逗号、引号**写-读往返不闭合且静默**（`errors` 为空）。
> 实证：`名='甲 # 乙'` 落盘后再读回是 `'甲'`；`摘要: # 标题式值` 读成空列表；数组 `['a,b','c']` 读成三个。

1. **写侧「需要时才引号化」**（`tags.js` 的 `needsQuote`/`quoteValue`）：值含 ` # `、行首 `#`、`\n`/`\r`、
   引号、反斜杠、首尾空白、空串，或整值形如 `[...]` ⇒ 加双引号并转义 `\` 与 `"`（换行折成 `\n`）；
   **数组逐元素判断**，元素含逗号也引号化。**普通值逐字节不变**——出厂件靠字节比对判「有没有被改」，
   一律引号化会让既有文件当场漂移（有断言：18 件出厂件的 front matter 走 format+parse 字节一致）。
2. **读侧对称**：`unquote` 解 `\` `"` `'` `\n` `\r` `\t`（**只对带引号的值**，不带引号的 Windows 路径
   不解转义）；数组切分改 `splitArrayItems`——**逗号只在引号外才算分隔符**（否则 `["a,b", c]` 会被切成
   `"a` / `b"` / `c`，半截引号进 meta 而 errors 仍为空）。
3. **事实边界（复核问的）**：`ObjectStore.write` 与 `capability.publish` 都走 `formatFrontMatter` ⇒ 同一处修好；
   但 `store.write` **生产零调用点**（只测试调；它的唯一内部调用者 `store.rollback` 也没有运行时入口，
   动作面/路由面都没有承载它）。所以这一批的真实现网是 `capability.publish`（`名` 这类自由文本）。
4. **空串元素的折中**（W3 批5 复核反例：`['']` → `[""]` → 读回 `[]`）：读侧只丢**不带引号**的空元素
   —— legacy 手写 `[a, , b]` 照旧丢空段（老行为不变），而写侧对空串的表示 `""` 保留成空串 ⇒ 往返闭合。

### 2.19 已知边界（写下来是为了下次别重猜）

1. **`withLock` 的 TOCTOU 窗口（W3 批5 登记）**：`finally` 里的「读回锁文件确认令牌 → `rm`」之间
   有一个极窄窗口——确认之后、删除之前，锁文件若被强夺者重建，删掉的仍可能是新持有者的锁。
   实测分母：复核 150 轮 + 40 轮实机压测**未命中**；读码确认窗口存在（两次独立系统调用之间没有原子性可借）。
   为什么不再收：要真原子化得换 `flock`/`O_EXCL` 目录锁这类跨平台语义不同的机制，收益（把窗口从"极窄"
   降到"零"）与代价（Windows 上语义差异、已实测的锁易主留痕路径要重写）不成比例。
   当前防线：①「验后删」已挡住**已确认易主**的那条路（批1）；②进程内 `serializeByKey`（审计链先例）；
   ③`withLock` 的 stale 强夺与 `onSteal` 留痕。**这是已知边界，不是"已解决"**。
2. **`needsQuote` 的触发集**：含 ` # ` / 行首 `#` / 换行 / 引号 / 反斜杠 / 首尾空白 / 空串 / 整值形如 `[...]`
   才引号化。它覆盖的是「不引号化就会读坏」的值；**没有**做成"一律引号化"（那会让出厂件漂移，
   字节比对判据失效）。若将来出现新的读侧规则（例如新的注释/分隔语法），这张表要跟着补。
3. **`formatFrontMatter` 的键顺序**：固定表（`order` + 其余按字典序）——**不保留调用方给的顺序**。
   所以「拿一份文件 parse 再 format」只有在原文件本来就按这张表排时才字节一致（出厂件满足，有断言）。

## 3 · 验收

- `node --test test/` 全绿（Lead 写测试）。
- 每个模块至少一条「拒绝路径」测试：违规操作必须抛 `Denied`/`InvalidBody`，不得静默通过。
- 不得出现 `TODO`、注释掉的代码、未被引用的导出。
