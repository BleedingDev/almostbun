/**
 * Simple hash function for content-based cache invalidation.
 * Uses djb2-style hashing for fast string hashing.
 */
export function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString(36);
}

/**
 * Hash binary payloads using the same djb2-style algorithm as simpleHash.
 */
export function hashBytes(input: Uint8Array | ArrayBuffer): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let hash = 0;
  for (let i = 0; i < bytes.length; i++) {
    hash = ((hash << 5) - hash) + bytes[i]!;
    hash |= 0;
  }
  return hash.toString(36);
}
