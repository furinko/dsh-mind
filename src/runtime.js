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
import { Org, DEFAULT_PROJECT } from './org.js';

/** @type {Map<string, Promise<Org>>} */
const 实例 = new Map();

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
    pending = Org.open(spec).catch((error) => {
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
  return `${私有根}::${spec.project ?? DEFAULT_PROJECT}`;
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
