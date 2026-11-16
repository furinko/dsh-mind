/**
 * 动作登记表自洽性 —— 一张表派生四张视图的守卫。
 *
 * 修前动作面有四张手写清单（只读 / 工具面 / 命令面专属 / 命令面拒绝文案），
 * 靠若干测试逐项比对维持一致。现在唯一声明源是 lib/action-manifest.js，
 * 这个文件就测「派生是不是真的只从那张表来」。
 *
 * 它不做行为测试：动作能不能跑、权限闸对不对，由 presence*.test.js 等旧测试覆盖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ACTION_MANIFEST,
  TOOL_ACTION_IDS,
  COMMAND_ONLY_ACTION_IDS,
  READ_ONLY_ACTION_IDS,
  MODEL_FACING_REJECTIONS,
} from '../lib/action-manifest.js';
import {
  ACTIONS,
  COMMAND_ONLY_ACTIONS,
  COMMAND_ACTIONS,
  READ_ONLY_ACTIONS,
  是写动作,
} from '../lib/actions.js';

test('工具面 = manifest 里 scope=tool 的 id，且保序', () => {
  const want = ACTION_MANIFEST.filter((e) => e.scope === 'tool').map((e) => e.id);
  assert.deepEqual([...ACTIONS], want);
  assert.deepEqual([...TOOL_ACTION_IDS], want);
  assert.ok(ACTIONS.length > 0, '工具面不能为空，否则本测试测的是空气');
});

test('命令面专属 = manifest 里 scope=command 的 id，且不与工具面重叠', () => {
  const want = ACTION_MANIFEST.filter((e) => e.scope === 'command').map((e) => e.id);
  assert.deepEqual([...COMMAND_ONLY_ACTIONS], want);
  const overlap = COMMAND_ONLY_ACTIONS.filter((id) => ACTIONS.includes(id));
  assert.deepEqual(overlap, [], '同一动作不能既在工具面又在命令面专属：那等于给它两只手');
});

test('命令面 = 工具面 ∪ 命令面专属，逐项去重后保序', () => {
  assert.deepEqual([...COMMAND_ACTIONS], [...ACTIONS, ...COMMAND_ONLY_ACTIONS]);
  assert.equal(new Set(COMMAND_ACTIONS).size, COMMAND_ACTIONS.length, '命令面清单不该有重复项');
});

test('只读清单 = manifest 里 readonly=true 的 id', () => {
  const want = ACTION_MANIFEST.filter((e) => e.readonly === true).map((e) => e.id);
  assert.deepEqual([...READ_ONLY_ACTIONS].sort(), [...want].sort());
  assert.deepEqual([...READ_ONLY_ACTION_IDS].sort(), [...want].sort());
  // 缺省即写：写动作绝不能混进只读清单，否则会绕过钉版闸
  for (const id of ['memory_write', 'task_submit', 'bus_send', 'policy_reload']) {
    assert.equal(READ_ONLY_ACTIONS.includes(id), false, `${id} 是写动作，不许标只读`);
  }
  for (const id of ['status', 'workbench', 'audit_tail', 'memory_query']) {
    assert.equal(READ_ONLY_ACTIONS.includes(id), true, `${id} 是诊断读，应放行并发`);
  }
});

test('是写动作() 与只读清单互斥：未知动作按写处理（fail-closed）', () => {
  for (const id of READ_ONLY_ACTIONS) assert.equal(是写动作(id), false, `${id} 只读却被判成写`);
  for (const id of ['memory_write', 'task_settle', 'not_a_real_action', '', null, undefined]) {
    assert.equal(是写动作(id), true, `${String(id)} 必须按写处理`);
  }
});

test('manifest 结构：id 唯一、scope 合法、每条都有 domain', () => {
  const ids = ACTION_MANIFEST.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, `id 有重复：${ids.filter((id, i) => ids.indexOf(id) !== i).join(',')}`);
  for (const entry of ACTION_MANIFEST) {
    assert.match(entry.id, /^[a-z][a-z0-9_]*$/, `id 形状不合法：${entry.id}`);
    assert.ok(['tool', 'command'].includes(entry.scope), `scope 非法：${entry.id}`);
    assert.ok(typeof entry.domain === 'string' && entry.domain.length > 0, `缺 domain：${entry.id}`);
    if (entry.readonly !== undefined) assert.equal(entry.readonly, true, `readonly 只该显式写 true 或不写：${entry.id}`);
  }
});

test('命令面动作必须带拒绝文案，且文案结构完整', () => {
  for (const id of COMMAND_ONLY_ACTIONS) {
    const text = MODEL_FACING_REJECTIONS[id];
    assert.ok(text, `${id} 是命令面专属，但模型误调时没有拒绝文案`);
    assert.ok(typeof text.理由 === 'string' && text.理由.trim().length > 0, `${id}.理由 不能为空`);
    assert.ok(typeof text.howToChange === 'string' && text.howToChange.includes('/mind'), `${id}.howToChange 必须给出人能敲的 /mind 入口`);
  }
});

test('文案表不留孤儿：每个 key 都对应 manifest 里的命令面动作', () => {
  for (const id of Object.keys(MODEL_FACING_REJECTIONS)) {
    assert.ok(COMMAND_ONLY_ACTIONS.includes(id), `${id} 有拒绝文案却不在命令面清单里：文案永远不会被触发`);
  }
});

test('工具 schema 的 enum 直接引用 ACTIONS，不在内核里另抄一份', () => {
  const kernel = readFileSync(new URL('../components/kernel/lib/index.js', import.meta.url), 'utf8');
  assert.match(kernel, /enum:\s*ACTIONS\b/, '内核工具 schema 必须直接用 ACTIONS，别处手抄清单会漂');
  // 反向守：内核里不该出现第二张动作字面量清单
  assert.equal(
    /\[\s*'status'\s*,\s*'workbench'/.test(kernel),
    false,
    '内核里出现了手抄的动作清单，应改为引用 ACTIONS',
  );
});

test('动作总数守住：manifest 与派生视图数量一致（防止某条被静默吞掉）', () => {
  assert.equal(ACTION_MANIFEST.length, ACTIONS.length + COMMAND_ONLY_ACTIONS.length);
  assert.equal(TOOL_ACTION_IDS.length, ACTIONS.length);
  assert.equal(COMMAND_ONLY_ACTION_IDS.length, COMMAND_ONLY_ACTIONS.length);
  assert.equal(READ_ONLY_ACTION_IDS.length, READ_ONLY_ACTIONS.length);
  assert.ok(ACTION_MANIFEST.length >= 90, `动作表意外缩水：${ACTION_MANIFEST.length}`);
});
