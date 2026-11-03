import { createPublicClient, custom } from "viem";
import { baseSepolia } from "viem/chains";
import { rpcUrls, auditPurchase } from "../scripts/chain.mjs";
import { USDC } from "./app.mjs";
import { tokenAbi } from "../scripts/chain.mjs";
import { sha256, RPC_LIMIT, readTextBounded } from "./agent-contract.mjs";

export class RpcYield extends Error {}
export class RpcTemporary extends Error {}

// Every JSON-RPC HTTP request, including failover, consumes this invocation's
// budget. No hidden viem polling/retry may multiply the provider request count.
export function workerRpc(env, state, fetcher = fetch) {
  const urls = rpcUrls(env);
  let requests = 0;
  const client = createPublicClient({ chain: baseSepolia, batch: { multicall: false },
    transport: custom({ async request({ method, params }) {
      let last;
      for (let attempt = 0; attempt < Math.min(2, urls.length); attempt++) {
        if (requests >= RPC_LIMIT) throw new RpcYield("RPC invocation budget reached; resume next alarm");
        const url = urls[(state.rpcCursor ?? 0) % urls.length];
        requests++;
        try {
          const response = await fetcher(url, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(6000), headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: requests, method, params }) });
          if (!response.ok) { await response.body?.cancel(); throw new Error(`RPC HTTP ${response.status}`); }
          const body = JSON.parse(await readTextBounded(response));
          if (body.error || !("result" in body)) throw new Error("RPC returned an error");
          // A lagging node may return null while another already has the block.
          if (body.result === null) throw new Error("RPC block or receipt not yet available");
          return body.result;
        } catch (error) {
          last = error; state.rpcCursor = ((state.rpcCursor ?? 0) + 1) % urls.length;
        }
      }
      throw new RpcTemporary(last?.message ?? "RPC temporarily unavailable");
    } }, { retryCount: 0 }) });
  client.waitForTransactionReceipt = options => client.getTransactionReceipt({ hash: options.hash });
  return client;
}

const encode = value => JSON.stringify(value, (_, item) => typeof item === "bigint" ? { $bigint: String(item) } : item);
const decode = value => JSON.parse(value, (_, item) => item && typeof item === "object" && Object.keys(item).length === 1 && typeof item.$bigint === "string" ? BigInt(item.$bigint) : item);

// Reuse the full payment audit, but checkpoint each successful read. An alarm
// that runs out of requests resumes at the first missing read, without repaying.
export async function incrementalAudit(record, rpc, persist, options = {}) {
  record.auditReads ??= {};
  const cached = {};
  for (const method of ["getChainId", "waitForTransactionReceipt", "getBlock", "readContract", "getLogs"]) {
    cached[method] = async (...args) => {
      const key = sha256(encode([method, args]));
      if (Object.hasOwn(record.auditReads, key)) return decode(record.auditReads[key]);
      const value = await rpc[method](...args);
      record.auditReads[key] = encode(value);
      await persist(record);
      return value;
    };
  }
  await auditPurchase(record, cached, options);
  await persist(record);
  return record;
}

// Lost settlement responses are recovered from the exact authorization nonce.
// Only one bounded log range is scanned at a time. No transfer is submitted.
export async function reconcilePayment(record, rpc, persist) {
  if (await rpc.getChainId() !== 84532) throw new Error("RPC is not Base Sepolia");
  const head = await rpc.getBlockNumber({ cacheTime: 0 });
  const block = await rpc.getBlock({ blockNumber: head });
  const used = await rpc.readContract({ address: USDC, abi: [{ type: "function", name: "authorizationState", stateMutability: "view", inputs: [{ type: "address", name: "authorizer" }, { type: "bytes32", name: "nonce" }], outputs: [{ type: "bool" }] }], functionName: "authorizationState", args: [record.buyer, record.authorization.nonce], blockNumber: head });
  if (!used) {
    record.reconciliation = { authorizationUsed: false, blockNumber: String(head), expired: block.timestamp > BigInt(record.authorization.validBefore) + 12n, safeToRetry: block.timestamp > BigInt(record.authorization.validBefore) + 12n, verificationBasis: "exact_contract_nonce_unused_after_expiry_plus_12_seconds", checkedAt: new Date().toISOString() };
    await persist(record);
    return record.reconciliation.safeToRetry ? "confirmed_unpaid" : "waiting";
  }
  const start = BigInt(record.scanNext ?? String(BigInt(record.before.block) + 1n));
  const end = start + 149n < head ? start + 149n : head;
  if (start > head) throw new RpcTemporary("Used authorization transaction not yet visible on this RPC");
  const logs = await rpc.getLogs({ address: USDC, event: tokenAbi.find(item => item.name === "AuthorizationUsed"), args: { authorizer: record.buyer, nonce: record.authorization.nonce }, fromBlock: start, toBlock: end, strict: true });
  if (logs.length > 1) throw new Error("Conflicting authorization events");
  if (logs.length === 1) {
    record.settlement = { success: true, transaction: logs[0].transactionHash, network: "eip155:84532", payer: record.buyer };
    record.reconciliation = { authorizationUsed: true, transaction: logs[0].transactionHash, checkedAt: new Date().toISOString() };
    await persist(record);
    return "settled";
  }
  record.scanNext = String(end + 1n); await persist(record);
  if (end === head) { record.scanNext = String(BigInt(record.before.block) + 1n); await persist(record); throw new RpcTemporary("Authorization event temporarily unavailable; another RPC will be used"); }
  return "scanning";
}
