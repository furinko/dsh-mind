import { DelegationPolicy } from '../../../src/delegation-policy.js';
import { Fault, InvalidBody, describeFailure } from '../../../src/kernel/errors.js';

const ENTRY_ID = 'dsh-mind-kernel';
const ENTRY_NAME = 'dsh-mind/kernel';
const SOURCE = 'profile:dsh-mind-kernel.delegation';
// Connection 认证的人侧浏览器通道按主权者通道如实映射（Lead 裁定 2026-10-17，bus msg-ffb19322）：
// 部署授权属「你定的」域，策略目标保持宪章档；id 保留「设置页」让账目可辨来源。该映射只存在于
// 认证路由处理器内——模型可达面（mind ACTIONS）没有 delegation 写动作，模型形状主体对同目标仍被真实引擎拒绝。
const SUBJECT = Object.freeze({ id: '设置页', kind: '主权者' });

function entryFor(editor) {
  const entries = editor.entries().filter((entry) => entry.options.id === ENTRY_ID && entry.options.name === ENTRY_NAME);
  if (entries.length !== 1) throw new Fault('DELEGATION_ENTRY_UNAVAILABLE', '当前 profile 没有唯一可编辑的 dsh-mind 内核条目。');
  return entries[0];
}

function persisted(editor) {
  const entry = entryFor(editor);
  const row = editor.configuration().find((item) => item.entry === entry);
  if (!row) throw new Fault('DELEGATION_CONFIG_UNAVAILABLE', '读不到内核的 profile 配置层。');
  // 官方 Include 按整个 config 替换。configuration 把“无 override”与 config:{} 都投影成 {}。
  let config = row.override;
  if (Object.keys(config).length === 0) {
    const inherited = new DelegationPolicy(row.inherited.delegation);
    if (inherited.fingerprint !== new DelegationPolicy({}).fingerprint) {
      throw new Fault('DELEGATION_PERSISTENCE_AMBIGUOUS', '宿主读接口无法区分无覆盖与显式空 config；盘面状态未知，请用原生配置编辑器核对。');
    }
    config = row.inherited;
  }
  const policy = new DelegationPolicy(config.delegation);
  return { state: 'observed', source: SOURCE, fingerprint: policy.fingerprint, config: policy.config };
}

/**
 * 仅供已通过宿主 Connection 认证的人侧路由使用；不注册模型动作，不另存授权副本。
 * @param {{ctx: object, org: object, delegation: DelegationPolicy, project: string, readiness?: object}} spec
 * @returns {{read(): object, save(input: object): Promise<{status: number, body: object}>}}
 * @throws {Fault} 正式配置服务或唯一条目缺席时拒绝读取/写入。
 */
