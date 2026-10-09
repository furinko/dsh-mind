# 代码审查报告：dsh-mind + DSHOME-Plugin（2026-10-08）

> 性质：静态审查 + 主会话交叉核验。**不改任何代码、不改任何设计。**
> 方法：5 个子代理并行分模块审查（内核策略 / 记忆检索 / 任务协作 / 对外接口 / 前端看板），
> 主会话对全部 P0/P1 逐条 read 源码核验，两组合重复报告视为高置信。
> 基线：`preflight` 通过 · `node --test` **149/149 绿** · git 工作区干净（HEAD = `aa8dbd0`，已推送）。
> 口径：本报告只列**代码级新发现**；A1 只读面、A2 提交协议、A3 回滚集合、缺陷 4 血缘、A12 多路召回等在案设计问题不重复报告（见《现状核对》）。
> 依据文档：[组织设计.md](组织设计.md) v1.5 · [组织设计评审与记忆存储召回方案.md](组织设计评审与记忆存储召回方案.md) · [组织设计架构补充建议.md](组织设计架构补充建议.md) · [现状核对-两份评审稿与dsh-mind实现.md](现状核对-两份评审稿与dsh-mind实现.md) · 仓内 `DESIGN-MAP.md` / `INTERFACES.md`。

---

## 一、总评

读路径（policy 判定本体 / time / audit 投影 / workbench 投影 / presence 读数链）质量高，契约核对大部分吻合，
**本项目历史上高发的「字段/签名错位」在 src↔src 之间基本没有复发**——但在 **schema↔actions↔src 的三段接口面上复发了**（§三-D）。
降级合同（「最坏只能信息少，不能空白/抛错」）在前端被系统性执行。

**失守集中在写路径与身份链，且是系统性的，不是单点：**

1. **「写操作先过策略引擎」有多处旁路**——任务图 6 个写方法中 4 个不过闸、upgrade_withdraw、memory purge、bus.deliver。
   「复核者只读数」「成员任务内全权」「失联冻结」因此各有可走的路。
2. **身份与判定脱节**——`identityStatus` 没接进判定（封存实例照常全权）；身份变更后不 reload（判定读旧快照）；
   工具面主体恒为 Lead（成员 kind 构造不出来）；而 `role` 参数又是自报的。两端都说明 subject 不来自可信身份档案。
3. **主权者身份在所有入口都构造不出来**——upgrade_resolve 必然被拒、revoke/purge 的主权者路径全死，
   整个「挂起→裁决」升级流程结构性死锁，工作台还在引导人敲必失败的命令。
4. **若干机制「只记账不执行」**——升级 compare/resolve 不落盘、autoRollback 不改任何文件、`bus.deliver/unlock` 与反趋同 API 无动作入口。

---

## 二、P1 清单（主会话已逐条 read 核验）

### A. 写路径绕过策略引擎（设计硬规则 §9：写必过闸，无旁路）

| # | 位置 | 问题 | 核验 |
|---|---|---|---|
| A1 | `src/tasks.js:95-99,110-123,164-172,179-183,190-194,201-205` | `start/submit/reject/markPending/resolvePending/attach` 全部不过 `policy.check`（只有 create/dispatch/review 过）。**且状态机无守卫**：已采纳任务可 `task_start` 复活为执行中；待派发任务可直接 `task_review` 过=已采纳，跳过派发/执行/交卷（只有 dispatch 查了状态）。后果：复核者「只读数不改」、成员「任务外无」、失联冻结对这条链全部失效 | 已核，两组独立重复报告 |
| A2 | `src/upgrade.js:177-191` | `withdraw` 不过 `policy.check`：Lead 可任意撤回本该主权者裁决的挂起项；而 `resolve`（154-159）过闸且必拒——**「裁决」关死、「撤回」敞开，权限刚好颠倒** | 已核 |
| A3 | `src/memory.js:281-289` | `purge`（全库唯一物理删除）不过 `policy.check`，自建授权闸：`spec.理由.includes('敏感')`——**关键字闸**：理由写「这段**不敏感**」也命中放行；且 `原因` 缺省时 `undefined.includes` 抛裸 TypeError | 已核 |
| A4 | `src/bus.js:101-120` | `deliver` 不过 `policy.check`：谁都能放行被「暂不投递」压住的消息（send 过闸、deliver 不过） | 已核；当前动作面无入口（见 E2），定级受可达性影响 |
| A5 | `src/memory.js:336-351` | `archiveAnswers` 不过 `policy.check`，不按任务过滤（`spec.任务` 仅作文案，同项目别任务的开放作答被误归档），重复调用反复追加归档状态 | 已核；动作面无入口，同上 |

### B. 身份与判定脱节（§12.2：身份停用/删除时判定必须有确定答案）

