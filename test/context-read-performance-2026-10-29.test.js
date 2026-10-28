import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rename, rm, stat, utimes } from 'node:fs/promises';
import { makeFixture, LEAD, SOVEREIGN } from './helpers.mjs';
import { Org } from '../src/org.js';
import { InformationService } from '../src/information.js';
import { injectProfessionalContext } from '../components/kernel/lib/professional-context.js';
import { injectLeadContext } from '../components/kernel/lib/lead-context.js';
import { injectInformationContext } from '../components/kernel/lib/information-hooks.js';
import { projectMindRuntimeContext, withMindReadSnapshot } from '../components/kernel/lib/runtime-context.js';

const P = 'read-performance';
const spec = (subject = LEAD) => ({ subject, project: P, session: subject.id });
const base = () => ({ sections: [{ name: 'host', text: 'host rules' }], contexts: [], tools: [], variables: {} });
async function fixture(run) {
  const f = await makeFixture(); const org = await Org.open({ ...f, project: P });
  try { await org.information.locked(() => {}); await run(org, f); }
  finally { await org.observability.flush(); await f.cleanup(); }
}
const countLoads = service => {
  const load = service.load.bind(service); let count = 0;
  service.load = async () => { count++; return load(); };
  return () => count;
};
async function replaceState(service, change) {
  const state = JSON.parse(await readFile(service.file, 'utf8')); change(state);
  const temp = service.file + '.external'; await writeFile(temp, JSON.stringify(state)); await rename(temp, service.file);
}

it('同一次读取共享不可变数据，并发与嵌套读取不重复解析；普通load仍返回独立可写数据', () => fixture(async org => {
  const service = org.information; const count = countLoads(service);
  await service.withReadSnapshot(async () => {
    const states = await Promise.all(Array.from({ length: 40 }, () => service.readState()));
    assert.ok(states.every(state => state === states[0]));
    assert.ok(Object.isFrozen(states[0].config)); assert.ok(Object.isFrozen(states[0].records));
    assert.throws(() => { states[0].config.paused = true; }, TypeError);
    await service.withReadSnapshot(async () => assert.equal(await service.readState(), states[0]));
    assert.equal(count(), 1);
  });
  const first = await service.load(); const second = await service.load();
  assert.notEqual(first, second); first.config.paused = true; assert.equal(second.config.paused, false);
}));

it('两个同时进行的装配互不共享快照；装配退出后不保留读取缓存', () => fixture(async org => {
  const service = org.information; const count = countLoads(service);
  let arrivals = 0; const ready = Promise.withResolvers();
  const read = () => service.withReadSnapshot(async () => {
    const state = await service.readState(); if (++arrivals === 2) ready.resolve(); await ready.promise;
    assert.equal(await service.readState(), state); return state;
  });
  const [a, b] = await Promise.all([read(), read()]); assert.notEqual(a, b); assert.equal(count(), 2);
  await service.withReadSnapshot(() => service.readState()); assert.equal(count(), 3);
}));

it('同尺寸原地改写并恢复mtime仍通过ctime识别，不能继续交付旧资料', () => fixture(async org => {
  const service = org.information; const before = await stat(service.file);
  await assert.rejects(service.withReadSnapshot(async () => {
    const old = await service.readState(); const raw = await readFile(service.file, 'utf8');
    const bytes = raw.replace(/("dailySourceReads":\s*)1/, '$12'); assert.equal(Buffer.byteLength(bytes), before.size);
    await writeFile(service.file, bytes); await utimes(service.file, before.atime, before.mtime);
    assert.equal((await service.readState()).config.dailySourceReads, 2); assert.equal(old.config.dailySourceReads, 1);
  }), { code: 'INFORMATION_SCOPE_CHANGED' });
}));

it('原子替换、删除和损坏文件均不能命中旧快照，读取结束前还会复核文件', () => fixture(async org => {
  const service = org.information;
  await assert.rejects(service.withReadSnapshot(async () => {
    await service.readState(); await replaceState(service, state => { state.config.paused = true; });
    assert.equal((await service.readState()).config.paused, true);
  }), { code: 'INFORMATION_SCOPE_CHANGED' });
  await assert.rejects(service.withReadSnapshot(async () => {
    await service.readState(); await replaceState(service, state => { state.revision++; });
  }), { code: 'INFORMATION_SCOPE_CHANGED' });
  await assert.rejects(service.withReadSnapshot(async () => {
    await service.readState(); await writeFile(service.file, '{broken');
    await assert.rejects(service.readState(), { code: 'INFORMATION_STATE_INVALID' });
  }), { code: 'INFORMATION_SCOPE_CHANGED' });
  await rm(service.file);
  await service.locked(() => {});
  await assert.rejects(service.withReadSnapshot(async () => {
    await service.readState(); await rm(service.file);
    // An absent file is a fresh empty state, never the previously loaded file.
    assert.equal((await service.readState()).revision, 0);
  }), { code: 'INFORMATION_SCOPE_CHANGED' });
}));

