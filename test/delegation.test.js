/**
 * Lead 自主调度（2026-10-15 主权者授权「由 lead 根据需求判断使用团队或子智能体或都不使用」）：
 *  三层判据——①授权真源 DelegationPolicy（配置非法=未授权，fail-closed）；
 *  ②统一入口 member_spawn/message/stop/list（适配器直调服务不过 tools 管线 ⇒ 每个入口
 *    显式过同一道授权闸；半途失败如实报阶段，不把半成品报成就绪）；
 *  ③内核接线（提示词唯一改动点 + 创建闸 + 宿主服务束）。
 * 官方契约依据：成员研究简表（host-contract-reader，2026-10-15）——waterfall 须 await next()
 * 改返回值、team:policy 是 Team 成员唯一段而普通子会话为零段、Team 成员必须走 Team 邮箱。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, LEAD, MEMBER } from './helpers.mjs';
import { Org } from '../src/org.js';
import { DelegationPolicy } from '../src/delegation-policy.js';
import { projectKeyForPath } from '../src/project-identity.js';
import { runAction } from '../lib/actions.js';
import { fakeHost, fakeExec } from './host-harness.mjs';
import * as kernel from '../components/kernel/lib/index.js';
import { shareOrg } from '../src/runtime.js';
import { drainKernelAudit } from './kernel-drain.mjs';
import { writeUnder } from './helpers.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const FACTORY = join(here, '..', 'mind');
const P = 'plug';
// 新构建（2026-10-17 app.asar）teamPolicy 的文本形状：授权闸句已被上游删除，纯协作纪律。
const OFFICIAL = 'Agent Teams is available in this session\n\nThe Team Lead and all teammates share the same working directory and filesystem. Edits are immediately visible to every member.\n\nKeep the official tail.';
const 授权配置 = { mode: 'lead-discretion', projects: [P], authorizationRef: 'test-grant' };

/** 造假宿主服务束：记录调用、可控名册，不碰真实执行体。 */
function 假宿主({ delegation = new DelegationPolicy(授权配置), agent = { id: LEAD.id, session: { id: LEAD.id, header: { id: LEAD.id } } }, team = [], kids = [] } = {}) {
  const calls = { spawn: [], teamSend: [], subSend: [], interrupts: [] };
  const agentTeams = {
    spawnTeammate: async (_caller, req) => { calls.spawn.push(req); return { member: { id: `team-${calls.spawn.length}`, name: req.name } }; },
    sendMessage: async (_caller, req) => { calls.teamSend.push(req); return { messageId: `tm-${calls.teamSend.length}` }; },
    listMembers: () => team,
    interrupt: (_caller, name) => { calls.interrupts.push(name); return { previousStatus: 'running' }; },
  };
  const subagents = {
    // 契约桩（2026-10-18 换代后）：只认 startContinuable/drainContinuableChildren；校验顶层 spec.signal 在场（宿主类型里它是必填）。
    startContinuable: async (spec) => {
      if (!(spec?.signal instanceof AbortSignal)) throw new Error('contract: spec.signal required');
      assert.equal(Object.hasOwn(spec.request, 'signal'), false, 'continuable signal belongs to outer spec');
      calls.spawn.push(spec); return { childId: `sub-${calls.spawn.length}`, messageId: 'm0' };
    },
    sendMessage: async (_sender, id, content) => { calls.subSend.push({ id, content }); return `sm-${calls.subSend.length}`; },
    interrupt: (id) => { calls.interrupts.push(id); },
    drainContinuableChildren: async (_parent, ids) => { calls.interrupts.push(...ids); },
    listChildren: async () => kids,
  };
  return { 宿主: { project: P, agent, agents: { get: id => id === agent.id ? agent : undefined }, agentTeams, subagents, delegation }, calls };
}

