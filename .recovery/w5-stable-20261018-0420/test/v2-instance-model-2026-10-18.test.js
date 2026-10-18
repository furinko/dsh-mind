/**
 * W5 回归网（v2 口述收敛 2026-10-18 条目8/9/10/11/12/20）。
 *
 * 钉七件事，每件都配**能变红**的坏状态（这是「验过」与「记得它能跑」的分界）：
 *  ① 钉卡版本：实例出生时钉住当时的生效卡（内容寻址快照），改卡文件后
 *     运行中实例的规则 / 能力面**不跟着变**，但「钉的是旧版、盘里是新版」可见；
 *  ② 生命周期：创建 / 绑定 / 交卷 / 封存入注册表索引（创建·绑定·封存真写身份档案，
 *     交卷从任务事件流投影，活跃从审计链投影）；
 *  ③ 孤儿回收：同代=活；异代 + pid 死=封存；异代 + pid 活=未判定（不动）；
 *     无代次=未判定（响亮）。**任务节点状态绝不因回收而前进**；
 *  ④ 不越授：Lead 派活不得造平级/上级；给自己的登记归「不自授」管（幂等放行）；
 *     声明写域扩张但没有上游范围 ⇒ 拒（不猜全集）；
 *  ⑤ 不自授：同权限幂等登记放行且不写盘；给自己换更高种类 ⇒ 拒；缺扩张集合判定 ⇒ 拒；
 *  ⑥ 系统封闭：无机制名的系统写拒；清单外三元组拒；清单内放行；系统**不豁免**失联冻结；
 *     模型面自报 role=系统 不改变主体；
 *  ⑦ 条目11：负责人保留岗位名、实例进 `绑定`；bind 只认**在册在岗且岗位对得上**的实例；
 *     复核实例的自有节点可有受限生命周期（开工 → 交卷报告），别的节点一步不放。
 *
 * ⚠️ **本批未含（待补修，见任务记录）**：签名安全 H ——「每一次新复核都必须有真实在册在岗
 * 复核实例 + 合法复核任务关联」。原方案借 `依赖` 表达关联会与 dispatch 的依赖门槛成环
 * （被复核节点只到已交卷，复核任务永远派不出去），已作废；正确方案是任务载体上独立的
 * `复核对象` 引用并在 review 时**无条件**校验。它牵动 18 个测试文件 46 处 review 调用点，
 * 属补修批，**不在本文件伪造一条会变红的断言来冒充已落**。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeFixture, writeUnder, LEAD, MEMBER, REVIEWER } from './helpers.mjs';
import { Org } from '../src/org.js';
import { Denied } from '../src/kernel/errors.js';
import { MECHANISM_NAMES, mechanismAllows } from '../src/mechanism.js';

const P = 'proj-w5';

/** 岗位卡（结构合规的最小卡；能力引用必须是能力库里真实存在的 id）。 */
function 岗位卡(id) {
  return `---
id: ${id}
kind: 身份
authority: 自治
zone: 出厂
domain: 个体
version: 1
---
<!-- authority: 自治 -->
# ${id}

## 个体L0 · 身份核心

我是 ${id}。

### 身份核心

锁定段。

## 个体L1 · 规则

1. 先搜后写。

## 个体L2 · 能力引用

- \`policy-decision\`

## 个体L3 · 经验引用

### 占位
`;
}

async function 起组织(options = {}) {
  const f = await makeFixture(options);
  for (const id of ['插件工程', '复核员', 'Lead']) {
    await writeUnder(f.privateRoot, `集体L3-成员角色卡/${id}.md`, 岗位卡(id));
  }
  const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P, ...(options.代次 ? { 代次: options.代次 } : {}) });
  return { f, org };
}

/** 造一个已派发、member-a 执行中的节点。 */
async function 执行中节点(org, 描述, 负责人 = '插件工程') {
  const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述, 负责人, 判据: ['判据一'] });
  await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
  return node;
}

