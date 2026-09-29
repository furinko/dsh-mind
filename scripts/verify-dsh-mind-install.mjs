// scripts/verify-dsh-mind-install.mjs — 真装验收（在**已装好本包**的 profile 上跑）。
//
// 为什么单独一个脚本（不进 test/selftest.mjs）：它验的是**装到别处之后**的行为，
// 需要一个真装过的 profile 作输入 ⇒ 环境依赖，不适合每次自测都跑。
//
// 用法：node scripts/verify-dsh-mind-install.mjs <profileDir>
// 退出码：PASS 0 / FAIL 1 / 用法错 2

import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const profileDir = process.argv[2];
if (!profileDir) { console.error('用法：node scripts/verify-dsh-mind-install.mjs <profileDir>'); process.exit(2); }

let pass = 0;
const fails = [];
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fails.push(name); console.log(`  ✗ ${name}${detail ? '  → ' + detail : ''}`); }
};

/** patch 行 id → 包内子路径（与 package.json exports 的键一致）。 */
const SUBPATH = {
  'dsh-mind-inject': 'host/inject',
  'dsh-mind-recall': 'host/recall',
  'dsh-mind-connect': 'host/connect',
  'dsh-mind-guard': 'host/guard',
  'dsh-mind-skill-loader': 'host/skill-loader',
  'dsh-mind-compaction-log': 'host/compaction-log',
  'dsh-mind-mood': 'host/mood',
  'dsh-mind-session-budget': 'host/session-budget',
  'dsh-mind-agent-roles': 'host/agent-roles',
};
const ROWS = Object.keys(SUBPATH);

console.log(`== dsh-mind 真装验收（profile: ${profileDir}）==`);

const pkgDir = join(profileDir, 'node_modules', 'dsh-mind');
check('① 已装进 profile 的 node_modules', existsSync(pkgDir), pkgDir);
if (!existsSync(pkgDir)) {
  console.log(`\nFAIL  ${pass}/${pass + fails.length}（包没装上，后续检查无意义）`);
  process.exit(1);
}

// ── ② 每个插件子路径都真能解析到文件 ─────────────────────────────────────────
const pj = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
const missing = [];
for (const row of ROWS) {
  const rel = pj.exports?.[`./${SUBPATH[row]}`];
  if (rel === undefined) { missing.push(`${row}: exports 缺 ./${SUBPATH[row]}`); continue; }
  if (!existsSync(join(pkgDir, String(rel).split('/').join(sep)))) missing.push(`${row}: ${rel} 不存在`);
}
check(`② ${ROWS.length} 个插件子路径都能解析到实体（漏 exports = 启动崩）`, missing.length === 0, missing.join('; '));

// ── ③ patch 行与 exports 一一对应 ────────────────────────────────────────────
const patch = readFileSync(join(pkgDir, 'cordis.patch.yml'), 'utf8');
const patchIds = [...patch.matchAll(/^\s*-\s*id:\s*(\S+)/gm)].map((m) => m[1]);
const notInExports = patchIds.filter((id) => pj.exports?.[`./${SUBPATH[id]}`] === undefined);
check(`③ patch 的 ${patchIds.length} 行都有对应 exports`, notInExports.length === 0, notInExports.join(', '));
check('③ patch 行数 = 预期插件数', patchIds.length === ROWS.length, `${patchIds.length} vs ${ROWS.length}`);

// ── ④ 固件随包（files 白名单生效）────────────────────────────────────────────
const fw = join(pkgDir, 'firmware');
const fwFiles = existsSync(fw) ? readdirSync(fw, { recursive: true }).length : 0;
check('④ firmware/ 随包（否则首启自举无源 ⇒ 装上变空壳）', existsSync(join(fw, 'L0', 'SOUL.md')), fw);
check(`④ 固件文件数 ≥ 30（实测 ${fwFiles}）`, fwFiles >= 30, String(fwFiles));

// ── ⑤ 首启自举：在干净根上真跑一次 ──────────────────────────────────────────
const tmpHome = mkdtempSync(join(tmpdir(), 'dshmind-fresh-'));
const saved = { DSH_HOME: process.env.DSH_HOME, MIND_HOME: process.env.MIND_HOME };
try {
  process.env.MIND_HOME = tmpHome;
  delete process.env.DSH_HOME;
  const boot = await import(pathToFileURL(join(pkgDir, 'lib', 'bootstrap.js')).href + `?t=${Date.now()}`);
  check('⑤ 自举前：报未就位（证明这是"首启"）', boot.bootstrapStatus().ready === false);
  const r = boot.bootstrap();
  check('⑤ 自举 ⇒ seeded', r.action === 'seeded', JSON.stringify(r));
  check('⑤ 固件落到 <MIND_HOME>/mind/L0/SOUL.md', existsSync(join(tmpHome, 'mind', 'L0', 'SOUL.md')));
  check('⑤ 私有区空壳已建', existsSync(join(tmpHome, 'mind-private', 'L3', 'projects')));
  check('⑤ 自举后报已就位', boot.bootstrapStatus().ready === true, JSON.stringify(boot.bootstrapStatus().missing));
  check('⑤ 二次自举幂等 ⇒ skipped', boot.bootstrap() === undefined ? false : boot.bootstrap().action === 'skipped');
} finally {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(tmpHome, { recursive: true, force: true });
}

// ── ⑥ 反例：错的子路径必须解析失败（证明 ② 不是恒绿）────────────────────────
check('⑥ 反例：不存在的 exports 键 ⇒ 检查能变红', pj.exports['./host/no-such'] === undefined);

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'}  ${pass}/${pass + fails.length}`);
if (fails.length) { console.log('失败项：\n  - ' + fails.join('\n  - ')); process.exit(1); }
