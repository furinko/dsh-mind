/**
 * 「Lead 身份落在可自报字段上」回归（2026-10-10 独立复核攻破 · 主人已拍，本批修）。
 *
 * 攻破形态（复核 runAction 级=确认，本文件把**攻击原样钉成**判据）：
 *  - **门①**：`runAction({ subject: {kind:'Lead'}, args: {action:'debate_round', id:节点, role:'Lead'} })`
 *    ⇒ **放行**（轮次 1→2）。根因：`lib/actions.js` 主体构造回落到
 *    `subjectFor({ 岗位: args.role })`，而 `subjectFor` 的 `岗位 === 'Lead'` 一档直接给出
 *    `{kind:'Lead'}` ⇒ **模型自己填一个参数就能声明自己是 Lead**。
 *  - **门②**：`components/kernel/lib/index.js` 的 `agentSubject(exec)` 恒传
 *    `根会话: true`（一个**常量**）⇒ 任何会话（含成员子会话）的 subject 都是 `{kind:'Lead'}`
 *    ⇒ `debate_round` / `debate_converge` 的「仅 Lead」判据在模型可达面**完全不承重**。
 *
 * 两道门的关系：门① 堵「参数声明」，门② 堵「会话事实读错」。缺一门都能被那样打。
 *
 * 判据（每条都带反例面 / 正对照）：
 *  1. `args.role === 'Lead'` ⇒ 拒（**先于** `spec.主体` 判定：声明本身就是越界）；
 *     **正对照**：显式声明成员岗位（`role:'插件工程', 实例:'member-a'`）⇒ 仍放行。
 *  2. `agentSubject`：子会话（`origin:'subagent'` / `delegationDepth>=1`）⇒ **不是 Lead**；
 *     根会话 ⇒ **是 Lead**（正对照）；`exec.agent.session` 取不到 ⇒ **不是 Lead**（fail-closed）。
 *  3. 端到端（经 `mind` 工具的模型可达面）：子会话主体调 `debate_round` / `debate_converge`
 *     ⇒ 拒；根会话 ⇒ 放行（正对照，且真推进轮次 / 真收敛）。
 *     ⚠️ **这条的「拒」落在主体链的档案校验那一道**（会话派生的实例键**不在身份档案里** ⇒ 最严拒），
 *     **早于** debate 服务的「仅 Lead」；「仅 Lead」那一层由 ⑤（服务面 · 已登记成员直调）与
 *     ⑱ 的既有回归背书。别把 ③ 读成「debate 层在模型可达面被验过」。
 *     （⚠️ A 落地后**仍是拒**，但机制换了：以前是「roleId 哨兵值与档案岗位对不上」，
 *      现在是「这个实例键压根没登记进档案」。同一读数、不同理由 —— 这条用例断言的是前者那句
 *      `/未登记/`，A 落地时按机制改成 `/没有登记/`，判据本体「子会话不是 Lead」一字未动。）
 *     ⚠️ 造「两份答案」的前置只能走**服务面**（工具面主体由会话事实唯一决定 ⇒ `args.实例`
 *     不再记名，连交两次会折叠成 1 份）——读数与理由写在 ③ 前置那段注释里。
 *  4. 每条被拒的判据**同时**断言「副作用没发生」：轮次未推进 / 无轮边界消息落线 / 讨论未收敛。
 *  5. **A 落地（2026-10-10 · 主人拍板的路径，本文件末尾的 `A 落地` 段）**：
 *     ① Lead 用 `registry_assign` **显式登记**该子会话（实例 = 它的会话 id）；
 *     ② 内核一格：`src/org.js` 的 `subjectFor` 最后一档（会话派生）**不填 `roleId`**
 *     ⇒ `lib/actions.js:148` 的岗位对账 `member.岗位 !== 主体.roleId` 第三段短路
 *     ⇒ 语义变成「**在册且在岗即可，岗位以档案为准**」。
 *     A-1 登记后放行（主体形状 `{id, kind:'成员'}`，无 `roleId`）/ A-2 未登记仍拒（fail-closed）/
 *     A-3 自报岗位仍要档案一致（门① 的成果，一格不放）/ A-4 根会话不受影响（仍是 Lead）。
 *     ⚠️ 本段**改的是判据本体的语义**（第三段判据所指的对象从「哨兵值 `未登记`」变成「主体自陈的
 *     岗位」），不是为了让测试变绿而放宽断言：旧用例里那条「登记成真岗位也仍拒」钉的正是
 *     「会话派生的 roleId 恒为哨兵值」这个缺陷，而那个缺陷**就是本批要治的东西**。
 *
 * ⚠️ **诚实边界**（别把本文件的绿读成比它更大的结论）：
 *  · 门② 的判据只到**代码路径级**：真实宿主会话里 `header.origin` / `parentSession` 的
 *    实际形态**未在真实运行态验证过**（本轮没有起真会话）。本文件用的是**桩 exec**。
 *  · 未取证的那一格（**`agent` 在、会话事实缺席** —— 命令行那条路没带 agent 的形态）
 *    **沿用修前读数 Lead**：为不动 15 处既有夹具（host.test.js / integration.test.js /
 *    presence*.test.js / host-routes.test.js 的裸 `{}`）而刻意保留，是 fail-open 的残留面，
 *    已如实记进 `docs/设计债-2026-10-09.md` ⑳。**本轮堵的是「子会话恒 Lead」那一格。**
 *  · 门② 只管内核 `mind` 工具 / `/mind` 命令这一条主体链。`components/guard` 自己
 *    硬编码 `subjectFor({ 根会话: true })`（guard/lib/index.js:102,118）——**本轮未改**，
 *    它的 `upgrade_resolve` 仍以 Lead 执行（见回报的影响面清点）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, LEAD } from './helpers.mjs';
import { DebateService, ROUND_BOUNDARY_MARK } from '../src/debate.js';
import { TaskGraph } from '../src/tasks.js';
import { MessageBus } from '../src/bus.js';
import { ReviewProtocol } from '../src/review.js';
import { RoleRegistry } from '../src/registry.js';
import { subjectFor } from '../src/org.js';
import { runAction } from '../lib/actions.js';
import * as kernel from '../components/kernel/lib/index.js';
import { fakeHost } from './host-harness.mjs';
import { shareOrg, forgetSharedOrg } from '../src/runtime.js';

const P = 'default';
const MEMBER_A = { id: 'member-a', kind: '成员', roleId: '插件工程' };
const MEMBER_B = { id: 'member-b', kind: '成员', roleId: '插件工程' };

/** 与 `org.open` 同款接线（本次不用 debate.open 的随机性，故 random 固定成常数）。 */
function 装配(g) {
  const tasks = new TaskGraph({ layout: g.layout, policy: g.policy, audit: g.audit, clock: g.clock });
  const bus = new MessageBus({ layout: g.layout, policy: g.policy, audit: g.audit, clock: g.clock });
  const registry = new RoleRegistry({ layout: g.layout, policy: g.policy, audit: g.audit, clock: g.clock });
  const review = new ReviewProtocol({ layout: g.layout, policy: g.policy, audit: g.audit, clock: g.clock, tasks, bus, random: () => 0 });
  const debate = new DebateService({ layout: g.layout, policy: g.policy, audit: g.audit, clock: g.clock, tasks, bus, review, registry });
  return { tasks, bus, registry, review, debate };
}

