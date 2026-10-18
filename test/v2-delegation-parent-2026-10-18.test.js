/**
 * 受控父判（v2 口述收敛 2026-10-18 条目20 · 不越授）的回归网。
 *
 * 被验的判据（一条一句话，每条都能变红）：
 *  ① **正常委派**：委派者（Lead）自己有这个权 ⇒ 成员任务内照常写；
 *  ② **只给成员的 grant 也越不过父**：权限矩阵给「成员」allow、给「Lead」deny 时，
 *     成员那一格必须被父判拒——「委派不能派自己没有的权」；
 *  ③ **父判 confirm 门槛传播**：委派者那边需要主权者放行 ⇒ 子实例拿到的是 confirm，
 *     不能用自己的 allow 绕过；
 *  ④ **模型关不掉**：调用方在 context 里传「父判/面求值」之类键，不能跳过父判；
 *  ⑤ **不递归**：委派链只判一层（父的父不参与），不会从子判里长出孙授权；
 *  ⑥ **历史残余**：没有 `委派者` 记录的旧实例不做父判（明确缺口，不猜）。
 *
 * 实现位置：`src/policy.js` 的 `#受控父判`（判定唯一落点）+ `src/registry.js` 的
 * `#委派者事实`（`registry_assign` 时钉 `{id, kind, 卡版本}`）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeFixture, writeUnder } from './helpers.mjs';
import { Org } from '../src/org.js';
import { Denied, NeedsApproval } from '../src/kernel/errors.js';

const P = 'proj-w5-parent';

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

/** 私有权限矩阵（唯一真源里那条 policy 块；grant 的 subject 是主体种类）。 */
function 矩阵(grants) {
  return [
    '---', 'id: 权限矩阵', 'kind: 规则', 'authority: 法律', 'zone: 私有', 'domain: 集体', 'version: 1', '---',
    '# 权限矩阵', '', '## 三档门槛', '你定的 > 组织定的。', '',
    '```policy', JSON.stringify({ grants }, null, 2), '```', '',
  ].join('\n');
}

async function 起组织(选项 = {}) {
  // ⑥ 历史残余用例要「真·无委派父」的旧实例：显式 legacyMembers，别让默认真钉把它补成合法态。
  const f = await makeFixture(选项.legacyMembers ? { legacyMembers: true } : {});
  for (const id of ['插件工程', 'Lead', '复核员']) {
    await writeUnder(f.privateRoot, `集体L3-成员角色卡/${id}.md`, 岗位卡(id));
  }
  if (选项.grants) await writeUnder(f.privateRoot, '集体L1-法律/权限矩阵.md', 矩阵(选项.grants));
  if (选项.members) {
    await writeUnder(f.privateRoot, '身份档案/identity.json', `${JSON.stringify({
      members: 选项.members,
      sovereign: { lastInteraction: new Date().toISOString() },
      denylist: [],
    }, null, 2)}\n`);
  }
  const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
  return { f, org };
}

/** 起一个主会话 Lead 实例 + 它委派的一名成员，并给成员一个「名下已派发」的节点。 */
async function 委派一人(org, { 实例 = 'm-1', 主 = 'lead-1' } = {}) {
  await org.registry.ensureLeadInstance({ 实例: 主, 代次: { 代: 'gen-test', pid: process.pid } });
  await org.registry.assign({ subject: { id: 主, kind: 'Lead', roleId: 'Lead' }, 岗位: '插件工程', 实例 });
  const 新建 = await org.tasks.create({ subject: { id: 主, kind: 'Lead', roleId: 'Lead' }, 项目: P, 描述: `父判-${实例}`, 负责人: '插件工程', 判据: ['x'] });
  // 用 dispatch 的返回值（已派发的节点投影）当任务上下文——拿 create 的旧投影会一直显示「待派发」。
  const node = await org.tasks.dispatch(新建.id, { subject: { id: 主, kind: 'Lead', roleId: 'Lead' }, 项目: P });
  return { node, 成员: { id: 实例, kind: '成员', roleId: '插件工程' }, 主 };
}

describe('① 正常委派：父有该权 ⇒ 成员任务内照常写', () => {
  it('写入成功，且实例绑定上钉着真实委派者（id/kind/卡版本）', async () => {
    const { f, org } = await 起组织();
    try {
      const { node, 成员, 主 } = await 委派一人(org);
      const 开 = await org.tasks.start(node.id, { subject: 成员, 项目: P });
      assert.equal(开.状态, '执行中', '正常委派不受父判影响');

      const 记 = (await org.registry.identity()).members['m-1'];
      assert.equal(记.委派者.id, 主, '委派者 id = 真实登记主体');
      assert.equal(记.委派者.kind, 'Lead', '委派者 kind');
      assert.equal(记.委派者.卡版本, (await org.registry.cardOf(主)).卡版本.摘要, '委派者卡版本 = 它出生时钉住的那一版');
    } finally { await f.cleanup(); }
  });
});

