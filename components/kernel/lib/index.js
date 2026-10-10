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
import { describeFailure } from '../../../src/kernel/errors.js';
import { ACTIONS, runAction } from '../../../lib/actions.js';
import { 挂同源路由, 看板包 } from './routes.js';

export const name = 'dsh-mind-kernel';
export const inject = ['tools'];

/** 闸的三态。`未配置` 是出厂件缺失时的诚实答案，不是「随便放行」。 */
const ENVELOPE_STATE = { 状态: '未配置', 允许: [], 拒绝: [] };

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

  // 主面（工具）**不吞异常**：注册不上就等于这个组件没生效，
  // 让宿主如实报出装载失败，而不是留下一个「看起来装好了」的假象。
  ctx.tools.register(mindTool({ org, 项目, 项目键: (exec) => 项目键(exec?.agent, 项目) }));

  ctx.inject?.(['commands'], (scoped) => {
    try {
      scoped.commands.register(mindCommand({ org, 项目, 项目键: (agent) => 项目键(agent, 项目) }));
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

  try {
    // 单调闸：只读部署偏好，不读路径，不接受任何人的「通融」。
    ctx.tools.guard((exec) => 闸判定(exec, 项目));
  } catch (error) {
    logger.warn?.(`[dsh-mind] 注册工具范围闸失败：${error instanceof Error ? error.message : String(error)}`);
  }

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
 * @param {{ org: object, 项目: string, 项目键: (exec: object) => string }} spec
 */
function mindTool({ org, 项目, 项目键 }) {
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
        id: { type: 'string', description: '对象 id（任务节点 / 记忆条目 / 挂起项）' },
        描述: { type: 'string' },
        负责人: { type: 'string', description: '负责人 id 或多个用逗号分隔' },
        判据: { type: 'string', description: '验收标准；多个用逗号分隔。任务必填，派发后冻结' },
        依赖: { type: 'string' },
        模式: { type: 'string', enum: ['并行分担', '独立会审'], description: '一岗多人必须显式声明' },
        三态: { type: 'string', enum: ['过', '不过', '未验'], description: '复核结论；未验 ≠ 通过且不计打回' },
        分歧清单: { type: 'string' },
        反例面: { type: 'string' },
        结论: { type: 'string', description: '交卷结论（task_submit）；会审按人留，谁交卷记谁那份' },
        决定: { type: 'string', description: '待决项的裁决内容（task_resolve）' },
        复核者: { type: 'string', description: '复核结论归属的复核者 id（task_review）；省略取主体' },
        待决类型: { type: 'string', description: '待决类型（task_pending）；省略取「升级差异」' },
        结论集: { type: 'string', description: 'JSON 数组：[{成员,结论,反例面}]，用于零分歧检查' },
        产出物引用: { type: 'string' },
        类: { type: 'string', enum: ['知识', '经历', '偏好', '作答'] },
        内容: { type: 'string' },
        来源: { type: 'string', description: '怎么知道的；记忆写入必填（谁记的默认取主体）' },
        来源引用: { type: 'string', description: '证据/来源对象 id，多个用逗号分隔（契约A 血缘）；know-/exp-/pref-/answ- 查账本、task- 查任务图、artifact- 本批不校验，悬空拒写' },
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
        原因: { type: 'string' },
        名: { type: 'string' },
        正文: { type: 'string' },
        适用岗位: { type: 'string' },
        依据: { type: 'string' },
        线程: { type: 'string' },
        发件: { type: 'string', description: '已忽略（W2 安全修复）：发件人恒为真实主体 id，自报无效——冒充发件人是伪造轮边界的第一步' },
        收件: { type: 'string', description: '收件人，多个用逗号分隔' },
        类型: { type: 'string', description: '消息类型（bus_send）；debate_say 只认 分歧/表态/答复' },
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
    isConcurrencySafe: (args) => ['status', 'workbench', 'memory_query', 'memory_lineage', 'capability_list', 'capability_resolve', 'capability_read', 'bus_read', 'audit_tail', 'audit_verify', 'registry_list', 'registry_can', 'upgrade_pending', 'policy_check'].includes(args?.action),
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
        return JSON.stringify({ 成功: true, ...(await runAction({ org, 项目: 本次项目, subject: 主体, 主体, args: normalizeArgs(args) })) }, null, 1);
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
 * @param {{ org: object, 项目: string, 项目键: (agent: object) => string, 名册?: object }} spec
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
          const 包 = await 看板包({ org: spec.org, 项目: 本次项目, 读者: agentSubject({ agent }), 审计条数: 40 });
          return { kind: 'success', text: JSON.stringify(包, null, 1) };
        }
        const [head, ...rest] = line.split(/\s+/);
        const action = ALIASES[head] ?? head;
        const args = 解析参数(rest.join(' '));
        const 主体 = agentSubject({ agent });
        // `面: 'command'` 是**人侧**的标记：命令面专属动作（如改设置的 `presence`）
        // 只在这一面可达，`mind` 工具的 enum 里没有它们（模型没有这只手）。
        // `主体` 一起显式传下去：账上要记**敲这条命令的那个人**，不许归并成一个泛化的 lead。
        const result = await runAction({ org: spec.org, 项目: args.project ?? 本次项目, subject: 主体, 主体, args: { action, ...args }, 面: 'command' });
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
  if (ENVELOPE_STATE.允许.length > 0 && !ENVELOPE_STATE.允许.includes(工具) && !工具.startsWith('mind')) {
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
  for (const file of candidates) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(text);
      ENVELOPE_STATE.状态 = '已配置';
      ENVELOPE_STATE.允许 = Array.isArray(parsed.允许) ? parsed.允许 : [];
      ENVELOPE_STATE.拒绝 = Array.isArray(parsed.拒绝) ? parsed.拒绝 : [];
      return;
    } catch (error) {
      ENVELOPE_STATE.状态 = '故障';
      ENVELOPE_STATE.错误 = `${file}：${error instanceof Error ? error.message : String(error)}`;
      logger.warn?.(`[dsh-mind] 工具总范围无法解析，已按 fail-closed 处理：${ENVELOPE_STATE.错误}`);
      return;
    }
  }
  ENVELOPE_STATE.状态 = '未配置';
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
      轮.set(key, bucket);
    } catch (error) {
      logger.warn?.(`[dsh-mind] 工具结果记账异常：${error instanceof Error ? error.message : String(error)}`);
    }
  });

  // 轮 = 一次任务实例从派发到交卷的一次执行段；交卷（回合结束）时落一条汇总。
  ctx.on('turn/end', (payload) => {
    try {
      const key = 轮键(payload);
      const bucket = 轮.get(key);
      if (!bucket || (bucket.成功 === 0 && bucket.失败 === 0)) return;
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
      org.registry.markInteraction({}).catch((error) => logger.warn?.(`[dsh-mind] 记录主权者交互失败：${error.message}`));
    } catch {
      // 事件形状变了不该影响会话；失联判定还有 `/mind sovereign_interaction`（命令面专属）兜底。
    }
  });
}

