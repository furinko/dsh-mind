/**
 * 授权标签与正文结构（§4 授权标签、§6 对象元数据、§11 写入侧校验）。
 *
 * 一条纪律（§4）：**目录负责「找得到」，标签负责「谁能改」**。
 * 所以本文件是「谁能改」的唯一解析处——策略引擎只读这里的结论，不看路径。
 *
 * 标签是**段**粒度的：同一份文档里，权限矩阵那段可以是「法律」，
 * 作业规程那段可以是「自治」。对象级 authority = 各段中最高的那个。
 */
import { InvalidBody } from './kernel/errors.js';
import { splitClauses } from './kernel/text.js';

/** 授权档的强弱，用于「冲突时以更高 authority 为准」（§4）。 */
export const AUTHORITY_RANK = { 宪章: 3, 法律: 2, 自治: 1, 只增: 0 };

/** §6 `kind` 的封闭清单。 */
export const KINDS = ['身份', '规则', '能力', '知识', '经历', '偏好', '作答', '任务', '消息', '产物', '账目'];

/** §6 `authority` 的封闭清单。 */
export const AUTHORITIES = ['宪章', '法律', '自治', '只增'];

/** 段标记：`<!-- authority: 法律 -->`，写在段首。 */
const SEGMENT_MARKER = /^<!--\s*authority\s*:\s*(宪章|法律|自治|只增)\s*-->\s*$/;

/**
 * @param {string} a
 * @param {string} b
 * @returns {number} 正数表示 a 更强
 */
export function compareAuthority(a, b) {
  return (AUTHORITY_RANK[a] ?? -1) - (AUTHORITY_RANK[b] ?? -1);
}

/**
 * @param {string[]} list
 * @param {string} [fallback]
 * @returns {string} 最强的那一档
 */
export function highestAuthority(list, fallback = '自治') {
  let best = fallback;
  for (const item of list) {
    if (compareAuthority(item, best) > 0) best = item;
  }
  return best;
}

/**
 * 解析极小 YAML 子集（对象元数据只有标量与短列表，不需要完整 YAML）。
 *
 * 为什么不用 YAML 依赖：§12.5「出厂件不含任何用户特定信息」之外还有一条现实约束——
 * 插件要在没有安装步骤的情况下被宿主直接 import。零依赖是最强的可装载性保证。
 *
 * @param {string} raw front matter 内部文本（不含 `---` 行）
 * @returns {{ data: Record<string, any>, errors: string[] }}
 */
export function parseSimpleYaml(raw) {
  /** @type {Record<string, any>} */
  const data = {};
  const errors = [];
  for (const rawLine of String(raw).split('\n')) {
    const line = rawLine.replace(/\s+#.*$/, '').trimEnd();
    if (!line.trim() || line.trim().startsWith('#')) continue;
    // 键允许中文：对象元数据里有 `名`、`摘要` 这类人读字段，
    // 只认 ASCII 会让它们**静默丢失** —— 那比报错更难查。
    const m = /^([\p{Letter}_][\p{Letter}\p{Number}_-]*)\s*:\s*(.*)$/u.exec(line);
    if (!m) {
      errors.push(`无法解析的元数据行：${line.trim()}`);
      continue;
    }
    const [, key, rest] = m;
    const value = rest.trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value
        .slice(1, -1)
        .split(',')
        .map((s) => unquote(s.trim()))
        .filter((s) => s !== '');
    } else if (value === '') {
      data[key] = [];
    } else {
      data[key] = unquote(value);
    }
  }
  return { data, errors };
}

/** @param {string} value */
function unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * 把对象元数据写成 front matter。键顺序固定，保证同一份内容两次写出字节一致
 * （升级层要靠字节比对判断「出厂有没有改」）。
 * @param {Record<string, any>} data
 * @returns {string}
 */
export function formatFrontMatter(data) {
  const order = ['id', 'kind', 'authority', 'zone', 'domain', 'project', 'version', 'generation', 'refs'];
  const keys = [...order.filter((k) => data[k] !== undefined), ...Object.keys(data).filter((k) => !order.includes(k)).sort()];
  const lines = keys.map((key) => {
    const value = data[key];
    if (Array.isArray(value)) return `${key}: [${value.join(', ')}]`;
    if (value === null || value === undefined) return `${key}:`;
    return `${key}: ${value}`;
  });
  return `---\n${lines.join('\n')}\n---\n`;
}

/**
 * 解析一份对象文档。
 *
 * @param {string} text 全文
 * @param {{ defaultAuthority?: string }} [options]
 * @returns {{
 *   meta: Record<string, any>,
 *   body: string,
 *   segments: Array<{ authority: string, heading: string|null, key: string, body: string, hash: string }>,
 *   authority: string,
 *   clauses: ReturnType<typeof splitClauses>,
 *   errors: string[],
 * }}
 */
