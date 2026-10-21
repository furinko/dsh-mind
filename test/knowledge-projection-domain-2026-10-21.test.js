/** 同源逐事件投影与一次性反馈索引；不以时间阈值代替安全/工作量断言。 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fold } from '../src/tasks.js';
import { createKnowledgeFeedbackResolver, resolveKnowledgeFeedback, knowledgeFeedbackFingerprint } from '../src/knowledge-feedback.js';
import { Denied } from '../src/kernel/errors.js';

const P = 'knowledge-projection';
const A = 'task-prefix-a';
const B = 'task-prefix-b';
const actor = { id: 'member-a', kind: '成员' };
const lead = { id: 'lead', kind: 'Lead' };
const PRIVATE = 'PRIVATE_DECLARATION_MUST_NOT_LEAVE_PROOF';
const manifest = suffix => ({ 摘要: suffix.repeat(64) });
const item = (id = 'know-prefix', 使用结果 = '发现问题') => ({ id, 用途: '边界核对', 适用判断: PRIVATE, 使用结果, 来源: { 状态: '来源未核验' } });
const adoption = (items = [item()]) => ({ 版本: 1, 声明状态: items.length ? '已声明' : '显式空', 条目: items });
const submit = (id, seq, generation, items = [item()]) => ({ id, kind: 'submitted', seq, 代: generation, by: actor, 采用知识: adoption(items), 交付物清单: manifest('a'), 结论: '真实交付待核对' });

function richRows() {
  return [
    { id: A, kind: 'created', seq: 1, 负责人: actor.id },
    { id: B, kind: 'created' },
    submit(A, 3, 1),
    { id: A, kind: 'reviewed', 代: 1, 三态: '过', 复核者: lead.id, by: lead, 交付物摘要: 'a'.repeat(64) },
    { id: A, kind: 'artifact', seq: 5, 复核读根: true, 产出物: 'review-root' },
    { id: A, kind: 'accepted', seq: 6, 代: 1, 依据: '复核结论', 票: 'rv-4', by: lead, 交付物摘要: 'a'.repeat(64) },
    { id: A, kind: 'pending', seq: 7 },
    { id: A, kind: 'resolved', seq: 8, 状态: '已交卷' },
    { ...submit(A, 9, 1), 交付物清单: manifest('b') },
    { id: A, kind: 'reviewed', seq: 10, 代: 1, 三态: '未验', 状态: '未验', by: lead, 交付物摘要: 'b'.repeat(64) },
    { id: A, kind: 'reviewed', seq: 11, 代: 1, 三态: '过', by: lead, 交付物摘要: 'b'.repeat(64) },
    { id: A, kind: 'rejected', seq: 12 }, // 未验不关闭代。
    { id: A, kind: 'reviewed', seq: 13, 代: 1, 三态: '不过', 状态: '已打回', by: lead, 交付物摘要: 'b'.repeat(64) },
    { id: A, kind: 'rejected', seq: 14 },
    { id: A, kind: 'started', seq: 15 },
    { ...submit(A, 16, 2), 交付物清单: manifest('c') },
    { id: A, kind: 'review_exempted', seq: 17, 代: 2, by: lead },
    { id: A, kind: 'accepted', seq: 18, 代: 2, 依据: '复核免审', 票: null, 豁免: 'ex-17', by: lead, 交付物摘要: 'c'.repeat(64) },
    { id: A, kind: 'closed', seq: 19 },
    { ...submit(B, 20, 1), 交付物清单: null },
    { id: B, kind: 'reviewed', 代: 1, 三态: '过', by: lead },
    { id: B, kind: 'artifact', seq: 22, 产出物: 'new-delivery' },
    { id: 'task-successor', kind: 'created', seq: 23, 前序任务: A, 负责人: actor.id },
  ];
}

describe('任务前缀visitor与批反馈索引', () => {
  it('逐事件before/after与各独立前缀fold完全一致，默认返回不变且旧票保持全局位置', () => {
    const rows = richRows();
    const original = structuredClone(rows);
    const frames = [];
    const observed = fold(rows, ({ row, index, before, after }) => {
      assert.equal(row, rows[index]);
      assert.deepEqual(before, fold(rows.slice(0, index)).get(row.id) ?? null, `before ${index}`);
      assert.deepEqual(after, fold(rows.slice(0, index + 1)).get(row.id), `after ${index}`);
      frames.push({ index, before, after });
    });
    assert.equal(frames.length, rows.length);
    assert.deepEqual(observed, fold(rows));
    assert.deepEqual(rows, original, '读取不改原始事件');
    assert.equal(frames[3].after.待采纳.票, 'rv-4', '旧缺seq票按全局位置，不能按单任务重排');
    assert.equal(frames[4].after.待采纳.票, 'rv-4', '复核读根不使交付票失效');
    assert.equal(frames[8].after.待采纳, undefined, '新交卷使旧票失效');
    assert.equal(frames[11].after.代, 1, '未验状态的rejected不关代');
    assert.equal(frames[13].before.代, 1);
    assert.equal(frames[13].after.代, 2);
    assert.match(frames[20].after.交付物待补证, /未绑定交卷内容清单/);
    assert.equal(frames[18].after.后继任务, undefined, '先前浅投影不被后来新字段反写');
    assert.equal(observed.get(A).后继任务, 'task-successor');
  });

  it('一个scan同时交付采纳前后事实和反馈解析，返工不洗掉旧本代反馈', () => {
    const rows = richRows();
    const accepted = [];
    let visits = 0;
    const index = createKnowledgeFeedbackResolver({ rows, 项目: P, visit: frame => {
      visits++;
      if (frame.row.kind === 'accepted') accepted.push({ before: frame.before, after: frame.after });
    } });
    assert.equal(visits, rows.length);
    assert.equal(accepted[0].before.待采纳.票, 'rv-4');
    assert.equal(accepted[0].after.采纳.票, 'rv-4');
    assert.equal(accepted[1].before.复核豁免.票, 'ex-17');
    assert.equal(index.nodes.get(A).代, 2);
    const reference = { 任务: A, 提交序: 3, 知识id: 'know-prefix' };
    const proof = index.resolve(reference);
    assert.deepEqual(proof, { 版本: 1, 指纹: knowledgeFeedbackFingerprint({ 项目: P, ...reference, 事件: rows[2], 条目: rows[2].采用知识.条目[0] }) });
    assert.deepEqual(resolveKnowledgeFeedback({ rows, 项目: P, ...reference }), proof, '公共单笔入口保持同一见证合同');
    assert.deepEqual(Object.keys(proof), ['版本', '指纹']);
    assert.equal(JSON.stringify(proof).includes(PRIVATE), false);
  });

  it('全账seq碰撞包括别的任务/非submitted/忽略行，不接受调用方伪前缀修复坏代', () => {
    const rows = [{ id: A, kind: 'created', seq: 1 }, submit(A, 2, 1)];
    const ref = { 任务: A, 提交序: 2, 知识id: 'know-prefix' };
    for (const collision of [{ id: B, kind: 'created', seq: 2 }, { seq: 2 }]) {
      const source = [...rows, collision];
      let seen = 0;
      const index = createKnowledgeFeedbackResolver({ rows: source, 项目: P, visit: () => { seen++; } });
      assert.equal(seen, source.length, '全局计数不先过滤kind或task');
      assert.throws(() => index.resolve(ref), Denied);
      assert.throws(() => resolveKnowledgeFeedback({ rows: source, 项目: P, ...ref }), Denied);
    }
    const bad = structuredClone(rows);
    bad[1].代 = 2;
    const badIndex = createKnowledgeFeedbackResolver({ rows: bad, 项目: P });
    badIndex.nodes.get(A).代 = 2;
    assert.throws(() => badIndex.resolve({ ...ref, before: { 代: 2 }, 前缀代: 2 }), Denied, '公开方法不能用自报prefix替代原事件前代');
    assert.throws(() => resolveKnowledgeFeedback({ rows: bad, 项目: P, ...ref, before: { 代: 2 } }), Denied);
  });

  it('legacy位置序号不计为显式seq，后来同值真实seq只能定位后来原事件', () => {
    const rows = [{ id: A, kind: 'created', seq: 1 }, submit(A, undefined, 1), { id: A, kind: 'reviewed', seq: 3, 代: 1, 三态: '不过', 状态: '已打回' }, { id: A, kind: 'rejected', seq: 4 }, { id: A, kind: 'started', seq: 5 }, submit(A, 2, 2)];
    delete rows[1].seq;
    rows[5].采用知识.条目[0].适用判断 = '后来实际提交';
    const seen = [];
    const index = createKnowledgeFeedbackResolver({ rows, 项目: P, visit: frame => { if (frame.row.kind === 'submitted') seen.push({ index: frame.index, explicit: frame.row.seq }); } });
    assert.deepEqual(seen, [{ index: 1, explicit: undefined }, { index: 5, explicit: 2 }]);
    const reference = { 任务: A, 提交序: 2, 知识id: 'know-prefix' };
    const proof = index.resolve(reference);
    assert.equal(proof.指纹, knowledgeFeedbackFingerprint({ 项目: P, ...reference, 事件: rows[5], 条目: rows[5].采用知识.条目[0] }));
    assert.notEqual(proof.指纹, knowledgeFeedbackFingerprint({ 项目: P, ...reference, 事件: rows[1], 条目: rows[1].采用知识.条目[0] }));
    assert.throws(() => createKnowledgeFeedbackResolver({ rows: rows.slice(0, 5), 项目: P }).resolve(reference), Denied, '无真实seq时不能回退行号');
  });

  it('批索引捕获摘要而不保留可变声明，修改返回proof或当前node不能伪造前缀', () => {
    const rows = [{ id: A, kind: 'created', seq: 1 }, submit(A, 2, 1)];
    const ref = { 任务: A, 提交序: 2, 知识id: 'know-prefix' };
    const index = createKnowledgeFeedbackResolver({ rows, 项目: P });
    const proof = index.resolve(ref);
    const expected = structuredClone(proof);
    rows[1].采用知识.条目[0].使用结果 = '有帮助';
    rows[1].采用知识.条目[0].适用判断 = '后来修改原文';
    proof.指纹 = 'forged';
    index.nodes.get(A).代 = 99;
    assert.deepEqual(index.resolve(ref), expected, '索引是当次快照，调用方变更不重签原见证');
    assert.throws(() => resolveKnowledgeFeedback({ rows, 项目: P, ...ref }), Denied, '直接公共入口仍以本次完整原文重核');
  });

  it('4000行/32000负条目仅建一次索引，所有resolve不再读取或遍历原行', () => {
    const rows = [];
    const references = [];
    let seqReads = 0;
    let idReads = 0;
    const instrument = row => {
      const id = row.id; const seq = row.seq;
      Object.defineProperty(row, 'id', { enumerable: true, get() { idReads++; return id; } });
      Object.defineProperty(row, 'seq', { enumerable: true, get() { seqReads++; return seq; } });
      return row;
    };
    for (let i = 0; i < 2000; i++) {
      const task = `task-scale-${i}`;
      rows.push(instrument({ id: task, kind: 'created', seq: rows.length + 1 }));
      const seq = rows.length + 1;
      const items = Array.from({ length: 16 }, (_, n) => item(`know-scale-${n}`));
      rows.push(instrument(submit(task, seq, 1, items)));
      for (const declaration of items) references.push({ 任务: task, 提交序: seq, 知识id: declaration.id });
    }
    let visits = 0;
    const index = createKnowledgeFeedbackResolver({ rows, 项目: P, visit: () => { visits++; } });
    assert.equal(visits, 4000);
    assert.equal(index.nodes.size, 2000);
    assert.equal(references.length, 32000);
    const builtReads = { seqReads, idReads };
    for (const ref of references) assert.match(index.resolve(ref).指纹, /^[a-f0-9]{64}$/);
    assert.deepEqual({ seqReads, idReads }, builtReads, '批量resolve不再map/filter/fold任何原行');
    assert.equal(visits, rows.length);
  });
});
