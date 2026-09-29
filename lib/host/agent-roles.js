// lib/host/agent-roles.js — 角色卡 → 独立 persona 子代理。
//
// ── 为什么需要 ────────────────────────────────────────────────────────────────
//   官方团队插件给不了"**每个成员独立系统提示词**"——它按 Team membership 装同一套工具 +
//   同一段 POLICY（persona 是部署级一份）。本插件把「角色卡」接到 DSH 原生子代理接缝上：
//   卡正文 → `request.persona`（真替换部署 persona）；卡 tools → `request.toolFilter`；
//   卡 model → `request.agentOptions`。
//
// ── 三把工具（**成员线**）─────────────────────────────────────────────────────
//   role_list（查卡池）· role_spawn（派成员）· role_send（给成员发消息）
//   另有**卡线**（role_card_*）属"自动调优卡片"的进阶能力，v1 不含。
//
// ── 两道闸（缺一不可）─────────────────────────────────────────────────────────
//   ① `toolFilter`（**可见面**）：`childCtx.tools.restrict()` 收窄继承来的工具。
//   ② **执行期 guard**：restrict **不过滤 scope 自己注册的工具**（官方语义），而 `subagent`
//      是按每个 agent 自己的 scope 注册的 ⇒ 光靠 ① 拦不住"成员再起成员"。②在**调用期**拦。
//      —— 这是本插件存在的关键理由，删了它"成员不得再起成员"就是空话。
//
// ── 边界（诚实标注）─────────────────────────────────────────────────────────
//   卡正文 = 成员的**系统提示词**，改卡影响之后起的成员（已起的不受影响）。
//   全程 fail-open；工具内部错误返回结构化值，不抛穿工具边界。

