/** 自动连续性只记有原文依据的用户表达；人格资料不成为身份或固定回复。 */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Org } from '../src/org.js';
import { recallLeadContext } from '../src/lead-context.js';
import { makeFixture, LEAD, MEMBER, SOVEREIGN } from './helpers.mjs';

const P = 'continuity-capture';
const Q = 'continuity-capture-other';
const spec = (subject = LEAD, project = P) => ({ subject, project, session: subject.id });
const config = f => ({ home: f.home, privateRoot: f.privateRoot, factoryRoot: f.factoryRoot, project: P });
const proposal = (message, extra = {}) => ({ id: 'lead-name', kind: '人格', scope: '部署', state: '有效',
  text: '用户希望称呼Lead为砚舟', sources: [message.source], quotes: [message.text], ...extra });
const update = (org, extract, target = spec(), extra = {}) => org.continuityCapture.update(target, { extract, ...extra });
const recall = (org, target = spec()) => recallLeadContext({ org, subject: target.subject, project: target.project });
const query = (org, target = spec(), extra = {}) => org.memory.query({ subject: target.subject, 读者: target.subject,
  项目: target.project, 类: '偏好', 返回模式: '全文', limit: 100, ...extra });
const remembered = frame => JSON.stringify(frame.记录);
const stale = error => ['PROJECT_BRIEF_CHANGED', 'PROJECT_BRIEF_SOURCE_CHANGED', 'CONTINUITY_CAPTURE_CHANGED',
  'CONTINUITY_CAPTURE_SOURCE_CHANGED'].includes(error?.code);
const settle = promise => promise.then(value => ({ value }), error => ({ error }));

