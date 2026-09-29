---
name: prompt-surface-audit
description: 注入面体检——出厂提示词/系统提示词「每会话都带着」的那一面，怎么量、怎么核、怎么改：先钉真身（谁注入·注入什么·几次），再量化各段字符（**真跑装配器**，不读文档），再逐条核机制承诺是否接线，判据是"每行值不值得每个会话看到"，改高危区走快照+validate+版本门禁，验收要真跑+基线人工比对。触发：注入面 / 提示词优化 / 出厂提示词 / 系统提示词 / 每会话注入 / token 账本 / 瘦身 / 减注入 / R0 R1 / 上下文预算 / 宪法改动 / 重复冗余。
version: 1.0.4
author: DSHOME
license: internal
metadata:
  tags: [注入面, 提示词, token账本, 引用真实性, 每行值得, 高危改动, 真跑验收, 无界增长]
  related: [mind/L0/SOUL.md, mind/L0/AGENTS.md, mind/L1/HUB.md, mind/L1/Ritual.md, mind/L1/changelog-L0.md, packages/dshome/lib/host/mind-inject.js, scripts/mind-prime.mjs, scripts/mind-prime-rules-itest.mjs, scripts/verify-l1-versions.mjs, scripts/search-regression.mjs]
contract:
  id: prompt-surface-audit
  triggers: [注入面, 提示词优化, 出厂提示词, 系统提示词, 每会话注入, token 账本, 瘦身, 减注入, 上下文预算, 宪法改动]
  inputs: [一个"每次会话都注入"的面（R0 宪法 / R1 召回 / 系统提示词 / 目录级 AGENTS.md）]
  outputs: [注入面真身（注入器 + 文件 + 频次 + 活进程 marker 读数）+ 分节字符账 + 引用真实性逐条核验表 + 该改清单（每行值不值得）+ 改前改后读数与验收证据]
  deps: [packages/dshome/lib/host/mind-inject.js, scripts/mind-prime.mjs, scripts/mind-validate.mjs, scripts/evolve-log.mjs]
---

# prompt-surface-audit — 注入面体检（每会话都带着的那一面）

> 心法一句话：**注入面的每一行都在收"每会话租金"——问的不是"这句话对不对"，是"它值不值得每个会话都看到"。**
> 权威定义**不在这张卡**：加载策略真源是 `mind/L1/HUB.md §三`（注入层 R0 / 上工装配层 R1 / 按需层）；
> 高危改动流程真源是 `mind/L1/Ritual.md §四`。本卡只写"**怎么量、怎么核、怎么验收**"（不做第二份真相）。
> 来源：2026-09-24「出厂提示词注入面体检」实做蒸馏（批次 `l0-polish`，提交 `4632145`）。

## 一、使用流程（Step 1→N）

1. **先钉真身：谁在注入、注入什么、几次**。读**注入器源码**，不读文档：R0 = `packages/dshome/lib/host/mind-inject.js`
   的 `composeMindL0Text`（读双件**全文**、各 `.trim()`、`'\n\n'` 拼接、每会话首步一次）；R1 = `scripts/mind-prime.mjs`。
   顺手取**活进程物证**：`profiles/dshome/.dsh-market/mind-inject-marker.txt` 的 `inject: len=… ver=…`。
   ⚠️ **顺序也是契约**（SOUL 先于 AGENTS 由 `verify-host-plugins.mjs` 的顺序断言锁住）。
2. **量化各段字符——真跑装配器，别读文档、别手算**。
   - R0：`composeMindL0Text(root).length`（与 marker 的 `len` 同口径）。
   - R1：`node scripts/mind-prime.mjs --cwd <真实工作区>`——**必须带 `--cwd`**：不带则 projectKey 解析为空 ⇒
     进度/待办恒 0，账本会小一半（本人踩过）。`--json` 给结构化，可直接量各段长度。
   - 账要**分节**：头部 / 每节 / 尾行都要有数，才知道该动谁。
