/**
 * 记忆服务（§7「知道什么」）。
 *
 * 三条设计原则决定了这里的每个形状：
 *  1. **写入必带「谁记的 + 怎么知道的」** —— 所以 `来源` 是必填结构，缺了在**写入时**就拒。
 *  2. **不许改写，只能追加** —— 失效 / 冷 / 被推翻全部是**追加一条状态记录**，
 *     原条目那行字节不动。唯一的例外是物理删除，且只对敏感数据或主权者明确要求开放。
 *  3. **能力不在记忆服务里** —— 它在与记忆服务并列的能力库中。这里没有 `能力` 这一类。
 *
 * 四类的归属（§7 表）：知识 = 岗位 + 项目双标签（跨项目/本项目）；经历 = 组织账本（只增）；
 * 偏好 = 部署（永不外流）；作答 = 实例（私有区内部，任务结束归档）。
 */
import { appendLines, exists, listDirs, readJsonl, readTextOrNull, atomicWrite, withLock } from './kernel/fsx.js';
import { InvalidBody, Denied } from './kernel/errors.js';
import { objectId } from './kernel/ids.js';
import { buildIndex, formatMiss, search } from './retrieval.js';
import { DIR, MEMORY_KINDS } from './paths.js';

/** 归档后可读的角色（§7 表）。 */
const ANSWER_READERS = ['主权者', 'Lead', '复核者'];

/** 记录档位：条目行 vs 状态行。用「有没有 `指向`」区分，避免再加一个字段。 */
const isStateRow = (row) => typeof row?.指向 === 'string' && typeof row?.追加 === 'string';

export class MemoryService {
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
   * 记一条。写入时校验正文结构与来源；不合规拒写，不做事后修补。
   *
   * @param {{ subject: object, 类: string, 内容: string, 来源: string|{谁?: string, 怎么知道: string}, 项目?: string, 岗位?: string, 标签?: string[], 轮?: string, 任务?: object }} input
   * @returns {Promise<{ id: string, 类: string, 归属: string, 账本: string, 项目: string|null, 岗位: string|null }>}
   */
  async remember(input) {
    const kind = input.类;
    if (!MEMORY_KINDS.includes(kind)) {
      throw new InvalidBody(`记忆只有四类：${MEMORY_KINDS.join(' / ')}；收到「${kind}」。能力不在记忆服务里。`, {
        detail: { 收到: kind, 允许: MEMORY_KINDS },
      });
    }
    const 来源 = normalizeSource(input.来源, input.subject);
    if (!来源.谁 || !来源.怎么知道) {
      throw new InvalidBody('记忆写入必须带「谁记的 + 怎么知道的」。', {
        missing: [!来源.谁 ? '来源.谁' : null, !来源.怎么知道 ? '来源.怎么知道' : null].filter(Boolean),
      });
    }
    const text = String(input.内容 ?? '').trim();
    if (!text) throw new InvalidBody('记忆内容为空：空条目会污染检索面。');

    const 项目 = input.项目 ?? null;
    if (kind === '知识' && !项目) {
      throw new InvalidBody('知识必须恒打项目标签：它产生于某个项目。');
    }
    if (kind === '作答' && !项目) {
      throw new InvalidBody('作答必须有项目归属：它是某个项目里的一次作答。');
    }

    const scope = kind === '经历' || kind === '偏好' ? DIR.跨项目 : 项目;
    const target = memoryTarget(kind, scope, 项目);
    await this.policy.check({
      subject: input.subject,
      action: 'create',
      target,
      context: { task: input.任务 ?? null, 类: kind },
    });

    const id = objectId(kind, `${text.slice(0, 40)}/${input.subject?.id ?? ''}`, { at: this.clock.ms() });
    const row = {
      id,
      类: kind,
      内容: text,
      来源,
      归属: scope,
      项目,
      // 知识：项目标签恒打；岗位标签默认不打（由 Lead 判定「这条跨项目可复用」后追加）。
      岗位: kind === '知识' ? null : (input.岗位 ?? null),
      标签: input.标签 ?? [],
      状态: '有效',
      记于: this.clock.iso(),
      轮: input.轮 ?? null,
    };
    await appendLines(this.layout.memoryLog(scope, kind), [row]);
    await this.audit.append({
      动作: '状态变更',
      主体: input.subject,
      对象: { id, kind: '知识' === kind ? '知识' : kind },
      依据: '记忆服务：写入必带谁记的 + 怎么知道的',
      结果: `记入${scope}`,
      项目,
      详情: { 类: kind, 来源: 来源.怎么知道 },
    });
    return { id, 类: kind, 归属: scope, 账本: this.layout.memoryLog(scope, kind), 项目, 岗位: row.岗位 };
  }

