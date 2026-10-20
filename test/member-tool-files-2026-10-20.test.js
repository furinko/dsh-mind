import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, readFile, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeFixture, LEAD, MEMBER } from './helpers.mjs';
import { fakeHost } from './host-harness.mjs';
import { shareOrg, forgetSharedOrg, shareKey } from '../src/runtime.js';
import { apply } from '../components/kernel/lib/index.js';
import { ToolFileAuthority } from '../src/tool-file-scope.js';
import { runAction } from '../lib/actions.js';

const P = 'member-tool-files';
async function setup({ configured = true } = {}) {
  const f = await makeFixture();
  const cwd = join(f.home, 'work');
  const outside = join(f.home, 'outside');
  await mkdir(cwd); await mkdir(outside);
  const input = join(cwd, 'input.txt');
  await writeFile(input, 'trusted task input');
  const host = fakeHost();
  await apply(host.ctx, { home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P,
    projectBindings: [{ path: cwd, project: P }],
    ...(configured ? { memberFileAccess: { read: [cwd], write: [cwd] } } : {}),
    audit工具调用: false });
  const org = await shareOrg({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
  const exec = (name, args = {}, id = 'member-a', directory = cwd) => ({ name, arguments: args,
    agent: { session: { id, header: { cwd: directory, origin: 'subagent', parentSession: 'lead', delegationDepth: 1 } } } });
  const guard = (name, args, id, directory) => host.闸.map((g) => g(exec(name, args, id, directory))).find((x) => x !== undefined);
  const dispatch = async (range = { 读: [cwd], 写: [cwd] }) => {
    const n = await org.tasks.create({ subject: LEAD, 项目: P, 描述: 'file work', 负责人: ['插件工程'], 判据: ['file changed'] });
    await org.tasks.bind(n.id, { subject: LEAD, 项目: P, 实例: 'member-a', 岗位: '插件工程' });
    return org.tasks.dispatch(n.id, { subject: LEAD, 项目: P, 工具文件范围: range });
  };
  return { f, cwd, outside, input, host, org, guard, dispatch, async cleanup() { host.清理(); forgetSharedOrg(shareKey({ home: f.home, privateRoot: f.privateRoot, project: P })); await f.cleanup(); } };
}

describe('普通成员通用工具文件边界', () => {
  it('无任务时，raw 私有/出厂文件、普通文件、shell 与未知工具均拒，组织入口与父报告保留', async () => {
    const s = await setup();
    try {
      for (const file of [s.input, s.f.layout.identityFile(), s.f.layout.rulePath('宪章', '出厂')]) {
        assert.match(s.guard('read', { file_path: file }), /成员工具闸/);
        assert.match(s.guard('write', { file_path: file, content: 'x' }), /成员工具闸/);
      }
      for (const name of ['pwsh', 'bash', 'exec_command', 'unknown_future_tool']) assert.match(s.guard(name, {}), /闭名单/);
      assert.equal(s.guard('mind', { action: 'status' }), undefined);
      assert.equal(s.guard('send_message', { target: 'lead', message: '边界不可用' }), undefined);
      assert.match(s.guard('send_message', { target: 'member-b', message: 'go' }), /不是派发你的 Lead/);
      assert.equal(await readFile(s.input, 'utf8'), 'trusted task input', 'guard 只判定，测试从未执行被拦工具');
    } finally { await s.cleanup(); }
  });

  it('派发冻结显式读写根，真实绑定本人可读写新文件；同岗其他成员、越根和未知执行类拒', async () => {
    const s = await setup();
    try {
      const n = await s.dispatch();
      assert.equal(n.工具文件范围.版本, 1);
      assert.equal(n.工具文件范围.授予者, 'lead');
      assert.equal(s.guard('read', { file_path: s.input }), undefined);
      assert.equal(s.guard('read', { file_path: 'input.txt' }), undefined);
      assert.equal(s.guard('write', { file_path: join(s.cwd, 'new', 'result.txt'), content: 'x' }), undefined);
      assert.match(s.guard('read', { file_path: s.input }, 'member-b'), /本人真实绑定/);
      assert.match(s.guard('write', { file_path: join(s.outside, 'result.txt') }), /本人真实绑定/);
      assert.match(s.guard('write', { file_path: join(`${s.cwd}-sibling`, 'result.txt') }), /本人真实绑定/, '同名前缀兄弟目录不在根内');
      assert.match(s.guard('pwsh', { command: 'harmless', cwd: s.cwd }), /闭名单/);
      await s.org.tasks.start(n.id, { subject: MEMBER, 项目: P });
      await s.org.tasks.submit(n.id, { subject: MEMBER, 项目: P, 结论: 'done' });
      assert.match(s.guard('write', { file_path: s.input, content: 'changed after submit' }), /本人真实绑定/, '交卷关闭通用写窗口');
    } finally { await s.cleanup(); }
  });

  it('没有部署者上限、越授或自授均拒；cwd 变化与同名前缀目录不会扩大授权', async () => {
    const s = await setup({ configured: false });
    try {
      await assert.rejects(() => s.dispatch(), /不在部署者给 Lead/);
      s.org.tasks.configureToolFiles({ read: [s.cwd], write: [] });
      await assert.rejects(() => s.dispatch({ 读: [s.outside] }), /不在部署者给 Lead/);
      const authority = s.org.tasks.toolFileAuthority();
      assert.throws(() => authority.grant({ 读: [s.cwd] }, MEMBER), /成员不能给自己/);
      await s.dispatch({ 读: [s.cwd] });
      assert.match(s.guard('write', { file_path: s.input }), /本人真实绑定/);
      assert.match(s.guard('read', { file_path: join(s.outside, 'x') }, 'member-a', s.outside), /本人真实绑定/);
      s.org.tasks.configureToolFiles({ read: [], write: [] });
      assert.match(s.guard('read', { file_path: s.input }), /上限已撤回/);
    } finally { await s.cleanup(); }
  });

  it('private/factory 及其递归父根不可授权；junction 下新文件和递归搜索均不得越根', async () => {
    const s = await setup();
    try {
      assert.throws(() => new ToolFileAuthority({ layout: s.f.layout, config: { read: [s.f.home] } }), /私有组织账本与出厂规则根/);
      assert.throws(() => s.org.tasks.toolFileAuthority().grant({ 读: [s.f.privateRoot] }, LEAD), /私有组织账本与出厂规则根/);
      await s.dispatch();
      assert.match(s.guard('read', { file_path: s.f.layout.identityFile() }), /组织原始文件隔离/);
      assert.equal(s.guard('glob', { path: s.cwd, pattern: '**/*' }), undefined);
      const link = join(s.cwd, 'escape');
      await symlink(s.outside, link, process.platform === 'win32' ? 'junction' : 'dir');
      assert.match(s.guard('write', { file_path: join(link, 'new.txt') }), /本人真实绑定/);
      assert.match(s.guard('glob', { path: s.cwd, pattern: '**/*' }), /符号链接\/junction/);
    } finally { await s.cleanup(); }
  });

  it('member_spawn 的文件越授在任何宿主创建副作用之前拒绝', async () => {
    const s = await setup();
    try {
      const node = await s.org.tasks.create({ subject: LEAD, 项目: P, 描述: 'invalid spawn scope', 负责人: ['插件工程'], 判据: ['must not start'] });
      let calls = 0;
      const agent = { id: 'lead', session: { id: 'lead', header: { cwd: s.cwd } } };
      const host = { agent, project: P, signal: new AbortController().signal,
        delegation: { authorize: () => ({ fingerprint: 'fixture' }) },
        subagents: { async startContinuable() { calls += 1; throw new Error('must not be called'); } } };
      await assert.rejects(() => runAction({ org: s.org, 项目: P, 主体: LEAD, 面: 'tool', 宿主: host,
        args: { action: 'member_spawn', 方式: 'subagent', 岗位: '插件工程', 节点: node.id, 任务书: 'no side effect', 工具文件范围: { 写: [s.outside] } } }), /不在部署者给 Lead/);
      assert.equal(calls, 0);
      assert.equal((await s.org.tasks.get(node.id, { 项目: P })).状态, '待派发');
    } finally { await s.cleanup(); }
  });

  it('派发后硬链接入根内的身份档案和外部普通保密文件均不能借路径授权读写或递归搜索', async () => {
    const s = await setup();
    try {
      await s.dispatch();
      assert.equal((await stat(s.input)).nlink, 1);
      for (const tool of ['read', 'read_image', 'write', 'edit']) assert.equal(s.guard(tool, { file_path: s.input, content: 'unchanged', old_string: 'x', new_string: 'y' }), undefined, '单链接普通文件保留正例');
      const secret = join(s.outside, 'private.txt');
      await writeFile(secret, 'outside-confidential');
      const identityBefore = await readFile(s.f.layout.identityFile(), 'utf8');
      for (const [source, name] of [[s.f.layout.identityFile(), 'ordinary.json'], [secret, 'ordinary.txt']]) {
        const alias = join(s.cwd, name);
        await link(source, alias); // 必须在 apply/派发之后，避免身份原子替换把旧别名脱钩。
        assert.equal((await stat(alias)).nlink, 2);
        for (const tool of ['read', 'read_image', 'write', 'edit']) assert.match(s.guard(tool, { file_path: alias, content: 'must not execute', old_string: 'x', new_string: 'y' }), /硬链接/);
      }
      for (const tool of ['glob', 'grep']) assert.match(s.guard(tool, { path: s.cwd, pattern: '*' }), /硬链接/);
      const safe = join(s.cwd, 'safe');
      await mkdir(join(safe, 'nested'), { recursive: true });
      await writeFile(join(safe, 'nested', 'one.txt'), 'single link');
      assert.equal(s.guard('glob', { path: safe, pattern: '**/*' }), undefined, '普通目录不因目录自身 nlink 多于1误拒');
      assert.equal(await readFile(s.f.layout.identityFile(), 'utf8'), identityBefore, '只执行判定，身份档案不被测试工具修改');
      assert.equal(await readFile(secret, 'utf8'), 'outside-confidential');
    } finally { await s.cleanup(); }
  });

  for (const revoked of ['member-a', 'lead', 'task']) it(`真实撤回 ${revoked} 后写/edit和交付捕获立即失权，mind诊断仍可达`, async () => {
    const s = await setup();
    try {
      const node = await s.dispatch();
      const running = await s.org.tasks.start(node.id, { subject: MEMBER, 项目: P });
      assert.equal(s.guard('write', { file_path: s.input }), undefined);
      assert.equal(s.org.tasks.toolFileAuthority().canCapture(s.input, { ...running, 项目: P }, MEMBER), true);
      await s.org.registry.revoke({ subject: { id: 'sovereign', kind: '主权者' }, 对象id: revoked === 'task' ? node.id : revoked, 理由: 'withdraw new writes' });
      const decision = await s.org.policy.decide({ subject: MEMBER, action: 'write', target: { id: node.id, kind: '任务', authority: '自治', zone: '私有', project: P }, context: { task: running } });
      assert.equal(decision.verdict, 'deny', '现行策略真实拒绝作为对照');
      for (const tool of ['write', 'edit']) assert.match(s.guard(tool, { file_path: s.input }), /撤回|不越授/);
      assert.equal(s.org.tasks.toolFileAuthority().canCapture(s.input, { ...running, 项目: P }, MEMBER), false);
      assert.equal(s.guard('mind', { action: 'status' }), undefined);
    } finally { await s.cleanup(); }
  });

  it('失联、策略故障和动态审批收紧同步冻结文件新写；人侧恢复后原合法范围可再用', async () => {
    const s = await setup();
    try {
      await writeFile(s.f.layout.deploymentPrefs(), JSON.stringify({ 介入度: '放权' }));
      await s.org.policy.reload();
      await s.dispatch();
      const originalClock = s.org.clock._source;
      s.org.clock._source = () => new Date(Date.now() + 8 * 86400_000);
      assert.match(s.guard('write', { file_path: s.input }), /失联/);
      assert.equal(s.guard('mind', { action: 'status' }), undefined);
      s.org.clock._source = originalClock;
      assert.equal(s.guard('write', { file_path: s.input }), undefined);
      const originalPrefs = await stat(s.f.layout.deploymentPrefs());
      await writeFile(s.f.layout.deploymentPrefs(), JSON.stringify({ 介入度: '审批' }));
      await utimes(s.f.layout.deploymentPrefs(), originalPrefs.atime, originalPrefs.mtime);
      assert.equal((await stat(s.f.layout.deploymentPrefs())).size, originalPrefs.size, '同尺寸并恢复mtime也必须发现真实授权变化');
      assert.match(s.guard('write', { file_path: s.input }), /授权依赖原文已变化/, '无需等5秒或依赖旧mtime');
      await s.org.policy.reload();
      assert.match(s.guard('edit', { file_path: s.input }), /审批|放行/);
      await writeFile(s.f.layout.deploymentPrefs(), '{broken');
      assert.match(s.guard('write', { file_path: s.input }), /故障|原文已变化/);
      await s.org.policy.reload();
      assert.match(s.guard('write', { file_path: s.input }), /不健康|故障/);
      assert.equal(s.guard('mind', { action: 'status' }), undefined);
      await writeFile(s.f.layout.deploymentPrefs(), JSON.stringify({ 介入度: '放权', 允许: [], 拒绝: ['write'] }));
      await s.org.policy.reload();
      assert.match(s.guard('write', { file_path: s.input }), /工具总范围之外/, '工具总范围收紧逐次读取');
      await writeFile(s.f.layout.deploymentPrefs(), JSON.stringify({ 介入度: '放权' }));
      await s.org.policy.reload();
      assert.equal(s.guard('write', { file_path: s.input }), undefined);
    } finally { await s.cleanup(); }
  });

  for (const change of ['岗位', '代', '卡', '宿主代次']) it(`同id实例${change}变化不能继承旧文件权；同岗正规restore保留原凭证可继续`, async () => {
    const s = await setup();
    try {
      await s.dispatch();
      await s.org.registry.seal({ subject: LEAD, 实例: MEMBER.id, 理由: 'regular suspend' });
      assert.match(s.guard('write', { file_path: s.input }), /未就绪/);
      await s.org.registry.restore({ subject: LEAD, 实例: MEMBER.id });
      assert.equal(s.guard('write', { file_path: s.input }), undefined, '同岗同代同卡正规复岗保留权');
      const source = await readFile(join(s.f.factoryRoot, '集体L3-成员角色卡/插件工程.md'), 'utf8');
      await s.f.write('集体L3-成员角色卡/测试工程.md', source.replaceAll('插件工程', '测试工程'));
      await s.org.registry.seal({ subject: LEAD, 实例: MEMBER.id, 理由: 'change role' });
      await s.org.registry.assign({ subject: LEAD, 实例: MEMBER.id, 岗位: '测试工程' });
      assert.match(s.guard('write', { file_path: s.input }), /绑定岗位\/实例凭证/);
      if (change !== '岗位') {
        await s.org.registry.seal({ subject: LEAD, 实例: MEMBER.id, 理由: 'new identity pin' });
        if (change === '卡') await s.f.write('集体L3-成员角色卡/插件工程.md', source.replace('1. 先定判据再干活。', '1. 先定判据再干活。\n2. 新卡新增限制。'));
        await s.org.registry.assign({ subject: LEAD, 实例: MEMBER.id, 岗位: '插件工程', ...(change === '代' ? { 代: 2 } : {}), ...(change === '宿主代次' ? { 代次: { 代: 'new-host-generation', pid: process.pid } } : {}) });
        assert.match(s.guard('write', { file_path: s.input }), /绑定岗位\/实例凭证/);
      }
    } finally { await s.cleanup(); }
  });
});