export function parseDocument(text, options = {}) {
  const source = String(text);
  const fallback = options.defaultAuthority ?? '自治';
  const errors = [];
  let meta = {};
  let body = source;

  if (source.startsWith('---\n')) {
    const end = source.indexOf('\n---', 3);
    if (end === -1) {
      errors.push('front matter 未闭合');
    } else {
      const parsed = parseSimpleYaml(source.slice(4, end + 1));
      meta = parsed.data;
      errors.push(...parsed.errors);
      body = source.slice(end + 4).replace(/^\n/, '');
    }
  }

  const clauses = splitClauses(body);
  /** @type {Array<{ authority: string, heading: string|null, key: string, body: string, hash: string }>} */
  const segments = [];
  let current = { authority: fallback, heading: null, lines: [] };
  const flush = () => {
    const segBody = current.lines.join('\n').trim();
    if (segBody) {
      segments.push({
        authority: current.authority,
        heading: current.heading,
        key: current.heading ?? '@top',
        body: segBody,
        hash: clauseHashOf(clauses, current.heading) ?? '',
      });
    }
  };

  for (const line of body.split('\n')) {
    const marker = SEGMENT_MARKER.exec(line.trim());
    if (marker) {
      flush();
      current = { authority: marker[1], heading: null, lines: [] };
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) {
      flush();
      current = { authority: current.authority, heading: line.replace(/^#{1,6}\s+/, '').trim(), lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  flush();

  return {
    meta,
    body,
    segments,
    authority: highestAuthority(segments.map((s) => s.authority), fallback),
    clauses,
    errors,
  };
}

/** @param {ReturnType<typeof splitClauses>} clauses @param {string|null} heading */
function clauseHashOf(clauses, heading) {
  if (!heading) return null;
  return clauses.find((c) => c.heading === heading)?.hash ?? null;
}

/**
 * §11：正文结构是写入侧义务——写入时校验，不合规拒绝写入。
 *
 * 每类对象的「合规」定义在此表里，别处不再重复判断。
 * 事后修补会违反「不许改写只能追加」，所以这是唯一时机。
 */
const STRUCTURE_RULES = {  规则: { sections: [], meta: ['id', 'authority'], because: '规则必须带授权标签才能被策略引擎判定' },
  身份: { sections: ['个体L0', '个体L1'], meta: ['id'], because: '角色卡必须显式给出身份与个体规则两段' },
  能力: { sections: ['适用岗位', '怎么做'], meta: ['id'], because: '能力库装的是「怎么做」，且必须声明适用岗位以维持单源' },
  知识: { sections: ['正文'], meta: ['id', 'project', 'source'], because: '知识写入必带「谁记的 + 怎么知道的」，并恒打项目标签' },
  经历: { sections: ['正文'], meta: ['id', 'source'], because: '经历写入必带来源；只增不改' },
  偏好: { sections: ['正文'], meta: ['id', 'source'], because: '偏好属于部署且永不外流，写入必带来源' },
  作答: { sections: ['正文'], meta: ['id', 'source'], because: '作答归档需可追溯来源' },
  任务: { sections: ['判据'], meta: ['id'], because: '§7：验收标准必填，派发后判据冻结' },
  产物: { sections: [], meta: ['id'], because: '产物是对象存储里的实体，任务节点只存引用' },
  消息: { sections: [], meta: ['id'], because: '消息 authority = 只增' },
  账目: { sections: [], meta: ['id'], because: '账目只增' },
};

/**
 * @param {string} kind
 * @param {ReturnType<typeof parseDocument>} doc
 * @throws {InvalidBody}
 */
export function assertStructure(kind, doc) {
  const rule = STRUCTURE_RULES[kind];
  if (!rule) throw new InvalidBody(`未知的 kind：${kind}`, { detail: { kind } });
  // 封闭清单要被真的执行，而不是当注释：新增一个 kind 就必须同时给出结构规则。
  if (!KINDS.includes(kind)) throw new InvalidBody(`kind=${kind} 不在 §6 的封闭清单里`, { detail: { 清单: KINDS } });  if (doc.errors.length) {
    throw new InvalidBody(`元数据无法解析：${doc.errors.join('；')}`, { detail: { errors: doc.errors } });
  }
  const missingMeta = rule.meta.filter((key) => doc.meta[key] === undefined || doc.meta[key] === '');
  const headings = doc.clauses.map((c) => c.heading);
  const missingSections = rule.sections.filter((name) => !headings.some((h) => h.includes(name)));
  if (missingMeta.length || missingSections.length) {
    throw new InvalidBody(
      `${kind} 正文结构不合规：${rule.because}。缺少 ${[...missingMeta, ...missingSections].join('、')}`,
      { missing: [...missingMeta, ...missingSections], detail: { kind, rule: rule.because } },
    );
  }
  if (kind === '规则' && !AUTHORITIES.includes(doc.meta.authority)) {
    throw new InvalidBody(`规则对象的 authority 必须是宪章/法律/自治之一，收到：${doc.meta.authority}`);
  }
}
