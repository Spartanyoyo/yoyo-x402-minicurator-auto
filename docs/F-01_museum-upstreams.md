# F-01：MiniCurator 博物馆上游

日期：2026-10-25。上游均为公开只读 HTTPS API，不需要 API key。Cloudflare 出站实际证据见 [cloudflare-egress-2026-10-25.json](../evidence/phase2a/cloudflare-egress-2026-10-25.json)。

| 自建资源 | 固定上游主机与路径 | 参数映射 | 核验 |
|---|---|---|---|
| met-search | collectionapi.metmuseum.org/public/collection/v1.1/search | q、limit、offset、departmentId；固定 hasImages=true | total、objectIDs；ID 不代表图片权利 |
| met-artwork | collectionapi.metmuseum.org/public/collection/v1/objects/{id} | 正整数 ID | ID 一致、isPublicDomain=true、标题、图片及来源主机 |
| met-departments | collectionapi.metmuseum.org/public/collection/v1/departments | 无 | 非空部门 ID/名称列表 |
| cma-artwork-search | openaccess-api.clevelandart.org/api/artworks/ | q→title、offset→skip；固定 cc0=1、has_image=1 | data、info.total；逐项复核 CC0 与图片 |
| cma-artwork | openaccess-api.clevelandart.org/api/artworks/{id} | 正整数 ID | ID 一致、share_license_status=CC0 |
| cma-artist-search | openaccess-api.clevelandart.org/api/creators/ | q→name、offset→skip | 艺术家 ID、姓名、关联作品 |
| cma-artist | openaccess-api.clevelandart.org/api/creators/{id} | 正整数 ID | ID 一致；关联作品的图片权利仍未核验 |
| smk-search | api.smk.dk/api/v1/art/search/ | q→keys、limit→rows；固定 lang=en | found、items；逐项复核 public_domain 与图片 |
| smk-artwork | api.smk.dk/api/v1/art/ | id→object_number；固定 lang=en | 对象编号一致、public_domain=true |

## 来源和许可

- Met：[官方 API 文档](https://metmuseum.github.io/)。元数据和标记开放的作品图片使用 CC0；官方建议每秒不超过 80 次请求。旧版 search 已退役，当前使用 v1.1。
- CMA：[API 文档](https://openaccess-api.clevelandart.org/)和[开放政策](https://www.clevelandart.org/open-access)。作品以明确 CC0 标记为准；未发现统一公开的每秒限额，不将其解释为无限调用。
- SMK：[官方 API 说明](https://www.smk.dk/en/article/smk-api/)。只交付明确 public_domain=true 的作品图片，并保留 Public Domain Mark。未发现明确数字限额；夜间数据和变更记录可作为后续扩容方案，本次未下载全量库。

原官方说明的来源与哈希见 [official-source-manifest.json](../evidence/phase2a/official-source-manifest.json)。馆藏事实来自上游；中文解释和观察题由 Codex 在采购后编写。保留馆名和来源并不表示官方合作或背书。

## 运行边界

每次资源调用最多请求一个固定上游 URL；不接收外部 URL，不遍历全库，不代理图片二进制。检索每页最多 10 条，offset 最大 1000。请求不自动跟随重定向。Worker 中使用 redirect=manual 并拒绝非成功响应，因为该运行时不支持 Node 的 redirect=error。上游响应正文按 2 MiB 上限流式读取，超限即中止并且不进入 JSON 解析或缓存。

每个资源独立缓存；搜索新鲜期 1 小时，详情和部门 1 天，最多保留 7 天。缓存键含版本、资源和规范化参数。显式撤回权利或 404 时不使用旧详情。上游故障的降级数据保留原抓取时间并标记 stale=true。缓存不保证跨 Cloudflare 机房命中。

Provider 限流绑定按每机房、每馆 20 次 / 10 秒保护未命中缓存的上游请求；它是本服务的局部保护，不是全球配额保证。Agent 顺序调用，Met 总流量仍须遵守官方建议。

## 实际出站门槛

2026-10-25，临时 Worker 对九个接口各执行两次有效读取，完成 18/18 份状态与字段核验。证据包含完整公开响应、SHA256、Cloudflare 环境标记、机房与耗时；本机传输失败和补取过程保留在 previousAttempts 中。该有限检查证明部署网络可达，不构成 SLA。
