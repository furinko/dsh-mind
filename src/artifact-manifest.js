/** 交卷内容的不可变清单。复核只验证已经冻结的内容，绝不替旧提交补造证据。 */
import { createHash } from 'node:crypto';
import { lstat, open, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Denied, InvalidBody } from './kernel/errors.js';
import { parseDocument } from './tags.js';
import { readObjectHistory } from './store.js';
import { assertSingleLinkFile, canonicalFileTarget, insideFileRoot } from './tool-file-scope.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const sameStat = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'nlink'].every((k) => a[k] === b[k]);
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const MAX_FILES = 20000;
const MAX_BYTES = 256 * 1024 * 1024;

function denied(reason, detail = {}) {
  return new Denied('任务图 · 交付物内容绑定', reason, {
    howToChange: '恢复交卷时的内容；需要改成果时重新 task_submit 冻结新清单，再复核出票。旧记录缺清单时必须交新卷，不能用旧票补证。',
    detail,
  });
}

/** 当前代的交付物；复核读根是权限，不是交付内容。 */
export function artifactReferences(node) {
  return [...new Set([
    ...(node?.交付挂载 ?? []),
    ...(node?.独立答案 ?? []).flatMap((a) => a.产出物引用 ?? []),
  ])];
}

function assertPublicFile(path, layout) {
  const target = canonicalFileTarget(path);
  for (const root of [layout.privateRoot, layout.factoryRoot]) {
    const protectedRoot = canonicalFileTarget(root);
    if (insideFileRoot(target, protectedRoot) || insideFileRoot(protectedRoot, target)) {
      throw denied('组织双区原始文件不能作为通用文件交付物读取；组织产物请使用对象 id 或 mind://私有/产物/id@版本 引用。');
    }
  }
  return target;
}

function canCaptureFile(path, spec) {
  const { task, subject, fileAuthority } = spec;
  if (subject?.kind !== '成员') return true;
  return fileAuthority?.canCapture?.(path, task, subject) === true;
}

/** 每一级都查链接；只查最终 realpath 会把「目录内文件越界」隐藏掉。 */
async function assertNoLinks(path) {
  let current = resolve(path);
  for (;;) {
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw denied('交付物路径含符号链接或 junction，无法冻结其读取边界。');
    assertSingleLinkFile(stat, '交付物文件');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function fileContent(path, budget) {
  const handle = await open(path, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw denied('交付物不是普通文件。');
    assertSingleLinkFile(before, '交付物文件');
    budget.bytes += Number(before.size);
    if (budget.bytes > MAX_BYTES) throw denied(`交付物超过 ${MAX_BYTES} 字节的核验预算，请缩小交付目录。`);
    const digest = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let consumed = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      consumed += bytesRead;
      if (consumed > Number(before.size) || consumed > MAX_BYTES) throw denied('交付物在读取中增长或超过核验预算。');
      digest.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    assertSingleLinkFile(after, '交付物文件');
    assertSingleLinkFile(named, '交付物文件');
    if (!sameStat(before, after) || !sameStat(after, named)) throw denied('交付物在读取过程中变化，请在文件稳定后重新交卷。');
    return { 字节: Number(after.size), 模式: Number(after.mode & 0o777n), sha256: digest.digest('hex') };
  } finally { await handle.close(); }
}

async function fileTree(path, budget) {
  await assertNoLinks(path);
  const entries = [];
  async function visit(current, name) {
    if (++budget.files > MAX_FILES) throw denied(`交付物超过 ${MAX_FILES} 个文件条目，请缩小交付目录。`);
    const before = await lstat(current, { bigint: true });
    if (before.isSymbolicLink()) throw denied('交付物目录含符号链接或 junction，拒绝递归读取。');
    assertSingleLinkFile(before, '交付物文件');
    if (before.isFile()) entries.push({ 路径: name, 类型: '文件', ...await fileContent(current, budget) });
    else if (before.isDirectory()) {
      entries.push({ 路径: name, 类型: '目录' });
      const names = (await readdir(current)).sort();
      for (const child of names) await visit(join(current, child), name ? `${name}/${child}` : child);
      const afterNames = (await readdir(current)).sort();
      if (JSON.stringify(names) !== JSON.stringify(afterNames) || !sameStat(before, await lstat(current, { bigint: true }))) throw denied('交付目录在读取过程中变化，请在目录稳定后重新交卷。');
    } else throw denied('交付物包含非常规文件，不能作为稳定内容核验。');
  }
  await visit(path, '');
  await assertNoLinks(path);
  return entries;
}

/** 对象库通常原子替换，仍核对句柄与落点，拒绝读取中发生的改写/换文件。 */
async function objectBytes(path) {
  await assertNoLinks(path);
  const handle = await open(path, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_BYTES)) throw denied('对象正文不是普通文件或超过内容核验预算。');
    assertSingleLinkFile(before, '对象正文');
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    assertSingleLinkFile(after, '对象正文');
    if (bytes.length > MAX_BYTES || !sameStat(before, after) || !sameStat(after, await lstat(path, { bigint: true }))) throw denied('对象正文在读取过程中变化，请在写入完成后重新交卷。');
    await assertNoLinks(path);
    return bytes;
  } finally { await handle.close(); }
}

