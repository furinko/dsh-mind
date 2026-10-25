#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════
// dsh-mind · profile 安装自检（单包自洽形态，2026-10-11 重写 / 2026-10-12 修三处假绿）
// ═══════════════════════════════════════════════════════════════════════════════
//
// 为什么需要它：装错和装对在「装完那一刻」可能长得一样（卡在、不报错，
// 直到装载器 import 组件行才炸）。本脚本把那一刻的判断补上。
// 单包化后要防的病变了：不再是「link: 组件静默不装」（四包形态已废），
// 而是「装到的包不完整」——发布物缺出厂区/缺组件入口/bundles 没挂上。
//
// 2026-10-12 修的三处假绿（它们都能给坏发布物盖章「安装自检通过」）：
//   ① 出厂区只硬点名 4 个文件 ⇒ 改成按**装上的那个包自己的** `src/paths.js` 清单全量核对
//      （区目录 / RULE_FILES / ROLE_CARD_FILES / DEFAULT_FILES + 能力卡目录数量）。
//      清单只此一份，本脚本不再手抄——抄一份就会漂。
//   ② 补丁只数行数（3 行）⇒ 删掉内核行、换一条重复的 guard 行，行数照样对得上。改成
//      **逐行验组件在场**，口径与 `test/preflight.mjs` 同款：行 name 必须是本包子路径且
//      对上 exports 与磁盘，看板行是裸包名载体行，每个宿主组件都必须被某一行引用。
//   ③ 读 manifest 不认 BOM ⇒ 裸 SyntaxError 栈。改成剥 BOM + 解析失败给人话诊断。
//
// 用法：
//   node scripts/verify-profile-install.mjs <profileDir>
//   node scripts/verify-profile-install.mjs --selftest   # 临时目录造坏输入，验证本脚本会红
//
// 判据（任一失败 exit 1）：
//   ① profile dependencies 里有 dsh-mind，bundles 里有 dsh-mind 且没有组件 id；
//   ② node_modules/dsh-mind 解析得到：非 private、无 dependencies、
//      exports 的每一条都真的落盘（口径同 test/preflight.mjs）；
//   ③ 出厂区 mind/ 按 src/paths.js 的清单全量核对：区目录 / 规则件 / 岗位卡 /
//      defaults 逐条 existsSync，能力卡目录 readdir 数量 > 0；
//      外加**两件单文档**：`编制.md`（`Layout.establishmentPath('出厂')`）与
//      `集体L2-共享基础设施/README.md`（`Layout.factory()`）—— 它们不在任何数组里，
//      2026-10-12 补漏前是**绿的漏网**；
//   ④ cordis.patch 逐行验组件在场：宿主行的 name 对得上 exports 的子路径 + 文件在盘上，
//      看板是裸包名载体行；两个宿主组件各自都得有行（只数行数会让「删内核行换重复 guard 行」蒙混过关）；
//   ⑤ 组件行子路径从 profile 上下文可解析（require.resolve 逐条验）。

import { existsSync, readFileSync, readdirSync, mkdirSync, rmSync, writeFileSync, cpSync, mkdtempSync, statSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const 脚本目录 = dirname(fileURLToPath(import.meta.url));
const 本仓库 = join(脚本目录, '..');
const BUNDLE = 'dsh-mind';
const 宿主组件 = ['kernel', 'guard']; // 看板只有浏览器半区（./client），载体行是裸包名行

/**
 * 读 JSON：**容忍开头 BOM**（手工编辑过的 manifest 常见），解析失败给人话诊断而不是裸栈。
 * @param {string} path
 * @returns {{值?: any, 错?: string}}
 */
function 读json(path) {
  let 文本;
  try {
    文本 = readFileSync(path, 'utf8');
  } catch (error) {
    return { 错: `读不到 ${path}：${error.message}` };
  }
  const 有BOM = /^\uFEFF/.test(文本);
  try {
    return { 值: JSON.parse(文本.replace(/^\uFEFF/, '')) };
  } catch (error) {
    const 首行 = 文本.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0].slice(0, 60);
    return {
      错: `${path} 不是合法 JSON${有BOM ? '（开头有 BOM，剥掉后仍解析失败）' : ''}：${error.message}；首行是 ${JSON.stringify(首行)}`,
    };
  }
}

