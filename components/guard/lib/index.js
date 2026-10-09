/**
 * 组件 · 安全类。
 *
 * 它为什么能独立成一个组件：设计把安全类定成**封闭清单 + 五道配套**，
 * 而它只在「机制疑似出问题」或「出厂件更新」时才被用到，日常执行根本不需要。
 *
 * 它不自己装配组织：走**共享运行时**取内核正在用的那一份。
 * 自己再装配一份的话，探针看到的策略引擎状态可能不是内核正在用的那一个（那等于白测）。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { shareOrg } from '../../../src/runtime.js';
import { kernelFactoryRoot } from '../../../src/paths.js';
import { subjectFor, DEFAULT_PROJECT } from '../../../src/org.js';
import { InvalidBody, describeFailure } from '../../../src/kernel/errors.js';

export const name = 'dsh-mind-guard';
export const inject = ['tools'];

/** 本组件独有的动作面。内核的 `mind` 工具不认识它们，工具清单里也不会出现。 */
export const ACTIONS = ['probe_run', 'probe_health', 'probe_rollback', 'upgrade_compare', 'upgrade_resolve', 'upgrade_withdraw'];

/**
 * @param {any} ctx cordis 上下文
 * @param {{ project?: string, home?: string, factoryRoot?: string, privateRoot?: string, 开机自检?: boolean }} [config]
 */
