# 上游审查与最小设计

日期：2026-11-04。上游完整历史克隆自 https://github.com/barretlee/cloudflare-proxy ，基线 `1172395ba46c87eebace82ecfc212c4bf71c1dd2`。全部跟踪文件共三份：README.md、LICENSE、cloudflare-worker.js，均已完整阅读。LICENSE 原样保留。

## 发现

| 项目 | 原行为 | 本版处理 |
| --- | --- | --- |
| 代理身份 | 只判断 Authorization 非空 | Secret 双 Token；认证先于所有路径和方法 |
| URL | request.url 字符串替换 host，沿用原 scheme，无端点限制 | 固定 HTTPS origin，赋值安全路径与 Query，不跟随重定向 |
| 方法/请求体 | 只解析 POST JSON；其他非 GET/HEAD 可能发送 `{}` | 允许列表匹配 method + path；原始 body |
| JSON | 请求/非流式响应解析并重新序列化 | 完全不解析、不转换 |
| Multipart | 另走直接复制 Request 的分支 | 统一流转发；未开放上传端点 |
| SSE | 请求体 stream=true 时返回上游流 | 不推断协议，所有响应直接流转发 |
| Responses | 路径可能转发，但无专项测试；非 JSON 错误可触发解析异常 | 普通/流式/工具/结构化 JSON Mock + SDK 验证 |
| Headers | JSON 分支只发 Content-Type 与 Authorization；普通响应只留 Content-Type | 必要请求字段允许列表、响应安全过滤、保留限流及 Request ID |
| 错误 | JSON 解析或 fetch 异常未处理 | 上游错误保持 body/status；连接失败固定 502；不回显异常 |
| CORS | OPTIONS 无认证且通配开放 | 默认关闭；所有方法先认证 |
| 可靠性 | 无取消、连接、并发及资源验证 | 原始流/AbortSignal，Mock 验证，云端长连接另验收 |

上游 URL 替换方式缺少结构化边界，不把这一点夸大为已证实的任意主机 SSRF；本版通过固定 origin 和禁止 redirect 消除目标可变性。

## 实现取舍

一个原生 ES module，少量辅助函数；不引入框架、数据库、Key 池或协议转换。端点仅扩展至 SDK 和模型发现需要的路径。GET 模型/响应同样要求双 Token。生产没有 fetch 注入配置，测试才使用函数参数或 Miniflare outboundService。

Token 格式限制降低重复头/超长输入歧义；SHA-256 固定长度摘要配合 Workers 原生 timingSafeEqual。没有自制 JavaScript 循环的“恒时”承诺。原语依据 [Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)。

转发设置 `redirect: manual`，3xx 对客户端返回固定 502，避免 Worker 和 SDK 自动跳转传播凭据。Cloudflare 明确提示 follow 可将敏感 Header 发往不同域名：[Request](https://developers.cloudflare.com/workers/runtime-apis/request/)。

生产不重试，不加应用层响应超时，不缓存；调用方决定超时/重试。启用 `enable_request_signal`，响应流直接相连，避免额外消费。保留 fetch 的响应流与 `Content-Encoding`，使用默认响应构造让 Workers 处理压缩透传。曾误用 `encodeBody: manual`，在真实本地 workerd/HTTP 链路下会产生 gzip 头与明文 body 不一致；已删除该设置，并用 gzip JSON、SSE 和错误响应作运行时回归。`manual` 适用于自行提供预压缩数据，不应套用到此处的 fetch 流。[Fetch 压缩透传](https://developers.cloudflare.com/workers/runtime-apis/fetch/#passthrough-behavior) · [Response](https://developers.cloudflare.com/workers/runtime-apis/response/)

## 环境与工作范围

初始目录为空，目录名 `OpenAI-Proxy ` 含末尾空格，保留原路径。分支 `feat/secure-openai-proxy`，远程只有 upstream。GitHub 连接只读确认账号可用；本机无 gh CLI。未新建远程仓库、未推送。

`.research/` 内是公开客户端源码，用于配置审查；`.venv/`、`node_modules/` 是验证依赖；`dist/` 是本地 dry-run 产物。均被忽略并保留以便复验，无真实凭据。已做本地自检和限定范围的独立代码审查；这不代表第三方安全认证或云端实测。
