# 代2返工反证读数

任务复核不过票：`rv-569`。代2本人重新 task_start + policy_check(write,本节点) allow 后继续。

## 当前实例补偿证据接线（真实工具输出摘录）

新加入创建后停机 API 消失的 subagent/team 两臂。第一轮 17 tests：15 pass / 2 fail；两臂外层 Fault 的 `错误详情` 缺失，读 `补偿失败` 抛 TypeError。调查定位：登记适配器已经构造补偿错误，Council 的失败审计带错误详情，但 create catch 未透传到外层 Fault。

修复为同一 create catch 透传既有 error.detail，不新增权限或补偿写入口。随后同一矩阵 17/17 通过：缺接口时补偿失败非 null，含“停机接口…已不可用…未停机”，原登记前失败原因保留，真实停机调用次数为 0。不是把没停当成功。

## 确定性定格并发（真实工具输出摘录）

命令：

```powershell
& $node --test --test-reporter=tap --test-name-pattern '开场发送阻塞后另一Root先收敛' test/v2-council-failure-cleanup-2026-10-18.test.js
```

顺序由 Promise 屏障控制，未用 sleep/时间阈值：

1. 首条开场 send 已进入，阻塞在显式 gate；opened 已提交。
2. 另一 Root 真 answer 全员、unlock、converge，结论已定格并退役。
3. 释放 gate，使先前 send 抛错，再跑其失败作废与 owned 补偿。

修复前真实输出：

```text
not ok 1 - 开场发送阻塞后另一Root先收敛：失败作废不得覆盖已定格状态
error: Expected values to be strictly equal:
'作废' !== '已收敛'
code: ERR_ASSERTION
expected: 已收敛
actual: 作废
# tests 1
# pass 0
# fail 1
exit code: 1
```

只在既有 `#作废` → `#append` 的 inLockGuard 单点增加已收敛硬拒。修后同命令 1/1 通过、退出 0：最终保持已收敛及另一 Root 的唯一原结论，converged=1，aborted=0；外层作废错误含已收敛，拒作废后仍逐个尝试 owned 清理，预给在岗不动。完整证据由最终全门禁与对应变异继续核验，不用本单臂绿替代全版门禁。
