/**
 * 授权与信息边界批（task-授权与信息边界批-第二批-依据--frmeq · 2026-10-16）。
 * 依据：audits/mind-2026-10-16/审查报告 §四 R01/R03/R05（A组）及复核汇总后续顺序第2条。
 *
 * A组判据：
 *  - R01 工具范围按配置键继承：私有部署 JSON 缺 允许/拒绝 键 ⇒ 逐键继承出厂（缺省≠显式空
 *    数组）；失联设置（presence 键写进同一个 部署.json）改动前后工具范围逐项不变。
 *  - R05 重载快照一致性：读前/读后一致才发布——重载中途落盘的撤回不再失效（审查实证：
 *    修前【新 mtime 绑旧名单】，decide 的 mtime 快速路恒判「没变」，撤回空转到下一次
 *    身份写入）；在飞重载期间的并发 reload 不丢 dirty。
 *  - R03 任务授权寿命：未派发（待派发）与终态（已采纳/已结账）不再是写凭据；已派发/
 *    执行中/已打回/已交卷照常；Lead 不受影响（kind 直通）。
 *
 * 注入缝说明：PolicyEngine 构造器注入的 clock 在 #reloadOnce 的状态组装段被调用——
 * 恰在「身份已读、快照未发布」的原撕裂窗内，用它落盘撤回即确定性复现审查实证，
 * 不需要碰任何私有字段。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { cp as fsCp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFixture, LEAD, writeUnder, seedLegacyIndependentCouncil, seedReviewRelation } from './helpers.mjs';
import { Org } from '../src/org.js';
import { runAction } from '../lib/actions.js';
import { Denied, Fault } from '../src/kernel/errors.js';
import { MessageBus } from '../src/bus.js';
import { appendLines } from '../src/kernel/fsx.js';
import { slug } from '../src/kernel/ids.js';
import { fakeHost, fakeExec } from './host-harness.mjs';
import * as kernel from '../components/kernel/lib/index.js';
import { shareOrg } from '../src/runtime.js';
import { drainKernelAudit } from './kernel-drain.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FACTORY = join(here, '..', 'mind');
const P = 'proj-authboundary';

const MEMBER_A = { id: 'member-a', kind: '成员', roleId: '插件工程' };
const MEMBER_B = { id: 'member-b', kind: '成员', roleId: '插件工程' };
const SOVEREIGN = { id: 'sovereign', kind: '主权者' };

/**
 * 带 member-a 拒绝名单的新身份档案（R05 撤回场景的落盘内容）。
 *
 * **只改被测的撤回位**：members 从夹具当前真实档案里取（保留真卡版本 + 委派父），
 * 不手写裸成员行——否则 R05a 测到的是「缺凭证被拒」而不是「撤回立即生效」。
 */
function 撤回档案(fixture) {
  const doc = JSON.parse(readFileSync(fixture.layout.identityFile(), 'utf8'));
  doc.denylist = [{ id: 'member-a' }];
  return `${JSON.stringify(doc, null, 2)}\n`;
}

