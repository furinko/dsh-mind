/**
 * 宿主半区的假宿主。
 *
 * 为什么需要它：真实宿主只在重启后才会加载插件，而「重启一次才知道行不行」
 * 对于会拖垮整个 profile 的插件是不可接受的验证节奏。
 * 这个假宿主把 `apply` 需要的服务面（tools / commands / systemPrompt / events / effect）
 * 按文档形状搭出来，于是插件的装配路径、工具 schema、闸的行为都能在进程内被断言。
 */

/**
 * 造一个假 ctx。
 *
 * @param {{ 提供服务?: string[] }} [options]
 * @returns {{ ctx: any, 工具: Map<string, any>, 命令: Map<string, any>, 段落: any[], 闸: Function[], 钩子: Map<string, Function[]>, 日志: string[], 触发(event: string, ...args: any[]): void, 清理(): void }}
 */
export function fakeHost(options = {}) {
  const 服务 = new Set(options.提供服务 ?? ['tools', 'commands', 'systemPrompt']);
  const 工具 = new Map();
  const 命令 = new Map();
  const 段落 = [];
  const 闸 = [];
  const 钩子 = new Map();
  const 日志 = [];
  const 清理器 = [];

  const logger = {
    info: (msg) => 日志.push(`info: ${msg}`),
    warn: (msg) => 日志.push(`warn: ${msg}`),
    error: (msg) => 日志.push(`error: ${msg}`),
  };

  const ctx = {
    logger,
    get(name) {
      return 服务.has(name) ? 服务面[name] : undefined;
    },
    inject(names, callback) {
      if (!names.every((n) => 服务.has(n))) return undefined;
      return callback(服务面);
    },
    on(event, listener) {
      const list = 钩子.get(event) ?? [];
      list.push(listener);
      钩子.set(event, list);
      return () => {
        const current = 钩子.get(event) ?? [];
        钩子.set(event, current.filter((l) => l !== listener));
      };
    },
    effect(fn) {
      const disposer = fn();
      清理器.push(disposer);
      return disposer;
    },
    emit(event, ...args) {
      for (const listener of 钩子.get(event) ?? []) listener(...args);
    },
  };

  const 服务面 = {
    tools: {
      register(definition) {
        if (!definition?.name) throw new Error('tool needs a name');
        if (工具.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`);
        // 复刻真实 register 的硬校验：output {schema, render} 必填。
        if (!definition.output || typeof definition.output.render !== 'function') {
          throw new TypeError(`tool "${definition.name}" must declare output { schema, render }`);
        }
        工具.set(definition.name, definition);
        return () => 工具.delete(definition.name);
      },
      guard(fn) {
        闸.push(fn);
        return () => 闸.splice(闸.indexOf(fn), 1);
      },
    },
    commands: {
      register(definition) {
        if (!definition?.name) throw new Error('command needs a name');
        命令.set(definition.name, definition);
        return () => 命令.delete(definition.name);
      },
    },
    systemPrompt: {
      section(definition) {
        段落.push(definition);
        return () => 段落.splice(段落.indexOf(definition), 1);
      },
    },
  };

  // cordis 的服务既可用 `ctx.get(name)` 取，也直接挂在 `ctx.<name>` 上；
  // 假宿主必须同时提供两种形状，否则测出的装配路径与真实宿主不一致。
  Object.assign(ctx, 服务面);

  return {
    ctx,
    工具,
    命令,
    段落,
    闸,
    钩子,
    日志,
    触发(event, ...args) {
      for (const listener of 钩子.get(event) ?? []) listener(...args);
    },
    清理() {
      for (const disposer of 清理器.reverse()) {
        try {
          disposer?.();
        } catch {
          // 清理失败不影响断言
        }
      }
    },
  };
}

/**
 * 造一个假的工具执行上下文。
 * @param {{ name: string, callId?: string, sessionId?: string }} spec
 */
export function fakeExec(spec) {
  return {
    name: spec.name,
    callId: spec.callId ?? `call-${Math.random().toString(36).slice(2, 8)}`,
    agent: { session: { id: spec.sessionId ?? 'session-test-0001', header: { cwd: process.cwd() } } },
  };
}
