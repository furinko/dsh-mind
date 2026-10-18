/**
 * Root 上下文已钉规程（v2 条目10 · W7 实证补修）。
 *
 * 病灶：Lead 钉版只在工具/命令首次调用时发生，组织说明是静态文本——Root 在**首次模型
 * 工作前**既没有登记也没有卡消费者；运行中实例的规程面与账上钉的版本可能脱节。
 *
 * 本文件钉：
 *  ① 首个真实 Root 模型组织上下文装配时，就走同一真实宿主事实入口出生/钉版，并把
 *     **该实例钉住的那一版** Lead L0/L1（完整、不截断）与能力引用注入上下文；
 *  ② 之后改现行 Lead 卡，运行中实例的注入规程不换脸（仍读钉住快照）；
 *  ③ 不是真实根 Agent（子会话 / 无会话 id 的任意 Lead 形状）不登记、不注入；
 *  ④ 卡缺/坏时明确「未就绪」横幅（不假成功注入规则），且不炸整轮。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, writeUnder } from './helpers.mjs';
import { fakeHost } from './host-harness.mjs';
import * as plugin from '../components/kernel/lib/index.js';

/** 写一张带唯一标记的 Lead 卡（private 覆盖出厂；version 递增）。 */
async function 写Lead卡(f, 版本, 规则行) {
  await writeUnder(f.privateRoot, '集体L3-成员角色卡/Lead.md', `---
id: Lead
kind: 身份
authority: 自治
zone: 私有
domain: 个体
version: ${版本}
---
# Lead

## 个体L0 · 身份核心

我是 v${版本} 的 Lead。

### 身份核心

锁定段。

## 个体L1 · 规则

${规则行}

## 个体L2 · 能力引用

- \`policy-decision\`

## 个体L3 · 经验引用

### 占位
`);
}

const 基础装配 = () => ({
  sections: [{ name: 'mind:organization', text: '静态组织说明（不含任何已钉 Lead 规程）' }],
  tools: [],
  contexts: [],
  variables: {},
});

/** 取出内核注册的 system-prompt/assemble 监听并真实调用（真装配面，不 mock 结果）。 */
async function 跑装配(host, agent) {
  const 监听 = (host.钩子.get('system-prompt/assemble') ?? []).at(-1);
  assert.equal(typeof 监听, 'function', '内核必须注册 system-prompt/assemble 监听');
  const 装配 = 基础装配();
  return 监听(装配, { agent }, async () => 装配);
}

function 根Agent(id) {
  return { session: { id, header: { cwd: process.cwd() } } };
}

describe('Root 首个组织上下文：出生/钉版 + 注入已钉 Lead 规程', () => {
  it('首次装配即钉版并注入完整 v1 L0/L1；改现行卡到 v2 后运行中实例不换脸', async () => {
    const f = await makeFixture();
    const host = fakeHost();
    try {
      await 写Lead卡(f, 1, '1. v1-Lead-先定判据。\n2. v1-Lead-不越授、不改他人卡。');
      await plugin.apply(host.ctx, { home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot });
      const agent = 根Agent('root-ctx-1');

      const 一 = await 跑装配(host, agent);
      const 段 = 一.sections.find((s) => s.name === 'mind:lead-pinned-rules');
      assert.ok(段, '首个真实 Root 装配必须注入已钉 Lead 规程');
      const 钉 = await f.registry.cardOf('root-ctx-1');
      assert.equal(钉?.就绪, true, '首次装配前已走正规出生/钉版（在册在岗 + 真摘要）');
      assert.ok(钉.卡版本?.摘要, '实例有真卡版本摘要');
      assert.match(段.text, /v1-Lead-先定判据/);
      assert.match(段.text, /v1-Lead-不越授、不改他人卡/, 'L1 完整注入（不截断）');
      assert.match(段.text, /我是 v1 的 Lead/, 'L0 身份核心一并注入');
      assert.match(段.text, new RegExp(钉.卡版本.摘要.slice(0, 12)), '注入的卡版本与钉住摘要一致');
      assert.match(段.text, /policy-decision/, '能力只引用');

      // 改现行卡到 v2：运行中实例的规程不许换脸（仍读钉住快照）。
      await 写Lead卡(f, 2, '1. v2-Lead-先写后补判据。');
      const 二 = await 跑装配(host, 根Agent('root-ctx-1'));
      const 段2 = 二.sections.find((s) => s.name === 'mind:lead-pinned-rules');
      assert.match(段2.text, /v1-Lead-先定判据/);
      assert.doesNotMatch(段2.text, /v2-Lead-先写后补判据/, '现行卡改动不得替换运行中实例规程');
      assert.equal((await f.registry.cardOf('root-ctx-1')).卡版本?.摘要, 钉.卡版本.摘要, '实例钉版仍是最初那一版');
    } finally {
      host.清理();
      await f.cleanup();
    }
  });

  it('不是真实根 Agent：子会话/无 session id 的任意 Lead 形状不登记、不注入', async () => {
    const f = await makeFixture();
    const host = fakeHost();
    try {
      await 写Lead卡(f, 1, '1. v1-Lead-先定判据。');
      await plugin.apply(host.ctx, { home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot });

      // 子会话（成员）：即使 agent 形状带 kind 也不在装配面造 Lead。
      const 子 = await 跑装配(host, { session: { id: 'session-child-ctx', header: { origin: 'subagent', cwd: process.cwd() } } });
      assert.equal(子.sections.some((s) => s.name === 'mind:lead-pinned-rules'), false, '子会话不注入 Lead 规程');
      assert.equal((await f.registry.identity()).members['session-child-ctx'], undefined, '子会话不被误登记成 Lead');

      // 无 session.id 的任意 Lead 形状（设置页等）：连会话 id 都没有 ⇒ 不造人。
      const 假 = await 跑装配(host, { kind: 'Lead' });
      assert.equal(假.sections.some((s) => s.name === 'mind:lead-pinned-rules'), false, '无会话事实不注入');
    } finally {
      host.清理();
      await f.cleanup();
    }
  });

  it('卡缺/坏：明确「未就绪」且不假成功注入规则；不炸整轮', async () => {
    const f = await makeFixture({ lead: 'absent' }); // 无 Lead 卡/无 Lead 记录：钉版必失败
    const host = fakeHost();
    try {
      await plugin.apply(host.ctx, { home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot });
      const 装配 = await 跑装配(host, 根Agent('root-ctx-absent'));
      const 段 = 装配.sections.find((s) => s.name === 'mind:lead-pinned-rules');
      assert.ok(段, '失败也要给明确横幅，而不是静默无段');
      assert.match(段.text, /未就绪/);
      assert.match(段.text, /自治写已按 fail-closed 拒绝/);
      assert.doesNotMatch(段.text, /个体L1 · 规则：/, '失败时不许注入任何像规程的正文');
    } finally {
      host.清理();
      await f.cleanup();
    }
  });
});
