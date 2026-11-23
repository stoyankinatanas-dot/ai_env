# Market-State API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Cloudflare Worker that collects BTC/ETH perpetual-futures data from several exchanges every 5 minutes, derives a market "state", and sells it to AI agents per request over x402 (USDC on Base).

**Architecture:** One Worker project in `ai_env/`. Two cron triggers do the work: every 5 minutes for collection and every 15 minutes for the summary. They write the latest snapshot to KV and history to D1. A Hono app serves free routes, and paid routes go behind the `@x402/hono` `paymentMiddleware`. A Claude Haiku 5.5 call writes a neutral summary under a $5/month cap.

**Tech Stack:** TypeScript, Hono 4.13, Wrangler 4, Vitest 4 + `@cloudflare/vitest-pool-workers`, `@x402/hono` / `@x402/core` / `@x402/evm` / `@x402/extensions` 2.32, `@coinbase/x402` 2.1, `@anthropic-ai/sdk` 1.x.

**Spec:** `ai_env/docs/specs/2026-11-23-market-state-api-design.md`

## Global Constraints

- All code and CI live under `ai_env/`. Nothing outside it changes except one workflow file `.github/workflows/ai-env.yml` and the root README row.
- Assets: BTC and ETH perpetuals only.
- Collector cron `*/5 * * * *`; summariser cron `*/15 * * * *`.
- Stale threshold: 15 minutes. Paid routes return 503 when the snapshot's `as_of` is older than that. Because `@x402/hono` skips settlement when the status is >= 400, no payment is taken.
- Prices: `/v1/snapshot` `$0.01`, `/v1/funding` `$0.005`, `/v1/regime` `$0.01`. They live in `src/config.ts`.
- Network: `eip155:84532` (Base Sepolia) until Task 10 switches it, by config, to `eip155:8453` (Base mainnet).
- Public URL: `https://ai-env.<account-subdomain>.workers.dev`. The worker name is `ai-env`.
- Summary model `claude-haiku-5-5`, `thinking: {type: "adaptive"}`, `output_config: {effort: "low"}`, `max_tokens: 1024`. Cost formula: `in*0.10/1e6 + out*0.50/1e6` USD. Monthly cap `$5`.
- Every JSON response carries `as_of` (ISO UTC), `version`, `disclaimer: "Market data and analytics only. Not investment advice."` and `methodology_url`.
- The summary text must never contain advice. Use the banned-phrase list in Task 7.
- History: per-venue history is never served. Only aggregated series are.
- Secrets (Cloudflare secrets, never committed): `PAY_TO`, `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `ANTHROPIC_API_KEY`, `ADMIN_TOKEN`.

## Review Focus

1. **One venue down or malformed:** the snapshot still builds from the other venues and lists the failed venue under `sources[].ok=false`. Tests are in Task 4.
2. **Fewer than 2 healthy venues:** the snapshot is marked `degraded: true`, and paid routes return 503. Tests are in Tasks 4 and 8.
3. **Cold start with no history:** the z-score is `null` and the regime is `"warming_up"`, with no crash or NaN in the JSON. Tests are in Task 5.
4. **Summariser fails, refuses, uses a banned phrase or hits the cap:** the previous summary is kept and marked `summary_stale: true`, and the data is still served. Tests are in Task 7.
5. **The KV snapshot is missing because nothing has been collected yet:** `/v1/sample` and paid routes return 503 JSON, not a 500 error. Tests are in Tasks 6 and 8.

---

## File Structure

```
ai_env/
  package.json  tsconfig.json  wrangler.jsonc  vitest.config.ts
  migrations/0001_init.sql           D1 schema
  src/index.ts                       Worker entry: fetch -> app, scheduled -> crons
  src/config.ts                      prices, thresholds, network, model ids
  src/types.ts                       VenueTicker, Snapshot, Env
  src/venues/<venue>.ts              one adapter per exchange: fetch + parse
  src/venues/index.ts                registry of enabled venues
  src/collect.ts                     run adapters, aggregate, persist
  src/metrics.ts                     OI-weighted funding, z-score, regime rules
  src/store.ts                       KV/D1 read/write helpers
  src/summary.ts                     Claude call, guardrail, budget
  src/app.ts                         Hono app, free + paid routes
  src/payments.ts                    x402 server + route config + sales log
  src/static/{landing.html,llms.txt,methodology.md}
  scripts/probe.ts                   throwaway reachability probe (Task 2)
  scripts/market-check.ts            competitor buyer analysis (Task 1)
  test/**/*.test.ts  test/fixtures/<venue>/*.json
  docs/runbook.md
```

---

### Task 0: Replace the Python skeleton with a Worker scaffold

**Files:**
- Delete: `ai_env/pyproject.toml`, `ai_env/uv.lock`, `ai_env/.python-version`, `ai_env/src/ai_env/`
- Create: `package.json`, `tsconfig.json`, `wrangler.jsonc`, `vitest.config.ts`, `src/index.ts`, `src/app.ts`, `src/types.ts`, `test/app.test.ts`
- Modify: `ai_env/.gitignore` (add `node_modules/`, `.wrangler/`, `.dev.vars`)

**Interfaces:**
- Produces: `type Env = { KV: KVNamespace; DB: D1Database; PAY_TO: string; CDP_API_KEY_ID: string; CDP_API_KEY_SECRET: string; ANTHROPIC_API_KEY: string; ADMIN_TOKEN: string; NETWORK: string }`; `createApp(): Hono<{ Bindings: Env }>` in `src/app.ts`; the default export `{ fetch, scheduled }` in `src/index.ts`.

- [ ] **Step 1:** Delete the Python files. Run `npm init -y` and install `hono`, plus dev dependencies `wrangler`, `typescript`, `vitest@^4.1`, `@cloudflare/vitest-pool-workers`, `@cloudflare/workers-types`. Set up `wrangler.jsonc` with name `ai-env`, `main: src/index.ts`, a current `compatibility_date`, `nodejs_compat`, KV binding `KV`, D1 binding `DB` and the two crons. Set `vars.NETWORK = "eip155:84532"`.
- [ ] **Step 2: Failing test.** In `test/app.test.ts`, `GET /health` should return 200 with `{ ok: true }`.
- [ ] **Step 3:** Run `npx vitest run`. Expected: FAIL (404).
- [ ] **Step 4:** Implement `createApp()` with `GET /health`, and wire it into `src/index.ts`.
- [ ] **Step 5:** Run `npx vitest run` (expect PASS) and `npx tsc --noEmit` (expect no errors).
- [ ] **Step 6:** Commit with the message `ai_env: replace Python skeleton with Cloudflare Worker scaffold`.

### Task 1: Market check (research script; it gates Task 10 only)

**Files:** Create `scripts/market-check.ts`. Create `docs/research/2026-11-x402-market-check.md` for the results.

**Interfaces:** Produces `analysePayTo(addr: string, days: number): Promise<{ address: string; uniquePayers: number; repeatPayers: number; payments: number; usd: number }>`.

- [ ] **Step 1:** List the trading/data resources from the Bazaar discovery list, which is the unauthenticated `list` endpoint of the CDP facilitator via `@coinbase/x402`. Add any Agentic.Market pages that are reachable. Collect each resource's `payTo` on `eip155:8453`.
- [ ] **Step 2:** For each `payTo`, count USDC `Transfer` logs to that address over the last 30 days, using a public Base RPC with `eth_getLogs` in chunks of at most 10k blocks. The USDC contract on Base is `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`. A *repeat payer* is a sender with 3 or more payments. The script has no unit tests; check it by hand against a block explorer for one address.
- [ ] **Step 3:** Write the top 20 table and a verdict into `docs/research/2026-11-x402-market-check.md`. If even the leaders have fewer than about 50 repeat payers, flag **PAUSE** for the owner. Commit.

### Task 2: Exchange reachability probe (needs the owner's Cloudflare token)

**Files:** Create `scripts/probe.ts`, a throwaway Worker run with `wrangler deploy --name ai-env-probe`. Create `test/fixtures/<venue>/*.json` and `docs/probe-results.md`.

- [ ] **Step 1:** Write the probe Worker. On cron, and on `GET /run`, it calls each candidate endpoint below. It records the HTTP status and stores the first 64 KB of each body in KV.

| Venue | Endpoint(s) |
|---|---|
| hyperliquid | `POST https://api.hyperliquid.xyz/info` body `{"type":"metaAndAssetCtxs"}` |
| deribit | `GET https://www.deribit.com/api/v2/public/ticker?instrument_name={BTC,ETH}-PERPETUAL`; `GET .../public/get_volatility_index_data?currency={BTC,ETH}&resolution=3600&start_timestamp=..&end_timestamp=..` |
| okx | `GET https://www.okx.com/api/v5/public/funding-rate?instId={BTC,ETH}-USDT-SWAP`; `.../public/open-interest?instType=SWAP&instId=..`; `.../public/mark-price?instType=SWAP&instId=..` |
| kraken | `GET https://futures.kraken.com/derivatives/api/v3/tickers` |
| bitget | `GET https://api.bitget.com/api/v2/mix/market/ticker?symbol={BTC,ETH}USDT&productType=USDT-FUTURES` |
| bybit | `GET https://api.bybit.com/v5/market/tickers?category=linear&symbol={BTC,ETH}USDT` |
| binance | `GET https://fapi.binance.com/fapi/v1/premiumIndex?symbol=..`; `.../fapi/v1/openInterest?symbol=..` |

- [ ] **Step 2:** Deploy it and trigger it 3 times, at least 10 minutes apart. If fewer than 3 venues return 200, redeploy with the probe inside a Durable Object using `locationHint: "weur"` and repeat.
- [ ] **Step 3:** Save one 200 body per venue endpoint as a test fixture. Write `docs/probe-results.md` with the reachable venues. Apply the spec rule: launch with 3 or more venues, or with Hyperliquid + Deribit only, or stop and ask the owner if fewer than 2 are reachable. For each reachable venue, also write a short summary of its API terms on redistributing derived data into `docs/probe-results.md`, for the owner to review (spec human step 5). Delete the probe Worker and commit.

### Task 3: Venue adapters (pure parsing, tested against fixtures)

Create one adapter for each venue reachable in Task 2.

**Files:** Create `src/venues/<venue>.ts`, `src/venues/index.ts`, `test/venues/<venue>.test.ts`. Add to `src/types.ts`.

**Interfaces:**
- Produces:
  ```ts
  type Asset = "BTC" | "ETH";
  type VenueTicker = { venue: string; asset: Asset; funding8h: number; predictedFunding8h: number | null;
                       oiUsd: number; markPx: number; indexPx: number };
  interface VenueAdapter { name: string; fetchTickers(f: typeof fetch): Promise<VenueTicker[]> }
  parse<Venue>(raw: unknown): VenueTicker[]   // exported per adapter, pure
  enabledVenues: VenueAdapter[]               // src/venues/index.ts
  ```
- Rules: `funding8h` is the funding rate normalised to an 8-hour period, as a decimal. Hyperliquid's hourly rate ×8. Venues already on 8h are unchanged. Kraken's absolute rate is converted to relative with `fundingRate / markPx` and scaled to 8h; confirm this against Kraken's docs. `oiUsd` is open interest in USD: multiply by `markPx` where the venue reports coins.

- [ ] **Step 1:** Write failing tests per venue. Load the fixture, run `parse<Venue>()`, and assert 2 tickers (BTC and ETH) with finite numbers and `markPx > 0`. Assert that `oiUsd` is between 1e8 and 1e11 for BTC, and that `|funding8h|` is less than 0.01. Also assert that a fixture with one field missing makes `parse` drop that asset instead of throwing.
- [ ] **Step 2:** Run `npx vitest run test/venues`. Expected: FAIL.
- [ ] **Step 3:** Implement the parsers and `fetchTickers`. Each `fetchTickers` uses a 5-second timeout through `AbortSignal.timeout(5000)`.
- [ ] **Step 4:** Run the tests. Expected: PASS. Commit.

### Task 4: Collector, aggregation and storage

**Files:** Create `migrations/0001_init.sql`, `src/store.ts`, `src/collect.ts`, `test/collect.test.ts`.

**Interfaces:**
- Consumes: `enabledVenues`, `VenueTicker`.
- Produces:
  ```ts
  type AssetState = { asset: Asset; venues: { venue: string; funding8h: number; oiUsd: number; basisBps: number }[];
                      oiWeightedFunding8h: number; totalOiUsd: number; oiChange1hPct: number | null;
                      oiChange24hPct: number | null; fundingZ30d: number | null; dvol: number | null;
                      regime: Regime; volRegime: "low" | "normal" | "high" | null };
  type Snapshot = { as_of: string; version: string; degraded: boolean;
                    sources: { venue: string; ok: boolean; error?: string }[];
                    assets: AssetState[]; summary: { text: string; as_of: string; stale: boolean } | null;
                    disclaimer: string; methodology_url: string };
  collect(env: Env, now: Date, adapters?: VenueAdapter[]): Promise<Snapshot>
  store.putLatest(env, s: Snapshot); store.getLatest(env): Promise<Snapshot | null>
  store.getSnapshotAt(env, isoTime: string): Promise<Snapshot | null>   // newest at or before
  store.fundingSeries(env, asset, sinceIso): Promise<{ ts: string; oiWeightedFunding8h: number }[]>
  ```
- D1 tables: `snapshots(ts TEXT PRIMARY KEY, json TEXT)`, `asset_history(ts TEXT, asset TEXT, oi_weighted_funding_8h REAL, total_oi_usd REAL, PRIMARY KEY(ts, asset))`, `sales(ts TEXT, route TEXT, price_usd REAL, payer TEXT, tx TEXT)`, `llm_spend(month TEXT PRIMARY KEY, usd REAL)`.
- `basisBps = (markPx - indexPx) / indexPx * 1e4`. `degraded = true` when fewer than 2 venues are ok.
- Retention, run in each collect: delete `snapshots` rows older than 2 days. Delete `asset_history` rows older than 90 days, except rows whose minute is `00`.

- [ ] **Step 1:** Write failing tests using fake adapters. Two ok venues give the correct OI-weighted funding. Worked example: (0.0001, $1B) and (0.0003, $3B) give 0.00025. One throwing adapter appears with `ok:false`, and the snapshot still builds. With one ok adapter, `degraded:true`. After `collect`, `getLatest` returns that snapshot. History older than 90 days that isn't on the hour gets deleted.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Leave metrics as `null` / `"warming_up"` for now; Task 5 fills them. Wire the `*/5` cron to `collect`.
- [ ] **Step 4:** Run the tests. Expected: PASS. Commit.

### Task 5: Derived metrics and regime rules

**Files:** Create `src/metrics.ts`, `test/metrics.test.ts`, `src/static/methodology.md`.

**Interfaces:**
- Produces: `type Regime = "warming_up" | "neutral" | "elevated_long" | "elevated_short" | "crowded_long" | "crowded_short" | "deleveraging"`; `zScore(series: number[], x: number): number | null` returns null when fewer than 288 points or when stdev is 0; `classifyRegime(z: number | null, oiChange24hPct: number | null): Regime`; `volRegime(dvol: number | null): "low" | "normal" | "high" | null`.
- Rules, checked in this order:
  1. `z` or `oiChange24hPct` is null → `warming_up`.
  2. `oiChange24hPct <= -10` → `deleveraging`.
  3. `z >= 2 && oiChange24hPct >= 5` → `crowded_long`.
  4. `z <= -2 && oiChange24hPct >= 5` → `crowded_short`.
  5. `|z| < 1` → `neutral`.
  6. Otherwise `z > 0` → `elevated_long`, else `elevated_short`.
- DVOL bands: below 40 is `low`, 40–70 is `normal`, above 70 is `high`.

- [ ] **Step 1:** Write a failing table test with one row per rule, plus these boundaries: `z=2, oi=5` → `crowded_long`; `z=0.99` → `neutral`; `oi=-10` → `deleveraging`. Also `zScore` with 287 points → null, and a constant series → null.
- [ ] **Step 2:** Run it. Expected: FAIL. **Step 3:** Implement, then use it in `collect`: the z-score comes from the 30-day `fundingSeries`, and the OI changes are taken from `asset_history` at -1h and -24h. Write `methodology.md` describing exactly these rules.
- [ ] **Step 4:** Run the tests. Expected: PASS. Commit.

### Task 6: Free routes

**Files:** Modify `src/app.ts`. Create `src/static/landing.html`, `src/static/llms.txt` and `test/free-routes.test.ts`.

**Interfaces:** Consumes `store.getLatest` and `store.getSnapshotAt`. Produces the routes `GET /`, `/llms.txt`, `/openapi.json`, `/methodology` and `/v1/sample`.

- [ ] **Step 1:** Write failing tests:
  - `/v1/sample` returns the snapshot from at least 60 minutes ago, with `sample: true`, `summary: null` and the disclaimer present.
  - With an empty store it returns 503 with `{ error: "no_data_yet" }`.
  - `/openapi.json` lists the three paid paths with their prices in `x-price-usd`.
  - `/llms.txt` mentions each paid path and its price.
- [ ] **Step 2:** Run them. Expected: FAIL. **Step 3:** Implement, importing the static files as text modules. The landing page text and `llms.txt` describe the data, the prices, x402 on Base, and the not-advice disclaimer.
- [ ] **Step 4:** Run them. Expected: PASS. Commit.

### Task 7: Summariser with guardrails and budget

**Files:** Create `src/summary.ts` and `test/summary.test.ts`.

**Interfaces:**
- Produces: `runSummary(env, now, client?: Pick<Anthropic, "messages">): Promise<"updated" | "kept_banned" | "kept_refusal" | "kept_error" | "skipped_cap">`; `containsBanned(text: string): boolean`; `costUsd(usage: { input_tokens: number; output_tokens: number }): number`.
- Banned phrases, case-insensitive with word boundaries: `buy`, `sell`, `go long`, `go short`, `long now`, `short now`, `should`, `recommend`, `target`, `entry`, `stop loss`, `take profit`, `price will`.
- System prompt: describe the snapshot JSON in 3–5 neutral sentences. Cover funding, open interest, basis and the regime label. State no predictions or recommendations and do not use second-person advice.
- Summary on success: set `snapshot.summary = { text, as_of, stale: false }` in KV, and add the cost to `llm_spend` for the current month (`YYYY-MM`). On any non-update result, keep the old text and set `stale: true`. If the month's spend is at least `$5`, return `skipped_cap` without calling the API.

- [ ] **Step 1:** Write failing tests with a fake client, one per outcome:
  - a clean text gives `updated` and the spend increases by `costUsd`;
  - a text containing "you should buy" gives `kept_banned`;
  - `stop_reason: "refusal"` gives `kept_refusal`;
  - a thrown `Anthropic.APIError` gives `kept_error`;
  - a spend of 5.00 gives `skipped_cap` with zero client calls.

  Also check that `costUsd({input_tokens: 3000, output_tokens: 500})` is approximately 0.00055.
- [ ] **Step 2:** Run them. Expected: FAIL. **Step 3:** Implement using `@anthropic-ai/sdk` `client.messages.create` with the model and parameters from Global Constraints, and wire it to the `*/15` cron.
- [ ] **Step 4:** Run them. Expected: PASS. Commit.

### Task 8: Paid routes with x402 (testnet)

**Files:** Create `src/payments.ts` and `test/paid-routes.test.ts`. Modify `src/app.ts`.

**Interfaces:**
- Produces: `buildRoutesConfig(env): RoutesConfig`. Each paid route has `accepts: [{ scheme: "exact", price, network: env.NETWORK, payTo: env.PAY_TO }]`, a `description`, and a Bazaar discovery extension from `declareDiscoveryExtension` in `@x402/extensions/bazaar` that gives an output example. Also produces `buildResourceServer(env): x402ResourceServer`: `new HTTPFacilitatorClient(...)` uses `https://x402.org/facilitator` on testnet and `createFacilitatorConfig(CDP_API_KEY_ID, CDP_API_KEY_SECRET)` from `@coinbase/x402` on mainnet, then `.register(env.NETWORK, new ExactEvmScheme())`.
- Route payloads:
  - `/v1/snapshot` returns the full `Snapshot`.
  - `/v1/funding` returns per-asset current per-venue funding plus `history_24h` and `history_7d`, taken from the aggregated `oiWeightedFunding8h` series at hourly points.
  - `/v1/regime` returns per asset `{ regime, volRegime, fundingZ30d, oiChange24hPct, summary }`.
