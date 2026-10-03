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
import { pluginSource } from '../message-source.js';
import { isConnected } from './connect.js';
import { splitSessionEvent, sessionIdOf } from './session-event.js';

export const name = 'dsh-mind-mood';
// ⚠️ 不声明 `fs`（2026-09-29 修）：本文件不落盘；`inject` 多列一个用不到的服务，
//    会让缺该服务的 profile 里**整个插件静默不激活**。
export const inject = [];

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

/**
 * 测试缝：读某会话的折叠状态（只读）。
 * 为什么要有：折叠是**模块私有**的，而"宿主形态 `(session, event)` 有没有被吃到"这件事
 * 只能通过状态变化观测——2026-09-30 的真机缺陷（签名单参 ⇒ 情绪永不注入）正是没有这个观测点
 * 才隐身至今（真源仍是上面的 `state`，本函数只读不写）。
 */
export function moodStateOf(sessionId) {
  return state.get('session:' + String(sessionId)) ?? null;
}

/** 按时间衰减后的有效档位。 */
export function effectiveLevel(rec, now = Date.now()) {
  if (!rec) return 'ok';
  const steps = Math.floor((now - rec.at) / DECAY_MS);
  if (steps <= 0) return rec.level;
  // ⚠️ 衰减分**两条路径**（2026-09-29 修）：此前是单序 `['bristle','down','proud','ok']`
  //    ⇒ "蔫"被夹在"炸毛"与"得意"之间，即"从炸毛平复要先变得意"——语义自相矛盾。
  //    现在：负向 bristle → down → ok（逐级平复）；正向 proud → ok（得意自然回落）。
  const order = rec.level === 'proud' ? ['proud', 'ok'] : ['bristle', 'down', 'ok'];
  const i = order.indexOf(rec.level);
  if (i < 0) return 'ok';
  return order[Math.min(i + steps, order.length - 1)];
}

/** 记一条成因（去重、只留最近 3 条）。 */
function addCause(rec, text) {
  if (!text) return;
  rec.causes = [text, ...rec.causes.filter((c) => c !== text)].slice(0, 3);
}

/**
 * 事件 → 新状态（**纯函数**，便于断言；apply 只负责喂事件与注入）。
 *
 * 为什么抽出来（2026-09-29）：`proud`（得意）此前**没有任何赋值点**——文件头写着
 * "连续成功 → 得意"，实现里它只在档位表和衰减序里出现过 ⇒ 永不可达，且**判据测不到**
 * （折叠逻辑私有）。抽成纯函数后，自测可以直接喂事件序列并断言档位。
 *
 * @param {object|undefined} rec 现状态
 * @param {object} ev 会话事件
 * @returns {{level:string, causes:string[], at:number, streak:number}}
 */
export function nextMoodState(rec, ev, now = Date.now()) {
  const cur = rec
    ? { ...rec, causes: [...(rec.causes || [])] }
    : { level: 'ok', causes: [], at: now, streak: 0 };
  const hit = causeOf(ev);
  if (hit) {
    cur.level = hit.level;
    addCause(cur, hit.cause);
    cur.at = now;
    cur.streak = 0;
    return cur;
  }
  // 连续成功 ≥3 ⇒ 得意
  if (ev?.type === 'tool/result' && ev.data?.isError !== true) {
    cur.streak = (cur.streak || 0) + 1;
    if (cur.streak >= 3 && cur.level !== 'proud') {
      cur.level = 'proud';
      addCause(cur, '连续顺利');
      cur.at = now;
    }
  }
  return cur;
}

/** 渲染状态行。 */
export function renderMood(level, causes) {
  const lv = LEVELS[level] ?? LEVELS.ok;
  const why = causes.length ? `成因：${causes.join('；')}` : '成因：无';
  return `【情绪】${lv.label}（尾巴${lv.tail}）· ${why}\n`
    + '（只改语气，不改判断：数字、路径、证据、验证标准不因情绪变松。）';
}

/** 从事件里抽成因（失败/成功/被纠正）→ `{ cause, level }`；无 ⇒ null。 */
function causeOf(ev) {
  const t = ev?.type;
  if (t === 'tool/result' && ev.data?.isError === true) return { cause: '工具失败', level: 'down' };
  if (t === 'turn/end' && ev.data?.reason?.kind === 'error') return { cause: '本轮回合出错', level: 'bristle' };
  return null;
}

export function apply(ctx) {
  try {
    mark('mood', 'apply: registered（每轮注入）');
    if (!createUserMessage) mark('mood', 'apply: degraded — createUserMessage 不可用');

    // 从事件流折叠状态（不主动存盘：情绪是短期状态，重启即归零，符合"状态行管此刻"）
    // ⚠️ 签名是 **`(session, event)`**——**不是**单参 payload（2026-09-30 修，代价：情绪永不注入、
    //    marker 里只有 apply 行 ⇒ 假绿；根因与"判据空转"详见 `lib/host/session-event.js` 头部）
    ctx.on('session/event', (a, b) => {
      try {
        const { session, event: ev } = splitSessionEvent(a, b);
        const id = sessionIdOf(session);
        if (!id || !ev) return;
        const key = 'session:' + String(id);
        state.set(key, nextMoodState(state.get(key), ev));
      } catch { /* 折叠失败不影响会话 */ }
    });

    ctx.on('session/disposed', (s) => {
      const id = sessionIdOf(s);
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
        if (!rec) return decision;                     // 从未有过成因 ⇒ 不注入（不编情绪）
        if (level === 'ok') {
          // ⚠️ 衰减回"如常" ⇒ **停注入并清状态**（2026-09-29 修）：此前判据是
          //    `level === 'ok' && !rec`，而 `rec` 只要存在过就永为真值 ⇒ 衰减到 ok 之后
          //    **每轮**都注入「【情绪】如常（尾巴正常）· 成因：…」，与"不编情绪"自相矛盾。
          state.delete(key);
          return decision;
        }

        // 消息形态是硬契约；`source` 走 pluginSource 按宿主版本自适应（见 message-source.js）
        const msg = createUserMessage({
          content: [{ type: 'text', text: renderMood(level, rec?.causes ?? []) }],
          source: pluginSource(name, 'mood'),
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
