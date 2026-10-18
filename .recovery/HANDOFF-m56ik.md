# Mind v2 当前恢复交接（2026-10-18 17:35）

## 先读这份，再按需读旧continuation
- 唯一设计真源：docs/design/v2-口述收敛-2026-10-18.md（139行、24条已确认）。不重定设计，不立统一授权模型。
- 工作区C:\Users\wjthq\.dsh\plugins；产品dsh-mind；现有GUI http://127.0.0.1:5698。不要启动替代服务器或擅重启。
- 原工作树大量未提交改动，禁止git checkout/reset/stash/add/commit，保留全部。
- 用户最新要求：之后新建子代理和团队用6.1sol；已有实例曾是官方4.1f。不要再创建Flash/Luna替代。

## 两个实际阻塞与已证实的原因
### 1. 工具守卫半成品导致自锁
- I实例d53dbc91-2e52-433f-8fd6-826ceeed8414先在kernel的闸判定调用咨询参与工具闸，函数尚未定义就保存；HMR立即加载，所有工具抛ReferenceError。
- 此前该I还曾在instance-snapshot先引用读会审绑定再写定义，造成所有成员工具锁死。Root补定义恢复过，节点ht55m留证。
- 本次连Root工具也锁死。主权者已手动在components/kernel/lib/index.js第549行加入以下维护函数，Root已真实read确认：
  ```js
  function 咨询参与工具闸(exec) {
    if (agentSubject(exec)?.kind === 'Lead') return {命中:false};
    throw new Error('维护中：成员工具保持拒绝');
  }
  ```
- 当前是【Root修复通道可用、所有成员仍拒绝】的维护态，不是功能完成。不要把它当正式实现，不要改成全量return false放行。
- Root已成功mind member_stop I；不得再让同一写者直接修改live入口。新实现必须先在隔离副本一次补全与验证，再完整原子替换。

### 2. 当前会话旧模型白名单不会刷新
- 用户确实两次调整了设置，最后明确开放6.1；但当前会话list_subagent_models仍只广告openai-codex/gpt-6-luna，gpt-6.1-sol与gpt-6.1查询仍被Session拒绝。
- 已从当前官方app.asar提取源码证明，不是猜缓存：.recovery/route-official-dsh-tool-subagent.js。
- 258-292：subagentModelSelectionPolicy投影只接受第一条subagent/model-selection-policy事件，后续不改；record只写一次。
- 540-557：已有会话优先读其持久白名单；只有freshSession读取全局settings.current；子会话继承父名单。
- 所以需要【新建空白主会话】才接新设置，不是继续/Fork旧上下文。不要改旧会话事件或绕过允许列表，也不要猜不同模型替代。
- 新会话的Root可用维护通道；但成员仍会被维护函数拒绝。要先由Root在隔离副本修好正式工具守卫、原子上线，再新开Sol子实例。

## 已建立隔离副本（不在HMR监听目录）
- C:\Users\wjthq\AppData\Local\Temp\dsh-mind-m56ik-fd8dc94d
- 全产品树字节复制，排除了.git/.recovery/node_modules；package/src/lib/components/test/docs均在。
- 记录：.recovery/m56ik-isolated-stage.json。复制时主入口SHA256=530faa77edc7d411c31aa91d6723d346cceb6013feeafe11557d1669082edbcb，源/副本相同。
- 副本尚未做任何修复或验证，包含维护函数。不要声称已通过。
- 当前Root恢复节点：task-恢复咨询工具闸第二次实时接线故障-m56ik，已因主权者选择迁移标为待决（前态执行中），负责人session-d889c676-babd-479d-8dde-c4e2411112a2。未完成、不自动成功。新Root不能冒旧Root署名交卷；可先留真实接手经历/新恢复节点，再按正规状态处理，禁止改原账。
- 迁移前已通过mind.member_stop停止A/W5/67/J/K/E/F/I/17cc全部本轮实例（J/K/E/F/17cc最后停止于2026-10-18T09:42Z前后）。未伪造它们完成或自动封存未完成任务；正常采纳/结账/封存仍待新Root按真实票据处理。

## 此前完成的实现（不等于全部终验收）
- A：复核者普通成员岗、真实署名/冲突排除、显式复核对象、5读出口按任务裁剪，审计本人也先核项目，raw私有账本工具读取拒绝。
- 真实task_attach(读根=true)是Lead/主权者给复核任务授权路径的入口，成员自报产物不能自授读域；realpath/case/../junction校验。
- 复核send_message只准真实派发Lead；兼容两个【当前真实】工具变体agent_id与target，所有提供目标须同一Lead，拒双字段冲突/未知收件字段。不要退回target-only假夹具。
- W5：Root/Member所有新写须在册在岗+卡版本，Member另有真实委派父；无legacy永久写豁免；迁移补登只补缺位、保真实创建日期。父deny/confirm传播、私有一层重判、模型context不可关闭。
- runtime进程代锚globalThis稳定Symbol，同PID HMR不换进程代；Org装配标记另设，不参与孤儿判定。旧缺事实继续未判定，不猜补、不自动成功。新born真实携pid。
- J：card-credential.js是registry/policy/snapshot共同真实卡校验；重算原v版本+NUL+生效正文摘要、校派生段/refs与岗位类型；坏证据不覆写。canTouch在册坏卡不回落现行卡，只有无实例时显式预览；parseRefs从capability单源导出。新26例。
- K：review过只出rv-N票，不自动采纳；task_accept由Lead/主权者引用本任务当前有效过票，或合法免审/旧账显式确认。task_disagree追加异议不改票。已被合法采纳(node)是唯一谓词，旧Member过自动已采纳但未Root承接有需Lead确认，不能新依赖/结账/晋升；已结账不复活。14例。
- 真卡消费者：member_spawn只附自己cardOf已钉L0/L1完整段+能力引用；Root真实system-prompt/assemble前使用其已钉卡，当前卡变化不换脸。Root此会话实际收到已钉558a3...developer规程。
- E：task_settle真实知识晋升与映射node.记忆晋升；来源必须已被合法采纳；记忆整理必须真实角色+绑定执行中任务+同项目来源；复核员无知识特许；namespace通用与执行project分离；幂等键来源项目|任务|候选，业务参数变化拒冲突，失败不假结账。新8例；E已交卷812根+21board+503harness。
- F：intervention私有冻结请求+公开安全摘要，可信人侧内部生成sovereign主体；改设置/本人审批恢复失联但不批准其他请求，自动消息不续；原请求者按审批引用重放冻结参数；只有confirm门可消，硬拒照判。完整步骤计划在host副作用前预判，锁外/内重复检查不多耗一步，真第二副作用需第二步；父confirm同操作不重复卡，父deny/坏卡照拒。
- F已接actions/kernel/workbench/board设置UI（介入度/免审/完整审批预览/批准拒撤）。tasks.settlePlan是业务与审批共同唯一只读计划，不复制候选/处置。最后F报864（根+board合计）/503全绿，但这是I最后半成品写入前的基线，当前live维护态不绿。

