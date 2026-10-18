/**
 * 补修 I（2026-10-18）：会审受管参与实例（不占任务图）的域服务回归网。
 *
 * 本文件只测**我独占的域面**（CouncilService / registry.assign 会审绑定 / instance-snapshot
 * 只读字段）。actions/kernel 的动作面与工具面闭名单、以及 policy 的咨询限制 hunk 不在这里
 * 假装已接通——它们分别在 E/F 的共享面冻结后接；本文件不构成端到端证据。
 *
 * 判据（每条都能变红）：
 *  ① 受管 open 创建 N 个真实登记实例，实例记录带 会审绑定（会审/项目/来源会话/资料），
 *    opened 冻结 创建实例+卡版本，任务图节点数不增长；
 *  ② 作答/解锁/讨论/收敛沿用原状态机与盲评遮罩；收敛后只退役 opened.创建实例 中
 *    仍在岗且绑定=本场的实例，预给参与者与别场实例不动；
 *  ③ 复核岗在发起前就拒（预给与新建两条路），不靠「跳过只读窄条」凑齐卷；
 *  ④ 创建/登记/钉版/发送失败：只清本次 owned 实例，opened 未落则不落、已落则 aborted，
 *    预给参与者不动；审计带阶段/已建/补偿失败；
 *  ⑤ 慢创建不占会审锁（同项目另一场会审可继续作答）；
 *  ⑥ 资料根：相对路径/不存在/私有区原始账本先拒；合法绝对路径 realpath 冻结；
 *  ⑦ registry.assign：来源会话强制取登记主体；不可改绑/解除/补绑；复核员/Lead 岗拒绝；
 *    会审绑定与任务节点互斥；seal/restore 保留绑定；
 *  ⑧ instance-snapshot：无绑定=无字段；合法对象=透出；坏形状=带 `无效` 的对象（闭名单用），
 *    显式 null 视为无绑定（合同：只有 registry 写这个键，null 是旧记录/未绑定的合法形态）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { makeFixture, writeUnder, LEAD, MEMBER, REVIEWER } from './helpers.mjs';
import { Org } from '../src/org.js';
import { 线程名 } from '../src/council.js';
import { readInstanceSnapshot } from '../src/instance-snapshot.js';
import { Denied, Fault, InvalidBody } from '../src/kernel/errors.js';

const P = 'proj-v2managed';
const 乙 = { id: 'member-b', kind: '成员', roleId: '插件工程' };

async function 起组织(options = {}) {
  const f = await makeFixture(options);
  const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
  return { f, org };
}

/** 与 council.js 同一口径的路径归一（Windows 大小写不敏感）。 */
function 规范路径(路径) {
  const 绝对 = resolve(String(路径));
  return process.platform === 'win32' ? 绝对.toLowerCase() : 绝对;
}

/** 造一份「测试用适配器」：只调真实 Registry/Council，不复制 member_spawn 的宿主实现。 */
function 造适配器(org, opts = {}) {
  const calls = { 创建: [], 发送: [], 退役: [] };
  let seq = 0;
  return {
    calls,
    async 创建参与者(spec) {
      calls.创建.push(spec);
      const n = calls.创建.length;
      if (opts.第二个创建失败 && n === 2) {
        throw new Fault('TEST_CREATE_FAILED', '测试：第二实例创建失败', { detail: { 阶段: 'spawn' } });
      }
      const 实例 = `consult-${++seq}`;
      // 真实登记走 registry.assign（会审绑定 + 钉版 + 委派者一次落齐），与产品适配器同一落点。
      await org.registry.assign({ subject: LEAD, 岗位: spec.岗位, 实例, 会审: { id: spec.会审, 项目: spec.项目, 资料: spec.资料 } });
      if (opts.第二个钉卡不就绪 && n === 2) {
        return { 实例, 钉卡: { 就绪: false, 原因: '测试：钉卡未就绪' } };
      }
      const 钉卡 = await org.registry.cardOf(实例);
      return { 实例, 钉卡 };
    },
    async 发开场书(spec) {
      calls.发送.push(spec);
      if (opts.第一个发送后作答 && spec.实例 === 'consult-1') {
        await org.council.answer({ subject: { id: spec.实例, kind: '成员' }, 项目: P, id: spec.会审, 结论: '早卷秘密', 结论层: '方案A' });
      }
      if (opts.第二个发送失败 && spec.实例 === 'consult-2') {
        throw new Error('测试：第二实例任务书发送失败');
      }
    },
    async 退役实例(spec) {
      calls.退役.push(spec);
      const 成员 = (await org.registry.identity()).members?.[spec.实例];
      if (成员?.status === '在岗') await org.registry.seal({ subject: LEAD, 实例: spec.实例, 理由: spec.原因 });
      return { 已退役: true, 原状态: 成员?.status ?? null };
    },
  };
}

