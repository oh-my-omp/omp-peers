# Side questions

- Main sessions and subagents can ask main sessions. A subagent's question identifies its process and registry id and is one-way: the side answer returns through this call only. Do not use `peer_send` to reply to a subagent; it is not a registered peer.
- The target answers in a /btw-style side turn: its own model, system prompt and conversation, including output it is producing right now. The side turn runs alongside its main turn, adds nothing to its conversation and cannot call tools.
- It still costs the target's model usage and runs its context hooks, so ask what you need, not idle chatter.
- One side question per target session at a time. `ask_busy` means another one is being answered; ask again later.
- An answer over 32 KiB comes back cut and marked as cut.
- The call waits up to 5 minutes. Cancelling it aborts the target's side turn.
- `target_not_found`: the session id changed (`/new`, resume) or its omp exited; run `peer_list`.
- `ask_failed`: the side turn failed, for example because the target switched model or session mid-answer; asking again is safe.
- `ask_unsupported`: the target's omp has no side turns.
- To hand work over or notify, use `peer_send`, which enters the target's conversation; `peer_ask` never does.
