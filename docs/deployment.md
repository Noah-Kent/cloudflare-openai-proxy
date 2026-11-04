# 发布与部署操作单

GitHub 源码发布与 Cloudflare 部署分别处理。公开仓库无需配置 Cloudflare 账号或真实域名。Release、Cloudflare 部署/Secret 变更和真实 OpenAI 调用仍需另行授权。以下命令是操作说明。

## 1. GitHub

本地完整上游历史保留，`upstream` 指向 `https://github.com/barretlee/cloudflare-proxy.git`。发布仓库为 [Noah-Kent/cloudflare-openai-proxy](https://github.com/Noah-Kent/cloudflare-openai-proxy)，保留 GitHub Fork 关系。下列步骤供后续使用者创建自己的 Fork 时参考。

在创建 Fork 并取得推送授权后：

```sh
git remote add origin https://github.com/YOUR_ACCOUNT/cloudflare-openai-proxy.git
git fetch origin
git push -u origin feat/secure-openai-proxy
```

建议以 PR 审阅后再合入默认分支；创建 Fork、推送、合入和 Release 分开处理。MIT 原版权声明不得删除。同步上游时先 `git fetch upstream` 检查差异，不覆盖本版认证与测试。

发布前运行 `npm run scan:secrets`；它分别扫描工作文件、暂存区实际 blob 和可达历史，即使工作文件已清理或删除，暂存区里的凭据仍会被检出。再核对 staged diff 和历史，确认 `.dev.vars`、`.env*`、`.research/` 不被跟踪。扫描器只能发现常见密钥模式，不能作为密钥绝对不存在的证明；若曾提交过真实密钥，先撤销再处理历史，不能只删除当前文件。

## 2. Cloudflare 首次部署

先确认个人账户、Worker 名称、自定义域名、套餐限额、服务地区/政策和预期公开范围。源码无真实配置。默认 `workers_dev=false`、`preview_urls=false`，减少额外入口。

批准后执行：

```sh
WRANGLER_SEND_METRICS=false npx wrangler login
WRANGLER_SEND_METRICS=false npx wrangler whoami
```

在 `wrangler.toml` **顶层、`[observability]` 之前**设置自己 Cloudflare zone 的子域名，例如：

```toml
routes = [{ pattern = "api.example.com", custom_domain = true }]
```

确认该域名没有需要保留的冲突记录或其他服务。先部署拒绝所有业务请求的版本，再配置 Secret：

```sh
npm test
npm run test:sdk
WRANGLER_SEND_METRICS=false npm run build
# 以下两条改变远程资源，须授权：
WRANGLER_SEND_METRICS=false npm run deploy
WRANGLER_SEND_METRICS=false npx wrangler secret put PROXY_TOKEN
```

通过密码管理器生成 32 随机字节的 hex Token，交互输入 Secret；不要将 Token 作为命令行参数、写入 toml、命令历史或聊天。初次部署没有 Secret 时 Worker 会 403，避免先开放再认证。域名证书/DNS 生效后才能测试。

依据：[Secrets](https://developers.cloudflare.com/workers/configuration/secrets/) · [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)。

## 3. Token 轮换/撤销

- 轮换：`npx wrangler secret put PROXY_TOKEN` 输入新随机 Token；更新可信客户端。单 Token 无双密钥过渡期，旧 Token 对后续请求立即失败。
- 紧急撤销：经批准执行 `npx wrangler secret delete PROXY_TOKEN`；所有受保护请求失败关闭。已转发的请求可能仍继续。
- OpenAI Key 是独立凭据，只能在 OpenAI 平台撤销/重建，不在 Worker 注入替代 Key。
- 回滚旧 Worker 版本前检查其代码和 Secret 行为，禁止回滚到本项目上游无 Proxy Token 认证的版本。

## 4. 限流与费用

上线前在 Cloudflare zone 的 Security rules → Create rule → Rate limiting rules 创建规则（[官方步骤](https://developers.cloudflare.com/waf/rate-limiting-rules/create-zone-dashboard/)）：匹配此专用 host 和 `/v1/`，按 IP 限制请求速率，使用阻断/429，记录实际套餐可用的计数窗和阈值。个人低流量可从保守阈值开始，但共享出口可能误伤；测试后再调整。不要把两类密钥作为日志字段或公开规则中的字面值。

自定义域名规则不会自动保护独立 workers.dev/preview 地址，因此本配置默认禁用它们。不要用 JavaScript 进程内计数器声称全局限流。Workers [Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) 是另一方案，但需要实际接入调用；本版未实现该 binding。Cloudflare 分布式限流不是金额硬上限。独立 OpenAI Project/Key、预算告警、模型权限和重试限制一起使用。

## 5. 接口验证

先在不使用任何真实 Key 的情况下检查未认证 `GET /v1/models` 和 `OPTIONS /v1/responses` 均 403；再设置正确 Proxy Token，验证缺少 Bearer 为 401、不支持路径为 404。此阶段不会调用上游。

真实上游验收使用 SDK 示例，先安全设置 `OPENAI_BASE_URL`、两类 Key、`OPENAI_MODEL`，再明确启用 `ALLOW_REAL_API=1`。逐个低成本请求，不做循环压测，不在 `curl -v`、HAR、截图或日志展示认证头。连接测试也可能产生模型费用。

## 6. 故障定位

| 现象 | 优先检查 |
| --- | --- |
| 403，`type=proxy_error` | Proxy Token 缺失、错误、未配置或不符合 32–256 字符格式 |
| 401，`type=proxy_error` | Authorization 缺失或 Bearer 格式错误 |
| 上游 401/403 | OpenAI Key、Project、权限/政策；不是代理 Token 校验 |
| 404/405，`type=proxy_error` | base URL 重复 `/v1`、未开放端点或方法 |
| 429 | 若上游内容则 OpenAI 限流/配额；也可能 Cloudflare 规则，分别辨认响应 |
| 502，`type=proxy_error` | 上游连接失败或重定向被拒绝；不输出底层异常中的敏感信息 |
| 499 | 客户端在上游建立阶段取消；断开后客户端可能根本收不到此响应 |
| SSE 提前结束 | 客户端超时、网络、Cloudflare/上游限制；不要把半段输出伪造为完成 |
| 浏览器预检失败 | 本版默认无 CORS；使用可信服务端/桌面主进程 |
| 无法访问域名 | DNS、证书、route、workers_dev 默认禁用、自定义域名所属 zone |

[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/) 涉及内存、CPU、请求体大小与连接；流转发减少缓冲并不消除平台限制。真实长连接和边缘取消尚未验收，不能用 100ms 本地延迟模拟替代。
