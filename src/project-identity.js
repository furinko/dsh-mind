/** 项目身份与显示目录名分离；旧账必须由可信配置明确认领。 */
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { assertPathSegment, DIR } from './paths.js';
import { Fault, InvalidBody } from './kernel/errors.js';

function canonicalPath(value) {
  if (typeof value !== 'string' || !value.trim() || !isAbsolute(value)) {
    throw new InvalidBody('项目工作目录必须是绝对路径，不能用相对路径或目录尾名推断项目身份。');
  }
  let path = resolve(value);
  try { path = realpathSync(path); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

/**
 * 默认身份由完整规范路径生成；同尾名目录、路径大小写别名与 junction 均按真实路径判断。
 * @param {string} cwd @returns {string} @throws {InvalidBody} 非绝对目录；无写副作用。
 */
export function projectKeyForPath(cwd) {
  const path = canonicalPath(cwd);
  const name = basename(path).replace(/[^\p{L}\p{N}._-]/gu, '-').slice(0, 32).replace(/[. ]+$/, '') || 'workspace';
  return `p-${name}-${createHash('sha256').update(path).digest('hex').slice(0, 24)}`;
}

/**
 * bindings 来自宿主部署配置，不接受模型参数。
 * [{path:"C:/work/repo", project:"repo"}] 可显式沿用旧账；改目录时更新 path 可保留 project。
 * 一条项目键只属于一个真实目录，不能因多个同名目录出现而自动共享历史。
 * @param {{bindings?: Array<{path: string, project: string}>, layout?: import('./paths.js').Layout}} [spec]
 * @returns {(cwd: string|null|undefined, fallback: string) => string}
 * @throws {InvalidBody|Fault} 配置冲突或历史归属未确认；只读、不迁移数据。
 */
export function createProjectResolver({ bindings = [], layout } = {}) {
  if (!Array.isArray(bindings)) throw new InvalidBody('projectBindings 必须是 {path, project} 数组。');
  const paths = new Map();
  const projects = new Map();
  for (const binding of bindings) {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding) ||
        Object.keys(binding).some(key => !['path', 'project'].includes(key))) {
      throw new InvalidBody('projectBindings 每项只接受 path 与 project。');
    }
    if (typeof binding.project !== 'string') throw new InvalidBody('projectBindings 的 project 必须是字符串。');
    const path = canonicalPath(binding.path);
    const project = assertPathSegment(binding.project, '绑定项目');
    const equivalent = project.toUpperCase();
    if (paths.has(path) || projects.has(equivalent)) throw new InvalidBody('projectBindings 的真实目录与项目键必须一一对应；不能把不同目录合并进同一本历史账。');
    paths.set(path, project);
    projects.set(equivalent, path);
  }
  return (cwd, fallback) => {
    if (cwd === null || cwd === undefined || cwd === '') return assertPathSegment(fallback, '默认项目');
    const path = canonicalPath(cwd);
    const bound = paths.get(path);
    if (bound) return bound;
    const key = projectKeyForPath(path);
    // 即使新键已经产生，也不自动宣告同名旧账归属；认领须由部署者给出路径绑定。
    const legacy = basename(path);
    let validLegacy = true;
    try { assertPathSegment(legacy, '历史项目'); } catch { validLegacy = false; }
    if (layout && validLegacy && !projects.has(legacy.toUpperCase()) && [
      layout.private(DIR.基础设施, DIR.任务图, legacy),
      layout.busDir(legacy), layout.memoryDir(legacy),
    ].some(file => existsSync(file))) {
      throw new Fault('PROJECT_LEGACY_UNBOUND', `发现同名历史项目 ${legacy}，其真实目录归属未确认；请由部署者在 projectBindings 显式绑定 path 与 project 后再使用，不能自动合并或按旧账授权。`, { detail: { legacy, proposedProject: key } });
    }
    // 显式绑定的项目键不得被另一个目录通过默认派生结果占用。
    if (projects.has(key.toUpperCase()) && projects.get(key.toUpperCase()) !== path) {
      throw new Fault('PROJECT_ID_CONFLICT', '派生项目键已绑定到另一个真实目录，请核对 projectBindings。');
    }
    return key;
  };
}
