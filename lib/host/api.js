// lib/host/api.js — 前端配套（**host 半**）：只读状态 API + 「接入心智」开关 + 链路自检。
//
// ── 为什么单独一个插件 ────────────────────────────────────────────────────────
//   `connect.js` 的头部一直写着"拿不到 webServer 也能工作（**只是没面板入口**）"——
//   本插件就是那个入口的 host 半。面板要有东西可看，而心智的事实**全在盘上**
//   （marker 环 / 私有区文件 / 固件就位情况），故本层做四件事：
//     ① 把盘上的事实读成 JSON（`/api/mind/status`、`/api/mind/tree`、`/api/mind/file`）
//     ② 转发那个开关（`/api/mind/connect`，逻辑仍在 `connect.js`，此处不复制一份）
//     ③ 读**官方启动图**（`/api/mind/boot` → `clientModules.graph()`）：我的浏览器半在不在图里
//     ④ 收**浏览器自报**（`/api/mind/beacon`）：apply → slot → render → error 走到哪一格
//
// ── ⚠️ 曾经的错与正确姿势（2026-10-03 实测订正，别回退）──────────────────────
//   浏览器半**不走自托管**：官方 `dsh.client` 声明就够——`dsh-client-modules` 会扫 Loader
//   条目里的 `dsh.client`、自行编入启动图、自行服务 `/plugins/<id>/client.js`（combo 批次）。
//
//   我一度照抄第三方插件的"自托管 + `tapIndex` 注 boot 行"，结论是**它在本版外壳上是死路**：
//   本版启动清单是**对象** `{rev, entries, batches}`（`parseBootManifest` 逐字校验），
//   而那份实现第一句是 `if (!Array.isArray(graph)) return html` ⇒ **静默 no-op**；
//   更糟的是 marker 照样写 `client=ok 21049B`（**假绿**），面板从没被加载却"看起来验过了"。
//   ⇒ 纪律：**别信第三方注释里的"实测可用"**（那插件自己也可能是坏的），去读外壳源码/契约。
//
// ── 边界（诚实标注，别读成"忘了做"）──────────────────────────────────────────
//   · **只读 + 一个开关写口**。不提供裁决/放行入口（本包 guard 没有放行通道，`DESIGN §七`）、
//     不改记忆（增删改待办/记忆**不在本包**，`DESIGN §一`）。
//   · **隐私**：只服务 loopback 同源请求（`isTrustedLocalRequest`，与完整版同判据）。
//     ⚠️ 该判据**要求** `Sec-Fetch-Site: same-origin|none`（无 `Origin` 时）——浏览器同源
//     fetch 天然带上；**curl 之类的裸请求必须自己加这个头**，否则 403（这是闸在工作，不是坏了）：
//       curl -H 'Sec-Fetch-Site: same-origin' http://127.0.0.1:19387/api/mind/status
//     文件口只认 `.md/.json/.txt/.yml` 且 resolve 后必须落在 `mind/` 或 `mind-private/` 内
//     （目录穿越在 `resolveZonePath` 里挡死）。
//   · **fail-open**：任一路由注册失败只 warn，绝不断插件加载。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataRoot, mindDir, privateDir, profileDir, marketDir } from '../paths.js';
import { mark, readMark } from '../diag.js';
import { bootstrapStatus } from '../bootstrap.js';
import { isConnected, setConnected, offCount, offSessions } from './connect.js';

export const name = 'dsh-mind-api';

/** 缺 `webServer` 的部署（headless）⇒ 本插件不激活，别拖累其余 9 个。 */
export const inject = ['webServer'];

/** 本层登记的全部路由（供自测断言"路由集合"本身，而不只是"handler 能跑"）。
 *  ⚠️ 这里**没有** `/dsh-mind/client.js`：浏览器包走官方通道（`dsh.client` → client-modules
 *  自行服务 `/plugins/<id>/client.js`），自托管那条已删（见 apply 末尾注释）。 */
