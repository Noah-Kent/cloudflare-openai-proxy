# Cloudflare OpenAI Proxy

面向可信服务端、个人开发环境和支持自定义 Header 的桌面客户端的轻量 OpenAI HTTP 代理。基于 [barretlee/cloudflare-proxy](https://github.com/barretlee/cloudflare-proxy)，保留完整上游提交历史及 [MIT License](LICENSE) 中的原作者版权声明。

```
客户端（OpenAI Key + Proxy Token） → Cloudflare Worker → https://api.openai.com
```

Worker 无第三方运行依赖，不保存 OpenAI Key，不转换 OpenAI 协议，不解析 JSON/SSE。真实部署和使用必须符合 OpenAI 服务地区及使用政策；本项目不用于绕过地区限制。不要把凭据放入公开网页、公开仓库或分发给他人的客户端安装包。

## 部署到我的 Cloudflare

准备一个由 Cloudflare 管理的域名和一个空闲子域名。从克隆项目开始，按步骤完成登录、预演、部署和认证检查。前两次接口检查无需 OpenAI Key，也不产生模型费用。[开始部署](docs/deployment.md)

## 项目验证状态

截至 2026-11-05，官方 Python 和 Node SDK 通过已部署 Worker 的 8 项真实请求测试。DeepSeek Harness 已完成基础文本实测，重启后已确认推理等级菜单显示。Cherry Studio 已完成源码审查与模拟请求，真实客户端验收待完成。[测试记录](docs/testing.md) · [Harness 配置及设置页保存限制](docs/deepseek-harness.md)

## 认证与端点

每个请求都必须同时携带：

```http
Authorization: Bearer OPENAI_API_KEY
X-Proxy-Token: YOUR_PROXY_TOKEN
```

Worker 端把 `PROXY_TOKEN` 存为 Cloudflare Secret，客户端安全保存同一值。使用随机生成的 32–256 字符 Token，仅允许字母、数字、`_`、`-`（推荐 32 随机字节转 64 位十六进制）。Worker 先验证代理 Token：缺失、错误、配置缺失或格式无效均 403；随后检查 Bearer 格式，失败返回 401。有效代理认证不代表 OpenAI Key 有效，后者由 OpenAI 验证。Token 经 SHA-256 后用 Workers 原生 `timingSafeEqual` 比较；转发删除代理 Token，保留原 Authorization。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/v1/responses` | Responses 普通、流式、工具与结构化输出 |
| POST | `/v1/chat/completions` | Chat 普通、流式与工具调用 |
| GET | `/v1/models`、`/v1/models/{model}` | 模型列表与详情 |
| GET / DELETE | `/v1/responses/{response_id}` | 已保存响应读取/删除 |
| GET | `/v1/responses/{response_id}/input_items` | 输入项列表 |
| POST | `/v1/responses/{response_id}/cancel` | 取消后台响应 |

响应 ID 限定为 `resp_` 开头的字母数字、`_`、`-`。不开放 Files、Audio、Images、Embeddings、Realtime/WebSocket、Conversations、Responses compact/input_tokens 等端点；需要这些功能时先评估路径，而非放开全部 `/v1/*`。Multipart 字节转发机制有测试，但本版没有开放文件上传端点，也不代表 Responses 接受 Multipart。

## 本地开发与测试

要求 Node.js 22+；本次验证 Node 24.19.0、Python 3.9.6。建议新环境使用仍受维护的 Python 版本。开发工具和 SDK 精确版本已锁定，Worker 本身零依赖。

```sh
npm ci
npm test
python3 -m venv .venv
.venv/bin/python -m pip install -r examples/python/requirements.lock.txt
npm run test:sdk
# 可选慢测试：本地持续 65 秒，不调用真实 API
npm run test:long
WRANGLER_SEND_METRICS=false npm run build
```

`npm test` 使用本地 Mock；`test:sdk` 使用官方 SDK、本地 workerd 和拦截所有外连的 Mock 上游，默认假凭据，不产生真实 API 费用。Python 路径可用 `PYTHON=/path/to/python` 指定。`build` 是 `wrangler deploy --dry-run`，不远程发布。

```sh
cp .dev.vars.example .dev.vars
WRANGLER_SEND_METRICS=false npm run dev
```

开发服务器绑定 `127.0.0.1`。**普通 `npm run dev` 的已认证请求会转发真实 OpenAI 上游**，它不是 Mock 服务器；只使用假 Key 做拒绝验证，真实请求须另行批准。

## SDK 示例

环境变量：`OPENAI_BASE_URL=https://api.example.com/v1`、`OPENAI_API_KEY`、`PROXY_TOKEN`、`OPENAI_MODEL`。两种 Key 必须分别填写；模型选择账户实际可用且适合测试的低成本模型，不在代理内固定模型。

取得真实调用授权后，在本机安全注入上述变量并设置 `ALLOW_REAL_API=1`，再逐个运行：

```sh
node examples/node/client.mjs responses
node examples/node/client.mjs stream
.venv/bin/python examples/python/client.py responses
.venv/bin/python examples/python/client.py stream
```

还支持 `tools`、`structured`、`chat`、`chat-stream` 模式。示例每次只请求一次、关闭自动重试、输出上限 128 tokens；工具模式只显示函数调用，不执行工具。模型可能不支持某功能，或推理预算不足导致 incomplete；这与 HTTP 转发是否正确分别判断。示例在本地 Mock 下也会执行验证：

- Responses 非流式（`responses/tools/structured`）要求 `status=completed` 后才输出；流式要求收到 `response.completed`。失败、未完成或缺少完成状态均非零退出。
- 当前 `chat/chat-stream` 是纯文本示例，只把 `finish_reason=stop` 视为成功；达到长度上限、内容过滤、意外工具调用或缺少终态均非零退出。流式兼容空 choices 的用量帧，并在结束或异常时关闭流。
- SDK 不向普通流迭代暴露原始 `[DONE]`：示例判断 SDK 提供的 `stop`，不声称验证该分隔标志。只有 `[DONE]` 而无 `stop` 仍失败；已收到 `stop` 后自然 EOF 可成功，传输异常仍失败。

流式已输出的文字可能只是部分结果，调用脚本时须检查退出码。

客户端配置：[Cherry Studio](docs/cherry-studio.md) · [DeepSeek Harness](docs/deepseek-harness.md)。SDK 参数依据 [Python SDK](https://developers.openai.com/api/reference/python) 与 [Node SDK](https://developers.openai.com/api/reference/typescript) 官方文档。

## 转发与安全边界

- 固定 HTTPS 上游，路径精确匹配、Query 原样传递。参数或 Header 无法改变上游地址。URL 标准化可能折叠点路径，但最终允许列表和认证始终执行。
- 原始请求体、响应体及 SSE 流直接转发，不预读整流、不按 `stream` 参数改变解析行为。状态码和必要响应头保留；上游重定向特意转成 502，防止客户端自动跟随并泄露双 Token。
- 请求 Header 采用必要字段允许列表：Authorization、Content-Type/Encoding、Accept/Encoding、User-Agent、OpenAI-Organization/Project/Beta、Idempotency-Key、X-Client-Request-Id、X-Stainless-*。其他字段默认删除；Host、Content-Length、Cookie、代理凭据和逐跳 Header 不透传。新增必要 Header 应加测试。
- 响应保留 Request ID、限流、Retry-After、内容类型/编码等，删除逐跳字段、Set-Cookie、认证字段和所有 CORS 字段，强制 `Cache-Control: no-store`。保留 fetch 的响应流与 `Content-Encoding`，由 Workers 默认机制处理压缩透传，不强制 `encodeBody: manual`。[压缩透传行为](https://developers.cloudflare.com/workers/runtime-apis/fetch/#passthrough-behavior)。
- 默认无 CORS；未认证 OPTIONS 同样 403，通过认证但不支持的方法 405。浏览器预检无法使用本版；不要为了浏览器公开携带密钥而开启 `*`。桌面客户端的主进程/服务端请求不依赖浏览器 CORS。
- 默认无应用日志，关闭 Wrangler Observability。不得在调试中打印完整请求、两类 Key、Prompt 或响应。未来必要日志仅限时间、匹配后的路径、状态、耗时和固定错误码，避免 Query 与任意异常文本。平台日志另需审查保留规则。
- 传递请求 AbortSignal，直接返回响应流，支持底层取消传播；取消不保证上游立即停止计费。长时间连接和真实云端断开行为待实测。[Workers Request](https://developers.cloudflare.com/workers/runtime-apis/request/) 与 [资源限制](https://developers.cloudflare.com/workers/platform/limits/) 是运行边界依据。

## 费用保护与运维

使用独立 OpenAI Project 和最小权限 API Key，设置预算/费用告警、模型权限和速率限制。**告警不是绝对费用硬上限**；若账户提供可执行支出限制，需单独核实设置及适用范围。[OpenAI 官方说明](https://developers.openai.com/api/docs/guides/terraform/rate-limits-and-spend)

按需配置 Cloudflare 自定义域名的 WAF Rate Limiting：按域名、`/v1/` 路径及客户端 IP 限制短时请求，阈值按个人流量与套餐确定，动作选阻断/429，先低流量验收。本版无内存计数器、无全局金额限额；仅创建一个 Rate Limit binding 并不会自动生效。详见 [部署与撤销](docs/deployment.md)。

Proxy Token 泄露后更新 Secret（旧 Token 立即对后续请求失效），分发新 Token，并检查异常流量；若 OpenAI Key 也可能泄露，另行撤销并重建 OpenAI Key。撤销代理 Token 不会撤销已送到上游的请求。

## 项目记录

[上游审查及最小设计](docs/audit.md) · [测试状态](docs/testing.md) · [部署说明](docs/deployment.md)

原项目 `cloudflare-worker.js` 保留为模块兼容入口，实际入口为 `src/worker.js`；使用 Wrangler 打包，不再使用旧 README 的单文件粘贴部署方法。
