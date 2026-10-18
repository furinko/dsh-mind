# 官方宿主局部重载契约 · dsh-mind（只读研究）

- 项目：`plugins` / 产品：`dsh-mind` / 工作区：`C:\Users\wjthq\.dsh\plugins`
- 宿主：`D:\DeepSeek_harness_desktop\resources\app.asar`（真实文件，182,794,869 B）
- 运行态：同机桌面宿主 PID **21092**，启动 **2026-10-18 11:41:09 +08**，GUI **http://127.0.0.1:5698**
- 边界：**只读研究**。未执行重载/重启/网络写，未改产品源码或部署配置，未读取/输出认证令牌。证据只写 `dsh-mind/.recovery/`。
- 任务判据（冻结）：真实调用/参数与身份边界；区分是否清模块缓存及 shareOrg 缓存；同一 URL 下验证新机制实际对象代次；不靠裸 JSON 兼容/字符串猜版本/新服务器假生效；无法无中断重载时明确阻塞与证据。

---

## 0. 结论摘要（给 Lead）

1. **不需要主权者重启即可让 dsh-mind 的 host 半区改动生效。** 当前宿主已带 `--expose-internals`，profile 的 `hmr` 条目已显式配置模块监听根；官方 `@deepseek-ai/dsh-hmr` 在同一进程内完成了模块替换，并**确实清掉了 `src/runtime.js` 的模块实例**，从而重建了 `shareOrg` 单例。实测：`src/policy.js` 于 05:16:44Z 被并行写者保存后，我通过同一 URL/同一会话的 `mind status` 读到 live Org 装配代从 `f2961413…` 变为 `bc7a2d4b…`，PID 始终 21092（证据见 §3.4、§8）。
2. **官方没有名为 `reload` 的命令/RPC。** 局部重装配有且只有两条官方路径：
   - **A. 模块 watcher**（当前实际在跑）：保存被监听根下的源码 → chokidar `change` → `Hmr.partialReload()`；
   - **B. Profile reconciliation**：`Hmr.reconcileProfile(requiredIds)`，由 Plugin Manager 的变更动作、profile patch / profile `package.json` 变化触发（`PluginManager.reload()` 内部调用）。
   CLI `dsh plugin` 只是 pnpm 包管理，desktop profile 还要求先完全退出应用，**不是热重载入口**。
3. **两条路径的清缓存范围不同，正是“新 kernel + 旧缓存 Org”混代的根因：**
   - watcher/`partialReload`：受影响 Loader entry 的**整个依赖闭包**（含 `src/runtime.js`）+ 其 importer 被 evict ⇒ `shareOrg` 的模块级 `Map` 必被丢弃 ⇒ 新 Org。
   - `reconcileProfile`：只 evict **stale 模块 + 其 importers**，**不 evict 依赖**。只改 kernel/routes/actions 这类“消费端”时，`src/runtime.js` 留在缓存 ⇒ 新 kernel 拿到旧 Org；源码里有 `registry.snapshotSync`、live 对象原型上却没有，正是本事故形态。
4. **比接口混代更硬的阻塞：`processGeneration()` 的代次存在模块作用域。** 热重载会生成新的“进程代”（同 PID 也算新代）；旧实例仍挂旧代，`orphanSweep` 因 PID 相同只能判 **“未判定”**，不猜死。当前 live Org 是 `bc7a2d4b…`，而本成员实例 `67efe1e7…`（05:16:38 登记）仍是 `f2961413…`——同 PID 21092。读取桥接（`instance-snapshot.js`）只恢复读，不改变代次判定。**最终审计若要求“所有在岗实例同代”，必须先修这个，或主权者重启后重新登记；重启本身也会换代并封存旧实例，不是无损方案。**
5. **最小正式入口（Lead 可执行）**：保存被 `hmr` 监听根覆盖的源码文件（无需新命令/新服务器），等重装配完成后在**同一 URL、同一会话**读 `mind status` 的 `数据.引导.代次.代` 验证 Org 代次；若要证“新 kernel 代码本身”，需补一个模块代/接口身份的只读读数（§4.2）。**文件 hash、npm 绿、成员 read 成功、新服务器、JSON 兼容层都不能充当运行态证据。**

---

## 1. 取证基线（官方源码与运行配置）

### 1.1 官方源码版本与哈希

app.asar 的读取方法按 Lead 已验证的格式：16 字节 lead，`JSON长度 = u32@12`，JSON 从 offset 16；`dataStart = 8 + u32@4`，entry.offset 相对 dataStart；只读目标 entry，不复制整包。本报告引用的官方文件已抽到 `.recovery/asar-out/…`，并与 asar header 的 `integrity.hash` 核对：

| 包 | 版本 | 文件 | sha256 |
|---|---|---|---|
| `@deepseek-ai/dsh-hmr` | 0.2.1-rc.2 | `lib/index.js` | `143b445f1b303be83d56f9e7d3992e1a4885850c08f1082065d332ba7a70ae0a`（与 asar integrity 一致） |
| `@deepseek-ai/dsh-plugin-manager` | 0.2.1-rc.2 | `lib/index.js` | `1b8bf9eb266d7b3b7f899175e3f435c89ed8baa8aabc677212759f8c6cd23132` |
| `@deepseek-ai/dsh-plugin-manager/tools` | — | `lib/types/tools.js` | `07438d86ae290c0add52f2dd3863ee128be8739d35dc4599208e1387028431bd` |
| `@deepseek-ai/dsh-client-hmr` | 0.2.1-rc.2 | `lib/index.js` | `dcc6157a921254b0fa059fd498b90dad651b1908b8ac59ef5ecd1ab488269409` |
| `@deepseek-ai/cordis` | 4.0.5 | `lib/index.js` | （用于 `RegistryService.get` 语义） |
| `@deepseek-ai/cordis-plugin-loader` | 1.0.6 | `src/index.ts` 等 | （含 `Loader` 源码） |

取证工具与原件：`.recovery/asar.mjs`、`.recovery/asar-out/…`（只读副本，非产品 import）。

