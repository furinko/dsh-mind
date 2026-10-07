/**
 * 共享工作台（§7「当前状态的唯一视图」）。
 *
 * §14.2 在目录上给它标了 ⚠️：**无存储，纯投影**。
 * 于是本文件只有纯函数、没有 IO——这本身就是「不许当第二事实源」的技术保证：
 * 它在磁盘上没有任何东西可以被别的组件误认成真相。
 *
 * 显示什么，是**从设计推出来的**，不是挑好看的：
 *
 * | 这块 | 依据 |
 * |---|---|
 * | 待你决定 | 待决项是设计里唯一点名「工作台把它投影出来」的东西（§7 存储归属） |
 * | 任务节点 | 投影的两个来源之一（§7：「能从任务图 + 日志重算」） |
 * | 会审 | §10 反趋同：交卷进度 · 独立答案 · 分歧清单 · 反例面 · 零分歧 |
 * | 审计尾 | 投影的另一个来源；它是事实记录，不是讨论 |
 * | 状态条 | 当前状态；但取自**已有记录**，不现场重跑 |
 *
 * 而**不显示**：八件基础设施的计数（那是系统元数据，不是当前状态，且与 `mind status` 重复）、
 * 主干环路 stepper（§8 的环路是**流程定义**，画成常驻进度条永远停在某一格，信息量为零）、
 * 任何讨论内容（§7「不做讨论、不做权威记录」）。
 */
import { judgeZeroDivergence } from './review.js';

/** 任务状态 → 分组计数用的桶。 */
const 进行中 = new Set(['已派发', '执行中']);

/**
 * 投影出一份完整视图。
 *
 * @param {{
 *   项目: string,
 *   节点?: object[],
 *   审计尾?: object[],
 *   成员?: object[],
 *   岗位?: object[],
 *   升级挂起?: object[],
 *   探针?: object,
 *   策略?: object,
 *   线程?: object[],
 *   生成于?: string,
 * }} input
 * @returns {object} 视图；调用方不得把它写回磁盘。
 */
export function projectWorkbench(input) {
  const 节点 = input.节点 ?? [];
  const 待决 = 节点.filter((n) => n.状态 === '待决');
  const 升级 = 节点.filter((n) => n.升级);
  const 探针 = input.探针 ?? { 状态: '未知', 结果: [] };
  const 见红 = (探针.结果 ?? []).filter((r) => r.状态 === '红');

  return {
    项目: input.项目,
    生成于: input.生成于 ?? null,
    边界: { 只读: true, 说明: '工作台是投影：它不存储、不做讨论、不做权威记录。' },

    // 一行状态条：够判断「现在能不能干活」，不需要更多。
    状态条: {
      闸: { 在位: input.策略?.healthy === true, 规则数: (input.策略?.rules ?? []).length, 错误: input.策略?.错误 ?? null },
      介入度: input.策略?.介入度 ?? '未知',
      失联: input.策略?.失联?.lost === true,
      探针: { 状态: 探针.状态 ?? '未知', 见红: 见红.map((r) => r.探针), 恒红: 探针.恒红 === true, 恒绿: 探针.恒绿 === true },
    },

    // 设计里唯一点名要投影的东西，所以排在最前：主子只需要看这一块。
    待你决定: 收集待你决定({ 待决, 升级, 见红, 升级挂起: input.升级挂起 ?? [] }),

    任务: {
      总数: 节点.length,
      计数: {
        待派发: 节点.filter((n) => n.状态 === '待派发').length,
        进行中: 节点.filter((n) => 进行中.has(n.状态)).length,
        已交卷: 节点.filter((n) => n.状态 === '已交卷').length,
        已采纳: 节点.filter((n) => n.状态 === '已采纳').length,
        已打回: 节点.filter((n) => n.状态 === '已打回').length,
        未验: 节点.filter((n) => n.状态 === '未验').length,
        待决: 待决.length,
      },
      节点: 节点.map(任务行),
    },

    会审: 节点.filter((n) => (n.负责人 ?? []).length > 1 || (n.独立答案 ?? []).length > 0).map(会审行),

    审计尾: (input.审计尾 ?? []).map((row) => ({
      时间: row.时间,
      动作: row.动作,
      主体: row.主体?.id ?? row.主体,
      结果: row.结果,
      档位: row.档位,
      告警: row.告警 === true,
    })),
  };
}

/**
 * 成员只读自己任务那片（§7）。
 *
 * 这条不是「少给点信息」的礼貌，而是 §7.5 项目隔离之外的**岗位内隔离**：
 * 一个成员不该看见别人的中间结果，否则独立会审就不是独立的。
 *
 * @param {object} view `projectWorkbench` 的输出
 * @param {{ id: string, kind: string, roleId?: string }} 读者
 * @returns {object}
 */
