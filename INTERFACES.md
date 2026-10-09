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

## 3 · 验收

- `node --test test/` 全绿（Lead 写测试）。
- 每个模块至少一条「拒绝路径」测试：违规操作必须抛 `Denied`/`InvalidBody`，不得静默通过。
- 不得出现 `TODO`、注释掉的代码、未被引用的导出。
