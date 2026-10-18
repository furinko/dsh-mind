/**
 * 测试夹具：在临时目录里造一个最小可用的双区载体。
 *
 * 为什么需要它：策略引擎按设计「加载失败 = fail-closed」，因此任何测试都必须先有
 * 一份完整的规则件；否则测出来的全是「引擎不健康」这一种拒绝，覆盖不到真正的判定分支。
 * 夹具与出厂内容解耦：它只保证结构合规，不复制 `mind/` 里的产品文案。
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Clock } from '../src/kernel/time.js';
import { Layout } from '../src/paths.js';
import { PolicyEngine } from '../src/policy.js';
import { AuditLog } from '../src/audit.js';
import { appendLines, readJsonl } from '../src/kernel/fsx.js';

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
};

/**
 * 造一个临时双区。
 *
 * @param {{ rules?: Record<string, string>, defaults?: Record<string, any>, presence?: Record<string, any>|string, privateFiles?: Record<string, string>, offline?: boolean, members?: Record<string, object>, denylist?: object[] }} [options]
 * @returns {Promise<{ home: string, factoryRoot: string, privateRoot: string, layout: Layout, clock: Clock, audit: AuditLog, policy: PolicyEngine, write(rel: string, text: string): Promise<void>, writePrivate(rel: string, text: string): Promise<void>, cleanup(): Promise<void> }>}
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
  const home = await mkdtemp(join(tmpdir(), 'mind-fix-'));
  const factoryRoot = join(home, 'mind');
  const privateRoot = join(home, 'mind-private');

  for (const [rel, text] of Object.entries({ ...RULES, ...(options.rules ?? {}) })) {
    await writeUnder(factoryRoot, rel, text);
  }
  for (const [rel, text] of Object.entries(options.privateFiles ?? {})) {
    await writeUnder(privateRoot, rel, text);
  }
  // `defaults` 只写介入度（`介入度.json` 的唯一键）；响应期限走 `presence`（`响应期限.json`）。
  if (options.defaults) {
    await writeUnder(factoryRoot, '集体L2-共享基础设施/defaults/介入度.json', JSON.stringify(options.defaults, null, 2));
  }
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
  // 默认按「主权者刚启动过」造身份档案；offline: true 用来专门测失联冻结。
  await seedIdentity(privateRoot, {
    lastInteraction: options.offline ? new Date(Date.now() - 30 * 24 * 3600_000).toISOString() : undefined,
    members: options.members,
    denylist: options.denylist,
  });
  const policy = new PolicyEngine({ layout, clock, audit });
  await policy.reload();

  return {
    home,
    factoryRoot,
    privateRoot,
    layout,
    clock,
    audit,
    policy,
    write: (rel, text) => writeUnder(factoryRoot, rel, text),
    writePrivate: (rel, text) => writeUnder(privateRoot, rel, text),
    // maxRetries（2026-10-17 测试稳定性批）：Windows 下 rm -r 会撞「目录刚清空但句柄未释」
    // 的瞬态 ENOTEMPTY——设计债批基线跑实测踩中一次（单文件复跑即绿，纯环境噪声）。
    // 仓内先例：host.test.js after 钩子 / delegation.test.js 的 rm 都带同款参数。
    cleanup: () => rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }),
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
    members: options.members ?? {
      'member-a': { id: 'member-a', 岗位: '插件工程', 代: 1, status: '在岗' },
      // member-b：测试里第二个成员实例（会审/任务流用）；B1 起 成员身份必须登记才过闸。
      'member-b': { id: 'member-b', 岗位: '插件工程', 代: 1, status: '在岗' },
      lead: { id: 'lead', 岗位: 'Lead', 代: 1, status: '在岗' },
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

/** 常用主体。 */
export const SOVEREIGN = { id: 'sovereign', kind: '主权者' };
export const LEAD = { id: 'lead', kind: 'Lead' };
export const MEMBER = { id: 'member-a', kind: '成员', roleId: '插件工程' };
// v2（2026-10-18 复核者降级）：复核员是普通岗位卡——成员 kind + roleId=复核员，
// 只读/禁写边界由策略引擎按 roleId 判，不再有「复核者」主体类。
export const REVIEWER = { id: 'reviewer', kind: '成员', roleId: '复核员' };
