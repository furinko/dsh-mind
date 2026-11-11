/**
 * Server-only bridge from a registered live parent Agent to its current file policy.
 * No tool arguments, prompt text, working-directory guess or one-shot escalation
 * is an authority input. Re-resolve on EVERY use; do not cache the creation-time
 * inherited policy (a child may outlive a parent permission change).
 */
import { dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Denied } from './kernel/errors.js';
import { canonicalFileTarget, insideFileRoot } from './tool-file-scope.js';

const fail = reason => { throw new Denied('通用文件工具 · 宿主父权限不可判', reason, {
  howToChange: '核对宿主真实父会话、agents 与 sandboxPolicy 服务及当前文件权限；不接受模型自报、cwd 或一次性提权代替。',
}); };

export function createHostFileCeiling({ services }) {
  if (typeof services !== 'function') throw new TypeError('host services getter required');
  return (parentId, path, writing) => {
    const registry = services()?.agents;
    if (typeof registry?.get !== 'function' || typeof parentId !== 'string' || !parentId) fail('真实父会话目录不可用。');
    const parent = registry.get(parentId), session = parent?.session, header = session?.header;
    if (!parent || parent.id !== parentId || session?.id !== parentId || !header
      || (header.id !== undefined && header.id !== parentId)
      || header.origin !== undefined || (header.delegationDepth !== undefined && header.delegationDepth !== 0)) {
      fail('父会话不是当前登记的根 Agent；缺失、成员身份与不一致事实均拒绝。');
    }
    // Resolve through the parent's actual Cordis scope, not the caller/child's
    // context. SDK resolve({session}) consumes actual persisted overrides and
    // workingDirectory policy. Never supply sandbox_permissions here.
    const policyService = typeof parent.ctx?.get === 'function' ? parent.ctx.get('sandboxPolicy') : undefined;
    if (typeof policyService?.resolve !== 'function') fail('父会话的 sandboxPolicy 服务不可用。');
    const policy = policyService.resolve({ session });
    if (!policy || typeof policy.then === 'function'
      || !['read-only', 'workspace-write', 'danger-full-access'].includes(policy.mode)
      || (policy.sessionId !== undefined && policy.sessionId !== parentId)) fail('父会话文件策略缺失、异步或无法识别。');
    if (registry.get(parentId) !== parent || parent.session !== session) fail('父会话在权限读取期间已被替换。');
    // Do not let an ordinary member rewrite this running enforcement code or
    // its Node runtime. Independent development copies remain separate roots.
    if (writing) {
      for (const protectedPath of [fileURLToPath(new URL('../', import.meta.url)), dirname(process.execPath)]) {
        const protectedRoot=canonicalFileTarget(protectedPath);
        if (insideFileRoot(path,protectedRoot) || insideFileRoot(protectedRoot,path)) return false;
      }
    }
    // All three SDK modes allow reads; the task/protected-root/role guards still
    // restrict WHICH reads. A read permission never creates a write permission.
    if (!writing) return true;
    if (policy.mode === 'danger-full-access') return true;
    if (policy.mode === 'read-only') return false;
    if (typeof policy.workspaceRoot !== 'string' || !isAbsolute(policy.workspaceRoot)) fail('宿主工作区写根不可判。');
    // Deliberately delegate only the explicit workspace root, not the SDK's
    // ambient temporary directories. This is a subset of native writableRoots.
    const root = canonicalFileTarget(policy.workspaceRoot);
    return insideFileRoot(path, root);
  };
}
