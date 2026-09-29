// lib/host/guard.js — 写前护栏（在 write/edit 真正写入前拦一次）。
//
// ── 拦什么（**极窄内核**，其余写入放行——不侵入生长空间）──────────────────────
//   ① 隐私红线：往**出厂区** `mind/` 写疑似凭据 ⇒ 拦
//   ② 自我修改门禁：改**高危自我类文件**（宪法/规则/门禁/人设卡/放行真源）⇒ 拦，需放行
//   ③ 未接入心智的会话写心智区 ⇒ 拦
//
// ── 设计原则 ──────────────────────────────────────────────────────────────────
//   · **只拦不注入**（注入归 inject）——单一职责
//   · **fail-open**：整个 apply 包 try/catch，任何失败只记日志、绝不 rethrow
//     （宁可护栏没生效，也不因护栏 bug 带崩运行中的界面）
//   · **不做"等放行"硬拦**：程序判不了用户意图，硬拦易误伤生长
//
// ── 诚实标注（不许写得比机制强）──────────────────────────────────────────────
//   本护栏是**纪律级 + 来源标注**，**不是防伪机制**：本机进程可绕过（直接改批准记录）。
//   它治的是"误伤/误写"，不治"恶意"。这是已标注的边界，不是待补的漏洞。
//
// ── 不覆盖的面（诚实列出）────────────────────────────────────────────────────
//   `pwsh` / `node` 直接写文件**不经此处**（内容级判定不现实）⇒ 本包**既不拦、也不留痕**
//   （完整版另有独立提示环 `mind-guard-hints.txt` 与归属台账 `write-log.jsonl`，本包未随）。
//
// ── ⚠️ 本包**没有放行通道**（2026-09-29 补，防"规则比机制宽"）──────────────────
//   本文件只有"拦"：**不读** `approvals.json`、**不接** `approval` 服务、没有面板。
//   完整版有四条互备通道（一次性额度·**写成功才消费** / 路径前缀粒度 / 面板待裁决卡 /
//   上游弹窗 + `upstreamTrace` 留痕），本包**一条都没随** ⇒ 高危命中即**终局拒绝**，
//   没有"批一下就过"的机器出口。
//   按纪律：停下说明，等主人明确放行后由**主人自己动手**（或临时停用本插件；
//   **agent 不得自己去停**——那会把隐私红线一起关掉）。
//   `HIGH_RISK` 里那条 `mind-private/tasks/approvals.json` 是"护它不被改"，**不是**授权来源。

import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { mindDir, privateDir, marketDir, firmwareDir } from '../paths.js';
import { mark } from '../diag.js';
import { isConnected } from './connect.js';

export const name = 'dsh-mind-guard';
export const inject = ['tools', 'fs'];

/** 本护栏覆盖的写工具（其余工具不拦）。 */
export const MUTATING_TOOLS = ['write', 'edit', 'str_replace_editor'];

/** 高危自我类文件（改这些 ⇒ 真拦，需放行）。判据＝"改了它会改变系统怎么运转"。 */
const HIGH_RISK = [
  'mind/L0/SOUL.md', 'mind/L0/AGENTS.md',
  'mind/L1/HUB.md', 'mind/L1/Memory.md', 'mind/L1/Ritual.md',
  'mind/L1/Invariants.md', 'mind/L1/Concepts.md', 'mind/L1/Power.md',
  'mind/L1/Wisdom.md', 'mind/L1/Design-Philosophy.md',
  'mind-private/tasks/approvals.json',
];

/** 高危**目录前缀**（以 `/` 结尾）：目录下**任何**文件都算——抗改名。
 *  ⚠️ 人设卡**不能**写成精确文件名（2026-09-29 修）：写死 `人设卡.md` 时，
 *  同目录的改名件 / 第二张人格文件（实测 `mind-private/L0/other.md`）零门禁，
 *  而"改人设＝改我是谁"正是这一层要守的东西。 */
