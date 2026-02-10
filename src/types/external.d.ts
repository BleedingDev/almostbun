/**
 * Type declarations for CDN-loaded modules
 */

// Type declarations for esbuild-wasm to support dynamic import from CDN
interface EsbuildTransformOptions {
  loader?: string;
  jsx?: string;
  jsxFactory?: string;
  jsxFragment?: string;
  jsxImportSource?: string;
  sourcemap?: boolean | 'inline' | 'external' | 'both';
  sourcefile?: string;
  target?: string | string[];
  format?: 'iife' | 'cjs' | 'esm';
  minify?: boolean;
  tsconfigRaw?: string | object;
  platform?: 'browser' | 'node' | 'neutral';
  define?: Record<string, string>;
}

interface EsbuildTransformResult {
  code: string;
  map: string;
  warnings: unknown[];
}

// Declare the esbuild-wasm module for type-only imports
declare module 'esbuild-wasm' {
  export function initialize(options?: { wasmURL?: string; worker?: boolean }): Promise<void>;
  export function transform(input: string, options?: EsbuildTransformOptions): Promise<EsbuildTransformResult>;
  export function build(options: unknown): Promise<unknown>;
  export function formatMessages(messages: unknown[], options: unknown): Promise<string[]>;
  export const version: string;
}

declare module 'https://esm.sh/esbuild-wasm@0.20.0' {
  export function initialize(options?: { wasmURL?: string; worker?: boolean }): Promise<void>;
  export function transform(input: string, options?: EsbuildTransformOptions): Promise<EsbuildTransformResult>;
  export function build(options: unknown): Promise<unknown>;
  export function formatMessages(messages: unknown[], options: unknown): Promise<string[]>;
  export const version: string;
}

declare module 'https://unpkg.com/esbuild-wasm@0.20.0/esm/browser.min.js' {
  export function initialize(options?: { wasmURL?: string; worker?: boolean }): Promise<void>;
  export function transform(input: string, options?: EsbuildTransformOptions): Promise<EsbuildTransformResult>;
  export function build(options: unknown): Promise<unknown>;
  export function formatMessages(messages: unknown[], options: unknown): Promise<string[]>;
  export const version: string;
}

declare module 'https://esm.sh/@vue/compiler-sfc@3.5.28' {
  const compilerSfc: any;
  export default compilerSfc;
}

declare module 'https://esm.sh/svelte@5.39.6/compiler' {
  const svelteCompiler: any;
  export default svelteCompiler;
}

// Rollup browser module
declare module 'https://esm.sh/@rollup/browser@4.9.0' {
  export function rollup(options: unknown): Promise<{
    generate(outputOptions: unknown): Promise<{ output: unknown[] }>;
    write(outputOptions: unknown): Promise<{ output: unknown[] }>;
    close(): Promise<void>;
  }>;
  export const VERSION: string;
}

// Bun runtime modules (browser shims)
declare module 'bun' {
  const bun: any;
  export = bun;
}

declare module 'bun:sqlite' {
  export const Database: any;
  export const Statement: any;
  export const constants: Record<string, number>;
  const defaultExport: {
    Database: any;
    Statement: any;
    constants: Record<string, number>;
  };
  export default defaultExport;
}

declare module 'bun:test' {
  export const test: any;
  export const it: any;
  export const describe: any;
  export const beforeAll: any;
  export const afterAll: any;
  export const beforeEach: any;
  export const afterEach: any;
  export const expect: any;
  export const mock: any;
  export const vi: any;
  const defaultExport: Record<string, any>;
  export default defaultExport;
}

declare module 'bun:ffi' {
  export const suffix: string;
  export const FFIType: Record<string, number>;
  export const dlopen: (...args: any[]) => never;
  export const linkSymbols: (...args: any[]) => never;
  export const CString: (...args: any[]) => never;
  export const ptr: (...args: any[]) => never;
  export const toArrayBuffer: (...args: any[]) => never;
  export const JSCallback: (...args: any[]) => never;
  export const cc: (...args: any[]) => never;
  const defaultExport: Record<string, any>;
  export default defaultExport;
}

declare module 'bun:jsc' {
  export const gcAndSweep: () => void;
  export const heapStats: () => Record<string, number>;
  export const memoryUsage: () => Record<string, number>;
  export const serialize: (value: unknown) => Uint8Array;
  export const deserialize: <T = unknown>(data: Uint8Array) => T;
  export const setTimeZone: (timezone: string) => void;
  const defaultExport: Record<string, any>;
  export default defaultExport;
}

// Centralized Window interface augmentation for esbuild
interface Window {
  __esbuild?: typeof import('esbuild-wasm');
  __esbuildInitPromise?: Promise<void>;
}
