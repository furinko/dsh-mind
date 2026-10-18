# 代码审查报告：dsh-mind 与 DSHOME-Plugin（2026-10-14）

## 审查方式与范围

- **对象**：`dsh-mind`（宿主插件：src/ 17 模块 + lib/actions.js + components/kernel·guard·board）与 `DSHOME-Plugin`（纯客户端插件），合计约 1.7 万行源码（不含测试）。
- **方法**：6 个子代理按模块并行逐行审查（权限主体链 / 记忆存储 / 任务审计总线 / 基础设施入口 / 看板客户端 / DSHOME 客户端），**主会话对全部 P0/P1 逐条 read 原文核验**，下方标注「已核验」的条目均经主会话亲自确认属实。
- **基线**：审查时三个测试面全绿——dsh-mind `node --test` **493/493**、看板 client-harness **483 断言全过**、DSHOME selftest **60/60** + domtest **95/95**。本报告所列问题全部是测试照不到的静态/契约/真机行为面。

## 结论速览

- **P0（崩溃级）：0 条**。两个插件均无必崩路径。
- **P1（行为错误/机制失效）：12 条**，集中在三个族：①机制写了半套或写了没接线；②锁外判定/锁内落笔的 TOCTOU 残留；③对宿主真实行为（React passive 监听、NTFS 等价类）的假设错误。
- **P2 约 20 条，P3 约 40 条**，见分组清单。
- **共性模式**（比单条更重要）：
  1. **同一纪律跨面执行不一致**——投影层剥本机路径、动作面不剥；`canWrite` 判读有意入账、`canTouch` 同款设计未注明；guard 自称「只读或幂等」却标了写动作。
  2. **「登记的 API ≠ 可用的 API」**——`review.appoint` 恒拒、`bus.deliver` 断头路、`store.rollback` 族只有测试调用、`recordDisagreement/declareMode` 零生产调用。INTERFACES.md 登记的接口面与真实可达面有系统性落差。
  3. **静默 vs 响亮失败的口径在边缘接缝破例**——岗位卡 parseDocument 错误丢弃、grant 条目字段缺失静默失效、minimap 锚点失效无声消失，均违反自家「没跑就硬失败」纪律。

---

## P1 清单（12 条，全部主会话核验属实）

### dsh-mind · 宿主侧

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| 1 | `src/review.js:457` + `src/tasks.js:1000-1006` | **零分歧判据数据源从未接线**：判据用 `c.结论层 ?? c.结论`，但 submit 全链路（工具 schema → actions.js → fold）从不采集/存储 `结论层`，恒退化为**结论全文逐字相等**——独立答案几乎不会逐字同 ⇒ §10「全票一致=异常」报警事实上永不触发；反之全员不交结论时恒误报 | submit 增加显式「结论层」字段进 fold；或改结构化结论签名 |
| 2 | `src/review.js:335` + `src/tasks.js:997-1006` | **零分歧结论集不过滤负责人**：fold 收任何交卷人（`row.by?.id`），Lead 垫一份带反例面的卷即可永久压掉报警 | 结论集过滤 `负责人` 名单 |
| 3 | `src/tasks.js:334-340, 396-401, 449-454` | **§3.4 提审分离三处判定全在锁外**（`node` 来自锁外 `#require`，锁内 guard 只验状态）：并发 submit+review 可让交卷人复核自己的卷——与已修的 P1-6 同族残留 | §3.4 判定移入锁内 eventBuilder/guard |
| 4 | `src/bus.js:232` + `lib/actions.js` | **「暂不投递」断头路**（已知未修，2026-10-12 报告 #7 已记）：`deliver()` 仅测试可达，动作/命令面无 `bus_deliver`；`暂不投递:true` 落账后永久滞留 | 补 `bus_deliver` 动作或撤参 |
| 5 | `components/kernel/lib/index.js:592` → `src/bus.js:221` | **bus_read 收件过滤恒空且无声**：normalizeArgs 把「收件」拆成数组，`row.收件?.includes(query.收件)` 拿数组去 includes ⇒ 恒 false，带收件的 bus_read 永远返回 `[]` | 入口拆单值或 readRaw 支持数组 |
| 6 | `components/guard/lib/index.js:124` | **guard 把写动作标为并发安全**：`probe_run`（落快照 + 两条审计）与 `upgrade_compare`（每次 append 审计）在 `isConcurrencySafe` 白名单里，注释自称「只读或幂等」不实 | 摘掉这两个 action |
| 7 | `src/probes.js:377` + `src/kernel/time.js:38` | **探针快照文件名精度只到秒**：机制版本不变时同秒两次巡检同名 ⇒ atomicWrite 静默覆盖 ⇒ 审计两行同名不同哈希 ⇒ 快照完整性校验见红 ⇒ autoRollback 拒绝定位——**回滚机制被自己的命名碰撞毒化** | 文件名加毫秒/序号 |
| 8 | `src/memory.js:356-385` | **跨项目晋升无幂等闸**：同 id 二次晋升（换岗位）追加重复副本行，mergeEntryRows 保留先读到的那份 ⇒ 第二次晋升静默无效，但审计照记「追加岗位标签 B」——**审计与账本脱节（假留痕）** | 晋升前查已有岗位，重复则拒 |
| 9 | `src/review.js:118-134` + `src/policy.js:570` | **`appoint()` 逻辑上必然失败**：用 `action:'approve'` 但 context 无 `proposerId`，触发宪章不变式恒拒；且无生产调用方（仅 INTERFACES.md:293 登记）——登记的 API 实际不可用 | 修 context 或删除该方法并抹掉登记 |

