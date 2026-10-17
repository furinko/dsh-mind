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
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rm, stat, utimes, writeFile } from 'node:fs/promises';
import { makeFixture, LEAD, MEMBER, writeUnder } from './helpers.mjs';
import { extractPolicyBlock } from '../src/policy.js';
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

describe('R18 · 私有授权块按条款覆盖（2026-10-17 打回修正）', () => {
  const 文档 = (blocks) => [
    '---', 'id: 权限矩阵', 'kind: 规则', 'authority: 法律', 'version: 1', '---',
    '# 权限矩阵', ...blocks.flatMap((block, i) => [`## 段${i}`, '```policy', typeof block === 'string' ? block : JSON.stringify(block), '```']),
  ].join('\n');
  const 条款 = (kind, verdict = 'deny', reason = kind) => ({ subject: 'Lead', action: 'write', kind, verdict, reason });
  const 合并 = (出厂, 私有) => effectiveDocument(文档(出厂), 文档(私有), { defaultAuthority: '法律' });

  it('R18修正：私有有块时保留未覆盖出厂条款且只输出一个授权块', () => {
    const doc = 合并([{ grants: [条款('知识')] }], [{ grants: [条款('能力')] }]);
    assert.deepEqual(doc.errors, []);
    assert.equal([...doc.body.matchAll(/```policy\n/g)].length, 1, '授权块不得留在段正文后再追加一遍');
    assert.deepEqual(extractPolicyBlock(doc.body).grants, [条款('知识'), 条款('能力')]);
  });

  it('R18修正：精确选择器原位覆盖而宽窄选择器不互相吞掉', () => {
    const factory = [条款('知识'), { subject: 'Lead', action: 'write', verdict: 'deny', reason: '广域' }];
    const override = 条款('知识', 'confirm', '私有确认');
    const narrow = { ...条款('知识'), authority: '自治', reason: '限定档位' };
    const doc = 合并([{ grants: factory }], [{ grants: [override, narrow] }]);
    assert.deepEqual(extractPolicyBlock(doc.body).grants, [override, factory[1], narrow]);
  });

  it('R18修正：subject与action不同也不算同条覆盖', () => {
    const factory = [条款('知识'), { ...条款('知识'), subject: '成员' }, { ...条款('知识'), action: 'read' }];
    const override = 条款('知识', 'confirm');
    assert.deepEqual(extractPolicyBlock(合并([{ grants: factory }], [{ grants: [override] }]).body).grants, [override, factory[1], factory[2]]);
  });

  it('R18修正：同层重复选择器保留首条不因合并改成last-match', () => {
    const first = 条款('知识', 'deny', '首条');
    const second = 条款('知识', 'allow', '后条');
    const doc = 合并([{ grants: [条款('知识')] }], [{ grants: [first, second] }]);
    assert.deepEqual(extractPolicyBlock(doc.body).grants, [first]);
  });

  it('R18修正：非法grant不能被私有合法同条遮盖', () => {
    for (const bad of [null, [], { ...条款('知识'), action: '' }, { ...条款('知识'), verdict: 'Deny' }]) {
      assert.ok(合并([{ grants: [bad] }], [{ grants: [条款('知识')] }]).errors.length > 0);
    }
    assert.ok(合并([{ grants: '错误形状' }], [{ grants: [条款('知识')] }]).errors.length > 0);
  });

  it('R18修正：多授权块逐条合并且空grants不是删除指令', () => {
    const doc = 合并([{ grants: [条款('知识')], mode: '独立会审' }, { grants: [条款('经历')] }], [{ grants: [] }, { roles: ['复核员'] }]);
    const block = extractPolicyBlock(doc.body);
    assert.deepEqual(block.grants, [条款('知识'), 条款('经历')]);
    assert.deepEqual(block.roles, ['复核员']);
    assert.equal(block.mode, '独立会审');
    assert.equal([...doc.body.matchAll(/```policy\n/g)].length, 1);
  });

  it('R18修正：任一侧坏JSON都不得被另一侧的有效块遮掉', () => {
    for (const [factory, local] of [
      [['{坏JSON'], [{ grants: [条款('知识')] }]],
      [[{ grants: [条款('知识')] }], ['{坏JSON']],
    ]) {
      assert.ok(合并(factory, local).errors.some((error) => /policy|授权块/.test(error)), '坏块必须在生效文档errors里可见');
    }
    const 未闭合 = 文档([{ grants: [条款('知识')] }]).replace(/\n```$/, '');
    assert.ok(effectiveDocument(未闭合, 文档([{ grants: [条款('知识')] }]), { defaultAuthority: '法律' }).errors.some((error) => /未闭合/.test(error)));
    assert.ok(extractPolicyBlock('```policy\n{}').解析错误.some((error) => /未闭合/.test(error)));
  });

  it('R18修正：真实引擎继承与覆盖均在grant层承重而非宪章提前挡住', async () => {
    const f = await makeFixture({ rules: { '集体L1-法律/权限矩阵.md': 文档([{ grants: [条款('知识'), 条款('经历')] }]) } });
    try {
      await f.writePrivate('集体L1-法律/权限矩阵.md', 文档([{ grants: [条款('经历', 'confirm', '私有确认'), 条款('能力')] }]));
      assert.equal(await f.policy.reload(), true);
      assert.equal(f.policy.grants.filter((g) => g.source.startsWith('权限矩阵')).length, 3);
      for (const [kind, expected] of [['知识', 'deny'], ['经历', 'confirm'], ['能力', 'deny']]) {
        const result = await f.policy.decide({ subject: LEAD, action: 'write', target: { id: 'r18-' + kind, kind, authority: '自治', zone: '私有' } });
        assert.equal(result.verdict, expected, JSON.stringify(result));
        assert.match(result.rule, /grant/);
      }
    } finally {
      assert.match(f.home, /[\\/]mind-fix-[^\\/]+$/);
      await f.cleanup();
    }
  });

  it('R18修正：被私有同名段覆盖的出厂坏块仍令引擎fail-closed', async () => {
    const f = await makeFixture({ rules: { '集体L1-法律/权限矩阵.md': 文档(['{坏JSON']) } });
    try {
      await f.writePrivate('集体L1-法律/权限矩阵.md', 文档([{ grants: [条款('知识')] }]));
      assert.equal(await f.policy.reload(), false);
      assert.equal(f.policy.healthy, false);
    } finally {
      assert.match(f.home, /[\\/]mind-fix-[^\\/]+$/);
      await f.cleanup();
    }
  });
});

describe('R04 · 授权依赖新鲜度与显式重载', () => {
  const 改文件 = async (file, content) => {
    const previous = await stat(file);
    await writeFile(file, content, 'utf8');
    await utimes(file, previous.atime, new Date(previous.mtimeMs + 60_000));
  };

  it('R04修正：探针声明改动自动刷新且稳定后不重复reload', async () => {
    const f = await makeFixture();
    try {
      const file = f.layout.probeDeclaration();
      assert.ok(f.policy.authSig.路径.includes(file), '真实读过的声明必须进入签名');
      await 改文件(file, JSON.stringify({ 探针: ['审计链'] }));
      assert.deepEqual(await f.policy.refreshIfStale(), { changed: true, reloaded: true, ok: true });
      assert.deepEqual(f.policy.state.defaults.安全类, ['审计链']);
      assert.deepEqual(await f.policy.refreshIfStale(), { changed: false, reloaded: false, ok: true });
    } finally {
      assert.match(f.home, /[\\/]mind-fix-[^\\/]+$/);
      await f.cleanup();
    }
  });

  it('R04修正：探针声明缺失出现和坏JSON修复均进入自动刷新', async () => {
    const f = await makeFixture();
    try {
      const file = f.layout.probeDeclaration();
      assert.ok(file.startsWith(f.factoryRoot));
      await rm(file);
      assert.equal((await f.policy.refreshIfStale()).changed, true);
      assert.deepEqual(f.policy.state.defaults.安全类, []);
      await writeFile(file, JSON.stringify({ 探针: ['闸在位'] }), 'utf8');
      assert.equal((await f.policy.refreshIfStale()).changed, true);
      assert.deepEqual(f.policy.state.defaults.安全类, ['闸在位']);
      await 改文件(file, '{坏JSON');
      assert.equal((await f.policy.refreshIfStale()).ok, false);
      assert.equal(f.policy.healthy, false);
      await 改文件(file, JSON.stringify({ 探针: ['审计链'] }));
      assert.equal((await f.policy.refreshIfStale()).ok, true);
      assert.deepEqual(f.policy.state.defaults.安全类, ['审计链']);
    } finally {
      assert.match(f.home, /[\\/]mind-fix-[^\\/]+$/);
      await f.cleanup();
    }
  });

  it('R04修正：工具总范围并非策略加载依赖不应误入签名', async () => {
    const f = await makeFixture();
    try {
      const file = f.layout.factoryDefault('工具总范围');
      assert.equal(f.policy.authSig.路径.includes(file), false);
      await 改文件(file, JSON.stringify({ 允许: ['read'], 拒绝: ['write'] }));
      assert.deepEqual(await f.policy.refreshIfStale(), { changed: false, reloaded: false, ok: true });
    } finally {
      assert.match(f.home, /[\\/]mind-fix-[^\\/]+$/);
      await f.cleanup();
    }
  });
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
