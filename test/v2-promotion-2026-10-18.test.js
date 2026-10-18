/**
 * 补修E · 知识候选晋升与结账闭合（v2 口述收敛 2026-10-18 条目15/16/22）。
 *
 * 钉六件事：
 *  ① 结账的「晋升」= 真实知识条目（可回溯来源引用 + 审计 + 节点 记忆晋升 映射），不是
 *    只把处置字符串记进事件（不许假结账）。
 *  ② 适用岗位按来源推导：交卷人的档案岗位 / 经历条目岗位 / 任务负责人里的在册岗位，
 *    绝不贴成恰好干活的记忆整理岗；岗位能被 memory_query 实际召回。
 *  ③ 受限晋升只给**真实登记在岗**的记忆整理岗：绑着本实例的执行中任务 + 同项目已采纳来源
 *    + 双标签。普通成员、自报 roleId、未绑定任务、未采纳来源一律拒且无知识副作用。
 *  ④ 幂等：幂等键带来源项目 + 来源任务 + 候选键；同键重试返回旧条目、不重复产知识；
 *    同键换业务参数（岗位/内容/标题）响亮拒，节点不结账（保留「待结账」追踪）。
 *  ⑤ 「通用」= 公共命名空间（不是另一个真实项目）：Lead/记忆整理可落笔，披露/来源/审计
 *    同款；普通成员仍拒；成员跨项目总闸一字未动。
 *  ⑥ 复核读域可见：晋升产出的知识与「知识晋升」审计行对正牌复核实例可见。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, LEAD, MEMBER, REVIEWER } from './helpers.mjs';
import { Org } from '../src/org.js';
import { runAction } from '../lib/actions.js';
import { Denied, InvalidBody } from '../src/kernel/errors.js';

const P = 'proj-v2promo';
const 记忆整理 = { id: 'curator', kind: '成员', roleId: '记忆整理' };

/** 记忆整理岗最小卡（与夹具同形状；不复制产品正文，只保证结构合规）。 */
const 记忆整理卡 = `---
id: 记忆整理
kind: 身份
authority: 自治
zone: 出厂
domain: 个体
version: 1
---

# 记忆整理

## 个体L0 · 身份核心

我是记忆整理。

### 身份核心

锁定段。

## 个体L1 · 规则

1. 只追加。

## 个体L2 · 能力引用

- \`policy-decision\`

## 个体L3 · 经验引用

### 占位
`;

/** 夹具身份表：默认成员 + 一个真实登记的记忆整理实例（由 makeFixture 的 Registry 钉版）。 */
const 成员表 = {
  'member-a': { id: 'member-a', 岗位: '插件工程', 代: 1, status: '在岗' },
  'member-b': { id: 'member-b', 岗位: '插件工程', 代: 1, status: '在岗' },
  reviewer: { id: 'reviewer', 岗位: '复核员', 代: 1, status: '在岗' },
  curator: { id: 'curator', 岗位: '记忆整理', 代: 1, status: '在岗' },
};

async function 起组织() {
  const f = await makeFixture({
    rules: { '集体L3-成员角色卡/记忆整理.md': 记忆整理卡 },
    members: 成员表,
  });
  const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
  return { f, org };
}

/** 建一个 member-a 名下的执行中节点（成员写经历/候选的任务上下文）。 */
async function 成员节点(org, 描述 = '补修E-成员任务') {
  const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述, 负责人: 'member-a', 判据: ['x'] });
  await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
  return org.tasks.start(node.id, { subject: MEMBER, 项目: P });
}

/** 建一个绑定 curator、处于执行中的蒸馏任务（记忆整理岗的「任务内全权」凭据）。 */
async function 蒸馏任务(org, { 绑定 = true, 开工 = true } = {}) {
  const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '蒸馏来源任务的经验', 负责人: '记忆整理', 判据: ['x'] });
  if (绑定) await org.tasks.bind(node.id, { subject: LEAD, 项目: P, 实例: 'curator', 岗位: '记忆整理' });
  await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
  if (开工) await org.tasks.start(node.id, { subject: 记忆整理, 项目: P });
  return node.id;
}