/** 造一个已交齐的双人会审节点（前置与 debate-guards 同款）。 */
async function 交齐会审(tasks) {
  const node = await tasks.create({
    subject: LEAD, 项目: P, 描述: 'Lead 身份回归', 负责人: [MEMBER_A.id, MEMBER_B.id], 判据: ['结论一致'], 模式: '独立会审',
  });
  await tasks.dispatch(node.id, { subject: LEAD, 项目: P });
  await tasks.start(node.id, { subject: MEMBER_A, 项目: P });
  for (const s of [MEMBER_A, MEMBER_B]) await tasks.submit(node.id, { subject: s, 项目: P, 结论: `${s.id} 案` });
  return node.id;
}

/**
 * 动作面的最小 org：**`registry` 必须在**，因为主体链要拿它做身份档案校验
 * （成员/复核者一律过档 —— 判据「role:'插件工程' 正对照仍放行」靠的就是这一步）。
 */
function 动作面org(parts) {
  return { registry: parts.registry, tasks: parts.tasks, bus: parts.bus, debate: parts.debate };
}

/** 当前轮次 / 状态 / 轮边界消息数（三条「副作用没发生」的读数）。 */
async function 读数(parts, 节点) {
  const n = await parts.tasks.get(节点, { 项目: P });
  const 消息 = await parts.bus.readRaw({ 项目: P, 线程: 节点 });
  return {
    轮次: n.讨论?.轮次 ?? null,
    状态: n.讨论?.状态 ?? null,
    表态消息id: n.讨论?.表态消息id ?? null,
    边界条数: 消息.filter((m) => String(m.内容 ?? '').startsWith(ROUND_BOUNDARY_MARK)).length,
    消息总数: 消息.length,
  };
}

/**
 * 桩 exec：内核 `agentSubject` 认的就是这几个字段
 * （真形状 @deepseek-ai/dsh-session lib/types/types.d.ts:58-87 —— `session.id` 与
 * `session.header` 是**两处**，`header.id` 才是「会话 id 的镜像」，别混）。
 */
function 桩exec(header, id = 'session-root-0001') {
  return { name: 'mind', agent: { session: { id, header: { id, ...header } } } };
}
const 根会话exec = 桩exec({ cwd: 'C:/ws', createdAt: 1, isSeeded: false, version: 1 });
const 成员会话exec = 桩exec(
  { cwd: 'C:/ws', createdAt: 2, isSeeded: false, version: 1, origin: 'subagent', parentSession: 'session-root-0001', delegationDepth: 1 },
  'session-child-0002',
);
/** 第二个成员会话：独立会审的两份答案按**主体 id** 去重，所以两份要来自两个会话。 */
const 成员会话exec2 = 桩exec(
  { cwd: 'C:/ws', createdAt: 3, isSeeded: false, version: 1, origin: 'subagent', parentSession: 'session-root-0001', delegationDepth: 1 },
  'session-child-0003',
);

/** 起一个真装配的宿主（真出厂件 + 临时私有区），拿到 `mind` 工具。 */
async function 起宿主(g) {
  const host = fakeHost();
  await kernel.apply(host.ctx, { home: g.home, factoryRoot: g.factoryRoot, privateRoot: g.privateRoot });
  const org = await shareOrg({ home: g.home, factoryRoot: g.factoryRoot, privateRoot: g.privateRoot });
  await org.policy.reload();
  return { host, org, 工具: host.工具.get('mind') };
}

/**
 * 经**模型可达面**读 `agentSubject` 算出来的主体。
 *
 * 三种读数都要读得到，因为**「主体算错」与「主体对但身份没登记」都会以「放行/拒绝」的形态出现**：
 *  · 算成 Lead ⇒ `runAction` 放行 ⇒ 结果里有 `主体`；
 *  · 算成成员、但它的实例键**不在身份档案里**（或不在岗）⇒ 主体链的档案校验先拒
 *    ⇒ 结果里是拒绝文案（**没有** `主体` 字段）；
 *  · 算成成员、且**在册在岗**（A 落地后的正常一格）⇒ 放行 ⇒ 结果里有 `主体`
 *    （形状 `{id, kind:'成员', roleId:null}`，岗位在档案里不在主体上）。
 * 所以取「成功与否 + 主体（若有）+ 规则（若有）」三条，判据自己按需断言。
 */
async function 主体读数(工具, exec) {
  return JSON.parse(await 工具.execute({ action: 'status' }, exec));
}
/** 断言这条读数是「放行」，并返回主体。 */
function 放行主体(读数) {
  assert.equal(读数.成功, true, `这条读数的期望是放行，实际：${JSON.stringify(读数)}`);
  return 读数.主体;
}

