/** 最近一次 Mind 装配的有界事实；不存知识正文，不作为请求/阅读/采用证明。 */
import { agentSubject } from '../../../src/subject.js';
import { currentProfessionalScope } from '../../../src/professional-context.js';
import { digest } from '../../../src/kernel/text.js';

export function createProfessionalReceipts({ org, projectOf }) {
  let frames = new WeakMap();
  let closed = false;
  const hostScope = agent => {
    try {
      const session = agent?.session;
      const generation = session?.surface?.replaceGeneration;
      if (closed || !agent || typeof session?.id !== 'string' || !session.id.trim()
          || typeof session.header?.cwd !== 'string' || !session.header.cwd.trim()
          || !Number.isSafeInteger(generation) || generation < 0) return null;
      return { session: session.id, cwd: session.header.cwd, generation, project: projectOf({ agent }) };
    } catch { return null; }
  };
  const same = (a, b) => a && b && a.session === b.session && a.cwd === b.cwd && a.generation === b.generation && a.project === b.project;
  return {
    begin(agent) {
      if (!agent || typeof agent !== 'object') return null;
      frames.delete(agent); // 开始任何新装配即撤旧；失败、未查询和迟到回调不能复活旧记录。
      const scope = hostScope(agent);
      if (!scope) return null;
      const token = { scope };
      frames.set(agent, token);
      return token;
    },
    record(agent, token, frame, proof, sectionText) {
      if (!token || frames.get(agent) !== token || !same(token.scope, hostScope(agent))
          || frame?.状态 !== '已装配' || frame.项目 !== token.scope.project || !proof?.stamp || !proof.credentialStamp) return;
      // 复制已投影的有限 ID，不留下 frame/摘要/原始查询结果引用。
      token.stamp = proof.stamp;
      token.credentialStamp = proof.credentialStamp;
      token.receipt = { 版本: 1, 状态: 'Mind装配记录', 项目: frame.项目, 岗位: frame.岗位,
        任务: [...frame.任务], 知识ID: frame.知识.map(row => row.id), 装配指纹: digest(sectionText),
        任务截断: frame.任务截断, 知识截断: frame.截断,
        范围: '仅证明Mind装配，不证明最终请求保留、实际阅读、采用或收益；不授予后续读权。' };
    },
    async beforeSubmit(agent, task) {
      try {
        const token = frames.get(agent);
        if (!token?.receipt || !token.receipt.任务.includes(task) || !same(token.scope, hostScope(agent))) return null;
        const scope = await currentProfessionalScope(org, agentSubject({ agent }), token.scope.project);
        if (frames.get(agent) !== token || scope.stamp !== token.stamp || !same(token.scope, hostScope(agent))) return null;
        return token;
      } catch { return null; } // 观察不可用不阻断原交卷；也不捏造空召回。
    },
    async afterSubmit(agent, token, node) {
      try {
        if (!token?.receipt || frames.get(agent) !== token || !token.receipt.任务.includes(node?.id)
            || !same(token.scope, hostScope(agent))) return null;
        const scope = await currentProfessionalScope(org, agentSubject({ agent }), token.scope.project);
        if (frames.get(agent) !== token || scope.credentialStamp !== token.credentialStamp || !same(token.scope, hostScope(agent))) return null;
        return structuredClone(token.receipt);
      } catch { return null; }
    },
    close() { closed = true; frames = new WeakMap(); },
  };
}
