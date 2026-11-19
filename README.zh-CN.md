# omp-peers

[English](README.md) | 简体中文

- **Peer 端点（每个 omp 进程一个）**
  - 主会话注册 — 功能：把每个主会话（不含子代理）登记到本进程的端点；会话 id、标题、cwd 和空闲状态实时读取，`/new` 和恢复会话无需重新登记。时机：主会话的 `session_start`。实例：`index.ts` 中的 `node.add(localMain(pi, ctx), warn)`。
  - IPC 端点 — 功能：同一 OS 用户的每个进程开一个端点，该用户所有 profile 共用；它是唯一的存活信号（没有心跳、注册表或缓存）。时机：第一个主会话登记时打开。实例：macOS/Linux 上 `/tmp/omp-<uid>/peers/<pid>.sock`（父目录须属于该用户、权限 `0700`），Windows 上 `\\.\pipe\omp-<pid>-<hash>`。
  - 线协议 — 功能：每条连接承载一行 JSON 请求（`list`、`ask`、`irc`）和一行 JSON 响应；失败用固定代码。时机：每次 peer 工具调用。实例：错误码 `bad_request`、`unsupported_version`、`target_not_found`、`ask_busy`、`ask_unsupported`、`ask_failed`、`delivery_failed`。
  - 注销与关闭 — 功能：移除主会话，最后一个主会话离开时关闭端点；`kill -9` 和 RPC 模式下的信号会跳过它，留下一个拒绝连接的 socket 文件。时机：`session_shutdown`。实例：`/quit`、两次 Ctrl+C 或 `kill -TERM` 会关闭端点。
- **发现（`peer_list`）**
  - `peer_list` 工具 — 功能：列出运行 omp-peers 的存活 omp 进程及其主会话（id、标题、cwd、idle 或 busy）。时机：主会话或子代理调用时（顶层工具，`loadMode: "essential"`，审批 `read`）。实例：`2 omp process(es) reachable through omp-peers, 3 main session(s):`，随后是 `  - <sessionId> "<title>" — <cwd> — idle`。
  - 未装 omp-peers 的候选 — 功能：报告项目在线记录里 pid 仍在运行的 omp 进程，作为不能提问也不能发消息的候选。时机：每次 `peer_list` 结果。实例：从 `~/.omp/run/daemons/<scope>/clients/` 读出 `Other omp processes without omp-peers (candidates; cannot be asked or messaged): pid 4182.`
  - `xd://peer_list/liveness` — 功能：说明谁算存活、`alive, session list unavailable`（2 秒内未列出会话）、idle/busy，以及会话 id 在 `/new` 和恢复时会变。时机：模型在依赖存活状态前读取时。实例：``A session id changes on `/new` and on resume. List again …``。
- **旁路提问（`peer_ask`）**
  - `peer_ask` 工具 — 功能：向另一个主会话提一个 /btw 式旁路问题，答案经本次调用返回。时机：主会话或子代理调用时（审批 `read`）；最多等 5 分钟，取消会中止目标的旁路轮次。实例：`peer_ask({ to: "01a1f4a1", question: "Which branch are you on?" })` → `Answer from session <id> (pid <pid>):`。
  - 目标端旁路轮次 — 功能：目标经宿主 `runEphemeralTurn` 用自己的模型、system prompt 和对话作答，不往对话里加任何内容，也不运行工具；每个目标同时只答一个问题；超过 32 KiB 的答案被截断。时机：`ask` 请求到达目标端点时。实例：提示 `Side question from another omp main agent (session …, pid …, cwd …):`，忙时回复 `ask_busy`，截断标记 `[answer cut at 32 KiB]`。
  - `xd://peer_ask/side-turns` — 功能：说明旁路轮次的开销、一次一个的限制、32 KiB 截断和错误码。时机：模型提问前或提问失败后读取时。实例：`` `target_not_found`: the session id changed (`/new`, resume) or its omp exited; run `peer_list`. ``
- **消息（`peer_send`）**
  - `peer_send` 工具 — 功能：把一条消息（最多 64 KiB）送进另一个主会话的对话，注入后即返回，没有已读回执和离线投递。时机：主会话或子代理调用时（审批 `write`）。实例：`peer_send({ to: "01a1", message: "PR #12 is merged" })` → ``Delivered to session <id> (pid <pid>). … A reply arrives as an incoming peer message and wakes you; do not `wait` for it.``
  - `irc:incoming` 注入 — 功能：以 `irc:incoming` 自定义消息、aside 方式注入：空闲的目标开始一轮，忙碌的目标在下一步读到，不打断正在运行的工具。时机：`irc` 请求到达目标时。实例：`Incoming peer message from another omp main agent (session …): … call peer_send with to "<sessionId>"; the sender's reply wakes you when it arrives.`
  - 子代理单向发送 — 功能：把子代理发来的问题和消息标为单向，接收方只经旁路轮次作答，不用 `peer_send` 回复。时机：发送方是子代理时。实例：`This is a one-way message from a subagent: do not use peer_send to reply.`
  - `xd://peer_send/replies` — 功能：说明投递、回复、64 KiB 上限和避免互相唤醒的循环。时机：模型发送或回复前读取时。实例：`Do not answer a reply that needs no answer, so two sessions do not wake each other in a loop.`
- **界面语言**
  - 工具标签 — 功能：工具标签显示为英文或中文；说明、topic 和结果保持英文。时机：为会话注册工具时。实例：`peer_list` 的标签 `Peers` / `Peer 列表`，依次按 `OMOMP_LANG`、`LC_ALL`/`LC_MESSAGES`/`LANG` 决定。