export function createDelegationSettings({ ctx, org, delegation, project, readiness = {} }) {
  function editorFor() {
    const editor = ctx.get('configEditor');
    if (!editor || typeof editor.entries !== 'function' || typeof editor.configuration !== 'function' || typeof editor.edit !== 'function') {
      throw new Fault('DELEGATION_EDITOR_UNAVAILABLE', '宿主 configEditor 不可用；不会退回直接写 profile。');
    }
    return editor;
  }

  return {
    read() {
      const editor = editorFor();
      const disk = persisted(editor);
      const runtime = delegation.status(project);
      return {
        成功: true,
        数据: {
          persistence: disk,
          runtime,
          application: {
            state: !runtime.disposed && runtime.fingerprint === disk.fingerprint ? 'confirmed' : 'unconfirmed',
            fingerprint: runtime.fingerprint,
            disposed: runtime.disposed,
          },
          readiness: { ...readiness },
          adapters: { agentTeams: Boolean(ctx.get('agentTeams')), subagents: Boolean(ctx.get('subagents')) },
          documentPath: editor.documentPath,
          effect: '仅影响以后新派工的准入与后续提示词装配；撤回不会终止已有成员。提示词实际应用仍待下一轮验证。',
        },
      };
    },

    async save(input) {
      // edit 可能重装调用者自身，之后只使用独立 editor 与 org，不读取已 close 的旧 delegation。
      let editor;
      let error = null;
      let status = 200;
      const receipt = {
        requestedFingerprint: null,
        beforeFingerprint: null,
        commit: { state: 'not-started' },
        persistence: { state: 'unknown', source: SOURCE },
        application: { state: 'unknown', requiresFreshGet: true },
        audit: { state: 'pending' },
      };
      try {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InvalidBody('请求体必须是 JSON 对象。');
        if (Object.keys(input).some((key) => !['delegation', 'expectedFingerprint'].includes(key))) throw new InvalidBody('调度设置只接受 delegation 与 expectedFingerprint。');
        if (!Object.hasOwn(input, 'delegation')) throw new InvalidBody('delegation 必填。');
        if (typeof input.expectedFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedFingerprint)) throw new InvalidBody('expectedFingerprint 必须是最近一次 GET 的配置指纹。');
        const next = new DelegationPolicy(input.delegation);
        receipt.requestedFingerprint = next.fingerprint;
        editor = editorFor();
        const entry = entryFor(editor);
        if (typeof org.policy?.check !== 'function') throw new Fault('DELEGATION_POLICY_UNAVAILABLE', '组织策略引擎不可用，拒绝修改部署授权。');
        await org.policy.check({
          subject: SUBJECT, action: 'write',
          target: { id: 'dsh-mind-kernel.delegation', kind: '部署授权', authority: '宪章', zone: '私有', project },
          context: { source: 'authenticated-browser-settings' },
        });
        await editor.edit(entry, (current) => {
          const previous = new DelegationPolicy(current.delegation);
          receipt.beforeFingerprint = previous.fingerprint;
          if (previous.fingerprint !== input.expectedFingerprint) throw new Fault('DELEGATION_CONFLICT', '配置已被更新；请重新读取并确认草稿后再保存。');
          receipt.commit.state = 'unknown';
          return { ...current, delegation: { ...next.config, projects: [...next.config.projects] } };
        });
        receipt.commit.state = 'reconciled';
      } catch (failure) {
        error = failure;
        status = failure.code === 'DELEGATION_CONFLICT' ? 409 : failure.code === 'INVALID_BODY' ? 400 : ['DENIED', 'NEEDS_APPROVAL'].includes(failure.code) ? 403 : 503;
      }
      try {
        if (editor) receipt.persistence = { ...persisted(editor), matchesRequested: false };
        receipt.persistence.matchesRequested = receipt.persistence.fingerprint === receipt.requestedFingerprint && receipt.requestedFingerprint !== null;
      } catch (failure) {
        receipt.persistence = { state: 'unknown', source: SOURCE, error: describeFailure(failure).理由 };
      }
      try {
        await org.audit.append({
          动作: '调度设置变更', 主体: SUBJECT,
          对象: { id: 'dsh-mind-kernel.delegation', kind: '部署授权' },
          依据: '设置入口：通过宿主 Connection 认证的浏览器调度设置页',
          结果: error ? '失败；持久化与应用以分面回执为准' : 'Loader 已协调；须新 GET 验证生效',
          详情: { requestedFingerprint: receipt.requestedFingerprint, beforeFingerprint: receipt.beforeFingerprint, commit: receipt.commit, persistence: { state: receipt.persistence.state, fingerprint: receipt.persistence.fingerprint ?? null } },
        });
        receipt.audit = { state: 'recorded' };
      } catch (failure) {
        receipt.audit = { state: 'failed', error: describeFailure(failure).理由 };
        status = 503;
      }
      return {
        status,
        body: {
          成功: !error && receipt.audit.state === 'recorded',
          ...(error ? describeFailure(error) : { 结果: '已提交，应用须新 GET 核对' }),
          ...(receipt.audit.state === 'failed' ? { 理由: '审计失败；配置可能已保存，不要盲目重试。' + (error ? ` ${describeFailure(error).理由}` : '') } : {}),
          ...receipt,
        },
      };
    },
  };
}
