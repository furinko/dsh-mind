/**
 * 文件系统底座（§6 对象存储 = 文件系统的约定层）。
 *
 * 为什么不用数据库：§7「记忆服务不上数据库」、§14 把物理形态定成目录 + `.jsonl` +
 * `<id>.md`。这里提供的四件事——原子替换、追加、行式读取、跨进程互斥——
 * 就是那个约定层对操作系统的全部要求。
 *
 * 并发是真实存在的：同一个部署里可能有多个会话/成员同时写账本。
 * 因此「读-改-写」一律走 withLock，「纯追加」一律走 appendLines（O_APPEND 单次写）。
 */
import { open, mkdir, readFile, readdir, rename, rm, stat, writeFile, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** @param {string} file */
export async function ensureDir(file) {
  await mkdir(dirname(file), { recursive: true });
}

/** @param {string} dir */
export async function ensureDirPath(dir) {
  await mkdir(dir, { recursive: true });
}

/**
 * @param {string} file
 * @returns {Promise<boolean>}
 */
export async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 读文本；不存在时返回 null。存在性判定与读取是同一次系统调用的两种结果，
 * 避免「先 exists 再 read」之间的竞态。
 * @param {string} file
 * @returns {Promise<string|null>}
 */
export async function readTextOrNull(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * 原子替换：先写同目录的临时文件，再 rename 覆盖。
 * 为什么 tmp 必须同目录：跨卷 rename 会退化成「拷贝 + 删」，就不原子了。
 * @param {string} file
 * @param {string} content
 */
export async function atomicWrite(file, content) {
  await ensureDir(file);
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await writeFile(tmp, content, 'utf8');
  // Node 在 Windows 上用 MOVEFILE_REPLACE_EXISTING，覆盖已存在目标是原子的。
  await rename(tmp, file);
}

/**
 * 追加若干行（append-only 的唯一写法）。
 * 单次 appendFile 调用，行内已含 `\n`，因此并发追加不会互相撕行。
 * @param {string} file
 * @param {Array<string|object>} lines 对象会被 JSON.stringify
 */
export async function appendLines(file, lines) {
  const list = Array.isArray(lines) ? lines : [lines];
  if (list.length === 0) return;
  await ensureDir(file);
  const payload = list.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';
  await appendFile(file, payload, 'utf8');
}

/**
 * 读取行式文件，跳过空行与解析失败的行（坏行不等于整本账作废）。
 * @param {string} file
 * @returns {Promise<Array<any>>}
 */
export async function readJsonl(file) {
  const text = await readTextOrNull(file);
  if (text === null) return [];
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // 半行（写入被中断）或人工损坏：跳过，审计链的自检会把这件事报出来。
    }
  }
  return out;
}

/**
 * @param {string} dir
 * @param {{ filter?: (name: string) => boolean, recursive?: boolean }} [options]
 * @returns {Promise<string[]>} 相对 dir 的 POSIX 风格路径
 */
export async function listFiles(dir, options = {}) {
  const filter = options.filter ?? (() => true);
  const out = [];
  const walk = async (abs, rel) => {
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (options.recursive === false) continue;
        await walk(join(abs, entry.name), childRel);
      } else if (filter(entry.name, childRel)) {
        out.push(childRel);
      }
    }
  };
  await walk(dir, '');
  return out.sort();
}

/**
 * 列出一级子目录名。
 *
 * 为什么需要它：§14.4-5 把「目录名即项目键」，于是「有哪些项目」这件事
 * 只能通过目录枚举回答——它是记忆服务按项目分片检索的唯一项目来源。
 *
 * @param {string} dir
 * @param {{ up?: boolean }} [options] up=true 时返回 dir 的父目录下的同级目录（用于跳过 '跨项目' 这类固定分片）
 * @returns {Promise<string[]>}
 */
export async function listDirs(dir, options = {}) {
  const target = options.up ? dirname(dir) : dir;
  try {
    const entries = await readdir(target, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * 跨进程互斥。
 *
 * 为什么不用内存锁：§12.4「重启后所有判定必须能重建」的反面是
 * 「重启后不能有卡死的锁」。因此锁是文件，且带超时后的强夺语义：
 * 超过 staleMs 未释放视为上一个持有者已死，直接夺取并记录夺取事件。
 *
 * @template T
 * @param {string} lockPath
 * @param {() => Promise<T>} fn
 * @param {{ staleMs?: number, timeoutMs?: number, onSteal?: (info: object) => void }} [options]
 * @returns {Promise<T>}
 */
export async function withLock(lockPath, fn, options = {}) {
  const staleMs = options.staleMs ?? 15_000;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const started = Date.now();
  await ensureDir(lockPath);
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx');
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
        return await fn();
      } finally {
        await handle.close();
        await rm(lockPath, { force: true });
      }
    } catch (error) {
      // Windows 的已知行为：对已存在文件 open('wx') 常抛 EPERM 而非 EEXIST
      // （文件被别的句柄持有或处于删除挂起态时尤其如此）。锁文件路径只会指向普通文件，
      // 这里的 EPERM 按「锁被占着」处理：进入等待/夺取分支，而不是炸掉调用方。
      if (!error || (error.code !== 'EEXIST' && error.code !== 'EPERM')) throw error;
      const info = await stat(lockPath).catch(() => null);
      const age = info ? Date.now() - info.mtimeMs : Number.POSITIVE_INFINITY;
      if (age > staleMs) {
        await rm(lockPath, { force: true });
        options.onSteal?.({ lockPath, ageMs: age });
        continue;
      }
      // stat 不到 = 锁刚被释放（删除挂起窗口）——重试即可，不算失败。
      if (!info) continue;
      if (Date.now() - started > timeoutMs) {
        throw new Error(`获取锁超时：${lockPath}（持有者未在 ${timeoutMs}ms 内释放）`);
      }
      await sleep(20 + Math.floor(Math.random() * 40));
    }
  }
}

/** @param {number} ms */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 进程内按 key 串行化（互斥的最后一道保险）。
 *
 * 为什么有了 withLock 还要它：Windows 上「名字式」文件锁存在 rm/create 竞态——
 * 持有者的 rm 与等待者的 open('wx') 在删除挂起窗口内交错时，两个等待者可以**先后各自
 * 建出锁文件并都进入临界区**（实测复现：审计链同 seq 双行 fork，见 identity-chain E3）。
 * 进程内这条队列不依赖文件系统语义，await 链保证同 key 的 fn 绝不重叠；
 * 跨进程的一致性仍由 withLock 尽力 + 审计链自检兜底。
 *
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function serializeByKey(key, fn) {
  const tail = (serializeByKey._queue.get(key) ?? Promise.resolve()).catch(() => {});
  const run = tail.then(fn);
  serializeByKey._queue.set(key, run.catch(() => {}));
  return run;
}
/** @type {Map<string, Promise<void>>} */
serializeByKey._queue = new Map();

/**
 * 在锁内做「读-改-写」。
 * @template T
 * @param {{ file: string, lockPath: string, read: () => Promise<any>, apply: (current: any) => Promise<{ next: any, result: T }>, serialize?: (value: any) => string }} spec
 * @returns {Promise<T>}
 */
export async function mutateLocked(spec) {
  return withLock(spec.lockPath, async () => {
    const current = await spec.read();
    const { next, result } = await spec.apply(current);
    const text = spec.serialize ? spec.serialize(next) : `${JSON.stringify(next, null, 2)}\n`;
    await atomicWrite(spec.file, text);
    return result;
  });
}

/** @param {string} file */
export async function readJsonOrNull(file) {
  const text = await readTextOrNull(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
