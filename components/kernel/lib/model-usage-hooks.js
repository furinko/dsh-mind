/** 只观察宿主帧；通知不等待持久化，采集错误不得截断模型或工具执行。 */
import { randomUUID } from 'node:crypto';
import { canonical } from '../../../src/kernel/text.js';
import { modelUsageScope } from '../../../src/model-usage-scope.js';

const natural = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => natural(value) && value > 0;
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value;
const route = value => text(value) && value.length <= 256 ? value : null;
const FINISH_KINDS = new Set(['stop', 'tool-calls', 'max-tokens', 'error', 'aborted']);

export function createModelUsageHooks({ org, projectOf, logger = console, enabled = true }) {
  const lifecycles = new WeakMap();
  const pending = new Set();
  let attached = false; let stopped = false; let failedWrites = 0; let invalidFrames = 0; let orphanFrames = 0; let droppedWrites = 0;
  const warn = () => { try { if (failedWrites === 1) logger.warn?.('[dsh-mind] 模型用量采集失败，已报告读数存在缺口；业务继续，不补零或改额度。'); } catch { /* 观测告警也不影响业务。 */ } };
  const enqueue = (entry, action) => {
    if (pending.size >= 1024) { entry.failed = true; droppedWrites++; return; }
    // 同一尝试串行持久化，失败后不伪补后续事件。各尝试共享领域独占锁。
    entry.queue = entry.queue.then(action).catch(() => { if (!entry.failed) { entry.failed = true; failedWrites++; warn(); } });
    const job = entry.queue.finally(() => pending.delete(job)); pending.add(job);
  };
  const api = {
    observe(payload) {
      if (!enabled || stopped) return;
      try {
        const { agent, frame } = payload ?? {};
        if (!agent || typeof agent !== 'object' || !frame || !text(frame.attemptId) || !positive(frame.revision)) { invalidFrames++; return; }
        let lifecycle = lifecycles.get(agent);
        if (frame.type === 'start') {
          if (!natural(frame.turn) || !natural(frame.step)) { invalidFrames++; return; }
          if (!lifecycle) { lifecycle = { id: randomUUID(), attempts: new Map(), revision: 0 }; lifecycles.set(agent, lifecycle); }
          const previous = lifecycle.attempts.get(frame.attemptId);
          if (previous) {
            if (canonical(previous.start) !== canonical(frame)) invalidFrames++;
            return; // 同一 Agent 生命周期内不重开 attempt；新 Agent 的计数可合法从 1 开始。
          }
          if (frame.revision <= lifecycle.revision) { invalidFrames++; return; }
          // 每个实际 Agent 的结束凭据最多保留 128 个；旧 revision 水位防止淘汰后重开。
          for (const [id, item] of lifecycle.attempts) {
            if (lifecycle.attempts.size < 128) break;
            if (item.closed) lifecycle.attempts.delete(id);
          }
          if (lifecycle.attempts.size >= 128) { invalidFrames++; return; }
          const scope = modelUsageScope(agent, { org, projectOf });
          const entry = { key: randomUUID(), scope, session: agent.session.id, start: structuredClone(frame), revision: frame.revision,
            nextIndex: 0, queue: Promise.resolve(), failed: false, closed: false, finish: null, sawFinish: false, last: canonical(frame) };
          lifecycle.attempts.set(frame.attemptId, entry);
          lifecycle.revision = frame.revision;
          const spec = { ...scope, 执行键: entry.key, 会话: entry.session, 生命周期: lifecycle.id, attemptId: frame.attemptId,
            revision: frame.revision, turn: frame.turn, step: frame.step,
            配置路由: { provider: route(agent.options?.provider), model: route(agent.options?.model) } };
          enqueue(entry, () => org.modelUsage.recordStart(spec));
          return;
        }
        const entry = lifecycle?.attempts.get(frame.attemptId);
        if (!entry) { orphanFrames++; return; }
        if (entry.closed) { if (entry.last !== canonical(frame)) invalidFrames++; return; }
        if (entry.revision >= frame.revision) { if (entry.last !== canonical(frame)) invalidFrames++; return; }
        if (lifecycle.revision >= frame.revision) { invalidFrames++; return; }
        if (agent.session?.id !== entry.session || projectOf({ agent }) !== entry.scope.项目) { invalidFrames++; return; }
        if (frame.type === 'chunk') {
          if (!natural(frame.index) || frame.index !== entry.nextIndex || !natural(frame.time) || !frame.chunk || typeof frame.chunk.type !== 'string' || entry.sawFinish) { invalidFrames++; return; }
          entry.nextIndex++; entry.revision = frame.revision; lifecycle.revision = frame.revision;
          // 只保存计量与终止标记；不存正文、推理、工具参数或消息内容。
          entry.last = frame.chunk.type === 'usage' ? canonical(frame) : null;
          if (frame.chunk.type === 'usage') {
            const spec = { 项目: entry.scope.项目, 执行键: entry.key, index: frame.index, revision: frame.revision, time: frame.time, usage: structuredClone(frame.chunk.usage) };
            enqueue(entry, () => entry.failed ? undefined : org.modelUsage.recordSample(spec));
          } else if (frame.chunk.type === 'finish') {
            entry.sawFinish = true;
            entry.finish = FINISH_KINDS.has(frame.chunk.reason?.kind) ? frame.chunk.reason.kind : null;
            if (entry.finish === null) invalidFrames++;
          }
          return;
        }
        if (frame.type === 'end' && natural(frame.index) && frame.index === entry.nextIndex) {
          entry.closed = true; entry.revision = frame.revision; lifecycle.revision = frame.revision; entry.last = canonical(frame);
          const spec = { 项目: entry.scope.项目, 执行键: entry.key, index: frame.index, revision: frame.revision, outcome: structuredClone(frame.outcome), finish: entry.finish };
          enqueue(entry, () => entry.failed ? undefined : org.modelUsage.recordEnd(spec));
          return;
        }
        invalidFrames++;
      } catch { invalidFrames++; }
    },
    attach(ctx) {
      if (!enabled) return () => { stopped = true; };
      try { const dispose = ctx.on('agent/assistant-stream', api.observe); attached = true; return () => { stopped = true; attached = false; dispose?.(); }; }
      catch { failedWrites++; warn(); return () => { stopped = true; }; }
    },
    async flush() { while (pending.size) await Promise.all([...pending]); },
    health() { return { enabled, attached, stopped, failedWrites, invalidFrames, orphanFrames, droppedWrites, 完整: false, 费用: null }; },
  };
  return api;
}
