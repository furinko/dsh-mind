/**
 * 交付前自检：出厂件结构 + 组件名册 + 浏览器半区的经典脚本约束 + 全部模块可加载。
 *
 * 为什么要有它而不只靠测试：`client.js` 里出现一个顶层 `export` 会让**整站 web 启动失败**，
 * 出厂件结构不合规会让策略引擎 fail-closed 到全拒绝，而漏一个 `exports` 项会让宿主
 * 按子路径加载时被 ESM 直接拒收。这三种故障都不该等到重启之后才被发现。
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument, assertStructure } from '../src/tags.js';
import { listFiles, readTextOrNull } from '../src/kernel/fsx.js';
import { RULE_FILES, ROLE_CARD_FILES } from '../src/paths.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const failures = [];
const notes = [];

/** 出厂区：规则件与岗位卡必须结构合规。 */
for (const spec of RULE_FILES) {
  const path = join(root, 'mind', spec.dir, spec.file);
  const text = await readTextOrNull(path);
  if (text === null) {
    failures.push(`出厂规则件缺失：${spec.dir}/${spec.file}`);
    continue;
  }
  const doc = parseDocument(text, { defaultAuthority: spec.authority });
  try {
    assertStructure('规则', doc);
  } catch (error) {
    failures.push(`规则件结构不合规 ${spec.file}：${error.message}`);
  }
  if (doc.errors.length) failures.push(`规则件元数据无法解析 ${spec.file}：${doc.errors.join('；')}`);
}

const 能力目录 = join(root, 'mind', '集体L2-共享基础设施', '能力库');
const 能力ids = new Set();
for (const rel of await listFiles(能力目录, { recursive: false, filter: (n) => n.endsWith('.md') })) {
  const text = await readTextOrNull(join(能力目录, rel));
  const doc = parseDocument(text ?? '');
  try {
    assertStructure('能力', doc);
  } catch (error) {
    failures.push(`能力卡结构不合规 ${rel}：${error.message}`);
  }
  if (doc.meta.id) 能力ids.add(String(doc.meta.id));
}

for (const file of ROLE_CARD_FILES) {
  const text = await readTextOrNull(join(root, 'mind', '集体L3-成员角色卡', file));
  if (text === null) {
    failures.push(`岗位卡缺失：${file}`);
    continue;
  }
  const doc = parseDocument(text);
  try {
    assertStructure('身份', doc);
  } catch (error) {
    failures.push(`岗位卡结构不合规 ${file}：${error.message}`);
  }
  // 单源：卡里只能出现引用，且引用必须命中能力库。
  for (const line of String(doc.body).split('\n')) {
    const m = /^\s*[-*]\s+([a-z0-9][a-z0-9-]{2,})\s*$/.exec(line);
    if (!m) continue;
    if (file === '_模板.md') continue;
    if (!能力ids.has(m[1])) failures.push(`岗位卡 ${file} 引用了不存在的能力：${m[1]}`);
  }
}

