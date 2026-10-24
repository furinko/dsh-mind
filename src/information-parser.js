/** Optional local parsers. Source bytes are copied only into a private temporary directory. */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile, access, readdir, lstat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Fault } from './kernel/errors.js';

export const DOCUMENT_PARSER_VERSION = 'mind-documents-1';
export const DOCUMENT_LIMITS = Object.freeze({ fileBytes: 50 * 1024 * 1024, chars: 2000000, snapshotBytes: 16 * 1024 * 1024, timeoutMs: 30000 });
const worker = fileURLToPath(new URL('../scripts/information-parser.py', import.meta.url));

export async function parserPython() {
  if (process.env.DSH_MIND_PARSER_PYTHON) return process.env.DSH_MIND_PARSER_PYTHON;
  const home = process.env.DSH_MIND_PARSER_HOME ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'dsh-mind', 'document-parser');
  const candidate = process.platform === 'win32' ? join(home, 'venv', 'Scripts', 'python.exe') : join(home, 'venv', 'bin', 'python3');
  try { await access(candidate); return candidate; } catch { return null; }
}

export function runDocumentWorker(python, args, input, cwd, { timeoutMs = DOCUMENT_LIMITS.timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-I', '-B', worker, ...args], { cwd, windowsHide: true,
      env: { PATH: process.env.PATH ?? '', HOME: cwd, TMPDIR: cwd, TEMP: cwd, TMP: cwd, LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'ignore'] });
    let done = false; let size = 0; const chunks = [];
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Fault('INFORMATION_PARSE_TIMEOUT', '文档解析超时，未算作已读；可拆分文档后重试。')); }, timeoutMs);
    child.once('error', () => finish(new Fault('INFORMATION_PARSER_MISSING', '本地解析环境不可用，请安装或修复文档解析组件。')));
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > DOCUMENT_LIMITS.snapshotBytes) { child.kill('SIGKILL'); finish(new Fault('INFORMATION_PARSE_LIMIT', '解析输出超过上限，未提交。')); }
      else chunks.push(chunk);
    });
    child.once('close', code => {
      if (done) return;
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (code !== 0 || !result?.ok) throw new Fault(/^INFORMATION_[A-Z_]+$/.test(result?.code) ? result.code : 'INFORMATION_PARSE_FAILED', result?.message ?? '文档解析失败。');
        finish(null, result);
      } catch (error) { finish(error instanceof Fault ? error : new Fault('INFORMATION_PARSE_FAILED', '文档解析器未返回有效结果。')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ? JSON.stringify(input) : '');
  });
}

export async function documentCapabilities() {
  const python = await parserPython();
  if (!python) return { available: false, parser: DOCUMENT_PARSER_VERSION, formats: {}, message: '尚未安装本地文档解析组件；现有文本收录照常可用。' };
  try { return { ...await runDocumentWorker(python, ['--capabilities'], null, dirname(worker), { timeoutMs: 5000 }), available: true }; }
  catch { return { available: false, parser: DOCUMENT_PARSER_VERSION, formats: {}, message: '本地解析组件暂不可用；可修复后重试。' }; }
}

export async function parseDocument(buffer, name, privateRoot, options = {}) {
  const python = options.python ?? await parserPython();
  if (!python) throw new Fault('INFORMATION_PARSER_MISSING', '请先安装本地文档解析组件；来源文件保持原样，等待重试。');
  const extension = name.slice(name.lastIndexOf('.')).toLowerCase();
  const workRoot = join(privateRoot, 'parser-tmp');
  await mkdir(workRoot, { recursive: true, mode: 0o700 });
  // Abrupt process termination cannot run finally. Clean only old private job copies.
  for (const entry of (await readdir(workRoot, { withFileTypes: true })).slice(0, 256)) {
    if (!entry.isDirectory() || !entry.name.startsWith('job-')) continue;
    const candidate = join(workRoot, entry.name);
    try { if (Date.now() - (await lstat(candidate)).mtimeMs > 600000) await rm(candidate, { recursive: true, force: true }); } catch { /* Next parse can retry cleanup. */ }
  }
  const work = await mkdtemp(join(workRoot, 'job-'));
  try {
    const input = join(work, `input${extension}`);
    await writeFile(input, buffer, { mode: 0o600, flag: 'wx' });
    const value = await runDocumentWorker(python, [], { path: input, extension, maxChars: DOCUMENT_LIMITS.chars }, work, options);
    if (typeof value.text !== 'string' || !value.text.trim() || value.text.includes('\0') || value.text.length > DOCUMENT_LIMITS.chars
        || !Array.isArray(value.locations) || value.locations.length > 10000 || !['complete', 'partial'].includes(value.extraction?.status)
        || value.locations.some(l => typeof l.label !== 'string' || l.label.length > 240 || !Number.isSafeInteger(l.start) || !Number.isSafeInteger(l.end) || l.start < 0 || l.end > value.text.length || l.start >= l.end)) throw new Fault('INFORMATION_PARSE_FAILED', '解析正文或位置无效，未提交。');
    return { text: value.text, title: name.split(/[\\/]/).at(-1).slice(0, 240), format: extension,
      coverage: `${value.extraction.status === 'partial' ? '部分解析' : '文字解析完成'}；${(value.extraction.warnings.join('；') || '仅提取文件中的文字与表格').slice(0, 850)}；不证明已读完或理解全部文件`,
      extraction: value.extraction, locations: value.locations };
  } finally { await rm(work, { recursive: true, force: true }); }
}

export function materialLocations(material, start, end) {
  return (material.locations ?? []).filter(l => l.start < end && l.end > start).slice(0, 100);
}
