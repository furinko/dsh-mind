// lib/diag.js — 诊断留痕（多插件共用）。
//
// 落点：`<profile>/.dsh-market/<name>-marker.txt`，**追加式保留最近 N 行**。
//
// 为什么是"环"而不是"单槽覆盖"：单槽覆盖会把"某次真的注入过"这条现场证据被下一次启动抹掉
// —— 历史上就吃过这个亏（marker 里只剩 apply 行，而会话里的注入其实是好的）。
// 环保留最近若干行，"挂载"与"运行"两类事件都能回溯。
//
// 纪律：**留痕失败绝不影响功能**（fail-open）。诊断是辅助，不是主流程。

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { marketDir } from './paths.js';

/** 环长度（保留最近多少行）。 */
const RING_LINES = 20;

/**
 * 留痕来源标识（2026-09-29 加）。
 *
 * 为什么必须有：marker 曾只有"一行文本 + 时间戳" ⇒ **活进程与测试/脚本的留痕混在一起**，
 * 事后无法分辨。实测代价：marker 里出现 `apply: degraded — createUserMessage 不可用`
 * 时，我据此判"R0 注入不工作"，而那一行其实是**测试进程**写的（活进程同期正成功注入
 * `inject: len=5087`）。⇒ 每行尾部带 `[<角色> pid=<pid>]`，角色按**入口脚本**判：
 *   · `test`  —— `test/` 下的用例（隔离环境）
 *   · `script`—— `scripts/` 下的工具
 *   · `host`  —— 宿主加载的插件（真实运行态）
 */
function sourceTag() {
  const entry = String(process.argv[1] || '');
  const kind = /[\\/]test[\\/]/i.test(entry) ? 'test'
    : (/[\\/]scripts[\\/]/i.test(entry) ? 'script' : 'host');
  // **隔离标记**（2026-09-29 加）：入口脚本判不出角色时（如 Electron 自举、内联 `-e`、
  // 临时目录里的探针），靠"数据根/诊断目录被显式改过"这一硬事实兜住 —— 隔离运行写进
  // 真实 marker 的场景，据此一眼可辨（此前出现过 `len=26 [host pid=…]` 这种
  // "其实是夹具内容、却标成 host"的歧义留痕）。
  const isolated = process.env.MIND_MARKET_DIR || process.env.MIND_HOME ? ' isolated' : '';
  return `${kind} pid=${process.pid}${isolated}`;
}

/**
 * 追加一行诊断留痕（环状，保留最近 `RING_LINES` 行）。
 * @param {string} name marker 文件名前缀（如 `inject` ⇒ `inject-marker.txt`）
 * @param {string} line 内容
 * @returns {boolean} 是否写入成功（失败不抛）
 */
export function mark(name, line) {
  try {
    const dir = marketDir();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${name}-marker.txt`);
    const stamped = `${line} @ ${new Date().toISOString()} [${sourceTag()}]`;
    let prev = '';
    try { prev = readFileSync(file, 'utf8'); } catch { /* 首次写 */ }
    const lines = [...prev.split('\n').filter(Boolean), stamped].slice(-RING_LINES);
    writeFileSync(file, lines.join('\n') + '\n', 'utf8');
    return true;
  } catch { return false; }
}

/** 读回 marker（诊断用；不存在返回 ''）。 */
export function readMark(name) {
  try {
    const file = join(marketDir(), `${name}-marker.txt`);
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  } catch { return ''; }
}
