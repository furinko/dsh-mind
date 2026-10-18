// 只读取证工具（不属于产品源码）：从当前官方 app.asar 读目录/文件/字节匹配。
// 用法：
//   node asar.mjs list <内部目录路径>
//   node asar.mjs cat  <内部文件路径>
//   node asar.mjs grep <内部目录路径> <字节串> [最小命中数]
// 只读 app.asar，不复制整包；所有输出到 stdout。
import { openSync, readSync, closeSync } from 'node:fs';

const ASAR = 'D:/DeepSeek_harness_desktop/resources/app.asar';

function load() {
  const fd = openSync(ASAR, 'r');
  const head = Buffer.alloc(16);
  readSync(fd, head, 0, 16, 0);
  const jsonLen = head.readUInt32LE(12);
  const hb = Buffer.alloc(jsonLen);
  readSync(fd, hb, 0, jsonLen, 16);
  const tree = JSON.parse(hb.toString('utf8'));
  const dataStart = 8 + head.readUInt32LE(4);
  return { fd, tree, dataStart };
}

function entryAt(tree, p) {
  let node = tree;
  for (const seg of p.split('/').filter(Boolean)) {
    if (!node.files || !node.files[seg]) throw new Error('not found: ' + p);
    node = node.files[seg];
  }
  return node;
}

function readEntry(fd, dataStart, p) {
  const e = entryAt(treeRef, p);
  if (e.offset === undefined) throw new Error('directory, not file: ' + p);
  const buf = Buffer.alloc(Number(e.size));
  readSync(fd, buf, 0, buf.length, dataStart + Number(e.offset));
  return buf;
}

let treeRef;

/** 列出目录下所有文件的内部路径 + size。 */
function walk(node, p, out) {
  if (!node.files) return out;
  for (const [name, c] of Object.entries(node.files)) {
    const fp = p + '/' + name;
    if (c.offset !== undefined) out.push({ p: fp, size: Number(c.size) });
    else walk(c, fp, out);
  }
  return out;
}

const [, , cmd, a, b] = process.argv;
const { fd, tree, dataStart } = load();
treeRef = tree;
try {
  if (cmd === 'list') {
    const node = entryAt(tree, a);
    const files = walk(node, a, []);
    for (const f of files) console.log(f.size + '\t' + f.p);
  } else if (cmd === 'cat') {
    process.stdout.write(readEntry(fd, dataStart, a));
  } else if (cmd === 'extract') {
    // a=内部路径, b=落盘路径（只许 .recovery 下）
    if (!b || !(await import('node:path')).resolve(b).includes('.recovery')) throw new Error('dest must be under .recovery');
    const buf = readEntry(fd, dataStart, a);
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync((await import('node:path')).dirname(b), { recursive: true });
    writeFileSync(b, buf);
    console.log('wrote ' + b + ' (' + buf.length + ' bytes)');
  } else if (cmd === 'grep') {
    const node = entryAt(tree, a);
    const files = walk(node, a, []);
    const needle = Buffer.from(b, 'utf8');
    for (const f of files) {
      let buf;
      try { buf = readEntry(fd, dataStart, f.p); } catch { continue; }
      let idx = 0, hits = [];
      while ((idx = buf.indexOf(needle, idx)) !== -1) {
        // 取整行
        let s = idx; while (s > 0 && buf[s - 1] !== 10) s--;
        let e = idx; while (e < buf.length && buf[e] !== 10) e++;
        hits.push(buf.slice(s, e).toString('utf8').trim().slice(0, 400));
        idx += needle.length;
        if (hits.length > 30) break;
      }
      if (hits.length) { console.log('## ' + f.p); for (const h of hits) console.log('  ' + h); }
    }
  } else {
    console.error('unknown command');
    process.exitCode = 2;
  }
} finally {
  closeSync(fd);
}
