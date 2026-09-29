---
name: mind-api-calls
description: 用脚本直打心智 HTTP API（`/api/mind/*`）的三条硬口径——① 必须带 `Sec-Fetch-Site: same-origin`（否则 403）② body 必须显式 UTF-8 字节（传字符串会把中文**静默**变 `?`，接口仍返 200）③ 写完必须**回读校验**。触发：打API / Invoke-RestMethod / api/mind / 心智API / 中文变问号 / body编码 / 回读校验 / cron任务API / CSRF / 403 forbidden。
version: 1.0.2
author: DSHOME
license: internal
contract:
  id: mind-api-calls
  triggers: [打API, Invoke-RestMethod, api/mind, 心智API, 中文变问号, body编码, 回读校验, cron任务API, CSRF, 403]
  inputs: [目标路由 + JSON body（可能含中文）]
  outputs: [正确调用口径（头 + 编码 + 回读）+ 已实测的路由形状]
  deps: []
metadata:
  tags: [PowerShell, Invoke-RestMethod, UTF-8, 编码, CSRF, curl, 心智API, 回读校验]
  related: [verify-integrity]
---

# mind-api-calls — 用脚本驱动 `/api/mind/*` 的操作口径

## 一、工具定位

**对治的病**：心智 API 从**脚本**里直打时有三个失败面，前两个**不报错**：

| # | 病 | 症状 | 为什么会静默 |
|---|---|---|---|
| ① | 缺 CSRF 头 | `403 forbidden` | 这个**会报**——三个里最"善良"的一个 |
| ② | body 传字符串 | 中文**变成 `?`** 存进去 | 接口**返 200**；`?` 是合法 ASCII，服务端分不出"用户真打了问号"还是"编码坏了" |
| ③ | 不校验 | 以为写对了 | 只有"发出去 → 读回来对照"才能发现上面这两条 |

**实测读数（当场 A/B，零副作用：只 `add`+`GET`+`remove`，没 `run`、没拉会话）**：
- `Invoke-RestMethod -Body '{"prompt":"中文测试A"}'` ⇒ 回读 **`????A:?????`**
- `-Body ([Text.Encoding]::UTF8.GetBytes($json))` ⇒ 回读 **`中文测试B：只回复收到`** ✅

**真实事故链（2026-09-24，本机实测）**：用字符串 body 加了一条自治任务 ⇒ 它的 prompt 落库即乱码 ⇒ `cron/run` 拉起的会话收到 `任务： ????…` ⇒ 那个 agent 为**自救**去翻会话数据（自造脚本解 zstd、dump 会话里的 user 消息）、在共享工作区里跑起来 —— 等于**放了一个满工具的 agent 进去**，而且**停不掉**（插件没暴露"停会话"路由）。⇒ 本口径的价值不在"省一步"，在**掐掉这条链的第一环**。

## 二、部署/接入

无实体脚本——本条目是**操作口径**。可复制的两行封装（PowerShell）：

```powershell
$h = @{ 'Sec-Fetch-Site' = 'same-origin'; 'Content-Type' = 'application/json' }
$body = [Text.Encoding]::UTF8.GetBytes((@{ id='x'; prompt='中文' } | ConvertTo-Json -Compress))
Invoke-RestMethod -Uri 'http://127.0.0.1:3099/api/mind/cron/add' -Headers $h -Method POST -Body $body
```

## 三、核心操作

| 我要做的事 | 走这个 | 别用 |
|---|---|---|
| 打任何 `/api/mind/*` | 带 `Sec-Fetch-Site: same-origin`（或等价 `Origin`，host 必须同源；默认端口 3099） | 裸打（403，且看不出为什么） |
| body 含非 ASCII | **`[Text.Encoding]::UTF8.GetBytes($json)`** | `-Body <字符串>`（默认编码 ⇒ 中文变 `?`） |
| 写完确认 | **回读**（`GET` 回来逐字段对） | 拿 200 当"写对了" |
| 测"接线通不通" | 只走 `add` / `GET` / `remove` 这类**不改行为**的调用 | 拿 `cron/run` 当探针——**它会拉起一个真 agent**（见上） |

