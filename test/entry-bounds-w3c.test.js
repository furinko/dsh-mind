/**
 * W3 批3 · 入口与边界 + 四骑手（2026-10-09）——**塞 bug 校准**测试。
 *
 * 这一批钉的是「入口」与「边界」：谁能从哪条路进来（白名单 / 动作面 / 权限档），
 * 进来之后哪些东西必须被拦住（坏依赖 / 坏授权块 / 换岗 / 未交齐的内容）。
 * 逐条按「把实现故意改坏 → 必红」校准过（红绿读数见提交说明）：
 *  ① readonlyCommand 去掉 `node --test`（跑测试＝写副作用，不是只读）
 *  ② tasks.create 依赖校验：指向空气 / 依赖链成环 ⇒ 拒
 *  ③ task_settle：前置=已采纳、仅 Lead、归档作答、落终态、审计全记、工具面可达
 *  ⑤ components/kernel：死条目 / 恒等三元 / 轮键统一 / mind* 放行有理由（源码级钉住）
 *  ⑥ policy 坏 ```policy 块 ⇒ 引擎不健康 + 写动作 fail-closed；好块照常
 *  ⑦ 检索口径的搜索面报真实字段集（正文+标签）
 *  ⑧ tags 转义引号：`"a \" b"` 解干净，行尾注释仍剥
 *  ⑨ workbench 未交齐连 零分歧/零分歧依据 一起遮（齐后照给）
 *  ⑩ registry.assign 在岗换岗位 ⇒ 拒（先 seal 再 assign）
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeFixture, LEAD, MEMBER, REVIEWER, SOVEREIGN, writeUnder } from './helpers.mjs';
import { Clock } from '../src/kernel/time.js';
import { appendLines, readJsonl } from '../src/kernel/fsx.js';
import { Denied, InvalidBody } from '../src/kernel/errors.js';
import { TaskGraph } from '../src/tasks.js';
import { MemoryService } from '../src/memory.js';
import { RoleRegistry } from '../src/registry.js';
import { ReviewProtocol } from '../src/review.js';
import { MessageBus } from '../src/bus.js';
import { PolicyEngine } from '../src/policy.js';
import { AuditLog } from '../src/audit.js';
import { buildIndex, search } from '../src/retrieval.js';
import { parseSimpleYaml } from '../src/tags.js';
import { projectWorkbench } from '../src/workbench.js';
import { runAction, ACTIONS } from '../lib/actions.js';

const P = 'w3c-proj';

/** 一份合规的岗位卡（assign 需要岗位存在）。 */
const 岗位卡 = (id) =>
  ['---', `id: ${id}`, 'kind: 身份', 'authority: 自治', 'zone: 私有', 'domain: 个体', 'version: 1', '---', `# ${id}`, '', '## 个体L0 · 身份', '岗位身份。', '', '## 个体L1 · 规则', '先搜后写。'].join('\n');

/** 一套装配好的内核件（任务图接上记忆服务：结账要归档作答）。 */
async function 装配(f) {
  const clock = f.clock ?? new Clock();
  const audit = f.audit ?? new AuditLog({ layout: f.layout, clock });
  const policy = f.policy ?? new PolicyEngine({ layout: f.layout, clock, audit });
  if (!f.policy) await policy.reload();
  const memory = new MemoryService({ layout: f.layout, policy, audit, clock });
  const tasks = new TaskGraph({ layout: f.layout, policy, audit, clock, memory });
  const bus = new MessageBus({ layout: f.layout, policy, audit, clock });
  const review = new ReviewProtocol({ layout: f.layout, policy, audit, clock, tasks, bus, random: () => 0 });
  const registry = new RoleRegistry({ layout: f.layout, policy, audit, clock });
  return { layout: f.layout, policy, audit, clock, memory, tasks, bus, review, registry };
}