describe('② 只给成员的 grant 越不过父判', () => {
  it('权限矩阵：成员 allow + Lead deny ⇒ 成员那一格被父判拒；去掉 Lead 的 deny ⇒ 放行', async () => {
    const 只给成员 = [
      // 记忆写入在服务层的动作是 `create`（只增账本），grant 要按真实动作写——按别的动作写
      // 就测不到这条判据（本文件第一次就是栽在 action 写错上）。
      { subject: 'Lead', action: 'create', kind: '经历', verdict: 'deny', reason: '父判测试：Lead 无此写权' },
      { subject: '成员', action: 'create', kind: '经历', verdict: 'allow', reason: '父判测试：只给成员' },
    ];
    const a = await 起组织({ grants: 只给成员 });
    try {
      const { node, 成员 } = await 委派一人(a.org);
      await assert.rejects(
        () => a.org.memory.remember({ subject: 成员, 类: '经历', 内容: '父判应该拦住我', 来源: '测试', 任务: node, 项目: P }),
        (e) => e instanceof Denied && /受控父判/.test(e.rule),
        '子实例有 allow grant，但委派者没有这个权 ⇒ 拒',
      );
      const 拒 = await a.org.policy.decide({
        subject: 成员, action: 'create',
        target: { id: 'mem-x', kind: '经历', authority: '自治', zone: '私有', project: P },
        context: { task: node, 类: '经历' },
      });
      assert.equal(拒.verdict, 'deny');
      assert.match(拒.rule, /受控父判/);
      assert.equal(拒.detail.委派者, 'lead-1', '拒因点名委派者');
      assert.match(String(拒.detail.父判规则), /grant/, '把父判命中的那条规则原样带出');
    } finally { await a.f.cleanup(); }

    // 对照：不给 Lead 那条 deny ⇒ 同一动作放行（证明上一条的红是父判造成的，不是别的闸）。
    const b = await 起组织({ grants: [{ subject: '成员', action: 'create', kind: '经历', verdict: 'allow', reason: '只给成员' }] });
    try {
      const { node, 成员 } = await 委派一人(b.org);
      const 记 = await b.org.memory.remember({ subject: 成员, 类: '经历', 内容: '对照：父也没有 deny', 来源: '测试', 任务: node, 项目: P });
      assert.ok(记?.id, '对照臂必须落盘成功');
    } finally { await b.f.cleanup(); }
  });
});

describe('③ 父判 confirm 门槛传播：子不得用自己的 allow 绕过', () => {
  it('权限矩阵给 Lead 的「写任务」confirm ⇒ 成员 start 拿到 confirm（不是 allow）', async () => {
    const { f, org } = await 起组织({ grants: [{ subject: 'Lead', action: 'write', kind: '任务', verdict: 'confirm', reason: '父判测试：Lead 写任务需主权者放行' }] });
    try {
      const { node, 成员 } = await 委派一人(org);
      await assert.rejects(
        () => org.tasks.start(node.id, { subject: 成员, 项目: P }),
        (e) => e instanceof NeedsApproval && /父判确认门槛传播/.test(e.rule),
        '父判 confirm ⇒ 子也 confirm：确认门槛不能被 allow 绕过',
      );
      const 判 = await org.policy.decide({
        subject: 成员, action: 'write',
        target: { id: node.id, kind: '任务', authority: '自治', zone: '私有', project: P },
        context: { task: node, 节点操作: 'start' },
      });
      assert.equal(判.verdict, 'confirm');
      assert.equal(判.requireAuthority, '主权者');
    } finally { await f.cleanup(); }
  });
});

describe('④ 模型关不掉父判（闸在私有字段，不由 context 开合）', () => {
  it('context 里塞 父判/面求值 之类键 ⇒ 照样拒', async () => {
    const { f, org } = await 起组织({ grants: [
      { subject: 'Lead', action: 'create', kind: '经历', verdict: 'deny', reason: '父判测试：Lead 无此写权' },
      { subject: '成员', action: 'create', kind: '经历', verdict: 'allow' },
    ] });
    try {
      const { node, 成员 } = await 委派一人(org);
      for (const 伪造 of [{ 父判: true }, { 面求值: true }, { 父判: true, 面求值: true, 跳过父判: true }]) {
        const 判 = await org.policy.decide({
          subject: 成员, action: 'create',
          target: { id: 'mem-x', kind: '经历', authority: '自治', zone: '私有', project: P },
          context: { task: node, 类: '经历', ...伪造 },
        });
        assert.equal(判.verdict, 'deny', `伪造 ${JSON.stringify(伪造)} 不得绕过父判`);
        assert.match(判.rule, /受控父判/);
      }
    } finally { await f.cleanup(); }
  });
});

