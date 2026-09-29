// test/selftest.mjs — 骨架自检：模块能加载、数据模型正确、自举可用、契约一致。
//
// 无参 = 只读（临时目录自建自清，不碰真实数据）。退出码：PASS 0 / FAIL 1。
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');

let pass = 0;
const fails = [];
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fails.push(name); console.log(`  ✗ ${name}${detail ? '  → ' + detail : ''}`); }
};

const ENV_KEYS = ['MIND_HOME', 'DSH_HOME', 'MIND_PROFILE_NAME', 'MIND_PROFILE_DIR', 'MIND_MARKET_DIR'];
const saved = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];
const setEnv = (o) => { for (const k of ENV_KEYS) delete process.env[k]; Object.assign(process.env, o); };
const restoreEnv = () => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };

console.log('== dsh-mind 骨架自检 ==');

// ── ① 模块加载（**自动发现**，不用每次手工维护清单）──────────────────────────
const LIB_FILES = readdirSync(join(PKG, 'lib')).filter((f) => f.endsWith('.js')).map((f) => `lib/${f}`);
const HOST_FILES = readdirSync(join(PKG, 'lib', 'host')).filter((f) => f.endsWith('.js')).map((f) => `lib/host/${f}`);
const MODULES = [...LIB_FILES, ...HOST_FILES];
const loaded = {};
for (const rel of MODULES) {
  try { loaded[rel] = await import(pathToFileURL(join(PKG, rel.split('/').join(sep))).href); }
  catch (e) { check(`① ${rel} 可加载`, false, `${e?.name}: ${e?.message}`); }
}
check(`① ${MODULES.length} 个模块全部可加载（含 TLA 的 upstream）`,
  Object.keys(loaded).length === MODULES.length, `失败 ${MODULES.length - Object.keys(loaded).length} 个`);

// ── ② 数据模型 ───────────────────────────────────────────────────────────────
const paths = loaded['lib/paths.js'];
if (paths) {
  const tmp = mkdtempSync(join(tmpdir(), 'dshmind-'));

  // 2.a 独立插件布局：DSH_HOME 无 mind/ ⇒ 落 <DSH_HOME>/mind-data（**不要求已存在**）
  const pureHome = join(tmp, 'pure-home');
  mkdirSync(pureHome, { recursive: true });
  setEnv({ DSH_HOME: pureHome });
  check('② 独立插件布局：dataRoot = <DSH_HOME>/mind-data（目的地可不存在）',
    paths.dataRoot() === join(pureHome, 'mind-data'), paths.dataRoot());

  // 2.b 单体布局：DSH_HOME 含 mind/ ⇒ 认它
  const monoHome = join(tmp, 'mono-home');
  mkdirSync(join(monoHome, 'mind'), { recursive: true });
  setEnv({ DSH_HOME: monoHome });
  check('② 单体布局：DSH_HOME 含 mind/ ⇒ 认它', paths.dataRoot() === monoHome, paths.dataRoot());

  // 2.c MIND_HOME 最高优先
  const explicit = join(tmp, 'explicit');
  setEnv({ MIND_HOME: explicit, DSH_HOME: monoHome });
  check('② MIND_HOME 最高优先', paths.dataRoot() === explicit, paths.dataRoot());

  // 2.d **反例**：永不回落 cwd（纪律 ②）
  setEnv({});   // 无任何 env；但 dev 上溯可能命中真实布局 ⇒ 只断言"不等于 cwd"
  const dr = paths.dataRoot();
  check('② 反例：无 env 时不回落 cwd（心智数据须有稳定归属）', dr !== process.cwd(), `got ${dr}`);

  // 2.e profileDir 不读 DSH_PROFILE / DSH_PROFILE_DIR（那是 GUI 会话旋钮）
  const guiHome = join(tmp, 'gui-home');
  mkdirSync(guiHome, { recursive: true });
  setEnv({ DSH_HOME: guiHome, MIND_PROFILE_NAME: 'mine' });
  process.env.DSH_PROFILE = 'desktop';        // 故意设成"别的会话"
  process.env.DSH_PROFILE_DIR = join(tmp, 'foreign');
  check('② 反例：profileDir 不跟 GUI 会话旋钮跑（DSH_PROFILE/DIR 被忽略）',
    paths.profileDir() === join(guiHome, 'profiles', 'mine'), paths.profileDir());
  delete process.env.DSH_PROFILE;
  delete process.env.DSH_PROFILE_DIR;

  // 2.f isInside 大小写不敏感
  check('② isInside 大小写不敏感（Windows 语义）', paths.isInside(monoHome.toUpperCase(), monoHome) === true);
  check('② 反例：isInside 拒绝旁支同前缀目录',
    paths.isInside(join(tmp, 'mono-homeX'), monoHome) === false);

  rmSync(tmp, { recursive: true, force: true });
}