export function sliceForViewer(view, 读者) {
  if (读者?.kind !== '成员') {
    return { ...view, 视图: 读者?.kind === '复核者' ? '只读全量（复核者需要看到分歧清单）' : '全量' };
  }
  const 我的 = view.任务.节点.filter((n) => [...(n.负责人 ?? []), n.负责人岗位].includes(读者.id) || (n.负责人 ?? []).includes(读者.roleId));
  const 我的id = new Set(我的.map((n) => n.id));
  return {
    ...view,
    任务: { ...view.任务, 节点: 我的 },
    待你决定: view.待你决定.filter((item) => item.节点 && 我的id.has(item.节点)),
    会审: view.会审.filter((a) => 我的id.has(a.节点)),
    审计尾: view.审计尾.filter((row) => row.主体 === 读者.id),
    视图: '只读自己任务那片',
  };
}

/**
 * 「待你决定」：把需要主权者拍板的事聚成一张清单，每项都给出**该敲的命令**。
 *
 * 为什么给命令而不是按钮：§9 三条硬规则之三「工作台只读」。
 * 动作走命令那条路（照旧过策略引擎、入审计），工作台不承担写。
 *
 * @param {{待决: object[], 升级: object[], 见红: object[], 升级挂起: object[]}} parts
 */
function 收集待你决定(parts) {
  const 清单 = [];
  for (const node of parts.待决) {
    清单.push({
      类型: '待决项',
      节点: node.id,
      描述: node.描述,
      原因: node.待决原因 ?? '待定',
      可选项: ['用出厂版', '用我的版'],
      命令: `/mind task_resolve id=${node.id} 决定=用出厂版`,
    });
  }
  for (const node of parts.升级) {
    清单.push({
      类型: '打回升级',
      节点: node.id,
      描述: node.描述,
      原因: `同一节点打回 ${node.打回次数} 次（§8：≥2 次升级主权者）`,
      可选项: [],
      命令: `/mind workbench`,
    });
  }
  for (const 项 of parts.升级挂起) {
    清单.push({
      类型: '升级挂起',
      节点: 项.对象,
      描述: `条款「${项.条款}」两边都改了`,
      原因: '摆 diff 给主权者选（§5）',
      可选项: 项.可选项 ?? ['用出厂版', '用我的版'],
      命令: `/mind-guard resolve id=${项.id} 选择=用我的版`,
    });
  }
  for (const r of parts.见红) {
    清单.push({
      类型: '探针见红',
      节点: null,
      描述: `安全类探针「${r.探针}」见红`,
      原因: r.详情,
      可选项: [],
      命令: '/mind-guard probe',
    });
  }
  return 清单;
}

/** 一个任务节点 → 一行（判据、冻结、打回、产出物、交卷进度）。 */
function 任务行(node) {
  return {
    id: node.id,
    描述: node.描述,
    状态: node.状态,
    负责人: node.负责人 ?? [],
    模式: node.模式 ?? null,
    判据: node.判据 ?? [],
    判据冻结: node.判据冻结 === true,
    依赖: node.依赖 ?? [],
    打回次数: node.打回次数 ?? 0,
    产物: node.产出物引用 ?? [],
    交卷: 交卷进度(node),
    ...(node.升级 ? { 升级: node.升级 } : {}),
    ...(node.待决原因 ? { 待决原因: node.待决原因 } : {}),
  };
}

/**
 * 交卷进度：**应交**看负责人人数，**已交**看有几个人的独立答案。
 * 两者都来自任务图事件流，所以是纯投影（§9 会审解锁就靠这个判据）。
 */
function 交卷进度(node) {
  const 应交 = (node.负责人 ?? []).length;
  const 已交 = (node.独立答案 ?? []).length;
  return { 已交, 应交, 齐: 应交 > 0 && 已交 >= 应交 };
}

/**
 * 一次会审 → 一块。**独立答案按人留**（§10：N 份独立答案 + 分歧清单）。
 *
 * 盲标与揭名：未交齐时只给「成员 A/B/C」；交齐后两者都给。
 * 这条规矩是 §10 的，不是界面的——投影照做，界面照显示。
 */
function 会审行(node) {
  const 进度 = 交卷进度(node);
  const 答案 = (node.独立答案 ?? []).map((a, i) => ({
    盲标: `成员 ${String.fromCharCode(65 + i)}`,
    成员: a.成员,
    结论: a.结论,
    反例面: a.反例面 ?? [],
    产出物引用: a.产出物引用 ?? [],
  }));
  const 判定 = judgeZeroDivergence(答案.map((a) => ({ 成员: a.成员, 结论: a.结论, 反例面: a.反例面 })));
  const 复核 = (node.复核经过 ?? []).at(-1) ?? null;
  return {
    节点: node.id,
    描述: node.描述,
    模式: node.模式 ?? '独立会审',
    揭名: 进度.齐,
    交卷: 进度,
    独立答案: 答案,
    分歧清单: 复核?.分歧清单 ?? [],
    反例面: 复核?.反例面 ?? [],
    零分歧: 判定.零分歧,
    零分歧依据: 判定.依据,
    复核三态: 复核?.三态 ?? null,
    复核者: 复核?.复核者 ?? null,
  };
}
