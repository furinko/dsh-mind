/**
 * v2 会审并发状态机回归（2026-10-18 · 节点 task-修复独立会审并发状态机）。
 *
 * 病灶（Lead 用临时真实 Org 夹具复现）：已解锁会审 `Promise.all([round, round])`
 * 两路都在锁外读到「已解锁 / 轮次 0」，各自 +1 ⇒ 两路都返回轮 1、最终轮次 1；
 * 解锁与收敛同款（锁外读-判-写）。修法：会审状态权威判定全部收进事件锁内复检，
 * 轮边界消息与轮次事件同锁同序落线，状态事件与总线轮边界跨存储失配 fail-closed。
 *
 * 确定性：不用时钟 sleep。并发 = 同一个 Promise.all 里的两路调用；两路都会在
 * 各自第一次 await（`#require` 读事件流）后挂起，因此必然都拿到同一个旧视图——
 * 这正是被修的竞态窗口。断言只看落线条数 / 轮次 / 审计动作，不看时序。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendLines, readJsonl } from '../src/kernel/fsx.js';
import { Denied, Fault } from '../src/kernel/errors.js';
import { makeFixture, LEAD, MEMBER } from './helpers.mjs';
import { Org } from '../src/org.js';
import { 本轮发言, 轮边界轮次, ROUND_BOUNDARY_MARK, 线程名 } from '../src/council.js';

const P = 'proj-council-concurrency';
const 部署偏好 = '集体L2-共享基础设施/defaults/部署.json';
const 乙 = { id: 'member-b', kind: '成员', roleId: '插件工程' };

async function 起组织(options = {}) {
  const f = await makeFixture(options);
  const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
  return { f, org };
}

async function 开会审(org) {
  return org.council.open({ subject: LEAD, 项目: P, 问题: '并发状态机回归', 参与者: [MEMBER.id, 乙.id] });
}

/** 甲乙各交一份卷（结论层一致、无例外面 ⇒ 零分歧成立）。 */
async function 交齐(org, id) {
  await org.council.answer({ subject: MEMBER, 项目: P, id, 结论: 'A 案', 结论层: '方案A' });
  await org.council.answer({ subject: 乙, 项目: P, id, 结论: 'B 案', 结论层: '方案A' });
}

async function 解锁(org, id) {
  await 交齐(org, id);
  return org.council.unlock({ subject: LEAD, 项目: P, id });
}

const 读消息 = (org, id) => org.bus.readRaw({ 项目: P, 线程: 线程名(id) });
const 边界消息 = (消息) => (消息 ?? []).filter((m) => String(m?.内容 ?? '').startsWith(ROUND_BOUNDARY_MARK));

/** 会审事件流里这场会审的行（锁内落线顺序的原始证据）。 */
async function 会审事件(f, id) {
  const rows = await readJsonl(f.layout.councilLog(P));
  return rows.filter((r) => r.id === id);
}

