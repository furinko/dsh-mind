/** Linux进程边界：保留宿主权限，仅将人设目录及其挂载别名设为只读。 */
import { mkdirSync, lstatSync, readFileSync, realpathSync, statSync, accessSync, constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, sep } from 'node:path';
import { Fault } from '../../../src/kernel/errors.js';

const unavailable = message => new Fault('PERSONA_CORE_PROCESS_BOUNDARY', message);
const decodeMount = value => value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
let executable;

function parents(path) {
  const list = [];
  for (let current = path; ; current = dirname(current)) {
    const info = lstatSync(current, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) throw unavailable('人设目录祖先不是可核对的真实目录。');
    list.push({ path: current, identity: `${info.dev}:${info.ino}` });
    if (dirname(current) === current) return list;
  }
}

const inside = (target, root) => target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);

/** 按mountinfo的设备号与文件系统内路径识别别名，包括单独挂载的子目录。 */
export function personaMountAliases(roots) {
  const mounts = readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\n')
    .map(line => { const fields = line.split(' '); return { device: fields[2], root: decodeMount(fields[3]), point: decodeMount(fields[4]) }; });
  const aliases = new Set(roots);
  for (const root of roots) parents(root);
  for (const root of aliases) {
    if (aliases.size > 1024) throw unavailable('人设目录挂载别名过多，无法可靠建立保护。');
    const source = mounts.filter(mount => inside(root, mount.point)).sort((a, b) => b.point.length - a.point.length)[0];
    if (!source) throw unavailable('人设目录的文件系统挂载来源不可核对。');
    const filesystemPath = join(source.root, relative(source.point, root));
    for (const mount of mounts) {
      if (inside(mount.point, root)) aliases.add(mount.point);
      if (mount.device !== source.device) continue;
      if (inside(mount.root, filesystemPath)) aliases.add(mount.point);
      else if (inside(filesystemPath, mount.root)) aliases.add(join(mount.point, relative(mount.root, filesystemPath)));
    }
  }
  return [...aliases].sort((a, b) => a.length - b.length || a.localeCompare(b));
}

export function protectPersonaProcess(argv, roots) {
  if (!Array.isArray(argv) || !argv.length || argv.some(arg => typeof arg !== 'string')) throw unavailable('人设保护需要完整进程argv。');
  if (!executable) {
    const program = ['/usr/bin/bwrap', '/bin/bwrap'].map(path => {
      try {
        const real = realpathSync(path), info = statSync(real);
        if (!info.isFile() || info.mode & 0o022) return null;
        // 容器可能将系统文件的root映射成nobody；核验当前用户的实际写权。
        for (let item = real; ; item = dirname(item)) {
          try { accessSync(item, constants.W_OK); return null; } catch (error) {
            if (!['EACCES', 'EPERM', 'EROFS'].includes(error.code)) return null;
          }
          if (dirname(item) === item) break;
        }
        return real;
      } catch { return null; }
    }).find(Boolean);
    if (!program) throw unavailable('人设目录保护需要当前用户不可改写的系统bubblewrap路径。');
    const probe = spawnSync(program, ['--bind', '/', '/', '--unshare-pid', '--proc', '/proc', '--', '/bin/true'], { timeout: 3000, stdio: 'ignore' });
    if (probe.status !== 0) throw unavailable('当前Linux无法启用人设目录只读隔离；需要可用的bubblewrap。未将完全权限静默降为工作区权限。');
    executable = program;
  }
  for (const root of roots) mkdirSync(root, { recursive: true, mode: 0o700 });
  const aliases = personaMountAliases(roots);
  const anchors = new Set();
  for (const root of aliases) for (let parent = dirname(root); parent !== '/'; parent = dirname(parent)) anchors.add(parent);
  const args = ['--bind', '/', '/', '--unshare-pid', '--proc', '/proc', '--die-with-parent'];
  // 祖先作为独立挂载点，阻止改名父目录后在原地址重建假核心目录。
  for (const anchor of [...anchors].sort((a, b) => a.length - b.length || a.localeCompare(b))) args.push('--bind', anchor, anchor);
  for (const root of aliases) args.push('--ro-bind', root, root);
  return [executable, ...args, '--', ...argv];
}
