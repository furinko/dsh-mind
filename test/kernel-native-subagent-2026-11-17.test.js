/**
 * 宿主原生子会话（DSH 自带 subagent）的工具闸回归 —— 2026-11-17。
 *
 * 病灶：内核的「复核员工具闸」对所有子会话先判「未登记 ⇒ 全拒」，于是没有
 * member_spawn 登记的宿主原生子会话连 read/glob 和 send_message 都被拦，
 * 而拒绝文案却写着「请交回 Lead 诊断」——报告通道也被同一行拒掉。
 *
 * 本文件钉住修复后的边界：
 *  - 父会话是在岗 Lead 的原生子会话：只读闭名单放行，私有区原始账本仍拒；
 *  - 写工具 / 非只读工具仍拒；
 *  - 父会话不是 Lead（成员起的子会话）：仍按成员规则拒（不借原生关系扩权）；
 *  - 已登记成员不受影响（由 member-tool-files 那组用例覆盖）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeFixture } from './helpers.mjs';
import { fakeHost } from './host-harness.mjs';
import * as plugin from '../components/kernel/lib/index.js';

const 项目键 = 'native-proj';

function 子会话exec(工具, 参数, { 父 = 'lead', cwd, id = 'native-child' } = {}) {
  return {
    name: 工具,
    arguments: 参数,
    agent: { session: { id, header: { origin: 'subagent', parentSession: 父, cwd } } },
  };
}

function 闸(host, exec) {
  for (const guard of host.闸) {
    const 结果 = guard(exec);
    assert.ok(!(结果 instanceof Promise), 'guard 不得返回 Promise（同步契约）');
    assert.ok(结果 === undefined || typeof 结果 === 'string', `guard 必须同步返回 string/undefined，实际：${String(结果)}`);
    if (结果 !== undefined) return 结果;
  }
  return undefined;
}

async function 起现场() {
  const f = await makeFixture();
  const 项目目录 = join(f.home, 项目键);
  await mkdir(join(项目目录, 'src'), { recursive: true });
  await writeFile(join(项目目录, 'src', 'a.js'), 'export const a = 1;\n', 'utf8');
  const host = fakeHost();
  await plugin.apply(host.ctx, { home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, projectBindings: [{ path: 项目目录, project: 项目键 }] });
  return { f, host, 项目目录 };
}

describe('宿主原生子会话工具闸', () => {
  it('在岗 Lead 起的原生子会话：读项目普通文件放行，私有区账本仍拒', async () => {
    const { f, host, 项目目录 } = await 起现场();
    try {
      assert.equal(闸(host, 子会话exec('read', { file_path: join(项目目录, 'src', 'a.js') }, { cwd: 项目目录 })), undefined);
      const 私有 = 闸(host, 子会话exec('read', { file_path: f.layout.identityFile() }, { cwd: 项目目录 }));
      assert.match(私有 ?? '', /私有区原始账本禁止直读/);
    } finally { await f.cleanup(); }
  });

  it('原生子会话不能借只读放行拿到写/执行与 mind 入口', async () => {
    const { f, host, 项目目录 } = await 起现场();
    try {
      for (const 工具 of ['write', 'edit', 'pwsh', 'mind']) {
        const 拒 = 闸(host, 子会话exec(工具, { file_path: join(项目目录, 'x.txt'), command: 'echo x' }, { cwd: 项目目录 }));
        assert.match(拒 ?? '', /宿主原生子会话只读/, `${工具} 应被只读闭名单拒绝`);
      }
    } finally { await f.cleanup(); }
  });

  it('父会话不是 Lead（成员起的子会话）时不借原生关系扩权', async () => {
    const { f, host, 项目目录 } = await 起现场();
    try {
      const 拒 = 闸(host, 子会话exec('read', { file_path: join(项目目录, 'src', 'a.js') }, { 父: 'member-a', cwd: 项目目录 }));
      assert.ok(typeof 拒 === 'string' && 拒.length > 0, '成员起的未登记子会话仍应拒绝');
    } finally { await f.cleanup(); }
  });
});
