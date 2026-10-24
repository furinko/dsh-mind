import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { settingsScene } from './settings-fixture.mjs';
import { jsonResponse } from './client-harness.mjs';
import { makeFixture, SOVEREIGN } from '../../../test/helpers.mjs';
import { Org } from '../../../src/org.js';
import { information路由 } from '../../kernel/lib/routes.js';

const project = 'information-ui';
async function scene(run, options = {}) {
  const f = await makeFixture(); const org = await Org.open({ ...f, project });
  const ctx = { get: () => ({ requestRejection: () => undefined }) };
  const handlers = { settings: information路由({ org, ctx, 项目: project }), preview: information路由({ org, ctx, 项目: project, mode: 'preview' }) };
  const calls = [];
  let pending = 0;
  const s = await settingsScene({ informationOnly: true, informationClosed: options.informationClosed, uiWorkspace: options.uiWorkspace?.(f), informationRequest: async (url, init) => {
    pending++;
    try {
    calls.push({ url, method: init.method, body: init.body && JSON.parse(init.body) });
    const req = { method: init.method, url, headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() { if (init.body) yield Buffer.from(init.body); } };
    const res = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
    await handlers[url.startsWith('/plugins/dsh-mind/information-material') ? 'preview' : 'settings'](req, res);
    if (options.locations && res.body?.数据?.config) res.body.数据.locations = { locations: options.locations(f) };
    return jsonResponse(res.body, res.status);
    } finally { pending--; }
  } });
  const wait = async () => { for (let n = 0; n < 300; n++) { await s.flush(); if (!pending && !s.text().includes('正在处理并核对…')) { await s.flush(); if (!pending) return; } } throw Error('Information UI did not settle'); };
  const click = s.click;
  s.click = async label => { await click(label); await wait(); };
  try { await wait(); await run(s, org, f, calls); } finally { s.close(); await org.observability.flush(); await f.cleanup(); }
}

it('设置主页面保持紧凑，来源管理是有关闭入口的分栏小弹窗；草稿在关闭后保留', async () => scene(async s => {
  assert.ok(s.button('管理信息来源'));
  assert.equal(s.elements().filter(e => e.props.role === 'dialog').length, 0);
  await s.click('管理信息来源');
  const dialog = s.elements().find(e => e.props.role === 'dialog');
  assert.equal(dialog.props['aria-label'], '信息来源与沉淀管理'); assert.equal(dialog.props['aria-modal'], true);
  for (const tab of ['连接目录', '收录与沉淀', '阅读设置']) assert.ok(s.button(tab));
  assert.equal(s.field('适用岗位'), undefined, '岗位归属交给Lead，不让用户逐条分配');
  await s.click('阅读设置'); s.change('每日自主探索上限', '2');
  s.field('关闭信息来源管理').props.onClick(); await s.flush();
  assert.equal(s.elements().filter(e => e.props.role === 'dialog').length, 0);
  await s.click('管理信息来源'); assert.equal(s.field('每日自主探索上限').props.value, 2);
}, { informationClosed: true }));

it('实际设置组件连接本地目录，经认证路由收录并查看文字版本；会话是分享主入口', async () => scene(async (s, org, f) => {
  assert.match(s.text(), /在会话中分享/);
  const dir = join(f.home, '外部资料'); await mkdir(dir); await writeFile(join(dir, '一.md'), '# 奇怪的乐器\n叶子也能吹出声音。');
  s.change('来源名称', '我的知识库'); s.change('本地目录绝对路径', dir); await s.click('连接信息来源');
  assert.equal((await org.information.load()).sources[0].path, dir);
  await s.click('现在收录一批'); assert.match(s.text(), /奇怪的乐器/);
  await s.click('查看原文 奇怪的乐器'); assert.match(s.text(), /叶子也能吹出声音/);
  await s.click('暂停阅读'); assert.equal((await org.information.load()).config.paused, true);
  await s.click('恢复阅读'); assert.equal((await org.information.load()).config.paused, false);
}));