// ── 辅助 ──────────────────────────────────────────────────────────────────────

/**
 * 组织说明段：随身份带的是**岗位与编制**，不是全量历史。
 * 这是 §9「上下文 = 按需拉，不许全量推」在提示词侧的实现。
 * @param {any} org
 */
function 组织说明(org) {
  return [
    '本会话处于一个数字组织中，你可以用 `mind` 工具与组织交互。',
    `项目键：${org.project}。`,
    '身份约定：根会话执行者 = Lead（可派活、可建卡、可汇总验收）；复核者只读数、不改、不提案；成员任务内全权、任务外无。',
    '纪律：写操作一律先过策略引擎；被拒绝时结果里会带「哪条规则 + 改它要什么授权」，照着改，不要绕。',
    '按需拉取：需要组织状态时调 `mind` 的 status / workbench；需要知识时调 memory_query；需要技能规程时调 capability_list。不要假设历史会出现在上下文里。',
    '留痕是自治的门槛：无留痕的自治变更 = 无效。',
  ].join('\n');
}

/**
 * 从执行上下文里取主体：**根会话 = Lead，子会话（成员）= 不是 Lead**。
 *
 * 门②（2026-10-10 独立复核实证 · Lead 身份落在可自报字段上）：
 * 修前这里传的是**常量** `根会话: true` ⇒ 任何会话（含成员子会话）的 subject 都是
 * `{kind:'Lead'}` ⇒ `debate_round` / `debate_converge` 的「仅 Lead」判据在模型可达面不承重
 * （成员会话调 `debate_round` 直接放行）。常量的危险在于它**不依赖任何事实**：
 * 换掉它就得给出事实判据。
 *
 * 事实判据**不是**「`parentSession` 存在即成员」——`session/fork` 造的**顶层**会话带
 * `parentSession` 却不带委托语义（`@deepseek-ai/dsh-session` lib/types/types.d.ts:70-76 自陈
 * "fork seed lineage"，与本仓 `E:\DSHOME\packages\dshome\lib\host\mind-inject.js:223-224`
 * 点名的误杀坑一字一致）。本仓既有同款判据**四处**（mind-inject.js:197-208 点名的
 * notify.js:311/368、session-budget.js:293/337、mind-mood.js:418）用的都是
 * `header.origin === 'subagent'`（types.d.ts:81，全文只有这一个取值；写入端唯一一处是
 * dsh-subagent 的 childSessionMeta，三条创建路径共用 ⇒ **所有 in-process 子会话都带它，
 * 而顶层会话这个字段缺席**）。成员子会话正是子代理：`startContinuable` 起的成员走的就是
 * 这条路。于是这里用**同一份事实**，与那四处同口径；`delegationDepth` 只作佐证
 * （types.d.ts:82-87：顶层缺席、子会话 = 父+1）。
 *
 * 三档（顺序即优先级：先判最贵的「子会话事实」）：
 *  1. **有子会话事实**（`header.origin === 'subagent'`，或 `delegationDepth >= 1`）⇒
 *     **不是 Lead**；实例键取**自己的**会话 id（B 修 · 2026-10-10，见 `会话实例键`）。
 *     身份 = **成员**、**不带 `roleId`**（A 修 · 2026-10-10）：会话事实里没有「岗位」这一位，
 *     所以主体不自陈岗位 —— 岗位由 Lead 的显式登记（`registry_assign`，实例 = 该会话 id）
 *     落在身份档案里，主体链对账时按「在册且在岗」放行（见 `docs/设计债-2026-10-09.md` ㉑）。
 *  2. 其余（不是子会话 / 会话事实缺席 / `header` 缺席但 `agent` 在）⇒ **Lead**，
 *     实例取会话 id（W3 批3 既有语义：账上不丢掉「哪一个会话」）。
 *  3. `exec` 整个取不到（不是对象）⇒ **不认 Lead**，落到 `subjectFor({})` 的
 *     `{kind:'成员'}`（无 `roleId`）—— 与 `subjectFor` 自陈的「未知一律不给万能身份，
 *     身份不明时最严」同口径（fail-closed）：实例键是 `unknown`，档案里查不到 ⇒ 拒。
 *
 * 为什么第 2 档**不收窄**「会话事实缺席」那一格（这一档修前就是恒 Lead，修后仍是 Lead）：
 *  · `Session` 恒定带 `header`（`SessionHeader.id` 是 required，types.d.ts:65），
 *    所以「有会话而无 header / 无会话」只出现在**夹具**里，而夹具正是本函数的调用面：
 *    `fakeExec`（test/host-harness.mjs:127）给 `{id, header:{cwd}}`；命令面给
 *    `{agent:{session:{id,header}}}`（test/presence-command.test.js:193）或**裸 `{}`**
 *    （15 处：host.test.js:120/124/128、integration.test.js:36/65/70/90、
 *    presence*.test.js、host-routes.test.js:148/210/257）。裸 `{}` 的语义是
 *    「命令行那条路没带 agent」，**不是**「这是个成员会话」——本轮实测：把它判成成员
 *    会让 26 条既有用例变红（整条 `/mind` 命令面打成拒绝），那是误伤，不是收紧。
 *  · 本轮**要堵的洞**是「**子会话**也恒被当成 Lead」，第 1 档正对着它；第 2 档保持原状
 *    是**刻意不动既有行为**（不动 ≠ 放宽：它修前修后同一读数）。
 *  · 真正 Unknown 的那一格（第 3 档）倒向安全侧 —— 与任务书建议的「拿不到父会话事实
 *    ⇒ 不认 Lead」同向，只是把「拿不到」的判据定在 **`exec` 缺失**，而不是「`header`
 *    缺席」（后者是夹具常态，不是真实形态）。
 *
 * ⚠️ 诚实边界：只到**代码路径级**。真实宿主会话里 `header.origin` / `parentSession` 的
 *    实际形态**未在真实运行态验证过**（本轮没有起真会话）。未取证的那一格（第 2 档末）
 *    沿用修前读数 Lead —— fail-open 的残留面如实记在 `docs/设计债-2026-10-09.md` ⑳。
 * @param {any} exec
 */
