/** Public host lifecycle seam. A continuable child is never replaced by a one-shot run. */
import { Fault, InvalidBody } from '../src/kernel/errors.js';

const signalOf = host => host?.signal instanceof AbortSignal ? host.signal : new AbortController().signal;
const textId = value => typeof value === 'string' && value.trim() ? value : null;

export function requireDelegation({ host, subject, project }) {
  if (!host?.delegation) throw new Fault('DELEGATION_NOT_WIRED', '调度策略组件未随内核装载（旧内核或装配降级）。', { howToChange: '重启或修复 dsh-mind 内核组件。' });
  return host.delegation.authorize({ subject, project });
}

export function parseModelRoute(args, mode) {
  const provider = String(args?.模型供应商 ?? '').trim(), model = String(args?.模型 ?? '').trim(), effort = String(args?.推理档 ?? '').trim();
  if (!provider !== !model) throw new InvalidBody('模型路由要成对给：模型供应商 与 模型 缺一只给一个，子会话路由会变成半指定半继承的拼接怪。', { missing: [provider ? '模型' : '模型供应商'] });
  const route = provider ? { provider, model, ...(effort ? { reasoningEffort: effort } : {}) } : null;
  if (effort && !route) throw new InvalidBody('推理档随模型路由生效：单独给推理档没有路由可挂，必须同时给 模型供应商 + 模型（或三个都不给）。', { missing: ['模型供应商', '模型'], detail: { 阶段: 'precheck' } });
  if (route && mode === 'team') throw new InvalidBody('方式=team 不支持模型路由：宿主 Team 服务只转发 {prompt,parent}，agentOptions 会被静默丢弃——指定了路由却起默认模型等于冒充指定路由。改用 方式=subagent，或不带路由用 team。', { detail: { 阶段: 'precheck', 方式: mode } });
  return { 模型供应商: provider, 模型: model, 推理档: effort, 模型路由: route };
}

/**
 * 宿主能力探测（2026-11-19）：宿主每版都可能改/加/删方法，硬编码方法名会让 Mind
 * 在宿主一升级就整体失灵。这里只把「没有它就无法完成受管创建」的接口当硬要求，
 * 其余按可用性降级，并把降级事实交给调用方。
 */
export function hostCapabilities(host, mode = 'subagent') {
  const service = mode === 'team' ? host?.agentTeams : host?.subagents;
  const has = (key) => typeof service?.[key] === 'function';
  return Object.freeze({
    mode,
    service: Boolean(service),
    create: typeof host?.hostCreation?.prepare === 'function' && host?.hostCreation?.available?.(mode) === true,
    send: has('sendMessage'),
    list: mode === 'team' ? has('listMembers') : has('listChildren'),
    membership: has('tryMembership'),
    interrupt: has('interrupt'),
    release: has('drainContinuableChildren') ? 'drainContinuableChildren' : has('drainChildren') ? 'drainChildren' : null,
  });
}

export function assertExecutionHost(host, mode, council = false) {
  if (!host?.agent) throw new Fault('MEMBER_SPAWN_NO_AGENT', '宿主没有传真实 Agent。');
  const service = mode === 'team' ? host.agentTeams : host.subagents;
  if (!service) throw new Fault(mode === 'team' ? 'MEMBER_SPAWN_NO_TEAM_RUNTIME' : 'MEMBER_SPAWN_NO_SUBAGENT_RUNTIME', `宿主未装载 ${mode} 成员服务。`);
  const caps = hostCapabilities(host, mode);
  // 硬要求只有两件：官方创建通道 + 能把开工书写进 inbox 的 sendMessage。
  // 名册（listChildren/listMembers）缺失时，subagent 可按官方返回 id 登记并如实标注降级；
  // Team 没有名册无法解析 target，仍视为硬要求。释放/中断只在真用到时判。
  const missing = [];
  if (!caps.create) missing.push('官方创建通道');
  if (!caps.send) missing.push('sendMessage');
  if (mode === 'team' && !caps.list) missing.push('listMembers');
  if (missing.length) throw new Fault('MEMBER_SPAWN_CONTRACT', `宿主 ${mode} 服务缺少 ${missing.join('、')}：缺少就无法完成受管创建，已在创建前拒绝。`, { detail: { 阶段: 'precheck', 缺: missing, 能力: caps } });
  return caps;
}

