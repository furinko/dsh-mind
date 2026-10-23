import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { makeFixture, LEAD } from './helpers.mjs';
import { fakeHost, fakeExec } from './host-harness.mjs';
import { ProbeRunner, CLOSED_LIST } from '../src/probes.js';
import { mechanismArtifact } from '../src/mechanism-artifact.js';
import { shareOrg } from '../src/runtime.js';
import { apply } from '../components/guard/lib/index.js';
import { atomicWrite } from '../src/kernel/fsx.js';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const runner = (f) => new ProbeRunner({ ...f, 无内核装配: true });
const rollbackRows = async (f) => (await f.audit.read({})).filter((r) => r.动作 === '自动回滚');
async function fixture(fn) { const f = await makeFixture(); try { await fn(f); } finally { await f.cleanup(); } }
async function copy(fn) {
  const parent = await mkdtemp(join(tmpdir(), 'probe-artifact-test-'));
  const root = join(parent, 'product');
  try {
    await cp(ROOT, root, { recursive: true });
    await fn(root);
  } finally { await rm(parent, { recursive: true, force: true }); }
}
const load = (root, relative) => import(pathToFileURL(join(root, relative)).href);

describe('探针巡检唯一自动落点', () => {
  it('全绿不定位；红灯本次快照/审计绑定、系统主体与升级读数完整，拒收版本自报', async () => fixture(async (f) => {
    const p = runner(f);
    const before = mechanismArtifact();
    const green = await p.run({ subject: LEAD, 机制版本: 'boot' });
    assert.equal(green.全绿, true);
    assert.equal(green.回滚, null);
    assert.equal((await rollbackRows(f)).length, 0);
    assert.match(green.机制版本, /^dsh-mind@1\.3\.0\+sha256:[0-9a-f]{64}$/);
    f.policy.state.ok = false;
    const red = await p.run({ subject: LEAD, 机制版本: 'model-forged' });
    assert.equal(red.全绿, false);
    assert.deepEqual(red.结果.map((r) => r.探针), CLOSED_LIST);
    assert.equal(red.机制版本, green.机制版本);
    assert.equal(red.回滚.执行, false);
    assert.equal(red.回滚.已定位, true);
    assert.equal(red.回滚.目标版本, green.机制版本);
    assert.deepEqual(red.回滚.目标快照, green.快照);
    assert.equal(red.回滚.可恢复, '不可确定');
    assert.equal(red.回滚.制品来源, null);
    const rows = await rollbackRows(f);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].详情.触发快照, red.快照);
    assert.equal(rows[0].告警, true);
    assert.equal(rows[0].主体.kind, '系统');
    assert.equal(rows[0].详情.升级, '主权者');
    assert.deepEqual(mechanismArtifact(), before, '巡检不改代码、不自建恢复制品');
    await assert.rejects(readdir(f.layout.artifactDir()), { code: 'ENOENT' });
    const disk = JSON.parse(await readFile(join(f.layout.probeSnapshotDir(), red.快照.名), 'utf8'));
    assert.equal(disk.回滚, undefined, '定位读数不倒写已入账的快照');
  }));

  it('仅声明坏也触发定位，四灯未增第五盏；无历史明报不可确定', async () => fixture(async (f) => {
    await writeFile(f.layout.probeDeclaration(), '{');
    const red = await runner(f).run({ subject: LEAD });
    assert.equal(red.见红.length, 0);
    assert.equal(red.结果.length, 4);
    assert.equal(red.全绿, false);
    assert.equal(red.回滚.状态, '不可确定');
    assert.match(red.回滚.原因, /没有任何/);
    assert.equal((await rollbackRows(f)).length, 1);
  }));

  for (const laterRed of [false, true]) it(`确定性并发：后续绿${laterRed ? '再红' : ''}不能吃掉本次红或污染目标`, async () => fixture(async (f) => {
    const p = runner(f), other = runner(f);
    const green = await p.run({ subject: LEAD });
    let resume, arrived;
    const hold = new Promise((r) => { resume = r; });
    const entered = new Promise((r) => { arrived = r; });
    const original = p.autoRollback.bind(p);
    let bound;
    p.autoRollback = async (reference) => { bound = reference; arrived(); await hold; return original(reference); };
    f.policy.state.ok = false;
    const running = p.run({ subject: LEAD });
    await Promise.race([entered, running.then(() => { throw Error('本次红未进入自动定位落点'); })]);
    f.policy.state.ok = true;
    const future = await other.run({ subject: LEAD });
    assert.equal(future.全绿, true);
    if (laterRed) { f.policy.state.ok = false; await other.run({ subject: LEAD }); }
    resume();
    const red = await running;
    assert.deepEqual(red.快照, bound);
    assert.deepEqual(red.回滚.触发快照, bound);
    assert.deepEqual(red.回滚.目标快照, green.快照, '目标必须是本次审计之前的绿，不是后续绿');
    const own = (await rollbackRows(f)).filter((r) => r.详情.触发快照?.名 === bound.名);
    assert.equal(own.length, 1);
  }));

  it('历史boot/声明标签不倒灌当前身份，legacy文件不改', async () => fixture(async (f) => {
    const p = runner(f);
    const name = '2020-legacy.json';
    const text = `${JSON.stringify({ 机制版本: 'boot', 于: '2020-01-01T00:00:00Z', 全绿: true, 结果: [], 见红: [] }, null, 2)}\n`;
    await f.writePrivate(`升级/探针快照/${name}`, text);
    const { shortHash } = await import('../src/kernel/ids.js');
    await f.audit.append({ 动作: '探针巡检', 主体: LEAD, 对象: {id:'红线索兵',kind:'账目'}, 结果:'全绿', 详情:{快照:{名:name,哈希:shortHash(text,16)}} });
    f.policy.state.ok = false;
    const red = await p.run({ subject: LEAD });
    assert.equal(red.回滚.已定位, false);
    assert.equal(red.回滚.目标版本, null);
    assert.equal(red.回滚.历史标签, 'boot');
    assert.match(red.回滚.原因, /不能倒灌/);
    assert.equal(await readFile(join(f.layout.probeSnapshotDir(), name),'utf8'),text);
  }));

  it('目标被篡改拒绝定位并告警', async () => fixture(async (f) => {
    const p = runner(f), green = await p.run({subject: LEAD});
    const path = join(f.layout.probeSnapshotDir(),green.快照.名);
    await writeFile(path,(await readFile(path,'utf8')).replace('已核代码身份','伪造代码身份'));
    f.policy.state.ok = false;
    const red = await p.run({subject: LEAD});
    assert.equal(red.回滚.状态,'拒绝定位');
    assert.equal(red.回滚.已定位,false);
    assert.equal((await rollbackRows(f)).at(-1).告警,true);
  }));

  it('定位读取异常仍无条件告警，run不得伪报成功', async () => fixture(async (f) => {
    const p = runner(f); f.policy.state.ok = false;
    const read = f.audit.read.bind(f.audit);
    f.audit.read = async () => { throw Error('injected-read-failure'); };
    await assert.rejects(p.run({subject:LEAD}),/回滚定位失败.*injected-read-failure/);
    f.audit.read = read;
    const rows = await rollbackRows(f);
    assert.equal(rows.length,1);
    assert.equal(rows[0].详情.状态,'定位失败');
    assert.equal(rows[0].告警,true);
  }));

  it('定位审计失败抛出，不返回已入账；证据提交失败不执行无凭定位', async () => fixture(async (f) => {
    const p=runner(f); f.policy.state.ok=false;
    const append=f.audit.append.bind(f.audit);
    f.audit.append=async(e)=>{if(e.动作==='自动回滚')throw Error('injected-rollback-audit');return append(e);};
    await assert.rejects(p.run({subject:LEAD}),/injected-rollback-audit/);
    f.audit.append=async(e)=>{if(e.动作==='探针异常')throw Error('injected-snapshot-audit');return append(e);};
    await assert.rejects(p.run({subject:LEAD}),/injected-snapshot-audit/);
    f.audit.append=append;
    assert.equal((await rollbackRows(f)).length,0);
  }));

  it('后续健康故障不跳过红灯定位；手工无快照未知而非绿', async () => fixture(async (f) => {
    const p=runner(f);
    const empty=await p.autoRollback();
    assert.equal(empty.状态,'不可确定');assert.match(empty.原因,/缺失/);
    f.policy.state.ok=false;
    p.evaluateHealth=async()=>{throw Error('injected-health-failure');};
    await assert.rejects(p.run({subject:LEAD}),/injected-health-failure/);
    assert.equal((await rollbackRows(f)).length,2);
  }));

  it('真guard工具/命令/开机都走同一落点，启动不再boot，health只读', async () => fixture(async (f) => {
    const host=fakeHost();
    const config={home:f.home,privateRoot:f.privateRoot,factoryRoot:f.factoryRoot};
    const org=await shareOrg(config);org.policy.state.ok=false;
    await apply(host.ctx,{...config,开机自检:false});
    const tool=host.工具.get('mind_guard');
    const result=JSON.parse(await tool.execute({action:'probe_run',机制版本:'model-forged'},fakeExec({name:'mind_guard',sessionId:'probe-real-root'})));
    assert.equal(result.成功,true);assert.equal(result.探针.全绿,false);
    assert.ok(result.探针.回滚);assert.notEqual(result.探针.机制版本,'model-forged');
    const command=host.命令.get('mind-guard');
    const cmd=await command.handler({agent:fakeExec({sessionId:'probe-cmd-root'}).agent,rawInput:'probe'});
    assert.equal(cmd.kind,'success');
    assert.ok(JSON.parse(cmd.text).探针.回滚);
    await atomicWrite(org.layout.guardReceiptFile(),JSON.stringify({范围闸:{registered:true},调度创建闸:{registered:true}}));
    let complete;const boot=new Promise((resolve)=>{complete=resolve;});
    const run=org.probes.run.bind(org.probes);org.probes.run=(...args)=>{const result=run(...args);complete(result);return result;};
    const host2=fakeHost();await apply(host2.ctx,config);const bootResult=await boot;
    assert.notEqual(bootResult.机制版本,'boot');assert.ok(bootResult.回滚);
    assert.equal((await rollbackRows(org)).length,3);
    const count=(await org.audit.read({})).length;
    const health=JSON.parse(await tool.execute({action:'probe_health'},fakeExec({name:'mind_guard',sessionId:'probe-health-root'})));
    assert.equal(health.成功,true);assert.equal((await org.audit.read({})).length,count);
    assert.ok(host2.日志.some((s)=>s.includes('代码身份=')&&s.includes('升级主权者')));
  }));
});

