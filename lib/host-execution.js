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

export function assertExecutionHost(host, mode, council = false) {
  if (!host?.agent) throw new Fault('MEMBER_SPAWN_NO_AGENT', '宿主没有传真实 Agent。');
  const service = mode === 'team' ? host.agentTeams : host.subagents;
  if (!service) throw new Fault(mode === 'team' ? 'MEMBER_SPAWN_NO_TEAM_RUNTIME' : 'MEMBER_SPAWN_NO_SUBAGENT_RUNTIME', `宿主未装载 ${mode} 成员服务。`);
  const required = mode === 'team'
    ? ['spawnTeammate', 'sendMessage', 'interrupt', ...(council ? ['listMembers'] : [])]
    : typeof service.startContinuable==='function'?['startContinuable','sendMessage','drainContinuableChildren']:['startActivation','sendMessage','drainChildren'];
  const missing = required.filter(key => typeof service[key] !== 'function');
  if (missing.length) throw new Fault('MEMBER_SPAWN_CONTRACT', `宿主 ${mode} 公共服务缺少 ${missing.join('、')}：必要接口未就绪，已在创建前拒绝。`, { detail: { 阶段: 'precheck', 缺: missing } });
}

export async function createExecution({ host, mode, name, description, standby, modelRoute, reservedChildId }) {
  assertExecutionHost(host, mode);
  const agent = host.agent, signal = signalOf(host);
  let id = null, teamName = null, initialMessageId = null;
  try {
  if (mode === 'team') {
    const created = await host.agentTeams.spawnTeammate(agent, { name, description,
      prompt: [{ type: 'text', text: standby }], context: 'fresh', provider: 'spawn', signal });
    id = textId(created?.member?.id ?? created?.id); teamName = textId(created?.member?.name) ?? name;
  } else {
    // Current public service: signal belongs to the outer spec. The child inbox,
    // not completion of a model turn, is the acceptance boundary of this call.
    const spec={provider:'spawn',label:description,...(reservedChildId?{childId:reservedChildId}:{}),request:{prompt:[{type:'text',text:standby}],parent:agent,...(modelRoute?{agentOptions:modelRoute}:{})},signal};
    const created=typeof host.subagents.startContinuable==='function'
      ?await host.subagents.startContinuable(spec)
      :await host.subagents.startActivation({...spec,delivery:'parent'});
    id = textId(created?.childId); initialMessageId = textId(created?.messageId);
  }
  } catch (cause) {
    throw new Fault('MEMBER_SPAWN_RESULT_UNKNOWN', '宿主创建调用异常，结果未知；请核对直系目录，不要重复创建。', { cause,
      outcome: { 提交状态: '未知', 可重试: false, 恢复指引: '核对当前父会话的宿主直系目录及组织登记；没有可靠创建回执时不要重复 member_spawn。', 已确认阶段: [] } });
  }
  if (mode === 'subagent' && reservedChildId && id && id !== reservedChildId) throw new Fault('MEMBER_SPAWN_RESERVED_ID_MISMATCH', '宿主返回的子会话标识与预留值不符，归属未知；不登记、绑定或自动释放这个意外标识。', {
    outcome: { 提交状态: '未知', 可重试: false, 恢复指引: '按持久操作id、拟用实例和宿主实际返回值分别核对直属目录，不能把不符回执认作本次首建或补签接收。',
      已确认阶段: [{ 阶段: '宿主返回标识不符，归属未知', 拟用实例: reservedChildId, 返回实例: id }] },
  });
  if (mode === 'subagent' && id && !initialMessageId) throw new Fault('MEMBER_SPAWN_RECEIPT_UNKNOWN', `宿主返回子会话 ${id}，但缺少初始消息接收凭据；不要重复创建或假称已就绪。`, {
    detail: { 阶段: 'spawn', 方式: mode, 实例: id, 初始消息已接收: null, 可重试: false },
    outcome: { 提交状态: '未知', 可重试: false, 恢复指引: '按宿主返回的实例id核对直系目录和初始 inbox；返回标识不证明本次首建、组织登记或卡就绪，不要重复创建或盲目停用该id。',
      已确认阶段: [{ 阶段: '宿主返回实例标识', 实例: id }] },
  });
  if (!id) throw new Fault('MEMBER_SPAWN_NO_ID', '创建调用已返回但未提供实例 id；结果未知，不要重复创建，先核对宿主直系目录。', {
    detail: { 阶段: 'spawn', 方式: mode, 已创建: null, 可重试: false },
    outcome: { 提交状态: '未知', 可重试: false, 恢复指引: '核对当前父会话的宿主直系目录和初始 inbox；缺实例id不能推断创建失败，不要重复 member_spawn。', 已确认阶段: [] },
  });
  return { 实例: id, 团队名: teamName, agent, signal, 初始消息id: initialMessageId,
    初始消息已接收: mode === 'subagent' ? true : null, 执行完成: null };
}

/** A signal receipt never asserts target settlement. Absent targets may be accepted no-ops. */
export async function requestExecutionInterrupt({ host, mode, agent, id, teamName }) {
  const service = mode === 'team' ? host?.agentTeams : host?.subagents;
  if (typeof service?.interrupt !== 'function') throw new Fault('MEMBER_STOP_NO_CHANNEL', `宿主 ${mode} 公共中断接口不可用。`, { detail: { 实例: id, 已请求中断: false, 已停: null } });
  if (mode === 'team') await service.interrupt(agent, teamName);
  else await service.interrupt(id, { kind: 'ancestor', agent });
  return { 实例: id, 通道: mode, 已请求中断: true, 已停: null, 说明: '仅确认中断请求已发出；目标可继续运行至观察取消信号，未知/非驻留目标可为无操作。' };
}

/** Waits only for selected resident continuable Activations to release their handles. */
export async function releaseExecution({ host, mode, agent, id, teamName }) {
  if (mode === 'team') return requestExecutionInterrupt({ host, mode, agent, id, teamName });
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
