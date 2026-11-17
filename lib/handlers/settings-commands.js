// 设置/命令面实现 —— 2026-11-17 从 handlers/index.js 按域拆出。
// 依赖沿用同一组命名导入（全量）；后续可按实际使用面收窄。
import { Denied, Fault, InvalidBody, NeedsApproval } from '../../src/kernel/errors.js';
import { canonical } from '../../src/kernel/text.js';
import { normalizeContinuity } from '../../src/lead-continuity.js';
import { AUTHORITIES } from '../../src/tags.js';
import { normalizeCollaborationFeedback } from '../../src/collaboration-feedback.js';
import { atomicWrite, readTextOrNull, stripBom, withLock } from '../../src/kernel/fsx.js';
import { MAX_RESPONSE_DEADLINE_HOURS } from '../../src/kernel/time.js';
import { MEMORY_KINDS, 线程等价键 } from '../../src/paths.js';
import { 全员已交, 负责人实例名单 } from '../../src/tasks.js';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { 审计尾默认条数 } from '../../src/audit.js';
import { DEBATE_SAY_TYPES, COUNCIL_THREAD_PREFIX } from '../../src/council.js';
import { 盲标分配 } from '../../src/review.js';
import { 钉版主体 } from '../../src/subject.js';
import { 取复核读域, 在读域, 审计行在读域, 线程在读域, 复核对象引用 } from '../../src/review-scope.js';
import { 以放行上下文, 记录本次新建 } from '../../src/intervention.js';
import { 介入计划Of, 计划会挂起 } from '../approval-plan.js';
import { assertMemberSpawnPlan, runMemberSpawnStages, memberSpawnBudgetReceipt, recheckMemberSpawnPlan } from '../member-spawn-plan.js';
import { createMemberSpawnJournal } from '../member-spawn-journal.js';
import { INTERVENTION } from '../../src/policy.js';
import { messageExistingMember, listExistingMembers, stopExistingMember } from '../member-maintenance.js';
import { TASK_RECOVERY_RELATION_FIELDS } from '../../src/task-state.js';
import { readInstanceSnapshot } from '../../src/instance-snapshot.js';
import { matchingBinding } from '../../src/tool-file-scope.js';
import { normalizeKnowledgeContext } from '../../src/knowledge-applicability.js';
import { normalizeFeedbackReference } from '../../src/knowledge-feedback.js';
import { assertExecutionHost, prepareExecution, releaseExecution, sendExecutionMessage, requireDelegation, parseModelRoute } from '../host-execution.js';
import { leadAffectExecution } from '../../components/kernel/lib/lead-affect.js';
import { readTaskRecords } from '../../src/task-records.js';
import { ACTION_MANIFEST, TOOL_ACTION_IDS, COMMAND_ONLY_ACTION_IDS, READ_ONLY_ACTION_IDS, MODEL_FACING_REJECTIONS } from '../action-manifest.js';
import { capabilityHandlers } from './capability.js';
import { busHandlers } from './bus.js';
import { debateHandlers } from './debate.js';
import { auditHandlers } from './audit-actions.js';
import { registryHandlers } from './registry.js';
import { goalHandlers } from './goals.js';
import { taskHandlers } from './tasks.js';
import { memberHandlers } from './members.js';
import { 记动作拦截, 实例活动索引, 实例活动读数, 未登记敲门者, informationScope, requireExperiments, READ_ONLY_SET, 命令面专属文案, 拒讨论线程直灌, 成员可达节点, 规范读根, 断言记忆写入参数, reviewReadProof, 复核读域For, 取任务上下文, 盲评遮罩, 要求授权, 解析模型路由, 断言成员宿主就绪, 停执行体, 补偿归属复判, 登记钉版, 发成员书, 拼钉卡规程, 参数列表, 岗位清单, 断言会审计计划完整, 会审退役适配器, 中止信号, 错误信息, 目标参数, 动作提交凭据, 宿主清理凭据, 规范成员名, 查Team名, 拒他人任务线程, 记设置入账, 设置读数, 设置依据, 解析介入度, 解析复核免审, 解析开关, 解析设置小时, 读部署偏好文件, 会审咨询动作 } from '../actions.js';

