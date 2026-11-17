// 记忆写入/整理域实现 —— 2026-11-17 从 handlers/index.js 按域拆出。
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

export const memoryActionHandlers = {
  async memory_write({ org, 项目, 会话项目, subject, args }) {
    if (!MEMORY_KINDS.includes(args.类)) throw new InvalidBody(`记忆只有四类：${MEMORY_KINDS.join(' / ')}`);
    // 不许替调用方编一个来源：§7 要求「写入必带谁记的 + 怎么知道的」，
    // 缺了就拒写（写入侧义务），而不是填个「未说明」让它过关。
    const 来源 = args.来源 ?? (args.依据 ? args.依据 : null);
    if (!来源) throw new InvalidBody('memory_write 需要「来源」：这条你是怎么知道的？', { missing: ['来源'] });
    // v2 条目22 · 公共命名空间（补修E）：『通用』是**存储命名空间**，不是另一个真实项目——
    // 执行项目仍是会话项目，跨项目总闸（runAction 单点）一字不动；命名空间只决定落在哪本账。
    // 这样「通用」不用在成员跨项目闸上开例外，也没把执行项目改写成项目键。
    const 命名空间 = typeof args.命名空间 === 'string' && args.命名空间.trim() ? args.命名空间.trim() : null;
    if (命名空间 !== null && 命名空间 !== '通用') {
      throw new InvalidBody(`未知命名空间：${命名空间}。目前只有「通用」= 项目无关知识的公共命名空间（它不是项目，不参与项目隔离）。`, { detail: { 命名空间 } });
    }
    if (命名空间 && args.类 !== '知识') {
      throw new InvalidBody('「通用」命名空间只收知识：经历属组织账本、偏好属部署账本、作答属实例任务—它们不进公共命名空间。', { detail: { 类: args.类 } });
    }
    // v2 条目22 跨项目写：成员在 runAction 单点已被拦；Lead 可显式传 project 写别的
    // 项目，但「合理」要落在依据上——依据必填，且随条目与审计留痕（事后可判）。
    const 跨项目 = typeof args.project === 'string' && args.project.trim() && args.project.trim() !== 会话项目;
    if (跨项目 && subject.kind === 'Lead' && !(typeof args.依据 === 'string' && args.依据.trim())) {
      throw new InvalidBody('跨项目写记忆必须带「依据」：跨项目的「合理」落在依据上（v2 条目22），事后靠它可判。', { missing: ['依据'] });
    }
    // 公共命名空间不是项目的默认住所：Lead 往里放东西同样要把「凭什么公开」落在依据上。
    if (命名空间 === '通用' && subject.kind === 'Lead' && !(typeof args.依据 === 'string' && args.依据.trim())) {
      throw new InvalidBody('写「通用」公共命名空间必须带「依据」：项目无关知识的「合理」落在依据上（v2 条目22），事后靠它可判。', { missing: ['依据'] });
    }
    const 写入项目 = 命名空间 ?? 项目;
    const 来源引用 = Array.isArray(args.来源引用)
      ? args.来源引用.map((v) => String(v).trim()).filter(Boolean)
      : (args.来源引用 === undefined || args.来源引用 === null ? [] : String(args.来源引用).split(/[,，]/).map((s) => s.trim()).filter(Boolean));

    // 成员写知识 = 受限晋升（v2 条目15/16 · 补修E）：唯一入口是记忆服务的 promoteFromAdopted
    // （真实登记记忆整理岗 + 同项目已采纳来源 + 双标签 + 绑定执行中任务，全部在服务层判）。
    // 普通成员在这里连「直接写」的门都够不着——只能走交卷的知识候选。
    // 复核员不在这里拦：它没有知识写入通道，也不能走受限晋升——直接落到服务层/策略引擎的
    // 「复核员岗 · 只读数，不改」闸上，拒绝理由才归到它真正的岗位边界（不在半路换成「缺晋升参数」）。
    if (subject.kind === '成员' && args.类 === '知识') {
      const 任务 = await 取任务上下文({ org, 项目, args });
      if (!任务) {
        throw new InvalidBody('记忆整理岗晋升知识必须带「任务」：晋升要在你被绑定的执行中任务内（任务内全权、任务外无）。', { missing: ['任务'] });
      }
      const 任务引用 = 来源引用.filter((ref) => ref.startsWith('task-'));
      if (任务引用.length !== 1) {
        throw new InvalidBody(`受限晋升的「来源引用」必须恰好包含 1 个 task- 任务节点（已采纳来源），收到 ${任务引用.length} 个。`, { detail: { 来源引用 } });
      }
      // 候选键 = 同一来源（非任务引用）的蒸馏身份：重试同输入 ⇒ 幂等命中、不重复产知识；
      // 同一来源换了岗位/内容 ⇒ 幂等键冲突被拒（别拿旧产物冒充本次内容）。
      const 候选键 = `refs:${来源引用.filter((ref) => !ref.startsWith('task-')).sort().join(',') || 任务引用[0]}:${args.岗位 ?? ''}`;
      return {
        条目: await org.memory.promoteFromAdopted({
          subject,
          项目: 写入项目,
          岗位: args.岗位,
          内容: args.内容,
          来源,
          来源引用,
          依据: args.依据,
          标签: args.标签,
          ...(Object.hasOwn(args, '知识说明') ? { 知识说明: args.知识说明 } : {}),
          任务,
          晋升: { 来源任务: 任务引用[0], 候选键, 执行任务: 任务.id },
        }),
      };
    }

    return {
      条目: await org.memory[subject.kind === 'Lead' && (args.类 === '偏好' || ['经历', '知识'].includes(args.类) && (!args.岗位 || args.岗位 === 'Lead') && !args.任务 && !来源引用.some(ref => ref.startsWith('task-'))) ? 'rememberPersonal' : 'remember']({
        subject,
        类: args.类,
        内容: args.内容,
        来源,
        项目: 写入项目,
        岗位: args.岗位,
        标签: args.标签,
        ...(Object.hasOwn(args, '知识说明') ? { 知识说明: args.知识说明 } : {}),
        ...(Object.hasOwn(args, '连续性') ? { 连续性: args.连续性 } : {}),
        ...(Object.hasOwn(args, '协作反馈') ? { 协作反馈: args.协作反馈 } : {}),
        依据: 跨项目 || 命名空间 ? args.依据 : undefined,
        // 披露豁免只在「通用」直写有意义（v2 条目22：通用与跨项目晋升同一把披露闸）。
        披露豁免: args.披露豁免 === true,
        // 契约A：来源引用（证据/来源对象 id 列表）——服务层做存在性校验，悬空即拒。
        来源引用,
        // 任务上下文透传（2026-10-12 接口缺口修复）：成员的「任务内全权」由策略引擎
        // scopeOf 按节点负责人名单判定——这里只把调用方声明的节点**从任务图取出**交给
        // 唯一判定点；自报不算数（传别人的节点照拒），取不到 = 响亮拒，不编一个。
        任务: await 取任务上下文({ org, 项目, args }),
      }),
    };
  },

  async memory_query({ org, 项目, subject, args }) {
    // 契约B（2026-10-09）：查询也过唯一判定点。subject 来自 runAction 的主体链
    // （B3：成员/复核者必须与身份档案一致，不许 role 自报即真），不是 args 里另开的自报字段。
    // v2 条目22 读面：成员的跨项目读在 runAction 单点已拦；Lead/主权者跨项目读放行
    // （这里收到的 项目 已是目标项目，runAction 按 args.project 换过）。
    // v2 条目4/6（复核读域）：复核员岗的检索面按「已绑定复核任务→显式复核对象」限定，
    // 读域由本动作按**同一项目**现算，不凭会话 cwd、也不跨项目账本猜。
    const 域 = await 复核读域For({ org, 项目, subject });
    return {
      结果: await org.memory.query({
        subject, 类: args.类, 项目, 岗位: args.岗位, 文本: args.文本,
        显式: args.显式, 含失效: args.含失效, 读者: subject, 读域: 域,
        ...(Object.hasOwn(args, '含待复验') ? { 含待复验: args.含待复验 } : {}),
        id: args.id, 返回模式: args.返回模式 ?? '摘要', 内容预算: args.内容预算,
        偏移: args.偏移, 正文偏移: args.正文偏移, 数据版本: args.数据版本,
        limit: args.limit, 条数上限: args.条数上限,
      }),
    };
  },

  /**
   * 契约A（2026-10-09）·血缘查询：这条记忆的上下游（引用 + 推翻替换链），闭包 ≤3 层。
   * 读面与契约B 同款：subject 过判定，放行记一条「只读服务调用」汇总审计。
   */
  async memory_lineage({ org, subject, args }) {
    if (!args.id) throw new InvalidBody('memory_lineage 需要 id（要查血缘的记忆条目）', { missing: ['id'] });
    return { 血缘: await org.memory.lineage({ subject, id: args.id }) };
  },

  async memory_organize({ org, 项目, subject, args }) {
    const allowed = ['action','project','role','op','id','ids','内容','原因','类'];
    if (Object.keys(args).some(key => !allowed.includes(key))) throw new InvalidBody('记忆整理含未知字段。');
    return { 整理: await org.memory.organize({subject,项目,op:args.op,id:args.id,ids:args.ids,内容:args.内容,原因:args.原因,类:args.类}) };
  },
};
