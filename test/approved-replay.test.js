import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { makeFixture } from './helpers.mjs';
import { Org } from '../src/org.js';
import { canonical, digest } from '../src/kernel/text.js';

const owner = { id: 'repair-original-applicant', kind: 'Lead' };
const source = {
  subject: owner, action: 'write', args: { 内容: 'OWNER-APPROVED-ORIGINAL' }, 项目: 'plugins', 档位: '审批',
  步骤: [{ 动作: 'write', 目标: { kind: '产物', id: 'artifact-proof' }, 预览: { 内容: 'OWNER-APPROVED-ORIGINAL' }, 说明: '冻结写' }],
};
async function scene(fn) {
  const f = await makeFixture({ defaults: { 介入度: '审批' } });
  try {
    const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: 'plugins' });
    const request = await org.intervention.记请求(source);
    await org.intervention.人侧决议({ 请求id: request.请求id, 决定: '批准', 通道: '隔离人侧适配器', 认证: '测试认证事实' });
    const file = org.layout.private('介入请求', request.请求id + '.json');
    const record = JSON.parse(await readFile(file, 'utf8'));
    await fn(org, request, file, record);
  } finally { await f.cleanup(); }
}
function seal(record) { delete record.内容摘要; record.内容摘要 = digest(canonical(record)); return record; }
async function uses(org) { return (await org.audit.read({})).filter(x => x.动作 === '介入放行占用'); }
async function zeroUse(org) { assert.equal((await uses(org)).length, 0, '必须在占用和执行之前拒绝'); }
async function replay(org, r, record) {
  return org.intervention.校验放行({ 请求id: r.请求id, subject: owner, action: 'write', 入参: record.入参, 步骤: record.步骤 });
}

test('批准后原冻结记录正控：原申请者原参数原步骤可占用一次，不把安全修复做成恒拒', () => scene(async (org, r, file, record) => {
  const a = await replay(org, r, record);
  assert.equal(a.ok, true); assert.equal(a.冻结.入参.内容, 'OWNER-APPROVED-ORIGINAL');
  assert.equal((await replay(org, r, record)).ok, false);
  assert.equal((await uses(org)).length, 1);
}));

const tampering = [
  ['入参', record => { record.入参.内容 = 'AFTER-APPROVAL-SWAP'; }],
  ['步骤预览', record => {
    record.步骤[0].预览.内容 = 'CHANGED-PLAN';
    record.步骤[0].内容指纹 = digest(canonical({ 说明: record.步骤[0].说明, 预览: record.步骤[0].预览 }));
  }],
  ['步骤指纹字段', record => { record.步骤[0].内容指纹 = 'a'.repeat(64); }],
  ['项目', record => { record.项目 = 'foreign-project'; }],
  ['请求指纹字段', record => { record.请求指纹 = 'b'.repeat(64); }],
  // 时间戳不参与规范请求id；它单独变化足以区分“请求自洽”与“原账本绑定”。
  ['账本摘要不符', record => { record.冻结于 = '2099-01-01T00:00:00Z'; }],
];
for (const [name, change] of tampering) {
  test('批准后篡改' + name + '并自重算摘要，仍须在占用前被请求账本绑定拒绝', () => scene(async (org, r, file, record) => {
    change(record); await writeFile(file, JSON.stringify(seal(record)));
    if (['步骤预览', '步骤指纹字段', '账本摘要不符'].includes(name)) {
      assert.equal(org.intervention.请求指纹({ subject: record.主体, action: record.动作, args: record.入参, 目标: record.目标, 项目: record.项目 }), r.请求id);
    }
    const a = await replay(org, r, record);
    assert.equal(a.ok, false, '自摘要不是批准意图的可信来源');
    assert.match(a.原因, /账本不符/); await zeroUse(org);
  }));
}

test('批准后删除冻结记录拒绝，不降级到调用方入参或空计划执行', () => scene(async (org, r, file, record) => {
  await unlink(file); const a = await replay(org, r, record);
  assert.equal(a.ok, false); assert.match(a.原因, /记录缺失/); await zeroUse(org);
}));

test('重放须绑定当前批准行内容摘要：冻结文件与请求行不变，错误批准摘要不能消费', () => scene(async (org, r, file, record) => {
  await org.audit.append({ 动作: '介入决议', 主体: { id: 'sovereign', kind: '主权者' }, 对象: { id: r.请求id, kind: '介入请求' }, 项目: 'plugins', 结果: '批准', 依据: '独立错误批准摘要夹具', 详情: { 请求记录: { 请求id: r.请求id, 摘要: 'f'.repeat(64) } } });
  const a = await replay(org, r, record); assert.equal(a.ok, false); assert.match(a.原因, /决议.*摘要/); await zeroUse(org);
}));

test('规范请求id独立绑定：自摘要及请求/批准摘要相互一致也不能换掉规范请求身份', () => scene(async (org, r, file, record) => {
  const fake = 'd'.repeat(64); record.请求id = fake; record.请求指纹 = fake; seal(record);
  await writeFile(org.layout.private('介入请求', fake + '.json'), JSON.stringify(record));
  for (const [动作, 主体, 结果] of [['介入请求', owner, '待放行'], ['介入决议', { id: 'sovereign', kind: '主权者' }, '批准']]) {
    await org.audit.append({ 动作, 主体, 对象: { id: fake, kind: '介入请求' }, 项目: 'plugins', 结果, 依据: '规范指纹独立夹具', 详情: { 动作: 'write', 档位: '审批', 目标: null, 请求记录: { 请求id: fake, 摘要: record.内容摘要 } } });
  }
  const a = await replay(org, { 请求id: fake }, record); assert.equal(a.ok, false); assert.match(a.原因, /规范请求指纹/); await zeroUse(org);
}));

test('预览与决定共用完整冻结校验链：文件自摘要有效也不展示或盲批置换计划', () => scene(async (org, r, file, record) => {
  record.步骤[0].预览.内容 = 'NOT-THE-APPROVED-PLAN'; await writeFile(file, JSON.stringify(seal(record)));
  const rows = await org.intervention.人侧待决({ 项目: null, 会话: owner.id });
  const row = rows.find(x => x.请求id === r.请求id);
  assert.match(row.记录问题, /账本不符/); assert.equal(row.完整请求, undefined); assert.equal(row.审阅指纹, undefined);
  await assert.rejects(org.intervention.人侧决议({ 请求id: r.请求id, 决定: '撤销', 通道: '隔离人侧适配器', 认证: '测试认证事实' }), /账本不符/);
  await zeroUse(org);
}));