export const ROUTE_SPECS = [
  { kind: 'exact', path: '/api/mind/status' },
  { kind: 'exact', path: '/api/mind/tree' },
  { kind: 'exact', path: '/api/mind/file' },
  { kind: 'exact', path: '/api/mind/connect' },
  { kind: 'exact', path: '/api/mind/boot' },
  { kind: 'exact', path: '/api/mind/beacon' },
];

/** 浏览器半的 id：**官方启动图里的 entry id 就是包名**（`client-modules` 按 Loader 条目的包名编图）。 */
export const CLIENT_ID = 'dsh-mind';

/** 面板要读的 marker 名单（**多一个少一个都是缺陷**，自测对着它点名）。 */
export const MARKERS = [
  'inject', 'recall', 'connect', 'guard', 'skill-loader',
  'compaction-log', 'mood', 'session-budget', 'agent-roles', 'api',
];

/**
 * **沉默属设计**的插件：它们的 marker 只在"真有事发生"时才有运行行，
 * 零运行读数**不构成**"挂载 ≠ 生效"的证据。
 *
 * 为什么单列（2026-09-30）：v1 一律按"零运行读数 ⇒ 警告"报，于是 `guard` 被误报——
 * 而 guard 只在**拦截**时留痕，"没拦过"是正常态。误报会训练主人忽略警告，比不报更糟。
 * ⇒ 这一类降级为**说明**（不是把结论删掉）；而 `mood`/`session-budget`/`compaction-log`
 * 那类"每一轮/每次压缩都该留痕却没有"的沉默，仍然算**警告**。
 */
export const SILENT_BY_DESIGN = {
  connect: '只在被「接入开关」调用时留痕——没人点过就没有运行行',
  api: '只在被浏览器请求时留痕——面板没打开过就没有运行行',
  guard: '只在**拦截**时留痕 ⇒ 零运行读数＝还没拦过，不代表护栏没装',
};

/** 文件口的扩展名白名单（只读文本；不进二进制/凭据类扩展名）。 */
const READ_EXT = ['.md', '.json', '.txt', '.yml', '.yaml'];
/** 单文件读取上限（超出截断并如实标注）。 */
const MAX_FILE_BYTES = 128 * 1024;
/** 树的口径：深度与条数上限（防止把一个巨库一次吐给浏览器）。 */
const TREE_MAX_DEPTH = 4;
const TREE_MAX_ENTRIES = 400;

// ── 信任闸（与完整版 `dshome-mind-connect` 同判据：loopback 地址 + loopback Host + 同源）──

function isIPv4Loopback(v4) {
  const parts = String(v4).split('.');
  return parts.length === 4 && parts[0] === '127'
    && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** 远端地址是否 loopback（含 `::1` 与 `::ffff:127.x`）。 */
export function isLoopbackAddress(address) {
  if (address === undefined) return false;
  const n = String(address).toLowerCase();
  if (n === '::1') return true;
  if (n.startsWith('::ffff:')) return isIPv4Loopback(n.slice(7));
  return isIPv4Loopback(n);
}

/** Host 头是否是 loopback（防 DNS rebinding）。 */
export function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  return isIPv4Loopback(hostname);
}

/**
 * 该请求是否可信（loopback + 同源）。
 * 判据逐条照抄完整版**实测可用**的那份，别自创：丢任何一条都等于把心智数据开了个对外口。
 */
export function isTrustedLocalRequest(request) {
  try {
    if (!isLoopbackAddress(request?.socket?.remoteAddress)) return false;
    const host = request?.headers?.host;
    if (typeof host !== 'string') return false;
    let hostUrl;
    try { hostUrl = new URL('http://' + host); } catch { return false; }
    if (!isLoopbackHostname(hostUrl.hostname)) return false;
    const site = request.headers['sec-fetch-site'];
    if (site === 'cross-site') return false;
    const origin = request.headers.origin;
    if (origin === undefined) return site === 'same-origin' || site === 'none';
    try { return new URL(origin).host === hostUrl.host; } catch { return false; }
  } catch { return false; }
}

