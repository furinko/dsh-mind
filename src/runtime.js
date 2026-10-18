/**
 * 组件间的进程内运行时（内核与安全类共用的唯一装配点）。
 *
 * 为什么需要它：组件是**各自一行、各自一个 `apply`** 的独立包
 * （插件列表里它们是一张卡下面的三行，各自带开关）。
 * 但它们必须操作**同一个 Org 实例**——策略引擎的内存状态、审计链尾、身份缓存
 * 一旦各持一份，判定就会随「哪一行先激活」而变，这比不拆更糟。
 *
 * 为什么不做成 cordis 服务：服务需要用 `@deepseek-ai/dsh-*` 的基类来 provide，
 * 而本插件刻意零依赖（profile 安装的包不保证能解析出厂包）。
 * 于是退到更朴素、也更可验证的机制：**同一进程 + 同一模块实例 + 一个键控缓存**。
 * 键取「私有区根 + 项目」，因此同一次启动里的多个组件必然共享，重启后自然重建（§12.4）。
 */
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Org, DEFAULT_PROJECT } from './org.js';

/** @type {Map<string, Promise<Org>>} */
const 实例 = new Map();

/**
 * 进程代次的全局锚：**跨模块重导入恒定**。官方 HMR 会清掉 runtime 模块、重新执行模块级
 * `let`，于是同一个 PID 会拿到新 UUID（审计实证：pid 21092 从 f296… 变 bc7a…）。
 * `Symbol.for` 在同一 isolate 内全局共享 ⇒ 进程事实不再跟模块装配代次混用。
 */
const 进程代键 = Symbol.for('dsh-mind.process-generation.v1');

/**
 * 本进程的**代次**（v2 口述收敛 2026-10-18 条目12：孤儿回收的可靠事实源之一）。
 *
 * 为什么需要它：重启后要判「哪些在岗实例其实是孤儿」，而宿主没有给「任意会话是否还活着」
 * 的公开接口（`subagents.listChildren` 只覆盖某个在册父会话的子代；continuable 子会话
 * inactive ≠ 死）。**不猜接口**的落点就是这里：拿进程本身当锚——
 *  - `代` 每进程一个 UUID：同一进程里的所有 Org 装配共享它；
 *  - `pid` 是 OS 事实：别的进程代次还在不在，用 `process.kill(pid, 0)` 判得出来。
 *
 * 三条口径：
 *  - 槽里已有且 `pid === process.pid` ⇒ **恒等返回**（同一进程内多次 import，含 `?nonce=` 变体）；
 *  - pid 不符（fork / 隔离环境残留）⇒ 重新生成；
 *  - 真实新进程（新 pid）⇒ 自然新代次。
 *
 * 注意：这是**进程**代，不是**装配**代——每次新 Org 装配有自己的标记（见 `shareOrg`），
 * 两者不可混用（孤儿回收只认进程代的 pid 存活事实）。
 *
 * @returns {{代: string, pid: number, 于: string}} 本进程代次（同进程恒等）
 */
export function processGeneration() {
  const 现存 = globalThis[进程代键];
  if (现存 && 现存.pid === process.pid && typeof 现存.代 === 'string' && 现存.代) return 现存;
  const 新 = Object.freeze({ 代: randomUUID(), pid: process.pid, 于: new Date().toISOString() });
  globalThis[进程代键] = 新;
  return 新;
}

/**
 * 取（或首次装配）共享的 Org。
 *
 * 缓存的是 **Promise** 而不是结果：两行同时激活时，第二次调用等待的是同一次装配，
 * 不会出现两个 Org 同时往同一个账本写。
 *
 * @param {{ home: string, factoryRoot: string, privateRoot?: string, project?: string, logger?: object }} spec
 * @returns {Promise<Org>}
 */
export function shareOrg(spec) {
  const key = shareKey(spec);
  let pending = 实例.get(key);
  if (!pending) {
    // 代次随装配一起下发（条目12）：同一进程里所有组件共享同一个 Org ⇒ 共享同一进程代；
    // 两个组件各自生成代次会让同一批实例被对方当成孤儿（误杀邻居）。
    // **装配标记**（与进程代分开）：每次新 Org 装配一个独立 UUID，供 `status.引导` 回答
    // 「这是哪一次装配」；它**不参与**孤儿回收（回收只认进程代的 pid 存活事实）。
    const 装配标记 = randomUUID();
    pending = Org.open({ ...spec, 代次: processGeneration() })
      .then((org) => {
        org.装配标记 = 装配标记;
        if (org.boot && typeof org.boot === 'object') org.boot.装配标记 = 装配标记;
        return org;
      })
      .catch((error) => {
        // 失败不留在缓存里：否则一次瞬时故障会让本次启动永久残废。
        实例.delete(key);
        throw error;
      });
    实例.set(key, pending);
  }
  return pending;
}

/**
 * 共享键：私有区根 + 项目键。两者任一不同就是不同的组织。
 *
 * **路径先归一（W3 批1·2026-10-09）**：私有区根有两个来源——有的组件自己按
 * `home` 拼，有的把 `Layout.privateRoot` 原样传进来，而 `Layout` 用的是 `path.join`
 * （Windows 下是反斜杠）。`C:\x\mind-data\mind-private` 与 `C:/x/mind-data/mind-private`
 * 指向同一个目录却是两个键 ⇒ 缓存里装配出**两个 Org 实例**，同一个审计账出现两个写者，
 * 链头各算各的（这正是本缓存存在的理由被绕过）。
 * 所以拼键前先过 `path.resolve`：分隔符、尾斜杠、`.`/`..` 一律折成同一条绝对路径。
 * 归一的是**同一台机器上的同一个目录**，不涉及大小写折叠（Windows 大小写不敏感，
 * 但那是「另一个隐患」，本批不动）。
 *
 * @param {{ privateRoot?: string, home?: string, factoryRoot?: string, project?: string }} spec
 * @returns {string}
 */
export function shareKey(spec) {
  const 私有根 = resolve(spec.privateRoot ?? join(spec.home ?? '', 'mind-data', 'mind-private'));
  // Windows 大小写折叠（2026-10-13 审查 P2-16）：盘符大小写两个写法（`C:\x` vs `c:\x`）
  // 之前是两个键 ⇒ 两个 Org 同写一份账本——正是本缓存要防的事故。只折盘符：全路径折叠
  // 在大小写敏感文件系统上会把不同目录误合，折盘符在两边都安全（盘符大小写从不区分语义）。
  const 折盘符 = /^([A-Za-z]):/.test(私有根) ? 私有根[0].toUpperCase() + 私有根.slice(1) : 私有根;
  return `${折盘符}::${spec.project ?? DEFAULT_PROJECT}`;
}

/**
 * 忘掉一个共享实例。只给测试与「装配失败后重试」用——
 * 生产路径不需要它，也不该有别的调用点。
 * @param {string} [key] 省略则清空全部
 */
export function forgetSharedOrg(key) {
  if (key === undefined) 实例.clear();
  else 实例.delete(key);
}

/** @returns {number} 当前缓存了几个组织（测试断言「只装配一次」用）。 */
export function sharedOrgCount() {
  return 实例.size;
}