const HIGH_RISK_DIRS = ['mind-private/L0/'];

/** 包内固件真源里等同于"宪法/规则"的文件（相对 `firmware/`，小写）。
 *  为什么单独一档（2026-09-29 实测补）：`firmware/` 会被 `bootstrap` 拷到**每一台新机器**，
 *  改它比改本机 `mind/` 更上游；而此前判据只在数据根内做后缀匹配 ⇒ 改
 *  `firmware/L0/SOUL.md` **完全放行**（实测）。 */
const HIGH_RISK_FIRMWARE = [
  'l0/soul.md', 'l0/agents.md',
  'l1/hub.md', 'l1/memory.md', 'l1/ritual.md', 'l1/invariants.md',
  'l1/concepts.md', 'l1/power.md', 'l1/wisdom.md', 'l1/design-philosophy.md',
];

/** 归一化为可比较的路径（统一 / 且小写——Windows 大小写不敏感）。 */
function norm(p) {
  return resolve(String(p || '')).replace(/\\/g, '/').toLowerCase();
}

/** 目标是否在给定根内。 */
function inRoot(target, root) {
  const t = norm(target);
  const r = norm(root).replace(/\/+$/, '');
  return t === r || t.startsWith(r + '/');
}

/**
 * 内容是否带**凭据形态**（不是"提到这些词"）。
 * 判据：`KEY = 值`（值 ≥6 位非空白）/ PEM 私钥块。
 * 为什么要求赋值形态：拦词会把"记录 token 消耗教训"这类**正当写作**也拦死，且无解除通道。
 */
export function hasSecrets(content) {
  const s = String(content || '');
  if (!s) return false;
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(s)) return true;
  // KEY 词表（2026-09-29 补两类）：`access_key` 是云凭据最常见形态；`client_secret` 显式列出。
  const KEY = '(?:api[\\s_-]?key|access[\\s_-]?key|client[\\s_-]?secret|secret|token|passwd|password|private[\\s_-]?key|密码|口令|密钥|私钥|令牌)';
  // 赋值形态：`KEY = 值` / `KEY: 值` / 中文「KEY 是 值 / KEY 为 值」，值 ≥6 位非空白。
  // ⚠️ 为什么认「是/为」（2026-09-29 补）：中文里"我的密码是 xxxx"是最自然的凭据落地形态，
  //    只认 `[:=]` 会漏（实测：老实现拦得住，本实现此前放行）。
  // 取舍：这一档**宁可误伤**（往可推送的出厂区写疑似凭据 ⇒ 拦下来改措辞或改落 mind-private），
  //    也不漏判；误伤面被"值 ≥6 位非空白"限住。
  return new RegExp(`${KEY}\\s*(?:[:=]|是|为)\\s*["']?\\S{6,}`, 'i').test(s);
}

/**
 * 纯判定：给定一次写入，返回拒绝理由（`undefined` = 放行）。
 * **抽成纯函数**是为了可测（门禁能直接喂用例，不必起宿主）。
 * @param {{tool:string, path:string, content?:string, sessionId?:string}} req
 * @returns {string|undefined}
 */
