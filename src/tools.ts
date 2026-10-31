// The three model-facing tools. Each call reads the live peers at that moment; nothing is cached.
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type ExtensionContext, type ToolDefinition, z } from "@oh-my-pi/pi-coding-agent";
import { unbridgedOmpPids } from "./candidates.ts";
import { ASK_TIMEOUT_MS, DELIVER_TIMEOUT_MS, type Exchange, exchange, resolveTarget, survey } from "./client.ts";
import { errorText } from "./errors.ts";
import { tr } from "./i18n.ts";
import { MAX_ANSWER_BYTES, MAX_TEXT_BYTES, PROTOCOL_VERSION, type Sender, type SessionInfo } from "./protocol.ts";
import { topicsFor } from "./topics.ts";

type Result = AgentToolResult<Record<string, never>>;

const text = (body: string, isError = false): Result => ({
	content: [{ type: "text", text: body }],
	details: {},
	...(isError ? { isError } : {}),
});

function self(ctx: ExtensionContext): Sender {
	return {
		pid: process.pid,
		sessionId: ctx.sessionManager.getSessionId(),
		title: ctx.sessionManager.getSessionName(),
		cwd: ctx.sessionManager.getCwd(),
	};
}

function sessionLine(session: SessionInfo, you: string): string {
	const title = session.title === undefined ? "untitled" : `"${session.title}"`;
	const mark = session.sessionId === you ? " (you)" : "";
	return `  - ${session.sessionId} ${title} — ${session.cwd} — ${session.idle ? "idle" : "busy"}${mark}`;
}

async function list(ctx: ExtensionContext): Promise<Result> {
	const you = ctx.sessionManager.getSessionId();
	const peers = await survey();
	const lines: string[] = [];
	let mains = 0;
	for (const peer of peers) {
		const here = peer.pid === process.pid ? " (this process)" : "";
		switch (peer.sessions.kind) {
			case "listed":
				mains += peer.sessions.list.length;
				lines.push(`- pid ${peer.pid}${here}`, ...peer.sessions.list.map((session) => sessionLine(session, you)));
				break;
			case "unlisted":
				lines.push(`- pid ${peer.pid}${here}: alive, session list unavailable (${peer.sessions.reason})`);
				break;
		}
	}
	const unbridged = await unbridgedOmpPids(new Set(peers.map((peer) => peer.pid)));
	const header = `${peers.length} omp process(es) reachable through omp-peers, ${mains} main session(s):`;
	const footer =
		unbridged.length === 0
			? []
			: [`Other omp processes without omp-peers (candidates; cannot be asked or messaged): pid ${unbridged.join(", ")}.`];
	return text([header, ...lines, ...footer].join("\n"));
}

/** Resolve `to` and refuse yourself; returns the peer pid and full session id, or the refusal. */
async function target(
	to: string,
	ctx: ExtensionContext,
): Promise<{ kind: "ok"; pid: number; sessionId: string } | { kind: "refused"; result: Result }> {
	const resolved = await resolveTarget(to);
	switch (resolved.kind) {
		case "not_found":
			return {
				kind: "refused",
				result: text(`No live main session matches "${to}". Live sessions: ${resolved.known.join(", ") || "none"}. Run peer_list.`, true),
			};
		case "ambiguous":
			return {
				kind: "refused",
				result: text(
					`"${to}" matches several sessions: ${resolved.candidates.map((c) => `${c.sessionId} (pid ${c.pid})`).join(", ")}. Use more characters.`,
					true,
				),
			};
		case "found":
			if (resolved.session.sessionId === ctx.sessionManager.getSessionId()) {
				return { kind: "refused", result: text("That session is you; pick another one from peer_list.", true) };
			}
			return { kind: "ok", pid: resolved.pid, sessionId: resolved.session.sessionId };
	}
}

function failure(result: Exclude<Exchange, { kind: "response" }>, sessionId: string): Result {
	switch (result.kind) {
		case "unreachable":
			return text(`Session ${sessionId}'s omp process is gone (${result.reason}).`, true);
		case "timeout":
			return text(`No answer from session ${sessionId} within ${Math.round(result.ms / 1000)} s.`, true);
		case "cancelled":
			return text("Cancelled.", true);
		case "closed":
			return text(`Session ${sessionId}'s omp closed the connection without answering (${result.reason}).`, true);
		case "malformed":
			return text(`Session ${sessionId} sent a malformed response: ${result.message}`, true);
	}
}