| # | 位置 | 问题 | 核验 |
|---|---|---|---|
| B1 | `src/policy.js:319` + `src/policy.js:805` + `src/registry.js:97` | `#evaluate` 只查 `SUBJECT_KINDS` 封闭清单，**从不查身份档案 members 的 status**；写好的 `identityStatus`（「按最严处理」）只被 `canTouch` 读数用。封存实例照常全权；`#isDenied`（551-555）只比 `target.id` 不比 `subject.id` ⇒ 对实例身份的 revoke 对该主体零影响 | 已核 |
| B2 | `src/registry.js:139-263` 全域 + `src/org.js:118-130` | `assign/seal/restore/revoke/markInteraction` 写身份档案后**不触发 `policy.reload()`**，判定读的是 reload 时的旧快照。生产路径只有 bootstrap 与 presence 写入两处 reload。后果一：**失联「冻得住、解不开」**——「主权者任一次交互即解除」在进程内不成立（记账了但判定照冻结）；后果二：`sovereign_interaction` 工具面可达且不过 policy，模型可记账后借热重载/presence 写触发的 reload 自行解冻 | 已核 |
| B3 | `components/kernel/lib/index.js:496-500` + `lib/actions.js:94` + `src/org.js:210-216` | 工具面主体**恒为 Lead**：`agentSubject` 恒传 `根会话:true`，`runAction` 又以 `subject.kind==='Lead'` 回填 `根会话:true`，于是 `subjectFor` 里 `岗位='插件工程'` 也被 213 行的 `根会话===true` 判成 Lead——**成员 kind 在工具面构造不出来** ⇒ `scopeOf`（任务内全权）与 `sliceForViewer`（成员切片）在工具面全部失效。同时 `role='复核员'` 又可自报成复核者。两端合起来：subject 不是从可信身份档案来的 | 已核 |

### C. 主权者动作全部不可达（结构性死锁）

| # | 位置 | 问题 | 核验 |
|---|---|---|---|
| C1 | `src/org.js:210-216` + `src/upgrade.js:154-159` + `src/policy.js:426` + `src/workbench.js:245` | `subjectFor` 只产出 Lead/成员/复核者，mind 工具、`/mind`、`/mind-guard`、同源路由**没有任何入口能构造 `kind:'主权者'`**。于是：`upgrade_resolve` 被宪章不变式「publish 非主权者拒」**必然拒绝**（挂起队列只进不出）；`registry_revoke`、`purge` 的主权者路径、旧数据读授权同理全死。而工作台「待你决定」还在引导敲 `/mind-guard resolve id=… 选择=…`——**一条必失败的死命令**。⚠️ 修法是设计决策（主权者身份通道怎么开），**需主权者裁决**，不该单方面改 | 已核，两组独立重复报告 |

### D. schema↔actions↔src 接口面错位

| # | 位置 | 问题 | 核验 |
|---|---|---|---|
| D1 | `components/kernel/lib/index.js:154-204` | mind 工具 schema **缺 `结论`、`决定`**（连带缺 `复核者`、`待决类型`、`limit`）且 `additionalProperties:false`：`task_submit` 的「结论」永远传不进（节点上 `结论:null`），`task_resolve` 把 `决定:undefined` 写进事件流。**活体实证**：当前会话挂载的 mind 工具参数表就没有这两个字段 | 已核（含活体） |
| D2 | `lib/actions.js:143` vs `src/tasks.js:120` | `task_submit` 不转发 `反例面`：schema 有、normalizeArgs 解析了、submit 接收，唯独动作层漏传 ⇒ 交卷反例面永远 `[]` ⇒ §10 零分歧判据「无人给出反例面」**恒真**，零分歧报警名存实亡 | 已核，两组独立重复报告 |

### E. 数据一致性