  /**
   * 由 Lead 判定「这条跨项目可复用」后追加岗位标签（默认不打，不是漏打）。
   * 追加本身也是一条状态记录，因此可追溯是谁判断的。
   *
   * @param {string} id
   * @param {{ subject: object, 岗位: string, 理由: string }} spec
   * @returns {Promise<{ id: string, 岗位: string }>}
   */
  async promoteCrossProject(id, spec) {
    const entry = await this.#folded(id);
    if (!entry) throw new InvalidBody(`没有这条记忆：${id}`);
    if (entry.类 !== '知识') throw new InvalidBody('只有知识可以打岗位标签；经历/偏好/作答不跨项目。');
    await this.policy.check({
      subject: spec.subject,
      action: 'write',
      target: memoryTarget('知识', DIR.跨项目, entry.项目),
      context: { id },
    });
    // 双份留痕：本项目那份保留原样，跨项目那份追一条同 id 的条目，
    // 这样「它产生于本项目」与「它对本岗位可复用」两个事实都在。
    await appendLines(this.layout.memoryLog(DIR.跨项目, '知识'), [
      {
        ...entry,
        归属: DIR.跨项目,
        岗位: spec.岗位,
        追加: undefined,
        记于: entry.记于,
        跨项目判定: { 由: spec.subject?.id ?? 'unknown', 理由: spec.理由, 于: this.clock.iso() },
      },
    ]);
    await this.audit.append({
      动作: '状态变更',
      主体: spec.subject,
      对象: { id, kind: '知识' },
      依据: '知识标签写入规则：岗位标签默认不打，Lead 判定可复用后追加',
      结果: `追加岗位标签 ${spec.岗位}`,
      项目: entry.项目,
      详情: { 理由: spec.理由 },
    });
    return { id, 岗位: spec.岗位 };
  }

  /**
   * 检索。默认把归档后的作答排除在检索面之外；`显式: true` 才把它拉回来（§7）。
   *
   * @param {{ 类?: string[], 项目?: string, 岗位?: string, 文本?: string, 显式?: boolean, 读者?: object, limit?: number }} [query]
   * @returns {Promise<{ 命中: object[], 口径: object, 条目: object[], 说明?: string }>}
   */
  async query(query = {}) {
    const wanted = query.类 ?? MEMORY_KINDS;
    const rows = [];
    for (const kind of wanted) {
      if (!MEMORY_KINDS.includes(kind)) continue;
      for (const scope of await this.#scopesFor(kind, query.项目)) {
        rows.push(...(await readJsonl(this.layout.memoryLog(scope, kind))));
      }
    }
    const entries = fold(rows).filter((entry) => entry.状态 !== '物理删除');
    const visible = [];
    for (const entry of entries) {
      if (entry.类 === '作答' && entry.归档 === true && query.显式 !== true) continue;
      if (entry.类 === '作答' && entry.归档 === true && query.读者) {
        if (!ANSWER_READERS.includes(query.读者.kind)) continue;
      }
      if (query.项目 && entry.类 === '知识' && entry.项目 && entry.项目 !== query.项目 && entry.归属 !== DIR.跨项目) continue;
      if (query.岗位 && entry.岗位 && entry.岗位 !== query.岗位) continue;
      visible.push(entry);
    }

    if (!query.文本) {
      return {
        命中: [],
        条目: visible,
        口径: { 搜索面: '记忆服务', 查询词: '', 范围: wanted.join('/'), 文档数: visible.length, 命中数: 0 },
        ...(query.显式 === true ? { 说明: '已显式包含归档作答。' } : {}),
      };
    }
    const index = buildIndex(visible.map((entry) => ({ id: entry.id, 正文: entry.内容, 标签: [entry.类, entry.岗位 ?? ''], 来源: entry.归属 })));
    const result = search(index, query.文本, { limit: query.limit ?? 10, 范围: `${wanted.join('/')}@${query.项目 ?? '全部项目'}` });
    if (result.命中.length === 0) result.说明 = formatMiss(result.口径);
    result.条目 = visible;
    return result;
  }

