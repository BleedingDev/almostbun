import { describe, expect, it } from 'vitest';
import { bootstrapAndRunGitHubProject, type RunnableProjectKind } from '../src/repo/runner';
import { getServerBridge, resetServerBridge } from '../src/server-bridge';

type RepoMatrixCase = {
  name: string;
  url: string;
  expectedKind: RunnableProjectKind;
  probePaths?: string[];
  skipInstall?: boolean;
  includeDev?: boolean;
  transformProjectSources?: boolean;
  serverReadyTimeoutMs?: number;
};

const CASE_TIMEOUT_MS = Number(process.env.PUBLIC_REPO_CASE_TIMEOUT_MS || 4 * 60 * 1000);

const PUBLIC_REPO_MATRIX: RepoMatrixCase[] = [
  {
    name: 'modern-static-self-built-node',
    url: 'https://github.com/web-infra-dev/modern-js-examples/tree/main/examples/deploy/self-built-node/.output/html/main',
    expectedKind: 'static',
    skipInstall: true,
  },
  {
    name: 'modern-static-playwright-report',
    url: 'https://github.com/web-infra-dev/modern-js-examples/tree/main/examples/test-playwright/playwright-report',
    expectedKind: 'static',
    skipInstall: true,
  },
  {
    name: 'modern-static-minify',
    url: 'https://github.com/web-infra-dev/modern.js/tree/main/tests/e2e/builder/cases/html/minify/static',
    expectedKind: 'static',
    skipInstall: true,
  },
  {
    name: 'modern-static-test-dist',
    url: 'https://github.com/web-infra-dev/modern.js/tree/main/packages/server/server/tests/fixtures/pure/test-dist/html/main',
    expectedKind: 'static',
    skipInstall: true,
  },
  {
    name: 'tanstack-start-bare',
    url: 'https://github.com/TanStack/router/tree/main/examples/react/start-bare',
    expectedKind: 'vite',
    skipInstall: true,
  },
  {
    name: 'tanstack-start-basic-react-query',
    url: 'https://github.com/TanStack/router/tree/main/examples/react/start-basic-react-query',
    expectedKind: 'vite',
    skipInstall: true,
  },
  {
    name: 'tanstack-start-basic-rsc',
    url: 'https://github.com/TanStack/router/tree/main/examples/react/start-basic-rsc',
    expectedKind: 'vite',
    skipInstall: true,
  },
  {
    name: 'tanstack-start-basic-authjs',
    url: 'https://github.com/TanStack/router/tree/main/examples/react/start-basic-authjs',
    expectedKind: 'vite',
    skipInstall: true,
  },
  {
    name: 'tanstack-start-basic-cloudflare',
    url: 'https://github.com/TanStack/router/tree/main/examples/react/start-basic-cloudflare',
    expectedKind: 'vite',
    skipInstall: true,
  },
  {
    name: 'tanstack-start-basic-auth',
    url: 'https://github.com/TanStack/router/tree/main/examples/react/start-basic-auth',
    expectedKind: 'vite',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-context-api',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-context-api',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-redux',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-redux',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-apollo-and-redux',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-apollo-and-redux',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-jotai',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-jotai',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-react-intl',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-react-intl',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-i18n-next-intl',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-i18n-next-intl',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-mobx',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-mobx',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-next-seo',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-next-seo',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-static-export',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-static-export',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'svelte-vite-plugin-env',
    url: 'https://github.com/sveltejs/vite-plugin-svelte/tree/main/packages/e2e-tests/env',
    expectedKind: 'vite',
    skipInstall: true,
  },
  {
    name: 'garfish-app-esm-http-server',
    url: 'https://github.com/web-infra-dev/garfish/tree/main/dev/app-esm',
    expectedKind: 'node-script',
    includeDev: true,
    probePaths: ['/index.html', '/'],
  },
  {
    name: 'heroku-node-getting-started',
    url: 'https://github.com/heroku/node-js-getting-started',
    expectedKind: 'node-script',
    probePaths: ['/'],
  },
];

