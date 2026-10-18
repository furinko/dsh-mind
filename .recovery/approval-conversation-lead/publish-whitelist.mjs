// 通用「按字节白名单发布」工具（只用于本会话的候选发布；不是产品代码）。
// 用法：
//   node publish-whitelist.mjs prepare <whitelist.json> <sourceProductDir> <liveDir> <workDir>
//   node publish-whitelist.mjs publish <workDir> <ticket>
//   node publish-whitelist.mjs verify  <workDir>
// 约定：
//   - whitelist 是 [{path, before, after}]，before=null 表示新文件；
//   - 发布前逐项核对 live 当前字节 = before、source 当前字节 = after（任何一个不等就整单拒绝，零写入）；
//   - prepare 只写 workDir（staging + 原件备份 + prepared.json），不碰 live；
//   - publish 需要真实独立票号；逐文件 rename（先依赖提供方、后消费者），并记录每步 SHA 与耗时；
//   - 不做「多文件事务」的虚假承诺：中断时把已完成清单写进 publication-failed.json 供人工判断。
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fileSha = file => fs.existsSync(file) ? sha(fs.readFileSync(file)) : null;
const safe = (base, rel) => {
  const abs = path.resolve(base, rel);
  if (!abs.startsWith(path.resolve(base) + path.sep)) throw Error(`Unsafe relative path: ${rel}`);
  return abs;
};

function readWhitelist(file) {
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(rows) || rows.length === 0) throw Error('Whitelist must be a non-empty array');
  for (const row of rows) {
    if (typeof row.path !== 'string' || !row.path || path.isAbsolute(row.path) || row.path.includes('..')) throw Error(`Bad path in whitelist: ${row.path}`);
    if (!(row.before === null || /^[a-f0-9]{64}$/.test(row.before))) throw Error(`Bad before sha: ${row.path}`);
    if (!/^[a-f0-9]{64}$/.test(row.after)) throw Error(`Bad after sha: ${row.path}`);
  }
  return rows;
}

const [mode, ...args] = process.argv.slice(2);

if (mode === 'prepare') {
  const [whitelistFile, source, live, work] = args;
  if (![whitelistFile, source, live, work].every(Boolean)) throw Error('prepare needs whitelist/source/live/work');
  if (fs.existsSync(path.join(work, 'prepared.json'))) throw Error('work dir already prepared');
  const rows = readWhitelist(path.resolve(whitelistFile));
  const liveAbs = path.resolve(live), srcAbs = path.resolve(source);
  const checks = [];
  for (const row of rows) {
    const liveFile = safe(liveAbs, row.path), srcFile = safe(srcAbs, row.path);
    const liveSha = fileSha(liveFile), srcSha = fileSha(srcFile);
    if (liveSha !== row.before) throw Error(`live SHA mismatch for ${row.path}: ${liveSha} != ${row.before}`);
    if (srcSha !== row.after) throw Error(`source SHA mismatch for ${row.path}: ${srcSha} != ${row.after}`);
    checks.push({ ...row, liveFile, srcFile });
  }
  fs.mkdirSync(work, { recursive: true });
  const staged = [];
  for (const row of checks) {
    const dst = safe(path.join(work, 'staged'), row.path);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(row.srcFile, dst, fs.constants.COPYFILE_EXCL);
    if (fileSha(dst) !== row.after) throw Error(`staged SHA mismatch ${row.path}`);
    let backup = null;
    if (row.before !== null) {
      backup = safe(path.join(work, 'originals'), row.path);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.copyFileSync(row.liveFile, backup, fs.constants.COPYFILE_EXCL);
      if (fileSha(backup) !== row.before) throw Error(`backup SHA mismatch ${row.path}`);
    }
    staged.push({ path: row.path, before: row.before, after: row.after, liveFile: row.liveFile, staged: dst, backup });
  }
  fs.writeFileSync(path.join(work, 'prepared.json'), JSON.stringify({ at: new Date().toISOString(), source: srcAbs, live: liveAbs, phase: 'prepared-not-published', files: staged }, null, 2));
  console.log(JSON.stringify({ prepared: staged.length, published: false }));
} else if (mode === 'publish') {
  const [work, ticket] = args;
  if (!/^rv-\d+$/.test(ticket ?? '')) throw Error('publish needs the actual review ticket id (rv-N)');
  const prepared = JSON.parse(fs.readFileSync(path.join(work, 'prepared.json'), 'utf8'));
  if (fs.existsSync(path.join(work, 'published.json'))) throw Error('already published');
  for (const row of prepared.files) {
    if (fileSha(row.liveFile) !== row.before) throw Error(`live drifted before publish: ${row.path}`);
    if (fileSha(row.staged) !== row.after) throw Error(`staged drifted: ${row.path}`);
    if (row.backup && fileSha(row.backup) !== row.before) throw Error(`backup drifted: ${row.path}`);
  }
  // 顺序：数据/服务提供方先换，消费者后换（本插件内 client 消费者最后）。
  const rank = row => /^src\//.test(row.path) ? 0 : /^components\/kernel\//.test(row.path) ? 1 : /^lib\//.test(row.path) ? 2 : /^components\/board\/lib\//.test(row.path) ? 9 : 5;
  const order = [...prepared.files].sort((a, b) => rank(a) - rank(b));
  const started = new Date().toISOString();
  const clock = performance.now();
  const done = [];
  try {
    for (const row of order) {
      if (fileSha(row.liveFile) !== row.before) throw Error(`concurrent change: ${row.path}`);
      // 新文件的父目录在 live 里可能还不存在：先建目录再 rename（目录创建单独记账）。
      fs.mkdirSync(path.dirname(row.liveFile), { recursive: true });
      fs.renameSync(row.staged, row.liveFile);
      const now = fileSha(row.liveFile);
      if (now !== row.after) throw Error(`published SHA mismatch: ${row.path}`);
      done.push({ path: row.path, sha256: now });
    }
    fs.writeFileSync(path.join(work, 'published.json'), JSON.stringify({ started, ended: new Date().toISOString(), elapsedMs: performance.now() - clock, ticket, phase: 'published-needs-runtime-verification', files: done }, null, 2));
    console.log(JSON.stringify({ published: done.length, ticket, elapsedMs: performance.now() - clock }));
  } catch (error) {
    fs.writeFileSync(path.join(work, 'publication-failed.json'), JSON.stringify({ started, ticket, completed: done, error: error.message, note: 'Stop and inspect exact SHAs; no restart/profile/permission change was performed.' }, null, 2));
    throw error;
  }
} else if (mode === 'verify') {
  const [work] = args;
  const prepared = JSON.parse(fs.readFileSync(path.join(work, 'prepared.json'), 'utf8'));
  const published = JSON.parse(fs.readFileSync(path.join(work, 'published.json'), 'utf8'));
  const report = prepared.files.map(row => ({ path: row.path, expected: row.after, actual: fileSha(row.liveFile) }));
  const bad = report.filter(row => row.expected !== row.actual);
  console.log(JSON.stringify({ files: report.length, mismatched: bad.length, ticket: published.ticket, elapsedMs: published.elapsedMs }));
  if (bad.length) { console.error(JSON.stringify(bad, null, 2)); process.exitCode = 1; }
} else {
  throw Error('mode must be prepare | publish | verify');
}
