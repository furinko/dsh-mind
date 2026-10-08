#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════
// dsh-mind · 一键装进 profile（幂等）
// ═══════════════════════════════════════════════════════════════════════════════
//
// 为什么需要它：手工装法要求「四个包都写进 profile 的 dependencies、bundles 只写 dsh-mind」，
// 而**官方 CLI（`dsh plugin add`）只会写 dsh-mind 一行**——组件一个都不跟进来（实测），
// 照它装就是组件静默不装。本脚本把那段手工编辑固化下来，并且装完**自动跑自检**当验收闸。
//
// 用法：
//   node scripts/install-into-profile.mjs <profileDir> [--dry-run] [--pnpm <pnpm 命令前缀>]
//
// 它做什么（幂等，可反复跑）：
//   1. 读 <profileDir>/package.json；
//   2. dependencies 补上四行：dsh-mind + 三个组件（link: 指向本仓库），写法已正确就不动；
//   3. dsh.profile.bundles 确保有 dsh-mind，并确保三个组件**不在**其中（在就移除并告知——那是「三张卡」的错误形态）；
//   4. 有改动时先把原文件备份成 package.json.bak-install-<时间戳>，再写；
//   5. 在 <profileDir> 里跑 pnpm install（探测不到 pnpm 就明确报错，不假装成功）；
//   6. 最后跑 scripts/verify-profile-install.mjs <profileDir> 当验收闸（非 0 ⇒ 本脚本也非 0）。
//
// 硬边界：
//   · **绝不自动挑选或猜测 profileDir**：无参数即用法错误 exit 2；不是 profile 目录也 exit 2（不替谁创建 profile）。
//   · **不重启 / 不杀死 / 不启动任何客户端进程**：改完只是「需要重启客户端才生效」，本脚本只提示，不代劳。
//   · **不碰 profile 之外的文件**（除了读取本仓库自身、以及 pnpm 自己的全局 store）。
//   · --dry-run：只打印将要做的改动，不写文件、不跑 pnpm、不跑自检。

import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const 脚本目录 = dirname(fileURLToPath(import.meta.url));
const 本仓库 = resolve(脚本目录, '..');
const 自检脚本 = join(脚本目录, 'verify-profile-install.mjs');

const BUNDLE_NAME = 'dsh-mind';
const COMPONENT_NAMES = ['dsh-mind-kernel', 'dsh-mind-guard', 'dsh-mind-board'];
const REQUIRED_PACKAGES = [BUNDLE_NAME, ...COMPONENT_NAMES];

/** 包 → 本仓库里的目标目录。 */
const 包目录 = {
  [BUNDLE_NAME]: 本仓库,
  'dsh-mind-kernel': join(本仓库, 'components', 'kernel'),
  'dsh-mind-guard': join(本仓库, 'components', 'guard'),
  'dsh-mind-board': join(本仓库, 'components', 'board'),
};

/** 期望写进 profile 的依赖写法（pnpm 的 link: 协议，正斜杠）。 */
const 期望写法 = Object.fromEntries(
  REQUIRED_PACKAGES.map((name) => [name, `link:${包目录[name].replace(/\\/g, '/')}`]),
);

const 用法 = [
  '用法：node scripts/install-into-profile.mjs <profileDir> [--dry-run] [--pnpm <pnpm 命令前缀>]',
  '例：  node scripts/install-into-profile.mjs %USERPROFILE%\\.dsh\\profiles\\desktop',
  '      node scripts/install-into-profile.mjs %USERPROFILE%\\.dsh\\profiles\\desktop --dry-run',
  '',
  'pnpm 探测顺序：--pnpm 参数 → 环境变量 DSH_MIND_PNPM / DSH_PNPM → PATH 上的 pnpm →',
  '              官方桌面客户端自带的 resources/runtime/pnpm/bin/pnpm.mjs（用当前 node 跑）。',
].join('\n');

// ── 小工具 ────────────────────────────────────────────────────────────────────

/** 读 JSON（容忍 BOM）；失败返回 { error }。 */
function readJson(path) {
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) };
  } catch (error) {
    return { error: error.message };
  }
}

/** 时间戳，用于备份名。 */
function 时间戳() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 备份路径（同目录，重名则加序号）。 */
function 备份路径(profileDir) {
  const 基 = `package.json.bak-install-${时间戳()}`;
  let 候选 = join(profileDir, 基);
  let n = 2;
  while (existsSync(候选)) {
    候选 = join(profileDir, `${基}-${n}`);
    n += 1;
  }
  return 候选;
}

