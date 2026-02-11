import { describe, expect, it } from 'vitest';
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

async function probeRunningApp(port: number, paths: string[]): Promise<{
  ok: boolean;
  statusCode: number;
  path: string;
  bodyPreview: string;
  crawledPaths: string[];
}> {
  const bridge = getServerBridge();
  let lastStatus = 0;
  let lastPath = paths[0] || '/';
  let lastPreview = '';
  let crawledPaths: string[] = [];

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
    const hasRedirectLocation =
      typeof response.headers?.location === 'string' &&
      response.headers.location.length > 0;
    const ok =
      response.statusCode >= 200 &&
      response.statusCode < 400 &&
      (body.trim().length > 0 || hasRedirectLocation) &&
      !/Cannot GET \//i.test(bodyPreview);
    return {
      ok,
      response,
      body,
      bodyPreview,
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

    if (firstProbe.ok) {
      const linksToProbe = extractLocalLinks(probePath, firstProbe.body).slice(0, 8);
      const traversed = new Set<string>([probePath]);
      for (const linkPath of linksToProbe) {
        if (traversed.has(linkPath)) continue;
        traversed.add(linkPath);
        const linkedProbe = await probeSinglePath(linkPath);
        if (!linkedProbe.ok) {
          return {
            ok: false,
            statusCode: linkedProbe.response.statusCode,
            path: linkPath,
            bodyPreview: linkedProbe.bodyPreview,
            crawledPaths: [...traversed],
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
      if (requestedNames.length > 0) {
        expect(matrix.length).toBe(requestedNames.length);
      } else {
        expect(matrix.length).toBeGreaterThanOrEqual(50);
      }

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
              `probe failed at ${probe.path} with status ${probe.statusCode}; body preview: ${probe.bodyPreview}; crawled: ${probe.crawledPaths.join(', ')}`
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
