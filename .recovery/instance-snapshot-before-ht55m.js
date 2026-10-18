/**
 * 同步工具闸不能等待异步 Registry，也不能依赖热更前已缓存对象有没有新增方法。
 * Registry 与宿主闸共用这一份新鲜文件读取/归一化；坏档案绝不折成可放行的空表。
 *
 * 补修J（2026-10-18 独立审计）：`就绪` 不再只看「有摘要字符串」。已钉版且摘要是一个
 * 内容寻址键时，同步 reader 也要按**真实卡内容**验一遍（岗位对齐 + 重算摘要 + 派生面
 * 重派生），与 `registry.cardOf` / `policy` 写前闸共用 card-credential 的唯一校验面。
 * 坏证据折成 `就绪:false` + 可读原因，绝不默认放行。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stripBom } from './kernel/fsx.js';
import { assertPathSegment, DIR } from './paths.js';
import { readVerifiedCardSnapshot } from './card-credential.js';

/**
 * 读取真实身份文件，返回可判失败的实例凭证快照；不写入、不推断缺失历史。
 *
 * @param {string} file 身份档案路径（`身份档案/identity.json`）
 * @param {{快照目录?: string}} [options] 卡快照目录（缺省取身份档案同级的 `卡快照/`，
 *   与 `Layout.cardSnapshot()` 同一个目录名常量）
 * @returns {{ok: boolean, 原因?: string, 未引导?: boolean, 成员: Record<string, object>}}
 */
export function readInstanceSnapshot(file, options = {}) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, 未引导: true, 成员: {} };
    return { ok: false, 原因: `身份档案读不到（${error?.code ?? '未知'}）：${error instanceof Error ? error.message : String(error)}`, 成员: {} };
  }
  let doc;
  try {
    doc = JSON.parse(stripBom(text));
  } catch (error) {
    return { ok: false, 原因: `身份档案 JSON 解析失败：${error instanceof Error ? error.message : String(error)}（不得当空表放行）`, 成员: {} };
  }
  const 原始 = doc?.members;
  if (原始 === undefined || 原始 === null) return { ok: true, 未引导: true, 成员: {} };
  if (typeof 原始 !== 'object' || Array.isArray(原始)) {
    return { ok: false, 原因: '身份档案 members 不是对象（坏形状）：不得当空表放行', 成员: {} };
  }
  const 快照目录 = options?.快照目录 ?? join(dirname(file), DIR.卡快照);
  const 成员 = {};
  for (const [id, raw] of Object.entries(原始)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      成员[id] = { id, 岗位: null, 状态: null, 卡版本摘要: null, 委派者id: null, 就绪: false, 未就绪原因: '档案行形状不合法' };
      continue;
    }
    const 岗位 = typeof raw.岗位 === 'string' && raw.岗位 ? raw.岗位 : null;
    const 状态 = typeof raw.status === 'string' ? raw.status : null;
    const 卡版本摘要 = typeof raw.卡版本?.摘要 === 'string' && raw.卡版本.摘要 ? raw.卡版本.摘要 : null;
    const 委派者id = typeof raw.委派者?.id === 'string' && raw.委派者.id ? raw.委派者.id : null;
    // 会审绑定（补修I）：同步 guard 的唯一判据。**有键就必须按会审闭名单处理**——
    // 坏形状不许折成「没有绑定」而把通用工具放出去，所以归一失败也保留一个带 `无效` 的对象。
    const 会审绑定 = 读会审绑定(raw.会审绑定);
    const 天然凭证 = 岗位 === 'Lead' || 岗位 === '主权者' || 岗位 === '出厂作者';
    // 只有「在岗 + 已钉」才值得读盘验卡：封存/未钉的实例本来就不就绪，读它只是白花钱。
    const 卡面原因 = 状态 === '在岗' && 卡版本摘要 ? 校验钉住卡(快照目录, 卡版本摘要, raw.卡版本, 岗位) : null;
    const 未就绪原因 = 状态 !== '在岗'
      ? `状态为 ${状态 ?? '缺失'}`
      : (!卡版本摘要 ? '缺卡版本' : (卡面原因 ? `钉住卡快照不可用：${卡面原因}` : (!天然凭证 && !委派者id ? '缺委派归属' : null)));
    成员[id] = {
      id, 岗位, 状态, 卡版本摘要, 委派者id, 就绪: 未就绪原因 === null,
      ...(未就绪原因 === null ? {} : { 未就绪原因 }),
      ...(会审绑定 ? { 会审绑定 } : {}),
    };
  }
  return { ok: true, 成员 };
}

/**
 * 按内容寻址键找卡快照并验真实内容；任何一步不成立都返回可读原因（不抛）。
 *
 * @param {string} 目录 卡快照目录
 * @param {string} 摘要 钉住的摘要（也是文件名）
 * @param {object} 钉 身份档案里钉住的卡版本记录（岗位 / 声明版本 / 摘要）
 * @param {string|null} 岗位 档案登记岗位（校验卡内声明岗位必须与它一致）
 * @returns {string|null} 失败原因；通过 ⇒ null
 */
function 校验钉住卡(目录, 摘要, 钉, 岗位) {
  let 路径;
  try {
    路径 = join(目录, `${assertPathSegment(摘要, '卡版本摘要')}.json`);
  } catch (error) {
    return `卡版本摘要不是合法内容寻址键：${error instanceof Error ? error.message : String(error)}`;
  }
  const 读 = readVerifiedCardSnapshot(路径, { 钉: 钉 && typeof 钉 === 'object' ? 钉 : { 摘要 }, 期望岗位: 岗位 });
  return 读.ok ? null : 读.原因;
}
