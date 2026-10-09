/**
 * W3 批1 · 并发一致性（2026-10-09）——五条修复的**塞 bug 校准**测试。
 *
 * 这一批修的是同一类病：**读-改-写没进闸**。五个现场各自都能独立复现，所以每条断言都
 * 先按「把实现故意改坏 → 必红」校准过（红绿读数见提交说明）：
 *  ① fsx.withLock「验后删」——原持有者不得删掉强夺者重建的锁（三方同进洞）；
 *  ② store.write 对象级锁——并发写同一 id 不得算出同一个 previous/version；
 *  ③ tasks.reject 打回计数入锁——并发 reject 不得丢次数、升级判定按锁内结果；
 *  ④ runtime.shareKey 路径归一——同一私有区的两种写法必须同键（否则两个 Org 实例双写审计链）；
 *  ⑤ 记忆账本锁统一——追加与 purge 的整文件重写共用 `${file}.lock`；多实例同毫秒不撞 id。
 *
 * 这些测的都是**机制的时序面**，不是「跑一次看看」：所以每一个都用「先把闸拿在手里，
 * 再断言操作被挡住 / 断言两个结果各不相同」这类确定性构造，不靠 sleep 撞运气。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readJsonl, readTextOrNull, sleep, withLock } from '../src/kernel/fsx.js';
import { Clock } from '../src/kernel/time.js';
import { makeFixture, LEAD, REVIEWER, SOVEREIGN } from './helpers.mjs';
import { ObjectStore } from '../src/store.js';
import { TaskGraph } from '../src/tasks.js';
import { MemoryService, fold } from '../src/memory.js';
import { forgetSharedOrg, shareKey, shareOrg, sharedOrgCount } from '../src/runtime.js';

/** @type {Awaited<ReturnType<typeof makeFixture>>} */
let f;
/** @type {ObjectStore} */ let store;
/** @type {TaskGraph} */ let tasks;
/** @type {MemoryService} */ let memory;

const P = 'w3-proj';

/** 能力卡正文（store.write 的 body 不吃 front matter，元数据由 meta 给）。 */
const 能力正文 = (标记) => ['# 并发演示', '', '## 适用岗位', '- 插件工程', '', '## 怎么做', `${标记}：并发写同一个 id 时各写各的版本。`].join('\n');

/** 记忆写入的最小合规输入。 */
const 记一条 = (内容, extra = {}) => ({ subject: LEAD, 类: '知识', 内容, 来源: '测试', 项目: 'default', ...extra });