describe('门① 主体构造：Lead 身份不由参数声明（2026-10-10）', () => {
  it('①-回归：args.role=Lead ⇒ 拒（改前放行、轮次 1→2）；且轮次未推进、无边界消息落线', async () => {
    const g = await makeFixture();
    try {
      const parts = 装配(g);
      const 节点 = await 交齐会审(parts.tasks);
      await parts.debate.open({ subject: LEAD, 项目: P, 节点 });
      const 前 = await 读数(parts, 节点);
      assert.equal(前.轮次, 1, '前提：讨论开在第 1 轮');

      // 攻击原样：subject 是 Lead（工具面真实形态），args 里自报 role:'Lead'。
      await assert.rejects(
        () => runAction({
          org: 动作面org(parts), 项目: P, subject: LEAD,
          args: { action: 'debate_round', id: 节点, role: 'Lead' },
        }),
        (e) => e.name === 'Denied'
          && /Lead 身份由会话事实决定，不由参数声明/.test(e.rule)
          && /自报字段/.test(e.message)
          && typeof e.howToChange === 'string' && /根会话/.test(e.howToChange),
        '修前：这里回落到 subjectFor({岗位:"Lead"}) ⇒ 自报即成真 ⇒ 放行并推进轮次',
      );

      const 后 = await 读数(parts, 节点);
      assert.equal(后.轮次, 1, '被拒的换轮没有推进轮次（不是纸面拒绝）');
      assert.equal(后.边界条数, 0, '被拒的换轮没有落轮边界消息 ⇒ 两道预算没被重置');
      assert.equal(后.消息总数, 前.消息总数, '被拒的调用一条消息都没落线');
    } finally {
      await g.cleanup();
    }
  });

  it('①-回归·攻击变体：role=Lead + 实例自报 ⇒ 同样拒（换实例名不能绕）', async () => {
    const g = await makeFixture();
    try {
      const parts = 装配(g);
      const 节点 = await 交齐会审(parts.tasks);
      await parts.debate.open({ subject: LEAD, 项目: P, 节点 });

      await assert.rejects(
        () => runAction({
          org: 动作面org(parts), 项目: P, subject: LEAD,
          args: { action: 'debate_round', id: 节点, role: 'Lead', 实例: 'member-b' },
        }),
        (e) => e.name === 'Denied' && /不由参数声明/.test(e.rule),
        '复核实测的另一形态：role=Lead + 实例=member-b 也放行 —— 一并堵',
      );
      assert.equal((await 读数(parts, 节点)).轮次, 1, '轮次未推进');

      // 收敛口同样堵（同一个主体构造，两个动作都靠它）。
      await assert.rejects(
        () => runAction({
          org: 动作面org(parts), 项目: P, subject: LEAD,
          args: { action: 'debate_converge', id: 节点, role: 'Lead' },
        }),
        (e) => e.name === 'Denied' && /不由参数声明/.test(e.rule),
        'debate_converge 与 debate_round 共用主体构造 ⇒ 同一个洞',
      );
      const 收 = await 读数(parts, 节点);
      assert.equal(收.状态, '讨论中', '被拒的收敛没有把讨论改成已收敛');
      assert.equal(收.表态消息id, null, '被拒的收敛没有落末位表态（表态消息id 仍为空）');
    } finally {
      await g.cleanup();
    }
  });

  it('①-正对照：显式声明**在册在岗成员**（主体由宿主给：member-a / 插件工程）⇒ 仍放行', async () => {
    const g = await makeFixture();
    try {
      const parts = 装配(g);
      const 节点 = await 交齐会审(parts.tasks);
      await parts.debate.open({ subject: LEAD, 项目: P, 节点 });
      // P2（2026-10-10）后成员身份**只能由宿主显式给**（`主体`）。args 里的 `role`/`实例`
      // 仍然照旧填着 —— 现在它们一个字都不参与构造（留着的意义就是钉住这一点）。
      const 发言 = await runAction({
        org: 动作面org(parts), 项目: P, subject: LEAD, 主体: MEMBER_A,
        args: { action: 'debate_say', id: 节点, role: '插件工程', 实例: 'member-a', 类型: '表态', 内容: '成员照常发言' },
      });
      assert.equal(发言.主体.kind, '成员', '成员身份仍按身份档案构造（门① 不误伤成员这条路）');
      assert.equal(发言.主体.roleId, '插件工程');
      assert.equal(发言.发言.本轮消息数, 1, '成员发言真落线并计入本轮（不是「全拒」换来的安全）');
    } finally {
      await g.cleanup();
    }
  });

  it('①-反例面：`spec.主体` 优先的可信路径**不受影响**（命令面记真实主体那一条）', async () => {
    const g = await makeFixture();
    try {
      const parts = 装配(g);
      const 节点 = await 交齐会审(parts.tasks);
      await parts.debate.open({ subject: LEAD, 项目: P, 节点 });
      // 命令面显式给主体（宿主注入的可信路径）：轮次照常推进 —— 门① 不许把这条路也堵了。
      const 换 = await runAction({
        org: 动作面org(parts), 项目: P, subject: LEAD, 主体: LEAD,
        args: { action: 'debate_round', id: 节点 },
      });
      assert.equal(换.讨论.轮次, 2, 'spec.主体 优先那条路原样可用（Lead 换轮仍放行）');
      // 但同一调用里顺带自报 Lead 仍拒：声明本身越界，撞上可信路径也不变成合法。
      await assert.rejects(
        () => runAction({
          org: 动作面org(parts), 项目: P, subject: LEAD, 主体: LEAD,
          args: { action: 'debate_round', id: 节点, role: 'Lead' },
        }),
        (e) => e.name === 'Denied' && /不由参数声明/.test(e.rule),
        '有 spec.主体 也拒：门① 先于主体优先级判定',
      );
    } finally {
      await g.cleanup();
    }
  });
});

