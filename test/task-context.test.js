/**
 * 任务上下文透传 · 接口缺口修复（2026-10-12 · task-修复接口缺口-mind-工具层与-7lot2）。
 *
 * 缺口：mind 工具层没有「任务」入参、lib/actions.js 不向 src/memory.js 透传，
 * 于是 memory.js:106 的 `context.task` 恒为 null，成员调 memory_write / memory_lifecycle
 * 恒被 policy.js scopeOf 判「任务外」——即使名下有执行中的任务节点。
 * 服务层（remember/#appendState）本来就有 任务 入参，缺口在动作层与工具层 ⇒ 本文件
 * 全部钉在 runAction 级（缺口的真实发生面），不在服务层重测既有覆盖。
 *
 * 判据：
 *  ① 成员任务内带「任务」写记忆 ⇒ 成功；
 *  ② 缺「任务」⇒ 拒，且拒因指向调用方该补的入参（「未声明任务上下文」），
 *     不指向任务图（口径改形：旧措辞「没有关联任务节点」让读者去找 Lead 派节点，
 *     实测名下有节点也照拒——措辞改形不是删红，旧断言面无一处引用旧字面）；
 *  ③ 传**别人名下**的节点 ⇒ 拒（自报不成真：动作层只负责取真节点，
 *     scopeOf 仍按负责人名单比对）；
 *  ④ 传不存在的节点 ⇒ InvalidBody 响亮拒（不编空节点滑进策略引擎）；
 *  ⑤ 成员任务内 invalidate 自己记的条目 ⇒ 成功（#appendState 同病同修，
 *     §7「错误/过期」本就是成员的常规处置动作）；
 *  ⑥ Lead 不带「任务」照常写（回归面：非成员不吃 scopeOf 这道闸）。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, LEAD, MEMBER } from './helpers.mjs';
import { runAction } from '../lib/actions.js';
import { Org } from '../src/org.js';
import { Denied, InvalidBody } from '../src/kernel/errors.js';

const P = 'proj-taskctx';

describe('任务上下文透传（接口缺口修复）', () => {
  let f;
  let org;
  let 节点; // member-a 名下，执行中
  let 他人节点; // member-b 名下

  before(async () => {
    f = await makeFixture();
    org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
    节点 = await org.tasks.create({ subject: LEAD, 项目: P, 描述: 'member-a 的节点', 负责人: 'member-a', 判据: ['能写记忆'] });
    await org.tasks.dispatch(节点.id, { subject: LEAD, 项目: P });
    await org.tasks.start(节点.id, { subject: MEMBER, 项目: P });
    他人节点 = await org.tasks.create({ subject: LEAD, 项目: P, 描述: 'member-b 的节点', 负责人: 'member-b', 判据: ['x'] });
    await org.tasks.dispatch(他人节点.id, { subject: LEAD, 项目: P });
  });
  after(async () => {
    await f.cleanup();
  });

  /** @param {object} extra 追加/覆盖的入参 */
  const 成员写知识 = (extra) =>
    runAction({
      org,
      项目: P,
      subject: { id: 'lead', kind: 'Lead' },
      主体: MEMBER,
      args: { action: 'memory_write', 类: '经历', 内容: '任务内产出', 来源: '测试', ...extra },
    });

  it('① 成员任务内带「任务」写记忆 ⇒ 成功', async () => {
    const r = await 成员写知识({ 任务: 节点.id });
    assert.ok(r.条目?.id, `应返回条目 id，实际 ${JSON.stringify(r)}`);
    assert.equal(r.条目.项目, P);
  });

  it('② 缺「任务」⇒ 拒，拒因指向调用方该补的入参（不指向任务图）', async () => {
    await assert.rejects(
      () => 成员写知识({}),
      (e) =>
        e instanceof Denied &&
        /未声明任务上下文/.test(e.message) &&
        /任务外无/.test(e.rule) &&
        /传「任务」/.test(e.howToChange),
    );
  });

  it('③ 传别人名下的节点 ⇒ 拒（自报不成真，scopeOf 按负责人名单比对）', async () => {
    await assert.rejects(
      () => 成员写知识({ 任务: 他人节点.id }),
      (e) => e instanceof Denied && /负责人/.test(e.message) && /member-b/.test(e.message),
    );
  });

  it('④ 传不存在的节点 ⇒ InvalidBody 响亮拒', async () => {
    await assert.rejects(
      () => 成员写知识({ 任务: 'task-ghost-404' }),
      (e) => e instanceof InvalidBody && /不存在/.test(e.message),
    );
  });

  it('⑤ 成员任务内 invalidate 自己记的条目 ⇒ 成功（#appendState 同病同修）', async () => {
    const w = await 成员写知识({ 任务: 节点.id, 内容: '稍后要失效的条目' });
    const r = await runAction({
      org,
      项目: P,
      subject: { id: 'lead', kind: 'Lead' },
      主体: MEMBER,
      args: { action: 'memory_lifecycle', op: 'invalidate', id: w.条目.id, 原因: '结论过期', 任务: 节点.id },
    });
    assert.equal(r.结果?.状态, 'invalid', `应追加 invalid 状态，实际 ${JSON.stringify(r.结果)}`);
    // 对照：同一条目缺「任务」处置 ⇒ 仍判任务外（处置面没开旁路）。
    const w2 = await 成员写知识({ 任务: 节点.id, 内容: '第二条待处置' });
    await assert.rejects(
      () =>
        runAction({
          org,
          项目: P,
          subject: { id: 'lead', kind: 'Lead' },
          主体: MEMBER,
          args: { action: 'memory_lifecycle', op: 'invalidate', id: w2.条目.id, 原因: '缺任务上下文' },
        }),
      (e) => e instanceof Denied && /未声明任务上下文/.test(e.message),
    );
  });

  it('⑥ Lead 不带「任务」照常写（回归：非成员不吃 scopeOf）', async () => {
    const r = await runAction({
      org,
      项目: P,
      subject: { id: 'lead', kind: 'Lead' },
      主体: LEAD,
      args: { action: 'memory_write', 类: '知识', 内容: 'Lead 的知识', 来源: '测试', project: P },
    });
    assert.ok(r.条目?.id);
  });
});
