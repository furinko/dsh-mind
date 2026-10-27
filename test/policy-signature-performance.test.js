import { it, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { setImmediate } from 'node:timers/promises';
import { stat, utimes, rm } from 'node:fs/promises';
import { makeFixture, LEAD } from './helpers.mjs';

it('授权文件独立查询同时进行，逆序完成仍产生原签名且不重载', async () => {
  const f = await makeFixture();
  const paths = [...f.policy.authSig.路径], expected = f.policy.authSig.串;
  const stats = new Map(await Promise.all(paths.map(async path => [path, await stat(path).catch(() => null)])));
  const pending = [];
  const original = fs.promises.stat;
  const replacement = mock.method(fs.promises, 'stat', function (path, ...args) {
    if (!stats.has(path)) return original.call(this, path, ...args);
    return new Promise((resolve, reject) => pending.push(() => stats.get(path)
      ? resolve(stats.get(path)) : reject(Object.assign(new Error('missing'), { code: 'ENOENT' }))));
  });
  syncBuiltinESMExports();
  let refresh;
  try {
    refresh = f.policy.refreshIfStale();
    await setImmediate();
    assert.equal(pending.length, paths.length, '不能等待前一个文件完成才查询后一个文件');
    for (const finish of pending.reverse()) finish();
    assert.deepEqual(await refresh, { changed: false, reloaded: false, ok: true });
    assert.equal(f.policy.authSig.串, expected);
  } finally {
    replacement.mock.restore(); syncBuiltinESMExports();
    for (const finish of pending) finish();
    await refresh;
    await f.cleanup();
  }
});

it('每次检查重取所有依赖，新完成的检查不能缓存下一次修改', async () => {
  const f = await makeFixture();
  try {
    for (const path of [...f.policy.authSig.路径]) {
      const info = await stat(path).catch(() => null);
      if (!info) continue;
      assert.equal((await f.policy.refreshIfStale()).changed, false);
      await utimes(path, info.atime, new Date(info.mtimeMs + 60000));
      assert.deepEqual(await f.policy.refreshIfStale(), { changed: true, reloaded: true, ok: true }, path);
      assert.equal((await f.policy.refreshIfStale()).changed, false, path);
    }
  } finally { await f.cleanup(); }
});

it('缺席依赖出现坏配置后立即拒绝，删除坏配置后重新检查恢复', async () => {
  const f = await makeFixture();
  try {
    const path = f.policy.authSig.路径.find(path => path.endsWith('部署.json'));
    assert.ok(path);
    assert.equal(await stat(path).catch(() => null), null);
    assert.equal((await f.policy.refreshIfStale()).changed, false);
    await f.writePrivate('集体L2-共享基础设施/defaults/部署.json', '{');
    const decision = await f.policy.decide({ subject: LEAD, action: 'read',
      target: { id: 'test', kind: '记忆', authority: '自治', zone: '私有', project: 'default' } });
    assert.equal(decision.verdict, 'deny');
    assert.equal(decision.alarm, true);
    await rm(path);
    assert.deepEqual(await f.policy.refreshIfStale(), { changed: true, reloaded: true, ok: true });
  } finally { await f.cleanup(); }
});
