/**
 * 补修K · 复核给票与 Lead 采纳分离（v2 口述收敛 2026-10-18 条目4/20 的落地回归）。
 *
 * 主权者原意（条目4）：**采纳权在 Lead**；没有「过」不得采纳，「未验」也不得采纳；
 * Lead 可记录不同意，但不得修改复核结论；采纳必须引用复核结论。
 * 修前 `review(过)` 直接写 `状态:已采纳`——复核者一句话替 Lead 完成了采纳，账上却没有
 * 采纳人/所引用票/同任务代（独立审计 A/W5 用真实状态证实的缺口）。
 *
 * 每个正向都配一条**能变红**的反例（写不出反例＝没验过）：
 *  ① 复核只出票：状态不动、有 reviewed 无 accepted、票 = rv-<seq>；回执带真票与下一步。
 *  ② Lead 采纳：accepted 事件 by=真实 Lead、引用真票、带同任务代；节点 采纳 字段可读。
 *  ③ 越权：成员/复核岗不得采纳；错误 kind 一律拒且零写入。
 *  ④ 无依据：无过票 / 未验 / 伪票 / 错任务票 / 票后新交卷 / 票后新产物挂载 / 打回关代 ⇒ 全拒且零副作用。
 *  ⑤ 免审是合法依据：开关开 + 本代豁免 + 已交卷 ⇒ Lead 可采纳（引 ex-N）；开关关 / 未交卷 ⇒ 拒。
 *  ⑥ Lead 可采纳自己执行但被独立复核过的任务（采纳闸不误用「提审分离」挡采纳本人活）。
 *  ⑦ 采纳不改票、不改冻结判据（只增 accepted；reviewed 行字节不变）。
 *  ⑧ 历史：旧账「复核即采纳」保原行；成员复核的需 Lead 显式确认，前向依赖/结账不许误用；
 *     当时 Lead 复核的与已结账的尊重历史；不伪造旧签名；已结账不复活。
 *  ⑨ 并发采纳恰一条成功。
 *  ⑩ 三面入口：ACTIONS 有 task_accept；工作台「待采纳」带真票命令；异议单独可记且不改票。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendLines, readJsonl } from '../src/kernel/fsx.js';
import { makeFixture, writeUnder, LEAD, MEMBER, REVIEWER } from './helpers.mjs';
import { Org } from '../src/org.js';
import { Denied, InvalidBody } from '../src/kernel/errors.js';
import { ACTIONS, runAction } from '../lib/actions.js';
import { projectWorkbench } from '../src/workbench.js';
import { 已被合法采纳 } from '../src/tasks.js';

const P = 'proj-k-adopt';

/** 岗位卡（结构合规的最小卡；能力引用必须是能力库里真实存在的 id）。 */
function 岗位卡(id) {
  return `---
id: ${id}
kind: 身份
authority: 自治
zone: 出厂
domain: 个体
version: 1
---
<!-- authority: 自治 -->
# ${id}

## 个体L0 · 身份核心

我是 ${id}。

### 身份核心

锁定段。

## 个体L1 · 规则

1. 先搜后写。

## 个体L2 · 能力引用

- \`policy-decision\`

## 个体L3 · 经验引用

### 占位
`;
}

async function 起组织(options) {
  const f = await makeFixture(options);
  for (const id of ['插件工程', '复核员', 'Lead']) {
    await writeUnder(f.privateRoot, `集体L3-成员角色卡/${id}.md`, 岗位卡(id));
  }
  const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
  return { f, org };
}

const 跑 = (org, 主体, args) => runAction({ org, 项目: P, subject: 主体, 主体, args });

/** 造一个已交卷的业务节点（负责人=member-a，member-a 执行并交卷）。 */
async function 交卷节点(org, 描述 = '业务节点', 负责人 = ['member-a']) {
  const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述, 负责人, 判据: ['判据一'] });
  await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
  await org.tasks.start(node.id, { subject: MEMBER, 项目: P });
  await org.tasks.submit(node.id, { subject: MEMBER, 项目: P, 结论: '交付完成', 结论层: '可验' });
  return org.tasks.get(node.id, { 项目: P });
}

