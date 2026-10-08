/**
 * `presence` 设置入口（**命令面专属**）与状态条四态。
 *
 * 这一组用例守的是两件事：
 *  1. 主权者**有个能敲的入口**去改「失联限制 / 响应期限小时」—— 改完立刻生效、
 *     是 merge 写（不丢别的键）、非法值被拒且一个字节都不写、每次意图改设置都入账；
 *  2. 工作台的 `状态条.失联` 从布尔变成**四态字符串**——「关了」必须显示成「已关闭」，
 *     不许显示成「在位」（Batch 1.5 记下的那条真缺陷），而**读不到策略读数**是「未知」。
 *
 * 每条断言都先证明它能变红：本轮 ①-⑧ 全部是天然红（实现之前跑，逐条报错），
 * 红/绿原始日志见 `E:\dsh-mind-backup\batch2-red-evidence.txt` 与 `batch2-logs\*.log`。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeUnder } from './helpers.mjs';
import { readTextOrNull } from '../src/kernel/fsx.js';
import { ACTIONS, COMMAND_ONLY_ACTIONS, COMMAND_ACTIONS, runAction } from '../lib/actions.js';
import { projectWorkbench } from '../src/workbench.js';
import { fakeHost, fakeExec } from './host-harness.mjs';
import { shareOrg, forgetSharedOrg } from '../src/runtime.js';
import * as kernel from '../components/kernel/lib/index.js';

const here = dirname(fileURLToPath(import.meta.url));
/** 出厂区：走**仓库里的真文件**（不是夹具），这样测的是真装配路径。 */
const FACTORY = join(here, '..', 'mind');
/** 私有部署偏好（叠加层，最后覆盖出厂）——`Layout.deploymentPrefs()` 的相对形状。 */
const 部署偏好 = '集体L2-共享基础设施/defaults/部署.json';
/** 状态条.失联 的封闭四态。 */
const 四态 = ['在位', '已失联', '已关闭', '未知'];

/** 相对现在的小时数 → ISO 串。 */
const 前 = (小时) => new Date(Date.now() - 小时 * 3600_000).toISOString();

/**
 * 起一个真装配的宿主（假宿主 + 真出厂件 + 临时私有区）。
 * @returns {Promise<{ home: string, host: any, org: any, 命令: any, 工具: any, 文件: string, 清理: () => Promise<void> }>}
 */
async function 起宿主() {
  const home = await mkdtemp(join(tmpdir(), 'mind-presence-cmd-'));
  const host = fakeHost();
  await kernel.apply(host.ctx, { home, factoryRoot: FACTORY, privateRoot: join(home, 'mind-private') });
  const org = await shareOrg({ home, factoryRoot: FACTORY, privateRoot: join(home, 'mind-private') });
  await org.policy.reload();
  const 文件 = org.layout.deploymentPrefs();
  return {
    home,
    host,
    org,
    命令: host.命令.get('mind'),
    工具: host.工具.get('mind'),
    文件,
    写私有: (rel, text) => writeUnder(join(home, 'mind-private'), rel, text),
    清理: async () => {
      host.清理();
      forgetSharedOrg();
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
    },
  };
}

/** 敲一条 `/mind` 命令，返回解析后的包（顺带断言「成功」）。 */
async function 敲(t, rawInput, agent = {}) {
  const 回复 = await t.命令.handler({ agent, rawInput });
  return { 回复, 包: JSON.parse(回复.text) };
}

/** 工作台投影（走真装配，跟面板读的是同一份）。 */
async function 看状态条(t) {
  const { 包 } = await 敲(t, 'workbench');
  assert.equal(包.成功, true, JSON.stringify(包));
  return 包.数据.状态条;
}

