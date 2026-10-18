/**
 * 审计检查点加固（task-审计检查点加固-第13代复核加强-l9lgg · 2026-10-16）。
 * 依据：iahma 结账记录里第13代复核员的 4 条反例面（加强面）。
 *
 * 四件：
 *  ① 检查点：清单记每月末 {seq,hash}——append 时检查点超前于本行 seq ⇒ 拒写（删月复活口
 *     在写入面关闭）；verify 时实际尾回卷/同 seq hash 不符 ⇒ 红「检查点回卷」（直写旁路兜住）；
 *     正常写窗（检查点=尾）不误报。
 *  ② 清单自保护：清单缺失（盘上有分片/锚）⇒ 红「清单缺失」；坏 JSON ⇒ 红「清单损坏」；
 *     无分片无清单 ⇒ 绿。
 *  ③ R15 归零断面：锚在而日志无行 ⇒ append 响亮拒；verify 侧仍由「尾部截断」红（回归钉住）。
 *  ④ R16 detail：失败阶段（指针|审计）与 指针已写 可判——两断面在 Fault 里可区分。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile, mkdir } from 'node:fs/promises';
import { makeFixture, LEAD } from './helpers.mjs';
import { Org } from '../src/org.js';
import { AuditLog } from '../src/audit.js';
import { Fault } from '../src/kernel/errors.js';
import { chainHash } from '../src/kernel/text.js';

const P = 'proj-cpk';
const SOVEREIGN = { id: 'sovereign', kind: '主权者' };

/** 桩钟：可切月（审计按月分片）。 */
function 桩钟() {
  const 态 = { 月: '2026-08' };
  return {
    态,
    clock: { iso: () => `${态.月}-15T00:00:00Z`, ms: () => Date.parse(`${态.月}-15T00:00:00Z`) },
  };
}

describe('① 检查点（删月复活口）', () => {
  it('T1a：已登记月被删后 append ⇒ InvalidBody 拒写（检查点超前于本行）', async () => {
    const f = await makeFixture();
    try {
      const { 态, clock } = 桩钟();
      const audit = new AuditLog({ layout: f.layout, clock });
      态.月 = '2026-03';
      for (let i = 0; i < 3; i += 1) await audit.append({ 动作: '状态变更', 主体: LEAD, 对象: { id: `x${i}` } });
      assert.equal((await audit.verify()).ok, true, '前提：绿');
      // 删月（账本+锚成对）——清单与检查点仍在。
      await rm(f.layout.auditLog('2026-03'));
      await rm(f.layout.auditAnchor('2026-03'));
      // 生产形态（第13代反例1）：修前任何一次正常记账都会复活该月（seq 从 1 重来、告警消失）。
      const audit2 = new AuditLog({ layout: f.layout, clock });
      await assert.rejects(
        () => audit2.append({ 动作: '状态变更', 主体: LEAD, 对象: { id: 'revive' } }),
        (e) => /检查点.*超前|疑似被删除后重建/.test(e.message),
        '检查点(seq=3) ≥ 本行 seq(1) ⇒ 拒写',
      );
    } finally {
      await f.cleanup();
    }
  });

  it('T1b：直写文件旁路（手写 seq=1 重建分片）⇒ verify 红「检查点回卷」', async () => {
    const f = await makeFixture();
    try {
      const { 态, clock } = 桩钟();
      const audit = new AuditLog({ layout: f.layout, clock });
      态.月 = '2026-03';
      for (let i = 0; i < 2; i += 1) await audit.append({ 动作: '状态变更', 主体: LEAD, 对象: { id: `x${i}` } });
      await rm(f.layout.auditLog('2026-03'));
      await rm(f.layout.auditAnchor('2026-03'));
      // 绕过 append 直写一条自链的 seq=1 行 + 匹配锚（旁路复刻「复活后的月」）。
      const row = { seq: 1, 时间: '2026-03-15T00:00:00Z', 主体: 'lead', 动作: '状态变更', 对象: { id: null }, 依据: '', 结果: '记', 档位: '全记', 项目: null, 轮: null, 告警: false, 详情: {}, prev: null };
      row.hash = chainHash(null, { ...JSON.parse(JSON.stringify(row)), hash: undefined });
      await writeFile(f.layout.auditLog('2026-03'), `${JSON.stringify(row)}\n`, 'utf8');
      await writeFile(f.layout.auditAnchor('2026-03'), `${JSON.stringify({ seq: 1, hash: row.hash, at: row.时间 })}\n`, 'utf8');
      const v = await audit.verify();
      assert.equal(v.ok, false, '回卷必须见红');
      assert.ok(v.broken.some((b) => b.类型 === '检查点回卷' && b.month === '2026-03'), `要点名检查点回卷：${JSON.stringify(v.broken)}`);
    } finally {
      await f.cleanup();
    }
  });

  it('T1c：正常写窗（连续 append，检查点=尾）⇒ verify 恒绿、不误报', async () => {
    const f = await makeFixture();
    try {
      const { 态, clock } = 桩钟();
      const audit = new AuditLog({ layout: f.layout, clock });
      态.月 = '2026-08';
      for (let i = 0; i < 5; i += 1) {
        await audit.append({ 动作: '状态变更', 主体: LEAD, 对象: { id: `n${i}` } });
        const v = await audit.verify();
        assert.equal(v.ok, true, `第 ${i + 1} 次写入后不应误报：${JSON.stringify(v.broken)}`);
      }
      // 跨月：检查点按月各记各的。
      态.月 = '2026-10';
      await audit.append({ 动作: '状态变更', 主体: LEAD, 对象: { id: '跨月' } });
      assert.equal((await audit.verify()).ok, true, '跨月正常写入不误报');
    } finally {
      await f.cleanup();
    }
  });
});