/**
 * 出厂区必备清单：**从装上的那个包自己的 `src/paths.js` 取真源**，不在本脚本里重抄一份
 * （抄一份就会漂）。读不到 paths.js 就报缺件，**不用兜底清单顶替**——兜底清单恰恰会把
 * 「发布物漏了 paths.js」这件事变成绿灯。
 * 2026-10-12 补漏：上面那份清单只覆盖 `RULE_FILES` / `ROLE_CARD_FILES` / `DEFAULT_FILES`
 * ＋ 能力卡 `readdir`，**漏了两件单件文档**——`集体L2-集体结构/编制.md` 与
 * `集体L2-共享基础设施/README.md`。它们谁都不在数组里，所以「把这两件从发布物里删掉」
 * 曾经是绿的。补法不是在本脚本里再手抄两个文件名（手抄一份就会漂），而是**问既有取径接口**：
 * `Layout.establishmentPath('出厂')` 与 `Layout.factory(DIR.基础设施, 'README.md')`。
 * @param {string} 包目录
 * @returns {Promise<{错: string} | {源: string, 区目录: string[], 规则件: string[][], 岗位卡目录: string, 岗位卡: string[], 默认值目录: string, 默认值: string[], 能力目录: string, 单件: string[]}>}
 */
async function 读出出厂清单(包目录) {
  const 源 = join(包目录, 'src', 'paths.js');
  if (!existsSync(源)) {
    return { 错: '包里缺 src/paths.js —— 出厂区清单的真源不在，无从核对（发布物不完整？files 白名单漏了？）' };
  }
  let mod;
  try {
    mod = await import(pathToFileURL(源).href);
  } catch (error) {
    return { 错: `src/paths.js 加载失败（出厂区清单读不出来）：${error.message}` };
  }
  const { DIR, RULE_FILES, ROLE_CARD_FILES, DEFAULT_FILES, Layout } = mod;
  if (!DIR || !Array.isArray(RULE_FILES) || !Array.isArray(ROLE_CARD_FILES) || !DEFAULT_FILES) {
    return { 错: 'src/paths.js 里读不到 DIR / RULE_FILES / ROLE_CARD_FILES / DEFAULT_FILES —— 清单真源缺项，出厂区核对无据' };
  }
  if (typeof Layout !== 'function') {
    return { 错: 'src/paths.js 里读不到 Layout —— 单件出厂件的取径接口不在，编制/README 无从核对' };
  }
  // 单件出厂件：**路径由 Layout 自己算**（factoryRoot 指向包内 mind/），本脚本不手抄文件名。
  const 出厂根 = join(包目录, 'mind');
  const layout = new Layout({ factoryRoot: 出厂根, privateRoot: 出厂根 });
  // `Layout.establishmentPath('出厂')` 给出**绝对**路径 ⇒ 折回相对 mind/ 的口径（与上面各项一致）。
  const 编制相对 = layout.establishmentPath('出厂').slice(出厂根.length + 1);
  return {
    源,
    区目录: [DIR.宪章, DIR.法律, DIR.集体结构, DIR.基础设施, DIR.角色卡].filter(Boolean),
    规则件: RULE_FILES.map((spec) => [spec.dir, spec.file]),
    岗位卡目录: DIR.角色卡,
    岗位卡: [...ROLE_CARD_FILES],
    默认值目录: join(DIR.基础设施, DIR.默认值),
    默认值: Object.values(DEFAULT_FILES),
    能力目录: join(DIR.基础设施, DIR.能力库),
    // `编制.md` 走既有取径接口；基础设施 README 走 `Layout.factory()` 组装
    // （paths.js 没有专门的 README 取径函数，`factory()` 就是那件既有接口）。
    单件: [
      编制相对,
      layout.factory(DIR.基础设施, 'README.md').slice(出厂根.length + 1),
    ],
  };
}

