/**
 * 测试夹具：在临时目录里造一个最小可用的双区载体。
 *
 * 为什么需要它：策略引擎按设计「加载失败 = fail-closed」，因此任何测试都必须先有
 * 一份完整的规则件；否则测出来的全是「引擎不健康」这一种拒绝，覆盖不到真正的判定分支。
 * 夹具与出厂内容解耦：它只保证结构合规，不复制 `mind/` 里的产品文案。
 */
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Clock } from '../src/kernel/time.js';
import { Layout } from '../src/paths.js';
import { PolicyEngine } from '../src/policy.js';
import { AuditLog } from '../src/audit.js';
import { RoleRegistry } from '../src/registry.js';
import { appendLines, readJsonl } from '../src/kernel/fsx.js';

/**
 * 最小合规岗位卡（真实 Registry 的钉版/能力面都读它；测试要换内容自己覆盖写）。
 * 三张默认卡同源生成：改一处三张一起改，别让夹具里的卡形状各写一份。
 * @param {string} id
 */
function 最小岗位卡(id) {
  return `---
id: ${id}
kind: 身份
authority: 自治
zone: 出厂
domain: 个体
version: 1
---
# ${id}

## 个体L0 · 身份核心

我是 ${id}。

### 身份核心

锁定段。

## 个体L1 · 规则

1. 先定判据再干活。

## 个体L2 · 能力引用

- \`policy-decision\`

## 个体L3 · 经验引用

### 占位
`;
}

const RULES = {
  '集体L0-宪章/宪章.md': `---
id: 宪章
kind: 规则
authority: 宪章
zone: 出厂
domain: 集体
version: 1
---
# 宪章

## 使命与价值观
更好地服务用户。

## 不可违背原则
组织不给自己发合格证。
`,
  '集体L1-法律/协作协议.md': `---
id: 协作协议
kind: 规则
authority: 法律
zone: 出厂
domain: 集体
version: 1
---
# 协作协议

## 作业规程
谁提的 / 凭什么 / 谁复核 / 结果 / 可回滚点。
`,
  '集体L1-法律/权限矩阵.md': `---
id: 权限矩阵
kind: 规则
authority: 法律
zone: 出厂
domain: 集体
version: 1
---
# 权限矩阵

## 三档门槛
你定的 > 组织定的。
`,
  '集体L1-法律/裁决流程.md': `---
id: 裁决流程
kind: 规则
authority: 法律
zone: 出厂
domain: 集体
version: 1
---
# 裁决流程

## 复核三态
过 / 不过 / 未验。
`,
  '集体L1-法律/审计要求.md': `---
id: 审计要求
kind: 规则
authority: 法律
zone: 出厂
domain: 集体
version: 1
---
# 审计要求

## 分级
全记 / 记汇总 / 不逐次记。
`,
  '集体L2-集体结构/编制.md': `---
id: 编制
kind: 规则
authority: 自治
zone: 出厂
domain: 集体
version: 1
---
# 编制

## 岗位
Lead 常驻唯一；成员岗位持久、实例临时。
`,
  // 单源：介入度.json 只放介入度；响应期限的两个键只放 响应期限.json。
  '集体L2-共享基础设施/defaults/介入度.json': JSON.stringify({ 介入度: '放权' }, null, 2),
  '集体L2-共享基础设施/defaults/响应期限.json': JSON.stringify({ 失联限制: true, 响应期限小时: 72 }, null, 2),
  '集体L2-共享基础设施/defaults/工具总范围.json': JSON.stringify({ 允许: [], 拒绝: [] }, null, 2),
  '集体L2-共享基础设施/defaults/安全类探针.json': JSON.stringify({ 探针: ['审计链', '闸在位', '出厂件洁净', '撤回名单一致'] }, null, 2),
  '集体L3-成员角色卡/_模板.md': `---
id: _模板
kind: 身份
authority: 自治
zone: 出厂
domain: 个体
version: 1
---
# 角色卡模板

## 个体L0 · 身份
岗位身份，不随实例变化。

## 个体L1 · 规则
该岗位的行为规则。

## 个体L2 · 能力
引用能力库中的条目 id。

## 个体L3 · 经验
引用经验条目 id。
`,
  // 默认成员的岗位卡：v2 条目10/20 起合法成员要由真实 Registry 从合法 Lead 登记
  // （真卡版本 + 父归属），没有卡就登记不了。测试要换内容自行覆盖写。
  '集体L3-成员角色卡/插件工程.md': 最小岗位卡('插件工程'),
  '集体L3-成员角色卡/复核员.md': 最小岗位卡('复核员'),
};

