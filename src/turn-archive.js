/** Chunked turn storage. The manifest is the sole commit point; unreachable parts are collectible.
 * Parts never serve as a second history. No rollback copy is made by ordinary writes. */
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { digest } from './kernel/text.js';
import { Fault } from './kernel/errors.js';

export const TURN_ARCHIVE_VERSION = 4;
export const TURN_CHUNK_CHARS = 65536;
const hash = value => /^[a-f0-9]{64}$/.test(value ?? '');
const invalid = () => new Fault('TURN_BUFFER_INVALID', '轮级分块或清单损坏；保留现场，不用不完整资料继续写。');

// Message.text is the canonical visible body. Preserve block boundaries with
// ranges rather than storing the same text again inside public.content.
function encodePublicText(state) {
  return { ...state, textReferences: 1, rounds: state.rounds.map(round => ({ ...round, messages: round.messages.map(message => {
    if (!Array.isArray(message.public?.content)) return message;
    let cursor = 0;
    const content = message.public.content.map(block => {
      if (block.type !== 'text' || typeof block.text !== 'string' || !block.text.length) return block;
      const offset = message.text.indexOf(block.text, cursor);
      if (offset < 0) return block;
      cursor = offset + block.text.length;
      const { text, ...rest } = block;
      return { ...rest, textRange: [offset, text.length] };
    });
    return { ...message, public: { ...message.public, content } };
  }) })) };
}
function decodePublicText(state) {
  if (state.textReferences === undefined) return state;
  if (state.textReferences !== 1 || !Array.isArray(state.rounds)) throw invalid();
  for (const round of state.rounds) for (const message of round.messages ?? []) {
    if (!Array.isArray(message.public?.content)) continue;
    message.public.content = message.public.content.map(block => {
      if (!Object.hasOwn(block, 'textRange')) return block;
      const range = block.textRange;
      if (block.type !== 'text' || typeof message.text !== 'string' || !Array.isArray(range) || range.length !== 2
          || range.some(n => !Number.isSafeInteger(n) || n < 0) || range[0] + range[1] > message.text.length) throw invalid();
      const { textRange, ...rest } = block;
      return { ...rest, text: message.text.slice(range[0], range[0] + range[1]) };
    });
  }
  delete state.textReferences;
  return state;
}

export async function hydrateTurnArchive(file, manifest) {
  if (manifest?.version !== TURN_ARCHIVE_VERSION) return manifest;
  if (!Array.isArray(manifest.parts) || !hash(manifest.payloadHash)
      || manifest.parts.some(part => !hash(part)) || manifest.rounds !== undefined) throw invalid();
  const chunks = [];
  for (const part of manifest.parts) {
    const chunk = JSON.parse(await readFile(`${file}.part-${part}`, 'utf8'));
    if (typeof chunk !== 'string' || chunk.length > TURN_CHUNK_CHARS || digest(chunk) !== part) throw invalid();
    chunks.push(chunk);
  }
  const text = chunks.join('');
  if (digest(text) !== manifest.payloadHash) throw invalid();
  const state = JSON.parse(text);
  if (state.version !== TURN_ARCHIVE_VERSION || state.session !== manifest.session || state.project !== manifest.project
      || state.nextSeq !== manifest.nextSeq || state.floor !== manifest.floor) throw invalid();
  return decodePublicText(state);
}

export async function saveTurnArchive(file, state, save) {
  state.version = TURN_ARCHIVE_VERSION;
  const text = JSON.stringify(encodePublicText(state)); const parts = [];
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(text.length, offset + TURN_CHUNK_CHARS);
    // Hash intact Unicode: UTF-8 would map a split surrogate to a replacement
    // character, making distinct partial surrogate strings hash identically.
    const high = text.charCodeAt(end - 1); const low = text.charCodeAt(end);
    if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) end--;
    const chunk = text.slice(offset, end); const key = digest(chunk); offset = end;
    parts.push(key);
    // Content addressed, immutable, and synced before publishing its reference.
    try {
      const present = JSON.parse(await readFile(`${file}.part-${key}`, 'utf8'));
      if (present !== chunk) throw invalid();
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; await save(`${file}.part-${key}`, chunk); }
  }
  await save(file, { version: TURN_ARCHIVE_VERSION, project: state.project, session: state.session,
    nextSeq: state.nextSeq, floor: state.floor, payloadHash: digest(text), parts });
  await collectTurnArchive(file, new Set(parts));
}

export async function collectTurnArchive(file, retained) {
  let files;
  try { files = await readdir(dirname(file)); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const prefix = `${basename(file)}.part-`;
  for (const name of files) {
    if (new RegExp(`^${basename(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\.migration-backup)?\\.tmp-[a-f0-9-]+$`).test(name)) {
      await rm(join(dirname(file), name), { force: true }); continue;
    }
    if (!name.startsWith(prefix)) continue;
    const key = name.slice(prefix.length);
    if (hash(key) && !retained.has(key) || /^[a-f0-9]{64}\.tmp-[a-f0-9-]+$/.test(key)) {
      await rm(join(dirname(file), name), { force: true });
    }
  }
}

export async function turnArchiveBytes(file) {
  let files;
  try { files = await readdir(dirname(file)); } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  let bytes = 0;
  for (const name of files) if (name === basename(file) || name.startsWith(`${basename(file)}.`)) {
    const info = await stat(join(dirname(file), name)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info?.isFile()) bytes += info.size;
  }
  return bytes;
}
