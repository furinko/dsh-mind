import {DelegationPolicy} from '../../../src/delegation-policy.js';
import {digest} from '../../../src/kernel/text.js';
import {loadClient,makeDocument,makeSlots,makeCtx,makeSessions,makeStrictRequire,createRenderer,collect,textOf,jsonResponse,settle,sampleView} from './client-harness.mjs';

// Public routes and the actual registered settings component, with isolated in-memory settings.
export async function settingsScene(options={}) {
  const state={presence:{失联限制:true,生效响应期限小时:72,介入度:'预审',复核免审:false,lost:false,响应期限小时来源:'出厂',失联限制来源:'出厂',值不合法:false,...options.presence},delegation:new DelegationPolicy(options.delegation||{mode:'explicit-user',projects:[],authorizationRef:''}).config,fail:false,hold:'',release:null};
  state.persona={text:options.personaText??'',exists:options.personaText!==undefined};
  const personaData=()=>({text:state.persona.text,fingerprint:state.persona.exists?digest(state.persona.text):digest('mind:persona-core:missing'),state:!state.persona.exists?'missing':state.persona.text.trim()?'active':'empty',file:'fixture/private/主权人设/核心人设.md',limits:{characters:3000,bytes:12000}});
  const calls=[];const doc=makeDocument();
  const loaded=loadClient({document:doc.document,fetch:async(url,init)=>{
     const call={url,method:init.method,body:init.body?JSON.parse(init.body):undefined};calls.push(call);
     if(options.informationRequest && url.startsWith('/plugins/dsh-mind/information')) return options.informationRequest(url,init);
    if(state.fail&&url!=='/plugins/dsh-mind/workbench')return jsonResponse({成功:false,理由:'读取暂不可用'},503);
    if(init.method==='POST'&&state.hold===url){state.hold='';await new Promise(resolve=>{state.release=resolve;});}
    if(url==='/plugins/dsh-mind/persona-core'){
      if(options.personaRequest)return options.personaRequest(url,init);
      if(call.method==='POST'){
        options.beforePersonaSave?.(state);
        if(call.body.expectedFingerprint!==personaData().fingerprint)return jsonResponse({成功:false,理由:'核心人设已在别处更新'},409);
        if(state.personaMode!=='no-save')state.persona={text:call.body.text,exists:true};
        return jsonResponse({成功:state.personaMode!=='audit-failure',requestedFingerprint:digest(call.body.text),commit:{state:'written'},audit:{state:state.personaMode==='audit-failure'?'failed':'recorded'}});
      }
      if(state.personaReadFailure)return jsonResponse({成功:false,理由:'人设读取失败'},503);
      const snapshot=personaData();
      if(state.holdPersonaRead){state.holdPersonaRead=false;await new Promise(resolve=>{state.releasePersonaRead=resolve;});}
      return jsonResponse({成功:true,数据:snapshot});
    }
    if(url==='/plugins/dsh-mind/presence'){
      if(call.method==='POST'){
        const body=call.body;
        if(body.开关!==undefined)state.presence.失联限制=body.开关==='是';
        if(body.小时!==undefined)state.presence.生效响应期限小时=body.小时;
        if(body.介入度!==undefined)state.presence.介入度=body.介入度;
        if(body.复核免审!==undefined)state.presence.复核免审=body.复核免审;
      }
      return jsonResponse({成功:true,读数:state.presence,设置文件:'fixture/private/settings.json'});
    }
    if(url==='/plugins/dsh-mind/delegation'){
      if(call.method==='POST'){
        const policy=new DelegationPolicy(call.body.delegation);state.delegation=policy.config;
        return jsonResponse({成功:true,requestedFingerprint:policy.fingerprint,commit:{state:'reconciled'},audit:{state:'recorded'}});
      }
      const policy=new DelegationPolicy(state.delegation);
      return jsonResponse({成功:true,数据:{persistence:{config:policy.config,fingerprint:policy.fingerprint,source:'fixture:profile'},runtime:policy.status('plugins'),application:{state:'confirmed'},readiness:{promptRegistered:true,creationGuardRegistered:true}}});
    }
    return jsonResponse(sampleView());
  }});
   const slots=makeSlots();const plugin=loaded.definition.factory(makeStrictRequire().require);const dispose=plugin.apply(makeCtx({slots:slots.slots,sessions:makeSessions([{id:'settings-fixture',main:true}]),uiWorkspace:options.uiWorkspace}));
  let r=createRenderer(slots.calls.register.find(x=>x.options.name==='settings.section').Component,{close(){}});r.flush();await settle(10);r.flush();
  // The minimal renderer does not expand React child components; render the actual registered child in isolation.
  if(options.informationOnly){const child=collect(r.tree).elements.find(e=>typeof e.type==='function'&&e.type.name==='信息成长设置');if(!child)throw Error('Information settings child missing');r.unmount();r=createRenderer(child.type,child.props);r.flush();await settle(10);r.flush();}
  const elements=()=>collect(r.tree,{skipStyle:true}).elements;
  const field=label=>elements().find(x=>x.props['aria-label']===label);
  const button=label=>elements().find(x=>x.type==='button'&&textOf(x)===label);
  async function flush(){await settle(10);r.flush();}
  return {state,calls,loaded,r,doc,elements,field,button,flush,text:()=>textOf(r.tree),change(label,value){field(label).props.onChange({target:{value}});r.flush();},async click(label){const b=button(label);if(!b||b.props.disabled)throw Error('Unavailable button: '+label);b.props.onClick();r.flush();await flush();},async poll(){loaded.timers.intervals[0].fn();await flush();},close(){r.unmount();dispose();}};
}
