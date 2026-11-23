// Market check (plan Task 1): how much real, repeat buying do x402 data sellers see?
// Run: node --experimental-strip-types scripts/market-check.ts [cacheDir]
// Sources: CDP x402 discovery list (public) + USDC Transfer logs on Base (public RPC).

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const DISCOVERY = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";
const RPC = "https://mainnet.base.org";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const BLOCKS_PER_DAY = 43_200; // Base: 2s blocks
const CHUNK = Number(process.env.MC_CHUNK ?? 10_000);

type Item = {
  resource: string;
  description?: string;
  accepts: { network: string; payTo: string; amount: string; asset: string }[];
  quality?: { l30DaysTotalCalls?: number; l30DaysUniquePayers?: number; lastCalledAt?: string };
};

export async function fetchAllResources(cacheDir: string): Promise<Item[]> {
  const cache = `${cacheDir}/discovery.json`;
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8"));
  const items: Item[] = [];
  for (let offset = 0; ; offset += 1000) {
    const res = await fetch(`${DISCOVERY}?limit=1000&offset=${offset}`);
    if (!res.ok) throw new Error(`discovery ${res.status}`);
    const page = (await res.json()) as { items: Item[]; pagination: { total: number } };
    items.push(...page.items);
    if (page.items.length === 0 || items.length >= page.pagination.total) break;
  }
  writeFileSync(cache, JSON.stringify(items));
  return items;
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (res.ok) {
      const body = (await res.json()) as { result?: T; error?: { message: string } };
      if (body.result !== undefined) return body.result;
      if (body.error && !/rate|limit|timeout/i.test(body.error.message)) throw new Error(body.error.message);
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
  throw new Error(`rpc ${method} failed after retries`);
}

export async function analysePayTo(
  address: string,
  days: number,
): Promise<{ address: string; uniquePayers: number; repeatPayers: number; payments: number; usd: number }> {
  const head = parseInt(await rpc<string>("eth_blockNumber", []), 16);
  const from = head - days * BLOCKS_PER_DAY;
  const toTopic = "0x" + address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const counts = new Map<string, number>();
  let payments = 0;
  let usd = 0;
  for (let start = from; start <= head; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, head);
    const logs = await rpc<{ topics: string[]; data: string }[]>("eth_getLogs", [
      { address: USDC, fromBlock: "0x" + start.toString(16), toBlock: "0x" + end.toString(16), topics: [TRANSFER_TOPIC, null, toTopic] },
    ]);
    for (const log of logs) {
      const payer = "0x" + log.topics[1].slice(26);
      counts.set(payer, (counts.get(payer) ?? 0) + 1);
      payments++;
      usd += Number(BigInt(log.data)) / 1e6;
    }
  }
  const repeatPayers = [...counts.values()].filter((n) => n >= 3).length;
  return { address, uniquePayers: counts.size, repeatPayers, payments, usd };
}

const RELEVANT = /funding|open.?interest|perp|derivativ|liquidat|basis|volatil|ohlc|candle|price|market.?data|orderbook|order.?book|trading|signal|whale|token.?(safety|risk|audit|scan)|crypto/i;

async function main() {
  const cacheDir = process.argv[2] ?? ".market-check-cache";
  mkdirSync(cacheDir, { recursive: true });
  const all = await fetchAllResources(cacheDir);
  const base = all.filter((i) => i.accepts?.some((a) => a.network === "eip155:8453"));
  const payers = (i: Item) => i.quality?.l30DaysUniquePayers ?? 0;

  const buckets = [1, 10, 50, 100, 500, 1000].map((t) => [t, base.filter((i) => payers(i) >= t).length]);
  const relevant = base.filter((i) => RELEVANT.test(`${i.resource} ${i.description ?? ""}`));
  const top = [...relevant].sort((a, b) => payers(b) - payers(a)).slice(0, 20);

  const onchain = new Map<string, Awaited<ReturnType<typeof analysePayTo>>>();
  for (const item of top.slice(0, 10)) {
    const payTo = item.accepts.find((a) => a.network === "eip155:8453")!.payTo;
    if (onchain.has(payTo)) continue;
    try {
      onchain.set(payTo, await analysePayTo(payTo, 7));
    } catch (e) {
      console.error(`on-chain check failed for ${payTo}: ${(e as Error).message}`);
    }
  }

  const out = {
    generated: new Date().toISOString(),
    totalResources: all.length,
    baseMainnetResources: base.length,
    resourcesWithAtLeastNPayers30d: Object.fromEntries(buckets),
    relevantResources: relevant.length,
    relevantWithAnyPayer30d: relevant.filter((i) => payers(i) > 0).length,
    top: top.map((i) => {
      const a = i.accepts.find((x) => x.network === "eip155:8453")!;
      return {
        resource: i.resource,
        description: (i.description ?? "").slice(0, 100),
        priceUsd: Number(a.amount) / 1e6,
        calls30d: i.quality?.l30DaysTotalCalls ?? 0,
        uniquePayers30d: payers(i),
        lastCalledAt: i.quality?.lastCalledAt ?? null,
        payTo: a.payTo,
        onchain7d: onchain.get(a.payTo) ?? null,
      };
    }),
  };
  writeFileSync(`${cacheDir}/result.json`, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