describe('门② agentSubject：Lead 身份由会话事实决定（2026-10-10）', () => {
  it('②-判据本体：根会话 ⇒ Lead（正对照）；子会话 ⇒ 不是 Lead；exec 取不到 ⇒ 不是 Lead', async () => {
    const g = await makeFixture();
    try {
      const { 工具, host } = await 起宿主(g);
      try {
        // 正对照：无父会话的顶层会话 ⇒ Lead（既有的「根会话执行者 = Lead」语义没被改坏）。
        const 根 = 放行主体(await 主体读数(工具, 根会话exec));
        assert.equal(根.kind, 'Lead', `根会话仍是 Lead（门② 不是把 Lead 一起取消了）；实际 ${JSON.stringify(根)}`);
        // ⚠️ 实例键（**B 修 · 2026-10-10 改断言**）：判据本体的语义变了 —— 实例键的用途是
        // 「唯一标识**哪一个会话**」，修前那条 `'session-' + String(会话id).slice(0,8)`
        // 在真实形状（`session-<uuid>`）下恒退化成 `session-session-`，一位信息都不带。
        // 所以这里断言的是**会话 id 原样**，不是为了让测试变绿而放宽（旧断言的"绿"本身
        // 就是钉住一个坏读数）。完整论证与影响面清点见 ㉒。
        assert.equal(根.id, String(根会话exec.agent.session.id), `实例键 = 会话 id 原样（唯一标识会话）；实际 ${JSON.stringify(根)}`);

        // 子会话：origin=subagent（本仓四处同款判据用的就是它）⇒ 不是 Lead。
        // 这一条**不可能**放行：算成成员后，只要它的实例键不在身份档案里，主体链就拒它 ——
        // 于是「不是 Lead」的可观察形态就是「被拒」，且拒绝理由是身份那一条（而不是别的闸）。
        // ⚠️ A 落地后拒绝的**机制**换了（以前是哨兵值 `未登记` 与档案岗位对不上，现在是
        // 「档案里没有这个实例键」）；「不是 Lead」这个判据本体没变，改的只是断言查的那句话
        // —— 旧的 `/未登记/` 现在只由 `lib/actions.js:151` 的**文案回落**满足，查它等于查一句
        // 显示文本，查不住机制。所以这里改查 `/没有登记/`（更严，不是放宽）。
        const 子读数 = await 主体读数(工具, 成员会话exec);
        assert.equal(子读数.成功, false, `子会话不得被当成 Lead 放行，实际 ${JSON.stringify(子读数)}`);
        assert.equal(子读数.主体, undefined, '子会话的读数里没有 Lead 主体（修前这里恒是 Lead）');
        assert.match(String(子读数.理由), /没有登记/, `子会话的实例键不在身份档案里 ⇒ 档案校验拒；实际 ${子读数.理由}`);
        // 子会话的实例键同样 = **它自己的**会话 id（B 修：修前取父会话 ⇒ 两个同父的子会话
        // 共用一个主体 id）。这里断言的是子会话自己的 id，不是父会话的。
        assert.match(String(子读数.理由), new RegExp(String(成员会话exec.agent.session.id)), '实例键 = 子会话自己的会话 id ⇒ 拒绝文案里带它');

        // exec **整个取不到** ⇒ 倒向安全侧（不认 Lead）：`agentSubject(undefined)` 走第 3 档。
        // 这是本轮唯一的 fail-closed 档 —— 与修前的差别：修前连这一档也恒传 `根会话: true`。
        const 无exec = await 主体读数(工具, undefined);
        assert.equal(无exec.成功, false, 'exec 取不到 ⇒ status 也被拒（fail-closed）');
        assert.match(String(无exec.理由 ?? ''), /身份档案/, '拒绝理由是身份那一条（成员身份必须来自身份档案）');

        // ⚠️ 残留面（**有意保留**，如实钉住而不是假装它不存在）：`agent` 在、会话事实缺席
        // ⇒ 仍按根会话 = Lead。这一格是**修前既有读数**（不是本轮新放的口子），保留它是为了
        // 不动 15 处既有夹具（裸 `{}` 的语义是「命令行那条路没带 agent」）。它已记进 ⑳ 的诚实边界。
        const 裸agent = 放行主体(await 主体读数(工具, { name: 'mind', agent: {} }));
        assert.equal(裸agent.kind, 'Lead', '残留面：agent 在而会话事实缺席 ⇒ 沿用修前读数 Lead（未取证，见 ⑳）');
      } finally {
        host.清理();
        forgetSharedOrg();
      }
    } finally {
      await g.cleanup();
    }
  });

  it('②-落地判据：会话事实是主体的唯一来源（`主体` 漏传 ⇒ args 自报即成真）', async () => {
    const g = await makeFixture();
    try {
      const { 工具, host } = await 起宿主(g);
      try {
        // 这条盯的是**门② 会不会退化成死代码**：只改 `agentSubject` 而不把 `主体` 传给
        // `runAction`，`runAction` 就回落到 `subjectFor({岗位: args.role, 实例: args.实例, …})`
        // ⇒ 模型一条参数就把主体换成**别的在册实例**。实测（半成品形态的读数）：
        // 根会话 + `role:'插件工程', 实例:'member-a'` ⇒ 主体 = `{"id":"member-a","kind":"成员",…}`。
        // 落地后：args 不参与主体构造 ⇒ 主体仍是会话派生的那个（kind = Lead）。
        const 自报 = { action: 'status', role: '插件工程', 实例: 'member-a' };
        const 根 = JSON.parse(await 工具.execute(自报, 根会话exec));
        assert.equal(根.成功, true, JSON.stringify(根));
        assert.equal(根.主体.kind, 'Lead', `args 自报不改主体：根会话仍是 Lead；实际 ${JSON.stringify(根.主体)}`);
        assert.notEqual(根.主体.id, 'member-a', 'args.实例 不参与主体构造（漏传 `主体` 时这里会是 member-a ⇒ 死代码形态）');

        // 反例面：同一份自报用在**子会话**上 ⇒ 拒（不是 Lead），且拒绝理由落在身份那一条。
        const 子 = JSON.parse(await 工具.execute(自报, 成员会话exec));
        assert.equal(子.成功, false, '子会话自报在册实例也换不来身份（会话事实在前）');
        assert.equal(子.主体, undefined, '子会话的读数里没有主体（更不可能是 Lead）');
        assert.match(String(子.理由), /身份档案/, `拒绝理由落在身份那一条；实际 ${子.理由}`);
      } finally {
        host.清理();
        forgetSharedOrg();
      }
    } finally {
      await g.cleanup();
    }
  });
});

