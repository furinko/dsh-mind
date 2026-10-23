/**
 * 对象存储（§6「对象存储是底座，不是一件」）。
 *
 * 三件被设计点名的行为，本文件是它们唯一的实现处：
 *  1. **策略引擎是唯一写入口** —— 所有文档类对象都必须先过 `policy.check()`。
 *  2. **版本化在写时自动发生** —— 任何带 version 的对象，改动前自动留前一版。
 *  3. **回滚动作读历史版本，审计日志只记版本指针** —— 审计里不会出现正文。
 *
 * 只管**文档类**对象（规则 / 身份 / 能力 / 产物）。账目类（任务 / 消息 / 记忆 / 审计）
 * 走各自的 append-only 服务，因为它们的真相是「事件序列」而不是「当前文本」。
 */
import { listFiles, readJsonOrNull, readTextOrNull, atomicWrite, mutateLocked, withLock } from './kernel/fsx.js';
import { InvalidBody, Fault } from './kernel/errors.js';
import { parseVersionName } from './kernel/ids.js';
import { digest } from './kernel/text.js';
import { assertStructure, effectiveDocument, formatFrontMatter, highestAuthority, parseDocument } from './tags.js';
import { RULE_FILES } from './paths.js';

/** 走对象存储的 kind。其余 kind 由各自的服务负责。 */
export const DOCUMENT_KINDS = ['规则', '身份', '能力', '产物'];

/** 历史的物理身份含类型与来源；旧 id 自身不允许冒号，索引键不会与旧键相撞。 */
function historyIdentity(kind, zone = '私有') {
  if (!DOCUMENT_KINDS.includes(kind) || !['私有', '出厂'].includes(zone) || (kind === '产物' && zone === '出厂')) {
    throw new InvalidBody('版本历史需要明确有效的对象类与来源区。');
  }
  return { kind, zone };
}
const historyKey = (id, { kind, zone }) => `${kind}:${zone}:${id}`;
const historyFault = (id, version) => new Fault('STORE_HISTORY_AMBIGUOUS',
  `旧历史 ${id}@v${version} 缺少唯一可验证的类型、来源及内容回执；保留原件，不猜测归属。`);

/** 旧共享路径不以正文自报标签认归属，须核对完整审计链中的原写入摘要回执。 */
async function legacyHistoryIdentity(id, version, content, evidence) {
  const parsed = parseDocument(content.toString());
  if (String(parsed.meta.id) !== id || !DOCUMENT_KINDS.includes(parsed.meta.kind)
      || Number(parsed.meta.version) !== version) throw historyFault(id, version);
  const hash = digest(content);
  const matches = new Map();
  let rows;
  try { rows = await evidence(); } catch { throw historyFault(id, version); }
  for (const row of rows) {
    if (row.动作 !== '状态变更' || row.对象?.id !== id || row.对象?.kind !== parsed.meta.kind
        || row.详情?.版本指针 !== `${id}@v${version}` || row.详情?.摘要 !== hash
        || !['私有', '出厂'].includes(row.详情?.区)) continue;
    const identity = historyIdentity(parsed.meta.kind, row.详情.区);
    if (parsed.meta.zone && parsed.meta.zone !== identity.zone) continue;
    matches.set(historyKey(id, identity), identity);
  }
  if (matches.size !== 1) throw historyFault(id, version);
  return [...matches.values()][0];
}

/**
 * 对象库及交付物核验共用历史解析。read可保留调用方更严格的链接/句柄核验；
 * 返回本次读出的正文，不在验证归属后重新读取一个可能变化的文件。
 */
