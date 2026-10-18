/**
 * 补修F · 介入度待决：请求 / 决议 / 一次性放行（v2 口述收敛 2026-10-18 条目 14/17/20/24）。
 *
 * 反例优先（verify-integrity 配方②）：每一条「通过」都配一个必须失败的坏状态——
 * 伪 Owner（模型参数造身份）、盲批（读不到完整冻结内容）、篡改记录、参数置换、
 * 复用批准、假完成、旧目标、卡版本变化、档位变化、跨项目泄漏、审批绕过硬拒/复核员/失联。
 *
 * 本文件守的边界：审批只解除介入度 confirm 那一支；其余硬闸照判；
 * 主权者主体只由人侧入口内部构造；完整请求只给主权者与原申请者，审计只留摘要与指纹。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { makeFixture, LEAD, REVIEWER } from './helpers.mjs';
import { Org } from '../src/org.js';
import { ACTIONS } from '../lib/actions.js';
import { InterventionService, 以放行上下文, 决议动作 } from '../src/intervention.js';
import { intervention路由 } from '../components/kernel/lib/routes.js';
import { Denied, InvalidBody } from '../src/kernel/errors.js';

const P = 'proj-f-approval';
const P2 = 'proj-f-approval-other';

/** 起一个真 Org（真策略引擎 + 真账本）；默认审批档，options 可覆盖（失联/撤回名单/档位）。 */
async function 起(选项 = {}) {
  const f = await makeFixture({ defaults: { 介入度: '审批' }, ...选项 });
  const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
  return { f, org };
}

/** 一条被拦下的写：默认审批档、任务目标、项目 P；步骤计划 = 宏动作到底层策略的翻译层。 */
function 一单(over = {}) {
  return {
    subject: LEAD,
    action: 'write',
    args: { id: 't-1', 描述: '干点活' },
    目标: { id: 't-1', kind: '任务', 代: 1 },
    项目: P,
    档位: '审批',
    规则: '法律 介入度 · 审批（§4）',
    步骤: [{ 动作: 'write', 目标: { kind: '任务', id: 't-1' }, 说明: '改任务节点', 预览: { 描述: '干点活' } }],
    ...over,
  };
}

/** 只有计划步骤、没有宏名的放行上下文（宏名不参与匹配）。 */
function 放行(步骤, 原主体 = 'lead') {
  return { 原主体, 请求id: 'iv-x', 步骤 };
}

/** 人侧决议的统一来源名字（模拟同源路由已通过宿主 Connection 认证）。 */
const 人侧 = { 通道: '设置页', 认证: '宿主 Connection 已认证（同源浏览器设置入口）' };

