/**
 * 契约A（完整血缘，评审稿 §C2/§C8，2026-10-09 主人裁决方案②）+ 契约C 两个补强骑手。
 *
 * 契约A：记忆条目行新增 来源引用（证据链，写入时存在性校验 fail-closed）与
 *  派生自（推翻替换链，overturn 自动写）；血缘索引纯投影（buildLineageIndex /
 *  lineageClosure，闭包 ≤3 层、环安全）；lineage(id) 只读面（契约B 同款闸+汇总审计）；
 *  purge 三步化（待删除状态行 + 下游隔离 + 物理抹 + 审计含隔离清单），fold 支持
 *  「待删除/隔离」两态（退出默认召回、粘性、含失效可拉回、口径报隔离条目数）。
 * 骑手①：披露命中被拒也入审计（「披露拦截」，记汇总，不抄原文）。
 * 骑手②：部署.json 披露敏感模式=[] 显式关闭——合法但必须响亮留痕（告警档，
 *  状态迁移触发，持续关闭不刷屏）。
 *
 * 塞 bug 校准（先红后绿）见提交说明：短路存在性校验 / 跳过隔离行追加 /
 * 删掉空清单告警，本文件对应断言必须红。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeFixture, SOVEREIGN, LEAD, writeUnder } from './helpers.mjs';
import { MemoryService, buildLineageIndex, lineageClosure } from '../src/memory.js';
import { runAction } from '../lib/actions.js';
import { GRADE } from '../src/audit.js';
import { appendLines } from '../src/kernel/fsx.js';

const 部署偏好 = '集体L2-共享基础设施/defaults/部署.json';
const 任务图账 = '集体L2-共享基础设施/任务图/default/tasks.jsonl';

/** @type {Awaited<ReturnType<typeof makeFixture>>} */
let f;
/** @type {MemoryService} */ let memory;

/** 手写一条最小合规的旧式知识条目行（无 来源引用/派生自 字段——测向后兼容与环）。 */
function 旧行(id, extra = {}) {
  return {
    id,
    类: '知识',
    标题: `旧式 ${id}`,
    内容: `旧式条目正文 ${id}`,
    来源: { 谁: 'test', 怎么知道: '手写夹具' },
    归属: 'default',
    项目: 'default',
    状态: '有效',
    记于: new Date().toISOString(),
    ...extra,
  };
}