// ── 路由小工具 ────────────────────────────────────────────────────────────────

function json(res, status, body) {
  try {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(body));
  } catch { /* 连接已断 ⇒ 无所谓 */ }
}

function readJsonBody(req, limit = 65536) {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body-too-large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('bad-json')); }
    });
    req.on('error', reject);
  });
}

// ── 盘上事实 → JSON ───────────────────────────────────────────────────────────

/** 递归列文件（只 md/json/txt/yml；失败即空，不抛）。 */
function listFiles(dir, depth = 0, out = []) {
  if (depth > TREE_MAX_DEPTH || out.length >= TREE_MAX_ENTRIES) return out;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (out.length >= TREE_MAX_ENTRIES) break;
    const p = join(dir, e.name);
    if (e.isDirectory()) { listFiles(p, depth + 1, out); continue; }
    if (!e.isFile()) continue;
    const lower = e.name.toLowerCase();
    if (!READ_EXT.some((x) => lower.endsWith(x))) continue;
    try {
      const st = statSync(p);
      out.push({ path: p, bytes: st.size, mtime: st.mtimeMs });
    } catch { /* 单文件读不到就跳过 */ }
  }
  return out;
}

/** 目录下 .md 文件数（角色卡等计数用）。 */
function countMarkdown(dir) {
  return listFiles(dir, 0, []).filter((f) => f.path.toLowerCase().endsWith('.md')).length;
}

/** 私有区概览（记忆空不空、长到哪一步）。 */
function vaultOverview() {
  const priv = privateDir();
  const personaPath = join(priv, 'L0', '人设卡.md');
  const rulesPath = join(priv, 'L3', 'common', 'user-rules', 'rules.md');
  const learnPath = join(priv, 'L1', 'Learn.md');

  const sizeOf = (p) => { try { return existsSync(p) ? statSync(p).size : null; } catch { return null; } };
  const readText = (p) => { try { return existsSync(p) ? readFileSync(p, 'utf8') : ''; } catch { return ''; } };

  const topicsDir = join(priv, 'L3', 'common');
  let topics = [];
  try {
    topics = readdirSync(topicsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({ topic: e.name, files: countMarkdown(join(topicsDir, e.name)) }));
  } catch { /* 无 L3/common ⇒ 空 */ }

  const projDir = join(priv, 'L3', 'projects');
  let projects = [];
  try {
    projects = readdirSync(projDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        const md = readText(join(projDir, e.name, 'project.md'));
        return {
          key: e.name,
          todos: (md.match(/^\s*-\s*\[ \]/gm) || []).length,
          done: (md.match(/^\s*-\s*\[[xX]\]/gm) || []).length,
        };
      });
  } catch { /* 无 L3/projects ⇒ 空 */ }

  const learn = readText(learnPath);
  return {
    roleCardCount: countMarkdown(join(priv, 'L2', 'agents')),
    persona: { present: existsSync(personaPath), bytes: sizeOf(personaPath) },
    userRules: { present: existsSync(rulesPath), bytes: sizeOf(rulesPath) },
    learnCount: (learn.match(/^\s*-\s*\[/gm) || []).length,
    l3: { topics, fileCount: topics.reduce((n, t) => n + t.files, 0) },
    projects,
  };
}

/**
 * marker 环 → 读数。
 *
 * `runtime` ＝ **不是 `apply:` 开头的行数**（＝挂载之后真发生过的事）。
 * 为什么单列这一格：本包吃过"marker 里只有 `apply:` 就以为插件在工作"的亏
 * （`Learn` 2026-09-29：「假绿」族）——挂载 ≠ 生效，这格让两者在面板上分得开。
 */
function markerReadings() {
  return MARKERS.map((n) => {
    const text = readMark(n);
    const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
    const runtime = lines.filter((l) => !/^apply[:：]/.test(l));
    return {
      name: n,
      lines: lines.length,
      runtime: runtime.length,
      last: lines.length ? lines[lines.length - 1] : '',
      lastRuntime: runtime.length ? runtime[runtime.length - 1] : '',
    };
  });
}

