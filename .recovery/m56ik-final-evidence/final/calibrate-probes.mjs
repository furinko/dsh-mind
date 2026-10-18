import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { makeFixture, LEAD } from '../test/helpers.mjs';
import { ProbeRunner } from '../src/probes.js';
const source = new URL('../src/probes.js', import.meta.url);
const sha = async () => createHash('sha256').update(await readFile(source)).digest('hex');
const before = await sha(), results = [];
for (const name of ['审计链', '闸在位', '出厂件洁净', '撤回名单一致']) {
  const f = await makeFixture();
  try {
    const probes = new ProbeRunner({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock, 无内核装配: true });
    const green = await probes.run({ subject: LEAD, 机制版本: `calibration-${name}-before` });
    assert.equal(green.全绿, true, JSON.stringify(green.见红));
    if (name === '审计链') {
      const path = f.layout.auditLog(new Date().toISOString().slice(0, 7));
      const row = { seq: 999, 时间: '2020-01-01T00:00:00Z', 主体: { id: 'isolated-fixture', kind: '未知' }, 动作: '状态变更', 对象: { id: 'fixture', kind: '账目' }, 依据: '隔离篡改输入', 结果: '仅测试', 档位: '全记', prev: 'deadbeef', hash: 'cafebabe' };
      await writeFile(path, `${await readFile(path, 'utf8')}${JSON.stringify(row)}\n`);
    } else if (name === '闸在位') {
      probes.无内核装配 = false; // 需要真实回执却缺席 ⇒ 未知必须红，不拿健康策略对象代替注册证据。
    } else if (name === '出厂件洁净') {
      await writeFile(join(f.factoryRoot, '__isolated-sensitive-input.txt'), 'C:\\Users\\calibration-only\\fixture.txt\ncalibration@example.test\n', 'utf8');
    } else {
      const path = f.layout.identityFile(), identity = JSON.parse(await readFile(path, 'utf8'));
      identity.denylist = [{ id: 'fixture-missing-withdrawn-card' }];
      await writeFile(path, JSON.stringify(identity));
    }
    const red = await probes.run({ subject: LEAD, 机制版本: `calibration-${name}-after` });
    const result = red.结果.find(x => x.探针 === name);
    assert.equal(result.状态, '红', JSON.stringify(red.结果));
    results.push({ probe: name, before: 'green', after: 'red', detail: result.详情, isolatedHome: f.home });
  } finally { await f.cleanup(); }
}
const unchanged = before === await sha();
assert.equal(unchanged, true);
await writeFile(new URL('./probe-calibration-results.json', import.meta.url), JSON.stringify({ at: new Date().toISOString(), inputScope: 'four fresh temporary fixtures only; no live data touched', node: process.version, results, sourceSha256: before, unchanged }, null, 2));
console.log(JSON.stringify({ calibrated: results.length, unchanged, results }, null, 2));
