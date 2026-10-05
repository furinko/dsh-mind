// lib/paths.js — 数据模型：心智数据的落点（本插件**唯一**的路径真源）。
//
// ── 三区 ──────────────────────────────────────────────────────────────────────
//   dataRoot()     心智数据根。其下是 `mind/`（出厂固件副本）与 `mind-private/`（本机实例）
//   firmwareDir()  包内出厂固件（只读源，随包分发）
//   profileDir()   诊断与台账（marker / jsonl）—— 属于"本机 profile"，不属于心智数据
//
// ── 解析顺序（**核心设计，改前先读懂这段**）────────────────────────────────────
//   1. `MIND_HOME` 显式指定 ⇒ 用它（测试隔离 / 自定义部署）
//   2. `DSH_HOME` 在场：
//        a. 其下有 `mind/` ⇒ 认它（**单体布局**：心智数据与 dsh home 同根）
//        b. 否则 ⇒ `<DSH_HOME>/mind-data`（**独立插件布局：目的地，可能尚不存在**）
//   3. 无 `DSH_HOME` ⇒ dev 上溯（找含 `mind/` 的祖先，兼容源码开发态）
//   4. 都找不到 ⇒ 用户级 `~/.dsh-mind`
//
// ⚠️ **两条硬纪律**（都是实测换来的，别回退）：
//
//   ① **2.b 不许要求目录已存在**。全新安装时 `mind-data/` 正等着首启自举去创建；
//      写成"不存在就换别的" ⇒ 固件会被落到错误位置。首版曾回落 `cwd`，
//      后果是"谁在哪跑就落哪"——独立插件装到别人机器上必然错位。
//
//   ② **永不回落 `cwd`**。心智数据必须有**稳定归属**；cwd 随调用者漂移，
//      不是一个可以承载长期记忆的位置。兜底用 `~/.dsh-mind`（用户级、稳定、可写）。
//
// ── 为什么单独一个模块 ────────────────────────────────────────────────────────
//   可移植化的地基。历史教训：同一段"找根"逻辑曾在 11 处各写一遍，且各自硬编码
//   `profiles/<某个具体名字>` ⇒ 换 profile / 换设备即错。**任何调用方都不得再自写一份。**

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本模块所在目录（`<pkg>/lib/`）。 */
const HERE = dirname(fileURLToPath(import.meta.url));
/** 包根（`<pkg>/`）。 */
const PKG_ROOT = resolve(HERE, '..');

/** 独立插件布局下，心智数据目录名（与 `mind/` 平级）。 */
export const DATA_DIRNAME = 'mind-data';

/** 去掉尾部路径分隔符（Windows 上 `C:\a\` 与 `C:\a` 必须判等）。 */
function trimSep(p) {
  if (typeof p !== 'string' || p === '') return '';
  const s = p.replace(/[\\/]+$/, '');
  return s === '' ? p : s;
}

/** 该目录是否"像心智根"（其下有 `mind/`）。全库统一的判据。 */
function looksLikeMindRoot(dir) {
  if (!dir) return false;
  try { return existsSync(join(dir, 'mind')); } catch { return false; }
}

/** dev 态上溯：从包根往上找含 `mind/` 的祖先（源码开发时心智数据就在仓库里）。 */
function ascendForMind() {
  let cur = PKG_ROOT;
  for (let i = 0; i < 8; i += 1) {
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
    if (looksLikeMindRoot(cur)) return cur;
  }
  return null;
}

/**
 * 心智数据根（其下有 `mind/` + `mind-private/`）。
 * **不保证目录已存在**——首启由 `bootstrap()` 创建。
 * @returns {string} 绝对路径
 */