| # | 位置 | 问题 | 核验 |
|---|---|---|---|
| E1 | `src/memory.js:466-473` + `162-171` + `120-141` | `fold` 对条目行 `entries.set` **后者覆盖前者**；query 按「跨项目→各项目」序推入 ⇒ 项目账原始副本（`岗位:null`）**覆盖**晋升副本 ⇒ `promoteCrossProject` 打的岗位标签在默认 memory_query 视图里**不可见**、`归属` 错报；仅带「项目」参数时碰巧正确。「岗位知识随身份带」的核心链条在默认读路径静默失真 | 已核 |
| E2 | `src/bus.js:87-94,101-120` + 动作表 | `deliver` 以同 id 追加新行实现只增，但 `read` **从不按 id 折叠**：投递后消息出现两行，`未投递=true` 查询仍返回原行，「暂不投递」状态机不生效。且 `deliver/unlock` 在动作表**无入口**——暂不投递的消息永远无法投递，§9 会审解锁广播永不发生（死接通） | 已核 |
| E3 | `src/audit.js:67-94` | 审计链 `append` 全程**无锁**（读尾→算 seq→appendLines→写 anchor）：并发追加（decide 拒绝入账与业务入账天然交织，mind/mind_guard 可被并行调用）产生同 seq 同 prev 的两行 ⇒ **链 fork**，`verify()` 把正常并发误判「链损坏」。`fsx.js` 头注释自称「读-改-写一律走 withLock」，审计恰好没走 | 已核 |
| E4 | `src/policy.js:151-153,167-172` vs `src/kernel/errors.js:61` | **故障期拒绝零留痕**：引擎不健康或判定抛错时 `decide` 直接 return Fault，不走 156-165 的 `audit.append`；而 `Fault.toDecision` 的 howToChange 承诺「故障期间的拒绝记录已入账，可申诉」——**承诺与实现直接矛盾**。最需要留痕的时刻恰好零留痕 | 已核 |
| E5 | `src/paths.js` 全域（taskLog/busThread/memoryDir/pendingFile/historyDir 等） | **路径穿越零防御**：`project`（mind 工具参数，actions.js:75 直接透传）、`线程`、`id`、`岗位` 全部原样 `join` 进路径。`project="../../x"` 即逃逸私有区，审计追加可落到任意位置 | 已核 |

### F. 机制「只记账不执行」

| # | 位置 | 问题 | 核验 |
|---|---|---|---|
| F1 | `src/upgrade.js:81-124,147-171` | 升级流水线**纯记账**：`compare` 的「直接替换 / 强制替换」与 `resolve` 的裁决都**不写任何规则文件**（连安全类强制替换也不落盘）。叠加 policy 加载「私有命中即生效」⇒ 有私有覆盖时出厂升级永远不生效，且无人在日志外能发现 | 已核 |
| F2 | `src/probes.js:133-163` | `autoRollback` 只 `audit.append` + 返回 `执行:true/目标版本`，**不改任何文件或运行态**——审计写着「版本x → 版本y」，机制纹丝不动；且快照只存版本标签，**没有可回滚的制品**，结构上就无法真回滚。⚠️ 回滚制品是什么是设计决策，需裁决；在此之前至少把口径改实（「已定位回滚目标，待执行」） | 已核 |
| F3 | `src/upgrade.js:196-209` | `#suspend` 对已裁决/已撤回的同 id 挂起项**直接覆盖重写** ⇒ 裁决历史丢失、同条款反复挂起、队列永不收敛 | 已核 |

### G. 前端

| # | 位置 | 问题 | 核验 |
|---|---|---|---|
| G1 | `DSHOME-Plugin/lib/client.js:609-624,3056-3084` | `applyConversation` 无拆卸、无重入守卫：document capture click 监听 + body MutationObserver 注册后永不移除。minimap/notify 都有 `__dshomePluginTeardown` 重入契约，唯独 conversation 没有。dev 态 HMR 每次保存叠一份 observer/sweep，确定性资源泄漏 | 已核 |

---

## 三、P2 清单（节选重点，全部已过主会话抽检）