官方源码定位（行号均为 `.recovery/asar-out/` 抽取副本的行号；sha256 见上表）：

| 符号/行为 | 文件 | 行 |
|---|---|---|
| `Hmr.Config`（base/root/ignored/debounce） | `dsh-hmr/lib/index.js` | 702-712 |
| `Hmr` 构造（`--expose-internals`、`baseDir`） | 同上 | 782-789 |
| `watchConfig()`（profile patch/manifest 精确监听） | 同上 | 767-781, 49-121 |
| `Hmr[Service.init]`（profile watch / module watch） | 同上 | 820-951 |
| 模块 watcher + `change` + debounce dispatch | 同上 | 883-936 |
| `partialReload()`（依赖闭包 + evict + 逐 entry 替换） | 同上 | 1015-1149 |
| `evict()`（ESM loadCache + CJS require.cache） | 同上 | 1157-1178 |
| `planReplacement()`（stale + importers，不向下加依赖） | 同上 | 1214-1257 |
| `stopPlanned()`（无备份 evict + 停 fiber） | 同上 | 1274-1279 |
| `reconcileProfile()`（compare → plan → stop → recompose） | 同上 | 1320-1385 |
| `profileRoots()`（profile + linked targets 的 realpath） | 同上 | 1449-1453 |
| `PluginManager.reload(requiredIds)` → `hmr.reconcileProfile` | `dsh-plugin-manager/lib/index.js` | 2360-2372 |
| `PluginManager.configure()` → `hmr.runExclusive` | 同上 | 2324-2331 |
| `PluginManager.setPluginEnabled()`（写 patch 后 reload） | 同上 | 1930-1943 |
| `plugin_manager` 工具 + `danger-full-access`/审批 | `dsh-plugin-manager/lib/types/tools.js` | 74-99, 123-130 |
| `recomposeProfile(ctx, patches, "dsh", {requiredIds, running})` | `app-boot-index.js` | 3782-3784, 3797-3849 |
| `RegistryService.get(plugin)`（按 plugin callback 存 runtime） | `cordis-index.js` | 1545-1548 |
| 出厂 `hmr` 默认 `root: []` | `base-cordis.patch.yml` | 28-34 |
| 标准 preset 禁用 `tool-plugin-manager` | `standard.patch.yml` | 123-126 |
| 创造/`cordis` preset 启用 `tool-plugin-manager` | `cordis.patch.yml` | 131-132 |
| `Org.status()` 返回 `引导: this.boot` | 产品 `src/org.js` | 292-307 |
| `shareOrg`/`processGeneration`/`实例` Map | 产品 `src/runtime.js` | 18-19, 36-42, 53-67 |
| `snapshotSync` 桥接 | 产品 `src/registry.js` | 750-751 |
| `recordBoot` / `orphanSweep` | 产品 `src/registry.js` | 988-1007, 1031+ |
| kernel 捕获 `org` / guard 捕获 `org` | 产品组件 | `kernel/lib/index.js:56-64` / `guard/lib/index.js:28-38` |

### 1.2 运行宿主与 profile

- PID 21092 命令行：`… --expose-internals …\dsh-desktop-host\lib\index.js …\dsh C:\Users\wjthq\.dsh\profiles\desktop …`。
  `--expose-internals` 是 HMR 的硬前置（`Hmr` 构造函数：`if (!this.ctx.loader.internal) throw new Error("--expose-internals is required for HMR service")`）。
- profile：`C:\Users\wjthq\.dsh\profiles\desktop`；`package.json` 依赖 `"dsh-mind": "link:../../plugins/dsh-mind"`；`node_modules\dsh-mind` 是 **Junction → `C:\Users\wjthq\.dsh\plugins\dsh-mind`**。
- profile patch（`cordis.patch.yml`，mtime 12:34:03 +08）中的有效条目：
  ```yaml
  - id: hmr
    name: "@deepseek-ai/dsh-hmr"
    disabled: false
    config:
      base: "../.."
      root:
        - "plugins/dsh-mind"
        - "plugins/DSHOME-Plugin"
  ```
  `~/.dsh/cordis.patch.yml`（home patch）不存在，因此没有更高优先级覆盖。
- 出厂默认（`@deepseek-ai/dsh-base/cordis.patch.yml`）：`hmr` 条目 `root: []`——只监听配置文件，不监听源码。**profile patch 的 root 才是本机源码热重载生效的原因。**
- 当前 `--patch` 启动 overlay：命令行中没有，故 profile patch 即最终层。

### 1.3 官方 `Hmr.Config`（真实参数）

`@deepseek-ai/dsh-hmr/lib/index.js`（抽取副本行号，下同）：

```js
static Config = z.object({
  base: z.string(),
  root: z.array(String).role("table").default(["."]),
  ignored: z.array(String).role("table").default([
    "**/node_modules", "**/.*", "cache", "data"
  ]),
  debounce: z.natural().role("ms").default(100)
});
```

`baseDir = fileURLToPath(new URL(config.base || ".", ctx.baseUrl))`。profile 组合下 `ctx.baseUrl` 为 profile 目录，因此本机 `base: "../.."` = `C:\Users\wjthq\.dsh`；root 解析为 `C:\Users\wjthq\.dsh\plugins\dsh-mind`（chokidar `ignored` 也是相对 `baseDir` 计算的）。

---

## 2. 官方局部重装配的两条真实路径

### 2.1 路径 A：模块 watcher（当前生效）

**真实调用链**（官方源码）：

1. `Hmr[Service.init]` 里：`this.watcher = watch(root, { ...config, cwd: watchBaseDir, ignored: path => match(relative(...)), ignoreInitial: true })`。
2. 仅监听 `change` 事件：`this.watcher.on("change", (path) => { changed.add(path); dispatch(); })`。
3. `dispatch`（`ctx.debounce(..., config.debounce)`）进入 `runExclusive`；对每个变化路径：
   - 若是已缓存 ESM 模块（`esmHas(url)`）→ 放入 `stashed`；
   - 若是 Loader include 树文件 → `include.refresh()`；
   - 否则 emit `hmr/change`。
