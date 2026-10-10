/**
 * 升级：叠加层 + 条款级合并（§5）。
 *
 * 一句话概括这一件的行为：**出厂文件是只读模板，用户改动是叠加层，生效内容是合并结果**。
 * 合并的最小单位是**条款**而不是文件——否则任何一处改动都会把整个文件判成冲突。
 *
 * 处置表（§5，经主权者 2026-10-08 批次4裁决修订）：
 *   用户没改过        → 直接替换
 *   用户改了、出厂没改 → 保留用户的
 *   两边改了同一条     → **保留用户的（私有优先）**，并审计一条告警提示主权者——
 *                       不再挂起等裁决；Lead 的裁决通道保留给遗留挂起项
 *   安全类            → 强制替换，不可协商
 */
import { readJsonOrNull, readTextOrNull, atomicWrite, listFiles } from './kernel/fsx.js';
import { InvalidBody } from './kernel/errors.js';
import { splitClauses } from './kernel/text.js';
import { RULE_FILES } from './paths.js';

/** 处置三态（「挂起」已按主权者 2026-10-08 裁决并入「保留用户的」：冲突私有优先 + 告警提示）。 */
export const DISPOSITIONS = ['直接替换', '保留用户的', '强制替换'];

export class UpgradeManager {
  /**
   * @param {{ layout: import('./paths.js').Layout, policy: import('./policy.js').PolicyEngine, audit: import('./audit.js').AuditLog, clock: import('./kernel/time.js').Clock }} spec
   */
  constructor(spec) {
    this.layout = spec.layout;
    this.policy = spec.policy;
    this.audit = spec.audit;
    this.clock = spec.clock;
  }

