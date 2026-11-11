# Mind 调度流程候选：交付与复现

> **仅隔离源码候选，作者自测；不是独立验收票，也不是装载许可。**
> 以交付清单的 commit、文件 SHA256 和原始日志为准。没有改运行插件、profile、私人数据，也没有推送、重启或真实模型试验。

## 范围

从冻结 `92a82ed11c80df0cb0b5933e7e671257a1da36b7` 建立 `fix/mind-flow-20261106`，只修 Mind 调度流程。原 Mind 权限修复、DSHOME 工作台 `c2b3329`、可选集成 `78f0e734` 不变；本候选不包含后两份工作台增量。包版本仍为 `1.10.0`，不能用包版本号区分候选和运行代码，必须核对提交/内容指纹。

## 行为变化

| 情形 | 本候选行为 |
|---|---|
| delegation 缺席或真正的 `{}` | Mind 不再要求额外项目创建许可；每次仍走真实 Host 准入 |
| 明确 `explicit-user` 或无 mode 的旧部分配置 | 保留限制，不从缺字段推断同意 |
| `host` 且 projects 非空 | 项目范围继续收紧 |
| 非法配置、失效内核或缺少官方执行接口 | 明确拒绝，不直调底层创建服务 |
| Host deny、ask、禁用、执行器撤销 | 不用工具可见/服务存在替代许可，不换执行器、不改走普通子会话 |
| `member_stop` | 与新建资格分离；验证真实父子、当前项目、精确任务/会审归属及目录；仅报告请求，不认证停止 |
| Team 失败补偿/退役 | 同样经过官方 `interrupt_agent`，不是宿主禁用或审批的豁免；等待后重核归属、政策和精确目标 |
| 复核缺对象/读根 | 用 `task_bind` / `task_attach` 修原任务，再联系同一实例，不必重建 |

`canAttempt` 只是 Mind 资格，`authorized` 只是旧显式授权读数，`hostAdmission=not-evaluated` 不是 Host 已批准。当前运行配置仍为明确的旧限制，**安装候选不会自动撤销它**；如需改动，必须由有权的人另行调整。

## 冻结判据与源码索引

1. 默认、旧限制和坏配置：[统一策略](../src/delegation-policy.js)、[专项](../test/delegation-host-follow.test.js)、[设置服务](../components/kernel/lib/delegation-settings.js)、[设置交互](../components/board/test/delegation-settings.test.js)。
2. 真实 Host 创建/中断准入：[私有桥](../src/host-creation-bridge.js)、[内核接线](../components/kernel/lib/index.js)、[官方 SDK 桥专项](../test/host-creation-bridge-sdk.mjs)、[完整内核 SDK 专项](../test/mind-flow-kernel-sdk.mjs)。
3. 原任务/岗位/文件/目标/预算：[创建计划](../lib/member-spawn-plan.js)、[会审](../src/council.js)、[成员创建账](../src/spawn-operation-ledger.js)、[会审创建账](../src/council-creation-ledger.js)、[预算回归](../test/goal-budget-integration-2026-10-20.test.js)。沿用原冻结文件域和 Host 上限；没有引入模型自报授权。
4. 恢复与回执：[既有维护](../lib/member-maintenance.js)、[公共生命周期封装](../lib/host-execution.js)、[停止反例](../test/member-stop.test.js)、[恢复说明](RECOVERY.md)。停止、封存、驻留释放、inbox 接收、任务完成各自分开。
5. 原始验证与不足：[逐轮记录](MIND-FLOW-2026-11-06.md)保留红测、失败、跳过及测试修正；下面的复现步骤不需要接触运行数据。

## 测试真实性与未验项

- SDK 专项采用真实 Cordis、Session、projection、ToolRuntime、当前 NativeToolExecutor、官方工具及完整 Mind 内核。创建、目录、inbox、中断为**可计数的合成服务**，不创建真实子 Agent，不调用模型。
- 采用实际公开 SDK 副本：DSH `0.2.2-rc.1` / Cordis `4.1.0`，另跑 `0.2.1-rc.5` / Cordis `4.0.5`。旧版少四个新版执行器/PTC 专用测试，不是跳过公共用例。peer 版本声明不意味着其他所有历史版本已验证。
- Host 内部异步过程不是原子事务。宿主结果未知时保留原调用意图，拒绝盲重建/盲补偿；请求返回不证明子回合或外部副作用已停止。
- Windows 完整回归有一个已在冻结基线复现的 POSIX mode `438 != 384` 失败；没有修掉/跳过它，也不把它解释为真实 Windows ACL 缺陷。另有显式跳过，不能计为通过。
- 三个旧 SDK 撤销 fixture 曾误用 `tasks.close` 签名。已修正并增加实际终态与 Host 目录计数断言；先前对应的绿色结果不能当作真正的任务撤销证据。
- 独立复核、真实成员运行、生产 GUI、运行态装载均未验。所有作者自测都不替代独立复核。

## 本机复现

在隔离候选根目录运行；`$node` 和 `DSH_SDK_ROOT` 可换成自行核验的同版本公开副本。不要将运行 profile 或私人目录作为夹具输入。

```powershell
$node='C:/Users/kuro/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe'
& $node test/preflight.mjs
& $node components/board/test/client-harness.mjs
& $node --test --test-timeout=120000 --test-reporter=tap 'test/*.test.js' 'components/board/test/*.test.js'
# 完整回归仍有已披露的基线失败；请核对原始错误，不吞掉退出码。

$env:DSH_SDK_ROOT='C:/Users/kuro/.dsh/repos/audits/mind-flow-20261106/sdk-022rc1'
& $node --test --test-timeout=60000 --test-reporter=tap test/mind-flow-kernel-sdk.mjs test/host-creation-bridge-sdk.mjs

$env:DSH_SDK_ROOT='C:/Users/kuro/.dsh/repos/audits/scenes-20261105/sdk-rc5'
& $node --test --test-timeout=60000 --test-reporter=tap test/mind-flow-kernel-sdk.mjs test/host-creation-bridge-sdk.mjs
```

常规完整回归的 glob **不包含 `.mjs` SDK 专项**，不能只跑 `npm test` 就称 SDK 验证完成。无 SDK 时，不可将跳过当通过。公开 SDK/依赖目录不打进源码交付，不执行归档的历史运维脚本。

## 独立复核与装载

作者交卷后，应对同一冻结源码/证据建立显式复核对象和必要只读根；需要独立复跑时，先登记冻结实验许可，再让复核员自己选配方执行并出票。当前运行调度限制未变，不能借这个尚未装载的候选绕过创建限制，也不能用普通代理代签。

源码交付不等于整体采纳。获得有效独立结论后按原票处理；装载、运行插件替换或重启仍需用户针对该次操作明确同意。保留原三份冻结交付，不为合入候选改写它们。