describe('真实包源码身份，不是声明哈希或恢复制品', () => {
  it('独立SHA复算完整清单，排除私有数据且包版本来自真实清单', async () => {
    const identity=mechanismArtifact();
    assert.equal(identity.状态,'已核代码身份');
    const manifest=JSON.parse(await readFile(join(ROOT,'package.json'),'utf8'));
    assert.equal(identity.包版本,manifest.version);
    assert.ok(identity.文件.length>30);
    for(const f of identity.文件){
      assert.equal(f.SHA256,createHash('sha256').update(await readFile(join(ROOT,f.路径))).digest('hex'));
      assert.doesNotMatch(f.路径,/(^|\/)(mind|test|docs|mind-private|\.git|node_modules)(\/|$)/);
    }
    assert.equal(identity.代码指纹,createHash('sha256').update(JSON.stringify(identity.文件)).digest('hex'));
    assert.equal(identity.制品来源,null);assert.equal(identity.可恢复,'不可确定');
  });

  it('同声明异检测实现：真ProbeRunner结果和版本均不同，私有/声明变化不冒充代码版本', async () => copy(async (root) => {
    const path=join(root,'src/probes.js');
    const source=await readFile(path,'utf8');
    assert.ok(source.includes("状态: '绿', 详情: '拒绝名单为空。'"));
    await writeFile(path,source.replace("状态: '绿', 详情: '拒绝名单为空。'","状态: '红', 详情: 'changed-implementation'"));
    const Other=(await load(root,'src/probes.js')).ProbeRunner;
    await fixture(async(f)=>{
      const a=await runner(f).run({subject:LEAD});
      const b=await new Other({...f,无内核装配:true}).run({subject:LEAD});
      assert.equal(a.全绿,true);assert.equal(b.全绿,false);
      assert.notEqual(a.机制版本,b.机制版本);
      const version=a.机制版本;
      await f.writePrivate('产物/私有数据.txt','private-not-in-code-identity');
      await writeFile(f.layout.probeDeclaration(),JSON.stringify({探针:CLOSED_LIST,备注:'changed-declaration-only'}));
      assert.equal((await runner(f).run({subject:LEAD})).机制版本,version);
    });
  }));

  it('新增代码文件及真实包版本均影响身份', async () => copy(async(root)=>{
    const pkg=join(root,'package.json');const json=JSON.parse(await readFile(pkg,'utf8'));json.version='1.1.1';await writeFile(pkg,JSON.stringify(json));
    await writeFile(join(root,'src/new-runtime-code.js'),'export const added = 1;\n');
    const current=(await load(root,'src/mechanism-artifact.js')).mechanismArtifact();
    assert.equal(current.包版本,'1.1.1');assert.notEqual(current.机制版本,mechanismArtifact().机制版本);
    assert.ok(current.文件.some((f)=>f.路径==='src/new-runtime-code.js'));
  }));

  it('加载后源码漂移为未知，不把盘上新代码标成已加载版本', async () => copy(async(root)=>{
    const get=(await load(root,'src/mechanism-artifact.js')).mechanismArtifact;
    assert.equal(get().状态,'已核代码身份');
    const path=join(root,'src/probes.js');await writeFile(path,(await readFile(path,'utf8'))+'\n');
    const changed=get();assert.equal(changed.状态,'不可确定');assert.equal(changed.机制版本,null);assert.match(changed.说明,/漂移/);
  }));

  it('代码目录缺失/包版本缺失均明确未知，四灯不伪造第五灯', async () => copy(async(root)=>{
    await rm(join(root,'lib'),{recursive:true,force:true});
    const {mechanismArtifact:get}=await load(root,'src/mechanism-artifact.js');
    assert.equal(get().状态,'不可确定');assert.equal(get().机制版本,null);assert.match(get().说明,/读取失败/);
    const Other=(await load(root,'src/probes.js')).ProbeRunner;
    await fixture(async(f)=>{
      const ran=await new Other({...f,无内核装配:true}).run({subject:LEAD});
      assert.equal(ran.代码身份.状态,'不可确定');assert.equal(ran.机制版本,null);assert.equal(ran.结果.length,4);
    });
  }));

  it('干净单包发布形状不要求未发布组件清单，源码与安装集合身份一致', async () => copy(async(root)=>{
    for (const name of ['kernel','guard','board']) await rm(join(root,`components/${name}/package.json`));
    for (const path of ['docs','test','tools','.gitignore','.gitattributes']) await rm(join(root,path),{recursive:true,force:true});
    const installed=(await load(root,'src/mechanism-artifact.js')).mechanismArtifact();
    const source=mechanismArtifact();
    assert.equal(installed.状态,'已核代码身份');
    assert.equal(installed.机制版本,source.机制版本);
    assert.deepEqual(installed.文件,source.文件);
    assert.ok(installed.文件.some((f)=>f.路径==='icon.svg'));
    assert.ok(!installed.文件.some((f)=>/^components\/[^/]+\/package\.json$/.test(f.路径)));
  }));

  it('清单内运行资源改变必须改变代码资源身份',async()=>copy(async(root)=>{
    const icon=join(root,'icon.svg');await writeFile(icon,(await readFile(icon,'utf8'))+'\n<!-- changed runtime icon -->\n');
    const identity=(await load(root,'src/mechanism-artifact.js')).mechanismArtifact();
    assert.equal(identity.状态,'已核代码身份');
    assert.notEqual(identity.机制版本,mechanismArtifact().机制版本);
  }));

  it('删除必需exports代码或声明未发布入口不可静默缩集合',async()=>copy(async(root)=>{
    await rm(join(root,'lib/index.js'));
    const identity=(await load(root,'src/mechanism-artifact.js')).mechanismArtifact();
    assert.equal(identity.状态,'不可确定');assert.equal(identity.机制版本,null);
    assert.match(identity.说明,/必需运行入口/);
  }));

  it('删除内部必需模块真加载硬失败，不把指纹读数当装载成功',async()=>copy(async(root)=>{
    await rm(join(root,'src/probes.js'));
    await assert.rejects(load(root,'src/org.js'),{code:'ERR_MODULE_NOT_FOUND'});
  }));

  it('缺实际包版本不能借工具参数补造版本',async()=>copy(async(root)=>{
    const path=join(root,'package.json');const json=JSON.parse(await readFile(path,'utf8'));delete json.version;await writeFile(path,JSON.stringify(json));
    const identity=(await load(root,'src/mechanism-artifact.js')).mechanismArtifact();
    assert.equal(identity.状态,'不可确定');assert.equal(identity.机制版本,null);
  }));
});