describe('② 清单自保护', () => {
  it('T2a：只删清单（盘上有分片）⇒ 红「清单缺失」；T2c 全新部署（无分片无清单）⇒ 绿', async () => {
    const f = await makeFixture();
    try {
      const { clock } = 桩钟();
      const audit = new AuditLog({ layout: f.layout, clock });
      await audit.append({ 动作: '状态变更', 主体: LEAD, 对象: { id: 'x' } });
      await rm(f.layout.auditMonthManifest());
      const v = await audit.verify();
      assert.equal(v.ok, false, '清单缺失必须见红（修前 ok=true）');
      assert.ok(v.broken.some((b) => b.类型 === '清单缺失'), `要点名清单缺失：${JSON.stringify(v.broken)}`);
      // 全新部署形态：把分片与锚也全删（无任何审计痕迹）⇒ 绿，不误报。
      for (const m of [...await audit.months()]) {
        await rm(f.layout.auditLog(m));
        await rm(f.layout.auditAnchor(m), { force: true });
      }
      const fresh = await audit.verify();
      assert.equal(fresh.ok, true, `无分片无清单 ⇒ 绿：${JSON.stringify(fresh.broken)}`);
    } finally {
      await f.cleanup();
    }
  });

  it('T2b：清单坏 JSON ⇒ 红「清单损坏」；且写入面 fail-closed（拒写、不洗红）', async () => {
    const f = await makeFixture();
    try {
      const { clock } = 桩钟();
      const audit = new AuditLog({ layout: f.layout, clock });
      await audit.append({ 动作: '状态变更', 主体: LEAD, 对象: { id: 'x' } });
      await writeFile(f.layout.auditMonthManifest(), '{"months": ', 'utf8');
      const v = await audit.verify();
      assert.equal(v.ok, false, '清单损坏必须见红');
      assert.ok(v.broken.some((b) => b.类型 === '清单损坏'), `要点名清单损坏：${JSON.stringify(v.broken)}`);
      // 第14代分歧2：写入面 fail-closed——append 拒写且清单**不被洗掉**（修前坏 JSON 硬拒、
      // 坏形状被静默重建洗红——两种坏态不对称）。拒后 verify 仍红。
      await assert.rejects(
        () => audit.append({ 动作: '状态变更', 主体: LEAD, 对象: { id: 'y' } }),
        (e) => /清单损坏|写入面 fail-closed/.test(e.message),
        '坏 JSON ⇒ append 拒写（不静默重建）',
      );
      const v2 = await audit.verify();
      assert.ok(v2.broken.some((b) => b.类型 === '清单损坏'), '拒写不洗红：清单损坏仍在');
    } finally {
      await f.cleanup();
    }
  });

  it('T2d：清单形状不合规（合法 JSON 缺 months）⇒ verify 红＋append 拒写不洗红（与坏 JSON 同口径）', async () => {
    const f = await makeFixture();
    try {
      const { clock } = 桩钟();
      const audit = new AuditLog({ layout: f.layout, clock });
      await audit.append({ 动作: '状态变更', 主体: LEAD, 对象: { id: 'x' } });
      // 形状不合规：合法 JSON 但没有 months 数组（修前 append 会整文件覆盖清单、洗掉红）。
      await writeFile(f.layout.auditMonthManifest(), '{"foo": 1}', 'utf8');
      const v = await audit.verify();
      assert.equal(v.ok, false);
      assert.ok(v.broken.some((b) => b.类型 === '清单损坏'), `要点名清单损坏（形状）：${JSON.stringify(v.broken)}`);
      await assert.rejects(
        () => audit.append({ 动作: '状态变更', 主体: LEAD, 对象: { id: 'y' } }),
        (e) => /清单损坏|形状不合规|写入面 fail-closed/.test(e.message),
        '坏形状 ⇒ append 拒写（修前被静默重建洗红）',
      );
      const 原文 = await import('node:fs').then((m) => m.readFileSync(f.layout.auditMonthManifest(), 'utf8'));
      assert.ok(原文.includes('"foo"'), '清单未被覆盖重建（洗红面关闭）');
    } finally {
      await f.cleanup();
    }
  });
});

