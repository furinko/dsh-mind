/**
 * 载体布局（§14 目录结构）。
 *
 * 为什么路径集中在一个人手里：§14 那条纪律是「目录负责找得到，标签负责谁能改」。
 * 本文件只负责前半句——把「哪个对象住在哪」写成唯一的一张表；
 * 后半句在 `tags.js` + `policy.js`，两边不互相看一眼。
 *
 * 两区：
 *  - 出厂区 = 插件包自带的 `mind/`（只读模板，随产品更新；§5「出厂区装程序与模板」）
 *  - 私有区 = `$DSH_HOME/mind-data/mind-private/`（主权者的覆盖 + 跑出来的数据）
 *
 * 私有区根沿用既有 `mind-data/mind-private`，新增目录与旧系统的 `L0/L1/L2/L3` 并列而不覆盖
 * （§13.3：旧数据不迁移、但保留、原地只读、不接入检索面）。
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InvalidBody } from './kernel/errors.js';

/**
 * 路径片段校验：项目键 / 线程 / 对象 id / 岗位 这类**入口可控**的字符串，
 * 进 `join` 之前必须过这一关——`project="../../x"` 一行就能让账本与审计追加落到私有区外面。
 * 拒绝：空串、`.` / `..`、路径分隔符、冒号（盘符/ADS）、控制字符。
 * 正常片段（中文、点号如 `my.proj`、连字符）原样放行。
 *
 * @param {unknown} value
 * @param {string} 名 出错时指给调用方看的字段名
 * @returns {string} 通过校验的片段
 */
export function assertPathSegment(value, 名) {
  const s = String(value ?? '');
  if (!s || s === '.' || s === '..' || /[/\\:]/.test(s) || /[\u0000-\u001f]/.test(s)) {
    throw new InvalidBody(`路径片段不合法（${名}）：不许为空、不许是 . 或 ..、不许含路径分隔符 / 冒号 / 控制字符。`, { detail: { 字段: 名, 值: s } });
  }
  return s;
}

/**
 * 线程键的等价类：**哪些写法算「同一个线程」**（唯一源，紧挨 `assertPathSegment` ——
 * 两者管的是同一件事：入口可控的字符串进路径之前该怎么看它）。
 *
 * 为什么必须有它（批c 补漏 · P3，2026-10-10 复核实证）：**落线侧的键是文件系统给的** ——
 * `busThread()` 把线程名直接 join 进路径，而本部署落在 NTFS（大小写不敏感）⇒
 * `TASK-X.jsonl` 与 `task-x.jsonl` 是**同一个文件**（实测：动作面用大写别名发一条，
 * `readRaw(真 id)` 就读得到同一份内容）。所以判定侧不许自己发明一套口径：
 * 「判定用精确键 + 落线用不敏感键」＝ 大小写别名就是一条旁路。
 *
 * 口径**不多不少**，就照落线侧的等价类来：
 *  - **只折大小写**（`toUpperCase`，与 NTFS 的比较表同向；线程名/节点 id 是 ASCII slug + 哈希，等价类一致）；
 *  - **不做 Unicode 规范化**：NTFS 不折 NFKC，折了会让判定比落线**更宽**（`①.jsonl` 与 `1.jsonl` 是两个文件）
 *    —— 那是**误伤**（把两个普通线程判成同一个线程），同样是与落线侧不一致；
 *  - **不折分隔符 / 冒号**：`assertPathSegment` 已在落线侧把它们一律拒掉 ⇒ 那一面本来就没有别名可绕。
 *
 * 已知边界（如实记）：本函数与 NTFS 的比较表在**非 ASCII 大小写**上未必逐字符同向
 * （`ß` / `ı` 这类）；本部署的线程名与节点 id 由 `slugOf` 生成（字母 + 数字 + 哈希），不落在这条边界上。
 * 真出现非 ASCII 别名时，要按**当时载体的比较表**复核这一处，别假设它天然对。
 *
 * @param {unknown} thread
 * @returns {string}
 */
export function 线程等价键(thread) {
  return String(thread ?? '').toUpperCase();
}