4. `stashed` 非空 → `await this.partialReload()`。

**`partialReload()` 的关键语义**（这是“会清 shareOrg”的原因）：

```js
// 1) accepted 先取 stashed + 其 importers（analyzeChanges）
// 2) 对每个受影响 Loader entry：
const dependencies = [...await loadDependencies(job, this.declined)];
if (!dependencies.some((dep) => this.accepted.has(dep))) continue;
dependencies.forEach((dep) => this.accepted.add(dep));   // ← 整个依赖闭包
// 3) 一次 evict，再 import 新 entry、逐个停旧起新
const rollback = this.evict(this.accepted);
...
await this.ctx.loader.import(generation.filename, this.getOuterStack);
...
this.ctx.registry.delete(plugin);
await Promise.all(fibers.map(({ fiber }) => fiber.await()));
await reload(replacement, fibers, replacements, activated);
...
this.ctx.emit("hmr/reload", reloads);
this.files.refresh(this.accepted);
```

因此：**只要 dsh-mind 的某个已加载 Loader entry 受影响，该 entry 的整个 `src/` 依赖闭包（含 `runtime.js`、`org.js`、`registry.js`、`policy.js` 等）都会被加入 accepted 并 evict**。这是 `shareOrg` Map 被丢弃的充分条件。

- 失败时 `rollback()` 恢复模块缓存并重载旧实现；成功后不恢复。
- 该路径**没有认证参数**：触发条件就是文件系统 `change` 事件；能写监听目录的本机用户/进程即可触发；HMR 只写 logger（`reload plugin at %C`），不产生 mind 审计行。
- 注意本版本的模块 watcher **只监听 `change`**，不监听 `add`/`unlink`：新增文件本身不触发重载；删除文件也不会触发（但被删除文件若随后被比较到，需靠 reconcile 路径）。要触发重载，必须让一个**已加载**的模块文件发生 `change`。

### 2.2 路径 B：Profile reconciliation

**真实调用链**：

- `PluginManager.setPluginEnabled(id, enabled)` / `setBundleEnabled` / `setVersionExemption` / `installBundle` / `removeBundle` 等（`@deepseek-ai/dsh-plugin-manager/lib/index.js`）→ 都在 `change()` 内 → `this.configure(async () => { ...; await this.reload(...) })`。
- `configure(operation)`：
  ```js
  const hmr = this.ownerContext.get("hmr");
  return hmr === void 0 ? apply() : hmr.runExclusive(apply);
  ```
- `reload(requiredIds = [])`：
  ```js
  const { warnings, pending, restartReason } = await hmr.reconcileProfile(requiredIds);
  ...
  ```
- `Hmr.reconcileProfile(requiredIds = [])` 必须在 `runExclusive` 内：
  ```js
  const running = [...this.ctx.loader.entries()].filter((entry) => entry.fiber?.state === 2);
  const patches = readProfilePatches("dsh", profile);
  comparison = this.files.compare(this.profileModules(profileRoots(profile.dir)));
  // stale 模块 + 其 importers → planReplacement → stopPlanned（evict，无备份）
  // → recomposeProfile(root, patches, "dsh", { requiredIds, running })
  // → files.observe(...)
  ```
- 触发源：
  - profile patch 文件（`profile.patchPath`）或 profile `package.json` 的 `watchConfig`：`refresh(false)` / `refresh(true)`；`refresh` 会先比较输入字节与 bundles，**输入未变则直接 return，不重装配**。
  - Plugin Manager 的变更：直接调 `reconcileProfile`，**不依赖文件事件**。
- `recomposeProfile` 来自 `@deepseek-ai/dsh-app-boot`（`recomposeProfile(ctx, patches, "dsh", { requiredIds, running })`）：发布新的 runtime resolution、应用 generation、启动被停掉的 entry、重试此前 import 失败的 entry、判定激活；它自身带来的 restart 原因目前只有 `package-moved`。
- 该路径的 `stopPlanned` 是**无备份 evict**：`this.evict(plan.evicted)` 的返回值被丢弃；替换失败时旧代码不再运行，插件以 failed 停留，直到下一次重装配再次 import。与路径 A 的 rollback 不同，**reconcile 路径失败不回滚**。

**该路径的认证/权限边界**（官方源码可见）：

- `plugin_manager` 工具（`dsh-plugin-manager/lib/types/tools.js`）：
  ```js
  await approveEscalation({
    requestedMode: 'danger-full-access',
    effectiveMode: policy.mode,
    subject: 'plugin management operation',
    justification: `plugin_manager ${JSON.stringify(args)}. ...`
  }, { approver: ctx.get('approval'), agent: exec.agent, callId: exec.callId,
       toolName: 'plugin_manager', signal: exec.signal });
  ```
  参数：`action: 'set_plugin' | 'set_bundle' | 'list_plugins' | 'list_bundles' | 'install_bundle' | 'remove_bundle' | ...`；`target` 是 entryId / bundle 名 / 安装 spec；`set_plugin` 还需 `enabled: boolean`。
  **认证来源**：会话的 sandbox/approval 策略（`danger-full-access` 或逐次审批），不是插件管理自己的 token；工具本身**在标准 preset 里默认禁用**：
  - `dsh-base/cordis.patch.yml`：`- id: tool-plugin-manager … disabled: true`
  - `dsh-web-app/cordis.patch.yml`：`- id: tool-plugin-manager\ndisabled: true`
  - `presets/standard.patch.yml`：`tool-plugin-manager … disabled: true`
  - `presets/cordis.patch.yml`（创造模式）：`id: tool-plugin-manager` 启用（连同 `tool-cordis`）
