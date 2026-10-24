/** Human-side location shortcuts. Discover mounted roots, never mount or scan their contents. */
import { access, lstat, readFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, parse } from 'node:path';

const unescapeMount = value => value.replace(/\\(040|011|012|134)/g, (_, code) => String.fromCharCode(parseInt(code, 8)));
export function linuxInformationVolumes(text) {
  const devices = new Set(); const result = [];
  for (const line of text.split('\n')) {
    const [head, tail] = line.split(' - '); if (!tail) continue;
    const fields = head.split(' '); const path = unescapeMount(fields[4] ?? '');
    if (!/^\/(?:run\/media|media|mnt)(?:\/|$)/.test(path)) continue;
    const identity = `${fields[2]}:${fields[3]}`;
    if (devices.has(identity)) continue;
    const filesystem = tail.split(' ')[0];
    devices.add(identity); result.push({ name: basename(path), path, kind: 'volume', filesystem });
    if (result.length >= 64) break;
  }
  return result;
}

export async function informationLocations() {
  const home = homedir(); const locations = [{ name: '主目录', path: home, kind: 'home' }];
  let volumes = []; let warning = null;
  try {
    if (process.platform === 'linux') volumes = linuxInformationVolumes(await readFile('/proc/self/mountinfo', 'utf8'));
    else if (process.platform === 'darwin') volumes = (await readdir('/Volumes')).slice(0, 64).map(name => ({ name, path: join('/Volumes', name), kind: 'volume' }));
    else if (process.platform === 'win32') volumes = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(letter => ({ name: `${letter}:`, path: `${letter}:\\`, kind: 'volume' }));
  } catch { warning = '暂时无法刷新磁盘位置，仍可输入完整路径浏览。'; }
  if (process.platform !== 'win32') locations.push({ name: '文件系统', path: parse(home).root, kind: 'root' });
  const checked = await Promise.all(volumes.map(async volume => {
    try {
      const info = await lstat(volume.path);
      if (!info.isDirectory() || info.isSymbolicLink()) return null;
      await access(volume.path, constants.R_OK | constants.X_OK);
      return { ...volume, available: true };
    } catch (error) {
      if (process.platform === 'win32' && ['ENOENT', 'ENODEV'].includes(error.code)) return null;
      return { ...volume, available: false, reason: ['EACCES', 'EPERM'].includes(error.code) ? '当前进程无访问权限' : '磁盘已断开或暂不可用' };
    }
  }));
  return { locations: [...locations, ...checked.filter(Boolean)], warning,
    note: '显示 DSH 所在设备的已挂载位置；未出现的外接盘请先在系统文件管理器中挂载。' };
}
