# Mentor 审阅指南

这份指南用于在 5–10 分钟内判断第一阶段是否真实完成。所有结论都能在仓库内找到对应证据；审阅无需再次付款。

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
- 第二、第三阶段尚未开展。

完整证据地图见[证据索引](../evidence/README.md)。