export const settingsCommandHandlers = {
  async review_zero({ org, 项目, subject, args }) {
    // 结论集不再收自报（2026-10-13 审查 P1-8）：修前 Lead 递一份假「反例面」就能压掉报警；
    // 现在必须给节点 id，服务层从任务图独立答案重算（与 workbench 投影同一权威源）。
    if (!args.id) throw new InvalidBody('review_zero 需要 id（任务节点 id）：零分歧检查从任务图独立答案重算，不收自报结论集。', { missing: ['id'] });
    return { 检查: await org.review.checkZeroDivergence({ subject, 项目, 节点: args.id }) };
  },

  async sovereign_interaction({ org }) {
    // 来源必带（设计评审 #7 · 2026-10-15）：markInteraction 的来源白名单闸——本动作是
    // 命令面专属（模型没有这只手），来源如实声明为「presence命令」。
    return { 主权者: await org.registry.markInteraction({ 来源: 'presence命令' }) };
  },

  /**
   * `presence`：失联限制的**人用设置入口**（命令面专属；`mind` 工具 schema 里没有它）。
   *
   * 读：不带参数 ⇒ 只回报当前生效读数（沿用 Batch 1.5 在 `policy.presence()` 里做好的字段）。
   * 写：`/mind presence 开关=否 小时=168` ⇒ 私有 `部署.json`（`Layout.deploymentPrefs()`）。
   *
   * 四条不许让步的性质：
   *  1. **merge 写** —— 只覆盖 `失联限制` / `响应期限小时` 两个键，别的键一个不许丢
   *     （整份 replace 会把主权者写在同一个文件里的 介入度 / 安全类 顺手抹掉；
   *      其中 `安全类` 这一格**在运行态当前没有任何消费者**，所以那条属于「别动别人的东西」，
   *      不是「保住了某个行为」—— 别把它当成有行为意义的键去"修"）；
   *  2. **原子写** —— 走 `atomicWrite`（先写同目录临时文件再 rename）；
   *  3. **非法值拒不写** —— `小时` 要 ≥1 的整数且不超过 `MAX_RESPONSE_DEADLINE_HOURS`，
   *     `开关` 要是 是/否；拒绝路径一个字节都不许改；
   *  4. **无条件入账** —— 只要**意图**改设置（含原值与新值相同、无变更可写），就 `audit.append`
   *     一条，主体记**真实主体**（谁敲的命令就是谁，不许冒充主权者）；
   *     落盘之后的**回读**（`reload()` + `presence()`）也在同一个 try 里：那个环节炸了同样要入账
   *     （如实写明盘动没动），不许静默 —— 越界的大整数曾经正是在这里「先写盘、再炸、不入账」。
   */
  async presence({ org, subject, args }) {
    const 路径 = org.layout.deploymentPrefs();
    const 有开关 = args.开关 !== undefined && args.开关 !== null;
    const 有小时 = args.小时 !== undefined && args.小时 !== null;
    const 有介入度 = args.介入度 !== undefined && args.介入度 !== null;
    const 有免审 = args.复核免审 !== undefined && args.复核免审 !== null;
    if (!有开关 && !有小时 && !有介入度 && !有免审) {
      return {
        读数: 设置读数(org),
        设置文件: 路径,
        说明: '读：本次没带任何设置键，没有改任何设置，也没入账（读不是设置入口）。',
      };
    }
    // 人侧入口（v2 条目14/17 · Lead 2026-10-18 修正）：主体由 intervention 内部构造为
    // 主权者本人——命令里自报的身份不参与。模型面没有这只手（命令面专属动作）。
    const 通道 = /设置页/.test(String(args.依据 ?? '')) ? '设置页' : '命令面';
    return await org.intervention.以人侧身份({
      通道,
      执行: async (主权者) => {
        // 人侧入口先记「本人有效交互」：主权者失联时，本人来改设置这件事本身就是解冻事实
        // ——先解冻再判设置闸，否则「失联冻结」会把唯一能恢复它的手冻住（自锁）。
        const 交互 = await org.intervention.记本人交互();
        // 先校验：非法值立刻拒，且一个字节都不写。拒绝也要留痕。
        let 新开关;
        let 新小时;
        let 新介入度;
        let 新免审;
        try {
          新开关 = 有开关 ? 解析开关(args.开关) : undefined;
          新小时 = 有小时 ? 解析设置小时(args.小时) : undefined;
          新介入度 = 有介入度 ? 解析介入度(args.介入度) : undefined;
          新免审 = 有免审 ? 解析复核免审(args.复核免审) : undefined;
        } catch (error) {
          await 记设置入账(org, {
            主体: 主权者,
            路径,
            依据: 设置依据(args.依据, 通道),
            结果: '拒绝（非法值，未写盘）',
            详情: { 拒绝理由: 错误信息(error), 入口: 通道, 收到的: { 开关: args.开关 ?? null, 小时: args.小时 ?? null, 介入度: args.介入度 ?? null, 复核免审: args.复核免审 ?? null } },
          });
          throw error;
        }

        // 设置写照走唯一判定点（没接线的「改设置」曾是预审四类里的假绿）：
        // kind=设置 / 自治档。Owner 因 kind=主权者天然不受介入度（自己不批自己）；
        // 非法模型写照旧 confirm/deny——这个动作本身是命令面专属，模型面到不了。
        await org.policy.check({
          subject: 主权者,
          action: 'write',
          target: { id: '部署设置', kind: '设置', authority: '自治', zone: '私有', project: null },
          context: {},
        });

        // 读-改-写一律在锁内：同一个部署里可能有别的会话也在改这份设置。
        // **写完的回读也在这同一个 try 里** —— 落盘成功但读数炸掉的场合必须留痕、不许静默。
        let 结果;
        let 已写盘 = false;
        let 读数;
        try {
          结果 = await withLock(`${路径}.lock`, async () => {
            const 现有 = await 读部署偏好文件(路径);
            const 下一份 = { ...现有.对象 };
            const 变更 = [];
            const 无变更 = [];
            /** @type {Record<string, {原值: unknown, 新值: unknown, 变更: boolean}>} */
            const 键详情 = {};
            for (const [键, 要写, 新值] of [
              ['失联限制', 有开关, 新开关],
              ['响应期限小时', 有小时, 新小时],
              ['介入度', 有介入度, 新介入度],
              ['复核免审', 有免审, 新免审],
            ]) {
              if (!要写) continue;
              const 有原值 = Object.hasOwn(现有.对象, 键);
              const 变了 = !有原值 || !Object.is(现有.对象[键], 新值);
              键详情[键] = { 原值: 有原值 ? 现有.对象[键] : null, 新值, 变更: 变了 };
              if (变了) 变更.push(键);
              else 无变更.push(键);
              下一份[键] = 新值;
            }
            // 只有真变更才写盘（原值与新值相同 ⇒ 盘上不动，但已经入账）。
            if (变更.length > 0) await atomicWrite(路径, `${JSON.stringify(下一份, null, 2)}\n`);
            return { 变更, 无变更, 键详情 };
          });
          已写盘 = 结果.变更.length > 0;
          // 写完立刻重载：`presence()` / 工作台 / 策略引擎读的就是这一次 reload 之后的值。
          await org.policy.reload();
          读数 = 设置读数(org);
        } catch (error) {
          // 读不懂的文件、写不进去的盘、落盘之后算不出的读数：一律留痕，且如实说明盘动没动。
          const 原因 = 错误信息(error);
          await 记设置入账(org, {
            主体: 主权者,
            路径,
            依据: 设置依据(args.依据, 通道),
            结果: 已写盘 ? `已写盘，但回读失败：${原因}` : `拒绝（未写盘）：${原因}`,
            详情: { 拒绝理由: 原因, 入口: 通道, 写盘: 已写盘 },
          });
          throw error;
        }

        await 记设置入账(org, {
          主体: 主权者,
          路径,
          依据: 设置依据(args.依据, 通道),
          结果: 结果.变更.length > 0 ? `已写 ${结果.变更.join(' / ')}` : '无变更（原值与新值相同，未写盘）',
          详情: { 键: 结果.键详情, 变更: 结果.变更, 无变更: 结果.无变更, 写盘: 结果.变更.length > 0, 入口: 通道 },
        });
        // 本人改设置 = 有效本人交互（已在入口处记；这里只把读数带回）。
        return {
          设置文件: 路径,
          变更: 结果.变更,
          无变更: 结果.无变更,
          读数,
          入口: 通道,
          交互,
          说明: 结果.变更.length > 0
            ? '已改：这是 merge 写，只覆盖本次带来的键，文件里别的键原样保留。'
            : '原值与新值相同：没有需要写盘的东西，但已如实入账。',
        };
      },
    });
  },

  /**
   * 主权者逐请求放行（命令面专属；设置页的「待审批」走同一个域服务）。
   * 决议主体由 `org.intervention.人侧决议` 内部构造，这里的 `subject` 不参与归属。
   */
  async intervention_resolve({ org, args }) {
    const 请求id = String(args.请求id ?? '').trim();
    if (!请求id) throw new InvalidBody('intervention_resolve 需要 请求id（介入请求 id；设置页「待审批」里可复制）。', { missing: ['请求id'] });
    return await org.intervention.人侧决议({
      请求id,
      决定: args.决定,
      理由: args.理由 ?? '',
      通道: '命令面',
      认证: '人/命令面（命令面专属动作，模型没有这只手）',
    });
  },


  // ── Lead 自主调度：宿主执行体的统一治理入口 ──────────────────────────────────
  // 这组动作经内核注入的 宿主 服务束（真实 Agent + agentTeams/subagents）调官方运行时；
  // 准入与提示词共用同一份 DelegationPolicy（配置在 profile 的 dsh-mind-kernel.delegation）。
  // 新建必须经过本次真实 Mind 调用持有的官方工具桥；配置只判 Mind 资格，不替代 Host 准入。
  // 维护已有实例另按归属、任务与宿主目录判定；不因服务存在而认定已获创建许可。

  /** 调度授权读数（只读）：范围、指纹与适配可用性；不把授权存在当成就绪。 */
  async delegation_status({ 项目, 宿主 }) {
    if (!宿主?.delegation) {
      throw new Fault('DELEGATION_NOT_WIRED', '调度策略组件未随内核装载（旧内核或装配降级）。', { howToChange: '重启或修复 dsh-mind 内核组件后重试。' });
    }
    return { 数据: { ...宿主.delegation.status(项目), 适配: { agentTeams: Boolean(宿主.agentTeams), subagents: Boolean(宿主.subagents) } } };
  },

  /**
   * 策略引擎显式重载 + 生效回执（R04 · 审查 2026-10-16 · 判据③）。
   *
   * 为什么要有这只手：decide 的依赖签名比对让「手改规则件/部署介入度」在下一判定自动
   * 生效（判据①）；但**改了到底生效没有**需要一处可对账的显式动作——重载前后各取一次
   * describe()，把规则数、每份规则件的 digest 与加载时刻摆出来，前后不一致就是「确实换了
   * 内容」，一致就是「盘上没变或没读到」。回执里同时给 defaults来源（介入度等键的生效层）。
   *
   * 闸：仅 Lead / 主权者。重载会读盘并可能让引擎转不健康（真坏的规则件 fail-closed），
   * 属机制动作；成员/复核者没有这只手（复核者的只读守卫另有其道：它们连动作面都到不了）。
   */
  async policy_reload({ org, 项目, subject, 重载前 }) {
    if (!['Lead', '主权者'].includes(subject?.kind)) {
      throw new Denied(
        '法律 权限矩阵 · 策略重载仅 Lead / 主权者（R04）',
        `策略引擎重载是机制动作：${subject?.kind ?? '未知'} 没有这只手。`,
        {
          requireAuthority: 'Lead',
          howToChange: '由 Lead（根会话）或主权者执行；改了规则件/部署偏好后，decide 的依赖签名比对会在下一次判定自动生效，通常无需手工重载。',
        },
      );
    }
    const 前 = 重载前 ?? org.policy.describe();
    const 前摘要 = (前.rules ?? []).map((r) => `${r.id}@${r.zone}:${String(r.digest).slice(0, 8)}`);
    const ok = await org.policy.reload();
    const 后 = org.policy.describe();
    const 后摘要 = (后.rules ?? []).map((r) => `${r.id}@${r.zone}:${String(r.digest).slice(0, 8)}`);
    const 变了 = 前摘要.join('|') !== 后摘要.join('|');
    await org.audit?.append?.({
      动作: '策略重载',
      主体: subject,
      对象: { id: '策略引擎', kind: '机制' },
      依据: 'R04（审查 2026-10-16）：显式重载 + 生效回执',
      结果: ok ? (变了 ? '已重载（规则摘要有变化）' : '已重载（规则摘要无变化）') : '重载失败（引擎不健康，判定面 fail-closed）',
      项目,
      详情: { 规则数: { 前: 前摘要.length, 后: 后摘要.length }, 摘要变化: 变了, 健康: 后.healthy, 生效来源: 后.defaults来源 ?? {} },
    });
    return {
      数据: {
        健康: 后.healthy,
        加载于: 后.loadedAt,
        规则数: { 前: 前摘要.length, 后: 后摘要.length },
        摘要: { 前: 前摘要, 后: 后摘要 },
        摘要变化: 变了,
        错误: 后.error ?? null,
        生效来源: 后.defaults来源 ?? {},
      },
      说明: 变了
        ? '重载完成：规则摘要与重载前不同（盘上内容确实换了）。'
        : '重载完成：规则摘要与重载前一致（盘上没变，或改的不是引擎读取的那份——对照 摘要 与 生效来源）。',
    };
  },
};
