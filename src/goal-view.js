/** 有界目标摘要；任务进展从当前任务真源重算，摘要不反写成第二份事实。 */
import { 已被合法采纳 } from './tasks.js';
import { BUDGET_COVERAGE } from './goal-budget.js';

const excerpt = (text, limit) => {
  const value = String(text ?? '');
  return { 文本: value.slice(0, limit), 省略: value.length > limit };
};

export function projectGoalSnapshot(goals, snapshot, nodes, limit = 10, budgets = null) {
  const all = snapshot.目标;
  const selected = all.slice(-limit).reverse();
  const byGoal = new Map(selected.map(goal => [goal.id, []]));
  for (const task of nodes) {
    const current = goals.constraintsForTask(task, nodes, snapshot.项目);
    if (current && byGoal.has(current.目标)) byGoal.get(current.目标).push(task);
  }
  return {
    健康: '可用', 总数: all.length, hasMore: all.length > selected.length, 摘要: true,
    目标: selected.map(goal => {
      const linked = byGoal.get(goal.id);
      let budget;
      try {
        const state = budgets?.getBudgetSync(goal.id, { 项目: snapshot.项目 });
        budget = { 健康: budgets ? '可用' : '未接入', ...(state ?? { 配置: null, 上限: null, 累计准入: null, 已结算: null, 未决占用: null, 可准入: null }), 覆盖口径: BUDGET_COVERAGE, token: null, 费用: null };
      } catch { budget = { 健康: '不可用', 配置: null, 上限: null, 累计准入: null, 已结算: null, 未决占用: null, 可准入: null, token: null, 费用: null }; }
      return {
        id: goal.id, 修订: goal.修订, 状态: goal.状态,
        期望结果: excerpt(goal.期望结果, 160),
        下一步: excerpt(goal.下一步, 200), 等待原因: excerpt(goal.等待原因, 200),
        禁止工具: [...goal.禁止工具], 文本约束条数: goal.约束.length,
        来源声明: goal.来源声明,
        任务进展: { 关联: linked.length, 合法采纳: linked.filter(已被合法采纳).length },
        预算: budget,
        详情指引: `goal_query id=${goal.id}；摘要不含完整约束和完成依据。`,
      };
    }),
  };
}
