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
import { splitSessionEvent, sessionIdOf } from './session-event.js';

export const name = 'dsh-mind-compaction-log';
export const inject = ['fs'];

const LOG_HEADER = [
  '# 压缩留痕（compaction-log）',
  '',
  '> 由 `dsh-mind-compaction-log` 机器追加；**只追加、不改写**。',
  '> `释放` = start 与 end 两次 token 读数之差（正=腾出，负=压缩自身开销）；取不到记 `unknown`。',
  '> `turn` 缺失记 `manual`（手动 `/compact`）；`结果` 记成功或失败+error 摘要（2026-09-29 补）。',
  '',
  '| 时间 | 会话 | 事件 | compactionId | turn | 释放 token | 结果 |',
  '|---|---|---|---|---|---|---|',
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

    const meterTotal = (session) => {
      try {
        // ⚠️ 要把 session 传进去（2026-09-29 修）：老实现是 `measure?.(session)`；
        //    不传 ⇒ 拿到"未按会话计算"的读数，或签名不符直接抛（抛错被吞成 null）。
        const n = ctx.get?.('tokenMeter')?.measure?.(session)?.totalTokens;
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

    // ⚠️ 签名是 **`(session, event)`**——**不是**单参 payload（2026-09-30 修：写错 ⇒ 压缩永不落痕、
    //    连留痕文件都不生成，而 marker 里只有 apply 行 ⇒ 假绿；根因见 `lib/host/session-event.js`）
    ctx.on('session/event', (a, b) => {
      try {
        const { session: sess, event: ev } = splitSessionEvent(a, b);
        const type = ev?.type;
        if (typeof type !== 'string' || !type.startsWith('compaction/')) return;
        if (type === 'compaction/summary') return;   // 过程性中间通知，不记（老口径）
        const id = cell(ev?.data?.compactionId);
        const session = sessionIdOf(sess) || 'unknown';
        // 快照键 = 会话 + compactionId（**2026-09-29 修**）：此前只用 compactionId，
        // 而缺失值被折成字符串 `'unknown'` ⇒ 多个缺 id 的并发压缩会互相覆盖快照。
        const key = `${cell(session)}|${id}`;
        const turnCell = (ev?.data?.turn === undefined || ev?.data?.turn === null) ? 'manual' : String(ev.data.turn);

        if (type === 'compaction/start') {
          startTokens.set(key, meterTotal(sess));
          return;
        }
        // 工具结果剪枝（**2026-09-29 补**）：文件头声明覆盖"工具结果剪枝"，此前白名单
        // 只有 start/end ⇒ 声明了却根本没记（老实现有独立的 prune 分支）。
        if (type === 'compaction/prune') {
          append(`| ${stamp()} | ${cell(session)} | ${type} | ${id} | ${turnCell} | unknown | 工具结果剪枝 |`);
          return;
        }
        if (type !== 'compaction/end') return;

        const before = startTokens.get(key);
        startTokens.delete(key);
        const after = meterTotal(sess);
        const released = (typeof before === 'number' && typeof after === 'number') ? before - after : null;
        // `结果` 列（**2026-09-29 补**）：失败时带 error 摘要 —— "这次压缩成没成"是本文件的主要价值之一
        const err = ev?.data?.error;
        const result = err ? `失败：${cell(err).slice(0, 120)}` : '成功';
        append(`| ${stamp()} | ${cell(session)} | ${type} | ${id} | ${turnCell} | ${released === null ? 'unknown' : released} | ${result} |`);
      } catch { /* 留痕失败不影响会话 */ }
    });

    // 会话销毁 ⇒ 清该会话的残留快照（**2026-09-29 补**）：否则异常中断的压缩会留下
    // 永不消费的条目（键里含会话，不清就是纯泄漏）。
    ctx.on('session/disposed', (s) => {
      const sid = sessionIdOf(s);
      if (!sid) return;
      const prefix = `${cell(sid)}|`;
      for (const k of [...startTokens.keys()]) if (k.startsWith(prefix)) startTokens.delete(k);
    });

    mark('compaction-log', 'apply: subscribed（compaction/start · end · prune）+ disposed 清理');
  } catch (e) {
    mark('compaction-log', `apply failed: ${e?.message ?? e}`);
    ctx.logger?.('dsh-mind').warn(`dsh-mind-compaction-log: apply 失败（已忽略）：${e?.message ?? e}`);
  }
}