import { existsSync, readFileSync, readdirSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { mindDir, privateDir, marketDir } from '../paths.js';
import { mark } from '../diag.js';
import { fmValue, fmArray } from '../search.js';

export const name = 'dsh-mind-agent-roles';
export const inject = ['agents', 'tools', 'subagents'];

/** 固定级联闸：成员不得再起成员/跑编排。 */
export const CASCADE_DENY = ['subagent', 'subagent_fork', 'workflow', 'ralph'];
/** 顶层（delegationDepth 0）起成员的**绝对**深度上限。传 0 会被官方直接拒。 */
export const MEMBER_MAX_DEPTH = 1;
/** 子代理 provider。 */
export const DEFAULT_PROVIDER = 'spawn';
/** 本插件自己的工具名（绝不能进子会话的 filter）。 */
export const ROLE_TOOL_NAMES = ['role_list', 'role_spawn', 'role_send'];

const DEFAULT_TASK = '请按你的角色职责执行本次任务，完成后按三段回报：做了什么 / 证据 / 未完成·存疑。';
const MEMBER_MAP_FILE = 'agent-roles-members.jsonl';

// ── 卡解析 ───────────────────────────────────────────────────────────────────

/** 卡池目录：私有卡池 + 工作区 `.agent-roles`（同 id 时工作区优先）。 */
export function cardDirs(cwd) {
  const dirs = [{ dir: join(privateDir(), 'L2', 'agents'), zone: 'private' }];
  if (cwd) dirs.push({ dir: join(cwd, '.agent-roles'), zone: 'workspace' });
  return dirs;
}

/**
 * 解析一张卡（frontmatter + 正文）。
 * @returns {{id,name,description,tools,model,persona,path}|null} 无 id 或无正文 ⇒ null
 */
export function parseCard(text, sourcePath = '') {
  const body = String(text || '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(body);
  if (!m) return null;
  const persona = m[2].trim();
  const id = fmValue(body, 'id');
  if (!id || !persona) return null;
  const allow = fmArray(body, 'allow');
  const deny = fmArray(body, 'deny');
  // 卡 model → `request.agentOptions`（2026-09-29 修：此前读了 `card.model` 却从不解析 ⇒ 死代码）
  const modelName = fmValue(body, 'model');
  const providerName = fmValue(body, 'provider');
  const model = modelName
    ? { ...(providerName ? { provider: providerName } : {}), model: modelName }
    : null;
  return {
    id,
    name: fmValue(body, 'name') || id,
    description: fmValue(body, 'description'),
    tools: { allow, deny },
    model,
    persona,
    path: sourcePath,
  };
}

/** 发现全部卡（工作区覆盖私有）。 */
export function discoverCards(cwd) {
  const byId = new Map();
  for (const { dir, zone } of cardDirs(cwd)) {
    if (!existsSync(dir)) continue;
    let names;
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.md') || n.startsWith('_')) continue;   // `_template.md` 不算卡
      let text;
      try { text = readFileSync(join(dir, n), 'utf8'); } catch { continue; }
      const card = parseCard(text, join(dir, n));
      if (card) byId.set(card.id, { ...card, zone });
    }
  }
  return [...byId.values()];
}

// ── persona 组装 ─────────────────────────────────────────────────────────────

/** 成员底线真源（`mind/L0/CREW.md`）；缺失 ⇒ 空串（不假装有）。 */
export function readCrew() {
  try {
    const f = join(mindDir(), 'L0', 'CREW.md');
    return existsSync(f) ? readFileSync(f, 'utf8').trim() : '';
  } catch { return ''; }
}

/** 成员最终 persona = 卡正文 + 成员宪法（**不可被卡覆盖**）。 */
export function composePersona(card) {
  const crew = readCrew();
  const body = card?.persona ? String(card.persona).trim() : '';
  return crew ? `${body}\n\n---\n\n${crew}` : body;
}

// ── 工具面与闸 ───────────────────────────────────────────────────────────────

/** 归一化工具名列表。 */
function toNames(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : [];
}

/**
 * 执行期闸：把「角色能力面」从**可见性**升级为**调用即拒绝**。
 * @returns {(execution:{name?:string}) => string|undefined} 返回字符串=拒绝
 */
export function buildToolGuard(tools = {}) {
  const allow = toNames(tools.allow);
  // 执行期闸的 deny = 卡内 deny ∪ 级联闸 ∪ 本插件自有工具。
  // ⚠️ 这里**可以**放"本部署不存在"的名字（如 `subagent`/`ralph`）：本闸是**按名字判定**的
  //   纯函数，调用不到的名字无副作用；而可见面 filter 下发它们会被宿主机**响亮拒绝**
  //   （见 buildToolFilter 的实测记录）。
  const deny = new Set([...toNames(tools.deny), ...CASCADE_DENY, ...ROLE_TOOL_NAMES]);
  const allowSet = allow.length > 0 ? new Set(allow) : null;
  return (execution) => {
    const n = typeof execution?.name === 'string' ? execution.name : '';
    if (!n) return undefined;
    if (deny.has(n)) return `角色能力面未放行 ${n}（级联闸或卡内 deny）`;
    if (allowSet && !allowSet.has(n)) return `角色能力面只含 ${allow.join('、')}，未放行 ${n}`;
    return undefined;
  };
}

/**
 * 可见面 filter（喂 `request.toolFilter`）。
 *
 * ⚠️ **只下发"必然存在"的名字**（2026-09-29 真触发抓到，最严重的一条）：
 * 宿主 `restrict()` 对**未知全局工具名是响亮拒绝**——实测原文
 *   `tools.restrict() names unknown global tools "subagent", "ralph"; known global tools: …`
 * ⇒ 只要把 `CASCADE_DENY` 下发进 filter，`role_spawn` 就**直接失败、成员永远起不来**
 * （本机这份运行时没有 `subagent` 也没有 `ralph`；`subagent_fork`/`workflow` 才有）。
 *
 * 所以：filter 只放 **卡内显式声明** + **本插件自有的 `role_*`**（后者一定存在——刚注册成功），
 * 级联闸交给**执行期闸**兜（按名判定，不依赖名字存在）。
 * 代价（诚实标注）：`subagent_fork`/`workflow` 不再"看不见"，只是**调用即被拒**——
 * 从"可见面早挡"降级为"调用期硬拒"，闸仍在。
 */
export function buildToolFilter(card) {
  const tools = card?.tools || {};
  return {
    allow: toNames(tools.allow),
    deny: [...new Set([...toNames(tools.deny), ...ROLE_TOOL_NAMES])],
  };
}

// ── 起成员 ───────────────────────────────────────────────────────────────────

/** 成员名归一：小写、保留汉字、其余折 `-`。 */
export function sanitizeMemberName(raw) {
  return String(raw ?? '').toLowerCase().replace(/[^\u4e00-\u9fffa-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/**
 * 组装 `startContinuable` 的 spec（**纯函数**，便于断言）。
 * label 形如 `<卡名>:<成员名>`——它是子代理列表的标题，也是跨进程认人的依据。
 */
export function buildStartSpec({ parent, card, memberName, task } = {}) {
  const roleId = card?.id ? String(card.id) : 'inline';
  const cardName = (card?.name && !String(card.name).includes(':')) ? String(card.name) : roleId;
  const name = (typeof memberName === 'string' && memberName.trim()) || sanitizeMemberName(roleId) || roleId;
  const prompt = (typeof task === 'string' && task.trim()) || DEFAULT_TASK;
  const request = {
    prompt: [{ type: 'text', text: prompt }],
    parent,
    persona: composePersona(card),
    maxDepth: MEMBER_MAX_DEPTH,
  };
  const model = card?.model;
  if (model && typeof model === 'object' && Object.keys(model).length) request.agentOptions = { ...model };
  const filter = buildToolFilter(card);
  if (filter.allow.length || filter.deny.length) request.toolFilter = filter;
  return { provider: DEFAULT_PROVIDER, label: `${cardName}:${name}`, request };
}

/** 记成员归属（append-only；重启后靠它认人补闸）。 */
function appendMemberMap(entry) {
  try {
    const dir = marketDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, MEMBER_MAP_FILE), JSON.stringify(entry) + '\n', 'utf8');
  } catch { /* 归属表写失败不影响起成员 */ }
}

/**
 * 从归属表**读回** `childId -> { cardId, guard }`（跨重启补闸）。
 *
 * ⚠️ 为什么必须有（2026-09-29 修）：`state` 是进程内 Map，进程一重启就空 ⇒ 老成员
 * **永久掉闸**（老实现有 `ensureMemberGuardById` 跨进程按归属表补装；本包此前只写不读，
 * `MEMBER_MAP_FILE` 全包仅"声明 + 写"两处命中）。
 * 卡面（工具面）从当前卡池按 `cardId` 重新解析；卡池里找不到该 id（卡被退役/改名）⇒ 跳过
 * （不猜、不假装有闸）。
 * @param {Array<object>} cards 当前卡池（通常私有区；工作区卡要等有 cwd 时）
 * @returns {Map<string,{cardId:string,guard:Function}>}
 */
export function loadMemberMap(cards = []) {
  const out = new Map();
  try {
    const f = join(marketDir(), MEMBER_MAP_FILE);
    if (!existsSync(f)) return out;
    const byId = new Map((Array.isArray(cards) ? cards : []).map((c) => [c.id, c]));
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (!rec?.childId || !rec?.cardId) continue;
      const card = byId.get(String(rec.cardId));
      if (!card) continue;
      out.set(String(rec.childId), { cardId: card.id, guard: buildToolGuard(card.tools) });
    }
  } catch { /* 读不回 ⇒ 只影响跨重启补闸，不影响新派成员 */ }
  return out;
}

// ── 工具注册 ─────────────────────────────────────────────────────────────────

/**
 * 工具输出契约（**宿主硬要求**）。
 *
 * ⚠️ 2026-09-29 活体验收抓到：宿主 `dsh-tools` 的 `register()` 要求
 * `output.render` **必须是函数**，缺了直接抛
 * `tool "<名>" must declare output { schema, render, presentationMeta? }`
 * —— 三把工具**全部被拒注册**，而这在此前被 `apply failed`（`reading 'layers'`）完全掩盖。
 *
 * `schema` 只许用宿主支持的 JSON Schema 关键字：`type / oneOf / properties / required /
 * additionalProperties / items / enum / const`（注解另加 `description/title/default/examples`）。
 * 三个工具的返回值都严格是 `{ ok, text }` ⇒ `additionalProperties: false` + `required`
 * 让"将来多返回字段"这件事**响亮失败**，而不是静默漂移。
 */
const TEXT_OUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
    required: ['ok', 'text'],
  },
  render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
};

