# CC Switch / Codex 历史推理与 ID 过滤脚本（v11）

用于 Windows + Node.js 24+。无额外依赖，不需要 npm install。

转发路径：Codex → 本机过滤层（默认 18181）→ CC Switch（自动发现监听端口）→ 上游。

v11 相比 v10 的三点核心变化（v10 行为见文末"回退到 v10 模式"）：

1. **流式转发**：SSE 在上游首个 delta 到达时开始转发，不再等待完整响应。首个内容之前收到的可分类错误仍可隐形重试；内容交付后的错误与断流不再自动重放，交由客户端处理，已交付的输出无法撤回。
2. **懒历史（lazy history）**：默认保留请求中的历史 reasoning（思维链）、密文与 ID，并保留 `include: reasoning.encrypted_content`，仍强制 `store:false`。未变更的请求按原始字节转发，跳过重新序列化。只有当上游报出跨资源归属错误（different Azure resource）时，才把该请求降级为 v10 的"移除 reasoning + 历史 ID"请求体重试。保留历史的实际质量、延迟和用量收益取决于客户端与上游，本次未作真实模型对照测量。
3. **网页观测台**：内置实时仪表盘（`node filter.cjs ui`），每秒推送聚合数据：请求速率、首包/总耗时延迟、token 流量、错误分类、按类别的重试恢复占比、最近请求列表。当日聚合快照写入 `.runtime/metrics.json`，重启后恢复；明细与分钟曲线不持久化。

## 使用

在 PowerShell 中运行：

~~~powershell
Set-Location ".\ccswitch-codex-filter"
node .\filter.cjs start
node .\filter.cjs status
node .\filter.cjs ui     # 打开网页观测台（浏览器自动打开，地址含本机访问令牌）
~~~

先在 CC Switch 中打开「本地代理」和 Codex 接管。脚本也可以先启动待命。
看到 status 的 state 为 filtering、ccSwitchReachable 为 true 后，重新启动 Codex 终端，或完全退出并重开使用该配置的 Codex 应用。
running 为 true 仅表示后台服务运行，不代表当前窗口已接入。waiting-for-supported-provider / waiting-for-ccswitch 表示待命；正常使用官方默认配置时，不会强行切换到 CC Switch。

更新脚本后，需要先 stop 再 start，重新加载代码。status 应显示 filterVersion: 11。
桌面目录的三个 .cmd 入口（启动/停止/查看状态）不变，另新增"打开观测台.cmd"双击直达网页仪表盘。

关闭过滤层：

~~~powershell
node .\filter.cjs stop
~~~

停止会恢复脚本修改的 CC Switch 地址，再关闭监听；随后同样需要重启 Codex 客户端。
重复 start/stop 是安全的。start 为隐藏后台进程；serve 在前台运行，可用 Ctrl+C 停止并恢复。未安装开机启动任务。

## 网页观测台

- 打开方式：`node filter.cjs ui`（自动打开默认浏览器），或双击上级目录"打开观测台.cmd"。地址形如 `http://127.0.0.1:18181/__codex_filter__/ui#<令牌>`，仅限本机访问；令牌用于数据接口鉴权，请勿外传该链接。
- 数据经 SSE 每秒推送，页面无需刷新。断线自动重连；更换令牌后带 `#新令牌` 的地址优先于本地缓存。
- 内容：总览 KPI（总请求/成功/失败/取消/重试执行/**重试后获成功响应**/今日平均首包延迟/累计 tokens/思维链保留与移除/降级请求数）、每分钟请求速率与重试折线、每分钟首字与总耗时均值、每分钟 token 流量、错误分类与错误码排行、**按类别的重试效果表（调度/执行/恢复/耗尽/恢复占比/计划等待）**、首字与总耗时分布直方图、最近 200 条请求明细（耗时/首字/重试/错误/tokens）。正在处理的请求（等待上游/退避重试/流式输出中）单独展示。
- 聚合数据不包含任何请求正文或密钥；token 用量来自响应中的 usage 字段。当日累计跨重启保留（metrics.json），按本机自然日重置。开始量归开始当天，完成量、用量与重试归各事件发生当天，跨午夜时完成量可大于当天开始量；活跃请求继续保留。分钟级曲线（最多 180 个有事件的分钟）与最近 200 条明细仅留内存。
- token 统计口径：`response.completed` 中的 `usage.input_tokens / output_tokens`，缓存命中单列（cached_tokens）。

## 实际过滤内容

