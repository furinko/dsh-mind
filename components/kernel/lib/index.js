/**
 * 组件 · 内核。
 *
 * 它负责组织对外的两个面——模型侧的 `mind` 工具、人侧的 `/mind` 命令——
 * 再叠三条横切纪律：工具范围闸、审计钩子、系统提示段。
 *
 * 组织本身（八件基础设施）不在这里，它在 bundle 包的 `src/`；本文件只把它接到宿主上。
 * 组织实例取自**共享运行时**：安全类组件与它必须操作同一份（各自装配一份的话，
 * 探针检查的策略引擎可能不是内核正在用的那一个——那等于白测）。
 *
 * 本文件**不 import 任何 `@deepseek-ai/*`**：profile 安装的插件不保证能解析
 * 出厂包，而一个 import 失败会让整棵插件树起不来。所有能力都通过 `ctx` 服务拿。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { shareOrg } from '../../../src/runtime.js';
import { subjectFor, DEFAULT_PROJECT } from '../../../src/org.js';
import { kernelFactoryRoot } from '../../../src/paths.js';
import { agentSubject } from '../../../src/subject.js';
import { describeFailure, InvalidBody } from '../../../src/kernel/errors.js';
import { atomicWrite, stripBom } from '../../../src/kernel/fsx.js';
import { ACTIONS, runAction } from '../../../lib/actions.js';
// 看板尾长单源（设计评审 #17 · 2026-10-15）：装配期喂给看板包的「40」改引常量（值不变）。
import { 看板审计尾条数 } from '../../../src/audit.js';
// 单源（2026-10-11 schema 口径修缮）：类型 参数描述里的消息类型枚举从 bus.js 的
// 唯一清单拼出来——手抄一份必漂（src/bus.js 的 MESSAGE_TYPES 是闸的同一真源）。
import { MESSAGE_TYPES } from '../../../src/bus.js';
import { 挂同源路由, 看板包 } from './routes.js';
// Lead 自主调度（2026-10-15 主权者授权）：提示词、创建闸与成员入口共用同一份授权判据。
import { DelegationPolicy } from '../../../src/delegation-policy.js';

export const name = 'dsh-mind-kernel';
export const inject = ['tools'];

/** 闸的三态。`未配置` 是出厂件缺失时的诚实答案，不是「随便放行」。 */
const ENVELOPE_STATE = { 状态: '未配置', 允许: [], 拒绝: [] };
/**
 * 告警去重键（P2-4 裁决乙·2026-10-13）：fail-open / 故障都**只喊一次**（内容变化才再喊），
 * 不许被 5s 热更定时器刷成日志洪水。放行语义本身不动（主权者没设 = 无限制，机制不替他改），
 * 但「现在等于没设」这件事必须可见一次。
 */
let 上次告警键 = null;