async function creationRoster(host, mode, agent, signal) {
  const caps = hostCapabilities(host, mode);
  // 名册是「新直属成员」的证明，不是创建的前提。没有它时降级为「信官方返回值」，
  // 由调用方在结果里标注；绝不拿别的会话/岗位去猜归属。
  if (!caps.list) return { rows: null, degraded: `宿主未提供 ${mode === 'team' ? 'listMembers' : 'listChildren'}，未能核对直属目录` };
  let rows;
  if (mode === 'team') {
    const membership = host.agentTeams.tryMembership?.(agent);
    if (typeof host.agentTeams.tryMembership === 'function' && membership == null) rows = [];
    else {
      if (membership && membership.role !== 'lead') throw new Fault('MEMBER_SPAWN_CONTRACT', '当前父会话不是Team Lead。');
      rows = host.agentTeams.listMembers(agent);
    }
  } else rows = await host.subagents.listChildren(agent.session.id, signal);
  signal.throwIfAborted();
  if (!Array.isArray(rows) || rows.some(r => !textId(r?.id)) || new Set(rows.map(r => r.id)).size !== rows.length) throw new Fault('MEMBER_SPAWN_CONTRACT', '宿主直属目录不可判或标识重复，不能猜测本次创建归属。');
  return { rows, degraded: null };
}

/** Server-only one-use handle. Persist hostCall before execute; no child exists yet. */
export function prepareExecution({ host, mode, name, description, standby, modelRoute, beforeDispatch = async () => {} }) {
  assertExecutionHost(host, mode);
  const agent = host.agent, signal = signalOf(host);
  let before = null, used = false, degraded = null;
  const call = host.hostCreation.prepare({ mode, name, description, standby, modelRoute,
    // Revalidate only the immutable plan while the official body waits. Never
    // refresh the pre-creation catalog: that would reclassify a new child as old.
    whilePending: async () => { await beforeDispatch(); assertExecutionHost(host, mode); },
    beforeDispatch: async () => {
    await beforeDispatch();
    assertExecutionHost(host, mode);
    const roster = await creationRoster(host, mode, agent, signal);
    degraded = roster.degraded;
    before = roster.rows ? new Set(roster.rows.map(r => r.id)) : null;
    if (mode === 'team' && roster.rows?.some(r => r.name === name)) throw new Fault('MEMBER_SPAWN_CONTRACT', '宿主目录已存在本次Team名称；不能将既有成员当成本次创建。');
    await beforeDispatch();
    assertExecutionHost(host, mode);
  } });
  const hostCall = Object.freeze({ 版本: 1, 工具: call.tool, 调用id: call.callId });
  return Object.freeze({ hostCall, async execute() {
    if (used) throw new Fault('HOST_CREATION_UNAVAILABLE', '创建句柄已执行，不能重复创建。');
    used = true;
    const receipt = await call.execute();
    let id = null;
    let 返回字段 = null;
    try {
      if (receipt.callId !== call.callId || receipt.tool !== call.tool) throw Error('宿主调用关联不符');
      const value = receipt.value;
      返回字段 = value && typeof value === 'object' ? Object.keys(value) : typeof value;
      const roster = await creationRoster(host, mode, agent, signal);
      degraded = roster.degraded;
      const rows = roster.rows;
      if (mode === 'team') {
        // Official Team tools deliberately omit internal ids. Resolve their
        // exact target through the SAME parent's current authoritative roster,
        // not a model-provided id or an arbitrary same-name registry record.
        if (value?.member?.target !== name || value.member.role !== 'teammate' || !['running', 'inactive'].includes(value.member.status)) throw Error('Team工具未返回本次已创建成员的精确target');
        const matches = rows.filter(r => r.name === name);
        if (matches.length !== 1 || matches[0].role !== 'teammate' || !['running', 'inactive'].includes(matches[0].status)) throw Error('Team直属目录缺失、同名不唯一或成员未就绪');
        id = textId(matches[0].id);
      } else {
        // 宿主每版返回值形状可能变。rc.5 的官方 subagent 工具只回 { kind:'activation', name }，
        // **没有子会话 id**；Mind 需要的实例键是子会话 id，所以有直属目录时按名字解析，
        // 没有目录时只能明确失败——绝不把显示名当实例 id 登记。
        const 名称 = textId(value?.name);
        const 候选 = [value?.subagentId, value?.childSessionId, value?.sessionId, value?.id,
          value?.activation?.subagentId, value?.activation?.id, value?.session?.id]
          .filter((x) => typeof x === 'string' && x.trim());
        const 唯一 = [...new Set(候选)];
        if (唯一.length > 1) throw Error(`宿主返回了多个互不相同的实例标识（${唯一.join(' / ')}），不猜哪一个`);
        id = 唯一[0] ?? null;
        if (rows) {
          const 按id = id ? rows.filter(r => r.id === id) : [];
          const 命中 = 按id.length ? 按id : (名称 ? rows.filter(r => r.name === 名称) : []);
          if (命中.length !== 1 || 命中[0].mode !== 'continuable') throw Error('实例不是本父会话的新直属可续发成员');
          id = 命中[0].id;
        } else if (!id) {
          throw Error(`宿主只返回${名称 ? `名称「${名称}」` : '无标识的结果'}，没有实例 id，且未提供直属目录接口；无法登记该子会话`);
        }
      }
      if (!id || (before && before.has(id)) || id === agent.id) throw Error('缺少新实例标识或返回了既有实例');
      await beforeDispatch();
      assertExecutionHost(host, mode);
      // Official tools expose no initial inbox receipt. Null is not a failure or
      // a fabricated acknowledgement; the later business message has its own id.
      return { 实例: id, 团队名: mode === 'team' ? name : null, agent, signal,
        初始消息id: null, 初始消息已接收: null, 执行完成: null, 宿主调用: hostCall,
        ...(degraded ? { 目录核对: `降级：${degraded}` } : {}) };
    } catch (cause) {
      throw new Fault('MEMBER_SPAWN_RESULT_UNKNOWN', `宿主调用已返回，但新直属成员或当前派工条件未确认（${cause instanceof Error ? cause.message : String(cause)}）；不登记、不盲停，也不重复创建。`, { cause,
        detail: { 宿主调用: hostCall, ...(id ? { 返回实例: id } : {}), ...(返回字段 ? { 返回字段 } : {}) },
        outcome: { 提交状态: '未知', 可重试: false, 恢复指引: '按原操作id及宿主调用id核对直属目录；旧实例或未知标识不属于本次可补偿成员。', 已确认阶段: [] } });
    }
  } });
}