describe('③ R15 归零断面', () => {
  it('锚在而日志清空 ⇒ append 响亮拒；verify 仍红（尾部截断回归钉住）', async () => {
    const f = await makeFixture();
    try {
      const { 态, clock } = 桩钟();
      const audit = new AuditLog({ layout: f.layout, clock });
      态.月 = '2026-08';
      await audit.append({ 动作: '状态变更', 主体: LEAD, 对象: { id: 'a' } });
      await audit.append({ 动作: '状态变更', 主体: LEAD, 对象: { id: 'b' } });
      // 归零：清空日志内容（锚保留）。
      await writeFile(f.layout.auditLog('2026-08'), '', 'utf8');
      const v = await audit.verify();
      assert.equal(v.ok, false, 'verify 侧该形状必须红');
      assert.ok(v.broken.some((b) => b.类型 === '尾部截断' || b.类型 === '撕裂行'), `修前由尾部截断兜住，不回退：${JSON.stringify(v.broken)}`);
      // append 侧：新实例续写必须响亮拒（修前静默按锚续写）。
      const audit2 = new AuditLog({ layout: f.layout, clock });
      await assert.rejects(
        () => audit2.append({ 动作: '状态变更', 主体: LEAD, 对象: { id: 'c' } }),
        (e) => /锚.*在案而账本无行|日志疑似被删|清零/.test(e.message),
        '归零断面不许静默续写',
      );
    } finally {
      await f.cleanup();
    }
  });
});

describe('④ R16 detail 可查明性', () => {
  it('审计失败断面 ⇒ 失败阶段=审计、指针已写=true；指针失败断面 ⇒ 失败阶段=指针、指针已写=false', async () => {
    const f = await makeFixture();
    try {
      const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
      // 断面一：指针路径被目录占位 ⇒ #recordPointer 失败。
      await mkdir(f.layout.historyIndex(), { recursive: true });
      await assert.rejects(
        () => org.store.write('能力', { meta: { id: 'cap-p', 名: 'P卡', authority: '自治', domain: '集体' }, body: '\n# P卡\n\n## 适用岗位\n- 插件工程\n\n## 怎么做\nx\n' }, { subject: LEAD, reason: '指针断面' }),
        (e) => e instanceof Fault && e.code === 'STORE_PARTIAL_COMMIT' && e.detail?.失败阶段 === '指针' && e.detail?.指针已写 === false && /指针/.test(e.message),
        '指针断面：失败阶段=指针、指针已写=false',
      );
      await rm(f.layout.historyIndex(), { recursive: true, force: true });
      // 断面二：指针可写、审计注入失败。
      const 原append = org.audit.append.bind(org.audit);
      org.audit.append = async () => { throw new Error('注入：审计不可用'); };
      await assert.rejects(
        () => org.store.write('能力', { meta: { id: 'cap-a', 名: 'A卡', authority: '自治', domain: '集体' }, body: '\n# A卡\n\n## 适用岗位\n- 插件工程\n\n## 怎么做\nx\n' }, { subject: LEAD, reason: '审计断面' }),
        (e) => e instanceof Fault && e.code === 'STORE_PARTIAL_COMMIT' && e.detail?.失败阶段 === '审计' && e.detail?.指针已写 === true,
        '审计断面：失败阶段=审计、指针已写=true',
      );
      org.audit.append = 原append;
    } finally {
      await f.cleanup();
    }
  });
});

