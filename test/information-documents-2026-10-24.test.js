import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parserPython, parseDocument, documentCapabilities } from '../src/information-parser.js';
import { INFORMATION_EXTENSIONS } from '../src/information-files.js';
import { InformationService } from '../src/information.js';
import { makeFixture, LEAD, SOVEREIGN } from './helpers.mjs';
import { Org } from '../src/org.js';

const human = { subject: SOVEREIGN, project: 'documents', session: null };
const lead = { subject: LEAD, project: 'documents', session: LEAD.id };
const scope = { project: null, audience: 'lead', roles: [], relationship: null };
const caps = await documentCapabilities();
const python = await parserPython();
const enabled = python && Object.values(caps.formats).length === 7 && Object.values(caps.formats).every(Boolean);
const skip = enabled ? false : 'optional local parser dependencies not installed (run setup-information-parser.sh)';

async function samples(run) {
  const root = await mkdtemp(join(tmpdir(), 'mind-document-samples-'));
  try {
    const r = spawnSync(python, ['-I', '-B', fileURLToPath(new URL('./fixtures/information-documents.py', import.meta.url)), join(root, 'source')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    await run(join(root, 'source'), join(root, 'private'));
  } finally { await rm(root, { recursive: true, force: true }); }
}
async function scene(run) {
  const f = await makeFixture(); const org = await Org.open({ ...f, project: 'documents' });
  try {
    const dir = join(f.home, 'source'); await mkdir(dir);
    await org.information.admin(human, { op: 'source_save', expectedRevision: 0, source: { name: 'Documents', path: dir, enabled: true, recursive: true, extensions: [...INFORMATION_EXTENSIONS], purpose: '两者', scope } });
    await run(org.information, dir, org, f);
  } finally { org.informationHooks?.stop(); await org.observability.flush(); await f.cleanup(); }
}

it('真实解析常见文档：出处、公式、EPUB顺序、UTF16位置；原件和来源目录保持原样', { skip }, async () => samples(async (source, privateRoot) => {
  const expected = { 'notes.docx': /正文块.*\n.*Document heading/s, 'slides.pptx': /幻灯片1/, 'table.xlsx': /C2: =B2\*2/, 'book.epub': /First chapter[\s\S]*Second chapter/, 'multi.csv': /第一行\n第二行 😀/, 'mixed.pdf': /第1页.*\nPDF page one/s };
  const names = await readdir(source);
  for (const [name, pattern] of Object.entries(expected)) {
    const input = await readFile(join(source, name)); const before = await stat(join(source, name));
    const result = await parseDocument(input, name, privateRoot);
    assert.match(result.text, pattern); assert.ok(result.locations.length);
    assert.equal(result.locations.at(-1).end, result.text.length);
    assert.deepEqual(await readFile(join(source, name)), input);
    assert.equal((await stat(join(source, name))).mtimeMs, before.mtimeMs);
    if (name === 'book.epub') assert.doesNotMatch(result.text, /DO NOT KEEP/);
    if (name === 'mixed.pdf' || name === 'table.xlsx') assert.equal(result.extraction.status, 'partial');
  }
  const large = await parseDocument(await readFile(join(source, 'large.csv')), 'large.csv', privateRoot);
  assert.ok(large.text.length > 1048576); assert.equal(large.extraction.status, 'complete');
  assert.deepEqual(await readdir(source), names);
  assert.deepEqual(await readdir(join(privateRoot, 'parser-tmp')), []);
}));

it('损坏、加密、无文字、归档越界和XML实体不冒充可读；超时与缺组件会清理私有临时副本', { skip }, async () => samples(async (source, privateRoot) => {
  for (const [name, code] of [['scan.pdf', 'INFORMATION_NO_TEXT'], ['encrypted.pdf', 'INFORMATION_ENCRYPTED'], ['unsafe.epub', 'INFORMATION_ARCHIVE_REFUSED'], ['entities.docx', 'INFORMATION_ARCHIVE_REFUSED']]) {
    await assert.rejects(parseDocument(await readFile(join(source, name)), name, privateRoot), { code });
  }
  await assert.rejects(parseDocument(Buffer.from('not PDF'), 'bad.pdf', privateRoot), { code: 'INFORMATION_FORMAT_INVALID' });
  await assert.rejects(parseDocument(Buffer.from('x'), 'x.pdf', privateRoot, { python: '/missing/mind-python' }), { code: 'INFORMATION_PARSER_MISSING' });
  await assert.rejects(parseDocument(await readFile(join(source, 'notes.docx')), 'slow.docx', privateRoot, { timeoutMs: 1 }), { code: 'INFORMATION_PARSE_TIMEOUT' });
  assert.deepEqual(await readdir(join(privateRoot, 'parser-tmp')), []);
}));

it('文档增量缓存、重开复用、实际分页位置、更新停用派生与撤回后不重建快照', { skip }, async () => scene(async (service, source, org, f) => {
  await writeFile(join(source, 'a.csv'), 'name,value\nflute,bird song 😀\n');
  await service.scan();
  let state = await service.load(); let item = state.items[0];
  assert.equal(state.documents[item.id].status, 'complete');
  const r = await service.read(lead, { id: item.id, limit: 12000 });
  assert.match(r.locations[1].label, /记录2/);
  const record = await service.record(lead, { type: 'growth', kind: '兴趣', title: '竹笛', text: '想听听竹笛模拟鸟鸣。', sources: [{ readingId: r.readingId, quote: 'bird song' }] });
  assert.equal(record.sources[0].locations.length, 2);
  const reopened = new InformationService({ org, layout: f.layout, clock: org.clock });
  reopened.documentParser = () => { throw Error('unchanged source must use persisted cache'); };
  await reopened.scan(); assert.equal((await reopened.load()).items[0].revision, 1);
  await writeFile(join(source, 'a.csv'), 'name,value\nflute,new information\n');
  await service.scan(); state = await service.load(); item = state.items[0];
  assert.equal(item.revision, 2); assert.equal((await service.context(lead)).growth.length, 0);
  assert.match((await service.preview(human, { id: item.id, version: 1 })).text, /bird song/);
  await service.admin(human, { op: 'forget', id: item.id, revision: item.revision });
  item = (await service.load()).items[0];
  await service.admin(human, { op: 'purge', id: item.id, revision: item.revision });
  await service.scan(); await assert.rejects(service.blob(item.hash));
  assert.equal((await service.load()).documents[item.id].status, 'withdrawn');
}));

it('解析在锁外执行；暂停、断开或原件变化会阻止在途结果提交', async () => {
  for (const change of ['pause', 'disconnect', 'rewrite']) await scene(async (service, source) => {
    await writeFile(join(source, 'a.csv'), 'one');
    let release; const wait = new Promise(resolve => { release = resolve; });
    let started; const signal = new Promise(resolve => { started = resolve; });
    service.documentParser = async () => { started(); await wait; return { title: 'a.csv', text: 'one', format: '.csv', coverage: 'synthetic text' }; };
    const pending = service.scan(); await signal;
    const state = await service.load();
    if (change === 'pause') await service.admin(human, { op: 'configure', expectedRevision: state.configRevision, config: { ...state.config, paused: true } });
    if (change === 'disconnect') await service.admin(human, { op: 'source_remove', expectedRevision: state.configRevision, id: state.sources[0].id });
    if (change === 'rewrite') await writeFile(join(source, 'a.csv'), 'two');
    release(); const report = await pending;
    assert.equal((await service.load()).items.length, 0);
    assert.ok(report.canceled || report.errors.some(e => e.error === 'INFORMATION_FILE_CHANGED'));
  });
});

it('缺少组件的文件仍有处理回执；重试须人侧，不能重试撤回资料', async () => scene(async (service, source) => {
  await writeFile(join(source, 'a.pdf'), '%PDF-invalid');
  service.documentParser = async () => { throw Object.assign(Error('missing'), { code: 'INFORMATION_PARSER_MISSING' }); };
  await service.scan(); const state = await service.load(); const doc = Object.values(state.documents)[0];
  assert.equal(doc.status, 'needs-component'); assert.equal(state.items.length, 0);
  await assert.rejects(service.admin(lead, { op: 'parse_retry', id: doc.id, expectedRevision: state.configRevision }), { code: 'DENIED' });
  await service.admin(human, { op: 'parse_retry', id: doc.id, expectedRevision: state.configRevision });
  assert.equal((await service.load()).documents[doc.id].status, 'pending');
}));

it('进程中断后的过期批次重扫，不漏掉游标已越过的文件；根目录丢失后停用旧正文', async () => scene(async (service, source) => {
  await writeFile(join(source, 'a.md'), '# Bird\nflute');
  await service.scan();
  await service.locked(async state => {
    state.sources[0].scan = { epoch: 'interrupted', queue: [{ dir: '', after: 'a.md' }], incomplete: false };
    state.sources[0].parseJob = { id: 'interrupted', started: Date.now() - 600000 };
    state.documents[state.items[0].id].status = 'parsing';
  });
  await service.scan(); assert.equal((await service.load()).items[0].state, 'active');
  assert.equal(Object.values((await service.load()).documents)[0].status, 'complete');
  await rm(source, { recursive: true }); await service.scan();
  assert.equal((await service.load()).items[0].state, 'error');
  await assert.rejects(service.read(lead, { id: (await service.load()).items[0].id }), { code: 'DENIED' });
}));
