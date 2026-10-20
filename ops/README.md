# ops 历史归档（不可直接执行）

这些文件来自10-19的运维归档提交`9b94852`，按用户要求随其它代码一起整合到main。**Git合并不是安装/实验/长期委派授权。不要运行历史install、rollback或capture脚本。**

- [历史执行交接](<trial-a/HANDOFF.md>)与[授权快照](<trial-a/AUTHORIZATION.json>)只描述旧会话的一次维护窗口，不是当前许可。
- [固定目标模块](<trial-a/fixed.mjs>)包含本机绝对路径；其相对查找的`ops/batch1/evidence/original-sha.json`、`ops/batch2/evidence/frozen-product.json`未随Git归档，归档不自包含。不得编造manifest、改固定SHA或跳过检查来执行。
- [前置方案](<trial-preflight/PLAN.md>)中的旧GUI/PID/配置和候选指纹不能当现在运行事实。源码已整合，旧冻结/全树检查不能给新树背书。
- 真实安装、重启加载、实验enforcement、批准/拒绝GUI因果、独立复核均未因此通过；当前保持不部署、不启实验、不改身份闸。

## 仅自有无敏夹具的测试

[维护测试](<trial-a/maintenance.test.mjs>)只在自建临时目录测试文件事务，不安装真实profile。[Windows测试](<trial-a/windows.test.mjs>)会在自有无敏目录测DACL并只读观察应用进程；必须由操作者先在OS查询当前GUI监听PID，再经`DSH_MIND_TEST_LISTENER_PID`传入。没有历史PID默认值，未知即失败，不把旧29128硬编码当事实。

本轮实际执行的测试命令与结果见[主干整合记录](<../docs/交接/2026-10-20-主干整合.md>)。测试夹具绿不构成真实安装或独立复核票。
