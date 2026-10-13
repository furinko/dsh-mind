/**
 * 2026-10-13 裁决第二批 回归：
 *  - P2-18 更正声明授权引用存在性（fail-closed）；
 *  - P2-12 失联冻结覆盖 Lead 的法律档 publish（升级裁决通道）；
 *  - M1 交卷人不得复核自己的卷（提审分离）；
 *  - M6 岗位卡 meta.id 与文件名不一致 ⇒ fail-closed 拒；
 *  - P2-13 盲标映射去顺序化且 openBlind/reveal 一致；
 *  - P3 打回≥2 的 escalated 只落一次；
 *  - 裁决3 探针快照被改 ⇒ autoRollback 拒绝定位并告警。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { makeFixture, LEAD, MEMBER, REVIEWER } from './helpers.mjs';
import { AuditLog } from '../src/audit.js';
import { TaskGraph } from '../src/tasks.js';
import { RoleRegistry } from '../src/registry.js';
import { PolicyEngine } from '../src/policy.js';
import { ProbeRunner } from '../src/probes.js';
import { 盲标分配 } from '../src/review.js';
import { Denied } from '../src/kernel/errors.js';
import { appendLines } from '../src/kernel/fsx.js';

const P = 'p-r2';

/** 在任务图里落一个节点 id（授权引用的存在性载体）。 */
async function 落任务节点(f, id, 项目 = P) {
  const log = f.layout.taskLog(项目);
  await mkdir(dirname(log), { recursive: true });
  await appendLines(log, [{ seq: 1, at: new Date().toISOString(), by: { id: 'lead', kind: 'Lead' }, kind: 'created', id, 描述: '载体', 判据: ['x'] }]);
}

describe('裁决第二批 · P2-18 授权引用存在性', () => {
  it('悬空授权（任务图里没有该节点）⇒ 拒', async () => {
    const f = await makeFixture();
    const audit = new AuditLog({ layout: f.layout, clock: f.clock });
    // 造一处真实瑕疵（单点 hash 断裂）：授权检查在瑕疵核验之后，先过前面的闸。
    await audit.append({ 动作: '状态变更', 主体: LEAD, 对象: 'a', 依据: '第 1 行', 结果: 'ok' });
    await audit.append({ 动作: '状态变更', 主体: LEAD, 对象: 'b', 依据: '第 2 行（将被写坏）', 结果: 'ok' });
    const month = (await audit.months())[0];
    const file = f.layout.auditLog(month);
    const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
    const row2 = JSON.parse(lines[1]);
    row2.依据 = '写后改了';
    lines[1] = JSON.stringify(row2);
    await writeFile(file, `${lines.join('\n')}\n`);
    // 不落任务节点：授权引用悬空。
    await assert.rejects(
      () => audit.appendCorrection({ 主体: LEAD, 目标: `${month}#2`, 理由: 'r', 授权引用: 'task-不存在-xyz' }),
      (e) => e instanceof Denied && /授权引用/.test(e.message),
    );
    await f.cleanup();
  });
});

describe('裁决第二批 · P2-12 失联冻结覆盖升级裁决通道', () => {
  it('失联期间 Lead 对法律档规则件 publish ⇒ 拒（纪律级升机制级）', async () => {
    const f = await makeFixture({ offline: true });
    const 判 = await f.policy.decide({
      subject: LEAD,
      action: 'publish',
      target: { id: '权限矩阵', kind: '规则', authority: '法律' },
    });
    assert.equal(判.verdict, 'deny', '失联期间升级裁决通道必须冻结');
    assert.match(判.reason, /失联/);
    // 反例面：主权者失联不影响其自己的法律档动作（失联只冻结别人）。
    assert.equal((await f.policy.decide({ subject: { id: 'sovereign', kind: '主权者' }, action: 'write', target: { id: '权限矩阵', kind: '规则', authority: '法律' } })).verdict, 'allow');
    await f.cleanup();
  });
});