/** 造一条复核任务并绑定复核实例（显式复核对象），可开工交报告。 */
async function 复核任务(org, 目标id, options = {}) {
  const node = await org.tasks.create({
    subject: LEAD,
    项目: P,
    描述: options.描述 ?? `复核-${目标id}`,
    负责人: ['复核员'],
    判据: ['核对目标'],
    复核对象: [目标id],
  });
  await org.tasks.bind(node.id, { subject: LEAD, 项目: P, 实例: 'reviewer', 岗位: '复核员' });
  await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
  if (options.交报告 !== false) {
    await org.tasks.start(node.id, { subject: REVIEWER, 项目: P });
    await org.tasks.submit(node.id, { subject: REVIEWER, 项目: P, 结论: '已核' });
  }
  return org.tasks.get(node.id, { 项目: P });
}

/** 业务节点交卷 + 复核员出「过」票（票就从真回执拿）。 */
async function 出过票(org, 业务) {
  await 复核任务(org, 业务.id);
  const r = await 跑(org, REVIEWER, { action: 'task_review', id: 业务.id, 三态: '过' });
  assert.equal(r.结论.三态, '过');
  assert.match(String(r.结论.票), /^rv-\d+$/, '复核回执必须带真票');
  return r.结论.票;
}

/** 事件行数（零副作用断言用）。 */
const 行数 = async (org, 项目 = P) => (await org.tasks.events({ 项目 })).length;

describe('① 复核只出票，不代 Lead 采纳', () => {
  it('review(过) 只写 reviewed：状态停在已交卷、票 rv-<seq> 可引用、无 accepted 事件', async () => {
    const { f, org } = await 起组织();
    try {
      const 业务 = await 交卷节点(org, '只出票');
      const 票 = await 出过票(org, 业务);
      const 节点 = await org.tasks.get(业务.id, { 项目: P });
      assert.equal(节点.状态, '已交卷', '补修K：复核「过」不自动采纳（修前直接已采纳）');
      assert.deepEqual(节点.待采纳, { 票, 复核者: 'reviewer', 于: 节点.待采纳.于, 代: 1 }, '当前代有效票可读');
      assert.equal(节点.复核经过.at(-1).票, 票, '复核经过带票');
      const rows = await org.tasks.events({ 项目: P });
      assert.equal(rows.filter((r) => r.id === 业务.id && r.kind === 'reviewed').length, 1);
      assert.equal(rows.filter((r) => r.kind === 'accepted').length, 0, '没有任何自动采纳事件');
      assert.ok(!rows.some((r) => r.id === 业务.id && r.状态 === '已采纳'), '事件行里也没有已采纳');
      assert.equal(已被合法采纳(节点), false, '未采纳 ⇒ 唯一判定为 false');

      // 回执必须给出真票与下一步（指路不能只有内部字段）。
      const r = await 跑(org, REVIEWER, { action: 'task_review', id: 业务.id, 三态: '过' });
      assert.equal(r.结论.票, r.结论.待采纳.票, '再次复核也出真票');
      assert.match(String(r.结论.下一步), new RegExp(`task_accept.*id=${业务.id}.*票=${r.结论.票}`), '回执文字带可执行指路');
    } finally { await f.cleanup(); }
  });

  it('工作台派生「已过待 Lead 采纳」：任务行带真票命令、待你决定给出 task_accept；计数单列待采纳', async () => {
    const { f, org } = await 起组织();
    try {
      const 业务 = await 交卷节点(org, '待采纳投影');
      const 票 = await 出过票(org, 业务);
      const view = projectWorkbench({ 项目: P, 节点: await org.tasks.list({ 项目: P }) });
      const 行 = view.任务.节点.find((n) => n.id === 业务.id);
      assert.deepEqual(行.待采纳?.票, 票, '任务行带真票（不是只有内部字段）');
      assert.match(String(行.采纳命令), new RegExp(`task_accept.*票=${票}`), '任务行给可执行命令');
      const 项 = view.待你决定.find((x) => x.类型 === '待采纳' && x.节点 === 业务.id);
      assert.ok(项, '待你决定里有「待采纳」');
      assert.match(String(项.命令), new RegExp(`/mind task_accept id=${业务.id} 票=${票}`));
      assert.equal(view.任务.计数.待采纳, 1, '计数单列待采纳（不混进已交卷）');
      assert.equal(view.任务.计数.已采纳, 0, '复核过 ≠ 已采纳');
      assert.ok(ACTIONS.includes('task_accept'), '模型面动作表有正式采纳入口');
      assert.ok(ACTIONS.includes('task_disagree'), '异议记录也有动作面入口');
    } finally { await f.cleanup(); }
  });
});

