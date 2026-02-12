/**
 * async_hooks shim - lightweight async context tracking for browser/runtime parity
 */

type AsyncHookCallbacks = {
  init?: (asyncId: number, type: string, triggerAsyncId: number, resource: object) => void;
  before?: (asyncId: number) => void;
  after?: (asyncId: number) => void;
  destroy?: (asyncId: number) => void;
};

type AsyncStoreMap = Map<AsyncLocalStorage<unknown>, unknown>;

type AsyncContext = {
  id: number;
  triggerId: number;
  type: string;
  resource: object;
  stores: AsyncStoreMap;
};

const rootContext: AsyncContext = {
  id: 0,
  triggerId: 0,
  type: 'ROOT',
  resource: {},
  stores: new Map(),
};

let currentContext: AsyncContext = rootContext;
let nextAsyncId = 1;

const enabledHooks = new Set<AsyncHookImpl>();

const originalSetTimeout = globalThis.setTimeout.bind(globalThis);
const originalQueueMicrotask = typeof globalThis.queueMicrotask === 'function'
  ? globalThis.queueMicrotask.bind(globalThis)
  : undefined;
const originalPromiseThen = Promise.prototype.then;

let patched = false;

const emitInit = (context: AsyncContext): void => {
  for (const hook of enabledHooks) {
    hook.callbacks.init?.(context.id, context.type, context.triggerId, context.resource);
  }
};

const emitBefore = (asyncId: number): void => {
  for (const hook of enabledHooks) {
    hook.callbacks.before?.(asyncId);
  }
};

const emitAfter = (asyncId: number): void => {
  for (const hook of enabledHooks) {
    hook.callbacks.after?.(asyncId);
  }
};

const emitDestroy = (asyncId: number): void => {
  for (const hook of enabledHooks) {
    hook.callbacks.destroy?.(asyncId);
  }
};

const scheduleDestroy = (asyncId: number): void => {
  if (originalQueueMicrotask) {
    originalQueueMicrotask(() => emitDestroy(asyncId));
    return;
  }
  originalSetTimeout(() => emitDestroy(asyncId), 0);
};

const createContext = (
  type: string,
  resource: object,
  triggerId = currentContext.id
): AsyncContext => {
  const context: AsyncContext = {
    id: nextAsyncId++,
    triggerId,
    type,
    resource,
    stores: new Map(currentContext.stores),
  };
  emitInit(context);
  return context;
};

const runWithContext = <T>(context: AsyncContext, fn: () => T): T => {
  const previous = currentContext;
  currentContext = context;
  emitBefore(context.id);
  try {
    return fn();
  } finally {
    emitAfter(context.id);
    currentContext = previous;
    scheduleDestroy(context.id);
  }
};

const ensurePatched = (): void => {
  if (patched) return;
  patched = true;

  Promise.prototype.then = function patchedThen<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    const parent = currentContext;
    const context = createContext('PROMISE', this as object, parent.id);

    const wrap = <T>(handler?: ((value: unknown) => T | PromiseLike<T>) | null) => {
      if (typeof handler !== 'function') return handler;
      return function wrapped(this: unknown, value: unknown): T | PromiseLike<T> {
        return runWithContext(context, () => handler.call(this, value));
      };
    };

    const nextPromise = originalPromiseThen.call(
      this,
      wrap(onfulfilled) as ((value: unknown) => TResult1 | PromiseLike<TResult1>) | undefined,
      wrap(onrejected) as ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | undefined
    );
    return nextPromise as Promise<TResult1 | TResult2>;
  };

  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    if (typeof handler !== 'function') {
      return originalSetTimeout(handler, timeout, ...args);
    }

    const context = createContext('Timeout', handler as unknown as object, currentContext.id);
    const wrapped = () => runWithContext(context, () => handler(...args));
    return originalSetTimeout(wrapped, timeout);
  }) as typeof setTimeout;

  if (originalQueueMicrotask) {
    globalThis.queueMicrotask = ((callback: VoidFunction) => {
      const context = createContext('Microtask', callback as unknown as object, currentContext.id);
      originalQueueMicrotask(() => {
        runWithContext(context, callback);
      });
    }) as typeof queueMicrotask;
  }
};