describe('① 钉卡版本（条目10）：出生钉住，改卡不改运行中实例', () => {
  it('assign 钉住当时的卡；改卡文件后 canTouch 仍读钉住版，现行摘要可见地不同', async () => {
    const { f, org } = await 起组织();
    try {
      await org.registry.assign({ subject: LEAD, 岗位: '插件工程', 实例: 'i-1' });
      const 钉 = await org.registry.cardOf('i-1');
      assert.ok(钉.卡版本?.摘要, '登记即钉版');
      assert.equal(钉.未钉, false);
      const 出生摘要 = 钉.卡版本.摘要;

      // 改卡：加一项能力引用（工作面变化最容易读出差异）。
      await writeUnder(f.privateRoot, '集体L3-成员角色卡/插件工程.md', 岗位卡('插件工程').replace('- `policy-decision`', '- `task-node`\n- `upgrade-merge`'));

      const 后 = await org.registry.cardOf('i-1');
      assert.equal(后.卡版本.摘要, 出生摘要, '钉住的版本不因改卡而变');
      assert.notEqual(后.现行摘要, 出生摘要, '现行摘要确实变了（可见，但不静默生效）');

      const 面 = await org.registry.canTouch({ id: 'i-1' });
      assert.deepEqual(面.能力, ['policy-decision'], '运行中实例的能力面仍读钉住版');
    } finally { await f.cleanup(); }
  });

  it('审计带卡版本：实例登记与后续动作的主体上都记着钉住的摘要', async () => {
    const { f, org } = await 起组织();
    try {
      await org.registry.assign({ subject: LEAD, 岗位: '插件工程', 实例: 'i-2' });
      const 摘要 = (await org.registry.cardOf('i-2')).卡版本.摘要;
      const 行 = (await org.audit.read({})).filter((r) => r.对象?.id === 'i-2' && r.动作 === '状态变更').at(-1);
      assert.equal(行.详情.卡版本, 摘要, '登记行详情带卡版本');
      // 主体上的卡版本（runAction 单点补，audit.normalizeActor 认这个键）——用一次真实动作验。
      await org.registry.seal({ subject: { ...LEAD, 卡版本: 摘要 }, 实例: 'i-2', 理由: '钉版审计演示' });
      const 封存行 = (await org.audit.read({})).filter((r) => r.动作 === '状态变更' && r.对象?.id === 'i-2').at(-1);
      assert.equal(封存行.主体.卡版本, 摘要, '主体带卡版本进账');
    } finally { await f.cleanup(); }
  });
});

describe('② 生命周期（条目10）：创建/绑定/交卷/封存进注册表', () => {
  it('创建·绑定·封存真写身份档案；交卷从任务事件流投影进索引', async () => {
    const { f, org } = await 起组织();
    try {
      const node = await 执行中节点(org, 'w5-生命周期');
      await org.registry.assign({ subject: LEAD, 岗位: '插件工程', 实例: 'i-3', 节点: node.id });
      const 成员 = (await org.registry.identity()).members['i-3'];
      assert.ok(成员.生命周期?.创建于, '创建于落档');
      assert.equal(成员.生命周期.绑定节点, node.id, '绑定节点落档');

      await org.tasks.bind(node.id, { subject: LEAD, 项目: P, 实例: 'i-3', 岗位: '插件工程' });
      await org.tasks.start(node.id, { subject: { ...MEMBER, id: 'i-3' }, 项目: P });
      await org.tasks.submit(node.id, { subject: { ...MEMBER, id: 'i-3' }, 项目: P, 结论: '交卷' });
      await org.registry.sync({ 活动: { 'i-3': { 最近活动于: '2026-10-18T00:00:00Z', 活动条数: 3 } } });
      const index = JSON.parse(await readFile(f.layout.registryFile(), 'utf8'));
      const 行 = index.实例['i-3'];
      assert.ok(行.生命周期.创建于, '索引带创建于');
      assert.ok(行.生命周期.绑定时, '索引带绑定时');
      assert.ok(行.生命周期.交卷于, '索引带交卷于（任务事件流投影）');
      assert.equal(行.生命周期.最近活跃于, '2026-10-18T00:00:00Z', '活跃从审计链投影');
      assert.equal(行.卡版本.摘要, (await org.registry.cardOf('i-3')).卡版本.摘要, '索引带卡版本');

      await org.registry.seal({ subject: LEAD, 实例: 'i-3', 理由: '用完封存' });
      const 封 = (await org.registry.identity()).members['i-3'];
      assert.ok(封.生命周期.封存于, '封存时刻进生命周期');
    } finally { await f.cleanup(); }
  });
});

