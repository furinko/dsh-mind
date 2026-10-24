import {test} from 'node:test';
import assert from 'node:assert/strict';
import {settingsScene} from './settings-fixture.mjs';
import {collect,textOf} from './client-harness.mjs';

function visibleElements(tree){const result=[];function visit(n){if(Array.isArray(n))return n.forEach(visit);if(!n||typeof n!=='object'||!n.props||n.props.hidden)return;result.push(n);if(n.type==='details'&&!n.props.open){visit(n.props.children.find(x=>x.type==='summary'));return;}visit(n.props.children);}visit(tree);return result;}
const posts=t=>t.calls.filter(x=>x.method==='POST');

test('设置分组清楚：首屏隐藏诊断、项目指纹及冗长回执；只有一个刷新入口',async()=>{
  const t=await settingsScene();try{
    assert.deepEqual(t.elements().filter(x=>x.type==='h3').map(textOf),['核心人设','运行与审批','Lead 调度授权']);
    assert.deepEqual(t.elements().filter(x=>x.type==='h4').map(x=>textOf(x).split('\n')[0]),['失联保护','审批与复核']);
    const visible=visibleElements(t.r.tree);assert.ok(!visible.some(x=>x.type==='input'&&x.props['aria-label']==='授权项目'));
    assert.ok(!visible.some(x=>['授权真源','盘面 / 运行指纹','设置文件 fixture/private/settings.json'].includes(textOf(x))));
    assert.equal(t.elements().filter(x=>x.type==='button'&&textOf(x).includes('重新读取')).length,1);
    assert.equal(t.button('保存').props.disabled,true);assert.equal(t.button('保存调度授权').props.disabled,true);assert.equal(posts(t).length,0);
    t.field('响应期限小时').props.onKeyDown({key:'Enter'});await t.flush();assert.equal(posts(t).length,0,'未修改的回车不空提交');
  }finally{t.close();}
});

test('字段标签与解释绑定控件，选中模式只展示相关说明',async()=>{
  const t=await settingsScene();try{
    for(const f of t.elements().filter(x=>['input','select'].includes(x.type))){assert.ok(t.elements().some(x=>x.type==='label'&&x.props.htmlFor===f.props.id));assert.ok(t.elements().some(x=>x.props.id===f.props['aria-describedby']));}
    assert.deepEqual(collect(t.field('介入度')).elements.filter(x=>x.type==='option').map(textOf),['0%','50%','100%']);
    assert.match(textOf(t.elements().find(x=>x.props.id==='dshmind-setting-intervention-hint')),/改岗位.*发布能力/);
    t.change('介入度','审批');assert.match(textOf(t.elements().find(x=>x.props.id==='dshmind-setting-intervention-hint')),/每次自治写入/);
    assert.ok(!t.text().includes('放权=自治写直落留痕；预审='));
  }finally{t.close();}
});

test('取消策略修改不写入，并恢复跟随读数；改回原值也自动回到无修改态',async()=>{
  const t=await settingsScene();try{
    t.change('响应期限小时','168');assert.equal(t.button('保存').props.disabled,false);
    await t.click('取消修改');assert.equal(t.field('响应期限小时').props.value,'72');assert.equal(t.button('保存').props.disabled,true);assert.equal(posts(t).length,0);
    t.change('响应期限小时','100');t.change('响应期限小时','72');assert.equal(t.button('保存').props.disabled,true);
    t.state.presence.生效响应期限小时=24;await t.poll();assert.equal(t.field('响应期限小时').props.value,'24');
  }finally{t.close();}
});

test('统一刷新只发GET且保留两组草稿；取消一组不丢另一组输入',async()=>{
  const t=await settingsScene();try{
    t.change('响应期限小时','168');t.change('调度模式','lead-discretion');t.change('授权项目','plugins');t.change('授权依据','用户明确授权');
    await t.click('重新读取');assert.equal(t.field('响应期限小时').props.value,'168');assert.equal(t.field('授权依据').props.value,'用户明确授权');assert.equal(posts(t).length,0);
    await t.click('取消修改');assert.equal(t.field('授权项目').props.value,'plugins');assert.equal(t.button('保存调度授权').props.disabled,false);
    await t.click('取消调度修改');assert.equal(t.field('调度模式').props.value,'explicit-user');assert.equal(t.button('保存调度授权').props.disabled,true);
  }finally{t.close();}
});

test('外部策略变更显式保留草稿，禁止陈旧保存，采用当前策略后可继续',async()=>{
  const t=await settingsScene();try{
    t.change('响应期限小时','168');t.state.presence.生效响应期限小时=48;await t.poll();
    assert.equal(t.field('响应期限小时').props.value,'168');assert.match(t.text(),/当前设置已在别处更新/);assert.equal(t.button('保存').props.disabled,true);
    t.field('响应期限小时').props.onKeyDown({key:'Enter'});await t.flush();assert.equal(posts(t).length,0);
    await t.click('采用当前策略');assert.equal(t.field('响应期限小时').props.value,'48');t.change('响应期限小时','96');await t.click('保存');assert.equal(t.state.presence.生效响应期限小时,96);
  }finally{t.close();}
});

