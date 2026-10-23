/** 仅由已认证的人侧设置路由调用；PersonaCoreService 与模型动作仍无写入口。 */
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { assertPersonaCorePath, readPersonaCoreFile, validatePersonaCoreText, PERSONA_CORE_LIMITS } from '../../../src/persona-core.js';
import { digest } from '../../../src/kernel/text.js';
import { serializeByKey, withLock } from '../../../src/kernel/fsx.js';
import { Fault, InvalidBody, describeFailure } from '../../../src/kernel/errors.js';

const SUBJECT = Object.freeze({ id: '设置页', kind: '主权者' });
const MISSING = digest('mind:persona-core:missing');

export function createPersonaCoreSettings({ org, project }) {
  function fileFor() {
    const file = resolve(org.layout.personaCoreFile());
    const inside = relative(resolve(org.layout.privateRoot), file);
    if (!inside || inside === '..' || inside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(inside)) {
      throw new Fault('PERSONA_CORE_INVALID', '核心人设路径不在当前部署私有目录内。');
    }
    return file;
  }
  function snapshot() {
    const file = fileFor();
    const frame = readPersonaCoreFile(file);
    return {
      file, text: frame?.text ?? '', fingerprint: frame?.digest ?? MISSING,
      state: !frame ? 'missing' : frame.text.trim() ? 'active' : 'empty',
      bytes: frame?.bytes ?? 0, limits: PERSONA_CORE_LIMITS,
    };
  }
  async function authorize(action) {
    await org.policy.check({ subject: SUBJECT, action,
      target: { id: '核心人设', kind: '身份', authority: '宪章', zone: '私有', domain: '个体', project },
      context: { source: 'authenticated-browser-settings' },
    });
  }
  return {
    async read() {
      await authorize('read');
      return { 成功: true, 数据: snapshot() };
    },
    async save(input) {
      let error = null;
      let status = 200;
      const receipt = { requestedFingerprint: null, beforeFingerprint: null, commit: { state: 'not-started' }, audit: { state: 'pending' } };
      try {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['text', 'expectedFingerprint'].includes(k))) {
          throw new InvalidBody('核心人设设置只接受 text 与 expectedFingerprint。');
        }
        validatePersonaCoreText(input.text);
        if (typeof input.expectedFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedFingerprint)) throw new InvalidBody('请先读取当前核心人设版本，再保存修改。');
        receipt.requestedFingerprint = digest(Buffer.from(input.text, 'utf8'));
        await authorize('write');
        const file = fileFor();
        await serializeByKey(process.platform === 'win32' ? file.toLowerCase() : file, async () => {
          assertPersonaCorePath(file, { allowMissing: true });
          mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
          assertPersonaCorePath(file, { allowMissing: true });
          return withLock(`${file}.settings.lock`, () => {
            // 最后一次等待之后同步完成版本核对与原子替换；同进程外部编辑不能插进两者之间。
            const before = snapshot();
            receipt.beforeFingerprint = before.fingerprint;
            if (before.fingerprint !== input.expectedFingerprint) throw new Fault('PERSONA_CORE_CONFLICT', '核心人设已在别处更新；草稿已保留，请重新读取并核对后保存。');
            const tmp = `${file}.settings-${randomUUID()}.tmp`;
            let handle;
            try {
              handle = openSync(tmp, 'wx', 0o600);
              writeFileSync(handle, input.text, 'utf8');
              fsyncSync(handle);
              closeSync(handle); handle = undefined;
              assertPersonaCorePath(file, { allowMissing: true });
              if (snapshot().fingerprint !== input.expectedFingerprint) throw new Fault('PERSONA_CORE_CONFLICT', '核心人设在保存期间被外部修改，请重新读取核对；未覆盖外部版本。');
              renameSync(tmp, file);
              receipt.commit.state = 'written';
            } finally {
              if (handle !== undefined) closeSync(handle);
              try { unlinkSync(tmp); } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
            }
            const after = snapshot();
            if (after.fingerprint !== receipt.requestedFingerprint) throw new Fault('PERSONA_CORE_CHANGED', '保存后核心人设再次变化，请重新读取核对。');
          }, { timeoutMs: 5000 });
        });
      } catch (failure) {
        error = failure;
        status = failure.code === 'PERSONA_CORE_CONFLICT' ? 409 : failure.code === 'INVALID_BODY' ? 400 : ['DENIED', 'NEEDS_APPROVAL'].includes(failure.code) ? 403 : 503;
      }
      try {
        await org.audit.append({ 动作: '核心人设设置变更', 主体: SUBJECT,
          对象: { id: '核心人设', kind: '身份' }, 依据: '设置入口：通过宿主 Connection 认证的浏览器核心人设设置页',
          结果: error ? '未完整确认；以保存回执和重新读取为准' : '已保存；下一轮重新读取核心人设',
          详情: { requestedFingerprint: receipt.requestedFingerprint, beforeFingerprint: receipt.beforeFingerprint, commit: receipt.commit },
        });
        receipt.audit = { state: 'recorded' };
      } catch {
        receipt.audit = { state: 'failed' };
        status = 503;
      }
      return { status, body: { 成功: !error && receipt.audit.state === 'recorded', ...receipt,
        ...(error ? describeFailure(error) : {}),
        ...(receipt.audit.state === 'failed' ? { 理由: '审计未确认；核心人设可能已保存，请重新读取核对，不要盲目重试。' } : {}),
      } };
    },
  };
}
