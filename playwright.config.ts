import { defineConfig } from '@playwright/test';

const PLAYWRIGHT_WEB_SERVER_PORT = Math.max(1, Number(process.env.PLAYWRIGHT_WEB_SERVER_PORT || 5173));
const PLAYWRIGHT_WEB_SERVER_HOST = process.env.PLAYWRIGHT_WEB_SERVER_HOST || '127.0.0.1';
const PLAYWRIGHT_WEB_SERVER_TIMEOUT_MS = Math.max(
  30_000,
  Number(process.env.PLAYWRIGHT_WEB_SERVER_TIMEOUT_MS || 120_000)
);
const PLAYWRIGHT_BASE_URL = `http://${PLAYWRIGHT_WEB_SERVER_HOST}:${PLAYWRIGHT_WEB_SERVER_PORT}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 60000,
  retries: 0,
  use: {
    baseURL: PLAYWRIGHT_BASE_URL,
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  webServer: {
    command: `npm run dev -- --host ${PLAYWRIGHT_WEB_SERVER_HOST} --port ${PLAYWRIGHT_WEB_SERVER_PORT}`,
    url: `${PLAYWRIGHT_BASE_URL}/examples/vite-demo.html`,
    reuseExistingServer: !process.env.CI,
    timeout: PLAYWRIGHT_WEB_SERVER_TIMEOUT_MS,
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