/**
 * @param {any} ctx cordis 上下文
 * @param {{ project?: string, home?: string, factoryRoot?: string, privateRoot?: string, audit工具调用?: boolean }} [config]
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
    // 装配失败必须响亮，但**不许**让宿主起不来：注册一个把原因说清楚的自述工具。
    logger.warn?.(`[dsh-mind] 组织装配失败，已降级为只读自述：${error instanceof Error ? error.message : String(error)}`);
    ctx.tools.register(degradedTool(error));
    return;
  }

  const 项目 = config.project ?? DEFAULT_PROJECT;
  刷新工具总范围(org, logger);
  // 主权者随时可能改工具总范围：定时重读，让改动生效而不必重启。
  ctx.effect?.(() => {
    const timer = setInterval(() => 刷新工具总范围(org, logger), 5000);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  }, 'dsh-mind: 工具总范围热更新');

  // R06（审查 2026-10-16）：安全必需依赖（宿主工具闸）注册失败 ⇒ 拒绝激活——修前仅 warn
  // 后继续：guards=0、mind 工具照常在、探针还绿（审查实证，最需要红灯的时候它绿着）。
  // 两件事：① 注册**回执**写给探针（org.toolGuardReceipts，闸在位探针从此查真实宿主链）；
  // ② 范围闸注册失败 ⇒ 走装配失败同款降级（只读自述 + error 日志），不装「看起来装好了」。
  const 闸回执 = {
    范围闸: { registered: null, error: null },
    调度创建闸: { registered: null, error: null },
  };
  // 回执**落盘**而非内存（R06）：内核与 guard 组件各有自己的 org 装配实例，闸在位探针
  // 要跨实例读到它，只有私有区的文件做得到（guardReceiptFile 与探针状态同目录）。
  // 写失败只 warn：注册本身失败的场景里，降级自述已把原因带到模型面，探针侧看不到
  // 回执会如实标注「不在可观测面」——比让装配崩在半路好。
  try {
    await atomicWrite(org.layout.guardReceiptFile(), `${JSON.stringify(闸回执, null, 2)}\n`);
  } catch (error) {
    logger.warn?.(`[dsh-mind] 工具闸回执落盘失败（探针将看不到真实注册状态）：${错误消息(error)}`);
  }
  try {
    // 单调闸：只读部署偏好，不读路径，不接受任何人的「通融」。
    ctx.tools.guard((exec) => 闸判定(exec, 项目));
    闸回执.范围闸 = { registered: true, error: null };
    await atomicWrite(org.layout.guardReceiptFile(), `${JSON.stringify(闸回执, null, 2)}\n`);
  } catch (error) {
    闸回执.范围闸 = { registered: false, error: 错误消息(error) };
    try {
      await atomicWrite(org.layout.guardReceiptFile(), `${JSON.stringify(闸回执, null, 2)}\n`);
    } catch { /* 已在降级路径：模型面有自述，探针侧看不到回执会如实标注 */ }
    logger.error?.(`[dsh-mind] 工具范围闸注册失败，拒绝激活（§12.1 闸不许 fail-open）：${闸回执.范围闸.error}`);
    ctx.tools.register(degradedTool(new Error(`工具范围闸注册失败：${闸回执.范围闸.error}。安全必需依赖不在位，内核按 fail-closed 拒绝激活（R06）——修好注册环境后重启会话。`)));
    return;
  }

  // Lead 自主调度授权（2026-10-15 主权者指令「由 lead 根据需求判断使用团队或子智能体或都不使用」）：
  // 配置在 profile 层 dsh-mind-kernel.delegation（主权者的机器，不归模型/记忆改）；坏配置按未授权
  // 处理（fail-closed：宁可退回官方默认「用户显式点名」，不静默放权）。
  const delegation = 建调度策略(config.delegation, logger);
  /** R06：安全必需闸注册失败且不可降级运行时置位——装配在注册 mind 工具前据此中止。 */
  let 拒绝激活 = null;
  ctx.effect?.(() => {
    const 撤销器 = [];
    try {
      // 提示词唯一改动点：官方 team:policy 的首段原位换成部署授权，其余协作纪律保持官方原文。
      // prepend=true 让本监听最后落值；官方 complete-prompt preset 会在 waterfall 后强制还原，
      // 那类 preset 不在本授权的兼容范围（delegation_status 读数里如实标注）。
      撤销器.push(ctx.on('system-prompt/assemble', async (assembly, context, next) => {
        const out = await next();
        return delegation.assemble(out, { project: 项目键(context?.agent, 项目), isTeam: 是Team成员(ctx, context?.agent) });
      }, { prepend: true }));
    } catch (error) {
      logger.warn?.(`[dsh-mind] 注册调度提示词监听失败：${错误消息(error)}`);
    }
    try {
      // 创建闸：授权项目内，裸 spawn_teammate/subagent/fork/workflow 一律指回 member_spawn（先判据后创建）。
      // R06：注册失败不再仅 warn——回执记红（闸在位探针见红）；若调度授权在本项目生效，
      // 裸创建闸缺席 = 授权面无闸 ⇒ 拒绝激活（降级只读自述）；未授权项目的创建闸本就
      // 不承重，记红继续（异常本身仍值得看见）。
      撤销器.push(ctx.tools.guard((exec) => delegation.creationGuard(exec, { subject: agentSubject(exec), project: 项目键(exec?.agent, 项目) })));
      闸回执.调度创建闸 = { registered: true, error: null };
      // effect 回调是同步的（宿主的 disposer 契约）：回执落盘即发即忘，写失败不阻断装配。
      atomicWrite(org.layout.guardReceiptFile(), `${JSON.stringify(闸回执, null, 2)}\n`).catch(() => {});
    } catch (error) {
      闸回执.调度创建闸 = { registered: false, error: 错误消息(error) };
      atomicWrite(org.layout.guardReceiptFile(), `${JSON.stringify(闸回执, null, 2)}\n`).catch(() => {});
      logger.error?.(`[dsh-mind] 调度创建闸注册失败（闸在位探针将见红）：${闸回执.调度创建闸.error}`);
      if (delegation.status(项目).authorized) {
        拒绝激活 = `调度创建闸注册失败：${闸回执.调度创建闸.error}。调度授权已生效而创建闸缺席 = 授权面无闸，按 fail-closed 拒绝激活（R06）。`;
      }
    }
    return () => {
      for (const 撤 of 撤销器) {
        try { 撤?.(); } catch { /* 已在卸载路上 */ }
      }
      delegation.close();
    };
  }, 'dsh-mind: Lead 调度授权');
  if (拒绝激活) {
    logger.error?.(`[dsh-mind] 拒绝激活内核：${拒绝激活}`);
    ctx.tools.register(degradedTool(new Error(拒绝激活)));
    return;
  }

  // 宿主服务束：member_* 动作经它调官方运行时。每次调用现取（HMR/晚装载的服务取不到就如实为 null）。
  // signal 必带：Team/子会话服务内部 AbortSignal.any 会校验每一项（漏传 ⇒ "signals[0] is not of
  // type AbortSignal"，本机重启后实测），官方工具链恒传 exec.signal——这里对齐同一契约。
  const 宿主服务 = (exec) => ({
    agent: exec?.agent ?? null,
    signal: exec?.signal ?? null,
    agentTeams: 取服务(ctx, 'agentTeams'),
    subagents: 取服务(ctx, 'subagents'),
    delegation,
  });

  // 主面（工具）**不吞异常**：注册不上就等于这个组件没生效，
  // 让宿主如实报出装载失败，而不是留下一个「看起来装好了」的假象。
  ctx.tools.register(mindTool({ org, 项目, 项目键: (exec) => 项目键(exec?.agent, 项目), 宿主服务 }));

  ctx.inject?.(['commands'], (scoped) => {
    try {
      scoped.commands.register(mindCommand({ org, 项目, 项目键: (agent) => 项目键(agent, 项目), 宿主服务 }));
    } catch (error) {
      logger.warn?.(`[dsh-mind] 注册 /mind 命令失败：${error instanceof Error ? error.message : String(error)}`);
    }
  });

  ctx.inject?.(['systemPrompt'], (scoped) => {
    try {
      scoped.systemPrompt.section({ name: 'mind:organization', order: 60, text: 组织说明(org) });
    } catch (error) {
      logger.warn?.(`[dsh-mind] 注册组织说明段失败：${error instanceof Error ? error.message : String(error)}`);
    }
  });

  // 同源路由：浏览器侧**唯一**的读/写通路（`remote.commands.execute` 那条链在官方客户端
  // 上永不返回 —— 那是「面板空、设置写不进去」的根因）。注册不上路由不许影响装载。
  挂同源路由({
    ctx,
    org,
    项目,
    logger,
    间隔毫秒: config.webServer间隔毫秒,
    次数: config.webServer次数,
  });

  // （范围闸注册已上移至装配早期并带 R06 回执/降级——见上方 闸回执 块，此处不再重复注册。）

  if (config.audit工具调用 !== false) {
    try {
      挂审计(ctx, org, logger);
    } catch (error) {
      logger.warn?.(`[dsh-mind] 注册审计钩子失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    挂主权者交互(ctx, org, logger);
  } catch (error) {
    logger.warn?.(`[dsh-mind] 注册主权者交互钩子失败：${error instanceof Error ? error.message : String(error)}`);
  }

  logger.info?.(`[dsh-mind] 内核组件就位：项目 ${项目}，策略引擎 ${org.policy.healthy ? '在位' : '不在位（fail-closed）'}。`);
}

export default { name, inject, apply };

/**
 * 出问题时的自述工具：宁可让模型看到「组织没起来 + 原因」，
 * 也不能让它以为组织在岗却拿不到答案。
 *
 * 它由组件宿主在**装配失败**时注册，所以住在这里（与 `mind` 工具同一份形状）。
 * @param {unknown} error
 */
export function degradedTool(error) {
  const 原因 = error instanceof Error ? error.message : String(error);
  return {
    name: 'mind',
    description: '数字组织未能装配；本工具只回报原因。',
    parameters: { type: 'object', properties: { action: { type: 'string' } }, required: [], additionalProperties: true },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() {
      return JSON.stringify({ 成功: false, 结果: '组织未装配', 理由: 原因, 怎么改: '检查 $DSH_HOME/mind-data 的读写权限与出厂区 mind/ 的完整性，然后重启会话。' }, null, 1);
    },
  };
}

// ── 模型入口 ──────────────────────────────────────────────────────────────────

/**
 * `mind` 工具：一个动作参数走全部组织操作。
 * 返回 JSON 文本，于是模型与工作台读的是同一份字节。
 * @param {{ org: object, 项目: string, 项目键: (exec: object) => string, 宿主服务?: (exec: object) => object }} spec
 */
function mindTool({ org, 项目, 项目键, 宿主服务 }) {
  return {
    name: 'mind',
    description: [
      '数字组织的唯一入口：查看组织状态、任务图、记忆、能力库、消息总线、审计、探针，并执行组织动作。',
      '所有写动作都过策略引擎；被拒绝时结果里带「哪条规则 + 改它要什么授权」。',
      '读取请用 status / workbench / memory_query / capability_list / audit_tail；写入用 task_* / memory_write / bus_send 等。',
      `动作清单：${ACTIONS.join(', ')}。`,
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTIONS, description: '要执行的动作' },
        project: { type: 'string', description: '项目键；省略则用当前项目' },
        role: { type: 'string', description: '以哪个岗位身份执行（Lead / 复核员 / 成员岗位名）' },
        实例: { type: 'string', description: '岗位实例 id；省略则按岗位推断' },
        id: { type: 'string', description: '对象 id（任务节点 / 记忆条目 / 挂起项 / 能力名——capability_read 按 id 读，不读 名）' },
        // 描述/原因 的分工按动作实际消费面写（设计评审 F2b 普查 · 2026-10-15）：task_pending
        // 的 handler 读的是 原因（服务层 markPending 的 待决原因），不读 描述——修前 描述
        // 的说明写着「task_create / task_pending」两用，照它传参会静默落空。
        描述: { type: 'string', description: '任务的描述（task_create）' },
        负责人: { type: 'string', description: '负责人 id 或多个用逗号分隔（task_create 建 / task_reassign 改派——改派仅 Lead、仅待派发/已派发）' },
        判据: { type: 'string', description: '验收标准；多个用逗号分隔。任务必填，派发后冻结' },
        依赖: { type: 'string' },
        模式: { type: 'string', enum: ['并行分担', '独立会审'], description: '一岗多人必须显式声明' },
        三态: { type: 'string', enum: ['过', '不过', '未验'], description: '复核结论；未验 ≠ 通过且不计打回' },
        分歧清单: { type: 'string' },
        反例面: { type: 'string' },
        结论: { type: 'string', description: '交卷结论（task_submit）；会审按人留，谁交卷记谁那份' },
        结论层: { type: 'string', description: '结论的结构化标签（task_submit，会审时必填）：一句话给结论定性归类，如「方案A」「可修」「不采纳」。§10 零分歧判据比的是它而不是结论全文——措辞漂不了的判据才成立；不写则退化为全文逐字比对（两份独立答案几乎不会逐字同，报警永不触发）' },
        决定: { type: 'string', description: '待决项的裁决内容（task_resolve）' },
        复核者: { type: 'string', description: '复核结论归属的复核者 id（task_review）；省略取主体' },
        候选: { type: 'string', description: '复核者实例 id（review_nominate）。在册在岗 ⇒ 池内派单（不进待决）；池外 ⇒ 新任命提名（挂待决等主权者）；省略 ⇒ 从在册复核员按账上活动轮派。提名≠任命：池外任命仍由主权者经 registry_assign 带授权引用执行' },
        待决类型: { type: 'string', description: '待决类型（task_pending）；省略取「升级差异」' },
        产出物引用: { type: 'string' },
        类: { type: 'string', enum: ['知识', '经历', '偏好', '作答'] },
        对象类: { type: 'string', description: '对象库的种类（store_rollback 用：能力/规则/身份/产物…；与记忆类的「类」不是一个字段）' },
        version: { type: 'number', description: 'store_rollback 的回滚目标版本号（正整数）' },
        内容: { type: 'string', description: '正文内容（bus_send 的消息正文 / memory_write 的条目内容）' },
        来源: { type: 'string', description: '怎么知道的；记忆写入必填（谁记的默认取主体）' },
        来源引用: { type: 'string', description: '证据/来源对象 id，多个用逗号分隔（契约A 血缘）；know-/exp-/pref-/answ- 查账本、task- 查任务图、artifact- 本批不校验，悬空拒写' },
        任务: { type: 'string', description: '任务节点 id（memory_write / memory_lifecycle / capability_publish 的成员调用必填：声明本次写入归属的任务上下文——「任务内全权」靠它判定；策略引擎仍按节点负责人名单比对，传别人的节点照拒）' },
        授权引用: { type: 'string', description: '主权者授权依据 id（audit_correct 必填：决议 / 任务节点 id；registry_assign 目标岗=复核员时必填；member_spawn 岗位=复核员时必填——起执行体前预检并透传给登记闸；review_exempt 必填——豁免复核是主权者决定，空授权默认拒；原样进链接受复核）' },
        岗位: { type: 'string' },
        标签: { type: 'string' },
        文本: { type: 'string', description: '检索查询词' },
        显式: { type: 'boolean', description: '检索时是否显式包含归档作答' },
        含失效: { type: 'boolean', description: '检索时是否包含已失效/被推翻的记忆（默认 false：只召回当前有效视图）' },
        全量: { type: 'boolean', description: 'workbench 是否越过「成员只读自己那片」的切片' },
        op: { type: 'string', enum: ['invalidate', 'demote', 'overturn', 'purge', 'promote'], description: '记忆处置；不许改写只能追加' },
        敏感: { type: 'boolean', description: 'op=purge 时显式声明「这是敏感数据」；声明会进审计，不声明只有主权者能物理删除' },
        披露豁免: { type: 'boolean', description: 'op=promote 时 Lead 显式豁免披露机械检查（仅 Lead 可用）；豁免与命中的敏感模式名会一起进审计' },
        新条目: { type: 'string' },
        原因: { type: 'string', description: '原因/理由（task_pending 待决原因 / registry_seal / registry_revoke / review_nominate 提名理由 / review_exempt 豁免原因）' },
        名: { type: 'string', description: '能力名（capability_resolve 检索 / capability_publish 发布；capability_read 不读名、只读 id）' },
        正文: { type: 'string', description: '能力卡正文（capability_publish）' },
        适用岗位: { type: 'string' },
        依据: { type: 'string' },
        线程: { type: 'string', description: '线程名（bus_send / bus_read）' },
        发件: { type: 'string', description: '已忽略（W2 安全修复）：发件人恒为真实主体 id，自报无效——冒充发件人是伪造轮边界的第一步' },
        收件: { type: 'string', description: '收件人，多个用逗号分隔' },
        类型: { type: 'string', description: `消息类型（bus_send）：${MESSAGE_TYPES.join('/')}——「系统」为机制保留字，仅系统主体可发；debate_say 只认 分歧/表态/答复` },
        暂不投递: { type: 'boolean' },
        延后: { type: 'boolean' },
        引用: { type: 'string' },
        未投递: { type: 'boolean' },
        档位: { type: 'string', enum: ['全记', '记汇总', '不逐次记'] },
        动作: { type: 'string', description: 'policy_check 要判定的动作' },
        target: { type: 'string', description: 'policy_check 的目标 JSON：{"id","kind","authority","zone"}' },
        代: { type: 'number' },
        审计条数: { type: 'number' },
        limit: { type: 'number', description: '返回条数上限（memory_query 的命中 / bus_read / audit_tail）' },
        条数上限: { type: 'number', description: 'memory_query 返回 条目 的回传条数上限（默认 50；超出截断并附 条目截断: true 与总数）' },
        方式: { type: 'string', enum: ['team', 'subagent'], description: 'member_spawn 的执行体：持久团队成员（team）或普通持续子会话（subagent）；直接执行不调该动作' },
        岗位: { type: 'string', description: 'member_spawn 登记的岗位名（须已有岗位卡）' },
        节点: { type: 'string', description: 'member_spawn 绑定的任务节点 id（须待派发且已定判据）' },
        任务书: { type: 'string', description: 'member_spawn 的开工任务书（判据与岗位要点由机制自动附上）' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    // 只有只读动作允许并发：写动作会把「读-改-写」排成一队，避免并发自伤。
    // `probe_health` 曾在这张表里（W3 批3 清掉）：它是**安全类组件**的工具名，
    // 不属于本工具的动作面（`ACTIONS` 里没有它）——留在这里是一条永远匹配不上的死条目，
    // 读的人会以为「探针巡检在这个工具上是并发安全的」。
    isConcurrencySafe: (args) => ['status', 'workbench', 'memory_query', 'memory_lineage', 'capability_list', 'capability_resolve', 'capability_read', 'bus_read', 'audit_tail', 'audit_verify', 'registry_list', 'registry_can', 'upgrade_pending', 'policy_check', 'delegation_status', 'member_list', 'task_criteria'].includes(args?.action),
    async execute(args, exec) {
      const 主体 = agentSubject(exec);
      try {
        // 项目键省略时取**当前工作区目录名**（§14.4-5：目录名即项目键）——
        // 否则面板永远只显示默认项目，而任务建在别的项目里，看起来就是"一块空白"。
        const 本次项目 = args.project ?? 项目键(exec);
        // `主体` 必须显式传下去（W3 批3 的 `spec.主体` 优先那条路）—— 这是门② 的**落地点**：
        // 只改 `agentSubject` 而不把它传进 `runAction`，会话事实判据就是一条**死代码**
        // （`runAction` 会回落到 `subjectFor({根会话: subject?.kind === 'Lead'})`，
        // 而那个回落本身又受「自报的 args.role」影响）。本轮实测过这个半成品形态：
        // 子会话 `agentSubject` 算出成员、`runAction` 收到的却是 Lead（两处读数都在回报里）。
        return JSON.stringify({ 成功: true, ...(await runAction({ org, 项目: 本次项目, subject: 主体, 主体, args: normalizeArgs(args), ...(宿主服务 ? { 宿主: 宿主服务(exec) } : {}) })) }, null, 1);
      } catch (error) {
        return JSON.stringify({ 成功: false, ...describeFailure(error) }, null, 1);
      }
    },
  };
}

// ── 工作台数据入口 ────────────────────────────────────────────────────────────

/**
 * `/mind` 命令：工作台页面与人都用它。
 *
 * 与工具**共用同一张动作表**（`lib/actions.js`），不维护第二份逻辑。
 * @param {{ org: object, 项目: string, 项目键: (agent: object) => string, 名册?: object, 宿主服务?: (agent: object) => object }} spec
 */
function mindCommand(spec) {
  return {
    name: 'mind',
    description: '心智 · 数字组织：查看状态与工作台投影，或执行组织动作',
    input: { hint: '[status|workbench|audit|presence|...] [参数JSON 或 键=值]' },
    handler: async ({ agent, rawInput }) => {
      const line = String(rawInput ?? '').trim();
      const 本次项目 = spec.项目键(agent);
      try {
        if (line === '' || line === 'dashboard' || line === 'workbench') {
          // 看板走的也是「按身份切片」的同一条路：Lead 看全量，成员只读自己那片。
          // 投影本体与同源路由**共用**（`看板包`）：同一份 JSON，客户端只换传输层。
          const 包 = await 看板包({ org: spec.org, 项目: 本次项目, 读者: agentSubject({ agent }), 审计条数: 看板审计尾条数 });
          return { kind: 'success', text: JSON.stringify(包, null, 1) };
        }
        const [head, ...rest] = line.split(/\s+/);
        const action = ALIASES[head] ?? head;
        const args = 解析参数(rest.join(' '));
        const 主体 = agentSubject({ agent });
        // `面: 'command'` 是**人侧**的标记：命令面专属动作（如改设置的 `presence`）
        // 只在这一面可达，`mind` 工具的 enum 里没有它们（模型没有这只手）。
        // `主体` 一起显式传下去：账上要记**敲这条命令的那个人**，不许归并成一个泛化的 lead。
        const result = await runAction({ org: spec.org, 项目: args.project ?? 本次项目, subject: 主体, 主体, args: { ...args, action }, 面: 'command', ...(spec.宿主服务 ? { 宿主: spec.宿主服务(agent) } : {}) });
        return { kind: 'success', text: JSON.stringify({ 成功: true, ...result }, null, 1) };
      } catch (error) {
        return { kind: 'error', text: JSON.stringify({ 成功: false, ...describeFailure(error) }, null, 1) };
      }
    },
  };
}

/** 人习惯敲的短名 → 动作名。只做改名，不加逻辑。 */
const ALIASES = {
  status: 'status',
  dashboard: 'workbench',
  audit: 'audit_tail',
  tasks: 'workbench',
  memory: 'memory_query',
  capability: 'capability_list',
  can: 'registry_can',
};

/**
 * 项目键：**目录名即项目键**（§14.4-5）。
 *
 * 为什么不能固定用 `config.project` 的默认值：§7.5 要求工作台按项目隔离，
 * 而「当前在哪个项目」的真相是**工作区目录**。固定默认值会让面板永远显示 default，
 * 于是你在自己的项目里建了任务，面板却是一片空白——看起来就是「没用」。
 *
 * @param {{ session?: { header?: { cwd?: string } } }} [agent]
 * @param {string} 兜底 取不到工作区时用（来自 config.project）
 * @returns {string}
 */
function 项目键(agent, 兜底) {
  try {
    const cwd = agent?.session?.header?.cwd;
    if (typeof cwd === 'string' && cwd.trim()) {
      const 尾 = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop();
      if (尾) return 尾;
    }
  } catch {
    // 取不到工作区就用兜底：这里不该因为读不到 cwd 而让整个动作失败。
  }
  return 兜底;
}

/**
 * 解析命令行的参数尾巴。
 *
 * 支持三种写法，因为人在命令行里三种都会敲：
 *  - 整体 JSON：`{"描述":"…"}`
 *  - 键值对：`描述=写文档 负责人=member-a,member-b`
 *  - 裸词：`task_create 写文档`（裸词累加成描述，命令行的自然读法）
 *
 * @param {string} raw
 * @returns {object}
 */
function 解析参数(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return {};
  if (text.startsWith('{')) {
    try {
      return normalizeArgs(JSON.parse(text));
    } catch {
      // 不是合法 JSON 就继续按键值对解析：命令行里少一个引号不该变成硬错误。
    }
  }
  /** @type {Record<string, any>} */
  const out = {};
  for (const token of text.match(/"[^"]*"|\S+/g) ?? []) {
    const stripped = token.replace(/^"|"$/g, '');
    const m = /^([^=]+)=(.*)$/.exec(stripped);
    if (m) out[m[1]] = m[2];
    else out.描述 = out.描述 ? `${out.描述} ${stripped}` : stripped;
  }
  return normalizeArgs(out);
}

// ── 闸 ────────────────────────────────────────────────────────────────────────

/**
 * 工具总范围闸（§4：工具总范围 = 主权者）。
 *
 * 为什么用 `tools.guard()` 而不是 `tools/pre-execute`：文档写明 guard 是
 * **单调**的——任何后来的监听者都无法把它的拒绝翻回放行。pre-execute 是可重排的瀑布，
 * 用它做闸就等于 §12.1 说的 fail-open。
 *
 * @param {any} exec
 * @param {string} 项目
 * @returns {string|undefined} 返回字符串即拒绝
 */
function 闸判定(exec, 项目) {
  const 工具 = exec?.name;
  if (!工具) return undefined;
  if (ENVELOPE_STATE.状态 === '未配置') return undefined;
  if (ENVELOPE_STATE.状态 === '故障') {
    return `[dsh-mind] 工具范围闸故障：${ENVELOPE_STATE.错误}。按 fail-closed 拒绝全部工具调用（§12.1 闸不许 fail-open）。修复 mind/集体L2-共享基础设施/defaults/工具总范围.json 后重试。`;
  }
  if (ENVELOPE_STATE.拒绝.includes(工具)) {
    return `[dsh-mind] 工具「${工具}」在工具总范围之外：工具总范围由主权者设定（§4）。要改请让主权者修改 工具总范围.json。`;
  }
  // 自家工具用**精确名单**（2026-10-12 评审 P3）：startsWith('mind') 会把任何
  // 「mind*」开头的第三方工具一起放行进白名单模式——前缀不是身份。
  const 自家工具 = 工具 === 'mind' || 工具 === 'mind_guard';
  if (ENVELOPE_STATE.允许.length > 0 && !ENVELOPE_STATE.允许.includes(工具) && !自家工具) {
    return `[dsh-mind] 工具「${工具}」未被允许：当前工具总范围是白名单模式。要改请让主权者修改 工具总范围.json。`;
  }
  // `mind*` 为什么无条件放行（W3 批3 补的注释，此前只有一行代码、没有理由）：
  // 工具总范围管的是**宿主工具**（read / write / bash / 第三方插件的工具）——
  // 那是主权者对「这台机器上能碰什么」的设定；而 `mind` 是本组织自己的入口
  // （status / workbench / memory_query / 各动作）。白名单一开就把 `mind` 关掉，
  // 等于组织看不见自己的状态、也读不到自己的记忆，而唯一的恢复手段恰恰要经这个工具
  // ⇒ 自我锁死。所以这一格不在主权者的名单管辖内，不是"漏了校验"。
  // 边界如实说：`/mind` 命令面走的是另一条路（`runCommand` → `runAction`），
  // 本来就不经过这道闸；这里的放行只影响模型侧的工具调用。
  void 项目;
  return undefined;
}

/** 读一次工具总范围；读不出来就诚实地标成「未配置」或「故障」。 */
function 刷新工具总范围(org, logger) {
  const candidates = [org.layout.deploymentPrefs(), org.layout.factoryDefault('工具总范围')];
  // 每次刷新先归零：上一份状态不能带进本轮（热更场景下文件可能已被主权者删掉）。
  ENVELOPE_STATE.状态 = '未配置';
  // R01（审查 2026-10-16 · 按配置键继承）：修前对第一个「可解析」的文件整份采信——
  // 缺 允许/拒绝 键的私有部署 JSON（失联设置就写在同一个 私有部署.json 里，presence
  // 一改就造出这种形态）被折成两份空数组并 break ⇒ 出厂层的收紧清单被无关操作冲掉，
  // 白名单变全放行（审查实证：改失联设置前后 write/pwsh 从拒变放）。
  // 修法：键缺席 = 继承下一层，绝不折成空数组；只有【显式写出的数组】才算该层对键的
  // 决定（显式空数组仍是主权者的合法选择——整体放行，与出厂件形态一致）。
  let 允许 = null;
  let 拒绝 = null;
  for (const file of candidates) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    try {
      // BOM 先剥（2026-10-15 事故收口·第二批）：闸层是**独立于策略引擎的读文件路径**——
      // 第一批修了引擎侧（fsx/policy），这里漏修导致重启后闸仍被 BOM 打趴（全工具 fail-closed）。
      // 经 stripBom 单源，与引擎侧同一把尺；真坏的 JSON 仍按「故障」fail-closed。
      const parsed = JSON.parse(stripBom(text));
      if (允许 === null && Array.isArray(parsed.允许)) 允许 = parsed.允许;
      if (拒绝 === null && Array.isArray(parsed.拒绝)) 拒绝 = parsed.拒绝;
      if (允许 !== null && 拒绝 !== null) break; // 两键都有了，不再看下一层
    } catch (error) {
      ENVELOPE_STATE.状态 = '故障';
      ENVELOPE_STATE.错误 = `${file}：${error instanceof Error ? error.message : String(error)}`;
      break;
    }
  }
  if (ENVELOPE_STATE.状态 !== '故障') {
    ENVELOPE_STATE.状态 = (允许 !== null || 拒绝 !== null) ? '已配置' : '未配置';
    ENVELOPE_STATE.允许 = 允许 ?? [];
    ENVELOPE_STATE.拒绝 = 拒绝 ?? [];
  }
  // P2-4 裁决乙：告警按内容去重，一次说清——fail-open 可见但不刷屏，故障同理。
  let 告警键 = null;
  let 告警文 = null;
  if (ENVELOPE_STATE.状态 === '故障') {
    告警键 = `故障|${ENVELOPE_STATE.错误}`;
    告警文 = `[dsh-mind] 工具总范围无法解析，已按 fail-closed 处理：${ENVELOPE_STATE.错误}`;
  } else if (ENVELOPE_STATE.状态 === '未配置'
    || (ENVELOPE_STATE.允许.length === 0 && ENVELOPE_STATE.拒绝.length === 0)) {
    // 「已配置但两清单皆空」与「未配置」效果相同（全部放行）——两键都显式给空数组是
    // 主权者的合法决定（出厂件恰好就是这样），只报「未配置」会漏掉这个真实形态。
    告警键 = '放行全部';
    告警文 = '[dsh-mind] 工具总范围未生效（未配置，或允许/拒绝两清单皆空）：按出厂语义全部宿主工具放行（fail-open）。'
      + '要收紧，请由主权者在 工具总范围.json 写 允许/拒绝 清单（§4：工具总范围 = 主权者）。';
  }
  if (告警文 && 告警键 !== 上次告警键) {
    上次告警键 = 告警键;
    logger.warn?.(告警文);
  }
  if (!告警文) 上次告警键 = null;
}

// ── 审计 ──────────────────────────────────────────────────────────────────────

/** 只读工具不逐次记；写工具的成功按轮汇总，失败全记。 */
const READ_ONLY_TOOLS = new Set(['read', 'glob', 'grep', 'list_agents', 'mind', 'skill', 'load_workspace_dependencies', 'list_subagent_models', 'job_list', 'job_output']);

/**
 * 把工具调用记进审计（§7 分级）。
 *
 * `tools/result` 是**唯一**在成功与失败两条路上都会触发一次的钩子，
 * 所以「失败全记」与「成功按轮汇总」在这里一并实现。
 * @param {any} ctx @param {any} org @param {any} logger
 */
function 挂审计(ctx, org, logger) {
  /** @type {Map<string, {成功: number, 失败: number, 工具: Map<string, number>}>} */
  const 轮 = new Map();

  /**
   * 轮键：**两处取法必须同一份**（W3 批3·2026-10-09）。
   *
   * 此前 `tools/result` 的兜底用的是**单次调用的 id**（形如 `call-xxxx`），而 `turn/end`
   * 用的是「会话 id 取不到就一个固定兜底键」：两边算出不同的键，于是 `tools/result` 存的桶
   * 在 `turn/end` 里**永远找不到、也永远删不掉**——Map 只增不减（长时间运行就是缓慢泄漏），
   * 而且汇总条目永远不会落。
   * 现在只认「会话 id」（单次调用的 id 拿它当轮键本来就错：每次调用会开一个新桶），
   * 取不到就都用 `'unknown-turn'`，两端必然对齐。
   *
   * @param {any} source `tools/result` 的 exec 或 `turn/end` 的 payload
   * @returns {string}
   */
  function 轮键(source) {
    return String(source?.agent?.session?.id ?? source?.session?.id ?? source?.sessionId ?? 'unknown-turn');
  }

  ctx.on('tools/result', (exec, result) => {
    try {
      const 工具 = exec?.name ?? 'unknown';
      const key = 轮键(exec);
      const bucket = 轮.get(key) ?? { 成功: 0, 失败: 0, 工具: new Map() };
      const 失败 = result?.isError === true;
      if (失败) {
        bucket.失败 += 1;
        org.audit
          .append({
            动作: '工具调用失败',
            // 主体取**真实调用者**（W3 批3）：此前恒记 `{id:'lead'}`，任何一次失败看起来
            // 都是 Lead 干的——成员踩的坑被记到 Lead 头上，排障与追责都跟着错。
            主体: agentSubject(exec),
            对象: { id: 工具, kind: '工具' },
            依据: '审计要求：失败全记（失败是最贵的学习信号）',
            结果: '失败',
            轮: key,
            详情: { 原因: result?.error?.message ?? '未提供原因', 码: result?.error?.info ?? null },
          })
          .catch((error) => logger.warn?.(`[dsh-mind] 失败记账写入失败：${error.message}`));
      } else if (!READ_ONLY_TOOLS.has(工具)) {
        bucket.成功 += 1;
        bucket.工具.set(工具, (bucket.工具.get(工具) ?? 0) + 1);
      }
      // 只记有内容的桶（2026-10-14 审查 P2-14）：修前 `轮.set` 无条件执行，只跑只读工具
      // 的会话也会留下零计数桶——turn/end 里「空桶直接 return」又不删它，Map 只增不减。
      // 现在只读结果根本不进 Map，空桶 delete 兜底留在 turn/end（双保险）。
      if (bucket.成功 > 0 || bucket.失败 > 0) 轮.set(key, bucket);
    } catch (error) {
      logger.warn?.(`[dsh-mind] 工具结果记账异常：${error instanceof Error ? error.message : String(error)}`);
    }
  });

  // 轮 = 一次任务实例从派发到交卷的一次执行段；交卷（回合结束）时落一条汇总。
  ctx.on('turn/end', (payload) => {
    try {
      const key = 轮键(payload);
      const bucket = 轮.get(key);
      // 空桶也要删掉（2026-10-14 审查 P2-14 的双保险）：历史版本/异常路径留下的零计数
      // 桶不许在 Map 里永久残留。
      if (!bucket || (bucket.成功 === 0 && bucket.失败 === 0)) {
        轮.delete(key);
        return;
      }
      轮.delete(key);
      org.audit
        .append({
          动作: '工具调用成功',
          // 汇总条目的主体同样取真实会话（此前恒记 Lead：轮汇总与失败记录一样会张冠李戴）。
          主体: agentSubject({ agent: { session: payload?.session ?? (payload?.sessionId ? { id: payload.sessionId } : undefined) } }),
          对象: { id: key, kind: '轮' },
          依据: '轮定义：一次任务实例从派发到交卷的一次执行段；成功的工具调用按轮汇总',
          结果: `成功 ${bucket.成功} / 失败 ${bucket.失败}`,
          轮: key,
          详情: { 成功调用: bucket.成功, 失败调用: bucket.失败, 工具分布: Object.fromEntries(bucket.工具) },
        })
        .catch((error) => logger.warn?.(`[dsh-mind] 轮汇总写入失败：${error.message}`));
    } catch (error) {
      logger.warn?.(`[dsh-mind] 轮汇总异常：${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

/**
 * 主权者交互：自最后一次交互起超过响应期限未响应 ⇒ 系统自动标记失联。
 * 任何一次交互即解除——所以这里只要看到用户消息就落一次时间戳。
 * @param {any} ctx @param {any} org @param {any} logger
 */
function 挂主权者交互(ctx, org, logger) {
  ctx.on('session/event', (session, event) => {
    try {
      const type = event?.type ?? event?.event?.type;
      if (type !== 'user/message') return;
      // 来源必带（设计评审 #7 · 2026-10-15）：markInteraction 的来源白名单闸——「宿主事件」
      // 就是本挂钩（宿主的用户消息），缺席/名单外会被服务层 fail-closed 拒。
      org.registry.markInteraction({ 来源: '宿主事件' }).catch((error) => logger.warn?.(`[dsh-mind] 记录主权者交互失败：${error.message}`));
    } catch {
      // 事件形状变了不该影响会话；失联判定还有 `/mind sovereign_interaction`（命令面专属）兜底。
    }
  });
}

// ── 辅助 ──────────────────────────────────────────────────────────────────────

/**
 * 建调度策略：配置非法时按未授权（explicit-user）降级并响亮告警——授权类配置的坏值
 * 不许静默当成“没配”（那等于放权失败无人知），也不许让整个内核起不来。
 * @param {unknown} config
 * @param {object} logger
 */
function 建调度策略(config, logger) {
  try {
    return new DelegationPolicy(config);
  } catch (error) {
    logger.error?.(`[dsh-mind] delegation 配置非法，已按未授权（explicit-user）处理：${错误消息(error)}`);
    return new DelegationPolicy({});
  }
}

/** 取宿主服务：先 ctx.get 再 ctx 直挂（两种形状都认）；未装载返回 null，不让装载失败。 */
function 取服务(ctx, 名) {
  try {
    const s = typeof ctx?.get === 'function' ? ctx.get(名) : null;
    if (s) return s;
  } catch {
    /* 未装载 */
  }
  try {
    return ctx?.[名] ?? null;
  } catch {
    return null;
  }
}

/** 该 Agent 是否 Team 成员（含 Lead 伪行）：按真实名册判，不猜 id 前缀。 */
function 是Team成员(ctx, agent) {
  const teams = 取服务(ctx, 'agentTeams');
  if (!teams || !agent) return false;
  try {
    return teams.tryMembership(agent) !== undefined;
  } catch {
    return false;
  }
}

/** @param {unknown} error @returns {string} */
function 错误消息(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 组织说明段：随身份带的是**岗位与编制**，不是全量历史。
 * 这是 §9「上下文 = 按需拉，不许全量推」在提示词侧的实现。
 * @param {any} org
 */
function 组织说明(org) {
  return [
    '本会话处于一个数字组织中，你可以用 `mind` 工具与组织交互。',
    // 项目键不点名（设计评审 F2 · 2026-10-15）：修前这里钉 `${org.project}`（装配期项目，
    // 恒 default），而工具面每次调用都按工作区目录重新解析项目键——提示词说一个、
    // 实际操作另一个。静态句子只教解析规则，不替会话猜项目。
    '项目键：省略 project 参数时取会话工作区目录名（§14.4-5 目录名即项目键）。',
    '身份约定：根会话执行者 = Lead（可派活、可建卡、可汇总验收）；复核者只读数、不改、不提案；成员任务内全权、任务外无。',
    '派活流程：接需求→定判据（写不出判据就不开工）→查岗位（有需要即建卡/改卡）→Lead 按需选择直接执行或 member_spawn 委派（方式=team/subagent＋岗位＋节点＋任务书；机制完成待命握手→registry_assign 登记→绑定节点→装载岗位与判据→发开工消息）→复核→采纳/打回→落记忆→结账。',
    '纪律：写操作一律先过策略引擎；被拒绝时结果里会带「哪条规则 + 改它要什么授权」，照着改，不要绕。',
    '按需拉取：需要组织状态时调 `mind` 的 status / workbench；需要知识时调 memory_query；需要技能规程时调 capability_list。不要假设历史会出现在上下文里。',
    '留痕是自治的门槛：无留痕的自治变更 = 无效。',
  ].join('\n');
}

/**
 * 会话事实主体（agentSubject / 会话实例键）已下沉到 `src/subject.js`（2026-10-10 · guard 残留面收口）：
 * `components/guard` 的工具面与命令面也要用**同一份**判据 —— 各抄一份就会漂（P2 的教训）。
 * 本文件顶部 import 它；既有调用点（:224/:262/:268/:458/:487 一带）一字未改。
 */

/** 把工具入参里的逗号串与 JSON 串规整成动作表要的形状。 */

/** 布尔型参数白名单（与上方 schema 的 type:'boolean' 一一对应）。 */
const BOOLEAN_ARGS = new Set(['显式', '含失效', '全量', '敏感', '披露豁免', '暂不投递', '延后', '未投递']);

function normalizeArgs(args) {
  const out = { ...args };
  // 布尔字面量归一（2026-10-12 评审 P3）：命令行/JSON 串里敲的 'true'/'false' 是
  // 字符串——`全量=false` 在 JS 里是 truthy（恒真），反过来按假处理的字段就恒假。
  // 只对**布尔型参数**归一（2026-10-13 审查 P2-9）：修前遍历全部键，把 内容='true' 这类
  // 自由文本静默改型落账（记忆/任务数据损坏）。白名单外的字段原样透传。
  for (const key of BOOLEAN_ARGS) {
    if (out[key] === 'true') out[key] = true;
    else if (out[key] === 'false') out[key] = false;
  }
  for (const key of ['负责人', '判据', '依赖', '分歧清单', '反例面', '产出物引用', '适用岗位', '收件', '标签', '来源引用']) {
    const value = out[key];
    if (typeof value === 'string') {
      if (value.trim().startsWith('[')) {
        try {
          out[key] = JSON.parse(value);
          continue;
        } catch {
          // 不是合法 JSON 就按逗号切，不报错：模型常把数组写成逗号串。
        }
      }
      out[key] = value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    }
  }
  if (typeof out.target === 'string') {
    try {
      out.target = JSON.parse(out.target);
    } catch {
      out.target = { id: out.target, kind: '未知' };
    }
  }
  // 「结论集」已从工具 schema 撤掉（2026-10-14 审查 P3：review_zero 自 2026-10-13 起从任务图
  // 独立答案重算，不收自报）。解析块保留给 /mind 命令路径与直达 execute 的调用：坏串仍响亮拒，
  // 不静默落成空集（trace-floor.test.js 批次4·P2-2 门禁守着这条）。
  if (typeof out.结论集 === 'string') {
    try {
      out.结论集 = JSON.parse(out.结论集);
    } catch {
      // 坏串不许静默落成 []（2026-10-12 评审 P2-2）：零分歧检查读空气 ⇒ 「零分歧」假绿。
      throw new InvalidBody('结论集 不是合法 JSON：解析失败不许静默当空集（空集与坏串是两回事）。', {
        detail: { 期望形状: '[{"成员":"member-a","结论":"...","反例面":["..."]}]' },
      });
    }
  }
  return out;
}
