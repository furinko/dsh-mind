/** Host adapter. Execution object/token, never caller callId, identifies one real attempt. */
import { agentSubject } from '../../../src/subject.js';
import { withObservation } from '../../../src/observability.js';

export function createKernelObservations({ org, projectOf, logger = console, enabled = true }) {
  const observer = org.observability;
  const collect = work => { try { return work(); } catch { try { observer.captureError(); } catch {} return null; } };
  const begin = (exec, phase) => collect(() => {
    let project = null; try { project = projectOf(exec); } catch { observer.captureError(); }
    const id = exec?.agent?.session?.id;
    const subject = typeof id === 'string' && id.trim() ? agentSubject(exec) : { id: 'unknown', kind: 'unknown' };
    return observer.begin(exec, { subject, project, phase });
  });
  return {
    guard(exec, ruleId, work) {
      const attempt = enabled ? begin(exec, 'guard') : null;
      // Observation failures cannot skip work(), change its return or throw over its own error.
      const reason = work((id, version, versionScope) => collect(() => observer.block(attempt, { ruleId: id, ruleVersion: version,
        versionScope: versionScope ?? (version === undefined ? 'loaded-policy-documents-and-defaults' : 'tool-envelope-config'), source: 'native_sync_guard' })));
      if (typeof reason === 'string') collect(() => observer.block(attempt, { ruleId, source: 'native_sync_guard' }));
      return reason;
    },
    async execute(exec, work) {
      const attempt = begin(exec, 'mind-body');
      try {
        const result = await withObservation(observer, attempt, work);
        if (!enabled) collect(() => observer.finish(attempt, { isError: false }));
        return result;
      } catch (error) {
        collect(() => observer.semanticFailure(attempt, error));
        if (!enabled) collect(() => observer.finish(attempt, { isError: true }));
        throw error;
      }
    },
    attach(ctx) {
      observer.setCoverage({ nativeTools: enabled ? 'enabled' : 'disabled', semanticMind: 'enabled' });
      if (!enabled) return;
      ctx.on('tools/pre-execute', (exec, next = () => Promise.resolve({ kind: 'allow' })) => {
        begin(exec, 'pre-execute');
        return next();
      });
      ctx.on('tools/result', (exec, result) => { collect(() => observer.finish(begin(exec, 'result'), result)); });
      挂兼容工具审计(ctx, org, logger);
    },
  };
}

/** 只读工具不逐次记；写工具的成功按轮汇总，失败全记。 */
const READ_ONLY_TOOLS = new Set(['read', 'glob', 'grep', 'list_agents', 'mind', 'skill', 'load_workspace_dependencies', 'list_subagent_models', 'job_list', 'job_output']);

/**
 * 把工具调用记进审计（§7 分级）。
 *
 * `tools/result` 是**唯一**在成功与失败两条路上都会触发一次的钩子，
 * 所以「失败全记」与「成功按轮汇总」在这里一并实现。
 * @param {any} ctx @param {any} org @param {any} logger
 */
