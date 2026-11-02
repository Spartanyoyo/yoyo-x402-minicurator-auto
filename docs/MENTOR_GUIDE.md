# Mentor 审阅指南

当前最新阶段：第二阶段B（2026-11-02）。下面先给出云端Agent的审阅路径，再保留第一阶段的历史验收指南。审阅源码、报告和已有证据无需付款，也不需要取得私钥或模型API密钥。

## 第二阶段 B：建议的 5–10 分钟审阅顺序

1. 阅读[2-B验收报告](第二阶段B_验收报告.md)，了解本地提交目标、云端采购与整合、最终交付的完整闭环。
2. 查看[云端生成的15分钟猫主题展览](第二阶段B_云端生成猫主题展览.md)，确认三馆作品、来源、许可和交易引用。图片是馆方HTTPS外链；若预览器未显示，可打开图像链接检查。
3. 查看[正常任务完整交付](../evidence/phase2b/job-89a152f2e8d0bcb4e9826168da9ac7746698fe9c56a85177bec2690a51862b89.json)：本地只购买一次任务，云端自主完成6项资源采购，约32秒后交付；本地不逐个选择或购买博物馆API。
4. 查看[双RPC独立重审](../evidence/phase2b/independent-audit-89a152f2e8d0bcb4e9826168da9ac7746698fe9c56a85177bec2690a51862b89.json)：两跳共7笔付款，由两家RPC交叉验证，14/14通过。另有[故障恢复重审](../evidence/phase2b/independent-audit-181017958d850143f992122ffcfa0b8029b365e5f686818394dcac23b521ffde.json)，16/16通过，包括2个经证明未付款的授权尝试。
5. 查看[最终检查摘要](../evidence/phase2b/final-verification.json)、[重复取件检查](../evidence/phase2b/redelivery-89a152f2e8d0bcb4e9826168da9ac7746698fe9c56a85177bec2690a51862b89.json)和[使用说明](第二阶段B_使用说明.md)，核对185项测试、存储、并行、恢复与运行边界。

### 关键代码

| 文件 | 审阅重点 |
|---|---|
| [agent-job.mjs](../src/agent-job.mjs) | 持久化任务状态机、预算预留、nonce认领、付款队列与恢复 |
| [agent-model.mjs](../src/agent-model.mjs) | 白名单工具规划、模型请求限制、基于采购记录生成交付 |
| [chain.mjs](../scripts/chain.mjs) | 两跳付款审查、精确Transfer、授权事件与共享钱包余额解释 |
| [agent.test.mjs](../test/agent.test.mjs) | 重放、崩溃、预算、并发、未知付款和重复取件测试 |

本地只读验证（Node.js 24，不需要密钥，不会付款）：

```bash
npm ci
npm run verify
```

当前仅为Base Sepolia测试网；未用预付款不自动退款，模型讲解需人工审核，原有Zod依赖公告仍有记录。Cloudflare云端任务保留七天；仓库中的脱敏证据和展览文件可长期审阅。详细边界见[验收报告](第二阶段B_验收报告.md)。

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