- **默认（懒历史）**：保留 input 中全部历史 reasoning 项（含 id 与 encrypted_content）、`include: reasoning.encrypted_content` 与各历史项 id；仍强制 `store: false`。请求内容无变化时按原始字节直传。
- **降级**：同一请求内，第一次遇到"不同 Azure 资源"归属错误（HTTP 400 或流内 response.failed）时，自动改用移除全部历史 reasoning、移除可移除历史 ID、剔除 include 密文项的保守请求体重试（即 v10 行为），后续重试沿用降级后的请求体。
- 仍然明确拒绝（不转发、不静默丢弃）：`previous_response_id`、`conversation`、`item_reference`、compaction 及其他携带 encrypted_content 的非 reasoning 项。`/responses/compact` 一律 409。
- 支持 JSON、gzip、deflate、br、zstd 请求；重新计算 Content-Length。
- 上游返回的 SSE 与 HTTP 响应原样转发；仅流内错误事件在首个内容事件之前会被拦截并用于重试决策。

## 自动重试

可重试分类（均指对同一请求的额外重试，不修改会话历史）：

| 分类 | 触发条件 | 额度 | 退避阶梯 |
| --- | --- | --- | --- |
| 临时限流 | HTTP 400/429 + rate_limit_exceeded / exceeded token rate limit | 20 次 | 10/20/40/60/60 秒 + 随机抖动 |
| 断流/超时/网关 | 流中断、空闲超时、stream disconnected 措辞、response.failed 无详情、**cc_switch_forward_failed**、**通用 JSON 5xx 网关错误（cc_switch_upstream_error 等）**、**流内 bad_response / server_error**、ALB HTML 400 | 10 次 | 1/2/4/8/15 秒 |
| 无可用渠道 | HTTP 503 + no_available_channel / 无可用渠道 | 10 次 | 5/10/20/30/60 秒 |
| 资源归属 | HTTP 400 + "created under a different Azure OpenAI resource"（触发懒历史降级） | 5 次 | 1/2/4/8/15 秒 |

- 四类合计最多 20 次（即每条客户端请求最多转发 21 次），总期限 30 分钟；各类退避独立计数，超过第 5 次沿用最后一级间隔。
- 通用 JSON 5xx 在首次输出前按网关错误有限重试；HTTP 401/403，以及 code 或 type 表示认证、余额或配额错误时不重试。新增分类已用本机模拟服务验证，未测量真实上游的恢复率或性能增益。
- Retry-After / retry-after-ms / x-ms-retry-after-ms 是等待下限，不会提前重试。CC Switch 自己的故障转移仍然生效。
- 流内错误重试窗口：首个内容事件（delta）到达之前。此后错误原样交付客户端，是否重试由客户端决定；过滤器不再自动重放该轮。
- 内容开始后的流中断同样直接交付；重试只保护"尚未向客户端交付任何输出"的阶段。首次转发前暂存的响应超过 64 MiB 返回 response_too_large；开始转发后不再整轮暂存。

## 观测与统计

- stats 新增 `reasoningKept`（懒模式下保留的历史 reasoning 项数）；`removedReasoningItems` / `removedItemIds` 现在主要在降级时增长。
- 日志事件新增 `history-degraded`（DEGRADE，触发降级及移除数量）。日志写入改为内存缓冲异步落盘，日志批次异步追加，正常停止时等待最终批次写入；轮转与 24 小时/4 MiB 清理策略不变。metrics 聚合快照仍每分钟同步写入。
- 请求级观测（首字延迟、每请求 tokens、错误明细、活跃请求阶段）见网页观测台；`filter.cjs logs` 仍提供终端实时日志。

## 回退到 v10 模式

如需恢复"整轮暂存 + 每次移除历史"的旧行为，编辑 `proxy.cjs` 中 `makeProxy` 的两个默认值：`historyMode = 'strip'`、`bufferMode = 'full'`（或调用 makeProxy 时传入对应选项）。`filterResponsesRequest(body, 'strip')` 与 v10 过滤完全一致，已有测试覆盖。

## 长会话与接管边界

