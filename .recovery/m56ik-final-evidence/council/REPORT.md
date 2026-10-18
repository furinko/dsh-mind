# 受管会审失败清理修复交卷（代2）

节点：`task-按独立审查修复受管会审审批与审计-p3zzj`  
执行主体：`24581596-3601-4cb2-99a7-14dfb6dad4de`（插件工程）。已先开工，再用本人任务上下文取得 `policy_check(write)` allow。

## 结论与边界

冻结判据对应修复与隔离验证已完成，待独立复核和 Root 合并；**不是 live 生效声明**。无 live 写入、无 git、无 profile 改动、无重启、无新服务、无代理委派。

产品改动仅三件：[actions.js](<C:/Users/wjthq/AppData/Local/Temp/dsh-mind-councilfail-210fe8c6cc7a4855814d87b61738ce63/lib/actions.js>)、[council.js](<C:/Users/wjthq/AppData/Local/Temp/dsh-mind-councilfail-210fe8c6cc7a4855814d87b61738ce63/src/council.js>)、[intervention.js](<C:/Users/wjthq/AppData/Local/Temp/dsh-mind-councilfail-210fe8c6cc7a4855814d87b61738ce63/src/intervention.js>)。既有 [approval-plan.js](<C:/Users/wjthq/AppData/Local/Temp/dsh-mind-councilfail-210fe8c6cc7a4855814d87b61738ce63/lib/approval-plan.js>) 已唯一转调 councilPlan，保持字节不变，未复制补偿定义。没有修改 policy、tasks、registry 或 kernel guard。并发其他写者及其写域按 Lead 正式书确认；采用独占 HMR 外 Temp 全产品副本，不参与共享配置/索引/提交。

## 先反证，后修复

[改前故障读数](<C:/Users/wjthq/AppData/Local/Temp/dsh-mind-councilfail-210fe8c6cc7a4855814d87b61738ce63/baseline-failure.txt.utf8>)：真实 Org/Registry/Council/Policy/runAction + 契约宿主桩，8/8 失败，不是抽取函数或文本判据。

| 反证 | 改前实测 | 本版行为 |
|---|---|---|
| 审批已批准，第二 spawn 失败 | owned-1 仍在岗；补偿失败原文为 seal 还需审批 | owned-1 封存、停机尝试，补偿失败空；介入请求记失败 |
| 登记落盘后状态变更/主体创建/成员创建审计失败 | 当前 id 未进入 Council owned 清单，漏封存 | 在登记适配器内确认已落身份并清当前 id；原错误和补偿错误都回传 |
| opened 已落，发起审计失败 | 永久作答中 | aborted 冻结作废，再清 owned；预给参与者不变 |
| converged 已落，普通/零分歧审计失败 | stop=[]，结论不可重试而实例遗留 | 本调用 onCommitted 记录落线事实，锁外逐个退役；错误合并，结论仅一条 |
| member_list 同 id 登记与真实子代 | 来源、名称 null | 合并岗位与宿主来源/名称；team 去重；未知运行状态 null |

## 代2返工闭环（不过票 rv-569）

本人按打回回执重新 task_start（代2执行中），再取得本任务 policy_check(write) allow。仅同一独占副本续修，没有扩大产品写域。

- 严格停机分支在调用点验证实际函数、保留服务方法 this、并 await。创建后 `subagent.drainChildren` / `team.interrupt` 消失时，明确返回未停机的补偿失败；普通 member 默认尽力分支保持旧合同。
- 受管 open 的 Fault 根据真正提交边界分别说明“opened 已落线但发起审计失败”或“opened 未能落线”；详情显式给 `opened已落线`，不把补偿尝试写成成功。
- 故障注入另抓到当前实例补偿详情只进审计而未进外层 Fault，现从 create catch 透传既有 error.detail；未新增权限或补偿写入口。
- Promise 屏障反例实证：开场发送阻塞→另一 Root 完成 answer/unlock/converge→释放发送失败，修前终态“作废 !== 已收敛”。仅在现有 `#作废` 的 append 锁内 guard 拒绝覆盖已收敛；作废错误照实回执，仍逐个 owned 清理。修后唯一结论保持、converged=1、aborted=0，预给不动。
- [返工反证摘录](<C:/Users/wjthq/AppData/Local/Temp/dsh-mind-councilfail-210fe8c6cc7a4855814d87b61738ce63/rework-baseline.md>) 保存上述实红→实绿顺序。最终全版门禁读数见下节，不沿用代1绿色。

## 批准补偿的限定机制

- 冻结计划 N=2 从三步扩为五步：create 会审、两次身份 create、两条**条件 seal**；主权者预览可见 `补偿自=2/3`、失败触发条件及预给/别场排除条件。
- 运行期新建映射不接受工具 JSON 的 `owned` 自报。适配器核对三证：spawn 前档案无此身份；当前请求已实际匹配该身份 create 步；落盘身份绑定本场/项目/真实来源主体。登记审计失败的 catch 同样核验这三证。
- 补偿 seal 只匹配映射内目标及对应创建步序，一步一次；重复策略检查沿既有写入身份幂等，不新增全局 seal 豁免、不改 policy、不伪造主权者。
- 正常成功不调用失败补偿；已有身份冒返时不改绑、不封、不停预给或别场。
- converged 清理只由**本调用**事件已落线事实触发；并发输家不会借其他调用已收敛而再次退役。
- 退役本体、retired 事件、退役失败审计、存档读取、介入失败记账的错误均保留。账本故障无法保证补记成功时，以明确错误回执和已落事件留事实，不伪称全成功。