describe('① 请求载体：私有冻结记录 + 审计只留摘要', () => {
  it('审计行只存键名/形状/指纹/记录引用；正文只在私有记录里', async () => {
    const { f, org } = await 起();
    try {
      const 暗号 = 'SECRET-α-绝密正文-1234567890';
      const r = await org.intervention.记请求(一单({ args: { id: 't-1', 描述: 暗号 } }));
      assert.equal(r.状态, '待放行');
      const 全账 = await org.audit.read({});
      assert.ok(!JSON.stringify(全账).includes(暗号), '请求体正文不许进审计（账本可广投影）');
      const 行 = 全账.find((x) => x.动作 === '介入请求');
      assert.equal(行.项目, P);
      assert.deepEqual(行.详情.安全摘要.键, ['id', '描述']);
      assert.equal(行.详情.请求记录.请求id, r.请求id);
      assert.match(String(行.详情.请求记录.摘要), /^[0-9a-f]{64}$/, '审计留内容指纹，正文另存');
      // 私有记录里是完整正文（主权者/原申请者可预览，不盲批）。
      const 记录 = await org.intervention.读冻结({ 请求id: r.请求id, subject: { id: 'sovereign', kind: '主权者' } });
      assert.equal(记录.入参.描述, 暗号);
      assert.equal((await org.intervention.投影({ 项目: P })).length, 1);
      assert.equal((await org.intervention.投影({ 项目: P2 })).length, 0, '跨项目不可见');
    } finally {
      await f.cleanup();
    }
  });

  it('完整请求只给主权者与原申请者；别的成员读不到', async () => {
    const { f, org } = await 起();
    try {
      const r = await org.intervention.记请求(一单({ args: { id: 't-1', 描述: '原申请者的正文' } }));
      const 主权者读 = await org.intervention.读冻结({ 请求id: r.请求id, subject: { id: 'sovereign', kind: '主权者' } });
      assert.equal(主权者读.入参.描述, '原申请者的正文');
      const 本人读 = await org.intervention.读冻结({ 请求id: r.请求id, subject: LEAD });
      assert.equal(本人读.入参.描述, '原申请者的正文');
      await assert.rejects(
        () => org.intervention.读冻结({ 请求id: r.请求id, subject: { id: 'member-b', kind: '成员' } }),
        (e) => e instanceof Denied,
        '别的成员不得读完整请求体',
      );
    } finally {
      await f.cleanup();
    }
  });

  it('私有记录被改过 ⇒ 摘要不符，读/决议/重放一律拒（不拿坏记录当冻结请求）', async () => {
    const { f, org } = await 起();
    try {
      const r = await org.intervention.记请求(一单());
      const 路径 = f.layout.private('介入请求', `${r.请求id}.json`);
      const 原文 = JSON.parse(await readFile(路径, 'utf8'));
      原文.入参.描述 = '被改过的正文';
      await writeFile(路径, JSON.stringify(原文, null, 2), 'utf8');
      await assert.rejects(
        () => org.intervention.读冻结({ 请求id: r.请求id, subject: { id: 'sovereign', kind: '主权者' } }),
        (e) => e instanceof InvalidBody,
      );
      await assert.rejects(
        () => org.intervention.人侧决议({ ...人侧, 请求id: r.请求id, 决定: '批准' }),
        (e) => e instanceof InvalidBody,
        '读不到可信的完整记录 ⇒ 不许盲批',
      );
    } finally {
      await f.cleanup();
    }
  });

  it('同一请求反复被拦不复活收口态（完成必须真有完成行）', async () => {
    const { f, org } = await 起();
    try {
      const r = await org.intervention.记请求(一单());
      await org.intervention.人侧决议({ ...人侧, 请求id: r.请求id, 决定: '批准' });
      const 放 = await org.intervention.校验放行({ 请求id: r.请求id, subject: LEAD, action: 'write' });
      assert.equal(放.ok, true);
      await org.intervention.记完成({ 请求id: r.请求id, 主体: LEAD, 占用行: 放.占用, 项目: P });
      assert.equal((await org.intervention.记请求(一单())).状态, '已完成', '收口态不因同参请求复活');
      assert.equal((await org.intervention.投影({ 项目: P }))[0].状态, '已完成');
    } finally {
      await f.cleanup();
    }
  });
});

describe('② 伪 Owner：主体只由人侧入口内部构造', () => {
  it('调用方塞 subject/kind/role 一律无效；审计主体=主权者 + 通道', async () => {
    const { f, org } = await 起();
    try {
      const r = await org.intervention.记请求(一单());
      const 决议 = await org.intervention.人侧决议({
        ...人侧,
        请求id: r.请求id,
        决定: '批准',
        主体: { id: 'hacker', kind: '主权者' },
        role: 'Lead',
        kind: '主权者',
      });
      assert.deepEqual(决议.主体, { id: 'sovereign', kind: '主权者' }, '主体由入口构造，不由参数声明');
      assert.equal(决议.交互.交互来源, '人侧入口', '本人交互用准确来源，不借 presence命令');
      const 行 = (await org.audit.read({})).filter((x) => x.动作 === 决议动作).at(-1);
      assert.equal(行.主体.id, 'sovereign');
      assert.equal(行.主体.kind, '主权者');
      assert.match(行.依据, /设置页/);
      assert.equal(行.详情.入口.通道, '设置页');
      assert.equal(行.详情.入口.认证, 人侧.认证);
    } finally {
      await f.cleanup();
    }
  });

  it('模型工具面的动作 enum 里没有任何审批动作（结构性不可达）', () => {
    assert.ok(!ACTIONS.some((a) => /介入|intervention|approval/.test(String(a))), `工具面不该有审批动作：${ACTIONS.filter((a) => /介入|intervention|approval/.test(String(a)))}`);
  });
});

