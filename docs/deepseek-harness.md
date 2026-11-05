# DeepSeek Harness 配置

核实日期：2026-11-04。官方源码 `deepseek-ai/deepseek-harness`，提交 `8bd073392eef6f54e921a093b95076248eb08cbb`，根包 `0.2.2-alpha.3`；本机 CLI/适配包为 `0.2.1-rc.5`。字段说明依据上述源码；本机安装版已完成一次真实客户端基础文本测试，范围及编辑器限制见文末。

## 当前字段和入口

Settings → Models → Add model provider → Custom model API。Web 默认配置位于 `$DSH_HOME/profiles/web/cordis.patch.yml`；DSH_HOME 默认 `~/.dsh`。自定义启动 profile 使用对应目录。请求头当前需编辑配置文件，不能假设 Models 表单有 Header 输入框。

以下是 **profile patch**（不是完整启动配置）。已有 `llm-pi-ai` 条目应合并保留其他 Provider；Cordis config 覆盖可能替换整个 entry config，不能盲目覆盖。模型 ID 改为实际可用模型。

```yaml
- id: llm-pi-ai
  config:
    providers:
      openai-proxy:
        apiKeyEnv: OPENAI_PROXY_API_KEY
        api: openai-responses
        baseURL: https://api.example.com/v1
        headers:
          X-Proxy-Token: !!js process.env.PROXY_TOKEN
        retryPolicy:
          mode: normal
          maxRetries: 0
        models:
          - id: YOUR_MODEL_ID
```

完整 Cordis entry 使用 `name: '@deepseek-ai/dsh-llm-pi-ai'` + config；不要把 name 形式误当现有 patch 的 id。Chat Completions 使用另一 Provider ID 并设置 `api: openai-completions`，其余结构相同。一个 Provider 选择一种协议，不在 Worker 内做转换。

`apiKeyEnv` 从 Harness 凭据服务或环境解析 OpenAI Key；`headers` 是独立字典。`!!js process.env.PROXY_TOKEN` 来自官方 Cordis 表达式机制；启动进程前安全注入环境变量，变量为空时不应继续测试。不是 `${PROXY_TOKEN}` 字符串模板。本机真实测试采用的是文件读取表达式，不能把该结果当作上述环境变量示例已经实测；如解析失败需检查安装版配置机制，不把 Token 放进 API Key 字段。

代理使用独立的 OPENAI_PROXY_API_KEY 引用，可在 Harness 的代理 Provider 编辑页保存专用 OpenAI Key；保留官方 Provider 的 OPENAI_API_KEY。引用名分开不代表实际 Key 值必然不同，应由使用者分别创建、录入。

不把真实 Token 写进仓库或导出的配置。若 GUI 重存不保留表达式，先停止并检查配置差异，不把失败解释为代理需要单密钥模式。

## 源码证据与路径

- [官方 Provider 指南](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/docs/user/guide/providers.md)：配置路径、协议选择、patch 形式。
- [config.ts](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/packages/llm/llm-pi-ai/src/config.ts)：`headers` 字典及 Fetch 校验；[adapter.ts](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/packages/llm/llm-pi-ai/src/adapter.ts)：profile headers 进入 pi-ai 请求。
- [discovery.ts](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/packages/llm/llm-pi-ai/src/discovery.ts)：自定义 Provider 的 `GET /v1/models` 合并 Header 后设置 Bearer；内置 catalog Provider 可能不发模型列表请求。
- [Cordis 配置](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/docs/cordis-tutorial/05-config.md)：`!!js process.env`；[Loader](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/vendor/loader/src/config/utils.ts)：表达式求值。

正常推理使用 `/v1/responses` 或 `/v1/chat/completions`。模型 discovery 走 `/v1/models`。本版不支持 Harness 自带 DeepSeek 搜索/抓取、Anthropic Messages 或 OpenAI Codex 账户 OAuth 路由；应选择自定义 OpenAI API Provider。

## 实机验收范围与结果

