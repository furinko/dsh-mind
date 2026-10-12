/**
 * 2026-10-12 评审批次 3：存储底座四修（P1-5 / P1-6 / P1-7 / P1-10 + P2-9）。
 *
 *  - P1-5 capability.read 路径逃逸：id 先过 assertPathSegment。
 *  - P1-6 archiveAnswers 从 fold 出的当前视图滤「未归档」（修前滤原始行 ⇒ 重复归档、
 *    账本长胖、审计读数虚高）；读与追加并进同一把锁（设计债⑦）。
 *  - P1-7 promoteCrossProject：fold 派生键（历史/状态/账本出现于）不许回落账本；
 *    被否的知识不许晋升（判据与召回面同源）。
 *  - P1-10 withLock 强夺/删除挂起两条路径收进公共「超时 + 退避」出口（修前裸 continue
 *    ⇒ 100% CPU 热循环且永不超时）；staleMs 15s ⇒ 60s（P2-9：慢 ≠ 死）。
 *
 * 断言全部经塞 bug 校准（造坏 ⇒ 必红）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { makeFixture, LEAD } from './helpers.mjs';
import { MemoryService } from '../src/memory.js';
import { CapabilityLibrary } from '../src/capability.js';
import { readJsonl, withLock } from '../src/kernel/fsx.js';
import { DIR } from '../src/paths.js';

const P = 'default';

describe('批次3 · P1-5：capability.read 的 id 先过段校验', () => {
  it('路径逃逸 id ⇒ 拒（修前直接拼路径读库外任意 .md）；合法但不存在的 id ⇒ null', async () => {
    const g = await makeFixture();
    try {
      const capability = new CapabilityLibrary({ layout: g.layout, policy: g.policy, audit: g.audit, clock: g.clock });
      await assert.rejects(
        () => capability.read({ id: '../../../secret' }),
        (e) => e.name === 'InvalidBody' && /能力id/.test(e.message),
        '穿目录的 id 必须在拼路径之前被拦',
      );
      await assert.rejects(() => capability.read({ id: 'a/b' }), (e) => e.name === 'InvalidBody', '含分隔符同样拒');
      assert.equal(await capability.read({ id: 'kebab-legal-but-missing' }), null, '段合法、文件不存在 ⇒ null（正常读面不动）');
    } finally {
      await g.cleanup();
    }
  });
});

describe('批次3 · P1-6：archiveAnswers 只归档「未归档」的当前条目', () => {
  async function 记一条作答(memory, 内容) {
    return memory.remember({ subject: LEAD, 类: '作答', 内容, 来源: { 谁: 'lead', 怎么知道: '批次3测试' }, 项目: P });
  }

  it('归档 ⇒ 再归档 = 0 条（修前每次结账给全体老条目再追加一轮归档行）', async () => {
    const g = await makeFixture();
    try {
      const memory = new MemoryService({ layout: g.layout, policy: g.policy, audit: g.audit, clock: g.clock });
      await 记一条作答(memory, '作答一');
      await 记一条作答(memory, '作答二');
      const 一 = await memory.archiveAnswers({ 项目: P, 任务: 'task-1', subject: LEAD });
      assert.equal(一.归档条数, 2, '首次归档 2 条');
      const 二 = await memory.archiveAnswers({ 项目: P, 任务: 'task-2', subject: LEAD });
      assert.equal(二.归档条数, 0, '没有新作答 ⇒ 归档 0 条（修前是 2：老条目被重复归档）');
      await 记一条作答(memory, '作答三');
      const 三 = await memory.archiveAnswers({ 项目: P, 任务: 'task-3', subject: LEAD });
      assert.equal(三.归档条数, 1, '只有新那条被归档（审计读数 = 真增量）');
      const 归档行 = (await readJsonl(g.layout.memoryLog(P, '作答'))).filter((r) => r.追加 === '归档');
      assert.equal(归档行.length, 3, '账上恰好 3 行归档记录（2+0+1，不长胖）');
    } finally {
      await g.cleanup();
    }
  });
});

describe('批次3 · P1-7：知识晋升不带 fold 派生键、不收被否条目', () => {
  async function 记一条知识(memory, 内容) {
    const r = await memory.remember({ subject: LEAD, 类: '知识', 内容, 来源: { 谁: 'lead', 怎么知道: '批次3测试' }, 项目: P });
    return r.id;
  }

  it('晋升行不含 历史/状态/账本出现于（修前 spread 进账 ⇒ 内嵌陈旧状态史盖真实历史）', async () => {
    const g = await makeFixture();
    try {
      const memory = new MemoryService({ layout: g.layout, policy: g.policy, audit: g.audit, clock: g.clock });
      const id = await 记一条知识(memory, '可复用的知识');
      await memory.promoteCrossProject(id, { subject: LEAD, 岗位: '插件工程', 理由: '复用' });
      const 行 = (await readJsonl(g.layout.memoryLog(DIR.跨项目, '知识'))).find((r) => r.id === id);
      assert.ok(行, '跨项目账上有晋升行');
      assert.equal(Object.hasOwn(行, '历史'), false, 'fold 派生键 历史 不许落账');
      assert.equal(Object.hasOwn(行, '状态'), false, 'fold 派生键 状态 不许落账');
      assert.equal(Object.hasOwn(行, '账本出现于'), false, 'fold 派生键 账本出现于 不许落账');
      assert.equal(行.岗位, '插件工程', '岗位标签照打（正常路径不动）');
    } finally {
      await g.cleanup();
    }
  });

  it('已失效/被推翻的知识 ⇒ 晋升拒（召回面否掉的东西不许从侧门扩散）', async () => {
    const g = await makeFixture();
    try {
      const memory = new MemoryService({ layout: g.layout, policy: g.policy, audit: g.audit, clock: g.clock });
      const id = await 记一条知识(memory, '后来被证伪的知识');
      await memory.invalidate(id, { subject: LEAD, 原因: '实测不成立' });
      await assert.rejects(
        () => memory.promoteCrossProject(id, { subject: LEAD, 岗位: '插件工程', 理由: '明知失效还晋升' }),
        (e) => e.name === 'Denied' && /被否的知识不许晋升/.test(e.rule),
        '已失效 ⇒ 拒（修前放行）',
      );
      const id2 = await 记一条知识(memory, '被推翻的旧说法');
      await memory.overturn(id2, { subject: LEAD, 新条目: '正确的新说法', 理由: '复现推翻' });
      await assert.rejects(
        () => memory.promoteCrossProject(id2, { subject: LEAD, 岗位: '插件工程', 理由: '晋升被推翻者' }),
        (e) => e.name === 'Denied' && /被否/.test(e.rule),
        '被推翻 ⇒ 拒',
      );
    } finally {
      await g.cleanup();
    }
  });
});

describe('批次3 · P1-10：withLock 的强夺/删除挂起路径走「超时 + 退避」公共出口', () => {
  it('锁被正常持有 ⇒ 等待路径共用「超时 + 退避」出口（重组后行为不退化）；并发临界区不重叠', async () => {
    const g = await makeFixture();
    try {
      const lockPath = join(g.home, 'busy.lock');
      let release;
      const holding = withLock(lockPath, () => new Promise((r) => { release = r; }), { timeoutMs: 10_000 });
      await new Promise((r) => setTimeout(r, 200)); // 等持有者进临界区
      const t0 = Date.now();
      await assert.rejects(
        () => withLock(lockPath, async () => { throw new Error('临界区重叠了'); }, { timeoutMs: 400 }),
        /获取锁超时/,
        '持有者未释放 ⇒ 等待者按 timeoutMs 响亮失败（重组后这条路径不许退化）',
      );
      const elapsed = Date.now() - t0;
      assert.ok(elapsed >= 400 && elapsed < 4000, `耗时应在 timeoutMs 附近收束（实际 ${elapsed}ms）`);
      release();
      await holding;
      // 持有者释放后立即可拿（锁文件验后删已落地）。
      assert.equal(await withLock(lockPath, async () => '拿到'), '拿到', '释放后正常获取');
    } finally {
      await g.cleanup();
    }
    // 注（P1-10 校准边界）：「rm 在删除挂起/共享冲突上 EPERM」的耐受在本测试栈无法确定性
    // 复现（cmd del 实测：libuv 的 share-delete 语义让名字立即消失，强夺直接成功）。
    // 该分支为防御性修补，代码注释记录了实测依据；这里钉的是重组后所有等待路径的行为契约。
  });

  it('正对照：真 stale 锁照旧强夺放行（重组后强夺路径不许被退避拖死）', async () => {
    const g = await makeFixture();
    try {
      const lockPath = join(g.home, 'stale.lock');
      const holder = await open(lockPath, 'w');
      await holder.writeFile(JSON.stringify({ pid: 99999, at: new Date(Date.now() - 120_000).toISOString() }));
      await holder.close();
      // 内容令牌是旧的 ⇒ stat 的 mtime 也是旧的（写于 120s 前不成立，用 staleMs=1 让「新文件也算过期」）。
      const 抢到 = await withLock(lockPath, async () => '进临界区', { staleMs: 1, timeoutMs: 5000 });
      assert.equal(抢到, '进临界区', 'stale 强夺正常路径不动');
    } finally {
      await g.cleanup();
    }
  });
});
