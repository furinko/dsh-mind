import { it } from 'node:test';
import assert from 'node:assert/strict';
import { Org } from '../src/org.js';
import { makeFixture, LEAD, SOVEREIGN } from './helpers.mjs';
import { runAction } from '../lib/actions.js';

const P = 'information-lifecycle-conflicts';
const spec = (subject = LEAD) => ({ subject, project: P, session: subject.id });
async function scene(run) {
  const f = await makeFixture(); const org = await Org.open({ ...f, project: P });
  try { await run(org); } finally { await org.observability.flush(); await f.cleanup(); }
}
async function source(org) {
  const item = await org.information.deposit(spec(SOVEREIGN), { producer: 'fixture', externalId: 'one', title: '竹笛',
    text: '竹笛可以模仿鸟叫。短片可以比较不同气息。', coverage: '合成文字',
    scope: { project: null, relationship: null, audience: 'auto', roles: [] } });
  const reading = await org.information.read(spec(), { id: item.id });
  return { type: 'growth', kind: '兴趣', title: '竹笛兴趣', text: '我想听听竹笛怎样模仿鸟叫。',
    sources: [{ readingId: reading.readingId, quote: '竹笛可以模仿鸟叫' }] };
}
const active = async org => (await org.memory.query({ subject: LEAD, 读者: LEAD, 项目: P, 类: '偏好', 返回模式: '全文' })).条目;
const reviseAction = (org, data) => runAction({ org, 项目: P, subject: LEAD, 主体: LEAD,
  宿主: { project: P, agent: { session: { id: LEAD.id, header: { cwd: process.cwd() } } } },
  args: { action: 'information_update', 信息: { op: 'revise', data } } });

