/**
 * 设计评审修复批次 A 回归（对应 docs/归档/审查轮-2026-10/设计评审报告-dsh-mind-2026-10-15.md）。
 *
 * 覆盖：
 *  F1  memory_query 带 类 单选字符串打崩动作（服务层归一：字符串包数组）。
 *  F2  status 用错项目（org.status 接 本次调用项目键；内核提示段不再钉装配期项目）。
 *  F2b 动作层参数透传普查（649a4 / F1 / F2 三案同族的系统性检查，清单见下）。
 *  F5  零分歧空串坍缩（双空卷被折成「全票一致」触发人工抽检）。
 *  #13 historyFile 的 version 段不过校验（全文件唯一未校验的入口可控片段）。
 *  #15 identityStatus 缺 status 字段按在岗放行（与 #档案岗位Of 口径不一）。
 *
 * ── F2b 普查清单（lib/actions.js 全部 HANDLERS × kernel schema 的 58 参数；「项目」为重点列）──
 *  断链（本批修）：
 *   - status：修前不接 `项目`，org.status() 恒用装配期 this.project ⇒ F2。
 *   - policy_check：`项目` 修前读 args.project（模型面省略时恒 null）而不是 runAction
 *     解析出的 `项目`——同一个 schema 参数两套口径（status 同族）。已对齐；引擎当前
 *     不读 target.project，无行为差，纯口径统一防漂（回归用桩钉住 target.project 的接线）。
 *  文档性错标（本批改 schema 描述，不改行为）：
 *   - 描述：修前写着「task_create / task_pending」两用，而 task_pending 的 handler 读的是
 *     原因（服务层 markPending 的 待决原因）——照旧说明传参会静默落空。已改两处描述。
 *  消费（项目已线进服务调用，其余参数逐项核对）：
 *   - workbench：项目/审计条数/全量（全量对成员降级并如实标注）。
 *   - task_create（描述/负责人/判据/依赖/模式/项目）、task_reassign（id/负责人/项目）、
 *     task_dispatch / task_start（id/项目）、task_submit（id/结论/结论层/反例面/产出物引用/项目）、
 *     task_review（id/三态/分歧清单/反例面/复核者/项目，代签闸+复核员档案解析）、
 *     task_pending（id/原因/待决类型/项目）、task_resolve（id/决定/项目）、task_settle（id/项目）。
 *   - review_nominate（id/候选=实例/原因/项目）、review_exempt（id/授权引用/原因/项目）。
 *   - memory_write（类/内容/来源，依据兜底/岗位/标签/来源引用/任务/项目）、
 *     memory_query（类/岗位/文本/显式/含失效/limit/条数上限/项目——类 单选字符串在服务层归一，F1）。
 *   - capability_publish（名/正文/适用岗位/依据/任务/项目）。
 *   - bus_send（线程/收件/类型/内容/暂不投递/延后/引用/项目）、bus_read（线程/收件/未投递/limit/项目）、
 *     bus_deliver（线程/id/项目）、bus_unlock（id/线程/收件=参与者/内容/项目）。
 *   - debate_open / debate_say / debate_round / debate_converge（id/类型/内容/项目）。
 *   - review_zero（id/项目）。
 *  显式忽略（跨项目设计，注释在位）：
 *   - memory_lineage：血缘跨项目（#folded 全 scope 扫，判定 target 的 project 恒 null）。
 *   - memory_lifecycle 的 purge / promote：物理删除/跨项目晋升按条目自身 entry.项目 落账；
 *     invalidate/demote/overturn 走 取任务上下文（含项目）。
 *   - capability_list / resolve / read：能力库跨项目（§7）；消费 岗位/来源/名/id。
 *   - audit_tail / audit_verify / audit_correct：审计链跨项目只增；消费 档位/limit/id/原因/授权引用。
 *   - store_rollback：对象库与版本历史不按项目分片；消费 对象类/id/version/依据。
 *   - registry_list / can / assign / seal / revoke：身份与岗位不按项目隔离（§7）；
 *     消费 id/岗位/实例/代/授权引用/原因。
 *   - upgrade_pending：跨项目，无参数消费。
 *   - presence / sovereign_interaction（命令面专属）：消费 开关/小时（不在工具 schema）；无项目语义。
 *  runAction 层消费（不在单个 handler 里）：
 *   - role / 实例：门① 拒 role='Lead'；两者只进拒绝 detail，不参与主体构造（P2 之后主体必由宿主给）。
 *   - 发件：显式忽略（W2：发件人恒为真实主体 id，schema 描述已注明）。
 *
 * 塞 bug 校准：F1 / F2 / F5 三条在副本仓做过「塞回坏码 ⇒ 本文件对应断言必红 ⇒ 还原 ⇒ 必绿」，
 * 校准读数（几红/几绿）见批次 A 交付报告；原仓零写入。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFixture, writeUnder, LEAD } from './helpers.mjs';
import { fakeHost, fakeExec } from './host-harness.mjs';
import { Org } from '../src/org.js';
import { runAction } from '../lib/actions.js';
import { identityStatus } from '../src/policy.js';
import { judgeZeroDivergence } from '../src/review.js';
import { InvalidBody } from '../src/kernel/errors.js';
import * as plugin from '../components/kernel/lib/index.js';

const P = 'default';
const here = dirname(fileURLToPath(import.meta.url));
const FACTORY = join(here, '..', 'mind');

async function 起组织(project = P) {
  const fixture = await makeFixture();
  const org = await Org.open({ home: fixture.home, factoryRoot: fixture.factoryRoot, privateRoot: fixture.privateRoot, project });
  return { fixture, org };
}

/** 造一个双负责人独立会审节点：两人各交一份（卷可空对象 = 结论/结论层全空的「空卷」）。 */
async function 会审节点(org, 卷A = {}, 卷B = {}) {
  const { id } = await org.tasks.create({ subject: LEAD, 项目: P, 描述: `会审-${Math.random().toString(36).slice(2, 7)}`, 负责人: ['member-a', 'member-b'], 判据: ['判据一'], 模式: '独立会审' });
  await org.tasks.dispatch(id, { subject: LEAD, 项目: P });
  await org.tasks.start(id, { subject: { id: 'member-a', kind: '成员' }, 项目: P });
  await org.tasks.submit(id, { subject: { id: 'member-a', kind: '成员' }, 项目: P, ...卷A });
  await org.tasks.submit(id, { subject: { id: 'member-b', kind: '成员' }, 项目: P, ...卷B });
  return id;
}

