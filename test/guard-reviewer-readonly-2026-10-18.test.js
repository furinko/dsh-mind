/**
 * 复核员只读工具闸回归（v2 口述收敛 2026-10-18 条目6/7 的补修；真 host guard 面）。
 *
 * 病灶：五个 mind 读出口收窄后，通用文件工具仍可直读私有区原始任务/审计/身份/记忆/总线文件。
 * 本文件钉住**现有唯一范围 guard**（不注册平行 guard）里的复核员角色边界：
 *  - 只读闭名单：read/glob/grep/read_image/skill + mind/mind_guard（后者由本体按动作判）；
 *    write/edit/pwsh/bash/创建/未知执行类一律拒；
 *  - 读路径只到**本复核任务/目标的显式产出引用**（文件或目录；绝对路径且真实存在）；
 *    cwd 只用于解析相对参数，不当授权面；私有区原始账本优先拒，大小写 / 相对 / `..` /
 *    junction / symlink 都折到 realpath 再比；
 *  - 真实 `exec.arguments.file_path/path`（不是 exec.input），缺关键读数 unknown 即拒；
 *  - 工具总范围「未配置」的早退**不许**把角色闸一起跳过；
 *  - guard 必须同步返回 string/undefined，绝不返回 Promise。
 *
 * 反例全部是「让闸必须变红」的坏状态；底层宿主不改。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, stat, writeFile } from 'node:fs/promises';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, seedReviewRelation } from './helpers.mjs';
import { fakeHost } from './host-harness.mjs';
import { appendLines } from '../src/kernel/fsx.js';
import { Denied } from '../src/kernel/errors.js';
import { shareOrg } from '../src/runtime.js';
import * as plugin from '../components/kernel/lib/index.js';

const 项目键 = 'guard-proj';

/** 复核员会话的 exec 形状：子会话事实（origin=subagent）+ 真实 arguments + 已提交 cwd。 */
function 复核exec(工具, 参数, cwd) {
  return {
    name: 工具,
    arguments: 参数,
    agent: { session: { id: 'reviewer', header: { origin: 'subagent', cwd } } },
  };
}

/** 跑一遍所有已注册 guard（真宿主是「任一返回字符串即拒」）。 */
function 闸(host, exec) {
  for (const guard of host.闸) {
    const 结果 = guard(exec);
    assert.ok(!(结果 instanceof Promise), 'guard 不得返回 Promise（同步契约）');
    assert.ok(结果 === undefined || typeof 结果 === 'string', `guard 必须同步返回 string/undefined，实际：${String(结果)}`);
    if (结果 !== undefined) return 结果;
  }
  return undefined;
}

async function 起现场({ 附读根 = true } = {}) {
  const f = await makeFixture();
  const 项目目录 = join(f.home, 项目键);
  await mkdir(join(项目目录, 'src'), { recursive: true });
  await writeFile(join(项目目录, 'src', 'a.js'), 'export const a = 1;\n', 'utf8');
  // 造一个复核任务：绑定 reviewer、显式复核对象 biz-1；Lead 在复核任务上 attach
  // **源码目录引用**（产出物引用 = 绝对路径目录）——这是复核员可读的唯一文件面。
  await appendLines(f.layout.taskLog(项目键), [{
    seq: 1, at: new Date().toISOString(), by: { id: 'lead', kind: 'Lead' },
    kind: 'created', id: 'biz-1', 描述: 'guard-业务', 负责人: ['member-a'], 判据: ['可验'], 依赖: [], 状态: '待派发',
  }]);
  const 复核id = await seedReviewRelation(f, { 项目: 项目键, 目标: 'biz-1', id: 'rev-1' });
  if (附读根) {
    await appendLines(f.layout.taskLog(项目键), [{
      seq: 9001, at: new Date().toISOString(), by: { id: 'lead', kind: 'Lead' },
      kind: 'artifact', id: 复核id, 产出物: 项目目录, 复核读根: true,
    }]);
  }
  const host = fakeHost();
  await plugin.apply(host.ctx, { home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, projectBindings: [{ path: 项目目录, project: 项目键 }] });
  return { f, host, 项目目录 };
}

