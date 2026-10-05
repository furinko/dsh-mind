// lib/host/recall.js — R1 上工召回（每会话首步装配"该带上的记忆"）。
//
// ── 装配什么（七件）──────────────────────────────────────────────────────────
//   project.md 的「进度状态」+「下一步」待办 · L3 相关记忆 top-N · Learn 末尾 3 条 ·
//   user-rules · 人设卡
//
// ── 两个设计决定 ──────────────────────────────────────────────────────────────
//   ① **机械装配，不靠"记得去搜"**：召回由确定性代码做，不是让 agent 自己想起来。
//   ② **空机优雅降级**：没有 mind-private 时输出空串 ⇒ 不注入、不报错（新装机器就该这样）。
//
// ── 隔离 ──────────────────────────────────────────────────────────────────────
//   检索候选 = `L3/common/`（恒含）+ `L3/projects/<当前项目>/`（仅当前）——**物理目录隔离**，
//   其它项目不扫。当前项目 key = 会话 cwd 的目录名。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { mindDir, privateDir, PERSONA_REL, PERSONA_CHARS } from '../paths.js';
import { mark } from '../diag.js';
import { makeInjector, surfaceViewOf } from '../injector.js';
import { createUserMessage } from '../upstream.js';
import { rank } from '../search.js';
import { isConnected } from './connect.js';

export const name = 'dsh-mind-recall';
export const inject = ['fs'];

/** L3 记忆取用配额：总数与"通用层保底席位"。 */
const L3_LIMIT = 4;
const L3_GENERAL_MIN = 2;
/** Learn 取末尾几条。 */
const LEARN_TAIL = 3;

/** 递归收集 `.md`（跳过 README/_index）。 */
function walkMd(dir, out = [], rel = '') {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (e.startsWith('.')) continue;
    const full = join(dir, e);
    const r = rel ? `${rel}/${e}` : e;
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walkMd(full, out, r);
    else if (e.endsWith('.md') && !/README|_index/.test(basename(r))) {
      try { out.push({ rel: r, full, text: readFileSync(full, 'utf8') }); } catch { /* 跳过读不了的 */ }
    }
  }
  return out;
}

/** 取 project.md 的「进度状态」与「下一步」两节。 */
function projectSection(projectKey) {
  const f = join(privateDir(), 'L3', 'projects', projectKey, 'project.md');
  if (!existsSync(f)) return '';
  try {
    const text = readFileSync(f, 'utf8');
    const out = [];
    for (const head of ['进度状态', '下一步']) {
      const re = new RegExp(`^##+\\s*[^\\n]*${head}[^\\n]*\\n([\\s\\S]*?)(?=\\n##+\\s|$)`, 'm');
      const m = re.exec(text);
      if (m) out.push(`### ${head}\n${m[1].trim().split('\n').slice(0, 12).join('\n')}`);
    }
    return out.join('\n\n');
  } catch { return ''; }
}

