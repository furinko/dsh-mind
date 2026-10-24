import { it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, LEAD, MEMBER } from './helpers.mjs';
import { Org } from '../src/org.js';
import { injectProfessionalContext, PROFESSIONAL_SECTION } from '../components/kernel/lib/professional-context.js';

const P = 'professional-absence';
const base = () => ({ sections: [{ name: 'host:rules', text: '宿主规则' }], tools: [] });
const frameOf = assembly => JSON.parse(assembly.sections.find(row => row.name === PROFESSIONAL_SECTION).text.split('\n').at(-1));
async function fixture(run) {
  const f = await makeFixture();
  try {
    const org = await Org.open({ home: f.home, privateRoot: f.privateRoot, factoryRoot: f.factoryRoot, project: P });
    const context = { agent: { session: { id: MEMBER.id, header: { cwd: process.cwd(), origin: 'subagent', delegationDepth: 1 } } }, org, projectOf: () => P };
    const task = async () => {
      const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: 'nebula 增量解码', 负责人: MEMBER.roleId, 判据: ['nebula'] });
      await org.tasks.bind(node.id, { subject: LEAD, 项目: P, 实例: MEMBER.id, 岗位: MEMBER.roleId });
      await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
      await org.tasks.start(node.id, { subject: MEMBER, 项目: P });
      return node;
    };
    await run({ org, context, task });
  } finally { await f.cleanup(); }
}

it('无活动绑定不查知识、不发送假空结果，同时移除旧专业段', async () => fixture(async ({ org, context }) => {
  let queried = 0; org.memory.query = async () => { queried++; throw Error('no query expected'); };
  const stale = { ...base(), sections: [...base().sections, { name: PROFESSIONAL_SECTION, text: 'old-private-summary' }] };
  const result = await injectProfessionalContext(stale, context);
  assert.equal(queried, 0);
  assert.deepEqual(result, base());
  assert.doesNotMatch(JSON.stringify(result), /old-private-summary|知识/);
}));

it('有真实活动绑定且查询零命中仍发送真实空结果，不与未查询混淆', async () => fixture(async ({ org, context, task }) => {
  await task();
  const original = org.memory.query.bind(org.memory); const queries = [];
  org.memory.query = async spec => { queries.push({ kind: spec.类, recheck: Boolean(spec.数据版本) }); return original(spec); };
  const result = await injectProfessionalContext(base(), context);
  assert.deepEqual(queries, [{ kind: '知识', recheck: false }, { kind: '经历', recheck: false }, { kind: '知识', recheck: true }, { kind: '经历', recheck: true }]);
  assert.equal(frameOf(result).状态, '已装配');
  assert.deepEqual(frameOf(result).知识, []);
}));

it('交卷后不重读账本、不保留旧正文或空帧，原始采用声明仍在', async () => fixture(async ({ org, context, task }) => {
  const known = await org.memory.remember({ subject: LEAD, 项目: P, 类: '知识', 岗位: MEMBER.roleId, 内容: 'nebula private-summary', 来源: '合成夹具' });
  const node = await task();
  const prior = await injectProfessionalContext(base(), context);
  assert.deepEqual(frameOf(prior).知识.map(row => row.id), [known.id]);
  await org.tasks.submit(node.id, { subject: MEMBER, 项目: P, 结论: '交付待验收', 采用知识: [{ id: known.id, 用途: '核对分块状态', 适用判断: '分块字节输入', 使用结果: '未知' }] });
  let queried = 0; org.memory.query = async () => { queried++; throw Error('no query expected'); };
  const result = await injectProfessionalContext(prior, context);
  assert.equal(queried, 0); assert.deepEqual(result, base());
  assert.doesNotMatch(JSON.stringify(result), /private-summary|知识/);
  assert.equal((await org.knowledgeReuse.query({ subject: LEAD, 项目: P, 任务: node.id })).采用页.条目[0].采用知识[0].id, known.id);
}));

it('Lead确实执行空查询时仍提供当前查询结果', async () => fixture(async ({ org }) => {
  const options = { agent: { session: { id: LEAD.id, header: { cwd: process.cwd() } } }, org, projectOf: () => P };
  const frame = frameOf(await injectProfessionalContext(base(), options));
  assert.equal(frame.岗位, 'Lead'); assert.equal(frame.状态, '已装配'); assert.deepEqual(frame.知识, []);
}));
