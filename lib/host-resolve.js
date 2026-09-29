// lib/host-resolve.js — 从**宿主**解析上游包（不是从本插件自己的位置）。
//
// ── 为什么必须这样 ────────────────────────────────────────────────────────────
//   `import('@deepseek-ai/dsh-llm')` 是按**本文件所在位置**往上找 node_modules。
//   当本插件以 **junction / link** 方式安装时，Node 按 **realpath** 解析 ⇒ 找到的是
//   `<本插件源码目录>`（那里没有 node_modules）⇒ 导入失败 ⇒ 拿不到上游导出。
//
//   **实测代价（2026-09-29）**：装进官方客户端（junction 安装）后 marker 出现
//   `apply: degraded — createUserMessage 不可用` ⇒ **R0 注入实际不工作**。
//   而我的测试环境用的是**副本安装**（插件被复制进 profile 的 node_modules，
//   旁边正好有上游包）⇒ 掩盖了这个 bug。
//
// ── 解法 ──────────────────────────────────────────────────────────────────────
//   以**宿主入口脚本**（`process.argv[1]`）为基准解析：
//     · 官方客户端：`...\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\index.js`
//     · dsh CLI   ：`<dir>\node_modules\@deepseek-ai\dsh\lib\bin.js`
//   两者往上找都能命中宿主的 node_modules。**两种安装形态都成立。**

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

/** 宿主入口脚本路径（解析基准）。取不到 ⇒ 退回 cwd（最坏情况仍比插件自身位置准）。 */
function hostBase() {
  return process.argv[1] || process.cwd();
}

/**
 * 按宿主的模块图解析并动态导入一个包。
 * @param {string} spec 包名（可带子路径）
 * @returns {Promise<object|null>} 模块命名空间；解析/导入失败 ⇒ null（不抛）
 */
export async function hostImport(spec) {
  try {
    const req = createRequire(hostBase());
    const resolved = req.resolve(spec);
    return await import(pathToFileURL(resolved).href);
  } catch {
    // 兜底：本插件自身位置（副本安装时有效）
    try { return await import(spec); } catch { return null; }
  }
}

/**
 * 按宿主的模块图解析并读取一个包的 `package.json`（同步）。
 * @param {string} spec 包名
 * @returns {object|null} 解析出的 JSON；取不到 ⇒ null（不抛）
 */
export function hostPackageJson(spec) {
  try {
    const req = createRequire(hostBase());
    return JSON.parse(readFileSync(req.resolve(`${spec}/package.json`), 'utf8'));
  } catch {
    try {
      const reqSelf = createRequire(import.meta.url);
      return JSON.parse(readFileSync(reqSelf.resolve(`${spec}/package.json`), 'utf8'));
    } catch { return null; }
  }
}

/**
 * 同步解析一个包的绝对路径（不导入）。
 * @returns {string|null}
 */
export function hostResolve(spec) {
  try {
    return createRequire(hostBase()).resolve(spec);
  } catch { return null; }
}
