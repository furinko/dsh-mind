import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fault, describeFailure } from '../src/kernel/errors.js';

test('对外提交回执只保留显式安全字段，不反射detail、正文或宿主原始异常', () => {
  const fault = new Fault('POST_COMMIT', '消息已接收，审计失败。', {
    detail: { 内容: 'PRIVATE-CONTENT', 宿主异常: 'PRIVATE-HOST' },
    outcome: { 提交状态: '已提交', 可重试: false, 恢复指引: '按消息id查询，不要重发。',
      已确认阶段: [{ 阶段: 'inbox已接收', 消息id: 'receipt-1', 已接收: true, 内容: 'PRIVATE-CONTENT', 宿主异常: 'PRIVATE-HOST' }] },
  });
  const reply = describeFailure(fault);
  assert.equal(reply.结果, '执行未完整收尾');
  assert.equal(reply.提交状态, '已提交');
  assert.equal(reply.可重试, false);
  assert.deepEqual(reply.已确认阶段, [{ 阶段: 'inbox已接收', 消息id: 'receipt-1', 已接收: true }]);
  assert.doesNotMatch(JSON.stringify(reply), /PRIVATE-/);
  assert.equal(fault.toDecision().howToChange, reply.恢复指引);
  assert.doesNotMatch(fault.toDecision().reason, /按 fail-closed 拒绝/);
});

test('缺提交事实不会默认未提交或允许重试；旧故障结构保持兼容', () => {
  const fault = new Fault('UNKNOWN', '结果未知。', { outcome: { 提交状态: '自报成功', 可重试: 'yes' } });
  assert.equal(describeFailure(fault).提交状态, '未知');
  assert.equal(describeFailure(fault).可重试, null);
  assert.deepEqual(describeFailure(new Fault('POLICY_FAILED', '判定失败。')), {
    结果: '安全闸故障（fail-closed）', 故障码: 'POLICY_FAILED', 理由: '判定失败。',
  });
  assert.match(new Fault('LEGACY', '未知').toDecision().howToChange, /核对操作是否已经提交/);
});
