import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { auditPurchase, balances, chainClient, decodeUsdcEvents, rpcUrls } from "./chain.mjs";
import { validateCuratorDelivery } from "./curator-purchase.mjs";
import { NETWORK, PRICE_ATOMIC, USDC } from "../src/app.mjs";
import { SERVICES } from "../src/curator-catalog.mjs";

const { values } = parseArgs({ options: {
  demo: { type: "string", default: "evidence/phase2a/demo-session.json" },
  "primary-rpc": { type: "string" },
  "secondary-rpc": { type: "string" },
  attempts: { type: "string", default: "2" },
  out: { type: "string" },
} });

const sessionPath = values.demo;
const session = JSON.parse(await readFile(sessionPath, "utf8"));
const sessionDirectory = "evidence/phase2a";
const requiredServices = new Set(Object.keys(SERVICES));
const failures = [];
const assertCheck = (condition, message) => { if (!condition) failures.push(message); };
const attempts = Number(values.attempts);
if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) throw new Error("--attempts must be an integer in 1..5");

assertCheck(session.status === "completed_verified", "demo session is not completed_verified");
assertCheck(Array.isArray(session.unresolvedSignedAttempts) && session.unresolvedSignedAttempts.length === 0, "demo session has unresolved signed attempts");
assertCheck(BigInt(session.openingBalances.buyer) - BigInt(session.closingBalances.buyer) === BigInt(PRICE_ATOMIC) * 9n, "buyer balance change is not 9000 atomic units");
assertCheck(BigInt(session.closingBalances.seller) - BigInt(session.openingBalances.seller) === BigInt(PRICE_ATOMIC) * 9n, "seller balance change is not 9000 atomic units");

const verifiedEntries = session.purchases.filter(entry => entry.status === "verified");
assertCheck(verifiedEntries.length === 9, `expected 9 verified purchase entries, found ${verifiedEntries.length}`);
assertCheck(new Set(verifiedEntries.map(entry => entry.service)).size === 9, "verified purchases do not cover nine distinct services");
assertCheck([...requiredServices].every(service => verifiedEntries.some(entry => entry.service === service)), "one or more required services lack a verified purchase");
assertCheck(new Set(verifiedEntries.map(entry => entry.transaction)).size === 9, "verified purchases do not have nine distinct transactions");

const records = new Map();
for (const entry of verifiedEntries) {
  const path = `${sessionDirectory}/${entry.evidence}`;
  const raw = await readFile(path);
  const record = JSON.parse(raw.toString("utf8"));
  records.set(entry.service, { path, sha256: createHash("sha256").update(raw).digest("hex"), record });
  assertCheck(record.status === "verified", `${entry.service}: evidence file is not verified`);
  assertCheck(record.resourceService === entry.service, `${entry.service}: file/service mismatch`);
  assertCheck(record.network === NETWORK && record.asset?.toLowerCase() === USDC.toLowerCase(), `${entry.service}: wrong network or asset`);
  assertCheck(record.settlement?.network === NETWORK, `${entry.service}: wrong settlement network`);
  assertCheck(record.receipt?.transactionHash?.toLowerCase() === entry.transaction?.toLowerCase(), `${entry.service}: transaction mismatch`);
  assertCheck(record.http?.some(http => http.paid && http.status === 200), `${entry.service}: no paid HTTP 200 response`);
  assertCheck(record.audit?.deliveryVerified === true, `${entry.service}: recorded delivery is not verified`);
}

const detailByMuseum = { Met: "met-artwork", CMA: "cma-artwork", SMK: "smk-artwork" };
for (const selected of session.selectedWorks ?? []) {
  const service = detailByMuseum[selected.museum];
  const item = records.get(service)?.record.response?.resource?.items?.[0];
  assertCheck(Boolean(item), `${selected.museum}: selected artwork detail is missing`);
  if (!item) continue;
  for (const field of ["id", "title", "imageUrl", "sourceUrl", "rights"]) assertCheck(JSON.stringify(item[field]) === JSON.stringify(selected[field]), `${selected.museum}: selected work field ${field} does not match purchased evidence`);
}