3. **逐条核"机制承诺"的引用真实性**：脚本名与**子命令**、HTTP 接口（**方法与参数位置**：query vs POST body）、
   文件路径、函数名、**交叉章节号**（`§x` / `#N`）。每条给"存在 / 不存在 / 名字不符 + 证据（文件:行）"。
   本仓历史证明这一类最会失真：`paths.allow` 解析了却没接线；`AGENTS §四` 写"分档细则见 `Ritual §四`"而该节根本没有；
   `dup-check` 被写成 query 形态（真身是 POST body）。**独立核验员（另一进程只读复核）能抓出作者自己的盲区**。
4. **判据：每行值不值得每个会话看到**。不值得的三类：① **变更说明/版本沿革**（属 changelog）② **与别处重复的指针**
   ③ **细则**（该待在自己的家，按需 read）。第 ③ 类的判别法：搜这一节标题自述的定位（如 `Ritual §四` 自称
   "AGENTS 常驻只留核心，这些按需读" ⇒ 它才是细则的家）。
5. **改高危区**（`L0` 双件 / `L1` 八件 / 人设卡）：`evolve-log batch <批次> <files...>` 写前记账 → 改 →
   `node scripts/mind-validate.mjs --strict --defer-content-drift`（warn 也拒）→ `git add` 后
   `node scripts/verify-l1-versions.mjs`（**改 L1 正文必须提版本**，头/尾版本行都要动）→ commit 过 pre-commit 全链。
6. **验收四件（缺一不算完）**：
   ① **真跑装配器**算改后长度（不是估算）；
   ② `node scripts/search-regression.mjs --layer=factory` 读数，**并人工读 `scripts/regression-baseline.factory.json`
   逐项比对**——门禁在"语料增量"分支会**跳过精确比对**，exit 0 ≠ 没退化；
   ③ **活进程证据**：注入源"每会话读盘 ⇒ 下次会话即生效" ⇒ 新会话的 marker 行（`len`/`ver` 是否换成新值）；
   ④ **payload 快照同步**（hash 比对；`verify-payload` **不带** `--defer-content-drift` 才是硬判）。
7. **别忘了子代理侧**：同一套注入器对不同 `delegationDepth` 的行为**可能不同**，而"成员到底拿到什么"必须**逐项实测**（2026-09-24 实测基线）：成员**带** R0 全文（SOUL+AGENTS）+ 角色卡正文 + 固定尾注 + **skill 命中指路提示**；**不带** R1 正文（project / L3 / Learn / user-rules / 人设卡正文皆无）、**不带**管控者协议与《管理层宪章》（`agent-roles.js:1552` 只装 `delegationDepth ?? 0 === 0`）。改过注入器之后**两侧都要再读一次**。
8. **子代理显示名当场验**：子代理列表显示的是 **`label`**（不是 `title`）——官方 `subagent` 拿工具参数 `description` 当 label（天然可中文），自家 `role_spawn` 的 label **新格式＝`<卡中文名>:<成员名>`**（如 `沉淀员:命名验证`）、**旧格式 `role:<卡id>:<名>` 仍被兼容解析**（跨进程恢复补闸靠它认人）；起一个成员看返回值里的 `label` 就能判定标题长什么样（见 §四 对应踩坑）。

## 二、核心规则（硬约束）

- **规则口径不得比机制宽**（本仓已定方向）：文档写"每次上工必须加载 X"而没有任何装配代码读 X ⇒ 那是**空头义务**，
  改文本对齐机制，**不是**扩机制。
- **单一权威**：细则进 L1 已有的家，L0 只留摘要 + 指针；**指针必须指得到**（改完当场 grep 目标章节确认存在）。
  改一个"悬空指针"最省事的办法不是删指针，是**把内容补到指针指向的家**。