describe('A · R01：工具范围按配置键继承（缺省 ≠ 显式空数组）', () => {
  /** 复制一份出厂区到临时目录并按需改写 工具总范围.json——不动真出厂件。 */
  async function 起宿主({ 工厂范围, 私有部署 }) {
    const home = await mkdtemp(join(tmpdir(), 'mind-r01-'));
    const factory = join(home, 'mind-factory');
    await fsCp(FACTORY, factory, { recursive: true });
    if (工厂范围 !== null) await writeUnder(factory, '集体L2-共享基础设施/defaults/工具总范围.json', 工厂范围);
    if (私有部署 !== null) await writeUnder(join(home, 'mind-private'), '集体L2-共享基础设施/defaults/部署.json', 私有部署);
    const host = fakeHost();
    await kernel.apply(host.ctx, { home, factoryRoot: factory, privateRoot: join(home, 'mind-private') });
    return { home, host };
  }
  const 清理 = async (home, host) => {
    host.清理();
    await drainKernelAudit(await shareOrg({ home, factoryRoot: join(home, 'mind-factory'), privateRoot: join(home, 'mind-private') }));
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
  };
  const 首个理由 = (host, exec) => host.闸.map((g) => g(exec)).find(Boolean);

  it('私有部署只有 presence 键（失联设置写同文件的真形态）⇒ 出厂收紧清单逐键继承，未被冲掉', async () => {
    // 审查实证（repro-security-confirmed #1）：修前 write/pwsh 从拒变放——「可解析但缺键」
    // 的私有部署 JSON 被折成两份空数组并 break，出厂层的 拒绝 清单整个丢失。
    const { home, host } = await 起宿主({
      工厂范围: JSON.stringify({ 允许: [], 拒绝: ['pwsh', 'write'] }),
      私有部署: JSON.stringify({ 岗位闲置天数: 5, 失联限制: true }), // /mind presence 写出的形态：无范围键
    });
    try {
      assert.match(String(首个理由(host, fakeExec({ name: 'pwsh' }))), /在工具总范围之外/, '出厂的 拒绝 清单必须继承生效');
      assert.match(String(首个理由(host, fakeExec({ name: 'write' }))), /在工具总范围之外/);
      assert.equal(首个理由(host, fakeExec({ name: 'mind' })), undefined, '自家工具不受影响');
    } finally {
      await 清理(home, host);
    }
  });

  it('私有部署【显式】给出空清单 ⇒ 整体放行仍是主权者的合法决定（不被继承翻转）', async () => {
    const { home, host } = await 起宿主({
      工厂范围: JSON.stringify({ 允许: [], 拒绝: ['pwsh'] }),
      私有部署: JSON.stringify({ 允许: [], 拒绝: [] }), // 两键都显式为空 = 有意放开
    });
    try {
      assert.equal(首个理由(host, fakeExec({ name: 'pwsh' })), undefined, '显式空数组 = 显式决定，键在私有层已定，不再看出厂');
    } finally {
      await 清理(home, host);
    }
  });

  it('按键分层的优先序：私有层给了 拒绝 ⇒ 该键由私有层整体决定（出厂的 拒绝 不叠加）', async () => {
    const { home, host } = await 起宿主({
      工厂范围: JSON.stringify({ 允许: [], 拒绝: ['pwsh'] }),
      私有部署: JSON.stringify({ 拒绝: ['bash'] }), // 只给了 拒绝 键
    });
    try {
      assert.match(String(首个理由(host, fakeExec({ name: 'bash' }))), /在工具总范围之外/, '私有层的 拒绝 生效');
      assert.equal(首个理由(host, fakeExec({ name: 'pwsh' })), undefined, '拒绝 键已被私有层整体决定，出厂项不叠加（换岗要改私有层）');
    } finally {
      await 清理(home, host);
    }
  });

  it('坏 JSON ⇒ 故障全拒（fail-closed 回归钉，不因继承改形而弱化）', async () => {
    const { home, host } = await 起宿主({
      工厂范围: JSON.stringify({ 允许: [], 拒绝: [] }),
      私有部署: '{"岗位闲置天数": ',
    });
    try {
      assert.match(String(首个理由(host, fakeExec({ name: 'mind' }))), /工具范围闸故障/);
    } finally {
      await 清理(home, host);
    }
  });
});

