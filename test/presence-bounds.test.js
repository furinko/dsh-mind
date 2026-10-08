/**
 * Batch 2.5 · 复核官挑出的必修项：`小时`的上界（F1）、读数不全时的 null 语义（F3）、
 * 注释与事实不符（F2）、内置兜底 72 的单源（S2）。
 *
 * 为什么每一条都要有：复核官的对抗性检验证明，本批的 `presence` 写入口在「合法的大整数」上
 * 会**先写盘、再炸、不入账**，而炸掉的是整条读数链（status / 工作台全废）——
 * 这正好违反 Batch 2 自己写的两条性质（非法值拒不写、无条件入账）。
 * 所以这里按 verify-integrity 的老规矩：每条断言先证明它能变红（红证据见
 * `E:\dsh-mind-backup\batch2.5-red-evidence.txt`，原始日志 `batch2-logs\*.log`）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeUnder } from './helpers.mjs';
import { listFiles, readTextOrNull } from '../src/kernel/fsx.js';
import { MAX_RESPONSE_DEADLINE_HOURS } from '../src/kernel/time.js';
import { projectWorkbench } from '../src/workbench.js';
import { fakeHost, fakeExec } from './host-harness.mjs';
import { shareOrg, forgetSharedOrg } from '../src/runtime.js';
import * as kernel from '../components/kernel/lib/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const FACTORY = join(ROOT, 'mind');
const 部署偏好 = '集体L2-共享基础设施/defaults/部署.json';
const 四态 = ['在位', '已失联', '已关闭', '未知'];
/** 复核官实测会炸的那两个值（都满足 `≥1 的整数`）。 */
const 越界值 = '99999999999';

const 前 = (小时) => new Date(Date.now() - 小时 * 3600_000).toISOString();

/** 起一个真装配的宿主（假宿主 + 真出厂件 + 临时私有区）。 */
async function 起宿主() {
  const home = await mkdtemp(join(tmpdir(), 'mind-bounds-'));
  const host = fakeHost();
  await kernel.apply(host.ctx, { home, factoryRoot: FACTORY, privateRoot: join(home, 'mind-private') });
  const org = await shareOrg({ home, factoryRoot: FACTORY, privateRoot: join(home, 'mind-private') });
  await org.policy.reload();
  return {
    home,
    host,
    org,
    命令: host.命令.get('mind'),
    工具: host.工具.get('mind'),
    文件: org.layout.deploymentPrefs(),
    写私有: (rel, text) => writeUnder(join(home, 'mind-private'), rel, text),
    清理: async () => {
      host.清理();
      forgetSharedOrg();
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
    },
  };
}

/** 敲一条 `/mind` 命令。 */
async function 敲(t, rawInput, agent = {}) {
  const 回复 = await t.命令.handler({ agent, rawInput });
  return { 回复, 包: JSON.parse(回复.text) };
}

/** 写一份「主权者写在同一个文件里」的内容，返回其原文本。 */
async function 放一份别的键(t) {
  const 文本 = JSON.stringify({ 介入度: '零参与', 说明: '这行不许被顺手改掉' }, null, 2) + '\n';
  await t.写私有(部署偏好, 文本);
  return 文本;
}

