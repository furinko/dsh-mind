// scan-turn-errors.mjs — 扫**全部**会话，列出指定时间之后的失败回合。
// 用法：node scan-turn-errors.mjs <sessions 根> [起始 ISO 时间，如 2026-09-29T18:05]
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const root = process.argv[2];
const since = process.argv[3] ? new Date(process.argv[3]).getTime() : 0;
if (!root) { console.error('用法：node scan-turn-errors.mjs <sessions 根> [起始 ISO]'); process.exit(2); }

function readAll(f) {
  const buf = readFileSync(f);
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const pos = [];
  for (let i = 0; i + 4 <= buf.length; i += 1) if (buf.compare(magic, 0, 4, i, i + 4) === 0) pos.push(i);
  const parts = [];
  for (let k = 0; k < pos.length; k += 1) {
    const e = k + 1 < pos.length ? pos[k + 1] : buf.length;
    try { parts.push(zstdDecompressSync(buf.subarray(pos[k], e)).toString('utf8')); } catch { /* skip */ }
  }
  return parts.join('');
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/^session.*\.jsonl\.zstd$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(root);
console.log(`共 ${files.length} 个会话；只看 ${since ? new Date(since).toLocaleString('sv-SE') : '全部'} 之后的失败\n`);

let total = 0;
for (const f of files) {
  let lines;
  try { lines = readAll(f).split('\n').filter(Boolean); } catch { continue; }
  const hits = [];
  for (const l of lines) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (o?.type !== 'turn/end') continue;
    const k = o?.data?.reason?.kind;
    if (k !== 'error' && k !== 'interrupted') continue;
    if (o.time < since) continue;
    hits.push({ t: new Date(o.time).toLocaleString('sv-SE'), turn: o.data.turn, kind: k, msg: o.data?.reason?.error?.message ?? '' });
  }
  if (hits.length === 0) continue;
  total += hits.length;
  const sid = f.split(/[\\/]/).slice(-2)[0];
  console.log(`══ ${sid}`);
  for (const h of hits) console.log(`   ${h.t}  turn=${h.turn}  ${h.kind}${h.msg ? '  ⚠️ ' + h.msg : ''}`);
  console.log('');
}
console.log(total === 0 ? '✅ 该时间之后**无**失败回合' : `共 ${total} 个失败回合`);
