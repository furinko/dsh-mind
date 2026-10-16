/**
 * 2026-10-13 审查批次2-4 回归：
 *  - P1-10 路由同源防线对非浏览器客户端（无 sec-fetch-site）fail-closed；
 *  - P1-11 remember 内部通道（派生自/同锁追加）不接受外部传入；
 *  - P1-14 披露正则的灾难性回溯在加载期被拒 + 匹配面长度上限；
 *  - P1-7 审计撕裂行可见（坏行/末行无换行 ⇒ broken）、整月删除已登记月 ⇒ 分片缺失见红；
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

describe('批次2 · 路由防线（P1-10 于 2026-10-13 晚改形：认形状 + 计可见，见下）', () => {
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

  // ⚠️ **口径改形（2026-10-13 晚）**——这两条原来是「无 sec-fetch-site ⇒ 403（fail-closed）」。
  //    真机取证推翻了它的前提：**官方客户端里插件页发出的请求压根不带 Fetch Metadata 头**
  //    （指纹实测：sec-fetch-site / origin / referer 全无，只剩 host），那一类不是"本机可疑进程"，
  //    而是**宿主替页面发的合法通道** ⇒ fail-closed 把面板与设置页整类打死（看板每 3 秒轮询全 403）。
  //    新口径（`读栅栏` / `写栅栏`）：**先看有没有"明说跨站"，再看是不是本机**——
  //      ① 明说 cross-site / same-site ⇒ 拒；② 非回环 Host / Origin ⇒ 拒；
  //      ③ 缺声明 + 本机回环 ⇒ **放行并计数**（进 ping 的 `本机通道`，不再无声）。
  //    残余风险如实写在 `允许无头本机读` 的注释里（本机进程本来也能直接读盘）；要收紧改一个常量。
  it('本机无头写（无 sec-fetch-site 但回环 + json）⇒ 放行（P1-10 改形）', async () => {
    const org = { policy: { presence: () => ({}) } };
    const 路由 = presence路由({ org, 项目: 'p' });
    const { req, res, 状态 } = 请求('POST', { 'content-type': 'application/json', host: '127.0.0.1:1' });
    await 路由(req, res);
    assert.notEqual(状态.码, 403, '本机回环的无头请求是宿主通道的常态，不再整类拒');
  });

  it('本机无头读（workbench GET 无 sec-fetch-site、回环）⇒ 放行（P1-10 改形）', async () => {
    let 到过投影 = false;
    const org = { workbench: async () => { 到过投影 = true; return { 项目: 'p' }; } };
    const 路由 = workbench路由({ org, 项目: 'p' });
    const { req, res, 状态 } = 请求('GET', { host: '127.0.0.1:1' });
    await 路由(req, res);
    assert.equal(状态.码, 200, '缺声明 + 本机回环 ⇒ 放行（官方客户端插件通道就是这形状）');
    assert.equal(到过投影, true);
  });

  it('负向判据不松：明说跨站 / 非回环 Host ⇒ 一律拒', async () => {
    const org = { workbench: async () => { throw new Error('不许走到投影这一步'); } };
    const 路由 = workbench路由({ org, 项目: 'p' });
    const 跨站 = 请求('GET', { host: '127.0.0.1:1', 'sec-fetch-site': 'cross-site' });
    await 路由(跨站.req, 跨站.res);
    assert.equal(跨站.状态.码, 403, '浏览器明说跨站 ⇒ 拒');
    const 外机 = 请求('GET', { host: 'evil.example:80' });
    await 路由(外机.req, 外机.res);
    assert.equal(外机.状态.码, 403, '非回环 Host ⇒ 拒（这个端点只服务本机）');
    const 异源 = 请求('GET', { host: '127.0.0.1:1', origin: 'http://evil.example' });
    await 路由(异源.req, 异源.res);
    assert.equal(异源.状态.码, 403, 'Origin 不是回环来源 ⇒ 拒');
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

  // ── 真机取证：拒绝要带**传输层指纹**（2026-10-13 主权者真机报「跨站读取被拒」，
  //    而带同源头的探针打得通 ⇒ 光有「被拒」两个字定位不了真因）────────────────────
  it('无头本机读 ⇒ 放行，且 ping 把它记成「本机通道」（不无声）', async () => {
    const org = { workbench: async () => ({ 项目: 'p' }) };
    const 路由 = workbench路由({ org, 项目: 'p' });
    const { req, res, 状态 } = 请求('GET', { host: '127.0.0.1:19387' });
    await 路由(req, res);
    assert.equal(状态.码, 200, '缺声明 + 回环 ⇒ 放行');
    const { ping路由 } = await import('../components/kernel/lib/routes.js');
    const ping = ping路由({ org, ctx: null });
    const 好 = 请求('GET', { host: '127.0.0.1:19387', 'sec-fetch-site': 'same-origin' });
    await ping(好.req, 好.res);
    const 包 = JSON.parse(好.状态.体);
    assert.ok(包.本机通道, `ping 要报本机通道计数：${好.状态.体}`);
    assert.ok(包.本机通道.读 >= 1, '无头读要被计数');
    assert.match(String(包.本机通道.最近指纹.host), /127\.0\.0\.1/, '计数里带最近一次的无头指纹');
  });

  it('拒绝理由带指纹：非回环 Host 被拒时能看出「host 不是回环」', async () => {
    const org = { workbench: async () => ({ 项目: 'p' }) };
    const 路由 = workbench路由({ org, 项目: 'p' });
    const { req, res, 状态 } = 请求('GET', { host: 'evil.example:80' });
    await 路由(req, res);
    assert.equal(状态.码, 403);
    assert.match(状态.体, /Host 不是回环地址/, `拒绝理由要给出可执行的为什么：${状态.体}`);
    assert.match(状态.体, /host=evil\.example:80/, '要写明收到的 host');
    assert.match(状态.体, /sec-fetch-site=（无）/, '要写明收到的 Fetch Metadata 状态');
  });

  it('拒绝理由带指纹：跨站读能看出 origin 与 host 不是同一个源', async () => {
    const org = { workbench: async () => ({ 项目: 'p' }) };
    const 路由 = workbench路由({ org, 项目: 'p' });
    const { req, res, 状态 } = 请求('GET', {
      host: '127.0.0.1:19387',
      'sec-fetch-site': 'cross-site',
      origin: 'http://localhost:5173',
      referer: 'http://localhost:5173/panel',
    });
    await 路由(req, res);
    assert.equal(状态.码, 403);
    assert.match(状态.体, /sec-fetch-site=cross-site/);
    assert.match(状态.体, /origin=http:\/\/localhost:5173/);
    assert.match(状态.体, /referer=http:\/\/localhost:5173\/panel/);
  });

  // 真机读数（2026-10-13 17:25）：官方客户端里**插件页自己的请求**也不带 Fetch Metadata 头
  // （sec-fetch-site / origin / referer 全无）⇒ 与「本机任意进程」在传输层同形 ⇒ 被 P1-10 整类拒。
  // 于是还差一件事没验：**插件自带的自定义头能不能穿过那条通道**——
  // 能穿过，才谈得上把栅栏从「认来源」改成「认凭据」。
  it('指纹记下插件标记头：x-dsh-mind-panel 到位与否读得出', async () => {
    const org = { workbench: async () => ({ 项目: 'p' }) };
    const 路由 = workbench路由({ org, 项目: 'p' });
    // 用**被拒的形状**（明说跨站）来读指纹：放行路径不回理由体，指纹只在拒绝理由与 ping 上。
    const 无标记 = 请求('GET', { host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' });
    await 路由(无标记.req, 无标记.res);
    assert.match(无标记.状态.体, /插件标记=（无）/, '没带标记头要如实写「无」');
    const 有标记 = 请求('GET', { host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site', 'x-dsh-mind-panel': '1' });
    await 路由(有标记.req, 有标记.res);
    assert.match(有标记.状态.体, /插件标记=1/, `自定义头到位时要读得出：${有标记.状态.体}`);
  });

  it('ping 端点回报「最近一次同源拒绝」——诊断不必靠截图传话', async () => {
    const org = { workbench: async () => ({ 项目: 'p' }) };
    const 工作台 = workbench路由({ org, 项目: 'p' });
    // ① 先制造一次跨站拒绝（模拟面板那边的请求）
    const 坏 = 请求('GET', { host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site', origin: 'http://localhost:5173' });
    await 工作台(坏.req, 坏.res);
    assert.equal(坏.状态.码, 403);
    // ② 再打一次**同源** ping：应当能读到上一条被拒的指纹
    const { ping路由 } = await import('../components/kernel/lib/routes.js');
    const ping = ping路由({ org, ctx: null });
    const 好 = 请求('GET', { host: '127.0.0.1:19387', 'sec-fetch-site': 'same-origin' });
    await ping(好.req, 好.res);
    assert.equal(好.状态.码, 200);
    const 包 = JSON.parse(好.状态.体);
    assert.ok(包.最近同源拒绝, `ping 要带最近同源拒绝：${好.状态.体}`);
    assert.equal(包.最近同源拒绝.端点, 'workbench');
    assert.equal(包.最近同源拒绝.指纹.origin, 'http://localhost:5173');
    assert.match(String(包.最近同源拒绝.期望), /sec-fetch-site/);
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

  it('整月成对删除（已登记月）⇒ 分片缺失见红（R13/R14 口径：月份清单取代日历连续性）', async () => {
    const f = await makeFixture();
    // R13/R14（审查 2026-10-16 口径改形）：修前「月份缺口」按**日历连续性**判——无活动月
    // 会被误报成整月被删（R13 实证）。现行口径：机制每月首写登记「月份清单」，verify 按
    // 清单∪日志∪锚核对——**真被删的已登记月仍必红**（类型从「月份缺口」改为「分片缺失」，
    // 强度不变：删掉账本+锚成对也照样查得出）。本用例改为经 append 造三个月（清单随之登记）。
    const { AuditLog } = await import('../src/audit.js');
    let 当前月 = '2026-08';
    const 桩钟 = { iso: () => `${当前月}-15T00:00:00Z`, ms: () => Date.parse(`${当前月}-15T00:00:00Z`) };
    const audit = new AuditLog({ layout: f.layout, clock: 桩钟 });
    for (const m of ['2026-08', '2026-09', '2026-10']) {
      当前月 = m;
      await audit.append({ 动作: '状态变更', 主体: LEAD, 对象: { id: 'x' } });
    }
    const 好 = await audit.verify();
    assert.equal(好.ok, true, `前提：三月全绿（实际 ${JSON.stringify(好.broken)}）`);
    // 删中间月（账本+锚成对）——它在月份清单里在案。
    await rm(f.layout.auditLog('2026-09'));
    await rm(f.layout.auditAnchor('2026-09'));
    const 坏 = await audit.verify();
    assert.equal(坏.ok, false, '整月删除必须见红');
    assert.ok(坏.broken.some((b) => b.类型 === '分片缺失' && b.month === '2026-09'), `要有 2026-09 的分片缺失项：${JSON.stringify(坏.broken)}`);
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