describe('③ 孤儿回收（条目12）：只认可靠进程代次，任务状态不被推进', () => {
  const 代本 = 'gen-now';

  /** 起一个「本代」组织：两个实例都属于本代，boot 记录里也记着本代 pid。 */
  async function 起本代() {
    const f = await makeFixture();
    for (const id of ['插件工程', '复核员', 'Lead']) await writeUnder(f.privateRoot, `集体L3-成员角色卡/${id}.md`, 岗位卡(id));
    await writeUnder(f.privateRoot, '身份档案/identity.json', `${JSON.stringify({
      members: {
        'member-a': { id: 'member-a', 岗位: '插件工程', 代: 1, status: '在岗', 代次: 代本 },
        'member-b': { id: 'member-b', 岗位: '插件工程', 代: 1, status: '在岗', 代次: 代本 },
      },
      sovereign: { lastInteraction: new Date().toISOString() },
      denylist: [],
      boot: { 代: 代本, pid: process.pid, 于: new Date().toISOString(), 代次记录: { [代本]: { pid: process.pid, 于: new Date().toISOString() } } },
    }, null, 2)}\n`);
    const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P, 代次: { 代: 代本, pid: process.pid, 于: new Date().toISOString() } });
    return { f, org };
  }

  /**
   * 改身份档案：把某实例挪到**上一代**，并记下那一代的 pid（模拟「崩溃前的那个宿主进程」）。
   * 直接改盘而不是走 actions —— 这一步模拟的是「宿主进程死了」，组织侧没有动作能表达它。
   */
  async function 改成上一代(f, 实例, pid) {
    const doc = JSON.parse(await readFile(f.layout.identityFile(), 'utf8'));
    doc.members[实例] = { ...doc.members[实例], 代次: 'gen-old' };
    doc.boot = { ...doc.boot, 代次记录: { ...(doc.boot?.代次记录 ?? {}), 'gen-old': { pid, 于: '2026-10-17T00:00:00Z' } } };
    await writeUnder(f.privateRoot, '身份档案/identity.json', `${JSON.stringify(doc, null, 2)}\n`);
  }

  it('异代 + pid 已死 ⇒ 封存；同代邻居不动；节点状态不变（未交卷不自动成功）', async () => {
    const { f, org } = await 起本代();
    try {
      const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '孤儿-节点不动', 负责人: 'member-b', 判据: ['x'] });
      await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
      await 改成上一代(f, 'member-a', 999999);
      const 读 = await org.registry.orphanSweep({ 代次: { 代: 代本 } });
      assert.deepEqual(读.封存, ['member-a'], '判得死的孤儿被封存');
      const 身份 = await org.registry.identity();
      assert.equal(身份.members['member-a'].status, '封存', '孤儿标封存');
      assert.equal(身份.members['member-b'].status, '在岗', '同代邻居不动（多会话共享组织安全）');
      const 后 = await org.tasks.get(node.id, { 项目: P });
      assert.equal(后.状态, '已派发', '回收绝不推进任务状态（未完成交卷不自动成功）');
      const 审计 = (await org.audit.read({})).filter((r) => r.动作 === '状态变更' && r.对象?.id === 'member-a').at(-1);
      assert.equal(审计.主体.kind, '系统', '回收记账主体=系统');
      assert.equal(审计.主体.id, 'system');
    } finally { await f.cleanup(); }
  });

  it('异代 + pid 仍活 ⇒ 未判定（宁漏收不错杀）', async () => {
    const { f, org } = await 起本代();
    try {
      await 改成上一代(f, 'member-a', process.pid);
      const 读 = await org.registry.orphanSweep({ 代次: { 代: 代本 } });
      assert.deepEqual(读.封存, [], 'pid 还活 ⇒ 不判死');
      assert.ok(读.未判定.some((x) => x.实例 === 'member-a' && /仍存活/.test(x.原因)), '未判定要写明事实');
      assert.equal((await org.registry.identity()).members['member-a'].status, '在岗', '未判定 ⇒ 不动');
    } finally { await f.cleanup(); }
  });

  it('无代次（历史实例）⇒ 未判定，不猜死', async () => {
    const { f, org } = await 起本代();
    try {
      const doc = JSON.parse(await readFile(f.layout.identityFile(), 'utf8'));
      delete doc.members['member-a'].代次;
      await writeUnder(f.privateRoot, '身份档案/identity.json', `${JSON.stringify(doc, null, 2)}\n`);
      const 读 = await org.registry.orphanSweep({ 代次: { 代: 代本 } });
      assert.deepEqual(读.封存, [], '没有存活事实就绝不判死');
      assert.ok(读.未判定.some((x) => x.实例 === 'member-a' && /无代次记录/.test(x.原因)));
      assert.equal((await org.registry.identity()).members['member-a'].status, '在岗');
    } finally { await f.cleanup(); }
  });
});

