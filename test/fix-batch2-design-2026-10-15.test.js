/**
 * 设计评审修复批次 B 回归（对应 docs/design/设计评审报告-dsh-mind-2026-10-15.md 的
 * F3 / F4 / #9 / #14 四条；批次 A 的 F1/F2/F2b/F5/#13/#15 见 test/fix-batch-design-2026-10-15.test.js）。
 *
 *  F3  debate 齐卷 TOCTOU + 三事件游离 TRANSITIONS——齐卷检查通过后、debateOpened 落线前，
 *      节点被 review(过) 推进到已采纳 ⇒ 开讨论必须被拒（锁内复检是权威）；
 *      debate_round / debate_converged 在主状态离开「已交卷」后冻结。
 *  F4  tasks/bus 补 serializeByKey——并发 N 个 submit/send 同节点/同线程，
 *      全部落线、行数正确、不因包裹而死锁（行为面；Windows rm/create 竞态本身
 *      无法确定性复现，见文件尾「测试强度」注）。
 *  #9  bus.unlock 模式闸（并行分担交齐不触发会审解锁广播）；
 *      review.openBlind 从任务图重算齐卷（自报 已交 名单不承重）。
 *  #14 settle 归档先行、事件未落线 ⇒ 响亮补偿审计（告警:true，注明重试可收敛）；
 *      bus.send / debate 补记的事件后审计失败 ⇒ Fault（消息/事件已落线、不可重试）。
 *
 * 并发手法（沿 concurrency-w3.test.js 的确定性构造）：「先把闸拿在手里，再断言操作被
 * 挡住/按注入的次序落线」，不靠 sleep 撞运气——sleep 只用于把异步操作**停进**已知位置。
 *
 * 塞 bug 校准（副本仓 $env:TEMP\dshmind-calib-b，校准后已删）：拆掉对应修复 ⇒ 本文件
 * **7 红 / 6 绿**（2026-10-15 实跑读数）——
 *   红（红在对应断言）：F3 并发序列（Missing expected rejection: 齐卷窗口内被 review(过)
 *   抢先）、F3 换轮冻结、#9 模式闸、#9 openBlind 重算、#14.1 补偿审计（expected 1 实得 0）、
 *   #14.2 bus.send Fault、#14.2 debate 补记 Fault；
 *   绿（正对照/独立路径，塞 bug 后照旧绿）：F3 正对照、F4×3、#9 独立会审正对照、
 *   #9 openBlind 未注入 tasks 的独立用法。
 * F4 的诚实边界：把 serializeByKey 拆成直通（副本实测）后 F4 三条**仍绿**——它防的
 * Windows rm/create 竞态在进程内单测试无法确定性复现（appendLines 的 O_APPEND 单写
 * 本就不撕行）。行为面只钉「不因包裹而死锁/丢行/幂等破坏」；竞态本身的兜底与
 * audit.js 同款双层（fsx.js:302-309 的事故记录是它的依据，不是可复现的测试面）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { makeFixture, LEAD, MEMBER, REVIEWER } from './helpers.mjs';
import { TaskGraph } from '../src/tasks.js';
import { MessageBus } from '../src/bus.js';
import { ReviewProtocol } from '../src/review.js';
import { RoleRegistry } from '../src/registry.js';
import { MemoryService } from '../src/memory.js';
import { DebateService } from '../src/debate.js';
import { appendLines, readJsonl, sleep, withLock } from '../src/kernel/fsx.js';
import { Denied, Fault, InvalidBody } from '../src/kernel/errors.js';

const P = 'fix-b2';
const MEMBER_B = { id: 'member-b', kind: '成员', roleId: '插件工程' };

/** 与 org.js 同款接线（bus 注入 tasks——#9 的模式闸只在注入了任务图时生效）。 */
function 装配(g, { audit = g.audit, memory = null } = {}) {
  const tasks = new TaskGraph({ layout: g.layout, policy: g.policy, audit, clock: g.clock, memory, registry: null });
  const bus = new MessageBus({ layout: g.layout, policy: g.policy, audit, clock: g.clock, tasks });
  const registry = new RoleRegistry({ layout: g.layout, policy: g.policy, audit, clock: g.clock });
  const review = new ReviewProtocol({ layout: g.layout, policy: g.policy, audit, clock: g.clock, tasks, bus, registry, random: () => 0 });
  return { tasks, bus, registry, review };
}

