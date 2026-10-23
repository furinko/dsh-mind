import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { makeFixture, LEAD, MEMBER } from './helpers.mjs';
import { Org } from '../src/org.js';
import { injectProfessionalContext } from '../components/kernel/lib/professional-context.js';
import { createProfessionalReceipts } from '../components/kernel/lib/professional-receipts.js';
import { fakeHost } from './host-harness.mjs';
import * as kernel from '../components/kernel/lib/index.js';

const P = 'professional-receipts';
const base = () => ({ sections: [], tools: [] });
const agentOf = () => ({ session: { id: MEMBER.id, header: { cwd: process.cwd(), origin: 'subagent', delegationDepth: 1 }, surface: { replaceGeneration: 0 } } });
async function fixture(run) {
  const f = await makeFixture();
  const host = fakeHost();
  try {
    const org = await Org.open({ home: f.home, privateRoot: f.privateRoot, factoryRoot: f.factoryRoot, project: P });
    const known = await org.memory.remember({ subject: LEAD, 项目: P, 类: '知识', 岗位: MEMBER.roleId,
      内容: 'nebula private-summary-never-copy', 来源: '合成夹具' });
    const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: 'nebula 交付', 负责人: MEMBER.roleId, 判据: ['nebula'] });
    await org.tasks.bind(node.id, { subject: LEAD, 项目: P, 实例: MEMBER.id, 岗位: MEMBER.roleId });
    await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
    await org.tasks.start(node.id, { subject: MEMBER, 项目: P });
    let project = P;
    const projectOf = () => project;
    const receipts = createProfessionalReceipts({ org, projectOf });
    const agent = agentOf();
    const options = { agent, org, projectOf, receipts };
    const assemble = () => injectProfessionalContext(base(), options);
    const submit = () => org.tasks.submit(node.id, { subject: MEMBER, 项目: P, 结论: '交付待验收', 采用知识: [] });
    await run({ org, f, host, known, node, agent, receipts, options, assemble, submit, setProject: value => { project = value; } });
  } finally { host.清理(); await f.cleanup(); }
}

it('真实内核在成功交卷工具结果附装配事实，拒绝模型伪造；不扩大普通节点或账本投影', async () => fixture(async ({ org, f, host, known, node, agent }) => {
  await kernel.apply(host.ctx, { home: f.home, privateRoot: f.privateRoot, factoryRoot: f.factoryRoot, project: P,
    projectBindings: [{ path: process.cwd(), project: P }] });
  const hook = host.钩子.get('system-prompt/assemble').at(-1);
  await hook(base(), { agent }, async () => base());
  const tool = host.工具.get('mind');
  const failed = JSON.parse(await tool.execute({ action: 'task_submit', id: node.id, 结论: '失败', 知识装配回执: { 知识ID: ['forged'] } }, { agent }));
  assert.equal(failed.成功, false); assert.equal(failed.知识装配回执, undefined);
  assert.match(failed.理由, /未知参数/);
  const result = JSON.parse(await tool.execute({ action: 'task_submit', id: node.id, 结论: '待验收', 采用知识: [] }, { agent }));
  assert.equal(result.成功, true, JSON.stringify(result));
  const receipt = result.知识装配回执;
  assert.deepEqual(receipt.知识ID, [known.id]); assert.deepEqual(receipt.任务, [node.id]);
  assert.match(receipt.范围, /不证明最终请求保留、实际阅读、采用或收益/);
  assert.match(receipt.装配指纹, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(result), /private-summary-never-copy|forged/);
  assert.ok(result.节点.独立答案.every(row => !Object.hasOwn(row, '采用知识') && !Object.hasOwn(row, '知识装配回执')));
  const log = await readFile(org.layout.taskLog(P), 'utf8');
  assert.doesNotMatch(log, /知识装配回执|Mind装配记录|private-summary-never-copy/);
  assert.deepEqual((await org.knowledgeReuse.query({ subject: LEAD, 项目: P, 任务: node.id })).采用页.条目[0].采用知识, []);
  const after = await hook(base(), { agent }, async () => base());
  assert.ok(!after.sections.some(row => row.name === 'mind:professional-context'));
}));

it('没有装配记录为未知，实际零命中装配可回空ID，不能相互冒充', async () => fixture(async ({ org, known, agent, receipts, node, assemble, submit }) => {
  assert.equal(await receipts.beforeSubmit(agent, node.id), null);
  await org.memory.invalidate(known.id, { subject: LEAD, 原因: '合成失效' });
  await assemble();
  const token = await receipts.beforeSubmit(agent, node.id);
  assert.ok(token);
  const result = await submit();
  const receipt = await receipts.afterSubmit(agent, token, result);
  assert.deepEqual(receipt.知识ID, []); assert.equal(receipt.状态, 'Mind装配记录');
}));

