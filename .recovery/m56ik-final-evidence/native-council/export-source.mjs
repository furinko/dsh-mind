import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const cid = 'council-mvdqtu70-f0325';
const base = 'C:/Users/wjthq/.dsh/sessions/--C-Users-wjthq-.dsh-plugins--';
const out = 'C:/Users/wjthq/.dsh/plugins/dsh-mind/.recovery/m56ik-final-evidence/native-council';
mkdirSync(out, { recursive: true });
const sha = b => createHash('sha256').update(b).digest('hex');
function load(id) {
  const path = join(base, id, 'session.v4.jsonl.zstd'), bytes = readFileSync(path);
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), starts = [];
  for (let at = bytes.indexOf(magic); at >= 0; at = bytes.indexOf(magic, at + 4)) starts.push(at);
  let text = '', incompleteTail = null;
  for (let i = 0; i < starts.length; i++) {
    try { text += zstdDecompressSync(bytes.subarray(starts[i], starts[i + 1] ?? bytes.length)).toString('utf8'); }
    catch (e) { if (i !== starts.length - 1) throw e; incompleteTail = { offset: starts[i], error: e.message }; }
  }
  const rows = text.split(/\r?\n/).filter(Boolean).map(JSON.parse);
  return { rows, snapshot: { id, path, bytes: bytes.length, sha256: sha(bytes), frames: starts.length, records: rows.length, incompleteTail } };
}
const manifest = { at: new Date().toISOString(), filter: 'Only council-specific native tool/call + paired tool/result events; no system prompts, provider credentials or unrelated project data exported.', sources: [], files: [] };
const actions = new Set(['debate_open', 'debate_answer', 'debate_unlock', 'debate_round', 'debate_say', 'debate_converge', 'workbench']);
for (const id of ['session-ea05d8ff-0aab-45e2-aca4-e263855042b0', '93650aef-9692-4f9b-9093-106b8ee4cc81', '8252e161-1d1c-45df-b05d-097caa5cc890']) {
  const { rows, snapshot } = load(id); manifest.sources.push(snapshot);
  const results = new Map(rows.filter(r => r.type === 'tool/result').map(r => [r.data?.message?.toolCallId, r]));
  const pairs = [];
  for (const call of rows.filter(r => r.type === 'tool/call' && r.data?.name === 'mind')) {
    let args; try { args = JSON.parse(call.data.arguments); } catch { continue; }
    if (!actions.has(args.action)) continue;
    const result = results.get(call.data.callId); if (!result) continue;
    if (args.id !== cid && !(args.action === 'debate_open' && JSON.stringify(result).includes(cid))) continue;
    if (!JSON.stringify(result).includes(cid)) throw new Error('Matched action did not return this council');
    pairs.push({ action: args.action, call, result });
  }
  if (id.startsWith('session-')) for (const name of ['debate_open','debate_unlock','debate_round','debate_converge']) assert.equal(pairs.filter(p => p.action === name).length, 1, name);
  else for (const name of ['debate_answer','debate_say']) assert.equal(pairs.filter(p => p.action === name).length, 1, `${id} ${name}`);
  const filename = `${id}.native-tool-receipts.json`;
  const text = JSON.stringify({ sourceSession: id, sourceSnapshot: snapshot, pairs }, null, 2);
  writeFileSync(join(out, filename), text, { flag: 'wx' });
  manifest.files.push({ name: filename, sha256: sha(text), actions: pairs.map(p => p.action) });
  const descriptor = rows.find(r => r.type === 'subagent/descriptor')?.data;
  if (descriptor) manifest.sources.at(-1).selectedRoute = { provider: descriptor.agentProvider, model: descriptor.agentModel, reasoningEffort: descriptor.agentReasoningEffort };
}
const url = 'http://127.0.0.1:7710/plugins/dsh-mind/workbench?project=plugins';
const response = await fetch(url); assert.equal(response.status, 200);
const body = await response.text(), parsed = JSON.parse(body);
const council = parsed.数据?.会审?.find(x => x.id === cid);
const thread = parsed.数据?.消息总线?.find(x => x.线程 === `会审-${cid}`);
assert.equal(council?.状态, '已收敛'); assert.equal(thread?.最新?.filter(m => m.类型 === '表态').length, 2);
const projection = JSON.stringify({ source: { url, status: response.status, capturedAt: new Date().toISOString(), responseSha256: sha(body), project: parsed.项目, generatedAt: parsed.数据?.生成于 }, council, thread }, null, 2);
writeFileSync(join(out, 'native-workbench-council.json'), projection, { flag: 'wx' });
manifest.files.push({ name: 'native-workbench-council.json', sha256: sha(projection) });
const live = 'C:/Users/wjthq/.dsh/plugins/dsh-mind';
const publication = JSON.parse(readFileSync(join(live, '.recovery/m56ik-final-evidence/final/final-publication-result.json'), 'utf8'));
manifest.liveRecheck = publication.rows.map(row => ({ path: row.rel, expected: row.next, actual: sha(readFileSync(join(live, row.rel))) }));
assert.ok(manifest.liveRecheck.every(row => row.actual === row.expected));
writeFileSync(join(out, 'export-manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ out, files: manifest.files, liveEightMatch: true }, null, 2));
