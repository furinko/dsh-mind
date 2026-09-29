// test/pre-step-waterfall.mjs — 忠实模拟宿主的 `agent/pre-step` 瀑布，找出谁返回了 undefined。
//
// 宿主契约（`dsh-agent-loop/lib/index.js` 实测原文）：
//     const decision = await dispatch.waterfall("agent/pre-step", payload, () => Promise.resolve({
//         kind: "enter", messages: ...
//     }));
//     if (decision.kind === "reject") ...          // ← decision 为 undefined 时在这里炸
//
// ⇒ **任何 handler 返回 undefined，都会让整个回合在初始化阶段报
//    「Cannot read properties of undefined (reading 'kind')」**
//
// 用法：node test/pre-step-waterfall.mjs
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');

// ── 让 `hostImport` 能解析上游：把 `process.argv[1]` 指到**宿主入口**────────────
// 上游 `createUserMessage` 是构造注入消息的必要条件；解析不到 ⇒ 本测试无从验形态。
// 查找顺序：显式环境变量 > `$DSH_HOME` 下的 dsh CLI > 从包根往上找。
// **找不到就响亮跳过**（不静默当通过，Invariants #14）。
function findHostEntry() {
  const explicit = process.env.DSH_MIND_TEST_HOST;
  if (explicit && existsSync(explicit)) return explicit;
  const dshHome = process.env.DSH_HOME;
  if (dshHome) {
    const p = join(dshHome, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    if (existsSync(p)) return p;
  }
  let cur = PKG;
  for (let i = 0; i < 6; i += 1) {
    const p = join(cur, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    if (existsSync(p)) return p;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}
const hostEntry = findHostEntry();
const REAL_ARGV1 = process.argv[1];
if (hostEntry) {
  process.argv[1] = hostEntry;   // host-resolve 以此为解析基准
  console.log(`宿主入口（供上游解析）：${hostEntry}\n`);
} else {
  console.log('⚠️ **未找到宿主入口** ⇒ 上游 createUserMessage 解析不到，');
  console.log('   注入形态断言将**响亮跳过**（设 DSH_MIND_TEST_HOST 指向 dsh 的 lib/bin.js 可启用）\n');
}

let pass = 0;
const fails = [];
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fails.push(name); console.log(`  ✗ ${name}${detail ? '  → ' + detail : ''}`); }
};

/** 忠实模拟 cordis 的 waterfall：handler(payload, next)，next() 取下游结果。 */
function makeWaterfall(handlers, base) {
  return async function run(payload) {
    let i = 0;
    const next = async () => {
      if (i >= handlers.length) return base();
      const h = handlers[i];
      const idx = i;
      i += 1;
      const r = await h(payload, next);
      if (process.env.DSH_MIND_WF_DEBUG) {
        console.log(`[debug]   handler[${idx}] ${h.__nm ?? '?'} → messages=${(r?.messages ?? []).length} kind=${r?.kind} undefined=${r === undefined}`);
      }
      return r;
    };
    return next();
  };
}

/** 造一个假 ctx，记录各事件的 handler。 */
function fakeCtx(extra = {}) {
  const on = new Map();
  const registeredTools = [];
  return {
    handlers: on,
    registeredTools,
    on: (ev, fn) => { if (!on.has(ev)) on.set(ev, []); on.get(ev).push(fn); return () => {}; },
    get: () => undefined,
    effect: () => {},
    logger: () => ({ warn: () => {}, info: () => {} }),
    tools: {
      register: (t) => { registeredTools.push(t); },
      guard: () => {},
    },
    subagents: {},
    ...extra,
  };
}

const tmp = mkdtempSync(join(tmpdir(), 'dshmind-wf-'));
const ENV_KEYS = ['MIND_HOME', 'DSH_HOME', 'DSH_PROFILE_DIR', 'MIND_PROFILE_DIR'];
const saved = {}; for (const k of ENV_KEYS) saved[k] = process.env[k];
for (const k of ENV_KEYS) delete process.env[k];
process.env.MIND_HOME = tmp;

try {
  // 造最小私有区（让 recall 有东西可读，走"真注入"路径）
  mkdirSync(join(tmp, 'mind', 'L0'), { recursive: true });
  mkdirSync(join(tmp, 'mind-private', 'L1'), { recursive: true });
  mkdirSync(join(tmp, 'mind-private', 'L0'), { recursive: true });
  mkdirSync(join(tmp, 'mind-private', 'L3', 'common', 'lessons'), { recursive: true });
  writeFileSync(join(tmp, 'mind', 'L0', 'SOUL.md'), '# SOUL\n测试人格', 'utf8');
  writeFileSync(join(tmp, 'mind', 'L0', 'AGENTS.md'), '# AGENTS\n测试纪律', 'utf8');
  writeFileSync(join(tmp, 'mind-private', 'L1', 'Learn.md'), '- [2026-01-01] 教训\n', 'utf8');

  // 逐插件 apply，收集它们的 pre-step handler
  const PLUGINS = ['inject', 'recall', 'connect', 'skill-loader', 'mood', 'session-budget'];
  const allHandlers = [];
  for (const name of PLUGINS) {
    const mod = await import(pathToFileURL(join(PKG, 'lib', 'host', `${name}.js`)).href);
    const ctx = fakeCtx();
    try { mod.apply(ctx); } catch (e) { check(`${name}.apply 不抛`, false, e?.message); }
    const hs = ctx.handlers.get('agent/pre-step') || [];
    for (const h of hs) allHandlers.push({ name, h });
  }
  console.log(`\n收集到 ${allHandlers.length} 个 agent/pre-step handler：${allHandlers.map((x) => x.name).join(', ')}\n`);

  // 真跑一次瀑布
  const base = () => Promise.resolve({ kind: 'enter', messages: [] });
  /** 造一个"干净会话"的 payload（每次换 id ⇒ 不撞 per-session 注入状态）。 */
  const payloadFor = (sid) => ({
    agent: { session: { header: { id: sid, cwd: process.cwd() }, surface: { replaceGeneration: 0, nodes: [] }, eventAt: () => undefined } },
    messages: [],
    turn: 1,
    step: 1,
    signal: { throwIfAborted: () => {} },
  });

  // ⚠️ **顺序有讲究**：注入是"每会话每代次一次"，先跑隔离会把状态消耗掉 ⇒ 全链就看不到注入。
  //   所以**先跑全链**（新会话 id），再跑隔离（各用独立 id）。
  let full;
  try { full = await makeWaterfall(allHandlers.map((x) => x.h), base)(payloadFor('probe-full')); }
  catch (e) { check('全链瀑布不抛', false, `${e?.name}: ${e?.message}`); }
  if (process.env.DSH_MIND_WF_DEBUG) {
    console.log('\n[debug] 全链结果 messages 数 =', (full?.messages ?? []).length);
    for (const [i, m] of (full?.messages ?? []).entries()) {
      console.log(`[debug]   [${i}] role=${m?.role} source=${JSON.stringify(m?.source)}`);
    }
    console.log('');
  }

  // 逐个 handler 单独跑（隔离归因；各用独立会话 id 避免互相干扰）
  for (const { name, h } of allHandlers) {
    let out;
    try { out = await makeWaterfall([h], base)(payloadFor(`probe-${name}`)); }
    catch (e) { check(`${name} 的 handler 不抛`, false, `${e?.name}: ${e?.message}`); continue; }
    check(`${name} 的 handler 返回**非 undefined**（undefined 会让宿主在 decision.kind 处炸）`,
      out !== undefined, `返回了 ${out}`);
    if (out !== undefined) {
      check(`${name} 的返回值带 kind`, typeof out?.kind === 'string', JSON.stringify(out)?.slice(0, 80));
    }
  }

  check('全链瀑布返回非 undefined', full !== undefined, `返回了 ${full}`);
  if (full !== undefined) {
    check('全链返回值带 kind=enter（宿主据此判断继续）', full?.kind === 'enter', JSON.stringify(full)?.slice(0, 120));
    check('全链返回值带 messages 数组', Array.isArray(full?.messages), typeof full?.messages);
  }

  // ── 消息形态硬契约（2026-09-29 实机崩溃换来的判据）──────────────────────────
  // 宿主有 30+ 处读 `message.source.kind`；缺 source ⇒ `undefined.kind` ⇒ **整个回合作废**。
  // 这条断言就是当时缺的那一轴：只验了"返回非 undefined"，没验"消息形态对不对"。
  const injected = (full?.messages ?? []).filter((m) => m?.source?.kind === 'plugin');
  if (hostEntry) {
    check('确实注入了消息（source.kind=plugin）——否则下面的形态断言是空跑', injected.length > 0,
      `插入了 ${(full?.messages ?? []).length} 条，其中 plugin 来源 ${injected.length} 条`);
  } else {
    check('⚠️ 注入形态断言**被跳过**（未找到宿主入口）⇒ 本次结果**不构成**形态已验证', false,
      '设 DSH_MIND_TEST_HOST=<dsh 的 lib/bin.js> 后重跑');
  }
  for (const [i, m] of injected.entries()) {
    check(`注入消息[${i}] 有顶层 source.kind（宿主 30+ 处读它）`, typeof m?.source?.kind === 'string', JSON.stringify(m)?.slice(0, 100));
    check(`注入消息[${i}] 有 source.plugin（可归属）`, typeof m?.source?.plugin === 'string', String(m?.source?.plugin));
    check(`注入消息[${i}] content 是数组且首块为 text（官方形态）`,
      Array.isArray(m?.content) && m.content[0]?.type === 'text' && typeof m.content[0]?.text === 'string',
      JSON.stringify(m?.content)?.slice(0, 100));
    check(`注入消息[${i}] 有 role=user`, m?.role === 'user', String(m?.role));
    check(`注入消息[${i}] 有 id`, typeof m?.id === 'string' && m.id.length > 0, String(m?.id));
  }
  // 反向：不许有"没有 source"的消息混进来
  const noSource = (full?.messages ?? []).filter((m) => m && (m.source === undefined || m.source === null));
  check('**没有**缺 source 的消息混入（否则宿主 message.source.kind 必炸）', noSource.length === 0,
    `${noSource.length} 条缺 source`);
} finally {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'}  ${pass}/${pass + fails.length}`);
if (fails.length) { console.log('失败项：\n  - ' + fails.join('\n  - ')); process.exit(1); }
