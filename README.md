# omp-peers

English | [简体中文](README.zh-CN.md)

Lets the omp main sessions of one OS user find each other across processes, ask each other /btw-style side questions, and exchange IRC messages. omp's own Agent Hub (`agent://`, `wait`) only reaches agents inside one omp process; omp-peers connects the processes.

## Install

```sh
omp install https://github.com/oh-my-omp/omp-peers
```

The entry is the package-root `index.ts`, declared by `omp.extensions` in `package.json`. The plugin has no settings.

## Tools

Main sessions get three tools; subagents are not peers and get a refusal.

| Tool | Effect on the target session |
|---|---|
| `peer_list` | None. Lists the live omp processes running omp-peers with their main sessions (id, title, cwd, idle or busy), and omp processes without omp-peers as candidates. |
| `peer_ask` | Answers in a side turn through omp's /btw executor (`runEphemeralTurn`): its model, system prompt and conversation, including output it is producing. Nothing is added to its conversation, its main turn is not interrupted, and no tools run. It does cost the target's model usage. |
| `peer_send` | Injects an IRC message into its conversation as an `irc:incoming` card, delivered as an aside: an idle session starts a turn, a busy one reads it at its next step without its running tools being interrupted. The receiver replies with `peer_send`. |

Sessions are addressed by session id, or a unique prefix. The id changes on `/new` and resume; a request to an old id fails with `target_not_found`. Detailed model-facing rules are the tool topics in `src/topics/`.

Tool labels follow the UI language: `OMOMP_LANG` (`en` or `zh`), then the `omomp-lang` section of the single `omomp.{yml,yaml,json,toml}` in the agent directory, then `LC_ALL` / `LC_MESSAGES` / `LANG`, then English. Descriptions, topics and results, which the model reads, stay English.

## How it works

- Each omp process with at least one main session listens on `/tmp/omp-<uid>/peers/<pid>.sock`. The directory is per user and profile-independent, so every profile of the user shares it, and `/tmp` is emptied at boot, which no endpoint needs to outlive. `/tmp/omp-<uid>` must be owned by the user with mode `0700`, otherwise no endpoint is opened and omp logs a warning; the socket is `0600` and accepts the same user only.
- A process is alive when its socket accepts a connection. There is no heartbeat, registry or cache: every tool call reads the peers at that moment.
- One connection carries one JSON request line (`list`, `ask`, `irc`) and one JSON response line.
- One side question per target session at a time; a second gets `ask_busy`. Questions and messages are capped at 64 KiB, answers at 32 KiB (cut answers are marked).
- `peer_send` returns once the message is injected. There is no read receipt, no reply tracking and no offline delivery.
- omp processes without omp-peers come from omp's project presence records (`~/.omp/run/daemons/<scope>/clients/`) whose pid is still running. They are reported as candidates only: the records can outlive their process.

## Exit and leftovers

The socket is removed when the last main session of the process shuts down. With omp in TUI mode that covers `/quit`, a double Ctrl+C and `kill` with TERM, HUP or INT. `kill -9`, and signals to omp in RPC mode, skip the shutdown hook and leave the socket file behind. It refuses connections, so it is never listed as alive; it stays until reboot empties `/tmp`, or the next process with that pid takes the path over.

## Trust

Any process of the same OS user can connect to the socket, ask a session side questions (which read that session's context) and inject messages into it. Install the plugin only where that is acceptable.

## Development

```sh
bun install
bun run check
bun test
```

For local runs, load the entry directly: `omp -e ./index.ts`. Tests run their own node on a private temporary directory, so they do not join the real peer set.