export function dataRoot() {
  const explicit = trimSep(process.env.MIND_HOME || '');
  if (explicit) return resolve(explicit);

  // 官方 home 解析：`DSH_HOME`（非空白）?? `~/.dsh`
  // —— 与 `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome` **同语义**。
  // ⚠️ 必须有 `~/.dsh` 这一档：官方客户端**不设 `DSH_HOME` 环境变量**（它用命令行参数传
  //    profile 目录）⇒ 只读 env 会一路掉到兜底，把心智数据落到错位置（实测：落到
  //    `~/.dsh-mind`，而正确位置是 `~/.dsh/mind-data`）。
  const dshHome = resolveDshHome();
  if (dshHome) {
    // 单体布局：home 自己就是心智基座（其下有 mind/）
    if (looksLikeMindRoot(dshHome)) return resolve(dshHome);
    // 独立插件布局（**不要求已存在**，见文件头纪律 ①）
    return join(resolve(dshHome), DATA_DIRNAME);
  }

  const ascended = ascendForMind();
  if (ascended) return ascended;

  // 纪律 ②：兜底用包内目录，**绝不回落 cwd**
  return join(PKG_ROOT, '.mind-data');
}

/**
 * 解析 dsh home（`DSH_HOME` 非空白 ?? `~/.dsh`）。
 * 语义对齐官方 `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome`。
 * @returns {string} 绝对路径（不保证存在）
 */
export function resolveDshHome() {
  const fromEnv = trimSep(process.env.DSH_HOME || '');
  if (fromEnv) return resolve(fromEnv);
  const userHome = trimSep(process.env.USERPROFILE || process.env.HOME || '');
  return userHome ? join(resolve(userHome), '.dsh') : '';
}

/** 出厂固件副本（运行时读取的规则/技能来源）。 */
export function mindDir() {
  return join(dataRoot(), 'mind');
}

/** 本机实例（永不外流；用户自己养出来的那个）。 */
export function privateDir() {
  return join(dataRoot(), 'mind-private');
}

/** 包内出厂固件（**只读源**，随包分发；首启从这里拷贝）。 */
export function firmwareDir() {
  return join(PKG_ROOT, 'firmware');
}

/** 人设卡的落点（相对私有区）。
 *  单件口径放这里的原因：它同时被**读口**（`recall.js` 注入）与**写口**（`api.js` 面板保存）
 *  使用——两处各写一份字符串，改一处就会出现"保存到 A、召回读 B"的静默错位。 */
export const PERSONA_REL = 'L0/人设卡.md';

/** 人设卡注入上限（字符）。**读口截断与写口报警必须同一个数**：
 *  否则面板会对着一个已被截断的卡说"已全部生效"（本机口径：recall 只取前 N 字符）。 */
export const PERSONA_CHARS = 2000;

/**
 * 从**宿主命令行**里找出"正在运行的那个 profile 目录"。
 *
 * ⚠️ 为什么需要（2026-09-29 实测校正）：客户端**用位置参数**传 profile 目录
 * （`... dsh-desktop-host/lib/index.js <asar>\dsh <DSH_HOME>\profiles\<名> ...`），
 * 而**不保证**把 `DSH_PROFILE_DIR` 放进插件进程的环境里。实测：插件实跑
 * `profiles\desktop`，而 marker 全落到 `profiles\dshome\.dsh-market`
 * （＝回落到本函数的最后一档 `MIND_PROFILE_NAME || 'dshome'`）⇒ **诊断写错 profile**。
 *
 * 判据＝**读现场**而不是猜：argv 里那个**真实存在、且是 `<home>/profiles/` 的直属子目录**的项。
 * @param {string} home 已解析的 dsh home
 * @returns {string} 绝对路径；找不到 ⇒ 空串
 */
function profileDirFromArgv(home) {
  const root = home ? resolve(home) : '';
  if (!root) return '';
  const profilesRoot = join(root, 'profiles');
  for (const raw of process.argv.slice(1)) {
    if (typeof raw !== 'string' || !raw) continue;
    const p = trimSep(raw);
    if (!p || p.startsWith('-')) continue;
    try {
      if (!existsSync(p) || !statSync(p).isDirectory()) continue;
    } catch { continue; }
    const abs = resolve(p);
    if (abs.toLowerCase().startsWith(profilesRoot.toLowerCase() + sep)
      && resolve(dirname(abs)) === resolve(profilesRoot)) return abs;
  }
  return '';
}