describe('presence 设置入口：命令面专属 + 状态条四态', () => {
  // ① 读命令 + 写命令 ⇒ 私有 部署.json 出现两个键，presence() 立刻读到新值。
  it('① 写命令 ⇒ 私有 部署.json 出现 失联限制/响应期限小时，且 presence() 立刻读到新值', async () => {
    const t = await 起宿主();
    try {
      // 前提：私有区还没有这份文件（目录已由引导建好）—— 不存在 ≠ 不能写。
      assert.equal(await readTextOrNull(t.文件), null, '前提：私有区初始没有 部署.json');

      // 读：不带参数 ⇒ 只回报当前生效读数，不改任何东西。
      const 读 = await 敲(t, 'presence');
      assert.equal(读.包.成功, true, 读.回复.text);
      assert.equal(读.包.读数.生效响应期限小时, 72, '读命令要给出当前生效读数（出厂 72）');
      assert.equal(读.包.读数.响应期限小时来源, '出厂');
      assert.equal(读.包.读数.失联限制来源, '出厂');
      assert.equal(读.包.读数.值不合法, false);
      assert.equal(await readTextOrNull(t.文件), null, '纯读命令不许落盘');

      // 写：键名就是人敲的那两个。
      const 写 = await 敲(t, 'presence 开关=否 小时=168');
      assert.equal(写.包.成功, true, 写.回复.text);
      const 文件 = JSON.parse(await readTextOrNull(t.文件));
      assert.equal(文件.失联限制, false, '开关=否 ⇒ 私有 部署.json 里是 false');
      assert.equal(文件.响应期限小时, 168, '小时=168 ⇒ 私有 部署.json 里是 168');

      const 读数 = t.org.policy.presence();
      assert.equal(读数.已关闭, true, '写命令之后 presence() 立刻读到「关了」');
      assert.equal(读数.生效响应期限小时, 168, '写命令之后 presence() 立刻读到 168');
      assert.equal(读数.响应期限小时来源, '私有', '生效值来自私有层');
      assert.equal(读数.失联限制来源, '私有');

      // 反例面：写回去，同一处读数必须跟着变（证明上面那条不是恒真）。
      assert.equal((await 敲(t, 'presence 开关=是 小时=24')).包.成功, true);
      assert.notEqual(t.org.policy.presence().已关闭, true, '开关=是 ⇒ 不再是「已关闭」');
      assert.equal(t.org.policy.presence().生效响应期限小时, 24);
      // 宽容输入、严格落盘：`是` / `true` 两种写法都落成**布尔**。
      assert.equal((await 敲(t, 'presence 开关=true')).包.成功, true);
      assert.equal(JSON.parse(await readTextOrNull(t.文件)).失联限制, true, '布尔要落成布尔，不许把字符串 "true" 写进设置文件');

      // 目录/文件不存在要自己新建（Batch 1.5 的 README 承诺）。
      await rm(dirname(t.文件), { recursive: true, force: true });
      const 再写 = await 敲(t, 'presence 小时=48');
      assert.equal(再写.包.成功, true, 再写.回复.text);
      assert.equal(JSON.parse(await readTextOrNull(t.文件)).响应期限小时, 48, '目录不存在 ⇒ 自己新建');
    } finally {
      await t.清理();
    }
  });

  // ② merge 写：只覆盖两个键，别的键一个不许丢。
  it('② merge：先手工放别的键（介入度 / 安全类），写设置后它们还在', async () => {
    const t = await 起宿主();
    try {
      await t.写私有(部署偏好, JSON.stringify({ 介入度: '事后抽检', 安全类: ['只留这一条'] }, null, 2));
      const 写 = await 敲(t, 'presence 开关=否 小时=168');
      assert.equal(写.包.成功, true, 写.回复.text);
      const 文件 = JSON.parse(await readTextOrNull(t.文件));
      assert.equal(文件.介入度, '事后抽检', '别的键（介入度）不许被写设置顺手丢掉');
      assert.deepEqual(文件.安全类, ['只留这一条'], '别的键（安全类）也不许丢');
      assert.equal(文件.失联限制, false);
      assert.equal(文件.响应期限小时, 168);
      // 生效面同一条：merge 之后私有层的其它键照样生效（不是「文件里还在、读的时候没了」）。
      assert.equal(t.org.policy.intervention(), '事后抽检');
    } finally {
      await t.清理();
    }
  });

  // ③ 非法值 ⇒ 拒绝（理由含合法取值），且文件没被改（一个字节都不写）。
  it('③ 非法值（小时=0 / 小时=abc / 开关=也许）⇒ 拒绝 + 理由里含合法取值 + 文件未被改', async () => {
    const t = await 起宿主();
    try {
      const 用例 = [
        { 输入: 'presence 小时=0', 理由: /≥1 的整数/, 标注: '0 不是 ≥1 的整数' },
        { 输入: 'presence 小时=abc', 理由: /≥1 的整数/, 标注: 'abc 不是整数' },
        { 输入: 'presence 开关=也许', 理由: /(是|否)/, 标注: '也许 不是 是/否' },
      ];
      for (const c of 用例) {
        // 每次先在盘上放一份「主权者写的东西」，用来证明拒绝路径真的没碰它。
        const 原份 = JSON.stringify({ 介入度: '零参与', 其它: '不许动' }, null, 2) + '\n';
        await t.写私有(部署偏好, 原份);
        const { 回复, 包 } = await 敲(t, c.输入);
        assert.equal(回复.kind, 'error', `${c.标注}：必须被拒（${回复.text}）`);
        assert.ok(['拒绝', '结构不合规'].includes(包.结果), `${c.标注}：结果应是 拒绝/结构不合规，实际 ${包.结果}`);
        assert.match(String(包.理由), c.理由, `${c.标注}：理由里要说清合法取值`);
        assert.match(String(包.理由), /(开关|小时)/, `${c.标注}：理由里要点名是哪个键不合法`);
        assert.equal(await readTextOrNull(t.文件), 原份, `${c.标注}：拒绝路径不许改文件（逐字节相同）`);
      }
      // 反例面：文件根本不存在时，非法值也不许把它创建出来。
      await rm(t.文件, { force: true });
      const { 包: 空 } = await 敲(t, 'presence 小时=0');
      assert.equal(空.成功, false, '非法值必须被拒');
      assert.equal(await readTextOrNull(t.文件), null, '拒绝路径不许新建文件');
      // 正对照：合法取值照样能过 —— 证明上面三条拒的不是「写设置」这件事本身。
      assert.equal((await 敲(t, 'presence 小时=1')).包.成功, true);
      assert.equal(JSON.parse(await readTextOrNull(t.文件)).响应期限小时, 1);
      // 读不懂的文件也不许被覆盖：覆盖 = 替主权者把里面写的东西删了。
      const 坏文件 = '{ "介入度": "零参与"，这不是 JSON';
      await t.写私有(部署偏好, 坏文件);
      const 坏 = await 敲(t, 'presence 小时=168');
      assert.equal(坏.包.成功, false, '读不懂的 部署.json ⇒ 拒写');
      assert.match(String(坏.包.理由), /部署\.json/, '理由要点名是哪份文件读不懂');
      assert.equal(await readTextOrNull(t.文件), 坏文件, '读不懂的文件一个字节都不许被覆盖');
      // 这次拒绝也要留痕（拒绝路径同样是「意图改设置」）。
      const 拒绝记录 = (await t.org.audit.read({})).filter((r) => r.动作 === '设置变更' && /拒绝/.test(String(r.结果)));
      assert.ok(拒绝记录.length >= 1, `拒绝路径必须入账，实际：${JSON.stringify(拒绝记录)}`);
    } finally {
      await t.清理();
    }
  });

  // ④ 无条件入账：每次意图改设置都留一条，含原值→新值 + 真实主体。
  it('④ 每次写动作都入账（含原值→新值、真实主体，且不冒充主权者）', async () => {
    const t = await 起宿主();
    try {
      // 用一个**非 Lead、非主权者**的会话身份来敲：账上要记这个真实主体。
      const agent = { session: { id: 'abcd1234-0000-4000-8000-000000000000', header: { cwd: t.home } } };
      const 设置记录 = async () => (await t.org.audit.read({})).filter((r) => r.动作 === '设置变更');

      assert.deepEqual(await 设置记录(), [], '前提：动手之前没有 设置变更 记录');

      const 首次 = await 敲(t, 'presence 小时=168', agent);
      assert.equal(首次.包.成功, true, 首次.回复.text);
      const 一 = await 设置记录();
      assert.equal(一.length, 1, '写动作必须入账（无条件）');
      assert.equal(一[0].主体.id, 'session-abcd1234', '账上要记**真实主体**（敲命令的那个人）');
      assert.notEqual(一[0].主体.id, 'sovereign', '不许冒充主权者');
      assert.notEqual(一[0].主体.kind, '主权者', '不许冒充主权者');
      assert.equal(一[0].主体.kind, 'Lead', '根会话的执行者按约定是 Lead');
      assert.match(String(一[0].依据), /设置入口/, '依据要写明这是设置入口');
      assert.equal(一[0].详情.键.响应期限小时.原值, null, '首次写入：原值是「没有」');
      assert.equal(一[0].详情.键.响应期限小时.新值, 168, '账上要有新值');
      assert.equal(一[0].详情.键.响应期限小时.变更, true);
      assert.equal(一[0].详情.键.失联限制, undefined, '没被这次动作改的键不许出现在变更里');

      // 原值与新值相同：照样入账，但盘上一个字节都不许变。
      const 写前 = await readTextOrNull(t.文件);
      const 二次 = await 敲(t, 'presence 小时=168', agent);
      assert.equal(二次.包.成功, true, 二次.回复.text);
      const 二 = await 设置记录();
      assert.equal(二.length, 2, '原值与新值相同的场合也要入账（无条件）');
      assert.equal(二[1].详情.键.响应期限小时.变更, false, '无变更要如实标成 false');
      assert.equal(await readTextOrNull(t.文件), 写前, '无变更 ⇒ 不写盘（逐字节相同）');
      // 审计链自检：新记的这几条不许把账本弄坏。
      assert.equal((await t.org.audit.verify()).ok, true, '入账之后审计链必须仍自洽');
    } finally {
      await t.清理();
    }
  });

  // ⑤ 两侧清单：工具面没有这只手，命令面有。
  it('⑤ 工具 schema 的 enum 不含 presence；命令面能用它（两侧都断言）', async () => {
    const t = await 起宿主();
    try {
      const 枚举 = t.工具.parameters.properties.action.enum;
      assert.ok(Array.isArray(枚举), '工具 schema 要给出 action 的 enum');
      assert.ok(!枚举.includes('presence'), '工具 schema 不许暴露 presence：模型没有这只手');
      assert.ok(!ACTIONS.includes('presence'), 'ACTIONS（工具面本体）也不许含 presence');
      assert.ok(COMMAND_ONLY_ACTIONS.includes('presence'), 'presence 必须在「命令面专属」清单里');
      assert.deepEqual([...new Set(COMMAND_ACTIONS)], [...ACTIONS, ...COMMAND_ONLY_ACTIONS].filter((a, i, all) => all.indexOf(a) === i), '命令面 = 工具面 ∪ 命令面专属');

      // 反例面（工具面）：就算有人绕过 enum 直接调，动作表也必须拒。
      const 工具回复 = JSON.parse(await t.工具.execute({ action: 'presence' }, fakeExec({ name: 'mind' })));
      assert.equal(工具回复.成功, false, '工具面调用 presence 必须失败');
      assert.equal(工具回复.结果, '拒绝', `工具面的拒绝要可读：${JSON.stringify(工具回复)}`);
      assert.match(String(工具回复.理由), /命令面/, '理由要说清「这是命令面专属」');

      // 直接走动作表（不经 schema）也必须拒：默认面 = 工具面。
      await assert.rejects(
        () => runAction({ org: t.org, 项目: 'p', subject: { id: 'lead', kind: 'Lead' }, args: { action: 'presence' } }),
        (error) => {
          assert.equal(error.name, 'Denied', '要抛 Denied（判定完成的拒绝），不是别的错');
          assert.match(String(error.message), /命令面/, '理由要可执行：这是命令面专属动作');
          return true;
        },
        '动作表本体也要挡：schema 的 enum 不是唯一一道闸',
      );

      // 正例面（命令面）：人能敲，且真的能改。
      const { 回复, 包 } = await 敲(t, 'presence 开关=否');
      assert.equal(回复.kind, 'success', 回复.text);
      assert.equal(包.成功, true);
      assert.equal(t.org.policy.presence().已关闭, true, '命令面这一侧是真能改的（不是「两侧都不能用」）');
    } finally {
      await t.清理();
    }
  });

  // ⑥ 四态 + 失联详情。
  it('⑥ 四态：关了⇒已关闭 / 未关未超期⇒在位 / 超期⇒已失联 / 无策略读数⇒未知（+ 失联详情带出标记）', async () => {
    const t = await 起宿主();
    try {
      // 未知：上层没给策略读数（宿主没给 ≠ 正常）。
      assert.equal(projectWorkbench({ 项目: 'p' }).状态条.失联, '未知', '没有策略读数 ⇒ 未知');
      assert.equal(projectWorkbench({ 项目: 'p', 策略: {} }).状态条.失联, '未知', '空策略对象 ⇒ 未知');
      const 无读数详情 = projectWorkbench({ 项目: 'p' }).状态条.失联详情;
      assert.equal(无读数详情.读数, '缺失', '没读数时要如实说「缺失」，不许编一个在位');

      // 在位：主权者刚启动过（引导会落一次交互），开关未关、未超期。
      const 在位 = await 看状态条(t);
      assert.equal(在位.失联, '在位', '没关也没超期 ⇒ 在位');
      const 在位详情 = 在位.失联详情;
      assert.equal(在位详情.读数, '在位');
      assert.equal(在位详情.lost, false);
      assert.equal(在位详情.生效响应期限小时, 72, '详情要带出生效期限（别再让它烂在 describe() 里）');
      assert.equal(在位详情.响应期限小时来源, '出厂');
      assert.equal(在位详情.失联限制来源, '出厂');
      assert.equal(在位详情.值不合法, false);
      assert.equal(typeof 在位详情.hours, 'number');

      // 已失联：期限 1 小时 + 最后一次交互在 30 天前（走真装配路径重载身份档案）。
      await t.写私有(部署偏好, JSON.stringify({ 失联限制: true, 响应期限小时: 1 }, null, 2));
      await t.写私有('身份档案/identity.json', JSON.stringify({ members: { lead: { id: 'lead', 岗位: 'Lead', status: '在岗' } }, sovereign: { lastInteraction: 前(30 * 24) }, denylist: [] }, null, 2));
      assert.equal(await t.org.policy.reload(), true);
      const 超期 = await 看状态条(t);
      assert.equal(超期.失联, '已失联', '1 小时期限 + 30 天未交互 ⇒ 已失联');
      assert.equal(超期.失联详情.读数, '已失联');

      // 已关闭：只由 presence().已关闭 === true 触发。
      assert.equal((await 敲(t, 'presence 开关=否 小时=1')).包.成功, true);
      const 关闭 = await 看状态条(t);
      assert.equal(关闭.失联, '已关闭', '关了开关 ⇒ 四态里是「已关闭」');
      assert.equal(关闭.失联详情.读数, '已关闭');

      // 坏值：读数标「不合法」并把原值带出来（详情里也要有）。
      await t.写私有(部署偏好, JSON.stringify({ 失联限制: true, 响应期限小时: -5 }, null, 2));
      assert.equal(await t.org.policy.reload(), true);
      const 坏值 = (await 看状态条(t)).失联详情;
      assert.equal(坏值.值不合法, true, '坏值要在详情里如实标注');
      assert.equal(坏值.原值, -5, '详情要附原值，别让人猜自己写的是什么');
      assert.equal(坏值.生效响应期限小时, 72, '坏值生效成 72：详情要报生效值');
      assert.equal(坏值.响应期限小时来源, '内置兜底');

      // 四态是封闭集合：任何一份投影里都不许出现第五种说法。
      for (const 策略 of [{}, { 失联: { lost: false } }, { 失联: { lost: true } }, { 失联: { 已关闭: true, lost: false } }, { 失联: '说不清' }]) {
        assert.ok(四态.includes(projectWorkbench({ 项目: 'p', 策略 }).状态条.失联), `投影给出的失联态必须在四态内：${JSON.stringify(策略)}`);
      }
    } finally {
      await t.清理();
    }
  });

  // ⑦ 真缺陷的正面反例：关了 + 超期 30 天，仍必须是「已关闭」。
  it('⑦ 关了 + 超期 30 天 ⇒ 仍是「已关闭」（不许显示成「在位」）', async () => {
    const t = await 起宿主();
    try {
      await t.写私有(部署偏好, JSON.stringify({ 失联限制: false, 响应期限小时: 1 }, null, 2));
      await t.写私有('身份档案/identity.json', JSON.stringify({ members: { lead: { id: 'lead', 岗位: 'Lead', status: '在岗' } }, sovereign: { lastInteraction: 前(30 * 24) }, denylist: [] }, null, 2));
      assert.equal(await t.org.policy.reload(), true);
      assert.equal(t.org.policy.presence().已关闭, true, '前提：开关确实是关的');
      assert.equal(t.org.policy.presence().lost, false, '关了就不冻结');

      const 状态条 = await 看状态条(t);
      assert.equal(状态条.失联, '已关闭', '关了 + 超期 30 天：仍要如实说「已关闭」，绝不许说「在位」也不许说「已失联」');
      assert.notEqual(状态条.失联, '在位', '把「关了」显示成「在位」就是本批要修的那条真缺陷');
      assert.equal(状态条.失联详情.已关闭, true, '详情里要能看出这是「关了」而不是「一直在位」');

      // 反例面：同一份身份档案下把开关打开，立刻变成「已失联」—— 证明上面那条不是恒真。
      assert.equal((await 敲(t, 'presence 开关=是')).包.成功, true);
      assert.equal((await 看状态条(t)).失联, '已失联', '开关打开后，同一份 30 天未交互的档案 ⇒ 已失联');
    } finally {
      await t.清理();
    }
  });

  // ⑧ 不是 replace 整份文件：除两个设置键外逐字节不变（含键序）。
  it('⑧ 写动作不 replace 整份文件：除两个设置键外内容逐字节不变', async () => {
    const t = await 起宿主();
    try {
      const 原份 = {
        介入度: '事后抽检',
        安全类: ['审计链', '闸在位'],
        嵌套: { a: [1, 2, { b: 'x' }], c: null },
        说明: '主权者手写的文档键',
        失联限制: true,
        响应期限小时: 72,
      };
      const 原文本 = JSON.stringify(原份, null, 2) + '\n';
      await t.写私有(部署偏好, 原文本);
      const 写前 = await readTextOrNull(t.文件);

      assert.equal((await 敲(t, 'presence 小时=168')).包.成功, true);
      const 写后 = await readTextOrNull(t.文件);
      const 去设置键 = (文本) => 文本.split('\n').filter((行) => !/^\s*"(失联限制|响应期限小时)":/.test(行));
      assert.deepEqual(去设置键(写后), 去设置键(写前), '除两个设置键外，其余行要逐字节不变（含键序）');
      const 写后对象 = JSON.parse(写后);
      assert.equal(写后对象.响应期限小时, 168, '改的那个键要真的改到');
      assert.equal(写后对象.失联限制, true, '没被这次动作碰的键要保持原值（不是从出厂重算）');
      assert.deepEqual(写后对象.嵌套, 原份.嵌套, '嵌套结构原样保留');
      assert.deepEqual(Object.keys(写后对象), Object.keys(原份), '键序不许被重排');

      // 另一头：写一份**只有**两个键的陌生文件，其余键不许被凭空补进来自出厂。
      await t.写私有(部署偏好, JSON.stringify({ 失联限制: true }, null, 2) + '\n');
      assert.equal((await 敲(t, 'presence 小时=24')).包.成功, true);
      const 薄 = JSON.parse(await readTextOrNull(t.文件));
      assert.deepEqual(Object.keys(薄).sort(), ['响应期限小时', '失联限制'], '写动作只写它该写的两个键，不替主权者补别的');
    } finally {
      await t.清理();
    }
  });
});
