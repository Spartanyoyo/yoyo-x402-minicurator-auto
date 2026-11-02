import { createPublicClient, http, fallback, parseAbi, getAddress, decodeEventLog } from "viem";
import { baseSepolia } from "viem/chains";
import { NETWORK, USDC, PRICE_ATOMIC } from "../src/app.mjs";
import { validateWeather } from "../src/weather.mjs";

export const tokenAbi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
]);

const defaultRpcUrls = [
  "https://base-sepolia.gateway.tenderly.co",
  "https://base-sepolia.drpc.org",
  "https://base-sepolia.rpc.sentio.xyz",
  "https://base-testnet.api.pocket.network",
  "https://base-sepolia-public.nodies.app",
  "https://base-sepolia.api.onfinality.io/public",
  "https://sepolia.base.org",
  "https://base-sepolia-rpc.publicnode.com",
];

export function rpcUrls(env = process.env) {
  const legacy = [];
  if (env.BASE_SEPOLIA_RPC !== undefined) legacy.push(env.BASE_SEPOLIA_RPC);
  if (env.BASE_SEPOLIA_FALLBACK_RPC !== undefined) legacy.push(env.BASE_SEPOLIA_FALLBACK_RPC);
  const configured = env.BASE_SEPOLIA_RPCS === undefined
    ? [...legacy, ...defaultRpcUrls]
    : env.BASE_SEPOLIA_RPCS.split(",");
  const urls = configured.map(value => {
    let url;
    try { url = new URL(value.trim()); }
    catch { throw new Error("RPC list must contain valid HTTPS URLs, or HTTP loopback URLs for local testing"); }
    const loopback = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((!loopback && url.protocol !== "https:") || url.username || url.password || url.hash) {
      throw new Error("RPC list must use HTTPS without URL credentials or fragments; HTTP is allowed only on loopback");
    }
    return url.href;
  });
  return [...new Set(urls)];
}

export function chainClient({ env = process.env } = {}) {
  const transport = fallback(rpcUrls(env).map(url => http(url, { retryCount: 0, timeout: 8000 })), { retryCount: 0, rank: false });
  return createPublicClient({ chain: baseSepolia, transport });
}