async function scene(run) {
  const f = await makeFixture(); const org = await Org.open(config(f));
  try { await run({ org, f }); }
  finally { await org.observability.flush(); await f.cleanup(); }
}
async function capture(org, messages, target = spec(), { at = Date.now(), touch = true } = {}) {
  const position = await org.turnBuffer.position(target);
  const fromSeq = position?.nextSeq ?? 0;
  const turn = fromSeq + 1; let seq = fromSeq;
  const records = [{ seq: seq++, type: 'turn/start', turn, time: at }];
  for (const value of messages) {
    const { text, role = 'user', clipped = false, interrupted = false } = typeof value === 'string' ? { text: value } : value;
    records.push({ seq: seq++, type: 'message', turn, role, text, id: `m-${seq}`,
      clipped, interrupted, time: at });
  }
  records.push({ seq: seq++, type: 'turn/end', turn, reason: 'completed', time: at });
  await org.turnBuffer.capture({ ...target, fromSeq, throughSeq: seq, records });
  if (touch) await org.continuityCapture.touch(target);
  return records;
}
async function root(org, id, project = P) {
  const subject = { id, kind: 'Lead' };
  await org.registry.assign({ subject: SOVEREIGN, 岗位: 'Lead', 实例: id });
  for (const session of [LEAD.id, id]) {
    const state = await org.information.load();
    await org.information.admin({ subject: SOVEREIGN, project: P }, { op: 'relationship', expectedRevision: state.configRevision, session, relationship: 'same-human-fixture' });
  }
  return spec(subject, project);
}
function gate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function session(id = LEAD.id, header = {}) {
  return { id, header: { id, cwd: process.cwd(), ...header }, seq: 0, isOwnSeq: () => true,
    requestHeader: () => ({ config: { provider: 'isolated', model: 'fixture' } }) };
}
function model(extract) {
  return { async prepareCall(config, signal) {
    return { config, async *stream(options) {
      assert.equal(options.tools, undefined);
      const input = JSON.parse(options.messages[0].content[0].text);
      const output = JSON.stringify(await extract(input, signal));
      yield { type: 'block-end', index: 0, block: { type: 'text', text: output } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } };
  } };
}

it('自然称呼与表达偏好自动写正式记忆，Org重开与新Lead可召回，名称不固定为DeepSeek', async () => scene(async ({ org, f }) => {
  await capture(org, ['以后叫你砚舟吧，和我说话自然一点，先说明结果。']);
  await update(org, input => {
    assert.ok(Array.isArray(input.remembered));
    const message = input.messages.find(m => m.role === 'user');
    return { items: [proposal(message, { quotes: ['以后叫你砚舟吧'] }),
      proposal(message, { id: 'reply-style', kind: '用户偏好', text: '自然交流并先说明结果', quotes: ['和我说话自然一点，先说明结果'] })] };
  });
  const reopened = await Org.open(config(f));
  const next = await root(reopened, 'new-continuity-lead');
  const frame = await recall(reopened, next);
  assert.match(remembered(frame), /砚舟/);
  assert.match(remembered(frame), /自然交流并先说明结果/);
  assert.doesNotMatch(remembered(frame), /DeepSeek|你必须固定回复|我叫DeepSeek/);
  assert.equal(frame.记录.find(r => r.摘要.includes('砚舟')).连续性.类别, '人格');
  assert.equal(frame.记录.find(r => r.摘要.includes('砚舟')).连续性.依据, '明确表达');
  assert.notEqual(org.continuityCapture.file(P), org.projectBrief.file(P));
}));

it('同一主题的后续明确更正自动替换旧称呼，旧正式条目退出召回', async () => scene(async ({ org }) => {
  await capture(org, ['以后叫你砚舟。']);
  await update(org, input => ({ items: [proposal(input.messages[0])] }));
  const old = (await recall(org)).记录.find(r => r.摘要.includes('砚舟'));
  await capture(org, ['改一下，之后叫你栖川。']);
  await update(org, input => ({ items: [proposal(input.messages.find(m => m.role === 'user'), { text: '用户希望称呼Lead为栖川' })] }));
  const frame = await recall(org);
  assert.match(remembered(frame), /栖川/);
  assert.doesNotMatch(remembered(frame), /砚舟/);
  assert.ok(!frame.记录.some(r => r.id === old.id));
  const history = await query(org, spec(), { id: old.id, 含失效: true });
  assert.ok(history.条目.some(r => r.id === old.id && r.状态 !== '有效'));
}));

it('用户停止某主题形成不召回的正式墓碑，重试与旧会话补读不能复活该称呼', async () => scene(async ({ org }) => {
  const now = Date.now();
  await capture(org, ['以后叫你砚舟。'], spec(), { at: now - 10000 });
  await update(org, input => ({ items: [proposal(input.messages[0])] }));
  await capture(org, ['不要再用这个称呼，也别把它作为偏好带进新会话。'], spec(), { at: now });
  await update(org, input => ({ items: [proposal(input.messages[0], { state: '停止', text: '用户停止使用此前的Lead称呼' })] }));
  assert.doesNotMatch(remembered(await recall(org)), /砚舟/);
  const oldRoot = await root(org, 'restored-older-name');
  await capture(org, ['以后叫你砚舟。'], oldRoot, { at: now - 5000 });
  const result = await settle(update(org, input => ({ items: [proposal(input.messages[0])] }), oldRoot));
  if (result.error) assert.ok(result.error.code === 'INVALID_BODY' || result.error.code === 'DENIED' || stale(result.error), String(result.error));
  assert.doesNotMatch(remembered(await recall(org, oldRoot)), /砚舟/);
}));

it('记忆已提交但后续回执失败时重试认回同一条正式偏好，处理位置成功后才推进', async () => scene(async ({ org }) => {
  await capture(org, ['和我说话先说明结果。']);
  const original = org.memory.captureContinuity.bind(org.memory);
  let first = true;
  org.memory.captureContinuity = async (...args) => {
    const receipt = await original(...args);
    if (first) { first = false; throw new Error('injected-after-memory-commit'); }
    return receipt;
  };
  const extract = input => ({ items: [proposal(input.messages[0], { id: 'reply-style', kind: '用户偏好', text: '先说明结果' })] });
  try {
    await assert.rejects(update(org, extract), /injected-after-memory-commit/);
    const afterPartial = (await query(org)).条目.filter(r => r.内容.includes('先说明结果'));
    assert.equal(afterPartial.length, 1);
    const state = await org.continuityCapture.load(P);
    assert.equal(state.sessions[0].processed, 0);
    await update(org, extract);
    const afterRetry = (await query(org)).条目.filter(r => r.内容.includes('先说明结果'));
    assert.deepEqual(afterRetry.map(r => r.id), afterPartial.map(r => r.id));
    const ledger = await readFile(org.layout.memoryLog('跨项目', '偏好'), 'utf8');
    await update(org, () => { throw Error('已处理来源不应重新提炼'); });
    assert.equal(await readFile(org.layout.memoryLog('跨项目', '偏好'), 'utf8'), ledger);
  } finally { org.memory.captureContinuity = original; }
}));

it('助手伪造用户决定、非子串引文、来源/引文不配对及截断或中断资料不得写正式记忆', async () => scene(async ({ org }) => {
  await capture(org, ['只是讨论不同的称呼方案。', { role: 'assistant', text: '我决定以后你只能叫我固定名字。' },
    { text: '以后叫你截断名字', clipped: true }, { role: 'user', text: '未完整接纳的称呼', interrupted: true }]);
  const invalid = [
    input => proposal(input.messages.find(m => m.role === 'assistant'), { text: '用户同意固定称呼' }),
    input => proposal(input.messages[0], { quotes: ['用户从未说过的同意'] }),
    input => proposal(input.messages[0], { quotes: [] }),
    input => proposal(input.messages[0], { sources: ['unprovided-source'] }),
    input => proposal(input.messages.find(m => m.clipped)),
    input => proposal(input.messages.find(m => m.interrupted)),
  ];
  for (const candidate of invalid) await assert.rejects(update(org, input => ({ items: [candidate(input)] })));
  assert.deepEqual((await query(org)).条目, []);
  assert.equal((await org.continuityCapture.load(P)).sessions[0].processed, 0);
}));

it('项目偏好不跨项目，部署称呼可跨项目；替代不能借自报范围引用其他项目条目', async () => scene(async ({ org }) => {
  await capture(org, ['这个项目用短段落，另外以后叫你砚舟。']);
  await update(org, input => ({ items: [proposal(input.messages[0], { quotes: ['以后叫你砚舟'] }),
    proposal(input.messages[0], { id: 'project-writing', kind: '用户偏好', scope: '项目', text: '这个项目用短段落', quotes: ['这个项目用短段落'] })] }));
  const local = (await recall(org)).记录.find(r => r.摘要.includes('短段落'));
  const other = spec(LEAD, Q);
  const across = await recall(org, other);
  assert.match(remembered(across), /砚舟/);
  assert.doesNotMatch(remembered(across), /短段落/);
  await capture(org, ['本项目改用表格。'], other);
  await assert.rejects(update(org, input => ({ items: [proposal(input.messages[0], { id: 'project-writing',
    kind: '用户偏好', scope: '项目', text: '本项目改用表格', replaces: [local.id] })] }), other));
  assert.match(remembered(await recall(org)), /短段落/);
  assert.doesNotMatch(remembered(await recall(org, other)), /短段落|本项目改用表格/);
}));

it('候选只能引用本批用户表达，旧草稿不能借助手后续消息恢复已失效的正式记忆', async () => scene(async ({ org }) => {
  await capture(org, ['以后叫你砚舟。']);
  await update(org, input => ({ items: [proposal(input.messages[0])] }));
  const old = (await recall(org)).记录.find(r => r.摘要.includes('砚舟'));
  await org.memory.invalidate(old.id, { subject: LEAD, 原因: '停止沿用旧称呼' });
  await capture(org, [{ role: 'assistant', text: '我还想沿用旧称呼。' }]);
  await assert.rejects(update(org, input => {
    const source = input.previous[0]?.sources[0];
    assert.ok(source);
    return { items: [{ ...proposal({ source, text: '以后叫你砚舟。' }), text: '恢复此前被停止的砚舟称呼', quotes: ['以后叫你砚舟。'] }] };
  }));
  assert.doesNotMatch(remembered(await recall(org)), /砚舟/);
}));

it('提炼期间撤回来源使候选失效，正式记忆和处理位置均不提前提交', async () => scene(async ({ org }) => {
  await capture(org, ['以后叫你砚舟。']);
  await assert.rejects(update(org, async input => {
    const position = await org.turnBuffer.position(spec());
    await org.turnBuffer.forget({ ...spec(), throughSeq: position.nextSeq });
    await org.continuityCapture.touch(spec());
    return { items: [proposal(input.messages[0])] };
  }), stale);
  assert.deepEqual((await query(org)).条目, []);
  assert.equal((await org.continuityCapture.load(P)).sessions[0].processed, 0);
}));

it('来源在正式记忆方法入口后被清空，落账提交点仍复核fence并拒绝写入', async () => scene(async ({ org }) => {
  await capture(org, ['以后叫你砚舟。']);
  const original = org.memory.captureContinuity.bind(org.memory);
  let cleared = false;
  org.memory.captureContinuity = async (...args) => {
    if (!cleared) {
      cleared = true;
      const position = await org.turnBuffer.position(spec());
      await org.turnBuffer.forget({ ...spec(), throughSeq: position.nextSeq });
    }
    return original(...args);
  };
  try {
    await assert.rejects(update(org, input => ({ items: [proposal(input.messages[0])] })), stale);
    assert.ok(cleared);
    assert.deepEqual((await query(org)).条目, []);
    assert.equal((await org.continuityCapture.load(P)).sessions[0].processed, 0);
  } finally { org.memory.captureContinuity = original; }
}));

it('候选返回前卸载或active变化不会留下正式偏好，也不推进整理位置', async () => scene(async ({ org }) => {
  await capture(org, ['以后叫你砚舟。']);
  let active = true;
  const result = await settle(update(org, input => {
    active = false;
    return { items: [proposal(input.messages[0])] };
  }, spec(), { active: () => active }));
  if (result.error) assert.ok(result.error.code === 'DENIED' || stale(result.error), String(result.error));
  assert.deepEqual((await query(org)).条目, []);
  assert.equal((await org.continuityCapture.load(P)).sessions[0].processed, 0);
}));

it('替代既有人工正式人格须引用本批remembered中同类同范围id，不能跨类别替代', async () => scene(async ({ org }) => {
  const personality = await org.memory.remember({ subject: LEAD, 类: '偏好', 项目: P,
    内容: '用户此前称呼Lead为素白', 来源: '用户此前明确表达', 连续性: { 类别: '人格', 主题: '称呼', 依据: '明确表达', 范围: '部署' } });
  const preference = await org.memory.remember({ subject: LEAD, 类: '偏好', 项目: P,
    内容: '先说明结果', 来源: '用户此前明确表达', 连续性: { 类别: '用户偏好', 主题: '表达方式', 依据: '明确表达', 范围: '部署' } });
  await capture(org, ['之后叫你砚舟。']);
  await assert.rejects(update(org, input => ({ items: [proposal(input.messages[0], { replaces: [preference.id] })] })));
  await update(org, input => {
    assert.ok(input.remembered.some(record => record.id === personality.id));
    return { items: [proposal(input.messages[0], { replaces: [personality.id] })] };
  });
  const frame = await recall(org);
  assert.match(remembered(frame), /砚舟/);
  assert.doesNotMatch(remembered(frame), /素白/);
  assert.ok(frame.记录.some(row => row.id === preference.id));
}));

it('不支持的类别/范围、超长正文和未知字段拒绝，不能借自动记忆修改规程或权限', async () => scene(async ({ org }) => {
  await capture(org, ['交流时直接些，不用套固定开场白。']);
  const invalid = [
    { kind: '协作教训' }, { kind: '权限' }, { scope: '全部用户' }, { state: '已认证' },
    { text: 'x'.repeat(321) }, { 自动授权: true }, { quotes: [''] }, { replaces: ['pref-unprovided'] },
  ];
  for (const extra of invalid) await assert.rejects(update(org, input => ({ items: [proposal(input.messages[0], extra)] })));
  assert.deepEqual((await query(org)).条目, []);
  await assert.rejects(org.continuityCapture.touch(spec(MEMBER)), { code: 'DENIED' });
}));

it('连续性hooks轮末自动提炼；组件卸载中断在途模型，不能落正式记忆', async () => scene(async ({ org }) => {
  const { createContinuityCaptureHooks } = await import('../components/kernel/lib/continuity-capture-hooks.js');
  const started = gate(); const release = gate();
  const hooks = createContinuityCaptureHooks({ org, projectOf: () => P, llmOf: () => model(async input => {
    assert.ok(Array.isArray(input.remembered));
    started.resolve(); await release.promise;
    return { items: [proposal(input.messages.find(m => m.role === 'user'))] };
  }), logger: { warn() {} } });
  try {
    await capture(org, ['以后叫你砚舟。']);
    await hooks.persisted(session(), { summarize: true });
    await started.promise;
    hooks.stop(); release.resolve(); await hooks.flush();
    assert.deepEqual((await query(org)).条目, []);
    assert.equal((await org.continuityCapture.load(P)).sessions[0].processed, 0);
  } finally { release.resolve(); hooks.stop(); await hooks.flush(); }
}));

it('pending装配只带新用户原文，已invalid的正式称呼及旧草稿不能重新进入上下文', async () => scene(async ({ org }) => {
  const mod = await import('../components/kernel/lib/continuity-capture-hooks.js');
  await capture(org, ['以后叫你砚舟。']);
  await update(org, input => ({ items: [proposal(input.messages[0])] }));
  const old = (await recall(org)).记录.find(row => row.摘要.includes('砚舟'));
  await org.memory.invalidate(old.id, { subject: LEAD, 原因: '用户停止沿用旧资料' });
  await capture(org, ['这次语气轻松一些。', { role: 'assistant', text: 'assistant-only-stale-name' }]);
  const hooks = mod.createContinuityCaptureHooks({ org, projectOf: () => P, llmOf: () => null, logger: { warn() {} } });
  const base = { sections: [{ name: 'host', text: 'host' }] };
  try {
    const out = await mod.injectPendingContinuity(base, { agent: { session: session() }, org, hooks, projectOf: () => P });
    assert.match(JSON.stringify(out), /语气轻松一些/);
    assert.doesNotMatch(JSON.stringify(out), /砚舟|assistant-only-stale-name/);
    assert.doesNotMatch(remembered(await recall(org)), /砚舟/);
  } finally { hooks.stop(); await hooks.flush(); }
}));

it('示例对白或讨论名字不靠关键词强制写记忆，空提炼保留已有正式偏好', async () => scene(async ({ org }) => {
  await capture(org, ['以后叫你砚舟。']);
  await update(org, input => ({ items: [proposal(input.messages[0])] }));
  const original = (await recall(org)).记录.find(row => row.摘要.includes('砚舟'));
  await capture(org, ['我们在写一段示例对白，角色说“以后叫你墨白”。这不是在给你改称呼。']);
  await update(org, input => {
    assert.match(input.messages[0].text, /这不是在给你改称呼/);
    return { items: [] };
  });
  const frame = await recall(org);
  assert.ok(frame.记录.some(row => row.id === original.id));
  assert.match(remembered(frame), /砚舟/);
  assert.doesNotMatch(remembered(frame), /墨白|固定开场白|DeepSeek/);
}));

it('模型更换主题标签时可通过remembered精确纠正旧主题，不能留下两套称呼', async () => scene(async ({ org }) => {
  await capture(org, ['以后叫你素白。']);
  await update(org, input => ({ items: [proposal(input.messages[0], { id: 'legacy-name-topic', text: '用户称呼Lead为素白' })] }));
  const old = (await recall(org)).记录.find(row => row.摘要.includes('素白'));
  await capture(org, ['之前的称呼改成砚舟。']);
  await update(org, input => {
    const supplied = input.remembered.find(record => record.id === old.id);
    assert.ok(supplied && supplied.kind === '人格' && supplied.scope === '部署');
    return { items: [proposal(input.messages[0], { id: 'lead-name', replaces: [old.id] })] };
  });
  const frame = await recall(org);
  assert.match(remembered(frame), /砚舟/);
  assert.doesNotMatch(remembered(frame), /素白/);
  const history = await query(org, spec(), { id: old.id, 含失效: true });
  assert.ok(history.条目.some(row => row.id === old.id && row.状态 !== '有效'));
}));

it('晚补读但早于正式invalid的用户来源不能覆盖停用，真正后续新表达才可恢复', async () => scene(async ({ org }) => {
  const now = Date.now();
  await capture(org, ['以后叫你素白。'], spec(), { at: now - 20000 });
  await update(org, input => ({ items: [proposal(input.messages[0], { text: '用户称呼Lead为素白' })] }));
  const old = (await recall(org)).记录.find(row => row.摘要.includes('素白'));
  await org.memory.invalidate(old.id, { subject: LEAD, 原因: '用户人侧停止使用该称呼' });
  const restored = await root(org, 'name-before-formal-invalidation');
  await capture(org, ['以后叫你砚舟。'], restored, { at: now - 10000 });
  const result = await settle(update(org, input => ({ items: [proposal(input.messages[0])] }), restored));
  if (result.error) assert.ok(result.error.code === 'INVALID_BODY' || result.error.code === 'CONTINUITY_OLDER_SOURCE'
    || stale(result.error), String(result.error));
  assert.doesNotMatch(remembered(await recall(org, restored)), /素白|砚舟/);
  await capture(org, ['现在恢复这个约定，之后叫你栖川。'], restored, { at: Date.now() + 100 });
  await update(org, input => ({ items: [proposal(input.messages.find(m => m.text.includes('现在恢复')), { text: '用户称呼Lead为栖川' })] }), restored);
  assert.match(remembered(await recall(org, restored)), /栖川/);
}));

it('轮末hooks成功写正式偏好，新会话由正式Lead资料召回而非旧pending草稿', async () => scene(async ({ org }) => {
  const mod = await import('../components/kernel/lib/continuity-capture-hooks.js');
  let calls = 0;
  const hooks = mod.createContinuityCaptureHooks({ org, projectOf: () => P, llmOf: () => model(input => {
    calls++;
    return { items: [proposal(input.messages.find(m => m.role === 'user'))] };
  }), logger: { warn() {} } });
  try {
    await capture(org, ['以后叫你砚舟。']);
    await hooks.persisted(session(), { summarize: true });
    await hooks.flush();
    assert.equal(calls, 1);
    const next = await root(org, 'name-from-official-memory');
    assert.match(remembered(await recall(org, next)), /砚舟/);
    const base = { sections: [{ name: 'host', text: 'host' }] };
    assert.deepEqual((await mod.injectPendingContinuity(base, { agent: { session: session(next.session) },
      org, hooks, projectOf: () => P })).sections, base.sections);
  } finally { hooks.stop(); await hooks.flush(); }
}));

it('pending段在停用、成员、切项目和卸载时移除，不沿用上一会话私人文本', async () => scene(async ({ org }) => {
  const mod = await import('../components/kernel/lib/continuity-capture-hooks.js');
  await capture(org, ['以后叫你砚舟。']);
  const base = { sections: [{ name: 'host', text: 'host' }] };
  const stale = { sections: [...base.sections, { name: mod.PENDING_CONTINUITY_SECTION, text: 'stale-private-name' }] };
  const disabled = mod.createContinuityCaptureHooks({ org, projectOf: () => P, enabled: false });
  assert.deepEqual((await mod.injectPendingContinuity(stale, { agent: { session: session() }, org,
    hooks: disabled, projectOf: () => P })).sections, base.sections);
  const hooks = mod.createContinuityCaptureHooks({ org, projectOf: () => P, llmOf: () => null, logger: { warn() {} } });
  try {
    const child = session(MEMBER.id, { origin: 'subagent', delegationDepth: 1 });
    assert.deepEqual((await mod.injectPendingContinuity(stale, { agent: { session: child }, org,
      hooks, projectOf: () => P })).sections, base.sections);
    let project = P;
    const original = org.continuityCapture.read.bind(org.continuityCapture);
    org.continuityCapture.read = async (...args) => { const frame = await original(...args); project = Q; return frame; };
    try {
      assert.deepEqual((await mod.injectPendingContinuity(stale, { agent: { session: session() }, org,
        hooks, projectOf: () => project })).sections, base.sections);
    } finally { org.continuityCapture.read = original; }
    hooks.stop();
    assert.deepEqual((await mod.injectPendingContinuity(stale, { agent: { session: session() }, org,
      hooks, projectOf: () => P })).sections, base.sections);
  } finally { disabled.stop(); hooks.stop(); await hooks.flush(); }
}));

it('升级首次touch可从本项目旧projectBrief登记补读称呼，用户无需重复原话', async () => scene(async ({ org, f }) => {
  const original = '以后叫你砚舟吧，聊天自然些。';
  await capture(org, [original], spec(), { touch: false, at: Date.now() - 10000 });
  await org.projectBrief.touch(spec());
  await capture(org, ['其他项目的私有称呼不要混入'], spec(LEAD, Q), { touch: false });
  await org.projectBrief.touch(spec(LEAD, Q));
  assert.equal((await org.continuityCapture.load(P)).sessions.length, 0);
  const reopened = await Org.open(config(f));
  const next = await root(reopened, 'upgraded-new-root');
  await reopened.continuityCapture.touch(next);
  const state = await reopened.continuityCapture.load(P);
  const source = state.sessions.find(s => s.id === LEAD.id);
  assert.ok(source);
  assert.equal(source.processed, (await reopened.turnBuffer.load(P, LEAD.id)).floor);
  await update(reopened, input => {
    assert.deepEqual(input.messages.map(m => m.text), [original]);
    assert.equal(input.messages[0].session, LEAD.id);
    return { items: [proposal(input.messages[0], { quotes: ['以后叫你砚舟吧'] })] };
  }, next);
  assert.match(remembered(await recall(reopened, next)), /砚舟/);
}));

it('已落memory但回执失败后purge，重试不复活且墓碑只留散列屏障不留原话', async () => scene(async ({ org }) => {
  const originalText = '以后叫你砚舟，私有称呼来源校验9274。';
  await capture(org, [originalText]);
  const original = org.memory.captureContinuity.bind(org.memory);
  let first = true;
  org.memory.captureContinuity = async (...args) => {
    const receipt = await original(...args);
    if (first) { first = false; throw new Error('injected-before-cursor-receipt'); }
    return receipt;
  };
  const extract = input => ({ items: [proposal(input.messages[0])] });
  try {
    await assert.rejects(update(org, extract), /injected-before-cursor-receipt/);
    assert.equal((await org.continuityCapture.load(P)).sessions[0].processed, 0);
    const written = (await query(org)).条目.find(row => row.内容.includes('砚舟'));
    assert.ok(written);
    await org.memory.purge(written.id, { subject: SOVEREIGN, 理由: '用户明确要求删除记忆' });
    const file = org.layout.memoryLog('跨项目', '偏好');
    const ledger = await readFile(file, 'utf8');
    assert.doesNotMatch(ledger, /砚舟|私有称呼来源校验9274/);
    const barriers = ledger.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).map(row => row.自动连续性墓碑).filter(Boolean);
    assert.ok(barriers.length > 0);
    for (const barrier of barriers) {
      assert.deepEqual(Object.keys(barrier).sort(), ['主题哈希', '幂等键', '于', '项目', '范围', '归属会话'].sort());
      assert.match(barrier.归属会话, /^[a-f0-9]{64}$/);
      assert.match(barrier.主题哈希, /^[a-f0-9]{64}$/);
      assert.match(barrier.幂等键, /^continuity:[a-f0-9]{64}$/);
      assert.ok(Number.isFinite(barrier.于));
      assert.equal(barrier.项目, P);
      assert.equal(barrier.范围, '部署');
      assert.ok(!JSON.stringify(barrier).includes(originalText));
    }
    const result = await settle(update(org, extract));
    if (result.error) assert.ok(result.error.code === 'CONTINUITY_OLDER_SOURCE' || stale(result.error), String(result.error));
    assert.doesNotMatch(remembered(await recall(org)), /砚舟/);
    assert.deepEqual((await query(org)).条目, []);
  } finally { org.memory.captureContinuity = original; }
}));

