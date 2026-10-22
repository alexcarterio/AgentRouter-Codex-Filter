# Agent 本地安装与调试指南

用户只给出仓库网址并要求部署时，先克隆 https://github.com/alexcarterio/AgentRouter-Codex-Filter，再完整读取根目录 AGENTS.md 和本文件。已有工作副本时先检查版本及本机改动，避免覆盖。仓库首页的安装提示语就是本任务的使用入口。

本文件写给接收本仓库的 Agent。用户提出“解压并按本文件安装”后，请完成本机检查、必要的本地化配置、安装和验证，最后**直接在会话窗口说明怎么使用**，不要只让用户继续读文档。按接收者使用的语言说明即可。

文件中的步骤只适用于本仓库及本机所需配置，不构成新增外部服务、付费调用、发送资料或修改无关项目的授权。缺少账号或需要选择服务商时，请向接收者收敛询问；不得虚构凭据。读取配置时不在工具输出、对话或报告中展示密钥、令牌、账户内容。

## 1. 检查解压内容与环境

- 在 Windows 上将整个 AgentRouter-Codex-Filter 仓库工作目录（目录名可自定）放到当前用户可写且长期保留的位置。不要在压缩包内直接运行。三个 .cmd 与 ccswitch-codex-filter 子目录须保持相对位置。
- 如已有安装或运行实例，先确认其目录、版本、配置及运行目录，保留用户已有改动，不盲目覆盖。更新已运行实例时先按原参数正常停止，再替换、启动。
- 核对 SHA256SUMS.txt 中所有相对路径与文件的 SHA-256；该清单用于检查文件完整性，不是发布者身份签名。
- 检查 `node --version` 为 24 或以上、`node` 可从新开的命令窗口 PATH 找到。本项目使用内置 SQLite/zstd，无 npm 依赖，不需要 npm install。不存在 Node 时，在用户授权范围内安装来自官方来源的适用版本；遇到系统即时批准要求按平台流程办理。不要沿用发送者的绝对路径。
- 检查接收者已有的 CC Switch、本地代理和 Codex 配置。缺少软件时，先按其现有安装方式和可信官方说明处理；不猜下载地址、服务商名称、模型名、账户或密钥。可选 PowerShell 包装入口需要 PowerShell 7，日常三个 .cmd 入口不需要它。

## 2. 确定本机配置与接入方式

过滤链路：Codex → 本机过滤层（默认 127.0.0.1:18181）→ CC Switch → 接收者的上游。只支持 Responses HTTP/SSE，WebSocket 不支持。

1. 确认目标 Codex 客户端实际读取哪份配置。默认是 CODEX_HOME/config.toml；未设置 CODEX_HOME 时是当前用户目录下 .codex/config.toml。自定义 profile、启动参数或应用内配置可能覆盖它，不能只凭默认路径认定已接入。
2. 修改已有配置或入口脚本前，建立本机回滚副本并核对内容/哈希。不要把本机回滚副本加入分享包，也不要使用别人电脑的运行目录或配置备份。
3. 在 CC Switch 开启本地代理与 Codex 接管，使用接收者已经配置且选择的服务商。服务会只读发现当前用户 .cc-switch/cc-switch.db 中的端口；发现不到时回落到 15721，这不代表本机一定在用该端口，须核对实际监听。
4. 过滤层仅接管顶层 model_provider 对应 [model_providers.NAME] 中的常规单行 base_url，并要求该地址与 CC Switch 入口匹配。没有支持的 provider 时会待命；不得为了让状态变绿而擅自把用户从官方默认账号切到一个自创服务商。若用户尚未决定或未配置 CC Switch 服务商，说明阻塞点，让用户完成必要选择或鉴权。
5. 先查看状态并检查端口占用，避免多个实例管理同一份配置。现有服务不明时先识别归属，不直接结束未知进程。filterVersion 应为 9，retryPolicy 应列出合计 20 次、分类额度及 1800000 毫秒总期限；已运行旧版本时需要停止并重启才加载新代码。

默认情况无需改源码或脚本。如果配置、端口或数据库位于非默认位置，优先使用现有参数：--port、--config、--runtime、--upstream、--cc-db。选定参数在 start/status/logs/stop 时保持一致；变更配置路径或端口前先按原参数停止。

