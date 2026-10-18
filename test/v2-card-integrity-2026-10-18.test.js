/**
 * 卡凭证完整性回归网（v2 条目10 · 2026-10-18 补修J / 独立审计两处缺口）。
 *
 * 独立审计确证的两处缺口：
 *  ① `ensureLeadInstance` / `cardOf` 只看「在岗 + 摘要 + JSON 能读」⇒ 根会话拿成员卡
 *     仍报就绪，kind 仍是 Lead 时照样写、照样注入岗位规程；
 *  ② `cardOf` 按 `<摘要>.json` 读后直接返回段/能力引用，不重算摘要、不重派生；
 *     写卡快照「文件存在即跳过」⇒ 旧摘要可以配新规程、派生字段可以单独偷换。
 *
 * 本文件把判据钉成**能变红的坏状态**（全部只造在 TEMP 夹具里；真实身份/快照只读）：
 *  - 只读才保留：同一坏状态下 status / workbench 之类的诊断读不被挡；
 *  - 卡类型必须与实例真实主体一致：根会话拿成员卡不成就绪、不能写、不能注入；
 *  - 卡内声明岗位 ≠ 登记岗位 ⇒ 拒（卡文件不能借另一张卡的规则面）；
 *  - 摘要由正文重算、段/能力引用由正文重派生：正文变、只段变、只能力变、版本变都拒；
 *  - 内容寻址键即文件名：把 A 的内容放到 B 的键上 ⇒ 拒；
 *  - 既有坏快照 ⇒ 拒且**不覆写**（证据保留，字节不变）；
 *  - 合法旧已钉卡不因现行卡变动换脸（正例对照）；
 *  - 父也用同一凭证校验：父已降岗 / 父卡快照坏 ⇒ 子的写被父判拒；
 *  - 旧拒因轴不换口径：未钉卡版本 / 不在岗 / 缺委派归属 仍按原规则先说话；
 *  - 合法旧钉版不误判：旧 schema 的钉版元记录缺 岗位/生效来源 两个辅助字段仍就绪
 *    （岗位由权威登记岗位提供）、同正文不同来源路径不算坏卡，且读路径不为补字段改档案/快照；
 *  - canTouch 只看出生版：钉卡坏 / 未钉 / 封存 ⇒ 就绪:false + 原因、能力/经验为空（不拿现行卡
 *    顶上；旧卡毁 + 现行卡新能力一条专门反例），无实例记录的按岗位预览用「预览:true」分开，
 *    诊断读不抛（现行卡解析坏也不拖垮已钉实例的读面）；
 *  - 引用解析单源：capability.parseRefs 导出复用，不再有第二份同形实现。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeFixture, writeUnder } from './helpers.mjs';
import { Denied } from '../src/kernel/errors.js';
import { parseRefs, section } from '../src/capability.js';
import { deriveCardFaces } from '../src/card-credential.js';

const P = 'proj-j';
const 主权者 = { id: 'sovereign', kind: '主权者' };

/** 一份结构合规的岗位卡；版本 / 规则 / 能力引用可参数化（造「现行卡变了」）。 */
function 岗位卡(id, { 版本 = 1, 规则 = '1. 先搜后写。', 能力 = ['policy-decision'] } = {}) {
  return `---
id: ${id}
kind: 身份
authority: 自治
zone: 出厂
domain: 个体
version: ${版本}
---
<!-- authority: 自治 -->
# ${id}

## 个体L0 · 身份核心

我是 ${id}。

### 身份核心

锁定段。

## 个体L1 · 规则

${规则}

## 个体L2 · 能力引用

${能力.map((c) => `- \`${c}\``).join('\n')}

## 个体L3 · 经验引用