- 桌面设置页走的是同一 `PluginManager` 服务（Typert `Remote` 方法，如 `setPluginEnabled`），边界是桌面壳的本地连接 + profile 写锁；**不是**模型工具。
- **服务层本身不做角色校验**：任何能拿到 `ctx.pluginManager` 的进程内插件都能调用 `setPluginEnabled`。真正的闸在工具层（审批/权限）与桌面 UI；不要把 `reconcileProfile` 当安全边界。
- profile 写锁：`withFileLock(profile/package.json, …, { waitMs })`；变更影响该 profile 的**所有会话**。

### 2.3 不存在的入口（别猜）

- **没有** `dsh plugin reload` / `hmr.reload()` 这种命令/RPC。`Hmr` 的公开成员是 `runExclusive`、`runReload`、`watchConfig`、`reconcileProfile`、`evict` 等；`reconcileProfile` 不是 Typert Remote，也没有对应的模型工具/CLI。
- CLI `dsh plugin`（`@deepseek-ai/dsh/lib/plugin-*.js`）只调用 `runPluginCommand` / `runProfilePnpm`，是包管理；desktop profile 前置检查明确写着 “fully quit it before running dsh plugin --profile desktop”。
- `@deepseek-ai/dsh-client-hmr` 是**浏览器半区**的图同步/开发时 bundle 重载：`/plugins/events`，开发链路要 `pnpm run dev:web`；它不负责 host 模块/Org。host 半区重装配与页面刷新是两件事。

### 2.4 身份边界总结

| 入口 | 参数 | 认证/边界 | 审计 |
|---|---|---|---|
| 模块 watcher（路径 A） | 被监听根下的**文件 change**；`hmr` 配置 `{base,root,ignored,debounce}`；当前 `base=../..`、`root=[plugins/dsh-mind, plugins/DSHOME-Plugin]`、`debounce=100ms` | 本机文件系统写权限；无 token、无角色判定；同用户任何进程可触发 | HMR logger 有 `reload plugin at …`；**不写 mind 审计** |
| `Hmr.reconcileProfile(requiredIds)`（路径 B） | `requiredIds: string[]`（必须启动的 Loader entry id）；`running: Entry[]`（内部）；在 `runExclusive` 内 | 调用者已在进程内拿到 `hmr` 服务；无内建授权；工具层才要求 danger-full-access/审批；profile `package.json` 文件锁 | 取决于调用方；PluginManager 结果会报 `application`/`restartReason` |
| `plugin_manager` 工具 | `{action:'set_plugin', target:<entryId>, enabled:<bool>}` 等 | **danger-full-access 或逐次审批**；标准 preset 禁用，创造/`cordis` preset 启用 | 工具结果 + 服务行为；非 mind 审计 |
| 桌面设置页 | 同 `PluginManager` RPC | 桌面壳本地连接 + profile 写锁 | 同服务 |
| CLI `dsh plugin` | pnpm 参数 / version-exemption | 本机 OS 用户；desktop 要求应用完全退出 | CLI 输出 |

> 本次研究没有读取任何认证令牌，也没有尝试直连内部 RPC；以上全部来自官方源码与运行配置。

---

## 3. 缓存清除语义：模块缓存 vs shareOrg

### 3.1 模块缓存：`evict()` 清什么

`Hmr.evict(urls)`（官方源码）：

```js
evict(urls) {
  const esmBackup = new Map(); const cjsBackup = new Map();
  const cache = commonJsCache();               // require.cache
  const cached = new Set(this.esmUrls());      // Node ESM loadCache keys
  for (const url of list) if (cached.has(url)) {
    esmBackup.set(url, Map.prototype.get.call(this.internal.loadCache, url));
    Map.prototype.delete.call(this.internal.loadCache, url);   // 整个 URL 的 per-type job map
  }
  for (const filepath of list.filter(u => u.startsWith("file:")).map(u => fileURLToPath(u))) {
    const module = cache[filepath];
    if (module !== undefined) { cjsBackup.set(filepath, module); Reflect.deleteProperty(cache, filepath); }
  }
  return () => { /* restore both caches */ };
}
```

- **ESM**：删 `internal.loadCache` 的整个 entry（不是只删一个 type slot）。
- **CJS**：删 `require.cache[filename]`。
- 被清模块的顶层副作用不会撤销；再 import 会重新求值。
- packed worker 没有这两个缓存时，HMR 走 `restartReason: "module-comparison"`，只能重启。

**范围差异**：
- 路径 A `partialReload`：先 `accepted = stashed + transitive importers`（`analyzeChanges`），再对每个受影响 entry 把 **全部依赖** 加入 accepted，最后 `evict(accepted)`；失败回滚，成功 `files.refresh(accepted)`。
- 路径 B `reconcileProfile`：`planReplacement` 的 `affected = stale + transitive importers`（向上找 importer），只 evict 这个集合；**不向下加依赖**。随后 `stopPlanned` 无备份 evict；`recomposeProfile` 用当前文件启动被停的 entry。

### 3.2 shareOrg 单例：宿主不知道它，只有模块实例消失它才消失

`dsh-mind/src/runtime.js`：

```js
const 实例 = new Map();                    // 模块作用域

export function shareOrg(spec) {
  const key = shareKey(spec);
  let pending = 实例.get(key);
  if (!pending) {
    pending = Org.open({ ...spec, 代次: processGeneration() }).catch(...);
    实例.set(key, pending);
  }
  return pending;
}
```

- HMR 只清 Node 模块缓存；它**不认识** `实例` 这个 Map。Map 随 `src/runtime.js` 的模块实例存活。
- 因此：
  - `src/runtime.js` 被 evict 并重新 import ⇒ 新模块作用域 ⇒ 新 Map ⇒ 下一次 `shareOrg` 新建 Org。
  - `src/runtime.js` 未 evict ⇒ 即使 kernel/guard entry 重新 import，它们拿到的仍是**同一个旧 Map/旧 Org**。
- 路径 A 由于“受影响 entry 的依赖闭包全进 accepted”，`runtime.js` 必进 evict 集；实测证据见 §3.4。
- 路径 B 只在 `runtime.js` 自身 stale，或某个 **importer**（parent）stale 把 `runtime.js` 拉进来时才 evict 它。**只改消费端模块时不会**。

