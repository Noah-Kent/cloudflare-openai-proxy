# 测试结果与真实验收清单

日期：2026-11-04。验证对象：本分支 `src/worker.js` 及随附示例；最终本地提交可用 `git log -1` 获取。没有调用真实 OpenAI API，没有部署，没有运行第三方真实客户端。

## 已执行结果

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
- Cherry/DeepSeek 模拟是构造同类 Header 和路径，没有运行它们的程序，因此不标记真实客户端通过。

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

## 兼容性分层

| 客户端 | 静态配置审查 | Mock/本地 Worker | 真实 OpenAI + 已部署 Worker |
| --- | --- | --- | --- |
| 官方 Node SDK 7.50.0 | 通过 | SDK 与示例通过 | 待授权 |
| 官方 Python SDK 2.48.0 | 通过 | SDK 与示例通过 | 待授权 |
| Cherry Studio 源码 2.1.10 | 自定义头/Responses 确认 | 同类请求模拟通过 | 未安装运行，待验证 |
| DeepSeek Harness 源码 0.2.2-alpha.3 | Provider/headers/协议确认 | 同类请求模拟通过 | 本机 0.2.1-rc.5，未运行，待验证 |

## 真实验收（未经授权不执行）

先明确测试域名、四个客户端版本、低成本模型、调用次数与费用范围，分别取得部署和真实调用授权。模型权限、SDK 解析、Worker 传输分开记录。不做无意义高频压测；失败先分析，关闭重试。

- [ ] 无 Proxy Token/错误 Token → 403；正确 Token 缺少 Bearer → 401；非法路径/方法 → 404/405；确认无上游访问。
- [ ] 正确 Proxy Token + 无效 OpenAI Key → 保留上游 401；有效 Key → 最短普通响应。
- [ ] Node、Python：Responses 普通、stream、工具调用；结构化输出仅选支持模型；Chat 普通、stream、工具调用；保存状态码/Request ID，不存 Key 或敏感内容。
- [ ] 工具调用再由测试客户端返回无副作用结果，确认多轮 function_call_output/tool message 的闭环；不要让 Harness 执行真实 shell/文件修改。
- [ ] 真实 SSE 事件序列包含完成或错误事件；分清 incomplete、截断与正常结束。记录首字节、总时长、请求次数与输出上限。
- [ ] 单次经过批准的长响应及中途停止；检查客户端停止、连接关闭、上游用量。断开不保证已生成 token 不计费。
- [ ] Cherry：模型列表、连接检查、Chat、Responses 普通/流式、停止、工具功能；记录实际设置入口和 Header 存在情况。
- [ ] Harness：实际安装版识别 profile patch/环境表达式、独立两类凭据、模型发现、两个协议、SSE、工具调用及取消；确认未自动切换官方 DeepSeek/其他真实 Provider。
- [ ] Cloudflare 自定义域名/DNS/证书、WAF 限流、Secrets 轮换/撤销、无缓存、平台日志脱敏。

不要为得到 429/500 而大量调用真实接口；这些故障已由 Mock 覆盖。真实环境自然出现时记录脱敏证据即可。真实服务地区和使用政策遵从由部署与使用方核实。
