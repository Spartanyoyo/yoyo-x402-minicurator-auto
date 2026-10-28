# F-01：原始天气 API 接入依据

上游：挪威气象局 MET Norway，Locationforecast 2.0 compact。

官方文档：

- 接口：`https://api.met.no/weatherapi/locationforecast/2.0/documentation`
- 入门：`https://api.met.no/doc/GettingStarted`
- 使用条件：`https://api.met.no/doc/TermsOfService`

选用原因：提供真实全球天气模型数据，接入时不需要 API 密钥。数据采用 CC BY 4.0，返回结果保留 MET Norway 署名。服务按 Expires 缓存有效响应，过期后使用 Last-Modified / If-Modified-Since 条件请求；User-Agent 包含项目名与公开说明地址。本阶段只发出少量演示请求；扩大使用前还须提供运营者的实际联系信息并复核提供商的流量限制。

请求方法为 GET，地址为：

```text
https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=31.2304&lon=121.4737
```

`lat` 与 `lon` 为 WGS84 十进制度数，保留最多四位小数；请求携带项目 User-Agent。上游不使用 x402，收费由我们部署的 C 完成。

C 对外的 `latitude` 对应 D 的 `lat`，`longitude` 对应 `lon`。从响应 `properties.timeseries` 选择与请求时间最近的一项，将 `air_temperature`、`relative_humidity`、`wind_speed` 等转换为带单位的 JSON，保留上游更新时间、预报时间、来源 URL 与署名。

必须如实说明：这是天气模型预报中距离当前时刻最近的一项，不是气象站实时观测；不以静态示例代替真实数据。上游响应失败时返回错误，不伪造天气。

2026-10-22 复核后，适配层在写缓存和允许结算之前检查源单位、温度/湿度/风速及时间有效性。所选时次距请求不超过 90 分钟，模型更新时间不超过 24 小时；无效数据返回 502，不缓存、不结算。