/** 建「复核任务 → 显式复核对象」关联（v2 条目6：复核员的读域来源）。 */
async function 建复核关联(org, 目标id) {
  const 复核任务 = await org.tasks.create({ subject: LEAD, 项目: P, 描述: `复核-${目标id}`, 负责人: ['复核员'], 判据: ['核对'], 复核对象: [目标id] });
  await org.tasks.bind(复核任务.id, { subject: LEAD, 项目: P, 实例: 'reviewer', 岗位: '复核员' });
  await org.tasks.dispatch(复核任务.id, { subject: LEAD, 项目: P });
  return 复核任务.id;
}

/** 把一个执行中节点推到「已采纳」（真复核出票 + Lead 显式采纳），返回节点与可选经历条目。 */
async function 已采纳节点(org, { 知识候选 = [], 经历 = null } = {}) {
  const node = await 成员节点(org);
  let 经历条目 = null;
  if (经历) {
    经历条目 = await org.memory.remember({ subject: MEMBER, 类: '经历', 内容: 经历, 来源: '测试', 项目: P, 任务: node, 来源引用: [node.id] });
  }
  await org.tasks.submit(node.id, { subject: MEMBER, 项目: P, 结论: '交卷', 知识候选 });
  await 建复核关联(org, node.id);
  const 核 = await org.tasks.review(node.id, { subject: REVIEWER, 项目: P, 三态: '过', 分歧清单: [] });
  await org.tasks.accept(node.id, { subject: LEAD, 项目: P, 票: 核.待采纳?.票 });
  return { node, 经历条目 };
}

/** 读一条知识（同一项目账本，Lead 读者）。 */
async function 读知识(org, id) {
  return (await org.memory.query({ subject: LEAD, 类: '知识', 项目: P, 读者: LEAD })).条目.find((e) => e.id === id) ?? null;
}

describe('① 结账晋升 = 真实知识产物', () => {
  it('晋升产出可回溯知识条目（来源引用/岗位/审计/节点记忆晋升），不是只记处置字符串', async () => {
    const { f, org } = await 起组织();
    try {
      const { node, 经历条目 } = await 已采纳节点(org, { 知识候选: ['这个坑值得蒸馏'], 经历: '执行中踩的坑' });
      const 键 = `候选/${MEMBER.id}/0`;
      const settled = await org.tasks.settle(node.id, {
        subject: LEAD, 项目: P,
        记忆处置: {
          [经历条目.id]: '留账本',
          [键]: { 处置: '晋升', 岗位: '插件工程', 内容: '蒸馏后的可复用知识' },
        },
      });
      assert.equal(settled.状态, '已结账');
      const 知识id = settled.记忆晋升?.[键];
      assert.ok(知识id, '结账事件折回晋升产出的真实知识 id');
      const 知识 = await 读知识(org, 知识id);
      assert.ok(知识, '知识库里真的有这条');
      assert.equal(知识.内容, '蒸馏后的可复用知识');
      assert.equal(知识.岗位, '插件工程', '知识双标签：岗位');
      assert.equal(知识.项目, P, '知识双标签：项目');
      assert.ok((知识.来源引用 ?? []).includes(node.id), '来源引用可回溯到已采纳任务');
      const 晋升审计 = (await org.audit.read({})).filter((row) => row.动作 === '知识晋升' && row.详情?.知识 === 知识id);
      assert.equal(晋升审计.length, 1, '晋升动作入审计（可追溯）');
      assert.equal(晋升审计[0].对象.id, node.id, '审计对象记来源任务（复核读域按对象裁剪）');
      const 血缘 = await org.memory.lineage({ subject: LEAD, id: 知识id });
      assert.ok(血缘.上游.some((x) => x.id === node.id), '知识血缘上游可追到来源任务');
    } finally { await f.cleanup(); }
  });

  it('缺省适用岗位按来源推导（交卷人档案岗位），并按岗位真实可召回', async () => {
    const { f, org } = await 起组织();
    try {
      const { node } = await 已采纳节点(org, { 知识候选: ['默认岗位推导'] });
      const 键 = `候选/${MEMBER.id}/0`;
      const settled = await org.tasks.settle(node.id, { subject: LEAD, 项目: P, 记忆处置: { [键]: '晋升' } });
      const 知识id = settled.记忆晋升?.[键];
      const 知识 = await 读知识(org, 知识id);
      assert.equal(知识.岗位, '插件工程', '默认取交卷人的档案岗位，不贴记忆整理岗');
      assert.equal(知识.内容, '默认岗位推导', '缺省内容 = 交卷候选正文');
      const 召回 = await org.memory.query({ subject: LEAD, 类: '知识', 项目: P, 岗位: '插件工程', 文本: '默认岗位' });
      assert.ok(召回.命中.some((e) => e.id === 知识id), '岗位标签让适用岗位实际召回');
    } finally { await f.cleanup(); }
  });
});

