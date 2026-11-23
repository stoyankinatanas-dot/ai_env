# ai_env: Crypto Market-State API for AI Agents (design)

Status: draft for approval · 2026-11-23

## 1. Intent

A small paid web service that AI agents call to get a ready-made picture of
the crypto derivatives market for BTC and ETH. Agents pay per request in
fractions of a cent to a few cents (USDC on Base, via the x402 protocol). No
accounts or API keys are involved.

Why it exists:
- The owner wants a project that earns micropayments from AI agents.
- Crypto trading agents are the largest group of paying agents today. In one
  mid-2026 sample, the most-used paid resource was a $0.02 crypto assessment.
- An agent cannot cheaply rebuild this itself. It would need to poll several
  exchanges continuously, keep history, and compute derived metrics.

It is run as a **time-boxed experiment**. Realistic income is $0–50/month at
first. The 14-day kill rule in section 9 decides whether to continue.

## 2. Goals, non-goals, anti-goals

Goals
- Paid HTTP endpoints that return a fresh, cached JSON snapshot of the market
  state: funding rates, open interest, basis, a volatility regime, and a short
  plain-English summary.
- **Runs with no human operation once set up.** That covers data collection,
  summaries, selling, monitoring, and preparing fixes.
- Marginal cost per paid call near zero: no LLM call per request, served from
  cache.
- Easy for agents and their developers to find: x402 Bazaar and Agentic.Market
  listings, OpenAPI, `llms.txt`, and later an MCP server.

Non-goals (v1)
- Live liquidation feeds or liquidation-cluster maps. These need a permanent
  WebSocket connection, which the chosen hosting doesn't give cheaply (see
  section 4). They are a v2 candidate.
- Coins beyond BTC and ETH.
- A website for humans, beyond a one-page landing/docs page.
- Fiat payments or subscriptions.

Anti-goals (these would count as failure even if the service works)
- **Giving investment advice.** No buy/sell/hold calls, no "signals" wording,
  and nothing personalised. This would make it a regulated service under EU
  MiCA.
- Redistributing raw exchange data in a way that breaches exchange terms.
  Only derived and aggregated metrics are served.
- Running costs that exceed revenue by more than a small, fixed budget (see
  section 7).
- Anyone other than the owner holding the receiving wallet's keys or recovery
  phrase.

## 3. Constraints

