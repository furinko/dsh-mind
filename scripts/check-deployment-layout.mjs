#!/usr/bin/env node
// Read metadata only. Never import code from the target commit or open memory ledgers.
import { readFile, stat, realpath, lstat } from 'node:fs/promises';
import { resolve, join, dirname, basename, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { memoryLayoutVersion } from '../src/memory-layout.js';
import { DIR } from '../src/paths.js';

const fail = (message) => { throw Error(message); };
const hash = (value) => createHash('sha256').update(value.replace(/\r\n/g, '\n')).digest('hex');
const LEGACY_PATHS = '1085715d2dd2de82d1a933e9a6507989cd2c9f79ec7e2774faa60b9800686b27';
const V2_PATHS = '3fc532ba362d2a0566bd814f3157da685f165ee4ed4f88ff699d14356507b93f';
const V2_READER = '8939a3cd5a7ae45f5d6de28abc2df2dc19b6a3728ed7c45a82eb52834bb7990d';
const stripBom = (value) => value.replace(/^\ufeff/, '');

// Compatibility declarations belong to the frozen target commit. Older releases
// are recognized only by the audited memory methods, not unrelated path helpers.
export function supportedMemoryLayouts({ manifest, paths, reader }) {
  if (manifest !== null) {
    let parsed;
    try { parsed = JSON.parse(stripBom(manifest)); } catch { fail('目标提交的存储兼容清单无效，拒绝部署。'); }
    if (parsed?.version !== 1 || !Array.isArray(parsed.memoryLayouts) || !parsed.memoryLayouts.length
      || parsed.memoryLayouts.some(v => !Number.isInteger(v) || ![1, 2].includes(v))
      || new Set(parsed.memoryLayouts).size !== parsed.memoryLayouts.length) fail('目标提交的存储兼容清单版本未知，拒绝部署。');
    if (!Array.isArray(parsed.objectHistoryLayouts) || !parsed.objectHistoryLayouts.length
      || parsed.objectHistoryLayouts.some(v => !Number.isInteger(v) || ![1, 2].includes(v))
      || new Set(parsed.objectHistoryLayouts).size !== parsed.objectHistoryLayouts.length) fail('目标提交的对象历史兼容清单无效，拒绝部署。');
    return { memoryLayouts: parsed.memoryLayouts, objectHistoryLayouts: parsed.objectHistoryLayouts };
  }
  const start = paths?.indexOf('  memoryDir(scope) {') ?? -1;
  const end = paths?.indexOf('  personaCoreFile() {') ?? -1;
  if (start < 0 || end <= start || !paths.includes("  基础设施: '集体L2-共享基础设施',") || !paths.includes("  记忆服务: '记忆服务',")) fail('目标提交没有可核验的存储兼容声明，拒绝部署。');
  const signature = hash(paths.slice(start, end));
  if (signature === LEGACY_PATHS && reader === null) return { memoryLayouts: [1], objectHistoryLayouts: [1] };
  if (signature === V2_PATHS && reader !== null && hash(reader) === V2_READER
    && paths.includes('  memoryRoot() { return this.private(DIR.基础设施, DIR.记忆服务); }')) return { memoryLayouts: [1, 2], objectHistoryLayouts: [1] };
  fail('目标提交的旧版存储实现未获核验，拒绝部署。');
}

export function commitReader(repository, git, target) {
  let commit;
  try { commit = execFileSync(git, ['-C', repository, 'rev-parse', '--verify', '--end-of-options', target + '^{commit}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { fail('无法核对目标提交，拒绝部署。'); }
  if (!/^[a-f0-9]{40,64}$/.test(commit)) fail('目标提交标识无效，拒绝部署。');
  return { commit, read(path) {
    // ls-tree distinguishes a genuinely absent old metadata file from Git errors.
    let listing;
    try { listing = execFileSync(git, ['-C', repository, 'ls-tree', commit, '--', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { fail('无法读取目标提交的存储实现，拒绝部署。'); }
    if (!listing.trim()) return null;
    if (!/^100644 blob |^100755 blob /.test(listing)) fail('目标存储声明不是普通文件，拒绝部署。');
    try { return execFileSync(git, ['-C', repository, 'show', commit + ':' + path], { encoding: 'utf8', maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { fail('目标提交的存储文件不可读，拒绝部署。'); }
  } };
}

export async function resolvePrivateRoot({ privateRoot, homeRoot, profileDir, patches = [] }) {
  if (privateRoot) {
    if (!isAbsolute(privateRoot)) fail('MIND_PRIVATE_ROOT 必须是已核对的绝对路径。');
    return realpath(privateRoot);
  }
  if (!isAbsolute(homeRoot) || !isAbsolute(profileDir)) fail('无法确认数据根，请在本机配置中设置 MIND_PRIVATE_ROOT。');
  const actualHome = await realpath(homeRoot);
  const actualProfile = await realpath(profileDir);
  if (dirname(actualProfile) !== join(actualHome, 'profiles') || !basename(actualProfile)) fail('profile 与宿主主目录不匹配，请设置已核对的 MIND_PRIVATE_ROOT。');
  // Dynamic YAML and any root override cannot be resolved safely by this small
  // deployment checker. An explicit local setting is the operator's assertion.
  for (const patch of patches) {
    const active = stripBom(patch).split('\n').filter(line => !/^\s*#/.test(line)).join('\n');
    // Only simple block YAML is eligible for inference. Flow collections, quoted
    // keys, escapes, anchors, aliases, tags and directives can hide or merge a
    // root setting; they require an explicit, verified local data root.
    if (/[{}\[\]]|(?:^|[\s,:])(?:[&*!])|^\s*(?:%|\?\s|<<\s*:)|["'][^\n]*["']\s*:|\\/m.test(active)
      || /(?:^|[\s,{])['"]?(?:privateRoot|home)['"]?\s*:|!!js/m.test(active)) fail('装载配置有自定义或复杂数据根，请设置已核对的 MIND_PRIVATE_ROOT。');
  }
  return realpath(join(actualHome, 'mind-data', 'mind-private'));
}

export async function checkDeploymentLayout({ repository, git = 'git', target, privateRoot }) {
  const root = join(privateRoot, DIR.基础设施, DIR.记忆服务);
  if (!(await stat(root)).isDirectory()) fail('记忆目录不存在，不能将未知数据根视为布局1。');
  const version = memoryLayoutVersion(root);
  const historyVersion = async () => { try { await lstat(join(privateRoot, DIR.版本历史, '.objects-v2')); return 2; } catch (error) { if (error.code === 'ENOENT') return 1; throw error; } };
  const objectHistoryLayout = await historyVersion();
  const source = commitReader(repository, git, target);
  const manifest = source.read('scripts/storage-compatibility.json');
  const supported = supportedMemoryLayouts({ manifest,
    paths: manifest === null ? source.read('src/paths.js') : null,
    reader: manifest === null ? source.read('src/memory-layout.js') : null });
  if (!supported.memoryLayouts.includes(version)) fail('目标提交不支持当前记忆布局' + version + '，拒绝切换或回退；数据保持原状。');
  if (!supported.objectHistoryLayouts.includes(objectHistoryLayout)) fail('目标提交不支持当前对象历史布局' + objectHistoryLayout + '，拒绝切换或回退；数据保持原状。');
  if (await historyVersion() !== objectHistoryLayout) fail('检查期间对象历史布局发生变化，拒绝部署。');
  if (memoryLayoutVersion(root) !== version) fail('检查期间记忆布局发生变化，拒绝部署。');
  return { commit: source.commit, memoryLayout: version, objectHistoryLayout };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    const keys = { '--repo': 'repository', '--git': 'git', '--target': 'target', '--private-root': 'privateRoot', '--home-root': 'homeRoot', '--profile': 'profileDir', '--runtime': 'runtimeDir' };
    for (let i = 2; i < process.argv.length; i += 2) {
      const key = keys[process.argv[i]]; const value = process.argv[i + 1];
      if (!key || value === undefined || key in options) fail('兼容检查参数无效。');
      options[key] = value;
    }
    if (!options.repository || !options.target || !options.profileDir || !options.runtimeDir) fail('缺少兼容检查参数。');
    const source = commitReader(options.repository, options.git ?? 'git', options.target);
    const patches = await Promise.all([
      readFile(join(options.profileDir, 'cordis.patch.yml'), 'utf8'),
      readFile(join(options.runtimeDir, 'cordis.patch.yml'), 'utf8'),
    ]);
    const targetPatch = source.read('cordis.patch.yml');
    if (targetPatch === null) fail('目标装载配置不存在，无法核对数据根。');
    patches.push(targetPatch);
    const privateRoot = await resolvePrivateRoot({ ...options, patches });
    const checked = await checkDeploymentLayout({ ...options, privateRoot });
    console.log('存储兼容检查通过：' + checked.commit.slice(0, 12) + '，记忆布局' + checked.memoryLayout + '，对象历史布局' + checked.objectHistoryLayout + '。');
  } catch (error) {
    // Avoid echoing JSON, configuration values, ledger contents or child output.
    const message = ['ENOENT', 'EACCES', 'EPERM'].includes(error.code) ? '数据根或兼容元数据不可核对；请检查本机配置与权限。' : error.message;
    console.error('部署兼容检查未通过：' + message); process.exitCode = 1;
  }
}
