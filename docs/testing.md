# 测试结果与真实验收清单

更新日期：2026-11-05。验证对象：本分支 `src/worker.js` 及随附示例。以下保留原有 Mock 回归记录，并补充已部署 Worker 的真实 SDK 测试和用户执行的 Harness 基础文本测试；它们是不同层次的证据。本次文档整理未修改 Worker、未追加付费调用。对应公开源码版本为 `3abcde8`；下列真实结果不等于全部端点、模型和客户端功能均通过。

## 已执行的本地 Mock 与发布前检查（历史记录）

| 检查 | 结果 | 能证明的范围 |
| --- | --- | --- |
| `npm test` | 62 项通过 | 认证、固定上游、路径/方法、Header、原始 JSON/Multipart/二进制、错误、SSE、并发、日志自检；2 项原有 workerd 测试、新增压缩组及 3 个子场景、5 项扫描回归 |
| `npm run test:sdk` | 59 个测试条目通过；含 18 个 SDK 场景、12 次正常示例执行及 56 次完成状态回归 | Node/Python SDK → 本地 workerd → Mock；全部出站由测试接管 |
| `npm run test:long` | 1 项通过，实际持续约 65 秒 | 本地 HTTP → workerd → 定时 Mock SSE，首字节 <5 秒，66 个事件顺序与内容一致 |
| `npm run build` | dry-run 通过 | Wrangler 可打包；约 4.92 KiB，gzip 1.85 KiB，无 Worker 运行依赖 |
| `npm run scan:secrets` | 未发现常见凭据模式 | 当前非忽略文件、暂存区实际 blob 及全部可达历史 blob/commit；不输出匹配内容，不是完备泄密证明 |
| `npm audit --registry=https://registry.npmjs.org` | 0 个已知漏洞 | 当日开发依赖公告；不代表不存在未知漏洞 |
| `git diff --check`、语法检查、LICENSE 比对 | 通过 | 无空白错误；MIT 与原作者版权原样保留 |

环境：Node 24.19.0、Python 3.9.6、OpenAI Node 7.50.0、OpenAI Python 2.48.0、Wrangler 4.157.0、workerd 1.20261103.1、Miniflare 5.20261103.0-beta（该 Wrangler 自带依赖版本；测试显式使用其 v4 配置转换器）。Node 测试中给 `crypto.subtle.timingSafeEqual` 接入 Node 原生比较以运行同一业务代码；workerd 测试额外验证 Workers 自带原语，不以 polyfill 结果代替运行时。

默认 npm mirror 不提供 audit 接口，所以只读漏洞查询改用官方 npm registry；未修改用户全局 npm 配置。

## 覆盖细节

- 未配置/缺失/错误/重复 Proxy Token，缺少/错误/重复 Bearer；拒绝时上游调用数为零。
- 各方法无法绕过认证；非法路径、编码路径、重复斜杠、目标 Query/Header 注入；固定上游 HTTPS；不跟随 3xx，不向客户端返回重定向目标。
- 重要 OpenAI/SDK 头保留，X-Proxy-Token、Cookie、X-Api-Key、代理认证、Host/长度和逐跳头剥离；响应 Request ID/Retry-After 保留，无通配 CORS，无缓存。
- Chat 与 Responses 普通/流式；工具定义与返回、结构化 schema/输出；非 JSON 上游错误与 401/429/500 等状态。
- SSE 多事件、注释、CRLF、UTF-8 跨块、顺序；不预读完整响应。压缩回归用原始 HTTP 客户端 → workerd → HTTP 字节桥 → 本地 gzip 上游，验证 JSON、SSE、429 的编码头、解压内容及压缩字节一致；不使用会自动解压的客户端来判断线上字节，也不以 Node Response 注入测试代替 workerd 行为。
- Node 核心测试验证请求信号、响应 cancel、流错误、20 请求并发；实际本地 HTTP 断开在代理 Worker 与 Mock Worker 之间验证取消信号/流取消。初版 Node outboundService 桥接 Mock 未观测到 cancel，改用两个 workerd isolate，未为迁就 Mock 改生产实现。
- 两个 SDK 各 9 项：模型列表、Responses 普通/流式/工具/结构化、Chat 普通/流式/工具、429。交付示例每种语言再运行 6 个模式。所有模型和响应均为测试构造，不证明任何真实模型支持该能力。
- Cherry/DeepSeek 模拟是构造同类 Header 和路径；这些模拟本身不证明真实客户端兼容，后续实测单独记录如下。

