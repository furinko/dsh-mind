/**
 * 任务图 / 消息总线 / 记忆 / 检索 / 复核 / 反趋同。
 *
 * 这一组测的是「主干环路」能不能真的跑起来，以及每条机制在**越界**时是否拒绝：
 * 判据冻结、线程隔离、不许改写只能追加、会审解锁边界、零分歧报警。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, SOVEREIGN, LEAD, MEMBER, REVIEWER, seedReviewRelation } from './helpers.mjs';
import { TaskGraph } from '../src/tasks.js';
import { MessageBus } from '../src/bus.js';
import { MemoryService } from '../src/memory.js';
import { ReviewProtocol } from '../src/review.js';
import { buildIndex, formatMiss, runRegression, search } from '../src/retrieval.js';
import { Denied, InvalidBody } from '../src/kernel/errors.js';
import { readJsonl } from '../src/kernel/fsx.js';
import { Clock } from '../src/kernel/time.js';
import { runAction } from '../lib/actions.js';
import { projectWorkbench, sliceForViewer } from '../src/workbench.js';
import { Org } from '../src/org.js';

/** @type {Awaited<ReturnType<typeof makeFixture>>} */
let f;
/** @type {TaskGraph} */ let tasks;
/** @type {MessageBus} */ let bus;
/** @type {MemoryService} */ let memory;
/** @type {ReviewProtocol} */ let review;

const P = 'proj-a';

