# 安全说明

本项目的第一阶段、第二阶段A和第二阶段B均仅使用Base Sepolia测试网，不托管主网资金。2-B云端Agent使用独立测试钱包采购资源，原本地买方私钥不上传。

## 本机秘密

以下路径只应存在于本机，不能提交，也不能粘贴到公开 Issue：

- `.env.local`：买方测试私钥与本地运行配置
- `.env.cloudflare`：Cloudflare API Token 与账号 ID
- `.env.phase2b.local`：云端专用测试钱包私钥与DeepSeek API密钥；仅以Worker Secrets部署
- `.dev.vars`：本地 Worker 配置
- `private/`：卖方测试私钥，以及少量与公开证据不重复的旧版审计快照
- `private/phase2b/jobs/`：任务取件令牌，不放URL、日志或公开证据
- `local-only/`：被 Git 忽略的本机验收图片和报告等交付物

公开测试钱包地址、交易哈希、公共链上回执和脱敏后的购买记录可以进入证据目录。

2-B会过滤facilitator异常中回显的签名交易、原始付款头和凭证。共享付款队列、精确nonce认领、预算预留、每日10个新授权上限、模型调用次数和响应大小限制均由代码执行。模型输出仅决定白名单工具参数和讲解文案，不接触付款密钥。链上审计证明支付和交付来源，不证明每句模型解读的学术准确性；正式展陈仍应审核文案。

## 发布前检查

```bash
npm run verify
```

`verify` 会运行自动测试、Wrangler dry-run、全仓 Markdown 链接检查和公开文件敏感信息扫描。扫描会同时检查本机密钥值、PEM 私钥和常见服务 Token，并拒绝证据中的原始签名交易、超长十六进制载荷、非占位付款签名头，以及 Base64 付款响应内的原始签名材料。它不会创建支付授权或提交付款。发布证据后还应运行：

```bash
npm run evidence:manifest
```

提交前用 `git status --short` 和 `git check-ignore -v .env.local .env.cloudflare private/seller-key.txt local-only` 复核实际发布范围。
