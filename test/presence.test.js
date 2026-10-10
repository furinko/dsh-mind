/**
 * 失联限制（失联保险）与出厂默认值的**单源**。
 *
 * 这一组用例守的是一件事：**主权者照着 README 改设置，必须真的生效**。
 * 以前的形状是「出厂 README 写着 `响应期限.json` 可改，实际生效的却是 `介入度.json`
 * 里重复的一份 ＋ 硬编码 72」—— 改了静默无效，而自检还打勾。所以每条断言都先证明它能变红：
 * 绿不稀奇，**能变红**才说明它测的是真东西（verify-integrity：写不出反例 = 没验过）。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFixture, writeUnder } from './helpers.mjs';
import { readTextOrNull } from '../src/kernel/fsx.js';
import { ACTIONS, COMMAND_ONLY_ACTIONS, COMMAND_ACTIONS, runAction } from '../lib/actions.js';
import { fakeHost, fakeExec } from './host-harness.mjs';
import { shareOrg } from '../src/runtime.js';
import * as kernel from '../components/kernel/lib/index.js';

const here = dirname(fileURLToPath(import.meta.url));
/** 出厂区：断言 ⑤ 读的是**仓库里的真文件**，不是夹具。 */
const FACTORY = join(here, '..', 'mind');
const 出厂响应期限 = join(FACTORY, '集体L2-共享基础设施', 'defaults', '响应期限.json');
const 出厂介入度 = join(FACTORY, '集体L2-共享基础设施', 'defaults', '介入度.json');
/** 私有部署偏好（叠加层，最后覆盖出厂）。 */
const 部署偏好 = '集体L2-共享基础设施/defaults/部署.json';
/** 出厂区那份响应期限件的路径（夹具形状）。 */
const 夹具响应期限 = '集体L2-共享基础设施/defaults/响应期限.json';

/**
 * 冻结清单：工具面上**允许存在**的动作名，手抄一份放在测试里。
 *
 * 为什么要有第二份而不直接比 `ACTIONS`：以前这条判据靠「禁词表 + 正则」，
 * 换个名字就绕过去了 —— `defaults_set` / `presence_write` / 中文动作名都不在禁词表里。
 * 白名单式比对之后，**任何**新动作都不可能静默通过：它必须先被写进这份清单，
 * 而写进来时就得回答一句「这是不是个改设置的动作」。
 * 两条路一起走：schema 的 enum 必须等于这份清单，`ACTIONS` 本体也必须等于它。
 */
const 冻结动作表 = [
  'status',
  'workbench',
  'policy_check',
  'task_create',
  'task_dispatch',
  'task_start',
  'task_submit',
  'task_review',
  'task_pending',
  'task_resolve',
  // task_settle（W3 批3）：结账——环路最后一步，仅 Lead（policy 的 settle 动作守着）。
  // 它是**工具面可达**的：收尾必须是 Lead 显式拍板的一步，藏进 review 内部就没有独立动作记录了。
  'task_settle',
  'memory_write',
  'memory_query',
  'memory_lineage',
  'memory_lifecycle',
  'capability_list',
  'capability_resolve',
  'capability_read',
  'capability_publish',
  'bus_send',
  'bus_read',
  'audit_tail',
  'audit_verify',
  'registry_list',
  'registry_can',
  'registry_assign',
  'registry_seal',
  'registry_revoke',
  'upgrade_pending',
  'review_zero',
  'bus_unlock',
  'debate_open',
  'debate_say',
  'debate_round',
  'debate_converge',
];
// sovereign_interaction 不在工具面：它是命令面专属（与 presence 同一张 B 清单），
// 失联判定的「事实源」——主权者在线——只能由人声明（/mind sovereign_interaction）。

/** 相对现在的小时数 → ISO 串。 */
const 前 = (小时) => new Date(Date.now() - 小时 * 3600_000).toISOString();

/** 覆盖私有区 部署.json（主权者改的那份）。 */
const 写部署偏好 = (f, obj) => writeUnder(f.privateRoot, 部署偏好, JSON.stringify(obj, null, 2));

