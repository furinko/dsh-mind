/**
 * 生效闭环与热更新（task-生效闭环与热更新-节点B-依据审-o1acv · 2026-10-16）。
 * 依据：审查报告 §四 R04/R18 的「修法/验收」。
 *
 * 本档覆盖：
 *  R04-① decide 的授权依赖新鲜度（手改规则件/部署介入度后无需显式 reload 即生效）
 *  R04-③ policy_reload 动作的生效回执（前后摘要对照）与权限闸
 *  R18-⑤ effectiveDocument 段级合并（私有同名段覆盖、未出现段继承出厂）
 *  R18-⑥ 审查实证两向：出厂权限条款 deny + 私有只定制无关段 ⇒ 修前限制实际消失、修后仍在
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, LEAD, MEMBER, SOVEREIGN, writeUnder } from './helpers.mjs';
import { Org } from '../src/org.js';
import { runAction } from '../lib/actions.js';
import { Denied } from '../src/kernel/errors.js';
import { effectiveDocument } from '../src/tags.js';

const P = 'proj-r04r18';

/** 权限矩阵（法律件）：出厂版带一条「成员不得删除」的 deny grant，私有版只改无关段。
 *  授权块是 **JSON** 格式（extractPolicyBlock 只认 JSON：```policy { "grants": [...] } ```）。 */
const 权限矩阵 = (标记, 是否带Grant) => [
  '---', 'id: 权限矩阵', 'kind: 规则', 'authority: 法律', 'zone: 私有', 'domain: 集体', 'version: 1', '---',
  '# 权限矩阵', '',
  '## 三档门槛', `你定的 > 组织定的。（${标记}）`, '',
  ...(是否带Grant
    ? ['```policy', JSON.stringify({ grants: [{ subject: '成员', action: 'delete', verdict: 'deny', reason: '成员不得删除组织对象' }] }, null, 2), '```', '']
    : []),
].join('\n');

describe('R18 · effectiveDocument 段级合并（唯一解析器）', () => {
  it('单元：私有同名段覆盖、未出现段继承出厂；段外 H1 保留', async () => {
    const 出厂 = ['---', 'id: x', 'kind: 规则', 'authority: 法律', 'version: 1', '---', '# 标题（出厂）', '', '## 甲', '出厂甲', '', '## 乙', '出厂乙', '', '## 丙', '出厂丙', ''].join('\n');
    const 私有 = ['---', 'id: x', 'kind: 规则', 'authority: 法律', 'version: 1', '---', '# 标题（私有）', '', '## 乙', '私有乙', ''].join('\n');
    const 生效 = effectiveDocument(出厂, 私有, { defaultAuthority: '法律' });
    assert.equal(生效.errors.length, 0);
    assert.ok(String(生效.body).includes('标题（私有）'), '段外头以私有为准');
    assert.ok(String(生效.body).includes('私有乙'), '私有同名段覆盖');
    assert.ok(String(生效.body).includes('出厂甲'), '私有未出现的段继承出厂（甲）');
    assert.ok(String(生效.body).includes('出厂丙'), '私有未出现的段继承出厂（丙）');
    assert.ok(!String(生效.body).includes('出厂乙'), '被覆盖的出厂段不残留');
    assert.match(String(生效.合并来源), /段级合并/);
  });

  it('两向：出厂 deny 条款 + 私有只改无关段 ⇒ 合并后 deny 条款仍在（修前整文件替换会丢）', async () => {
    const f = await makeFixture({
      rules: { '集体L1-法律/权限矩阵.md': 权限矩阵('出厂版', true) },
    });
    try {
      // 私有只定制「三档门槛」一段（不碰授权块所在的结构）——整文件替换的经典踩法。
      await writeUnder(f.privateRoot, '集体L1-法律/权限矩阵.md', 权限矩阵('私有版', false));
      const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
      const 规则 = (org.policy.state.rules ?? []).find((r) => r.id === '权限矩阵');
      assert.ok(规则, '权限矩阵在案');
      assert.ok(String(规则.text).includes('grants'), `合并后出厂授权块必须继承（修前私有命中即短路 ⇒ 丢失）：${String(规则.text).slice(0, 200)}`);
      assert.ok(String(规则.text).includes('成员不得删除组织对象'), '继承的授权块内容逐字来自出厂那份');
      const deny = (org.policy.grants ?? []).find((g) => g.subject === '成员' && g.action === 'delete');
      assert.ok(deny, `出厂的 deny grant 必须仍在：${JSON.stringify(org.policy.grants)}`);
      assert.equal(deny.verdict, 'deny');
      // 行为面：出厂的 deny 条款必须在**授权块这一层**承重。动作选 `write`（宪章 §3.2 只在
      // delete/publish 上先拦，write 会走到 grant 判定）——修前 grants=[] ⇒ 该拒绝不出现。
      const 判 = await org.policy.decide({ subject: MEMBER, action: 'write', target: { id: 'obj-1', kind: '知识', authority: '自治', zone: '私有' }, context: {} });
      assert.equal(判.verdict, 'deny', `成员 write 必须被出厂的 deny 条款拦住：${JSON.stringify(判)}`);
      assert.match(String(判.rule), /权限矩阵|grant/, `拒因应指回授权块：${判.rule}`);
    } finally {
      await f.cleanup();
    }
  });
});

