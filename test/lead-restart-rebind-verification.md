# Lead 重启安全续接验证（2026-10-20）

## 边界

- 仓库：`C:\Users\kuro\.dsh\repos\dsh-mind`；基线 `09d5f7a`，工作区补丁，未提交、未推送、未部署。
- 本会话 `session-36041cd3-3fed-4b8c-b500-6a8e460cecd1` 已经在线 registry_can 核验：Lead、在岗、就绪。
- 不改真实身份账本，不恢复任何已封存或撤权身份（包括历史上被旧孤儿回收封存的 Lead）。

## 修复

1. 旧进程死亡时，Lead 仅失效运行绑定，身份状态及生命周期保留；临时成员维持原封存语义。
2. 只有宿主入口传递的匹配根会话事实才可续接：会话 id、非子代理、档案 Lead 岗位、在岗、未撤权、钉卡真实可读、本进程已登记代次、锁内竞态复查。
3. 工具参数中的会话/实例自报不能代替宿主 exec；未知事实、不符岗位、人工封存及撤权均不恢复。
4. 增加封闭机制 `Lead运行绑定`，失效与续接都经策略，分别保留写入意图与完成审计；重复/并发续接不重复完成事件。
5. 凭证闸拒绝失效运行绑定，以及启动回收被拒时已知的异进程旧绑定写权；诊断读保留。
6. 修复 Registry 写回与 Policy 读取忽略 boot 的问题，保留代次事实。绑定更新不改钉卡、身份代数、生命周期或任务事件。

## 实测

- 定向：`node --test test/lead-restart-rebind.test.js test/v2-instance-model-2026-10-18.test.js test/v2-runtime-generation-2026-10-18.test.js`：35/35。
- 最终全量：bundled Node + bundled pnpm 执行 `pnpm test`，退出码 0；950 tests，950 pass，0 fail。
- 浏览器夹具：509 条断言全部通过（464 元素 / 268 文本节点）。这是离线夹具，不是真实 GUI 或应用部署验证。
- `git diff --check` 无错误。
- 使用隔离临时组织与宿主接口夹具验证重启，不重启/部署当前生产应用。第一次全量运行与编辑重叠，曾报新增测试 boot 缺失及代码身份变化；缺陷已修正，稳定源码后全量通过，再补强拒写与审计并完整复跑通过。不能把第一次失败计为通过。

## 最终受验源码 SHA256

| 文件 | SHA256 |
|---|---|
| src/registry.js | 18665EED848A777989F519855713B79BA0D8BA3736B334588FBF68BC2626BF4C |
| src/policy.js | 4412B851AFE9D0B8E6A62F7F108CD3DA2D759E312C1E958941A23FBC956FFA3D |
| src/mechanism.js | 3A8960CCE95694EB5323109BA99F57B857BAFE4707AE786DC5A976838DA8AAEB |
| components/kernel/lib/index.js | 985DC8B7625315B63520910418BD4D8600C22B6ACF9E9B22287E147401047844 |
| test/lead-restart-rebind.test.js | 02EB6DC792DE3295E09695AE56AAE68C300C2F3123230861DF4A58AC5637A51B |
| test/v2-instance-model-2026-10-18.test.js | 8D89CA232C5CEEDE1882243801CECEF620E4870AF92A5B80986755786B8AB256 |

以上指纹由最终全量期间只读提取；后续若源码变动须重验。

## 独立复核状态

未验，不冒充正式采纳。member_spawn 被部署授权闸拒绝：项目 dsh-mind 未配置有效的 Lead 自主调度授权，需主权者/部署者配置授权依据。没有换用普通子代理绕过、没有修改配置。Lead 是执行方，不能给自己签复核票。待授权独立复核者后，对任务 task-修复重启-Lead-安全续接-写-3rds9 复核；此时不得发布候选。