/** Learn 末尾 N 条（条目以 `- [` 开头）。 */
function learnTail() {
  const f = join(privateDir(), 'L1', 'Learn.md');
  if (!existsSync(f)) return '';
  try {
    const items = readFileSync(f, 'utf8').split('\n').filter((l) => /^- \[/.test(l));
    return items.slice(-LEARN_TAIL).join('\n');
  } catch { return ''; }
}

/** user-rules 正文（截断，避免无界增长）。 */
function userRules() {
  const f = join(privateDir(), 'L3', 'common', 'user-rules', 'rules.md');
  if (!existsSync(f)) return '';
  try { return readFileSync(f, 'utf8').replace(/^---[\s\S]*?\n---\n/, '').trim().slice(0, 2000); } catch { return ''; }
}

/** 人设卡正文（截断；落点与上限都取自 `paths.js` 的单件口径）。 */
function personaCard() {
  const f = join(privateDir(), ...PERSONA_REL.split('/'));
  if (!existsSync(f)) return '';
  try { return readFileSync(f, 'utf8').trim().slice(0, PERSONA_CHARS); } catch { return ''; }
}

/**
 * 装配召回文本。空机（无 mind-private）⇒ 返回空串。
 * @param {string} query 任务关键词
 * @param {string} projectKey 当前项目（cwd 目录名）
 */
export function composeRecall(query, projectKey) {
  const blocks = [];

  const proj = projectSection(projectKey);
  if (proj) blocks.push(proj);

  // L3：通用层恒含 + 当前项目层；**通用层保底席位**（否则项目层恒在场会吃满配额）
  const general = walkMd(join(privateDir(), 'L3', 'common'));
  const project = projectKey ? walkMd(join(privateDir(), 'L3', 'projects', projectKey, '知识')) : [];
  const gHits = rank(query, general, { limit: L3_LIMIT });
  const pHits = rank(query, project, { limit: L3_LIMIT });
  const picked = [...gHits.slice(0, Math.max(L3_GENERAL_MIN, L3_LIMIT - pHits.length)), ...pHits].slice(0, L3_LIMIT);
  if (picked.length) {
    blocks.push('### 相关记忆\n' + picked.map((h) => `- ${h.rel}（相关度 ${(h.score * 100).toFixed(0)}%）`).join('\n'));
  }

  const learn = learnTail();
  if (learn) blocks.push('### 最近教训\n' + learn);

  const rules = userRules();
  if (rules) blocks.push('### 用户规则\n' + rules);

  const persona = personaCard();
  if (persona) blocks.push('### 人设卡\n' + persona);

  if (blocks.length === 0) return '';
  return blocks.join('\n\n');
}

export function apply(ctx) {
  try {
    // 空机检测：没有私有区就没有可召回的（新装机器 ⇒ 静默不注入）
    if (!existsSync(privateDir())) {
      mark('recall', 'apply: no mind-private（空机，召回停用）');
      return;
    }

    const state = new Map();
    let surfaceBroken = false;

    mark('recall', 'apply: registered hook（read-per-session）');
    if (!createUserMessage) mark('recall', 'apply: degraded — createUserMessage 不可用');

    ctx.on('session/disposed', (s) => {
      const id = s?.id ?? s?.header?.id;
      if (id) state.delete('session:' + String(id));
    });

    ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
      const decision = await next();
      try {
        if (decision?.kind !== 'enter') return decision;
        const sessionId = agent?.session?.header?.id;
        if (!isConnected(sessionId)) return decision;
        const view = surfaceViewOf(agent);
        if (view === null) {
          if (!surfaceBroken) {
            surfaceBroken = true;
            mark('recall', 'error: surface unavailable — 在场复核停用');
            ctx.logger?.('dsh-mind').warn('dsh-mind-recall: session.surface 不可用 → 跳过召回');
          }
          return decision;
        }

        // 查询词 = 本会话最后一条用户消息（截断）；项目 key = cwd 目录名
        const lastUser = [...(messages || [])].reverse().find((m) => typeof m?.text === 'string' && m.text.trim());
        const query = String(lastUser?.text || '心智').slice(0, 120).trim() || '心智';
        const cwd = agent?.session?.header?.cwd || '';
        const projectKey = cwd ? basename(resolve(cwd)) : '';

        const once = makeInjector({
          pluginName: name,
          form: 'recall',
          markName: 'recall',
          buildText: () => composeRecall(query, projectKey),
          head: (repair) => (repair ? '\n【上工召回 · 补注入】\n' : '\n【上工召回】\n'),
        });
        return once(view, decision, messages, state, createUserMessage);
      } catch (e) {
        mark('recall', `error: ${e?.message ?? e}`);
        return decision;
      }
    });
  } catch (e) {
    mark('recall', `apply failed: ${e?.message ?? e}`);
    ctx.logger?.('dsh-mind').warn(`dsh-mind-recall: apply 失败（已忽略）：${e?.message ?? e}`);
  }
}
