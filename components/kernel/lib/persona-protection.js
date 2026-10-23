/** Mind自有人设文件接口边界；不包装或改写宿主的权限、沙箱、终端、进程服务。 */
import { dirname, isAbsolute, resolve, relative, sep } from 'node:path';
import { lstatSync } from 'node:fs';
import { canonicalFileTarget, insideFileRoot } from '../../../src/tool-file-scope.js';

const READ_TOOLS = new Set(['read', 'read_image', 'glob', 'grep']);
function ancestry(path) {
  const result = [];
  for (let parent = path; ; parent = dirname(parent)) {
    try {
      const stat = lstatSync(parent, { bigint: true });
      if (stat.isSymbolicLink() || !stat.ino) throw new Error('路径祖先身份不可确认');
      result.push({ id: `${stat.dev}:${stat.ino}`, suffix: relative(parent, path) });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (dirname(parent) === parent) return result;
  }
}
function physicalInside(path, root) {
  if (insideFileRoot(path, root)) return true;
  const parents = ancestry(root);
  return ancestry(path).some(child => parents.some(parent => child.id === parent.id
    && (child.suffix === parent.suffix || !parent.suffix || child.suffix.startsWith(`${parent.suffix}${sep}`))));
}


export function createPersonaProtection({ org, cwdOf = exec => exec?.agent?.session?.header?.cwd, platform = process.platform }) {
  const root = canonicalFileTarget(resolve(dirname(org.layout.personaCoreFile())));
  let stopped = false;
  return {
    health() {
      return { stopped, platform, interfaceGuard: !stopped, hostServicesWrapped: false,
        hostExecutionPolicy: 'native', shellCoreProtection: false,
        // 保留旧读面字段，但不把自有接口规则冒充宿主执行隔离。
        nativePolicy: false, confinedExecution: false, terminalProof: false,
        acceptedEnforcement: [], lastEnforcement: null,
        执行状态: stopped ? '已停止' : '遵循宿主原生权限，Mind不接管命令与终端',
        保护范围: 'Mind文件工具接口拒绝改写核心人设及替换其目录；完全权限shell仍可修改文件，不提供命令层隔离。',
      };
    },
    guard(exec) {
      if (READ_TOOLS.has(exec?.name)) return undefined;
      if (stopped) return '[dsh-mind] 核心人设接口保护已卸载，拒绝继续执行。';
      for (const key of ['file_path', 'path', 'source', 'destination', 'target_path', 'new_path', 'old_path']) {
        const value = exec?.arguments?.[key];
        if (typeof value !== 'string' || !value.trim()) continue;
        const cwd = cwdOf(exec);
        if (!isAbsolute(value) && !cwd) return '[dsh-mind] 写路径缺少基准，无法核对核心人设边界。';
        try {
          const path = canonicalFileTarget(isAbsolute(value) ? value : resolve(cwd, value));
          if (physicalInside(path, root) || physicalInside(root, path)) return '[dsh-mind] 核心人设由本地人侧维护，Mind文件工具不能创建、改写或替换该目录。';
        } catch (error) { return '[dsh-mind] 写路径无法可靠解析，核心人设接口拒绝该操作：' + error.message; }
      }
      return undefined;
    },
    stop() { stopped = true; },
  };
}