export async function readObjectHistory({ layout, audit, id, version, kind, zone = '私有',
  read = readTextOrNull, evidence = () => audit.readVerified() }) {
  const identity = historyIdentity(kind, zone);
  if (!Number.isSafeInteger(version) || version < 1) throw new InvalidBody('历史版本必须是正整数。');
  let path = layout.historyFile(id, `v${version}`, identity);
  let content = await read(path);
  if (content === null) {
    path = layout.historyFile(id, `v${version}`);
    content = await read(path);
    if (content === null) return null;
    const owner = await legacyHistoryIdentity(id, version, content, evidence);
    if (owner.kind !== kind || owner.zone !== zone) return null;
  }
  const parsed = parseDocument(content.toString());
  if (String(parsed.meta.id) !== id || parsed.meta.kind !== kind
      || (parsed.meta.zone && parsed.meta.zone !== zone) || Number(parsed.meta.version) !== version) {
    throw new Fault('STORE_HISTORY_INVALID', `版本历史 ${id}@v${version} 与对象身份不符，保留原件。`);
  }
  return { path, content };
}

export class ObjectStore {
  /**
   * @param {{ layout: import('./paths.js').Layout, policy: import('./policy.js').PolicyEngine, audit: import('./audit.js').AuditLog, clock: import('./kernel/time.js').Clock }} spec
   */
  constructor(spec) {
    this.layout = spec.layout;
    this.policy = spec.policy;
    this.audit = spec.audit;
    this.clock = spec.clock;
  }

  /**
   * 读一个对象：私有区覆盖出厂区（§5 叠加层），命中即返回，并标注它来自哪一区。
   *
   * @param {string} kind
   * @param {string} id
   * @param {{ subject: object, zone?: '出厂'|'私有' }} spec
   * @returns {Promise<{ id: string, kind: string, zone: '出厂'|'私有', path: string, meta: object, body: string, authority: string, segments: object[], clauses: object[], digest: string }|null>}
   */
  async read(kind, id, spec) {
    const zones = spec.zone ? [spec.zone] : ['私有', '出厂'];
    // R18（审查 2026-10-16）：显式指定单区时按区读（写侧的回读语义不变）；不指定时
    // **两侧都读、段级合并**——修前私有命中即短路，出厂里未被私有碰过的段在生效面上消失
    // （报告实证：法律档能力卡被低档重发后限制实际失效）。与规则件/角色卡同一解析器。
    if (spec.zone) {
      const path = this.#pathFor(kind, { id }, spec.zone, spec.authority);
      if (!path) return null;
      const text = await readTextOrNull(path);
      if (text === null) return null;
      return this.#decorate(kind, id, spec.zone, path, text);
    }
    const 私有路径 = this.#pathFor(kind, { id }, '私有', spec.authority);
    const 出厂路径 = this.#pathFor(kind, { id }, '出厂', spec.authority);
    const 私有文本 = 私有路径 ? await readTextOrNull(私有路径) : null;
    const 出厂文本 = 出厂路径 ? await readTextOrNull(出厂路径) : null;
    if (私有文本 === null && 出厂文本 === null) return null;
    if (私有文本 === null) return this.#decorate(kind, id, '出厂', 出厂路径, 出厂文本);
    if (出厂文本 === null) return this.#decorate(kind, id, '私有', 私有路径, 私有文本);
    const 生效 = effectiveDocument(出厂文本, 私有文本, { 出厂标为: '出厂', 私有标为: '私有' });
    return this.#decorate(kind, id, '私有', 私有路径, 生效.body, 生效, { 合并来源: 生效.合并来源 });
  }

