/**
 * 角色卡双区同名语义：`list()` 与 `get()` 必须同一个口径 —— 且冲突不许被静默吞掉。
 *
 * 守的是一件事：**同名岗位卡在「列」和「读」上给同一个答案，
 * 而「存在同名」这件事仍然看得见**。
 *
 * 改动前的形状（实测真源，非推测）：
 *   - `get()`：`for (const zone of ['自治','出厂'])` 命中即 return ⇒ 私有优先，同名只用一份；
 *   - `list()`：`return this.#scanCards()` ⇒ 两区都 push，无去重、无覆盖 ⇒ 同名出两行。
 * 同一条读取链上两种语义并存：`registry_list` 报 2 个岗位，`registry_can`（走 get）只认 1 个。
 * 谁也没写错，错的是「同一件事有两个口径」。
 *
 * 为什么带对照组：一个「把所有重复都删掉」的实现能让判据①变绿，
 * 却会把只在出厂区存在的那张卡一起吃掉、或把所有卡都标成同名冲突。
 * 所以每条正例都配一条反例。绿不稀奇，**能变红**才说明它测的是真东西（铁律：能造坏才算修好）。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Clock } from '../src/kernel/time.js';
import { Layout } from '../src/paths.js';
import { AuditLog } from '../src/audit.js';
import { RoleRegistry } from '../src/registry.js';
import { makeFixture, writeUnder } from './helpers.mjs';

const 卡目录 = '集体L3-成员角色卡';
const 同名 = '同名岗';
const 仅出厂 = '仅出厂岗';

/** 出厂区那一份。与私有版内容刻意不同，用来分辨「生效的是哪一份」。 */
const 出厂版 = (id) => `---
id: ${id}
kind: 身份
authority: 自治
zone: 出厂
domain: 个体
version: 1
---
# ${id}（出厂版）

## 个体L0 · 身份
出厂的那一份。

## 个体L1 · 规则
出厂规则。

## 个体L2 · 能力
出厂-能力-甲

## 个体L3 · 经验
出厂-经验-甲
`;

const 私有版 = (id) => `---
id: ${id}
kind: 身份
authority: 自治
zone: 自治
domain: 个体
version: 1
---
# ${id}（私有版）

## 个体L0 · 身份
私有的那一份。

## 个体L1 · 规则
私有规则。

## 个体L2 · 能力
私有-能力-乙
私有-能力-丙

## 个体L3 · 经验
私有-经验-乙
`;

/** 对照组：只在出厂区存在，去重不许把它一起吃掉。 */
const 仅出厂卡 = `---
id: ${仅出厂}
kind: 身份
authority: 自治
zone: 出厂
domain: 个体
version: 1
---
# ${仅出厂}

## 个体L0 · 身份
只有出厂区有。
`;