/**
 * 默认 Lead 岗位卡（v2 条目9/10：Lead 也钉卡版本）。
 *
 * 为什么默认就给：Lead 的自治写现在要过「在册在岗 + 钉版摘要 + 快照可读」写前闸，
 * 夹具若不给一张真实可钉的卡，几乎所有以 Lead 为主体的测试都会撞在闸上——
 * 那不是被测行为坏了，是初态没建好。特测「无卡 / 未钉 / 封存」用 `lead` 选项显式关掉
 * 默认 setup，再由测试自己造反例（不许用「测试环境就跳闸」的旁路）。
 */
const LEAD_CARD = 最小岗位卡('Lead');

/**
 * 造一个临时双区。
 *
 * @param {{ rules?: Record<string, string>, defaults?: Record<string, any>, presence?: Record<string, any>|string, privateFiles?: Record<string, string>, offline?: boolean, members?: Record<string, object>, denylist?: object[], lead?: 'pinned'|'unpinned'|'absent' }} [options]
 *   `lead`（默认 `'pinned'`）：默认给夹具建一个合法 Lead 初态——最小 Lead 卡 + 身份档案在岗
 *   + 钉版（走真实 RoleRegistry，由**主权者**做测试准备，不经过被测自治通道，也不改介入度/
 *   失联开关）。反例必须显式关：`'unpinned'`（在岗但未钉）、`'absent'`（无卡无记录）。
 *   封存类反例：先默认钉版，再由测试自己 `registry.seal`（或传 members 里已封存的 lead）。
 * @returns {Promise<{ home: string, factoryRoot: string, privateRoot: string, layout: Layout, clock: Clock, audit: AuditLog, policy: PolicyEngine, registry: RoleRegistry, write(rel: string, text: string): Promise<void>, writePrivate(rel: string, text: string): Promise<void>, cleanup(): Promise<void> }>}
 */
