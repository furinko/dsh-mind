// lib/host/graph.js — 心智图谱（**host 半的纯函数层**）：把盘上的知识文件读成 nodes/edges。
//
// ── 为什么整层重写（2026-10-04 主人明示"不好，你参考DSHOME的图谱呗"）──────────
//   v1 用"正文词面里的 `.md` 引用"当边 ⇒ 实测 45 节点刷出 **211 条边**，其中
//   `L1/Tree.md` 一张索引表就贡献 32 条"我列了你"的出边，于是**枢纽全是假的**
//   （度由排版决定，与语义无关）。参考实现 `E:\DSHOME\packages\dshome-mind` 的边
//   **只来自 frontmatter**，条条都能追到作者写的那一行：
//     · `metadata.related`（人显式写的关联 —— 主来源）
//     · `metadata.tags`（共享 ≥2 个 tag 自动成边 —— 用来救孤点；阈值 2 防"通用 tag 把全图连成一坨"）
//     · `topic`（L3 记忆同主题成边 —— topic 是分类维度，比 tags 可靠）
//   边少了，但**每条都有语义**。这就是"图谱"和"毛线团"的区别。
//
// ── 本层只做纯函数（不读盘）──────────────────────────────────────────────────
//   喂进 `[{zone, rel, bytes, text}]`，吐出 `{nodes, edges, …}`。读盘留在 `api.js`
//   （那里已有 zone 白名单 / 穿越防护 / 大小上限，**别在此处复制一份判据**）。
//
// ── 层的划分（与参考实现同表；客户端必须**逐层登记**）───────────────────────
//   ⚠️ 参考实现门禁里最贵的一条：客户端 `LAYER_ORDER` 漏登记一个层 id ⇒ 布局不给它排位
//   ⇒ 渲染节点时读 `p.x` 抛 TypeError ⇒ **整块图谱白屏**。所以本文件的 `LAYER_ORDER`
//   就是唯一真源：客户端拿它渲染，自测拿它做"两边一致"的断言。

/** 层表（数组顺序＝纵向色带顺序）。id 是 host↔client 的契约。 */
export const LAYER_ORDER = [
  { id: 'L0', label: 'L0 宪法', color: '#8b5cf6' },
  { id: 'L1', label: 'L1 规则', color: '#4D6BFE' },
  { id: 'L2S', label: 'L2 技能', color: '#10b981' },
  { id: 'L2E', label: 'L2 经验', color: '#14b8a6' },
  { id: 'AG', label: '角色卡', color: '#a78bfa' },
  { id: 'L3I', label: 'L3 记忆', color: '#f97316' },
  { id: 'L3P', label: '项目记忆', color: '#ef4444' },
  { id: 'L3H', label: 'L3 历史', color: '#f59e0b' },
  { id: 'TR', label: '回收站', color: '#64748b' },
  { id: 'TK', label: '任务缓冲', color: '#ec4899' },
  { id: 'OT', label: '其他（非标路径）', color: '#94a3b8' },
];

const LAYER_BY_ID = new Map(LAYER_ORDER.map((l) => [l.id, l]));