describe('并发换轮：轮次与边界同锁定序', () => {
  it('Promise.all([round, round])：两路各得 1、2 两轮（不重复同一轮），边界按序各一条', async () => {
    const { f, org } = await 起组织();
    try {
      const 开 = await 开会审(org);
      await 解锁(org, 开.id);

      const 结果 = await Promise.all([
        org.council.round({ subject: LEAD, 项目: P, id: 开.id }),
        org.council.round({ subject: LEAD, 项目: P, id: 开.id }),
      ]);

      assert.deepEqual(结果.map((r) => r.轮次).sort((a, b) => a - b), [1, 2], '并发两路必须收敛到 1、2 两轮，不许都拿轮1');
      assert.equal((await org.council.get(P, 开.id)).轮次, 2, '最终轮次 = 2（锁内逐次 +1）');

      const 消息 = await 读消息(org, 开.id);
      assert.deepEqual(
        边界消息(消息).map((m) => m.内容),
        [`${ROUND_BOUNDARY_MARK} 1`, `${ROUND_BOUNDARY_MARK} 2`],
        '轮边界消息按轮序落线：不重复、不乱序（预算按最后一条边界切轮）',
      );
      assert.equal(边界消息(消息).length, 2, '两轮各恰一条边界');

      const 事件 = await 会审事件(f, 开.id);
      assert.deepEqual(事件.filter((r) => r.kind === 'rounded').map((r) => r.轮次), [1, 2]);

      const 审计 = (await org.audit.read({})).filter((r) => r.对象?.id === 开.id);
      assert.equal(审计.filter((r) => r.动作 === '讨论开启').length, 1, '只有第一次换轮是「讨论开启」');
      assert.equal(审计.filter((r) => r.动作 === '会审换轮').length, 1, '第二次换轮是「会审换轮」');
    } finally { await f.cleanup(); }
  });

  it('轮次上限处并发：只成功一路推进，另一路拒（轮次上限），不重复边界', async () => {
    const { f, org } = await 起组织();
    try {
      const 开 = await 开会审(org);
      await 解锁(org, 开.id);
      await org.council.round({ subject: LEAD, 项目: P, id: 开.id }); // 1

      const 结果 = await Promise.allSettled([
        org.council.round({ subject: LEAD, 项目: P, id: 开.id }),
        org.council.round({ subject: LEAD, 项目: P, id: 开.id }),
      ]);
      const 成功 = 结果.filter((r) => r.status === 'fulfilled');
      const 拒绝 = 结果.filter((r) => r.status === 'rejected');
      assert.equal(成功.length, 1, '上限 2：并发两路只能有一路推进');
      assert.equal(成功[0].value.轮次, 2);
      assert.equal(拒绝.length, 1);
      assert.ok(拒绝[0].reason instanceof Denied && /轮次上限/.test(拒绝[0].reason.rule), '被拒的那路要点名轮次上限');

      assert.equal((await org.council.get(P, 开.id)).轮次, 2, '被拒的那路不推进（最终仍是 2，不越上限）');
      const 消息 = await 读消息(org, 开.id);
      assert.deepEqual(
        边界消息(消息).map((m) => m.内容),
        [`${ROUND_BOUNDARY_MARK} 1`, `${ROUND_BOUNDARY_MARK} 2`],
        '边界恰两条：没有第二条「轮 2」边界（重复同一轮会洗预算）',
      );
    } finally { await f.cleanup(); }
  });
});