  /**
   * 失效：追加 `invalid` 状态，不改原条目（§7「错误 / 过期」）。
   * @param {string} id
   * @param {{ subject: object, 原因: string }} spec
   */
  async invalidate(id, spec) {
    return this.#appendState(id, 'invalid', spec);
  }

  /**
   * 冷：追加降权状态，不删（§7「冷」）。
   * @param {string} id
   * @param {{ subject: object, 原因: string }} spec
   */
  async demote(id, spec) {
    return this.#appendState(id, '降权', spec);
  }

  /**
   * 被推翻：追加状态并追加新条目，双份留痕（§7「被推翻」）。
   * @param {string} id
   * @param {{ subject: object, 新条目: string, 理由: string }} spec
   */
  async overturn(id, spec) {
    const entry = await this.#folded(id);
    if (!entry) throw new InvalidBody(`没有这条记忆：${id}`);
    const created = await this.remember({
      subject: spec.subject,
      类: entry.类,
      内容: spec.新条目,
      来源: { 谁: spec.subject?.id, 怎么知道: `推翻 ${id}：${spec.理由}` },
      项目: entry.项目,
      岗位: entry.岗位 ?? undefined,
    });
    await this.#appendState(id, '推翻', spec, { 新条目: created.id });
    return { id, 状态: '被推翻', 新条目: created.id };
  }

