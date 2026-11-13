import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { makeFixture, LEAD, MEMBER, SOVEREIGN } from './helpers.mjs';
import { Org } from '../src/org.js';
import { createInformationHooks } from '../components/kernel/lib/information-hooks.js';
import { createLeadSpaceHooks } from '../components/kernel/lib/lead-space-hooks.js';

const P = 'personal-no-card';
const spec = (subject = LEAD, project = P) => ({ subject, project, session: subject.id });
const human = () => spec(SOVEREIGN);
const session = () => ({ id: LEAD.id, header: { cwd: process.cwd() }, isOwnSeq: () => true,
  requestHeader: () => ({ config: { provider: 'synthetic', model: 'synthetic' } }) });
async function scene(run) {
  const f = await makeFixture(); const org = await Org.open({ ...f, project: P });
  const originalCore = await readFile(org.layout.personaCoreFile()).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  try {
    const identity = await org.registry.identity(); delete identity.members[LEAD.id].卡版本;
    await writeFile(f.layout.identityFile(), JSON.stringify(identity));
    org.registry.cardOf = async () => { throw Error('普通聊天能力不应加载专业卡'); };
    await run(org, f);
    const afterCore = await readFile(org.layout.personaCoreFile()).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    assert.deepEqual(afterCore, originalCore, '合成核心人设没有反向写入');
  } finally { org.informationHooks?.stop(); org.leadSpaceHooks?.stop(); await org.informationHooks?.flush(); await org.leadSpaceHooks?.flush(); await org.observability.flush(); await f.cleanup(); }
}
const deposit = org => org.information.deposit(human(), { producer: 'synthetic', externalId: 'story', title: '笛声',
  text: '竹笛可以模仿鸟鸣，这是一份合成材料。', coverage: '合成全文',
  scope: { project: null, audience: 'lead', roles: [], relationship: null } });
function model(reply, count) {
  return { async prepareCall(config) { count.calls++; return { config, async *stream(options) {
    assert.equal(options.tools, undefined);
    const input = JSON.parse(options.messages[0].content[0].text);
    yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(reply(input)) } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } }; } };
}

it('真实Lead无专业卡仍可按公开经历成长、记录情绪和随笔；成员与跨项目私人访问仍拒', () => scene(async org => {
  const item = await deposit(org);
  const reading = await org.information.read(spec(), { id: item.id });
  const growth = await org.information.record(spec(), { type: 'growth', kind: '疑问', title: '想听笛声', text: '我想进一步了解笛声如何模拟鸟鸣。', sources: [{ readingId: reading.readingId, quote: '竹笛可以模仿鸟鸣' }] });
  assert.ok(growth.id);
  const affect = await org.leadAffect.update(spec(), { op: 'record', epoch: 0, key: 'synthetic-interest', account: {
    event: '读到合成笛声材料', appraisal: '我有些好奇', feelings: ['好奇'], desires: ['想了解声音'], affect: { valence: 0.3, arousal: 0.2 } } },
  { context: { kind: 'model-self-report', session: LEAD.id, seq: 0, expression: null } });
  assert.equal((await org.leadAffect.query(spec())).entries[0].id, affect.id);
  const note = await org.leadSpace.update(spec(), { op: 'write', title: '合成随笔', text: '小鱼想听听笛声。' });
  assert.equal((await org.leadSpace.query(spec(), { id: note.id })).text, '小鱼想听听笛声。');
  await assert.rejects(org.leadSpace.query(spec(MEMBER)), /Lead/);
  await assert.rejects(org.leadAffect.query(spec(MEMBER)), /Lead/);
  assert.equal((await org.leadSpace.query(spec(LEAD, 'another-project'))).total, 0);
}));

it('无专业卡的后台经历阅读仍使用真实Lead路由，封存身份不触发模型请求或自行复岗', () => scene(async (org, f) => {
  await deposit(org); const count = { calls: 0 };
  const llm = model(input => ({ records: [{ type: 'growth', kind: '疑问', title: '鸟鸣', text: '我想再了解笛声。', quote: input.source.text.slice(0, 8) }] }), count);
  const hooks = createInformationHooks({ org, projectOf: () => P, llmOf: () => llm, logger: { warn() {} } }); org.informationHooks = hooks;
  hooks.schedule(session()); await hooks.flush(); assert.equal(count.calls, 1);
  assert.equal((await org.information.context(spec())).growth.length, 1);
  const identity = await org.registry.identity(); identity.members[LEAD.id].status = '封存';
  await writeFile(f.layout.identityFile(), JSON.stringify(identity));
  hooks.schedule(session()); await hooks.flush(); assert.equal(count.calls, 1);
  assert.equal((await org.registry.identity()).members[LEAD.id].status, '封存');
}));

it('无专业卡可在合成已启用时段进行自由活动，预算/真实运行代次继续约束', () => scene(async (org, f) => {
  org.clock._source = () => new Date('2026-11-13T02:00:00Z');
  const state = await org.leadSpace.load();
  await org.leadSpace.configure(human(), { expectedRevision: state.revision, config: { ...state.config, enabled: true, timezone: 'Asia/Shanghai' } });
  const count = { calls: 0 }; const llm = model(() => ({ activity: 'rest', writing: null, material: null }), count);
  const hooks = createLeadSpaceHooks({ org, projectOf: () => P, llmOf: () => llm, logger: { warn() {} } }); org.leadSpaceHooks = hooks;
  hooks.bind(session()); await hooks.tick(); assert.equal(count.calls, 1);
  assert.equal((await org.leadSpace.load()).wakes[0].state, 'rested');
  const identity = await org.registry.identity();
  identity.members[LEAD.id].代次 = { 代: 'stale-synthetic-host', pid: 999999 };
  identity.members[LEAD.id].运行绑定 = { 状态: '失效' };
  await writeFile(f.layout.identityFile(), JSON.stringify(identity));
  await assert.rejects(org.leadSpace.update(spec(), { op: 'write', title: '迟到', text: '不可写入' }), /旧运行绑定|运行绑定/);
  await hooks.tick(); assert.equal(count.calls, 1); assert.equal(hooks.health().state, 'waiting-for-lead');
}));
