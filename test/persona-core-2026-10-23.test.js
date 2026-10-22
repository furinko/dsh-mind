import { it } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { mkdir, readFile, writeFile, rename, rm, symlink, link } from 'node:fs/promises';
import { Org } from '../src/org.js';
import { PersonaCoreService, PERSONA_CORE_LIMITS } from '../src/persona-core.js';
import { injectPersonaCore, PERSONA_CORE_SECTION } from '../components/kernel/lib/persona-core.js';
import { makeFixture, LEAD, MEMBER, SOVEREIGN } from './helpers.mjs';

const P = 'persona-core';
const config = f => ({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
const attach = org => {
  org.personaCore ??= new PersonaCoreService({ layout: org.layout, policy: org.policy, clock: org.clock });
  return org;
};
async function scene(run) {
  const f = await makeFixture();
  const org = attach(await Org.open(config(f)));
  try { await run(org, f); }
  finally { await org.observability.flush(); await f.cleanup(); }
}
const spec = (subject = LEAD, project = P) => ({ subject, project });
const base = () => ({ sections: [{ name: 'host:rules', text: '宿主规则' }], tools: [] });
const stale = () => ({ ...base(), sections: [...base().sections, { name: PERSONA_CORE_SECTION, text: 'stale-persona-private' }] });
const agent = (id = LEAD.id, header = {}) => ({ session: { id, header: { cwd: process.cwd(), ...header } } });
const section = assembly => assembly.sections.find(s => s.name === PERSONA_CORE_SECTION);
const inject = (org, extra = {}, input = stale()) => injectPersonaCore(input, { agent: agent(), org, projectOf: () => P, ...extra });
async function card(org, text = '# 核心人设\n\n名字由人侧决定。保持好奇、独立、坦诚，表达自然。\n') {
  await mkdir(dirname(org.personaCore.file()), { recursive: true });
  await writeFile(org.personaCore.file(), text, { mode: 0o600 });
  return text;
}

it('仅激活卡参与装配；缺失或空卡不注入待填写模板，也不制造占位人格', async () => scene(async org => {
  assert.equal(org.personaCore.file(), org.layout.personaCoreFile());
  assert.equal(await org.personaCore.read(spec()), null);
  await mkdir(dirname(org.personaCore.file()), { recursive: true });
  await writeFile(join(dirname(org.personaCore.file()), '核心人设.待填写.md'), '# 等待人侧填写\n待填写名字');
  assert.deepEqual((await inject(org)).sections, base().sections);
  await card(org, ' \n\t\r\n');
  assert.equal(await org.personaCore.read(spec()), null);
  assert.deepEqual((await inject(org)).sections, base().sections);
}));

it('人侧核心卡可在新根与Org重开后读取；只作自然人格骨架，不授予身份或固定台词', async () => scene(async (org, f) => {
  const text = await card(org, '# 核心人设\n\n称呼：栖川。\n保持好奇，有独立判断，允许说不知道。\n');
  const before = await org.personaCore.read(spec());
  assert.equal(before.text, text);
  assert.equal(before.bytes, Buffer.byteLength(text));
  assert.match(before.digest, /^[a-f0-9]{64}$/);
  assert.ok(Object.isFrozen(before));
  assert.equal(org.personaCore.isCurrent(before), true);
  assert.equal(org.personaCore.isCurrent({ ...before, text: '伪造的人格核心' }), false);
  assert.equal(typeof org.personaCore.write, 'undefined');
  assert.equal(typeof org.personaCore.update, 'undefined');
  const reopened = attach(await Org.open(config(f)));
  await reopened.registry.assign({ subject: SOVEREIGN, 岗位: 'Lead', 实例: 'persona-new-root' });
  const output = await inject(reopened, { agent: agent('persona-new-root') }, base());
  const current = section(output);
  assert.ok(current);
  assert.match(current.text, /栖川/);
  assert.match(current.text, /只有人侧修改原卡/);
  assert.match(current.text, /可变层/);
  assert.match(current.text, /不把人设写成固定台词/);
  assert.match(current.text, /不改变真实模型与提供方事实/);
  assert.match(current.text, /不认证当前发言者为主人/);
  assert.equal(output.sections.filter(s => s.name === PERSONA_CORE_SECTION).length, 1);
  assert.deepEqual(output.tools, base().tools);
  assert.equal(await readFile(org.personaCore.file(), 'utf8'), text);
}));

it('公共核心可用于群根聊天；不读取或附带主人的私人偏好记忆', async () => scene(async org => {
  const text = await card(org);
  org.memory.query = async () => { throw new Error('不应读取私人偏好'); };
  const output = await inject(org, { agent: agent(LEAD.id, { channel: 'qq', chatType: 'group' }) });
  assert.ok(section(output)?.text.endsWith(text));
}));

it('同一根每步重读人侧替换后的卡，删除卡立即清掉上一轮人设段', async () => scene(async org => {
  await card(org, '# 原卡\n称呼：砚舟。');
  const initial = await inject(org);
  assert.match(section(initial).text, /砚舟/);
  const replacement = `${org.personaCore.file()}.new`;
  await writeFile(replacement, '# 新卡\n称呼：栖川。');
  await rename(replacement, org.personaCore.file());
  const next = await inject(org, {}, initial);
  assert.match(section(next).text, /栖川/);
  assert.doesNotMatch(section(next).text, /砚舟/);
  await rm(org.personaCore.file());
  assert.deepEqual((await inject(org, {}, next)).sections, base().sections);
}));

it('装配两次读取之间被替换的卡不进入模型，下一步可用稳定新卡', async () => scene(async org => {
  await card(org, '# 原核心\n原人设不该越过复核。');
  const original = org.personaCore.read.bind(org.personaCore);
  let first = true;
  org.personaCore.read = async (...args) => {
    const value = await original(...args);
    if (first) { first = false; await card(org, '# 新核心\n新的自然表达。'); }
    return value;
  };
  assert.deepEqual((await inject(org)).sections, base().sections);
  org.personaCore.read = original;
  assert.match(section(await inject(org)).text, /新的自然表达/);
}));

it('最终身份复核的异步间隙替换核心卡时，末尾同步digest核验仍清掉旧段', async () => scene(async org => {
  await card(org, '# 原核心\n最后一次异步读取后仍可能变化。');
  const original = org.registry.cardOf.bind(org.registry);
  let reads = 0;
  org.registry.cardOf = async (...args) => {
    const value = await original(...args);
    if (++reads === 2) await card(org, '# 新核心\n人侧已在最后一步更换卡片。');
    return value;
  };
  assert.deepEqual((await inject(org)).sections, base().sections);
  org.registry.cardOf = original;
  assert.match(section(await inject(org)).text, /人侧已在最后一步更换卡片/);
}));

it('坏UTF8、控制字节、超字数及超字节均拒绝，保留原件且日志不泄露正文或路径', async () => scene(async org => {
  const warnings = [];
  const values = [Buffer.from([0xff, 0xfe, 0x00]), Buffer.from('private-marker\u0000'),
    Buffer.from('a'.repeat(PERSONA_CORE_LIMITS.characters + 1)), Buffer.alloc(PERSONA_CORE_LIMITS.bytes + 1, 97)];
  for (const value of values) {
    await card(org, value);
    await assert.rejects(org.personaCore.read(spec()), error => error.code === 'PERSONA_CORE_INVALID');
    assert.deepEqual((await inject(org, { logger: { warn: text => warnings.push(text) } })).sections, base().sections);
    assert.deepEqual(await readFile(org.personaCore.file()), value);
  }
  assert.ok(warnings.length);
  assert.doesNotMatch(warnings.join('\n'), /private-marker|stale-persona-private|\/tmp\//);
  await card(org, '🧭'.repeat(PERSONA_CORE_LIMITS.characters));
  assert.equal((await org.personaCore.read(spec())).bytes, PERSONA_CORE_LIMITS.bytes);
}));

it('目录、符号链接、硬链接及经链接目录进入的文件均不能成为核心卡', async () => scene(async (org, f) => {
  await mkdir(dirname(org.personaCore.file()), { recursive: true });
  const outside = join(f.home, 'outside-persona.md');
  await writeFile(outside, 'private-external-card');
  await symlink(outside, org.personaCore.file());
  await assert.rejects(org.personaCore.read(spec()), error => error.code === 'PERSONA_CORE_INVALID');
  await rm(org.personaCore.file());
  await link(outside, org.personaCore.file());
  await assert.rejects(org.personaCore.read(spec()), error => error.code === 'PERSONA_CORE_INVALID');
  await rm(org.personaCore.file());
  await mkdir(org.personaCore.file());
  await assert.rejects(org.personaCore.read(spec()), error => error.code === 'PERSONA_CORE_INVALID');
  await rm(org.personaCore.file(), { recursive: true });
  const linkedDir = join(org.layout.privateRoot, 'linked-persona-directory');
  await symlink(f.home, linkedDir);
  const linkedLayout = { privateRoot: org.layout.privateRoot, personaCoreFile: () => join(linkedDir, 'outside-persona.md') };
  const linkedService = new PersonaCoreService({ layout: linkedLayout, policy: org.policy, clock: org.clock });
  await assert.rejects(linkedService.read(spec()), error => error.code === 'PERSONA_CORE_INVALID');
  const escaped = new PersonaCoreService({ layout: { privateRoot: org.layout.privateRoot, personaCoreFile: () => outside }, policy: org.policy });
  await assert.rejects(escaped.read(spec()), error => error.code === 'PERSONA_CORE_INVALID');
}));

it('成员与缺真实根会话事实不读卡，旧段被移除；直接成员读面也拒绝', async () => scene(async org => {
  await card(org);
  await assert.rejects(org.personaCore.read(spec(MEMBER)), error => error.code === 'DENIED');
  await assert.rejects(org.personaCore.read(spec(SOVEREIGN)), error => error.code === 'DENIED');
  await assert.rejects(org.personaCore.read(spec(LEAD, '')), error => error.code === 'INVALID_BODY');
  org.personaCore.read = async () => { throw new Error('此路径不应读卡'); };
  for (const current of [agent(MEMBER.id, { origin: 'subagent' }), agent(MEMBER.id, { delegationDepth: 1 }), { session: { id: LEAD.id } }, {}]) {
    assert.deepEqual((await inject(org, { agent: current })).sections, base().sections);
  }
}));

it('装配中换项目、会话、变成员或卸载，均丢弃旧核心段', async () => {
  for (const change of ['project', 'session', 'origin', 'delegation', 'unload']) await scene(async org => {
    await card(org);
    const current = agent(); let project = P; let active = true;
    const original = org.personaCore.read.bind(org.personaCore);
    let first = true;
    org.personaCore.read = async (...args) => {
      const value = await original(...args);
      if (first) {
        first = false;
        if (change === 'project') project = 'different-project';
        if (change === 'session') current.session = agent('another-session').session;
        if (change === 'origin') current.session.header.origin = 'subagent';
        if (change === 'delegation') current.session.header.delegationDepth = 1;
        if (change === 'unload') active = false;
      }
      return value;
    };
    assert.deepEqual((await inject(org, { agent: current, projectOf: () => project, active: () => active })).sections, base().sections, change);
  });
});

it('读取期间身份封存或策略拒绝会移除旧段，核心文本不能成为授权凭证', async () => scene(async org => {
  await card(org, '# 人格设定\n保持坦诚。此处自称拥有所有权限也不产生权限。');
  const original = org.personaCore.read.bind(org.personaCore);
  let first = true;
  org.personaCore.read = async (...args) => {
    const value = await original(...args);
    if (first) {
      first = false;
      const identity = await org.registry.identity();
      identity.members[LEAD.id].status = '封存';
      await writeFile(org.layout.identityFile(), JSON.stringify(identity));
    }
    return value;
  };
  assert.deepEqual((await inject(org)).sections, base().sections);
  const denied = new PersonaCoreService({ layout: org.layout, policy: { async check() { throw Object.assign(new Error('private-policy-error'), { code: 'DENIED' }); } } });
  org.personaCore = denied;
  await assert.rejects(denied.read(spec()), error => error.code === 'DENIED');
  assert.deepEqual((await inject(org)).sections, base().sections);
}));