async function probeRunningApp(port: number, paths: string[]): Promise<{
  ok: boolean;
  statusCode: number;
  path: string;
  bodyPreview: string;
}> {
  const bridge = getServerBridge();
  let lastStatus = 0;
  let lastPath = paths[0] || '/';
  let lastPreview = '';

  for (const probePath of paths) {
    const response = await bridge.handleRequest(
      port,
      'GET',
      probePath,
      {
        host: 'localhost',
        accept: 'text/html,application/json,application/javascript,*/*',
      }
    );
    const body = response.body ? response.body.toString() : '';
    const bodyPreview = body.slice(0, 220);
    const hasRedirectLocation =
      typeof response.headers?.location === 'string' &&
      response.headers.location.length > 0;
    const ok =
      response.statusCode >= 200 &&
      response.statusCode < 400 &&
      (body.trim().length > 0 || hasRedirectLocation) &&
      !/Cannot GET \//i.test(bodyPreview);

    if (ok) {
      return {
        ok,
        statusCode: response.statusCode,
        path: probePath,
        bodyPreview,
      };
    }

    lastStatus = response.statusCode;
    lastPath = probePath;
    lastPreview = bodyPreview;
  }

  return {
    ok: false,
    statusCode: lastStatus,
    path: lastPath,
    bodyPreview: lastPreview,
  };
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race<T>([
      work,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

describe.skipIf(process.env.RUN_PUBLIC_REPO_MATRIX !== '1')('public repo compatibility matrix', () => {
  it(
    'bootstraps and serves public GitHub repos',
    async () => {
      const failures: string[] = [];
      const requestedNames = (process.env.PUBLIC_REPO_MATRIX_NAMES || '')
        .split(',')
        .map(name => name.trim())
        .filter(Boolean);
      const matrix = requestedNames.length > 0
        ? PUBLIC_REPO_MATRIX.filter(repo => requestedNames.includes(repo.name))
        : PUBLIC_REPO_MATRIX;
      expect(matrix.length).toBeGreaterThanOrEqual(20);

      for (const repoCase of matrix) {
        let running: Awaited<ReturnType<typeof bootstrapAndRunGitHubProject>>['running'] | undefined;
        const logs: string[] = [];
        console.log(`[matrix] start ${repoCase.name}`);

        try {
          const started = await withTimeout(
            bootstrapAndRunGitHubProject(repoCase.url, {
              skipInstall: repoCase.skipInstall,
              initServiceWorker: false,
              includeDev: repoCase.includeDev,
              transformProjectSources: repoCase.transformProjectSources,
              serverReadyTimeoutMs: repoCase.serverReadyTimeoutMs ?? 45_000,
              onProgress: (message) => {
                logs.push(`[progress] ${message}`);
              },
              log: (message) => {
                logs.push(message);
              },
            }),
            CASE_TIMEOUT_MS,
            repoCase.name
          );

          running = started.running;
          expect(started.detected.kind).toBe(repoCase.expectedKind);

          const probe = await withTimeout(
            probeRunningApp(
              running.port,
              repoCase.probePaths || ['/', '/index.html']
            ),
            30_000,
            `${repoCase.name} probe`
          );

          if (!probe.ok) {
            throw new Error(
              `probe failed at ${probe.path} with status ${probe.statusCode}; body preview: ${probe.bodyPreview}`
            );
          }

          console.log(`[matrix] pass ${repoCase.name} (${started.detected.kind})`);
        } catch (error) {
          failures.push(
            `[${repoCase.name}] ${repoCase.url}\nerror: ${String(error)}\nrecent logs:\n${logs.slice(-25).join('\n')}`
          );
          console.log(`[matrix] fail ${repoCase.name}: ${String(error)}`);
        } finally {
          try {
            running?.stop();
          } catch {
            // ignore cleanup issues and continue
          }
          resetServerBridge();
        }
      }

      expect(failures, failures.join('\n\n==========\n\n')).toEqual([]);
    },
    60 * 60 * 1000
  );
});
