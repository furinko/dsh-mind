// Root 独立反例（不是工程自测）：批准之后改写私有冻结记录并重算自摘要，
// 检验「重放校验是否与账本/决议摘要及规范请求指纹绑定」。
// 只使用冻结候选的只读模块 + 临时夹具 home；不改候选、不碰 live、不碰真实 d836。
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { makeFixture } from 'file:///C:/Users/wjthq/AppData/Local/Temp/dsh-mind-conversation-approval-RPsVEF/product/test/helpers.mjs';
import { Org } from 'file:///C:/Users/wjthq/AppData/Local/Temp/dsh-mind-conversation-approval-RPsVEF/product/src/org.js';
import { canonical, digest } from 'file:///C:/Users/wjthq/AppData/Local/Temp/dsh-mind-conversation-approval-RPsVEF/product/src/kernel/text.js';
import { 规范步骤 } from 'file:///C:/Users/wjthq/AppData/Local/Temp/dsh-mind-conversation-approval-RPsVEF/product/src/intervention.js';

const OWNER = 'session-independent-replay-binding-test';
const result = { at: new Date().toISOString(), candidateIdentity: '443f42fa661c1dfe79bc569039745137b071f3ee339d2b8fd16741fc255a3549', scope: 'Isolated temp fixture using frozen candidate modules; not live, not real d836, not a human decision', observations: {} };
const f = await makeFixture({ defaults: { 介入度: '审批' } });
try {
  const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: 'default' });
  const spec = {
    subject: { id: OWNER, kind: 'Lead' },
    action: 'write',
    args: { 内容: '主权者批准的原正文' },
    项目: 'default',
    档位: '审批',
    步骤: [{ 动作: 'write', 目标: { kind: '产物', id: 'artifact-replay-binding' }, 说明: '写冻结内容', 预览: { 内容: '主权者批准的原正文' } }],
  };
  const created = await org.intervention.记请求(spec);
  const requestId = created.请求id;
  const previewRow = (await org.intervention.人侧待决({}))?.find?.(x => x.请求id === requestId);
  assert.ok(previewRow, '待决投影里必须能看到这一单');
  const approvedDigest = previewRow.内容摘要;
  // 隔离夹具里的「人侧决定」：模拟主权者点击，用于构造合法批准后的重放窗口；不涉及任何真实请求。
  const decision = await org.intervention.人侧决议({ 请求id: requestId, 决定: '批准', 通道: '隔离验收夹具', 认证: '夹具内部调用' });
  assert.equal(decision.决定, '批准');
  result.observations.ledgerDigestAtApproval = approvedDigest;
  result.observations.recordDigestAtApproval = (await org.intervention.读冻结({ 请求id: requestId, subject: { id: OWNER, kind: 'Lead' } })).内容摘要;

  // —— 批准之后：改写私有冻结记录（入参 + 计划预览），并重算自摘要，保留 请求id/请求指纹/版本 ——
  const file = org.layout.private('介入请求', requestId + '.json');
  const record = JSON.parse(await readFile(file, 'utf8'));
  // 篡改者拥有私有区写权：连步骤内的内容指纹一起按同一份「规范步骤」重算，保持内部自洽。
  const tamperedSteps = 规范步骤(record.步骤.map((step, index) => index === 0 ? { ...step, 预览: { 内容: '批准后被替换的正文' } } : step));
  const tampered = { ...record, 入参: { 内容: '批准后被替换的正文' }, 步骤: tamperedSteps };
  delete tampered.内容摘要;
  tampered.内容摘要 = digest(canonical(tampered));
  await writeFile(file, JSON.stringify(tampered, null, 2) + '\n');

  // 预览面是否报出账本不符（这是改前就有的保护）
  const previewAfter = (await org.intervention.人侧待决({}))?.find?.(x => x.请求id === requestId);
  result.observations.previewAfterTamper = { 记录问题: previewAfter?.记录问题 ?? null, 状态: previewAfter?.状态 ?? null, tamperedDigest: tampered.内容摘要 };

  // 重放面：原申请者按「被替换后的参数」重放
  const replay = await org.intervention.校验放行({
    请求id: requestId,
    subject: { id: OWNER, kind: 'Lead' },
    action: 'write',
    入参: { 内容: '批准后被替换的正文' },
    步骤: tamperedSteps,
  });
  result.observations.replay = { ok: replay.ok, 状态: replay.状态, 原因: replay.原因 ?? null, 冻结入参: replay.冻结?.入参 ?? null, 冻结步骤预览: replay.冻结?.步骤?.[0]?.预览 ?? null };
  result.observations.rawReplay = JSON.stringify(replay);
  result.observations.conclusion = replay.ok && replay.冻结?.入参?.内容 === '批准后被替换的正文'
    ? '批准后的重放校验接受了被替换的正文：自摘要通过、账本摘要与规范请求指纹未参与校验'
    : '重放校验拒绝了被替换的正文';
} finally {
  await f.cleanup();
}
writeFileSync(new URL('./repro-replay-ledger-binding-result.json', import.meta.url), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ledgerDigest: result.observations.ledgerDigestAtApproval, tamperedDigest: result.observations.previewAfterTamper?.tamperedDigest, replayOk: result.observations.replay?.ok, replayStatus: result.observations.replay?.状态, replayReason: result.observations.replay?.原因, replayContent: result.observations.replay?.冻结入参, conclusion: result.observations.conclusion }, null, 2));
