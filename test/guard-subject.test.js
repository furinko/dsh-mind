/**
 * guard 残留面收口（2026-10-10）：`mind_guard` / `/mind-guard` 的主体必须来自**会话事实**。
 *
 * 修前：`components/guard/lib/index.js` 两处硬编码 `subjectFor({ 根会话: true })`
 * ⇒ 任何会话（含成员子会话）调 guard 都按 Lead 执行 —— `upgrade_resolve` / `upgrade_withdraw`
 * 这类裁决动作因此绕过「仅 Lead」授权面（⑳ 门② 堵的是内核 `runAction`，guard 是独立入口；
 * `docs/设计债-2026-10-09.md` ⑳ 影响面清点表 #14 点名的残留面）。
 *
 * 判据：**成员子会话的 resolve 被策略拒、根会话的 resolve 放行** —— 两个 exec 同一挂起项面、
 * 同一动作，唯一变量是会话事实。修前（恒 Lead）两侧都放行 ⇒ 「成员被拒」断言当场红。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeFixture } from './helpers.mjs';
import { fakeHost, fakeExec } from './host-harness.mjs';
import guardModule, { ACTIONS } from '../components/guard/lib/index.js';
const guardApply = guardModule.apply;

/** 子会话 exec（成员）：header.origin='subagent'（㉑ ㉒ 判据认的那几个字段）。 */
function 子会话exec(sessionId) {
  return { name: 'mind_guard', agent: { session: { id: sessionId, header: { cwd: process.cwd(), origin: 'subagent', delegationDepth: 1 } } } };
}

/** 挂起项（安全类:false ⇒ 法律档 ⇒ Lead 可裁决、成员拒 —— policy 升级裁决通道）。 */
async function 造挂起项(g, id) {
  const item = { id, 对象: '协作协议', 安全类: false, 条款: '§1 作业规程', 挂起于: '2026-10-10T00:00:00Z' };
  await g.writePrivate(`升级/挂起/${id}.json`, `${JSON.stringify(item, null, 2)}\n`);
  return join(g.privateRoot, '升级', '挂起', `${id}.json`);
}

describe('guard 残留面：主体来自会话事实（2026-10-10 收口）', () => {
  it('工具面：成员子会话 resolve ⇒ 策略拒（挂起项未动）；根会话 resolve ⇒ 放行并落「已裁决」', async () => {
    const g = await makeFixture();
    const host = fakeHost();
    try {
      await guardApply(host.ctx, { home: g.home, factoryRoot: g.factoryRoot, privateRoot: g.privateRoot, 开机自检: false });
      const tool = host.工具.get('mind_guard');
      assert.ok(tool, 'guard 工具已注册到宿主');
      assert.ok(ACTIONS.includes('upgrade_resolve'), '前提：upgrade_resolve 在本组件动作表');

      const p成员 = await 造挂起项(g, 'p-member');
      const pLead = await 造挂起项(g, 'p-lead');

      // ① 成员子会话：策略拒（修前恒 Lead ⇒ 这里会放行 —— 本判据的改坏锚）
      const 成员回 = JSON.parse(await tool.execute(
        { action: 'upgrade_resolve', id: 'p-member', 选择: '用出厂版', 原因: '成员尝试' },
        子会话exec('session-child-guard1'),
      ));
      assert.equal(成员回.成功, false, '成员子会话不得以 Lead 身份做升级裁决（修前正是放行）');
      assert.ok(成员回.规则 || 成员回.理由, '拒绝带 规则/理由（策略引擎的判据面，不是静默失败）');
      const 成员件 = JSON.parse(await readFile(p成员, 'utf8'));
      assert.equal(成员件.已裁决, undefined, '被拒的那次没写盘（挂起项原样）');

      // ② 根会话（Lead）：放行并真写盘 —— 同一动作、同一夹具，唯一变量是会话事实
      const lead回 = JSON.parse(await tool.execute(
        { action: 'upgrade_resolve', id: 'p-lead', 选择: '用出厂版', 原因: '正对照' },
        fakeExec({ name: 'mind_guard', sessionId: 'session-root-guard1' }),
      ));
      assert.equal(lead回.成功, true, '根会话 = Lead ⇒ 升级裁决放行（既有授权面不动）');
      const lead件 = JSON.parse(await readFile(pLead, 'utf8'));
      assert.equal(lead件.已裁决, true, '真写盘（不是纸面成功）');
      assert.equal(lead件.由, 'session-root-guard1', '审计位记录的是会话事实主体 id');
    } finally {
      host.清理();
      await g.cleanup();
    }
  });

  it('命令面：/mind-guard 的 handler 同样吃会话事实（成员 agent ⇒ error；根会话 agent ⇒ success）', async () => {
    const g = await makeFixture();
    const host = fakeHost();
    try {
      await guardApply(host.ctx, { home: g.home, factoryRoot: g.factoryRoot, privateRoot: g.privateRoot, 开机自检: false });
      const command = host.命令.get('mind-guard');
      assert.ok(command, '/mind-guard 命令已注册');

      await 造挂起项(g, 'p-cmd-member');
      await 造挂起项(g, 'p-cmd-lead');

      // handler 的 agent 形状 = exec.agent（与 /mind 命令面同款取法：agentSubject({ agent })）
      const 成员agent = { session: { id: 'session-child-guard2', header: { cwd: process.cwd(), origin: 'subagent', delegationDepth: 2 } } };
      const rootagent = { session: { id: 'session-root-guard2', header: { cwd: process.cwd() } } };

      const 成员回 = await command.handler({ agent: 成员agent, rawInput: 'resolve id=p-cmd-member 选择=用出厂版' });
      assert.equal(成员回.kind, 'error', '命令面：成员会话里敲 /mind-guard 裁决 ⇒ 拒');

      const lead回 = await command.handler({ agent: rootagent, rawInput: 'resolve id=p-cmd-lead 选择=用出厂版' });
      assert.equal(lead回.kind, 'success', '命令面：根会话（人）敲 /mind-guard ⇒ 放行（零 token 通道不坏）');
    } finally {
      host.清理();
      await g.cleanup();
    }
  });

  it('fail-closed：exec 整个缺席 ⇒ 不认 Lead（落成员 ⇒ 策略拒）', async () => {
    const g = await makeFixture();
    const host = fakeHost();
    try {
      await guardApply(host.ctx, { home: g.home, factoryRoot: g.factoryRoot, privateRoot: g.privateRoot, 开机自检: false });
      const tool = host.工具.get('mind_guard');
      await 造挂起项(g, 'p-unknown');
      const 回 = JSON.parse(await tool.execute({ action: 'upgrade_resolve', id: 'p-unknown', 选择: '用出厂版' }, undefined));
      assert.equal(回.成功, false, 'exec 缺席 ⇒ fail-closed（unknown 实例过不了升级裁决授权）');
    } finally {
      host.清理();
      await g.cleanup();
    }
  });
});