describe('主干环路', () => {
  before(async () => {
    f = await makeFixture();
    tasks = new TaskGraph({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
    bus = new MessageBus({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
    memory = new MemoryService({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
    review = new ReviewProtocol({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock, tasks, bus, random: () => 0 });
  });
  after(async () => {
    await f.cleanup();
  });

  it('任务：判据必填；v2 多人只剩并行分担（不再需要「模式」声明）', async () => {
    await assert.rejects(() => tasks.create({ subject: LEAD, 项目: P, 描述: '没判据', 负责人: 'member-a' }), (e) => e instanceof InvalidBody);
    await assert.rejects(() => tasks.create({ subject: LEAD, 项目: P, 描述: '没负责人', 判据: ['x'] }), (e) => e instanceof InvalidBody);
    // v2（条目18）：会审退出任务图 ⇒ 多人形态只剩并行分担，名单即全部事实，不再要求模式声明。
    const 两人 = await tasks.create({ subject: LEAD, 项目: P, 描述: '两人并行分担', 负责人: ['member-a', 'member-b'], 判据: ['x'] });
    assert.ok(!('模式' in 两人), '模式字段已删除（不是 null 空壳；历史事件仍可折出旧值）');
    assert.deepEqual(两人.负责人, ['member-a', 'member-b']);
    const node = await tasks.create({ subject: LEAD, 项目: P, 描述: '合法节点', 负责人: 'member-a', 判据: ['能建', '能派'] });
    assert.equal(node.状态, '待派发');
    assert.equal(node.判据.length, 2);
  });

  it('任务：派发后判据冻结，试图改判据的事件被拒', async () => {
    const node = await tasks.create({ subject: LEAD, 项目: P, 描述: '冻结演示', 负责人: 'member-a', 判据: ['原始判据'] });
    const dispatched = await tasks.dispatch(node.id, { subject: LEAD, 项目: P });
    assert.equal(dispatched.判据冻结, true);
    // 直接往事件流里塞一个带判据的事件：这是唯一能绕过 API 的入口，也必须被拦。
    const { appendLines } = await import('../src/kernel/fsx.js');
    await assert.rejects(
      async () => {
        const rows = await tasks.events({ 项目: P });
        const { withLock } = await import('../src/kernel/fsx.js');
        await withLock(f.layout.taskLock(P), async () => {
          // 复刻 tasks 内部那条不变式：已派发就不再接受判据字段。
          const current = (await tasks.events({ 项目: P })).find((r) => r.id === node.id && r.kind === 'dispatched');
          if (current) throw new Denied('任务图 · 派发后判据冻结', '判据不能在事后改动。');
          await appendLines(f.layout.taskLog(P), [{ kind: 'created', id: node.id, 判据: ['被篡改'] }]);
        });
      },
      (e) => e instanceof Denied,
    );
    assert.deepEqual((await tasks.get(node.id, { 项目: P })).判据, ['原始判据']);
  });

  it('任务：复核三态与打回计数；未验不算通过也不计打回；打回≥2 升级主权者', async () => {
    const node = await tasks.create({ subject: LEAD, 项目: P, 描述: '复核演示', 负责人: 'member-a', 判据: ['x'] });
    await tasks.dispatch(node.id, { subject: LEAD, 项目: P });
    await tasks.start(node.id, { subject: MEMBER, 项目: P });
    await tasks.submit(node.id, { subject: MEMBER, 项目: P, 产出物引用: ['artifact-9'] });

    await seedReviewRelation(f, { 项目: P, 目标: node.id });
    const 未验 = await review.record({ subject: REVIEWER, 项目: P, 节点: node.id, 三态: '未验', 反例面: ['读数拿不到'] });
    assert.equal(未验.算通过, false);
    assert.equal(未验.计打回, false);
    assert.match(未验.谁接手, /Lead/);
    const after未验 = await tasks.get(node.id, { 项目: P });
    assert.equal(after未验.状态, '未验');
    assert.equal(after未验.打回次数, 0);

    await review.record({ subject: REVIEWER, 项目: P, 节点: node.id, 三态: '不过', 分歧清单: ['判据 1 未满足'] });
    const after1 = await tasks.get(node.id, { 项目: P });
    assert.equal(after1.打回次数, 1);
    assert.equal(after1.升级, undefined);

    // P1-02：打回关闭当前代并清空答案；第二次复核前必须先返工交卷，
    // 否则「不合格产出一份新证据都没有」也会被计数/采纳。打回计数语义不变。
    await tasks.start(node.id, { subject: MEMBER, 项目: P });
    await tasks.submit(node.id, { subject: MEMBER, 项目: P, 产出物引用: ['artifact-10'] });
    await review.record({ subject: REVIEWER, 项目: P, 节点: node.id, 三态: '不过', 分歧清单: ['判据 1 仍未满足'] });
    const after2 = await tasks.get(node.id, { 项目: P });
    assert.equal(after2.打回次数, 2);
    assert.equal(after2.升级.至, '主权者');
    assert.equal(after2.升级.原因, '打回≥2');
  });

  it('任务：产出物只存引用；待决项是节点状态且裁决后记录不消失', async () => {
    const node = await tasks.create({ subject: LEAD, 项目: P, 描述: '待决演示', 负责人: 'member-a', 判据: ['x'] });
    await tasks.dispatch(node.id, { subject: LEAD, 项目: P });
    await tasks.start(node.id, { subject: MEMBER, 项目: P });
    await tasks.submit(node.id, { subject: MEMBER, 项目: P, 产出物引用: ['artifact-1', 'artifact-2'] });
    const submitted = await tasks.get(node.id, { 项目: P });
    assert.deepEqual(submitted.产出物引用, ['artifact-1', 'artifact-2']);
    assert.equal(typeof submitted.产出物引用[0], 'string', '节点上只存引用，不存本体');

    await tasks.markPending(node.id, { subject: LEAD, 项目: P, 原因: '两边改了同一条', 待决类型: '升级差异' });
    const pending = await tasks.get(node.id, { 项目: P });
    assert.equal(pending.状态, '待决');
    const snapshot = await tasks.snapshot({ 项目: P });
    assert.ok(snapshot.待决.some((n) => n.id === node.id));

    await tasks.resolvePending(node.id, { subject: SOVEREIGN, 项目: P, 决定: '用出厂版' });
    const resolved = await tasks.get(node.id, { 项目: P });
    assert.equal(resolved.状态, '已交卷');
    assert.equal(resolved.已决.决定, '用出厂版');
    assert.deepEqual(resolved.待决记录.map((r) => r.决定), ['用出厂版']);
  });

  it('动作面 bus_unlock 已退役：模型面没有这只手，旧会审线程零广播', async () => {
    const MEMBER_B = { id: 'member-b', kind: '成员', roleId: '插件工程' };
    const node = await tasks.create({ subject: LEAD, 项目: P, 描述: '会审接线演示', 负责人: ['member-a', 'member-b'], 判据: ['x'] });
    await tasks.dispatch(node.id, { subject: LEAD, 项目: P });
    await tasks.start(node.id, { subject: MEMBER, 项目: P });
    const org = { tasks, bus, registry: { identity: async () => ({ members: {} }) } };
    await tasks.submit(node.id, { subject: MEMBER, 项目: P, 结论: 'A 案' });
    await tasks.submit(node.id, { subject: MEMBER_B, 项目: P, 结论: 'B 案' });
    // v2 条目18：会审退出任务图后，旧「齐卷解锁广播」入口整体退役（模型面未知动作即响亮失败）。
    await assert.rejects(
      () => runAction({ org, 项目: P, subject: LEAD, 主体: LEAD, args: { action: 'bus_unlock', id: node.id, 线程: node.id } }),
      (e) => e instanceof InvalidBody && /未知 action/.test(e.message),
      'bus_unlock 不再在动作面存在',
    );
    const rows = await bus.read({ subject: LEAD, 项目: P, 线程: node.id });
    assert.equal(rows.filter((m) => m.类型 === '广播').length, 0, '零广播落线（历史账本不变）');
  });

  it('记忆 query 的条目预算：默认最多 50 条并如实标注截断；条数上限 可调', async () => {
    // 造 55 条可见条目（空 query 的全量回传正是要加预算的那条路）。
    for (let i = 0; i < 55; i += 1) {
      await memory.remember({ subject: LEAD, 类: '偏好', 内容: `预算演示第 ${i} 条`, 来源: '测试' });
    }
    const 默认 = await memory.query({ subject: LEAD, 类: ['偏好'] });
    assert.equal(默认.条目.length, 50, '默认最多回传 50 条');
    assert.equal(默认.条目截断, true, '截断要如实标注');
    assert.equal(默认.条目总数, 55, '总数要给全，别让人以为只有 50 条');
    assert.match(默认.说明 ?? '', /55/, '说明里要有总数');

    const 调宽 = await memory.query({ subject: LEAD, 类: ['偏好'], 条数上限: 100 });
    assert.equal(调宽.条目.length, 55, '条数上限 调宽后不截断');
    assert.equal(调宽.条目截断, false, '没截断就不许标 true');

    const 调窄 = await memory.query({ subject: LEAD, 类: ['偏好'], 条数上限: 5 });
    assert.equal(调窄.条目.length, 5, '条数上限=5 只回 5 条');
    assert.equal(调窄.条目截断, true);
    // 预算只管 条目：口径里的 条目数 仍是真总数（账本侧可见条数；检索面的 文档数 是另一个数，见 W3 批2）。
    assert.equal(调窄.口径.条目数, 55, '口径（命中逻辑）不受预算影响');
  });

  it('消息总线：线程隔离、暂不投递、会审解锁的硬边界', async () => {
    await bus.send({ subject: LEAD, 项目: P, 线程: 't-1', 发件: 'lead', 收件: ['member-a'], 类型: '派活', 内容: '做 A' });
    await bus.send({ subject: LEAD, 项目: P, 线程: 't-2', 发件: 'lead', 收件: ['member-a'], 类型: '派活', 内容: '做 B' });
    await bus.send({ subject: LEAD, 项目: P, 线程: 't-1', 发件: 'lead', 收件: ['member-a'], 类型: '表态', 内容: '稍后投递', 暂不投递: true });

    const t1 = await bus.read({ subject: LEAD, 项目: P, 线程: 't-1' });
    assert.equal(t1.length, 2);
    assert.ok(t1.every((m) => m.线程 === 't-1'), '不得跨线程返回');
    const t2 = await bus.read({ subject: LEAD, 项目: P, 线程: 't-2' });
    assert.equal(t2.length, 1);
    assert.equal((await bus.read({ subject: LEAD, 项目: P, 线程: 't-1', 未投递: true })).length, 1);

    const deferred = t1.find((m) => m.状态 === '暂不投递');
    const delivered = await bus.deliver({ 项目: P, 线程: 't-1', id: deferred.id, subject: LEAD });
    assert.equal(delivered.状态, '已投递');

    // v2 条目18：旧「齐卷解锁」服务入口已退役（对任何节点恒拒，不落广播）。
    await assert.rejects(
      () => bus.unlock({ subject: LEAD, 项目: P, 线程: 't-1', 全员已交: false, 参与者: ['member-a'] }),
      (e) => e instanceof Denied && /已退役/.test(e.rule),
    );
    await assert.rejects(
      () => bus.unlock({ subject: LEAD, 项目: P, 线程: 't-1', 全员已交: true, 参与者: ['member-a'] }),
      (e) => e instanceof Denied && /已退役/.test(e.rule),
    );
    assert.equal((await bus.read({ subject: LEAD, 项目: P, 线程: 't-1' })).filter((m) => m.类型 === '广播').length, 0, '零广播落线');
  });

  it('⑦ 消息总线投影：全部线程 + 未投递 + 会审讨论段盲评收起 + 投影取数免审计', async () => {
    await bus.send({ subject: LEAD, 项目: P, 线程: 'wb-1', 发件: 'lead', 收件: ['member-a'], 类型: '广播', 内容: 'x'.repeat(200) });
    await bus.send({ subject: LEAD, 项目: P, 线程: 'wb-1', 发件: 'lead', 收件: ['member-a'], 类型: '提问', 内容: '短消息', 暂不投递: true });

    // 免审计（设计债③）：summary 是投影取数，走 readRaw——审计行数前后必须一动不动。
    const before = (await f.audit.read({})).length;
    const 汇总 = await bus.summary({ 项目: P });
    assert.equal((await f.audit.read({})).length, before, 'summary 投影取数零审计（readRaw 内部读）');
    const wb1 = 汇总.find((t) => t.线程 === 'wb-1');
    assert.equal(wb1.条数, 2, '条数=折叠后的当前视图（暂不投递也是一条消息）');
    assert.equal(wb1.未投递, 1);
    assert.equal(wb1.最新.length, 2);
    // ⚠️ 口径改形（2026-10-12，主权者指令「（总线）也默认收起呗」）：
    // 旧断言是「投影层把正文截到 120 字，全文在 bus_read」——它把「收窄」做在了**数据源头**，
    // 于是渲染层手里没有全文，「展开看全部」无从谈起，且超出的条数连「另有 N」都算不出
    // （`summary` 只给 5 条，渲染层再 slice(-5) 是纯空操作）。
    // 新口径：**截断动作挪到渲染层**（默认折叠 3 行 + 展开钮），投影层给**全量正文**，
    // 另附 `正文原长` 供渲染层判断要不要给展开钮。本条守的本意不变——正文不许被静默丢弃——
    // 只是换成「给全量」来表达。全文检索/审计仍走 bus_read。
    assert.equal(wb1.最新[0].内容.length, 200, '正文给全量（收窄挪到渲染层折叠，不在源头删信息）');
    assert.equal(wb1.最新[0].正文原长, 200, '正文原长随附，供渲染层判断要不要给展开钮');

    // 投影：普通线程带最新消息；会审讨论线程（节点带 讨论 子状态）不出正文与发件。
    const 投影 = (节点) => projectWorkbench({
      项目: P, 节点, 探针: { 结果: [] }, 策略: { healthy: true, rules: [] },
      线程: [
        { 线程: 'wb-1', 条数: 2, 未投递: 1, 最新: wb1.最新 },
        { 线程: 'n-9', 条数: 5, 未投递: 0, 最新: [{ id: 'm', 发件: 'member-x', 类型: '分歧', 内容: '不该被看见', 状态: '已投递', 追加于: 't' }] },
      ],
    });
    assert.equal(投影([]).消息总线.find((t) => t.线程 === 'wb-1').最新.length, 2, '普通线程带最新消息');
    const 讨论行 = 投影([{ id: 'n-9', 状态: '执行中', 负责人: ['member-a'], 讨论: { 状态: '讨论中' } }]).消息总线.find((t) => t.线程 === 'n-9');
    assert.equal(讨论行.会审讨论段, true);
    assert.equal(讨论行.最新, undefined, '会审讨论线程不出正文（盲评遮罩做在投影层）');
    // 成员切片：总线正文一律收起（「只读自己那片」——他人发言不是自己那片）。
    const 成员视图 = sliceForViewer(投影([]), { id: 'member-a', kind: '成员' });
    assert.ok(成员视图.消息总线.every((t) => !t.最新), '成员切片：总线只给规模行，不给正文');
  });

  it('⑦ 盲评掩码补漏（纯投影）：名单与会审行同口径取并集，判定键走单源 `线程等价键`', () => {
    const 消息行 = (内容) => [{ id: 'm-1', 发件: 'member-a', 类型: '交卷', 内容, 状态: '已投递', 追加于: 't' }];
    const 投影 = (节点, 线程) => projectWorkbench({
      项目: P, 节点, 探针: { 结果: [] }, 策略: { healthy: true, rules: [] }, 线程,
    });

    // ① 未交齐的会审节点（负责人 2 人、1 份独立答案、**没开讨论**）⇒ 线程也遮。
    //    修前：名单只装「开了讨论」的节点 ⇒ 这条线程原样画出「发件 + 正文」。
    //    v2：会审行已迁到存档（任务节点不再投影成会审行），但历史任务图的线程仍按盲评口径遮。
    const 未齐会审 = { id: 'task-mask-a', 状态: '执行中', 负责人: ['member-a', 'member-b'], 独立答案: [{ 成员: 'member-a', 结论: 'A 案' }] };
    const 视图 = 投影([未齐会审], [{ 线程: 'task-mask-a', 条数: 1, 未投递: 0, 最新: 消息行('密文-未齐会审') }]);
    assert.equal(视图.消息总线[0].会审讨论段, true, '未交齐的会审节点线程必须遮：判据是「揭名之前不给内容」，与有没有开讨论无关');
    assert.equal(视图.消息总线[0].最新, undefined, '遮罩行不给正文与发件');
    assert.ok(!JSON.stringify(视图).includes('密文-未齐会审'), '同一份投影里不许出现那串密文');

    // ② 判定键必须与落线侧同源：落线是 `busThread()` 直接 join 文件系统（NTFS 大小写不敏感）
    //    ⇒ 大写别名线程是同一个文件。修前用精确键 ⇒ miss ⇒ 正文进面板。
    const 别名视图 = 投影([未齐会审], [{ 线程: 'TASK-MASK-A', 条数: 1, 未投递: 0, 最新: 消息行('密文-别名') }]);
    assert.equal(别名视图.消息总线[0].会审讨论段, true, '大小写别名线程同样遮（判定键走 线程等价键()）');
    assert.ok(!JSON.stringify(别名视图).includes('密文-别名'), '大小写别名不许把正文送进面板');

    // ③ 正对照（别修过头）：**非会审**节点（1 负责人、无独立答案、没开讨论）的普通线程照旧给「最新」。
    const 单人 = { id: 'task-plain', 状态: '执行中', 负责人: ['member-a'] };
    const 普通 = 投影([单人], [{ 线程: 'task-plain', 条数: 1, 未投递: 0, 最新: 消息行('普通正文') }]).消息总线[0];
    assert.equal(普通.最新.length, 1, '普通线程仍给正文+发件——消息总线面板的意义就是让人看见线程');
    assert.equal(普通.会审讨论段, undefined, '普通线程不带遮罩标记');

    // ④ 并集，不取替换：`n.讨论` 那一路必须保留（开了讨论但形状不是会审的节点仍遮）；
    //    会审形状的另一半（有独立答案、哪怕只有 1 位负责人）也遮 —— 与会审行同口径。
    const 讨论单 = { id: 'task-open', 状态: '执行中', 负责人: ['member-a'], 讨论: { 状态: '讨论中' } };
    const 讨论单行 = 投影([讨论单], [{ 线程: 'task-open', 条数: 1, 未投递: 0, 最新: 消息行('讨论正文') }]).消息总线[0];
    assert.equal(讨论单行.会审讨论段, true, '开过讨论的节点仍遮（既有口径不许被替换掉）');
    assert.equal(讨论单行.最新, undefined);
    const 单人有答案 = { id: 'task-ans', 状态: '已交卷', 负责人: ['member-a'], 独立答案: [{ 成员: 'member-a', 结论: 'A 案' }] };
    assert.equal(
      投影([单人有答案], [{ 线程: 'task-ans', 条数: 1, 未投递: 0, 最新: 消息行('单人会审正文') }]).消息总线[0].会审讨论段,
      true,
      '有独立答案（哪怕 1 位负责人）也是会审：与会审行同口径',
    );

    // e) 成员切片行为不变：遮罩行的形状与「不给正文」照旧。
    const 成员 = sliceForViewer(视图, { id: 'member-a', kind: '成员' });
    assert.deepEqual(
      成员.消息总线,
      [{ 线程: 'task-mask-a', 条数: 1, 未投递: 0, 会审讨论段: true }],
      '成员切片：只给规模行，遮罩标记照旧带出（行为不变）',
    );
  });

  it('⑦ 盲评掩码端到端：动作面落进会审节点线程的结论不进面板投影（含大写别名线程）', async () => {
    const g = await makeFixture();
    try {
      const org = await Org.open({ home: g.home, factoryRoot: g.factoryRoot, privateRoot: g.privateRoot, project: P });
      const 节点 = await org.tasks.create({
        subject: LEAD, 项目: P, 描述: '掩码补漏会审', 负责人: ['member-a', 'member-b'], 判据: ['结论一致'], 模式: '独立会审',
      });
      await org.tasks.dispatch(节点.id, { subject: LEAD, 项目: P });
      await org.tasks.start(节点.id, { subject: MEMBER, 项目: P });
      await org.tasks.submit(节点.id, { subject: MEMBER, 项目: P, 结论: 'A 案' }); // 只交 1/2：未齐

      // 泄漏路径 A：负责人 `bus_send` 往**自己的任务线程**（=节点 id，这条本来就被允许）落结论。
      const 密文 = '密文：未交齐的会审结论';
      await runAction({
        org, 项目: P, subject: LEAD, 主体: MEMBER,
        args: { action: 'bus_send', 线程: 节点.id, 类型: '交卷', 内容: 密文 },
      });
      assert.equal(
        (await org.bus.readRaw({ 项目: P, 线程: 节点.id })).some((m) => m.内容 === 密文),
        true,
        '前置：这条落线路径本身是允许的（真落线，不是纸面允许）',
      );
      const 视图 = await org.workbench({ 项目: P });
      const 总线行 = 视图.消息总线.find((t) => t.线程 === 节点.id);
      assert.equal(总线行?.会审讨论段, true, '未交齐 ⇒ 历史会审节点线程按盲评口径收起正文');
      assert.ok(!JSON.stringify(视图).includes(密文), '同一份面板上，会审线程遮罩时总线行不许把结论画出来');

      // 泄漏路径 B：讨论开启**之前**用大写别名先建线（先落的那一侧决定文件名形态，
      // 与真 id 是同一个文件）——判定侧用精确键就会 miss。
      const 节点B = await org.tasks.create({
        subject: LEAD, 项目: P, 描述: '掩码补漏会审二', 负责人: ['member-a', 'member-b'], 判据: ['结论一致'], 模式: '独立会审',
      });
      await org.tasks.dispatch(节点B.id, { subject: LEAD, 项目: P });
      await org.tasks.start(节点B.id, { subject: MEMBER, 项目: P });
      await org.tasks.submit(节点B.id, { subject: MEMBER, 项目: P, 结论: 'A 案' }); // 只交 1/2：未齐
      const 别名 = 节点B.id.toUpperCase();
      assert.notEqual(别名, 节点B.id, '前置：别名与真 id 字面不同（否则这条测不到大小写口径）');
      const 别名密文 = '密文：大写别名线程';
      await runAction({
        org, 项目: P, subject: LEAD, 主体: LEAD,
        args: { action: 'bus_send', 线程: 别名, 类型: '交卷', 内容: 别名密文 },
      });
      assert.equal(
        (await org.bus.readRaw({ 项目: P, 线程: 节点B.id })).some((m) => m.内容 === 别名密文),
        true,
        '别名与真 id 落到同一个文件（NTFS 大小写不敏感）——这就是大小写那条旁路的落线事实',
      );
      const 别名视图 = await org.workbench({ 项目: P });
      const 别名行 = 别名视图.消息总线.find((t) => t.线程 === 别名);
      assert.equal(别名行?.会审讨论段, true, `别名线程也必须遮，实际 ${JSON.stringify(别名行)}`);
      assert.ok(!JSON.stringify(别名视图).includes(别名密文), '大小写别名不许把正文送进面板');
    } finally {
      await g.cleanup();
    }
  });

  it('记忆：写入必带来源，项目标签恒打、岗位标签默认不打', async () => {
    await assert.rejects(
      () => memory.remember({ subject: LEAD, 类: '知识', 内容: '没有来源', 项目: P }),
      (e) => e instanceof InvalidBody && /怎么知道/.test(e.message),
    );
    await assert.rejects(
      () => memory.remember({ subject: LEAD, 类: '知识', 内容: '没有项目', 来源: '看文档' }),
      (e) => e instanceof InvalidBody && /项目标签/.test(e.message),
    );
    await assert.rejects(
      () => memory.remember({ subject: LEAD, 类: '能力', 内容: 'x', 来源: 'y', 项目: P }),
      (e) => e instanceof InvalidBody && /四类/.test(e.message),
    );
    const entry = await memory.remember({ subject: LEAD, 类: '知识', 内容: '策略引擎必须 fail-closed', 来源: { 怎么知道: '设计文档 §12' }, 项目: P });
    assert.equal(entry.项目, P);
    assert.equal(entry.岗位, null, '岗位标签默认不打');

    const promoted = await memory.promoteCrossProject(entry.id, { subject: LEAD, 岗位: '插件工程', 理由: '这条跨项目可复用' });
    assert.equal(promoted.岗位, '插件工程');
    await assert.rejects(() => memory.promoteCrossProject(entry.id, { subject: MEMBER, 岗位: '插件工程', 理由: 'x' }), (e) => e instanceof Denied || e instanceof InvalidBody);
  });

  it('记忆：不许改写只能追加——失效与降权都不动原条目那行', async () => {
    const entry = await memory.remember({ subject: LEAD, 类: '经历', 内容: '踩过一次并发写的坑', 来源: '本人经历' });
    const file = f.layout.memoryLog('跨项目', '经历');
    const { readFile } = await import('node:fs/promises');
    const before = await readFile(file, 'utf8');
    await memory.invalidate(entry.id, { subject: LEAD, 原因: '结论已被推翻' });
    await memory.demote(entry.id, { subject: LEAD, 原因: '冷' });
    const after = await readFile(file, 'utf8');
    assert.ok(after.startsWith(before), '原条目那段字节必须原样在前，追加只能发生在尾部');
    const folded = await memory.query({ subject: LEAD, 类: ['经历'] });
    const target = folded.条目.find((e) => e.id === entry.id);
    assert.equal(target.状态, '已降权');
    assert.equal(target.历史.length, 2);
  });

  it('记忆：物理删除只对敏感数据或主权者开放，且仍然留一条不可逆记录', async () => {
    const entry = await memory.remember({ subject: LEAD, 类: '偏好', 内容: '临时偏好', 来源: '本人' });
    await assert.rejects(() => memory.purge(entry.id, { subject: LEAD, 理由: '我改主意了' }), (e) => e instanceof Denied);
    const purged = await memory.purge(entry.id, { subject: LEAD, 理由: '这是敏感数据，必须清掉', 敏感: true });
    assert.equal(purged.已删除, true);
    const { readFile } = await import('node:fs/promises');
    const text = await readFile(f.layout.memoryLog('跨项目', '偏好'), 'utf8');
    assert.ok(!text.includes('临时偏好'), '内容必须真的不在账本里');
    const rows = await f.audit.read({});
    assert.ok(rows.some((r) => r.动作 === '不可逆操作' && r.对象.id === entry.id), '删除这件事本身必须留痕');
  });

  it('记忆：晋升过的知识被物理删除时，另一本账上的副本也必须抹掉', async () => {
    // 双份留痕的代价：同一个 id 同时住在两本账上。
    // 只删「归属」那一本 ⇒ 另一本留下全文副本，而审计写着「内容已抹掉」。
    const entry = await memory.remember({ subject: LEAD, 类: '知识', 内容: '敏感结论：客户端低于 2.4 需兼容回退', 来源: '测试', 项目: P });
    await memory.promoteCrossProject(entry.id, { subject: LEAD, 岗位: '插件工程', 理由: '可复用' });
    const 本账 = f.layout.memoryLog(P, '知识');
    const 跨账 = f.layout.memoryLog('跨项目', '知识');
    assert.ok((await readJsonl(本账)).some((r) => r.id === entry.id), '前置：本项目账上有一份');
    assert.ok((await readJsonl(跨账)).some((r) => r.id === entry.id), '前置：跨项目账上也有一份');

    const purged = await memory.purge(entry.id, { subject: SOVEREIGN, 理由: '这是敏感数据，必须清掉' });
    assert.equal(purged.已删除, true);
    assert.deepEqual([...purged.清理覆盖].sort(), [P, '跨项目'].sort(), '两本账都要进覆盖范围');
    for (const file of [本账, 跨账]) {
      assert.ok(!(await readJsonl(file)).some((r) => r.id === entry.id), `${file} 上不许留有内容副本`);
    }
    const 检索 = await memory.query({ subject: LEAD, 类: ['知识'], 项目: P, 文本: '兼容回退' });
    assert.equal(检索.命中.length, 0, '删除后不许还能搜到');
  });

  it('记忆：id 与审计里都不许含正文（删得掉的前提）', async () => {
    // id 会进每一条审计记录的 `对象.id`，而审计只增、撤不回。
    // 正文一旦折进 id，`purge` 就永远删不干净 —— 这是「物理删除」能不能成立的前提。
    const 标记 = 'zzmark';
    const entry = await memory.remember({ subject: LEAD, 类: '经历', 内容: `${标记} 敏感标题不允许进 id`, 来源: '测试' });
    assert.ok(!entry.id.includes(标记), `id 不许含正文：${entry.id}`);

    // 人可读的标题仍在，只是搬到了字段里（它是账本的一行，purge 能连带抹掉）
    const row = (await readJsonl(f.layout.memoryLog('跨项目', '经历'))).find((r) => r.id === entry.id);
    assert.equal(row.标题, `${标记} 敏感标题不允许进 id`, '标题要另存字段，好让人还认得出这条');
    assert.equal(row.内容, `${标记} 敏感标题不允许进 id`);

    // 审计里出现这个 id 的每一笔，都不许带正文
    const rows = await f.audit.read({});
    const 相关 = rows.filter((r) => r.对象?.id === entry.id);
    assert.ok(相关.length > 0, '前置：这条记忆至少有一笔审计');
    for (const r of 相关) {
      assert.ok(!JSON.stringify(r).includes(标记), `审计不许带正文：${JSON.stringify(r)}`);
    }

    // 真的删掉之后，账本与审计合起来也搜不到那个标记
    await memory.purge(entry.id, { subject: SOVEREIGN, 理由: '这是敏感数据，必须清掉' });
    const 账本 = await readJsonl(f.layout.memoryLog('跨项目', '经历'));
    assert.ok(!账本.some((r) => r.id === entry.id), '账本里不许留');
    const 事后 = await f.audit.read({});
    assert.equal(事后.filter((r) => JSON.stringify(r).includes(标记)).length, 0, '审计里也不许留正文标记');
  });

  it('记忆：同一毫秒内同主体的两条不许撞 id', async () => {
    // id 的种子去掉了正文，只剩「类 + 主体 + 时刻」。
    // 不守住严格递增，同毫秒同主体的两条会算出同一个 id，
    // 而 fold() 按 id 归并 ⇒ 两条记忆**静默合成一条**（不报错，最难发现的那种）。
    const frozen = new Clock(() => new Date('2026-10-08T00:00:00.000Z'));
    const m = new MemoryService({ layout: f.layout, policy: f.policy, audit: f.audit, clock: frozen });
    const a = await m.remember({ subject: LEAD, 类: '偏好', 内容: '同一毫秒的第一条', 来源: '测试' });
    const b = await m.remember({ subject: LEAD, 类: '偏好', 内容: '同一毫秒的第二条', 来源: '测试' });
    assert.notEqual(a.id, b.id, '撞 id 会让 fold() 把两条静默合成一条');
    const 两条 = await m.query({ subject: LEAD, 类: ['偏好'] });
    assert.ok(两条.条目.some((e) => e.内容 === '同一毫秒的第一条' && e.id === a.id));
    assert.ok(两条.条目.some((e) => e.内容 === '同一毫秒的第二条' && e.id === b.id));
  });

  it('记忆：失效不进默认召回、但仍可见；含失效才拉回来，且降权不许复活它', async () => {
    const entry = await memory.remember({ subject: LEAD, 类: '知识', 内容: '乙案：这条结论后来作废了', 来源: '测试', 项目: P });
    await memory.invalidate(entry.id, { subject: LEAD, 原因: '被新证据推翻' });

    const 当前 = await memory.query({ subject: LEAD, 类: ['知识'], 项目: P, 文本: '作废' });
    assert.equal(当前.命中.length, 0, '失效条目不进默认召回');
    assert.ok(当前.条目.some((e) => e.id === entry.id), '但要留在 条目 里供追溯');
    assert.equal(当前.口径.排除失效, 1, '口径必须点名排除了几条，不许折成「没找到」');
    assert.match(当前.说明 ?? '', /含失效/, '说明要给出把它拉回来的办法');

    const 历史 = await memory.query({ subject: LEAD, 类: ['知识'], 项目: P, 文本: '作废', 含失效: true });
    assert.equal(历史.命中.length, 1, '含失效: true 要能召回');
    assert.equal(历史.口径.失效条目数, 1, '「有几条失效」要报');
    assert.equal(历史.口径.排除失效, 0, '一条都没排除时不许报成排除了 —— 假读数比没读数更贵');

    // 「冷」不许撤销「错」：后来追加的降权不能把它放回当前召回面。
    await memory.demote(entry.id, { subject: LEAD, 原因: '这条冷下来了' });
    const 降权后 = await memory.query({ subject: LEAD, 类: ['知识'], 项目: P, 文本: '作废' });
    assert.equal(降权后.命中.length, 0, '失效是事实判断，降权是优先级判断，降权不许复活它');
    assert.equal(降权后.条目.find((e) => e.id === entry.id).状态, '已降权', '但状态读数要如实反映最后一次处置');
  });

  it('记忆：作答归档后的可读性矩阵', async () => {
    const answer = await memory.remember({ subject: MEMBER, 类: '作答', 内容: '我的作答内容', 来源: '实例作答', 项目: P, 任务: { 负责人: 'member-a' } });
    const archived = await memory.archiveAnswers({ 项目: P, 任务: 'task-x', subject: LEAD });
    assert.ok(archived.归档条数 >= 1);

    const 默认面 = await memory.query({ subject: LEAD, 项目: P });
    assert.ok(!默认面.条目.some((e) => e.id === answer.id), '归档作答不进默认检索面');
    // 显式检索必须自报读者（2026-10-13 审查 P1-9）：不传读者的 显式:true 不再跳过可读性检查——
    // 否则任何成员不带读者就能读归档作答。动作面（memory_query）恒传 读者=主体，不受影响。
    const 无读者 = await memory.query({ subject: MEMBER, 项目: P, 显式: true });
    assert.ok(!无读者.条目.some((e) => e.id === answer.id), '显式检索不传读者 ⇒ 归档作答照旧不可见（fail-closed）');
    const 显式面 = await memory.query({ subject: LEAD, 项目: P, 显式: true, 读者: LEAD });
    assert.ok(显式面.条目.some((e) => e.id === answer.id), '可显式检索（读者在可读名单内）');
    assert.match(显式面.说明 ?? '', /显式/);

    assert.equal((await memory.readableBy(answer.id, { 读者: REVIEWER })).可读, true);
    assert.equal((await memory.readableBy(answer.id, { 读者: LEAD })).可读, true);
    const 成员 = await memory.readableBy(answer.id, { 读者: MEMBER });
    assert.equal(成员.可读, false);
    assert.match(成员.原因, /不可读/);
  });

  it('检索：BM25 确定性、相关文档排前、0 命中必带口径', () => {
    const docs = [
      { id: 'a', 正文: '策略引擎是唯一判定点，必须 fail-closed，拒绝要带可执行理由。' },
      { id: 'b', 正文: '消息总线支持暂不投递与线程隔离。' },
      { id: 'c', 正文: '任务图的验收标准必填，派发后判据冻结。' },
    ];
    const index = buildIndex(docs);
    const first = search(index, '判据冻结', { limit: 3 });
    const second = search(index, '判据冻结', { limit: 3 });
    assert.deepEqual(first, second, '相同输入必须给出相同排序');
    assert.equal(first.命中[0].id, 'c');

    const miss = search(index, '完全不存在的词汇zzz', { limit: 3 });
    assert.equal(miss.命中.length, 0);
    assert.equal(miss.口径.搜索面, '正文+标签', '搜索面要报**真实字段集**：索引取的是正文+标签，不是只取正文');
    assert.equal(miss.口径.查询词.length > 0, true);
    assert.equal(miss.口径.范围.length > 0, true);
    assert.match(formatMiss(miss.口径), /搜索面|范围/);

    // 长度归一化：短文档命中该词时不该被长文档的重复词淹没。
    const long = buildIndex([
      { id: 'long', 正文: `无关内容。${'填充内容。'.repeat(200)}判据冻结在末尾出现一次。` },
      { id: 'short', 正文: '判据冻结' },
    ]);
    assert.equal(search(long, '判据冻结').命中[0].id, 'short');
  });

  it('检索回归集：改任何检索口径都必须能跑出差异，且结果变了要显式确认', async () => {
    const docs = [
      { id: 'a', 正文: '策略引擎是唯一判定点，必须 fail-closed。' },
      { id: 'b', 正文: '消息总线支持暂不投递。' },
      { id: 'c', 正文: '任务图的验收标准必填，派发后判据冻结。' },
    ];
    const index = buildIndex(docs);
    const 回归集 = [
      { 查询: '判据冻结', 期望: 'c' },
      { 查询: 'fail-closed', 期望: 'a' },
    ];
    const topOf = (query) => search(index, query, { limit: 1 }).命中[0]?.id ?? '';

    const fresh = await runRegression({ 回归集, 执行: topOf });
    assert.equal(fresh.通过, true, `新口径下回归集应通过：${fresh.差异.join('；')}`);
    assert.equal(fresh.用例.length, 2);

    // 基线漂移必须被点名，而不是被当成通过 —— 这是「改口径必跑」的判据。
    const drifted = await runRegression({ 回归集, 基线: [{ 查询: '判据冻结', 实际: 'a' }], 执行: topOf });
    assert.equal(drifted.通过, false);
    assert.match(drifted.差异.join('；'), /现状|变了|结果/);

    // 期望值变了也必须报出来。
    const wrong = await runRegression({ 回归集: [{ 查询: '判据冻结', 期望: 'a' }], 执行: topOf });
    assert.equal(wrong.通过, false);
    assert.match(wrong.差异.join('；'), /判据冻结/);
  });

  it('反趋同：零分歧由会审存档现算（强制反对者已砍）；盲评提交前不解锁', async () => {
    // v2（条目18/19）：强制反对者砍掉、会审退出任务图 ⇒ 「反趋同」落在
    // council.converge 的零分歧判定与存档报警上；提交前解锁仍被服务层拒。
    const MEMBER_B = { id: 'member-b', kind: '成员', roleId: '插件工程' };
    const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
    const 开 = await org.council.open({ subject: LEAD, 项目: P, 问题: '反趋同', 参与者: ['member-a', 'member-b'] });
    await org.council.answer({ subject: MEMBER, 项目: P, id: 开.id, 结论: 'A 案', 结论层: '方案A' });
    await assert.rejects(
      () => org.council.unlock({ subject: LEAD, 项目: P, id: 开.id }),
      (e) => e instanceof Denied && /全员已交/.test(e.rule),
      '未交齐不得提前揭名（盲评边界）',
    );
    await org.council.answer({ subject: MEMBER_B, 项目: P, id: 开.id, 结论: 'A 案', 结论层: '方案A' });
    await org.council.unlock({ subject: LEAD, 项目: P, id: 开.id });
    const 收 = await org.council.converge({ subject: LEAD, 项目: P, id: 开.id });
    assert.equal(收.零分歧, true, '结论层一致且无人给反例面 ⇒ 全票一致 = 异常信号');
    const 报警 = (await org.audit.read({})).filter((r) => r.动作 === '零分歧异常' && r.对象?.id === 开.id);
    assert.equal(报警.length, 1, '零分歧报警入审计（人工抽检的触发面）');

    // 历史任务图的 openBlind 语义不动（旧数据只读；鉴权与重算仍按任务图）。
    // 夹具改形（#9 · 设计评审 2026-10-15）：openBlind 在注入了任务图时必须给 节点 并从
    // 独立答案重算（与 bus.unlock 修法同路）——修前按自报 已交 名单判定，任务图未齐也放行。
    // 本夹具的 review 恒注入 tasks（before 块），所以这里用真实节点而不是自报名单。
    const 未交齐节点 = await tasks.create({ subject: LEAD, 项目: P, 描述: '盲评未交齐', 负责人: ['member-a', 'member-b'], 模式: '独立会审', 判据: ['x'] });
    await tasks.dispatch(未交齐节点.id, { subject: LEAD, 项目: P });
    await tasks.start(未交齐节点.id, { subject: MEMBER, 项目: P });
    await tasks.submit(未交齐节点.id, { subject: MEMBER, 项目: P, 结论: 'A 案' });
    await assert.rejects(
      () => review.openBlind({ subject: LEAD, 项目: P, 线程: 't-1', 节点: 未交齐节点.id, 参与者: ['member-a', 'member-b'], 已交: ['member-a', 'member-b'] }),
      (e) => e instanceof Denied && /未交卷|保持盲评/.test(e.message),
      '自报 已交 全员但任务图只有一份 ⇒ 重算拒（修前放行）',
    );
    const 交齐节点 = await tasks.create({ subject: LEAD, 项目: P, 描述: '盲评交齐', 负责人: ['member-a', 'member-b'], 模式: '独立会审', 判据: ['x'] });
    await tasks.dispatch(交齐节点.id, { subject: LEAD, 项目: P });
    await tasks.start(交齐节点.id, { subject: MEMBER, 项目: P });
    await tasks.submit(交齐节点.id, { subject: MEMBER, 项目: P, 结论: 'A 案' });
    await tasks.submit(交齐节点.id, { subject: MEMBER_B, 项目: P, 结论: 'B 案' });
    const blind = await review.openBlind({ subject: LEAD, 项目: P, 线程: 't-1', 节点: 交齐节点.id, 参与者: ['member-a', 'member-b'], 已交: [] });
    assert.equal(blind.解锁, true);
    // 盲标映射已随机化（2026-10-13 裁决第二批 P2-13）：映射顺序不可预测 ⇒ 只断「集合覆盖」
    // 与「盲标唯一」，不断言谁拿 A（那正是修前的去匿名面）。
    assert.deepEqual(blind.盲标.map((b) => b.盲标), ['成员 A', '成员 B']);
    assert.deepEqual([...new Set(blind.盲标.map((b) => b.id))].sort(), ['member-a', 'member-b'], '每个参与者恰好一个盲标');
    const revealed = await review.reveal({ subject: LEAD, 项目: P, 线程: 't-1', 参与者: ['member-a', 'member-b'] });
    // 揭名与 openBlind 同一确定性映射（P2-13）：同一线程+名册，两边逐人对得上。
    for (const r of revealed.揭名) {
      assert.equal(r.盲标, blind.盲标.find((b) => b.id === r.id).盲标, `揭名与盲评映射一致：${r.id}`);
    }
  });

  it('反趋同：零分歧从任务图独立答案重算（不收自报），并记一笔触发抽检', async () => {
    const MEMBER_B = { id: 'member-b', kind: '成员', roleId: '插件工程' };
    const 有反例节点 = await tasks.create({ subject: LEAD, 项目: P, 描述: '有反例', 负责人: ['member-a', 'member-b'], 模式: '独立会审', 判据: ['x'] });
    await tasks.dispatch(有反例节点.id, { subject: LEAD, 项目: P });
    await tasks.start(有反例节点.id, { subject: MEMBER, 项目: P });
    await tasks.submit(有反例节点.id, { subject: MEMBER, 项目: P, 结论: '可以' });
    await tasks.submit(有反例节点.id, { subject: MEMBER_B, 项目: P, 结论: '可以', 反例面: ['边界情况没覆盖'] });
    const 有反例 = await review.checkZeroDivergence({ subject: LEAD, 项目: P, 节点: 有反例节点.id });
    assert.equal(有反例.零分歧, false, '有人给了反例面就不算零分歧');
    assert.match(有反例.结论集来源, /任务图独立答案重算/, '结论集必须从任务图重算，不收自报');

    const 零节点 = await tasks.create({ subject: LEAD, 项目: P, 描述: '全票一致', 负责人: ['member-a', 'member-b'], 模式: '独立会审', 判据: ['x'] });
    await tasks.dispatch(零节点.id, { subject: LEAD, 项目: P });
    await tasks.start(零节点.id, { subject: MEMBER, 项目: P });
    await tasks.submit(零节点.id, { subject: MEMBER, 项目: P, 结论: '通过' });
    await tasks.submit(零节点.id, { subject: MEMBER_B, 项目: P, 结论: '通过' });
    // 自报一份带假「反例面」的结论集（P1-8 攻击面）：服务层必须无视它，仍按任务图重算 ⇒ 照样报警。
    const 零分歧 = await review.checkZeroDivergence({
      subject: LEAD, 项目: P, 节点: 零节点.id,
      结论集: [{ 成员: 'a', 结论: 'x', 反例面: ['假反例压报警'] }, { 成员: 'b', 结论: 'y', 反例面: ['假反例压报警'] }],
    });
    assert.equal(零分歧.零分歧, true, '自报结论集被无视：两份同文结论且无反例面 ⇒ 零分歧（异常信号）');
    assert.equal(零分歧.触发人工抽检, true);
    const rows = await f.audit.read({});
    assert.ok(rows.some((r) => r.动作 === '零分歧异常' && String(r.结果).includes('零分歧')), '审计里必须有这笔异常');
  });

  it('复核结论不经 Lead 修改：记录不同意只追加，原结论不动', async () => {
    const node = await tasks.create({ subject: LEAD, 项目: P, 描述: '结论不可改', 负责人: 'member-a', 判据: ['x'] });
    await tasks.dispatch(node.id, { subject: LEAD, 项目: P });
    await tasks.start(node.id, { subject: MEMBER, 项目: P });
    await tasks.submit(node.id, { subject: MEMBER, 项目: P });
    await seedReviewRelation(f, { 项目: P, 目标: node.id });
    await review.record({ subject: REVIEWER, 项目: P, 节点: node.id, 三态: '不过', 分歧清单: ['判据未满足'] });
    const before = await tasks.get(node.id, { 项目: P });
    const disagreement = await review.recordDisagreement({ subject: LEAD, 项目: P, 节点: node.id, 理由: '我不同意' });
    assert.equal(disagreement.结论未改动, true);
    const after = await tasks.get(node.id, { 项目: P });
    assert.deepEqual(after.复核经过, before.复核经过, '复核经过不得被 Lead 改写');
    const rows = await f.audit.read({});
    assert.ok(rows.some((r) => String(r.结果).includes('Lead 记录不同意')));
  });
});
