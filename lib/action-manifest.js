/**
 * 动作登记表 —— 动作面的**唯一声明源**。
 *
 * 修前动作面由三张手写清单叠出来：只读清单、工具面清单、命令面专属清单，
 * 再加一张「命令面专属拒绝文案」表。四张表描述的是同一批动作，靠
 * test/presence*.test.js 逐项比对维持一致。问题是它们是同一事实的四种投影，
 * 拆开写就必然各写一遍，迟早漂一处——而漂的方向恰好是一侧放行、一侧拒，
 * 那是真实的越权面，不是一个文档瑕疵。
 *
 * 现在一张表，每条动作一行，字段即判据：
 *
 *   id     动作名。工具 schema 的 enum、`/mind` 命令解析、审计行都用它。
 *   scope  'tool'    = 模型可达（工具面 ∪ 命令面）
 *          'command' = 仅人侧可达（模型没有这只手）
 *   readonly  true = 只读。可并发执行；Lead 钉版闸对诊断读不要求钉版摘要。
 *            缺省即写（fail-closed：新增动作不显式标只读，一律按写守）。
 *   domain 归属域。只为人读与后续按域拆分工具面用，**不参与运行时判定**。
 *   modelFacingRejection 仅命令面动作带：模型误调时的拒绝理由与改法。
 *
 * **表的顺序就是工具 schema enum 的顺序**（`ACTIONS.join(', ')` 会原样出现在工具描述里）。
 * 不要为了排版好看把动作挪到「同域」旁边——那会改变模型看到的清单顺序。
 * 想按域看，看 domain 字段。
 *
 * 派生（见 lib/actions.js）：
 *   ACTIONS               = scope==='tool' 的 id，保序
 *   COMMAND_ONLY_ACTIONS  = scope==='command' 的 id，保序
 *   COMMAND_ACTIONS       = 全部 id（工具面 ∪ 命令面专属）
 *   READ_ONLY_ACTIONS     = readonly 的 id
 *
 * 新增一个动作 = 这里加一行 + lib/actions.js 的 HANDLERS 加一个实现。两处，不再有四张表。
 */