记录实际 Harness、适配包、pi-ai 版本和有效 profile；以一个空测试目录运行，禁用 shell/文件写入等非必要工具。分别验证 Responses 和 Chat 的短文本、SSE、一个无副作用工具调用、模型列表。先错 Proxy Token（应 403），再正确 Proxy Token + 无效 OpenAI Key（应上游 401），最后用获准的有效 Key。只记录凭据是否存在，不记录值。确认中断及重试行为、Header 未被后续插件覆盖。

2026-11-04 实测：本机 Harness 0.2.1-rc.5 配置独立代理 Provider、独立 API Key 引用和文件读取形式的 Proxy Token 表达式后，用户通过真实界面使用 gpt-4.1-mini 完成一次文本问答，约 3 秒正常结束。协议配置为 Responses，传输配置为 SSE；这证明基础文本调用可用，不等同于逐事件 SSE 完整性、工具调用、长流、中断恢复或其他模型验收通过。未为此升级 Harness。

## 已知编辑器限制

本机 0.2.1-rc.5 的模型设置页，在 Header 使用 `!!js` 文件读取表达式时，删除测试模型并保存会出现：

```text
$.providers.openai-proxy.headers.X-Proxy-Token expected string but got [object Object]
```

运行时能解析表达式并完成请求，但配置编辑器的保存校验路径会遇到未解析的表达式对象。使用无真实凭据的合成输入可以复现同样的类型错误；字符串 Header 可以通过同一配置 Schema。此问题属于本次实际安装版的配置编辑兼容限制，不表示 Worker 认证失败，也不能据此断言其他版本具有相同行为。

问题具体针对 Header 中尚未解析的 `!!js` 表达式对象，并非所有自定义字段都不支持。即使只改模型名称、模型列表或推理等级，也可能因保存时校验同一 Provider 的 Header 而被连带阻止；其他设置页是否受影响须分别验证。运行时可用不代表设置界面能正确保存同一份配置。

### 当前维护决定（2026-11-05）

使用文件引用的部署中，Proxy Token 继续存于本机私有文件，通过表达式读取；以有效 profile 的 `cordis.patch.yml` 作为该代理 Provider 参数的主要维护入口。暂不修改本机安装的 Harness 程序，也不为规避错误将 Token 改成明文。此方法是操作上的替代方式，编辑器缺陷仍未修复。

### 以后修改配置的步骤

1. **确认目标并取消旧表单。** 核对实际启动的 profile、Harness 版本和当前配置；取消设置页中未保存的编辑，避免稍后用旧表单覆盖文件。只修改代理 Provider，不覆盖官方直连通道。
2. **备份当前文件。** 在本机私有、非 Git 目录保存一份可回退备份，采用受限权限；备份可能包含表达式、私有地址或其他敏感配置，不放进公开仓库。
3. **只改目标字段。** 保留 `!!js` 标签、Token 文件读取表达式、Header 名称、独立 API Key 引用及其他 Provider。新增模型时分别核实上下文、输入类型和 `reasoningEfforts`；删除模型时检查默认模型和已有会话是否仍引用它。不要靠关闭认证或删除 Header 让保存通过。
4. **校验语法和差异。** 使用能保留自定义 YAML 标签的解析方式，核对实际变更仅限预期字段。静态检查不要执行凭据读取表达式，不打印完整配置或已解析 Header。失败时先修正或恢复目标改动，不继续加载错误配置。
5. **重新加载并确认界面。** 等当前任务结束，在允许重启时重启 Harness 后端，再刷新网页；只刷新网页不能保证后端读取新文件。核对“OpenAI 代理”下的模型、等级及当前选择，不用同名官方模型作为验证依据。若需回退，应先检查备份之后是否还有其他修改，避免整份恢复覆盖新成果。
6. **记录结果。** 区分磁盘校验、本地模拟、界面确认和真实 API 调用；需要真实测试时按授权控制费用。同步配置说明与本机接续记录；如果涉及凭据位置、引用或生命周期变化，再按本机凭据保存约定更新台账。

遇到同样的保存错误时，取消表单并按上述文件维护流程处理，不反复点击保存。模型选择菜单中的会话切换与 Provider 设置页保存不是同一个操作；本次缺陷不能直接推断前者不可用。

### 后续修复与升级检查

