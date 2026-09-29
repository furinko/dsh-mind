// lib/host/session-budget.js — 会话预算哨兵（上下文长了就提醒换新会话）。
//
// ── 为什么 ────────────────────────────────────────────────────────────────────
//   上下文越长，每次请求越贵。实测：21–50 轮 ≈ 0.017 元/轮，400+ 轮 ≈ 0.031 元/轮。
//   提醒"该换会话了"比闷头聊下去省钱，但**不该打断回合** ⇒ 只在 `turn/end` 评估，
//   提示挂在**下一次** pre-step 的注入里。
//
// ── 两档（有意保守）──────────────────────────────────────────────────────────
//   T1（低水位）：**只有本回合真交付过东西**才提示——否则长会话会被反复打扰。
//   T2（高水位）：不看交付，过线即提示。
//   每会话每档只提示一次，总数上限 3 次。
//
// ── 边界 ──────────────────────────────────────────────────────────────────────
//   取不到 `tokenMeter` ⇒ **不提示**（不假装知道）。绝不打断回合。

import { sessionKey, insertAfterClaimed } from '../insert.js';
import { mark } from '../diag.js';
import { createUserMessage } from '../upstream.js';
import { pluginSource } from '../message-source.js';
import { isConnected } from './connect.js';

export const name = 'dsh-mind-session-budget';
export const inject = ['fs'];

/** 默认水位（token）。可用环境变量覆盖，便于按模型/预算调。 */
const T1 = Number(process.env.DSH_MIND_BUDGET_T1 || 150000);
const T2 = Number(process.env.DSH_MIND_BUDGET_T2 || 300000);
/** 每会话最多提示次数。 */
const MAX_PROMPTS = 3;

/** 本回合是否"交付过东西"（决定 T1 是否触发）。 */
function hadDeliverable(events) {
  return (events || []).some((e) => e?.type === 'tool/result'
    && ['present', 'todo_write'].includes(String(e?.data?.name ?? '')));
}

export function apply(ctx) {
  try {
    /** sessionKey -> { prompts:number, fired:Set<string> }。 */
    const state = new Map();
    /** sessionKey -> 待注入的提示文本（在 turn/end 决定，下一次 pre-step 消费）。 */
    const pending = new Map();

    const meterTotal = () => {
      try {
        const n = ctx.get?.('tokenMeter')?.measure?.()?.totalTokens;
        return typeof n === 'number' ? n : null;
      } catch { return null; }
    };

    mark('session-budget', `apply: registered（T1=${T1} T2=${T2}）`);

    ctx.on('session/event', (payload) => {
      try {
        const ev = payload?.event ?? payload;
        if (ev?.type !== 'turn/end') return;
        const id = ev?.sessionId ?? ev?.session?.id;
        if (!id) return;
        const key = 'session:' + String(id);
        const rec = state.get(key) || { prompts: 0, fired: new Set() };
        if (rec.prompts >= MAX_PROMPTS) return;

        const total = meterTotal();
        if (total === null) return;   // 取不到 ⇒ 不提示（不假装知道）

        let tier = '';
        if (total >= T2) tier = 'T2';
        else if (total >= T1 && hadDeliverable(ev?.data?.events)) tier = 'T1';
        if (!tier || rec.fired.has(tier)) return;

        rec.fired.add(tier);
        rec.prompts += 1;
        state.set(key, rec);
        pending.set(key, `【会话预算】本轮上下文约 ${Math.round(total / 1000)}k token，`
          + `已过 ${tier === 'T2' ? '高' : '低'}水位。\n`
          + '建议：这轮收尾后**开新会话**继续（把结论/待办写进记忆再走，新会话照样接得上）。');
      } catch { /* 评估失败不影响会话 */ }
    });

    ctx.on('session/disposed', (s) => {
      const id = s?.id ?? s?.header?.id;
      if (id) { state.delete('session:' + String(id)); pending.delete('session:' + String(id)); }
    });

    ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
      const decision = await next();
      try {
        if (decision?.kind !== 'enter') return decision;
        const key = sessionKey(agent);
        if (key === null || !createUserMessage) return decision;
        if (!isConnected(agent?.session?.header?.id)) return decision;

        const text = pending.get(key);
        if (!text) return decision;
        pending.delete(key);   // 只提示一次

        // 消息形态是硬契约；`source` 走 pluginSource 按宿主版本自适应（见 message-source.js）
        const msg = createUserMessage({
          content: [{ type: 'text', text }],
          source: pluginSource(name, 'session-budget'),
        });
        if (!msg) return decision;
        const out = insertAfterClaimed(decision, messages, msg);
        if (!Array.isArray(out?.messages) || !out.messages.includes(msg)) return decision;
        mark('session-budget', 'inject: 已提示换会话');
        return out;
      } catch (e) {
        mark('session-budget', `error: ${e?.message ?? e}`);
        return decision;
      }
    });
  } catch (e) {
    mark('session-budget', `apply failed: ${e?.message ?? e}`);
    ctx.logger?.('dsh-mind').warn(`dsh-mind-session-budget: apply 失败（已忽略）：${e?.message ?? e}`);
  }
}