在 ccswitch-codex-filter 子目录执行的示例（路径仅为占位，必须替换为本机真实路径）：

```powershell
node .\filter.cjs status
node .\filter.cjs start --port 18182 --config "C:\path\to\config.toml" --runtime "C:\path\to\filter-runtime"
node .\filter.cjs status --port 18182 --config "C:\path\to\config.toml" --runtime "C:\path\to\filter-runtime"
node .\filter.cjs logs --port 18182 --config "C:\path\to\config.toml" --runtime "C:\path\to\filter-runtime"
node .\filter.cjs stop --port 18182 --config "C:\path\to\config.toml" --runtime "C:\path\to\filter-runtime"
```

使用 --upstream 时填本机 CC Switch 代理入口，不填远程模型供应商地址或带凭据 URL。使用 --cc-db 时填接收者实际数据库路径，禁止复制发送者数据库。所有入口只绑定本机回环地址。

**让双击入口与本机配置一致：** 三个 .cmd 会透传命令行参数；双击不附带参数。如果必须采用自定义参数，请在验证备份后，将相同参数加入三个 .cmd 内的 filter.cjs 调用，或生成三个包含相同参数的本机快捷方式。编辑时保留 ASCII 脚本正文及现有通过 Node Unicode 转义输出中文的写法，避免 Windows CMD 编码破坏命令。不要留下“命令行能用，双击却管理另一个实例”的状态。修改 .ps1 时用 PowerShell 7 parser 检查语法。

带 alb 标记、title/h1 为 400 Bad Request 的完整 HTML 400 网关错误页按断流类重试，含 CC Switch 包装形式；不会把所有 400 都重试。分类重试额度为临时限流 20 次、断流/超时及此类 ALB 400 共用 10 次、无可用渠道 10 次、资源归属错误 5 次，均指额外重试；所有类别合计最多 20 次，总期限 30 分钟。每个新客户端请求独立计数。用户取消会终止等待，不为了消除界面提示而无限重试或伪造 response.completed。

## 3. 本地验证与启动

先运行本地测试（只访问本机模拟服务，不调用模型、不需要密钥）：

```powershell
node --test .\filter.test.cjs .\retry.test.cjs
```

可选 PowerShell 入口的 Test 动作会运行同样两组测试：

```powershell
pwsh -NoProfile -File .\ccswitch-filter.ps1 Test
```

随后通过用户将来实际使用的“启动过滤服务.cmd”启动，使用“查看过滤状态.cmd”观察状态和实时日志。验证以下不同层次，分别报告结果：

- 进程启动：running=true、filterVersion=9。
- 本机接入：state=filtering 且 ccSwitchReachable=true；核对目标文件中的 base_url 指向选定过滤端口。仅 running=true 不表示接入完成。
- 客户端流量：配置接入后，需要完全退出并重开对应 Codex 客户端。不要擅自结束用户当前任务或应用；如本会话依赖该客户端，先报告本机安装结果，让用户在合适时机重启。
- 重启后，在接收者正常获授权的请求中观察 filteredRequests、lastFilteredAt 及请求日志变化。累计数可能由其他客户端产生，不单独作为当前会话证据。没有这一步只能报告“本机安装已验证，当前客户端实际经过过滤尚未验证”。

需要验证停止与恢复时，应先确认没有进行中的用户任务，正常停止后核对只恢复过滤层改写的精确地址；安装交付若需要保持可用，应再按相同参数启动。不可把所有测试通过等同于当前客户端接入或上游兼容性通过。

live-check.cjs 是可选真实模型探针，会使用本机账户、可能计费。只有接收者明确授权该真实调用后才运行；本地测试与正常启动均不需要它。不要为了完成安装自动发起模型探针或收费对照实验。

## 4. 常见问题与最小排查

