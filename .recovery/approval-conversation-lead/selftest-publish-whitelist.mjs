// 发布工具自测：只在临时目录里造 live/source 假体，验证 prepare/publish/verify 的行为与拒绝路径。
// 这是工具自测，不是任何真实发布记录；不读取也不写入真实 live、不申请任何票。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { writeFileSync as writeEvidence } from 'node:fs';
import assert from 'node:assert/strict';

const NODE = process.execPath;
const TOOL = new URL('./publish-whitelist.mjs', import.meta.url).pathname.replace(/^\//, '');
const sha = text => createHash('sha256').update(Buffer.from(text)).digest('hex');
const put = (base, rel, text) => { const file = join(base, rel); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
const run = (...args) => spawnSync(NODE, [TOOL, ...args], { encoding: 'utf8' });

const box = mkdtempSync(join(tmpdir(), 'publish-selftest-'));
const live = join(box, 'live'), source = join(box, 'source'), work = join(box, 'work');
put(live, 'src/a.js', 'old-a\n'); put(live, 'components/board/lib/client.js', 'old-client\n');
put(source, 'src/a.js', 'new-a\n'); put(source, 'components/board/lib/client.js', 'new-client\n'); put(source, 'test/new.test.js', 'new-test\n');
const whitelist = [
  { path: 'src/a.js', before: sha('old-a\n'), after: sha('new-a\n') },
  { path: 'components/board/lib/client.js', before: sha('old-client\n'), after: sha('new-client\n') },
  { path: 'test/new.test.js', before: null, after: sha('new-test\n') },
];
const whitelistFile = join(box, 'whitelist.json');
writeFileSync(whitelistFile, JSON.stringify(whitelist, null, 2));

const prepared = run('prepare', whitelistFile, source, live, work);
assert.equal(prepared.status, 0, prepared.stderr);
assert.equal(readFileSync(join(live, 'src/a.js'), 'utf8'), 'old-a\n', 'prepare 不得改 live');
const published = run('publish', work, 'rv-999');
assert.equal(published.status, 0, published.stderr);
assert.equal(readFileSync(join(live, 'src/a.js'), 'utf8'), 'new-a\n');
assert.equal(readFileSync(join(live, 'components/board/lib/client.js'), 'utf8'), 'new-client\n', '消费者最后换但也必须换到');
assert.equal(readFileSync(join(live, 'test/new.test.js'), 'utf8'), 'new-test\n', '新文件必须落位');
const verified = run('verify', work);
assert.equal(verified.status, 0, verified.stderr);
assert.match(verified.stdout, /"mismatched":0/);

// 负例1：source 与白名单不符 ⇒ prepare 拒，live 不动
const box2 = mkdtempSync(join(tmpdir(), 'publish-selftest-neg-'));
const live2 = join(box2, 'live'), source2 = join(box2, 'source'), work2 = join(box2, 'work');
put(live2, 'src/a.js', 'old-a\n'); put(source2, 'src/a.js', 'tampered\n');
const negFile = join(box2, 'whitelist.json');
writeFileSync(negFile, JSON.stringify([{ path: 'src/a.js', before: sha('old-a\n'), after: sha('new-a\n') }]));
const neg = run('prepare', negFile, source2, live2, work2);
assert.notEqual(neg.status, 0);
assert.match(neg.stderr, /source SHA mismatch/);
assert.equal(readFileSync(join(live2, 'src/a.js'), 'utf8'), 'old-a\n');

// 负例2：live 在 prepare 后漂移 ⇒ publish 拒且不写入任何文件
const box3 = mkdtempSync(join(tmpdir(), 'publish-selftest-drift-'));
const live3 = join(box3, 'live'), source3 = join(box3, 'source'), work3 = join(box3, 'work');
put(live3, 'src/a.js', 'old-a\n'); put(source3, 'src/a.js', 'new-a\n');
const driftFile = join(box3, 'whitelist.json');
writeFileSync(driftFile, JSON.stringify([{ path: 'src/a.js', before: sha('old-a\n'), after: sha('new-a\n') }]));
assert.equal(run('prepare', driftFile, source3, live3, work3).status, 0);
put(live3, 'src/a.js', 'someone-else\n');
const drift = run('publish', work3, 'rv-998');
assert.notEqual(drift.status, 0);
assert.match(drift.stderr, /live drifted/);
assert.equal(readFileSync(join(live3, 'src/a.js'), 'utf8'), 'someone-else\n');
assert.equal(existsSync(join(work3, 'published.json')), false);

writeEvidence(new URL('./selftest-publish-whitelist-result.json', import.meta.url), JSON.stringify({
  at: new Date().toISOString(),
  scope: 'Tooling self-test in temp dirs only; not a real publication, no real ticket',
  positive: { prepared: 3, published: 3, verifyMismatched: 0, prepareKeptLiveUntouched: true },
  negatives: { sourceShaMismatchRefused: true, liveDriftAfterPrepareRefused: true, driftLeftLiveAtForeignContent: true, noPublishedReceiptWritten: true },
}, null, 2));
console.log(JSON.stringify({ positive: 'ok', negatives: 'ok' }));
