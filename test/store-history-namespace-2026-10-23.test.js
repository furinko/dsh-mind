import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { makeFixture, SOVEREIGN } from './helpers.mjs';
import { ObjectStore } from '../src/store.js';
import { captureArtifactManifest } from '../src/artifact-manifest.js';
import { formatFrontMatter } from '../src/tags.js';
import { digest } from '../src/kernel/text.js';

const identity = (kind, zone = '私有') => ({ kind, zone });
const body = text => '# demo\n\n## 适用岗位\n- Lead\n\n## 怎么做\n' + text + '\n';
const document = (id, text, meta = {}) => ({ meta: { id, authority: '自治', ...meta }, body: body(text) });
const spec = { subject: SOVEREIGN, reason: '隔离版本回归' };
const author = { subject: { id: 'factory-author', kind: '出厂作者' }, reason: '隔离出厂更新', zone: '出厂' };
const ambiguous = error => error.code === 'STORE_HISTORY_AMBIGUOUS';

async function scene(t) {
  const f = await makeFixture();
  t.after(() => f.cleanup());
  return { ...f, store: new ObjectStore(f) };
}
async function seedLegacy(f, id = 'legacy') {
  await f.store.write('能力', document(id, 'old-one'), spec);
  await f.store.write('能力', document(id, 'old-two'), spec);
  const legacy = f.layout.historyFile(id, 'v1');
  await mkdir(dirname(legacy), { recursive: true });
  await rename(f.layout.historyFile(id, 'v1', identity('能力')), legacy);
  const index = JSON.parse(await readFile(f.layout.historyIndex(), 'utf8'));
  index[id] = index['能力:私有:' + id]; delete index['能力:私有:' + id];
  await writeFile(f.layout.historyIndex(), JSON.stringify(index));
  return legacy;
}

it('同id的能力和产物并发更新保留各自历史、指针及回滚正文', async t => {
  const f = await scene(t);
  for (const text of ['one', 'two']) {
    await Promise.all(['能力', '产物'].map(kind => f.store.write(kind, document('shared', kind + text), spec)));
  }
  assert.match(await f.store.readVersion('shared', 1, identity('能力')), /能力one/);
  assert.match(await f.store.readVersion('shared', 1, identity('产物')), /产物one/);
  await assert.rejects(f.store.readVersion('shared', 1), ambiguous);
  await assert.rejects(f.store.history('shared'), ambiguous);
  await assert.rejects(f.store.pointers('shared'), ambiguous);
  await assert.rejects(f.store.pointers(), ambiguous);
  for (const kind of ['能力', '产物']) {
    assert.equal((await f.store.pointers('shared', identity(kind))).shared.version, 2);
    await f.store.rollback(kind, 'shared', 1, spec);
    assert.match((await f.store.read(kind, 'shared', { subject: SOVEREIGN, zone: '私有' })).body, new RegExp(kind + 'one'));
    const pointer = (await f.store.pointers('shared', identity(kind))).shared;
    assert.equal(pointer.version, 3); assert.equal(pointer.回滚自, 1);
  }
  const keys = Object.keys(JSON.parse(await readFile(f.layout.historyIndex(), 'utf8')));
  assert.deepEqual(keys.sort(), ['产物:私有:shared', '能力:私有:shared'].sort());
});

it('同id双区版本独立，出厂更新不污染私有回滚或已冻结版本引用', async t => {
  const f = await scene(t);
  for (const [zone, options] of [['私有', spec], ['出厂', author]]) {
    for (const text of ['one', 'two']) await f.store.write('能力', document('dual', zone + text), options);
  }
  assert.match(await f.store.readVersion('dual', 1, identity('能力', '私有')), /私有one/);
  assert.match(await f.store.readVersion('dual', 1, identity('能力', '出厂')), /出厂one/);
  await assert.rejects(f.store.readVersion('dual', 1), ambiguous);
  const manifest = await captureArtifactManifest(['mind://私有/能力/dual@1', 'mind://出厂/能力/dual@1'], {
    layout: f.layout, policy: f.policy, subject: SOVEREIGN, task: { 项目: 'history-test' },
  });
  assert.ok(manifest.条目.every(entry => entry.类型 === '对象版本'));
  assert.notEqual(manifest.条目[0].sha256, manifest.条目[1].sha256);
  await f.store.rollback('能力', 'dual', 1, spec);
  assert.match((await f.store.read('能力', 'dual', { subject: SOVEREIGN, zone: '私有' })).body, /私有one/);
  assert.match((await f.store.read('能力', 'dual', { subject: SOVEREIGN, zone: '出厂' })).body, /出厂two/);
});

it('写入来源取实际区域，不接受调用方元数据伪造另一历史归属', async t => {
  const f = await scene(t);
  await f.store.write('能力', document('zone-label', 'one', { zone: '出厂' }), spec);
  await f.store.write('能力', document('zone-label', 'two', { zone: '出厂' }), spec);
  assert.match(await f.store.readVersion('zone-label', 1, identity('能力')), /zone: 私有/);
  assert.equal(await f.store.readVersion('zone-label', 1, identity('能力', '出厂')), null);
});