describe('A · R05：重载快照读前/读后一致＋在飞合并不丢 dirty', () => {
  it('R05a：重载中途落盘的撤回立即生效——修前【新 mtime 绑旧名单】致 decide 恒判「没变」', async () => {
    const g = await makeFixture();
    try {
      assert.equal(g.policy.healthy, true, '前提：引擎已初载（快照无拒绝名单）');
      const 原iso = g.clock.iso.bind(g.clock);
      let 已注入 = false;
      g.clock.iso = () => {
        if (!已注入) {
          已注入 = true;
          // 审查实证的撕裂窗：身份正文已读、快照未发布、尾部 mtime 未记——此刻撤回落盘。
          // clock.iso 在状态组装段被调，正落在这个窗口里（见文件头注释）。
          writeFileSync(join(g.privateRoot, '身份档案/identity.json'), 撤回档案(g));
        }
        return 原iso();
      };
      await g.policy.reload();
      g.clock.iso = 原iso;
      const d = await g.policy.decide({
        subject: MEMBER_A,
        action: 'write',
        target: { id: 'mem-x', kind: '记忆', authority: '自治', zone: '私有' },
        context: { task: { 负责人: ['member-a'], 状态: '执行中' } },
      });
      assert.equal(d.verdict, 'deny', '撤回必须生效：修前发布旧名单却记下新 mtime，decide 快速路从此看不出变化');
      assert.match(d.rule, /撤回/, '拒因落在撤回名单那条');
    } finally {
      await g.cleanup();
    }
  });

  it('R05b：在飞重载期间档案变化＋并发 reload ⇒ 最终快照含新状态（修前共享 Promise 吞掉写入）', async () => {
    const g = await makeFixture();
    try {
      const 原iso = g.clock.iso.bind(g.clock);
      let 已注入 = false;
      g.clock.iso = () => {
        if (!已注入) {
          已注入 = true;
          writeFileSync(join(g.privateRoot, '身份档案/identity.json'), 撤回档案(g));
          // 并发 reload：第一轮还在飞（我们就在它的加载窗口里）——修前它只共享 Promise
          // 就完事；修后【确有新变化】的并发调用标脏，在飞轮结束再补读一轮。
          void g.policy.reload();
        }
        return 原iso();
      };
      await g.policy.reload();
      g.clock.iso = 原iso;
      const d = await g.policy.decide({
        subject: MEMBER_A,
        action: 'write',
        target: { id: 'mem-x', kind: '记忆', authority: '自治', zone: '私有' },
        context: { task: { 负责人: ['member-a'], 状态: '执行中' } },
      });
      assert.equal(d.verdict, 'deny', '在飞期间的变化不得被「已重载」假象吞掉');
    } finally {
      await g.cleanup();
    }
  });

  it('R05c：并发 reload（档案未变）不触发补读——第三批「读取次数不随调用数翻倍」语义保持（由 fix-batch4 既有用例守护，此处钉返回值语义）', async () => {
    const g = await makeFixture();
    try {
      const r = await Promise.all([g.policy.reload(), g.policy.reload(), g.policy.reload()]);
      assert.deepEqual(r, [true, true, true], 'reload 返回值仍是 #reloadOnce 的布尔语义（外层控制流不得吞掉）');
    } finally {
      await g.cleanup();
    }
  });
});