describe('③ 重放：冻结请求 / 参数置换 / 复用批准', () => {
  it('回放执行的是冻结请求；本次参数与冻结不一致 ⇒ 参数置换拒', async () => {
    const { f, org } = await 起();
    try {
      const r = await org.intervention.记请求(一单({ args: { id: 't-2', 描述: '原请求' } }));
      await org.intervention.人侧决议({ ...人侧, 请求id: r.请求id, 决定: '批准' });
      const 换 = await org.intervention.校验放行({ 请求id: r.请求id, subject: LEAD, action: 'write', 入参: { id: 't-2', 描述: '换过的请求' } });
      assert.equal(换.ok, false);
      assert.equal(换.状态, '参数置换');
      const 好 = await org.intervention.校验放行({ 请求id: r.请求id, subject: LEAD, action: 'write', 入参: { id: 't-2', 描述: '原请求' } });
      assert.equal(好.ok, true);
      assert.deepEqual(好.冻结.入参, { id: 't-2', 描述: '原请求' }, '拿回冻结参数执行，不靠调用方复述');
    } finally {
      await f.cleanup();
    }
  });

  it('不是原申请者 ⇒ 主体不符；换动作 ⇒ 动作不符', async () => {
    const { f, org } = await 起();
    try {
      const r = await org.intervention.记请求(一单());
      await org.intervention.人侧决议({ ...人侧, 请求id: r.请求id, 决定: '批准' });
      assert.equal((await org.intervention.校验放行({ 请求id: r.请求id, subject: { id: 'member-a', kind: '成员', roleId: '插件工程' }, action: 'write' })).状态, '主体不符');
      assert.equal((await org.intervention.校验放行({ 请求id: r.请求id, subject: LEAD, action: 'create' })).状态, '动作不符');
    } finally {
      await f.cleanup();
    }
  });

  it('计划变了（内容或条数）⇒ 计划不符；人侧待决能预览每一步真正要写什么', async () => {
    const { f, org } = await 起();
    try {
      const 步骤 = [{ 动作: 'write', 目标: { kind: '任务', id: 't-1' }, 说明: '改任务节点', 预览: { 描述: 'A' } }];
      const r = await org.intervention.记请求(一单({ 步骤 }));
      const 清单 = await org.intervention.人侧待决({ 项目: P });
      assert.equal(清单[0].完整请求.描述, '干点活', '完整请求正文可预览');
      assert.equal(清单[0].步骤[0].说明, '改任务节点');
      assert.deepEqual(清单[0].步骤[0].预览, { 描述: 'A' }, '步骤预览是真正将写的内容，不只 hash');
      await org.intervention.人侧决议({ ...人侧, 请求id: r.请求id, 决定: '批准' });
      assert.equal((await org.intervention.校验放行({ 请求id: r.请求id, subject: LEAD, action: 'write', 步骤: [{ 动作: 'write', 目标: { kind: '任务', id: 't-1' }, 说明: '改任务节点', 预览: { 描述: 'B' } }] })).状态, '计划不符', '内容变了');
      assert.equal((await org.intervention.校验放行({ 请求id: r.请求id, subject: LEAD, action: 'write', 步骤: [] })).状态, '计划不符', '少写一步');
      assert.equal((await org.intervention.校验放行({ 请求id: r.请求id, subject: LEAD, action: 'write', 步骤 })).ok, true, '同一计划可放行');
    } finally {
      await f.cleanup();
    }
  });

  it('一次性占用：第二次重放被拒，只落一条占用行', async () => {
    const { f, org } = await 起();
    try {
      const r = await org.intervention.记请求(一单());
      await org.intervention.人侧决议({ ...人侧, 请求id: r.请求id, 决定: '批准' });
      const 一 = await org.intervention.校验放行({ 请求id: r.请求id, subject: LEAD, action: 'write' });
      assert.equal(一.ok, true);
      const 二 = await org.intervention.校验放行({ 请求id: r.请求id, subject: LEAD, action: 'write' });
      assert.equal(二.ok, false);
      assert.equal(二.状态, '占用未报告');
      const 占用行 = (await org.audit.read({})).filter((x) => x.动作 === '介入放行占用' && x.对象?.id === r.请求id);
      assert.equal(占用行.length, 1, '重复执行不重复副作用');
    } finally {
      await f.cleanup();
    }
  });
});