it('阅读预算草稿在刷新后保留，设置变化时不能以新版本覆盖旧草稿', async () => scene(async (s, org) => {
  s.change('每日模型调用上限（含选题）', '2');
  const before = await org.information.load();
  await org.information.admin({ subject: SOVEREIGN, project, session: null }, { op: 'configure', expectedRevision: before.configRevision, config: { ...before.config, dailyReadChars: 12345 } });
  await s.click('刷新见闻与成长');
  assert.equal(s.field('每日模型调用上限（含选题）').props.value, 2);
  assert.match(s.text(), /草稿保留/); assert.equal(s.button('保存阅读设置').props.disabled, true);
  await s.click('放弃阅读设置修改'); assert.equal(s.field('每日阅读字符上限').props.value, 12345);
}));

it('成长记录修订、停用和历史均经真实服务，人侧预览不计模型预算', async () => scene(async (s, org) => {
  const human = { subject: SOVEREIGN, project, session: null };
  const item = await org.information.deposit(human, { producer: 'ui-fixture', externalId: '1', title: '小发现', text: '叶子吹奏很有趣', coverage: '测试文字', scope: { project: null, audience: 'lead', roles: [], relationship: null } });
  const target = { subject: { id: 'lead', kind: 'Lead' }, project, session: 'lead' };
  const read = await org.information.read(target, { id: item.id });
  await org.information.record(target, { type: 'growth', kind: '兴趣', title: '听叶子', text: '我想听听叶子的声音', sources: [{ readingId: read.readingId, quote: '叶子吹奏' }] });
  await s.click('刷新见闻与成长'); await s.click('趣味与成长');
  await s.click('纠正 听叶子'); s.change('纠正后的收获', '我更喜欢听竹笛'); s.change('收获修订或分享原因', '刚才理解得不准确'); await s.click('保存收获纠正');
  assert.match(s.text(), /我更喜欢听竹笛/);
  await s.click('查看修订与试用 听叶子'); assert.match(s.text(), /刚才理解得不准确/);
  const usage = (await org.information.load()).usage;
  await s.click('停止使用 听叶子'); assert.equal((await org.information.query(target, { collection: 'growth' })).entries[0].state, 'withdrawn');
  assert.deepEqual((await org.information.load()).usage, usage);
}));

const listing = (path, entries = [], home = path) => ({ path, home, crumbs: [{ name: '主目录', path: home }, ...(path === home ? [] : [{ name: path.split('/').at(-1), path }])], entries: entries.map(p => ({ name: p.split('/').at(-1), path: p, hidden: p.split('/').at(-1).startsWith('.') })), truncated: false });
it('像工作区一样浏览并跨目录多选，一次保存全部来源；取消不连接，已连接项不可重复选择', async () => scene(async (s, org, f, calls) => {
  const one = join(f.home, '知识库甲'); const two = join(f.home, '插件导出乙');
  await mkdir(one); await mkdir(two);
  await s.click('选择信息来源目录');
  s.change('选择目录 ' + one, true); await s.click('进入 插件导出乙'); await s.click('选择当前目录');
  assert.match(s.text(), /已选择 2 个目录/); assert.equal((await org.information.load()).sources.length, 0);
  await s.click('取消选择目录'); assert.equal((await org.information.load()).sources.length, 0);
  await s.click('选择信息来源目录'); assert.match(s.text(), /已选择 0 个目录/);
  s.change('选择目录 ' + one, true); s.change('选择目录 ' + two, true);
  await s.click('连接选中目录（2）');
  const state = await org.information.load(); assert.deepEqual(state.sources.map(x => x.path).sort(), [one, two].sort());
  assert.equal(state.configRevision, 1); assert.equal(calls.filter(c => c.body?.op === 'sources_add').length, 1);
  assert.ok(state.sources.every(x => x.scope.audience === 'auto' && x.scope.project === null && x.recursive));
  await s.click('选择信息来源目录'); assert.equal(s.field('选择目录 ' + one).props.disabled, true); assert.equal(s.field('选择目录 ' + two).props.checked, true);
}, { uiWorkspace: f => ({ async listDirectory(path = f.home) { return listing(path, path === f.home ? [join(f.home, '知识库甲'), join(f.home, '插件导出乙')] : [], f.home); } }) }));

