/**
 * bun:ffi shim
 *
 * Native FFI is unavailable in browser runtime.
 * We keep API shape so modules can load and feature-detect gracefully.
 */

function notSupported(api: string): never {
  throw new Error(`bun:ffi ${api} is not available in browser runtime`);
}

export const suffix = '.browser';

export const FFIType = {
  void: 0,
  bool: 1,
  i8: 2,
  u8: 3,
  i16: 4,
  u16: 5,
  i32: 6,
  u32: 7,
  i64: 8,
  u64: 9,
  f32: 10,
  f64: 11,
  ptr: 12,
  cstring: 13,
} as const;

export type FFIFunctionSignature = {
  args?: unknown[];
  returns?: unknown;
  nonblocking?: boolean;
};

export function dlopen(_library: string, _symbols: Record<string, FFIFunctionSignature>) {
  return notSupported('dlopen()');
}

export function linkSymbols(_symbols: Record<string, FFIFunctionSignature>) {
  return notSupported('linkSymbols()');
}

export function CString(_pointer: unknown): string {
  return notSupported('CString()');
}

export function ptr(_value: unknown): number {
  return notSupported('ptr()');
}

export function toArrayBuffer(_pointer: unknown, _offset?: number, _length?: number): ArrayBuffer {
  return notSupported('toArrayBuffer()');
}

export function JSCallback(_fn: (...args: unknown[]) => unknown, _options?: unknown): unknown {
  return notSupported('JSCallback()');
}

export function cc(_source: string, _options?: unknown): unknown {
  return notSupported('cc()');
}

export default {
  suffix,
  FFIType,
  dlopen,
  linkSymbols,
  CString,
  ptr,
  toArrayBuffer,
  JSCallback,
  cc,
};