describe('A · R03：任务授权寿命（未派发/终态不是写凭据）', () => {
  let f;
  let org;
  before(async () => {
    f = await makeFixture();
    org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
  });
  after(async () => {
    await f.cleanup();
  });
  const 执行 = (主体, args) => runAction({ org, 项目: P, 主体, subject: 主体, args });
  const 写知识 = (主体, 任务节点) => 执行(主体, { action: 'memory_write', 类: '经历', 内容: 'x', 来源: '测试', ...(任务节点 ? { 任务: 任务节点.id ?? 任务节点 } : {}), project: P });

  it('待派发（未派发）：负责人名单匹配也拒，拒因指向状态', async () => {
    const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: 'R03-未派发', 负责人: 'member-a', 判据: ['x'] });
    await assert.rejects(
      () => 写知识(MEMBER_A, node),
      (e) => e instanceof Denied && /尚未派发/.test(e.message),
      '未派发 = 授权未生效（审查实证：待派发阶段即可充当写凭据）',
    );
  });

  it('已派发 / 执行中 / 已交卷 / 已打回：照常放行（生产路径回归）', async () => {
    const a = await org.tasks.create({ subject: LEAD, 项目: P, 描述: 'R03-已派发', 负责人: 'member-a', 判据: ['x'] });
    await org.tasks.dispatch(a.id, { subject: LEAD, 项目: P });
    await 写知识(MEMBER_A, a);
    await org.tasks.start(a.id, { subject: MEMBER_A, 项目: P });
    await 写知识(MEMBER_A, a); // 执行中
    await org.tasks.submit(a.id, { subject: MEMBER_A, 项目: P, 结论: '交卷' });
    await 写知识(MEMBER_A, a); // 已交卷（复核窗口内的只增动作不拦——TRANSITIONS 明文）
    const b = await org.tasks.create({ subject: LEAD, 项目: P, 描述: 'R03-打回', 负责人: 'member-a', 判据: ['x'] });
    await org.tasks.dispatch(b.id, { subject: LEAD, 项目: P });
    await org.tasks.start(b.id, { subject: MEMBER_A, 项目: P });
    await org.tasks.submit(b.id, { subject: MEMBER_A, 项目: P, 结论: '交卷' });
    await seedReviewRelation(f, { 项目: P, 目标: b.id });
    await org.tasks.review(b.id, { subject: { id: 'reviewer', kind: '成员', roleId: '复核员' }, 项目: P, 三态: '不过', 分歧清单: ['x'] });
    await 写知识(MEMBER_A, b); // 已打回（返工态）
    await org.tasks.start(b.id, { subject: MEMBER_A, 项目: P }); // 打回重开（状态机路径照常）
  });

  it('已采纳 / 已结账（终态）：拒，拒因指向任务状态', async () => {
    const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: 'R03-终态', 负责人: 'member-a', 判据: ['x'] });
    await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
    await org.tasks.start(node.id, { subject: MEMBER_A, 项目: P });
    await org.tasks.submit(node.id, { subject: MEMBER_A, 项目: P, 结论: '交卷' });
    await seedReviewRelation(f, { 项目: P, 目标: node.id });
    const 过 = await org.tasks.review(node.id, { subject: { id: 'reviewer', kind: '成员', roleId: '复核员' }, 项目: P, 三态: '过', 分歧清单: [] });
    // 补修K：复核只出票；采纳是 Lead 的独立一步（引用真票）——终态仍只由采纳产生。
    await org.tasks.accept(node.id, { subject: LEAD, 项目: P, 票: 过.待采纳?.票 });
    await assert.rejects(
      () => 写知识(MEMBER_A, node),
      (e) => e instanceof Denied && /终态/.test(e.message) && /已采纳/.test(e.message),
      '「曾负责过」不构成永久写凭据（审查实证：真实流转到终态后写仍成功）',
    );
    await org.tasks.settle(node.id, { subject: LEAD, 项目: P, 记忆处置: {} });
    await assert.rejects(
      () => 写知识(MEMBER_A, node),
      (e) => e instanceof Denied && /终态/.test(e.message),
      '已结账同样拒',
    );
  });

  it('Lead 不受任务状态影响（kind 直通，scopeOf 只判成员）', async () => {
    const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: 'R03-Lead', 负责人: 'member-a', 判据: ['x'] });
    await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
    await org.tasks.start(node.id, { subject: MEMBER_A, 项目: P });
    await org.tasks.submit(node.id, { subject: MEMBER_A, 项目: P, 结论: '交卷' });
    await seedReviewRelation(f, { 项目: P, 目标: node.id });
    const 过 = await org.tasks.review(node.id, { subject: { id: 'reviewer', kind: '成员', roleId: '复核员' }, 项目: P, 三态: '过', 分歧清单: [] });
    // 补修K：复核只出票；采纳是 Lead 的独立一步（引用真票）——「已采纳态下 Lead 照写」的前提。
    await org.tasks.accept(node.id, { subject: LEAD, 项目: P, 票: 过.待采纳?.票 });
    await 写知识(LEAD, node); // 已采纳态下 Lead 照写（结账前的组织侧记录）
  });
});

// ── B 组：输出边界与信息隔离 ──────────────────────────────────────────────────

