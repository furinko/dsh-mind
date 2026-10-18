/**
 * 岗位卡凭证的**唯一校验面**（v2 条目10 · 2026-10-18 补修J）。
 *
 * 病灶：卡快照是内容寻址的（文件名 = `digest(v声明版本 + \0 + 正文)`），但「文件名对」
 * 不等于「内容对」。修前读方 parse 完就直接把快照里的 `段` / `能力引用` 交给调用方：
 * 于是旧摘要可以配新规程、正文可以变而摘要照旧、派生字段可以被单独偷换——这些在
 * 读面上全都长得像一张合法卡。写入侧更糟：`#写卡快照` 见文件已存在就跳过，坏文件
 * 永远不会被验，也永远修不掉（覆写它又会毁掉证据）。
 *
 * 所以卡凭证的读取 / 校验只留这一处，三个消费者共用：
 *  - `registry.cardOf`（钉住规则面的唯一解析，出生 / 注入 / canTouch 都读它）；
 *  - `policy` 的写前凭证闸（所有 Lead / 成员新写的唯一判定点，含受控父判）；
 *  - `instance-snapshot`（宿主同步 guard 用的纯 reader）。
 *
 * 判据是「正文与声明版本权威、派生字段必须由它重派生」而不是「摘要字符串非空」：
 * 摘要由正文重算、段与能力引用由正文重派生、岗位与登记岗位对齐，任一不符即不可用。
 *
 * 哈希算法与编码保持不变（`UTF8`，`v` + 声明版本 + `\u0000` + 正文）：已有快照是
 * 内容寻址的，换算法等于把全部合法旧钉版判成坏证据。
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { stripBom } from './kernel/fsx.js';
import { digest } from './kernel/text.js';
import { parseRefs, section } from './capability.js';

/**
 * 卡上的四段，顺序即个体域的层级（§14：个体域才有 L0~L3）。
 * registry 的分段读取与快照校验共用这一份，不各写一个数组字面量。
 */
export const CARD_SEGMENTS = ['个体L0', '个体L1', '个体L2', '个体L3'];

/**
 * 卡版本的唯一摘要算法：声明版本进哈希 ⇒ 改版本号也换新摘要（内容寻址）。
 *
 * @param {number} 声明版本
 * @param {string} 正文 生效正文（已去掉 front matter、两区已合并）
 * @returns {string} sha256 hex
 */
export function cardDigest(声明版本, 正文) {
  return digest(`v${声明版本}\u0000${typeof 正文 === 'string' ? 正文 : ''}`);
}

/**
 * 由正文派生规则面（段 / 能力引用 / 经验引用）。
 *
 * 为什么派生值不随快照走：快照里的派生字段是**当时的落盘副本**，必须能被正文重新
 * 算出来，否则「正文没变但段变了」这种偷换就查不出来。
 *
 * @param {string} 正文
 * @returns {{段: Record<string, string>, 能力引用: string[], 经验引用: string[]}}
 */
export function deriveCardFaces(正文) {
  const body = typeof 正文 === 'string' ? 正文 : '';
  return {
    段: Object.fromEntries(CARD_SEGMENTS.map((名称) => [名称, section(body, 名称)])),
    能力引用: parseRefs(section(body, '个体L2')),
    经验引用: parseRefs(section(body, '个体L3')),
  };
}

/**
 * 校验一份卡快照的**真实内容**（不读盘）。
 *
 * 查五件事（每件都能单独变红）：
 *  ① 形状：对象 / 岗位字符串 / 声明版本有限数 / 正文字符串 / 摘要字符串；
 *  ② 岗位：卡内声明岗位 === 期望岗位（登记岗位）、=== 钉住的岗位；
 *  ③ 声明版本：快照与钉住的一致；
 *  ④ 摘要：由 `声明版本 + 正文` 重算，必须等于快照自称的摘要（旧摘要配新规程在此拒）；
 *  ⑤ 派生面：段与能力引用由正文重派生后逐项一致（只偷换派生字段在此拒）。
 *
 * @param {object} 快照 卡快照对象
 * @param {{钉?: object|null, 期望岗位?: string|null}} [选项] 钉住记录与期望岗位（登记岗位）
 * @returns {{ok: true, 快照: object, 段: Record<string, string>, 能力引用: string[], 经验引用: string[]} | {ok: false, 原因: string}}
 */
