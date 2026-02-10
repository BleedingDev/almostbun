/**
 * bun:test shim
 *
 * Bridges to test globals when available (Vitest/Jest-like env),
 * with lightweight fallbacks for runtime compatibility.
 */

type AnyFn = (...args: any[]) => any;

type TestFn = (name: string, fn?: AnyFn, timeout?: number) => unknown;
type HookFn = (fn: AnyFn, timeout?: number) => unknown;
type DescribeFn = (name: string, fn: AnyFn) => unknown;

const globalAny = globalThis as Record<string, any>;

function fallbackDeepEqual(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return Object.is(a, b);
  }
}

function fallbackExpect(received: unknown) {
  return {
    toBe(expected: unknown) {
      if (!Object.is(received, expected)) {
        throw new Error(`Expected ${String(received)} to be ${String(expected)}`);
      }
    },

    toEqual(expected: unknown) {
      if (!fallbackDeepEqual(received, expected)) {
        throw new Error('Expected values to be deeply equal');
      }
    },

    toMatch(expected: RegExp | string) {
      const value = String(received);
      const passed = typeof expected === 'string' ? value.includes(expected) : expected.test(value);
      if (!passed) {
        throw new Error(`Expected ${value} to match ${String(expected)}`);
      }
    },

    toBeTruthy() {
      if (!received) {
        throw new Error(`Expected ${String(received)} to be truthy`);
      }
    },

    toBeFalsy() {
      if (received) {
        throw new Error(`Expected ${String(received)} to be falsy`);
      }
    },
  };
}

function makeTest(globalName: string): TestFn {
  const candidate = globalAny[globalName];
  if (typeof candidate === 'function') {
    return candidate.bind(globalAny) as TestFn;
  }

  return (name: string, fn?: AnyFn) => {
    if (!fn) return;
    try {
      return fn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${globalName}('${name}') failed: ${message}`);
    }
  };
}

function makeHook(globalName: string): HookFn {
  const candidate = globalAny[globalName];
  if (typeof candidate === 'function') {
    return candidate.bind(globalAny) as HookFn;
  }

  return (fn: AnyFn) => fn();
}

function makeDescribe(globalName: string): DescribeFn {
  const candidate = globalAny[globalName];
  if (typeof candidate === 'function') {
    return candidate.bind(globalAny) as DescribeFn;
  }

  return (_name: string, fn: AnyFn) => fn();
}

function createMockUtilities() {
  const viLike = globalAny.vi;
  if (viLike && typeof viLike === 'object') {
    return viLike;
  }

  return {
    fn(impl?: AnyFn) {
      const calls: unknown[][] = [];

      const mockFn = (...args: unknown[]) => {
        calls.push(args);
        if (impl) {
          return impl(...args);
        }
        return undefined;
      };

      Object.defineProperty(mockFn, 'mock', {
        value: { calls },
        enumerable: true,
      });

      return mockFn;
    },
    mock: () => {},
    unmock: () => {},
    restoreAllMocks: () => {},
    clearAllMocks: () => {},
    resetAllMocks: () => {},
  };
}

export const test = makeTest('test');
export const it = makeTest('it');
export const describe = makeDescribe('describe');

export const beforeAll = makeHook('beforeAll');
export const afterAll = makeHook('afterAll');
export const beforeEach = makeHook('beforeEach');
export const afterEach = makeHook('afterEach');

export const expect = (typeof globalAny.expect === 'function'
  ? globalAny.expect.bind(globalAny)
  : fallbackExpect) as (value: unknown) => ReturnType<typeof fallbackExpect>;

export const mock = createMockUtilities();
export const vi = mock;

export default {
  test,
  it,
  describe,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  expect,
  mock,
  vi,
};
