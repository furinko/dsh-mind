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
// ── 两档处置（2026-10-05 改造：由"只有拦"升级为"红线硬拒 + 高危放行一次"）────────
//   ① **红线档**（未接入心智 / 凭据入出厂区）⇒ `ctx.tools.guard` **硬拒**。
//      该钩子是**同步、单向**的（只能拒、永远不能放）⇒ 与"红线不可放行"语义天然吻合。
//   ② **高危自我修改档**（宪法/规则/门禁/人设卡/包内固件真源）⇒ `tools/pre-execute`
//      返回 `{kind:'ask'}`，由**宿主自己**把请求送进 `approval` seam（`dsh-tools`
//      `serviceAsk`）：主人「允许一次」才过；rejected / cancelled / unavailable
//      一律由宿主落成拒绝（fail-closed）。审批留痕由宿主写 `approval/asked` +
//      `approval/decided`（`dsh-user-approval`）⇒ **agent 伪造不了**，本文件不再另记一份。
//      ⚠️ ② 的处置**随会话审批策略分岔**（2026-10-05 主人点选）：策略 `ask`（本机预设「心智护栏」）
//      ⇒ 弹窗放行一次；策略 `never`（本机预设「danger-full-access」＝完全权限）⇒ **自动放行**——
//      "完全权限默认放行心智修改"；要"只对心智修改提示"，就选「心智护栏」。红线档不受策略影响，恒硬拒。
//   ⚠️ 为什么必须换钩子（不是偏好，是契约）：`ctx.tools.guard` 注册在 `tools/pre-execute`
//      **之后**，是同步单调闸、没有 await 点 ⇒ 弹窗塞不进去；且"任何 guard 都不能强制
//      放行另一道 guard 的拒绝"⇒ 高危档若留在 guard 层，上游批准也会被自己否掉。
//   ⚠️ **降级不放宽**：`tools/pre-execute` 未能注册时，高危档**退回硬拒**（而不是放开）。
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
 * 两档名（`inspect` 的 `tier`）：`redline`＝不可放行的红线；`approval`＝可经上游放行一次。
 * 为什么分成两档而不是一刀切：红线（隐私/边界）**不可逆** ⇒ 机制层硬拒；高危自我修改
 * **可逆**（有快照/可回滚）⇒ 允许主人显式放行一次——`AGENTS §四` 两档同此口径。
 */
export const TIERS = ['redline', 'approval'];

/**
 * 纯判定（**单一真源**）：给定一次写入，返回 `{tier, reason}`；放行 ⇒ `undefined`。
 * **抽成纯函数**是为了可测（门禁能直接喂用例，不必起宿主）。
 * @param {{tool:string, path:string, content?:string, sessionId?:string}} req
 * @returns {{tier:'redline'|'approval', reason:string}|undefined}
 */
export function inspect(req) {
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

  // ① 红线档：未接入心智的会话写心智区 ⇒ 拦（关了心智就别动它的文件）
  if (inMindZone && !isConnected(sessionId)) {
    return { tier: 'redline', reason: '本会话未接入心智（已关闭）⇒ 不写心智区文件' };
  }

  // ① 红线档：隐私——往出厂区写凭据
  if (inFactory && hasSecrets(content)) {
    return {
      tier: 'redline',
      reason: '隐私红线：出厂区（mind/ 与包内 firmware/）不写凭据类内容——私密数据只进 mind-private/',
    };
  }

  // ② 放行档：高危自我修改（宪法/规则/门禁/人设卡/包内固件真源）
  // ⚠️ 用**包含**匹配而不是 `endsWith('/'+h)`（2026-09-29 修）：后缀精确匹配会放过
  //    `<受管文件>.bak` / `<受管文件>/子文件` 这类变体（实测：老口径拦得住、本口径放行）。
  //    代价＝可能匹配到"别处的同名副本"（如 `other/mind/L1/HUB.md`）——那也**该拦**。
  const hitFile = HIGH_RISK.some((h) => t.includes('/' + h.toLowerCase()) || t.startsWith(h.toLowerCase()));
  const hitDir = HIGH_RISK_DIRS.some((d) => t.includes(d.toLowerCase()));
  const hitFirmware = fwRel !== '' && HIGH_RISK_FIRMWARE.includes(fwRel);
  if (hitFile || hitDir || hitFirmware) {
    return {
      tier: 'approval',
      reason: hitFirmware
        ? '高危自我修改：改的是**包内固件真源**（firmware/，会被拷到每一台新机器）——需显式放行'
        : '高危自我修改：改的是宪法/规则/门禁/人设卡/放行真源——需显式放行',
    };
  }

  return undefined;
}

