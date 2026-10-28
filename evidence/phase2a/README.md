# 第二阶段 A 证据

本目录保存 2026-10-23 的选题取证，以及用户批准后 2026-10-25 的实施、部署和测试网购买证据。私钥、部署 Token 和账号标识不进入本目录。

## 2026-10-25 配置与验收

- [cloudflare-egress-2026-10-25.json](cloudflare-egress-2026-10-25.json)：Cloudflare 网络对九个上游各取得两份有效响应；保留本机传输失败与补取记录。
- [deployment-2026-10-25.json](deployment-2026-10-25.json)：当前策展与天气 Worker 的版本、100% 流量、公开绑定类型和本地源码哈希；天气版本保持不变。
- `deploy-api-*.json`：通过官方 Cloudflare 版本与部署 API 的发布记录、模块哈希和流量核对。
- `probe-*.json`：当前验收阶段的九个服务免费文档、健康检查和未付款报价；`probe-1792913053593.json` 是最终部署后的 9/9 检查。早期连接失败与中间探测记录放入 `evidence/history`。
- [live-boundaries-2026-10-25.json](live-boundaries-2026-10-25.json)：付款头大小、非法 ID 与外部 URL 拒绝的云端实测。
- [demo-session.json](demo-session.json)：跨馆演示的采购索引、预算与进度；以其最终状态判断是否全部完成。
- 当前会话为 `completed_verified`：九个资源各成功采购一次，确认支出 9000 原子单位，九项跨资源检查通过；三次签名后响应丢失均已到期核实未扣款，另四次签名前失败，没有未解决的付款结果。
- [purchases](purchases/)：逐资源文档全文与哈希、402 报价、授权 nonce、200 交付、结算、精确 Transfer、余额及审计。修复后的审计还会绑定 `AuthorizationUsed` 事件，并核对授权双方、金额、有效时间、settlement payer、网络和资产。未签名失败和授权到期后确认未扣款的记录均保留。
- [independent-chain-reaudit-2026-10-25.json](independent-chain-reaudit-2026-10-25.json)：用 Tenderly 与 Pocket 两个不同 RPC 在不重新付款的情况下重审九笔交易，逐笔核对回执、授权事件、精确 Transfer、历史余额和资料交付，9/9 通过。
- [image-proof-2026-10-25.json](image-proof-2026-10-25.json)：从三份已购作品详情取原图 URL，实际读取图片、核对 MIME、JPEG 签名、字节数与哈希；失败传输与成功直连均保留，最终 3/3。
- [temporary-worker-cleanup-2026-10-25.json](temporary-worker-cleanup-2026-10-25.json)：删除本次临时出站探测 Worker，官方 API 返回成功，后续读取为 404；正式策展与天气 Worker 在部署记录中再次核对。
- [final-verification-2026-10-25.json](final-verification-2026-10-25.json)：完整 verify、模块语法、JSON 解析和最终验收门槛摘要；依赖漏洞单独披露。
- [release-verification-2026-10-28.json](release-verification-2026-10-28.json)：GitHub 发布前复核摘要，记录全量门禁、线上 9/9、双 RPC 9/9、未新增付款及尚存的依赖风险。
- [rpc-health-2026-10-25.json](rpc-health-2026-10-25.json)：本机公共 RPC 只读健康检查。
- [dependency-audit-2026-10-25.json](dependency-audit-2026-10-25.json)：依赖审计原文；剩余 Zod 公告与输入限制见[依赖审计说明](../../docs/第二阶段A_依赖审计说明.md)。

## 2026-10-23 选题阶段

- [connectivity-final-nine-direct.json](connectivity-final-nine-direct.json)：9 个拟用馆藏上游接口，各直连检查两轮；18/18 返回有效 JSON，无 HTTP 429。
- [curator-crosslink-and-image-proof.json](curator-crosslink-and-image-proof.json)：Met、CMA、SMK 的检索、作品、创作者引用一致性，以及三件示例图片的范围读取结果。
- [official-source-manifest.json](official-source-manifest.json)：三家馆官方文档的来源、抓取时间、大小和 SHA256。
- [dependency-sentinel-upstream-probe-2026-10-23.json](dependency-sentinel-upstream-probe-2026-10-23.json)：作为比较项的依赖体检方案 deps.dev/OSV 上游探测；8/8 成功，但最终选择仍为三家馆藏来源的策展方案。复现脚本为 [probe-phase2a.mjs](../../scripts/probe-phase2a.mjs)。

选题阶段仅验证本机直连；2026-10-25 已补充真实 Cloudflare 出站证据。两类检查均为有限时点的功能验证，不构成生产 SLA。`verified` 要求支付和交付同时通过；`not_charged_reconciled` 表示未知请求已到期并核实未扣款，不计为成功购买。

本轮成品为[配置验收报告](../../docs/第二阶段A_配置验收报告.md)和[猫主题迷你展览](../../docs/第二阶段A_猫主题迷你展览.md)。2026-10-23 的旧报告与记录仍保留其历史状态。
