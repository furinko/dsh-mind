import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeFixture, LEAD } from './helpers.mjs';
import { TaskGraph } from '../src/tasks.js';
import { ObjectStore } from '../src/store.js';
import { ToolFileAuthority } from '../src/tool-file-scope.js';
import { captureArtifactManifest, verifyArtifactManifest } from '../src/artifact-manifest.js';
import { appendLines } from '../src/kernel/fsx.js';

const P = 'content-binding';
const REVIEW = { id: 'sovereign', kind: '主权者' };
const blocked = (error) => error?.code === 'DENIED' && /交付物|内容|清单|对象|旧票|双区/.test(error.message);

async function fixture(t) {
  const f = await makeFixture();
  t.after(() => f.cleanup());
  return { ...f, tasks: new TaskGraph(f) };
}

async function submitted(f, refs = []) {
  const n = await f.tasks.create({ subject: LEAD, 项目: P, 描述: '冻结交付内容', 负责人: 'lead', 判据: ['内容经过独立核验'] });
  await f.tasks.dispatch(n.id, { subject: LEAD, 项目: P });
  await f.tasks.start(n.id, { subject: LEAD, 项目: P });
  return f.tasks.submit(n.id, { subject: LEAD, 项目: P, 产出物引用: refs, 结论: '完成' });
}
const review = (f, id) => f.tasks.review(id, { subject: REVIEW, 项目: P, 三态: '过' });
const accept = (f, id, 票) => f.tasks.accept(id, { subject: LEAD, 项目: P, 票 });
const objectText = (id, version, body) => `---\nid: ${id}\nkind: 产物\nauthority: 自治\nzone: 私有\ndomain: 集体\nversion: ${version}\n---\n# ${id}\n${body}\n`;

