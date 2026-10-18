/**
 * v2 介入度三档（口述收敛 2026-10-18 条目14/17/24）的回归网。
 *
 * 钉五件事：
 *  ① 取值只剩 放权/预审/审批 三档；旧档名加载期 fail-closed（在 fix-batch-2026-10-13
 *    P2-1 用「事后抽检」钉过，这里只钉三档语义）。
 *  ② 放权 = 现状零参与行为：自治写直落留痕。
 *  ③ 预审 = 高风险清单写死：改岗位卡 / 发布能力 / 物理删除记忆 / 改设置 ⇒ confirm
 *    且带 介入挂起 标记；低风险直落；实例登记（registry_assign）不算改卡。
 *  ④ 审批 = 每条自治写都 confirm；主权者不受影响；法律档不受影响。
 *  ⑤ 挂起投影：被拦的写进审计（策略拒绝 · 需确认 · 介入挂起），工作台「待你决定」
 *    把它投影出来并带放行方式文本。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, LEAD, SOVEREIGN } from './helpers.mjs';
import { Org } from '../src/org.js';
import { NeedsApproval } from '../src/kernel/errors.js';
import { runAction } from '../lib/actions.js';
import { INTERVENTION } from '../src/policy.js';

const P = 'proj-v2intervention';

describe('① 档位清单', () => {
  it('INTERVENTION 恰为三档', () => {
    assert.deepEqual(INTERVENTION, ['放权', '预审', '审批']);
  });
});

describe('② 放权 = 直落留痕', () => {
  it('高风险动作在放权档也直落（放权就是零参与的改名）', async () => {
    const f = await makeFixture({ defaults: { 介入度: '放权' } });
    try {
      const d = await f.policy.decide({ subject: LEAD, action: 'create', target: { id: 'cap-x', kind: '能力', authority: '自治' }, context: {} });
      assert.equal(d.verdict, 'allow');
      assert.match(d.rule, /放权/);
    } finally { await f.cleanup(); }
  });
});

describe('③ 预审 = 高风险清单写死', () => {
  async function 判(f, action, kind, context = {}) {
    return f.policy.decide({ subject: LEAD, action, target: { id: 'obj-1', kind, authority: '自治', zone: '私有' }, context });
  }
  it('四类高风险全拦：改岗位卡 / 发布能力 / 物理删除记忆 / 改设置', async () => {
    const f = await makeFixture({ defaults: { 介入度: '预审' } });
    try {
      for (const [action, kind, context, 名] of [
        ['write', '身份', {}, '改岗位卡'],
        ['create', '身份', {}, '新建岗位卡'],
        ['create', '能力', {}, '发布能力'],
        ['write', '能力', {}, '改能力卡'],
        ['write', '记忆', { 状态: '物理删除' }, '物理删除记忆'],
        ['write', '设置', {}, '改设置'],
      ]) {
        const d = await 判(f, action, kind, context);
        assert.equal(d.verdict, 'confirm', `${名} 在预审档必须挂起（实际 ${d.verdict}）`);
        assert.equal(d.detail?.介入挂起, true, `${名} 的 confirm 必须带挂起标记`);
        assert.match(d.rule, /预审/);
      }
    } finally { await f.cleanup(); }
  });
  it('低风险直落；实例登记不算改卡（派活在预审档照常）', async () => {
    const f = await makeFixture({ defaults: { 介入度: '预审' } });
    try {
      assert.equal((await 判(f, 'write', '任务')).verdict, 'allow', '任务写 = 低风险');
      assert.equal((await 判(f, 'write', '记忆', { id: 'mem-1' })).verdict, 'allow', '普通记忆写 = 低风险');
      assert.equal((await 判(f, 'create', '身份', { 身份操作: '实例' })).verdict, 'allow', 'registry_assign 起实例 ≠ 改岗位卡');
    } finally { await f.cleanup(); }
  });
});

describe('④ 审批 = 每条自治写都等放行', () => {
  it('低风险也拦；主权者不受影响；法律档不受影响', async () => {
    const f = await makeFixture({ defaults: { 介入度: '审批' } });
    try {
      const d = await f.policy.decide({ subject: LEAD, action: 'write', target: { id: 't', kind: '任务', authority: '自治' }, context: {} });
      assert.equal(d.verdict, 'confirm', '审批档连低风险写也挂起');
      assert.equal(d.detail?.介入挂起, true);
      const s = await f.policy.decide({ subject: SOVEREIGN, action: 'write', target: { id: 't', kind: '任务', authority: '自治' }, context: {} });
      assert.equal(s.verdict, 'allow', '主权者不受介入度影响');
      const law = await f.policy.decide({ subject: LEAD, action: 'publish', target: { id: 'r', kind: '规则', authority: '法律' }, context: {} });
      assert.notEqual(law.verdict, 'confirm', '介入度只罩自治档，立法通道不受它影响');
    } finally { await f.cleanup(); }
  });
});

describe('⑤ 挂起投影进工作台「待你决定」', () => {
  it('被拦的写入账 ⇒ 工作台出现「介入审批」项并带可敲的决议命令', async () => {
    const f = await makeFixture({ defaults: { 介入度: '审批' } });
    try {
      const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
      // 走**真实动作入口**：请求/步骤计划由动作层登记（服务层直调只留策略拒绝行，没有请求实体）。
      await assert.rejects(
        () => runAction({
          org,
          项目: P,
          subject: LEAD,
          主体: LEAD,
          面: 'tool',
          args: { action: 'task_create', 描述: '审批档下的活', 负责人: 'lead', 判据: 'x' },
        }),
        (e) => e instanceof NeedsApproval && e.detail?.介入挂起 === true && typeof e.detail?.请求id === 'string',
        '审批档下建任务被拦、带请求 id',
      );
      const wb = await org.workbench({ 项目: P });
      const item = wb.待你决定.find((x) => x.类型 === '介入审批');
      assert.ok(item, `工作台「待你决定」要有介入审批项（实际：${JSON.stringify(wb.待你决定.map((x) => x.类型))}）`);
      assert.match(item.命令, /intervention_resolve/, '挂起项给主权者可敲的决议命令');
      assert.match(item.描述, /审批/, '挂起项点名档位');
      assert.equal(item.状态, '待放行', '状态机投影：未批 = 待放行');
    } finally { await f.cleanup(); }
  });
});
