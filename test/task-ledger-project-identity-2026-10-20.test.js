import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, appendFile, stat, utimes } from 'node:fs/promises';
import { symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeFixture, LEAD } from './helpers.mjs';
import { fakeHost } from './host-harness.mjs';
import { TaskGraph } from '../src/tasks.js';
import { MemoryService } from '../src/memory.js';
import { parseTaskLedger, readTaskLedger, readTaskLedgerSync } from '../src/task-ledger.js';
import { projectKeyForPath, createProjectResolver } from '../src/project-identity.js';
import * as kernel from '../components/kernel/lib/index.js';

const invalidLedger = error => error?.code === 'TASK_LEDGER_INVALID';
const row = { seq: 1, kind: 'created', id: 'task-source', 描述: '来源', 判据: ['不退回旧状态'], 负责人: ['member-a'] };

describe('任务真源损坏必须阻止所有投影与授权消费者', () => {
  it('同步与异步严格读取一致，坏 JSON、未知事件与撕裂末行均拒；BOM/CRLF 与空行兼容', async () => {
    const f = await makeFixture();
    const file = f.layout.taskLog('strict');
    try {
      assert.deepEqual(await readTaskLedger(file), []);
      assert.deepEqual(readTaskLedgerSync(file), []);
      await mkdir(dirname(file), { recursive: true });
      for (const bad of [`${JSON.stringify(row)}\n{坏行}\n`, `${JSON.stringify(row)}`, 'null\n', '{"kind":"unknown","id":"t"}\n']) {
        await writeFile(file, bad);
        await assert.rejects(() => readTaskLedger(file), invalidLedger);
        assert.throws(() => readTaskLedgerSync(file), invalidLedger);
      }
      assert.deepEqual(parseTaskLedger(`\uFEFF${JSON.stringify(row)}\r\n\r\n`), [row]);
    } finally { await f.cleanup(); }
  });

  it('派发事件损坏后 get/写/registry.sync/记忆来源校验全部拒绝，账本原字节不变', async () => {
    const f = await makeFixture();
    const tasks = new TaskGraph(f);
    const memory = new MemoryService(f);
    const project = 'corrupt';
    try {
      const node = await tasks.create({ subject: LEAD, 项目: project, 描述: '不能回退', 负责人: 'member-a', 判据: ['冻结'] });
      await tasks.dispatch(node.id, { subject: LEAD, 项目: project });
      await tasks.get(node.id, { 项目: project }); // 先热缓存，再损坏真源。
      const file = f.layout.taskLog(project);
      const lines = (await readFile(file, 'utf8')).trimEnd().split('\n');
      lines[1] = '{损坏的派发事件}';
      const broken = `${lines.join('\n')}\n`;
      await writeFile(file, broken);
      await assert.rejects(() => tasks.get(node.id, { 项目: project }), invalidLedger);
      await assert.rejects(() => tasks.create({ subject: LEAD, 项目: project, 描述: '不许继续追加', 负责人: 'member-a', 判据: ['x'] }), invalidLedger);
      await assert.rejects(() => f.registry.sync(), invalidLedger);
      await assert.rejects(() => f.audit.授权依据存在(node.id), invalidLedger);
      await assert.rejects(() => memory.remember({ subject: LEAD, 类: '经历', 内容: '必须验证来源', 来源: '实测', 项目: project, 来源引用: [node.id] }), invalidLedger);
      assert.equal(await readFile(file, 'utf8'), broken);
    } finally { await f.cleanup(); }
  });

  it('真实同步复核工具闸遇到一条坏事件就拒，不按剩余事件授予读根', async () => {
    const f = await makeFixture();
    const host = fakeHost();
    const cwd = join(f.home, 'repo');
    const file = join(cwd, 'a.js');
    try {
      await mkdir(cwd, { recursive: true }); await writeFile(file, 'x');
      const project = projectKeyForPath(cwd);
      const log = f.layout.taskLog(project);
      await mkdir(dirname(log), { recursive: true });
      await writeFile(log, `${JSON.stringify(row)}\n`);
      await kernel.apply(host.ctx, { home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot });
      await appendFile(log, '{坏行}\n');
      const exec = { name: 'read', arguments: { file_path: file }, agent: { session: { id: 'reviewer', header: { origin: 'subagent', cwd } } } };
      const denied = host.闸.map(guard => guard(exec)).find(result => result !== undefined);
      assert.equal(typeof denied, 'string');
      assert.match(denied, /任务账本|任务真源/);
    } finally { host.清理(); await f.cleanup(); }
  });

  it('同尺寸损坏并恢复mtime仍拒，调用者修改events返回值不能污染下次授权投影', async () => {
    const f = await makeFixture(), tasks = new TaskGraph(f), project = 'exact-bytes';
    try {
      const node = await tasks.create({ subject: LEAD, 项目: project, 描述: '原文缓存', 负责人: 'member-a', 判据: ['真实字节'] });
      await tasks.dispatch(node.id, { subject: LEAD, 项目: project });
      const events = await tasks.events({ 项目: project });
      events[0].负责人 = ['attacker'];
      assert.deepEqual((await tasks.get(node.id, { 项目: project })).负责人, ['member-a']);
      const file = f.layout.taskLog(project), before = await stat(file), text = await readFile(file, 'utf8');
      const broken = text.replace('"kind":"dispatched"', '"kind":"dispatched!');
      assert.equal(broken.length, text.length); assert.notEqual(broken, text);
      await writeFile(file, broken); await utimes(file, before.atime, before.mtime);
      await assert.rejects(() => tasks.get(node.id, { 项目: project }), invalidLedger);
    } finally { await f.cleanup(); }
  });
});

