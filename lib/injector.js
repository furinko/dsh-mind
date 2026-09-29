// lib/injector.js — 「每会话每代次注入一次」的共用机制（R0 宪法 / R1 召回共用）。
//
// ── 为什么抽出来 ──────────────────────────────────────────────────────────────
//   R0 与 R1 的注入机制完全相同，只差"注什么"与来源标签。历史教训：同一段机制写两遍
//   ⇒ 修一处漏一处（两插件曾各自维护一份 60 行的代次逻辑）。
//
// ── 机制要点 ──────────────────────────────────────────────────────────────────
//   · **代次键**（`session.surface.replaceGeneration`）：官方压缩器只保护 surface 第 0 格、
//     从第 1 格起压 ⇒ 塞在后面的注入**每次压缩必被换出去**。代次只有 replace 才 +1，
//     普通 append 不动 ⇒ 同代次 O(1) 直接返回（零扫描）；换代次才扫 surface 复核在场。
//   · **落地校验**：`insertAfterClaimed` 在 `decision.messages` 非数组时静默返回原对象。
//     若照样记代次，一次没落地会把该代次"钉死"、到下次换代前永不再试 ⇒ 必须校验。
//   · **fail-open**：任何异常只留痕，不抛穿（单步失败不拖垮回合）。

import { sessionKey, insertAfterClaimed } from './insert.js';
import { mark } from './diag.js';

/**
 * 造一个注入器。
 * @param {object} o
 * @param {string} o.pluginName 插件名（写进消息 source.plugin，供在场复核）
 * @param {string} o.form       source.form（如 'instructions' / 'recall'）
 * @param {string} o.markName   marker 文件名前缀
 * @param {() => string} o.buildText  装配注入文本（返回空串 = 本次不注入）
 * @param {(repair:boolean) => string} [o.head] 块头生成器
 * @returns {(view:{session:object,surface:object}, decision:object, messages:any[], state:Map, createUserMessage:Function) => object}
 */
export function makeInjector(o) {
  const { pluginName, form, markName, buildText } = o;
  const head = o.head || ((repair) => (repair ? '\n【补注入】\n' : '\n'));

  let insertFailed = false;   // 只报一次（不刷屏）

  return function injectOnce(view, decision, messages, state, createUserMessage) {
    try {
      if (!createUserMessage) return decision;
      const { session, surface } = view;
      const key = sessionKey({ session });
      if (key === null) return decision;

      const gen = surface.replaceGeneration;
      const rec = state.get(key);
      // 同代次 ⇒ 注入必在场，零扫描返回
      if (rec && rec.gen === gen) return decision;
      // 换代次但仍在 surface ⇒ 只更新代次，不重注
      if (rec && isOnSurface(session, surface, pluginName, form)) {
        state.set(key, { gen, ever: rec.ever });
        return decision;
      }

      const text = buildText();
      if (!text) return decision;

      const repair = !!(rec && rec.ever);
      // ⚠️ **消息形态是硬契约**（2026-09-29 实机崩溃换来的，别改）：
      //   官方 `dsh-agent-instructions` / `dsh-time-context` 的形态是
      //       createUserMessage({ content: [{type:'text', text}], source: {kind:'plugin', plugin, form} })
      //   宿主有 30+ 处读 `message.source.kind`（`dsh-agent-loop` 的 `isOwned`、
      //   `dsh-api-session-controller`、`dsh-session-title`、`dsh-tool-skill` …）。
      //   **缺顶层 `source` ⇒ `undefined.kind` ⇒ 整个回合作废**（实机报
      //   「Cannot read properties of undefined (reading 'kind')」）。
      //   另外消息被 `freezeMessage` 冻结 ⇒ **不能创建后再补 `source`**，必须构造期传入。
      const msg = createUserMessage({
        content: [{ type: 'text', text: head(repair) + text }],
        source: { kind: 'plugin', plugin: pluginName, form },
      });
      if (!msg) return decision;

      const out = insertAfterClaimed(decision, messages, msg);
      if (!Array.isArray(out?.messages) || !out.messages.includes(msg)) {
        if (!insertFailed) {
          insertFailed = true;
          mark(markName, 'inject#failed: decision.messages 非数组或未插入');
        }
        return decision;   // **不记代次** ⇒ 下一步重试
      }

      state.set(key, { gen, ever: true });
      mark(markName, `inject: len=${text.length}${repair ? ' repair' : ''}`);
      return out;
    } catch (e) {
      mark(markName, `error: ${e?.message ?? e}`);
      return decision;
    }
  };
}

/** 该插件注入的内容是否仍在 surface 上（钉 source，不看文本）。 */
export function isOnSurface(session, surface, pluginName, form) {
  for (const seq of surface.nodes) {
    const e = session.eventAt(seq);
    if (e && e.type === 'user/message'
      && e.data?.source?.plugin === pluginName
      && e.data?.source?.form === form) return true;
  }
  return false;
}

/** 取 surface 视图；任一要件缺失 ⇒ null（判据面失效，调用方应响亮留痕）。 */
export function surfaceViewOf(agent) {
  const session = agent?.session;
  const surface = session?.surface;
  if (!surface || typeof surface.replaceGeneration !== 'number') return null;
  if (!Array.isArray(surface.nodes) || typeof session.eventAt !== 'function') return null;
  return { session, surface };
}
