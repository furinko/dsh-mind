#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════
// dsh-mind · profile 安装自检 —— 专门防「静默不装」
// ═══════════════════════════════════════════════════════════════════════════════
//
// 为什么需要它：`link:` 是纯符号链接协议，pnpm **不解析**目标包的 `dependencies`。
// 本包 package.json 用 `"dsh-mind-kernel": "link:./components/kernel"` 表达组件依赖，
// 所以在 profile 层三个组件包**一个都不会进 node_modules**——而这时：
//   · 卡还在（`dsh.profile.bundles` 里有 dsh-mind）
//   · 不报错（patch 的 insert 行解析不到才炸，往往要等重启/用到才发现）
// 也就是说，装错和装对在「装完那一刻」长得一模一样。本脚本就是把那一刻的判断补上。
//
// 用法：
//   node scripts/verify-profile-install.mjs <profileDir>
//   node scripts/verify-profile-install.mjs --selftest     # 用临时目录造坏输入，验证本脚本会红
//
// 判据（逐条人话输出，任一失败 exit 1）：
//   ① profile package.json 的 dependencies 里有 dsh-mind + 三个组件包；
//   ② dsh.profile.bundles 里有 dsh-mind、且**没有**三个组件包（写全三个 = 三张卡）；
//   ③ 这 4 个包在 <profileDir>/node_modules 下都解析得到（且包名与目录名一致）；
//   ④ 装上的 dsh-mind 的 cordis.patch.yml 里 insert 的 **三条行齐全**
//      （内核 / 安全类 / 看板），且每条 name 都能在 profile 的 node_modules 里解析到
//      （profile 目录是 baseUrl 锚点）。少一行 = 一个组件静默不装，同样判红；
//      多出来的行：解析不到就红，解析得到就不管。
//   ⑤ 装上的 dsh-mind 的出厂区 mind/ 必备目录件齐全（5 个区目录 + 规则件 + 岗位卡 +
//      defaults + 能力库非空）。
//
// 只读：本脚本不改任何东西（除 --selftest 在自己造的临时目录里干活，退出前删干净）。

import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const 本仓库 = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 那张卡（bundle 包）。 */
const BUNDLE_NAME = 'dsh-mind';
/** 三个组件包（顺序与 cordis.patch.yml 的 insert 一致）。 */
const COMPONENT_NAMES = ['dsh-mind-kernel', 'dsh-mind-guard', 'dsh-mind-board'];
/** 4 个必须出现在 profile dependencies 与 node_modules 里的包。 */
const REQUIRED_PACKAGES = [BUNDLE_NAME, ...COMPONENT_NAMES];

const 判据标题 = {
  deps: '① profile dependencies 里有 dsh-mind + 三个组件',
  bundles: '② dsh.profile.bundles 只写 dsh-mind（三个组件不在其中）',
  resolve: '③ 4 个包在 profile 的 node_modules 下解析得到',
  patch: '④ cordis.patch.yml 的 insert 各行 name 解析得到',
  factory: '⑤ 出厂区 mind/ 必备目录件齐全',
};

// ── 小工具 ────────────────────────────────────────────────────────────────────