describe('② Lead 正式采纳：引用真票、带同任务代、事件不重签', () => {
  it('task_accept(票) ⇒ accepted 事件 by=Lead + 票 + 代；节点可读采纳字段且已被合法采纳', async () => {
    const { f, org } = await 起组织();
    try {
      const 业务 = await 交卷节点(org, '正式采纳');
      const 票 = await 出过票(org, 业务);
      const r = await 跑(org, LEAD, { action: 'task_accept', id: 业务.id, 票, 依据: '交付可验' });
      assert.equal(r.节点.状态, '已采纳');
      assert.equal(r.采纳.依据, '复核结论');
      assert.equal(r.采纳.票, 票);
      assert.equal(r.采纳.由, 'lead', '采纳人 = 真实执行主体');
      assert.equal(r.采纳.代, 1, '采纳事件记录同任务代');
      const row = (await org.tasks.events({ 项目: P })).find((x) => x.kind === 'accepted');
      assert.equal(row.by.id, 'lead');
      assert.equal(row.票, 票);
      assert.equal(row.代, 1);
      assert.equal(row.采纳说明, '交付可验');
      assert.ok(!Object.hasOwn(row, '三态') && !Object.hasOwn(row, '复核者') && !Object.hasOwn(row, '判据'), '采纳事件不重签、不带判据');
      const 节点 = await org.tasks.get(业务.id, { 项目: P });
      assert.equal(已被合法采纳(节点), true, '唯一判定：合法采纳');
      assert.equal(节点.待采纳, undefined, '采纳后不再有待采纳');
    } finally { await f.cleanup(); }
  });

  it('采纳不动复核票与冻结判据（reviewed 行字节不变、判据不变）', async () => {
    const { f, org } = await 起组织();
    try {
      const 业务 = await 交卷节点(org, '不改票');
      const 票 = await 出过票(org, 业务);
      const 前 = (await org.tasks.events({ 项目: P })).find((x) => x.kind === 'reviewed');
      const 前判据 = JSON.stringify((await org.tasks.get(业务.id, { 项目: P })).判据);
      await 跑(org, LEAD, { action: 'task_accept', id: 业务.id, 票 });
      const 后 = (await org.tasks.events({ 项目: P })).find((x) => x.kind === 'reviewed');
      assert.equal(JSON.stringify(后), JSON.stringify(前), '复核票行一个字节都不许改');
      const 节点 = await org.tasks.get(业务.id, { 项目: P });
      assert.equal(JSON.stringify(节点.判据), 前判据, '冻结判据不被采纳改动');
      assert.equal(节点.判据冻结, true);
    } finally { await f.cleanup(); }
  });
});

