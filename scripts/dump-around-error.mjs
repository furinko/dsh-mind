// dump-around-error.mjs — 打印失败回合前后的原始事件（找上下文）。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const file = process.argv[2];
if (!file) { console.error('用法：node dump-around-error.mjs <session.v4.jsonl.zstd>'); process.exit(2); }

function readAll(f) {
  const buf = readFileSync(f);
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const pos = [];
  for (let i = 0; i + 4 <= buf.length; i += 1) if (buf.compare(magic, 0, 4, i, i + 4) === 0) pos.push(i);
  const parts = [];
  for (let k = 0; k < pos.length; k += 1) {
    const end = k + 1 < pos.length ? pos[k + 1] : buf.length;
    try { parts.push(zstdDecompressSync(buf.subarray(pos[k], end)).toString('utf8')); } catch { /* skip */ }
  }
  return parts.join('');
}

const lines = readAll(file).split('\n').filter(Boolean);
console.log(`共 ${lines.length} 条事件\n`);

// 找第一个 error 的 turn/end
let idx = -1;
for (let i = 0; i < lines.length; i += 1) {
  try {
    const o = JSON.parse(lines[i]);
    if (o?.type === 'turn/end' && o?.data?.reason?.kind === 'error') { idx = i; break; }
  } catch { /* skip */ }
}
if (idx < 0) { console.log('未找到 error 回合'); process.exit(0); }

console.log(`=== error 回合在第 ${idx} 条；打印前 25 条 ===\n`);
for (let i = Math.max(0, idx - 25); i <= idx; i += 1) {
  try {
    const o = JSON.parse(lines[i]);
    const t = o?.type ?? '?';
    // 压缩输出：类型 + 关键字段
    let extra = '';
    if (t === 'user/message') extra = JSON.stringify(o?.data?.source ?? {}).slice(0, 120) + ' | ' + String(o?.data?.content?.[0]?.text ?? '').slice(0, 100);
    else if (t === 'turn/end') extra = JSON.stringify(o?.data?.reason ?? {}).slice(0, 300);
    else if (t === 'assistant/message') extra = String(o?.data?.content?.[0]?.text ?? '').slice(0, 100);
    else extra = JSON.stringify(o?.data ?? {}).slice(0, 160);
    console.log(`[${String(i).padStart(4)}] ${t.padEnd(22)} ${extra}`);
  } catch { console.log(`[${String(i).padStart(4)}] (解析失败) ${lines[i].slice(0, 160)}`); }
}