describe('契约A · 完整血缘（2026-10-09 方案②）', () => {
  before(async () => {
    f = await makeFixture();
    memory = new MemoryService({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
    // 一条真实任务事件行（task- 前缀引用的存在性校验面是任务图事件流）。
    await writeUnder(f.privateRoot, 任务图账, `${JSON.stringify({ seq: 1, at: new Date().toISOString(), by: { id: 'lead', kind: 'Lead' }, id: 'task-lin-1', kind: 'created' })}\n`);
  });
  after(async () => {
    await f.cleanup();
  });

  it('来源引用存在性校验 fail-closed：悬空记忆/悬空任务/未知前缀都拒，artifact- 本批放行', async () => {
    await assert.rejects(
      () => memory.remember({ subject: LEAD, 类: '知识', 内容: '引用不存在的记忆', 来源: '测试', 项目: 'default', 来源引用: ['know-ghost-xyz'] }),
      (e) => e.name === 'InvalidBody' && /悬空引用/.test(e.message) && /账本/.test(e.message),
      'know- 前缀必须能在账本 fold 到',
    );
    await assert.rejects(
      () => memory.remember({ subject: LEAD, 类: '知识', 内容: '引用不存在的任务', 来源: '测试', 项目: 'default', 来源引用: ['task-ghost-1'] }),
      (e) => e.name === 'InvalidBody' && /悬空引用/.test(e.message) && /任务图/.test(e.message),
      'task- 前缀必须查任务图',
    );
    await assert.rejects(
      () => memory.remember({ subject: LEAD, 类: '知识', 内容: '未知前缀', 来源: '测试', 项目: 'default', 来源引用: ['rule-xxx'] }),
      (e) => e.name === 'InvalidBody' && /无法校验的引用/.test(e.message),
      '无法校验的引用等于悬空引用（fail-closed）',
    );
    const art = await memory.remember({ subject: LEAD, 类: '知识', 内容: '引用产物（本批不校验）', 来源: '测试', 项目: 'default', 来源引用: ['artifact-any-1'] });
    assert.ok(art.id.startsWith('know-'));
    const taskRef = await memory.remember({ subject: LEAD, 类: '知识', 内容: '引用真实任务', 来源: '测试', 项目: 'default', 来源引用: ['task-lin-1'] });
    assert.ok(taskRef.id, 'task- 命中任务图事件流即放行');
    const knowRef = await memory.remember({ subject: LEAD, 类: '知识', 内容: '引用真实记忆', 来源: '测试', 项目: 'default', 来源引用: [art.id] });
    assert.ok(knowRef.id, 'know- 命中账本即放行');
  });

  it('overturn 自动写 派生自：新条目记被推翻者 id（调用方不传）', async () => {
    const base = await memory.remember({ subject: LEAD, 类: '知识', 内容: '旧说法将被推翻', 来源: '测试', 项目: 'default', 来源引用: ['task-lin-1'] });
    const t = await memory.overturn(base.id, { subject: LEAD, 新条目: '取代旧说法的新结论', 理由: '有新证据' });
    const 新 = (await memory.query({ subject: LEAD, 类: ['知识'], 项目: 'default', 含失效: true })).条目.find((x) => x.id === t.新条目);
    assert.ok(新, '新条目要能 fold 到');
    assert.equal(新.派生自, base.id, '派生自=被推翻者 id，由 overturn 自动写');
    assert.deepEqual(新.来源引用, ['task-lin-1'], 'overturn 继承被推翻者的证据链（来源引用）');
  });

  it('建链 A←B(引用)←C(派生自)：purge A ⇒ B/C 隔离、退出默认召回、含失效可拉回、审计含隔离清单', async () => {
    const A = await memory.remember({ subject: LEAD, 类: '知识', 内容: '链头知识即将被物理删除', 来源: '测试', 项目: 'default' });
    const B = await memory.remember({ subject: LEAD, 类: '知识', 内容: '链中知识引用了链头', 来源: '测试', 项目: 'default', 来源引用: [A.id] });
    const t = await memory.overturn(B.id, { subject: LEAD, 新条目: '链尾知识取代链中', 理由: '更新' });
    const C = t.新条目; // 字符串 id（overturn 返回 {新条目: created.id}）

    const purged = await memory.purge(A.id, { subject: LEAD, 理由: '链头是敏感数据', 敏感: true });
    assert.ok(purged.下游隔离.includes(B.id), `B（引用 A）必须隔离，实际 ${JSON.stringify(purged.下游隔离)}`);
    assert.ok(purged.下游隔离.includes(C), 'C（派生自 B）必须隔离（传递第 2 层）');

    // 默认召回：B/C 退出；条目里仍在（供追溯）；含失效拉回。
    const 默认 = await memory.query({ subject: LEAD, 类: ['知识'], 项目: 'default' });
    const bView = 默认.条目.find((x) => x.id === B.id);
    const cView = 默认.条目.find((x) => x.id === C);
    assert.equal(bView?.状态, '已隔离', '隔离判据粘性：后来状态不许覆盖（B 先被推翻再被隔离，最终已隔离）');
    assert.equal(cView?.状态, '已隔离');
    assert.ok(!默认.条目.some((x) => x.id === A.id), '源条目行已物理抹掉，fold 不到');
    const 拉回 = await memory.query({ subject: LEAD, 类: ['知识'], 项目: 'default', 含失效: true });
    assert.ok(拉回.条目.some((x) => x.id === B.id) && 拉回.条目.some((x) => x.id === C), '含失效: true 要能拉回被隔离条目');

    // 口径：隔离条目数 单独报；说明给拉回办法。
    assert.equal(默认.口径.隔离条目数, 2, '隔离条目数如时报（B+C；源 A 已抹不计）');
    assert.match(默认.说明 ?? '', /血缘隔离/, '说明要点名血缘隔离');
    assert.match(默认.说明 ?? '', /含失效: true/, '说明要给拉回办法');

    // 账本字节：源条目行真没了；待删除状态行留痕；下游条目行不动（隔离≠删除）。
    const text = await readFile(f.layout.memoryLog('default', '知识'), 'utf8');
    assert.ok(!text.includes('链头知识即将被物理删除'), '源内容必须真的不在账本里');
    assert.match(text, /"追加":"待删除"/, '源对象留一条待删除状态行');
    assert.match(text, /"追加":"隔离"/, '下游留隔离状态行');
    assert.ok(text.includes(B.id) && text.includes(C), '下游条目行字节不动（隔离是追加状态，不是删除）');

    // 审计：不可逆操作带 下游隔离 清单。
    const 不可逆 = (await f.audit.read({})).filter((r) => r.动作 === '不可逆操作' && r.对象?.id === A.id).at(-1);
    assert.ok(不可逆, '不可逆操作审计仍在');
    assert.deepEqual([...不可逆.详情.下游隔离].sort(), [B.id, C].sort(), '审计详情含下游隔离清单');
  });

  it('闭包深度上限 3：第 4 层不隔离、仍可召回；lineage 深度读数如实报截断', async () => {
    const A = await memory.remember({ subject: LEAD, 类: '知识', 内容: '深链源头', 来源: '测试', 项目: 'default' });
    const b1 = await memory.remember({ subject: LEAD, 类: '知识', 内容: '深链第一层', 来源: '测试', 项目: 'default', 来源引用: [A.id] });
    const b2 = await memory.remember({ subject: LEAD, 类: '知识', 内容: '深链第二层', 来源: '测试', 项目: 'default', 来源引用: [b1.id] });
    const b3 = await memory.remember({ subject: LEAD, 类: '知识', 内容: '深链第三层', 来源: '测试', 项目: 'default', 来源引用: [b2.id] });
    const b4 = await memory.remember({ subject: LEAD, 类: '知识', 内容: '深链第四层', 来源: '测试', 项目: 'default', 来源引用: [b3.id] });

    const lin = await memory.lineage({ subject: LEAD, id: A.id });
    assert.ok(lin.下游.some((x) => x.id === b3.id), '第 3 层在闭包内');
    assert.ok(!lin.下游.some((x) => x.id === b4.id), '第 4 层超出深度上限');
    assert.equal(lin.深度读数.下游截断, true, '第 3 层还有下游 ⇒ 截断必须如实报');
    assert.equal(lin.深度读数.深度上限, 3);

    const purged = await memory.purge(A.id, { subject: LEAD, 理由: '深链源是敏感数据', 敏感: true });
    assert.deepEqual([...purged.下游隔离].sort(), [b1.id, b2.id, b3.id].sort(), 'purge 阻断同样 ≤3 层');
    assert.ok(!purged.下游隔离.includes(b4.id));
    const q = await memory.query({ subject: LEAD, 类: ['知识'], 项目: 'default', 含失效: true });
    assert.notEqual(q.条目.find((x) => x.id === b4.id)?.状态, '已隔离', '第 4 层不受波及');
  });

  it('环安全：环形账本（手写行绕过写入校验）lineage 返回不挂起，两侧都能到达', async () => {
    const 账本 = f.layout.memoryLog('default', '知识');
    await appendLines(账本, [旧行('know-loop-a', { 来源引用: ['know-loop-b'] }), 旧行('know-loop-b', { 来源引用: ['know-loop-a'] })]);
    // 纯函数级：建图 + 闭包在环上终止。
    const { readFile: rf } = await import('node:fs/promises');
    const rows = (await rf(账本, 'utf8')).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    const index = buildLineageIndex(rows);
    const closure = lineageClosure(index, 'know-loop-a');
    assert.ok(closure.上游.some((x) => x.id === 'know-loop-b'));
    assert.ok(closure.下游.some((x) => x.id === 'know-loop-b'));
    assert.ok(closure.深度读数.走过节点数 > 0);
    // 服务级：扫真账本的同一路径也不挂起（超时即红）。
    const lin = await memory.lineage({ subject: LEAD, id: 'know-loop-a' });
    assert.equal(lin.id, 'know-loop-a');
  });

  it('旧数据（无血缘字段）purge 行为不回归：下游隔离为空、物理抹与审计照旧', async () => {
    await appendLines(f.layout.memoryLog('default', '知识'), [旧行('know-legacy-1')]);
    const purged = await memory.purge('know-legacy-1', { subject: LEAD, 理由: '旧数据里的敏感内容', 敏感: true });
    assert.equal(purged.已删除, true);
    assert.deepEqual(purged.下游隔离, [], '旧行没有血缘字段 ⇒ 下游闭包为空');
    const text = await readFile(f.layout.memoryLog('default', '知识'), 'utf8');
    assert.ok(!text.includes('旧式条目正文 know-legacy-1'), '源内容照旧物理抹掉');
    assert.ok((await f.audit.read({})).some((r) => r.动作 === '不可逆操作' && r.对象?.id === 'know-legacy-1'), '不可逆审计照旧');
  });

  it('lineage 读面过闸（契约B 同款）：无主体拒、放行记一条汇总审计、工具面透传主体', async () => {
    const base = await memory.remember({ subject: LEAD, 类: '知识', 内容: '血缘读面演示', 来源: '测试', 项目: 'default' });
    await assert.rejects(
      () => memory.lineage({ id: base.id }),
      (e) => e.name === 'Denied' && /未知主体/.test(e.message),
      '血缘查询也要主体（fail-closed）',
    );
    await assert.rejects(
      () => memory.lineage({ subject: LEAD, id: 'know-不存在' }),
      (e) => e.name === 'InvalidBody' && /没有这条记忆/.test(e.message),
      '查不存在的 id 响亮拒',
    );
    const before = (await f.audit.read({})).length;
    const lin = await memory.lineage({ subject: LEAD, id: base.id });
    assert.equal(lin.id, base.id);
    assert.deepEqual(lin.上游, []);
    const rows = (await f.audit.read({})).slice(before).filter((r) => r.动作 === '只读服务调用');
    assert.equal(rows.length, 1, '一次调用一条');
    assert.equal(rows[0].详情?.服务, 'memory.lineage');
    assert.equal(rows[0].档位, GRADE.记汇总);

    // 工具面：memory_lineage 把 runAction 主体链主体传进服务。
    let 收到 = null;
    const org = { registry: { identity: async () => ({ members: {} }) }, memory: { lineage: async (s) => { 收到 = s; return { id: s.id }; } } };
    await runAction({ org, 项目: 'default', subject: { id: 'lead', kind: 'Lead' }, args: { action: 'memory_lineage', id: base.id } });
    assert.equal(收到.subject.kind, 'Lead');
    assert.equal(收到.id, base.id);
    await assert.rejects(
      () => runAction({ org, 项目: 'default', subject: { id: 'lead', kind: 'Lead' }, args: { action: 'memory_lineage' } }),
      (e) => e.name === 'InvalidBody' && /id/.test(e.message),
      '缺 id 结构性拒',
    );
  });

  it('promote 副本经 spread 继承 来源引用 与 派生自（钉住：晋升不丢血缘）', async () => {
    const base = await memory.remember({ subject: LEAD, 类: '知识', 内容: '待晋升的带血缘知识', 来源: '测试', 项目: 'default', 来源引用: ['task-lin-1'] });
    const t = await memory.overturn(base.id, { subject: LEAD, 新条目: '晋升的是推翻链的新条目', 理由: '更新' });
    await memory.promoteCrossProject(t.新条目, { subject: LEAD, 岗位: '插件工程', 理由: '跨项目可复用' });
    const 视图 = (await memory.query({ subject: LEAD, 类: ['知识'], 项目: 'default', 含失效: true })).条目.find((x) => x.id === t.新条目);
    assert.equal(视图.岗位, '插件工程', '前提：晋升副本生效');
    assert.deepEqual(视图.来源引用, ['task-lin-1'], '晋升副本继承 来源引用');
    assert.equal(视图.派生自, base.id, '晋升副本继承 派生自');
  });
});

describe('契约C 补强 · 骑手①②（2026-10-09）', () => {
  before(async () => {
    f = await makeFixture();
    memory = new MemoryService({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
  });
  after(async () => {
    await f.cleanup();
  });

  it('骑手①：披露命中被拒也入审计——「披露拦截」一条（记汇总，不抄敏感原文）', async () => {
    const entry = await memory.remember({ subject: LEAD, 类: '知识', 内容: '联系人写的是拦截演示 ops@example.com', 来源: '测试', 项目: 'default' });
    await assert.rejects(() => memory.promoteCrossProject(entry.id, { subject: LEAD, 岗位: '插件工程', 理由: 'x' }), (e) => e.name === 'Denied');
    const 拦截 = (await f.audit.read({})).filter((r) => r.动作 === '披露拦截' && r.对象?.id === entry.id);
    assert.equal(拦截.length, 1, '命中未豁免：恰好一条披露拦截');
    assert.deepEqual(拦截[0].详情?.命中模式, ['email']);
    assert.equal(拦截[0].详情?.拒绝类型, '命中未豁免');
    assert.equal(拦截[0].档位, GRADE.记汇总, '按裁决记汇总');
    assert.ok(!JSON.stringify(拦截).includes('ops@example.com'), '不抄敏感原文（只记模式名）');

    // 豁免越权路径同样入账（主权者带豁免参数被拒）。
    const e2 = await memory.remember({ subject: SOVEREIGN, 类: '知识', 内容: '越权豁免演示含 secret', 来源: '测试', 项目: 'default' });
    await assert.rejects(() => memory.promoteCrossProject(e2.id, { subject: SOVEREIGN, 岗位: '插件工程', 理由: 'x', 披露豁免: true }), (e) => e.name === 'Denied' && /豁免/.test(e.rule));
    const 越权 = (await f.audit.read({})).filter((r) => r.动作 === '披露拦截' && r.对象?.id === e2.id);
    assert.equal(越权.length, 1, '豁免越权：恰好一条披露拦截');
    assert.equal(越权[0].详情?.拒绝类型, '豁免越权');
    assert.ok(!JSON.stringify(越权).includes('secret'), '越权记录同样不抄原文');
  });

  it('骑手②：空清单=显式关闭——合法且生效，但必须响亮留痕（告警档、状态迁移触发）', async () => {
    const g = await makeFixture({ privateFiles: { [部署偏好]: JSON.stringify({ 披露敏感模式: [] }) } });
    try {
      const 关闭记录 = async () => (await g.audit.read({})).filter((r) => r.动作 === '披露机械检查已显式关闭');
      // makeFixture 构造时已 reload 过一次：首次加载即空 ⇒ 已有一条。
      let rows = await 关闭记录();
      assert.equal(rows.length, 1, '空清单必须留痕，不许静默关闭');
      assert.equal(rows[0].告警, true, '告警档');
      assert.equal(rows[0].档位, GRADE.全记);

      // 持续关闭：再 reload 不刷屏。
      await g.policy.reload();
      assert.equal((await 关闭记录()).length, 1, '同一状态反复 reload 不重复喊');

      // 恢复非空 ⇒ 标志复位；再关 ⇒ 再喊一次。
      await writeUnder(g.privateRoot, 部署偏好, JSON.stringify({ 披露敏感模式: [{ 名: '内部词', 正则: '内部词\\d+' }] }));
      await g.policy.reload();
      assert.equal((await 关闭记录()).length, 1, '恢复非空不加记录');
      await writeUnder(g.privateRoot, 部署偏好, JSON.stringify({ 披露敏感模式: [] }));
      await g.policy.reload();
      assert.equal((await 关闭记录()).length, 2, '再次关闭要再喊一次（状态迁移）');

      // 显式关闭确实生效：机械检查不拦任何模式。
      const m = new MemoryService({ layout: g.layout, policy: g.policy, audit: g.audit, clock: g.clock });
      const e = await m.remember({ subject: LEAD, 类: '知识', 内容: '关闭态下含 C:\\path 与 password', 来源: '测试', 项目: 'default' });
      assert.equal((await m.promoteCrossProject(e.id, { subject: LEAD, 岗位: '插件工程', 理由: 'x' })).岗位, '插件工程', '空清单 = 主权者显式关闭，不拦任何模式');
    } finally {
      await g.cleanup();
    }
  });
});
