import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithRetry } from '../src/npm/fetch';

describe('npm fetch retries', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries transient network errors and eventually succeeds', async () => {
    let attempts = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      attempts++;
      if (attempts === 1) {
        throw new TypeError('fetch failed');
      }
      return new Response('ok', { status: 200 });
    });

    const response = await fetchWithRetry(
      'https://registry.npmjs.org/example',
      undefined,
      { attempts: 2, baseDelayMs: 0, maxDelayMs: 0 }
    );

    expect(attempts).toBe(2);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
  });

  it('retries browser-style "Failed to fetch" errors', async () => {
    let attempts = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      attempts++;
      if (attempts === 1) {
        throw new TypeError('Failed to fetch');
      }
      return new Response('ok', { status: 200 });
    });

    const response = await fetchWithRetry(
      'https://registry.npmjs.org/example',
      undefined,
      { attempts: 2, baseDelayMs: 0, maxDelayMs: 0 }
    );

    expect(attempts).toBe(2);
    expect(response.status).toBe(200);
  });

  it('retries retryable HTTP status codes', async () => {
    let attempts = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      attempts++;
      if (attempts === 1) {
        return new Response('busy', { status: 503 });
      }
      return new Response('ok', { status: 200 });
    });

    const response = await fetchWithRetry(
      'https://registry.npmjs.org/example',
      undefined,
      { attempts: 3, baseDelayMs: 0, maxDelayMs: 0 }
    );

    expect(attempts).toBe(2);
    expect(response.status).toBe(200);
  });

  it('does not retry non-retryable HTTP statuses', async () => {
    let attempts = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      attempts++;
      return new Response('missing', { status: 404 });
    });

    const response = await fetchWithRetry(
      'https://registry.npmjs.org/example',
      undefined,
      { attempts: 3, baseDelayMs: 0, maxDelayMs: 0 }
    );

    expect(attempts).toBe(1);
    expect(response.status).toBe(404);
  });
});
