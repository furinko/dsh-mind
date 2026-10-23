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
import { InvalidBody } from './errors.js';

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
  // tmp 名加随机段（2026-10-14 审查 P2-16）：修前 `tmp-${pid}-${ms}` 同毫秒同文件
  // 两次写会撞名（writeFile 互截 + rename 竞态）；随机段让碰撞概率可忽略。
  // 失败路径清孤儿 tmp：写半截留下的 tmp 不该在目录里越积越多。
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await writeFile(tmp, content, 'utf8');
    // Node 在 Windows 上用 MOVEFILE_REPLACE_EXISTING，覆盖已存在目标是原子的。
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
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
 * 剥 UTF-8 BOM（首字符 U+FEFF）——**编码层的字节序标记不是内容**（2026-10-15 主权者裁决）。
 *
 * 事故背景：Windows 工具（PowerShell `Out-File -Encoding utf8`、编辑器自动保存）默认写
 * BOM，而 `JSON.parse` 不容忍它 ⇒ 部署.json 一被这类手碰过，引擎就按「文件坏了」处理
 * ⇒ §12.1 fail-closed 拒绝全部工具调用（含修复者自己的手）。一天两次。
 * 修法是**归一化**不是放水：剥完剩下的仍按原规则响亮校验（真坏的 JSON 照样抛）。
 * 单源在这里，所有从盘读 JSON 的位置一律先过它——各抄一份就会漂。
 * @param {string} text
 * @returns {string}
 */