describe('B · R07：任务写响应安全呈现（未齐卷不泄露他人答案）', () => {
  let f;
  let org;
  before(async () => {
    f = await makeFixture();
    org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
  });
  after(async () => {
    await f.cleanup();
  });
  const 执行 = (主体, args) => runAction({ org, 项目: P, 主体, subject: 主体, args });
  /** 独立会审节点：已派发，member-a 已交卷（结论含可探嗅的私密串），member-b 未交。 */
  async function 建半交节点(标记) {
    const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: `R07-${标记}`, 负责人: ['member-a', 'member-b'], 判据: ['x'], 模式: '独立会审' });
    await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
    await org.tasks.start(node.id, { subject: MEMBER_A, 项目: P });
    await org.tasks.submit(node.id, { subject: MEMBER_A, 项目: P, 结论: `member-a的R07私密结论-${标记}` });
    return node;
  }

  it('B 未交卷时调 task_pending：响应不含 A 的答案（修前直接回完整节点）', async () => {
    const node = await 建半交节点('甲');
    const r = await 执行(MEMBER_B, { action: 'task_pending', id: node.id, 原因: 'R07 探嗅' });
    const 文本 = JSON.stringify(r.节点);
    assert.ok(!文本.includes('member-a的R07私密结论-甲'), '未齐卷的成功响应不得携带他人结论');
    assert.equal((r.节点.独立答案 ?? []).some((a) => a.成员 === 'member-a'), false, 'A 的独立答案整段不出现在 B 的响应里');
    assert.equal(r.节点.盲评遮罩, true, '遮罩要明说（不静默裁剪）');
  });

  it('三人会审中间交卷人的 submit 响应只见自己的卷；末位交卷（齐卷=揭名）后恢复全量', async () => {
    // 揭名口径沿用 bus 盲评遮罩的既有判定（全员已交 · 唯一源）：齐卷那一刻本来就能互读，
    // 写响应同步放开；要验的「第二人 submit 泄露」风险面在**三人会审的中间交卷人**——
    // 他交完仍未齐卷，响应必须只带自己的卷（修前返回完整节点，A 的私密结论直接可见）。
    const g = await makeFixture({
      members: {
        'member-a': { id: 'member-a', 岗位: '插件工程', 代: 1, status: '在岗' },
        'member-b': { id: 'member-b', 岗位: '插件工程', 代: 1, status: '在岗' },
        'member-c': { id: 'member-c', 岗位: '插件工程', 代: 1, status: '在岗' },
        lead: { id: 'lead', 岗位: 'Lead', 代: 1, status: '在岗' },
        reviewer: { id: 'reviewer', 岗位: '复核员', 代: 1, status: '在岗' },
      },
    });
    try {
      const org = await Org.open({ home: g.home, factoryRoot: g.factoryRoot, privateRoot: g.privateRoot, project: P });
      const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: 'R07-三人', 负责人: ['member-a', 'member-b', 'member-c'], 判据: ['x'], 模式: '独立会审' });
      await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
      const MEMBER_C = { id: 'member-c', kind: '成员', roleId: '插件工程' };
      await runAction({ org, 项目: P, 主体: MEMBER_A, subject: MEMBER_A, args: { action: 'task_start', id: node.id } });
      await runAction({ org, 项目: P, 主体: MEMBER_A, subject: MEMBER_A, args: { action: 'task_submit', id: node.id, 结论: 'member-a的R07私密结论-三人' } });
      // 首个交卷后节点离开可 start 态（状态机语义）：后续成员直接 submit（各自那份独立答案）。
      const b交 = await runAction({ org, 项目: P, 主体: MEMBER_B, subject: MEMBER_B, args: { action: 'task_submit', id: node.id, 结论: 'member-b的R07结论-三人' } });
      const 交文本 = JSON.stringify(b交.节点);
      assert.ok(!交文本.includes('member-a的R07私密结论-三人'), '中间交卷人（2/3）的响应不得带 A 的答案');
      assert.ok(交文本.includes('member-b的R07结论-三人'), '自己的卷照给');
      assert.equal(b交.节点.盲评遮罩, true);
      // 末位交卷 ⇒ 齐卷（既有揭名点）：C 的响应恢复全量，后续写响应同口径。
      const c交 = await runAction({ org, 项目: P, 主体: MEMBER_C, subject: MEMBER_C, args: { action: 'task_submit', id: node.id, 结论: 'member-c的R07结论' } });
      assert.ok(JSON.stringify(c交.节点).includes('member-a的R07私密结论-三人'), '齐卷=揭名（与 bus 盲评遮罩同口径），末位交卷人的响应可见全量');
      assert.equal(c交.节点.盲评遮罩, undefined);
    } finally {
      await g.cleanup();
    }
  });
});