| 位置 | 问题 |
|---|---|
| `src/kernel/fsx.js:165-195` | `withLock` 按 mtime>15s 强夺 + finally 无条件 `rm`：临界区超 15s 锁被夺后，原持有者会删掉新持有者的锁 ⇒ 三方同进临界区（潜伏结构缺陷，当前数据量不触发） |
| `src/audit.js:121-138` | `verify` 测不出**尾部截断**：删掉末尾 N 行后剩余链完全合法；anchor 存了更高 seq 可对照但 verify 不读它 |
| `src/store.js:62-135` | 文档写无对象级锁（只锁 historyIndex）：两并发写同对象算出同一 previous，留版互覆 |
| `src/policy.js:156-165` + `registry.js:112-121` | 读数面污染审计：`canTouch`/`policy_check` 的 deny/confirm 判定也逐条入账，一次 canTouch 最多写 14 条只增审计，还放大 E3 并发窗口 |
| `src/policy.js:762-777` | 坏 ```policy 块 JSON 解析失败静默 `continue`：整部法律的授权块被丢、引擎仍报 healthy、原先放行的动作突然全拒（§3.6 不许静默失败） |
| `src/tags.js:134-144` | CRLF front matter 静默失效：只认 `---\n`，Windows CRLF 文件 meta 整体静默为空，authority 退回兜底 |
| `src/tasks.js:164-172` | reject 打回计数在锁外读-改-写，并发下计数丢失，「打回≥2 升级」可能永不触发 |
| `src/tasks.js:68,23` | 依赖只存不检（无存在性/环/已采纳校验）；`TERMINAL` 含「已结账」但全 src 无事件产生它——环路最后一步「结账」未实现 |
| `src/review.js:210-246,285` | 反趋同 API（openBlind/reveal/pickDissenter/declareMode 等）动作面无入口，§10 流程在真实部署不存在；`readonlyCommand` 白名单含 `node --test`（可执行任意测试文件 ⇒ 写副作用），洞穿复核者只读边界 |
| `src/workbench.js:296-320` | 会审行**无条件**输出每份答案的 `成员+结论` 原文（`揭名` 只是提示字段）——文件注释自称「未交齐只给成员 A/B/C」，实现从不遮罩；叠加 B3（工具面读不出成员）当前无消费者，但投影本身违约 |
| `src/memory.js:419-428,371-382` | 晋升知识状态行只写跨项目账（`#folded` 先命中跨项目副本）⇒ 项目账副本永远「有效」；`stats` 按账 fold 与 query 合并 fold 读数分裂，且同 id 双计数 |
| `src/memory.js:254-267` | `overturn` 非原子（先 remember 后 appendState，后者被拒则新条目悬空）；remember 对知识强制 `岗位:null` ⇒ 推翻已晋升知识时替换条目丢岗位标签 |
| `src/memory.js:303-318` | `purge` 单边锁：持 `${file}.lock` 读-滤-重写，但 `appendLines` 不拿这把锁 ⇒ 并发追加落在重写窗口被 `atomicWrite` 整体覆盖丢失 |
| `src/memory.js:202-226` | 口径合并用 `visible.length` 覆盖 search 实算的 `文档数`，「候选文档数」虚报——正是 `formatMiss` 要消除的假读数 |
| `src/registry.js:139-166` | `assign` 无重复实例守卫：对已封存实例再 assign ⇒ 静默复活、重置代/登记于，绕过 restore 语义 |
| `src/memory.js:83,394-398` | 撞 id 防护只限单实例（`#nextStamp` 是内存态）：多 Org 实例同毫秒同主体写经历/偏好 ⇒ 同 id，fold 静默吞一条 |
| `src/retrieval.js:30,42,81-83` | BM25 口径不一致：`avgdl` 用「正文+标签」token 数、`dl` 只算正文 ⇒ 标签多的文档系统性高估；且内层循环反复 tokenize 同一篇 |
| `src/probes.js:41` | `declare()` 的 JSON.parse 无容错：声明文件坏 JSON ⇒ `run()` 整体抛异常，无快照无审计，见红留不下证据 |
| `src/upgrade.js:279` | 基线无、出厂无、私有有（用户自加条款）⇒ 误判「挂起」，用户新增条款被反复挂起 |
| `components/kernel/lib/routes.js:355-360` | webServer 20 次轮询拿不到时**静默放弃、零日志**——面板与设置页永久空白无痕，正是该文件注释自述要根治的场景（§3.6） |
| `dsh-mind/components/board/lib/client.js:310,2265-2278` | `probeBoardEnabled` 打 `/plugins/dsh-mind/components`，服务端从未注册该路由（端点表只许 presence/workbench/ping）⇒ 「看板关掉即自我撤下」是死功能 + 注释说谎（按 DESIGN-MAP 看板行关掉时 client 根本不进 roster，探针结构上多余）——删死代码或补路由 |
| `dsh-mind/package.json:21` | `exports["./client"]` 指向不存在的 `lib/client.js`（看板 client 独立成组件后的残留导出） |
| `update-plugins.mjs:149-150` | `git rev-list` 失败被静默吞成「已是最新」（取数错误与无更新不可区分） |
| `sovereign_interaction`（actions.js:282-284） | 工具面可达且不过 policy：失联判定的事实源可被模型自写（配合 B2 构成自行解冻旁路）——至少应过闸或移出工具面 |

## 四、P3（改进项，择要）