describe('Batch 2.5：presence 的上界 / 读数 null 语义 / 注释与单源', () => {
  // ── F1 上界：越界值必须被拒在前面，而且拒绝之后读数链还得能用 ─────────────────
  it('F1a 越界值（小时=99999999999）⇒ 拒绝 + 理由含合法区间 + 文件零字节改动', async () => {
    const t = await 起宿主();
    try {
      const 原份 = await 放一份别的键(t);
      const { 回复, 包 } = await 敲(t, `presence 小时=${越界值}`);
      assert.equal(回复.kind, 'error', `越界值必须被拒（实际：${回复.text}）`);
      assert.ok(['拒绝', '结构不合规'].includes(包.结果), `结果应是 拒绝/结构不合规，实际 ${包.结果}`);
      assert.match(String(包.理由), /小时/, '理由要点名是哪个键不合法');
      assert.match(String(包.理由), new RegExp(String(MAX_RESPONSE_DEADLINE_HOURS)), '理由要给出合法上界（就是那一份常量）');
      assert.equal(await readTextOrNull(t.文件), 原份, '越界值一个字节都不许写盘');
    } finally {
      await t.清理();
    }
  });

  it('F1b 越界值之后：策略仍健康，/mind status 与工作台仍然可用（读数链不废）', async () => {
    const t = await 起宿主();
    try {
      await 放一份别的键(t);
      assert.equal((await 敲(t, `presence 小时=${越界值}`)).包.成功, false, '前提：越界值确实被拒');
      assert.equal(t.org.policy.healthy, true, '策略引擎不许因为一次被拒的写入变成不健康');
      const 读数 = t.org.policy.presence();
      assert.equal(读数.值不合法, false, '引擎读数必须还能算出来');
      assert.equal(读数.生效响应期限小时, 72);

      const 状态 = await 敲(t, 'status');
      assert.equal(状态.包.成功, true, `/mind status 必须仍可用：${状态.回复.text}`);
      assert.equal(状态.包.数据.失联.值不合法, false);
      const 台 = await 敲(t, 'workbench');
      assert.equal(台.包.成功, true, `/mind workbench 必须仍可用：${台.回复.text}`);
      assert.ok(四态.includes(台.包.数据.状态条.失联), `状态条.失联 必须是四态之一，实际 ${台.包.数据.状态条.失联}`);
      // 模型侧同一条路：工具面读也得活着。
      const 工具回复 = JSON.parse(await t.工具.execute({ action: 'status' }, fakeExec({ name: 'mind' })));
      assert.equal(工具回复.成功, true, `mind{status} 必须仍可用：${JSON.stringify(工具回复)}`);
      const 工具台 = JSON.parse(await t.工具.execute({ action: 'workbench' }, fakeExec({ name: 'mind' })));
      assert.equal(工具台.成功, true, `mind{workbench} 必须仍可用：${JSON.stringify(工具台)}`);
      assert.ok(四态.includes(工具台.数据.状态条.失联));
    } finally {
      await t.清理();
    }
  });

  it('F1c 越界值也要入账（含拒绝原因）—— 不许静默', async () => {
    const t = await 起宿主();
    try {
      await 放一份别的键(t);
      assert.equal((await 敲(t, `presence 小时=${越界值}`)).包.成功, false);
      const 记录 = (await t.org.audit.read({})).filter((r) => r.动作 === '设置变更');
      assert.equal(记录.length, 1, `越界值的这次意图改设置必须入账一条，实际 ${记录.length} 条`);
      assert.match(String(记录[0].结果), /拒绝/, '结果要如实写「拒绝」');
      assert.match(String(记录[0].详情.拒绝理由), new RegExp(String(MAX_RESPONSE_DEADLINE_HOURS)), '账上要留下拒绝原因（含合法上界）');
      assert.notEqual(记录[0].主体.id, 'sovereign', '不冒充主权者');
      assert.equal((await t.org.audit.verify()).ok, true, '入账之后审计链必须仍自洽');
    } finally {
      await t.清理();
    }
  });

  it('F1d 边界：上界值收、上界+1 拒；且「拒绝」不许动盘上已有的值', async () => {
    const t = await 起宿主();
    try {
      assert.equal((await 敲(t, `presence 小时=${MAX_RESPONSE_DEADLINE_HOURS}`)).包.成功, true, '上界值本身是合法值');
      assert.equal(JSON.parse(await readTextOrNull(t.文件)).响应期限小时, MAX_RESPONSE_DEADLINE_HOURS);
      assert.equal(t.org.policy.presence().值不合法, false, '上界值不许被标成不合法');
      assert.equal(t.org.policy.presence().生效响应期限小时, MAX_RESPONSE_DEADLINE_HOURS);

      const 越 = await 敲(t, `presence 小时=${MAX_RESPONSE_DEADLINE_HOURS + 1}`);
      assert.equal(越.包.成功, false, `上界+1 必须被拒：${越.回复.text}`);
      assert.equal(JSON.parse(await readTextOrNull(t.文件)).响应期限小时, MAX_RESPONSE_DEADLINE_HOURS, '拒绝路径不许动盘上已有的值');

      // 上界本身也要经得起问：既不能小到把正常设置挡掉，也不能大到撞上 Date 的上界（8.64e15ms）。
      assert.ok(MAX_RESPONSE_DEADLINE_HOURS >= 24 * 365, `上界太小（${MAX_RESPONSE_DEADLINE_HOURS} 小时），正常设置会被误拒`);
      assert.ok(MAX_RESPONSE_DEADLINE_HOURS <= 2_400_000_000, `上界太大（${MAX_RESPONSE_DEADLINE_HOURS} 小时），会撞上 Date 上界 8.64e15ms`);
    } finally {
      await t.清理();
    }
  });

  it('F1e 单源：上界只在 src/kernel/time.js 写一份，lib/actions.js 引用它（无第二份字面量）', async () => {
    const 动作源码 = (await readTextOrNull(join(ROOT, 'lib', 'actions.js'))) ?? '';
    const 时间源码 = (await readTextOrNull(join(ROOT, 'src', 'kernel', 'time.js'))) ?? '';
    assert.match(时间源码, /export const MAX_RESPONSE_DEADLINE_HOURS/, '上界常量要住在 src/kernel/time.js（判据那一份）');
    assert.match(动作源码, /MAX_RESPONSE_DEADLINE_HOURS/, 'lib/actions.js 的写前校验必须引用同一份上界');
    assert.ok(!/876_?000/.test(动作源码), 'lib/actions.js 不许再写一份上界字面量（两处字面量迟早会漂）');
    assert.ok(!/响应期限小时:\s*72/.test(动作源码), 'lib/actions.js 也不许写死兜底 72');
  });

  it('F1f 文件里手写的越界值（不经入口）⇒ 读数不炸，按兜底 72 判，并如实标「不合法」', async () => {
    const t = await 起宿主();
    try {
      // 复核官的复现留下的正是这个状态：盘上已经有越界值。
      await t.写私有(部署偏好, JSON.stringify({ 失联限制: true, 响应期限小时: Number(越界值) }, null, 2));
      await t.写私有('身份档案/identity.json', JSON.stringify({ members: {}, sovereign: { lastInteraction: 前(100) }, denylist: [] }, null, 2));
      assert.equal(await t.org.policy.reload(), true);
      const 读数 = t.org.policy.presence();
      assert.equal(读数.值不合法, true, '越界值必须被标成不合法（不许静默当成生效值）');
      assert.equal(读数.生效响应期限小时, 72, '越界值退回内置兜底 72');
      assert.equal(读数.lost, true, '100 小时未交互 > 72 ⇒ 仍是失联（保护不失效）');
      assert.doesNotThrow(() => t.org.policy.presence(), '读数本身不许抛（一抛整条状态链全废）');

      const 状态 = await 敲(t, 'status');
      assert.equal(状态.包.成功, true, `/mind status 必须仍可用：${状态.回复.text}`);
      assert.equal(状态.包.数据.失联.值不合法, true);
      const 台 = (await 敲(t, 'workbench')).包.数据.状态条;
      assert.equal(台.失联, '已失联', '按退回后的 72 判，就是已失联');
      assert.equal(台.失联详情.值不合法, true);
      assert.equal(台.失联详情.原值, Number(越界值), '读数要带原值，别让人猜自己写的是什么');
    } finally {
      await t.清理();
    }
  });

  // 顺带加固（同向 fail-safe，不是复核官点名的条目）：身份档案里的坏时间戳同样会让 toIso 抛，
  // 那与 F1 是同一个「读数链全废」的后果，所以在同一处判据里一并堵住。
  it('F1g 身份档案里的坏时间戳 ⇒ 不炸，按「从未交互」判失联（fail-safe）', async () => {
    const t = await 起宿主();
    try {
      await t.写私有('身份档案/identity.json', JSON.stringify({ members: {}, sovereign: { lastInteraction: '说不清的时刻' }, denylist: [] }, null, 2));
      assert.equal(await t.org.policy.reload(), true);
      const 读数 = t.org.policy.presence();
      assert.equal(读数.lost, true, '查不到一次有效交互 ⇒ 按从未交互判失联（§12.2 查不到 ≠ 放行）');
      assert.equal(读数.since, null);
      assert.equal(读数.deadline, null);
      const 状态 = await 敲(t, 'status');
      assert.equal(状态.包.成功, true, `/mind status 不许因为一个坏时间戳就废掉：${状态.回复.text}`);
    } finally {
      await t.清理();
    }
  });

  // ── F3 读数不全 ⇒ 三个布尔必须是 null（不是 false）────────────────────────────
  it('F3a 读数形态读不出 ⇒ 四态「未知」且 详情.lost === null（{}/{lost:"false"}/{lost:0}）', async () => {
    for (const 失联 of [{}, { lost: 'false' }, { lost: 0 }, { lost: null }, '说不清']) {
      const 状态条 = projectWorkbench({ 项目: 'p', 策略: { 失联 } }).状态条;
      const 标注 = JSON.stringify(失联);
      assert.equal(状态条.失联, '未知', `${标注}：形态读不出 ⇒ 未知`);
      assert.equal(状态条.失联详情.lost, null, `${标注}：详情.lost 必须是 null —— false 会被消费者读成「在位」`);
      assert.equal(状态条.失联详情.已关闭, null, `${标注}：详情.已关闭 也读不出结论 ⇒ null`);
    }
  });

  it('F3b 完全没有策略读数 ⇒ 已关闭 / 值不合法 / lost 全是 null', async () => {
    const 详情 = projectWorkbench({ 项目: 'p' }).状态条.失联详情;
    assert.equal(projectWorkbench({ 项目: 'p' }).状态条.失联, '未知');
    assert.equal(详情.已关闭, null, '没读数 ⇒ 已关闭 是 null（不是 false）');
    assert.equal(详情.值不合法, null, '没读数 ⇒ 值不合法 是 null（不是 false）');
    assert.equal(详情.lost, null);
    assert.equal(详情.读数, '缺失');
  });

  it('F3c 四态与详情必须互相一致：未知 ⇒ lost 为 null；其余 ⇒ lost 是布尔', async () => {
    const 样本 = [{}, { lost: false }, { lost: true }, { 已关闭: true, lost: false }, { lost: 'false' }, { lost: 1 }];
    for (const 失联 of 样本) {
      const 状态条 = projectWorkbench({ 项目: 'p', 策略: { 失联 } }).状态条;
      const 标注 = JSON.stringify(失联);
      if (状态条.失联 === '未知') {
        assert.equal(状态条.失联详情.lost, null, `${标注}：四态说未知，详情不许给一个布尔`);
      } else {
        assert.equal(typeof 状态条.失联详情.lost, 'boolean', `${标注}：四态有结论，详情.lost 就得是布尔`);
        assert.equal(状态条.失联详情.读数, 状态条.失联, `${标注}：详情的「读数」与状态条同一句话`);
      }
    }
  });

  it('F3d 反例面：真读数照样给真布尔（别为了 null 把正常路径也变成 null）', async () => {
    const t = await 起宿主();
    try {
      const 真 = (await 敲(t, 'status')).包.数据.失联;
      const 详情 = projectWorkbench({ 项目: 'p', 策略: { 失联: 真 } }).状态条.失联详情;
      assert.equal(详情.lost, false, '有读数且明确没失联 ⇒ false（不是 null）');
      assert.equal(详情.已关闭, false, '有读数且开关没关 ⇒ false（不是 null）');
      assert.equal(详情.值不合法, false);
      assert.equal(详情.生效响应期限小时, 72);
    } finally {
      await t.清理();
    }
  });

  // ── F2 注释与事实：把「行为面 no-op」钉成可测事实 ─────────────────────────────
  it('F2 运行态 `安全类` 这一格当前没有消费者（合并序调整在行为面是 no-op）', async () => {
    // 只扫**代码**（注释里当然会提到这个字段名 —— 刚写的事实说明就在注释里）。
    const 去注释 = (文本) => 文本.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const 消费者 = [];
    for (const dir of ['src', 'lib']) {
      for (const rel of await listFiles(join(ROOT, dir), { recursive: true, filter: (n) => n.endsWith('.js') })) {
        const 文本 = 去注释((await readTextOrNull(join(ROOT, dir, rel))) ?? '');
        if (/defaults\??\.安全类/.test(文本)) 消费者.push(`${dir}/${rel}`);
      }
    }
    assert.deepEqual(消费者, [], `运行态 安全类 出现了消费者：${消费者.join(', ')} —— 那就不再是 no-op，注释要跟着改`);
  });

  it('F2b 不实注释必须改掉：policy.js / paths.js 里不许再写「私有 安全类 压不过出厂声明」', async () => {
    const 策略源码 = (await readTextOrNull(join(ROOT, 'src', 'policy.js'))) ?? '';
    const 路径源码 = (await readTextOrNull(join(ROOT, 'src', 'paths.js'))) ?? '';
    for (const [名, 源码] of [['src/policy.js', 策略源码], ['src/paths.js', 路径源码]]) {
      assert.ok(!/压不过出厂声明/.test(源码), `${名}：旧注释与 HEAD 实现不符（复核官逐行核过），必须改成事实`);
      assert.match(源码, /no-op|无消费者/, `${名}：要如实标注「安全类 这一格当前无消费者 ⇒ 行为面 no-op」`);
    }
  });

  // ── S2 单源：内置兜底 72 只有一份字面量 ───────────────────────────────────────
  it('S2 内置兜底 72 只有一份：src/policy.js 引用 BUILTIN_RESPONSE_DEADLINE_HOURS', async () => {
    const 策略源码 = (await readTextOrNull(join(ROOT, 'src', 'policy.js'))) ?? '';
    assert.match(策略源码, /BUILTIN_RESPONSE_DEADLINE_HOURS/, '兜底值要引用 src/kernel/time.js 那一份常量');
    assert.ok(!/响应期限小时:\s*72/.test(策略源码), '不许在 src/policy.js 里再写死一份 72');
  });
});
