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
import { InvalidBody } from './kernel/errors.js';
import { parseVersionName } from './kernel/ids.js';
import { digest } from './kernel/text.js';
import { assertStructure, formatFrontMatter, parseDocument } from './tags.js';
import { RULE_FILES } from './paths.js';

/** 走对象存储的 kind。其余 kind 由各自的服务负责。 */
export const DOCUMENT_KINDS = ['规则', '身份', '能力', '产物'];

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
    for (const zone of zones) {
      const path = this.#pathFor(kind, { id }, zone, spec.authority);
      if (!path) continue;
      const text = await readTextOrNull(path);
      if (text === null) continue;
      return this.#decorate(kind, id, zone, path, text);
    }
    return null;
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

    // 对象级锁（W3 批1·2026-10-09）：read-existing → keepVersion → atomicWrite →
    // recordPointer 全程包进按对象锁（照 bus 线程锁 `${file}.lock` 先例）。不锁的话
    // 两个并发 write 同 id 会算出同一个 version、互相覆盖正文、留下撕开的版本史。
    // 锁路径与目标文件同目录同主名——path 只由 id/authority/zone 决定（不含 version），
    // 所以在算 version 之前就能定。
    const lockPath = `${this.#pathFor(kind, { id }, zone, meta.authority ?? '自治')}.lock`;
    return withLock(lockPath, async () => {
      const existing = await this.read(kind, id, { subject: spec.subject });
      // version 从 front matter 里读回来是**字符串**；不转数字就会得到 v1 → v11 这种版本号。
      const previous = existing ? Number(existing.meta.version ?? 1) : null;
      const authority = existing?.authority ?? meta.authority ?? '自治';
      meta.authority = meta.authority ?? authority;

      await this.policy.check({
        subject: spec.subject,
        action: existing ? 'write' : 'create',
        target: {
          id,
          kind,
          authority: meta.authority,
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
      const text = `${formatFrontMatter(meta)}${document.body.startsWith('\n') ? document.body.slice(1) : document.body}`;
      const parsed = parseDocument(text, { defaultAuthority: meta.authority });
      assertStructure(kind, parsed);

      const path = this.#pathFor(kind, meta, zone, meta.authority);
      if (!path) throw new InvalidBody(`对象存储没有 ${kind} 的落点`);
      if (existing) await this.#keepVersion(id, existing, previous);

      await atomicWrite(path, text);
      const pointer = { id, kind, zone, version, digest: digest(text), at: this.clock.iso(), path };
      await this.#recordPointer(id, pointer);
      await this.audit.append({
        动作: '状态变更',
        主体: spec.subject,
        对象: { id, kind },
        依据: spec.reason,
        结果: previous === null ? `创建 v${version}` : `v${previous} → v${version}`,
        项目: meta.project ?? null,
        详情: { 版本指针: `${id}@v${version}`, 摘要: pointer.digest, 区: zone },
      });

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
   * @returns {Promise<Array<{ version: number, at: string, digest: string, path: string }>>}
   */
  async history(id) {
    const dir = this.layout.historyDir(id);
    const files = await listFiles(dir, { recursive: false, filter: (n) => n.endsWith('.md') });
    /** @type {Array<{version:number, at:string, digest:string, path:string}>} */
    const out = [];
    for (const name of files) {
      const version = parseVersionName(name);
      if (version === null) continue;
      const path = this.layout.historyFile(id, `v${version}`);
      const text = await readTextOrNull(path);
      if (text === null) continue;
      const parsed = parseDocument(text);
      out.push({ version, at: String(parsed.meta.保存于 ?? ''), digest: digest(text), path });
    }
    return out.sort((a, b) => a.version - b.version);
  }

  /**
   * 读某一版历史正文。
   * @param {string} id
   * @param {number} version
   * @returns {Promise<string|null>}
   */
  async readVersion(id, version) {
    return readTextOrNull(this.layout.historyFile(id, `v${version}`));
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
    const text = await this.readVersion(id, version);
    if (text === null) throw new InvalidBody(`版本历史里没有 ${id}@v${version}`);
    await this.policy.check({
      subject: spec.subject,
      action: 'rollback',
      target: { id, kind, authority: '法律', zone: '私有', textVersion: true },
      context: { reason: spec.reason, version },
    });
    const parsed = parseDocument(text);
    const result = await this.write(kind, { meta: parsed.meta, body: parsed.body }, { ...spec, reason: `${spec.reason}（回滚自 v${version}）` });
    await this.#recordPointer(id, {
      id,
      kind,
      zone: '私有',
      version: result.version,
      digest: result.digest,
      at: this.clock.iso(),
      path: result.path,
      回滚自: version,
    });
    return { id, version: result.version, restoredFrom: version };
  }

  /**
   * 当前版本指针（审计用；正文不在这里）。
   * @param {string} [id]
   * @returns {Promise<Record<string, object>>}
   */
  async pointers(id) {
    const index = (await readJsonOrNull(this.layout.historyIndex())) ?? {};
    return id ? { [id]: index[id] } : index;
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
    if (kind === '规则') return this.layout.rulePath(meta.id, zone);
    return this.layout.documentPath(kind, { id: meta.id, authority: authority ?? '自治' }, zone);
  }

  /** @param {string} kind @param {string} id @param {'出厂'|'私有'} zone @param {string} path @param {string} text */
  #decorate(kind, id, zone, path, text) {
    const parsed = parseDocument(text);
    return {
      id: parsed.meta.id ?? id,
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
    };
  }

  /** 改动前留前一版：这是「任何带 version 的对象，改动前自动留前一版」的全部实现。 */
  async #keepVersion(id, existing, version) {
    const path = this.layout.historyFile(id, `v${version}`);
    const stamped = existing.raw ?? `${formatFrontMatter({ ...existing.meta, 保存于: this.clock.iso() })}${existing.body}`;
    await atomicWrite(path, stamped);
  }

  /** 版本指针索引：只记指针与摘要，正文永远在文件里。 */
  async #recordPointer(id, pointer) {
    await mutateLocked({
      file: this.layout.historyIndex(),
      lockPath: `${this.layout.historyIndex()}.lock`,
      read: () => readJsonOrNull(this.layout.historyIndex()),
      apply: (current) => ({ next: { ...(current ?? {}), [id]: pointer }, result: pointer }),
    });
  }
}
