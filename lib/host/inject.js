// lib/host/inject.js — R0 宪法注入（人格 + 运行纪律，每会话首步全文注入一次）。
//
// ── 做什么 ────────────────────────────────────────────────────────────────────
//   每个 agent 会话【第一步】时，把 `mind/L0/SOUL.md` + `AGENTS.md` **全文**作为一条
//   user 消息插进消息流。SOUL（我是谁）**先于** AGENTS（怎么活）是契约。
//
// ── 两个设计决定 ──────────────────────────────────────────────────────────────
//   ① **正文即注入源**：不做"手写摘要副本"（曾用摘要 ⇒ 权威倒挂：生效的是摘要、
//      改正文不生效）。现在每会话**运行时读盘**，改正文即改注入。
//   ② 注入机制（每会话一次 / 代次跟踪 / 落地校验）在 `lib/injector.js` —— **与 R1 共用**，
//      不在这里重写一份（历史教训：同一机制两份实现必然漂移）。
//
// ── 边界 ──────────────────────────────────────────────────────────────────────
//   只做**注入**，不做拦截（拦截归 guard）。全程 fail-open。

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { mindDir } from '../paths.js';
import { bootstrap } from '../bootstrap.js';
import { mark } from '../diag.js';
import { makeInjector, surfaceViewOf } from '../injector.js';
import { createUserMessage } from '../upstream.js';
import { isConnected } from './connect.js';

export const name = 'dsh-mind-inject';
export const inject = ['fs'];

/** 注入件（**顺序是契约**：人格先于行为）。 */
const PARTS = ['SOUL.md', 'AGENTS.md'];

/** 装配 R0 全文（运行时读盘）。任一缺失注另一件；全缺返回空串。 */
export function composeText() {
  try {
    const dir = join(mindDir(), 'L0');
    const parts = [];
    for (const f of PARTS) {
      const p = join(dir, f);
      if (!existsSync(p)) continue;
      const t = readFileSync(p, 'utf8').trim();
      if (t) parts.push(t);
    }
    return parts.join('\n\n');
  } catch { return ''; }
}

export function apply(ctx) {
  try {
    // 首启自举（幂等 · 只增不改 · fail-open）：装到新机器时本机没有固件。
    try {
      const boot = bootstrap({ logger: (m) => ctx.logger?.('dsh-mind')?.info?.(m) });
      if (boot.action === 'seeded') mark('inject', `apply: bootstrap seeded（copied=${boot.copied}）`);
      else if (boot.action === 'no-source') mark('inject', 'apply: bootstrap no-source（包内缺 firmware/）');
    } catch { /* bootstrap 自身 fail-open */ }

    if (!composeText()) { mark('inject', 'apply: text empty（R0 文件缺失？）'); return; }

    const injectOnce = makeInjector({
      pluginName: name,
      form: 'instructions',
      markName: 'inject',
      buildText: composeText,
      head: (repair) => (repair
        ? '\n【心智 · R0 宪法（SOUL + AGENTS 全文）· 补注入】\n'
        : '\n【心智 · R0 宪法（SOUL + AGENTS 全文）】\n'),
    });

    const state = new Map();
    let surfaceBroken = false;

    mark('inject', 'apply: registered hook（read-per-session）');
    if (!createUserMessage) mark('inject', 'apply: degraded — createUserMessage 不可用');

    ctx.on('session/disposed', (s) => {
      const id = s?.id ?? s?.header?.id;
      if (id) state.delete('session:' + String(id));
    });

    ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
      const decision = await next();
      try {
        if (decision?.kind !== 'enter') return decision;
        if (!isConnected(agent?.session?.header?.id)) return decision;
        const view = surfaceViewOf(agent);
        if (view === null) {
          if (!surfaceBroken) {
            surfaceBroken = true;
            mark('inject', 'error: surface unavailable — 在场复核停用');
            ctx.logger?.('dsh-mind').warn('dsh-mind-inject: session.surface 不可用 → 跳过注入');
          }
          return decision;
        }
        return injectOnce(view, decision, messages, state, createUserMessage);
      } catch (e) {
        mark('inject', `error: ${e?.message ?? e}`);
        return decision;
      }
    });
  } catch (e) {
    mark('inject', `apply failed: ${e?.message ?? e}`);
    ctx.logger?.('dsh-mind').warn(`dsh-mind-inject: apply 失败（已忽略）：${e?.message ?? e}`);
  }
}