/**
 * 兼容旧签名：只取拒因字符串（`undefined`＝放行）。
 * 保留它是因为既有调用方与测试（`test/selftest.mjs` ⑨）都按"字符串＝拦"用。
 * @param {{tool:string, path:string, content?:string, sessionId?:string}} req
 * @returns {string|undefined}
 */
export function decide(req) {
  return inspect(req)?.reason;
}

/** 从宿主执行体里取判定入参（`ctx.tools.guard` 钩子与 `tools/pre-execute` 拿到的是**同一个**对象）。 */
function reqOf(execution) {
  return {
    tool: execution?.name,
    path: execution?.arguments?.file_path ?? execution?.arguments?.path ?? execution?.args?.file_path ?? execution?.args?.path ?? '',
    content: contentOf(execution?.arguments ?? execution?.args),
    sessionId: execution?.agent?.session?.header?.id,
  };
}

/**
 * 放行流水（append-only JSONL，供审计）。
 * **导出**给 HTTP 写口用（`api.js` 的面板保存人设卡）：那份流水只此一处实现，
 * 路由里另写一遍就等于养出第二份格式（迟早漂移，且"哪个面写了什么"会分不清）。
 */
export function recordDecision(rec) {
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

/**
 * 本会话的有效审批策略（`ask` / `never`）；拿不到 ⇒ `undefined`（不自己判，交给上游）。
 * 为什么只在 `never` 时短路：`never` 下 `approval.request()` 在服务内部**直接**返回 `rejected`
 * 且**不弹窗**，若照常 ask，主人会看到 "the user rejected" 这种**没人被问过**的假陈述。
 * `never` 下的处置（2026-10-05 主人点选）＝**自动放行高危档**：完全权限预设的语义就是
 * "默认放行、包括心智修改"；需要放行前有人看一眼，就切到带 `ask` 的预设（本机＝「心智护栏」）。
 * 红线段不走这里（它在 guard 层、与策略无关，恒硬拒）。
 * ⚠️ 这里**只读**，绝不调用 `setPolicy`——策略是主人的开关，agent 自己去翻＝自己开门。
 */
function policyOf(ctx, execution) {
  try {
    const svc = typeof ctx.get === 'function' ? ctx.get('approval') : undefined;
    const session = execution?.agent?.session;
    if (!svc || !session) return undefined;
    if (typeof svc.effectivePolicy === 'function') return svc.effectivePolicy(session);
    if (typeof svc.overrideOf === 'function') return svc.overrideOf(session);
  } catch { /* 读不到就当未知 ⇒ 交给上游 ask */ }
  return undefined;
}

export function apply(ctx) {
  try {
    // ⚠️ 必须**直接调用** `ctx.tools.guard(...)`，不要先 `const g = ctx.tools.guard` 再调——
    //   那是脱离 `this` 的裸函数调用，guard 内部读 `this.layers` 会炸（实测：reading 'layers'）。
    const hardLayer = typeof ctx.tools?.guard === 'function';

    // ② 放行层（高危档）：`tools/pre-execute` 瀑布可 await ⇒ 是审批 seam 的接入点。
    //    顺序上**先 `next()` 再 ask**：下游若已有拒绝，不拿主人的弹窗去覆盖它
    //    （同官方 `dsh-experimental-auto-review` 的写法）。
    let approvalLayer = false;
    if (typeof ctx.on === 'function') {
      try {
        ctx.on('tools/pre-execute', async (execution, next) => {
          const downstream = await next();
          try {
            const req = reqOf(execution);
            const verdict = inspect(req);
            if (!verdict || verdict.tier !== 'approval') return downstream;
            if (!downstream || downstream.kind !== 'allow') return downstream;
            const audit = (decidedBy, effect) => recordDecision({
              ts: new Date().toISOString(), tool: req.tool, path: String(req.path),
              reason: verdict.reason, tier: verdict.tier,
              session: req.sessionId ?? null, decidedBy, effect,
            });
            if (policyOf(ctx, execution) === 'never') {
              // ⚠️ `never`（完全权限预设）＝**默认放行**（2026-10-05 主人点选）：
              //    这里**自动放行**高危档，而不是"直接拒"——主人的原话是"完全权限自动放行心智修改"。
              //    红线档不在此列（它在 guard 层，与策略无关，恒硬拒）。
              //    要"只对心智修改提示"，选带 `approval: ask` 的预设（本机＝「心智护栏」）。
              audit('policy-never', 'allow');
              mark('guard', `allow(never): ${req.tool} ${String(req.path).slice(-60)}`);
              return downstream;
            }
            audit('ask-upstream', 'ask');
            mark('guard', `ask: ${req.tool} ${String(req.path).slice(-60)}`);
            return {
              kind: 'ask',
              reason: `${verdict.reason}｜path=${req.path}`,
              displayReason: {
                en: 'dsh-mind guard: this write hits high-risk self-modification (constitution / mind rules / gates / persona card / packaged firmware source).\nPath: ' + req.path + '\nApprove this one call?',
                zh: `心智护栏：这次写入命中「高危自我修改」（宪法 / mind 规则 / 门禁 / 人设卡 / 包内固件真源）。\n路径：${req.path}\n只放行这一次？`,
              },
            };
          } catch (e) {
            mark('guard', `pre-execute error: ${e?.message ?? e}`);
            return downstream;   // 判定内部出错 ⇒ 不拦（fail-open，与既有口径一致）
          }
        });
        approvalLayer = true;
      } catch (e) {
        mark('guard', `apply: pre-execute 注册失败（高危档退回硬拒，不放宽）：${e?.message ?? e}`);
      }
    }

    // ① 红线层（硬拒·不可放行）。同时兜住"放行层没装上"的降级 ⇒ 高危档退回硬拒。
    if (hardLayer) {
      ctx.tools.guard((execution) => {
        try {
          const req = reqOf(execution);
          const verdict = inspect(req);
          if (!verdict) return undefined;
          if (verdict.tier !== 'redline' && approvalLayer) return undefined;
          recordDecision({
            ts: new Date().toISOString(), tool: req.tool, path: String(req.path),
            reason: verdict.reason, tier: verdict.tier,
            session: req.sessionId ?? null, decidedBy: approvalLayer ? 'guard' : 'guard(degraded)',
          });
          mark('guard', `deny: ${req.tool} ${String(req.path).slice(-60)}`);
          return verdict.reason;
        } catch (e) {
          mark('guard', `error: ${e?.message ?? e}`);
          return undefined;   // 判定内部出错 ⇒ 放行（fail-open）
        }
      });
    }

    if (!hardLayer && !approvalLayer) {
      mark('guard', 'apply: 无可用挂载点（护栏停用，fail-open）');
      return;
    }
    mark('guard', `apply: mounted（mutating=${MUTATING_TOOLS.join('/')}, approvalLayer=${approvalLayer}）`);
  } catch (e) {
    mark('guard', `apply failed: ${e?.message ?? e}`);
    ctx.logger?.('dsh-mind').warn(`dsh-mind-guard: apply 失败（已忽略）：${e?.message ?? e}`);
  }
}