describe('DelegationPolicy · 授权真源', () => {
  it('坏配置一律拒载：未知键 / 坏档位 / 缺范围或缺授权依据 / 坏项目键', () => {
    assert.throws(() => new DelegationPolicy({ mode: 'always' }), /mode/);
    assert.throws(() => new DelegationPolicy({ foo: 1 }), /未知配置键/);
    assert.throws(() => new DelegationPolicy({ mode: 'lead-discretion' }), /projects 范围与 authorizationRef/);
    assert.throws(() => new DelegationPolicy({ mode: 'lead-discretion', projects: ['a/b'] }), /路径片段/);
  });

  it('authorize：仅 Lead、仅授权项目；关闭后硬拒', () => {
    const p = new DelegationPolicy(授权配置);
    assert.throws(() => p.authorize({ subject: MEMBER, project: P }), /不得自行再起成员/);
    assert.throws(() => p.authorize({ subject: LEAD, project: 'other' }), /没有有效/);
    assert.equal(p.authorize({ subject: LEAD, project: P }).fingerprint, p.fingerprint);
    p.close();
    assert.throws(() => p.authorize({ subject: LEAD, project: P }), (e) => e.code === 'DELEGATION_DISPOSED');
  });

  it('creationGuard：授权项目内挡裸创建并指回 member_spawn；未授权项目保持官方默认', () => {
    const p = new DelegationPolicy(授权配置);
    assert.equal(p.creationGuard({ name: 'read' }, { subject: LEAD, project: P }), undefined);
    assert.equal(p.creationGuard({ name: 'spawn_teammate' }, { subject: LEAD, project: 'other' }), undefined);
    assert.match(p.creationGuard({ name: 'spawn_teammate' }, { subject: LEAD, project: P }), /member_spawn/);
    assert.match(p.creationGuard({ name: 'workflow' }, { subject: LEAD, project: P }), /member_spawn/);
    assert.match(p.creationGuard({ name: 'subagent' }, { subject: MEMBER, project: P }), /仅允许 Lead/);
  });

  it('assemble：仅对授权项目的 Team 成员原位改写首段；其余原样返回；漂移/缺段/重段硬拒', () => {
    const p = new DelegationPolicy(授权配置);
    const 装配 = { sections: [{ name: 'mind:organization', text: '组织说明' }, { name: 'team:policy', text: OFFICIAL }], tools: [{ name: 'mind' }], contexts: [{ name: 'c' }], variables: { model: 'x' } };
    assert.equal(p.assemble(装配, { project: P, isTeam: false }), 装配, '非 Team 作用域不动');
    assert.equal(p.assemble(装配, { project: 'other', isTeam: true }), 装配, '未授权项目不动');
    const out = p.assemble(装配, { project: P, isTeam: true });
    assert.notEqual(out, 装配);
    assert.equal(out.sections[0], 装配.sections[0], '其余段原对象保留');
    assert.equal(out.tools, 装配.tools, 'tools/contexts/variables 不许丢');
    assert.ok(out.sections[1].text.startsWith(`[${DelegationPolicy.generation}]`), '组织授权头前置');
    // 契约换代（2026-10-17）：上游删掉授权闸句 ⇒ 拼接改为「头前置+官方全文逐字保留」。
    // 判据是「官方文本逐字在案」，不再是「闸句被换掉」（旧断言随旧契约退役）。
    assert.ok(out.sections[1].text.endsWith(OFFICIAL), '官方全文逐字保留在授权头之后');
    assert.ok(out.sections[1].text.includes('The Team Lead and all teammates share the same working directory'), '官方协作纪律原样在');
    // v2（口述收敛 2026-10-18 条目1/3）：提示词里**不许**再出现「复核员任命需要主权者授权」——
    // 复核员是普通岗位卡，独立性靠冲突排除 + 冻结判据。这句提示词若回来，模型就会照做，
    // 等于把已砍掉的任命闸从提示词里复活。
    assert.equal(/Reviewer appointments still require/i.test(out.sections[1].text), false, '不再宣称复核任命需授权');
    assert.match(out.sections[1].text, /Reviewers are ordinary role cards/, '按 v2 口径写明复核员是普通岗');
    assert.match(out.sections[1].text, /conflict exclusion/, '独立性由冲突排除承担');
    assert.throws(() => p.assemble({ sections: [] }, { project: P, isTeam: true }), (e) => e.code === 'DELEGATION_TEAM_POLICY');
    assert.throws(() => p.assemble({ sections: [{ name: 'team:policy', text: OFFICIAL }, { name: 'team:policy', text: OFFICIAL }] }, { project: P, isTeam: true }), (e) => e.code === 'DELEGATION_TEAM_POLICY');
    assert.throws(() => p.assemble({ sections: [{ name: 'team:policy', text: '上游改了措辞' }] }, { project: P, isTeam: true }), (e) => e.code === 'DELEGATION_UPSTREAM_POLICY_DRIFT');
  });
});

