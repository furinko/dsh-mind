/**
 * v2 知识/记忆收口（口述收敛 2026-10-18 条目15/16/22）的回归网。
 *
 * 钉五件事：
 *  ① 知识 = 晋升动作：成员实例写「知识」被策略拒绝；经历/作答照常；Lead 照写。
 *  ② 结账强制记忆处置：无声明一律拒收（detail 里列候选清单）；处置必须逐条覆盖
 *    （经历 + 交卷知识候选）；「丢弃」= 追加失效；无候选传 {} 明示放行。
 *  ③ 「通用」命名空间：项目=「通用」的知识落跨项目账；披露机械检查照跑
 *    （命中即拒 + 披露拦截入账；Lead 披露豁免放行并入账）。
 *  ④ 跨项目规则：成员跨项目写/读一律拒；Lead 跨项目写依据必填、带依据放行且入条目；
 *    Lead 跨项目读放行。
 *  ⑤ 工作台兜底：已采纳未结账节点投到「待你决定」。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, LEAD, MEMBER } from './helpers.mjs';
import { Org } from '../src/org.js';
import { runAction } from '../lib/actions.js';
import { Denied, InvalidBody } from '../src/kernel/errors.js';

const P = 'proj-v2mem';

async function 起组织() {
  const f = await makeFixture();
  const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
  return { f, org };
}

/** 建一个 member-a 名下已派发且已开工的节点（成员写经历/作答的任务上下文取执行中形态）。 */
async function 成员节点(org, 描述 = 'w3-演示') {
  const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述, 负责人: 'member-a', 判据: ['x'] });
  await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
  return org.tasks.start(node.id, { subject: MEMBER, 项目: P });
}

/** 给成员复核造真实关联（v2 条目6：复核任务 + 显式复核对象）。 */
async function 建复核关联(org, 目标id) {
  const 复核任务 = await org.tasks.create({ subject: LEAD, 项目: P, 描述: `复核-${目标id}`, 负责人: ['复核员'], 判据: ['核对'], 复核对象: [目标id] });
  await org.tasks.bind(复核任务.id, { subject: LEAD, 项目: P, 实例: 'reviewer', 岗位: '复核员' });
  await org.tasks.dispatch(复核任务.id, { subject: LEAD, 项目: P });
  return 复核任务.id;
}

/** 把节点推到已采纳（member-a 交卷，reviewer 复核过 → Lead 显式采纳，补修K）。 */
async function 已采纳节点(org) {
  const node = await 成员节点(org);
  await org.tasks.submit(node.id, { subject: MEMBER, 项目: P, 结论: '交卷' });
  await 建复核关联(org, node.id);
  const 核 = await org.tasks.review(node.id, { subject: { id: 'reviewer', kind: '成员', roleId: '复核员' }, 项目: P, 三态: '过', 分歧清单: [] });
  await org.tasks.accept(node.id, { subject: LEAD, 项目: P, 票: 核.待采纳?.票 });
  return node;
}

describe('① 知识 = 晋升动作', () => {
  it('成员实例写知识 ⇒ 拒；写经历/作答 ⇒ 照常；Lead 写知识 ⇒ 照常', async () => {
    const { f, org } = await 起组织();
    try {
      const node = await 成员节点(org);
      await assert.rejects(
        () => org.memory.remember({ subject: MEMBER, 类: '知识', 内容: '成员直写知识', 来源: '测试', 项目: P, 任务: node }),
        (e) => e instanceof Denied && /知识是晋升动作/.test(e.rule),
        '成员直写知识被拦（条目15）',
      );
      const exp = await org.memory.remember({ subject: MEMBER, 类: '经历', 内容: '任务里的经历', 来源: '测试', 项目: P, 任务: node, 来源引用: [node.id] });
      assert.ok(exp.id, '经历照常');
      const ans = await org.memory.remember({ subject: MEMBER, 类: '作答', 内容: '作答', 来源: '测试', 项目: P, 任务: node });
      assert.ok(ans.id, '作答照常');
      const know = await org.memory.remember({ subject: LEAD, 类: '知识', 内容: 'Lead 落笔的知识', 来源: '测试', 项目: P });
      assert.ok(know.id, 'Lead 写知识照常');
    } finally { await f.cleanup(); }
  });
});

