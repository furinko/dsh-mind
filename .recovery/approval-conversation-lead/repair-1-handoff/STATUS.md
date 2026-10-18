# WIP 停工交接

**WIP，未经独立复核、未发布、不可当交付。**

按用户今晚暂停要求停工：不启动新的全池/变异，不 task_submit，不发布、不改真实审批或档位。任务 `task-z4jrl工程子任务-在全新HM-z9yzd` 已按正式打回重新 task_start，当前执行中、代2、打回次数1；rv-664=不过保持原样。明日必须从本状态继续，不能沿用旧候选绿灯。

## ① 已完成的补修及证据

### 隔离与冻结
- 本轮唯一写域为本目录 repair-1；[补修产品](<product/>) 从已交候选443f只读复制起步，没有覆盖旧产品、旧报告或旧verified。
- [建树脚本](<setup.mjs>) 开始时逐项校验旧候选288项后复制，输出 copied=true；保存了 [候选起点288项SHA](<candidate-base.json>) 和 [旧报告/终态证据16项SHA](<parent-evidence-base.json>)。
- [原始d9基线286项](<original-sha.json>) 亦保留；尚未做本轮终态全树复算。

### 批准后冻结记录重放绑定
- 真Org/真Intervention反例先于修复跑：原冻结正控通过，4项安全反例均错误放行 ok:true。原失败现场：[补修前日志](<target-1792341064774.log>)。
- 只改同一 [intervention域服务](<product/src/intervention.js>) 的唯一私有冻结读取链，预览/决定/重放共用：记录自摘要 → 请求账本摘要及归属 → 重算规范请求id → 重放时批准行摘要。不新增请求库、不改权限或认证。
- [新增重放测试](<product/test/approved-replay.test.js>) 修后5/5：[通过日志](<target-1792341075795.log>)。已覆盖：合法原单可占用且仅一次；批准后改入参并自重算摘要；仅改计划预览且重算步骤内容指纹/记录摘要；错误批准行摘要；账本/批准摘要一致但规范请求id错误。拒绝分支断言0占用。
- 可读拒因分别为“完整冻结记录与请求账本不符”“冻结记录的规范请求指纹不符”“冻结记录与已批准决议的内容摘要不符”；不能拿决定前保护代重放期保护。

### 慢轮询与根层入口
- 先在补修复制树跑慢响应反例，2例均失败：[修前慢读日志](<target-1792341189055.log>)，包括有效200无法显示、可读错误被丢弃。
- [客户端](<product/components/board/lib/client.js>) 已改为每会话single-flight GET，3秒poll复用在途请求，epoch隔离会话；POST后的强制回读先等旧读结束再发新GET，不拿批准前快照确认。
- 唯一审批UI注册从header.actions迁到官方 `shell.overlay`，旧header注册移除。根层只从真实 `useSessions` 快照中的 `retainedBy.mainView` / `retainedBy.sidebarChat` 引用取精确会话id，逐会话独立消费者；不扫描controller/gateway后台会话、不猜最后一条/前缀/父会话。无会话/根契约缺失有明确不可用状态。
- 官方来源已补到本目录 [公开源码证据](<official/>)：ui-layout 57–61/313/351（mainView及根overlay渲染）；ui-session 1098–1114（useSessions根标准源）；ui-subagent 755–807（sidebarChat真实retain来源及embedded会话）。原官方runner的shell.overlay root/list契约仍见 [上轮公开runner](<../official/dsh/node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/client.js#L5433-L5490>)。
- [会话消费者测试](<product/components/board/test/conversation-approval.test.js>) 已迁移到实际根组件与keyed子组件的 [最小组合渲染器](<product/components/board/test/approval-renderer.mjs>)，不是抽函数复刻。
- 已运行的12例通过：[客户端通过日志](<target-1792341294247.log>)。包含持续24秒受控时序（每次延迟4秒、3秒poll、至少4个有效响应、同会话最多1个GET）以及慢错误恢复；上轮10例的会话切换、正文完整、关闭不重弹、批准/拒绝/撤销、真路由/域服务闭环仍保留并通过。此为受控异步时序/组件执行，不是实际网络或DOM证据。

## ② 尚未完成或尚未运行

1. 刚追加的6项客户端目标**尚未运行**：hideChrome/blank有mainView；仅embedded/sidebarChat；主+嵌入多会话正文隔离且不扫后台；无session/目录pending；根useSessions缺席；POST遇已有旧GET仍须新回读确认。它们位于 [会话消费者测试](<product/components/board/test/conversation-approval.test.js>)，停工前只做了语法检查。
2. Root要求的重放反例还需各自独立补齐：单独改步骤指纹字段、改项目、改请求指纹字段、删记录，以及完整列明请求账本/规范id/批准摘要三处各自有效的变异证据。已有5例不代表这张矩阵全部完成。
3. 全原池/安装/preflight/官方契约/独立变异本轮**均未完整运行**；上轮929/31/509及11变异不能背书本轮改动。
4. [官方契约测试脚本](<official-contract.test.mjs>) 尚需适配新根overlay真实入口与根标准props；[变异脚本](<mutations.mjs>) 尚需更新旧header定位、冻结校验集中后的锚，并新增慢poll、根形态与重放期绑定变异。
5. 本轮最终完整性审计脚本尚未建立；[最终驱动](<final-check.mjs>) 是复制模板，引用的本轮integrity脚本未就绪，**不要直接当成可交付的一键门禁**。需要核旧product288项+旧证据16项、live/两旧工程树、新实际白名单及全部43运行资源身份，保留新旧SHA。
6. 真实slot内核、真实浏览器数据面/几何可见性/焦点、真人审批、实际发包/执行代次均未验；未部署、未刷新当前生产GUI。
7. Root告知的调度创建闸注册竞态不在本轮判据内，没有改guard或调度闸，不能写成已修。

## ③ 当前产品是否自洽、如何继续

- [补修产品](<product/>) 已收在可编译可继续的源码状态。停工前 `node --check` 实跑：客户端、intervention、会话测试、组合渲染器、重放测试，全部exit 0。
- 核心补修已有上述5/5和12/12目标证据；最后6项新增目标、全池兼容性及新官方契约/变异未验，因此“可继续”**不等于功能验收通过**。
- 没有后台测试或服务留待运行；没有原地变异，没有改旧候选或rv664。明日起先跑新增目标并补反例/驱动适配，再做完整原池和新副本变异，最后复算SHA、另写补修报告，按正式流程重新交卷供c407独立复核。

## ④ 交付禁用标识

**WIP，未经独立复核、未发布、不可当交付。**

今晚至此停止。不要采纳旧票，不覆盖旧候选与失败证据，不操作真实d836/0265，不修改主权者档位或认证边界。
