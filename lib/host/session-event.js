// lib/host/session-event.js — 宿主 `session/event` 的**参数形态**（一个真源，三处共用）。
//
// ── 为什么要单独一个模块（实测代价：三个插件静默空转）────────────────────────
//   宿主 `ctx.on('session/event', handler)` 的 handler 签名是 **`(session, event)` 两个位置参数**——
//   完整版四处都这么写（`mind-mood.js:394` · `mind-compaction-log.js:127` ·
//   `session-budget.js:308` · `notify.js:415`），官方 `session/disposed` 同样传 session 对象。
//
//   本包重写时误写成**单参 payload**（`(payload) => payload?.event ?? payload`）⇒ 第一参拿到的是
//   session 对象、`event` 恒为 `undefined` ⇒ `mood` / `session-budget` / `compaction-log`
//   **三处全部提前 return**：情绪从不注入、预算从不提示、压缩从不留痕。
//   而 marker 里只有 `apply: registered`（**假绿**），纯函数自测也看不见——因为夹具当时**也按错
//   约定喂数据**（判据与实现同错，双向空转，见 `Learn` 2026-09-29「判据空转族」）。
//
// ── 本模块干什么 ─────────────────────────────────────────────────────────────
//   把两种形态都归一成 `{ session, event }`：
//     · 宿主形态（**优先**）：`(session, event)` —— 第二参在场即认定；
//     · 单参载荷（老宿主 / 夹具）：`{ event, sessionId, session }` 或直接就是一个事件对象。
//   归一化不是"和稀泥"：判定**只认宿主形态**——selftest 用"session 只从第一参带 id、事件里没有
//   sessionId"的用例证明宿主形态真的被读到了（写错签名 ⇒ 那条必红）。
//
// ── 为什么抽共用而不是各写一份 ────────────────────────────────────────────────
//   同 `lib/paths.js` 的教训：同一段"找根"逻辑曾在 11 处各写一遍，改一处漏十处。
//   签名这种事尤其如此——它错起来是**静默**的，重复三份就等于三个定时炸弹。

/**
 * 归一化 `session/event` 的回调参数。
 * @param {unknown} a 第一位置参数（宿主形态＝session 对象）
 * @param {unknown} b 第二位置参数（宿主形态＝event 对象）
 * @returns {{session: object|null, event: object|null}}
 */
export function splitSessionEvent(a, b) {
  // 宿主形态：两个位置参数（第二参在场是硬信号——第一参恒为 session）
  if (b !== undefined && b !== null) return { session: a ?? null, event: b ?? null };

  // 单参载荷（兼容面）：`{ event, session, sessionId }` 或事件对象本身
  const p = a;
  if (!p || typeof p !== 'object') return { session: null, event: null };
  const ev = (p.event && typeof p.event === 'object')
    ? p.event
    : (typeof p.type === 'string' ? p : null);
  // session 的三处历史写法都要认（**根层优先**）：`p.session` · `p.sessionId` · `event.session`
  // ⚠️ 第三档不是"想当然"：本包旧实现就是从**事件对象**上取 session（`ev?.session?.id`），
  //    老夹具/老宿主正是把 session 塞在 event 里的形态（见 selftest ⑪/⑬ 的历史用例）。
  let session = (p.session && typeof p.session === 'object') ? p.session : null;
  if (!session && typeof p.sessionId === 'string') session = { id: p.sessionId };
  if (!session && ev) {
    session = (ev.session && typeof ev.session === 'object') ? ev.session
      : (typeof ev.sessionId === 'string' ? { id: ev.sessionId } : null);
  }
  return { session, event: ev };
}

/**
 * 从 session 对象取 id（`session.id` 优先，兜 `session.header.id`）。
 * @returns {string} 取不到 ⇒ 空串（调用方据此跳过，**不编一个 id**）
 */
export function sessionIdOf(session) {
  if (!session || typeof session !== 'object') return '';
  const id = session.id ?? session.header?.id;
  return typeof id === 'string' && id ? id : '';
}