/** 建一份可读资料（绝对路径，realpath 归一后才是冻结值）。 */
async function 造资料(f) {
  const 目录 = join(f.home, 'materials');
  await mkdir(目录, { recursive: true });
  const 文件 = join(目录, 'brief.md');
  await writeFile(文件, '# 资料\n决策背景。\n', 'utf8');
  return 规范路径(await realpath(文件));
}

describe('① 受管 open 全流程（域服务，不冒充端到端）', () => {
  it('N=2：真实登记/钉版/opened 冻结；任务图零增长；作答→解锁→收敛只退役本场', async () => {
    const { f, org } = await 起组织();
    try {
      const 资料 = await 造资料(f);
      const a = 造适配器(org);
      const 任务前 = (await org.tasks.list({ 项目: P })).length;
      const 开 = await org.council.open({
        subject: LEAD, 项目: P, 问题: '方案 A 还是方案 B',
        参与者: [MEMBER.id], 参与岗位: ['插件工程', '插件工程'], 资料: [资料],
        来源会话: 'fake-session', // 自报来源：必须被忽略
        ...a,
      });
      assert.equal(开.会审.参与者.length, 3, '预给 1 + 新建 2');
      assert.deepEqual(开.创建实例.map((x) => x.实例), ['consult-1', 'consult-2']);
      assert.equal(开.来源会话, 'lead');
      assert.deepEqual(开.会审.资料, [资料], '资料 realpath 后冻结');
      assert.equal(开.会审.创建实例.length, 2);
      assert.ok(开.会审.创建实例.every((x) => typeof x.卡版本 === 'string' && x.卡版本.length > 0), 'opened 冻结卡版本摘要');
      assert.equal((await org.tasks.list({ 项目: P })).length, 任务前, '任务图节点数不增长');

      for (const c of 开.创建实例) {
        const 成员 = (await org.registry.identity()).members[c.实例];
        assert.equal(成员.status, '在岗');
        assert.equal(成员.会审绑定.会审, 开.id);
        assert.equal(成员.会审绑定.项目, P);
        assert.equal(成员.会审绑定.来源会话, 'lead', '来源会话 = 真实登记主体');
        assert.deepEqual(成员.会审绑定.资料, [资料]);
        assert.equal(成员.生命周期.绑定会审, 开.id);
        assert.equal(成员.委派者.id, 'lead', '委派者=Lead，父判有据');
        const 发送 = a.calls.发送.find((s) => s.实例 === c.实例);
        assert.equal(发送.会审, 开.id);
        assert.equal(发送.来源会话, 'lead');
        assert.equal(发送.钉卡.就绪, true, '任务书只用钉住的卡');
      }

      await org.council.answer({ subject: { id: 'consult-1', kind: '成员' }, 项目: P, id: 开.id, 结论: 'A 秘密结论', 结论层: '方案A' });
      await org.council.answer({ subject: { id: 'consult-2', kind: '成员' }, 项目: P, id: 开.id, 结论: 'B 案', 结论层: '方案A' });
      await org.council.answer({ subject: MEMBER, 项目: P, id: 开.id, 结论: '预给答案', 结论层: '方案A' });
      const 盲读 = (await org.council.list({ 项目: P, 读者: { id: 'consult-2', kind: '成员' } }))[0];
      assert.equal(盲读.盲评遮罩, true);
      assert.ok(!JSON.stringify(盲读).includes('A 秘密结论'), '作答中他人答案仍遮罩');

      await org.council.unlock({ subject: LEAD, 项目: P, id: 开.id });
      const 收 = await org.council.converge({ subject: LEAD, 项目: P, id: 开.id, 退役实例: a.退役实例 });
      assert.equal(收.会审.状态, '已收敛');
      assert.deepEqual(收.退役.map((x) => [x.实例, x.已退役]), [['consult-1', true], ['consult-2', true]]);
      assert.deepEqual(收.会审.退役.map((x) => [x.实例, x.已退役]), [['consult-1', true], ['consult-2', true]], '退役结果随 retired 事件存档');
      const 档案 = (await org.registry.identity()).members;
      assert.equal(档案['consult-1'].status, '封存');
      assert.equal(档案['consult-2'].status, '封存');
      assert.equal(档案['member-a'].status, '在岗', '预给参与者不被退役');
      assert.equal('会审绑定' in 档案['member-a'], false, '预给参与者不被追加会审绑定/不改原权限');
      assert.deepEqual(a.calls.退役.map((x) => x.实例).sort(), ['consult-1', 'consult-2']);
      assert.equal((await org.tasks.list({ 项目: P })).length, 任务前, '收敛同样不写任务图');
    } finally { await f.cleanup(); }
  });

  it('全新建 N=2（无预给）也能完成咨询；总人数按新建计', async () => {
    const { f, org } = await 起组织();
    try {
      const a = 造适配器(org);
      const 开 = await org.council.open({ subject: LEAD, 项目: P, 问题: '全新建', 参与者: [], 参与岗位: ['插件工程', '插件工程'], ...a });
      assert.equal(开.会审.参与者.length, 2);
      await org.council.answer({ subject: { id: 'consult-1', kind: '成员' }, 项目: P, id: 开.id, 结论: 'A' });
      await org.council.answer({ subject: { id: 'consult-2', kind: '成员' }, 项目: P, id: 开.id, 结论: 'B' });
      await org.council.unlock({ subject: LEAD, 项目: P, id: 开.id });
      const 收 = await org.council.converge({ subject: LEAD, 项目: P, id: 开.id, 退役实例: a.退役实例 });
      assert.deepEqual(收.退役.map((x) => [x.实例, x.已退役]), [['consult-1', true], ['consult-2', true]]);
    } finally { await f.cleanup(); }
  });

  it('作答中答案不在总线：bus 不是绕盲评遮罩的读面', async () => {
    const { f, org } = await 起组织();
    try {
      const a = 造适配器(org);
      const 开 = await org.council.open({ subject: LEAD, 项目: P, 问题: 'bus 读面', 参与者: [MEMBER.id], 参与岗位: ['插件工程'], ...a });
      await org.council.answer({ subject: { id: 'consult-1', kind: '成员' }, 项目: P, id: 开.id, 结论: '只应存在会审存档' });
      const 消息 = await org.bus.readRaw({ 项目: P, 线程: 线程名(开.id) });
      assert.deepEqual(消息, [], '作答中讨论线程尚未建立：答案不在总线，bus_read 拿不到答案');
      const 视图 = await org.council.list({ 项目: P, 读者: { id: 'consult-1', kind: '成员' } });
      assert.equal(视图[0].盲评遮罩, true);
    } finally { await f.cleanup(); }
  });

  it('councilPlan：open 摊 create 会审+N 身份；converge 摊 write+owned seal；只读', async () => {
    const { f, org } = await 起组织();
    try {
      const 资料 = await 造资料(f);
      const a = 造适配器(org);
      const 开 = await org.council.open({ subject: LEAD, 项目: P, 问题: '计划', 参与者: [MEMBER.id], 参与岗位: ['插件工程', '插件工程'], 资料: [资料], ...a });
      const 开前 = await org.council.get(P, 开.id);
      const 开计划 = await org.council.councilPlan({ 项目: P, 动作: 'debate_open', args: { 参与者: [MEMBER.id], 参与岗位: ['插件工程', '插件工程'], 问题: '计划', 资料: [资料] } });
      assert.equal(开计划.步骤.length, 3, 'create 会审 + 2 次身份登记');
      assert.equal(开计划.步骤[0].动作, 'create');
      assert.equal(开计划.步骤[0].目标.kind, '会审');
      assert.equal(开计划.步骤[0].目标.新, true);
      assert.deepEqual(开计划.步骤.slice(1).map((s) => [s.动作, s.目标.kind, s.目标.新]), [['create', '身份', true], ['create', '身份', true]]);
      assert.ok(开计划.步骤.every((s) => s.写 == null), '计划不带写标签（与 assign 的实际 context 对齐）');
      assert.equal((await org.council.get(P, 开.id)).状态, 开前.状态, '只读：计划不推进状态');

      await org.council.answer({ subject: MEMBER, 项目: P, id: 开.id, 结论: '预给' });
      await org.council.answer({ subject: { id: 'consult-1', kind: '成员' }, 项目: P, id: 开.id, 结论: 'A' });
      await org.council.answer({ subject: { id: 'consult-2', kind: '成员' }, 项目: P, id: 开.id, 结论: 'B' });
      await org.council.unlock({ subject: LEAD, 项目: P, id: 开.id });
      const 收计划 = await org.council.councilPlan({ 项目: P, 动作: 'debate_converge', args: { id: 开.id, 内容: '收' } });
      assert.deepEqual(收计划.步骤.map((s) => [s.动作, s.目标.kind]), [['write', '会审'], ['seal', '身份'], ['seal', '身份']]);
      assert.deepEqual(收计划.步骤.slice(1).map((s) => s.目标.id), ['consult-1', 'consult-2'], '只列本场 owned 实例');
    } finally { await f.cleanup(); }
  });
});