### 3.3 混代根因与路径对照

典型消费端（不会把 runtime 拉进 reconcile 的 evict 集）：`components/kernel/lib/index.js`、`components/kernel/lib/routes.js`、`components/kernel/lib/delegation-settings.js`、`lib/actions.js`、`src/review-scope.js`（仅 kernel import）等。
典型构建端（被 `org.js`/`runtime.js`/`registry.js` import，reconcile 也会沿 importer 拉到 runtime）：`src/policy.js`、`src/tasks.js`、`src/bus.js`、`src/memory.js`、`src/capability.js`、`src/audit.js`、`src/store.js`、`src/paths.js`、`src/instance-snapshot.js`（registry/kernel 都 import）等。

| 改动文件 | 路径 A（watcher/partialReload） | 路径 B（reconcile） | 结果 |
|---|---|---|---|
| kernel entry / routes / actions 等消费端 | 受影响 entry 的依赖闭包含 `runtime.js` → 全量 evict | 只 evict stale + importers → `runtime.js` 留缓存 | A：新 Org；B：**新 kernel + 旧 Org（混代）** |
| `src/registry.js` / `org.js` / `policy.js` / `instance-snapshot.js` 等构建端 | 全量 evict | stale + importers 链会包含 `runtime.js`（它是 importer） | A/B 都新 Org |
| 仅新增文件（未被旧图 import） | **不触发**（watcher 只听 change；新 URL 不在 ESM 缓存） | 不 stale；若没有别的触发则不重装配 | 需要同时改一个已加载 importer |
| 仅删文件 | **不触发**（无 unlink 监听） | 只有被触发时才 compare 到 missing；否则不重装配 | 不要依赖删除触发 |
| 改 `@deepseek-ai/dsh-hmr` 自身或宿主静态图 | `fullReload`/`loader.exit()` 或 `host-module` pending | `host-module` pending | **必须重启** |
| 受影响模块是“无 Loader entry 的插件” | `unmanaged-plugin` pending | `unmanaged-plugin` pending | **必须重启** |

**额外风险（两条都与最终验收有关）**：

1. **路径 A 的新旧 Org 交叠窗口**：`partialReload` 是逐 entry “停旧→起新”，不是先停完所有再起。kernel 先起新 Org 时，guard 的旧 fiber 可能仍在用旧 Org（两者同 PID、不同代）。窗口很短，但若有并发工具调用，会出现两个 Org 同写一份账本。官方 README 说的“共享同一运行时的 entry 一起替换”指的是**同一 plugin callback** 的多个 entry；dsh-mind 三个组件是三个不同 callback（`RegistryService.get(plugin)` 按 callback 存储），不会被官方分组。因此不能假设官方会替我们做“全体 stop barrier”。
2. **路径 B 失败不回滚**：替换版本 import/activate 失败 ⇒ 旧代码不再运行，插件以 failed 停留，直到下一次 recompose 重新 import。路径 A 有 rollback（恢复缓存 + 旧实现），相对安全。

### 3.4 已实测：官方局部重载确实重建了 Org

**同 PID 21092、同 URL、同一会话**：

| 时点 | 读数 | 值 |
|---|---|---|
| 2026-10-18T05:16:37Z | `mind status` → `数据.引导.代次` | `{代:"f2961413-da39-4aa2-b0fc-8fa8d91e3ba9", pid:21092, 于:"2026-10-18T05:10:53.056Z"}` |
| 2026-10-18T05:16:44Z | 并行写者保存 `src/policy.js`（mtime 13:16:44 +08） | 110,227 B |
| 2026-10-18T05:16:44Z | 审计 seq2274 | `机制维护 … 本进程代次 bc7a2d4b（pid 21092）已登记` |
| 2026-10-18T05:22:45Z | `mind status` → `数据.引导.代次` | `{代:"bc7a2d4b-a93a-4fad-b02e-9f888e31ccce", pid:21092, 于:"2026-10-18T05:16:44.163Z"}` |
| 2026-10-18T05:16:44Z | `identity.json` boot | `bc7a2d4b…` / pid 21092 / 05:16:44.163Z |

推理：`Org.open` 只在 `shareOrg` 的模块级 Map 为空时执行；新 Org 的 boot 记录只能来自**新的 `runtime.js` 模块实例**。因此这次重载确实清掉了 `runtime.js` 的模块缓存，并重建了 shareOrg 单例。触发者是并行写者（W5/A）对 `policy.js` 的保存，不是本会话执行的重载。

同一状态还暴露了 §0.4 的身份副作用：本成员实例 `67efe1e7-…` 在 05:16:38 用旧代 `f2961413…` 登记，05:22:45Z 的 status 把它列入 `孤儿回收.未判定`：
> “代次 f2961413-da39-4aa2-b0fc-8fa8d91e3ba9 没有 pid 记录：拿不到存活事实。”

补充异常：审计 seq2261（05:10:53）明确登记过 `f2961413`，但 05:16:44 的 `identity.boot.代次记录` 只剩 `bc7a2d4b`。即 **`代次记录` 的历史在热重载/并发写中丢失**。判定结果同为“未判定”，但证据链变弱；`identity.json` 不能当可靠的代次历史源（以审计 + live tool 读数为准）。这值得 W5/Lead 核对 `registry.recordBoot` 的读写竞态。

---

## 4. 同一现有 URL 下验证“实际对象代次”的方法

### 4.1 现在就能用的 live 读数（无需改代码）

**同一 URL、同一会话**调用 `mind` 工具 `status`，读：

- `数据.引导.代次.代` — **kernel 组件所持 live Org 的装配代**（`Org.boot.代次`，来源 `org.status()` 返回 `引导: this.boot`，`src/org.js:292-307`）。它是 `shareOrg` 在 `Org.open` 时传入的 `processGeneration()` UUID，**在内存里**，不是从文件读的。
- `数据.引导.代次.pid` / `.于` — 同进程 PID 与装配时间。
- `数据.引导.孤儿回收.本代` — 同一次 boot 的 sweep 本代。
- `数据.探针.最近[].详情` 的“加载于 …” — 策略引擎最后一次 `reload` 时间；**弱证据**（同一 Org 内 policy.reload 也会改它），不要单独用。