- **红线一条不删**：瘦身只压缩表述与去重；判据 / 名单 / 例外 / 反例全保留。改前先列"逐条映射"，改后抽查落点。
- **节号是契约**：全仓大量 `AGENTS §x` 引用 ⇒ **不重排节号**，只动内容密度（重排要全仓修引用，成本远大于收益）。
- **版本行是机器契约**：`_版本：x.y` 形态被注入 marker（`ver=`）与 `verify-l1-versions` 同时消费；改格式会**静默**打断它们。
- **换行风格要保**：`write` 会把 CRLF 归一成 LF，`edit` 会跟随原风格 ⇒ 写完量一次 CRLF/LF 计数，别让 diff 变成整文件重写。
- **被进程加载 vs 每会话读盘**：前者改完要重启 + 在活进程上真触发；后者（L0 双件就是这个）下次会话即生效，验收落在新会话 marker 上。

## 三、行为准则（软技能）

- **先量后动、先出体检表再谈改哪**：不量就砍＝拍脑袋（本人 2026-09-24 先出 3 张表才动刀）。
- **估算要经得起事后对照**：方案里报 −23%、实测 −9.2%（因为同时**新增**了两处坑的说明）⇒ **差额如实认账**，
  只报"省了多少"是选择性汇报。
- **优先找"无界项"**：只增不减、没有上限的段（本次：`userRules` 全量直出、人设卡全文不截断）——今天不痛，是**随时间的隐性地雷**。
- **不替用户裁他的活数据**：进度 / 待办 / 教训 / 偏好是**产品决策**（登记待办、问一句取向）；
  文档结构 / 文案 / 接线是**工程决策**（能处理就处理掉、给证据）。
- **改"每会话都跑"的装配器**：纯函数拆库（`mind-prime-lib.mjs` 先例）+ 配可执行反例表（`*-itest.mjs`），
  别让"看起来显然"的排序 / 裁切写成恒绿。
- **注入面体检的产物是账本不是感觉**：交付"真身 + 分节字符 + 逐条核验表 + 验收读数"，让下次能动得下去。

## 四、踩坑记录（每条 ≤100 字）

- **文档比机制旧**：`HUB §三` 写"Learn 末尾 4 条"，而 `mind-prime.mjs` 早已是"末尾 3 条 + 按任务检索 2 条"。
- **悬空指针**：`AGENTS §四` 写"分档细则见 `Ritual §四`"，grep 全文件该节并没有分档内容——表只住在 AGENTS 自己。
- **接口形态失真**：`/api/mind/dup-check` 被写成 query 形态（`project=<key>`），真身是 **POST + JSON body**（`index.cjs:1150/1158`）。
- **门禁与文件不匹配**：`changelog-L0.md` 住在 `mind/L1/` 却没有版本行 ⇒ `verify-l1-versions` 判"内容变+版本行没变＝红"，下次改必被拦。
- **`mind-validate` 的尾部版本取窗口内第一个匹配**：沿革台账里照抄的历史 `_版本：x.y` 行会冒充"尾版本"⇒ 该文件只能尾部带版本行、头部不设。
- **账本口径错**：量 R1 忘带 `--cwd` ⇒ projectKey 空 ⇒ 进度/待办恒 0，账本小一半（差点当成"这项目没待办"）。
- **回归门禁的"绿"可能是跳过**：语料增量分支不比对分数 ⇒ 要人工读 baseline 逐项比（本次 15/15·11/11 才敢说无退化）。
- **别信注释里的"实测"**：`agent-roles.js:120-121` 写着"成员不带 R0/R1 注入"，而独立审查逐帧解压实测**本轮成员带完整 R0** ⇒ 注释/文档是**二手证据**，机制代码与活进程读数才是一手（我一度照那条过时注释，把**本来对的**推断改错了——纠正自己也得看证据等级）。
- **子代理列表显示的是 `label`，不是 `title`**：官方 `subagent` 用工具参数 `description` 当 label；自家 `role_spawn` 默认名曾取卡 id 折算的英文 ⇒ 标题是 `role:reviewer:xxx`。修法＝默认名改取卡的中文 `name`（`defaultMemberName()`）。⚠️ label **是机器契约**（`parseRoleLabel` 解析、跨进程靠它＋归属表认人补闸），**但格式可以演进**——2026-09-24 已改为 `<卡中文名>:<成员名>`（旧格式仍兼容解析），代价三条：① 新旧**双格式都必须能解析**；② 新格式必须能**唯一确定是哪张卡**（左段唯一命中已知卡名，重名即不认）；③ 需 append-only 归属表（`agent-roles-members.jsonl`）作第二来源兜底。取证入口＝`packages/dshome/lib/host/agent-roles.js` 的 `parseRoleLabel` / `recognizeMember`。

