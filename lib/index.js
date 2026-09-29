// lib/index.js — bundle 入口。
//
// 本包的插件由自带的 `cordis.patch.yml` 组装；这个模块只是包根导出
// （让 `main` 指向一个真文件——内容为空即可）。
//
// 各插件的真实入口在 `lib/host/*.js`，逐条登记在 package.json 的 exports 里。
// ⚠️ **漏一条 exports = 宿主按包子路径加载时 ESM 直接拒收 = 启动崩**（本仓有过两次先例）。
export {};
