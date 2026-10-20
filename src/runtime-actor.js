import {Denied,Fault} from './kernel/errors.js';
import {agentSubject} from './subject.js';

/**
 * 运行时身份事实唯一核对：模型参数不能替代 live Agent 或当前宿主工作目录。
 * @param {{host:object,subject:object,project:string,sessionProject?:string}} spec
 * @returns {object} 宿主原始 Agent，不复制、不按同 id 对象冒认。
 * @throws {Denied|Fault} 缺事实、身份不符或跨项目时拒绝。
 */
export function requireLiveActor({host,subject,project,sessionProject=project}) {
  const reject=reason=>new Denied('运行时身份 · 真实主体/当前项目',reason,{howToChange:'核对真实会话、当前工作目录与主体；不接受自报身份、父链或项目。'});
  const actualProject=host?.project;
  if(typeof actualProject!=='string'||!actualProject)throw new Fault('MEMBER_PROJECT_UNAVAILABLE','宿主当前工作目录项目不可用，不接受入参项目代替。');
  if(project!==actualProject||project!==sessionProject)throw reject('禁止跨项目：必须使用当前会话项目。');
  const agent=host?.agent;
  if(!agent||typeof host?.agents?.get!=='function'||host.agents.get(agent.id)!==agent)throw reject('宿主未提供可核对的真实 live Agent，不能以同 id 对象冒充父会话。');
  if(!agent.id||agent.id!==agent.session?.id||agent.id!==subject?.id
    ||(agent.session?.header?.id!==undefined&&agent.session.header.id!==subject.id)
    ||agentSubject({agent}).kind!==subject?.kind)throw reject('宿主父会话事实与执行主体不符，不猜前缀或别名。');
  return agent;
}
