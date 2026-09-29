// lib/upstream.js — 上游（@deepseek-ai/*）导出的「运行时可选获取」层。
//
// ── 为什么需要 ────────────────────────────────────────────────────────────────
//   顶层具名导入是 ESM 的**链接期**错误：
//       import { createUserMessage } from '@deepseek-ai/dsh-llm';
//   上游一旦改名/移除该导出，模块在**任何代码求值之前**就抛错 ⇒ 插件里 apply() 外层的
//   try/catch **一行都执行不到**（模块根本没加载成功）⇒ 整个插件树加载失败 ⇒ 界面起不来。
//
//   本层把「静态具名导入」换成「动态 import + 兜住」：拿不到就返回 null，
//   由调用方降级并留可见标记，**绝不把异常抛回模块加载期**。
//
// ── 对可移植性的意义 ──────────────────────────────────────────────────────────
//   本插件要能装在**多个 dsh 版本**上。实测：`@deepseek-ai/dsh-settings` 的
//   `settingsNamespace` 在 0.1.5-rc.2 与 0.2.0-rc.1 **都不导出**（顶层只有
//   SettingsConflictError / SettingsForms / default / redactSecrets）。
//   本层保证那只是"降级"，不是"崩树"。
//
// ── 边界（诚实标注）──────────────────────────────────────────────────────────
//   本层**只治"导出消失/改名"**。治不了：服务名、槽位名、hook 签名被改
//   —— 那些是运行时行为契约，需要各插件自行探测。

/** 取用失败清单（空 = 全部就位）。供诊断消费。 */
const failures = [];

/** 动态取一个**函数型**导出；导入失败或类型不符 → null（并记账）。 */
async function optionalFn(spec, exportName) {
  try {
    const mod = await import(spec);
    const value = mod?.[exportName];
    if (typeof value === 'function') return value;
    failures.push(`${spec}#${exportName} 不是函数（得到 ${typeof value}）`);
    return null;
  } catch (e) {
    failures.push(`${spec} 导入失败：${e?.message ?? e}`);
    return null;
  }
}

/** 构造一条 user 消息（官方 dsh-llm）。R0/R1/Skill 卡注入都用它。 */
export const createUserMessage = await optionalFn('@deepseek-ai/dsh-llm', 'createUserMessage');

/** 取用失败清单（只读）。 */
export const upstreamFailures = failures;

/** 一句话摘要，便于写 marker / 打日志。 */
export function upstreamSummary() {
  return failures.length === 0 ? 'upstream ok' : `upstream degraded: ${failures.join('; ')}`;
}
