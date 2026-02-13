import { describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bootstrapAndRunGitHubProject, type RunnableProjectKind } from '../src/repo/runner';
import { getServerBridge, resetServerBridge } from '../src/server-bridge';

type RepoMatrixCase = {
  name: string;
  url: string;
  expectedKind: RunnableProjectKind;
  probePaths?: string[];
  crawlLinksLimit?: number;
  skipInstall?: boolean;
  includeDev?: boolean;
  transformProjectSources?: boolean;
  serverReadyTimeoutMs?: number;
};

const CASE_TIMEOUT_MS = Number(process.env.PUBLIC_REPO_CASE_TIMEOUT_MS || 4 * 60 * 1000);
const CASE_RETRIES = Math.max(1, Number(process.env.PUBLIC_REPO_CASE_RETRIES || 2));
const CASE_RETRY_DELAY_MS = Math.max(0, Number(process.env.PUBLIC_REPO_CASE_RETRY_DELAY_MS || 300));
const DEFAULT_CRAWL_LINKS_LIMIT = Math.max(0, Number(process.env.PUBLIC_REPO_CRAWL_LINKS_LIMIT || 8));
const LOG_SCAN_TAIL = Math.max(10, Number(process.env.PUBLIC_REPO_LOG_SCAN_TAIL || 60));
const MATRIX_REPORT_PATH = (process.env.PUBLIC_REPO_MATRIX_REPORT_PATH || '').trim();
const STRICT_LOG_VALIDATION = process.env.PUBLIC_REPO_STRICT_LOG_VALIDATION === '1';
const MATRIX_SHARD_TOTAL = Math.max(1, Number(process.env.PUBLIC_REPO_MATRIX_SHARD_TOTAL || 1));
const RAW_MATRIX_SHARD_INDEX = Number(process.env.PUBLIC_REPO_MATRIX_SHARD_INDEX || 0);
const MATRIX_SHARD_INDEX = Number.isFinite(RAW_MATRIX_SHARD_INDEX)
  ? Math.max(0, Math.min(MATRIX_SHARD_TOTAL - 1, Math.floor(RAW_MATRIX_SHARD_INDEX)))
  : 0;
const MATRIX_ARTIFACTS_DIR = (process.env.PUBLIC_REPO_MATRIX_ARTIFACTS_DIR || '').trim();
const CAPTURE_SCREENSHOTS = process.env.PUBLIC_REPO_CAPTURE_SCREENSHOTS === '1';

const FATAL_BODY_PATTERNS: RegExp[] = [
  /\bReferenceError\b/i,
  /\bTypeError\b/i,
  /\bSyntaxError\b/i,
  /\bCannot find module\b/i,
  /\bModule not found\b/i,
  /\bis not defined\b/i,
  /\bFailed to compile\b/i,
  /\bBuild failed\b/i,
  /\bApplication error: a client-side exception has occurred\b/i,
  /\bInternal Server Error\b/i,
];

const FATAL_LOG_PATTERNS: RegExp[] = [
  /\bReferenceError\b/i,
  /\bTypeError\b/i,
  /\bSyntaxError\b/i,
  /\bRangeError\b/i,
  /\bUnhandled(?:Promise)?Rejection\b/i,
  /\bCannot find module\b/i,
  /\bModule not found\b/i,
  /\bERR_MODULE_NOT_FOUND\b/i,
  /\bis not defined\b/i,
  /\bFailed to compile\b/i,
  /\bBuild failed\b/i,
  /\bError:\s+listen EADDRINUSE\b/i,
];

const BENIGN_LOG_PATTERNS: RegExp[] = [
  /\bWarning:\s+Service Worker initialization failed\b/i,
  /\bSourceMap\b/i,
  /\bDeprecationWarning\b/i,
];

function findFatalLogs(logs: string[]): string[] {
  const fatal: string[] = [];
  for (const line of logs.slice(-LOG_SCAN_TAIL)) {
    if (!FATAL_LOG_PATTERNS.some(pattern => pattern.test(line))) {
      continue;
    }
    if (!STRICT_LOG_VALIDATION && BENIGN_LOG_PATTERNS.some(pattern => pattern.test(line))) {
      continue;
    }
    fatal.push(line);
  }
  return fatal;
}

type RepoMatrixCaseResult = {
  name: string;
  url: string;
  expectedKind: RunnableProjectKind;
  status: 'pass' | 'fail';
  attempts: number;
  durationMs: number;
  detectedKind?: RunnableProjectKind;
  probePath?: string;
  crawledPaths?: string[];
  screenshotPath?: string;
  artifactPath?: string;
  logsTail: string[];
  error?: string;
};

