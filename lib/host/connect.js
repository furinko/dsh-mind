// lib/host/connect.js — 「接入心智」每会话开关。
//
// 作用：关闭某会话的心智后，注入 / 召回 / 护栏都跳过它。
// 默认**接入**（只记录显式关闭的会话，避免状态膨胀）。
//
// 为什么单独一个插件：`inject` / `recall` / `guard` 三处都要在决策点查同一个开关，
// 抽出来避免各写一份（历史教训：同一判据多份实现必然漂移）。

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { marketDir } from '../paths.js';
import { mark } from '../diag.js';

export const name = 'dsh-mind-connect';

/** 无硬依赖：拿不到 webServer 也能工作（只是没面板入口）。 */
export const inject = [];

/** sessionKey -> false（只存"明确关闭"）。 */
const off = new Map();

const file = () => join(marketDir(), 'connect.json');
const keyOf = (id) => (id ? `session:${String(id)}` : null);

/** 启动时载入持久化的关闭集。 */
function load() {
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8'));
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw)) if (v === false) off.set(k, false);
    }
  } catch { /* 无文件 / 坏文件 ⇒ 全默认接入 */ }
}

/** 落盘（只写 false）。 */
function persist() {
  try {
    const obj = {};
    for (const [k, v] of off) if (v === false) obj[k] = false;
    mkdirSync(dirname(file()), { recursive: true });
    writeFileSync(file(), JSON.stringify(obj, null, 2), 'utf8');
  } catch { /* 落盘失败不影响运行态 */ }
}

/**
 * 该会话是否接入心智。**默认接入**（未知会话返回 true）。
 * @param {string|undefined} sessionId
 * @returns {boolean}
 */
export function isConnected(sessionId) {
  const k = keyOf(sessionId);
  if (k === null) return true;
  return off.get(k) !== false;
}

/**
 * 设置会话接入状态。
 * @returns {boolean} 是否成功
 */
export function setConnected(sessionId, enabled) {
  const k = keyOf(sessionId);
  if (k === null) return false;
  if (enabled) off.delete(k); else off.set(k, false);
  persist();
  return true;
}

/** 供诊断/面板：当前关闭的会话数。 */
export function offCount() {
  return off.size;
}

export function apply(ctx) {
  try {
    load();
    mark('connect', `apply: loaded（off=${off.size}）`);
    // 会话销毁 → 清状态（避免内存随会话数长存）
    ctx.on('session/disposed', (session) => {
      const id = session?.id ?? session?.header?.id;
      const k = keyOf(id);
      if (k && off.has(k)) { off.delete(k); persist(); }
    });
  } catch (e) {
    mark('connect', `apply failed: ${e?.message ?? e}`);
    ctx.logger?.('dsh-mind').warn(`dsh-mind-connect: apply 失败（已忽略）：${e?.message ?? e}`);
  }
}
