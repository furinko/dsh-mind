/**
 * 端到端：像宿主那样装载，走一遍模型侧与界面侧的真实调用链。
 *
 * 为什么需要它：单元测试证明各件正确，但「装进去之后能不能用」取决于
 * **跨半区的那条缝**——`/mind dashboard` 返回的 JSON，浏览器看板要能读懂。
 * 这条缝一旦对不上，界面只会显示空白，而单元测试全绿。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeHost, fakeExec } from './host-harness.mjs';
import * as plugin from '../components/kernel/lib/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const FACTORY = join(here, '..', 'mind');

/** @type {string} */ let home;
/** @type {any} */ let host;

describe('装载后的真实调用链', () => {
  before(async () => {
    home = await mkdtemp(join(tmpdir(), 'mind-e2e-'));
    host = fakeHost();
    await plugin.apply(host.ctx, { home, factoryRoot: FACTORY, privateRoot: join(home, 'mind-private') });
  });
  after(async () => {
    host?.清理();
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
  });

  it('看板要读的每一个字段，宿主都真的给了', async () => {
    const command = host.命令.get('mind');
    const reply = await command.handler({ agent: {}, rawInput: 'dashboard' });
    assert.equal(reply.kind, 'success');

    const wrapper = JSON.parse(reply.text);
    // 浏览器半区把包装与投影合成一层，这里复刻同一读取口径。
    const view = { ...wrapper, ...wrapper.数据 };
    for (const field of ['项目', '生成于', '边界', '状态条', '待你决定', '任务', '会审', '审计尾']) {
      assert.ok(view[field] !== undefined, `看板要的字段缺失：${field}`);
    }
    assert.ok(Array.isArray(view.任务.节点), '任务节点要能直接遍历');
    assert.ok(Array.isArray(view.待你决定), '待你决定要能直接遍历');
    assert.ok(Array.isArray(view.会审), '会审块要能直接遍历');
    assert.equal(view.边界.只读, true);
    assert.equal(typeof view.状态条.闸.在位, 'boolean');
    // 失联态是**四态字符串**（Batch 2 起）：布尔装不下「关了」这件事（关了 ≠ 在位 ≠ 失联）。
    assert.equal(typeof view.状态条.失联, 'string');
    assert.ok(['在位', '已失联', '已关闭', '未知'].includes(view.状态条.失联), `状态条.失联 必须是四态之一，实际 ${view.状态条.失联}`);
    assert.ok(view.状态条.探针 && Array.isArray(view.状态条.探针.见红), '探针见红要能直接遍历');

    // 设计里点名要显示的两块，在空组织下也必须是**明确的空**，不是 undefined。
    assert.deepEqual(view.待你决定, [], '空组织下「待你决定」是空清单');
    assert.deepEqual(view.会审, [], '空组织下没有会审');
  });

  it('待你决定里每一项都能直接照着敲（工作台只读，所以给命令不给按钮）', async () => {
    const tool = host.工具.get('mind');
    const command = host.命令.get('mind');
    const exec = fakeExec({ name: 'mind' });
    // 项目键由工作区目录派生（§14.4-5），所以这里不写死项目，而是照面板看到的那个来。
    const 项目 = JSON.parse((await command.handler({ agent: {}, rawInput: 'workbench' })).text).数据.项目;
    const 节点 = JSON.parse(await tool.execute({ action: 'task_create', 描述: '待决演示', 负责人: 'member-a', 判据: 'x', project: 项目 }, exec)).节点;
    await tool.execute({ action: 'task_dispatch', id: 节点.id, project: 项目 }, exec);
    await tool.execute({ action: 'task_pending', id: 节点.id, project: 项目, 原因: '两边改了同一条' }, exec);

    const view = JSON.parse((await command.handler({ agent: {}, rawInput: 'dashboard' })).text).数据;
    const 待决 = view.待你决定.find((x) => x.类型 === '待决项');
    assert.ok(待决, `待决项应出现在「待你决定」里：${JSON.stringify(view.待你决定)}`);
    assert.match(待决.命令, /\/mind task_resolve/);
    assert.deepEqual(待决.可选项, ['用出厂版', '用我的版']);
    assert.deepEqual(view.任务.节点.find((n) => n.id === 节点.id).交卷, { 已交: 0, 应交: 1, 齐: false });
  });

  it('模型侧与界面侧走的是同一张动作表：工具能做的工作台，命令也做得出来', async () => {
    const tool = host.工具.get('mind');
    const command = host.命令.get('mind');
    // 两侧都必须拿到带工作区的 agent：项目键是**从工作区目录派生的**（§14.4-5），
    // 拿不到工作区就退回默认项目，于是两侧会报出不同的项目——那不是两个事实源，是缺上下文。
    const agent = fakeExec({ name: 'mind' }).agent;
    const viaTool = JSON.parse(await tool.execute({ action: 'workbench' }, fakeExec({ name: 'mind' })));
    const viaCommand = JSON.parse((await command.handler({ agent, rawInput: 'workbench' })).text);
    assert.equal(viaTool.数据.项目, viaCommand.数据.项目);
    assert.deepEqual(Object.keys(viaTool.数据).sort(), Object.keys(viaCommand.数据).sort());

    // 真拿不到工作区时，两侧都退回同一档，而不是各说各话。
    const 无上下文 = JSON.parse((await command.handler({ agent: {}, rawInput: 'workbench' })).text).数据;
    assert.equal(无上下文.项目, 'default', '无工作区 ⇒ 退回默认项目');
  });

  it('一条完整的组织动作在装载后可用：建节点 → 派发 → 交卷 → 复核 → 零分歧', async () => {
    const tool = host.工具.get('mind');
    const exec = fakeExec({ name: 'mind', sessionId: 'session-e2e' });
    const P = 'e2e';

    const created = JSON.parse(await tool.execute({ action: 'task_create', 描述: '端到端节点', 负责人: 'member-a', 判据: '可建,可派', project: P }, exec));
    assert.equal(created.成功, true);
    const id = created.节点.id;

    assert.equal(JSON.parse(await tool.execute({ action: 'task_dispatch', id, project: P }, exec)).节点.判据冻结, true);
    assert.equal(JSON.parse(await tool.execute({ action: 'task_submit', id, project: P, 产出物引用: 'artifact-e2e' }, exec)).节点.状态, '已交卷');
    const reviewed = JSON.parse(await tool.execute({ action: 'task_review', id, project: P, 三态: '过', 复核者: 'reviewer' }, exec));
    assert.equal(reviewed.结论.算通过, true);

    const zero = JSON.parse(await tool.execute({
      action: 'review_zero', id, project: P,
      结论集: JSON.stringify([{ 成员: 'a', 结论: '可以' }, { 成员: 'b', 结论: '可以' }]),
    }, exec));
    assert.equal(zero.检查.零分歧, true);
    assert.equal(zero.检查.触发人工抽检, true);

    const audit = JSON.parse(await tool.execute({ action: 'audit_tail', limit: 50 }, exec));
    assert.ok(audit.审计.some((r) => r.动作 === '零分歧异常'), '零分歧那一笔必须进审计');
  });

  it('记忆与能力库在装载后可用，且拒绝路径带可执行理由', async () => {
    const tool = host.工具.get('mind');
    const exec = fakeExec({ name: 'mind' });
    const written = JSON.parse(await tool.execute({ action: 'memory_write', 类: '知识', 内容: '装载后写入的知识', 来源: '集成测试', project: 'e2e' }, exec));
    assert.equal(written.成功, true);
    const queried = JSON.parse(await tool.execute({ action: 'memory_query', 文本: '装载后写入', project: 'e2e' }, exec));
    assert.ok(queried.结果.命中.length >= 1);

    const list = JSON.parse(await tool.execute({ action: 'capability_list' }, exec));
    assert.ok(list.能力.length >= 6, '出厂能力库应被读到');
    const resolved = JSON.parse(await tool.execute({ action: 'capability_resolve', 名: 'policy-decision' }, exec));
    assert.equal(resolved.解析.冲突, false);
    assert.equal(resolved.解析.默认, '出厂');

    const denied = JSON.parse(await tool.execute({ action: 'memory_write', 类: '知识', 内容: '缺来源' }, exec));
    assert.equal(denied.成功, false);
    assert.equal(denied.结果, '结构不合规');
    assert.ok(denied.理由.includes('怎么知道的'));
  });

  it('探针与升级运维不在内核的工具面上：它们属于安全类组件', async () => {
    const tool = host.工具.get('mind');
    const exec = fakeExec({ name: 'mind' });
    const enumValues = tool.parameters.properties.action.enum;
    for (const action of ['probe_run', 'probe_health', 'probe_rollback', 'upgrade_compare', 'upgrade_resolve']) {
      assert.ok(!enumValues.includes(action), `内核不该暴露 ${action}`);
      const refused = JSON.parse(await tool.execute({ action }, exec));
      assert.equal(refused.成功, false);
      assert.match(String(refused.理由), /未知 action/);
    }
    // 只读的「看挂起」留在内核：没装安全类组件也要能看到待裁决的 diff。
    const pending = JSON.parse(await tool.execute({ action: 'upgrade_pending' }, exec));
    assert.equal(pending.成功, true);
    assert.ok(Array.isArray(pending.挂起));
  });
});
