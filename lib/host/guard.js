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
//   `pwsh` / `node` 直接写文件**不经此处**（内容级判定不现实）⇒ 只留痕、不硬拦。

import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { mindDir, privateDir, marketDir } from '../paths.js';
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
  'mind-private/L0/人设卡.md',
  'mind-private/tasks/approvals.json',
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
  const KEY = '(?:api[\\s_-]?key|secret|token|passwd|password|private[\\s_-]?key|密码|口令|密钥|私钥|令牌)';
  return new RegExp(`${KEY}\\s*[:=]\\s*\\S{6,}`, 'i').test(s);
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

  const inFactory = inRoot(target, mindDir());
  const inPrivate = inRoot(target, privateDir());
  const inMindZone = inFactory || inPrivate;

  // ③ 未接入心智的会话写心智区 ⇒ 拦（关了心智就别动它的文件）
  if (inMindZone && !isConnected(sessionId)) {
    return '本会话未接入心智（已关闭）⇒ 不写心智区文件';
  }

  // ① 隐私红线：往出厂区写凭据
  if (inFactory && hasSecrets(content)) {
    return '隐私红线：出厂区（mind/）不写凭据类内容——私密数据只进 mind-private/';
  }

  // ② 自我修改门禁：高危自我类文件
  const t = norm(target);
  if (HIGH_RISK.some((h) => t.endsWith('/' + h.toLowerCase()))) {
    return '高危自我修改：改的是宪法/规则/门禁/人设卡/放行真源——需显式放行';
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
