/**
 * 2026-10-12 评审批次 6：P3 清扫（报告 §四的「小毛病」逐条钉断言）。
 *
 * 后端：
 *  ① tasks 负责人去重（['A','A'] 不再虚增进度的源头）
 *  ② debate 收敛末位表态记真实主体 id（不硬编码 'lead'）
 *  ③ workbench 死分支摘除（负责人岗位 字段不存在，不许当匹配依据）
 *  ④ retrieval 命中数报截断前总数（limit=0 不许报「0 命中」）
 *  ⑤ store 未知规则件响亮拒（不再把锁建到 "null.lock"）
 *  ⑥ fsx readJsonOrNull 解析失败响亮抛（「坏了」≠「没有」）
 *  ⑦ tags 剥 BOM（front matter 不再整段消失）
 *  ⑧ memory overturn 先过 write 闸再落新条目（修前半动作窗口：新条目落了、推翻没标上）
 *  ⑨ audit_tail limit=0 ⇒ 空（slice(-0) 不回整组）
 *  ⑩ 命令面参数不许盖命令头（{...args, action}：头是权威）
 *  ⑪ 命令/工具入参布尔归一（'false' 不再恒真）
 *  ⑫ 工具总范围白名单：自家工具精确名单（'mindEvil' 不再搭前缀的便车）
 *  ⑬ describeFailure 兜底分支脱绝对路径
 *  ⑭ 同源路由注册失败 ⇒ 按预算重试（不再永久缺席只留一条 warn）
 *
 * 断言全部经塞 bug 校准（造坏 ⇒ 必红）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFixture, LEAD, writeUnder } from './helpers.mjs';
import { fakeHost } from './host-harness.mjs';
import { shareOrg, forgetSharedOrg } from '../src/runtime.js';
import * as kernel from '../components/kernel/lib/index.js';
import { TaskGraph } from '../src/tasks.js';
import { MessageBus } from '../src/bus.js';
import { RoleRegistry } from '../src/registry.js';
import { ReviewProtocol } from '../src/review.js';
import { DebateService } from '../src/debate.js';
import { MemoryService } from '../src/memory.js';
import { ObjectStore } from '../src/store.js';
import { sliceForViewer } from '../src/workbench.js';
import { buildIndex, search } from '../src/retrieval.js';
import { parseDocument } from '../src/tags.js';
import { readJsonOrNull, readJsonl } from '../src/kernel/fsx.js';
import { describeFailure, Denied } from '../src/kernel/errors.js';
import { 挂同源路由 } from '../components/kernel/lib/routes.js';
import { runAction } from '../lib/actions.js';

const P = 'default';
const here = dirname(fileURLToPath(import.meta.url));
const FACTORY = join(here, '..', 'mind');

function 装配(g) {
  const tasks = new TaskGraph({ layout: g.layout, policy: g.policy, audit: g.audit, clock: g.clock });
  const bus = new MessageBus({ layout: g.layout, policy: g.policy, audit: g.audit, clock: g.clock });
  const registry = new RoleRegistry({ layout: g.layout, policy: g.policy, audit: g.audit, clock: g.clock });
  const review = new ReviewProtocol({ layout: g.layout, policy: g.policy, audit: g.audit, clock: g.clock, tasks, bus, random: () => 0 });
  const debate = new DebateService({ layout: g.layout, policy: g.policy, audit: g.audit, clock: g.clock, tasks, bus, review, registry });
  return { tasks, bus, registry, review, debate };
}

describe('批次6 · P3 后端', () => {
  it('① create 负责人去重：[A,A] ⇒ [A]', async () => {
    const g = await makeFixture();
    try {
      const { tasks } = 装配(g);
      const node = await tasks.create({ subject: LEAD, 项目: P, 描述: '去重', 负责人: ['member-a', 'member-a'], 判据: ['x'] });
      assert.deepEqual(node.负责人, ['member-a'], '重复负责人必须塌缩成一个');
    } finally {
      await g.cleanup();
    }
  });

  it('② converge 末位表态的发件人 = 真实主体 id（不是硬编码 lead）', async () => {
    const g = await makeFixture();
    try {
      const { tasks, bus, debate } = 装配(g);
      const node = await tasks.create({ subject: LEAD, 项目: P, 描述: '末位表态', 负责人: ['member-a', 'member-b'], 判据: ['x'], 模式: '独立会审' });
      await tasks.dispatch(node.id, { subject: LEAD, 项目: P });
      await tasks.start(node.id, { subject: { id: 'member-a', kind: '成员', roleId: '插件工程' }, 项目: P });
      for (const id of ['member-a', 'member-b']) {
        await tasks.submit(node.id, { subject: { id, kind: '成员', roleId: '插件工程' }, 项目: P, 结论: `${id} 案` });
      }
      await debate.open({ subject: LEAD, 项目: P, 节点: node.id });
      const 真Lead = { id: 'root-lead-实例', kind: 'Lead' };
      await debate.converge({ subject: 真Lead, 项目: P, 节点: node.id, 内容: '到此为止' });
      const 消息 = await bus.readRaw({ 项目: P, 线程: node.id });
      const 末位 = 消息.filter((m) => m.类型 === '表态').pop();
      assert.equal(末位.发件, 'root-lead-实例', '末位表态必须记真实主体 id（修前硬编码 lead，对不上账）');
    } finally {
      await g.cleanup();
    }
  });

  it('③ sliceForViewer：不存在的「负责人岗位」字段不许当匹配依据', async () => {
    const view = {
      任务: { 节点: [{ id: 'n1', 负责人: ['member-b'], 负责人岗位: 'member-a' }] },
      待你决定: [], 会审: [], 审计尾: [], 消息总线: [],
    };
    const 切片 = sliceForViewer(view, { id: 'member-a', kind: '成员' });
    assert.equal(切片.任务.节点.length, 0, '节点上没有 负责人岗位 这个字段：拿它匹配 = 死分支漏数据（修前 member-a 看得见别人的节点）');
  });

  it('④ retrieval：命中数报截断前总数（limit=0 也是真命中数）', () => {
    const index = buildIndex([
      { id: 'a', 正文: '审计链 必须 响亮 失败' },
      { id: 'b', 正文: '审计链 不许 静默' },
    ]);
    const r0 = search(index, '审计链', { limit: 0 });
    assert.equal(r0.命中.length, 0, 'limit=0 ⇒ 列表为空（这没变）');
    assert.equal(r0.口径.命中数, 2, '但命中数必须是截断前的真数（修前报 0 ⇒ 「有命中」被报成「0 命中」）');
    const r1 = search(index, '审计链', { limit: 1 });
    assert.equal(r1.命中.length, 1);
    assert.equal(r1.口径.命中数, 2, '截断不许改读数');
  });

  it('⑤ store：未知规则件 id ⇒ 响亮拒（不再把锁建到 null.lock）', async () => {
    const g = await makeFixture();
    try {
      const store = new ObjectStore({ layout: g.layout, policy: g.policy, audit: g.audit, clock: g.clock });
      await assert.rejects(
        () => store.write('规则', { meta: { id: '根本没这条规则' }, body: '' }, { subject: LEAD }),
        (e) => e.name === 'InvalidBody' && /未知规则件/.test(e.message),
      );
    } finally {
      await g.cleanup();
    }
  });

  it('⑥ readJsonOrNull：文件坏了 ⇒ 抛（不许伪装成「没有」）', async () => {
    const g = await makeFixture();
    try {
      const file = join(g.privateRoot, '坏.json');
      await writeFile(file, '{ 这根本不是 JSON');
      await assert.rejects(() => readJsonOrNull(file), (e) => e.name === 'InvalidBody' && /JSON 解析失败/.test(e.message));
      assert.equal(await readJsonOrNull(join(g.privateRoot, '不存在.json')), null, '不存在仍回 null（语义没混）');
    } finally {
      await g.cleanup();
    }
  });

  it('⑦ parseDocument 剥 BOM：带 BOM 的 front matter 不再整段消失', () => {
    const parsed = parseDocument('﻿---\nid: 带bom\n---\n正文在这里');
    assert.equal(parsed.meta.id, '带bom', 'BOM 之后 front matter 必须照常解析');
    assert.ok(parsed.body.startsWith('正文在这里'), '正文不许带 front matter 残渣');
  });

  it('⑧ overturn 先过 write 闸：闸拒 ⇒ 新条目也不许落（修前撕裂：条目落了、推翻没标上）', async () => {
    const g = await makeFixture();
    try {
      // 包装真引擎：只把 'write' 动作拒掉，其余放行（测的是动作序，不是引擎）。
      const 拒写 = new Proxy(g.policy, {
        get(t, k) {
          if (k === 'check') {
            return async (input) => {
              if (input.action === 'write') throw new Denied('测试闸：拒写', '本用例故意拒 write 动作');
              return t.check(input);
            };
          }
          const v = t[k];
          return typeof v === 'function' ? v.bind(t) : v;
        },
      });
      const memory = new MemoryService({ layout: g.layout, policy: 拒写, audit: g.audit, clock: g.clock });
      const base = await memory.remember({ subject: LEAD, 类: '知识', 内容: '旧说法', 来源: '测试', 项目: P });
      const 账本 = g.layout.memoryLog(P, '知识');
      const 前行数 = (await readJsonl(账本)).length;
      await assert.rejects(
        () => memory.overturn(base.id, { subject: LEAD, 新条目: '新说法', 理由: '有新证据' }),
        (e) => e.name === 'Denied' && /测试闸/.test(e.rule),
      );
      const 后行数 = (await readJsonl(账本)).length;
      assert.equal(后行数, 前行数, 'write 闸拒了 ⇒ 新条目一行都不许落（修前：remember 先落、状态行后拒 ⇒ 撕裂）');
    } finally {
      await g.cleanup();
    }
  });

  it('⑨ audit_tail：limit=0 ⇒ 空数组（slice(-0) 不许回整组）', async () => {
    const g = await makeFixture();
    try {
      await g.audit.append({ 动作: '状态变更', 主体: 'lead', 结果: '一' });
      const r0 = await runAction({ org: { audit: g.audit }, 项目: P, 主体: LEAD, args: { action: 'audit_tail', limit: 0 } });
      assert.deepEqual(r0.审计, [], 'limit=0 = 一条都不要');
      const r1 = await runAction({ org: { audit: g.audit }, 项目: P, 主体: LEAD, args: { action: 'audit_tail', limit: 1 } });
      assert.equal(r1.审计.length, 1, 'limit=1 正常截尾');
    } finally {
      await g.cleanup();
    }
  });

  it('⑩ 命令面：参数里的 action 不许盖命令头（头是权威）', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mind-p3-cmd-'));
    const host = fakeHost();
    try {
      await kernel.apply(host.ctx, { home, factoryRoot: FACTORY, privateRoot: join(home, 'mind-private') });
      await shareOrg({ home, factoryRoot: FACTORY, privateRoot: join(home, 'mind-private') });
      const 回复 = await host.命令.get('mind').handler({ agent: {}, rawInput: 'status action=task_create' });
      const 包 = JSON.parse(回复.text);
      assert.equal(包.成功, true, `status 必须照跑（修前被参数盖成 task_create ⇒ 缺描述报错）：${回复.text}`);
      assert.equal(包.action, 'status', '命令头是权威，参数里的 action 只是普通参数');
    } finally {
      host.清理();
      forgetSharedOrg();
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
    }
  });

  it('⑪ 入参布尔归一：命令行 显式=true ⇒ 真把归档作答拉回（修前字符串真值恒假）', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mind-p3-bool-'));
    const host = fakeHost();
    try {
      await kernel.apply(host.ctx, { home, factoryRoot: FACTORY, privateRoot: join(home, 'mind-private') });
      const org = await shareOrg({ home, factoryRoot: FACTORY, privateRoot: join(home, 'mind-private') });
      await org.memory.remember({ subject: LEAD, 类: '作答', 内容: '归档的旧答案', 来源: { 谁: 'lead', 怎么知道: '批次6测试' }, 项目: P });
      await org.memory.archiveAnswers({ 项目: P, 任务: 'task-p3-bool', subject: LEAD });
      // 对照臂：不带 显式 ⇒ 归档作答不进检索面。
      const 不带 = JSON.parse((await host.命令.get('mind').handler({ agent: {}, rawInput: 'memory_query 文本=归档' })).text);
      assert.ok(!JSON.stringify(不带).includes('归档的旧答案'), '前提：默认不含归档作答');
      const 带上 = JSON.parse((await host.命令.get('mind').handler({ agent: {}, rawInput: 'memory_query 文本=归档 显式=true' })).text);
      assert.ok(JSON.stringify(带上).includes('归档的旧答案'),
        "显式=true 必须真生效（修前字符串 'true' 过不了 === true ⇒ 恒假 ⇒ 永远拉不回）");
    } finally {
      host.清理();
      forgetSharedOrg();
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
    }
  });

  it('⑫ 工具总范围白名单：mindEvil 不许搭 mind 前缀的便车；mind/mind_guard 照常', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mind-p3-allow-'));
    const host = fakeHost();
    try {
      await writeUnder(join(home, 'mind-private'), '集体L2-共享基础设施/defaults/部署.json', JSON.stringify({ 允许: ['read'] }));
      await kernel.apply(host.ctx, { home, factoryRoot: FACTORY, privateRoot: join(home, 'mind-private') });
      await new Promise((r) => setTimeout(r, 30)); // 刷新工具总范围是异步的，等它落定
      const 闸 = host.闸[0];
      assert.ok(typeof 闸 === 'function', '前提：工具闸已注册');
      assert.ok(typeof 闸({ name: 'mindEvil' }) === 'string', 'mindEvil 不在白名单 ⇒ 拒（修前 startsWith 放行）');
      assert.equal(闸({ name: 'mind' }), undefined, '自家 mind 放行');
      assert.equal(闸({ name: 'mind_guard' }), undefined, '自家 mind_guard 放行');
      assert.ok(typeof 闸({ name: 'bash' }) === 'string', '白名单外的普通工具照样拒');
    } finally {
      host.清理();
      forgetSharedOrg();
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
    }
  });

  it('⑬ describeFailure 兜底分支：脱绝对路径（部署目录结构不外泄）', () => {
    const r = describeFailure(new Error("ENOENT: no such file or directory, open 'C:\\Users\\wjthq\\mind-data\\秘密.json'"));
    assert.ok(!r.理由.includes('C:\\Users'), 'Windows 绝对路径不许原文外泄');
    assert.ok(r.理由.includes('<路径:秘密.json>'), `折成 <路径:文件名>：${r.理由}`);
    // 类型化分支不动：Denied 的文案是机制写的，照原样
    const d = describeFailure(new Denied('规则', '带路径也照原文：C:\\Users\\x（机制文案是面向操作者的）'));
    assert.ok(d.理由.includes('C:\\Users'), 'Denied 分支不碰（机制文案有意面向操作者）');
  });

  it('⑭ 同源路由注册失败 ⇒ 按预算重试（修前一次失败就永久缺席）', async () => {
    const 注册日志 = [];
    let 第几次 = 0;
    const ws = {
      register(def) {
        第几次 += 1;
        注册日志.push(def.path);
        if (第几次 === 1) throw new Error('duplicate exact route（瞬时冲突）');
        return () => {};
      },
    };
    const ctx = {
      webServer: ws,
      effect(fn) { this._清理 = fn(); return this._清理; },
    };
    const 警告 = [];
    挂同源路由({ ctx, org: {}, 项目: P, logger: { warn: (m) => 警告.push(m) }, 间隔毫秒: 5, 次数: 5 });
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(注册日志.includes('/plugins/dsh-mind/presence')
      && 注册日志.includes('/plugins/dsh-mind/workbench')
      && 注册日志.includes('/plugins/dsh-mind/ping'),
      `第一次失败后必须重试到挂上（修前：挂 0 条 + 一条 warn 了事）。注册日志：${JSON.stringify(注册日志)}`);
    assert.ok(注册日志.length >= 4, '第一次失败 + 第二次三条全挂 ⇒ 至少 4 次 register 调用');
  });
});
