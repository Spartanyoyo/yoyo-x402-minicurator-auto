# 测试与部署验证

## 2026-10-22 完整复核

| 文件 | 结论 |
|---|---|
| [JUnit 自动化测试](tests-review-2026-10-22.xml) | 65 项通过、0 失败、0 跳过；路径已规范为仓库相对路径 |
| [接口边界检查](integration-review-2026-10-22.json) | Node、本地 Workers、云端共 30 项；保留一次连接失败及补验 |
| [源码语法](syntax-review-2026-10-22.json) | 22 个模块通过 |
| [真实天气源](upstream-review-2026-10-22.json) | MET Norway 北京响应通过字段、单位、地点和时间校验 |
| [历史交易复审](historical-reaudit-2026-10-22.json) | 在更严格条件下复审 2026-10-16 交易，结果仍为 `verified` |
| [文档链接](documentation-links-review-2026-10-22.json) | 当前 14 份 Markdown、191 条本地链接全部可解析 |
| [凭据扫描](credential-scan-review-2026-10-22.json) | 当前扫描 108 个公开及构建文件；3 项实际凭据和 2 项私有部署标识均无匹配 |
| [依赖审计](dependency-audit-final-2026-10-22.json) | 运行当时的锁文件未发现已知漏洞 |
| [购买后免费探针](probe-1792639846140.json) | 文档 200、健康 200、未付款天气 402 |

## 部署

- [部署与源码哈希](deployment-review-2026-10-22.json)：版本、100% 流量、绑定与采集时哈希。
- [本地源码哈希比较](local-source-hashes-review-2026-10-22.json)：区分云端服务文件与本地买方工具。
- [Worker 绑定检查](worker-bindings-review-2026-10-22.json)：本地与服务端均不包含私有绑定。
- [首次云端部署](deployment-1792155170711.json)：2026-10-16 原部署证据。

## RPC 可用性

- [8 节点完整操作检查](rpc-pool-review-2026-10-22.json)
- [回退链 ID 与余额检查](rpc-fallback-review-2026-10-22.json)
- [顺序列表检查](rpc-fallback-list-review-2026-10-22.json)
- [健康快照](rpc-health-2026-10-22.json)
- [连接波动记录](connection-review-2026-10-22.json)

公共 RPC 的可用性会波动；回退是提高观测与查账成功率的手段，不作为付款成功的条件。
