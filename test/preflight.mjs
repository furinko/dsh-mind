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

// 交付形状是「一张卡 + 三行」。这里守四条只靠运行时会很晚才暴露的边界：
//  ① 清单里每个被引用的路径都必须在 exports 里，且真的在磁盘上
//     （漏一个 ⇒ 宿主按子路径加载被 ESM 拒收 ⇒ 后端启动即崩）；
//  ② 补丁插的行必须指向 components/ 下真实存在的包，且行名 == 包名；
//  ③ bundle 包自己不插行（插了列表里就会多出一张卡，组件又退回成插件）；
//  ④ 浏览器半区必须挂在看板包上（挂错包，那一行的开关就管不到它）。
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const exported = new Set(Object.values(manifest.exports ?? {}));
for (const rel of [manifest.main, manifest.icon, manifest.dsh?.bundle?.patch].filter(Boolean)) {
  const normalized = rel.startsWith('./') ? rel : `./${rel}`;
  if (!exported.has(normalized)) failures.push(`${normalized} 被 package.json 引用但不在 exports 里 —— 宿主按子路径加载会直接拒收。`);
  if ((await readTextOrNull(join(root, rel))) === null) failures.push(`${normalized} 不存在。`);
}
if (manifest.dsh?.client) failures.push('bundle 包不该有 dsh.client：浏览器半区属于看板组件。');
// exports 每一项都必须落在磁盘上：浏览器半区独立成组件后，根包曾留着指向
// 不存在文件的 `./client` 导出——引用面（上面的循环）查不到它，因为没人引用它。
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
  if (!(manifest.dependencies ?? {})[row.name]) {
    failures.push(`行 ${row.id} 的包 ${row.name} 不在 bundle 的 dependencies 里 —— profile 解析不到它。`);
  }
}
notes.push(`补丁插 ${补丁行.length} 行：${补丁行.map((r) => r.id).join(' / ')}。`);

// 每个组件包：名字与行一致、清单承诺的路径存在且被 exports 覆盖、浏览器半区是经典脚本。
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
  if (!补丁行.some((row) => row.name === 包清单.name)) {
    failures.push(`components/${dir} 的包名 ${包清单.name} 没有被任何补丁行引用 —— 它不会被装载。`);
  }
  const 导出 = new Set(Object.values(包清单.exports ?? {}));
  for (const rel of [包清单.main, ...(包清单.dsh?.client ? ['./lib/client.js'] : [])].filter(Boolean)) {
    const normalized = rel.startsWith('./') ? rel : `./${rel}`;
    if (!导出.has(normalized)) failures.push(`${包清单.name}：${normalized} 被引用但不在 exports 里。`);
  }
  for (const rel of await listFiles(join(包目录, 'lib'), { recursive: true, filter: (n) => n.endsWith('.js') })) {
    const text = await readTextOrNull(join(包目录, 'lib', rel));
    if (text && /from\s+['"]@deepseek-ai\//.test(text)) {
      failures.push(`${包清单.name}：lib/${rel} 引用了出厂包 —— profile 安装的插件不保证能解析它。`);
    }
    if (rel === 'client.js') {
      const 源码 = text ?? '';
      if (/^\s*(import|export)\s/m.test(源码)) failures.push(`${包清单.name}：lib/client.js 含顶层 import/export，会让整站 web 启动失败。`);
      else if (!源码.includes('window.__ModuleLoader__.load')) failures.push(`${包清单.name}：lib/client.js 没有走 window.__ModuleLoader__.load。`);
      // 宿主是按**包名**去模块表里取这个 factory 的。id 写错不是「本插件不显示」，
      // 而是整站 web 启动失败 —— 这条曾经真的把宿主带崩过，所以在这里钉死。
      const loaderId = /__ModuleLoader__\.load\(\s*\{[^}]*?id:\s*'([^']+)'/s.exec(源码)?.[1];
      if (loaderId !== 包清单.name) {
        failures.push(`${包清单.name}：lib/client.js 的 loader id 是 '${loaderId ?? '(缺失)'}'，必须等于包名 '${包清单.name}'。`);
      }
      const 插件体名 = /return\s*\{\s*name:\s*'([^']+)'/.exec(源码)?.[1];
      if (插件体名 !== 包清单.name) {
        failures.push(`${包清单.name}：lib/client.js 的插件体 name 是 '${插件体名 ?? '(缺失)'}'，必须等于包名。`);
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
// 浏览器半区只允许出现在看板包里。
for (const dir of 组件目录) {
  const 包清单 = JSON.parse(await readFile(join(root, 'components', dir, 'package.json'), 'utf8'));
  if (dir !== 'board' && 包清单.dsh?.client) failures.push(`${包清单.name} 不该有 dsh.client：浏览器半区属于看板组件。`);
}
notes.push(`组件包 ${组件目录.length} 个，各自的清单与 exports 一致。`);

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