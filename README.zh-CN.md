# omp-peers

[English](README.md) | 简体中文

让同一 OS 用户下各个 omp 进程的主会话互相发现，互相发起 /btw 式旁路询问，并互发 IRC 消息。omp 自带的 Agent Hub（`agent://`、`wait`）只能触达同一个 omp 进程内的 agent；omp-peers 把各个进程连起来。

## 安装

```sh
omp install https://github.com/oh-my-omp/omp-peers
```

入口是包根 `index.ts`，由 `package.json` 的 `omp.extensions` 声明。插件没有配置项。

## 工具

主会话可以使用三个工具。子代理不算 peer，调用这些工具会被拒绝。

| 工具 | 对目标会话的影响 |
|---|---|
| `peer_list` | 没有影响。列出运行 omp-peers 的存活 omp 进程及其主会话（id、标题、cwd、空闲或忙碌），没装 omp-peers 的 omp 进程只作为候选列出。 |
| `peer_ask` | 目标通过 omp 的 /btw 执行器（`runEphemeralTurn`）在旁路回合里作答，使用它自己的模型、system prompt 和对话，包括它此刻正在输出的内容。不会往它的对话里追加任何东西，不会打断它的主回合，也不会执行工具；但会消耗目标的模型用量。 |
| `peer_send` | 把一条 IRC 消息以 `irc:incoming` 卡片注入目标对话，按 aside 投递：空闲的会话会因此开始一轮，忙碌的会话在下一个 step 读到，正在运行的工具不会被打断。接收方用 `peer_send` 回复。 |

用 session id 或其唯一前缀寻址会话。`/new` 和 resume 会更换 id，发给旧 id 的请求会以 `target_not_found` 失败。给模型看的详细规则写在 `src/topics/` 下的工具 topic 里。

工具标签跟随界面语言：先看 `OMOMP_LANG`（`en` 或 `zh`），再看 agent 目录下唯一一份 `omomp.{yml,yaml,json,toml}` 的 `omomp-lang` 段，再看 `LC_ALL` / `LC_MESSAGES` / `LANG`，最后是英文。工具说明、topic 和结果是给模型读的，保持英文。

## 工作方式

- 只要还有一个主会话，omp 进程就在 `~/.omp/run/peers/<pid>.sock` 上监听。这个目录不分 profile，同一用户的所有 profile 共用；socket 权限为 `0600`，只接受同一用户的连接。
- 连接能被接受，进程就算存活。没有心跳、注册中心或缓存，每次工具调用都现场读取当时的 peer。
- 一个连接只承载一行 JSON 请求（`list`、`ask`、`irc`）和一行 JSON 响应。
- 每个目标会话同一时间只回答一个旁路询问，第二个会得到 `ask_busy`。问题和消息上限 64 KiB，回答上限 32 KiB，被截断的回答会注明。
- `peer_send` 在消息注入后就返回。没有已读回执，不跟踪回复，也不做离线投递。
- 没装 omp-peers 的 omp 进程来自 omp 自己的项目 presence 记录（`~/.omp/run/daemons/<scope>/clients/`）中 pid 仍在运行的条目。它们只算候选，因为这些记录可能比对应进程活得更久。

## 退出与残留

进程的最后一个主会话关闭时，socket 被删除。omp 在 TUI 模式下，`/quit`、连按两次 Ctrl+C，以及 `kill` 发送 TERM、HUP 或 INT 都属于这种情况。`kill -9`，以及向 RPC 模式的 omp 发送的信号，都会跳过 shutdown 钩子，留下 socket 文件。这个文件会拒绝连接，所以永远不会被列为存活；下一个复用该 pid 的进程会接管这条路径。

## 信任边界

同一 OS 用户下的任何进程都能连上 socket：向会话发起旁路询问（回答会用到该会话的上下文），也能往会话里注入消息。只在能接受这一点的机器上安装本插件。

## 开发

```sh
bun install
bun run check
bun test
```

本地运行时直接加载入口：`omp -e ./index.ts`。测试使用私有 `HOME`，不会加入真实的 peer 集合。
