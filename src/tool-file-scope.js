/**
 * 通用文件工具的权限边界。宿主现行父权限给出上限，显式部署配置可进一步收紧；Lead 按任务取子集。
 * 工作目录只解析相对路径，不构成权限。shell/未知工具没有可证明的文件沙箱，不能靠路径授权。
 */
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Denied, InvalidBody } from './kernel/errors.js';
import { readInstanceSnapshot } from './instance-snapshot.js';

export const FILE_READ_TOOLS = new Set(['read', 'read_image', 'glob', 'grep']);
export const FILE_WRITE_TOOLS = new Set(['write', 'edit']);
const lower = (s) => process.platform === 'win32' ? s.toLowerCase() : s;
export function insideFileRoot(path, root) {
  const rel = relative(lower(root), lower(path));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/** realpath 不识别硬链接；普通文件只在唯一目录项指向它时才有可证明的路径边界。 */
export function assertSingleLinkFile(stat, label = '普通文件') {
  if (stat.isFile() && stat.nlink !== 1 && stat.nlink !== 1n) {
    throw new Denied('通用文件工具 · 硬链接边界', `${label}存在多个硬链接或链接数不可确认，不能证明其内容仅属于授权路径（nlink=${String(stat.nlink)}）；请复制为独立的单链接文件。`);
  }
}

/** 缺目标允许留给新文件路径校验；其它读取失败和多链接普通文件均拒绝。 */
export function assertSingleLinkTarget(path) {
  try { assertSingleLinkFile(lstatSync(path)); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
}

/** 对新文件也解析最近存在的祖先，不把 junction 下的不存在目标按词法路径放行。 */
export function canonicalFileTarget(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || /[\u0000-\u001f]/.test(path)) throw new Error('需要无控制字符的绝对路径');
  // ADS、尾部点/空格是 NTFS 别名，不能让权限判定与宿主打开的对象分歧。
  if (process.platform === 'win32' && (/^\\\\[.?]\\/.test(path) || path.replace(/^[A-Za-z]:/, '').includes(':') || path.split(/[\\/]/).some((x) => /[. ]$/.test(x)))) throw new Error('不支持 Windows 设备命名空间、NTFS ADS 或尾部点/空格路径');
  const parts = [];
  let current = resolve(path);
  for (;;) {
    try {
      const real = realpathSync(current);
      assertSingleLinkFile(lstatSync(real));
      return lower(resolve(real, ...parts.reverse()));
    }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      // dangling symlink 不是待新建目录；不能沿父目录推导其真实落点。
      try { if (lstatSync(current).isSymbolicLink()) throw new Error('悬空符号链接不可授权'); }
      catch (e) { if (e?.code !== 'ENOENT') throw e; }
      const parent = dirname(current);
      if (parent === current) throw error;
      parts.push(relative(parent, current));
      current = parent;
    }
  }
}

function roots(input, name, { existing = true } = {}) {
  if (!Array.isArray(input) || input.some((x) => typeof x !== 'string' || !isAbsolute(x))) throw new InvalidBody(`${name} 必须是绝对路径字符串数组。`);
  return [...new Set(input.map((x) => {
    try {
      if (existing) realpathSync(x);
      return canonicalFileTarget(x);
    } catch (error) { throw new InvalidBody(`${name} 的路径不可解析：${x}（${error.message}）。`); }
  }))];
}

