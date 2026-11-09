import test from 'node:test';
import assert from 'node:assert/strict';
import { DelegationPolicy } from '../src/delegation-policy.js';
const lead = { id: 'lead', kind: 'Lead' };
const spec = { subject: lead, project: 'plug' };
const official = 'Agent Teams is available in this session\n\nThe Team Lead and all teammates share the same working directory and filesystem. Original tail.';

for (const config of [undefined, {}, { mode: 'host' }]) test(`Host default is eligibility, not explicit grant or Host approval: ${JSON.stringify(config)}`, () => {
  const policy = new DelegationPolicy(config), state = policy.authorize(spec);
  assert.equal(state.mode, 'host'); assert.equal(state.canAttempt, true);
  assert.equal(state.authorized, false); assert.equal(state.admission, 'host-required');
  assert.equal(state.hostAdmission, 'not-evaluated'); assert.equal(state.authorizationRef, null);
  assert.equal(new DelegationPolicy(policy.config).fingerprint, policy.fingerprint, 'normalized default roundtrips');
  assert.match(policy.creationGuard({ name: 'subagent' }, spec), /member_spawn/);
  assert.match(policy.creationGuard({ name: 'subagent' }, { ...spec, connected: false }), /未接入/);
  assert.throws(() => policy.authorize({ ...spec, subject: { kind: '成员' } }));
  policy.close(); assert.equal(policy.status('plug').canAttempt, false);
  assert.equal(policy.status('plug').admission, 'unavailable'); assert.throws(() => policy.authorize(spec));
});

for (const config of [{ mode: 'explicit-user' }, { projects: [] }, { projects: ['*'] }, { authorizationRef: '' }, { projects: ['plug'], authorizationRef: 'old-reference' }]) test(`explicit/ambiguous legacy configuration stays restricted: ${JSON.stringify(config)}`, () => {
  const policy = new DelegationPolicy(config), state = policy.status('plug');
  assert.equal(state.mode, 'explicit-user'); assert.equal(state.canAttempt, false); assert.equal(state.admission, 'restricted');
  assert.throws(() => policy.authorize(spec));
});

test('Host mode honors explicit project restriction and never claims a deployment grant', () => {
  const policy = new DelegationPolicy({ mode: 'host', projects: ['plug'] });
  assert.equal(policy.authorize(spec).canAttempt, true);
  assert.equal(policy.status('other').canAttempt, false);
  assert.throws(() => policy.authorize({ ...spec, project: 'other' }));
  assert.match(policy.creationGuard({ name: 'subagent' }, { ...spec, project: 'other' }), /限制/);
  assert.equal(policy.authorizeMaintenance({ ...spec, project: 'other' }).maintenanceOnly, true);
});

test('legacy scoped grant remains scoped and still needs native Host approval', () => {
  const policy = new DelegationPolicy({ mode: 'lead-discretion', projects: ['plug'], authorizationRef: 'test-only' });
  const state = policy.authorize(spec);
  assert.equal(state.authorized, true); assert.equal(state.canAttempt, true);
  assert.equal(state.hostAdmission, 'not-evaluated'); assert.equal(state.admission, 'host-required');
  assert.throws(() => policy.authorize({ ...spec, project: 'other' }));
});

test('default Team header preserves official text without inventing explicit human authorization', () => {
  const policy = new DelegationPolicy(), original = { sections: [{ name: 'team:policy', text: official }] };
  const result = policy.assemble(original, { project: 'plug', isTeam: true });
  assert.match(result.sections[0].text, /Host.*admission/i);
  assert.doesNotMatch(result.sections[0].text, /deployment owner explicitly authorizes/i);
  assert.ok(result.sections[0].text.endsWith(official));
  assert.equal(policy.assemble(result, { project: 'plug', isTeam: true }), result);
});

for (const config of [null, { mode: null }, { mode: false }, { mode: 'host', projects: null }, { mode: 'host', projects: ['../escape'] }, { mode: 'host', authorizationRef: 1 }]) test(`invalid values are never a Host default: ${JSON.stringify(config)}`, () => {
  assert.throws(() => new DelegationPolicy(config));
});