/**
 * 出厂区的绝对路径——**全插件唯一的答案**。
 *
 * 为什么不让每个组件自己算：相对路径的层数取决于组件在目录树里的深度，
 * 每多一个组件就多一次算错的机会（实测把 `../../` 写少一层，策略引擎读不到规则件、
 * 直接 fail-closed）。「出厂区在哪」本来就是载体问题，答案放在载体模块里。
 *
 * @returns {string}
 */
export function kernelFactoryRoot() {
  return fileURLToPath(new URL('../mind/', import.meta.url));
}

/** §14.1/§14.2 的目录名，原文照抄，不翻译、不改写。 */
export const DIR = {
  宪章: '集体L0-宪章',
  法律: '集体L1-法律',
  集体结构: '集体L2-集体结构',
  基础设施: '集体L2-共享基础设施',
  角色卡: '集体L3-成员角色卡',
  角色注册表: '角色注册表',
  工作台: '共享工作台',
  任务图: '任务图',
  消息总线: '消息总线',
  策略引擎: '策略引擎',
  能力库: '能力库',
  记忆服务: '记忆服务',
  审计日志: '审计日志',
  产物库: '产物库',
  默认值: 'defaults',
  跨项目: '跨项目',
  升级: '升级',
  版本历史: '版本历史',
  身份档案: '身份档案',
};

/** 记忆四类（§7「记忆服务的四类」）。 */
export const MEMORY_KINDS = ['知识', '经历', '偏好', '作答'];

/** 宪法与法律出厂默认文本（§14.1）。 */
export const RULE_FILES = [
  { id: '宪章', authority: '宪章', dir: DIR.宪章, file: '宪章.md' },
  { id: '协作协议', authority: '法律', dir: DIR.法律, file: '协作协议.md' },
  { id: '权限矩阵', authority: '法律', dir: DIR.法律, file: '权限矩阵.md' },
  { id: '裁决流程', authority: '法律', dir: DIR.法律, file: '裁决流程.md' },
  { id: '审计要求', authority: '法律', dir: DIR.法律, file: '审计要求.md' },
];

/** 出厂侧的基础岗位卡（§14.1）。 */
export const ROLE_CARD_FILES = ['_模板.md', '复核员.md', '插件工程.md', '文档整理.md', '记忆整理.md'];

/**
 * 出厂默认值（§14.1 `defaults/`）：介入度 / 响应期限 / 工具总范围 / 安全类探针。
 *
 * **每个键只有一个源**（§5 单源）：
 *  - `介入度.json` → `介入度`（**不再承载 `响应期限小时`**）
 *  - `响应期限.json` → `失联限制` ＋ `响应期限小时`（这两个键的**唯一**出厂源）
 *  - `工具总范围.json` → 工具范围闸的白 / 黑名单（由内核组件另读）
 *  - `安全类探针.json` → 安全类探针声明（**并入运行态时键名改成 `安全类`**）
 * 私有区 `部署.json` 是叠加层：同名键压过出厂那几份（主权者优先）。
 *
 * **合并次序（低 → 高，见 `src/policy.js` 的 `#loadDefaults()`）**：
 *  内置兜底 → 出厂 `介入度.json` → 出厂 `响应期限.json` → 出厂 `安全类探针.json` → **私有 `部署.json`**。
 *  两条容易踩的细则：
 *   ① **出厂区内 `介入度.json` 在 `响应期限.json` 之前读** ⇒ 老部署若在 `介入度.json` 里留了一份
 *      `响应期限小时`（Batch 1 之前那是双源），冲突时**以 `响应期限.json` 为准** —— 这是有意的
 *      （`响应期限.json` 是这两个键的唯一出厂源），别按「谁先谁后无所谓」去调这两行。
 *   ② **私有 `部署.json` 是最后一份**，`安全类` 也压得过出厂探针声明 —— 私有最后覆盖是全键统一的，
 *      别把探针声明挪到私有层之后再并入（那会让「私有优先」在这里失效）。
 *      **事实核对（Batch 2.5 复核官逐行核过 HEAD）**：旧实现里私有那份本来就压得过
 *      （探针赋值在「出厂」那次迭代内，私有 `Object.assign` 在其后）⇒ 这次调整在**行为面是 no-op**，
 *      它只是把次序写显式；而运行态 `安全类` 这一格当前**无消费者**
 *      （`probes.js` 读的是出厂声明文件，不是运行态这一格）。
 * 出厂件里的纯文档键（`说明` 之类）**不进运行态**（白名单式并入），被剔掉的键名进 `忽略的默认值键`。
 */