describe('④ 假完成：失败不完成，可重新决定', () => {
  it('写失败 ⇒ 状态失败、无完成行；重新批准后才回到「已批准待重放」', async () => {
    const { f, org } = await 起();
    try {
      const r = await org.intervention.记请求(一单());
      await org.intervention.人侧决议({ ...人侧, 请求id: r.请求id, 决定: '批准' });
      const 放 = await org.intervention.校验放行({ 请求id: r.请求id, subject: LEAD, action: 'write' });
      await org.intervention.记失败({ 请求id: r.请求id, 主体: LEAD, 占用行: 放.占用, 原因: '目标写入被拒', 项目: P });
      let 清单 = await org.intervention.投影({ 项目: P });
      assert.equal(清单[0].状态, '失败');
      assert.equal(清单[0].完成行, null, '失败不许显示已完成');
      assert.equal((await org.audit.read({})).filter((x) => x.动作 === '介入完成').length, 0);
      assert.equal((await org.intervention.校验放行({ 请求id: r.请求id, subject: LEAD, action: 'write' })).ok, false, '失败即消耗本次批准，不自动重试');
      await org.intervention.人侧决议({ ...人侧, 请求id: r.请求id, 决定: '批准' });
      清单 = await org.intervention.投影({ 项目: P });
      assert.equal(清单[0].状态, '已批准待重放', '重新决定后才可再来一次');
    } finally {
      await f.cleanup();
    }
  });
});

describe('⑤ 失效面：旧目标 / 卡版本 / 档位改', () => {
  it('目标代变化 ⇒ 已失效（投影与重放同一把尺）', async () => {
    const f = await makeFixture({ defaults: { 介入度: '审批' } });
    try {
      const svc = new InterventionService({ layout: f.layout, clock: f.clock, audit: f.audit, policy: f.policy, 目标代Of: async () => 2 });
      const r = await svc.记请求(一单());
      await svc.人侧决议({ ...人侧, 请求id: r.请求id, 决定: '批准' });
      assert.equal((await svc.投影({ 项目: P }))[0].状态, '已失效');
      const 放 = await svc.校验放行({ 请求id: r.请求id, subject: LEAD, action: 'write' });
      assert.equal(放.ok, false);
      assert.equal(放.状态, '已失效');
    } finally {
      await f.cleanup();
    }
  });

  it('原主体卡版本变化 ⇒ 已失效（旧批准按旧卡做出）', async () => {
    const f = await makeFixture({ defaults: { 介入度: '审批' } });
    try {
      let 现行卡 = 'card-v1';
      const svc = new InterventionService({ layout: f.layout, clock: f.clock, audit: f.audit, policy: f.policy, 卡版本Of: async () => 现行卡 });
      const 原主体 = { ...LEAD, 卡版本: 'card-v1' };
      const r = await svc.记请求(一单({ subject: 原主体 }));
      await svc.人侧决议({ ...人侧, 请求id: r.请求id, 决定: '批准' });
      现行卡 = 'card-v2';
      assert.equal((await svc.投影({ 项目: P }))[0].状态, '已失效');
      const 放 = await svc.校验放行({ 请求id: r.请求id, subject: 原主体, action: 'write' });
      assert.equal(放.ok, false);
      assert.equal(放.状态, '已失效');
    } finally {
      await f.cleanup();
    }
  });

  it('介入度改档 ⇒ 旧项准确转「已失效」，且不许重放', async () => {
    const { f, org } = await 起({ defaults: { 介入度: '放权' } });
    try {
      assert.equal(org.policy.intervention(), '放权');
      const r = await org.intervention.记请求(一单({ 档位: '审批' }));
      await org.intervention.人侧决议({ ...人侧, 请求id: r.请求id, 决定: '批准' });
      assert.equal((await org.intervention.投影({ 项目: P }))[0].状态, '已失效');
      const 放 = await org.intervention.校验放行({ 请求id: r.请求id, subject: LEAD, action: 'write' });
      assert.equal(放.ok, false);
      assert.equal(放.状态, '已失效');
    } finally {
      await f.cleanup();
    }
  });
});

