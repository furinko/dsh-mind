/** 创建前必须留意图；后续观察写失败不撤销已发生业务，也不触发盲目补偿。 */
import { canonical, digest } from '../src/kernel/text.js';
import { Fault } from '../src/kernel/errors.js';
import { SPAWN_OPERATION_ISSUE_CODES } from '../src/spawn-operations.js';

export function existingSpawnOperation(record, project) {
  return new Fault('MEMBER_SPAWN_OPERATION_EXISTS', `任务 ${record.任务} 已有成员创建操作 ${record.操作id}；先用 operation_query 核对，不能重复创建。`, {
    outcome: { 提交状态: record.状态 === 'audited' ? '已提交' : record.状态 === 'intent' ? '未知' : '部分提交', 可重试: false,
      恢复指引: `operation_query id=${record.操作id} project=${project} 查询原意图及历史阶段，再核对任务和宿主目录。拟用实例不等于已创建；不要重复 member_spawn。`,
      已确认阶段: [{ 阶段: '已有成员创建意图；不签发新执行权', 项目: project, 任务: record.任务, 操作id: record.操作id,
        ...(record.拟用实例 ? { 拟用实例: record.拟用实例 } : {}) }] },
  });
}

/** 只读准备：旧意图先于任务状态和新审批诊断，读权仍来自当前主体。 */
export async function assertNoSpawnOperation({ org, project, subject, task }) {
  if (!org.spawnOperations) return; // 旧的纯计划夹具；真实 Org 恒装配此服务。
  const existing = org.spawnOperations.findByTask(project, task);
  if (!existing) return;
  const view = await org.spawnOperations.query({ subject, 项目: project, id: existing.操作id, 条数: 1 });
  const readable = view.操作页.条目[0];
  if (!readable) throw new Fault('MEMBER_SPAWN_OPERATION_UNREADABLE', '已有创建意图无法取得当前可读回执，不能猜测未创建。');
  throw existingSpawnOperation(readable, project);
}

export function createMemberSpawnJournal({ org, project, subject, plan }) {
  let intent = null; let broken = false; let completed = false;
  const warn = () => { try { org.logger?.warn?.('[dsh-mind] 成员创建阶段记账不完整；原业务事实保留，按操作id核对，不重复创建或自动释放。'); } catch { /* 诊断不能干扰已发生业务。 */ } };
  return {
    async begin() {
      if (!org.spawnOperations) throw new Fault('MEMBER_SPAWN_OPERATION_NOT_WIRED', '成员创建意图账未装配，不能在无恢复凭据的情况下创建宿主。');
      const receipt = await org.spawnOperations.begin({ subject, 项目: project, 任务: plan.入参.节点, 方式: plan.入参.方式,
        请求摘要: digest(canonical({ 入参: plan.入参, 模型路由: plan.模型路由 ?? null })) });
      if (receipt.可创建 !== true) throw existingSpawnOperation(receipt, project);
      intent = receipt;
      return receipt;
    },
    async record(stage, receipt) {
      if (!intent || broken) return;
      try {
        await org.spawnOperations.record({ 项目: project, 操作id: intent.操作id, 阶段: stage, 回执: receipt });
        if (stage === 'audited') completed = true;
      } catch { broken = true; warn(); }
    },
    async failure(cause, confirmed = []) {
      if (!intent) return cause;
      const wrap = () => new Fault(cause.code ?? 'MEMBER_SPAWN_INCOMPLETE', cause.message ?? '成员创建未完整收尾。', {
        cause, detail: cause.detail,
        outcome: { 提交状态: cause.outcome?.提交状态 ?? '未知', 可重试: false,
          恢复指引: `operation_query id=${intent.操作id} project=${project} 核对持久意图及阶段。历史阶段可能落后业务事实，同时核对本次确认回执与任务真源。${broken ? '阶段记账需核对。' : ''}${cause.outcome?.恢复指引 ?? '宿主结果不可判，勿盲重建。'}`,
          已确认阶段: [{ 阶段: '成员创建意图已记录', 项目: project, 操作id: intent.操作id, 任务: plan.入参.节点,
            ...(intent.拟用实例 ? { 拟用实例: intent.拟用实例 } : {}) }, ...confirmed, ...(cause.outcome?.已确认阶段 ?? [])] },
      });
      const safe = wrap();
      try { await org.spawnOperations.recordIssue({ 项目: project, 操作id: intent.操作id, 故障码: SPAWN_OPERATION_ISSUE_CODES.includes(safe.code) ? safe.code : 'MEMBER_SPAWN_FAILED', 已确认阶段: safe.outcome.已确认阶段 }); }
      catch { broken = true; warn(); }
      return wrap();
    },
    receipt() { return intent ? { 操作id: intent.操作id, 拟用实例: intent.拟用实例, 记账: completed && !broken ? '已收尾' : '需核对', 成员执行: null } : null; },
  };
}