function makeTools(ctx, state) {
  const list = {
    name: 'role_list',
    description: '列出可用的角色卡（岗位）。派活前先查这里，有匹配的卡就派卡，岗位对不上才退裸 subagent。',
    parameters: { type: 'object', properties: {} },
    output: TEXT_OUT,
    async execute(_args, exec) {
      const cwd = exec?.agent?.session?.header?.cwd || '';
      const cards = discoverCards(cwd);
      const text = cards.length
        ? cards.map((c) => `- ${c.id}（${c.name}）${c.description ? '：' + c.description : ''}`).join('\n')
        : '（无角色卡）';
      return { ok: true, text };
    },
  };

  const spawn = {
    name: 'role_spawn',
    description: '按角色卡派一个成员。成员有独立系统提示词、按卡收窄的工具面、执行期闸。',
    parameters: {
      type: 'object',
      required: ['role'],
      properties: {
        role: { type: 'string', description: '角色卡 id（见 role_list）' },
        name: { type: 'string', description: '成员名（可选，进子代理列表标题）' },
        task: { type: 'string', description: '任务书（判据 / 闸门 / 不许自批）' },
      },
    },
    output: TEXT_OUT,
    async execute(args, exec) {
      const parent = exec?.agent;
      if (!parent) return { ok: false, text: '无法解析父 agent（不在 agent 上下文里）' };
      const cwd = parent?.session?.header?.cwd || '';
      const card = discoverCards(cwd).find((c) => c.id === String(args?.role ?? ''));
      if (!card) return { ok: false, text: `找不到角色卡：${args?.role}（先 role_list 看可用的）` };
      const subagents = ctx.subagents;
      if (typeof subagents?.startContinuable !== 'function') return { ok: false, text: '子代理服务不可用' };

      const spec = buildStartSpec({ parent, card, memberName: args?.name, task: args?.task });
      const started = await subagents.startContinuable({ ...spec, signal: exec?.signal });
      const childId = started?.id ?? started?.childId ?? '';
      if (childId) {
        appendMemberMap({ childId, cardId: card.id, label: spec.label, at: new Date().toISOString() });
        state.set(String(childId), { cardId: card.id, guard: buildToolGuard(card.tools) });
      }
      return { ok: true, text: `已派成员：${spec.label}${childId ? `（${childId}）` : ''}` };
    },
  };

  const send = {
    name: 'role_send',
    description: '给已派出的成员发一条消息（改需求 / 补背景）。',
    parameters: {
      type: 'object', required: ['target', 'message'],
      properties: { target: { type: 'string' }, message: { type: 'string' } },
    },
    output: TEXT_OUT,
    async execute(args, exec) {
      const sendFn = ctx.subagents?.sendMessage;
      if (typeof sendFn !== 'function') return { ok: false, text: '子代理控制服务不可用' };
      try {
        await sendFn(exec?.agent, String(args?.target ?? ''), String(args?.message ?? ''), { signal: exec?.signal });
        return { ok: true, text: `已发送给 ${args?.target}` };
      } catch (e) { return { ok: false, text: `发送失败：${e?.message ?? e}` }; }
    },
  };

  return [list, spawn, send];
}