export async function makeFixture(options = {}) {
  // `defaults` 只写 介入度.json（那一个键的唯一出厂源）；响应期限的两个键住在 响应期限.json ⇒ 走 `presence`。
  // 以前这里对这两个键**静默无效**（写进了 介入度.json，而生效的是 响应期限.json）——
  // 下一个写测试的人会踩「夹具设了没用，还查不出为什么」。所以直接响亮拒绝并指路。
  for (const 键 of ['响应期限小时', '失联限制']) {
    if (options.defaults && 键 in options.defaults) {
      throw new Error(
        `夹具的 defaults 选项不承载 ${键}：它写的是 介入度.json，而 ${键} 的唯一出厂源是 响应期限.json。` +
          `请改用 presence 选项，例如 makeFixture({ presence: { ${键}: … } })；` +
          `两个键都要写就 makeFixture({ presence: { 失联限制: true, 响应期限小时: 72 } })。`,
      );
    }
  }
  // Windows runner TEMP may use an 8.3 spelling; ordinary fixtures need the actual root.
  const home = await realpath(await mkdtemp(join(tmpdir(), 'mind-fix-')));
  const factoryRoot = join(home, 'mind');
  const privateRoot = join(home, 'mind-private');
  const leadMode = options.lead ?? 'pinned';

  for (const [rel, text] of Object.entries({
    ...RULES,
    // 默认给一张真实最小 Lead 卡（钉版需要有货可钉）；`lead:'absent'` 显式留空。
    ...(leadMode === 'absent' ? {} : { '集体L3-成员角色卡/Lead.md': LEAD_CARD }),
    ...(options.rules ?? {}),
  })) {
    await writeUnder(factoryRoot, rel, text);
  }
  for (const [rel, text] of Object.entries(options.privateFiles ?? {})) {
    await writeUnder(privateRoot, rel, text);
  }
  // `defaults`（介入度）**延后到 setup 之后**再写：合法初态（Lead/成员钉版）必须先在
  // 放权档建立，否则审批档会把夹具准备一起拦成 NeedsApproval。响应期限不是自治写，照旧先行。
  if (options.presence) {
    await writeUnder(
      factoryRoot,
      '集体L2-共享基础设施/defaults/响应期限.json',
      typeof options.presence === 'string' ? options.presence : JSON.stringify(options.presence, null, 2),
    );
  }

  const layout = new Layout({ factoryRoot, privateRoot });
  const clock = new Clock();
  const audit = new AuditLog({ layout, clock });
  // 默认按「主权者刚启动过」造身份档案。**失联初态不在这里落**：钉版是测试准备，
  // 必须在建立合法初态（Lead 在岗 + 钉版）之后，再把 lastInteraction 推到过去并重载——
  // 否则「失联冻结一切自治写」会连夹具 setup 一起冻掉（4 个测试曾根本没进入被测体）。
  // `lead:'unpinned'` 才把「在岗但未钉」的 lead 直接种进去（反例专用）。
  const 默认成员 = {
    'member-a': { id: 'member-a', 岗位: '插件工程', 代: 1, status: '在岗' },
    // member-b：测试里第二个成员实例（会审/任务流用）；B1 起 成员身份必须登记才过闸。
    'member-b': { id: 'member-b', 岗位: '插件工程', 代: 1, status: '在岗' },
    reviewer: { id: 'reviewer', 岗位: '复核员', 代: 1, status: '在岗' },
    ...(leadMode === 'unpinned' ? { lead: { id: 'lead', 岗位: 'Lead', 代: 1, status: '在岗' } } : {}),
  };
  await seedIdentity(privateRoot, {
    lastInteraction: undefined,
    members: options.members ?? 默认成员,
    // 撤回名单同样延后到 setup 之后落：否则「登记一个随后被撤回的成员」会在夹具准备阶段
    // 就被拒绝名单拦住（测到的是 setup 失败，不是被测的撤回行为）。
    denylist: [],
  });
  const policy = new PolicyEngine({ layout, clock, audit });
  await policy.reload();
  const registry = new RoleRegistry({ layout, policy, audit, clock });
  // 引擎坏（规则件/部署件故意写坏）时不做钉版准备：那不是「未钉 Lead」反例，
  // 而是被测对象不健康——此时任何写都已被引擎 fail-closed，夹具不该先炸在 setup 上。
  if (leadMode === 'pinned' && policy.healthy !== false) {
    // 测试准备，不是被测自治通道：由**主权者**做一次正规登记（assign），钉版=真实摘要，
    // 不临时关介入度 / 不临时解冻。已有记录（含测试自己种的「封存」反例）不复活、不改写。
    const 已有 = (await registry.identity()).members.lead;
    if (!已有 || (已有.status === '在岗' && !已有.卡版本?.摘要)) {
      await registry.assign({ subject: { id: 'sovereign', kind: '主权者' }, 岗位: 'Lead', 实例: 'lead' });
    }
    const 成员 = (await registry.identity()).members.lead;
    if (成员?.status === '在岗') {
      const 读 = await registry.cardOf('lead');
      if (读?.就绪 !== true) {
        throw new Error(`夹具初态失败：Lead 钉版不可读（${读?.原因 ?? 'registry 没给就绪读数'}）——反例会变成假红，先修夹具。`);
      }
    }
    // v2 条目10/20：默认合法成员也要经真实 Registry 由**合法 Lead** 登记（真卡版本 + 父归属），
    // 否则「旧无版本/无委派父还照写」会变成夹具制造的假绿。没卡的岗位保持原样（测缺卡反例）；
    // 特测 legacy 缺证用 `legacyMembers: true` 显式关掉这段准备。
    if (options.legacyMembers !== true && 成员?.status === '在岗') {
      const 委派 = { id: 'lead', kind: 'Lead', roleId: 'Lead' };
      const 天然凭证 = new Set(['Lead', '主权者', '出厂作者']);
      for (const [实例, row] of Object.entries((await registry.identity()).members ?? {})) {
        if (实例 === 'lead' || row?.status !== '在岗' || row?.卡版本?.摘要) continue;
        // Lead/主权者/出厂作者是结构性身份（机制出生），不由 Lead 派活登记；Lead 派 Lead
        // 会撞「不越授」。只迁移**成员岗**的合法凭证。
        if (天然凭证.has(row.岗位)) continue;
        if (!(await registry.get({ id: row.岗位 }))) continue;
        await registry.assign({ subject: 委派, 岗位: row.岗位, 实例, 代: row.代 ?? 1 });
      }
    }
  }
  // ── 合法初态建立后，再落「最终设置/撤回答辩/失联时钟」并重载 ──────────────────
  // 顺序有意：审批档 / 失联 / 撤回名单都是被测边界，夹具准备必须先于它们完成；
  // 否则测到的是 setup 被闸拦，而不是被测行为（4 个测试曾根本没进入被测体）。
  const 需身份收尾 = options.offline === true || options.denylist !== undefined;
  if (options.defaults) {
    await writeUnder(factoryRoot, '集体L2-共享基础设施/defaults/介入度.json', JSON.stringify(options.defaults, null, 2));
  }
  if (需身份收尾) {
    // 保留 setup 得到的真实卡版本/委派父，只改 sovereign 时钟与 denylist。
    const identityFile = layout.identityFile();
    const doc = JSON.parse(await readFile(identityFile, 'utf8'));
    if (options.offline === true) {
      doc.sovereign = { ...(doc.sovereign ?? {}), lastInteraction: new Date(Date.now() - 30 * 24 * 3600_000).toISOString() };
    }
    if (options.denylist !== undefined) doc.denylist = options.denylist;
    await writeFile(identityFile, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  }
  if (options.defaults || 需身份收尾) await policy.reload();

  return {
    home,
    factoryRoot,
    privateRoot,
    layout,
    clock,
    audit,
    policy,
    registry,
    write: (rel, text) => writeUnder(factoryRoot, rel, text),
    writePrivate: (rel, text) => writeUnder(privateRoot, rel, text),
    // maxRetries（2026-10-17 测试稳定性批）：Windows 下 rm -r 会撞「目录刚清空但句柄未释」
    // 的瞬态 ENOTEMPTY——设计债批基线跑实测踩中一次（单文件复跑即绿，纯环境噪声）。
    // 仓内先例：host.test.js after 钩子 / delegation.test.js 的 rm 都带同款参数。
    cleanup: async () => {
      // A real kernel guard/result can enqueue asynchronous observation/legacy audit writes.
      // The same audit write locks provide a drain barrier without creating another shared Org.
      // Deliberate corrupt-audit fixtures may fail verification; their business assertions already
      // checked that failure, and cleanup still removes the isolated directory after the lock barrier.
      try { await audit.readVerified(); }
      catch (error) { if (error?.code !== 'INVALID_BODY') throw error; }
      finally { await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }); }
    },
  };
}