const related = {
  "met-search": "552027",
  "cma-artwork-search": "152829",
  "cma-artist-search": "31140",
  "smk-search": "KMS3402",
};
for (const [service, id] of Object.entries(related)) {
  assertCheck(records.get(service)?.record.response?.resource?.items?.some(item => item.id === id), `${service}: selected cross-resource ID ${id} is missing`);
}
assertCheck(records.get("cma-artist")?.record.response?.resource?.items?.[0]?.artworks?.some(item => item.id === "152829"), "cma-artist: selected artwork relation is missing");
assertCheck((session.assertions ?? []).every(item => item.passed === true), "one or more recorded cross-resource assertions failed");
const crossResourceArtworkSelection = failures.every(message => !message.includes("selected cross-resource") && !message.includes("selected artwork relation") && !message.includes("selected work field") && !message.includes("selected artwork detail"));

const configuredRpcs = rpcUrls();
const primaryRpc = values["primary-rpc"] ?? process.env.PHASE2A_PRIMARY_RPC ?? configuredRpcs[0];
const secondaryRpc = values["secondary-rpc"] ?? process.env.PHASE2A_SECONDARY_RPC ?? configuredRpcs.find((url, index) => index > 0 && !/drpc|sentio|nodies/.test(url));
assertCheck(Boolean(primaryRpc && secondaryRpc), "two RPC endpoints are required");
assertCheck(primaryRpc !== secondaryRpc, "primary and secondary RPC endpoints must differ");

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function withRetry(operation) {
  const history = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const value = await operation();
      history.push({ attempt, status: "passed" });
      return { ok: true, value, attempts: history };
    } catch (error) {
      history.push({ attempt, status: "failed", error: error.shortMessage ?? error.message });
      if (attempt < attempts) await delay(1500 * attempt);
    }
  }
  return { ok: false, error: history.at(-1).error, attempts: history };
}

async function primaryAudit(source, endpoint) {
  const audited = structuredClone(source.record);
  await auditPurchase(audited, chainClient({ env: { BASE_SEPOLIA_RPCS: endpoint } }), { validateDelivery: validateCuratorDelivery });
  if (audited.status !== "verified" || !audited.audit?.paymentVerified || !audited.audit?.deliveryVerified) throw new Error(audited.error ?? `primary audit status: ${audited.status}`);
  return {
    status: audited.status,
    paymentVerified: audited.audit.paymentVerified,
    deliveryVerified: audited.audit.deliveryVerified,
    authorizationFieldsMatch: audited.audit.authorizationFieldsMatch,
    authorizationEventMatch: audited.audit.authorizationEventMatch,
    authorizationTimeMatch: audited.audit.authorizationTimeMatch,
    settlementPayerMatches: audited.audit.settlementPayerMatches,
    declaredTermsMatch: audited.audit.declaredTermsMatch,
    exactTransfer: audited.audit.exactTransfer,
    noOtherTransfers: audited.audit.noOtherTransfers,
    buyerDelta: audited.audit.buyerDelta,
    sellerDelta: audited.audit.sellerDelta,
    blockNumber: audited.receipt.blockNumber,
  };
}