## 剩下真正要做
1. 安全补完整咨询工具守卫，在隔离副本验证。保旧普通Member/复核规则；新咨询只自己会审问答/必要资料读、无写代码/子进程/派活/能力发布，未知绑定拒；只给派发Lead报告，不堵死故障上报。工具guard必须同步，真实exec.arguments，定义与调用一次落完整。
2. I域已做：council受管open三回调，锁外创建/发书/退役，失败只清本次owned并记aborted，收敛仅退役本场owned；registry咨询绑定来源取实际Root、不可改绑/解除、复核/Lead岗拒；snapshot归一绑定；域18+原39通过。
3. I还未完成共享入口/唯一宿主创建adapter抽取。不要复制member_spawn另入口；open/converge必须复用同实际适配器，必要接口未就绪先拒零副作用。盲评答案仅Council同一forViewer，bus不是答案出口。
4. I已暴露只读councilPlan({项目,动作:'debate_open'|'debate_converge',args})->{步骤}|null，待F在lib/approval-plan.js接两case（这条转发因工具崩未送达F）：
   - open：[create 会审 新:true]+N×[create 身份 新:true]，无写标签，预览问题/参与者/岗位/资料。
   - converge：仅已解锁/讨论中；[write 会审id]+每个在岗且绑定本场owned[seal 身份id]，无写标签，预览结论/实例/岗位。
   必须在host前批准整份N身份创建计划，不能只批会审后再卡N次。
5. 正式阶段源freeze后Root亲跑四门/四闭探针/实际接口，不拿旧绿或当前维护函数当完成。然后新建Sol独立终审任务（先定判据、显式复核对象、真实read roots）；旧17cc审计员已交阶段报告不能当常驻池复用。
6. 最终文档/执行规程/INTERFACES/设计映射诚实对齐；真实票采纳、候选处置、结账并停封临时实例。

## 实例/节点索引（供接手，不在本文件自授权）
- A a5296122-d03f-4c51-8990-b8ef1da7281c / task-审计补修A-复核读域-真实署名--bgu0d，停写已停止；旧过待新Root显式接受。
- W5 7f8ea0d5-c7bf-4f88-9f12-af061bc9a6cf / task-按条目8-9-10-12-20--o0gvc，停写已停止。
- J 44ed86ad-a3a8-451a-8b9c-90a8ce686457 / task-补修J-独立审计确认条目10两处-fg4ax，交卷冻结。
- K 18dbfe95-e930-4a7c-b870-161a94dd7895 / task-补修K-按已确认条目4与采纳权在-fjdxd，交卷冻结。
- E 7b7adfce-b95b-4c8a-8632-8bc63d8fdf98 / task-补修E-按口述15-16-22闭-do3pd，交卷冻结。
- F d31741ae-9213-4633-966e-3f5fd1583382 / task-补修F-按口述14-17-24闭-dqglr，交卷冻结等两计划case。
- I d53dbc91-2e52-433f-8fd6-826ceeed8414 / task-补修I-按口述18-19提供不占-dqmkm，未完成，已Root停止，源码半接不可声称完成。
- 17cc2d6b-49a8-462a-843b-dbd110fe333c / task-按-landing-audit--o0gyj，已交阶段报告15落实9未落实，报告完成≠软件绿；A/W5/cuoi曾过，后续缺口另修。
- Root ht55m：task-最小恢复-I在实时加载的同步身份-ht55m，已交卷待独立复核。
- Root cuoik：task-修复同步身份工具闸在热重载混合代-cuoik，旧Registry方法混代锁成员的独立恢复，已独立过。
- 原目标goal-6401f156-9421-416a-af29-24e178b3fe73，最新get_goal确认revision6、phase=paused、activation=disarmed、roundsStarted=2/max200，尚未完成。主权者已明确选择『迁移并暂停当前会话』；不要在旧会话自动续跑或误标完成。新空白主会话按其直接接续请求另建/接续真实目标。

## 勿再踩
- 源代码就是当前运行插件，保存会HMR；完整文件副本验证前不要再改live共同工具守卫。
- 缺函数是运行期ReferenceError，node --check不保证；必须真加载+执行角色反例。
- 不用PS5.1 Get-Content默认编码整文件重写，曾GBK毁中文；用read/edit/UTF8，字节拷贝备份。
- 不重启规避；重启不会补缺函数，且可能封存旧实例。旧源/新方法混代≠源码不存在，先核官方契约。