如需推动上游修复，可另行准备不含真实凭据、个人域名或本机私有路径的最小复现，说明“运行时解析成功、编辑器保存校验失败”。尚未提交上游问题或补丁。

理想修复应保留原始表达式，并在正确阶段校验配置类型；不应为通过校验而执行任意表达式，或把解析出的真实 Token 写回文件。未来升级 Harness 后，先在隔离的假凭据配置中验证表达式能否原样保存、模型修改能否成功，再决定是否恢复使用 GUI 维护代理参数。升级或本机打补丁不属于本次已执行工作。


## 自定义代理模型的推理等级

2026-11-05 核对本机 Harness 0.2.1-rc.5：内置 `openai` Provider 可继承安装包的模型能力目录；自定义 `openai-proxy` 不会仅凭相同模型 ID 继承该目录。只填写名称、上下文和输入类型时，未声明 `reasoningEfforts` 的自定义模型被识别为 `reasoning: false`，界面不会提供推理等级。这与 Worker 的请求体转发无关。

在目标模型条目中显式添加以下映射，保留已有 ID、名称、容量和输入类型：

```yaml
# gpt-6-astra / gpt-6.1-sol 的模型条目
reasoningEfforts:
  low: low
  medium: medium
  high: high
  xhigh: xhigh
  max: max
```

`gpt-6.1-terra` 使用相同五档，并增加 `off: none`。不要给 Astra、Sol 添加 Off，也不要把不支持的档位写成 `null`：本版配置字典中省略的档位会被禁用；`off: null` 的语义是支持 Off 但不发送对应参数，与禁用 Off 不同。

| 模型 | 本次配置的可选等级 | 特殊映射 |
| --- | --- | --- |
| gpt-6-astra | Low / Medium / High / Xhigh / Max | 不提供 Off |
| gpt-6.1-sol | Low / Medium / High / Xhigh / Max | 不提供 Off |
| gpt-6.1-terra | Off / Low / Medium / High / Xhigh / Max | Off → Responses 的 `reasoning.effort: none` |

这些值来自本机安装包的 OpenAI 模型目录，不代表逐档真实 API 验收。以后新增或升级模型，应核实其能力映射；模型列表发现本身不能补全推理等级信息。“提供商默认”也不是固定的 High，不显式选择时使用默认行为。

本次先用旧配置复现三个模型均无推理能力元数据，再补齐配置。验证了模型选择器所需的能力对象、非法档位拒绝、pi-ai 实际请求序列化以及 Worker 的原始请求体透传，共 19 个本地场景（16 个显式档位 + 3 个默认行为）通过。全程使用假凭据和拦截的本地响应，没有访问真实 OpenAI。这不等于已验证云端逐档接受、推理质量、费用或长响应。

磁盘修改后需确认运行中的服务重新加载配置。仅刷新网页不一定有效；本机曾需先执行部署者自己的停止/启动命令，再刷新界面。2026-11-05 用户重启后确认推理等级已出现；这是用户反馈的界面验收，不代表逐档真实 API 调用已验证。Header 的 `!!js` GUI 保存限制仍存在，操作方式见上一节；不要通过把 Token 写成明文来规避。

## 图片模型不等同于可用聊天模型

模型发现返回的列表不代表当前客户端和代理支持所有模型的接口。GPT Image 2.5 系列用于生成、编辑图片；不能仅把它填入当前 Responses Provider 的顶层 model，就假定它能像通用模型一样聊天或画图。

按 [OpenAI 图片生成工具说明](https://developers.openai.com/api/docs/guides/tools-image-generation)，Responses 顶层使用受支持的通用模型，通过 image_generation 工具选择 gpt-image-2.5-sunburst 或 gpt-image-2.5-flare。客户端还需支持工具请求和图片结果的处理、展示。当前 Harness 的这条路径尚未核实或测试。

本 Worker 未开放独立的 /v1/images/generations、/v1/images/edits 路径。已允许 /v1/responses 不等于已验收图片生成：其工具参数可随原始请求体转发，但客户端适配、图片输出、耗时与费用仍需单独验证。当前没有增加图片端点、插件或图片生成测试。