export function apply(ctx) {
  try {
    /** childId -> { cardId, guard }。 */
    const state = new Map();
    let guardInstalled = false;

    // 跨重启补闸：从归属表读回（apply 期只有私有卡池可用；工作区卡要等 spawn 时的 cwd）。
    try {
      for (const [k, v] of loadMemberMap(discoverCards(''))) state.set(k, v);
    } catch { /* 读不回 ⇒ 只影响跨重启补闸 */ }

    // ── 执行期闸（2026-09-29 重做）──────────────────────────────────────────
    // 老做法＝"每个成员注册一次 `ctx.tools.guard(rec.guard)`"，两个真问题：
    //   ① **scope 污染**：guard 是**插件级**注册，回调对所有会话生效 ⇒ 成员 A 的闸会把
    //      主会话/成员 B 的工具调用一起拦（拦错人）。
    //   ② **时序倒置**：它挂在 `agent/created` 上，而该事件在 `startContinuable` **内部**
    //      就派发完了（那时 `state` 还没写）⇒ 处理器恒早退、**闸根本没装上**——
    //      文件头那句"删了它『成员不得再起成员』就是空话"于是真的成了空话。
    // 现在：**注册一次**，回调里按 `execution.agent.session.header.id` 查 `state`；
    // 非本插件派的成员 ⇒ 放行（不误伤）。与时序无关（成员调工具必在 spawn 返回之后）。
    const installGuardOnce = () => {
      if (guardInstalled) return true;
      if (typeof ctx.tools?.guard !== 'function') return false;
      guardInstalled = true;
      // ⚠️ **必须作为方法直接调用**（`ctx.tools.guard(fn)`）。
      //    先取出来（`const g = ctx.tools.guard; g(fn)`）是脱离 `this` 的裸调用，
      //    guard 内部读 `this.layers` 会当场炸（`Cannot read properties of undefined
      //    (reading 'layers')`）——炸了又被 apply 的 catch 吞掉 ⇒ **整个插件静默停用**
      //    （三把工具一个都没注册）。guard.js 文件头早有同款警告，本处 2026-09-29
      //    由**活体验收**当场抓到（marker: `apply failed: ... reading 'layers'`）。
      ctx.tools.guard((execution) => {
        try {
          const id = String(execution?.agent?.session?.header?.id ?? '');
          if (!id) return undefined;
          const rec = state.get(id);
          if (!rec) return undefined;            // 不是本插件派的成员 ⇒ 放行
          return rec.guard(execution);
        } catch { return undefined; }            // fail-open
      });
      return true;
    };
    const installed = installGuardOnce();
    mark('agent-roles', installed
      ? `apply: 执行期闸已装（按 agent id 判定；重启补闸 ${state.size} 人）`
      : 'apply: ctx.tools.guard 不可用 ⇒ 执行期闸未装（fail-open）');

    const tools = ctx.tools;
    if (typeof tools?.register !== 'function') {
      mark('agent-roles', 'apply: ctx.tools.register 不可用（插件停用）');
      return;
    }
    let failedRegs = 0;
    for (const t of makeTools(ctx, state)) {
      try { tools.register(t); } catch (e) {
        failedRegs += 1;
        mark('agent-roles', `register ${t.name} 失败：${e?.message ?? e}`);
      }
    }
    // ⚠️「mounted」必须**只在真装上时**打（2026-09-29 修）：此前 register 失败也算 mounted
    //   ⇒ marker 上一行「mounted」下一行「register 失败」，看着像成功（假绿）。
    mark('agent-roles', failedRegs
      ? `apply: **部分挂载**（${failedRegs}/${ROLE_TOOL_NAMES.length} 把注册失败，工具实际不可用）`
      : `apply: mounted（tools=${ROLE_TOOL_NAMES.join('/')}）`);
  } catch (e) {
    mark('agent-roles', `apply failed: ${e?.message ?? e}`);
    ctx.logger?.('dsh-mind').warn(`dsh-mind-agent-roles: apply 失败（已忽略）：${e?.message ?? e}`);
  }
}
