/**
 * Node.js `wasi` module shim.
 *
 * Re-export WASI from @tybys/wasm-util, which provides a browser-compatible
 * WASI implementation used by napi-rs wasm runtimes.
 */

import { WASI as PolyfillWASI } from '@tybys/wasm-util';

type WasiOptions = {
  version?: 'unstable' | 'preview1';
  args?: string[];
  env?: Record<string, string | undefined>;
  preopens?: Record<string, string>;
  fs?: unknown;
  print?: (text: string) => void;
  printErr?: (text: string) => void;
  returnOnExit?: boolean;
};

type RuntimeGlobalWithFs = typeof globalThis & {
  __almostbunFsShim?: unknown;
};

export class WASI extends PolyfillWASI {
  constructor(options: WasiOptions = {}) {
    const runtimeGlobal = globalThis as RuntimeGlobalWithFs;
    const fs = options.fs ?? runtimeGlobal.__almostbunFsShim;
    const hasPreopens = !!options.preopens && Object.keys(options.preopens).length > 0;

    // Node's WASI preopens map real host directories. In this browser runtime
    // we operate on a virtual FS, so preopens are disabled to avoid host-fs
    // assumptions made by Node-oriented loaders.
    const normalized: WasiOptions = hasPreopens
      ? { ...options, preopens: {} }
      : { ...options };

    if (fs && normalized.fs === undefined) {
      normalized.fs = fs;
    }

    super(normalized as ConstructorParameters<typeof PolyfillWASI>[0]);
  }
}

export default {
  WASI,
};