- **Hosting: Cloudflare Workers** (the owner's choice). This means:
  - TypeScript is the language. The earlier Python skeleton in `ai_env/` is
    replaced.
  - Scheduled jobs use Cron Triggers. There is no always-on process.
  - Storage uses Cloudflare services: KV for the latest snapshot, D1 (SQLite)
    for history.
- **Exchange geo-blocking.** Binance (and probably Bybit) reject requests from
  US or datacenter IPs with HTTP 451. Worker cron jobs may run from US
  locations. The source list therefore has to be decided by testing from a
  deployed Worker (section 6, step 1).
- **Payments:** x402 with USDC on the Base network, paid to the owner's own
  wallet address. Mainnet needs a facilitator; Coinbase's (CDP) is the
  default, and it also screens transactions.
- **Claude API** for the summaries. The model and how often it runs are set by
  cost (section 7).
- **Repository:** `stoyankinatanas-dot/Claud`, folder `ai_env/`. The repo is a
  monorepo, so CI must only touch this folder.

## 4. Approaches considered

| Option | Summary | Why not / why |
|---|---|---|
| 1. Small VPS (Hetzner) | Python process with a permanent exchange WebSocket, ~€5–10/month | Recommended by Claude for the live liquidation feed. Not chosen. |
| **2. Cloudflare Workers** | Serverless TypeScript, cron jobs, KV/D1, native x402 support (`x402-hono`, Agents SDK `paidTool`) | **Chosen by the owner.** Nothing to maintain, near-zero cost, first-class x402. Trade-off: no permanent connection, so liquidations are out of v1. |
| 3. Fly.io / Railway | Managed container | Higher cost and platform lock-in, without a clear advantage. |

A possible v2 addition is a Cloudflare Durable Object holding an outbound
exchange WebSocket for liquidations. It costs extra, so it is added only if
v1 shows demand.

## 5. Design

### 5.1 Components (one Worker project)

```
Cron (every 5 min) ──> collector ──> D1 (history) + KV ("latest" snapshot)
Cron (every N min) ──> summariser (Claude API) ──> KV ("latest" summary)
HTTP (Hono app):
  GET /                    free   landing page + docs links
  GET /llms.txt            free   agent-readable description
  GET /openapi.json        free
  GET /v1/sample           free   same shape as /v1/snapshot, 1 hour delayed
  GET /v1/snapshot         paid   full current market state, BTC+ETH
  GET /v1/funding          paid   funding rates per venue + history (24h/7d)
  GET /v1/regime           paid   volatility/positioning regime + summary text
  GET /admin/health        token  collector freshness, errors, sales counters
```

- Paid routes are behind `paymentMiddleware` from `x402-hono`. It is configured
  with the owner's `PAY_TO` address, network `base`, a USD price per route,
  and the facilitator URL.
- Responses always include `as_of` (UTC), the per-source freshness, a
  `disclaimer` field ("market data and analytics only, not investment
  advice"), and `version`.
- If data is stale (older than 15 minutes), paid routes return HTTP 503 with
  no payment taken, rather than serving stale data. The builder confirms with
  the x402 middleware how to fail before settlement.

### 5.2 Data (v1)

For BTC and ETH perpetuals, per reachable venue:
- funding rate (current and predicted, where offered);
- open interest in USD, with 1h/24h change;
- mark vs index price, giving the basis;
- for BTC and ETH options: implied volatility index where public (e.g.
  Deribit DVOL).

Derived:
- OI-weighted average funding;
- funding z-score vs the last 30 days;
- regime label, from a fixed rule table such as "crowded long", "neutral" or
  "deleveraging". The rules are documented in the response's `methodology`
  link.

Candidate sources, in order. Keep the ones reachable from Workers:
Hyperliquid, Deribit, OKX, Kraken Futures, Bitget, Bybit, Binance.
**At least 3 reachable venues are required to launch.** *(Claude's call)*
If the probe finds fewer, the collector runs inside a Durable Object with an
EU location hint (e.g. `weur`) and the probe is repeated from there. If still
fewer than 3 are reachable, but Hyperliquid and Deribit both are, launch with
those two and say so in `methodology`. If fewer than 2 are reachable, stop
and discuss with the owner.

**Per-venue vs aggregated** *(Claude's call)*: per-venue *current* values are
served, as public aggregator sites already do. History is served only as
derived/aggregated series (OI-weighted funding, z-scores), never as raw
per-venue history. The owner's exchange-terms review (human step 5) can
tighten this.

History is kept in D1 at 5-minute resolution for 90 days, then downsampled to
hourly.

### 5.3 Summary text

A Claude call takes the latest snapshot JSON and returns 3–5 neutral
sentences describing the state. The prompt forbids recommendations. The
output is checked against a banned-phrase list (buy, sell, long now, target,
"should"...). If the check fails, the previous summary is kept and an error
is logged. Thinking is set to `adaptive` and a stop reason of `refusal` is
handled.

### 5.4 Pricing (initial)

- `/v1/snapshot` $0.01
- `/v1/funding` $0.005
- `/v1/regime` $0.01

Prices live in config so the weekly review can change them through a pull
request.

### 5.5 Automation ("100% AI-operated")

| Job | How | Human involvement |
|---|---|---|
| Collect, summarise, serve, take payments | Worker cron + HTTP | none |
| Deploy | GitHub Actions on merge to `main` with path filter `ai_env/**`, runs tests then `wrangler deploy` | none after secrets are set |
| Daily health report | Claude Code scheduled task: reads `/admin/health` and on-chain receipts to `PAY_TO`, writes a short report (sales, uptime, errors) | owner reads it |
| Breakage fix | Same task: if health is red, it opens a fix PR on a branch | owner approves the merge (recommended for now; can be made automatic later) |
| Weekly growth review | Claude Code scheduled task: sales per route, competitor listings and prices, proposes pricing/endpoint changes as a PR | owner approves |

### 5.6 One-time human steps (cannot or should not be automated)

1. Create a wallet on Base (e.g. Coinbase Wallet) and keep the recovery phrase
   offline. Give only the **public address**.
2. Create a Cloudflare account. Create an API token for Workers, KV and D1,
   and store it as a GitHub secret.
3. Create a Coinbase Developer Platform account for the mainnet facilitator
   and store its keys as Cloudflare secrets.
4. Create an Anthropic API key, stored as a Cloudflare secret.
5. Read the API terms of the exchanges that end up being used (Claude prepares
   a summary).
6. Have one conversation with a Bulgarian accountant about USDC income, VAT and
   record-keeping.

## 6. Order of work

1. **Market check (runs in parallel with steps 2–4).** *(Claude's call: it does
   not block building, but it does block step 6, mainnet.)* Look at the top 10–20
   trading/data sellers on the x402 Bazaar and Agentic.Market. Count unique
   and repeat paying wallets on Base. Report findings to the owner. If even
   the leaders have under ~50 real repeat wallets, pause and discuss.
2. **Reachability probe.** Deploy a throwaway Worker that calls each candidate
   exchange from cron and records status codes. This decides the source list.
3. Collector + storage + free `/v1/sample` (no payments yet), with tests.
4. Summariser with the guardrails above.
5. x402 paid routes on **Base Sepolia testnet**, tested end-to-end with a test
   client wallet.
6. Switch to mainnet; landing page, `llms.txt`, OpenAPI, Bazaar listing,
   Agentic.Market listing.
7. Ops automation: CI deploy, `/admin/health`, daily and weekly scheduled
   tasks.
8. Distribution push: posts or plugins for one or two agent frameworks.
9. Day 14 after listing: kill/continue decision (section 9).
10. v1.1: MCP server with `paidTool` exposing the same data.

## 7. Cost budget

- Cloudflare Workers paid plan $5/month (needed for cron frequency and D1
  limits). The builder confirms whether the free plan is enough.
- Claude summaries: the **owner chooses the model and frequency**. Rough
  numbers, assuming ~3k input / ~500 output tokens per run:
  - Claude Opus 5.5 every 15 min: ~$60/month.
  - Claude Opus 5.5 hourly: ~$16/month.
  - Claude Haiku 5.5 every 15 min: ~$1.5/month.
- Hard cap: the summariser stops if the month's Claude spend passes the
  budget set in config.

## 8. Risks

- **Too little real demand** (most likely). Mitigated by the step-1 market
  check and the kill rule.
- **Exchange blocks or terms.** Use only reachable venues, serve derived
  data, and follow the human step 5 review.
- **MiCA / advice line.** Covered by the anti-goals, the summary guardrails
  and the disclaimer.
- **Tax/VAT ambiguity.** Covered by the accountant (human step 6) and a log of
  every sale, kept in D1 and on-chain.
- **Dependence on one payment rail and marketplace.** Accepted for an
  experiment.

## 9. Success and kill rule

14 days after the mainnet listing:
- **Continue:** 20 or more unique external paying wallets **and** 5 or more
  repeat payers.
- **Otherwise:** stop marketing it. Either keep the data pipeline for the
  owner's own trading bots, or shut it down.

## 10. Repository and automation scope (Claude's calls)

- The old Python skeleton in `ai_env/` is **deleted** and replaced by the
  Worker project.
- Automated tasks and CI may change files **only under `ai_env/`**.
- Any automated PR that touches pricing, `PAY_TO`, the facilitator or payment
  config is **always held for the owner**, even if auto-merge is enabled
  later.
- On-chain receipts are read through a public Base RPC endpoint; no extra
  API key is needed.

## 11. Left to the builder

- Exact project layout, Hono/Wrangler versions, test framework (Vitest with
  the Workers pool is suggested).
- D1 schema and regime rule thresholds (documented in `methodology`).
- Retry and backoff logic per exchange.
- Exact wording of the landing page and `llms.txt`.
