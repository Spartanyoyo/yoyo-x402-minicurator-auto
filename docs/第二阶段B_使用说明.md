# 第二阶段 B：云端生成后付费取件

2026-11-03 根据 mentor 反馈改为协议 2：云端 Agent 直接调用 Met、CMA、SMK 的免费官方 API，准备好完整展览后，本地 Agent 通过 x402 购买成品。固定服务费是 3000 原子单位，即 0.003 Base Sepolia 测试 USDC。上游免费调用不产生采购费用。

## 本地使用

使用 Node.js 24 和本机已配置的 `.env.local`、`.env.phase2b.local`：

```bash
npm ci
npm run agent:probe
npm run agent:run -- --goal "为十岁孩子制作15分钟中文鸟类主题展览，包含Met、CMA、SMK三馆作品、观察问题和来源" --max-calls 24
```

`run` 提交免费生成任务，等待三馆详情与成品齐全，再验证 402 报价、提交一次 0.003 测试 USDC 授权，最后等待查账和交付。不会逐个购买 2-A 接口。`--max-calls` 是免费取数的调用次数上限，默认 24，允许 6..30；旧的 `--budget` 参数已取消。

可以把准备和付款分开执行：

```bash
node --use-env-proxy --env-file=.env.local --env-file=.env.phase2b.local scripts/agent.mjs submit --goal "15分钟三馆花卉主题展览" --max-calls 24
npm run agent:wait -- --id <任务ID>
npm run agent:pay -- --id <任务ID>
npm run agent:status -- --id <任务ID>
npm run agent:reconcile -- --id <任务ID>
npm run agent:verify-chain -- <任务ID>
```

`submit` 和 `wait` 不签名、不付款，停在 `ready`；`pay` 只购买已经准备好的成品。`status`、`reconcile` 和 `verify-chain` 不付款。不要在支付状态未知时新建任务或重复 `pay`。只有服务端确认精确授权 nonce 过期且从未使用，返回 `payment_retry_allowed`，才允许用户显式选择新的付款。

最终 Markdown 存入 `local-only/phase2b/`，公开证据存入 `evidence/phase2b/`。取件令牌仅存于 `private/phase2b/jobs/<任务ID>.json`，不得分享或写入 URL。已付款任务在七天保留期内可重复取件。

## 服务接口

1. `POST /jobs/{id}`：提交目标，不付款，返回 202。
2. `GET /jobs/{id}`：查看生成进度；`ready` 时只给成品哈希、三馆摘要和价格，不给正文。
3. `POST /jobs/{id}/delivery`：未付款返回 402；官方 SDK 签名后提交一次授权，返回 202。
4. 云端保存已接受的授权，依次执行付款前余额读取、结算和链上审计；确认金额、授权 nonce、Transfer、AuthorizationUsed、网络、双方地址、有效期、余额和成品绑定。余额 RPC 临时失败也会自动续跑；在首次结算前调用 `reconcile` 会继续准备同一付款。
5. `GET /jobs/{id}`：审计通过后返回 `complete` 与成品；重复取件无需再付。

身份计算、字段与状态的完整约定见 [F-02](F-02_cloud-curator.md)。旧协议任务继续使用保存的任务 ID 和私有令牌取件，旧证据保留为历史记录。

## 失败恢复与资源限制

每轮执行只负责规划、最多三项免费取数、生成报告、结算或链上读取中的一个阶段。成功数据与链上读取均持久化。真实 RPC HTTP 请求连同切换节点每轮最多十二次，达到上限自动续跑；临时错误最多六次退避后才进入 `needs_attention`，不重新结算。

作品被明确标记非公版、无可交付图片或不存在时记为 `unavailable`，改选其他候选，不进入付款等待。馆方直接返回 HTTP 404 或 422 也立即跳过该作品，不重试该 ID，也不回退到过期缓存。搜索页被权限过滤后为空、但仍有后续结果时继续分页。三馆有效详情未齐，程序会拒绝模型提前结束；若资源上限耗尽，生成阶段失败，不向用户收费。

默认最多 24 个不同工具调用，最多三项并行、十轮模型规划、十四次模型请求；免费 GET 最多三次尝试。任务、中间 JSON、成品由 SQLite Durable Objects 保留七天，每条最多 2 MiB；模型输入输出最多 128 KiB。图片继续使用馆方 URL，GitHub 的外链代理可能影响展示。

先生成后收费会消耗运营者的模型 API 额度，因此全局每天最多十个免费生成任务，同一 IP 每天最多六个（均按 UTC 日）。一次任务的重复提交不额外占配额。仅限测试网；无生产 SLA 和自动退款，模型解说仍需人工审核。

## 配置和部署

`.env.local` 保存本地付款钱包；`.env.cloudflare` 保存部署凭据；`.env.phase2b.local` 保存 DeepSeek 配置与收款钱包。密钥在 Cloudflare Worker Secrets 中，模型不接触密钥。本次只部署 `wrangler.agent.jsonc` 对应的 2-B Worker。

```bash
npm run agent:build
npm run agent:deploy
```

首次设置密钥可用 `scripts/prepare-agent-secrets.mjs` 和 Wrangler Secret bulk；临时密钥 JSON 不得纳入 Git，完成上传后删除。阶段 1 和阶段 2-A 使用各自配置独立部署。
