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

import { existsSync, mkdirSync } from 'node:fs';
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

  const dshHome = trimSep(process.env.DSH_HOME || '');
  if (dshHome) {
    // 2.a 单体布局
    if (looksLikeMindRoot(dshHome)) return resolve(dshHome);
    // 2.b 独立插件布局（**不要求已存在**，见文件头纪律 ①）
    return join(resolve(dshHome), DATA_DIRNAME);
  }

  const ascended = ascendForMind();
  if (ascended) return ascended;

  // 纪律 ②：兜底用用户级目录，**绝不回落 cwd**
  const home = trimSep(process.env.USERPROFILE || process.env.HOME || '');
  return home ? join(resolve(home), '.dsh-mind') : join(PKG_ROOT, '.mind-data');
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

/**
 * 本机 profile 目录（诊断/台账落点）。
 * 顺序：`MIND_PROFILE_DIR` > `DSH_HOME/profiles/<MIND_PROFILE_NAME|dshome>` > 包内 `.profile`。
 * ⚠️ **不读 `DSH_PROFILE` / `DSH_PROFILE_DIR`**：那两个是"当前 GUI 会话"的旋钮，
 *    与"心智数据归属哪个 profile"是两回事——跟随它们会让落痕写到基座之外（实测红过）。
 */
export function profileDir() {
  const explicit = trimSep(process.env.MIND_PROFILE_DIR || '');
  if (explicit) return resolve(explicit);
  const name = String(process.env.MIND_PROFILE_NAME || 'dshome').trim() || 'dshome';
  const dshHome = trimSep(process.env.DSH_HOME || '');
  if (dshHome) return join(resolve(dshHome), 'profiles', name);
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