export const DEFAULT_FILES = {
  介入度: '介入度.json',
  响应期限: '响应期限.json',
  工具总范围: '工具总范围.json',
  安全类探针: '安全类探针.json',
};

/**
 * 双区载体。实例化一次，全局复用。
 */
export class Layout {
  /**
   * @param {{ factoryRoot: string, privateRoot: string }} roots
   *   factoryRoot：插件包内的 `mind/`；privateRoot：`$DSH_HOME/mind-data/mind-private`
   */
  constructor(roots) {
    this.factoryRoot = roots.factoryRoot;
    this.privateRoot = roots.privateRoot;
  }

  /** @param {string} rel @returns {string} 出厂区绝对路径 */
  factory(...rel) {
    return join(this.factoryRoot, ...rel);
  }

  /** @param {string} rel @returns {string} 私有区绝对路径 */
  private(...rel) {
    return join(this.privateRoot, ...rel);
  }

  /** @param {'出厂'|'私有'} zone */
  root(zone) {
    return zone === '出厂' ? this.factoryRoot : this.privateRoot;
  }

  /** 规则文件（宪章 / 法律），两区各一份 —— 私有区那份是覆盖层。 */
  rulePath(ruleId, zone) {
    const spec = RULE_FILES.find((r) => r.id === ruleId);
    if (!spec) return null;
    return zone === '出厂' ? this.factory(spec.dir, spec.file) : this.private(spec.dir, spec.file);
  }

  /** 编制（集体结构）。 */
  establishmentPath(zone = '自治') {
    return zone === '出厂' ? this.factory(DIR.集体结构, '编制.md') : this.private(DIR.集体结构, '编制.md');
  }

  /** 角色卡目录。 */
  roleCardDir(zone = '自治') {
    return zone === '出厂' ? this.factory(DIR.角色卡) : this.private(DIR.角色卡);
  }

  /** 能力库目录：出厂能力库 / 自治能力库（§5「两个能力库 = 双区各一份」）。 */
  capabilityDir(zone = '自治') {
    return zone === '出厂' ? this.factory(DIR.基础设施, DIR.能力库) : this.private(DIR.基础设施, DIR.能力库);
  }

  /** 产物库（`kind = 产物` 的落点；任务节点只存引用）。 */
  artifactDir() {
    return this.private(DIR.基础设施, DIR.产物库);
  }

  /** 任务图：`任务图/<项目>/tasks.jsonl`（append-only 事件流，状态可重算）。 */
  taskLog(project) {
    return this.private(DIR.基础设施, DIR.任务图, assertPathSegment(project, '项目'), 'tasks.jsonl');
  }

  /** 任务图的锁。 */
  taskLock(project) {
    return this.private(DIR.基础设施, DIR.任务图, assertPathSegment(project, '项目'), '.tasks.lock');
  }

  /** 消息总线目录：`消息总线/<项目>/`。 */
  busDir(project) {
    return this.private(DIR.基础设施, DIR.消息总线, assertPathSegment(project, '项目'));
  }

  /**
   * 消息总线线程文件：`消息总线/<项目>/<线程>.jsonl`。
   *
   * ⚠️ 这里拼出的路径就是**线程的落点**，而它认的等价类是**文件系统的**（NTFS 大小写不敏感）——
   * 判定侧（如 `lib/actions.js` 的讨论线程判据）不许自己再发明一套，一律走 `线程等价键()`（同文件顶部）。
   */
  busThread(project, thread) {
    return join(this.busDir(project), `${assertPathSegment(thread, '线程')}.jsonl`);
  }

  /** 记忆服务目录：`记忆服务/跨项目/` 或 `记忆服务/<项目>/`。 */
  memoryDir(scope) {
    return this.private(DIR.基础设施, DIR.记忆服务, assertPathSegment(scope, '记忆范围'));
  }

  /** 某一类记忆的账本文件。 */
  memoryLog(scope, kind) {
    return join(this.memoryDir(scope), `${assertPathSegment(kind, '记忆类')}.jsonl`);
  }

