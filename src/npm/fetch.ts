/**
 * Resilient fetch helpers for npm/registry/tarball downloads.
 */

export interface FetchWithRetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (attempt: number, reason: string) => void;
}

const DEFAULT_ATTEMPTS = 4;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  return (error as { code?: string }).code;
}

function isRetryableNetworkError(error: unknown): boolean {
  if (!error) return false;

  const code = errorCode(error);
  if (
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'ECONNRESET' ||
    code === 'ECONNABORTED' ||
    code === 'ENOTFOUND' ||
    code === 'ETIMEDOUT'
  ) {
    return true;
  }

  const message = String((error as { message?: unknown }).message || error).toLowerCase();
  return (
    message.includes('networkerror') ||
    message.includes('timed out') ||
    message.includes('connect timeout') ||
    message.includes('fetch failed') ||
    message.includes('failed to fetch')
  );
}

function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  if (baseDelayMs <= 0 && maxDelayMs <= 0) {
    return 0;
  }
  const exponential = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
  const jitterWindow = Math.max(1, Math.floor(baseDelayMs / 2));
  const jitter = Math.floor(Math.random() * jitterWindow);
  return exponential + jitter;
}

/**
 * Fetch with retry for transient transport and gateway issues.
 */
export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  options: FetchWithRetryOptions = {}
): Promise<Response> {
  const attempts = Math.max(1, options.attempts || DEFAULT_ATTEMPTS);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);

  let lastError: unknown;
  let lastResponse: Response | undefined;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(input, init);
      if (!response.ok && isRetryableStatus(response.status) && attempt < attempts) {
        lastResponse = response;
        options.onRetry?.(attempt, `HTTP ${response.status}`);
        await sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs));
        continue;
      }

      return response;
    } catch (error) {
      lastError = error;
      if (!isRetryableNetworkError(error) || attempt >= attempts) {
        throw error;
      }
      options.onRetry?.(attempt, String((error as { message?: unknown }).message || error));
      await sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs));
    }
  }

  if (lastResponse) {
    return lastResponse;
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Fetch failed after ${attempts} attempts`);
}
