# 本机 Linux 开发与验收

2026-10-22 在 Linux 上建立的新环境，与历史 Windows desktop 部署分别记录。

| 用途 | 位置 |
|---|---|
| 开发仓库 | `/home/kuro/DSH插件开发` |
| 固定运行工作树 | `/home/kuro/.local/share/dsh-mind/runtime` |
| DSH profile | `/home/kuro/.dsh/profiles/web` |
| 客户端 | `http://127.0.0.1:3080/` |
| 本机脚本配置 | `~/.local/share/dsh-mind/local.env`，仓外保存 |
| 安装备份、检查日志、部署回执 | `~/.local/share/dsh-mind/audits/` |
| 私有数据 | `~/.dsh/mind-data/mind-private/` |

profile 使用 `link:` 指向运行工作树，`dsh.profile.bundles` 包含 `dsh-mind`。内核、安全类、看板共用一个包，不需构建或安装运行时依赖。此链接不会自动跟随开发目录的未提交修改。

## 每轮开发

```bash
cd /home/kuro/DSH插件开发
# 修改后可先检查；本机 shell 未配置 Node 时可直接使用 bash 命令。
bash scripts/local-dsh.sh check
# 提交本轮源码，再运行；部署会再次检查完整池。
git add <本轮文件>
git commit -m '<本轮变更>'
bash scripts/local-dsh.sh deploy
```

Node 在 PATH 时也可使用 `npm run dsh:check`、`npm run dsh:deploy`、`npm run dsh:status`、`npm run dsh:rollback`。

部署拒绝未提交的源码或脏运行工作树。通过检查后，先核对目标和失败回退提交均支持磁盘上的记忆与对象历史布局，再记录旧提交、停止本机 DSH 服务、切换运行工作树、核对 profile 安装并冷启动。停服后和启动前再次检查兼容性；启动失败仅在旧提交仍兼容当前数据时恢复，否则保持停机并报告原因，不自动还原数据。完整冷启动会中断正在运行的会话，应在本轮任务结束后执行。

`bash scripts/local-dsh.sh status` 核对磁盘提交与安装。`bash scripts/local-dsh.sh rollback` 恢复上一次运行提交并重启；每次旧提交也保存于 `refs/dsh-local/history/`。回退源码不回滚私有数据或第三方插件。

新提交通过 `scripts/storage-compatibility.json` 声明支持的数据布局；无声明的旧提交仅接受已核验的实现。记忆布局2、或新增的 `版本历史/.objects-v2/`，均不能交给只支持旧格式的代码。旧历史保留在原处不表示旧代码能读回新增历史。兼容检查只读元数据，不读取记忆正文或运行目标提交代码。

默认私有根仅从标准 `$DSH_HOME/profiles/<profile>` 和无根路径覆盖的装载配置推导；自定义数据根、动态配置或无法核对的目录会拒绝部署。在仓外 `local.env` 中设置已确认的绝对路径 `MIND_PRIVATE_ROOT` 可明确实际数据根，不能用一个空目录绕过检查。

## 客户端验收

部署后刷新原 DSH 浏览器页面；如要求本地登录，使用原启动器打开客户端，不传播日志里的认证令牌。

1. 插件页应出现一张「心智 · 数字组织」卡，包含内核、安全类、看板。
2. 侧栏「心智 · 数字组织」能打开总览、任务、审计和记忆；数据应来自当前宿主。
3. 设置中的「心智」分组能读取运行、审批与调度设置；保存行为按本轮具体改动另做验证。
4. 在空闲会话执行 `/mind-guard probe`，再看总览；四道探针应全绿。初次装配期间可能先记录调度闸回执尚未落盘的红色快照，不能仅凭旧快照判断当前注册状态。
5. 功能改动还需验收对应真实流程；源码测试、HTTP 就绪和看板加载不能证明成员交付与审批闭环已通过。

## 完全权限与插件安装

Linux人设目录保护通过系统bubblewrap作用于官方`subprocess.spawn/spawnTerminal`进程入口，不再将完全权限统一降为工作区可写。工作区外的profile可按用户权限修改，核心目录仍只读。系统需要可用且当前用户不可改写的`/usr/bin/bwrap`或`/bin/bwrap`；缺失时返回明确诊断。Windows/macOS尚沿原有保守保护策略。

DSH 0.2.1-rc.2默认禁用`tool-plugin-manager`。要让聊天使用正式安装工具，须由人侧在该profile启用这一宿主内置组件；它继续执行宿主的完全权限/逐次审批检查，改变工作区权限不会自动授予安装资格。本机此次修复同时启用该组件，不在Mind出厂补丁中为其他部署自动打开。插件源码和本机profile变更分别留存回执。

本机首轮全量测试的十项失败来自 Windows 路径、大小写不敏感文件系统及中文路径 URL 解码假设。当前测试夹具改用本机绝对路径及显式项目绑定、按实际文件身份核对大小写别名，并用 `fileURLToPath` 解码资源路径；业务代码没有随这些适配改变。

脚本使用本机已安装的 Node、Git 和 DSH。机器路径只写入仓外 `local.env`，迁移机器时重新配置；脚本不会推送 Git 或发布 npm 包。