- `src/kernel/ids.js:5-6,42-54`：头注释「id 由 kind+主体+序号推导、可从目录名重建」与实现（随机哈希后缀）不符；objectId 注释「同一秒内不撞」与实现（毫秒输入，同毫秒同种子必撞）不符
- `src/kernel/time.js:126,151`：`now` 解析 NaN 时判在线（fail-open 方向），与 lastInteraction 侧的最严处理不对称
- `src/tags.js:61,106,228`：行内注释剥离切引号内 ` #`；数组 join 往返失真；assertStructure 段名 `includes` 子串匹配可被「判据冻结说明」冒充
- `src/store.js:209,265`：rollback 的 `target.authority` 硬编码 `'法律'`（留痕档位错）；`#decorate` 文件名与 meta.id 不一致时静默换 id
- `src/runtime.js:47-50`：shareKey `'/'` 拼接 vs `path.join`（Windows 反斜杠）⇒ 同一私有根两个 Org 实例 ⇒ 审计链双写者（放大 E3）
- `src/kernel/fsx.js:60`：`atomicWrite` tmp 名 pid+毫秒，同进程同毫秒同文件两写撞 tmp
- `src/audit.js:113-114`：跨月 read 以 seq（每月重置）为主键排序 ⇒ 跨月交错
- `components/kernel/lib/index.js`：`isConcurrencySafe` 白名单含 `probe_health` 死条目；`agentSubject` 恒等三元死代码；审计钩子主体记死 `{id:'lead'}` 且轮键两处取法不同（Map 缓慢泄漏）；闸白名单模式无条件放行 `mind*` 无注释
- `dsh-mind board client.js:1150,1887`：注释残留「通道是 remote.commands.execute」（Batch 7 已换同源 fetch）；`:1381-1384` useStore 兜底路径每次渲染重复订阅（仅在宿主 React 缺 useEffect 的假设性降级路径触发）；`:1486-1499` 轮询无序号，旧响应可覆盖新快照
- `DSHOME-Plugin client.js:16-23`：头注释「Six features」实际 5 个；`:2041-2045` minimap wheel 未处理 `deltaMode`
- `update-plugins.mjs:107-118`：hmr 检测不剥行内注释，误判方向恰好是危险侧（声称已热更实际要重启）
- `src/memory.js:483,103`：fold「物理删除」死分支；`'知识'===kind?'知识':kind` 恒等三元
- `src/registry.js:38-58`：`sync()` 写的 index.json 全仓无读者，「索引缺失自动重算」注释与实现不符
- `src/capability.js:50,95-105,131-141`：list 取 meta.id 而 read 按文件名找（手工卡 id≠文件名时 list 给得出 read 读不到）；promote 把 fold 产物整体 spread 落账靠 `追加:undefined` 被 stringify 丢弃兜底

---

## 五、修复批次建议（P0+P1 优先，按依赖排序）

**批次 1（小修大效，全是一两行）**
1. `lib/actions.js:143` 补传 `反例面: args.反例面`（D2）
2. schema 补 `结论`、`决定`、`复核者`、`待决类型`、`limit`（D1）
3. `decide` 故障路径补 audit 入账，或把 `errors.js:61` 口径改实（E4）——二选一，建议前者
4. `package.json` 删 `./client` 死导出；board 删 `probeBoardEnabled` 死代码（或在 routes 补 components 端点——需动「只许三个」纪律，建议删）

**批次 2（闸面补齐）**
5. tasks 六个写方法补 `policy.check` + 状态机合法转移表（A1）；`withdraw`/`purge`/`deliver`/`archiveAnswers` 补闸（A2-A5）
6. `purge` 入参校验（理由必填）+ 去掉关键字闸，授权交给策略引擎（A3）
7. `paths.js` 统一片段校验（拒 `..`/分隔符/绝对路径/盘符）（E5）

**批次 3（身份链）**
8. `identityStatus` 接入 `#evaluate`（非「在岗」一律拒）+ `#isDenied` 增比 `subject.id`（B1）
9. 身份变更动作后触发 `policy.reload()`；`markInteraction` 后 reload 或 presence 改读真源（B2）
10. 工具面 subject 从可信身份档案取，不再由 `role` 自报（B3）——与批次 4 的设计裁决相关

**批次 4（需主权者裁决的设计决策，先裁决再动）**
11. **主权者身份通道怎么开**（C1）：人侧命令面映射为「主权者」？单次授权凭据？不开则升级裁决/撤回/purge 主权者路径如实标注「当前不可达」并改掉工作台的死命令引导
12. **autoRollback 的回滚制品**（F2）：回滚什么、制品存哪；未定前把返回/审计口径改实
13. **升级落盘语义**（F1）：compare/resolve 该不该直接改私有区规则文件（涉及「出厂件只读模板/叠加层」的解释）

**批次 5（一致性）**
14. fold 同 id 条目行显式合并（E1）；审计 append 上锁（E3）；bus read 按 id 折叠（E2）；`#suspend` 已裁决另存历史（F3）
15. DSHOME conversation 补 teardown（G1）

**每批验证约定**：ad hoc 验证脚本 + 预期值独立 + 新断言首次塞 bug 校准 + `node --test` 金标准回归 + git 提交（照仓内既有纪律）。

---

## 六、审查过程留痕

| 项 | 读数 |
|---|---|
| 子代理 | 5 组并行（内核策略 / 记忆检索 / 任务协作 / 对外接口 / 前端），P0/P1 全部经主会话 read 核验 |
| 高置信信号 | A1/D2/C1 等 6 条被两组独立重复报告；D1 有活体实证（当前会话工具 schema 缺字段） |
| 子代理定级被主会话修正 | 3 条：board components 路由（P1→P2，探针结构上多余）、useStore 订阅泄漏（P1→P3，假设性降级路径）、withLock 竞态（P1→P2，需 >15s 临界区） |
| 测试基线 | 审查前后均 149/149 绿；本次审查**零代码改动** |

