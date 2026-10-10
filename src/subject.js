/**
 * 会话事实主体：从执行上下文派生主体（根会话 = Lead，子会话 = 成员）。
 *
 * 为什么从 `components/kernel/lib/index.js` 下沉到这里（2026-10-10 · guard 残留面收口）：
 * `components/guard` 的 `mind_guard` 工具与 `/mind-guard` 命令原先各自硬编码
 * `subjectFor({ 根会话: true })` —— **不读会话事实** ⇒ 任何会话（含成员子会话）调
 * guard 都按 Lead 执行（`docs/设计债-2026-10-10` ⑳ 影响面清点表 #14 点名的残留面）。
 * 修法＝guard 与内核用**同一份**会话事实判据，于是把它抽到 `src/`（组件与内核都能 import），
 * 单源 —— 各抄一份就会漂（P2 的教训：判据抄在哪个入口里，就只有那个入口受保护）。
 *
 * 本文件与 `src/org.js` 的分工：`subjectFor` 管「给定事实（岗位/实例/根会话）怎么落主体形状」；
 * 本文件管「执行上下文（exec）里**哪些是事实**」——两件事一层一层，不许合并
 * （合并后 `subjectFor` 的调用方就得懂 exec，而 exec 是宿主的概念）。
 */
import { subjectFor } from './org.js';

/**
 * 从执行上下文里取主体：**根会话 = Lead，子会话（成员）= 不是 Lead**。
 *
 * 门②（2026-10-10 独立复核实证 · Lead 身份落在可自报字段上）：
 * 修前这里传的是**常量** `根会话: true` ⇒ 任何会话（含成员子会话）的 subject 都是
 * `{kind:'Lead'}` ⇒ `debate_round` / `debate_converge` 的「仅 Lead」判据在模型可达面不承重
 * （成员会话调 `debate_round` 直接放行）。常量的危险在于它**不依赖任何事实**：
 * 换掉它就得给出事实判据。
 *
 * 事实判据**不是**「`parentSession` 存在即成员」——`session/fork` 造的**顶层**会话带
 * `parentSession` 却不带委托语义（`@deepseek-ai/dsh-session` lib/types/types.d.ts:70-76 自陈
 * "fork seed lineage"，与本仓 `E:\DSHOME\packages\dshome\lib\host\mind-inject.js:223-224`
 * 点名的误杀坑一字一致）。本仓既有同款判据**四处**（mind-inject.js:197-208 点名的
 * notify.js:311/368、session-budget.js:293/337、mind-mood.js:418）用的都是
 * `header.origin === 'subagent'`（types.d.ts:81，全文只有这一个取值；写入端唯一一处是
 * dsh-subagent 的 childSessionMeta，三条创建路径共用 ⇒ **所有 in-process 子会话都带它，
 * 而顶层会话这个字段缺席**）。成员子会话正是子代理：`startContinuable` 起的成员走的就是
 * 这条路。于是这里用**同一份事实**，与那四处同口径；`delegationDepth` 只作佐证
 * （types.d.ts:82-87：顶层缺席、子会话 = 父+1）。
 *
 * 三档（顺序即优先级：先判最贵的「子会话事实」）：
 *  1. **有子会话事实**（`header.origin === 'subagent'`，或 `delegationDepth >= 1`）⇒
 *     **不是 Lead**；实例键取**自己的**会话 id（B 修 · 2026-10-10，见 `会话实例键`）。
 *     身份 = **成员**、**不带 `roleId`**（A 修 · 2026-10-10）：会话事实里没有「岗位」这一位，
 *     所以主体不自陈岗位 —— 岗位由 Lead 的显式登记（`registry_assign`，实例 = 该会话 id）
 *     落在身份档案里，主体链对账时按「在册且在岗」放行（见 `docs/设计债-2026-10-09.md` ㉑）。
 *  2. 其余（不是子会话 / 会话事实缺席 / `header` 缺席但 `agent` 在）⇒ **Lead**，
 *     实例取会话 id（W3 批3 既有语义：账上不丢掉「哪一个会话」）。
 *  3. `exec` 整个取不到（不是对象）⇒ **不认 Lead**，落到 `subjectFor({})` 的
 *     `{kind:'成员'}`（无 `roleId`）—— 与 `subjectFor` 自陈的「未知一律不给万能身份，
 *     身份不明时最严」同口径（fail-closed）：实例键是 `unknown`，档案里查不到 ⇒ 拒。
 *
 * 为什么第 2 档**不收窄**「会话事实缺席」那一格（这一档修前就是恒 Lead，修后仍是 Lead）：
 *  · `Session` 恒定带 `header`（`SessionHeader.id` 是 required，types.d.ts:65），
 *    所以「有会话而无 header / 无会话」只出现在**夹具**里，而夹具正是本函数的调用面：
 *    `fakeExec`（test/host-harness.mjs:127）给 `{id, header:{cwd}}`；命令面给
 *    `{agent:{session:{id,header}}}`（test/presence-command.test.js:193）或**裸 `{}`**
 *    （15 处：host.test.js:120/124/128、integration.test.js:36/65/70/90、
 *    presence*.test.js、host-routes.test.js:148/210/257）。裸 `{}` 的语义是
 *    「命令行那条路没带 agent」，**不是**「这是个成员会话」——本轮实测：把它判成成员
 *    会让 26 条既有用例变红（整条 `/mind` 命令面打成拒绝），那是误伤，不是收紧。
 *  · 本轮**要堵的洞**是「**子会话**也恒被当成 Lead」，第 1 档正对着它；第 2 档保持原状
 *    是**刻意不动既有行为**（不动 ≠ 放宽：它修前修后同一读数）。
 *  · 真正 Unknown 的那一格（第 3 档）倒向安全侧 —— 与任务书建议的「拿不到父会话事实
 *    ⇒ 不认 Lead」同向，只是把「拿不到」的判据定在 **`exec` 缺失**，而不是「`header`
 *    缺席」（后者是夹具常态，不是真实形态）。
 *
 * ⚠️ 诚实边界：只到**代码路径级**。真实宿主会话里 `header.origin` / `parentSession` 的
 *    实际形态**未在真实运行态验证过**（本轮没有起真会话）。未取证的那一格（第 2 档末）
 *    沿用修前读数 Lead —— fail-open 的残留面如实记在 `docs/设计债-2026-10-09.md` ⑳。
 * @param {any} exec
 */
