import { readFileSync, writeFileSync } from "node:fs";
import { auditPurchase, chainClient } from "./chain.mjs";
import { validateCuratorDelivery } from "./curator-purchase.mjs";
import { paymentAmount, sha256 } from "../src/agent-contract.mjs";
import { reconcilePurchase } from "./reconcile.mjs";
const id = process.argv[2];
if (!/^[a-f0-9]{64}$/.test(id ?? "")) throw new Error("Pass a job id");
const acceptance = JSON.parse(readFileSync(`evidence/phase2b/acceptance-${id}.json`, "utf8"));
const job = JSON.parse(readFileSync(`evidence/phase2b/job-${id}.json`, "utf8"));
if (job.status !== "complete" || sha256(job.delivery.reportMarkdown) !== job.delivery.reportSha256) throw new Error("Completed and intact delivery required");
const providers = [{ name: "Tenderly", url: "https://base-sepolia.gateway.tenderly.co" }, { name: "Pocket", url: "https://base-testnet.api.pocket.network" }];
const evidence = { checkedAt: new Date().toISOString(), jobId: id, newPayments: 0, results: [], passed: false };
const paidPurchases = job.delivery.purchases.filter(record => record.status === "verified");
const unpaidAttempts = [...(job.delivery.priorAttempts ?? []), ...job.delivery.purchases.filter(record => record.status === "confirmed_unpaid")];
const save = () => writeFileSync(`evidence/phase2b/independent-audit-${id}.json`, JSON.stringify(evidence, null, 2) + "\n");
for (const provider of providers) {
  const rpc = chainClient({ env: { BASE_SEPOLIA_RPCS: provider.url } });
  for (const [index, original] of [acceptance, ...paidPurchases].entries()) {
    const record = structuredClone(original);
    const result = { provider: provider.name, hop: index === 0 ? "local_to_cloud" : "cloud_to_resource", service: record.resourceService ?? "cloud-curation", transaction: record.settlement?.transaction };
    try {
      if (index > 0 && record.buyer.toLowerCase() !== acceptance.seller.toLowerCase()) throw new Error("Cloud buyer is not the incoming payee");
      await auditPurchase(record, rpc, { allowConcurrentTransfers: true, ...(index === 0 ? { expectedAmount: paymentAmount(acceptance.input), deliveryStatus: 202, validateDelivery: response => { if (response.jobId !== id) throw new Error("Wrong job acceptance"); } } : { validateDelivery: validateCuratorDelivery }) });
      result.status = record.status; result.audit = record.audit; result.receipt = record.receipt; result.before = record.beforeObserved; result.after = record.after;
    } catch (error) { result.status = "audit_error"; result.error = error.shortMessage ?? "RPC audit unavailable"; }
    evidence.results.push(result); save(); console.log(JSON.stringify({ provider: provider.name, service: result.service, status: result.status }));
  }
  for (const record of unpaidAttempts) {
    const result = { provider: provider.name, hop: "unpaid_attempt", service: record.resourceService, nonce: record.authorization.nonce };
    try { result.reconciliation = await reconcilePurchase(record, rpc, { allowConcurrentTransfers: true }); result.status = result.reconciliation.safeToRetry ? "confirmed_unpaid" : "unresolved"; }
    catch { result.status = "audit_error"; }
    evidence.results.push(result); save(); console.log(JSON.stringify({ provider: provider.name, service: result.service, status: result.status }));
  }
}
evidence.passed = evidence.results.length === providers.length * (paidPurchases.length + 1 + unpaidAttempts.length) && evidence.results.every(result => ["verified", "confirmed_unpaid"].includes(result.status)); save();
console.log(JSON.stringify({ passed: evidence.passed, checks: evidence.results.length, newPayments: 0 }));
if (!evidence.passed) process.exitCode = 1;
