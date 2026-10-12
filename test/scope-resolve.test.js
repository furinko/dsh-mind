/**
 * scopeOf 经身份档案解析岗位（缺口4 · 2026-10-12 · task-scopeOf-经身份档案解析岗-8k9qh）。
 *
 * 缺口：成员主体刻意不带 roleId（src/subject.js:40-42 · A 修——岗位由 registry_assign
 * 落在身份档案），而 scopeOf 旧实现按 [subject.id, subject.roleId] 比对负责人名单
 * ⇒ 负责人写**岗名**的节点，任何真实成员会话都结构性无法 start
 * （2026-10-12 实踩：task_start 891j1 被拒「该任务节点负责人是 插件工程，不是 91709266…」）。
 *
 * 修复：scopeOf 直配不中时，经身份档案（policy 自读、decide 入口按 mtime 保鲜的那份内存态）
 * 把实例解析成岗位再比对；自报 roleId 移出比对面。
 *
 * 本文件钉死的判据：
 *  ① 岗名负责人的已派发节点：该岗在册在岗实例（**不带 roleId 的真实会话形态**）
 *     可 task_start + 任务内写动作（e2e）；
 *  ② 解析只信真源三向照拒：不在册（§12.2 闸）/ 在册不在岗（§12.2 闸）/
 *     自报岗位与名单一致但档案岗位不符（scopeOf 拒—— denial 必须长在 scopeOf 上）；
 *  ③ 实例直配回归：按实例派的节点仍精确到实例，同岗别的实例照拒；
 *  ④ 名单语义不放宽：按岗名派 ⇒ 该岗任一在岗实例可动；空名单仍放行（policy.js:314 既有语义）；
 *  ⑤ 不引环依赖：policy.js 源码不出现对 registry 模块的引用（档案真源是同一个文件，
 *     policy 自己读，无需依赖注册表模块）。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeFixture, LEAD } from './helpers.mjs';
import { runAction } from '../lib/actions.js';
import { Org } from '../src/org.js';
import { Denied } from '../src/kernel/errors.js';

const P = 'proj-scope-resolve';
/** 真实成员会话形态：不带 roleId（subject.js A 修：会话事实里没有岗位这一位）。 */
const 实例甲 = { id: 'member-a', kind: '成员' };
const 实例乙 = { id: 'member-b', kind: '成员' };