本机已实测：`f2961413…` → `bc7a2d4b…`，PID 未变。这证明 **kernel 的 live Org 被重建**。它**不**证明：

- 浏览器页面里的 client bundle 是新版（host 半区与页面半区不同，见 §2.3）；
- guard 组件也持有同一个 Org（需要 guard 侧读数）；
- 新 kernel 代码本身已执行（可能只是 Org 新建，kernel 仍旧；需要一个 kernel 模块代读数）。

`identity.json` 的 `boot` 只能作交叉核对；它是文件层，且在热重载并发下可能丢历史（§3.4）。

### 4.2 建议补的最小只读读数（新代码，非版本字符串）

在 `mind status`（或一个只读诊断 action）里加一个 `运行态` 块，由**当前执行代码现场生成**，不做任何兼容/猜版本：

```js
运行态: {
  进程: {
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    进程代: processGeneration().代,          // 修复后：跨重载稳定，只在真重启时变
  },
  模块: {
    runtime: RUNTIME_MODULE_ID,             // runtime.js 模块 eval 时的 randomUUID
    kernel: KERNEL_MODULE_ID,               // kernel/lib/index.js 模块 eval 时的 randomUUID
  },
  组织: {
    装配代: org.装配代,                     // Org.open 时生成的 randomUUID（新增）
    装配于: org.装配于,                     // 新增，或直接暴露 org.boot.代次.于
    实例数: sharedOrgCount(),               // 调当前 runtime 模块的共享计数
  },
  接口: {
    registrySnapshotSync: typeof org.registry.snapshotSync === 'function',
    registry原型同源: Object.getPrototypeOf(org.registry) === Registry.prototype, // 同一模块 import 的类
    registry原型方法数: Object.getOwnPropertyNames(Object.getPrototypeOf(org.registry)).length,
  },
  消费者: { kernel组织代: org.装配代 }       // guard 侧再报一份，做同代一致性
}
```

关键设计：

- **三层次分开**：`进程代`（重启才变）、`模块代`（模块被重新 import 就变）、`组织装配代`（`Org.open` 重跑就变）。**不要用一个 UUID 冒充所有层次**——当前 `processGeneration` 就是模块作用域，热重载把它一起轮换，导致“同 PID 不同代”的假孤儿（§5.1）。
- **接口身份用对象/原型同一性**，不是 `package.json` 版本、不是静态字符串：`org.registry.constructor === Registry`（或 `Object.getPrototypeOf(org.registry) === Registry.prototype`，`Registry` 必须是**同一模块实例** import 进来的）+ `typeof org.registry.snapshotSync === 'function'`（在 live 对象上现取）。若 live 对象是旧类实例、而当前模块是新类，这两个断言会红——这正是“源码方法在、live 对象没有”的机器判据。
- **多消费者同代**：guard 的 `mind_guard` 也返回它拿到的 `org.装配代`；kernel/guard 必须相等。若不等，说明有组件用了旧 Org（或旧 runtime 模块），即混代。
- **行为断言**：通过同一 URL 的 `mind` 调用触发**只在新路径存在**的返回值（例如 `snapshotSync` 路径的读结果/新审计字段）。仅“工具存在”“字段兼容”“旧路径仍能读”都不算。
- 如果暂时不改产品，至少把现有 `引导.代次` 的 before/after 作为 Org 重建判据；但这不能证明新 kernel 代码，最终验收仍应补上述字段。

### 4.3 验收矩阵（可直接照做）

**前置**：在重载前先取一次基线（同一会话/同一 URL）：`mind status` 的 `引导.代次.{代,pid,于}`；记录进程启动时间（任务管理器/`Get-Process`）与 `PID`。

| # | 断言 | 判据 | 失败含义 |
|---|---|---|---|
| 1 | 同一宿主 | 重载后 PID 与基线相同、进程启动时间不变 | PID/启动时间变了 = 发生了重启，不能记为“局部重载” |
| 2 | 新 kernel 代码执行 | `模块.kernel` UUID 与基线不同（需 §4.2 字段） | 文件改了但新代码没执行 |
| 3 | runtime 模块重评 | `模块.runtime` UUID 与基线不同（需 §4.2 字段） | runtime.js 未 evict；此时若接口有变，必然混代 |
| 4 | Org 单例重建 | `组织.装配代` 与基线不同；`引导.代次.代` 也变化 | 旧 Org 仍被返回（缓存未清） |
| 5 | 无混代 | kernel 与 guard 报的 `组织.装配代` **相等**；`sharedOrgCount()===1`；`未判定` 中没有“同 PID、旧代”的在用实例 | 新 kernel + 旧 Org，或双 Org 窗口 |
| 6 | live 接口真实存在 | `typeof org.registry.snapshotSync==='function'` 且 `getPrototypeOf(org.registry)===Registry.prototype`（同模块） | 只有源码/文件有方法，live 对象没有 |
| 7 | 行为生效 | 通过同一 `mind` 调用触发新路径，返回新结果/新审计行；内容断言通过 | 旧代码路径仍生效，或桥接直接读文件冒充 |
| 8 | 同 URL | 调用来自现有 GUI 会话的同一 `mind` 工具（不是新 CLI、不是新 server） | 新进程/新端口 = 假生效 |
| 9 | 浏览器半区另验 | 若改了 `components/board/lib/client.js`：页面执行层要有新 bundle 的代次标记，或走 `pnpm run dev:web`/刷新；host 重载不覆盖页面 | 用 host 绿冒充 UI 新 |
| 10 | 身份连续（若要求） | 在岗实例的代次 = live `进程代`；同 PID 旧代不再被当“未判定” | 需先修 §5.1 或重启后重登记 |

