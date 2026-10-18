/**
 * 设计评审修复批次 C（2026-10-15，对应 docs/归档/审查轮-2026-10/设计评审报告-dsh-mind-2026-10-15.md）。
 *
 * 覆盖（十二项中的可测项）：
 *   #7  markInteraction 来源白名单闸 + 失联→在线迁移那一刻的单条审计（常规心跳不刷）；
 *   #8  workbench 会审行盲标与 review.盲标分配 单源（同人同标；名册集合变 ⇒ 映射变）；
 *   #10 探针审计行主体=真实触发者；upgrade.compare 落签名时刻来自注入时钟；
 *   #11 findCard / upgrade.#resolve 候选集单源（撤回能力卡不再让探针误报红）；
 *   #12 assign 的岗位卡存在性复检在锁内（check 后卡被删 ⇒ 拒，登记不发生）；
 *   #16 INTERFACES.md 漂移守卫（不再登记死 API；同源路由面已记载）；
 *   #17 审计尾长单源（动作面 20 / 看板包 40，常量钉值）；
 *   P3-a stats 走行缓存（数字与直读对照一致；坏行可见不丢）；P3-b gradeOf('设置变更')；
 *   P3-c 「只回传最新 N 条」措辞改为账本序。
 *   （#18 是纯注释项、#16 的五处正文修订是文档本身，均以本文件的守卫断言覆盖可机检的部分。）
 *
 * 塞bug校准（2026-10-15 实做）：#7 来源闸、#8 盲标单源、#11 findCard 三项在
 * $env:TEMP\dshmind-calib-c 副本里还原缺陷 ⇒ 本文件对应断言必红且红在对应行 ⇒ 删副本。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appendFile, rm } from 'node:fs/promises';
import { makeFixture, writeUnder, SOVEREIGN, LEAD, MEMBER } from './helpers.mjs';
import { Org } from '../src/org.js';
import { RoleRegistry } from '../src/registry.js';
import { UpgradeManager, 按id找卡 } from '../src/upgrade.js';
import { ProbeRunner } from '../src/probes.js';
import { MemoryService, fold } from '../src/memory.js';
import { GRADE, 审计尾默认条数, 看板审计尾条数 } from '../src/audit.js';
import { 盲标分配 } from '../src/review.js';
import { projectWorkbench } from '../src/workbench.js';
import { runAction } from '../lib/actions.js';
import { 看板包 } from '../components/kernel/lib/routes.js';
import { readJsonl, readJsonOrNull } from '../src/kernel/fsx.js';
import { Denied, InvalidBody } from '../src/kernel/errors.js';
import { DIR } from '../src/paths.js';

const P = 'default';

/** 造一个已交齐的独立会审节点：两个负责人各交一份（照 fix-batch-2026-10-14 的体例）。 */
async function 会审节点(org, { 结论A = '甲案', 结论B = '乙案' } = {}) {
  const { id } = await org.tasks.create({ subject: LEAD, 项目: P, 描述: `会审-${Math.random()}`, 负责人: ['member-a', 'member-b'], 判据: ['判据一'], 模式: '独立会审' });
  await org.tasks.dispatch(id, { subject: LEAD, 项目: P });
  await org.tasks.start(id, { subject: { id: 'member-a', kind: '成员' }, 项目: P });
  await org.tasks.submit(id, { subject: { id: 'member-a', kind: '成员' }, 项目: P, 结论: `a:${结论A}`, 结论层: 结论A });
  await org.tasks.submit(id, { subject: { id: 'member-b', kind: '成员' }, 项目: P, 结论: `b:${结论B}`, 结论层: 结论B });
  return id;
}

/** 桩时钟：时刻完全由测试控制（#10：compare 的签名时刻不许再碰 new Date()）。 */
class 桩钟 {
  constructor(iso) {
    this.value = iso;
  }
  now() {
    return new Date(this.value);
  }
  iso() {
    return this.value;
  }
  ms() {
    return Date.parse(this.value);
  }
}

// ── #7 markInteraction：来源闸 + 迁移审计 ─────────────────────────────────────