/** 造一个双人节点并交齐（模式可指定）。 */
async function 交齐节点(tasks, 模式, 描述) {
  const { id } = await tasks.create({ subject: LEAD, 项目: P, 描述, 负责人: ['member-a', 'member-b'], 判据: ['判据一'], 模式 });
  await tasks.dispatch(id, { subject: LEAD, 项目: P });
  await tasks.start(id, { subject: MEMBER, 项目: P });
  await tasks.submit(id, { subject: MEMBER, 项目: P, 结论: 'A 案' });
  await tasks.submit(id, { subject: MEMBER_B, 项目: P, 结论: 'B 案' });
  return id;
}

/** debateOpened 的最小入参（编排层 debate.open 会算好这些快照）。 */
const 开讨论入参 = (id) => ({ subject: LEAD, 项目: P, 参与者: ['member-a', 'member-b'], 轮次上限: 2, 预算快照: { 每轮消息上限: 24, 每人每轮字符上限: 4000 } });

// ── F3 ────────────────────────────────────────────────────────────────────────

describe('设计评审 2026-10-15 · F3：debate 齐卷 TOCTOU 与三事件入 TRANSITIONS', () => {
  it('并发序列：齐卷检查通过后、落线前节点被 review(过) 推进到已采纳 ⇒ debateOpened 锁内复检拒、零事件落线', async () => {
    const g = await makeFixture();
    try {
      const { tasks } = 装配(g);
      const id = await 交齐节点(tasks, '独立会审', 'F3 并发序列');

      // ① 拿住任务图锁：debateOpened 的锁外检查（#require / #checkWrite / 齐卷快过）全在
      //    锁外跑得通，#append 会停在 withLock 门口——这正是「齐卷检查已通过、事件未落线」的窗口。
      let 开讨论完成 = false;
      const 闸 = withLock(g.layout.taskLock(P), async () => { await sleep(350); });
      const 开讨论 = tasks.debateOpened(id, 开讨论入参(id)).then(
        (v) => { 开讨论完成 = true; return v; },
        (e) => { 开讨论完成 = true; throw e; },
      );
      await sleep(80);
      assert.equal(开讨论完成, false, '前提：debateOpened 已过锁外检查、停在锁门口（窗口已打开）');

      // ② 窗口内注入并发推进：review(过) 落线。这里直写事件行（不走 withLock）是**有意的**
      //    测试手法——它扮演「抢在开讨论之前拿到锁的另一个写者」；被测的权威判定是
      //    debateOpened 锁内复检，不依赖别的调用方守不守锁。
      const rows = await readJsonl(g.layout.taskLog(P));
      await appendLines(g.layout.taskLog(P), [{
        seq: rows.length + 1,
        at: new Date().toISOString(),
        by: { id: REVIEWER.id, kind: '复核者' },
        kind: 'reviewed',
        id,
        三态: '过',
        状态: '已采纳',
        分歧清单: [],
        反例面: [],
        复核者: REVIEWER.id,
        算通过: true,
        计打回: false,
      }]);

      // ③ 放闸：debateOpened 进锁，必须以「锁内状态已推进」被拒。
      await 闸;
      await assert.rejects(
        () => 开讨论,
        (e) => e instanceof Denied && /锁内复检|已采纳/.test(e.rule + e.message),
        '齐卷窗口内被 review(过) 抢先 ⇒ 开讨论必须拒（修前在已采纳节点上落出活跃讨论段）',
      );
      const events = (await tasks.events({ 项目: P })).filter((r) => r.id === id);
      assert.equal(events.filter((r) => r.kind === 'debate_opened').length, 0, '被拒的 debate_opened 不得落线');
      const node = await tasks.get(id, { 项目: P });
      assert.equal(node.状态, '已采纳');
      assert.equal(node.讨论, undefined, '已采纳节点上不许存在讨论段');
    } finally {
      await g.cleanup();
    }
  });

  it('正对照：正常已交卷节点开讨论照常成功（TRANSITIONS 新增不误伤）', async () => {
    const g = await makeFixture();
    try {
      const { tasks } = 装配(g);
      const id = await 交齐节点(tasks, '独立会审', 'F3 正对照');
      const 节点 = await tasks.debateOpened(id, 开讨论入参(id));
      assert.equal(节点.讨论.状态, '讨论中', '开讨论照常成功');
      assert.equal(节点.状态, '已交卷', '讨论是子状态：主状态不动');
    } finally {
      await g.cleanup();
    }
  });

  it('讨论中被 review(过) 推进到已采纳后：debate_round / debate_converged 冻结（锁外快速失败即拒）', async () => {
    const g = await makeFixture();
    try {
      const { tasks } = 装配(g);
      const id = await 交齐节点(tasks, '独立会审', 'F3 冻结');
      await tasks.debateOpened(id, 开讨论入参(id));
      // 软约束（既有语义不动）：讨论中仍可 review。
      await tasks.review(id, { subject: REVIEWER, 项目: P, 三态: '过', 复核结论: '讨论中直接采纳' });
      assert.equal((await tasks.get(id, { 项目: P })).状态, '已采纳');
      await assert.rejects(
        () => tasks.debateRounded(id, { subject: LEAD, 项目: P, 轮次: 2 }),
        (e) => e instanceof Denied && /已采纳|已交卷|状态/.test(e.message),
        '已采纳节点上换轮必须拒（TRANSITIONS debate_round 前驱=带讨论段的已交卷）',
      );
      await assert.rejects(
        () => tasks.debateConverged(id, { subject: LEAD, 项目: P, 表态消息id: 'msg-x' }),
        (e) => e instanceof Denied && /已采纳|已交卷|状态/.test(e.message),
        '已采纳节点上收敛必须拒（同上）',
      );
      const events = (await tasks.events({ 项目: P })).filter((r) => r.id === id);
      assert.equal(events.filter((r) => r.kind === 'debate_round' || r.kind === 'debate_converged').length, 0, '被拒的换轮/收敛事件不得落线');
    } finally {
      await g.cleanup();
    }
  });
});