// 交付形状是「一张卡 + 三行，单包自洽」。这里守四条只靠运行时会很晚才暴露的边界：
//  ① 清单里每个被引用的路径都必须在 exports 里，且真的在磁盘上
//     （漏一个 ⇒ 宿主按子路径加载被 ESM 拒收 ⇒ 后端启动即崩）；
//  ② 补丁插的行必须是本包子路径（<包名>/<sub>）且经 exports 解析到 components/ 下的真实文件
//     —— 单包自洽的关键：用户只装一个包，三行全部可达（四包 link: 形态已废）；
//  ③ bundle 包自己不插行（插了列表里就会多出一张卡，组件又退回成插件）；
//  ④ 浏览器半区挂在根包上（dsh.client + exports ./client），组件包一个都不许有。
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const exported = new Set(Object.values(manifest.exports ?? {}));
for (const rel of [manifest.main, manifest.icon, manifest.dsh?.bundle?.patch].filter(Boolean)) {
  const normalized = rel.startsWith('./') ? rel : `./${rel}`;
  if (!exported.has(normalized)) failures.push(`${normalized} 被 package.json 引用但不在 exports 里 —— 宿主按子路径加载会直接拒收。`);
  if ((await readTextOrNull(join(root, rel))) === null) failures.push(`${normalized} 不存在。`);
}
if (manifest.private === true) failures.push('package.json 仍是 private —— npm 发不出去，市场装不到。');
if (Object.keys(manifest.dependencies ?? {}).length > 0) failures.push('bundle 包不该有 dependencies —— 组件已在包内，残留依赖会让安装器去解析不存在的包。');
// 浏览器半区挂在根包上：宿主按 `<包名>/client` 取浏览器包。
if (manifest.dsh?.client?.platform !== 'web') failures.push('根包缺 dsh.client(platform:web) —— 浏览器半区不会被发现。');
if (manifest.exports?.['./client'] === undefined) failures.push('根包 exports 缺 ./client —— 宿主按 <包名>/client 解析浏览器半区会拒收。');
// exports 每一项都必须落在磁盘上。
for (const [key, value] of Object.entries(manifest.exports ?? {})) {
  if (typeof value !== 'string' || !value.startsWith('./')) continue;
  if ((await readTextOrNull(join(root, value))) === null) failures.push(`exports["${key}"] 指向不存在的文件：${value}`);
}