describe('⑤ 第14代打回修正（旧部署播种 / 写入面口径 / 等号边界）', () => {
  it('T5：旧部署（分片在、清单缺）首写 ⇒ 兜底登记现存月∪锚月并播种检查点；删旧月 ⇒ verify 红「分片缺失」', async () => {
    const f = await makeFixture();
    try {
      const { 态, clock } = 桩钟();
      const audit = new AuditLog({ layout: f.layout, clock });
      // 造旧月（2026-08 三行＋锚），随后删掉清单 ⇒ 旧部署形态（分片在、清单缺）。
      态.月 = '2026-08';
      for (let i = 0; i < 3; i += 1) await audit.append({ 动作: '状态变更', 主体: LEAD, 对象: { id: `old${i}` } });
      await rm(f.layout.auditMonthManifest());
      // 首写当前月（2026-10）——修前（第14代分歧1）：兜底分支不可达，旧月不登记不播种。
      态.月 = '2026-10';
      await audit.append({ 动作: '状态变更', 主体: LEAD, 对象: { id: 'now' } });
      const 清单 = JSON.parse(await import('node:fs').then((m) => m.readFileSync(f.layout.auditMonthManifest(), 'utf8')));
      assert.ok(清单.months.includes('2026-08'), `兜底必须登记旧月：${JSON.stringify(清单.months)}`);
      assert.ok(清单.checkpoints['2026-08']?.seq === 3, `旧月播种检查点 seq=3：${JSON.stringify(清单.checkpoints)}`);
      // 删旧月（分片+锚成对）⇒ 分片缺失红（修前 P1 实证：verify ok=true 零红——R14 回退）。
      await rm(f.layout.auditLog('2026-08'));
      await rm(f.layout.auditAnchor('2026-08'));
      const v = await audit.verify();
      assert.equal(v.ok, false, '旧月被删必须见红（修前旧月无登记 ⇒ 静默）');
      assert.ok(v.broken.some((b) => b.类型 === '分片缺失' && b.month === '2026-08'), `要点名旧月分片缺失：${JSON.stringify(v.broken)}`);
    } finally {
      await f.cleanup();
    }
  });

  it('T7：等号边界回归钉——检查点 seq 恰等于本行 seq ⇒ 拒（≥ 而非 >）', async () => {
    const f = await makeFixture();
    try {
      const { 态, clock } = 桩钟();
      const audit = new AuditLog({ layout: f.layout, clock });
      态.月 = '2026-09';
      for (let i = 0; i < 2; i += 1) await audit.append({ 动作: '状态变更', 主体: LEAD, 对象: { id: `x${i}` } });
      // 手工把检查点写成 seq=3（= 本行将写的 seq）：若守卫用 > 会漏过（第14代 cpA2）。
      const 清单 = JSON.parse(await import('node:fs').then((m) => m.readFileSync(f.layout.auditMonthManifest(), 'utf8')));
      清单.checkpoints['2026-09'] = { seq: 3, hash: 'deadbeef' };
      await writeFile(f.layout.auditMonthManifest(), `${JSON.stringify(清单, null, 2)}\n`, 'utf8');
      await assert.rejects(
        () => audit.append({ 动作: '状态变更', 主体: LEAD, 对象: { id: 'eq' } }),
        (e) => /超前/.test(e.message),
        '检查点 seq=3 ≥ 本行 seq=3 ⇒ 拒（等号边界）',
      );
    } finally {
      await f.cleanup();
    }
  });
});