describe('② 记忆整理受限晋升', () => {
  it('真实登记的记忆整理岗：同项目已采纳来源 + 绑定执行中任务 ⇒ 落真实知识；重试幂等', async () => {
    const { f, org } = await 起组织();
    try {
      const { node: 来源, 经历条目 } = await 已采纳节点(org, { 经历: '来源任务里踩的坑' });
      const 蒸馏 = await 蒸馏任务(org);
      const 写 = () => runAction({
        org, 项目: P, subject: 记忆整理, 主体: 记忆整理,
        args: {
          action: 'memory_write', 类: '知识', 内容: '从来源任务蒸馏的岗经验', 来源: '已采纳来源蒸馏',
          岗位: '插件工程', 任务: 蒸馏, 来源引用: [来源.id, 经历条目.id],
        },
      });
      const 第一次 = await 写();
      const 知识id = 第一次.条目.id;
      assert.ok(知识id);
      const 知识 = await 读知识(org, 知识id);
      assert.equal(知识.内容, '从来源任务蒸馏的岗经验');
      assert.equal(知识.岗位, '插件工程');
      assert.ok((知识.来源引用 ?? []).includes(来源.id), '来源引用挂已采纳任务');
      const 审计 = (await org.audit.read({})).filter((row) => row.动作 === '知识晋升' && row.详情?.知识 === 知识id);
      assert.equal(审计.length, 1);
      assert.equal(审计[0].项目, P, '审计项目 = 来源项目（复核读域同项目口径）');

      // 同输入重试：幂等命中，不重复产知识。
      const 第二次 = await 写();
      assert.equal(第二次.条目.id, 知识id, '重试认回同一条知识');
      assert.equal(第二次.条目.幂等命中, true);
      const 同内容 = (await org.memory.query({ subject: LEAD, 类: '知识', 项目: P, 读者: LEAD })).条目.filter((e) => e.内容 === '从来源任务蒸馏的岗经验');
      assert.equal(同内容.length, 1, '重复调用不重复产知识');
    } finally { await f.cleanup(); }
  });

  it('普通成员 / 自报 roleId / 未绑定任务 / 非执行中 / 未采纳来源 ⇒ 全拒且无知识副作用', async () => {
    const { f, org } = await 起组织();
    try {
      const { node: 来源, 经历条目 } = await 已采纳节点(org, { 经历: '可蒸馏的来源' });
      const 蒸馏 = await 蒸馏任务(org);
      const 知识数 = async () => (await org.memory.query({ subject: LEAD, 类: '知识', 项目: P, 读者: LEAD })).条目.length;
      const 基线 = await 知识数();

      // ① 普通成员（插件工程）经动作层写知识 ⇒ 拒（受限晋升只给记忆整理）。
      const 成员任务 = await 成员节点(org);
      await assert.rejects(
        () => runAction({ org, 项目: P, subject: MEMBER, 主体: MEMBER, args: { action: 'memory_write', 类: '知识', 内容: 'x', 来源: '测试', 岗位: '插件工程', 任务: 成员任务.id, 来源引用: [来源.id] } }),
        (e) => e instanceof Denied && /记忆整理岗/.test(e.rule + e.message),
      );

      // ② 自报 roleId：档案是插件工程，直调服务层也不许（真实岗位以档案为准）。
      await assert.rejects(
        () => org.memory.promoteFromAdopted({ subject: { id: 'member-a', kind: '成员', roleId: '记忆整理' }, 项目: P, 岗位: '插件工程', 内容: 'x', 来源: '测试', 晋升: { 来源任务: 来源.id, 候选键: 'k1', 执行任务: 蒸馏 } }),
        (e) => e instanceof Denied && /真实登记/.test(e.rule),
      );
      // 直调 remember 同样被服务层闸拦：哪怕是记忆整理岗、任务上下文齐全，也没有
      // 「直接写知识」的通道（唯一入口是受限晋升 promoteFromAdopted）。
      const 蒸馏节点 = await org.tasks.get(蒸馏, { 项目: P });
      await assert.rejects(
        () => org.memory.remember({ subject: 记忆整理, 类: '知识', 内容: 'x', 来源: '测试', 项目: P, 岗位: '插件工程', 任务: 蒸馏节点 }),
        (e) => e instanceof Denied && /知识是晋升动作/.test(e.rule),
      );

      // ③ 任务没绑定本实例 ⇒ 拒（负责人写岗位名不算真实绑定）。
      const 没绑定 = await 蒸馏任务(org, { 绑定: false, 开工: false });
      await assert.rejects(
        () => runAction({ org, 项目: P, subject: 记忆整理, 主体: 记忆整理, args: { action: 'memory_write', 类: '知识', 内容: 'x', 来源: '测试', 岗位: '插件工程', 任务: 没绑定, 来源引用: [来源.id] } }),
        (e) => e instanceof Denied && /没绑定本实例/.test(e.rule),
      );

      // ④ 任务不在执行中（已派发） ⇒ 拒。
      const 未开工 = await 蒸馏任务(org, { 开工: false });
      await assert.rejects(
        () => runAction({ org, 项目: P, subject: 记忆整理, 主体: 记忆整理, args: { action: 'memory_write', 类: '知识', 内容: 'x', 来源: '测试', 岗位: '插件工程', 任务: 未开工, 来源引用: [来源.id] } }),
        (e) => e instanceof Denied && /不在执行中/.test(e.rule),
      );

      // ⑤ 来源任务未合法采纳（执行中） ⇒ 拒，且没有知识副作用。
      const 未采纳 = await 成员节点(org, '未采纳来源');
      await assert.rejects(
        () => runAction({ org, 项目: P, subject: 记忆整理, 主体: 记忆整理, args: { action: 'memory_write', 类: '知识', 内容: 'x', 来源: '测试', 岗位: '插件工程', 任务: 蒸馏, 来源引用: [未采纳.id] } }),
        (e) => e instanceof Denied && /未被合法采纳/.test(e.rule),
      );
      assert.equal(await 知识数(), 基线, '全部拒绝分支没有留下知识条目');

      // ⑥ 复核员只读不写知识：服务层不再豁免复核员（直调也拒）。
      await assert.rejects(
        () => org.memory.remember({ subject: REVIEWER, 类: '知识', 内容: 'x', 来源: '测试', 项目: P }),
        (e) => e instanceof Denied,
      );
      // 正对照：同一条来源、同一条任务，记忆整理岗能晋升（证明拒绝来自主体/来源判定，不是环境）。
      const 正 = await runAction({ org, 项目: P, subject: 记忆整理, 主体: 记忆整理, args: { action: 'memory_write', 类: '知识', 内容: '正对照', 来源: '测试', 岗位: '插件工程', 任务: 蒸馏, 来源引用: [来源.id, 经历条目.id] } });
      assert.ok(正.条目.id);
    } finally { await f.cleanup(); }
  });
});

