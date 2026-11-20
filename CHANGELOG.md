# Changelog

## [Unreleased]

### Breaking Changes

- The `peer_list`, `peer_ask` and `peer_send` tools and their `xd://peer_*` topics are gone: models use the `peer://` internal URL instead — `read peer://` lists peers, `write peer://<address>` sends a message and `write peer://<address>?ask` asks a side question whose answer is the write result
- Peers are addressed by process id (`peer://<pid>`, or `peer://<pid>/<sessionId>` when one omp process hosts several main sessions) instead of by session id, so an address stays valid across `/new` and resume

### Added

- Added the plugin setting `enabled` (default on; `/settings` → Plugins or `omp plugin config`): turned off, an omp process opens no peer endpoint and offers no `peer://`; a change takes effect when omp next starts
- Added peer:// write errors for missing, ambiguous, unlisted or self targets and validation for malformed addresses, unsupported query parameters, empty content or oversized content
- An omp process accepts at most 20 messages per 10 minutes from any one other omp process; further messages are refused with `budget_exceeded`, so two models cannot wake each other forever (side questions are not counted)

### Changed

- Peer side questions now include in-flight tool calls, and peer prompts use peer:// sender labels with reply instructions for main senders and a one-way notice for subagents
- A side question's model usage is recorded in the asked session's usage journal under the purpose `omp-peers-ask`

### Fixed

- omp-peers loads again on omp 19 (it imported getDaemonRuntimeRoot, which omp 19 removed)

### Security

- Escaped harness tags in peer messages so content cannot forge or close the message envelope

## [0.2.1] - 2026-11-19

### Changed

- Updated the shared copy of `i18n.ts` to oh-my-omp/shared@33dbe00.

## [0.2.0] - 2026-11-15

### Added

- Added Windows support: processes listen on per-user named pipes and peer discovery finds live peers from the pipe namespace

## [0.1.10] - 2026-11-12

### Changed

- 发布改为 omomp 的每日发布：合并到 main 不再升版本号，提交在 `## [Unreleased]` 下用 lgit 写条目；每天 02:00 GMT+9 由共享 workflow 把这一节发布到 `release` 分支、`v<version>` tag 与 GitHub Release；安装改为 `https://github.com/oh-my-omp/omp-peers#release`。
