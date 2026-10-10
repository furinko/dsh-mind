#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════
// dsh-mind · profile 安装自检（单包自洽形态，2026-10-11 重写）
// ═══════════════════════════════════════════════════════════════════════════════
//
// 为什么需要它：装错和装对在「装完那一刻」可能长得一样（卡在、不报错，
// 直到装载器 import 组件行才炸）。本脚本把那一刻的判断补上。
// 单包化后要防的病变了：不再是「link: 组件静默不装」（四包形态已废），
// 而是「装到的包不完整」——发布物缺出厂区/缺组件入口/bundles 没挂上。
//
// 用法：
//   node scripts/verify-profile-install.mjs <profileDir>
//   node scripts/verify-profile-install.mjs --selftest   # 临时目录造坏输入，验证本脚本会红
//
// 判据（任一失败 exit 1）：
//   ① profile dependencies 里有 dsh-mind，bundles 里有 dsh-mind 且没有组件 id；
//   ② node_modules/dsh-mind 解析得到：非 private、无 dependencies、
//      exports 的 ./kernel ./guard ./board ./client 全部落盘；
//   ③ 出厂区 mind/（宪章/法律/角色卡/defaults）与 src/ 在包里；
//   ④ cordis.patch 三行 name 都是 dsh-mind/<sub> 且能对上 exports；
//   ⑤ 组件行子路径从 profile 上下文可解析（require.resolve 逐条验）。

