import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
// 包的代码/运行资源范围服从根files；排除可变规则数据和文档，不能把它们冒充检测实现身份。
const EXCLUSIONS = Object.freeze([
  Object.freeze({ 路径: 'mind', 原因: '出厂规则/角色/默认值数据，不是代码身份；声明由封闭清单探针单独校验' }),
  Object.freeze({ 路径: 'README.md', 原因: '说明文档，不是运行资源' }),
]);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function capture() {
  let current = 'package.json';
  try {
    if (!lstatSync(join(ROOT, current)).isFile()) throw new Error('根清单必须是实体文件');
    const manifest = JSON.parse(readFileSync(join(ROOT, current), 'utf8'));
    if (typeof manifest.name !== 'string' || !manifest.name || typeof manifest.version !== 'string' || !manifest.version) throw new Error('包名或实际包版本缺失');
    if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error('根files发布范围缺失');
    function relative(value) {
      if (typeof value !== 'string' || !value || value.startsWith('/') || /[\\:*?\[\]{}]/.test(value)) throw new Error('发布范围必须是包内明确路径，不接受glob或绝对路径');
      const path = value.replace(/^\.\//, '').replace(/\/$/, '');
      if (path.split('/').some((p) => !p || p === '.' || p === '..')) throw new Error('发布范围不能跨出包根');
      return path;
    }
    const excluded = new Set(EXCLUSIONS.map((e) => e.路径));
    const roots = [...new Set(['package.json', ...manifest.files.map(relative).filter((p) => !excluded.has(p))])].sort();
    const paths = [];
    function visit(path) {
      current = path;
      const stat = lstatSync(join(ROOT, path));
      if (stat.isSymbolicLink()) throw new Error('代码/运行资源范围不接受符号链接');
      if (stat.isDirectory()) {
        const entries = readdirSync(join(ROOT, path));
        if (!entries.length) throw new Error('发布代码目录为空');
        for (const name of entries) visit(`${path}/${name}`);
      } else if (stat.isFile()) paths.push(path);
      else throw new Error('发布范围含未知文件类型');
    }
    for (const path of roots) visit(path);
    const required = [];
    function entry(value) {
      if (typeof value === 'string') required.push(relative(value));
      else if (value && typeof value === 'object') Object.values(value).forEach(entry);
      else throw new Error('运行入口声明无法解析');
    }
    for (const value of [manifest.main, manifest.icon, manifest.dsh?.bundle?.patch, manifest.exports]) entry(value);
    for (const path of required) {
      current = path;
      if (!paths.includes(path)) throw new Error('必需运行入口不在已核发布代码/资源集合');
    }
    const files = [...new Set(paths)].sort().map((path) => {
      current = path;
      return Object.freeze({ 路径: path, SHA256: sha256(readFileSync(join(ROOT, path))) });
    });
    const fingerprint = sha256(JSON.stringify(files));
    return Object.freeze({
      状态: '已核代码身份', 包名: manifest.name, 包版本: manifest.version,
      代码指纹: fingerprint, 机制版本: `${manifest.name}@${manifest.version}+sha256:${fingerprint}`,
      范围来源: '根package.json.files中的代码/运行资源＋实际exports/main/icon/patch入口核对',
      范围: Object.freeze(roots), 排除: EXCLUSIONS, 必需入口: Object.freeze([...new Set(required)].sort()), 文件: Object.freeze(files),
      制品来源: null, 可恢复: '不可确定',
      说明: '模块加载期发布代码/资源身份；不是已发布包或git提交的恢复凭据。没有精确制品出处，须主权者经版本管理核对，运行态不创建制品或装回文件。',
    });
  } catch (error) {
    return Object.freeze({ 状态: '不可确定', 机制版本: null, 制品来源: null, 可恢复: '不可确定', 说明: `代码身份读取失败：${current}（${error.code ?? error.message}）` });
  }
}

const LOADED = capture();

/**
 * 返回实际包加载期的代码身份；源码漂移或缺件返回明确未知，不把盘上新代码冒充已加载代码。
 * @returns {object} 只含包内相对路径和内容摘要，无私有数据；不抛出、不写盘、不建立恢复制品。
 */
export function mechanismArtifact() {
  if (LOADED.状态 !== '已核代码身份') return LOADED;
  const current = capture();
  if (current.状态 !== '已核代码身份') return current;
  if (current.机制版本 !== LOADED.机制版本) return { 状态: '不可确定', 机制版本: null, 制品来源: null, 可恢复: '不可确定', 说明: '加载后包内源码发生漂移，不能证明当前内存执行身份；须重新装配并核对版本管理。' };
  return LOADED;
}
