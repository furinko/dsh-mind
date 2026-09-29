---
name: import-artifact
description: 导入协议——其他设备/agent 蒸馏产物即插即用。触发：用户丢来文件/路径/内容/压缩包（"直接丢给你"）。
version: 1.0.0
author: DSHOME
license: internal
metadata:
  tags: [import, 导入, 即插即用, artifact, 蒸馏包]
  related: [mind/README.md, mind/L1/Memory.md, mind/L1/Tree.md]
contract:
  id: import-artifact
  triggers: [直接丢给你, 导入, 蒸馏包, artifact]
  inputs: [路径, 粘贴内容, 压缩包]
  outputs: [归类放置, 索引更新, 汇报]
  deps: [mind/README.md, mind/L1/Tree.md, mind/L1/Memory.md]
---

# import-artifact — 导入协议

## 一、使用流程

收到产物（路径 / 粘贴内容 / 压缩包）后按 ①→⑦ 执行，全部完成再汇报：

```
① 识别    这是什么？SKILL.md？蒸馏目录包？记忆导出？裸文档？压缩包？
② 校验    frontmatter 完整？版本？死链？内容含本机私密信息？（有则提示确认）
③ 归类    SKILL → mind\L2\Skill\；Exp → mind\L2\Exp\；通用记忆 → mind-private\L3\common\<主题>\
          ；项目记忆/结晶 → mind-private\L3\projects\<项目>\（档案根 or 知识\<主题>）；规则/模板 → mind\（需用户确认）；裸文档 → 给 2-3 个归类选项
④ 放置    默认写 mind-private\（隐私区）；用户明确说"公开/进仓库"才写 mind\
⑤ 建索引  更新对应主题 _index.md + mind\L1\Tree.md 清单 + 关联索引
⑥ 回滚点  导入前 git checkpoint（mind-private 独立 git）；冲突旧版进 TRASH 不覆盖
⑦ 汇报    装了什么、放哪了、冲突怎么处理、需不需要用户裁定
```

## 二、核心规则

- 🔴 **隐私默认**：产物一律落 `mind-private\`，只有用户明确说公开才进 `mind\`（出厂区）。
- 🔴 **同名私有优先**：`mind-private\` 与 `mind\` 同名文件，加载时私有区优先。
- 🔴 **不覆盖原则**：同名/同版本冲突 → 旧版进 TRASH（不删只移），新版入库，汇报里说明。
- 🔴 **裸文档不瞎猜**：无 frontmatter 的，读内容后给 2-3 个归类选项，用户一句话定。
- 🔴 **格式容忍**：有 frontmatter 走标准流程；没有的"尽力识别 + 问一句"，绝不拒绝也绝不瞎放。
- 🟡 **压缩包**：`.zip` / `.tgz` 先解压再走 ①→⑦。
- 🟡 **导入后验证**：读回校验 + 死链检查 + 可被 grep 命中。

## 三、行为准则

- 导入是"接住"，不是"吞掉"——汇报必须让用户知道装了什么、放哪了。
- 用户的设备/agent 产物是别人蒸馏的心血，保留作者与版本信息（frontmatter author/license 不抹掉）。
- 不确定就停：归类存疑时问用户，不硬塞。

## 四、踩坑记录

- frontmatter 缺失 → 不要拒收，读内容 + 补一张"面单"给用户确认。
- 压缩包不解压就识别 → 识别失败，先解压。
- 版本冲突直接覆盖 → 会丢历史，一律 TRASH 保底。
- 忘更新索引 → 产物进库但 Tree/_index 没同步，后续找不到；⑤ 是必做步。

## 五、关联索引

**L1：** `mind\L1\Memory.md`（归档规则）· `mind\L1\Tree.md`（索引）
**L2 Exp：** `mind\L2\Exp\`（工具手册）
**L3 common：** 通用结晶主题目录 `mind-private\L3\common\<主题>\` + `_index.md`；主题总览见 `mind\L1\Tree.md` L3 区
**L3 projects：** `mind-private\L3\projects\<项目>\`（项目记忆：project.md + 档案 + 知识\）

---
_版本：1.0.0 | 2026-09-02 | 初版（导入协议固化）_