for (const operation of ['purge', 'invalid']) {
  it(`记忆落账回执失败后${operation}，新Lead的pending屏蔽旧称呼并保留治理后新表达`, async () => scene(async ({ org }) => {
    const mod = await import('../components/kernel/lib/continuity-capture-hooks.js');
    const oldText = '以后叫你砚舟，旧原话不应绕过正式治理。';
    await capture(org, [oldText], spec(), { at: Date.now() - 10000 });
    const original = org.memory.captureContinuity.bind(org.memory);
    org.memory.captureContinuity = async (...args) => {
      await original(...args);
      throw new Error('injected-pending-receipt-loss');
    };
    try {
      await assert.rejects(update(org, input => ({ items: [proposal(input.messages[0])] })), /injected-pending-receipt-loss/);
    } finally { org.memory.captureContinuity = original; }
    assert.equal((await org.continuityCapture.load(P)).sessions[0].processed, 0);
    const written = (await query(org)).条目.find(row => row.内容.includes('砚舟'));
    assert.ok(written);
    if (operation === 'purge') await org.memory.purge(written.id, { subject: SOVEREIGN, 理由: '用户明确要求删除记忆' });
    else await org.memory.invalidate(written.id, { subject: LEAD, 原因: '用户人侧停止使用该称呼' });

    const next = await root(org, `pending-after-${operation}`);
    const hooks = mod.createContinuityCaptureHooks({ org, projectOf: () => P, llmOf: () => null, logger: { warn() {} } });
    const base = { sections: [{ name: 'host', text: 'host' }] };
    const stale = { sections: [...base.sections, { name: mod.PENDING_CONTINUITY_SECTION, text: oldText }] };
    const inject = assembly => mod.injectPendingContinuity(assembly, { agent: { session: session(next.session) }, org, hooks, projectOf: () => P });
    try {
      assert.deepEqual((await inject(stale)).sections, base.sections);
      assert.doesNotMatch(remembered(await recall(org, next)), /砚舟/);
      const freshText = '之后交流时直接一些，先说明结果。';
      await capture(org, [freshText], next, { at: Date.now() + 100 });
      const refreshed = await inject(base);
      const pending = refreshed.sections.find(section => section.name === mod.PENDING_CONTINUITY_SECTION);
      assert.ok(pending);
      assert.match(pending.text, /之后交流时直接一些，先说明结果/);
      assert.doesNotMatch(pending.text, /砚舟|旧原话不应绕过正式治理/);
    } finally { hooks.stop(); await hooks.flush(); }
  }));
}
