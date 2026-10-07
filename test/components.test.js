/**
 * 组件：bundle 卡 + 三行，以及它们之间的边界。
 *
 * 「组件」在这个部署里的定义来自插件管理页：**一张插件卡下面那几行，每行一个独立包、一个独立开关**。
 * 于是断言也围着它转：
 *  1. 补丁真的插了三行，且 `name` 指向**三个不同的包**（同一包不能靠行数冒充组件）；
 *  2. bundle 包自己不插行 —— 插了就会在列表里变成「又一个插件」；
 *  3. 内核与安全类拿到的是**同一个 Org**（各持一份会让探针检查到另一个策略引擎，等于白测）。
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

describe('组件：一张卡 + 三行', () => {
  it('bundle 补丁插三行，每行指向一个不同的包', async () => {
    const 补丁 = await readFile(join(root, 'cordis.patch.yml'), 'utf8');
    const rows = parsePatch(补丁);
    assert.equal(rows.length, 3, `应插三行，实际 ${rows.length}：${rows.map((r) => r.id).join(',')}`);
    assert.deepEqual(rows.map((r) => r.id), ['dsh-mind-kernel', 'dsh-mind-guard', 'dsh-mind-board']);
    for (const row of rows) {
      assert.ok(row.name, `行 ${row.id} 缺 name`);
      assert.notEqual(row.name, 'dsh-mind', `行 ${row.id} 不该指向 bundle 包自己 —— 那样就没有「组件」了`);
    }
    assert.equal(new Set(rows.map((r) => r.name)).size, 3, '三行必须指向三个不同的包');
  });

  it('bundle 包自己不插行，否则列表里会多出一张卡', async () => {
    const 补丁 = await readFile(join(root, 'cordis.patch.yml'), 'utf8');
    const ids = parsePatch(补丁).map((r) => r.id);
    assert.equal(ids.includes('dsh-mind'), false, 'bundle 包不该给自己插一行');
  });

  it('bundle 的三个依赖就是那三个组件包，且都是本地 link', async () => {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const deps = manifest.dependencies ?? {};
    assert.deepEqual(Object.keys(deps).sort(), ['dsh-mind-board', 'dsh-mind-guard', 'dsh-mind-kernel']);
    for (const [name, spec] of Object.entries(deps)) {
      assert.match(spec, /^link:/, `${name} 必须是 link: 依赖（组件就在本目录里）`);
    }
    const rows = parsePatch(await readFile(join(root, 'cordis.patch.yml'), 'utf8')).map((r) => r.name);
    for (const name of rows) assert.ok(deps[name], `行 ${name} 不在 bundle 的 dependencies 里 —— profile 解析不到它`);
  });

  it('三个组件包各自成包，且名字与行对得上', async () => {
    const rows = parsePatch(await readFile(join(root, 'cordis.patch.yml'), 'utf8'));
    for (const row of rows) {
      const dir = row.name === 'dsh-mind-kernel' ? 'kernel' : row.name === 'dsh-mind-guard' ? 'guard' : 'board';
      const manifest = JSON.parse(await readFile(join(root, 'components', dir, 'package.json'), 'utf8'));
      assert.equal(manifest.name, row.name, `components/${dir} 的包名应与行一致`);
      assert.equal(typeof manifest.main, 'string', `${row.name} 缺 main`);
      assert.ok(manifest.exports['.'], `${row.name} 缺 exports["."]`);
    }
  });

  it('看板的浏览器半区挂在看板包上：关掉那一行，面板与入口一起消失', async () => {
    const board = JSON.parse(await readFile(join(root, 'components', 'board', 'package.json'), 'utf8'));
    assert.ok(board.dsh?.client, '看板包必须自带 dsh.client —— 否则它的行开关管不到浏览器半区');
    assert.equal(board.dsh.client.platform, 'web');
    assert.equal(board.exports['./client'], './lib/client.js');
    const kernel = JSON.parse(await readFile(join(root, 'components', 'kernel', 'package.json'), 'utf8'));
    assert.equal(kernel.dsh?.client, undefined, '内核包不该有浏览器半区');
    const bundle = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    assert.equal(bundle.dsh?.client, undefined, 'bundle 包不该有浏览器半区');
  });

  it('共享组织：同样的部署落在同一个键上，不同的部署不共享', () => {
    assert.equal(shareKey({ home: 'H', project: 'p1' }), shareKey({ home: 'H', project: 'p1' }));
    assert.notEqual(shareKey({ home: 'H', project: 'p1' }), shareKey({ home: 'H', project: 'p2' }));
    assert.notEqual(shareKey({ home: 'H', project: 'p1' }), shareKey({ privateRoot: 'X', project: 'p1' }));
    assert.equal(sharedOrgCount(), 0);
    forgetSharedOrg();
  });
});
