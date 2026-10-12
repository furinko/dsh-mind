#!/usr/bin/env node
/**
 * 债⑳ 取证探针（只读 · 2026-10-13 主权者裁决乙）
 *
 * 取什么证：subject.js「非子会话 ⇒ Lead」是 fail-open 推断——宿主若改了 agent 形状，
 * 成员子会话会被静默判成 Lead。探针不猜形状，**读审计账上的真实主体记录**：
 * 每一次 mind 工具调用都按真实主体入账，对比「你明知是子会话干的活」与「账上记的主体」
 * 是否一致，就是 fail-open 有没有被触发的直接证据。
 *
 * 用法：
 *   node tools/probe-agent-shape.mjs [私有区根目录]
 *   —— 不传参时自动在 ~/.dsh 下找「审计」目录。
 *
 * 配套动作（取证两臂）：
 *   ① 根会话里随便调一次 mind（如 mind workbench）；
 *   ② 让一个子代理也调一次 mind；
 *   ③ 跑本脚本：②那次的账上主体必须是「成员」而不是「Lead」。
 *
 * 本脚本只读：不写、不改、不联网。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function* 找审计目录(root, depth = 0) {
  if (depth > 6) return;
  let entries;
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    const p = join(root, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    if (name === '审计日志' || name === '审计') {
      yield p;
      continue;
    }
    if (['node_modules', '.git', '$RECYCLE.BIN', 'AppData'].includes(name)) continue;
    yield* 找审计目录(p, depth + 1);
  }
}

function 读行(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

const 给定 = process.argv[2];
const 候选 = 给定 ? [给定] : [...找审计目录(join(homedir(), '.dsh'))];
if (候选.length === 0) {
  console.log('没找到任何「审计」目录。请把私有区根目录（含 审计/ 的那层）作为参数传进来。');
  process.exit(2);
}

for (const 审计目录 of 候选) {
  console.log(`\n═══ 审计目录：${审计目录}`);
  const files = readdirSync(审计目录).filter((f) => f.endsWith('.jsonl') || /^audit-.*\.json$/.test(f)).sort();
  /** 主体形状统计：kind → Set(id 样例) */
  const 形状 = new Map();
  const 工具调用 = [];
  for (const f of files) {
    for (const row of 读行(join(审计目录, f))) {
      const 主体 = row.主体;
      const key = typeof 主体 === 'string' ? 主体 : JSON.stringify(主体);
      const kind = typeof 主体 === 'object' && 主体 ? (主体.kind ?? '?') : '字符串';
      if (!形状.has(kind)) 形状.set(kind, new Set());
      形状.get(kind).add(key.length > 60 ? `${key.slice(0, 60)}…` : key);
      if (row.动作 === '工具调用' || /工具/.test(String(row.动作))) 工具调用.push({ 文件: f, 主体: key, 结果: row.结果 });
    }
  }
  console.log('账上出现过的主体 kind 分布：');
  for (const [kind, ids] of 形状) {
    console.log(`  ${kind} × ${ids.size}：${[...ids].slice(0, 5).join('，')}${ids.size > 5 ? ' …' : ''}`);
  }
  const 身份档案 = join(审计目录, '..', '身份档案', 'identity.json');
  if (existsSync(身份档案)) {
    try {
      const 档案 = JSON.parse(readFileSync(身份档案, 'utf8'));
      const members = Object.keys(档案.members ?? {});
      console.log(`身份档案成员：${members.length ? members.join('，') : '（空——还没有成员实例）'}`);
    } catch (e) {
      console.log(`身份档案读不出来：${e.message}`);
    }
  }
  console.log('\n判读指引：');
  console.log('  · 如果你让子代理调过 mind，而上面只有 Lead、没有 成员 ⇒ fail-open 实锤，债⑳ 必须修；');
  console.log('  · 子代理的调用记成了 成员（带 roleId）⇒ 现行推断在你这版宿主上是成立的，债⑳ 降为「宿主升级时复验」；');
  console.log('  · 把本输出原样贴回会话，我按证据落修法。');
}
