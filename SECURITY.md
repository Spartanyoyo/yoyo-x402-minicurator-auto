# 安全说明

本项目是第一阶段的 Base Sepolia 测试网演示，不托管主网资金。

## 本机秘密

以下路径只应存在于本机，不能提交，也不能粘贴到公开 Issue：

- `.env.local`：买方测试私钥与本地运行配置
- `.env.cloudflare`：Cloudflare API Token 与账号 ID
- `.dev.vars`：本地 Worker 配置
- `private/`：卖方测试私钥，以及少量与公开证据不重复的旧版审计快照
- `local-only/`：被 Git 忽略的本机验收图片和报告等交付物

公开测试钱包地址、交易哈希、公共链上回执和脱敏后的购买记录可以进入证据目录。

## 发布前检查

```bash
npm run verify
```

`verify` 会运行自动测试、Wrangler dry-run、全仓 Markdown 链接检查和公开文件敏感信息扫描。扫描会同时检查本机密钥值、PEM 私钥和常见服务 Token，并拒绝证据中的原始签名交易、超长十六进制载荷、非占位付款签名头，以及 Base64 付款响应内的原始签名材料。它不会创建支付授权或提交付款。发布证据后还应运行：

```bash
npm run evidence:manifest
```

提交前用 `git status --short` 和 `git check-ignore -v .env.local .env.cloudflare private/seller-key.txt local-only` 复核实际发布范围。