describe('④ 不越授（条目20）：派活不得造平级/上级', () => {
  it('Lead 把实例登记到主权者岗 ⇒ 拒（不是岗位名黑名单，是种类范围）', async () => {
    const { f, org } = await 起组织();
    try {
      await assert.rejects(
        () => org.registry.assign({ subject: LEAD, 岗位: '主权者', 实例: 'x-1' }),
        (e) => e instanceof Denied && /不越授/.test(e.rule),
        '平级/上级一律越授',
      );
      await assert.rejects(
        () => org.registry.assign({ subject: LEAD, 岗位: '出厂作者', 实例: 'x-2' }),
        (e) => e instanceof Denied && /不越授/.test(e.rule),
      );
      // 正对照：普通成员岗照常放行。
      const ok = await org.registry.assign({ subject: LEAD, 岗位: '插件工程', 实例: 'x-3' });
      assert.equal(ok.岗位, '插件工程');
    } finally { await f.cleanup(); }
  });

  it('派给上级实例（档案里岗位=主权者）⇒ 拒；派给成员实例 ⇒ 放行', async () => {
    const { f, org } = await 起组织({ members: {
      'member-a': { id: 'member-a', 岗位: '插件工程', 代: 1, status: '在岗' },
      'boss-1': { id: 'boss-1', 岗位: '主权者', 代: 1, status: '在岗' },
    } });
    try {
      const a = await org.tasks.create({ subject: LEAD, 项目: P, 描述: 'w5-派给上级', 负责人: 'boss-1', 判据: ['x'] });
      await assert.rejects(
        () => org.tasks.dispatch(a.id, { subject: LEAD, 项目: P }),
        (e) => e instanceof Denied && /不越授/.test(e.rule),
      );
      const b = await org.tasks.create({ subject: LEAD, 项目: P, 描述: 'w5-派给成员', 负责人: 'member-a', 判据: ['x'] });
      const 派 = await org.tasks.dispatch(b.id, { subject: LEAD, 项目: P });
      assert.equal(派.状态, '已派发');
    } finally { await f.cleanup(); }
  });

  it('声明写域扩张但本部署没有写域凭证 ⇒ 拒（不猜全集、不虚假通过）', async () => {
    const { f, org } = await 起组织();
    try {
      const d = await org.policy.decide({
        subject: LEAD,
        action: 'dispatch',
        target: { id: 'n-1', kind: '任务', authority: '自治', zone: '私有' },
        context: { task: { 负责人: ['插件工程'], 状态: '待派发' }, 写域: ['宪章'] },
      });
      assert.equal(d.verdict, 'deny');
      assert.match(d.rule, /不越授/);
      assert.match(d.reason, /写域/);
    } finally { await f.cleanup(); }
  });
});

