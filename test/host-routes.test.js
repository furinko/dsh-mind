/**
 * Batch 7 · 宿主侧：自注册同源路由。
 *
 * 为什么要换传输层：`remote.commands.execute(sessionId, '/mind dashboard')` 在官方客户端
 * （0.2.0-rc.2）上**永不返回** ⇒ 看板面板停在「读取中」、设置页也没法写设置
 * （真机证据：私有 `部署.json` 不存在、账上 0 条「设置变更」——命令压根没到宿主）。
 *
 * 换成宿主自注册的 exact 路由 + 浏览器同源 `fetch`（已跑通的第三方插件用的就是这条路）。
 * 本文件守的七条：三个端点与命令面**同一份 JSON**、同一套处理函数、没有通用代理、
 * webServer 晚到也能挂上、disposer 真的生效。
 *
 * 每条断言都先证明能变红：红证据见 `E:\dsh-mind-backup\batch7-host-red-evidence.txt`。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeUnder } from './helpers.mjs';
import { readTextOrNull } from '../src/kernel/fsx.js';
import { fakeHost, fakeExec } from './host-harness.mjs';
import { shareOrg, forgetSharedOrg } from '../src/runtime.js';
import * as kernel from '../components/kernel/lib/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const FACTORY = join(here, '..', 'mind');
const 部署偏好 = '集体L2-共享基础设施/defaults/部署.json';
const 前缀 = '/plugins/dsh-mind';
const 端点 = { presence: `${前缀}/presence`, workbench: `${前缀}/workbench`, ping: `${前缀}/ping` };
/** 注册表里**只许**有这三个（多一个就是通用代理的口子）。 */
const 应有端点 = [端点.presence, 端点.workbench, 端点.ping];

const 睡 = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 假的 webServer：只认 exact 路由，未注册的路径一律 404（宿主对未知路径就是这么答的）。 */
function 假WebServer() {
  /** @type {Map<string, Function>} */
  const 表 = new Map();
  return {
    get 路由表() {
      return [...表.keys()];
    },
    register(spec) {
      if (spec?.kind !== 'exact') throw new Error(`只支持 exact 路由：${JSON.stringify(spec?.kind)}`);
      if (表.has(spec.path)) {
        // 复刻宿主的硬校验：重复 path 直接抛，激活失败。
        const error = new Error(`duplicate exact route: ${spec.path}`);
        error.code = 'DUPLICATE_ROUTE';
        throw error;
      }
      表.set(spec.path, spec.handler);
      return () => 表.delete(spec.path);
    },
    /** 测试侧：照 HTTP 的样子发一次请求（真实宿主按 pathname 匹配 exact 路由，query 只在 handler 里读）。 */
    async 请求(method, path, options = {}) {
      const handler = 表.get(String(path).split('?')[0]);
      if (!handler) return { 状态码: 404, 体: '', json: null };
      const 体 = options.体 === undefined ? '' : options.体;
      const req = {
        method,
        url: path,
        headers: {
          host: '127.0.0.1:3099',
          ...(体 ? { 'content-type': 'application/json' } : {}),
          'sec-fetch-site': 'same-origin',
          ...(options.headers ?? {}),
        },
        async *[Symbol.asyncIterator]() {
          if (体) yield Buffer.from(体, 'utf8');
        },
      };
      const res = {
        状态码: null,
        头: null,
        体: '',
        writeHead(码, 头) {
          this.状态码 = 码;
          this.头 = 头 ?? null;
        },
        end(文本) {
          this.体 = 文本 ?? '';
        },
      };
      await handler(req, res);
      let json = null;
      try {
        json = res.体 ? JSON.parse(res.体) : null;
      } catch {
        // 不是 JSON 就留着原文，让断言自己报出来
      }
      return { 状态码: res.状态码, 体: res.体, json };
    },
  };
}

async function 起宿主(options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'mind-routes-'));
  const host = options.提供服务 ? fakeHost({ 提供服务: options.提供服务 }) : fakeHost();
  const ws = 假WebServer();
  if (options.时机 !== 'late' && options.时机 !== 'never') host.ctx.webServer = ws;
  await kernel.apply(host.ctx, {
    home,
    factoryRoot: FACTORY,
    privateRoot: join(home, 'mind-private'),
    webServer间隔毫秒: options.间隔毫秒 ?? 20,
    webServer次数: options.次数 ?? 20,
  });
  const org = await shareOrg({ home, factoryRoot: FACTORY, privateRoot: join(home, 'mind-private') });
  await org.policy.reload();
  if (options.时机 === 'late') {
    await 睡(options.晚到毫秒 ?? 40);
    host.ctx.webServer = ws;
    await 睡(options.等毫秒 ?? 150);
  }
  return {
    home,
    host,
    org,
    ws,
    命令: host.命令.get('mind'),
    文件: org.layout.deploymentPrefs(),
    写私有: (rel, text) => writeUnder(join(home, 'mind-private'), rel, text),
    清理: async () => {
      host.清理();
      forgetSharedOrg();
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
    },
  };
}

