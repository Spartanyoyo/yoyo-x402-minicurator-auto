# F-02: Cloud Cross-Museum Curator (Phase 2-B)

Service: {{BASE_URL}}. Payee / dedicated cloud buyer: {{SELLER_ADDRESS}}.
Network: eip155:84532, Base Sepolia testnet only. USDC asset: 0x036CbD53842c5426634e7929541eC2318f3dCF7e.

## Contract

The local agent supplies a goal, pays once with x402 V2 exact, and retrieves the finished report. The cloud model chooses and buys the Phase 2-A museum APIs and writes the exhibition. Public health: GET /health.

- Body: {"goal":"Chinese or English cross-museum curation objective","budgetAtomic":"9000"}. Goal: 5..2000 characters. Budget: 3000..9000, in multiples of 1000. Lower budgets are rejected before payment because three museums require at least three detail calls.
- Generate a random 32-byte lowercase hex bearer token locally; send it ONLY in Authorization: Bearer. Keep it private for redelivery.
- jobId is SHA256 of JSON.stringify({goal:trimmedGoal,budgetAtomic,tokenHash:SHA256(token)}) with that exact key order.
- POST /jobs/{jobId}, same body and bearer token. Unpaid response: HTTP 402 + PAYMENT-REQUIRED. Price = budgetAtomic + 3000 service fee, maximum 12000 atomic test USDC.
- Sign the exact quote with the official x402 SDK and submit one paid POST with PAYMENT-SIGNATURE. No redirect or automatic paid retry. The receipt is PAYMENT-RESPONSE.
- An accepted task returns HTTP 202. GET /jobs/{jobId} with the token returns 202 while pending, 200 with delivery when complete. No second payment for status or redelivery.
- POST /jobs/{jobId}/reconcile with the token checks chain state first. A contract-confirmed unused authorization, expired by more than 12 seconds, permits one new attempt within the original reserved budget. An unknown or already-paid outcome never permits repayment. A second proven-unpaid failure is retained and the model may select a different call within its remaining budget.
- Job states: awaiting_payment, accepting_payment, queued, planning, buying, waiting_reconciliation, composing, complete, needs_attention. Read status and error together; 202 is not proof of completion.
- Outputs: delivery.reportMarkdown, reportSha256, purchases (documentation, authorization fields without signature, settlement, chain/nonce/events/balance/delivery audits), modelEvidence, completedAt and totalUpstreamAtomic.

## Limits and custody

Maximum 9 distinct calls, 3 concurrent operations per job, 5 planning rounds and 7 model requests total. Each resource costs 1000 atomic units. Calls are reserved before execution. The shared facilitator payment lane serializes paid HTTP submissions to avoid relayer nonce races; free reads and audits can run concurrently. At most one retry is allowed per proven-unpaid call. Unknown outcomes retain budget and never cause repayment. A global cap allows at most 10 new incoming authorization claims per UTC day.

Jobs, intermediate JSON, receipts and reports live in SQLite-backed Durable Objects for seven days; unpaid draft jobs expire after one hour. Atomic chunks have size caps and integrity hashes. Image files remain at the museums: reports include verified public-domain/CC0 image URLs, sources and attribution. No local filesystem is required by the Worker.

The service is a prepaid testnet experiment. The cloud wallet receives the full quoted budget plus fee. Unspent budget is reported but is NOT automatically refunded. API/model/upstream failures may produce needs_attention instead of a report. There is no production SLA, automatic refund, mainnet support or guarantee of museum availability. Model API charges are billed separately to the operator.

Both payment hops preserve authorization nonce, exact USDC Transfer, AuthorizationUsed event, payer/payee, validity-window and independent balance checks. Concurrent transfers are enumerated and their net effects must explain both balance deltas; a balance change alone is never sufficient proof.

Never place the bearer token, wallet key, model key or reusable PAYMENT-SIGNATURE in public evidence, URLs, logs or prompts. The model cannot choose hosts, prices, wallets, secrets or concurrency limits.