## 首次复查修复（已提交于 `2c841b7`）

针对 `74d5be1` 发现的两个缺陷，先添加回归测试并确认旧代码失败，再修复：

- Python/Node Responses 流示例收到 `response.failed`、`response.incomplete` 或缺少完成事件的 EOF，均以退出码 1 报告状态并关闭流；已输出文本保留为部分结果。两种语言各验证失败、未完成、提前结束、正常完成，共 8 个场景，全部通过。
- 扫描器单独读取 Git index 的 blob ID 和内容，不再用工作文件替代暂存内容。5 个隔离临时仓库场景覆盖：首次提交前的干净暂存区、暂存凭据后清理工作文件（含特殊文件名）、删除工作文件、未跟踪文件、已从当前文件移除但仍在历史里的凭据。输出不含测试凭据值，全部通过。

该轮重跑 `npm test`、`npm run test:sdk`、密钥扫描与差异检查；Worker、Wrangler 配置和依赖没有变化，65 秒长流、打包及依赖审计沿用当时同一 Worker 版本的既有记录。该轮无真实 API 调用或远程修改。

## 本次压缩与完成状态修复

针对 `2c841b7` 的再次审查，先添加测试确认旧代码失败，再修复：

- 压缩 JSON、SSE 和 429 响应在旧代码下均触发 `Z_DATA_ERROR`。移除 `encodeBody: manual` 后，实际 workerd/HTTP 链路返回的 gzip 可解压且与上游压缩字节一致；状态码和必要响应头保留。
- Node/Python 的非流式 Responses 三个模式统一要求 `completed` 后才输出；Chat 普通及流式纯文本模式只接受 `finish_reason=stop`。新增 48 个场景覆盖失败、未完成、缺失状态、长度/过滤/意外工具终止、只有 EOF 或 `[DONE]`、正常完成及空 choices 用量帧；旧实现暴露的失败退出码和 Python 空 choices 问题均已修复。连同原有 8 个 Responses 流终态场景，共 56 次完成状态回归通过。
- 正常 Chat 流 Mock 补上真实协议要求的 `finish_reason=stop` chunk；SDK 内部消耗 `[DONE]`，因此 `stop` 后自然 EOF 被视为成功，但只有 `[DONE]` 而没有 `stop` 仍失败。没有把 SDK 能观测的终态当作原始分隔标志校验。

本轮重跑基础测试、SDK 测试、65 秒长流、Wrangler 本地 dry-run、密钥扫描和差异检查；依赖未变，依赖审计沿用当日既有结果。源码改动与回归覆盖另经只读独立复查。所有测试只使用本地 Mock，无真实 API 调用、推送或部署。

## 真实部署与低成本测试

2026-11-04 经授权完成个人 Worker 自定义域名部署。未认证 GET models、POST responses、OPTIONS responses 返回代理 403；正确 Proxy Token 下，缺少/错误 Bearer 分别返回 401，不支持路径返回 404，不支持方法返回 405。这些拒绝场景没有携带可用 OpenAI Key，也没有触发模型生成；上游调用阻断机制另由 Mock 断言验证。

当日，官方 SDK 经已部署 Worker 的真实测试使用 gpt-4.1-mini，8 次模型请求、自动重试 0、每次输出上限 128 tokens，全部 HTTP 200 且完成状态符合预期：

| 客户端 | 真实场景 | 结果 |
| --- | --- | --- |
| Python OpenAI 2.48.0 | Responses 普通文本、流式文本、函数调用输出、结构化输出 | 4/4 通过 |
| Node OpenAI 7.50.0 | Responses 普通文本、流式文本；Chat 普通文本、流式文本 | 4/4 通过 |

两次 Responses 流各观测到 9 个 SDK 事件并以 response.completed 结束；Chat 流记录 4 个 SDK 事件并正常 stop。函数调用仅检查返回的调用结构，没有执行函数或回传工具结果。SDK 报告合计输入 156、输出 18 tokens；实际账单以 OpenAI 为准，不用此数据推算 Harness 的费用。

