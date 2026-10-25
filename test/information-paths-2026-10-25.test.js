import {it} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,writeFile,symlink,rename,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sourceRoot,verifyRoot,readSourceFile} from '../src/information-files.js';

async function scene(run){const root=await realpath(await mkdtemp(join(tmpdir(),'mind-source-path-')));try{await run(root);}finally{await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:60});}}

it('来源使用真实目录及文件身份，普通中文路径可读取，私有排除根仍拒绝',()=>scene(async root=>{
 const dir=join(root,'资料目录');await mkdir(dir);await writeFile(join(dir,'原文.txt'),'一个合成来源');
 const source=await sourceRoot(dir);await verifyRoot(source);assert.equal((await readSourceFile(source,'原文.txt',1024)).raw,'一个合成来源');
 await assert.rejects(sourceRoot(dir,[root]),/私有|自我收录/);
}));

it('来源根和中间组件的符号链接或Windows junction仍被拒绝',()=>scene(async root=>{
 const dir=join(root,'资料目录');await mkdir(dir);await writeFile(join(dir,'原文.txt'),'不得沿别名读取');
 const alias=join(root,'目录别名');await symlink(dir,alias,process.platform==='win32'?'junction':'dir');
 await assert.rejects(sourceRoot(alias),/真实路径|普通目录/);
 const nested=join(dir,'嵌套别名');await symlink(root,nested,process.platform==='win32'?'junction':'dir');
 const source=await sourceRoot(dir);await assert.rejects(readSourceFile(source,'嵌套别名/资料目录/原文.txt',1024),{code:'INFORMATION_LINK_REFUSED'});
}));

it('同一路径目录被替换后仍按设备与inode身份拒绝旧来源',()=>scene(async root=>{
 const dir=join(root,'资料目录');await mkdir(dir);const source=await sourceRoot(dir);
 await rename(dir,join(root,'原目录'));await mkdir(dir);
 await assert.rejects(verifyRoot(source),{code:'INFORMATION_SOURCE_CHANGED'});
}));

it('Windows盘符大小写不构成目录别名，后续核对及读取使用相同文件身份',{skip:process.platform!=='win32'},()=>scene(async root=>{
 const dir=join(root,'资料目录');await mkdir(dir);await writeFile(join(dir,'原文.txt'),'同一真实来源');
 const lower=dir[0].toLowerCase()+dir.slice(1),upper=dir[0].toUpperCase()+dir.slice(1);
 const one=await sourceRoot(lower),two=await sourceRoot(upper);assert.equal(one.identity,two.identity);
 await verifyRoot(one);await verifyRoot(two);
 assert.equal((await readSourceFile(one,'原文.txt',1024)).hash,(await readSourceFile(two,'原文.txt',1024)).hash);
}));