function 挂兼容工具审计(ctx, org, logger) {
  const legacyAudit = { append: entry => org.observability.track(org.audit.append(entry)) };
  /** @type {Map<string, {成功: number, 失败: number, 工具: Map<string, number>}>} */
  const 轮 = new Map();

  /**
   * 轮键：**两处取法必须同一份**（W3 批3·2026-10-09）。
   *
   * 此前 `tools/result` 的兜底用的是**单次调用的 id**（形如 `call-xxxx`），而 `turn/end`
   * 用的是「会话 id 取不到就一个固定兜底键」：两边算出不同的键，于是 `tools/result` 存的桶
   * 在 `turn/end` 里**永远找不到、也永远删不掉**——Map 只增不减（长时间运行就是缓慢泄漏），
   * 而且汇总条目永远不会落。
   * 现在只认「会话 id」（单次调用的 id 拿它当轮键本来就错：每次调用会开一个新桶），
   * 取不到就都用 `'unknown-turn'`，两端必然对齐。
   *
   * @param {any} source `tools/result` 的 exec 或 `turn/end` 的 payload
   * @returns {string}
   */
  function 轮键(source) {
    return String(source?.agent?.session?.id ?? source?.session?.id ?? source?.sessionId ?? 'unknown-turn');
  }

  ctx.on('tools/result', (exec, result) => {
    try {
      const 工具 = exec?.name ?? 'unknown';
      const key = 轮键(exec);
      const bucket = 轮.get(key) ?? { 成功: 0, 失败: 0, 工具: new Map() };
      const 失败 = result?.isError === true;
      if (失败) {
        bucket.失败 += 1;
        legacyAudit
          .append({
            动作: '工具调用失败',
            // 主体取**真实调用者**（W3 批3）：此前恒记 `{id:'lead'}`，任何一次失败看起来
            // 都是 Lead 干的——成员踩的坑被记到 Lead 头上，排障与追责都跟着错。
            主体: agentSubject(exec),
            对象: { id: 工具, kind: '工具' },
            依据: '审计要求：失败全记（失败是最贵的学习信号）',
            结果: '失败',
            轮: key,
            详情: { 原因: result?.error?.message ?? '未提供原因', 码: result?.error?.info ?? null },
          })
          .catch((error) => logger.warn?.(`[dsh-mind] 失败记账写入失败：${error.message}`));
      } else if (!READ_ONLY_TOOLS.has(工具)) {
        bucket.成功 += 1;
        bucket.工具.set(工具, (bucket.工具.get(工具) ?? 0) + 1);
      }
      // 只记有内容的桶（2026-10-14 审查 P2-14）：修前 `轮.set` 无条件执行，只跑只读工具
      // 的会话也会留下零计数桶——turn/end 里「空桶直接 return」又不删它，Map 只增不减。
      // 现在只读结果根本不进 Map，空桶 delete 兜底留在 turn/end（双保险）。
      if (bucket.成功 > 0 || bucket.失败 > 0) 轮.set(key, bucket);
    } catch (error) {
      logger.warn?.(`[dsh-mind] 工具结果记账异常：${error instanceof Error ? error.message : String(error)}`);
    }
  });

  // 轮 = 一次任务实例从派发到交卷的一次执行段；交卷（回合结束）时落一条汇总。
  ctx.on('turn/end', (payload) => {
    try {
      const key = 轮键(payload);
      const bucket = 轮.get(key);
      // 空桶也要删掉（2026-10-14 审查 P2-14 的双保险）：历史版本/异常路径留下的零计数
      // 桶不许在 Map 里永久残留。
      if (!bucket || (bucket.成功 === 0 && bucket.失败 === 0)) {
        轮.delete(key);
        return;
      }
      轮.delete(key);
      legacyAudit
        .append({
          动作: '工具调用成功',
          // 汇总条目的主体同样取真实会话（此前恒记 Lead：轮汇总与失败记录一样会张冠李戴）。
          // P2-04（全面审查 2026-10-17）：主体与轮键必须同源——宿主用 agent 形状发
          // turn/end 时，轮键取到了成员会话，主体却回落到 Lead。这里复用轮键的同一优先级。
          主体: agentSubject({ agent: payload?.agent ?? { session: payload?.session ?? (payload?.sessionId ? { id: payload.sessionId } : undefined) } }),
          对象: { id: key, kind: '轮' },
          依据: '轮定义：一次任务实例从派发到交卷的一次执行段；成功的工具调用按轮汇总',
          结果: `成功 ${bucket.成功} / 失败 ${bucket.失败}`,
          轮: key,
          详情: { 成功调用: bucket.成功, 失败调用: bucket.失败, 工具分布: Object.fromEntries(bucket.工具) },
        })
        .catch((error) => logger.warn?.(`[dsh-mind] 轮汇总写入失败：${error.message}`));
    } catch (error) {
      logger.warn?.(`[dsh-mind] 轮汇总异常：${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