## 七、修复追踪

| 批次 | 状态 | 提交 | 验证 |
|---|---|---|---|
| 批次 1（接口面/留痕/死代码：反例面、schema 字段、故障入账、死导出/死探针） | ✅ 已修 | `c775e42` | preflight ✔；node --test **158/158**（149 基线 + 9 新例）；7 处新断言全部经塞 bug 校准 |
| 批次 2（闸面补齐 + 状态机 + purge 声明闸 + 路径校验） | ✅ 已修 | `c775e42` | 同上；既有流程测试补了 task_start 环节（设计环路：派发→执行→交卷） |
| 批次 3（身份链：identityStatus 入判定、变更后 reload、工具面身份可信化） | ✅ 已修 | `612fbd4`（与批次 5 同一笔） | B1/B2/B3 各有新断言；subjectFor 岗位优先于根会话标记；runAction 岗位身份必须档案登记且在岗；preflight ✔ · node --test **171/171**（158 基线 + 13 新例 identity-chain）；塞 bug 校准 10/10 全红（临时副本造坏，原仓零写入） |
| 批次 4（**需主权者裁决**：主权者身份通道 / 回滚制品 / 升级落盘语义） | ✅ **三项已裁决并落地**（2026-10-08 裁决 → `2cf178d` 落地） | `2cf178d` | preflight ✔ · node --test **175/175** ×3；批次 4 断言塞 bug 校准 5/6 红。裁决 1（主权者通道）：**不开身份通道**，改开**升级裁决通道**——Lead 可对**法律档规则件** publish（用于 upgrade_resolve / upgrade_withdraw 裁决遗留挂起项），自我约束＝仅在主权者授意时行使；宪章档与 delete 仍主权者专属（`src/policy.js:547-551, 605-609`）。裁决 2（回滚制品）：**git/包版本管理即可**——autoRollback 维持「定位全绿最近一版 + 入账 + 告警升级主权者」，不自建制品、不自动改文件。裁决 3（升级落盘语义）：**处置表由四态并为三态**——无冲突双生效；有冲突**私有优先（保留用户的）+ 审计告警**提示主权者，**不再挂起等裁决**；`upgrade_resolve/withdraw` 降级为处置**遗留**挂起项（`src/upgrade.js:7-19, 255-274`）。附带：E3 链 fork 追加修复（Windows `open(wx)` 抛 EPERM 按「锁被占」处理 + `serializeByKey` 进程内同 key 串行） |
| 批次 5（一致性：fold 合并、审计锁、bus 折叠、#suspend 历史、DSHOME teardown） | ✅ 已修 | `612fbd4`（与批次 3 同一笔） | E3 修复中发现并修掉第二个缺陷：锁内必须 fresh 重读链尾，信各自内存缓存照样 fork（两写者实测复现）；E1 附带发现 query 命中行不含岗位标签，断言改盯 `条目` 视图 |
| 批次 6（2026-10-09 · 回滚口径甲′落地 + 审计动作名分流） | ✅ 已修 | `0e70d24` | preflight ✔；node --test **180/180**；grep 门槛零残留（「无条件执行/待批次4/回滚制品未定义」仅剩 docs/design 历史参考件与 test 反例断言两处豁免面）；出厂面 10 处 + README/guard 6 处「待批次4」口径同步；全绿落账改记「探针巡检」（ACTION_GRADE 补表行），见红才「探针异常」，双向断言 + 旧口径反例断言 |
| 批次 7（契约 B+C：只读面收窄过判定 + 知识晋升披露机械检查） | ✅ 已修 | `13a3421` | preflight OK；node --test **196/196**（180 基线 + 16 新增 `test/contracts-bc.test.js`）。契约 B：`memory.query` / `bus.read` / `capability.resolve` 调用链加 subject 过 `policy.check`（动作 read，不新增策略动作）、缺主体按未知主体**最严拒**、放行记「只读服务调用」一条（记汇总，不随返回条数入账）。契约 C：`promoteCrossProject` 晋升前对 标题+内容+标签 过敏感模式（默认清单＝盘符绝对路径/UNC/环境变量/email/凭据词），命中即拒；`披露豁免` 仅 Lead。塞 bug 校准（先红后绿）：缺主体回填默认 Lead → fail 1；清空默认清单 → fail 4；档位改全记 → fail 2 |
| 批次 8（契约 A 完整血缘 + 契约 C 补强骑手 · W1-A 主人裁决方案②） | ✅ 已修 | `0588083` | preflight OK；node --test **206/206**（196 基线 + 10 新增 `test/contracts-a.test.js`）。契约 A：条目行加 `来源引用`（写入时存在性校验 fail-closed）+ `派生自`（推翻替换链）；`overturn` 自动写 `派生自` 并继承证据链；纯函数 `buildLineageIndex` / `lineageClosure`（≤3 层、环安全）；`memory_lineage` 只读动作；**`purge` 三步化**（待删除状态行 → 按血缘下游闭包逐条隔离 → 物理抹源 + 不可逆审计记「下游隔离」）。骑手①披露拦截入账；骑手②`披露敏感模式: []` 合法但必须留痕（告警档、状态迁移触发）。塞 bug 校准：短路存在性校验 → fail 1；purge 闭包清空 → fail 2；删空清单告警 → fail 1；lineage 主体回填 → fail 1 |
| 批次 9（W2 会审讨论段：协作环路的最后一块） | ✅ 已实现 | `6acf964` | preflight OK（内核模块 23 个）；node --test **222/222**（206 基线 + 16 新增 `test/debate.test.js`）；client-harness 305/305。三事件 `debate_opened/debate_round/debate_converged` fold 出节点 `讨论` 子状态；齐卷判据与 `bus_unlock` 同款**重算**（不信自报）；预算默认 `{轮次2·人数8·每轮24条·每人4000字}`、部署.json「会审讨论」键部分覆盖 + 加载期校验，**开启时冻结快照**；轮边界靠系统边界消息切轮（不靠时钟）。塞 bug 校准：字符闸短路 → fail 1；齐卷判据恒真 → fail 1；轮次上限闸拆 → fail 1 |
| 批次 10（W2 安全修复：伪造轮边界洗讨论预算） | ✅ 已修（**独立复核实证漏洞**） | `bbec0d1` | preflight OK；node --test **226/226**（222 基线 + 4 新增）；board 6/6。**攻击链**：任何已知主体经 `bus_send` 自报 `发件:system + 类型:系统 + 内容 [debate-round] n` 即可过闸落线——**根因＝策略闸只查「动作 + 对象」，而 `发件`/`类型` 是自报字段、未与主体绑定**；轮边界认定又只看「发件/类型/内容前缀」三件套 ⇒ 参与者能反复重置消息数与字符两道预算闸、并污染可收敛提示（复核已用预埋对抗题实证）。**两层修法**：A 写入面——`bus.send` 对 `类型='系统'` 且 `subject.kind !== '系统'` 一律 `Denied`（「系统」为机制保留字，动手前 grep 全仓确认零误伤）；B 动作面——`bus_send` **发件不许自报**（handler 恒以主体链真实 id 为发件人，`args.发件` 忽略），服务面 `发件` 参数保留给 unlock 广播 / 轮边界 / 末位表态等内部编排。**攻击场景已钉成回归用例**（自报三件套 → Denied、预算计数连续不被洗、真边界不受误伤；另一路自报 `发件=system` → 落线发件＝主体链真实 id）。塞 bug 校准：拆 A 闸（条件 `&& false`）→ fail 1（攻击用例必红） |
| 批次 11（W3 批1 并发一致性） | ✅ 已修 | `e37f9df` | preflight OK（内核模块 23 个）；node --test **232/232**（226 基线 + 6 新增 `test/concurrency-w3.test.js`）。五条同族病一次收口：`withLock` **验后删**（令牌还是自己的才 rm，已易主则留痕跳过）· `store.write` 对象级锁 · `tasks.reject` 打回计数入锁 · `runtime.shareKey` 路径归一（`/` 拼接 → `path.resolve`）· 记忆账本锁统一（唯一入口 `#appendLedger` + 锁内查重 `#appendEntry`）。塞 bug 校准 6 处逐条先红后绿（`finally` 无条件 rm / 锁路径随机 / builder 用锁外预读 / shareKey 字面拼接 / 裸 appendLines / 去掉锁内查重，各有实测读数） |
| 批次 12（W3 批2 口径与静默失效） | ✅ 已修 | `93109b1` | preflight OK；node --test **244/244**（232 基线 + 12 新增 `test/consistency-w3b.test.js`）。十一条同族病（错口径照常给读数 / 坏输入照常放行 / 被砍账尾照常自洽 / 未交齐照常投影真名）：审计自检读 anchor（新增「尾部截断/锚缺失」）· `audit.read` 排序键改 `(月, seq)` · BM25 同源 `dl` · CRLF 与引号内注释 · 坏探针声明兜底见红 · `assign` 两守卫 · `now` 侧最严（修 NaN fail-open）· ids 注释改实 · rollback authority 取被回滚版本 · 会审遮罩 · 记忆口径两数分开。塞 bug 校准 15 处读数；§11 口径变更回归：真实语料 5 个查询**排序全同**、对抗语料排序**翻转**（旧 B 0.870033 > A 0.737191；新 A 0.737191 > B 0.434775） |
| 批次 13（W3 批3 入口与边界 + 四骑手） | ✅ 已修 | `b30c704` | preflight OK；node --test **253/253**（244 基线 + 9 新增 `test/entry-bounds-w3c.test.js` + host 3 条）；client-harness 307/307。只读白名单去掉 `node --test`（跑测试＝写副作用）· `tasks.create` 依赖校验（不存在/成环，锁内判）· 新动作 `task_settle`（环路最后一步，「结账」档位全记；归档先于终态）· 坏 ```policy 块响亮 fail-closed · 看板轮询序号 · `tags` 转义引号 · 未交齐连「零分歧」一起遮。塞 bug 校准 18 处读数 |
| 批次 14（W3 批4 收口：front matter 写-读往返闭合 + 四条门禁） | ✅ 已修（**复核挖出的真缺陷**） | `26162cb` | preflight OK；node --test **259/259**（253 基线 + 6 新增 `test/roundtrip-w3d.test.js`）；client-harness 309/309。真缺陷：`formatFrontMatter` **写侧从不引号化**，而读侧会剥引号/切行内注释/切数组 ⇒ 自由文本里的 ` # `、行首 `#`、逗号、引号**写-读往返不闭合且静默**（`errors` 为空）；实证 `名='甲 # 乙'` 读回 `'甲'`、`摘要: # 标题式值` 读成空列表。修：`needsQuote/quoteValue` 按需引号化 + 读侧对称（`unquote` 只对带引号值解转义；`splitArrayItems` 逗号只在引号外算分隔符）；**普通值逐字节不变**（18 件出厂件 format+parse 字节一致，防"一律引号化"的过度修法）。四条门禁（依赖校验在锁内 / 归档被拒不许显示已结账 / 判定不许读遮罩行 / 设置页轮询序号）各带塞 bug 校准读数。口径改实：`readonlyCommand` 生产零调用点（两处 grep）→ 改标「待接线」并进设计债（见[设计债-2026-10-09.md](设计债-2026-10-09.md)） |
| 批次 15（W3 批5 收尾：零分歧判定基数 + 数组空串往返 + 已知边界登记） | ✅ 已修 | `a7f5501` | preflight OK；node --test **260/260**（259 基线 + 1 新增）；client-harness 309/309。①复核实测「②c 门禁不承重」（造坏「判定改用遮罩行」→ 全绿）：修法是补一个**不含任何人结论文本**的机械读数 `零分歧判定基数`（未交齐时投影）⇒ 造坏后基数 actual 0 / expected 2 必红；②数组空串元素往返折中（读侧只丢**不带引号**的空元素，`['']`/`['a','']`/`['','']` 往返逐字相等）；③`INTERFACES.md` 补 `readonlyCommand` 实测证据 + 新增 §2.19「已知边界」（`withLock` 残余 TOCTOU 分母 150+40 轮未命中 / `needsQuote` 触发集 / front matter 键顺序）。塞 bug 校准 3 处先红后绿 |

