/**
 * 能力库（§7「怎么做」）。
 *
 * 这一件单独立项的唯一理由就是**单源**：同一项能力被多岗位共用，挂在角色卡里就得复制。
 * 于是本文件守两条：
 *  1. **双区各一份、同名不合并** —— 出厂能力库随产品更新，自治能力库组织自治且永不外流；
 *     同名是两条，检索时两条都返回并标注来源，默认用自治版，冲突并列给 Lead 判。
 *  2. **角色卡只存引用** —— `referencesFor()` 回答「这个岗位引用了哪几项能力」，
 *     而不是把正文抄进卡里。
 */
import { listFiles, readTextOrNull, atomicWrite, ensureDir } from './kernel/fsx.js';
import { InvalidBody } from './kernel/errors.js';
import { assertStructure, formatFrontMatter, parseDocument } from './tags.js';
import { assertPathSegment } from './paths.js';
import { slug } from './kernel/ids.js';

/** 两个来源的固定标签。 */
export const SOURCE_FACTORY = '出厂';
export const SOURCE_AUTONOMOUS = '自治';

export class CapabilityLibrary {
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
   * 列出能力。两区都列，各自标注来源。
   *
   * @param {{ subject?: object, 岗位?: string, 来源?: '出厂'|'自治' }} [query]
   * @returns {Promise<Array<{ id: string, 名: string, 来源: string, 适用岗位: string[], 摘要: string, path: string }>>}
   */
  async list(query = {}) {
    const zones = query.来源 ? [query.来源] : [SOURCE_AUTONOMOUS, SOURCE_FACTORY];
    const out = [];
    for (const 来源 of zones) {
      const dir = this.#dir(来源);
      for (const rel of await listFiles(dir, { recursive: false, filter: (n) => n.endsWith('.md') })) {
        const path = `${dir}/${rel}`;
        const text = await readTextOrNull(path);
        if (text === null) continue;
        const parsed = parseDocument(text);
        const 适用岗位 = parseRoles(section(parsed.body, '适用岗位'));
        if (query.岗位 && !适用岗位.includes(query.岗位)) continue;
        out.push({
          id: parsed.meta.id ?? rel.replace(/\.md$/, ''),
          名: parsed.meta.名 ?? rel.replace(/\.md$/, ''),
          来源,
          适用岗位,
          摘要: firstLine(section(parsed.body, '怎么做')),
          path,
        });
      }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id) || a.来源.localeCompare(b.来源));
  }

  /**
   * 按名解析。**同名不合并**：两条都返回，标注来源，默认指向自治版，
   * 冲突时把选择权留给 Lead（本方法不替它决定）。
   *
   * @param {{ subject?: object, 名: string }} spec
   * @returns {Promise<{ 名: string, 条目: object[], 默认: string|null, 冲突: boolean, 说明: string }>}
   */
  async resolve(spec) {
    const all = await this.list();
    const 条目 = all.filter((c) => c.id === spec.名 || c.名 === spec.名);
    if (条目.length === 0) {
      return { 名: spec.名, 条目: [], 默认: null, 冲突: false, 说明: `能力库里没有「${spec.名}」；同名不合并，缺失就是缺失。` };
    }
    const hasFactory = 条目.some((c) => c.来源 === SOURCE_FACTORY);
    const hasAuto = 条目.some((c) => c.来源 === SOURCE_AUTONOMOUS);
    const 冲突 = hasFactory && hasAuto;
    const 默认 = hasAuto ? SOURCE_AUTONOMOUS : SOURCE_FACTORY;
    return {
      名: spec.名,
      条目,
      默认,
      冲突,
      说明: 冲突
        ? '出厂与自治各有一份同名能力：默认用自治版；两条并列交给 Lead 判，不做静默合并。'
        : `只有${默认}版一份。`,
    };
  }

  /**
   * 读一项能力的正文。
   * @param {{ subject?: object, id: string, 来源?: '出厂'|'自治' }} spec
   * @returns {Promise<{ id: string, 来源: string, 正文: string, 适用岗位: string[], path: string }|null>}
   */
  async read(spec) {
    const zones = spec.来源 ? [spec.来源] : [SOURCE_AUTONOMOUS, SOURCE_FACTORY];
    for (const 来源 of zones) {
      const path = `${this.#dir(来源)}/${spec.id}.md`;
      const text = await readTextOrNull(path);
      if (text === null) continue;
      const parsed = parseDocument(text);
      return { id: parsed.meta.id ?? spec.id, 来源, 正文: parsed.body, 适用岗位: parseRoles(section(parsed.body, '适用岗位')), path };
    }
    return null;
  }

  /**
   * 发布到自治能力库。这是唯一的写入面——**永不外流**，所以它只写私有区。
   *
   * id 默认取名字的 kebab 折形而不是随机哈希：§14.4-1 要求「稳定、短、kebab」，
   * 而角色卡的 `个体L2` 段要**按 id 引用**它——随机 id 会让引用无从写起。
   *
   * @param {{ subject: object, 名: string, id?: string, 正文: string, 适用岗位: string[], 依据: string }} input
   * @returns {Promise<{ id: string, 来源: string, path: string }>}
   */
  async publish(input) {
    const 适用岗位 = (input.适用岗位 ?? []).map((s) => String(s).trim()).filter(Boolean);
    if (适用岗位.length === 0) {
      throw new InvalidBody('能力卡必须声明适用岗位：没有岗位就无从维持单源。', { missing: ['适用岗位'] });
    }
    const id = assertPathSegment(input.id ?? slug(input.名, { maxLength: 40 }), '能力id');
    const meta = {
      id,
      kind: '能力',
      名: input.名,
      authority: '自治',
      zone: '私有',
      domain: '集体',
      version: 1,
    };
    const body = `\n# ${input.名}\n\n## 适用岗位\n${适用岗位.map((r) => `- ${r}`).join('\n')}\n\n## 怎么做\n${input.正文}\n`;
    const text = `${formatFrontMatter(meta)}${body}`;
    assertStructure('能力', parseDocument(text, { defaultAuthority: '自治' }));

    await this.policy.check({
      subject: input.subject,
      action: 'create',
      target: { id, kind: '能力', authority: '自治', zone: '私有', domain: '集体', project: null },
      context: { 依据: input.依据 },
    });
    const dir = this.#dir(SOURCE_AUTONOMOUS);
    await ensureDir(`${dir}/${id}.md`);
    await atomicWrite(`${dir}/${id}.md`, text);
    await this.audit.append({
      动作: '状态变更',
      主体: input.subject,
      对象: { id, kind: '能力' },
      依据: input.依据,
      结果: '发布到自治能力库（永不外流）',
      详情: { 适用岗位 },
    });
    return { id, 来源: SOURCE_AUTONOMOUS, path: `${dir}/${id}.md` };
  }

  /**
   * 某个岗位引用了哪些能力（角色卡 `个体L2` 段只存引用）。
   * @param {{ 岗位: string }} query
   * @returns {Promise<{ 岗位: string, 引用: string[], 解析: Array<{id: string, 来源: string|null}> }>}
   */
  async referencesFor(query) {
    const 岗位 = assertPathSegment(query.岗位, '岗位');
    const cardPath = `${this.layout.roleCardDir('自治')}/${岗位}.md`;
    const text = (await readTextOrNull(cardPath)) ?? (await readTextOrNull(`${this.layout.roleCardDir('出厂')}/${岗位}.md`));
    if (text === null) throw new InvalidBody(`没有岗位卡：${query.岗位}`);
    const parsed = parseDocument(text);
    const 引用 = parseRefs(section(parsed.body, '个体L2'));
    const all = await this.list();
    return {
      岗位: query.岗位,
      引用,
      // 单源解析也遵守「默认用自治版」：同名时宁可显式取自治那条，
      // 也不要依赖列表的排序顺序（排序是展示用的，不是语义）。
      解析: 引用.map((id) => ({ id, 来源: resolveSource(all.filter((c) => c.id === id)) })),
    };
  }

  /**
   * 能力库规模（工作台与探针用）。
   * @returns {Promise<{ 出厂: number, 自治: number, 同名: string[] }>}
   */
  async stats() {
    const all = await this.list();
    const byName = new Map();
    for (const c of all) byName.set(c.id, new Set([...(byName.get(c.id) ?? []), c.来源]));
    return {
      出厂: all.filter((c) => c.来源 === SOURCE_FACTORY).length,
      自治: all.filter((c) => c.来源 === SOURCE_AUTONOMOUS).length,
      同名: [...byName.entries()].filter(([, zones]) => zones.size > 1).map(([id]) => id),
    };
  }

  /** @param {'出厂'|'自治'} 来源 */
  #dir(来源) {
    return this.layout.capabilityDir(来源);
  }
}

