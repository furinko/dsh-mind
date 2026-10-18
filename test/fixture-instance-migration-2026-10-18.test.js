/**
 * 夹具实例统一迁移（v2 条目10/20 的测试准备面 · 2026-10-18）。
 *
 * 背景：7f8 将把「Lead/成员新写凭证」统一翻严（卡版本 + 委派父归属）。在那之前，
 * 夹具不能靠「伪身份行」让合法 case 过闸——默认合法成员必须经**真实 Registry 从合法 Lead
 * 登记**（真卡版本 + 委派父），而 legacy 缺证必须是测试**显式**选择的初态，不能被悄悄补钉。
 *
 * 本文件钉夹具合同（不测产品策略；策略闸由 7f8 的测试面覆盖）：
 *  - 默认：lead 由主权者钉版；member-a/b/reviewer 由该 Lead 登记（真卡版本 + 委派者=lead 及其卡版本）；
 *  - `legacyMembers:true`：成员保持旧形状（无卡版本/无委派者），Lead 仍合法钉版（特测缺证反例）；
 *  - `lead:'unpinned'|'absent'`：显式关默认 setup，不自动补钉/复活；
 *  - 自定义 members 保留测试意图：封存的不复活、无卡的岗位不硬登记；
 *  - 默认岗位卡数 = 真实卡数（Lead/插件工程/复核员 + _模板），计数与卡对应。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture } from './helpers.mjs';

describe('夹具实例统一迁移：默认真钉 + 显式反例', () => {
  it('默认合法成员经真实 Lead 登记：真卡版本 + 委派父（含父自己钉住的卡版本）', async () => {
    const f = await makeFixture();
    try {
      const id = await f.registry.identity();
      const lead = id.members.lead;
      assert.equal(lead.status, '在岗');
      assert.ok(lead.卡版本?.摘要, 'Lead 钉版（真摘要）');
      for (const 实例 of ['member-a', 'member-b', 'reviewer']) {
        const m = id.members[实例];
        assert.ok(m?.卡版本?.摘要, `${实例} 有真卡版本`);
        assert.equal(m.委派者?.id, 'lead', `${实例} 的委派父=合法 Lead`);
        assert.equal(m.委派者?.kind, 'Lead');
        assert.equal(m.委派者?.卡版本, lead.卡版本.摘要, `${实例} 的父归属带父的卡版本`);
      }
      const 卡 = (await f.registry.list()).map((r) => r.id).sort();
      assert.deepEqual(卡, ['Lead', '_模板', '复核员', '插件工程'].sort(), '默认岗位卡数 = 真实卡数（计数与卡对应）');
    } finally { await f.cleanup(); }
  });

  it('legacyMembers 显式选择：成员保留旧形状（无卡版本/无委派者），Lead 仍合法钉版', async () => {
    const f = await makeFixture({ legacyMembers: true });
    try {
      const id = await f.registry.identity();
      assert.ok(id.members.lead?.卡版本?.摘要, 'Lead 仍合法钉版（legacy 只针对成员缺证）');
      for (const 实例 of ['member-a', 'member-b', 'reviewer']) {
        assert.equal(id.members[实例]?.卡版本, undefined, `${实例} 保留 legacy 缺证形状`);
        assert.equal(id.members[实例]?.委派者, undefined, `${实例} 无委派父归属`);
      }
    } finally { await f.cleanup(); }
  });

  it('lead:unpinned / absent 显式关默认 setup：不自动补钉、不假装合法初态', async () => {
    const unpinned = await makeFixture({ lead: 'unpinned' });
    try {
      const id = await unpinned.registry.identity();
      assert.equal(id.members.lead?.status, '在岗');
      assert.equal(id.members.lead?.卡版本, undefined, 'unpinned Lead 不许被自动补钉');
      assert.equal(id.members['member-a']?.卡版本, undefined, 'Lead 不合法时不替成员造父归属');
    } finally { await unpinned.cleanup(); }

    const absent = await makeFixture({ lead: 'absent' });
    try {
      const id = await absent.registry.identity();
      assert.equal(id.members.lead, undefined, 'absent：没有 lead 记录');
      assert.equal(await absent.registry.cardOf('lead'), null, 'absent：没有 Lead 钉版读数（不伪造）');
    } finally { await absent.cleanup(); }
  });

  it('自定义 members 保留测试意图：封存不复活、无卡岗位不硬登记', async () => {
    const f = await makeFixture({
      members: {
        'member-a': { id: 'member-a', 岗位: '插件工程', 代: 1, status: '在岗' },
        'sealed-x': { id: 'sealed-x', 岗位: '插件工程', 代: 1, status: '封存' },
        'no-card': { id: 'no-card', 岗位: '不存在的岗位', 代: 1, status: '在岗' },
      },
    });
    try {
      const id = await f.registry.identity();
      assert.equal(id.members['sealed-x'].status, '封存', '封存实例不被自动复活');
      assert.equal(id.members['sealed-x'].卡版本, undefined, '封存实例也不被补钉');
      assert.equal(id.members['no-card'].卡版本, undefined, '没有岗位卡的成员不硬登记（保留缺卡反例）');
      assert.ok(id.members['member-a']?.卡版本?.摘要, '有卡的默认岗位成员照常登记');
    } finally { await f.cleanup(); }
  });
});
