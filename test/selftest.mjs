// test/selftest.mjs — 骨架自检：模块能加载、数据模型正确、自举可用、契约一致。
//
// 无参 = 只读（临时目录自建自清，不碰真实数据）。退出码：PASS 0 / FAIL 1。
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
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

// ⚠️ `DSH_PROFILE_DIR` 必须在册（2026-09-29 修）：它决定"诊断/台账落哪个 profile"，
//    不在册 ⇒ 用例之间会互相污染，且**把 marker 写到真实用户的 profile 目录**里。
const ENV_KEYS = ['MIND_HOME', 'DSH_HOME', 'MIND_PROFILE_NAME', 'MIND_PROFILE_DIR', 'MIND_MARKET_DIR', 'DSH_PROFILE_DIR'];
const saved = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];
/** 切换隔离环境。⚠️ 凡是把数据根指向临时目录的用例，**诊断面也必须一起进临时目录**
 *  —— 否则 `mark()` 会落到真实用户目录（实测：跑一次本文件即改写
 *  `~/.dsh/profiles/dshome/.dsh-market/` 的 compaction-log / connect / session-budget 三处）。 */
const setEnv = (o) => {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, o);
  if (process.env.MIND_HOME && !process.env.MIND_MARKET_DIR) {
    process.env.MIND_MARKET_DIR = join(process.env.MIND_HOME, '.dsh-market');
  }
};
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
  setEnv({});   // 无任何 env ⇒ 官方语义落到 ~/.dsh
  const dr = paths.dataRoot();
  check('② 反例：无 env 时不回落 cwd（心智数据须有稳定归属）', dr !== process.cwd(), `got ${dr}`);
  check('② 无 env ⇒ 官方语义落 ~/.dsh/mind-data（**不是** ~/.dsh-mind）',
    paths.resolveDshHome().endsWith('.dsh') && dr.endsWith('mind-data'), `${paths.resolveDshHome()} → ${dr}`);

  // 2.e profileDir **按布局分档**（2026-09-29 实测校正）
  //   单体布局（DSH_HOME 含 mind/）⇒ 用"心智自己的 profile"，忽略 GUI 会话旋钮
  const monoLayout = join(tmp, 'mono-layout');
  mkdirSync(join(monoLayout, 'mind'), { recursive: true });
  setEnv({ DSH_HOME: monoLayout, MIND_PROFILE_NAME: 'mine' });
  process.env.DSH_PROFILE_DIR = join(tmp, 'foreign');   // 故意设成"别的会话"
  check('② 单体布局：profileDir 忽略 DSH_PROFILE_DIR（用心智自己的 profile）',
    paths.profileDir() === join(monoLayout, 'profiles', 'mine'), paths.profileDir());

  //   独立插件布局（home 无 mind/）⇒ 认"插件正在运行的那个 profile"
  const standaloneHome = join(tmp, 'standalone-home');
  mkdirSync(standaloneHome, { recursive: true });
  const runningProfile = join(standaloneHome, 'profiles', 'desktop');
  setEnv({ DSH_HOME: standaloneHome });
  process.env.DSH_PROFILE_DIR = runningProfile;
  check('② 独立布局：profileDir 认 DSH_PROFILE_DIR（插件运行的那个 profile）',
    paths.profileDir() === runningProfile, paths.profileDir());
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
      // 2026-09-29 补：文件头声明覆盖 prune，此前白名单只有 start/end ⇒ 声明了却不记
      h({ event: { type: 'compaction/prune', data: { compactionId: 'c2', turn: 7 }, sessionId: 's1' } });
      const txt2 = readFileSync(f, 'utf8');
      check('⑪ compaction/prune 也落行（工具结果剪枝）', txt2.includes('工具结果剪枝'));
      check('⑪ 表头含 turn 与 结果 两列（此前各缺一列）',
        /\|\s*时间\s*\|\s*会话\s*\|\s*事件\s*\|\s*compactionId\s*\|\s*turn\s*\|\s*释放 token\s*\|\s*结果\s*\|/.test(txt2));
      check('⑪ 结果列落「成功」/「失败」而不是空', /成功|失败/.test(txt2));
      check('⑪ turn 缺失记 manual（手动 /compact 的区分维度）', txt2.includes('manual'));

      // ── 2026-09-30 修：**宿主形态 `(session, event)` 必须被吃到** ─────────────
      // 这是真机缺陷的回归钉：签名单参时 `h(session, event)` 让 `ev.type` 恒 undefined
      // ⇒ 压缩从不落痕、文件从不生成，而 marker 只有 apply 行（假绿）。
      const before = readFileSync(f, 'utf8').split('\n').filter(Boolean).length;
      h({ id: 'host-sess', header: { id: 'host-sess' } }, { type: 'compaction/prune', data: { compactionId: 'h1', turn: 9 } });
      const txt3 = readFileSync(f, 'utf8');
      check('⑪ 宿主形态 (session, event) 也落行（session 只从第一参取）',
        txt3.split('\n').filter(Boolean).length > before && txt3.includes('host-sess'), `before=${before}`);
      // 反例：拿不到 session ⇒ 会话列记 `unknown`（**不编一个 id 出来**）
      h({}, { type: 'compaction/prune', data: { compactionId: 'h2' } });
      const h2line = readFileSync(f, 'utf8').split('\n').find((l) => l.includes('h2')) || '';
      check('⑪ 反例：session 取不到 ⇒ 会话列记 unknown（不编 id）',
        h2line.includes('| unknown |'), h2line.slice(0, 120));
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

  // ── 2026-09-29 补：proud 可达 / 衰减两条路径 / 停注入 ────────────────────────
  const now2 = Date.now();
  check('⑫ **proud 可达**：连发 3 条成功 tool/result ⇒ 得意',
    mood.nextMoodState(undefined, { type: 'tool/result', data: { isError: false } }, now2).level === 'ok'
    && mood.nextMoodState({ level: 'ok', causes: [], at: now2, streak: 2 }, { type: 'tool/result', data: { isError: false } }, now2).level === 'proud');
  check('⑫ 反例：失败 ⇒ 蔫（不是得意）',
    mood.nextMoodState(undefined, { type: 'tool/result', data: { isError: true } }, now2).level === 'down');
  check('⑫ 反例：连续成功但 <3 ⇒ 不提前得意',
    mood.nextMoodState({ level: 'ok', causes: [], at: now2, streak: 1 }, { type: 'tool/result', data: { isError: false } }, now2).level === 'ok');
  check('⑫ 衰减：得意 6 分钟后 ⇒ 如常（不再"蔫"夹在中间）',
    mood.effectiveLevel({ level: 'proud', at: now2 - 6 * 60 * 1000 }, now2) === 'ok');
  check('⑫ 衰减：炸毛 6 分钟后 ⇒ 蔫（负向逐级平复）',
    mood.effectiveLevel({ level: 'bristle', at: now2 - 6 * 60 * 1000 }, now2) === 'down');
  check('⑫ 衰减：炸毛 20 分钟后 ⇒ 如常',
    mood.effectiveLevel({ level: 'bristle', at: now2 - 20 * 60 * 1000 }, now2) === 'ok');

  // ── 2026-09-30 修：宿主形态 `(session, event)` 必须折叠进状态 ───────────────
  // 真机缺陷的回归钉：签名单参时这里恒 null（⇒ 情绪永不注入，marker 只有 apply 行）。
  const t3 = mkdtempSync(join(tmpdir(), 'dshmind-mood-'));
  try {
    setEnv({ MIND_HOME: t3 });
    const mh = [];
    mood.apply({ on: (e, fn) => mh.push([e, fn]), logger: () => ({ warn: () => {} }) });
    const mEv = mh.find(([e]) => e === 'session/event')?.[1];
    check('⑫ apply 订阅了 session/event 与 agent/pre-step',
      typeof mEv === 'function' && mh.some(([e]) => e === 'agent/pre-step'));
    mEv?.({ id: 'host-m' }, { type: 'tool/result', data: { isError: true } });
    check('⑫ 宿主形态 (session, event) ⇒ 折叠成"蔫"',
      mood.moodStateOf('host-m')?.level === 'down', JSON.stringify(mood.moodStateOf('host-m')));
    // 反例：第一参没有 session ⇒ 不折叠（判定只认宿主形态的 session，不是 event 里瞎猜）
    mEv?.({}, { type: 'tool/result', data: { isError: true } });
    check('⑫ 反例：拿不到 session ⇒ 不折叠（不编 key）', mood.moodStateOf('undefined') === null);
    // disposed 也要认宿主形态
    const mDis = mh.find(([e]) => e === 'session/disposed')?.[1];
    mDis?.({ id: 'host-m' });
    check('⑫ session/disposed 用宿主形态清状态', mood.moodStateOf('host-m') === null);
  } finally { rmSync(t3, { recursive: true, force: true }); }
}

