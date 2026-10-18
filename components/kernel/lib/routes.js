/**
 * 组件 · 内核的**同源路由**（自注册）。
 *
 * 为什么要有这一层：`/mind` 命令是人在输入框里敲的那条路，而工作台页面与设置页原本走
 * `remote.commands.execute(sessionId, '/mind dashboard')` —— 这条链在官方客户端
 * （0.2.0-rc.2）上**永不返回**：面板停在「读取中」、设置页也写不进去设置
 * （真机证据：私有 `部署.json` 不存在、审计里 0 条「设置变更」——命令压根没到宿主）。
 *
 * 换成宿主自注册的 exact 路由 + 浏览器同源 `fetch`（同机已跑通的第三方插件用的就是这条）。
 * 四条纪律钉在这里：
 *
 *  1. **与命令面同一份 JSON**：响应体就是 `/mind …` 那份 JSON（同一套缩进），
 *     客户端只是换传输层，解析逻辑一个字都不用动；失败也照今天的形状
 *     （`{成功:false, 结果:'拒绝'|'结构不合规', 理由, 要什么授权?, 怎么改?}`）。
 *  2. **只有明确端点，没有通用代理**：只开 `presence`（读/写）、`workbench`（读）、
 *     `ping`（自检）三条。**不许**顺手做成「跑任意 action」的代理 ——
 *     浏览器能碰到的东西，不许比命令面更宽。
 *  3. **无会话也能用**：它是浏览器侧唯一的读/写通路（不再是 `/mind` 命令），所以
 *     不依赖任何会话/agent id，也不依赖 `ctx.get('remote')` 那条链 ——
 *     只依赖 `ctx.get('webServer')`（晚到就轮询等它，拿不到就不让装载失败）。
 *  4. **写路径不冒充主权者**：没有会话主体 ⇒ 账上主体记 `{ id: '设置页', kind: 'Lead' }`，
 *     `依据` 写明「走同源路由的浏览器设置页」，读账的人一眼看得出这条是人从浏览器改的。
 *
 * 处理函数**复用命令面那一条路**（`runAction({ 面: 'command' })`）：策略引擎、merge 写、
 * `withLock`、`atomicWrite`、无条件入账、校验/拒绝口径全部照旧，这里既不复制也不放宽。
 */
import { describeFailure } from '../../../src/kernel/errors.js';
import { runAction } from '../../../lib/actions.js';
// 看板尾长单源（设计评审 #17 · 2026-10-15）：本文件与 kernel/lib/index.js 的「40」
// 都引 src/audit.js 的常量，值不变、出处归一。
import { 看板审计尾条数 } from '../../../src/audit.js';

/** 路由前缀（面板与设置页都按它取数据）。 */
export const 路由前缀 = '/plugins/dsh-mind';

/** 只登记明确端点；调度授权另经宿主认证，不开放任意 action 代理。 */
export const 端点表 = Object.freeze({
  presence: `${路由前缀}/presence`,
  workbench: `${路由前缀}/workbench`,
  ping: `${路由前缀}/ping`,
  delegation: `${路由前缀}/delegation`,
  // v2 条目14/17（2026-10-18 补修F）：介入度待决清单与主权者逐请求决议。
  // 与调度授权同一档：读/写都要求宿主 Connection 认证，不退回无头本机通道。
  intervention: `${路由前缀}/intervention`,
});

/** 组件名（ping 自检与被审计的「谁在服务」都用它）。 */
export const 组件名 = 'dsh-mind-kernel';

/** 路由写路径的主体：它是「设置页」这个入口，不是主权者本人。 */
export function 设置页主体() {
  return { id: '设置页', kind: 'Lead', roleId: 'Lead' };
}

/** 路由写路径的入账依据（写死在动作里会掩盖「这条是浏览器设置页改的」）。 */
export const 设置页依据 = '设置入口：走同源路由的浏览器设置页（/plugins/dsh-mind/presence）';

/** 请求体上限：设置只有两个键，64 KiB 足够；超了不是我们的活儿。 */
const 体上限字节 = 64 * 1024;

/**
 * 等价 `/mind dashboard`：与命令面**同一个投影实现**（`org.workbench` + 同一套切片）。
 * @param {{ org: object, 项目: string, 读者?: object, 审计条数?: number }} spec
 */
export async function 看板包({ org, 项目, 读者, 审计条数 = 看板审计尾条数 }) {
  const view = await org.workbench({ 项目, 审计条数, 读者 });
  return { 成功: true, action: 'workbench', 项目, 数据: view };
}

