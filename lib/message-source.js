// lib/message-source.js — 注入消息的 `source` 形态适配（跨会话格式版本）。
//
// ── 为什么需要（2026-09-29 实机两次翻车换来的）────────────────────────────────
//
//   注入消息的 `source` 是**宿主硬契约**，且**在 0.2.0 改了**：
//
//   · **V3（≤ 0.1.x）**：`{ kind: 'plugin', plugin: '<包名>', form }`
//       —— 官方 `dsh-agent-instructions` / `dsh-time-context` 的写法。
//
//   · **V4（≥ 0.2.0）**：`kind` 必须是**生产者自有 kind**，`kind === 'plugin'` 被**明确拒绝**。
//       官方原文（`message-sources.js`）：
//           if (... || value["kind"] === "plugin")
//             throw new SessionFormatError("format v4 message requires a producer-owned source kind");
//       第三方的映射规则（`producerKind`）：
//           return `plugin:${plugin}`;     // 并**删掉 `plugin` 字段**
//
// ── 两种失败的实机症状（都真踩过）────────────────────────────────────────────
//   ① 完全没有 `source`      ⇒ `message.source.kind` 处 `Cannot read properties of undefined (reading 'kind')`
//   ② 用了 V3 的 `kind:'plugin'` ⇒ `format v4 message requires a producer-owned source kind`
//
// ── 为什么默认取 V4 ────────────────────────────────────────────────────────────
//   两边**宽容度不对称**：V4 对 `kind:'plugin'` 是**硬拒绝**（整回合作废），
//   而 V3 遇到 `plugin:<名>` 只是"不把它当 plugin 消息"（**无害**）。
//   ⇒ 版本探测失败时取 V4，是**损失更小**的一侧。

import { hostPackageJson } from './host-resolve.js';

/** 宿主 `@deepseek-ai/dsh` 版本（取不到 ⇒ null）。 */
export function hostVersion() {
  const pj = hostPackageJson('@deepseek-ai/dsh');
  return typeof pj?.version === 'string' ? pj.version : null;
}

/**
 * 是否使用 V4（producer-owned）形态。
 * 判据：宿主版本 `>= 0.2.0`；**取不到版本 ⇒ 取 V4**（见文件头的宽容度不对称）。
 */
export function usesProducerOwnedSource(version = hostVersion()) {
  if (typeof version !== 'string') return true;
  const m = /^(\d+)\.(\d+)\./.exec(version.trim());
  if (!m) return true;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return true;
  return major > 0 || minor >= 2;
}

/**
 * 造注入消息的 `source`（按宿主会话格式版本自适应）。
 * @param {string} pluginName 生产者包名（用于归属）
 * @param {string} form 形态标签（同一插件的多种注入可区分）
 */
export function pluginSource(pluginName, form, version = hostVersion()) {
  if (usesProducerOwnedSource(version)) {
    // V4：kind 即生产者身份，`plugin` 字段**必须不存在**
    return { kind: `plugin:${pluginName}`, form };
  }
  // V3：旧包装
  return { kind: 'plugin', plugin: pluginName, form };
}