  /**
   * 写入：策略判定 → 结构校验 → 留前一版 → 原子替换 → 入账。
   *
   * @param {string} kind
   * @param {{ meta: object, body: string }} document
   * @param {{ subject: object, reason: string, segment?: string, zone?: '出厂'|'私有', task?: object }} spec
   *   `task` 是**任务内全权**的凭据：成员交产物时必须给，否则会被判成任务外。
   * @returns {Promise<{ id: string, version: number, zone: '私有', path: string, authority: string, previous: number|null, digest: string }>}
   */
  async write(kind, document, spec) {
    if (!DOCUMENT_KINDS.includes(kind)) {
      throw new InvalidBody(`kind=${kind} 不是文档类对象：请交给对应的 append-only 服务写入。`, {
        detail: { kind, handled: DOCUMENT_KINDS },
      });
    }
    const meta = { ...document.meta, kind };
    const id = meta.id;
    if (!id) throw new InvalidBody(`${kind} 对象缺少 id`);

    // 出厂区只对出厂作者开放（§5：出厂件随产品更新，不由本部署改写）。
    const zone = spec.zone ?? '私有';
    if (zone === '出厂' && spec.subject?.kind !== '出厂作者') {
      throw new InvalidBody('出厂区是只读模板：只有出厂作者能改动它，本部署的改动一律进私有区叠加层。', {
        detail: { zone, subject: spec.subject?.kind ?? null },
      });
    }

    // 正文、历史和指针共用类型/来源/id身份锁；同对象并发更新不能共用版本号，
    // 不同对象即使id相同也不能共用历史。锁先落v2目录，旧写入器从此不得接管。
    historyIdentity(kind, zone);
    const lockPath = this.layout.historyObjectLock(id, { kind, zone });
    return withLock(lockPath, async () => {
      // existing 读取带 zone 限定（2026-10-13 审查 P2-15）：修前按 私有→出厂 合并读——
      // 出厂作者更新出厂件时 existing 会命中私有叠加层 ⇒ version 按私有副本续算、
      // #keepVersion 把私有正文存进历史，而私有叠加层仍遮蔽新出厂件（更新静默不可见）。
      // 版本谱系跟着**写入目标那一区**走：写哪一区，就从哪一区读 existing。
      const existing = await this.read(kind, id, { subject: spec.subject, zone });
      // version 从 front matter 里读回来是**字符串**；不转数字就会得到 v1 → v11 这种版本号。
      const previous = existing ? Number(existing.meta.version ?? 1) : null;
      if (existing && (!Number.isSafeInteger(previous) || previous < 1 || existing.meta.kind !== kind
          || (existing.meta.zone && existing.meta.zone !== zone))) throw new InvalidBody('既有对象类型、来源或版本无效，不能继续版本链。');
      // R17（审查 2026-10-16 · 按旧/新最高档判定，档位标签不可被重写降级）：修前判定用
      // 【调用方想写成的】meta.authority——既有法律档对象被同 id 低档位重发覆盖成自治
      // （审查实证：正确针对既有法律卡的 write 判 deny，经生产能力发布服务却覆盖成功）。
      // 修法三件：
      //  ① 判定档 = max(既有对象档, 新元数据档, 新正文段最高档)——正文档来自 parseDocument
      //     （其 authority 即各段 authority 的最高值，tags.js 单源）；
      //  ② 写入档跟既有对象：调用方元数据不得改写既有对象的档位标签——降级结构性不可能；
      //     升档按高档判（实际只有主权者过得去），即「授权标签变更单独过闸」的最小实现；
      //  ③ 首写对象（无既有面）照 meta 判。
      const 正文最高档 = parseDocument(String(document.body ?? ''), { defaultAuthority: '自治' }).authority;
      // 既有档读 front matter 的 authority（标签真源）——decorate 的 .authority 是**段推导**
      // 值（正文无 `<!-- authority: -->` 段标记时恒自治），吃这个差正是 R17 的病根之一：
      // 法律标签的卡被读成自治，重发覆盖时按自治判、按自治写，标签静默降级。
      const 既有档 = existing?.meta?.authority ?? existing?.authority ?? null;
      let 判定档 = meta.authority ?? 既有档 ?? '自治';
      for (const 候选 of [既有档, meta.authority, 正文最高档]) {
        if (候选) 判定档 = highestAuthority([判定档, 候选]);
      }
      // 写入档 = 判定档（单调不降）：降级结构性不可能——低档重发按高档判，非主权者过不去；
      // 主权者带低档元数据重写，落盘档位仍是高档（标签降不下来）。升档同样按高档判，
      // 等价「授权标签变更单独过闸」的最小实现（能对高档判 write 的只有主权者）。
      meta.authority = 判定档;

      await this.policy.check({
        subject: spec.subject,
        action: existing ? 'write' : 'create',
        target: {
          id,
          kind,
          authority: 判定档,
          zone,
          domain: meta.domain ?? '集体',
          project: meta.project ?? null,
          segment: spec.segment ?? null,
        },
        // 任务节点要一起传下去：§2「成员任务内全权，任务外无」——
        // 成员写下自己的产出物正是「交卷」，没有这个上下文它会被判成「任务外」而拒写。
        context: { reason: spec.reason, task: spec.task ?? null },
      });

      const version = previous === null ? 1 : previous + 1;
      meta.version = version;
      meta.zone = zone;
      const text = `${formatFrontMatter(meta)}${document.body.startsWith('\n') ? document.body.slice(1) : document.body}`;
      const parsed = parseDocument(text, { defaultAuthority: meta.authority });
      assertStructure(kind, parsed);

      const path = this.#pathFor(kind, meta, zone, meta.authority);
      if (!path) throw new InvalidBody(`对象存储没有 ${kind} 的落点`);
      if (existing) await this.#keepVersion(id, existing, previous, { kind, zone });

      await atomicWrite(path, text);
      const pointer = { id, kind, zone, version, digest: digest(text), at: this.clock.iso(), path,
        ...(spec.restoredFrom === undefined ? {} : { 回滚自: spec.restoredFrom }) };
      // R16（审查 2026-10-16 · 部分提交明确化）：正文落盘、版本指针/审计是后续两笔——
      // 修前后续失败只把原错误裸抛，调用方会误判「没写成」而盲重试（重试 = 又一个版本）。
      // 最低限度实现（判据允许）：失败必须明示「正文已提交到 vX」并禁止盲重试语义；
      // 完整的 operation id/outbox 恢复面在后续批次。
      // 第13代复核反例4（2026-10-16）：detail 增 失败阶段 与 指针已写——两断面（指针未写/
      // 审计失败）在 Fault 里可判，调用方不用人工核盘猜状态。
      let 阶段 = '指针';
      try {
        await this.#recordPointer(id, pointer);
        阶段 = '审计';
        await this.audit.append({
          动作: '状态变更',
          主体: spec.subject,
          对象: { id, kind },
          依据: spec.reason,
          结果: previous === null ? `创建 v${version}` : `v${previous} → v${version}`,
          项目: meta.project ?? null,
          详情: { 版本指针: `${id}@v${version}`, 摘要: pointer.digest, 区: zone },
        });
      } catch (error) {
        throw new Fault(
          'STORE_PARTIAL_COMMIT',
          `${kind} ${id} 的正文已落盘（v${version}，摘要 ${pointer.digest.slice(0, 8)}…），但提交链未完成：${error instanceof Error ? error.message : String(error)}。不要盲目重试——对象已在盘上，重试会写出新版本而不是修复本次；请核对盘上版本与指针后继续。`,
          { detail: { id, kind, version, 已落盘正文: true, 指针已写: 阶段 === '审计', 失败阶段: 阶段, 摘要: pointer.digest, 失败原因: error instanceof Error ? error.message : String(error) } },
        );
      }

      return {
        id,
        version,
        zone: /** @type {'私有'} */ (zone),
        path,
        authority: meta.authority,
        previous,
        digest: pointer.digest,
      };
    });
  }