/** 面板要看的"活体读数"：注入长度、召回长度、压缩留痕文件等。 */
function liveReadings(markers) {
  const pick = (n) => markers.find((m) => m.name === n) || { last: '', lines: 0, runtime: 0 };
  const lastLen = (n) => {
    const m = pick(n);
    const hit = /len=(\d+)/.exec(m.last || '');
    return hit ? Number(hit[1]) : null;
  };
  const logPath = join(privateDir(), 'tasks', 'compaction-log.md');
  let compactionLines = null;
  try { compactionLines = existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean).length : 0; } catch { compactionLines = null; }
  return {
    injectLen: lastLen('inject'),
    recallLen: lastLen('recall'),
    compactionLines,
  };
}

/** 由读数派生的人话警告（**通用规则**，不为某个插件写死结论）。 */
function warningsOf(markers, vault, fw) {
  const out = [];
  if (!fw?.ready) out.push(`固件未就位：缺 ${(fw?.missing || []).join('、') || '（清单为空，可疑）'}`);
  if (!fw?.firmwareAvailable) out.push('包内没有固件源（`files` 白名单漏了 `firmware/`）');
  for (const m of markers) {
    // ⚠️ "沉默属设计"的插件不进警告（见 SILENT_BY_DESIGN 的注释：误报会训练人忽略警告）
    if (m.runtime === 0 && !(m.name in SILENT_BY_DESIGN)) {
      out.push(`「${m.name}」自挂载后没有任何运行读数（挂载 ≠ 生效）`);
    }
  }
  if (vault.roleCardCount === 0) out.push('角色卡 0 张：`role_spawn` 派不出成员');
  if (!vault.persona.present) out.push('无人设卡：人格只有 SOUL 通用款');
  if (!vault.userRules.present) out.push('无 user-rules：召回里没有你的偏好那一段');
  if (vault.l3.fileCount === 0) out.push('L3 记忆为空：召回只可能带出项目档与教训');
  // 浏览器侧报错是**真故障**（不是"沉默"）⇒ 进警告
  const errBeacon = beacons.get('error');
  if (errBeacon) out.push(`浏览器半报错（${errBeacon.n} 次）：${errBeacon.detail || '无摘要'}`);
  return out;
}

/** 沉默但**属设计**的那些 ⇒ 降级成"说明"（结论不删，只是不当成故障）。 */
function notesOf(markers) {
  const out = [];
  for (const m of markers) {
    if (m.runtime === 0 && (m.name in SILENT_BY_DESIGN)) {
      out.push(`「${m.name}」零运行读数属正常：${SILENT_BY_DESIGN[m.name]}`);
    }
  }
  // 浏览器自报的链路走到了哪一步（把"看不见"拆成可定位的四格）
  const chain = [
    ['apply', '模块与 apply 跑起来了'],
    ['slot', '槽位注册成功'],
    ['render', '组件真的渲染了'],
  ];
  const reached = chain.filter(([k]) => beacons.has(k)).map(([k, label]) => `${k}（${label}）`);
  const missing = chain.filter(([k]) => !beacons.has(k)).map(([k]) => k);
  if (reached.length && missing.length) {
    out.push(`浏览器自报：已到 ${reached.join(' → ')}；**未到** ${missing.join('、')} ⇒ 断点就在这两格之间`);
  } else if (missing.length === chain.length) {
    out.push('浏览器自报：一格都没到 ⇒ 浏览器半没被执行（看 /api/mind/boot 的 hasSelf；也可能是页面没刷新）');
  }
  return out;
}

