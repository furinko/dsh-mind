import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { savePrivateBufferState } from '../src/turn-buffer.js';
import { Org } from '../src/org.js';
import { createTurnBufferHooks } from '../components/kernel/lib/turn-buffer-hooks.js';
import { makeFixture, LEAD } from './helpers.mjs';

it('Windows真实共享锁：原子替换失败保留旧文件，释放后可恢复', { skip: process.platform !== 'win32', timeout: 30000 }, async (t) => {
  const root = resolve(await mkdtemp(join(tmpdir(), 'mind-rename-share-')));
  const file = join(root, 'synthetic.json');
  let child;
  try {
    await writeFile(file, '{"old":true}\n');
    const script = '$f=[System.IO.File]::Open($env:MIND_TEST_FILE,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::ReadWrite); [Console]::WriteLine("ready"); [Console]::In.ReadLine() | Out-Null; $f.Dispose()';
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, MIND_TEST_FILE: file }, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true,
    });
    const lines = createInterface({ input: child.stdout });
    const [line] = await once(lines, 'line');
    assert.equal(line, 'ready');
    let observed;
    try { await savePrivateBufferState(file, { fresh: true }); }
    catch (error) { observed = error; }
    assert.ok(observed, 'held share without delete must reject replacement');
    t.diagnostic(`isolated Windows rename code: ${observed.code}`);
    assert.ok(['EPERM', 'EACCES', 'EBUSY'].includes(observed.code), `unexpected Windows error ${observed.code}`);
    assert.equal(await readFile(file, 'utf8'), '{"old":true}\n');
    assert.deepEqual((await readdir(root)).sort(), ['synthetic.json']);
    const exited = once(child, 'exit'); child.stdin.end('\n'); await exited; child = null;
    await savePrivateBufferState(file, { fresh: true });
    assert.equal(await readFile(file, 'utf8'), '{"fresh":true}\n');
  } finally {
    if (child) { child.stdin.end('\n'); child.kill(); }
    assert.ok(root.startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')));
    await rm(root, { recursive: true, force: true });
  }
});

it('Windows短暂共享锁释放后，实际轮缓冲检查点自动补写且不丢消息', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const f = await makeFixture(); const project = 'buffer-sharing-retry';
  const org = await Org.open({ ...f, project }); const events = [];
  const session = { id: LEAD.id, header: { id: LEAD.id, cwd: process.cwd() }, inheritedEventCount: 0,
    get seq() { return events.length; }, isOwnSeq: seq => seq >= 0 && seq < events.length };
  const hooks = createTurnBufferHooks({ org, projectOf: () => project, queryOf: () => ({
    async readEvent({ seq, after }) { return { session: session.header, inheritedEventCount: 0, events: events.slice(seq, seq + after + 1) }; },
  }), logger: { warn() {} } });
  const append = (type, data, surfaceOp) => events.push({ seq: events.length, time: Date.now(), type, data, ...(surfaceOp ? { surfaceOp } : {}) });
  let child; let released = false; const originalCapture = org.turnBuffer.capture.bind(org.turnBuffer);
  try {
    append('turn/start', { turn: 1 });
    append('user/message', { role: 'user', id: 'first', source: { kind: 'user' }, content: [{ type: 'text', text: '合成消息一' }] }, 'append');
    await hooks.sync(session);
    const file = org.turnBuffer.file(project, session.id);
    const script = '$f=[System.IO.File]::Open($env:MIND_TEST_FILE,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::ReadWrite); [Console]::WriteLine("ready"); [Console]::In.ReadLine() | Out-Null; $f.Dispose()';
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, MIND_TEST_FILE: file }, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    const [line] = await once(createInterface({ input: child.stdout }), 'line'); assert.equal(line, 'ready');
    append('user/message', { role: 'user', id: 'second', source: { kind: 'user' }, content: [{ type: 'text', text: '合成消息二' }] }, 'append');
    const exited = once(child, 'exit');
    org.turnBuffer.capture = async (...args) => {
      try { return await originalCapture(...args); }
      catch (error) { if (error?.code === 'EPERM' && !released) { released = true; child.stdin.end('\n'); } throw error; }
    };
    await hooks.sync(session); await exited; child = null;
    const frame = await org.turnBuffer.read({ subject: LEAD, project, session: session.id });
    assert.deepEqual(frame.轮次.flatMap(r => r.消息.map(m => m.文本)), ['合成消息一', '合成消息二']);
    assert.equal(frame.未核事件数, 0); assert.equal(frame.下次事件序号, session.seq);
    assert.equal(released, true); assert.ok(hooks.health().retryRecovered >= 1);
  } finally {
    org.turnBuffer.capture = originalCapture; if (child) { child.stdin.end('\n'); child.kill(); }
    await hooks.flush(); await org.observability.flush(); await f.cleanup();
  }
});

it('Windows持续共享锁耗尽有限重试后明报失败，释放后保留旧数据并补齐', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const f = await makeFixture(); const project = 'buffer-sharing-permanent';
  const org = await Org.open({ ...f, project }); const events = [];
  const session = { id: LEAD.id, header: { id: LEAD.id, cwd: process.cwd() }, inheritedEventCount: 0,
    get seq() { return events.length; }, isOwnSeq: seq => seq >= 0 && seq < events.length };
  const hooks = createTurnBufferHooks({ org, projectOf: () => project, queryOf: () => ({
    async readEvent({ seq, after }) { return { session: session.header, inheritedEventCount: 0, events: events.slice(seq, seq + after + 1) }; },
  }), logger: { warn() {} } });
  const append = (type, data, surfaceOp) => events.push({ seq: events.length, time: Date.now(), type, data, ...(surfaceOp ? { surfaceOp } : {}) });
  let child;
  try {
    append('turn/start', { turn: 1 });
    append('user/message', { role: 'user', id: 'first', source: { kind: 'user' }, content: [{ type: 'text', text: '原消息' }] }, 'append');
    await hooks.sync(session);
    const file = org.turnBuffer.file(project, session.id);
    const script = '$f=[System.IO.File]::Open($env:MIND_TEST_FILE,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::ReadWrite); [Console]::WriteLine("ready"); [Console]::In.ReadLine() | Out-Null; $f.Dispose()';
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, MIND_TEST_FILE: file }, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    const [line] = await once(createInterface({ input: child.stdout }), 'line'); assert.equal(line, 'ready');
    append('user/message', { role: 'user', id: 'second', source: { kind: 'user' }, content: [{ type: 'text', text: '待补消息' }] }, 'append');
    await assert.rejects(hooks.sync(session), { code: 'EPERM' }); await hooks.flush();
    let frame = await org.turnBuffer.read({ subject: LEAD, project, session: session.id });
    assert.deepEqual(frame.轮次.flatMap(r => r.消息.map(m => m.文本)), ['原消息']);
    assert.equal(hooks.health().retryAttempts, 4); assert.equal(hooks.health().failedWrites, 1);
    assert.deepEqual(Object.keys(hooks.health().lastFailure).sort(), ['at', 'code', 'operation']);
    const exited = once(child, 'exit'); child.stdin.end('\n'); await exited; child = null;
    await hooks.sync(session);
    frame = await org.turnBuffer.read({ subject: LEAD, project, session: session.id });
    assert.deepEqual(frame.轮次.flatMap(r => r.消息.map(m => m.文本)), ['原消息', '待补消息']);
    assert.equal(frame.未核事件数, 0); assert.equal(frame.下次事件序号, session.seq);
  } finally {
    if (child) { child.stdin.end('\n'); child.kill(); }
    await hooks.flush(); await org.observability.flush(); await f.cleanup();
  }
});