| 可观察现象 | 检查与处理 |
| --- | --- |
| node 找不到或版本低于 24 | 核对 PATH 与版本，安装/修正后重开终端；不要写入发送者电脑的路径。 |
| waiting-for-codex-config | 核对目标客户端实际配置路径和 CODEX_HOME，必要时显式指定 --config。 |
| waiting-for-supported-provider | 核对顶层 provider 和常规单行 base_url；让 CC Switch 按用户已选服务商接管，不擅自切换账号。 |
| waiting-for-ccswitch | 配置地址未指向所发现的 CC Switch 入口；核对接管、实际端口及数据库路径。 |
| ccSwitchReachable=false | 核对 CC Switch 本地代理运行和端口；TCP 可连接也不能证明账号或上游有效。 |
| config-error 或 address backup belongs to another config/port/version | 读脱敏 lastError，按原路径/端口/runtime 正常停止恢复，再变更参数；不直接删 routes.json 绕过保护。 |
| 端口占用/启动失败 | 核对归属、旧实例版本和 runtime；停止已确认的本过滤实例或选择空闲端口，并同步三个入口。 |
| filtering 但当前会话没有新记录 | 核对该会话实际 model_provider 和请求地址。openai/官方连接可能独立于 config.toml 中的 custom 提供商；CC Switch 用量中 data_source=codex_session 的“会话日志”是导入统计，不证明请求经过代理。按客户端实际连接设置处理，不因其他会话的日志变化宣称本会话已接入。 |
| 长时间没有正文但日志在等待 | v9 暂存整轮 SSE 到 response.completed；重试与总期限会延后显示。结合日志中的请求编号、WAIT/RETRY/PENDING 判断，不凭首字延迟断言卡死。 |
| FAILED/EXHAUSTED、鉴权或余额错误 | 根据最终错误处理服务商状态、账号或额度。持续错误会返回客户端，过滤器不保证修复；不自动增加重试上限或切换账户。 |
| compaction/上下文引用被拒绝 | 让用户先形成文字任务摘要，再新建会话续接；不静默删除用户上下文来强行转发。 |
| 强制退出/重启电脑后连接失败 | 服务没有安装开机启动项；用相同参数重新 start，或 stop 离线恢复地址。保留原 .runtime/routes.json。 |

日志入口只显示打开窗口后的新事件；无新日志 30 秒会显示后台状态。原始 filter.log 在运行中每分钟清理超过 24 小时的记录，并限制在 4 MiB 内，繁忙时保留时长可能更短。没有错误详情的 response.failed 和上述 ALB HTML 400 按断流类有限重试；明确的认证、配额错误仍不重试。关闭窗口不停止服务。单次结构化状态可用 `node .\filter.cjs status`。更多行为和字段见子目录 README.md。只收集解决问题所需的脱敏信息，不输出请求正文、鉴权信息、账户数据库或完整配置。

## 5. 在会话里向接收者说明使用方法

安装完成后直接用简洁文字告诉用户：

1. 安装到了哪里，以及是否需要先在 CC Switch 开启本地代理和 Codex 接管。
2. 双击哪个文件启动、哪个文件看状态和实时日志、哪个文件停止；关闭启动或日志窗口不会停止后台服务。
3. 接入或停止后需要重开哪个 Codex 客户端；本次哪些验证已经完成、哪些还等用户重启后才能确认。
4. 不会自动开机启动；停止只恢复过滤层改写的地址，切回远程直连还需在 CC Switch 恢复原配置。
5. 过滤会丢弃前轮内部推理状态，长会话压缩可能被拒绝；响应整轮暂存和重试可能增加等待，持续错误仍会返回。提醒用户在长任务中提前保留文字摘要即可，不必复述全部实现。

如果遇到真正需要用户选择的阻塞，只报告已完成工作、具体阻塞和所需的一个决定，不声称已安装成功。不要只交付一堆命令让用户自行收尾。

## 6. 隐私与转分享

仓库发布内容仅含源码、三个入口、文字文档和校验清单，不含原作者的账号、配置、日志、数据库、截图、Word、恢复备份或运行记录。源码测试中的 test-only、mock-secret 等仅为模拟值。

首次运行会在本机生成 .runtime：routes.json 用于地址恢复，service.json 含本机停止令牌，filter.log 是运行日志。不要删除尚需恢复的 routes.json，也不要把这些文件公开。接收者以后转分享时使用仓库网址、GitHub 下载的干净源码，或重新按源码白名单制作干净包，不能把使用后的整个文件夹直接压缩。