/** 全量状态（面板一次拿全）。 */
export function collectStatus() {
  const fw = bootstrapStatus();
  const markers = markerReadings();
  const vault = vaultOverview();
  return {
    ok: true,
    at: new Date().toISOString(),
    /** 路由命中计数（我这边被浏览器调用的次数）。 */
    hits: Object.fromEntries(hits),
    /** 浏览器自报的链路里程碑（apply / slot / render / error），见 `noteBeacon`。 */
    clientBeacons: Object.fromEntries([...beacons].map(([k, v]) => [k, { n: v.n, first: v.first, detail: v.detail }])),
    /** 浏览器半**执行并 apply** 过（最强的那一格；比"取过包"更硬）。 */
    clientApplied: beacons.has('apply'),
    paths: {
      dataRoot: dataRoot(),
      mindDir: mindDir(),
      privateDir: privateDir(),
      profileDir: profileDir(),
      marketDir: marketDir(),
    },
    firmware: fw,
    connect: { offCount: offCount(), offSessions: offSessions() },
    vault,
    markers,
    live: liveReadings(markers),
    warnings: warningsOf(markers, vault, fw),
    notes: notesOf(markers),
  };
}

/**
 * 把 `zone` + `rel` 解析成一个**允许读**的绝对路径。
 * 返回 `{ ok:true, path }` 或 `{ ok:false, error }`——错误字符串会原样回给浏览器（不泄露别的）。
 * 挡：未知 zone / 绝对路径 / `..` 穿越 / 越出 zone 根 / 非白名单扩展名。
 */
export function resolveZonePath(zone, rel) {
  const root = zone === 'mind' ? mindDir() : (zone === 'private' ? privateDir() : null);
  if (!root) return { ok: false, error: 'zone must be mind|private' };
  const raw = String(rel ?? '').trim();
  if (!raw) return { ok: false, error: 'rel is required' };
  if (raw.includes('\0')) return { ok: false, error: 'bad rel' };
  if (resolve(raw) === resolve(root)) return { ok: false, error: 'rel must be a file' };
  if (/^([a-zA-Z]:|[\\/])/.test(raw)) return { ok: false, error: 'rel must be relative' };

  const abs = resolve(join(root, raw));
  const normRoot = resolve(root).replace(/[\\/]+$/, '');
  const normAbs = abs.replace(/[\\/]+$/, '');
  const inside = normAbs.toLowerCase() === normRoot.toLowerCase()
    || normAbs.toLowerCase().startsWith(normRoot.toLowerCase() + sep);
  if (!inside) return { ok: false, error: 'outside zone' };

  const lower = normAbs.toLowerCase();
  if (!READ_EXT.some((x) => lower.endsWith(x))) return { ok: false, error: 'extension not readable' };
  return { ok: true, path: abs };
}

/** 读一个 zone 内的文本文件（截断并如实标注）。 */
export function readZoneFile(zone, rel) {
  const r = resolveZonePath(zone, rel);
  if (!r.ok) return { ok: false, error: r.error };
  try {
    if (!existsSync(r.path) || !statSync(r.path).isFile()) return { ok: false, error: 'not a file' };
    const st = statSync(r.path);
    const buf = readFileSync(r.path);
    const truncated = st.size > MAX_FILE_BYTES;
    const text = truncated ? buf.subarray(0, MAX_FILE_BYTES).toString('utf8') : buf.toString('utf8');
    return { ok: true, zone, rel: String(rel), bytes: st.size, truncated, text };
  } catch (e) {
    return { ok: false, error: `read failed: ${e?.message ?? e}` };
  }
}

/** 列一个 zone 内的可读文件（面板左侧的清单）。 */
export function listZone(zone) {
  const root = zone === 'mind' ? mindDir() : (zone === 'private' ? privateDir() : null);
  if (!root) return { ok: false, error: 'zone must be mind|private' };
  const files = listFiles(root).map((f) => ({
    rel: f.path.slice(root.length + 1).split(sep).join('/'),
    bytes: f.bytes,
    mtime: f.mtime,
  }));
  return { ok: true, zone, files, truncated: files.length >= TREE_MAX_ENTRIES };
}

// ── 插件主体 ─────────────────────────────────────────────────────────────────

/** 浏览器包路径（`client/` 与 `lib/` 平级——**不同运行期分目录**，自测也按这条盯着）。 */
export const CLIENT_FILE = fileURLToPath(new URL('../../client/client.js', import.meta.url));