/**
 * 取出 markdown 中某个二级标题下的正文。
 * @param {string} body
 * @param {string} heading
 * @returns {string}
 */
export function section(body, heading) {
  const lines = String(body).split('\n');
  const out = [];
  let inside = false;
  for (const line of lines) {
    const m = /^#{1,6}\s+(.*)$/.exec(line);
    if (m) {
      if (inside) break;
      inside = m[1].trim().includes(heading);
      continue;
    }
    if (inside) out.push(line);
  }
  return out.join('\n').trim();
}

/** @param {string} text */
function parseRoles(text) {
  return String(text)
    .split(/[\n,，、;；]+/)
    .map((s) => s.replace(/^[-*•\d.\s]+/, '').trim())
    .filter(Boolean);
}

/** @param {string} text */
function parseRefs(text) {  return String(text)
    .split(/[\n,，、;；]+/)
    .map((s) => s.replace(/^[-*•\d.\s`]+/, '').replace(/`/g, '').trim())
    .filter((s) => s && !s.startsWith('#'));
}

/**
 * 同名两条时的来源判定：自治优先（§5 默认用自治版）。
 * @param {Array<{id: string, 来源: string}>} entries
 * @returns {string|null}
 */
function resolveSource(entries) {
  if (entries.length === 0) return null;
  return entries.find((c) => c.来源 === SOURCE_AUTONOMOUS)?.来源 ?? entries[0].来源;
}

/** @param {string} text */
function firstLine(text) {
  const line = String(text).split('\n').find((l) => l.trim() && !l.trim().startsWith('#'));
  return line ? line.replace(/^[-*•\s]+/, '').trim().slice(0, 80) : '';
}