// ── pnpm 探测 ─────────────────────────────────────────────────────────────────

/**
 * 找官方桌面客户端自带的 pnpm（`resources/runtime/pnpm/bin/pnpm.mjs`，也兼容同级 `pnpm.mjs`）。
 * 根目录来源：DSH_DESKTOP_ROOT / DSH_DESKTOP_HOME → 派生盘符（DSH_HOME、node 自身、当前目录所在盘）
 * 的一级目录名带 dsh/harness/deepseek 的 → %LOCALAPPDATA%\Programs、%ProgramFiles%、%ProgramFiles(x86)% 的一级目录
 * → 开发版 node 安装（%LOCALAPPDATA%\dshome-dev\node\node_modules\pnpm\pnpm.cjs）。
 * 找不到返回空数组（不报错）。
 */
function 找自带pnpm() {
  const 布局 = [
    join('resources', 'runtime', 'pnpm', 'bin', 'pnpm.mjs'),
    join('resources', 'runtime', 'pnpm', 'pnpm.mjs'),
    join('node_modules', 'pnpm', 'pnpm.cjs'),
  ];
  const 根 = [];
  const 加根 = (p) => {
    if (p && !根.includes(p)) 根.push(p);
  };
  for (const key of ['DSH_DESKTOP_ROOT', 'DSH_DESKTOP_HOME']) {
    const v = process.env[key];
    if (v) 加根(resolve(v));
  }
  // 派生盘符的一级目录：名字带 dsh / harness / deepseek 的（本机客户端装在 E:\DeepSeek_Harness_Desktop）。
  const 盘符 = new Set();
  for (const p of [process.env.DSH_HOME, process.execPath, process.cwd(), process.env.LOCALAPPDATA]) {
    if (!p) continue;
    const m = /^([A-Za-z]:)[\\/]/.exec(resolve(p));
    if (m) 盘符.add(m[1]);
  }
  const 目录们 = [...盘符].map((d) => `${d}\\`);
  for (const 父 of [
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs'),
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
  ]) {
    if (父) 目录们.push(父);
  }
  for (const 父 of 目录们) {
    let 子;
    try {
      子 = readdirSync(父, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of 子) {
      if (!e.isDirectory()) continue;
      if (!/dsh|harness|deepseek/i.test(e.name)) continue;
      加根(join(父, e.name));
    }
  }
  // 开发版 node 安装（本机见过：pnpm.cjs 在 node/node_modules/pnpm 下）。
  if (process.env.LOCALAPPDATA) 加根(join(process.env.LOCALAPPDATA, 'dshome-dev', 'node'));

  const 找到 = [];
  for (const 根目录 of 根) {
    for (const 相对 of 布局) {
      const p = join(根目录, 相对);
      if (existsSync(p)) 找到.push(p);
    }
  }
  return 找到;
}

/**
 * 探测可用的 pnpm：逐个候选跑 `--version`，第一个返回 0 的胜出。
 * 为什么要先试跑：PATH 上可能只有一个跑不起来的 shim（本机就见过 `pnpm.ps1` 被执行策略挡住），
 * 「探测到了」不等于「能用」。
 * @param {string|undefined} 显式 来自 `--pnpm`。
 * @returns {{ok: true, 候选: object, 版本: string} | {ok: false, 候选: object[], 试过的: string[]}}
 */
function 探测pnpm(显式) {
  const 候选 = [];
  if (显式) 候选.push({ 来源: '--pnpm 参数', 类型: 'shell', 命令: 显式 });
  for (const key of ['DSH_MIND_PNPM', 'DSH_PNPM']) {
    const v = process.env[key];
    if (v && v.trim()) 候选.push({ 来源: `环境变量 ${key}`, 类型: 'shell', 命令: v.trim() });
  }
  候选.push({ 来源: 'PATH 上的 pnpm', 类型: 'shell', 命令: 'pnpm' });
  for (const mjs of 找自带pnpm()) {
    候选.push({ 来源: `官方客户端自带 pnpm（${mjs}）`, 类型: 'node', 命令: mjs });
  }

  const 试过的 = [];
  for (const c of 候选) {
    const r = c.类型 === 'shell'
      ? spawnSync(`${c.命令} --version`, { shell: true, encoding: 'utf8' })
      : spawnSync(process.execPath, [c.命令, '--version'], { encoding: 'utf8' });
    const 版本 = (r.stdout ?? '').trim().split(/\r?\n/).pop() ?? '';
    if (r.status === 0 && 版本) return { ok: true, 候选: c, 版本 };
    试过的.push(`${c.来源} → ${r.error ? r.error.message : `退出码 ${r.status}`}`);
  }
  return { ok: false, 候选, 试过的 };
}

/** 用选定的 pnpm 跑一条子命令（stdio 直通，看得见 pnpm 的输出）。 */
function 跑pnpm(候选, 子命令, cwd) {
  const r = 候选.类型 === 'shell'
    ? spawnSync(`${候选.命令} ${子命令}`, { shell: true, cwd, stdio: 'inherit' })
    : spawnSync(process.execPath, [候选.命令, 子命令], { cwd, stdio: 'inherit' });
  return r.status ?? 1;
}

// ── 改动计算 ──────────────────────────────────────────────────────────────────

/**
 * 算出要对 profile manifest 做的改动。
 * @returns {{改动: string[], 变更: boolean, 新manifest: object, 被移除的组件: string[]}}
 */
function 算改动(manifest) {
  const 改动 = [];
  let 变更 = false;
  const 新 = structuredClone(manifest);

  // ① dependencies 四行
  const deps = { ...(新.dependencies ?? {}) };
  for (const name of REQUIRED_PACKAGES) {
    const 想要 = 期望写法[name];
    if (!(name in deps)) {
      改动.push(`  + dependencies.${name} = ${JSON.stringify(想要)}`);
      deps[name] = 想要;
      变更 = true;
    } else if (deps[name] !== 想要) {
      改动.push(`  ~ dependencies.${name}: ${JSON.stringify(deps[name])} → ${JSON.stringify(想要)}`);
      deps[name] = 想要;
      变更 = true;
    } else {
      改动.push(`  = dependencies.${name} 已是 ${JSON.stringify(想要)}，不动`);
    }
  }
  if (变更) 新.dependencies = deps;

  // ② bundles：确保有 dsh-mind，确保三个组件不在其中
  const 原bundles = Array.isArray(新.dsh?.profile?.bundles) ? [...新.dsh.profile.bundles] : [];
  let bundles = [...原bundles];
  let bundles变更 = false;

  const 被移除的组件 = COMPONENT_NAMES.filter((name) => bundles.includes(name));
  if (被移除的组件.length) {
    bundles = bundles.filter((name) => !被移除的组件.includes(name));
    bundles变更 = true;
    for (const name of 被移除的组件) {
      改动.push(`  − bundles.${name} 移除（组件写进 bundles 会各自变成一张卡，而不是那张卡下面的行）`);
    }
  }
  if (!bundles.includes(BUNDLE_NAME)) {
    bundles.push(BUNDLE_NAME);
    bundles变更 = true;
    改动.push(`  + bundles.${BUNDLE_NAME} 追加（那张卡）`);
  } else {
    改动.push(`  = bundles.${BUNDLE_NAME} 已在其中，不动`);
  }

  if (bundles变更) {
    新.dsh = { ...(新.dsh ?? {}), profile: { ...(新.dsh?.profile ?? {}), bundles } };
    变更 = true;
  }

  if (改动.length === 0) 改动.push('  （没有需要改的地方）');
  return { 改动, 变更, 新manifest: 新, 被移除的组件 };
}

// ── 主流程 ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(`${用法}\n`);
  process.exit(0);
}