/**
 * ③ 出厂区：按清单**全量**核对（清单来自 `src/paths.js`，见上）。
 * 只查在场，不查内容——内容由 `test/preflight.mjs` 管。
 * @param {string} 包目录
 * @returns {Promise<{失败: string[], 通过: string|null}>}
 */
async function 核出厂区(包目录) {
  const 清单 = await 读出出厂清单(包目录);
  if (清单.错) return { 失败: [清单.错], 通过: null };
  const 根 = join(包目录, 'mind');
  if (!existsSync(根)) return { 失败: ['包里没有 mind/ 出厂区目录 —— 发布物不完整（files 白名单漏了？）'], 通过: null };

  const 失败 = [];
  const 缺 = (项们, 算路径) => 项们.filter((x) => !existsSync(算路径(x)));

  const 缺区 = 缺(清单.区目录, (d) => join(根, d));
  if (缺区.length) 失败.push(`出厂区缺区目录：${缺区.join('、')} —— 发布物不完整（files 白名单漏了？）`);
  const 缺规则 = 缺(清单.规则件, ([d, f]) => join(根, d, f));
  if (缺规则.length) 失败.push(`出厂区缺规则件：${缺规则.map(([d, f]) => `${d}/${f}`).join('、')} —— 发布物不完整`);
  const 缺卡 = 缺(清单.岗位卡, (f) => join(根, 清单.岗位卡目录, f));
  if (缺卡.length) 失败.push(`出厂区缺岗位卡：${缺卡.join('、')} —— 发布物不完整`);
  const 缺默 = 缺(清单.默认值, (f) => join(根, 清单.默认值目录, f));
  if (缺默.length) 失败.push(`出厂区缺 defaults：${缺默.join('、')} —— 发布物不完整`);
  // 单件出厂件（不在上面任何数组里 —— 这正是它们曾经漏网的原因）。
  const 缺单件 = 缺(清单.单件, (rel) => join(根, rel));
  if (缺单件.length) 失败.push(`出厂区缺单件文档：${缺单件.join('、')} —— 发布物不完整（files 白名单漏了？）`);

  // 能力卡目录：按旧版口径查 readdir 数量（> 0），这条覆盖的是「目录整个不在包里」。
  let 能力数 = 0;
  const 能力目录 = join(根, 清单.能力目录);
  if (existsSync(能力目录)) {
    try {
      能力数 = readdirSync(能力目录).filter((name) => name.endsWith('.md')).length;
    } catch {
      能力数 = 0;
    }
  }
  if (能力数 === 0) 失败.push(`出厂能力库 ${清单.能力目录} 里没有能力卡（readdir = 0）—— 发布物不完整`);

  if (失败.length) return { 失败, 通过: null };
  return {
    失败,
    通过: `出厂区 mind/ 齐全（区目录 ${清单.区目录.length}、规则件 ${清单.规则件.length}、岗位卡 ${清单.岗位卡.length}、defaults ${清单.默认值.length}、单件 ${清单.单件.length}、能力卡 ${能力数} 张；清单源 src/paths.js）`,
  };
}