function agentSubject(exec) {
  if (!exec || typeof exec !== 'object') return subjectFor({});
  const session = exec?.agent?.session;
  const 会话id = session?.id;
  const header = session?.header;
  // 第 1 档：子会话事实（同一份事实源，见上）。
  if (header?.origin === 'subagent' || (Number.isInteger(header?.delegationDepth) && header.delegationDepth >= 1)) {
    return subjectFor({ 根会话: false, 实例: 会话实例键(会话id) ?? 'member-unknown' });
  }
  // 第 2 档：不是子会话 ⇒ 根会话 = Lead（既有语义原样）。
  return subjectFor({ 根会话: true, 实例: 会话实例键(会话id) ?? 'lead' });
}

/**
 * 会话实例键：**会话 id 原样 —— 不截断、不加前缀、不换父会话**（B 修 · 2026-10-10）。
 *
 * 修前是 `'session-' + String(键).slice(0, 8)`（`键` = 父会话 ?? 自己的会话 id）。
 * 它坏在一个**没被核实的前提**上：假设会话 id 是短的无前缀串。真实形状不是——
 * 实测（本机 `E:\DSHOME\sessions\` 下 460 个会话目录里 **208 个**形如 `session-<uuid>`，
 * 例如本任务 Lead 的会话 id `session-7fb7087b-c62a-4c64-a6ce-40aab0a78cd9`）
 * ⇒ `slice(0, 8)` **恰好等于** `'session-'` ⇒ 实例键**恒为 `session-session-`**：
 * 审计 / 注册表 / 独立答案里「**哪一个会话**」这一位信息全丢。实测读数见
 * `test/lead-identity.test.js` 的 B 判据（两个不同真实 id 都印出来了）。
 *
 * 为什么这个形状**唯一**（三层论证，都不靠"看起来够长"这种直觉）：
 *  1. **按契约唯一**：`SessionId` 的定义就是「Identifies one session in the store (and its
 *     persistence artifacts)」（`@deepseek-ai/dsh-session` lib/types/types.d.ts:4-5）
 *     ⇒ 它是会话在 store 里的**主键**：唯一性由身份定义保证，不由长度保证。
 *  2. **同一会话稳定**：`Session.id` 是 getter，派生自 header 的**唯一一份**拷贝
 *     （同包 lib/types/index.d.ts:120-121 "The session identity, derived from its durable
 *     header's single copy"）⇒ 同一会话的两次调用必得同一个键。
 *  3. **不截断 ⇒ 不引入碰撞**：任何截断都是把一个唯一键映射到更小的空间上
 *     （`slice(0, 8)` 就是这个错误的极端形态）。取原样则碰撞面 = 会话 id 本身的碰撞面。
 *
 * 为什么不加 `session-` 前缀：真实 id 大多**已经**带它（208/460 实测），再加一层就是修前
 * 那种「前缀被自己吃掉」的重复；而 `dsh-agent-loop` 另有一条
 * `` `${id}-session-${randomUUID()}` `` 的生成式（lib/index.js:1540）⇒ 会话 id **不保证**
 * 以 `session-` 开头。**对 id 的形状不做任何假设**，是这一版唯一稳妥的写法。
 *
 * ⚠️ **语义变更（如实登记，不是顺手改）**：第 1 档（子会话）修前取**父会话**当实例键
 * （旧注释的理由是「哪个 Lead 起的比会话 id 更稳定」）。那与「实例键 = 哪一个**会话**」
 * 的用途相冲：同一个 Lead 起的两个成员子会话算出**同一个**主体 id ⇒ 「独立答案按主体 id
 * 去重」会把两个人的卷折成一份，注册表也无法把实例登记到具体某个成员
 * （而 A 的修法正需要 `members[<子会话id>]` 这个键）。B 的任务面写的是「唯一标识**会话**」，
 * 故两档统一取**自己的**会话 id。影响面清点见 `docs/设计债-2026-10-09.md` ㉒。
 *
 * @param {unknown} 会话id `exec.agent.session.id`
 * @returns {string|null} 键；取不到给 null，由调用方各自兜底（`'lead'` / `'member-unknown'`）
 */
function 会话实例键(会话id) {
  return typeof 会话id === 'string' && 会话id.trim() ? 会话id : null;
}

/** 把工具入参里的逗号串与 JSON 串规整成动作表要的形状。 */
function normalizeArgs(args) {  const out = { ...args };
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
  if (typeof out.结论集 === 'string') {
    try {
      out.结论集 = JSON.parse(out.结论集);
    } catch {
      out.结论集 = [];
    }
  }
  return out;
}
