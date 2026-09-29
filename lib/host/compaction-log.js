// lib/host/compaction-log.js — 压缩留痕（把此前**静默**的上下文压缩写成一行审计）。
//
// ── 为什么需要 ────────────────────────────────────────────────────────────────
//   上下文压缩（自动阈值 / 手动 /compact / 工具结果剪枝）此前**不留任何痕**：
//   压缩了多少、什么时候压的、释放了多少 token，事后完全查不到。本插件把每次压缩
//   写成一行，落在 `<mind-private>/tasks/compaction-log.md`（**独立文件**，不污染 changelog）。
//
// ── 释放量口径 ────────────────────────────────────────────────────────────────
//   `compaction/start` 与 `compaction/end` 各取一次 `tokenMeter.measure().totalTokens`，
//   差值即释放量（正数=腾出，负数=压缩自身开销）。取不到记 `unknown`——**不假装有**。
//
// ── 边界 ──────────────────────────────────────────────────────────────────────
//   只追加、不改写；写失败只 warn（fail-open）。`tokenMeter` 走 `ctx.get()` 按需取，
//   **不列进 inject**——列进去会让缺该服务的 profile 里本插件整体不激活，留痕静默消失。

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { privateDir } from '../paths.js';
import { mark } from '../diag.js';

export const name = 'dsh-mind-compaction-log';
export const inject = ['fs'];

const LOG_HEADER = [
  '# 压缩留痕（compaction-log）',
  '',
  '> 由 `dsh-mind-compaction-log` 机器追加；**只追加、不改写**。',
  '> `释放` = start 与 end 两次 token 读数之差（正=腾出，负=压缩自身开销）；取不到记 `unknown`。',
  '',
  '| 时间 | 会话 | 事件 | compactionId | 释放 token |',
  '|---|---|---|---|---|',
  '',
].join('\n');

const logPath = () => join(privateDir(), 'tasks', 'compaction-log.md');

/** 单元格内不许出现裸 `|`（会破表）。 */
const cell = (v) => (v === undefined || v === null || v === '' ? 'unknown' : String(v).replace(/\|/g, '/'));
const stamp = () => new Date().toLocaleString('sv-SE').replace('T', ' ');

export function apply(ctx) {
  try {
    /** compactionId -> 起始 token 读数。 */
    const startTokens = new Map();

    const meterTotal = () => {
      try {
        const m = ctx.get?.('tokenMeter');
        const n = m?.measure?.()?.totalTokens;
        return typeof n === 'number' ? n : null;
      } catch { return null; }
    };

    const append = (row) => {
      try {
        const f = logPath();
        mkdirSync(dirname(f), { recursive: true });
        if (!existsSync(f)) writeFileSync(f, LOG_HEADER, 'utf8');
        appendFileSync(f, row + '\n', 'utf8');
      } catch (e) {
        ctx.logger?.('dsh-mind').warn(`dsh-mind-compaction-log: 写失败（不影响会话）：${e?.message ?? e}`);
      }
    };

    ctx.on('session/event', (payload) => {
      try {
        const ev = payload?.event ?? payload;
        const type = ev?.type;
        if (type !== 'compaction/start' && type !== 'compaction/end') return;
        const id = cell(ev?.data?.compactionId);
        const session = ev?.sessionId ?? ev?.session?.id ?? '';

        if (type === 'compaction/start') {
          startTokens.set(id, meterTotal());
          return;
        }
        const before = startTokens.get(id);
        startTokens.delete(id);
        const after = meterTotal();
        const released = (typeof before === 'number' && typeof after === 'number') ? before - after : null;
        append(`| ${stamp()} | ${cell(session)} | ${type} | ${id} | ${released === null ? 'unknown' : released} |`);
      } catch { /* 留痕失败不影响会话 */ }
    });

    mark('compaction-log', 'apply: subscribed（compaction/start · compaction/end）');
  } catch (e) {
    mark('compaction-log', `apply failed: ${e?.message ?? e}`);
    ctx.logger?.('dsh-mind').warn(`dsh-mind-compaction-log: apply 失败（已忽略）：${e?.message ?? e}`);
  }
}
