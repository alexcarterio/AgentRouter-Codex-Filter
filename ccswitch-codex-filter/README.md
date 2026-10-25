# CC Switch / Codex 历史推理与 ID 过滤脚本

用于 Windows + Node.js 24+。无额外依赖，不需要 npm install。

转发路径：Codex → 本机过滤层（默认 18181）→ CC Switch（自动发现监听端口）→ 上游。

## 使用

在 PowerShell 中运行：

~~~powershell
Set-Location ".\ccswitch-codex-filter"
node .\filter.cjs start
node .\filter.cjs status
~~~

先在 CC Switch 中打开「本地代理」和 Codex 接管。脚本也可以先启动待命。
看到 status 的 state 为 filtering、ccSwitchReachable 为 true 后，重新启动 Codex 终端，或完全退出并重开使用该配置的 Codex 应用。
running 为 true 仅表示后台服务运行，不代表当前窗口已接入。waiting-for-supported-provider / waiting-for-ccswitch 表示待命；正常使用官方默认配置时，不会强行切换到 CC Switch。
已经运行的客户端可能缓存旧地址，修改文件不会给当前连接自动加上过滤。
恢复旧会话时，应检查 filteredRequests、lastFilteredAt 是否随新请求变化，
并检查 removedReasoningItems、removedItemIds 的增量；总数可能包含连通性测试，不能单凭总数判断当前窗口已接入。

更新脚本后，需要先 stop 再 start，重新加载代码。当前暂存响应自动重试版 status 应显示 filterVersion: 10。双击桌面目录的“查看过滤状态.cmd”可持续查看带中文说明、按请求编号关联的实时日志；关闭这个日志窗口不会停止过滤服务。

关闭过滤层：

~~~powershell
node .\filter.cjs stop
~~~

停止会恢复脚本修改的 CC Switch 地址，再关闭监听；随后同样需要重启 Codex 客户端。
重复 start/stop 是安全的。start 为隐藏后台进程，关掉启动它的终端仍会运行；
serve 在前台运行，可用 Ctrl+C 停止并恢复。未安装开机启动任务。

也可以使用 PowerShell 包装脚本：

~~~powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\ccswitch-filter.ps1 Start
pwsh -NoProfile -ExecutionPolicy Bypass -File .\ccswitch-filter.ps1 Status
pwsh -NoProfile -ExecutionPolicy Bypass -File .\ccswitch-filter.ps1 Logs
pwsh -NoProfile -ExecutionPolicy Bypass -File .\ccswitch-filter.ps1 Stop
pwsh -NoProfile -ExecutionPolicy Bypass -File .\ccswitch-filter.ps1 Test
~~~

桌面目录的三个 .cmd 入口分别用于启动、停止、持续查看中文日志；查看状态不会停在一次性统计。三个入口可透传现有命令行选项，例如 --port、--config、--runtime；使用自定义参数时，启停和查看须保持一致。PowerShell 的 Status 返回一次性 JSON，Logs 持续输出日志，Test 同时运行过滤和重试两组本地测试。启动、停止不需要为 v10 更换命令；更新代码后先停止再启动，才能重新加载后台代码。

## 实际过滤内容

- 删除每次 POST /responses 或 /v1/responses 的 input 中整个 type: reasoning 项。
- 从 include 中删除 reasoning.encrypted_content，并设置 store: false。
- 清理 input 中普通消息、function_call / function_call_output、custom_tool_call / custom_tool_call_output 的顶层 id。
  这些历史 ID 可能属于另一上游资源，曾引发 “The requested item was created under a different ... resource”。
  仅移除可重新提交完整内容的记录 ID，保留工具配对所需的 call_id、消息 phase、工具参数与结果、嵌套文件/资源引用。