describe('③ 越权与无依据一律拒（零副作用）', () => {
  it('成员 / 复核岗采纳 ⇒ 拒（采纳权在 Lead），事件数不变', async () => {
    const { f, org } = await 起组织();
    try {
      const 业务 = await 交卷节点(org, '越权采纳');
      const 票 = await 出过票(org, 业务);
      const 前 = await 行数(org);
      for (const 主体 of [MEMBER, REVIEWER]) {
        await assert.rejects(
          () => 跑(org, 主体, { action: 'task_accept', id: 业务.id, 票 }),
          (e) => e instanceof Denied && /采纳仅 Lead/.test(e.rule),
          `${主体.id} 不得采纳`,
        );
      }
      await assert.rejects(() => org.tasks.accept(业务.id, { subject: { id: 'sovereign', kind: '成员' }, 项目: P, 票 }), (e) => e instanceof Denied);
      assert.equal(await 行数(org), 前, '被拒的采纳零写入');
      assert.equal((await org.tasks.get(业务.id, { 项目: P })).状态, '已交卷');
    } finally { await f.cleanup(); }
  });

  it('无过 / 未验 / 伪票 / 错任务票 / 票后新交卷 / 票后新产物 / 打回关代 ⇒ 全拒且零写入', async () => {
    const { f, org } = await 起组织();
    try {
      // 无过：只是交卷，没有票。
      const 仅交卷 = await 交卷节点(org, '仅交卷');
      await assert.rejects(
        () => org.tasks.accept(仅交卷.id, { subject: LEAD, 项目: P }),
        (e) => e instanceof Denied && /采纳缺合法依据/.test(e.rule),
        '没有「过」不得采纳',
      );
      // 未验：出了未验票，但不是过（用独立节点，别把后续用例的票张冠李戴）。
      const 未验节点 = await 交卷节点(org, '未验');
      await 复核任务(org, 未验节点.id);
      const 未验 = await 跑(org, REVIEWER, { action: 'task_review', id: 未验节点.id, 三态: '未验' });
      assert.equal((await org.tasks.get(未验节点.id, { 项目: P })).状态, '未验');
      await assert.rejects(
        () => org.tasks.accept(未验节点.id, { subject: LEAD, 项目: P, 票: String(未验.结论.票) }),
        (e) => e instanceof Denied,
        '未验不得采纳（连自己的未验票也不行）',
      );
      // 补材料后再核「过」：状态停在未验，但当前代最后结论是过 ⇒ 票可采纳（不留死胡同）。
      const 补核票 = (await org.tasks.review(未验节点.id, { subject: REVIEWER, 项目: P, 三态: '过', 分歧清单: [] })).待采纳?.票;
      assert.match(String(补核票), /^rv-\d+$/, '补核出真票');
      assert.equal((await org.tasks.accept(未验节点.id, { subject: LEAD, 项目: P, 票: 补核票 })).状态, '已采纳');
      // 出一张真票，然后逐条打它的反例面。
      const 业务 = await 交卷节点(org, '有票节点');
      const 票 = await 出过票(org, 业务);
      const 前伪 = await 行数(org);
      await assert.rejects(() => org.tasks.accept(业务.id, { subject: LEAD, 项目: P, 票: 'rv-999999' }), (e) => e instanceof Denied && /有效过票/.test(e.rule), '伪票拒');
      await assert.rejects(() => org.tasks.accept(业务.id, { subject: LEAD, 项目: P, 票: 'not-a-ticket' }), (e) => e instanceof InvalidBody, '票格式不合法 ⇒ 响亮拒');
      assert.equal(await 行数(org), 前伪, '伪票/坏票被拒 ⇒ 零写入');
      const 别的 = await 交卷节点(org, '错任务');
      const 别的票 = await 出过票(org, 别的);
      const 前错 = await 行数(org);
      await assert.rejects(() => org.tasks.accept(别的.id, { subject: LEAD, 项目: P, 票 }), (e) => e instanceof Denied, '错任务票拒（票属于别的节点）');
      assert.equal(await 行数(org), 前错, '错任务票被拒 ⇒ 零写入');
      assert.equal((await org.tasks.accept(别的.id, { subject: LEAD, 项目: P, 票: 别的票 })).状态, '已采纳', '票在它自己的节点上合法（对照臂，证明上面拒的是归属不是票本身）');

      // 票后新交卷 ⇒ 旧票作废（复核过的是旧成果）。
      await org.tasks.submit(业务.id, { subject: MEMBER, 项目: P, 结论: '改了' });
      assert.equal((await org.tasks.get(业务.id, { 项目: P })).待采纳, undefined, '票后新交卷 ⇒ 待采纳消失');
      await assert.rejects(() => org.tasks.accept(业务.id, { subject: LEAD, 项目: P, 票 }), (e) => e instanceof Denied && /有效过票/.test(e.rule), '借旧票采纳新成果 ⇒ 拒');
      // 再出票即可采纳（票跟着成果走）。
      const 新票 = (await org.tasks.review(业务.id, { subject: REVIEWER, 项目: P, 三态: '过', 分歧清单: [] })).待采纳?.票;
      assert.match(String(新票), /^rv-\d+$/);
      assert.equal((await org.tasks.accept(业务.id, { subject: LEAD, 项目: P, 票: 新票 })).状态, '已采纳');

      // 票后新产物挂载（非读根）同样作废。
      const 产物票节点 = await 交卷节点(org, '产物挂载');
      const 产物票 = await 出过票(org, 产物票节点);
      await org.tasks.attach(产物票节点.id, { subject: MEMBER, 项目: P, 产出物: 'artifact-补交' });
      assert.equal((await org.tasks.get(产物票节点.id, { 项目: P })).待采纳, undefined, '非读根产物挂载改变被验成果 ⇒ 票作废');
      await assert.rejects(() => org.tasks.accept(产物票节点.id, { subject: LEAD, 项目: P, 票: 产物票 }), (e) => e instanceof Denied);

      // 打回关代 ⇒ 旧票作废。
      const 代节点 = await 交卷节点(org, '关代');
      const 代票 = await 出过票(org, 代节点);
      await org.tasks.review(代节点.id, { subject: REVIEWER, 项目: P, 三态: '不过', 分歧清单: ['重做'] });
      await assert.rejects(() => org.tasks.accept(代节点.id, { subject: LEAD, 项目: P, 票: 代票 }), (e) => e instanceof Denied, '打回关闭当前代 ⇒ 旧票失效');
    } finally { await f.cleanup(); }
  });

  it('读根授权不算「新交卷」：给复核任务附读根不让它的票作废', async () => {
    const { f, org } = await 起组织();
    try {
      const 业务 = await 交卷节点(org, '读根业务');
      const 复核 = await 复核任务(org, 业务.id);
      const 复核回执 = await 跑(org, LEAD, { action: 'task_review', id: 复核.id, 三态: '过' });
      const 票 = 复核回执?.结论?.票;
      assert.match(String(票), /^rv-\d+$/, '复核任务本身也能出票');
      await org.tasks.attach(复核.id, { subject: LEAD, 项目: P, 产出物: f.privateRoot, 读根: true });
      assert.equal((await org.tasks.get(复核.id, { 项目: P })).待采纳?.票, 票, '读根只是开文件读面，不改成果、不作废票');
      assert.equal((await org.tasks.accept(复核.id, { subject: LEAD, 项目: P, 票 })).状态, '已采纳');
    } finally { await f.cleanup(); }
  });
});