export async function createExecution(spec) { return prepareExecution(spec).execute(); }

/** One closed official Team lane, shared by maintenance AND owned compensation.
 * The caller supplies its own ownership proof; this layer rechecks exact addressing
 * after Host approval. Cleanup is not an exemption from a disabled/denied tool. */
export function prepareTeamInterrupt({ host, agent, id, teamName, beforeDispatch = async () => {} }) {
  const capability = host?.hostMaintenance, service = host?.agentTeams, signal = signalOf(host);
  if (!textId(id) || !textId(teamName) || typeof capability?.prepare !== 'function' || typeof service?.listMembers !== 'function') throw new Fault('MEMBER_STOP_NO_CHANNEL', 'Team中断缺官方工具通道或精确目录；不直调服务、不换普通子会话通道。');
  return capability.prepare({ mode: 'team', target: teamName, beforeDispatch: async () => {
    await beforeDispatch();
    if (host.agent !== agent || host.agentTeams !== service || host.hostMaintenance !== capability) throw new Fault('MEMBER_STOP_SCOPE_CHANGED', '中断的真实父对象或通道已变化。');
    const rows = await service.listMembers(agent);
    const matches = Array.isArray(rows) ? rows.filter(r => r?.id === id) : [];
    if (matches.length !== 1 || matches[0].role !== 'teammate' || matches[0].name !== teamName
      || rows.filter(r => r?.name === teamName).length !== 1) throw new Fault('MEMBER_STOP_SCOPE_CHANGED', '中断目标的直属Team名称/实例不再唯一相符，拒绝旧目标。');
    await beforeDispatch();
    signal.throwIfAborted();
  } });
}

