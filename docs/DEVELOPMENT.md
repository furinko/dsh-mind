# 开发、验证与发布边界

## 本地工作区

遵守父目录 `AGENTS.md`：日常开发在 `dsh-mind-dev`；桌面 profile 直接链接的 `dsh-mind` 是单独固定的运行工作区。两者共享 Git 数据库，不能把开发修改保存到运行目录，也不能用开发测试推断当前 GUI 已更新。

本轮开始前的全部未提交候选已逐文件保存于 `audits/mind-restructure-baseline-20261020-173655`，其中 `manifest.json` 记录 SHA-256，`tracked.patch` 保存已跟踪差异。早前 WIP、历史引用与 Git 清理恢复材料按父目录说明保留，不自动合并。

## 验证命令

项目无运行时 npm 依赖。使用 `package.json` 支持的 Node 版本，在仓库根目录执行：

```powershell
node test/preflight.mjs
node --test "test/*.test.js" "components/board/test/*.test.js"
node components/board/test/client-harness.mjs
node scripts/verify-profile-install.mjs --selftest
git diff --check
```

`npm test` 包含前三项。没有 npm 命令时可直接使用 Node，不能因此省略看板或安装检查。

先跑改动相关的正反例，源码稳定后统一运行完整池。测试应验证用户可见行为和实际边界；文案与可逆低影响编辑不另建照抄实现的测试。

preflight 检查出厂文档、岗位能力引用、包导出、三组件装配、浏览器经典脚本限制与模块可加载。安装 selftest 证明包形状检查器能发现反例，不证明真实 profile 已安装或当前运行代码已生效。

## 变更记录

每轮验收记录包含修改范围、实际命令与结果、源码是否冻结、日志位置，以及未验证的宿主与迁移边界。历史测试数只对应当时版本，README 不维护一份永久落后的测试总数。

领域服务拥有事实和业务规则；适配器转换参数、调用服务、返回结果。新增命令如有副作用，执行、预览及审批计划必须覆盖同一实际步骤。反馈、指标和缓存不能成为新的授权源。

## 部署

开发、提交、推送、发布与运行部署是分开的操作。本轮重整只修改开发候选。运行部署前需核对成员文件范围、历史项目绑定、原有私有叠加与岗位钉版，以及实际宿主接口；新出厂卡不会自动重写已有实例的权限。

部署后的真实工具、审批界面、项目归属、guard 回执和采集健康需要在目标环境验证。无法确认的运行状态保持未知；不要把 Git HEAD、安装退出码或文件时间当作 HMR 已成功的证据。
