# F-02: Cloud Cross-Museum Curator (Phase 2-B, protocol 2)

Service: {{BASE_URL}}. Result payee: {{SELLER_ADDRESS}}.
Network: eip155:84532, Base Sepolia testnet only. USDC asset: 0x036CbD53842c5426634e7929541eC2318f3dCF7e.

## Prepare, then purchase the completed result

The cloud agent calls FREE official Met, Cleveland and SMK APIs directly, generates an exhibition, then offers the completed result for one x402 V2 exact payment. There is no upstream x402 purchase and no procurement prepayment. Public metadata: GET /health and GET /F-02.md.

1. Normalize input as {"protocolVersion":2,"goal":"trimmed objective","maxCalls":24}, with that exact key order. goal: 5..2000 characters; maxCalls: integer 6..30, default 24. budgetAtomic is no longer accepted.
2. Generate a random 32-byte lowercase hexadecimal bearer token locally. tokenHash = SHA256(token). jobId = SHA256(JSON.stringify({protocolVersion:2,goal,maxCalls,tokenHash})), preserving the key order. Send the token ONLY in Authorization: Bearer, never in URLs or public evidence.
3. POST /jobs/{jobId} with the normalized JSON body and bearer. HTTP 202 starts free preparation, WITHOUT PAYMENT-SIGNATURE. Repeating this POST with the same input and token is idempotent. A changed goal or call limit cannot reuse the same identifier.
4. GET /jobs/{jobId} with the bearer polls status. HTTP 202 means processing; HTTP 200 with status=ready means a complete result exists. summary includes providers, workCount, generatedAt, reportSha256, priceAtomic=3000, and paymentPath. The report and source records are withheld before payment.
5. POST /jobs/{jobId}/delivery with the bearer, without a payment, returns HTTP 402 + PAYMENT-REQUIRED ONLY when ready. GET on this delivery path also returns the quote. Its resource URL binds the job and its description binds the report SHA256. Price is fixed at 3000 atomic units (0.003 test USDC); free upstream calls add no charges.
6. Validate the exact network/asset/payee/amount/resource/hash and maxTimeoutSeconds=300. Sign with the official x402 SDK, then submit ONE POST to the same /delivery URL with PAYMENT-SIGNATURE. Never automatically retry a signed request. HTTP 202 acknowledges the authorization, not a completed payment.
7. Pre-settlement balance reads, settlement and chain audit run in separate alarms. The accepted authorization is saved before any balance RPC, so a temporary RPC failure resumes the same payment. Poll GET /jobs/{jobId}; it returns HTTP 200 status=complete and delivery only after exact payment and report binding are verified. PAYMENT-RESPONSE is present once settlement is known. Repeated authenticated retrieval is free and stable.
8. POST /jobs/{jobId}/reconcile is read-only for payments and resumes persisted audit progress; it never settles an authorization again. Transient RPC failures normally resume automatically, with node failover and bounded backoff. Unknown or already-used authorizations never permit repayment.

States: queued, planning, fetching, composing, ready, preparing_payment, settling_payment, auditing_payment, reconciling_payment, payment_retry_allowed, complete, failed, needs_attention. Read status and error together. A failed free preparation produces no payable result and no charge. payment_retry_allowed requires the exact nonce to be contract-confirmed unused after its validity ends plus 12 seconds; a new payment then requires an explicit client action. A waiting or failed audit never exposes delivery.

Outputs: summary before payment; after verified payment, delivery.reportMarkdown, reportSha256, resources (official source, normalized public-domain/CC0 metadata, response hash), modelEvidence, generatedAt, feeAtomic and totalUpstreamAtomic="0". purchases is an empty array in protocol 2. incoming records the single local-to-cloud payment, authorization without signature, receipt, exact Transfer, AuthorizationUsed and balance audit.

## Bounds, persistence and recovery

At most 24 distinct museum calls by default (hard configurable cap 30), three concurrent free GETs per batch, ten model planning rounds and fourteen total model requests. Each free GET has at most three attempts. Empty filtered pages advance offset while more results exist. Explicit 404/422 or absent licensed image marks an artwork unavailable; that ID is not fetched again. The application rejects early model finish until all three museums have valid detail responses.

Each alarm performs one phase. Chain audit checkpoints successful reads, limits actual RPC HTTP requests including failover to twelve per invocation, and resumes in another alarm. RPC errors switch nodes; transient failures back off at most six consecutive times before needs_attention. A lost settlement response triggers exact-nonce read-only reconciliation, scanning at most 150 blocks in one phase, never resettlement.

SQLite-backed Durable Objects store task state, bounded intermediate JSON and final reports for seven days. Each record is at most 2 MiB, model request/response at most 128 KiB. No temporary filesystem is needed. Museum image URLs, sources and rights are retained; the cloud does not copy image binaries.

Because preparation precedes payment and uses operator-funded model API calls, the service limits preparation to ten jobs per UTC day globally and six per source IP per UTC day. Repeated creation of one job does not consume another quota slot. A separate daily cap of ten incoming authorization claims remains. Model API fees are paid by the operator.

This is a testnet experiment, without production SLA or automatic refunds. Older protocol-1 paid jobs retain their original stored reports and recovery handler; new jobs use only protocol 2. Historical two-hop payment evidence is not proof of the current one-hop flow. Phase 2-A remains a separate service.

Never expose the bearer token, wallet key, model key, reusable PAYMENT-SIGNATURE or private payment payload. The model cannot choose hosts, wallets, prices or execution limits.