## 验证读数（本独占副本工作树面）

1. 首轮改前 8/8 红；首次修复同一组 8/8 绿。
2. 真 apply 入口、域服务、并发及新故障负例的组合回归 53/53 绿；后续补充错场绑定及代2全部负例已包含在以下最终完整门禁。
3. 本版完整门禁：[gate-results.json](<C:/Users/wjthq/AppData/Local/Temp/dsh-mind-councilfail-210fe8c6cc7a4855814d87b61738ce63/gate-results.json>) 三步退出码均 0：
   - [preflight.log](<C:/Users/wjthq/AppData/Local/Temp/dsh-mind-councilfail-210fe8c6cc7a4855814d87b61738ce63/preflight.log>)：30 内核模块全部真加载，组件/exports/出厂件结构通过。
   - [full-tests.log](<C:/Users/wjthq/AppData/Local/Temp/dsh-mind-councilfail-210fe8c6cc7a4855814d87b61738ce63/full-tests.log>)：895 tests / 250 suites，895 pass / 0 fail / 0 skipped，112615 ms。
   - [client-harness.log](<C:/Users/wjthq/AppData/Local/Temp/dsh-mind-councilfail-210fe8c6cc7a4855814d87b61738ce63/client-harness.log>)：503 断言全过。
4. [mutation-results.json](<C:/Users/wjthq/AppData/Local/Temp/dsh-mind-councilfail-210fe8c6cc7a4855814d87b61738ce63/mutation-results.json>)：七个新 Temp 全产品变异副本分别移除定格作废锁内闸、严格停机接口检测、正确 opened 提交边界文案、owned 限定、登记审计清理、提交后清理通知、成员来源合并，均以目标断言实红退出 1；脚本核验具体失败见证，不把任意异常当成功。原被测树三件产品源码 sha 前后逐件相同。

新故障测试共 18 例（含代2两种停机API消失、opened未提交、定格队列四例），覆盖非本请求、非 owned、未匹配 create、仅预检未首登、错创建步序、异主体、预给、别场、冒返旧 id、落盘错场、正常成功、重复判定不多耗且不能多封、审计失败逐个退役并合并错误。测试入口：[故障测试](<C:/Users/wjthq/AppData/Local/Temp/dsh-mind-councilfail-210fe8c6cc7a4855814d87b61738ce63/test/v2-council-failure-cleanup-2026-10-18.test.js>)。

### 复现命令

在本报告所在独占副本目录执行，Node 为已装载运行时的 v24.21.0；环境 PATH 未提供 node，故使用绝对路径：

```powershell
$node='C:\Users\wjthq\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $node --test test/v2-council-failure-cleanup-2026-10-18.test.js
& $node verify-councilfail.mjs
& $node mutate-councilfail.mjs
```

[全门禁脚本](<C:/Users/wjthq/AppData/Local/Temp/dsh-mind-councilfail-210fe8c6cc7a4855814d87b61738ce63/verify-councilfail.mjs>) 严格执行项目清单的 preflight、全部 test 与 board test、client harness，不缩小全门禁候选池；子进程用文件描述符输出，不捕获管道。变异脚本保留独立副本，不原地改被测资产。

## 合并物与原/新 sha

- [repair.diff](<C:/Users/wjthq/AppData/Local/Temp/dsh-mind-councilfail-210fe8c6cc7a4855814d87b61738ce63/repair.diff>)：3 产品、2 受影响测试、1 新测试。
- [merge-manifest.json](<C:/Users/wjthq/AppData/Local/Temp/dsh-mind-councilfail-210fe8c6cc7a4855814d87b61738ce63/merge-manifest.json>)：全部原/新完整 SHA256；导出时核验对应 live 仍等于原 sha，漂移即硬失败，不产生盲覆盖。

| 产品 | 原 sha 前12位 | 新 sha 前12位 |
|---|---|---|
| actions | 14005a844d19 | 294794eaef20 |
| council | b93d19b410af | 177974dbf72f |
| intervention | 4f6f3cc129d4 | a73f03fe9732 |
| approval-plan（未改） | b23d9dd51d33 | b23d9dd51d33 |

Root 应按完整原 sha 比对后将三件互依产品与测试同批原子合并，再在合并终态重跑门禁及获批重启验证。旧冻结的三步 open 审批与新五步计划不一致时按现有计划校验拒绝，需要重新申请，不迁移或静默扩权。

## 卫生与验证盲区

- 单源检索在本副本全部 `.js` 面完成：`记录本次新建` 实现仅 intervention 一处，产品调用仅 actions 一处；补偿计划定义仅 council 一处；approval-plan 沿原路委托，不添 V2 或并存入口。
- 移除旧登记异常清理分支，复用同一登记适配器失败回调；作废集中到一个私有方法供三个失败分支使用；未新增依赖或预留残骸。
- 这是临时工作树与契约宿主桩面，不代表 GUI 发包/页面执行、真实宿主进程已换版。未获重启权限，也没有 cordis_inspect 工具，因此未宣称在线运行契约已验收。
- 完整 npm 等价门禁已跑；仓库未配置 tsc/knip/jscpd，未擅装依赖、未宣称这些额外工具已运行。
- 底层磁盘不可写时不能保证 aborted/retired 新事件可落盘；机制尽力逐个清理并回报具体失败，不能伪造持久成功。进程在故障处理中被硬杀的恢复不在本批声明范围内。