describe('② 复核岗与副作用前拒绝', () => {
  it('复核岗不能参会：预给与新建两条路都在创建前拒，并指路真实复核任务', async () => {
    const { f, org } = await 起组织();
    try {
      const a = 造适配器(org);
      await assert.rejects(
        () => org.council.open({ subject: LEAD, 项目: P, 问题: 'q', 参与者: [MEMBER.id, REVIEWER.id] }),
        (e) => e instanceof Denied && /复核岗不能作为参与者/.test(e.rule) && /复核任务/.test(e.message),
        '预给复核员也要在副作用前拒',
      );
      await assert.rejects(
        () => org.council.open({ subject: LEAD, 项目: P, 问题: 'q', 参与者: [MEMBER.id], 参与岗位: ['复核员'], ...a }),
        (e) => e instanceof Denied && /复核岗/.test(e.rule),
        '新建复核岗同样拒',
      );
      assert.equal(a.calls.创建.length, 0, '拒发生在创建前');
      assert.deepEqual(await org.council.list({ 项目: P }), []);
    } finally { await f.cleanup(); }
  });

  it('适配器缺一 ⇒ COUNCIL_ADAPTER_NOT_READY，零创建零落账', async () => {
    const { f, org } = await 起组织();
    try {
      const a = 造适配器(org);
      for (const spec of [
        {},
        { 创建参与者: a.创建参与者 },
        { 创建参与者: a.创建参与者, 发开场书: a.发开场书 },
      ]) {
        await assert.rejects(
          () => org.council.open({ subject: LEAD, 项目: P, 问题: 'q', 参与者: [MEMBER.id], 参与岗位: ['插件工程'], ...spec }),
          (e) => e instanceof Fault && e.code === 'COUNCIL_ADAPTER_NOT_READY',
        );
      }
      assert.equal(a.calls.创建.length, 0);
      assert.deepEqual(await org.council.list({ 项目: P }), []);
    } finally { await f.cleanup(); }
  });

  it('资料根预检：相对路径/不存在/私有区原始账本先拒', async () => {
    const { f, org } = await 起组织();
    try {
      await writeUnder(f.privateRoot, 'secret.md', '私有区原始账本\n');
      const 私有文件 = join(f.privateRoot, 'secret.md');
      const a = 造适配器(org);
      const 打开 = (资料) => org.council.open({ subject: LEAD, 项目: P, 问题: 'q', 参与者: [MEMBER.id], 参与岗位: ['插件工程'], 资料: [资料], ...a });
      await assert.rejects(() => 打开('relative.md'), (e) => e instanceof InvalidBody && /绝对路径/.test(e.message));
      await assert.rejects(() => 打开(join(f.home, 'nope.md')), (e) => e instanceof InvalidBody && /不存在/.test(e.message));
      await assert.rejects(() => 打开(私有文件), (e) => e instanceof Denied && /私有区/.test(e.rule));
      assert.equal(a.calls.创建.length, 0);
      assert.deepEqual(await org.council.list({ 项目: P }), []);
    } finally { await f.cleanup(); }
  });

  it('Lead 未钉版 ⇒ 副作用前 COUNCIL_SOURCE_NOT_READY', async () => {
    const { f, org } = await 起组织({ lead: 'unpinned' });
    try {
      const a = 造适配器(org);
      await assert.rejects(
        () => org.council.open({ subject: LEAD, 项目: P, 问题: 'q', 参与者: [MEMBER.id], 参与岗位: ['插件工程'], ...a }),
        (e) => e instanceof Fault && e.code === 'COUNCIL_SOURCE_NOT_READY',
      );
      assert.equal(a.calls.创建.length, 0);
      assert.deepEqual(await org.council.list({ 项目: P }), []);
    } finally { await f.cleanup(); }
  });
});

