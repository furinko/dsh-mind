/**
 * 审查 B2 半边（机制级修复）：身份档案 mtime 失效检查。
 *
 * 之前「seal 后判定立即生效」靠的是 registry 写完档案自觉调 reload() —— 纪律级保证。
 * 这里断言的是机制级：**绕过 registry 的写入**（手改 JSON / 外部工具）也必须在下一次
 * 判定前生效。校准记录：曾把 policy.js decide 入口的 mtime 比对整段注释掉跑红
 * （用例 a 的 §12.2 断言失败，判定仍读旧快照放行在岗状态），还原后转绿 ——
 * 证明用例 a 确实钉在这条机制上，不是碰巧通过。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { makeFixture, MEMBER } from './helpers.mjs';

/** @type {Awaited<ReturnType<typeof makeFixture>>} */ let f;

describe('B2 半边 · 身份档案新鲜度（机制级）', () => {
  before(async () => {
    f = await makeFixture();
  });
  after(async () => {
    await f.cleanup();
  });

  const 目标 = { id: '知识-x', kind: '知识', authority: '自治', zone: '私有' };

  it('a) 手改档案封存成员后**不调 reload**，decide 已按新事实拒绝', async () => {
    // 不走 registry：直接改身份档案，模拟绕过写入方的任意外部改动。
    const file = f.layout.identityFile();
    const doc = JSON.parse(await readFile(file, 'utf8'));
    doc.members['member-a'] = { ...doc.members['member-a'], status: '封存' };
    await writeFile(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');

    const 决定 = await f.policy.decide({ subject: MEMBER, action: 'write', target: 目标, context: {} });
    assert.equal(决定.verdict, 'deny');
    assert.match(决定.rule, /§12\.2/, '封存必须无需任何人记得 reload 就生效');
    assert.match(决定.reason, /封存/);
  });

  it('b) 档案不变时连续 decide 不重复 reload；变更后也只补一次', async () => {
    // spy：包一层 reload 计数（decide 里走 this.reload()，实例覆盖即可截获）。
    const 原函数 = f.policy.reload.bind(f.policy);
    let 次数 = 0;
    f.policy.reload = async (...args) => {
      次数 += 1;
      return 原函数(...args);
    };
    try {
      // 档案未变：连续判定不该触发任何 reload（热路径只是一次 stat）。
      for (let i = 0; i < 3; i += 1) {
        await f.policy.decide({ subject: { ...MEMBER, id: 'member-b' }, action: 'read', target: 目标, context: {} });
      }
      assert.equal(次数, 0, `档案未变却 reload 了 ${次数} 次`);

      // 变更一次：第一次 decide 补 reload，之后不再重复。
      const file = f.layout.identityFile();
      const doc = JSON.parse(await readFile(file, 'utf8'));
      doc.members['member-b'] = { ...doc.members['member-b'], status: '封存' };
      await writeFile(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
      for (let i = 0; i < 3; i += 1) {
        await f.policy.decide({ subject: { ...MEMBER, id: 'member-b' }, action: 'read', target: 目标, context: {} });
      }
      assert.equal(次数, 1, `一次档案变更应恰好触发 1 次 reload，实际 ${次数}`);
    } finally {
      f.policy.reload = 原函数;
    }
  });

  it('c) 边界：档案不存在不抛（按无变化兜底），后创建即被感知', async () => {
    const g = await makeFixture();
    try {
      const file = g.layout.identityFile();
      await rm(file);
      // 不存在 ⇒ mtime 记 null，null == null 视为无变化：不抛、不 reload、照常判定。
      let 次数 = 0;
      const 原函数 = g.policy.reload.bind(g.policy);
      g.policy.reload = async (...args) => {
        次数 += 1;
        return 原函数(...args);
      };
      const 缺席 = await g.policy.decide({ subject: MEMBER, action: 'write', target: 目标, context: {} });
      assert.equal(缺席.verdict, 'deny', '档案缺失时成员按「未登记」最严拒绝');
      assert.equal(次数, 1, '有→无是变更：删除后第一次判定补 1 次 reload（并把戳记为 null）');
      await g.policy.decide({ subject: MEMBER, action: 'write', target: 目标, context: {} });
      assert.equal(次数, 1, '缺失→缺失才是「无变化」：不该再 reload');

      // 后创建（从未有到有）必须被感知：null → 数字也是「不同」。
      await writeFile(file, `${JSON.stringify({ members: { 'member-a': { id: 'member-a', 岗位: '插件工程', 代: 1, status: '在岗' } }, sovereign: { lastInteraction: new Date().toISOString() }, denylist: [] }, null, 2)}\n`, 'utf8');
      const 在岗 = await g.policy.decide({ subject: MEMBER, action: 'write', target: 目标, context: {} });
      assert.equal(次数, 2, '档案从无到有应再触发恰好 1 次 reload');
      assert.doesNotMatch(在岗.reason, /没有 member-a/, '创建后判定要读到新档案里的登记');
    } finally {
      await g.cleanup();
    }
  });
});