### dsh-mind · 看板客户端（components/board/lib/client.js）

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| 10 | L4360-4435 | **「人改过」防覆盖机制是死的**：`set人改过(true)` 全文 0 调用（仅 L4435 复位 false）。3 秒轮询回读会把用户正在填的设置表单静默冲掉——注释承诺的保护不存在 | 两个 onChange 各加 `set人改过(true)`（一行修） |
| 11 | L3315-3317 | **图谱滚轮 `preventDefault()` 无效**：React 17+ 将 wheel 注册为根节点 passive 监听，此处是 no-op——图上滚轮时**缩放与整页滚动同时发生**，注释宣称的行为与实际相反 | ref 回调里对 svg 原生节点 `addEventListener('wheel', fn, {passive:false})`，dispose 摘除 |

### DSHOME-Plugin

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| 12 | `lib/client.js:71,73` vs 头注释 L42-46 | **minimap 承重锚点违反自家纪律**：头注释声明「hash 类名 never used anywhere in this file」，但 `scrollBody:'[class*="_scrollBody"]'`、`officialRail:'body nav[class*="_frame"]'` 恰是 hash 类名片段选择器；上游改名 ⇒ findScroller 静默返回 null ⇒ minimap 整体无声消失（连日志都没有），违反自家「未接线要能说」标准 | 锚点失效时一次性 warn；长期改用语义属性或加存在性探针 |

---

## P2 清单（按插件归并，20 条）

### dsh-mind · 宿主侧

1. **`src/policy.js:461,565`** `authority` 缺省默认 `'自治'`（最松档），与文件自述 fail-closed 方向相反——现靠调用方都盖章撑着，是纪律级不是机制级。
2. **`src/registry.js:239-249`** 复核员任命授权引用只验非空不验存在——audit_correct 已落地存在性校验（P2-18），此处口径不一。
3. **`src/registry.js:143,434`** 岗位卡 parseDocument 的 errors 静默丢弃（规则件同情形响亮抛错，§3.6 口径不一）。
4. **`src/policy.js:1138-1151`** collectGrants 的 grant 条目只校验 verdict，subject/action 缺失或拼错静默失效。
5. **`src/review.js:190-269`** recordDisagreement / declareMode 服务层零授权闸——当前未接线不发作，接线即洞。
6. **`src/subject.js:78-79`** 第 2 档 fail-open 残留（exec 无子会话事实 ⇒ 恒 Lead）——设计债⑳已登记，复核确认仍在。
7. **`src/audit.js:242-272`** appendCorrection 授权引用只验「任务图里存在」：任何真实节点 id 都过闸，不验主权者来源（爆炸半径有限，但「存在≠授权」）。
8. **`src/tasks.js:544-553`** 升级去重竞态：`>=2` + 锁外查「已升过」，并发 reject 可落双 escalated。
9. **`src/tasks.js:788-822`** #append 先落任务事件、锁外再记审计：审计失败 ⇒ 状态已变链上缺条，调用方重试 = 洗卷窗口。
10. **`src/debate.js:269-281`** round 部分失败窗口：事件先落、边界消息后发，send 失败 ⇒ 轮次推进但预算切轮边界缺失。
11. **`src/debate.js:203-237`** say 预算闸 TOCTOU：读-判-写不原子，并发发言可超两道预算。
12. **`src/debate.js:127-141`** open 顺序：reveal（审计记「已揭名」）在 debateOpened 落线前，并发双 open 被拒时审计已记揭名。
13. **`src/tasks.js:178`** 单人节点默认 `模式:'独立会审'`：solo 节点对讨论段/解锁广播全部敞开，语义错配。
14. **`src/kernel/lib/index.js:505,516`** 审计轮桶 Map 泄漏：只读工具也建零计数桶，turn/end 里零计数桶 return 前不 delete，会话键永久残留（一行修）。
15. **`src/upgrade.js:114-135`** compare() 只读比对每次刷审计且主体记 system/factory 而非真实调用者，可灌水审计链。
16. **`src/kernel/fsx.js:61`** atomicWrite tmp 名 `tmp-${pid}-${ms}` 同毫秒同文件碰撞，失败 tmp 孤儿无清理。
17. **`src/capability.js:60,128`** capability_read/resolve 把本机绝对路径原样回模型面，与 workbench.js:148「剥 path」自家纪律相反。
18. **`src/paths.js:29-35`** assertPathSegment 未拒 Windows 保留名（CON/NUL/COM1-9）与尾部点/空格——NTFS 别名，项目键 `'foo.'` 与 `'foo'` 共目录。
19. **`src/memory.js:510`** 用户标签只写不可召回：索引只喂 [类,岗位]，标签字段只进不出。
20. **`src/store.js:177-243`** history/readVersion/rollback/pointers 全仓只有 test/ 调用——文件头宣称的三大设计行为之一「回滚」产品面未接线（probe_rollback 走另一套只定位）。要么接线要么删承诺。