describe('设计评审 2026-10-15 · F1：memory_query 的 类 是单选字符串，不许打崩动作', () => {
  it('runAction 面：类:"知识"（schema 合法单选）⇒ 成功返回，口径范围只有 知识，命中无其它类', async () => {
    const { fixture, org } = await 起组织();
    try {
      // 两类各一条，共用同一检索词——修前（字符串直传）这一步就是 TypeError。
      await org.memory.remember({ subject: LEAD, 类: '知识', 内容: '发布前端口冻结是硬门槛', 来源: '测试', 项目: P });
      await org.memory.remember({ subject: LEAD, 类: '经历', 内容: '端口冻结那次我们翻车了', 来源: '测试', 项目: P });

      const r = await runAction({ org, 项目: P, subject: LEAD, 主体: LEAD, args: { action: 'memory_query', 类: '知识', 文本: '端口冻结' } });
      assert.equal(r.action, 'memory_query', '经动作面跑通（修前在这里抛 TypeError：wanted.join is not a function）');
      assert.ok(r.结果.命中.length >= 1, `知识类条目要能命中；实际 ${JSON.stringify(r.结果.命中)}`);
      assert.ok(r.结果.命中.every((h) => h.标签?.[0] === '知识'), '命中里只许有 知识 类（标签首位 = 条目类）');
      assert.match(r.结果.口径.范围, /^知识(@|$)/, `口径范围只报 知识；实际 ${r.结果.口径.范围}`);
      assert.ok(!r.结果.口径.范围.includes('经历'), '范围不许把 经历 折进来');

      // 无文本面（浏览分支同样消费 wanted）：条目全部是 知识，范围是单个类名。
      const browse = await runAction({ org, 项目: P, subject: LEAD, 主体: LEAD, args: { action: 'memory_query', 类: '知识' } });
      assert.ok(browse.结果.条目.length >= 1 && browse.结果.条目.every((e) => e.类 === '知识'), '无文本分支同样只回 知识 类条目');
      assert.equal(browse.结果.口径.范围, '知识', `浏览分支的范围是单个类名；实际 ${browse.结果.口径.范围}`);
    } finally {
      await fixture.cleanup();
    }
  });

  it('工具面端到端：经 schema 真装配，memory_query 类:"知识" ⇒ 成功:true', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mind-f1-tool-'));
    await writeUnder(home, 'mind-private/README.md', '# 私有区（测试）\n');
    const host = fakeHost();
    try {
      await plugin.apply(host.ctx, { home, factoryRoot: FACTORY, privateRoot: join(home, 'mind-private') });
      const tool = host.工具.get('mind');
      const 根 = fakeExec({ name: 'mind' });
      for (const [类, 内容] of [['知识', '发布规程要求先冻结端口'], ['经历', '冻结端口晚了导致回滚']]) {
        const w = JSON.parse(await tool.execute({ action: 'memory_write', 类, 内容, 来源: '测试', project: 'proj-f1-tool' }, 根));
        assert.equal(w.成功, true, `写入 ${类} 要成功：${JSON.stringify(w)}`);
      }
      const q = JSON.parse(await tool.execute({ action: 'memory_query', 类: '知识', 文本: '冻结端口', project: 'proj-f1-tool' }, 根));
      assert.equal(q.成功, true, `schema 单选字符串不许打崩工具面；实际 ${JSON.stringify(q).slice(0, 300)}`);
      assert.match(q.结果.口径.范围, /^知识@/, `工具面口径范围 = 知识@项目；实际 ${q.结果.口径.范围}`);
      assert.ok(q.结果.命中.length >= 1 && q.结果.命中.every((h) => h.标签?.[0] === '知识'), '命中只许 知识 类');
    } finally {
      host.清理();
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
    }
  });
});

