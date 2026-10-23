import { it } from 'node:test';
import assert from 'node:assert/strict';
import { renderView, sampleView } from './client-harness.mjs';

it('看板明示Windows命令的部分隔离边界，未核实时不显示完整隔离', async () => {
  const view = sampleView();
  view.核心人设保护 = { 执行状态: '最近返回部分隔离',
    保护范围: '文件工具禁止改写核心人设；命令沿Windows原生沙箱运行，允许部分隔离，不能保证任意命令都无法改卡。' };
  const partial = await renderView(view);
  assert.match(partial.text, /人设保护\s+最近返回部分隔离/);
  assert.match(partial.text, /不能保证任意命令都无法改卡/);
  assert.doesNotMatch(partial.text, /完整隔离/);
  view.核心人设保护.执行状态 = '尚未核实执行隔离';
  const unknown = await renderView(view);
  assert.match(unknown.text, /尚未核实执行隔离/);
  assert.doesNotMatch(unknown.text, /最近返回部分隔离/);
});