describe('⑤ 不递归：委派链只判一层，不会长出孙授权', () => {
  it('成员的委派者本身还有委派者 ⇒ 第二层不参与（否则这里会被拒）', async () => {
    const { f, org } = await 起组织();
    try {
      // 真凭证：两人都经 Lead 正规登记（真卡版本 + 真委派者），再把链改成「A→B→未知」。
      await org.registry.ensureLeadInstance({ 实例: 'lead-x', 代次: { 代: 'gen-test', pid: process.pid } });
      const 主 = { id: 'lead-x', kind: 'Lead', roleId: 'Lead' };
      await org.registry.assign({ subject: 主, 岗位: '插件工程', 实例: 'member-a' });
      await org.registry.assign({ subject: 主, 岗位: '插件工程', 实例: 'member-b' });
      const doc = JSON.parse(await readFile(f.layout.identityFile(), 'utf8'));
      doc.members['member-a'].委派者 = { id: 'member-b', kind: '成员', 卡版本: doc.members['member-b'].卡版本.摘要 };
      doc.members['member-b'].委派者 = { id: 'ghost', kind: '未知', 卡版本: null };
      await writeUnder(f.privateRoot, '身份档案/identity.json', `${JSON.stringify(doc, null, 2)}\n`);
      await org.policy.reload();
      const 新建 = await org.tasks.create({ subject: 主, 项目: P, 描述: '父判-不递归', 负责人: '插件工程', 判据: ['x'] });
      const node = await org.tasks.dispatch(新建.id, { subject: 主, 项目: P });
      const 判 = await org.policy.decide({
        subject: { id: 'member-a', kind: '成员', roleId: '插件工程' }, action: 'write',
        target: { id: node.id, kind: '任务', authority: '自治', zone: '私有', project: P },
        context: { task: node },
      });
      assert.equal(判.verdict, 'allow', '只判一层：父的父（未知主体）不参与本判');
    } finally { await f.cleanup(); }
  });
});

describe('⑦ 绑定接线（真事件，不是自证字段）：assign 不带节点 → task_bind → registry.sync', () => {
  it('索引里的 绑定时/绑定节点/绑定项目/绑定岗位 来自 bound 事件；岗位负责人不被当成实例键', async () => {
    const { f, org } = await 起组织();
    try {
      // 关键：assign **不带节点**（W5 之前唯一路径），绑定只经 task_bind 落事件。
      const 主 = 'lead-1';
      await org.registry.ensureLeadInstance({ 实例: 主, 代次: { 代: 'gen-test', pid: process.pid } });
      await org.registry.assign({ subject: { id: 主, kind: 'Lead', roleId: 'Lead' }, 岗位: '插件工程', 实例: 'm-1' });
      const 建 = await org.tasks.create({ subject: { id: 主, kind: 'Lead', roleId: 'Lead' }, 项目: P, 描述: '绑定接线', 负责人: '插件工程', 判据: ['x'] });
      const node = await org.tasks.dispatch(建.id, { subject: { id: 主, kind: 'Lead', roleId: 'Lead' }, 项目: P });
      await org.tasks.bind(node.id, { subject: { id: 主, kind: 'Lead', roleId: 'Lead' }, 项目: P, 实例: 'm-1', 岗位: '插件工程' });

      const 前 = (await org.registry.identity()).members['m-1'].生命周期 ?? {};
      assert.equal(前.绑定节点, undefined, '前提：assign 不带节点 ⇒ 身份档案里没有绑定字段（旧路径的真实形态）');

      await org.registry.sync();
      const index = JSON.parse(await readFile(f.layout.registryFile(), 'utf8'));
      const 生 = index.实例['m-1'].生命周期;
      assert.equal(生.绑定节点, node.id, '绑定节点来自 bound 事件');
      assert.ok(生.绑定时, '绑定时来自 bound 事件');
      assert.equal(生.绑定项目, P, '绑定项目要落真实项目（项目墙/审计读域要用）');
      assert.equal(生.绑定岗位, '插件工程', '绑定岗位来自 bound 事件');

      // 岗位名不是实例键：索引里不该出现名为「插件工程」的实例行。
      assert.equal(index.实例['插件工程'], undefined, '岗位负责人不能被当成实例记进索引');
    } finally { await f.cleanup(); }
  });
});

