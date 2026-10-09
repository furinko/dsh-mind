/**
 * W3 批4 · 收口（2026-10-09）——写侧往返闭合 + 四条门禁。
 *
 * 复核挖出的**真缺陷**：`formatFrontMatter`（写侧）从不引号化，而 `unquote`（读侧）会剥引号、
 * 切注释、切数组 ⇒ 自由文本里的 ` # `、行首 `#`、逗号、引号一律**写-读往返不闭合且静默**
 * （errors 为空）。本文件把「闭合」钉成断言，并钉住**普通值逐字节不变**（出厂件不许漂移）。
 *
 * 四条门禁（只加测试，实现不改——除真缺陷那一处）：
 *  a. 依赖校验在**锁内**（另一个写者持锁、后期才落线依赖节点 ⇒ 必须等到锁释放后放行）
 *  b. 归档被拒 ⇒ 节点不许显示已结账（事件流里也不许有 settled）
 *  c. workbench 未交齐时不投影零分歧，但**内部判定仍是全量答案现算**
 *  d. 设置页轮询序号（在 client-harness 里，见那条 ⑥c）
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { appendLines, listFiles, readTextOrNull, sleep, withLock } from '../src/kernel/fsx.js';
import { formatFrontMatter, parseDocument, parseSimpleYaml } from '../src/tags.js';
import { makeFixture, LEAD, MEMBER, REVIEWER, SOVEREIGN } from './helpers.mjs';
import { Clock } from '../src/kernel/time.js';
import { AuditLog } from '../src/audit.js';
import { PolicyEngine } from '../src/policy.js';
import { TaskGraph } from '../src/tasks.js';
import { MemoryService } from '../src/memory.js';
import { CapabilityLibrary } from '../src/capability.js';
import { MessageBus } from '../src/bus.js';
import { ReviewProtocol } from '../src/review.js';
import { Denied } from '../src/kernel/errors.js';
import { projectWorkbench } from '../src/workbench.js';
import { judgeZeroDivergence } from '../src/review.js';

const P = 'w3d-proj';

/** 一套装配好的内核件。 */
async function 装配(f) {
  const clock = f.clock ?? new Clock();
  const audit = f.audit ?? new AuditLog({ layout: f.layout, clock });
  const policy = f.policy ?? new PolicyEngine({ layout: f.layout, clock, audit });
  if (!f.policy) await policy.reload();
  const memory = new MemoryService({ layout: f.layout, policy, audit, clock });
  const tasks = new TaskGraph({ layout: f.layout, policy, audit, clock, memory });
  const bus = new MessageBus({ layout: f.layout, policy, audit, clock });
  const review = new ReviewProtocol({ layout: f.layout, policy, audit, clock, tasks, bus, random: () => 0 });
  const capability = new CapabilityLibrary({ layout: f.layout, policy, audit, clock });
  return { layout: f.layout, policy, audit, clock, memory, tasks, bus, review, capability };
}

/** front matter 文本 → meta（走真解析入口，不另写一份规则）。 */
function 读回(文本) {
  const 块 = 文本.slice(4, 文本.indexOf('\n---', 3) + 1);
  return parseSimpleYaml(块).data;
}

