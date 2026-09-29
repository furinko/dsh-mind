// read-session-error.mjs — 从会话日志（多帧 zstd）里解出最近的错误原文。
//
// 会话日志 = `sessions/<workspace>/<session-id>/session.jsonl.zstd`，**每帧一个独立 zstd 块**。
// ⚠️ 只解第一帧只会拿到 ~170 字符的 session 头（多帧陷阱，见 dshome-diagnostics 卡）。
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const root = process.argv[2];
if (!root) { console.error('用法：node read-session-error.mjs <sessions 根>'); process.exit(2); }

/** 按 zstd 魔数切帧、逐帧解、拼接。 */
function readAll(file) {
  const buf = readFileSync(file);
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const pos = [];
  for (let i = 0; i + 4 <= buf.length; i += 1) if (buf.compare(magic, 0, 4, i, i + 4) === 0) pos.push(i);
  if (pos.length === 0) return '';
  const parts = [];
  for (let k = 0; k < pos.length; k += 1) {
    const end = k + 1 < pos.length ? pos[k + 1] : buf.length;
    try { parts.push(zstdDecompressSync(buf.subarray(pos[k], end)).toString('utf8')); } catch { /* 坏帧跳过 */ }
  }
  return parts.join('');
}

/** 收集所有会话文件（按 mtime 倒序）。 */
function collect(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) collect(p, out);
    else if (/^session.*\.jsonl\.zstd$/.test(e.name)) { try { out.push({ p, m: statSync(p).mtimeMs }); } catch { /* 跳过 */ } }
  }
  return out;
}

const files = collect(root).sort((a, b) => b.m - a.m).slice(0, 3);
console.log(`找到 ${collect(root).length} 个会话，查最近 ${files.length} 个\n`);

for (const f of files) {
  console.log(`══ ${f.p}`);
  console.log(`   修改于 ${new Date(f.m).toLocaleString('sv-SE')}`);
  const text = readAll(f.p);
  const lines = text.split('\n').filter(Boolean);
  console.log(`   ${lines.length} 条事件`);
  // 精确找「回合失败」：turn/end 且 reason.kind !== completed
  let n = 0;
  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o?.type !== 'turn/end') continue;
    const kind = o?.data?.reason?.kind;
    if (kind === undefined || kind === 'completed') continue;
    n += 1;
    if (n > 5) break;
    const err = o?.data?.reason?.error ?? {};
    console.log(`\n   ⚠️ [turn/end] kind=${kind}`);
    console.log(`      message: ${String(err.message ?? '(无)').slice(0, 500)}`);
    if (err.stack) console.log(`      stack:\n        ${String(err.stack).split('\n').slice(0, 8).join('\n        ')}`);
    if (err.code) console.log(`      code: ${err.code}`);
  }
  if (n === 0) console.log('   （无失败回合）');
  console.log('');
}
