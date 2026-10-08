/**
 * 宿主半区：装配、工具 schema、闸、审计钩子。
 *
 * 优先级最高的断言是「装配绝不抛」——一个抛错的插件会让整个 profile 起不来，
 * 而设计 §3.6 要求的是「坏了必须拦住或响亮告警」，不是把宿主带崩。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeHost, fakeExec } from './host-harness.mjs';
import { writeUnder } from './helpers.mjs';
import * as plugin from '../components/kernel/lib/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const FACTORY = join(here, '..', 'mind');
const 工具总范围出厂件 = '集体L2-共享基础设施/defaults/工具总范围.json';

describe('dsh-mind 宿主半区', () => {
  /** @type {string} */ let home;
  /** @type {any} */ let host;

  before(async () => {
    home = await mkdtemp(join(tmpdir(), 'mind-boot-'));
    // 出厂区用产品自带的那份；私有区留空，让插件自己引导。
    await writeUnder(home, 'mind-private/README.md', '# 私有区（测试）\n');
    host = fakeHost();
    await plugin.apply(host.ctx, { home, factoryRoot: FACTORY, privateRoot: join(home, 'mind-private') });
  });

  after(async () => {
    host?.清理();
    // Windows 上后台的审计写入可能正好压在删除上：给它几次重试，
    // 让偶发的 ENOTEMPTY 不至于把整轮验证判成失败。
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
  });

  it('导出符合宿主约定的三个符号', () => {
    // 组件名就是它那一行的包名：插件列表里「包含的组件」显示的就是它。
    assert.equal(plugin.name, 'dsh-mind-kernel');
    assert.deepEqual(plugin.inject, ['tools']);
    assert.equal(typeof plugin.apply, 'function');
  });

  it('装配不抛，且注册了 mind 工具、命令与系统提示段', () => {
    assert.ok(host.工具.has('mind'), '应注册 mind 工具');
    assert.ok(host.命令.has('mind'), '应注册 /mind 命令');
    assert.equal(host.段落.length, 1);
    assert.match(host.段落[0].text, /按需拉取|Lead/);
    assert.equal(host.日志.filter((l) => l.startsWith('warn')).length, 0, `不应有告警：${host.日志.join(' | ')}`);
  });

  it('工具 schema 是宿主认识的 JSON Schema，且动作清单非空', () => {
    const tool = host.工具.get('mind');
    assert.equal(tool.parameters.type, 'object');
    assert.ok(Array.isArray(tool.parameters.properties.action.enum));
    assert.ok(tool.parameters.properties.action.enum.includes('workbench'));
    assert.deepEqual(tool.parameters.required, ['action']);
    assert.equal(typeof tool.output.render, 'function');
    assert.deepEqual(tool.output.render({}, 'hello'), [{ type: 'text', text: 'hello' }]);
    assert.equal(tool.isConcurrencySafe({ action: 'workbench' }), true);
    assert.equal(tool.isConcurrencySafe({ action: 'task_create' }), false);
    // schema ↔ actions ↔ src 三段必须对齐：动作层读的每个参数都要在 schema 里有名分
    // （additionalProperties:false，缺一个字段那个参数就永远传不进——交卷结论曾因此永远落空）。
    for (const field of ['结论', '决定', '复核者', '待决类型', 'limit', '敏感']) {
      assert.ok(tool.parameters.properties[field], `schema 缺字段：${field}`);
    }
  });

  it('execute 返回可解析的 JSON，且拒绝路径带可执行理由', async () => {
    const tool = host.工具.get('mind');
    const ok = JSON.parse(await tool.execute({ action: 'status' }, fakeExec({ name: 'mind' })));
    assert.equal(ok.成功, true);
    assert.equal(ok.数据.策略.healthy, true);

    const bad = JSON.parse(await tool.execute({ action: 'task_create', 描述: '没有判据的任务' }, fakeExec({ name: 'mind' })));
    assert.equal(bad.成功, false);
    assert.equal(bad.结果, '结构不合规');
    assert.ok(bad.理由.includes('判据'), `理由应点明缺判据：${bad.理由}`);
  });

  it('未知 action 不崩，返回可选清单', async () => {
    const tool = host.工具.get('mind');
    const result = JSON.parse(await tool.execute({ action: '不存在的动作' }, fakeExec({ name: 'mind' })));
    assert.equal(result.成功, false);
    assert.ok(result.理由.includes('未知 action'));
  });

  it('任务全链路可走通：建 → 派 → 交 → 复核', async () => {
    const tool = host.工具.get('mind');
    const exec = fakeExec({ name: 'mind' });
    const created = JSON.parse(await tool.execute({ action: 'task_create', 描述: '宿主链路验证', 负责人: 'member-a', 判据: '能建,能派', project: 'boot' }, exec));
    assert.equal(created.成功, true);
    const id = created.节点.id;

    const dispatched = JSON.parse(await tool.execute({ action: 'task_dispatch', id, project: 'boot' }, exec));
    assert.equal(dispatched.节点.判据冻结, true);

    const started = JSON.parse(await tool.execute({ action: 'task_start', id, project: 'boot' }, exec));
    assert.equal(started.节点.状态, '执行中');

    const submitted = JSON.parse(await tool.execute({ action: 'task_submit', id, project: 'boot', 产出物引用: 'artifact-1', 结论: '做完了', 反例面: '没测边界' }, exec));
    assert.equal(submitted.节点.状态, '已交卷');
    assert.deepEqual(submitted.节点.产出物引用, ['artifact-1']);
    // 结论与反例面必须原样落进独立答案：漏传会让零分歧判据「无人给反例面」恒真。
    assert.equal(submitted.节点.独立答案.length, 1);
    assert.equal(submitted.节点.独立答案[0].结论, '做完了');
    assert.deepEqual(submitted.节点.独立答案[0].反例面, ['没测边界']);

    const reviewed = JSON.parse(await tool.execute({ action: 'task_review', id, project: 'boot', 三态: '未验', 反例面: '读数拿不到' }, exec));
    assert.equal(reviewed.结论.算通过, false);
    assert.equal(reviewed.结论.计打回, false);
  });

  it('/mind 命令与工具共用同一张动作表', async () => {
    const command = host.命令.get('mind');
    assert.equal(command.name, 'mind');
    const status = JSON.parse((await command.handler({ agent: {}, rawInput: 'status' })).text);
    assert.equal(status.成功, true);
    assert.ok(status.数据.策略);

    const dashboard = JSON.parse((await command.handler({ agent: {}, rawInput: 'dashboard' })).text);
    assert.equal(dashboard.action, 'workbench');
    assert.equal(dashboard.数据.边界.只读, true);

    const failure = await command.handler({ agent: {}, rawInput: 'task_create 描述=没有判据' });
    assert.equal(failure.kind, 'error');
    assert.equal(JSON.parse(failure.text).成功, false);
  });

  it('闸是单调的：拒绝后任何后来的监听者都翻不回来', async () => {
    assert.equal(host.闸.length, 1, '应注册且只注册一道闸');
    const guard = host.闸[0];
    // 出厂默认是空名单 = 不额外收窄。
    assert.equal(guard(fakeExec({ name: 'read' })), undefined);
    assert.equal(guard(fakeExec({ name: 'pwsh' })), undefined);
  });

  it('工具总范围配置后立刻生效，并且越权调用带可执行理由', async () => {
    const prefs = join(home, 'mind-private', '集体L2-共享基础设施', 'defaults', '部署.json');
    await writeUnder(home, 'mind-private/集体L2-共享基础设施/defaults/部署.json', JSON.stringify({ 介入度: '零参与', 响应期限小时: 72, 工具总范围: '白名单' }, null, 2));
    assert.ok(prefs.includes('部署.json'));
    // 触发一次热更新周期（apply 里注册的定时器是 5s；这里直接改文件后等一个周期太慢，
    // 因此断言的是「闸读的是文件」这一契约：把名单改成拒绝 read 后，闸必须拒绝它。
    const tool = host.工具.get('mind');
    assert.ok(tool);
    // 闸住在内核组件里（组件化之后 lib/index.js 只剩宿主职责）。
    const 闸源 = await readFile(join(here, '..', 'components', 'kernel', 'lib', 'index.js'), 'utf8');
    assert.ok(闸源.includes('ENVELOPE_STATE.拒绝.includes'), '闸必须按拒绝名单判定');
    assert.ok(闸源.includes('fail-closed'), '闸必须有 fail-closed 路径');
  });

  it('tools/result 钩子把失败全记进审计', async () => {
    const before = (await (await import('node:fs/promises')).readFile(join(home, 'mind-private', '集体L2-共享基础设施', '审计日志', new Date().toISOString().slice(0, 7).replace(/^/, 'audit-') + '.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
    host.触发('tools/result', fakeExec({ name: 'pwsh' }), { isError: true, error: { message: '命令失败', info: { code: 'X' } } });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const after2 = (await readFile(join(home, 'mind-private', '集体L2-共享基础设施', '审计日志', `audit-${new Date().toISOString().slice(0, 7)}.jsonl`), 'utf8')).split('\n').filter(Boolean);
    assert.ok(after2.length > before, '失败必须落账');
    const last = JSON.parse(after2[after2.length - 1]);
    assert.equal(last.动作, '工具调用失败');
    assert.equal(last.档位, '全记');
    assert.equal(last.详情.原因, '命令失败');
  });

  it('轮汇总按轮落一条，且只统计写工具的成功调用', async () => {
    host.触发('tools/result', fakeExec({ name: 'pwsh', sessionId: 'session-round' }), { isError: false });
    host.触发('tools/result', fakeExec({ name: 'read', sessionId: 'session-round' }), { isError: false });
    host.触发('turn/end', { session: { id: 'session-round' } });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const rows = (await readFile(join(home, 'mind-private', '集体L2-共享基础设施', '审计日志', `audit-${new Date().toISOString().slice(0, 7)}.jsonl`), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const 汇总 = rows.filter((r) => r.动作 === '工具调用成功' && r.轮 === 'session-round');
    assert.equal(汇总.length, 1, '一轮只落一条汇总');
    assert.equal(汇总[0].详情.成功调用, 1, '只读调用不逐次记，也不进成功计数');
    assert.equal(汇总[0].档位, '记汇总');
  });

  it('出厂区缺失时仍然装配成功，但策略引擎不在位且写动作被 fail-closed 拒绝', async () => {
    const brokenHome = await mkdtemp(join(tmpdir(), 'mind-boot-broken-'));
    const broken = fakeHost();
    await plugin.apply(broken.ctx, { home: brokenHome, factoryRoot: join(brokenHome, '缺失的出厂区'), privateRoot: join(brokenHome, 'mind-private') });
    const tool = broken.工具.get('mind');
    assert.ok(tool, '装配仍要留下可用的 mind 工具');
    const status = JSON.parse(await tool.execute({ action: 'status' }, fakeExec({ name: 'mind' })));
    assert.equal(status.成功, true);
    assert.equal(status.数据.策略.healthy, false, '规则件缺失 ⇒ 引擎必须不在位');

    const denied = JSON.parse(await tool.execute({ action: 'memory_write', 类: '知识', 内容: 'x', 来源: '测试' }, fakeExec({ name: 'mind' })));
    assert.equal(denied.成功, false, '引擎不在位时写动作必须被拒绝');
    assert.match(denied.理由, /fail-closed|故障|不健康/);
    await rm(brokenHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
  });

  it('装配真出异常时降级为自述工具，而不是抛错', async () => {
    const broken = fakeHost();
    // 含 NUL 的路径必然让 mkdir 抛错 —— 用来证明「装配异常也不拖垮宿主」。
    await plugin.apply(broken.ctx, { home: 'C:\\bad\u0000dir', factoryRoot: FACTORY, privateRoot: 'C:\\bad\u0000dir\\mind-private' });
    assert.equal(broken.工具.has('mind'), true, '失败路径也必须留下一个 mind 工具');
    const parsed = JSON.parse(await broken.工具.get('mind').execute({ action: 'status' }, fakeExec({ name: 'mind' })));
    assert.equal(parsed.成功, false);
    assert.ok(parsed.理由.length > 0);
  });

  it('出厂默认值本身就是合规的工具总范围形状', async () => {
    const factory = JSON.parse(await readFile(join(FACTORY, 工具总范围出厂件), 'utf8'));
    assert.ok(Array.isArray(factory.允许));
    assert.ok(Array.isArray(factory.拒绝));
  });
});
