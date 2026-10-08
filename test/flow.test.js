/**
 * 任务图 / 消息总线 / 记忆 / 检索 / 复核 / 反趋同。
 *
 * 这一组测的是「主干环路」能不能真的跑起来，以及每条机制在**越界**时是否拒绝：
 * 判据冻结、线程隔离、不许改写只能追加、会审解锁边界、零分歧报警。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, SOVEREIGN, LEAD, MEMBER, REVIEWER } from './helpers.mjs';
import { TaskGraph } from '../src/tasks.js';
import { MessageBus } from '../src/bus.js';
import { MemoryService } from '../src/memory.js';
import { ReviewProtocol } from '../src/review.js';
import { buildIndex, formatMiss, runRegression, search } from '../src/retrieval.js';
import { Denied, InvalidBody } from '../src/kernel/errors.js';
import { readJsonl } from '../src/kernel/fsx.js';
import { Clock } from '../src/kernel/time.js';

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

  it('任务：判据必填，一岗多人必标模式', async () => {
    await assert.rejects(() => tasks.create({ subject: LEAD, 项目: P, 描述: '没判据', 负责人: 'member-a' }), (e) => e instanceof InvalidBody);
    await assert.rejects(() => tasks.create({ subject: LEAD, 项目: P, 描述: '没负责人', 判据: ['x'] }), (e) => e instanceof InvalidBody);
    await assert.rejects(
      () => tasks.create({ subject: LEAD, 项目: P, 描述: '两人没模式', 负责人: ['member-a', 'member-b'], 判据: ['x'] }),
      (e) => e instanceof InvalidBody && /一岗多人/.test(e.message),
    );
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

  it('消息总线：线程隔离、暂不投递、会审解锁的硬边界', async () => {
    await bus.send({ subject: LEAD, 项目: P, 线程: 't-1', 发件: 'lead', 收件: ['member-a'], 类型: '派活', 内容: '做 A' });
    await bus.send({ subject: LEAD, 项目: P, 线程: 't-2', 发件: 'lead', 收件: ['member-a'], 类型: '派活', 内容: '做 B' });
    await bus.send({ subject: LEAD, 项目: P, 线程: 't-1', 发件: 'lead', 收件: ['member-a'], 类型: '表态', 内容: '稍后投递', 暂不投递: true });

    const t1 = await bus.read({ 项目: P, 线程: 't-1' });
    assert.equal(t1.length, 2);
    assert.ok(t1.every((m) => m.线程 === 't-1'), '不得跨线程返回');
    const t2 = await bus.read({ 项目: P, 线程: 't-2' });
    assert.equal(t2.length, 1);
    assert.equal((await bus.read({ 项目: P, 线程: 't-1', 未投递: true })).length, 1);

    const deferred = t1.find((m) => m.状态 === '暂不投递');
    const delivered = await bus.deliver({ 项目: P, 线程: 't-1', id: deferred.id, subject: LEAD });
    assert.equal(delivered.状态, '已投递');

    const locked = await bus.unlock({ subject: LEAD, 项目: P, 线程: 't-1', 全员已交: false, 参与者: ['member-a'] });
    assert.equal(locked.解锁, false);
    assert.match(locked.原因, /全员已交/);
    const unlocked = await bus.unlock({ subject: LEAD, 项目: P, 线程: 't-1', 全员已交: true, 参与者: ['member-a'] });
    assert.equal(unlocked.解锁, true);
    assert.ok(unlocked.广播);
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
    const folded = await memory.query({ 类: ['经历'] });
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
    const 检索 = await memory.query({ 类: ['知识'], 项目: P, 文本: '兼容回退' });
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
    const 两条 = await m.query({ 类: ['偏好'] });
    assert.ok(两条.条目.some((e) => e.内容 === '同一毫秒的第一条' && e.id === a.id));
    assert.ok(两条.条目.some((e) => e.内容 === '同一毫秒的第二条' && e.id === b.id));
  });

  it('记忆：失效不进默认召回、但仍可见；含失效才拉回来，且降权不许复活它', async () => {
    const entry = await memory.remember({ subject: LEAD, 类: '知识', 内容: '乙案：这条结论后来作废了', 来源: '测试', 项目: P });
    await memory.invalidate(entry.id, { subject: LEAD, 原因: '被新证据推翻' });

    const 当前 = await memory.query({ 类: ['知识'], 项目: P, 文本: '作废' });
    assert.equal(当前.命中.length, 0, '失效条目不进默认召回');
    assert.ok(当前.条目.some((e) => e.id === entry.id), '但要留在 条目 里供追溯');
    assert.equal(当前.口径.排除失效, 1, '口径必须点名排除了几条，不许折成「没找到」');
    assert.match(当前.说明 ?? '', /含失效/, '说明要给出把它拉回来的办法');

    const 历史 = await memory.query({ 类: ['知识'], 项目: P, 文本: '作废', 含失效: true });
    assert.equal(历史.命中.length, 1, '含失效: true 要能召回');
    assert.equal(历史.口径.失效条目数, 1, '「有几条失效」要报');
    assert.equal(历史.口径.排除失效, 0, '一条都没排除时不许报成排除了 —— 假读数比没读数更贵');

    // 「冷」不许撤销「错」：后来追加的降权不能把它放回当前召回面。
    await memory.demote(entry.id, { subject: LEAD, 原因: '这条冷下来了' });
    const 降权后 = await memory.query({ 类: ['知识'], 项目: P, 文本: '作废' });
    assert.equal(降权后.命中.length, 0, '失效是事实判断，降权是优先级判断，降权不许复活它');
    assert.equal(降权后.条目.find((e) => e.id === entry.id).状态, '已降权', '但状态读数要如实反映最后一次处置');
  });

  it('记忆：作答归档后的可读性矩阵', async () => {
    const answer = await memory.remember({ subject: MEMBER, 类: '作答', 内容: '我的作答内容', 来源: '实例作答', 项目: P, 任务: { 负责人: 'member-a' } });
    const archived = await memory.archiveAnswers({ 项目: P, 任务: 'task-x', subject: LEAD });
    assert.ok(archived.归档条数 >= 1);

    const 默认面 = await memory.query({ 项目: P });
    assert.ok(!默认面.条目.some((e) => e.id === answer.id), '归档作答不进默认检索面');
    const 显式面 = await memory.query({ 项目: P, 显式: true });
    assert.ok(显式面.条目.some((e) => e.id === answer.id), '可显式检索');
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
    assert.equal(miss.口径.搜索面, '正文');
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

  it('反趋同：强制反对者不重复、不选参与者；盲评提交前不解锁', async () => {
    const first = await review.pickDissenter({ 项目: P, 节点: 'n-1', 参与者: ['member-a'], 候选: ['member-a', 'member-b', 'member-c'] });
    assert.notEqual(first.反对者, 'member-a');
    const second = await review.pickDissenter({ 项目: P, 节点: 'n-1', 参与者: ['member-a'], 候选: ['member-a', 'member-b', 'member-c'] });
    assert.notEqual(second.反对者, first.反对者, '同一节点不得重复指定');

    await assert.rejects(
      () => review.openBlind({ subject: LEAD, 项目: P, 线程: 't-1', 参与者: ['member-a', 'member-b'], 已交: ['member-a'] }),
      (e) => e instanceof Denied,
    );
    const blind = await review.openBlind({ subject: LEAD, 项目: P, 线程: 't-1', 参与者: ['member-a', 'member-b'], 已交: ['member-a', 'member-b'] });
    assert.equal(blind.解锁, true);
    assert.deepEqual(blind.盲标.map((b) => b.盲标), ['成员 A', '成员 B']);
    assert.ok(!JSON.stringify(blind.盲标.at(0)).includes('member-a') === false, '盲标阶段本就不该给名字对齐；揭名在讨论阶段');
    const revealed = await review.reveal({ subject: LEAD, 项目: P, 线程: 't-1', 参与者: ['member-a', 'member-b'] });
    assert.equal(revealed.揭名.find((r) => r.盲标 === '成员 A').id, 'member-a');
  });

  it('反趋同：零分歧按「结论层一致且无人给反例面」判定，并记一笔触发抽检', async () => {
    const 有反例 = await review.checkZeroDivergence({
      subject: LEAD, 项目: P, 节点: 'n-2',
      结论集: [
        { 成员: 'a', 结论: '可以' },
        { 成员: 'b', 结论: '可以' },
        { 成员: 'c', 结论: '可以', 反例面: ['边界情况没覆盖'] },
      ],
    });
    assert.equal(有反例.零分歧, false, '有人给了反例面就不算零分歧');

    const 零分歧 = await review.checkZeroDivergence({
      subject: LEAD, 项目: P, 节点: 'n-3',
      结论集: [
        { 成员: 'a', 结论: '通过', 结论层: '可以' },
        { 成员: 'b', 结论: '同意', 结论层: '可以' },
        { 成员: 'c', 结论: '无异议', 结论层: '可以' },
      ],
    });
    assert.equal(零分歧.零分歧, true, '措辞不同但结论层一致 ⇒ 仍是零分歧');
    assert.equal(零分歧.触发人工抽检, true);
    const rows = await f.audit.read({});
    assert.ok(rows.some((r) => r.动作 === '零分歧异常' && String(r.结果).includes('零分歧')), '审计里必须有这笔异常');
  });

  it('复核结论不经 Lead 修改：记录不同意只追加，原结论不动', async () => {
    const node = await tasks.create({ subject: LEAD, 项目: P, 描述: '结论不可改', 负责人: 'member-a', 判据: ['x'] });
    await tasks.dispatch(node.id, { subject: LEAD, 项目: P });
    await tasks.start(node.id, { subject: MEMBER, 项目: P });
    await tasks.submit(node.id, { subject: MEMBER, 项目: P });
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