describe('角色注册表 · 双区同名：「列」与「读」是同一个口径，且冲突可见', () => {
  let fixture;
  let registry;

  before(async () => {
    fixture = await makeFixture();
    // 夹具与出厂内容解耦：同名卡两区各写一份，另加一张只在出厂区的卡。
    await writeUnder(fixture.factoryRoot, `${卡目录}/${同名}.md`, 出厂版(同名));
    await writeUnder(fixture.factoryRoot, `${卡目录}/${仅出厂}.md`, 仅出厂卡);
    await writeUnder(fixture.privateRoot, `${卡目录}/${同名}.md`, 私有版(同名));
    const layout = new Layout({ factoryRoot: fixture.factoryRoot, privateRoot: fixture.privateRoot });
    const clock = new Clock();
    const audit = new AuditLog({ layout, clock });
    registry = new RoleRegistry({ layout, policy: fixture.policy, audit, clock });
  });

  after(async () => {
    await fixture.cleanup();
  });

  it('判据①：list() 的同一 id 不再出现两行', async () => {
    const ids = (await registry.list()).map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, `list() 输出了重复 id：${JSON.stringify(ids)}`);
    assert.equal(ids.filter((i) => i === 同名).length, 1, `「${同名}」应只出现一行，实际 ${ids.filter((i) => i === 同名).length} 行`);
  });

  it('判据①·对照组：去重不许连「只在出厂」的卡一起吃掉', async () => {
    const ids = (await registry.list()).map((r) => r.id);
    assert.ok(ids.includes(仅出厂), `只在出厂区存在的岗位卡被丢了：${JSON.stringify(ids)}`);
  });

  it('判据②：同名冲突仍然可见——行上带得出「两区都有」', async () => {
    const 行 = (await registry.list()).find((r) => r.id === 同名);
    assert.ok(行, `「${同名}」没出现在 list() 里`);
    assert.ok(Array.isArray(行.同名), `list() 的行必须带可读的「同名」数组字段，实际 ${JSON.stringify(行.同名)}`);
    assert.deepEqual(行.同名, ['私有', '出厂'], `两区来源没被如实列出：${JSON.stringify(行.同名)}`);
    // R18 口径改形：两区都有 ⇒ 来源报「合并（私有+出厂）」（生效文档为段级合并产物）。
    assert.equal(行.来源, '合并（私有+出厂）', '两区都有时生效来源是段级合并');
    assert.equal(行.同名[0], '私有', '「同名」的第一项仍即生效首层（私有），读的人不用再对照两处');
  });

  it('判据②·对照组：不同名的卡不虚报冲突', async () => {
    const 行 = (await registry.list()).find((r) => r.id === 仅出厂);
    assert.ok(行);
    assert.deepEqual(行.同名, ['出厂'], `只在出厂区存在的卡被虚报成同名冲突：${JSON.stringify(行.同名)}`);
    assert.equal(行.来源, '出厂');
  });

  it('判据②·可读途径：list() 与 get() 对「这个 id 在两区都有」给同一条答案', async () => {
    const 行 = (await registry.list()).find((r) => r.id === 同名);
    const 卡 = await registry.get({ id: 同名 });
    assert.ok(卡);
    assert.equal(卡.来源, 行.来源, 'list() 与 get() 报告了不同的生效来源');
    // R18（审查 2026-10-16 口径改形）：两区都有时生效文档是**段级合并**的产物，不再报「私有」。
    // 修前报「私有」而运行态是整文件替换——那正是报告 R18 的「解释与运行态不符」：
    // 私有只定制无关段时，出厂里未被碰过的条款在生效面上消失（限制实际失效）。
    assert.equal(卡.来源, '合并（私有+出厂）', '同名时生效的是段级合并版（私有同名段覆盖、未出现段继承出厂）');
  });

  it('判据③：get() 取值语义——段级合并版生效（夹具私有四段俱全 ⇒ 内容逐字来自私有那份）', async () => {
    const 卡 = await registry.get({ id: 同名 });
    assert.ok(卡, 'get() 取不到同名岗');
    // R18：来源标签改为「合并」（两区都有）；**取值语义**的断言一个不放松——
    // 本夹具的私有版四段俱全，故合并结果应与私有版逐字一致（同名段覆盖的极端情形）。
    assert.equal(卡.来源, '合并（私有+出厂）');
    assert.deepEqual(卡.能力引用, ['私有-能力-乙', '私有-能力-丙'], `能力引用应来自私有版：${JSON.stringify(卡.能力引用)}`);
    assert.deepEqual(卡.经验引用, ['私有-经验-乙']);
    assert.ok(卡.正文.includes('私有版'), '正文应来自私有那份');
    assert.ok(!卡.正文.includes('出厂版'), '正文里混进了出厂那份');
  });

  it('判据③·补：私有只定制一段 ⇒ 出厂其余段必须继承（R18 的修复本体）', async () => {
    // 修前（整文件替换）：私有命中即短路 ⇒ 出厂里未被碰过的段在生效面上消失。
    // 报告 R18 实证：出厂权限条款 deny、私有只定制无关段 ⇒ 限制实际消失、请求误 allow。
    await writeUnder(
      fixture.privateRoot,
      `${卡目录}/${同名}.md`,
      `---
id: ${同名}
kind: 身份
authority: 自治
zone: 自治
domain: 个体
version: 1
---
# ${同名}（只定制一段）

## 个体L0 · 身份
只有这一段是私有改的。
`,
    );
    const 卡 = await registry.get({ id: 同名 });
    assert.ok(卡, 'get() 取不到同名岗');
    assert.ok(String(卡.正文).includes('只有这一段是私有改的'), '私有段生效');
    assert.ok(String(卡.正文).includes('出厂规则') || String(卡.段?.['个体L1 · 规则'] ?? '').includes('出厂'), `未定制的出厂段必须继承：段=${JSON.stringify(卡.段)}`);
    assert.ok(JSON.stringify(卡.段).includes('出厂-能力-甲') || String(卡.正文).includes('出厂-能力-甲'), `出厂能力段必须继承：${JSON.stringify(卡.段)}`);
    // 恢复夹具（后续用例依赖原私有版）。
    await writeUnder(fixture.privateRoot, `${卡目录}/${同名}.md`, 私有版(同名));
  });

  it('判据③·对照组：只在出厂区的卡照旧读得到', async () => {
    const 卡 = await registry.get({ id: 仅出厂 });
    assert.ok(卡);
    assert.equal(卡.来源, '出厂');
  });

  it('判据③：canTouch() 的取值链没被去重改动带偏——同名实例的能力/经验仍取自私有版', async () => {
    await writeUnder(
      fixture.privateRoot,
      '身份档案/identity.json',
      `${JSON.stringify(
        { members: { 'member-same': { id: 'member-same', 岗位: 同名, 代: 1, status: '在岗' } }, sovereign: { lastInteraction: new Date().toISOString() }, denylist: [] },
        null,
        2,
      )}\n`,
    );
    await fixture.policy.reload();
    const 答 = await registry.canTouch({ id: 'member-same' });
    assert.equal(答.岗位, 同名);
    assert.equal(答.在岗, true);
    assert.deepEqual(答.能力, ['私有-能力-乙', '私有-能力-丙'], `canTouch 的能力引用应来自私有版：${JSON.stringify(答.能力)}`);
    assert.deepEqual(答.经验, ['私有-经验-乙']);
  });

  it('判据②：每一行都带「同名」，且它列出的区数就是这张卡实际所在的区数', async () => {
    const 行表 = await registry.list();
    assert.ok(行表.length > 0, '夹具没扫出任何岗位卡');
    for (const 行 of 行表) {
      assert.ok(Array.isArray(行.同名), `行 ${行.id} 缺「同名」字段：${JSON.stringify(Object.keys(行))}`);
      assert.ok(行.同名.length >= 1, `行 ${行.id} 的「同名」为空——连生效来源都没记：${JSON.stringify(行.同名)}`);
      // R18 口径改形：两区都有 ⇒ 来源是「合并（…）」，而 同名 首项仍是生效首层（私有）。
      if (行.同名.length > 1) {
        assert.equal(行.同名[0], '私有', `两区同名行 ${行.id} 的生效首层应为私有`);
        assert.ok(String(行.来源).includes(行.同名[0]), `行 ${行.id} 的合并来源「${行.来源}」里应含生效首层 ${行.同名[0]}`);
      } else {
        assert.equal(行.同名[0], 行.来源, `单区行 ${行.id} 的来源应与同名首项一致`);
      }
      assert.equal(new Set(行.同名).size, 行.同名.length, `行 ${行.id} 的来源有重复：${JSON.stringify(行.同名)}`);
      assert.ok(行.同名.every((z) => z === '私有' || z === '出厂'), `行 ${行.id} 出现未知来源：${JSON.stringify(行.同名)}`);
    }
    // 冲突可见的充分条件：只有同名那张卡的两区来源长度 > 1。
    assert.deepEqual(
      行表.filter((r) => r.同名.length > 1).map((r) => r.id),
      [同名],
      '「两区都有」这张表只应点名真正的冲突卡',
    );
  });

  it('判据①③：sync() 的索引仍是「盘上有什么」的如实台账（两区并列），与对外口径分开', async () => {
    const 读数 = await registry.sync();
    // 对外：一个 id 一行。
    const 对外 = (await registry.list()).map((r) => r.id);
    assert.equal(new Set(对外).size, 对外.length, `对外清单出现重复 id：${JSON.stringify(对外)}`);
    // 索引：同名两行照记（索引不是给外部读的「清单」，是台账）。
    assert.ok(读数.岗位 >= 对外.length, `索引岗位数 ${读数.岗位} 小于对外清单 ${对外.length}`);
  });
});
