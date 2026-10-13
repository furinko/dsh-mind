/**
 * 2026-10-13 审查批次2-4 回归：
 *  - P1-10 路由同源防线对非浏览器客户端（无 sec-fetch-site）fail-closed；
 *  - P1-11 remember 内部通道（派生自/同锁追加）不接受外部传入；
 *  - P1-14 披露正则的灾难性回溯在加载期被拒 + 匹配面长度上限；
 *  - P1-7 审计撕裂行可见（坏行/末行无换行 ⇒ broken）、整月删除 ⇒ 月份缺口见红；
 *  - P2-19 auditLog(month) 过路径段校验（`..` 拒）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { makeFixture, LEAD, MEMBER } from './helpers.mjs';
import { AuditLog } from '../src/audit.js';
import { Clock } from '../src/kernel/time.js';
import { Layout } from '../src/paths.js';
import { MemoryService } from '../src/memory.js';
import { presence路由, workbench路由 } from '../components/kernel/lib/routes.js';

describe('批次2 · P1-10 路由防线只认浏览器', () => {
  /** 极简 req/res 夹具：按给定的头与方法造请求。 */
  const 请求 = (方法名, headers = {}) => {
    const req = { method: 方法名, headers, url: '/', [Symbol.asyncIterator]: async function* () {} };
    const 状态 = { 码: null, 体: null };
    const res = {
      writeHead(code) { 状态.码 = code; },
      end(body) { 状态.体 = String(body ?? ''); },
    };
    return { req, res, 状态 };
  };

  it('非浏览器写（无 sec-fetch-site，哪怕带 json 头）⇒ 403 拒', async () => {
    const org = { policy: { presence: () => ({}) } };
    const 路由 = presence路由({ org, 项目: 'p' });
    const { req, res, 状态 } = 请求('POST', { 'content-type': 'application/json', host: '127.0.0.1:1' });
    await 路由(req, res);
    assert.equal(状态.码, 403, 'curl/本机进程不带 Fetch Metadata 头必须被拒');
  });

  it('非浏览器读（workbench GET 无 sec-fetch-site）⇒ 403 拒，拿不到全量投影', async () => {
    const org = { workbench: async () => { throw new Error('不许走到投影这一步'); } };
    const 路由 = workbench路由({ org, 项目: 'p' });
    const { req, res, 状态 } = 请求('GET', { host: '127.0.0.1:1' });
    await 路由(req, res);
    assert.equal(状态.码, 403, '无 Fetch Metadata 的读 = 非浏览器客户端，fail-closed');
  });

  it('浏览器同源读（sec-fetch-site: same-origin）⇒ 照常放行（正对照不误伤）', async () => {
    let 到过投影 = false;
    const org = { workbench: async () => { 到过投影 = true; return { 项目: 'p' }; } };
    const 路由 = workbench路由({ org, 项目: 'p' });
    const { req, res, 状态 } = 请求('GET', { host: '127.0.0.1:1', 'sec-fetch-site': 'same-origin' });
    await 路由(req, res);
    assert.equal(状态.码, 200);
    assert.equal(到过投影, true, '真浏览器请求不受影响');
  });
});

