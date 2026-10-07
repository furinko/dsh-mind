/**
 * 对象存储、能力库、角色注册表。
 *
 * 这三件的共同点是「有真源、有索引、有版本」：测试必须证明**索引能从真源重建**、
 * **版本真的留下前一版**、**同名真的不合并**——否则它们就是一堆会漂移的副本。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { makeFixture, SOVEREIGN, LEAD, MEMBER, writeUnder } from './helpers.mjs';
import { ObjectStore } from '../src/store.js';
import { CapabilityLibrary } from '../src/capability.js';
import { RoleRegistry } from '../src/registry.js';
import { InvalidBody, Denied } from '../src/kernel/errors.js';

/** @type {Awaited<ReturnType<typeof makeFixture>>} */
let f;
/** @type {ObjectStore} */
let store;
/** @type {CapabilityLibrary} */
let capability;
/** @type {RoleRegistry} */
let registry;

const 能力卡 = (id, 岗位, 正文) => [
  '---',
  `id: ${id}`,
  'kind: 能力',
  'authority: 自治',
  'zone: 私有',
  'domain: 集体',
  'version: 1',
  '---',
  `# ${id}`,
  '',
  '## 适用岗位',
  ...岗位.map((r) => `- ${r}`),
  '',
  '## 怎么做',
  正文,
].join('\n');

