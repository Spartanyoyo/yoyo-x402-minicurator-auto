# MiniCurator 使用说明

MiniCurator 延续第一阶段的文档驱动 Agent 交易：用户提出自然语言需求，Codex 读取服务文档、购买所需数据、核对链上付款，再编写展览方案。

## 在线入口

- 服务：https://yoyo-x402-minicurator.accessible-trip.workers.dev
- 总文档：https://yoyo-x402-minicurator.accessible-trip.workers.dev/F-02.md
- 九个服务目录：https://yoyo-x402-minicurator.accessible-trip.workers.dev/catalog
- 单资源文档：`/services/{service}/F-02.md`；单资源健康检查：`/services/{service}/health`。
- 配置验收：[第二阶段A_配置验收报告.md](第二阶段A_配置验收报告.md)；成品示例：[猫主题迷你展览](第二阶段A_猫主题迷你展览.md)。

九个资源为 Met 搜索、作品、部门；CMA 作品搜索、作品、艺术家搜索、艺术家；SMK 搜索、作品。每个成功调用分别收费 0.001 Base Sepolia 测试 USDC。九个资源各买一次共 0.009；继续购买额外作品详情会继续收费。

## 给 Codex 的示例需求

> 请阅读本项目 MiniCurator 的 F-02，为 10 岁孩子制作一个 15 分钟的猫主题跨馆艺术展。使用 Met、CMA、SMK，按需独立购买 API，总预算不超过 0.009 测试 USDC。请给出三件经公版图片核验的作品、展览顺序、中文讲解、观察题、来源和购买证据。付款状态不明时先只读查账，再决定后续步骤。

Codex 负责主题理解、选择作品、展览顺序和中文表达。API 负责固定参数、检索、权利过滤、标准化、缓存及支付。服务内部不调用大模型，也不需要模型 API key。

## 本机命令

需要 Node.js 24。已有本机 `.env.local` 与 `.env.cloudflare`；配置样例是 [.env.example](../.env.example) 和 [.env.cloudflare.example](../.env.cloudflare.example)。私钥与 Cloudflare Token 留在忽略文件中，不进入 Worker。MiniCurator 的服务地址使用独立的 `CURATOR_SERVER_URL`。本机 RPC 池已经按只读健康检查更新为可用节点，并保留顺序回退。

本机代理出现过间歇性 TLS 握手重置。MiniCurator 使用明确的代理连接；验收中对比过 TLS 上限与 curl 传输，最后两笔 SMK 采购使用 `CURATOR_TLS_MAX_VERSION=TLSv1.3` 成功。证书验证保持开启，代理节点未更改。这是当前链路的实测配置，不代表网络问题已永久解决；该选项仅影响本机客户端。

免费检查所有文档、健康状态及未付款报价，不会创建支付授权：

```powershell
npm run curator:probe
```

从已知中断记录继续免费检查：

```powershell
npm run curator:probe -- --resume evidence/phase2a/probe-时间戳.json
```

以下命令会创建新的一次购买，单次最多支付 1000 个最小单位。它是单笔工具，不保存会话级累计预算，因此跨馆 0.009 预算仍需由调用方逐笔累计并在达到上限时停止。演示验收结束后优先查看已保存证据，不必重复执行：

```powershell
npm run curator:buy -- --service met-search --q cat --limit 5 --offset 0 --intent "为十岁孩子准备十五分钟猫主题展览，搜索Met候选作品"
```

作品详情使用 `--id`；部门服务不接收查询参数。CMA 的 `--q` 分别映射作品标题和艺术家姓名，SMK 为关键词检索。完整参数和价格见每个服务的 F-02。

已有成功结算回执，但本机链上审计尚未完成时，只重做查账：

```powershell
npm run curator:audit -- evidence/phase2a/purchases/已有购买文件.json
```

对已保存的九项演示记录，用两个独立 RPC 不付费重审全部交易、授权事件、服务交付和跨馆关系：

```powershell
npm run curator:verify-chain -- --primary-rpc https://base-sepolia.gateway.tenderly.co --secondary-rpc https://base-testnet.api.pocket.network --out evidence/phase2a/independent-chain-reaudit-2026-10-25.json
```

修复后的单笔 `curator:audit` 不只查看 Transfer 和余额：它还要求保存的授权 nonce 与交易中的 `AuthorizationUsed` 事件一致，并核对授权付款人、收款人、金额、有效时间、结算 payer 和网络/资产。

签名后响应丢失或结算结果不明时，检查授权是否使用、链上过期时间、双方余额和相关转账：

```powershell
npm run curator:reconcile -- evidence/phase2a/purchases/已有购买文件.json
```

`safeToRetry=true` 只说明该笔旧授权满足重新决策的条件，不会自动付款。已使用授权不得自动重买。只读探测允许一次不同传输方式的回退；付费提交没有网络重试或自动传输回退。

完整检查及独立部署：

```powershell
npm run verify
npm run curator:deploy
```

`verify` 同时运行天气与 MiniCurator 测试、两个 Worker 的 dry-run、文档链接和凭据扫描。`curator:deploy` 只更新新策展 Worker。第一阶段天气部署仍使用原来的配置。

## 交付核对

2026-10-25 的验收已完成九项独立成功采购，总支付 0.009 测试 USDC，没有未解决的付款结果。优先阅读[配置验收报告](第二阶段A_配置验收报告.md)、[展览成品](第二阶段A_猫主题迷你展览.md)和[会话索引](../evidence/phase2a/demo-session.json)。依赖审计仍有 Zod 上游公告，见[依赖审计说明](第二阶段A_依赖审计说明.md)。

优先看 `status=verified` 且 `audit.paymentVerified=true`、`audit.deliveryVerified=true` 的购买证据。每件作品应有来源、图片、明确权利、原始标题和抓取时间。搜索返回的 Met ID、艺术家关联作品不能代替作品详情的图片权利核验。

过期缓存会标记 `cache.stale=true`，同时保留原始抓取时间；当前缓存不是全球持久数据库。免费健康检查反映配置可读，不保证博物馆或付款基础设施随时可用。测试网采购验证不等同于生产 SLA。