/** 路径 → 层 id。**兜底必须存在**（参考实现里 `OT` 就是被一个非标路径打出来的）。 */
export function layerOf(rel) {
  const r = String(rel || '');
  if (/^L0\//.test(r)) return 'L0';
  if (/^L1\//.test(r)) return 'L1';
  if (/^L2\/Skill\//.test(r)) return 'L2S';
  if (/^L2\/Exp\//.test(r)) return 'L2E';
  if (/^L2\/agents\//.test(r)) return 'AG';
  if (/^L3\/history\//.test(r)) return 'L3H';
  if (/^L3\/projects\//.test(r)) return 'L3P';
  if (/^L3\//.test(r)) return 'L3I';
  if (/^TRASH\//.test(r)) return 'TR';
  if (/^tasks\//.test(r)) return 'TK';
  return 'OT';
}

/**
 * 该文件算不算"活内容"（进图候选）。
 *
 * 三条排除，全部来自参考实现踩过的坑，**没有一条是洁癖**：
 *   · `README.md` / `_index.md`：索引件，进图只会造出"每个目录都有的同名卡"
 *   · `tasks/evolution/snapshots/`：归档副本、非活内容
 *   · `TRASH/` 下的**归档副本**：任一路径段带 `__`，**或**以 `snapshots-` 开头。
 *     ⚠️ 判据必须**按段**看、且要枚举**同义形态**——这条是配方 ㈡ 的标本，本机实测过两次：
 *       (a) 戳落在**目录名**上（`TRASH/2026-09-29T14-54-06__mindfw-backup__…` 是文件级，
 *           `TRASH/snapshots-20261004-0040/…` 是目录级）——旧口径只看 basename ⇒ 整棵漏网；
 *       (b) 本机快照机制用的是 `snapshots-<YYYYMMDD-HHMM>`（**横杠**），而固件归档戳是 `__`
 *           ⇒ 只认 `__` 时，14 个目录级副本里的 `Learn.md`/`Tree.md`/`limits.md` 照样进图
 *           （实测：11 个 TR 节点全是这类旧副本，一个真回收件都没有）。
 *     **只排归档副本**：TRASH 下确属"真回收件"的（日期 + 单下划线，如
 *     `TRASH/2026-09-12_退役记录_回收件.md`）照常进图——不许放宽成"TRASH 整层排掉"。
 */
const ARCHIVE_SEG = (s) => s.includes('__') || s.startsWith('snapshots-');

export function isGraphFile(rel) {
  const r = String(rel || '').replace(/\\/g, '/');
  if (!r || r.startsWith('.')) return false;
  const base = r.split('/').pop();
  if (base === 'README.md' || base === '_index.md' || base === '.gitkeep') return false;
  if (r.startsWith('tasks/evolution/snapshots/')) return false;
  if (r.startsWith('TRASH/') && r.split('/').some(ARCHIVE_SEG)) return false;
  return true;
}

// ── frontmatter 小工具（词面级，不引 YAML 依赖）──────────────────────────────
// ⚠️ 口径必须**容许嵌套缩进**：本机实测 `tags`/`related` 长在 `metadata:` 下面
//    （`metadata:\n  related: [...]`）。v1 用行首匹配 `^related:` ⇒ **假 0 命中**，
//    差点得出"数据里没有 related ⇒ 边模型不适用"的错误结论——恰好是配方 ㈡ 的活标本。

function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''));
  return m ? m[1] : '';
}
function fmValue(fm, key) {
  const re = new RegExp('(?:^|\\n)\\s*' + key + ':\\s*([^\\n]+)');
  const m = re.exec(fm);
  return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : '';
}
/** frontmatter `name:` —— 命名链第一档。 */
export function fmName(text) {
  return fmValue(frontmatter(text), 'name');
}
/** 正文第一个 `#` 标题 —— 命名链第二档。 */
export function firstTitle(text) {
  const body = String(text || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const t = /^#+\s+(.+?)\s*$/m.exec(body);
  return t ? t[1].trim().replace(/[#*`]/g, '') : '';
}
/** frontmatter `related: [a, b]` → **basename 去 `.md` 小写**（参考实现口径，连线按它认人）。 */
export function relatedList(text) {
  const m = /(?:^|\n)\s*related:\s*\[([^\]]*)\]/.exec(frontmatter(text));
  if (!m) return [];
  return m[1].split(',').map((s) => {
    const tail = String(s).trim().replace(/^['"]|['"]$/g, '').split(/[/\\]/).pop() || '';
    return tail.replace(/\.md$/i, '').toLowerCase();
  }).filter(Boolean);
}
/** frontmatter `tags: [a, b]`（YAML 内联数组）—— 自动成边的数据源。 */
export function fmTags(text) {
  const m = /(?:^|\n)\s*tags:\s*\[([^\]]*)\]/.exec(frontmatter(text));
  if (!m) return [];
  return m[1].split(',').map((s) => String(s).trim().replace(/^['"]|['"]$/g, '').toLowerCase()).filter(Boolean);
}
/** frontmatter `topic: <主题>` —— 同主题成边的数据源。 */
export function fmTopic(text) {
  return fmValue(frontmatter(text), 'topic').toLowerCase();
}

/** 文件名去 `YYYY-MM-DD_` 前缀（TRASH 快照整条保留：区分历史版本只靠它）。 */
export function fileNameStem(rel) {
  const base = String(rel).split('/').pop().replace(/\.md$/i, '');
  if (String(rel).startsWith('TRASH/')) return base;
  return base.replace(/^\d{4}-\d{2}-\d{2}_/, '');
}

/**
 * 卡片名（三档命名链）。
 * 为什么不能简单取 `name`：参考实现实测过"名字辨识度太低"——292 节点里 237 个落在重名组
 * （49 组），因为 L3 记忆卡以前全取**主题目录名**（同主题一卡一名）。现在 L3/TRASH 取
 * **文件名**（擦掉日期前缀，留作者自己起的那句话标题），天然唯一。
 */
export function labelOf(rel, text) {
  const seg = String(rel).split('/');
  let label = fmName(text);
  if ((!label && seg[0] === 'L3') || seg[0] === 'TRASH') label = fileNameStem(rel);
  if (!label) label = firstTitle(text);
  if (!label) label = seg[seg.length - 1].replace(/\.md$/i, '');
  return label;
}

/** 项目归属：`L3/projects/<key>/…` → key；其它 → ''。 */
export function projectOf(rel) {
  const seg = String(rel).split('/');
  return seg[0] === 'L3' && seg[1] === 'projects' && seg[2] ? seg[2] : '';
}

/**
 * 建图。`files` ＝ `[{zone, rel, bytes, text}]`（zone ∈ `mind` | `private`）。
 *
 * `opts.project`：给项目 key 时做**黑名单式隔离**（参考实现口径）——只剔除"别人家的项目记忆"，
 * 底座（L0-L2 + 私有底座 + L3/common + tasks/TRASH）原样在场。为什么是黑名单不是白名单：
 * 切项目时若把底座也切掉，图会碎成"只有几张项目卡"，而项目卡的意义恰恰是"它在整套规则里的位置"。
 */
export function buildGraph(files, opts = {}) {
  const all = (Array.isArray(files) ? files : []).filter((f) => f && f.zone && f.rel && isGraphFile(f.rel));
  const pj = String(opts.project || '').trim();
  const scoped = Boolean(pj) && !/[/\\]/.test(pj);
  const list = all.filter((f) => {
    if (!scoped) return true;
    if (f.zone !== 'private') return true;                        // 出厂固件永远在场
    if (!f.rel.startsWith('L3/projects/')) return true;           // 非项目记忆全留
    return f.rel.startsWith('L3/projects/' + pj + '/');
  });

  const nodes = [];
  const byKey = new Map();            // 认人表：key（label / basename，小写）→ Map<id, node>
  const addKey = (k, node) => {
    if (!k) return;
    const key = String(k).toLowerCase();
    if (!byKey.has(key)) byKey.set(key, new Map());
    byKey.get(key).set(node.id, node);
  };
  for (const f of list) {
    const text = typeof f.text === 'string' ? f.text : '';
    const lay = LAYER_BY_ID.get(layerOf(f.rel)) || LAYER_BY_ID.get('OT');
    nodes.push({
      id: `${f.zone}:${f.rel}`,
      label: labelOf(f.rel, text),
      layer: lay.id,
      layerLabel: lay.label,
      color: lay.color,
      project: projectOf(f.rel),
      zone: f.zone,
      rel: f.rel,
      bytes: typeof f.bytes === 'number' ? f.bytes : null,
      hasFm: frontmatter(text) !== '',
    });
    const n = nodes[nodes.length - 1];
    addKey(n.label, n);
    addKey(f.rel.split('/').pop().replace(/\.md$/i, ''), n);
  }

  /**
   * 按 key 找目标节点。**同名多份时不许猜**——这是 v1 留下、并且在参考实现里缺失的一条纪律。
   *
   * 为什么必须留：参考实现的 `byLabel` 是单值 Map，**后写的那份直接覆盖**
   * ⇒ `related: [project.md]`（两个项目下都有 project.md）会静默连到"最后注册的那一个"。
   * 那等于在图上报了一条作者没表达的关系，而且没人能核对。这里的口径：
   *   命中 1 份 ⇒ 连线；命中多份 ⇒ **同区唯一**才连线；否则记入 `relatedMiss`（why=ambiguous）。
   */
  function lookup(key, fromZone) {
    const m = byKey.get(String(key || '').toLowerCase());
    if (!m || m.size === 0) return { kind: 'missing' };
    const arr = [...m.values()];
    if (arr.length === 1) return { kind: 'node', node: arr[0] };
    const sameZone = arr.filter((n) => n.zone === fromZone);
    if (sameZone.length === 1) return { kind: 'node', node: sameZone[0] };
    return { kind: 'ambiguous', candidates: arr.length };
  }

  // 兜底去重（参考实现同款）：跨区同 rel（`L1/Learn.md` 出厂 + 私有各一份）与快照撞名，
  // 靠**可视 label** 追加父目录名 / 区名区分；**不动 byKey**（它服务连线，语义要保持原样）。
  {
    const groups = new Map();
    for (const n of nodes) {
      if (!groups.has(n.label)) groups.set(n.label, []);
      groups.get(n.label).push(n);
    }
    for (const [, same] of groups) {
      if (same.length < 2) continue;
      for (const n of same) {
        const seg = n.rel.split('/');
        const parent = seg.length >= 2 ? seg[seg.length - 2] : '';
        if (parent && n.label.indexOf('· ' + parent) < 0) n.label = `${n.label} · ${parent}`;
      }
      const still = new Map();
      for (const n of same) {
        if (!still.has(n.label)) still.set(n.label, []);
        still.get(n.label).push(n);
      }
      for (const [, dup] of still) {
        if (dup.length < 2) continue;
        for (const n of dup) n.label = `${n.label} · ${n.zone === 'private' ? '私有' : '出厂'}`;
      }
    }
  }

  const edges = [];
  const seen = new Set();
  const addEdge = (a, b, type) => {
    if (!a || !b || a === b) return false;
    const key = [a, b].sort().join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    edges.push({ source: a, target: b, type });
    return true;
  };

  // ① related（显式，主来源）
  const relatedMiss = [];
  for (const f of list) {
    const text = typeof f.text === 'string' ? f.text : '';
    const src = `${f.zone}:${f.rel}`;
    for (const r of relatedList(text)) {
      const hit = lookup(r, f.zone);
      if (hit.kind === 'missing') { relatedMiss.push({ from: src, target: r, why: 'missing' }); continue; }
      if (hit.kind === 'ambiguous') { relatedMiss.push({ from: src, target: r, why: 'ambiguous', candidates: hit.candidates }); continue; }
      addEdge(src, hit.node.id, 'related');
    }
  }

  // ② tags：共享 ≥2 个 tag 才连（阈值 2 防"通用 tag 把全图连成一坨"）
  const tagIndex = new Map();
  for (const f of list) {
    const tags = fmTags(typeof f.text === 'string' ? f.text : '');
    if (!tags.length) continue;
    const src = `${f.zone}:${f.rel}`;
    for (const t of tags) {
      if (!tagIndex.has(t)) tagIndex.set(t, new Set());
      tagIndex.get(t).add(src);
    }
  }
  const pairShare = new Map();
  for (const group of tagIndex.values()) {
    const arr = [...group];
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const key = [arr[i], arr[j]].sort().join('|');
        pairShare.set(key, (pairShare.get(key) || 0) + 1);
      }
    }
  }
  for (const [key, share] of pairShare) {
    if (share < 2) continue;
    const cut = key.indexOf('|');
    addEdge(key.slice(0, cut), key.slice(cut + 1), 'tags');
  }

  // ③ topic：L3 记忆 / 项目记忆同主题两两成边
  const topicIndex = new Map();
  for (const f of list) {
    if (f.zone !== 'private') continue;
    if (!(f.rel.startsWith('L3/common/') || f.rel.startsWith('L3/projects/'))) continue;
    const topic = fmTopic(typeof f.text === 'string' ? f.text : '');
    if (!topic) continue;
    const src = `${f.zone}:${f.rel}`;
    if (!topicIndex.has(topic)) topicIndex.set(topic, new Set());
    topicIndex.get(topic).add(src);
  }
  for (const group of topicIndex.values()) {
    const arr = [...group];
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) addEdge(arr[i], arr[j], 'topic');
    }
  }

  // 读数（面板要显示，且每个数字都能复核）
  const deg = new Map();
  for (const e of edges) {
    deg.set(e.source, (deg.get(e.source) || 0) + 1);
    deg.set(e.target, (deg.get(e.target) || 0) + 1);
  }
  for (const n of nodes) n.deg = deg.get(n.id) || 0;
  const isolated = nodes.filter((n) => n.deg === 0).map((n) => n.id).sort();
  const byLayer = {};
  for (const lay of LAYER_ORDER) {
    const c = nodes.filter((x) => x.layer === lay.id).length;
    if (c) byLayer[lay.id] = c;
  }
  const byZone = { mind: 0, private: 0 };
  for (const n of nodes) byZone[n.zone] = (byZone[n.zone] || 0) + 1;
  const byType = { related: 0, tags: 0, topic: 0 };
  for (const e of edges) byType[e.type] = (byType[e.type] || 0) + 1;
  const projects = [...new Set(nodes.map((n) => n.project).filter(Boolean))].sort();
  const missByWhy = { missing: 0, ambiguous: 0 };
  for (const m of relatedMiss) missByWhy[m.why] = (missByWhy[m.why] || 0) + 1;

  return {
    nodes, edges, isolated, relatedMiss, projects,
    stats: {
      nodes: nodes.length,
      edges: edges.length,
      byType,
      byLayer,
      byZone,
      isolated: isolated.length,
      relatedMiss: relatedMiss.length,
      relatedMissByWhy: missByWhy,
      /** 边密度：一眼看出图是"毛线团"还是"一盘散沙"（v1 是 4.7，参考实现约 1.1）。 */
      edgePerNode: nodes.length ? Number((edges.length / nodes.length).toFixed(2)) : 0,
      /** 带 frontmatter 的节点数 —— 边的**上限**由它决定（没有 frontmatter 就没有 related/tags）。 */
      withFm: nodes.filter((n) => n.hasFm).length,
      hubs: nodes.slice().sort((a, b) => b.deg - a.deg || a.id.localeCompare(b.id)).slice(0, 5)
        .map((n) => ({ id: n.id, label: n.label, deg: n.deg, layer: n.layer })),
    },
  };
}

/** 客户端渲染要用的层表（**唯一真源**：两边不一致 ⇒ 整块白屏，见文件头注释）。 */
export function layerTable() {
  return LAYER_ORDER.map((l) => ({ ...l }));
}
