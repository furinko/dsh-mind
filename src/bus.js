/**
 * 消息总线（§7「结构化通信」）。
 *
 * 五条「必须保证」：
 *  1. **支持暂不投递** —— 消息可以先落账、后投递；状态写在消息上。
 *  2. **线程隔离** —— 读取只按线程取，跨线程只能靠显式遍历。
 *  3. **历史不入上下文** —— 本模块只负责存与取。它**不向任何模型上下文注入内容**，
 *     注入决策属于宿主（§9「上下文 = 按需拉，不许全量推」）。
 *  4. **Lead 表态可标记延后** —— 一条消息可以带 `延后: true`，表示发件人据此保留表态。
 *  5. **可写预检与 send 同闸** —— `canWrite()` 是同一道闸、同一个 action/target 组合的
 *     「只判定不落盘」版本，供编排层在**指定之前**剔除哑候选（⑮ 收尾②·2026-10-10）：
 *     复核者 / 拒绝名单成员当上「强制反对者」= 面板有名字、发声通道静默失效。
 *
 * 消息 `authority = 只增`（§6）：总线里没有修改与删除。
 */
import { appendLines, listFiles, readJsonl, serializeByKey, withLock } from './kernel/fsx.js';
import { InvalidBody, Denied, Fault } from './kernel/errors.js';
import { objectId } from './kernel/ids.js';
import { 全员已交 } from './tasks.js';

/** 消息类型（§9 接口契约里 `类型` 的取值面）。 */
export const MESSAGE_TYPES = ['派活', '交卷', '复核结论', '分歧', '广播', '表态', '提问', '答复', '系统'];

/**
 * `summary()` 每个线程默认给多少条最新消息（2026-10-12 主权者口径「默认收起、展开看全部」）。
 *
 * 为什么不再是 5：面板要能**折叠**而不是**丢弃**。旧版投影只给 5 条、渲染层还照着
 * 5 条再 `slice(-5)` 一次（纯空操作），于是第 6 条起从源头就没了、连「另有 N 条」都算不出。
 * 现在给得足够宽，由渲染层默认折叠、按需展开；「条数」字段仍是全量真值，
 * 所以即使某线程超过这个数，渲染层也能用 `条数 - 最新.length` 明说还有多少。
 */
export const DEFAULT_LATEST = 50;

export class MessageBus {
  /**
   * @param {{ layout: import('./paths.js').Layout, policy: import('./policy.js').PolicyEngine, audit: import('./audit.js').AuditLog, clock: import('./kernel/time.js').Clock }} spec
   */
  constructor(spec) {
    this.layout = spec.layout;
    this.policy = spec.policy;
    this.audit = spec.audit;
    this.clock = spec.clock;
    // 任务图（可选注入 · 2026-10-13 审查 P2-4）：unlock 的齐卷判定从任务图重算，
    // 不再信调用方布尔自报。装配点（org.js）接上；独立用法（纯函数式夹具）退回自报并如实标注。
    this.tasks = spec.tasks ?? null;
  }

