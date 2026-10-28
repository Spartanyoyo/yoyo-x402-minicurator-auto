# 第二阶段 A 依赖审计说明

日期：2026-10-25。原始结果见 [dependency-audit-2026-10-25.json](../evidence/phase2a/dependency-audit-2026-10-25.json)。

本轮将本机 HTTP 客户端 `undici` 更新至 `7.30.1`，并将 `fast-uri` 固定到 `3.1.9`。安装后完整业务测试和两个 Worker dry-run 均通过。Cloudflare 部署使用 Wrangler 生成的 bundle，通过官方版本上传与部署 API 发布；本机的 API 连接沿用已验证的显式代理和 TLS 配置。

审计仍报告 **6 个 high 条目**：Zod 及通过它传播告警的五个 x402 包，对应同一个底层公告 [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)。当前官方 x402 `2.28.0` 要求 `zod ^3.24.2`，使用的 Zod 为 `3.25.76`。公告列出的修复版本为 Zod `4.6.6`；直接跨主版本覆盖会破坏 SDK 使用的单参数 `z.record(...)` 等 schema，因此本次保留官方兼容依赖。

当前防护为在 MiniCurator 进入 SDK schema 解析前拒绝超过 8192 字符的付款头和超过 2048 字符的 URL；本机购买工具也在解析前拒绝超过 16384 字符的报价头。该限制已增加单测并执行云端实测。它限制当前暴露接口的输入规模，**不代表已经消除上游公告，也不构成零漏洞声明**。

本项目本轮验收范围是 Base Sepolia 测试网功能与 Agent 采购演示。若要进入生产服务，需要跟进官方 x402 的兼容修复、重新审计与部署；不能直接沿用本次测试网验收作为生产安全结论。第一阶段已部署天气 Worker 本轮未更新，其历史依赖审计结果只代表当时的快照。
