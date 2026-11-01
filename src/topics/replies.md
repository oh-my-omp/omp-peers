# Messages and replies

- Main sessions and subagents can send to main sessions. A subagent's message identifies its process and registry id and is explicitly one-way: do not use `peer_send` to reply, including to its process's main session.
- The message enters the target session's conversation as an IRC card. An idle target starts a turn on it; a busy target reads it at its next step without its running tools being interrupted.
- `Delivered` means the message was injected. It does not mean the target has read it or will answer.
- When you send as a main session, replies arrive in your conversation as `Incoming peer message from another omp main agent (session …)`, and wake you when you are idle. Do not `wait` for them and do not poll `peer_list`: end your turn. Subagents have no peer reply address.
- `agent://` and `wait` belong to the Agent Hub of one omp process and cannot reach another process. Reply to a message from a main session with `peer_send`, `to` set to the session id the message names. A subagent sender cannot receive such a reply.
- A message holds at most 64 KiB. Nothing is stored for later: if the target's omp has exited, sending fails.
- Each message can start a turn on the other side. Do not answer a reply that needs no answer, so two sessions do not wake each other in a loop.