describe('③ 幂等与失败窗口', () => {
  it('知识写成功后结账失败：节点不结账（待结账仍可见），重试认回同一条知识', async () => {
    const { f, org } = await 起组织();
    try {
      const { node } = await 已采纳节点(org, { 知识候选: ['写成功后后续失败'] });
      const 键 = `候选/${MEMBER.id}/0`;
      const 原归档 = org.memory.archiveAnswers.bind(org.memory);
      let 次数 = 0;
      org.memory.archiveAnswers = async (spec) => {
        次数 += 1;
        if (次数 === 1) throw new Error('模拟结账后段失败');
        return 原归档(spec);
      };
      await assert.rejects(() => org.tasks.settle(node.id, { subject: LEAD, 项目: P, 记忆处置: { [键]: '晋升' } }), /模拟结账后段失败/);
      const 现状 = await org.tasks.get(node.id, { 项目: P });
      assert.equal(现状.状态, '已采纳', '结账没落线：不许假结账');
      const 待结账 = (await org.workbench({ 项目: P })).待你决定.find((x) => x.类型 === '待结账' && x.节点 === node.id);
      assert.ok(待结账, '未结账的节点仍被工作台追踪');
      const 一次产物 = (await org.memory.query({ subject: LEAD, 类: '知识', 项目: P, 读者: LEAD })).条目.filter((e) => e.内容 === '写成功后后续失败');
      assert.equal(一次产物.length, 1, '知识已真实产出（不是假晋升）');

      org.memory.archiveAnswers = 原归档;
      const settled = await org.tasks.settle(node.id, { subject: LEAD, 项目: P, 记忆处置: { [键]: '晋升' } });
      assert.equal(settled.状态, '已结账');
      assert.equal(settled.记忆晋升[键], 一次产物[0].id, '重试认回同一条知识 id');
      const 两次产物 = (await org.memory.query({ subject: LEAD, 类: '知识', 项目: P, 读者: LEAD })).条目.filter((e) => e.内容 === '写成功后后续失败');
      assert.equal(两次产物.length, 1, '重试不重复产知识');
    } finally { await f.cleanup(); }
  });

  it('同幂等键换了业务参数 ⇒ 响亮拒且不结账（旧知识不冒充本次内容）', async () => {
    const { f, org } = await 起组织();
    try {
      const { node } = await 已采纳节点(org, { 知识候选: ['同键换参数'] });
      const 键 = `候选/${MEMBER.id}/0`;
      // 先落一条同幂等键、不同岗位的知识（模拟上一次晋升的参数）。
      await org.memory.promoteFromAdopted({
        subject: LEAD, 项目: P, 岗位: '文档整理', 内容: '同键换参数', 标题: '同键换参数', 来源: '预写',
        晋升: { 来源任务: node.id, 候选键: 键 },
      });
      await assert.rejects(
        () => org.tasks.settle(node.id, { subject: LEAD, 项目: P, 记忆处置: { [键]: '晋升' } }),
        (e) => e instanceof Denied && /幂等键/.test(e.rule),
      );
      assert.equal((await org.tasks.get(node.id, { 项目: P })).状态, '已采纳', '失败不结账');
      assert.equal((await org.memory.query({ subject: LEAD, 类: '知识', 项目: P, 读者: LEAD })).条目.filter((e) => e.内容 === '同键换参数').length, 1, '没有产第二条');
    } finally { await f.cleanup(); }
  });
});