/**
 * 本机 profile 目录（诊断/台账落点）。
 *
 * ⚠️ **按布局分档**（2026-09-29 实测校正，别一刀切）：
 *
 *   · **单体布局**（`DSH_HOME` 含 `mind/`，如 DSHOME 仓库）：
 *     诊断属"心智自己的那个 profile" ⇒ `<home>/profiles/<MIND_PROFILE_NAME|dshome>`。
 *     **此处必须忽略 `DSH_PROFILE_DIR`**——它是"当前 GUI 会话"的旋钮，实测会让 marker
 *     写到 `profiles/desktop/` 而门禁在 `profiles/dshome/` 找 ⇒ 整片断言变红。
 *
 *   · **独立插件布局**（如官方客户端）：
 *     诊断属"**插件正在运行的那个 profile**" ⇒ 认 `DSH_PROFILE_DIR`；它**不在**时
 *     从宿主 argv 里认（见 `profileDirFromArgv`，这是本机实测缺的那一档）。
 *
 * 顺序：`MIND_PROFILE_DIR` > （单体：home/profiles/名）> `DSH_PROFILE_DIR`
 *       > **argv 里的 `home/profiles/<名>`** > home/profiles/名 > 包内兜底
 */
export function profileDir() {
  const explicit = trimSep(process.env.MIND_PROFILE_DIR || '');
  if (explicit) return resolve(explicit);

  const name = String(process.env.MIND_PROFILE_NAME || 'dshome').trim() || 'dshome';
  const home = resolveDshHome();

  // 单体布局 ⇒ 心智自己的 profile（忽略 GUI 会话旋钮）
  if (home && looksLikeMindRoot(home)) return join(resolve(home), 'profiles', name);

  // 独立插件布局 ⇒ 插件正在运行的那个 profile
  const running = trimSep(process.env.DSH_PROFILE_DIR || '');
  if (running) return resolve(running);

  // ⚠️ 本机实测（官方客户端）：`DSH_PROFILE_DIR` 不给插件进程 ⇒ 从 argv 认现场
  const fromArgv = profileDirFromArgv(home);
  if (fromArgv) return fromArgv;

  if (home) return join(resolve(home), 'profiles', name);
  return join(PKG_ROOT, '.profile');
}

/** 诊断与台账目录（marker / jsonl）。 */
export function marketDir() {
  const explicit = trimSep(process.env.MIND_MARKET_DIR || '');
  if (explicit) return resolve(explicit);
  return join(profileDir(), '.dsh-market');
}

/** 幂等建目录；返回同一路径便于链式使用。 */
export function ensureDir(dir) {
  try { mkdirSync(dir, { recursive: true }); } catch { /* 权限/占用留给调用方 */ }
  return dir;
}

/**
 * `target` 是否在 `root` 内（**大小写不敏感**，Windows 语义）。
 * 单独一个函数的原因：历史缺陷——一处区分大小写的 `includes` 让私密路径在公开面假绿数日。
 * @returns {boolean}
 */
export function isInside(target, root) {
  if (!target || !root) return false;
  const norm = (p) => resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();
  const t = norm(target);
  const r = norm(root);
  return t === r || t.startsWith(r + sep.toLowerCase()) || t.startsWith(r + '/');
}

/** 只读诊断快照（不写盘）。 */
export function describePaths() {
  return {
    dataRoot: dataRoot(),
    mindDir: mindDir(),
    privateDir: privateDir(),
    firmwareDir: firmwareDir(),
    profileDir: profileDir(),
    marketDir: marketDir(),
    env: {
      MIND_HOME: process.env.MIND_HOME || null,
      DSH_HOME: process.env.DSH_HOME || null,
      MIND_PROFILE_NAME: process.env.MIND_PROFILE_NAME || null,
      MIND_PROFILE_DIR: process.env.MIND_PROFILE_DIR || null,
      MIND_MARKET_DIR: process.env.MIND_MARKET_DIR || null,
    },
  };
}