// ── F4 ────────────────────────────────────────────────────────────────────────

describe('设计评审 2026-10-15 · F4：tasks/bus 套 serializeByKey（进程内串行不丢行不死锁）', () => {
  it('并发 8 个 submit 同节点：全部落线、事件数正确、fold 仍按人留一份', async () => {
    const g = await makeFixture();
    try {
      const { tasks } = 装配(g);
      const id = await 交齐节点(tasks, '独立会审', 'F4 并发交卷');
      // 同一负责人连发 8 份（合法：已交卷是 submit 的合法前驱，fold 同人替换）。
      await Promise.all(Array.from({ length: 8 }, (_, i) =>
        tasks.submit(id, { subject: MEMBER, 项目: P, 结论: `第 ${i} 份` })));
      const events = (await tasks.events({ 项目: P })).filter((r) => r.id === id && r.kind === 'submitted');
      assert.equal(events.length, 8 + 2, `8 次并发 submit + 交齐节点原有的 2 次 = 10 条 submitted；实际 ${events.length}（丢行 = serializeByKey 包错位）`);
      const node = await tasks.get(id, { 项目: P });
      assert.equal(node.状态, '已交卷');
      assert.equal((node.独立答案 ?? []).length, 2, '按人留：并发替换后仍是 a/b 各一份');
      // seq 不重复（连号可以，重复 = 双行fork）。
      const seqs = (await tasks.events({ 项目: P })).map((r) => r.seq);
      assert.equal(new Set(seqs).size, seqs.length, '并发追加不许算出重复 seq（同 seq 双行 = 审计链 E3 同款 fork）');
    } finally {
      await g.cleanup();
    }
  });

  it('并发 8 个 send 同线程：全部落线、行数正确（包裹不吞消息）', async () => {
    const g = await makeFixture();
    try {
      const { bus } = 装配(g);
      await Promise.all(Array.from({ length: 8 }, (_, i) =>
        bus.send({ subject: LEAD, 项目: P, 线程: 't-f4', 发件: 'lead', 收件: ['member-a'], 类型: '表态', 内容: `并发消息 ${i}` })));
      const rows = await bus.readRaw({ 项目: P, 线程: 't-f4' });
      assert.equal(rows.length, 8, `8 条并发消息全部落线；实际 ${rows.length}`);
      assert.deepEqual(rows.map((m) => m.内容).sort(), Array.from({ length: 8 }, (_, i) => `并发消息 ${i}`).sort(), '内容一条不少');
    } finally {
      await g.cleanup();
    }
  });

  it('并发 send + deliver 混跑同线程：投递幂等语义不因串行化破坏', async () => {
    const g = await makeFixture();
    try {
      const { bus } = 装配(g);
      const sent = await bus.send({ subject: LEAD, 项目: P, 线程: 't-f4b', 发件: 'lead', 收件: ['member-a'], 类型: '派活', 内容: '先压着', 暂不投递: true });
      await Promise.all([
        bus.deliver({ subject: LEAD, 项目: P, 线程: 't-f4b', id: sent.id }),
        bus.deliver({ subject: LEAD, 项目: P, 线程: 't-f4b', id: sent.id }),
        bus.send({ subject: MEMBER, 项目: P, 线程: 't-f4b', 发件: 'member-a', 收件: [], 类型: '表态', 内容: '并发插入的一条' }),
      ]);
      const rows = await bus.readRaw({ 项目: P, 线程: 't-f4b' });
      assert.equal(rows.length, 2, '折叠视图：两条消息（原消息 + 插入消息），deliver 幂等不重复');
      assert.equal(rows.find((m) => m.id === sent.id)?.状态, '已投递', '投递最终生效');
    } finally {
      await g.cleanup();
    }
  });
});