describe('⑧ 父判的父也要过条目10 写前闸（父 Lead 封存/未钉 ⇒ 子写不了）', () => {
  it('委派者是未钉版 Lead ⇒ 子实例的写被父判拒，且拒因点名条目10', async () => {
    const { f, org } = await 起组织();
    try {
      // 先用合法 Lead 把子实例正规登记（真卡版本），再把它的委派者改成一个「在岗但未钉版」的 Lead。
      await org.registry.ensureLeadInstance({ 实例: 'lead-ok', 代次: { 代: 'gen-test', pid: process.pid } });
      const 主 = { id: 'lead-ok', kind: 'Lead', roleId: 'Lead' };
      await org.registry.assign({ subject: 主, 岗位: '插件工程', 实例: 'm-unpinned' });
      const doc = JSON.parse(await readFile(f.layout.identityFile(), 'utf8'));
      doc.members['lead-nopin'] = { id: 'lead-nopin', 岗位: 'Lead', 代: 1, status: '在岗' };
      doc.members['m-unpinned'].委派者 = { id: 'lead-nopin', kind: 'Lead', 卡版本: null };
      await writeUnder(f.privateRoot, '身份档案/identity.json', `${JSON.stringify(doc, null, 2)}\n`);
      await org.policy.reload();
      const 新建 = await org.tasks.create({ subject: 主, 项目: P, 描述: '父判-父未钉', 负责人: '插件工程', 判据: ['x'] });
      const node = await org.tasks.dispatch(新建.id, { subject: 主, 项目: P });

      const 判 = await org.policy.decide({
        subject: { id: 'm-unpinned', kind: '成员', roleId: '插件工程' }, action: 'write',
        target: { id: node.id, kind: '任务', authority: '自治', zone: '私有', project: P },
        context: { task: node },
      });
      assert.equal(判.verdict, 'deny', '父 Lead 未过写前闸 ⇒ 子也写不了');
      assert.match(判.rule, /受控父判/);
      assert.match(String(判.detail.父判规则), /条目10/, '父判命中的是条目10 的写前闸');
    } finally { await f.cleanup(); }
  });
});

describe('⑥ 历史残余：缺委派归属的旧实例 ⇒ **写拒、只读允许**（不再永久豁免）', () => {
  it('夹具里的 legacy 成员（无委派者）写动作被凭证闸拒；读照旧', async () => {
    const { f, org } = await 起组织({ legacyMembers: true });
    try {
      // 先给 legacy 成员正规补登（真卡版本），再只抹掉委派归属 ⇒ 精确命中「缺委派归属」。
      await org.registry.ensureLeadInstance({ 实例: 'lead-x', 代次: { 代: 'gen-test', pid: process.pid } });
      await org.registry.assign({ subject: { id: 'lead-x', kind: 'Lead', roleId: 'Lead' }, 岗位: '插件工程', 实例: 'member-a' });
      const doc = JSON.parse(await readFile(f.layout.identityFile(), 'utf8'));
      delete doc.members['member-a'].委派者;
      await writeUnder(f.privateRoot, '身份档案/identity.json', `${JSON.stringify(doc, null, 2)}\n`);
      await org.policy.reload();
      const 旧 = (await org.registry.identity()).members['member-a'];
      assert.equal(旧.委派者, undefined, '前提：缺委派归属');
      assert.equal(旧.status, '在岗', '前提：不判死、仍在岗');
      const 新建 = await org.tasks.create({ subject: { id: 'lead-x', kind: 'Lead', roleId: 'Lead' }, 项目: P, 描述: '父判-历史', 负责人: '插件工程', 判据: ['x'] });
      const node = await org.tasks.dispatch(新建.id, { subject: { id: 'lead-x', kind: 'Lead', roleId: 'Lead' }, 项目: P });
      const 写 = await org.policy.decide({
        subject: { id: 'member-a', kind: '成员', roleId: '插件工程' }, action: 'write',
        target: { id: node.id, kind: '任务', authority: '自治', zone: '私有', project: P },
        context: { task: node },
      });
      assert.equal(写.verdict, 'deny', '缺委派归属 ⇒ 新写拒（不是永久豁免）');
      assert.match(写.rule, /缺委派归属/);
      const 读 = await org.policy.decide({
        subject: { id: 'member-a', kind: '成员', roleId: '插件工程' }, action: 'read',
        target: { id: node.id, kind: '任务', authority: '自治', zone: '私有', project: P },
        context: { task: node },
      });
      assert.equal(读.verdict, 'allow', '只读域照旧');
    } finally { await f.cleanup(); }
  });
});
