// lib/host/graph.js — 心智图谱（**host 半的纯函数层**）：把盘上的知识文件读成 nodes/edges。
//
// ── 为什么单独一个文件，而不是塞进 api.js ────────────────────────────────────
//   因为解析是**纯函数**：喂进 `[{zone, rel, bytes, text}]`，吐出 `{nodes, edges, …}`。
//   纯 ⇒ 能在 node 里拿夹具逐条验（含反例），而"读盘"留在 `api.js`
//   （那里已有 zone 白名单 / 目录穿越防护，**别在此处复制一份判据**）。
//
// ── 边的判据（这是本文件全部的价值，也是全部的风险）──────────────────────────
//   边**只有一种**来源：文件正文里出现的、**能解析到盘上真实文件**的 `.md` 引用。
//   一切"我觉得这两个东西有关系"的推断**都不画**——图上编关系比图上少根线更坏
//   （少根线看得见，编出来的关系没人能核对）。
//     ① 指不到实体      ⇒ **不算边**，进 `dangling` 点名（不静默丢）
//     ② 同名多份        ⇒ 同区优先；仍分不清 ⇒ 不算边，进 `ambiguous`（**不猜**）
//        （真实例子：`mind/L1/Learn.md` 是模板、`mind-private/L1/Learn.md` 是真条目）
//     ③ 自指（文件点名自己）⇒ 丢掉（会画出零信息量的自环）
//
// ── 与"孤岛"的关系 ──────────────────────────────────────────────────────────
//   `isolated` = 度为 0 的节点 = **一根引用线都没有**。这有两种完全不同的含义，
//   面板必须分开说、不许合成一句"死件"：
//     · 没人引用它、它也不引用别人 ⇒ 可能是**没人读的死件**，也可能是**根件**
//       （`SOUL.md` 这种被注入而不被正文引用的，天生度为 0）
//     · 所以本层只**点名**，不下结论；下结论要人看。
//
// ── 判据的边界（诚实标注）──────────────────────────────────────────────────
//   · 只认 `.md`：`.json/.txt/.yml` 不做引用图（心智里它们是数据，不是关系）。
//   · 只扫两个 zone（`mind/` + `mind-private/`）：包内 `firmware/` 不算节点——
//     它跟这两个区是**同源副本**，画进来会出现两套同名点，图立刻没法读。
//     正文里指向 `firmware/…` 的引用会走"裸名回退"落到 `mind/` 的同名件上（那是真引用）。

/** 层：取 rel 的第一段（`L0/SOUL.md` → `L0`；`README.md` → `other`）。 */
export function layerOf(rel) {
  const seg = String(rel || '').split('/')[0];
  return /^L[0-3]$/.test(seg) ? seg : 'other';
}

/**
 * 这个文件算不算"心智知识件"。
 *
 * 排除 `TRASH/`（2026-10-04 实测：私有区里有 `TRASH/snapshots-…/`，是自我修改前的快照暂存区）。
 * 为什么必须排：快照是**旧副本**，画进图会变成"同名两份 + 孤岛"，把真读数淹掉——
 * 第一次干跑时 5 个孤岛**全是** TRASH 件，一个真孤岛都没有。
 */
const EXCLUDE_PREFIXES = ['trash/'];

export function isGraphFile(_zone, rel) {
  const r = String(rel || '').replace(/\\/g, '/').toLowerCase();
  return !EXCLUDE_PREFIXES.some((p) => r.startsWith(p));
}

/**
 * 悬空引用分三类（**分类是为了让清单可用**，不是给结论）：
 *   · `template`：模板占位（`YYYY-MM-DD_描述.md` 这种写在规则文里的示例）
 *   · `package` ：指向**包内/别处**（`docs/DESIGN.md`、`scripts/…`）——不在两个 zone 里，本就不该是心智节点
 *   · `missing` ：其余 ⇒ 这才可能是**真缺件**（首次干跑就抓到：十几个 L1 件引用
 *                `mind\L1\changelog-L1.md`，而 `mind/L1/` 与包内 `firmware/L1/` 都没有这个文件）
 */
const PACKAGE_SEGMENTS = new Set([
  'docs', 'lib', 'client', 'scripts', 'test', 'firmware', 'node_modules', 'plugins',
]);

export function classifyDangling(target) {
  const raw = String(target || '');
  if (/(YYYY|XXX|<|\*|…|示例)/i.test(raw)) return 'template';
  const norm = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  const seg = norm.split('/')[0].toLowerCase();
  if (PACKAGE_SEGMENTS.has(seg) || /\.(json|ya?ml)$/i.test(norm)) return 'package';
  return 'missing';
}