- 已有 compaction、item_reference、previous_response_id、conversation 引用或其他加密上下文时，会明确拒绝转发，避免静默丢失上下文。
- /responses/compact 以及请求中启用的自动 compaction 会被拒绝。Codex 长会话自动压缩可能因此停止；应提前请模型给出任务摘要，再新建会话接续。
- 仅支持 Responses HTTP/SSE。WebSocket 握手返回 426。
- 仅编辑顶层 model_provider 指向的 [model_providers.NAME] 下的常规单行 base_url。自定义 --profile、命令行 --config 覆盖、应用内其他配置来源可能绕过它；以状态统计是否增长为准。
- CC Switch 关闭接管或切换到外部直连地址时，过滤层进入 waiting-for-ccswitch，不会强行覆盖该地址。
- 当前 ID 清理（降级后）覆盖 Codex 常见的普通消息及函数/自定义工具记录。其他依赖服务器资源的工具记录保留其 ID。
- 每秒读取配置检查 CC Switch 重写。若在这一秒内启动客户端，仍可能缓存直连 CC Switch 的地址，需在 filtering 后重启客户端。
- 停止时只恢复脚本写入的精确地址，不覆盖其他设置或 CC Switch 后来切换到的外部地址。
- 强制结束进程/重启电脑后，先重新 start 恢复监听，或 stop 离线恢复地址。不要先删除 .runtime/routes.json。

## 配置与状态

默认读取当前用户 .cc-switch/cc-switch.db 中 Codex 的监听端口，只读访问。
默认 Codex 配置为 CODEX_HOME/config.toml（设置了 CODEX_HOME 时），否则为用户目录 .codex/config.toml。

可覆盖路径和端口：

~~~powershell
node .\filter.cjs start --port 18181 --upstream http://127.0.0.1:15721
node .\filter.cjs start --config "C:\path\to\config.toml" --runtime "C:\path\to\filter-runtime"
~~~

自定义 runtime 时，status/stop/ui 也要指定同一个 --runtime。变更端口或配置路径前先 stop。
状态返回 retryPolicy，列明当前已加载的分类额度、合计上限和总期限；只看磁盘文件版本不足以证明运行进程已更新。
状态：
- filtering：已将文件中的地址接入过滤层；客户端是否真正经过它，看 filteredRequests 是否增长。
- waiting-for-ccswitch：后台待命，尚未检测到配置中的 CC Switch 地址。
- waiting-for-supported-provider：没有找到支持的 provider/base_url 配置。
- config-error：接入失败，lastError 给出原因。
- stopped：过滤层未运行。

stats 字段：removedItemIds 是降级时清理的历史记录 ID 数量；reasoningKept 是保留的历史 reasoning 项数量；lastFilteredAt 是最后处理 Responses 请求的时间；lastUpstreamStatus / upstreamHttpErrors 记录上游 HTTP 状态；各类 Retries / RetryAccepted / RetryExhausted 统计重试执行、恢复、耗尽；streamRetryErrors 是丢弃流内错误并重试的次数；activeRequests 是当前正在处理的请求数。

运行文件位于 .runtime/：filter.log 是日志，routes.json 是仅用于地址恢复的备份，service.json 是进程控制信息（包含本地停止令牌，请勿公开），metrics.json 是当日聚合快照（每分钟与停止时写入）。

## 验证

~~~powershell
node --test .\filter.test.cjs .\retry.test.cjs .\dashboard.test.cjs
~~~

测试使用工作区临时配置和本机模拟服务，不调用收费模型，覆盖：密文与历史 ID 过滤（strip 与 lazy 两种模式）、懒降级重试、原文直传、流式首包、SSE 错误拦截与重试窗口、取消、错误透传、地址恢复、重复启停、聚合统计、观测台页面与令牌鉴权、当日聚合持久化。

可选真实连通性检查（会向 CC Switch 当前上游发送一条极短模型请求）：

~~~powershell
node .\live-check.cjs
~~~

它调用本机已安装的 Codex CLI，创建临时会话，在本地请求中注入故意无效的历史 reasoning 密文以及 5 个带模拟历史 ID 的消息和工具记录。v11 懒模式下这些内容会原样发往上游：只要最终收到 FILTER_OK 即通过——无论是上游接受了注入内容（kept 计数），还是触发了跨资源错误并走降级重试（removed 计数）。这只验证本次连通性，不证明所有错误路径或完整历史连续性。结果 JSON 会标明两种路径的计数。测试使用 low 推理强度，不修改正常设置，不输出密钥或改动已有会话。部分上游限制客户端类型，因此使用真实 Codex CLI。

找不到 CLI 时可加 --codex "C:\path\to\codex.exe"。--baseline 可直接经 CC Switch 做对照，不注入密文、不经过过滤层。

接口背景参考：[OpenAI reasoning guide](https://developers.openai.com/api/docs/guides/reasoning)。
