import { setTimeout as delay } from 'node:timers/promises';
import { readJsonOrNull } from '../../../src/kernel/fsx.js';

const REQUIRED_GATES = ['范围闸', '调度创建闸'];

/**
 * 内核先写未确认回执，再在宿主 effect 中注册调度闸。仅开机自检允许等这段装配，
 * 最多五秒；失败或超时仍交给原探针如实判红，手工巡检不经过此等待。
 */
export async function runStartupProbe(org, { signal, timeoutMs = 5000, pollMs = 50 } = {}) {
  const deadline = performance.now() + timeoutMs;
  while (!signal?.aborted) {
    try {
      const receipt = await readJsonOrNull(org.layout.guardReceiptFile());
      if (REQUIRED_GATES.every((name) => receipt?.[name]?.registered === true)) break;
      if (receipt && Object.values(receipt).some((gate) => gate?.registered === false)) break;
    } catch {
      // 损坏或读失败不当作「还在启动」掩盖：原探针负责记录真实错误。
      break;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    try {
      await delay(Math.min(pollMs, remaining), undefined, { signal });
    } catch (error) {
      if (signal?.aborted) return null;
      throw error;
    }
  }
  if (signal?.aborted) return null;
  return org.probes.run({ subject: { id: 'system', kind: '系统' } });
}
