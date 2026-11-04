# Cherry Studio 配置

核实日期：2026-11-04。源码 `CherryHQ/cherry-studio`，提交 `f5c1df49de1b44e64aceb9dc9ed0023abb6a2e1f`，package.json 标示 `2.1.10`。这是读取的 main 快照，不声称等于所有用户安装的最新稳定发行版；本机 /Applications 未发现 Cherry Studio，未运行实际应用。

## 设置

1. 设置 → 模型服务，添加/选择使用 API Key 的 OpenAI 或自定义服务商。
2. API Key 填 OpenAI Key；API 地址填 `https://YOUR_DOMAIN/v1`。
3. API 地址旁的请求配置入口打开“请求配置”抽屉，在“自定义请求头”增加：名称 `X-Proxy-Token`，值为你的代理 Token。JSON 模式等价于 `{"X-Proxy-Token":"YOUR_PROXY_TOKEN"}`。
4. 只增加该 Header，不设置 Authorization、X-Api-Key 或 Content-Type。源码允许自定义头覆盖已有头，因此不能笼统声称 Authorization 永远不会被覆盖；仅添加 X-Proxy-Token 时两者独立。
5. 请求配置/模型的端点类型选择 OpenAI Responses，Base URL 仍为上述 `/v1`；Chat 选择 OpenAI Chat Completions。请求预览应分别结束于 `/v1/responses` 和 `/v1/chat/completions`，避免双重 `/v1`。不要把完整 `/responses` URL 填到普通 base URL 字段。

源码有独立的请求配置抽屉、Header 列表/JSON 编辑和每端点 Base URL；旧版 UI 可能不同，应以安装版为准。Responses 端点存在不保证所有模型功能可用。若客户端配置了不在本代理范围内的嵌入/图片等功能，会得到 404。

## 核实依据

- [ApiHost 入口](https://github.com/CherryHQ/cherry-studio/blob/f5c1df49de1b44e64aceb9dc9ed0023abb6a2e1f/src/renderer/pages/settings/ProviderSettings/ConnectionSettings/ApiHost.tsx) 与 [ProviderCustomHeaderDrawer](https://github.com/CherryHQ/cherry-studio/blob/f5c1df49de1b44e64aceb9dc9ed0023abb6a2e1f/src/renderer/pages/settings/ProviderSettings/ConnectionSettings/ProviderCustomHeaderDrawer.tsx)：保存到 `provider.settings.extraHeaders`。
- [Header 合并](https://github.com/CherryHQ/cherry-studio/blob/f5c1df49de1b44e64aceb9dc9ed0023abb6a2e1f/src/main/ai/utils/provider.ts)：默认 Bearer 与额外头并存，但额外头可覆盖同名字段。
- [Provider 构造](https://github.com/CherryHQ/cherry-studio/blob/f5c1df49de1b44e64aceb9dc9ed0023abb6a2e1f/src/main/ai/provider/config.ts) 和 [端点创建](https://github.com/CherryHQ/cherry-studio/blob/f5c1df49de1b44e64aceb9dc9ed0023abb6a2e1f/src/renderer/pages/settings/ProviderSettings/ProviderList/customProviderCreation.ts)：Responses、Chat 分路，Header 传入 SDK。
- [模型列表](https://github.com/CherryHQ/cherry-studio/blob/f5c1df49de1b44e64aceb9dc9ed0023abb6a2e1f/src/main/ai/provider/listModels.ts)：OpenAI 类模型列表使用 `/models`（结合 base URL 为 `/v1/models`），携带配置的 Header。

连接测试可能发送实际生成请求，不应当成免费健康检查。文本模型在本版已支持的 Chat/Responses 路径内；其他模型类别可能触发图片、音频、嵌入等未开放端点。避免一键批量检查所有模型和所有 Key。

## 实机验收（待部署及真实调用授权）

记录应用版本、Provider 类型、端点与所选模型。先用错误 Proxy Token 检查 403，再用正确 Proxy Token 和无效 OpenAI Key 区分上游 401；最后逐项测试模型列表、短文本、SSE 连续输出、停止生成和 Responses 工具调用。必要时使用只记录 Header 名称/存在布尔值的本地检查器，禁止导出带密钥的 HAR。

若模型列表成功但生成失败，比较生成使用的端点、Header 与模型权限；若两者都 403，优先排查 Header 是否保存/发送。浏览器 Web 版如发起 CORS 预检，本版默认不支持，不能直接开启通配 CORS 掩盖差异。

现状：源码确认自定义 Header 及 Responses 路径；对应请求模拟通过；**真实 Cherry Studio → 已部署 Worker → OpenAI 未验证**。
