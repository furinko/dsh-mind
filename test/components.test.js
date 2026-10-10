/**
 * 组件：bundle 卡 + 三行，以及它们之间的边界（单包自洽形态）。
 *
 * 「组件」在这个部署里的定义来自插件管理页：**一张插件卡下面那几行，每行一个独立开关**。
 * 2026-10-11 可发布化批起，三行不再是三个独立包，而是**本包的子路径导出**
 * （`dsh-mind/kernel` 等）——用户只装 `dsh-mind` 一个包，三行全部可达；
 * 旧四包 link: 形态（官方安装器只写一行依赖 ⇒ 组件静默不装，实测在案）废除。
 * 于是断言也围着它转：
 *  1. 补丁真的插了三行，`name` 是三个**不同的子路径**且经 exports 解析到 components/；
 *  2. bundle 包自己不插行 —— 插了就会在列表里变成「又一个插件」；
 *  3. 清单可发布：无 private、无 dependencies、浏览器半区挂在根包；
 *  4. 内核与安全类拿到的是**同一个 Org**（各持一份会让探针检查到另一个策略引擎，等于白测）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forgetSharedOrg, shareKey, sharedOrgCount } from '../src/runtime.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/** 极简补丁解析：只认 `- insert:` 下面形如 `- id: … / name: …` 的行。 */
function parsePatch(text) {
  const rows = [];
  let current = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/#.*$/, '').trimEnd();
    if (!line.trim()) continue;
    const row = /^\s*-\s+id:\s*(\S+)\s*$/.exec(line);
    if (row) {
      current = { id: row[1], name: null, config: {} };
      rows.push(current);
      continue;
    }
    const name = /^\s+name:\s*(\S+)\s*$/.exec(line);
    if (name && current) {
      current.name = name[1].replace(/^['"]|['"]$/g, '');
    }
  }
  return rows;
}

describe('组件：一张卡 + 三行（单包自洽）', () => {
  it('bundle 补丁插三行，每行指向一个不同的子路径导出', async () => {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const 补丁 = await readFile(join(root, 'cordis.patch.yml'), 'utf8');
    const rows = parsePatch(补丁);
    assert.equal(rows.length, 3, `应插三行，实际 ${rows.length}：${rows.map((r) => r.id).join(',')}`);
    assert.deepEqual(rows.map((r) => r.id), ['dsh-mind-kernel', 'dsh-mind-guard', 'dsh-mind-board']);
    for (const row of rows) {
      assert.ok(row.name, `行 ${row.id} 缺 name`);
      assert.match(row.name, new RegExp(`^${manifest.name}/`), `行 ${row.id} 的 name '${row.name}' 应是本包子路径`);
      assert.notEqual(row.name, manifest.name, `行 ${row.id} 不该指向 bundle 入口自己 —— 那样就没有「组件」了`);
      const sub = row.name.slice(manifest.name.length + 1);
      assert.equal(typeof manifest.exports[`./${sub}`], 'string', `行 ${row.id} 的子路径不在 exports 里 —— 装载时 import 会拒收`);
      assert.ok(manifest.exports[`./${sub}`].startsWith('./components/'), `行 ${row.id} 应解析进 components/`);
    }
    assert.equal(new Set(rows.map((r) => r.name)).size, 3, '三行必须指向三个不同的子路径');
  });

  it('bundle 包自己不插行，否则列表里会多出一张卡', async () => {
    const 补丁 = await readFile(join(root, 'cordis.patch.yml'), 'utf8');
    const ids = parsePatch(补丁).map((r) => r.id);
    assert.equal(ids.includes('dsh-mind'), false, 'bundle 包不该给自己插一行');
  });

  it('单包可发布：无 private、无 dependencies', async () => {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    assert.notEqual(manifest.private, true, 'private 会挡掉 npm 发布 —— 市场装不到');
    assert.deepEqual(Object.keys(manifest.dependencies ?? {}), [], '组件已在包内，dependencies 残留会让安装器去解析不存在的包');
  });

  it('三个组件入口都在根包 exports 且落盘', async () => {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    for (const dir of ['kernel', 'guard', 'board']) {
      assert.equal(manifest.exports[`./${dir}`], `./components/${dir}/lib/index.js`, `exports ./${dir} 应指向 ${dir} 的宿主入口`);
    }
  });

  it('浏览器半区挂在根包上：dsh.client + exports ./client，组件包一个都不许有', async () => {
    const bundle = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    assert.equal(bundle.dsh?.client?.platform, 'web', '根包必须声明浏览器半区（platform:web）');
    assert.equal(bundle.exports['./client'], './components/board/lib/client.js');
    for (const dir of ['kernel', 'guard', 'board']) {
      const pkg = JSON.parse(await readFile(join(root, 'components', dir, 'package.json'), 'utf8'));
      assert.equal(pkg.dsh?.client, undefined, `components/${dir} 不该再有 dsh.client —— 浏览器半区已上移根包`);
      assert.equal(typeof pkg.main, 'string', `components/${dir} 缺 main`);
      assert.ok(pkg.exports['.'], `components/${dir} 缺 exports["."]`);
    }
  });

  it('共享组织：同样的部署落在同一个键上，不同的部署不共享', () => {
    assert.equal(shareKey({ home: 'H', project: 'p1' }), shareKey({ home: 'H', project: 'p1' }));
    assert.notEqual(shareKey({ home: 'H', project: 'p1' }), shareKey({ home: 'H', project: 'p2' }));
    assert.notEqual(shareKey({ home: 'H', project: 'p1' }), shareKey({ privateRoot: 'X', project: 'p1' }));
    assert.equal(sharedOrgCount(), 0);
    forgetSharedOrg();
  });
});
