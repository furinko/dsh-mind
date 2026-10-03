// lib/index.js — bundle 入口，**同时也是"裸包名"启动行挂载的那个 host 半**。
//
// ── 为什么这个文件必须是一个能挂载的 plugin（2026-10-04 实测）────────────────
//   官方客户端扫描器只认**裸包名**的启动行（见 `cordis.patch.yml` 顶部第二条纪律），
//   而那一行 `name: dsh-mind` 解析到本文件（`main`）。本文件若是不带 `apply` 的空模块，
//   宿主挂载期会判 "invalid plugin" ⇒ 包起不来，客户端扫描也跟着完蛋。
//   故这里挂一个**只留一行痕**的空插件：唯一职责＝让本包被识别为一个"包"，
//   从而让 `package.json` 的 `dsh.client` 被扫进浏览器启动图。
//
// 各插件的真实入口在 `lib/host/*.js`，逐条登记在 `cordis.patch.yml` 与 package.json exports 里。
// ⚠️ **漏一条 exports = 宿主按包子路径加载时 ESM 直接拒收 = 启动崩**（本仓有过两次先例）。

import { mark } from './diag.js';

export const name = 'dsh-mind-root';

export function apply() {
  mark('root', 'apply: 裸包名启动行已挂载（本包由此被客户端扫描识别）');
}