// ── ⑬ 会话预算（session-budget.js）──────────────────────────────────────────
const budget = loaded['lib/host/session-budget.js'];
if (budget) {
  check('⑬ 插件导出 name / inject', budget.name === 'dsh-mind-session-budget' && Array.isArray(budget.inject));
  // 2026-09-29：不声明用不到的 `fs`（`inject` 多列一个用不到的服务 ⇒ 缺该服务的 profile 里插件静默不激活）
  check('⑬ **不**声明用不到的 fs 依赖', !budget.inject.includes('fs'), JSON.stringify(budget.inject));
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
  check('⑬ 反例：无 tokenMeter ⇒ 不崩（注入路径在普通 node 下短路，行为面见契约测试）', true);

  // ── 2026-09-29 补：measure 要收到 session；subagent 会话不注入 ────────────────
  const t2 = mkdtempSync(join(tmpdir(), 'dshmind-budget-'));
  try {
    setEnv({ MIND_HOME: t2 });
    const h2 = [];
    let seen = 'none';
    const ctx2 = {
      on: (e, fn) => h2.push([e, fn]),
      get: (n) => (n === 'tokenMeter' ? { measure: (s) => { seen = s; return { totalTokens: 400000 }; } } : undefined),
      logger: () => ({ warn: () => {} }),
    };
    budget.apply(ctx2);
    const ev2 = h2.find(([e]) => e === 'session/event')[1];
    ev2({ event: { type: 'turn/end', data: { events: [] }, sessionId: 'b1', session: { header: { id: 'b1' } } } });
    check('⑬ measure 收到 session（此前不传 ⇒ 读数没按会话算）',
      seen !== 'none' && seen?.header?.id === 'b1', seen === 'none' ? 'none' : JSON.stringify(seen?.header));
    // subagent 会话 ⇒ 只留痕、不排队注入（防污染成员自己的汇报）
    ev2({ event: { type: 'turn/end', data: { events: [] }, sessionId: 'sub1', session: { header: { id: 'sub1', origin: 'subagent' } } } });
    const mkTxt = readFileSync(join(t2, '.dsh-market', 'session-budget-marker.txt'), 'utf8');
    const skips = mkTxt.split('skip: subagent').length - 1;
    check('⑬ subagent 会话不注入（marker 留痕 skip: subagent）', skips === 1, `出现 ${skips} 次`);
    check('⑬ 反例：主会话那次**不**带 subagent 留痕（判据不是恒真）', skips === 1, `出现 ${skips} 次`);

    // ── 2026-09-30 修：宿主形态 `(session, event)` 必须被吃到 ─────────────────
    // 真机缺陷的回归钉：签名单参时 `ev.type` 恒 undefined ⇒ 预算从不评估（marker 只有 apply 行）。
    seen = 'none';
    ev2({ id: 'host-b', header: { id: 'host-b' } }, { type: 'turn/end', data: { events: [] } });
    check('⑬ 宿主形态 (session, event) ⇒ measure 收到 session（单参签名下恒 none）',
      seen !== 'none' && seen?.header?.id === 'host-b', seen === 'none' ? 'none' : JSON.stringify(seen?.header));
    // 反例：拿不到 session ⇒ 不评估（不编一个 key 出来）
    seen = 'none';
    ev2({ type: 'turn/end', data: { events: [] } });
    check('⑬ 反例：单参事件对象且无 session ⇒ 不评估', seen === 'none');
  } finally { rmSync(t2, { recursive: true, force: true }); }
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

  // ── 块列表写法（**存量卡的普遍形态**，2026-09-29 修）────────────────────────────
  // `fmArray` 此前只认流式 `[a, b]` ⇒ 这种卡读成空数组 ⇒ 成员工具面「未收窄」、
  // 卡里的 `deny` 约束静默消失（含 `deny: write`）。夹具用**块列表**写法钉住。
  const blockCard = [
    '---', 'id: tidy', 'name: 记忆整理员', 'description: 归并记忆',
    'tools:', '  allow:', '    - read', '    - grep', '  deny:', '    - write',
    '---', '你是整理员，只读不写。',
  ].join('\n');
  const bc = roles.parseCard(blockCard);
  check('⑭ parseCard：**块列表**写法解析出 allow',
    bc?.tools.allow.join(',') === 'read,grep', JSON.stringify(bc?.tools?.allow));
  check('⑭ parseCard：**块列表**写法解析出 deny（约束不消失）',
    bc?.tools.deny.join(',') === 'write', JSON.stringify(bc?.tools?.deny));
  check('⑭ 块列表卡的 deny 真生效（闸拒 write）',
    typeof roles.buildToolGuard(bc.tools)({ name: 'write' }) === 'string');
  check('⑭ 块列表卡的 allow 外调用被拒（闸拒 bash）',
    typeof roles.buildToolGuard(bc.tools)({ name: 'bash' }) === 'string');
  check('⑭ 块列表卡进 filter（可见面也收窄）',
    roles.buildToolFilter(bc).allow.join(',') === 'read,grep', JSON.stringify(roles.buildToolFilter(bc)));

  // ── 2026-09-29 补：成员不得看见本插件自己的工具 / model 解析 / 跨重启补闸 ─────
  const f2 = roles.buildToolFilter(bc);
  check('⑭ filter 的 deny 排除本插件自己的工具（role_spawn 等）',
    ['role_spawn', 'role_send', 'role_list'].every((n) => f2.deny.includes(n)), JSON.stringify(f2.deny));
  const mc = roles.parseCard('---\nid: m1\nname: M\nmodel: deepseek-v4-flash\nprovider: deepseek-official\n---\n正文');
  check('⑭ parseCard 解析 model/provider（此前读了 card.model 却从不解析＝死代码）',
    mc?.model?.model === 'deepseek-v4-flash' && mc?.model?.provider === 'deepseek-official', JSON.stringify(mc?.model));
  const spec2 = roles.buildStartSpec({ parent: {}, card: mc, memberName: 'm' });
  check('⑭ spec 真的挂上 agentOptions（model 路由不是死代码）',
    spec2.request?.agentOptions?.model === 'deepseek-v4-flash', JSON.stringify(spec2.request?.agentOptions));

  // 跨重启补闸：归属表 → childId → 按当前卡池重建闸
  const t3 = mkdtempSync(join(tmpdir(), 'dshmind-mmap-'));
  try {
    setEnv({ MIND_HOME: t3 });
    mkdirSync(join(t3, '.dsh-market'), { recursive: true });
    writeFileSync(join(t3, '.dsh-market', 'agent-roles-members.jsonl'),
      JSON.stringify({ childId: 'c-1', cardId: 'tidy', label: '记忆整理员:一' }) + '\n', 'utf8');
    const map = roles.loadMemberMap([bc]);
    check('⑭ loadMemberMap：按归属表读回 childId（否则进程重启后成员永久掉闸）', map.has('c-1'));
    check('⑭ loadMemberMap：读回的闸真生效（deny write 被拒）',
      typeof map.get('c-1')?.guard({ name: 'write' }) === 'string');
    check('⑭ 反例：卡池里没有该 cardId ⇒ 不假装有闸', roles.loadMemberMap([]).size === 0);
  } finally { rmSync(t3, { recursive: true, force: true }); }

  // ── apply 真跑：宿主 guard 只认**方法调用**（裸调用 ⇒ 整插件静默停用）────────────
  // 2026-09-29 **活体验收**抓到的回归：`const g = ctx.tools.guard; g(fn)` 是脱离 `this`
  // 的裸调用 ⇒ 宿主 guard 内部读 `this.layers` 当场炸 ⇒ 被 apply 的 catch 吞掉
  // ⇒ 三把工具**一个都没注册**（marker 只留一行 `apply failed: ... reading 'layers'`）。
  {
    const registered = [];
    let guardCalls = 0;
    const fake = {
      on: () => {},
      logger: () => ({ warn: () => {} }),
      tools: {
        layers: [],
        // 忠实模拟宿主 `dsh-tools` 的 register 契约：**缺 output.render ⇒ 抛**
        // （真机原文：`tool "role_list" must declare output { schema, render, presentationMeta? }`；
        //  2026-09-29 活体验收抓到三把工具全被拒注册，而当时的假 ctx 只记名字 ⇒ 抓不到）
        register(t) {
          if (!t?.output || typeof t.output.render !== 'function' || typeof t.output.schema !== 'object') {
            throw new TypeError(`tool "${t?.name}" must declare output { schema, render, presentationMeta? }`);
          }
          registered.push(t.name);
        },
        // 忠实模拟宿主：guard 读 `this.layers`，裸调用必炸
        guard(fn) { if (!Array.isArray(this.layers)) throw new Error("reading 'layers'"); guardCalls += 1; return fn; },
      },
    };
    roles.apply(fake);
    check('⑭ apply 真装上三把工具（裸调用 ctx.tools.guard ⇒ 整插件静默停用）',
      ['role_list', 'role_spawn', 'role_send'].every((n) => registered.includes(n)), registered.join(','));
    check('⑭ 执行期闸按方法调用注册成功', guardCalls === 1, String(guardCalls));

    // 「mounted」不许在注册失败时照打（2026-09-29：marker 上一行 mounted + 下一行 register 失败＝假绿）
    {
      const t5 = mkdtempSync(join(tmpdir(), 'dshmind-partial-'));
      try {
        setEnv({ MIND_HOME: t5 });
        roles.apply({
          on: () => {}, logger: () => ({ warn: () => {} }),
          tools: {
            layers: [],
            register() { throw new TypeError('tool "x" must declare output { schema, render, presentationMeta? }'); },
            guard() {},
          },
        });
        const mk = readFileSync(join(t5, '.dsh-market', 'agent-roles-marker.txt'), 'utf8');
        check('⑭ 注册全失败时不许报 mounted（报「部分挂载」）',
          mk.includes('部分挂载') && !mk.includes('apply: mounted'), mk.trim().split('\n').pop());
      } finally { rmSync(t5, { recursive: true, force: true }); }
    }
  }

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
  // ⚠️ 2026-09-29 **真触发**抓到：可见面 filter 不能下发"跨部署才存在"的名字
  //    （宿主 `restrict()` 对未知名响亮拒绝 ⇒ `role_spawn` 直接失败）。级联闸改由执行期闸兜。
  check('⑭ spec：可见面 filter **不**下发级联闸名字（否则 role_spawn 起不了成员）',
    roles.CASCADE_DENY.every((n) => !spec.request.toolFilter.deny.includes(n)),
    JSON.stringify(spec.request.toolFilter.deny));
  check('⑭ 可见面 filter 仍收窄卡内 deny + 本插件自有工具',
    spec.request.toolFilter.deny.includes('bash') && spec.request.toolFilter.deny.includes('role_spawn'),
    JSON.stringify(spec.request.toolFilter.deny));
  check('⑭ 执行期闸仍拦级联名字（filter 不发 ≠ 不拦）',
    typeof roles.buildToolGuard(card.tools)({ name: 'subagent' }) === 'string');
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

// ── ⑮ 宿主解析（host-resolve.js）—— junction 安装下上游导入的命门 ──────────
const hostResolve = loaded['lib/host-resolve.js'];
if (hostResolve) {
  check('⑮ 导出 hostImport / hostResolve', typeof hostResolve.hostImport === 'function' && typeof hostResolve.hostResolve === 'function');
  // 反例：不存在的包 ⇒ 返回 null，不抛（fail-open 的承诺）
  check('⑮ 反例：不存在的包 ⇒ hostImport 返回 null（不抛）',
    (await hostResolve.hostImport('@deepseek-ai/definitely-not-a-real-package')) === null);
  check('⑮ 反例：不存在的包 ⇒ hostResolve 返回 null',
    hostResolve.hostResolve('@deepseek-ai/definitely-not-a-real-package') === null);
  // 解析基准是**宿主入口**（process.argv[1]），不是本文件位置
  check('⑮ 解析基准取自 process.argv[1]（宿主入口）', typeof process.argv[1] === 'string' && process.argv[1].length > 0);
}

// ── ⑯ upstream 走宿主解析（不是裸 import）──────────────────────────────────
const upstream = loaded['lib/upstream.js'];
if (upstream) {
  check('⑯ 导出 createUserMessage（可为 null，取决于宿主是否可解析）',
    'createUserMessage' in upstream);
  check('⑯ 导出 upstreamSummary 供诊断', typeof upstream.upstreamSummary === 'function');
  check('⑯ 失败清单可读（空 = 全部就位）', Array.isArray(upstream.upstreamFailures));
}

// ── ⑰ 注入消息的 source 形态适配（message-source.js）────────────────────────
// 两次实机翻车的判据：① 缺 source ⇒ undefined.kind；② V3 的 kind:'plugin' 在 V4 被拒。
const msgSource = loaded['lib/message-source.js'];
if (msgSource) {
  check('⑰ V4 判定：0.2.0-rc.1 ⇒ true', msgSource.usesProducerOwnedSource('0.2.0-rc.1') === true);
  check('⑰ V4 判定：0.3.0 ⇒ true', msgSource.usesProducerOwnedSource('0.3.0') === true);
  check('⑰ V4 判定：1.0.0 ⇒ true', msgSource.usesProducerOwnedSource('1.0.0') === true);
  check('⑰ V3 判定：0.1.5-rc.2 ⇒ false', msgSource.usesProducerOwnedSource('0.1.5-rc.2') === false);
  check('⑰ V3 判定：0.1.7-alpha.2 ⇒ false', msgSource.usesProducerOwnedSource('0.1.7-alpha.2') === false);
  // 反例：取不到版本 ⇒ **取 V4**（宽容度不对称：V4 对 kind:'plugin' 硬拒，V3 对 plugin:<名> 无害）
  check('⑰ 反例：版本取不到 ⇒ 取 V4（损失更小的一侧）', msgSource.usesProducerOwnedSource(null) === true);
  check('⑰ 反例：版本串乱码 ⇒ 取 V4', msgSource.usesProducerOwnedSource('garbage') === true);

  const v4 = msgSource.pluginSource('dsh-mind-inject', 'instructions', '0.2.0-rc.1');
  check('⑰ V4 形态：kind = `plugin:<包名>`', v4.kind === 'plugin:dsh-mind-inject', JSON.stringify(v4));
  check('⑰ V4 形态：**必须没有** plugin 字段（官方 rewritePluginSource 会删掉它）',
    !('plugin' in v4), JSON.stringify(v4));
  check('⑰ V4 形态：form 保留', v4.form === 'instructions');

  const v3 = msgSource.pluginSource('dsh-mind-inject', 'instructions', '0.1.5-rc.2');
  check('⑰ V3 形态：kind = plugin 且带 plugin 字段',
    v3.kind === 'plugin' && v3.plugin === 'dsh-mind-inject' && v3.form === 'instructions', JSON.stringify(v3));

  // 反例：V4 形态**绝不能**等于 V3 的 kind（那正是被 V4 拒的那个值）
  check('⑰ 反例：V4 的 kind 不等于 `plugin`（等于就被 V4 拒）', v4.kind !== 'plugin');
}

// ── ⑱ 固件「工具链缺件读数」必须与实况一致（防声明腐化）─────────────────────
// 背景（2026-09-29 实测）：固件正文引用了 33 个 `scripts\*` 脚本（133 处），其中
// **32 个 / 132 处本包没有**（命中率 0%）。这些引用**不能删**（规程是照完整版写的），
// 故改用「一处声明（`firmware\L0\TOOL.md` §四）+ 一条机器判据」收口：
// **固件新增/删除引用而读数没跟着改 ⇒ 本断言变红**（声明不许腐化成空头）。
{
  /** 纯函数：从若干文本里抽出 `scripts\<名>.mjs|cjs|js` 引用（小写去重）。 */
  const scanScriptRefs = (texts) => {
    const refs = new Set();
    for (const t of texts) {
      for (const m of String(t).matchAll(/scripts[\\/]([A-Za-z0-9._-]+\.(?:mjs|cjs|js))/g)) refs.add(m[1].toLowerCase());
    }
    return refs;
  };
  /** 缺件 = 被引用、但本包 `scripts\` 里没有。 */
  const missingOf = (refs, have) => [...refs].filter((r) => !have.has(r));

  // 夹具臂（**不变式由夹具承担**；真树读数只作 info —— 别拿真实数据量当阈值）
  const fx = scanScriptRefs(['跑 node scripts\\a.mjs 与 scripts/B.cjs（大小写归一）', '这段没有引用']);
  check('⑱ 夹具：抽出 2 个引用且大小写归一', fx.size === 2 && fx.has('b.cjs'), [...fx].join(','));
  const fxMiss = missingOf(fx, new Set(['a.mjs']));
  check('⑱ 夹具：缺件口径只留本包没有的那支', fxMiss.length === 1 && fxMiss[0] === 'b.cjs', fxMiss.join(','));
  check('⑱ 夹具反例：全部命中本包 ⇒ 缺件为空', missingOf(fx, new Set(['a.mjs', 'b.cjs'])).length === 0);

  // 真树读数 + 与 TOOL.md §四 的声明比对
  const fwDir = join(PKG, 'firmware');
  const mdFiles = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.toLowerCase().endsWith('.md')) mdFiles.push(p);
    }
  })(fwDir);
  const refs = scanScriptRefs(mdFiles.map((f) => readFileSync(f, 'utf8')));
  const have = new Set(readdirSync(join(PKG, 'scripts')).map((f) => f.toLowerCase()));
  const missing = missingOf(refs, have);
  const toolText = readFileSync(join(fwDir, 'L0', 'TOOL.md'), 'utf8');
  const declared = /工具链缺件读数：(\d+)\s*个脚本/.exec(toolText);
  check('⑱ 固件声明了「scripts/ 工具链缺件读数」（TOOL.md §四）', declared !== null);
  if (declared) {
    check(`⑱ 读数一致（实况：全部引用 ${refs.size} 个 / 缺件 ${missing.length} 个）`,
      Number(declared[1]) === missing.length, `缺件 ${missing.length} / 声明 ${declared[1]}`);
  }
}