import { existsSync, readFileSync, mkdirSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const 脚本目录 = dirname(fileURLToPath(import.meta.url));
const 本仓库 = join(脚本目录, '..');
const BUNDLE = 'dsh-mind';
const 组件 = ['kernel', 'guard', 'board'];

/** 逐条判据：返回 [失败原因们, 通过语们]。 */
function 检查(profileDir) {
  const 失败 = [];
  const 通过 = [];
  const profileManifestPath = join(profileDir, 'package.json');
  if (!existsSync(profileManifestPath)) return [['profile 目录里没有 package.json'], []];
  const profile = JSON.parse(readFileSync(profileManifestPath, 'utf8'));

  const deps = Object.keys(profile.dependencies ?? {});
  if (!deps.includes(BUNDLE)) 失败.push(`dependencies 缺 ${BUNDLE}（装了吗？）`);
  else 通过.push(`dependencies 有 ${BUNDLE}（${profile.dependencies[BUNDLE]}）`);
  const bundles = profile.dsh?.profile?.bundles ?? [];
  if (!bundles.includes(BUNDLE)) 失败.push(`dsh.profile.bundles 缺 ${BUNDLE} —— 官方安装器装完会自动补；缺了就是卡没挂上`);
  else 通过.push(`bundles 含 ${BUNDLE}`);

  const 包目录 = join(profileDir, 'node_modules', BUNDLE);
  if (!existsSync(包目录)) return [[`node_modules/${BUNDLE} 不存在 —— pnpm 没装上`], 通过];
  const pkg = JSON.parse(readFileSync(join(包目录, 'package.json'), 'utf8'));
  if (pkg.name !== BUNDLE) 失败.push(`包名是 ${pkg.name}，应为 ${BUNDLE}`);
  if (pkg.private === true) 失败.push('装到的包是 private —— 像是装进了源码仓而不是发布物');
  if (Object.keys(pkg.dependencies ?? {}).length > 0) 失败.push(`装到的包带着 dependencies（${Object.keys(pkg.dependencies).join(',')}）—— 单包形态不该有`);
  else 通过.push('包内自洽（无 dependencies）');

  for (const sub of [...组件, 'client']) {
    const target = pkg.exports?.[`./${sub}`];
    if (typeof target !== 'string') {
      失败.push(`exports 缺 ./${sub} —— 装载器 import ${BUNDLE}/${sub} 会拒收`);
      continue;
    }
    if (!existsSync(join(包目录, target))) 失败.push(`exports ./${sub} → ${target} 不在包里`);
  }
  if (失败.length === 0) 通过.push('组件入口 ./kernel ./guard ./board ./client 全部落盘');

  if (pkg.dsh?.client?.platform !== 'web') 失败.push('包缺 dsh.client(platform:web) —— 浏览器半区不会被发现');
  const 出厂必备 = ['mind/集体L0-宪章/宪章.md', 'mind/集体L3-成员角色卡/_模板.md', 'mind/集体L2-共享基础设施/defaults/介入度.json', 'src/paths.js'];
  for (const rel of 出厂必备) {
    if (!existsSync(join(包目录, rel))) 失败.push(`包里缺 ${rel} —— 发布物不完整（files 白名单漏了？）`);
  }
  if (失败.filter((f) => f.includes('包里缺')).length === 0) 通过.push('出厂区 mind/ 与 src/ 在包里');

  // 组件行：name 必须是 dsh-mind/<sub> 且对上 exports。
  const patch = readFileSync(join(包目录, 'cordis.patch.yml'), 'utf8');
  const rows = [...patch.matchAll(/^\s*-\s+id:\s*(\S+)\s*$[\s\S]*?^\s+name:\s*(\S+)\s*$/gm)]
    .map((m) => ({ id: m[1], name: m[2].replace(/^['"]|['"]$/g, '') }));
  if (rows.length !== 组件.length) 失败.push(`cordis.patch 应插 ${组件.length} 行，实际 ${rows.length}`);
  for (const row of rows) {
    if (!row.name.startsWith(`${BUNDLE}/`)) 失败.push(`行 ${row.id} 的 name '${row.name}' 不是 ${BUNDLE}/<sub> 子路径`);
    else if (typeof pkg.exports?.[`./${row.name.slice(BUNDLE.length + 1)}`] !== 'string') 失败.push(`行 ${row.id} 的子路径不在 exports 里`);
  }

  // 子路径从 profile 上下文真的解析得到（这是装载器视角）。
  const req = createRequire(profileManifestPath);
  for (const sub of [...组件, 'client']) {
    try {
      req.resolve(`${BUNDLE}/${sub}`);
    } catch (error) {
      失败.push(`require.resolve('${BUNDLE}/${sub}') 失败：${error.message}`);
    }
  }
  if (失败.filter((f) => f.includes('require.resolve')).length === 0) 通过.push('四个子路径从 profile 上下文全部可解析');
  return [失败, 通过];
}

// ── selftest：临时目录造坏输入，本脚本必须红 ─────────────────────────────────
function selftest() {
  const tmp = join(本仓库, '.selftest-verify');
  rmSync(tmp, { recursive: true, force: true });
  let 全红 = true;
  const cases = [];
  const 造profile = (name, { pkgOverrides } = {}) => {
    const dir = join(tmp, name);
    const 包目录 = join(dir, 'node_modules', BUNDLE);
    mkdirSync(包目录, { recursive: true });
    cpSync(join(本仓库, 'mind'), join(包目录, 'mind'), { recursive: true });
    cpSync(join(本仓库, 'src'), join(包目录, 'src'), { recursive: true });
    cpSync(join(本仓库, 'cordis.patch.yml'), join(包目录, 'cordis.patch.yml'));
    for (const c of 组件) {
      mkdirSync(join(包目录, 'components', c, 'lib'), { recursive: true });
      cpSync(join(本仓库, 'components', c, 'lib'), join(包目录, 'components', c, 'lib'), { recursive: true });
    }
    writeFileSync(join(包目录, 'package.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(本仓库, 'package.json'), 'utf8')), ...pkgOverrides }, null, 2));
    const profile = { name: 'probe', dependencies: { [BUNDLE]: 'file:probe' }, dsh: { profile: { bundles: [BUNDLE] } } };
    writeFileSync(join(dir, 'package.json'), JSON.stringify(profile, null, 2));
    return dir;
  };
  // 坏例 1：发布物缺组件入口（files 白名单漏装 board）。
  {
    const dir = 造profile('missing-board');
    rmSync(join(dir, 'node_modules', BUNDLE, 'components', 'board'), { recursive: true, force: true });
    const [失败] = 检查(dir);
    cases.push(['缺组件入口必红', 失败.length > 0]);
  }
  // 坏例 2：bundles 没挂（官方安装器没跑 reconcile 的样子）。
  {
    const dir = 造profile('no-bundle');
    const p = join(dir, 'package.json');
    writeFileSync(p, JSON.stringify({ dependencies: { [BUNDLE]: 'file:probe' } }, null, 2));
    const [失败] = 检查(dir);
    cases.push(['bundles 缺卡必红', 失败.length > 0]);
  }
  // 好例：完整包必须全绿（否则自检本身就是坏的）。
  {
    const dir = 造profile('good');
    const [失败, 通过] = 检查(dir);
    cases.push(['完整包全绿', 失败.length === 0 && 通过.length >= 5]);
  }
  for (const [名, ok] of cases) {
    process.stdout.write(`  ${ok ? '✓' : '✗'} ${名}\n`);
    if (!ok) 全红 = false;
  }
  rmSync(tmp, { recursive: true, force: true });
  return 全红;
}

const arg = process.argv[2];
if (arg === '--selftest') {
  process.exit(selftest() ? 0 : 1);
}
if (!arg || arg.startsWith('-')) {
  process.stderr.write('用法：node scripts/verify-profile-install.mjs <profileDir>\n      node scripts/verify-profile-install.mjs --selftest\n');
  process.exit(2);
}
const [失败, 通过] = 检查(arg);
for (const line of 通过) process.stdout.write(`  ✓ ${line}\n`);
for (const line of 失败) process.stdout.write(`  ✗ ${line}\n`);
process.stdout.write(失败.length === 0 ? '安装自检通过。\n' : `安装自检失败 ${失败.length} 条。\n`);
process.exit(失败.length === 0 ? 0 : 1);
