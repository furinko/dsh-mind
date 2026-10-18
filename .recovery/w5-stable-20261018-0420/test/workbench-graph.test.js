/**
 * 能力 × 岗位接线投影（2026-10-13 重做·图谱）。
 *
 * 守四件事：
 *  ① `capability.list()` 给的本机绝对路径 **不许进投影**（`path` 必须被剥掉）；
 *  ② 宿主没给 ⇒ `null`（不装懂）：凭空造空表会让面板把「宿主没给」画成「一张卡都没有」；
 *  ③ 成员切片**拿不到治理面**（能力/岗位/实例计数），非成员拿全量；
 *  ④ 坏实例键（`'undefined'`）单独可见、不混进任何岗位的计数。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectWorkbench, sliceForViewer } from '../src/workbench.js';

const 基础 = { 项目: 'p', 节点: [], 探针: { 结果: [] }, 策略: { healthy: true, rules: [] } };

const 能力样例 = [
  { id: 'assert-with-evidence', 名: 'assert-with-evidence', 来源: '自治', 适用岗位: ['Lead', '复核员'], 摘要: '', path: 'C:/Users/kuro/.dsh/mind-data/mind-private/能力库/assert-with-evidence.md' },
  { id: 'policy-decision', 名: 'policy-decision', 来源: '出厂', 适用岗位: ['Lead'], 摘要: '要写要派的主体都走这一项。', path: 'C:/Users/kuro/.dsh/repos/dsh-mind/mind/能力库/policy-decision.md' },
];
const 岗位样例 = [
  { id: 'Lead', 来源: '私有', 同名: ['私有'], 摘要: '常驻、唯一', 能力引用: ['policy-decision'], 段: ['个体L0'], digest: 'abc' },
  { id: '复核员', 来源: '私有', 同名: ['私有', '出厂'], 摘要: '常驻岗', 能力引用: ['policy-decision', 'assert-with-evidence'], 段: ['个体L0'], digest: 'def' },
];

test('投影：能力/岗位搬结构，剥掉本机绝对路径', () => {
  const view = projectWorkbench({ ...基础, 能力: 能力样例, 岗位: 岗位样例 });
  assert.equal(view.能力.length, 2);
  assert.deepEqual(view.能力[0], { id: 'assert-with-evidence', 来源: '自治', 适用岗位: ['Lead', '复核员'] },
    `能力行只该有 id/来源/适用岗位：${JSON.stringify(view.能力[0])}`);
  assert.equal(JSON.stringify(view).includes('mind-private'), false, '投影里不许出现本机私有区路径');
  assert.equal(JSON.stringify(view).includes('C:/Users/kuro'), false, '投影里不许出现本机绝对路径');
  assert.equal(view.岗位[1].同名.length, 2, '双区同名必须照实带出（吞掉它＝把分歧变成静默覆盖）');
  assert.deepEqual(view.岗位[0].能力引用, ['policy-decision']);
  assert.equal(view.岗位[0].digest, undefined, 'digest 不进投影');
});

test('投影：宿主没给 ⇒ null（不装懂），不许伪造空表', () => {
  const view = projectWorkbench(基础);
  assert.equal(view.能力, null, '宿主没给能力 ⇒ null');
  assert.equal(view.岗位, null, '宿主没给岗位 ⇒ null');
  assert.equal(view.实例计数, null, '宿主没给实例计数 ⇒ null');
});

test('投影：记忆按类透传；没给 ⇒ null', () => {
  const 有 = projectWorkbench({ ...基础, 记忆: { 存量合计: 44, 窗口天: 7, 新增合计: 44, 晋升: 0, 按类: { 经历: 31, 知识: 10, 偏好: 3 } } });
  assert.deepEqual(有.记忆.按类, { 经历: 31, 知识: 10, 偏好: 3 });
  const 无 = projectWorkbench({ ...基础, 记忆: { 存量合计: 44 } });
  assert.equal(无.记忆.按类, null, '宿主没给按类 ⇒ null（不当成空对象）');
});

test('成员切片：治理面（能力/岗位/实例计数）不给，且是 null 不是空表', () => {
  const view = projectWorkbench({ ...基础, 能力: 能力样例, 岗位: 岗位样例, 实例计数: { 按岗位: { Lead: { 在岗: 1, 封存: 0 } }, 异常键: 0, 合计: 1 } });
  const 成员 = sliceForViewer(view, { id: 'member-a', kind: '成员' });
  assert.equal(成员.能力, null, '成员不该拿到能力接线面');
  assert.equal(成员.岗位, null, '成员不该拿到岗位接线面');
  assert.equal(成员.实例计数, null, '成员不该拿到实例规模');
  assert.equal(成员.视图, '只读自己任务那片');
  // 非成员（Lead / 复核者）照给——治理面是他们要看的
  for (const kind of ['Lead', '复核者']) {
    const v = sliceForViewer(view, { id: 'x', kind });
    assert.equal(v.能力.length, 2, `${kind} 应拿到能力面`);
    assert.equal(v.岗位.length, 2, `${kind} 应拿到岗位面`);
  }
});

test('实例计数：坏键 undefined 单独可见，不混进岗位计数', async () => {
  const { 计实例计数 } = await import('../src/org.js');
  const 计数 = 计实例计数({
    members: {
      'undefined': { 岗位: '插件工程', status: '在岗' },
      'a': { 岗位: '插件工程', status: '在岗' },
      'b': { 岗位: '插件工程', status: '封存' },
      'c': { 岗位: '复核员', status: '在岗' },
      'd': { status: '在岗' },
    },
  });
  assert.equal(计数.异常键, 1, "坏键 'undefined' 要单独可见");
  assert.equal(计数.按岗位.插件工程.在岗, 1, '坏键不许混进在岗计数');
  assert.equal(计数.按岗位.插件工程.封存, 1);
  assert.deepEqual(计数.按岗位.复核员, { 在岗: 1, 封存: 0 });
  assert.equal(计数.按岗位['undefined'], undefined, '坏键不许自成一个岗位');
  assert.equal(计数.合计, 5, '合计含坏键（它也是一条档案记录）');
  // 投影只搬运，不改口径
  const view = projectWorkbench({ ...基础, 实例计数: 计数 });
  assert.deepEqual(view.实例计数, 计数);
});
