# 第二阶段 B：云端策展 Agent

本地 Agent 提交目标、购买一个任务并取件。云端 DeepSeek 模型自主选择阶段2-A的九种工具，用独立钱包采购，再根据已验证记录编写展览。模型不接触密钥；价格、网络、服务白名单、预算和签名由代码控制。官方模型列表与实际JSON请求已验证，API标识是 `deepseek-flash`。

## 使用

在仓库根目录使用 Node.js 24：

```bash
npm run agent:probe
npm run agent:run -- --goal '为十岁孩子制作15分钟中文猫主题展览，包含Met、CMA、SMK三馆作品、观察问题和来源' --budget 9000
npm run agent:status -- --id <任务ID>
npm run agent:wait -- --id <任务ID>
npm run agent:reconcile -- --id <任务ID>
npm run agent:verify-chain -- <任务ID>
```

`run` 只购买一个云端任务并轮询结果；本地不选择和购买各博物馆 API。最终 Markdown 在 `local-only/phase2b/`，脱敏证据在 `evidence/phase2b/`。取件令牌仅在 `private/phase2b/jobs/<任务ID>.json`，不得分享或放入URL。

`status` 和 `wait` 不付款。`reconcile` 先只读查账：已付款且有完整响应的项恢复审计；只有精确授权nonce被合约确认未使用、有效期已结束超过12秒、初始余额快照一致的项，才允许一次新的采购尝试。原尝试保留在 `priorAttempts`，不增加采购预算。状态仍未知、已付款但丢失响应、或再次失败时停止。不要直接新建任务来绕过未知付款。

`verify-chain` 用Tenderly与Pocket两个独立RPC检查两跳全部付款，不发送新交易。`needs_attention`不是完成状态。机器契约见[F-02](F-02_cloud-curator.md)。

## 配置和部署

`.env.local`保留原本地钱包；`.env.cloudflare`保留部署凭据；`.env.phase2b.local`从样例复制，存放模型配置与专用云端测试钱包。本地凭据均被Git忽略。

```bash
node scripts/setup-agent-wallet.mjs
npm run agent:build
npm run agent:deploy
node --env-file=.env.phase2b.local scripts/prepare-agent-secrets.mjs
node --env-file=.env.cloudflare node_modules/wrangler/bin/wrangler.js secret bulk private/phase2b/secrets.json --config wrangler.agent.jsonc
```

只把 `AGENT_WALLET_KEY` 与 `AGENT_LLM_API_KEY` 上传为Worker Secrets，不上传原本地买方私钥。更换模型需同步更新Worker的公开模型变量。

## 存储与并行

每个任务对应一个SQLite-backed Durable Object。目标、计划、预算预留、中间JSON、授权字段、HTTP响应、链上证据和最终Markdown均持久化。JSON按小块事务写入和读取，并检查SHA256，单对象上限2 MiB。任务保留七天，未付费草稿一小时清理。

Worker内存仅处理有大小上限的临时响应，不依赖本机文件夹或临时磁盘。图片使用馆方已经验证许可的URL，不下载二进制副本。模型只看到目标和博物馆数据。

每轮最多三项任务并行，启动前原子预留整个批次预算。F-02、报价、数据检查和链上审计可以并行；公共facilitator的relayer会发生nonce冲突，因此付费HTTP请求经全局Durable Object队列串行提交。队列保存中断租约，避免重启后重复提交未知付款。

总上限：九项采购、五轮规划、七次模型请求。每项最多一次经查账证明未付款的重试。Alarm在本地程序退出后仍继续执行任务。一次入站授权通过全局nonce认领只绑定一个任务。

## 支付与边界

默认本地支付0.012测试USDC：最多0.009采购预算加0.003服务费。每个资源0.001。未用预付款当前留在云端钱包，不自动退款；报告列示实际支出。模型法币API费用由运营者账户另付。

两跳都核验网络、USDC合约、收付款地址、金额、有效期、nonce、AuthorizationUsed、精确Transfer、交易回执及数据交付。共享钱包模式枚举相关区间转账并解释双方余额净变化；阶段2-A默认单笔隔离审计继续保留。

facilitator异常文本可能携带原始签名交易，公开证据递归删除这些数据和原始支付头。密钥、取件令牌和可复用签名不进入报告。

这是测试网实验，不提供主网托管、自动退款或生产SLA。若已付款的上游响应永久丢失，阶段2-A没有历史响应补发接口，任务会明确停止，不能虚构结果或盲目重付。