// ── #9 ────────────────────────────────────────────────────────────────────────

describe('设计评审 2026-10-15 · #9：bus.unlock 模式闸 与 openBlind 重算', () => {
  it('并行分担节点交齐 ⇒ bus_unlock 被拒（会审解锁只属独立会审）且零广播落线', async () => {
    const g = await makeFixture();
    try {
      const { bus, tasks } = 装配(g);
      const id = await 交齐节点(tasks, '并行分担', '#9 并行分担交齐');
      await assert.rejects(
        () => bus.unlock({ subject: LEAD, 项目: P, 节点: id, 线程: id, 全员已交: true, 参与者: ['member-a', 'member-b'] }),
        (e) => e instanceof Denied && /独立会审/.test(e.rule + e.message),
        '并行分担交齐不许触发会审解锁广播（修前照样放行并落系统广播）',
      );
      assert.equal((await bus.readRaw({ 项目: P, 线程: id })).length, 0, '零广播落线（不是纸面拒绝）');
    } finally {
      await g.cleanup();
    }
  });

  it('独立会审节点交齐 ⇒ 照常解锁并广播（正对照，判据不误伤）', async () => {
    const g = await makeFixture();
    try {
      const { bus, tasks } = 装配(g);
      const id = await 交齐节点(tasks, '独立会审', '#9 正对照');
      const r = await bus.unlock({ subject: LEAD, 项目: P, 节点: id, 线程: id, 全员已交: true, 参与者: ['member-a', 'member-b'] });
      assert.equal(r.解锁, true);
      const 落线 = (await bus.readRaw({ 项目: P, 线程: id })).filter((m) => m.类型 === '广播');
      assert.equal(落线.length, 1, '解锁广播真落线');
    } finally {
      await g.cleanup();
    }
  });

  it('openBlind：自报 已交 全员但任务图未齐 ⇒ 拒（修前放行）；交齐 ⇒ 过；缺 节点 ⇒ 响亮拒', async () => {
    const g = await makeFixture();
    try {
      const { review, tasks } = 装配(g);
      const 半交 = (await tasks.create({ subject: LEAD, 项目: P, 描述: '#9 半交', 负责人: ['member-a', 'member-b'], 判据: ['x'], 模式: '独立会审' })).id;
      await tasks.dispatch(半交, { subject: LEAD, 项目: P });
      await tasks.start(半交, { subject: MEMBER, 项目: P });
      await tasks.submit(半交, { subject: MEMBER, 项目: P, 结论: 'A 案' });
      await assert.rejects(
        () => review.openBlind({ subject: LEAD, 项目: P, 线程: 't-9', 节点: 半交, 参与者: ['member-a', 'member-b'], 已交: ['member-a', 'member-b'] }),
        (e) => e instanceof Denied && /未交卷|保持盲评/.test(e.message),
        '自报名单谎报全员、任务图只有一份 ⇒ 重算拒（修前按自报放行，盲评提前揭开）',
      );
      await assert.rejects(
        () => review.openBlind({ subject: LEAD, 项目: P, 线程: 't-9', 参与者: ['member-a', 'member-b'], 已交: ['member-a', 'member-b'] }),
        (e) => e instanceof InvalidBody && /节点/.test(e.message),
        '注入了任务图却缺 节点 ⇒ 响亮拒（不静默退回自报）',
      );
      const 齐 = await 交齐节点(tasks, '独立会审', '#9 交齐');
      const ok = await review.openBlind({ subject: LEAD, 项目: P, 线程: 't-9', 节点: 齐, 参与者: ['member-a', 'member-b'], 已交: [] });
      assert.equal(ok.解锁, true, '真交齐 ⇒ 放行（自报空名单也不影响——它不承重）');
      assert.match(ok.说明, /任务图重算/, '口径要如实写明是重算');
    } finally {
      await g.cleanup();
    }
  });

  it('openBlind 未注入 tasks 的独立用法：自报名单照常生效，但口径响亮标注', async () => {
    const g = await makeFixture();
    try {
      const 裸review = new ReviewProtocol({ layout: g.layout, policy: g.policy, audit: g.audit, clock: g.clock, random: () => 0 });
      await assert.rejects(
        () => 裸review.openBlind({ subject: LEAD, 项目: P, 线程: 't-9b', 参与者: ['member-a', 'member-b'], 已交: ['member-a'] }),
        (e) => e instanceof Denied,
      );
      const ok = await 裸review.openBlind({ subject: LEAD, 项目: P, 线程: 't-9b', 参与者: ['member-a', 'member-b'], 已交: ['member-a', 'member-b'] });
      assert.equal(ok.解锁, true, '独立用法（纯函数式夹具）保持旧行为');
      assert.match(ok.说明, /自报/, '口径必须标注「自报」（诚实边界）');
    } finally {
      await g.cleanup();
    }
  });
});

