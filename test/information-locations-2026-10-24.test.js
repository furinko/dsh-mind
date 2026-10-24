import { it } from 'node:test';
import assert from 'node:assert/strict';
import { linuxInformationVolumes, informationLocations } from '../src/information-locations.js';

it('Linux挂载位置识别USB、硬盘和手动挂载目录，正确解码空格并排除宿主镜像别名', () => {
  const text = [
    '10 1 8:1 / / rw - ext4 /dev/sda1 rw',
    '11 1 8:2 / /run/media/user/我的\\040U盘 rw - exfat /dev/sdb1 rw',
    '12 1 8:3 / /run/media/user/Backup rw - ntfs3 /dev/sdc1 rw',
    '13 1 8:2 / /host/run/media/user/我的\\040U盘 rw - exfat /dev/sdb1 rw',
    '14 1 8:2 / /media/duplicate rw - exfat /dev/sdb1 rw',
    '15 1 8:4 / /mnt rw - ext4 /dev/sdd1 rw',
    '16 1 8:5 / /mnt/archive rw - ext4 /dev/sde1 rw',
    '17 1 0:1 / /proc rw - proc proc rw',
    '18 1 8:1 /media /media rw - ext4 /dev/sda1 rw',
    '19 1 8:1 /mnt /mnt/system-alias rw - ext4 /dev/sda1 rw',
    '20 1 259:2 /media /media rw - ext4 /dev/nvme0n1p2 rw',
    '21 1 259:2 /mnt /mnt rw - ext4 /dev/nvme0n1p2 rw',
  ].join('\n');
  const disks = linuxInformationVolumes(text);
  assert.deepEqual(disks.map(d => d.path), ['/run/media/user/我的 U盘', '/run/media/user/Backup', '/mnt', '/mnt/archive']);
  assert.deepEqual(disks.map(d => d.filesystem), ['exfat', 'ntfs3', 'ext4', 'ext4']);
});

it('位置发现有数量上限，真实读面只提供目录入口和可访问状态，不读取磁盘正文', async () => {
  const text = Array.from({ length: 100 }, (_, i) => `${i + 1} 1 8:${i} / /media/disk-${i} rw - exfat /dev/fake${i} rw`).join('\n');
  assert.equal(linuxInformationVolumes(text).length, 64);
  const result = await informationLocations();
  assert.ok(result.locations.some(p => p.kind === 'home'));
  assert.ok(result.locations.every(p => typeof p.path === 'string' && !Object.hasOwn(p, 'content')));
  for (const volume of result.locations.filter(p => p.kind === 'volume')) assert.equal(typeof volume.available, 'boolean');
});
