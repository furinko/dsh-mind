import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settingsScene } from './settings-fixture.mjs';
const posts = t => t.calls.filter(c => c.method === 'POST' && c.url === '/plugins/dsh-mind/persona-core');

test('核心人设位于设置首屏；缺卡可创建，保存回读后可留空停用', async () => {
  const t = await settingsScene(); try {
    assert.match(t.text(), /尚未创建核心人设卡/);
    assert.equal(t.field('核心人设内容').type, 'textarea');
    assert.equal(t.button('保存核心人设').props.disabled, true);
    t.change('核心人设内容', '# 人设\n坦诚，保持好奇。🙂');
    await t.click('保存核心人设');
    assert.equal(t.state.persona.text, '# 人设\n坦诚，保持好奇。🙂');
    assert.match(t.text(), /核心人设已保存并回读一致/);
    assert.equal(t.button('保存核心人设').props.disabled, true);
    assert.equal(posts(t).length, 1);
    assert.deepEqual(Object.keys(posts(t)[0].body).sort(), ['expectedFingerprint', 'text']);
    t.change('核心人设内容', ''); await t.click('保存核心人设');
    assert.equal(t.state.persona.text, ''); assert.equal(t.state.persona.exists, true);
  } finally { t.close(); }
});

test('重新读取保留人设草稿；外部变更禁用陈旧保存，显式取消后采用当前卡', async () => {
  const t = await settingsScene({ personaText: 'old' }); try {
    t.change('核心人设内容', 'draft');
    await t.click('重新读取'); assert.equal(t.field('核心人设内容').props.value, 'draft');
    t.state.persona.text = 'external'; await t.poll();
    assert.equal(t.field('核心人设内容').props.value, 'draft');
    assert.equal(t.button('保存核心人设').props.disabled, true);
    assert.match(t.text(), /核心人设已在别处更新/);
    await t.click('采用当前人设'); assert.equal(t.field('核心人设内容').props.value, 'external');
    assert.equal(posts(t).length, 0);
    t.change('核心人设内容', 'cancel me'); await t.click('取消人设修改');
    assert.equal(t.field('核心人设内容').props.value, 'external');
  } finally { t.close(); }
});

test('尚未被轮询观察到的冲突也保留草稿', async () => {
  const t = await settingsScene({ personaText: 'old', beforePersonaSave(state) { state.persona.text = 'external'; } }); try {
    t.change('核心人设内容', 'draft'); await t.click('保存核心人设');
    assert.equal(t.field('核心人设内容').props.value, 'draft');
    assert.equal(t.state.persona.text, 'external');
    assert.match(t.text(), /草稿已保留/);
    assert.equal(t.button('保存核心人设').props.disabled, true);
  } finally { t.close(); }
});

test('同帧双击只写一次，保存中禁用刷新，字符上限按Unicode字符计数', async () => {
  const t = await settingsScene(); try {
    t.change('核心人设内容', '🙂'.repeat(3000));
    assert.equal(t.button('保存核心人设').props.disabled, false);
    t.change('核心人设内容', '🙂'.repeat(3001));
    assert.equal(t.button('保存核心人设').props.disabled, true);
    t.change('核心人设内容', 'new'); t.state.hold = '/plugins/dsh-mind/persona-core';
    const save = t.button('保存核心人设').props.onClick; save(); save(); await t.flush();
    assert.equal(posts(t).length, 1); assert.equal(t.button('重新读取').props.disabled, true);
    t.state.release(); await t.flush();
    assert.equal(t.field('核心人设内容').props.value, 'new');
    assert.equal(t.button('保存核心人设').props.disabled, true);
  } finally { t.close(); }
});

test('保存后的新回读不被先发后到的旧人设轮询覆盖', async () => {
  const t = await settingsScene({ personaText: 'old' }); try {
    t.state.holdPersonaRead = true; await t.poll();
    assert.ok(t.state.releasePersonaRead);
    t.change('核心人设内容', 'new'); await t.click('保存核心人设');
    t.state.releasePersonaRead(); await t.flush();
    assert.equal(t.field('核心人设内容').props.value, 'new');
    assert.match(t.text(), /核心人设已保存并回读一致/);
  } finally { t.close(); }
});

for (const mode of ['no-save', 'audit-failure', 'read-failure']) test(`${mode} 不把POST或不完整回执显示为已保存`, async () => {
  const t = await settingsScene({ personaText: 'old' }); try {
    t.change('核心人设内容', 'new');
    t.state.personaMode = mode;
    if (mode === 'read-failure') t.state.personaReadFailure = true;
    await t.click('保存核心人设');
    assert.doesNotMatch(t.text(), /核心人设已保存并回读一致/);
    assert.equal(t.field('核心人设内容').props.value, 'new');
    assert.match(t.text(), /未确认|未完整确认|未一致/);
  } finally { t.close(); }
});
