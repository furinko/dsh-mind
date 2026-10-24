import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile, chmod, symlink, lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { Layout } from '../src/paths.js';
import { supportedMemoryLayouts, resolvePrivateRoot, checkDeploymentLayout } from '../scripts/check-deployment-layout.mjs';

const source = fileURLToPath(new URL('..', import.meta.url));
const declaration = (memoryLayouts = [1, 2], objectHistoryLayouts = [1, 2]) => JSON.stringify({ version: 1, memoryLayouts, objectHistoryLayouts });
const quote = value => "'" + value.replace(/'/g, "'\"'\"'") + "'";
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'mind-deployment-layout-'));
  const repository = join(directory, 'repo'); const runtime = join(directory, 'runtime');
  const app = join(directory, 'app'); const home = join(directory, 'home'); const profile = join(home, 'profiles', 'web');
  const privateRoot = join(home, 'mind-data', 'mind-private'); const events = join(app, 'events');
  const layout = new Layout({ factoryRoot: join(repository, 'mind'), privateRoot });
  const put = async (file, text) => { await mkdir(dirname(file), { recursive: true }); await writeFile(file, text); };
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    await mkdir(repository); await mkdir(app); await mkdir(profile, { recursive: true }); await mkdir(layout.memoryRoot(), { recursive: true });
    // Use the real Layout, rather than duplicating its directory naming.
    const ledger = layout.memoryLog('synthetic', '知识'); await put(ledger, 'synthetic-private-bytes\n');
    await put(join(repository, 'package.json'), '{"type":"module"}');
    await put(join(repository, 'cordis.patch.yml'), '- insert: []\n');
    for (const name of ['scripts/local-dsh.sh', 'scripts/check-deployment-layout.mjs', 'src/paths.js', 'src/memory-layout.js', 'src/kernel/errors.js', 'src/kernel/fsx.js']) {
      const target = join(repository, name); await mkdir(dirname(target), { recursive: true }); await copyFile(join(source, name), target);
    }
    await put(join(repository, 'scripts/storage-compatibility.json'), declaration([1], [1]));
    await put(join(repository, 'scripts/verify-profile-install.mjs'), "console.log('synthetic install check');\n");
    await put(join(repository, 'test/preflight.mjs'), "console.log('✔ preflight synthetic');\n");
    await put(join(repository, 'test/smoke.test.js'), "import { it } from 'node:test'; it('synthetic source check',()=>{});\n");
    await put(join(repository, 'components/board/test/smoke.test.js'), "import { it } from 'node:test'; it('synthetic board check',()=>{});\n");
    await put(join(repository, 'components/board/test/client-harness.mjs'), "console.log('client-harness: synthetic');\n");
    git('init', '--quiet'); git('config', 'user.name', 'Synthetic Deployment'); git('config', 'user.email', 'synthetic@example.invalid');
    git('add', '.'); git('commit', '--quiet', '-m', 'synthetic old writer'); const old = git('rev-parse', 'HEAD');
    await put(join(repository, 'scripts/storage-compatibility.json'), declaration()); git('add', '.'); git('commit', '--quiet', '-m', 'synthetic new writer'); const current = git('rev-parse', 'HEAD');
    git('worktree', 'add', '--quiet', '--detach', runtime, old); git('update-ref', 'refs/dsh-local/previous', old);
    const commit = async (manifest) => { await put(join(repository, 'scripts/storage-compatibility.json'), manifest); git('add', '.'); git('commit', '--quiet', '-m', 'synthetic compatibility variation'); return git('rev-parse', 'HEAD'); };
    const check = target => checkDeploymentLayout({ repository, target, privateRoot });
    const marker = text => put(join(layout.memoryRoot(), '布局.json'), text);
    const readEvents = async () => (await readFile(events, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).trim().split('\n').filter(Boolean);
    const shell = async (mode = '', command = 'deploy') => {
      await mkdir(join(profile, 'node_modules'), { recursive: true });
      try { await symlink(runtime, join(profile, 'node_modules', 'dsh-mind'), process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      await put(join(profile, 'package.json'), '{}'); await put(join(profile, 'cordis.patch.yml'), '- insert: []\n');
      await put(join(app, 'spec.json'), JSON.stringify({ events, runtime, privateRoot, memoryRoot: layout.memoryRoot(), mode }));
      await put(join(app, 'control.mjs'), [
        "import { readFileSync, appendFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';",
        "import { dirname, join } from 'node:path'; import { fileURLToPath } from 'node:url'; import { execFileSync } from 'node:child_process';",
        "const spec=JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)),'spec.json'),'utf8')); const action=process.argv[2];",
        "const previous=existsSync(spec.events)?readFileSync(spec.events,'utf8'):'';",
        "const head=execFileSync('git',['-C',spec.runtime,'rev-parse','HEAD'],{encoding:'utf8'}).trim();",
        "appendFileSync(spec.events,action+':'+head+'\\n');",
        "if(action==='stop'&&spec.mode==='memory-change-on-stop')writeFileSync(join(spec.memoryRoot,'布局.json'),'本轮未知布局');",
        "if(action==='launch'&&!previous.includes('launch:')) {",
        " if(spec.mode==='history-change-and-fail'){mkdirSync(join(spec.privateRoot,'版本历史','.objects-v2'),{recursive:true});process.exit(1);}",
        " if(spec.mode==='launch-failure')process.exit(1);",
        "}"
      ].join('\n'));
      for (const action of ['stop', 'launch']) { const file=join(app, action+'.sh'); await put(file, '#!/usr/bin/env bash\nexec '+quote(process.execPath)+' '+quote(join(app,'control.mjs'))+' '+quote(action)+'\n'); await chmod(file, 0o755); }
      let configuredGit='git';
      if(mode==='status-failure') {
        configuredGit=join(app,'failing-git.sh');
        await put(configuredGit, '#!/usr/bin/env bash\nfor task_arg in "$@"; do if [[ "$task_arg" == status ]]; then exit 7; fi; done\nexec git "$@"\n');
        await chmod(configuredGit,0o755);
      }
      const config = join(directory, 'local.env');
      await put(config, Object.entries({ MIND_NODE: process.execPath, MIND_GIT: configuredGit, MIND_APP_DIR: app, MIND_PROFILE_DIR: profile, MIND_RUNTIME_DIR: runtime, MIND_AUDIT_DIR: join(directory,'audits'), MIND_PRIVATE_ROOT: privateRoot }).map(([key,value])=>key+'='+quote(value)).join('\n')+'\n');
      return spawnSync('bash', [join(repository,'scripts/local-dsh.sh'), command], { encoding:'utf8', env:{...process.env, DSH_MIND_LOCAL_CONFIG:config}, timeout:30000 });
    };
    await run({ directory, repository, runtime, home, profile, privateRoot, layout, ledger, old, current, git, put, commit, check, marker, readEvents, shell });
  } finally { await rm(directory, { recursive:true, force:true, maxRetries:5, retryDelay:50 }); }
}

it('当前兼容清单允许真实Layout布局1与布局2；检查不改记忆字节', () => fixture(async f => {
  assert.equal((await f.check(f.current)).memoryLayout,1);
  assert.equal(await readFile(f.ledger,'utf8'),'synthetic-private-bytes\n');
  await rm(join(f.layout.memoryRoot(),'synthetic'),{recursive:true}); await f.marker('{"version":2}');
  assert.equal((await f.check(f.current)).memoryLayout,2);
}));
it('布局2拒绝布局1目标，已有字节不改动', () => fixture(async f => {
  await rm(join(f.layout.memoryRoot(),'synthetic'),{recursive:true}); await f.marker('{"version":2}');
  await assert.rejects(f.check(f.old),/不支持当前记忆布局2/);
  assert.equal(await readFile(join(f.layout.memoryRoot(),'布局.json'),'utf8'),'{"version":2}');
}));
for (const kind of ['directory','file','link']) it('对象历史2的'+kind+'占位即阻止旧目标', () => fixture(async f => {
  const root=join(f.privateRoot,'版本历史','.objects-v2'); await mkdir(dirname(root),{recursive:true});
  if(kind==='directory')await mkdir(root);
  else if(kind==='file')await writeFile(root,'synthetic lock');
  else { const target=join(f.directory,'link-target'); await mkdir(target); await symlink(target,root,process.platform==='win32'?'junction':'dir'); await rm(target,{recursive:true}); }
  await assert.rejects(f.check(f.old),/不支持当前对象历史布局2/); assert.equal((await f.check(f.current)).objectHistoryLayout,2);
}));
for (const marker of ['{broken','{"version":3}','null']) it('无效或未知磁盘布局拒绝：'+marker, () => fixture(async f => {
  await f.marker(marker); await assert.rejects(f.check(f.current),/布局/);
  assert.equal(await readFile(join(f.layout.memoryRoot(),'布局.json'),'utf8'),marker);
}));
it('进行中的迁移及操作锁拒绝，不打开私有正文', () => fixture(async f => {
  const transaction=join(dirname(f.layout.memoryRoot()),'记忆布局迁移.json');
  await f.put(transaction,'{"version":1,"phase":"prepared"}'); await assert.rejects(f.check(f.current),/迁移尚未收尾/);
  await rm(transaction); await mkdir(join(dirname(f.layout.memoryRoot()),'记忆布局操作.lock')); await assert.rejects(f.check(f.current),/正在操作/);
  assert.equal(await readFile(f.ledger,'utf8'),'synthetic-private-bytes\n');
}));
it('未知、损坏的目标兼容清单与不存在提交一律拒绝', () => fixture(async f => {
  for(const manifest of ['{broken','{"version":2,"memoryLayouts":[1]}',declaration([3]),'{"version":1,"memoryLayouts":[1]}']) {
    const target=await f.commit(manifest); await assert.rejects(f.check(target),/兼容清单/);
  }
  await assert.rejects(f.check('missing-target'),/无法核对目标提交/);
}));
it('新格式收录落盘后阻止旧读取器回退，仅读取无正文布局标记', () => fixture(async f => {
  await f.put(join(f.privateRoot, '信息收录', 'parser-layout.json'), '{"version":2}');
  await f.put(join(f.privateRoot, '信息收录', 'state.json'), 'must-not-read-private-state');
  await assert.rejects(f.check(f.current), /不支持当前信息收录布局2/);
  const target = await f.commit(JSON.stringify({ version: 1, memoryLayouts: [1, 2], objectHistoryLayouts: [1, 2], informationLayouts: [1, 2] }));
  assert.equal((await f.check(target)).informationLayout, 2);
  await f.put(join(f.privateRoot, '信息收录', 'parser-layout.json'), '{broken');
  await assert.rejects(f.check(target), /信息收录布局标记无效/);
  assert.equal(await readFile(join(f.privateRoot, '信息收录', 'state.json'), 'utf8'), 'must-not-read-private-state');
}));
it('没有清单的已审查布局2读取器可识别，无关路径调整不改变识别', async () => {
  const paths=await readFile(join(source,'src/paths.js'),'utf8'); const reader=await readFile(join(source,'src/memory-layout.js'),'utf8');
  assert.deepEqual(supportedMemoryLayouts({manifest:null,paths,reader}),{memoryLayouts:[1,2],objectHistoryLayouts:[1]});
  assert.deepEqual(supportedMemoryLayouts({manifest:null,paths:paths+'\n// unrelated path change\n',reader}),{memoryLayouts:[1,2],objectHistoryLayouts:[1]});
  assert.throws(()=>supportedMemoryLayouts({manifest:null,paths:paths.replace("'项目接续',", "'other-root',"),reader}),/未获核验/);
});
it('标准profile推导实际私有根；定制或不明确的根要求显式配置', () => fixture(async f => {
  assert.equal(await resolvePrivateRoot({homeRoot:f.home,profileDir:f.profile,patches:['# home: ignored\n- id: synthetic\n  config:\n    enabled: true']}),await realpath(f.privateRoot));
  for(const patch of ['config: { privateRoot: /different }','config: { home: /different }','config: !!js value','config: *override','config: &override\n  enabled: true','config: { enabled: true }','config: !!map value','\"\\x70rivateRoot\": /different','config: {\"home\": /different}','config: {\"privateRoot\": /different}']) await assert.rejects(resolvePrivateRoot({homeRoot:f.home,profileDir:f.profile,patches:[patch]}),/MIND_PRIVATE_ROOT/);
  assert.equal(await resolvePrivateRoot({privateRoot:f.privateRoot}),await realpath(f.privateRoot));
  await assert.rejects(resolvePrivateRoot({privateRoot:'relative'}),/绝对路径/);
  await assert.rejects(resolvePrivateRoot({homeRoot:f.directory,profileDir:f.profile,patches:[]}),/不匹配/);
}));

it('已审查的旧版直接路径只允许记忆1与历史1', async () => {
  let paths=await readFile(join(source,'src/paths.js'),'utf8');
  paths=paths.replace("return memoryScopePath(this.memoryRoot(), assertPathSegment(scope, '记忆范围'));", "return this.private(DIR.基础设施, DIR.记忆服务, assertPathSegment(scope, '记忆范围'));")
    .replace("return memoryWorkPath(this.memoryRoot(), '轮级缓冲',", "return this.private(DIR.基础设施, DIR.记忆服务, '轮级缓冲',")
    .replace("return memoryWorkPath(this.memoryRoot(), '项目接续',", "return this.private(DIR.基础设施, DIR.记忆服务, '项目接续',")
    .replace("return memoryWorkPath(this.memoryRoot(), '连续性提炼',", "return this.private(DIR.基础设施, DIR.记忆服务, '连续性提炼',");
  assert.deepEqual(supportedMemoryLayouts({manifest:null,paths,reader:null}),{memoryLayouts:[1],objectHistoryLayouts:[1]});
  assert.throws(()=>supportedMemoryLayouts({manifest:null,paths:paths.replace("基础设施: '集体L2-共享基础设施'", "基础设施: 'unknown'"),reader:null}),/可核验/);
});

const linuxOnly={skip:process.platform!=='linux'};
it('部署前检查回退目标：不兼容时不停服、不checkout、不改回退引用',linuxOnly,()=>fixture(async f=>{
  await mkdir(join(f.privateRoot,'版本历史','.objects-v2'),{recursive:true});
  const previous=f.git('rev-parse','refs/dsh-local/previous'); const result=await f.shell();
  assert.notEqual(result.status,0); assert.match(result.stderr,/不支持当前对象历史布局2/);
  assert.deepEqual(await f.readEvents(),[]); assert.equal(f.git('rev-parse','refs/dsh-local/previous'),previous);
  assert.equal(execFileSync('git',['-C',f.runtime,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),f.old);
}));
it('手动rollback目标不兼容时在停服前拒绝',linuxOnly,()=>fixture(async f=>{
  f.git('worktree','remove','--force',f.runtime); f.git('worktree','add','--quiet','--detach',f.runtime,f.current);
  await mkdir(join(f.privateRoot,'版本历史','.objects-v2'),{recursive:true});
  const result=await f.shell('','rollback'); assert.notEqual(result.status,0); assert.deepEqual(await f.readEvents(),[]);
}));
it('正常部署通过并只启动目标提交',linuxOnly,()=>fixture(async f=>{
  const result=await f.shell(); assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
  assert.deepEqual(await f.readEvents(),['stop:'+f.old,'launch:'+f.current]);
}));
it('新启动产生历史2后失败，不再启动不兼容的旧写入器',linuxOnly,()=>fixture(async f=>{
  const result=await f.shell('history-change-and-fail'); assert.notEqual(result.status,0);
  assert.match(result.stderr,/保持停机/); assert.deepEqual(await f.readEvents(),['stop:'+f.old,'launch:'+f.current,'stop:'+f.current]);
  assert.ok((await lstat(join(f.privateRoot,'版本历史','.objects-v2'))).isDirectory());
}));
it('普通启动失败仍可恢复兼容的旧提交',linuxOnly,()=>fixture(async f=>{
  const result=await f.shell('launch-failure'); assert.notEqual(result.status,0);
  assert.deepEqual(await f.readEvents(),['stop:'+f.old,'launch:'+f.current,'stop:'+f.current,'launch:'+f.old]);
}));
it('停机期间元数据变化，异常路径也不启动任何版本',linuxOnly,()=>fixture(async f=>{
  const result=await f.shell('memory-change-on-stop'); assert.notEqual(result.status,0);
  assert.deepEqual((await f.readEvents()).filter(e=>e.startsWith('launch:')),[]); assert.match(result.stderr,/保持停机/);
}));

it('Git状态读取失败不冒充干净：零停服、零checkout且回退引用不变',linuxOnly,()=>fixture(async f=>{
  const previous=f.git('rev-parse','refs/dsh-local/previous');
  const result=await f.shell('status-failure'); assert.notEqual(result.status,0); assert.match(result.stderr,/无法核对工作区状态/);
  assert.deepEqual(await f.readEvents(),[]); assert.equal(f.git('rev-parse','refs/dsh-local/previous'),previous);
  assert.equal(execFileSync('git',['-C',f.runtime,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),f.old);
}));

it('QQ来源布局落盘后禁止旧轮缓冲读取器接管，未知标记也拒绝',async()=>fixture(async f=>{
 const file=join(f.layout.memoryRoot(),'external-conversation-layout.json');await f.put(file,JSON.stringify({version:2}));const oldBytes=await readFile(f.ledger,'utf8');
 await assert.rejects(f.check(f.current),/轮级缓冲来源布局2/);
 const supported=await f.commit(JSON.stringify({version:1,memoryLayouts:[1,2],objectHistoryLayouts:[1,2],turnBufferLayouts:[1,2]}));assert.equal((await f.check(supported)).turnBufferLayout,2);assert.equal(await readFile(f.ledger,'utf8'),oldBytes);
 await f.put(file,JSON.stringify({version:3}));await assert.rejects(f.check(supported),/布局未知/);
}));
