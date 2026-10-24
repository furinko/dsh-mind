import { it } from 'node:test';
import assert from 'node:assert/strict';
import { settingsScene } from './settings-fixture.mjs';
import { jsonResponse } from './client-harness.mjs';
import { makeFixture, SOVEREIGN, LEAD } from '../../../test/helpers.mjs';
import { Org } from '../../../src/org.js';
import { leadSpace路由 } from '../../kernel/lib/routes.js';

const project = 'free-space-ui';
const human = { subject: SOVEREIGN, project, session: null };
async function scene(run) {
  const f = await makeFixture(); const org = await Org.open({ ...f, project });
  const handler = leadSpace路由({ org, ctx: { get: () => ({ requestRejection: () => undefined }) }, 项目: project });
  let pending = 0;
  const ui = await settingsScene({ spaceOnly: true, leadSpaceRequest: async (url, init) => {
    pending++;
    try {
      const req = { method: init.method, url, headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { if (init.body) yield Buffer.from(init.body); } };
      const res = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } }; await handler(req, res); return jsonResponse(res.body, res.status);
    } finally { pending--; }
  } });
  const wait = async () => { for (let i = 0; i < 150; i++) { await ui.flush(); if (!pending && !ui.text().includes('正在保存…')) return; } throw Error('Lead space UI did not settle'); };
  const click = ui.click; ui.click = async label => { await click(label); await wait(); };
  try { await wait(); await run(ui, org); } finally { ui.close(); await org.observability.flush(); await f.cleanup(); }
}
it('自由时光默认紧凑，独立弹窗分区，关闭和切页保留活动草稿，实际保存经认证路由回读', async () => scene(async (s, org) => {
  assert.equal(s.elements().filter(e => e.props.role === 'dialog').length, 0);
  assert.ok(s.field('开启自由活动')); await s.click('安排与随笔');
  assert.equal(s.field('自由时光与随笔').props['aria-modal'], true);
  s.change('自由活动时区', 'Asia/Shanghai'); s.change('自由活动每日请求上限', '2');
  await s.click('自己的随笔'); await s.click('关闭自由时光'); await s.click('安排与随笔'); await s.click('活动安排');
  assert.equal(s.field('自由活动每日请求上限').props.value, 2);
  await s.click('保存活动安排'); const state = await org.leadSpace.load(); assert.equal(state.config.dailyCalls, 2); assert.equal(state.config.timezone, 'Asia/Shanghai');
  assert.equal(state.config.enabled, false, '修改安排不擅自开启活动');
  assert.ok(s.calls.some(c => c.method === 'POST' && c.body?.op === 'configure'));
  assert.match(s.text(), /不是精确费用封顶/);
}));
it('设置冲突保留旧草稿，不覆盖别处修改；取消后采用最新状态', async () => scene(async (s, org) => {
  await s.click('安排与随笔'); s.change('自由活动每日请求上限', '2');
  const state = await org.leadSpace.load(); await org.leadSpace.configure(human, { expectedRevision: state.revision, config: { ...state.config, seconds: 30 } });
  await s.click('保存活动安排'); assert.match(s.text(), /草稿已保留/); assert.equal(s.field('自由活动每日请求上限').props.value, 2);
  assert.equal((await org.leadSpace.load()).config.dailyCalls, 4); await s.click('取消安排修改'); assert.equal(s.field('自由活动最长秒数').props.value, 30);
}));
it('随笔正文按需读取，人侧修订及确认删除走同一正式服务，不产生正式记忆', async () => scene(async (s, org) => {
  await org.leadSpace.update({ subject: LEAD, session: LEAD.id, project }, { op: 'write', title: '小鱼', text: '未成形的想法' });
  await s.click('安排与随笔'); await s.click('自己的随笔'); await s.click('查看随笔');
  assert.equal(s.field('随笔内容').props.value, '未成形的想法'); s.change('随笔内容', '人的修订'); await s.click('保存随笔修订');
  let list = await org.leadSpace.query(human); assert.equal(list.entries[0].humanEdited, true);
  await s.click('查看随笔'); await s.click('删除这篇随笔'); assert.equal((await org.leadSpace.query(human)).total, 1);
  await s.click('确认删除随笔'); assert.equal((await org.leadSpace.query(human)).total, 0);
  assert.equal((await org.memory.query({ subject: LEAD, 类: '经历', 项目: project })).条目.length, 0);
}));
