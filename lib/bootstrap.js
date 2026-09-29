// lib/bootstrap.js — 首启自举：本机没有固件时，从包内 `firmware/` 落地一份。
//
// ── 为什么必须有 ──────────────────────────────────────────────────────────────
//   插件装上时，本机**没有那份固件**（它不随 dsh home 存在）。不自举 ⇒ 注入器读不到
//   SOUL/AGENTS、召回找不到规则、面板扫不出树 —— **装上也是空壳**。
//
// ── 五条纪律 ──────────────────────────────────────────────────────────────────
//   ① **幂等**：必备件齐全 ⇒ 一个字节都不动
//   ② **只增不改**：已存在的文件一律跳过（**绝不覆盖用户已经养出来的心智**）
//   ③ **不写示例记忆**：只建私有区空壳 + 首启说明（写了＝预设生长方向，违背"全放开生长"）
//   ④ **缺失必＝未就位**：用**必备件清单**判据，不用单点（见下 REQUIRED 注释）
//   ⑤ **fail-open**：自举异常只 warn，绝不断插件加载
//
// ── 为什么是"清单判据"而不是"看一个标志文件" ──────────────────────────────────
//   单点判据（只看 `SOUL.md`）下，"SOUL 在、HUB 被误删"会被当成"已就位"⇒ **跳过补缺**，
//   残缺固件永远修不好（而缺 HUB 时装配会静默少一半）。清单判据让缺件能被补回。

import { existsSync, mkdirSync, readdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataRoot, mindDir, privateDir, firmwareDir, ensureDir } from './paths.js';

/**
 * 必备件清单（缺任一件即视为"未就位"）。
 * 判据：**没有它，核心机制就跑不起来**——SOUL/AGENTS 是 R0 注入源，
 * HUB/Memory/Ritual 是装配与规程的权威源。
 */
export const REQUIRED_FIRMWARE = [
  ['L0', 'SOUL.md'],
  ['L0', 'AGENTS.md'],
  ['L1', 'HUB.md'],
  ['L1', 'Memory.md'],
  ['L1', 'Ritual.md'],
];

/** 固件是否**完备**（必备件全在）。 */
export function isFirmwareReady() {
  return REQUIRED_FIRMWARE.every(([d, f]) => existsSync(join(mindDir(), d, f)));
}

/**
 * 只读自检：报当前状态与缺件（不写盘）。
 * 供面板 / 脚本 / 诊断消费。
 */
export function bootstrapStatus() {
  const fw = firmwareDir();
  const missing = [];
  for (const [d, f] of REQUIRED_FIRMWARE) {
    if (!existsSync(join(mindDir(), d, f))) missing.push(`${d}/${f}`);
  }
  return {
    dataRoot: dataRoot(),
    mindDir: mindDir(),
    privateDir: privateDir(),
    firmwareDir: fw,
    /** 包内是否有固件源（false ⇒ 打包漏了 `files` 白名单或固件目录） */
    firmwareAvailable: existsSync(join(fw, 'L0', 'SOUL.md')),
    /** 本机固件是否已就位 */
    ready: isFirmwareReady(),
    missing,
  };
}

/** 递归拷贝，**只增不改**（目标已存在的文件一律跳过）。 */
function copyTreeNoOverwrite(src, dst, stats) {
  ensureDir(dst);
  let entries;
  try { entries = readdirSync(src, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const s = join(src, e.name);
    const d = join(dst, e.name);
    if (e.isDirectory()) { copyTreeNoOverwrite(s, d, stats); continue; }
    if (!e.isFile()) continue;
    if (existsSync(d)) { stats.skipped += 1; continue; }
    try { copyFileSync(s, d); stats.copied += 1; } catch { stats.failed += 1; }
  }
}

/** 私有区空壳（**不写任何示例记忆**——写了＝预设生长方向）。 */
const PRIVATE_SUBDIRS = [
  'L0', 'L1',
  'L2/Skill', 'L2/Exp', 'L2/agents',
  'L3/common', 'L3/projects', 'L3/history',
  'TRASH', 'tasks',
];

const PRIVATE_README = `# 本机心智实例

> 这个目录 = **你自己养出来的那个伴生体**，永不上传、永不外流。
> 出厂固件在隔壁 \`mind/\`（可推送、可被升级覆盖）；这里的东西只属于本机。

## 从哪开始
1. **人设**（可选）：在 \`L0/人设卡.md\` 写"它是谁"。不写就是干净通用智能体。
2. **偏好**：你的习惯、铁律、纠正 → \`L3/common/user-rules/rules.md\`。
3. **项目记忆**：每个项目一个目录 → \`L3/projects/<项目>/project.md\`。
4. **教训**：被纠正/被表扬 → \`L1/Learn.md\`（当场写，不靠"下次记住"）。

## 纪律
给 \`mind/\`（出厂区）写私密内容 = 把隐私推上公开仓库。**私密一律落这里。**
`;

/**
 * 首启自举（幂等 · 只增不改 · fail-open）。
 * @param {{logger?: (msg: string) => void}} [opts]
 * @returns {{action:'skipped'|'seeded'|'no-source'|'failed', copied:number, skipped:number, failed:number, detail:string}}
 */
export function bootstrap(opts = {}) {
  // logger 自身可能抛 ⇒ 包一层，保证"只 warn 不抛"的承诺成立（实测踩过：catch 里再调 logger 会二次抛）
  const rawLog = typeof opts.logger === 'function' ? opts.logger : () => {};
  const log = (m) => { try { rawLog(m); } catch { /* 日志失败不影响主流程 */ } };
  const stats = { copied: 0, skipped: 0, failed: 0 };

  try {
    // ① 已完备 ⇒ 不动
    if (isFirmwareReady()) {
      return { action: 'skipped', ...stats, detail: '固件完备（幂等：不动现有内容）' };
    }

    // ② 包内无源 ⇒ 如实报，不假装成功
    const src = firmwareDir();
    if (!existsSync(join(src, 'L0', 'SOUL.md'))) {
      const detail = `包内无固件：${src}（检查 package.json 的 files 白名单是否含 firmware/）`;
      log(`[dsh-mind] ${detail}`);
      return { action: 'no-source', ...stats, detail };
    }

    // ③ 落地 / 补缺（只增不改）
    copyTreeNoOverwrite(src, mindDir(), stats);

    // ④ 建私有区空壳 + 首启说明
    for (const sub of PRIVATE_SUBDIRS) ensureDir(join(privateDir(), sub.split('/').join('/')));
    const notePath = join(privateDir(), 'README.md');
    if (!existsSync(notePath)) {
      try { writeFileSync(notePath, PRIVATE_README, 'utf8'); stats.copied += 1; } catch { stats.failed += 1; }
    }

    const detail = `固件落地：复制 ${stats.copied} / 跳过 ${stats.skipped}（已存在）/ 失败 ${stats.failed} → ${mindDir()}`;
    log(`[dsh-mind] ${detail}`);
    return { action: 'seeded', ...stats, detail };
  } catch (e) {
    // fail-open：自举失败绝不断插件加载
    const detail = `自举异常（已忽略）：${e?.message ?? e}`;
    log(`[dsh-mind] ⚠️ ${detail}`);
    return { action: 'failed', ...stats, detail };
  }
}
