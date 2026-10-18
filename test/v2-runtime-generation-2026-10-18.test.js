/**
 * 进程代 vs 装配标记（v2 条目12 · 2026-10-18 审计实证 67efe1e7）的回归。
 *
 * 钉四件事：
 *  ① **同一进程跨模块（重）导入恒定**：官方 HMR 会清掉 runtime 模块——模块级 `let` 会换
 *     UUID（实测 pid 21092 从 f296… 变 bc7a…），所以代次必须锚在 `globalThis` 的稳定 Symbol。
 *     这里用 `?nonce=` 二次 import 模拟「模块重新加载」。
 *  ② **装配标记**：每次**新 Org 装配**一个独立标记（供 `status.引导` 读），同一 key 复用同一标记。
 *  ③ **进程代 ≠ 装配标记**：装配标记变了，进程代不变；孤儿回收只看进程代的 pid 存活事实。
 *  ④ **同 PID 跨 HMR 不误回收**：旧代记录但 pid 仍活 ⇒ 未判定（不封存）；真死 PID 才封存，
 *     且**绝不推进任务状态**（未交卷不自动成功）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processGeneration, shareOrg, forgetSharedOrg } from '../src/runtime.js';

const P = 'proj-w5-gen';

function 起home() {
  return mkdtemp(join(tmpdir(), 'mind-gen-'));
}

describe('① 进程代：同进程跨模块导入恒定，不同真实进程不同', () => {
  it('同模块多次调用恒等；?nonce 重导入（模拟 HMR 清模块）后仍恒等', async () => {
    const a = processGeneration();
    const b = processGeneration();
    assert.equal(a.代, b.代, '同模块多次调用恒等');
    assert.equal(a.pid, process.pid);
    // 模拟 HMR：同一路径带不同 query 会被当成另一个模块实例，模块级变量会重置。
    const 再加载 = await import(`../src/runtime.js?nonce=${Date.now()}`);
    const c = 再加载.processGeneration();
    assert.equal(c.代, a.代, '模块重导入后代次不变（锚在 globalThis，而不是模块局部 let）');
    assert.equal(c.pid, process.pid);
  });

  it('pid 不符（模拟另一真实进程）⇒ 重新生成，不复用旧代', async () => {
    const 键 = Symbol.for('dsh-mind.process-generation.v1');
    const 原值 = globalThis[键];
    try {
      globalThis[键] = Object.freeze({ 代: 'foreign-generation', pid: process.pid + 100000, 于: new Date().toISOString() });
      const 新 = processGeneration();
      assert.notEqual(新.代, 'foreign-generation', 'pid 不符必须换新代');
      assert.equal(新.pid, process.pid);
      assert.equal(processGeneration().代, 新.代, '换过之后同进程继续恒等');
    } finally {
      globalThis[键] = 原值;
    }
  });
});

describe('② 装配标记：新装配新标记，复用同 key 同标记；与进程代解耦', () => {
  it('两个不同项目的装配 ⇒ 两个标记；重复取同一项目 ⇒ 同一标记；进程代始终不变', async () => {
    const home = await 起home();
    try {
      const 代0 = processGeneration().代;
      const org1 = await shareOrg({ home, factoryRoot: join(process.cwd(), 'mind'), project: `${P}-a` });
      const org1b = await shareOrg({ home, factoryRoot: join(process.cwd(), 'mind'), project: `${P}-a` });
      const org2 = await shareOrg({ home, factoryRoot: join(process.cwd(), 'mind'), project: `${P}-b` });
      assert.ok(org1.装配标记 && org2.装配标记, '每次装配都有标记');
      assert.equal(org1.装配标记, org1b.装配标记, '同 key 复用同一装配 ⇒ 同标记');
      assert.notEqual(org1.装配标记, org2.装配标记, '不同装配 ⇒ 不同标记');
      assert.equal(org1.boot.装配标记, org1.装配标记, 'status.引导 读得到（boot 上可见）');
      assert.equal(org1.boot.代次.代, 代0, '进程代不随装配变');
      assert.equal(org2.boot.代次.代, 代0, '另一个装配也用同一个进程代');
    } finally {
      forgetSharedOrg();
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
    }
  });
});

describe('③ 孤儿回收只认进程代的 pid 事实（装配标记不参与）', () => {
  it('同 PID 跨 HMR（代次已换代但 pid 仍活）⇒ 未判定，不封存', async () => {
    const home = await 起home();
    try {
      const 本代 = processGeneration();
      // 造一条「旧代」记录：代次 uuid 与当前不同，但 pid 就是本进程（HMR 后的真实形态）。
      const { Org } = await import('../src/org.js');
      const org = await Org.open({ home, factoryRoot: join(process.cwd(), 'mind'), project: P, 代次: 本代 });
      const 身份 = join(home, 'mind-data', 'mind-private', '身份档案', 'identity.json');
      const { readFileSync, writeFileSync } = await import('node:fs');
      const doc = JSON.parse(readFileSync(身份, 'utf8'));
      doc.members['m-hmr'] = { id: 'm-hmr', 岗位: '插件工程', 代: 1, status: '在岗', 代次: { 代: 'stale-uuid-from-old-module', pid: process.pid } };
      writeFileSync(身份, `${JSON.stringify(doc, null, 2)}\n`);
      const 读 = await org.registry.orphanSweep({ 代次: 本代 });
      assert.equal(读.封存.includes('m-hmr'), false, 'pid 还活 ⇒ 绝不判死（同 PID 跨 HMR 不误回收）');
      assert.ok(读.未判定.some((x) => x.实例 === 'm-hmr' && /仍存活/.test(x.原因)), '落「仍存活」未判定');
    } finally {
      forgetSharedOrg();
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
    }
  });

  it('真死 PID ⇒ 封存，且不推进任务状态（未交卷不自动成功）', async () => {
    const home = await 起home();
    try {
      const 本代 = processGeneration();
      const { Org } = await import('../src/org.js');
      const org = await Org.open({ home, factoryRoot: join(process.cwd(), 'mind'), project: P, 代次: 本代 });
      // 先用本代合法身份建一个节点并派发，再把负责实例挪到「死 pid」的旧代上。
      const 主 = { id: 'lead-gen', kind: 'Lead', roleId: 'Lead' };
      await org.registry.ensureLeadInstance({ 实例: 主.id, 代次: 本代 });
      await org.registry.assign({ subject: 主, 岗位: '插件工程', 实例: 'm-dead' });
      const 建 = await org.tasks.create({ subject: 主, 项目: P, 描述: '代次死 pid', 负责人: '插件工程', 判据: ['x'] });
      const node = await org.tasks.dispatch(建.id, { subject: 主, 项目: P });
      const 身份 = join(home, 'mind-data', 'mind-private', '身份档案', 'identity.json');
      const { readFileSync, writeFileSync } = await import('node:fs');
      const doc = JSON.parse(readFileSync(身份, 'utf8'));
      doc.members['m-dead'].代次 = { 代: 'dead-gen', pid: 999999 };
      writeFileSync(身份, `${JSON.stringify(doc, null, 2)}\n`);
      const 读 = await org.registry.orphanSweep({ 代次: 本代, 存活探测: (pid) => pid !== 999999 });
      assert.deepEqual(读.封存, ['m-dead'], '判得死的孤儿被封存');
      assert.equal((await org.tasks.get(node.id, { 项目: P })).状态, '已派发', '回收绝不推进任务状态');
    } finally {
      forgetSharedOrg();
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
    }
  });
});