describe('W3 批3 · 入口与边界', () => {
  it('①readonlyCommand：`node --test` 不再放行（跑测试是写副作用），拒绝时指沙箱区', () => {
    const 允许 = ReviewProtocol.readonlyCommand('git status');
    assert.equal(允许.允许, true, 'git status 仍是只读白名单里的');
    for (const 命令 of ['node --test', 'node --test test/flow.test.js', 'node --test "test/*.test.js"']) {
      const 判 = ReviewProtocol.readonlyCommand(命令);
      assert.equal(判.允许, false, `「${命令}」会落盘（临时文件/快照/账本），不许当只读放行`);
      assert.match(判.howToChange ?? '', /沙箱/, '拒绝要给可执行理由：需要落盘的实验走沙箱区');
    }
    assert.equal(ReviewProtocol.readonlyCommand('node --version').允许, false, '白名单式：没登记的 node 子命令一律拒');
  });

  it('②tasks.create 依赖校验：指向空气 / 依赖链成环都拒；正常依赖照常', async () => {
    const f = await makeFixture();
    try {
      const { tasks } = await 装配(f);
      await assert.rejects(
        () => tasks.create({ subject: LEAD, 项目: P, 描述: '依赖空气', 负责人: 'member-a', 判据: ['x'], 依赖: ['task-不存在-1'] }),
        (e) => e instanceof InvalidBody && /依赖的节点不存在/.test(e.message) && e.missing.includes('task-不存在-1'),
      );
      assert.deepEqual(await tasks.list({ 项目: P }), [], '被拒的节点不许留下半条事件');

      const 前置 = await tasks.create({ subject: LEAD, 项目: P, 描述: '前置', 负责人: 'member-a', 判据: ['x'] });
      const 后继 = await tasks.create({ subject: LEAD, 项目: P, 描述: '后继', 负责人: 'member-a', 判据: ['x'], 依赖: [前置.id] });
      assert.deepEqual(后继.依赖, [前置.id], '正常依赖照常落线');

      // 成环：手写一条把 前置 指回 后继 的事件（等价于旧数据/别处漏判留下的环），
      // 再从这条链上建新节点 ⇒ 必须拒（「先做谁」在环里没有解）。
      await appendLines(f.layout.taskLog(P), [
        { seq: 99, at: new Date().toISOString(), by: { id: 'lead', kind: 'Lead' }, kind: 'created', id: 前置.id, 描述: '前置', 负责人: ['member-a'], 判据: ['x'], 依赖: [后继.id], 状态: '待派发' },
      ]);
      await assert.rejects(
        () => tasks.create({ subject: LEAD, 项目: P, 描述: '踩在环上', 负责人: 'member-a', 判据: ['x'], 依赖: [前置.id] }),
        (e) => e instanceof Denied && /成环/.test(e.message),
      );
    } finally {
      await f.cleanup();
    }
  });

  it('③task_settle：仅 Lead、前置=已采纳、归档作答、落终态已结账、审计全记、工具面可达', async () => {
    const f = await makeFixture();
    try {
      const { tasks, memory, audit, policy } = await 装配(f);
      const 节点 = await tasks.create({ subject: LEAD, 项目: P, 描述: '结账演示', 负责人: 'member-a', 判据: ['x'] });
      await tasks.dispatch(节点.id, { subject: LEAD, 项目: P });
      await tasks.start(节点.id, { subject: MEMBER, 项目: P });

      // 前置闸：没采纳不许结账
      await assert.rejects(
        () => tasks.settle(节点.id, { subject: LEAD, 项目: P }),
        (e) => e instanceof Denied && /不能执行 settle/.test(e.message),
      );

      // 一条真实作答（成员任务内）——结账要把它归档
      const 作答 = await memory.remember({ subject: MEMBER, 类: '作答', 内容: '我的作答内容', 来源: '实例作答', 项目: P, 任务: { 负责人: 'member-a' } });
      await tasks.submit(节点.id, { subject: MEMBER, 项目: P, 结论: '做完了' });
      await tasks.review(节点.id, { subject: REVIEWER, 项目: P, 三态: '过' });
      assert.equal((await tasks.get(节点.id, { 项目: P })).状态, '已采纳');

      // 权限：成员与复核者都不许结账——**要钉住的是「结账是 Lead 的收尾权」这条规则本身**，
      // 不能只匹配 /Lead/：别的层（复核者只读数、成员任务外无）也会拒，只是理由不是这一条。
      for (const 主体 of [MEMBER, REVIEWER]) {
        await assert.rejects(
          () => tasks.settle(节点.id, { subject: 主体, 项目: P }),
          (e) => e instanceof Denied && /结账是 Lead 的收尾权/.test(e.rule) && /task_settle/.test(e.howToChange),
          `${主体.kind} 不许结账（理由必须是结账权限这一条）`,
        );
      }
      assert.equal((await tasks.get(节点.id, { 项目: P })).状态, '已采纳', '被拒的结账不许改动节点');

      const 结账 = await tasks.settle(节点.id, { subject: LEAD, 项目: P });
      assert.equal(结账.状态, '已结账');
      assert.equal(结账.归档条数, 1, '该项目的作答要被归档（1 条）');
      assert.equal((await memory.readableBy(作答.id, { 读者: MEMBER })).可读, false, '归档后成员不可读');

      // 终态：再结账一次拒
      await assert.rejects(() => tasks.settle(节点.id, { subject: LEAD, 项目: P }), (e) => e instanceof Denied);

      // 审计：动作名「结账」、档位全记（它同时改状态与改可见面）
      const 结账行 = (await audit.read({})).filter((r) => r.动作 === '结账');
      assert.equal(结账行.length, 1, '结账要独立入账（动作名可审）');
      assert.equal(结账行[0].档位, '全记');
      assert.equal(结账行[0].结果, 'settled');

      // 工具面可达（不是只能从 review 内部触发）：ACTIONS 里有它，runAction 走得通
      assert.ok(ACTIONS.includes('task_settle'));
      const 另一 = await tasks.create({ subject: LEAD, 项目: P, 描述: '工具面结账', 负责人: 'member-a', 判据: ['x'] });
      await tasks.dispatch(另一.id, { subject: LEAD, 项目: P });
      await tasks.start(另一.id, { subject: MEMBER, 项目: P });
      await tasks.submit(另一.id, { subject: MEMBER, 项目: P, 结论: 'ok' });
      await tasks.review(另一.id, { subject: REVIEWER, 项目: P, 三态: '过' });
      const org = { tasks, memory, policy, audit, registry: { identity: async () => ({ members: {} }) } };
      const 结果 = await runAction({ org, 项目: P, subject: LEAD, 主体: LEAD, args: { action: 'task_settle', id: 另一.id } });
      assert.equal(结果.节点.状态, '已结账');
      assert.match(结果.说明, /已结账/);

      // 装配漏了记忆服务时：响亮抛 Fault（不是 TypeError 那种"看起来像代码 bug"的错）。
      // 用一个**新的、已采纳**的节点：终态节点会先被状态机挡住，测不到这条装配守卫。
      const 第三个 = await tasks.create({ subject: LEAD, 项目: P, 描述: '装配守卫', 负责人: 'member-a', 判据: ['x'] });
      await tasks.dispatch(第三个.id, { subject: LEAD, 项目: P });
      await tasks.start(第三个.id, { subject: MEMBER, 项目: P });
      await tasks.submit(第三个.id, { subject: MEMBER, 项目: P, 结论: 'ok' });
      await tasks.review(第三个.id, { subject: REVIEWER, 项目: P, 三态: '过' });
      const 裸图 = new TaskGraph({ layout: f.layout, policy, audit, clock: f.clock });
      await assert.rejects(
        () => 裸图.settle(第三个.id, { subject: LEAD, 项目: P }),
        (e) => e.name === 'Fault' && e.code === 'SETTLE_NO_MEMORY',
        '结账要归档作答，没有记忆服务必须响亮说清是装配问题',
      );
    } finally {
      await f.cleanup();
    }
  });

  it('⑤components/kernel：死条目 / 恒等三元 / 轮键统一 / mind* 放行理由（源码级钉住）', async () => {
    const 源码 = await readFile(new URL('../components/kernel/lib/index.js', import.meta.url), 'utf8');
    assert.doesNotMatch(源码, /'probe_health'/, 'probe_health 是安全类组件的工具名，不在本工具动作面里（死条目已清）');
    assert.doesNotMatch(源码, /=== 'lead' \? 'lead'/, '恒等三元是重构残留，不许再出现');
    assert.doesNotMatch(源码, /callId/, '轮键不许拿单次调用的 callId 当轮（每次调用一个桶 ⇒ turn/end 找不到、Map 只增不减）');
    assert.equal((源码.match(/轮键\(/g) ?? []).length >= 3, true, '轮键必须两处共用同一份实现（定义 + 两个钩子各一次）');
    assert.match(源码, /`mind\*` 为什么无条件放行/, 'mind* 无条件放行处必须写明理由（闸白名单）');
    assert.match(源码, /工具总范围管的是\*\*宿主工具\*\*/, '理由要说清管的是宿主工具，不是组织自己的入口');
  });

  it('⑥policy 坏 ```policy 块：引擎不健康 + 写动作全拒；好块照常', async () => {
    const 坏 = await makeFixture({
      rules: {
        '集体L1-法律/权限矩阵.md': ['---', 'id: 权限矩阵', 'kind: 规则', 'authority: 法律', 'zone: 出厂', 'domain: 集体', 'version: 1', '---', '# 权限矩阵', '', '## 三档门槛', '你定的 > 组织定的。', '', '```policy', '{ grants: [ 这不是 JSON', '```'].join('\n'),
      },
    });
    try {
      const policy = new PolicyEngine({ layout: 坏.layout, clock: 坏.clock, audit: 坏.audit });
      const ok = await policy.reload();
      assert.equal(ok, false, '坏授权块 ⇒ 加载失败（fail-closed）');
      assert.equal(policy.healthy, false);
      assert.match(policy.describe().error ?? '', /授权块无法解析/, '错误要进引擎健康面（describe.error）并点名是哪份规则件');
      assert.match(policy.describe().error ?? '', /权限矩阵/);
      const 判定 = await policy.decide({ subject: LEAD, action: 'write', target: { id: 'x', kind: '能力', authority: '自治', zone: '私有' }, context: {} });
      assert.equal(判定.verdict, 'deny', '引擎不健康 ⇒ 写动作 fail-closed');
      assert.equal(判定.alarm, true, '而且必须告警（不许静默）');
    } finally {
      await 坏.cleanup();
    }

    const 好 = await makeFixture({
      rules: {
        '集体L1-法律/权限矩阵.md': ['---', 'id: 权限矩阵', 'kind: 规则', 'authority: 法律', 'zone: 出厂', 'domain: 集体', 'version: 1', '---', '# 权限矩阵', '', '## 三档门槛', '你定的 > 组织定的。', '', '```policy', JSON.stringify({ grants: [{ subject: 'Lead', action: 'create', kind: '能力', verdict: 'allow', reason: '好块照常生效' }] }), '```'].join('\n'),
      },
    });
    try {
      const policy = new PolicyEngine({ layout: 好.layout, clock: 好.clock, audit: 好.audit });
      assert.equal(await policy.reload(), true, '好块 ⇒ 引擎健康');
      assert.equal(policy.describe().error, null);
      const 判定 = await policy.decide({ subject: LEAD, action: 'create', target: { id: 'x', kind: '能力', authority: '自治', zone: '私有' }, context: {} });
      assert.equal(判定.verdict, 'allow', '好块里的 grant 照常生效');
      assert.match(判定.reason, /好块照常生效/);
    } finally {
      await 好.cleanup();
    }
  });

  it('⑦检索口径的搜索面报真实字段集：正文+标签（标签确实参与检索）', () => {
    const index = buildIndex([{ id: 'a', 正文: '无关内容。', 标签: ['判据冻结'] }]);
    assert.equal(index.field, '正文+标签');
    const 命中 = search(index, '判据冻结');
    assert.equal(命中.口径.搜索面, '正文+标签', '口径要报真实字段集（修前写死 正文）');
    assert.equal(命中.命中[0]?.id, 'a', '标签命中是真命中（口径不实会让人解释不通这条）');
  });

  it('⑧tags 转义引号：值解干净、行尾注释仍剥、不带引号的反斜杠原样留', () => {
    const y = parseSimpleYaml([
      '摘要: "a \\" b"',
      '带注释: "值 \\" 里" # 这是注释',
      '单引号: \'x \\\' y\'',
      '路径: C:\\Users\\k',
      '注释里: 值 # 后面是注释',
    ].join('\n'));
    assert.equal(y.data.摘要, 'a " b', '转义引号要解回原字符（修前留成 a \\" b）');
    assert.equal(y.data.带注释, '值 " 里', '转义引号 + 行尾注释：两者都要对');
    assert.equal(y.data.单引号, "x ' y");
    assert.equal(y.data.路径, 'C:\\Users\\k', '不带引号的值不解转义（Windows 路径不许被吃反斜杠）');
    assert.equal(y.data.注释里, '值');
    assert.deepEqual(y.errors, []);
  });

  it('⑨workbench 未交齐：连 零分歧/零分歧依据 一起遮；齐后照给', () => {
    const 造节点 = (答案) => ({ id: 'n-w3c', 描述: '技术路线', 状态: '已交卷', 模式: '独立会审', 负责人: ['member-a', 'member-b', 'member-c'], 判据: ['x'], 判据冻结: true, 独立答案: 答案 });
    const 两份一致 = [
      { 成员: 'member-a', 结论: '用会话命令', 反例面: [] },
      { 成员: 'member-b', 结论: '用会话命令', 反例面: [] },
    ];
    const 未齐 = projectWorkbench({ 项目: 'p', 节点: [造节点(两份一致)], 探针: { 结果: [] }, 策略: { healthy: true, rules: [] } }).会审[0];
    assert.equal(未齐.揭名, false);
    assert.deepEqual(未齐.独立答案, [{ 盲标: '成员 A' }, { 盲标: '成员 B' }]);
    assert.equal(未齐.零分歧, undefined, '未交齐时「这两份一致」本身也是内容级信息 ⇒ 不投影');
    assert.equal(未齐.零分歧依据, undefined);
    assert.doesNotMatch(JSON.stringify(未齐), /全票一致/, '依据文本也不许漏出去');

    const 齐 = projectWorkbench({
      项目: 'p',
      节点: [造节点([...两份一致, { 成员: 'member-c', 结论: '用会话命令', 反例面: [] }])],
      探针: { 结果: [] },
      策略: { healthy: true, rules: [] },
    }).会审[0];
    assert.equal(齐.揭名, true);
    assert.equal(齐.零分歧, true, '齐后照给（三份一致且无人给反例面 ⇒ 零分歧异常信号）');
    assert.match(齐.零分歧依据, /全票一致/);
  });

  it('⑩registry.assign 在岗换岗位 ⇒ 拒（先 seal 再 assign）；同岗位仍幂等', async () => {
    const f = await makeFixture();
    try {
      await writeUnder(f.privateRoot, '集体L3-成员角色卡/插件工程.md', 岗位卡('插件工程'));
      await writeUnder(f.privateRoot, '集体L3-成员角色卡/文档整理.md', 岗位卡('文档整理'));
      const { registry } = await 装配(f);
      await registry.assign({ subject: LEAD, 岗位: '插件工程', 实例: 'member-w3c', 代: 3 });
      assert.equal((await registry.identity()).members['member-w3c'].代, 3);

      await assert.rejects(
        () => registry.assign({ subject: LEAD, 岗位: '文档整理', 实例: 'member-w3c', 代: 1 }),
        (e) => e instanceof Denied && /换岗位/.test(e.rule + e.message) && /registry_seal/.test(e.howToChange),
        '在岗换岗位必须拒（assign 会重置代数、抹掉换岗断点）',
      );
      const 现状 = (await registry.identity()).members['member-w3c'];
      assert.equal(现状.岗位, '插件工程', '岗位不许被改');
      assert.equal(现状.代, 3, '代数不许被重置');

      const 幂等 = await registry.assign({ subject: LEAD, 岗位: '插件工程', 实例: 'member-w3c', 代: 1 });
      assert.equal(幂等.幂等, true);

      // 正路：先停岗再登记到新岗位（停岗那一步就是换岗的留痕）
      await registry.seal({ subject: LEAD, 实例: 'member-w3c', 理由: '换岗' });
      await registry.assign({ subject: LEAD, 岗位: '文档整理', 实例: 'member-w3c', 代: 1 });
      const 换后 = (await registry.identity()).members['member-w3c'];
      assert.equal(换后.岗位, '文档整理');
      assert.equal(换后.status, '在岗');
    } finally {
      await f.cleanup();
    }
  });
});