type RepoMatrixReport = {
  version: 1;
  generatedAt: string;
  completedAt: string;
  totalCases: number;
  passCount: number;
  failCount: number;
  strictLogValidation: boolean;
  caseTimeoutMs: number;
  retries: number;
  shardIndex: number;
  shardTotal: number;
  results: RepoMatrixCaseResult[];
};

type ProbeSnapshot = {
  path: string;
  statusCode: number;
  bodyPreview: string;
  bodySample: string;
};

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
    name: 'tanstack-start-basic',
    url: 'https://github.com/TanStack/router/tree/main/examples/react/start-basic',
    expectedKind: 'vite',
    skipInstall: true,
  },
  {
    name: 'tanstack-start-basic-static',
    url: 'https://github.com/TanStack/router/tree/main/examples/react/start-basic-static',
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
    name: 'nextjs-with-stitches',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-stitches',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-styled-components',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-styled-components',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-ant-design',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-ant-design',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-emotion',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-emotion',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-framer-motion',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-framer-motion',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-lingui',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-lingui',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-mantine',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-mantine',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-next-translate',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-next-translate',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-react-bootstrap',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-react-bootstrap',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-react-hook-form',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-react-hook-form',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-rematch',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-rematch',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-route-as-modal',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-route-as-modal',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-sass',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-sass',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-service-worker',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-service-worker',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-shallow-routing',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-shallow-routing',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-styled-jsx',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-styled-jsx',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-typescript',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-typescript',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-web-worker',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-web-worker',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-absolute-imports',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-absolute-imports',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-babel-macros',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-babel-macros',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-biome',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-biome',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-cookies-next',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-cookies-next',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-custom-babel-config',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-custom-babel-config',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-cxs',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-cxs',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-dynamic-import',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-dynamic-import',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-eslint',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-eslint',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-flow',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-flow',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-goober',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-goober',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-google-analytics',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-google-analytics',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-gsap',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-gsap',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-i18n-rosetta',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-i18n-rosetta',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-linaria',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-linaria',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-mobx-state-tree',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-mobx-state-tree',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-msw',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-msw',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-next-page-transitions',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-next-page-transitions',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-next-ui',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-next-ui',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-overmind',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-overmind',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-portals',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-portals',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-prefetching',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-prefetching',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-react-ga4',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-react-ga4',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-react-multi-carousel',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-react-multi-carousel',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-reactstrap',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-reactstrap',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-reflux',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-reflux',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-segment-analytics',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-segment-analytics',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-sitemap',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-sitemap',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-slate',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-slate',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-strict-csp',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-strict-csp',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-styletron',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-styletron',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-three-js',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-three-js',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-typescript-types',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-typescript-types',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-vanilla-extract',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-vanilla-extract',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-videojs',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-videojs',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-vitest',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-vitest',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-webassembly',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-webassembly',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-xstate',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-xstate',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-youtube-embed',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-youtube-embed',
    expectedKind: 'next',
    skipInstall: true,
  },
  {
    name: 'nextjs-with-ably',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-ably',
    expectedKind: 'next',
    skipInstall: true,
    crawlLinksLimit: 0,
  },
  {
    name: 'nextjs-with-algolia-react-instantsearch',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-algolia-react-instantsearch',
    expectedKind: 'next',
    skipInstall: true,
    crawlLinksLimit: 0,
  },
  {
    name: 'nextjs-with-apivideo',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-apivideo',
    expectedKind: 'next',
    skipInstall: true,
    crawlLinksLimit: 0,
  },
  {
    name: 'nextjs-with-axiom',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-axiom',
    expectedKind: 'next',
    skipInstall: true,
    crawlLinksLimit: 0,
  },
  {
    name: 'nextjs-with-cloudinary',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-cloudinary',
    expectedKind: 'next',
    skipInstall: true,
    crawlLinksLimit: 0,
  },
  {
    name: 'nextjs-with-compiled-css',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-compiled-css',
    expectedKind: 'next',
    skipInstall: true,
    crawlLinksLimit: 0,
  },
  {
    name: 'nextjs-with-cypress',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-cypress',
    expectedKind: 'next',
    skipInstall: true,
    crawlLinksLimit: 0,
  },
  {
    name: 'nextjs-with-facebook-pixel',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-facebook-pixel',
    expectedKind: 'next',
    skipInstall: true,
    crawlLinksLimit: 0,
  },
  {
    name: 'nextjs-with-fela',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-fela',
    expectedKind: 'next',
    skipInstall: true,
    crawlLinksLimit: 0,
  },
  {
    name: 'nextjs-with-filbert',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-filbert',
    expectedKind: 'next',
    skipInstall: true,
    crawlLinksLimit: 0,
  },
  {
    name: 'nextjs-with-formspree',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-formspree',
    expectedKind: 'next',
    skipInstall: true,
    crawlLinksLimit: 0,
  },
  {
    name: 'nextjs-with-google-tag-manager',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-google-tag-manager',
    expectedKind: 'next',
    skipInstall: true,
    crawlLinksLimit: 0,
  },
  {
    name: 'nextjs-with-graphql-react',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-graphql-react',
    expectedKind: 'next',
    skipInstall: true,
    crawlLinksLimit: 0,
  },
  {
    name: 'nextjs-with-hls-js',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-hls-js',
    expectedKind: 'next',
    skipInstall: true,
    crawlLinksLimit: 0,
  },
  {
    name: 'nextjs-with-jest',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-jest',
    expectedKind: 'next',
    skipInstall: true,
    crawlLinksLimit: 0,
  },
  {
    name: 'nextjs-with-jest-babel',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-jest-babel',
    expectedKind: 'next',
    skipInstall: true,
    crawlLinksLimit: 0,
  },
  {
    name: 'nextjs-with-kea',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-kea',
    expectedKind: 'next',
    skipInstall: true,
    crawlLinksLimit: 0,
  },
  {
    name: 'nextjs-with-mdbreact',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-mdbreact',
    expectedKind: 'next',
    skipInstall: true,
    crawlLinksLimit: 0,
  },
  {
    name: 'nextjs-with-mocha',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-mocha',
    expectedKind: 'next',
    skipInstall: true,
    crawlLinksLimit: 0,
  },
  {
    name: 'nextjs-with-mux-video',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-mux-video',
    expectedKind: 'next',
    skipInstall: true,
    crawlLinksLimit: 0,
  },
  {
    name: 'nextjs-with-next-sitemap',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-next-sitemap',
    expectedKind: 'next',
    skipInstall: true,
    crawlLinksLimit: 0,
  },
  {
    name: 'nextjs-with-oxlint',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-oxlint',
    expectedKind: 'next',
    skipInstall: true,
    crawlLinksLimit: 0,
  },
  {
    name: 'nextjs-with-particles',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-particles',
    expectedKind: 'next',
    skipInstall: true,
    crawlLinksLimit: 0,
  },
  {
    name: 'nextjs-with-plausible',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-plausible',
    expectedKind: 'next',
    skipInstall: true,
    crawlLinksLimit: 0,
  },
  {
    name: 'nextjs-with-playwright',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-playwright',
    expectedKind: 'next',
    skipInstall: true,
    crawlLinksLimit: 0,
  },
  {
    name: 'nextjs-with-polyfills',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-polyfills',
    expectedKind: 'next',
    skipInstall: true,
    crawlLinksLimit: 0,
  },
  {
    name: 'nextjs-with-portals-ssr',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-portals-ssr',
    expectedKind: 'next',
    skipInstall: true,
    crawlLinksLimit: 0,
  },
  {
    name: 'nextjs-with-quill-js',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-quill-js',
    expectedKind: 'next',
    skipInstall: true,
    crawlLinksLimit: 0,
  },
  {
    name: 'nextjs-with-rbx-bulma-pro',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-rbx-bulma-pro',
    expectedKind: 'next',
    skipInstall: true,
    crawlLinksLimit: 0,
  },
  {
    name: 'nextjs-with-react-md-typescript',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-react-md-typescript',
    expectedKind: 'next',
    skipInstall: true,
    crawlLinksLimit: 0,
  },
  {
    name: 'nextjs-with-react-toolbox',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-react-toolbox',
    expectedKind: 'next',
    skipInstall: true,
    crawlLinksLimit: 0,
  },
  {
    name: 'nextjs-with-rebass',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-rebass',
    expectedKind: 'next',
    skipInstall: true,
    crawlLinksLimit: 0,
  },
  {
    name: 'nextjs-with-reflexjs',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-reflexjs',
    expectedKind: 'next',
    skipInstall: true,
    crawlLinksLimit: 0,
  },
  {
    name: 'nextjs-with-segment-analytics-pages-router',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-segment-analytics-pages-router',
    expectedKind: 'next',
    skipInstall: true,
    crawlLinksLimit: 0,
  },
  {
    name: 'nextjs-with-sentry',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-sentry',
    expectedKind: 'next',
    skipInstall: true,
    crawlLinksLimit: 0,
  },
  {
    name: 'nextjs-with-stencil',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-stencil',
    expectedKind: 'next',
    skipInstall: true,
    crawlLinksLimit: 0,
  },
  {
    name: 'nextjs-with-storybook',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-storybook',
    expectedKind: 'next',
    skipInstall: true,
    crawlLinksLimit: 0,
  },
  {
    name: 'nextjs-with-temporal',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-temporal',
    expectedKind: 'next',
    skipInstall: true,
    crawlLinksLimit: 0,
  },
  {
    name: 'nextjs-with-typescript-graphql',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-typescript-graphql',
    expectedKind: 'next',
    skipInstall: true,
    crawlLinksLimit: 0,
  },
  {
    name: 'nextjs-with-unsplash',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-unsplash',
    expectedKind: 'next',
    skipInstall: true,
    crawlLinksLimit: 0,
  },
  {
    name: 'nextjs-with-urql',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-urql',
    expectedKind: 'next',
    skipInstall: true,
    crawlLinksLimit: 0,
  },
  {
    name: 'nextjs-with-userbase',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-userbase',
    expectedKind: 'next',
    skipInstall: true,
    crawlLinksLimit: 0,
  },
  {
    name: 'nextjs-with-yoga',
    url: 'https://github.com/vercel/next.js/tree/canary/examples/with-yoga',
    expectedKind: 'next',
    skipInstall: true,
    crawlLinksLimit: 0,
  },
  {
    name: 'tanstack-basic',
    url: 'https://github.com/TanStack/router/tree/main/examples/react/basic',
    expectedKind: 'vite',
    skipInstall: true,
  },
  {
    name: 'tanstack-basic-default-search-params',
    url: 'https://github.com/TanStack/router/tree/main/examples/react/basic-default-search-params',
    expectedKind: 'vite',
    skipInstall: true,
  },
  {
    name: 'tanstack-basic-devtools-panel',
    url: 'https://github.com/TanStack/router/tree/main/examples/react/basic-devtools-panel',
    expectedKind: 'vite',
    skipInstall: true,
  },
  {
    name: 'tanstack-basic-file-based',
    url: 'https://github.com/TanStack/router/tree/main/examples/react/basic-file-based',
    expectedKind: 'vite',
    skipInstall: true,
  },
  {
    name: 'tanstack-basic-react-query',
    url: 'https://github.com/TanStack/router/tree/main/examples/react/basic-react-query',
    expectedKind: 'vite',
    skipInstall: true,
  },
  {
    name: 'tanstack-basic-react-query-file-based',
    url: 'https://github.com/TanStack/router/tree/main/examples/react/basic-react-query-file-based',
    expectedKind: 'vite',
    skipInstall: true,
  },
  {
    name: 'tanstack-deferred-data',
    url: 'https://github.com/TanStack/router/tree/main/examples/react/deferred-data',
    expectedKind: 'vite',
    skipInstall: true,
  },
  {
    name: 'tanstack-kitchen-sink',
    url: 'https://github.com/TanStack/router/tree/main/examples/react/kitchen-sink',
    expectedKind: 'vite',
    skipInstall: true,
  },
  {
    name: 'tanstack-kitchen-sink-file-based',
    url: 'https://github.com/TanStack/router/tree/main/examples/react/kitchen-sink-file-based',
    expectedKind: 'vite',
    skipInstall: true,
  },
  {
    name: 'tanstack-kitchen-sink-react-query',
    url: 'https://github.com/TanStack/router/tree/main/examples/react/kitchen-sink-react-query',
    expectedKind: 'vite',
    skipInstall: true,
  },
  {
    name: 'tanstack-large-file-based',
    url: 'https://github.com/TanStack/router/tree/main/examples/react/large-file-based',
    expectedKind: 'vite',
    skipInstall: true,
  },
  {
    name: 'tanstack-location-masking',
    url: 'https://github.com/TanStack/router/tree/main/examples/react/location-masking',
    expectedKind: 'vite',
    skipInstall: true,
  },
  {
    name: 'tanstack-navigation-blocking',
    url: 'https://github.com/TanStack/router/tree/main/examples/react/navigation-blocking',
    expectedKind: 'vite',
    skipInstall: true,
  },
  {
    name: 'tanstack-scroll-restoration',
    url: 'https://github.com/TanStack/router/tree/main/examples/react/scroll-restoration',
    expectedKind: 'vite',
    skipInstall: true,
  },
  {
    name: 'tanstack-view-transitions',
    url: 'https://github.com/TanStack/router/tree/main/examples/react/view-transitions',
    expectedKind: 'vite',
    skipInstall: true,
  },
  {
    name: 'tanstack-authenticated-routes',
    url: 'https://github.com/TanStack/router/tree/main/examples/react/authenticated-routes',
    expectedKind: 'vite',
    skipInstall: true,
  },
  {
    name: 'tanstack-basic-non-nested-devtools',
    url: 'https://github.com/TanStack/router/tree/main/examples/react/basic-non-nested-devtools',
    expectedKind: 'vite',
    skipInstall: true,
  },
  {
    name: 'tanstack-basic-virtual-file-based',
    url: 'https://github.com/TanStack/router/tree/main/examples/react/basic-virtual-file-based',
    expectedKind: 'vite',
    skipInstall: true,
  },
  {
    name: 'tanstack-basic-virtual-inside-file-based',
    url: 'https://github.com/TanStack/router/tree/main/examples/react/basic-virtual-inside-file-based',
    expectedKind: 'vite',
    skipInstall: true,
  },
  {
    name: 'tanstack-i18n-paraglide',
    url: 'https://github.com/TanStack/router/tree/main/examples/react/i18n-paraglide',
    expectedKind: 'vite',
    skipInstall: true,
  },
  {
    name: 'tanstack-kitchen-sink-react-query-file-based',
    url: 'https://github.com/TanStack/router/tree/main/examples/react/kitchen-sink-react-query-file-based',
    expectedKind: 'vite',
    skipInstall: true,
  },
  {
    name: 'tanstack-quickstart',
    url: 'https://github.com/TanStack/router/tree/main/examples/react/quickstart',
    expectedKind: 'vite',
    skipInstall: true,
  },
  {
    name: 'tanstack-quickstart-file-based',
    url: 'https://github.com/TanStack/router/tree/main/examples/react/quickstart-file-based',
    expectedKind: 'vite',
    skipInstall: true,
  },
  {
    name: 'tanstack-quickstart-esbuild-file-based',
    url: 'https://github.com/TanStack/router/tree/main/examples/react/quickstart-esbuild-file-based',
    expectedKind: 'static',
    skipInstall: true,
  },
  {
    name: 'tanstack-search-validator-adapters',
    url: 'https://github.com/TanStack/router/tree/main/examples/react/search-validator-adapters',
    expectedKind: 'vite',
    skipInstall: true,
  },
  {
    name: 'tanstack-start-counter',
    url: 'https://github.com/TanStack/router/tree/main/examples/react/start-counter',
    expectedKind: 'vite',
    skipInstall: true,
  },
  {
    name: 'tanstack-start-large',
    url: 'https://github.com/TanStack/router/tree/main/examples/react/start-large',
    expectedKind: 'vite',
    skipInstall: true,
  },
  {
    name: 'tanstack-start-material-ui',
    url: 'https://github.com/TanStack/router/tree/main/examples/react/start-material-ui',
    expectedKind: 'vite',
    skipInstall: true,
  },
  {
    name: 'tanstack-start-streaming-data-from-server-functions',
    url: 'https://github.com/TanStack/router/tree/main/examples/react/start-streaming-data-from-server-functions',
    expectedKind: 'vite',
    skipInstall: true,
  },
  {
    name: 'tanstack-start-tailwind-v4',
    url: 'https://github.com/TanStack/router/tree/main/examples/react/start-tailwind-v4',
    expectedKind: 'vite',
    skipInstall: true,
  },
  {
    name: 'tanstack-with-framer-motion',
    url: 'https://github.com/TanStack/router/tree/main/examples/react/with-framer-motion',
    expectedKind: 'vite',
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

async function probeRunningApp(
  port: number,
  paths: string[],
  crawlLinksLimit: number = DEFAULT_CRAWL_LINKS_LIMIT
): Promise<{
  ok: boolean;
  statusCode: number;
  path: string;
  bodyPreview: string;
  crawledPaths: string[];
  snapshots: ProbeSnapshot[];
  bodyErrorPattern?: string;
}> {
  const bridge = getServerBridge();
  let lastStatus = 0;
  let lastPath = paths[0] || '/';
  let lastPreview = '';
  let crawledPaths: string[] = [];
  const snapshotsByPath = new Map<string, ProbeSnapshot>();

  const probeSinglePath = async (probePath: string) => {
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
    const bodySample = body.slice(0, 20_000);
    const bodyForValidation = body.slice(0, 8000);
    const bodyErrorPattern = FATAL_BODY_PATTERNS.find(pattern => pattern.test(bodyForValidation));
    const hasRedirectLocation =
      typeof response.headers?.location === 'string' &&
      response.headers.location.length > 0;
    const ok =
      response.statusCode >= 200 &&
      response.statusCode < 400 &&
      (body.trim().length > 0 || hasRedirectLocation) &&
      !/Cannot GET \//i.test(bodyPreview) &&
      !bodyErrorPattern;
    return {
      ok,
      response,
      body,
      bodyPreview,
      bodySample,
      bodyErrorPattern: bodyErrorPattern?.source,
    };
  };

  const extractLocalLinks = (basePath: string, html: string): string[] => {
    const links = new Set<string>();
    const hrefRegex = /href\s*=\s*["']([^"']+)["']/gi;
    let match: RegExpExecArray | null = null;
    while ((match = hrefRegex.exec(html))) {
      const href = (match[1] || '').trim();
      if (!href || href.startsWith('#')) continue;
      if (/^(mailto:|tel:|javascript:)/i.test(href)) continue;
      try {
        const resolved = new URL(href, `http://localhost${basePath}`);
        if (resolved.host !== 'localhost') continue;
        const normalizedPath = `${resolved.pathname}${resolved.search}`;
        if (!normalizedPath.startsWith('/')) continue;
        if (normalizedPath.startsWith('/__virtual__/')) continue;
        if (normalizedPath.startsWith('/_next/')) continue;
        if (normalizedPath.startsWith('/@vite/')) continue;
        links.add(normalizedPath);
      } catch {
        // ignore invalid href
      }
    }
    return [...links];
  };

  for (const probePath of paths) {
    const firstProbe = await probeSinglePath(probePath);
    snapshotsByPath.set(probePath, {
      path: probePath,
      statusCode: firstProbe.response.statusCode,
      bodyPreview: firstProbe.bodyPreview,
      bodySample: firstProbe.bodySample,
    });

    if (firstProbe.ok) {
      const linksToProbe = extractLocalLinks(probePath, firstProbe.body).slice(0, crawlLinksLimit);
      const traversed = new Set<string>([probePath]);
      for (const linkPath of linksToProbe) {
        if (traversed.has(linkPath)) continue;
        traversed.add(linkPath);
        const linkedProbe = await probeSinglePath(linkPath);
        snapshotsByPath.set(linkPath, {
          path: linkPath,
          statusCode: linkedProbe.response.statusCode,
          bodyPreview: linkedProbe.bodyPreview,
          bodySample: linkedProbe.bodySample,
        });
        if (!linkedProbe.ok) {
          return {
            ok: false,
            statusCode: linkedProbe.response.statusCode,
            path: linkPath,
            bodyPreview: linkedProbe.bodyPreview,
            crawledPaths: [...traversed],
            snapshots: [...snapshotsByPath.values()],
            bodyErrorPattern: linkedProbe.bodyErrorPattern,
          };
        }
      }
      crawledPaths = [...traversed];
      return {
        ok: true,
        statusCode: firstProbe.response.statusCode,
        path: probePath,
        bodyPreview: firstProbe.bodyPreview,
        crawledPaths,
        snapshots: [...snapshotsByPath.values()],
        bodyErrorPattern: firstProbe.bodyErrorPattern,
      };
    }

    lastStatus = firstProbe.response.statusCode;
    lastPath = probePath;
    lastPreview = firstProbe.bodyPreview;
  }

  return {
    ok: false,
    statusCode: lastStatus,
    path: lastPath,
    bodyPreview: lastPreview,
    crawledPaths,
    snapshots: [...snapshotsByPath.values()],
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

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>(resolve => setTimeout(resolve, ms));
}

function selectShard<T>(items: T[], shardIndex: number, shardTotal: number): T[] {
  if (shardTotal <= 1) {
    return items;
  }
  return items.filter((_, index) => index % shardTotal === shardIndex);
}

function toSafeFileToken(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120) || 'case';
}

type HtmlScreenshotRenderer = {
  render: (html: string, outputPath: string) => Promise<void>;
  close: () => Promise<void>;
};

async function createHtmlScreenshotRenderer(
  enabled: boolean,
  onInfo: (message: string) => void
): Promise<HtmlScreenshotRenderer | null> {
  if (!enabled) {
    return null;
  }

  try {
    const playwright = await import('@playwright/test');
    const browser = await playwright.chromium.launch({
      headless: true,
      args: ['--disable-dev-shm-usage'],
    });

    return {
      render: async (html: string, outputPath: string) => {
        if (!html.trim()) {
          return;
        }
        const page = await browser.newPage({
          viewport: { width: 1280, height: 720 },
        });
        try {
          const normalizedHtml = /<html[\s>]/i.test(html)
            ? html
            : `<!doctype html><html><body>${html}</body></html>`;
          const dataUrl = `data:text/html;base64,${Buffer.from(normalizedHtml, 'utf8').toString('base64')}`;
          await page.goto(dataUrl, { waitUntil: 'load', timeout: 15_000 });
          await page.screenshot({ path: outputPath, fullPage: true });
        } finally {
          await page.close();
        }
      },
      close: async () => {
        await browser.close();
      },
    };
  } catch (error) {
    onInfo(`Screenshot renderer unavailable: ${String(error)}`);
    return null;
  }
}

async function writeCaseArtifact(
  repoCase: RepoMatrixCase,
  status: RepoMatrixCaseResult['status'],
  payload: {
    attempts: number;
    detectedKind?: RunnableProjectKind;
    probePath?: string;
    crawledPaths?: string[];
    logsTail: string[];
    snapshots?: ProbeSnapshot[];
    errors?: string[];
    screenshotPath?: string;
  }
): Promise<string | undefined> {
  if (!MATRIX_ARTIFACTS_DIR) {
    return undefined;
  }

  const caseDir = path.resolve(MATRIX_ARTIFACTS_DIR, 'cases');
  await mkdir(caseDir, { recursive: true });
  const artifactName = `${toSafeFileToken(repoCase.name)}.json`;
  const artifactPath = path.join(caseDir, artifactName);

  const artifactPayload = {
    generatedAt: new Date().toISOString(),
    shardIndex: MATRIX_SHARD_INDEX,
    shardTotal: MATRIX_SHARD_TOTAL,
    case: repoCase,
    status,
    attempts: payload.attempts,
    detectedKind: payload.detectedKind,
    probePath: payload.probePath,
    crawledPaths: payload.crawledPaths || [],
    logsTail: payload.logsTail,
    errors: payload.errors || [],
    snapshots: payload.snapshots || [],
    screenshotPath: payload.screenshotPath,
  };

  await writeFile(artifactPath, JSON.stringify(artifactPayload, null, 2), 'utf8');
  return artifactPath;
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
      const selectedMatrix = requestedNames.length > 0
        ? PUBLIC_REPO_MATRIX.filter(repo => requestedNames.includes(repo.name))
        : PUBLIC_REPO_MATRIX;
      if (requestedNames.length > 0) {
        expect(selectedMatrix.length).toBe(requestedNames.length);
      } else {
        expect(selectedMatrix.length).toBeGreaterThanOrEqual(50);
      }

      const matrix = selectShard(selectedMatrix, MATRIX_SHARD_INDEX, MATRIX_SHARD_TOTAL);
      if (MATRIX_SHARD_TOTAL > 1 && selectedMatrix.length >= MATRIX_SHARD_TOTAL) {
        expect(matrix.length).toBeGreaterThan(0);
      }
      if (MATRIX_SHARD_INDEX >= MATRIX_SHARD_TOTAL) {
        throw new Error(
          `Invalid matrix shard configuration index=${MATRIX_SHARD_INDEX} total=${MATRIX_SHARD_TOTAL}`
        );
      }
      console.log(
        `[matrix] shard ${MATRIX_SHARD_INDEX + 1}/${MATRIX_SHARD_TOTAL} selected ${matrix.length}/${selectedMatrix.length} cases`
      );

      const screenshotRenderer = await createHtmlScreenshotRenderer(
        Boolean(MATRIX_ARTIFACTS_DIR) && CAPTURE_SCREENSHOTS,
        (message) => console.log(`[matrix] ${message}`)
      );

      const report: RepoMatrixReport = {
        version: 1,
        generatedAt: new Date().toISOString(),
        completedAt: '',
        totalCases: matrix.length,
        passCount: 0,
        failCount: 0,
        strictLogValidation: STRICT_LOG_VALIDATION,
        caseTimeoutMs: CASE_TIMEOUT_MS,
        retries: CASE_RETRIES,
        shardIndex: MATRIX_SHARD_INDEX,
        shardTotal: MATRIX_SHARD_TOTAL,
        results: [],
      };

      try {
        for (const repoCase of matrix) {
          const caseStartedAt = Date.now();
          const attemptErrors: string[] = [];
          let passed = false;
          let attempts = 0;
          let detectedKind: RunnableProjectKind | undefined;
          let probePath: string | undefined;
          let crawledPaths: string[] | undefined;
          let logsTail: string[] = [];
          let snapshots: ProbeSnapshot[] | undefined;
          let screenshotPath: string | undefined;
          console.log(`[matrix] start ${repoCase.name}`);

          for (let attempt = 1; attempt <= CASE_RETRIES; attempt += 1) {
            attempts = attempt;
            let running: Awaited<ReturnType<typeof bootstrapAndRunGitHubProject>>['running'] | undefined;
            const logs: string[] = [];
            if (attempt > 1) {
              console.log(`[matrix] retry ${repoCase.name} (attempt ${attempt}/${CASE_RETRIES})`);
            }
            resetServerBridge();

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
              detectedKind = started.detected.kind;

              const probe = await withTimeout(
                probeRunningApp(
                  running.port,
                  repoCase.probePaths || ['/', '/index.html'],
                  repoCase.crawlLinksLimit ?? DEFAULT_CRAWL_LINKS_LIMIT
                ),
                30_000,
                `${repoCase.name} probe`
              );

              if (!probe.ok) {
                throw new Error(
                  `probe failed at ${probe.path} with status ${probe.statusCode}; body preview: ${probe.bodyPreview}; body error pattern: ${probe.bodyErrorPattern || 'none'}; crawled: ${probe.crawledPaths.join(', ')}`
                );
              }
              probePath = probe.path;
              crawledPaths = probe.crawledPaths;
              snapshots = probe.snapshots;

              const fatalLogs = findFatalLogs(logs);
              if (fatalLogs.length > 0) {
                throw new Error(`fatal runtime logs detected:\n${fatalLogs.slice(0, 10).join('\n')}`);
              }

              logsTail = logs.slice(-25);

              if (screenshotRenderer && MATRIX_ARTIFACTS_DIR) {
                const primarySnapshot = probe.snapshots.find(item => item.path === probe.path) || probe.snapshots[0];
                if (primarySnapshot && primarySnapshot.bodySample.trim()) {
                  const screenshotDir = path.resolve(MATRIX_ARTIFACTS_DIR, 'screenshots');
                  await mkdir(screenshotDir, { recursive: true });
                  const screenshotAbsolutePath = path.join(screenshotDir, `${toSafeFileToken(repoCase.name)}.png`);
                  await screenshotRenderer.render(primarySnapshot.bodySample, screenshotAbsolutePath);
                  screenshotPath = path.relative(process.cwd(), screenshotAbsolutePath);
                }
              }

              console.log(`[matrix] pass ${repoCase.name} (${started.detected.kind})`);
              passed = true;
              break;
            } catch (error) {
              const renderedError = String(error);
              logsTail = logs.slice(-25);
              attemptErrors.push(
                `attempt ${attempt}/${CASE_RETRIES}: ${renderedError}\nrecent logs:\n${logs.slice(-25).join('\n')}`
              );
              console.log(`[matrix] fail ${repoCase.name} attempt ${attempt}/${CASE_RETRIES}: ${renderedError}`);
            } finally {
              try {
                running?.stop();
              } catch {
                // ignore cleanup issues and continue
              }
              resetServerBridge();
            }

            if (!passed && attempt < CASE_RETRIES) {
              await sleep(CASE_RETRY_DELAY_MS * attempt);
            }
          }

          let artifactPath: string | undefined;
          try {
            const maybeArtifact = await writeCaseArtifact(repoCase, passed ? 'pass' : 'fail', {
              attempts,
              detectedKind,
              probePath,
              crawledPaths,
              logsTail,
              snapshots,
              errors: passed ? undefined : attemptErrors,
              screenshotPath,
            });
            artifactPath = maybeArtifact
              ? path.relative(process.cwd(), maybeArtifact)
              : undefined;
          } catch (error) {
            console.warn(`[matrix] case artifact write failed (${repoCase.name}): ${String(error)}`);
          }

          report.results.push({
            name: repoCase.name,
            url: repoCase.url,
            expectedKind: repoCase.expectedKind,
            status: passed ? 'pass' : 'fail',
            attempts,
            durationMs: Date.now() - caseStartedAt,
            detectedKind,
            probePath,
            crawledPaths,
            screenshotPath,
            artifactPath,
            logsTail,
            error: passed ? undefined : attemptErrors.join('\n\n'),
          });

          if (!passed) {
            failures.push(
              `[${repoCase.name}] ${repoCase.url}\n${attemptErrors.join('\n\n')}`
            );
          }
        }
      } finally {
        await screenshotRenderer?.close();
      }

      report.passCount = report.results.filter(result => result.status === 'pass').length;
      report.failCount = report.results.length - report.passCount;
      report.completedAt = new Date().toISOString();
      if (MATRIX_REPORT_PATH) {
        const reportPath = path.resolve(MATRIX_REPORT_PATH);
        try {
          await mkdir(path.dirname(reportPath), { recursive: true });
          await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
          console.log(`[matrix] report written: ${reportPath}`);
        } catch (error) {
          console.warn(`[matrix] report write failed (${reportPath}): ${String(error)}`);
        }
      }

      expect(failures, failures.join('\n\n==========\n\n')).toEqual([]);
    },
    60 * 60 * 1000
  );
});
