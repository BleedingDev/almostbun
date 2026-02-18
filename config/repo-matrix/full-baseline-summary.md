# Public Repo Full Matrix Baseline

Generated: 2026-02-18T16:18:26.799Z

## Overview

| Metric | Value |
| --- | ---: |
| Total cases | 159 |
| Passed | 6 |
| Failed | 153 |
| Pass rate | 3.8% |
| Shard | 1/4 |
| Median duration (p50) | 30002 ms |
| Tail duration (p90) | 30003 ms |
| Average duration | 29305 ms |

## Business Impact

- Compatibility conversion: **3.8%** of repos reached a runnable and probe-verified state.
- Time-to-value: median case completion is **30002 ms** (p90: **30003 ms**).
- Primary loss driver: **Unknown** stage drop-offs.
- Top technical blocker cluster: **Unknown**.

## Functional Funnel

| Stage | Drop-offs | Remaining Cases |
| --- | ---: | ---: |
| Bootstrap | 73 | 86 |
| Detection | 0 | 86 |
| Server Start | 0 | 86 |
| Probe | 0 | 86 |
| Runtime | 0 | 86 |
| Unknown | 80 | 6 |

## Failure Categories

| Category | Count |
| --- | ---: |
| Unknown | 153 |

## Failing Cases (Top 12)

| Case | Detected Kind | Error |
| --- | --- | --- |
| tanstack-start-bare | n/a | attempt 1/1: Error: tanstack-start-bare timed out after 30000ms recent logs: [progress] Downloading TanStack/router@main... |
| tanstack-start-basic-cloudflare | n/a | attempt 1/1: Error: tanstack-start-basic-cloudflare timed out after 30000ms recent logs: [progress] Downloading TanStack/router@main... [pro |
| nextjs-with-context-api | n/a | attempt 1/1: Error: nextjs-with-context-api timed out after 30000ms recent logs: [progress] Downloading vercel/next.js@canary... |
| nextjs-with-react-intl | n/a | attempt 1/1: Error: nextjs-with-react-intl timed out after 30000ms recent logs: [progress] Downloading vercel/next.js@canary... |
| nextjs-with-static-export | n/a | attempt 1/1: Error: nextjs-with-static-export timed out after 30000ms recent logs: [progress] Downloading vercel/next.js@canary... [progress |
| nextjs-with-emotion | n/a | attempt 1/1: Error: nextjs-with-emotion timed out after 30000ms recent logs: [progress] Downloading vercel/next.js@canary... |
| nextjs-with-next-translate | n/a | attempt 1/1: Error: nextjs-with-next-translate timed out after 30000ms recent logs: [progress] Downloading vercel/next.js@canary... [progres |
| nextjs-with-route-as-modal | n/a | attempt 1/1: Error: nextjs-with-route-as-modal timed out after 30000ms recent logs: [progress] Downloading vercel/next.js@canary... [progres |
| nextjs-with-styled-jsx | n/a | attempt 1/1: Error: nextjs-with-styled-jsx timed out after 30000ms recent logs: [progress] Downloading vercel/next.js@canary... |
| nextjs-with-babel-macros | n/a | attempt 1/1: Error: nextjs-with-babel-macros timed out after 30000ms recent logs: [progress] Downloading vercel/next.js@canary... |
| nextjs-with-cxs | n/a | attempt 1/1: Error: nextjs-with-cxs timed out after 30000ms recent logs: [progress] Downloading vercel/next.js@canary... [progress] Retrying |
| nextjs-with-goober | n/a | attempt 1/1: Error: nextjs-with-goober timed out after 30000ms recent logs: [progress] Downloading vercel/next.js@canary... |
