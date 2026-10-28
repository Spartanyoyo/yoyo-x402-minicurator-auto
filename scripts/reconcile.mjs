import { parseAbi } from "viem";
import { USDC } from "../src/app.mjs";
import { balances, chainClient, intervalTransfers } from "./chain.mjs";

const authorizationAbi = parseAbi(["function authorizationState(address authorizer, bytes32 nonce) view returns (bool)", "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)"]);

export async function reconcilePurchase(record, rpc = chainClient()) {
  if (await rpc.getChainId() !== 84532) throw new Error("RPC is not Base Sepolia");
  if (!record.authorization) return { checkedAt: new Date().toISOString(), signed: false, safeToRetry: !record.http?.some(entry => entry.paid), reason: "No authorization was created; inspect the original preflight failure" };
  const blockNumber = await rpc.getBlockNumber({ cacheTime: 0 });
  const block = await rpc.getBlock({ blockNumber });
  const expired = block.timestamp >= BigInt(record.authorization.validBefore);
  const used = await rpc.readContract({ address: USDC, abi: authorizationAbi, functionName: "authorizationState", args: [record.buyer, record.authorization.nonce], blockNumber });
  if (!expired && !used) return { checkedAt: new Date().toISOString(), signed: true, blockNumber: String(blockNumber), blockTime: new Date(Number(block.timestamp) * 1000).toISOString(), expired: false, authorizationUsed: false, expiresAt: new Date(Number(record.authorization.validBefore) * 1000).toISOString(), safeToRetry: false, reason: "Authorization has not expired; wait and reconcile again before any further purchase" };
  const beforeObserved = await balances(rpc, record.buyer, record.seller, BigInt(record.before.block));
  const after = await balances(rpc, record.buyer, record.seller, blockNumber);
  const transfers = await intervalTransfers(rpc, record.buyer, record.seller, BigInt(record.before.block) + 1n, blockNumber);
  const authorizations = [];
  for (let start = BigInt(record.before.block) + 1n; start <= blockNumber; start += 150n) {
    const end = start + 149n < blockNumber ? start + 149n : blockNumber;
    authorizations.push(...await rpc.getLogs({ address: USDC, event: authorizationAbi[1], args: { authorizer: record.buyer, nonce: record.authorization.nonce }, fromBlock: start, toBlock: end, strict: true }));
  }
  const balancesUnchanged = beforeObserved.buyer === record.before.buyer && beforeObserved.seller === record.before.seller && after.buyer === record.before.buyer && after.seller === record.before.seller;
  return {
    checkedAt: new Date().toISOString(), signed: true, blockNumber: String(blockNumber), blockTime: new Date(Number(block.timestamp) * 1000).toISOString(), expired, authorizationUsed: used,
    beforeObserved, after, balancesUnchanged, transfers, authorizationTransactions: authorizations.map(log => ({ transactionHash: log.transactionHash, blockNumber: String(log.blockNumber) })),
    safeToRetry: !used && expired && balancesUnchanged && transfers.length === 0 && authorizations.length === 0,
    reason: used ? "Authorization used; inspect the linked transaction and recover delivery, never automatically repay" : !expired ? "Authorization has not expired; wait and reconcile again" : "Retry only if unused, expired, balances unchanged and no related transfers",
  };
}
