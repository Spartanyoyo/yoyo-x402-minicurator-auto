import { readFileSync, writeFileSync } from "node:fs";
import { sha256 } from "../src/agent-contract.mjs";
const read = path => JSON.parse(readFileSync(path, "utf8"));
const normal = "89a152f2e8d0bcb4e9826168da9ac7746698fe9c56a85177bec2690a51862b89";
const recovery = "181017958d850143f992122ffcfa0b8029b365e5f686818394dcac23b521ffde";
const testLog = readFileSync("local-only/phase2b/verify-final.log", "utf8");
const targetedLog = readFileSync("local-only/phase2b/agent-final-tests.log", "utf8");
const checks = {
  fullSuite: /tests 185/.test(testLog) && /pass 185/.test(testLog) && /fail 0/.test(testLog),
  targetedAfterFinalBounds: /tests 35/.test(targetedLog) && /pass 35/.test(targetedLog) && /fail 0/.test(targetedLog),
  threeDryRunBuilds: (testLog.match(/--dry-run: exiting now/g) ?? []).length === 3,
  normalDoubleRpc: read(`evidence/phase2b/independent-audit-${normal}.json`).passed,
  recoveryDoubleRpc: read(`evidence/phase2b/independent-audit-${recovery}.json`).passed,
  redelivery: read(`evidence/phase2b/redelivery-${normal}.json`).passed,
  liveProbe: read("evidence/phase2b/probe.json").passed,
  docs: read("evidence/phase2b/docs-check.json").passed,
  credentialScan: read("evidence/phase2b/security-check.json").passed,
};
if (!Object.values(checks).every(Boolean)) throw new Error("Final evidence includes a failed check");
const sources = ["src/agent-worker.mjs", "src/agent-job.mjs", "src/agent-model.mjs", "src/agent-contract.mjs", "src/agent-evidence.mjs", "scripts/purchase.mjs", "scripts/chain.mjs", "scripts/reconcile.mjs", "wrangler.agent.jsonc"];
const result = { status: "phase2b_testnet_complete", checkedAt: new Date().toISOString(), checks, testsPassed: 185, normalJob: normal, recoveryJob: recovery, normalDurationSeconds: 32.003, normalAuditChecks: 14, recoveryAuditChecks: 16, newPaymentsForAudit: 0, deployment: read("evidence/phase2b/deployment.json"), normalE2eExecutionVersion: "69ce185f-e35e-49e4-9f5a-1b8df7bfea3b", subsequentChanges: "Added model-input size and minimum three-museum budget guards; targeted tests, deployment and live unpaid probes passed", sourceHashes: Object.fromEntries(sources.map(path => [path, sha256(readFileSync(path))])), dependencyAudit: read("local-only/phase2b/dependency-audit.json").metadata?.vulnerabilities, limitations: ["Base Sepolia testnet only", "Unused prepaid budget is not automatically refunded", "A lost paid upstream response cannot be redelivered by the Phase 2-A provider", "Model prose requires human review", "Existing upstream Zod advisory remains; functional acceptance is not production clearance"] };
writeFileSync("evidence/phase2b/final-verification.json", JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ status: result.status, checks, testsPassed: result.testsPassed }));
