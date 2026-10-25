import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicWrite } from '../src/kernel/fsx.js';

// Each test file has its own Node process. Inject only the OS rename boundary;
// all temporary-file writes, old-file reads and cleanup below use the real disk.
async function scene(platform, replace, run) {
  const dir = await mkdtemp(join(tmpdir(), 'mind-atomic-'));
  const file = join(dir, '回执.json');
  await writeFile(file, '旧版');
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const original = fs.promises.rename;
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
    fs.promises.rename = (from, to) => replace(from, to, original);
    syncBuiltinESMExports();
    await run(file, dir);
  } finally {
    fs.promises.rename = original;
    syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', descriptor);
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
  }
}

it('Windows短暂拒绝替换后提交同一临时文件，等待期间旧文件始终完整', async () => {
  const errors = ['EPERM', 'EACCES', 'EBUSY'];
  const attempts = [];
  await scene('win32', async (from, to, rename) => {
    attempts.push(from);
    assert.equal(await readFile(to, 'utf8'), '旧版');
    assert.equal(await readFile(from, 'utf8'), '新版');
    const code = errors.shift();
    if (code) throw Object.assign(new Error(code), { code });
    return rename(from, to);
  }, async (file, dir) => {
    await atomicWrite(file, '新版');
    assert.equal(await readFile(file, 'utf8'), '新版');
    assert.equal(attempts.length, 4);
    assert.equal(new Set(attempts).size, 1);
    assert.deepEqual(await readdir(dir), ['回执.json']);
  });
});

it('Windows持久权限错误有限退出，保留旧文件并清理临时文件', async () => {
  const error = Object.assign(new Error('仍被占用'), { code: 'EPERM' });
  let calls = 0;
  await scene('win32', async () => { calls++; throw error; }, async (file, dir) => {
    await assert.rejects(atomicWrite(file, '不得丢旧版'), e => e === error);
    assert.ok(calls > 1 && calls <= 8);
    assert.equal(await readFile(file, 'utf8'), '旧版');
    assert.deepEqual(await readdir(dir), ['回执.json']);
  });
});

for (const [platform, code] of [['linux', 'EPERM'], ['win32', 'ENOENT']]) {
  it(`${platform}的${code}不进入Windows占用重试`, async () => {
    const error = Object.assign(new Error(code), { code });
    let calls = 0;
    await scene(platform, async () => { calls++; throw error; }, async (file, dir) => {
      await assert.rejects(atomicWrite(file, '新版'), e => e === error);
      assert.equal(calls, 1);
      assert.equal(await readFile(file, 'utf8'), '旧版');
      assert.deepEqual(await readdir(dir), ['回执.json']);
    });
  });
}
