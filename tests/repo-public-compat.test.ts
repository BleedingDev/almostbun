import { describe, expect, it } from 'vitest';
import { bootstrapAndRunGitHubProject, type RunnableProjectKind } from '../src/repo/runner';
import { getServerBridge, resetServerBridge } from '../src/server-bridge';

type RepoMatrixCase = {
  name: string;
  url: string;
  expectedKind: RunnableProjectKind;
  probePaths?: string[];
};

const PUBLIC_REPO_MATRIX: RepoMatrixCase[] = [
  {
    name: 'mdn-styled-static',
    url: 'https://github.com/mdn/beginner-html-site-styled',
    expectedKind: 'static',
  },
  {
    name: 'modernjs-examples-self-built-node-output',
    url: 'https://github.com/web-infra-dev/modern-js-examples/tree/main/examples/deploy/self-built-node/.output/html/main',
    expectedKind: 'static',
  },
  {
    name: 'modernjs-examples-playwright-report',
    url: 'https://github.com/web-infra-dev/modern-js-examples/tree/main/examples/test-playwright/playwright-report',
    expectedKind: 'static',
  },
  {
    name: 'modernjs-builder-static-minify-case',
    url: 'https://github.com/web-infra-dev/modern.js/tree/main/tests/e2e/builder/cases/html/minify/static',
    expectedKind: 'static',
  },
  {
    name: 'modernjs-server-pure-dist-html',
    url: 'https://github.com/web-infra-dev/modern.js/tree/main/packages/server/server/tests/fixtures/pure/test-dist/html/main',
    expectedKind: 'static',
  },
  {
    name: 'vite-template-vue-ts',
    url: 'https://github.com/vitejs/vite/tree/main/packages/create-vite/template-vue-ts',
    expectedKind: 'vite',
  },
  {
    name: 'vite-template-svelte-ts',
    url: 'https://github.com/vitejs/vite/tree/main/packages/create-vite/template-svelte-ts',
    expectedKind: 'vite',
  },
  {
    name: 'vite-template-solid-ts',
    url: 'https://github.com/vitejs/vite/tree/main/packages/create-vite/template-solid-ts',
    expectedKind: 'vite',
  },
  {
    name: 'nextjs-with-context-api',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-context-api',
    expectedKind: 'next',
  },
  {
    name: 'tanstack-router-react-basic',
    url: 'https://github.com/TanStack/router/tree/main/examples/react/basic',
    expectedKind: 'vite',
  },
  {
    name: 'tanstack-router-authenticated-routes',
    url: 'https://github.com/TanStack/router/tree/main/examples/react/authenticated-routes',
    expectedKind: 'vite',
  },
  {
    name: 'svelte-vite-plugin-env-e2e',
    url: 'https://github.com/sveltejs/vite-plugin-svelte/tree/main/packages/e2e-tests/env',
    expectedKind: 'vite',
  },
  {
    name: 'vite-template-vanilla',
    url: 'https://github.com/vitejs/vite/tree/main/packages/create-vite/template-vanilla',
    expectedKind: 'vite',
  },
  {
    name: 'vite-template-vanilla-ts',
    url: 'https://github.com/vitejs/vite/tree/main/packages/create-vite/template-vanilla-ts',
    expectedKind: 'vite',
  },
  {
    name: 'vite-template-react',
    url: 'https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react',
    expectedKind: 'vite',
  },
  {
    name: 'vite-template-react-ts',
    url: 'https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts',
    expectedKind: 'vite',
  },
  {
    name: 'vite-template-vue',
    url: 'https://github.com/vitejs/vite/tree/main/packages/create-vite/template-vue',
    expectedKind: 'vite',
  },
  {
    name: 'vite-template-svelte',
    url: 'https://github.com/vitejs/vite/tree/main/packages/create-vite/template-svelte',
    expectedKind: 'vite',
  },
  {
    name: 'vite-template-solid',
    url: 'https://github.com/vitejs/vite/tree/main/packages/create-vite/template-solid',
    expectedKind: 'vite',
  },
  {
    name: 'vite-template-lit',
    url: 'https://github.com/vitejs/vite/tree/main/packages/create-vite/template-lit',
    expectedKind: 'vite',
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
    const body = response.body.toString();
    const bodyPreview = body.slice(0, 220);
    const ok =
      response.statusCode >= 200 &&
      response.statusCode < 400 &&
      body.trim().length > 0 &&
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

describe.skipIf(process.env.RUN_PUBLIC_REPO_MATRIX !== '1')('public repo compatibility matrix', () => {
  it(
    'bootstraps and serves 20 public GitHub repos',
    async () => {
      const failures: string[] = [];

      for (const repoCase of PUBLIC_REPO_MATRIX) {
        let passed = false;
        const attemptErrors: string[] = [];

        for (let attempt = 1; attempt <= 2; attempt += 1) {
          let running: Awaited<ReturnType<typeof bootstrapAndRunGitHubProject>>['running'] | undefined;
          const logs: string[] = [];

          try {
            const started = await bootstrapAndRunGitHubProject(repoCase.url, {
              initServiceWorker: false,
              serverReadyTimeoutMs: 20_000,
              log: (message) => {
                logs.push(message);
              },
            });

            running = started.running;
            expect(started.detected.kind).toBe(repoCase.expectedKind);

            const probe = await probeRunningApp(
              running.port,
              repoCase.probePaths || ['/', '/index.html']
            );

            if (!probe.ok) {
              throw new Error(
                `probe failed at ${probe.path} with status ${probe.statusCode}; body preview: ${probe.bodyPreview}`
              );
            }

            passed = true;
            break;
          } catch (error) {
            attemptErrors.push(
              `attempt ${attempt}: ${String(error)}\nrecent logs:\n${logs.slice(-25).join('\n')}`
            );
          } finally {
            try {
              running?.stop();
            } catch {
              // ignore cleanup issues and continue
            }
            resetServerBridge();
          }
        }

        if (!passed) {
          failures.push(
            `[${repoCase.name}] ${repoCase.url}\n${attemptErrors.join('\n---\n')}`
          );
        }
      }

      expect(failures, failures.join('\n\n==========\n\n')).toEqual([]);
    },
    60 * 60 * 1000
  );
});