describe('并发解锁 / 并发收敛：只成功一次', () => {
  it('Promise.all([unlock, unlock])：只落一条 unlocked 事件、一条解锁审计', async () => {
    const { f, org } = await 起组织();
    try {
      const 开 = await 开会审(org);
      await 交齐(org, 开.id);

      const 结果 = await Promise.allSettled([
        org.council.unlock({ subject: LEAD, 项目: P, id: 开.id }),
        org.council.unlock({ subject: LEAD, 项目: P, id: 开.id }),
      ]);
      assert.equal(结果.filter((r) => r.status === 'fulfilled').length, 1, '并发解锁只有一路成功');
      assert.equal(结果.filter((r) => r.status === 'rejected').length, 1);
      assert.ok(结果.find((r) => r.status === 'rejected').reason instanceof Denied, '后到的那路按状态机拒');

      const 事件 = await 会审事件(f, 开.id);
      assert.equal(事件.filter((r) => r.kind === 'unlocked').length, 1, '揭名事件只落一条（不重复解锁）');
      const 审计 = (await org.audit.read({})).filter((r) => r.动作 === '会审解锁' && r.对象?.id === 开.id);
      assert.equal(审计.length, 1, '解锁审计也只一条');
      assert.equal((await org.council.get(P, 开.id)).状态, '已解锁');
    } finally { await f.cleanup(); }
  });

  it('Promise.all([converge, converge])：只成功一次、零分歧报警只一条；之后换轮/发言不复活', async () => {
    const { f, org } = await 起组织();
    try {
      const 开 = await 开会审(org);
      await 解锁(org, 开.id);
      await org.council.round({ subject: LEAD, 项目: P, id: 开.id }); // 讨论中（轮1）
      const 消息数前 = (await 读消息(org, 开.id)).length;
      const 事件数前 = (await 会审事件(f, 开.id)).length;

      const 结果 = await Promise.allSettled([
        org.council.converge({ subject: LEAD, 项目: P, id: 开.id, 内容: '并发收敛结论' }),
        org.council.converge({ subject: LEAD, 项目: P, id: 开.id, 内容: '并发收敛结论' }),
      ]);
      const 成功 = 结果.filter((r) => r.status === 'fulfilled');
      const 拒绝 = 结果.filter((r) => r.status === 'rejected');
      assert.equal(成功.length, 1, '并发收敛只有一次能成功');
      assert.equal(拒绝.length, 1);
      assert.ok(拒绝[0].reason instanceof Denied && /已收敛/.test(拒绝[0].reason.message), '后到的那路要看见「已收敛」并拒');

      const 事件 = await 会审事件(f, 开.id);
      assert.equal(事件.filter((r) => r.kind === 'converged').length, 1, '只落一条收敛事件（不许两条结论）');
      const 报警 = (await org.audit.read({})).filter((r) => r.动作 === '零分歧异常' && r.对象?.id === 开.id);
      assert.equal(报警.length, 1, '零分歧报警只一条（并发第二路在锁内已拒，不多报）');
      const 收 = 成功[0].value;
      assert.equal(收.会审.状态, '已收敛');
      assert.equal(收.会审.结论, '并发收敛结论');
      assert.equal(收.零分歧, true);

      // 收敛后状态机冻结：换轮 / 发言都不许把已收敛的会审复活。
      await assert.rejects(
        () => org.council.round({ subject: LEAD, 项目: P, id: 开.id }),
        (e) => e instanceof Denied && /状态机/.test(e.rule),
        '收敛后换轮必须拒（不复活）',
      );
      await assert.rejects(
        () => org.council.say({ subject: MEMBER, 项目: P, id: 开.id, 类型: '表态', 内容: '复活发言' }),
        (e) => e instanceof Denied && /没有开启讨论/.test(e.rule),
        '收敛后发言必须拒（不复活）',
      );
      assert.equal((await org.council.get(P, 开.id)).状态, '已收敛');
      assert.equal((await org.council.get(P, 开.id)).轮次, 1, '被拒的换轮不推进轮次');
      assert.equal((await 会审事件(f, 开.id)).length, 事件数前 + 1, '收敛后只多了那一条收敛事件');
      assert.equal((await 读消息(org, 开.id)).length, 消息数前, '收敛后没有新讨论消息落线');
    } finally { await f.cleanup(); }
  });
});

