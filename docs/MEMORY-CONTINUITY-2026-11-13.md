# 暂停后接续与总结进度修复

状态：隔离开发、未装载。基线 `34b918677233b1bb42ef3df88050bc82b25bec17`，分支 `fix-mind-memory-continuity`。本轮直接依据用户“你来改吧”及“按天遗忘会导致暂停后接续不上”修正，不采用原来的14天设计。运行检出、真实私人资料、profile及DSH进程均不作为修改或测试对象；未推送、合并或部署。

## 实际保留规则

- 时间是来源信息，不是删除许可。不再因过了14天、轮次已完成、已经摘录或取消保留标记，自动隐藏或删除原文。普通已完成回复不等于整项工作已经结束。
- 同会话读原文/续页、重新打开、继续采集、维护、项目接续、跨会话检索，以及旧外部来源补读沿用同一规则。旧投影已标成3但仍有按时间遗漏的补读，也会在宿主历史可用时重新核对；原清空水位和停用区间仍生效。历史时间未知时保持未知，不编成补读时刻。暂停期间没有新写入时，时间本身不会改变原文分页版本。
- 短期是未主动整理的完整经历工作区，而不是日历倒计时；仍能按需总结、修正、合并和明确遗忘，不是将全部经历标成永久不可删。当前不新增替代天数、轮数上限或另一套必须先登记的任务生命周期。
- 上下文与检索分页预算不变，不将全部磁盘历史注入模型。容量、扫描预算和可用宿主历史仍有实际边界，不能因此声称任意规模历史总能一次召回；未来整理应按经历价值与实际工作进展判断，不能重新偷偷按时间淘汰。
- 维护仍回收无引用分块、临时文件和到期迁移副本。迁移副本的7天是冗余备份寿命，不是原始经历的寿命。旧版已经删掉、截断或宿主未提供的内容不能由此次代码凭空恢复。

## 摘录与理解

- 新元数据 `轮级总结.kind=extract|semantic` 分开记覆盖，基于消息序号、id、正文散列、角色及外部出处，不用共同的最大事件号消费整批经历。
- 自动摘录仍明确是每条最多240字符的机械摘录，不冒充真正的理解，也不抢占后续语义总结范围。语义总结只记实际引用来源；空理解不记完成，未引用的消息仍可继续总结。
- 旧记录无kind时只按其真实正文形式识别。旧语义记录曾把全部待处理消息写入来源清单，兼容时仅把正文实际引用的消息计作已理解。不能识别的旧形式不猜作已理解；不全库改写旧资料。
- 角色校验、当前来源复核、会话写锁与明确遗忘屏障仍生效。暂时认识可沿既有记忆修订入口更正；接口接通不证明模型归纳正确或已经产生收益。

## 验证记录

新增回归先在未改动的基线源码上运行：11项新增场景中10项复现失败，明确遗忘正控通过。另运行13项既有情绪测试，原Windows权限断言 `438 !== 384` 再次复现，其他12项通过。合计24项：13通过、11失败、0跳过/取消，原始结果保留在 `memory-continuity-baseline-no-isolation.log`。

首次默认Node测试进程模式因当前Windows沙箱不支持子进程捕获管道而报 `spawn EPERM`，未执行用例；保留在 `memory-continuity-baseline.log`，不能当作产品基线失败。后续使用Node公开的 `--experimental-test-isolation=none` 避免此管道，不提升权限、不修ACL或改断言。所有资料均为合成临时夹具。

首轮专项65项为64通过、1失败：新增11项全部通过；失败为旧布局迁移调用Windows PowerShell捕获管道被当前沙箱拒绝（spawnSync powershell.exe EPERM）。该同名用例已在未改动基线再次复现，不能计作通过，也不通过改ACL、放宽断言或新跳过来隐藏。原始日志为 `memory-continuity-focused-01.log` 和 `memory-continuity-baseline-migration.log`。

最终功能提交 `7073109fd422e0a5cfd4ef853fb967e50f2e3ae1`。新增19项全部通过，覆盖暂停180/365天、项目摘要接续、旧projection2/3补读、跨项目撤回、无外部消息幸存、未知时间排序、起点变化后的true/false保留标记及明确遗忘。最后一轮相关回归11文件共131项：130通过、1失败、0跳过/取消；唯一失败是已在原基线复现的Windows迁移捕获管道EPERM，不计作通过。原始结果位于 `.w37-final-related` 和 `memory-continuity-final-related.log`。

前一功能提交 `76333eac094354bccf180fca70041f7944995ec3` 做了完整248文件回归：2631项，2574通过、44失败、13跳过、0取消，**不是全绿**。44项失败涉及的同名测试均在未改动的34b9186、同一权限环境中再次复现；三批基线子集共224项，172通过、44失败、8跳过。包含父suite的48个失败标题逐项比较，无新增未匹配标题。主要涉及Windows权限/链接边界和子进程捕获管道；本轮不把旧失败改成成功、跳过或擅自放宽权限。最后的标记关联修正只重跑了上述全部相关路径，**未再次重跑整套248文件**；不能把前一提交的全量结果冒充最终提交的全量结果。

完整回归使用 `test/run-inherited-stdio.mjs` 保留每文件独立进程、4路并行，子进程只继承stdio，TAP由Node公开reporter写入新目录，不改变测试权限。全量原始TAP保存在 `.w37-full-02`，对照在 `.w37-baseline-failures-01` 至 `03`；中间失败结果 `.w37-full-01` 保留。机器可核对汇总及最终源码散列见 [验证记录](<MEMORY-CONTINUITY-VERIFICATION-2026-11-13.json>)。

只读技术咨询发现的跨项目撤回和未知轮时间问题，先用3项失败复现再修；后续发现unknown轮补回前缀导致保留标记丢失，再用true/false两项失败复现并按幸存原消息恢复标记。原失败日志 `memory-continuity-review-before.log`、`memory-continuity-retain-before.log` 均保留。咨询只做有界静态检查；执行和最后标记修正的验证由Lead完成，不冒称正式独立复核票或全产品已验。

预检最终95个内核模块可加载；未改动的前端549条断言和合成安装器10项自检通过。没有真实运行存量迁移、真实GUI装载验收，也没有新增基于价值自动删除原始经历的算法；现有主动整理和明确遗忘仍保留。

## 复跑

```powershell
node --experimental-test-isolation=none --test --test-concurrency=1 --test-timeout=60000 test/memory-continuity-2026-11-13.test.js
node --experimental-test-isolation=none --test --test-concurrency=1 --test-timeout=60000 test/redesign-summary-2026-11-13.test.js test/redesign-summary-race-review-2026-11-13.test.js test/turn-buffer-2026-10-22.test.js test/turn-archive-redesign-2026-11-13.test.js test/deploy-turn-v4-readiness-2026-11-13.test.js test/conversation-recall-2026-10-25.test.js
node test/run-inherited-stdio.mjs
node test/preflight.mjs
node components/board/test/client-harness.mjs
node scripts/verify-profile-install.mjs --selftest
```

## 装载与回退边界

本次没有改存储主格式、搬动真实资料或启动额外模型调用。现运行版本在正式装载本候选前仍遵守其旧规则，不能说源码修好就已保护当前运行资料。后续单独取得本次装载同意，再按实际状态执行；不复用历史部署许可。旧版本即使能读同一格式，也可能重新按天裁剪，不应带着旧规则继续写入而冒充保留策略兼容。
