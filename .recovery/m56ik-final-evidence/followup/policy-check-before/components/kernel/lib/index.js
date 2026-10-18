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
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, basename, join, resolve as resolvePath, sep } from 'node:path';
import { shareOrg } from '../../../src/runtime.js';
import { subjectFor, DEFAULT_PROJECT } from '../../../src/org.js';
import { kernelFactoryRoot } from '../../../src/paths.js';
import { agentSubject } from '../../../src/subject.js';
import { readInstanceSnapshot } from '../../../src/instance-snapshot.js';
import { describeFailure, Denied, InvalidBody } from '../../../src/kernel/errors.js';
import { atomicWrite, stripBom } from '../../../src/kernel/fsx.js';
import { ACTIONS, READ_ONLY_ACTIONS, 是写动作, runAction, 会审参与动作闸 } from '../../../lib/actions.js';
// 复核读域单源（v2 条目6）：guard 是同步的 ⇒ 直接同步读任务账本 + fold，不另造一套范围判据。
import { fold } from '../../../src/tasks.js';
import { 复核读域 } from '../../../src/review-scope.js';
// 看板尾长单源（设计评审 #17 · 2026-10-15）：装配期喂给看板包的「40」改引常量（值不变）。
import { 看板审计尾条数 } from '../../../src/audit.js';
// 单源（2026-10-11 schema 口径修缮）：类型 参数描述里的消息类型枚举从 bus.js 的
// 唯一清单拼出来——手抄一份必漂（src/bus.js 的 MESSAGE_TYPES 是闸的同一真源）。
import { MESSAGE_TYPES } from '../../../src/bus.js';
import { 挂同源路由, 看板包 } from './routes.js';
import { createDelegationSettings } from './delegation-settings.js';
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
  // R04（审查 2026-10-16 · 生效闭环）：同一节拍也刷**策略引擎**——修前只刷工具范围，
  // 规则件/部署介入度改了要等「下一次身份更新顺便重载」（报告实证：改完仍按旧规则判）。
  // 两侧都走「比签名、变了才重载」的轻量路径（refreshIfStale 只做 stat，不重读不解析）。
  ctx.effect?.(() => {
    const timer = setInterval(() => {
      刷新工具总范围(org, logger);
      void org.policy.refreshIfStale().catch(() => { /* 重载失败=引擎不健康，判定面自会 fail-closed */ });
    }, 5000);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  }, 'dsh-mind: 工具总范围与策略引擎热更新');

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
    // v2 条目6/7 补修：同一个 guard 里先判**复核员角色边界**（见 闸判定），不新注册平行 guard。
    ctx.tools.guard((exec) => 闸判定(exec, 项目, { org, ctx }));
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
  const 调度接线回执 = { promptRegistered: false, creationGuardRegistered: false };
  /**
   * R06 回执的 effect 侧落盘（2026-10-17 冷启动验收修复）：首写 + 2 秒后一次幂等确认写。
   * 修前即发即忘且失败静默——冷启动实证回执永停「未尝试」而闸本体行为面在位（假阴性
   * 同样腐蚀探针可信度）。确认写同时治两类丢失：瞬态写失败，与启动期二次激活把先到的
   * true 覆写回 null 的竞态。effect 回调必须同步返回 disposer，不能 await——保持即发
   * 即忘，只是不再吞错、不再只写一次。
   */
  const 落闸回执 = (attempt) => atomicWrite(org.layout.guardReceiptFile(), `${JSON.stringify(闸回执, null, 2)}\n`)
    .catch((error) => logger.error?.(`[dsh-mind] 工具闸回执落盘失败（第${attempt}次，将幂等重写）：${错误消息(error)}`));
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
        const 已接调度 = delegation.assemble(out, { project: 项目键(context?.agent, 项目), isTeam: 是Team成员(ctx, context?.agent) });
        // v2 条目10（W7 实证）：Root 实例在**首个真实组织上下文装配前**出生/钉版，并把
        // 它钉住的那版 Lead 规程注入；子会话/伪 Lead 形状不在此列（agentSubject 判）。
        return 注入Lead已钉规程(已接调度, context?.agent, org, logger);
      }, { prepend: true }));
      调度接线回执.promptRegistered = true;
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
      调度接线回执.creationGuardRegistered = true;
      // effect 回调是同步的（宿主的 disposer 契约）：首写即发即忘，确认写兜覆写竞态与瞬态失败。
      落闸回执(1);
      const 确认写 = setTimeout(() => { if (!delegation.closed) 落闸回执(2); }, 2_000);
      if (typeof 确认写.unref === 'function') 确认写.unref();
    } catch (error) {
      闸回执.调度创建闸 = { registered: false, error: 错误消息(error) };
      落闸回执(1);
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
  ctx.tools.register(mindTool({ org, 项目, 项目键: (exec) => 项目键(exec?.agent, 项目), 宿主服务, logger }));

  ctx.inject?.(['commands'], (scoped) => {
    try {
      scoped.commands.register(mindCommand({ org, 项目, 项目键: (agent) => 项目键(agent, 项目), 宿主服务, logger }));
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
    调度设置: createDelegationSettings({ ctx, org, delegation, project: 项目, readiness: 调度接线回执 }),
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
function mindTool({ org, 项目, 项目键, 宿主服务, logger }) {
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
        实例: { type: 'string', description: 'registry_assign / task_bind 的实例 id（必填；省略会被拒，不再按岗位推断）' },
        id: { type: 'string', description: '对象 id（任务节点 / 记忆条目 / 挂起项 / 能力名——capability_read 按 id 读，不读 名）' },
        // 描述/原因 的分工按动作实际消费面写（设计评审 F2b 普查 · 2026-10-15）：task_pending
        // 的 handler 读的是 原因（服务层 markPending 的 待决原因），不读 描述——修前 描述
        // 的说明写着「task_create / task_pending」两用，照它传参会静默落空。
        描述: { type: 'string', description: '任务的描述（task_create）' },
        负责人: { type: 'string', description: '负责人 id 或多个用逗号分隔（task_create 建 / task_reassign 改派——改派仅 Lead、仅待派发/已派发）' },
        判据: { type: 'string', description: '验收标准；多个用逗号分隔。任务必填，派发后冻结' },
        依赖: { type: 'string' },
        复核对象: { type: 'string', description: '复核任务的显式被验目标（节点 id 列表，task_create / task_bind，多个用逗号分隔或 JSON 数组）。它不是依赖：依赖是「先做谁」，复核对象是「验哪一单」——绝不借用 依赖 表达复核对象（依赖须前置已采纳，会让复核闭环死锁）' },
        问题: { type: 'string', description: '会审要收敛的问题（debate_open，v2 条目18）；参与者用「参与者」或「参与岗位」参数点名' },
        参与者: { type: 'string', description: '会审参与者 id，多个用逗号分隔（debate_open）：被点名的在册在岗实例独立作答；预给实例不改原任务权' },
        参与岗位: { type: 'string', description: '会审受管参与实例的岗位名，多个用逗号分隔（debate_open）：每个元素创建一个真实受管咨询实例（可重复同一岗位 = N 个实例）' },
        资料: { type: 'string', description: '会审参与实例的唯一只读文件根：发起者给的绝对路径（文件/目录），多个用逗号分隔（debate_open）；不提供则参与实例不能读文件' },
        三态: { type: 'string', enum: ['过', '不过', '未验'], description: '复核结论；未验 ≠ 通过且不计打回。「过」只出可引用票、不自动采纳（补修K）：采纳另走 task_accept' },
        票: { type: 'string', description: '复核票 id（task_accept 引用）：task_review 回执与工作台「待采纳」给出的 rv-N（reviewed 事件 seq）。免审采纳与历史确认不带票；票后若有新交卷/新产出物挂载则作废' },
        理由: { type: 'string', description: '理由（task_disagree：Lead 的不同意意见；只进审计，不改复核三态/冻结判据）' },
        分歧清单: { type: 'string' },
        反例面: { type: 'string' },
        知识候选: { type: 'string', description: '交卷附的知识候选（task_submit，v2 条目15）：值得蒸馏成知识的点，多个用逗号分隔或 JSON 数组。成员不得直接写知识——候选随卷入账，结账时 Lead 逐条判' },
        记忆处置: { type: 'string', description: 'task_settle 必填（v2 条目16）：{候选键:"晋升"|"留账本"|"丢弃"} 的 JSON 对象；「晋升」也可写成 {处置:"晋升",岗位?,标题?,内容?}（可选蒸馏覆盖，缺省按来源绑定岗位/现有正文推导）。无候选传 {} 明示。晋升会真实产出知识条目（id 见节点.记忆晋升），任一条失败则不结账（不留假结账）' },
        命名空间: { type: 'string', enum: ['通用'], description: 'memory_write 的存储命名空间：「通用」= 项目无关知识的公共命名空间，不是另一个项目（执行项目仍是当前会话项目，成员跨项目闸不变）。目前只收「知识」；Lead 写入须带依据，披露检查照跑' },
        结论: { type: 'string', description: '交卷结论（task_submit）；会审按人留，谁交卷记谁那份' },
        结论层: { type: 'string', description: '结论的结构化标签（task_submit，会审时必填）：一句话给结论定性归类，如「方案A」「可修」「不采纳」。§10 零分歧判据比的是它而不是结论全文——措辞漂不了的判据才成立；不写则退化为全文逐字比对（两份独立答案几乎不会逐字同，报警永不触发）' },
        决定: { type: 'string', description: '待决项的裁决内容（task_resolve）' },
        复核者: { type: 'string', description: '复核结论归属的复核者 id（task_review）；省略取主体' },
        待决类型: { type: 'string', description: '待决类型（task_pending）；省略取「升级差异」' },
        产出物引用: { type: 'string' },
        类: { type: 'string', enum: ['知识', '经历', '偏好', '作答'] },
        对象类: { type: 'string', description: '对象库的种类（store_rollback 用：能力/规则/身份/产物…；与记忆类的「类」不是一个字段）' },
        version: { type: 'number', description: 'store_rollback 的回滚目标版本号（正整数）' },
        内容: { type: 'string', description: '正文内容（bus_send 的消息正文 / memory_write 的条目内容）' },
        来源: { type: 'string', description: '怎么知道的；记忆写入必填（谁记的默认取主体）' },
        来源引用: { type: 'string', description: '证据/来源对象 id，多个用逗号分隔（契约A 血缘）；know-/exp-/pref-/answ- 查账本、task- 查任务图、artifact- 本批不校验，悬空拒写。记忆整理岗写知识（受限晋升）必须恰好带 1 个 task-* 且该任务已被合法采纳（同项目）' },
        任务: { type: 'string', description: '任务节点 id（memory_write / memory_lifecycle / capability_publish 的成员调用必填：声明本次写入归属的任务上下文——「任务内全权」靠它判定；策略引擎仍按节点负责人名单比对，传别人的节点照拒）。记忆整理岗写知识时= 绑着你的执行中任务' },
        授权引用: { type: 'string', description: '主权者授权依据 id（audit_correct 必填：决议 / 任务节点 id；原样进链接受复核。v2 起复核员任命/复核豁免不再用授权引用——复核员是普通岗位卡，豁免走部署设置「复核免审」开关）' },
        岗位: { type: 'string', description: '岗位名（registry_assign / memory_* / capability_* / member_spawn）；记忆写入时 = 知识双标签的岗位标签（受限晋升必填：这条知识对哪个岗位可召回，不是整理它的人）；member_spawn 时须已有岗位卡' },
        标签: { type: 'string' },
        文本: { type: 'string', description: '检索查询词' },
        显式: { type: 'boolean', description: '检索时是否显式包含归档作答' },
        含失效: { type: 'boolean', description: '检索时是否包含已失效/被推翻的记忆（默认 false：只召回当前有效视图）' },
        全量: { type: 'boolean', description: 'workbench 是否越过「成员只读自己那片」的切片' },
        op: { type: 'string', enum: ['invalidate', 'demote', 'overturn', 'purge', 'promote'], description: '记忆处置；不许改写只能追加' },
        敏感: { type: 'boolean', description: 'op=purge 时显式声明「这是敏感数据」；声明会进审计，不声明只有主权者能物理删除' },
        披露豁免: { type: 'boolean', description: 'op=promote 时 Lead 显式豁免披露机械检查（仅 Lead 可用）；豁免与命中的敏感模式名会一起进审计' },
        新条目: { type: 'string' },
        原因: { type: 'string', description: '原因/理由（task_pending 待决原因 / registry_seal / registry_revoke / review_exempt 豁免原因）' },
        名: { type: 'string', description: '能力名（capability_resolve 检索 / capability_publish 发布；capability_read 不读名、只读 id）' },
        正文: { type: 'string', description: '能力卡正文（capability_publish）' },
        适用岗位: { type: 'string' },
        依据: { type: 'string', description: '依据（task_accept 可选：采纳说明随 accepted 事件入账；采纳资格不靠自报——服务层按票/免审/历史确认判）' },
        // v2 条目14/17（2026-10-18 补修F）：主权者逐请求放行后，原申请者带这个引用重试
        // 原动作——执行的是冻结请求（参数与步骤计划都按原样），不是这次的复述参数。
        审批引用: { type: 'string', description: '介入请求 id（v2 条目14/17）：写动作被介入度挂起后，主权者在设置页「待审批」批准，原申请者带 审批引用=<请求id> 重试原动作。执行的是冻结请求；参数/计划与记录不一致、已执行过、已失效都会拒' },
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
        target: { type: 'string', description: 'policy_check 的目标 JSON：{"id","kind","authority","zone","sandbox":true}；sandbox 仅为隔离实验预检标记，不授予或扩大权限' },
        代: { type: 'number' },
        审计条数: { type: 'number' },
        limit: { type: 'number', description: '返回条数上限（memory_query 的命中 / bus_read / audit_tail）' },
        条数上限: { type: 'number', description: 'memory_query 返回 条目 的回传条数上限（默认 50；超出截断并附 条目截断: true 与总数）' },
        方式: { type: 'string', enum: ['team', 'subagent'], description: 'member_spawn / debate_open 的执行体：持久团队成员（team）或普通持续子会话（subagent）；直接执行不调该动作' },
        节点: { type: 'string', description: 'member_spawn 绑定的任务节点 id（须待派发且已定判据）' },
        任务书: { type: 'string', description: 'member_spawn 的开工任务书（判据与岗位要点由机制自动附上）' },
        模型供应商: { type: 'string', description: 'member_spawn / debate_open 可选模型路由：LLM 供应商 id（须与 模型 成对给出；仅 方式=subagent 支持；缺省继承父路由，与既往行为一致）' },
        模型: { type: 'string', description: 'member_spawn / debate_open 可选模型路由：模型 id（须与 模型供应商 成对；宿主目录是 advisory，不合法路由由宿主在创建时响亮拒，不静默回落）' },
        推理档: { type: 'string', description: 'member_spawn / debate_open 可选：推理档位（随模型路由生效；换了路由不给别人，子会话用所选模型的默认档）' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    // 只有只读动作允许并发：写动作会把「读-改-写」排成一队，避免并发自伤。
    // 读写分类的**单源**在 lib/actions.js 的 READ_ONLY_ACTIONS（Lead 钉版闸共用同一张表），
    // 这里不另抄一份——两处各写一张表，迟早一侧放行一侧拒。
    isConcurrencySafe: (args) => READ_ONLY_ACTIONS.includes(args?.action),
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
        // v2 条目9/10：Lead 实例随主会话出生——**落在这里**（真实 exec 的会话事实），
        // 不在路由面/任意 Lead 形状上自动生造（那是「设置页」这类伪实例的来源）。
        const 登记 = await 钉Lead实例(org, 主体, logger);
        // v2 条目10（W5 审计反例收口）：内核入口不再「warn 后继续」——模型面的 Lead 自治写
        // 必须钉版真就绪；诊断读（status / workbench / audit_tail …）照旧放行并带读数。
        // 分类与 runAction / isConcurrencySafe 共用 READ_ONLY_ACTIONS 这一张表。
        const 本次入参 = normalizeArgs(args);
        if (主体.kind === 'Lead' && 是写动作(本次入参.action) && 登记?.就绪 !== true) {
          throw new Denied(
            'v2 条目10 · Lead 自治写前钉版未就绪（内核入口）',
            `Lead 实例 ${主体.id} 的出生/钉版读数未就绪：${登记?.原因 ?? '内核没拿到就绪读数（unknown ⇒ 按未就绪处理）'}。模型面的自治写不做「先写后补钉」——写动作 fail-closed；status / workbench / audit 等诊断读仍可用。`,
            {
              requireAuthority: '主权者/Lead',
              howToChange: '先由主权者/Lead 修好 Lead 岗位卡与身份档案（在岗 + 钉版快照可读），或重新登记 Lead 实例；诊断用 status / workbench / audit_tail。',
              detail: { 实例: 主体.id, 动作: 本次入参.action, 写动作: true, 就绪读数: 登记 ?? null },
            },
          );
        }
        return JSON.stringify({
          成功: true,
          ...(登记 && 登记.就绪 === false ? { 实例登记: 登记 } : {}),
          ...(await runAction({ org, 项目: 本次项目, subject: 主体, 主体, args: 本次入参, ...(宿主服务 ? { 宿主: 宿主服务(exec) } : {}) })),
        }, null, 1);
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
        // v2 条目9/10：同一条出生路径（命令面也是真实 agent 的会话事实）。
        const 登记 = await 钉Lead实例(spec.org, 主体, spec.logger);
        // `面: 'command'` 是**人侧**的标记：命令面专属动作（如改设置的 `presence`）
        // 只在这一面可达，`mind` 工具的 enum 里没有它们（模型没有这只手）。
        // `主体` 一起显式传下去：账上要记**敲这条命令的那个人**，不许归并成一个泛化的 lead。
        // P1-12（全面审查 2026-10-17）：宿主服务束读 `exec.agent`；命令面手里只有 agent 本身，
        // 修前把 agent 当 exec 传 ⇒ 宿主.agent 恒 null，/mind member_* 全抛 NO_AGENT。
        // 两个面统一成 exec 形状：命令面显式包成 { agent }（无工具调用的 signal）。
        const result = await runAction({ org: spec.org, 项目: args.project ?? 本次项目, subject: 主体, 主体, args: { ...args, action }, 面: 'command', ...(spec.宿主服务 ? { 宿主: spec.宿主服务({ agent }) } : {}) });
        return { kind: 'success', text: JSON.stringify({ 成功: true, ...(登记 && 登记.就绪 === false ? { 实例登记: 登记 } : {}), ...result }, null, 1) };
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
 * **顺序（v2 条目6/7 补修）**：复核员的角色边界**先于**工具总范围求值。修前
 * `ENVELOPE_STATE.状态 === '未配置'` 直接 return，任何没配工具范围的部署里，
 * 复核员就能用普通文件工具直读私有区原始账本——角色闸不许被「范围未配置」旁路。
 *
 * @param {any} exec
 * @param {string} 项目
 * @param {{ org?: object, ctx?: any }} [deps]
 * @returns {string|undefined} 返回字符串即拒绝（**同步**，绝不返回 Promise）
 */
function 闸判定(exec, 项目, deps = {}) {
  const 工具 = exec?.name;
  if (!工具) return undefined;
  // 补修I：会审参与实例的**闭名单**先于复核员/范围闸；有绑定即由它收口（预给参与者无绑定⇒不收紧）。
  const 咨询 = 咨询参与工具闸(exec, 项目, deps);
  if (咨询?.拒 !== undefined) return 咨询.拒;
  const 角色拒 = 咨询?.命中 ? undefined : 复核员工具闸(exec, 项目, deps);
  if (角色拒 !== undefined) return 角色拒;
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

/** 会审实例无任务写域：闭名单只留问答、规范读取、明确资料与派发者报告。 */
const 咨询只读工具 = new Set(['read', 'read_image', 'glob', 'grep', 'skill', 'mind']);

function 咨询参与工具闸(exec, 项目, deps) {
  const 主体 = agentSubject(exec);
  if (主体?.kind !== '成员' || !主体.id) return { 命中: false };
  const 快照 = readInstanceSnapshot(deps.org?.layout?.identityFile?.());
  // 无法识别成员时仍交原身份闸拒绝，不把未知快照折成普通成员。
  if (!快照.ok) return { 命中: false };
  const member = 快照.成员?.[主体.id];
  const 绑定 = member?.会审绑定;
  if (!绑定) return { 命中: false };
  const 拒 = (理由) => ({ 命中: true, 拒: `[dsh-mind] 会审参与实例工具闸 · ${理由}` });
  // 故障上报先于钉卡/绑定就绪检查，但收件人仍只由真实委派父与宿主父会话判定。
  if (exec.name === 'send_message') {
    if (快照.成员?.[member.委派者id]?.岗位 !== 'Lead') return 拒('报告通道没有可信的派发 Lead，unknown ⇒ 拒。');
    return { 命中: true, 拒: 成员报告通道(exec, 快照, member) };
  }
  if (member.就绪 !== true || member.岗位 === '复核员' || member.岗位 === 'Lead') {
    return 拒(`实例未就绪：${member.未就绪原因 ?? '咨询实例不是普通成员岗'}；仅可向派发 Lead 报告。`);
  }
  if (绑定.无效 || 绑定.来源会话 !== member.委派者id) return 拒(`绑定不可用（${绑定.无效 ?? '来源会话与真实委派者冲突'}），unknown ⇒ 拒；请报告派发 Lead。`);
  const 当前目录 = 会话工作目录(exec, deps);
  const 当前项目 = 当前目录 ? basename(当前目录) : 项目键(exec.agent, 项目);
  if (当前项目 !== 绑定.项目) return 拒(`会话项目 ${当前项目} 不是绑定项目 ${绑定.项目}，目录变化不扩大咨询权限。`);
  if (!咨询只读工具.has(exec.name)) return 拒(`工具「${exec.name}」不在咨询只读闭名单；写文件、子进程、再派活、能力发布及未知工具一律拒。`);
  if (exec.name === 'mind') {
    try { 会审参与动作闸({ subject: 主体, args: exec.arguments, 绑定, 项目: 当前项目 }); }
    catch (error) { return 拒(错误消息(error)); }
    return { 命中: true };
  }
  if (exec.name === 'skill') return { 命中: true };
  return { 命中: true, 拒: 咨询读路径(exec, deps, 绑定) };
}

function 咨询读路径(exec, deps, 绑定) {
  const 参数 = exec.arguments;
  const 搜索 = exec.name === 'glob' || exec.name === 'grep';
  let 路径 = 搜索 ? 参数?.path : 参数?.file_path;
  const 基准 = 会话工作目录(exec, deps);
  if (搜索 && 路径 === undefined) 路径 = 基准;
  const 拒 = (原因) => `[dsh-mind] 会审参与实例读路径 · ${原因}`;
  if (typeof 路径 !== 'string' || !路径.trim()) return 拒('缺少真实 arguments 路径或当前工作目录，unknown ⇒ 拒。');
  if (!isAbsolute(路径) && !基准) return 拒('相对路径没有当前工作目录，unknown ⇒ 拒。');
  let 目标;
  try { 目标 = 规范路径(realpathSync(isAbsolute(路径) ? 路径 : resolvePath(基准, 路径))); }
  catch { return 拒('目标路径不存在或无法 realpath，unknown ⇒ 拒。'); }
  const 私有根 = deps.org?.layout?.privateRoot;
  if (!私有根) return 拒('私有区位置不可判定，unknown ⇒ 拒。');
  const 私有 = 规范路径(私有根);
  if (在目录内(目标, 私有) || (搜索 && 在目录内(私有, 目标))) return 拒('私有区原始账本禁止直读，也不得从父目录递归搜索；请报告 Lead。');
  const 根 = (绑定.资料 ?? []).filter((x) => typeof x === 'string' && isAbsolute(x))
    .map((x) => process.platform === 'win32' ? resolvePath(x).toLowerCase() : resolvePath(x))
    .filter((x) => {
      try { return 规范路径(realpathSync(x)) === x; } catch { return false; }
    });
  return 根.some((x) => 在目录内(目标, x)) ? undefined : 拒('目标不在本场会审明确授权的资料根内；没有资料不等于整个工作区可读。');
}

/**
 * 复核员的只读工具闭名单（v2 条目6/7 · 2026-10-18）。
 *
 * 为什么是**闭名单**：`write/edit/pwsh/bash/创建/未知执行类` 的正确集合是「除下面这些
 * 之外的一切」——开名单会把未来新增的工具默认放给复核员（漏一个就是一条写侧门）。
 * `mind` / `mind_guard` 由本体按动作判（写全拒、读按复核读域）；`skill` 是只读规范。
 */
const 复核只读工具 = new Set(['read', 'glob', 'grep', 'read_image', 'skill', 'mind', 'mind_guard']);

/** 与条目10 同一把尺：用真实会话事实（根会话=Lead，子会话=成员），不认自报。 */
function 复核员工具闸(exec, 项目, deps) {
  const 工具 = exec?.name;
  const 主体 = agentSubject(exec);
  if (主体?.kind !== '成员' || !主体.id) return undefined;
  // 读取函数不依赖热更前已缓存的 Registry 对象是否已有新方法。
  const 快照 = readInstanceSnapshot(deps.org?.layout?.identityFile?.());
  if (快照?.ok !== true) {
    // parse / 形状失败 ⇒ **不得当空表放行**（7f8 的同步接口合同）。
    return `[dsh-mind] 工具闸 · 身份档案同步快照不可用，无法确认复核员只读边界（unknown ⇒ 拒，不拿空表放行）：${快照.原因 ?? '未知原因'}。`;
  }
  const member = 快照.成员?.[主体.id];
  if (!member || member.状态 !== '在岗' || !member.岗位) {
    return `[dsh-mind] 工具闸 · 成员身份未就绪：${主体.id} ${member ? `状态为 ${member.状态 ?? '缺失'}、岗位 ${member.岗位 ?? '缺失'}` : '没有在册记录'}。未知/封存实例不能因无法识别复核岗位而获得通用工具权限，请交回 Lead 诊断。`;
  }
  if (member.岗位 !== '复核员') return undefined;
  // 报告通道（唯一放行的非只读工具）：只允许发给**派发它的 Lead**，不是全局放行
  // send_message（否则复核员可唤醒任意成员/再派活）。见 成员报告通道()。
  if (工具 === 'send_message') return 成员报告通道(exec, 快照, member);
  if (!复核只读工具.has(工具)) {
    return `[dsh-mind] 复核员只读数（v2 条目7）：工具「${工具}」不在只读闭名单内（write / edit / pwsh / bash / 创建 / 未知执行类一律拒）。需要改被验对象请把结论交给 Lead，由 Lead 落笔。`;
  }
  if (工具 === 'mind' || 工具 === 'mind_guard' || 工具 === 'skill') return undefined;
  // 读域判据要岗位位（档案里已确认是复核员）：补上 roleId，仍走 review-scope 同一函数。
  const 读数 = 复核读路径(exec, { ...deps, 项目, 主体: { ...主体, roleId: member.岗位 } });
  if (读数.拒) return 读数.拒;
  return undefined;
}

/**
 * 复核员的**报告通道**（v2 条目6 补修）：`send_message` 只许发给派发它的 Lead。
 *
 * 官方有两个真实变体：子代理用 `agent_id`，Root/Team 用 `target`。这里**同一函数**同时认
 * 这两个当前已核字段（不写成 `agent_id ?? target` 的目标置换）：
 *  - 至少提供一个；提供的每一个都必须是字符串且指向**同一个**可信派发 Lead；
 *  - `lead` 别名与派发父的真实 ID 等价（同一 Lead 的两种写法），合并后必须唯一；
 *  - 任一字段指别成员/别角色、两字段冲突、出现 `message`/`agent_id`/`target` 之外的
 *    未知收件类参数、缺字段或空串 ⇒ 全拒（不让未知收件参数偷偷进 body）。
 *
 * 可信派发关系 = 身份快照 `委派者id`（Lead 正规登记落下）+ 宿主父会话
 * （`header.parentSession` / `parentSessionId`；拿不到不用 header.cwd 猜）。两者都像 Lead
 * 但指向不同实例 ⇒ 无法唯一判定，按 fail-closed 拒。
 * 只回报、不改被验对象；不是业务提案动作的豁免（其他写工具仍全拒）。
 *
 * @returns {string|undefined} 拒因或放行（undefined）
 */
function 成员报告通道(exec, 快照, member) {
  const 参数 = exec?.arguments;
  if (!参数 || typeof 参数 !== 'object' || Array.isArray(参数)) {
    return '[dsh-mind] 成员报告通道 · send_message 的 arguments 缺失或形状不合法（unknown ⇒ 拒）。';
  }
  const 允许键 = new Set(['message', 'agent_id', 'target']);
  const 未知键 = Object.keys(参数).filter((键) => !允许键.has(键));
  if (未知键.length > 0) {
    return `[dsh-mind] 成员报告通道 · 不认识的收件/透传参数：${未知键.join('、')}。只允许 message + agent_id/target（官方两个真实变体）；未知参数不许偷偷进 body。`;
  }
  const 提供 = ['agent_id', 'target'].filter((键) => 参数[键] !== undefined);
  if (提供.length === 0) {
    return '[dsh-mind] 成员报告通道 · 缺少收件字段：至少给 agent_id 或 target 之一（unknown ⇒ 拒），且只能指向派发你的 Lead。';
  }
  for (const 键 of 提供) {
    const 值 = 参数[键];
    if (typeof 值 !== 'string' || !值.trim()) {
      return `[dsh-mind] 成员报告通道 · ${键} 必须是非空字符串（unknown ⇒ 拒）。`;
    }
  }
  // 可信派发 Lead：委派者 id（必须是 Lead 实例/别名）与宿主父会话。
  const 候选 = [];
  const 委派者id = typeof member?.委派者id === 'string' ? member.委派者id : null;
  if (委派者id && (委派者id === 'lead' || 快照.成员?.[委派者id]?.岗位 === 'Lead')) 候选.push(委派者id);
  const 头 = exec?.agent?.session?.header ?? {};
  const 父会话 = typeof 头.parentSession === 'string'
    ? 头.parentSession
    : (头.parentSession?.id ?? (typeof 头.parentSessionId === 'string' ? 头.parentSessionId : null));
  if (typeof 父会话 === 'string' && 父会话) 候选.push(父会话);
  const 唯一 = [...new Set(候选)];
  if (唯一.length === 0) {
    return '[dsh-mind] 成员报告通道 · 没有可信的派发 Lead/父会话（缺父归属或档案坏）：不能发消息；请把结果放进交卷，或让 Lead 先正规登记复核实例。';
  }
  if (唯一.length > 1) {
    return `[dsh-mind] 成员报告通道 · 父归属（${委派者id ?? '无'}）与宿主父会话（${父会话 ?? '无'}）指向不同 Lead，无法唯一判定派发者（fail-closed）：请交回 Lead 核档案。`;
  }
  const 派发 = 唯一[0];
  const 允许别名 = 派发 === 'lead' || 快照.成员?.[派发]?.岗位 === 'Lead';
  const 归一 = (值) => (值 === 派发 || (允许别名 && 值 === 'lead') ? 派发 : null);
  for (const 键 of 提供) {
    if (归一(参数[键]) === null) {
      return `[dsh-mind] 成员报告通道 · ${键}「${参数[键]}」不是派发你的 Lead（${派发}${允许别名 ? ' / lead' : ''}）：不能唤醒其他成员、不能改派活对象。`;
    }
  }
  return undefined;
}

/** 会话当前工作目录：官方 `workingDirectory.get(session)` 是已提交的绝对路径，优先用它。 */
function 会话工作目录(exec, deps) {
  try {
    const 服务 = (typeof deps.ctx?.get === 'function' ? deps.ctx.get('workingDirectory') : null) ?? deps.ctx?.workingDirectory;
    const 目录 = 服务?.get?.(exec?.agent?.session);
    if (typeof 目录 === 'string' && 目录.trim()) return 目录;
  } catch { /* 服务未装载：退回会话头 */ }
  // 不把 header.cwd 当唯一真源（目录可变）；只有服务拿不到时才作为 fallback。
  const 头目录 = exec?.agent?.session?.header?.cwd;
  return typeof 头目录 === 'string' && 头目录.trim() ? 头目录 : null;
}

/** 规范化 + realpath（处理 junction / symlink / `..`；Windows 大小写不敏感）。 */
function 规范路径(路径) {
  const 绝对 = resolvePath(路径);
  let 真 = 绝对;
  try { 真 = realpathSync(绝对); } catch { /* 不存在的路径按词法判：写入类本就已被闭名单拦掉 */ }
  return process.platform === 'win32' ? 真.toLowerCase() : 真;
}

/** 目标是否在根目录内（按路径段比较，前缀相同的兄弟目录不算）。 */
function 在目录内(目标, 根) {
  return 目标 === 根 || 目标.startsWith(`${根}${sep}`) || 目标.startsWith(`${根}/`);
}

/**
 * 复核员读路径判定：真实 `exec.arguments` 的 file_path/path（官方 L3259-64 冻结的是
 * `exec.arguments`，不是 `exec.input`），**缺关键读数按 unknown 拒**。
 *
 * 私有区（任务图/审计/身份/记忆/总线原始账本）优先拒：路径先 realpath 再比较，
 * 大小写 / 相对 / `..` / junction / symlink 都折到同一个真实路径上，不比字面串。
 * 其余只允许任务项目源码（会话已提交工作目录）内的读；产物请走明确引用。
 *
 * @returns {{ 拒?: string }}
 */
function 复核读路径(exec, deps) {
  const 工具 = exec?.name;
  const 参数 = exec?.arguments;
  let 目标 = 工具 === 'read' || 工具 === 'read_image' ? 参数?.file_path : 参数?.path;
  if (目标 === undefined || 目标 === null || String(目标).trim() === '') {
    if (工具 === 'glob' || 工具 === 'grep') {
      // 官方 fs-search：未传 path ⇒ 搜索根 = 当前工作目录（已提交的那个）。
      目标 = 会话工作目录(exec, deps);
      if (!目标) {
        return { 拒: `[dsh-mind] 复核员读路径 · 工具「${工具}」未传 path 且取不到当前工作目录（unknown ⇒ 拒，不从 header.cwd 猜）：请显式带 path，或用 mind 的只读动作。` };
      }
    } else {
      return { 拒: `[dsh-mind] 复核员读路径 · 工具「${工具}」缺少 arguments.file_path（unknown ⇒ 拒）：请在 exec.arguments 里给出要读的文件路径。` };
    }
  }
  if (typeof 目标 !== 'string') {
    return { 拒: `[dsh-mind] 复核员读路径 · 「${工具}」的路径参数不是字符串（unknown ⇒ 拒）。` };
  }
  const 基准 = 会话工作目录(exec, deps);
  const 绝对 = /^[A-Za-z]:[\\/]/.test(目标) || 目标.startsWith('/') ? 目标 : (基准 ? resolvePath(基准, 目标) : null);
  if (!绝对) {
    return { 拒: `[dsh-mind] 复核员读路径 · 相对路径「${目标}」没有可用的当前工作目录（unknown ⇒ 拒）。` };
  }
  const 规范目标 = 规范路径(绝对);
  const 私有根 = deps.org?.layout?.privateRoot;
  if (私有根) {
    const 规范私有 = 规范路径(私有根);
    if (在目录内(规范目标, 规范私有)) {
      return { 拒: '[dsh-mind] 复核员读路径 · 私有区原始任务/审计/身份/记忆/总线文件禁止直读（v2 条目6/7）：请改用 mind 的 scoped 动作——workbench / task_criteria / memory_query / audit_tail / bus_read，它们按复核读域裁剪。' };
    }
  }
  if (!基准) {
    // 相对参数的解析基准只能来自 workingDirectory.get（官方语义）；拿不到就 unknown 拒。
    return { 拒: `[dsh-mind] 复核员读路径 · 相对路径「${目标}」没有可用的当前工作目录（unknown ⇒ 拒）：请先确保会话工作目录可读，或用绝对路径 + 合法产出引用。` };
  }
  // **授权读根 = 本复核任务/目标上的显式产出引用**（文件或目录），不是整台机器、也不是整个工作区。
  // 引用必须是**绝对路径且真实存在**；散文式 / 相对路径 / 不存在的引用一律不猜（无效即不作为根）。
  const 授权 = 复核授权读根(exec, deps);
  if (授权.拒) return 授权;
  if (!授权.根.some((根) => 在目录内(规范目标, 根))) {
    return {
      拒: `[dsh-mind] 复核员读路径 · 「${目标}」不在本复核任务的授权产出引用范围内（目录变化不扩大授权）：请 Lead 在复核任务上 attach 明确源码目录/产物文件（产出物引用，绝对路径），或改用 mind 的 scoped 动作（workbench / task_criteria / memory_query / audit_tail / bus_read）。`,
    };
  }
  return {};
}

/**
 * 复核员的授权读根：从**任务图真实绑定**同步现算，不依赖会话 cwd 作为授权面。
 *
 * 口径：复核读域（已绑定复核任务 → 显式复核对象）里每个节点的 `产出物引用`；
 * 只认**绝对路径且真实存在**的引用（文件或目录）——散文 / id / 相对路径不猜。
 * 私有组织根（raw 账本）始终由调用方先拒，这里不参与。
 *
 * @returns {{ 根?: string[], 拒?: string }}
 */
function 复核授权读根(exec, deps) {
  const org = deps.org;
  if (!org?.layout?.taskLog) return { 拒: '[dsh-mind] 复核员读路径 · 任务图接口不可用，无法确认授权产出引用（unknown ⇒ 拒）。' };
  // 项目键 = **已提交工作目录**的目录名（§14.4-5 目录名即项目键）；拿不到才退回配置默认。
  // 不用 header.cwd 当唯一真源（目录可变），也不把「目录变了」变成授权扩张——授权仍来自该
  // 项目任务图上的真实绑定。
  const 提交目录 = 会话工作目录(exec, deps);
  const 项目名 = 提交目录 ? basename(提交目录) : 项目键(exec?.agent, deps.项目 ?? DEFAULT_PROJECT);
  let rows;
  try {
    const 文本 = readFileSync(org.layout.taskLog(项目名), 'utf8');
    rows = 文本.trim() === '' ? [] : 文本.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  } catch (error) {
    return { 拒: `[dsh-mind] 复核员读路径 · 读不到项目 ${项目名} 的任务账本（unknown ⇒ 拒，不拿「没读到」当「没有引用」）：${error instanceof Error ? error.message : String(error)}。若尚无复核任务/授权产出引用，请 Lead 先建复核任务并 attach 源码目录/产物文件（授权产出引用，绝对路径）。` };
  }
  const 节点 = [...fold(rows).values()];
  const 域 = 复核读域({ 节点, 主体: deps.主体 ?? agentSubject(exec), 项目: 项目名 });
  if (!域.限定) return { 拒: '[dsh-mind] 复核员读路径 · 主体不是已登记的复核员岗（unknown ⇒ 拒）。' };
  const 根 = new Set();
  for (const node of 节点) {
    if (!域.集合.has(String(node.id))) continue;
    // 只认 Lead/主权者通过 task_attach(读根=true) 明确授予的 `复核读根`；
    // 成员自报的 产出物引用（交付物）不授予文件读权限——避免成员自授权扩读域。
    for (const 引用 of node.复核读根 ?? []) {
      if (typeof 引用 !== 'string' || !isAbsolute(引用)) continue;
      try { 根.add(规范路径(realpathSync(引用))); } catch { /* 不存在 / 读不到 ⇒ 不作为授权根 */ }
    }
  }
  if (根.size === 0) {
    return {
      拒: `[dsh-mind] 复核员读路径 · 本复核任务没有可用的授权产出引用（复核任务 ${域.复核任务.length} 个 / 复核对象 ${域.复核对象.length} 个）：不能默认把工作区或整台机器授给复核员。请 Lead 在复核任务上 attach 源码目录/产物文件（产出物引用，绝对路径）。`,
    };
  }
  return { 根: [...根] };
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
          // P2-04（全面审查 2026-10-17）：主体与轮键必须同源——宿主用 agent 形状发
          // turn/end 时，轮键取到了成员会话，主体却回落到 Lead。这里复用轮键的同一优先级。
          主体: agentSubject({ agent: payload?.agent ?? { session: payload?.session ?? (payload?.sessionId ? { id: payload.sessionId } : undefined) } }),
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
 *
 * **只认真正的人类消息**（2026-10-18 条目13 审计实证）：宿主 journal 里
 * `agent-message` / `subagent-settled` / `runtime-context` / `compact-checkpoint` /
 * `skill-catalog` 等也全是 `user/message`。修前只看事件类型 ⇒ 系统自己的自动回报
 * 会给自己续失联时钟，「失联」永远不会到。
 *
 * 可信判据来自宿主写的事实：`event.data.source.kind === 'user'` **且带 `rpcId`**
 * （真实人消息由用户的 RPC 发起）。未知 / 缺来源 / 其它 kind 一律**不续命**；
 * 不从正文猜（正文可伪造，来源字段是宿主写的）。事件包装 `event` / `event.event`
 * 两种形状都认（按实际宿主日志兼容）。
 *
 * @param {any} ctx @param {any} org @param {any} logger
 */
function 挂主权者交互(ctx, org, logger) {
  ctx.on('session/event', (session, event) => {
    try {
      // 包装兼容：宿主有的版本直接给事件、有的包在 event.event 里。
      const ev = event?.type ? event : event?.event;
      if (ev?.type !== 'user/message') return;
      const source = ev?.data?.source ?? null;
      // 唯一可信口径：source.kind === 'user' 且 rpcId 非空。缺一即不续命（fail-closed）。
      if (source?.kind !== 'user' || typeof source?.rpcId !== 'string' || source.rpcId === '') return;
      // 来源必带（设计评审 #7 · 2026-10-15）：markInteraction 的来源白名单闸——「宿主事件」
      // 就是本挂钩（宿主的**人类**用户消息），缺席/名单外会被服务层 fail-closed 拒。
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
    '派活流程：接需求→定判据（写不出判据就不开工）→查岗位（有需要即建卡/改卡）→Lead 按需选择直接执行或 member_spawn 委派（方式=team/subagent＋岗位＋节点＋任务书；机制完成 registry_assign 登记→绑定节点→装载岗位与判据→发开工消息，不等待成员确认）→复核→采纳/打回→落记忆→结账。',
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

/**
 * Lead 实例随主会话出生（v2 口述收敛 2026-10-18 条目9/10）的**唯一调用点实现**：
 * 工具面与命令面各调一次，判据与落点都在 `registry.ensureLeadInstance()`。
 *
 * 三条边界（2026-10-18 W5 审计反例后收紧）：
 *  - 只对**真实会话事实派生的 Lead 主体**生效（`agentSubject` 的产物）。路由面主体是
 *    `{id:'设置页', kind:'Lead'}`——伪实例，不在这里出生（它直接调 runAction，绕过本函数）。
 *  - **不再「warn 后继续」**：返回的就绪读数是模型面自治写的写前闸输入（已封存 / 未钉版 /
 *    快照读不到 / unknown 一律未就绪）。读动作仍可用并带诊断读数。
 *  - 幂等：已有记录（任何岗位）一律不动——不复活封存、不自动补钉；由写前快照校验与
 *    registry_restore 的正路处理。
 *
 * @param {object} org
 * @param {object} 主体 `agentSubject` 的产物
 * @param {object} logger
 * @returns {Promise<{已登记: boolean, 就绪: boolean, 卡版本?: string|null, 原因?: string}|null>} 非 Lead ⇒ null
 */
async function 钉Lead实例(org, 主体, logger) {
  if (主体?.kind !== 'Lead') return null;
  try {
    const 读数 = await org.registry.ensureLeadInstance({ 实例: 主体.id, 代次: org.boot?.代次 });
    // 就绪 = 有登记事实 + 明确就绪 + 有卡版本摘要。缺关键位（unknown）按**未就绪**处理：
    // 写前闸不许「少一个字段就默认 ready」。
    const 就绪 = 读数?.已登记 === true && 读数?.就绪 === true && Boolean(读数?.卡版本);
    if (!就绪) logger?.warn?.(`[dsh-mind] Lead 实例钉版未就绪（模型面自治写将 fail-closed）：${读数?.原因 ?? '没有可判就绪读数'}（实例 ${主体.id}）`);
    return { ...读数, 就绪, ...(就绪 ? {} : { 原因: 读数?.原因 ?? '没有可判就绪读数（unknown ⇒ 未就绪）' }) };
  } catch (error) {
    const 原因 = error instanceof Error ? error.message : String(error);
    logger?.warn?.(`[dsh-mind] Lead 实例钉版失败（模型面自治写将 fail-closed）：${原因}`);
    return { 已登记: false, 就绪: false, 卡版本: null, 原因 };
  }
}

/**
 * 把**该 Root 实例已钉住的 Lead 规程**注入组织上下文（v2 条目10 · W7 实证补修）。
 *
 * 时机：`system-prompt/assemble` 里、首个真实模型组织上下文装配之前。出生/钉版走
 * **同一个真实宿主事实入口**（`钉Lead实例` → `ensureLeadInstance`），只对真实根 Agent；
 * 子会话（成员）/设置页等伪 Lead 形状不会到这里，也不从 args 推身份。
 *
 * 失败语义：读卡/钉版失败**不假成功**——不注入任何「看起来是规程」的正文，只显式标
 * 「未就绪 + 自治写已 fail-closed、诊断读可用」；不抛错，避免整轮会话起不来。
 * 运行中实例的规程来自钉住快照（`cardOf.段`），后续改现行卡不会换脸。
 *
 * @param {object} assembly
 * @param {any} agent 宿主装配上下文里的真实 Agent
 * @param {object} org
 * @param {any} logger
 */
async function 注入Lead已钉规程(assembly, agent, org, logger) {
  try {
    if (!assembly || typeof assembly !== 'object' || !Array.isArray(assembly.sections)) return assembly;
    // 只认**真实 Agent**（有 session.id 的宿主会话事实）：没有会话 id 的任意 Lead 形状
    // （如设置页路由主体）不在这里造人；子会话由 agentSubject 判成成员后跳过。
    const 会话id = agent?.session?.id;
    if (typeof 会话id !== 'string' || !会话id.trim()) return assembly;
    const 主体 = agentSubject({ agent });
    if (主体?.kind !== 'Lead' || !主体.id) return assembly;
    const 登记 = await 钉Lead实例(org, 主体, logger);
    let 段文本;
    if (登记?.就绪 !== true) {
      段文本 = [
        '【Lead 岗位规程 · 未就绪】',
        `实例 ${主体.id} 的岗位卡钉版未就绪（${登记?.原因 ?? 'unknown'}）：自治写已按 fail-closed 拒绝；`,
        '只读诊断（status / workbench / audit_tail / task_criteria）仍可用。请先由主权者修好 Lead 岗位卡与身份档案。',
      ].join('\n');
    } else {
      const 钉 = await org.registry.cardOf(主体.id);
      const 段 = 钉?.段 ?? {};
      // 卡解析出的段键是 `个体L0` / `个体L1`；旧接口/别处可能带段名，两种形状都认。
      const 取段 = (...键) => 键.map((k) => 段?.[k]).find((v) => typeof v === 'string' && v.trim()) ?? '';
      const L0 = String(取段('个体L0', '个体L0 · 身份核心', '个体L0 · 身份核心（锁定）', '个体L0 · 身份')).trim();
      const L1 = String(取段('个体L1', '个体L1 · 规则')).trim();
      const 能力 = (钉?.能力引用 ?? []).join('、');
      段文本 = [
        `【Lead 岗位规程 · 已钉卡版本 ${(钉?.卡版本?.摘要 ?? '').slice(0, 12) || '未知'}】`,
        ...(L0 ? [`个体L0 · 身份核心：${L0}`] : []),
        ...(L1 ? [`个体L1 · 规则：${L1}`] : []),
        `个体L2 · 能力引用（只引用，不内嵌正文）：${能力 || '（无）'}`,
        '运行中实例以本钉住版本为准；现行卡后续改动不会替换这些规程。',
      ].join('\n');
    }
    const 既有 = assembly.sections.find((section) => section?.name === 'mind:lead-pinned-rules');
    if (既有) return { ...assembly, sections: assembly.sections.map((s) => (s === 既有 ? { ...s, text: 段文本 } : s)) };
    return { ...assembly, sections: [...assembly.sections, { name: 'mind:lead-pinned-rules', text: 段文本 }] };
  } catch (error) {
    logger?.warn?.(`[dsh-mind] Lead 已钉规程注入失败（不假成功，也不炸整轮）：${错误消息(error)}`);
    return assembly;
  }
}

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
  for (const key of ['负责人', '判据', '依赖', '复核对象', '分歧清单', '反例面', '产出物引用', '适用岗位', '收件', '标签', '来源引用', '知识候选', '参与者']) {
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
  // 记忆处置（task_settle · v2 条目16）：{候选键: "晋升"|"留账本"|"丢弃"} 的对象映射。
  // 字符串形态按 JSON 解析；坏串响亮拒，不静默当空声明（空对象 {} 是「无候选需处置」的
  // 合法明示，坏串不是）。
  if (typeof out.记忆处置 === 'string') {
    try {
      out.记忆处置 = JSON.parse(out.记忆处置);
    } catch {
      throw new InvalidBody('记忆处置 不是合法 JSON：解析失败不许静默当空声明（空声明与坏串是两回事）。', {
        detail: { 期望形状: '{"know-xxx":"晋升","候选/member-a/0":"留账本"}' },
      });
    }
  }
  return out;
}