export class ToolFileAuthority {
  #read = [];
  #write = [];
  #layout;
  #policy;
  #goals;
  #configured;
  #hostCeiling;
  constructor({ layout, config, policy, goals, hostCeiling } = {}) {
    this.#layout = layout;
    this.#policy = policy;
    this.#goals = goals;
    if (hostCeiling !== undefined && typeof hostCeiling !== 'function') throw new InvalidBody('宿主文件权限桥必须由装配面提供同步函数。');
    this.#hostCeiling = hostCeiling;
    this.#configured = config !== undefined;
    if (!this.#configured) return; // 未配置静态表：使用可信宿主桥；两者皆无仍拒绝。
    if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some((x) => !['read', 'write'].includes(x))) throw new InvalidBody('memberFileAccess 只接受 read / write 数组（部署者配置，不接受模型自报）。');
    this.#read = roots(config.read ?? [], 'memberFileAccess.read');
    this.#write = roots(config.write ?? [], 'memberFileAccess.write');
    for (const root of [...this.#read, ...this.#write]) this.#assertUnprotected(root, true);
  }
  #assertUnprotected(path, recursive = false) {
    for (const root of [this.#layout?.privateRoot, this.#layout?.factoryRoot]) {
      if (!root) throw new Denied('通用文件工具 · 组织根不可判', '组织双区位置不完整，不能授予通用文件权限。');
      const protectedRoot = canonicalFileTarget(root);
      if (insideFileRoot(path, protectedRoot) || (recursive && insideFileRoot(protectedRoot, path))) throw new Denied('通用文件工具 · 组织原始文件隔离', '私有组织账本与出厂规则根禁止通用文件工具直读写，也不能从其父目录递归访问；组织动作请走 mind。');
    }
  }
  grant(input, subject) {
    if (input === undefined) return { 版本: 1, 授予者: String(subject?.id ?? ''), 读: [], 写: [] };
    if (subject?.kind !== 'Lead') throw new Denied('通用文件工具 · 仅 Lead 派发授权', '任务文件范围由成员的派发 Lead 授予，成员不能给自己授予；主权者通过部署配置设定可授上限。');
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((x) => !['读', '写'].includes(x))) throw new InvalidBody('工具文件范围只接受 读 / 写 绝对路径数组。');
    const read = roots(input.读 ?? [], '工具文件范围.读');
    const write = roots(input.写 ?? [], '工具文件范围.写');
    for (const [list, writing, name] of [[read, false, '读'], [write, true, '写']]) {
      for (const root of list) {
        this.#assertUnprotected(root, true);
        if (!this.#withinCeiling(root, writing, subject.id)) throw new Denied('通用文件工具 · 不越授', `${name}根 ${root} 不在真实宿主父会话现行权限与显式 memberFileAccess 配置的交集内；无可信来源仍拒绝，不从工作目录推导权限。`);
      }
    }
    return { 版本: 1, 授予者: String(subject.id), 读: read, 写: write };
  }
  #rootStillValid(root) {
    try { return lower(realpathSync(root)) === root; } catch { return false; }
  }
  #withinCeiling(root, writing, parent) {
    const ceiling = writing ? this.#write : this.#read;
    if (this.#configured && !ceiling.some(up => this.#rootStillValid(up) && insideFileRoot(root, up))) return false;
    if (this.#hostCeiling) return this.#hostCeiling(parent, root, writing) === true;
    // Standalone service callers may explicitly install a static deployment
    // ceiling. The production kernel ALWAYS installs the live host bridge.
    return this.#configured;
  }
  /** 服务层交卷只允许为本人当前仍有权读取/产出的文件计算摘要，不能借提交绕过撤权。 */
  canCapture(path, task, subject) {
    if (subject?.kind !== '成员') return true;
    const snapshot = readInstanceSnapshot(this.#layout?.identityFile?.());
    const member = snapshot.成员?.[subject.id];
    const parent = snapshot.成员?.[member?.委派者id];
    const grant = task?.工具文件范围;
    if (!snapshot.ok || !member?.就绪 || !parent?.就绪 || parent.岗位 !== 'Lead'
      || !(task.绑定 ?? []).some((b) => matchingBinding(b, subject.id, member))) return false;
    // 复核员的文件读权来自 Lead 的 task_attach，不来自通用文件写权。
    // 这里只允许冻结显式引用的已授权文件内容；不授予写权、不自动把读根列成交付物。
    if (member.岗位 === '复核员') {
      if (task.判据冻结 !== true || !(task.负责人 ?? []).some(owner => owner === subject.id || owner === member.岗位)
        || this.#decision(subject, task, 'write', 'submit').verdict !== 'allow') return false;
      return (task.复核读根 ?? []).some(root => typeof root === 'string' && isAbsolute(root)
        && this.#rootStillValid(root) && insideFileRoot(path, root));
    }
    if (grant?.版本 !== 1 || grant.授予者 !== member.委派者id) return false;
    if (this.#decision(subject, task, 'write').verdict !== 'allow') return false;
    try {
      return [[grant.读, false], [grant.写, true]].some(([list, writing]) => Array.isArray(list)
        && list.some(root => typeof root === 'string' && this.#rootStillValid(root) && insideFileRoot(path, root)
          && this.#withinCeiling(root, writing, member.委派者id)));
    } catch { return false; }
  }
  #decision(subject, task, action, operation = 'tool_file') {
    return this.#policy?.decideCurrentSync?.({ subject, action,
      target: { id: task.id, kind: '任务', authority: '自治', zone: '私有', project: task.项目 },
      context: { task, 节点操作: operation } }) ?? { verdict: 'deny', rule: '同步策略资格缺失', reason: '策略引擎没有同步新鲜度判定，不能授权通用文件工具。' };
  }
  /** 授权候选与递归交集同源；预算只能引用这些实际范围，不接受自报任务归属。 */
  scopeTasks({ tool, args, cwd, nodes, instance, parent, member }) {
    const writing = FILE_WRITE_TOOLS.has(tool);
    if (!writing && !FILE_READ_TOOLS.has(tool)) throw new Denied('成员通用工具 · 闭名单', `工具「${tool}」没有可核验的任务文件边界；shell、执行器、插件工具与未知工具均拒绝。请通过 mind 或向派发 Lead 报告。`);
    const recursive = tool === 'glob' || tool === 'grep';
    const path = recursive ? (args?.path ?? cwd) : args?.file_path;
    if (typeof path !== 'string' || !path.trim() || (!isAbsolute(path) && !cwd)) throw new Denied('成员通用工具 · 路径不可判', '缺少真实 arguments.file_path/path 或相对路径基准；未知即拒。');
    const target = canonicalFileTarget(isAbsolute(path) ? path : resolve(cwd, path));
    this.#assertUnprotected(target, recursive);
    const key = writing ? '写' : '读';
    const grants = nodes.filter((n) => ['已派发', '执行中'].includes(n.状态)
      && (n.绑定 ?? []).some((b) => matchingBinding(b, instance, member))
      && n.工具文件范围?.版本 === 1 && n.工具文件范围.授予者 === parent);
    const overlaps = (root, intersect = false) => typeof root === 'string' && this.#rootStillValid(root)
      && (insideFileRoot(target, root) || (intersect && insideFileRoot(root, target)));
    const scoped = grants.filter(task => Array.isArray(task.工具文件范围[key])
      && task.工具文件范围[key].some(root => overlaps(root) && this.#withinCeiling(root, writing, parent)));
    if (!scoped.length) throw new Denied('成员通用工具 · 任务文件范围', `目标不在本人真实绑定的活动任务所冻结的${key}根内，或绑定岗位/实例凭证已变化、父 Lead 可授上限已撤回；工作目录、负责人岗位名和产物引用不构成授权。`);
    // 宿主没有可信的本次任务归因。命中同一路径的任务不能借另一条重叠授权
    // 洗掉目标限制；不相关路径的独立工作仍按各自范围判定。
    // 递归搜索还会触及目标目录下的更窄任务根：反向包含只用于附加限制，绝不授予搜索权限。
    // 上限变窄只撤销授权，不能让仍活动的重叠任务限制消失。
    const constrained = grants.filter(task => Array.isArray(task.工具文件范围[key])
      && task.工具文件范围[key].some(root => overlaps(root, recursive)));
    return { writing, recursive, target, scoped, constrained };
  }
  check(input) {
    const { tool, nodes, instance, member } = input;
    const { writing, recursive, target, scoped, constrained } = this.scopeTasks(input);
    for (const task of constrained) {
      const goal = this.#goals?.constraintsForTask(task, nodes, task.项目);
      if (!goal) continue;
      if ((writing && goal.状态 !== '进行中') || goal.禁止工具.includes(tool)) {
        throw new Denied('目标 · 当前文件工具限制', `目标 ${goal.目标} 的当前修订 ${goal.修订} 不允许本次 ${tool}（状态：${goal.状态}）。本路径命中的目标约束不能借重叠任务绕过。`, {
          howToChange: '读取当前目标及限制；需要处理独立工作时使用无冲突的任务输出范围。放宽限制或恢复用户暂停须走人侧目标决议。',
          detail: { 目标: goal.目标, 修订: goal.修订, 工具: tool, 状态: goal.状态 },
        });
      }
    }
    const decisions = scoped.map((task) => this.#decision({ id: instance, kind: '成员', roleId: member?.岗位 }, task, writing ? 'write' : 'read'));
    if (!decisions.some((d) => d.verdict === 'allow')) throw new Denied(decisions[0].rule, decisions[0].reason);
    // 宿主 glob/grep 的未来选项可能跟随链接；在无法沙箱时拒绝含链接的搜索树。
    if (recursive) assertFileSearchTree(target);
  }
}

export function matchingBinding(binding, instance, member) {
  const pin = binding?.凭证;
  return binding?.实例 === instance && binding.岗位 === member?.岗位
    && pin?.版本 === 1 && pin.代 === member.代
    && pin.宿主代次 === member.宿主代次;
}

export function assertFileSearchTree(path, budget = { count: 0 }) {
  if (++budget.count > 10000) throw new Denied('成员通用工具 · 搜索边界', '搜索树超过 10000 个条目，无法同步确认链接边界；请缩小 path。');
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw new Denied('成员通用工具 · 搜索边界', '搜索树含符号链接/junction，通用递归搜索不能证明其读取边界；请缩小到无链接的目录或使用精确 read。');
  assertSingleLinkFile(st, '搜索树内普通文件');
  if (st.isDirectory()) for (const child of readdirSync(path)) assertFileSearchTree(join(path, child), budget);
  else if (!st.isFile()) throw new Denied('成员通用工具 · 搜索边界', '搜索树含非常规文件，无法确认读取边界。');
}