export function decide(req) {
  const { tool, path: target, content, sessionId } = req || {};
  if (!MUTATING_TOOLS.includes(String(tool))) return undefined;
  if (!target) return undefined;

  const t = norm(target);
  const fw = norm(firmwareDir());
  const inFirmware = t === fw || t.startsWith(fw + '/');
  const fwRel = inFirmware ? t.slice(fw.length + 1) : '';
  // ⚠️ 出厂区**含包内固件**（2026-09-29 补）：包内 `firmware/` 是要推公开仓库的那份源，
  //    往里写凭据与往 `mind/` 写是同一件事（此前只认数据根 ⇒ 漏）。
  const inFactory = inRoot(target, mindDir()) || inRoot(target, firmwareDir());
  const inPrivate = inRoot(target, privateDir());
  const inMindZone = inFactory || inPrivate;

  // ③ 未接入心智的会话写心智区 ⇒ 拦（关了心智就别动它的文件）
  if (inMindZone && !isConnected(sessionId)) {
    return '本会话未接入心智（已关闭）⇒ 不写心智区文件';
  }

  // ① 隐私红线：往出厂区写凭据
  if (inFactory && hasSecrets(content)) {
    return '隐私红线：出厂区（mind/ 与包内 firmware/）不写凭据类内容——私密数据只进 mind-private/';
  }

  // ② 自我修改门禁：高危自我类文件
  // ⚠️ 用**包含**匹配而不是 `endsWith('/'+h)`（2026-09-29 修）：后缀精确匹配会放过
  //    `<受管文件>.bak` / `<受管文件>/子文件` 这类变体（实测：老口径拦得住、本口径放行）。
  //    代价＝可能匹配到"别处的同名副本"（如 `other/mind/L1/HUB.md`）——那也**该拦**。
  const hitFile = HIGH_RISK.some((h) => t.includes('/' + h.toLowerCase()) || t.startsWith(h.toLowerCase()));
  const hitDir = HIGH_RISK_DIRS.some((d) => t.includes(d.toLowerCase()));
  const hitFirmware = fwRel !== '' && HIGH_RISK_FIRMWARE.includes(fwRel);
  if (hitFile || hitDir || hitFirmware) {
    return hitFirmware
      ? '高危自我修改：改的是**包内固件真源**（firmware/，会被拷到每一台新机器）——需显式放行'
      : '高危自我修改：改的是宪法/规则/门禁/人设卡/放行真源——需显式放行';
  }

  return undefined;
}

/** 放行流水（append-only JSONL，供审计）。 */
function appendDecision(rec) {
  try {
    const f = join(marketDir(), 'guard-decisions.jsonl');
    mkdirSync(dirname(f), { recursive: true });
    appendFileSync(f, JSON.stringify(rec) + '\n', 'utf8');
  } catch { /* 留痕失败不影响判定 */ }
}

/** 取写入内容（不同工具参数名不同）。 */
function contentOf(args) {
  if (!args || typeof args !== 'object') return '';
  return String(args.content ?? args.new_string ?? args.new_str ?? args.text ?? '');
}

export function apply(ctx) {
  try {
    // ⚠️ 必须**直接调用** `ctx.tools.guard(...)`，不要先 `const g = ctx.tools.guard` 再调——
    //   那是脱离 `this` 的裸函数调用，guard 内部读 `this.layers` 会炸（实测：reading 'layers'）。
    if (typeof ctx.tools?.guard !== 'function') {
      mark('guard', 'apply: ctx.tools.guard 不可用（护栏停用，fail-open）');
      return;
    }

    // 返回值不另存：guard 随本插件 fiber 卸载自动解绑。
    ctx.tools.guard((execution) => {
      try {
        const tool = execution?.name;
        const args = execution?.arguments ?? execution?.args ?? {};
        const path = args.file_path ?? args.path ?? '';
        const sessionId = execution?.agent?.session?.header?.id;
        const reason = decide({ tool, path, content: contentOf(args), sessionId });
        if (reason === undefined) return undefined;
        appendDecision({
          ts: new Date().toISOString(), tool, path: String(path), reason,
          session: sessionId ?? null, decidedBy: 'guard',
        });
        mark('guard', `deny: ${tool} ${String(path).slice(-60)}`);
        return reason;
      } catch (e) {
        mark('guard', `error: ${e?.message ?? e}`);
        return undefined;   // 判定内部出错 ⇒ 放行（fail-open）
      }
    });

    mark('guard', `apply: mounted（mutating=${MUTATING_TOOLS.join('/')}）`);
  } catch (e) {
    mark('guard', `apply failed: ${e?.message ?? e}`);
    ctx.logger?.('dsh-mind').warn(`dsh-mind-guard: apply 失败（已忽略）：${e?.message ?? e}`);
  }
}
