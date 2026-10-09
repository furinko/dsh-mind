/**
 * W3 批2 · 口径与静默失效（2026-10-09）——十一条修复的**塞 bug 校准**测试。
 *
 * 这一批的病名是「静默」：错的口径照常给读数、坏的输入照常放行、被砍掉的账尾
 * 照常自洽、未交齐的答案照常投影真名。所以每条断言都钉在**可观察的读数**上，
 * 并且逐条按「把实现故意改坏 → 必红」校准过（红绿读数见提交说明）：
 *  ① audit.verify 读 anchor ⇒ 砍掉月尾必须被发现（链内自洽 ≠ 没被截断）
 *  ② audit.read 排序键 (月, seq) ⇒ 跨月不许按 seq 全局交错
 *  ③ BM25 的 dl 与 tf 同字段集（索引期预存）⇒ 标签多不再压低分母
 *  ④ tags：CRLF 照常解析；行内注释不许切进引号
 *  ⑤ 探针声明坏 JSON ⇒ 折成「问题」+ 见红，run 仍落快照与审计
 *  ⑥ registry.assign：封存实例拒（指 restore）；在岗同岗位幂等（不写盘、不重置代数）
 *  ⑦ time：now 解析不出 ⇒ 按最严判失联（不许 fail-open），且永不抛
 *  ⑧ ids.js 注释改实（不许再写「从目录名重建」「同一秒内不撞」）
 *  ⑨ store：rollback 的 authority 取自被回滚版本；文件名与 meta.id 不一致响亮拒
 *  ⑩ workbench：未交齐答案行只给盲标（真名与结论都不出）
 *  ⑪ memory：检索候选数与账本条目数分开报；stats 跨账合并 fold 不双计数
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appendLines, readJsonl } from '../src/kernel/fsx.js';
import { evaluateSovereignPresence } from '../src/kernel/time.js';
import { tokenize } from '../src/kernel/text.js';
import { parseDocument, parseSimpleYaml, formatFrontMatter } from '../src/tags.js';
import { buildIndex, search, runRegression } from '../src/retrieval.js';
import { AuditLog } from '../src/audit.js';
import { ProbeRunner } from '../src/probes.js';
import { RoleRegistry } from '../src/registry.js';
import { ObjectStore } from '../src/store.js';
import { MemoryService } from '../src/memory.js';
import { projectWorkbench } from '../src/workbench.js';
import { InvalidBody, Denied } from '../src/kernel/errors.js';
import { makeFixture, LEAD, SOVEREIGN, writeUnder } from './helpers.mjs';

const 本月 = () => new Date().toISOString().slice(0, 7);

/** 一份合规的能力卡正文（store.write 的 body 不吃 front matter）。 */
const 能力正文 = (标记) => ['# 能力', '', '## 适用岗位', '- 插件工程', '', '## 怎么做', `${标记}：先搜后写。`].join('\n');

/** 一份合规的岗位卡。 */
const 岗位卡 = (id = '插件工程') =>
  ['---', `id: ${id}`, 'kind: 身份', 'authority: 自治', 'zone: 私有', 'domain: 个体', 'version: 1', '---', `# ${id}`, '', '## 个体L0 · 身份', '岗位身份。', '', '## 个体L1 · 规则', '先搜后写。'].join('\n');

/** 每个用例一个干净的双区（这一批测的是读数，串味会让断言失去意义）。 */
async function 造区(options) {
  const f = await makeFixture(options);
  return { f, done: () => f.cleanup() };
}