**必须排除的“假绿”**：

- 文件 hash/mtime 变了 ≠ 运行态已换；这正是本次事故要防的“源文件有、live 没有”。
- `npm test`/离线新装配全绿 ≠ 现有宿主已重装配；离线进程是另一套模块图。
- 成员 `mind` read 成功 ≠ Org 升级；`instance-snapshot.js` 的桥接就是**直接读文件**，旧 Org 也能读。
- `snapshotSync` 兼容层/裸 JSON 字段存在 ≠ 真实新机制；判据要取 live 对象上的方法/原型同一性。
- 新开一个 `dsh` server / 新端口 ≠ 现有 GUI 生效。
- `mind status` 的任务/记忆/岗位计数 ≠ 对象代次；这些走文件/服务读，旧代码也能返回。
- “HMR 日志里有 reload”只证明动作发生，不证明**哪一版**在跑；要代次 + 行为。

---

## 5. 具体位置与最小修复建议（只定位，不自行改）

### 5.1 首选：`src/runtime.js` 的进程代必须按“进程”锚定，而不是按“模块实例”

- 位置：`src/runtime.js:36-42`（`processGeneration()` 与 `let 进程代次 = null`）。
- 现状：`进程代次` 是模块作用域；HMR 重新 import 该模块即得到新的 `进程代次`。这违反注释里“本进程的代次 / 同一进程恒等”的语义，也与 `registry.orphanSweep` 的“同代=活”判据冲突：同 PID 的旧代会被判“未判定”，在岗实例变成历史。
- 最小修法（建议）：把进程代锚到进程级存储并按 PID 校验，例如 `globalThis[Symbol.for('dsh-mind.processGeneration')]`；仅当 `stored.pid !== process.pid` 时新建。这样：
  - 热重载：同进程 ⇒ 同代 ⇒ 旧实例仍判同代存活，不再出现同 PID 的“未判定”；
  - 真重启：新 PID ⇒ 新代 ⇒ 旧进程实例按 pid 已死正常回收。
- 同时新增独立的**装配代**（`Org.open` 时生成）用于验证 Org 重建；不要再用 `进程代` 冒充“模块/装配代”。

### 5.2 `src/runtime.js` 的 `实例` Map：不要从组件里清；要保证 `runtime.js` 被 evict

- 位置：`src/runtime.js:18-19`（`const 实例 = new Map()`）、`53-67`（`shareOrg`）、`98-101`（`forgetSharedOrg`，仅供测试/失败重试）。
- 不建议在生产路径由组件调用 `forgetSharedOrg()`：旧的 guard fiber 仍持有旧 Org，会变成两个 Org 并写同一账本（比现在更糟）。
- 正确方向是让 `runtime.js` 进入 evict 集：路径 A 已保证（依赖闭包）；路径 B 需要**变更集里包含一个构建端文件**（runtime/org/registry 或其依赖），或者使用路径 A。若要在产品层自愈，可在 `shareOrg` 里用一个“接口代”校验缓存 Org，但必须配合“所有消费者重启”的栅栏；不要只重建缓存。

### 5.3 组件在 `apply` 里捕获 `org`：这是接口变更时的约束点

- 位置：`components/kernel/lib/index.js:56-64`、`components/guard/lib/index.js:28-38`（`org = await shareOrg(...)` 后闭包持有）。
- 后果：只重载 kernel 而 `runtime.js` 未 evict 时，新 kernel 仍拿旧 Org；只重载 guard 同理。组件的“共享”语义只在同一 runtime 模块实例内成立。
- guard 的闸是同步的（不能每调用 `await shareOrg`），所以不要简单改成“每次调用重新取”；若要自愈，需设计同步可读的持有者/版本校验，且保持单写者。

### 5.4 现有的文件桥接（`src/instance-snapshot.js` + `src/registry.js:750-751`）

- 这是**可用性桥接**：旧 live Registry 没有 `snapshotSync` 时，`readInstanceSnapshot` 仍能提供读。对应回归测试 `test/guard-reviewer-readonly-2026-10-18.test.js:243-258` 已把这个场景钉住。
- 它**不是**升级证据，也不应该被当成“运行态已换”的判据；它的存在恰恰证明混代发生过。最终验收必须看 §4.2 的对象身份/代次。

### 5.5 观察到的身份记录异常（供 W5/Lead 核对）

- 位置：`src/registry.js:988-1007`（`recordBoot`）与 `1031+`（`orphanSweep`）。
- 事实：审计 seq2261 存在 `f2961413` 的登记，但 05:16:44 后的 `identity.boot.代次记录` 只剩 `bc7a2d4b`；`未判定` 的理由从“pid 存活”退化为“没有 pid 记录”。
- 影响：判断结论仍安全（不猜死），但证据链不完整；多次热重载/并发写会把 8 代历史冲掉。建议核对 `#mutateIdentity` 的读-改-写锁与 `recordBoot` 调用顺序，或把历史只依赖审计（不把 `代次记录` 当历史源）。此项与“混代”是两个问题，别混为一谈。

---

## 6. 何时才必须主权者重启（以及重启的真实代价）

**当前 dsh-mind host 半区源码改动：不必须重启。** 证据：PID 21092 未变、`--expose-internals` 在、HMR 已启用、profile 是 link 插件、实测同 PID 内已完成模块替换与 Org 重建。

**必须重启的官方判据**（都会以明确原因出现）：

- `host-module`：变更模块在宿主进程入口的静态图里（`loadDependencies(mainJob)`），HMR 标 pending，PluginManager 报 `restart-required`。
- `unmanaged-plugin`：受影响插件没有 Loader entry（例如被其他方式静态挂载）。
- `module-comparison`：本线程没有 ESM `loadCache`（packed worker 等），无法比较/替换。
- `package-moved`：runtime resolution 拒绝发布（包被移动到另一目录/替换了 DSH 安装提供的包），recompose 回退到 `package-moved`。
- `no-hmr`：profile 没有 `profileContext`，或 `hmr` 条目被禁用；此时 PluginManager 直接写 `application:'restart-required', restartReason:'no-hmr'`。
- 缺失 `--expose-internals`：HMR 服务直接抛错（当前不满足）。