describe('② 结账强制记忆处置', () => {
  it('无声明 ⇒ 拒收且列出候选；逐条判 ⇒ 结账；丢弃 ⇒ 经历失效；处置折回节点', async () => {
    const { f, org } = await 起组织();
    try {
      const node = await 成员节点(org); // 执行中
      // 挂一条本任务的经历（执行中写——采纳后任务上下文就过了期）。
      const exp = await org.memory.remember({ subject: MEMBER, 类: '经历', 内容: '执行中踩的坑', 来源: '测试', 项目: P, 任务: node, 来源引用: [node.id] });
      await org.tasks.submit(node.id, { subject: MEMBER, 项目: P, 结论: '交卷', 知识候选: ['这个坑值得蒸馏'] });
      await 建复核关联(org, node.id);
      // 补修K：复核过只出票，采纳是 Lead 的独立一步（引用真票）——结账前置仍是已采纳。
      const 核 = await org.tasks.review(node.id, { subject: { id: 'reviewer', kind: '成员', roleId: '复核员' }, 项目: P, 三态: '过', 分歧清单: [] });
      await org.tasks.accept(node.id, { subject: LEAD, 项目: P, 票: 核.待采纳?.票 });
      // 无声明 ⇒ 拒收，detail 里列出两类候选。
      let 清单 = null;
      await assert.rejects(
        () => org.tasks.settle(node.id, { subject: LEAD, 项目: P }),
        (e) => {
          if (!(e instanceof Denied) || !/记忆处置/.test(e.rule)) return false;
          清单 = e.detail?.候选清单 ?? [];
          return true;
        },
        '无记忆处置声明 ⇒ 拒收',
      );
      assert.ok(清单.some((c) => c.键 === exp.id && c.类 === '经历'), '候选清单含本任务经历');
      assert.ok(清单.some((c) => c.键 === `候选/${MEMBER.id}/0` && c.类 === '交卷候选'), '候选清单含交卷知识候选');
      // 覆盖不全 ⇒ 拒（缺交卷候选那条）。
      await assert.rejects(
        () => org.tasks.settle(node.id, { subject: LEAD, 项目: P, 记忆处置: { [exp.id]: '留账本' } }),
        (e) => e instanceof InvalidBody,
      );
      // 逐条判：经历丢弃（⇒ 失效）、交卷候选晋升（补修E：真实产出知识条目，不是只记声明）。
      const settled = await org.tasks.settle(node.id, {
        subject: LEAD, 项目: P,
        记忆处置: { [exp.id]: '丢弃', [`候选/${MEMBER.id}/0`]: '晋升' },
      });
      assert.equal(settled.状态, '已结账');
      assert.deepEqual(settled.记忆处置, { [exp.id]: '丢弃', [`候选/${MEMBER.id}/0`]: '晋升' }, '处置声明折回节点');
      const 知识id = settled.记忆晋升?.[`候选/${MEMBER.id}/0`];
      assert.ok(知识id, '晋升产生真实知识条目（补修E：不留假结账）');
      const 产物 = (await org.memory.query({ subject: LEAD, 类: '知识', 项目: P, 读者: LEAD })).条目.find((e) => e.id === 知识id);
      assert.equal(产物.内容, '这个坑值得蒸馏', '缺省蒸馏正文 = 交卷知识候选');
      assert.equal(产物.岗位, '插件工程', '岗位标签按来源（交卷人档案岗位）推导');
      assert.ok((产物.来源引用 ?? []).includes(node.id), '来源引用可回溯到已采纳任务');
      const after = (await org.memory.query({ subject: LEAD, 类: '经历', 项目: P, 含失效: true, 读者: LEAD })).条目.find((e) => e.id === exp.id);
      assert.notEqual(after.状态, '有效', '丢弃 = 追加失效（召回面关掉，账本行还在）');
    } finally { await f.cleanup(); }
  });

  it('无候选的节点：传 {} 明示即放行', async () => {
    const { f, org } = await 起组织();
    try {
      const node = await 已采纳节点(org);
      const settled = await org.tasks.settle(node.id, { subject: LEAD, 项目: P, 记忆处置: {} });
      assert.equal(settled.状态, '已结账');
    } finally { await f.cleanup(); }
  });
});