for (const disposition of ['invalidate', 'demote', 'overturn']) {
  it(`正式记忆的人侧${disposition}阻止Lead从收录入口恢复或重写`, async () => scene(async org => {
    const r = await org.information.record(spec(), await source(org));
    if (disposition === 'overturn') await org.memory.overturn(r.nativeId, { subject: SOVEREIGN, 新条目: '本人纠正后的文字', 理由: '人侧纠正' });
    else await org.memory[disposition](r.nativeId, { subject: SOVEREIGN, 原因: '人侧停用' });
    const before = await org.information.load();
    await assert.rejects(reviseAction(org, { id: r.id, revision: r.revision, state: 'active', reason: '尝试恢复' }), { code: 'DENIED' });
    await assert.rejects(reviseAction(org, { id: r.id, revision: r.revision, text: '模型的新措辞', reason: '尝试重写' }), { code: 'DENIED' });
    assert.deepEqual((await org.information.load()).records, before.records);
  }));
}
it('模型自己的淡去可恢复，普通读面仍隐藏淡去正文且不会留下空草稿', async () => scene(async org => {
  const r = await org.information.record(spec(), await source(org));
  const dormant = await org.information.revise(spec(), { id: r.id, revision: r.revision, state: 'dormant', reason: '暂时搁置' });
  assert.equal(dormant.text, ''); assert.equal((await active(org)).length, 0);
  const resumed = await reviseAction(org, { id: r.id, revision: dormant.revision, state: 'active', reason: '恢复兴趣' });
  assert.equal(resumed.数据.text, r.text); assert.equal(resumed.数据.integration, 'complete');
  assert.equal((await active(org)).length, 1); await org.information.prepareLearning(spec());
}));
it('人侧仍可显式恢复正式停用，并可修复旧版本保存的空待处理回执', async () => scene(async org => {
  const r = await org.information.record(spec(), await source(org));
  await org.memory.invalidate(r.nativeId, { subject: SOVEREIGN, 原因: '人侧停用' });
  const restored = await org.information.admin(spec(SOVEREIGN), { op: 'revise', id: r.id, revision: r.revision, state: 'active', reason: '本人恢复' });
  assert.equal(restored.nativeActive, true); assert.equal(restored.text, r.text);
  await org.information.locked(state => { const row = state.records.find(x => x.id === r.id); row.text = ''; row.integration = 'pending'; });
  const repaired = await org.information.admin(spec(SOVEREIGN), { op: 'revise', id: r.id, revision: restored.revision, state: 'active', reason: '修复旧回执' });
  assert.equal(repaired.text, r.text); assert.equal(repaired.integration, 'complete'); await org.information.prepareLearning(spec());
}));
it('人侧停用正式知识后，重分配与replaces也不能重新生成有效副本', async () => scene(async org => {
  const input = { ...await source(org), kind: '知识', roles: ['插件工程'] };
  const r = await org.information.record(spec(), input);
  await org.memory.invalidate(r.nativeId, { subject: SOVEREIGN, 原因: '人侧停用知识' });
  const before = (await org.information.load()).records;
  await assert.rejects(org.information.distribute(spec(), { id: r.id, revision: r.revision, roles: [], reason: '收回Lead' }), { code: 'DENIED' });
  await assert.rejects(org.information.record(spec(), { ...input, text: '模型替代旧认识', replaces: [{ id: r.id, revision: r.revision }] }), { code: 'DENIED' });
  assert.deepEqual((await org.information.load()).records, before);
}));
it('正式记忆在准备后被人侧停用时，提交点拒绝复活且重试仍拒绝', async () => scene(async org => {
  const r = await org.information.record(spec(), await source(org));
  const original = org.memory.rememberIntake.bind(org.memory); let once = true;
  org.memory.rememberIntake = async input => {
    if (once) { once = false; await org.memory.invalidate(r.nativeId, { subject: SOVEREIGN, 原因: '准备后撤回' }); }
    return original(input);
  };
  await assert.rejects(reviseAction(org, { id: r.id, revision: r.revision, text: '我想进一步了解竹笛的气息。', reason: '新认识' }));
  assert.equal((await active(org)).length, 0);
  await assert.rejects(org.information.settlePending(spec()));
  assert.equal((await active(org)).length, 0);
}));
it('人侧处置在替代链中间或多岗位副本中仍承重', async () => scene(async org => {
  const input = await source(org);
  const r = await org.information.record(spec(), input);
  const one = await org.memory.overturn(r.nativeId, { subject: LEAD, 新条目: '模型第一版修订', 理由: '再理解' });
  const two = await org.memory.overturn(one.新条目, { subject: SOVEREIGN, 新条目: '本人纠正', 理由: '人侧更正' });
  await org.memory.overturn(two.新条目, { subject: LEAD, 新条目: '模型后续版本', 理由: '再理解' });
  await assert.rejects(reviseAction(org, { id: r.id, revision: r.revision, state: 'active', reason: '尝试沿旧回执恢复' }), { code: 'DENIED' });
  const knowledge = await org.information.record(spec(), { ...input, kind: '知识', text: '竹笛气息比较方法', roles: ['Lead', '插件工程'] });
  assert.equal(knowledge.native.length, 2);
  await org.memory.invalidate(knowledge.native[1].id, { subject: SOVEREIGN, 原因: '人侧停用第二份知识' });
  await assert.rejects(org.information.distribute(spec(), { id: knowledge.id, revision: knowledge.revision, roles: [], reason: '收回Lead' }), { code: 'DENIED' });
}));
it('记录已物理删除时，恢复失败不能保存新的空待处理状态', async () => scene(async org => {
  const r = await org.information.record(spec(), await source(org));
  await org.memory.purge(r.nativeId, { subject: SOVEREIGN, 理由: '人侧明确删除' });
  const before = (await org.information.load()).records;
  await assert.rejects(reviseAction(org, { id: r.id, revision: r.revision, state: 'active', text: '模型重写', reason: '试图补回' }), { code: 'INFORMATION_NATIVE_CHANGED' });
  assert.deepEqual((await org.information.load()).records, before);
}));
it('来源已撤回的淡去记录不能恢复，也不留下新草稿', async () => scene(async org => {
  const r = await org.information.record(spec(), await source(org));
  const dormant = await org.information.revise(spec(), { id: r.id, revision: r.revision, state: 'dormant', reason: '暂时搁置' });
  const item = (await org.information.load()).items.find(i => i.id === r.sources[0].item);
  await org.information.admin(spec(SOVEREIGN), { op: 'forget', id: item.id, revision: item.revision });
  const before = (await org.information.load()).records;
  await assert.rejects(reviseAction(org, { id: r.id, revision: dormant.revision, state: 'active', reason: '试图恢复旧来源' }));
  assert.deepEqual((await org.information.load()).records, before);
}));
it('能力候选自淡去恢复保留方法条件和局限，不把缺字段写成undefined正文', async () => scene(async org => {
  const r = await org.information.record(spec(), { ...await source(org), type: 'candidate', kind: undefined,
    method: '先比较两段气息', conditions: '短片覆盖完整', limitations: '只代表小样本', roles: ['插件工程'] });
  const dormant = await org.information.revise(spec(), { id: r.id, revision: r.revision, state: 'dormant', reason: '暂时搁置' });
  const restored = await reviseAction(org, { id: r.id, revision: dormant.revision, state: 'active', reason: '重新试用' });
  assert.equal(restored.数据.method, r.method); assert.equal(restored.数据.conditions, r.conditions);
  assert.equal(restored.数据.limitations, r.limitations); assert.equal(restored.数据.text, r.text);
}));
it('替代提交被人侧撤回拦住后，修订待处理新记录不能丢弃原记忆依赖', async () => scene(async org => {
  const input = await source(org); const old = await org.information.record(spec(), input);
  const original = org.memory.rememberIntake.bind(org.memory); let once = true;
  org.memory.rememberIntake = async args => {
    if (once) { once = false; await org.memory.invalidate(old.nativeId, { subject: SOVEREIGN, 原因: '替代提交前撤回' }); }
    return original(args);
  };
  await assert.rejects(org.information.record(spec(), { ...input, text: '我想进一步比较竹笛和口哨。', replaces: [{ id: old.id, revision: old.revision }] }), { code: 'DENIED' });
  const pending = (await org.information.load()).records.find(r => r.id !== old.id);
  assert.equal(pending.integration, 'pending'); assert.equal(pending.native?.length ?? 0, 0);
  assert.ok(pending.retire.some(n => n.id === old.nativeId));
  assert.ok(pending.nativeGuard.ids.includes(old.nativeId));
  for (const changes of [{ state: 'active' }, { text: '模型给待处理替代记录换个说法' }]) {
    await assert.rejects(reviseAction(org, { id: pending.id, revision: pending.revision, reason: '恢复待处理记录', ...changes }), { code: 'DENIED' });
    assert.deepEqual((await org.information.load()).records.find(r => r.id === pending.id), pending);
  }
  assert.equal((await active(org)).length, 0);
  const restored = await org.information.admin(spec(SOVEREIGN), { op: 'revise', id: pending.id, revision: pending.revision, state: 'active', reason: '本人确认采用新理解' });
  assert.equal(restored.nativeActive, true); assert.equal(restored.text, pending.text);
}));
it('未发生人侧撤回的待处理替代记录仍能由Lead恢复', async () => scene(async org => {
  const input = await source(org); const old = await org.information.record(spec(), input);
  const original = org.memory.rememberIntake.bind(org.memory); let once = true;
  org.memory.rememberIntake = async args => { if (once) { once = false; throw new Error('injected-before-native-write'); } return original(args); };
  await assert.rejects(org.information.record(spec(), { ...input, text: '我想进一步比较竹笛和口哨。', replaces: [{ id: old.id, revision: old.revision }] }), /injected-before-native-write/);
  const pending = (await org.information.load()).records.find(r => r.id !== old.id);
  const restored = await reviseAction(org, { id: pending.id, revision: pending.revision, state: 'active', reason: '恢复失败提交' });
  assert.equal(restored.数据.nativeActive, true); assert.equal(restored.数据.text, pending.text);
}));
it('替代一条尚未完成的替代记录，继续继承原记忆的提交期撤回限制', async () => scene(async org => {
  const input = await source(org); const a = await org.information.record(spec(), input);
  const original = org.memory.rememberIntake.bind(org.memory); let mode = 'interrupt';
  org.memory.rememberIntake = async args => {
    if (mode === 'interrupt') { mode = 'normal'; throw new Error('injected-pending-B'); }
    if (mode === 'human-stop') { mode = 'normal'; await org.memory.invalidate(a.nativeId, { subject: SOVEREIGN, 原因: 'C提交前撤回A' }); }
    return original(args);
  };
  await assert.rejects(org.information.record(spec(), { ...input, text: 'B的暂存理解', replaces: [{ id: a.id, revision: a.revision }] }), /injected-pending-B/);
  const b = (await org.information.load()).records.find(r => r.id !== a.id);
  mode = 'human-stop';
  await assert.rejects(org.information.record(spec(), { ...input, text: 'C对B的后续理解', replaces: [{ id: b.id, revision: b.revision }] }), { code: 'DENIED' });
  const c = (await org.information.load()).records.find(r => r.id !== a.id && r.id !== b.id);
  assert.ok(c.nativeGuard.ids.includes(a.nativeId)); assert.ok(c.retire.some(n => n.id === a.nativeId));
  assert.equal((await active(org)).length, 0);
}));
it('没有人侧撤回时，多层待处理替代能正常落账并退休原正式条目', async () => scene(async org => {
  const input = await source(org); const a = await org.information.record(spec(), input);
  const original = org.memory.rememberIntake.bind(org.memory); let once = true;
  org.memory.rememberIntake = async args => { if (once) { once = false; throw new Error('injected-pending-B'); } return original(args); };
  await assert.rejects(org.information.record(spec(), { ...input, text: 'B的暂存理解', replaces: [{ id: a.id, revision: a.revision }] }), /injected-pending-B/);
  const b = (await org.information.load()).records.find(r => r.id !== a.id);
  const c = await org.information.record(spec(), { ...input, text: 'C对B的后续理解', replaces: [{ id: b.id, revision: b.revision }] });
  assert.equal(c.nativeActive, true); assert.equal(c.text, 'C对B的后续理解');
  assert.equal(await org.memory.intakeActive(a.nativeId), false);
  assert.deepEqual((await active(org)).map(r => r.id), [c.nativeId]);
}));

