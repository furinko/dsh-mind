/**
 * 审计链「更正声明」闭环（缺口2a · 2026-10-12 · task-审计链更正声明机制-缺口2-a--8dt4y）。
 *
 * 背景：真实账本 2026-10#37 单点 hash 不符（写入路径把 `对象.id:null` 的键丢掉后才落盘，
 * hash 却是带 id 算的——实存 1886e2ad…、复算 67df02e7…，prev 骨架完好）。宪章「只增
 * 不可改」禁止改原行 ⇒ 探针恒红且无闭环。主权者裁决采用「追加更正」方案。
 *
 * 本文件钉死的判据：
 *  ① 闸控：缺授权引用 / 缺理由 / 目标形状错 / 目标不存在 / 目标健康 / 目标骨架断裂 ⇒ 全拒
 *     （默认拒绝，只有「真瑕疵 + 授权依据 + 理由」齐备才放行）；
 *  ② 有效声明让 verify 把该点从「链断裂」转「已确认瑕疵」（ok:true、broken 空、
 *     声明行全记 + 告警、载荷含 month#seq / 实存 hash / 复算 hash / 理由 / 授权引用）；
 *  ③ 声明与账本对不上（实存 hash 错）⇒ 仍红（目标点照旧断 + 声明另计「更正声明无效」）；
 *  ④ 篡改更正声明 ⇒ 必红（声明自身是普通链节，改它内容 = 它自己的 hash 对不上）；
 *  ⑤ 探针级：更正前审计链红、更正后绿，其余三道探针不受影响；
 *  ⑥ 只增不破：更正后原行字节不动（目标行的 JSON 原文逐字等于更正前）。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { makeFixture, LEAD } from './helpers.mjs';
import { AuditLog } from '../src/audit.js';
import { ProbeRunner } from '../src/probes.js';
import { Denied, InvalidBody } from '../src/kernel/errors.js';

const 授权 = 'task-审计链更正声明机制-缺口2-a--8dt4y';

/**
 * 造一份「seq2 单点瑕疵」夹具：正常追加 3 行，然后把第 2 行的 依据 改掉但保留原 hash——
 * prev 骨架完好、只有 seq2 自己的 hash 对不上（真实 seq:37 的同形复刻）。
 * @returns {Promise<{ f: object, audit: AuditLog, month: string, 原行原文: string[] }>}
 */