export const ACTION_MANIFEST = Object.freeze([
  { id: 'monitor_query', scope: 'tool', readonly: true, domain: '诊断' },
  { id: 'monitor_followup', scope: 'tool', domain: '诊断' },
  { id: 'monitor_feedback', scope: 'tool', domain: '诊断' },
  { id: 'status', scope: 'tool', readonly: true, domain: '诊断' },
  { id: 'workbench', scope: 'tool', readonly: true, domain: '诊断' },
  { id: 'policy_check', scope: 'tool', readonly: true, domain: '诊断' },
  { id: 'goal_create', scope: 'tool', domain: '目标' },
  { id: 'goal_query', scope: 'tool', readonly: true, domain: '目标' },
  { id: 'goal_revise', scope: 'tool', domain: '目标' },
  { id: 'goal_progress', scope: 'tool', domain: '目标' },
  { id: 'goal_complete', scope: 'tool', domain: '目标' },
  { id: 'goal_link_task', scope: 'tool', domain: '目标' },
  { id: 'budget_query', scope: 'tool', readonly: true, domain: '目标' },
  { id: 'usage_query', scope: 'tool', readonly: true, domain: '目标' },
  { id: 'operation_query', scope: 'tool', readonly: true, domain: '调度' },
  { id: 'knowledge_reuse_query', scope: 'tool', readonly: true, domain: '记忆' },
  { id: 'task_create', scope: 'tool', domain: '任务' },
  { id: 'task_reassign', scope: 'tool', domain: '任务' },
  { id: 'task_close', scope: 'tool', domain: '任务' },
  { id: 'task_successor', scope: 'tool', domain: '任务' },
  { id: 'task_dispatch', scope: 'tool', domain: '任务' },
  { id: 'task_bind', scope: 'tool', domain: '任务' },
  { id: 'task_attach', scope: 'tool', domain: '任务' },
  { id: 'task_start', scope: 'tool', domain: '任务' },
  { id: 'task_submit', scope: 'tool', domain: '任务' },
  { id: 'task_review', scope: 'tool', domain: '复核' },
  { id: 'task_accept', scope: 'tool', domain: '复核' },
  { id: 'task_disagree', scope: 'tool', domain: '复核' },
  { id: 'task_criteria', scope: 'tool', readonly: true, domain: '复核' },
  { id: 'task_pending', scope: 'tool', domain: '任务' },
  { id: 'task_resolve', scope: 'tool', domain: '任务' },
  { id: 'task_settle', scope: 'tool', domain: '任务' },
  { id: 'task_scope_grant', scope: 'tool', domain: '任务' },
  { id: 'review_exempt', scope: 'tool', domain: '复核' },
  { id: 'review_experiment_allow', scope: 'tool', domain: '复核' },
  { id: 'review_experiment_run', scope: 'tool', domain: '复核' },
  { id: 'review_experiment_read', scope: 'tool', readonly: true, domain: '复核' },
  { id: 'memory_write', scope: 'tool', domain: '记忆' },
  { id: 'memory_use_query', scope: 'tool', readonly: true, domain: '记忆' },
  { id: 'information_query', scope: 'tool', readonly: true, domain: '信息' },
  { id: 'information_read', scope: 'tool', readonly: true, domain: '信息' },
  { id: 'information_update', scope: 'tool', domain: '信息' },
  { id: 'lead_space_query', scope: 'tool', readonly: true, domain: 'Lead' },
  { id: 'lead_space_update', scope: 'tool', domain: 'Lead' },
  { id: 'lead_affect_query', scope: 'tool', readonly: true, domain: 'Lead' },
  { id: 'lead_affect_update', scope: 'tool', domain: 'Lead' },
  { id: 'lead_desire_query', scope: 'tool', readonly: true, domain: 'Lead' },
  { id: 'lead_desire_update', scope: 'tool', domain: 'Lead' },
  { id: 'memory_query', scope: 'tool', readonly: true, domain: '记忆' },
  { id: 'turn_buffer_query', scope: 'tool', readonly: true, domain: '记忆' },
  { id: 'turn_experience_retain', scope: 'tool', domain: '记忆' },
  { id: 'project_brief_query', scope: 'tool', readonly: true, domain: '记忆' },
  { id: 'memory_lineage', scope: 'tool', readonly: true, domain: '记忆' },
  { id: 'memory_lifecycle', scope: 'tool', domain: '记忆' },
  { id: 'memory_organize', scope: 'tool', domain: '记忆' },
  { id: 'turn_summary', scope: 'tool', domain: '记忆' },
  { id: 'task_reconcile', scope: 'tool', domain: '任务' },
  { id: 'task_organize', scope: 'tool', domain: '任务' },
  { id: 'capability_list', scope: 'tool', readonly: true, domain: '能力' },
  { id: 'capability_resolve', scope: 'tool', readonly: true, domain: '能力' },
  { id: 'capability_read', scope: 'tool', readonly: true, domain: '能力' },
  { id: 'capability_publish', scope: 'tool', domain: '能力' },
  { id: 'bus_send', scope: 'tool', domain: '总线' },
  { id: 'bus_read', scope: 'tool', readonly: true, domain: '总线' },
  { id: 'bus_deliver', scope: 'tool', domain: '总线' },
  { id: 'audit_tail', scope: 'tool', readonly: true, domain: '审计' },
  { id: 'audit_verify', scope: 'tool', readonly: true, domain: '审计' },
  { id: 'audit_correct', scope: 'tool', domain: '审计' },
  { id: 'store_rollback', scope: 'tool', domain: '审计' },
  { id: 'registry_list', scope: 'tool', readonly: true, domain: '注册' },
  { id: 'registry_can', scope: 'tool', readonly: true, domain: '注册' },
  { id: 'registry_assign', scope: 'tool', domain: '注册' },
  { id: 'registry_seal', scope: 'tool', domain: '注册' },
  { id: 'registry_revoke', scope: 'tool', domain: '注册' },
  { id: 'upgrade_pending', scope: 'tool', readonly: true, domain: '注册' },
  { id: 'review_zero', scope: 'tool', domain: '复核' },
  { id: 'debate_open', scope: 'tool', domain: '会审' },
  { id: 'debate_answer', scope: 'tool', domain: '会审' },
  { id: 'debate_unlock', scope: 'tool', domain: '会审' },
  { id: 'debate_say', scope: 'tool', domain: '会审' },
  { id: 'debate_round', scope: 'tool', domain: '会审' },
  { id: 'debate_converge', scope: 'tool', domain: '会审' },
  { id: 'delegation_status', scope: 'tool', readonly: true, domain: '调度' },
  { id: 'policy_reload', scope: 'tool', domain: '诊断' },
  { id: 'member_spawn', scope: 'tool', domain: '成员' },
  { id: 'member_message', scope: 'tool', domain: '成员' },
  { id: 'member_stop', scope: 'tool', domain: '成员' },
  { id: 'member_list', scope: 'tool', readonly: true, domain: '成员' },

  // ── 命令面专属：只有人能敲，模型没有这只手 ────────────────────────────
  {
    id: 'presence',
    scope: 'command',
    domain: '设置',
    modelFacingRejection: {
      理由: '宪章 三权（§4）：改设置的入口只给人',
      howToChange: '由人敲 /mind presence 开关=是|否 小时=<≥1 的整数> 介入度=放权|预审|审批 复核免审=是|否（不带参数则是只读的当前读数）。',
    },
  },
  {
    id: 'sovereign_interaction',
    scope: 'command',
    domain: '设置',
    modelFacingRejection: {
      理由: '宪章 失联判定（§4）：主权者在线的事实只能由人声明',
      howToChange: '由人敲 /mind sovereign_interaction（模型没有这只手：失联判定的事实源不许模型自写）。',
    },
  },
  {
    id: 'intervention_resolve',
    scope: 'command',
    domain: '设置',
    modelFacingRejection: {
      理由: '宪章 三权（§4）：逐请求放行只给主权者本人（人侧入口）',
      howToChange: '由人敲 /mind intervention_resolve 请求id=<介入请求id> 决定=批准|拒绝|撤销（完整内容与步骤预览在设置页「待审批」）。',
    },
  },
  {
    id: 'goal_decide',
    scope: 'command',
    domain: '目标',
    modelFacingRejection: {
      理由: '持久目标 · 用户目标与暂停/取消/恢复决定只认人侧入口',
      howToChange: '由人敲 /mind goal_decide id=<目标id> 修订=<当前修订> 状态=暂停|取消|进行中，或用JSON给出用户要修改的期望结果/完成依据。',
    },
  },
  {
    id: 'budget_decide',
    scope: 'command',
    domain: '目标',
    modelFacingRejection: {
      理由: '目标预算 · 受管准入上限只能由人侧配置',
      howToChange: '由人敲 /mind budget_decide id=<目标id> 预算修订=<首次0或当前修订> 上限=<非负整数>；单位固定为一次受管准入尝试，不代表token或费用预算。',
    },
  },
  {
    id: 'turn_buffer_forget',
    scope: 'command',
    domain: '记忆',
    modelFacingRejection: {
      理由: '私人会话缓冲由当前会话的人清空',
      howToChange: '在当前会话执行 /mind turn_buffer_forget；不会删除宿主原始对话或正式长期记忆。',
    },
  },
  {
    id: 'turn_archive_maintain',
    scope: 'command',
    domain: '记忆',
    modelFacingRejection: {
      理由: '旧格式迁移和回退属于维护操作，不能由普通模型工作顺带执行',
      howToChange: '维护窗口内执行 /mind turn_archive_maintain op=maintain|migrate|rollback；仅本会话Mind副本，回退拒绝覆盖新写入。',
    },
  },
  {
    id: 'project_brief_forget',
    scope: 'command',
    domain: '记忆',
    modelFacingRejection: {
      理由: '项目工作摘要由当前会话的人清空',
      howToChange: '在当前会话执行 /mind project_brief_forget；保留旧来源处理屏障，不删除宿主对话或正式长期记忆。',
    },
  },
  {
    id: 'review_experiment_cleanup',
    scope: 'command',
    domain: '复核',
    modelFacingRejection: {
      理由: '实验残留清理属于维护操作，需要真实退出与归属证明',
      howToChange: '在维护窗口内由人敲 /mind review_experiment_cleanup；缺少原实体或所有权证据时会拒绝，不做猜测性清理。',
    },
  },
]);

/** 工具面动作名（顺序即 `mind` 工具 schema enum 的顺序）。 */
export const TOOL_ACTION_IDS = Object.freeze(
  ACTION_MANIFEST.filter((entry) => entry.scope === 'tool').map((entry) => entry.id),
);

/** 命令面专属动作名（只有 `/mind` 认，模型面够不着）。 */
export const COMMAND_ONLY_ACTION_IDS = Object.freeze(
  ACTION_MANIFEST.filter((entry) => entry.scope === 'command').map((entry) => entry.id),
);

/** 只读动作名（可并发 + 诊断读免钉版）。缺省即写，见文件头。 */
export const READ_ONLY_ACTION_IDS = Object.freeze(
  ACTION_MANIFEST.filter((entry) => entry.readonly === true).map((entry) => entry.id),
);

/** 命令面专属拒绝文案：id → {理由, howToChange}。 */
export const MODEL_FACING_REJECTIONS = Object.freeze(
  Object.fromEntries(
    ACTION_MANIFEST.filter((entry) => entry.modelFacingRejection).map((entry) => [entry.id, entry.modelFacingRejection]),
  ),
);
