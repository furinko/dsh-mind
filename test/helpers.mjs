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
  '集体L2-共享基础设施/defaults/介入度.json': JSON.stringify({ 介入度: '零参与', 响应期限小时: 72 }, null, 2),
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
 * @param {{ rules?: Record<string, string>, defaults?: Record<string, any>, privateFiles?: Record<string, string>, offline?: boolean, members?: Record<string, object>, denylist?: object[] }} [options]
 * @returns {Promise<{ home: string, factoryRoot: string, privateRoot: string, layout: Layout, clock: Clock, audit: AuditLog, policy: PolicyEngine, write(rel: string, text: string): Promise<void>, writePrivate(rel: string, text: string): Promise<void>, cleanup(): Promise<void> }>}
 */
export async function makeFixture(options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'mind-fix-'));
  const factoryRoot = join(home, 'mind');
  const privateRoot = join(home, 'mind-private');

  for (const [rel, text] of Object.entries({ ...RULES, ...(options.rules ?? {}) })) {
    await writeUnder(factoryRoot, rel, text);
  }
  for (const [rel, text] of Object.entries(options.privateFiles ?? {})) {
    await writeUnder(privateRoot, rel, text);
  }
  if (options.defaults) {
    await writeUnder(factoryRoot, '集体L2-共享基础设施/defaults/介入度.json', JSON.stringify(options.defaults, null, 2));
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
    cleanup: () => rm(home, { recursive: true, force: true }),
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

/** 常用主体。 */
export const SOVEREIGN = { id: 'sovereign', kind: '主权者' };
export const LEAD = { id: 'lead', kind: 'Lead' };
export const MEMBER = { id: 'member-a', kind: '成员', roleId: '插件工程' };
export const REVIEWER = { id: 'reviewer', kind: '复核者', roleId: '复核员' };
