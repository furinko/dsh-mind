import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeFixture, seedReviewRelation } from '../test/helpers.mjs';
import { fakeHost } from '../test/host-harness.mjs';
import { appendLines } from '../src/kernel/fsx.js';
import { shareOrg } from '../src/runtime.js';
import { readInstanceSnapshot } from '../src/instance-snapshot.js';
import * as plugin from '../components/kernel/lib/index.js';

const f = await makeFixture();
const results = [];
try {
  const project = 'mixed-generation-proof';
  const root = join(f.home, project);
  const source = join(root, 'src', 'a.js');
  await mkdir(join(root, 'src'), {recursive:true});
  await writeFile(source, 'export const proof = true;\n', 'utf8');
  await appendLines(f.layout.taskLog(project), [{seq:1, at:new Date().toISOString(), by:{id:'lead',kind:'Lead'}, kind:'created', id:'biz-proof', 描述:'proof', 负责人:['member-a'], 判据:['done'], 依赖:[], 状态:'待派发'}]);
  const review = await seedReviewRelation(f, {项目:project, 目标:'biz-proof', id:'review-proof'});
  await appendLines(f.layout.taskLog(project), [{seq:9001, at:new Date().toISOString(), by:{id:'lead',kind:'Lead'}, kind:'artifact', id:review, 产出物:root}]);
  const org = await shareOrg({home:f.home, factoryRoot:f.factoryRoot, privateRoot:f.privateRoot, project});
  // A cached object from the previous generation lacks the newly added method.
  org.registry.snapshotSync = undefined;
  const host = fakeHost();
  await plugin.apply(host.ctx, {home:f.home, factoryRoot:f.factoryRoot, privateRoot:f.privateRoot, project});
  function guard(name, args, id='reviewer') {
    const exec = {name, arguments:args, agent:{session:{id,header:{origin:'subagent',cwd:root}}}};
    for (const fn of host.闸) {
      const result = fn(exec);
      assert.ok(!(result instanceof Promise));
      if (result !== undefined) return result;
    }
  }
  assert.equal(typeof org.registry.snapshotSync, 'undefined');
  assert.equal(guard('read',{file_path:source}), undefined);
  assert.equal(guard('read',{file_path:source},'member-a'), undefined);
  assert.match(guard('edit',{file_path:source}), /复核员只读/);
  assert.match(guard('read',{file_path:f.layout.identityFile()}), /私有|原始/);
  results.push({case:'cached-registry-without-method',reviewerSourceReadAllowed:true,engineerReadAllowed:true,reviewerWriteDenied:true,rawIdentityReadDenied:true,synchronous:true});
  await org.registry.seal({subject:{id:'sovereign-proof',kind:'主权者'},实例:'reviewer',理由:'isolated guard regression'});
  assert.match(guard('write',{file_path:source}), /成员身份未就绪/);
  assert.match(guard('write',{file_path:source},'unknown-member'), /成员身份未就绪/);
  results.push({case:'sealed-or-unknown-member',genericWriteDenied:true});
  await f.writePrivate('身份档案/identity.json', '{broken');
  assert.equal(readInstanceSnapshot(f.layout.identityFile()).ok, false);
  assert.match(guard('read',{file_path:source},'member-a'), /不可用/);
  results.push({case:'broken-identity-json',snapshotFailed:true,guardDenied:true});
  await writeFile(new URL('./snapshot-guard-mixed-proof.json', import.meta.url), JSON.stringify(results,null,2), 'utf8');
  console.log(JSON.stringify(results,null,2));
} finally {
  await f.cleanup();
}