describe('W3 批1 · 并发一致性', () => {
  before(async () => {
    f = await makeFixture();
    store = new ObjectStore({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
    tasks = new TaskGraph({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
    memory = new MemoryService({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
  });
  after(async () => {
    forgetSharedOrg();
    await f.cleanup();
  });

  it('①fsx.withLock「验后删」：锁易主后原持有者不删新锁，也不吞声；没易主的照常释放', async () => {
    const lockPath = join(f.home, '锁探针', 'steal.lock');
    const 留痕 = [];
    const 原warn = console.warn;
    console.warn = (...args) => 留痕.push(args.join(' '));
    try {
      await withLock(lockPath, async () => {
        // 复刻病根：持有者 A 的 fn 太慢 ⇒ 等待者 B 判 stale 强夺，删掉旧锁并**建出自己的锁文件**。
        // 真正要验的是 A 的 finally 此刻读到的令牌不是自己的 ⇒ 不许 rm。
        const { rm, writeFile } = await import('node:fs/promises');
        await rm(lockPath, { force: true });
        await writeFile(lockPath, JSON.stringify({ pid: process.pid, at: 'B-持有者' }), 'utf8');
      });
    } finally {
      console.warn = 原warn;
    }
    const 现 = await readTextOrNull(lockPath);
    assert.ok(现 !== null, 'B 的锁必须还在：原持有者无条件 rm 就是「第三者可进临界区」的那条路');
    assert.equal(JSON.parse(现).at, 'B-持有者', '留下的必须是新持有者的令牌，而不是 A 的');
    assert.equal(留痕.length, 1, '锁易主要留痕（§3.6 不吞声）');
    assert.match(留痕[0], /锁已易主/);

    // 反面：不是「一律不删」。没被夺走的锁，出让时必须真的释放。
    const 普通 = join(f.home, '锁探针', 'normal.lock');
    await withLock(普通, async () => {});
    assert.equal(await readTextOrNull(普通), null, '没易主的锁不释放 ⇒ 下一个人等到超时（这是另一种坏）');
  });

  it('②store.write 对象级锁：并发写同一 id 不共用同一个 previous/version，历史与指针不撕', async () => {
    const id = 'w3-concurrent';
    const meta = () => ({ meta: { id, authority: '自治', domain: '集体', project: null }, spec: { subject: LEAD, reason: '并发之一' } });
    const 甲 = meta();
    const 乙 = meta();
    乙.spec = { subject: LEAD, reason: '并发之二' };

    const [a, b] = await Promise.all([
      store.write('能力', { meta: 甲.meta, body: 能力正文('甲') }, 甲.spec),
      store.write('能力', { meta: 乙.meta, body: 能力正文('乙') }, 乙.spec),
    ]);

    assert.deepEqual([a.version, b.version].sort((x, y) => x - y), [1, 2], '并发写同一对象必须各拿一个版本号（不锁 ⇒ 两个都算 v1，后写的盖掉前写的）');
    assert.equal([a, b].filter((r) => r.previous === null).length, 1, '只能有一个是「首建」');
    assert.equal([a, b].filter((r) => r.previous === 1).length, 1, '另一个必须看得见前一版');

    const 指针 = (await store.pointers(id))[id];
    assert.equal(指针.version, 2, '版本指针不许停在被打断的那一刻');
    const 历史 = await store.history(id);
    assert.deepEqual(历史.map((h) => h.version), [1], '留前一版只能留一次（不锁会各留一份 v1，撕开版本史）');
    const 当前 = await store.read('能力', id, { subject: LEAD });
    assert.equal(Number(当前.meta.version), 2, '盘上正文必须是 v2');
    assert.equal(当前.digest, (a.version === 2 ? a : b).digest, '盘上正文与 v2 那次写入的摘要必须一致');
  });

  it('③tasks.reject 打回计数入锁：并发 reject 不丢计数，升级判定按锁内结果', async () => {
    const node = await tasks.create({ subject: LEAD, 项目: P, 描述: '并发打回演示', 负责人: 'member-a', 判据: ['x'] });
    await tasks.dispatch(node.id, { subject: LEAD, 项目: P });
    await tasks.start(node.id, { subject: LEAD, 项目: P });
    await tasks.submit(node.id, { subject: LEAD, 项目: P, 产出物引用: ['artifact-w3-1'] });

    await Promise.all([
      tasks.reject(node.id, { subject: REVIEWER, 项目: P, 理由: '并发打回 一' }),
      tasks.reject(node.id, { subject: REVIEWER, 项目: P, 理由: '并发打回 二' }),
    ]);

    const 行 = (await tasks.events({ 项目: P })).filter((r) => r.id === node.id);
    assert.deepEqual(
      行.filter((r) => r.kind === 'rejected').map((r) => r.打回次数).sort((x, y) => x - y),
      [1, 2],
      '两次并发打回必须一次算 1、一次算 2（锁外算 ⇒ 两条都写 1，链上少一次打回）',
    );
    const 节点 = await tasks.get(node.id, { 项目: P });
    assert.equal(节点.打回次数, 2);
    assert.equal(节点.升级?.至, '主权者', '次数够 2 就必须升级；丢计数会让升级永不发生');
    assert.equal(行.filter((r) => r.kind === 'escalated').length, 1, '只升级一次：并发下不许两条都判「≥2」');
  });

  it('④runtime.shareKey 路径归一：同一私有区的两种写法同键，且共用同一个 Org 实例', async () => {
    // 写法一：组件自己按 home 拼；写法二：Layout 的 join 结果；写法三：字面斜杠拼接。
    const 键_home = shareKey({ home: f.home, project: 'w3-p1' });
    const 键_join = shareKey({ privateRoot: join(f.home, 'mind-data', 'mind-private'), project: 'w3-p1' });
    const 键_斜杠 = shareKey({ privateRoot: `${f.home}/mind-data/mind-private`, project: 'w3-p1' });
    const 键_尾斜杠 = shareKey({ privateRoot: `${join(f.home, 'mind-data', 'mind-private')}/`, project: 'w3-p1' });
    assert.equal(键_home, 键_join, '同一个目录两种写法必须同键（不同键 ⇒ 两个 Org 实例双写同一条审计链）');
    assert.equal(键_home, 键_斜杠);
    assert.equal(键_home, 键_尾斜杠);
    assert.notEqual(键_home, shareKey({ home: f.home, project: 'w3-p2' }), '项目不同仍是不同的组织');

    // 端到端：两种写法真的只装配一次，且拿到的是同一个实例。
    forgetSharedOrg();
    const 甲 = shareOrg({ home: f.home, factoryRoot: f.factoryRoot, project: 'w3-p1' });
    const 乙 = shareOrg({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: join(f.home, 'mind-data', 'mind-private'), project: 'w3-p1' });
    assert.equal(sharedOrgCount(), 1, '同一私有区只许装配一个 Org');
    assert.equal(await 甲, await 乙, '两次调用必须拿到同一个对象（缓存键相同）');
    forgetSharedOrg();
  });

  it('⑤记忆账本锁统一：追加排在 `${file}.lock` 后面，purge 的整文件重写抹不掉并发追加的行', async () => {
    const file = f.layout.memoryLog('default', '知识');
    const 锁 = `${file}.lock`;

    // 先拿住**purge 重写用的那把锁**：账本追加若绕过它，这里就会立刻返回（必红）。
    const 闸 = withLock(锁, async () => {
      await sleep(300);
    });
    await sleep(40);
    let 条目完成 = false;
    const 条目 = memory.remember(记一条('锁统一：这条不能被 purge 的整文件重写盖掉')).then((r) => {
      条目完成 = true;
      return r;
    });
    await sleep(150);
    assert.equal(条目完成, false, '条目追加必须与 purge 的重写共用 `${file}.lock`，不许绕过');
    await 闸;
    const 行 = await 条目;
    assert.equal(条目完成, true, '闸放开后必须落线，不是被锁死');

    // 状态行是另一条追加路径（#appendState），同样必须走这把锁。
    const 闸2 = withLock(锁, async () => {
      await sleep(250);
    });
    await sleep(40);
    let 状态完成 = false;
    const 状态 = memory.invalidate(行.id, { subject: LEAD, 原因: '锁统一演示' }).then((x) => {
      状态完成 = true;
      return x;
    });
    await sleep(120);
    assert.equal(状态完成, false, '状态行追加也必须排在账本锁后面');
    await 闸2;
    await 状态;

    // 物理抹是「读全文 → 滤掉目标 id → 整文件重写」：不连坐、且并发追加的条目必须还在。
    const 邻居 = await memory.remember(记一条('锁统一：purge 之后这条必须还在'));
    await memory.purge(行.id, { subject: SOVEREIGN, 理由: '锁统一演示：物理删除', 敏感: true });
    const rows = await readJsonl(file);
    assert.ok(!rows.some((r) => r.id === 行.id), '目标条目行应被物理抹掉');
    assert.ok(rows.some((r) => r.id === 邻居.id), '物理抹不许连坐：同账本其它条目必须还在');
    assert.ok(rows.some((r) => r.指向 === 行.id), '待删除状态行留在账上（物理删除这件事本身要留痕）');
  });

  it('⑤b remember 撞 id：两个实例同毫秒同主体 → 锁内查重 bump，两条不许静默 fold 合一', async () => {
    const 冻结 = new Date('2026-10-09T12:00:00.000Z');
    const 服务s = [1, 2].map(() => new MemoryService({ layout: f.layout, policy: f.policy, audit: f.audit, clock: new Clock(() => 冻结) }));

    const [a, b] = await Promise.all([
      服务s[0].remember({ subject: LEAD, 类: '经历', 内容: '同毫秒 甲', 来源: '测试' }),
      服务s[1].remember({ subject: LEAD, 类: '经历', 内容: '同毫秒 乙', 来源: '测试' }),
    ]);

    assert.notEqual(a.id, b.id, '两个实例同毫秒同主体会算出同一个 id：fold 按 id 归并 ⇒ 两条记忆静默合一');
    const rows = await readJsonl(f.layout.memoryLog('跨项目', '经历'));
    assert.equal(rows.filter((r) => r.id === a.id || r.id === b.id).length, 2, '两条都得落线');
    assert.equal(fold(rows).filter((e) => e.id === a.id || e.id === b.id).length, 2, '折叠视图里也必须是两条');
  });
});