### dsh-mind · 看板客户端

21. **L4131-4136** 审计「展开全部」钮计数错：折叠态 `audit.length` 已切成 20，按钮写「共 20 条待铺开」——投影 500 条也显示 20，违反自家「不静默截断」纪律（改 `审计总条数`，一行修）。
22. **L2283** 图谱画布高只按能力数算，岗位 > 能力时岗位节点纵向重叠。
23. **L3086-3091 + L3555** 3s 轮询无变更比对：每次全量发通知 + 全 7 页 reconcile + writeCache 大 JSON.stringify，投影变大后可感知卡顿。
24. **L1958 等** 数据键字典不用 null 原型（`__proto__` 作 id 会改原型），与自家 `安全合并` 口径不一致。

### DSHOME-Plugin

25. **L256-353, 2609-2611, 3291** HMR 重入无 teardown 三处：applyTheme 的 slots.register 句柄弃置、applyNotifySettings 注册句柄弃置——settings.section 是 list 槽，热重载叠加重复「提醒」分区（minimap/notify/conversation 都有全局 teardown，这三处漏了）。
26. **L1529-1533** 分数 DPR（125%/150% 缩放）下 `canvas.width !== w*dpr` 恒真（赋值截断为整数），每次重绘重建画布，流式期每 120ms 一次。
27. **L1214, 1378-1399** 超长会话画布高 zoom32×band×dpr2 ≈ 48640px，超 Chrome 32767 上限 ⇒ 缩略图整块空白。
28. **L462** `[data-disclosure-row]{background…!important}` 全局生效，越界改写宿主其它 disclosure-row 界面。
29. **L73 + L1132** officialRail 选择器过宽：任何含 `_frame` 的 nav 都被 opacity:0 隐藏。
30. **L515-530 + L570-583** 若上游变更使合成 click 失效，sweep 在流式 characterData 驱动下每帧 dispatch 点击穿透 React 根，无退避。

---

## P3 摘重（完整清单在各分组底稿）

- **死代码/死分支**：fold 的「物理删除」分支无生产者；DSHOME `shiftFor`（L1501）死代码；board L2545 两分支相同的死三元；actions.js schema 死参数「结论集」（review_zero 已不收）。
- **静默吞**：`src/bus.js:95` 收件 undefined 存 `[null]` 污染账本；`memory.js #rows` readJsonl 静默跳坏行使 purge 隔离闭包可能漏撕裂行。
- **注释漂移**：`bus.js:4-12` 头注释「四条必须保证」实列 5 条；board 页脚仍沿用已停用命令通道措辞；DSHOME locale en/zh 仅各 1 键且与 package.json 描述漂移（UI 文案硬编码中文，locale 形同虚设）。
- **幂等/竞态边角**：任务节点 id = 描述 16 字 + 毫秒末 5 位，同毫秒同描述必撞且无锁内查重；registry seal/restore 无状态守卫；audit 声明行自身断链时双计噪音。
- **仓库卫生**：`DSHOME-Plugin/dt.log`（11KB 二进制日志）残留仓库根目录（未被 git 跟踪，属本地残留物，应删）。
- **性能债**：探针快照无轮换 + autoRollback/工作台/registry_list 全量读账 O(历史)；review #轮派/#usedDissenters 每次全量扫账；serializeByKey._queue 只增不减。

