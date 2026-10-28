# 项目证据索引

第二阶段 MiniCurator 的出站、部署、报价、购买与异常对账证据集中在 [phase2a](phase2a/README.md)。下文保留第一阶段历史索引。

本目录收录第一阶段在 Node、本地 Workers、Cloudflare 和 Base Sepolia 上产生的可复核记录。建议按下面的顺序阅读：

完整的公开证据文件、大小和 SHA256 见[证据清单](MANIFEST.md)。原始敏感诊断仅保存在本机被忽略的 local-only/ 目录。

1. [完整复核报告](../docs/第一阶段_复核报告_2026-10-22.md)：范围、修复、测试与结论。
2. [2026-10-22 云端购买](transactions/purchase-1792639327312.json)：402 → 200、天气交付、链上回执与双方余额。
3. [自动化测试结果](verification/tests-review-2026-10-22.xml)：65 项通过、0 失败。
4. [独立交易复审](transactions/purchase-1792639327312-independent-reaudit-2026-10-22.json)：复制原记录后重新查账。
5. [交易跨节点核验](transactions/transaction-rpc-crosscheck-summary-2026-10-22.json)：两个独立公共 RPC 得到相同结果。

## 目录

| 目录 | 内容 |
|---|---|
| [phase2a](phase2a/README.md) | MiniCurator 选题、云端实施与逐资源测试网采购 |
| [transactions](transactions/README.md) | 三笔成功测试交易、链上复审、跨节点核验、钱包与地点证据 |
| [verification](verification/README.md) | 自动化测试、接口边界、部署、RPC、依赖审计和发布检查 |
| [history](history/README.md) | 失败尝试、授权到期核对、免费探针及排查过程 |

## 金额与时间口径

- Base Sepolia 测试 USDC 的 `1000` 个最小单位等于 `0.001` 测试 USDC。
- JSON 时间主要为 ISO 8601 UTC；报告通常使用北京时间（UTC+8）。
- 三笔成功交易合计 `0.003` 测试 USDC：本地一笔、2026-10-16 云端一笔、2026-10-22 云端一笔。
- 一次 HTTP 402 成功或交易签名存在，都不等于卖方已经收到款项。最终验收同时检查成功回执、精确金额、授权编号、双方余额和区间内相关转账。
- 失败尝试记录保持原样；没有因查账失败而自动重复付款。