/**
 * 从正文里抠出 `.md` 引用（**词面级**，不做语义推断）。
 *
 * 排除的字符包含空白、引号、markdown 括号与中英标点 ⇒ 天然的右侧边界，
 * 于是 `[文字](path.md#L24)`、`（见 `mind\L1\Tree.md`）` 都能正确切出 `path.md`。
 * 尾随的 `#L24` 靠回溯丢掉（正则要求以 `.md` 结尾）。
 */
const REF_RE = /[^\s"'`<>|*?()[\]{}，。；：、,;:!！?？（）「」『』]+\.md/gi;

/** 单文件最多取多少条引用（防病态文件把图撑爆；超出即截断并如实标注）。 */
const MAX_REFS_PER_FILE = 400;

export function extractRefs(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const seen = new Set();
  const out = [];
  // 每行都重置 lastIndex：正则是 /g 的，跨行复用必须自己管状态
  for (const line of text.split('\n')) {
    REF_RE.lastIndex = 0;
    let m;
    while ((m = REF_RE.exec(line)) !== null) {
      const raw = m[0];
      // ⚠️ `:` 是右侧/左侧边界字符 ⇒ `https://a/b.md` 会从 `//a/b.md` 这一截开始匹配。
      //    这种"URL 尾巴"必须在这里就丢：否则它会以词面身份进 dangling 清单，
      //    把真正该修的缺件淹掉（第一次自测就是被这条抓出来的）。
      if (m.index > 0 && line[m.index - 1] === ':') continue;
      if (raw.startsWith('/')) continue;
      if (seen.has(raw)) continue;
      seen.add(raw);
      out.push(raw);
      if (out.length >= MAX_REFS_PER_FILE) return out;
    }
  }
  return out;
}

/**
 * 把一个引用词面归一成 `{zoneHint, path}`；返回 `null` = **这条不算引用**（不是"悬空"）。
 *
 * 为什么必须区分"跳过"与"悬空"：`https://…/x.md` 这种指不到的**本来就不是心智引用**，
 * 把它塞进"断裂引用"清单等于自己制造噪声，几次之后这份清单就没人看了。
 */
export function normalizeRef(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (/:\/\//.test(s)) return null;                 // URL
  s = s.replace(/\\/g, '/');
  // 绝对路径形态（本机真路径，散落在正文里）⇒ 只取 mind-data 之后那一段，别的丢掉
  const abs = /(?:^|\/)mind-data\/(mind-private|mind)\/(.+)$/i.exec(s);
  if (abs) {
    return { zoneHint: abs[1].toLowerCase() === 'mind-private' ? 'private' : 'mind', path: abs[2] };
  }
  if (/^[a-zA-Z]:/.test(s)) return null;            // 盘符开头但不在 mind-data 里 ⇒ 不是心智件
  while (s.startsWith('./')) s = s.slice(2);
  if (s.startsWith('/')) return null;
  if (s.includes('..')) return null;                // 相对跳跃 ⇒ 不猜
  const zone = /^(mind-private|mind)\/(.+)$/i.exec(s);
  if (zone) return { zoneHint: zone[1].toLowerCase() === 'mind-private' ? 'private' : 'mind', path: zone[2] };
  return { zoneHint: null, path: s };
}

/**
 * 解析一条引用 → `{kind:'skip'|'edge'|'dangling'|'ambiguous', …}`。
 * 查找顺序 = **同区优先**（引用多半指自己那一区的同名件）：
 *   带路径的：按 zoneHint/同区/另一区 依序做整路径命中 →
 *             都不中再退到"裸名"（`L2/Skill/x.md` 这种半截路径很常见）；
 *   裸名的  ：唯一命中即连；同名多份时若"同区恰好一份"就选它，否则判 `ambiguous`（**不猜**）。
 */
export function resolveRef(raw, fromNode, index) {
  const norm = normalizeRef(raw);
  if (!norm) return { kind: 'skip' };
  const other = fromNode.zone === 'mind' ? 'private' : 'mind';
  const order = norm.zoneHint
    ? [norm.zoneHint, norm.zoneHint === 'mind' ? 'private' : 'mind']
    : [fromNode.zone, other];

  if (norm.path.includes('/')) {
    for (const z of order) {
      const id = index.byRel.get(z + ':' + norm.path.toLowerCase());
      if (id) return { kind: 'edge', to: id };
    }
  }
  const base = norm.path.split('/').pop().toLowerCase();
  const cands = index.byBase.get(base) || [];
  if (cands.length === 0) return { kind: 'dangling' };
  if (cands.length === 1) return { kind: 'edge', to: cands[0] };
  const sameZone = cands.filter((id) => id.startsWith(fromNode.zone + ':'));
  if (sameZone.length === 1) return { kind: 'edge', to: sameZone[0] };
  return { kind: 'ambiguous', candidates: cands.length };
}

/**
 * 建图：`files` ＝ `[{zone, rel, bytes, text}]`（text 缺失即只当节点、不抽边）。
 *
 * 返回的每个数字都**可回溯**：edges 带 `via`（原始词面），dangling/ambiguous 带 `from`，
 * 面板上点开就能对着原文核——这是"图上的线不是编的"唯一证明方式。
 */
export function buildGraph(files, opts = {}) {
  const maxDangling = opts.maxDangling ?? 200;
  const maxAmbiguous = opts.maxAmbiguous ?? 100;
  const maxFroms = opts.maxFroms ?? 12;

  const nodes = [];
  const byRel = new Map();
  const byBase = new Map();
  for (const f of Array.isArray(files) ? files : []) {
    if (!f || !f.zone || !f.rel) continue;
    const id = f.zone + ':' + f.rel;
    const label = String(f.rel).split('/').pop();
    nodes.push({
      id, zone: f.zone, rel: f.rel, label,
      layer: layerOf(f.rel),
      kind: f.kind || 'doc',
      bytes: typeof f.bytes === 'number' ? f.bytes : null,
      inDeg: 0, outDeg: 0, deg: 0,
    });
    byRel.set(id.toLowerCase(), id);
    const b = label.toLowerCase();
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b).push(id);
  }
  const index = { byRel, byBase };

  const edges = [];
  const edgeKeys = new Set();
  /** 悬空/歧义都按**目标词面**归组：同一个烂引用被十几个文件引，逐条列会把清单淹掉。 */
  const danglingMap = new Map();
  const ambiguousMap = new Map();

  for (const f of Array.isArray(files) ? files : []) {
    if (!f || !f.zone || !f.rel || typeof f.text !== 'string') continue;
    const from = f.zone + ':' + f.rel;
    for (const raw of extractRefs(f.text)) {
      const r = resolveRef(raw, { zone: f.zone, rel: f.rel }, index);
      if (r.kind === 'edge') {
        if (r.to === from) continue;                 // 自指不画
        const key = from + '\u0000' + r.to;
        if (edgeKeys.has(key)) continue;
        edgeKeys.add(key);
        edges.push({ from, to: r.to, kind: 'ref', via: raw });
        continue;
      }
      if (r.kind === 'skip') continue;
      const bucket = r.kind === 'dangling' ? danglingMap : ambiguousMap;
      if (bucket.size >= (r.kind === 'dangling' ? maxDangling : maxAmbiguous) && !bucket.has(raw)) continue;
      let rec = bucket.get(raw);
      if (!rec) {
        rec = r.kind === 'dangling'
          ? { target: raw, why: classifyDangling(raw), count: 0, froms: [] }
          : { target: raw, candidates: r.candidates, count: 0, froms: [] };
        bucket.set(raw, rec);
      }
      rec.count += 1;
      if (rec.froms.length < maxFroms && !rec.froms.includes(from)) rec.froms.push(from);
    }
  }

  const byCount = (a, b) => b.count - a.count || a.target.localeCompare(b.target);
  const dangling = [...danglingMap.values()].sort(byCount);
  const ambiguous = [...ambiguousMap.values()].sort(byCount);

  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const e of edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (a) a.outDeg += 1;
    if (b) b.inDeg += 1;
  }
  for (const n of nodes) n.deg = n.inDeg + n.outDeg;

  const isolated = nodes.filter((n) => n.deg === 0).map((n) => n.id).sort();
  const byLayer = {};
  for (const n of nodes) byLayer[n.layer] = (byLayer[n.layer] || 0) + 1;
  const danglingByWhy = {};
  for (const d of dangling) danglingByWhy[d.why] = (danglingByWhy[d.why] || 0) + 1;

  return {
    nodes, edges, dangling, ambiguous, isolated,
    stats: {
      nodes: nodes.length,
      edges: edges.length,
      dangling: dangling.length,
      danglingRefs: dangling.reduce((n, d) => n + d.count, 0),
      danglingByWhy,
      ambiguous: ambiguous.length,
      isolated: isolated.length,
      byLayer,
      /** 进出度的前三名（面板上"枢纽"的机械依据，不是画出来的感觉）。 */
      hubs: nodes.slice().sort((a, b) => b.deg - a.deg || a.id.localeCompare(b.id)).slice(0, 5)
        .map((n) => ({ id: n.id, deg: n.deg, inDeg: n.inDeg, outDeg: n.outDeg })),
    },
  };
}
