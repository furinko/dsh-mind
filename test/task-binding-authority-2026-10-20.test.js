import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeFixture, LEAD, MEMBER } from './helpers.mjs';
import { Org } from '../src/org.js';
import { runAction } from '../lib/actions.js';
import { readTaskLedger } from '../src/task-ledger.js';

const PROJECT = 'task-binding-authority';
const OTHER = { id: 'member-b', kind: '成员', roleId: '插件工程' };
const bindingDenied = error => error?.code === 'DENIED' && /真实实例绑定/.test(error.message);

async function fixture(body) {
  const f = await makeFixture();
  let org;
  try {
    org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: PROJECT });
    const run = (subject, args) => runAction({ org, 项目: PROJECT, 主体: subject, args });
    const create = async ({ bind = true, owners = ['插件工程'] } = {}) => {
      const node = await org.tasks.create({ subject: LEAD, 项目: PROJECT, 描述: '绑定隔离与失联接续', 负责人: owners, 判据: ['保留原署名和判据'] });
      if (bind) await org.tasks.bind(node.id, { subject: LEAD, 项目: PROJECT, 实例: MEMBER.id, 岗位: '插件工程' });
      await org.tasks.dispatch(node.id, { subject: LEAD, 项目: PROJECT });
      return node.id;
    };
    await body({ f, org, run, create });
  } finally {
    await org?.observability.flush();
    await f.cleanup();
  }
}