- A sales-log middleware runs *outside* `paymentMiddleware`. After `next()`, if the status is 200 and a settlement response header is present, it decodes that header and inserts a row into `sales`. Read the header name from `@x402/core`; it is `PAYMENT-RESPONSE` in v2.
- Stale guard inside the handlers: if there is no snapshot, or `as_of` is older than 15 minutes, or `degraded` is true, return 503 `{ error: "data_unavailable" }`. No settlement happens.

- [ ] **Step 1:** Write failing tests, with the facilitator client stubbed through an injectable `buildResourceServer`:
  - a request without payment gets 402, with a `PAYMENT-REQUIRED` body that has the price `$0.01` and the network `eip155:84532`;
  - a stubbed valid payment gets 200 with a snapshot and one row in `sales`;
  - a stale snapshot with valid payment gets 503, the stub's `settle` is not called, and `sales` has no row;
  - a degraded snapshot gets 503.
- [ ] **Step 2:** Run them. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run them. Expected: PASS.
- [ ] **Step 5: End-to-end on testnet.** Deploy, then pay with a test wallet funded from the Base Sepolia faucet, using `@x402/fetch` in a short script `scripts/pay-test.ts`. Expect 200 and a USDC transfer to `PAY_TO` on the Sepolia explorer. Commit.

