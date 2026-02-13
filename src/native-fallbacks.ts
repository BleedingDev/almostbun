export interface NativeFallbackDescriptor {
  packageName: string;
  fallbackModuleId: string;
  reason: string;
}

export interface NativePackageSupport {
  packageName: string;
  kind: 'fallback' | 'unsupported';
  fallbackModuleId?: string;
  note: string;
}

const NATIVE_FALLBACKS = new Map<string, NativeFallbackDescriptor>([
  [
    'sqlite3',
    {
      packageName: 'sqlite3',
      fallbackModuleId: 'sqlite3',
      reason: 'Uses native bindings in Node; browser runtime uses Bun-compatible sqlite shim.',
    },
  ],
  [
    'better-sqlite3',
    {
      packageName: 'better-sqlite3',
      fallbackModuleId: 'better-sqlite3',
      reason: 'Uses native bindings in Node; browser runtime uses Bun-compatible sqlite shim.',
    },
  ],
]);

const UNSUPPORTED_NATIVE_PACKAGES = new Map<string, string>([
  ['sharp', 'Requires native libvips bindings not available in browser-only runtime.'],
  ['canvas', 'Requires native Cairo bindings not available in browser-only runtime.'],
  ['argon2', 'Requires native hashing bindings not available in browser-only runtime.'],
  ['bcrypt', 'Requires native bindings (use bcryptjs in browser).'],
  ['keytar', 'Requires OS keychain native bindings unavailable in browser runtime.'],
  ['@parcel/watcher', 'Requires native filesystem watcher bindings unavailable in browser runtime.'],
  ['lmdb', 'Requires native storage bindings unavailable in browser runtime.'],
]);

function getPackageNameFromSpecifier(specifier: string): string | null {
  if (
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('node:') ||
    specifier.startsWith('bun:')
  ) {
    return null;
  }

  const normalized = specifier.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) {
    return null;
  }

  // Fallback shims should only apply to bare package imports.
  // Keep subpath imports (e.g. sqlite3/package.json) on normal resolution.
  if (parts[0].startsWith('@')) {
    if (parts.length !== 2) {
      return null;
    }
    return `${parts[0]}/${parts[1]}`;
  }

  if (parts.length !== 1) {
    return null;
  }

  return parts[0];
}

export function getNativeFallbackForSpecifier(specifier: string): NativeFallbackDescriptor | null {
  const packageName = getPackageNameFromSpecifier(specifier);
  if (!packageName) {
    return null;
  }
  return NATIVE_FALLBACKS.get(packageName) ?? null;
}

export function getPackageNameFromNodeModulesPath(resolvedPath: string): string | null {
  const marker = '/node_modules/';
  const index = resolvedPath.lastIndexOf(marker);
  if (index < 0) {
    return null;
  }

  const rest = resolvedPath.slice(index + marker.length);
  const parts = rest.split('/').filter(Boolean);
  if (parts.length === 0) {
    return null;
  }

  if (parts[0].startsWith('@') && parts.length > 1) {
    return `${parts[0]}/${parts[1]}`;
  }

  return parts[0];
}

export function getNativeFallbackForResolvedPath(
  resolvedPath: string
): NativeFallbackDescriptor | null {
  const packageName = getPackageNameFromNodeModulesPath(resolvedPath);
  if (!packageName) {
    return null;
  }
  return NATIVE_FALLBACKS.get(packageName) ?? null;
}

export function getNativePackageSupport(packageName: string): NativePackageSupport | null {
  const fallback = NATIVE_FALLBACKS.get(packageName);
  if (fallback) {
    return {
      packageName,
      kind: 'fallback',
      fallbackModuleId: fallback.fallbackModuleId,
      note: fallback.reason,
    };
  }

  const unsupportedReason = UNSUPPORTED_NATIVE_PACKAGES.get(packageName);
  if (unsupportedReason) {
    return {
      packageName,
      kind: 'unsupported',
      note: unsupportedReason,
    };
  }

  return null;
}