// This shape was produced by real 49a272c Org code, not an invented corruption:
// A native -> interrupted replacement B(retire=A) -> interrupted C(replaces=B,
// retire=[], no nativeGuard). The independent old-source audit records that seed.
async function legacyPending(org) {
  const input = await source(org); const a = await org.information.record(spec(), input);
  const original = org.memory.rememberIntake.bind(org.memory);
  org.memory.rememberIntake = async () => { throw new Error('legacy-seed-interruption'); };
  await assert.rejects(org.information.record(spec(), { ...input, text: '旧版B', replaces: [{ id: a.id, revision: a.revision }] }), /legacy-seed-interruption/);
  const b = (await org.information.load()).records.find(r => r.text === '旧版B');
  await assert.rejects(org.information.record(spec(), { ...input, text: '旧版C', replaces: [{ id: b.id, revision: b.revision }] }), /legacy-seed-interruption/);
  await org.information.locked(state => {
    for (const row of state.records.filter(r => !r.native?.length)) delete row.nativeGuard;
    state.records.find(r => r.text === '旧版C').retire = [];
  });
  org.memory.rememberIntake = original;
  return { a, c: (await org.information.load()).records.find(r => r.text === '旧版C') };
}
it('旧版丢失见证的pending替代拒绝自动恢复，人侧核对后的新版本可正常修订', async () => scene(async org => {
  const { a, c } = await legacyPending(org);
  await org.memory.invalidate(a.nativeId, { subject: SOVEREIGN, 原因: '升级后人侧停用原认识' });
  for (const changes of [{ state: 'active' }, { text: '模型自行恢复旧草稿' }]) {
    await assert.rejects(reviseAction(org, { id: c.id, revision: c.revision, reason: '旧版恢复', ...changes }), { code: 'DENIED' });
  }
  const restored = await org.information.admin(spec(SOVEREIGN), { op: 'revise', id: c.id, revision: c.revision, state: 'active', reason: '本人核对旧链并采用C' });
  assert.equal(restored.nativeActive, true);
  const changed = await reviseAction(org, { id: c.id, revision: restored.revision, text: '新版本正常后续理解', reason: '正常修订' });
  assert.equal(changed.数据.nativeActive, true); assert.equal(changed.数据.text, '新版本正常后续理解');
}));
for (const chain of ['missing', 'cycle']) {
  it(`旧版pending替代链${chain}时连人侧恢复也不能猜测缺失的依赖`, async () => scene(async org => {
    const { c } = await legacyPending(org);
    await org.information.locked(state => { state.records.find(r => r.id === c.id).replaces = [chain === 'cycle' ? c.id : 'missing-record']; });
    const before = (await org.information.load()).records;
    await assert.rejects(org.information.admin(spec(SOVEREIGN), { op: 'revise', id: c.id, revision: c.revision, state: 'active', reason: '核对旧版记录' }), { code: 'INFORMATION_NATIVE_CHANGED' });
    assert.deepEqual((await org.information.load()).records, before);
  }));
}
it('新格式确实没有正式依赖的pending草稿替代保留空见证并可正常恢复', async () => scene(async org => {
  const input = await source(org); const original = org.memory.rememberIntake.bind(org.memory);
  org.memory.rememberIntake = async () => { throw new Error('new-draft-interruption'); };
  await assert.rejects(org.information.record(spec(), input), /new-draft-interruption/);
  const first = (await org.information.load()).records[0];
  await assert.rejects(org.information.record(spec(), { ...input, text: '没有正式原件的新理解', replaces: [{ id: first.id, revision: first.revision }] }), /new-draft-interruption/);
  const next = (await org.information.load()).records.find(r => r.id !== first.id);
  assert.deepEqual(next.nativeGuard.ids, []); assert.equal(next.retire.length, 0);
  org.memory.rememberIntake = original;
  const restored = await reviseAction(org, { id: next.id, revision: next.revision, state: 'active', reason: '恢复新草稿' });
  assert.equal(restored.数据.nativeActive, true);
}));