function parseObjectReference(ref) {
  const match = /^mind:\/\/(私有|出厂)\/(规则|身份|能力|产物)\/([^/@]+)@(?:v)?([1-9]\d*)$/.exec(ref);
  if (match) {
    try { return { 区: match[1], 对象类: match[2], id: decodeURIComponent(match[3]), 版本: Number(match[4]) }; }
    catch { return null; }
  }
  // 既有裸 id 在交卷时解析为一个真实产物版本；不把 id 文本本身当内容摘要。
  if (!ref.includes('/') && !ref.includes('\\') && !ref.includes(':')) return { 区: '私有', 对象类: '产物', id: ref, 版本: null };
  return null;
}

async function readObjectVersion(object, spec) {
  const { layout, policy, subject, task } = spec;
  const path = object.对象类 === '规则' ? layout.rulePath(object.id, object.区)
    : layout.documentPath(object.对象类, { id: object.id }, object.区);
  if (!path || (object.对象类 === '产物' && object.区 !== '私有')) throw denied('对象版本引用没有可核验的存储位置。');
  await policy.check({ subject, action: 'read', target: { id: object.id, kind: object.对象类, authority: '自治', zone: object.区, project: task?.项目 }, context: { task } });
  let content;
  try { content = await objectBytes(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let parsed = content ? parseDocument(content.toString('utf8')) : null;
  if (object.版本 != null && Number(parsed?.meta?.version) !== object.版本) {
    const history = await readObjectHistory({ layout, audit: policy.audit, id: object.id, version: object.版本,
      kind: object.对象类, zone: object.区, read: async file => {
        try { return await objectBytes(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      } });
    content = history?.content;
    parsed = content ? parseDocument(content.toString('utf8')) : null;
  }
  if (!content || content.length > MAX_BYTES || String(parsed?.meta?.id) !== object.id || String(parsed?.meta?.kind) !== object.对象类 || (parsed?.meta?.zone && parsed.meta.zone !== object.区) || !Number.isSafeInteger(Number(parsed?.meta?.version)) || Number(parsed.meta.version) < 1 || (object.版本 != null && Number(parsed.meta.version) !== object.版本)) throw denied(`对象 ${object.id} 没有身份与版本一致的真实正文。`);
  await policy.check({ subject, action: 'read', target: { id: object.id, kind: object.对象类, authority: parsed.meta.authority ?? '自治', zone: object.区, project: task?.项目 }, context: { task } });
  return { ...object, 版本: Number(parsed.meta.version), 字节: content.length, sha256: hash(content) };
}

/** 不可解析引用可留在交卷记录，但不会得到合格票。 */
export async function captureArtifactManifest(refs, spec) {
  if (!Array.isArray(refs) || refs.some((r) => typeof r !== 'string' || !r.trim())) throw new InvalidBody('产出物引用必须是非空字符串数组。');
  const entries = [];
  const budget = { files: 0, bytes: 0 };
  for (const ref of [...new Set(refs)].sort()) {
    if (isAbsolute(ref)) {
      const path = assertPublicFile(ref, spec.layout);
      // 授权在任何内容读取之前；不可验证条目也不带文件摘要。
      if (!canCaptureFile(path, spec)) {
        entries.push({ 引用: ref, 类型: '不可验证', 原因: '文件不在本人真实绑定任务冻结的读/写范围内。' });
        continue;
      }
      try { entries.push({ 引用: ref, 类型: '文件树', 路径: path, 条目: await fileTree(ref, budget) }); }
      catch (error) { if (error instanceof Denied) throw error; entries.push({ 引用: ref, 类型: '不可验证', 原因: `文件不可读（${error.code ?? '读取失败'}）。` }); }
      continue;
    }
    const object = parseObjectReference(ref);
    if (object) {
      try { entries.push({ 引用: ref, 类型: '对象版本', ...await readObjectVersion(object, spec) }); }
      catch (error) { if (error instanceof Denied && error.rule !== '任务图 · 交付物内容绑定') throw error; entries.push({ 引用: ref, 类型: '不可验证', 原因: `对象版本不可核验（${error.code ?? '身份或版本不符'}）。` }); }
    } else entries.push({ 引用: ref, 类型: '不可验证', 原因: '请使用绝对文件路径、真实产物 id 或 mind://私有/产物/id@版本。' });
  }
  const manifest = { 版本: 1, 算法: 'sha256', 条目: entries };
  return { ...manifest, 摘要: hash(JSON.stringify(manifest)) };
}

export function artifactManifestDigest(manifest) {
  if (!manifest || manifest.版本 !== 1 || manifest.算法 !== 'sha256' || !Array.isArray(manifest.条目)) return null;
  const digest = hash(JSON.stringify({ 版本: manifest.版本, 算法: manifest.算法, 条目: manifest.条目 }));
  return manifest.摘要 === digest ? digest : null;
}

/** 只重读被冻结的引用；不会把当前内容写回清单，也不接受调用方提供摘要。 */
export async function verifyArtifactManifest(manifest, refs, spec) {
  const digest = artifactManifestDigest(manifest);
  if (!digest) throw denied('本代交卷没有完整可信的内容清单：旧交卷/旧票不能作为新采纳依据。');
  if (JSON.stringify([...new Set(refs)].sort()) !== JSON.stringify(manifest.条目.map((e) => e.引用))) throw denied('交付物引用在冻结后变化，必须重新交卷。');
  const budget = { files: 0, bytes: 0 };
  for (const entry of manifest.条目) {
    if (entry.类型 === '不可验证') throw denied(`交付物 ${entry.引用} 尚不可验证：${entry.原因}`);
    try {
      if (entry.类型 === '文件树') {
        const path = assertPublicFile(entry.引用, spec.layout);
        if (!samePath(path, entry.路径) || JSON.stringify(await fileTree(entry.引用, budget)) !== JSON.stringify(entry.条目)) throw denied(`交付物 ${entry.引用} 的内容已偏离交卷清单，旧复核票不能采纳修改后的成果。`);
      } else if (entry.类型 === '对象版本') {
        const current = await readObjectVersion(entry, spec);
        if (current.sha256 !== entry.sha256 || current.字节 !== entry.字节) throw denied(`对象 ${entry.id}@${entry.版本} 的内容已偏离交卷清单。`);
      } else throw denied('交付物清单存在未知条目类型。');
    } catch (error) {
      if (error instanceof Denied) throw error;
      throw denied(`交付物 ${entry.引用} 不能重读核验（${error.code ?? '读取失败'}）。`);
    }
  }
  return digest;
}
