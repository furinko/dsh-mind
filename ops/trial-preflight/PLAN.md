# 一次性有限试装前核对与方案（尚未授权执行）

## 给你的结论

已核到当前GUI的managed profile为 **desktop**，路径为 `C:/Users/kuro/.dsh/profiles/desktop`；8377监听PID **29128**，与本轮正式mind状态里的组织引导PID一致。主包由profile清单的bundles加载，再从主包自身patch插入三个组件，不是旧三份alias依赖各自独立加载。

**下一步建议只批准A：加载级试装，实验保持关闭，不新建/唤醒成员、不改自主委派授权。** 本轮只读核对和方案已完成，没有改现役配置，也没有加载候选。

## 证据及还不能下的结论

- [脱敏核对记录](<C:/Users/kuro/.dsh/repos/_mind_review_channel_20261019/trial-preflight/evidence/capture.json>)：managed环境、OS监听PID、profile三文件SHA、安装链接真实目标、250文件候选逐SHA、磁盘身份。
- 当前主包引用为原仓，磁盘43资源指纹 `de758799dcfc345055e96a83f113d3dda9e622ae6c4e761cb44a3edc9a849b38`。正式status在本轮给出的最近探针仍是 **2026-10-19T08:04:19Z的历史快照**，不可当本轮新鲜内存身份确认；本轮没有执行写快照的正式probe。
- 本轮只读核到Home层patch不存在；监听进程及其父进程的原始命令行不保存，后续单独查到两者均无`--patch`标志。内存profileContext的全部overlays仍未直接读取，实际应用前须由官方配置入口核最终生效树。
- 已读取本机归档的官方源码，见[来源SHA清单](<C:/Users/kuro/.dsh/repos/_mind_review_channel_20261019/trial-preflight/evidence/loader-sources.json>)：profile组合顺序是bundles→profile patch→Home patch→启动overlays；[官方配置编辑器](<C:/Users/kuro/.dsh/repos/_mind_review_channel_20261019/trial-preflight/official/dsh__node_modules__@deepseek-ai__dsh-config-editor__lib__index.js#L117-L134>)会拒绝被后层覆盖的配置。
- **不能直接给旧id换name**：[官方patch算法](<C:/Users/kuro/.dsh/repos/_mind_review_channel_20261019/trial-preflight/official/dsh__node_modules__@deepseek-ai__dsh-app-boot__lib__index.js#L61-L109>)把name当匹配条件，名字不同会跳过。因此A使用禁用旧行+插入唯一trial新id，不能做假重命名。
- [四项只读原文方法验证](<C:/Users/kuro/.dsh/repos/_mind_review_channel_20261019/trial-preflight/evidence/plan-contracts.json>)已过：错name确实跳过；禁旧插新保留无关行；撤掉临时列表恢复原组合；路径型根入口可被官方浏览器模块发现器定位到候选主包。不是活进程加载证明。
- 官方插件管理器在没有HMR时只返回restart-required，不能把磁盘保存当运行生效，见[原文](<C:/Users/kuro/.dsh/repos/_mind_review_channel_20261019/trial-preflight/official/dsh__node_modules__@deepseek-ai__dsh-plugin-manager__lib__index.js#L2360-L2388>)。当前HMR服务是否可安全替换此常驻门禁尚未验，不承诺无缝热换。
- 系统有效PowerShell执行策略为Restricted。尝试运行[采集脚本](<C:/Users/kuro/.dsh/repos/_mind_review_channel_20261019/trial-preflight/capture.ps1>)被拒，正文未执行；未改策略、未用Bypass/IEX或其它入口执行该文件。后续[Node只读采集](<C:/Users/kuro/.dsh/repos/_mind_review_channel_20261019/trial-preflight/capture.mjs>)仅作文件/managed环境观察，没有执行被拒脚本。

## A：仅加载级试装——本次等待你明确批准的范围

### 固定目标

- 仅当前 **desktop** profile，现有GUI `http://127.0.0.1:8377`；不新开/替代server，不动原仓、四份旧候选或依赖安装/junction。
- 候选为[第二批冻结产品](<C:/Users/kuro/.dsh/repos/_mind_review_channel_20261019/batch2/product/dsh-mind>)，250文件、48运行资源；代码身份固定为：
  `dsh-mind@1.1.0+sha256:46693109560950969b07c2677c13b06c9b52ab62c23f068259f17aa9a57107ca`。
- 完整文件manifestHash固定为 `621db2d7fa1b53a53145c3e90db8f9218fdf5262702230c2b0b6f2c6babffbea`；原[冻结报告](<C:/Users/kuro/.dsh/repos/_mind_review_channel_20261019/batch2/REPORT.md>)中的真实Windows/独立复核未验边界不改变。

### 唯一配置改动

只在[desktop用户patch](<C:/Users/kuro/.dsh/profiles/desktop/cordis.patch.yml>)附加可识别的临时区块：禁用原 `dsh-mind-kernel/guard/board` 三id，插入 `dsh-mind-trial-kernel/guard/board` 三个新id，入口用冻结候选的显式file URI。具体数据在[待批准补丁提案](<C:/Users/kuro/.dsh/repos/_mind_review_channel_20261019/trial-preflight/PROPOSED-PATCH.json>)，它是未应用的资料，不是配置文件。

- kernel/guard显式保留原出厂数据根及原privateRoot，避免切成一套新组织；不迁移/回卷数据。
- `reviewExperiments.enabled=false`，不写`reviewed:true`、不配置可信可执行候选，不启动任何实验。
- 不改delegation/工具闭名单/免审/模型路由，不安装包，不改当前package清单和链接目标。
- 原patch含其它插件设置：备份只能在本机受保护位置保存原字节，不输出/上传正文；交付证据只留SHA。当前本轮尚未创建这个敏感备份。

### 执行前停止条件与维护窗口

1. 开新执行节点冻结上述写域，记录你对固定指纹A范围的授权。没有授权不写配置。
2. 重核profile三文件/原仓/候选SHA及最终生效树；如中途有其它人改配置、三id缺失/重复、后层覆盖或路径不符，立即停，不覆盖别人改动。
3. 常驻门禁替换存在卸旧/上新窗口。须先暂停同profile所有会话；无法确认全体停工时不能热切。**推荐你退出当前应用，在独立终端用随后经审读的受控Node安装/回滚程序离线改patch，再重开原应用**。本轮没有生成或执行有写配置能力的安装程序；不设置脱管后台任务，不代杀当前GUI进程。
4. 应用重启会中断当前会话执行，旧进程角色/许可可能需要重新核实；不能把冷恢复、inactive、在册当活体或自动复活旧授权。异常时只回滚代码/配置，不擅自重登成员或推进任务。
5. 单次维护窗口内执行A，验证完即回滚；若无法完成活进程确认，不留候选长期运行，也不自动重启反复追绿。

### A的活进程验收（不使用工程自测替代）

- 正式入口必须回显/新鲜探针确认候选指纹及48资源；历史快照、磁盘SHA、HTTP200不算生效。回执只能由实际注册过程生成，不手工写registered=true。
- 三个trial组件各一份正常装载，旧三项无重复工具/闸/路由；原组织数据根相同，status/看板/命令可读。
- 三新动作出现在实际工具schema；未启用实验时登记/运行硬拒且零进程；不伪造复核员身份做代跑正控。
- 委派创建授权仍explicit-user/false；复核员原生pwsh等仍被闭名单拒绝。无可验证实例则该格未验，不伪造已验。
- 记录正式四探针/注册回执及GUI刷新结果；启动自检可能增加审计/快照或重写动态回执，这些是应记录的自然运行事实，不是复制旧绿。

### 回滚

- 在维护窗口撤掉本次临时区块，恢复原patch原字节/前SHA，再通过原应用的正式重载或重启恢复原三id及原代码身份。若其它配置已变化，则做三方核对，不整文件盲覆盖。
- 数据/审计/任务/实际发生的探针和回执**不做时间回卷**；旧组件恢复后重新生成自己的回执并以新鲜正式入口核验，不粘贴旧绿色回执。
- 任一指纹、闸注册、重复组件、数据根或恢复步骤异常即停。保留日志；没有“试装成功所以自动长期启用/免审/发票”的后续动作。

## B：真正的实验/隔离烟测——不包含在A授权内

A仅证明加载，不证明Windows隔离。B必须另行授权、审读冻结烟测脚本/传递依赖和NodeSHA、确认正式复核成员的真实归属/任务/读根后才启用一次许可。没有可用持有人就停，不绕长期创建闸新起人，也不由Lead代跑。

建议B预算：单许可1次、有效10分钟、进程30秒、输出16KiB，仍是固定 `preflight` recipe。预审小包的该入口仅对本任务新建的自有对照夹具做以下检查：

| 验证 | 必须观察到的证据 |
|---|---|
| 正式包装与身份 | 真实confine返回partial及包装argv；进程服务实际收到的是包装argv；Node原件/副本SHA对应，不仅sandbox自报 |
| 写界限 | 副本内新标记可写；只对预先授权的自身外侧对照文件尝试写，预期拒绝且字节未变。若能写外夹具则验收红并停止，不触原业务文件 |
| IPC/固定测试池 | 真实Windows约束内Node测试池/子进程IPC可用；失败按实记录，不退回裸命令或扩权 |
| 超时/取消/后代收口 | 受控可终止子进程；独立观察done与waitForExit严格true；未知不得宣停净，不清现场、不返额度 |
| 输出/清理/卸载 | 真实超限截断标志、实收字节、清理成功或保留路径；插件卸载实际等待语义另测，不以发kill替代 |

partial不保证读/网络隔离，不用“能读外面”当隔离破坏，也不声称防恶意逃逸/全机零残留。真实enforcement、独立票和正式发布分别验，不借A或原运行态绿。

## 这轮范围

本轮仅采集/静态原文方法验证/计划，未加载候选、未触现役配置/回执、未创建或唤醒成员。独立复核票仍未取得。本计划提交后需要你明确回答是否批准 **A加载级试装及维护窗口**；B、长期启用、原审批候选合并与其它设计债不随“继续”自动授权。