it('回执仅对原Agent及任务，跨项目、换会话、替换表面和缺宿主代数均不续用', async () => fixture(async ({ agent, node, receipts, assemble, setProject }) => {
  await assemble();
  assert.equal(await receipts.beforeSubmit(agentOf(), node.id), null);
  assert.equal(await receipts.beforeSubmit(agent, 'other-task'), null);
  setProject('other-project'); assert.equal(await receipts.beforeSubmit(agent, node.id), null); setProject(P);
  agent.session.id = 'other-session'; assert.equal(await receipts.beforeSubmit(agent, node.id), null); agent.session.id = MEMBER.id;
  agent.session.surface.replaceGeneration++; assert.equal(await receipts.beforeSubmit(agent, node.id), null);
  delete agent.session.surface;
  await assemble(); assert.equal(await receipts.beforeSubmit(agent, node.id), null);
}));

it('新装配失败、未执行查询和卸载都撤旧记录；迟到成功不会复活', async () => fixture(async ({ org, agent, node, receipts, assemble }) => {
  await assemble(); assert.ok(await receipts.beforeSubmit(agent, node.id));
  const query = org.memory.query.bind(org.memory);
  org.memory.query = async () => { throw Error('synthetic failure'); };
  await assemble(); assert.equal(await receipts.beforeSubmit(agent, node.id), null);
  org.memory.query = query;
  let release; let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  org.memory.query = async spec => { const result = await query(spec); entered(); await new Promise(resolve => { release = resolve; }); return result; };
  const pending = assemble(); await waiting;
  org.memory.query = async () => { throw Error('newer failed assembly'); };
  await assemble(); release(); await pending;
  assert.equal(await receipts.beforeSubmit(agent, node.id), null);
  org.memory.query = query;
  await assemble(); receipts.close(); assert.equal(await receipts.beforeSubmit(agent, node.id), null);
}));

it('新一代岗位实例即使仍同名也不能拿旧凭证记录交卷', async () => fixture(async ({ org, agent, node, receipts, assemble }) => {
  await assemble();
  const file = org.layout.identityFile();
  const identity = JSON.parse(await readFile(file, 'utf8'));
  identity.members[MEMBER.id].代++;
  await writeFile(file, JSON.stringify(identity));
  assert.equal(await receipts.beforeSubmit(agent, node.id), null);
}));

it('装配后当前读权被拒绝，不以曾经装配绕过交卷前核对', async () => fixture(async ({ org, agent, node, receipts, assemble }) => {
  await assemble();
  const check = org.policy.check.bind(org.policy);
  org.policy.check = async spec => { if (spec.action === 'read' && spec.target?.kind === '任务') throw Error('current read denied'); return check(spec); };
  assert.equal(await receipts.beforeSubmit(agent, node.id), null);
}));

it('交卷期间凭证或表面发生变化也不返回先前捕获的回执', async () => fixture(async ({ org, agent, node, receipts, assemble, submit }) => {
  await assemble(); const token = await receipts.beforeSubmit(agent, node.id); assert.ok(token);
  const result = await submit();
  agent.session.surface.replaceGeneration++;
  assert.equal(await receipts.afterSubmit(agent, token, result), null);
  agent.session.surface.replaceGeneration--;
  const file = org.layout.identityFile(); const identity = JSON.parse(await readFile(file, 'utf8'));
  identity.members[MEMBER.id].代++; await writeFile(file, JSON.stringify(identity));
  assert.equal(await receipts.afterSubmit(agent, token, result), null);
}));

it('交卷后新装配不查询、不续用旧记录；回执副本不能污染本进程或写入旧声明', async () => fixture(async ({ org, agent, node, known, receipts, assemble, submit }) => {
  await assemble(); const token = await receipts.beforeSubmit(agent, node.id);
  const result = await submit();
  const log = await readFile(org.layout.taskLog(P), 'utf8');
  const first = await receipts.afterSubmit(agent, token, result);
  first.知识ID.push('mutated');
  assert.deepEqual((await receipts.afterSubmit(agent, token, result)).知识ID, [known.id]);
  let queries = 0; org.memory.query = async () => { queries++; throw Error('must not query'); };
  await assemble(); assert.equal(queries, 0);
  assert.equal(await receipts.beforeSubmit(agent, node.id), null);
  assert.equal(await receipts.afterSubmit(agent, token, result), null);
  assert.equal(await readFile(org.layout.taskLog(P), 'utf8'), log);
}));

it('项目解析失败仍沿原装配降级，不让观察器阻断系统提示', async () => fixture(async ({ org, agent }) => {
  const projectOf = () => { throw Error('unbound project'); };
  const receipts = createProfessionalReceipts({ org, projectOf });
  assert.deepEqual(await injectProfessionalContext(base(), { agent, org, projectOf, receipts }), base());
}));