describe('真实任务绑定优先于岗位和负责人回退', () => {
  it('本人当前凭证允许真实动作；同岗未绑定实例不能开工或借旧任务写记忆', async () => {
    await fixture(async ({ org, run, create }) => {
      const id = await create();
      await assert.rejects(() => run(OTHER, { action: 'task_start', id }), bindingDenied);
      assert.equal((await org.tasks.get(id, { 项目: PROJECT })).状态, '已派发');
      assert.equal((await run(MEMBER, { action: 'task_start', id })).节点.状态, '执行中');
      const memory = await run(MEMBER, { action: 'memory_write', 类: '经历', 内容: '本人的真实任务结果', 来源: '绑定本人', 任务: id });
      assert.ok(memory.条目?.id);
      await assert.rejects(() => run(OTHER, { action: 'memory_write', 类: '经历', 内容: '借同岗任务写入', 来源: '未绑定同岗', 任务: id }), bindingDenied);
    });
  });

  it('已有绑定时负责人名单中的另一个实例也不能绕过真实绑定', async () => {
    await fixture(async ({ run, create }) => {
      const id = await create({ owners: [MEMBER.id, OTHER.id] });
      await assert.rejects(() => run(OTHER, { action: 'task_start', id }), bindingDenied);
      assert.equal((await run(MEMBER, { action: 'task_start', id })).节点.状态, '执行中');
    });
  });

  it('旧实例封存并挂待决后，同岗新实例不能恢复或修改旧任务，旧实例也不能再交卷', async () => {
    await fixture(async ({ org, run, create }) => {
      const id = await create();
      await run(MEMBER, { action: 'task_start', id });
      await org.registry.seal({ subject: LEAD, 实例: MEMBER.id, 理由: '失联；宿主停止状态未知' });
      await run(LEAD, { action: 'task_pending', id, 原因: '由 Lead 另建后继，旧结果留存' });
      await assert.rejects(() => run(OTHER, { action: 'task_resolve', id, 决定: '同岗新实例擅自恢复' }), bindingDenied);
      await assert.rejects(() => run(OTHER, { action: 'memory_write', 类: '经历', 内容: '旧任务不能变成新实例的写凭据', 来源: '反例', 任务: id }), bindingDenied);
      await assert.rejects(() => run(MEMBER, { action: 'memory_write', 类: '经历', 内容: '封存实例不再有新写权', 来源: '旧实例反例', 任务: id }), error => error?.code === 'DENIED' && /封存|不在岗|不是在岗/.test(error.message));
      await assert.rejects(() => run(MEMBER, { action: 'task_submit', id, 结论: '封存实例迟到交卷' }), error => error?.code === 'DENIED');
      assert.equal((await org.tasks.get(id, { 项目: PROJECT })).状态, '待决');
    });
  });

  it('已有绑定但缺少凭证的旧行保持可读，不能降格为无绑定兼容路径续写', async () => {
    await fixture(async ({ org, run, create }) => {
      const id = await create({ bind: false });
      const file = org.layout.taskLog(PROJECT);
      const rows = await readTaskLedger(file);
      // 播种真实历史形状：早期 bound 事件没有凭证，读面仍保留它，写面不得猜当前凭证。
      await appendFile(file, `${JSON.stringify({ seq: rows.length + 1, at: new Date().toISOString(), by: LEAD, kind: 'bound', id,
        绑定: { 实例: MEMBER.id, 岗位: '插件工程', 于: new Date().toISOString() } })}\n`, 'utf8');
      assert.equal((await org.tasks.get(id, { 项目: PROJECT })).绑定[0].实例, MEMBER.id);
      await assert.rejects(() => run(MEMBER, { action: 'task_start', id }), bindingDenied);
    });
  });

  it('完全无绑定的旧任务保留岗位回退与实例直配正控', async () => {
    await fixture(async ({ run, create }) => {
      const roleTask = await create({ bind: false });
      assert.equal((await run(OTHER, { action: 'task_start', id: roleTask })).节点.状态, '执行中');
      assert.ok((await run(MEMBER, { action: 'memory_write', 类: '经历', 内容: '无绑定旧任务仍按岗寻址', 来源: 'legacy正控', 任务: roleTask })).条目?.id);
      const instanceTask = await create({ bind: false, owners: [MEMBER.id] });
      await assert.rejects(() => run(OTHER, { action: 'task_start', id: instanceTask }), error => error?.code === 'DENIED');
      assert.equal((await run(MEMBER, { action: 'task_start', id: instanceTask })).节点.状态, '执行中');
    });
  });

  for (const change of ['岗位', '代', '卡', '宿主代次']) it(`${change}变更不能继承旧绑定；未变凭证的正规复岗可以继续`, async () => {
    await fixture(async ({ f, org, run, create }) => {
      const id = await create();
      await run(MEMBER, { action: 'task_start', id });
      await org.registry.seal({ subject: LEAD, 实例: MEMBER.id, 理由: '普通停岗' });
      await org.registry.restore({ subject: LEAD, 实例: MEMBER.id });
      assert.ok((await run(MEMBER, { action: 'memory_write', 类: '经历', 内容: '同岗同代同卡复岗正控', 来源: '正规复岗', 任务: id })).条目?.id);
      const card = await readFile(join(f.factoryRoot, '集体L3-成员角色卡/插件工程.md'), 'utf8');
      await f.write('集体L3-成员角色卡/替补工程.md', card.replaceAll('插件工程', '替补工程'));
      await org.registry.seal({ subject: LEAD, 实例: MEMBER.id, 理由: '显式换岗' });
      await org.registry.assign({ subject: LEAD, 实例: MEMBER.id, 岗位: '替补工程' });
      if (change !== '岗位') {
        await org.registry.seal({ subject: LEAD, 实例: MEMBER.id, 理由: '换回原岗但凭证已变' });
        if (change === '卡') await f.write('集体L3-成员角色卡/插件工程.md', card.replace('1. 先定判据再干活。', '1. 先定判据再干活。\n2. 新版新增限制。'));
        await org.registry.assign({ subject: LEAD, 实例: MEMBER.id, 岗位: '插件工程',
          ...(change === '代' ? { 代: 2 } : {}),
          ...(change === '宿主代次' ? { 代次: { 代: 'new-host-generation', pid: process.pid } } : {}),
        });
      }
      await assert.rejects(() => run({ id: MEMBER.id, kind: '成员' }, { action: 'memory_write', 类: '经历', 内容: '新凭证不能续写旧任务', 来源: '旧绑定反例', 任务: id }), bindingDenied);
    });
  });

  it('真实卡快照失效仍由统一凭证闸拒绝，绑定中的相同摘要不构成豁免', async () => {
    await fixture(async ({ org, run, create }) => {
      const id = await create();
      await run(MEMBER, { action: 'task_start', id });
      const member = (await org.registry.identity()).members[MEMBER.id];
      const file = org.layout.cardSnapshot(member.卡版本.摘要);
      const snapshot = JSON.parse(await readFile(file, 'utf8'));
      await writeFile(file, JSON.stringify({ ...snapshot, 正文: `${snapshot.正文}\n被篡改的规则` }), 'utf8');
      await assert.rejects(() => run(MEMBER, { action: 'memory_write', 类: '经历', 内容: '坏卡不能再写', 来源: '快照失效反例', 任务: id }), error => error?.code === 'DENIED' && /快照|校验/.test(error.message));
    });
  });
});
