# DeepSeek Harness 配置

核实日期：2026-11-04。官方源码 `deepseek-ai/deepseek-harness`，提交 `8bd073392eef6f54e921a093b95076248eb08cbb`，根包 `0.2.2-alpha.3`；本机 CLI/适配包为 `0.2.1-rc.5`。下文依据上述源码，不能直接声称旧安装版已支持全部行为；未修改本机 Harness 配置、未启动实际会话。

## 当前字段和入口

Settings → Models → Add model provider → Custom model API。Web 默认配置位于 `$DSH_HOME/profiles/web/cordis.patch.yml`；DSH_HOME 默认 `~/.dsh`。自定义启动 profile 使用对应目录。请求头当前需编辑配置文件，不能假设 Models 表单有 Header 输入框。

以下是 **profile patch**（不是完整启动配置）。已有 `llm-pi-ai` 条目应合并保留其他 Provider；Cordis config 覆盖可能替换整个 entry config，不能盲目覆盖。模型 ID 改为实际可用模型。

```yaml
- id: llm-pi-ai
  config:
    providers:
      personal-openai-proxy:
        apiKeyEnv: OPENAI_API_KEY
        api: openai-responses
        baseURL: https://YOUR_DOMAIN/v1
        headers:
          X-Proxy-Token: !!js process.env.PROXY_TOKEN
        retryPolicy:
          mode: normal
          maxRetries: 0
        models:
          - id: YOUR_MODEL_ID
```

完整 Cordis entry 使用 `name: '@deepseek-ai/dsh-llm-pi-ai'` + config；不要把 name 形式误当现有 patch 的 id。Chat Completions 使用另一 Provider ID 并设置 `api: openai-completions`，其余结构相同。一个 Provider 选择一种协议，不在 Worker 内做转换。

`apiKeyEnv` 从 Harness 凭据服务或环境解析 OpenAI Key；`headers` 是独立字典。`!!js process.env.PROXY_TOKEN` 来自官方 Cordis 表达式机制；启动进程前安全注入环境变量，变量为空时不应继续测试。不是 `${PROXY_TOKEN}` 字符串模板。源码支持环境表达式，不代表已用本机旧安装版跑通；旧版如解析失败需先检查该版本配置机制，不把 Token 放进 API Key 字段。

不把真实 Token 写进仓库或导出的配置。若 GUI 重存不保留表达式，先停止并检查配置差异，不把失败解释为代理需要单密钥模式。

## 源码证据与路径

- [官方 Provider 指南](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/docs/user/guide/providers.md)：配置路径、协议选择、patch 形式。
- [config.ts](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/packages/llm/llm-pi-ai/src/config.ts)：`headers` 字典及 Fetch 校验；[adapter.ts](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/packages/llm/llm-pi-ai/src/adapter.ts)：profile headers 进入 pi-ai 请求。
- [discovery.ts](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/packages/llm/llm-pi-ai/src/discovery.ts)：自定义 Provider 的 `GET /v1/models` 合并 Header 后设置 Bearer；内置 catalog Provider 可能不发模型列表请求。
- [Cordis 配置](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/docs/cordis-tutorial/05-config.md)：`!!js process.env`；[Loader](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/vendor/loader/src/config/utils.ts)：表达式求值。

正常推理使用 `/v1/responses` 或 `/v1/chat/completions`。模型 discovery 走 `/v1/models`。本版不支持 Harness 自带 DeepSeek 搜索/抓取、Anthropic Messages 或 OpenAI Codex 账户 OAuth 路由；应选择自定义 OpenAI API Provider。

## 待授权后的实机验收

记录实际 Harness、适配包、pi-ai 版本和有效 profile；以一个空测试目录运行，禁用 shell/文件写入等非必要工具。分别验证 Responses 和 Chat 的短文本、SSE、一个无副作用工具调用、模型列表。先错 Proxy Token（应 403），再正确 Proxy Token + 无效 OpenAI Key（应上游 401），最后用获准的有效 Key。只记录凭据是否存在，不记录值。确认中断及重试行为、Header 未被后续插件覆盖。

现状：静态支持已确认；Worker 模拟通过；**真实 Harness → 已部署 Worker → OpenAI 未验证**。当前没有自动升级或运行现有 Harness，以免带入用户现有 Provider 和真实凭据。