/**
 * 等价 `/mind presence …`：走**命令面**那条 action 路（不另写一套）。
 * @param {{ org: object, 项目: string, 参数?: object }} spec
 */
export async function presence包({ org, 项目, 参数 = {} }) {
  const 主体 = 设置页主体();
  const result = await runAction({
    org,
    项目,
    subject: 主体,
    主体,
    // `依据` 放在最后：路由面不许自定义它，账上永远看得出这条来自浏览器设置页。
    args: { action: 'presence', ...参数, 依据: 设置页依据 },
    面: 'command',
  });
  return { 成功: true, ...result };
}

// ── HTTP 细节（签名与请求体读法照同机跑通的插件样本）──────────────────────────

/** @param {any} req */
function 取头(req, 名) {
  const headers = (req && req.headers) || {};
  return String(headers[名] ?? '');
}

/**
 * 请求指纹：只取**传输层事实**，供「为什么被拒」写清楚。
 *
 * 为什么要有它（2026-10-13 真机取证）：主权者真机上面板报「跨站读取被拒」，但端点用
 * 带 `sec-fetch-site: same-origin` 的探针**打得通** ⇒ 光看「被拒」两个字定位不了真因
 * （是页面源不同？是 Referer 露了别的源？还是宿主转发时改了 Host？）。传输层拒绝**不入账**
 * （入账会变成 3 秒轮询的洪水），所以把它挂在**拒绝理由**与 **ping 端点**上：
 * 面板那条「未连接」提示会原样显示指纹，刷新一次就能读出真因。
 *
 * ⚠️ 只取这几个传输层头，**一个业务入参都不抄**（理由与 8dt59 同款：传输层诊断不许变成内容泄露面）。
 */
function 请求指纹(req) {
  const 头 = (req && req.headers) || {};
  const 取 = (名) => String(头[名] ?? '') || '（无）';
  return {
    secFetchSite: 取('sec-fetch-site'),
    origin: 取('origin'),
    host: 取('host'),
    referer: 取('referer'),
    // 插件半边自己带的标记头（`x-dsh-mind-panel`）。真机读数（2026-10-13 17:25）：
    // 官方客户端里插件页的请求**不带任何 Fetch Metadata 头**（sec-fetch-site / origin / referer 全无），
    // 与「本机任意进程」在传输层无法区分 ⇒ 被 P1-10 的 fail-closed 整类拒掉。
    // 这个标记头的到位与否，直接回答「自定义头能不能穿过那条通道」——
    // 能穿过，才谈得上把栅栏从「认来源」改成「认凭据」。
    标记: 取('x-dsh-mind-panel'),
  };
}

/** 指纹 → 一行可读串（进拒绝理由；面板会显示它）。 */
function 指纹串(req) {
  const f = 请求指纹(req);
  return 'sec-fetch-site=' + f.secFetchSite + ' · origin=' + f.origin + ' · host=' + f.host
    + (f.referer === '（无）' ? '' : ' · referer=' + f.referer)
    + ' · 插件标记=' + f.标记;
}

/**
 * 最近一次同源拒绝（只留最后一条）。
 *
 * 存下来是为了给**看门人一条自证通路**：面板被拒时它自己看得到理由，
 * 而外部（人和工具）可以打 `GET /plugins/dsh-mind/ping` 读到同一条指纹 —— 不必靠截图传话。
 * 不入账、不落盘：这是**运行态诊断**，不是事实记录（事实记录是审计链，它不收传输层噪声）。
 */
const 最近同源拒绝 = { 于: null, 端点: null, 指纹: null, 期望: null };

/** 记一笔同源拒绝（内存，不落盘）。 */
function 记同源拒绝(端点, req, 期望) {
  最近同源拒绝.于 = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  最近同源拒绝.端点 = 端点;
  最近同源拒绝.指纹 = 请求指纹(req);
  最近同源拒绝.期望 = 期望;
}

/**
 * Host / Origin 是不是回环地址（这个端点只服务本机）。
 * 参数 `origin` 传整条 URL，`host` 传 `host` 头；两者都容忍缺省。
 */