/** 身份档案：指定「最后一次交互」在多少小时前。 */
const 写身份 = (f, 小时) => writeUnder(f.privateRoot, '身份档案/identity.json', JSON.stringify({
  members: { lead: { id: 'lead', 岗位: 'Lead', status: '在岗' } },
  sovereign: { lastInteraction: 前(小时) },
  denylist: [],
}, null, 2));

/** 自治档写动作的判定（失联冻结就是拦在这一条上）。 */
const 自治写 = (policy) => policy.decide({ subject: { id: 'lead', kind: 'Lead' }, action: 'write', target: { id: 'c', kind: '能力', authority: '自治' } });

describe('失联限制：出厂件是真源，开关可关', () => {
  /** @type {Awaited<ReturnType<typeof makeFixture>>} */
  let f;
  before(async () => {
    f = await makeFixture();
  });
  after(async () => {
    await f.cleanup();
  });

  // ① 出厂 响应期限.json 的 响应期限小时 必须真的被读 —— 改了要生效。
  it('① 出厂 响应期限.json 改成 1 小时 ⇒ 2 小时未交互即失联', async () => {
    const g = await makeFixture({ presence: { 失联限制: true, 响应期限小时: 1 } });
    await 写身份(g, 2);
    assert.equal(await g.policy.reload(), true, '夹具必须能加载（引擎健康）');
    assert.equal(g.policy.state.defaults.响应期限小时, 1, '出厂 响应期限.json 的值必须进 defaults');
    assert.equal(g.policy.presence().lost, true, '1 小时期限 + 2 小时未交互 = 失联');
    assert.equal((await 自治写(g.policy)).verdict, 'deny', '失联 ⇒ 自治写被冻结');
    await g.cleanup();
  });

  // ①的反例面：同一时刻、默认期限下不该失联 —— 证明上面那条不是恒真。
  it('①反例 默认 72 小时期限下，同样 2 小时未交互不失联', async () => {
    const h = await makeFixture();
    await 写身份(h, 2);
    assert.equal(await h.policy.reload(), true);
    assert.equal(h.policy.state.defaults.响应期限小时, 72);
    assert.equal(h.policy.presence().lost, false, '默认 72 小时下 2 小时不该失联');
    assert.equal((await 自治写(h.policy)).verdict, 'allow', '不失联 ⇒ 自治写放行');
    await h.cleanup();
  });

  // ①的另一半：文件**缺失**（不是坏）⇒ 允许退回内置默认 —— 全新部署合理。
  it('①缺失 出厂 响应期限.json 缺失 ⇒ 退回内置默认 72，且引擎仍健康', async () => {
    const g = await makeFixture();
    await rm(join(g.factoryRoot, 夹具响应期限), { force: true });
    assert.equal(await g.policy.reload(), true, '缺文件不是坏文件：不该让引擎不健康');
    assert.equal(g.policy.state.defaults.响应期限小时, 72, '缺失 ⇒ 退回内置兜底 72');
    assert.equal(g.policy.state.defaults.失联限制, true, '缺失 ⇒ 开关仍默认开着');
    await g.cleanup();
  });

  // ② 私有 部署.json 压过出厂（回归：别把主权者优先弄坏）。
  it('② 私有 部署.json 的 响应期限小时 压过出厂两个文件', async () => {
    const g = await makeFixture({ presence: { 失联限制: true, 响应期限小时: 1 } });
    await 写部署偏好(g, { 响应期限小时: 72 });
    await 写身份(g, 2);
    assert.equal(await g.policy.reload(), true);
    assert.equal(g.policy.state.defaults.响应期限小时, 72, '私有部署偏好最后覆盖出厂');
    assert.equal(g.policy.presence().lost, false, '72 小时下 2 小时不该失联');
    await g.cleanup();
  });

  // ③ 开关关掉：不冻结，但也**不许伪装成在线**。
  it('③ 失联限制 false ⇒ 超期也不冻结，且读数里是「已关闭」', async () => {
    const g = await makeFixture({ presence: { 失联限制: false, 响应期限小时: 1 } });
    await 写身份(g, 30 * 24);
    assert.equal(await g.policy.reload(), true);
    const p = g.policy.presence();
    assert.equal(p.已关闭, true, '关了就得说关了');
    assert.equal(p.lost, false, '关了就不冻结');
    // 不伪装成在线：`since` / `deadline` 不许是「有交互、未到期」的形状。
    assert.equal(p.since, null);
    assert.equal(p.deadline, null);
    assert.equal(p.hours, 0);
    assert.equal((await 自治写(g.policy)).verdict, 'allow', '关了 ⇒ 自治写不再被失联冻结拦下');
    // 反例面：把开关打开，同一份身份档案下必须重新冻结 —— 证明「allow」不是别的原因给的。
    await 写部署偏好(g, { 失联限制: true });
    assert.equal(await g.policy.reload(), true);
    assert.equal(g.policy.presence().lost, true);
    assert.equal((await 自治写(g.policy)).verdict, 'deny');
    await g.cleanup();
  });

  // ④ 坏 JSON 必须响亮抛错，不许静默退回 72。
  it('④ 出厂 响应期限.json 坏 ⇒ 响亮抛错 + 引擎 fail-closed（不静默退 72）', async () => {
    const g = await makeFixture();
    await g.write(夹具响应期限, '{ "响应期限小时": 1, 这不是 JSON');
    assert.equal(await g.policy.reload(), false, '坏件 ⇒ 引擎不健康');
    assert.equal(g.policy.healthy, false);
    assert.match(String(g.policy.state.error), /无法解析/, '错误必须点名「无法解析」，而不是悄悄给个 72');
    // 不能把坏件当成「没设置」：写动作必须 fail-closed 被拒。
    const d = await 自治写(g.policy);
    assert.equal(d.verdict, 'deny');
    assert.equal(d.alarm, true, '故障必须响亮（§3.6）');
    await g.cleanup();
  });

  // ⑤ 双源根因：出厂 介入度.json 里不得再有 响应期限小时。
  it('⑤ 出厂 介入度.json 不再承载 响应期限小时（读仓库里的真文件）', async () => {
    const text = await readTextOrNull(出厂介入度);
    assert.notEqual(text, null, `出厂件必须存在：${出厂介入度}`);
    const parsed = JSON.parse(text);
    assert.ok(!('响应期限小时' in parsed), '介入度.json 里不许再有 响应期限小时 —— 双源就是「改了不生效」的根因');
    assert.ok(!('失联限制' in parsed), '失联限制 也不许住在介入度.json');
    assert.deepEqual(Object.keys(parsed), ['介入度'], '介入度.json 只承载介入度这一个键');
    // 另一头：响应期限件必须真的承载这两个键（否则单源变成了无源）。
    const 期限 = JSON.parse(await readTextOrNull(出厂响应期限));
    assert.equal(期限.失联限制, true);
    assert.equal(期限.响应期限小时, 72);
  });

  // ⑥ 读数：开关关掉时 status() 里看得出是「已关闭」（走真实的装配 + 动作表）。
  it('⑥ /mind status 在开关关闭时输出里含「已关闭」', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mind-presence-'));
    const host = fakeHost();
    await kernel.apply(host.ctx, { home, factoryRoot: FACTORY, privateRoot: join(home, 'mind-private') });
    try {
      // 主权者改私有 部署.json 关掉开关，再触发一次重载（宿主定时重读之外的手动入口）。
      await writeUnder(home, `mind-private/${部署偏好}`, JSON.stringify({ 失联限制: false, 响应期限小时: 1 }, null, 2));
      // 共享运行时：组件装配的就是这一个组织实例（不是另造一份）。
      const org = await shareOrg({ home, factoryRoot: FACTORY, privateRoot: join(home, 'mind-private') });
      await org.policy.reload();

      // 人敲的 `/mind status` 与模型调的 `mind{action:status}` 进的是同一张动作表。
      const 命令 = host.命令.get('mind');
      const 回复 = await 命令.handler({ agent: {}, rawInput: 'status' });
      assert.equal(回复.kind, 'success', 回复.text);
      const 包 = JSON.parse(回复.text);
      const 状态数据 = 包.数据;
      assert.equal(状态数据.失联.已关闭, true, '/mind status 必须看得出开关是关的');
      assert.equal(状态数据.失联.lost, false);
      assert.match(回复.text, /已关闭/, '输出文本里要真的有「已关闭」这四个字');

      // 工具侧同一条路：JSON 文本里同样带 已关闭。
      const 工具 = host.工具.get('mind');
      const 工具回复 = JSON.parse(await 工具.execute({ action: 'status' }, fakeExec({ name: 'mind' })));
      assert.equal(工具回复.成功, true);
      assert.equal(工具回复.数据.失联.已关闭, true);
      // 工作台的失联态是**四态字符串**（Batch 2 起）：关了就显示「已关闭」，
      // 而四态里根本没有「在位」这一种能给「关了」用的说法。
      const 工作台 = JSON.parse(await 工具.execute({ action: 'workbench' }, fakeExec({ name: 'mind' })));
      assert.equal(工作台.成功, true);
      assert.equal(工作台.数据.状态条.失联, '已关闭', '关了开关 ⇒ 状态条要说「已关闭」，不许说「已失联」也不许说「在位」');
    } finally {
      host.清理();
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
    }
  });

  // ⑦ 回归：模型**没有手**去改这个设置。判据是白名单式比对，不是禁词表。
  it('⑦ S4 工具面：schema 的 enum 与冻结清单逐一比对，且不含任何写设置的动作', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mind-presence-schema-'));
    const host = fakeHost();
    await kernel.apply(host.ctx, { home, factoryRoot: FACTORY, privateRoot: join(home, 'mind-private') });
    try {
      const 工具 = host.工具.get('mind');
      assert.ok(工具, 'mind 工具应已注册');
      const 枚举 = 工具.parameters.properties.action.enum;
      assert.ok(Array.isArray(枚举), '工具 schema 要给出 action 的 enum');
      // ① 白名单式：逐项等于冻结清单 —— 多了 / 少了 / 改了名，一律红。
      assert.deepEqual([...枚举], 冻结动作表, 'schema 的 enum 必须逐项等于冻结清单：任何新动作都要先过这一关');
      // ② 动作表本体也不许漂移：否则 schema 跟着 ACTIONS 一起变，两边都说自己对。
      assert.deepEqual([...ACTIONS], 冻结动作表, 'lib/actions.js 的 ACTIONS 也必须逐项等于冻结清单');
      // ②b 命令面专属清单 B（Batch 2）：工具面 = A，命令面 = A ∪ B。
      // B 里的动作**不许**混进工具面（schema enum / ACTIONS 两处都不许出现），
      // 而设置写动作只从命令面可达 —— 也就是「模型没有这只手」。
      assert.ok(Array.isArray(COMMAND_ONLY_ACTIONS) && COMMAND_ONLY_ACTIONS.length > 0, 'B（命令面专属清单）必须非空，否则这条断言测的是空气');
      for (const 动作 of COMMAND_ONLY_ACTIONS) {
        assert.ok(!冻结动作表.includes(动作), `命令面专属动作不许混进工具面冻结清单 A：${动作}`);
        assert.ok(!枚举.includes(动作), `工具 schema 的 enum 不许含命令面专属动作：${动作}`);
        assert.ok(!ACTIONS.includes(动作), `ACTIONS（工具面本体）也不许含命令面专属动作：${动作}`);
      }
      assert.deepEqual(
        [...new Set(COMMAND_ACTIONS)],
        [...冻结动作表, ...COMMAND_ONLY_ACTIONS],
        '命令面可达动作 = A ∪ B（多一个少一个都要红）',
      );
      assert.ok(枚举.includes('status'), '正对照：enum 里该有的动作要在');
      // ③ 匹配面放宽到**所有**带 action enum 的工具，不只是 mind。
      const 带动作的工具 = [...host.工具.entries()].filter(([, t]) => Array.isArray(t?.parameters?.properties?.action?.enum));
      assert.ok(带动作的工具.length >= 1, '至少要有一个带 action enum 的工具，否则这条断言测的是空气');
      for (const [名, t] of 带动作的工具) {
        for (const 动作 of t.parameters.properties.action.enum) {
          assert.ok(冻结动作表.includes(动作), `工具 ${名} 暴露了冻结清单外的动作：${动作}`);
        }
      }
      // ④ 白名单自身的体检：按语义面扫（写动词 × 设置名词），别指望某个词恰好被禁词表收着。
      const 设置写 = 冻结动作表.filter(
        (a) => /设置|setting|config|defaults|preference|presence/i.test(a) && /set|write|update|patch|put|delete|改|写|设/i.test(a),
      );
      assert.deepEqual(设置写, [], `动作表里出现疑似「写设置」的动作：${设置写.join(', ')}`);
      // ④b（Batch 2）B 里的设置写动作**只**从命令面可达：同样按语义面扫，再逐条真调一次工具面。
      const 命令面设置写 = COMMAND_ONLY_ACTIONS.filter((a) => /设置|setting|config|defaults|preference|presence/i.test(a));
      assert.ok(命令面设置写.length > 0, '命令面专属清单里必须真有一个设置写动作，否则 ④b 测的是空气');
      const org = await shareOrg({ home, factoryRoot: FACTORY, privateRoot: join(home, 'mind-private') });
      for (const 动作 of 命令面设置写) {
        await assert.rejects(
          () => runAction({ org, 项目: 'p', subject: { id: 'lead', kind: 'Lead' }, args: { action: 动作 } }),
          (error) => {
            assert.equal(error.name, 'Denied', `${动作}：工具面调用要抛 Denied`);
            assert.match(String(error.message), /命令面/, `${动作}：理由要说清「命令面专属」`);
            return true;
          },
          `${动作} 是设置写动作：工具面（模型侧）必须够不着`,
        );
      }
    } finally {
      host.清理();
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
    }
  });

  // ⑦b（2026-10-11 跑通测试 P3×3 回归）：schema 参数描述必须与 handler 真实口径一致。
  // 病灶：capability_read 只读 id、bus_send 正文参数真名是 内容、类型枚举未标注——
  // 按 schema 字面传参会必然失败且报错误导（「能力库里没有 undefined」「空消息不入总线」）。
  it('⑦b S4 工具面：争议参数描述与 handler 口径一致（id/名/内容/正文/类型）', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mind-presence-desc-'));
    const host = fakeHost();
    await kernel.apply(host.ctx, { home, factoryRoot: FACTORY, privateRoot: join(home, 'mind-private') });
    try {
      const props = host.工具.get('mind').parameters.properties;
      assert.match(props.id.description, /capability_read 按 id 读/, 'id 描述要点名 capability_read 按 id 读');
      assert.match(props.名.description, /capability_read 不读名/, '名 描述要警示 read 不读它');
      assert.match(props.内容.description, /bus_send/, '内容 描述要归属 bus_send');
      assert.match(props.正文.description, /capability_publish/, '正文 描述要归属 capability_publish');
      // 类型 枚举必须由 MESSAGE_TYPES 单源拼出：逐项一致 + 保留字警示在。
      const { MESSAGE_TYPES } = await import('../src/bus.js');
      assert.ok(
        props.类型.description.startsWith(`消息类型（bus_send）：${MESSAGE_TYPES.join('/')}`),
        `类型 描述的枚举要与 src/bus.js 的 MESSAGE_TYPES 逐项一致（手抄清单必漂）`,
      );
      assert.match(props.类型.description, /机制保留字/, '「系统」保留字警示要在');
    } finally {
      host.清理();
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
    }
  });

  // ⑧ D2 坏值不许静默：保护仍在（72），但读数必须说清「你写的值不合法、已退回」。
  it('⑧ D2 响应期限小时 是坏值（0 / -5 / "abc" / null）⇒ 仍按 72 判，读数标 值不合法 + 原值 + 来源', async () => {
    for (const 坏值 of [0, -5, 'abc', null]) {
      const g = await makeFixture({ presence: { 失联限制: true, 响应期限小时: 坏值 } });
      await 写身份(g, 100); // 100 小时未交互：> 72 ⇒ 必须仍判失联
      assert.equal(await g.policy.reload(), true, '坏值不是坏 JSON：引擎仍应健康');
      const p = g.policy.presence();
      const 标注 = JSON.stringify(坏值);
      assert.equal(p.生效响应期限小时, 72, `${标注}：坏值不许让失联保险失效，仍按内置兜底 72 判`);
      assert.equal(p.lost, true, `${标注}：100 小时 > 72 ⇒ 仍判失联`);
      assert.equal((await 自治写(g.policy)).verdict, 'deny', `${标注}：自治写仍被冻结`);
      assert.equal(p.值不合法, true, `${标注}：必须如实标注「你写的值不合法」，不许静默退回`);
      assert.deepEqual(p.原值, 坏值, '读数要附原值，别让人猜自己写的是什么');
      assert.equal(p.响应期限小时来源, '内置兜底', '生效值来自内置兜底：读数要说清是哪一层');
      assert.equal(p.原值来源, '出厂', '坏值是出厂层写的：要说清该去改哪一份');
      assert.match(String(p.不合法说明), /不合法/, '读数里要有可读的一句说明');
      assert.match(String(p.不合法说明), /退回/, '读数里要说明「已退回 72」，而不是只报个 false');
      await g.cleanup();
    }
  });

  // ⑨ D2 合法值：既生效，也标得出「生效值来自哪一层」（幽灵件就是来源不清长出来的）。
  it('⑨ D2 响应期限小时 168 ⇒ 生效 168，来源标明 出厂 / 私有 / 内置兜底', async () => {
    const 出厂 = await makeFixture({ presence: { 失联限制: true, 响应期限小时: 168 } });
    await 写身份(出厂, 100); // 100 < 168 ⇒ 不失联：证明生效的是 168，不是拿 72 顶的
    assert.equal(await 出厂.policy.reload(), true);
    assert.equal(出厂.policy.state.defaults.响应期限小时, 168, '168 必须真的进 defaults');
    assert.equal(出厂.policy.presence().生效响应期限小时, 168);
    assert.equal(出厂.policy.presence().lost, false, '100 小时 < 168 ⇒ 不失联');
    assert.equal(出厂.policy.presence().值不合法, false, '合法值不许被标成不合法');
    assert.equal(出厂.policy.presence().响应期限小时来源, '出厂', '生效值来自出厂区');
    assert.equal(出厂.policy.presence().失联限制来源, '出厂', '「失联限制」生效值来自哪一层也要标');

    // 私有层覆盖：同一条身份档案下 168 → 24（100 小时必须失联）——来源也要跟着变成「私有」。
    await 写部署偏好(出厂, { 响应期限小时: 24 });
    assert.equal(await 出厂.policy.reload(), true);
    assert.equal(出厂.policy.presence().生效响应期限小时, 24);
    assert.equal(出厂.policy.presence().响应期限小时来源, '私有', '主权者改的私有层要标成「私有」');
    assert.equal(出厂.policy.presence().失联限制来源, '出厂', '没被私有层压过的键仍标它的原层');
    assert.equal(出厂.policy.presence().lost, true, '24 小时期限 + 100 小时未交互 ⇒ 失联');
    await 出厂.cleanup();

    // 内置兜底层：出厂件**缺失**（不是坏）⇒ 退回内置默认，来源标「内置兜底」。
    const 兜底 = await makeFixture();
    await rm(join(兜底.factoryRoot, 夹具响应期限), { force: true });
    assert.equal(await 兜底.policy.reload(), true);
    const p = 兜底.policy.presence();
    assert.equal(p.生效响应期限小时, 72);
    assert.equal(p.响应期限小时来源, '内置兜底');
    assert.equal(p.失联限制来源, '内置兜底');
    assert.equal(p.值不合法, false, '缺失不是坏值：不许被标成「不合法」');
    await 兜底.cleanup();
  });

  // ⑩ C 纯文档键不许进运行态：`说明` 会随 status / 工作台序列化出去，看起来像一条能生效的设置。
  it('⑩ C 文档键「说明」不进运行态：state.defaults 只有运行键，且剔除不是静默丢弃', async () => {
    const 真件 = await readTextOrNull(出厂响应期限);
    assert.ok(真件, `正对照：仓库里的出厂件必须存在：${出厂响应期限}`);
    assert.ok('说明' in JSON.parse(真件), '正对照：仓库里的出厂件本来就带「说明」—— 否则这条断言测了个空气');
    const g = await makeFixture();
    await g.write(夹具响应期限, 真件); // 用真出厂件（带 说明）覆盖夹具件
    await 写部署偏好(g, { 响应期限小时: 72, 说明: '私有层也写了一段文档，它同样不该进运行态' });
    assert.equal(await g.policy.reload(), true);
    assert.ok(!('说明' in g.policy.state.defaults), '纯文档键不许进运行态（state.defaults）');
    assert.ok(!('说明' in g.policy.describe().defaults), 'describe() 给工作台的那份也不许带文档键');
    // 反向面：运行键必须还在 —— 别把整份都剔了当「干净」。
    assert.equal(g.policy.state.defaults.响应期限小时, 72, '私有层的运行键仍要生效');
    assert.equal(g.policy.state.defaults.失联限制, true);
    assert.equal(g.policy.state.defaults.介入度, '零参与');
    // 剔除不是静默丢弃：被剔掉的键名要能看见（写错键名的人否则会以为「设置生效了」）。
    assert.deepEqual(g.policy.describe().忽略的默认值键, ['说明'], '被剔除的文档键名要如实列出');
    await g.cleanup();
  });

  // ⑪ S6 私有最后覆盖是**全键统一**的次序：安全类也必须以私有那份为准。
  it('⑪ S6 私有 部署.json 的 安全类 压过出厂 安全类探针.json', async () => {
    const g = await makeFixture();
    // 反例面：没写私有那份时，生效的就是出厂探针声明。
    assert.deepEqual(
      g.policy.state.defaults.安全类,
      ['审计链', '闸在位', '出厂件洁净', '撤回名单一致'],
      '没写私有那份时，生效的是出厂声明',
    );
    await 写部署偏好(g, { 安全类: ['只留这一条'] });
    assert.equal(await g.policy.reload(), true);
    assert.deepEqual(g.policy.state.defaults.安全类, ['只留这一条'], '私有 部署.json 是最后覆盖层：安全类也以它为准');
    await g.cleanup();
  });

  // ⑫ S1 夹具不许静默失效：写下一个测试的人会踩「夹具设了没用」。
  it('⑫ S1 夹具 defaults 传「响应期限小时 / 失联限制」⇒ 直接抛错并指路 presence', async () => {
    for (const 键 of ['响应期限小时', '失联限制']) {
      await assert.rejects(
        () => makeFixture({ defaults: { [键]: 1 } }),
        (error) => {
          assert.match(String(error.message), /presence/, '错误里要指路：改用 presence 选项');
          assert.match(String(error.message), new RegExp(键), '错误里要点名是哪个键');
          return true;
        },
        `夹具必须响亮拒绝静默无效的写法：${键}`,
      );
    }
    // 反例面：合法写法照样能用（介入度走 defaults，响应期限走 presence）。
    const g = await makeFixture({ defaults: { 介入度: '事后抽检' }, presence: { 响应期限小时: 168 } });
    assert.equal(g.policy.intervention(), '事后抽检');
    assert.equal(g.policy.state.defaults.响应期限小时, 168);
    await g.cleanup();
  });

  // ⑬ S2 老部署遗留：介入度.json 里那份 响应期限小时 与 响应期限.json 冲突时，以后者为准。
  it('⑬ S2 介入度.json 遗留的 响应期限小时 以 响应期限.json 为准（有意为之的中间层次序）', async () => {
    const g = await makeFixture({
      rules: {
        '集体L2-共享基础设施/defaults/介入度.json': JSON.stringify({ 介入度: '变更预审', 响应期限小时: 999 }, null, 2),
      },
      presence: { 失联限制: true, 响应期限小时: 72 },
    });
    await 写身份(g, 100); // 999 生效 ⇒ 不失联；72 生效 ⇒ 失联
    assert.equal(await g.policy.reload(), true);
    assert.equal(g.policy.state.defaults.响应期限小时, 72, '同一层次序：响应期限.json 在 介入度.json 之后读 ⇒ 以它为准');
    assert.equal(g.policy.presence().lost, true, '行为面同上：生效的是 72，不是遗留的 999');
    assert.equal(g.policy.state.defaults来源.响应期限小时, '出厂', '生效值来自 响应期限.json（出厂层）');
    assert.equal(g.policy.presence().响应期限小时来源, '出厂', '读数里也要标出这一层');
    // 反例面：介入度.json 确实被读了 —— 否则上面那条可能只是「整个文件被忽略」。
    assert.equal(g.policy.intervention(), '变更预审', '介入度.json 里的 介入度 仍要生效');
    await g.cleanup();
  });

  // ⑭ S3 含糊值 fail-safe：严格 false 才算关；"false" / 0 / null 一律保持开着。
  it('⑭ S3 含糊值（"false" / 0 / null）⇒ 失联保险保持开着（fail-safe），不许被摘掉', async () => {
    for (const 含糊 of ['false', 0, null]) {
      const g = await makeFixture({ presence: { 失联限制: 含糊, 响应期限小时: 1 } });
      await 写身份(g, 30 * 24);
      assert.equal(await g.policy.reload(), true);
      const p = g.policy.presence();
      const 标注 = JSON.stringify(含糊);
      assert.notEqual(p.已关闭, true, `${标注} 是含糊值，不是严格 false ⇒ 不许当成「关了」`);
      assert.equal(p.lost, true, `${标注}：含糊值要保持保护（冻结照旧）`);
      assert.equal((await 自治写(g.policy)).verdict, 'deny', `${标注}：含糊值下自治写必须仍被冻结`);
      // 反例面：同一个夹具上改成严格 false，立刻变成「已关闭」—— 证明上面那几条不是恒真。
      await 写部署偏好(g, { 失联限制: false });
      assert.equal(await g.policy.reload(), true);
      assert.equal(g.policy.presence().已关闭, true);
      assert.equal((await 自治写(g.policy)).verdict, 'allow');
      await g.cleanup();
    }
  });

  // ⑮ D2 端到端：坏值要真的走到 `/mind status`（人敲的与模型调的是同一张动作表）。
  it('⑮ D2 坏值经 /mind status 看得见：生效 72 + 值不合法 + 原值 + 原值来源', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mind-presence-badvalue-'));
    const host = fakeHost();
    await kernel.apply(host.ctx, { home, factoryRoot: FACTORY, privateRoot: join(home, 'mind-private') });
    try {
      // 主权者在私有层写了个坏值（真实出厂件 + 真实装配路径）。
      await writeUnder(home, `mind-private/${部署偏好}`, JSON.stringify({ 失联限制: true, 响应期限小时: -5 }, null, 2));
      const org = await shareOrg({ home, factoryRoot: FACTORY, privateRoot: join(home, 'mind-private') });
      await org.policy.reload();

      const 回复 = await host.命令.get('mind').handler({ agent: {}, rawInput: 'status' });
      assert.equal(回复.kind, 'success', 回复.text);
      const 失联 = JSON.parse(回复.text).数据.失联;
      assert.equal(失联.生效响应期限小时, 72, '坏值不许让保护失效：仍按 72 判');
      assert.equal(失联.值不合法, true, '/mind status 要看得出「你写的值不合法」');
      assert.deepEqual(失联.原值, -5, '要附原值');
      assert.equal(失联.原值来源, '私有', '要说清坏值是哪一层写的（该去改哪个文件）');
      assert.equal(失联.响应期限小时来源, '内置兜底', '生效值来自内置兜底');
      assert.match(String(失联.不合法说明), /退回/, '读数里要有一句「已退回 72」');
      // 工具侧同一条路（人敲的与模型调的不维护第二份）。
      const 工具回复 = JSON.parse(await host.工具.get('mind').execute({ action: 'status' }, fakeExec({ name: 'mind' })));
      assert.equal(工具回复.成功, true);
      assert.equal(工具回复.数据.失联.值不合法, true);
      // 引擎自述（工作台装配时读的就是这一份）：真实出厂件里的 说明 不许进运行态。
      const 自述 = org.policy.describe();
      assert.ok(!('说明' in 自述.defaults), '真实出厂件里的 说明 不许进运行态');
      assert.deepEqual(自述.忽略的默认值键, ['说明'], '每个被剔掉的文档键都要点名');
      assert.equal(自述.defaults来源.响应期限小时, '私有', '来源要看得出生效值来自私有层');
    } finally {
      host.清理();
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
    }
  });
});