describe('member_* 动作 · 统一治理入口', () => {
  const 岗位卡 = '集体L3-成员角色卡/插件工程.md';
  const 岗位卡正文 = '---\nid: 插件工程\nkind: 身份\nauthority: 自治\nzone: 出厂\ndomain: 个体\nversion: 1\n---\n# 插件工程\n\n## 个体L0 · 身份\n成员岗，实例临时。\n\n## 个体L1 · 规则\n单源、唯一入口、不留残骸。\n\n## 个体L2 · 能力\n（引用能力库条目 id）\n\n## 个体L3 · 经验\n（引用经验条目 id）\n';
  async function 现场Org() {
    const f = await makeFixture({ rules: { [岗位卡]: 岗位卡正文 } });
    const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
    return { f, org };
  }
  async function 建待发节点(org, 描述 = '调度验证任务') {
    return org.tasks.create({ subject: LEAD, 项目: P, 描述, 负责人: ['插件工程'], 判据: ['判据甲', '判据乙'] });
  }
  const 执行 = (org, 宿主, args, 主体 = LEAD) => runAction({ org, 项目: P, 主体, subject: 主体, args, 宿主 });

  it('member_spawn（team）：启动自检→登记→绑定→装载→开工，全链路落账', async () => {
    const { f, org } = await 现场Org();
    try {
      const { 宿主, calls } = 假宿主();
      const 节点 = await 建待发节点(org);
      const r = await 执行(org, 宿主, { action: 'member_spawn', 方式: 'team', 岗位: '插件工程', 节点: 节点.id, 任务书: '做甲事' });
      assert.equal(r.已登记, true);
      assert.equal(r.已派发, true);
      assert.equal(r.已发开工书, true);
      assert.equal(r.实例, 'team-1');
      assert.equal((await org.registry.identity()).members['team-1'].status, '在岗');
      const after = await org.tasks.get(节点.id, { 项目: P });
      assert.equal(after.状态, '已派发');
      // v2 条目11：负责人**保留岗位名**（「这一岗」），实例进独立的 `绑定` 字段——
      // 修前这里 reassign 成 ['team-1']，等于把一岗收成一人的记录。
      assert.deepEqual(after.负责人, ['插件工程'], '负责人仍是岗位名');
      assert.deepEqual(after.绑定.map((b) => b.实例), ['team-1'], '实例绑到节点上');
      assert.equal(calls.spawn[0].prompt[0].text, calls.spawn[0].prompt[0].text);
      assert.match(calls.spawn[0].prompt[0].text, /启动自检/);
      assert.equal(calls.teamSend[0].target, r.名, '开工消息按 Team 名发送');
      assert.match(calls.teamSend[0].content[0].text, /判据甲/);
      assert.match(calls.teamSend[0].content[0].text, /task_start/);
      assert.match(calls.teamSend[0].content[0].text, /做甲事/);
    } finally { await f.cleanup(); }
  });

  it('开工书只取实例钉住快照：get=v2 / cardOf=v1 ⇒ 只注入 v1（含完整 L0/L1），不混现行正文', async () => {
    const { f, org } = await 现场Org();
    try {
      const { 宿主, calls } = 假宿主();
      const 节点 = await 建待发节点(org);
      const v1段 = {
        '个体L0 · 身份核心': '我是 v1 的插件工程。',
        '个体L1 · 规则': '1. v1-先搜后写。\n2. v1-不碰判据、不改交卷人。',
      };
      // 「现行卡」必须是**真实完整的 v2 卡**（正文 + 由正文派生的段/能力引用同源）：手捏一个
      // 只带 id/段/能力的无正文空壳卡，会让钉版自校当场拒（补修J card-credential 单源）——
      // 那是**假初态**抢命中，测不到本用例真正要测的「开工书只取钉住快照」这一层。
      // 于是写真实卡文件、再用 registry.get 读回（不手填摘要/hash）。
      // 段标题与夹具卡同名（两区合并按段名覆盖；不同名会两段并存、section 先命中出厂那段）。
      const v2正文 = '---\nid: 插件工程\nkind: 身份\nauthority: 自治\nzone: 出厂\ndomain: 个体\nversion: 2\n---\n# 插件工程\n\n## 个体L0 · 身份\n我是 v2 的插件工程。\n\n## 个体L1 · 规则\n1. v2-先写后搜。\n\n## 个体L2 · 能力\n- `danger-v2`\n\n## 个体L3 · 经验\n（引用经验条目 id）\n';
      await writeUnder(f.privateRoot, 岗位卡, v2正文);
      const v2卡 = await org.registry.get({ id: '插件工程' });
      assert.match(String(v2卡?.正文), /v2-先写后搜/, '前提：现行卡确已是 v2（真实完整卡，不是空壳桩）');
      assert.ok((v2卡?.能力引用 ?? []).includes('danger-v2'), '前提：v2 能力引用由正文派生（单源）');
      const 真cardOf = org.registry.cardOf.bind(org.registry);
      org.registry.cardOf = async (id) => (id === 'team-1'
        ? { 就绪: true, 岗位: '插件工程', 段: v1段, 能力引用: ['policy-decision'], 卡版本: { 摘要: 'v1digest0000' } }
        : 真cardOf(id));
      await 执行(org, 宿主, { action: 'member_spawn', 方式: 'team', 岗位: '插件工程', 节点: 节点.id, 任务书: '做乙事' });
      const 书 = calls.teamSend[0].content[0].text;
      assert.match(书, /v1-先搜后写/, '规程正文取钉住快照');
      assert.match(书, /v1-不碰判据、不改交卷人/, 'L1 规则完整附上、不被截断');
      assert.match(书, /v1digest/, '卡版本摘要来自实例钉住的那一版');
      assert.doesNotMatch(书, /v2-先写后搜/, '不许把现行 get 的正文混进来');
      assert.doesNotMatch(书, /danger-v2/, '能力引用同样只取钉住版');
      assert.match(书, /policy-decision/, '能力只引用、不内嵌正文');
    } finally { await f.cleanup(); }
  });

  it('卡钉版未就绪 ⇒ member_spawn 明确失败、不发假开工书（实例已登记、阶段可读）', async () => {
    const { f, org } = await 现场Org();
    try {
      const { 宿主, calls } = 假宿主();
      const 节点 = await 建待发节点(org);
      const 真cardOf = org.registry.cardOf.bind(org.registry);
      org.registry.cardOf = async (id) => (id === 'team-1'
        ? { 就绪: false, 岗位: '插件工程', 段: null, 能力引用: null, 卡版本: null, 原因: '卡快照缺失' }
        : 真cardOf(id));
      await assert.rejects(
        () => 执行(org, 宿主, { action: 'member_spawn', 方式: 'team', 岗位: '插件工程', 节点: 节点.id, 任务书: '做丙事' }),
        (e) => e.code === 'MEMBER_SPAWN_CARD_NOT_READY' && /未就绪/.test(e.message),
      );
      assert.equal(calls.teamSend.length, 0, '未就绪不许发任何开工书');
    } finally { await f.cleanup(); }
  });

  it('member_spawn（subagent）：走 startContinuable 且 parent 是真实 Agent', async () => {
    const { f, org } = await 现场Org();
    try {
      const { 宿主, calls } = 假宿主();
      const 节点 = await 建待发节点(org);
      const r = await 执行(org, 宿主, { action: 'member_spawn', 方式: 'subagent', 岗位: '插件工程', 节点: 节点.id, 任务书: '做乙事' });
      assert.equal(r.实例, 'sub-1');
      assert.equal(calls.spawn[0].request.parent, 宿主.agent, '必须传原始 exec.agent，不能传组织主体');
      assert.equal(calls.subSend[0].id, 'sub-1');
    } finally { await f.cleanup(); }
  });

  it('member_spawn 模型路由（subagent）：agentOptions 原样透传给宿主；缺省不携带（与既往逐字节一致）', async () => {
    const { f, org } = await 现场Org();
    try {
      const { 宿主, calls } = 假宿主();
      const 节点A = await 建待发节点(org, '带路由的评审任务');
      const r = await 执行(org, 宿主, { action: 'member_spawn', 方式: 'subagent', 岗位: '插件工程', 节点: 节点A.id, 任务书: '评审', 模型供应商: 'openai-codex', 模型: 'gpt-6.1-sol' });
      assert.deepEqual(calls.spawn[0].request.agentOptions, { provider: 'openai-codex', model: 'gpt-6.1-sol' },
        '路由须原样进 agentOptions（宿主 resolveChildAgentOptions 消费它覆盖继承路由）');
      assert.deepEqual(r.模型路由, { provider: 'openai-codex', model: 'gpt-6.1-sol' }, '回执带出路由，可入审计/transcript 对账');
      const 节点B = await 建待发节点(org, '不带路由的默认任务');
      const r2 = await 执行(org, 宿主, { action: 'member_spawn', 方式: 'subagent', 岗位: '插件工程', 节点: 节点B.id, 任务书: '默认' });
      assert.ok(!('agentOptions' in calls.spawn[1].request), '缺省不携带 agentOptions——子会话继承父路由，与既往行为逐字节一致');
      assert.ok(!('模型路由' in r2), '缺省回执不带 模型路由 字段');
    } finally { await f.cleanup(); }
  });

  it('member_spawn 模型路由的响亮失败：team 路带路由 ⇒ 拒且零创建；路由缺一半 ⇒ 拒且零创建；推理档随路由透传', async () => {
    const { f, org } = await 现场Org();
    try {
      const { 宿主, calls } = 假宿主();
      const 节点A = await 建待发节点(org, 'team 带路由');
      await assert.rejects(
        () => 执行(org, 宿主, { action: 'member_spawn', 方式: 'team', 岗位: '插件工程', 节点: 节点A.id, 任务书: 'x', 模型供应商: 'openai-codex', 模型: 'gpt-6.1-sol' }),
        (e) => e.code === 'INVALID_BODY' && /team 不支持模型路由/.test(e.message) && e.detail.阶段 === 'precheck',
      );
      assert.equal(calls.spawn.length, 0, '拒绝发生在起执行体之前——不许「先造再杀」（R19 同款纪律）');
      const 节点B = await 建待发节点(org, '路由缺一半');
      await assert.rejects(
        () => 执行(org, 宿主, { action: 'member_spawn', 方式: 'subagent', 岗位: '插件工程', 节点: 节点B.id, 任务书: 'x', 模型: 'gpt-6.1-sol' }),
        (e) => e.code === 'INVALID_BODY' && /成对/.test(e.message),
      );
      assert.equal(calls.spawn.length, 0);
      const 节点C = await 建待发节点(org, '带推理档');
      await 执行(org, 宿主, { action: 'member_spawn', 方式: 'subagent', 岗位: '插件工程', 节点: 节点C.id, 任务书: 'x', 模型供应商: 'kimi-coding', 模型: 'k3-256k', 推理档: 'high' });
      assert.deepEqual(calls.spawn[0].request.agentOptions, { provider: 'kimi-coding', model: 'k3-256k', reasoningEffort: 'high' }, '推理档随路由透传（缺省则子会话用所选模型默认档）');
    } finally { await f.cleanup(); }
  });

  it('member_spawn 部分失败①：登记失败 ⇒ 报阶段并补偿停用，不报就绪', async () => {
    const { f, org } = await 现场Org();
    try {
      const { 宿主, calls } = 假宿主();
      const 原assign = org.registry.assign.bind(org.registry);
      org.registry.assign = async (spec) => { throw new Error('注入：登记失败'); };
      const 节点 = await 建待发节点(org);
      await assert.rejects(
        () => 执行(org, 宿主, { action: 'member_spawn', 方式: 'team', 岗位: '插件工程', 节点: 节点.id, 任务书: 'x' }),
        (e) => e.code === 'MEMBER_SPAWN_ASSIGN_FAILED' && e.detail.阶段 === 'registry_assign' && e.detail.实例 === 'team-1',
      );
      org.registry.assign = 原assign;
      assert.ok(calls.interrupts.length >= 1, '补偿停用已请求');
      assert.equal((await org.tasks.get(节点.id, { 项目: P })).状态, '待派发', '节点不被半成品污染');
    } finally { await f.cleanup(); }
  });

  it('member_spawn 部分失败②：派发失败 ⇒ 实例已登记如实报，不回滚也不报就绪', async () => {
    const { f, org } = await 现场Org();
    try {
      const { 宿主 } = 假宿主();
      org.tasks.dispatch = async () => { throw new Error('注入：派发失败'); };
      const 节点 = await 建待发节点(org);
      await assert.rejects(
        () => 执行(org, 宿主, { action: 'member_spawn', 方式: 'subagent', 岗位: '插件工程', 节点: 节点.id, 任务书: 'x' }),
        (e) => e.code === 'MEMBER_SPAWN_DISPATCH_FAILED' && e.detail.已登记 === true && e.detail.实例 === 'sub-1',
      );
      assert.equal((await org.registry.identity()).members['sub-1'].status, '在岗', '登记是既成事实，报阶段而非静默回滚');
    } finally { await f.cleanup(); }
  });

  it('未授权 / 非主体 / 宿主缺线：全部响亮拒', async () => {
    const { f, org } = await 现场Org();
    try {
      const 节点 = await 建待发节点(org);
      const 未授权 = 假宿主({ delegation: new DelegationPolicy({}) });
      await assert.rejects(() => 执行(org, 未授权.宿主, { action: 'member_spawn', 方式: 'team', 岗位: '插件工程', 节点: 节点.id, 任务书: 'x' }), (e) => /没有有效.*Lead 自主调度/.test(e.message));
      const 无策略 = 假宿主({ delegation: null });
      await assert.rejects(() => 执行(org, 无策略.宿主, { action: 'member_spawn', 方式: 'team', 岗位: '插件工程', 节点: 节点.id, 任务书: 'x' }), (e) => e.code === 'DELEGATION_NOT_WIRED');
      const 有授权 = 假宿主();
      await assert.rejects(() => 执行(org, 有授权.宿主, { action: 'member_spawn', 方式: 'team', 岗位: '插件工程', 节点: 节点.id, 任务书: 'x' }, MEMBER), /不得自行再起成员/);
      await assert.rejects(() => 执行(org, 无策略.宿主, { action: 'delegation_status' }), (e) => e.code === 'DELEGATION_NOT_WIRED');
    } finally { await f.cleanup(); }
  });

  it('member_message/stop：Team 成员按名走 Team 邮箱，普通实例走子会话服务', async () => {
    const { f, org } = await 现场Org();
    try {
      const { 宿主, calls } = 假宿主({ team: [{ id: 'team-1', role: 'teammate', name: 'member-x', status: 'inactive' }] });
      await org.registry.assign({ subject: LEAD, 岗位: '插件工程', 实例: 'team-1' });
      await org.registry.assign({ subject: LEAD, 岗位: '插件工程', 实例: 'sub-9' });
      for (const 实例 of ['team-1', 'sub-9']) {
        const node = await 建待发节点(org, `维护 ${实例}`);
        await org.tasks.bind(node.id, { subject: LEAD, 项目: P, 实例, 岗位: '插件工程' });
        await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
      }
      宿主.subagents.listChildren = async () => [{ id: 'sub-9', mode: 'continuable' }];
      const r1 = await 执行(org, 宿主, { action: 'member_message', 实例: 'team-1', 内容: '进展如何' });
      assert.equal(r1.通道, 'team');
      assert.equal(calls.teamSend[0].target, 'member-x', '按实例 id 查真实名，不猜');
      assert.equal(calls.subSend.length, 0, 'Team 成员不许绕过 Team 邮箱走普通服务');
      const r2 = await 执行(org, 宿主, { action: 'member_message', 实例: 'sub-9', 内容: '继续' });
      assert.equal(r2.通道, 'subagent');
      assert.equal(calls.subSend[0].id, 'sub-9');
      await 执行(org, 宿主, { action: 'member_stop', 实例: 'team-1' });
      assert.deepEqual(calls.interrupts, ['member-x']);
      await 执行(org, 宿主, { action: 'member_stop', 实例: 'sub-9' });
      assert.deepEqual(calls.interrupts, ['member-x', 'sub-9']);
      await assert.rejects(() => 执行(org, 宿主, { action: 'member_message', 实例: '陌生id', 内容: 'x' }), /不在册/);
    } finally { await f.cleanup(); }
  });

  it('member_list / delegation_status：合并读数与授权读数', async () => {
    const { f, org } = await 现场Org();
    try {
      await org.registry.assign({ subject: LEAD, 岗位: '插件工程', 实例: 'team-1' });
      await org.registry.seal({ subject: LEAD, 实例: 'member-a', 理由: '测试' });
      const { 宿主 } = 假宿主({
        team: [{ id: 'team-1', role: 'teammate', name: 'member-x', status: 'inactive' }, { id: 'team-2', role: 'teammate', name: 'n2', status: 'running' }],
        kids: [{ id: 'kid-9', label: '普通子' }],
      });
      const node = await 建待发节点(org);
      await org.tasks.bind(node.id, { subject: LEAD, 项目: P, 实例: 'team-1', 岗位: '插件工程' });
      await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
      const r = await 执行(org, 宿主, { action: 'member_list' });
      const 按实例 = new Map(r.成员.map((m) => [m.实例, m]));
      assert.equal(按实例.get('team-1').来源, 'team');
      assert.equal(按实例.get('team-1').名, 'member-x');
      assert.equal(按实例.has('team-2'), false, '未登记未绑定的Team行不扩张组织读域');
      assert.equal(按实例.has('kid-9'), false, '原生子目录不是任务登记，不自动入册');
      assert.ok(!按实例.has('member-a'), '封存实例不列');
      const s = await 执行(org, 宿主, { action: 'delegation_status' });
      assert.equal(s.数据.mode, 'lead-discretion');
      assert.equal(s.数据.authorized, true);
      assert.deepEqual(s.数据.choices, ['direct', 'team', 'subagent']);
      assert.equal(s.数据.适配.agentTeams, true);
    } finally { await f.cleanup(); }
  });
});

