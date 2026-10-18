/**
 * 补修F · 真链对照（Lead 2026-10-18 两点校准）。
 *
 * ① **重复检查 ≠ 重复副作用**：用真实 `TaskGraph` / `MemoryService`（不是手工拼一串
 *    `policy.check`），把服务的 `policy.check` 包成「锁外预检 + 锁内复判」两次判定。
 *    同一次业务写两次判定只消耗一步、只落一份副作用；真的第二个新建（新 id / 新写入标签）
 *    必须再消耗一步，不能借重复检查豁免。
 * ② **同一真实父的重复 confirm 不卡已批准的子请求**：受控父判只 peek 不消费；
 *    父 deny / 父卡失效仍拒。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { makeFixture, LEAD, MEMBER } from './helpers.mjs';
import { Org } from '../src/org.js';
import { 以放行上下文 } from '../src/intervention.js';
import { Denied, NeedsApproval } from '../src/kernel/errors.js';

const P = 'proj-f-chains';

async function 起(选项 = {}) {
  const f = await makeFixture({ defaults: { 介入度: '审批' }, ...选项 });
  const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
  return { f, org };
}

/**
 * 把真实服务的 `policy.check` 包成两次判定（锁外预检 + 锁内复判），模拟「同一业务写多次
 * decide」。`标签Of(input)` 可给每次业务写注入稳定的 `context.介入写`（服务侧本该自己传）。
 */
function 装双检(org, { 标签Of = null } = {}) {
  const 原check = org.policy.check.bind(org.policy);
  const 读数 = [];
  org.policy.check = async (input) => {
    const 上下文 = { ...(input.context ?? {}) };
    if (标签Of) 上下文.介入写 = 标签Of(input);
    const 入参 = { ...input, context: 上下文 };
    const 一 = await 原check(入参); // 锁外：真路径（拒绝就照真错误抛）
    const 二 = await org.policy.decide(入参); // 锁内复判：同一业务写，必须仍是 allow
    读数.push(一.rule);
    if (二.verdict !== 'allow') {
      读数.push(二.verdict);
      throw 二.verdict === 'confirm'
        ? new NeedsApproval(二.rule, 二.reason, { requireAuthority: 二.requireAuthority, howToChange: 二.howToChange, detail: 二.detail })
        : new Denied(二.rule, 二.reason, { requireAuthority: 二.requireAuthority, howToChange: 二.howToChange, detail: 二.detail });
    }
    读数.push(二.rule);
    return 一;
  };
  return { 读数, 还原: () => { delete org.policy.check; } };
}

const 建任务步骤 = (over = {}) => ({ 动作: 'create', 目标: { kind: '任务', 新: true }, 说明: '建任务节点', 预览: { 描述: '双检活' }, ...over });