describe('③ 端到端：子会话主体换轮 / 收敛都拒，根会话放行（2026-10-10）', () => {
  it('③-回归：经 `mind` 工具真装配 + 真讨论段，判据 3 逐条读数', async () => {
    const g = await makeFixture();
    try {
      const { 工具, org, host } = await 起宿主(g);
      try {
        // 成员要**在册在岗**才会走到 debate 服务那一层（否则被主体链的档案校验先拒，
      // 那样测到的就不是「仅 Lead」这条判据了）。
        await g.writePrivate('身份档案/identity.json', JSON.stringify({
          members: {
            'member-a': { id: 'member-a', 岗位: '插件工程', 代: 1, status: '在岗' },
            'member-b': { id: 'member-b', 岗位: '插件工程', 代: 1, status: '在岗' },
            lead: { id: 'lead', 岗位: 'Lead', 代: 1, status: '在岗' },
          },
          sovereign: { lastInteraction: new Date().toISOString() },
          denylist: [],
        }, null, 2));
        await org.registry.sync();
        await org.policy.reload();

        const 项目 = JSON.parse(await 工具.execute({ action: 'status' }, 根会话exec)).数据.项目;
        const 跑 = async (args, exec) => JSON.parse(await 工具.execute({ ...args, project: 项目 }, exec));

        // ── 前置（一）：一个会审任务节点 —— 建 / 派 / 开工走**工具面根会话**（Lead 的日常动作，
        //    这条路必须照常走通；门①/门② 都不许误伤它）。
        const 建 = await 跑({ action: 'task_create', 描述: '端到端会审', 负责人: 'member-a,member-b', 判据: '结论一致', 模式: '独立会审' }, 根会话exec);
        assert.equal(建.成功, true, JSON.stringify(建));
        const 节点 = 建.节点.id;
        assert.equal((await 跑({ action: 'task_dispatch', id: 节点 }, 根会话exec)).成功, true);
        assert.equal((await 跑({ action: 'task_start', id: 节点 }, 根会话exec)).成功, true);

        // ── 前置（二）：「两份答案按人留」这一步只能用**服务面**（与 `交齐会审` 同款）。
        //    为什么（本轮如实读出的功能后果，不是判据）：**工具面的主体由会话事实唯一决定** ——
        //    内核把 `主体` 显式传给 `runAction` ⇒ `spec.主体 ?? subjectFor({岗位, 实例, …})`
        //    的前半段短路 ⇒ `args.role` / `args.实例` **不再参与主体构造**。实测（本轮，工作树）：
        //      同一个根会话 exec 连交两次卷、分别自报 实例=member-a / member-b ⇒
        //        交卷1 主体 = {"id":"<根会话id>","kind":"Lead","roleId":"Lead"}
        //        交卷2 主体 = {"id":"<根会话id>","kind":"Lead","roleId":"Lead"}
        //        独立答案 = ["<根会话id>"]（**1** 份：按主体 id 折叠）
        //        （⚠️ 这两行是**修前**读数，那时 id 恒为 `session-session-`；B 修后同一条路
        //         折叠行为**不变**（仍折叠成 1 份），变的只是 id 现在真的是这个会话。）
        //    ⇒ 「谁交的那一份」不再能靠参数区分。这正是本轮要堵的自报身份面在**同一条路**上的代价，
        //    已进回报的影响面清点与 `docs/设计债-2026-10-09.md` ⑳（成员会话在工具面恒被拒那一条）。
        await org.tasks.submit(节点, { subject: MEMBER_A, 项目, 结论: 'a 案' });
        await org.tasks.submit(节点, { subject: MEMBER_B, 项目, 结论: 'b 案' });
        const 交齐节点 = await org.tasks.get(节点, { 项目 });
        assert.equal(交齐节点.独立答案.length, 2, `两份答案按人留：实际 ${JSON.stringify(交齐节点.独立答案.map((a) => a.成员))}`);

        // 讨论段经**组装层同一个 org 的服务面**开（不能用另建的 `装配(g)`：那会在同一份盘上再起
        // 一套服务实例，与内核持有的那个 org 抢同一批文件）。工具面那条 `debate_open` 的可写预检
        // 与本节判据无关，混进来只会让失败原因难查。
        const 开 = await org.debate.open({ subject: LEAD, 项目, 节点 });
        assert.ok(开.参与者.length >= 2, `讨论段要开得起来：${JSON.stringify(开)}`);

        const 节点读数 = async () => (await org.tasks.get(节点, { 项目 })).讨论;
        const 线程 = () => org.bus.readRaw({ 项目, 线程: 节点 });
        const 边界条数 = async () => (await 线程()).filter((m) => String(m.内容 ?? '').startsWith(ROUND_BOUNDARY_MARK)).length;

        // ① 子会话换轮 ⇒ 拒，且**三条**「副作用没发生」：轮次未推进 / 没落轮边界 / 一条消息都没落线。
        assert.equal((await 节点读数()).轮次, 1, '前提：第 1 轮');
        const 前条数 = (await 线程()).length;
        const 子换 = await 跑({ action: 'debate_round', id: 节点 }, 成员会话exec);
        assert.equal(子换.成功, false, '子会话换轮必须被拒（修前 agentSubject 恒 Lead ⇒ 放行、轮次 1→2）');
        assert.equal(子换.主体, undefined, '被拒的调用里没有 Lead 主体（修前这里是 Lead）');
        // 诚实读数：这一拒发生在**主体链的档案校验**那一道（子会话的主体键是会话派生的会话 id，
        // 身份档案里没有这个实例 ⇒ 最严拒），**早于** debate 服务的「仅 Lead」。两层指向同一个结论；
        // 「仅 Lead」那一层本身由 ⑤ 直接钉住。
        assert.match(String(子换.规则), /身份停用 = 最严/, `子会话在主体链就被拦下（档案里没有这个实例键）；实际 ${子换.规则}`);
        assert.equal((await 节点读数()).轮次, 1, '被拒的换轮没有推进轮次');
        assert.equal(await 边界条数(), 0, '被拒的换轮没有落轮边界消息');
        assert.equal((await 线程()).length, 前条数, '被拒的换轮一条消息都没落线');

        // ② 子会话收敛 ⇒ 拒，且讨论没收敛、没落末位表态、一条消息都没落线。
        const 子收 = await 跑({ action: 'debate_converge', id: 节点 }, 成员会话exec);
        assert.equal(子收.成功, false, '子会话收敛必须被拒');
        assert.equal(子收.主体, undefined, '被拒的调用里没有 Lead 主体');
        assert.equal((await 节点读数()).状态, '讨论中', '被拒的收敛没有把讨论改成已收敛');
        assert.equal((await 节点读数()).表态消息id ?? null, null, '被拒的收敛没有落末位表态');
        assert.equal((await 线程()).length, 前条数, '被拒的收敛一条消息都没落线');

        // ②b 第二个子会话（同父）同样拒：「不是 Lead」对**每一个**子会话都成立，不靠
        //     「只有第一个会话特殊」。⚠️ B 修后这两个子会话的实例键**不再相同**
        //     （修前两档都取父会话 ⇒ 同一个值）；差异本身由下面的 `B-实例键` 用例正面钉住。
        const 子换2 = await 跑({ action: 'debate_round', id: 节点 }, 成员会话exec2);
        assert.equal(子换2.成功, false, '第二个子会话换轮同样拒');
        assert.equal(子换2.主体, undefined, '第二个子会话也没有 Lead 主体');
        assert.equal((await 节点读数()).轮次, 1, '第二个子会话也没能把轮次推上去');

        // ③ 正对照：根会话换轮 ⇒ 放行（且真推进轮次、真落边界消息）。
        const 根换 = await 跑({ action: 'debate_round', id: 节点 }, 根会话exec);
        assert.equal(根换.成功, true, `根会话换轮要放行：${JSON.stringify(根换)}`);
        assert.equal(根换.讨论.轮次, 2, '根会话换轮真推进到第 2 轮（功能本体没被改坏）');
        assert.equal(await 边界条数(), 1, '根会话换轮真落了一条边界消息');
        assert.equal(根换.主体.kind, 'Lead', '根会话的主体读数就是 Lead');

        // ④ 正对照：根会话收敛 ⇒ 放行（且真收敛、真落末位表态）。
        const 根收 = await 跑({ action: 'debate_converge', id: 节点 }, 根会话exec);
        assert.equal(根收.成功, true, `根会话收敛要放行：${JSON.stringify(根收)}`);
        assert.equal((await 节点读数()).状态, '已收敛', '根会话收敛真把讨论收掉');
        assert.ok((await 节点读数()).表态消息id, '根会话收敛真落了末位表态');

        // ⑤ 服务面直钉「仅 Lead」那一层（不经主体链）：一个**已登记**的在册成员直接调
        // `debate.round` / `converge` ⇒ 必须是被那条判据拒，而不是被身份挡下。
        // 这一条排除了「① ② 的拒只是因为实例没登记」这种更弱的解释。
        const parts = 装配(g);
        const 节点2 = await 交齐会审(parts.tasks);
        await parts.debate.open({ subject: LEAD, 项目: P, 节点: 节点2 });
        await assert.rejects(
          () => parts.debate.round({ subject: MEMBER_A, 项目: P, 节点: 节点2 }),
          (e) => e.name === 'Denied' && /换轮仅 Lead/.test(e.rule) && e.requireAuthority === 'Lead',
          '在册成员直接调服务面换轮 ⇒ 被「仅 Lead」拒（与端到端拒的是同一件事，这里换了层）',
        );
        await assert.rejects(
          () => parts.debate.converge({ subject: MEMBER_A, 项目: P, 节点: 节点2 }),
          (e) => e.name === 'Denied' && /收敛仅 Lead/.test(e.rule) && e.requireAuthority === 'Lead',
          '在册成员直接调服务面收敛 ⇒ 被「仅 Lead」拒',
        );
        const 节点2读数 = await parts.tasks.get(节点2, { 项目: P });
        assert.equal(节点2读数.讨论.轮次, 1, '服务面被拒的换轮同样没有推进轮次');
        assert.equal(节点2读数.讨论.状态, '讨论中', '服务面被拒的收敛同样没有收敛');
      } finally {
        host.清理();
        forgetSharedOrg();
      }
    } finally {
      await g.cleanup();
    }
  });
});

