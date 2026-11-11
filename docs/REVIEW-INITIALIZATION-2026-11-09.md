# 受控复核实验初始化修复（2026-11-09）

## 状态与边界

本件是从冻结流程候选 `f19af6054ecb71af1966c4f3a5ac93962f49a8de` 派生的新隔离候选，未装载、未推送、未重启。原冻结候选和原交付包保留。作者自测不是独立复核票，也不是当前桌面运行通道已恢复的证明。

真实复核员已经成功创建，并通过正式 `task_attach` 读根读到文件；不需要追加普通成员文件白名单，也不需要重建实例。随后真实 `review_experiment_allow` 返回 `EXPERIMENT_NOT_WIRED`，没有生成许可，没有独立实验运行。

## 原因：已证实什么、尚未证实什么

旧源码在默认自主实验服务初始化时立即用 `process.execPath` 生成并校验默认 Node，即便之后 Lead 的每项配方都会显式提供另一执行器。桌面 Electron 可执行文件实际为 246,343,656 字节，独立 Node 为 93,580,104 字节；原校验上限为 134,217,728 字节。

隔离的独立 Node 进程把该 Electron 路径作为数据代入，旧构造器复现 `DENIED / 可执行文件不是有界实体文件`，还原独立 Node 后旧构造器正常。新增单测也用超限合成文件复现。没有运行 Electron，没有改变活进程属性；这证明源码初始化缺陷与实际文件体积不相容，**不证明已取得当前活进程的异常堆栈或完整配置**。真实入口的未接线故障与此缺陷相符，但其他初始化原因仍不能排除。

## 最小修复

- [执行器选择](<../src/review-autonomy.js>)：服务初始化只校验配置与预算，不读取未使用的宿主执行器。命名配方显式指定路径时，仍逐项校验实体文件、128MiB上限与SHA，并冻结实际argv。
- 省略执行器时才尝试当前宿主 Node。只有 Node release/version 身份且没有 Electron/Bun 标识的进程允许默认选择；Electron/不明宿主明确要求 Lead 指定，不扫描安装目录、不猜路径、不启动 Electron。兼容内建配方同样遵守默认身份判断。
- 自主配置使用 `per-recipe-v2` 指纹标记，默认 `node:null`；真实解释器保存在每项配方中。新配置不能悄悄复用旧配置许可；旧许可记录、输出与旧白名单模式不改写。
- [许可记录](<../src/review-experiments.js>)不再把未使用的宿主执行器伪装成已冻结顶层 Node；审批预览及配方详情继续包含实际路径、SHA、argv。身份、任务、正式读根、宿主权限交集、预算、撤回、执行前复核及审计逻辑未放宽。
- [工具说明](<../components/kernel/lib/index.js>)与[接口合同](<../INTERFACES.md>)明确 Electron 下不能省略执行器。
- 显式 `null` 执行器按非法路径拒绝，不作为“省略”降级到默认值。

## 可复跑证据

证据目录在仓库旁的 `audits/mind-flow-20261106/review-init-20261109`，最终源码/证据哈希及原交付核验另见该目录的交付清单。

| 检查 | 已观察结果 |
| --- | --- |
| [新增初始化单测](<../test/review-initialization.test.js>)修前 | 6项：1过、5失败，原红测保留；并非把失败算通过 |
| 初始化与既有实验/复核生命周期专项 | 98/98，无跳过 |
| [实际公开SDK接线测试](<../test/review-initialization-sdk.mjs>) | 新SDK单项批次5/5；覆盖登记完整计划、冻结实际Node、复核员run/read、Lead不可代跑、隐式Electron拒绝、显式停用、坏配置、读根及环境注入拒绝 |
| DSH 0.2.2-rc.1完整SDK相关套件 | 133/133，无跳过 |
| DSH 0.2.1-rc.5完整SDK相关套件 | 最终129/129，无跳过；初次128过/1失败是夹具携带undefined，旧SDK不允许无损JSON序列化，已改为真正省略字段并保留原失败 |
| 全量两次（含最终功能源码复跑） | 每次2538项：2524过、1失败、13明确跳过，0取消；未把已知失败计为通过 |
| preflight / client-harness | 90模块可加载 / 549断言通过 |

全量唯一失败位于 [lead-affect测试:38](<../test/lead-affect-2026-10-31.test.js#L38>)：Windows模式位438（0666）与预期384（0600）不同。此前冻结基线已有相同失败；本次未修改该代码或夹具，也不据此断言真实ACL缺陷。13项跳过仍是未验证，不计通过。

SDK测试使用实际 Cordis、Session、ToolRuntime、选定版本的执行器和完整 Mind 内核；任务/成员/子目录及进程输出服务是合成依赖。测试中的run/read是作者驱动的隔离合同验证，不是当前真实复核员的独立实验，也不是实际模型、桌面GUI或OS隔离验收。公开SDK目录属于外部传递依赖，不因顶层Node/SHA被冻结就宣称整棵依赖均已冻结。

### 复现示例（PowerShell，独立候选目录内）

```powershell
$node='C:/Users/kuro/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe'
& $node --test --test-concurrency=2 --test-timeout=60000 --test-reporter=tap test/review-initialization.test.js test/review-autonomy.test.js test/review-experiment-entry.test.js test/review-experiment-process.test.js test/review-experiments.test.js test/review-task-lifetime-2026-10-28.test.js
$env:DSH_SDK_ROOT='C:/Users/kuro/.dsh/repos/audits/mind-flow-20261106/sdk-022rc1'
& $node --test --test-concurrency=2 --test-timeout=60000 --test-reporter=tap test/mind-flow-kernel-sdk.mjs test/host-creation-bridge-sdk.mjs test/review-initialization-sdk.mjs
# 换为已准备的 sdk-rc5 目录再运行同组SDK测试
& $node --test --test-concurrency=4 --test-timeout=120000 --test-reporter=tap 'test/*.test.js' 'components/board/test/*.test.js'
& $node test/preflight.mjs
& $node components/board/test/client-harness.mjs
```

## 后续恢复条件

不得以本件离线源码替代运行态恢复。需另行取得针对实际运行插件装载/生命周期操作的明确同意，核对那次真实加载版本与实验入口，再由 Lead 在正式复核读根内登记许可。成功后由原复核员亲自选配方运行、读取原始结果并出票。若复核新候选，必须明确更新被验业务/正式读根和版本，不把旧候选的复核任务暗换成新版本。不调整全局文件白名单、不借裸shell或另建普通代理绕过当前实验服务缺失。