const 干跑 = argv.includes('--dry-run');
let 显式pnpm;
const pnpm下标 = argv.indexOf('--pnpm');
if (pnpm下标 !== -1) {
  显式pnpm = argv[pnpm下标 + 1];
  if (显式pnpm === undefined) {
    process.stderr.write('--pnpm 后面要给命令前缀，例如：--pnpm "pnpm"\n');
    process.exit(2);
  }
}

const pnpm值下标 = pnpm下标 === -1 ? -1 : pnpm下标 + 1;
const 位置参数 = argv.filter((arg, index) => !arg.startsWith('-') && index !== pnpm值下标);
if (位置参数.length === 0) {
  process.stderr.write(`${用法}\n`);
  process.exit(2);
}
if (位置参数.length > 1) {
  process.stderr.write(`只接受一个 profileDir，收到 ${位置参数.length} 个：${位置参数.join('、')}\n${用法}\n`);
  process.exit(2);
}

const profileDir = resolve(位置参数[0]);
const manifestPath = join(profileDir, 'package.json');
if (!existsSync(manifestPath)) {
  process.stderr.write(
    `不是 profile 目录（没有 package.json）：${profileDir}\n`
    + '本脚本**不会**替你猜或创建 profile——请给准 profile 目录（例：%USERPROFILE%\\.dsh\\profiles\\desktop）。\n',
  );
  process.exit(2);
}