export class AsyncResource {
  private context: AsyncContext;

  constructor(type: string, _options?: object) {
    ensurePatched();
    this.context = createContext(type || 'AsyncResource', this, currentContext.id);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runInAsyncScope<T>(fn: (...args: any[]) => T, thisArg?: unknown, ...args: any[]): T {
    return runWithContext(this.context, () => fn.apply(thisArg, args));
  }

  emitDestroy(): this {
    emitDestroy(this.context.id);
    return this;
  }

  asyncId(): number { return this.context.id; }
  triggerAsyncId(): number { return this.context.triggerId; }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static bind<T extends (...args: any[]) => any>(fn: T, _type?: string): T {
    // Preserve identity for compatibility with existing runtime expectations.
    return fn;
  }
}

export class AsyncLocalStorage<T> {
  disable(): void {
    currentContext.stores.delete(this as unknown as AsyncLocalStorage<unknown>);
  }

  getStore(): T | undefined {
    return currentContext.stores.get(this as unknown as AsyncLocalStorage<unknown>) as T | undefined;
  }

  run<R>(store: T, callback: () => R): R {
    ensurePatched();
    const nextStores = new Map(currentContext.stores);
    nextStores.set(this as unknown as AsyncLocalStorage<unknown>, store);
    const previous = currentContext;
    currentContext = { ...currentContext, stores: nextStores };
    let restoreSync = true;
    try {
      const result = callback();
      if (result && typeof (result as unknown as Promise<unknown>).then === 'function') {
        restoreSync = false;
        return (result as unknown as Promise<R>).finally(() => {
          currentContext = previous;
        }) as unknown as R;
      }
      return result;
    } finally {
      if (restoreSync) {
        currentContext = previous;
      }
    }
  }

  exit<R>(callback: () => R): R {
    const nextStores = new Map(currentContext.stores);
    nextStores.delete(this as unknown as AsyncLocalStorage<unknown>);
    const previous = currentContext;
    currentContext = { ...currentContext, stores: nextStores };
    let restoreSync = true;
    try {
      const result = callback();
      if (result && typeof (result as unknown as Promise<unknown>).then === 'function') {
        restoreSync = false;
        return (result as unknown as Promise<R>).finally(() => {
          currentContext = previous;
        }) as unknown as R;
      }
      return result;
    } finally {
      if (restoreSync) {
        currentContext = previous;
      }
    }
  }

  enterWith(store: T): void {
    ensurePatched();
    const nextStores = new Map(currentContext.stores);
    nextStores.set(this as unknown as AsyncLocalStorage<unknown>, store);
    currentContext = { ...currentContext, stores: nextStores };
  }
}

class AsyncHookImpl implements AsyncHook {
  enabled = false;
  callbacks: AsyncHookCallbacks;

  constructor(callbacks: AsyncHookCallbacks) {
    this.callbacks = callbacks;
  }

  enable(): this {
    ensurePatched();
    this.enabled = true;
    enabledHooks.add(this);
    return this;
  }

  disable(): this {
    this.enabled = false;
    enabledHooks.delete(this);
    return this;
  }
}

export interface AsyncHook {
  enable(): this;
  disable(): this;
}

export function createHook(callbacks: AsyncHookCallbacks): AsyncHook {
  return new AsyncHookImpl(callbacks);
}

export function executionAsyncId(): number {
  return currentContext.id;
}

export function executionAsyncResource(): object {
  return currentContext.resource;
}

export function triggerAsyncId(): number {
  return currentContext.triggerId;
}

export default {
  AsyncResource,
  AsyncLocalStorage,
  createHook,
  executionAsyncId,
  executionAsyncResource,
  triggerAsyncId,
};