describe('复核员只读工具闸（真 host guard）', () => {
  it('复核读根内的硬链接别名不能直读私有身份或从其父目录递归检索', async () => {
    const { f, host, 项目目录 } = await 起现场();
    try {
      const alias = join(项目目录, 'src', 'ordinary.json');
      await link(f.layout.identityFile(), alias);
      assert.equal((await stat(alias)).nlink, 2);
      for (const tool of ['read', 'read_image']) assert.match(闸(host, 复核exec(tool, { file_path: alias }, 项目目录)), /硬链接/);
      for (const tool of ['glob', 'grep']) assert.match(闸(host, 复核exec(tool, { path: 项目目录, pattern: '*' }, 项目目录)), /硬链接/);
      assert.equal(闸(host, 复核exec('read', { file_path: join(项目目录, 'src', 'a.js') }, 项目目录)), undefined);
    } finally { host.清理(); await f.cleanup(); }
  });

  it('正例：项目源码 read/glob/grep 放行；mind 由本体按动作判；guard 全部同步', async () => {
    const { f, host, 项目目录 } = await 起现场();
    try {
      assert.equal(闸(host, 复核exec('read', { file_path: join(项目目录, 'src', 'a.js') }, 项目目录)), undefined);
      assert.equal(闸(host, 复核exec('glob', { pattern: '**/*.js', path: 项目目录 }, 项目目录)), undefined);
      assert.equal(闸(host, 复核exec('grep', { pattern: 'a = 1', path: join(项目目录, 'src') }, 项目目录)), undefined);
      assert.equal(闸(host, 复核exec('glob', { pattern: '**/*.js' }, 项目目录)), undefined, '未传 path ⇒ 搜索根 = 当前工作目录');
      assert.equal(闸(host, 复核exec('mind', { action: 'task_review', id: 't' }, 项目目录)), undefined, 'mind 由本体按动作判');
      assert.equal(闸(host, 复核exec('mind_guard', { action: 'probe_health' }, 项目目录)), undefined);
    } finally { await f.cleanup(); }
  });

  it('报告通道：agent_id / target 两个官方变体都认；只许同一派发 Lead；冲突/未知参数拒', async () => {
    const { f, host, 项目目录 } = await 起现场();
    try {
      // 官方子代理变体：只有 agent_id；Root/Team 变体：只有 target；以及两者一致。
      assert.equal(闸(host, 复核exec('send_message', { agent_id: 'lead', message: '复核完成' }, 项目目录)), undefined, 'agent_id-only 合法');
      assert.equal(闸(host, 复核exec('send_message', { target: 'lead', message: '复核完成' }, 项目目录)), undefined, 'target-only 合法');
      assert.equal(闸(host, 复核exec('send_message', { agent_id: 'lead', target: 'lead', message: '复核完成' }, 项目目录)), undefined, '双字段一致合法');

      // 反例：任一字段指别成员/伪角色，或双字段冲突。
      for (const 参数 of [
        { agent_id: 'member-a', message: 'x' },
        { target: 'member-a', message: 'x' },
        { agent_id: '插件工程', message: 'x' },
        { agent_id: 'sovereign', message: 'x' },
        { agent_id: 'lead', target: 'member-a', message: 'x' },
        { agent_id: 'member-a', target: 'lead', message: 'x' },
      ]) {
        const r = 闸(host, 复核exec('send_message', 参数, 项目目录));
        assert.ok(typeof r === 'string' && /报告通道/.test(r), `非法目标必须拒：${JSON.stringify(参数)} => ${r}`);
      }
      // 反例：缺字段 / 空串 / 非字符串 / 未知第三收件参数（不许偷偷进 body）。
      for (const 参数 of [
        { message: 'x' },
        { agent_id: '', message: 'x' },
        { target: 42, message: 'x' },
        { agent_id: 'lead', message: 'x', to: 'member-b' },
        { agent_id: 'lead', message: 'x', recipient: 'member-b' },
      ]) {
        const r = 闸(host, 复核exec('send_message', 参数, 项目目录));
        assert.ok(typeof r === 'string' && /报告通道/.test(r), `非法字段必须拒：${JSON.stringify(参数)} => ${r}`);
      }
      // 只有 exec.input 不算读数。
      const 只有input = { name: 'send_message', input: { agent_id: 'lead', message: 'x' }, agent: { session: { id: 'reviewer', header: { origin: 'subagent', cwd: 项目目录 } } } };
      const input拒 = 闸(host, 只有input);
      assert.ok(typeof input拒 === 'string' && /报告通道/.test(input拒), `exec.input 不算读数：${input拒}`);

      // lead 别名与「父真实 ID」等价：委派父是真实 Lead 实例时，两字段各写一种也放行。
      const org = await shareOrg({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot });
      const 出生 = await org.registry.ensureLeadInstance({ 实例: 'lead-real-1', 代次: { 代: 'gen-test', pid: process.pid } });
      assert.equal(出生.就绪, true, `真实 Lead 出生失败：${JSON.stringify(出生)}`);
      await org.registry.assign({ subject: { id: 'lead-real-1', kind: 'Lead', roleId: 'Lead' }, 岗位: '复核员', 实例: 'reviewer2' });
      const 真父exec = (参数) => ({ name: 'send_message', arguments: 参数, agent: { session: { id: 'reviewer2', header: { origin: 'subagent', cwd: 项目目录 } } } });
      assert.equal(闸(host, 真父exec({ agent_id: 'lead', target: 'lead-real-1', message: 'x' })), undefined, 'lead 别名与父真实 ID 等价');
      const 冲突 = 闸(host, 真父exec({ agent_id: 'lead', target: 'member-a', message: 'x' }));
      assert.ok(typeof 冲突 === 'string' && /报告通道/.test(冲突), '真实父下仍不许指别人');
    } finally { await f.cleanup(); }

    // 反例：legacy 复核实例（无委派父、无宿主父会话）⇒ 报告通道无可信目标，明确拒。
    const g = await makeFixture({ legacyMembers: true });
    const host2 = fakeHost();
    try {
      await plugin.apply(host2.ctx, { home: g.home, factoryRoot: g.factoryRoot, privateRoot: g.privateRoot });
      const r = 闸(host2, 复核exec('send_message', { agent_id: 'lead', message: 'x' }, join(g.home, 项目键)));
      assert.ok(typeof r === 'string' && /没有可信/.test(r), `缺父归属不许发：${r}`);
    } finally {
      host2.清理();
      await g.cleanup();
    }
  });

  it('反例：write/edit/pwsh/bash/未知执行类 ⇒ 拒；一般 shell 不能静态证只读，复核员关闭', async () => {
    const { f, host, 项目目录 } = await 起现场();
    try {
      for (const 工具 of ['write', 'edit', 'pwsh', 'bash', 'create_directory', 'mystery_exec']) {
        const r = 闸(host, 复核exec(工具, { file_path: join(项目目录, 'src', 'a.js'), 内容: 'x' }, 项目目录));
        assert.ok(typeof r === 'string' && /只读闭名单/.test(r), `${工具} 必须被只读闭名单拒，实际：${r}`);
      }
    } finally { await f.cleanup(); }
  });

  it('反例：私有区原始账本直读 ⇒ 拒（绝对/相对/.. /大小写/junction/symlink 都折到 realpath）', async () => {
    const { f, host, 项目目录 } = await 起现场();
    try {
      const 身份 = join(f.privateRoot, '身份档案', 'identity.json');
      const 绝对拒 = 闸(host, 复核exec('read', { file_path: 身份 }, 项目目录));
      assert.ok(typeof 绝对拒 === 'string' && /私有区/.test(绝对拒) && /mind/.test(绝对拒), `绝对路径必须拒：${绝对拒}`);
      // 相对路径 + ..
      const 相对 = `../${f.privateRoot.split(/[\\/]/).pop()}/身份档案/identity.json`;
      const 相对拒 = 闸(host, 复核exec('read', { file_path: 相对 }, 项目目录));
      assert.ok(typeof 相对拒 === 'string' && /私有区/.test(相对拒), `相对/.. 不能绕：${相对拒}`);
      // 大小写别名（Windows 落线不区分大小写）
      if (process.platform === 'win32') {
        const 大写 = 身份.toUpperCase();
        const 大写拒 = 闸(host, 复核exec('read', { file_path: 大写 }, 项目目录));
        assert.ok(typeof 大写拒 === 'string' && /私有区/.test(大写拒), `大小写别名不能绕：${大写拒}`);
      }
      // junction / symlink：链接在项目源码目录内，真实目标在私有区
      const 链接 = join(项目目录, 'link-to-private');
      symlinkSync(f.privateRoot, 链接, 'junction');
      const 链接拒 = 闸(host, 复核exec('read', { file_path: join(链接, '身份档案', 'identity.json') }, 项目目录));
      assert.ok(typeof 链接拒 === 'string' && /私有区/.test(链接拒), `junction/symlink 不能绕：${链接拒}`);
      // 授权根之外（哪怕是出厂规则件）也不许读：不是「复核员就有全盘读」。
      const 界外 = 闸(host, 复核exec('read', { file_path: join(f.factoryRoot, '集体L0-宪章', '宪章.md') }, 项目目录));
      assert.ok(typeof 界外 === 'string' && /授权产出引用/.test(界外), `授权根之外不许读：${界外}`);
    } finally { await f.cleanup(); }
  });

  it('反例：缺 arguments.file_path / 只有 exec.input / glob 无 path 且无 cwd ⇒ unknown 拒', async () => {
    const { f, host, 项目目录 } = await 起现场();
    try {
      const 缺路径 = 闸(host, 复核exec('read', {}, 项目目录));
      assert.ok(typeof 缺路径 === 'string' && /unknown/.test(缺路径), `缺 file_path ⇒ unknown 拒：${缺路径}`);
      // 官方冻结的是 exec.arguments；exec.input 不是读数来源。
      const 只有input = { name: 'read', input: { file_path: join(项目目录, 'src', 'a.js') }, agent: { session: { id: 'reviewer', header: { origin: 'subagent', cwd: 项目目录 } } } };
      const input拒 = 闸(host, 只有input);
      assert.ok(typeof input拒 === 'string' && /unknown/.test(input拒), `exec.input 不算读数 ⇒ unknown 拒：${input拒}`);
      // 无 path 且无 cwd：不许退回 header.cwd 乱猜，也不许放行。
      const 无cwd = { name: 'glob', arguments: { pattern: '**/*' }, agent: { session: { id: 'reviewer', header: { origin: 'subagent' } } } };
      const 无cwd拒 = 闸(host, 无cwd);
      assert.ok(typeof 无cwd拒 === 'string' && /unknown/.test(无cwd拒), `无 cwd ⇒ unknown 拒：${无cwd拒}`);
    } finally { await f.cleanup(); }
  });

  it('工具总范围「未配置」早退不许跳过角色闸：复核员写仍拒、无授权引用时读也明确拒', async () => {
    const f = await makeFixture();
    // 删掉出厂 工具总范围.json ⇒ 刷新后 ENVELOPE_STATE 状态为「未配置」。
    const { rm } = await import('node:fs/promises');
    await rm(join(f.factoryRoot, '集体L2-共享基础设施', 'defaults', '工具总范围.json'), { force: true });
    const 项目目录 = join(f.home, 'project');
    await mkdir(join(项目目录, 'src'), { recursive: true });
    await writeFile(join(项目目录, 'src', 'a.js'), 'export const a = 1;\n', 'utf8');
    const host = fakeHost();
    try {
      await plugin.apply(host.ctx, { home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot });
      const 写 = 闸(host, 复核exec('write', { file_path: join(项目目录, 'src', 'a.js'), 内容: 'x' }, 项目目录));
      assert.ok(typeof 写 === 'string' && /只读闭名单/.test(写), '范围未配置时角色闸仍须拒写');
      // 读也不再是「整个工作区放行」：没有授权产出引用就明确拒并指路 Lead attach。
      const 读 = 闸(host, 复核exec('read', { file_path: join(项目目录, 'src', 'a.js') }, 项目目录));
      assert.ok(typeof 读 === 'string' && /授权产出引用/.test(读), `无授权引用时读必须明确拒：${读}`);
    } finally {
      host.清理();
      await f.cleanup();
    }
  });

  it('同一 guard 分别判普通成员/Lead：无任务成员写拒，Lead 不进入成员闭名单', async () => {
    const { f, host, 项目目录 } = await 起现场();
    try {
      const 普通成员 = { name: 'write', arguments: { file_path: join(项目目录, 'src', 'a.js'), 内容: 'x' }, agent: { session: { id: 'member-a', header: { origin: 'subagent', cwd: 项目目录 } } } };
      assert.match(闸(host, 普通成员), /成员工具闸.*本人真实绑定/, '普通成员由自己的任务文件范围闸拒绝，不能因非复核岗而裸写');
      const lead = { name: 'write', arguments: { file_path: join(项目目录, 'src', 'a.js'), 内容: 'x' }, agent: { session: { id: 'lead', header: { cwd: 项目目录 } } } };
      assert.equal(闸(host, lead), undefined, 'Lead 不进入复核员闭名单');
    } finally { await f.cleanup(); }
  });

  it('scope 内 mind 动作仍通：复核员经真 guard 做 task_start / task_submit / task_review 全链路', async () => {
    const { f, host, 项目目录 } = await 起现场();
    try {
      const 工具 = host.工具.get('mind');
      const 跑 = async (exec, args) => JSON.parse(await 工具.execute({ ...args, project: 'guard-proj' }, exec));
      const leadExec = { name: 'mind', arguments: {}, agent: { session: { id: 'lead-guard', header: { cwd: 项目目录 } } } };
      const memberExec = { name: 'mind', arguments: {}, agent: { session: { id: 'member-a', header: { origin: 'subagent', cwd: 项目目录 } } } };
      const reviewerExec = { name: 'mind', arguments: {}, agent: { session: { id: 'reviewer', header: { origin: 'subagent', cwd: 项目目录 } } } };

      // 业务节点：Lead 建/派/绑，member-a 开工交卷。
      const 业务 = await 跑(leadExec, { action: 'task_create', 描述: 'guard-业务', 负责人: 'member-a', 判据: '可验' });
      assert.equal(业务.成功, true, JSON.stringify(业务));
      const 业务id = 业务.节点.id;
      assert.equal((await 跑(leadExec, { action: 'task_dispatch', id: 业务id })).成功, true);
      assert.equal((await 跑(leadExec, { action: 'task_bind', id: 业务id, 实例: 'member-a', 岗位: '插件工程' })).成功, true);
      assert.equal((await 跑(memberExec, { action: 'task_start', id: 业务id })).成功, true);
      assert.equal((await 跑(memberExec, { action: 'task_submit', id: 业务id, 结论: '交付' })).成功, true);

      // 复核任务：显式复核对象 = 业务节点；绑定复核实例后派发。
      const 复核任务 = await 跑(leadExec, { action: 'task_create', 描述: 'guard-复核', 负责人: '复核员', 判据: '核对', 复核对象: 业务id });
      assert.equal(复核任务.成功, true, JSON.stringify(复核任务));
      const 复核id = 复核任务.节点.id;
      assert.equal((await 跑(leadExec, { action: 'task_bind', id: 复核id, 实例: 'reviewer', 岗位: '复核员' })).成功, true);
      assert.equal((await 跑(leadExec, { action: 'task_dispatch', id: 复核id })).成功, true);

      // 复核员在自己的复核任务上开工/交报告，并对业务节点落复核结论——都经 guard 的 mind 放行。
      assert.equal((await 跑(reviewerExec, { action: 'task_start', id: 复核id })).成功, true, '复核员 task_start（自有复核节点）应通');
      assert.equal((await 跑(reviewerExec, { action: 'task_submit', id: 复核id, 结论: '已核' })).成功, true, '复核员 task_submit（交报告）应通');
      const 核 = await 跑(reviewerExec, { action: 'task_review', id: 业务id, 三态: '过' });
      assert.equal(核.成功, true, JSON.stringify(核));
      assert.equal(核.结论.算通过, true);
    } finally { await f.cleanup(); }
  });

  it('正式入口 task_attach：Lead 授目录 ⇒ 复核员 read 通；成员不能给自己扩读根；私有根拒', async () => {
    const { f, host, 项目目录 } = await 起现场({ 附读根: false });
    try {
      const 工具 = host.工具.get('mind');
      const 跑 = async (exec, args) => JSON.parse(await 工具.execute({ ...args, project: 项目键 }, exec));
      const leadExec = { name: 'mind', arguments: {}, agent: { session: { id: 'lead-attach', header: { cwd: 项目目录 } } } };
      const memberExec = { name: 'mind', arguments: {}, agent: { session: { id: 'member-a', header: { origin: 'subagent', cwd: 项目目录 } } } };
      await writeFile(join(项目目录, '其他.txt'), 'outside\n', 'utf8');
      const 源目录 = join(项目目录, 'src');

      // 反例：成员不能调用授权动作给自己扩读根。
      const 成员附 = await 跑(memberExec, { action: 'task_attach', id: 'rev-1', 产出物引用: 源目录 });
      assert.equal(成员附.成功, false, '成员调用 task_attach 必须被拒');
      // 反例（服务层）：绕过动作面直接 attach(读根=true) 也必须拒——不能靠动作层单点。
      const org = await shareOrg({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot });
      await assert.rejects(
        () => org.tasks.attach('rev-1', { subject: { id: 'member-a', kind: '成员', roleId: '插件工程' }, 项目: 项目键, 产出物: 源目录, 读根: true }),
        (e) => e instanceof Denied && /仅 Lead/.test(e.rule),
        '成员不能通过服务层给自己扩复核读根',
      );
      // 反例：私有区原始根不能作为读根（连 Lead 也不行）。
      const 私有附 = await 跑(leadExec, { action: 'task_attach', id: 'rev-1', 产出物引用: join(f.privateRoot, '身份档案', 'identity.json') });
      assert.equal(私有附.成功, false, '私有组织根不许作为复核读根');
      // 反例：不存在的路径 / 相对散文不猜。
      const 不存在 = await 跑(leadExec, { action: 'task_attach', id: 'rev-1', 产出物引用: join(项目目录, '不存在目录') });
      assert.equal(不存在.成功, false, '不存在的读根必须拒');

      // 正例：Lead 通过正式入口附真实源码目录 ⇒ 复核员 read 通。
      const 附 = await 跑(leadExec, { action: 'task_attach', id: 'rev-1', 产出物引用: 源目录 });
      assert.equal(附.成功, true, JSON.stringify(附));
      assert.equal(闸(host, 复核exec('read', { file_path: join(源目录, 'a.js') }, 项目目录)), undefined, '授权目录内 read 通');
      // 未授予的项目根其他文件仍拒（授权只到 src，不外溢）。
      const 外溢 = 闸(host, 复核exec('read', { file_path: join(项目目录, '其他.txt') }, 项目目录));
      assert.ok(typeof 外溢 === 'string' && /授权产出引用/.test(外溢), `未授权文件仍拒：${外溢}`);
    } finally { await f.cleanup(); }
  });

  it('合法授予私有区父目录不放行递归 raw 搜索；非私有源码搜索正对照保留', async () => {
    const { f, host, 项目目录 } = await 起现场();
    try {
      const tool = host.工具.get('mind');
      const lead = { name: 'mind', agent: { session: { id: 'lead', header: { cwd: 项目目录 } } } };
      const args = { action: 'task_attach', id: 'rev-1', 产出物引用: f.home };
      const granted = JSON.parse(await tool.execute(args, { ...lead, arguments: args }));
      assert.equal(granted.成功, true, JSON.stringify(granted));
      await writeFile(join(f.privateRoot, 'raw-sentinel.txt'), 'private-sentinel-unique', 'utf8');
      for (const 工具 of ['grep', 'glob']) {
        const 结果 = 闸(host, 复核exec(工具, { path: f.home, pattern: 'private-sentinel-unique' }, 项目目录));
        assert.match(结果, /父目录递归搜索/, '合法父读根也不能把 raw 子树带入搜索');
        assert.equal(闸(host, 复核exec(工具, { path: 项目目录, pattern: '*.js' }, 项目目录)), undefined, '源码正对照仍允许');
      }
      assert.equal(闸(host, 复核exec('read', { file_path: join(项目目录, 'src', 'a.js') }, 项目目录)), undefined);
    } finally { host.清理(); await f.cleanup(); }
  });

  it('旧 live Registry 没有 snapshotSync 方法仍可用新纯 reader（热重载混合代恢复回归）', async () => {
    const { f, host, 项目目录 } = await 起现场();
    try {
      const org = await shareOrg({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot });
      assert.equal(typeof org.registry.snapshotSync, 'function', '前提：新 Registry 有同步快照方法');
      // 类方法在原型上，delete 不掉；用自身属性遮蔽成 undefined 模拟「热重载后仍是旧缓存对象」。
      org.registry.snapshotSync = undefined;
      assert.equal(typeof org.registry.snapshotSync, 'undefined', '模拟热重载后仍是旧缓存 Registry 对象');
      // guard 改用 src/instance-snapshot.js 的新鲜文件读 ⇒ 不依赖 live 对象 method。
      assert.equal(闸(host, 复核exec('read', { file_path: join(项目目录, 'src', 'a.js') }, 项目目录)), undefined, '旧对象无 method 仍可读授权源码');
      const 写 = 闸(host, 复核exec('write', { file_path: join(项目目录, 'src', 'a.js'), 内容: 'x' }, 项目目录));
      assert.ok(typeof 写 === 'string' && /只读闭名单/.test(写), '旧对象无 method 时写仍拒');
      const 账本 = 闸(host, 复核exec('read', { file_path: join(f.privateRoot, '身份档案', 'identity.json') }, 项目目录));
      assert.ok(typeof 账本 === 'string' && /私有区/.test(账本), '旧对象无 method 时 raw 私有账仍拒');
    } finally { await f.cleanup(); }
  });
});
