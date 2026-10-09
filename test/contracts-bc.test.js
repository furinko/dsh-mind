/**
 * 契约B（只读面收窄）与契约C（披露机械检查）——主权者裁决 2026-10-09 落地的断言。
 *
 * 契约B：memory.query / bus.read / capability.resolve 三个只读服务此前不过策略引擎
 *  （lib/actions.js 直连），现在调用链加 subject 过 policy.check；放行按
 *  「一次调用一条」入账（动作「只读服务调用」，档位=记汇总），绝不逐条结果入账。
 * 契约C：promoteCrossProject 晋升前对 标题+内容+标签 过机械敏感模式；命中即拒
 *  （Denied 指向豁免面），Lead 显式豁免放行且审计记「披露豁免+命中模式」；
 *  清单可被私有 部署.json 的 `披露敏感模式` 整体覆盖，非法正则响亮抛错（fail-closed）。
 *
 * 塞 bug 校准（先红后绿）见提交说明：注释掉 query 的 policy.check / 清空默认清单 /
 * 删 ACTION_GRADE 登记，本文件的对应断言必须红。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, SOVEREIGN, LEAD } from './helpers.mjs';
import { MemoryService } from '../src/memory.js';
import { MessageBus } from '../src/bus.js';
import { CapabilityLibrary } from '../src/capability.js';
import { runAction } from '../lib/actions.js';
import { GRADE } from '../src/audit.js';

const 部署偏好 = '集体L2-共享基础设施/defaults/部署.json';

/** @type {Awaited<ReturnType<typeof makeFixture>>} */
let f;
/** @type {MemoryService} */ let memory;
/** @type {MessageBus} */ let bus;
/** @type {CapabilityLibrary} */ let capability;

