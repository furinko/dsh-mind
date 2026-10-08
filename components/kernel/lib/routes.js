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

/** 路由前缀（面板与设置页都按它取数据）。 */
export const 路由前缀 = '/plugins/dsh-mind';

/** 明确端点表：注册表里**只许**有这三个（多一个就是通用代理的口子）。 */
export const 端点表 = Object.freeze({
  presence: `${路由前缀}/presence`,
  workbench: `${路由前缀}/workbench`,
  ping: `${路由前缀}/ping`,
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
export async function 看板包({ org, 项目, 读者, 审计条数 = 40 }) {
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

/** Origin 头（若有）必须与请求 Host 完全同源。 */
function 源与宿主同源(origin, host) {
  if (!origin) return true;
  try {
    return new URL(origin).host === String(host || '');
  } catch {
    return false;
  }
}

/** 读请求栅栏：挡掉跨站读取（简单请求即可读，不需要 cookie）。 */
function 同源读请求(req) {
  if (取头(req, 'sec-fetch-site').toLowerCase() === 'cross-site') return false;
  return 源与宿主同源(取头(req, 'origin'), 取头(req, 'host'));
}

/**
 * 写请求栅栏：
 *  - `content-type` 必须是 `application/json` —— 跨域带这个头必然触发预检，预检失败就写不进来；
 *  - `sec-fetch-site`（浏览器自己带、页面无法伪造）只接受 same-origin / none；
 *  - 带 Origin 时必须同源。
 */
function 同源写请求(req) {
  if (!取头(req, 'content-type').toLowerCase().startsWith('application/json')) return false;
  const 站点 = 取头(req, 'sec-fetch-site').toLowerCase();
  if (站点 && 站点 !== 'same-origin' && 站点 !== 'none') return false;
  return 源与宿主同源(取头(req, 'origin'), 取头(req, 'host'));
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
 * @param {{ org: object, 项目: string }} spec
 */
export function presence路由({ org, 项目 }) {
  return async function presence端点(req, res) {
    const 方法 = String(req?.method ?? 'GET').toUpperCase();
    if (方法 === 'GET' || 方法 === 'HEAD') {
      if (!同源读请求(req)) return 回拒绝(res, 403, '跨站读取被拒：这个端点只服务同源页面。', '从本机页面访问该端点。');
      try {
        回JSON(res, 200, await presence包({ org, 项目 }));
      } catch (error) {
        回失败(res, error);
      }
      return;
    }
    if (方法 === 'POST' || 方法 === 'PUT') {
      if (!同源写请求(req)) {
        return 回拒绝(res, 403, '跨站写入被拒：写请求必须同源，且 content-type 为 application/json。', '从本机页面用 fetch 提交 JSON。');
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
      // **只认这两个键**：body 里别的字段一律不进 args（否则浏览器这一侧会比命令面更宽）。
      const 参数 = {};
      if (Object.hasOwn(载荷, '开关')) 参数.开关 = 载荷.开关;
      if (Object.hasOwn(载荷, '小时')) 参数.小时 = 载荷.小时;
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
    if (!同源读请求(req)) return 回拒绝(res, 403, '跨站读取被拒：这个端点只服务同源页面。', '从本机页面访问该端点。');
    try {
      // 读者固定是「设置页」这个 Lead 身份：命令面上根会话（Lead）看到的就是全量投影。
      回JSON(res, 200, await 看板包({ org, 项目: 取项目(req, 项目), 读者: 设置页主体(), 审计条数: 40 }));
    } catch (error) {
      回失败(res, error);
    }
  };
}

/**
 * `/plugins/dsh-mind/ping`：**通路自检**（浏览器侧拿它做诊断，主人截图就能看到通路状态）。
 * 只回状态，不吃参数、不跑动作 —— 同样不许被当成通用代理。
 * @param {{ org: object }} spec
 */
export function ping路由({ org }) {
  return async function ping端点(req, res) {
    const 方法 = String(req?.method ?? 'GET').toUpperCase();
    if (方法 !== 'GET' && 方法 !== 'HEAD') return 回方法不对(res, 方法, 'GET');
    if (!同源读请求(req)) return 回拒绝(res, 403, '跨站读取被拒：这个端点只服务同源页面。', '从本机页面访问该端点。');
    回JSON(res, 200, { 成功: true, 组件: 组件名, 有webServer: true, 时间: 当前ISO(org) });
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
 * 把三条路由挂到宿主上。
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

    const 现在挂 = () => {
      const ws = 取webServer(ctx);
      if (!ws || typeof ws.register !== 'function') return false;
      const 新挂 = [];
      try {
        新挂.push(ws.register({ kind: 'exact', path: 端点表.presence, handler: presence路由({ org, 项目 }) }));
        新挂.push(ws.register({ kind: 'exact', path: 端点表.workbench, handler: workbench路由({ org, 项目 }) }));
        新挂.push(ws.register({ kind: 'exact', path: 端点表.ping, handler: ping路由({ org }) }));
      } catch (error) {
        // 挂到一半失败：把已挂的撤掉，别在宿主的注册表里留半个我们。
        for (const 撤 of 新挂) {
          try {
            撤();
          } catch {
            // 撤不掉也没别的办法，如实告警即可
          }
        }
        logger.warn?.(`[dsh-mind] 注册同源路由失败：${error instanceof Error ? error.message : String(error)}`);
        return true; // webServer 在位，只是这次注册没成 —— 不再轮询
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
      if (现在挂() || 试了 >= 次数) {
        clearInterval(定时器);
        定时器 = null;
      }
    }, 间隔毫秒);
    if (typeof 定时器.unref === 'function') 定时器.unref();
    return 收尾;
  }, 'dsh-mind: 同源路由（presence / workbench / ping）');
}
