import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { apply } from '../components/kernel/lib/index.js';
import { shareOrg, forgetSharedOrg } from '../src/runtime.js';
import { makeFixture, LEAD } from './helpers.mjs';
import { fakeHost } from './host-harness.mjs';

const P = 'config-failclosed';
const args = (name, file) => name === 'pwsh' ? { command: 'must not execute' }
  : { file_path: file, content: 'must not execute' };
const agents = [
  undefined,
  { session: { id: 'lead', header: {} } },
  { session: { id: 'member-a', header: { origin: 'subagent', parentSession: 'lead', delegationDepth: 1 } } },
];
const rejection = (host, exec) => host.闸.map((g) => g(exec)).find((r) => r !== undefined);

function assertClosed(host, file) {
  assert.equal(host.闸.length, 1, '故障之前已有承重范围闸，不等待正常注册阶段');
  for (const agent of agents) {
    for (const name of ['read', 'write', 'pwsh']) {
      assert.match(rejection(host, { name, arguments: args(name, file), agent }), /未就绪.*fail-closed|fail-closed.*未就绪/);
    }
    for (const name of ['skill', 'mind_guard', 'unknown_future_tool']) assert.match(rejection(host, { name, agent }), /fail-closed/);
    assert.match(rejection(host, { name: 'mind', arguments: { action: 'task_submit' }, agent }), /fail-closed/);
    assert.equal(rejection(host, { name: 'mind', arguments: { action: 'status' }, agent }), undefined, '仅精确自述动作保持可用');
    assert.equal(rejection(host, { name: 'mind', arguments: {}, agent }), undefined, '无action时也是自述');
  }
  assert.match(rejection(host, undefined), /fail-closed/, '连执行上下文也缺失时不能默认放行');
}

async function fixture(t) {
  const f = await makeFixture();
  const cwd = join(f.home, 'work');
  await mkdir(cwd);
  const file = join(cwd, 'input.txt');
  await writeFile(file, 'preserved input');
  const hosts = [];
  t.after(async () => { for (const host of hosts) host.清理(); forgetSharedOrg(); await f.cleanup(); });
  const host = () => { const h = fakeHost(); hosts.push(h); return h; };
  const config = { home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P,
    projectBindings: [{ path: cwd, project: P }], memberFileAccess: { read: [cwd], write: [cwd] }, audit工具调用: false };
  return { f, cwd, file, config, host };
}

async function assertRecovered(s) {
  // 模拟宿主卸载故障配置、以修正配置重新装配；共享 Org 不应被上一次失败污染。
  const host = s.host();
  await apply(host.ctx, s.config);
  assert.equal(host.闸.length, 2, '正常装配仍保持范围与创建两闸，不堆积启动平行闸');
  const tool = host.工具.get('mind');
  assert.ok(tool.parameters.properties.action.enum.includes('task_create'), '恢复完整组织工具而不是只读自述');
  const exec = { name: 'mind', agent: { session: { id: 'lead', header: { cwd: s.cwd } } } };
  const status = JSON.parse(await tool.execute({ action: 'status' }, exec));
  assert.equal(status.成功, true, JSON.stringify(status));
  const org = await shareOrg(s.config);
  const n = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '修复配置后合法文件任务', 负责人: '插件工程', 判据: ['合法范围可用'] });
  await org.tasks.bind(n.id, { subject: LEAD, 项目: P, 实例: 'member-a', 岗位: '插件工程' });
  await org.tasks.dispatch(n.id, { subject: LEAD, 项目: P, 工具文件范围: { 读: [s.cwd], 写: [s.cwd] } });
  const agent = { session: { id: 'member-a', header: { cwd: s.cwd, origin: 'subagent', parentSession: 'lead', delegationDepth: 1 } } };
  assert.equal(rejection(host, { name: 'read', arguments: { file_path: s.file }, agent }), undefined, '真实已绑定任务授权恢复');
  assert.match(rejection(host, { name: 'pwsh', arguments: { command: 'never executed' }, agent }), /闭名单/);
}

describe('内核配置故障路径的承重范围闸', () => {
  for (const [label, invalid, reason] of [
    ['memberFileAccess 授权组织双区的父目录', (s) => ({ memberFileAccess: { read: [s.f.home] } }), /私有组织账本|出厂规则根/],
    ['projectBindings 非法 project 路径段', (s) => ({ projectBindings: [{ path: s.cwd, project: '..' }] }), /绑定项目|路径段|不能/],
    ['shareOrg 初始化参数失败', () => ({ privateRoot: 42 }), /string|类型|Received/],
  ]) {
    it(`${label}：诊断工具之前已拒原生工具，修正配置后合法启动`, async (t) => {
      const s = await fixture(t);
      const host = s.host();
      const loading = apply(host.ctx, { ...s.config, ...invalid(s) });
      assertClosed(host, s.file); // 第一次 await 返回前即已注册，不只检查 catch 后的最终状态。
      await loading;
      assertClosed(host, s.file);
      const tool = host.工具.get('mind');
      assert.ok(tool, '故障后保留可用自述工具');
      const out = JSON.parse(await tool.execute({ action: 'status' }, { name: 'mind' }));
      assert.equal(out.成功, false);
      assert.equal(out.结果, '组织未装配');
      assert.match(out.理由, reason);
      assert.equal(await readFile(s.file, 'utf8'), 'preserved input', '测试只运行闸判定，没有执行原生工具');
      host.清理();
      await assertRecovered(s);
    });
  }
});