## 五、关联索引

**L0/L1（权威源）：** `mind/L0/SOUL.md` + `mind/L0/AGENTS.md`（R0 双件本体）· `mind/L1/HUB.md §三`（加载策略真源）· `mind/L1/Ritual.md §四`（高危改动：分档判据 + 事务四段式）· `mind/L1/changelog-L0.md`（L0 沿革归档）
**L2 Skill：** `verify-integrity.md`（真加载 / 反例证伪 / 无输入即失败）· `factory-hygiene.md`（推送面卫生）· `landing-audit.md`（书面红线 vs 真门禁接线）
**工具：** `packages/dshome/lib/host/mind-inject.js`（R0 注入器 + marker）· `scripts/mind-prime.mjs` + `scripts/mind-prime-lib.mjs`（R1 装配器 / 纯函数库）· `scripts/mind-prime-rules-itest.mjs`（user-rules 排序与上限的反例表）· `scripts/mind-validate.mjs`（(c) payload 同步 / (d) 注入源检查）· `scripts/verify-l1-versions.mjs` · `scripts/search-regression.mjs`

---

_版本：1.0.4 | 2026-09-29 | **订正（前版沿革的「全库不存在、从未建过」为假）**：被指对象是**本机私有区 `L2/Skill` 的一张能力卡**（元进化体检法 1.1.0），**在盘、且在私有登记面在册**（mtime 09-18，**早于**该结论书写日期）；当时的「0 命中」是**搜索面盲区**——`.gitignore` 使从仓库根、尊重 `.gitignore` 的搜索看不见私有区。出厂面按**双区纪律**仍**不写其条目名、不引用其路径**（故此处不回填引用），仅订正事实表述。 | _版本：1.0.3 | 2026-09-25 | **清幽灵关联索引**：删 `evolution-checkup.md`（机制体检位；**全库含 TRASH 0 命中**——同批 `recall-tuning` / `concurrent-writers` 已清、本卡漏清）| 1.0.2 | 2026-09-24 | 订正 `label` 口径（推翻本卡旧结论「label 只能改段内容、不能改格式」）：新格式＝`<卡中文名>:<成员名>`（实测 `沉淀员:命名验证`）、旧格式 `role:<卡id>:<名>` 仍被兼容解析（跨进程恢复补闸靠它认人）；格式可演进的代价三条——① 新旧双格式都必须能解析 ② 新格式必须能唯一确定是哪张卡（左段唯一命中已知卡名，重名即不认）③ 需 append-only 归属表 `agent-roles-members.jsonl` 作第二来源兜底；取证入口＝`packages/dshome/lib/host/agent-roles.js` 的 `parseRoleLabel` / `recognizeMember` | 1.0.1 | 2026-09-24 | 新建——判据三条全过（跨项目可复用 / 有验证过的事实 / 以后还会遇到）：由当日「出厂提示词注入面体检」实做蒸馏（R0 5125 + R1 5256 分节账本 · 三处引用失真 · 批次 `l0-polish`）；本卡只写"怎么量 / 怎么核 / 怎么验收"，注入源与门禁的真实位置一律指过去。_