const parsed = readJson(manifestPath);
if (parsed.error) {
  process.stderr.write(`读不了 ${manifestPath}：${parsed.error}\n`);
  process.exit(2);
}

process.stdout.write(`\n=== dsh-mind 一键装进 profile${干跑 ? '（--dry-run）' : ''} ===\n`);
process.stdout.write(`profile：${profileDir}\n`);
process.stdout.write(`本仓库：${本仓库}\n`);
process.stdout.write(`\n将要做的改动：\n`);
const { 改动, 变更, 新manifest, 被移除的组件 } = 算改动(parsed.value);
for (const 行 of 改动) process.stdout.write(`${行}\n`);

if (干跑) {
  process.stdout.write('\n（--dry-run：没有写任何文件，也没有跑 pnpm；去掉 --dry-run 才会真装。）\n');
  process.exit(0);
}

if (变更) {
  const 备份 = 备份路径(profileDir);
  copyFileSync(manifestPath, 备份);
  writeFileSync(manifestPath, `${JSON.stringify(新manifest, null, 2)}\n`);
  process.stdout.write(`\n已备份原文件：${备份}\n`);
  process.stdout.write(`已写入：${manifestPath}\n`);
  if (被移除的组件.length) {
    process.stdout.write(`注意：bundles 里原来的 ${被移除的组件.join('、')} 已移除——那是「三张卡」的错误形态，组件行来自 dsh-mind 的 cordis.patch.yml。\n`);
  }
} else {
  process.stdout.write('\npackage.json 无需改动（未写文件、未备份）。\n');
}

// 跑 pnpm install
process.stdout.write('\n探测 pnpm…\n');
const 探测 = 探测pnpm(显式pnpm);
if (!探测.ok) {
  process.stderr.write('✘ 探测不到可用的 pnpm。试过的候选：\n');
  for (const 行 of 探测.试过的) process.stderr.write(`    ${行}\n`);
  const 自带 = 找自带pnpm();
  process.stderr.write('\n手工方案（在 profile 目录里跑其中一条）：\n');
  process.stderr.write(`    cd "${profileDir}"\n`);
  process.stderr.write('    pnpm install\n');
  for (const mjs of 自带) process.stderr.write(`    node "${mjs}" install\n`);
  process.stderr.write('    或指定：node scripts/install-into-profile.mjs <profileDir> --pnpm "<pnpm 命令前缀>"\n');
  process.stderr.write('\n（package.json 已经写好，pnpm install 成功后跑自检即可：\n');
  process.stderr.write(`     node "${自检脚本}" "${profileDir}" ）\n`);
  process.exit(1);
}
process.stdout.write(`用 ${探测.候选.来源}（版本 ${探测.版本}）\n`);
process.stdout.write(`在 ${profileDir} 里跑 pnpm install…\n\n`);
const 装码 = 跑pnpm(探测.候选, 'install', profileDir);
if (装码 !== 0) {
  process.stderr.write(`\n✘ pnpm install 退出码 ${装码}——装没成，别当成功。\n`);
  process.exit(装码);
}

// 验收闸：自检
process.stdout.write('\n跑验收闸（scripts/verify-profile-install.mjs）…\n');
const 闸 = spawnSync(process.execPath, [自检脚本, profileDir], { stdio: 'inherit' });
const 闸码 = 闸.status ?? 1;
if (闸码 !== 0) {
  process.stderr.write(`\n✘ 自检没过（退出码 ${闸码}）：装得不完整，按上面失败项改。\n`);
  process.exit(闸码);
}

process.stdout.write('\n✔ 装好了：四行依赖都在、bundles 只写 dsh-mind、自检 5/5 通过。\n');
process.stdout.write('提示：**需要重启客户端才生效**（本脚本不重启任何进程，也不杀进程）。\n');
process.exit(0);
