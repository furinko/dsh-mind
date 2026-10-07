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
存储：`layout.taskLog(project)` + `layout.taskLock(project)`，事件类型 `created|dispatched|started|submitted|reviewed|rejected|pending|resolved|artifact|escalated`。
每次落盘前 `policy.check({subject, action:'dispatch'|'write'|'review'|... , target:{id, kind:'任务', authority:'自治', project}})`；
每次落盘后 `audit.append({动作:'状态变更', ...})`。

### 2.2 `src/bus.js` — 消息总线
```js
export class MessageBus {
  constructor({layout, policy, audit, clock})
  /** {线程, 发件, 收件, 类型, 内容, 项目, 暂不投递} -> {id, 状态:'已投递'|'暂不投递', 追加于} */
  async send(message)
  /** 只返回本线程消息（线程隔离）。 */
  async read({ 项目, 线程, 读者, 收件 })
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
  async remember({ subject, 类, 内容, 来源, 项目, 岗位, 标签 })
  async query({ 类, 项目, 岗位, 文本, 显式, 读者 })
  /** 不许改写，只能追加：以下四个都是「追加一条状态记录」。 */
  async invalidate(id, { subject, 原因 })
  async demote(id, { subject, 原因 })
  async overturn(id, { subject, 新条目, 理由 })
  /** 物理删除仅限：敏感数据、主权者明确要求。 */
  async purge(id, { subject, 理由 })
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

### 2.5 `src/capability.js` — 能力库（怎么做）
```js
export class CapabilityLibrary {
  constructor({layout, policy, audit, clock})
  /** 两区各一份：出厂能力库（随产品更新）+ 自治能力库（组织自治，永不外流）。 */
  async list({ subject, 岗位 })
  /** 同名不合并：两条都返回并标注来源；默认用自治版；冲突时并列给 Lead 判。 */
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
  /** 实例权限只来自岗位。 */
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
  /** 探针红 ⇒ 自动回滚到「探针全绿的最近一版」；策略引擎内置行为：无条件执行 + 无条件入账。 */
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

### 2.11 `src/org.js` — 组装（不要动，由 Lead 实现）
把上面各件组装成 `createOrg({home, factoryRoot, privateRoot, project, subject})`。

## 3 · 验收

- `node --test test/` 全绿（Lead 写测试）。
- 每个模块至少一条「拒绝路径」测试：违规操作必须抛 `Denied`/`InvalidBody`，不得静默通过。
- 不得出现 `TODO`、注释掉的代码、未被引用的导出。