// ── #14 ───────────────────────────────────────────────────────────────────────

describe('设计评审 2026-10-15 · #14：settle 补偿审计 与 事件后审计失败的 Fault 包裹', () => {
  it('#14.1 settle：归档先行、事件未落线 ⇒ 重抛前落一条 告警:true 的「结账未落线」补偿审计，重试语义如实标注', async () => {
    const g = await makeFixture();
    try {
      const memory = new MemoryService({ layout: g.layout, policy: g.policy, audit: g.audit, clock: g.clock });
      const { tasks } = 装配(g, { memory });
      const id = await 交齐节点(tasks, '独立会审', '#14 结账');
      // 攒一条待归档作答（作答类记忆按项目归账，settle 时归档；成员写入要走任务上下文）。
      // R03（2026-10-16）任务授权寿命：成员带任务上下文的写只在 未终态 放行——生产流里
      // 作答在交卷前后（执行中/已交卷）落账；这里按生产时序写在 review 之前，不占用
      // 「已采纳后仍可写」这条从没被设计过的路。
      await memory.remember({ subject: MEMBER, 类: '作答', 内容: '#14 的独立答案', 来源: '测试', 项目: P, 任务: await tasks.get(id, { 项目: P }) });
      await tasks.review(id, { subject: REVIEWER, 项目: P, 三态: '过', 复核结论: '过' });
      assert.equal((await tasks.get(id, { 项目: P })).状态, '已采纳');
      const 原账 = await readJsonl(g.layout.taskLog(P));

      // 拿住任务图锁：settle 的归档（记忆账本另一把锁，不受影响）先走完，
      // #append 停在锁门口——这就是「已归档、事件未落线」的窗口。
      // 手动闸门（2026-10-17 测试稳定性批）：修前有两个定时假设——① `withLock` 的**实际
      // 取得**与 settle 发车之间是启动序竞态（并发负载下 settle 可能先拿到锁，前提当场假）；
      // ② 持锁 350ms 暗含「断言必须在此窗内做完」（负载下超窗 ⇒ settle 在破账前成功走完）。
      // 改为**拿到信号再发车、破账后放行**：全程无定时假设，窗口要多长有多长。
      let 结账完成 = false;
      let 通报拿到; const 已拿到 = new Promise((resolve) => { 通报拿到 = resolve; });
      let 放行; const 可放行 = new Promise((resolve) => { 放行 = resolve; });
      const 闸 = withLock(g.layout.taskLock(P), async () => { 通报拿到(); await 可放行; });
      await 已拿到; // 锁确在手上，settle 才发车——启动序竞态的根治面
      const 结账 = tasks.settle(id, { subject: LEAD, 项目: P }).then(
        (v) => { 结账完成 = true; return v; },
        (e) => { 结账完成 = true; throw e; },
      );
      // 归档先行是**事件序**不是定时序：轮询到「作答账出现归档行」为据——锁在我们手里，
      // settle 此刻必然停在任务图锁门口（它进不去），轮多久都不会错过窗口。
      const 归档在账 = async () => (await readJsonl(g.layout.memoryLog(P, '作答'))).some((r) => r.追加 === '归档');
      const 止 = Date.now() + 5_000;
      while (!(await 归档在账())) {
        assert.ok(Date.now() <= 止, '等归档行超时：settle 未在预算内走到任务图锁门口');
        await sleep(50);
      }
      assert.equal(结账完成, false, '前提：settle 停在锁门口（归档已先行）');
      // 归档确实已经发生（顺序的证据面）：作答账本里已有指向该条目的归档状态行。
      const 作答账 = await readJsonl(g.layout.memoryLog(P, '作答'));
      assert.ok(作答账.some((r) => r.追加 === '归档'), '归档先于事件落线（有意设计，勿翻转——见 tasks.js settle 注释）');

      // 注入失败：把任务图账本换成目录（readJsonl/appendLines 都会响亮失败）。
      await rm(g.layout.taskLog(P), { force: true });
      await mkdir(g.layout.taskLog(P), { recursive: true });
      放行();
      await 闸;

      await assert.rejects(() => 结账, (e) => e instanceof Error, '事件未落线 ⇒ settle 必须失败（不许把已归档报成已结账）');
      // 补偿审计存在且响亮。
      const 补偿 = (await g.audit.read({})).filter((r) => r.动作 === '结账未落线');
      assert.equal(补偿.length, 1, '恰好一条「结账未落线」补偿审计');
      assert.equal(补偿[0].告警, true, '补偿审计必须告警（把失败窗口从静默变成响亮）');
      assert.match(JSON.stringify(补偿[0].详情), /重试 settle 可收敛/, '详情必须写明收敛路径');
      assert.ok((补偿[0].详情?.归档条数 ?? 0) >= 1, '详情带真实归档条数');

      // 修好账本（放回原内容）后：节点仍停在已采纳、无 settled 事件 ⇒ 重试 settle 可收敛。
      await rm(g.layout.taskLog(P), { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
      const 原文 = 原账.map((r) => JSON.stringify(r)).join('\n') + '\n';
      await writeFile(g.layout.taskLog(P), 原文, 'utf8');
      const 事后 = await tasks.get(id, { 项目: P });
      assert.equal(事后.状态, '已采纳', '事件未落线 ⇒ 节点仍已采纳（重试 settle 的入口还在）');
      assert.equal((await tasks.events({ 项目: P })).filter((r) => r.kind === 'settled').length, 0, '没有 settled 事件落线');
      const 重试 = await tasks.settle(id, { subject: LEAD, 项目: P });
      assert.equal(重试.状态, '已结账', `修复后重试 settle 可收敛；实际 ${重试.状态}`);
    } finally {
      await g.cleanup();
    }
  });

  it('R3 settle：事件已落线仅审计失败，不得记未落线或建议重试', async () => {
    const g = await makeFixture();
    try {
      const memory = new MemoryService({ layout: g.layout, policy: g.policy, audit: g.audit, clock: g.clock });
      let 注入次数 = 0;
      const 坏审计 = {
        append: async (entry) => {
          if (entry.动作 === '结账') {
            注入次数 += 1;
            throw new Error('回归夹具：结账事件后的审计暂时失败');
          }
          return g.audit.append(entry);
        },
        read: (query) => g.audit.read(query),
      };
      const { tasks } = 装配(g, { memory, audit: 坏审计 });
      const id = await 交齐节点(tasks, '独立会审', 'R3 结账第二笔失败');
      // R03：作答按生产时序在 review 之前落账（已交卷态），不占「已采纳后仍可写」。
      await memory.remember({ subject: MEMBER, 类: '作答', 内容: 'R3 的独立答案', 来源: '测试', 项目: P, 任务: await tasks.get(id, { 项目: P }) });
      await tasks.review(id, { subject: REVIEWER, 项目: P, 三态: '过' });
      await assert.rejects(
        () => tasks.settle(id, { subject: LEAD, 项目: P }),
        (e) => e instanceof Fault && e.code === 'AUDIT_APPEND_FAILED_AFTER_EVENT' && /已落线/.test(e.message) && /不要重试/.test(e.message),
      );
      assert.equal(注入次数, 1, '故障必须命中结账审计，不是前置路径失败');
      assert.equal((await tasks.get(id, { 项目: P })).状态, '已结账');
      assert.equal((await tasks.events({ 项目: P })).filter((r) => r.id === id && r.kind === 'settled').length, 1);
      assert.ok((await readJsonl(g.layout.memoryLog(P, '作答'))).some((r) => r.追加 === '归档'));
      const 补偿 = (await g.audit.read({})).filter((r) => r.动作 === '结账未落线');
      assert.equal(补偿.length, 0, '真实事件已落线，不能制造反向审计事实或重试建议');
      await assert.rejects(() => tasks.settle(id, { subject: LEAD, 项目: P }), (e) => e instanceof Denied && /已结账/.test(e.message));
    } finally {
      await g.cleanup();
    }
  });

  it('R3 正对照：正常结账保留完整审计且不生成失败补偿', async () => {
    const g = await makeFixture();
    try {
      const memory = new MemoryService({ layout: g.layout, policy: g.policy, audit: g.audit, clock: g.clock });
      const { tasks } = 装配(g, { memory });
      const id = await 交齐节点(tasks, '独立会审', 'R3 正常结账');
      await tasks.review(id, { subject: REVIEWER, 项目: P, 三态: '过' });
      assert.equal((await tasks.settle(id, { subject: LEAD, 项目: P })).状态, '已结账');
      const rows = await g.audit.read({});
      assert.equal(rows.filter((r) => r.动作 === '结账' && r.对象.id === id).length, 1);
      assert.equal(rows.filter((r) => r.动作 === '结账未落线').length, 0);
    } finally {
      await g.cleanup();
    }
  });

  it('#14.2 bus.send：消息已落线、审计追加失败 ⇒ Fault（不可重试语义），消息本体在账上', async () => {
    const g = await makeFixture();
    try {
      const 注入 = [];
      const 坏审计 = { append: async (entry) => { 注入.push(entry); throw new Error('注入：审计追加失败'); }, read: async () => [] };
      const bus = new MessageBus({ layout: g.layout, policy: g.policy, audit: 坏审计, clock: g.clock });
      await assert.rejects(
        () => bus.send({ subject: LEAD, 项目: P, 线程: 't-142', 发件: 'lead', 收件: [], 类型: '表态', 内容: '先落线再说' }),
        (e) => e instanceof Fault && e.code === 'AUDIT_APPEND_FAILED_AFTER_EVENT' && /已落线/.test(e.message) && /不要重试/.test(e.message),
        '事件后审计失败必须 Fault 且明示「已落线、不可重试」（修前裸抛，调用方会误判没发成而重发）',
      );
      assert.equal((await bus.readRaw({ 项目: P, 线程: 't-142' })).length, 1, '消息本体已经落线（Fault 不是「没写成」）');
    } finally {
      await g.cleanup();
    }
  });

  it('#14.2 debate 补记：讨论事件已落线、反对者指定补记审计失败 ⇒ Fault；debate_opened 在事件流上', async () => {
    const g = await makeFixture();
    try {
      // 审计桩：只对「反趋同 · 强制反对者」那条补记失败（其余审计放行——讨论开启的
      // 审计依据是「任务图事件流」、揭名是「§10 盲评」，都不含「反趋同」，不掺和本条要钉的失败点）。
      const 坏审计 = {
        append: async (entry) => {
          if (String(entry.依据 ?? '').includes('反趋同')) throw new Error('注入：补记审计失败');
          return { seq: 0 };
        },
        read: async () => [],
      };
      const { tasks, bus, registry, review } = 装配(g, { audit: 坏审计 });
      const debate = new DebateService({ layout: g.layout, policy: g.policy, audit: 坏审计, clock: g.clock, tasks, bus, review, registry });
      const id = await 交齐节点(tasks, '独立会审', '#14 补记');
      await assert.rejects(
        () => debate.open({ subject: LEAD, 项目: P, 节点: id }),
        (e) => e instanceof Fault && e.code === 'AUDIT_APPEND_FAILED_AFTER_EVENT' && /不要重试 debate_open/.test(e.message),
        '补记审计失败 ⇒ Fault 且指明不可用重试 debate_open 修复（修前裸抛，两个事实源越漂越远）',
      );
      const node = await tasks.get(id, { 项目: P });
      assert.equal(node.讨论?.状态, '讨论中', 'debate_opened 事件已落线（Fault 描述的是「第二笔缺失」，不是「没开成」）');
    } finally {
      await g.cleanup();
    }
  });
});

/**
 * 测试强度与诚实边界（写给下一个校准的人）：
 *  - F3 的并发序列是**确定性构造**（锁门口停 + 直写注入），钉的是锁内复检的权威性；
 *    它不依赖真实线程竞态，塞 bug 校准（去掉锁内复检）必红。
 *  - F4 的行为测试只钉「不丢行、不死锁、幂等不破坏」。serializeByKey 防的 Windows
 *    rm/create 竞态在进程内单测试里无法确定性复现（appendLines 的 O_APPEND 单写不撕行），
 *    拆掉包裹后本组测试仍绿——这是如实的强度标注，不是校准遗漏。
 *  - #14.1 用「锁门口停 + 账本换目录」注入事件落线失败；它同时钉了顺序面（归档先行的
 *    证据 = 作答账本里已有归档行）与收敛面（修复账本后重试 settle 成已结账）。
 *  - #14.2 用审计桩注入第二笔失败；桩只对目标审计行抛错，其余路径放行（隔离失败点）。
 */