async function ask(params: { to: string; question: string }, signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<Result> {
	const resolved = await target(params.to, ctx);
	if (resolved.kind === "refused") return resolved.result;
	const request = { v: PROTOCOL_VERSION, kind: "ask", to: resolved.sessionId, from: self(ctx), question: params.question } as const;
	const result = await exchange(resolved.pid, request, ASK_TIMEOUT_MS, signal);
	if (result.kind !== "response") return failure(result, resolved.sessionId);
	const response = result.response;
	switch (response.kind) {
		case "answer": {
			const cut = response.truncated ? `\n\n[answer cut at ${MAX_ANSWER_BYTES / 1024} KiB]` : "";
			return text(`Answer from session ${resolved.sessionId} (pid ${resolved.pid}):\n\n${response.text}${cut}`);
		}
		case "error":
			return text(`Session ${resolved.sessionId} did not answer: ${response.code}: ${response.message}`, true);
		case "sessions":
		case "accepted":
			return text(`Session ${resolved.sessionId} sent an unexpected ${response.kind} response.`, true);
	}
}

async function send(params: { to: string; message: string }, signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<Result> {
	const resolved = await target(params.to, ctx);
	if (resolved.kind === "refused") return resolved.result;
	const request = { v: PROTOCOL_VERSION, kind: "irc", to: resolved.sessionId, from: self(ctx), message: params.message } as const;
	const result = await exchange(resolved.pid, request, DELIVER_TIMEOUT_MS, signal);
	if (result.kind !== "response") return failure(result, resolved.sessionId);
	const response = result.response;
	switch (response.kind) {
		case "accepted": {
			const state =
				response.recipient === "idle" ? "It was idle and starts a turn on it now." : "It was busy and reads it at its next step.";
			return text(
				`Delivered to session ${resolved.sessionId} (pid ${resolved.pid}). ${state} A reply arrives as an incoming peer message and wakes you; do not \`wait\` for it.`,
			);
		}
		case "error":
			return text(`Not delivered to session ${resolved.sessionId}: ${response.code}: ${response.message}`, true);
		case "sessions":
		case "answer":
			return text(`Session ${resolved.sessionId} sent an unexpected ${response.kind} response.`, true);
	}
}

const boundedText = (what: string) =>
	z
		.string()
		.min(1)
		.describe(`${what}, at most ${MAX_TEXT_BYTES / 1024} KiB of UTF-8`);

const toParam = z.string().min(1).describe("Target session id from peer_list, or a unique prefix of it");

const listParams = z.object({});
const askParams = z.object({ to: toParam, question: boundedText("The question") });
const sendParams = z.object({ to: toParam, message: boundedText("The message") });

type Topics = { docTopics(): Readonly<Record<string, string>> };

/** Main sessions only: a subagent is not a peer and has no address to reply to. */
async function guarded(ctx: ExtensionContext, run: () => Promise<Result>): Promise<Result> {
	if (ctx.agent.kind !== "main") return text("omp-peers tools are for main sessions only.", true);
	try {
		return await run();
	} catch (error) {
		return text(`omp-peers failed: ${errorText(error)}`, true);
	}
}

/** The tool definitions; called once per extension binding, so labels follow the UI language of that session. */
export const peerTools = () =>
	[
		{
			name: "peer_list",
			label: tr("Peers", "Peer 列表"),
			description: `Lists the live omp processes of this user that run omp-peers and their main sessions (id, title, cwd, idle or busy), plus omp processes without omp-peers.

Topics — read the one a call needs before making it:
- \`xd://peer_list/liveness\` — before relying on who is alive, or when a process shows no session list`,
			parameters: listParams,
			approval: "read",
			docTopics: () => topicsFor("peer_list"),
			execute: (_id, _params, _signal, _onUpdate, ctx) => guarded(ctx, () => list(ctx)),
		} satisfies ToolDefinition<typeof listParams> & Topics,
		{
			name: "peer_ask",
			label: tr("Ask peer", "询问 peer"),
			description: `Asks another omp main session a /btw-style side question and returns its answer; the target answers from its current context without adding anything to its conversation.

Topics — read the one a call needs before making it:
- \`xd://peer_ask/side-turns\` — before asking, or when an ask fails or comes back cut`,
			parameters: askParams,
			approval: "read",
			docTopics: () => topicsFor("peer_ask"),
			execute: (_id, params, signal, _onUpdate, ctx) => guarded(ctx, () => ask(params, signal, ctx)),
		} satisfies ToolDefinition<typeof askParams> & Topics,
		{
			name: "peer_send",
			label: tr("Message peer", "发消息给 peer"),
			description: `Sends an IRC message to another omp main session: it enters that session's conversation, waking it when idle.

Topics — read the one a call needs before making it:
- \`xd://peer_send/replies\` — before sending, and before replying to an incoming peer message`,
			parameters: sendParams,
			approval: "write",
			docTopics: () => topicsFor("peer_send"),
			execute: (_id, params, signal, _onUpdate, ctx) => guarded(ctx, () => send(params, signal, ctx)),
		} satisfies ToolDefinition<typeof sendParams> & Topics,
	] as const;
