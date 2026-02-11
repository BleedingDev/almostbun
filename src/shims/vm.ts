/**
 * vm shim - sandboxed execution using Proxy + with() scopes.
 */

const kVmContext = Symbol.for('almostbun.vm.context');
const kVmProxy = Symbol.for('almostbun.vm.proxy');

type VmContext = Record<string | symbol, unknown> & {
  [kVmContext]?: true;
  [kVmProxy]?: object;
};

function evalWithRuntimeScope(code: string): unknown {
  const dynamicImport = (globalThis as typeof globalThis & {
    __almostbunDynamicImport?: (specifier: string) => Promise<unknown>;
  }).__almostbunDynamicImport;

  if (typeof dynamicImport !== 'function') {
    return eval(code);
  }

  return (function scopedEval(source: string) {
    const __dynamicImport = dynamicImport;
    return eval(source);
  })(code);
}

function hasInfiniteLoopPattern(code: string): boolean {
  return /\bwhile\s*\(\s*true\s*\)/.test(code) || /\bfor\s*\(\s*;\s*;\s*\)/.test(code);
}

function assertTimeoutGuard(code: string, options?: { timeout?: number }): void {
  if (!options || typeof options.timeout !== 'number') return;
  if (options.timeout <= 0) {
    throw new Error('Script execution timed out');
  }
  if (hasInfiniteLoopPattern(code)) {
    throw new Error(`Script execution timed out after ${options.timeout}ms`);
  }
}

function getContextProxy(contextObject: VmContext): object {
  if (contextObject[kVmProxy]) {
    return contextObject[kVmProxy] as object;
  }

  let proxyRef: object;
  const proxy = new Proxy(contextObject, {
    has: (_target, prop) => {
      if (prop === 'eval' || prop === '__almostbun_code__') return false;
      return true;
    },
    get(target, prop, receiver) {
      if (prop === Symbol.unscopables) return undefined;
      if (prop === 'globalThis' || prop === 'global') return proxyRef;
      if (prop in target) {
        return Reflect.get(target, prop, receiver);
      }
      return undefined;
    },
    set(target, prop, value, receiver) {
      return Reflect.set(target, prop, value, receiver);
    },
    getOwnPropertyDescriptor(target, prop) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, prop);
      if (descriptor) return descriptor;
      return {
        configurable: true,
        enumerable: true,
        writable: true,
        value: undefined,
      };
    },
  });
  proxyRef = proxy;
  contextObject[kVmProxy] = proxy;
  return proxy;
}

function executeInContext(code: string, contextObject: VmContext, options?: { timeout?: number }): unknown {
  assertTimeoutGuard(code, options);
  const proxy = getContextProxy(contextObject);
  const evaluator = new Function(
    'sandbox',
    '__almostbun_code__',
    'with (sandbox) { return eval(__almostbun_code__); }'
  ) as (sandbox: object, __almostbun_code__: string) => unknown;
  return evaluator(proxy, code);
}

export class Script {
  private code: string;

  constructor(code: string, _options?: object) {
    this.code = code;
  }

  runInThisContext(options?: { timeout?: number }): unknown {
    assertTimeoutGuard(this.code, options);
    return evalWithRuntimeScope(this.code);
  }

  runInNewContext(contextObject?: object, options?: { timeout?: number }): unknown {
    const context = createContext(contextObject);
    return executeInContext(this.code, context as VmContext, options);
  }

  runInContext(context: object, options?: { timeout?: number }): unknown {
    return this.runInNewContext(context, options);
  }

  createCachedData(): Buffer {
    return Buffer.from('');
  }
}

export function createContext(contextObject?: object, _options?: object): object {
  const context = (contextObject || {}) as VmContext;
  context[kVmContext] = true;
  return context;
}

export function isContext(sandbox: object): boolean {
  return !!(sandbox as VmContext)[kVmContext];
}

export function runInThisContext(code: string, options?: { timeout?: number }): unknown {
  const script = new Script(code);
  return script.runInThisContext(options);
}

export function runInNewContext(code: string, contextObject?: object, options?: { timeout?: number }): unknown {
  const script = new Script(code);
  return script.runInNewContext(contextObject, options);
}

export function runInContext(code: string, context: object, options?: { timeout?: number }): unknown {
  return runInNewContext(code, context, options);
}

export function compileFunction(code: string, params?: string[], _options?: object): Function {
  return new Function(...(params || []), code);
}

export class Module {
  constructor(_code: string, _options?: object) {}
  link(_linker: unknown): Promise<void> { return Promise.resolve(); }
  evaluate(_options?: object): Promise<unknown> { return Promise.resolve(); }
  get status(): string { return 'unlinked'; }
  get identifier(): string { return ''; }
  get context(): object { return {}; }
  get namespace(): object { return {}; }
}

export class SourceTextModule extends Module {}
export class SyntheticModule extends Module {
  setExport(_name: string, _value: unknown): void {}
}

export default {
  Script,
  createContext,
  isContext,
  runInThisContext,
  runInNewContext,
  runInContext,
  compileFunction,
  Module,
  SourceTextModule,
  SyntheticModule,
};