/**
 * 造一份「主权者刚启动过」的身份档案。
 *
 * 为什么夹具默认要写它：失联判定以「最后一次交互」为起点，而全新部署里
 * 那一次交互就是启动本身。不写它，所有自治档写入都会被失联冻结拦住，
 * 于是测试测的全是失联分支，覆盖不到真正的判定逻辑。
 *
 * @param {string} privateRoot
 * @param {{ lastInteraction?: string, members?: Record<string, object>, denylist?: object[] }} [options]
 * @returns {Promise<string>} 写入的 identity.json 路径
 */
export async function seedIdentity(privateRoot, options = {}) {
  const doc = {
    // 默认不含 lead：合法 Lead 初态是**真实 RoleRegistry 登记 + 钉版**的结果（见 makeFixture），
    // 直接种一条没有卡版本的 lead 记录会成为「未钉版」反例，不该被当成默认正常态。
    members: options.members ?? {
      'member-a': { id: 'member-a', 岗位: '插件工程', 代: 1, status: '在岗' },
      // member-b：测试里第二个成员实例（会审/任务流用）；B1 起 成员身份必须登记才过闸。
      'member-b': { id: 'member-b', 岗位: '插件工程', 代: 1, status: '在岗' },
      reviewer: { id: 'reviewer', 岗位: '复核员', 代: 1, status: '在岗' },
    },
    sovereign: { lastInteraction: options.lastInteraction ?? new Date().toISOString() },
    denylist: options.denylist ?? [],
  };
  const rel = '身份档案/identity.json';
  await writeUnder(privateRoot, rel, `${JSON.stringify(doc, null, 2)}\n`);
  return join(privateRoot, rel);
}

