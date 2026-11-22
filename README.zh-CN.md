# omp-peers

[English](README.md) | 简体中文

- **Peer 端点（每个 omp 进程一个）**
  - 主会话注册 — 功能：把每个主会话（不含子代理）登记到本进程的端点；会话 id、标题、cwd 和空闲状态实时读取，`/new` 和恢复会话无需重新登记。时机：主会话的 `session_start`。实例：`index.ts` 中的 `node.add(localMain(pi, ctx, ...), warn)`。
  - IPC 端点 — 功能：同一 OS 用户的每个进程开一个端点，该用户所有 profile 共用；它是唯一的存活信号（没有心跳、注册表或缓存）。时机：第一个主会话登记时打开。实例：macOS/Linux 上 `/tmp/omp-<uid>/peers/<pid>.sock`（父目录须属于该用户、权限 `0700`），Windows 上 `\\.\pipe\omp-<pid>-<hash>`。
  - 线协议 — 功能：每条连接承载一行 JSON 请求（`list`、`ask`、`irc`）和一行 JSON 响应；失败用固定错误码。时机：每次读写 `peer://`。实例：错误码 `bad_request`、`unsupported_version`、`target_not_found`、`ask_busy`、`ask_unsupported`、`ask_failed`、`delivery_failed`、`budget_exceeded`。
  - 注销与关闭 — 功能：移除主会话，最后一个主会话离开时关闭端点；`kill -9` 和 RPC 模式下的信号会跳过它，留下一个拒绝连接的 socket 文件。时机：`session_shutdown`。实例：`/quit`、两次 Ctrl+C 或 `kill -TERM` 会关闭端点。
- **`peer://` 内部 URL 协议**
  - 注册与设置 — 功能：当插件设置 `enabled` 为 true（进程启动时读取一次）时，向 `InternalUrlRouter` 注册 `peer://` 处理器。时机：扩展初始化阶段（`index.ts`）。实例：`peer://<pid>` 指向该进程唯一的主会话（跟随 `/new` 和恢复）；当同一进程托管多个主会话时使用 `peer://<pid>/<sessionId>`。
  - 发现（`read peer://`） — 功能：探测运行 `omp-peers` 的存活 omp 进程并列出其主会话（地址、标题、cwd、idle/busy，以及 `(you)` / `(this omp process)` 标记）。时机：主会话或子代理读取 `peer://` 时。实例：`- peer://<address> "<title>" — <cwd> — idle`。
  - 旁路提问（`write peer://<address>?ask`） — 功能：向另一个主会话提一个 `/btw` 式旁路问题，并以写入结果直接返回答案；最多等 5 分钟，取消会中止目标的旁路轮次，同一目标同时只处理一个问题（`ask_busy`），超过 32 KiB 的回答会被截断并附 `[answer cut at 32 KiB]`，`target_not_found` 会列出在线 peer。时机：主会话或子代理调用 `write` 写入带 `?ask` 的地址时（tier `read`，scope `coordination`）。实例：`write(path: "peer://12345?ask", content: "Which branch are you on?")` → `Answer from peer://12345:`。
  - 目标端旁路轮次 — 功能：目标经宿主 `runEphemeralTurn` 用自己的模型、system prompt、对话及正在生成的工具调用预览作答，不往对话里加任何内容，也不运行工具。时机：`ask` 请求到达目标端点时。实例：提示 `Side question from another omp main session (peer://…, cwd …):`，purpose 为 `omp-peers-ask`。
  - 消息（`write peer://<address>`） — 功能：把一条消息（最多 64 KiB UTF-8）送进另一个主会话的对话，注入后即返回，没有已读回执和离线投递；同一来源进程每 10 分钟最多唤醒目标 20 次（`budget_exceeded`）。时机：主会话或子代理调用 `write` 写入 `peer://<address>` 时（tier `read`，scope `coordination`）。实例：`write(path: "peer://12345", content: "PR #12 is merged")` → ``Delivered to peer://12345. It was idle and starts a turn on it now. A reply arrives as an incoming peer message and wakes you; do not `wait` for it.``。
  - `irc:incoming` 注入 — 功能：以 `irc:incoming` 自定义消息、aside 方式注入：空闲的目标开始一轮，忙碌的目标在下一步读到，不打断正在运行的工具。时机：`irc` 请求到达目标时。实例：`<irc>` 包裹文本，指引接收方通过 `write`（`path: "peer://<address>"`, `content: "…"`）回复。
  - 子代理单向发送 — 功能：由于子代理没有 `peer://` 地址，来自子代理的问题和消息会被标记为单向；接收方只能经旁路轮次作答，不能回发消息。时机：发送方 `taskDepth > 0` 时。实例：`It is one-way: a subagent has no peer:// address, so nothing you write reaches it.`。