describe('批次3 · P1-11 remember 内部通道封口', () => {
  it('外部传 派生自 ⇒ 响亮拒（血缘事实不是自报项）', async () => {
    const f = await makeFixture();
    const memory = new MemoryService({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
    await assert.rejects(
      () => memory.remember({ subject: LEAD, 类: '偏好', 内容: '伪造血缘', 来源: '测试', 派生自: 'pref-xxx' }),
      (e) => e.name === 'InvalidBody' && /内部通道/.test(e.message),
    );
    await assert.rejects(
      () => memory.remember({ subject: LEAD, 类: '偏好', 内容: '伪造伴随行', 来源: '测试', 同锁追加: () => [] }),
      (e) => e.name === 'InvalidBody' && /内部通道/.test(e.message),
    );
    await f.cleanup();
  });

  it('overturn 的合法内部路径照常工作（派生自仍由 overturn 自动写）', async () => {
    const f = await makeFixture();
    const memory = new MemoryService({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
    const base = await memory.remember({ subject: LEAD, 类: '偏好', 内容: '旧偏好', 来源: '测试' });
    const r = await memory.overturn(base.id, { subject: LEAD, 新条目: '新偏好', 理由: '审查回归' });
    const 新 = await memory.query({ subject: LEAD, 类: ['偏好'], 含失效: true });
    assert.ok(新.条目.some((e) => e.id === r.新条目 && e.派生自 === base.id), '派生自=被推翻者 id，由 overturn 自动写');
    await f.cleanup();
  });
});

describe('批次3 · P1-14 披露正则回溯安全', () => {
  it('部署.json 带 `(a+)+$` 类灾难性回溯正则 ⇒ 加载期被拒（引擎不健康）', async () => {
    const g = await makeFixture({
      privateFiles: { '集体L2-共享基础设施/defaults/部署.json': JSON.stringify({ 披露敏感模式: [{ 名: '坏正则', 正则: '(a+)+$' }] }) },
    });
    assert.equal(g.policy.healthy, false, '灾难性回溯正则必须让引擎不健康');
    await g.cleanup();
  });

  it('合法正则照常加载（正对照）', async () => {
    const g = await makeFixture({
      privateFiles: { '集体L2-共享基础设施/defaults/部署.json': JSON.stringify({ 披露敏感模式: [{ 名: '密钥', 正则: 'sk-[A-Za-z0-9]{16,}' }] }) },
    });
    assert.equal(g.policy.healthy, true);
    await g.cleanup();
  });
});

describe('批次4 · P1-7 审计完整性读数', () => {
  it('撕裂行（半行 JSON）⇒ verify 见红（类型=撕裂行），不再静默跳过', async () => {
    const f = await makeFixture();
    const audit = new AuditLog({ layout: f.layout, clock: new Clock() });
    await audit.append({ 动作: '状态变更', 主体: LEAD, 对象: { id: 'x' } });
    // 模拟崩溃撕裂：在账本尾部补半行（无换行、非 JSON）。
    const file = f.layout.auditLog((await audit.months())[0]);
    await writeFile(file, `${await readFile(file, 'utf8')}{"seq": 99, "时间": "20`);
    const v = await audit.verify();
    assert.equal(v.ok, false);
    assert.ok(v.broken.some((b) => b.类型 === '撕裂行'), `要有撕裂行项：${JSON.stringify(v.broken)}`);
    await f.cleanup();
  });

  it('整月成对删除（中间月）⇒ 月份缺口见红', async () => {
    const f = await makeFixture();
    const audit = new AuditLog({ layout: f.layout, clock: new Clock() });
    // 造三个月账：直接手写最简合法分片（单行自链 + 匹配的锚）。
    const { chainHash } = await import('../src/kernel/text.js');
    for (const m of ['2026-08', '2026-09', '2026-10']) {
      const row = { seq: 1, 时间: `${m}-01T00:00:00Z`, 主体: 'lead', 动作: '状态变更', 对象: { id: null }, 依据: '', 结果: '记', 档位: '全记', 项目: null, 轮: null, 告警: false, 详情: {}, prev: null };
      // 与 audit.append 同款归一（P2-1）：先 JSON 往返丢键，再**补回 hash: undefined**——
      // canonical 把 undefined 算成 null，键必须在场（直接丢键会全盘见红，注释在 audit.append）。
      row.hash = chainHash(null, { ...JSON.parse(JSON.stringify(row)), hash: undefined });
      const file = f.layout.auditLog(m);
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, `${JSON.stringify(row)}\n`);
      const anchor = f.layout.auditAnchor(m);
      await writeFile(anchor, JSON.stringify({ seq: 1, hash: row.hash, at: row.时间 }));
    }
    const 好 = await audit.verify();
    assert.equal(好.ok, true, `前提：连续三月全绿（实际 ${JSON.stringify(好.broken)}）`);
    // 删中间月（账本+锚成对）。
    await rm(f.layout.auditLog('2026-09'));
    await rm(f.layout.auditAnchor('2026-09'));
    const 坏 = await audit.verify();
    assert.equal(坏.ok, false, '整月删除必须见红');
    assert.ok(坏.broken.some((b) => b.类型 === '月份缺口'), `要有月份缺口项：${JSON.stringify(坏.broken)}`);
    await f.cleanup();
  });

  it('P2-19：auditLog(month) 对 `..` 拒（路径段校验）', async () => {
    const f = await makeFixture();
    assert.throws(() => f.layout.auditLog('../../x'), /路径片段|不合法/, '月份是路径段，必须过校验');
    await f.cleanup();
  });
});

describe('批次2 · P1-6 任务状态机锁内复检（语义抽样）', () => {
  it('terminal 节点的 start 在锁内同样被拒（外层判过之后状态已变也拦得住）', async () => {
    const f = await makeFixture();
    const { TaskGraph } = await import('../src/tasks.js');
    const tasks = new TaskGraph({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
    const P = 'p16';
    const node = await tasks.create({ subject: LEAD, 项目: P, 描述: '锁内复检', 负责人: 'member-a', 判据: ['x'] });
    await tasks.dispatch(node.id, { subject: LEAD, 项目: P });
    await tasks.start(node.id, { subject: MEMBER, 项目: P });
    await tasks.submit(node.id, { subject: MEMBER, 项目: P });
    await tasks.review(node.id, { subject: { id: 'reviewer', kind: '复核者' }, 项目: P, 三态: '过' });
    const 已采纳 = await tasks.get(node.id, { 项目: P });
    assert.equal(已采纳.状态, '已采纳');
    await assert.rejects(
      () => tasks.submit(node.id, { subject: MEMBER, 项目: P, 结论: '洗回已交卷' }),
      (e) => e.name === 'Denied' && /状态机|已采纳/.test(e.message),
      '已采纳节点不许被 submit 洗回已交卷（锁内复检）',
    );
    await f.cleanup();
  });
});