同日，DeepSeek Harness 0.2.1-rc.5 经独立代理 Provider 使用 gpt-4.1-mini 完成一次基础文本问答。客户端配置为 Responses + SSE，验收依据为真实界面的完成状态。逐事件网络轨迹、工具闭环、长流和取消仍待验证。配置方式见 [Harness 文档](deepseek-harness.md)。

## 2026-11-05 Harness 推理等级配置回归

本机 0.2.1-rc.5 的三个代理模型补齐 reasoningEfforts。修复前检查能检出三项缺失；修复后，安装版能力解析函数生成正确的选择器元数据，非法档位被拒绝。实际 pi-ai Responses 请求序列化与本地 Node Worker 透传共 19 个场景通过：Astra/Sol 各 5 档、Terra 6 档，另加三个模型的默认行为。Worker 测试注入 Node 的安全比较原语和假上游，不是本次 workerd/真实边缘验收。

真实 Key/Token 未读取，网络被拦截，未发生付费调用。仅新增本机配置字段与文档，未改 Worker、未升级 Harness；原有 Mock/真实测试记录仍为历史记录，本轮未全量重跑。2026-11-05 用户重启后确认推理等级已出现。该反馈证明选项显示问题已解决；未单独记录三个模型逐项截图或逐档真实 API 结果。具体映射见 [Harness 文档](deepseek-harness.md)。

## 兼容性分层

| 客户端 | 静态配置审查 | Mock/本地 Worker | 真实 OpenAI + 已部署 Worker |
| --- | --- | --- | --- |
| 官方 Node SDK 7.50.0 | 通过 | SDK 与示例通过 | 上述 4 项通过，其余待验证 |
| 官方 Python SDK 2.48.0 | 通过 | SDK 与示例通过 | 上述 4 项通过，其余待验证 |
| Cherry Studio 源码 2.1.10 | 自定义头/Responses 确认 | 同类请求模拟通过 | 未安装运行，待验证 |
| DeepSeek Harness 源码 0.2.2-alpha.3 | Provider/headers/协议确认 | 同类请求模拟通过 | 本机 0.2.1-rc.5 基础文本通过，其余待验证 |

## 剩余真实验收

以下为剩余验收项；已完成部分见上方真实结果。扩大测试前明确客户端版本、模型、调用次数与费用范围，并遵守当次授权。模型权限、SDK 解析、Worker 传输分开记录。不做无意义高频压测；失败先分析，关闭重试。

- [x] 代理拒绝场景和有效 Key 的最短响应：范围见上方记录；上游阻断的调用计数由 Mock 验证。
- [x] Python Responses 普通/流式/函数调用输出/结构化；Node Responses 与 Chat 普通/流式。
- [x] Harness 实际界面的基础文本调用。
- [ ] 正确 Proxy Token + 无效 OpenAI Key 的真实上游 401（Mock 已覆盖）。
- [ ] 其余 SDK 真实场景：Node Responses 工具/结构化、Python Chat 普通/流式、两种 SDK 的 Chat 工具调用。
- [ ] 工具调用再由客户端返回无副作用结果，确认多轮 function_call_output/tool message 闭环；不执行真实 shell/文件修改。
- [ ] 真实长响应及中途停止，检查连接关闭、用量与事件终态；断开不保证已生成 token 不计费。Mock 的长流和取消不能代替这项。
- [ ] Cherry：模型列表、连接检查、Chat、Responses 普通/流式、停止、工具功能。
- [ ] Harness：模型发现、Chat 协议、逐事件 SSE、工具闭环、取消和其他模型；确认未切换至其他 Provider。
- [x] Harness 重启后推理等级显示：2026-11-05 用户确认；三个模型的能力映射另由本地检查验证。
- [ ] 各模型逐档真实 API 接受情况及默认行为验收。
- [ ] Secrets 轮换/撤销演练、真实边缘无缓存和日志脱敏复核。DNS/证书可达及禁用额外入口已有记录；本次未重新查询远程状态。

启用 Cloudflare 限流规则的部署者应按实际配置另行验收。

不要为得到 429/500 而大量调用真实接口；这些故障已由 Mock 覆盖。真实环境自然出现时记录脱敏证据即可。真实服务地区和使用政策遵从由部署与使用方核实。