/**
 * 路由命中计数（**每进程内存态，重启归零**）。
 *
 * 为什么需要它：后端看不见浏览器。每次浏览器调用我的路由都在这里记一笔，
 * `status.hits` 给出读数；首次命中写一行 marker（只写一次，避免 15s 轮询把环刷满）。
 * ⚠️ 但"取过我的路由"≠"面板出来了"——真正的证据是浏览器自报（见 `noteBeacon`）。
 */
const hits = new Map();

function noteHit(path) {
  const n = (hits.get(path) || 0) + 1;
  hits.set(path, n);
  if (n === 1) mark('api', `hit: ${path}（浏览器侧首次命中）`);
  return n;
}

/**
 * 浏览器自报（beacon）计数：`what -> {n, first, detail}`。
 *
 * 这一格治的是**静默失效**：链路任何一环断掉（模块没加载 / 槽位不存在 / 组件抛错），
 * 后端看到的都只是"没事发生"。现在每一环都留痕，且**第一次**到达时写 marker。
 */
const beacons = new Map();

function noteBeacon(what, detail) {
  const key = (String(what || '').slice(0, 40) || 'unknown');
  const rec = beacons.get(key) || { n: 0, first: new Date().toISOString(), detail: '' };
  rec.n += 1;
  if (detail) rec.detail = String(detail).slice(0, 200);
  beacons.set(key, rec);
  if (rec.n === 1) {
    mark('api', `beacon: ${key}${rec.detail ? `（${rec.detail.slice(0, 80)}）` : ''}`);
  }
  return rec;
}

