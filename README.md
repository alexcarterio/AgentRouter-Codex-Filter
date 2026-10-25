# AgentRouter-Codex-Filter

让你的 Agent 帮你部署的 Codex 本地过滤器。当前版本：**V10**。

适用于 **Windows + Node.js 24+ + CC Switch + Codex Responses HTTP/SSE**。在 Codex 与 CC Switch 之间过滤部分历史状态，并对可恢复的上游错误进行有限重试，缓解通过 AgentRouter 等上游使用 Codex 时的历史资源归属错误、限流和断流。

无需 `npm install`，不附带模型账号、密钥或个人运行资料。

## V10 更新说明

- 修复 `stream disconnected before completion: stream closed before response.completed` 被包装为 HTTP JSON 错误时未进入断流重试的问题；覆盖 HTTP 400/500、gzip 502 和 SSE 错误场景。
- 与其他断流/超时及指定 ALB 400 错误共用最多 10 次额外重试；所有类别合计最多 20 次，总期限 30 分钟。
- 鉴权、余额和配额耗尽错误仍不重试；重试耗尽后返回最终错误，失败尝试中的正文和客户端工具调用不会下发。
- 验证：48 项本机模拟测试通过，未调用真实模型。升级后先停止再启动服务，确认 `filterVersion=10`；当前客户端是否接入仍须按安装指南核对。

## 直接交给你的 Agent

把本仓库网址发给自己的 Agent，并告诉它：

> 请克隆这个仓库，先完整读取根目录的 AGENTS.md 和 AGENT_SETUP.md，按我电脑的实际环境完成本地化配置、安装和本地调试。使用我已有的 CC Switch 与 Codex 配置，保护账号和密钥。完成后直接在会话窗口告诉我怎么启动、查看状态、停止，以及哪些功能已经验证、哪些还需要我操作。不要自行调用可能计费的真实模型探针。

仓库地址：**https://github.com/alexcarterio/AgentRouter-Codex-Filter**

```powershell
git clone https://github.com/alexcarterio/AgentRouter-Codex-Filter.git
cd AgentRouter-Codex-Filter
```

Agent 入口：[AGENTS.md](AGENTS.md)。安装、本地路径与端口适配、验证、故障排查和交付要求统一见 [AGENT_SETUP.md](AGENT_SETUP.md)。不要只读首页就直接修改用户的连接配置。

已有账号、CC Switch 服务商和客户端连接仍需使用接收者自己的配置；缺少凭据或需要选择服务商时，由 Agent 明确说明需要用户补充的事项。

## 它如何工作

```text
Codex → 本机过滤器（默认 127.0.0.1:18181）→ CC Switch → AgentRouter / 已配置上游
```

- 清理历史 reasoning 项及可移除的普通历史 item ID，保留消息正文、图片、工具配对的 call_id 和本轮推理强度。
- 对明确的资源归属错误、临时限流、断流/超时、带 alb 标记的 HTML 400、无可用渠道，以及没有错误详情的 response.failed 进行有限重试。
- 分类额度与总期限共同限制重试：合计最多额外 20 次，总期限 30 分钟。认证失败、配额耗尽等不会靠无限重试掩盖。
- 整轮 SSE 暂存到 response.completed 后才交付客户端，失败尝试中的客户端工具调用不会下发。
- 修改连接地址前保留恢复资料；停止服务时恢复过滤器改写的 CC Switch 地址。

它是本机转发与兼容处理工具，不提供账号，不代替 CC Switch 的服务商配置，也不能保证持续上游故障一定恢复。

## 安装完成后怎么用

1. 在 CC Switch 打开本地代理和 Codex 接管，使用已配置的 Responses 服务商。
2. 双击 **启动过滤服务.cmd**。
3. 双击 **查看过滤状态.cmd**，确认 `running=true`、`state=filtering`、`ccSwitchReachable=true`。
4. 按 Agent 的本机核验结果重新打开对应 Codex 客户端，用正常请求确认 `filteredRequests`、`lastFilteredAt` 有变化。
5. 双击 **停止过滤服务.cmd** 停止并恢复地址。关闭日志窗口只结束查看，不会停止后台服务。

日志窗口只展示打开后的新记录，30 秒无新事件时显示后台状态。原始日志运行期间每分钟清理超过 24 小时的记录，并限制在 **4 MiB** 内；繁忙时优先保留最新记录，因此保留时间可能更短。不会自动安装开机启动项。

三个入口从本机 PATH 查找 Node.js。非默认端口或路径须让 Agent 同步调整启、停、查看入口，避免管理不同实例。

## 使用前了解这些边界

- 当前只适配 Windows、本机 CC Switch 和 Responses HTTP/SSE；不支持 WebSocket 转发。
- 自动 compaction、已有压缩密文和无法独立转移的上下文引用会明确拒绝。长任务应提前保存文字摘要，再新建会话接续。
- 过滤会丢弃前轮内部推理状态；整轮暂存和重试会延迟可见输出。上游内置搜索等仍可能重复执行并消耗上游额度。
- 客户端可能使用独立的官方连接、profile 或已缓存地址，绕过过滤器。服务正在运行，不代表当前会话已接入；以该会话的实际连接和新请求记录为准。
- CC Switch 用量中的“会话日志”可能是从本机会话文件导入的统计，不能单凭这类记录证明请求经过代理。
- 其他依赖服务器资源的工具记录不保证跨上游可移植。完整规则和错误分类见 [过滤器说明](ccswitch-codex-filter/README.md)。

## 本地验证

```powershell
cd ccswitch-codex-filter
node --test .\filter.test.cjs .\retry.test.cjs
```

测试使用本机模拟服务，不需要模型密钥。`live-check.cjs` 是可选真实模型探针，可能计费，只有用户明确授权后才能运行。本地测试通过不等于接收者的真实上游和客户端已经验证。

仓库的 `SHA256SUMS.txt` 可用于核对已发布文件的内容；它不是发布者身份签名。

## 隐私与再次分享

仓库不包含账号、配置、数据库、日志、恢复备份、运行状态、截图或本机部署记录。源码测试里的 `test-only`、`mock-secret` 等仅为模拟值。

首次运行会在本机生成 `.runtime/`。其中 `routes.json` 用于恢复地址，`service.json` 包含本机停止令牌；这些资料不可公开，也不要在仍需恢复地址时随意删除。转分享请使用仓库网址或 GitHub 源码下载，不要直接打包使用后的整个目录。

## 许可证

本项目采用 [MIT License](LICENSE)。