it('有唯一完整审计摘要回执的旧历史兼容读取、产物核验和回滚，旧文件不迁移不改写', async t => {
  const f = await scene(t);
  const file = await seedLegacy(f);
  const original = await readFile(file, 'utf8');
  assert.equal(await f.store.readVersion('legacy', 1), original);
  assert.equal((await f.store.history('legacy'))[0].path, file);
  assert.equal((await f.store.pointers('legacy')).legacy.version, 2);
  const manifest = await captureArtifactManifest(['mind://私有/能力/legacy@1'], {
    layout: f.layout, policy: f.policy, subject: SOVEREIGN, task: { 项目: 'history-test' },
  });
  assert.equal(manifest.条目[0].类型, '对象版本');
  await f.store.rollback('能力', 'legacy', 1, spec);
  assert.equal(await readFile(file, 'utf8'), original);
  assert.equal((await f.store.pointers('legacy', identity('能力'))).legacy.version, 3);
  assert.deepEqual(Object.keys(await f.store.pointers()), ['legacy']);
  assert.equal((await f.store.pointers()).legacy.version, 3);
  assert.match(await readFile(f.layout.historyFile('legacy', 'v2', identity('能力')), 'utf8'), /old-two/);
});

it('旧历史正文标签或旧索引不能代替摘要回执，修改正文后拒绝回滚', async t => {
  const f = await scene(t);
  const file = await seedLegacy(f);
  const current = (await f.store.read('能力', 'legacy', { subject: SOVEREIGN, zone: '私有' })).raw;
  await writeFile(file, (await readFile(file, 'utf8')).replace('old-one', 'forged-one'));
  await assert.rejects(f.store.readVersion('legacy', 1, identity('能力')), ambiguous);
  await assert.rejects(f.store.rollback('能力', 'legacy', 1, spec), ambiguous);
  assert.equal((await f.store.read('能力', 'legacy', { subject: SOVEREIGN, zone: '私有' })).raw, current);
});

it('旧历史同摘要存在双区回执时拒绝猜测，正文没有zone不能默认私有', async t => {
  const f = await scene(t);
  const content = formatFrontMatter({ id: 'ambiguous', kind: '能力', version: 1, authority: '自治' }) + body('same');
  const file = f.layout.historyFile('ambiguous', 'v1');
  await mkdir(dirname(file), { recursive: true }); await writeFile(file, content);
  for (const zone of ['出厂', '私有']) await f.audit.append({
    动作: '状态变更', 主体: SOVEREIGN, 对象: { id: 'ambiguous', kind: '能力' },
    详情: { 版本指针: 'ambiguous@v1', 摘要: digest(content), 区: zone },
  });
  for (const zone of ['出厂', '私有']) await assert.rejects(f.store.readVersion('ambiguous', 1, identity('能力', zone)), ambiguous);
  assert.equal(await readFile(file, 'utf8'), content);
});

it('旧历史仅能向已证明归属的对象读取，不能借另一类型执行回滚', async t => {
  const f = await scene(t);
  await seedLegacy(f);
  assert.equal(await f.store.readVersion('legacy', 1, identity('产物')), null);
  await assert.rejects(f.store.rollback('产物', 'legacy', 1, spec), /没有/);
  assert.equal(await f.store.read('产物', 'legacy', { subject: SOVEREIGN, zone: '私有' }), null);
});

it('新命名空间历史不允许同一版本被另一正文覆盖', async t => {
  const f = await scene(t);
  await f.store.write('能力', document('immutable', 'one'), spec);
  await f.store.write('能力', document('immutable', 'two'), spec);
  const file = f.layout.historyFile('immutable', 'v1', identity('能力'));
  const before = await readFile(file, 'utf8');
  const current = f.layout.documentPath('能力', { id: 'immutable' }, '私有');
  await writeFile(current, before.replace('one', 'external-rewind'));
  await assert.rejects(f.store.write('能力', document('immutable', 'three'), spec), error => error.code === 'STORE_HISTORY_CONFLICT');
  assert.equal(await readFile(file, 'utf8'), before);
  assert.match(await readFile(current, 'utf8'), /external-rewind/);
});

it('缺省zone的旧正文只有唯一已验证来源回执时可读，审计链损坏则拒绝', async t => {
  const f = await scene(t);
  const content = formatFrontMatter({ id: 'old-no-zone', kind: '能力', version: 1, authority: '自治' }) + body('old');
  const file = f.layout.historyFile('old-no-zone', 'v1');
  await mkdir(dirname(file), { recursive: true }); await writeFile(file, content);
  const receipt = await f.audit.append({
    动作: '状态变更', 主体: SOVEREIGN, 对象: { id: 'old-no-zone', kind: '能力' },
    详情: { 版本指针: 'old-no-zone@v1', 摘要: digest(content), 区: '私有' },
  });
  assert.equal(await f.store.readVersion('old-no-zone', 1, identity('能力')), content);
  const auditFile = f.layout.auditLog(receipt.月);
  await writeFile(auditFile, (await readFile(auditFile, 'utf8')).replace('old-no-zone@v1', 'old-no-zone@v2'));
  await assert.rejects(f.store.readVersion('old-no-zone', 1, identity('能力')), ambiguous);
});

it('新历史身份不符时拒绝，不退回碰巧存在的旧正文', async t => {
  const f = await scene(t);
  const legacy = await seedLegacy(f);
  const current = f.layout.historyFile('legacy', 'v1', identity('能力'));
  await writeFile(current, (await readFile(legacy, 'utf8')).replace('kind: 能力', 'kind: 产物'));
  await assert.rejects(f.store.readVersion('legacy', 1, identity('能力')), error => error.code === 'STORE_HISTORY_INVALID');
});