describe('① 同一业务写多次判定 ≠ 重复副作用', () => {
  it('真实 TaskGraph.create + 锁外/锁内两次判定：一步、一份副作用；第二次真建仍须新步', async () => {
    const { f, org } = await 起();
    try {
      const 双 = 装双检(org);
      try {
        await 以放行上下文({ 原主体: 'lead', 请求id: 'iv-create', 步骤: [建任务步骤()] }, async () => {
          await org.tasks.create({ subject: LEAD, 项目: P, 描述: '双检活', 负责人: 'lead', 判据: ['x'] });
          assert.deepEqual(双.读数, ['法律 介入度 · 已批准放行（§4/v2 条目14/17）', '法律 介入度 · 已批准放行（§4/v2 条目14/17）'], '锁外与锁内都必须放行');
          // 同一上下文里的第二个真实新建：新 id ⇒ 没有可用步 ⇒ 必须再挂起（不许借重复检查豁免）
          await assert.rejects(
            () => org.tasks.create({ subject: LEAD, 项目: P, 描述: '第二个', 负责人: 'lead', 判据: ['x'] }),
            (e) => e instanceof NeedsApproval,
            '第二个新建不能被重复检查豁免',
          );
        });
      } finally {
        双.还原();
      }
      assert.equal((await org.tasks.list({ 项目: P })).length, 1, '只有一份副作用');
    } finally {
      await f.cleanup();
    }
  });

  it('两个计划步 ⇒ 两次真实新建都过；第三次仍挂起', async () => {
    const { f, org } = await 起();
    try {
      const 双 = 装双检(org);
      try {
        await 以放行上下文({ 原主体: 'lead', 请求id: 'iv-create2', 步骤: [建任务步骤(), 建任务步骤()] }, async () => {
          await org.tasks.create({ subject: LEAD, 项目: P, 描述: '一', 负责人: 'lead', 判据: ['x'] });
          await org.tasks.create({ subject: LEAD, 项目: P, 描述: '二', 负责人: 'lead', 判据: ['x'] });
          await assert.rejects(() => org.tasks.create({ subject: LEAD, 项目: P, 描述: '三', 负责人: 'lead', 判据: ['x'] }), (e) => e instanceof NeedsApproval);
        });
      } finally {
        双.还原();
      }
      assert.equal((await org.tasks.list({ 项目: P })).length, 2);
    } finally {
      await f.cleanup();
    }
  });

  it('真实 MemoryService：同一账本目标的两次写入靠写入标签区分（写标签是同一次业务写的幂等键）', async () => {
    const { f, org } = await 起();
    try {
      let 当前标签 = '记忆:一';
      const 双 = 装双检(org, { 标签Of: () => 当前标签 });
      try {
        const 步骤 = [
          { 动作: 'create', 目标: { kind: '经历', 新: true }, 写: '记忆:一', 说明: '写经历一', 预览: { 内容: '一' } },
          { 动作: 'create', 目标: { kind: '经历', 新: true }, 写: '记忆:二', 说明: '写经历二', 预览: { 内容: '二' } },
        ];
        await 以放行上下文({ 原主体: 'lead', 请求id: 'iv-mem', 步骤 }, async () => {
          await org.memory.remember({ subject: LEAD, 类: '经历', 内容: '一', 项目: P, 来源: { 谁: 'lead', 怎么知道: '真链对照' } });
          当前标签 = '记忆:二';
          await org.memory.remember({ subject: LEAD, 类: '经历', 内容: '二', 项目: P, 来源: { 谁: 'lead', 怎么知道: '真链对照' } });
          当前标签 = '记忆:三';
          await assert.rejects(
            () => org.memory.remember({ subject: LEAD, 类: '经历', 内容: '三', 项目: P, 来源: { 谁: 'lead', 怎么知道: '真链对照' } }),
            (e) => e instanceof NeedsApproval,
            '同账本目标的第三次真实写入：没有第三步 ⇒ 仍挂起',
          );
        });
      } finally {
        双.还原();
      }
      const 条目 = (await org.memory.query({ subject: LEAD, 类: ['经历'] })).条目;
      assert.equal(条目.length, 2, '只落两份真实副作用（每份只做一次锁内复判不重复写）');
    } finally {
      await f.cleanup();
    }
  });
});

