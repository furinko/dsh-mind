# Lead 直接执行不越授误拒：隔离修复候选

结论：已复现并在全新 HMR 外副本修复；未部署，待 Lead 独立审核。任务：task-核实并隔离修复Lead直接执行任-otxec。成员实例：9626091d-73a6-48a9-b927-c0e303524b7a。

## 范围与写前回执

- 独占副本：`C:/Users/wjthq/AppData/Local/Temp/dsh-mind-direct-bb516c0c2a1444c4ba6ce2126e8c7e9d`；复制时排除 .git/.recovery/node_modules；未改 m56ik 冻结副本。
- Lead 确认其自身只改文档、两名复核员只读，无其他 policy/tasks 写者。复制前后这两件 SHA256 一致。
- 本人先取得 task_start 回执；原 policy_check 因固定空 context 报任务外拒绝后，立即停写并报 Lead，没有旁路。Lead 修薄接口后，本人重新调用 policy_check，任务=本节点，动作=write，目标=自治/私有产物，得到 allow「法律 介入度 · 放权（§4）」后才建立副本落盘。
- 未自行起代理、重启、改 profile、使用 git；未操作 Root 的真实任务账本；本任务只对隔离夹具作实验。

## 证据先行

[基线复现脚本](<C:/Users/wjthq/AppData/Local/Temp/dsh-mind-direct-bb516c0c2a1444c4ba6ce2126e8c7e9d/test/direct-lead-baseline.mjs>) 在未改源码时真加载动作入口、Org、TaskGraph、PolicyEngine，复刻 Root 主体 id + 负责人 Lead + 本人真实绑定形状，读数见[基线日志](<C:/Users/wjthq/AppData/Local/Temp/dsh-mind-direct-bb516c0c2a1444c4ba6ce2126e8c7e9d/direct-baseline.txt>)：

1. 本人真实绑定后 dispatch 被「v2 条目20 · 不越授」拒：Lead@Lead 被当成外派平级；节点仍待派发。
2. 由夹具主权者先派发后，Lead bind 另一 Lead 成功，证明绑定旁门真实存在。
3. 本人实例 id 自领派发后，reassign 另一 Lead 成功，证明改派旁门真实存在。

真实链：动作 task_dispatch → tasks.dispatch → policy.check → #invariants → #不越授 → #被派主体。原解析器仅识别负责人等于 subject.id 的自领，不消费岗位名对应的真实绑定；bind/reassign 只有普通 write，原不越授只认 create/dispatch。

已逐条阅读 24 条口述收敛，特别是 9/10/11/20：Lead 多实例、钉卡、负责人岗位名与实例绑定、禁止扩权。直接执行不是造另一个 Lead，不通过放宽平级外派来修复。

## 最小机制改动

部署白名单仅两件生产源和一件回归测试：

