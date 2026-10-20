# A加载级试装：离线执行交接

你已在明确A范围后答“继续”。本轮把它记录为[单次A授权](<C:/Users/kuro/.dsh/repos/_mind_review_channel_20261019/trial-a/AUTHORIZATION.json>)，不是B实验、长期委派或正式发布授权。

**现在尚未安装。** 当前GUI仍在运行，真实安装入口已按预期拒绝，配置/备份/锁均零写，见[真实在位拒绝证据](<C:/Users/kuro/.dsh/repos/_mind_review_channel_20261019/trial-a/evidence/live-refusal.json>)。不要直接结束承载本会话的进程。

## 你接下来只需做这几步

1. 先保存本页命令，停止同profile其它工作，**完全退出DeepSeek Harness（含托盘）**。不要只关闭浏览器页。命令执行完以前不要重新启动应用；进程检查不是阻止别人启动应用的OS互斥锁。
2. 打开一个独立的普通PowerShell终端，运行下面安装命令。**不要改PowerShell执行策略，不要加Bypass，不需要以管理员身份运行。** 它调用已有Node.exe，不运行任何.ps1文件。

```powershell
& 'C:\Users\kuro\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' 'C:\Users\kuro\.dsh\repos\_mind_review_channel_20261019\trial-a\trial-a.mjs' install
```

3. 只有返回 `ok:true`、`state:installed-on-disk-not-loaded` 才重开**原应用**，回到这个会话发 **“A已装，验收”**。这仅说明磁盘改好，不代表已经加载。不要运行实验，不要开长期授权。
4. 完成本轮加载验收后，再完全退出应用，用下面命令回滚，然后重开原应用，回来发 **“A已回滚，核验”**。单次维护窗口结束必须恢复，不把试装留成长期部署；本程序不安装后台守护或自动杀应用的定时任务。

```powershell
& 'C:\Users\kuro\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' 'C:\Users\kuro\.dsh\repos\_mind_review_channel_20261019\trial-a\trial-a.mjs' rollback
```

可随时只读看状态：把最后一个词换为 `status`。安装前的全基线只读核对可用 `check`，不要把 `check` 在已安装后报的patch差异当作安装失败。

## 固定写域和保护

- 只改[desktop用户patch](<C:/Users/kuro/.dsh/profiles/desktop/cordis.patch.yml>)：保留原字节前缀，附加本次唯一标记区块，禁用旧三id、插入三trial入口。
- 冻结候选代码SHA `46693109560950969b07c2677c13b06c9b52ab62c23f068259f17aa9a57107ca`，250文件/48运行资源；完整manifestHash `621db2d7fa1b53a53145c3e90db8f9218fdf5262702230c2b0b6f2c6babffbea`。
- 原factoryRoot/privateRoot不变；`reviewExperiments.enabled=false`。不写reviewed=true，不动delegation/免审/其它插件设置/package清单/依赖链接/原仓/旧候选。
- 写前重核全应用进程退出、三配置基线、Home层缺席、四链接、原仓与候选全部文件。锁占用/漂移/链接异常/重复试装即停，单次用完不能悄悄再装。
- 原配置的敏感原字节仅备份到本机受保护私有维护目录；先设置并读回用户/System/Admin专属DACL才写备份，不在输出/工作区证据保存正文。
- 当前账户的icacls /restore已在无敏夹具中返回1300；执行器**不再调用restore、不提权**。只在新临时文件的继承DACL与原件完全相同时原子替换，不同就拒绝。没有删除原文件再写入的降级路径。
- 原字节备份、活动指针、摘要链journal和临时文件用于故障取证。原子发布后记账失败不会谎称回滚；保存原备份和prepared状态供核对。
- rollback只认本次固定目标、摘要和受保护备份，配置中途被别人改过就停做三方核对。审计/任务/动态回执不时间回卷，不粘贴旧绿色回执。

## 失败时怎么处理

- `APP_STILL_RUNNING`：完全退出应用后才能执行。此首门发生在配置/备份/锁写入之前。
- `BASELINE_DRIFT` / `LINK_DRIFT` / `HOME_PATCH_APPEARED` / `CANDIDATE_DRIFT`：不要绕过或强制覆盖，保存错误码回到会话核对。
- `ACL_REPLACEMENT_MISMATCH`：不提升管理员权限追绿；原配置不发布，保留现场核对ACL。
- `LOCK_OCCUPIED` / `JOURNAL_DAMAGED` / `PUBLICATION_UNCONFIRMED` 或其它错误：不要盲重试、删锁、手改备份。保留本机维护记录并回来说明；状态本身不等进程死活或安全完成。
- 如果安装已产生本次临时配置，必须在应用退出后按记录恢复。不会因为回滚遇漂移就整文件盖回、抹掉别人的配置修改。

## 回来后我会核什么

以真实正式入口的新鲜身份/探针确认候选指纹与48资源、三组件唯一/原数据根、原工具闸与创建授权未扩大、三新动作schema出现但默认禁实验/零进程。历史探针、磁盘SHA、单纯HTTP200不算生效。复核员实例事实不足的格明确未验，不伪造身份或由Lead代跑。

独立复核票、真实Windows沙箱测试/IPC/取消清理等B内容仍未验，不由A覆盖。已有工程[冻结报告](<C:/Users/kuro/.dsh/repos/_mind_review_channel_20261019/batch2/REPORT.md>)继续有效，但不是活进程加载证明。

## 本轮验证

- 第二轮执行器回归 **27/27、零跳过**，含临时夹具安装/逐字节回滚、配置/源码/候选漂移、Home层、锁、ACL与写失败、启动竞态、备份/journal篡改、发布后记账失败和单次限制；真实Windows的自有无敏目录DACL保护与继承一致性也已测。
- 首轮24/25的原始失败及icacls 1300诊断保留，没有提权或忽略错误追绿。
- `check`已对真实固定基线通过；真实在位安装拒绝无生产改动。**实际安装、重启加载、完整活进程验收、实际回滚均尚未发生。**