**若必须重启（主权者步骤）**：

1. 先取离线新装配证据 + 文件快照（哈希）；记录当前 live `mind status` 的 `引导.代次` / PID。
2. 完全退出 DeepSeek Harness（含托盘/后台进程；`Get-Process` 确认 21092 及子进程消失）。
3. 重新启动，确认新 PID / 新进程代；`mind status` 的 `引导.代次` 应为新代，`孤儿回收` 会按“旧 pid 已死”封存旧实例。
4. Lead 需要按机制重新登记/补充在岗实例（否则旧成员是历史实例，只读/不可写）。**重启不是身份连续方案**；它更换进程代并封存旧代，代价与热重载相同甚至更大。
5. 若最终验收要求“单一代次 + 全部在岗实例同代”，优先做 §5.1 的最小修法并热重载；重启后仍然要重新登记所有在岗实例，不能省。

**结论**：没有发现 dsh-mind 这类改动需要重启的官方阻塞；真正阻塞“无中断且身份连续”的是 §5.1 的产品实现，不是宿主重载能力。

---

## 7. 最终验收操作序（Lead 可直接照做）

0. **冻结写者**：停止其他 agent 对 `dsh-mind` 的并发编辑（当前模块 watcher 把每一次保存都当 live 变更；半成品保存会立刻生效/触发 rollback 或 failed）。先做文件快照（哈希）；跑一次**独立进程**的离线新装配测试（`node test/preflight.mjs` + 目标测试；不要在 live 宿主里假装离线）。
1. **取基线**：同一 GUI 会话调用 `mind status`，记录 `数据.引导.代次.{代,pid,于}`；记录 PID/启动时间；若已有 §4.2 字段，全部记录。
2. **落最终改动**：优先一次成组保存；若接口跨模块变更，确保变更集包含 `src/runtime.js` 或 `src/org.js`/`src/registry.js` 等构建端文件（路径 B 也能拉入 runtime），或确认最后一次保存走的是模块 watcher（路径 A 会自动全闭包）。不要通过改 profile patch/manifest 来“顺手触发”；那会走路径 B。
3. **等重装配完成**：观察 `mind status` 的 `引导.代次` 是否变化；同时用 §4.2 的 kernel/runtime/装配代字段做矩阵判断。若 live 工具暂时不可用（failed），先用文件修正 + 再保存/下一次重装配恢复；路径 B 失败不回滚，路径 A 会回滚。
4. **判据**：按 §4.3 的 1–8 逐条核；第 5 条（多消费者同代）与第 6 条（live 接口）必须全绿。任何“文件改了 / 离线绿 / read 成功”都不替代。
5. **若第 3/4 条红（runtime 未 evict）**：说明走了 reconcile 路径或 watcher 未覆盖。最小修复：在变更集里加一个构建端文件的真实改动并保存（触发路径 A），再验；**不要**起新 server、不要裸 JSON 兼容、不要把 `instance-snapshot.js` 的读成功当升级。
6. **浏览器半区**：若改了 `components/board/lib/client.js`，另走 `pnpm run dev:web` 的开发链路或页面刷新，并按“页面执行层代次标记”验；host 半区的代次不能证明页面已换。
7. **身份连续性**：若验收包含“在岗实例同代”，先按 §5.1 修 `processGeneration` 再重载；否则同 PID 的旧代会继续被判“未判定”，成员的写面可能保持锁死（读桥接只救读）。

---

## 8. 证据索引

- 官方源码读取工具：`dsh-mind/.recovery/asar.mjs`（只读 asar，支持 `list/cat/grep/extract`）。
- 官方源码抽取副本：`dsh-mind/.recovery/asar-out/dsh/node_modules/@deepseek-ai/…`
  - `dsh-hmr/lib/index.js`（含 `Hmr`、`evict`、`partialReload`、`planReplacement`、`stopPlanned`、`reconcileProfile`、`profileRoots`）
  - `dsh-plugin-manager/lib/index.js`（`PluginManager.reload/configure/setPluginEnabled`）
  - `dsh-plugin-manager/lib/types/tools.js`（`plugin_manager` 工具与 danger-full-access 边界）
  - `dsh-client-hmr/lib/index.js`（浏览器半区）
  - `cordis-index.js`（`RegistryService.get` 按 plugin callback 存 runtime）
  - `base-cordis.patch.yml` / `webapp-cordis.patch.yml` / `standard.patch.yml` / `cordis.patch.yml`（entry 禁用/启用）
  - `app-boot-index.js`（`recomposeProfile`）
- 本机运行态证据：`dsh-mind/.recovery/reload-contract-live-evidence-20261018.json`
  - PID 21092、启动 11:41:09、`--expose-internals`、profile link、hmr patch、`mind status` 前后代次、identity boot、审计 seq2261/2274、本成员旧代未判定。
- 相关回归测试（证明混代事故形态已被记录）：`dsh-mind/test/guard-reviewer-readonly-2026-10-18.test.js:243-258`。

---

### 一句话给最终用户

**dsh-mind 的 host 半区改动能在这台机器上无重启局部生效，且实测已经生效；但“新代码 + 旧缓存 Org”只有在走模块 watcher、整个依赖闭包被 evict 时才安全，走 Plugin Manager/patch 的 reconcile 路径只清 stale+importers，会保留旧 Org。最终验收请用同一 URL 的 live `mind status` 读 `引导.代次`（并补 kernel/runtime/装配代与 live 接口身份）来判，不要用文件 hash、npm 绿或成员 read 成功。另有一条独立阻塞：`processGeneration` 是模块作用域，热重载会轮换“进程代”，同 PID 的旧实例会被判“未判定”；要“无中断且所有在岗实例同代”，先修 `src/runtime.js:36-42`（只定位，未改）。**