- [策略引擎](<C:/Users/wjthq/AppData/Local/Temp/dsh-mind-direct-bb516c0c2a1444c4ba6ce2126e8c7e9d/src/policy.js#L1177-L1324>)：现有 #不越授 承接实例绑定和改派；岗位 Lead 只有该岗绑定非空、全部为本人、本人真实在岗档案是 Lead 才标自领。逐一审视实际绑定；旧绑定声明或当前档案任一指向高权，都不能被低权那一边掩盖。原职权级映射和成员父域实现不变。
- [任务图](<C:/Users/wjthq/AppData/Local/Temp/dsh-mind-direct-bb516c0c2a1444c4ba6ce2126e8c7e9d/src/tasks.js#L324-L490>)：派发用账本锁内新投影判定；绑定的在岗/岗位/负责人验证移入同一锁，候选绑定通过真实 fold 生成；改派以锁内新投影替换候选负责人后送原判定点。#append 等待既有 inLockGuard 的异步结果。动作层不接受模型自报的 context/task/自领。
- [新增回归测试](<C:/Users/wjthq/AppData/Local/Temp/dsh-mind-direct-bb516c0c2a1444c4ba6ce2126e8c7e9d/test/direct-lead-execution.test.js>)：17 项真链行为测试，覆盖两个正门、外派/混合/伪造反例、绑定/改派侧门和确定性任务队列竞态。

单源搜索范围=隔离根 src 全部文件；#不越授 定义 1、#被派主体 定义 1、本人自领岗 实现 1；未新增并存实现、公开 API、授权对象或岗位等级表。无新增生产导出。只有这两件已有源与复制时基线不同（机器核查见最终哈希清单）。

## 验证命令与读数

以下命令 cwd 为隔离根；预检及所有测试不读写真实组织数据。

```powershell
node --check src/policy.js
node --check src/tasks.js
node --test test/direct-lead-execution.test.js
node test/preflight.mjs
node --test "test/*.test.js" "components/board/test/*.test.js"
node components/board/test/client-harness.mjs
```

- [针对性回归](<C:/Users/wjthq/AppData/Local/Temp/dsh-mind-direct-bb516c0c2a1444c4ba6ce2126e8c7e9d/direct-focused-final.txt>)：17/17，含本人派发→开工→交卷、负责人仍岗位名；另一 Lead/主权者/出厂作者、混合负责人/混合绑定、登记高权、伪造 context、真实档案不符、普通成员父域限制均按预期。
- [preflight](<C:/Users/wjthq/AppData/Local/Temp/dsh-mind-direct-bb516c0c2a1444c4ba6ce2126e8c7e9d/direct-preflight.txt>)：通过；内核模块 30 个可真加载，包入口/出厂卡/半区结构合规。
- [完整回归](<C:/Users/wjthq/AppData/Local/Temp/dsh-mind-direct-bb516c0c2a1444c4ba6ce2126e8c7e9d/direct-full-suite.txt#L1402-L1409>)：894/894，251 suites，0 fail/skip；已收齐后台 job pwsh-76c7a2046e1f4764，exit 0。
- [客户端 harness](<C:/Users/wjthq/AppData/Local/Temp/dsh-mind-direct-bb516c0c2a1444c4ba6ce2126e8c7e9d/direct-client-harness.txt#L505>)：503 条断言通过。
- tsc/knip/jscpd：本包未配置，未安装工具、未宣称已运行；采用原 package 门禁及真加载行为回归。

### 三个独立变异副本的反证

只改 direct-mutations 下的独立副本，不原地污染候选源；之后候选 SHA256 仍不变。

1. 删除岗位 Lead 自领分支 → [正例被不越授拒](<C:/Users/wjthq/AppData/Local/Temp/dsh-mind-direct-bb516c0c2a1444c4ba6ce2126e8c7e9d/direct-mutation-self.txt>)，exit 1，1/1 fail。
2. 取消 bind/reassign 接入不越授 → [两项 Missing expected rejection](<C:/Users/wjthq/AppData/Local/Temp/dsh-mind-direct-bb516c0c2a1444c4ba6ce2126e8c7e9d/direct-mutation-policy.txt>)，exit 1，2/2 fail。
3. dispatch 策略上下文退回锁外旧 node → [先加绑另一 Lead 后仍派发成功，被断言抓住](<C:/Users/wjthq/AppData/Local/Temp/dsh-mind-direct-bb516c0c2a1444c4ba6ce2126e8c7e9d/direct-mutation-lock.txt>)，exit 1，1/1 fail。

这些红是目标行为断言，不是任何错误均算通过的 expect-fail；修复候选是同一套判据的正向绿臂。最初测试夹具两处假红（准备混合上级节点时误走被测Lead通道；首版队列只同时起调用、未等实际入队）已修正为主权者建立初态及观察真实 serializeByKey 入队，不改被测对象的合法语义。

## 哈希与部署前门槛

| 白名单 | 复制时/当前 live 原 SHA256 | 候选 SHA256 |
|---|---|---|
| 策略引擎 | 098755fca9e1e61377ee816fe999fc1be7065305e4a437f8824c6a6e83684253 | ff22b8ee9cfd96eca119094c7018cc861a7e07a40fcd354e8850ae9d6342349f |
| 任务图 | 82d1ebadad10cfc6dab166ccce6b36823383d5466fb8929fa0db2ea357ce5d82 | ac9c75f73d0afa95c4fe4a3a7f22da0fa38f0427b55f17a03e7ba3ac4d3149d6 |
| 新回归测试 | 新增 | 42b95c8cb5bb45f4212875da15080597c6bd96ef1136079d1805f8b92d393b10 |

[最终哈希清单](<C:/Users/wjthq/AppData/Local/Temp/dsh-mind-direct-bb516c0c2a1444c4ba6ce2126e8c7e9d/direct-final-hashes.json>) 单列生产改动原/新/live 前值及所有本次交付证据摘要；该清单不自哈希。源树改前完整摘要另保留在基线清单。

Lead 人工审核后才允许按白名单原子上线；上线前必须再次比对两个 live 原 SHA，不匹配即停，不做盲覆盖。严禁整棵目录覆盖：direct-mutations 内是刻意坏代码，direct-*、基线脚本、报告仅属证据，不上线。

## 边界与风险

- 本结论仅是 HMR 外候选源码与隔离真实模块链的绿，不是线上已经生效。必须由 Lead 上线后用真正 Root 自绑定节点亲自验证，再查实际代次/加载证据；成员不代 Root 派发，不自批、不自启代理/重启。
- 同任务账本并发已确定性验证；身份档案另属其本来锁域，此次没有新增跨账本原子事务或改变多进程文件锁原语。不声称覆盖任意跨进程身份更换瞬间。
- 锁内策略判定增加账本锁占用；绑定候选复用 fold 会多折叠一次本项目事件流，性能未做规模基准。该操作属于低频排兵，不新建缓存事实源。
- 旧账有他人高权绑定，即使现档降岗/封存也不允许由 Lead 把其声明隐去；须主权者明确处理。这是保守拒绝，不自动洗账。
- 任务写域子集真凭证缺口沿用原声明，本次未补权限模型；普通成员父域、负责人岗位名、真实绑定验证、只读复核/冻结判据/审批门槛没有松绑。