describe('项目路径身份与历史归属', () => {
  it('同尾名目录隔离，路径规范化/大小写/junction 别名保持同一身份', async () => {
    const f = await makeFixture();
    try {
      const a = join(f.home, 'company-a', 'repo'), b = join(f.home, 'company-b', 'repo');
      await mkdir(a, { recursive: true }); await mkdir(b, { recursive: true });
      assert.notEqual(projectKeyForPath(a), projectKeyForPath(b));
      assert.equal(projectKeyForPath(a), projectKeyForPath(join(a, '..', 'repo')));
      if (process.platform === 'win32') assert.equal(projectKeyForPath(a), projectKeyForPath(a.toUpperCase()));
      const alias = join(f.home, 'alias'); symlinkSync(a, alias, process.platform === 'win32' ? 'junction' : 'dir');
      assert.equal(projectKeyForPath(a), projectKeyForPath(alias));
    } finally { await f.cleanup(); }
  });

  it('历史 basename 未认领即拒；显式绑定能沿用历史，但另一个同名目录使用独立新键', async () => {
    const f = await makeFixture();
    try {
      const a = join(f.home, 'a', 'repo'), b = join(f.home, 'b', 'repo');
      await mkdir(a, { recursive: true }); await mkdir(b, { recursive: true });
      await mkdir(dirname(f.layout.taskLog('repo')), { recursive: true });
      await writeFile(f.layout.taskLog('repo'), `${JSON.stringify(row)}\n`);
      assert.throws(() => createProjectResolver({ layout: f.layout })(a, 'default'), e => e.code === 'PROJECT_LEGACY_UNBOUND');
      const resolver = createProjectResolver({ layout: f.layout, bindings: [{ path: a, project: 'repo' }] });
      assert.equal(resolver(a, 'default'), 'repo');
      assert.equal(resolver(b, 'default'), projectKeyForPath(b));
      assert.throws(() => createProjectResolver({ bindings: [{ path: a, project: 'repo' }, { path: b, project: 'REPO' }] }));
      assert.throws(() => createProjectResolver()('repo', 'default'));
    } finally { await f.cleanup(); }
  });

  it('真实 mind 入口为两个同名工作目录创建不同账本，成员显式 project 不能覆盖会话真源', async () => {
    const f = await makeFixture(), host = fakeHost();
    const a = join(f.home, 'a', 'repo'), b = join(f.home, 'b', 'repo');
    try {
      await mkdir(a, { recursive: true }); await mkdir(b, { recursive: true });
      await kernel.apply(host.ctx, { home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot });
      const tool = host.工具.get('mind');
      for (const cwd of [a, b]) {
        const result = JSON.parse(await tool.execute({ action: 'task_create', 描述: '同名目录', 负责人: 'member-a', 判据: ['各归各'] }, { name: 'mind', agent: { session: { id: 'lead', header: { cwd } } } }));
        assert.equal(result.成功, true, JSON.stringify(result));
        assert.equal((await readTaskLedger(f.layout.taskLog(projectKeyForPath(cwd)))).length, 1);
      }
      const result = JSON.parse(await tool.execute({ action: 'status', project: projectKeyForPath(b) }, { name: 'mind', agent: { session: { id: 'member-a', header: { origin: 'subagent', cwd: a } } } }));
      assert.equal(result.成功, false);
      assert.match(result.理由, /跨项目/);
    } finally { host.清理(); await f.cleanup(); }
  });
});