describe('⑤ 不自授（条目20）：按扩张集合判，同权限幂等放行', () => {
  it('Lead 重复登记自己同一个岗位 ⇒ 放行且不写盘（幂等）', async () => {
    const { f, org } = await 起组织();
    try {
      await org.registry.ensureLeadInstance({ 实例: 'lead-session-1', 代次: { 代: 'g1' } });
      const 前 = JSON.stringify((await org.registry.identity()).members['lead-session-1']);
      const r = await org.registry.assign({ subject: { ...LEAD, id: 'lead-session-1' }, 岗位: 'Lead', 实例: 'lead-session-1' });
      assert.equal(r.幂等, true, '同岗位重复登记 = 幂等');
      const 后 = JSON.stringify((await org.registry.identity()).members['lead-session-1']);
      assert.equal(后, 前, '幂等登记不写盘');
    } finally { await f.cleanup(); }
  });

  it('Lead 给自己换到更高种类的岗位 ⇒ 拒（扩张集合非空）', async () => {
    const { f, org } = await 起组织();
    try {
      await org.registry.ensureLeadInstance({ 实例: 'lead-session-2', 代次: { 代: 'g1' } });
      await assert.rejects(
        () => org.registry.assign({ subject: { ...LEAD, id: 'lead-session-2' }, 岗位: '主权者', 实例: 'lead-session-2' }),
        (e) => e instanceof Denied && /不自授/.test(e.rule),
      );
    } finally { await f.cleanup(); }
  });

  it('自身身份写但没带扩张集合判定 ⇒ 拒（fail-closed，不猜）', async () => {
    const { f, org } = await 起组织();
    try {
      // 用 Lead 主体的**给自己登记**这一格：成员的首道闸是「成员不得建卡」，先于不自授，
      // 测不到本判据；Lead 自登才走到「扩张集合缺席 ⇒ 拒」。
      const d = await org.policy.decide({
        subject: { id: 'lead-x', kind: 'Lead', roleId: 'Lead' },
        action: 'create',
        target: { id: 'lead-x', kind: '身份', authority: '自治', zone: '私有', 岗位: 'Lead' },
        context: { 身份操作: '实例' },
      });
      assert.equal(d.verdict, 'deny');
      assert.match(d.rule, /不自授/);
    } finally { await f.cleanup(); }
  });
});

