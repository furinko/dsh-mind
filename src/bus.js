/**
 * 消息总线（§7「结构化通信」）。
 *
 * 四条「必须保证」：
 *  1. **支持暂不投递** —— 消息可以先落账、后投递；状态写在消息上。
 *  2. **线程隔离** —— 读取只按线程取，跨线程只能靠显式遍历。
 *  3. **历史不入上下文** —— 本模块只负责存与取。它**不向任何模型上下文注入内容**，
 *     注入决策属于宿主（§9「上下文 = 按需拉，不许全量推」）。
 *  4. **Lead 表态可标记延后** —— 一条消息可以带 `延后: true`，表示发件人据此保留表态。
 *
 * 消息 `authority = 只增`（§6）：总线里没有修改与删除。
 */
import { appendLines, readJsonl, withLock } from './kernel/fsx.js';
import { InvalidBody } from './kernel/errors.js';
import { objectId } from './kernel/ids.js';

/** 消息类型（§9 接口契约里 `类型` 的取值面）。 */
export const MESSAGE_TYPES = ['派活', '交卷', '复核结论', '分歧', '广播', '表态', '提问', '答复', '系统'];

export class MessageBus {
  /**
   * @param {{ layout: import('./paths.js').Layout, policy: import('./policy.js').PolicyEngine, audit: import('./audit.js').AuditLog, clock: import('./kernel/time.js').Clock }} spec
   */
  constructor(spec) {
    this.layout = spec.layout;
    this.policy = spec.policy;
    this.audit = spec.audit;
    this.clock = spec.clock;
  }

  /**
   * 投递一条消息（可能暂不投递、可能延后表态）。
   *
   * @param {{ subject: object, 项目: string, 线程: string, 发件: string, 收件: string|string[], 类型: string, 内容: string, 暂不投递?: boolean, 延后?: boolean, 引用?: string }} message
   * @returns {Promise<{ id: string, 状态: string, 线程: string, 追加于: string }>}
   */
  async send(message) {
    if (!message.线程?.trim()) throw new InvalidBody('消息必须属于一个线程。', { missing: ['线程'] });
    if (!message.发件?.trim()) throw new InvalidBody('消息必须有发件人。', { missing: ['发件'] });
    const 类型 = message.类型 ?? '表态';
    if (!MESSAGE_TYPES.includes(类型)) throw new InvalidBody(`未知消息类型：${类型}`, { missing: ['类型'] });
    const 内容 = String(message.内容 ?? '').trim();
    if (!内容) throw new InvalidBody('空消息不入总线。');

    const id = objectId('消息', `${message.线程}/${message.发件}/${内容.slice(0, 24)}`, { at: this.clock.ms() });
    await this.policy.check({
      subject: message.subject,
      action: 'create',
      target: { id, kind: '消息', authority: '只增', zone: '私有', domain: '集体', project: message.项目 },
      context: {},
    });
    const 状态 = message.暂不投递 === true ? '暂不投递' : '已投递';
    await withLock(`${this.layout.busThread(message.项目, message.线程)}.lock`, async () => {
      await appendLines(this.layout.busThread(message.项目, message.线程), [
        {
          id,
          线程: message.线程,
          发件: message.发件,
          收件: Array.isArray(message.收件) ? message.收件 : [message.收件],
          类型,
          内容,
          状态,
          延后: message.延后 === true,
          引用: message.引用 ?? null,
          追加于: this.clock.iso(),
        },
      ]);
    });
    await this.audit.append({
      动作: '状态变更',
      主体: message.subject,
      对象: { id, kind: '消息' },
      依据: `消息总线投递 · ${类型}`,
      结果: 状态,
      项目: message.项目,
      详情: { 线程: message.线程, 收件: message.收件 },
    });
    return { id, 状态, 线程: message.线程, 追加于: this.clock.iso() };
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
    if (query.收件) out = out.filter((row) => row.收件?.includes(query.收件));
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
      target: { id: spec.id, kind: '消息', authority: '只增', zone: '私有', domain: '集体', project: spec.项目 },
      context: {},
    });
    // 只增：投递动作也是一条新记录（同 id 的最新状态生效），历史那条「暂不投递」不动。
    // 写入与 send 同一把线程锁：不锁的话并发投递会在 send 的写窗口外落行。
    await withLock(`${this.layout.busThread(spec.项目, spec.线程)}.lock`, async () => {
      await appendLines(this.layout.busThread(spec.项目, spec.线程), [
        { ...target, 状态: '已投递', 投递于: this.clock.iso(), 记录: '投递动作' },
      ]);
    });
    await this.audit.append({
      动作: '状态变更',
      主体: spec.subject,
      对象: { id: spec.id, kind: '消息' },
      依据: '消息总线：暂不投递 → 已投递',
      结果: '已投递',
      项目: spec.项目,
      详情: { 线程: spec.线程 },
    });
    return { id: spec.id, 状态: '已投递' };
  }

  /**
   * 会审解锁（§9 两处边界写死之一）。
   * 任务图报「全员已交」才解锁并广播；没交齐就只能等——这条边界不允许被绕过。
   *
   * @param {{ subject: object, 项目: string, 线程: string, 全员已交: boolean, 参与者?: string[], 内容?: string }} spec
   * @returns {Promise<{ 解锁: boolean, 广播: string|null, 原因: string }>}
   */
  async unlock(spec) {
    if (spec.全员已交 !== true) {
      return { 解锁: false, 广播: null, 原因: '任务图未报「全员已交」，会审保持锁定（提交后解锁）。' };
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
    const { listFiles } = await import('./kernel/fsx.js');
    const files = await listFiles(this.layout.busDir(spec.项目), { recursive: false, filter: (n) => n.endsWith('.jsonl') });
    return files.map((f) => f.replace(/\.jsonl$/, '')).sort();
  }

  /**
   * 每个线程的规模，供工作台显示。
   *
   * @param {{ 项目: string, subject?: object }} spec
   * @returns {Promise<Array<{ 线程: string, 条数: number, 未投递: number }>>}
   */
  async summary(spec) {
    const out = [];
    for (const 线程 of await this.threads(spec)) {
      // 投影没有「谁在读」这个事实，用系统主体过闸——不冒充任何真实身份。
      const rows = await this.read({ 项目: spec.项目, 线程, subject: spec.subject ?? { id: 'system', kind: '系统' } });
      out.push({ 线程, 条数: rows.length, 未投递: rows.filter((r) => r.状态 === '暂不投递').length });
    }
    return out;
  }
}