/**
 * @param {string} root
 * @param {string} rel
 * @param {string} text
 */
export async function writeUnder(root, rel, text) {
  const file = join(root, rel);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text, 'utf8');
}

/** @param {string} kind @param {string} [id] */
export function actor(kind, id) {
  return { id: id ?? `${kind}-1`, kind };
}

/**
 * 播一条**历史任务图独立会审**节点（v2 后不再有写路径，只读面仍需真账本形态）。
 *
 * 为什么直接写事件流：v2 删掉了任务 `模式` 字段与 debate_* 写路径，`tasks.create` 不再接受
 * 「独立会审」。但 bus_read 盲评遮罩 / workbench 会审线程遮罩 / review.openBlind 的旧数据
 * 契约仍在（只读不迁移）——要测它们，只能按真实历史账本的形状播种 `created` 事件。
 *
 * @param {Awaited<ReturnType<typeof makeFixture>>} fixture
 * @param {{ 项目?: string, id?: string, 负责人?: string[], 描述?: string }} [spec]
 * @returns {Promise<string>} 节点 id
 */
export async function seedLegacyIndependentCouncil(fixture, spec = {}) {
  const 项目 = spec.项目 ?? 'default';
  const id = spec.id ?? `task-legacy-${Math.random().toString(36).slice(2, 7)}`;
  const 负责人 = spec.负责人 ?? ['member-a', 'member-b'];
  const at = new Date().toISOString();
  const 既有 = await readJsonl(fixture.layout.taskLog(项目));
  const seq = (既有.at(-1)?.seq ?? 0) + 1;
  await appendLines(fixture.layout.taskLog(项目), [
    {
      seq, at, by: { id: 'lead', kind: 'Lead' }, kind: 'created', id,
      描述: spec.描述 ?? '历史独立会审（只读播种）', 负责人, 判据: ['x'], 依赖: [],
      状态: '待派发', 模式: '独立会审',
    },
    { seq: seq + 1, at: new Date(Date.now() + 1).toISOString(), by: { id: 'lead', kind: 'Lead' }, kind: 'dispatched', id, 状态: '已派发' },
  ]);
  return id;
}

/**
 * 播种一条「复核任务 → 显式复核对象」关联（v2 条目6 的测试夹具）。
 *
 * 为什么直接写事件流：只是给**被测语义**造前置事实（谁能复核谁、复核员读域从哪来），
 * 不应该顺带触发策略判定与审计行——否则测试的事件/审计读数会被夹具污染，
 * 分不清「被测动作写了几条」与「夹具补了几条」。形状与 create/bind/dispatch 一致：
 * created（带 复核对象）→ bound（实例）→ dispatched（冻结快照）。
 *
 * @param {Awaited<ReturnType<typeof makeFixture>>} fixture
 * @param {{ 项目?: string, 目标: string, 复核者?: string, id?: string }} spec
 * @returns {Promise<string>} 复核任务节点 id
 */
export async function seedReviewRelation(fixture, spec = {}) {
  const 项目 = spec.项目 ?? 'default';
  const 目标 = spec.目标;
  if (!目标) throw new Error('seedReviewRelation 需要 目标（被复核节点 id）。');
  const id = spec.id ?? `task-review-${Math.random().toString(36).slice(2, 7)}`;
  const 复核者 = spec.复核者 ?? 'reviewer';
  const 既有 = await readJsonl(fixture.layout.taskLog(项目));
  const seq = (既有.at(-1)?.seq ?? 0) + 1;
  const at = new Date().toISOString();
  await appendLines(fixture.layout.taskLog(项目), [
    { seq, at, by: { id: 'lead', kind: 'Lead' }, kind: 'created', id, 描述: `复核-${目标}`, 负责人: ['复核员'], 判据: ['核对'], 依赖: [], 复核对象: [目标], 状态: '待派发' },
    { seq: seq + 1, at, by: { id: 'lead', kind: 'Lead' }, kind: 'bound', id, 绑定: { 实例: 复核者, 岗位: '复核员', 于: at } },
    { seq: seq + 2, at, by: { id: 'lead', kind: 'Lead' }, kind: 'dispatched', id, 判据冻结: true, 复核对象: [目标] },
  ]);
  return id;
}