/** 逐条判据：返回 [失败原因们, 通过语们]。 */
async function 检查(profileDir) {
  const 失败 = [];
  const 通过 = [];
  const 段 = () => 失败.length; // 分段计数：某一段全过才给它一行 ✓
  const profileManifestPath = join(profileDir, 'package.json');
  if (!existsSync(profileManifestPath)) return [['profile 目录里没有 package.json'], []];
  const profile读 = 读json(profileManifestPath);
  if (profile读.错) return [[profile读.错], []];
  const profile = profile读.值;

  const deps = Object.keys(profile.dependencies ?? {});
  if (!deps.includes(BUNDLE)) 失败.push(`dependencies 缺 ${BUNDLE}（装了吗？）`);
  else 通过.push(`dependencies 有 ${BUNDLE}（${profile.dependencies[BUNDLE]}）`);
  const bundles = profile.dsh?.profile?.bundles ?? [];
  if (!bundles.includes(BUNDLE)) 失败.push(`dsh.profile.bundles 缺 ${BUNDLE} —— 官方安装器装完会自动补；缺了就是卡没挂上（DSH 0.2.1 起装载器只按 bundles 清单应用 bundle patch，运行时升级后常见丢失：用插件管理器重新启用即可）`);
  else 通过.push(`bundles 含 ${BUNDLE}`);

  const 包目录 = join(profileDir, 'node_modules', BUNDLE);
  if (!existsSync(包目录)) return [[`node_modules/${BUNDLE} 不存在 —— pnpm 没装上`], 通过];
  const 包清单读 = 读json(join(包目录, 'package.json'));
  if (包清单读.错) return [[`装到的包读不出清单：${包清单读.错}`], 通过];
  const pkg = 包清单读.值;
  if (pkg.name !== BUNDLE) 失败.push(`包名是 ${pkg.name}，应为 ${BUNDLE}`);
  if (pkg.private === true) 失败.push('装到的包是 private —— 像是装进了源码仓而不是发布物');
  if (Object.keys(pkg.dependencies ?? {}).length > 0) 失败.push(`装到的包带着 dependencies（${Object.keys(pkg.dependencies).join(',')}）—— 单包形态不该有`);
  else 通过.push('包内自洽（无 dependencies）');

  // ② exports：三个关键子路径必须在，且**每一条**都得真的落盘（口径同 test/preflight.mjs）。
  const 入口段 = 段();
  for (const sub of [...宿主组件, 'client']) {
    if (typeof pkg.exports?.[`./${sub}`] !== 'string') 失败.push(`exports 缺 ./${sub} —— 装载器 import ${BUNDLE}/${sub} 会拒收`);
  }
  for (const [key, target] of Object.entries(pkg.exports ?? {})) {
    if (typeof target !== 'string' || !target.startsWith('./')) continue;
    if (!existsSync(join(包目录, target))) 失败.push(`exports["${key}"] → ${target} 不在包里 —— 宿主按子路径加载会被 ESM 拒收`);
  }
  if (段() === 入口段) 通过.push('exports 每一项（含 ./kernel ./guard ./client）都落在包里');

  if (pkg.dsh?.client?.platform !== 'web') 失败.push('包缺 dsh.client(platform:web) —— 浏览器半区不会被发现');

  // ③ 出厂区：按 src/paths.js 的清单全量核对。
  const 出厂 = await 核出厂区(包目录);
  失败.push(...出厂.失败);
  if (出厂.通过) 通过.push(出厂.通过);

  // ④ 组件行：**逐行**验组件在场（口径同 test/preflight.mjs；只数行数会让
  //    「删内核行、换一条重复 guard 行」蒙混过关——行数还是 3）。
  const 行段 = 段();
  let patch = '';
  try {
    patch = readFileSync(join(包目录, 'cordis.patch.yml'), 'utf8').replace(/^\uFEFF/, '');
  } catch (error) {
    失败.push(`读不到 cordis.patch.yml：${error.message}`);
  }
  const rows = [...patch.matchAll(/^\s*-\s+id:\s*(\S+)\s*$[\s\S]*?^\s+name:\s*(\S+)\s*$/gm)]
    .map((m) => ({ id: m[1], name: m[2].replace(/^['"]|['"]$/g, '') }));
  if (rows.length !== 宿主组件.length + 1) 失败.push(`cordis.patch 应插 ${宿主组件.length + 1} 行，实际 ${rows.length}`);
  if (rows.some((row) => row.id === BUNDLE)) 失败.push(`cordis.patch 给自己插了行 ${BUNDLE} —— 列表里会多出一张卡，组件就退回成插件了`);
  for (const row of rows) {
    if (row.name === BUNDLE) {
      // 载体行（看板）：裸包名 → 根入口，浏览器半区由它发现。
      if (typeof pkg.exports?.['.'] !== 'string') 失败.push(`载体行 ${row.id} 指向根包，但 exports["."] 缺失`);
      continue;
    }
    if (!row.name.startsWith(`${BUNDLE}/`)) {
      失败.push(`行 ${row.id} 的 name '${row.name}' 不是 ${BUNDLE}/<sub> 子路径或裸包名载体行`);
      continue;
    }
    const sub = row.name.slice(BUNDLE.length + 1);
    const target = pkg.exports?.[`./${sub}`];
    if (typeof target !== 'string') {
      失败.push(`行 ${row.id} 的 name '${row.name}' 不在 exports 里 —— 装载时 import 会拒收`);
      continue;
    }
    if (!existsSync(join(包目录, target))) 失败.push(`行 ${row.id} 解析到不存在的文件：${target}`);
    if (!target.startsWith('./components/')) 失败.push(`行 ${row.id} 解析到 ${target} —— 组件行必须落进 components/`);
  }
  // 要害：每个宿主组件都得起码被一行引用。删掉内核行、拿 guard 行凑数时，这条才红。
  for (const sub of 宿主组件) {
    if (!rows.some((row) => row.name === `${BUNDLE}/${sub}`)) {
      失败.push(`cordis.patch 里没有一行引用 ${BUNDLE}/${sub} —— 这个组件不会被装载（光看行数看不出来）`);
    }
  }
  if (段() === 行段) 通过.push(`cordis.patch ${rows.length} 行逐行在场：${rows.map((r) => r.name).join(' / ')}`);

  // ⑤ 子路径从 profile 上下文真的解析得到（这是装载器视角）。
  const 解段 = 段();
  const req = createRequire(profileManifestPath);
  for (const sub of [...宿主组件, 'client']) {
    try {
      req.resolve(`${BUNDLE}/${sub}`);
    } catch (error) {
      失败.push(`require.resolve('${BUNDLE}/${sub}') 失败：${error.message}`);
    }
  }
  if (段() === 解段) 通过.push('三个子路径从 profile 上下文全部可解析');
  return [失败, 通过];
}

// ── selftest：临时目录造坏输入，本脚本必须红 ─────────────────────────────────
async function selftest() {
  const 本包 = 读json(join(本仓库, 'package.json'));
  if (本包.错) {
    process.stdout.write(`  ✗ 读不到本仓库 package.json：${本包.错}\n`);
    return false;
  }
  const 真源 = await import(pathToFileURL(join(本仓库, 'src', 'paths.js')).href);
  // 夹具落 os.tmpdir()：跑在仓库里会留下 .selftest-verify 这种脏目录（git status 会看见）。
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-mind-verify-')));
  const cases = [];
  const 判 = async (名, fn) => {
    // Report each case before it starts, even if a native filesystem call aborts.
    writeFileSync(1, `  检查 ${名}…\n`);
    try {
      cases.push([名, (await fn()) === true]);
    } catch (error) {
      cases.push([`${名}（夹具或判据抛异常：${error.message}）`, false]);
    }
    const [结果名, ok] = cases.at(-1);
    writeFileSync(1, `  ${ok ? '✓' : '✗'} ${结果名}\n`);
  };
  try {
    /** 造一个假 dsh-mind 包：按本包 package.json 的 files 白名单复制（发布物清单单一来源）。 */
    const 造profile = (name, { profile文本 } = {}) => {
      // Similar Chinese names have the same short UTF-8 hex prefix. Each mutation
      // needs a fresh directory so a later case never overwrites an imported one.
      const dir = mkdtempSync(join(tmp, `${name}-`));
      const 包目录 = join(dir, 'node_modules', BUNDLE);
      mkdirSync(包目录, { recursive: true });
      for (const rel of [...(本包.值.files ?? []), 'package.json']) {
        const 源 = join(本仓库, rel);
        if (!existsSync(源)) continue;
        // A filter keeps Node's JS/libuv copy path. The native no-filter fast path
        // can terminate on Windows Unicode paths (nodejs/node#54476, #63970).
        cpSync(源, join(包目录, rel), { recursive: statSync(源).isDirectory(), filter: () => true });
      }
      const profile = { name: 'probe', dependencies: { [BUNDLE]: 'file:probe' }, dsh: { profile: { bundles: [BUNDLE] } } };
      writeFileSync(join(dir, 'package.json'), profile文本 ?? JSON.stringify(profile, null, 2));
      return dir;
    };

    // 好例：完整包必须全绿（否则自检本身就是坏的）。
    await 判('完整包全绿', async () => {
      const [失败, 通过] = await 检查(造profile('good'));
      return 失败.length === 0 && 通过.length >= 5;
    });

    // 坏例 1：发布物缺组件入口（files 白名单漏装 board ⇒ ./client 落空）。
    await 判('缺组件入口必红', async () => {
      const dir = 造profile('missing-board');
      rmSync(join(dir, 'node_modules', BUNDLE, 'components', 'board'), { recursive: true, force: true });
      const [失败] = await 检查(dir);
      return 失败.length > 0;
    });

    // 坏例 2：exports 里有、磁盘上没有（删掉 guard 的宿主入口文件）。
    await 判('exports 有磁盘没有必红', async () => {
      const dir = 造profile('missing-guard-entry');
      rmSync(join(dir, 'node_modules', BUNDLE, 'components', 'guard', 'lib', 'index.js'), { force: true });
      const [失败] = await 检查(dir);
      return 失败.length > 0;
    });

    // 坏例 3：bundles 没挂（官方安装器没跑 reconcile 的样子）。
    await 判('bundles 缺卡必红', async () => {
      const dir = 造profile('no-bundle', { profile文本: JSON.stringify({ dependencies: { [BUNDLE]: 'file:probe' } }, null, 2) });
      const [失败] = await 检查(dir);
      return 失败.length > 0;
    });

    // 坏例 4：出厂区只剩 3/22 件（留下的正是旧脚本硬点名的那 3 个 —— 所以旧脚本是绿的）。
    await 判('出厂区只剩 3/22 件必红', async () => {
      const dir = 造profile('factory-3of22');
      const 出厂 = join(dir, 'node_modules', BUNDLE, 'mind');
      const 留 = [
        join(真源.DIR.宪章, '宪章.md'),
        join(真源.DIR.角色卡, '_模板.md'),
        join(真源.DIR.基础设施, 真源.DIR.默认值, '介入度.json'),
      ];
      // 能力库整棵删掉（旧脚本根本没查它）。
      rmSync(join(出厂, 真源.DIR.基础设施, 真源.DIR.能力库), { recursive: true, force: true });
      for (const entry of readdirSync(出厂, { recursive: true })) {
        const rel = String(entry);
        const 全 = join(出厂, rel);
        if (statSync(全).isDirectory() || 留.includes(rel)) continue; // 目录留着，删文件即可
        rmSync(全, { force: true });
      }
      const 剩 = readdirSync(出厂, { recursive: true }).filter((p) => statSync(join(出厂, String(p))).isFile()).length;
      if (剩 !== 3) throw new Error(`夹具失效：mind/ 剩 ${剩} 件，应为 3 件`);
      const [失败] = await 检查(dir);
      return 失败.length > 0;
    });

    // 坏例 5：删内核行、换成重复的 guard 行（行数仍是 3 —— 旧脚本只看行数，所以是绿的）。
    await 判('删内核行换重复 guard 行必红', async () => {
      const dir = 造profile('dup-guard-row');
      const p = join(dir, 'node_modules', BUNDLE, 'cordis.patch.yml');
      const 原 = readFileSync(p, 'utf8');
      const 变 = 原.replace(/^(\s*name:\s*)dsh-mind\/kernel\s*$/m, '$1dsh-mind/guard');
      if (变 === 原) throw new Error('夹具失效：patch 里找不到 name: dsh-mind/kernel');
      writeFileSync(p, 变);
      if (/^\s*name:\s*dsh-mind\/kernel\s*$/m.test(变)) throw new Error('夹具失效：变异后还有一行的 name 是 dsh-mind/kernel');
      const [失败] = await 检查(dir);
      return 失败.length > 0;
    });

    // 坏例 6：profile manifest 带 BOM —— 不许崩，判读要与无 BOM 一致（旧版这里吐裸 SyntaxError 栈）。
    await 判('profile manifest 带 BOM 不崩且判读一致', async () => {
      const dir = 造profile('bom-profile');
      const p = join(dir, 'package.json');
      writeFileSync(p, '\uFEFF' + readFileSync(p, 'utf8'));
      const 头 = readFileSync(p);
      if (!(头[0] === 0xef && 头[1] === 0xbb && 头[2] === 0xbf)) throw new Error('夹具失效：BOM 没写进去');
      const [失败, 通过] = await 检查(dir);
      return 失败.length === 0 && 通过.length >= 5;
    });

    // 坏例 7：JSON 真坏（BOM + 断尾）⇒ 人话诊断，不许裸栈。
    await 判('坏 JSON 给人话诊断不吐裸栈', async () => {
      const dir = 造profile('broken-json', { profile文本: '\uFEFF{"name":"probe","dependencies":{' });
      const [失败] = await 检查(dir);
      return 失败.length >= 1 && 失败[0].includes('不是合法 JSON') && 失败[0].includes('package.json');
    });

    // 坏例 8：删掉**单件**出厂文档（编制.md / 基础设施 README.md）—— 这两件不在任何数组里，
    //        2026-10-12 补漏前删了照样绿。这条就是那次补漏的「能造坏」证明。
    for (const rel of [join(真源.DIR.集体结构, '编制.md'), join(真源.DIR.基础设施, 'README.md')]) {
      await 判(`删单件出厂文档 ${rel} 必红`, async () => {
        const dir = 造profile(`missing-single-${Buffer.from(rel).toString('hex').slice(0, 12)}`);
        const 全 = join(dir, 'node_modules', BUNDLE, 'mind', rel);
        if (!existsSync(全)) throw new Error(`夹具失效：${rel} 不在包里`);
        rmSync(全, { force: true });
        const [失败] = await 检查(dir);
        return 失败.some((line) => line.includes('出厂区缺单件文档') && line.includes(rel));
      });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  let 自检通过 = true;
  for (const [, ok] of cases) {
    if (!ok) 自检通过 = false;
  }
  return 自检通过;
}

const arg = process.argv[2];
if (arg === '--selftest') {
  // Let piped stdout drain on Windows; process.exit can discard the case report.
  process.exitCode = (await selftest()) ? 0 : 1;
} else if (!arg || arg.startsWith('-')) {
  process.stderr.write('用法：node scripts/verify-profile-install.mjs <profileDir>\n      node scripts/verify-profile-install.mjs --selftest\n');
  process.exitCode = 2;
} else {
  const [失败, 通过] = await 检查(arg);
  for (const line of 通过) process.stdout.write(`  ✓ ${line}\n`);
  for (const line of 失败) process.stdout.write(`  ✗ ${line}\n`);
  process.stdout.write(失败.length === 0 ? '安装自检通过。\n' : `安装自检失败 ${失败.length} 条。\n`);
  process.exitCode = 失败.length === 0 ? 0 : 1;
}
