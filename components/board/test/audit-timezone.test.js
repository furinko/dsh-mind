import {it} from 'node:test';
import assert from 'node:assert/strict';
import {renderView,sampleView,findAllByClass,textOf} from './client-harness.mjs';
async function show(times,timeZone='Asia/Shanghai') {
 const view=sampleView();view.审计尾=times.map((时间,i)=>({seq:i+1,时间,at:'1999-01-01T00:00:00Z',动作:'时间测试-'+i,主体:'lead',档位:'全记',结果:'记'}));
 view.生成于='2040-01-01T00:00:00Z';const before=JSON.stringify(view);const page=await renderView(view,{timeZone});assert.equal(JSON.stringify(view),before,'不得改写原投影时间');
 const labels=findAllByClass(page.tree,'dshmind-auditRow').map(row=>row.props.children[0]).reverse();return {page,labels};
}
it('UTC审计转换北京时间并跨日，使用事件时间而非投影生成时间或其他字段',async()=>{
 const {page,labels}=await show(['2026-10-24T16:05:06Z']);assert.equal(textOf(labels[0]),'10-25 00:05:06');assert.match(labels[0].props.title,/2026-10-25 00:05:06.*Asia\/Shanghai.*UTC\+08:00/);assert.match(labels[0].props.title,/原始时间：2026-10-24T16:05:06Z/);assert.match(page.text,/本地时间（Asia\/Shanghai）/);
 assert.equal(textOf(findAllByClass(page.tree,'dshmind-tlTime')[0]),'10-25 00:05');
});
it('带正负偏移的相同时刻统一显示，不重复加八小时',async()=>{
 const {labels}=await show(['2026-10-24T16:05:06Z','2026-10-25T00:05:06+08:00','2026-10-24T12:05:06-04:00']);assert.deepEqual(labels.map(textOf),['10-25 00:05:06','10-25 00:05:06','10-25 00:05:06']);
});
it('按浏览器所在时区显示；不把北京时间写死给其他地区用户',async()=>{
 const {labels}=await show(['2026-10-24T16:05:06Z'],'UTC');assert.equal(textOf(labels[0]),'10-24 16:05:06');assert.match(labels[0].props.title,/UTC/);
});
it('夏令时回拨的两个01:30保留不同UTC偏移和原始值',async()=>{
 const {labels}=await show(['2026-11-01T05:30:00Z','2026-11-01T06:30:00Z'],'America/New_York');assert.deepEqual(labels.map(textOf),['11-01 01:30:00','11-01 01:30:00']);assert.match(labels[0].props.title,/UTC-04:00/);assert.match(labels[1].props.title,/UTC-05:00/);assert.notEqual(labels[0].props.title,labels[1].props.title);
});
it('缺时区、无效日期和空时间不猜测为当前时间或1970年',async()=>{
 const values=['2026-10-24T16:05:06','2026-02-30T10:00:00Z','bad-time',null];const {page,labels}=await show(values);assert.deepEqual(labels.map(textOf),values.map(v=>v||'—'));assert.match(labels[0].props.title,/时区无法核对/);assert.equal(labels[3].props.title,'时间未提供');assert.doesNotMatch(page.text,/NaN|Invalid Date|1970-01/);
});