/**
 * 给一份**被测试覆盖过**的身份档案重新建立合法 Lead 初态（测试准备，不是被测自治通道）。
 *
 * 场景：测试为了造失联/身份读数直接重写 identity.json（常只写一个裸 `lead` 记录），
 * 把 makeFixture 的钉版覆盖掉了；而 Lead 自治写现在要求「在册 + 在岗 + 钉版摘要可读」。
 * 这里由主权者走一次正规 assign 补钉（真摘要来自真实卡哈希，不手填），随后回读就绪。
 *
 * 特测「未钉 / 封存 / 无记录」的反例**不要调用它**——那才是要测的坏初态。
 *
 * @param {Awaited<ReturnType<typeof makeFixture>>} fixture
 * @param {string} [实例]
 * @returns {Promise<object|null>} registry.cardOf 的就绪读数
 */
export async function 钉Lead(fixture, 实例 = 'lead') {
  const 现存 = (await fixture.registry.identity()).members[实例];
  if (!现存 || 现存.status !== '在岗') {
    // 不存在 / 已封存：不复活。测试若要写，得自己先造合法初态（显式）。
    return null;
  }
  if (!现存.卡版本?.摘要) {
    await fixture.registry.assign({ subject: { id: 'sovereign', kind: '主权者' }, 岗位: 'Lead', 实例 });
  }
  return fixture.registry.cardOf(实例);
}

/** 常用主体。 */
export const SOVEREIGN = { id: 'sovereign', kind: '主权者' };
export const LEAD = { id: 'lead', kind: 'Lead' };
export const MEMBER = { id: 'member-a', kind: '成员', roleId: '插件工程' };
// v2（2026-10-18 复核者降级）：复核员是普通岗位卡——成员 kind + roleId=复核员，
// 只读/禁写边界由策略引擎按 roleId 判，不再有「复核者」主体类。
export const REVIEWER = { id: 'reviewer', kind: '成员', roleId: '复核员' };

/**
 * 把节点推到「已采纳」的**正路**（补修K · 2026-10-18 · 条目4「采纳权在 Lead」）。
 *
 * 复核「过」只出票、不自动采纳；测试要断言已采纳，就必须像真实 Lead 一样显式采纳，
 * 并且引用**真票**（`node.待采纳.票`）——不许夹具自造 accepted 事件、不许放宽成
 * 「状态是已交卷就算过」。缺票直接抛：那说明前置的复核根本没出票，测试该红。
 *
 * @param {object} org Org 实例
 * @param {string|object} 节点 节点 id 或节点投影（调用方刚 review 完的返回值也行）
 * @param {{ 项目: string, subject?: object }} spec 项目必填（每个测试的项目键不同）
 * @returns {Promise<object>} 采纳后的节点投影（含 `采纳`）
 */
export async function 采纳过(org, 节点, spec) {
  const { 项目 } = spec;
  if (!项目) throw new Error('采纳过 需要 项目（测试的项目键）');
  const 目标 = 节点 && typeof 节点 === 'object' ? 节点 : null;
  const id = 目标 ? 目标.id : 节点;
  const 现状 = 目标 ?? (await org.tasks.get(id, { 项目 }));
  const 票 = 现状?.待采纳?.票;
  if (!票) throw new Error(`采纳过：节点 ${id} 没有 待采纳.票（状态=${现状?.状态}）——先 review(过) 出票，不要绕过采纳`);
  return org.tasks.accept(id, { subject: spec.subject ?? LEAD, 项目, 票 });
}
