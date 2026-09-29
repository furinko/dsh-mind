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
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');

// ── 让 `hostImport` 能解析上游：把 `process.argv[1]` 指到**宿主入口**────────────
// 上游 `createUserMessage` 是构造注入消息的必要条件；解析不到 ⇒ 本测试无从验形态。
//
// ⚠️ 2026-09-29 补：**真实客户端的宿主包在 `app.asar` 里**，普通 node 解析不到
//   （实测 `createRequire(asar 入口).resolve('@deepseek-ai/dsh-llm')` ⇒ MODULE_NOT_FOUND），
//   于是这条"最贵的判据"长期在默认环境下被**响亮跳过**。
//   解法：**用客户端自己的 Electron node 模式**（`ELECTRON_RUN_AS_NODE=1`）重跑本文件——
//   Electron 内置 asar 支持，同一个基准就能解析到宿主包（实测 resolved ✅）。
//   优先级：显式 env > `$DSH_HOME` 的 dsh CLI > 包根上溯 > 客户端 asar 内宿主入口。

/** 宿主入口候选（判据＝**能不能从这个基准解析到上游**，不是路径存在与否 —— asar 需穿透）。 */
function hostCandidates() {
  const out = [];
  const explicit = process.env.DSH_MIND_TEST_HOST;
  if (explicit) out.push(explicit);
  const dshHome = process.env.DSH_HOME;
  if (dshHome) out.push(join(dshHome, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  let cur = PKG;
  for (let i = 0; i < 6; i += 1) {
    out.push(join(cur, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  // 官方客户端的宿主入口（在 app.asar 内；只有 Electron node 模式能解析）
  out.push(join(PKG, '..', 'resources', 'app.asar', 'dsh', 'node_modules',
    '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js'));
  return out;
}

/** 该路径能否作为解析基准（能解析到 `@deepseek-ai/dsh-llm` ⇒ 注入形态可验）。 */
function usableAsBase(p) {
  if (!p) return false;
  try {
    createRequire(p).resolve('@deepseek-ai/dsh-llm');
    return true;
  } catch { return false; }
}

function findHostEntry() {
  for (const c of hostCandidates()) if (usableAsBase(c)) return c;
  return null;
}

/** 客户端可执行文件（判据：同级有 `resources/app.asar`）。 */
function findClientExe() {
  const root = resolve(PKG, '..');
  if (!existsSync(join(root, 'resources', 'app.asar'))) return null;
  try {
    for (const e of readdirSync(root)) {
      if (!e.toLowerCase().endsWith('.exe')) continue;
      if (/^uninstall/i.test(e)) continue;
      return join(root, e);
    }
  } catch { /* 读不到目录 ⇒ 无客户端 */ }
  return null;
}

let hostEntry = findHostEntry();

// 普通 node 解析不到宿主上游，但本机有客户端 ⇒ 用 Electron node 模式自举重跑
// （`stdio: 'inherit'`：沙箱下管道捕获会 EPERM，且要保留彩色/流式输出）。
if (!hostEntry && !process.env.DSH_MIND_WF_RELAUNCHED) {
  const exe = findClientExe();
  const asarEntry = hostCandidates().at(-1);
  if (exe) {
    console.log('普通 node 解析不到宿主上游（宿主包在 app.asar 内）');
    console.log(`⇒ 用客户端 Electron node 模式重跑：${exe}\n`);
    const r = spawnSync(exe, [fileURLToPath(import.meta.url)], {
      stdio: 'inherit',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        DSH_MIND_WF_RELAUNCHED: '1',
        DSH_MIND_TEST_HOST: asarEntry,
      },
    });
    process.exit(typeof r.status === 'number' ? r.status : 1);
  }
}

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
// ⚠️ `MIND_MARKET_DIR` 必须在册并指到临时根（2026-09-29 修）：本文件会**真跑 apply**，
//    而 `mark()` 落 `profileDir()/.dsh-market` —— 只隔离 MIND_HOME 的话，marker 会写到
//    **真实用户目录**（实测：跑一次就改写 `~/.dsh/profiles/dshome/.dsh-market/` 的三处留痕）。
const ENV_KEYS = ['MIND_HOME', 'DSH_HOME', 'DSH_PROFILE_DIR', 'MIND_PROFILE_DIR', 'MIND_MARKET_DIR'];
const saved = {}; for (const k of ENV_KEYS) saved[k] = process.env[k];
for (const k of ENV_KEYS) delete process.env[k];
process.env.MIND_HOME = tmp;
process.env.MIND_MARKET_DIR = join(tmp, '.dsh-market');

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

  // ── 消息形态硬契约（2026-09-29 实机两次翻车换来的判据）──────────────────────
  // ① 缺顶层 `source` ⇒ 宿主 `message.source.kind` 处炸（undefined.kind）
  // ② `kind:'plugin'` 在 **0.2.0 的 V4 被明确拒绝**（producer-owned source kind）
  // ⇒ 断言每条注入消息都带**合法形态**的 source，且**绝不出现裸 `plugin`**。
  const isPluginSource = (s) => s?.kind === 'plugin' || (typeof s?.kind === 'string' && s.kind.startsWith('plugin:'));
  const injected = (full?.messages ?? []).filter((m) => isPluginSource(m?.source));

  // 按**宿主实际会话格式**判定期望形态（本测试可能跑在 V3 或 V4 宿主上）
  const msgSourceMod = await import(pathToFileURL(join(PKG, 'lib', 'message-source.js')).href);
  const hostVer = msgSourceMod.hostVersion();
  const expectV4 = msgSourceMod.usesProducerOwnedSource(hostVer);
  console.log(`宿主版本：${hostVer ?? '(取不到)'} ⇒ 期望形态：${expectV4 ? 'V4 producer-owned' : 'V3 旧包装'}\n`);

  if (hostEntry) {
    check('确实注入了消息（plugin 来源）——否则下面的形态断言是空跑', injected.length > 0,
      `插入了 ${(full?.messages ?? []).length} 条，其中 plugin 来源 ${injected.length} 条`);
  } else {
    check('⚠️ 注入形态断言**被跳过**（未找到宿主入口）⇒ 本次结果**不构成**形态已验证', false,
      '设 DSH_MIND_TEST_HOST=<dsh 的 lib/bin.js> 后重跑');
  }
  for (const [i, m] of injected.entries()) {
    const kind = m?.source?.kind;
    check(`注入消息[${i}] 有非空 source.kind（宿主 30+ 处读它）`,
      typeof kind === 'string' && kind.length > 0, String(kind));
    if (expectV4) {
      // V4：kind 必须是 `plugin:<包名>`，且**不能有** plugin 字段
      check(`注入消息[${i}] V4：kind 形如 \`plugin:<包名>\``, typeof kind === 'string' && kind.startsWith('plugin:'), String(kind));
      check(`注入消息[${i}] V4：**没有** plugin 字段（官方 rewritePluginSource 会删掉）`, !('plugin' in (m?.source ?? {})), JSON.stringify(m?.source));
    } else {
      // V3：旧包装
      check(`注入消息[${i}] V3：kind==='plugin' 且带 plugin 字段`,
        kind === 'plugin' && typeof m?.source?.plugin === 'string', JSON.stringify(m?.source));
    }
    check(`注入消息[${i}] content 是数组且首块为 text（官方形态）`,
      Array.isArray(m?.content) && m.content[0]?.type === 'text' && typeof m.content[0]?.text === 'string',
      JSON.stringify(m?.content)?.slice(0, 100));
    check(`注入消息[${i}] 有 role=user`, m?.role === 'user', String(m?.role));
    check(`注入消息[${i}] 有 id`, typeof m?.id === 'string' && m.id.length > 0, String(m?.id));
  }
  // **跨版本不变量**：裸 `plugin` 只在 V3 合法
  if (expectV4) {
    check('**V4 不变量**：注入消息里不出现裸 kind=`plugin`（0.2.0 会硬拒）',
      injected.every((m) => m?.source?.kind !== 'plugin'),
      JSON.stringify(injected.map((m) => m?.source)));
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
