# 第二阶段 B 证据

## 当前：协议 2（2026-11-03）

云端直接调用三馆免费 API，成品准备好后，本地通过 x402 支付固定 3000 原子单位测试 USDC 取件。先读 [Mentor 修订报告](../../docs/第二阶段B_Mentor反馈修订报告.md)与[最终检查摘要](review-2026-11-03/final-verification.json)。

| 主题 | 完整交付 | 本地付款 | 双 RPC 审计 | 重复取件 |
|---|---|---|---|---|
| 猫 | [job](job-51174f865a3a76fd1667267af84e67a3bb494362a68f603d4a24437881a5ce56.json) | [acceptance](acceptance-51174f865a3a76fd1667267af84e67a3bb494362a68f603d4a24437881a5ce56.json) | [2/2](independent-audit-51174f865a3a76fd1667267af84e67a3bb494362a68f603d4a24437881a5ce56.json) | [通过](redelivery-51174f865a3a76fd1667267af84e67a3bb494362a68f603d4a24437881a5ce56.json) |
| 鸟类 | [job](job-bea2eda61b5df1adc0f10ba588c1840a0ced66b2833b4c9399dbfb8119123deb.json) | [acceptance](acceptance-bea2eda61b5df1adc0f10ba588c1840a0ced66b2833b4c9399dbfb8119123deb.json) | [2/2](independent-audit-bea2eda61b5df1adc0f10ba588c1840a0ced66b2833b4c9399dbfb8119123deb.json) | [通过](redelivery-bea2eda61b5df1adc0f10ba588c1840a0ced66b2833b4c9399dbfb8119123deb.json) |
| 风景 | [job](job-8a6d59a5826ec3173d2c908844d1903b242fd31e24db273759a7c31a3b13736f.json) | [acceptance](acceptance-8a6d59a5826ec3173d2c908844d1903b242fd31e24db273759a7c31a3b13736f.json) | [2/2](independent-audit-8a6d59a5826ec3173d2c908844d1903b242fd31e24db273759a7c31a3b13736f.json) | [通过](redelivery-8a6d59a5826ec3173d2c908844d1903b242fd31e24db273759a7c31a3b13736f.json) |
| 花卉 | [job](job-9d2db2ed6396b8f53138cee8897dc4e62099f6c5515fe12f2e5bb128b47438ff.json) | [acceptance](acceptance-9d2db2ed6396b8f53138cee8897dc4e62099f6c5515fe12f2e5bb128b47438ff.json) | [2/2](independent-audit-9d2db2ed6396b8f53138cee8897dc4e62099f6c5515fe12f2e5bb128b47438ff.json) | [通过](redelivery-9d2db2ed6396b8f53138cee8897dc4e62099f6c5515fe12f2e5bb128b47438ff.json) |

补充证据：[四主题矩阵](review-2026-11-03/scenarios.json)、[线上协议边界探测](review-2026-11-03/probe.json)、[SMK 补丁后的实时标准化](review-2026-11-03/smk-live-normalization.json)、[三个服务的部署版本](review-2026-11-03/deployment.json)。

鸟类[首次免费准备失败](job-13cadba9348e3df3a63a509aa80da32ffcc5606d4262ed08175f2b5c4e00909f.json)和对应[免费接受记录](acceptance-13cadba9348e3df3a63a509aa80da32ffcc5606d4262ed08175f2b5c4e00909f.json)保留；没有向该任务付款。猫、花卉准备于 SMK 缩略图补丁前，鸟类重跑验证缩略图修正，表中风景任务验证最终付款准备补丁。

另保留一份较早的风景验证：[19 项调用的完整交付](job-e8231cb373da961f7ecc0bff51f2f2646aca3069527eea05476e48850db5d184.json)、[付款记录](acceptance-e8231cb373da961f7ecc0bff51f2f2646aca3069527eea05476e48850db5d184.json)、[双 RPC](independent-audit-e8231cb373da961f7ecc0bff51f2f2646aca3069527eea05476e48850db5d184.json)与[重复取件](redelivery-e8231cb373da961f7ecc0bff51f2f2646aca3069527eea05476e48850db5d184.json)。计入额外验证后，共五笔成功付款、10 项独立审计和 5 次重复取件，实付合计 0.015 测试 USDC。较早风景通过额外分页恢复；最终风景仅 6 项调用且使用合法 API 缩略图。[新增付款准备回归证据](review-2026-11-03/preflight-regression.json)记录补丁前两条失败和补丁后通过结果。

## 历史：协议 1（2026-11-02）

旧协议由本地预付采购预算，云端再购买阶段 2-A 资源。历史记录不描述当前新任务流程。

- [旧验收报告](../../docs/第二阶段B_验收报告.md)与[旧检查摘要](final-verification.json)。
- [正常任务交付](job-89a152f2e8d0bcb4e9826168da9ac7746698fe9c56a85177bec2690a51862b89.json)及[14 项双 RPC 核验](independent-audit-89a152f2e8d0bcb4e9826168da9ac7746698fe9c56a85177bec2690a51862b89.json)。
- [旧任务故障恢复](job-181017958d850143f992122ffcfa0b8029b365e5f686818394dcac23b521ffde.json)及[16 项核验](independent-audit-181017958d850143f992122ffcfa0b8029b365e5f686818394dcac23b521ffde.json)。

所有金额均为 Base Sepolia 测试 USDC。公开证据不含取件令牌或可复用签名头；UTC 时间和历史失败按原样保留。[全项目证据哈希清单](../MANIFEST.md)可用于核对文件。