describe('⑥ 终态：拒绝 / 撤销不复活', () => {
  it('拒绝 ⇒ 已拒绝；再批准被拒；撤销 ⇒ 已撤销', async () => {
    const { f, org } = await 起();
    try {
      const r = await org.intervention.记请求(一单());
      await org.intervention.人侧决议({ ...人侧, 请求id: r.请求id, 决定: '拒绝', 理由: '不需要' });
      assert.equal((await org.intervention.投影({ 项目: P }))[0].状态, '已拒绝');
      await assert.rejects(
        () => org.intervention.人侧决议({ ...人侧, 请求id: r.请求id, 决定: '批准' }),
        (e) => e instanceof Denied,
        '已拒绝是终态，不复活',
      );
      const r2 = await org.intervention.记请求(一单({ args: { id: 't-9' } }));
      await org.intervention.人侧决议({ ...人侧, 请求id: r2.请求id, 决定: '批准' });
      await org.intervention.人侧决议({ ...人侧, 请求id: r2.请求id, 决定: '撤销' });
      assert.equal((await org.intervention.投影({ 项目: P })).find((x) => x.请求id === r2.请求id).状态, '已撤销');
      assert.equal((await org.intervention.校验放行({ 请求id: r2.请求id, subject: LEAD, action: 'write' })).ok, false);
    } finally {
      await f.cleanup();
    }
  });
});

describe('⑦ 失联：本人决定恢复失联，但不批准别的待决', () => {
  it('决议落账即恢复失联；另一单仍是待放行', async () => {
    const { f, org } = await 起({ offline: true });
    try {
      assert.equal(org.policy.presence().lost, true, '前提：夹具处于失联');
      const r1 = await org.intervention.记请求(一单({ args: { id: 't-a' } }));
      const r2 = await org.intervention.记请求(一单({ args: { id: 't-b' } }));
      const 决议 = await org.intervention.人侧决议({ ...人侧, 请求id: r1.请求id, 决定: '批准' });
      assert.equal(决议.交互.已记, true);
      assert.equal(org.policy.presence().lost, false, '本人有效交互恢复失联');
      const 清单 = await org.intervention.投影({ 项目: P });
      assert.equal(清单.find((x) => x.请求id === r1.请求id).状态, '已批准待重放');
      assert.equal(清单.find((x) => x.请求id === r2.请求id).状态, '待放行', '恢复 ≠ 批准其他待决');
    } finally {
      await f.cleanup();
    }
  });
});