export async function balances(rpc, buyer, seller, blockNumber) {
  const read = address => rpc.readContract({ address: USDC, abi: tokenAbi, functionName: "balanceOf", args: [getAddress(address)], blockNumber });
  for (let attempt = 0; ; attempt++) {
    try {
      const [buyerBalance, sellerBalance] = await Promise.all([read(buyer), read(seller)]);
      return { block: String(blockNumber), buyer: String(buyerBalance), seller: String(sellerBalance) };
    } catch (error) {
      if (attempt >= 4 || !/block not found|header not found/i.test(error.message)) throw error;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

export async function auditPurchase(record, rpc = chainClient(), { validateDelivery, expectedAmount = PRICE_ATOMIC, allowConcurrentTransfers = false, deliveryStatus = 200 } = {}) {
  if (!/^[1-9]\d*$/.test(expectedAmount)) throw new Error("Invalid expected audit amount");
  record.status = "settled_audit_pending";
  delete record.audit;
  if (await rpc.getChainId() !== 84532) throw new Error("RPC is not Base Sepolia");
  if (!record.settlement?.success || record.settlement.network !== "eip155:84532") throw new Error("Missing successful Base Sepolia settlement receipt");
  const receipt = await rpc.waitForTransactionReceipt({ hash: record.settlement.transaction, timeout: 60000 });
  record.receipt = { transactionHash: receipt.transactionHash, status: receipt.status, blockNumber: String(receipt.blockNumber) };
  if (receipt.transactionHash.toLowerCase() !== record.settlement.transaction.toLowerCase() || receipt.blockNumber <= BigInt(record.before.block)) {
    throw new Error("Receipt hash or block does not match this purchase");
  }
  const settlementBlock = await rpc.getBlock({ blockNumber: receipt.blockNumber });
  record.receipt.blockTimestamp = String(settlementBlock.timestamp);
  ({ transfers: record.transfers, authorizationEvents: record.authorizationEvents } = decodeUsdcEvents(receipt.logs));
  record.beforeObserved = await balances(rpc, record.buyer, record.seller, BigInt(record.before.block));
  record.after = await balances(rpc, record.buyer, record.seller, receipt.blockNumber);
  record.intervalTransfers = await intervalTransfers(rpc, record.buyer, record.seller, BigInt(record.before.block) + 1n, receipt.blockNumber);
  const isExact = t => t.from.toLowerCase() === record.buyer.toLowerCase() && t.to.toLowerCase() === record.seller.toLowerCase() && t.value === expectedAmount;
  const related = record.transfers.filter(t => [t.from, t.to].some(address => [record.buyer, record.seller].some(wallet => wallet.toLowerCase() === address.toLowerCase())));
  const authorization = record.authorization;
  const authorizationFieldsMatch = authorization?.from?.toLowerCase() === record.buyer.toLowerCase() &&
    authorization?.to?.toLowerCase() === record.seller.toLowerCase() &&
    authorization?.value === expectedAmount &&
    /^0x[0-9a-f]{64}$/i.test(authorization?.nonce ?? "");
  const authorizationEventMatch = record.authorizationEvents.length === 1 &&
    record.authorizationEvents[0].authorizer.toLowerCase() === record.buyer.toLowerCase() &&
    record.authorizationEvents[0].nonce.toLowerCase() === authorization?.nonce?.toLowerCase();
  const authorizationTimeMatch = /^\d+$/.test(authorization?.validAfter ?? "") &&
    /^\d+$/.test(authorization?.validBefore ?? "") &&
    BigInt(authorization.validAfter) <= settlementBlock.timestamp &&
    settlementBlock.timestamp <= BigInt(authorization.validBefore);
  const settlementPayerMatches = record.settlement.payer?.toLowerCase() === record.buyer.toLowerCase();
  const declaredTermsMatch = record.network === NETWORK && record.asset?.toLowerCase() === USDC.toLowerCase();
  let deliveryVerified = false;
  try {
    const paid = record.http?.findLast(entry => entry.paid);
    if (paid?.status !== deliveryStatus || !record.response?.requestId || paid.headers["x-request-id"] !== record.response.requestId) {
      throw new Error("Missing successful data response or matching request ID");
    }
    if (validateDelivery) validateDelivery(record.response, record, Date.parse(paid.receivedAt));
    else validateWeather(record.response.weather, record.location, Date.parse(paid.receivedAt));
    deliveryVerified = true;
    delete record.deliveryError;
  } catch (error) {
    record.deliveryError = error.message;
  }
  record.audit = {
    chainSuccess: receipt.status === "success",
    exactTransfer: related.length === 1 && isExact(related[0]),
    authorizationFieldsMatch,
    authorizationEventMatch,
    authorizationTimeMatch,
    settlementPayerMatches,
    declaredTermsMatch,
    initialBalancesMatch: record.before.buyer === record.beforeObserved.buyer && record.before.seller === record.beforeObserved.seller,
    noOtherTransfers: record.intervalTransfers.length === 1 && isExact(record.intervalTransfers[0]) && record.intervalTransfers[0].transactionHash.toLowerCase() === receipt.transactionHash.toLowerCase(),
    buyerDelta: String(BigInt(record.before.buyer) - BigInt(record.after.buyer)),
    sellerDelta: String(BigInt(record.after.seller) - BigInt(record.before.seller)),
    deliveryVerified,
    auditedAt: new Date().toISOString(),
  };
  const net = address => record.intervalTransfers.reduce((sum, t) => sum + (t.to.toLowerCase() === address.toLowerCase() ? BigInt(t.value) : 0n) - (t.from.toLowerCase() === address.toLowerCase() ? BigInt(t.value) : 0n), 0n);
  const ownTransferPresent = record.intervalTransfers.filter(t => t.transactionHash.toLowerCase() === receipt.transactionHash.toLowerCase() && isExact(t)).length === 1;
  record.audit.balanceChangesExplained = ownTransferPresent && net(record.buyer) === BigInt(record.after.buyer) - BigInt(record.before.buyer) && net(record.seller) === BigInt(record.after.seller) - BigInt(record.before.seller);
  record.audit.balanceMode = allowConcurrentTransfers ? "all_interval_transfers" : "isolated_transfer";
  const balancesVerified = allowConcurrentTransfers ? record.audit.balanceChangesExplained : record.audit.noOtherTransfers && record.audit.buyerDelta === expectedAmount && record.audit.sellerDelta === expectedAmount;
  record.audit.paymentVerified = record.audit.chainSuccess && record.audit.exactTransfer && authorizationFieldsMatch && authorizationEventMatch && authorizationTimeMatch && settlementPayerMatches && declaredTermsMatch && record.audit.initialBalancesMatch && balancesVerified;
  record.status = record.audit.paymentVerified ? deliveryVerified ? "verified" : "paid_delivery_failed" : "audit_failed";
  return record;
}

export function decodeUsdcEvents(logs) {
  const decoded = logs.filter(log => log.address.toLowerCase() === USDC.toLowerCase()).flatMap(log => {
    try { return [decodeEventLog({ abi: tokenAbi, data: log.data, topics: log.topics })]; }
    catch { return []; }
  });
  return {
    transfers: decoded.filter(log => log.eventName === "Transfer").map(log => ({ from: log.args.from, to: log.args.to, value: String(log.args.value) })),
    authorizationEvents: decoded.filter(log => log.eventName === "AuthorizationUsed").map(log => ({ authorizer: log.args.authorizer, nonce: log.args.nonce })),
  };
}

export async function intervalTransfers(rpc, buyer, seller, fromBlock, toBlock) {
  const logs = new Map();
  const event = tokenAbi.find(item => item.type === "event" && item.name === "Transfer");
  for (let start = fromBlock; start <= toBlock; start += 150n) {
    const end = start + 149n < toBlock ? start + 149n : toBlock;
    const options = { address: USDC, event, fromBlock: start, toBlock: end, strict: true };
    const groups = await Promise.all([
      rpc.getLogs({ ...options, args: { from: [getAddress(buyer), getAddress(seller)] } }),
      rpc.getLogs({ ...options, args: { to: [getAddress(buyer), getAddress(seller)] } }),
    ]);
    for (const log of groups.flat()) {
      logs.set(`${log.transactionHash}:${log.logIndex}`, { transactionHash: log.transactionHash, blockNumber: String(log.blockNumber), logIndex: log.logIndex, from: log.args.from, to: log.args.to, value: String(log.args.value) });
    }
  }
  return [...logs.values()];
}