export async function apply(ctx, config = {}) {
  const logger = ctx?.logger ?? console;
  let org = null;
  try {
    org = await shareOrg({
      home: config.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'),
      factoryRoot: config.factoryRoot ?? kernelFactoryRoot(),
      privateRoot: config.privateRoot,
      project: config.project ?? DEFAULT_PROJECT,
      logger,
    });
  } catch (error) {
    logger.warn?.(`[dsh-mind] 安全类组件取不到共享组织，未装载：${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  // 主面（工具）**不吞异常**：注册不上就等于这个组件没生效，
  // 让宿主如实报出装载失败，而不是留下一个「看起来装好了」的假象。
  ctx.tools.register(guardTool({ org }));

  ctx.inject?.(['commands'], (scoped) => {
    try {
      scoped.commands.register(guardCommand({ org }));
    } catch (error) {
      logger.warn?.(`[dsh-mind] 安全类组件：注册 /mind-guard 命令失败（工具面不受影响）：${error instanceof Error ? error.message : String(error)}`);
    }
  });

  if (config.开机自检 !== false) {
    // 开机自检：探针每次启动跑一遍并留快照。
    // 「回滚到全绿的最近一版」需要连续的历史，不跑就没有历史可回。
    void org.probes
      .run({ 机制版本: 'boot' })
      .then((result) => {
        logger.info?.(`[dsh-mind] 开机自检：${result.全绿 ? '四道探针全绿' : `见红 ${result.见红.length} 项（${result.见红.map((r) => r.探针).join('、')}）`}`);
      })
      .catch((error) => logger.warn?.(`[dsh-mind] 开机自检失败：${error instanceof Error ? error.message : String(error)}`));
  }

  logger.info?.('[dsh-mind] 安全类组件就位。');
}

export default { name, inject, apply };

/** `mind_guard` 工具：一个动作参数走完本组件的全部操作。 */
function guardTool({ org }) {
  return {
    name: 'mind_guard',
    description: [
      '数字组织的安全类与升级入口：跑四道封闭探针、看探针健康、定位回滚目标（只定位入账＋告警升级主权者；运行态不自动改文件，装回由主权者经版本管理执行），以及裁决出厂件升级的挂起 diff。',
      '安全类是封闭清单（审计链 / 闸在位 / 出厂件洁净 / 撤回名单一致），没有「等其他类似情况」兜底。',
      `动作清单：${ACTIONS.join(', ')}。`,
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTIONS, description: '要执行的动作' },
        机制版本: { type: 'string', description: 'probe_run 记录用的机制版本标签' },
        对象: { type: 'string', description: 'upgrade_compare 要比对的对象 id' },
        安全类: { type: 'boolean', description: 'upgrade_compare 是否按安全类强制替换' },
        id: { type: 'string', description: '挂起项 id（upgrade_resolve / upgrade_withdraw）' },
        选择: { type: 'string', enum: ['用出厂版', '用我的版'], description: '挂起项的裁决' },
        原因: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    // 探针与比对是只读或幂等的；裁决会改挂起项状态，不与别的调用并发。
    isConcurrencySafe: (args) => ['probe_run', 'probe_health', 'upgrade_compare'].includes(args?.action),
    async execute(args, exec) {
      try {
        return JSON.stringify({ 成功: true, ...(await runGuardAction(org, args, subjectFor({ 根会话: true }))) }, null, 1);
      } catch (error) {
        return JSON.stringify({ 成功: false, ...describeFailure(error) }, null, 1);
      }
    },
  };
}

/** `/mind-guard` 命令：人用，零 token。 */
function guardCommand({ org }) {
  return {
    name: 'mind-guard',
    description: '心智 · 安全类与升级：探针自检 / 健康 / 回滚 / 挂起裁决',
    input: { hint: '[probe|health|rollback|pending|resolve id=… 选择=…]' },
    handler: async ({ rawInput }) => {
      const line = String(rawInput ?? '').trim();
      const 主体 = subjectFor({ 根会话: true });
      try {
        const [head, ...rest] = line.split(/\s+/);
        if (head === '' || head === 'health') {
          return { kind: 'success', text: JSON.stringify({ 成功: true, ...(await runGuardAction(org, { action: 'probe_health' }, 主体)) }, null, 1) };
        }
        if (head === 'probe' || head === 'probes') {
          return { kind: 'success', text: JSON.stringify({ 成功: true, ...(await runGuardAction(org, { action: 'probe_run' }, 主体)) }, null, 1) };
        }
        if (head === 'pending') {
          const 挂起 = (await org.upgrade.pending()).filter((p) => !p.已裁决 && !p.已撤回);
          return { kind: 'success', text: JSON.stringify({ 成功: true, 挂起 }, null, 1) };
        }
        const args = parseArgs(rest.join(' '));
        const action = head === 'rollback' ? 'probe_rollback' : head === 'resolve' ? 'upgrade_resolve' : head === 'compare' ? 'upgrade_compare' : head;
        return { kind: 'success', text: JSON.stringify({ 成功: true, ...(await runGuardAction(org, { action, ...args }, 主体)) }, null, 1) };
      } catch (error) {
        return { kind: 'error', text: JSON.stringify({ 成功: false, ...describeFailure(error) }, null, 1) };
      }
    },
  };
}

/**
 * 本组件的动作实现。动作表独立于内核，于是「装了哪个组件就有什么动作」是字面事实。
 * @param {any} org
 * @param {object} args
 * @param {{ id: string, kind: string }} subject 执行者；裁决类动作要它来判定授权
 */
async function runGuardAction(org, args, subject) {
  switch (args.action) {
    case 'probe_run':
      return { 探针: await org.probes.run({ 机制版本: args.机制版本 }) };
    case 'probe_health':
      return { 健康: await org.probes.evaluateHealth(), 影响面: await org.probes.impactStatement({ 机制版本: 'current' }) };
    case 'probe_rollback':
      return { 回滚: await org.probes.autoRollback() };
    case 'upgrade_compare':
      if (!args.对象) throw new InvalidBody('upgrade_compare 需要 对象');
      return { 比对: await org.upgrade.compare({ 对象: args.对象, 安全类: args.安全类 === true }) };
    case 'upgrade_resolve':
      return { 裁决: await org.upgrade.resolve({ subject, id: args.id, 选择: args.选择, 理由: args.原因 ?? '未说明' }) };
    case 'upgrade_withdraw':
      return { 撤回: await org.upgrade.withdraw({ subject, id: args.id, 理由: args.原因 ?? '未说明' }) };
    default:
      throw new InvalidBody(`未知 action：${String(args.action)}`, { detail: { 可选: ACTIONS } });
  }
}

/** 命令行参数：`id=x 选择=用我的版`；裸词忽略（本组件没有「描述」这类自由字段）。 */
function parseArgs(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return {};
  if (text.startsWith('{')) {
    try {
      return JSON.parse(text);
    } catch {
      // 不是合法 JSON 就继续按键值对解析。
    }
  }
  /** @type {Record<string, any>} */
  const out = {};
  for (const token of text.match(/"[^"]*"|\S+/g) ?? []) {
    const m = /^([^=]+)=(.*)$/.exec(token.replace(/^"|"$/g, ''));
    if (m) out[m[1]] = m[2];
  }
  return out;
}