async function 造瑕疵夹具() {
  const f = await makeFixture();
  const audit = new AuditLog({ layout: f.layout, clock: f.clock });
  // 授权引用存在性校验（2026-10-13 裁决第二批 P2-18）：授权必须指向任务图里真实出现过的
  // 节点 id——夹具里先落一个该 id 的事件行，让合法路径过闸。
  const { appendLines } = await import('../src/kernel/fsx.js');
  const { mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  const taskLog = f.layout.taskLog('default');
  await mkdir(dirname(taskLog), { recursive: true }).catch(() => {});
  await appendLines(taskLog, [{ seq: 1, at: new Date().toISOString(), by: { id: 'lead', kind: 'Lead' }, kind: 'created', id: 授权, 描述: '更正声明授权载体', 判据: ['x'] }]);
  await audit.append({ 动作: '状态变更', 主体: LEAD, 对象: 'a', 依据: '第 1 行', 结果: 'ok' });
  await audit.append({ 动作: '状态变更', 主体: LEAD, 对象: 'b', 依据: '第 2 行（将被写坏）', 结果: 'ok' });
  await audit.append({ 动作: '状态变更', 主体: LEAD, 对象: 'c', 依据: '第 3 行', 结果: 'ok' });
  const month = (await audit.months())[0];
  const file = f.layout.auditLog(month);
  const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
  const row2 = JSON.parse(lines[1]);
  row2.依据 = '写后内容变了（hash 还是按旧内容算的）'; // 单点瑕疵：内容动、hash 不动、骨架不动
  lines[1] = JSON.stringify(row2);
  await writeFile(file, `${lines.join('\n')}\n`, 'utf8');
  // ⑥ 的比对基准是**瑕疵行**（造坏后的落盘原文）：更正声明不许动它一个字节。
  return { f, audit, month, 原行原文: [...lines] };
}

describe('审计链更正声明（缺口2a）', () => {
  describe('① 闸控：默认拒绝', () => {
    let f;
    let audit;
    before(async () => {
      f = await makeFixture();
      audit = new AuditLog({ layout: f.layout, clock: f.clock });
      await audit.append({ 动作: '状态变更', 主体: LEAD, 对象: 'x', 依据: '健康行', 结果: 'ok' });
    });
    after(async () => {
      await f.cleanup();
    });

    it('缺授权引用 ⇒ 拒', async () => {
      await assert.rejects(
        () => audit.appendCorrection({ 主体: LEAD, 目标: '2026-10#1', 理由: 'r' }),
        (e) => e instanceof Denied && /授权引用/.test(e.message),
      );
    });
    it('缺理由 ⇒ 拒', async () => {
      await assert.rejects(
        () => audit.appendCorrection({ 主体: LEAD, 目标: '2026-10#1', 授权引用: 授权 }),
        (e) => e instanceof Denied && /理由/.test(e.message),
      );
    });
    it('目标形状错 ⇒ InvalidBody', async () => {
      await assert.rejects(
        () => audit.appendCorrection({ 主体: LEAD, 目标: '37', 理由: 'r', 授权引用: 授权 }),
        (e) => e instanceof InvalidBody && /month#seq/.test(e.message),
      );
    });
    it('目标不存在 ⇒ InvalidBody', async () => {
      await assert.rejects(
        () => audit.appendCorrection({ 主体: LEAD, 目标: '2026-10#999', 理由: 'r', 授权引用: 授权 }),
        (e) => e instanceof InvalidBody && /不存在/.test(e.message),
      );
    });
    it('目标健康 ⇒ 拒（对健康行写声明 = 伪造瑕疵）', async () => {
      const month = (await audit.months())[0];
      await assert.rejects(
        () => audit.appendCorrection({ 主体: LEAD, 目标: `${month}#1`, 理由: 'r', 授权引用: 授权 }),
        (e) => e instanceof Denied && /只认真实瑕疵/.test(e.rule),
      );
    });
  });

  describe('②③④⑥ 闭环语义', () => {
    let f;
    let audit;
    let month;
    let 原行原文;
    before(async () => {
      ({ f, audit, month, 原行原文 } = await 造瑕疵夹具());
    });
    after(async () => {
      await f.cleanup();
    });

    it('更正前：seq2 判「链断裂」，ok=false', async () => {
      const v = await audit.verify();
      assert.equal(v.ok, false);
      assert.equal(v.broken.length, 1, `应只有 seq2 一处断裂，实际 ${JSON.stringify(v.broken)}`);
      assert.equal(v.broken[0].seq, 2);
      assert.equal(v.broken[0].类型, '链断裂');
      assert.equal(v.已确认瑕疵.length, 0);
    });

    it('② 有效声明 ⇒ 转「已确认瑕疵」，声明行全记+告警、载荷齐', async () => {
      await audit.appendCorrection({ 主体: LEAD, 目标: `${month}#2`, 理由: '写入路径丢键缺陷，内容经核对无误', 授权引用: 授权 });
      const v = await audit.verify();
      assert.equal(v.ok, true, `应转绿，实际 broken=${JSON.stringify(v.broken)}`);
      assert.equal(v.broken.length, 0);
      assert.equal(v.已确认瑕疵.length, 1);
      assert.equal(v.已确认瑕疵[0].seq, 2);
      assert.equal(v.已确认瑕疵[0].类型, '已确认瑕疵');
      const rows = await audit.read({});
      const 声明 = rows.find((r) => r.动作 === '更正声明');
      assert.ok(声明, '声明自身必须入链');
      assert.equal(声明.档位, '全记');
      assert.equal(声明.告警, true, '追加动作本身告警');
      assert.equal(声明.详情.目标, `${month}#2`);
      assert.ok(声明.详情.实存hash && 声明.详情.复算hash, '载荷含实存/复算 hash');
      assert.equal(声明.详情.授权引用, 授权);
      assert.equal(声明.详情.理由, '写入路径丢键缺陷，内容经核对无误');
      assert.ok(声明.详情.实存hash !== 声明.详情.复算hash, '声明记的是一处真瑕疵');
    });

    it('⑥ 只增不破：目标行原文逐字未动', async () => {
      const lines = (await readFile(f.layout.auditLog(month), 'utf8')).split('\n').filter(Boolean);
      assert.equal(lines[1], 原行原文[1], '原行字节不许动——更正是追加，不是改写');
      assert.equal(lines.length, 原行原文.length + 1, '只许多一行（声明），不许少');
    });

    it('④ 篡改更正声明 ⇒ 必红', async () => {
      const file = f.layout.auditLog(month);
      const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
      const 声明行 = JSON.parse(lines.at(-1));
      assert.equal(声明行.动作, '更正声明', '前置：尾行是声明');
      声明行.详情.理由 = '篡改：把理由换成别的';
      lines[lines.length - 1] = JSON.stringify(声明行);
      await writeFile(file, `${lines.join('\n')}\n`, 'utf8');
      const v = await audit.verify();
      assert.equal(v.ok, false);
      assert.ok(
        v.broken.some((b) => b.类型 === '链断裂' && b.seq === 声明行.seq),
        `篡改声明 ⇒ 声明自己的链节断裂见红，实际 ${JSON.stringify(v.broken)}`,
      );
    });
  });

  describe('③ 声明与账本对不上 ⇒ 仍红', () => {
    let f;
    let audit;
    let month;
    before(async () => {
      ({ f, audit, month } = await 造瑕疵夹具());
    });
    after(async () => {
      await f.cleanup();
    });

    it('实存 hash 写错的声明：目标点照旧断 + 声明另计无效', async () => {
      // 绕过 appendCorrection 的闸（攻击面就在这：手写一条内容错配的声明行）。
      await audit.append({
        动作: '更正声明',
        主体: LEAD,
        对象: { id: `${month}#2`, kind: '审计' },
        依据: '伪造授权',
        结果: '已确认瑕疵（谎报）',
        告警: true,
        详情: { 目标: `${month}#2`, 实存hash: 'deadbeef', 复算hash: 'cafebabe', 理由: '编的理由', 授权引用: '伪造' },
      });
      const v = await audit.verify();
      assert.equal(v.ok, false);
      assert.ok(v.broken.some((b) => b.类型 === '链断裂' && b.seq === 2), '目标点照旧断，声明洗不白');
      assert.ok(v.broken.some((b) => b.类型 === '更正声明无效'), `错配声明必须另计红，实际 ${JSON.stringify(v.broken)}`);
    });
  });

  describe('⑤ 探针级：更正前红、更正后绿，其余三道不受影响', () => {
    let f;
    let audit;
    let month;
    let probes;
    before(async () => {
      ({ f, audit, month } = await 造瑕疵夹具());
      probes = new ProbeRunner({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock, 无内核装配: true });
    });
    after(async () => {
      await f.cleanup();
    });

    it('更正前审计链红、其余三道绿；更正后四盏全绿', async () => {
      const 前 = await probes.run({ subject: LEAD, 机制版本: 'corr-1' });
      assert.ok(前.见红.some((r) => r.探针 === '审计链'), '更正前审计链必须红');
      assert.equal(前.见红.length, 1, `其余三道不许被波及，实际见红 ${JSON.stringify(前.见红)}`);

      await f.audit.appendCorrection({ 主体: LEAD, 目标: `${month}#2`, 理由: '写入路径丢键缺陷，内容经核对无误', 授权引用: 授权 });
      const 后 = await probes.run({ subject: LEAD, 机制版本: 'corr-2' });
      assert.equal(后.全绿, true, `更正后应四盏全绿，实际见红 ${JSON.stringify(后.见红)}`);
      const 链 = 后.结果.find((r) => r.探针 === '审计链');
      assert.match(链.详情, /已确认瑕疵 1 处/, '探针读数要报出已确认瑕疵（透明，不装没事）');
    });
  });
});
