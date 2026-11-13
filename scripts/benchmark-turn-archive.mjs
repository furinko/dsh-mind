/** Synthetic storage/capture comparison only. Pass a baseline source module path.
 * Both implementations write exclusively to makeFixture() temporary layouts.
 * No real conversations, model requests, profiles or running hosts are used. */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Org } from '../src/org.js';
import { TurnBufferService, projectTurnEvent } from '../src/turn-buffer.js';
import { makeFixture, LEAD } from '../test/helpers.mjs';
import { injectTurnBuffer } from '../components/kernel/lib/turn-buffer-hooks.js';
import { memoryTree } from '../src/memory-layout-migration.js';

if (!process.argv[2]) throw Error('Usage: node scripts/benchmark-turn-archive.mjs <baseline src/turn-buffer.js>');
const baseline = await import(pathToFileURL(resolve(process.argv[2])).href);
const project = 'synthetic-turn-benchmark';
function eventsFor(count) {
  const events = []; const time = Date.now();
  const append = (type, data, surfaceOp) => events.push({ seq: events.length, time, type, data, surfaceOp });
  for (let turn = 1; turn <= count; turn++) {
    append('turn/start', { turn });
    append('user/message', { id: `u-${turn}`, role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: turn === Math.floor(count / 2) ? 'BEGIN' + '完整经历'.repeat(20000) + 'END' : `round-${turn}:` + '需求细节'.repeat(250) }] }, 'append');
    append('assistant/message', { turn, message: { id: `a-${turn}`, role: 'assistant',
      content: [{ type: 'text', text: `answer-${turn}:` + '结果证据'.repeat(250) }] } }, 'append');
    append('turn/end', { turn, reason: { kind: 'completed' } });
  }
  return events;
}
async function measure(module, events, candidate) {
  const f = await makeFixture(); let org;
  try {
    org = await Org.open({ ...f, project });
    org.turnBuffer = new module.TurnBufferService({ layout: org.layout, org, clock: org.clock });
    const spec = { subject: LEAD, project, session: LEAD.id };
    const records = events.map(event => module.projectTurnEvent(event));
    const start = performance.now();
    for (let offset = 0; offset < events.length; offset += 1024) await org.turnBuffer.capture({ ...spec,
      records: records.slice(offset, offset + 1024), fromSeq: offset, throughSeq: Math.min(events.length, offset + 1024) });
    const captureMs = performance.now() - start;
    const state = await org.turnBuffer.load(project, LEAD.id);
    const queryStart = performance.now();
    const frame = await org.turnBuffer.read({ ...spec, budget: 3600, limit: 8 });
    const queryMs = performance.now() - queryStart;
    const section = await injectTurnBuffer({ sections: [] }, { org, agent: { session: {
      id: LEAD.id, header: { id: LEAD.id, cwd: f.home }, seq: events.length, surface: { nodes: [] },
      isOwnSeq: seq => seq >= 0 && seq < events.length } },
      hooks: { health: () => ({ enabled: true, stopped: false }), sync: async () => {} }, projectOf: () => project });
    const storedMessages = state.rounds.flatMap(round => round.messages);
    let summary = null;
    if (candidate) {
      const bytesBefore = (await memoryTree(org.layout.memoryRoot())).reduce((n, row) => n + (row.bytes ?? 0), 0);
      const summaryStart = performance.now();
      const receipt = await org.turnSummaries.summarize(spec);
      const summaryMs = performance.now() - summaryStart;
      const bytesAfter = (await memoryTree(org.layout.memoryRoot())).reduce((n, row) => n + (row.bytes ?? 0), 0);
      summary = { mode: receipt.mode, sourceCount: receipt.sourceCount, addedMemoryBytes: bytesAfter - bytesBefore,
        elapsedMs: +summaryMs.toFixed(2), modelRequests: 0 };
    }
    return { storedRounds: state.rounds.length, storedMessages: storedMessages.length,
      storedTextChars: storedMessages.reduce((n, m) => n + m.text.length, 0),
      storageBytes: candidate ? (await org.turnBuffer.storageUsage(spec)).总字节 : (await stat(org.turnBuffer.file(project, LEAD.id))).size,
      captureMs: +captureMs.toFixed(2), queryMs: +queryMs.toFixed(2),
      queryFrameChars: JSON.stringify(frame).length, automaticContextChars: section.sections.reduce((n, s) => n + s.text.length, 0),
      ...(candidate ? { summary } : {}) };
  } finally { await org?.observability.flush(); await f.cleanup(); }
}
const rows = [];
for (const turns of [20, 140, 1000]) {
  const events = eventsFor(turns);
  const old = await measure(baseline, events, false);
  const current = await measure({ TurnBufferService, projectTurnEvent }, events, true);
  const sourceTextChars = events.reduce((n, event) => n + (event.data.content ?? event.data.message?.content ?? []).reduce((v, b) => v + (b.text?.length ?? 0), 0), 0);
  rows.push({ turns, sourceTextChars, baseline: old, current });
}
process.stdout.write(JSON.stringify({ kind: 'synthetic-storage-and-capture', measuredAt: new Date().toISOString(),
  baselineModule: resolve(process.argv[2]), modelRequests: 0,
  note: 'Single samples, including filesystem effects; not a latency distribution, model cost or production benefit claim.', rows }, null, 2) + '\n');
