/**
 * BOM 容错读（派活闭环第四批 · 2026-10-15 主权者裁决「读不懂的姿势错了，改程序」）。
 *
 * 事故：PowerShell `Out-File -Encoding utf8` / 编辑器自动保存 把 UTF-8 BOM（U+FEFF）
 * 写进 部署.json ⇒ `JSON.parse` 抛错 ⇒ 引擎不健康 ⇒ §12.1 fail-closed 拒绝全部工具
 * 调用（含修复者自己的手）——一天内两次，第二次是主权者故意加回的「活红色测试」。
 *
 * 裁决：BOM 是**编码层的字节序标记，不是内容**。读取器把它当内容错误 = 读法错了。
 * 修法：`stripBom` 单源（fsx.js），所有从盘读 JSON 的位置统一先剥再解析。
 * **fail-closed 不弱化**：真坏的 JSON（非 BOM）照样响亮抛/引擎不健康——归一化编码装饰
 * 与静默吞坏配置是两回事，后者仍然被禁止。
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeFixture, LEAD } from './helpers.mjs';
import { Org } from '../src/org.js';
import { readJsonOrNull, readJsonl, stripBom } from '../src/kernel/fsx.js';
import { writeUnder } from './helpers.mjs';

const P = 'proj-bom';

describe('BOM 容错读', () => {
  let f;
  after(async () => { if (f) await f.cleanup(); });

  it('stripBom：剥首字符 U+FEFF，其余一字不动；无 BOM 原样返回', () => {
    assert.equal(stripBom('\uFEFF{}'), '{}');
    assert.equal(stripBom('{}'), '{}');
    assert.equal(stripBom(''), '');
    assert.equal(stripBom('\uFEFF'), '');
  });

  it('带 BOM 的 部署.json：引擎健康且键生效（回归钉 2026-10-15 事故）', async () => {
    f = await makeFixture({
      privateFiles: { '集体L2-共享基础设施/defaults/部署.json': '\uFEFF{"岗位闲置天数": 5}' },
    });
    assert.equal(f.policy.healthy, true, 'BOM 不该把引擎打趴');
    assert.equal(f.policy.state.defaults.岗位闲置天数, 5, 'BOM 后面的键要生效');
  });

  it('带 BOM 的 身份档案：成员照常可读、组织照常开门', async () => {
    const g = await makeFixture({
      privateFiles: { '身份档案/identity.json': '\uFEFF{"members":{"member-a":{"id":"member-a","岗位":"插件工程","代":1,"status":"在岗"}},"sovereign":{"lastInteraction":"2026-10-15T00:00:00Z"},"denylist":[]}' },
    });
    try {
      const org = await Org.open({ home: g.home, factoryRoot: g.factoryRoot, privateRoot: g.privateRoot, project: P });
      const identity = await org.registry.identity();
      assert.equal(identity.members['member-a']?.岗位, '插件工程', 'BOM 不该吞掉成员名单');
    } finally {
      await g.cleanup();
    }
  });

  it('带 BOM 首行的 jsonl：readJsonl 照常出全部行', async () => {
    const g = await makeFixture();
    try {
      await writeUnder(g.privateRoot, 'tmp-bom.jsonl', '\uFEFF{"a":1}\n{"a":2}\n');
      // 修前：BOM 首行被当坏行静默跳过 ⇒ 只剩 [{a:2}]——比打趴引擎更阴的数据丢失形态。
      assert.deepEqual((await readJsonl(join(g.privateRoot, 'tmp-bom.jsonl'))).map((r) => r.a), [1, 2]);
    } finally {
      await g.cleanup();
    }
  });

  it('fail-closed 不弱化：真坏的 JSON（非 BOM）照样响亮拒', async () => {
    const g = await makeFixture({
      privateFiles: { '集体L2-共享基础设施/defaults/部署.json': '{"岗位闲置天数": ' },
    });
    try {
      assert.equal(g.policy.healthy, false, '截断的 JSON 仍然要打趴引擎（BOM 容错 ≠ 坏配置容错）');
      const bad = join(g.privateRoot, '坏.json');
      await writeUnder(g.privateRoot, '坏.json', '{"x": ');
      await assert.rejects(() => readJsonOrNull(bad), (e) => /JSON 解析失败/.test(e.message));
    } finally {
      await g.cleanup();
    }
  });
});
