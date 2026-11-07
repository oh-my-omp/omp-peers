// The receiving side of one main session: answers side questions through the host's /btw executor
// and injects IRC messages into the session. Built from the session's `session_start` context.
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "./errors.ts";
import type { AskOutcome, LocalMain } from "./node.ts";
import { MAX_ANSWER_BYTES, type Sender, truncateUtf8 } from "./protocol.ts";

function describeSender(from: Sender): string {
	const title = from.title === undefined ? "" : ` "${from.title}"`;
	const origin = `session ${from.sessionId}${title}, pid ${from.pid}, cwd ${from.cwd}`;
	return from.kind === "sub" ? `subagent ${from.agentId} of omp process (${origin})` : origin;
}

function askPrompt(question: string, from: Sender): string {
	return [
		from.kind === "sub"
			? `Side question from an omp subagent (${describeSender(from)}):`
			: `Side question from another omp main agent (${describeSender(from)}):`,
		"",
		question,
		"",
		"Answer it from your current context. This is a /btw-style side turn: the answer goes back to the asker only, it is not added to your conversation, and you cannot call tools here.",
		...(from.kind === "sub"
			? [
					"This is one-way communication from a subagent: return your answer through this side turn only. Do not use peer_send to reply; the subagent is not a registered peer.",
				]
			: []),
	].join("\n");
}

function ircContent(message: string, from: Sender): string {
	return [
		from.kind === "sub"
			? `Incoming peer message from an omp subagent (${describeSender(from)}):`
			: `Incoming peer message from another omp main agent (${describeSender(from)}):`,
		"",
		message,
		"",
		from.kind === "sub"
			? "It came through omp-peers, not the Agent Hub. This is a one-way message from a subagent: do not use peer_send to reply. The subagent is not a registered peer; agent:// and wait cannot reach it across processes."
			: `It came through omp-peers, not the Agent Hub: \`agent://\` cannot reach the sender and \`wait\` does not wait for it. If a response is expected, call peer_send with to "${from.sessionId}"; the sender's reply wakes you when it arrives.`,
	].join("\n");
}

/** Width of the host's one-line previews (`previewLine`): they fold whitespace and cut at column 119. */
const SUMMARY_COLUMNS = 120;

/**
 * The one-line summary the IRC card and the session summary line render from `details.message`,
 * so the entry holds the full message once, in `content`. It is the whitespace-folded message up to
 * the end of the word that crosses column 119, followed by ` …` when more follows. A summary longer
 * than the cut previews exactly as the full message does, and a redacting preview still sees a
 * whitespace-free secret crossing the cut whole rather than a fragment. Only the kept words are read.
 */
function ircSummary(message: string): string {
	const words = /\S+/g;
	const kept: string[] = [];
	/** Folded length of `kept` joined by single spaces. */
	let length = 0;
	for (let match = words.exec(message); match !== null; match = words.exec(message)) {
		const start = kept.length === 0 ? 0 : length + 1;
		// The previous word ended at or past the cut and more follows.
		if (start >= SUMMARY_COLUMNS) return [...kept, "…"].join(" ");
		kept.push(match[0]);
		length = start + match[0].length;
	}
	return kept.join(" ");
}

export function localMain(pi: ExtensionAPI, ctx: ExtensionContext): LocalMain {
	/** The side question being answered; one at a time, held until the side turn settles. */
	let answering: AbortController | undefined;

	async function ask(question: string, from: Sender, closed: AbortSignal): Promise<AskOutcome> {
		if (ctx.runEphemeralTurn === undefined) return { kind: "unsupported" };
		if (answering !== undefined) return { kind: "busy" };
		const controller = new AbortController();
		answering = controller;
		const onClosed = (): void => controller.abort();
		closed.addEventListener("abort", onClosed, { once: true });
		try {
			// Infinity keeps the host's repeated-line dedupe without its 4 KiB one-liner cap; the
			// protocol cap below is applied here, where truncation is known.
			const result = await ctx.runEphemeralTurn({
				promptText: askPrompt(question, from),
				signal: controller.signal,
				replyMaxBytes: Infinity,
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
				// The host's IRC card and session summary line render `from` and `message`; the model reads
				// `content`, the entry's only full copy of the message.
				details: {
					from:
						from.kind === "sub"
							? `subagent ${from.agentId} — ${from.title ?? from.sessionId} (pid ${from.pid})`
							: `${from.title ?? from.sessionId} (pid ${from.pid})`,
					message: ircSummary(message),
				},
			},
			// aside: idle starts a turn; streaming reads it at the next step without breaking the tool batch.
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