describe('③ 部分失败：只清本次 owned，预给不动', () => {
  it('第二实例创建失败 ⇒ 第一实例被停+封、无 opened、审计带阶段/清单', async () => {
    const { f, org } = await 起组织();
    try {
      const a = 造适配器(org, { 第二个创建失败: true });
      let 错误;
      await assert.rejects(
        () => org.council.open({ subject: LEAD, 项目: P, 问题: 'q', 参与者: [MEMBER.id], 参与岗位: ['插件工程', '插件工程'], ...a }),
        (e) => { 错误 = e; return e instanceof Fault && e.code === 'COUNCIL_CREATE_FAILED' && /consult-1/.test(e.message); },
      );
      assert.deepEqual(a.calls.退役.map((x) => x.实例), ['consult-1']);
      assert.equal((await org.registry.identity()).members['consult-1'].status, '封存');
      assert.equal((await org.registry.identity()).members['member-a'].status, '在岗', '预给参与者不动');
      assert.deepEqual(await org.council.list({ 项目: P }), [], 'opened 未落');
      const 审计 = (await org.audit.read({})).filter((r) => r.动作 === '会审创建失败');
      assert.equal(审计.length, 1);
      assert.equal(审计[0].对象.id, 错误.detail.会审);
      assert.equal(审计[0].详情.阶段, 'create');
      assert.deepEqual(审计[0].详情.已创建, ['consult-1']);
      assert.deepEqual(审计[0].详情.补偿失败, []);
    } finally { await f.cleanup(); }
  });

  it('第二实例钉卡未就绪 ⇒ 两个已登记实例都被清（含第 2 个）', async () => {
    const { f, org } = await 起组织();
    try {
      const a = 造适配器(org, { 第二个钉卡不就绪: true });
      await assert.rejects(
        () => org.council.open({ subject: LEAD, 项目: P, 问题: 'q', 参与者: [MEMBER.id], 参与岗位: ['插件工程', '插件工程'], ...a }),
        (e) => e instanceof Fault && e.code === 'COUNCIL_CREATE_FAILED' && /就绪/.test(e.message),
      );
      const 档案 = (await org.registry.identity()).members;
      assert.equal(档案['consult-1'].status, '封存');
      assert.equal(档案['consult-2'].status, '封存');
      assert.equal(档案['member-a'].status, '在岗');
      assert.deepEqual(a.calls.退役.map((x) => x.实例).sort(), ['consult-1', 'consult-2']);
    } finally { await f.cleanup(); }
  });

  it('第二实例发送失败 ⇒ aborted（作废）+ 清两个实例；早卷仍被盲评遮罩', async () => {
    const { f, org } = await 起组织();
    try {
      const a = 造适配器(org, { 第二个发送失败: true, 第一个发送后作答: true });
      let 错误;
      await assert.rejects(
        () => org.council.open({ subject: LEAD, 项目: P, 问题: 'q', 参与者: [MEMBER.id], 参与岗位: ['插件工程', '插件工程'], ...a }),
        (e) => { 错误 = e; return e instanceof Fault && e.code === 'COUNCIL_SEND_FAILED'; },
      );
      const 视图 = (await org.council.list({ 项目: P }))[0];
      assert.equal(视图.状态, '作废');
      assert.match(String(视图.作废原因), /第二实例任务书发送失败/);
      assert.equal(视图.作废阶段, 'send');
      assert.equal(视图.答案.length, 1, '早卷已入档（事实），但作废后仍按盲评遮罩');
      const 盲读 = (await org.council.list({ 项目: P, 读者: { id: 'consult-2', kind: '成员' } }))[0];
      assert.equal(盲读.盲评遮罩, true);
      assert.ok(!JSON.stringify(盲读).includes('早卷秘密'), '作废不是揭名：读面走同一遮罩');
      await assert.rejects(
        () => org.council.converge({ subject: LEAD, 项目: P, id: 视图.id, 退役实例: a.退役实例 }),
        (e) => e instanceof Denied && /作废不得收敛/.test(e.rule),
        '作废不是可收敛状态：早卷只作事实留痕',
      );
      const 档案 = (await org.registry.identity()).members;
      assert.equal(档案['consult-1'].status, '封存');
      assert.equal(档案['consult-2'].status, '封存');
      assert.equal(档案['member-a'].status, '在岗');
      const 审计 = (await org.audit.read({})).filter((r) => r.动作 === '会审创建失败');
      assert.equal(审计.length, 1);
      assert.equal(审计[0].详情.阶段, 'send');
      assert.equal(审计[0].详情.已发, 1);
      assert.ok(错误.detail.已创建.includes('consult-1'));
    } finally { await f.cleanup(); }
  });
});