describe('B · R08：opaque 唯一消息 ID ＋ 盲评输出白名单', () => {
  it('同毫秒同前缀两条都落账不折叠；id 不编码发件人与正文', async () => {
    const g = await makeFixture();
    try {
      // 固定时钟复现 R12 的碰撞条件：同线程同主体同正文前 24 字、同一毫秒。
      const 固定时钟 = { ms: () => 1759000000000, iso: () => '2026-09-28T00:00:00.000Z' };
      const bus = new MessageBus({ layout: g.layout, policy: g.policy, audit: g.audit, clock: 固定时钟 });
      const 公共前缀 = '同线程同作者同正文前二十四字'; // 恰 12 字 ×2 = 24 字符
      await bus.send({ subject: MEMBER_A, 项目: P, 线程: 't-r08', 类型: '表态', 内容: `${公共前缀}尾部甲` });
      await bus.send({ subject: MEMBER_A, 项目: P, 线程: 't-r08', 类型: '表态', 内容: `${公共前缀}尾部乙` });
      const { readJsonl } = await import('../src/kernel/fsx.js');
      const rows = await readJsonl(g.layout.busThread(P, 't-r08'));
      assert.equal(rows.length, 2, '两条成功发送都要在账（修前按 id 折叠只剩第二条）');
      assert.notEqual(rows[0].id, rows[1].id, 'id 必须唯一');
      for (const row of rows) {
        assert.ok(!row.id.includes('member-a'), `id 不编码发件人：${row.id}`);
        assert.ok(!row.id.includes(公共前缀.slice(0, 8)), `id 不编码正文：${row.id}`);
      }
    } finally {
      await g.cleanup();
    }
  });

  it('盲评期遮罩走字段白名单：他人的消息只剩最小字段集（含 id 也不泄露内容）', async () => {
    const f = await makeFixture();
    try {
      const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
      // v2 删了任务「模式」写入路径：按真实历史账本形状播种一个独立会审节点（只读契约仍在）。
      const 节点id = await seedLegacyIndependentCouncil(f, { 项目: P, 描述: 'R08-遮罩' });
      const 结论串 = '选择方案甲不要乙-R08';
      // v2 旧独立会审已封写（bus_send 恒拒）：遮罩是**读面**契约，按历史账本形状直接播种一条消息，
      // 不经过已封闭的写入口（只测读面，不造已不允许的写）。
      await appendLines(f.layout.busThread(P, 节点id), [{
        id: `msg-blind-${Date.now().toString(36)}`,
        线程: 节点id,
        发件: 'member-a',
        收件: [],
        类型: '交卷',
        内容: 结论串,
        状态: '已投递',
        延后: false,
        引用: null,
        追加于: new Date().toISOString(),
      }]);
      const r = await runAction({ org, 项目: P, 主体: MEMBER_B, subject: MEMBER_B, args: { action: 'bus_read', 线程: 节点id } });
      const 他条 = (r.消息 ?? []).find((m) => m.盲评遮罩 === true);
      assert.ok(他条, 'B 读到的是遮罩条目（A 的消息不原样出）');
      const 白名单 = ['id', '线程', '类型', '状态', '追加于', '发件', '内容', '盲评遮罩'];
      for (const 键 of Object.keys(他条)) assert.ok(白名单.includes(键), `遮罩条目只留白名单字段，发现额外字段：${键}`);
      assert.ok(!JSON.stringify(他条).includes(结论串), '遮罩条目任何字段都不含正文');
      assert.ok(!JSON.stringify(他条).includes('member-a'), '不泄露真实发件人');
      assert.ok(!他条.id.includes('选择方案'), 'id 为 opaque，不含正文（修前旧 id 编码正文前缀）');
    } finally {
      await f.cleanup();
    }
  });
});

describe('B · R11：超长披露 fail-closed（尾部未检查 ≠ 通过）', () => {
  let f;
  let org;
  before(async () => {
    f = await makeFixture();
    org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
  });
  after(async () => {
    await f.cleanup();
  });
  const 执行 = (主体, args) => runAction({ org, 项目: P, 主体, subject: 主体, args });

  it('凭据词藏在 20k 之后、无豁免 ⇒ 晋升拒（修前免检扩散）', async () => {
    const 长文 = `${'甲'.repeat(20_100)}password=TOPSECRET-R11`;
    const w = await 执行(LEAD, { action: 'memory_write', 类: '知识', 内容: 长文, 来源: 'R11 测试' });
    const id = w.条目.id;
    await assert.rejects(
      () => 执行(LEAD, { action: 'memory_lifecycle', op: 'promote', id, 岗位: '插件工程', 原因: 'R11 无豁免' }),
      (e) => e instanceof Denied && /超长.*未全检|未全检.*超长/.test(e.rule) || (e instanceof Denied && /超长/.test(e.message) && /未全检/.test(e.message)),
      '超长输入的尾部未过机械检查 ⇒ fail-closed 拒晋升',
    );
  });

  it('Lead 显式豁免 ⇒ 放行且「超长」事实进审计；短文命中（回归）仍拒', async () => {
    const 长文 = `${'乙'.repeat(20_100)}password=TOPSECRET-R11b`;
    const w = await 执行(LEAD, { action: 'memory_write', 类: '知识', 内容: 长文, 来源: 'R11 测试' });
    const ok = await 执行(LEAD, { action: 'memory_lifecycle', op: 'promote', id: w.条目.id, 岗位: '插件工程', 原因: 'R11 豁免', 披露豁免: true });
    assert.ok(ok);
    const 豁免行 = (await org.audit.read({})).filter((r) => r.动作 === '披露豁免').at(-1);
    assert.equal(豁免行.详情.已截断, true, '豁免必须带「超长未全检」事实（Lead 通读过什么要说清）');
    // 回归：短文命中前缀 ⇒ 原有命中拒路径不变。
    const s = await 执行(LEAD, { action: 'memory_write', 类: '知识', 内容: 'password=SHORT-R11', 来源: 'R11 测试' });
    await assert.rejects(
      () => 执行(LEAD, { action: 'memory_lifecycle', op: 'promote', id: s.条目.id, 岗位: '插件工程', 原因: 'R11 命中' }),
      (e) => e instanceof Denied && /敏感模式|命中/.test(e.rule) || (e instanceof Denied && /敏感模式/.test(e.message)),
      '上限内的命中照旧拒（fail-closed 不替代命中检查）',
    );
  });
});

