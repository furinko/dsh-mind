import { it } from 'node:test';
import assert from 'node:assert/strict';
import { settingsScene } from './settings-fixture.mjs';
import { jsonResponse } from './client-harness.mjs';

const initial = () => ({ version: 1, revision: 1, epoch: 0, enabled: true, entries: [{ id: 'desire-fixture', revision: 1, status: 'active',
  content: { title: '写小诗', reason: '想尝试表达', criterion: '两行小诗', kind: 'finite', importance: 0.8, commitment: 0.6, activities: ['write'], nextStep: '先写两行', renewalHours: 72 },
  progress: 0.2, frustration: 0, priority: { score: 0.7, satisfaction: 0.3, need: 0.7, blocked: null }, history: [] }], nextOffset: null });
async function scene(run) {
  const state = initial(); const ctl = { hold: null, release: null, bad: false, stale: false, posts: 0, last: null, noSave: false };
  const ui = await settingsScene({ desiresOnly: true, desireRequest: async (url, init) => {
    if (init.method === 'GET') return jsonResponse({ 成功: true, 数据: ctl.bad ? { ...state, entries: [{}] } : structuredClone(state) });
    ctl.posts++; const body = JSON.parse(init.body); ctl.last = body;
    if (ctl.hold) await new Promise(resolve => { ctl.release = resolve; });
    if (ctl.stale) return jsonResponse({ 成功: false, 理由: '追求版本已变化，请重新读取' }, 409);
    if (!ctl.noSave) {
      if (body.op === 'configure') state.enabled = body.enabled;
      if (body.op === 'state') { state.entries[0].status = body.status; state.entries[0].revision++; }
      if (body.op === 'revise') { state.entries[0].content = body.content; state.entries[0].revision++; }
      if (body.op === 'clear') { state.entries = []; state.epoch++; }
      state.revision++;
    }
    return jsonResponse({ 成功: true, 数据: { id: body.id, revision: state.entries[0]?.revision, stateRevision: state.revision, epoch: state.epoch } });
  } });
  try { await run(ui, state, ctl); } finally { ui.close(); }
}
it('追求设置展示优先级、满足和下一步，可暂停/恢复并回读确认', async () => scene(async (ui, state, ctl) => {
  assert.match(ui.text(), /写小诗/); assert.match(ui.text(), /满足 30%/); assert.match(ui.text(), /下一步：先写两行/);
  await ui.click('暂停「写小诗」'); assert.equal(state.entries[0].status, 'paused'); assert.match(ui.text(), /已保存并回读/);
  await ui.click('恢复「写小诗」'); assert.equal(state.entries[0].status, 'active'); assert.equal(ctl.posts, 2);
}));
it('修改取舍带当前版本，冲突保留草稿，采用最新内容后才能继续修改', async () => scene(async (ui, state, ctl) => {
  await ui.click('调整「写小诗」'); ui.change('追求重要性', '0.4'); ctl.stale = true; state.entries[0].revision++;
  await ui.click('保存追求调整'); assert.equal(ui.field('追求重要性').props.value, 0.4); assert.match(ui.text(), /版本已变化/);
  await ui.click('采用当前追求内容'); assert.equal(ui.field('追求重要性').props.value, 0.8);
  ctl.stale = false; ui.change('追求投入意愿', '0.5'); await ui.click('保存追求调整');
  assert.equal(ctl.last.revision, 2); assert.equal(state.entries[0].content.commitment, 0.5); assert.match(ui.text(), /已保存并回读/);
}));
it('停用和清空有独立版本及明确清空操作，不动核心卡和自由时光设置', async () => scene(async (ui, state, ctl) => {
  await ui.click('暂停追求延续'); assert.equal(state.enabled, false); assert.equal(ctl.last.op, 'configure'); assert.equal(ctl.last.expectedRevision, 1);
  await ui.click('准备清空追求'); assert.equal(state.entries.length, 1);
  await ui.click('确认清空全部追求'); assert.equal(state.entries.length, 0); assert.equal(state.epoch, 1); assert.match(ui.text(), /还没有保留的长期追求/);
  assert.ok(ui.calls.filter(c => c.method === 'POST').every(c => c.url === '/plugins/dsh-mind/lead-desires'));
}));
it('重复点击只发一次，假成功与坏结构不显示保存成功', async () => scene(async (ui, state, ctl) => {
  ctl.hold = true; const button = ui.button('暂停「写小诗」'); button.props.onClick(); button.props.onClick(); ui.r.flush(); await ui.flush();
  assert.equal(ctl.posts, 1); ctl.release(); await ui.flush(); await ui.flush();
  ctl.hold = false; ctl.noSave = true; await ui.click('恢复「写小诗」'); assert.match(ui.text(), /回读结果与本次修改不一致/);
  ctl.bad = true; await ui.click('重新读取追求'); assert.match(ui.text(), /暂不可读/); assert.equal(ui.button('开启追求延续'), undefined);
  ctl.bad = false; state.entries[0].history = [{ kind: 'feedback' }]; await ui.click('重新读取追求'); assert.match(ui.text(), /暂不可读/);
}));