describe('B 实例键：唯一标识「哪一个会话」（2026-10-10 P1 补 · 判据带反例面）', () => {
  /**
   * **真实形状**的会话 id：`session-<uuid>`。
   * 形状依据（实测，不是猜）：本机 `E:\DSHOME\sessions\` 下 460 个会话目录里 **208 个**
   * 形如 `session-<uuid>`（生成端 `brandString(\`session-${randomUUID()}\`)`，
   * `@deepseek-ai/dsh-api-session-controller/lib/index.js:573/692`）。
   * 这里用两个同形状的合成 id —— 关键是它们**都在第 8 个字符处结束于 `session-` 前缀**，
   * 也就是修前那条公式的退化点。
   */
  const 真根A = 'session-7fb7087b-c62a-4c64-a6ce-40aab0a78cd9';
  const 真根B = 'session-80e3fa83-1b2c-4d5e-9f00-aabbccddeeff';
  /** 两个**同父**的子会话的会话 id（修前它们会算出同一个键 —— 这正是 B 要治的第二半）。 */
  const 真子A_id = 'session-c1a2b3c4-1111-4222-8333-444455556666';
  const 真子B_id = 'session-d5e6f7a8-9999-4aaa-8bbb-ccccddddeeee';
  const 真子A = 桩exec({ cwd: 'C:/ws', createdAt: 2, isSeeded: false, version: 1, origin: 'subagent', parentSession: 真根A, delegationDepth: 1 }, 真子A_id);
  const 真子B = 桩exec({ cwd: 'C:/ws', createdAt: 3, isSeeded: false, version: 1, origin: 'subagent', parentSession: 真根A, delegationDepth: 1 }, 真子B_id);

  it('B-判据：两个不同会话 ⇒ 不同键；同一会话两次调用 ⇒ 同键（根会话与子会话两面都测）', async () => {
    const g = await makeFixture();
    try {
      const { 工具, host } = await 起宿主(g);
      try {
        // ── 反例面（先把「这两个 id 真的能区分」钉住，否则下面的判据可能因为 id 选得不好而假绿）：
        //    修前那条公式对这两个 id 算出的是**同一个**键。
        const 旧公式 = (id) => `session-${String(id).slice(0, 8)}`;
        assert.equal(旧公式(真根A), 'session-session-', `修前公式退化读数（A）；实际 ${旧公式(真根A)}`);
        assert.equal(旧公式(真根B), 'session-session-', `修前公式退化读数（B）；实际 ${旧公式(真根B)}`);
        assert.equal(旧公式(真根A), 旧公式(真根B), '反例面前提：修前公式对这两个不同会话给出同一个键');

        // ── 根会话面：两个不同会话 ⇒ 两个不同键（读数原样印出来）。
        const 根A1 = 放行主体(await 主体读数(工具, 桩exec({ cwd: 'C:/ws', createdAt: 1, isSeeded: false, version: 1 }, 真根A)));
        const 根B1 = 放行主体(await 主体读数(工具, 桩exec({ cwd: 'C:/ws', createdAt: 1, isSeeded: false, version: 1 }, 真根B)));
        // eslint-disable-next-line no-console
        console.log(`[B-读数] 根会话 ${真根A} ⇒ 实例键 ${根A1.id} ; 根会话 ${真根B} ⇒ 实例键 ${根B1.id}`);
        assert.equal(根A1.id, 真根A, `根会话 A 的实例键 = 它自己的会话 id；实际 ${根A1.id}`);
        assert.equal(根B1.id, 真根B, `根会话 B 的实例键 = 它自己的会话 id；实际 ${根B1.id}`);
        assert.notEqual(根A1.id, 根B1.id, `两个不同会话必须给出不同实例键（修前都是 session-session-）；实际 ${根A1.id} / ${根B1.id}`);

        // ── 同一会话两次调用 ⇒ 同一个键（稳定性；键由会话 id 派生，不由调用次序派生）。
        const 根A2 = 放行主体(await 主体读数(工具, 桩exec({ cwd: 'C:/ws', createdAt: 1, isSeeded: false, version: 1 }, 真根A)));
        assert.equal(根A2.id, 根A1.id, '同一会话两次调用必须是同一个实例键');
        // 换一份 header（同一 id、不同 createdAt）也必须是同一个键：键只认会话身份，不认其余 header 字段。
        const 根A3 = 放行主体(await 主体读数(工具, 桩exec({ cwd: 'C:/other', createdAt: 999, isSeeded: true, version: 3 }, 真根A)));
        assert.equal(根A3.id, 根A1.id, '同一会话（换 header 其余字段）仍是同一个实例键');

        // ── 子会话面：两个**同父**的子会话 ⇒ 两个不同键（修前它们取父会话 ⇒ 同一个键）。
        const 子A读数 = await 主体读数(工具, 真子A);
        const 子B读数 = await 主体读数(工具, 真子B);
        // 子会话一律被主体链拒（它的实例键不在身份档案里），所以键要从拒绝文案里读。
        // ⚠️ 文案形状 `…：<id>（<角色位>）在档案里…` —— 那个括号段是 `lib/actions.js:151` 的
        // **文案回落** `主体.roleId ?? '未登记'`（A 落地后会话派生主体恒走回落）。本断言只借它
        // 定位 id 那一段；改文案会让它红，那是**有意的**（别让它悄悄漂走）。
        const 键从理由 = (理由) => {
          const m = /：(\S+?)（/.exec(String(理由));
          return m ? m[1] : null;
        };
        const 子A键 = 键从理由(子A读数.理由);
        const 子B键 = 键从理由(子B读数.理由);
        // eslint-disable-next-line no-console
        console.log(`[B-读数] 子会话 ${真子A_id} ⇒ 实例键 ${子A键} ; 子会话 ${真子B_id} ⇒ 实例键 ${子B键}`);
        assert.equal(子A键, 真子A_id, `子会话的实例键 = 它**自己**的会话 id（修前取父会话）；实际 ${子A键}`);
        assert.equal(子B键, 真子B_id, `第二个子会话的实例键 = 它自己的会话 id；实际 ${子B键}`);
        assert.notEqual(子A键, 子B键, `两个同父子会话必须给出不同实例键（修前都取父会话 ⇒ 同一个）；实际 ${子A键} / ${子B键}`);
        assert.notEqual(子A键, 真根A, '子会话的键不许退化成父会话的键（否则「哪一个会话」仍丢）');

        // ── 取不到会话 id 的兜底（两条路各自的兜底值，别互相串）。
        const 无id子 = await 主体读数(工具, { name: 'mind', agent: { session: { header: { origin: 'subagent', version: 1, isSeeded: false } } } });
        assert.match(String(无id子.理由), /member-unknown/, '子会话取不到会话 id ⇒ 兜底 member-unknown（fail-closed）');
        const 无id根 = 放行主体(await 主体读数(工具, { name: 'mind', agent: { session: { header: { cwd: 'C:/ws', version: 1, isSeeded: false } } } }));
        assert.equal(无id根.id, 'lead', `根会话取不到会话 id ⇒ 兜底 lead；实际 ${无id根.id}`);
      } finally {
        host.清理();
        forgetSharedOrg();
      }
    } finally {
      await g.cleanup();
    }
  });
});