describe('⑧ 策略钩子：批准只解除介入度 confirm 门', () => {
  it('计划里对上 ⇒ allow；主体或 id 不符 ⇒ 仍 confirm', async () => {
    const f = await makeFixture({ defaults: { 介入度: '审批' } });
    try {
      const 目标 = { id: 't-1', kind: '任务', authority: '自治', zone: '私有' };
      const 判 = () => f.policy.decide({ subject: LEAD, action: 'write', target: 目标, context: {} });
      const 步骤 = [{ 动作: 'write', 目标: { kind: '任务', id: 't-1' } }];
      assert.equal((await 判()).verdict, 'confirm', '无放行上下文 ⇒ 仍挂起');
      const 过 = await 以放行上下文(放行(步骤), 判);
      assert.equal(过.verdict, 'allow');
      assert.match(过.rule, /已批准放行/);
      const 换人 = await 以放行上下文(放行(步骤, 'member-a'), 判);
      assert.equal(换人.verdict, 'confirm', '别的 Lead/成员不能拿这笔放行');
      const 换目标 = await 以放行上下文(放行([{ 动作: 'write', 目标: { kind: '任务', id: 't-2' } }]), 判);
      assert.equal(换目标.verdict, 'confirm', '换目标不许复用同一笔放行');
    } finally {
      await f.cleanup();
    }
  });

  it('复核员只读 / 撤回名单 / 失联冻结在带放行时仍拒', async () => {
    const 名单 = await makeFixture({ defaults: { 介入度: '审批' }, denylist: [{ id: 'cap-blocked', 理由: '撤回（测试）', 撤于: '2026-10-18T00:00:00Z' }] });
    try {
      const 带 = (fn) => 以放行上下文({ 原主体: 'reviewer', 请求id: 'iv-x', 步骤: [{ 动作: 'write', 目标: { kind: '任务', id: 't-1' } }] }, fn);
      const 复核 = await 带(() => 名单.policy.decide({ subject: REVIEWER, action: 'write', target: { id: 't-1', kind: '任务', authority: '自治' }, context: {} }));
      assert.notEqual(复核.verdict, 'allow', '审批不能解除复核员只读（前置父判/只读闸任一先拦都算）');
      assert.notEqual(复核.rule, '法律 介入度 · 已批准放行（§4/v2 条目14/17）', '复核员这条路不许被放行上下文点绿');
      const 硬拒 = await 以放行上下文({ 原主体: 'lead', 请求id: 'iv-x', 步骤: [{ 动作: 'write', 目标: { kind: '能力', id: 'cap-blocked' } }] }, () => 名单.policy.decide({ subject: LEAD, action: 'write', target: { id: 'cap-blocked', kind: '能力', authority: '自治' }, context: {} }));
      assert.equal(硬拒.verdict, 'deny', '审批不能绕过撤回名单硬拒');
    } finally {
      await 名单.cleanup();
    }
    const 失联 = await makeFixture({ defaults: { 介入度: '审批' }, offline: true });
    try {
      const 判 = await 以放行上下文(放行([{ 动作: 'write', 目标: { kind: '任务', id: 't-1' } }]), () => 失联.policy.decide({ subject: LEAD, action: 'write', target: { id: 't-1', kind: '任务', authority: '自治' }, context: {} }));
      assert.equal(判.verdict, 'deny', '审批不能解冻失联');
    } finally {
      await 失联.cleanup();
    }
  });
});

