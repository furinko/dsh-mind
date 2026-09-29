// lib/host/skill-loader.js — Skill 关键词触发（命中就注入一张"方法论卡片"）。
//
// ── 做什么 ────────────────────────────────────────────────────────────────────
//   每步扫**真用户消息**，命中某张卡的 `contract.triggers` 就注入一张卡片
//   （描述 + 产出摘要，约 150 token）——让 agent"不靠记得"就知道有对应方法论可用、
//   以及去哪读全文。**注入卡片而非全文**：全文几十上百行灌上下文违反"少而精"。
//
// ── 扫描面边界（**别越界**）──────────────────────────────────────────────────
//   只扫**心智自己的四区**（出厂/私有 × Skill/Exp）。**绝不扫 `skills/`**——那是官方
//   `dsh-skill-filesystem` 的目录，它走 `ctx.skills.register` 注册式。两边各扫各的；
//   若本插件也去扫 `skills/`，同一条技能会被**双份注入**。
//
// ── 两个设计决定 ──────────────────────────────────────────────────────────────
//   ① **只扫真用户消息**：扫"本会话全部消息"会导致——卡片文案里印着 triggers 词表，
//      注入后又被自己扫到 ⇒ 自激（实测：一张卡能把 10~22 张卡全带出来）。
//   ② **同卡同会话只提示一次**（去重），且触发匹配是**精确子串**——有意设计，防命中
//      自身文件名/说明里的词。代价：中文口语变体会漏 ⇒ 触发词要显式列常见说法。

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { mindDir, privateDir } from '../paths.js';
import { mark } from '../diag.js';
import { fmValue, fmArray } from '../search.js';
import { sessionKey, insertAfterClaimed } from '../insert.js';
import { createUserMessage } from '../upstream.js';
import { isConnected } from './connect.js';

export const name = 'dsh-mind-skill-loader';
export const inject = ['fs'];

/** 心智自己的四区（**不含官方 `skills/`**，见文件头边界说明）。 */
export function scanDirs() {
  return [
    [join(mindDir(), 'L2', 'Skill'), 'factory'],
    [join(privateDir(), 'L2', 'Skill'), 'private'],
    [join(mindDir(), 'L2', 'Exp'), 'factory'],
    [join(privateDir(), 'L2', 'Exp'), 'private'],
  ];
}

/**
 * 载入全部卡片的触发索引（同名私有优先覆盖出厂）。
 * @returns {Array<{id:string, description:string, outputs:string, triggers:string[], zone:string}>}
 */
export function loadCards() {
  const byId = new Map();
  for (const [dir, zone] of scanDirs()) {
    if (!existsSync(dir)) continue;
    let names;
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.md') || n === 'README.md' || n === '_index.md') continue;
      let text;
      try { text = readFileSync(join(dir, n), 'utf8'); } catch { continue; }
      const triggers = fmArray(text, 'triggers');
      if (triggers.length === 0) continue;   // 无触发词 = 永不触发（跳过，不占内存）
      byId.set(fmValue(text, 'name') || n.replace(/\.md$/, ''), {
        id: fmValue(text, 'name') || n.replace(/\.md$/, ''),
        description: fmValue(text, 'description'),
        outputs: fmArray(text, 'outputs').join('、'),
        triggers, zone,
      });
    }
  }
  return [...byId.values()];
}

/** 从消息里取文本（content 可能是 string 或 blocks）。 */
function textOf(m) {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.map((c) => (typeof c === 'string' ? c : c?.text ?? '')).join('\n');
  return typeof m.text === 'string' ? m.text : '';
}

/** 卡片文本。 */
function cardText(card) {
  const lines = [`【方法论 · ${card.id}】`, card.description || ''];
  if (card.outputs) lines.push(`产出：${card.outputs}`);
  lines.push(`全文：${card.zone === 'private' ? 'mind-private/L2' : 'mind/L2'}/${card.id}.md`);
  return lines.filter(Boolean).join('\n');
}

export function apply(ctx) {
  try {
    const cards = loadCards();
    mark('skill-loader', `apply: registered hook（cards=${cards.length}）`);
    if (cards.length === 0) return;

    /** sessionKey -> Set<cardId>（同卡同会话只提示一次）。 */
    const injected = new Map();

    ctx.on('session/disposed', (s) => {
      const id = s?.id ?? s?.header?.id;
      if (id) injected.delete('session:' + String(id));
    });

    ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
      const decision = await next();
      try {
        if (decision?.kind !== 'enter') return decision;
        const key = sessionKey(agent);
        if (key === null || !createUserMessage) return decision;
        if (!isConnected(agent?.session?.header?.id)) return decision;

        // **只扫真用户消息**（防自激，见文件头 ①）
        const userText = (messages || []).map(textOf).join('\n');
        if (!userText) return decision;

        const done = injected.get(key) || new Set();
        const hit = cards.find((c) => !done.has(c.id) && c.triggers.some((t) => userText.includes(t)));
        if (!hit) return decision;

        const msg = createUserMessage({ text: cardText(hit) });
        if (!msg) return decision;
        const out = insertAfterClaimed(decision, messages, msg);
        if (!Array.isArray(out?.messages) || !out.messages.includes(msg)) return decision;

        done.add(hit.id);
        injected.set(key, done);
        mark('skill-loader', `card: ${hit.id}`);
        return out;
      } catch (e) {
        mark('skill-loader', `error: ${e?.message ?? e}`);
        return decision;
      }
    });
  } catch (e) {
    mark('skill-loader', `apply failed: ${e?.message ?? e}`);
    ctx.logger?.('dsh-mind').warn(`dsh-mind-skill-loader: apply 失败（已忽略）：${e?.message ?? e}`);
  }
}