export function apply(ctx) {
  try {
    const guard = (req, res) => {
      if (isTrustedLocalRequest(req)) return true;
      json(res, 403, { ok: false, error: 'forbidden' });
      return false;
    };

    // ① 状态（面板的主数据）
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/api/mind/status',
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        noteHit('/api/mind/status');
        try { json(res, 200, collectStatus()); }
        catch (e) { json(res, 500, { ok: false, error: `status failed: ${e?.message ?? e}` }); }
      },
    }), 'dsh-mind-api: status route');

    // ② 文件清单
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/api/mind/tree',
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        noteHit('/api/mind/tree');
        const url = new URL(req.url, 'http://localhost');
        const zone = (url.searchParams.get('zone') || 'private').trim();
        const out = listZone(zone);
        json(res, out.ok ? 200 : 400, out);
      },
    }), 'dsh-mind-api: tree route');

    // ③ 只读文件
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/api/mind/file',
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        noteHit('/api/mind/file');
        const url = new URL(req.url, 'http://localhost');
        const zone = (url.searchParams.get('zone') || 'private').trim();
        const rel = url.searchParams.get('rel') || '';
        const out = readZoneFile(zone, rel);
        json(res, out.ok ? 200 : 400, out);
      },
    }), 'dsh-mind-api: file route');

    // ④ 接入开关（逻辑仍在 connect.js；此处只转发，**不复制一份判据**）
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/api/mind/connect',
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        noteHit('/api/mind/connect');
        const url = new URL(req.url, 'http://localhost');
        const session = (url.searchParams.get('session') || '').trim();
        if (req.method === 'GET') {
          json(res, 200, { ok: true, session, enabled: isConnected(session), offCount: offCount(), offSessions: offSessions() });
          return;
        }
        if (req.method !== 'POST') {
          res.setHeader('allow', 'GET, POST');
          json(res, 405, { ok: false, error: 'method not allowed' });
          return;
        }
        let body = {};
        try { body = await readJsonBody(req); } catch { body = {}; }
        const sid = typeof body?.session === 'string' && body.session.trim() ? body.session.trim() : session;
        if (!sid) { json(res, 400, { ok: false, error: 'session is required' }); return; }
        const ok = setConnected(sid, body?.enabled === true);
        json(res, ok ? 200 : 400, { ok, session: sid, enabled: isConnected(sid), offCount: offCount(), offSessions: offSessions() });
      },
    }), 'dsh-mind-api: connect route');

    // ④b 官方客户端启动图（**只读诊断**）：`dsh.client` 的扫描结果由 client-modules 服务持有。
    //     为什么需要这一格：面板"看不见"时，第一件事就是分清两种可能——
    //     ① 我的浏览器半**没被编进启动图**（声明/导出有问题）；
    //     ② 编进去了但**浏览器侧执行/挂载失败**（模块报错、槽位不存在）。
    //     这里给 ① 一个机械读数（`hasSelf` + 真实 entries/batches），② 交给 `/api/mind/beacon`。
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/api/mind/boot',
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        noteHit('/api/mind/boot');
        let graph = null;
        try { graph = ctx.get?.('clientModules')?.graph?.() ?? null; } catch { graph = null; }
        const entries = Array.isArray(graph?.entries)
          ? graph.entries.map((e) => ({ id: e.id, url: e.url, rev: e.rev, inject: e.inject ?? [], external: e.external ?? [] }))
          : null;
        const batches = Array.isArray(graph?.batches)
          ? graph.batches.map((b) => ({ phase: b.phase, url: b.url, entries: b.entries }))
          : null;
        json(res, 200, {
          ok: true,
          serviceAvailable: graph !== null,
          rev: graph?.rev ?? null,
          entries,
          batches,
          /** 关键读数：我的浏览器半在不在启动图里 */
          hasSelf: Array.isArray(entries) && entries.some((e) => e.id === CLIENT_ID),
          selfEntry: Array.isArray(entries) ? (entries.find((e) => e.id === CLIENT_ID) ?? null) : null,
        });
      },
    }), 'dsh-mind-api: boot graph route');

    // ④c 浏览器自报（beacon）：把"浏览器侧到底走到哪一步"变成盘上读数。
    //     链路四格：`apply`（模块工厂跑完且 apply 被调用）→ `slot`（槽位注册成功）→
    //     `render`（组件真的渲染）→ `error`（渲染/加载出错，带摘要）。
    //     为什么必须自报：之前只能靠人眼；一个静默失效的 no-op（tagIndex 注入）就骗过了一整轮验收。
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/api/mind/beacon',
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        noteHit('/api/mind/beacon');
        const url = new URL(req.url, 'http://localhost');
        const what = (url.searchParams.get('what') || '').trim();
        const detail = (url.searchParams.get('detail') || '').trim();
        const rec = noteBeacon(what, detail);
        json(res, 200, { ok: true, what, count: rec.n, first: rec.first });
      },
    }), 'dsh-mind-api: beacon route');

    // ⚠️ 这里**曾经**是"自托管浏览器包 + `tapIndex` 注 boot 行"（2026-09-30 删）。
    //    删的理由是实测的痛：本版外壳的启动清单是**对象** `{rev, entries, batches}`，
    //    而那份实现第一句就是 `if (!Array.isArray(graph)) return html` ⇒ **静默 no-op**，
    //    面板从没被加载，而 marker 上只写着 `client=ok 21049B`（**假绿**）。
    //    正解＝官方通道：`package.json` 的 `dsh.client` 由 `dsh-client-modules` 扫描并自行
    //    编入启动图、自行服务 bundle（`/plugins/<id>/client.js`，combo 批次）。
    //    于是本插件不再自己造通道，只**读**结果（`/api/mind/boot`：`hasSelf`）＋ 收浏览器自报。
    const bundleOk = existsSync(CLIENT_FILE);
    if (!bundleOk) mark('api', 'apply: 浏览器包缺失（client/client.js 不在包里）⇒ 面板不可用');

    mark('api', `apply: mounted（routes=${ROUTE_SPECS.length} client=${bundleOk ? 'present' : 'missing'}）`);
  } catch (e) {
    mark('api', `apply failed: ${e?.message ?? e}`);
    ctx.logger?.('dsh-mind').warn(`dsh-mind-api: apply 失败（已忽略）：${e?.message ?? e}`);
  }
}