describe('W3 批4 · 写-读往返闭合', () => {
  it('①formatFrontMatter 需要时才引号化：四实证 + 边界全闭合，普通值不动', () => {
    const 例 = [
      { 名: '甲 # 乙' }, // 复核实证①：`#` 被当行内注释切掉
      { 摘要: '# 标题式值' }, // 复核实证②：行首 `#` ⇒ 读成空列表
      { 标签: ['a,b', 'c'] }, // 复核实证③：数组元素里的逗号被当分隔符
      { 摘要: 'a " b' }, // 复核实证④：引号被当边界剥壳
      { 摘要: ' 首尾空白 ' },
      { 摘要: '' }, // 裸空值读回是 []，空串必须写成 ""
      { 摘要: 'x#y' }, // `#` 前无空白 ⇒ 不是注释，普通值（不许被引号化）
      { 路径: 'C:\\Users\\k' }, // 不带引号 ⇒ 不解转义，反斜杠保住
      { 摘要: 'a\\"b' },
      { 摘要: '[看起来像数组]' },
      { refs: ['id-1', 'id-2'] },
      { refs: [] },
      { 摘要: '普通值' },
    ];
    for (const data of 例) {
      const 文本 = `${formatFrontMatter(data)}\n# 正文\n`;
      assert.deepEqual(读回(文本), data, `往返必须闭合：${JSON.stringify(data)}`);
    }
    // 普通值逐字节不变（引号化只发生在需要时）
    const 普通 = formatFrontMatter({ id: '甲卡', kind: '能力', authority: '自治', zone: '私有', domain: '集体', version: 1 });
    assert.equal(普通, '---\nid: 甲卡\nkind: 能力\nauthority: 自治\nzone: 私有\ndomain: 集体\nversion: 1\n---\n');
    // 数组元素各自判断：只有含逗号那个被引号化
    assert.equal(formatFrontMatter({ refs: ['a', 'b,c'] }), '---\nrefs: [a, "b,c"]\n---\n');
    // 空串元素（W3 批5 复核反例）：`['']` 写成 `[""]`，读回必须还是 `['']`
    for (const 数据 of [{ refs: [''] }, { refs: ['a', ''] }, { refs: ['', ''] }, { 摘要: '' }]) {
      assert.deepEqual(读回(`${formatFrontMatter(数据)}\n# 正文\n`), 数据, `空串往返必须闭合：${JSON.stringify(数据)}`);
    }
    assert.equal(formatFrontMatter({ refs: [''] }), '---\nrefs: [""]\n---\n');
  });

  it('①数组空元素折中：带引号的空串保留，legacy 裸空段照旧丢', () => {
    // legacy 手写（不带引号）⇒ 老行为不变
    assert.deepEqual(parseSimpleYaml('refs: [a, , b]').data, { refs: ['a', 'b'] });
    assert.deepEqual(parseSimpleYaml('refs: [,]').data, { refs: [] });
    assert.deepEqual(parseSimpleYaml('refs: []').data, { refs: [] });
    // 带引号的空串是**写侧对空串的表示** ⇒ 必须留住（否则 `['']` 往返成 `[]`）
    assert.deepEqual(parseSimpleYaml('refs: [""]').data, { refs: [''] });
    assert.deepEqual(parseSimpleYaml('refs: ["", a]').data, { refs: ['', 'a'] });
    assert.deepEqual(parseSimpleYaml("refs: ['']").data, { refs: [''] });
  });

  it('①出厂件 front matter 走一遍 format+parse：**逐字节不变**（升级层靠字节比对）', async () => {
    const root = new URL('../mind/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    const files = await listFiles(root, { recursive: true, filter: (n) => n.endsWith('.md') });
    assert.ok(files.length >= 15, `出厂件要够多才有意义，实测 ${files.length}`);
    for (const rel of files) {
      const text = await readTextOrNull(join(root, rel));
      if (text === null) continue;
      const 块 = text.slice(0, text.indexOf('\n---', 3) + 5);
      const 重建 = formatFrontMatter(parseDocument(text).meta);
      assert.equal(重建, 块, `出厂件 ${rel} 的 front matter 不许因为引号化而漂移`);
    }
  });

  it('①capability.publish 的自由文本名：落盘后再读回还是原名（复核的实证路径）', async () => {
    const f = await makeFixture();
    try {
      const { capability } = await 装配(f);
      const 名 = '甲 # 乙';
      const 发布 = await capability.publish({ subject: LEAD, 名, 适用岗位: ['插件工程'], 正文: '先搜后写。', 依据: '测试' });
      const 列表 = await capability.list({ subject: LEAD });
      const 命中 = 列表.find((c) => c.id === 发布.id);
      assert.ok(命中, '发布的能力卡要出现在列表里');
      assert.equal(命中.名, 名, '名里的 ` # ` 不许被当注释切掉（修前读回是「甲」）');
      const 读 = await capability.read({ subject: LEAD, id: 发布.id });
      assert.ok(读, '能力卡要读得到');
      // `capability.read` 不返回 meta ⇒ 直接读盘上那份，验「写进文件再读回来」这一趟
      const 原文 = await readTextOrNull(读.path);
      assert.equal(parseDocument(原文).meta.名, 名, '落盘那份的 meta.名 也要闭合');
    } finally {
      await f.cleanup();
    }
  });
});

describe('W3 批4 · 四条门禁', () => {
  it('②a 依赖校验在锁内：另一个写者持锁、后期才落线依赖节点 ⇒ 仍放行（且确实等过锁）', async () => {
    const f = await makeFixture();
    try {
      const { tasks, clock } = await 装配(f);
      const 锁 = f.layout.taskLock(P);
      // 另一个写者：先拿住任务锁，300ms 后才把 task-H 落线（复核实证的手法）。
      const 门 = withLock(锁, async () => {
        await sleep(300);
        await appendLines(f.layout.taskLog(P), [
          { seq: 1, at: clock.iso(), by: { id: 'lead', kind: 'Lead' }, kind: 'created', id: 'task-H', 描述: 'H', 负责人: ['member-a'], 判据: ['x'], 依赖: [], 状态: '待派发' },
        ]);
      });
      await sleep(40); // 让 create 在**持锁期间**发起（锁外预读会在这里读到"没有 task-H"而拒）
      const t0 = Date.now();
      const 节点 = await tasks.create({ subject: LEAD, 项目: P, 描述: 'B 依赖 H', 负责人: 'member-a', 判据: ['x'], 依赖: ['task-H'] });
      const 用时 = Date.now() - t0;
      await 门;
      assert.deepEqual(节点.依赖, ['task-H'], '持锁期间发起的 create 必须等到锁释放、看见刚落的依赖再放行');
      assert.ok(用时 >= 200, `create 必须真的等过锁（锁内校验），实测 ${用时}ms（锁外预读会是几毫秒且被拒）`);
    } finally {
      await f.cleanup();
    }
  });

  it('②b 归档被拒 ⇒ 节点不许显示已结账，事件流里也不许有 settled', async () => {
    const f = await makeFixture();
    try {
      const { tasks, memory, policy } = await 装配(f);
      const 节点 = await tasks.create({ subject: LEAD, 项目: P, 描述: '归档被拒', 负责人: 'member-a', 判据: ['x'] });
      await tasks.dispatch(节点.id, { subject: LEAD, 项目: P });
      await tasks.start(节点.id, { subject: MEMBER, 项目: P });
      await memory.remember({ subject: MEMBER, 类: '作答', 内容: '我的作答', 来源: '实例作答', 项目: P, 任务: { 负责人: 'member-a' } });
      await tasks.submit(节点.id, { subject: MEMBER, 项目: P, 结论: 'ok' });
      await tasks.review(节点.id, { subject: REVIEWER, 项目: P, 三态: '过' });

      const 原check = policy.check.bind(policy);
      policy.check = async (input) => {
        if (input.action === 'write' && input.target?.kind === '作答') {
          throw new Denied('测试拦截 · 归档被拒', '模拟归档闸拒绝');
        }
        return 原check(input);
      };
      await assert.rejects(() => tasks.settle(节点.id, { subject: LEAD, 项目: P }), (e) => e instanceof Denied);
      policy.check = 原check;

      assert.equal((await tasks.get(节点.id, { 项目: P })).状态, '已采纳', '归档被拒 ⇒ 节点不许显示已结账');
      assert.ok(!(await tasks.events({ 项目: P })).some((r) => r.kind === 'settled'), '事件流里不许留下 settled');

      // 撤拦截 ⇒ 正常结账
      const 结 = await tasks.settle(节点.id, { subject: LEAD, 项目: P });
      assert.equal(结.状态, '已结账');
      assert.equal(结.归档条数, 1);
    } finally {
      await f.cleanup();
    }
  });

  it('②c 未交齐不投影零分歧，但内部判定仍是全量答案现算（齐后照给；分歧时给 false）', () => {
    const 造节点 = (答案) => ({ id: 'n-w3d', 描述: '路线', 状态: '已交卷', 模式: '独立会审', 负责人: ['member-a', 'member-b', 'member-c'], 判据: ['x'], 判据冻结: true, 独立答案: 答案 });
    const 投影 = (答案) => projectWorkbench({ 项目: 'p', 节点: [造节点(答案)], 探针: { 结果: [] }, 策略: { healthy: true, rules: [] } }).会审[0];

    const 一致两份 = [
      { 成员: 'member-a', 结论: '用会话命令', 反例面: [] },
      { 成员: 'member-b', 结论: '用会话命令', 反例面: [] },
    ];
    const 未齐 = 投影(一致两份);
    assert.equal(未齐.零分歧, undefined, '未交齐不投影（批3 的遮罩）');
    assert.equal(judgeZeroDivergence(一致两份).零分歧, true, '判定用的是**全量答案**（同一个纯函数），只是不投影');
    // W3 批5：未交齐时补的**机械读数**——它由全量答案算得、不含任何人的结论文本。
    // 没有它，「判定读的是全量还是遮罩后的行」在未交齐场景下没有任何可观察判据
    // （复核实测：把判定改成读遮罩行仍然全绿）。遮罩行没有结论 ⇒ 基数会塌成 0。
    assert.equal(未齐.零分歧判定基数, 2, '未交齐（2/3）时基数 = 全量答案里带结论的条数（2）');
    assert.deepEqual(未齐.独立答案, [{ 盲标: '成员 A' }, { 盲标: '成员 B' }], '同时答案行只有盲标（遮罩仍在）');
    assert.doesNotMatch(JSON.stringify(未齐), /用会话命令/, '机械读数不许把结论带出来');

    const 齐 = 投影([...一致两份, { 成员: 'member-c', 结论: '用会话命令', 反例面: [] }]);
    assert.equal(齐.零分歧, true, '齐后照给');
    assert.equal(齐.零分歧判定基数, undefined, '齐后给的是判定值本身，不需要基数这个旁证');

    // 反向：结论不同 ⇒ false。这条能识别「拿遮罩后的行去判」那种实现——
    // 遮罩行没有 成员/结论，`结论层` 会塌成一个空串，于是任何会审都被判成"零分歧"。
    const 分歧三份 = [
      { 成员: 'member-a', 结论: '用会话命令', 反例面: [] },
      { 成员: 'member-b', 结论: '用常驻进程', 反例面: [] },
      { 成员: 'member-c', 结论: '用会话命令', 反例面: [] },
    ];
    const 齐分歧 = 投影(分歧三份);
    assert.equal(齐分歧.零分歧, false, '结论层有分歧 ⇒ 不是零分歧（拿遮罩行去判会误报 true）');
    assert.match(齐分歧.零分歧依据, /分歧数 2/);
  });
});
