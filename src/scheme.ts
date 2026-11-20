import type {
	InternalResource,
	InternalUrl,
	InternalWriteResult,
	ProtocolHandler,
	ResolveContext,
	SchemeHost,
	SchemeSpec,
	WriteContext,
} from "@oh-my-pi/pi-coding-agent/internal-urls";
import {
	ASK_TIMEOUT_MS,
	addressedSessions,
	DELIVER_TIMEOUT_MS,
	type Exchange,
	exchange,
	type PeerAddress,
	parseAddress,
	resolveTarget,
	survey,
} from "./client.ts";
import { node, peersDir, WAKE_BUDGET, WAKE_WINDOW_MS } from "./node.ts";
import { MAX_ANSWER_BYTES, MAX_TEXT_BYTES, PROTOCOL_VERSION, type Sender, senderWire, utf8Bytes } from "./protocol.ts";

type ToolSession = NonNullable<WriteContext["session"]>;

const result = (text: string, isError = false): InternalWriteResult => ({
	content: [{ type: "text", text }],
	...(isError ? { isError } : {}),
});

function sender(session: ToolSession): Sender {
	const sessionId = session.sessionManager?.getSessionId?.() ?? session.getSessionId?.() ?? `pid-${process.pid}`;
	const origin = { pid: process.pid, sessionId, cwd: session.cwd };
	if ((session.taskDepth ?? 0) > 0) return { kind: "sub", agentId: session.getAgentId?.() ?? "subagent", ...origin };
	const local = node.main(sessionId);
	return { kind: "main", address: local?.address ?? String(process.pid), title: local?.title, ...origin };
}

async function list(context: ResolveContext | undefined): Promise<string> {
	const peers = await survey(peersDir());
	const lines: string[] = [];
	let mains = 0;
	for (const peer of peers) {
		if (peer.sessions.kind === "unlisted") {
			lines.push(`- pid ${peer.pid}: alive, session list unavailable (${peer.sessions.reason})`);
			continue;
		}
		for (const { address, session } of addressedSessions({ pid: peer.pid, list: peer.sessions.list })) {
			mains++;
			const title = session.title === undefined ? "untitled" : `"${session.title}"`;
			const mark = peer.pid !== process.pid ? "" : session.sessionId === context?.sessionId ? " (you)" : " (this omp process)";
			lines.push(`- peer://${address} ${title} — ${session.cwd} — ${session.idle ? "idle" : "busy"}${mark}`);
		}
	}
	return [
		`${peers.length} omp process(es) reachable through omp-peers, ${mains} main session(s):`,
		...lines,
		"",
		"`write peer://<address>` messages a session (an idle one starts a turn); `write peer://<address>?ask` asks it a side question and returns the answer as the write result.",
		"",
	].join("\n");
}

function failure(exchanged: Exclude<Exchange, { kind: "response" }>, address: string): InternalWriteResult {
	switch (exchanged.kind) {
		case "unreachable":
			return result(`peer://${address} is unreachable: its omp process is gone (${exchanged.reason}).`, true);
		case "timeout":
			return result(`peer://${address} timed out: no response within ${Math.round(exchanged.ms / 1000)} s.`, true);
		case "cancelled":
			return result("Cancelled.", true);
		case "closed":
			return result(`peer://${address} closed the connection without responding (${exchanged.reason}).`, true);
		case "malformed":
			return result(`peer://${address} sent a malformed response: ${exchanged.message}`, true);
	}
}