describe('裁决第二批 · M1 提审分离', () => {
  it('交卷人复核自己的卷 ⇒ 拒；未交卷者复核 ⇒ 放行', async () => {
    const f = await makeFixture();
    const tasks = new TaskGraph({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
    const node = await tasks.create({ subject: LEAD, 项目: P, 描述: '提审分离', 负责人: 'member-a', 判据: ['x'] });
    await tasks.dispatch(node.id, { subject: LEAD, 项目: P });
    await tasks.start(node.id, { subject: MEMBER, 项目: P });
    await tasks.submit(node.id, { subject: MEMBER, 项目: P, 结论: '交卷' });
    await assert.rejects(
      () => tasks.review(node.id, { subject: MEMBER, 项目: P, 三态: '过' }),
      (e) => e instanceof Denied && /自己的卷/.test(e.message),
      '交卷人（member-a）不得复核自己的卷',
    );
    await assert.rejects(
      () => tasks.review(node.id, { subject: REVIEWER, 项目: P, 三态: '过', 复核者: 'member-a' }),
      (e) => e instanceof Denied && /自己的卷/.test(e.message),
      '借 复核者 字段冒名也不行：判据看独立答案归属',
    );
    // 反例面：未参与交卷的复核者照常。
    const ok = await tasks.review(node.id, { subject: REVIEWER, 项目: P, 三态: '未验' });
    assert.equal(ok.状态, '未验');
    await f.cleanup();
  });
});

describe('裁决第二批 · M6 岗位卡冒名', () => {
  it('文件 x.md 自称 id: Lead ⇒ 扫描响亮拒（fail-closed）', async () => {
    const f = await makeFixture();
    const 冒名卡 = join(f.layout.roleCardDir('自治'), 'fake-role.md');
    await mkdir(dirname(冒名卡), { recursive: true });
    await writeFile(冒名卡, `---\nid: Lead\nkind: 身份\nauthority: 自治\nzone: 私有\ndomain: 个体\nversion: 1\n---\n# 冒名卡\n\n## 个体L0 · 身份\n假装是 Lead。\n`);
    const registry = new RoleRegistry({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
    await assert.rejects(
      () => registry.list(),
      (e) => e instanceof Denied && /不一致/.test(e.message),
      'meta.id 与文件名不一致必须响亮拒，不许索引冒名',
    );
    await f.cleanup();
  });
});

describe('裁决第二批 · P2-13 盲标映射', () => {
  it('映射不跟随数组顺序（至少存在一个顺序不同的名册形态）+ 两入口一致', async () => {
    // 找一个「顺序敏感」的名册形态证明置换真的动了顺序（对大多数名册会命中）。
    let 命中 = false;
    for (let n = 2; n <= 8 && !命中; n++) {
      const 参与者 = Array.from({ length: n }, (_, i) => `m${i}`);
      const map = 盲标分配('t', 参与者);
      if (map.some((e, i) => e.盲标 !== `成员 ${String.fromCharCode(65 + i)}`)) 命中 = true;
    }
    assert.ok(命中, '盲标分配对全部名册都恒等映射 = 没有去顺序化');
    // 同一线程+名册，两次独立调用一致；换线程则（大概率）不同。
    const a = ['member-a', 'member-b', 'member-c'];
    assert.deepEqual(盲标分配('t-1', a), 盲标分配('t-1', a), '确定性：openBlind 与 reveal 各自算同一映射');
    // 名册顺序不影响映射（集合语义）。
    const b = [...a].reverse();
    assert.deepEqual(
      盲标分配('t-1', b).sort((x, y) => x.id.localeCompare(y.id)),
      盲标分配('t-1', a).sort((x, y) => x.id.localeCompare(y.id)),
      '同一集合不同顺序 ⇒ 同一映射',
    );
  });
});

describe('裁决第二批 · P3 escalated 去重', () => {
  it('打回 3 次只落一条 escalated', async () => {
    const f = await makeFixture();
    const tasks = new TaskGraph({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
    const node = await tasks.create({ subject: LEAD, 项目: P, 描述: '反复打回', 负责人: 'member-a', 判据: ['x'] });
    await tasks.dispatch(node.id, { subject: LEAD, 项目: P });
    for (let i = 0; i < 3; i++) {
      await tasks.start(node.id, { subject: MEMBER, 项目: P });
      await tasks.submit(node.id, { subject: MEMBER, 项目: P, 结论: `第 ${i + 1} 次` });
      await tasks.review(node.id, { subject: REVIEWER, 项目: P, 三态: '不过', 分歧清单: ['再来'] });
    }
    const rows = JSON.parse(`[${(await readFile(f.layout.taskLog(P), 'utf8')).trim().split('\n').join(',')}]`);
    assert.equal(rows.filter((r) => r.kind === 'escalated').length, 1, '升级只落一次');
    const final = await tasks.get(node.id, { 项目: P });
    assert.equal(final.打回次数, 3, '打回计数照常累计');
    await f.cleanup();
  });
});

describe('裁决第二批 · 裁决3 快照完整性', () => {
  it('快照被篡改 ⇒ autoRollback 拒绝定位并告警', async () => {
    const f = await makeFixture();
    const probes = new ProbeRunner({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
    const 系统 = { id: 'system', kind: '系统' };
    // 跑两轮：第一轮全绿（回滚目标），第二轮见红（触发 autoRollback）。
    await probes.run({ subject: 系统, 机制版本: 'v-green' });
    // 快照文件名按时间戳排序定「最新」：Clock 秒级精度下两轮要跨秒，保证 red 排在 green 后。
    await new Promise((r) => setTimeout(r, 1100));
    const { readdir } = await import('node:fs/promises');
    const { shortHash } = await import('../src/kernel/ids.js');
    const 见红前文件 = (await readdir(f.layout.probeSnapshotDir())).find((n) => n.includes(shortHash('v-green', 6)));
    // 造一次见红：往拒绝名单写一个不存在的卡 id ⇒「撤回名单一致」探针红（不动审计账本）。
    const identityFile = f.layout.identityFile();
    const identity = JSON.parse(await readFile(identityFile, 'utf8'));
    identity.denylist = [{ id: 'ghost-card-不存在', 理由: '造红' }];
    await writeFile(identityFile, JSON.stringify(identity, null, 2));
    await probes.run({ subject: 系统, 机制版本: 'v-red' });
    // 篡改全绿快照（投毒：把见红改成全绿 + 指向伪造版本）。
    const 全绿文件 = join(f.layout.probeSnapshotDir(), 见红前文件);
    const snap = JSON.parse(await readFile(全绿文件, 'utf8'));
    snap.机制版本 = 'v-fake';
    snap.全绿 = true;
    await writeFile(全绿文件, `${JSON.stringify(snap, null, 2)}\n`);
    const r = await probes.autoRollback();
    assert.equal(r.执行, false);
    assert.equal(r.已定位, undefined, '被篡改的快照不许成为回滚目标');
    assert.match(r.原因, /完整性存疑/);
    await f.cleanup();
  });
});