/** 极简补丁解析：只认 `- id:` 与紧随的 `name:`。 */
const 补丁行 = [...String(await readTextOrNull(join(root, 'cordis.patch.yml')) ?? '').matchAll(/^\s*-\s+id:\s*(\S+)\s*$[\s\S]*?^\s+name:\s*(\S+)\s*$/gm)]
  .map((m) => ({ id: m[1], name: m[2].replace(/^['"]|['"]$/g, '') }));
if (补丁行.length === 0) failures.push('cordis.patch.yml 没有插入任何组件行。');
if (补丁行.some((row) => row.id === manifest.name)) failures.push('bundle 包给自己插了行 —— 列表里会多出一张卡，组件就退回成插件了。');
for (const row of 补丁行) {
  if (!row.name.startsWith(`${manifest.name}/`)) {
    failures.push(`行 ${row.id} 的 name '${row.name}' 不是本包子路径（应为 ${manifest.name}/<sub>）。`);
    continue;
  }
  const sub = row.name.slice(manifest.name.length + 1);
  const target = manifest.exports?.[`./${sub}`];
  if (typeof target !== 'string') {
    failures.push(`行 ${row.id} 的 name '${row.name}' 不在根包 exports 里 —— 装载时 import 会拒收。`);
    continue;
  }
  if ((await readTextOrNull(join(root, target))) === null) failures.push(`行 ${row.id} 解析到不存在的文件：${target}。`);
  if (!target.startsWith('./components/')) failures.push(`行 ${row.id} 解析到 ${target} —— 组件行必须落进 components/。`);
}
notes.push(`补丁插 ${补丁行.length} 行：${补丁行.map((r) => r.id).join(' / ')}。`);

// 每个组件目录：根包 exports 的 ./<dir> 指向它的 lib/index.js、被补丁行引用，
// 清单承诺的路径存在且被 exports 覆盖、浏览器半区是经典脚本。
const 组件目录 = ['kernel', 'guard', 'board'];
for (const dir of 组件目录) {
  const 包目录 = join(root, 'components', dir);
  let 包清单;
  try {
    包清单 = JSON.parse(await readFile(join(包目录, 'package.json'), 'utf8'));
  } catch (error) {
    failures.push(`components/${dir}/package.json 无法解析：${error.message}`);
    continue;
  }
  const 期望入口 = `./components/${dir}/lib/index.js`;
  if (manifest.exports?.[`./${dir}`] !== 期望入口) {
    failures.push(`根包 exports["./${dir}"] 应为 ${期望入口}，实际 ${manifest.exports?.[`./${dir}`]}。`);
  }
  if (!补丁行.some((row) => row.name === `${manifest.name}/${dir}`)) {
    failures.push(`components/${dir} 没有被任何补丁行引用 —— 它不会被装载。`);
  }
  const 导出 = new Set(Object.values(包清单.exports ?? {}));
  for (const rel of [包清单.main].filter(Boolean)) {
    const normalized = rel.startsWith('./') ? rel : `./${rel}`;
    if (!导出.has(normalized)) failures.push(`${包清单.name}：${normalized} 被引用但不在 exports 里。`);
  }
  if (包清单.dsh?.client) failures.push(`${包清单.name} 不该有 dsh.client —— 浏览器半区挂在根包上。`);
  for (const rel of await listFiles(join(包目录, 'lib'), { recursive: true, filter: (n) => n.endsWith('.js') })) {
    const text = await readTextOrNull(join(包目录, 'lib', rel));
    if (text && /from\s+['"]@deepseek-ai\//.test(text)) {
      failures.push(`${包清单.name}：lib/${rel} 引用了出厂包 —— profile 安装的插件不保证能解析它。`);
    }
    if (rel === 'client.js') {
      const 源码 = text ?? '';
      if (/^\s*(import|export)\s/m.test(源码)) failures.push(`${包清单.name}：lib/client.js 含顶层 import/export，会让整站 web 启动失败。`);
      else if (!源码.includes('window.__ModuleLoader__.load')) failures.push(`${包清单.name}：lib/client.js 没有走 window.__ModuleLoader__.load。`);
      // 宿主是按**被安装包的包名**去模块表里取这个 factory 的（单包化后 = 根包名）。
      // id 写错不是「本插件不显示」，而是整站 web 启动失败 —— 这条曾经真的把宿主带崩过。
      const loaderId = /__ModuleLoader__\.load\(\s*\{[^}]*?id:\s*'([^']+)'/s.exec(源码)?.[1];
      if (loaderId !== manifest.name) {
        failures.push(`${包清单.name}：lib/client.js 的 loader id 是 '${loaderId ?? '(缺失)'}'，必须等于根包名 '${manifest.name}'。`);
      }
      const 插件体名 = /return\s*\{\s*name:\s*'([^']+)'/.exec(源码)?.[1];
      if (插件体名 !== manifest.name) {
        failures.push(`${包清单.name}：lib/client.js 的插件体 name 是 '${插件体名 ?? '(缺失)'}'，必须等于根包名。`);
      }
      continue;
    }
    try {
      await import(new URL(`../components/${dir}/lib/${rel}`, import.meta.url).href);
    } catch (error) {
      failures.push(`${包清单.name}：lib/${rel} 无法加载：${error.message}`);
    }
  }
}
notes.push(`组件 ${组件目录.length} 个（单包自洽），入口与清单一致。`);

// 全部内核模块必须可加载（语法错误在这里就要暴露，而不是等宿主重启）。
const modules = await listFiles(join(root, 'src'), { recursive: true, filter: (n) => n.endsWith('.js') });
for (const rel of modules) {
  try {
    await import(new URL(`../src/${rel}`, import.meta.url).href);
  } catch (error) {
    failures.push(`模块无法加载 src/${rel}：${error.message}`);
  }
}
notes.push(`内核模块 ${modules.length} 个全部可加载；出厂能力卡 ${能力ids.size} 张。`);
// 出厂件洁净：不许出现用户特定信息（与「出厂件洁净」探针同一判据）。
const 出厂文件 = await listFiles(join(root, 'mind'), { recursive: true, filter: (n) => /\.(md|json|ya?ml)$/.test(n) });
for (const rel of 出厂文件) {
  const text = await readTextOrNull(join(root, 'mind', rel));
  if (text === null) continue;
  if (/[A-Za-z]:\\Users\\/.test(text) || /\/Users\/[A-Za-z0-9._-]+\//.test(text)) {
    failures.push(`出厂件含绝对用户路径：mind/${rel}`);
  }
  if (/\bsk-[A-Za-z0-9]{16,}\b/.test(text)) failures.push(`出厂件含疑似密钥：mind/${rel}`);
}

if (failures.length) {
  console.error(`✖ preflight 失败 ${failures.length} 项：`);
  for (const item of failures) console.error(`  - ${item}`);
  process.exit(1);
}
console.log(`✔ preflight 通过：${notes.join(' ')}`);