function 源是回环(origin) {
  if (!origin) return true;
  try {
    const h = new URL(origin).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return h === '127.0.0.1' || h === 'localhost' || h === '::1';
  } catch {
    return false;
  }
}
function 宿主是回环(host) {
  const h = String(host || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

/**
 * 本机无头通道开关（2026-10-13 真机取证后的**主权者级权衡**，一行可退）。
 *
 * 事由：P1-10（同日早些时候）把「`sec-fetch-site` 缺席 = 非浏览器 = 拒」写成 fail-closed。
 * 随后真机取证发现：**官方客户端里插件页发出的请求压根不带 Fetch Metadata 头**
 * （指纹实测 `sec-fetch-site=（无）· origin=（无）· referer=（无）`，只剩 `host`）——
 * 那条通道是宿主替页面发的（没有浏览器指纹），于是面板与设置页**整类被拒**：
 * 看板每 3 秒轮询 `Promise.all([workbench, presence])` 全部 403，面板恒「未连接」。
 *
 * 取舍（**如实标注，别读成"已解决"**）：
 *  - 保留：浏览器**明说** `cross-site` / `same-site` ⇒ 一律拒（网页攻击的特征，且页面无法伪造）；
 *    非回环 Host / 非回环 Origin ⇒ 一律拒。
 *  - 接受：缺声明的**本机**请求（宿主代理通道 / 本机进程）放行，但**不再无声**——
 *    计数并进 `ping` 读数（`本机通道`），拒绝理由也带指纹。
 *  - 残余风险：本机任意进程仍可读到投影（它本来也能直接读盘）。这条权衡**属主权者级**，
 *    要收紧就把下面这个常量改 `false`（一行，无需改逻辑）。
 */
const 允许无头本机读 = true;

/** 无头通道计数（内存诊断；进 ping，不落盘不入账——传输层不写事实记录）。 */
const 无头通道 = { 读: 0, 写: 0, 首次于: null, 最近于: null, 最近指纹: null };
function 记无头请求(类, req) {
  const 于 = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  无头通道[类] += 1;
  if (!无头通道.首次于) 无头通道.首次于 = 于;
  无头通道.最近于 = 于;
  无头通道.最近指纹 = 请求指纹(req);
}

/**
 * 读请求栅栏（2026-10-13 改形，见 `允许无头本机读` 的说明）。
 *
 * 判据顺序：**先看浏览器有没有"明说跨站"，再看是不是本机，最后才看缺不缺声明**。
 * 这与 P1-10 的差别只在第三条：P1-10 把「缺声明」直接当敌意；真机证明本机官方客户端
 * 的插件通道正是这个形状 ⇒ 缺声明在本机回环下**放行且计数**，其余照旧一律拒。
 *
 * @returns {{ok: boolean, 为什么?: string}}
 */
function 读栅栏(req) {
  const 站点 = 取头(req, 'sec-fetch-site').toLowerCase();
  if (站点 === 'cross-site' || 站点 === 'same-site') return { ok: false, 为什么: '浏览器声明跨站（sec-fetch-site=' + 站点 + '）' };
  if (站点 && 站点 !== 'same-origin' && 站点 !== 'none') return { ok: false, 为什么: '未知的 sec-fetch-site 取值：' + 站点 };
  if (!宿主是回环(取头(req, 'host'))) return { ok: false, 为什么: 'Host 不是回环地址（这个端点只服务本机）' };
  if (!源是回环(取头(req, 'origin'))) return { ok: false, 为什么: 'Origin 不是回环来源' };
  if (!站点) {
    if (!允许无头本机读) return { ok: false, 为什么: '无 Fetch Metadata 头（本机无头通道已关闭）' };
    记无头请求('读', req);
  }
  return { ok: true };
}

/**
 * 写请求栅栏（同样是改形后的口径，见 `允许无头本机读`）：
 *  - `content-type` 必须是 `application/json`（跨域带这个头必然触发预检）；
 *  - 明说 `cross-site` / `same-site` ⇒ 拒；非回环 Host / Origin ⇒ 拒；
 *  - 缺声明但本机回环 ⇒ 放行且计数（本机客户端写主权者设置本来就要走这条路）。
 *
 * @returns {{ok: boolean, 为什么?: string}}
 */
function 写栅栏(req) {
  if (!取头(req, 'content-type').toLowerCase().startsWith('application/json')) return { ok: false, 为什么: 'content-type 不是 application/json' };
  const 站点 = 取头(req, 'sec-fetch-site').toLowerCase();
  if (站点 === 'cross-site' || 站点 === 'same-site') return { ok: false, 为什么: '浏览器声明跨站（sec-fetch-site=' + 站点 + '）' };
  if (站点 && 站点 !== 'same-origin' && 站点 !== 'none') return { ok: false, 为什么: '未知的 sec-fetch-site 取值：' + 站点 };
  if (!宿主是回环(取头(req, 'host'))) return { ok: false, 为什么: 'Host 不是回环地址' };
  if (!源是回环(取头(req, 'origin'))) return { ok: false, 为什么: 'Origin 不是回环来源' };
  if (!站点) {
    if (!允许无头本机读) return { ok: false, 为什么: '无 Fetch Metadata 头（本机无头通道已关闭）' };
    记无头请求('写', req);
  }
  return { ok: true };
}

/** @param {any} req @returns {Promise<string>} */
async function 读请求体(req) {
  const 块 = [];
  let 长 = 0;
  for await (const 片 of req) {
    长 += 片.length;
    if (长 > 体上限字节) throw new Error('请求体过大');
    块.push(片);
  }
  return Buffer.concat(块).toString('utf8');
}

/** 回一份 JSON：缩进与命令面一致（`JSON.stringify(包, null, 1)`），客户端只换传输层。 */
function 回JSON(res, 状态码, 包) {
  res.writeHead(状态码, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(包, null, 1));
}

/** 传输层拒绝（栅栏 / 方法不对 / body 读不出）：同样是 `{成功:false, …}` 的形状。 */
function 回拒绝(res, 状态码, 理由, 怎么改) {
  回JSON(res, 状态码, { 成功: false, 结果: '拒绝', 规则: '同源栅栏（/plugins/dsh-mind）', 理由, 要什么授权: '主权者', 怎么改 });
}

/** 业务失败：与命令面逐字段同形（`describeFailure` 是同一个）。 */
function 回失败(res, error) {
  回JSON(res, 200, { 成功: false, ...describeFailure(error) });
}

/** 方法不对：405 + 同形状的说明。 */
function 回方法不对(res, 方法, 允许) {
  回JSON(res, 405, {
    成功: false,
    结果: '拒绝',
    规则: '同源路由（/plugins/dsh-mind）',
    理由: `${方法} 不支持：这个端点只接受 ${允许}。`,
    要什么授权: '主权者',
    怎么改: `改用 ${允许}。`,
  });
}

/** 从 query 里取项目键（命令面也允许指定项目 ⇒ 这里不算更宽）。 */
function 取项目(req, 兜底) {
  try {
    const url = new URL(String(req?.url ?? ''), 'http://localhost');
    const 值 = url.searchParams.get('project');
    return 值 && 值.trim() ? 值.trim() : 兜底;
  } catch {
    return 兜底;
  }
}

/** @param {object} org */
function 当前ISO(org) {
  try {
    if (typeof org?.clock?.iso === 'function') return org.clock.iso();
  } catch {
    // 取不到就退回本地时钟，自检端点不许因为时钟坏掉而不可用。
  }
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ── 三条端点 ──────────────────────────────────────────────────────────────────

/**
 * `/plugins/dsh-mind/presence`：GET 读、POST 写（body 只认 `{开关?, 小时?}`）。
 * @param {{ org: object, 项目: string, ctx?: object }} spec
 */
export function presence路由({ org, 项目, ctx }) {
  return async function presence端点(req, res) {
    const 方法 = String(req?.method ?? 'GET').toUpperCase();
    if (方法 === 'GET' || 方法 === 'HEAD') {
      const 判读 = 读栅栏(req);
      if (!判读.ok) {
        记同源拒绝('presence·读', req, 判读.为什么);
        return 回拒绝(res, 403, '读取被拒：' + 判读.为什么 + '。收到：' + 指纹串(req), '从本机页面访问该端点。');
      }
      try {
        回JSON(res, 200, await presence包({ org, 项目 }));
      } catch (error) {
        回失败(res, error);
      }
      return;
    }
    if (方法 === 'POST' || 方法 === 'PUT') {
      const 判写 = 写栅栏(req);
      if (!判写.ok) {
        记同源拒绝('presence·写', req, 判写.为什么);
        return 回拒绝(res, 403, '写入被拒：' + 判写.为什么 + '。收到：' + 指纹串(req), '从本机页面用 fetch 提交 JSON。');
      }
      // P1-06（全面审查 2026-10-17）：读投影的无头本机取舍不自动延伸到**写**。
      // 写失联限制/响应期限是主权者级设置，必须与 delegation 写路由同一套宿主 Connection
      // 认证；认证缺席即不可用，绝不回退到只靠回环 + 缺 Fetch Metadata 的写栅栏。
      const connection = ctx?.get?.('connection');
      if (!connection || typeof connection.requestRejection !== 'function') {
        return 回JSON(res, 503, { 成功: false, 结果: '不可用', 理由: '宿主 Connection 认证不可用；presence 写入口不会退回无认证通道。' });
      }
      const rejection = connection.requestRejection(req);
      if (rejection !== undefined) {
        return 回JSON(res, rejection === 401 ? 401 : 403, { 成功: false, 结果: '拒绝', 理由: '宿主拒绝此请求：presence 写需要已认证的同源浏览器设置入口。' });
      }
      let 原文;
      try {
        原文 = await 读请求体(req);
      } catch (error) {
        回JSON(res, 413, { 成功: false, 结果: '结构不合规', 理由: `请求体读不出来：${error instanceof Error ? error.message : String(error)}`, 缺什么: [] });
        return;
      }
      let 载荷;
      try {
        载荷 = 原文.trim() === '' ? {} : JSON.parse(原文);
      } catch (error) {
        回JSON(res, 400, { 成功: false, 结果: '结构不合规', 理由: `请求体不是合法 JSON：${error instanceof Error ? error.message : String(error)}`, 缺什么: [] });
        return;
      }
      if (!载荷 || typeof 载荷 !== 'object' || Array.isArray(载荷)) {
        回JSON(res, 400, { 成功: false, 结果: '结构不合规', 理由: '请求体必须是一个 JSON 对象，例如 {"小时":168}。', 缺什么: [] });
        return;
      }
      // **只认设置键**：body 里别的字段一律不进 args（否则浏览器这一侧会比命令面更宽）。
      const 参数 = {};
      if (Object.hasOwn(载荷, '开关')) 参数.开关 = 载荷.开关;
      if (Object.hasOwn(载荷, '小时')) 参数.小时 = 载荷.小时;
      // v2 条目14/17：介入度三档 + 复核免审全局开关（与命令面同一份设置入口）。
      if (Object.hasOwn(载荷, '介入度')) 参数.介入度 = 载荷.介入度;
      if (Object.hasOwn(载荷, '复核免审')) 参数.复核免审 = 载荷.复核免审;
      try {
        回JSON(res, 200, await presence包({ org, 项目, 参数 }));
      } catch (error) {
        回失败(res, error);
      }
      return;
    }
    回方法不对(res, 方法, 'GET（读）或 POST（写）');
  };
}

/**
 * `/plugins/dsh-mind/workbench`：GET 看板投影（等价 `/mind dashboard`）。
 * @param {{ org: object, 项目: string }} spec
 */
export function workbench路由({ org, 项目 }) {
  return async function workbench端点(req, res) {
    const 方法 = String(req?.method ?? 'GET').toUpperCase();
    if (方法 !== 'GET' && 方法 !== 'HEAD') return 回方法不对(res, 方法, 'GET');
    const 判读 = 读栅栏(req);
    if (!判读.ok) {
      记同源拒绝('workbench', req, 判读.为什么);
      return 回拒绝(res, 403, '读取被拒：' + 判读.为什么 + '。收到：' + 指纹串(req), '从本机页面访问该端点。');
    }
    try {
      // 读者固定是「设置页」这个 Lead 身份：命令面上根会话（Lead）看到的就是全量投影。
      回JSON(res, 200, await 看板包({ org, 项目: 取项目(req, 项目), 读者: 设置页主体(), 审计条数: 看板审计尾条数 }));
    } catch (error) {
      回失败(res, error);
    }
  };
}

/**
 * `/plugins/dsh-mind/ping`：**通路自检**（浏览器侧拿它做诊断，主人截图就能看到通路状态）。
 * 只回状态，不吃参数、不跑动作 —— 同样不许被当成通用代理。
 *
 * `有webServer` 不许写死为 true：路由挂上只说明**挂的那一刻**webServer 在位，
 * 之后宿主上的服务可能又不在了。自检要如实反映**此刻**取不取得到，读不到就报
 * `webServer未接入`，而不是回一份假绿。
 * @param {{ org: object, ctx?: object }} spec
 */
export function ping路由({ org, ctx }) {
  return async function ping端点(req, res) {
    const 方法 = String(req?.method ?? 'GET').toUpperCase();
    if (方法 !== 'GET' && 方法 !== 'HEAD') return 回方法不对(res, 方法, 'GET');
    const 判ping = 读栅栏(req);
    if (!判ping.ok) {
      记同源拒绝('ping', req, 判ping.为什么);
      return 回拒绝(res, 403, '读取被拒：' + 判ping.为什么 + '。收到：' + 指纹串(req), '从本机页面访问该端点。');
    }
    const ws = ctx ? 取webServer(ctx) : null;
    const 有webServer = Boolean(ws && typeof ws.register === 'function');
    回JSON(res, 200, {
      成功: 有webServer,
      组件: 组件名,
      有webServer,
      ...(有webServer ? {} : { 状态: 'webServer未接入', 说明: '宿主上此刻取不到 webServer 服务；面板/设置页可能空白，诊断见宿主日志。' }),
      // 最近一次被栅栏拒掉的请求 + **本机无头通道**的计数（内存诊断读数，不落盘、不入账）：
      // 面板自己被拒时看不到别人的证据，外部一打 ping 就能读到同一条指纹 —— 诊断不必靠截图传话。
      ...(最近同源拒绝.于 ? { 最近同源拒绝: { ...最近同源拒绝 } } : {}),
      ...(无头通道.读 + 无头通道.写 > 0 ? { 本机通道: { ...无头通道 } } : {}),
      时间: 当前ISO(org),
    });
  };
}

/**
 * `/plugins/dsh-mind/intervention`：GET 读介入度待决清单、POST 落主权者逐请求决议。
 *
 * 三条纪律：
 *  1. **读也不退回无头通道**：清单里有「谁要对什么做什么」，与调度授权同一档，
 *     要求宿主 Connection 认证（比 presence 的只读投影更严——那是公开读数，这是待决事项）。
 *  2. **body 只认三个键**：`{请求id, 决定, 理由}`。任何 subject/kind/role/面 都不进调用；
 *     主权者主体由 `org.intervention` 内部构造（模型参数永远造不出这个身份）。
 *  3. **不代理任意动作**：它只做「读清单 / 落决议」，不跑原写动作；重放由原申请者
 *     带 `审批引用` 发起，审批不能替申请人执行。
 *
 * @param {{ org: object, 项目: string, ctx?: object }} spec
 */
export function intervention路由({ org, 项目, ctx }) {
  return async function intervention端点(req, res) {
    const 方法 = String(req?.method ?? 'GET').toUpperCase();
    if (!['GET', 'POST', 'PUT'].includes(方法)) return 回方法不对(res, 方法, 'GET（读）或 POST（写）');
    // 认证闸前置于同源栅栏：两者都要过，任一缺席即不可用（不退回更宽的通道）。
    const connection = ctx?.get?.('connection');
    if (!connection || typeof connection.requestRejection !== 'function') {
      return 回JSON(res, 503, { 成功: false, 结果: '不可用', 理由: '宿主 Connection 认证不可用；介入审批入口不会退回无认证通道。' });
    }
    const rejection = connection.requestRejection(req);
    if (rejection !== undefined) {
      return 回JSON(res, rejection === 401 ? 401 : 403, { 成功: false, 结果: '拒绝', 理由: '宿主拒绝此请求：介入审批需要已认证的同源浏览器设置入口。' });
    }
    if (方法 === 'GET') {
      const 判读 = 读栅栏(req);
      if (!判读.ok) {
        记同源拒绝('intervention·读', req, 判读.为什么);
        return 回拒绝(res, 403, '读取被拒：' + 判读.为什么 + '。收到：' + 指纹串(req), '从本机页面访问该端点。');
      }
      try {
        回JSON(res, 200, { 成功: true, action: 'intervention', 项目: 取项目(req, 项目), 待决: await org.intervention.人侧待决({ 项目: 取项目(req, 项目) }) });
      } catch (error) {
        回失败(res, error);
      }
      return;
    }
    const 判写 = 写栅栏(req);
    if (!判写.ok) {
      记同源拒绝('intervention·写', req, 判写.为什么);
      return 回拒绝(res, 403, '写入被拒：' + 判写.为什么 + '。收到：' + 指纹串(req), '从本机页面用 fetch 提交 JSON。');
    }
    let 原文;
    try {
      原文 = await 读请求体(req);
    } catch (error) {
      回JSON(res, 413, { 成功: false, 结果: '结构不合规', 理由: `请求体读不出来：${error instanceof Error ? error.message : String(error)}`, 缺什么: [] });
      return;
    }
    let 载荷;
    try {
      载荷 = 原文.trim() === '' ? {} : JSON.parse(原文);
    } catch (error) {
      回JSON(res, 400, { 成功: false, 结果: '结构不合规', 理由: `请求体不是合法 JSON：${error instanceof Error ? error.message : String(error)}`, 缺什么: [] });
      return;
    }
    if (!载荷 || typeof 载荷 !== 'object' || Array.isArray(载荷)) {
      回JSON(res, 400, { 成功: false, 结果: '结构不合规', 理由: '请求体必须是一个 JSON 对象，例如 {"请求id":"…","决定":"批准"}。', 缺什么: [] });
      return;
    }
    // 只认三个键：body 里别的字段一律不进调用（主体由服务内部构造，不接受声明）。
    const 参数 = {};
    if (Object.hasOwn(载荷, '请求id')) 参数.请求id = 载荷.请求id;
    if (Object.hasOwn(载荷, '决定')) 参数.决定 = 载荷.决定;
    if (Object.hasOwn(载荷, '理由')) 参数.理由 = 载荷.理由;
    try {
      回JSON(res, 200, {
        成功: true,
        ...(await org.intervention.人侧决议({
          ...参数,
          通道: '设置页',
          认证: '宿主 Connection 已认证（同源浏览器设置入口）',
          // 不按 query 项目收窄：请求 id 是含项目的指纹，跨项目决议由主权者自己做主。
          项目: null,
        })),
      });
    } catch (error) {
      回失败(res, error);
    }
  };
}

/**
 * 授权设置不沿用允许无头本机请求的 presence 栅栏；宿主认证缺席即不可用。
 * @param {{ctx: object, settings: object}} spec
 * @returns {Function} 只接受 GET/POST 的 exact HTTP handler；写入副作用由正式 ConfigEditor 执行。
 */
export function delegation路由({ ctx, settings }) {
  return async function delegation端点(req, res) {
    const method = String(req.method ?? 'GET').toUpperCase();
    if (!['GET', 'POST'].includes(method)) return 回方法不对(res, method, 'GET（读）或 POST（写）');
    try {
      const connection = ctx.get('connection');
      if (!connection || typeof connection.requestRejection !== 'function' || !settings) {
        return 回JSON(res, 503, { 成功: false, 理由: '宿主 Connection 认证或调度设置服务不可用；不会退回无认证通道。' });
      }
      const rejection = connection.requestRejection(req);
      if (rejection !== undefined) return 回JSON(res, rejection === 401 ? 401 : 403, { 成功: false, 理由: '宿主拒绝此请求：需要已认证的同源浏览器设置入口。' });
      if (method === 'GET') return 回JSON(res, 200, settings.read());
      if (取头(req, 'content-type').split(';')[0].trim().toLowerCase() !== 'application/json') {
        return 回JSON(res, 415, { 成功: false, 理由: '调度设置只接受 application/json。' });
      }
      let body;
      try {
        body = await 读请求体(req);
      } catch {
        return 回JSON(res, 413, { 成功: false, 理由: '请求体读取失败或超过 64 KiB。' });
      }
      let input;
      try {
        input = JSON.parse(body);
      } catch {
        return 回JSON(res, 400, { 成功: false, 理由: '请求体不是合法 JSON。' });
      }
      const result = await settings.save(input);
      回JSON(res, result.status, result.body);
    } catch (error) {
      回JSON(res, 503, { 成功: false, ...describeFailure(error) });
    }
  };
}

// ── 注册（webServer 可能晚于插件激活）────────────────────────────────────────

/** 取 webServer 服务：先 `ctx.get`，再退回 `ctx.webServer`（两种宿主形状都认）。 */
function 取webServer(ctx) {
  let ws = null;
  try {
    ws = typeof ctx?.get === 'function' ? ctx.get('webServer') : null;
  } catch {
    // 取服务抛错不该影响激活
  }
  if (!ws) {
    try {
      ws = ctx?.webServer ?? null;
    } catch {
      // 同上
    }
  }
  return ws;
}

/**
 * 集中持有全部路由 disposer，避免配置自重装时留下重复端点。
 *
 * webServer 可能**晚于插件激活**（`inject=[]` 不等待依赖，加载器不推迟激活）：
 * 照同机跑通的那个插件的做法 —— 每 500ms 试一次，共 20 次；仍拿不到就**静默结束**
 * （插件保持激活，绝不因为 webServer 缺失就装载失败）。
 *
 * 路由 disposer **必须交回** `ctx.effect` 的清理：否则插件重载 / 二次 apply 会撞
 * "duplicate exact route"，激活直接失败。
 *
 * @param {{ ctx: any, org: object, 项目: string, logger?: object, 间隔毫秒?: number, 次数?: number }} spec
 */
export function 挂同源路由(spec) {
  const { ctx, org, 项目, logger = console } = spec;
  const 间隔毫秒 = Number.isFinite(spec.间隔毫秒) ? spec.间隔毫秒 : 500;
  const 次数 = Number.isFinite(spec.次数) ? spec.次数 : 20;

  if (typeof ctx?.effect !== 'function') {
    // 没有 effect 就等于清理器无处交回：如实告警，但不让装载失败。
    logger.warn?.('[dsh-mind] 宿主没有 ctx.effect：同源路由的清理器无处交回（重载可能撞 duplicate exact route）。');
    return undefined;
  }

  return ctx.effect(() => {
    /** @type {Function[]} */
    let 清理器们 = [];
    let 定时器 = null;
    let 试了 = 0;
    let 最近错误 = null;

    const 现在挂 = () => {
      const ws = 取webServer(ctx);
      if (!ws || typeof ws.register !== 'function') return false;
      const 新挂 = [];
      try {
        新挂.push(ws.register({ kind: 'exact', path: 端点表.presence, handler: presence路由({ org, 项目, ctx }) }));
        新挂.push(ws.register({ kind: 'exact', path: 端点表.workbench, handler: workbench路由({ org, 项目 }) }));
        新挂.push(ws.register({ kind: 'exact', path: 端点表.ping, handler: ping路由({ org, ctx }) }));
        新挂.push(ws.register({ kind: 'exact', path: 端点表.delegation, handler: delegation路由({ ctx, settings: spec.调度设置 }) }));
        新挂.push(ws.register({ kind: 'exact', path: 端点表.intervention, handler: intervention路由({ org, 项目, ctx }) }));
      } catch (error) {
        // 挂到一半失败：把已挂的撤掉，别在宿主的注册表里留半个我们。
        for (const 撤 of 新挂) {
          try {
            撤();
          } catch {
            // 撤不掉也没别的办法，如实告警即可
          }
        }
        // 注册失败**不当作「挂完了」**（2026-10-12 评审 P3）：修前 return true 让轮询
        // 立刻停，端点永久缺席、只留一条 warn——面板永远空白而无人知晓。
        // 现在返回 false：继续按预算重试（瞬时冲突会自愈），预算耗尽走下面那条响亮告警。
        最近错误 = error instanceof Error ? error.message : String(error);
        return false;
      }
      清理器们 = 新挂;
      return true;
    };

    const 收尾 = () => {
      if (定时器 !== null) {
        clearInterval(定时器);
        定时器 = null;
      }
      for (const 撤 of 清理器们) {
        try {
          撤();
        } catch {
          // 宿主自己会清理，这里失败不影响卸载
        }
      }
      清理器们 = [];
    };

    if (现在挂()) return 收尾;
    定时器 = setInterval(() => {
      试了 += 1;
      const 挂上了 = 现在挂();
      if (挂上了 || 试了 >= 次数) {
        clearInterval(定时器);
        定时器 = null;
        if (!挂上了) {
          // 不许静默：20 次都拿不到 webServer，等于浏览器半区整个没接线。
          // 影响面说清楚 —— 面板与设置页会一直空白，而插件侧看起来「激活正常」。
          logger.warn?.(
            `[dsh-mind] 同源路由放弃挂载：轮询 ${次数} 次（${间隔毫秒}ms/次）都没挂上。`
            + (最近错误 ? ` 最后一次注册失败：${最近错误}。` : ' 原因：一直没拿到 webServer。')
            + ` 未注册的端点：${端点表.presence}（设置页读写）、${端点表.workbench}（看板投影）、${端点表.ping}（自检）、${端点表.delegation}（调度授权设置）、${端点表.intervention}（介入度待决与决议）。`
            + ` 影响面：工作台面板与设置页将保持空白/读取中，命令面（/mind）不受影响。`,
          );
        }
      }
    }, 间隔毫秒);
    if (typeof 定时器.unref === 'function') 定时器.unref();
    return 收尾;
  }, 'dsh-mind: 同源路由（presence / workbench / ping / delegation / intervention）');
}