export function agentSubject(exec) {
  if (!exec || typeof exec !== 'object') return subjectFor({});
  const session = exec?.agent?.session;
  const 会话id = session?.id;
  const header = session?.header;
  // 第 1 档：子会话事实（同一份事实源，见上）。
  if (header?.origin === 'subagent' || (Number.isInteger(header?.delegationDepth) && header.delegationDepth >= 1)) {
    return subjectFor({ 根会话: false, 实例: 会话实例键(会话id) ?? 'member-unknown' });
  }
  // 第 2 档：不是子会话 ⇒ 根会话 = Lead（既有语义原样）。
  return subjectFor({ 根会话: true, 实例: 会话实例键(会话id) ?? 'lead' });
}

/**
 * 会话实例键：**会话 id 原样 —— 不截断、不加前缀、不换父会话**（B 修 · 2026-10-10）。
 *
 * 修前是 `'session-' + String(键).slice(0, 8)`（`键` = 父会话 ?? 自己的会话 id）。
 * 它坏在一个**没被核实的前提**上：假设会话 id 是短的无前缀串。真实形状不是——
 * 实测（本机 `E:\DSHOME\sessions\` 下 460 个会话目录里 **208 个**形如 `session-<uuid>`，
 * 例如本任务 Lead 的会话 id `session-7fb7087b-c62a-4c64-a6ce-40aab0a78cd9`）
 * ⇒ `slice(0, 8)` **恰好等于** `'session-'` ⇒ 实例键**恒为 `session-session-`**：
 * 审计 / 注册表 / 独立答案里「**哪一个会话**」这一位信息全丢。实测读数见
 * `test/lead-identity.test.js` 的 B 判据（两个不同真实 id 都印出来了）。
 *
 * 为什么这个形状**唯一**（三层论证，都不靠"看起来够长"）：
 *  1. **按契约唯一**：`SessionId` 的定义就是「Identifies one session in the store (and its
 *     persistence artifacts)」（`@deepseek-ai/dsh-session` lib/types/types.d.ts:4-5）
 *     ⇒ 它是会话在 store 里的**主键**：唯一性由身份定义保证，不由长度保证。
 *  2. **同一会话稳定**：`Session.id` 是 getter，派生自 header 的**唯一一份**拷贝
 *     （同包 lib/types/index.d.ts:120-121 "The session identity, derived from its durable
 *     header's single copy"）⇒ 同一会话的两次调用必得同一个键。
 *  3. **不截断 ⇒ 不引入碰撞**：任何截断都是把一个唯一键映射到更小的空间上
 *     （`slice(0, 8)` 就是这个错误的极端形态）。取原样则碰撞面 = 会话 id 本身的碰撞面。
 *
 * 为什么不加 `session-` 前缀：真实 id 大多**已经**带它（208/460 实测），再加一层就是修前
 * 那种「前缀被自己吃掉」的重复；而 `dsh-agent-loop` 另有一条
 * `` `${id}-session-${randomUUID()}` `` 的生成式（lib/index.js:1540）⇒ 会话 id **不保证**
 * 以 `session-` 开头。**对 id 的形状不做任何假设**，是这一版唯一稳妥的写法。
 *
 * ⚠️ **语义变更（如实登记，不是顺手改）**：第 1 档（子会话）修前取**父会话**当实例键
 * （旧注释的理由是「哪个 Lead 起的比会话 id 更稳定」）。那与「实例键 = 哪一个**会话**」
 * 的用途相冲：同一个 Lead 起的两个成员子会话算出**同一个**主体 id ⇒ 「独立答案按主体 id
 * 去重」会把两个人的卷折成一份，注册表也无法把实例登记到具体某个成员
 * （而 A 的修法正需要 `members[<子会话id>]` 这个键）。B 的任务面写的是「唯一标识**会话**」，
 * 故两档统一取**自己的**会话 id。影响面清点见 `docs/设计债-2026-10-09.md` ㉒。
 *
 * @param {unknown} 会话id `exec.agent.session.id`
 * @returns {string|null} 键；取不到给 null，由调用方各自兜底（`'lead'` / `'member-unknown'`）
 */
export function 会话实例键(会话id) {
  return typeof 会话id === 'string' && 会话id.trim() ? 会话id : null;
}