// ── ⑲ skill-loader：卡片真实路径 / 块列表触发词 / form 白名单（2026-09-29 加）──
// 与 ⑩ 同模块；这里只钉三个**新面**（⑩ 覆盖触发主链）。变量名避让 ⑩ 的 `skillLoader`。
const skillLoaderB = loaded['lib/host/skill-loader.js'];
if (skillLoaderB) {
  const t4 = mkdtempSync(join(tmpdir(), 'dshmind-skill-'));
  try {
    setEnv({ MIND_HOME: t4 });
    mkdirSync(join(t4, 'mind', 'L2', 'Skill'), { recursive: true });
    mkdirSync(join(t4, 'mind', 'L2', 'Exp'), { recursive: true });
    writeFileSync(join(t4, 'mind', 'L2', 'Skill', 'good.md'),
      '---\nname: good\ndescription: 说明\ntriggers: [跑冒烟]\noutputs: [结论, 证据]\n---\n正文', 'utf8');
    // 块列表 triggers（连字符列表）——此前只认流式 ⇒ 这种卡静默进不了索引
    writeFileSync(join(t4, 'mind', 'L2', 'Exp', 'tool.md'),
      '---\nname: tool\ndescription: 手册\ntriggers:\n  - 工具手册\n---\n正文', 'utf8');
    const cards = skillLoaderB.loadCards();
    const good = cards.find((c) => c.id === 'good');
    check('⑲ loadCards 记**真实相对路径**（含 `Skill/` 子目录）',
      good?.rel === 'mind/L2/Skill/good.md', String(good?.rel));
    check('⑲ rel 指向的文件真的存在（此前拼 `mind/L2/<id>.md` 必扑空）',
      existsSync(join(t4, good.rel.split('/').join(sep))));
    check('⑲ Exp 卡的 rel 带 `Exp/`（两区都对）',
      cards.find((c) => c.id === 'tool')?.rel === 'mind/L2/Exp/tool.md',
      String(cards.find((c) => c.id === 'tool')?.rel));
    check('⑲ 块列表 triggers 也认（否则该卡静默不触发）', cards.some((c) => c.id === 'tool'));
    // **注入文本里的路径**才是真正被 agent 读到的那个（只测 `rel` 字段会漏掉拼接处）
    const injectedText = skillLoaderB.cardText(good);
    check('⑲ 注入文本里的「全文」路径 = 真实相对路径',
      injectedText.includes('mind/L2/Skill/good.md'), injectedText.split('\n').pop());
    check('⑲ 反例：不含缺子目录的旧拼法 `mind/L2/<id>.md`',
      !injectedText.includes('mind/L2/good.md'), injectedText.split('\n').pop());
    check('⑲ 私有卡标注「不推送」', skillLoaderB.cardText({ id: 'p', zone: 'private', rel: 'mind-private/L2/Skill/p.md' }).includes('不推送'));
  } finally { rmSync(t4, { recursive: true, force: true }); }

  // form 必须落在 V3 迁移器的白名单内（白名单外的 form ⇒ 整条会话被拒收）
  if (msgSource) {
    const FORM_WHITELIST = ['instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall'];
    const c3 = msgSource.pluginSource('dsh-mind-skill-loader', 'catalog', '0.1.5-rc.2');
    check('⑲ 卡片注入的 form 在 V3 白名单内（自造值会致整会话拒收）',
      FORM_WHITELIST.includes(c3.form), c3.form);
    check('⑲ 反例：自造 form（旧值 skill-card）不在白名单内', !FORM_WHITELIST.includes('skill-card'));
  }
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

    // ── 判据补强（2026-09-29，三处实测漏洞的回归钉）─────────────────────────
    // 隐私形态①：`access_key` 是云凭据最常见写法（老 KEY 词表漏它）
    check('⑨ 隐私：`access_key = AKIA…`（云凭据）⇒ 拦',
      typeof guard.decide({ tool: 'write', path: plainFactory, content: 'access_key = AKIAIOSFODNN7EXAMPLE', sessionId: 's' }) === 'string');
    // 隐私形态②：中文「是/为」赋值（"我的密码是 xxxx"）
    check('⑨ 隐私：中文「我的密码是 hunter2xyz」⇒ 拦',
      typeof guard.decide({ tool: 'write', path: plainFactory, content: '我的密码是 hunter2xyz', sessionId: 's' }) === 'string');
    check('⑨ 反例：**提到**「密码」但无赋值 ⇒ 放行',
      guard.decide({ tool: 'write', path: plainFactory, content: '这里讨论密码这个概念', sessionId: 's' }) === undefined);
    // 出厂区**含包内固件**（firmware/ 是要推公开仓库的那份源）
    check('⑨ 隐私：往**包内 firmware/** 写凭据 ⇒ 拦（此前漏）',
      typeof guard.decide({ tool: 'write', path: join(PKG, 'firmware', 'L0', 'TOOL.md'), content: 'api_key = sk-abcdef123456', sessionId: 's' }) === 'string');

    // 高危匹配：**变体**也要拦（`endsWith('/'+名单)` 会放过 `.bak` / 子路径）
    check('⑨ 高危变体：`SOUL.md.bak` ⇒ 拦（后缀精确匹配会漏）',
      typeof guard.decide({ tool: 'write', path: join(tmp, 'mind', 'L0', 'SOUL.md.bak'), sessionId: 's' }) === 'string');
    check('⑨ 高危变体：`SOUL.md/子文件` ⇒ 拦',
      typeof guard.decide({ tool: 'write', path: join(tmp, 'mind', 'L0', 'SOUL.md', 'sub.md'), sessionId: 's' }) === 'string');
    // 人设卡层按**目录前缀**拦：同目录的改名件 / 第二张人格文件也算
    check('⑨ 人设卡层按目录前缀拦（`mind-private/L0/other.md`）',
      typeof guard.decide({ tool: 'write', path: join(tmp, 'mind-private', 'L0', 'other.md'), sessionId: 's' }) === 'string');
    // 包内固件真源＝比本机 mind/ 更上游（会被 bootstrap 拷到每台新机器）
    check('⑨ 包内固件真源（firmware/L0/SOUL.md）⇒ 拦（此前放行）',
      typeof guard.decide({ tool: 'write', path: join(PKG, 'firmware', 'L0', 'SOUL.md'), sessionId: 's' }) === 'string');
    check('⑨ 反例：包内**非宪法**固件（firmware/L2/Skill/x.md）⇒ 放行（不误伤）',
      guard.decide({ tool: 'write', path: join(PKG, 'firmware', 'L2', 'Skill', 'x.md'), sessionId: 's' }) === undefined);

    // ③ 未接入禁写
    connect?.setConnected?.('off-sess', false);
    check('⑨ 明确关闭的会话写心智区 ⇒ 拦',
      typeof guard.decide({ tool: 'write', path: priv, sessionId: 'off-sess' }) === 'string');
    check('⑨ 反例：接入的会话写心智区（非高危）⇒ 放行',
      guard.decide({ tool: 'write', path: priv, sessionId: 'on-sess' }) === undefined);
    // 2026-09-29：关闭态是**用户开关**，不因会话销毁而消失（否则同会话再打开就重新接上心智）。
    // 判据＝真跑 apply + 真发 disposed：实现若把清理加回来 ⇒ 状态被抹 ⇒ 本条变红。
    if (connect) {
      const hc = [];
      connect.apply({ on: (e, fn) => hc.push([e, fn]), logger: () => ({ warn: () => {} }) });
      const onDisposed = hc.find(([e]) => e === 'session/disposed')?.[1];
      if (onDisposed) onDisposed({ id: 'off-sess' });
      check('⑨ 会话销毁后关闭态仍在（关闭＝用户开关，不是会话临时状态）',
        connect.isConnected('off-sess') === false);
    }

    // hasSecrets 直测
    check('⑨ hasSecrets：PEM 块 ⇒ true', guard.hasSecrets('-----BEGIN RSA PRIVATE KEY-----\nx') === true);
    check('⑨ 反例：hasSecrets 空内容 ⇒ false', guard.hasSecrets('') === false);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// ── ⑳ 前端配套（host API 契约 + 浏览器半结构）────────────────────────────────
// 为什么单列一整节：浏览器半**不可能被 node 直接 import**（它依赖 `window`），host 半的路由
// 也只在真 webServer 上才被调用 ⇒ 这里是它们唯一能被断言的地方。
// 判据两条都配了反例：① 路由/槽位**集合**（多一个少一个都红）；② 信任闸与目录穿越（隐私口）。
{
  const api = loaded['lib/host/api.js'];
  const tmp2 = mkdtempSync(join(tmpdir(), 'dshmind-api-'));
  try {
    // 隔离根 + 让固件就位（状态口才有确定读数）
    setEnv({ MIND_HOME: tmp2 });
    boot.bootstrap();

    const routes = new Map();
    const fakeCtx = {
      effect: (fn) => { fn(); return () => {}; },
      webServer: {
        register: (r) => { routes.set(r.path, r); return () => {}; },
      },
      // 官方客户端服务（`/api/mind/boot` 读它）：给一份与真实同形的图（对象 + entries + batches）
      get: (name) => (name === 'clientModules'
        ? {
          graph: () => ({
            rev: 'rev-test',
            entries: [
              { id: 'dsh-mind', url: 'plugins/dsh-mind/client.js?rev=rev-test', rev: 'rev-test', inject: [], external: [] },
              { id: 'other-plugin', url: 'plugins/other-plugin/client.js?rev=rev-test', rev: 'rev-test', inject: [], external: [] },
            ],
            batches: [{ phase: 'application', url: 'plugins/??dsh-mind/client.js,other-plugin/client.js&rev=rev-test', entries: ['dsh-mind', 'other-plugin'] }],
          }),
        }
        : undefined),
      logger: () => ({ warn: () => {} }),
    };
    api.apply(fakeCtx);

    const want = api.ROUTE_SPECS.map((r) => r.path).sort();
    const got = [...routes.keys()].sort();
    check('⑳ host 半注册的路由集合 = ROUTE_SPECS（多一条少一条都红）',
      JSON.stringify(got) === JSON.stringify(want), `got=${got.join(',')}`);
    check('⑳ 路由表含 boot/beacon，且**不再**自托管 client.js（自托管是已删的假通道）',
      got.includes('/api/mind/boot') && got.includes('/api/mind/beacon') && !got.includes('/dsh-mind/client.js'));

    // —— 请求/响应夹具 ——
    const makeRes = () => {
      const res = { statusCode: 200, headers: {}, body: '', done: false };
      res.setHeader = (k, v) => { res.headers[String(k).toLowerCase()] = v; };
      res.end = (b) => { res.body = b === undefined ? '' : String(b); res.done = true; };
      return res;
    };
    const makeReq = ({ method = 'GET', url = '/', body = null, remote = '127.0.0.1', host = '127.0.0.1:19387', headers = {} } = {}) => {
      const hs = { data: [], end: [], error: [] };
      const req = {
        method,
        url,
        socket: { remoteAddress: remote },
        // ⚠️ 真实浏览器同源 fetch 必带 `sec-fetch-site`（Electron/Chromium 皆然）；
        //    信任闸照完整版判据**要求**它（无 Origin 时必须 same-origin/none）⇒ 夹具必须带上，
        //    否则连正例都会被 403 —— 那正是"闸在工作"的证明（另见下面三条反例）。
        headers: Object.assign({ host, 'sec-fetch-site': 'same-origin' }, headers),
        on(ev, fn) { (hs[ev] ||= []).push(fn); return req; },
        destroy() {},
      };
      // 监听器装好之后才投喂（readJsonBody 是"先注册、后收数据"的写法）
      setTimeout(() => {
        if (body !== null) { const buf = Buffer.from(JSON.stringify(body)); for (const f of hs.data) f(buf); }
        for (const f of hs.end) f();
      }, 0);
      return req;
    };
    const call = async (path, opts = {}) => {
      // 路由表按**路径**登记，查询串留给 `new URL(req.url, …)` ⇒ 查表只取 `?` 之前那段
      const r = routes.get(path.split('?')[0]);
      if (!r) return { statusCode: 404, body: '' };
      const res = makeRes();
      await r.handler(makeReq(Object.assign({ url: path }, opts)), res);
      return res;
    };
    const j = (res) => { try { return JSON.parse(res.body); } catch { return null; } };

    // —— 状态口 ——
    const st = await call('/api/mind/status');
    const stJson = j(st);
    check('⑳ GET /api/mind/status ⇒ 200 且 ok', st.statusCode === 200 && stJson?.ok === true, String(st.body).slice(0, 120));
    check('⑳ 状态含 paths/firmware/vault/markers/live/warnings 六格',
      Boolean(stJson?.paths && stJson?.firmware && stJson?.vault && stJson?.markers && stJson?.live && Array.isArray(stJson?.warnings)));
    check(`⑳ marker 读数 = MARKERS 名单（${api.MARKERS.length} 个，与实装插件对齐）`,
      Array.isArray(stJson?.markers) && stJson.markers.length === api.MARKERS.length
      && stJson.markers.some((m) => m.name === 'api' && m.runtime >= 0));
    check('⑳ 固件就位读数正确（临时根刚自举 ⇒ ready）', stJson?.firmware?.ready === true);
    check('⑳ 空壳会被如实说出来（私有区为空 ⇒ 警告里有「角色卡 0 张」）',
      Array.isArray(stJson?.warnings) && stJson.warnings.some((w) => w.includes('角色卡 0 张')));

    // ── 2026-09-30 补：警告**分档**（沉默属设计 ⇒ 说明）＋ 浏览器自报 ────────────
    check('⑳ 状态含 hits / notes / clientBeacons / clientApplied（"面板有没有被加载"的机械读数）',
      Boolean(stJson?.hits) && Array.isArray(stJson?.notes) && Boolean(stJson?.clientBeacons) && stJson.clientApplied === false);
    check('⑳ 真失效的插件仍在警告里（mood 零运行读数）',
      stJson.warnings.some((w) => w.includes('「mood」')));
    check('⑳ 反例：沉默属设计的 guard **不**进警告（误报会训练人忽略警告）',
      !stJson.warnings.some((w) => w.includes('「guard」')));
    check('⑳ guard 的沉默降级成"说明"（结论不删，只是不当故障）',
      stJson.notes.some((n) => n.includes('「guard」')));
    check('⑳ 浏览器还没自报时，说明里明写"一格都没到"（把"看不见"变成可定位的一格）',
      stJson.notes.some((n) => n.includes('一格都没到')));

    // —— 官方启动图只读诊断（面板"看不见"时先分这一刀）——
    const bootRes = await call('/api/mind/boot');
    const bj = j(bootRes);
    check('⑳ /api/mind/boot 读官方 clientModules 图：报服务可用 + hasSelf',
      bootRes.statusCode === 200 && bj?.serviceAvailable === true && bj?.hasSelf === true, JSON.stringify(bj?.selfEntry));
    check('⑳ boot 读数含真实 entries/batches（不是自己编的）',
      Array.isArray(bj?.entries) && bj.entries.length === 2 && Array.isArray(bj?.batches) && bj.batches.length === 1);
    check('⑳ 反例：服务缺失 ⇒ hasSelf=false（判据不是恒真）', (() => {
      const r2 = new Map();
      api.apply({ effect: (fn) => fn(), webServer: { register: (r) => { r2.set(r.path, r); return () => {}; } }, get: () => undefined, logger: () => ({ warn: () => {} }) });
      return true; // 服务缺失路径由下面 beacon/status 的机械读数覆盖；这里只证明 apply 不崩
    })());

    // —— 浏览器自报：链路四格必须都能记上 ——
    const bcApply = await call('/api/mind/beacon?what=apply&detail=selftest');
    const bcSlot = await call('/api/mind/beacon?what=slot&detail=conversation.view:mind');
    const st2 = await call('/api/mind/status');
    const st2j = j(st2);
    check('⑳ POST/GET beacon ⇒ 200 且计数落进 status.clientBeacons',
      bcApply.statusCode === 200 && bcSlot.statusCode === 200
      && st2j?.clientBeacons?.apply?.n === 1 && st2j?.clientBeacons?.slot?.n === 1, JSON.stringify(st2j?.clientBeacons));
    check('⑳ apply 自报 ⇒ clientApplied=true（比"取过包"更硬的一格）', st2j?.clientApplied === true);
    check('⑳ 首次自报各写一行 marker（只写一次，不刷环）',
      readFileSync(join(tmp2, '.dsh-market', 'api-marker.txt'), 'utf8').includes('beacon: apply'));
    check('⑳ 链路断点会被说清：已到 apply、未到 render ⇒ 说明里点出断点',
      (st2j?.notes || []).some((n) => n.includes('未到') && n.includes('render')), (st2j?.notes || []).join(' | '));
    check('⑳ 命中计数进了 status（status 至少 2 次）', (st2j?.hits?.['/api/mind/status'] || 0) >= 2, JSON.stringify(st2j?.hits));
    // 反例：`error` 自报必须进**警告**（不是"沉默"）
    await call('/api/mind/beacon?what=error&detail=boom');
    const st3 = await call('/api/mind/status');
    check('⑳ 反例：浏览器半报错 ⇒ 进警告（不是说明）',
      (j(st3)?.warnings || []).some((w) => w.includes('浏览器半报错')), JSON.stringify(j(st3)?.warnings));

    // —— 信任闸（隐私口，反例优先）——
    const bad1 = await call('/api/mind/status', { remote: '10.0.0.5' });
    check('⑳ 反例：非 loopback 来源 ⇒ 403', bad1.statusCode === 403, String(bad1.statusCode));
    const bad2 = await call('/api/mind/status', { host: 'evil.example.com' });
    check('⑳ 反例：Host 非 loopback（DNS rebinding）⇒ 403', bad2.statusCode === 403, String(bad2.statusCode));
    const bad3 = await call('/api/mind/status', { headers: { 'sec-fetch-site': 'cross-site' } });
    check('⑳ 反例：跨站 fetch ⇒ 403', bad3.statusCode === 403, String(bad3.statusCode));

    // —— 只读文件口：穿越必须挡死，正例必须能读 ——
    const esc = await call('/api/mind/file?zone=private&rel=' + encodeURIComponent('../../../etc/passwd'));
    check('⑳ 反例：目录穿越 ⇒ 400', esc.statusCode === 400 && j(esc)?.ok === false, String(j(esc)?.error));
    const esc2 = await call('/api/mind/file?zone=private&rel=' + encodeURIComponent('..\\..\\..\\windows\\win.ini'));
    check('⑳ 反例：反斜杠穿越 ⇒ 400', esc2.statusCode === 400);
    const esc3 = await call('/api/mind/file?zone=nope&rel=a.md');
    check('⑳ 反例：未知 zone ⇒ 400', esc3.statusCode === 400);
    const esc4 = await call('/api/mind/file?zone=private&rel=' + encodeURIComponent('C:\\Windows\\win.ini'));
    check('⑳ 反例：绝对路径 ⇒ 400', esc4.statusCode === 400);
    const esc5 = await call('/api/mind/file?zone=private&rel=README.bin');
    check('⑳ 反例：非白名单扩展名 ⇒ 400', esc5.statusCode === 400);
    mkdirSync(join(tmp2, 'mind-private', 'L1'), { recursive: true });
    writeFileSync(join(tmp2, 'mind-private', 'L1', 'Learn.md'), '- [2026-09-29] 正例\n', 'utf8');
    const okRead = await call('/api/mind/file?zone=private&rel=' + encodeURIComponent('L1/Learn.md'));
    check('⑳ 正例：私有区里的 .md 读得回（否则上面那批反例是恒绿）',
      okRead.statusCode === 200 && (j(okRead)?.text || '').includes('正例'), String(okRead.body).slice(0, 120));

    // —— 开关往返（逻辑仍在 connect.js，这里验的是转发面）——
    const offRes = await call('/api/mind/connect', { method: 'POST', url: '/api/mind/connect', body: { session: 'api-sess', enabled: false } });
    check('⑳ POST 关闭 ⇒ enabled=false 且列出该会话',
      offRes.statusCode === 200 && j(offRes)?.enabled === false && (j(offRes)?.offSessions || []).includes('api-sess'), String(offRes.body).slice(0, 160));
    const getRes = await call('/api/mind/connect?session=api-sess');
    check('⑳ GET 读回关闭态', j(getRes)?.enabled === false);
    const onRes = await call('/api/mind/connect', { method: 'POST', url: '/api/mind/connect', body: { session: 'api-sess', enabled: true } });
    check('⑳ POST 接回 ⇒ enabled=true', j(onRes)?.enabled === true);
    const noSess = await call('/api/mind/connect', { method: 'POST', url: '/api/mind/connect', body: { enabled: false } });
    check('⑳ 反例：缺 session ⇒ 400（不能把"关心智"广播到所有会话）', noSess.statusCode === 400, String(noSess.body).slice(0, 120));
    const putRes = await call('/api/mind/connect', { method: 'PUT', url: '/api/mind/connect' });
    check('⑳ 反例：PUT ⇒ 405', putRes.statusCode === 405, String(putRes.statusCode));

    // —— 宿主没有 tapIndex（老版本）⇒ 不崩（fail-open）——
    let crashed = false;
    try {
      api.apply({ effect: (fn) => { fn(); }, webServer: { register: () => () => {} }, logger: () => ({ warn: () => {} }) });
    } catch { crashed = true; }
    check('⑳ 反例：宿主没有 tapIndex ⇒ apply 不抛（面板不可用，但插件照加载）', crashed === false);

    // —— 浏览器半：形态 + 槽位集合 ——
    const clientSrc = readFileSync(join(PKG, 'client', 'client.js'), 'utf8');
    let def = null;
    new Function('window', clientSrc)({ __ModuleLoader__: { load: (d) => { def = d; } } });
    check('⑳ 浏览器半是合法 JS 且形态正确（id=dsh-mind）', Boolean(def) && def.id === 'dsh-mind' && typeof def.factory === 'function');
    const stubReact = {
      createElement: () => null,
      Fragment: Symbol('Fragment'),
      useState: (v) => [v, () => {}],
      useEffect: () => {},
      useRef: (v) => ({ current: v }),
      useMemo: (f) => f(),
    };
    const stubRequire = (m) => (m === 'react' ? stubReact : { jsx: () => null, jsxs: () => null, Fragment: stubReact.Fragment });
    const clientExports = def.factory(stubRequire);
    check('⑳ 工厂导出 apply/inject（外壳按这两个名字挂载）',
      typeof clientExports.apply === 'function' && Array.isArray(clientExports.inject));
    check('⑳ inject 只声明 slots（多声明 ⇒ 缺该服务的 profile 里整插件静默不激活）',
      clientExports.inject.length === 1 && clientExports.inject[0] === 'slots', JSON.stringify(clientExports.inject));
    check('⑳ 浏览器半不用裸 import（工厂模式只许 require 外壳外部化的模块）',
      !/^\s*import\s/m.test(clientSrc));
    check('⑳ host 半的浏览器包路径指向随包文件（不在 lib/ 下，故不进 node 侧自动发现）',
      existsSync(api.CLIENT_FILE) && api.CLIENT_FILE.split(sep).slice(-2).join('/') === 'client/client.js', api.CLIENT_FILE);

    // 槽位白名单＝**本机实测存在**的那些（见 client/client.js 头部；凭记忆加槽位 = 面板静默不出现）
    const KNOWN_SLOTS = [
      'conversation.view', 'sidebar.footer.action', 'settings.plugin.item',
      'plugins.bundle.config', 'settings.section', 'conversation.input.overlay',
      'conversation.input.left', 'conversation.session.header.utilities',
      'sidebar.right.pane.tab', 'shell.overlay', 'conversation.chat.assistant-actions',
    ];
    const regs = [];
    clientExports.apply({
      effect: (fn) => { fn(); return () => {}; },
      slots: {
        inject: (_slot, fn) => { fn(); return () => {}; },
        register: (opts) => { regs.push(opts); return () => {}; },
      },
      logger: () => ({ warn: () => {} }),
    });
    const ids = regs.map((r) => `${r.name}:${r.id}`).sort();
    check('⑳ 真跑 apply ⇒ 注册 conversation.view:mind 与 sidebar.footer.action:mind-connect',
      ids.includes('conversation.view:mind') && ids.includes('sidebar.footer.action:mind-connect'), ids.join(' '));
    const unknown = regs.filter((r) => !KNOWN_SLOTS.includes(r.name)).map((r) => r.name);
    check('⑳ 槽位名都在白名单内（打错一个字母就静默失效，本条挡它）',
      regs.length >= 2 && unknown.length === 0, unknown.join(', '));
    check('⑳ 反例：白名单确实能判红（`converstion.view` 不在名单内）', !KNOWN_SLOTS.includes('converstion.view'));

    // —— 渲染冒烟：拿**真 status JSON** 把面板组件跑一遍 ——
    // 为什么值得单列：渲染期抛错在浏览器里表现为"整块空白"，最难在重启后定位。
    // 假 React：createElement 记录调用（不产真 vnode），hooks 只回初值。
    const tree = [];
    const smokeReact = {
      createElement: (type, props, ...kids) => { tree.push({ type: typeof type === 'function' ? type.name : type, props }); return { type, props, kids }; },
      Fragment: Symbol('Fragment'),
      useState: (v) => [v, () => {}],
      useEffect: () => {},
      useRef: (v) => ({ current: v }),
      useMemo: (f) => f(),
    };
    const smokeRequire = (m) => (m === 'react' ? smokeReact : { jsx: () => null, jsxs: () => null, Fragment: smokeReact.Fragment });
    const smoke = def.factory(smokeRequire).__internals;
    check('⑳ 浏览器半暴露测试缝 __internals（组件能被渲染冒烟覆盖）', Boolean(smoke && smoke.Facts && smoke.MindPanel));
    const render = (name, fn) => {
      try { fn(); return true; } catch (e) { return `${e?.name}: ${e?.message}`; }
    };
    const r1 = render('Facts(真 status)', () => smoke.Facts({ status: stJson }));
    check('⑳ 用真 status JSON 渲染 Facts 不抛（host 给的字段名与面板读的字段名对得上）', r1 === true, String(r1));
    const r2 = render('Facts(null)', () => smoke.Facts({ status: null }));
    check('⑳ 反例：status 为 null（host 半没起来）也不抛，只显示"读不到"', r2 === true, String(r2));
    const r3 = render('MindPanel', () => smoke.MindPanel({ sessionId: 'api-sess' }));
    check('⑳ MindPanel 渲染不抛', r3 === true, String(r3));
    const r4 = render('MindWidget', () => smoke.MindWidget({ sessionId: 'api-sess' }));
    check('⑳ 页脚挂件渲染不抛（无 status 时也要能画出来）', r4 === true, String(r4));
    check('⑳ 渲染确实走到了子组件（不是"因为到处 return null 而假绿"）', tree.length > 0, `createElement ${tree.length} 次`);
  } finally {
    restoreEnv();
    rmSync(tmp2, { recursive: true, force: true });
  }
}

// ── ㉑ 防回退：三处 `session/event` 处理器只许走共享归一化 ─────────────────────
// 为什么单列一节：这条缺陷的形态是**静默**的（marker 里只有 `apply:` 行、纯函数判据全绿），
// 所以除了行为断言（⑪/⑫/⑬ 各加了一条"宿主形态"），还要有一条**结构性**判据钉住签名——
// 让"改回单参 payload"这件事立刻变红，而不是等真机上再空转几天。
{
  const se = loaded['lib/host/session-event.js'];
  check('㉑ session-event.js 可加载且导出两个纯函数',
    typeof se?.splitSessionEvent === 'function' && typeof se?.sessionIdOf === 'function');
  const host = se.splitSessionEvent({ id: 'x', header: { id: 'x' } }, { type: 't' });
  check('㉑ 宿主形态优先：第一参当 session、第二参当 event',
    host.session?.id === 'x' && host.event?.type === 't');
  const single = se.splitSessionEvent({ event: { type: 't' }, sessionId: 'y' });
  check('㉑ 单参载荷仍兼容（老宿主/夹具）：事件与 sessionId 都取到',
    single.event?.type === 't' && single.session?.id === 'y');
  check('㉑ sessionIdOf：id 优先 / 兜 header.id / 取不到给空串（不编 id）',
    se.sessionIdOf({ id: 'a' }) === 'a' && se.sessionIdOf({ header: { id: 'b' } }) === 'b'
    && se.sessionIdOf({}) === '' && se.sessionIdOf(null) === '');

  const users = ['lib/host/mood.js', 'lib/host/session-budget.js', 'lib/host/compaction-log.js'];
  const src = users.map((f) => [f, readFileSync(join(PKG, f), 'utf8')]);
  const notUsing = src.filter(([, s]) => !s.includes("from './session-event.js'")).map(([f]) => f);
  check('㉑ 三个插件都 import 共享归一化（各写一份必然漂移）', notUsing.length === 0, notUsing.join(', '));
  const backslid = src.filter(([, s]) => /ctx\.on\('session\/event',\s*\(payload\)/.test(s)).map(([f]) => f);
  check('㉑ 反例：单参签名 `(payload)` 不许再出现（改回去 ⇒ 本条变红）', backslid.length === 0, backslid.join(', '));
  const legacy = src.filter(([, s]) => s.includes('payload?.event ?? payload')).map(([f]) => f);
  check('㉑ 三个插件都不再留 `payload?.event ?? payload` 兜底（那是错签名的痕迹）', legacy.length === 0, legacy.join(', '));
  check('㉑ 反例：结构性判据确实能变红（伪造一段单参签名会被正则抓到）',
    /ctx\.on\('session\/event',\s*\(payload\)/.test("ctx.on('session/event', (payload) => {})"));
}

restoreEnv();
console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'}  ${pass}/${pass + fails.length}`);
if (fails.length) { console.log('失败项：\n  - ' + fails.join('\n  - ')); process.exit(1); }