/** A signal receipt never asserts target settlement. Absent targets may be accepted no-ops. */
export async function requestExecutionInterrupt({ host, mode, agent, id, teamName, beforeDispatch }) {
  const service = mode === 'team' ? host?.agentTeams : host?.subagents;
  if (typeof service?.interrupt !== 'function') throw new Fault('MEMBER_STOP_NO_CHANNEL', `宿主 ${mode} 公共中断接口不可用。`, { detail: { 实例: id, 已请求中断: false, 已停: null } });
  if (mode === 'team') {
    await beforeDispatch?.(); // Freeze owned cleanup facts before any Host approval wait.
    await prepareTeamInterrupt({ host, agent, id, teamName, beforeDispatch }).execute();
  }
  else await service.interrupt(id, { kind: 'ancestor', agent });
  return { 实例: id, 通道: mode, 已请求中断: true, 已停: null, 说明: '仅确认中断请求已发出；目标可继续运行至观察取消信号，未知/非驻留目标可为无操作。' };
}

/** Waits only for selected resident continuable Activations to release their handles. */
export async function releaseExecution({ host, mode, agent, id, teamName, beforeDispatch }) {
  if (mode === 'team') return requestExecutionInterrupt({ host, mode, agent, id, teamName, beforeDispatch });
  const release=typeof host?.subagents?.drainContinuableChildren==='function'?'drainContinuableChildren':'drainChildren';
  if (typeof host?.subagents?.[release] !== 'function') throw new Fault('COUNCIL_ADAPTER_NOT_READY', `实例 ${id} 的公共释放接口 subagent.drainContinuableChildren 不可用；不能报停止或补偿成功。`, {
    detail: { 实例: id, 方式: mode, 缺: 'drainContinuableChildren', 已停: null, 当前驻留已释放: false },
  });
  try { await host.subagents[release](agent, [id]); }
  catch (cause) { throw new Fault('MEMBER_RELEASE_UNKNOWN', '宿主释放调用未完整返回，当前驻留状态未知。', { cause,
    outcome: { 提交状态: '未知', 可重试: false, 恢复指引: '核对所选实例的宿主驻留状态；释放失败不表示仍运行或已停止，不要据此自动接管或重放业务。', 已确认阶段: [{ 阶段: '释放调用已发起', 实例: id, 已请求: true }] } }); }
  return { 实例: id, 通道: mode, 当前驻留已释放: true, 已停: null, 持久子会话已删除: false,
    说明: '公共释放调用已完成；仅保证所选驻留 Activation 释放，缺席目标允许无操作，持久子会话可再次接收消息恢复。' };
}

export async function sendExecutionMessage({ host, mode, agent, signal, id, teamName, content }) {
  let receipt;
  try { receipt = mode === 'team'
    ? await host.agentTeams.sendMessage(agent, { target: teamName, content: [{ type: 'text', text: content }], signal })
    : await host.subagents.sendMessage(agent, id, [{ type: 'text', text: content }], { signal }); }
  catch (cause) { throw new Fault('MEMBER_MESSAGE_RESULT_UNKNOWN', '宿主消息调用异常，inbox 接收状态未知。', { cause,
    outcome: { 提交状态: '未知', 可重试: false, 恢复指引: '核对原子会话的 inbox；没有接收凭据时不要重复发送。', 已确认阶段: [{ 阶段: '消息投递已发起', 实例: id, 已请求: true }] } }); }
  const messageId = textId(typeof receipt === 'string' ? receipt : receipt?.messageId);
  if (!messageId) throw new Fault('MEMBER_MESSAGE_RECEIPT_UNKNOWN', '宿主未给可判的 inbox 接收id；消息结果未知，不可盲重发。', { detail: { 实例: id, 已接收: null, 可重试: false },
    outcome: { 提交状态: '未知', 可重试: false, 恢复指引: '核对原子会话的 inbox；缺消息id不能推断未接收，不要重复发送。', 已确认阶段: [{ 阶段: '消息投递已发起', 实例: id, 已请求: true }] } });
  return { messageId, 已接收: true, 已处理: null, 执行完成: null };
}
