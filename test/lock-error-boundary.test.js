import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJsonl, withLock } from '../src/kernel/fsx.js';
import { makeFixture } from './helpers.mjs';

for (const code of ['EEXIST', 'EPERM']) {
  it(`锁内业务抛 ${code} 时保留原错误，不重试已发生的副作用`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mind-lock-error-'));
    const lock = join(dir, 'operation.lock');
    const failure = Object.assign(new Error('业务已部分完成'), { code });
    let attempts = 0;
    try {
      await assert.rejects(withLock(lock, async () => {
        attempts += 1;
        if (attempts === 1) throw failure;
        return '不应隐式重放';
      }), error => error === failure);
      assert.equal(attempts, 1);
      await assert.rejects(stat(lock), { code: 'ENOENT' });
      assert.equal(await withLock(lock, async () => '下一次显式操作'), '下一次显式操作');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it(`审计已经落账后告警回调抛 ${code}，一次调用只新增一条事实`, async () => {
    const f = await makeFixture();
    const failure = Object.assign(new Error('告警通知失败'), { code });
    let attempts = 0;
    try {
      f.audit.onAlarm = () => {
        attempts += 1;
        if (attempts === 1) throw failure;
      };
      await assert.rejects(f.audit.append({
        主体: { id: 'system', kind: '系统' }, 动作: '锁异常不重放', 告警: true,
      }), error => error === failure);
      const rows = (await Promise.all((await f.audit.months()).map(month => readJsonl(f.layout.auditLog(month))))).flat();
      assert.equal(rows.filter(row => row.动作 === '锁异常不重放').length, 1);
      assert.equal(attempts, 1);
      await f.audit.append({ 主体: { id: 'system', kind: '系统' }, 动作: '后续独立操作' });
      assert.equal((await f.audit.verify()).ok, true);
    } finally {
      await f.cleanup();
    }
  });
}
