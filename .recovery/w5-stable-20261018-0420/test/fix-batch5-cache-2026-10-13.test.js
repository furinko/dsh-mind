/**
 * 2026-10-13 第三批 · 任务图读缓存与锁内投影 回归：
 *  - 写路径返回的节点 = 锁内折出来的真读数（不再「写后再读」，也不读到别人的中途写入）；
 *  - 缓存签名失效：外部进程往账本追加一行（改 mtime）之后，本进程读得到；
 *  - 本进程自己的写立即对后续读可见（写计数让签名失效）；
 *  - 缓存不许改变语义：连续两次 get 返回内容一致，且不改盘。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { makeFixture, LEAD, MEMBER, REVIEWER } from './helpers.mjs';
import { TaskGraph } from '../src/tasks.js';

const P = 'p-cache';

describe('第三批 · 任务图读缓存', () => {
  it('写操作的返回值 = 锁内投影（与随后 get 的真读数一致）', async () => {
    const f = await makeFixture();
    const tasks = new TaskGraph({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
    const created = await tasks.create({ subject: LEAD, 项目: P, 描述: '缓存一致性', 负责人: 'member-a', 判据: ['x'] });
    assert.equal(created.状态, '待派发');
    assert.ok(created.创建于, '锁内投影要带创建时刻（都是从同一行折出来的）');
    const dispatched = await tasks.dispatch(created.id, { subject: LEAD, 项目: P });
    assert.equal(dispatched.状态, '已派发');
    assert.equal(dispatched.判据冻结, true);
    const 读回 = await tasks.get(created.id, { 项目: P });
    assert.deepEqual(读回, dispatched, '写返回的投影与真读数逐字段一致');
    await f.cleanup();
  });

  it('外部进程追加一行 ⇒ mtime 变化让缓存失效（本进程读得到别人写的）', async () => {
    const f = await makeFixture();
    const tasks = new TaskGraph({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
    const node = await tasks.create({ subject: LEAD, 项目: P, 描述: '外部写', 负责人: 'member-a', 判据: ['x'] });
    await tasks.get(node.id, { 项目: P }); // 先把缓存填上
    const file = f.layout.taskLog(P);
    const before = await stat(file);
    // 模拟另一个进程（另一个 Org 实例）追加：直接写盘，且把 mtime 推后。
    const text = await readFile(file, 'utf8');
    const 新行 = JSON.stringify({ seq: 2, at: new Date(Date.now() + 2000).toISOString(), by: { id: 'lead', kind: 'Lead' }, kind: 'dispatched', id: node.id, 判据冻结: true });
    await writeFile(file, `${text}${新行}\n`);
    const after = await stat(file);
    assert.notEqual(`${before.mtimeMs}:${before.size}`, `${after.mtimeMs}:${after.size}`, '前提：外部写改变了签名（mtime+size）');
    const 读回 = await tasks.get(node.id, { 项目: P });
    assert.equal(读回.状态, '已派发', '外部写入必须被本进程看见（签名失效）');
    await f.cleanup();
  });

  it('本进程写后立刻读得到（写计数让签名失效，不靠 mtime 精度）', async () => {
    const f = await makeFixture();
    const tasks = new TaskGraph({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
    const node = await tasks.create({ subject: LEAD, 项目: P, 描述: '连写', 负责人: 'member-a', 判据: ['x'] });
    await tasks.get(node.id, { 项目: P }); // 填缓存
    await tasks.dispatch(node.id, { subject: LEAD, 项目: P }); // 同一毫秒内写
    const 状态 = await tasks.get(node.id, { 项目: P });
    assert.equal(状态.状态, '已派发', '同毫秒写入也必须可见');
    await f.cleanup();
  });

  it('缓存不改变语义：全链路仍走通，事件数如实增长', async () => {
    const f = await makeFixture();
    const tasks = new TaskGraph({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
    const node = await tasks.create({ subject: LEAD, 项目: P, 描述: '全链路', 负责人: 'member-a', 判据: ['x'] });
    await tasks.dispatch(node.id, { subject: LEAD, 项目: P });
    await tasks.start(node.id, { subject: MEMBER, 项目: P });
    await tasks.submit(node.id, { subject: MEMBER, 项目: P, 结论: '完工' });
    await tasks.review(node.id, { subject: REVIEWER, 项目: P, 三态: '过' });
    const final = await tasks.get(node.id, { 项目: P });
    assert.equal(final.状态, '已采纳');
    const rows = await tasks.events({ 项目: P });
    assert.equal(rows.length, 5, `created/dispatched/started/submitted/reviewed 共 5 行（实际 ${rows.length}）`);
    // 缓存是纯读面：盘上行数 = 内存行数，没有多写也没有少写。
    const 盘上 = (await readFile(f.layout.taskLog(P), 'utf8')).trim().split('\n').length;
    assert.equal(盘上, 5);
    await f.cleanup();
  });
});