async function secondaryCheck(source, endpoint) {
  const rpc = chainClient({ env: { BASE_SEPOLIA_RPCS: endpoint } });
  if (await rpc.getChainId() !== 84532) throw new Error("secondary RPC is not Base Sepolia");
  const receipt = await rpc.waitForTransactionReceipt({ hash: source.record.settlement.transaction, timeout: 60000 });
  const block = await rpc.getBlock({ blockNumber: receipt.blockNumber });
  const { transfers, authorizationEvents } = decodeUsdcEvents(receipt.logs);
  const before = await balances(rpc, source.record.buyer, source.record.seller, BigInt(source.record.before.block));
  const after = await balances(rpc, source.record.buyer, source.record.seller, receipt.blockNumber);
  const exactTransfer = transfers.length === 1 && transfers[0].from.toLowerCase() === source.record.buyer.toLowerCase() && transfers[0].to.toLowerCase() === source.record.seller.toLowerCase() && transfers[0].value === PRICE_ATOMIC;
  const authorizationEventMatch = authorizationEvents.length === 1 && authorizationEvents[0].authorizer.toLowerCase() === source.record.buyer.toLowerCase() && authorizationEvents[0].nonce.toLowerCase() === source.record.authorization?.nonce?.toLowerCase();
  const authorizationTimeMatch = /^\d+$/.test(source.record.authorization?.validAfter ?? "") && /^\d+$/.test(source.record.authorization?.validBefore ?? "") && BigInt(source.record.authorization.validAfter) <= block.timestamp && block.timestamp <= BigInt(source.record.authorization.validBefore);
  const result = {
    transactionMatches: receipt.transactionHash.toLowerCase() === source.record.settlement.transaction.toLowerCase(),
    blockMatches: String(receipt.blockNumber) === String(source.record.receipt.blockNumber),
    chainSuccess: receipt.status === "success",
    exactTransfer,
    authorizationEventMatch,
    authorizationTimeMatch,
    initialBalancesMatch: before.buyer === source.record.before.buyer && before.seller === source.record.before.seller,
    finalBalancesMatch: after.buyer === source.record.after.buyer && after.seller === source.record.after.seller,
    before,
    after,
    buyerDelta: String(BigInt(before.buyer) - BigInt(after.buyer)),
    sellerDelta: String(BigInt(after.seller) - BigInt(before.seller)),
  };
  if (!result.transactionMatches || !result.blockMatches || !result.chainSuccess || !result.exactTransfer || !result.authorizationEventMatch || !result.authorizationTimeMatch || !result.initialBalancesMatch || !result.finalBalancesMatch) throw new Error("secondary RPC receipt, authorization, or snapshot differs");
  if (result.buyerDelta !== PRICE_ATOMIC || result.sellerDelta !== PRICE_ATOMIC) throw new Error("secondary RPC balances differ by an unexpected amount");
  return result;
}

const chainResults = [];
if (primaryRpc && secondaryRpc && primaryRpc !== secondaryRpc) {
  for (const service of Object.keys(SERVICES)) {
    const source = records.get(service);
    if (!source) continue;
    const primary = await withRetry(() => primaryAudit(source, primaryRpc));
    assertCheck(primary.ok, `${service}: primary RPC audit failed after ${attempts} attempt(s)`);
    const secondary = await withRetry(() => secondaryCheck(source, secondaryRpc));
    assertCheck(secondary.ok, `${service}: secondary RPC check failed after ${attempts} attempt(s)`);
    chainResults.push({ service, evidence: source.path, evidenceSha256: source.sha256, transaction: source.record.settlement.transaction, primary, secondary });
    console.log(`${service}: primary=${primary.ok ? "verified" : "error"}; secondary=${secondary.ok ? "ok" : "error"}`);
  }
}

const primaryPassed = chainResults.length === 9 && chainResults.every(item => item.primary.ok);
const secondaryPassed = chainResults.length === 9 && chainResults.every(item => item.secondary.ok);
const requirements = {
  nineDistinctServices: records.size === 9,
  paidHttpAndDeliveryEvidence: [...records.values()].every(item => item.record.http?.some(http => http.paid && http.status === 200) && item.record.audit?.deliveryVerified === true),
  crossResourceArtworkSelection,
  primaryRpcFullAudit: primaryPassed,
  independentSecondaryReceiptAuthorizationAndBalanceQuery: secondaryPassed,
};
const report = {
  checkedAt: new Date().toISOString(),
  scope: "Read-only Phase 2A acceptance audit; no signatures, payments, deployment or source mutation",
  passed: failures.length === 0 && Object.values(requirements).every(Boolean),
  failures,
  input: { session: sessionPath, sessionSha256: createHash("sha256").update(await readFile(sessionPath)).digest("hex") },
  requirements,
  rpc: { primary: primaryRpc, secondary: secondaryRpc, attempts },
  records: chainResults,
};

const output = values.out ?? `evidence/phase2a/independent-chain-reaudit-${Date.now()}.json`;
await mkdir("evidence/phase2a", { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ out: output, passed: report.passed, failures: failures.length, services: chainResults.length, primaryRpc, secondaryRpc }, null, 2));
if (!report.passed) process.exitCode = 1;