describe('线性化：say 落线与收敛不允许越序（初审补）', () => {
  it('屏障：say 停在预算闸后、消息落线前；converge 并发 ⇒ 只能 say 先落线再收敛（收敛分歧清单必须含这条）', async () => {
    const { f, org } = await 起组织();
    try {
      const 开 = await 开会审(org);
      await 解锁(org, 开.id);
      await org.council.round({ subject: LEAD, 项目: P, id: 开.id });

      // 在 bus.send 的 锁内闸 跑完之后、appendLines 之前停住（真实调用链，不改 bus.js；
      // 这一步复现初审指出的窗口：复检结束 → 消息落线之间，收敛仍可能插进来）。
      const 原send = org.bus.send;
      let 到闸后; const 已到闸后 = new Promise((r) => { 到闸后 = r; });
      let 放行; const 等放行 = new Promise((r) => { 放行 = r; });
      org.bus.send = async (message) => {
        const 原闸 = message.锁内闸;
        if (typeof 原闸 !== 'function') return 原send.call(org.bus, message);
        return 原send.call(org.bus, {
          ...message,
          锁内闸: async () => {
            await 原闸();
            到闸后();
            await 等放行;
          },
        });
      };
      try {
        const 说p = org.council.say({ subject: MEMBER, 项目: P, id: 开.id, 类型: '分歧', 内容: '屏障里的分歧' });
        await 已到闸后; // say 已过预算闸，消息尚未落线
        const 收p = org.council.converge({ subject: LEAD, 项目: P, id: 开.id, 内容: '屏障收敛' });
        // 观测屏障：等 converge 的收敛事件落线（文件事实），不是时钟等待。
        // 修后 say 持会审串行锁 ⇒ converge 只能等在锁外，暂停期间绝不落线；
        // 若它能落线，就说明 say 的「读-判-写」没和收敛同锁 —— 正是初审指的越序。
        let 暂停期间收敛落线 = false;
        for (let i = 0; i < 200; i += 1) {
          if ((await 会审事件(f, 开.id)).some((r) => r.kind === 'converged')) { 暂停期间收敛落线 = true; break; }
          await new Promise((r) => setImmediate(r));
        }
        放行();
        const [说, 收] = await Promise.all([说p, 收p]);

        assert.equal(暂停期间收敛落线, false, 'say 尚未落线时收敛事件不许先落线（say 的读-判-写必须与会审锁同源）');
        assert.equal(说.轮次, 1);
        assert.equal(收.会审.状态, '已收敛');
        assert.ok(
          收.分歧清单.includes('member-a: 屏障里的分歧'),
          `线性化失败：收敛事件先落线而 say 随后写入（分歧清单=${JSON.stringify(收.分歧清单)}）`,
        );
        assert.ok(
          (await 读消息(org, 开.id)).some((m) => m.内容 === '屏障里的分歧'),
          'say 确实落线（不是靠丢消息换来的绿）',
        );
      } finally { org.bus.send = 原send; }
    } finally { await f.cleanup(); }
  });

  it('反向线性化：收敛已完成后再发言 ⇒ 拒（不复活、不落线）', async () => {
    const { f, org } = await 起组织();
    try {
      const 开 = await 开会审(org);
      await 解锁(org, 开.id);
      await org.council.round({ subject: LEAD, 项目: P, id: 开.id });
      await org.council.converge({ subject: LEAD, 项目: P, id: 开.id });
      const 消息数前 = (await 读消息(org, 开.id)).length;

      await assert.rejects(
        () => org.council.say({ subject: MEMBER, 项目: P, id: 开.id, 类型: '分歧', 内容: '收敛后追加' }),
        (e) => e instanceof Denied,
        '收敛后 say 必须拒',
      );
      assert.equal((await 读消息(org, 开.id)).length, 消息数前, '被拒的发言没有落线');
      assert.equal((await org.council.get(P, 开.id)).状态, '已收敛');
    } finally { await f.cleanup(); }
  });
});

describe('converge / unlock 交错（审计要求）', () => {
  /** 在 org.council.get 返回后停一拍（= 方法已读到状态、还没拿会审锁）。 */
  function 装读取屏障(org) {
    const 原get = org.council.get.bind(org.council);
    let 到; const 已到 = new Promise((r) => { 到 = r; });
    let 放; const 等放 = new Promise((r) => { 放 = r; });
    let 挡 = true;
    org.council.get = async (...args) => {
      const 结果 = await 原get(...args);
      if (挡) { 挡 = false; 到(); await 等放; }
      return 结果;
    };
    return { 已到, 放行: 放, 还原: () => { org.council.get = 原get; } };
  }

  it('已解锁先收敛：并发 unlock 被状态机拒，收敛正常完成，不出现「收敛后再解锁」', async () => {
    const { f, org } = await 起组织();
    try {
      const 开 = await 开会审(org);
      await 解锁(org, 开.id);

      const 屏障 = 装读取屏障(org);
      try {
        const 收p = org.council.converge({ subject: LEAD, 项目: P, id: 开.id, 内容: '交错收敛' });
        await 屏障.已到; // converge 已读到「已解锁」，还没拿锁
        const 解 = await org.council.unlock({ subject: LEAD, 项目: P, id: 开.id }).then(() => '成功', (e) => e);
        assert.ok(解 instanceof Denied && /状态机/.test(解.rule), '已解锁的会审不得再解锁（并发也不例外）');
        屏障.放行();
        const 收 = await 收p;
        assert.equal(收.会审.状态, '已收敛');
        const 事件 = await 会审事件(f, 开.id);
        assert.equal(事件.filter((r) => r.kind === 'unlocked').length, 1, '没有第二条解锁事件');
        assert.equal(事件.filter((r) => r.kind === 'converged').length, 1, '收敛只一条');
      } finally { 屏障.还原(); }
    } finally { await f.cleanup(); }
  });

  it('作答中先解锁：并发 converge 被「未解锁不得收敛」拒，解锁正常完成，不落收敛事件', async () => {
    const { f, org } = await 起组织();
    try {
      const 开 = await 开会审(org);
      await 交齐(org, 开.id);

      const 屏障 = 装读取屏障(org);
      try {
        const 解p = org.council.unlock({ subject: LEAD, 项目: P, id: 开.id });
        await 屏障.已到; // unlock 已读到「作答中 + 全员已交」，还没拿锁
        const 收 = await org.council.converge({ subject: LEAD, 项目: P, id: 开.id }).then(() => '成功', (e) => e);
        assert.ok(收 instanceof Denied && /未解锁不得收敛/.test(收.rule), '未解锁的会审不得收敛（并发也不例外）');
        屏障.放行();
        const 解 = await 解p;
        assert.equal(解.会审.状态, '已解锁');
        const 事件 = await 会审事件(f, 开.id);
        assert.equal(事件.filter((r) => r.kind === 'converged').length, 0, '没有收敛事件');
        assert.equal(事件.filter((r) => r.kind === 'unlocked').length, 1, '解锁恰一条');
      } finally { 屏障.还原(); }
    } finally { await f.cleanup(); }
  });
});

