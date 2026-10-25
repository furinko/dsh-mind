/** Persistent Lead ownership and explicit relationship bindings; never host permissions. */
import { canonical, digest } from './kernel/text.js';
import { currentProfessionalScope } from './professional-context.js';

// 同一部署的本地主人延续于不同根会话；显式关系绑定仍可划分其他使用者。
export const LOCAL_OWNER_RELATIONSHIP = 'dsh:local-owner';
export const sessionRelationship = (session, bindings) => session ? bindings[digest(session)] ?? LOCAL_OWNER_RELATIONSHIP : null;

export class DataOwnershipService {
  constructor(org) { this.org = org; }
  async bindings() { return (await this.org.information.load()).bindings; }
  async relationship(session, bindings = null) { return sessionRelationship(session, bindings ?? await this.bindings()); }
  async stamp(session) {
    const bindings = await this.bindings();
    return digest(canonical({ owner: 'Lead', session, relationship: await this.relationship(session, bindings) }));
  }
  async related(one, two) {
    if (one === two) return true;
    const bindings = await this.bindings();
    return await this.relationship(one, bindings) === await this.relationship(two, bindings);
  }
  async allows(scope, subject, project) {
    if (subject?.kind === '主权者') return true;
    if (!scope || !['Lead', '成员'].includes(subject?.kind)) return false;
    if (scope.project !== null && scope.project !== project) return false;
    if (scope.relationship !== null && (subject.kind !== 'Lead' || scope.relationship !== await this.relationship(subject.id))) return false;
    if (subject.kind === 'Lead') return true;
    if (scope.audience !== 'roles') return false;
    try {
      const current = await currentProfessionalScope(this.org, subject, project);
      return !current.council && current.nodes.length > 0 && !current.domain?.限定 && current.role !== '复核员' && scope.roles.includes(current.role);
    } catch { return false; }
  }
}