describe('④ 免审是合法依据，但须 Lead 显式采纳', () => {
  it('开关开 + 本代豁免 + 已交卷 ⇒ 可采纳（依据=复核免审、引 ex-N）；未交卷 ⇒ 拒', async () => {
    const { f, org } = await 起组织({ defaults: { 复核免审: true } });
    try {
      const 节点 = await 交卷节点(org, '免审采纳');
      await org.tasks.exemptReview(节点.id, { subject: LEAD, 项目: P, 原因: '演示' });
      const r = await 跑(org, LEAD, { action: 'task_accept', id: 节点.id });
      assert.equal(r.节点.状态, '已采纳');
      assert.equal(r.采纳.依据, '复核免审');
      assert.equal(r.采纳.票, null, '免审不引复核票');
      assert.match(String(r.采纳.豁免), /^ex-\d+$/, '免审引豁免事件（可追）');

      // 未交卷：免审不等于「没交卷就成功」。
      const 执行中 = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '免审未交卷', 负责人: ['member-a'], 判据: ['x'] });
      await org.tasks.dispatch(执行中.id, { subject: LEAD, 项目: P });
      await org.tasks.exemptReview(执行中.id, { subject: LEAD, 项目: P, 原因: '演示' });
      await assert.rejects(() => org.tasks.accept(执行中.id, { subject: LEAD, 项目: P }), (e) => e instanceof Denied, '未交卷不得采纳（免审只免复核）');
    } finally { await f.cleanup(); }
  });

  it('开关关 ⇒ 免审依据不成立、拒；开关开但无豁免记录 ⇒ 拒', async () => {
    const { f, org } = await 起组织(); // 默认 复核免审 = 关
    try {
      const 节点 = await 交卷节点(org, '免审关');
      await assert.rejects(() => org.tasks.exemptReview(节点.id, { subject: LEAD, 项目: P, 原因: 'x' }), (e) => e instanceof Denied && /复核豁免|复核免审/.test(e.rule + e.message));
      await assert.rejects(() => org.tasks.accept(节点.id, { subject: LEAD, 项目: P }), (e) => e instanceof Denied && /采纳缺合法依据/.test(e.rule));
    } finally { await f.cleanup(); }
    const g = await 起组织({ defaults: { 复核免审: true } });
    try {
      const 节点 = await 交卷节点(g.org, '有开关无豁免');
      await assert.rejects(() => g.org.tasks.accept(节点.id, { subject: LEAD, 项目: P }), (e) => e instanceof Denied, '没有豁免记录 ⇒ 免审路径不成立');
    } finally { await g.f.cleanup(); }
  });
});

