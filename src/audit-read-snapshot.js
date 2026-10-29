/** Immutable parsed rows for explicit read-only projections; never an append or permission cache. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { listFiles } from './kernel/fsx.js';

const MAX_BYTES = 128 * 1024 * 1024;
const MAX_MONTHS = 4;
function freezeRows(rows) {
  const stack = [rows];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) continue;
    Object.freeze(value);
    for (const child of Object.values(value)) if (child && typeof child === 'object') stack.push(child);
  }
  return rows;
}

export class AuditReadSnapshot {
  #scopes = new AsyncLocalStorage();
  #rows = new Map();
  #pending = new Map();
  #bytes = 0;
  constructor(layout) { this.layout = layout; }
  active() { return this.#scopes.getStore()?.active === true; }
  async run(read) {
    if (this.active()) return read();
    const frame = { active: true };
    return this.#scopes.run(frame, async () => {
      try { return await read(); }
      finally { frame.active = false; }
    });
  }
  async #fileVersion(file) {
    try {
      const info = await stat(file, { bigint: true });
      return { key: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`, bytes: Number(info.size) };
    } catch (error) {
      if (error.code === 'ENOENT') return { key: 'absent', bytes: 0 };
      throw error;
    }
  }
  #forget(month) {
    const old = this.#rows.get(month);
    if (old) { this.#bytes -= old.bytes; this.#rows.delete(month); }
  }
  async read(month, load) {
    if (!this.active()) return load();
    const file = this.layout.auditLog(month), version = await this.#fileVersion(file);
    const cached = this.#rows.get(month);
    if (cached?.key === version.key) return cached.rows;
    this.#forget(month);
    if (this.#pending.get(month)?.key === version.key) return this.#pending.get(month).promise;
    const pending = { key: version.key };
    pending.promise = (async () => {
      const rows = freezeRows(await load());
      if ((await this.#fileVersion(file)).key === version.key && this.#pending.get(month) === pending && version.bytes <= MAX_BYTES) {
        while (this.#rows.size >= MAX_MONTHS || this.#bytes + version.bytes > MAX_BYTES) this.#forget(this.#rows.keys().next().value);
        this.#rows.set(month, { ...version, rows }); this.#bytes += version.bytes;
      }
      return rows;
    })();
    this.#pending.set(month, pending);
    try { return await pending.promise; }
    finally { if (this.#pending.get(month) === pending) this.#pending.delete(month); }
  }
  /** Include every log, current/legacy anchor and the manifest; lock files are not ledger data. */
  async version() {
    const manifest = basename(this.layout.auditMonthManifest());
    const names = (await listFiles(this.layout.auditDir(), { recursive: false, filter: name =>
      /^audit-\d{4}-\d{2}\.jsonl$/.test(name) || /^\.anchor-\d{4}-\d{2}\.json$/.test(name)
      || /^audit-\d{4}-\d{2}\.anchor\.json$/.test(name) || name === manifest })).sort();
    if (!names.includes(manifest)) names.push(manifest);
    const versions = [];
    for (const name of names) versions.push([name, (await this.#fileVersion(join(this.layout.auditDir(), name))).key]);
    return JSON.stringify(versions);
  }
}