describe('scopeOf 经身份档案解析岗位（缺口4）', () => {
  let f;
  let org;
  let 岗名节点; // 负责人 = '插件工程'（岗名）
  let 实例节点; // 负责人 = 'member-a'（实例）

  before(async () => {
    f = await makeFixture({
      members: {
        'member-a': { id: 'member-a', 岗位: '插件工程', 代: 1, status: '在岗' },
        'member-b': { id: 'member-b', 岗位: '插件工程', 代: 1, status: '在岗' },
        // member-c：在册但**封存**——②的「在册不在岗」探针。
        'member-c': { id: 'member-c', 岗位: '插件工程', 代: 1, status: '封存' },
        lead: { id: 'lead', 岗位: 'Lead', 代: 1, status: '在岗' },
        reviewer: { id: 'reviewer', 岗位: '复核员', 代: 1, status: '在岗' },
      },
    });
    org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
    岗名节点 = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '按岗名派的节点', 负责人: '插件工程', 判据: ['x'] });
    await org.tasks.dispatch(岗名节点.id, { subject: LEAD, 项目: P });
    实例节点 = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '按实例派的节点', 负责人: 'member-a', 判据: ['x'] });
    await org.tasks.dispatch(实例节点.id, { subject: LEAD, 项目: P });
  });
  after(async () => {
    await f.cleanup();
  });

  it('① 岗名负责人节点：在册在岗实例（不带 roleId）可 start + 任务内写动作', async () => {
    const started = await runAction({ org, 项目: P, 主体: 实例甲, args: { action: 'task_start', id: 岗名节点.id } });
    assert.equal(started.节点?.状态, '执行中', `应放行，实际 ${JSON.stringify(started)}`);
    const written = await runAction({
      org,
      项目: P,
      主体: 实例甲,
      args: { action: 'memory_write', 类: '知识', 内容: '岗名节点任务内写入', 来源: '测试', project: P, 任务: 岗名节点.id },
    });
    assert.ok(written.条目?.id, '任务内写动作（memory_write 带任务上下文）必须放行');
  });

  it('②a 不在册实例 ⇒ 照拒（§12.2 闸，查不到不等于放行）', async () => {
    await assert.rejects(
      () => runAction({ org, 项目: P, 主体: { id: 'ghost-不在册', kind: '成员' }, args: { action: 'task_start', id: 岗名节点.id } }),
      (e) => e instanceof Denied && /§12.2/.test(e.rule),
    );
  });

  it('②b 在册不在岗（封存）⇒ 照拒（§12.2 闸 + scopeOf 解析面双层）', async () => {
    await assert.rejects(
      () => runAction({ org, 项目: P, 主体: { id: 'member-c', kind: '成员' }, args: { action: 'task_start', id: 岗名节点.id } }),
      (e) => e instanceof Denied && /§12.2|封存/.test(e.rule + e.message),
    );
    // scopeOf 直连层也必须有同一答案：decide 的 §12.2 闸管「主体能不能行动」，
    // scopeOf 的解析面管「岗位算不算数」——封存实例的档案岗位不许产出，
    // 否则任何绕过 decide 的调用面（将来新调用点）会把封存账号当在岗用。
    assert.equal(
      f.policy.scopeOf({ id: 'member-c', kind: '成员' }, { 负责人: ['插件工程'] }).ok,
      false,
      '封存实例的岗位解析必须不产出（这道断言是「解析后不核在岗状态」造坏的收口）',
    );
  });

  it('②c 自报岗位与名单一致、档案岗位不符 ⇒ scopeOf 照拒（信自报 = 冒充第一步）', async () => {
    // member-b 档案岗位是「插件工程」；让它自报 roleId='文档整理' 去碰负责人='文档整理' 的名单——
    // 信自报会放行，只信档案则插件工程不在名单 ⇒ 拒，且拒绝必须长在 scopeOf 的理由上。
    const 节点 = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '派给文档整理岗', 负责人: '文档整理', 判据: ['x'] });
    await org.tasks.dispatch(节点.id, { subject: LEAD, 项目: P });
    const decision = await f.policy.decide({
      subject: { id: 'member-b', kind: '成员', roleId: '文档整理' },
      action: 'write',
      target: { id: '记忆/x', kind: '知识', authority: '自治', zone: '私有', domain: '集体', project: P },
      context: { task: 节点 },
    });
    assert.equal(decision.verdict, 'deny', '自报岗位不许兑现');
    assert.match(decision.reason, /负责人是 文档整理/, `拒因必须长在 scopeOf 上（不是 §12.2 闸），实际 ${decision.rule}：${decision.reason}`);
  });

  it('③ 实例直配回归：按实例派的节点仍精确到实例（同岗乙照拒）', async () => {
    const started = await runAction({ org, 项目: P, 主体: 实例甲, args: { action: 'task_start', id: 实例节点.id } });
    assert.equal(started.节点?.状态, '执行中', '实例本人仍直配放行（旧路径不变）');
    // 乙要单独碰一个**未 start** 的实例派节点：否则撞的是状态机（不能重复 start），测不到 scopeOf。
    const 乙的靶 = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '还是派给甲', 负责人: 'member-a', 判据: ['x'] });
    await org.tasks.dispatch(乙的靶.id, { subject: LEAD, 项目: P });
    await assert.rejects(
      () => runAction({ org, 项目: P, 主体: 实例乙, args: { action: 'task_start', id: 乙的靶.id } }),
      (e) => e instanceof Denied && /负责人是 member-a/.test(e.message),
      '同岗另一个实例不许沾按实例派的节点',
    );
  });

  it('④ 名单语义：按岗名派 ⇒ 该岗任一在岗实例可动；空名单仍放行', async () => {
    // 甲已在 ① 里动了岗名节点；乙（同岗）也必须有同等的任务内权。
    const 节点 = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '岗名节点二号', 负责人: '插件工程', 判据: ['x'] });
    await org.tasks.dispatch(节点.id, { subject: LEAD, 项目: P });
    const started = await runAction({ org, 项目: P, 主体: 实例乙, args: { action: 'task_start', id: 节点.id } });
    assert.equal(started.节点?.状态, '执行中', '同岗任一在岗实例都可动');
    // 空名单（policy.js:314 既有语义）：scopeOf 直读判 ok。
    assert.equal(f.policy.scopeOf(实例乙, { 负责人: [] }).ok, true, '空名单仍放行（语义未动）');
  });

  it('⑤ 不引环依赖：policy.js 源码不引用 registry 模块', async () => {
    const src = await readFile(new URL('../src/policy.js', import.meta.url), 'utf8');
    assert.ok(!/registry\.js/.test(src), 'policy.js 不许 import registry 模块——档案真源是同一个文件，policy 自读');
  });
});
