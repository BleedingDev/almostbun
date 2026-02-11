import { test, expect, type Page } from '@playwright/test';

const RUN_REPO_RUNNER_E2E_MATRIX = process.env.RUN_REPO_RUNNER_E2E_MATRIX === '1';
const CASE_TIMEOUT_MS = Math.max(60_000, Number(process.env.REPO_RUNNER_E2E_CASE_TIMEOUT_MS || 240_000));
const MAX_NAV_PATHS = Math.max(1, Number(process.env.REPO_RUNNER_E2E_MAX_NAV_PATHS || 3));

type RepoRunnerCase = {
  name: string;
  repoUrl: string;
  expectedFramework: RegExp;
  initialPath?: string;
};

const CRITICAL_CASES: RepoRunnerCase[] = [
  {
    name: 'modern-static',
    repoUrl: 'https://github.com/web-infra-dev/modern-js-examples/tree/main/examples/deploy/self-built-node/.output/html/main',
    expectedFramework: /^static \(\d+\)$/i,
    initialPath: '/index.html',
  },
  {
    name: 'tanstack-start-basic',
    repoUrl: 'https://github.com/TanStack/router/tree/main/examples/react/start-basic',
    expectedFramework: /^vite \(\d+\)$/i,
  },
  {
    name: 'next-context-api',
    repoUrl: 'https://github.com/vercel/next.js/tree/canary/examples/with-context-api',
    expectedFramework: /^next \(\d+\)$/i,
  },
  {
    name: 'garfish-esm',
    repoUrl: 'https://github.com/web-infra-dev/garfish/tree/main/dev/app-esm',
    expectedFramework: /^node-script \(\d+\)$/i,
    initialPath: '/index.html',
  },
];

const REQUESTED_CASE_NAMES = (process.env.REPO_RUNNER_E2E_CASES || '')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);

const ACTIVE_CASES = REQUESTED_CASE_NAMES.length > 0
  ? CRITICAL_CASES.filter((repoCase) => REQUESTED_CASE_NAMES.includes(repoCase.name))
  : CRITICAL_CASES;

const FATAL_TEXT_PATTERNS: RegExp[] = [
  /\bReferenceError\b/i,
  /\bTypeError\b/i,
  /\bSyntaxError\b/i,
  /\bRangeError\b/i,
  /\bCannot find module\b/i,
  /\bModule not found\b/i,
  /\bis not defined\b/i,
  /\bFailed to compile\b/i,
  /\bBuild failed\b/i,
  /\bUnhandled(?:Promise)?Rejection\b/i,
  /\bInternal Server Error\b/i,
];

const BENIGN_TEXT_PATTERNS: RegExp[] = [
  /\bWarning:\s+Service Worker initialization failed\b/i,
  /\bDeprecationWarning\b/i,
];

function findFatalLines(lines: string[]): string[] {
  return lines.filter((line) => {
    if (!FATAL_TEXT_PATTERNS.some((pattern) => pattern.test(line))) {
      return false;
    }
    if (BENIGN_TEXT_PATTERNS.some((pattern) => pattern.test(line))) {
      return false;
    }
    return true;
  });
}

async function waitForRunningState(page: Page): Promise<void> {
  await expect(page.locator('#status-badge')).toContainText('Running', { timeout: CASE_TIMEOUT_MS });
  await expect(page.locator('#preview-frame')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#framework-badge')).not.toContainText('Failed', { timeout: 5_000 });
}

async function collectPanelLogs(page: Page): Promise<string[]> {
  return page.locator('#logs .log-line').allTextContents();
}

async function assertPreviewContentHealthy(page: Page): Promise<void> {
  const bodyHtml = await page.locator('#preview-frame').evaluate((iframe) => {
    return (iframe as HTMLIFrameElement).contentDocument?.body?.innerHTML ?? '';
  });
  const bodyText = await page.locator('#preview-frame').evaluate((iframe) => {
    return (iframe as HTMLIFrameElement).contentDocument?.body?.innerText ?? '';
  });
  expect(bodyHtml.trim().length > 0 || bodyText.trim().length > 0).toBe(true);

  const bodyFatal = FATAL_TEXT_PATTERNS.find((pattern) => pattern.test(bodyHtml));
  if (bodyFatal) {
    throw new Error(`fatal body pattern detected in preview: ${bodyFatal.source}`);
  }
}

async function navigateAdditionalPaths(page: Page): Promise<void> {
  const discovered = await page.locator('#preview-frame').evaluate((iframe) => {
    const doc = (iframe as HTMLIFrameElement).contentDocument;
    if (!doc) {
      return [] as string[];
    }
    const anchors = [...doc.querySelectorAll('a[href^="/"]')];
    const hrefs = new Set<string>();
    for (const anchor of anchors) {
      const href = anchor.getAttribute('href') || '';
      if (!href.startsWith('/')) continue;
      if (href.startsWith('/__virtual__/')) continue;
      if (href.startsWith('/_next/')) continue;
      if (href.startsWith('/@vite/')) continue;
      hrefs.add(href);
    }
    return [...hrefs];
  });

  for (const href of discovered.slice(0, MAX_NAV_PATHS)) {
    await page.locator('#app-path').fill(href);
    await page.locator('#go-button').click();
    await page.waitForTimeout(800);
    await assertPreviewContentHealthy(page);
  }
}

test.describe('Repo Runner Critical Browser Matrix', () => {
  test.skip(!RUN_REPO_RUNNER_E2E_MATRIX, 'Set RUN_REPO_RUNNER_E2E_MATRIX=1 to run this suite');
  test.skip(REQUESTED_CASE_NAMES.length > 0 && ACTIVE_CASES.length === 0, 'REPO_RUNNER_E2E_CASES does not match known cases');

  for (const repoCase of ACTIVE_CASES) {
    test(`runs ${repoCase.name} with clean logs`, async ({ page }) => {
      test.setTimeout(CASE_TIMEOUT_MS + 60_000);

      const browserConsoleErrors: string[] = [];
      const pageErrors: string[] = [];

      page.on('console', (msg) => {
        if (msg.type() === 'error') {
          browserConsoleErrors.push(msg.text());
        }
      });
      page.on('pageerror', (error) => {
        pageErrors.push(error.message);
      });

      const params = new URLSearchParams({
        repo: repoCase.repoUrl,
        run: '1',
      });
      if (repoCase.initialPath) {
        params.set('path', repoCase.initialPath);
      }

      await page.goto(`/examples/repo-runner.html?${params.toString()}`);
      await waitForRunningState(page);
      await expect(page.locator('#framework-badge')).toHaveText(repoCase.expectedFramework);
      await assertPreviewContentHealthy(page);
      await navigateAdditionalPaths(page);

      const panelLogs = await collectPanelLogs(page);
      const fatalPanelLogs = findFatalLines(panelLogs);
      const fatalConsole = findFatalLines(browserConsoleErrors);
      const fatalPageErrors = findFatalLines(pageErrors);

      expect(
        fatalPanelLogs,
        `fatal panel logs:\n${fatalPanelLogs.join('\n')}\n\nall panel logs tail:\n${panelLogs.slice(-40).join('\n')}`
      ).toEqual([]);
      expect(fatalConsole, `fatal browser console errors:\n${fatalConsole.join('\n')}`).toEqual([]);
      expect(fatalPageErrors, `fatal page errors:\n${fatalPageErrors.join('\n')}`).toEqual([]);
    });
  }
});
