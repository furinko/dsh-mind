/** 用真实账本验证检索与浏览不会把整本记忆装进模型回复。 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, LEAD, MEMBER, REVIEWER } from './helpers.mjs';
import { MemoryService } from '../src/memory.js';
import { TaskGraph } from '../src/tasks.js';
import { InvalidBody } from '../src/kernel/errors.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeHost, fakeExec } from './host-harness.mjs';
import * as kernel from '../components/kernel/lib/index.js';
import { serializeMemoryEnvelope, memoryResponseOptions, memoryResponsePage } from '../src/memory-response.js';

const P = 'response-project';

async function fixture(run) {
  const f = await makeFixture();
  const memory = new MemoryService(f);
  try { await run(memory, f); } finally { await f.cleanup(); }
}

function bounded(result, budget, total = JSON.stringify(result).length) {
  const used = JSON.stringify({ 命中: result.命中, 条目: result.条目 }).length;
  assert.equal(result.内容已用, used, '读数必须来自实际回传内容');
  assert.ok(used <= budget, `实际${used}不能超过${budget}`);
  assert.equal(result.总响应字符, total);
  assert.ok(result.总响应字符 <= result.总响应上限);
}

describe('有界记忆读面', () => {
  it('标志自身占用预算后的最后一字符裁剪同步刷新正文边界', () => {
    const id = 'x'.repeat(52);
    const entry = { id, 内容: '文'.repeat(356), 来源: '源'.repeat(1000), 状态: '有效' };
    const first = memoryResponsePage({ entries: [entry], total: 1, detail: true, options: memoryResponseOptions({ id, 返回模式: '全文', 内容预算: 512 }) });
    assert.equal(first.条目[0].内容.length, 355, '夹具命中标志占位导致正文继续收缩的边界');
    assert.equal(first.条目[0].正文截断, true);
    assert.equal(first.下一正文偏移, first.条目[0].内容.length);
    assert.ok(first.内容已用 <= 512);
    const last = memoryResponsePage({ entries: [entry], total: 1, detail: true, options: memoryResponseOptions({ id, 返回模式: '全文', 内容预算: 512, 正文偏移: first.下一正文偏移, 数据版本: '0'.repeat(64) }) });
    assert.equal(first.条目[0].内容 + last.条目[0].内容, entry.内容);
    assert.equal(last.条目[0].正文截断, false);
    assert.equal(last.条目[0].下一正文偏移, null);
    assert.equal(last.下一正文偏移, null);
  });

  it('文本零命中只回口径，不夹带无关或失效全文', async () => fixture(async (m) => {
    await m.remember({ subject: LEAD, 类: '知识', 项目: P, 内容: `orbit ${'无关长正文'.repeat(2000)}`, 来源: '真实夹具' });
    const invalid = await m.remember({ subject: LEAD, 类: '知识', 项目: P, 内容: 'obsolete-secret 作废知识', 来源: '真实夹具' });
    await m.invalidate(invalid.id, { subject: LEAD, 原因: '被证据否定' });
    const result = await m.query({ subject: LEAD, 项目: P, 文本: 'missingkeyword', 返回模式: '摘要' });
    assert.deepEqual(result.条目, []);
    assert.deepEqual(result.命中, []);
    assert.equal(result.口径.文档数, 1);
    assert.equal(result.口径.条目数, 2);
    assert.equal(result.口径.排除失效, 1);
    assert.match(result.说明, /0 命中.*候选文档数=1/);
    assert.doesNotMatch(JSON.stringify(result), /orbit|obsolete-secret|无关长正文/);
  }));

  it('文本只返回实际命中，摘要不携全文，id详情仍可取同一条正文', async () => fixture(async (m) => {
    const text = `nebula ${'匹配正文'.repeat(1000)}`;
    const wanted = await m.remember({ subject: LEAD, 类: '知识', 项目: P, 内容: text, 来源: '真实夹具' });
    const other = await m.remember({ subject: LEAD, 类: '知识', 项目: P, 内容: 'planet 不相关', 来源: '真实夹具' });
    const result = await m.query({ subject: LEAD, 项目: P, 文本: 'nebula', 返回模式: '摘要' });
    assert.deepEqual(result.条目.map((e) => e.id), [wanted.id]);
    assert.deepEqual(result.命中.map((e) => e.id), [wanted.id]);
    assert.ok(!('内容' in result.条目[0]));
    assert.ok(result.条目[0].摘要.length <= 160);
    assert.ok(!JSON.stringify(result).includes(other.id));
    const detail = await m.query({ subject: LEAD, 项目: P, id: wanted.id, 返回模式: '全文' });
    assert.equal(detail.条目[0].内容, text);
    bounded(result, 12000);
  }));

  it('无文本只浏览当前有效视图；历史必须明确含失效，id也不能绕过', async () => fixture(async (m) => {
    const e = await m.remember({ subject: LEAD, 类: '知识', 项目: P, 内容: 'invalidbody-secret', 来源: '真实夹具' });
    await m.invalidate(e.id, { subject: LEAD, 原因: '否定' });
    for (const params of [{}, { id: e.id }, { 文本: 'invalidbody' }]) {
      const result = await m.query({ subject: LEAD, 项目: P, ...params });
      assert.deepEqual(result.条目, []);
      assert.equal(result.口径.排除失效, 1);
      assert.doesNotMatch(JSON.stringify(result), /invalidbody-secret/);
    }
    const history = await m.query({ subject: LEAD, 项目: P, id: e.id, 含失效: true });
    assert.equal(history.条目[0].内容, 'invalidbody-secret');
    assert.equal(history.条目[0].状态, '已失效');
  }));

  it('多条长文、超长来源/标签/历史均受总JSON预算约束', async () => fixture(async (m) => {
    await m.remember({ subject: LEAD, 类: '偏好', 内容: `budgetterm ${'长文😀'.repeat(2000)}`, 来源: '来源'.repeat(8000), 标签: ['标签'.repeat(8000)] });
    await m.remember({ subject: LEAD, 类: '偏好', 内容: `budgetterm ${'第二篇'.repeat(2000)}`, 来源: '测试' });
    for (const 返回模式 of ['全文', '摘要']) {
      const result = await m.query({ subject: LEAD, 文本: 'budgetterm', 返回模式, 内容预算: 900 });
      bounded(result, 900);
      assert.equal(result.内容截断, true);
      assert.equal(result.条目截断, true);
      assert.equal(result.口径.命中数, 2);
      assert.equal(result.下一偏移, 1);
      const next = await m.query({ subject: LEAD, 文本: 'budgetterm', 返回模式, 内容预算: 900, 偏移: result.下一偏移, 数据版本: result.数据版本 });
      bounded(next, 900);
      assert.ok([...result.条目, ...next.条目].some((e) => e.元数据截断 === true));
    }
  }));

  it('id长正文可在有限预算内续读，正文偏移与列表偏移分开', async () => fixture(async (m) => {
    const expected = `pages ${'甲😀乙'.repeat(800)}`;
    const entry = await m.remember({ subject: LEAD, 类: '知识', 项目: P, 内容: expected, 来源: '真实夹具' });
    let offset = 0;
    let text = '';
    let pages = 0;
    let 数据版本;
    do {
      const result = await m.query({ subject: LEAD, 项目: P, id: entry.id, 返回模式: '全文', 正文偏移: offset, 数据版本, 内容预算: 800 });
      数据版本 = result.数据版本;
      bounded(result, 800);
      assert.equal(result.条目[0].正文偏移, offset);
      const piece = result.条目[0].内容;
      assert.doesNotMatch(piece, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
      text += piece;
      offset = result.下一正文偏移;
      if (offset !== null) assert.equal(offset, text.length);
      pages += 1;
      assert.ok(pages < 30, '有效有限分页必须前进');
    } while (offset !== null);
    assert.equal(text, expected);
    assert.ok(pages > 1);
  }));

  it('命中分页准确报告总数；零limit不冒称零命中', async () => fixture(async (m) => {
    for (let i = 0; i < 5; i += 1) await m.remember({ subject: LEAD, 类: '偏好', 内容: `pagingtoken ${i}`, 来源: '测试' });
    const ids = [];
    let offset = 0;
    let 数据版本;
    do {
      const result = await m.query({ subject: LEAD, 文本: 'pagingtoken', 返回模式: '摘要', limit: 2, 偏移: offset, 数据版本 });
      数据版本 = result.数据版本;
      assert.equal(result.口径.命中数, 5);
      ids.push(...result.条目.map((e) => e.id));
      offset = result.下一偏移;
    } while (offset !== null);
    assert.equal(ids.length, 5);
    assert.equal(new Set(ids).size, 5);
    const zero = await m.query({ subject: LEAD, 文本: 'pagingtoken', limit: 0 });
    assert.deepEqual(zero.条目, []);
    assert.equal(zero.口径.命中数, 5);
    assert.doesNotMatch(zero.说明, /0 命中/);
  }));

  it('浏览分页在内容预算提前结束时也不重复、不漏条目', async () => fixture(async (m) => {
    for (let i = 0; i < 5; i += 1) await m.remember({ subject: LEAD, 类: '偏好', 内容: `条目${i} ${'文'.repeat(1000)}`, 来源: '测试' });
    const ids = [];
    let offset = 0;
    let 数据版本;
    do {
      const result = await m.query({ subject: LEAD, 类: '偏好', 返回模式: '全文', 内容预算: 800, 条数上限: 3, 偏移: offset, 数据版本 });
      数据版本 = result.数据版本;
      bounded(result, 800);
      ids.push(...result.条目.map((e) => e.id));
      offset = result.下一偏移;
    } while (offset !== null);
    assert.equal(ids.length, 5);
    assert.equal(new Set(ids).size, 5);
  }));

  it('id详情复用项目、岗位、复核读域和归档权限过滤', async () => fixture(async (m, f) => {
    const tasks = new TaskGraph(f);
    const allowed = await tasks.create({ subject: LEAD, 项目: P, 负责人: '插件工程', 描述: '可读来源', 判据: ['存在'] });
    const denied = await tasks.create({ subject: LEAD, 项目: P, 负责人: '插件工程', 描述: '其他来源', 判据: ['存在'] });
    const a = await m.remember({ subject: LEAD, 类: '知识', 项目: P, 岗位: '插件工程', 内容: 'allowedscope 允许正文', 来源: '测试', 来源引用: [allowed.id] });
    const b = await m.remember({ subject: LEAD, 类: '知识', 项目: P, 内容: 'deniedscope 其他正文', 来源: '测试', 来源引用: [denied.id] });
    const domain = { 限定: true, 项目: P, 集合: new Set([allowed.id]), 说明: '真实来源范围' };
    assert.equal((await m.query({ subject: REVIEWER, 读者: REVIEWER, 项目: P, id: a.id, 读域: domain })).条目.length, 1);
    assert.equal((await m.query({ subject: REVIEWER, 读者: REVIEWER, 项目: P, id: b.id, 读域: domain })).条目.length, 0);
    assert.equal((await m.query({ subject: LEAD, 项目: 'another-project', id: a.id })).条目.length, 0);
    assert.equal((await m.query({ subject: LEAD, 项目: P, 岗位: '文档整理', id: a.id })).条目.length, 0);
    const answer = await m.remember({ subject: MEMBER, 类: '作答', 项目: P, 内容: 'archivedsecret', 来源: '实例', 任务: { 负责人: MEMBER.id } });
    await m.archiveAnswers({ subject: LEAD, 项目: P, 任务: 'task-complete' });
    assert.equal((await m.query({ subject: MEMBER, 读者: MEMBER, 项目: P, id: answer.id, 显式: true })).条目.length, 0);
    assert.equal((await m.query({ subject: LEAD, 读者: LEAD, 项目: P, id: answer.id, 显式: true })).条目.length, 1);
  }));

  it('非法或无限参数不能扩大读面与预算', async () => fixture(async (m) => {
    for (const params of [
      { limit: Infinity }, { limit: 101 }, { limit: -1 }, { limit: '100' },
      { 条数上限: Infinity }, { 条数上限: 101 }, { 内容预算: Infinity }, { 内容预算: 32001 },
      { 内容预算: 0 }, { 偏移: -1 }, { 偏移: 0.5 }, { 正文偏移: 1 },
      { 文本: 'a'.repeat(2049) }, { id: 'a'.repeat(257) }, { id: 'id', 文本: 'term' },
    ]) await assert.rejects(() => m.query({ subject: LEAD, ...params }), (e) => e instanceof InvalidBody);
  }));

  it('整个响应包括巨大读域说明和转义查询词仍有独立硬上限', async () => fixture(async (m) => {
    const domain = { 限定: true, 项目: P, 集合: new Set(), 说明: '\u0000'.repeat(100000) };
    const result = await m.query({ subject: LEAD, 项目: P, 文本: '\u0000'.repeat(2048), 读域: domain, 内容预算: 32000 });
    bounded(result, 32000);
    assert.equal(result.信封截断, true);
    assert.equal(result.口径.复核读域排除, 0);
  }));

  it('列表两页之间追加、或正文状态变化后续页显式要求重启', async () => fixture(async (m) => {
    for (let i = 0; i < 5; i += 1) await m.remember({ subject: LEAD, 类: '偏好', 内容: `snapshot ${i}`, 来源: '测试' });
    const first = await m.query({ subject: LEAD, 类: '偏好', 条数上限: 2 });
    await m.remember({ subject: LEAD, 类: '偏好', 内容: 'snapshot 6', 来源: '测试' });
    await assert.rejects(() => m.query({ subject: LEAD, 类: '偏好', 条数上限: 2, 偏移: first.下一偏移, 数据版本: first.数据版本 }), (e) => e instanceof InvalidBody && /已变化.*重新读取/.test(e.message));
    const entry = await m.remember({ subject: LEAD, 类: '偏好', 内容: '正文'.repeat(2000), 来源: '测试' });
    const body = await m.query({ subject: LEAD, id: entry.id, 内容预算: 800 });
    await m.demote(entry.id, { subject: LEAD, 原因: '状态变化' });
    await assert.rejects(() => m.query({ subject: LEAD, id: entry.id, 正文偏移: body.下一正文偏移, 数据版本: body.数据版本, 内容预算: 800 }), (e) => e instanceof InvalidBody && /已变化/.test(e.message));
  }));

  it('巨大追加历史不能绕过内容预算，正文仍可按id读取', async () => fixture(async (m) => {
    const entry = await m.remember({ subject: LEAD, 类: '偏好', 内容: 'history-body', 来源: '测试' });
    for (let i = 0; i < 3; i += 1) await m.demote(entry.id, { subject: LEAD, 原因: '历史原因'.repeat(2000) });
    const result = await m.query({ subject: LEAD, id: entry.id, 内容预算: 800 });
    bounded(result, 800);
    assert.equal(result.条目[0].元数据截断, true);
    assert.equal(result.条目[0].内容, 'history-body');
  }));

  it('真实完整包装与缩进按最终文本收口，纯序列化不改原结果', async () => fixture(async (m) => {
    await m.remember({ subject: LEAD, 类: '偏好', 内容: `needle ${'x'.repeat(40000)}`, 来源: '测试' });
    const result = await m.query({ subject: LEAD, 文本: `needle${'\u0000'.repeat(2000)}`, 内容预算: 32000 });
    const original = JSON.stringify(result);
    const text = serializeMemoryEnvelope({ 成功: true, action: 'memory_query', 项目: P, 结果: result }, 1);
    const envelope = JSON.parse(text);
    assert.ok(text.length <= 40000);
    assert.equal(envelope.结果.总响应字符, text.length);
    assert.equal(JSON.stringify(result), original, '包装边界不能修改领域对象');
  }));
});

async function withHost(run) {
  const home = await mkdtemp(join(tmpdir(), 'mind-memory-host-'));
  const host = fakeHost();
  try {
    await kernel.apply(host.ctx, { home, factoryRoot: fileURLToPath(new URL('../mind', import.meta.url)), privateRoot: join(home, 'mind-private') });
    await run(host, fakeExec({ name: 'mind' }));
  } finally {
    host.清理();
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
  }
}

describe('装载后的记忆工具与命令', () => {
  it('工具默认摘要；显式id全文仍能按原权限读正文', async () => withHost(async (host, exec) => {
    const tool = host.工具.get('mind');
    const 内容 = `hostmemory ${'宿主工具长文'.repeat(200)}`;
    const written = JSON.parse(await tool.execute({ action: 'memory_write', 类: '偏好', 内容, 来源: '宿主读面测试' }, exec));
    assert.equal(written.成功, true);
    const summaryText = await tool.execute({ action: 'memory_query', 文本: 'hostmemory' }, exec);
    const summary = JSON.parse(summaryText);
    assert.equal(summary.成功, true);
    assert.equal(summary.结果.返回模式, '摘要');
    assert.equal(summary.结果.条目.length, 1);
    assert.ok(!('内容' in summary.结果.条目[0]));
    const detail = JSON.parse(await tool.execute({ action: 'memory_query', id: summary.结果.条目[0].id, 返回模式: '全文' }, exec));
    assert.equal(detail.成功, true);
    assert.equal(detail.结果.条目[0].内容, 内容);
    bounded(summary.结果, 12000, summaryText.length);
  }));

  it('命令数字分页可用，数字外观正文保持字符串', async () => withHost(async (host, exec) => {
    const command = host.命令.get('mind');
    const run = async (rawInput) => JSON.parse((await command.handler({ agent: exec.agent, rawInput })).text);
    for (let i = 0; i < 3; i += 1) {
      const result = await run(`memory_write 类=偏好 内容=commandpaging${i} 来源=宿主测试`);
      assert.equal(result.成功, true);
    }
    const first = await run('memory_query 类=偏好 limit=2 条数上限=2 内容预算=12000 偏移=0');
    assert.equal(first.成功, true);
    assert.equal(first.结果.条数上限, 2);
    assert.equal(first.结果.偏移, 0);
    const next = await run(`memory_query 类=偏好 条数上限=2 偏移=2 数据版本=${first.结果.数据版本}`);
    assert.equal(next.成功, true);
    assert.equal(next.结果.条目.length, 1);
    assert.equal(next.结果.偏移, 2);
    const numeric = await run('memory_write 类=偏好 内容=0007 来源=宿主测试');
    assert.equal(numeric.成功, true);
    const all = await run('memory_query 类=偏好 返回模式=全文');
    assert.ok(all.结果.条目.some((e) => e.内容 === '0007'), '数字外观正文不能被读面参数转换误伤');
  }));

  it('工具与命令实际JSON文本含包装与缩进仍不超过40000字符', async () => withHost(async (host, exec) => {
    const tool = host.工具.get('mind');
    const command = host.命令.get('mind');
    const 内容 = `needle ${'x'.repeat(40000)}`;
    const written = JSON.parse(await tool.execute({ action: 'memory_write', 类: '偏好', 内容, 来源: '完整序列化预算' }, exec));
    assert.equal(written.成功, true);
    const query = `needle${'\u0000'.repeat(2000)}`;
    const text = await tool.execute({ action: 'memory_query', 文本: query, 返回模式: '全文', 内容预算: 32000 }, exec);
    const result = JSON.parse(text);
    assert.equal(result.成功, true);
    assert.ok(text.length <= 40000, `真实工具返回${text.length}`);
    assert.equal(result.结果.总响应字符, text.length);
    const reply = await command.handler({ agent: exec.agent, rawInput: `memory_query 文本=${query} 返回模式=全文 内容预算=32000` });
    const viaCommand = JSON.parse(reply.text);
    assert.equal(viaCommand.成功, true);
    assert.ok(reply.text.length <= 40000, `真实命令返回${reply.text.length}`);
    assert.equal(viaCommand.结果.总响应字符, reply.text.length);
  }));
});