describe('⑥ 系统主体封闭清单（条目8）：不当万能写后门', () => {
  it('清单固定：四项，且三元组逐项匹配（换档/换动作/换目标类都不匹配）', () => {
    assert.deepEqual([...MECHANISM_NAMES].sort(), ['会审解锁', '实例出生', '孤儿回收', '轮边界'].sort());
    assert.equal(mechanismAllows('轮边界', 'create', '只增', '消息'), true);
    assert.equal(mechanismAllows('轮边界', 'write', '只增', '消息'), false, '换动作不匹配');
    assert.equal(mechanismAllows('轮边界', 'create', '自治', '消息'), false, '换档不匹配');
    assert.equal(mechanismAllows('轮边界', 'create', '只增', '身份'), false, '换目标类不匹配');
    assert.equal(mechanismAllows('不存在的机制', 'create', '自治', '身份'), false);
  });

  it('系统写不带机制名 ⇒ 拒；带清单内机制名 ⇒ 放行；系统 id 必须 system', async () => {
    const { f, org } = await 起组织();
    try {
      const 无机制 = await org.policy.decide({
        subject: { id: 'system', kind: '系统' },
        action: 'write',
        target: { id: 'x', kind: '身份', authority: '自治', zone: '私有' },
      });
      assert.equal(无机制.verdict, 'deny');
      assert.match(无机制.rule, /系统只做机制动作/);

      const 错三元组 = await org.policy.decide({
        subject: { id: 'system', kind: '系统' },
        action: 'write',
        target: { id: 'x', kind: '身份', authority: '自治', zone: '私有' },
        context: { 机制动作: '实例出生' },
      });
      assert.equal(错三元组.verdict, 'deny', '清单项写的是 create，write 不在里面');

      const 对 = await org.policy.decide({
        subject: { id: 'system', kind: '系统' },
        action: 'create',
        target: { id: 'x', kind: '身份', authority: '自治', zone: '私有' },
        context: { 机制动作: '实例出生', 身份操作: '实例' },
      });
      assert.equal(对.verdict, 'allow');

      const 换id = await org.policy.decide({
        subject: { id: 'system-lookalike', kind: '系统' },
        action: 'create',
        target: { id: 'x', kind: '身份', authority: '自治', zone: '私有' },
        context: { 机制动作: '实例出生' },
      });
      assert.equal(换id.verdict, 'deny', '系统主体形状唯一');
    } finally { await f.cleanup(); }
  });

  it('系统不豁免失联冻结：失联期系统机制写照样被冻', async () => {
    const { f, org } = await 起组织({ offline: true });
    try {
      const d = await org.policy.decide({
        subject: { id: 'system', kind: '系统' },
        action: 'seal',
        target: { id: 'x-1', kind: '身份', authority: '自治', zone: '私有' },
        context: { 机制动作: '孤儿回收' },
      });
      assert.equal(d.verdict, 'deny');
      assert.match(d.rule, /失联/);
    } finally { await f.cleanup(); }
  });
});

describe('⑦ 条目11 绑定 + 署名安全：负责人保岗位名，实例独立绑定', () => {
  it('bind 不覆盖负责人；全员已交按已绑实例判', async () => {
    const { f, org } = await 起组织();
    try {
      const node = await 执行中节点(org, 'w5-绑定');
      assert.deepEqual(node.负责人, ['插件工程'], '负责人仍是岗位名');
      await org.tasks.bind(node.id, { subject: LEAD, 项目: P, 实例: 'member-a', 岗位: '插件工程' });
      const 后 = await org.tasks.get(node.id, { 项目: P });
      assert.deepEqual(后.负责人, ['插件工程'], 'bind 不改负责人');
      assert.deepEqual(后.绑定.map((b) => b.实例), ['member-a'], '实例进绑定');
      await org.tasks.start(node.id, { subject: MEMBER, 项目: P });
      const 交 = await org.tasks.submit(node.id, { subject: MEMBER, 项目: P, 结论: 'done' });
      assert.equal(交.状态, '已交卷');
    } finally { await f.cleanup(); }
  });

  it('复核实例只能动自己绑定的复核节点（受限生命周期，不是 role 全局豁免）', async () => {
    const { f, org } = await 起组织();
    try {
      const 复核任务 = await org.tasks.create({ subject: LEAD, 项目: P, 描述: 'w5-复核自带节点', 负责人: '复核员', 判据: ['核对'] });
      await org.tasks.bind(复核任务.id, { subject: LEAD, 项目: P, 实例: 'reviewer', 岗位: '复核员' });
      await org.tasks.dispatch(复核任务.id, { subject: LEAD, 项目: P });
      // 自己绑定的节点：开工 + 交卷报告放行。
      const 开 = await org.tasks.start(复核任务.id, { subject: REVIEWER, 项目: P });
      assert.equal(开.状态, '执行中');
      const 报 = await org.tasks.submit(复核任务.id, { subject: REVIEWER, 项目: P, 结论: '报告' });
      assert.equal(报.状态, '已交卷');
      // 别人的节点：仍按「只读数，不改」拒。
      const 业务 = await 执行中节点(org, 'w5-别人节点');
      await assert.rejects(
        () => org.tasks.start(业务.id, { subject: REVIEWER, 项目: P }),
        (e) => e instanceof Denied && /复核员岗/.test(e.rule),
      );
    } finally { await f.cleanup(); }
  });
});