describe('⑩ 宏→底层对应：新建 ID / 多步 / 多派生写', () => {
  it('task_create：宏名不进匹配，底层 create + 每次新 ID 都放行；同一批准只够一次', async () => {
    const f = await makeFixture({ defaults: { 介入度: '审批' } });
    try {
      const 步骤 = [{ 动作: 'create', 目标: { kind: '任务', 新: true }, 说明: '建任务节点', 预览: { 描述: '新活' } }];
      const 判 = (id) => f.policy.decide({ subject: LEAD, action: 'create', target: { id, kind: '任务', authority: '自治' }, context: {} });
      const A = await 以放行上下文(放行(步骤), () => 判('task-AAA'));
      assert.equal(A.verdict, 'allow', '底层 create + 新 id 必须放行（宏名 task_create 不参与匹配）');
      const B = await 以放行上下文(放行(步骤), () => 判('task-BBB'));
      assert.equal(B.verdict, 'allow', '下一次重放生成的新 id 仍可对上（新:true 步不认 id）');
      let 第二步 = null;
      await 以放行上下文(放行(步骤), async () => {
        await 判('task-CCC');
        第二步 = await 判('task-DDD');
      });
      assert.equal(第二步.verdict, 'confirm', '同一上下文里同一步只用一次，不是全局豁免');
    } finally {
      await f.cleanup();
    }
  });

  it('member_spawn 式多步：派发/实例登记/绑定各一步，逐条消费；计划外写仍挂起', async () => {
    const f = await makeFixture({ defaults: { 介入度: '审批' } });
    try {
      const 步骤 = [
        { 序: 1, 动作: 'dispatch', 目标: { kind: '任务', id: 'task-spawn' }, 说明: '派发根节点' },
        { 序: 2, 动作: 'create', 目标: { kind: '身份', 新: true }, 说明: '登记本人实例', 预览: { 岗位: '插件工程' } },
        { 序: 3, 动作: 'write', 目标: { kind: '任务', id: 'task-spawn' }, 写: 'bind', 说明: '绑定实例' },
        { 序: 4, 动作: 'create', 目标: { kind: '身份', 新: true }, 说明: '登记第二个实例' },
      ];
      const 判 = (action, id, kind, context = {}) => f.policy.decide({ subject: LEAD, action, target: { id, kind, authority: '自治' }, context });
      await 以放行上下文(放行(步骤), async () => {
        assert.equal((await 判('dispatch', 'task-spawn', '任务')).verdict, 'allow', '派发');
        // 同一业务写的锁外预检 + 锁内复判：同一身份两次判都放行，且不再消耗第二步。
        assert.equal((await 判('dispatch', 'task-spawn', '任务')).verdict, 'allow', '派发的锁内复判');
        assert.equal((await 判('create', 'inst-new-1', '身份')).verdict, 'allow', '实例登记（新 id）');
        assert.equal((await 判('write', 'task-spawn', '任务', { 节点操作: 'bind' })).verdict, 'allow', '绑定（写标签 bind）');
        assert.equal((await 判('create', 'inst-new-2', '身份')).verdict, 'allow', '第二个实例');
        assert.equal((await 判('create', 'inst-new-3', '身份')).verdict, 'confirm', '计划外的第三个实例仍挂起');
        assert.equal((await 判('create', 'cap-x', '能力')).verdict, 'confirm', '别的 kind 不在计划里');
      });
    } finally {
      await f.cleanup();
    }
  });

  it('task_settle 式多派生写：一次批准覆盖计划内多条知识写，但不外溢', async () => {
    const f = await makeFixture({ defaults: { 介入度: '审批' } });
    try {
      const 步骤 = [
        { 动作: 'write', 目标: { kind: '任务', id: 'task-settle' }, 说明: '结账' },
        { 动作: 'create', 目标: { kind: '知识', 新: true }, 说明: '晋升候选 1', 预览: { 标题: 'K1' } },
        { 动作: 'create', 目标: { kind: '知识', 新: true }, 说明: '晋升候选 2', 预览: { 标题: 'K2' } },
        { 动作: 'create', 目标: { kind: '知识', 新: true }, 说明: '晋升候选 3', 预览: { 标题: 'K3' } },
      ];
      const 判 = (subject, action, id, kind) => f.policy.decide({ subject, action, target: { id, kind, authority: '自治' }, context: {} });
      await 以放行上下文(放行(步骤), async () => {
        assert.equal((await 判(LEAD, 'write', 'task-settle', '任务')).verdict, 'allow', '结账本身一步');
        for (const n of [1, 2, 3]) assert.equal((await 判(LEAD, 'create', `know-new-${n}`, '知识')).verdict, 'allow', `候选 ${n} 在计划内`);
        assert.equal((await 判(LEAD, 'create', 'know-new-4', '知识')).verdict, 'confirm', '多出来的第 4 条不在计划里');
        assert.equal((await 判(LEAD, 'write', 'know-exist', '知识')).verdict, 'confirm', '同链里的另一次写不自动获准');
        const 别人 = await 判({ id: 'member-a', kind: '成员', roleId: '插件工程' }, 'create', 'know-new-5', '知识');
        assert.notEqual(别人.verdict, 'allow', '批准 A 不是同链任意 B 的豁免');
      });
    } finally {
      await f.cleanup();
    }
  });
});