  /**
   * 列出一类对象的全部 id（两区合并，私有优先）。
   * @param {string} kind
   * @param {{ zone?: '出厂'|'私有' }} [options]
   * @returns {Promise<string[]>}
   */
  async list(kind, options = {}) {
    const zones = options.zone ? [options.zone] : ['私有', '出厂'];
    const ids = new Set();
    if (kind === '规则') {
      for (const spec of RULE_FILES) ids.add(spec.id);
      return [...ids].sort();
    }
    for (const zone of zones) {
      const dir = this.#dirOf(kind, zone);
      if (!dir) continue;
      for (const name of await listFiles(dir, { recursive: kind === '产物', filter: (n) => n.endsWith('.md') })) {
        ids.add(name.replace(/\.md$/, '').split('/').pop());
      }
    }
    return [...ids].sort();
  }

  /**
   * 版本历史。审计只记指针，正文在这里。
   * @param {string} id
   * @param {{kind?: string, zone?: '私有'|'出厂'}} [options] 省略时只接受唯一归属。
   * @returns {Promise<Array<{ version: number, at: string, digest: string, path: string }>>}
   */
  async history(id, options = {}) {
    const identity = await this.#historyIdentity(id, options);
    if (!identity) return [];
    const names = new Set();
    for (const dir of [this.layout.historyDir(id, identity), this.layout.historyDir(id)]) {
      for (const name of await listFiles(dir, { recursive: false, filter: n => /^v[1-9]\d*\.md$/.test(n) })) names.add(name);
    }
    let evidence;
    const out = [];
    for (const name of names) {
      const version = parseVersionName(name);
      const found = await readObjectHistory({ layout: this.layout, audit: this.audit, id, version, ...identity,
        evidence: () => evidence ??= this.audit.readVerified() });
      if (!found) continue;
      const parsed = parseDocument(found.content.toString());
      out.push({ version, at: String(parsed.meta.保存于 ?? ''), digest: digest(found.content), path: found.path });
    }
    return out.sort((a, b) => a.version - b.version);
  }