**已实测的路由形状**（只列真跑过的）：
- `GET  /api/mind/cron` → `{ok, tasks[]}`（任务含 `lastRunAt` / `lastResult` / `lastAttach`）
- `POST /api/mind/cron/add` → body `{id, cron, prompt, cwd, workspace?, catchUp?, preset?}`
- `POST /api/mind/cron/update` → body `{id, ...patch}`（`workspace:''` = 清空回"按目录自动"；`'@none'` = 明确不登记）
- `POST /api/mind/cron/remove` → body `{id}` → `{ok, removed}`
- `POST /api/mind/cron/run` → body `{id}` → **走串行闸 `cron.trigger(task,'panel-run')`（拉真会话）**，返回 `{ok, mode, …}`：`mode` ∈ `started`（闸空 ⇒ 立刻发了）/ `queued`（闸忙 ⇒ 入队，另带 `queueLength`，或 `dedup:'already-queued'` 表示本来就在队列里）/ `running`（该任务已在跑 ⇒ 未重复发起，`dedup:'already-running'`）/ `unserialized`（串行闸未接上 ⇒ 发了但**不保证不并发**）。⚠️ **不再返回 `sessionId` / `workspace`**——会话 id 要等创建完才有，本接口**不同步等**（2026-09-28 改；旧形状＝`executeTask` 直调 + 返回 `{status, sessionId, cwd, workspace}`）。
- `GET  /api/mind/workspaces` → `{ok, workspaces:[{id,title,path}], diag:{registryRef,count}}`

**反例自检**（证明修法有效、且"乱码 ≠ 输入问题"）：同一条中文 prompt 分两次 `add`——字符串 body 一次、UTF-8 字节一次——各自 `GET` 回读对比。**两次都 200，只有回读能分开**。

### 已知边界（诚实标注）

- **不能靠门禁**：`?` 是合法 ASCII ⇒ 服务端无法判定真伪问号。这一条**只能靠纪律 + 回读**。
- **面板不受影响**：浏览器（GUI）发的是正确 UTF-8；本坑只存在于"**脚本直打**"这一面。
- **`/api/mind/cron/run` 的副作用**：**会真拉一个自治会话**（面板「立即运行」同路径）。2026-09-28 起它改走串行闸 ⇒ ① 闸忙时语义是**入队**、不是"立刻跑"（看返回的 `mode`）② 该会话结束后**会进 `cron-runs.jsonl` 台账**（旧版绕闸直调、不进台账那半个缺口已修）。要验接线就别碰它。

## 四、关联索引

- `mind/L2/Skill/verify-integrity.md` —— "接口返 200 ≠ 内容是对的"同源：**判据必须落在"结果变没变"，不是"动作做没做"**
- 私有区 Exp「读文本 / 比较文件的操作口径」（**私有区**，按标题引用）—— **读侧**同族：`Get-Content` 默认 ANSI ⇒ 中文乱码 + 私有全文上屏；本条目是它的**写侧姊妹**
- 本机 `Learn.md` 2026-09-11「探针要对被测资产零风险」及其 2026-09-24 补记（**私有区**，按标题引用）—— 上面那条事故链的原始记录与四条动作
- 该「`/api/mind/cron/run` 绕过串行闸 + 该会话不进台账」缺口**已于 2026-09-28 修**（改走 `cron.trigger(task,'panel-run')`，形状见上「已实测的路由形状」）；当时挂在私有区项目档的那条待办已随之办结

---

_版本：1.0.2 | 2026-09-28 | 补齐**缺失的文件尾版本行**（依据 `mind\L1\Power.md` §四「文件头版本与文件尾版本一致」；`Exp\README.md` 1.3→1.4 · `Tree.md` 1.45→1.46 同批同步）——**正文零改动** | 1.0.1 | 2026-09-28 | `/api/mind/cron/run` 改走串行闸（`cron.trigger`，返回 `{ok,mode,…}`）+ 该会话**会进** `cron-runs.jsonl` 台账 | 1.0.0 | 2026-09-24 | 由私有区**提升**、去敏改写为固定四章_