describe('交付物内容清单与复核票绑定', () => {
  it('同路径原地改内容：提交后不能出票，出票后不能采纳，均零任务事件', async (t) => {
    const f = await fixture(t);
    const path = join(f.home, 'answer.txt');
    await writeFile(path, 'version-a');
    const n = await submitted(f, [path]);
    assert.match(n.交付物清单.摘要, /^[a-f0-9]{64}$/);
    await writeFile(path, 'version-b');
    let count = (await f.tasks.events({ 项目: P })).length;
    await assert.rejects(review(f, n.id), blocked);
    assert.equal((await f.tasks.events({ 项目: P })).length, count);
    await writeFile(path, 'version-a');
    const r = await review(f, n.id);
    const ticket = r.待采纳.票;
    await writeFile(path, 'version-c');
    count = (await f.tasks.events({ 项目: P })).length;
    await assert.rejects(accept(f, n.id, ticket), blocked);
    assert.equal((await f.tasks.events({ 项目: P })).length, count);
    await writeFile(path, 'version-a');
    const a = await accept(f, n.id, ticket);
    assert.equal(a.采纳.交付物摘要, n.交付物清单.摘要);
  });

  it('目录树包含新增、删除、改名、嵌套文件和空目录；任何漂移都拒绝旧票', async (t) => {
    const f = await fixture(t);
    const root = join(f.home, 'delivery');
    await mkdir(join(root, 'empty'), { recursive: true });
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'nested', 'a.txt'), 'A');
    const n = await submitted(f, [root]);
    assert.ok(n.交付物清单.条目[0].条目.some((e) => e.路径 === 'empty' && e.类型 === '目录'));
    const ticket = (await review(f, n.id)).待采纳.票;
    await writeFile(join(root, 'new.txt'), 'B');
    await assert.rejects(accept(f, n.id, ticket), blocked);
    await rm(join(root, 'new.txt'));
    await rename(join(root, 'nested', 'a.txt'), join(root, 'nested', 'b.txt'));
    await assert.rejects(accept(f, n.id, ticket), blocked);
    await rename(join(root, 'nested', 'b.txt'), join(root, 'nested', 'a.txt'));
    await rm(join(root, 'empty'), { recursive: true });
    await assert.rejects(accept(f, n.id, ticket), blocked);
  });

  it('重新交卷产生新清单与新票；恢复旧路径不能把旧票重新用在新提交上', async (t) => {
    const f = await fixture(t);
    const path = join(f.home, 'answer.txt');
    await writeFile(path, 'A');
    const n = await submitted(f, [path]);
    const oldTicket = (await review(f, n.id)).待采纳.票;
    await writeFile(path, 'B');
    const newer = await f.tasks.submit(n.id, { subject: LEAD, 项目: P, 产出物引用: [path], 结论: '新版' });
    assert.notEqual(newer.交付物清单.摘要, n.交付物清单.摘要);
    await assert.rejects(accept(f, n.id, oldTicket), /旧票作废/);
    const ticket = (await review(f, n.id)).待采纳.票;
    assert.notEqual(ticket, oldTicket);
    assert.equal((await accept(f, n.id, ticket)).状态, '已采纳');
  });

  it('交卷后新增挂载必须重新交卷；复核不能现场把新文件补成旧交卷的证据', async (t) => {
    const f = await fixture(t);
    const path = join(f.home, 'supplement.txt');
    await writeFile(path, '证据');
    const n = await submitted(f);
    await f.tasks.attach(n.id, { subject: LEAD, 项目: P, 产出物: path });
    await assert.rejects(review(f, n.id), blocked);
    await f.tasks.submit(n.id, { subject: LEAD, 项目: P, 结论: '补交' });
    const r = await review(f, n.id);
    assert.equal((await accept(f, n.id, r.待采纳.票)).状态, '已采纳');
  });

  it('真实产物裸 id 在交卷时钉版本，显式版本引用可读历史；当前对象升级不更换已验内容', async (t) => {
    const f = await fixture(t);
    const store = new ObjectStore(f);
    const document = (body) => ({ meta: { id: 'report', authority: '自治', zone: '私有', domain: '集体' }, body: `# report\n${body}\n` });
    await store.write('产物', document('第一版'), { subject: LEAD, reason: '真实对象交付' });
    const v1 = (await store.read('产物', 'report', { subject: LEAD, zone: '私有' })).raw;
    const n = await submitted(f, ['report', 'mind://私有/产物/report@1']);
    assert.ok(n.交付物清单.条目.every((e) => e.版本 === 1));
    await store.write('产物', document('第二版'), { subject: LEAD, reason: '后续版本' });
    const ticket = (await review(f, n.id)).待采纳.票;
    await writeFile(f.layout.historyFile('report', 'v1', { kind: '产物', zone: '私有' }), objectText('report', 1, '篡改历史'));
    await assert.rejects(accept(f, n.id, ticket), blocked);
    await writeFile(f.layout.historyFile('report', 'v1', { kind: '产物', zone: '私有' }), v1);
    assert.equal((await accept(f, n.id, ticket)).状态, '已采纳');
  });

  it('散文引用、缺失文件与不存在对象可以留账，但不能得到合格票', async (t) => {
    const f = await fixture(t);
    const n = await submitted(f, ['artifact-does-not-exist', 'https://example.test/mutable', join(f.home, 'absent.txt')]);
    assert.ok(n.交付物清单.条目.every((e) => e.类型 === '不可验证'));
    await assert.rejects(review(f, n.id), blocked);
    // 没有可验内容不妨碍记录未验和打回，避免把异常变成死锁。
    assert.equal((await f.tasks.review(n.id, { subject: REVIEW, 项目: P, 三态: '未验' })).状态, '未验');
    assert.equal((await f.tasks.review(n.id, { subject: REVIEW, 项目: P, 三态: '不过' })).状态, '已打回');
  });

  it('旧交卷与旧过票没有内容清单：不能新出票、免审核准或借原票补证', async (t) => {
    const f = await fixture(t);
    const id = 'legacy-content';
    const at = f.clock.iso();
    const by = { id: 'lead', kind: 'Lead' };
    await appendLines(f.layout.taskLog(P), [
      { seq: 1, at, by, kind: 'created', id, 描述: '旧任务', 负责人: ['lead'], 判据: ['核验'], 依赖: [] },
      { seq: 2, at, by, kind: 'dispatched', id },
      { seq: 3, at, by, kind: 'started', id, 状态: '执行中' },
      { seq: 4, at, by, kind: 'submitted', id, 状态: '已交卷', 产出物引用: [], 结论: '旧结果' },
      { seq: 5, at, by: REVIEW, kind: 'reviewed', id, 三态: '过', 代: 1, 复核者: REVIEW.id },
    ]);
    await assert.rejects(review(f, id), blocked);
    await assert.rejects(accept(f, id, 'rv-5'), blocked);
    assert.equal((await f.tasks.events({ 项目: P })).length, 5);
  });

  it('免审只免复核；交付物修改后仍不能采纳', async (t) => {
    const f = await fixture(t);
    f.policy.reviewExemptAllowed = () => true;
    const path = join(f.home, 'answer.txt');
    await writeFile(path, 'A');
    const n = await submitted(f, [path]);
    await f.tasks.exemptReview(n.id, { subject: LEAD, 项目: P, 原因: '测试免审' });
    await writeFile(path, 'B');
    await assert.rejects(accept(f, n.id), blocked);
    await writeFile(path, 'A');
    assert.equal((await accept(f, n.id)).采纳.依据, '复核免审');
  });

  it('组织原始路径禁止交付，成员范围外路径不会读取生成摘要', async (t) => {
    const f = await fixture(t);
    const spec = { layout: f.layout, policy: f.policy, subject: LEAD };
    await assert.rejects(captureArtifactManifest([f.layout.identityFile()], spec), blocked);
    const path = join(f.home, 'private-answer.txt');
    await writeFile(path, '不能越域读取');
    const manifest = await captureArtifactManifest([path], { ...spec, subject: { id: 'member-a', kind: '成员' }, task: { 绑定: [{ 实例: 'member-a' }] } });
    assert.equal(manifest.条目[0].类型, '不可验证');
    assert.ok(!manifest.条目[0].sha256 && !manifest.条目[0].条目);
    const fileAuthority = f.tasks.configureToolFiles({ read: [path], write: [] });
    const task = await f.tasks.create({ subject: LEAD, 项目: P, 描述: '真实凭证捕获边界', 负责人: '插件工程', 判据: ['授权内文件'] });
    await f.tasks.bind(task.id, { subject: LEAD, 项目: P, 实例: 'member-a', 岗位: '插件工程' });
    await f.tasks.dispatch(task.id, { subject: LEAD, 项目: P, 工具文件范围: { 读: [path] } });
    const bound = await f.tasks.start(task.id, { subject: { id: 'member-a', kind: '成员' }, 项目: P });
    const granted = await captureArtifactManifest([path], { ...spec, fileAuthority, subject: { id: 'member-a', kind: '成员' }, task: bound });
    assert.equal(granted.条目[0].类型, '文件树', '真绑定与冻结读域同时存在才读取');
    const unbound = await captureArtifactManifest([path], { ...spec, fileAuthority, subject: { id: 'member-b', kind: '成员' }, task: bound });
    assert.equal(unbound.条目[0].类型, '不可验证', '其他实例不能借同一任务域读取');
  });

  it('成员文件交卷逐次复核当前可授上限；部署撤权后旧冻结域不能继续算摘要', async (t) => {
    const f = await fixture(t);
    const path = join(f.home, 'member-answer.txt');
    await writeFile(path, '成员产物');
    f.tasks.configureToolFiles({ read: [path], write: [] });
    const n = await f.tasks.create({ subject: LEAD, 项目: P, 描述: '成员文件交付', 负责人: '插件工程', 判据: ['真实交付'] });
    await f.tasks.bind(n.id, { subject: LEAD, 项目: P, 实例: 'member-a', 岗位: '插件工程' });
    await f.tasks.dispatch(n.id, { subject: LEAD, 项目: P, 工具文件范围: { 读: [path] } });
    const member = { id: 'member-a', kind: '成员', roleId: '插件工程' };
    await f.tasks.start(n.id, { subject: member, 项目: P });
    const original = await f.tasks.submit(n.id, { subject: member, 项目: P, 产出物引用: [path] });
    assert.equal(original.交付物清单.条目[0].类型, '文件树');
    f.tasks.configureToolFiles({ read: [], write: [] });
    const revoked = await f.tasks.submit(n.id, { subject: member, 项目: P, 产出物引用: [path] });
    assert.equal(revoked.交付物清单.条目[0].类型, '不可验证');
    assert.ok(!revoked.交付物清单.条目[0].条目);
    await assert.rejects(review(f, n.id), blocked);
  });

  it('目录内 junction/符号链接拒绝冻结，冻结后替换成链接也不能借旧票采纳', async (t) => {
    const f = await fixture(t);
    const root = join(f.home, 'delivery');
    const outside = join(f.home, 'outside');
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(root, 'a.txt'), 'A');
    await writeFile(join(outside, 'secret.txt'), '不能跟随');
    const n = await submitted(f, [root]);
    const ticket = (await review(f, n.id)).待采纳.票;
    await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(accept(f, n.id, ticket), blocked);
    const count = (await f.tasks.events({ 项目: P })).length;
    await assert.rejects(f.tasks.submit(n.id, { subject: LEAD, 项目: P, 产出物引用: [root] }), blocked);
    assert.equal((await f.tasks.events({ 项目: P })).length, count);
  });

  it('清单摘要也受校验，调用方不能通过替换其内容来补造原票证据', async (t) => {
    const f = await fixture(t);
    const n = await submitted(f);
    const manifest = { ...n.交付物清单, 条目: [{ 引用: '伪造', 类型: '不可验证' }] };
    await assert.rejects(verifyArtifactManifest(manifest, ['伪造'], { layout: f.layout, policy: f.policy, subject: LEAD }), blocked);
  });

  it('硬链接到组织身份文件或外部普通文件的交付别名拒绝捕获，不生成内容证据', async (t) => {
    const f = await fixture(t);
    const secret = join(f.home, 'external-secret.txt');
    await writeFile(secret, 'outside secret');
    for (const [source, name] of [[f.layout.identityFile(), 'ordinary.json'], [secret, 'ordinary.txt']]) {
      const alias = join(f.home, name);
      await link(source, alias);
      assert.equal((await stat(alias)).nlink, 2);
      await assert.rejects(captureArtifactManifest([alias], { layout: f.layout, policy: f.policy, subject: LEAD }), /硬链接/);
    }
  });

  it('目录交付冻结/出票后新建文件硬链接，采纳拒绝；移除别名后普通目录和单链接文件仍可通过', async (t) => {
    const f = await fixture(t);
    const root = join(f.home, 'delivery');
    await mkdir(join(root, 'nested'), { recursive: true });
    const file = join(root, 'nested', 'one.txt');
    await writeFile(file, 'same bytes');
    const n = await submitted(f, [root]);
    const ticket = (await review(f, n.id)).待采纳.票;
    const alias = join(f.home, 'outside-alias.txt');
    await link(file, alias);
    const before = (await f.tasks.events({ 项目: P })).length;
    await assert.rejects(accept(f, n.id, ticket), /硬链接/);
    await assert.rejects(captureArtifactManifest([root], { layout: f.layout, policy: f.policy, subject: LEAD }), /硬链接/);
    assert.equal((await f.tasks.events({ 项目: P })).length, before, '失败核验零事件');
    await rm(alias);
    assert.equal((await stat(file)).nlink, 1);
    assert.equal((await accept(f, n.id, ticket)).状态, '已采纳');
  });

  it('对象正文的硬链接别名同样使提交和已冻结证据的重验拒绝', async (t) => {
    const f = await fixture(t);
    const path = f.layout.documentPath('产物', { id: 'linked-report' }, '私有');
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, objectText('linked-report', 1, 'stable object'));
    const n = await submitted(f, ['mind://私有/产物/linked-report@1']);
    const ticket = (await review(f, n.id)).待采纳.票;
    await link(path, join(f.home, 'object-alias.md'));
    assert.equal((await stat(path)).nlink, 2);
    await assert.rejects(accept(f, n.id, ticket), /硬链接/);
    await assert.rejects(captureArtifactManifest(['mind://私有/产物/linked-report@1'], { layout: f.layout, policy: f.policy, subject: LEAD }), /硬链接/);
  });
});