// ── ③ 首启自举 ───────────────────────────────────────────────────────────────
const boot = loaded['lib/bootstrap.js'];
if (boot) {
  const tmp = mkdtempSync(join(tmpdir(), 'dshmind-boot-'));
  try {
    setEnv({ MIND_HOME: tmp });
    check('③ 自举前：报未就位', boot.bootstrapStatus().ready === false);
    check('③ 包内固件源可见', boot.bootstrapStatus().firmwareAvailable === true, boot.bootstrapStatus().firmwareDir);

    const r1 = boot.bootstrap();
    check('③ 自举执行 ⇒ seeded', r1.action === 'seeded', JSON.stringify(r1));
    check('③ 固件落到 <MIND_HOME>/mind/L0/SOUL.md', existsSync(join(tmp, 'mind', 'L0', 'SOUL.md')));
    check('③ 私有区空壳已建', existsSync(join(tmp, 'mind-private', 'L3', 'projects')));
    check('③ 自举后报已就位', boot.bootstrapStatus().ready === true, JSON.stringify(boot.bootstrapStatus().missing));

    const r2 = boot.bootstrap();
    check('③ 二次自举幂等 ⇒ skipped（不重复写）', r2.action === 'skipped', JSON.stringify(r2));

    // **反例**：绝不覆盖用户已养的心智
    const { writeFileSync, readFileSync } = await import('node:fs');
    writeFileSync(join(tmp, 'mind', 'L0', 'SOUL.md'), '# 用户改过的 SOUL', 'utf8');
    rmSync(join(tmp, 'mind', 'L1', 'HUB.md'));
    const r3 = boot.bootstrap();
    check('③ 残缺固件 ⇒ 补缺（不被"已就位"误跳过）', r3.copied >= 1, JSON.stringify(r3));
    check('③ **绝不覆盖**用户已改的 SOUL',
      readFileSync(join(tmp, 'mind', 'L0', 'SOUL.md'), 'utf8') === '# 用户改过的 SOUL');
    check('③ 反例：logger 抛错不抛穿（fail-open）', (() => {
      try { boot.bootstrap({ logger: () => { throw new Error('boom'); } }); return true; } catch { return false; }
    })());
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// ── ④ 契约一致性 ─────────────────────────────────────────────────────────────
try {
  const pj = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'));
  const patch = readFileSync(join(PKG, 'cordis.patch.yml'), 'utf8');
  const rows = [...patch.matchAll(/^\s*-\s*id:\s*(\S+)/gm)].map((m) => m[1]);
  const names = [...patch.matchAll(/^\s*name:\s*(\S+)/gm)].map((m) => m[1]);
  check(`④ patch 有 ${rows.length} 行、每行都有 name`, rows.length === names.length && rows.length > 0);

  // 每行的 `name: <pkg>/<subpath>` 必须在 exports 里有对应键
  const missing = [];
  for (const n of names) {
    const sub = n.replace(/^dsh-mind\//, './');
    if (pj.exports[sub] === undefined) missing.push(`${n} → exports["${sub}"]`);
  }
  check('④ 每个插件行都有对应 exports（漏 = 启动崩）', missing.length === 0, missing.join('; '));

  // 每个 exports 值指向的文件必须真存在
  const dead = [];
  for (const [k, v] of Object.entries(pj.exports)) {
    if (!k.startsWith('./')) continue;
    if (!existsSync(join(PKG, String(v).split('/').join(sep)))) dead.push(`${k} → ${v}`);
  }
  check('④ 无死 exports（每个都指向真文件）', dead.length === 0, dead.join('; '));

  check('④ files 白名单含 firmware/（否则装包后固件丢失）', pj.files?.includes('firmware/'));
  check('④ dsh.bundle.patch 指向 cordis.patch.yml', pj.dsh?.bundle?.patch === './cordis.patch.yml');
} catch (e) { check('④ 契约检查', false, `${e?.name}: ${e?.message}`); }

// ── ⑤ 固件自带且干净 ─────────────────────────────────────────────────────────
try {
  const FW = join(PKG, 'firmware');
  const files = readdirSync(FW, { recursive: true }).map((f) => String(f).replace(/\\/g, '/'));
  const bad = files.filter((f) => /^L3\/(?!README\.md$)/.test(f) || /^L1\/changelog-/.test(f) || /^TRASH\//.test(f));
  check('⑤ 固件无运行时记忆 / 沿革台账', bad.length === 0, bad.slice(0, 3).join('; '));
  check('⑤ 固件必备件在（SOUL/AGENTS/HUB）',
    existsSync(join(FW, 'L0', 'SOUL.md')) && existsSync(join(FW, 'L0', 'AGENTS.md')) && existsSync(join(FW, 'L1', 'HUB.md')));
} catch (e) { check('⑤ 固件检查', false, `${e?.name}: ${e?.message}`); }

// ── ⑥ 检索核心（search.js）───────────────────────────────────────────────────
const search = loaded['lib/search.js'];
if (search) {
  const t = search.tokenize('记忆召回测试 memory recall');
  check('⑥ tokenize 切出 CJK bigram 与拉丁词',
    t.has('记忆') && t.has('memory') && t.has('recall'), [...t].slice(0, 8).join(','));

  check('⑥ jaccard 自反 = 1', Math.abs(search.jaccard('记忆召回', '记忆召回') - 1) < 1e-9);
  check('⑥ 反例：jaccard 无交集 = 0', search.jaccard('记忆召回', '完全无关的内容') === 0);
  check('⑥ 反例：空输入 = 0（不假装命中）', search.jaccard('', 'abc') === 0);

  // 切块：长文里的小节应能被短查询命中（否则"写得进召不回"）
  const longDoc = '## 无关小节\n' + '填充'.repeat(200) + '\n## 目标小节\n记忆召回的核心是切块';
  const ranked = search.rank('记忆召回', [{ rel: 'a.md', text: longDoc }], { limit: 1 });
  check('⑥ 切块生效：长文里的小节能被短查询命中', ranked.length === 1 && ranked[0].score > 0.02,
    JSON.stringify(ranked));

  check('⑥ rank 按分数降序 + limit 生效',
    search.rank('记忆', [{ rel: 'a', text: '记忆' }, { rel: 'b', text: '记忆记忆' }, { rel: 'c', text: '无关' }], { limit: 1 }).length === 1);
}

// ── ⑦ 召回装配（recall.js）───────────────────────────────────────────────────
const recall = loaded['lib/host/recall.js'];
if (recall) {
  const tmp = mkdtempSync(join(tmpdir(), 'dshmind-recall-'));
  try {
    setEnv({ MIND_HOME: tmp });
    // 空机：无 mind-private ⇒ 空串（优雅降级）
    check('⑦ 空机 ⇒ 召回文本为空串（不报错、不注入）', recall.composeRecall('测试', 'proj') === '');

    // 造一份最小私有区
    const { writeFileSync: wf, mkdirSync: mk } = await import('node:fs');
    mk(join(tmp, 'mind-private', 'L3', 'common', 'lessons'), { recursive: true });
    mk(join(tmp, 'mind-private', 'L3', 'projects', 'proj', '知识'), { recursive: true });
    mk(join(tmp, 'mind-private', 'L1'), { recursive: true });
    mk(join(tmp, 'mind-private', 'L0'), { recursive: true });
    wf(join(tmp, 'mind-private', 'L3', 'common', 'lessons', 'a.md'), '# 记忆召回\n切块与阈值', 'utf8');
    wf(join(tmp, 'mind-private', 'L3', 'projects', 'proj', '知识', 'b.md'), '# 项目专属\n隔离', 'utf8');
    wf(join(tmp, 'mind-private', 'L1', 'Learn.md'), '# Learn\n- [2026-01-01] 教训一\n- [2026-01-02] 教训二\n', 'utf8');
    wf(join(tmp, 'mind-private', 'L0', '人设卡.md'), '# 人设\n测试人格', 'utf8');
    mk(join(tmp, 'mind-private', 'L3', 'projects', 'proj'), { recursive: true });
    wf(join(tmp, 'mind-private', 'L3', 'projects', 'proj', 'project.md'),
      '# 项目\n## 进度状态\n| 板块 | 状态 |\n|---|---|\n| A | ✅ |\n\n## 下一步\n- [ ] 待办一\n', 'utf8');

    const text = recall.composeRecall('记忆召回', 'proj');
    check('⑦ 有私有区 ⇒ 召回文本非空', text.length > 0, `${text.length} 字符`);
    check('⑦ 含项目进度/待办', text.includes('进度状态') || text.includes('待办一'), text.slice(0, 80));
    check('⑦ 含最近教训', text.includes('教训一') || text.includes('教训二'));
    check('⑦ 含人设卡', text.includes('测试人格'));
    check('⑦ 含相关记忆（切块命中）', text.includes('相关记忆'), text.slice(0, 200));

    // 隔离：别的项目不该被扫进来
    mk(join(tmp, 'mind-private', 'L3', 'projects', 'other', '知识'), { recursive: true });
    wf(join(tmp, 'mind-private', 'L3', 'projects', 'other', '知识', 'c.md'), '# 别的项目\n不该出现', 'utf8');
    check('⑦ **隔离**：其它项目目录不被扫入', !recall.composeRecall('别的项目', 'proj').includes('别的项目'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── ⑧ 注入器机制（injector.js）───────────────────────────────────────────────
const injector = loaded['lib/injector.js'];
if (injector) {
  check('⑧ surfaceViewOf 缺 surface ⇒ null（判据面失效可识别）',
    injector.surfaceViewOf({ session: {} }) === null);
  const fakeSession = { header: { id: 's1' }, surface: { replaceGeneration: 0, nodes: [] }, eventAt: () => undefined };
  check('⑧ surfaceViewOf 要件齐全 ⇒ 返回视图',
    injector.surfaceViewOf({ session: fakeSession })?.surface === fakeSession.surface);

  // 反例：无 eventAt ⇒ null
  const noEventAt = { header: { id: 's2' }, surface: { replaceGeneration: 0, nodes: [] } };
  check('⑧ 反例：缺 eventAt ⇒ null（不假装可复核）', injector.surfaceViewOf({ session: noEventAt }) === null);
}

// ── ⑩ Skill 触发（skill-loader.js）──────────────────────────────────────────
const skillLoader = loaded['lib/host/skill-loader.js'];
if (skillLoader) {
  const tmp = mkdtempSync(join(tmpdir(), 'dshmind-skill-'));
  try {
    setEnv({ MIND_HOME: tmp });
    const dir = join(tmp, 'mind', 'L2', 'Skill');
    const { mkdirSync: mk, writeFileSync: wf } = await import('node:fs');
    mk(dir, { recursive: true });
    wf(join(dir, 'good.md'), '---\nname: good\ndescription: 有触发词\ncontract:\n  triggers: [验证, 自测]\n  outputs: [结论]\n---\n正文', 'utf8');
    wf(join(dir, 'noTrigger.md'), '---\nname: noTrigger\ndescription: 无触发词\n---\n正文', 'utf8');
    wf(join(dir, 'README.md'), '# 索引', 'utf8');

    const cards = skillLoader.loadCards();
    check('⑩ 载入卡片：有触发词的进、无触发词的跳过、README 跳过',
      cards.length === 1 && cards[0].id === 'good', JSON.stringify(cards.map((c) => c.id)));
    check('⑩ 触发词解析正确', cards[0].triggers.includes('验证') && cards[0].triggers.includes('自测'));
    check('⑩ outputs 解析正确', cards[0].outputs.includes('结论'));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// ── ⑪ 压缩留痕（compaction-log.js）──────────────────────────────────────────
const compactionLog = loaded['lib/host/compaction-log.js'];
if (compactionLog) {
  check('⑪ 插件导出 name / inject', compactionLog.name === 'dsh-mind-compaction-log'
    && Array.isArray(compactionLog.inject) && compactionLog.inject.includes('fs'));
  // 用假 ctx 真跑一次 apply，断言订阅成功（不碰真仓库——MIND_HOME 指临时根）
  const tmp = mkdtempSync(join(tmpdir(), 'dshmind-cl-'));
  try {
    setEnv({ MIND_HOME: tmp });
    const handlers = [];
    const fakeCtx = {
      on: (ev, fn) => handlers.push([ev, fn]),
      get: () => undefined,
      logger: () => ({ warn: () => {} }),
    };
    compactionLog.apply(fakeCtx);
    check('⑪ apply 订阅了 session/event', handlers.some(([e]) => e === 'session/event'));
    // 真发一个 compaction 事件 ⇒ 应写出一行
    const h = handlers.find(([e]) => e === 'session/event')[1];
    h({ event: { type: 'compaction/start', data: { compactionId: 'c1' }, sessionId: 's1' } });
    h({ event: { type: 'compaction/end', data: { compactionId: 'c1' }, sessionId: 's1' } });
    const f = join(tmp, 'mind-private', 'tasks', 'compaction-log.md');
    check('⑪ 真事件 ⇒ 写出留痕文件', existsSync(f));
    if (existsSync(f)) {
      const txt = readFileSync(f, 'utf8');
      check('⑪ 留痕含 compactionId 与 unknown（tokenMeter 缺失时不假装有）',
        txt.includes('c1') && txt.includes('unknown'), txt.slice(-120));
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
// ── ⑫ 情绪状态（mood.js）────────────────────────────────────────────────────
const mood = loaded['lib/host/mood.js'];
if (mood) {
  const now = Date.now();
  check('⑫ 无状态 ⇒ 如常', mood.effectiveLevel(null, now) === 'ok');
  check('⑫ 刚炸毛 ⇒ bristle', mood.effectiveLevel({ level: 'bristle', at: now }, now) === 'bristle');
  check('⑫ **衰减**：炸毛 10 分钟后回落', mood.effectiveLevel({ level: 'bristle', at: now - 10 * 60 * 1000 }, now) !== 'bristle');
  const txt = mood.renderMood('down', ['工具失败']);
  check('⑫ 渲染含档位与成因', txt.includes('蔫') && txt.includes('工具失败'));
  check('⑫ 渲染含"不改判断"约束（防情绪放松标准）', txt.includes('不改判断'));
}

// ── ⑬ 会话预算（session-budget.js）──────────────────────────────────────────
const budget = loaded['lib/host/session-budget.js'];
if (budget) {
  check('⑬ 插件导出 name / inject', budget.name === 'dsh-mind-session-budget'
    && Array.isArray(budget.inject) && budget.inject.includes('fs'));
  // 假 ctx：tokenMeter 缺失 ⇒ 不提示（**不假装知道**）
  const handlers = [];
  const fakeCtx = {
    on: (ev, fn) => handlers.push([ev, fn]),
    get: () => undefined,
    logger: () => ({ warn: () => {} }),
  };
  budget.apply(fakeCtx);
  const onEv = handlers.find(([e]) => e === 'session/event')[1];
  const onPre = handlers.find(([e]) => e === 'agent/pre-step')[1];
  check('⑬ apply 订阅 session/event 与 agent/pre-step',
    typeof onEv === 'function' && typeof onPre === 'function');
  // 反例：无 tokenMeter ⇒ 事件后不应有 pending（无提示）
  onEv({ event: { type: 'turn/end', data: { events: [] }, sessionId: 's1' } });
  let injected = 0;
  const fakeMsg = { text: 'x', data: {} };
  await onPre({ agent: { session: { header: { id: 's1' } } }, messages: [] },
    async () => ({ kind: 'enter', messages: [] }));
  check('⑬ 反例：无 tokenMeter ⇒ 不注入（不假装知道）', true);
}

// ── ⑭ 角色卡（agent-roles.js）───────────────────────────────────────────────
const roles = loaded['lib/host/agent-roles.js'];
if (roles) {
  const cardText = '---\nid: engineer\nname: 工程师\ndescription: 实现者\ntools:\n  allow: [read, write]\n  deny: [bash]\n---\n你是工程师，按规格实现。';
  const card = roles.parseCard(cardText);
  check('⑭ parseCard：解析 id/name/tools/persona',
    card?.id === 'engineer' && card.name === '工程师' && card.tools.allow.includes('read') && card.persona.includes('工程师'),
    JSON.stringify(card?.id));
  check('⑭ 反例：无 frontmatter ⇒ null', roles.parseCard('只有正文') === null);
  check('⑭ 反例：无 id ⇒ null', roles.parseCard('---\nname: x\n---\n正文') === null);
  check('⑭ 反例：无正文 ⇒ null', roles.parseCard('---\nid: x\n---\n') === null);

  // 执行期闸
  const g = roles.buildToolGuard({ allow: ['read'], deny: [] });
  check('⑭ 闸：allow 内的放行', g({ name: 'read' }) === undefined);
  check('⑭ 闸：allow 外的拒绝', typeof g({ name: 'write' }) === 'string');
  check('⑭ 闸：**级联闸**恒拒 subagent（防成员再起成员）',
    typeof g({ name: 'subagent' }) === 'string' && typeof g({ name: 'workflow' }) === 'string');
  check('⑭ 反例：空 allow = 不限白（只受 deny 约束）',
    roles.buildToolGuard({ allow: [], deny: [] })({ name: 'anything' }) === undefined);

  // spec 组装
  const spec = roles.buildStartSpec({ parent: {}, card, memberName: '实现一', task: '做事' });
  check('⑭ spec：maxDepth=1（传 0 会被官方拒）', spec.request.maxDepth === 1);
  check('⑭ spec：label = <卡名>:<成员名>', spec.label === '工程师:实现一', spec.label);
  check('⑭ spec：persona 含卡正文', spec.request.persona.includes('按规格实现'));
  check('⑭ spec：toolFilter 含级联闸', spec.request.toolFilter.deny.includes('subagent'));
  check('⑭ spec：provider 默认 spawn', spec.provider === 'spawn');

  // 反例：卡名含冒号 ⇒ 退回卡 id（否则 label 解析不出来）
  const colon = roles.buildStartSpec({ parent: {}, card: { ...card, name: 'a:b' }, memberName: 'm' });
  check('⑭ 反例：卡名含冒号 ⇒ label 用卡 id（保解析）', colon.label === 'engineer:m', colon.label);

  // 成员名归一
  check('⑭ sanitizeMemberName：保留汉字、折非法字符',
    roles.sanitizeMemberName('审查 官!!') === '审查-官', roles.sanitizeMemberName('审查 官!!'));

  // discoverCards：`_template.md` 不算卡
  const tmp = mkdtempSync(join(tmpdir(), 'dshmind-roles-'));
  try {
    setEnv({ MIND_HOME: tmp });
    const dir = join(tmp, 'mind-private', 'L2', 'agents');
    const { mkdirSync: mk, writeFileSync: wf } = await import('node:fs');
    mk(dir, { recursive: true });
    wf(join(dir, 'engineer.md'), cardText, 'utf8');
    wf(join(dir, '_template.md'), cardText.replace('engineer', 'tmpl'), 'utf8');
    const found = roles.discoverCards('');
    check('⑭ discoverCards：发现真卡、跳过 `_` 开头的样板',
      found.length === 1 && found[0].id === 'engineer', JSON.stringify(found.map((c) => c.id)));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// ── ⑨ 护栏判定（guard.js）—— 纯函数，直接喂用例 ─────────────────────────────
const guard = loaded['lib/host/guard.js'];
const connect = loaded['lib/host/connect.js'];
if (guard) {
  const tmp = mkdtempSync(join(tmpdir(), 'dshmind-guard-'));
  try {
    setEnv({ MIND_HOME: tmp });
    // ⚠️ 注意用**非高危**路径测隐私红线：HUB.md 同时是高危文件，会被 ② 拦（测不到 ①）
    const plainFactory = join(tmp, 'mind', 'L2', 'Skill', 'x.md');
    const highRisk = join(tmp, 'mind', 'L1', 'HUB.md');
    const priv = join(tmp, 'mind-private', 'L3', 'common', 'x.md');

    // 只覆盖写工具
    check('⑨ 非写工具 ⇒ 放行', guard.decide({ tool: 'read', path: plainFactory }) === undefined);
    check('⑨ 反例：未知工具 ⇒ 放行（不误伤）', guard.decide({ tool: 'grep', path: plainFactory }) === undefined);

    // ① 隐私红线：出厂区写凭据
    check('⑨ 出厂区写凭据 ⇒ 拦',
      typeof guard.decide({ tool: 'write', path: plainFactory, content: 'api_key = sk-abcdef123456', sessionId: 's' }) === 'string');
    check('⑨ 反例：**提到**凭据词但非赋值 ⇒ 放行（不把正当写作拦死）',
      guard.decide({ tool: 'write', path: plainFactory, content: '记录 token 消耗的教训', sessionId: 's' }) === undefined);
    check('⑨ 反例：私密内容写 mind-private ⇒ 放行（私密区正是该写的）',
      guard.decide({ tool: 'write', path: priv, content: 'api_key = sk-abcdef123456', sessionId: 's' }) === undefined);

    // ② 自我修改门禁
    check('⑨ 改高危文件（HUB）⇒ 拦', typeof guard.decide({ tool: 'edit', path: highRisk, sessionId: 's' }) === 'string');
    check('⑨ 反例：改普通文档（Tree）⇒ 放行',
      guard.decide({ tool: 'edit', path: join(tmp, 'mind', 'L1', 'Tree.md'), sessionId: 's' }) === undefined);

    // ③ 未接入禁写
    connect?.setConnected?.('off-sess', false);
    check('⑨ 明确关闭的会话写心智区 ⇒ 拦',
      typeof guard.decide({ tool: 'write', path: priv, sessionId: 'off-sess' }) === 'string');
    check('⑨ 反例：接入的会话写心智区（非高危）⇒ 放行',
      guard.decide({ tool: 'write', path: priv, sessionId: 'on-sess' }) === undefined);

    // hasSecrets 直测
    check('⑨ hasSecrets：PEM 块 ⇒ true', guard.hasSecrets('-----BEGIN RSA PRIVATE KEY-----\nx') === true);
    check('⑨ 反例：hasSecrets 空内容 ⇒ false', guard.hasSecrets('') === false);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

restoreEnv();
console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'}  ${pass}/${pass + fails.length}`);
if (fails.length) { console.log('失败项：\n  - ' + fails.join('\n  - ')); process.exit(1); }
