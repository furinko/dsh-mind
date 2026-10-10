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
 *     ⚠️ **这条的「拒」落在主体链的档案校验那一道**（会话派生的成员主体 = 未登记 ⇒ 最严拒），
 *     **早于** debate 服务的「仅 Lead」；「仅 Lead」那一层由 ⑤（服务面 · 已登记成员直调）与
 *     ⑱ 的既有回归背书。别把 ③ 读成「debate 层在模型可达面被验过」。
 *     ⚠️ 造「两份答案」的前置只能走**服务面**（工具面主体由会话事实唯一决定 ⇒ `args.实例`
 *     不再记名，连交两次会折叠成 1 份）——读数与理由写在 ③ 前置那段注释里。
 *  4. 每条被拒的判据**同时**断言「副作用没发生」：轮次未推进 / 无轮边界消息落线 / 讨论未收敛。
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
 * 两种读数都要读得到，因为**「主体算错」本身就会以两种形态出现**：
 *  · 算成 Lead ⇒ `runAction` 放行 ⇒ 结果里有 `主体`；
 *  · 算成未登记的成员 ⇒ 主体链的档案校验先拒 ⇒ 结果里是拒绝文案（**没有** `主体` 字段）。
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

  it('①-正对照：显式声明**在册在岗成员**（role=插件工程 / 实例=member-a）⇒ 仍放行', async () => {
    const g = await makeFixture();
    try {
      const parts = 装配(g);
      const 节点 = await 交齐会审(parts.tasks);
      await parts.debate.open({ subject: LEAD, 项目: P, 节点 });
      const 发言 = await runAction({
        org: 动作面org(parts), 项目: P, subject: LEAD,
        args: { action: 'debate_say', id: 节点, role: '插件工程', 实例: 'member-a', 类型: '表态', 内容: '成员照常发言' },
      });
      assert.equal(发言.主体.kind, '成员', '成员岗位仍按身份档案构造（门① 不误伤成员这条路）');
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
        // ⚠️ 实例键的**退化形状**（本轮诊断读数，未改门②）：公式 = `session-` + 会话id 前 8 位
        // （HEAD 的 :540 就是这个写法，不是本批引入）。本夹具的桩 id 以 `session-` 开头
        // ⇒ 前缀被吃掉一层 ⇒ `session-session-`；而**真实形状**的会话 id 也是
        // `session-<uuid>`（本机真实会话目录名 `session-80e3fa83-…`）⇒ **同款退化**：
        // 实例键不携带任何会话信息，「账上不丢哪一个会话」这句在真实形状下不成立。
        // 已如实记进 `docs/设计债-2026-10-09.md` ⑳ 与回报（B6/B7 读数）。
        assert.equal(根.id, 'session-session-', `实例键取会话 id 前 8 位（既有公式）；exec.id=${String(根会话exec.agent.session.id)} 实际=${JSON.stringify(根)}`);

        // 子会话：origin=subagent（本仓四处同款判据用的就是它）⇒ 不是 Lead。
        // 这一条**不可能**放行：算成成员后主体链会以「未登记」拒它 —— 于是「不是 Lead」的
        // 可观察形态就是「被拒」，且拒绝理由是身份那一条（而不是别的闸）。
        const 子读数 = await 主体读数(工具, 成员会话exec);
        assert.equal(子读数.成功, false, `子会话不得被当成 Lead 放行，实际 ${JSON.stringify(子读数)}`);
        assert.equal(子读数.主体, undefined, '子会话的读数里没有 Lead 主体（修前这里恒是 Lead）');
        assert.match(String(子读数.理由), /未登记/, `子会话算出来的是「未登记成员」⇒ 档案校验拒；实际 ${子读数.理由}`);
        assert.match(String(子读数.理由), /session-session-/, '实例键取父会话（可指认「哪个 Lead 起的」）⇒ 拒绝文案里带它');

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
        //        交卷1 主体 = {"id":"session-session-","kind":"Lead","roleId":"Lead"}
        //        交卷2 主体 = {"id":"session-session-","kind":"Lead","roleId":"Lead"}
        //        独立答案 = ["session-session-"]（**1** 份：按主体 id 折叠）
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
        // 诚实读数：这一拒发生在**主体链的档案校验**那一道（子会话的主体键是会话派生 id，不在身份
        // 档案里 ⇒ 未登记 ⇒ 最严拒），**早于** debate 服务的「仅 Lead」。两层指向同一个结论；
        // 「仅 Lead」那一层本身由 ⑤ 直接钉住。
        assert.match(String(子换.规则), /身份停用 = 最严/, `子会话在主体链就被拦下（未登记）；实际 ${子换.规则}`);
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

        // ②b 第二个子会话（同父）同样拒：两个子会话的实例键都取父会话 ⇒ 同一个值（这是判据 2 的
        //     读数，不是 bug）——「不是 Lead」对**每一个**子会话都成立，不靠「只有第一个会话特殊」。
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