describe('跨存储失配 fail-closed：不许洗预算', () => {
  it('轮边界消息落线失败：状态事件已落线但边界缺失 ⇒ 发言/续换轮都 fail-closed；人工补记后预算按新轮重算', async () => {
    const { f, org } = await 起组织({
      privateFiles: { [部署偏好]: JSON.stringify({ 会审讨论: { 轮次上限: 3 } }) },
    });
    try {
      const 开 = await 开会审(org);
      await 解锁(org, 开.id);
      await org.council.round({ subject: LEAD, 项目: P, id: 开.id }); // 轮1，边界1
      assert.deepEqual(边界消息(await 读消息(org, 开.id)).map((m) => m.内容), [`${ROUND_BOUNDARY_MARK} 1`]);

      const 原send = org.bus.send;
      org.bus.send = async (message) => {
        if (String(message?.内容 ?? '').startsWith(ROUND_BOUNDARY_MARK)) throw new Error('模拟边界消息落线失败');
        return 原send.call(org.bus, message);
      };
      try {
        await assert.rejects(
          () => org.council.round({ subject: LEAD, 项目: P, id: 开.id }),
          (e) => e instanceof Fault && e.code === 'DEBATE_BOUNDARY_MISSING',
          '边界失败必须响亮（Fault），不许静默续轮',
        );
      } finally { org.bus.send = 原send; }

      const 视图 = await org.council.get(P, 开.id);
      assert.equal(视图.轮次, 2, '前提：状态事件已落线（轮次 2），但边界消息没落线');
      assert.deepEqual(边界消息(await 读消息(org, 开.id)).map((m) => m.内容), [`${ROUND_BOUNDARY_MARK} 1`], '线程里仍只有轮1边界');

      // 失配期间：发言必须 fail-closed（否则消息会落进轮1之外、把轮2预算洗掉）。
      await assert.rejects(
        () => org.council.say({ subject: MEMBER, 项目: P, id: 开.id, 类型: '表态', 内容: '失配时发言' }),
        (e) => e instanceof Fault && e.code === 'DEBATE_BOUNDARY_DRIFT',
        '状态轮次与边界轮次失配 ⇒ 发言按 fail-closed 拒',
      );
      // 失配期间：续换轮也必须 fail-closed，不许把缺失的边界「跳过」。
      await assert.rejects(
        () => org.council.round({ subject: LEAD, 项目: P, id: 开.id }),
        (e) => e instanceof Fault && e.code === 'DEBATE_BOUNDARY_DRIFT',
        '失配期间续换轮按 fail-closed 拒（先人工补记）',
      );
      assert.equal((await org.council.get(P, 开.id)).轮次, 2, '失配期间轮次不继续推进');
      assert.equal(
        (await 读消息(org, 开.id)).filter((m) => m.内容 === '失配时发言').length,
        0,
        '失配时被拒的发言没有落线（预算不是纸面读数）',
      );

      // 人工补记：按 Fault 指引直接给线程补一条轮2边界（账本是只增的，不重跑 round）。
      await appendLines(f.layout.busThread(P, 线程名(开.id)), [{
        id: 'msg-人工补记-轮边界-2',
        线程: 线程名(开.id),
        发件: 'system',
        收件: [MEMBER.id, 乙.id],
        类型: '系统',
        内容: `${ROUND_BOUNDARY_MARK} 2`,
        状态: '已投递',
        延后: false,
        引用: null,
        追加于: new Date().toISOString(),
      }]);
      const 说 = await org.council.say({ subject: MEMBER, 项目: P, id: 开.id, 类型: '表态', 内容: '补记后第一句' });
      assert.equal(说.本轮消息数, 1, '补记后预算按新轮重算：这是轮2第1条（不是被轮1额度吞掉）');
      assert.equal(轮边界轮次(await 读消息(org, 开.id)), 2, '边界轮次回到与状态一致');
    } finally { await f.cleanup(); }
  });

  it('状态事件落线失败：不发边界、不推进轮次（不会出现「边界切了轮、状态没推进」的洗预算方向）；恢复后可正常开启', async () => {
    const { f, org } = await 起组织();
    try {
      const 开 = await 开会审(org);
      await 解锁(org, 开.id);

      const 原iso = org.clock.iso;
      org.clock.iso = () => { throw new Error('模拟状态事件落线失败'); };
      try {
        await assert.rejects(
          () => org.council.round({ subject: LEAD, 项目: P, id: 开.id }),
          /模拟状态事件落线失败/,
          '事件落线失败必须抛出（不吞）',
        );
      } finally { org.clock.iso = 原iso; }

      const 视图 = await org.council.get(P, 开.id);
      assert.equal(视图.状态, '已解锁', '状态没推进');
      assert.equal(视图.轮次, 0, '轮次没推进');
      assert.equal(边界消息(await 读消息(org, 开.id)).length, 0, '事件没落线 ⇒ 边界消息也不许先切轮（否则预算被凭空重置）');
      const 审计 = (await org.audit.read({})).filter((r) => r.动作 === '讨论开启' && r.对象?.id === 开.id);
      assert.equal(审计.length, 0, '失败的那次不落「讨论开启」审计');

      const 轮 = await org.council.round({ subject: LEAD, 项目: P, id: 开.id });
      assert.equal(轮.轮次, 1, '恢复后正常开启轮1（没有残留的半截状态）');
      assert.deepEqual(边界消息(await 读消息(org, 开.id)).map((m) => m.内容), [`${ROUND_BOUNDARY_MARK} 1`]);
    } finally { await f.cleanup(); }
  });
});