### Task 9: Admin health endpoint

**Files:** Modify `src/app.ts`. Create `test/admin.test.ts`.

**Interfaces:** `GET /admin/health` takes `Authorization: Bearer ${ADMIN_TOKEN}` and returns `{ ok, snapshot_age_s, degraded, sources, summary_age_s, llm_spend_month_usd, sales_24h: { count, usd, unique_payers }, sales_7d: {...} }`. `ok` is false if `snapshot_age_s > 900` or `degraded` is true.

- [ ] **Step 1:** Write failing tests: no token or a wrong token gives 401, and seeded data gives the right counts with `ok: true`. **Step 2:** Run them. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run them. Expected: PASS. Commit.

### Task 10: CI deploy and mainnet switch (requires the Task 1 verdict to not be PAUSE, or the owner's go-ahead)

**Files:** Create `.github/workflows/ai-env.yml` and `docs/runbook.md`. Modify `wrangler.jsonc`, and the root `README.md` row.

- [ ] **Step 1:** Add a workflow that runs on PRs and on pushes to `main` with path filter `ai_env/**`. It runs `npm ci`, `npx tsc --noEmit` and `npx vitest run`. On `main` it also runs `npx wrangler d1 migrations apply DB --remote` and `npx wrangler deploy`, using the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
- [ ] **Step 2:** Set `vars.NETWORK = "eip155:8453"`. Set the mainnet secrets. Deploy through a merge to `main`, which is the owner's approval.
- [ ] **Step 3: Smoke test.** An unpaid `GET /v1/snapshot` should return 402 with the mainnet network. Make one real $0.005 payment to `/v1/funding` from a small wallet and expect 200, a row in `sales` and the USDC visible at `PAY_TO`.
- [ ] **Step 4:** Write `docs/runbook.md` covering secrets, how to rotate them, how to pause selling (by removing the routes config), and the cost cap. Commit.

### Task 11: Listings and ops automation (outside the code)

- [ ] **Step 1:** Confirm that the resources appear in the CDP Bazaar `list` after the first settlement. Submit to Agentic.Market following its listing process, and record the result in `docs/runbook.md`.
- [ ] **Step 2:** Create the Claude Code scheduled tasks:
  - **Daily at 07:10 Europe/Sofia:** call `/admin/health`. Write a 5-line report covering health, sales, spend and errors. If `ok` is false, open a fix PR that touches `ai_env/**` only.
  - **Weekly on Monday:** review sales by route and competitor listings, and propose changes by PR. Any change to pricing or payment config is labelled `needs-owner`.
- [ ] **Step 3:** Post the launch in one or two agent-developer communities; Claude drafts and the owner posts. Record the listing date, since the 14-day decision is due 14 days later.
- [ ] **Step 4:** Add a one-time scheduled task for listing date + 14 days that runs the kill/continue check from spec section 9 and reports to the owner.