---

## 亮点（值得保留的纪律）

- **XSS 面两个客户端都干净**：board 全文 0 处 innerHTML，DSHOME 全走 textContent。
- 策略引擎本体 fail-closed 贯彻彻底，未发现可直接利用的权限绕过洞。
- 记忆层缓存失效链（mtime+size+写计数签名）经逐条核对自洽，近期 cache 修复无复发。
- 审计链（链哈希 + 链外 anchor + 跨月声明表 + 撕裂行体检）是全部模块中最扎实的。
- 注释普遍写「为什么/哪次事故换来的」，可信度高——这也让少数「注释承诺了但代码没做」的断裂（人改过、wheel、minimap 锚点）格外刺眼。

## 修复优先级建议

**第一批（一行/小改，收益最大）**：
1. board `set人改过(true)` 补两处调用（P1-10）
2. 审计展开钮改 `审计总条数`（P2-21）
3. 轮桶 delete（P2-14）
4. minimap 锚点失效一次性 warn（P1-12 的止血半边）
5. 删 dt.log

**第二批（机制补全，需配测试）**：
6. 零分歧检查：结论层接入 submit/fold + 结论集过滤负责人（P1-1+2，一起修）
7. §3.4 提审分离移入锁内（P1-3）
8. bus_read 收件过滤口径对齐（P1-5）
9. guard isConcurrencySafe 摘写动作 + 快照名加毫秒（P1-6+7，同因共修）
10. 记忆晋升幂等闸（P1-8）

**第三批（接线决策，需主权者裁决）**：
11. bus_deliver 接线或撤参（P1-4，两次审查在案）
12. review.appoint 修或删（P1-9）
13. store.rollback 族接线或删承诺（P2-20）
14. board wheel 改 passive:false 原生监听（P1-11，需真机验证）
15. policy authority 缺省方向（P2-1，改严可能影响现有调用方，需评估）

---

## 修复追踪（2026-10-15 收口，主人指令「全修了」）

全部 P1/P2 与可安全修的 P3 已修完，按批提交、每批带测试与塞 bug 校准：

| 批次 | 范围 | 提交 | 测试证据 |
|---|---|---|---|
| A+B | dsh-mind 宿主侧 P1-1~9 + P2-1~20 + 顺修 P3 | `20f9f2b`（24 文件，+989/−127） | `test/fix-batch-2026-10-14.test.js` 20 条新测试；P2-1 / P1-8 / P1-3 三处塞 bug 校准通过 |
| C | 看板客户端 P1-10 / P1-11 / P2-21~24 + P3 | `abd4cd6`（2 文件，+137/−54） | harness ③ 表单覆盖对照臂 + ⑪i 滚轮 passive:false 原生监听断言（塞 bug 校准通过）；486 条断言全绿 |
| D | DSHOME 客户端 P1-12 / P2-25~30 / locale 漂移 / dt.log | `889e560`（DSHOME-Plugin 仓，5 文件，+296/−32） | selftest 67/67（新增 7 条钉）；domtest 96/96（rail 用例改写为几何闸 + teardown 还原 + 宽 nav 对照臂） |
| E | 文档对齐：INTERFACES.md（deliver/提交签名、checkZeroDivergence 重算口径、结论层贯通、§2.20 语义差）、README（动作清单补 bus_deliver/audit_correct/store_rollback）、locale | 随本批提交 | 终验：513 tests 全绿 + harness 486 + DSHOME 67+96 |

**明确不修（在案裁决）**：
- 债⑳（subject.js 档2 fail-open）：主权者裁决不修，宿主升级时必须复验身份链——`docs/design/取证-债⑳-2026-10-13.md`。
- board 页脚 `/mind dashboard` 字样：复核过——命令通道仍活（`test/host.test.js` ⑫ 钉着 `/mind dashboard` 路由），措辞保留。
- `normalizeArgs` 的「结论集」解析块：由拒参数改为响亮拒绝保留（`test/trace-floor.test.js` 钉）。

**基线**：dsh-mind 513 tests（preflight + node --test）；看板 harness 486 断言；DSHOME selftest 67 + domtest 96。

---

*分组底稿（每组的完整问题表 + 原文摘录）在本轮会话记录中，可追溯。审查人：Lead 主会话 + 6 并行审查子代理；核验方式：P0/P1 全部经主会话 read 原文确认。*
