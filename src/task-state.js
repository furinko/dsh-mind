/** 任务授权的终态集合；终止不等于采纳或宿主执行停止。 */
export const TASK_TERMINAL_STATES = Object.freeze(['已采纳', '已结账', '已终止']);

/** 正式恢复领域拥有的派生字段；普通建节点入口不能自报这些事实。 */
export const TASK_RECOVERY_RELATION_FIELDS = Object.freeze([
  '前序任务', '后继任务', '源快照摘要', '规范摘要', '后继规范摘要', '后继原因', '终止源快照摘要',
  '继承打回次数', '本节点打回次数', '接续提醒',
]);

/**
 * 判断组织任务是否已结束授权寿命；不判断采纳资格或在途执行。
 * @param {object|string|null|undefined} node 节点投影或精确状态
 * @returns {boolean} 只认已知终态
 */
export function isTaskTerminal(node) {
  return TASK_TERMINAL_STATES.includes(typeof node === 'string' ? node : node?.状态);
}