describe('④ 「通用」公共命名空间', () => {
  it('记忆整理经命名空间写通用：真实产物 + 来源/披露/审计同款；普通成员仍拒', async () => {
    const { f, org } = await 起组织();
    try {
      const { node: 来源, 经历条目 } = await 已采纳节点(org, { 经历: '可公开的坑' });
      const 蒸馏 = await 蒸馏任务(org);
      const 写 = (内容 = '项目无关的公共知识') => runAction({
        org, 项目: P, subject: 记忆整理, 主体: 记忆整理,
        args: { action: 'memory_write', 类: '知识', 内容, 来源: '同项目已采纳来源', 岗位: '插件工程', 任务: 蒸馏, 来源引用: [来源.id, 经历条目.id], 命名空间: '通用' },
      });
      const 结果 = await 写();
      assert.equal(结果.条目.项目, '通用', '存储命名空间 = 通用');
      assert.equal(结果.条目.归属, '跨项目', '落在跨项目账（公共面）');
      const 知识 = (await org.memory.query({ subject: LEAD, 类: '知识', 项目: '通用', 读者: LEAD })).条目.find((e) => e.id === 结果.条目.id);
      assert.ok(知识, '通用账里能查到');
      const 审计 = (await org.audit.read({})).filter((row) => row.动作 === '知识晋升' && row.详情?.知识 === 结果.条目.id);
      assert.equal(审计.at(-1).项目, P, '审计项目 = 来源项目（不因存储命名空间而漂）');
      assert.equal(审计.at(-1).详情.存储项目, '通用');

      // 普通成员写通用：知识写入闸照拒（没有为成员开跨项目例外）。
      const 成员任务 = await 成员节点(org);
      await assert.rejects(
        () => runAction({ org, 项目: P, subject: MEMBER, 主体: MEMBER, args: { action: 'memory_write', 类: '知识', 内容: 'x', 来源: '测试', 岗位: '插件工程', 任务: 成员任务.id, 来源引用: [来源.id], 命名空间: '通用' } }),
        (e) => e instanceof Denied,
      );

      // 敏感内容：披露闸照跑（拒 + 披露拦截入账）。
      await assert.rejects(() => 写('联系 someone@example.com 拿钥匙'), (e) => e instanceof Denied && /披露/.test(e.rule + e.message));
      assert.ok((await org.audit.read({})).some((row) => row.动作 === '披露拦截'), '披露拦截入账');

      // Lead 写通用：依据必填（合理落依据），带依据放行且披露照跑。
      await assert.rejects(
        () => runAction({ org, 项目: P, subject: LEAD, 主体: LEAD, args: { action: 'memory_write', 类: '知识', 内容: '公共知识', 来源: '测试', 命名空间: '通用' } }),
        (e) => e instanceof InvalidBody && /依据/.test(e.message),
      );
      const lead = await runAction({ org, 项目: P, subject: LEAD, 主体: LEAD, args: { action: 'memory_write', 类: '知识', 内容: '公共知识', 来源: '测试', 依据: '项目无关，公共可复用', 命名空间: '通用' } });
      assert.equal(lead.条目.项目, '通用');
    } finally { await f.cleanup(); }
  });
});

describe('⑤ 复核读域可见', () => {
  it('正牌复核实例能读到晋升产出的知识与「知识晋升」审计行', async () => {
    const { f, org } = await 起组织();
    try {
      const { node } = await 已采纳节点(org, { 知识候选: ['复核读域可见的知识'] });
      const 键 = `候选/${MEMBER.id}/0`;
      const settled = await org.tasks.settle(node.id, { subject: LEAD, 项目: P, 记忆处置: { [键]: '晋升' } });
      const 知识id = settled.记忆晋升[键];
      const 读 = await runAction({ org, 项目: P, subject: REVIEWER, 主体: REVIEWER, args: { action: 'memory_query', 类: '知识', 文本: '复核读域可见' } });
      assert.ok(读.结果.条目.some((e) => e.id === 知识id), '复核读域内可召回该知识');
      const 审计 = await runAction({ org, 项目: P, subject: REVIEWER, 主体: REVIEWER, args: { action: 'audit_tail', limit: 200 } });
      assert.ok(审计.审计.some((row) => row.动作 === '知识晋升' && row.详情?.知识 === 知识id), '知识晋升审计行对复核读域可见');
    } finally { await f.cleanup(); }
  });
});