for(const group of ['policy','delegation'])test(group+'：同帧双击与回车仅提交一次，读取确认后才恢复操作',async()=>{
  const t=await settingsScene();try{
    if(group==='policy')t.change('响应期限小时','168');else{t.change('调度模式','lead-discretion');t.change('授权项目','plugins');t.change('授权依据','user-grant');}
    const path='/plugins/dsh-mind/'+(group==='policy'?'presence':'delegation');t.state.hold=path;const fn=t.button(group==='policy'?'保存':'保存调度授权').props.onClick;
    fn();fn();t.r.flush();t.field(group==='policy'?'响应期限小时':'授权依据').props.onKeyDown({key:'Enter'});await t.flush();
    assert.equal(posts(t).length,1);assert.equal(t.button('重新读取').props.disabled,true);assert.ok(t.state.release);t.state.release();await t.flush();await t.flush();
    assert.equal(posts(t).length,1);assert.ok(t.elements().some(x=>x.props.role==='status'&&textOf(x).includes('已保存')));
    assert.equal(t.button(group==='policy'?'保存':'保存调度授权').props.disabled,true);
  }finally{t.close();}
});

test('成功回读规范化输入后清除草稿，策略与调度不会互相保存',async()=>{
  const t=await settingsScene();try{
    t.change('响应期限小时','072');t.change('调度模式','lead-discretion');t.change('授权项目','plugins');t.change('授权依据','user-grant');
    await t.click('保存');assert.equal(t.field('响应期限小时').props.value,'72');assert.equal(t.button('保存').props.disabled,true);assert.equal(t.field('授权依据').props.value,'user-grant');
    assert.ok(posts(t).every(x=>x.url.endsWith('/presence')));assert.equal(t.button('保存调度授权').props.disabled,false);
  }finally{t.close();}
});

test('调度改回原值或取消后恢复跟随；未接入不显示硬编码调度模式',async()=>{
  const t=await settingsScene();try{
    t.change('调度模式','lead-discretion');t.change('调度模式','explicit-user');assert.equal(t.button('保存调度授权').props.disabled,true);
    t.state.delegation={mode:'lead-discretion',projects:['external'],authorizationRef:'external-grant'};await t.poll();assert.equal(t.field('调度模式').props.value,'lead-discretion');
    t.state.fail=true;await t.poll();assert.equal(t.field('调度模式').props.value,'');assert.equal(t.field('授权项目').props.value,'');assert.equal(t.field('调度模式').props.disabled,true);assert.equal(t.button('保存').props.disabled,true);
  }finally{t.close();}
});

test('常用页收起人设正文；切换分类和收起编辑保留三组草稿，不产生隐式保存',async()=>{
  const t=await settingsScene({personaText:'原有人设'});try{
    assert.equal(t.button('个性与成长').props['aria-selected'],true);
    assert.ok(!visibleElements(t.r.tree).some(x=>x.type==='textarea'));
    await t.click('编辑核心人设');t.change('核心人设内容','尚未保存的人设草稿');
    await t.click('运行与审批');t.change('响应期限小时','168');
    assert.ok(!visibleElements(t.r.tree).some(x=>x.props['aria-label']==='核心人设内容'));
    await t.click('成员调度');t.change('调度模式','lead-discretion');t.change('授权项目','plugins');t.change('授权依据','用户明确授权');
    await t.click('个性与成长');assert.equal(t.field('核心人设内容').props.value,'尚未保存的人设草稿');
    await t.click('收起编辑');assert.ok(!visibleElements(t.r.tree).some(x=>x.type==='textarea'));
    assert.match(t.text(),/有未保存修改/);await t.click('编辑核心人设');
    assert.equal(t.field('核心人设内容').props.value,'尚未保存的人设草稿');
    assert.equal(t.field('响应期限小时').props.value,'168');assert.equal(t.field('授权依据').props.value,'用户明确授权');
    assert.equal(posts(t).length,0);
  }finally{t.close();}
});

test('分类键盘导航关联唯一可见面板，方向键循环并正确移动焦点',async()=>{
  const t=await settingsScene();try{
    let focused=null;let prevented=0;
    const tabs=()=>t.elements().filter(x=>x.props.role==='tab');
    const key=async(label,value)=>{t.button(label).props.onKeyDown({key:value,preventDefault(){prevented++;},currentTarget:{parentElement:{querySelectorAll(){return tabs().map(x=>({focus(){focused=textOf(x);}}));}}}});t.r.flush();await t.flush();};
    await key('个性与成长','ArrowLeft');assert.equal(focused,'成员调度');assert.equal(t.button('成员调度').props['aria-selected'],true);
    await key('成员调度','Home');assert.equal(focused,'个性与成长');
    await key('个性与成长','ArrowRight');assert.equal(focused,'运行与审批');
    await key('运行与审批','End');assert.equal(focused,'成员调度');assert.equal(prevented,4);
    const active=tabs().filter(x=>x.props['aria-selected']);assert.equal(active.length,1);assert.equal(active[0].props.tabIndex,0);
    const visible=visibleElements(t.r.tree).filter(x=>x.props.role==='tabpanel');assert.equal(visible.length,1);
    assert.equal(visible[0].props.id,active[0].props['aria-controls']);assert.equal(visible[0].props['aria-labelledby'],active[0].props.id);
    assert.equal(posts(t).length,0);
  }finally{t.close();}
});
