# Yoyo x402 云端策展 Agent

**第二阶段 B 已按 mentor 反馈修订并部署（2026-11-03，协议 2）。** 本地 Agent 提交目标，云端 DeepSeek Flash 直接调用 Met、CMA、SMK 的免费官方 API，先准备完整展览；本地再通过 x402 支付固定 0.003 测试 USDC 取件。云端按阶段保存进度，临时 RPC 故障自动退避续跑，明确不可用的作品自动替换，三馆详情未齐时拒绝提前结束。云端不再购买阶段 2-A 的收费资源。

猫、鸟类、风景、花卉四个主题共五个真实任务已交付，10 项双 RPC 独立重审和 5 次重复取件检查通过，上游付款为 0。最后一次风景验证仅用 6 项免费调用完成，并实测了付款前余额准备的新恢复阶段。先读 [Mentor 反馈修订报告](docs/第二阶段B_Mentor反馈修订报告.md)、[使用说明](docs/第二阶段B_使用说明.md)与[机器契约](docs/F-02_cloud-curator.md)。成品：[猫](docs/examples/phase2b-v2-cats.md)、[鸟类](docs/examples/phase2b-v2-birds.md)、[风景](docs/examples/phase2b-v2-landscape.md)、[花卉](docs/examples/phase2b-v2-flowers.md)。原阶段 1 和阶段 2-A 的线上版本保持原样；[2026-11-02 验收报告](docs/第二阶段B_验收报告.md)保留为旧协议历史记录。

**第二阶段 A 已完成测试网配置、端到端演示和取证复核（2026-10-25）。** Cross-Museum MiniCurator 已部署 Met、CMA、SMK 的九个独立 x402 资源，并完成九笔 `verified` 采购，总支付 0.009 测试 USDC；九笔历史交易随后由两个不同 Base Sepolia RPC 在不重新付款的情况下 9/9 重审通过。直接查看 [Mentor 配置验收报告](docs/第二阶段A_配置验收报告.md)、[15 分钟猫主题展览](docs/第二阶段A_猫主题迷你展览.md)、[独立链上重审](evidence/phase2a/independent-chain-reaudit-2026-10-25.json)或 [MiniCurator 使用说明](docs/第二阶段A_使用说明.md)。当前仍有 Zod 上游依赖公告，详见[依赖审计说明](docs/第二阶段A_依赖审计说明.md)。

**2026-10-28 GitHub 发布前复核通过：** 150 项测试、两个 Worker 构建、文档与凭据扫描通过；线上 9 个资源再次 9/9 检查通过；九笔历史交易由两个独立 RPC 再次 9/9 重审通过，未新增付款。摘要见 [发布前复核证据](evidence/phase2a/release-verification-2026-10-28.json)。

第一阶段天气 Worker 保留原部署版本；下文为第一阶段的结构、运行方式与历史验收。

一个基于 **Cloudflare Workers + x402 V2 + Base Sepolia 测试 USDC + MET Norway** 的可支付天气服务。用户用自然语言提出天气需求，Codex 读取机器可读接口文档，按 quote 完成一次测试网支付，并在取得链上回执后交付天气数据。

**第一阶段已完成并通过端到端复核。** 2026-10-22 的复核购买返回 HTTP 402 → 200，链上精确转账 `1000` 个测试 USDC 最小单位；当次 65 项自动化测试、30 项接口边界检查、构建、依赖审计和独立链上复查均通过。

## 给 mentor 的快速审阅路径

| 顺序 | 文件 | 看什么 |
|---|---|---|
| 0 | [2-B 修订报告](docs/第二阶段B_Mentor反馈修订报告.md)与[修订证据](evidence/phase2b/review-2026-11-03/final-verification.json) | 当前架构、问题修复、四个主题与付款证明 |
| 1 | [Mentor 审阅指南](docs/MENTOR_GUIDE.md) | 5–10 分钟内核对目标、完成度和交易证据 |
| 2 | [最新完整复核报告](docs/第一阶段_复核报告_2026-10-22.md) | 发现的问题、修复、最终测试和真实交易 |
| 3 | [最新购买原始证据](evidence/transactions/purchase-1792639327312.json) | `documentation`、`http`、`response`、`settlement`、`receipt`、`audit` |
| 4 | [独立链上交叉核验](evidence/transactions/transaction-rpc-crosscheck-summary-2026-10-22.json) | 两个不同 RPC 对回执、区块和余额的独立结果 |
| 5 | [第一阶段验收报告](docs/第一阶段_验收报告.md) | A1–A10 与 2026-10-16 首次云端验收 |
| 6 | [证据文件清单](evidence/MANIFEST.md) | 所有公开证据的大小与 SHA256 |

已有的完整证据足够审阅，不需要再次调用 `buy`。`probe` 只读取文档、健康状态和未付款报价，不会签名或付款。

## 系统结构

```mermaid
flowchart LR
    A[用户：自然语言天气需求] --> B[Codex：读取 F-02 并准备坐标]
    B --> C[Cloudflare Worker 天气服务]
    C -->|未付款 request| Q[HTTP 402 + x402 V2 exact quote]
    Q --> B
    B -->|官方 x402 SDK 签名，单次付费提交| C
    C --> D[公共 x402 facilitator]
    D --> E[Base Sepolia 测试 USDC]
    C --> F[MET Norway Locationforecast]
    C -->|HTTP 200 + 天气 + 支付回执| B
    B --> G[链上回执、Transfer、双方余额核验]
```