describe('R04 · 授权依赖新鲜度与显式重载', () => {
  it('手改私有部署介入度 ⇒ 下一判定自动生效（无需显式 reload）', async () => {
    const f = await makeFixture();
    try {
      const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
      assert.equal(org.policy.state.defaults?.介入度, '零参与', '前提：夹具默认零参与');
      // 手改部署.json：介入度 → 逐条审批（模拟管理员直接编辑，不经任何服务层入口）。
      await writeUnder(f.privateRoot, '集体L2-共享基础设施/defaults/部署.json', `${JSON.stringify({ 介入度: '逐条审批' }, null, 2)}\n`);
      // 不给显式 reload：decide 的依赖签名比对必须在本次判定前发现变化并重载。
      const 判 = await org.policy.decide({ subject: LEAD, action: 'write', target: { id: 'obj-2', kind: '知识', authority: '自治', zone: '私有' }, context: {} });
      assert.equal(org.policy.state.defaults?.介入度, '逐条审批', '介入度必须已生效');
      assert.equal(判.verdict, 'confirm', `逐条审批档下 Lead 写应转 confirm（实际 ${JSON.stringify(判)}）`);
    } finally {
      await f.cleanup();
    }
  });

  it('手改规则件 ⇒ 下一判定自动生效（判定理由跟着换）', async () => {
    const f = await makeFixture();
    try {
      const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
      const 前 = org.policy.describe();
      // 手改私有权限矩阵（加一条「成员不得 publish」的 deny），不经服务层。
      await writeUnder(f.privateRoot, '集体L1-法律/权限矩阵.md', [
        '---', 'id: 权限矩阵', 'kind: 规则', 'authority: 法律', 'zone: 私有', 'domain: 集体', 'version: 1', '---',
        '# 权限矩阵', '', '## 三档门槛', '你定的 > 组织定的。', '',
        '```policy', JSON.stringify({ grants: [{ subject: '成员', action: 'write', verdict: 'deny', reason: '手改后的新条款' }] }, null, 2), '```', '',
      ].join('\n'));
      const 判 = await org.policy.decide({ subject: MEMBER, action: 'write', target: { id: 'cap-x', kind: '能力', authority: '自治', zone: '私有' }, context: {} });
      // 重载确实发生（摘要变化）且新条款生效。
      assert.equal(判.verdict, 'deny', `新条款必须生效：${JSON.stringify(判)}`);
      assert.match(String(判.rule), /grant/, `拒因应来自新 grant：${判.rule}`);
      assert.notDeepEqual(org.policy.describe().digests, 前.digests, '规则摘要应已变化（重载真的发生了）');
    } finally {
      await f.cleanup();
    }
  });

  it('policy_reload 动作：仅 Lead/主权者；回执带前后摘要对照与落审计', async () => {
    const f = await makeFixture();
    try {
      const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
      // 权限闸：成员没有这只手。
      await assert.rejects(
        () => runAction({ org, 项目: P, 主体: MEMBER, subject: MEMBER, args: { action: 'policy_reload' } }),
        (e) => e instanceof Denied && /策略重载仅 Lead/.test(e.rule),
        '成员不得重载策略引擎',
      );
      const r = await runAction({ org, 项目: P, 主体: LEAD, subject: LEAD, args: { action: 'policy_reload' } });
      assert.equal(typeof r.数据.健康, 'boolean');
      assert.ok(Array.isArray(r.数据.摘要.前) && Array.isArray(r.数据.摘要.后), `回执要带前后摘要：${JSON.stringify(r.数据)}`);
      assert.equal(r.数据.摘要.前.length, r.数据.摘要.后.length, '重载前后规则数不变（同盘）');
      assert.equal(r.数据.摘要变化, false, '盘上没变 ⇒ 摘要一致（如实报「无变化」）');
      const 行 = (await org.audit.read({})).filter((x) => x.动作 === '策略重载').at(-1);
      assert.ok(行, '重载必须落审计');
      assert.equal(行.主体.id, 'lead');
      // 改盘后再重载 ⇒ 回执报「有变化」。
      await writeUnder(f.privateRoot, '集体L1-法律/权限矩阵.md', 权限矩阵('显式重载后的新内容', true));
      const r2 = await runAction({ org, 项目: P, 主体: LEAD, subject: LEAD, args: { action: 'policy_reload' } });
      assert.equal(r2.数据.摘要变化, true, `改盘后重载应报有变化：${JSON.stringify(r2.数据.摘要)}`);
    } finally {
      await f.cleanup();
    }
  });
});