/** 只比除 `主体.id` 外的每一格：路由面主体是「设置页」、命令面是「敲命令的会话」，这个差异是设计要求的。 */
function 除主体(document) {
  const { 主体, ...其余 } = document;
  return { ...其余, 主体: { kind: 主体?.kind ?? null, roleId: 主体?.roleId ?? null } };
}

describe('Batch 7：自注册同源路由（换掉永不返回的命令通道）', () => {
  // ① GET presence 与 `/mind presence` 同一份 JSON
  it('① GET presence ⇒ 与 `/mind presence` 读同一份 JSON（形状逐字段比）', async () => {
    const t = await 起宿主();
    try {
      // 前提：这个假宿主**不提供** remote（路由不许依赖 `ctx.get('remote')` 那条链）。
      assert.equal(t.host.ctx.get('remote'), undefined, '前提：没有 remote 服务可用');
      const 路由 = await t.ws.请求('GET', 端点.presence);
      assert.equal(路由.状态码, 200, 路由.体);
      assert.equal(路由.json?.成功, true, 路由.体);
      const 命令 = JSON.parse((await t.命令.handler({ agent: {}, rawInput: 'presence' })).text);
      // 键集合与键序都要一样：客户端只是换传输层，解析逻辑不动。
      assert.deepEqual(Object.keys(路由.json), Object.keys(命令), `键集合/键序必须一致：\n路由 ${Object.keys(路由.json)}\n命令 ${Object.keys(命令)}`);
      assert.deepEqual(除主体(路由.json), 除主体(命令), '除主体 id 外逐字段相同');
      assert.deepEqual(路由.json.读数, 命令.读数, '读数那一块逐字段相同');
      // 主体：路由面**不许**冒充任何人，只如实说「设置页」。
      assert.equal(路由.json.主体.id, '设置页', '路由面主体就是「设置页」');
      assert.equal(路由.json.主体.kind, 'Lead');
      assert.notEqual(路由.json.主体.id, 'sovereign', '绝不许冒充主权者');
    } finally {
      await t.清理();
    }
  });

  // ①b 无会话也能用：宿主连 commands / remote 都没有，路由照旧工作
  it('①b 宿主连 commands / remote 都没有 ⇒ 路由照旧可用（它不依赖会话那条链）', async () => {
    const t = await 起宿主({ 提供服务: ['tools'] });
    try {
      assert.equal(t.host.ctx.get('commands'), undefined, '前提：命令服务不可用');
      assert.equal(t.host.ctx.get('remote'), undefined, '前提：remote 不可用');
      const 读 = await t.ws.请求('GET', 端点.presence);
      assert.equal(读.json?.成功, true, `路由必须能独立工作：${读.体}`);
      const 写 = await t.ws.请求('POST', 端点.presence, { 体: JSON.stringify({ 小时: 96 }) });
      assert.equal(写.json?.成功, true, `写也必须能独立工作：${写.体}`);
      assert.equal(t.org.policy.presence().生效响应期限小时, 96, '写要真生效');
      assert.equal((await t.ws.请求('GET', 端点.workbench)).json.成功, true);
      assert.equal((await t.ws.请求('GET', 端点.ping)).json.有webServer, true);
    } finally {
      await t.清理();
    }
  });

  // ② POST presence ⇒ merge 写 + 审计 + 与命令面写同形
  it('② POST presence {小时:168} ⇒ merge 写入私有 部署.json、审计多一条、响应与命令面同形', async () => {
    const t = await 起宿主();
    try {
      // 先手工放一个别的键：merge 不许把它丢掉。
      await t.写私有(部署偏好, JSON.stringify({ 介入度: '事后抽检' }, null, 2));
      const 路由 = await t.ws.请求('POST', 端点.presence, { 体: JSON.stringify({ 小时: 168 }) });
      assert.equal(路由.状态码, 200, 路由.体);
      assert.equal(路由.json?.成功, true, 路由.体);
      const 文件 = JSON.parse(await readTextOrNull(t.文件));
      assert.equal(文件.响应期限小时, 168, '路由面写必须落到同一个文件');
      assert.equal(文件.介入度, '事后抽检', 'merge 写：别的键不许丢');
      assert.equal(t.org.policy.presence().生效响应期限小时, 168, '写完立刻生效');

      const 审计 = (await t.org.audit.read({})).filter((r) => r.动作 === '设置变更');
      assert.equal(审计.length, 1, `路由面的写必须入账，实际 ${审计.length} 条`);
      assert.equal(审计[0].主体.id, '设置页', '账上主体是「设置页」');
      assert.equal(审计[0].主体.kind, 'Lead');
      assert.notEqual(审计[0].主体.id, 'sovereign', '绝不许冒充主权者');
      assert.match(String(审计[0].依据), /同源路由|设置页/, '依据要写明这是走同源路由的浏览器设置页');
      assert.equal(审计[0].详情.键.响应期限小时.新值, 168, '账上要有原值→新值');

      // 与命令面写同形：同一组键、同样的嵌套形状（值可以不同 —— 两次写的值本来就不同）。
      const 形状 = (doc, 层 = 0) =>
        Object.fromEntries(
          Object.entries(doc).map(([k, v]) => [
            k,
            v && typeof v === 'object' && !Array.isArray(v) && 层 < 2 ? 形状(v, 层 + 1) : (Array.isArray(v) ? 'array' : typeof v),
          ]),
        );
      const 命令 = JSON.parse((await t.命令.handler({ agent: {}, rawInput: 'presence 小时=24' })).text);
      assert.deepEqual(Object.keys(路由.json), Object.keys(命令), '与命令面写的响应键集合/键序一致');
      assert.deepEqual(形状(除主体(路由.json)), 形状(除主体(命令)), '与命令面写的响应同形');
      assert.equal(命令.成功, true, '正对照：命令面自己也写得进去');
      assert.equal(JSON.parse(await readTextOrNull(t.文件)).响应期限小时, 24, '命令面写的是同一个文件（同一条路）');
    } finally {
      await t.清理();
    }
  });

  // ③ 非法值 ⇒ 拒绝、文件不动、账上有那条拒绝
  it('③ 非法值（小时:0 / 小时:999999999 / 开关:"也许"）⇒ 拒绝 + 文件不动 + 账上有拒绝', async () => {
    const t = await 起宿主();
    try {
      const 用例 = [
        { 参数: { 小时: 0 }, 理由: /小时/ },
        { 参数: { 小时: 999999999 }, 理由: /876000/ },
        { 参数: { 开关: '也许' }, 理由: /开关/ },
      ];
      for (const c of 用例) {
        const 原份 = JSON.stringify({ 介入度: '零参与', 其它: '不许动' }, null, 2) + '\n';
        await t.写私有(部署偏好, 原份);
        const 路由 = await t.ws.请求('POST', 端点.presence, { 体: JSON.stringify(c.参数) });
        const 标注 = JSON.stringify(c.参数);
        assert.equal(路由.json?.成功, false, `${标注}：必须被拒（${路由.体}）`);
        assert.ok(['拒绝', '结构不合规'].includes(路由.json.结果), `${标注}：结果应是 拒绝/结构不合规，实际 ${路由.json.结果}`);
        assert.match(String(路由.json.理由), c.理由, `${标注}：理由要可执行`);
        assert.equal(await readTextOrNull(t.文件), 原份, `${标注}：拒绝路径不许动文件（逐字节相同）`);
      }
      const 拒绝 = (await t.org.audit.read({})).filter((r) => r.动作 === '设置变更' && /拒绝/.test(String(r.结果)));
      assert.ok(拒绝.length >= 3, `每条拒绝都要入账，实际 ${拒绝.length} 条`);
      assert.equal(拒绝[0].主体.id, '设置页');
      // 反例面：合法值照样能写 —— 证明上面拒的不是「这个端点不能用」。
      assert.equal((await t.ws.请求('POST', 端点.presence, { 体: JSON.stringify({ 小时: 72 }) })).json.成功, true);
    } finally {
      await t.清理();
    }
  });

  // ④ GET workbench 与 `/mind dashboard` 同一份投影
  it('④ GET workbench ⇒ 与 `/mind dashboard` 同一份投影', async () => {
    const t = await 起宿主();
    try {
      const 路由 = await t.ws.请求('GET', 端点.workbench);
      assert.equal(路由.状态码, 200, 路由.体);
      assert.equal(路由.json?.成功, true, 路由.体);
      assert.equal(路由.json.action, 'workbench');
      const 命令 = JSON.parse((await t.命令.handler({ agent: {}, rawInput: 'dashboard' })).text);
      assert.deepEqual(Object.keys(路由.json), Object.keys(命令), '包装层键集合/键序一致');
      // `生成于` 是时间戳（两次调用必然不同）⇒ 比之外逐字段相同。
      const { 生成于: _a, ...路由数据 } = 路由.json.数据;
      const { 生成于: _b, ...命令数据 } = 命令.数据;
      assert.deepEqual(Object.keys(路由数据), Object.keys(命令数据), '看板投影的顶层块必须一致');
      assert.deepEqual(路由数据, 命令数据, '除 生成于 外逐字段相同（同一份投影）');
    } finally {
      await t.清理();
    }
  });

  // ⑤ 没有通用代理：注册表里只有这三条 path，别的路径一律 404
  it('⑤ 不存在通用代理：注册表只有三个端点，run/command/action 一律 404', async () => {
    const t = await 起宿主();
    try {
      assert.deepEqual(
        [...t.ws.路由表].sort(),
        [...应有端点].sort(),
        `注册的路径必须只有这三个：${JSON.stringify(t.ws.路由表)}`,
      );
      for (const 名 of ['run', 'command', 'action', 'exec', 'tool', 'dispatch']) {
        for (const 方法 of ['GET', 'POST']) {
          const 答 = await t.ws.请求(方法, `${前缀}/${名}`, { 体: 方法 === 'POST' ? JSON.stringify({ action: 'presence' }) : '' });
          assert.equal(答.状态码, 404, `${方法} ${前缀}/${名} 必须 404（不许有通用代理）`);
        }
      }
      // 连"端点带尾巴"也不认（exact 路由的语义）。
      assert.equal((await t.ws.请求('GET', `${端点.presence}/extra`)).状态码, 404);
    } finally {
      await t.清理();
    }
  });

  // ⑤b ping：通路自检端点（浏览器侧的诊断依据），同样不是通用代理
  it('⑤b GET ping ⇒ 如实回报通路状态，且不许被当成通用代理', async () => {
    const t = await 起宿主();
    try {
      const 答 = await t.ws.请求('GET', 端点.ping);
      assert.equal(答.状态码, 200, 答.体);
      assert.deepEqual(Object.keys(答.json ?? {}), ['成功', '组件', '有webServer', '时间'], `响应键要与约定一致：${答.体}`);
      assert.equal(答.json.成功, true);
      assert.equal(答.json.组件, 'dsh-mind-kernel');
      assert.equal(答.json.有webServer, true, '能收到这个响应 ⇒ 路由确实挂在 webServer 上');
      assert.match(String(答.json.时间), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, '秒级 ISO 时间');
      // 它只回状态，不吃参数：带 query 也还是同一份自检（不会被拿去跑任何动作）。
      const 带参 = await t.ws.请求('GET', `${端点.ping}?action=presence&cmd=status`);
      assert.deepEqual(Object.keys(带参.json ?? {}), ['成功', '组件', '有webServer', '时间']);
      assert.equal(带参.json.组件, 'dsh-mind-kernel');
      assert.equal(带参.json.读数, undefined, 'ping 不许顺手把业务读数带出来');
      // 写方法不认：自检是只读的。
      assert.equal((await t.ws.请求('POST', 端点.ping, { 体: '{}' })).状态码, 405);
    } finally {
      await t.清理();
    }
  });

  // ⑥ webServer 晚到 / 根本拿不到
  it('⑥ webServer 晚到 ⇒ 照旧注册成功；拿不到 ⇒ 装载不失败', async () => {
    const 晚 = await 起宿主({ 时机: 'late', 晚到毫秒: 40, 等毫秒: 200 });
    try {
      assert.deepEqual(
        [...晚.ws.路由表].sort(),
        [...应有端点].sort(),
        `webServer 晚到也要挂上：${JSON.stringify(晚.ws.路由表)}`,
      );
      assert.equal((await 晚.ws.请求('GET', 端点.presence)).json.成功, true);
      assert.equal((await 晚.ws.请求('GET', 端点.ping)).json.有webServer, true);
    } finally {
      await 晚.清理();
    }

    const 无 = await (async () => {
      const home = await mkdtemp(join(tmpdir(), 'mind-routes-none-'));
      const host = fakeHost();
      let 抛了 = null;
      try {
        await kernel.apply(host.ctx, {
          home,
          factoryRoot: FACTORY,
          privateRoot: join(home, 'mind-private'),
          webServer间隔毫秒: 10,
          webServer次数: 3,
        });
      } catch (error) {
        抛了 = error;
      }
      await 睡(60); // 让 3 次轮询用尽
      return { host, home, 抛了 };
    })();
    try {
      assert.equal(无.抛了, null, `webServer 缺失不许让装载失败：${无.抛了?.message}`);
      assert.ok(无.host.工具.get('mind'), '插件必须保持激活（工具在位）');
      assert.ok(无.host.命令.get('mind'), '命令面也照样注册');
    } finally {
      无.host.清理();
      forgetSharedOrg();
      await rm(无.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
    }
  });

  // ⑦ 重复 apply：disposer 真的生效
  it('⑦ 重复 apply（卸载后重装）⇒ 不报 duplicate、不留残留', async () => {
    const 一 = await 起宿主();
    const { ws, home } = 一;
    try {
      assert.equal(ws.路由表.length, 3, '第一次 apply 挂上三条');
      // 卸载：effect 的清理器必须把路由 disposer 交回去，否则第二次 apply 撞 duplicate。
      一.host.清理();
      assert.deepEqual(ws.路由表, [], `卸载后不许留残留：${JSON.stringify(ws.路由表)}`);

      const host2 = fakeHost();
      host2.ctx.webServer = ws;
      let 抛了 = null;
      try {
        await kernel.apply(host2.ctx, { home, factoryRoot: FACTORY, privateRoot: join(home, 'mind-private'), webServer间隔毫秒: 20, webServer次数: 20 });
      } catch (error) {
        抛了 = error;
      }
      try {
        assert.equal(抛了, null, `二次 apply 不许撞 duplicate exact route：${抛了?.message}`);
        assert.deepEqual([...ws.路由表].sort(), [...应有端点].sort(), '二次 apply 后路由在位');
      } finally {
        host2.清理();
        assert.deepEqual(ws.路由表, [], '第二次卸载同样不许留残留');
      }
    } finally {
      forgetSharedOrg();
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
    }
  });

  // ⑧ P2 正对照（2026-10-10）：三个生产调用点的主体读数。
  // 本批改的是 `runAction` 的**兜底路**（`spec.主体` 缺席 ⇒ 拒）。三个生产调用点
  // （工具面 `components/kernel/lib/index.js:234` / 命令面 `:272` / 路由面 `components/kernel/lib/routes.js:69`）
  // **全部显式传 `主体`** ⇒ 走的是 `spec.主体` 那一支，读数必须与修前**逐字相同**。
  // 这条用例把三处读数原样印出来（修前/修后各跑一次逐字比，读数留在交付回报里）。
  it('⑧ P2 正对照：工具面 / 命令面 / 路由面的主体读数（三处都显式传主体，与修前逐字相同）', async () => {
    const t = await 起宿主();
    try {
      // 工具面：真宿主链（`agentSubject(exec)` ⇒ 根会话 = Lead，实例键 = 会话 id 原样）。
      const 工具 = t.host.工具.get('mind');
      const 工具读数 = JSON.parse(await 工具.execute({ action: 'status' }, fakeExec({ name: 'mind', sessionId: 'session-p2-0001' })));
      // 命令面：`/mind status`（裸 agent ⇒ Lead，既有语义原样）。
      const 命令读数 = JSON.parse((await t.命令.handler({ agent: {}, rawInput: 'status' })).text);
      // 路由面：同源设置页写（主体恒为「设置页」，不冒充任何人）。
      const 路由读数 = (await t.ws.请求('POST', 端点.presence, { 体: JSON.stringify({ 小时: 96 }) })).json;
      console.log(
        `[P2-正对照·读数] 工具面 成功=${工具读数.成功} 主体=${JSON.stringify(工具读数.主体)}`
          + ` | 命令面 成功=${命令读数.成功} 主体=${JSON.stringify(命令读数.主体)}`
          + ` | 路由面 成功=${路由读数.成功} 主体=${JSON.stringify(路由读数.主体)}`,
      );
      assert.deepEqual(工具读数.主体, { id: 'session-p2-0001', kind: 'Lead', roleId: 'Lead' }, '工具面：根会话 ⇒ Lead、实例键 = 会话 id 原样');
      assert.deepEqual(命令读数.主体, { id: 'lead', kind: 'Lead', roleId: 'Lead' }, '命令面：裸 agent ⇒ Lead（既有语义原样）');
      assert.deepEqual(路由读数.主体, { id: '设置页', kind: 'Lead', roleId: 'Lead' }, '路由面：主体 = 设置页，不许冒充主权者');
    } finally {
      await t.清理();
    }
  });
});
