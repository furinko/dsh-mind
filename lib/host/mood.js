// lib/host/mood.js — 情绪状态（每轮注入一条"当前情绪 + 客观成因"）。
//
// ── 与 R0/R1 的区别 ───────────────────────────────────────────────────────────
//   R0/R1 是**每会话一次**（宪法与记忆不重复注）；本插件是**每轮一次**——
//   情绪是"此刻怎样"，长会话里上下文不变就该变（否则人设是死的）。
//
// ── 只改语气，不改判断 ────────────────────────────────────────────────────────
//   注入的状态行**只影响说话方式**，数字/路径/证据/验证标准一个字都不因情绪变松。
//   这条写进注入文本本身，让模型看到约束。
//
// ── 状态怎么来 ────────────────────────────────────────────────────────────────
//   从会话事件流折叠：工具失败 → 蔫（tail down）；连续成功 → 得意；被纠正 → 炸毛。
//   带**时间衰减**（隔得久了自己回落），所以状态不会永远停在最后一件事上。
//
// ── 边界 ──────────────────────────────────────────────────────────────────────
//   状态存内存 + 投影；取不到事件流 ⇒ 不注入（不编情绪）。

import { sessionKey, insertAfterClaimed } from '../insert.js';
import { mark } from '../diag.js';
import { createUserMessage } from '../upstream.js';
import { isConnected } from './connect.js';

export const name = 'dsh-mind-mood';
export const inject = ['fs'];

/** 情绪档位与尾巴姿态。 */
const LEVELS = {
  proud: { tail: '翘着', label: '得意' },
  ok: { tail: '正常', label: '如常' },
  down: { tail: '垂着', label: '蔫' },
  bristle: { tail: '炸开', label: '炸毛' },
};

/** 衰减：多久之后情绪回落一档（毫秒）。 */
const DECAY_MS = 5 * 60 * 1000;

/** 会话状态：key -> { level, causes:[], at:number }。 */
const state = new Map();

/** 按时间衰减后的有效档位。 */
export function effectiveLevel(rec, now = Date.now()) {
  if (!rec) return 'ok';
  const steps = Math.floor((now - rec.at) / DECAY_MS);
  const order = ['bristle', 'down', 'proud', 'ok'];
  const i = order.indexOf(rec.level);
  if (i < 0) return 'ok';
  return order[Math.min(i + steps, order.length - 1)];
}

/** 记一条成因（去重、只留最近 3 条）。 */
function addCause(rec, text) {
  if (!text) return;
  rec.causes = [text, ...rec.causes.filter((c) => c !== text)].slice(0, 3);
}

/** 渲染状态行。 */
export function renderMood(level, causes) {
  const lv = LEVELS[level] ?? LEVELS.ok;
  const why = causes.length ? `成因：${causes.join('；')}` : '成因：无';
  return `【情绪】${lv.label}（尾巴${lv.tail}）· ${why}\n`
    + '（只改语气，不改判断：数字、路径、证据、验证标准不因情绪变松。）';
}

/** 从事件里抽成因（失败/成功/被纠正）。 */
function causeOf(ev) {
  const t = ev?.type;
  if (t === 'tool/result' && ev.data?.isError === true) return '工具失败';
  if (t === 'turn/end' && ev.data?.reason?.kind === 'error') return '本轮回合出错';
  return '';
}

export function apply(ctx) {
  try {
    mark('mood', 'apply: registered（每轮注入）');
    if (!createUserMessage) mark('mood', 'apply: degraded — createUserMessage 不可用');

    // 从事件流折叠状态（不主动存盘：情绪是短期状态，重启即归零，符合"状态行管此刻"）
    ctx.on('session/event', (payload) => {
      try {
        const ev = payload?.event ?? payload;
        const id = ev?.sessionId ?? ev?.session?.id;
        if (!id) return;
        const key = 'session:' + String(id);
        const rec = state.get(key) || { level: 'ok', causes: [], at: Date.now() };
        const cause = causeOf(ev);
        if (cause) {
          rec.level = cause === '工具失败' ? 'down' : 'bristle';
          addCause(rec, cause);
          rec.at = Date.now();
          state.set(key, rec);
        }
      } catch { /* 折叠失败不影响会话 */ }
    });

    ctx.on('session/disposed', (s) => {
      const id = s?.id ?? s?.header?.id;
      if (id) state.delete('session:' + String(id));
    });

    // 每轮注入（**不用 injector helper**——那是一次性语义）
    ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
      const decision = await next();
      try {
        if (decision?.kind !== 'enter') return decision;
        const key = sessionKey(agent);
        if (key === null || !createUserMessage) return decision;
        if (!isConnected(agent?.session?.header?.id)) return decision;

        const rec = state.get(key);
        const level = effectiveLevel(rec);
        if (level === 'ok' && !rec) return decision;   // 无事发生 ⇒ 不注入（不编情绪）

        // 消息形态是硬契约（缺顶层 source ⇒ 宿主 `message.source.kind` 炸）；见 injector.js 的长注。
        const msg = createUserMessage({
          content: [{ type: 'text', text: renderMood(level, rec?.causes ?? []) }],
          source: { kind: 'plugin', plugin: name, form: 'mood' },
        });
        if (!msg) return decision;
        const out = insertAfterClaimed(decision, messages, msg);
        if (!Array.isArray(out?.messages) || !out.messages.includes(msg)) return decision;
        mark('mood', `inject: ${level}`);
        return out;
      } catch (e) {
        mark('mood', `error: ${e?.message ?? e}`);
        return decision;
      }
    });
  } catch (e) {
    mark('mood', `apply failed: ${e?.message ?? e}`);
    ctx.logger?.('dsh-mind').warn(`dsh-mind-mood: apply 失败（已忽略）：${e?.message ?? e}`);
  }
}
