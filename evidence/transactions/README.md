# 成功交易与链上证据

## 2026-10-22 云端最终交易

- [完整购买记录](purchase-1792639327312.json)：用户意图、F-02、报价、付费请求、天气正文、回执与余额快照。
- [独立复审副本](purchase-1792639327312-independent-reaudit-2026-10-22.json)：对复制记录再次运行只读查账，不修改原记录。
- [跨节点核验摘要](transaction-rpc-crosscheck-summary-2026-10-22.json)：Tenderly 与 Nodies 确认相同回执、区块和双方余额。
- [第一轮原始查询](transaction-rpc-crosscheck-2026-10-22.json)与[第二轮原始查询](transaction-rpc-crosscheck-second-2026-10-22.json)：保留节点失败与成功结果。
- 交易：`0x7858f5bc9d2d3c22f9709c200f84b86f1dd2927242d126fce90bc00bf4856ff1`
- 买方余额：`19.998 → 19.997`；卖方余额：`0.002 → 0.003` 测试 USDC。

## 2026-10-16 云端首次交易

- [完整购买记录](purchase-1792155501626.json)
- [独立链上查账](final-chain-audit-1792155650115.json)
- 交易：`0x5ab696456203ce6ec4d8525cada0a30751e915e9636cc289a00838a6c85001f7`

## 本地联调

- [本地成功购买](purchase-1792148046905.json)：真实 Base Sepolia 测试资产，状态 `verified`。

## 公开基本信息

- [买卖双方地址与网络](wallets-public.json)
- [北京代表坐标来源](location-beijing.json)
