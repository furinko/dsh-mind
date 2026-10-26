/** Passive observation through published hooks. Does not change host requests, tools or permissions. */
import { agentSubject } from '../../../src/subject.js';
import { digest } from '../../../src/kernel/text.js';
import { randomUUID } from 'node:crypto';
import { contextPayload } from './context-frame.js';

export function createMemoryUseHooks({ org, projectOf, logger = console }) {
  const pending = new Set(); const frames = new Map(); let byAgent = new WeakMap();
  let stopped = false; let attached = false; let failedWrites = 0; let dropped = 0;
  const warn = () => { if (++failedWrites === 1) logger.warn?.('[dsh-mind] 记忆调用观察存在缺口；业务继续，未知不补成未使用。'); };
  const track = work => {
    if (stopped || pending.size >= 256) { dropped++; return; }
    const job = Promise.resolve().then(work).catch(warn).finally(() => pending.delete(job)); pending.add(job);
  };
  const scope = agent => {
    const subject = agentSubject({ agent }); const session = agent?.session;
    if (!session?.id || !session.header?.cwd || !['Lead', '成员'].includes(subject.kind)) return null;
    return { subject, project: projectOf({ agent }), session: session.id };
  };
  const frameItems = frame => [...(frame.知识 ?? []).map(i => ({ ...i, kind: '知识' })), ...(frame.经历 ?? []).map(i => ({ ...i, kind: '经历' })), ...(frame.能力 ?? []).map(i => ({ ...i, kind: '能力' })), ...(frame.记录 ?? []).map(i => ({ ...i, kind: '偏好', partial: true })), ...(frame.共同经历 ?? []).map(i => ({ ...i, kind: '经历', partial: true }))]
    .map(i => ({ id: i.id, kind: i.kind, version: i.版本摘要 ?? null, chars: i.内容片段?.length ?? i.摘要?.length ?? 0, partial: i.partial === true || i.需继续读取 === true }));
  const api = {
    clear(agent, channel = 'professional') { const group = byAgent.get(agent); const prior = group?.get(channel); if (prior) frames.delete(prior); group?.delete(channel); },
    recordAssembly(agent, frame, text, proof, channel = 'professional') {
      const spec = scope(agent); if (stopped || !spec) return;
      const observation = randomUUID(); // Correlation belongs to the observer, never the model prompt.
      spec.subject = { ...spec.subject, roleId: frame.岗位 ?? spec.subject.roleId }; spec.scopeStamp = proof?.stamp;
      const session = agent.session; const kind = spec.subject.kind;
      spec.valid = () => !stopped && agent.session === session && scope(agent)?.project === spec.project && scope(agent)?.subject.kind === kind;
      while (frames.size >= 128) frames.delete(frames.keys().next().value);
      const entry = { agent, spec, session: agent.session, text, payload: contextPayload(text), items: frameItems(frame), tasks: (frame.任务 ?? []).slice(0, 8), at: Date.now(), observed: new WeakSet() };
      const group = byAgent.get(agent) ?? new Map(); const prior = group.get(channel); if (prior) frames.delete(prior);
      frames.set(observation, entry); group.set(channel, observation); byAgent.set(agent, group);
      for (const stage of ['selected', 'assembled']) track(() => org.memoryUse.observe({ ...spec, stage, observation, items: entry.items, tasks: entry.tasks }));
    },
    observeRequest(options) {
      if (stopped || !options || typeof options !== 'object' || typeof options.sessionId !== 'string' || options.purpose) return;
      // The loop's sessionId binds identical text to its real session. Only the
      // latest full runtime snapshot/current system is eligible; an old snapshot
      // or a user quoting it cannot attest the current request.
      const messages = options.messages ?? [];
      const runtime = messages.findLast(message => message.source?.kind === 'runtime-context');
      const system = messages.findLast(message => message.role === 'system' || message.source?.kind === 'system-prompt');
      const texts = [typeof options.system === 'string' ? options.system.slice(-512000) : '',
        ...[system, runtime].filter(Boolean).map(message => (message.content ?? [])
          .filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n').slice(-512000))];
      for (const [observation, entry] of frames) {
        if (Date.now() - entry.at > 1800000) { frames.delete(observation); continue; }
        const now = scope(entry.agent);
        if (options.sessionId !== entry.spec.session || entry.observed.has(options) || entry.agent.session !== entry.session
            || now?.project !== entry.spec.project || now?.session !== entry.spec.session || now?.subject.kind !== entry.spec.subject.kind
            || !texts.some(text => text.includes(entry.text) || text.includes(entry.payload))) continue;
        entry.observed.add(options);
        track(() => org.memoryUse.observe({ ...entry.spec, stage: 'request-observed', observation, items: entry.items, tasks: entry.tasks }));
      }
    },
    result(exec, result) {
      if (stopped || exec?.name !== 'mind' || result?.isError !== false) return;
      const spec = scope(exec.agent); if (!spec) return;
      const session = exec.agent.session; const saved = frames.get(byAgent.get(exec.agent)?.get('professional'));
      if (saved) spec.subject = saved.spec.subject;
      spec.valid = () => !stopped && exec.agent.session === session && scope(exec.agent)?.project === spec.project && scope(exec.agent)?.subject.kind === spec.subject.kind;
      let raw = ''; for (const block of result.content ?? []) if (block.type === 'text') raw += block.text;
      if (raw.length > 50000) return;
      let body; try { body = JSON.parse(raw); } catch { return; }
      if (body.成功 !== true) return;
      const args = exec.arguments; let items = []; let stage; let tasks = [];
      if (args?.action === 'memory_query' && body.结果?.返回模式 === '全文') {
        stage = 'explicit-read'; items = (body.结果.条目 ?? []).filter(i => typeof i.内容 === 'string').slice(0, 32).map(i => ({ id: i.id, kind: i.类, version: digest(i.内容), chars: i.内容.length, partial: i.正文截断 === true }));
      } else if (args?.action === 'capability_read' && typeof body.条目?.正文 === 'string') {
        stage = 'explicit-read'; items = [{ id: body.条目.id, kind: '能力', version: digest(body.条目.正文), chars: Math.min(40000, body.条目.正文.length), partial: false }];
      } else if (args?.action === 'task_submit' && Array.isArray(args.采用知识) && body.节点?.id === args.id) {
        stage = 'adoption-declared'; tasks = [args.id]; items = args.采用知识.map(i => ({ id: i.id, kind: '知识', outcome: i.使用结果 }));
      } else return;
      track(() => org.memoryUse.observe({ ...spec, stage, observation: `tool:${String(exec.callId ?? body.action).slice(0, 200)}:${Date.now()}`, items, tasks }));
    },
    attach(ctx) {
      const disposers = [];
      try {
        disposers.push(ctx.on('llm/stream', (options, next) => { try { api.observeRequest(options); } catch { warn(); } return next(); }));
        disposers.push(ctx.on('tools/result', api.result)); attached = true;
      } catch { disposers.forEach(fn => fn?.()); warn(); }
      return () => { stopped = true; attached = false; frames.clear(); byAgent = new WeakMap(); disposers.forEach(fn => fn?.()); };
    },
    health() { return { attached, stopped, failedWrites, dropped, pending: pending.size, coverage: '本进程专业召回、Lead连续性段及mind全文读/交卷钩子观察；轮缓冲等其他上下文不在此记录。请求须有宿主sessionId，仅核对llm/stream观察点的当前system及最新runtime-context快照；无归因、截断、旁路和后续改写仍可能有缺口', actualUnderstanding: '未知' }; },
    async flush() { while (pending.size) await Promise.all([...pending]); },
  };
  return api;
}
