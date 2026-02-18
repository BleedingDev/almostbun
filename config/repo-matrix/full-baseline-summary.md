# Public Repo Full Matrix Baseline

Generated: 2026-02-18T17:21:23.324Z

## Overview

| Metric | Value |
| --- | ---: |
| Total cases | 159 |
| Passed | 155 |
| Failed | 4 |
| Pass rate | 97.5% |
| Shard | 1/1 |
| Median duration (p50) | 15765 ms |
| Tail duration (p90) | 38764 ms |
| Average duration | 20052 ms |

## Business Impact

- Compatibility conversion: **97.5%** of repos reached a runnable and probe-verified state.
- Time-to-value: median case completion is **15765 ms** (p90: **38764 ms**).
- Primary loss driver: **Bootstrap** stage drop-offs.
- Top technical blocker cluster: **Network/CORS**.

## Functional Funnel

| Stage | Drop-offs | Remaining Cases |
| --- | ---: | ---: |
| Bootstrap | 4 | 155 |
| Detection | 0 | 155 |
| Server Start | 0 | 155 |
| Probe | 0 | 155 |
| Runtime | 0 | 155 |
| Unknown | 0 | 155 |

## Failure Categories

| Category | Count |
| --- | ---: |
| Network/CORS | 4 |

## Failing Cases (Top 12)

| Case | Detected Kind | Error |
| --- | --- | --- |
| nextjs-with-youtube-embed | n/a | attempt 1/1: Error: nextjs-with-youtube-embed timed out after 60000ms recent logs: [progress] Downloading vercel/next.js@canary... |
| nextjs-with-ably | n/a | attempt 1/1: RepoRunError: Network operation failed while fetching project data or dependencies. (bootstrap.network-failed) recent logs: [pr |
| nextjs-with-algolia-react-instantsearch | n/a | attempt 1/1: RepoRunError: Network operation failed while fetching project data or dependencies. (bootstrap.network-failed) recent logs: [pr |
| nextjs-with-apollo | n/a | attempt 1/1: Error: nextjs-with-apollo timed out after 60000ms recent logs: [progress] Downloading vercel/next.js@canary... [progress] Retry |
