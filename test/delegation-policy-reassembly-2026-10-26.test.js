import { it } from 'node:test';
import assert from 'node:assert/strict';
import { DelegationPolicy } from '../src/delegation-policy.js';
import { officialTeamPolicy } from './fixtures/team-policy-0.2.1-rc.3.js';

const project = 'reassembly-fixture';
const config = { mode: 'lead-discretion', projects: [project], authorizationRef: 'synthetic-grant' };
const scope = { project, isTeam: true };
const policyAssembly = text => ({
  sections: [{ name: 'host:instructions', text: 'Unrelated host instructions.' }, { name: 'team:policy', text, interpolate: false }],
  contexts: [{ name: 'host:context', text: 'Synthetic current context.' }], variables: { model: 'fixture' },
});
const drift = error => error.code === 'DELEGATION_UPSTREAM_POLICY_DRIFT';

for (const interrupt of [true, false]) {
  it(`官方rc.3策略重复装配保留一份授权和逐字官方文本（interrupt=${interrupt}）`, () => {
    const policy = new DelegationPolicy(config);
    const official = officialTeamPolicy(interrupt);
    const original = policyAssembly(official);
    const first = policy.assemble(original, scope);
    const second = policy.assemble(first, scope);
    const third = new DelegationPolicy(config).assemble(structuredClone(second), scope);
    assert.equal(second, first, '重复装配不创建新段或追加第二份授权');
    assert.deepEqual(third, first, '同配置新实例接到已装配结果也保持幂等');
    const text = third.sections[1].text;
    assert.equal(text.split(`[${DelegationPolicy.generation}]`).length - 1, 1);
    assert.equal(text.slice(text.indexOf('\n\n') + 2), official, '官方全文逐字保留');
    assert.equal(original.sections[1].text, official, '不修改注册者的输入');
    assert.equal(first.sections[0], original.sections[0]);
    assert.equal(first.contexts, original.contexts);
    assert.equal(first.variables, original.variables);
    assert.equal(first.sections[1].interpolate, false);
  });
}

it('嵌套waterfall重装配的返回值经过外层Mind时不误报上游漂移', async () => {
  const policy = new DelegationPolicy(config);
  const original = policyAssembly(officialTeamPolicy(true));
  const mind = async next => policy.assemble(await next(), scope);
  // Another contributor refreshes the public assembly inside its listener.
  const result = await mind(() => mind(async () => structuredClone(original)));
  assert.equal(result.sections[1].text, policy.assemble(original, scope).sections[1].text);
});

it('只认本项目的完整原样授权头：改头、重复头、跨项目、旧代次和未知上游仍拒绝', () => {
  const policy = new DelegationPolicy({ ...config, projects: [project, 'other-project'] });
  const official = officialTeamPolicy(true);
  const text = policy.assemble(policyAssembly(official), scope).sections[1].text;
  const header = text.slice(0, -official.length);
  for (const bad of [
    text.replace('Delegation is optional:', 'Delegation is mandatory:'),
    header + text,
    text.replace(`[${DelegationPolicy.generation}]`, '[mind-delegation-v1]'),
    header + 'Unreviewed upstream policy.',
    'Unreviewed upstream policy.',
  ]) assert.throws(() => policy.assemble(policyAssembly(bad), scope), drift);
  assert.throws(() => policy.assemble(policyAssembly(text), { project: 'other-project', isTeam: true }), drift);
});

it('已装配段不恢复撤回的创建权，也不绕过缺段、重段和组件关闭检查', () => {
  const policy = new DelegationPolicy(config);
  const original = policyAssembly(officialTeamPolicy(true));
  const accepted = policy.assemble(original, scope);
  const ungranted = new DelegationPolicy();
  assert.equal(ungranted.assemble(accepted, scope), accepted);
  assert.throws(() => ungranted.authorize({ subject: { kind: 'Lead' }, project }), error => error.code === 'DENIED');
  assert.throws(() => policy.assemble({ sections: [] }, scope), error => error.code === 'DELEGATION_TEAM_POLICY');
  assert.throws(() => policy.assemble({ ...accepted, sections: [accepted.sections[1], accepted.sections[1]] }, scope), error => error.code === 'DELEGATION_TEAM_POLICY');
  policy.close();
  assert.equal(policy.assemble(accepted, scope), accepted);
  assert.throws(() => policy.authorize({ subject: { kind: 'Lead' }, project }), error => error.code === 'DELEGATION_DISPOSED');
});