describe('⑤ Lead 可采纳自己执行、但被别人独立复核过的任务', () => {
  it('负责人=lead、Lead 交卷、复核员独立出过票 ⇒ Lead 采纳成功（不误用提审分离挡采纳）', async () => {
    const { f, org } = await 起组织();
    try {
      const 节点 = await org.tasks.create({ subject: LEAD, 项目: P, 描述: 'Lead 自办', 负责人: ['lead'], 判据: ['x'] });
      await org.tasks.dispatch(节点.id, { subject: LEAD, 项目: P });
      await org.tasks.start(节点.id, { subject: LEAD, 项目: P });
      await org.tasks.submit(节点.id, { subject: LEAD, 项目: P, 结论: 'Lead 交卷' });
      await 复核任务(org, 节点.id);
      const 复核回执 = await 跑(org, REVIEWER, { action: 'task_review', id: 节点.id, 三态: '过' });
      const 票 = 复核回执?.结论?.票;
      const r = await org.tasks.accept(节点.id, { subject: LEAD, 项目: P, 票 });
      assert.equal(r.状态, '已采纳');
      assert.equal(r.采纳.由, 'lead');
    } finally { await f.cleanup(); }
  });
});

describe('⑥ 历史兼容：保原行、需确认、不伪造签名、不复活', () => {
  /** 播种旧账（reviewed 行自带 状态:已采纳 —— 修前「复核即采纳」）。 */
  async function 播种(f, spec) {
    const 既有 = await readJsonl(f.layout.taskLog(P));
    let seq = (既有.at(-1)?.seq ?? 0) + 1;
    const at = new Date().toISOString();
    const rows = [
      { seq: seq++, at, by: { id: 'lead', kind: 'Lead' }, kind: 'created', id: spec.id, 描述: '历史节点', 负责人: ['member-a'], 判据: ['旧判据'], 依赖: [], 状态: '待派发' },
      { seq: seq++, at, by: { id: 'lead', kind: 'Lead' }, kind: 'dispatched', id: spec.id, 判据冻结: true },
      { seq: seq++, at, by: { id: 'lead', kind: 'Lead' }, kind: 'started', id: spec.id, 状态: '执行中' },
      { seq: seq++, at, by: { id: 'member-a', kind: '成员' }, kind: 'submitted', id: spec.id, 状态: '已交卷', 产出物引用: [], 结论: '历史交卷' },
      { seq: seq++, at, by: { id: spec.复核人, kind: spec.复核人类型 }, kind: 'reviewed', id: spec.id, 三态: '过', 状态: '已采纳', 分歧清单: [], 反例面: [], 复核者: spec.复核人, 算通过: true, 计打回: false },
    ];
    if (spec.结账) rows.push({ seq: seq++, at, by: { id: 'lead', kind: 'Lead' }, kind: 'settled', id: spec.id, 状态: '已结账', 归档条数: 0 });
    await appendLines(f.layout.taskLog(P), rows);
    return spec.id;
  }

  it('成员复核即采纳的旧节点：保原行、标需 Lead 确认；依赖/结账不许误用；确认后才放行', async () => {
    const { f, org } = await 起组织();
    try {
      const id = await 播种(f, { id: 'task-历史成员采纳', 复核人: 'reviewer', 复核人类型: '成员' });
      const 节点 = await org.tasks.get(id, { 项目: P });
      assert.equal(节点.状态, '已采纳', '旧状态原样折出（不洗历史）');
      assert.equal(节点.需Lead确认, true, '仅成员复核、无 Lead 承接 ⇒ 待确认');
      assert.equal(节点.采纳.由, 'reviewer', '采纳人 = 当时的真实执行者（不伪造旧签名）');
      assert.equal(已被合法采纳(节点), false, '唯一判定不许只看状态字符串');
      // 前向依赖不许自动使用。
      await assert.rejects(
        () => org.tasks.create({ subject: LEAD, 项目: P, 描述: '依赖旧账', 负责人: ['member-a'], 判据: ['x'], 依赖: [id] }),
        (e) => e instanceof Denied && /历史自动采纳未确认不得作新依赖/.test(e.rule),
      );
      // 结账也不许把它洗成 Lead 收口。
      await assert.rejects(
        () => org.tasks.settle(id, { subject: LEAD, 项目: P, 记忆处置: {} }),
        (e) => e instanceof Denied && /未经 Lead 确认/.test(e.rule),
      );
      // 显式确认：不带票，落 accepted（依据=历史确认、票沿用旧票、by=真实 Lead）。
      const 确认 = await 跑(org, LEAD, { action: 'task_accept', id });
      assert.equal(确认.节点.状态, '已采纳');
      assert.equal(确认.采纳.依据, '历史确认');
      assert.equal(确认.采纳.由, 'lead', '确认人是这次真实执行的 Lead');
      assert.match(String(确认.采纳.票), /^rv-\d+$/, '如实引用旧票，不重签');
      assert.equal((await org.tasks.get(id, { 项目: P })).需Lead确认, undefined, '确认后标记消失');
      // 确认后依赖放行，工作台也不再把它列成待确认。
      const 依赖 = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '依赖旧账2', 负责人: ['member-a'], 判据: ['x'], 依赖: [id] });
      assert.ok(依赖.id);
      const view = projectWorkbench({ 项目: P, 节点: await org.tasks.list({ 项目: P }) });
      assert.ok(!view.待你决定.some((x) => x.类型 === '历史采纳待确认' && x.节点 === id), '确认后不再投待你决定');
    } finally { await f.cleanup(); }
  });

  it('当时 Lead 复核即采纳的旧节点 ⇒ 尊重历史（需确认不出现）；已结账的旧节点不复活', async () => {
    const { f, org } = await 起组织();
    try {
      const id = await 播种(f, { id: 'task-历史Lead采纳', 复核人: 'lead', 复核人类型: 'Lead' });
      const 节点 = await org.tasks.get(id, { 项目: P });
      assert.equal(节点.需Lead确认, undefined, '当时 Lead 的动作算已承接（不制造假待确认）');
      assert.equal(已被合法采纳(节点), true);

      const 结清 = await 播种(f, { id: 'task-历史结账', 复核人: 'reviewer', 复核人类型: '成员', 结账: true });
      const 结账节点 = await org.tasks.get(结清, { 项目: P });
      assert.equal(结账节点.状态, '已结账');
      assert.equal(结账节点.需Lead确认, undefined, '结账本来就是 Lead 的动作 ⇒ 视为已承接');
      assert.equal(已被合法采纳(结账节点), true);
      // 已结账不复活：接受任何采纳修复都不许把它写回去。
      await assert.rejects(() => org.tasks.accept(结清, { subject: LEAD, 项目: P }), (e) => e instanceof Denied && /状态机/.test(e.rule));
      const rows = await org.tasks.events({ 项目: P });
      assert.equal(rows.filter((r) => r.kind === 'accepted').length, 0, '旧账不伪造采纳事件');
    } finally { await f.cleanup(); }
  });
});