- 保留当前请求的 reasoning.effort、普通消息、图片、工具调用、工具结果和 call_id。
- 支持 JSON、gzip、deflate、br、zstd 请求；重新计算 Content-Length。
- v10 沿用整轮 SSE 暂存，收到 response.completed 才交给客户端；失败尝试中的正文、推理及工具调用不会交给客户端。成功内容会更晚显示。保留成功响应的推理，下次请求继续过滤历史密文。
- 自动重试明确的 Azure 历史 item 资源归属错误（HTTP 400）、临时 token/request 限流（HTTP 400/429，包含 rate_limit_exceeded 或 exceeded token rate limit）、断流/超时（含 HTTP JSON 错误和 SSE 错误中的 stream disconnected before completion: stream closed before response.completed），以及“无可用渠道”（HTTP 503，包含 no_available_channel 或对应中英文消息）。带 alb 标记、title/h1 均为 400 Bad Request 的完整 HTML 网关错误页（HTTP 400，含 CC Switch 包装形式）按断流类重试，日志标记 alb_bad_request；与断流/超时共用 10 次额度。普通参数错误和其他 HTML 400 不重试。预算、余额、配额耗尽不重试。
  按错误分类限制额外重试：临时限流最多 20 次，断流/超时及无可用渠道各最多 10 次，Azure 资源归属错误最多 5 次；四类合计最多 20 次，即每条客户端请求最多转发 21 次。Azure 资源错误依次等 1、2、4、8、15 秒；限流依次等 10、20、40、60、60 秒并增加不足 1 秒随机延迟；无可用渠道依次等 5、10、20、30、60 秒。超过第 5 次后沿用最后一级间隔；各类独立计算退避阶梯，切换错误类型不重置合计额度。
  Retry-After、retry-after-ms、x-ms-retry-after-ms 是等待下限；不会为了缩短等待提前重试。CC Switch 自己的故障转移仍然生效，本层只重试其最终返回的目标错误。
  每次重发同一个过滤后的请求，不添加“继续”、不修改会话历史或搜索记录。重试恢复时客户端只收到成功尝试的完整响应。客户端工具不会执行被丢弃的失败尝试；上游内置搜索等仍可能再次运行并消耗上游配额。
  HTTP 200/SSE 的 error 或 response.failed 事件也可拦截，包括已经在过滤层暂存正文、推理、工具事件的情况。由于这些内容尚未交给客户端，失败时丢弃暂存响应后重试。没有提供错误详情的 response.failed 按断流类最多额外重试 10 次，与原有断流重试共用额度；仍受合计 20 次及 30 分钟限制。明确的认证、配额及其他非目标业务错误，以及 response.incomplete 不自动重放。
  流式等待每 15 秒发空 response.in_progress 保活，客户端不会显示中间错误；输出完成前流关闭、网络断开或上游连续 120 秒无数据时，按 1、2、4、8、15 秒间隔重试。耗尽后返回最终 error 事件，客户端仍可能启动自身的重试。本层总期限为 1800 秒（30 分钟），包含 CC Switch 等待和重试；期限不足以满足上游等待下限时不再重试。取消立即停止等待和后续请求。
  其他 HTTP 400、402、503 等业务错误不重放；认证失败直接返回。暂存响应限制为 64 MiB；超过限制返回 response_too_large，不静默放行失败内容。该机制缓解可恢复失败，无法保证持续失败也对客户端无感。
- 不修改 CC Switch 数据库、API Key、Codex 历史文件。日志只记录时间、状态、数量和错误码，不记录请求正文或鉴权头。

这会丢弃模型前轮的内部推理状态，可能影响复杂任务的连续表现；保留本轮推理强度并不能恢复这部分状态。
它针对历史推理密文导致的解密失败，不保证解决所有上游报错。

## 长会话与接管边界

- 已有 compaction、item_reference、previous_response_id、conversation 引用或其他加密上下文时，会明确拒绝转发，避免静默丢失上下文。
- /responses/compact 以及请求中启用的自动 compaction 会被拒绝。Codex 长会话自动压缩可能因此停止；应提前请模型给出任务摘要，再新建会话接续。
- 仅支持 Responses HTTP/SSE。WebSocket 握手会返回 426；若手动启用了 WebSocket，应关闭该传输配置后使用。
- 仅编辑顶层 model_provider 指向的 [model_providers.NAME] 下的常规单行 base_url。自定义 --profile、命令行 --config 覆盖、应用内其他配置来源可能绕过它；以状态统计是否增长为准。
- CC Switch 关闭接管或切换到外部直连地址时，过滤层进入 waiting-for-ccswitch，不会强行覆盖该地址。
  再开启本地代理和 Codex 接管，等待 filtering 后重启 Codex；已缓存直连地址的窗口不会自动改道。
- 当前 ID 清理覆盖 Codex 常见的普通消息及函数/自定义工具记录。其他依赖服务器资源的工具记录保留其 ID，不保证跨上游可移植。
- 每秒读取配置检查 CC Switch 重写。检测到重新接管后会再次接入；若在这一秒内启动客户端，仍可能缓存直连 CC Switch 的地址，需在 filtering 后重启客户端。
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

