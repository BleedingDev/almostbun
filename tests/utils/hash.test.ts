import { describe, it, expect } from 'vitest';
import { hashBytes, simpleHash } from '../../src/utils/hash';

describe('simpleHash', () => {
  it('should return a string', () => {
    const result = simpleHash('test');
    expect(typeof result).toBe('string');
  });

  it('should return consistent results for same input', () => {
    const input = 'hello world';
    const hash1 = simpleHash(input);
    const hash2 = simpleHash(input);
    expect(hash1).toBe(hash2);
  });

  it('should return different results for different inputs', () => {
    const hash1 = simpleHash('hello');
    const hash2 = simpleHash('world');
    expect(hash1).not.toBe(hash2);
  });

  it('should handle empty string', () => {
    const result = simpleHash('');
    expect(result).toBe('0');
  });

  it('should handle long strings', () => {
    const longString = 'a'.repeat(10000);
    const result = simpleHash(longString);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('should handle unicode characters', () => {
    const result = simpleHash('こんにちは世界');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('should handle special characters', () => {
    const result = simpleHash('!@#$%^&*()_+-=[]{}|;:,.<>?');
    expect(typeof result).toBe('string');
  });

  it('should produce different hashes for similar strings', () => {
    const hash1 = simpleHash('test1');
    const hash2 = simpleHash('test2');
    expect(hash1).not.toBe(hash2);
  });

  it('should return base36 encoded string', () => {
    const result = simpleHash('test');
    // Base36 only contains 0-9 and a-z (or negative sign)
    expect(result).toMatch(/^-?[0-9a-z]+$/);
  });
});

describe('hashBytes', () => {
  it('returns deterministic hash for byte arrays', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    expect(hashBytes(bytes)).toBe(hashBytes(bytes));
  });

  it('distinguishes different byte arrays', () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 4]);
    expect(hashBytes(a)).not.toBe(hashBytes(b));
  });

  it('accepts ArrayBuffer inputs', () => {
    const bytes = new Uint8Array([9, 8, 7]);
    expect(hashBytes(bytes.buffer)).toBe(hashBytes(bytes));
  });
});
