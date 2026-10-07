// ═══════════════════════════════════════════════════════════════════════════════
// dsh-mind · 浏览器半边的 node:test 包装
// ═══════════════════════════════════════════════════════════════════════════════
//
// 四条：
//   1. 跑 `client-harness.mjs` 的全套行为断言（工厂加载 / 两处席位注册 / 渲染 / 降级）；
//   2. 用正则盯住 `lib/client.js` —— **顶层不得出现 import / export**。
//      宿主按经典脚本加载它，顶层模块语句会抛 SyntaxError，代价是**整站 web 启动失败**，
//      不只是这一个面板不显示。这条测试守的就是这个代价；
//   3. 不得引用任何 `@deepseek-ai/*` 宿主内部包（它们抛错 = 席位条目空白）；
//   4. `package.json` 的 exports 必须覆盖 `cordis.patch.yml` 与 `dsh.client` 里点到的
//      每一个路径，并且每个导出都真的落在磁盘上——漏一个就是后端启动即崩。

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { CLIENT_PATH, runHarness } from './client-harness.mjs';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_PATH = join(PACKAGE_ROOT, 'package.json');

const source = readFileSync(CLIENT_PATH, 'utf8');
const pkg = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8'));

test('client-harness：工厂加载、main + sidebar.panellist 注册、非平凡渲染、六条降级路径', async () => {
  const report = await runHarness();
  assert.ok(report.passed.length >= 70,
    '断言条数应 ≥ 70，实际 ' + report.passed.length);
  assert.ok(report.liveElements > 100,
    '活数据页面的元素数应 > 100，实际 ' + report.liveElements);
  assert.ok(report.liveTexts > 80,
    '活数据页面的文本节点数应 > 80，实际 ' + report.liveTexts);
});