- 收费接口：`GET /weather?latitude=...&longitude=...`
- 网络：Base Sepolia，`eip155:84532`
- 测试资产：`0x036CbD53842c5426634e7929541eC2318f3dCF7e`
- 单价：`1000` 原子单位，即 `0.001` 测试 USDC
- 在线服务：<https://yoyo-x402-weather.accessible-trip.workers.dev>
- 机器可读文档：<https://yoyo-x402-weather.accessible-trip.workers.dev/F-02.md>

## 已验证的云端交易

| 项目 | 结果 |
|---|---|
| 用户意图 | 查询北京现在的天气 |
| 坐标与来源 | `39.9075,116.3972`；Open-Meteo/GeoNames 北京代表点 |
| HTTP | 未付款 402；付费请求 200 |
| 天气 | MET Norway 最近时次模型预报：10.9°C、湿度 62.5%、风速 1.8 m/s |
| 买方余额 | 19.998 → 19.997 测试 USDC |
| 卖方余额 | 0.002 → 0.003 测试 USDC |
| 成功区块 | `48587561` |
| 状态 | `verified` |

交易：[0x7858f5bc9d2d3c22f9709c200f84b86f1dd2927242d126fce90bc00bf4856ff1](https://sepolia.basescan.org/tx/0x7858f5bc9d2d3c22f9709c200f84b86f1dd2927242d126fce90bc00bf4856ff1)

审计同时确认了结算回执、精确 Transfer、初始余额、最终余额和天气交付；区间内没有其他相关转账。当天一次付费响应丢失的请求在授权过期后确认未使用、未扣款，才重新执行购买。

## 仓库结构

```text
.
├── .github/workflows/ci.yml       GitHub Actions：自动测试、构建和证据清单检查
├── docs/                          接口契约、方案、使用说明、验收报告与主题展览
├── evidence/                      脱敏后的部署、探测、采购、链上审计与测试证据
│   ├── phase2b/                   云端策展协议 2 与旧协议的脱敏证据
│   ├── phase2a/                   九 API 展示的历史证据
│   ├── transactions/             真实测试网交易与独立 RPC 核验
│   └── history/                  被替代的失败、重试和中间过程
├── scripts/                       探测、购买、查账、双 RPC 重审、部署与证据工具
├── src/                           天气与 MiniCurator Worker、路由、数据适配和支付策略
├── test/                          业务、支付、RPC、缓存、探测和交付边界测试
├── local-only/                    被 Git 忽略的本机成品图片和报告，不参与发布
├── private/                       被 Git 忽略的卖方密钥与少量旧版独有档案
├── .env.example                   买方/本地运行配置样例
├── .env.cloudflare.example        Cloudflare 部署配置样例
├── wrangler.jsonc                 第一阶段天气 Worker 配置
├── wrangler.curator.jsonc         第二阶段 MiniCurator Worker 配置
├── wrangler.agent.jsonc           第二阶段 B 云端策展 Worker 配置
├── SECURITY.md                    发布前安全边界与检查
├── package.json
└── package-lock.json
```

本机凭据不进入仓库。`.env*`（除 `.example` 样例文件）、`.dev.vars*`、`private/` 和 `local-only/` 均在 `.gitignore` 中；依赖、构建产物和 Wrangler 缓存也不会提交。

## 本地验证

需要 Node.js 24：

```bash
npm ci
npm run verify
```

`verify` 会执行完整测试、Wrangler dry-run 构建和全仓 Markdown 链接检查；GitHub Actions 使用相同入口。更新公开证据后运行 `npm run evidence:manifest` 刷新哈希清单。

在线免费检查：

```bash
npm run probe -- https://yoyo-x402-weather.accessible-trip.workers.dev
```

预期依次得到文档 `200`、健康检查 `200`、未付款天气请求 `402`。该命令不会创建支付授权。

RPC 池只读检查：

```bash
npm run rpc-check -- --out evidence/verification/rpc-health-latest.json
```

工具默认按顺序尝试 8 个 Base Sepolia 公共节点。节点连接失败、HTTP 429 或 JSON-RPC 限流时自动切换；成功后停止，全部失败则停止并保留错误。也可通过 `BASE_SEPOLIA_RPCS` 覆盖完整列表。

## 配置与部署

第一阶段从 [.env.example](.env.example) 创建本机 `.env.local`，从 [.env.cloudflare.example](.env.cloudflare.example) 创建本机 `.env.cloudflare`。原本地买方私钥只留在本机，天气与2-A Worker不读取它。2-B另建专用测试钱包，以Worker Secret保存；模型配置样例为[.env.phase2b.example](.env.phase2b.example)。部署令牌和账号ID只放在被忽略的本机文件中。

```bash
npm run build
node --env-file=.env.cloudflare node_modules/wrangler/bin/wrangler.js deploy
```

`wrangler.jsonc` 只包含公开卖方地址。Cloudflare 账号 ID、API Token、买方和卖方私钥均留在被忽略的本机配置中；生产部署与本地开发都不需要买方私钥。

## 数据与支付语义

MET Norway 返回的是天气模型中距离请求时间最近的一项预报，不是气象站实时观测。响应保留数据更新时间、预报时间、抓取时间、来源、署名和许可。

本项目复用官方 `@x402/*` SDK 完成报价、授权签名、facilitator 验证与结算，没有自建支付协议或智能合约。每次购买最多创建一个签名并提交一次付费请求；付费状态未知时必须先只读查账，不能盲目重买。

## 范围与边界

第一阶段完成了自然语言请求、文档驱动调用、真实天气数据、测试网支付和可独立核验的证据链；第二阶段进一步完成九个博物馆资源的独立交易与跨馆整合。自主议价、复杂多 Agent 协作和生产级 SLA 不在本轮验收内。公共上游、facilitator、RPC、Cloudflare 和本机网络仍可能影响演示；扩大天气源使用前，还需补充运营者实际联系信息并复核提供商流量条件。
