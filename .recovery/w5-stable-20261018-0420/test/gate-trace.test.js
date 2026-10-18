/**
 * 闸门留痕 · 缺口1A（2026-10-12 · task-闸门留痕-缺口1-A-主权者已批-8dt59）。
 *
 * 缺口：spawn 成员到 registry_assign 之间组织账本全盲——未登记主体首次调 mind 被
 * 宪章 §12.2（runAction B3 闸）拒，这次拒绝却不入账（2026-10-12 实测：成员 12:05
 * 被拒，audit seq:128→129 之间无记录）⇒「陌生主体敲过门」账本完全看不见。
 *
 * 修复：B3 拦截在抛 Denied 前追加一条「身份未登记拦截」（全记），只记主体 id + 动作名。
 *
 * 本文件钉死的判据：
 *  ① 未登记主体调 mind 任意动作被 §12.2 拒 ⇒ 审计出现「身份未登记拦截」，含主体 id 与动作名；
 *  ② 防泄密：入参里的敏感字串不出现在该记录里（不记入参内容）；
 *  ③ 回归面：已登记主体的既有审计形态不变——未登记拦截只长在 B3 这条路上，
 *     已登记成员的策略拒绝仍记「策略拒绝」，不冒出新条目类；
 *  ④ 登记后同一主体放行 ⇒ 不再有拦截记录（闸的方向正确：只在拦截时记）。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, MEMBER } from './helpers.mjs';
import { runAction } from '../lib/actions.js';
import { Org } from '../src/org.js';
import { Denied } from '../src/kernel/errors.js';

const P = 'proj-gate-trace';
/** 敏感探针字串：若入参内容漏进审计记录，断言②立刻红。 */
const 敏感字串 = 'SENSITIVE-TOKEN-9f3a7c-不许入账';

describe('闸门留痕：身份未登记拦截入账（缺口1A）', () => {
  let f;
  let org;

  before(async () => {
    f = await makeFixture();
    org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
  });
  after(async () => {
    await f.cleanup();
  });

  it('① 未登记主体被 §12.2 拒 ⇒ 审计留「身份未登记拦截」（主体 id + 动作名）', async () => {
    const ghost = { id: 'ghost-未登记', kind: '成员' };
    await assert.rejects(
      () => runAction({ org, 项目: P, 主体: ghost, args: { action: 'status' } }),
      (e) => e instanceof Denied && /§12.2/.test(e.rule),
    );
    const rows = (await org.audit.read({})).filter((r) => r.动作 === '身份未登记拦截');
    assert.equal(rows.length, 1, `应恰好一条拦截记录，实际 ${rows.length}`);
    assert.equal(rows[0].主体.id, 'ghost-未登记', '记录含主体 id');
    assert.equal(rows[0].对象.id, 'status', '记录含动作名');
    assert.equal(rows[0].档位, '全记', '安全信号按全记入档');
    assert.equal(rows[0].结果, '拒绝');
  });

  it('② 防泄密：入参里的敏感字串不出现在拦截记录里', async () => {
    const ghost = { id: 'ghost-带敏感入参', kind: '成员' };
    await assert.rejects(
      () =>
        runAction({
          org,
          项目: P,
          主体: ghost,
          args: { action: 'memory_write', 类: '经历', 内容: 敏感字串, 来源: 敏感字串, project: P },
        }),
      (e) => e instanceof Denied && /§12.2/.test(e.rule),
    );
    const rows = (await org.audit.read({})).filter((r) => r.动作 === '身份未登记拦截' && r.主体.id === ghost.id);
    assert.equal(rows.length, 1, '前置：这次拦截确实入账了');
    assert.ok(!JSON.stringify(rows[0]).includes(敏感字串), '拦截记录不许带入参内容');
    assert.deepEqual(rows[0].详情 ?? {}, {}, '拦截记录的详情必须是空的（只记 id + 动作名）');
  });

  it('③ 回归：已登记成员的策略拒绝仍记「策略拒绝」，不冒出「身份未登记拦截」', async () => {
    const 前 = (await org.audit.read({})).filter((r) => r.动作 === '身份未登记拦截').length;
    // 已登记在岗成员走得到策略引擎：任务外写 ⇒ 既有的「策略拒绝」口径原样。
    await assert.rejects(
      () =>
        runAction({
          org,
          项目: P,
          主体: MEMBER,
          args: { action: 'memory_write', 类: '经历', 内容: '任务外写', 来源: '测试', project: P },
        }),
      (e) => e instanceof Denied && /任务外无/.test(e.rule),
    );
    const rows = await org.audit.read({});
    assert.ok(
      rows.some((r) => r.动作 === '策略拒绝' && r.主体.id === MEMBER.id),
      '已登记成员的拒绝仍按既有「策略拒绝」形态入账',
    );
    assert.equal(
      rows.filter((r) => r.动作 === '身份未登记拦截').length,
      前,
      '已登记主体的拒绝不许冒出「身份未登记拦截」——它只长在 B3 拦截路上',
    );
  });

  it('④ 同一主体登记在岗后放行 ⇒ 不再产生拦截记录', async () => {
    // 独立夹具：把「ghost-已登记」预登记进身份档案（members 选项整体替换默认表，
    // 所以默认值要带全）。registry.assign 需要岗位卡存在，夹具没有岗位卡——
    // 这里测的是「拦截只在未登记时记」，不走 assign 那条业务路。
    const g = await makeFixture({
      members: {
        'ghost-已登记': { id: 'ghost-已登记', 岗位: '插件工程', 代: 1, status: '在岗' },
        'member-a': { id: 'member-a', 岗位: '插件工程', 代: 1, status: '在岗' },
        lead: { id: 'lead', 岗位: 'Lead', 代: 1, status: '在岗' },
        reviewer: { id: 'reviewer', 岗位: '复核员', 代: 1, status: '在岗' },
      },
    });
    try {
      const org2 = await Org.open({ home: g.home, factoryRoot: g.factoryRoot, privateRoot: g.privateRoot, project: P });
      const r = await runAction({ org: org2, 项目: P, 主体: { id: 'ghost-已登记', kind: '成员' }, args: { action: 'status' } });
      assert.equal(r.action, 'status', '登记后放行');
      assert.equal(
        (await org2.audit.read({})).filter((x) => x.动作 === '身份未登记拦截').length,
        0,
        '放行路径不记拦截（闸的方向：只在拦截时记）',
      );
    } finally {
      await g.cleanup();
    }
  });
});
