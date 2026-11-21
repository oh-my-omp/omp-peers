import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { escapeHarnessTags } from "@oh-my-pi/pi-coding-agent/session/harness-tags";
import { errorText } from "./errors.ts";
import type { AskOutcome, LocalMain } from "./node.ts";
import { MAX_ANSWER_BYTES, type Sender, truncateUtf8 } from "./protocol.ts";

/** The usage-journal name of the side turns that answer peer questions. */
export const ASK_PURPOSE = "omp-peers-ask";

/** A tool call the session is still generating: the side turn's snapshot holds only finished messages. */
export type InflightCall = { name: string; path: string | undefined; chars: number };

export function inflightCalls(message: AgentMessage | undefined): InflightCall[] {
	if (message?.role !== "assistant") return [];
	const calls: InflightCall[] = [];
	for (const block of message.content) {
		if (block.type !== "toolCall") continue;
		const path: unknown = block.arguments?.path;
		calls.push({
			name: block.name,
			path: typeof path === "string" ? path : undefined,
			chars: JSON.stringify(block.arguments ?? {}).length,
		});
	}
	return calls;
}

function describeSender(from: Sender): string {
	const title = from.title === undefined ? "" : ` "${from.title}"`;
	switch (from.kind) {
		case "main":
			return `peer://${from.address}${title}, cwd ${from.cwd}`;
		case "sub":
			return `subagent ${from.agentId} of omp pid ${from.pid} (session ${from.sessionId}${title}, cwd ${from.cwd})`;
	}
}

function askPrompt(question: string, from: Sender, inflight: readonly InflightCall[]): string {
	return [
		from.kind === "sub"
			? `Side question from an omp subagent in another process (${describeSender(from)}):`
			: `Side question from another omp main session (${describeSender(from)}):`,
		"",
		escapeHarnessTags(question),
		"",
		...(inflight.length === 0
			? []
			: [
					"Tool calls you are still writing, not yet in this snapshot of your conversation:",
					...inflight.map(
						(call) => `- \`${call.name}\`${call.path === undefined ? "" : ` (${call.path})`}: ${call.chars} characters of arguments so far`,
					),
					"",
				]),
		"Answer it from your current context. This is a /btw-style side turn: the answer goes back to the asker only, it is not added to your conversation, and you cannot call tools here.",
		...(from.kind === "sub" ? ["The asker is a subagent and has no peer:// address: this answer is the only way back to it."] : []),
	].join("\n");
}

function ircContent(message: string, from: Sender): string {
	return [
		"<irc>",
		from.kind === "sub"
			? `Incoming peer message from an omp subagent in another process (${describeSender(from)}):`
			: `Incoming peer message from another omp main session (${describeSender(from)}):`,
		"",
		escapeHarnessTags(message),
		"",
		from.kind === "sub"
			? "It came through omp-peers. It is one-way: a subagent has no peer:// address, so nothing you write reaches it."
			: `It came through omp-peers; \`agent://\` and \`wait\` cannot reach the sender. If a response is expected, reply via \`write\` (\`path: "peer://${from.address}"\`, \`content: "…"\`); may finish current step first. No one replies on your behalf, and the sender's reply wakes you when it arrives.`,
		"</irc>",
	].join("\n");
}

function senderLabel(from: Sender): string {
	const name = from.title ?? from.sessionId;
	return from.kind === "sub" ? `subagent ${from.agentId} — ${name} (pid ${from.pid})` : `peer://${from.address} — ${name}`;
}

export function localMain(pi: ExtensionAPI, ctx: ExtensionContext, inflight: () => readonly InflightCall[]): LocalMain {
	let answering: AbortController | undefined;

	async function ask(question: string, from: Sender, closed: AbortSignal): Promise<AskOutcome> {
		if (ctx.runEphemeralTurn === undefined) return { kind: "unsupported" };
		if (answering !== undefined) return { kind: "busy" };
		const controller = new AbortController();
		answering = controller;
		const onClosed = (): void => controller.abort();
		closed.addEventListener("abort", onClosed, { once: true });
		try {
			const result = await ctx.runEphemeralTurn({
				promptText: askPrompt(question, from, inflight()),
				signal: controller.signal,
				replyMaxBytes: Infinity,
				purpose: ASK_PURPOSE,
			});
			const answer = truncateUtf8(result.replyText, MAX_ANSWER_BYTES);
			return { kind: "answer", text: answer.text, truncated: answer.truncated };
		} catch (error) {
			return { kind: "failed", message: errorText(error) };
		} finally {
			closed.removeEventListener("abort", onClosed);
			if (answering === controller) answering = undefined;
		}
	}

	function deliver(message: string, from: Sender): "idle" | "busy" {
		const recipient = ctx.isIdle() ? "idle" : "busy";
		pi.sendMessage(
			{
				customType: "irc:incoming",
				content: ircContent(message, from),
				display: true,
				// `message` is that text folded onto one line and
				// left whole: the host redacts secrets on the full text before it previews the entry, and a
				// cut made here would leave a fragment no later pass can recognize.
				details: {
					id: crypto.randomUUID(),
					from: senderLabel(from),
					message: message.replace(/\s+/g, " ").trim(),
				},
			},
			{ deliverAs: "aside", triggerTurn: true },
		);
		return recipient;
	}

	return {
		agentId: ctx.agent.id,
		sessionId: () => ctx.sessionManager.getSessionId(),
		title: () => ctx.sessionManager.getSessionName(),
		cwd: () => ctx.sessionManager.getCwd(),
		idle: () => ctx.isIdle(),
		ask,
		deliver,
		stop: () => answering?.abort(),
	};
}