/** 读 JSON；失败返回 { error }。容忍开头 BOM（手工编辑过的 manifest 常见）。 */
function readJson(path) {
  try {
    const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
    return { value: JSON.parse(text) };
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * 在 <profileDir>/node_modules 下解析一个包名。
 * 不看 pnpm 的写法（junction / symlink / 实体目录都接受），只看「解析得到 + 包名对得上」。
 */
function resolveInProfile(profileDir, name) {
  const dir = join(profileDir, 'node_modules', ...name.split('/'));
  if (!existsSync(dir)) return { ok: false, reason: `node_modules/${name} 不存在` };
  const manifestPath = join(dir, 'package.json');
  if (!existsSync(manifestPath)) return { ok: false, reason: `node_modules/${name} 存在，但没有 package.json（不是包）` };
  const parsed = readJson(manifestPath);
  if (parsed.error) return { ok: false, reason: `node_modules/${name}/package.json 解析失败：${parsed.error}` };
  if (parsed.value.name !== name) {
    return { ok: false, reason: `node_modules/${name} 里 package.json 的 name 是 ${JSON.stringify(parsed.value.name)}，与目录名不符` };
  }
  let real = dir;
  try {
    real = realpathSync(dir);
  } catch {
    /* realpath 失败不影响结论，保留原路径 */
  }
  return { ok: true, dir, real, manifest: parsed.value };
}

/**
 * 从 cordis.patch.yml 里取出 `insert` 块中每条的 `name`。
 *
 * 为什么自己解析而不引 yaml 包：本插件**零依赖**是纪律（不 import 任何 @deepseek-ai/*，
 * 也不给用户添安装负担），而这里只需要 insert 块里的 name 列表这一个信息。
 * 约定：`- insert:`（或 `insert:`）那一行的缩进是块缩进，块内更深的行里 `name:` 即一条。
 */
export function readInsertNames(patchText) {
  const names = [];
  const lines = patchText.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index].replace(/\s+#.*$/, '');
    if (!raw.trim()) continue;
    const indent = raw.match(/^\s*/)[0].length;
    const trimmed = raw.trim();
    if (!/^(?:-\s*)?insert\s*:\s*$/.test(trimmed)) continue;
    // 进入 insert 块：收后续更深缩进的行，直到遇到不更深且非空的行。
    for (let inner = index + 1; inner < lines.length; inner += 1) {
      const line = lines[inner].replace(/\s+#.*$/, '');
      if (!line.trim()) continue;
      const innerIndent = line.match(/^\s*/)[0].length;
      if (innerIndent <= indent) break;
      const match = /^(?:-\s*)?name\s*:\s*(.+?)\s*$/.exec(line.trim());
      if (match) names.push(match[1].replace(/^['"]|['"]$/g, ''));
    }
  }
  return names;
}

/** 出厂区必备清单的兜底副本（`src/paths.js` 读不到时用；读到就以 paths.js 为准）。 */
const 兜底出厂清单 = {
  source: '内置兜底清单（src/paths.js 读不到）',
  zones: ['集体L0-宪章', '集体L1-法律', '集体L2-集体结构', '集体L2-共享基础设施', '集体L3-成员角色卡'],
  rules: [
    ['集体L0-宪章', '宪章.md'],
    ['集体L1-法律', '协作协议.md'],
    ['集体L1-法律', '权限矩阵.md'],
    ['集体L1-法律', '裁决流程.md'],
    ['集体L1-法律', '审计要求.md'],
  ],
  roleCardDir: '集体L3-成员角色卡',
  roleCards: ['_模板.md', '复核员.md', '插件工程.md', '文档整理.md', '记忆整理.md'],
  defaultsDir: '集体L2-共享基础设施/defaults',
  defaults: ['介入度.json', '响应期限.json', '工具总范围.json', '安全类探针.json'],
  capabilityDir: '集体L2-共享基础设施/能力库',
};

/** 出厂区必备清单：优先读「装上的那个包」自己的 src/paths.js（单源），退回本仓库，再退回兜底。 */
async function loadFactorySpec(installedRoot) {
  const candidates = [join(installedRoot, 'src', 'paths.js'), join(本仓库, 'src', 'paths.js')];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const mod = await import(pathToFileURL(candidate).href);
      const DIR = mod.DIR;
      return {
        source: candidate,
        zones: [DIR.宪章, DIR.法律, DIR.集体结构, DIR.基础设施, DIR.角色卡],
        rules: mod.RULE_FILES.map((spec) => [spec.dir, spec.file]),
        roleCardDir: DIR.角色卡,
        roleCards: [...mod.ROLE_CARD_FILES],
        defaultsDir: join(DIR.基础设施, DIR.默认值),
        defaults: Object.values(mod.DEFAULT_FILES),
        capabilityDir: join(DIR.基础设施, DIR.能力库),
      };
    } catch {
      /* 换下一个候选 */
    }
  }
  return 兜底出厂清单;
}

// ── 五条判据 ──────────────────────────────────────────────────────────────────

/**
 * 跑完五条判据。
 * @param {string} profileDir 被检的 profile 目录。
 * @returns {Promise<Array<{id: string, ok: boolean, lines: string[]}>>}
 */
export async function runChecks(profileDir) {
  const results = [];
  const push = (id, ok, lines) => results.push({ id, ok, lines });

  // ① + ②：profile 的 package.json
  const manifestPath = join(profileDir, 'package.json');
  const manifest = existsSync(manifestPath) ? readJson(manifestPath) : { error: `没有这个文件：${manifestPath}` };
  const dependencies = manifest.value?.dependencies ?? {};
  const bundles = manifest.value?.dsh?.profile?.bundles ?? [];

  if (manifest.error) {
    const 说 = [`读不到 profile 的 package.json：${manifest.error}`];
    push('deps', false, 说);
    push('bundles', false, 说);
  } else {
    const 缺 = REQUIRED_PACKAGES.filter((name) => !(name in dependencies));
    const 依赖行 = REQUIRED_PACKAGES.map((name) => `${name in dependencies ? '✔' : '✘'} ${name}${name in dependencies ? ` = ${JSON.stringify(dependencies[name])}` : ' —— dependencies 里没有它'}`);
    push('deps', 缺.length === 0, [
      ...依赖行,
      ...(缺.length === 0
        ? []
        : [`缺 ${缺.length} 个：${缺.join('、')}。` + '注意：`link:` 不解析目标包的 dependencies，组件必须**显式**写在 profile 的 dependencies 里（README 安装节）。']),
    ]);

    const 有卡 = bundles.includes(BUNDLE_NAME);
    const 多出来的 = COMPONENT_NAMES.filter((name) => bundles.includes(name));
    push('bundles', 有卡 && 多出来的.length === 0, [
      `${有卡 ? '✔' : '✘'} bundles 里有 ${BUNDLE_NAME}（那张卡）`,
      `${多出来的.length === 0 ? '✔' : '✘'} bundles 里没有三个组件包${多出来的.length ? `（多了：${多出来的.join('、')}）` : ''}`,
      ...(多出来的.length
        ? ['组件包写进 bundles 会各自变成**一张卡**，而不是那张卡下面的行——组件的行来自 dsh-mind 的 cordis.patch.yml。']
        : []),
      ...(有卡 ? [] : ['bundles 里没有 dsh-mind，等于这张卡不会被挂载。']),
    ]);
  }

  // ③：node_modules 解析
  const 解析 = new Map();
  const 解析行 = [];
  let 解析全过 = true;
  for (const name of REQUIRED_PACKAGES) {
    const found = resolveInProfile(profileDir, name);
    解析.set(name, found);
    解析行.push(`${found.ok ? '✔' : '✘'} ${name}${found.ok ? ` → ${found.real}` : ` —— ${found.reason}`}`);
    if (!found.ok) 解析全过 = false;
  }
  push('resolve', 解析全过, 解析行);

  // ④：patch 的三行 name（解析锚点是 profile 目录）
  const bundle = 解析.get(BUNDLE_NAME);
  if (!bundle?.ok) {
    push('patch', false, [`✘ 先要能解析到 ${BUNDLE_NAME} 才能看它的 cordis.patch.yml —— 见判据 ③`]);
  } else {
    const patchPath = join(bundle.dir, 'cordis.patch.yml');
    const patchText = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : null;
    if (patchText === null) {
      push('patch', false, [`✘ 装上的 ${BUNDLE_NAME} 里没有 cordis.patch.yml（${patchPath}）—— 它就不是一张 bundle 卡`]);
    } else {
      const names = readInsertNames(patchText);
      const 行 = [];
      let ok = names.length > 0;
      if (names.length === 0) 行.push('✘ cordis.patch.yml 的 insert 块里一条 name 都没解析出来（文件被改坏了吗？）');
      for (const name of names) {
        const found = resolveInProfile(profileDir, name);
        行.push(`${found.ok ? '✔' : '✘'} insert: ${name}${found.ok ? ' 解析得到' : ` —— ${found.reason}（这一行挂不上，组件静默不装）`}`);
        if (!found.ok) ok = false;
      }
      const 少的 = COMPONENT_NAMES.filter((name) => !names.includes(name));
      if (少的.length) {
        ok = false;
        行.push(`✘ patch 里缺 insert 行：${少的.join('、')} —— 少一行 = 一个组件静默不装，与本 bug 同类`);
      } else {
        行.push('✔ patch 里三条 insert 行齐全（内核 / 安全类 / 看板）');
      }
      push('patch', ok, 行);
    }
  }

  // ⑤：出厂区 mind/
  if (!bundle?.ok) {
    push('factory', false, [`✘ 先要能解析到 ${BUNDLE_NAME} 才能看它的 mind/ —— 见判据 ③`]);
  } else {
    const spec = await loadFactorySpec(bundle.dir);
    const factoryRoot = join(bundle.dir, 'mind');
    const 行 = [`ℹ 必备清单来源：${spec.source}`];
    let ok = true;
    if (!existsSync(factoryRoot)) {
      push('factory', false, [...行, `✘ 没有出厂区目录：${factoryRoot}`]);
    } else {
      const 缺目录 = spec.zones.filter((zone) => !existsSync(join(factoryRoot, zone)));
      ok = ok && 缺目录.length === 0;
      行.push(`${缺目录.length === 0 ? '✔' : '✘'} 5 个区目录${缺目录.length ? ` 缺：${缺目录.join('、')}` : '齐全'}`);
      const 缺规则 = spec.rules.filter(([dir, file]) => !existsSync(join(factoryRoot, dir, file)));
      ok = ok && 缺规则.length === 0;
      行.push(`${缺规则.length === 0 ? '✔' : '✘'} 规则件 ${spec.rules.length} 个${缺规则.length ? ` 缺：${缺规则.map(([d, f]) => `${d}/${f}`).join('、')}` : '齐全'}`);
      const 缺岗位卡 = spec.roleCards.filter((file) => !existsSync(join(factoryRoot, spec.roleCardDir, file)));
      ok = ok && 缺岗位卡.length === 0;
      行.push(`${缺岗位卡.length === 0 ? '✔' : '✘'} 岗位卡 ${spec.roleCards.length} 个${缺岗位卡.length ? ` 缺：${缺岗位卡.join('、')}` : '齐全'}`);
      const 缺默认值 = spec.defaults.filter((file) => !existsSync(join(factoryRoot, spec.defaultsDir, file)));
      ok = ok && 缺默认值.length === 0;
      行.push(`${缺默认值.length === 0 ? '✔' : '✘'} defaults ${spec.defaults.length} 个${缺默认值.length ? ` 缺：${缺默认值.join('、')}` : '齐全'}`);
      const 能力目录 = join(factoryRoot, spec.capabilityDir);
      let 能力数 = 0;
      if (existsSync(能力目录)) {
        try {
          能力数 = readdirSync(能力目录).filter((name) => name.endsWith('.md')).length;
        } catch {
          能力数 = 0;
        }
      }
      ok = ok && 能力数 > 0;
      行.push(`${能力数 > 0 ? '✔' : '✘'} 能力库里有 ${能力数} 张能力卡（要求 > 0）`);
      push('factory', ok, 行);
    }
  }

  return results;
}

/** 打印一份自检报告；返回是否有失败。 */
function printReport(title, results) {
  process.stdout.write(`\n${title}\n`);
  let 失败 = 0;
  for (const result of results) {
    if (!result.ok) 失败 += 1;
    process.stdout.write(`\n${result.ok ? '[通过]' : '[失败]'} ${判据标题[result.id]}\n`);
    for (const line of result.lines) process.stdout.write(`        ${line}\n`);
  }
  process.stdout.write(`\n合计：${results.length} 条判据，通过 ${results.length - 失败}，失败 ${失败}\n`);
  return 失败 > 0;
}

// ── --selftest：给每条判据造一个坏输入，验证它真的会红 ────────────────────────

const ZONES = 兜底出厂清单.zones;

/** 把本仓库的一个子目录复制进临时区（跳过 .git / node_modules）。 */
function 复制包(target, source) {
  cpSync(source, target, {
    recursive: true,
    filter: (src) => !/[\\/]\.git([\\/]|$)/.test(src) && !/[\\/]node_modules([\\/]|$)/.test(src),
  });
}

/** 造一个假 dsh-mind 包：patch 的 insert 行可控、出厂区可控（只用于 selftest）。 */
function 造假bundle(root, 名, { insertNames, zones }) {
  const 包目录 = join(root, 名);
  mkdirSync(包目录, { recursive: true });
  writeFileSync(join(包目录, 'package.json'), `${JSON.stringify({
    name: BUNDLE_NAME,
    version: '0.0.0-selftest',
    type: 'module',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2)}\n`);
  const patch = ['- insert:', ...insertNames.flatMap((name) => [`    - id: ${name}`, `      name: ${name}`])].join('\n');
  writeFileSync(join(包目录, 'cordis.patch.yml'), `${patch}\n`);
  const 出厂 = join(包目录, 'mind');
  mkdirSync(出厂, { recursive: true });
  for (const zone of zones) 复制包(join(出厂, zone), join(本仓库, 'mind', zone));
  return 包目录;
}

/** 造一个 profile 目录：package.json + node_modules 下的实体副本。 */
function 造profile(root, 名, { deps, bundles, packages }) {
  const dir = join(root, 名);
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  const dependencies = {};
  for (const name of deps) dependencies[name] = `link:${join(root, 'src', name).replace(/\\/g, '/')}`;
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name: `selftest-profile-${名}`,
    private: true,
    dependencies,
    dsh: { profile: { bundles } },
  }, null, 2)}\n`);
  for (const [name, source] of Object.entries(packages)) {
    if (source === null) continue;
    复制包(join(dir, 'node_modules', name), source);
  }
  return dir;
}

async function runSelftest() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mind-selftest-'));
  const 好包 = {
    [BUNDLE_NAME]: 本仓库,
    'dsh-mind-kernel': join(本仓库, 'components', 'kernel'),
    'dsh-mind-guard': join(本仓库, 'components', 'guard'),
    'dsh-mind-board': join(本仓库, 'components', 'board'),
  };
  const 全 = REQUIRED_PACKAGES;
  let 未达标 = 0;

  /** 一个 fixture = 一份 profile 目录 + 期望必须红的判据（空数组 = 期望全绿）。 */
  const fixtures = [
    {
      名: '好的 profile（对照：必须全绿）',
      期望红: [],
      造: () => 造profile(root, 'good', { deps: 全, bundles: [BUNDLE_NAME], packages: 好包 }),
    },
    {
      名: '判据①坏输入：dependencies 只写 dsh-mind（照 README 旧说法的结果）',
      期望红: ['deps'],
      造: () => 造profile(root, 'no-component-deps', { deps: [BUNDLE_NAME], bundles: [BUNDLE_NAME], packages: 好包 }),
    },
    {
      名: '判据②坏输入：三个组件写进了 dsh.profile.bundles（变成三张卡）',
      期望红: ['bundles'],
      造: () => 造profile(root, 'components-in-bundles', { deps: 全, bundles: [BUNDLE_NAME, ...COMPONENT_NAMES], packages: 好包 }),
    },
    {
      名: '判据③坏输入：dependencies 写全了，但 node_modules 里缺 dsh-mind-board（link: 静默不装的现场）',
      期望红: ['resolve'],
      造: () => 造profile(root, 'missing-board', { deps: 全, bundles: [BUNDLE_NAME], packages: { ...好包, 'dsh-mind-board': null } }),
    },
    {
      名: '判据④坏输入：patch 里有一行 name 在 node_modules 里解析不到',
      期望红: ['patch'],
      造: () => {
        const 假 = 造假bundle(root, 'fake-bundle-ghost', { insertNames: [...COMPONENT_NAMES, 'dsh-mind-ghost'], zones: ZONES });
        return 造profile(root, 'ghost-insert', { deps: 全, bundles: [BUNDLE_NAME], packages: { ...好包, [BUNDLE_NAME]: 假 } });
      },
    },
    {
      名: '判据④坏输入：patch 只剩两条 insert（看板那一行没了）',
      期望红: ['patch'],
      造: () => {
        const 假 = 造假bundle(root, 'fake-bundle-two-rows', { insertNames: COMPONENT_NAMES.slice(0, 2), zones: ZONES });
        return 造profile(root, 'two-insert-rows', { deps: 全, bundles: [BUNDLE_NAME], packages: { ...好包, [BUNDLE_NAME]: 假 } });
      },
    },
    {
      名: '判据⑤坏输入：装上的 dsh-mind 出厂区缺一个区目录（集体L1-法律）',
      期望红: ['factory'],
      造: () => {
        const 假 = 造假bundle(root, 'fake-bundle-no-law', { insertNames: COMPONENT_NAMES, zones: ZONES.filter((z) => z !== '集体L1-法律') });
        return 造profile(root, 'broken-factory', { deps: 全, bundles: [BUNDLE_NAME], packages: { ...好包, [BUNDLE_NAME]: 假 } });
      },
    },
  ];

  process.stdout.write(`\n== 自检脚本自己的反例测试（--selftest）==\n临时区：${root}\n`);
  process.stdout.write('判定方式：期望变红的判据必须真的红（坏输入连带弄红相关判据不算不达标）。\n');
  try {
    for (const fixture of fixtures) {
      const dir = fixture.造();
      const results = await runChecks(dir);
      const 实际红 = results.filter((r) => !r.ok).map((r) => r.id);
      const 期望红 = [...fixture.期望红].sort();
      // 子集判定：期望红的判据**必须**红；坏输入连带弄红相关判据（例如缺组件包同时让 ③④ 红）不算不达标。
      const 一致 = 期望红.every((id) => 实际红.includes(id));
      if (!一致) 未达标 += 1;
      process.stdout.write(`\n${一致 ? '[反例达标]' : '[反例不达标]'} ${fixture.名}\n`);
      process.stdout.write(`        期望变红：${期望红.length ? 期望红.map((id) => 判据标题[id]).join(' / ') : '（无，应全绿）'}\n`);
      process.stdout.write(`        实际变红：${实际红.length ? 实际红.map((id) => 判据标题[id]).join(' / ') : '（无，全绿）'}\n`);
      if (!一致) {
        process.stdout.write(`        实际明细：\n`);
        for (const result of results.filter((r) => !r.ok)) {
          for (const line of result.lines) process.stdout.write(`          ${line}\n`);
        }
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  process.stdout.write(`\n反例测试结论：${fixtures.length} 个 fixture，${fixtures.length - 未达标} 个达标，${未达标} 个不达标\n`);
  return 未达标 > 0;
}

// ── 入口 ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write('用法：node scripts/verify-profile-install.mjs <profileDir>\n      node scripts/verify-profile-install.mjs --selftest\n');
  process.exit(0);
}

if (args.includes('--selftest')) {
  const 坏 = await runSelftest();
  process.exit(坏 ? 1 : 0);
}

const target = args.find((arg) => !arg.startsWith('-'));
if (target === undefined) {
  process.stderr.write('用法：node scripts/verify-profile-install.mjs <profileDir>\n');
  process.stderr.write('例：  node scripts/verify-profile-install.mjs %USERPROFILE%\\.dsh\\profiles\\desktop\n');
  process.exit(2);
}

const profileDir = resolve(target);
if (!existsSync(join(profileDir, 'package.json'))) {
  process.stderr.write(`不是 profile 目录（没有 package.json）：${profileDir}\n`);
  process.exit(2);
}

const results = await runChecks(profileDir);
const 坏 = printReport(`dsh-mind 安装自检 —— profile：${profileDir}`, results);
process.stdout.write(坏
  ? '\n结论：**装得不完整**。按上面失败项的提示改 profile 的 package.json，重跑 pnpm install，再跑一次本脚本。\n'
  : '\n结论：这张卡与三个组件都在位（组件依赖显式写进 profile、bundles 只写 dsh-mind）。\n');
process.exit(坏 ? 1 : 0);
