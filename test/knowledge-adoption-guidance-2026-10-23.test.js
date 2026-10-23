import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeFixture, LEAD, MEMBER } from './helpers.mjs';
import { Org } from '../src/org.js';
import { runAction } from '../lib/actions.js';
import { recallProfessionalContext } from '../src/professional-context.js';
import { injectProfessionalContext } from '../components/kernel/lib/professional-context.js';

it('交卷后不提供自动段，不改写既有采用声明及来源，说明不认证采用或收益', async () => {
  const f = await makeFixture(), P = 'adoption-guidance';
  try {
    const org = await Org.open({ home: f.home, privateRoot: f.privateRoot, factoryRoot: f.factoryRoot, project: P });
    const knowledge = await org.memory.remember({ subject: LEAD, 项目: P, 类: '知识', 岗位: MEMBER.roleId,
      内容: 'nebula 增量解码应跨块保留字符状态', 来源: '独立合成夹具' });
    const task = await org.tasks.create({ subject: LEAD, 项目: P, 负责人: MEMBER.roleId, 描述: 'nebula 解码交付', 判据: ['nebula'] });
    await org.tasks.bind(task.id, { subject: LEAD, 项目: P, 实例: MEMBER.id, 岗位: MEMBER.roleId });
    await org.tasks.dispatch(task.id, { subject: LEAD, 项目: P });
    await org.tasks.start(task.id, { subject: MEMBER, 项目: P });
    const before = await recallProfessionalContext({ org, subject: MEMBER, project: P });
    assert.deepEqual(before.知识.map(row => row.id), [knowledge.id]);
    const contextOptions = { agent: { session: { id: MEMBER.id, header: { cwd: process.cwd(), origin: 'subagent', delegationDepth: 1 } } }, org, projectOf: () => P };
    const activeAssembly = await injectProfessionalContext({ sections: [] }, contextOptions);
    assert.match(activeAssembly.sections[0].text, /看到不等于采用/);
    const result = await runAction({ org, 项目: P, 主体: MEMBER, args: { action: 'task_submit', id: task.id,
      结论: '交付待验收', 采用知识: [{ id: knowledge.id, 用途: '检查跨块状态', 适用判断: '输入为分块字节', 使用结果: '未知' }] } });
    assert.match(result.知识采用说明, /交卷后变空不证明此前未召回/);
    assert.match(result.知识采用说明, /来源哈希不证明实际使用或收益/);
    const log = await readFile(org.layout.taskLog(P), 'utf8');
    const after = await recallProfessionalContext({ org, subject: MEMBER, project: P });
    assert.deepEqual(after.知识, []);
    const assembly = await injectProfessionalContext(activeAssembly, contextOptions);
    assert.deepEqual(assembly.sections, [], '未执行查询时不提供空结果，也不续用旧段');
    const query = await org.knowledgeReuse.query({ subject: LEAD, 项目: P, 任务: task.id });
    const entry = query.采用页.条目[0].采用知识[0];
    assert.equal(entry.id, knowledge.id); assert.equal(entry.使用结果, '未知');
    assert.equal(entry.来源.状态, '可核来源版本');
    assert.equal(await readFile(org.layout.taskLog(P), 'utf8'), log, '空召回与只读核对不回写旧声明');
    assert.ok(result.节点.独立答案.every(row => !Object.hasOwn(row, '采用知识')), '不扩大普通任务投影的来源读面');
  } finally { await f.cleanup(); }
});