test('lib/client.js 顶层没有 import / export（经典脚本，否则整站 web 启动失败）', () => {
  const lines = source.split(/\r?\n/);
  const offenders = [];
  lines.forEach((raw, index) => {
    // 顶层语句在第 0 列；缩进过的同名词只可能是注释/字符串里的普通文本。
    if (/^(?:import|export)\b/.test(raw)) offenders.push((index + 1) + ': ' + raw.trim().slice(0, 80));
  });
  assert.deepEqual(offenders, [], '发现的顶层模块语句：\n' + offenders.join('\n'));

  assert.ok(!/^\s*(?:export\s+default|export\s*\{)/m.test(source), '不得出现 export default / export {');
  assert.match(source, /window\.__ModuleLoader__\.load\(/, '必须走 window.__ModuleLoader__.load');
  assert.match(source, /id:\s*'dsh-mind-board'/, "loader 的 id 必须是包名 'dsh-mind-board'");
  assert.match(source, /factory:\s*function\s*\(\s*require\s*\)/, 'factory 必须接收 require');
  assert.match(source, /return\s*\{\s*name:\s*'dsh-mind-board'/, 'factory 必须 return 插件体');
});

test('lib/client.js 不依赖宿主内部包，只用带兜底值的 --dsw-* 令牌', () => {
  assert.ok(!/require\(\s*['"]@deepseek-ai\//.test(source),
    '不得 require 任何 @deepseek-ai/* 包：抛错会让席位条目直接空白');
  assert.ok(!/\bfrom\s+['"]@deepseek-ai\//.test(source), '不得从 @deepseek-ai/* 导入');

  // 令牌纪律：出现过的 var(--dsw-…) 必须带兜底值，否则令牌缺失时会掉成非法颜色。
  const bare = source.match(/var\(--dsw-[a-z0-9-]+\)/g) || [];
  assert.ok(bare.length === 0,
    '每个主题令牌都要带兜底值（var(--token, #fallback)）：\n' + bare.join('\n'));
  assert.ok(/var\(--dsw-alias-/.test(source), '页面配色必须走 --dsw-alias-* 令牌');
});

test('两处席位：面板进 main（key dsh-mind），图标进 sidebar.panellist 且排在插件入口下面', () => {
  // 注册走本地的 `登记(name, 注册)` 包装（它把每次注册都包在 try/catch 里，
  // 界面组件不该有能力把整站 web 启动搞崩），所以断言打在这个包装上。
  assert.ok(/登记\('main', function \(\) \{/.test(source), '必须注册 main 席位（面板本体）');
  assert.ok(/登记\('sidebar\.panellist', function \(\) \{/.test(source), '必须注册 sidebar.panellist 席位（侧边栏入口）');
  assert.ok(/name: 'main',\s*\n\s*key: PANEL_KEY/.test(source), 'main 席位必须带 key');
  assert.ok(/name: 'sidebar\.panellist',\s*\n\s*id: PANEL_KEY/.test(source), '入口席位必须带 id');
  assert.ok(/order: 10/.test(source), '入口 order 必须是 10 —— 插件入口是 0，这样才排在它下面');
  assert.ok(/function 登记\(name, 注册\) \{[\s\S]{0,400}?try \{/.test(source),
    '两处注册必须各自包在 try/catch 里：注册失败只能让看板不可见，不能拖垮 web 启动');
  // 断言打在**注册调用**上，而不是「文件里出现过这个词」——
  // 后者会被解释这段历史的注释误伤。
  assert.ok(!/name:\s*'settings\.section'/.test(source), '不得再注册 settings.section');
  assert.ok(!/name:\s*'sidebar\.footer\.action'/.test(source), '不得再占用侧边栏页脚席位');
  assert.ok(/'\/mind dashboard'/.test(source), '宿主命令必须是 /mind dashboard');
});

test('八件与环路已从源码里删除（不是注释掉）：渲染、常量、样式一个不留', () => {
  // 这两块被判为无用且无设计依据：八件的计数是系统元数据（不是当前状态），
  // 环路是流程定义（画成常驻 stepper 永远停在某一格）。源码里留一个字符都算没删干净。
  const gone = [
    '八件', '环路', 'dshmind-eight', 'dshmind-piece', 'dshmind-metric', 'dshmind-guarantee',
    'dshmind-stepper', 'dshmind-stage', 'dshmind-lamps', 'dshmind-lamp', 'dshmind-bulb',
    'dshmind-pending', 'dshmind-diff', 'dshmind-metricKey',
    'EIGHT', 'STAGES', 'STAGE_OF', 'metricOf', 'pathGet', 'probeLamps', 'probeState',
    '策略状态', '探针灯', '升级挂起', '消息线程', '全部任务',
  ];
  for (const dead of gone) {
    assert.ok(!source.includes(dead), '已作废的「' + dead + '」不得留在 lib/client.js 里（包括注释与 CSS）');
  }
  // 「成员」这个词本身还活着（会审的盲标与独立答案里各有一处），死掉的是
  // **视图模型里的顶栏成员清单**与页脚那一行读数。
  assert.ok(!/['"]成员['"]\s*:/.test(source), '视图模型不得再取顶层「成员」清单');
  assert.ok(!/view\.成员/.test(source), '页脚不得再读 view.成员');
  assert.ok(!/view\.待决项/.test(source), '页脚不得再读 view.待决项（已换成待你决定）');
});

test('包清单点到的每条路径都在 exports 里，且都落在磁盘上', () => {
  // 组件包自己没有补丁：它那一行写在 bundle 的补丁里。
  // 所以这里只看本包清单承诺的东西——`main` 与 `dsh.client` 的浏览器半区。
  const referenced = new Set();
  if (typeof pkg.main === 'string') referenced.add('./' + pkg.main.replace(/^\.\//, ''));
  const client = (pkg.dsh && pkg.dsh.client) || {};
  assert.equal(client.platform, 'web', '看板组件必须声明 platform: web');
  assert.equal(typeof client.immediately, 'boolean');
  for (const value of Object.values(client)) {
    if (typeof value === 'string' && value.startsWith('./')) referenced.add(value);
  }
  // 浏览器半边由 dsh.client 段发现，宿主按 `<包名>/client` 解析，所以这条必须在。
  referenced.add('./lib/client.js');

  const exported = new Set(Object.values(pkg.exports || {}));
  for (const path of referenced) {
    assert.ok(exported.has(path), 'exports 缺 ' + path + ' ⇒ 宿主 ESM 加载器会拒收，后端启动即崩');
  }
  assert.equal(pkg.exports['.'], './lib/index.js');
  assert.equal(pkg.exports['./client'], './lib/client.js');

  for (const [key, value] of Object.entries(pkg.exports)) {
    assert.ok(value.startsWith('./'), key + ' 的导出路径必须是相对路径');
    assert.ok(existsSync(join(PACKAGE_ROOT, value.slice(2))), key + ' 指向的文件不存在：' + value);
  }
});