describe('④ 绑定范围与两场隔离', () => {
  it('收敛退役部分失败：逐条如实回执，不假装全成功', async () => {
    const { f, org } = await 起组织();
    try {
      const a = 造适配器(org);
      const 开 = await org.council.open({ subject: LEAD, 项目: P, 问题: '退役失败', 参与者: [MEMBER.id], 参与岗位: ['插件工程', '插件工程'], ...a });
      await org.council.answer({ subject: MEMBER, 项目: P, id: 开.id, 结论: '预给' });
      await org.council.answer({ subject: { id: 'consult-1', kind: '成员' }, 项目: P, id: 开.id, 结论: 'A' });
      await org.council.answer({ subject: { id: 'consult-2', kind: '成员' }, 项目: P, id: 开.id, 结论: 'B' });
      await org.council.unlock({ subject: LEAD, 项目: P, id: 开.id });
      const 原退役 = a.退役实例;
      a.退役实例 = async (spec) => {
        if (spec.实例 === 'consult-1') throw new Error('测试：停机失败');
        return 原退役(spec);
      };
      const 收 = await org.council.converge({ subject: LEAD, 项目: P, id: 开.id, 退役实例: a.退役实例 });
      assert.deepEqual(收.退役.map((x) => [x.实例, x.已退役]), [['consult-1', false], ['consult-2', true]]);
      assert.match(String(收.退役[0].原因), /停机失败/);
      assert.deepEqual(收.会审.退役.map((x) => [x.实例, x.已退役]), [['consult-1', false], ['consult-2', true]], '失败也随 retired 事件存档');
      const 档案 = (await org.registry.identity()).members;
      assert.equal(档案['consult-1'].status, '在岗', '失败的那个不假装已封存');
      assert.equal(档案['consult-2'].status, '封存');
      assert.equal(档案['member-a'].status, '在岗');
    } finally { await f.cleanup(); }
  });

  it('参与实例跨场作答拒；收敛只退役本场实例，预给/别场不动', async () => {
    const { f, org } = await 起组织();
    try {
      const a = 造适配器(org);
      const 开A = await org.council.open({ subject: LEAD, 项目: P, 问题: 'A', 参与者: [MEMBER.id], 参与岗位: ['插件工程'], ...a });
      const 开B = await org.council.open({ subject: LEAD, 项目: P, 问题: 'B', 参与者: [MEMBER.id], 参与岗位: ['插件工程'], ...a });
      assert.deepEqual(a.calls.创建.map((x) => x.会审), [开A.id, 开B.id]);
      await assert.rejects(
        () => org.council.answer({ subject: { id: 'consult-1', kind: '成员' }, 项目: P, id: 开B.id, 结论: '串场' }),
        (e) => e instanceof Denied && /实例绑定不是本场/.test(e.rule),
        '绑定 A 的实例不能答 B',
      );
      // A：预给 + consult-1 交齐 → 解锁 → 收敛
      await org.council.answer({ subject: MEMBER, 项目: P, id: 开A.id, 结论: 'A 预给' });
      await org.council.answer({ subject: { id: 'consult-1', kind: '成员' }, 项目: P, id: 开A.id, 结论: 'A 实例' });
      await org.council.unlock({ subject: LEAD, 项目: P, id: 开A.id });
      const 收A = await org.council.converge({ subject: LEAD, 项目: P, id: 开A.id, 退役实例: a.退役实例 });
      assert.deepEqual(收A.退役.map((x) => [x.实例, x.已退役]), [['consult-1', true]]);
      let 档案 = (await org.registry.identity()).members;
      assert.equal(档案['consult-1'].status, '封存');
      assert.equal(档案['consult-2'].status, '在岗', '别场实例不动');
      assert.equal(档案['member-a'].status, '在岗');
      // B 收敛后 consult-2 才退役
      await org.council.answer({ subject: MEMBER, 项目: P, id: 开B.id, 结论: 'B 预给' });
      await org.council.answer({ subject: { id: 'consult-2', kind: '成员' }, 项目: P, id: 开B.id, 结论: 'B 实例' });
      await org.council.unlock({ subject: LEAD, 项目: P, id: 开B.id });
      const 收B = await org.council.converge({ subject: LEAD, 项目: P, id: 开B.id, 退役实例: a.退役实例 });
      assert.deepEqual(收B.退役.map((x) => [x.实例, x.已退役]), [['consult-2', true]]);
      档案 = (await org.registry.identity()).members;
      assert.equal(档案['consult-2'].status, '封存');
      assert.equal(档案['member-a'].status, '在岗');
    } finally { await f.cleanup(); }
  });

  it('慢创建不占会审锁：创建进行中，另一场会审的作答不被阻塞', async () => {
    const { f, org } = await 起组织();
    try {
      const 挡 = await org.council.open({ subject: LEAD, 项目: P, 问题: 'A', 参与者: [MEMBER.id, 乙.id] });
      const a = 造适配器(org);
      const 原创建 = a.创建参与者;
      let 放行;
      const 门 = new Promise((r) => { 放行 = r; });
      let 已开始;
      const 开始 = new Promise((r) => { 已开始 = r; });
      a.创建参与者 = async (spec) => { 已开始(); await 门; return 原创建(spec); };
      const 开P = org.council.open({ subject: LEAD, 项目: P, 问题: 'B', 参与者: [MEMBER.id], 参与岗位: ['插件工程'], ...a });
      await 开始;
      const 答 = await Promise.race([
        org.council.answer({ subject: MEMBER, 项目: P, id: 挡.id, 结论: '锁外作答' }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('会审锁被慢创建占用')), 2000)),
      ]);
      assert.ok(答, '创建期间同项目会审仍可作答');
      放行();
      const 开 = await 开P;
      assert.equal(开.会审.参与者.length, 2);
    } finally { await f.cleanup(); }
  });

  it('父域：Lead 没有「写会审」权时，参与实例的作答被受控父判拒', async () => {
    const { f, org } = await 起组织();
    try {
      // 私有权限矩阵只加一条：Lead 对 会审 的 write 显式 deny。父判应把这条传给子实例。
      const 矩阵 = [
        '---', 'id: 权限矩阵', 'kind: 规则', 'authority: 法律', 'zone: 私有', 'domain: 集体', 'version: 1', '---',
        '# 权限矩阵', '', '## 机器可读授权块', '', '```policy',
        JSON.stringify({ grants: [{ subject: 'Lead', action: 'write', kind: '会审', verdict: 'deny', reason: '测试：Lead 无会审写权' }] }, null, 2),
        '```', '',
      ].join('\n');
      await f.writePrivate('集体L1-法律/权限矩阵.md', 矩阵);
      assert.equal(await f.policy.reload(), true, '前提：规则件合法');
      const a = 造适配器(org);
      const 开 = await org.council.open({ subject: LEAD, 项目: P, 问题: '父域', 参与者: [MEMBER.id], 参与岗位: ['插件工程'], ...a });
      await assert.rejects(
        () => org.council.answer({ subject: { id: 'consult-1', kind: '成员' }, 项目: P, id: 开.id, 结论: '父没有的权' }),
        (e) => e instanceof Denied && /受控父判/.test(e.rule),
        '委派不能派自己都没有的权',
      );
      assert.equal((await org.registry.identity()).members['consult-1'].会审绑定.会审, 开.id, '绑定已落，但写权仍受父判');
    } finally { await f.cleanup(); }
  });
});