describe('⑦ 并发采纳恰一条 & 异议独立可记', () => {
  it('两个 Lead 并发采纳同一张票 ⇒ 成功恰 1、accepted 恰 1 条', async () => {
    const { f, org } = await 起组织();
    try {
      const 业务 = await 交卷节点(org, '并发采纳');
      const 票 = await 出过票(org, 业务);
      const 结果 = await Promise.allSettled([
        org.tasks.accept(业务.id, { subject: LEAD, 项目: P, 票 }),
        org.tasks.accept(业务.id, { subject: LEAD, 项目: P, 票 }),
      ]);
      assert.equal(结果.filter((r) => r.status === 'fulfilled').length, 1, '并发采纳只许一条成功');
      const rows = await org.tasks.events({ 项目: P });
      assert.equal(rows.filter((r) => r.id === 业务.id && r.kind === 'accepted').length, 1, '不重复落 accepted');
    } finally { await f.cleanup(); }
  });

  it('Lead 记录不同意：只追加审计，不改三态/票/判据；成员/复核岗不得记录', async () => {
    const { f, org } = await 起组织();
    try {
      const 业务 = await 交卷节点(org, '异议记录');
      const 票 = await 出过票(org, 业务);
      const 前 = JSON.stringify((await org.tasks.get(业务.id, { 项目: P })).复核经过);
      const r = await 跑(org, LEAD, { action: 'task_disagree', id: 业务.id, 理由: '我不同意这条复核结论' });
      assert.equal(r.已记录, true);
      assert.equal(r.结论未改动, true);
      const 节点 = await org.tasks.get(业务.id, { 项目: P });
      assert.equal(JSON.stringify(节点.复核经过), 前, '异议不触碰复核票');
      assert.equal(节点.状态, '已交卷', '异议不推进状态');
      assert.equal(节点.待采纳?.票, 票, '票仍可用');
      await assert.rejects(() => 跑(org, MEMBER, { action: 'task_disagree', id: 业务.id, 理由: 'x' }), (e) => e instanceof Denied && /记录不同意仅 Lead/.test(e.rule));
      await assert.rejects(() => 跑(org, LEAD, { action: 'task_disagree', id: 业务.id }), (e) => e instanceof InvalidBody);
      // 异议不影响随后采纳。
      assert.equal((await org.tasks.accept(业务.id, { subject: LEAD, 项目: P, 票 })).状态, '已采纳');
    } finally { await f.cleanup(); }
  });
});
