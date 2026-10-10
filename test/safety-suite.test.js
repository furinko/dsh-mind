/**
 * 升级合并、安全类探针、审计链、工作台投影。
 *
 * 这一组盯的是「机制本身坏了会不会被发现」：
 * 合并判错、探针恒亮、账本被改、投影偷偷写盘——每一种都必须有断言拦着。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { makeFixture, SOVEREIGN, LEAD, writeUnder } from './helpers.mjs';
import { UpgradeManager, decide } from '../src/upgrade.js';
import { ProbeRunner, CLOSED_LIST } from '../src/probes.js';
import { AuditLog } from '../src/audit.js';
import { projectWorkbench, sliceForViewer } from '../src/workbench.js';
import { InvalidBody } from '../src/kernel/errors.js';

/** @type {Awaited<ReturnType<typeof makeFixture>>} */
let f;
/** @type {UpgradeManager} */ let upgrade;
/** @type {ProbeRunner} */ let probes;

const 条款 = (标题, 正文) => `## ${标题}\n${正文}\n`;
/** 合并演练放在真实的能力库目录里：`#resolve` 只认规则件、岗位卡与能力卡三处。 */
const 能力相对 = (名) => `集体L2-共享基础设施/能力库/${名}.md`;

describe('升级 / 探针 / 审计 / 工作台', () => {
  before(async () => {
    f = await makeFixture();
    upgrade = new UpgradeManager({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
    probes = new ProbeRunner({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
  });
  after(async () => {
    await f.cleanup();
  });

  it('处置表（裁决 2026-10-08）：直接替换 / 保留用户的（含冲突私有优先）/ 强制替换', () => {
    assert.equal(decide(null, 'a', null), '直接替换');
    assert.equal(decide('a', 'a', 'a'), '直接替换');
    assert.equal(decide('a', 'a', 'b'), '保留用户的', '出厂没改 ⇒ 保留用户的');
    assert.equal(decide('a', 'b', 'a'), '直接替换', '用户没改 ⇒ 直接替换');
    assert.equal(decide('a', 'b', 'c'), '保留用户的', '两边都改了同一条 ⇒ 私有优先，不再挂起');
    assert.equal(decide('a', 'b', 'c', true), '强制替换', '安全类不可协商');
    assert.equal(decide(null, 'b', 'c'), '保留用户的', '无基线的分歧也私有优先');
  });

  it('条款级合并：真按条款判；冲突标出来、告警提示、不落挂起（裁决 2026-10-08）', async () => {
    // 不写 H1：条款键就是标题路径，H1 会让键带上前缀（`演示/条款一`），
    // 这里要断言的是条款级行为本身，所以用最直接的形状。
    const 出厂 = `${条款('条款一', '出厂第一版')}\n${条款('条款二', '出厂第二版')}\n`;
    // 用户改了条款一，也改了条款二的一处措辞。
    const 私有 = `${条款('条款一', '用户改过的一条')}\n${条款('条款二', '用户改过的第二条')}\n`;
    await writeUnder(f.factoryRoot, 能力相对('合并演示'), 出厂);
    await writeUnder(f.privateRoot, 能力相对('合并演示'), 私有);

    await upgrade.stamp({ 版本: '1.0.0', 对象: ['合并演示'] });

    // 出厂只动了条款一，而用户也改了条款一 ⇒ 冲突，私有优先。
    const 出厂改 = `${条款('条款一', '出厂新版')}\n${条款('条款二', '出厂第二版')}\n`;
    await writeUnder(f.factoryRoot, 能力相对('合并演示'), 出厂改);
    const rows = await upgrade.compare({ 对象: '合并演示' });
    const 第一条 = rows.find((r) => r.条款 === '条款一');
    const 第二条 = rows.find((r) => r.条款 === '条款二');
    assert.ok(第一条 && 第二条, `条款键应被识别，实际键：${rows.map((r) => r.条款).join(',')}`);
    assert.equal(第一条.处置, '保留用户的', '两边都改了同一条 ⇒ 私有优先');
    assert.equal(第一条.冲突, true, '冲突事实必须显式标出');
    assert.ok(第一条.diff && 第一条.diff.出厂.includes('出厂新版'), '冲突行保留 diff 供提示');
    assert.equal(第二条.处置, '保留用户的', '出厂没改的那条保留用户的');
    // 不落新挂起：冲突私有优先后，挂起队列不再增长。
    assert.equal((await upgrade.pending()).length, 0, '新冲突不产生挂起项');
    // Lead 提示主权者：一条告警审计。
    const 提示 = (await f.audit.read({})).filter((r) => r.告警 === true && /私有优先/.test(String(r.结果)));
    assert.ok(提示.length >= 1, '冲突必须留下告警提示');
    assert.ok(提示.at(-1).详情.条款.includes('条款一'), '提示里点名冲突条款');
  });

  it('遗留挂起项：Lead 可裁决；裁决与撤回都留记录而不是删除', async () => {
    await f.writePrivate('升级/挂起/legacy-1.json', `${JSON.stringify({ id: 'legacy-1', 对象: '另一个', 条款: '甲', 安全类: false, 状态: '挂起', 可选项: ['用出厂版', '用我的版'] }, null, 2)}\n`);
    const resolved = await upgrade.resolve({ subject: LEAD, id: 'legacy-1', 选择: '用我的版', 理由: '主权者授意' });
    assert.equal(resolved.已裁决, true, '法律档遗留挂起：Lead 裁决通道放行');
    const after = await upgrade.pending();
    assert.equal(after.find((p) => p.id === 'legacy-1').选择, '用我的版');
    assert.equal(after.find((p) => p.id === 'legacy-1').已裁决, true, '裁决后记录仍在（不可逆的是记录）');

    await f.writePrivate('升级/挂起/legacy-2.json', `${JSON.stringify({ id: 'legacy-2', 对象: '另一个', 条款: '乙', 安全类: false, 状态: '挂起' }, null, 2)}\n`);
    const withdrawn = await upgrade.withdraw({ subject: LEAD, id: 'legacy-2', 理由: '不升级了' });
    assert.equal(withdrawn.已撤回, true);
    assert.equal((await upgrade.pending()).find((p) => p.id === 'legacy-2').已撤回, true, '撤回也不删记录');
  });

  it('安全类走强制替换，不看用户改没改', async () => {
    await writeUnder(f.factoryRoot, 能力相对('安全演示'), `${条款('红线', '旧机制')}\n`);
    await writeUnder(f.privateRoot, 能力相对('安全演示'), `${条款('红线', '用户改过的机制')}\n`);
    await upgrade.stamp({ 版本: '1.0.2', 对象: ['安全演示'] });
    await writeUnder(f.factoryRoot, 能力相对('安全演示'), `${条款('红线', '修补后的机制')}\n`);
    const rows = await upgrade.compare({ 对象: '安全演示', 安全类: true });
    assert.equal(rows[0].处置, '强制替换');
  });

  it('⑭ 死字段已删：条款级合并 / 安全类两条摘要审计交出去的条目不带「告警」键', async () => {
    // 断言面选「交给 audit.append 的条目」而不是落盘行，理由必须写死在这里（否则下一个人会来"修"成落盘断言）：
    //   `src/audit.js` 的 append 无条件写 `告警: entry.告警 === true` ⇒ **落盘行永远有 `告警` 这个键**
    //   （upgrade 不给就补 false）。所以「落盘行不含告警键」是做不到的，
    //   而「落盘行 告警 === false」是**恒真式**（由 audit.js 补出来，与本处那一行删没删无关）⇒ 验不出东西。
    //   能证伪「那一行删没删」的面只有调用点本身。
    /** @type {object[]} */
    const 入账 = [];
    const 原append = f.audit.append;
    f.audit.append = async (entry) => {
      入账.push({ ...entry }); // 快照：记的是调用点当时的形状，之后 audit 怎么加工都不影响
      return 原append.call(f.audit, entry);
    };
    try {
      // ① 非安全类：一条「保留用户的」（用户改了甲）+ 一条「直接替换」（用户没碰乙）
      //    ⇒ 摘要审计（依据「§5 升级：条款级合并」）落账——若全都保留用户的，这条审计根本不落。
      await writeUnder(f.factoryRoot, 能力相对('字段演示'), `${条款('甲', '出厂甲一版')}\n${条款('乙', '出厂乙一版')}\n`);
      await writeUnder(f.privateRoot, 能力相对('字段演示'), `${条款('甲', '用户甲一版')}\n`);
      await upgrade.stamp({ 版本: '1.1.0', 对象: ['字段演示'] });
      const 合并 = await upgrade.compare({ 对象: '字段演示' });
      assert.deepEqual(
        合并.map((r) => r.处置).sort(),
        ['保留用户的', '直接替换'],
        `前置：本用例要同时踩到两种处置，否则摘要审计不落账 ⇒ 下面的断言会空过。实际：${JSON.stringify(合并.map((r) => [r.条款, r.处置]))}`,
      );

      // ② 安全类：强制替换 ⇒ 另一条摘要审计（依据「§5 安全类：强制替换，不可协商」）。
      //    这里同时踩到冲突（出厂改了 + 用户改了同一条），于是正对照那条冲突告警也在场。
      await writeUnder(f.factoryRoot, 能力相对('字段安全演示'), `${条款('红线', '旧机制')}\n`);
      await writeUnder(f.privateRoot, 能力相对('字段安全演示'), `${条款('红线', '用户改过的机制')}\n`);
      await upgrade.stamp({ 版本: '1.1.1', 对象: ['字段安全演示'] });
      await writeUnder(f.factoryRoot, 能力相对('字段安全演示'), `${条款('红线', '修补后的机制')}\n`);
      await upgrade.compare({ 对象: '字段安全演示', 安全类: true });
    } finally {
      f.audit.append = 原append;
    }

    const 摘要 = 入账.filter((e) => ['§5 升级：条款级合并', '§5 安全类：强制替换，不可协商'].includes(String(e.依据)));
    assert.deepEqual(
      摘要.map((e) => e.依据).sort(),
      ['§5 升级：条款级合并', '§5 安全类：强制替换，不可协商'],
      '两条摘要审计都必须真的落账，且各自恰好一条（分母非零，下面的断言才不是空过）',
    );
    for (const entry of 摘要) {
      assert.equal(Object.hasOwn(entry, '告警'), false, `摘要审计不许再带恒假的「告警」键（处置里已无「挂起」）：${entry.依据}`);
    }
    // 正对照：同一轮里冲突告警那条**必须**仍带 `告警: true`——
    // 它证明上面查的不是「这一轮根本没有告警字段」这种空集结论（⑭ 只删摘要审计那一个死字段）。
    const 冲突 = 入账.filter((e) => /升级冲突私有优先/.test(String(e.依据)));
    assert.ok(冲突.length >= 1, '前置：冲突告警条目在场（本用例的 ② 必然冲突）');
    assert.ok(冲突.every((e) => e.告警 === true), '冲突告警原样保留：告警字段本身仍然有人真的在用');
  });

  it('探针封闭清单：缺声明、多声明都报错，不做「等其他类似情况」兜底', async () => {
    const 声明 = await probes.declare();
    assert.deepEqual(声明.已实现, CLOSED_LIST);
    await writeUnder(f.factoryRoot, '集体L2-共享基础设施/defaults/安全类探针.json', JSON.stringify({ 探针: [...CLOSED_LIST, '顺手加一个'] }));
    const bad = await probes.declare();
    assert.equal(bad.一致, false);
    assert.ok(bad.问题.some((p) => p.includes('清单外')));
    await writeUnder(f.factoryRoot, '集体L2-共享基础设施/defaults/安全类探针.json', JSON.stringify({ 探针: ['审计链', '闸在位'] }));
    const missing = await probes.declare();
    assert.equal(missing.一致, false);
    assert.ok(missing.问题.some((p) => p.includes('没有被声明')));
    await writeUnder(f.factoryRoot, '集体L2-共享基础设施/defaults/安全类探针.json', JSON.stringify({ 探针: CLOSED_LIST }));
  });

  it('探针：四盏灯全绿；审计被篡改、闸不在位都见红', async () => {
    const green = await probes.run({ 机制版本: 'mech-1' });
    assert.equal(green.全绿, true, `应全绿，实际：${JSON.stringify(green.见红)}`);
    assert.deepEqual(green.结果.map((r) => r.探针), CLOSED_LIST);

    // 全绿 run 的审计动作名必须是「探针巡检」：全绿是常态巡检，不是异常（权限矩阵：机制内置）。
    // 用「对象」定位当次追加：篡改用例里 seq=999 的伪造行会把 .at(-1) 顶掉，不能靠尾行定位。
    const greenRows = await f.audit.read({});
    const 巡检 = greenRows.filter((r) => r.对象?.id === '红线索兵').at(-1);
    assert.ok(巡检, '全绿 run 也必须落账（无条件入账）');
    assert.equal(巡检.动作, '探针巡检', '全绿 ⇒ 动作名「探针巡检」');
    assert.notEqual(巡检.动作, '探针异常', '反例：全绿 run 的当次审计追加不许是「探针异常」');
    assert.equal(巡检.告警, false, '全绿不告警');
    assert.equal(巡检.结果, '全绿', '结果文案与动作名自洽');
    assert.equal(巡检.档位, '全记', '巡检与异常同档：机制内置、无条件入账（审计要求「全记」行）');
    assert.ok(greenRows.every((r) => r.动作 !== '探针异常'), '全绿之后，账里不出现「探针异常」');

    // 篡改审计：追加一条 prev/hash 对不上的行。
    const month = new Date().toISOString().slice(0, 7);
    const auditFile = f.layout.auditLog(month);
    const forged = { seq: 999, 时间: '2020-01-01T00:00:00Z', 主体: { id: 'attacker', kind: '未知' }, 动作: '状态变更', 对象: { id: 'x', kind: '账目' }, 依据: '伪造', 结果: '伪造', 档位: '全记', prev: 'deadbeef', hash: 'cafebabe' };
    await writeFile(auditFile, `${await readFile(auditFile, 'utf8')}${JSON.stringify(forged)}\n`);
    const tampered = await probes.run({ 机制版本: 'mech-2' });
    assert.equal(tampered.全绿, false);
    assert.ok(tampered.见红.some((r) => r.探针 === '审计链'));
    const 异常 = (await f.audit.read({})).filter((r) => r.对象?.id === '红线索兵').at(-1);
    assert.equal(异常.动作, '探针异常', '见红 ⇒ 动作名「探针异常」');
    assert.equal(异常.告警, true, '见红要告警');

    // 闸不在位：删掉一个规则件再重载。
    const { rm } = await import('node:fs/promises');
    await rm(f.layout.rulePath('审计要求', '出厂'), { force: true });
    await f.policy.reload();
    const gate = await probes.run({ 机制版本: 'mech-3' });
    assert.ok(gate.见红.some((r) => r.探针 === '闸在位'));
    assert.equal(f.policy.healthy, false);
  });

  it('探针红 ⇒ 定位「全绿的最近一版」并入账、升级主权者；运行态不自动改文件（甲′）', async () => {
    const snapshots = await readdir(f.layout.probeSnapshotDir());
    assert.ok(snapshots.length >= 3);
    const result = await probes.autoRollback();
    assert.equal(result.执行, false, '运行态不自动改文件：只有定位，没有执行面');
    assert.equal(result.已定位, true);
    assert.equal(result.目标版本, 'mech-1', '跨过见红的 mech-2/mech-3，定位到全绿的最近一版');
    const rows = await f.audit.read({});
    const 回滚 = rows.filter((r) => r.动作 === '自动回滚');
    assert.ok(回滚.length >= 1, '无条件入账');
    assert.match(String(回滚.at(-1).结果), /已定位回滚目标 mech-1.*入账并升级主权者/);
    assert.doesNotMatch(String(回滚.at(-1).结果), /待执行|回滚制品未定义|待批次4/, '审计口径已按甲′裁决改实');
    assert.doesNotMatch(String(回滚.at(-1).结果), /mech-\d+ → mech-\d+/, '不许再写「x → y」这种像真回滚过的口径');
  });

  it('探针健康：恒红与恒绿都要报警', async () => {
    const health = await probes.evaluateHealth();
    assert.ok(['正常', '恒红', '恒绿', '样本不足'].includes(health.状态));
    assert.equal(typeof health.说明, 'string');
    assert.ok(health.说明.length > 0);
  });

  it('影响面声明说清动了哪些检测逻辑', async () => {
    const statement = await probes.impactStatement({ 机制版本: 'mech-3' });
    assert.equal(statement.机制版本, 'mech-3');
    assert.equal(typeof statement.声明, 'string');
    assert.ok(Array.isArray(statement.动了));
    assert.ok(Array.isArray(statement.未动));
  });

  it('审计：只增、按月分片、链自检能发现篡改', async () => {
    const audit = new AuditLog({ layout: f.layout, clock: f.clock });
    await audit.append({ 动作: '状态变更', 主体: { id: 'x', kind: 'Lead' }, 对象: 'y', 依据: '测试', 结果: 'ok' });
    const months = await audit.months();
    assert.ok(months.every((m) => /^\d{4}-\d{2}$/.test(m)));
    // 现行账本已被上面的用例篡改过，因此自检必须是「不 ok 且指出位置」。
    const verified = await audit.verify();
    assert.equal(verified.ok, false);
    assert.ok(verified.broken.length >= 1);
    assert.ok(verified.broken[0].month);
    // 清空队列不许让记录消失：清掉的项要进账本。
    const cleared = await audit.clearQueue({ 主体: { id: 'lead', kind: 'Lead' }, 队列: '待决队列', 清掉的项: [{ id: 'a' }, { id: 'b' }], 依据: '主权者要求' });
    assert.ok(cleared.seq > 0);
    const rows = await audit.read({});
    const entry = rows.find((r) => r.动作 === '账本清空');
    assert.ok(entry);
    assert.equal(entry.详情.清掉的项.length, 2, '清掉的项进账本，而不是消失');
  });

  it('审计写入不需要许可：策略引擎不健康时照样记账', async () => {
    assert.equal(f.policy.healthy, false, '前置：引擎已不在位');
    const audit = new AuditLog({ layout: f.layout, clock: f.clock });
    const written = await audit.append({ 动作: '策略拒绝', 主体: { id: 'lead', kind: 'Lead' }, 对象: 'z', 依据: '闸坏了', 结果: '拒绝' });
    assert.ok(written.seq > 0, '写入无条件 —— 否则会出现「拒绝导致的拒绝」');
  });

  it('工作台是纯投影：同样的输入给同样的输出，且不写任何东西', async () => {
    const before = await readdir(f.privateRoot, { recursive: true });
    const input = {
      项目: 'p-pur',
      节点: [
        { id: 'n1', 描述: '已派发', 状态: '已派发', 负责人: ['member-a'], 判据: ['x'], 判据冻结: true },
        { id: 'n2', 描述: '待决', 状态: '待决', 待决原因: '两边都改了', 判据冻结: true },
        { id: 'n3', 描述: '被打回两次', 状态: '已打回', 打回次数: 2, 升级: { 原因: '打回≥2', 至: '主权者' } },
      ],
      探针: { 状态: '正常', 结果: [] },
      策略: { healthy: true, rules: [{ id: '宪章' }], 介入度: '零参与', 失联: { lost: false } },
      审计尾: [{ 时间: 't', 动作: '状态变更', 主体: { id: 'lead', kind: 'Lead' }, 结果: 'ok', 档位: '全记' }],
      生成于: '2026-10-07T00:00:00Z',
    };
    const a = projectWorkbench(input);
    const b = projectWorkbench(input);
    assert.deepEqual(a, b, '投影必须是纯函数');
    assert.equal(a.边界.只读, true);

    // 状态条：够判断「现在能不能干活」
    assert.equal(a.状态条.闸.在位, true);
    assert.equal(a.状态条.闸.规则数, 1);
    // 四态字符串（Batch 2 起）：策略给了 lost:false 且开关没关 ⇒ 「在位」。
    assert.equal(a.状态条.失联, '在位');
    assert.equal(a.状态条.失联详情.lost, false, '详情要把原始读数带出来（这里没有 已关闭 这个字段 ⇒ 不是「关了」）');
    assert.equal(a.状态条.介入度, '零参与');

    // 待你决定：待决项与打回升级都要进来，并且**每项都给该敲的命令**（工作台只读）
    const 类型 = [...new Set(a.待你决定.map((x) => x.类型))].sort();
    assert.deepEqual(类型, ['打回升级', '待决项'].sort());
    const 待决项 = a.待你决定.find((x) => x.类型 === '待决项');
    assert.deepEqual(待决项.可选项, ['用出厂版', '用我的版']);
    assert.match(待决项.命令, /^\/mind task_resolve id=/);
    assert.match(a.待你决定.find((x) => x.类型 === '打回升级').原因, /打回 2 次/);

    // 任务：判据、冻结、打回次数、产物引用、交卷进度
    const n1 = a.任务.节点.find((n) => n.id === 'n1');
    assert.deepEqual(n1.判据, ['x']);
    assert.equal(n1.判据冻结, true);
    assert.deepEqual(n1.交卷, { 已交: 0, 应交: 1, 齐: false });
    assert.equal(a.任务.节点.find((n) => n.id === 'n3').打回次数, 2);
    assert.deepEqual(a.任务.计数, { 待派发: 0, 进行中: 1, 已交卷: 0, 已采纳: 0, 已打回: 1, 未验: 0, 已结账: 0, 待决: 1 });

    const after = await readdir(f.privateRoot, { recursive: true });
    assert.deepEqual(after, before, '工作台在磁盘上不留任何东西（无存储）');
  });

  it('会审块：N 份独立答案按人留，未交齐不揭名，零分歧按异常呈现', () => {
    const 节点 = {
      id: 'n9',
      描述: '技术路线',
      状态: '已交卷',
      模式: '独立会审',
      负责人: ['member-a', 'member-b', 'member-c'],
      判据: ['x'],
      判据冻结: true,
      独立答案: [
        { 成员: 'member-a', 结论: '用会话命令', 反例面: [], 产出物引用: ['方案-a'] },
        { 成员: 'member-b', 结论: '用会话命令', 反例面: ['无会话首屏'], 产出物引用: ['方案-b'] },
      ],
    };
    const 未齐 = projectWorkbench({ 项目: 'p', 节点: [节点], 探针: { 结果: [] }, 策略: { healthy: true, rules: [] } }).会审[0];
    assert.deepEqual(未齐.交卷, { 已交: 2, 应交: 3, 齐: false });
    assert.equal(未齐.揭名, false, '未交齐 ⇒ 不揭名');
    assert.deepEqual(未齐.独立答案.map((a) => a.盲标), ['成员 A', '成员 B'], 'N 份答案都留下来了');
    // W3 批3：未交齐时**零分歧也不投影**（「这两份一致」本身就是内容级信息，盲评要互不可见）。
    assert.equal(未齐.零分歧, undefined, '未交齐 ⇒ 零分歧/依据都不出');
    assert.equal(未齐.零分歧依据, undefined);

    // 交齐且**无人给反例面** ⇒ 零分歧（全票一致 = 异常信号）
    const 齐节点 = {
      ...节点,
      独立答案: ['member-a', 'member-b', 'member-c'].map((成员) => ({ 成员, 结论: '用会话命令', 反例面: [], 产出物引用: [] })),
    };
    const 齐 = projectWorkbench({ 项目: 'p', 节点: [齐节点], 探针: { 结果: [] }, 策略: { healthy: true, rules: [] } }).会审[0];
    assert.equal(齐.揭名, true);
    assert.deepEqual(齐.交卷, { 已交: 3, 应交: 3, 齐: true });
    assert.equal(齐.零分歧, true, '三份结论层一致且无人给反例面 ⇒ 零分歧（异常信号）');
    assert.match(齐.零分歧依据, /全票一致 = 异常信号/);
  });

  it('成员只读自己任务那片；Lead 与复核者看全量', () => {
    const view = projectWorkbench({
      项目: 'p-slice',
      节点: [
        { id: 'n1', 描述: '我的', 状态: '执行中', 负责人: ['member-a'], 待决原因: '等我', 独立答案: [{ 成员: 'member-a', 结论: 'x', 反例面: [] }] },
        { id: 'n2', 描述: '别人的', 状态: '执行中', 负责人: ['member-b'] },
      ],
      审计尾: [
        { 时间: 't1', 动作: '状态变更', 主体: { id: 'member-a', kind: '成员' }, 结果: 'a' },
        { 时间: 't2', 动作: '状态变更', 主体: { id: 'member-b', kind: '成员' }, 结果: 'b' },
      ],
    });
    const mine = sliceForViewer(view, { id: 'member-a', kind: '成员', roleId: '插件工程' });
    assert.deepEqual(mine.任务.节点.map((n) => n.id), ['n1'], '只看得见自己的节点');
    assert.deepEqual(mine.会审.map((a) => a.节点), ['n1'], '会审也切片');
    assert.equal(mine.审计尾.length, 1);
    assert.equal(mine.边界.只读, true);
    assert.match(mine.视图, /自己任务那片/);

    const leadView = sliceForViewer(view, { id: 'lead', kind: 'Lead' });
    assert.equal(leadView.任务.节点.length, 2);
    assert.equal(leadView.审计尾.length, 2);
    const reviewerView = sliceForViewer(view, { id: 'r', kind: '复核者' });
    assert.match(reviewerView.视图, /复核者/);
  });

  it('未知对象无从比对时报错，而不是悄悄给个「没问题」', async () => {
    await assert.rejects(() => upgrade.compare({ 对象: '从来没存在过的东西' }), (error) => error instanceof InvalidBody);
  });
});