describe('契约B · 只读面收窄（2026-10-09 主权者裁决）', () => {
  before(async () => {
    f = await makeFixture();
    memory = new MemoryService({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
    bus = new MessageBus({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
    capability = new CapabilityLibrary({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
  });
  after(async () => {
    await f.cleanup();
  });

  it('无主体即拒（fail-closed）：三个只读服务的拒绝都走既有 Denied 形状', async () => {
    for (const [服务, 敲] of [
      ['memory.query', () => memory.query({ 类: ['偏好'] })],
      ['bus.read', () => bus.read({ 项目: 'default', 线程: 't' })],
      ['capability.resolve', () => capability.resolve({ 名: '任意' })],
    ]) {
      await assert.rejects(
        敲,
        (e) => {
          assert.equal(e.name, 'Denied', `${服务}：必须是 Denied，不是别的异常`);
          assert.equal(e.code, 'DENIED');
          // 既有 Denied 形状四件套：哪条规则 / 为什么 / 要什么授权 / 怎么改。
          assert.ok(typeof e.rule === 'string' && e.rule.length > 0, `${服务}：rule 必须非空`);
          assert.match(e.message, /未知主体/, `${服务}：缺主体按未知主体最严处理`);
          assert.ok(e.requireAuthority, `${服务}：requireAuthority 必须在`);
          assert.ok(String(e.howToChange).length > 0, `${服务}：howToChange 必须可执行`);
          return true;
        },
        `${服务} 不带 subject 必须被拒`,
      );
    }
  });

  it('一次调用一条审计：查询命中多条也只记一条「只读服务调用」，档位=记汇总', async () => {
    for (let i = 0; i < 3; i += 1) {
      await memory.remember({ subject: LEAD, 类: '偏好', 内容: `审计档位演示第 ${i} 条`, 来源: '测试' });
    }
    const before = (await f.audit.read({})).length;
    const result = await memory.query({ subject: LEAD, 类: ['偏好'] });
    assert.ok(result.条目.length >= 3, `前提：可见条目不止一条（实际 ${result.条目.length}），断言才有意义`);
    const 新增 = (await f.audit.read({})).slice(before);
    const 只读 = 新增.filter((r) => r.动作 === '只读服务调用');
    assert.equal(只读.length, 1, `一次调用必须恰好一条，实际 ${只读.length}（全部新增：${JSON.stringify(新增.map((r) => r.动作))}）`);
    assert.equal(只读[0].档位, GRADE.记汇总, '档位由 ACTION_GRADE 登记为「记汇总」');
    assert.equal(只读[0].主体?.id, 'lead', '审计主体就是判定的那个主体');
  });

  it('bus.read 与 capability.resolve 放行也各记一条「只读服务调用」', async () => {
    await bus.send({ subject: LEAD, 项目: 'default', 线程: 'cb', 发件: 'lead', 收件: ['member-a'], 类型: '表态', 内容: '压一条' });
    const beforeBus = (await f.audit.read({})).length;
    assert.equal((await bus.read({ subject: LEAD, 项目: 'default', 线程: 'cb' })).length, 1);
    const busRows = (await f.audit.read({})).slice(beforeBus).filter((r) => r.动作 === '只读服务调用');
    assert.equal(busRows.length, 1, 'bus.read 一次调用一条');
    assert.equal(busRows[0].详情?.服务, 'bus.read');

    const beforeCap = (await f.audit.read({})).length;
    await capability.resolve({ subject: LEAD, 名: '不存在的名字也没关系' });
    const capRows = (await f.audit.read({})).slice(beforeCap).filter((r) => r.动作 === '只读服务调用');
    assert.equal(capRows.length, 1, 'capability.resolve 一次调用一条');
    assert.equal(capRows[0].详情?.服务, 'capability.resolve');
  });

  it('档位表登记：只读服务调用=记汇总、披露豁免=全记（表外 fallback 是全记，漏登记必现假档位）', () => {
    assert.equal(f.audit.gradeOf('只读服务调用'), GRADE.记汇总);
    assert.equal(f.audit.gradeOf('披露豁免'), GRADE.全记);
  });

  it('封存实例的查询被拒：身份链接入只读判定（§12.2），收窄不只看动作还看主体', async () => {
    const g = await makeFixture({ members: { 'member-sealed': { id: 'member-sealed', 岗位: '插件工程', 代: 1, status: '封存' } } });
    try {
      const m = new MemoryService({ layout: g.layout, policy: g.policy, audit: g.audit, clock: g.clock });
      await assert.rejects(
        () => m.query({ subject: { id: 'member-sealed', kind: '成员', roleId: '插件工程' }, 类: ['偏好'] }),
        (e) => e.name === 'Denied' && /§12\.2/.test(e.rule) && /封存/.test(e.message),
      );
    } finally {
      await g.cleanup();
    }
  });

  it('工具面三个只读动作的主体走批次3身份链：自报未登记实例在进服务前就被拒', async () => {
    const org = { registry: { identity: async () => ({ members: {} }) } };
    for (const action of ['memory_query', 'bus_read', 'capability_resolve']) {
      await assert.rejects(
        () => runAction({ org, 项目: 'default', subject: { id: 'lead', kind: 'Lead' }, args: { action, role: '插件工程', 实例: 'ghost', 线程: 't', 名: 'x' } }),
        (e) => /身份档案/.test(e.message),
        `${action} 的主体必须过身份链，不许 role 自报即真`,
      );
    }
  });

  it('工具面三个 handler 把可信主体传到服务层（不是 args 里另开的自报字段）', async () => {
    let last = null;
    const org = {
      registry: { identity: async () => ({ members: {} }) },
      memory: { query: async (q) => { last = { 服务: 'memory.query', subject: q.subject }; return {}; } },
      bus: { read: async (q) => { last = { 服务: 'bus.read', subject: q.subject }; return []; } },
      capability: { resolve: async (q) => { last = { 服务: 'capability.resolve', subject: q.subject }; return {}; } },
    };
    await runAction({ org, 项目: 'default', subject: { id: 'lead', kind: 'Lead' }, args: { action: 'memory_query' } });
    assert.equal(last.服务, 'memory.query');
    assert.equal(last.subject.kind, 'Lead', '服务层收到的是 runAction 主体链的 Lead');

    await runAction({ org, 项目: 'default', subject: { id: 'lead', kind: 'Lead' }, args: { action: 'bus_read', 线程: 't' } });
    assert.equal(last.服务, 'bus.read');
    assert.equal(last.subject.id, 'lead');

    await runAction({ org, 项目: 'default', subject: { id: 'lead', kind: 'Lead' }, args: { action: 'capability_resolve', 名: 'x' } });
    assert.equal(last.服务, 'capability.resolve');
    assert.equal(last.subject.kind, 'Lead');
  });
});

describe('契约C · 知识晋升披露机械检查（2026-10-09 主权者裁决）', () => {
  before(async () => {
    f = await makeFixture();
    memory = new MemoryService({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
  });
  after(async () => {
    await f.cleanup();
  });

  it('默认清单逐类命中即拒晋升，拒绝指向豁免面', async () => {
    const 用例 = [
      ['Windows 盘符绝对路径', '日志落在 C:\\Users\\kuro\\debug.log 里'],
      ['UNC 路径', '挂载点是 \\\\fileserver\\share\\conf'],
      ['环境变量', '配置目录在 %USERPROFILE%\\.dsh 下'],
      ['email', '联系人写的是 admin@example.com'],
      ['凭据词（英文）', '重置 password 之后又要重置 token'],
      ['凭据词（中文）', '把数据库密码直接抄进了文档'],
    ];
    for (const [名, 内容] of 用例) {
      const entry = await memory.remember({ subject: LEAD, 类: '知识', 内容, 来源: '测试', 项目: 'default' });
      await assert.rejects(
        () => memory.promoteCrossProject(entry.id, { subject: LEAD, 岗位: '插件工程', 理由: '想复用' }),
        (e) => {
          assert.equal(e.name, 'Denied', `[${名}] 必须是 Denied`);
          assert.match(e.rule + e.message, /披露|敏感模式/, `[${名}] 拒绝理由要点名披露机械检查`);
          assert.match(e.howToChange, /豁免/, `[${名}] howToChange 必须指向豁免面`);
          assert.ok(Array.isArray(e.detail?.命中模式) && e.detail.命中模式.length > 0, `[${名}] 拒绝详情要带命中模式名`);
          return true;
        },
        `[${名}] 命中默认清单必须拒绝晋升`,
      );
    }
  });

  it('标题与标签命中同样拦——三个面（标题+内容+标签）都要过', async () => {
    const byTitle = await memory.remember({ subject: LEAD, 类: '知识', 标题: '迁移目标 D:\\data', 内容: '内容本身干净', 来源: '测试', 项目: 'default' });
    await assert.rejects(
      () => memory.promoteCrossProject(byTitle.id, { subject: LEAD, 岗位: '插件工程', 理由: 'x' }),
      (e) => e.name === 'Denied' && e.detail?.命中模式?.includes('Windows 绝对路径/盘符'),
      '标题里的盘符路径必须拦',
    );
    const byTag = await memory.remember({ subject: LEAD, 类: '知识', 内容: '内容本身干净', 标签: ['api-token'], 来源: '测试', 项目: 'default' });
    await assert.rejects(
      () => memory.promoteCrossProject(byTag.id, { subject: LEAD, 岗位: '插件工程', 理由: 'x' }),
      (e) => e.name === 'Denied' && e.detail?.命中模式?.includes('凭据词'),
      '标签里的 token 必须拦',
    );
  });

  it('Lead 显式豁免放行晋升：审计记「披露豁免+命中模式」，且不把敏感原文抄进账本', async () => {
    const entry = await memory.remember({ subject: LEAD, 类: '知识', 内容: '公开支持邮箱 ops@example.com', 来源: '测试', 项目: 'default' });
    const promoted = await memory.promoteCrossProject(entry.id, { subject: LEAD, 岗位: '插件工程', 理由: '这是对外公开的支持邮箱', 披露豁免: true });
    assert.equal(promoted.岗位, '插件工程', '豁免后晋升正常完成');

    const rows = await f.audit.read({});
    const 豁免 = rows.filter((r) => r.动作 === '披露豁免' && r.对象?.id === entry.id);
    assert.equal(豁免.length, 1, '恰好一条披露豁免记录');
    assert.deepEqual(豁免[0].详情?.命中模式, ['email'], '命中模式名要进审计');
    assert.equal(豁免[0].档位, GRADE.全记, '披露豁免按全记入账');
    assert.equal(豁免[0].主体?.id, 'lead', '谁豁免的就记谁');
    assert.ok(!JSON.stringify(豁免).includes('ops@example.com'), '审计不许抄敏感原文（只记模式名）——抄进去等于二次披露');
  });

  it('豁免参数仅 Lead：主权者带 披露豁免=true 也拒', async () => {
    const entry = await memory.remember({ subject: SOVEREIGN, 类: '知识', 内容: '内部密钥轮换涉及 secret', 来源: '测试', 项目: 'default' });
    await assert.rejects(
      () => memory.promoteCrossProject(entry.id, { subject: SOVEREIGN, 岗位: '插件工程', 理由: '主权者想豁免', 披露豁免: true }),
      (e) => e.name === 'Denied' && /豁免/.test(e.rule + e.message) && /Lead/.test(e.rule + e.message),
      '豁免面按裁决只对 Lead 开放',
    );
  });

  it('干净内容晋升不产生披露豁免审计', async () => {
    const clean = await memory.remember({ subject: LEAD, 类: '知识', 内容: '通用的部署检查单：先备份再升级', 来源: '测试', 项目: 'default' });
    const ok = await memory.promoteCrossProject(clean.id, { subject: LEAD, 岗位: '插件工程', 理由: '通用知识' });
    assert.equal(ok.岗位, '插件工程');
    assert.ok(
      !(await f.audit.read({})).some((r) => r.动作 === '披露豁免' && r.对象?.id === clean.id),
      '没命中就没豁免这回事，不许出现空豁免记录',
    );
  });

  it('部署.json 的 披露敏感模式 整体覆盖出厂默认清单', async () => {
    const g = await makeFixture({
      privateFiles: {
        [部署偏好]: JSON.stringify({ 披露敏感模式: [{ 名: '内部代号', 正则: '内部代号[A-Z]-\\d+' }] }),
      },
    });
    try {
      const m = new MemoryService({ layout: g.layout, policy: g.policy, audit: g.audit, clock: g.clock });
      // 覆盖是整体替换：出厂默认的盘符模式不再拦。
      const pathy = await m.remember({ subject: LEAD, 类: '知识', 内容: '工具装在 C:\\tools 下', 来源: '测试', 项目: 'default' });
      assert.equal((await m.promoteCrossProject(pathy.id, { subject: LEAD, 岗位: '插件工程', 理由: 'x' })).岗位, '插件工程', '默认清单已被覆盖，此内容放行');
      // 自定义模式开始拦。
      const coded = await m.remember({ subject: LEAD, 类: '知识', 内容: '文档里带了 内部代号K-7', 来源: '测试', 项目: 'default' });
      await assert.rejects(
        () => m.promoteCrossProject(coded.id, { subject: LEAD, 岗位: '插件工程', 理由: 'x' }),
        (e) => e.name === 'Denied' && e.detail?.命中模式?.includes('内部代号'),
        '部署.json 覆盖的自定义模式必须生效',
      );
    } finally {
      await g.cleanup();
    }
  });

  it('部署.json 非法正则响亮抛错：引擎不健康（fail-closed），只读面一起被拒', async () => {
    const g = await makeFixture({
      privateFiles: { [部署偏好]: JSON.stringify({ 披露敏感模式: [{ 名: '坏正则', 正则: '([' }] }) },
    });
    try {
      assert.equal(g.policy.healthy, false, '加载失败必须反映在不健康状态上');
      assert.match(g.policy.state.error, /披露敏感模式/, '错误要点名是哪个键');
      assert.match(g.policy.state.error, /正则非法/, '错误要说清是正则编译不过');
      const m = new MemoryService({ layout: g.layout, policy: g.policy, audit: g.audit, clock: g.clock });
      await assert.rejects(
        () => m.query({ subject: LEAD, 类: ['偏好'] }),
        (e) => e.name === 'Fault' || /fail-closed|不健康|故障/.test(e.message),
        '坏清单不许静默跳过：引擎 fail-closed 连带只读面一起被拒',
      );
    } finally {
      await g.cleanup();
    }
  });

  it('部署.json 清单形状坏（非数组）同样 fail-closed', async () => {
    const g = await makeFixture({
      privateFiles: { [部署偏好]: JSON.stringify({ 披露敏感模式: 'password' }) },
    });
    try {
      assert.equal(g.policy.healthy, false);
      assert.match(g.policy.state.error, /披露敏感模式.*数组/);
    } finally {
      await g.cleanup();
    }
  });

  it('工具面 memory_lifecycle promote 把 披露豁免 传到服务层（不传则严格 false）', async () => {
    let 收到 = null;
    const org = {
      registry: { identity: async () => ({ members: {} }) },
      memory: { promoteCrossProject: async (id, spec) => { 收到 = spec; return { id, 岗位: spec.岗位 }; } },
    };
    await runAction({ org, 项目: 'default', subject: { id: 'lead', kind: 'Lead' }, args: { action: 'memory_lifecycle', op: 'promote', id: 'k-1', 岗位: '插件工程', 原因: 'r', 披露豁免: true } });
    assert.equal(收到.披露豁免, true, '显式带参要传 true');
    await runAction({ org, 项目: 'default', subject: { id: 'lead', kind: 'Lead' }, args: { action: 'memory_lifecycle', op: 'promote', id: 'k-2', 岗位: '插件工程', 原因: 'r' } });
    assert.equal(收到.披露豁免, false, '不带参数必须折成 false，不许 undefined 混过条件判断');
  });
});