> 批次 1+2 的附带行为变化（如实记录）：① `task_submit` 之前必须先 `task_start`（环路次序恢复强制力）；② `memory_lifecycle op=purge` 现在要求 `原因` 必填 + `敏感: true` 显式声明（主权者除外）；③ `upgrade_withdraw` 与 `upgrade_resolve` 走**升级裁决通道**：**不开主权者身份通道**，改由 Lead 对**法律档规则件** publish（自我约束＝仅在主权者授意时行使；宪章档与 delete 仍主权者专属）——批次 4 裁决 1 已落地（`2cf178d`），所以**挂起队列不再"只进不出"**；④ mind 工具 schema 新增 6 个字段，运行中的会话要重载插件后才生效。

> **表尾补记（2026-10-09 文档卫生收口）**：W3 清欠期间的**独立复核**另有两条收获，落在批次 14/15：
> ① **真缺陷**：`formatFrontMatter` 写侧从不引号化 ⇒ 值含 ` # ` / 行首 `#` / 逗号 / 引号时**写-读往返静默不闭合**（errors 为空）——`26162cb` 修（写侧按需引号化 + 读侧对称），并补四条门禁（依赖校验在锁内 / 归档被拒不许显示已结账 / 判定不许读遮罩行 / 设置页轮询序号），每条都带塞 bug 校准读数。
> ② **判据承重性**：`a7f5501` 记「造坏『判定改用遮罩行』仍全绿 ⇒ 判据不承重」，补一个不含结论文本的机械读数 `零分歧判定基数`（未交齐时投影）后造坏必红（基数 0/2）。复核记的**判据不承重共 3 条**，仓内提交信息只留痕了 ②c 这一条（其余两条未点名）——下次收口时按仓内留痕口径引用，别把"3 条"当已取证事实。
> 另：本节实测读数一律以 `node --test` 为准（README 的数字口径与本表逐笔对齐；本波收口时 **260/260**）。