describe('⑨ 人侧路由：Connection 认证 + 只认三个键 + 完整预览', () => {
  function 假对端() {
    const res = {
      状态码: null,
      体: '',
      writeHead(码) {
        this.状态码 = 码;
      },
      end(体) {
        this.体 = String(体 ?? '');
      },
    };
    return res;
  }
  function 假请求(method, body, headers = {}) {
    return {
      method,
      url: `/plugins/dsh-mind/intervention?project=${P}&sessionId=${encodeURIComponent(LEAD.id)}`,
      headers: { host: '127.0.0.1:5698', 'sec-fetch-site': 'same-origin', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      async *[Symbol.asyncIterator]() {
        if (body) yield Buffer.from(JSON.stringify(body), 'utf8');
      },
    };
  }

  it('GET 清单带完整请求；POST 决议；无认证 503；跨站 403', async () => {
    const { f, org } = await 起();
    try {
      const r = await org.intervention.记请求(一单({ args: { id: 't-1', 描述: '给主人预览的正文' } }));
      const 好ctx = { get: (名) => (名 === 'connection' ? { requestRejection: () => undefined } : undefined) };

      const 列表 = 假对端();
      await intervention路由({ org, 项目: P, ctx: 好ctx })(假请求('GET'), 列表);
      assert.equal(列表.状态码, 200, 列表.体);
      const 包 = JSON.parse(列表.体);
      assert.equal(包.待决.length, 1);
      assert.equal(包.待决[0].状态, '待放行');
      assert.equal(包.待决[0].完整请求.描述, '给主人预览的正文', '主权者要能预览完整冻结内容');
      assert.equal(包.待决[0].步骤[0].说明, '改任务节点', '步骤计划也要可预览');

      const 写 = 假对端();
      await intervention路由({ org, 项目: P, ctx: 好ctx })(假请求('POST', { 请求id: r.请求id, 决定: '批准', 理由: 'ok', 审阅指纹: 包.待决[0].审阅指纹, 主体: { id: 'hacker', kind: '主权者' }, kind: '主权者' }), 写);
      assert.equal(写.状态码, 200, 写.体);
      const 决议 = JSON.parse(写.体);
      assert.deepEqual(决议.主体, { id: 'sovereign', kind: '主权者' }, 'body 里的主体被忽略');
      assert.equal((await org.audit.read({})).filter((x) => x.动作 === 决议动作).at(-1).主体.id, 'sovereign');

      const 无认证 = 假对端();
      await intervention路由({ org, 项目: P, ctx: { get: () => undefined } })(假请求('GET'), 无认证);
      assert.equal(无认证.状态码, 503, '没有宿主 Connection ⇒ 不退回无认证通道');

      const 跨站 = 假对端();
      await intervention路由({ org, 项目: P, ctx: 好ctx })(假请求('POST', { 请求id: r.请求id, 决定: '批准' }, { 'sec-fetch-site': 'cross-site' }), 跨站);
      assert.equal(跨站.状态码, 403, '跨站写被同源栅栏拒');
    } finally {
      await f.cleanup();
    }
  });
});