describe('设计评审 2026-10-15 批次C · #7 markInteraction 来源闸与迁移审计', () => {
  it('来源缺席 / 白名单外 ⇒ InvalidBody 响亮拒，lastInteraction 一个字节不动', async () => {
    const f = await makeFixture();
    try {
      const reg = new RoleRegistry({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
      const 前 = (await reg.identity()).sovereign.lastInteraction;
      for (const bad of [undefined, null, '', '模型自报', '宿主事件 ']) {
        await assert.rejects(
          () => reg.markInteraction({ 来源: bad }),
          (e) => e instanceof InvalidBody && /来源/.test(e.message),
          `来源=${JSON.stringify(bad)} 必须拒`,
        );
      }
      // 完全不带 spec 的老式调用同样拒（spec = {} ⇒ 来源 undefined）。
      await assert.rejects(() => reg.markInteraction(), (e) => e instanceof InvalidBody);
      assert.equal((await reg.identity()).sovereign.lastInteraction, 前, '被拒的调用不许碰失联时钟');
    } finally {
      await f.cleanup();
    }
  });

  it('三个合法来源照常写 lastInteraction 且并列落 交互来源（lastInteraction 形状不变）', async () => {
    const f = await makeFixture();
    try {
      const reg = new RoleRegistry({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
      for (const 来源 of ['宿主事件', 'presence命令', '部署引导']) {
        const r = await reg.markInteraction({ 来源 });
        assert.equal(typeof r.lastInteraction, 'string', 'lastInteraction 仍是 ISO 字符串（形状不许变——policy/time 在读它）');
        assert.equal(r.交互来源, 来源, `返回值带交互来源：${来源}`);
        const 档案 = (await reg.identity()).sovereign;
        assert.equal(档案.lastInteraction, r.lastInteraction);
        assert.equal(档案.交互来源, 来源);
      }
    } finally {
      await f.cleanup();
    }
  });

  it('失联夹具：首次交互落一条「主权者交互」审计（含来源与解除时刻），第二条不落', async () => {
    const f = await makeFixture({ offline: true });
    try {
      const reg = new RoleRegistry({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
      assert.equal(f.policy.presence().lost, true, '前置：夹具处于失联');
      const 迁移行数 = async () => (await f.audit.read({})).filter((r) => r.动作 === '主权者交互');
      assert.equal((await 迁移行数()).length, 0, '前置：账上还没有迁移审计');
      const 第一 = await reg.markInteraction({ 来源: '宿主事件' });
      assert.equal(f.policy.presence().lost, false, '一次交互即解除（写档案后重载）');
      const rows = await 迁移行数();
      assert.equal(rows.length, 1, '失联→在线迁移那一刻落且只落一条');
      assert.deepEqual(rows[0].主体, { id: 'sovereign', kind: '主权者' }, '主体如实记主权者（这次交互是主权者的）');
      assert.equal(rows[0].详情.来源, '宿主事件', '详情注明来源');
      assert.equal(rows[0].详情.解除时刻, 第一.lastInteraction, '详情注明解除时刻');
      assert.equal(rows[0].档位, GRADE.全记, '档位显式入表（不靠表外 fallback）');
      // 常规心跳（在线状态下的后续交互）不逐条入账。
      await reg.markInteraction({ 来源: 'presence命令' });
      await reg.markInteraction({ 来源: '宿主事件' });
      assert.equal((await 迁移行数()).length, 1, '第二条、第三条交互不许再刷「主权者交互」');
    } finally {
      await f.cleanup();
    }
  });

  it('失联保险已关闭（失联限制=false）：交互照记但不构成「迁移」——不落审计', async () => {
    const f = await makeFixture({ offline: true, presence: { 失联限制: false, 响应期限小时: 1 } });
    try {
      const reg = new RoleRegistry({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
      assert.equal(f.policy.presence().已关闭, true, '前置：开关是关的');
      await reg.markInteraction({ 来源: '宿主事件' });
      assert.equal((await f.audit.read({})).filter((r) => r.动作 === '主权者交互').length, 0, '关了就没有「失联→在线」可言，不许落迁移审计');
    } finally {
      await f.cleanup();
    }
  });
});

// ── #8 盲标单源：council 遮罩 = review.盲标分配 ────────────────────────────────

describe('设计评审 2026-10-15 批次C · #8 盲标单源', () => {
  it('同一场会审：成员读者看到的盲标与 盲标分配(线程名(会审id), 参与者) 一一对应（同人同标）', async () => {
    const f = await makeFixture();
    try {
      const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
      const 开 = await org.council.open({ subject: LEAD, 项目: P, 问题: '盲标单源', 参与者: ['member-a', 'member-b'] });
      await org.council.answer({ subject: { id: 'member-a', kind: '成员', roleId: '插件工程' }, 项目: P, id: 开.id, 结论: '甲卷' });
      const { 线程名 } = await import('../src/council.js');
      const 标 = new Map(盲标分配(线程名(开.id), 开.会审.参与者).map((e) => [e.id, e.盲标]));
      const 乙读 = (await org.council.list({ 项目: P, 读者: { id: 'member-b', kind: '成员', roleId: '插件工程' } }))[0];
      const 甲条 = 乙读.答案.find((a) => a.成员 === 标.get('member-a'));
      assert.ok(甲条, '乙读到的他人条目必须用单源盲标（同人同标）');
      assert.equal(甲条.成员, 标.get('member-a'), '盲标逐字等于 盲标分配 的结果');
      assert.equal(甲条.结论, null, '盲标条目不许带结论');
      assert.equal(new Set([...标.values()]).size, 2, '盲标不重复');
    } finally {
      await f.cleanup();
    }
  });

  it('确定性置换钉值：名册集合变 ⇒ 同一成员的标跟着变；输入顺序变 ⇒ 映射不变', () => {
    const 线程 = '会审/c-盲标来源';
    const 映 = (名册) => new Map(盲标分配(线程, 名册).map((e) => [e.id, e.盲标]));
    const 甲乙 = 映(['member-a', 'member-b']);
    // 非下标恒等：确定性洗牌真实生效（若实现退回下标盲标，a 恒为成员 A）。
    assert.notEqual(甲乙.get('member-a'), '成员 A', '同一成员两套盲标不许并存（下标盲标恒 A）');
    // 输入顺序变（名册集合不变）⇒ 同人同标（集合语义）。
    assert.deepEqual([...映(['member-b', 'member-a'])].sort(), [...甲乙].sort(), '交卷顺序不许决定谁拿 A');
    // 名册集合变 ⇒ 同一成员的标变（种子含名册集合）。
    const 甲丙 = 映(['member-a', 'member-c']);
    assert.notEqual(甲丙.get('member-a'), 甲乙.get('member-a'), '换人 ⇒ 重洗（下标盲标察觉不了名册变化）');
  });

  it('与单源函数直连复核：council 遮罩的标表 === 盲标分配(线程名(会审id), 参与者)', async () => {
    const f = await makeFixture();
    try {
      const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
      const 开 = await org.council.open({ subject: LEAD, 项目: P, 问题: '标表复核', 参与者: ['member-a', 'member-b'] });
      const { 线程名 } = await import('../src/council.js');
      const 直连 = new Map(盲标分配(线程名(开.id), 开.会审.参与者).map((e) => [e.id, e.盲标]));
      await org.council.answer({ subject: { id: 'member-a', kind: '成员', roleId: '插件工程' }, 项目: P, id: 开.id, 结论: '甲' });
      const 乙读 = (await org.council.list({ 项目: P, 读者: { id: 'member-b', kind: '成员', roleId: '插件工程' } }))[0];
      assert.deepEqual(
        乙读.答案.map((r) => r.成员),
        [直连.get('member-a')],
        'member-a 的盲标与单源函数直连结果一致',
      );
    } finally {
      await f.cleanup();
    }
  });
});

// ── #10 探针审计主体 + compare 注入时钟 ───────────────────────────────────────

describe('设计评审 2026-10-15 批次C · #10 真实触发者与注入时钟', () => {
  it('探针审计行主体 = 传入 subject（手动 Lead 巡检在账上可分辨；system 路径行为不变）', async () => {
    const f = await makeFixture();
    try {
      const runner = new ProbeRunner({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
      await runner.run({ subject: LEAD });
      let rows = (await f.audit.read({})).filter((r) => ['探针巡检', '探针异常'].includes(r.动作));
      assert.ok(rows.length >= 1, '巡检入账了');
      assert.ok(rows.every((r) => r.主体.id === 'lead' && r.主体.kind === 'Lead'), `主体必须是传入的 subject（修前恒 system）；实际 ${JSON.stringify(rows.map((r) => r.主体))}`);
      // 机制自动路径（system 主体）照旧可跑、照旧记 system。
      await runner.run({ subject: { id: 'system', kind: '系统' } });
      rows = (await f.audit.read({})).filter((r) => ['探针巡检', '探针异常'].includes(r.动作));
      assert.ok(rows.some((r) => r.主体.id === 'system'), 'system 主体的自动路径行为不变');
    } finally {
      await f.cleanup();
    }
  });

  it('upgrade.compare 的签名落盘时刻来自注入时钟（修前 new Date() 控不住）', async () => {
    const 签名于 = async (iso) => {
      const f = await makeFixture();
      try {
        const up = new UpgradeManager({ layout: f.layout, policy: f.policy, audit: f.audit, clock: new 桩钟(iso) });
        await up.compare({ 对象: '权限矩阵', subject: LEAD });
        const 签名 = await readJsonOrNull(f.layout.private(DIR.升级, '比对签名.json'));
        assert.ok(签名, '比对后落了签名文件');
        return 签名.于;
      } finally {
        await f.cleanup();
      }
    };
    assert.equal(await 签名于('2026-10-15T01:02:03Z'), '2026-10-15T01:02:03Z', '签名时刻 = 桩钟读数');
    assert.equal(await 签名于('2027-01-01T00:00:00Z'), '2027-01-01T00:00:00Z', '两次调用、两个桩 ⇒ 两个时刻（时间可由注入时钟控制）');
  });
});

// ── #11 findCard / #resolve 候选集单源 ─────────────────────────────────────────

describe('设计评审 2026-10-15 批次C · #11 按id找卡单源', () => {
  const 能力卡正文 = ['---', 'id: cap-x', 'kind: 能力', 'authority: 自治', 'zone: 私有', 'domain: 集体', 'version: 1', '---', '# cap-x', '', '## 适用岗位', '- 插件工程', '', '## 怎么做', '先搜后写。'].join('\n');

  it('撤回一张能力卡后「撤回名单一致」探针不误报（修前按旧候选集找不到 ⇒ 误报红）', async () => {
    const f = await makeFixture({
      privateFiles: { '集体L2-共享基础设施/能力库/cap-x.md': 能力卡正文 },
      denylist: [{ id: 'cap-x', 理由: '撤回（测试）', 撤于: '2026-10-15T00:00:00.000Z', 由: 'sovereign' }],
    });
    try {
      const runner = new ProbeRunner({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
      const ran = await runner.run({ subject: LEAD });
      const 撤回 = ran.结果.find((r) => r.探针 === '撤回名单一致');
      assert.equal(撤回.状态, '绿', `能力卡还在盘上（撤回不删卡），不许误报红；详情：${撤回.详情}`);
      assert.match(撤回.详情, /卡都还在盘上/);
    } finally {
      await f.cleanup();
    }
  });

  it('共享实现回归：按id找卡 认 规则件+角色卡+能力卡 三类两区；upgrade.compare 走同一份解析', async () => {
    const f = await makeFixture({ privateFiles: { '集体L2-共享基础设施/能力库/cap-x.md': 能力卡正文 } });
    try {
      assert.ok(await 按id找卡(f.layout, 'cap-x', '私有'), '能力卡在私有区找得到（修前探针那份候选集漏了能力卡）');
      assert.ok(await 按id找卡(f.layout, '权限矩阵', '出厂'), '规则件在出厂区找得到');
      assert.equal(await 按id找卡(f.layout, 'cap-x', '出厂'), null, '出厂区没有副本 ⇒ null');
      assert.equal(await 按id找卡(f.layout, '不存在-卡', '私有'), null, '三处都没有 ⇒ null');
      // upgrade 侧同一份解析：compare 能把能力卡当对象解析出条款（#resolve 委托同一实现）。
      const up = new UpgradeManager({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
      const rows = await up.compare({ 对象: 'cap-x', subject: LEAD });
      assert.ok(rows.length >= 1, `compare 经同一实现解析到能力卡条款；实际 ${JSON.stringify(rows)}`);
    } finally {
      await f.cleanup();
    }
  });
});

// ── #12 assign 岗位卡锁内复检 ──────────────────────────────────────────────────

describe('设计评审 2026-10-15 批次C · #12 assign 岗位卡锁内复检', () => {
  const 角色卡 = ['---', 'id: 插件工程', 'kind: 身份', 'authority: 自治', 'zone: 私有', 'domain: 个体', 'version: 1', '---', '# 插件工程', '', '## 个体L0 · 身份', '插件工程岗。', '', '## 个体L2 · 能力', 'cap-x', ''].join('\n');

  it('岗位卡在 policy.check 之后被删 ⇒ 锁内复检拒，登记不发生（修前会带着已删卡登记）', async () => {
    const f = await makeFixture({ privateFiles: { '集体L3-成员角色卡/插件工程.md': 角色卡 } });
    try {
      const reg = new RoleRegistry({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
      const 卡路径 = `${f.layout.roleCardDir('自治')}/插件工程.md`;
      // 夹具默认也带一张出厂 插件工程 卡（默认真钉用）：本反例要「岗位上没有任何卡」，
      // 竞态窗口里必须两张一起删，否则锁内复检会被出厂卡兜住（前提不成立 ⇒ 假绿）。
      const 出厂卡路径 = `${f.layout.roleCardDir('出厂')}/插件工程.md`;
      // 正例：卡在 ⇒ 登记成功（锁内复检不误伤正常路径）。
      const ok = await reg.assign({ subject: LEAD, 岗位: '插件工程', 实例: 'member-ok' });
      assert.equal(ok.状态, '在岗');
      // 竞态夹具：policy.check 通过的那一刻把卡删掉——模拟「check 与写入之间岗位卡被删」的窗口。
      const 原check = f.policy.check.bind(f.policy);
      let 已删 = false;
      f.policy.check = async (input) => {
        if (!已删) {
          已删 = true;
          await rm(卡路径);
          await rm(出厂卡路径, { force: true });
        }
        return 原check(input);
      };
      await assert.rejects(
        () => reg.assign({ subject: LEAD, 岗位: '插件工程', 实例: 'member-race' }),
        (e) => e instanceof Denied && /实例权限只来自岗位/.test(e.rule),
        '锁内复检必须拒（修前：锁外预读已通过 ⇒ 不存在的岗位进档案）',
      );
      assert.equal((await reg.identity()).members['member-race'], undefined, '被拒的登记不许落进身份档案');
    } finally {
      await f.cleanup();
    }
  });
});

// ── #16 INTERFACES.md 漂移守卫 ────────────────────────────────────────────────

describe('设计评审 2026-10-15 批次C · #16 INTERFACES.md 漂移守卫', () => {
  it('不再登记死 API；五处修订与同源路由面已落在文档上', () => {
    const text = readFileSync(new URL('../INTERFACES.md', import.meta.url), 'utf8');
    // 锚「旧登记形态」（逗号连接的导出行）：文档里点名历史（斜杠连接）不算登记。
    assert.ok(!/RoundRecorder,\s*entryFingerprint/.test(text), '§1 不许再登记 src 里不存在的导出（轮桶在 kernel 内存 Map）');
    assert.match(text, /async unlock\(\{ subject, 项目, 节点, 线程, 全员已交, 参与者, 内容 \}\)/, '§2.2 bus.unlock 签名 = 实况');
    // v2（2026-10-18 复核者降级）：review.nominate / appoint 已删，文档须登记删除而非登记签名。
    assert.ok(!/async nominate\(/.test(text), '§2.9 review.nominate 已随复核者降级删除，不许再登记签名');
    assert.match(text, /提名 \/ 池 \/ 轮派 \/ 任命/, '§2.9 须点名复核员任命链已整体删除（v2）');
    assert.match(text, /有实现、无动作\/命令入口/, '§2.6 registry.restore 标注入口现状');
    assert.match(text, /\/plugins\/dsh-mind\/ping/, '同源路由面：三端点已记载');
  });
});

// ── #17 审计尾长单源 ──────────────────────────────────────────────────────────

describe('设计评审 2026-10-15 批次C · #17 审计尾长单源', () => {
  it('常量钉值（不许顺手改）：动作面 20 / 看板包 40', () => {
    assert.equal(审计尾默认条数, 20);
    assert.equal(看板审计尾条数, 40);
  });

  it('行为回归：workbench/audit_tail 默认 20 条；路由看板包 40 条', async () => {
    const f = await makeFixture();
    let org;
    try {
      org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
      for (let i = 0; i < 45; i++) {
        await org.audit.append({ 动作: '只读调用', 主体: LEAD, 对象: { id: `尾长-${i}`, kind: '测试' }, 依据: '尾长回归' });
      }
      const tail = await runAction({ org, 项目: P, subject: LEAD, 主体: LEAD, args: { action: 'audit_tail' } });
      assert.equal(tail.审计.length, 20, `audit_tail 默认 = ${审计尾默认条数} 条`);
      const bench = await runAction({ org, 项目: P, subject: LEAD, 主体: LEAD, args: { action: 'workbench' } });
      assert.equal(bench.数据.审计尾.length, 20, 'workbench 动作面审计尾默认 20 条');
      const 包 = await 看板包({ org, 项目: P });
      assert.equal(包.数据.审计尾.length, 40, `路由看板包 = ${看板审计尾条数} 条（节奏不因单源而变）`);
    } finally {
      await f.cleanup();
    }
  });
});

// ── P3-a / P3-b / P3-c ────────────────────────────────────────────────────────

describe('设计评审 2026-10-15 批次C · P3-a stats 走行缓存且坏行可见', () => {
  it('计数与直读对照一致；重复调用（缓存命中）读数稳定', async () => {
    const f = await makeFixture();
    let org;
    try {
      org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
      for (const i of [1, 2, 3]) {
        await org.memory.remember({ subject: LEAD, 类: '知识', 内容: `可复用知识 ${i}`, 来源: '测试', 项目: P });
      }
      await org.memory.remember({ subject: LEAD, 类: '经历', 内容: '一次经历', 来源: '测试', 项目: P });
      const s1 = await org.memory.stats();
      // 对照：不走服务，直读账本 + 同一个 fold 纯函数算期望值。
      const 知识行 = [];
      for (const scope of [DIR.跨项目, P]) 知识行.push(...(await readJsonl(f.layout.memoryLog(scope, '知识'))));
      const 期望知识 = fold(知识行).filter((e) => e.状态 !== '物理删除').length;
      const 期望经历 = fold(await readJsonl(f.layout.memoryLog(DIR.跨项目, '经历'))).filter((e) => e.状态 !== '物理删除').length;
      assert.equal(s1.计数.知识, 期望知识, `知识计数与直读一致（修前口径不许变）；实际 ${s1.计数.知识} vs ${期望知识}`);
      assert.equal(s1.计数.经历, 期望经历, '经历计数与直读一致');
      assert.equal(s1.坏行, undefined, '无坏行时不报坏行键');
      const s2 = await org.memory.stats();
      assert.deepEqual(s2, s1, '第二次 stats（缓存命中）读数与第一次逐字节相同');
    } finally {
      await f.cleanup();
    }
  });

  it('坏行夹具：stats 照报坏行并告警（缓存路径同源携带，坏行不进计数）', async () => {
    const f = await makeFixture();
    let org;
    try {
      org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
      await org.memory.remember({ subject: LEAD, 类: '知识', 内容: '好行', 来源: '测试', 项目: P });
      const 账本 = f.layout.memoryLog(P, '知识');
      await appendFile(账本, '{"这是坏行：崩溃撕裂的半行\n', 'utf8');
      const s = await org.memory.stats();
      assert.equal(s.坏行, 1, `坏行可见不丢（2026-10-13 裁决 P2-5）；实际 ${JSON.stringify(s.坏行)}`);
      assert.match(String(s.坏行告警), /必须可见/, '坏行>0 要带告警说明');
      assert.equal(s.计数.知识, 1, '坏行不进计数（好行照数）');
      const s2 = await org.memory.stats();
      assert.equal(s2.坏行, 1, '缓存命中路径同样报得出坏行（坏行计数随缓存条目同源携带）');
    } finally {
      await f.cleanup();
    }
  });
});

describe('设计评审 2026-10-15 批次C · P3-b/P3-c', () => {
  it("gradeOf('设置变更') === '全记'（显式入表，不靠表外 fallback）", async () => {
    const f = await makeFixture();
    try {
      assert.equal(f.audit.gradeOf('设置变更'), GRADE.全记, 'P3-b：结果对，机制也要对——表内有名');
      assert.equal(f.audit.gradeOf('主权者交互'), GRADE.全记, '同批新动作「主权者交互」也显式入表');
    } finally {
      await f.cleanup();
    }
  });

  it('「最新 N 条」措辞已改为账本序（说明文字与 slice(-N) 的实际语义一致）', async () => {
    const f = await makeFixture();
    let org;
    try {
      org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
      for (const i of [1, 2, 3]) {
        await org.memory.remember({ subject: LEAD, 类: '知识', 内容: `条目 ${i}`, 来源: '测试', 项目: P });
      }
      const q = await org.memory.query({ subject: LEAD, 项目: P, 条数上限: 2 });
      assert.equal(q.条目.length, 2, '预算只管条目这一栏');
      assert.match(q.说明, /只回传账本序最后 2 条（按账本顺序，非按记于时间排序）/, '措辞 = 实际语义（账本扫描序的尾部）');
      assert.ok(!/只回传最新/.test(q.说明), '旧措辞「只回传最新 N 条」不许再出现（P3-c）');
    } finally {
      await f.cleanup();
    }
  });
});