describe('② 受控父判：不卡已批准子请求，父 deny/父卡失效仍拒', () => {
  async function 建执行中任务(org, f) {
    const 节点 = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '父判链', 负责人: 'member-a', 判据: ['x'] });
    await org.tasks.dispatch(节点.id, { subject: LEAD, 项目: P });
    await org.tasks.start(节点.id, { subject: MEMBER, 项目: P });
    // 准备阶段在放权档做完，再切审批档——测的是写入面，不是 setup。
    await f.write('集体L2-共享基础设施/defaults/介入度.json', JSON.stringify({ 介入度: '审批' }, null, 2));
    await org.policy.reload();
    return 节点;
  }

  const 写经历 = (org, 节点, 内容) => org.memory.remember({ subject: MEMBER, 类: '经历', 内容, 项目: P, 任务: 节点, 来源: { 谁: 'member-a', 怎么知道: '真链对照' } });

  it('无批准：父的介入度 confirm 照旧传播（NeedsApproval）', async () => {
    const { f, org } = await 起({ defaults: { 介入度: '放权' } });
    try {
      const 节点 = await 建执行中任务(org, f);
      await assert.rejects(
        () => 写经历(org, 节点, '无批准'),
        (e) => e instanceof NeedsApproval && /父判确认门槛/.test(String(e.rule)),
        '父判的介入度 confirm 必须传播',
      );
      assert.equal((await org.memory.query({ subject: LEAD, 类: ['经历'] })).条目.length, 0);
    } finally {
      await f.cleanup();
    }
  });

  it('有批准计划：同一真实父的重复 confirm 不卡子请求；子写只消费一次', async () => {
    const { f, org } = await 起({ defaults: { 介入度: '放权' } });
    try {
      const 节点 = await 建执行中任务(org, f);
      const 步骤 = [{ 动作: 'create', 目标: { kind: '经历', 新: true }, 说明: '写经历', 预览: { 内容: '批准' } }];
      await 以放行上下文({ 原主体: 'member-a', 请求id: 'iv-parent', 步骤 }, () => 写经历(org, 节点, '批准'));
      assert.equal((await org.memory.query({ subject: LEAD, 类: ['经历'] })).条目.length, 1, '批准后子写落一份');
    } finally {
      await f.cleanup();
    }
  });

  it('父 deny 仍拒：撤回名单命中时，带批准也写不进去', async () => {
    const { f, org } = await 起({
      defaults: { 介入度: '放权' },
      denylist: [{ id: '记忆/跨项目/经历', 理由: '撤回（测试）', 撤于: '2026-10-18T00:00:00Z' }],
    });
    try {
      const 节点 = await 建执行中任务(org, f);
      const 步骤 = [{ 动作: 'create', 目标: { kind: '经历', 新: true }, 说明: '写经历' }];
      await assert.rejects(
        () => 以放行上下文({ 原主体: 'member-a', 请求id: 'iv-deny', 步骤 }, () => 写经历(org, 节点, '撤回命中')),
        (e) => e instanceof Denied,
        '父 deny 不能被批准绕过',
      );
      assert.equal((await org.memory.query({ subject: LEAD, 类: ['经历'] })).条目.length, 0);
    } finally {
      await f.cleanup();
    }
  });

  it('父卡失效仍拒：委派者本人的钉版快照被改坏 ⇒ 父判 deny', async () => {
    const { f, org } = await 起({ defaults: { 介入度: '放权' } });
    try {
      const 节点 = await 建执行中任务(org, f);
      const 身份文件 = f.layout.identityFile();
      const 文档 = JSON.parse(await readFile(身份文件, 'utf8'));
      // 父 = Lead 本人：把父自己的钉版摘要改成坏值（写前凭证闸会按真实快照验不过）。
      文档.members['lead'].卡版本 = { ...(文档.members['lead'].卡版本 ?? {}), 摘要: 'deadbeef'.repeat(8) };
      await writeFile(身份文件, `${JSON.stringify(文档, null, 2)}\n`, 'utf8');
      await org.policy.reload();
      const 步骤 = [{ 动作: 'create', 目标: { kind: '经历', 新: true }, 说明: '写经历' }];
      await assert.rejects(
        () => 以放行上下文({ 原主体: 'member-a', 请求id: 'iv-badcard', 步骤 }, () => 写经历(org, 节点, '父卡坏')),
        (e) => e instanceof Denied || e instanceof NeedsApproval,
        '父卡失效必须拒，不能当 allow',
      );
      assert.equal((await org.memory.query({ subject: MEMBER, 类: ['经历'] })).条目.length, 0);
    } finally {
      await f.cleanup();
    }
  });
});
