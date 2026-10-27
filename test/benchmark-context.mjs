import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// Run explicitly: node test/benchmark-context.mjs [source-root] [receipt.json].
// All writes use synthetic temporary fixtures; never connects to a running host.
const root = resolve(process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)));
const load = path => import(pathToFileURL(resolve(root, path)).href);
const { makeFixture, LEAD } = await load('test/helpers.mjs');
const { fakeHost } = await load('test/host-harness.mjs');
const { shareOrg, forgetSharedOrg, shareKey } = await load('src/runtime.js');
const { apply } = await load('components/kernel/lib/index.js');
const f = await makeFixture(), project = 'performance-synthetic';
const config = { home: f.home, privateRoot: f.privateRoot, factoryRoot: f.factoryRoot, project,
  projectBindings: [{ path: process.cwd(), project }] };
const org = await shareOrg(config), events = [], nodes = [];
const session = { id: LEAD.id, header: { id: LEAD.id, cwd: process.cwd() }, inheritedEventCount: 0,
  get seq() { return events.length; }, get surface() { return { nodes: [...nodes] }; },
  eventAt: seq => events[seq], isOwnSeq: seq => seq >= 0 && seq < events.length };
function append(type, data, surfaceOp) {
  events.push({ seq: events.length, type, data, time: Date.now(), ...(surfaceOp ? { surfaceOp } : {}) });
  if (surfaceOp === 'append') nodes.push(events.length - 1);
}
const query = { async observeSession() { return { source: 'live', header: session.header, inheritedEventCount: 0,
  cursor: session.seq - 1, events: [...events], [Symbol.dispose]() {} }; } };
const host = fakeHost({ 服务: { sessionQuery: query }, 提供服务: ['tools', 'commands', 'systemPrompt', 'sessionQuery'] });
const summarize = samples => {
  const sorted = [...samples].sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))],
    min: sorted[0], max: sorted.at(-1) };
};
try {
  await org.memory.remember({ subject: LEAD, 项目: project, 类: '偏好', 内容: '简洁表达', 来源: 'synthetic fixture',
    连续性: { 类别: '用户偏好', 主题: '表达', 依据: '明确表达', 范围: '部署' } });
  await apply(host.ctx, config);
  const hook = host.钩子.get('system-prompt/assemble').at(-1);
  let calls = 0, refreshMs = 0;
  const refresh = org.policy.refreshIfStale.bind(org.policy);
  org.policy.refreshIfStale = async (...args) => {
    const at = performance.now(); calls++;
    try { return await refresh(...args); } finally { refreshMs += performance.now() - at; }
  };
  const samples = [], refreshSamples = [], callSamples = [], frameHashes = new Set();
  for (let turn = 0; turn < 35; turn++) {
    append('turn/start', { turn });
    append('user/message', { id: `synthetic-${turn}`, role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: `普通聊天第${turn}句` }] }, 'append');
    calls = 0; refreshMs = 0;
    const input = { sections: [{ name: 'host:rules', text: 'Stable synthetic host rules.' }], contexts: [] };
    const at = performance.now();
    const out = await hook(input, { agent: { session } }, async () => input);
    const elapsed = performance.now() - at;
    assert.ok(out.contexts.some(c => c.name === 'mind:lead-continuity'));
    assert.ok(out.contexts.some(c => c.name === 'mind:information-growth'));
    assert.ok(!out.contexts.some(c => c.name === 'mind:project-brief'));
    if (turn >= 5) {
      samples.push(elapsed); refreshSamples.push(refreshMs); callSamples.push(calls);
      frameHashes.add(createHash('sha256').update(JSON.stringify(out)).digest('hex'));
    }
    append('turn/end', { turn, reason: { kind: 'completed' } });
  }
  assert.equal(frameHashes.size, 1);
  const signatureSamples = [];
  for (let i = 0; i < 100; i++) { const at = performance.now(); assert.equal((await refresh()).changed, false); signatureSamples.push(performance.now() - at); }
  const result = { at: new Date().toISOString(), root, node: process.version, warmups: 5, samples: samples.length,
    assemblyMs: summarize(samples), policyRefreshMs: summarize(refreshSamples), policyRefreshCalls: summarize(callSamples),
    singleRefreshMs: summarize(signatureSamples), dependencyFiles: org.policy.authSig.路径.length,
    stableProjection: true, externalModelRequests: 0, productionDataAccess: false,
    policySHA256: createHash('sha256').update(await readFile(resolve(root, 'src/policy.js'))).digest('hex'),
    limits: 'Synthetic fixture; full kernel hook with fake host services, no real Agent/provider or native client latency measurement.' };
  if (process.argv[3]) await writeFile(resolve(process.argv[3]), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  host.清理(); await org.turnBufferHooks?.flush(); await org.projectBriefHooks?.flush();
  await org.observability.flush(); forgetSharedOrg(shareKey(config)); await f.cleanup();
}