async function deliver(
	address: PeerAddress,
	url: InternalUrl,
	content: string,
	from: Sender,
	signal: AbortSignal | undefined,
): Promise<InternalWriteResult> {
	const resolved = await resolveTarget(peersDir(), address);
	switch (resolved.kind) {
		case "not_found":
			return result(`No main session at ${url.href}. Online: ${resolved.online.map((a) => `peer://${a}`).join(", ") || "none"}.`, true);
		case "ambiguous":
			return result(
				`pid ${address.pid} hosts several main sessions; address one of them: ${resolved.candidates.map((a) => `peer://${a}`).join(", ")}.`,
				true,
			);
		case "unlisted":
			return result(`pid ${address.pid} is alive but did not list its sessions (${resolved.reason}).`, true);
		case "found":
			break;
	}
	const { target } = resolved;
	if (from.kind === "main" && target.pid === process.pid && target.session.sessionId === from.sessionId) {
		return result(`peer://${target.address} is you; read peer:// and pick another session.`, true);
	}
	const base = { v: PROTOCOL_VERSION, to: target.session.sessionId, from: senderWire(from) } as const;
	if (url.searchParams.has("ask")) {
		const exchanged = await exchange(peersDir(), target.pid, { ...base, kind: "ask", question: content }, ASK_TIMEOUT_MS, signal);
		if (exchanged.kind !== "response") return failure(exchanged, target.address);
		const response = exchanged.response;
		switch (response.kind) {
			case "answer": {
				const cut = response.truncated ? `\n\n[answer cut at ${MAX_ANSWER_BYTES / 1024} KiB]` : "";
				return result(`Answer from peer://${target.address}:\n\n${response.text}${cut}`);
			}
			case "error":
				return result(`peer://${target.address} did not answer: ${response.code}: ${response.message}`, true);
			case "sessions":
			case "accepted":
				return result(`peer://${target.address} sent an unexpected ${response.kind} response.`, true);
		}
	}
	const exchanged = await exchange(peersDir(), target.pid, { ...base, kind: "irc", message: content }, DELIVER_TIMEOUT_MS, signal);
	if (exchanged.kind !== "response") return failure(exchanged, target.address);
	const response = exchanged.response;
	switch (response.kind) {
		case "accepted": {
			const state =
				response.recipient === "idle" ? "It was idle and starts a turn on it now." : "It was busy and reads it at its next step.";
			const replies =
				from.kind === "main"
					? "A reply arrives as an incoming peer message and wakes you; do not `wait` for it."
					: "You are a subagent, so this was one-way: the recipient cannot reply to you.";
			return result(`Delivered to peer://${target.address}. ${state} ${replies}`);
		}
		case "error":
			return result(`Not delivered to peer://${target.address}: ${response.code}: ${response.message}`, true);
		case "sessions":
		case "answer":
			return result(`peer://${target.address} sent an unexpected ${response.kind} response.`, true);
	}
}

export const peerScheme: ProtocolHandler = {
	scheme: "peer",
	spec: {
		backing: "virtual",
		selectors: "none",
		immutable: true,
		write: { via: "handler", payload: "verbatim", scope: "coordination", tier: () => "read", maxBytes: MAX_TEXT_BYTES },
	} satisfies SchemeSpec,

	promptDoc(host: SchemeHost): string {
		const oneWay = host.subagent ? ", one-way: you have no peer address" : "";
		const sameFolder = host.crossInstanceAgents
			? " A peer in this same folder with task.crossInstance on is also agent://<pid>; prefer that there."
			: "";
		return `peer://: main sessions of your user's other omp processes, any folder. \`read peer://\` lists their addresses; \`write peer://<address>\` messages one (wakes it when idle${oneWay}); \`write peer://<address>?ask\` asks a side question it answers from its own context without adding to its conversation, and the write result is the answer.${sameFolder}`;
	},

	promptReference(): string {
		return `peer://<pid> is that process's main session and follows its /new and resume; peer://<pid>/<sessionId> picks one when a process hosts several. ?ask waits up to ${ASK_TIMEOUT_MS / 60_000} min, cancelling aborts the answer, one question per session at a time (ask_busy), answers over ${MAX_ANSWER_BYTES / 1024} KiB come back cut, and the answer costs the asked session's model usage. Messages: at most ${MAX_TEXT_BYTES / 1024} KiB, no offline delivery, at most ${WAKE_BUDGET} per ${WAKE_WINDOW_MS / 60_000} min from one process to another (budget_exceeded); do not answer a reply that needs no answer, or two sessions wake each other in a loop.`;
	},

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		if ((url.rawHost || url.hostname) !== "") {
			throw new Error(
				`${url.href} is write-only: write it to message that session, or with ?ask to ask it. read peer:// lists the addresses.`,
			);
		}
		const content = await list(context);
		return { url: "peer://", content, contentType: "text/markdown", size: utf8Bytes(content) };
	},

	async write(url: InternalUrl, content: string, context?: WriteContext): Promise<InternalWriteResult> {
		const session = context?.session;
		if (session === undefined) throw new Error("peer:// writes need a tool session");
		const address = parseAddress(url.rawHost || url.hostname, url.pathname);
		if (address === undefined) {
			return result(`${url.href} is not a peer address: write peer://<pid> or peer://<pid>/<sessionId>; read peer:// lists them.`, true);
		}
		const extra = [...url.searchParams.keys()].filter((key) => key !== "ask");
		if (extra.length > 0) return result(`peer:// takes only the ?ask query; got ${extra.join(", ")}.`, true);
		if (content.trim() === "") return result("peer:// writes need non-empty content.", true);
		if (utf8Bytes(content) > MAX_TEXT_BYTES) return result(`peer:// content is limited to ${MAX_TEXT_BYTES / 1024} KiB of UTF-8.`, true);
		return await deliver(address, url, content, sender(session), context?.signal);
	},
};