describe('③ 「通用」命名空间', () => {
  it('通用知识落跨项目账；披露闸照跑（命中拒+入账；Lead 豁免放行）', async () => {
    const { f, org } = await 起组织();
    try {
      const ok = await org.memory.remember({ subject: LEAD, 类: '知识', 内容: '项目无关的通用知识', 来源: '测试', 项目: '通用' });
      assert.equal(ok.归属, '跨项目', '通用 = 跨项目账（合法住所，省晋升仪式）');
      // 披露机械检查照跑：email 命中默认清单。
      await assert.rejects(
        () => org.memory.remember({ subject: LEAD, 类: '知识', 内容: '联系 someone@example.com 拿钥匙', 来源: '测试', 项目: '通用' }),
        (e) => e instanceof Denied && /披露/.test(e.rule + e.message),
        '通用直写照样过披露闸',
      );
      const 拦截 = (await org.audit.read({})).filter((r) => r.动作 === '披露拦截');
      assert.ok(拦截.length >= 1, '拦截企图入账');
      const 豁免 = await org.memory.remember({ subject: LEAD, 类: '知识', 内容: '联系 someone@example.com 拿钥匙', 来源: '测试', 项目: '通用', 披露豁免: true });
      assert.ok(豁免.id, 'Lead 显式豁免放行');
    } finally { await f.cleanup(); }
  });
});

describe('④ 跨项目规则（runAction 层）', () => {
  it('成员跨项目写/读一律拒；Lead 跨项目写依据必填；带依据放行且入条目；Lead 跨项目读放行', async () => {
    const { f, org } = await 起组织();
    try {
      const node = await 成员节点(org);
      await assert.rejects(
        () => runAction({ org, 项目: P, subject: MEMBER, 主体: MEMBER, args: { action: 'memory_write', 类: '经历', 内容: 'x', 来源: '测试', 任务: node.id, project: 'other-proj' } }),
        (e) => e instanceof Denied && /成员禁止跨项目/.test(e.rule),
      );
      await assert.rejects(
        () => runAction({ org, 项目: P, subject: MEMBER, 主体: MEMBER, args: { action: 'memory_query', project: 'other-proj' } }),
        (e) => e instanceof Denied && /成员禁止跨项目/.test(e.rule),
      );
      await assert.rejects(
        () => runAction({ org, 项目: P, subject: LEAD, 主体: LEAD, args: { action: 'memory_write', 类: '经历', 内容: '写给别的项目', 来源: '测试', project: 'other-proj' } }),
        (e) => e instanceof InvalidBody && /依据/.test(e.message),
        'Lead 跨项目写缺依据 ⇒ 拒',
      );
      const ok = await runAction({ org, 项目: P, subject: LEAD, 主体: LEAD, args: { action: 'memory_write', 类: '经历', 内容: '写给别的项目', 来源: '测试', 依据: '那边项目复用这条排障记录', project: 'other-proj' } });
      assert.equal(ok.条目.项目, 'other-proj');
      const entry = (await org.memory.query({ subject: LEAD, 类: '经历', 项目: 'other-proj', 读者: LEAD })).条目.find((e) => e.id === ok.条目.id);
      assert.equal(entry.依据, '那边项目复用这条排障记录', '依据随条目留痕');
      const read = await runAction({ org, 项目: P, subject: LEAD, 主体: LEAD, args: { action: 'memory_query', project: 'other-proj', 文本: '排障' } });
      assert.ok(read.结果, 'Lead 跨项目读放行');
    } finally { await f.cleanup(); }
  });
});

describe('⑤ 工作台兜底：已采纳未结账投「待你决定」', () => {
  it('已采纳节点出现在待你决定并带结账命令文本；结账后消失', async () => {
    const { f, org } = await 起组织();
    try {
      const node = await 已采纳节点(org);
      const wb = await org.workbench({ 项目: P });
      const item = wb.待你决定.find((x) => x.类型 === '待结账' && x.节点 === node.id);
      assert.ok(item, '已采纳未结账 ⇒ 待你决定可见');
      assert.match(item.命令, /task_settle/);
      await org.tasks.settle(node.id, { subject: LEAD, 项目: P, 记忆处置: {} });
      const wb2 = await org.workbench({ 项目: P });
      assert.ok(!wb2.待你决定.some((x) => x.类型 === '待结账' && x.节点 === node.id), '结账后催办消失');
    } finally { await f.cleanup(); }
  });
});