  /**
   * 物理删除：仅限敏感数据、或主权者明确要求。
   *
   * 这是全库唯一允许**真的**从账本里抹掉内容的动作，所以它必须：
   * ① 只在两种理由下开放；② 抹掉内容后仍然在审计里留一条不可逆操作记录
   * （记录 id 与理由，不记录内容本身——否则等于没删）；③ **扫遍出现过该 id 的每一本账**
   * （晋升过的知识同时住在项目账与跨项目账上，只删一本等于没删）。
   *
   * @param {string} id
   * @param {{ subject: object, 理由: string }} spec
   * @returns {Promise<{ id: string, 已删除: true, 依据: string }>}
   */
  async purge(id, spec) {
    const 敏感 = spec.理由.includes('敏感');
    const 主权者要求 = spec.subject?.kind === '主权者';
    if (!敏感 && !主权者要求) {
      throw new Denied('法律 记忆处置表（物理删除只限敏感数据 / 主权者明确要求）', '物理删除会破坏「不许改写只能追加」这条唯一原则，只有敏感数据或主权者明确要求才允许。', {
        requireAuthority: '主权者',
        howToChange: '改用 invalidate() 追加失效状态；那才是错误/过期条目的常规处置。',
      });
    }
    const entry = await this.#folded(id);
    if (!entry) throw new InvalidBody(`没有这条记忆：${id}`);

    // 同一个 id 可以同时躺在两本账上：知识晋升会把它复制进「跨项目」，
    // 而原条目仍留在产生它的那个项目账里（§7「双份留痕」）。
    // 所以物理删除必须扫**所有**出现过它的账本——只删 `归属` 那一本，
    // 另一本会留下全文副本，而审计却写着「内容已抹掉」：那是一句假话。
    // 漏删的那本正是「原文禁读、副本仍可读」的空窗（评审稿 §C8 明令禁止）。
    const 覆盖 = [];
    for (const scope of [DIR.跨项目, ...(await this.#projectScopes())]) {
      const file = this.layout.memoryLog(scope, entry.类);
      if (await exists(file)) 覆盖.push({ scope, file });
    }
    for (const { file } of 覆盖) {
      await withLock(`${file}.lock`, async () => {
        const text = (await readTextOrNull(file)) ?? '';
        const kept = text
          .split('\n')
          .filter((line) => line.trim())
          .filter((line) => {
            try {
              return JSON.parse(line).id !== id;
            } catch {
              return true;
            }
          });
        await atomicWrite(file, kept.length ? `${kept.join('\n')}\n` : '');
      });
    }
    await this.audit.append({
      动作: '不可逆操作',
      主体: spec.subject,
      对象: { id, kind: entry.类 },
      依据: 敏感 ? '记忆处置表：敏感数据' : '记忆处置表：主权者明确要求',
      结果: `物理删除（内容已抹掉；覆盖 ${覆盖.length} 本账：${覆盖.map((x) => x.scope).join(' / ')}）`,
      项目: entry.项目,
      详情: { 理由: spec.理由, 类: entry.类, 清理覆盖: 覆盖.map((x) => x.file) },
    });
    return { id, 已删除: true, 依据: spec.理由, 清理覆盖: 覆盖.map((x) => x.scope) };
  }

  /**
   * 作答归档：任务结束时调用；归档后成员的读权限关闭，自动检索也不再默认返回。
   * @param {{ 项目: string, 任务?: string, subject: object }} spec
   * @returns {Promise<{ 归档条数: number, 账本: string }>}
   */
  async archiveAnswers(spec) {
    const file = this.layout.memoryLog(spec.项目, '作答');
    const rows = await readJsonl(file);
    const open = rows.filter((row) => !isStateRow(row));
    if (open.length === 0) return { 归档条数: 0, 账本: file };
    await appendLines(file, open.map((row) => ({ id: objectId('账目', row.id, { at: this.clock.ms() }), 指向: row.id, 追加: '归档', 追于: this.clock.iso(), 依据: spec.任务 ?? '任务结束', 主体: spec.subject })));
    await this.audit.append({
      动作: '状态变更',
      主体: spec.subject,
      对象: { id: spec.任务 ?? spec.项目, kind: '任务' },
      依据: '作答归档后的可读性表（§7）',
      结果: `归档 ${open.length} 条作答：成员不可读，默认检索面不再返回`,
      项目: spec.项目,
    });
    return { 归档条数: open.length, 账本: file };
  }

  /**
   * 归档后的可读性矩阵（§7 表）。
   * @param {string} id
   * @param {{ 读者: object }} spec
   * @returns {Promise<{ 可读: boolean, 原因: string }>}
   */
  async readableBy(id, spec) {
    const entry = await this.#folded(id);
    if (!entry) return { 可读: false, 原因: '没有这条记忆' };
    if (entry.类 !== '作答' || entry.归档 !== true) return { 可读: true, 原因: '未归档条目对所有在编主体可读' };
    if (ANSWER_READERS.includes(spec.读者?.kind)) return { 可读: true, 原因: `${spec.读者.kind} 在归档后仍可读（会审分歧清单必须对复核者可见）` };
    return { 可读: false, 原因: `${spec.读者?.kind ?? '未知主体'} 不可读归档作答；自动检索也不进默认面` };
  }

  /**
   * 记忆规模：供工作台与探针使用。
   * @param {{ 项目?: string }} [query]
   */
  async stats(query = {}) {
    /** @type {Record<string, number>} */
    const 计数 = {};
    for (const kind of MEMORY_KINDS) {
      let n = 0;
      for (const scope of await this.#scopesFor(kind, query.项目)) {
        n += fold(await readJsonl(this.layout.memoryLog(scope, kind))).filter((e) => e.状态 !== '物理删除').length;
      }
      计数[kind] = n;
    }
    return { 计数, 合计: Object.values(计数).reduce((a, b) => a + b, 0) };
  }

  // ── 内部 ────────────────────────────────────────────────────────────────────

  /** @param {string} kind @param {string|undefined} 项目 */
  async #scopesFor(kind, 项目) {
    const scopes = [DIR.跨项目];
    if (kind === '知识' || kind === '作答') {
      const all = await this.#projectScopes();
      for (const scope of all) {
        if (!项目 || scope === 项目) scopes.push(scope);
      }
    }
    return [...new Set(scopes)];
  }

  /** 记忆服务目录下出现过的项目键（目录名即项目键，§14.4-5）。 */
  async #projectScopes() {
    const names = await listDirs(this.layout.memoryDir(DIR.跨项目), { up: true });
    return names.filter((n) => n !== DIR.跨项目);
  }