it('原生目录选择宿主允许连续添加，取消不丢所选目录，保存冲突保留选择并要求重新核对', async () => {
  let picks = 0; let home;
  await scene(async (s, org, f) => {
    const dir = join(f.home, '原生选择'); await mkdir(dir);
    await s.click('选择信息来源目录'); assert.match(s.text(), /已选择 1 个目录/);
    await s.click('继续选择文件夹'); assert.match(s.text(), /已选择 1 个目录/);
    const state = await org.information.load();
    await org.information.admin({ subject: SOVEREIGN, project }, { op: 'configure', expectedRevision: state.configRevision, config: { ...state.config, paused: true } });
    await s.click('刷新磁盘列表'); assert.equal(s.button('连接选中目录（1）').props.disabled, true);
    await s.click('按当前设置核对所选目录'); await s.click('连接选中目录（1）');
    assert.equal((await org.information.load()).sources[0].path, dir);
    assert.equal((await org.information.load()).config.paused, true);
  }, { uiWorkspace: f => { home = f.home; return { async listDirectory() { throw Object.assign(Error('native only'), { rpcError: { code: 'directory-picker/unavailable' } }); }, async pickDirectory() { return picks++ === 0 ? join(home, '原生选择') : null; } }; } });
});

it('目录窗口独立显示，磁盘入口能跨卷多选并一次连接，关闭返回来源管理', async () => {
  const visited = [];
  await scene(async (s, org, f) => {
    const one = join(f.home, '磁盘甲', '知识库'); const two = join(f.home, '磁盘乙', '字幕');
    await mkdir(one, { recursive: true }); await mkdir(two, { recursive: true });
    await s.click('选择信息来源目录');
    assert.equal(s.elements().filter(e => e.props.role === 'dialog').length, 1);
    assert.equal(s.field('关闭信息来源管理'), undefined, '来源管理不与目录选择叠成两个弹窗');
    s.field('浏览磁盘 磁盘甲').props.onClick(); await s.flush();
    s.change('选择目录 ' + one, true);
    s.field('浏览磁盘 磁盘乙').props.onClick(); await s.flush();
    s.change('选择目录 ' + two, true);
    assert.ok(visited.includes(join(f.home, '磁盘甲')) && visited.includes(join(f.home, '磁盘乙')));
    assert.match(s.text(), /已选择 2 个目录/);
    await s.click('连接选中目录（2）');
    assert.deepEqual((await org.information.load()).sources.map(s => s.path).sort(), [one, two].sort());
    assert.ok(s.field('关闭信息来源管理'));
    await s.click('选择信息来源目录');
    s.field('关闭目录选择').props.onClick(); await s.flush();
    assert.ok(s.field('关闭信息来源管理'));
    assert.equal((await org.information.load()).sources.length, 2);
  }, {
    locations: f => ['磁盘甲', '磁盘乙'].map(name => ({ name, path: join(f.home, name), kind: 'volume', filesystem: 'exfat', available: true })),
    uiWorkspace: f => ({ async listDirectory(path = f.home) { visited.push(path); return listing(path,
      path.endsWith('磁盘甲') ? [join(path, '知识库')] : path.endsWith('磁盘乙') ? [join(path, '字幕')] : [], f.home); } }),
  });
});

it('文件解析失败有独立状态与人侧重试，来源目录只读提示和阅读预算分开呈现', async () => scene(async (s, org, f, calls) => {
  const dir = join(f.home, '解析来源'); await mkdir(dir); await writeFile(join(dir, 'sample.pdf'), '%PDF-synthetic');
  s.change('来源名称', '解析来源'); s.change('本地目录绝对路径', dir); await s.click('连接信息来源');
  org.information.documentParser = async () => { throw Object.assign(Error('fixture'), { code: 'INFORMATION_PARSER_MISSING' }); };
  await s.click('现在收录一批');
  assert.match(s.text(), /缺少解析组件/); assert.match(s.text(), /来源目录始终只读/);
  await s.click('重试解析 sample.pdf');
  assert.equal(Object.values((await org.information.load()).documents)[0].status, 'pending');
  assert.ok(calls.some(c => c.body?.op === 'parse_retry'));
  assert.equal(await readFile(join(dir, 'sample.pdf'), 'utf8'), '%PDF-synthetic');
}));
