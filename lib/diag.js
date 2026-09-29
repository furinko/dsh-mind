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
    const stamped = `${line} @ ${new Date().toISOString()}`;
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