// ── C 组：宿主闸与档位 ────────────────────────────────────────────────────────

describe('C · R17：对象写授权按旧/新最高档判定（法律卡不可被低档覆盖）', () => {
  let f;
  let org;
  before(async () => {
    f = await makeFixture();
    org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
  });
  after(async () => {
    await f.cleanup();
  });
  const 执行 = (主体, args) => runAction({ org, 项目: P, 主体, subject: 主体, args });

  it('既有法律档能力卡：Lead 经生产能力发布同 id ⇒ 拒（判定档升到法律）', async () => {
    // 夹具：主权者直写一张法律档能力卡（id 用 slug(名)——与生产发布的取 id 同口径）。
    const id = slug('R17法律卡', { maxLength: 40 });
    await org.store.write('能力', { meta: { id, 名: 'R17法律卡', authority: '法律', domain: '集体' }, body: '\n# R17法律卡\n\n## 适用岗位\n- 插件工程\n\n## 怎么做\n单源。\n' }, { subject: SOVEREIGN, reason: 'R17 夹具：法律档能力卡' });
    // 修前（审查实证）：正确针对法律卡的 write 判 deny，经 capability_publish（meta 恒自治）
    // 却覆盖成功、法律变自治。修后：判定档 = max(法律, 自治) = 法律 ⇒ Lead 写法律拒。
    await assert.rejects(
      () => 执行(LEAD, { action: 'capability_publish', 名: 'R17法律卡', 正文: 'x', 适用岗位: ['插件工程'], 依据: 'R17' }),
      (e) => e instanceof Denied && /法律/.test(e.rule),
      '既有法律档对象不可被低档位重发覆盖',
    );
  });

  it('主权者发布同 id ⇒ 放行且档位仍是法律（写入档单调不降，标签不可被改写降级）', async () => {
    const ok = await 执行(SOVEREIGN, { action: 'capability_publish', 名: 'R17法律卡', 正文: 'y', 适用岗位: ['插件工程'], 依据: 'R17 主权者改写' });
    assert.ok(ok.能力.version >= 2, '主权者可改写（高档判定只挡非主权者）');
    const after = await org.store.read('能力', slug('R17法律卡', { maxLength: 40 }), { subject: SOVEREIGN });
    // 标签真源在 front matter（decorate 的 .authority 是段推导值——正文无段标记时恒自治，
    // 与本断言要盯的「档位标签」不是一回事）。
    assert.equal(after.meta.authority, '法律', '调用方元数据（自治）不得把既有高档对象的档位标签降下来');
  });

  it('对照：新对象首写，Lead 想直接写法律档 ⇒ 按法律判拒（高档不是逃生门）', async () => {
    await assert.rejects(
      () => org.store.write('能力', { meta: { id: 'cap-r17-new', 名: 'R17新卡', authority: '法律', domain: '集体' }, body: '\n# R17新卡\n\n## 适用岗位\n- 插件工程\n\n## 怎么做\nx\n' }, { subject: LEAD, reason: 'R17 对照' }),
      (e) => e instanceof Denied && /法律/.test(e.rule),
      '首写按（可能被抬高的）声明档判：Lead 不得借「新对象」直写法律档',
    );
  });
});