  /** 审计日志：按月分片，不按项目分（§14.3）。 */
  auditLog(month) {
    return this.private(DIR.基础设施, DIR.审计日志, `audit-${month}.jsonl`);
  }

  /** 审计日志目录。 */
  auditDir() {
    return this.private(DIR.基础设施, DIR.审计日志);
  }

  /** 审计链锚：记住每片最后一条的链哈希，重启后据此续链。 */
  auditAnchor(month) {
    return this.private(DIR.基础设施, DIR.审计日志, `.anchor-${month}.json`);
  }

  /** 角色注册表：索引，不是真源（§14.2 明确标注）。 */
  registryFile() {
    return this.private(DIR.基础设施, DIR.角色注册表, 'index.json');
  }

  /** 身份档案：实例身份、封存状态、拒绝名单。 */
  identityFile() {
    return this.private(DIR.身份档案, 'identity.json');
  }

  identityLock() {
    return this.private(DIR.身份档案, '.identity.lock');
  }

  /** 部署偏好（私有区的覆盖层）。 */
  deploymentPrefs() {
    return this.private(DIR.基础设施, DIR.默认值, '部署.json');
  }

  /** 出厂默认值。 */
  factoryDefault(name) {
    return this.factory(DIR.基础设施, DIR.默认值, DEFAULT_FILES[name]);
  }

  /** 安全类探针的出厂声明。 */
  probeDeclaration() {
    return this.factory(DIR.基础设施, DIR.默认值, DEFAULT_FILES.安全类探针);
  }

  /** 探针的运行状态（私有区：跑出来的东西）。 */
  probeState() {
    return this.private(DIR.基础设施, DIR.默认值, '探针状态.json');
  }

  /** 探针快照目录：每一版机制留下全绿/见红的证据，供「回滚到全绿最近一版」。 */
  probeSnapshotDir() {
    return this.private(DIR.升级, '探针快照');
  }

  /** 升级：基线戳。 */
  baselineFile() {
    return this.private(DIR.升级, '基线.json');
  }

  /** 升级：挂起的 diff 队列（§5「挂起不阻塞其他更新」）。 */
  pendingDir() {
    return this.private(DIR.升级, '挂起');
  }

  pendingFile(id) {
    return join(this.pendingDir(), `${assertPathSegment(id, '挂起项id')}.json`);
  }

  /** 版本历史：`版本历史/<对象id>/<版本号>.md`（§14.4-4）。 */
  historyDir(objectId) {
    return this.private(DIR.版本历史, assertPathSegment(objectId, '对象id'));
  }

  historyFile(objectId, version) {
    return join(this.historyDir(objectId), `${version}.md`);
  }

  /** 版本历史的索引（记录每个对象当前版本指针；审计只记指针）。 */
  historyIndex() {
    return this.private(DIR.版本历史, 'index.json');
  }

  /**
   * 文档类对象的落点。
   * @param {string} kind §6 kind
   * @param {Record<string, any>} meta
   * @param {'出厂'|'私有'} zone
   * @returns {string}
   */
  documentPath(kind, meta, zone) {
    const id = assertPathSegment(meta.id, '对象id');
    switch (kind) {
      case '规则':
        return zone === '出厂'
          ? this.factory(meta.authority === '宪章' ? DIR.宪章 : DIR.法律, `${id}.md`)
          : this.private(meta.authority === '宪章' ? DIR.宪章 : DIR.法律, `${id}.md`);
      case '身份':
        return join(this.roleCardDir(zone), `${id}.md`);
      case '能力':
        return join(this.capabilityDir(zone), `${id}.md`);
      case '产物':
        return join(this.artifactDir(), `${id}.md`);
      default:
        throw new Error(`文档类对象不支持 kind：${kind}`);
    }
  }
}

/**
 * 默认布局：出厂区取插件包内的 `mind/`，私有区取 `$DSH_HOME/mind-data/mind-private`。
 * @param {{ home: string, factoryRoot: string, privateRoot?: string }} spec
 * @returns {Layout}
 */
export function defaultLayout(spec) {
  return new Layout({
    factoryRoot: spec.factoryRoot,
    privateRoot: spec.privateRoot ?? join(spec.home, 'mind-data', 'mind-private'),
  });
}