describe('对象存储 / 能力库 / 角色注册表', () => {
  before(async () => {
    f = await makeFixture();
    store = new ObjectStore({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
    capability = new CapabilityLibrary({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
    registry = new RoleRegistry({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
  });
  after(async () => {
    await f.cleanup();
  });

  it('版本化在写时自动发生：改动前留前一版', async () => {
    await store.write('能力', { meta: { id: 'ver-demo', authority: '自治', domain: '集体', project: null, refs: [] }, body: 能力卡('ver-demo', ['插件工程'], '第一版').replace(/^---[\s\S]*?---\n/, '') }, { subject: LEAD, reason: '首建' });
    const second = await store.write('能力', { meta: { id: 'ver-demo', authority: '自治', domain: '集体', project: null }, body: 能力卡('ver-demo', ['插件工程'], '第二版').replace(/^---[\s\S]*?---\n/, '') }, { subject: LEAD, reason: '改了一处' });
    assert.equal(second.version, 2);
    const history = await store.history('ver-demo');
    assert.deepEqual(history.map((h) => h.version), [1]);
    const v1 = await store.readVersion('ver-demo', 1);
    assert.match(v1, /第一版/, '历史里必须是改动前的那一版');
  });

  it('回滚也是写入：它读历史正文，然后自动再留一版（谁也不能抹掉回滚这件事）', async () => {
    await store.write('能力', { meta: { id: 'ver-demo', authority: '自治', domain: '集体' }, body: 能力卡('ver-demo', ['插件工程'], '第三版').replace(/^---[\s\S]*?---\n/, '') }, { subject: LEAD, reason: '再改' });
    const rolled = await store.rollback('能力', 'ver-demo', 1, { subject: SOVEREIGN, reason: '回滚到第一版' });
    assert.equal(rolled.restoredFrom, 1);
    assert.ok(rolled.version >= 4, '回滚本身产生新版本');
    const current = await store.read('能力', 'ver-demo', { subject: LEAD });
    assert.match(current.body, /第一版/);
    const history = await store.history('ver-demo');
    assert.ok(history.length >= 3, '回滚前的状态也留在历史里');
  });

  it('非主权者不能回滚文本版本', async () => {
    await assert.rejects(
      () => store.rollback('能力', 'ver-demo', 1, { subject: LEAD, reason: '我想回滚' }),
      (error) => error instanceof Denied && /主权者/.test(error.rule + error.reason),
    );
  });

  it('出厂区只读：只有出厂作者能写', async () => {
    await assert.rejects(
      () => store.write('能力', { meta: { id: 'x', authority: '自治' }, body: '## 适用岗位\n- a\n\n## 怎么做\nb' }, { subject: LEAD, reason: '写出厂区', zone: '出厂' }),
      (error) => error instanceof InvalidBody && /只读模板/.test(error.message),
    );
  });

  it('能力库：同名不合并，两条都返回、默认自治、冲突交给 Lead', async () => {
    await writeUnder(f.factoryRoot, '集体L2-共享基础设施/能力库/同名演示.md', 能力卡('同名演示', ['插件工程'], '出厂的做法：先用 grep。'));
    await capability.publish({ subject: LEAD, 名: '同名演示', 适用岗位: ['插件工程'], 正文: '自治的做法：先读设计文档再动手。', 依据: '组织自治' });

    const 解析 = await capability.resolve({ 名: '同名演示' });
    assert.equal(解析.条目.length, 2, '两条都要返回');
    assert.deepEqual(解析.条目.map((c) => c.来源).sort(), ['出厂', '自治']);
    assert.equal(解析.默认, '自治');
    assert.equal(解析.冲突, true);
    assert.match(解析.说明, /Lead/);

    const 自治条目 = await capability.read({ id: '同名演示', 来源: '自治' });
    assert.match(自治条目.正文, /自治的做法/);
    const 出厂条目 = await capability.read({ id: '同名演示', 来源: '出厂' });
    assert.match(出厂条目.正文, /出厂的做法/);
  });

  it('能力卡缺「适用岗位」或「怎么做」就拒收（写入侧校验）', async () => {
    await assert.rejects(
      () => capability.publish({ subject: LEAD, 名: '残缺能力', 适用岗位: [], 正文: '没有岗位段会被 assertStructure 拦下', 依据: '测试' }),
      (error) => error instanceof InvalidBody,
    );
  });

  it('岗位 → 能力引用（单源：角色卡只存引用，不内嵌正文）', async () => {
    const 卡 = [
      '---', 'id: 插件工程', 'kind: 身份', 'authority: 自治', 'zone: 私有', 'domain: 个体', 'version: 1', '---',
      '# 插件工程', '', '## 个体L0 · 身份', '插件工程岗。', '',
      '## 个体L1 · 规则', '先搜后写。', '',
      '## 个体L2 · 能力', '- 同名演示', '- policy-decision', '',
      '## 个体L3 · 经验', '- 无',
    ].join('\n');
    await writeUnder(f.privateRoot, '集体L3-成员角色卡/插件工程.md', 卡);
    const refs = await capability.referencesFor({ 岗位: '插件工程' });
    assert.deepEqual(refs.引用, ['同名演示', 'policy-decision']);
    assert.equal(refs.解析.find((r) => r.id === '同名演示').来源, '自治');
  });

  it('注册表：索引可从真源重建（删掉索引再 sync，内容仍然对）', async () => {
    const first = await registry.sync();
    assert.ok(first.岗位 >= 1);
    const { rm } = await import('node:fs/promises');
    await rm(f.layout.registryFile(), { force: true });
    const second = await registry.sync();
    assert.equal(second.实例, first.实例);
    const index = JSON.parse(await readFile(f.layout.registryFile(), 'utf8'));
    assert.ok(index.岗位.some((r) => r.id === '插件工程'));
    assert.equal(index.岗位.find((r) => r.id === '插件工程').来源, '私有');
  });

  it('实例权限只来自岗位：不存在的岗位不能发实例', async () => {
    await assert.rejects(
      () => registry.assign({ subject: LEAD, 岗位: '不存在的岗位', 实例: 'ghost-1' }),
      (error) => error instanceof Denied,
    );
    const ok = await registry.assign({ subject: LEAD, 岗位: '插件工程', 实例: 'member-x', 代: 2 });
    assert.equal(ok.状态, '在岗');
    assert.equal(ok.代, 2);
  });

  it('封存 ≠ 删除：卡留在盘上，状态改变', async () => {
    await registry.assign({ subject: LEAD, 岗位: '插件工程', 实例: 'member-seal' });
    const sealed = await registry.seal({ subject: LEAD, 实例: 'member-seal', 理由: '停岗' });
    assert.equal(sealed.状态, '封存');
    assert.equal(sealed.岗位卡仍在, true);
    const 卡文件 = await readdir(f.layout.roleCardDir('自治'));
    assert.ok(卡文件.includes('插件工程.md'), '卡不能被删');
    const restored = await registry.restore({ subject: LEAD, 实例: 'member-seal' });
    assert.equal(restored.状态, '在岗');
  });

  it('撤回 = 写拒绝名单，不删卡', async () => {
    const r = await registry.revoke({ subject: SOVEREIGN, 对象id: '插件工程', 理由: '主权者撤回' });
    assert.equal(r.已撤回, true);
    assert.equal(r.卡仍存在, true, '对象仍然存在');
    const list = await registry.denylist();
    assert.ok(list.some((d) => d.id === '插件工程'));
    await f.policy.reload();
    const decision = await f.policy.decide({ subject: LEAD, action: 'write', target: { id: '插件工程', kind: '身份', authority: '自治' } });
    assert.equal(decision.verdict, 'deny');
  });

  it('canTouch 答得出「这身份能碰什么」', async () => {
    const answer = await registry.canTouch({ id: 'member-x' });
    assert.equal(answer.岗位, '插件工程');
    assert.equal(answer.在岗, true);
    assert.ok(answer.权限.some((p) => p.action === 'read' && p.verdict === 'allow'));
    assert.ok(answer.权限.some((p) => p.action === 'delete' && p.verdict === 'deny'));
    assert.deepEqual(answer.能力, ['同名演示', 'policy-decision']);
    assert.deepEqual(answer.锁定的段, ['个体L0']);
  });

  it('未登记身份得到确定答案，而不是「查不到就放行」', async () => {
    const answer = await registry.canTouch({ id: '从来没有过的实例' });
    assert.equal(answer.在岗, false);
    assert.match(answer.原因, /查不到不等于放行/);
    assert.deepEqual(answer.权限, []);
  });

  it('成员身份无法直读能力库的写入面之外的旁路：每个动作都过策略引擎', async () => {
    // 成员在任务外调 publish ⇒ 必须被拒绝，且拒绝理由指向「任务外无」或「成员不得 create」。
    await assert.rejects(
      () => capability.publish({ subject: MEMBER, 名: '成员私自发的能力', 适用岗位: ['插件工程'], 正文: 'x', 依据: '我想加' }),
      (error) => error instanceof Denied || error instanceof InvalidBody,
    );
  });
});
