# Mentor 审阅指南

2026-11-06 补充：原始 HTTP 422 的立即跳过、作品替换和旧缓存边界已修正，见[修订报告补充](第二阶段B_Mentor反馈修订报告.md#2026-11-06-http-422-后续修正)与[回归证据](../evidence/phase2b/review-2026-11-06/http422-regression.json)。下文 2026-11-03 的测试数量、部署和付款结果为此前完整验收快照。

当前最新阶段：第二阶段 B 的 mentor 修订版（2026-11-03，协议 2）。云端直接调用三馆免费 API，先生成，再由本地通过 x402 付费取件。审阅源码、报告和已有证据无需付款，也不需要取得私钥或模型 API 密钥。

## 第二阶段 B：建议的 5–10 分钟审阅顺序

1. 阅读 [Mentor 反馈修订报告](第二阶段B_Mentor反馈修订报告.md)，按问题表核对架构、subrequest、临时 RPC、不可用作品与空页处理。
2. 查看四个云端成品：[猫](examples/phase2b-v2-cats.md)、[鸟类](examples/phase2b-v2-birds.md)、[风景](examples/phase2b-v2-landscape.md)、[花卉](examples/phase2b-v2-flowers.md)。每个成品都包含三馆作品、15 分钟路线、观察问题、馆方图片与公版来源。
3. 查看 [四主题场景矩阵](../evidence/phase2b/review-2026-11-03/scenarios.json)和[证据索引](../evidence/phase2b/README.md)：付款前只返回摘要和成品哈希；付款后哈希相同，且上游付款为 0。
4. 查看[鸟类任务完整交付](../evidence/phase2b/job-bea2eda61b5df1adc0f10ba588c1840a0ced66b2833b4c9399dbfb8119123deb.json)、[双 RPC 独立重审](../evidence/phase2b/independent-audit-bea2eda61b5df1adc0f10ba588c1840a0ced66b2833b4c9399dbfb8119123deb.json)与[重复取件](../evidence/phase2b/redelivery-bea2eda61b5df1adc0f10ba588c1840a0ced66b2833b4c9399dbfb8119123deb.json)。两家 RPC 验证同一笔本地到云端的 3000 原子单位支付；此任务实际跳过了三件不可用 Met 作品。
5. 查看[当前检查摘要](../evidence/phase2b/review-2026-11-03/final-verification.json)、[使用说明](第二阶段B_使用说明.md)和 [F-02](F-02_cloud-curator.md)，核对 211 项测试、持久化、并行上限和恢复边界。

### 关键代码

| 文件 | 审阅重点 |
|---|---|
| [agent-job.mjs](../src/agent-job.mjs) | 先准备后付款的持久化状态机、分阶段 alarm 与结果门控 |
| [agent-tools.mjs](../src/agent-tools.mjs) | 免费官方 API、不可用作品替换、空页续翻与三馆详情检查 |
| [agent-payment.mjs](../src/agent-payment.mjs) | 实际 RPC 请求上限、读取缓存、退避切换与只读查账 |
| [agent-model.mjs](../src/agent-model.mjs) | 白名单规划、调用上限、来源与生成内容绑定 |
| [chain.mjs](../scripts/chain.mjs) | 精确 Transfer、AuthorizationUsed、授权字段与余额核对 |
| [agent-v2.test.mjs](../test/agent-v2.test.mjs) | 26 项新协议回归；旧协议测试另行保留 |

本地只读验证（Node.js 24，不需要密钥，不会付款）：

```bash
npm ci
npm run verify
```

当前仅为 Base Sepolia 测试网，模型讲解仍需人工审核。任务和成品在 Durable Objects 保留七天；免费准备任务受每日配额限制，失败生成不收费。仓库中的脱敏证据和展览可长期审阅。2026-11-02 的两跳付款、预算预留和恢复材料保留在[协议 1 历史验收报告](第二阶段B_验收报告.md)，不代表当前新任务流程；旧存储任务继续使用兼容处理器。

---

## 第一阶段历史审阅指南（2026-10-22）

以下内容保留第一阶段当时的验收语境。

## 1. 先看完成结论

第一阶段实现了一条完整的可支付数据链路：

1. 用户用自然语言提出天气需求。
2. Codex 读取云端 F-02，确定十进制坐标。
3. 未付款请求收到 HTTP 402 和 x402 V2 exact quote。
4. 官方 SDK 使用 Base Sepolia 测试 USDC 创建一次授权并提交一次付费请求。
5. Worker 从 MET Norway 取得天气模型数据。
6. 响应返回 HTTP 200、`requestId` 和支付回执。
7. 查账工具独立核实交易回执、USDC Transfer、双方余额与天气交付。

请先阅读[最新复核报告](../docs/第一阶段_复核报告_2026-10-22.md)。

## 2. 核对最新真实交易

打开[最新购买记录](../evidence/transactions/purchase-1792639327312.json)，按以下字段阅读：

| 字段 | 应看到的内容 |
|---|---|
| `intent` | 用户的天气需求 |
| `documentation` | 实际读取的 F-02、时间和 SHA256 |
| `http[0]` | 未付款请求，状态 402 |
| `http[1]` | 付费请求，状态 200，请求编号与正文一致 |
| `response.weather` | 北京、MET Norway、温度/湿度/风速、时间和来源 |
| `settlement` | 成功结算与交易哈希 |
| `receipt` | 成功回执和区块号 |
| `before` / `after` | 买方 19.998 → 19.997；卖方 0.002 → 0.003 |
| `audit` | 付款和天气交付均通过 |
| `status` | `verified` |

交易哈希：

```text
0x7858f5bc9d2d3c22f9709c200f84b86f1dd2927242d126fce90bc00bf4856ff1
```

[Base Sepolia 浏览器](https://sepolia.basescan.org/tx/0x7858f5bc9d2d3c22f9709c200f84b86f1dd2927242d126fce90bc00bf4856ff1)

随后打开[独立复审副本](../evidence/transactions/purchase-1792639327312-independent-reaudit-2026-10-22.json)与[跨节点交叉核验](../evidence/transactions/transaction-rpc-crosscheck-summary-2026-10-22.json)。前者在不修改原记录的情况下重做查账；后者由两个不同公共 RPC 分别确认相同回执和余额。

## 3. 核对第一次验收

[第一阶段验收报告](../docs/第一阶段_验收报告.md)列出 A1–A10 与 2026-10-16 首次云端交易：

```text
0x5ab696456203ce6ec4d8525cada0a30751e915e9636cc289a00838a6c85001f7
```

对应原始记录和[历史独立复审](../evidence/verification/historical-reaudit-2026-10-22.json)均保留。

## 4. 核对测试与修复

[2026-10-22 复核报告](../docs/第一阶段_复核报告_2026-10-22.md)说明了旧实现上复现的 11 项失败、修复内容和最终结果。

关键证据：

- [65 项 JUnit 测试](../evidence/verification/tests-review-2026-10-22.xml)
- [30 项接口边界检查](../evidence/verification/integration-review-2026-10-22.json)
- [RPC 多节点完整操作核验](../evidence/verification/rpc-pool-review-2026-10-22.json)
- [依赖审计](../evidence/verification/dependency-audit-final-2026-10-22.json)
- [凭据扫描](../evidence/verification/credential-scan-review-2026-10-22.json)

## 5. 可选：检查在线状态

以下命令只读取免费文档、健康检查和未付款 402，不签名、不付款：

```bash
npm ci
npm run probe -- https://yoyo-x402-weather.accessible-trip.workers.dev
```

预期状态顺序：`200 / 200 / 402`。

## 6. 需要保留的判断边界

- 天气数据是 MET Norway 模型预报，不是气象站实时观测。
- 支付使用 Base Sepolia 测试 USDC，不代表真实资金结算。
- 公共天气源、facilitator、RPC 和网络可能波动；本阶段提供失败后查账与防重复付款规则，不承诺生产级 SLA。
- 此项为2026-10-22历史状态：当时第二、第三阶段尚未开展；当前第二阶段A、B已完成，见本页顶部入口。

完整证据地图见[证据索引](../evidence/README.md)。