describe('W3 批2 · 口径与静默失效', () => {
  it('①audit.verify 读 anchor：砍掉月尾的行必须被发现（链内自洽不等于没被截断）', async () => {
    const { f, done } = await 造区();
    try {
      const audit = new AuditLog({ layout: f.layout, clock: f.clock });
      for (let i = 0; i < 4; i += 1) {
        await audit.append({ 动作: '状态变更', 主体: { id: 'lead', kind: 'Lead' }, 对象: 'x', 依据: '测试', 结果: `第 ${i} 条` });
      }
      assert.equal((await audit.verify()).ok, true, '未被动的账必须自检通过');

      const file = f.layout.auditLog(本月());
      const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
      await writeFile(file, `${lines.slice(0, -1).join('\n')}\n`, 'utf8'); // 砍掉最后一行（剩下的链仍自洽）
      const 截断 = await audit.verify();
      assert.equal(截断.ok, false, '尾部被砍必须报出来：这是审计里最值得做的一刀');
      assert.ok(截断.broken.some((b) => b.类型 === '尾部截断'), `broken 要点名「尾部截断」：${JSON.stringify(截断.broken)}`);

      await writeFile(file, `${lines.join('\n')}\n`, 'utf8'); // 还原
      assert.equal((await audit.verify()).ok, true, '还原后必须回到全绿（不是把账判死了）');

      await rm(f.layout.auditAnchor(本月()), { force: true }); // 删锚 = 让截断无从发现
      const 无锚 = await audit.verify();
      assert.ok(无锚.broken.some((b) => b.类型 === '锚缺失'), '有账却无锚按最严报出来（§12.2 查不到 = 最严）');
    } finally {
      await done();
    }
  });

  it('②audit.read 排序键是 (月, seq)：跨月不许按 seq 全局交错', async () => {
    const { f, done } = await 造区();
    try {
      const audit = new AuditLog({ layout: f.layout, clock: f.clock });
      const 行 = (seq, 结果) => ({ seq, 时间: `2026-0${seq}-01T00:00:00Z`, 主体: { id: 'x', kind: 'Lead' }, 动作: '状态变更', 对象: { id: 'y', kind: '账目' }, 依据: '测试', 结果, 档位: '全记', prev: null, hash: 'h' });
      for (const r of [行(1, '一月-1'), 行(2, '一月-2'), 行(3, '一月-3')]) await appendLines(f.layout.auditLog('2026-01'), [r]);
      for (const r of [行(1, '二月-1'), 行(2, '二月-2')]) await appendLines(f.layout.auditLog('2026-02'), [r]);

      const rows = await audit.read({ months: ['2026-01', '2026-02'] });
      assert.deepEqual(
        rows.map((r) => r.结果),
        ['一月-1', '一月-2', '一月-3', '二月-1', '二月-2'],
        'seq 是逐月的：按它全局排会把二月插进一月中间（修前顺序＝一月-1、二月-1、一月-2…）',
      );
      // limit 取的是**最新**的那几条（末月末尾），不是全月交错后的尾巴
      const 尾 = await audit.read({ months: ['2026-01', '2026-02'], limit: 2 });
      assert.deepEqual(尾.map((r) => r.结果), ['二月-1', '二月-2']);
    } finally {
      await done();
    }
  });

  it('③BM25：dl 与 tf 同字段集（索引期预存）——标签多不再靠被低估的分母压过别人', async () => {
    // 对抗语料：A 正文略长无标签；B 正文极短但标签多。修前 B 的 dl 只算正文 ⇒ 分母小 ⇒ 排前。
    const docs = [
      { id: 'A-正文略长', 正文: `并发 ${'填充。'.repeat(3)}`, 标签: [] },
      { id: 'B-标签多', 正文: '并发', 标签: ['标签甲', '标签乙', '标签丙', '标签丁', '标签戊', '标签己', '标签庚', '标签辛', '标签壬', '标签癸'] },
    ];
    const index = buildIndex(docs);
    assert.deepEqual(
      index.dl,
      docs.map((d) => Math.max(1, tokenize(`${d.正文} ${(d.标签 ?? []).join(' ')}`).length)),
      'dl 必须与 tf/df 取自同一串 token（正文 + 标签）',
    );
    assert.equal(search(index, '并发 一致性', { limit: 2 }).命中[0].id, 'A-正文略长', '修前：B-标签多 靠被低估的分母排在前面');

    // §11：改口径必须跑回归集，且**基线漂移要显式确认**（这里基线就是新口径的实测值）。
    const base = buildIndex([
      { id: 'a', 正文: '策略引擎是唯一判定点，必须 fail-closed。' },
      { id: 'b', 正文: '消息总线支持暂不投递。' },
      { id: 'c', 正文: '任务图的验收标准必填，派发后判据冻结。' },
    ]);
    const 执行 = (q) => search(base, q, { limit: 1 }).命中[0]?.id ?? '';
    const 回归 = await runRegression({
      回归集: [
        { 查询: '判据冻结', 期望: 'c' },
        { 查询: 'fail-closed', 期望: 'a' },
      ],
      基线: [
        { 查询: '判据冻结', 实际: 'c' },
        { 查询: 'fail-closed', 实际: 'a' },
      ],
      执行,
    });
    assert.equal(回归.通过, true, `新口径下回归集必须通过：${回归.差异.join('；')}`);
  });

  it('④tags：CRLF 照常解析；行内注释不切进引号，写出仍是 LF', () => {
    const crlf = ['---', 'id: 甲卡', 'kind: 能力', 'authority: 自治', 'zone: 私有', 'domain: 集体', 'version: 1', '---', '# 甲卡', '', '## 适用岗位', '- 插件工程', '', '## 怎么做', '先搜后写。'].join('\r\n');
    const doc = parseDocument(crlf);
    assert.equal(doc.meta.id, '甲卡', 'CRLF 文本下 front matter 必须被识别（修前整段失踪、meta 为空）');
    assert.equal(doc.errors.length, 0);
    assert.equal(doc.meta.version, '1', 'front matter 的值是标量文本（version 的数字化由 store 负责）');
    assert.match(doc.body, /## 适用岗位/, 'body 不许把 front matter 一起吞进去');

    const y = parseSimpleYaml(['摘要: "a # b"', '备注: 值 # 这是注释', '# 整行注释', 'url: x#y', "引号内井号: 'p # q'"].join('\n'));
    assert.equal(y.data.摘要, 'a # b', '引号里的 # 是值的一部分（修前被切成 `"a`）');
    assert.equal(y.data['引号内井号'], 'p # q');
    assert.equal(y.data.备注, '值', '行尾注释照旧要剥');
    assert.equal(y.data.url, 'x#y', '# 前没有空白 ⇒ 是值的一部分');
    assert.equal(formatFrontMatter({ id: '甲卡', authority: '自治' }).includes('\r'), false, '写出仍是 LF：字节稳定是升级比对的判据');
  });

  it('⑤探针声明坏 JSON：折成「问题」并见红，run 仍落快照与审计', async () => {
    const { f, done } = await 造区();
    try {
      const probes = new ProbeRunner({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
      await f.write('集体L2-共享基础设施/defaults/安全类探针.json', '{ 探针: [ 这不是 JSON');
      const 声明 = await probes.declare();
      assert.equal(声明.一致, false);
      assert.ok(声明.问题.some((p) => /无法解析/.test(p)), `问题里要说清是解析失败：${声明.问题.join('；')}`);

      const ran = await probes.run({ 机制版本: 'w3b-1' });
      assert.equal(ran.全绿, false, '声明坏了不许报全绿');
      assert.ok(ran.声明问题.length > 0);
      assert.equal(ran.结果.length, 4, '四道探针照跑（修前 run 在第一步就抛，快照与审计全无）');
      assert.ok(await probes.latest(), '快照必须落下');
      const rows = await f.audit.read({});
      assert.ok(rows.some((r) => r.动作 === '探针异常' && r.告警 === true), '见红要入账并告警');
    } finally {
      await done();
    }
  });

  it('⑥registry.assign 守卫：封存实例拒（指 restore）；在岗同岗位幂等不写盘、不重置代数', async () => {
    const { f, done } = await 造区();
    try {
      await writeUnder(f.privateRoot, '集体L3-成员角色卡/插件工程.md', 岗位卡());
      const registry = new RoleRegistry({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });

      await registry.assign({ subject: LEAD, 岗位: '插件工程', 实例: 'member-w3b', 代: 1 });
      const 首份 = await readFile(f.layout.identityFile(), 'utf8');
      const 幂等 = await registry.assign({ subject: LEAD, 岗位: '插件工程', 实例: 'member-w3b', 代: 5 });
      assert.equal(幂等.幂等, true, '在岗且同岗位 ⇒ 幂等返回现状');
      assert.equal(幂等.代, 1, '代数不许被第二次登记重置');
      assert.equal(await readFile(f.layout.identityFile(), 'utf8'), 首份, '幂等路径不写盘');

      await registry.seal({ subject: LEAD, 实例: 'member-w3b', 理由: '停岗' });
      await assert.rejects(
        () => registry.assign({ subject: LEAD, 岗位: '插件工程', 实例: 'member-w3b', 代: 2 }),
        (e) => e instanceof Denied && /封存/.test(e.rule + e.message) && /restore/.test(e.howToChange),
        '封存实例不许靠 assign 静默复活（howToChange 要指 restore）',
      );
      assert.equal((await registry.identity()).members['member-w3b'].status, '封存', '状态不许被复活');

      await registry.restore({ subject: SOVEREIGN, 实例: 'member-w3b' });
      assert.equal((await registry.identity()).members['member-w3b'].status, '在岗', 'restore 仍是唯一还原路径');
    } finally {
      await done();
    }
  });

  it('⑦time：now 解析不出 ⇒ 按最严判失联（不许 fail-open），且永不抛', () => {
    const since = new Date('2026-10-09T00:00:00Z');
    const 底 = { lastInteraction: since.toISOString(), responseDeadlineHours: 72 };
    const 坏 = evaluateSovereignPresence({ ...底, now: '不是时刻' });
    assert.equal(坏.lost, true, '修前 NaN > deadline === false ⇒ 判在线（一个坏读数把失联保护关掉）');
    assert.match(坏.判定说明, /当前时刻/);
    assert.equal(坏.deadline !== null, true, '到期时刻算得出来就照给，别一起吞掉');
    assert.equal(坏.hours, null, '算不出的读数给 null，不给 0 冒充');
    assert.equal(坏.since, since.toISOString().replace(/\.\d{3}Z$/, 'Z'));

    // 永不抛：new Date 会抛的输入（Symbol / BigInt）也必须给确定读数
    for (const v of [Symbol('x'), 1n]) {
      const r = evaluateSovereignPresence({ ...底, now: v });
      assert.equal(r.lost, true, `${String(v)} 这类输入也必须按最严给读数`);
    }
    // 正常路径不受影响
    assert.equal(evaluateSovereignPresence({ ...底, now: since.getTime() + 1000 }).lost, false);
  });

  it('⑧ids.js 注释改实：不许再写「从目录名重建」「同一秒内不撞」这两句假话', async () => {
    const 源码 = await readFile(new URL('../src/kernel/ids.js', import.meta.url), 'utf8');
    assert.doesNotMatch(源码, /索引丢了也能从目录名重建/, '完整 id 含时刻哈希，目录名给不出它');
    assert.doesNotMatch(源码, /同一秒内的并发创建不会撞 id/, '同毫秒 + 同种子 + 同类会撞 id');
    assert.match(源码, /同毫秒/, '要写明真实的边界（同毫秒同种子会撞，调用方自带去重）');
  });

  it('⑨store：rollback 的 authority 取自被回滚版本；文件名与 meta.id 不一致时响亮拒', async () => {
    const { f, done } = await 造区();
    try {
      const store = new ObjectStore({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
      /** @type {object|null} */
      let 回滚目标 = null;
      const 原check = f.policy.check.bind(f.policy);
      f.policy.check = async (input) => {
        if (input.action === 'rollback') 回滚目标 = input.target;
        return 原check(input);
      };
      const meta = () => ({ id: 'w3b-cap', authority: '自治', domain: '集体', project: null });
      await store.write('能力', { meta: meta(), body: 能力正文('第一版') }, { subject: LEAD, reason: '首建' });
      await store.write('能力', { meta: meta(), body: 能力正文('第二版') }, { subject: LEAD, reason: '改一版' });
      const rolled = await store.rollback('能力', 'w3b-cap', 1, { subject: SOVEREIGN, reason: '回滚到第一版' });
      assert.equal(rolled.restoredFrom, 1);
      assert.equal(回滚目标?.authority, '自治', 'authority 必须是被回滚版本的实际档位（修前硬编码 法律）');
      assert.equal(回滚目标?.textVersion, true);

      // 文件名与 meta.id 不一致 ⇒ 读取响亮拒，不许静默换 id
      await writeUnder(
        f.privateRoot,
        '集体L2-共享基础设施/能力库/名字甲.md',
        ['---', 'id: 名字乙', 'kind: 能力', 'authority: 自治', 'zone: 私有', 'domain: 集体', 'version: 1', '---', '# 名字乙', '', '## 适用岗位', '- 插件工程', '', '## 怎么做', '先搜后写。'].join('\n'),
      );
      await assert.rejects(
        () => store.read('能力', '名字甲', { subject: LEAD }),
        (e) => e instanceof InvalidBody && /不一致/.test(e.message),
        '按名字甲读却拿到名字乙的正文，必须失败而不是悄悄换身份',
      );
    } finally {
      await done();
    }
  });

  it('⑩workbench 未交齐遮罩：答案行只给盲标，交齐才给真名与结论', () => {
    const 造节点 = (答案) => ({ id: 'n-w3b', 描述: '技术路线', 状态: '已交卷', 模式: '独立会审', 负责人: ['member-a', 'member-b', 'member-c'], 判据: ['x'], 判据冻结: true, 独立答案: 答案 });
    const 两份 = [
      { 成员: 'member-a', 结论: '用会话命令', 反例面: [], 产出物引用: ['方案-a'] },
      { 成员: 'member-b', 结论: '用会话命令', 反例面: ['无会话首屏'], 产出物引用: ['方案-b'] },
    ];
    const 未齐 = projectWorkbench({ 项目: 'p', 节点: [造节点(两份)], 探针: { 结果: [] }, 策略: { healthy: true, rules: [] } }).会审[0];
    assert.equal(未齐.揭名, false);
    assert.deepEqual(未齐.独立答案, [{ 盲标: '成员 A' }, { 盲标: '成员 B' }], '未交齐只给盲标：真名与结论都不许出');
    assert.doesNotMatch(JSON.stringify(未齐), /member-a|用会话命令|无会话首屏|方案-a/, '整个会审块里不许出现任何人的答案（修前 揭名 只是个提示字段）');
    assert.deepEqual(未齐.交卷, { 已交: 2, 应交: 3, 齐: false });

    const 齐 = projectWorkbench({
      项目: 'p',
      节点: [造节点([...两份, { 成员: 'member-c', 结论: '用会话命令', 反例面: [], 产出物引用: [] }])],
      探针: { 结果: [] },
      策略: { healthy: true, rules: [] },
    }).会审[0];
    assert.equal(齐.揭名, true);
    assert.deepEqual(齐.独立答案.map((a) => a.成员), ['member-a', 'member-b', 'member-c'], '交齐后全给');
    assert.equal(齐.独立答案[0].结论, '用会话命令');
    assert.deepEqual(齐.独立答案[1].反例面, ['无会话首屏']);
  });

  it('⑪a memory 口径：检索候选文档数与账本条目数分开报，谁也不覆盖谁', async () => {
    const { f, done } = await 造区();
    try {
      const memory = new MemoryService({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
      const 记 = (内容) => memory.remember({ subject: LEAD, 类: '知识', 内容, 来源: '测试', 项目: 'default' });
      await 记('并发一致性 甲');
      await 记('并发一致性 乙');
      const 丙 = await 记('并发一致性 丙');
      await memory.invalidate(丙.id, { subject: LEAD, 原因: '过期' });

      const 查 = await memory.query({ subject: LEAD, 类: ['知识'], 项目: 'default', 文本: '并发一致性' });
      assert.equal(查.口径.文档数, 2, '检索面实算的候选数（失效那条不进召回）');
      assert.equal(查.口径.条目数, 3, '账本侧可见条数（含被当前有效视图挡住的那条）');
      assert.notEqual(查.口径.文档数, 查.口径.条目数, '两个数答两个问题，修前同名覆盖 ⇒ 候选文档数虚高');

      const 空 = await memory.query({ subject: LEAD, 类: ['知识'], 项目: 'default', 文本: '完全不存在的词汇zzz' });
      assert.equal(空.命中.length, 0);
      assert.equal(空.口径.文档数, 2, '0 命中的口径同样用实算的候选数');
      assert.match(空.说明, /候选文档数=2/, 'formatMiss 报的必须是实算值，不是账本条数');
    } finally {
      await done();
    }
  });

  it('⑪b memory.stats：跨账合并 fold，晋升过的同 id 只计一次', async () => {
    const { f, done } = await 造区();
    try {
      const memory = new MemoryService({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
      await memory.remember({ subject: LEAD, 类: '知识', 内容: '存量甲', 来源: '测试', 项目: 'default' });
      const 晋升 = await memory.remember({ subject: LEAD, 类: '知识', 内容: '跨项目可复用', 来源: '测试', 项目: 'default' });
      await memory.promoteCrossProject(晋升.id, { subject: LEAD, 岗位: '插件工程', 理由: '可复用' });

      const 项目账 = await readJsonl(f.layout.memoryLog('default', '知识'));
      const 跨项目账 = await readJsonl(f.layout.memoryLog('跨项目', '知识'));
      assert.equal(
        项目账.filter((r) => r.id === 晋升.id).length + 跨项目账.filter((r) => r.id === 晋升.id).length,
        2,
        '账上确实是两行同 id（§7 双份留痕）',
      );
      const st = await memory.stats();
      assert.equal(st.计数.知识, 2, '跨账合并 fold：同 id 只计一次（修前按账分开 fold ⇒ 3）');
      assert.equal(st.合计, 2);
    } finally {
      await done();
    }
  });
});
