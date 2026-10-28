import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { NETWORK, USDC } from "../src/app.mjs";
import { rpcUrls } from "./chain.mjs";

export async function checkRpcEndpoint(url) {
  const startedAt = Date.now();
  try {
    const client = createPublicClient({ chain: baseSepolia, transport: http(url, { retryCount: 0, timeout: 12000 }) });
    const chainId = await client.getChainId();
    const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
    return { url, ok: chainId === 84532, chainId, blockNumber: String(blockNumber), elapsedMs: Date.now() - startedAt };
  } catch (error) {
    return {
      url,
      ok: false,
      elapsedMs: Date.now() - startedAt,
      error: { message: error.shortMessage ?? error.message, code: error.code ?? error.cause?.code ?? null },
    };
  }
}

export async function rpcHealth({ env = process.env, urls = rpcUrls(env) } = {}) {
  const endpoints = [];
  for (const url of urls) endpoints.push(await checkRpcEndpoint(url));
  return {
    at: new Date().toISOString(),
    network: NETWORK,
    chainId: 84532,
    asset: USDC,
    total: endpoints.length,
    available: endpoints.filter(endpoint => endpoint.ok).length,
    endpoints,
  };
}

async function main() {
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  const out = values.out ?? `evidence/verification/rpc-health-${Date.now()}.json`;
  const result = await rpcHealth();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ out, total: result.total, available: result.available, endpoints: result.endpoints.map(({ url, ok, chainId, blockNumber, elapsedMs, error }) => ({ url, ok, chainId, blockNumber, elapsedMs, error })) }, null, 2));
  if (result.available === 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();