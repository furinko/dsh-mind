import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeFixture, LEAD, MEMBER } from './helpers.mjs';
import { Org } from '../src/org.js';
import { runAction } from '../lib/actions.js';
import { InvalidBody } from '../src/kernel/errors.js';
import { fakeHost } from './host-harness.mjs';
import * as kernel from '../components/kernel/lib/index.js';

const P = 'preflight-correction';
const target = { id: 'synthetic-artifact', kind: '产物', authority: '自治', zone: '私有' };
async function scene(run) {
  const f = await makeFixture();
  try {
    const org = await Org.open({ home: f.home, privateRoot: f.privateRoot, factoryRoot: f.factoryRoot, project: P });
    const task = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '可验证交付', 负责人: MEMBER.id, 判据: ['有效交付'] });
    await org.tasks.dispatch(task.id, { subject: LEAD, 项目: P });
    await org.tasks.start(task.id, { subject: MEMBER, 项目: P });
    const check = (args = {}) => runAction({ org, 项目: P, 主体: MEMBER,
      args: { action: 'policy_check', 动作: 'write', target, 任务: task.id, ...args } });
    await run({ f, org, task, check });
  } finally { await f.cleanup(); }
}

for (const authority of ['task-not-an-authority', '成员', '', null]) {
  it(`错误authority ${String(authority)} 是结构错误，不进入权限判定或任务读取`, async () => scene(async ({ org, check }) => {
    let reads = 0, decisions = 0;
    org.tasks.get = async () => { reads++; throw Error('must not read'); };
    org.policy.decide = async () => { decisions++; throw Error('must not decide'); };
    await assert.rejects(check({ target: { ...target, authority } }), error => error instanceof InvalidBody
      && /target.authority.*不是任务id或主体岗位/.test(error.message) && /尚未形成权限判定/.test(error.message));
    assert.equal(reads, 0); assert.equal(decisions, 0);
  }));
}

it('workspace来源区错误与任务id误填可纠正，再按真实任务预检；不推进任务', async () => scene(async ({ org, task, check }) => {
  const before = await readFile(org.layout.taskLog(P), 'utf8');
  await assert.rejects(check({ target: { ...target, zone: 'workspace' } }), error => error instanceof InvalidBody && /不是workspace/.test(error.message));
  await assert.rejects(check({ target: { ...target, authority: task.id } }), InvalidBody);
  const corrected = await check();
  assert.equal(corrected.判定.verdict, 'allow');
  assert.match(corrected.说明, /不是文件路径授权/);
  assert.equal(await readFile(org.layout.taskLog(P), 'utf8'), before);
}));

it('未带任务仍拒绝并给出缺项提示，不从本人活动任务推断授权', async () => scene(async ({ check }) => {
  const result = await check({ 任务: undefined });
  assert.equal(result.判定.verdict, 'deny');
  assert.match(result.参数提示, /本次未带顶层「任务」/);
  assert.match(result.参数提示, /不推断已有权限/);
}));

it('合法法律标签的真实拒绝保持原始规则，不因参数纠错变为allow', async () => scene(async ({ org, task, check }) => {
  const legal = { ...target, authority: '法律' };
  const direct = await org.policy.decide({ subject: MEMBER, action: 'write', target: { ...legal, project: P, segment: null, sandbox: false }, context: { task: await org.tasks.get(task.id, { 项目: P }) } });
  const result = await check({ target: legal });
  assert.equal(result.判定.verdict, 'deny');
  assert.deepEqual(result.判定, direct);
  assert.equal(Object.hasOwn(result, '参数提示'), false);
}));

it('正确参数不放行他人任务或未知任务；合法旧数据标签仍由原策略拒绝', async () => scene(async ({ org, check }) => {
  const other = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '他人任务', 负责人: 'member-b', 判据: ['他人交付'] });
  await org.tasks.dispatch(other.id, { subject: LEAD, 项目: P });
  await org.tasks.start(other.id, { subject: { id: 'member-b', kind: '成员', roleId: MEMBER.roleId }, 项目: P });
  assert.equal((await check({ 任务: other.id })).判定.verdict, 'deny');
  await assert.rejects(check({ 任务: 'task-missing' }), /任务不存在/);
  const old = await check({ target: { ...target, zone: '旧数据' } });
  assert.equal(old.判定.verdict, 'deny');
}));

it('未知动作仍拒绝，未识别类型沿用原策略且不当作文件许可', async () => scene(async ({ org, task, check }) => {
  assert.equal((await check({ 动作: 'unknown-action' })).判定.verdict, 'deny');
  const unknown = { ...target, kind: 'unknown-kind' };
  const direct = await org.policy.decide({ subject: MEMBER, action: 'write', target: { ...unknown, project: P, segment: null, sandbox: false }, context: { task: await org.tasks.get(task.id, { 项目: P }) } });
  const result = await check({ target: unknown });
  assert.deepEqual(result.判定, direct);
  assert.match(result.说明, /不是文件路径授权或原生工具许可/);
}));

it('公开工具对坏JSON、数组、裸路径给结构错误；不伪造未知目标的权限拒绝', async () => {
  const f = await makeFixture(), host = fakeHost();
  try {
    await kernel.apply(host.ctx, { home: f.home, privateRoot: f.privateRoot, factoryRoot: f.factoryRoot,
      project: P, projectBindings: [{ path: process.cwd(), project: P }] });
    const tool = host.工具.get('mind');
    const agent = { session: { id: LEAD.id, header: { cwd: process.cwd() } } };
    for (const value of ['{bad', '[]', 'C:/synthetic/workspace/file.mjs', 'null']) {
      const result = JSON.parse(await tool.execute({ action: 'policy_check', target: value }, { agent }));
      assert.equal(result.成功, false);
      assert.equal(result.结果, '结构不合规');
      assert.match(result.理由, /target/);
      assert.equal(Object.hasOwn(result, '要什么授权'), false);
    }
  } finally { host.清理(); await f.cleanup(); }
});