it('写事务及提交检查不使用只读快照，写入仍持久化且使当前装配失效', () => fixture(async org => {
  const service = org.information;
  await assert.rejects(service.withReadSnapshot(async () => {
    await service.readState();
    await service.locked(async state => {
      const fresh = await service.readState(); assert.equal(Object.isFrozen(fresh), false);
      state.config.paused = true;
    });
    assert.equal((await service.readState()).config.paused, true);
  }), { code: 'INFORMATION_SCOPE_CHANGED' });
  assert.equal((await service.load()).config.paused, true);
}));

it('装配结束后继承异步上下文的后台回调仍重新读盘', () => fixture(async org => {
  const service = org.information; const go = Promise.withResolvers(); let background;
  await service.withReadSnapshot(async () => {
    await service.readState(); background = (async () => { await go.promise; return service.readState(); })();
  });
  await replaceState(service, state => { state.config.paused = true; }); go.resolve();
  assert.equal((await background).config.paused, true);
}));

it('实际召回的内容与原读取路径一致，条目增加不再逐条重新读取收录账本', () => fixture(async org => {
  const service = org.information;
  const scope = { project: null, audience: 'auto', roles: [], relationship: null };
  for (let i = 0; i < 10; i++) {
    const item = await service.deposit(spec(SOVEREIGN), { producer: 'fixture', externalId: String(i), title: `knowledge ${i}`, text: 'a real source passage', coverage: 'synthetic fixture', scope });
    const reading = await service.read(spec(), { id: item.id, limit: 12000 });
    await service.record(spec(), { type: 'growth', kind: '知识', title: `knowledge ${i}`, text: `knowledge-body-${i}`, sources: [{ readingId: reading.readingId, quote: reading.text }] });
  }
  const options = { org, agent: { session: { id: LEAD.id, header: { cwd: process.cwd() } } }, projectOf: () => P };
  const assemble = async () => {
    let out = await injectProfessionalContext(base(), options);
    out = await injectLeadContext(out, options); out = await injectInformationContext(out, options);
    return projectMindRuntimeContext(out);
  };
  const snapshot = service.withReadSnapshot.bind(service); service.withReadSnapshot = read => read();
  const before = await assemble(); service.withReadSnapshot = snapshot;
  const count = countLoads(service);
  const after = await withMindReadSnapshot(base(), { org }, assemble);
  assert.deepEqual(after, before); assert.match(JSON.stringify(after), /knowledge-body-/);
  assert.ok(count() <= 3, `whole assembly state parses: ${count()}`);
}));

it('另一服务撤回来源后，正在装配的资料全部退出；下一次读取拒绝已撤回记忆', () => fixture(async org => {
  const service = org.information; const item = await service.deposit(spec(SOVEREIGN), {
    producer: 'fixture', externalId: 'revoked', title: 'private', text: 'source for recall', coverage: 'synthetic fixture',
    scope: { project: null, audience: 'auto', roles: [], relationship: null },
  });
  const reading = await service.read(spec(), { id: item.id, limit: 12000 });
  await service.record(spec(), { type: 'growth', kind: '知识', title: 'private', text: 'must-disappear', sources: [{ readingId: reading.readingId, quote: reading.text }] });
  const other = new InformationService({ org, layout: org.layout, clock: org.clock });
  const options = { org, agent: { session: { id: LEAD.id, header: { cwd: process.cwd() } } }, projectOf: () => P };
  const out = await withMindReadSnapshot(base(), { org }, async () => {
    const assembled = await injectProfessionalContext(base(), options); assert.match(JSON.stringify(assembled), /must-disappear/);
    await other.locked(state => { state.items.find(i => i.id === item.id).state = 'withdrawn'; });
    return projectMindRuntimeContext(assembled);
  });
  assert.deepEqual(out, base());
  assert.doesNotMatch(JSON.stringify(await injectProfessionalContext(base(), options)), /must-disappear/);
}));

it('快照失效清掉自动资料但保留宿主规则、钉版规程及工具', () => fixture(async org => {
  const assembly = { ...base(), sections: [...base().sections, { name: 'mind:lead-pinned-rules', text: 'pinned' }, { name: 'mind:persona-core', text: 'old' }],
    contexts: [{ name: 'host:cwd', text: 'cwd' }, { name: 'mind:professional-context', text: 'old secret' }] };
  const out = await withMindReadSnapshot(assembly, { org }, async () => {
    await org.information.readState(); await replaceState(org.information, state => { state.revision++; }); return assembly;
  });
  assert.deepEqual(out.sections.map(s => s.name), ['host', 'mind:lead-pinned-rules']);
  assert.deepEqual(out.contexts.map(s => s.name), ['host:cwd']); assert.equal(out.tools, assembly.tools);
}));
