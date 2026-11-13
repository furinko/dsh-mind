import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { Org } from '../src/org.js';
import { makeFixture, LEAD, MEMBER } from './helpers.mjs';
import { currentConversationScope, recallProfessionalContext } from '../src/professional-context.js';
import { DelegationPolicy } from '../src/delegation-policy.js';
import { matchingBinding } from '../src/tool-file-scope.js';

const P = 'redesign-execution';
async function scene(run) {
  const f = await makeFixture(); const org = await Org.open({ ...f, project: P });
  try { await run(org, f); } finally { await org.observability.flush(); await f.cleanup(); }
}
async function mutate(org, change) {
  const file = org.layout.identityFile(); const id = JSON.parse(await readFile(file, 'utf8'));
  change(id); await writeFile(file, JSON.stringify(id)); await org.policy.reload();
}
const writeSpec = subject => ({ subject, action: 'create', target: { id: 'experience', kind: '经历', authority: '自治', zone: '私有', domain: '个体', project: P } });

it('真实Lead缺岗位卡可正常记录工作与召回，对话不加载任务或岗位卡', () => scene(async org => {
  await mutate(org, id => { delete id.members[LEAD.id].卡版本; });
  org.registry.cardOf = async () => { throw new Error('ordinary recall must not read a role card'); };
  org.tasks.list = async () => { throw new Error('ordinary recall must not depend on tasks'); };
  assert.equal((await org.policy.check(writeSpec(LEAD))).verdict, 'allow');
  assert.equal((await currentConversationScope(org, LEAD)).actor.id, LEAD.id);
  const spec = { subject: LEAD, project: P, session: LEAD.id };
  assert.equal((await org.turnBuffer.position(spec)), null);
  assert.deepEqual((await org.conversationRecall.read(spec, { text: 'fixture' })).条目, []);
}));

it('缺卡与坏卡不放宽真实身份、生命周期及委派归属', () => scene(async org => {
  await mutate(org, id => { delete id.members[LEAD.id].卡版本; delete id.members[MEMBER.id].委派者; });
  await assert.rejects(org.policy.check(writeSpec(MEMBER)), /委派者/);
  await assert.rejects(currentConversationScope(org, { id: MEMBER.id, kind: 'Lead' }), /在岗身份/);
  await assert.rejects(currentConversationScope(org, { id: 'not-registered', kind: 'Lead' }), /在岗身份/);
  await mutate(org, id => { id.members[LEAD.id].status = '封存'; });
  await assert.rejects(org.policy.check(writeSpec(LEAD)), /停用|不在岗/);
  await assert.rejects(currentConversationScope(org, LEAD), /在岗身份/);
}));

it('专业知识按真实专业选材，无卡不妨碍专业知识检索', () => scene(async org => {
  const entry = await org.memory.remember({ subject: LEAD, 类: '知识', 项目: P, 岗位: 'Lead', 内容: 'synthetic coordination method', 来源: 'fixture' });
  await mutate(org, id => { delete id.members[LEAD.id].卡版本; });
  const frame = await recallProfessionalContext({ org, subject: LEAD, project: P });
  assert.equal(frame.知识[0].id, entry.id);
}));

it('出厂通用审批不重复阻断普通工作，明确私有审批限制继续有效', () => scene(async (org, f) => {
  await f.write('集体L2-共享基础设施/defaults/介入度.json', JSON.stringify({ 介入度: '审批' }));
  await org.policy.reload();
  assert.equal((await org.policy.check(writeSpec(LEAD))).verdict, 'allow');
  await f.writePrivate('集体L2-共享基础设施/defaults/部署.json', JSON.stringify({ 介入度: '审批' }));
  await org.policy.reload();
  await assert.rejects(org.policy.check(writeSpec(LEAD)), e => e.name === 'NeedsApproval');
  assert.equal(org.policy.会挂起(writeSpec(LEAD)), true);
}));

it('默认Host模式允许Lead自选普通宿主委派，明确项目限制及宿主身份限制仍生效', () => {
  const policy = new DelegationPolicy(); const spec = { subject: LEAD, project: P };
  assert.equal(policy.creationGuard({ name: 'subagent' }, spec), undefined);
  assert.equal(policy.creationGuard({ name: 'subagent' }, { ...spec, connected: false }), undefined);
  assert.match(policy.creationGuard({ name: 'subagent' }, { ...spec, subject: MEMBER }), /仅允许 Lead/);
  const limited = new DelegationPolicy({ mode: 'host', projects: ['allowed'] });
  assert.match(limited.creationGuard({ name: 'subagent' }, spec), /项目范围限制/);
  const legacy = new DelegationPolicy({ mode: 'lead-discretion', projects: [P], authorizationRef: 'fixture-explicit' });
  assert.equal(legacy.creationGuard({ name: 'subagent' }, spec), undefined, '授权本身不是强制受管流程');
});

it('岗位卡更新不撤销工作绑定，实例重用或宿主代次变化仍使旧绑定失效', () => {
  const binding = { 实例: 'member', 岗位: '工程', 凭证: { 版本: 1, 代: 2, 卡版本摘要: 'old', 宿主代次: 'boot-1' } };
  const member = { 岗位: '工程', 代: 2, 卡版本摘要: 'new', 宿主代次: 'boot-1' };
  assert.equal(matchingBinding(binding, 'member', member), true);
  assert.equal(matchingBinding(binding, 'other', member), false);
  assert.equal(matchingBinding(binding, 'member', { ...member, 代: 3 }), false);
  assert.equal(matchingBinding(binding, 'member', { ...member, 宿主代次: 'boot-2' }), false);
});

it('明确私有审批下多类别清理只挂起一次完整计划，批准后不逐门再问', () => scene(async (org, f) => {
  const { runAction } = await import('../lib/actions.js');
  const entry = await org.memory.remember({ subject: LEAD, 类: '知识', 项目: P, 内容: 'obsolete knowledge', 来源: 'fixture' });
  const derived = await org.memory.remember({ subject: LEAD, 类: '经历', 项目: P, 内容: 'derived observation', 来源: 'fixture', 来源引用: [entry.id] });
  await f.writePrivate('集体L2-共享基础设施/defaults/部署.json', JSON.stringify({ 介入度: '审批' }));
  await org.policy.reload();
  const args = { action: 'memory_organize', op: 'forget', id: entry.id, 原因: 'synthetic forgetting' };
  const execute = args => runAction({ org, 项目: P, 主体: LEAD, args });
  let request;
  await assert.rejects(execute(args), e => e.name === 'NeedsApproval' && Boolean(request = e.detail.请求id));
  assert.equal((await org.memory.query({ subject: LEAD, 项目: P, id: entry.id })).条目.length, 1, '批准前未删除任何正文');
  // The service plan is read only and includes the derived source in another ledger.
  const plan = await org.memory.organizePlan({ ...args, subject: LEAD, 项目: P });
  assert.equal(plan.步骤.length, 2); assert.ok(plan.步骤.every(s => s.上下文.状态 === '物理删除'));
  await org.intervention.人侧决议({ 请求id: request, 决定: '批准', 通道: '设置页', 认证: 'synthetic authenticated fixture' });
  await execute({ ...args, 审批引用: request });
  assert.equal((await org.memory.query({ subject: LEAD, 项目: P, id: entry.id })).条目.length, 0);
  assert.equal((await org.memory.query({ subject: LEAD, 项目: P, id: derived.id })).条目.length, 0);
  await assert.rejects(execute({ ...args, 审批引用: request }));
}));