自定义 runtime 时，status/stop 也要指定同一个 --runtime。变更端口或配置路径前先 stop。
状态返回 retryPolicy，列明当前已加载的分类额度、合计上限和总期限；只看磁盘文件版本不足以证明运行进程已更新。
状态：
- filtering：已将文件中的地址接入过滤层；客户端是否真正经过它，看 filteredRequests 是否增长。
- waiting-for-ccswitch：后台待命，尚未检测到配置中的 CC Switch 地址。
- waiting-for-supported-provider：没有找到支持的 provider/base_url 配置。
- config-error：接入失败，lastError 给出原因。
- stopped：过滤层未运行。

stats.removedItemIds 是清理的历史记录 ID 数量；stats.lastFilteredAt 是最后处理 Responses 请求的时间。
stats.lastUpstreamStatus / upstreamHttpErrors 记录上游 HTTP 状态及 4xx/5xx 次数；HTTP 200 不等于完整成功，以 request-finished 的 SUCCESS 和 response.completed 为准。
stats.resourceRetries / rateLimitRetries 是两类错误各自执行的额外重试数；resourceRetryAccepted / rateLimitRetryAccepted / transportRetryAccepted 是重试后接受成功响应的请求数（SSE 必须收到 response.completed）；resourceRetryExhausted / rateLimitRetryExhausted 是次数或期限耗尽数。streamRetryErrors 是丢弃暂存响应并重试的流内错误数；transportRetries 统计断流、超时和上述 ALB HTML 400 的重试。activeRequests 是当前转发或等待中的请求数。

实时日志：START/FILTER 表示请求开始；FAIL 显示 different_azure、rate_limit、stream_incomplete、alb_bad_request、upstream_failed_without_details、no_available_channel 或其他错误，并说明是否命中可重试分类；WAIT/RETRY 显示第几次及等待秒数；PENDING 每 15 秒显示剩余总时间；SUCCESS/FAILED/CANCELED 表示最终结果；EXHAUSTED 表示次数或总时间耗尽。同一请求使用相同编号，重启服务后编号重新开始。各行保留英文标识并附中文说明。stats.availabilityRetries / availabilityRetryAccepted / availabilityRetryExhausted 分别统计无可用渠道的重试、恢复成功、次数或期限耗尽。

运行文件位于 .runtime/：filter.log 是日志，routes.json 是仅用于地址恢复的备份，service.json 是进程控制信息（包含本地停止令牌，请勿公开）。
filter.log 是结构化原始记录，终端会将其中事件翻译为中文说明。运行期间每分钟清理超过 24 小时的记录；单文件最多 4 MiB，写入达到上限时立即保留最新完整记录，因此繁忙时可能不足 24 小时。日志不生成无限历史归档。
查看窗口只显示打开后的新记录；日志清理或替换后继续跟随，不重复展示旧记录。连续 30 秒没有新日志时显示后台状态，提示这里只观察经过本过滤服务的请求。


## 验证


~~~powershell
node --test .\filter.test.cjs .\retry.test.cjs
~~~

测试使用工作区临时配置和本机模拟服务，不调用收费模型，覆盖密文与历史 ID 过滤、工具配对、文件引用、压缩请求、SSE、取消、错误透传、地址恢复、重复启停。

可选真实连通性检查（会向 CC Switch 当前上游发送一条极短模型请求）：

~~~powershell
node .\live-check.cjs
~~~

它调用本机已安装的 Codex CLI，创建临时会话，在本地请求中注入故意无效的历史 reasoning 密文，
以及 5 个带有模拟历史 ID 的消息和工具记录，再经运行中的过滤层检查返回 FILTER_OK。
同时检查密文和 ID 的清理计数，避免仅凭一次成功回复漏掉过滤缺陷。测试使用 low 推理强度，不修改你的正常推理设置。
不会输出密钥或改动已有会话。此检查不主动切换账号，不能代替每个上游的兼容性验证。部分上游限制客户端类型，因此使用真实 Codex CLI；普通 HTTP 探针可能收到 401。

找不到 CLI 时可加 --codex "C:\path\to\codex.exe"。--baseline 可直接经 CC Switch 做对照，不注入密文、不经过过滤层。

接口背景参考：[OpenAI reasoning guide](https://developers.openai.com/api/docs/guides/reasoning)。