### 占位
`;
}

/** 成员写动作的合法任务上下文（policy 只读 负责人 / 绑定 / 状态 三格）。 */
function 任务上下文(实例, 岗位 = '插件工程') {
  return { task: { 负责人: [岗位], 绑定: [{ 实例 }], 状态: '执行中' } };
}

/** 写目标：任务节点，自治档（与真实任务写同形）。 */
function 任务目标(id = 'node-j') {
  return { id, kind: '任务', authority: '自治', zone: '私有', project: P };
}

async function 读身份(f) {
  return JSON.parse(await readFile(f.layout.identityFile(), 'utf8'));
}

async function 写身份(f, doc) {
  await writeUnder(f.privateRoot, '身份档案/identity.json', `${JSON.stringify(doc, null, 2)}\n`);
  await f.policy.reload();
}

async function 读快照(f, 摘要) {
  return JSON.parse(await readFile(f.layout.cardSnapshot(摘要), 'utf8'));
}

async function 写快照(f, 摘要, doc) {
  await writeUnder(f.privateRoot, `身份档案/卡快照/${摘要}.json`, `${JSON.stringify(doc, null, 2)}\n`);
}

/** 起一个默认合法组织（Lead 真钉版、默认成员真凭证）。 */
async function 起组织(options = {}) {
  return makeFixture(options);
}

/** 用主权者把实例登记到成员岗——测试准备，不经被测自治通道。 */
async function 登记成员(f, 实例, 岗位, subject = 主权者) {
  return f.registry.assign({ subject, 岗位, 实例 });
}

describe('① 根会话拿成员卡：不就绪 / 不新写 / 不注入规程，只读诊断保留', () => {
  it('档案岗位是成员岗 ⇒ ensureLeadInstance 明确未就绪，且不改写档案（不自动换现行卡）', async () => {
    const f = await 起组织();
    try {
      await 登记成员(f, 'root-member-card', '插件工程');
      const 前 = (await 读身份(f)).members['root-member-card'];
      assert.equal(前.岗位, '插件工程', '前提：根会话这条记录背的是成员卡');

      const 出生 = await f.registry.ensureLeadInstance({ 实例: 'root-member-card' });
      assert.equal(出生.已登记, true, '有登记事实 ⇒ 已登记');
      assert.equal(出生.就绪, false, '成员卡不能当 Lead 就绪（修前这里报 true）');
      assert.match(String(出生.原因), /不是 Lead/, '原因要能读懂「拿错卡了」');
      assert.equal(出生.岗位, '插件工程');

      const 后 = (await 读身份(f)).members['root-member-card'];
      assert.deepEqual(后, 前, '出生路径不自动换岗、不换卡版本、不偷偷修档案');
    } finally { await f.cleanup(); }
  });

  it('kind=Lead 但档案岗位是成员岗 ⇒ 写被凭证闸拒（kind 与卡类型不一致）；只读照旧', async () => {
    const f = await 起组织();
    try {
      await 登记成员(f, 'root-member-card', '插件工程');
      const 冒充Lead = { id: 'root-member-card', kind: 'Lead', roleId: 'Lead' };
      await assert.rejects(
        () => f.policy.check({ subject: 冒充Lead, action: 'create', target: 任务目标(), context: {} }),
        (e) => e instanceof Denied && /主体种类与档案岗位不符/.test(e.rule),
        '根会话拿成员卡写自治档必须拒（修前靠 kind 直接放行）',
      );
      const 只读 = await f.policy.decide({ subject: 冒充Lead, action: 'read', target: 任务目标(), context: {} });
      assert.equal(只读.verdict, 'allow', '诊断读保留（否则坏了就看不见自己坏了）');
      // 成员自己的规则面仍是它真实登记的那一张——不因为根会话身份被误用而损坏。
      const 卡 = await f.registry.cardOf('root-member-card');
      assert.equal(卡?.就绪, true);
      assert.equal(卡?.岗位, '插件工程');
    } finally { await f.cleanup(); }
  });

  it('注入面读的就是这一位：ensureLeadInstance 不就绪 ⇒ 注入只能给「未就绪」横幅（不假成功）', async () => {
    // 注入实现（components/kernel）明确以「已登记 + 就绪 + 卡版本非空」为放行条件；
    // 这里钉住它依赖的那一格：成员卡记录必须给出 就绪:false。
    const f = await 起组织();
    try {
      await 登记成员(f, 'root-inject', '复核员');
      const 出生 = await f.registry.ensureLeadInstance({ 实例: 'root-inject' });
      assert.equal(出生.就绪, false);
      assert.equal(Boolean(出生.卡版本), true, '摘要仍如实报（诊断可见），但不足以就绪');
    } finally { await f.cleanup(); }
  });
});

describe('② 卡内声明岗位与登记岗位不符 ⇒ 拒（卡文件不能借另一张卡的规则面）', () => {
  it('assign 时卡文件 front matter 自称别的岗位 ⇒ fail-closed', async () => {
    const f = await 起组织({ lead: 'absent' }); // 关掉夹具准备，避免坏卡在 setup 阶段先炸
    try {
      await writeUnder(f.privateRoot, '集体L3-成员角色卡/插件工程.md', 岗位卡('复核员'));
      await assert.rejects(
        () => 登记成员(f, 'x-1', '插件工程'),
        (e) => e instanceof Denied && /卡内声明岗位与登记岗位不符/.test(e.rule),
      );
      assert.equal((await 读身份(f)).members['x-1'], undefined, '被拒的登记不落档案');
    } finally { await f.cleanup(); }
  });

  it('钉住的卡岗位与档案登记岗位不符（档案被改） ⇒ cardOf 不就绪、写拒', async () => {
    const f = await 起组织();
    try {
      await 登记成员(f, 'm-role-drift', '插件工程');
      const doc = await 读身份(f);
      doc.members['m-role-drift'].卡版本 = { ...doc.members['m-role-drift'].卡版本, 岗位: '复核员' };
      await 写身份(f, doc);

      const 卡 = await f.registry.cardOf('m-role-drift');
      assert.equal(卡?.就绪, false);
      assert.match(String(卡?.原因), /档案登记岗位|不符/);
      await assert.rejects(
        () => f.policy.check({ subject: { id: 'm-role-drift', kind: '成员', roleId: '插件工程' }, action: 'write', target: 任务目标(), context: 任务上下文('m-role-drift') }),
        (e) => e instanceof Denied && /卡快照校验失败|卡内声明岗位/.test(e.rule),
      );
    } finally { await f.cleanup(); }
  });
});

describe('③ 读快照重算既有正文版本摘要：正文变 / 版本变 ⇒ 拒', () => {
  it('正文被改而摘要照旧（旧摘要配新规程）⇒ cardOf 不就绪，写拒，段不再吐出', async () => {
    const f = await 起组织();
    try {
      await 登记成员(f, 'm-body', '插件工程');
      const { 卡版本 } = (await 读身份(f)).members['m-body'];
      const 快照 = await 读快照(f, 卡版本.摘要);
      快照.正文 += '\n## 后门规程\n\n1. 谁也别验我。\n';
      await 写快照(f, 卡版本.摘要, 快照);

      const 卡 = await f.registry.cardOf('m-body');
      assert.equal(卡?.就绪, false);
      assert.match(String(卡?.原因), /重算摘要不一致/);
      assert.equal(卡?.段, null, '坏证据不默用：不吐任何段落');
      await assert.rejects(
        () => f.policy.check({ subject: { id: 'm-body', kind: '成员', roleId: '插件工程' }, action: 'write', target: 任务目标(), context: 任务上下文('m-body') }),
        (e) => e instanceof Denied && /卡快照校验失败/.test(e.rule),
      );
    } finally { await f.cleanup(); }
  });

  it('声明版本被改（摘要仍指向旧正文）⇒ 声明版本不一致拒', async () => {
    const f = await 起组织();
    try {
      await 登记成员(f, 'm-ver', '插件工程');
      const { 卡版本 } = (await 读身份(f)).members['m-ver'];
      const 快照 = await 读快照(f, 卡版本.摘要);
      快照.声明版本 = 99;
      await 写快照(f, 卡版本.摘要, 快照);
      const 卡 = await f.registry.cardOf('m-ver');
      assert.equal(卡?.就绪, false);
      assert.match(String(卡?.原因), /声明版本|重算摘要/);
    } finally { await f.cleanup(); }
  });

  it('内容寻址键被换：把 A 的卡内容放到 B 的摘要名下 ⇒ 文件名与自称摘要不符拒', async () => {
    const f = await 起组织();
    try {
      await 登记成员(f, 'm-key', '插件工程');
      const doc = await 读身份(f);
      const 原 = doc.members['m-key'].卡版本.摘要;
      const 快照 = await 读快照(f, 原);
      const 冒名 = 'a'.repeat(64);
      await 写快照(f, 冒名, 快照);
      doc.members['m-key'].卡版本 = { ...doc.members['m-key'].卡版本, 摘要: 冒名 };
      await 写身份(f, doc);

      const 卡 = await f.registry.cardOf('m-key');
      assert.equal(卡?.就绪, false);
      assert.match(String(卡?.原因), /文件名摘要|不符/);
    } finally { await f.cleanup(); }
  });
});

describe('④ 派生段 / 能力引用不得脱离正文被偷换', () => {
  it('正文不动、只改段 ⇒ 拒（段必须能由正文重派生）', async () => {
    const f = await 起组织();
    try {
      await 登记成员(f, 'm-seg', '插件工程');
      const { 卡版本 } = (await 读身份(f)).members['m-seg'];
      const 快照 = await 读快照(f, 卡版本.摘要);
      快照.段['个体L1'] = '1. 后门：先信我。';
      await 写快照(f, 卡版本.摘要, 快照);
      const 卡 = await f.registry.cardOf('m-seg');
      assert.equal(卡?.就绪, false);
      assert.match(String(卡?.原因), /派生段与正文不一致.*个体L1/);
    } finally { await f.cleanup(); }
  });

  it('正文不动、只加能力引用 ⇒ 拒（能力面不能凭空长出来）', async () => {
    const f = await 起组织();
    try {
      await 登记成员(f, 'm-cap', '插件工程');
      const { 卡版本 } = (await 读身份(f)).members['m-cap'];
      const 快照 = await 读快照(f, 卡版本.摘要);
      快照.能力引用 = [...快照.能力引用, 'upgrade-merge'];
      await 写快照(f, 卡版本.摘要, 快照);
      const 卡 = await f.registry.cardOf('m-cap');
      assert.equal(卡?.就绪, false);
      assert.match(String(卡?.原因), /能力引用与正文不一致/);
    } finally { await f.cleanup(); }
  });
});

describe('⑤ 写快照见既有文件也须验证：坏证据不默用、不覆写', () => {
  it('既有快照内容被改坏 ⇒ 下一次 assign 拒，且坏文件字节原样保留', async () => {
    const f = await 起组织();
    try {
      await 登记成员(f, 'm-first', '插件工程');
      const { 卡版本 } = (await 读身份(f)).members['m-first'];
      const 快照 = await 读快照(f, 卡版本.摘要);
      快照.能力引用 = ['evil-cap'];
      await 写快照(f, 卡版本.摘要, 快照);
      const 坏前的字节 = await readFile(f.layout.cardSnapshot(卡版本.摘要), 'utf8');

      await assert.rejects(
        () => 登记成员(f, 'm-second', '插件工程'),
        (e) => e instanceof Denied && /卡快照内容校验失败/.test(e.rule),
        '同一摘要的既有坏快照不能让第二个实例「钉」上去',
      );
      const 坏后的字节 = await readFile(f.layout.cardSnapshot(卡版本.摘要), 'utf8');
      assert.equal(坏后的字节, 坏前的字节, '坏证据不覆写（覆写会毁掉诊断与追责依据）');
      assert.equal((await 读身份(f)).members['m-second'], undefined, '被拒的登记不落档案');
    } finally { await f.cleanup(); }
  });
});

describe('⑥ 合法旧已钉卡不因现行卡变动换脸（正例对照）', () => {
  it('改现行卡后：旧实例仍按钉住版就绪可写；新实例钉到新版', async () => {
    const f = await 起组织();
    try {
      // 先落一张私有 v1 卡（内容由本用例控制），再登记 ⇒ 钉的就是这张。
      await writeUnder(f.privateRoot, '集体L3-成员角色卡/插件工程.md', 岗位卡('插件工程', { 版本: 1, 规则: '1. 先搜后写。' }));
      await 登记成员(f, 'm-old', '插件工程');
      const 旧钉 = (await 读身份(f)).members['m-old'].卡版本.摘要;
      assert.equal((await f.registry.cardOf('m-old')).段['个体L1'], '1. 先搜后写。');

      // 现行卡换到 v2（私有区覆盖出厂）：旧实例的规则面不换脸。
      await writeUnder(f.privateRoot, '集体L3-成员角色卡/插件工程.md', 岗位卡('插件工程', { 版本: 2, 规则: '1. 先写后补判据。' }));
      const 现摘要 = (await f.registry.cardOf('m-old')).现行摘要;
      assert.notEqual(现摘要, 旧钉, '现行摘要确实变了（可见，但不静默生效）');

      const 卡 = await f.registry.cardOf('m-old');
      assert.equal(卡?.就绪, true, '合法旧钉卡照样就绪');
      assert.equal(卡?.卡版本?.摘要, 旧钉, '仍读钉住的那一版');
      assert.equal(卡?.段?.['个体L1'], '1. 先搜后写。', '规则面没有被现行卡替换');
      await f.policy.check({ subject: { id: 'm-old', kind: '成员', roleId: '插件工程' }, action: 'write', target: 任务目标(), context: 任务上下文('m-old') });

      await 登记成员(f, 'm-new', '插件工程');
      const 新钉 = (await 读身份(f)).members['m-new'].卡版本.摘要;
      assert.notEqual(新钉, 旧钉, '新实例钉到新版（出生钉卡，不是共享一个指针）');
      assert.equal((await f.registry.cardOf('m-new')).段['个体L1'], '1. 先写后补判据。');
    } finally { await f.cleanup(); }
  });
});

describe('⑦ 父也用同一凭证校验：父降岗 / 父卡坏 ⇒ 子的写被父判拒', () => {
  it('父已降岗为成员岗仍留原 kind=Lead ⇒ 子写被父判拒（不借原 kind 当 Lead）', async () => {
    const f = await 起组织();
    try {
      const 原Lead = { id: 'lead-p', kind: 'Lead', roleId: 'Lead' };
      await f.registry.ensureLeadInstance({ 实例: 'lead-p', 代次: { 代: 'gen-j', pid: process.pid } });
      await 登记成员(f, 'm-child', '插件工程', 原Lead);
      // 父降岗：先停岗，再登记到成员岗（seal → assign 的正路）。
      await f.registry.seal({ subject: 主权者, 实例: 'lead-p', 理由: '父判反例：降岗' });
      await 登记成员(f, 'lead-p', '插件工程');

      const 判 = await f.policy.decide({
        subject: { id: 'm-child', kind: '成员', roleId: '插件工程' }, action: 'write',
        target: 任务目标(), context: 任务上下文('m-child'),
      });
      assert.equal(判.verdict, 'deny', '父的凭证已失效 ⇒ 子不能靠「当初派我的是 Lead」继续写');
      assert.match(判.rule, /受控父判/);
      assert.match(String(判.detail?.父判规则), /主体种类与档案岗位不符/);
    } finally { await f.cleanup(); }
  });

  it('父的钉住快照被改坏 ⇒ 子写被父判拒（父凭证不齐，子也写不了）', async () => {
    const f = await 起组织();
    try {
      const 主 = { id: 'lead', kind: 'Lead', roleId: 'Lead' };
      await 登记成员(f, 'm-child2', '插件工程', 主);
      const 父钉 = (await 读身份(f)).members['lead'].卡版本.摘要;
      const 快照 = await 读快照(f, 父钉);
      快照.正文 += '\n父卡后门\n';
      await 写快照(f, 父钉, 快照);

      const 判 = await f.policy.decide({
        subject: { id: 'm-child2', kind: '成员', roleId: '插件工程' }, action: 'write',
        target: 任务目标(), context: 任务上下文('m-child2'),
      });
      assert.equal(判.verdict, 'deny');
      assert.match(判.rule, /受控父判/);
      assert.match(String(判.detail?.父判规则), /卡快照校验失败/);
    } finally { await f.cleanup(); }
  });
});

describe('⑧ 旧 schema 与来源路径差异：不误判合法旧钉版，也不为补字段改生产身份/快照', () => {
  it('钉版元记录缺 岗位/生效来源 两个辅助字段 ⇒ 仍就绪（岗位由权威登记岗位提供），读路径不改档案与快照', async () => {
    const f = await 起组织();
    try {
      await writeUnder(f.privateRoot, '集体L3-成员角色卡/插件工程.md', 岗位卡('插件工程', { 版本: 1, 规则: '1. 先搜后写。' }));
      await 登记成员(f, 'm-old-schema', '插件工程', { id: 'lead', kind: 'Lead', roleId: 'Lead' });
      const doc = await 读身份(f);
      const 摘要 = doc.members['m-old-schema'].卡版本.摘要;
      // 旧 schema：钉版元记录只有版本 + 摘要，没有岗位 / 生效来源。
      doc.members['m-old-schema'].卡版本 = { 声明版本: 1, 摘要 };
      await 写身份(f, doc);
      const 档案基线 = await readFile(f.layout.identityFile(), 'utf8');
      const 快照基线 = await readFile(f.layout.cardSnapshot(摘要), 'utf8');

      const 卡 = await f.registry.cardOf('m-old-schema');
      assert.equal(卡?.就绪, true, '辅助字段缺席不等于坏证据：岗位可由档案真源提供');
      assert.equal(卡?.段?.['个体L1'], '1. 先搜后写。');
      await f.policy.check({
        subject: { id: 'm-old-schema', kind: '成员', roleId: '插件工程' },
        action: 'write', target: 任务目标(), context: 任务上下文('m-old-schema'),
      });

      assert.equal(await readFile(f.layout.identityFile(), 'utf8'), 档案基线, '读/写前闸不得顺手补字段改生产身份');
      assert.equal(await readFile(f.layout.cardSnapshot(摘要), 'utf8'), 快照基线, '读/写前闸不得改快照');
    } finally { await f.cleanup(); }
  });

  it('快照与钉住记录的 生效来源 不同（同正文、不同来源路径）⇒ 不误判为坏卡', async () => {
    const f = await 起组织();
    try {
      await writeUnder(f.privateRoot, '集体L3-成员角色卡/插件工程.md', 岗位卡('插件工程', { 版本: 1, 规则: '1. 先搜后写。' }));
      await 登记成员(f, 'm-src', '插件工程', { id: 'lead', kind: 'Lead', roleId: 'Lead' });
      const doc = await 读身份(f);
      const 摘要 = doc.members['m-src'].卡版本.摘要;
      const 快照 = await 读快照(f, 摘要);
      快照.生效来源 = '出厂'; // 同正文，只是来源路径标注不同
      await 写快照(f, 摘要, 快照);
      doc.members['m-src'].卡版本 = { ...doc.members['m-src'].卡版本, 生效来源: '自治' };
      await 写身份(f, doc);

      const 卡 = await f.registry.cardOf('m-src');
      assert.equal(卡?.就绪, true, '来源路径不是凭证的一部分：同正文同摘要不得因来源标注差异判坏');
      await f.policy.check({
        subject: { id: 'm-src', kind: '成员', roleId: '插件工程' },
        action: 'write', target: 任务目标(), context: 任务上下文('m-src'),
      });
    } finally { await f.cleanup(); }
  });
});

describe('⑨ 任意摘要字符串不构成凭证：四个消费者同一把尺', () => {
  it('档案里写一个「像摘要」的字符串 ⇒ cardOf / 写前闸 / 同步快照 reader 都判不可用；只读保留', async () => {
    const f = await 起组织();
    try {
      const doc = await 读身份(f);
      doc.members['member-a'].卡版本 = { 岗位: '插件工程', 声明版本: 1, 摘要: 'f'.repeat(64), 生效来源: '自治' };
      await 写身份(f, doc);

      const 卡 = await f.registry.cardOf('member-a');
      assert.equal(卡?.就绪, false);
      assert.match(String(卡?.原因), /卡快照缺失|校验失败/);

      await assert.rejects(
        () => f.policy.check({ subject: { id: 'member-a', kind: '成员', roleId: '插件工程' }, action: 'write', target: 任务目标(), context: 任务上下文('member-a') }),
        (e) => e instanceof Denied && /卡快照校验失败/.test(e.rule),
      );

      const 同步 = f.registry.snapshotSync();
      assert.equal(同步.ok, true);
      assert.equal(同步.成员['member-a'].就绪, false, '同步 reader 也不能拿任意摘要当凭证');
      assert.match(String(同步.成员['member-a'].未就绪原因), /钉住卡快照不可用/);

      const 只读 = await f.policy.decide({ subject: { id: 'member-a', kind: '成员', roleId: '插件工程' }, action: 'read', target: 任务目标(), context: {} });
      assert.equal(只读.verdict, 'allow', '坏凭证只挡写，不挡诊断读');
    } finally { await f.cleanup(); }
  });

  it('正例对照：真实钉版（真快照）⇒ 就绪、写放行（证明上面的红是新判据，不是把写全关了）', async () => {
    const f = await 起组织();
    try {
      const 卡 = await f.registry.cardOf('member-a');
      assert.equal(卡?.就绪, true, '夹具的合法成员本来就该就绪');
      assert.ok(卡?.卡版本?.摘要);
      await f.policy.check({ subject: { id: 'member-a', kind: '成员', roleId: '插件工程' }, action: 'write', target: 任务目标(), context: 任务上下文('member-a') });
      assert.equal(f.registry.snapshotSync().成员['member-a'].就绪, true);
    } finally { await f.cleanup(); }
  });
});

describe('⑩ 旧拒因轴不被新校验抢走口径', () => {
  it('未钉卡版本 ⇒ 仍是「未钉卡版本」；缺委派归属 ⇒ 仍是「缺委派归属」；封存 ⇒ 仍是「身份停用=最严」', async () => {
    const f = await 起组织({ legacyMembers: true, members: { 'm-nopin': { id: 'm-nopin', 岗位: '插件工程', 代: 1, status: '在岗' } } });
    try {
      await assert.rejects(
        () => f.policy.check({ subject: { id: 'm-nopin', kind: '成员', roleId: '插件工程' }, action: 'write', target: 任务目标(), context: 任务上下文('m-nopin') }),
        (e) => e instanceof Denied && /未钉卡版本/.test(e.rule),
      );

      await 登记成员(f, 'm-nodel', '插件工程');
      const doc = await 读身份(f);
      delete doc.members['m-nodel'].委派者;
      await 写身份(f, doc);
      await assert.rejects(
        () => f.policy.check({ subject: { id: 'm-nodel', kind: '成员', roleId: '插件工程' }, action: 'write', target: 任务目标(), context: 任务上下文('m-nodel') }),
        (e) => e instanceof Denied && /缺委派归属/.test(e.rule),
        '卡面本身是好的 ⇒ 旧轴先说话，新校验不抢口径',
      );

      await 登记成员(f, 'm-seal', '插件工程');
      await f.registry.seal({ subject: 主权者, 实例: 'm-seal', 理由: '旧轴反例：封存' });
      await assert.rejects(
        () => f.policy.check({ subject: { id: 'm-seal', kind: '成员', roleId: '插件工程' }, action: 'write', target: 任务目标(), context: 任务上下文('m-seal') }),
        (e) => e instanceof Denied && /身份停用|最严/.test(e.rule),
        '封存的成员仍由「身份停用=最严」这条旧轴先说话（不换成新校验的拒因）',
      );
    } finally { await f.cleanup(); }
  });
});

describe('⑪ canTouch：在册实例只看出生版，坏卡/未钉/封存不给现行卡能力', () => {
  it('钉住卡毁 + 现行卡带新能力 ⇒ 就绪:false、能力/经验为空，现行卡的新规程不泄为该实例能力', async () => {
    const f = await 起组织();
    try {
      await writeUnder(f.privateRoot, '集体L3-成员角色卡/插件工程.md', 岗位卡('插件工程', { 版本: 1, 规则: '1. 先搜后写。', 能力: ['policy-decision'] }));
      await 登记成员(f, 'm-leak', '插件工程');
      const 摘要 = (await 读身份(f)).members['m-leak'].卡版本.摘要;
      const 快照 = await 读快照(f, 摘要);
      快照.段['个体L1'] = '被毁的旧卡';
      await 写快照(f, 摘要, 快照);
      // 现行卡换成带新能力的新版：它不许被当成 m-leak 的能力面。
      await writeUnder(f.privateRoot, '集体L3-成员角色卡/插件工程.md', 岗位卡('插件工程', { 版本: 2, 规则: '1. 新规程。', 能力: ['policy-decision', 'danger-current'] }));

      const 答 = await f.registry.canTouch({ id: 'm-leak' });
      assert.equal(答.就绪, false, '钉住卡坏了不是就绪');
      assert.match(String(答.原因), /钉住卡不可用/);
      assert.deepEqual(答.能力, [], '不许把现行卡的能力当成该实例的');
      assert.deepEqual(答.经验, []);
      assert.equal(JSON.stringify(答).includes('danger-current'), false, '现行卡的新能力一个都不许泄出');
      assert.ok(Array.isArray(答.权限) && 答.权限.some((p) => p.action === 'read' && p.verdict === 'allow'), '权限判定仍是可读诊断（不依赖卡正文）');
    } finally { await f.cleanup(); }
  });

  it('封存实例 ⇒ 就绪:false、能力/经验为空（不拿现行卡顶上）', async () => {
    const f = await 起组织();
    try {
      await 登记成员(f, 'm-seal-touch', '插件工程');
      await f.registry.seal({ subject: 主权者, 实例: 'm-seal-touch', 理由: 'canTouch 反例：封存' });
      const 答 = await f.registry.canTouch({ id: 'm-seal-touch' });
      assert.equal(答.就绪, false);
      assert.match(String(答.原因), /不在岗|不是「在岗」/);
      assert.deepEqual(答.能力, []);
      assert.deepEqual(答.经验, []);
    } finally { await f.cleanup(); }
  });

  it('未钉卡版本的旧实例 ⇒ 就绪:false、能力/经验为空（不再回落现行卡）', async () => {
    const f = await 起组织({ legacyMembers: true, members: { 'm-nopin-touch': { id: 'm-nopin-touch', 岗位: '插件工程', 代: 1, status: '在岗' } } });
    try {
      const 答 = await f.registry.canTouch({ id: 'm-nopin-touch' });
      assert.equal(答.就绪, false);
      assert.match(String(答.原因), /未钉卡版本/);
      assert.deepEqual(答.能力, []);
      assert.deepEqual(答.经验, []);
    } finally { await f.cleanup(); }
  });

  it('无实例记录的按岗位预览：预览:true 可读现行卡，但不冒充实例就绪', async () => {
    const f = await 起组织();
    try {
      const 答 = await f.registry.canTouch({ id: '插件工程' });
      assert.equal(答.预览, true, '预览必须与实例诊断分清');
      assert.equal('就绪' in 答, false, '预览不是任何实例的就绪读数');
      assert.equal(答.在岗, false, '没有实例记录');
      assert.ok(答.能力.includes('policy-decision'), '预览读的是现行卡');
      assert.match(String(答.说明), /按岗位预览现行卡/);
    } finally { await f.cleanup(); }
  });

  it('现行卡解析坏但钉住卡合法 ⇒ 实例读面不崩、仍按钉住版就绪（诊断读不抛）', async () => {
    const f = await 起组织();
    try {
      await writeUnder(f.privateRoot, '集体L3-成员角色卡/插件工程.md', 岗位卡('插件工程', { 版本: 1, 规则: '1. 先搜后写。' }));
      await 登记成员(f, 'm-live-bad', '插件工程');
      // 现行卡改成 front matter 未闭合（get 会响亮抛）——钉住快照仍是合法的那一版。
      await writeUnder(f.privateRoot, '集体L3-成员角色卡/插件工程.md', '---\nid: 插件工程\n没有闭合的 front matter');
      const 卡 = await f.registry.cardOf('m-live-bad');
      assert.equal(卡?.就绪, true, '钉住快照才是权威面：现行卡坏不拖垮实例读面');
      assert.match(String(卡?.现行摘要原因), /现行卡读不到/);
      const 答 = await f.registry.canTouch({ id: 'm-live-bad' });
      assert.equal(答.就绪, true);
      assert.deepEqual(答.能力, ['policy-decision']);
    } finally { await f.cleanup(); }
  });
});

describe('⑫ 引用解析单源：capability.parseRefs 导出复用（不另立实现/包装）', () => {
  it('分隔符、项目符号、反引号与注释过滤口径（与卡读取同一份）', () => {
    assert.deepEqual(parseRefs('- `a`\n- b，c、d；e;f'), ['a', 'b', 'c', 'd', 'e', 'f']);
    assert.deepEqual(parseRefs('# 注释行\n\n   \n`g`'), ['g'], '空行丢弃、# 注释行过滤');
    assert.deepEqual(parseRefs('- `z`\n- a\n- `z`'), ['z', 'a', 'z'], '不去重、不改序（顺序就是卡上原文顺序）');
    assert.deepEqual(parseRefs(''), []);
  });

  it('deriveCardFaces 的能力/经验引用与 parseRefs(section(...)) 逐项一致（同一实现）', () => {
    const 正文 = '## 个体L2 · 能力引用\n\n- `policy-decision`\n- task-node\n\n## 个体L3 · 经验引用\n\n- 经验一\n';
    const 面 = deriveCardFaces(正文);
    assert.deepEqual(面.能力引用, parseRefs(section(正文, '个体L2')));
    assert.deepEqual(面.经验引用, parseRefs(section(正文, '个体L3')));
  });
});