  /**
   * 投递一条消息（可能暂不投递、可能延后表态）。
   *
   * @param {{ subject: object, 项目: string, 线程: string, 发件: string, 收件: string|string[], 类型: string, 内容: string, 暂不投递?: boolean, 延后?: boolean, 引用?: string, 锁内闸?: () => Promise<void> }} message
   *   `锁内闸`（2026-10-14 审查 P2-11）：在线程写锁内、appendLines 之前跑的复检回调——
   *   「读-判-写」类判定（讨论预算闸）的权威一检。抛错即拒写。withLock 是文件锁不可
   *   重入，调用方不能自己先拿锁再调 send，闸只能以回调形式进来。
   * @returns {Promise<{ id: string, 状态: string, 线程: string, 追加于: string }>}
   */
  async send(message) {
    if (!message.线程?.trim()) throw new InvalidBody('消息必须属于一个线程。', { missing: ['线程'] });
    // 发件恒为真实主体 id（2026-10-13 审查 P2-4，服务层收口）：修前直写 `message.发件` 自报——
    // 动作层已封，但任何新内部调用者接上即绕过（防御纵深）。系统主体（轮边界等机制消息）
    // 用主体自己的 id（'system'）；自报发件只作兼容读，不再采信。
    if (!message.subject?.id) throw new InvalidBody('消息必须有发件人（发件恒取真实主体 id，subject 缺席 = 无法投递）。', { missing: ['subject'] });
    const 发件 = String(message.subject.id);
    const 类型 = message.类型 ?? '表态';
    if (!MESSAGE_TYPES.includes(类型)) throw new InvalidBody(`未知消息类型：${类型}`, { missing: ['类型'] });
    const 内容 = String(message.内容 ?? '').trim();
    if (!内容) throw new InvalidBody('空消息不入总线。');
    // 「系统」类型是机制保留字（W2 安全修复 2026-10-09）：会审讨论的轮边界消息靠
    // 发件='system'+类型='系统'+内容前缀 [debate-round] 认定，预算闸按它切轮。
    // 任何已知主体自报这三件套都能落线的话，参与者就能伪造轮边界**洗掉预算**
    // （消息数与字符两道闸一起重置）——所以类型='系统' 只许系统主体发，
    // 其余一律 Denied（unlock 广播类型='广播'、debate.round 真边界 subject.kind='系统'，均不受影响）。
    if (类型 === '系统' && message.subject?.kind !== '系统') {
      throw new Denied(
        '消息总线 · 系统类型仅系统主体可发（W2 安全修复 2026-10-09）',
        `${message.subject?.kind ?? '未知'} 不得发送类型为「系统」的消息：系统类型是机制保留字（轮边界等），伪造它会洗掉讨论预算。`,
        {
          howToChange: '讨论发言用 分歧 / 表态 / 答复；轮边界由 debate_round 机制落线，不接受任何调用方伪造。',
          detail: { 类型, 主体种类: message.subject?.kind ?? '未知' },
        },
      );
    }

    const id = objectId('消息', `${message.线程}/${发件}/${内容.slice(0, 24)}`, { at: this.clock.ms() });
    await this.policy.check({
      subject: message.subject,
      action: 'create',
      target: this.#写入目标(id, message.项目),
      context: {},
    });
    const 状态 = message.暂不投递 === true ? '暂不投递' : '已投递';
    // F4（设计评审 2026-10-15）：在 withLock 外套 serializeByKey（同 key = 线程账本文件）。
    // 与 audit.js append 的双层范例同款：Windows 名字式文件锁有 rm/create 竞态
    // （fsx.js:302-309 自认，审计链曾因此 fork——identity-chain E3），进程内这条
    // await 链保证同线程的写绝不重叠。withLock 不可重入（fsx.js 头注释）：
    // serializeByKey 的 fn 里不得再拿同一把锁（锁内闸回调只读不锁，安全）。
    const 线程账本 = this.layout.busThread(message.项目, message.线程);
    await serializeByKey(线程账本, () =>
      withLock(`${线程账本}.lock`, async () => {
        // 锁内闸（2026-10-14 审查 P2-11）：预算这类「读-判-写」判定的权威一检在这里——
        // 锁外那次是快速失败，并发发言双双过闸的窗口由这一检关掉。
        if (typeof message.锁内闸 === 'function') await message.锁内闸();
        await appendLines(线程账本, [
          {
            id,
            线程: message.线程,
            发件,
            // 收件缺席落 [] 而不是 [undefined]（2026-10-14 审查 P3）：修前 `[undefined]`
            // 经 JSON 序列化变 `[null]`，污染账本行、也让「这条消息发给谁」读出假值。
            收件: message.收件 == null ? [] : (Array.isArray(message.收件) ? message.收件 : [message.收件]),
            类型,
            内容,
            状态,
            延后: message.延后 === true,
            引用: message.引用 ?? null,
            追加于: this.clock.iso(),
          },
        ]);
      }),
    );
    // #14（设计评审 2026-10-15）：消息已落线、审计是第二笔——追加失败时状态已变、链上缺条。
    // 与 tasks.js #append 的 AUDIT_APPEND_FAILED_AFTER_EVENT 包裹同族：错误必须明示
    // 「消息已落线、仅审计缺失」，且不可重试（重试 send = 再落一条同内容消息）。
    try {
      await this.audit.append({
        动作: '状态变更',
        主体: message.subject,
        对象: { id, kind: '消息' },
        依据: `消息总线投递 · ${类型}`,
        结果: 状态,
        项目: message.项目,
        详情: { 线程: message.线程, 收件: message.收件 },
      });
    } catch (error) {
      throw new Fault('AUDIT_APPEND_FAILED_AFTER_EVENT', `消息 ${id}（线程 ${message.线程}）已落线，但审计追加失败：${error instanceof Error ? error.message : String(error)}。不要重试本操作——重试会往线程里再落一条同内容消息；请人工核对审计账本并补记。`, {
        detail: { 消息: id, 线程: message.线程, 项目: message.项目 },
      });
    }
    return { id, 状态, 线程: message.线程, 追加于: this.clock.iso() };
  }