export function validateCardSnapshot(快照, 选项 = {}) {
  const 钉 = 选项.钉 ?? null;
  const 期望岗位 = 选项.期望岗位 ?? null;
  if (!快照 || typeof 快照 !== 'object' || Array.isArray(快照)) {
    return { ok: false, 原因: '卡快照不是对象（坏形状，不得当空卡放行）' };
  }
  const 岗位 = typeof 快照.岗位 === 'string' ? 快照.岗位 : '';
  if (!岗位) return { ok: false, 原因: '卡快照缺岗位（卡内声明岗位为空）' };
  const 声明版本 = 快照.声明版本;
  if (typeof 声明版本 !== 'number' || !Number.isFinite(声明版本)) {
    return { ok: false, 原因: `卡快照的声明版本不是有限数：${JSON.stringify(声明版本 ?? null)}` };
  }
  if (typeof 快照.正文 !== 'string') return { ok: false, 原因: '卡快照缺正文字符串（不能拿空正文冒充一张卡）' };
  if (typeof 快照.摘要 !== 'string' || !快照.摘要) return { ok: false, 原因: '卡快照缺摘要' };
  if (!快照.段 || typeof 快照.段 !== 'object' || Array.isArray(快照.段)) {
    return { ok: false, 原因: '卡快照缺段对象（派生面无法与正文对照）' };
  }
  if (期望岗位 && 岗位 !== 期望岗位) {
    return { ok: false, 原因: `卡内声明岗位「${岗位}」与登记岗位「${期望岗位}」不符（卡类型必须与实例实际登记岗位一致）` };
  }
  if (钉) {
    if (typeof 钉.摘要 === 'string' && 钉.摘要 && 钉.摘要 !== 快照.摘要) {
      return { ok: false, 原因: `钉住的摘要 ${钉.摘要.slice(0, 12)}… 与快照自称的 ${快照.摘要.slice(0, 12)}… 不一致` };
    }
    if (typeof 钉.岗位 === 'string' && 钉.岗位 && 钉.岗位 !== 岗位) {
      return { ok: false, 原因: `钉住的卡岗位「${钉.岗位}」与快照声明岗位「${岗位}」不符` };
    }
    const 钉版本 = Number(钉.声明版本);
    if (Number.isFinite(钉版本) && 钉版本 !== 声明版本) {
      return { ok: false, 原因: `声明版本不一致：钉住 ${钉版本}，快照 ${声明版本}` };
    }
  }
  const 重算 = cardDigest(声明版本, 快照.正文);
  if (重算 !== 快照.摘要) {
    return { ok: false, 原因: `重算摘要不一致：由声明版本 ${声明版本} + 正文算出 ${重算.slice(0, 12)}…，快照自称 ${快照.摘要.slice(0, 12)}…（正文被改或摘要被换）` };
  }
  const 派生 = deriveCardFaces(快照.正文);
  const 段不符 = CARD_SEGMENTS.filter((名称) => (typeof 快照.段[名称] === 'string' ? 快照.段[名称] : '') !== 派生.段[名称]);
  if (段不符.length > 0) {
    return { ok: false, 原因: `派生段与正文不一致：${段不符.join('、')}（段被单独偷换，正文没有对应内容）` };
  }
  if (!sameRefs(快照.能力引用, 派生.能力引用)) {
    return { ok: false, 原因: `能力引用与正文不一致：快照 ${JSON.stringify(快照.能力引用 ?? null)} ≠ 正文派生 ${JSON.stringify(派生.能力引用)}` };
  }
  return { ok: true, 快照, 段: 派生.段, 能力引用: 派生.能力引用, 经验引用: 派生.经验引用 };
}

/**
 * 读一份内容寻址卡快照并**校验真实内容**（同步；宿主 guard 与 policy 写前闸都要它）。
 *
 * 文件名即摘要 ⇒ 还把「文件名」当第六项校验：文件里自称的摘要与文件名不一致，
 * 说明内容寻址键被换过（把 A 的内容放到 B 的键上），同样不可用。
 *
 * 永不抛：读不到 / 解析失败 / 校验不过都折成 `{ok:false, 原因}`，由调用方 fail-closed。
 *
 * @param {string} file 卡快照绝对路径
 * @param {{钉?: object|null, 期望岗位?: string|null}} [选项]
 * @returns {{ok: true, 快照: object, 段: Record<string, string>, 能力引用: string[], 经验引用: string[]} | {ok: false, 原因: string}}
 */
export function readVerifiedCardSnapshot(file, 选项 = {}) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, 原因: `卡快照缺失：${basename(file)}（内容寻址文件不在盘上，不能伪成功）` };
    return { ok: false, 原因: `卡快照读不到（${error?.code ?? '未知'}）：${error instanceof Error ? error.message : String(error)}` };
  }
  let 快照;
  try {
    快照 = JSON.parse(stripBom(text));
  } catch (error) {
    return { ok: false, 原因: `卡快照 JSON 解析失败：${error instanceof Error ? error.message : String(error)}（不得当空卡放行）` };
  }
  const 文件名摘要 = basename(file).replace(/\.json$/i, '');
  if (typeof 快照?.摘要 === 'string' && 快照.摘要 !== 文件名摘要) {
    return { ok: false, 原因: `文件名摘要与快照自称摘要不符：文件名 ${文件名摘要.slice(0, 12)}…，内容 ${快照.摘要.slice(0, 12)}…（内容寻址键被换）` };
  }
  return validateCardSnapshot(快照, 选项);
}

/** @param {unknown} a @param {string[]} b */
function sameRefs(a, b) {
  return Array.isArray(a) && a.length === b.length && a.every((项, i) => 项 === b[i]);
}