describe('A 落地（2026-10-10 · 主人拍板：Lead 显式登记 + 会话派生主体不填 roleId）', () => {
  /**
   * 岗位卡：`registry.assign` 在三条守卫之外还有一条前置 —— 目标岗位**必须有卡**
   * （`src/registry.js:178-184`，§7「实例权限只来自岗位」）。夹具只带一张 `_模板`，
   * 所以这里自己造一张，写在**私有自治区**（与 `test/identity-chain.test.js:29-36` 同款）。
   */
  const 岗位卡 = (id) => [
    '---', `id: ${id}`, 'kind: 身份', 'authority: 自治', 'zone: 私有', 'domain: 个体', 'version: 1', '---',
    `# ${id}`, '', '## 个体L0 · 身份', `${id} 岗。`, '',
    '## 个体L1 · 规则', '先搜后写。', '',
    '## 个体L2 · 能力', '- 无', '',
    '## 个体L3 · 经验', '- 无',
  ].join('\n');

  /** 一个**会话派生**的子会话：实例键 = 它自己的会话 id（B 修后的形状）。 */
  const 子id = 'session-child-a0001';
  const 子会话 = 桩exec(
    { cwd: 'C:/ws', createdAt: 2, isSeeded: false, version: 3, origin: 'subagent', parentSession: 'session-root-0001', delegationDepth: 1 },
    子id,
  );

  it('A-1 登记后可用：Lead 用 registry_assign 登记该子会话 ⇒ 子会话调 mind 以成员身份执行（主体无 roleId）', async () => {
    const g = await makeFixture();
    try {
      const { 工具, org, host } = await 起宿主(g);
      try {
        await g.writePrivate('集体L3-成员角色卡/复核员.md', 岗位卡('复核员'));

        // ── 登记**前**先读一次（同一个子会话、同一条 exec）：这一刻仍被拒 —— A-1/A-2 这一对
        //    正对照的全部差别就是「有没有那次登记」。
        const 登记前 = await 主体读数(工具, 子会话);
        assert.equal(登记前.成功, false, `登记前必须仍拒（fail-closed）；实际 ${JSON.stringify(登记前)}`);

        // ── ① Lead **显式登记**（工具面，根会话执行）：实例 = **该子会话的会话 id**。
        const 登记 = JSON.parse(await 工具.execute({ action: 'registry_assign', 岗位: '复核员', 实例: 子id, 代: 1 }, 根会话exec));
        assert.equal(登记.成功, true, `Lead 登记该实例要成功（岗位有卡 + 根会话过得了 create）；实际 ${JSON.stringify(登记)}`);
        assert.equal(登记.实例.岗位, '复核员');
        assert.equal(登记.实例.状态, '在岗');
        // 读**真源**（不是返回值）：档案里的键就是子会话的会话 id。
        assert.equal((await org.registry.identity()).members[子id].岗位, '复核员', '档案里的键 = 子会话的会话 id（B 修后的实例键）');

        // ── ② 子会话调 mind：放行，且主体形状按本批的设计 —— **没有 roleId**。
        const 后 = await 主体读数(工具, 子会话);
        assert.equal(后.成功, true, `登记后该子会话必须能执行（这正是本批要治的那一格）；实际 ${JSON.stringify(后)}`);
        assert.equal(Object.hasOwn(subjectFor({ 实例: 子id }), 'roleId'), false, '会话派生的主体**不带 roleId**（字段缺席，不是一个哨兵值）');
        assert.equal(后.主体.id, 子id, '主体 id = 这个子会话自己的会话 id');
        assert.equal(后.主体.kind, '成员', '会话派生的主体种类是成员（岗位在档案里，不在主体上）');
        assert.equal(后.主体.roleId, null, '序列化读数里 roleId 是 null —— 与「字段缺席」同义（`lib/actions.js:162` 的 `?? null`）');

        // ── ③ 真动作执行（不只是「过闸」）：工作台按**读者**切片那条路照常走通，
        //    且切的是「成员只读自己那片」—— 说明主体真流进了服务层。
        const 台 = JSON.parse(await 工具.execute({ action: 'workbench' }, 子会话));
        assert.equal(台.成功, true, JSON.stringify(台));
        assert.equal(台.数据.视图, '只读自己任务那片', `成员切片真生效；实际 ${台.数据.视图}`);
        // eslint-disable-next-line no-console
        console.log(`[A-读数] 登记后 子会话 ${子id} ⇒ 主体 ${JSON.stringify(后.主体)}；subjectFor 原样 ${JSON.stringify(subjectFor({ 实例: 子id }))}`);
      } finally {
        host.清理();
        forgetSharedOrg();
      }
    } finally {
      await g.cleanup();
    }
  });

  it('A-2 正对照 · 未登记仍拒：同一个子会话不登记 ⇒ 拒；登记后**封存** ⇒ 也拒（要「在册且在岗」两件）', async () => {
    const g = await makeFixture();
    try {
      const { 工具, org, host } = await 起宿主(g);
      try {
        await g.writePrivate('集体L3-成员角色卡/复核员.md', 岗位卡('复核员'));

        // ── ① 档案里没有这个实例键 ⇒ 拒（宪章 身份停用 = 最严）。
        const 未登记 = await 主体读数(工具, 子会话);
        assert.equal(未登记.成功, false, `没登记 ⇒ 必须拒（A 落地治的是「登记了也拒」，不是「一律放行」）；实际 ${JSON.stringify(未登记)}`);
        assert.equal(未登记.主体, undefined, '被拒的读数里没有主体');
        assert.match(String(未登记.规则), /身份停用 = 最严/, `拒绝理由落在身份那一条；实际 ${未登记.规则}`);
        assert.match(String(未登记.理由), new RegExp(子id), '拒绝文案里带的是**这个子会话**的实例键（不是父会话的）');
        assert.match(String(未登记.理由), /没有登记/, `机制是「档案里没有这个实例键」；实际 ${未登记.理由}`);

        // ── ② 登记**后**再封存 ⇒ 也拒：判据是「在册**且在岗**」，不是在册就算数。
        await org.registry.assign({ subject: LEAD, 岗位: '复核员', 实例: 子id, 代: 1 });
        assert.equal((await 主体读数(工具, 子会话)).成功, true, '前提：登记后在岗的这一刻是放行的（与 A-1 同款读数）');
        await org.registry.seal({ subject: LEAD, 实例: 子id, 理由: 'A-2 正对照：在册不在岗' });
        const 封存后 = await 主体读数(工具, 子会话);
        assert.equal(封存后.成功, false, `在册但封存 ⇒ 仍拒（「在岗」这一件不是摆设）；实际 ${JSON.stringify(封存后)}`);
        assert.match(String(封存后.理由), /封存/, `拒绝文案说出档案里的真实状态；实际 ${封存后.理由}`);

        // ── ③ ㉓ 那个怪面（手写档案把岗位写成 `未登记`）的落地后读数：**放行，但已不是「撞上哨兵值」**
        //    —— 主体压根没有 `roleId` 可与岗位比，放行只由「在册且在岗」决定，与岗位叫什么**无关**。
        //    这里如实复跑（手写夹具照旧能造出各种岗位名；sanctioned 面仍要求有卡，见下）。
        await g.writePrivate('身份档案/identity.json', JSON.stringify({
          members: { [子id]: { id: 子id, 岗位: '未登记', 代: 1, status: '在岗' } },
          sovereign: { lastInteraction: new Date().toISOString() },
          denylist: [],
        }, null, 2));
        await org.registry.sync();
        await org.policy.reload();
        const 手写 = await 主体读数(工具, 子会话);
        assert.equal(手写.成功, true, `手写档案（在册在岗）⇒ 放行，且与岗位叫什么无关；实际 ${JSON.stringify(手写)}`);
        assert.equal(手写.主体.roleId, null, '放行时主体依然**没有 roleId** ⇒ ㉓ 那个「靠哨兵值撞上对账」的形态已不存在');
        // sanctioned 面复跑：`registry_assign` 到岗位「未登记」⇒ 拒（岗位卡不存在）。
        await assert.rejects(
          () => org.registry.assign({ subject: LEAD, 岗位: '未登记', 实例: 子id, 代: 1 }),
          (e) => e.name === 'Denied' && /不存在/.test(e.message) && /岗位卡/.test(e.howToChange ?? ''),
          'sanctioned 面：岗位「未登记」没有岗位卡 ⇒ assign 被拒（哨兵值走不了正路）',
        );
      } finally {
        host.清理();
        forgetSharedOrg();
      }
    } finally {
      await g.cleanup();
    }
  });

  it('A-3 正对照 · 主体自陈的岗位仍要档案一致：插件工程 而档案岗位=复核员 ⇒ 拒；复核员 ⇒ 放行', async () => {
    const g = await makeFixture();
    try {
      const { 工具, org, host } = await 起宿主(g);
      try {
        await g.writePrivate('集体L3-成员角色卡/复核员.md', 岗位卡('复核员'));
        await org.registry.assign({ subject: LEAD, 岗位: '复核员', 实例: 子id, 代: 1 });

        // ── ① **主体自陈的岗位**（`主体.roleId` 是字符串）与档案不符 ⇒ 拒。
        //    这一格是门① 的成果，一个字都不许放宽。
        //    P2（2026-10-10）后角色卡这条路只能由**宿主给的主体**表达（`args.role`/`args.实例`
        //    不再参与构造 ⇒ args 仍照旧填着，用来钉住"自报救不回来"）。
        await assert.rejects(
          () => runAction({ org, 项目: org.project, subject: LEAD, 主体: subjectFor({ 岗位: '插件工程', 实例: 子id }), args: { action: 'status', role: '插件工程', 实例: 子id } }),
          (e) => e.name === 'Denied'
            && /身份停用 = 最严/.test(e.rule)
            && /插件工程/.test(e.message) && /复核员/.test(e.message),
          '主体自陈的岗位与档案不符 ⇒ 拒（会话派生那条「不填 roleId」不许把这一格也短路掉）',
        );

        // ── ② 正对照：主体自陈的岗位**与档案一致**（复核员）⇒ 放行，主体是复核者。
        //    证明 ① 的拒不是「凡带岗位就拒」，而是「带的岗位必须与档案一致」。
        const 过 = await runAction({ org, 项目: org.project, subject: LEAD, 主体: subjectFor({ 岗位: '复核员', 实例: 子id }), args: { action: 'status', role: '复核员', 实例: 子id } });
        assert.equal(过.主体.kind, '复核者', `与档案一致时按岗位构造主体；实际 ${JSON.stringify(过.主体)}`);
        assert.equal(过.主体.roleId, '复核员');

        // ── ③ 两条路不是同一个判据：**同一条 exec、同一份档案**，会话派生那条路照常放行
        //    （它不填 roleId ⇒ 不参与岗位对账），自报那条路照旧要对账。两格同时成立才是本批的设计。
        const 派生 = await 主体读数(工具, 子会话);
        assert.equal(派生.成功, true, `同一份档案下会话派生照常放行；实际 ${JSON.stringify(派生)}`);
        assert.equal(派生.主体.roleId, null, '会话派生的读数里没有 roleId（与 ① 的自报那一路形成对照）');
      } finally {
        host.清理();
        forgetSharedOrg();
      }
    } finally {
      await g.cleanup();
    }
  });

  it('A-4 根会话不受影响：根会话调 mind ⇒ 仍是 Lead、仍放行', async () => {
    const g = await makeFixture();
    try {
      const { 工具, host } = await 起宿主(g);
      try {
        const 根 = 放行主体(await 主体读数(工具, 根会话exec));
        assert.equal(根.kind, 'Lead', `根会话仍是 Lead（「根会话」那一档一个字节都没动）；实际 ${JSON.stringify(根)}`);
        assert.equal(根.roleId, 'Lead', 'Lead 那一档仍带 roleId（本批只动最后一档）');
        assert.equal(根.id, String(根会话exec.agent.session.id), '实例键 = 会话 id 原样（B 修）');
        // 真动作：根会话看**全量**（与 A-1 的成员切片互为对照）。
        const 台 = JSON.parse(await 工具.execute({ action: 'workbench' }, 根会话exec));
        assert.equal(台.成功, true, JSON.stringify(台));
        assert.equal(台.数据.视图, '全量', `根会话看全量；实际 ${台.数据.视图}`);
      } finally {
        host.清理();
        forgetSharedOrg();
      }
    } finally {
      await g.cleanup();
    }
  });
});