  /** @param {string} id */
  async #folded(id) {
    for (const kind of MEMORY_KINDS) {
      for (const scope of [DIR.跨项目, ...(await this.#projectScopes())]) {
        const rows = await readJsonl(this.layout.memoryLog(scope, kind));
        const hit = fold(rows).find((entry) => entry.id === id);
        if (hit) return hit;
      }
    }
    return null;
  }

  /**
   * @param {string} id
   * @param {string} 状态
   * @param {{ subject: object, 原因: string }} spec
   * @param {object} [extra]
   */
  async #appendState(id, 状态, spec, extra = {}) {
    const entry = await this.#folded(id);
    if (!entry) throw new InvalidBody(`没有这条记忆：${id}`);
    await this.policy.check({
      subject: spec.subject,
      action: 'write',
      target: memoryTarget(entry.类, entry.归属, entry.项目),
      context: { id, 状态 },
    });
    await appendLines(this.layout.memoryLog(entry.归属, entry.类), [
      { id: objectId('账目', `${id}:${状态}`, { at: this.clock.ms() }), 指向: id, 追加: 状态, 追于: this.clock.iso(), 依据: spec.原因, 主体: spec.subject, ...extra },
    ]);
    await this.audit.append({
      动作: '状态变更',
      主体: spec.subject,
      对象: { id, kind: entry.类 },
      依据: '记忆处置表：不许改写，只能追加',
      结果: `追加状态 ${状态}`,
      项目: entry.项目,
      详情: { 原因: spec.原因 },
    });
    return { id, 状态, 指向: id };
  }
}

/**
 * 把 append-only 行折成当前视图。
 * @param {object[]} rows
 * @returns {Array<object & {状态: string, 归档?: boolean, 历史: object[]}>}
 */
export function fold(rows) {
  /** @type {Map<string, object>} */
  const entries = new Map();
  /** @type {object[]} */
  const states = [];
  for (const row of rows) {
    if (isStateRow(row)) states.push(row);
    else if (row.id) entries.set(row.id, { ...row, 状态: row.状态 ?? '有效', 历史: [] });
  }
  for (const state of states.sort((a, b) => String(a.追于).localeCompare(String(b.追于)))) {
    const entry = entries.get(state.指向);
    if (!entry) continue;
    entry.历史 = [...entry.历史, state];
    if (state.追加 === 'invalid') entry.状态 = '已失效';
    else if (state.追加 === '降权') entry.状态 = '已降权';
    else if (state.追加 === '推翻') entry.状态 = '被推翻';
    else if (state.追加 === '归档') entry.归档 = true;
    else if (state.追加 === '物理删除') entry.状态 = '物理删除';
  }
  return [...entries.values()];
}

/**
 * @param {string|object} source
 * @param {object} subject
 * @returns {{谁: string, 怎么知道: string}}
 */
function normalizeSource(source, subject) {
  if (source && typeof source === 'object') {
    return { 谁: String(source.谁 ?? subject?.id ?? ''), 怎么知道: String(source.怎么知道 ?? '') };
  }
  return { 谁: String(subject?.id ?? ''), 怎么知道: String(source ?? '') };
}

/**
 * @param {string} 类
 * @param {string} scope
 * @param {string|null} 项目
 */
function memoryTarget(类, scope, 项目) {
  return {
    id: `记忆/${scope}/${类}`,
    kind: 类,
    authority: '自治',
    zone: '私有',
    domain: '集体',
    project: 项目,
  };
}
