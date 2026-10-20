import { Denied } from './kernel/errors.js';

/** 当前目标检查只是一道附加限制，不授予任务或宿主权限。 */
export function assertGoalAllowsAdvance(goal) {
  if (!goal || goal.状态 === '进行中') return;
  throw new Denied('目标 · 当前状态不允许新增推进', `目标 ${goal.目标} 当前为${goal.状态}（修订 ${goal.修订}），不能派发、开工、创建执行实例或新后继；原任务判据与已发生事实保留。`, {
    howToChange: goal.状态 === '等待' ? '先核对等待条件，合法条件满足后更新目标下一步。' : '暂停需由人侧明确恢复；完成或取消后的新工作另建目标。',
    detail: { 目标: goal.目标, 修订: goal.修订, 状态: goal.状态 },
  });
}
