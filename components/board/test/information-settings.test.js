import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { settingsScene } from './settings-fixture.mjs';
import { jsonResponse } from './client-harness.mjs';
import { makeFixture, SOVEREIGN } from '../../../test/helpers.mjs';
import { Org } from '../../../src/org.js';
import { information路由 } from '../../kernel/lib/routes.js';

const project = 'information-ui';
async function scene(run) {
  const f = await makeFixture(); const org = await Org.open({ ...f, project });
  const ctx = { get: () => ({ requestRejection: () => undefined }) };
  const handlers = { settings: information路由({ org, ctx, 项目: project }), preview: information路由({ org, ctx, 项目: project, mode: 'preview' }) };
  const calls = [];
  let pending = 0;
  const s = await settingsScene({ informationOnly: true, informationRequest: async (url, init) => {
    pending++;
    try {
    calls.push({ url, method: init.method, body: init.body && JSON.parse(init.body) });
    const req = { method: init.method, url, headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() { if (init.body) yield Buffer.from(init.body); } };
    const res = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
    await handlers[url.startsWith('/plugins/dsh-mind/information-material') ? 'preview' : 'settings'](req, res);
    return jsonResponse(res.body, res.status);
    } finally { pending--; }
  } });
  const wait = async () => { for (let n = 0; n < 300; n++) { await s.flush(); if (!pending && !s.text().includes('正在处理并核对…')) { await s.flush(); if (!pending) return; } } throw Error('Information UI did not settle'); };
  const click = s.click;
  s.click = async label => { await click(label); await wait(); };
  try { await wait(); await run(s, org, f, calls); } finally { s.close(); await org.observability.flush(); await f.cleanup(); }
}

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
  s.change('每日辅助阅读次数', '2');
  const before = await org.information.load();
  await org.information.admin({ subject: SOVEREIGN, project, session: null }, { op: 'configure', expectedRevision: before.configRevision, config: { ...before.config, dailyReadChars: 12345 } });
  await s.click('刷新见闻与成长');
  assert.equal(s.field('每日辅助阅读次数').props.value, 2);
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