  /**
   * 基线戳：记下出厂件每个条款此刻的哈希。
   *
   * 没有它就无法区分「出厂改了」和「用户改了」——那正是条款级合并唯一的判据来源。
   *
   * @param {{ 版本: string, 对象?: string[] }} spec
   * @returns {Promise<{ 版本: string, 对象: number, 条款: number, 于: string }>}
   */
  async stamp(spec) {
    const 对象 = spec.对象 ?? (await this.#factoryObjects());
    /** @type {Record<string, Record<string, string>>} */
    const baseline = {};
    let 条款数 = 0;
    for (const id of 对象) {
      const resolved = await this.#resolve(id, '出厂');
      if (!resolved) continue;
      const text = await readTextOrNull(resolved);
      if (text === null) continue;
      baseline[id] = Object.fromEntries(splitClauses(text).map((c) => [c.key, c.hash]));
      条款数 += Object.keys(baseline[id]).length;
    }
    await atomicWrite(
      this.layout.baselineFile(),
      `${JSON.stringify({ 版本: spec.版本, 于: this.clock.iso(), 对象: baseline }, null, 2)}\n`,
    );
    await this.audit.append({
      动作: '状态变更',
      主体: { id: 'factory', kind: '出厂作者' },
      对象: { id: '基线戳', kind: '账目' },
      依据: '§5 升级三配套之一：基线戳',
      结果: `基线 ${spec.版本}：${Object.keys(baseline).length} 个对象 / ${条款数} 条条款`,
    });
    return { 版本: spec.版本, 对象: Object.keys(baseline).length, 条款: 条款数, 于: this.clock.iso() };
  }

  /**
   * @returns {Promise<{版本: string, 于: string, 对象: Record<string, Record<string, string>>}|null>}
   */
  async baseline() {
    return readJsonOrNull(this.layout.baselineFile());
  }

  /**
   * 条款级比对。
   *
   * @param {{ 对象: string, 出厂文件?: string, 私有文件?: string|null, 安全类?: boolean }} spec
   * @returns {Promise<Array<{条款: string, 处置: string, 出厂哈希: string|null, 私有哈希: string|null, 基线哈希: string|null, diff: {出厂: string, 私有: string}|null}>>}
   */
  async compare(spec) {
    const baseline = await this.baseline();
    const base = baseline?.对象?.[spec.对象] ?? {};
    const 出厂文件 = spec.出厂文件 ?? (await this.#resolve(spec.对象, '出厂'));
    const 私有文件 = spec.私有文件 === undefined ? await this.#resolve(spec.对象, '私有') : spec.私有文件;

    const 出厂文本 = 出厂文件 ? await readTextOrNull(出厂文件) : null;
    const 私有文本 = 私有文件 ? await readTextOrNull(私有文件) : null;
    if (出厂文本 === null && 私有文本 === null) throw new InvalidBody(`对象 ${spec.对象} 两区都不存在，无从比对。`);

    const 出厂条款 = new Map(splitClauses(出厂文本 ?? '').map((c) => [c.key, c]));
    const 私有条款 = new Map(splitClauses(私有文本 ?? '').map((c) => [c.key, c]));
    const keys = [...new Set([...Object.keys(base), ...出厂条款.keys(), ...私有条款.keys()])].sort();

    const 结果 = keys.map((key) => {
      const 基线哈希 = base[key] ?? null;
      const fHash = 出厂条款.get(key)?.hash ?? null;
      const pHash = 私有条款.get(key)?.hash ?? null;
      const 处置 = decide(基线哈希, fHash, pHash, spec.安全类 === true);
      // 「两边都改了」要显式标出：处置是私有优先（保留用户的），但冲突事实必须可见——
      // Lead 据此提示主权者（主权者裁决 2026-10-08），diff 也保留给提示用。
      const 冲突 = pHash !== null && fHash !== 基线哈希 && pHash !== 基线哈希 && pHash !== fHash;
      return {
        条款: key,
        处置,
        ...(冲突 ? { 冲突: true } : {}),
        出厂哈希: fHash,
        私有哈希: pHash,
        基线哈希,
        diff: 冲突 ? { 出厂: trim(出厂条款.get(key)?.body ?? ''), 私有: trim(私有条款.get(key)?.body ?? '') } : null,
      };
    });

    // 冲突私有优先：不挂起、不阻塞，但必须有一条告警让 Lead 能向主权者提示（裁决 2026-10-08）。
    const 冲突行 = 结果.filter((r) => r.冲突);
    if (冲突行.length) {
      await this.audit.append({
        动作: '状态变更',
        主体: { id: 'system', kind: '系统' },
        对象: { id: spec.对象, kind: '规则' },
        依据: '§5 升级冲突私有优先（主权者裁决 2026-10-08）',
        结果: `私有优先：${冲突行.length} 条出厂/私有冲突保留私有版，待 Lead 提示主权者`,
        告警: true,
        详情: { 条款: 冲突行.map((r) => r.条款) },
      });
    }
    if (结果.some((r) => r.处置 !== '保留用户的')) {
      await this.audit.append({
        动作: spec.安全类 === true ? '强制更新' : '状态变更',
        主体: { id: 'factory', kind: '出厂作者' },
        对象: { id: spec.对象, kind: '规则' },
        依据: spec.安全类 === true ? '§5 安全类：强制替换，不可协商' : '§5 升级：条款级合并',
        结果: 结果.map((r) => `${r.条款}=${r.处置}`).join(' · '),
      });
    }
    return 结果;
  }

  /**
   * 挂起队列。主权者失联时挂起项**进队列而不是消失**（§3 不可逆资源）。
   * @returns {Promise<Array<object>>}
   */
  async pending() {
    const dir = this.layout.pendingDir();
    const files = await listFiles(dir, { recursive: false, filter: (n) => n.endsWith('.json') });
    const out = [];
    for (const name of files) {
      const item = await readJsonOrNull(`${dir}/${name}`);
      if (item) out.push(item);
    }
    return out.sort((a, b) => String(a.挂起于).localeCompare(String(b.挂起于)));
  }

  /**
   * 裁决一个**遗留**挂起项（新冲突已按私有优先自动处置，不再产生挂起）。
   * 主权者或 Lead 可裁决（主权者裁决 2026-10-08：Lead 自我约束，仅在主权者授意时行使）；
   * 安全类挂起项仍按宪章档拒绝 Lead。
   *
   * @param {{ subject: object, id: string, 选择: string, 理由: string }} spec
   * @returns {Promise<{ id: string, 已裁决: true, 选择: string }>}
   */
  async resolve(spec) {
    if (!['用出厂版', '用我的版'].includes(spec.选择)) {
      throw new InvalidBody('挂起项的选项只有「用出厂版 / 用我的版」。', { missing: ['选择'] });
    }
    const item = await this.pending();
    const target = item.find((i) => i.id === spec.id);
    if (!target) throw new InvalidBody(`没有这个挂起项：${spec.id}`);
    await this.policy.check({
      subject: spec.subject,
      action: 'publish',
      target: { id: target.对象, kind: '规则', authority: target.安全类 ? '宪章' : '法律', zone: '私有' },
      context: { 挂起项: spec.id },
    });
    const resolved = { ...target, 已裁决: true, 选择: spec.选择, 理由: spec.理由, 裁决于: this.clock.iso(), 由: spec.subject?.id ?? null };
    await atomicWrite(this.layout.pendingFile(spec.id), `${JSON.stringify(resolved, null, 2)}\n`);
    await this.audit.append({
      动作: '状态变更',
      主体: spec.subject,
      对象: { id: target.对象, kind: '规则' },
      依据: '§5 两边改了同一条 ⇒ 摆 diff 给主权者选',
      结果: `裁决 ${spec.选择}`,
      详情: { 挂起项: spec.id, 理由: spec.理由, 条款: target.条款 },
    });
    return { id: spec.id, 已裁决: true, 选择: spec.选择 };
  }

  /**
   * 可撤回（§5 升级三配套之三）。撤回同样留痕：挂起项不消失，只是被撤回。
   *
   * 撤回与裁决同一口径（action: 'publish'）与同一授权面（主权者或 Lead，裁决 2026-10-08）。
   * @param {{ subject: object, id: string, 理由?: string }} spec
   */
  async withdraw(spec) {
    const item = (await this.pending()).find((i) => i.id === spec.id);
    if (!item) throw new InvalidBody(`没有这个挂起项：${spec.id}`);
    await this.policy.check({
      subject: spec.subject,
      action: 'publish',
      target: { id: item.对象, kind: '规则', authority: item.安全类 ? '宪章' : '法律', zone: '私有' },
      context: { 挂起项: spec.id },
    });
    const withdrawn = { ...item, 已撤回: true, 撤回理由: spec.理由 ?? '未说明', 撤回于: this.clock.iso(), 由: spec.subject?.id ?? null };
    await atomicWrite(this.layout.pendingFile(spec.id), `${JSON.stringify(withdrawn, null, 2)}\n`);
    await this.audit.append({
      动作: '状态变更',
      主体: spec.subject,
      对象: { id: item.对象, kind: '规则' },
      依据: '§5 升级三配套：可撤回',
      结果: '挂起项已撤回（记录保留）',
      详情: { 挂起项: spec.id },
    });
    return { id: spec.id, 已撤回: true };
  }

  // ── 内部 ────────────────────────────────────────────────────────────────────

  /** @returns {Promise<string[]>} 出厂区里可参与合并的对象（规则 + 岗位卡 + 能力）。 */
  async #factoryObjects() {
    const ids = new Set();
    for (const spec of RULE_FILES) {
      if ((await readTextOrNull(this.layout.rulePath(spec.id, '出厂'))) !== null) ids.add(spec.id);
    }
    for (const dir of [this.layout.roleCardDir('出厂'), this.layout.capabilityDir('出厂')]) {
      for (const rel of await listFiles(dir, { recursive: false, filter: (n) => n.endsWith('.md') })) {
        ids.add(rel.replace(/\.md$/, ''));
      }
    }
    // 下划线开头的是模板（`_模板.md`）：模板没有被"改过"这一说，不参与合并。
    return [...ids].filter((id) => !id.startsWith('_')).sort();
  }

  /**
   * 对象 id → 该区里的实际文件。规则件、岗位卡、能力卡住在三处不同目录，
   * 由这一个函数统一解析，别处不再猜路径。
   * @param {string} 对象
   * @param {'出厂'|'私有'} zone
   * @returns {Promise<string|null>}
   */
  async #resolve(对象, zone) {
    const candidates = [
      this.layout.rulePath(对象, zone),
      `${this.layout.roleCardDir(zone)}/${对象}.md`,
      `${this.layout.capabilityDir(zone === '出厂' ? '出厂' : '自治')}/${对象}.md`,
    ].filter(Boolean);
    for (const path of candidates) {
      if ((await readTextOrNull(path)) !== null) return path;
    }
    return null;
  }
}

/**
 * 处置表。独立成函数是为了让「判定」与「落盘」分开，
 * 于是它能被单独测（合并逻辑出错时，比磁盘状态更早暴露问题）。
 *
 * 「挂起」已按主权者 2026-10-08 批次4裁决移除：两边都改了同一条 ⇒ 保留用户的（私有优先），
 * 冲突事实由 compare() 标注并审计告警提示，不再等裁决。
 *
 * @param {string|null} 基线
 * @param {string|null} 出厂
 * @param {string|null} 私有
 * @param {boolean} 安全类
 * @returns {string} DISPOSITIONS 之一
 */
export function decide(基线, 出厂, 私有, 安全类 = false) {
  if (私有 === null) return '直接替换';
  if (安全类) return '强制替换';
  if (基线 === null) return 出厂 === 私有 ? '直接替换' : '保留用户的';
  if (出厂 === 基线) return 私有 === 基线 ? '直接替换' : '保留用户的';
  if (私有 === 基线 || 私有 === 出厂) return '直接替换';
  return '保留用户的';
}

/** @param {string} text */
function trim(text) {
  return text.length > 2000 ? `${text.slice(0, 2000)}\n…（已截断）` : text;
}
