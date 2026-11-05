# 部署到自己的 Cloudflare

完成后，你会得到一个自己的 API 地址，例如 `https://api.example.com/v1`。以下命令适用于 macOS、Linux 或 WSL 的 **Bash**，请在同一个终端中按顺序执行。准备好 Git、Node.js 22 或更高版本（含 npm）、curl，以及一个由你的 Cloudflare 账户管理、状态为 Active 的域名。

## 1. 下载并安装

```bash
git clone https://github.com/Noah-Kent/cloudflare-openai-proxy.git
cd cloudflare-openai-proxy
npm ci
```

可以直接克隆并部署。想在自己的 GitHub 保存代码修改时再创建 Fork。需要运行完整开发测试的读者可按 [本地开发与测试](../README.md#本地开发与测试) 安装 Python 依赖。

## 2. 登录并选择子域名

```bash
npx wrangler login
npx wrangler whoami
```

在浏览器核对授权账户和权限。回到终端确认显示的账户拥有目标域名。如果能访问多个账户，请在下一步的私有配置顶层填写目标账户的 `account_id`。

挑选一个空闲子域名。在 Cloudflare 的 DNS 记录和 Workers 自定义域名、路由中检查它是否已指向其他服务。如有冲突，请换一个名称。Cloudflare 会在绑定时管理所需的 DNS 记录和证书。[Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)

## 3. 设置个人部署配置

从仓库根目录执行。配置副本位于 Git 忽略目录，重复执行会保留已有副本。

```bash
mkdir -p .wrangler/deploy
cfg=.wrangler/deploy/wrangler.toml
cp -n wrangler.toml "$cfg"
```

用文本编辑器打开 `.wrangler/deploy/wrangler.toml`。在 `[observability]` **上方**修改已有的 `name`、`main` 两行，并添加 `routes`。保留模板里的其余设置。首次部署请用自己账户中尚未使用的 Worker 名称，并把示例域名换成刚检查过的子域名。

```toml
name = "my-openai-proxy"
main = "../../src/worker.js"
routes = [{ pattern = "api.example.com", custom_domain = true }]
```

`main` 相对于配置副本所在目录解析。先用同一份配置在本地预演，终端应显示打包成功及 dry-run 结束。

```bash
npx wrangler deploy --dry-run --config "$cfg"
```

## 4. 部署并设置 Proxy Token

用密码管理器生成并保存一个 64 字符的随机字母数字串，区分大小写。确认上一步的账户、Worker 名称和域名后执行：

```bash
npx wrangler deploy --config "$cfg"
npx wrangler secret put PROXY_TOKEN --config "$cfg"
```

第一条上传 Worker 并绑定域名。对于新建 Worker，设置 Secret 前，受保护请求会返回 403。第二条提示输入 Secret 时粘贴刚保存的 Proxy Token。看到上传成功后，客户端也使用同一个值。**OpenAI API Key 由客户端单独保存**。将来更新 Secret 时继续使用同一份私有配置。[Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

## 5. 验证域名和认证（零模型费用）

将下面的主机名换成你刚部署的域名。证书生效后，在 Bash 里请求模型列表，查看响应状态和 JSON 错误类型。

```bash
base_url='https://api.example.com/v1'
curl -q -sS -w '\nHTTP %{http_code}\n' "$base_url/models"
```

预期为 **HTTP 403**，JSON 中 `error.type` 为 `proxy_error`。这表明该地址已到达 Worker 的认证检查。接下来只发送 Proxy Token，暂时省略 OpenAI Key：

```bash
IFS= read -rs -p 'Proxy Token（输入隐藏）: ' proxy_token
printf '\n'
printf 'X-Proxy-Token: %s\n' "$proxy_token" |
  curl -q -sS -H @- -w '\nHTTP %{http_code}\n' "$base_url/models"
unset proxy_token
```

预期变为 **HTTP 401**，JSON 中仍为 `proxy_error`。这表示 Worker 已接受 Proxy Token，接下来要求 OpenAI Bearer 凭据。两次请求都在 Worker 内结束。如果第二次仍是代理 403，请检查 Secret 名称、目标 Worker、大小写和粘贴内容。如果返回 HTML，请先检查绑定域名、DNS 和 Cloudflare 安全规则。

## 6. 连接客户端

| 客户端设置 | 填写内容 |
| --- | --- |
| Base URL | 自己的接口地址，例如 `https://api.example.com/v1` |
| API Key | 自己的 OpenAI Project API Key，客户端用它发送 `Authorization: Bearer …` |
| 自定义请求头 | 名称 `X-Proxy-Token`，值为第 4 步保存的 Proxy Token |
| 模型 | 选择该 OpenAI Project 可用且适合任务的模型 ID |

按所用客户端继续：[Python / Node SDK 示例](../README.md#sdk-示例) · [DeepSeek Harness](deepseek-harness.md) · [Cherry Studio](cherry-studio.md)。首次真实验证可只发一次短文本，并关闭自动重试。生成回复会使用 OpenAI Project 的额度。已验证的客户端、协议与待测项目见 [测试记录](testing.md)。

## Token 轮换/撤销

- 轮换：`npx wrangler secret put PROXY_TOKEN --config .wrangler/deploy/wrangler.toml` 输入新随机 Token；更新可信客户端。单 Token 无双密钥过渡期，旧 Token 对后续请求立即失败。
- 紧急撤销：经批准执行 `npx wrangler secret delete PROXY_TOKEN --config .wrangler/deploy/wrangler.toml`；所有受保护请求失败关闭。已转发的请求可能仍继续。
- OpenAI Key 是独立凭据，只能在 OpenAI 平台撤销/重建，不在 Worker 注入替代 Key。
- 回滚旧 Worker 版本前检查其代码和 Secret 行为，禁止回滚到本项目上游无 Proxy Token 认证的版本。

## 限流与费用

需要额外限流时，可在 Cloudflare zone 的 Security rules → Create rule → Rate limiting rules 创建规则（[官方步骤](https://developers.cloudflare.com/waf/rate-limiting-rules/create-zone-dashboard/)）：匹配此专用 host 和 `/v1/`，按 IP 限制请求速率，使用阻断/429，记录实际套餐可用的计数窗和阈值。个人低流量可从保守阈值开始，但共享出口可能误伤；测试后再调整。不要把两类密钥作为日志字段或公开规则中的字面值。

自定义域名规则不会自动保护独立 workers.dev/preview 地址，因此本配置默认禁用它们。不要用 JavaScript 进程内计数器声称全局限流。Workers [Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) 是另一方案，但需要实际接入调用；本版未实现该 binding。Cloudflare 分布式限流不是金额硬上限。独立 OpenAI Project/Key、预算告警、模型权限和重试限制一起使用。

## 故障定位

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

## 维护自己的 Fork（可选）

若要公开自己的修改，在 GitHub 创建 Fork，克隆自己的 Fork 后按常规分支与 PR 流程提交。保留 MIT 原版权声明。发布前运行 `npm run scan:secrets` 并核对暂存差异，确认提交中只有通用模板、占位符与预期改动。个人部署文件保存在 Git 忽略目录。