describe('设计评审 2026-10-15 · F2：status 按本次调用的项目键自述（不再拿装配期 default 答别的项目）', () => {
  it('双项目：status(项目X) 的任务数 === workbench(项目X) 的任务数，返回体 项目===X；default 侧不受牵连', async () => {
    const PX = 'proj-status-x';
    const { fixture, org } = await 起组织('default');
    try {
      await org.tasks.create({ subject: LEAD, 项目: PX, 描述: 'X 项目任务一', 负责人: 'lead', 判据: ['判据一'] });
      await org.tasks.create({ subject: LEAD, 项目: PX, 描述: 'X 项目任务二', 负责人: 'lead', 判据: ['判据一'] });
      await org.memory.remember({ subject: LEAD, 类: '知识', 内容: 'X 项目自己的知识', 来源: '测试', 项目: PX });

      const st = await runAction({ org, 项目: PX, subject: LEAD, 主体: LEAD, args: { action: 'status', project: PX } });
      assert.equal(st.数据.项目, PX, `返回体要报本次调用的项目；实际 ${st.数据.项目}（修前恒报装配期 default）`);
      const wb = await runAction({ org, 项目: PX, subject: LEAD, 主体: LEAD, args: { action: 'workbench', project: PX } });
      assert.equal(st.数据.任务, wb.数据.任务.总数, `status 的任务数与 workbench 同口径；status ${st.数据.任务} / workbench ${wb.数据.任务.总数}`);
      assert.equal(st.数据.任务, 2, 'X 项目两张卡都要数到');
      assert.equal(st.数据.记忆.按类.知识, 1, '记忆行同样按本次项目取数（X 项目一条知识）');

      // 对照臂：default（装配期项目）没有这些账——修前 status 正是把 default 的 0 报给 X 的调用方。
      const stDefault = await runAction({ org, 项目: 'default', subject: LEAD, 主体: LEAD, args: { action: 'status' } });
      assert.equal(stDefault.数据.项目, 'default');
      assert.equal(stDefault.数据.任务, 0, 'default 侧计数不受 X 项目影响');
      assert.equal(stDefault.数据.记忆.按类.知识, 0, 'default 侧记忆计数不受 X 项目影响');
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('设计评审 2026-10-15 · F2b：policy_check 的 target.project 线进 runAction 解析的项目', () => {
  it('省略 project 参数 ⇒ target.project 取解析项目；显式 project 优先（语义不变）', async () => {
    const 收到 = [];
    const 桩org = {
      policy: {
        decide: async (input) => {
          收到.push(input);
          return { verdict: 'allow', rule: '测试桩', reason: '' };
        },
      },
    };
    await runAction({ org: 桩org, 项目: 'proj-b', subject: LEAD, 主体: LEAD, args: { action: 'policy_check', 动作: 'read', target: { id: 't1', kind: '记忆' } } });
    assert.equal(收到[0].target.project, 'proj-b', '省略 project 时，判定 target 的 project 维取 runAction 解析的项目键（修前读 args.project，恒 null）');

    await runAction({ org: 桩org, 项目: 'proj-b', subject: LEAD, 主体: LEAD, args: { action: 'policy_check', 动作: 'read', target: { id: 't2', kind: '记忆' }, project: 'proj-c' } });
    assert.equal(收到[1].target.project, 'proj-c', '显式 project 参数照旧优先（args.project ?? spec.项目 的既有解析不变）');
  });
});

describe('设计评审 2026-10-15 · F5：空卷不构成零分歧（双空卷 ≠ 全票一致）', () => {
  it('纯函数：双空卷 ⇒ 零分歧:false + 空卷数:2；空串不入结论层集合；正对照照旧 true', () => {
    const 空 = judgeZeroDivergence([{ 成员: 'a' }, { 成员: 'b' }]);
    assert.equal(空.零分歧, false, '两份全空卷不许判「全票一致」（修前空串折叠成长度 1 的集合 ⇒ 误报）');
    assert.equal(空.空卷数, 2, '空卷数要看得见（为什么不判）');
    assert.deepEqual(空.结论层, [], '空串不入集合');
    assert.match(空.依据, /空卷/, '依据要点名空卷');

    const 一空一实 = judgeZeroDivergence([{ 成员: 'a', 结论层: '方案A' }, { 成员: 'b' }]);
    assert.equal(一空一实.零分歧, false);
    assert.equal(一空一实.空卷数, 1);
    assert.deepEqual(一空一实.结论层, ['方案A'], '非空结论层照常入集，空的那份由 空卷数 报');

    const 正 = judgeZeroDivergence([{ 成员: 'a', 结论层: '方案A', 结论: '甲' }, { 成员: 'b', 结论层: '方案A', 结论: '乙' }]);
    assert.equal(正.零分歧, true, '正对照：同结论层非空且无反例 ⇒ 照旧报警');
    assert.equal(正.空卷数, 0);
  });

  it('服务面：双空卷会审（v2 作答）⇒ 不报零分歧、不入「零分歧异常」账，存档照实标 false', async () => {
    const { fixture, org } = await 起组织();
    try {
      // 空卷 = 结论层与结论都为空。v2 作答必填结论，所以「空卷」只剩结论层为空这一种形态
      // （judgeZeroDivergence 的空卷判据：结论层 ?? 结论 ⇒ '' 不回落）。
      const 开 = await org.council.open({ subject: LEAD, 项目: P, 问题: '双空卷', 参与者: ['member-a', 'member-b'] });
      await org.council.answer({ subject: { id: 'member-a', kind: '成员', roleId: '插件工程' }, 项目: P, id: 开.id, 结论: '甲的独立答案', 结论层: '' });
      await org.council.answer({ subject: { id: 'member-b', kind: '成员', roleId: '插件工程' }, 项目: P, id: 开.id, 结论: '乙的独立答案', 结论层: '' });
      await org.council.unlock({ subject: LEAD, 项目: P, id: 开.id });
      const r = await org.council.converge({ subject: LEAD, 项目: P, id: 开.id });
      assert.equal(r.零分歧, false, '两份空卷 ⇒ 不构成零分歧');
      assert.match(r.零分歧依据, /空卷 2 份/, '读数要让读者看见「为什么不判」');
      const 报警行 = (await org.audit.read({})).filter((row) => row.动作 === '零分歧异常' && row.对象?.id === 开.id);
      assert.equal(报警行.length, 0, `空卷会审不许落「零分歧异常」审计；实际 ${JSON.stringify(报警行)}`);

      const wb = await runAction({ org, 项目: P, subject: LEAD, 主体: LEAD, args: { action: 'workbench' } });
      const 行 = wb.数据.会审.find((s) => s.id === 开.id);
      assert.ok(行, '会审存档行要在投影里');
      assert.equal(行.零分歧, false, '投影侧同样不判（照搬存档布尔）');
      assert.equal(行.状态, '已收敛');
    } finally {
      await fixture.cleanup();
    }
  });

  it('正对照：同结论层非空 ⇒ 零分歧:true 照旧，空卷数:0（P1-2 语义不回退）', async () => {
    const { fixture, org } = await 起组织();
    try {
      const id = await 会审节点(org, { 结论: '甲的独立答案', 结论层: '方案A' }, { 结论: '乙的独立答案', 结论层: '方案A' });
      const r = await org.review.checkZeroDivergence({ subject: LEAD, 项目: P, 节点: id });
      assert.equal(r.零分歧, true, `负责人结论层一致且无反例 ⇒ 必须照旧报警；实际 ${JSON.stringify(r)}`);
      assert.equal(r.空卷数, 0);
      const 报警行 = (await org.audit.read({})).filter((row) => row.动作 === '零分歧异常' && row.对象?.id === id);
      assert.equal(报警行.length, 1, '正对照照常入账（修判据不拆报警）');
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('设计评审 2026-10-15 · #13：historyFile 的 version 段过路径校验', () => {
  it("version='../../x' ⇒ 拒；'2' 与数字 2 照常", async () => {
    const f = await makeFixture();
    try {
      for (const bad of ['../../x', 'a/b', '..', '']) {
        assert.throws(() => f.layout.historyFile('cap-x', bad), InvalidBody, `version=${JSON.stringify(bad)} 必须按路径段校验拒`);
      }
      const ok = f.layout.historyFile('cap-x', '2').replace(/\\/g, '/');
      assert.ok(ok.endsWith('版本历史/cap-x/2.md'), `正常版本号照常拼路径；实际 ${ok}`);
      assert.ok(f.layout.historyFile('cap-x', 2).replace(/\\/g, '/').endsWith('版本历史/cap-x/2.md'), '数字版本号（schema 声明 type:number）经 String 归一照常');
    } finally {
      await f.cleanup();
    }
  });
});

describe('设计评审 2026-10-15 · #15：identityStatus 缺 status 按最严（与 #档案岗位Of 同口径）', () => {
  it('档案行只有 id+岗位、无 status ⇒ 判「状态缺失」拒绝；同表显式在岗的实例照常过', async () => {
    const f = await makeFixture({
      members: {
        // 夹具注记（#15 回归）：member-x 有意**不写 status**——这正是要测的形态；
        // member-ok 显式在岗，作同表对照。
        'member-x': { id: 'member-x', 岗位: '插件工程' },
        'member-ok': { id: 'member-ok', 岗位: '插件工程', 代: 1, status: '在岗' },
      },
    });
    try {
      const 缺 = identityStatus(f.policy, 'member-x');
      assert.equal(缺.known, true, '在册要如实说在册（known 只答「查得到查不到」）');
      assert.equal(缺.status, '状态缺失', `结论字段要点名缺状态；实际 ${缺.status}`);
      assert.match(缺.reason, /status|最严/, '理由要说清按最严处理');

      // 判定面：成员主体过引擎 ⇒ 拒（修前 status 缺席落「在岗」放行）。
      const decision = await f.policy.decide({
        subject: { id: 'member-x', kind: '成员' },
        action: 'read',
        target: { id: '记忆/检索/x', kind: '记忆', authority: '自治', zone: '私有', domain: '集体' },
        context: {},
      });
      assert.equal(decision.verdict, 'deny', '缺 status 的成员必须被拒（查不到 = 最严）');
      assert.match(decision.reason, /状态缺失|最严/, `拒因落在身份那一条；实际 ${decision.reason}`);

      // 对照：同表显式在岗 ⇒ 身份闸放行（判到别的规则是另一回事，这里只钉身份闸）。
      const okStatus = identityStatus(f.policy, 'member-ok');
      assert.equal(okStatus.status, '在岗');
      assert.equal(okStatus.reason, '');
    } finally {
      await f.cleanup();
    }
  });
});