  /** 可省身份仅为旧API兼容；同id多类型/多来源必须显式指定，不能任选一个。 */
  async readVersion(id, version, options = {}) {
    const identity = await this.#historyIdentity(id, options);
    if (!identity) return null;
    const found = await readObjectHistory({ layout: this.layout, audit: this.audit, id, version, ...identity });
    return found?.content.toString() ?? null;
  }

  async #historyIdentity(id, options) {
    if (options.kind !== undefined) return historyIdentity(options.kind, options.zone ?? '私有');
    if (options.zone !== undefined) throw new InvalidBody('历史来源必须与对象类一起指定。');
    const candidates = new Map();
    const add = identity => candidates.set(historyKey(id, identity), identity);
    for (const kind of DOCUMENT_KINDS) {
      for (const zone of ['私有', '出厂']) {
        if (kind === '产物' && zone === '出厂') continue;
        const identity = { kind, zone };
        const path = kind === '规则' ? this.layout.rulePath(id, zone) : this.#pathFor(kind, { id }, zone);
        const current = path ? await readTextOrNull(path) : null;
        const history = await listFiles(this.layout.historyDir(id, identity), { recursive: false, filter: n => /^v[1-9]\d*\.md$/.test(n) });
        if (current !== null || history.length) add(identity);
      }
    }
    let evidence;
    for (const name of await listFiles(this.layout.historyDir(id), { recursive: false, filter: n => /^v[1-9]\d*\.md$/.test(n) })) {
      const version = parseVersionName(name);
      const content = await readTextOrNull(this.layout.historyFile(id, `v${version}`));
      if (content !== null) add(await legacyHistoryIdentity(id, version, content, () => evidence ??= this.audit.readVerified()));
    }
    if (candidates.size > 1) throw new Fault('STORE_HISTORY_AMBIGUOUS', `对象id ${id} 有多种类型或来源；请显式指定kind和zone。`);
    return [...candidates.values()][0] ?? null;
  }

  /**
   * 回滚文本版本。⚠️ 回滚的是文本，不是世界（§4）；只有主权者能回滚文本版本。
   * 实现上它是一次「以历史正文为输入的新写入」——于是自动再留一版，
   * 谁也不能靠回滚抹掉「曾经回滚过」这个事实。
   *
   * @param {string} kind
   * @param {string} id
   * @param {number} version
   * @param {{ subject: object, reason: string }} spec
   * @returns {Promise<{ id: string, version: number, restoredFrom: number }>}
   */
  async rollback(kind, id, version, spec) {
    const zone = spec.zone ?? '私有';
    const text = await this.readVersion(id, version, { kind, zone });
    if (text === null) throw new InvalidBody(`版本历史里没有 ${id}@v${version}`);
    const parsed = parseDocument(text);
    // authority 取**被回滚版本自己写的**（W3 批2·2026-10-09）：此前硬编码 '法律'，
    // 那既不是这个对象的实际档位，也不是任何一版正文的属性——它让判定拿到一个
    // 谁都没声明过的值（回滚一个自治能力卡，却按法律档过闸）。
    // 取值口径与 `store.write`/`read` 一致：段标记推出的档位（parsed.authority），
    // 没有段标记时用 front matter 声明的 authority 兜底。
    const authority = parsed.meta.authority ?? parsed.authority ?? '自治';
    await this.policy.check({
      subject: spec.subject,
      action: 'rollback',
      target: { id, kind, authority, zone, textVersion: true },
      context: { reason: spec.reason, version },
    });
    const result = await this.write(kind, { meta: parsed.meta, body: parsed.body }, { ...spec, zone, restoredFrom: version, reason: `${spec.reason}（回滚自 v${version}）` });
    return { id, version: result.version, restoredFrom: version };
  }

  /**
   * 当前版本指针（审计用；正文不在这里）。
   * @param {string} [id]
   * @param {{kind?: string, zone?: '私有'|'出厂'}} [options]
   * @returns {Promise<Record<string, object>>}
   */
  async pointers(id, options = {}) {
    const index = (await readJsonOrNull(this.layout.historyIndex())) ?? {};
    if (!id) {
      // 对外保留id索引形状；内部旧/新键同一身份时取新指针，跨身份绝不静默择一。
      const visible = new Map();
      for (const [key, pointer] of Object.entries(index)) {
        const owner = historyIdentity(pointer?.kind, pointer?.zone);
        const qualified = historyKey(pointer.id, owner);
        if ((key !== pointer.id && key !== qualified)
            || pointer.path !== this.#pathFor(owner.kind, { id: pointer.id }, owner.zone)) {
          throw new Fault('STORE_HISTORY_INVALID', '版本指针与对象身份不符。');
        }
        const prior = visible.get(pointer.id);
        if (prior && historyKey(pointer.id, prior.pointer) !== qualified) throw new Fault('STORE_HISTORY_AMBIGUOUS', '版本指针含同id多身份；请按kind和zone分别查询。');
        if (!prior || key === qualified) visible.set(pointer.id, { pointer });
      }
      return Object.fromEntries([...visible].map(([key, value]) => [key, value.pointer]));
    }
    const identity = await this.#historyIdentity(id, options);
    if (!identity) return { [id]: undefined };
    const current = index[historyKey(id, identity)];
    const legacy = index[id];
    const matches = pointer => pointer?.id === id && pointer.kind === identity.kind && pointer.zone === identity.zone
      && pointer.path === this.#pathFor(identity.kind, { id }, identity.zone);
    if (current && !matches(current)) throw new Fault('STORE_HISTORY_INVALID', '版本指针与对象身份不符。');
    return { [id]: current ?? (matches(legacy) ? legacy : undefined) };
  }

  /** @param {string} kind @param {'出厂'|'私有'} zone */
  #dirOf(kind, zone) {
    switch (kind) {
      case '能力':
        return this.layout.capabilityDir(zone === '出厂' ? '出厂' : '自治');
      case '身份':
        return this.layout.roleCardDir(zone === '出厂' ? '出厂' : '自治');
      case '产物':
        return zone === '出厂' ? null : this.layout.artifactDir();
      default:
        return null;
    }
  }

  /**
   * 文档落点。规则件的目录由 id 决定（宪章进 L0、法律件进 L1），
   * 所以必须回查 RULE_FILES，不能靠调用方传对 authority。
   * @param {string} kind @param {{id: string}} meta @param {'出厂'|'私有'} zone @param {string} [authority]
   */
  #pathFor(kind, meta, zone, authority) {
    if (kind === '规则') {
      const p = this.layout.rulePath(meta.id, zone);
      // rulePath 对未知 id 回 null：不修的话锁会建到 "null.lock"、正文写到 null.md，
      // 两份互相不认识（2026-10-12 评审 P3）——未知规则件响亮拒。
      if (!p) throw new InvalidBody(`未知规则件 id：${meta.id}（规则件的落点由 RULE_FILES 决定，名单里的才有效）。`, { detail: { kind, id: meta.id, zone } });
      return p;
    }
    return this.layout.documentPath(kind, { id: meta.id, authority: authority ?? '自治' }, zone);
  }

  /**
   * @param {string} kind @param {string} id @param {'出厂'|'私有'} zone @param {string} path @param {string} text
   * @param {object} [已解析] R18：段级合并的解析结果（省略则按单份文本解析）
   * @param {{合并来源?: string}} [补充]
   */
  #decorate(kind, id, zone, path, text, 已解析, 补充 = {}) {
    const parsed = 已解析 ?? parseDocument(text);
    // 文件名与 meta.id 不一致 ⇒ 响亮拒（W3 批2·2026-10-09）：此前是 `parsed.meta.id ?? id`，
    // 于是「按 a 去读，拿到 b 的正文」这件事被静默咽下——调用方以为读到的是 a。
    // 对象 id 是引用的凭据（§14.4-1「引用一律用 id」），两处各说各话时读取必须失败，
    // 而不是悄悄换一个身份。meta 里没写 id 仍按文件名兜底（旧件兼容）。
    const 元数据id = parsed.meta.id === undefined || parsed.meta.id === null ? null : String(parsed.meta.id);
    if (元数据id !== null && 元数据id !== String(id)) {
      throw new InvalidBody(`${path} 的文件名（${id}）与元数据 id（${元数据id}）不一致：对象 id 是引用凭据，两处各说各话时读取必须响亮拒绝，不许静默换 id。`, {
        detail: { 文件名id: String(id), 元数据id, path },
      });
    }
    return {
      id: 元数据id ?? String(id),
      kind,
      zone,
      path,
      raw: text,
      meta: parsed.meta,
      body: parsed.body,
      authority: parsed.authority,
      segments: parsed.segments,
      clauses: parsed.clauses,
      digest: digest(text),
      // R18：两侧都有时如实标注生效文档是段级合并的产物（不谎称整份来自某一区）。
      ...(补充.合并来源 ? { 合并来源: 补充.合并来源 } : {}),
    };
  }

  /** 改动前留前一版：这是「任何带 version 的对象，改动前自动留前一版」的全部实现。 */
  async #keepVersion(id, existing, version, identity) {
    const path = this.layout.historyFile(id, `v${version}`, identity);
    const stamped = existing.raw ?? `${formatFrontMatter({ ...existing.meta, 保存于: this.clock.iso() })}${existing.body}`;
    const previous = await readTextOrNull(path);
    if (previous !== null && previous !== stamped) throw new Fault('STORE_HISTORY_CONFLICT',
      `历史 ${identity.kind}/${identity.zone}/${id}@v${version} 已有不同正文；保留原件，不覆盖历史。`);
    if (previous === null) await atomicWrite(path, stamped);
  }

  /** 同一索引锁内更新身份键；保留旧键供兼容读取，不自动迁移或覆盖旧证据。 */
  async #recordPointer(id, pointer) {
    await mutateLocked({
      file: this.layout.historyIndex(),
      lockPath: `${this.layout.historyIndex()}.lock`,
      read: () => readJsonOrNull(this.layout.historyIndex()),
      apply: (current) => ({ next: { ...(current ?? {}), [historyKey(id, pointer)]: pointer }, result: pointer }),
    });
  }
}