describe('内核接线 · 提示词与创建闸', () => {
  async function 起内核(配置) {
    const home = await mkdtemp(join(tmpdir(), 'mind-deleg-'));
    await writeUnder(home, 'mind-private/README.md', '# 私有区（测试）\n');
    const host = fakeHost({ 提供服务: ['tools', 'commands', 'systemPrompt'], 服务: { agentTeams: { tryMembership: () => ({ role: 'lead' }) } } });
    await kernel.apply(host.ctx, { home, factoryRoot: FACTORY, privateRoot: join(home, 'mind-private'), delegation: 配置 });
    return { home, host };
  }

  it('授权项目：创建闸挡裸 spawn_teammate 并指回 member_spawn；waterfall 原位改写唯一策略段', async () => {
    // 授权本次完整工作目录对应的项目身份；不能再用 basename 合并同名项目。
    const 本次项目 = projectKeyForPath(process.cwd());
    const { home, host } = await 起内核({ mode: 'lead-discretion', projects: [本次项目], authorizationRef: 'test' });
    try {
      const exec = fakeExec({ name: 'spawn_teammate' });
      const reasons = host.闸.map((g) => g(exec)).filter(Boolean);
      assert.ok(reasons.some((r) => /member_spawn/.test(r)), `创建闸应指回 member_spawn：${reasons.join(' | ')}`);
      const listeners = host.钩子.get('system-prompt/assemble') ?? [];
      assert.equal(listeners.length, 1, '唯一提示词监听');
      const assembly = { sections: [{ name: 'team:policy', text: OFFICIAL }, { name: 'mind:organization', text: '组织说明' }], tools: [], contexts: [] };
      const context = { agent: { session: { header: { cwd: process.cwd() } } } };
      const out = await listeners[0](assembly, context, async () => assembly);
      assert.ok(out.sections[0].text.startsWith(`[${DelegationPolicy.generation}]`), 'Team 成员（tryMembership 命中）拿到改写后的策略');
      assert.equal(out.sections[1].text, '组织说明');
    } finally {
      host.清理();
      await drainKernelAudit(await shareOrg({ home, factoryRoot: FACTORY, privateRoot: join(home, 'mind-private') }));
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
    }
  });

  it('坏配置：响亮告警并按未授权降级（闸不拦、waterfall 不改写）', async () => {
    const { home, host } = await 起内核({ mode: 'always' });
    try {
      assert.ok(host.日志.some((l) => l.startsWith('error') && /delegation 配置非法/.test(l)), '坏配置必须留下 error 级告警');
      const exec = fakeExec({ name: 'spawn_teammate' });
      assert.deepEqual(host.闸.map((g) => g(exec)).filter(Boolean), [], '未授权 ⇒ 官方默认行为不动');
      const listeners = host.钩子.get('system-prompt/assemble') ?? [];
      const assembly = { sections: [{ name: 'team:policy', text: OFFICIAL }], tools: [], contexts: [] };
      const out = await listeners[0](assembly, { agent: { session: { header: { cwd: process.cwd() } } } }, async () => assembly);
      assert.equal(out, assembly, '未授权项目原样返回');
    } finally {
      host.清理();
      await drainKernelAudit(await shareOrg({ home, factoryRoot: FACTORY, privateRoot: join(home, 'mind-private') }));
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
    }
  });
});