describe('轮边界判定单源不漂', () => {
  it('轮边界轮次 与 本轮发言 认同一条边界：编号乱序/缺号时切轮口径一致', () => {
    const 消息 = [
      { 发件: 'member-a', 类型: '表态', 内容: 'r1-a' },
      { 发件: 'system', 类型: '系统', 内容: `${ROUND_BOUNDARY_MARK} 1` },
      { 发件: 'member-a', 类型: '表态', 内容: 'r2-a' },
      { 发件: 'system', 类型: '系统', 内容: `${ROUND_BOUNDARY_MARK} 2` },
      { 发件: 'member-b', 类型: '分歧', 内容: 'r3-b' },
    ];
    assert.equal(轮边界轮次(消息), 2);
    assert.deepEqual(本轮发言(消息, ['member-a', 'member-b']).map((m) => m.内容), ['r3-b'], '切轮与对账认同一条（最后一次边界）');
    assert.equal(轮边界轮次([]), null, '没有边界 ⇒ null（调用方按失配处理）');
    assert.equal(
      轮边界轮次([{ 发件: 'system', 类型: '系统', 内容: `${ROUND_BOUNDARY_MARK} 坏轮号` }]),
      null,
      '边界轮号不可解析 ⇒ null（fail-closed，不许猜一个轮次）',
    );
  });
});
