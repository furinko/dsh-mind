/** Lead 对需求的可修正解释；不认证用户表达，也不改变目标、判据或操作权限。 */
import { InvalidBody } from './kernel/errors.js';

export function normalizeDemandUnderstanding(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['原始表达', '当前理解', '来源', '待验证', '关键问题', '分工'].includes(key))) throw new InvalidBody('需求理解必须是包含原始表达、当前理解和来源的对象；可选待验证、关键问题与分工，不接受认证或权限字段。');
  const text = (v, name, max) => {
    if (typeof v !== 'string' || !v.trim() || v.length > max) throw new InvalidBody(`需求理解.${name}必须为1至${max}字符。`);
    return v.trim();
  };
  const list = (v, name, max) => {
    if (!Array.isArray(v) || v.length > max) throw new InvalidBody(`需求理解.${name}必须是最多${max}项文本数组。`);
    return v.map(item => text(item, name, 240));
  };
  const out = { 原始表达: text(value.原始表达, '原始表达', 1000), 当前理解: text(value.当前理解, '当前理解', 1000), 来源: text(value.来源, '来源', 500) };
  if (Object.hasOwn(value, '待验证')) out.待验证 = list(value.待验证, '待验证', 6);
  if (Object.hasOwn(value, '关键问题')) out.关键问题 = list(value.关键问题, '关键问题', 3);
  if (Object.hasOwn(value, '分工')) {
    if (!Array.isArray(value.分工) || value.分工.length > 6) throw new InvalidBody('需求理解.分工必须是最多6项的岗位、工作和理由对象数组。');
    out.分工 = value.分工.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 3 || Object.keys(item).some(key => !['岗位', '工作', '理由'].includes(key))) throw new InvalidBody('需求理解.分工每项只接受岗位、工作和理由；分工建议不产生任务或授权。');
      return { 岗位: text(item.岗位, '分工岗位', 80), 工作: text(item.工作, '分工工作', 500), 理由: text(item.理由, '分工理由', 240) };
    });
  }
  return out;
}