describe('C · R06：宿主闸注册失败 ⇒ 拒绝激活/记红；真实回执进探针', () => {
  /** 装一个内核：guard 注册第 N 次失败可注入（1=范围闸，2=调度创建闸）。 */
  async function 起内核(失败位 = 0) {
    const home = await mkdtemp(join(tmpdir(), 'mind-r06-'));
    await writeUnder(join(home, 'mind-private'), 'README.md', '# 私有区（测试）\n');
    const host = fakeHost();
    if (失败位 > 0) {
      const tools = host.ctx.get('tools');
      const 原 = tools.guard.bind(tools);
      let n = 0;
      tools.guard = (fn) => {
        n += 1;
        if (n === 失败位) throw new Error(`注入：第 ${n} 次 guard 注册失败`);
        return 原(fn);
      };
    }
    await kernel.apply(host.ctx, { home, factoryRoot: FACTORY, privateRoot: join(home, 'mind-private') });
    return { home, host };
  }
  const 清理 = async (home, host) => { host.清理(); await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }); };

  for (const mode of ['注册抛错', 'guard接口缺失']) it(`首道范围闸${mode} ⇒ 组件加载抛稳定Fault，无工具/命令/提示词副作用`, async () => {
    const home = await mkdtemp(join(tmpdir(), 'mind-r06-required-'));
    const host = fakeHost();
    const cause = new Error('注入：首道 guard 注册失败');
    if (mode === '注册抛错') host.ctx.tools.guard = () => { throw cause; };
    else host.ctx.tools.guard = undefined;
    try {
      await assert.rejects(() => kernel.apply(host.ctx, { home, factoryRoot: FACTORY, privateRoot: join(home, 'mind-private') }),
        (error) => error instanceof Fault && error.code === 'KERNEL_REQUIRED_GUARD_UNAVAILABLE'
          && (mode === '注册抛错' ? error.cause === cause : error.cause instanceof TypeError));
      assert.equal(host.闸.length, 0, '如实保留首道注册失败事实，不能声称宿主原生工具已被阻断');
      assert.equal(host.工具.size, 0, '不注册降级mind工具伪装加载成功');
      assert.equal(host.命令.size, 0);
      assert.equal(host.段落.length, 0);
      assert.equal(host.钩子.size, 0, '失败在装配和任何异步副作用之前');
      assert.ok(host.日志.some((l) => l.startsWith('error') && /拒绝激活/.test(l)), 'error 级日志（不再是 warn 后装没事）');
    } finally {
      await 清理(home, host);
    }
  });

  it('调度创建闸注册失败（未授权项目）⇒ 回执记红：闸在位探针经回执文件见红', async () => {
    const { home, host } = await 起内核(2);
    try {
      assert.ok(host.工具.get('mind'), '未授权项目：创建闸不承重，装配继续（回执仍记红）');
      // 同一 home 上再开一个 org（跨装配实例）：探针读的是回执**文件**——R06 的可观测面。
      const org = await Org.open({ home, factoryRoot: FACTORY, privateRoot: join(home, 'mind-private'), project: 'default' });
      const ran = await org.probes.run({ subject: { id: 'lead', kind: 'Lead' } });
      const 闸 = ran.见红.find((r) => r.探针 === '闸在位');
      assert.ok(闸, '闸在位探针必须见红（修前只查策略对象、恒绿）');
      assert.match(String(闸.详情), /调度创建闸.*注册失败/, '详情点名失败的那道闸');
      assert.ok(!ran.全绿, '红就是红');
    } finally {
      await 清理(home, host);
    }
  });

  it('无注入 ⇒ 两道闸回执全绿；探针详情带真实回执读数', async () => {
    const { home, host } = await 起内核(0);
    try {
      const org = await Org.open({ home, factoryRoot: FACTORY, privateRoot: join(home, 'mind-private'), project: 'default' });
      const ran = await org.probes.run({ subject: { id: 'lead', kind: 'Lead' } });
      const 闸 = ran.结果.find((r) => r.探针 === '闸在位');
      assert.equal(闸.状态, '绿');
      assert.match(闸.详情, /范围闸.*调度创建闸.*已注册|调度创建闸.*范围闸.*已注册/, '回执双闸在案');
      assert.ok(ran.全绿, '其余探针不受回执通道影响');
    } finally {
      await 清理(home, host);
    }
  });
});