describe('⑤ registry.assign 会审绑定分支', () => {
  it('落 会审/项目/来源会话/资料 + 生命周期；来源会话不可自报；重复同绑定幂等', async () => {
    const { f, org } = await 起组织();
    try {
      const 资料 = [join(f.home, 'brief.md')];
      const 一回 = await org.registry.assign({
        subject: LEAD, 岗位: '插件工程', 实例: 'm-bind',
        会审: { id: 'c-1', 项目: P, 资料, 来源会话: 'fake-session' },
      });
      assert.equal(一回.状态, '在岗');
      const 成员 = (await org.registry.identity()).members['m-bind'];
      assert.deepEqual(成员.会审绑定, { 会审: 'c-1', 项目: P, 来源会话: 'lead', 资料 });
      assert.equal(成员.生命周期.绑定会审, 'c-1');
      assert.ok(成员.生命周期.绑定时);
      assert.equal(成员.委派者.id, 'lead');

      const 幂等 = await org.registry.assign({ subject: LEAD, 岗位: '插件工程', 实例: 'm-bind', 会审: { id: 'c-1', 项目: P, 资料 } });
      assert.equal(幂等.幂等, true, '同绑定重复登记是幂等，不重置出生/绑定时间');

      const 快照 = readInstanceSnapshot(f.layout.identityFile());
      assert.equal(快照.ok, true);
      assert.deepEqual(快照.成员['m-bind'].会审绑定, 成员.会审绑定);
      assert.equal('会审绑定' in 快照.成员['member-a'], false, '无绑定成员不产出该字段');
    } finally { await f.cleanup(); }
  });

  it('改绑/解除/补绑/复核员/Lead 岗/节点互斥全部拒；seal/restore 保留绑定', async () => {
    const { f, org } = await 起组织();
    try {
      const 资料 = [join(f.home, 'brief.md')];
      await org.registry.assign({ subject: LEAD, 岗位: '插件工程', 实例: 'm-bind', 会审: { id: 'c-1', 项目: P, 资料 } });
      await assert.rejects(
        () => org.registry.assign({ subject: LEAD, 岗位: '插件工程', 实例: 'm-bind', 会审: { id: 'c-2', 项目: P, 资料 } }),
        (e) => e instanceof Denied && /不可静默改绑/.test(e.rule),
      );
      await assert.rejects(
        () => org.registry.assign({ subject: LEAD, 岗位: '插件工程', 实例: 'm-bind' }),
        (e) => e instanceof Denied && /不可静默解除/.test(e.rule),
      );
      await assert.rejects(
        () => org.registry.assign({ subject: LEAD, 岗位: '复核员', 实例: 'm-rev', 会审: { id: 'c-1', 项目: P, 资料 } }),
        (e) => e instanceof Denied && /只能是普通成员岗/.test(e.rule) && /复核员/.test(e.message),
      );
      await assert.rejects(
        () => org.registry.assign({ subject: LEAD, 岗位: 'Lead', 实例: 'm-lead', 会审: { id: 'c-1', 项目: P, 资料 } }),
        (e) => e instanceof Denied && /只能是普通成员岗/.test(e.rule),
      );
      await assert.rejects(
        () => org.registry.assign({ subject: LEAD, 岗位: '插件工程', 实例: 'm-node', 节点: 't-1', 会审: { id: 'c-1', 项目: P, 资料 } }),
        (e) => e instanceof InvalidBody && /不得同时绑定任务节点/.test(e.message),
      );
      await assert.rejects(
        () => org.registry.assign({ subject: MEMBER, 岗位: '插件工程', 实例: 'm-self', 会审: { id: 'c-1', 项目: P, 资料 } }),
        (e) => e instanceof Denied && /只有 Lead/.test(e.rule),
        '成员不得给任何实例落会审绑定（不自授）',
      );

      await org.registry.seal({ subject: LEAD, 实例: 'm-bind', 理由: '测试封存' });
      let 成员 = (await org.registry.identity()).members['m-bind'];
      assert.equal(成员.status, '封存');
      assert.equal(成员.会审绑定.会审, 'c-1', '封存保留绑定（退役归属可追）');
      await org.registry.restore({ subject: LEAD, 实例: 'm-bind' });
      成员 = (await org.registry.identity()).members['m-bind'];
      assert.equal(成员.status, '在岗');
      assert.equal(成员.会审绑定.会审, 'c-1', '复岗也不丢绑定');
    } finally { await f.cleanup(); }
  });

  it('显式 null = 无绑定；坏形状 = 带无效的对象（不折成无绑定）', async () => {
    const { f, org } = await 起组织();
    try {
      const 资料 = [join(f.home, 'brief.md')];
      await org.registry.assign({ subject: LEAD, 岗位: '插件工程', 实例: 'm-bind', 会审: { id: 'c-1', 项目: P, 资料 } });
      const 身份路径 = f.layout.identityFile();
      const 原 = JSON.parse(await readFile(身份路径, 'utf8'));
      // 显式 null：合同 = 无绑定（旧记录/未绑定的合法形态；只有 registry 会写这个键）。
      原.members['m-bind'].会审绑定 = null;
      await writeFile(身份路径, `${JSON.stringify(原, null, 2)}\n`, 'utf8');
      let 快照 = readInstanceSnapshot(身份路径);
      assert.equal('会审绑定' in 快照.成员['m-bind'], false, '显式 null 视为无绑定');

      // 坏形状（对象缺字段）：保留对象 + 无效原因，guard 必须按闭名单 fail-closed。
      原.members['m-bind'].会审绑定 = { 会审: 'c-1' };
      await writeFile(身份路径, `${JSON.stringify(原, null, 2)}\n`, 'utf8');
      快照 = readInstanceSnapshot(身份路径);
      assert.equal(快照.成员['m-bind'].会审绑定.会审, 'c-1');
      assert.match(String(快照.成员['m-bind'].会审绑定.无效), /项目/);
      assert.match(String(快照.成员['m-bind'].会审绑定.无效), /来源会话/);

      // 非对象同样不能折成无绑定：guard 必须看到对象并 fail-closed。
      原.members['m-bind'].会审绑定 = 'not-an-object';
      await writeFile(身份路径, `${JSON.stringify(原, null, 2)}\n`, 'utf8');
      快照 = readInstanceSnapshot(身份路径);
      assert.match(String(快照.成员['m-bind'].会审绑定.无效), /不是对象/);
    } finally { await f.cleanup(); }
  });
});