  /**
   * 消息写入的判定 target —— `send` / `deliver` / `canWrite` **共用这一处**。
   *
   * 为什么必须共用：会审的候选池要在「指定强制反对者」之前问一句「这位能不能落消息」，
   * 而那句问话**必须**与 `send` 是同一个 action + 同一个 target 组合。各写一份字面量
   * 迟早会漂（`send` 改了 target 而预检没改 ⇒ 预检放行、真发言被拒，或反过来），
   * 那就又回到了「面板显示他是反对者、他一开口就被闸拒」这个缺陷。
   *
   * @param {string} id 消息 id（预检时用同一款生成器造的占位 id）
   * @param {string} 项目
   */
  #写入目标(id, 项目) {
    return { id, kind: '消息', authority: '只增', zone: '私有', domain: '集体', project: 项目 };
  }

  /**
   * 可写预检：这位主体**能不能往这个线程落一条消息**（⑮ 收尾②·2026-10-10）。
   *
   * 判据与 `send` **同款**：同一个 action（`create`）＋ `#写入目标` 那一个 target 组合，
   * 走同一个唯一判定点（`policy.decide`）。编排层（会审候选池）不许自创一套
   * 「能不能发言」的规则 —— 否则「面板写着他是强制反对者」与「他真的能发声」会漂开。
   *
   * 为什么需要它：候选池若不筛「可写」，复核者 / 拒绝名单成员会被选中，而他一发言就被
   * 策略闸拒（`法律 复核者只读数…` / `撤回 = 写拒绝名单`）⇒ 发声通道（四层里最后一层）
   * 对这类候选**静默失效**，面板却照旧显示「强制反对者：X」。
   *
   * **只判定，不落盘**：不 appendLines、不记「状态变更」；被拒的那一次由 `policy.decide`
   * 按既有口径记一条「策略拒绝」—— 那正是「谁被剔掉了、为什么」的正当留痕。
   * **fail-closed**：判定抛错 / 拿不到结论一律算**不可写**（§12.2 查不到 ≠ 放行）。
   *
   * @param {{ subject: object, 项目: string, 线程: string }} spec
   * @returns {Promise<{ 可写: boolean, 依据: string }>}
   */
  async canWrite(spec) {
    try {
      // 占位 id 用与 send 同一款生成器（同一形状）：target.id 也参与判定
      // （拒绝名单按 id 命中，命中即拒——主体自身被撤回同样走这一条）。
      const id = objectId('消息', `${spec.线程}/${spec.subject?.id ?? 'anonymous'}/预检`, { at: this.clock.ms() });
      const 决定 = await this.policy.decide({
        subject: spec.subject,
        action: 'create',
        target: this.#写入目标(id, spec.项目),
        context: {},
      });
      return 决定.verdict === 'allow'
        ? { 可写: true, 依据: 决定.rule }
        : { 可写: false, 依据: `${决定.rule}：${决定.reason}` };
    } catch (error) {
      return {
        可写: false,
        依据: `可写预检拿不到结论（fail-closed 按不可写处理）：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * 读一个线程。线程隔离是硬边界：这里不会返回别的线程的消息。
   *
   * 契约B（主权者裁决 2026-10-09）·只读面收窄：读取也过唯一判定点。
   * `subject` 缺失或未知 ⇒ 引擎拒绝（fail-closed），不另设默认主体；
   * 放行按「一次调用一条」入账（档位「记汇总」）。内部调用方（`deliver`）
   * 传它自己的主体；纯投影（`summary`）用系统主体——投影不冒充任何人。
   *
   * @param {{ subject: object, 项目: string, 线程: string, 读者?: object, 收件?: string, 未投递?: boolean, limit?: number }} query
   * @returns {Promise<object[]>}
   */
  async read(query) {
    const target = { id: `线程/${query.项目}/${query.线程}`, kind: '线程', authority: '只增', zone: '私有', domain: '集体', project: query.项目 };
    await this.policy.check({ subject: query.subject, action: 'read', target, context: {} });
    // 一次调用一条：读 100 条消息 ≠ 100 条审计。拒绝路径不入这条账（引擎的「策略拒绝」已全记）。
    await this.audit.append({
      动作: '只读服务调用',
      主体: query.subject,
      对象: { id: target.id, kind: '线程' },
      依据: '契约B（2026-10-09）只读面收窄：线程读取也过唯一判定点',
      结果: '放行',
      项目: query.项目,
      详情: { 服务: 'bus.read', 线程: query.线程 },
    });
    return this.readRaw(query);
  }

  /**
   * 内部读取（**不过闸、不入审计**）：折叠后的当前视图，与 `read()` 读同一条线程账本、
   * 走同一段折叠逻辑——同一事实源，只是没有调用方的判定与留痕。
   *
   * 为什么要有它（W2 2026-10-09）：编排层（讨论预算闸、工作台投影）要**现算**线程内容，
   * 走公开 `read()` 会让每次内部计算都过判定并落一条「只读服务调用」——预算闸的读数
   * 会被自己的审计噪音淹没。留痕属于编排动作本身（debate_say 落消息走 bus.send 的
   * 既有审计路径），不属于这一次内部读。
   *
   * @param {{ 项目: string, 线程: string, 收件?: string, 未投递?: boolean, limit?: number }} query
   * @returns {Promise<object[]>}
   */
  async readRaw(query) {
    const rows = await readJsonl(this.layout.busThread(query.项目, query.线程));
    // 只增账按 id 折叠成当前视图（E2）：投递是追加一条同 id 新行，
    // 不折的话一条消息出现两行、「未投递」查询永远命中旧行，状态机不生效。
    const folded = new Map();
    for (const row of rows) {
      const prev = folded.get(row.id);
      if (!prev || String(row.追加于 ?? '') >= String(prev.追加于 ?? '')) folded.set(row.id, row);
    }
    let out = [...folded.values()];
    // 收件过滤同时认单值与数组（2026-10-14 审查 P1-5）：normalizeArgs 会把逗号串拆成
    // 数组，修前这里只按标量 `includes`——数组查数组恒 false，带收件的读取静默返空。
    if (query.收件) {
      const 收件集 = Array.isArray(query.收件) ? query.收件 : [query.收件];
      out = out.filter((row) => 收件集.some((人) => (row.收件 ?? []).includes(人)));
    }
    if (query.未投递 === true) out = out.filter((row) => row.状态 === '暂不投递');
    if (query.未投递 === false) out = out.filter((row) => row.状态 === '已投递');
    return query.limit ? out.slice(-query.limit) : out;
  }

  /**
   * 把一条暂不投递的消息放出去。
   * @param {{ 项目: string, 线程: string, id: string, subject: object }} spec
   * @returns {Promise<{ id: string, 状态: string }>}
   */
  async deliver(spec) {
    const rows = await this.read({ 项目: spec.项目, 线程: spec.线程, subject: spec.subject });
    const target = rows.find((row) => row.id === spec.id);
    if (!target) throw new InvalidBody(`线程 ${spec.线程} 里没有消息 ${spec.id}`);
    if (target.状态 === '已投递') return { id: spec.id, 状态: '已投递' };
    // 「暂不投递 → 已投递」也是一次状态变更，必须与 send 过同一道闸（§9 写无旁路）；
    // 动作取 create：消息是只增对象，投递动作的实现也是追加一条新记录。
    await this.policy.check({
      subject: spec.subject,
      action: 'create',
      target: this.#写入目标(spec.id, spec.项目),
      context: {},
    });
    // 只增：投递动作也是一条新记录（同 id 的最新状态生效），历史那条「暂不投递」不动。
    // 写入与 send 同一把线程锁：不锁的话并发投递会在 send 的写窗口外落行。
    // F4（设计评审 2026-10-15）：外面再套 serializeByKey（同 key = 线程账本文件）——
    // 与 send / audit.js append 同款双层；理由见 send 处注释（Windows 名字锁 rm/create 竞态）。
    const 线程账本 = this.layout.busThread(spec.项目, spec.线程);
    await serializeByKey(线程账本, () =>
      withLock(`${线程账本}.lock`, async () => {
        await appendLines(线程账本, [
          { ...target, 状态: '已投递', 投递于: this.clock.iso(), 记录: '投递动作' },
        ]);
      }),
    );
    // #14（设计评审 2026-10-15）：投递行已落线、审计是第二笔——同 send 的包裹理由：
    // 失败必须明示「已落线、仅审计缺失」且不可重试语义（重投同 id 是幂等的，但审计
    // 缺口要人工补，不能让调用方误判「没投成」反复触发）。
    try {
      await this.audit.append({
        动作: '状态变更',
        主体: spec.subject,
        对象: { id: spec.id, kind: '消息' },
        依据: '消息总线：暂不投递 → 已投递',
        结果: '已投递',
        项目: spec.项目,
        详情: { 线程: spec.线程 },
      });
    } catch (error) {
      throw new Fault('AUDIT_APPEND_FAILED_AFTER_EVENT', `消息 ${spec.id}（线程 ${spec.线程}）的投递记录已落线，但审计追加失败：${error instanceof Error ? error.message : String(error)}。不要重试本操作——投递已生效；请人工核对审计账本并补记。`, {
        detail: { 消息: spec.id, 线程: spec.线程, 项目: spec.项目 },
      });
    }
    return { id: spec.id, 状态: '已投递' };
  }

  /**
   * 会审解锁（§9 两处边界写死之一）。
   * 任务图报「全员已交」才解锁并广播；没交齐就只能等——这条边界不允许被绕过。
   * #9（设计评审 2026-10-15）：注入了任务图时还要求 节点.模式 === '独立会审'（与
   * debate_open 同口径）——并行分担节点交齐不触发「会审解锁」广播。
   *
   * @param {{ subject: object, 项目: string, 线程: string, 全员已交: boolean, 参与者?: string[], 内容?: string }} spec
   * @returns {Promise<{ 解锁: boolean, 广播: string|null, 原因: string }>}
   */
  async unlock(spec) {
    // 齐卷判定从任务图重算（2026-10-13 审查 P2-4）：修前完全信调用方布尔 `全员已交`——
    // 动作层已重算，但服务面任何新调用者接上即绕过。注入了 tasks 就必须给 节点 id 现算
    // （全员已交() 是齐卷判据的唯一源，与遮罩/讨论开启同一把尺）；未注入 tasks 的独立用法
    // 才退回自报布尔，并在原因里如实标注口径。
    let 齐 = spec.全员已交 === true;
    // 未注入 tasks 的独立用法：模式无从验起，口径如实标注（#9 的诚实边界——
    // 动作面 bus_unlock 恒注入 tasks，真实部署不走这条兜底）。
    let 口径 = '调用方自报（未注入任务图，无法重算；模式亦未验）';
    if (this.tasks) {
      if (!spec.节点) throw new InvalidBody('unlock 需要 节点（任务节点 id）：齐卷判定从任务图独立答案重算，不收自报布尔。', { missing: ['节点'] });
      const node = await this.tasks.get(spec.节点, { 项目: spec.项目 });
      if (!node) throw new InvalidBody(`没有这个任务节点：${spec.节点}（项目 ${spec.项目}）`);
      // #9（设计评审 2026-10-15）· 模式闸：会审解锁只属独立会审（与 debate_open 同口径）。
      // 修前只判 全员已交 不查模式 ⇒ 并行分担节点交齐也触发「会审解锁」广播——并行分担
      // 没有盲评环节，「全员已交，现在可以亮出彼此的答案」对它是语义错配的系统消息
      // （单人节点默认无模式的 P2-13 修后，这类节点同样不该吃到会审广播）。
      if (node.模式 !== '独立会审') {
        throw new Denied(
          '会审解锁 · 只属独立会审（§10）',
          `节点 ${spec.节点} 的模式是「${node.模式 ?? '未声明'}」：会审解锁广播（全员已交后亮出彼此答案）只属独立会审；并行分担/单人节点没有盲评环节，交齐即复核，不需要「解锁」。`,
          {
            howToChange: '独立会审节点交齐后自动满足本判据；并行分担节点直接走复核（review），不要调 bus_unlock。',
            detail: { 节点: spec.节点, 模式: node.模式 ?? null },
          },
        );
      }
      齐 = 全员已交(node);
      口径 = `任务图重算（状态=${node.状态}，答案 ${(node.独立答案 ?? []).length}/${(node.负责人 ?? []).length}）`;
    }
    if (!齐) {
      return { 解锁: false, 广播: null, 原因: `任务图未报「全员已交」（${口径}），会审保持锁定（提交后解锁）。` };
    }
    // 幂等下沉服务层（2026-10-14 审查 P3）：修前幂等只在动作层（actions.js bus_unlock），
    // 任何直调服务层的新调用者都会重复广播。判据与动作层同源：线程里已有 system 的「广播」。
    const 既有 = await this.readRaw({ 项目: spec.项目, 线程: spec.线程 });
    if ((既有 ?? []).some((m) => m.类型 === '广播' && m.发件 === 'system')) {
      return { 解锁: true, 广播: null, 原因: '该线程已解锁过（幂等）：解锁广播一个节点只发一次，不重复落线。' };
    }
    const broadcast = await this.send({
      subject: { id: 'system', kind: '系统' },
      项目: spec.项目,
      线程: spec.线程,
      发件: 'system',
      收件: spec.参与者 ?? [],
      类型: '广播',
      内容: spec.内容 ?? '全员已交，会审解锁：现在可以亮出彼此的答案。',
    });
    await this.audit.append({
      动作: '状态变更',
      主体: spec.subject,
      对象: { id: spec.线程, kind: '线程' },
      依据: '§9 边界写死：会审解锁 = 任务图报「全员已交」',
      结果: '解锁并广播',
      项目: spec.项目,
    });
    return { 解锁: true, 广播: broadcast.id, 原因: '全员已交' };
  }

  /**
   * 项目里出现过的线程（目录即真相，不需要额外索引）。
   * @param {{ 项目: string }} spec
   * @returns {Promise<string[]>}
   */
  async threads(spec) {
    // listFiles 顶部静态导入（2026-10-14 审查 P3：修前此处动态 import，每次调用重付一次模块解析）。
    const files = await listFiles(this.layout.busDir(spec.项目), { recursive: false, filter: (n) => n.endsWith('.jsonl') });
    return files.map((f) => f.replace(/\.jsonl$/, '')).sort();
  }

  /**
   * 每个线程的规模与最新消息，供工作台显示。
   *
   * ⑦（2026-10-11）设计债③收口：投影取数改走 `readRaw`（内部读，不过闸、不入审计）——
   * 与 `讨论消息` 同口径：看板按秒级轮询，走公开 `read()` 会让「只读服务调用」
   * 按线程×轮询刷屏，淹没真正的留痕；留痕属于编排动作，不属于投影取数。
   *
   * **正文与条数口径（2026-10-12 主权者改口径：默认收起、展开看全部）**：
   * 旧版在这里就把正文截到 120 字、且只给最新 5 条 —— 截断发生在**投影层**，
   * 于是渲染层手里根本没有全文，「展开」无从谈起，且超出的条数**算不出「另有 N」**。
   * 现在改成：正文给**全量**（`内容`），另附 `正文原长` 供渲染层判断要不要给展开钮；
   * `最新条数` 默认也放宽到 `DEFAULT_LATEST`，让面板能折叠而不是丢弃。
   * 面板仍是「扫一眼的面」——收窄动作挪到**渲染层**（默认折叠 3 行 + 展开钮），
   * 而不是在数据源头把信息删掉。全文检索/审计仍走 `bus_read`。
   *
   * @param {{ 项目: string, 最新条数?: number }} spec `最新条数` 省略时取 `DEFAULT_LATEST`
   * @returns {Promise<Array<{ 线程: string, 条数: number, 未投递: number, 最新: object[] }>>}
   */
  async summary(spec) {
    const out = [];
    for (const 线程 of await this.threads(spec)) {
      const rows = await this.readRaw({ 项目: spec.项目, 线程 });
      out.push({
        线程,
        条数: rows.length,
        未投递: rows.filter((r) => r.状态 === '暂不投递').length,
        最新: rows.slice(-(spec.最新条数 ?? DEFAULT_LATEST)).map((row) => {
          const 正文 = String(row.内容 ?? '');
          return {
            id: row.id,
            发件: row.发件,
            类型: row.类型,
            内容: 正文,
            // 原长：渲染层据此决定「折叠预览」还是直接铺开（截断判断挪到渲染层）。
            正文原长: 正文.length,
            状态: row.状态,
            追加于: row.追加于,
          };
        }),
      });
    }
    return out;
  }
}