export function stripBom(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
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
    const t = stripBom(line.trim());
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
 * readJsonl 的**带体检**版本（2026-10-13 审查 P1-7）：跳坏行的同时把坏行数报出来。
 * 审计链自检此前复用了「会跳行的读取器」——撕裂半行被读取与自检**一起**静默跳过，
 * verify 对「上一条完好记录」照常全绿，该条记录永久丢失且无 broken 项。
 * `末行完整`：文件是否存在未以换行结尾的尾部（追加式账本的撕裂形态）。
 * @param {string} file
 * @returns {Promise<{ rows: any[], 坏行: number, 末行完整: boolean }>}
 */
export async function readJsonlHealth(file) {
  const text = await readTextOrNull(file);
  if (text === null) return { rows: [], 坏行: 0, 末行完整: true };
  const rows = [];
  let 坏行 = 0;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const t = stripBom(lines[i].trim());
    if (!t) continue;
    try {
      rows.push(JSON.parse(t));
    } catch {
      坏行 += 1;
    }
  }
  const 末行完整 = text === '' || text.endsWith('\n');
  return { rows, 坏行, 末行完整 };
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
  // staleMs 默认 60s（2026-10-12 评审 P2-9 从 15s 上调）：15s 在 Windows 慢盘 + 整文件重写
  // （purge 这类读-改-写）面前太激进了——持有者只是慢，就被判「已死」强夺，临界区双入。
  // 真实的死锁代价是等 60s，可接受；误判强夺的代价是数据竞争，不可接受。
  const staleMs = options.staleMs ?? 60_000;
  // timeoutMs 必须大于 staleMs（2026-10-13 审查 P1-5）：否则等待者在等到 stale 判死之前就先
  // 超时抛错，强夺分支永远不可达——崩溃进程留下的锁文件会让所有后续写持续失败，只能人工删锁
  // （这正是 fsx 头注释「重启后不能有卡死的锁」要防的事故）。默认给 stale 之后留一个完整
  // 的强夺 + 重试窗口；调用方仍可显式传更短的 timeoutMs 换快速失败。
  const timeoutMs = options.timeoutMs ?? staleMs + 60_000;
  const started = Date.now();
  await ensureDir(lockPath);
  for (;;) {
    let handle;
    try {
      handle = await open(lockPath, 'wx');
    } catch (error) {
      // 只有获取锁失败才允许重试。业务、令牌写入和释放阶段的文件错误必须向外返回；
      // fn 可能已经落账，不能因它抛 EPERM/EEXIST 就悄悄重放整次操作。
      // Windows 的已知行为：对已存在文件 open('wx') 常抛 EPERM 而非 EEXIST
      // （文件被别的句柄持有或处于删除挂起态时尤其如此）。锁文件路径只会指向普通文件，
      // 这里的 EPERM 按「锁被占着」处理：进入等待/夺取分支，而不是炸掉调用方。
      if (!error || (error.code !== 'EEXIST' && error.code !== 'EPERM')) throw error;
      const info = await stat(lockPath).catch(() => null);
      const age = info ? Date.now() - info.mtimeMs : Number.POSITIVE_INFINITY;
      if (info && age > staleMs) {
        // rm 前重校验（2026-10-13 审查 P1-5b）：stat 与 rm 之间旧锁可能刚被释放并被**新等待者**
        // 抢走——不重校验就会删掉新持有者的锁，两个进程同进临界区。重 stat 到同一 mtime 才删；
        // 已变样就当没看见，交给下面的超时 + 退避收束。
        const re = await stat(lockPath).catch(() => null);
        const 仍stale = re && re.mtimeMs === info.mtimeMs;
        // rm 在「删除挂起」上会 EPERM（句柄未关、DeleteFileW 已标挂起）——那不是强夺成功，
        // 是「还占着」：吞掉、交给下面的超时 + 退避收束（2026-10-12 评审 P1-10 复核实测）。
        const 抹掉 = 仍stale ? await rm(lockPath, { force: true }).then(() => true, () => false) : false;
        if (抹掉) options.onSteal?.({ lockPath, ageMs: age });
      }
      // 超时与退避是**所有**等待路径的共同出口（修前只有「锁还在且未过期」走这里，
      // 强夺与删除挂起两条都是裸 continue ⇒ 100% CPU 热循环，且永不超时）：
      //  - 强夺后立刻重试：Windows 上被 rm 的文件在持有句柄关闭前处于删除挂起态，
      //    open('wx') 持续 EPERM，裸 continue 会在这里空转到天荒地老；
      //  - stat 不到（!info）：同样是删除挂起窗口——等一拍再试，不算失败。
      if (Date.now() - started > timeoutMs) {
        throw new Error(`获取锁超时：${lockPath}（持有者未在 ${timeoutMs}ms 内释放）`);
      }
      await sleep(20 + Math.floor(Math.random() * 40));
      continue;
    }
    // 持有令牌：pid+at 双字段。验后删靠它比对——同进程并发抢同一路径时 pid 相同，
    // at（毫秒级时刻）区分两次持有。
    const token = { pid: process.pid, at: new Date().toISOString() };
    // 令牌写失败也要关句柄；获取成功后不再进入抢锁重试分支。
    try {
      await handle.writeFile(JSON.stringify(token));
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
    try {
      return await fn();
    } finally {
      await handle.close();
      // 删除前读回令牌。旧持有者超时后不得删掉新持有者的锁。
      const current = await readFile(lockPath, 'utf8').catch(() => null);
      let mine = false;
      try {
        const parsed = JSON.parse(current ?? '{}');
        mine = parsed.pid === token.pid && parsed.at === token.at;
      } catch {
        mine = false; // 读不懂 = 不是自己的令牌（或已损坏），一律不删。
      }
      if (mine) {
        await rm(lockPath, { force: true });
      } else {
        console.warn(`[dsh-mind] withLock(${lockPath})：锁已易主（自己的令牌不在锁文件里），跳过删除以保护新持有者。`);
      }
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
  const stored = run.catch(() => {});
  serializeByKey._queue.set(key, stored);
  // 队列只增不减收口（2026-10-14 审查 P3）：链尾 settle 后若自己仍是最新一项就摘除——
  // 长跑会话里 key 只增不减是缓慢泄漏。
  stored.finally(() => {
    if (serializeByKey._queue.get(key) === stored) serializeByKey._queue.delete(key);
  });
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

/**
 * 读 JSON 文件；**文件不存在**回 null，**存在但解析失败**响亮抛
 * （2026-10-12 评审 P3：解析失败回 null 会把「文件坏了」伪装成「没有这份文件」——
 * 审计锚坏了会被当成「没锚」、历史索引坏了会被当成「空索引」然后被整文件重写盖掉）。
 * 调用方若要把「坏了」折叠成自己的语义（如 audit.verify 把锚损坏归入 broken），
 * 自己 try/catch——那是有名的决策，不是这里的静默。
 * @param {string} file
 */
export async function readJsonOrNull(file) {
  const text = await readTextOrNull(file);
  if (text === null) return null;
  try {
    // BOM 先剥（stripBom 单源）：编码装饰不是内容；剩下的解析失败仍按「文件坏了」响亮抛。
    return JSON.parse(stripBom(text));
  } catch (error) {
    throw new InvalidBody(`JSON 解析失败：${file}（文件存在但内容坏了；「坏了」不许伪装成「没有」）。`, {
      detail: { file, 解析错误: error instanceof Error ? error.message : String(error) },
    });
  }
}
